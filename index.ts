/**
 * dsh-plugin-turn-memory — turn-granular context memory for DeepSeek Harness.
 *
 * Step 1 of a two-step context-compression plan:
 *
 *  - When a turn ends, the plugin immediately spawns a FORK subagent of this
 *    session (same model, its context is a verbatim replay of the completed
 *    turns — the full turn text included). The fork reads the turn from its
 *    own context, refines a per-turn draft file with read/edit tools, and
 *    answers DONE; the plugin then reads the draft back and replaces the
 *    turn's span — starting right after its user message, which stays
 *    verbatim on the surface — with a <turn-summary> checkpoint. The main
 *    agent never writes summaries itself; compact_turn only re-runs the
 *    fork for a turn the engine missed.
 *  - Replacement covers the summarized turn's span starting right after
 *    its user message, which stays verbatim on the surface, so the newest
 *    user message is never folded.
 *  - The replacement checkpoint is a user/message carrying the turn-memory
 *    source marker (turn number, summary id, format version). The raw events
 *    remain in the append-only log for replay and recall; the checkpoint is
 *    the durable summary record. No custom session event type is introduced,
 *    so logs stay loadable by unmodified harnesses.
 *  - The expand_turn tool recalls a turn's full transcript in two modes:
 *    agentic (routed by the turn's age: recent turns answer from a warm fork
 *    whose context replays the completed-turn log verbatim, older turns are
 *    read in full by a cheap model) and raw (the transcript straight into
 *    context). The model calls the tool with the mode of its choice.
 *
 * Replacement of a turn that experienced mid-turn compaction includes the
 * turn's own compaction checkpoints in the span, so the final turn summary
 * converges the mid-turn checkpoint and the tail into one record.
 *
 * Note on style: this file intentionally uses plain string concatenation and
 * String.fromCharCode(10) for newlines (no template literals, no backslash
 * escapes) so it can be embedded and generated without quoting hazards.
 *
 * The file is TypeScript with erasable-only syntax: node runs it natively via
 * type stripping (no build step), so the edit-reload loop stays single-source.
 * Pure boundary logic lives in lib/ and is unit-tested under test/ — run
 * `pnpm test` and `pnpm typecheck` after edits. The entry file consumes the
 * harness runtime structurally and is typed incrementally; lib/ is fully typed.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { renderTurnSpanText } from './lib/render.ts';
import { appendDumpBlock, buildDumpFileName, renderPrefixBoundary } from './lib/prefix.ts';
import { routeRecallByAge } from './lib/routing.ts';

/** File-based debug trace (the cordis logger buffer is not file-visible, and /tmp is per-process private). */
const DEBUG_LOG = (process.env.DSH_HOME ?? '/home/vilicvane/.dsh') + '/turn-memory-debug.log';
let debugEnabled = false;
function dbg(message) {
  if (!debugEnabled) return;
  try {
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + message + String.fromCharCode(10));
  } catch {
    /* debugging is best-effort */
  }
}

const NL = String.fromCharCode(10);

const name = 'turn-memory';
const inject = ['subagents', 'sessions', 'systemPrompt', 'tools', 'skills'];

/** Format version stamped into every summary checkpoint source. */
const TURN_SUMMARY_VERSION = 5;

/** The plugin field of the checkpoint source marker. */
const SUMMARY_MARKER_PLUGIN = 'turn-memory';

/** Default settings; every key is overridable through the profile row config. */
const DEFAULT_SETTINGS = {
  /** How long one recall fork/subagent may run before it is aborted. */
  recallTimeoutMs: 180000,
  /** Cheap model used by the recall tool's agentic-old-turn path. */
  cheapProvider: 'deepseek-official',
  cheapModel: 'deepseek-chat',
  /** Output-token ceiling for the cheap recall model (raised from 4096 after a huge-turn recall stopped at max-tokens). */
  cheapMaxTokens: 8192,
  /** Agentic recall window: a turn whose end lies within this many milliseconds of now is answered by a fork whose context replays the completed-turn log verbatim (warm only while the provider's disk cache still holds the prefix units persisted when those turns ran); older turns are read in full by the cheap model. Default calibrated against DeepSeek's documented best-effort cache retention of "a few hours to a few days" — the official lower bound. */
  recallRecentWindowMs: 7200000,
  /** Cap on the raw transcript returned into context. */
  maxRawChars: 500000,
  /** Cap per tool result inside a transcript. */
  toolResultCapChars: 20000,
  /** Absolute delegation-depth cap for recall children. */
  maxRecallDepth: 4,
  /** Write pipeline traces to /home/vilicvane/.dsh/turn-memory-debug.log. */
  debug: false,
  /** When non-empty, every landed compaction replacement appends one block to request-prefix-<sessionId>.txt in this directory — one accumulating file per session (the checkpoint node and the first kept node after it, separated by a divider line) — a debug aid for eyeballing where each folded span ends and the kept content begins. */
  prefixDumpDir: '',
};

/** Instruction for the per-turn summary fork: the draft already holds the turn's transcript in the FINAL checkpoint tag format, so the fork only shortens <working> contents in place; the engine reads the draft back when the fork settles. */
function buildSummaryPrompt(turn, draftPath) {
  return [
    'You are the turn-summary fork of this session. Your context is a verbatim replay of the session\'s completed turns — turn ' + turn + ' (the most recently completed turn in that replay) is fully in it.',
    '',
    'Compress ONLY turn ' + turn + ' into the draft file ' + draftPath + '. The draft already holds that turn\'s transcript in the FINAL checkpoint format: verbatim <user-steer> and <assistant> content, with the raw process (tool calls, results, routine checks) inside <working> blocks (tool results may be truncated). Your job is compression IN PLACE, not writing: with the edit tool, shorten the CONTENT of each <working> block to one flowing line. <user-steer> and <assistant> contents are already final — keep them byte for byte. Never add, remove, rename, or reorder tags; never merge or split blocks; never add content outside the draft; never print the summary in your reply — the file is the only deliverable. When the file is final, reply with the single word DONE.',
    '',
    'A compressed <working> line keeps the substantive part only — decisions, discoveries, fixes, meaningful outcomes, in chronological order — and drops transient detail (individual tool calls, intermediate output, routine checks).',
    '- Preserve verbatim whatever keeps your intuition: user wording and emphasis, commitments and offers, phrasing later turns may refer to, plus commands, paths, identifiers, error strings.',
    '- Read-in material stays as paths, not copies: inline only short key snippets; record the exact path plus one line of purpose — copied text goes stale.',
    '- Hindsight in natural language ("I thought X might work. It later turned out wrong."), kept inside the <working> block it revises; assumptions stated as felt ("I assumed X, unverified").',
    '- If the turn ended waiting for the user, the pending question and ALL its options stay verbatim inside the <working> block that carried them; end with the single next action when one is clear.',
    '- Once this summary lands it is the only trace of this turn: the original can only be recovered by an expand_turn recall or by re-reading files — a line kept now is cheaper than a recall later.',
    '- Compaction machinery (compact_turn calls, node counts, replacement results, restarts) never enters the summary; keep only substantive outcomes (root causes, decisions, fixes, artifacts).',
    '- Name skills and procedures instead of restating their steps.',
  ].join(NL);
}



/** Memory guidance section added to every agent's system prompt. */
const MEMORY_SECTION = [
  '## Conversation Memory',
  '',
  'Each completed turn is automatically compacted when it ends: a fork subagent of this session compresses the turn\'s transcript — pre-rendered into a draft file already in the checkpoint\'s tag format (verbatim <user-steer>/<assistant> content, raw process inside <working> blocks) — by shortening the <working> contents in place with edit, and the plugin then replaces the turn\'s span — starting right after its user message, which stays verbatim on the surface — with a <turn-summary> checkpoint. Do not compact turns yourself; the compact_turn tool (with a turn argument) only re-runs the fork for a completed turn the engine missed.',
  '',
  'When a summary may not contain what you need, or you must verify what happened in an earlier turn — including when the user challenges a claim — recall the full information with the expand_turn tool BEFORE answering; only the original transcripts settle the facts.',
  '',
  'Summaries annotate hindsight in natural language ("I thought X might work. It later turned out wrong."); treat later corrections as authoritative over earlier entries.',
  '',
  'The recall modes:',
  '',
  '1. agentic — the tool routes by the turn\'s age: a turn that ended within recallRecentWindowMs (default 2h) is answered by a fork replaying the completed turns verbatim (cheap only while the provider\'s disk cache still holds those prefix units); an older turn is read by a cheap model. Give agentic a focused question.',
  '2. raw — the full text of the turn is returned into the conversation. Most direct, most context consumed; very large turns are truncated. Last resort.',
  '',
  'Prefer agentic for lookups; use raw only when you need to work with the full text directly. Routine continuation must not require recall — summaries are written to support it.',
].join(NL);

function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = source[key];
    if (typeof value === typeof fallback) settings[key] = value;
  }
  return settings;
}

/** Extract joined text from content blocks (images render as a marker). */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join(NL).trim();
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '... [truncated, ' + (text.length - maxChars) + ' more chars]';
}

/** Find the last event of a type in a session log (live seq === index). */
/** Render an unknown thrown value for user-visible messages. */
function errorText(error, includeStack = false) {
  if (!(error instanceof Error)) return String(error);
  const text = error.message ?? String(error);
  return includeStack && error.stack !== undefined ? text + ' STACK ' + error.stack.slice(0, 300) : text;
}
function findLastEvent(session, type, beforeSeq?) {
  const events = session.events;
  const limit = beforeSeq === undefined ? events.length : Math.min(beforeSeq, events.length);
  for (let index = limit - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return events[index];
  }
  return undefined;
}

const VERBATIM_KIND_PATTERN = /kind="([^"]*)"/;

/** Resolve one verbatim tag against the turn's log events; undefined when unresolvable. */
function resolveVerbatim(session, item, kind) {
  if (kind !== 'turn-prompt') return undefined;
  const events = session.events;
  for (let seq = item.startSeq + 1; seq <= item.endSeq; seq += 1) {
    const event = events[seq];
    if (event === undefined) break;
    if (event.type === 'user/message' && event.surfaceOp === 'append') {
      return extractText(event.data?.content ?? []);
    }
  }
  return undefined;
}

/** Replace every turn-prompt verbatim tag in a summary with the turn's original message. */
function resolveVerbatimTags(session, item, summary) {
  if (summary.indexOf('<verbatim ') < 0) return summary;
  let result = '';
  let cursor = 0;
  while (true) {
    const open = summary.indexOf('<verbatim ', cursor);
    if (open < 0) {
      result += summary.slice(cursor);
      break;
    }
    const close = summary.indexOf('/>', open);
    if (close < 0) {
      result += summary.slice(cursor);
      break;
    }
    result += summary.slice(cursor, open);
    const tag = summary.slice(open, close + 2);
    const kind = VERBATIM_KIND_PATTERN.exec(tag)?.[1];
    const resolved = resolveVerbatim(session, item, kind);
    if (resolved === undefined) {
      dbg('tryReplace: turn ' + item.turn + ' verbatim tag unresolved, kept as-is: ' + tag);
      result += tag;
    } else {
      result += resolved;
    }
    cursor = close + 2;
  }
  return result;
}

/** Locate one turn's event span: (turn/start seq, turn/end seq]; open turns extend to the log tail. Also carries the boundary timestamps for age-based recall routing. */
function findTurnSpan(session, turn) {
  let startSeq;
  let endSeq;
  let startTime;
  let endTime;
  for (const event of session.events) {
    if (event.type === 'turn/start' && event.data?.turn === turn) {
      startSeq = event.seq;
      startTime = event.time;
    }
    if (event.type === 'turn/end' && event.data?.turn === turn) {
      endSeq = event.seq;
      endTime = event.time;
    }
  }
  if (startSeq === undefined) return undefined;
  return { startSeq, endSeq: endSeq ?? session.events.length - 1, startTime, endTime };
}

/** Whether any event of the given type sits inside (startSeq, endSeq]. */
function hasEventBetween(session, type, startSeq, endSeq) {
  for (let seq = startSeq + 1; seq <= endSeq; seq += 1) {
    if (session.events[seq]?.type === type) return true;
  }
  return false;
}

/**
 * Turns whose spans already carry a whole-turn replacement checkpoint. Only
 * scope 'whole-turn' counts: in-turn checkpoints carry the same plugin marker
 * since the self-fold rework and must NOT make a turn look replaced, or its
 * automatic turn-end fork never runs for it after any in-turn compaction.
 * Checkpoints written before
 * the scope field existed are ignored by design.
 */
function replacedTurnNumbers(session) {
  const out = new Set();
  for (const seq of session.surface.nodes) {
    const event = session.events[seq];
    if (event === undefined || event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source?.plugin === SUMMARY_MARKER_PLUGIN && source.scope === 'whole-turn' && typeof source.turn === 'number') out.add(source.turn);
  }
  return out;
}

/** Render one log event for the human-readable turn transcript. */
function renderTranscriptEvent(event, settings) {
  switch (event.type) {
    case 'user/message': {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return undefined;
      const source = event.data?.source;
      const label = source?.kind === 'user' ? 'User' : String(source?.kind ?? 'user');
      return NL + '### ' + label + NL + extractText(event.data?.content ?? []);
    }
    case 'assistant/message':
      return NL + '### Assistant' + NL + extractText(event.data?.message?.content ?? []);
    case 'tool/call':
      return NL + '### Tool call: ' + event.data?.name + NL + 'args: ' + truncate(event.data?.arguments ?? '', 2000);
    case 'tool/result': {
      const block = event.data?.message?.content?.[0];
      const errorTag = block?.isError === true ? ' (error)' : '';
      return NL + '### Tool result' + errorTag + NL + truncate(extractText(block?.content ?? []), settings.toolResultCapChars);
    }
    default:
      return undefined;
  }
}

/** Build the human-readable transcript of one turn. */
function buildTurnTranscript(session, span, settings) {
  const lines: string[] = [];
  let total = 0;
  for (let seq = span.startSeq + 1; seq <= span.endSeq; seq += 1) {
    const event = session.events[seq];
    if (event === undefined) break;
    const rendered = renderTranscriptEvent(event, settings);
    if (rendered === undefined) continue;
    total += rendered.length + 1;
    if (total > settings.maxRawChars) {
      lines.push(NL + '[transcript truncated: remaining events omitted]');
      break;
    }
    lines.push(rendered);
  }
  return lines.join(NL);
}

/** Operational skills bundled with the plugin (runtime rank 250; project-level skills override). */
const PLUGIN_SKILLS = [
  {
    name: 'dsh-web-restart',
    description: '重启本机 dsh web 服务器以加载 profile/插件变更。USE FOR: 修改了插件或 profile 配置需要生效；服务器异常需要重启；涉及 3080 端口、restart-web.sh、web-restart.log 时。',
    content: [
      '# 重启 dsh web 服务器',
      '',
      '服务器 = dsh web，默认监听 http://127.0.0.1:3080，agent 会话运行在服务器进程内。',
      '',
      '## 铁律',
      '',
      '- 默认不要自动重启：重启会撞上其他会话正在改的插件代码或正在写的会话日志（曾导致 zstandard 首帧损坏、boot 崩溃）。改动完成后在回复里提醒用户手动重启，不自行调度；只有用户明确要求自动重启时才走下面的延迟脚本流程。',
      '- 绝不在自己当前 turn 内直接 kill 服务器——会切断自己的回复流。必须用延迟脱离脚本，让当前回复先完整送达。',
      '- 重启会丢失所有插件内存态（turn-memory 的待替换摘要、未落盘状态）；这是预期降级，不补做。',
      '- 页面一般不需要手动刷新：客户端自动重连；仅当连接错误提示持续不消失时才刷新。',
      '',
      '## 流程',
      '',
      '1. 复用现成脚本 $DSH_HOME/restart-web.sh（30 秒延迟 → kill 旧进程 → 重新拉起 → 健康检查）。没有该脚本时按同样结构写一个：sleep 30 → kill 旧进程（pgrep 匹配）→ 等待退出 → nohup 重新拉起 → curl 健康检查，全程输出追加到 $DSH_HOME/web-restart.log。',
      '2. 调度方式（从 bash 工具）：',
      '',
      '   cd "$DSH_HOME" && setsid nohup ./restart-web.sh >/dev/null 2>&1 &',
      '',
      '3. 脚本启动 30 秒后才动手——期间正常完成当前回复。',
      '4. 验证：tail $DSH_HOME/web-restart.log 应看到 relaunching dsh web 与 server healthy on http://127.0.0.1:3080/；',
      "   pgrep -f 'dsh web' 拿到新 PID（其启动时间应晚于 relaunch 时间）。",
      '',
      '## 注意',
      '',
      '- 服务器经沙箱化 bash 用 setsid 启动会继承沙箱：/tmp 对该服务器进程是私有的。跨进程可见的日志/文件必须放 workspace 下。',
      '- 服务器 stdout/stderr 经 nohup 重定向汇入 $DSH_HOME/web-restart.log。',
    ].join(NL),
  },
  {
    name: 'dsh-session-log-inspect',
    description: '检查 dsh 会话持久化日志与事件。USE FOR: 核对摘要/替换节点、诊断 turn 边界、解压 session.jsonl.zstd、统计事件类型、重建 surface 折叠时。',
    content: [
      '# 检查 dsh 会话日志',
      '',
      '会话日志路径：$DSH_SESSION_JSONL（如 $DSH_HOME/sessions/--home-vilicvane--/<session-id>/session.jsonl.zstd）。',
      '',
      '## 解压（唯一验证可行的方式）',
      '',
      'zstd 多帧追加格式（每次 append 一个 frame）。fflate 只支持 deflate 系；zstd CLI 未必安装；python 未必有 zstandard 模块。用 python3 ctypes 调系统 libzstd.so.1 流式解压：',
      '',
      '- ZSTD_createDStream / ZSTD_initDStream / ZSTD_decompressStream / ZSTD_freeDStream；',
      '- InBuf/OutBuf 结构体：{src/dst: c_void_p, size: c_size_t, pos: c_size_t}；',
      '- 循环直到 inb.pos >= len(data) 且 outb.pos == 0 才停；每帧 ret==0 只表示当前帧完成，必须继续喂下一帧（早期踩过只解出第一帧的坑）。',
      '',
      '## 事件要点',
      '',
      '- 存储是折叠格式：chunk 事件合批成行，存储行数不等于事件数；内存中的 events 数组才是 seq==index 的完整事件。',
      '- 常用事件：turn/start{turn}、turn/end{turn, reason}、user/message（即 UserMessage，带 source）、assistant/message{turn, step, message}、tool/call{callId, name, arguments}、tool/result{message.content[0]=ToolResultBlock{toolCallId, isError}}。',
      '- surface 只有三种类型：user/message、assistant/message、tool/result；tool/call 不在 surface 上（配平校验必须遍历日志区间而非 surface 节点）。',
      '- 替换节点 = user/message + surfaceOp {op: replace, start, end} + source 标记（plugin: turn-memory 或 compact）。',
      '- 判断某 turn 是否已被替换：搜索 source.plugin 标记，不要用 seq 范围（替换节点的 seq 大于该 turn 的 turn/end seq）。',
      '- 事件类型统计：解压后按行 json.loads，Counter(e[type])。',
    ].join(NL),
  },
  {
    name: 'dsh-turn-memory',
    description: 'dsh-plugin-turn-memory 插件（turn 级摘要+延迟替换+expand_turn 召回）的运维、配置与行为约定。USE FOR: turn 摘要未生成/未替换、调试日志、插件修改、expand_turn 行为、turn-memory 相关排障时。',
    content: [
      '# dsh-plugin-turn-memory 运维',
      '',
      '本技能随插件分发（运行时注册，rank 250）。项目级技能（<项目>/.dsh/skills 或 <项目>/.agents/skills）可覆盖同名技能；用户级文件技能会被本内嵌版本遮蔽。',
      '',
      '## 配置（profile cordis.patch.yml 的 turn-memory 行）',
      '',
      '- debug: false（默认）。开 true 后管道轨迹写 $DSH_HOME/turn-memory-debug.log。用文件级日志是因为 cordis logger 只写内存缓冲、不落盘，且 /tmp 对服务器进程私有。',
      '- 其余键与默认：recallTimeoutMs 180000、cheapProvider deepseek-official、cheapModel deepseek-chat、cheapMaxTokens 8192、recallRecentWindowMs 7200000、maxRawChars 500000、toolResultCapChars 20000、maxRecallDepth 4、prefixDumpDir 留空（默认关闭）。',
      '',
      '## 行为约定',
      '',
      '- turn-memory 资格按持久化 origin 判定，不看运行时归属：origin 非 subagent 的会话（主会话与 fork，无论 live 还是 resumed）turn 结束时自动触发压缩 fork；仅一次性召回 subagent（origin 为 subagent）不参与（避免为一次性会话浪费主模型 fork）。',
      '- turn 结束 → registerTurn 登记（幂等、日志驱动、无 assistant 内容的 turn 跳过）并立即 spawn 主模型 fork 子代理（parent=agent、toolFilter 只允许 read/edit）：引擎先把该 turn 的 span 渲染成 checkpoint 同款标签格式（<user-steer>/<assistant> 逐字、原始过程在 <working> 块内，工具结果按 toolResultCapChars 截断）写进草稿 <cwd>/.dsh-turn-summary-<sessionId>-turn<N>.md（只读改工具面下空文件没有 edit 锚点，必须预填转录），fork 用 edit 只就地缩短各 <working> 块内容、标签结构不动，回复 DONE；引擎读回草稿 → tryReplace 立即把该 turn 的 span（起始用户消息之后、它逐字留在 surface）替换为 <turn-summary turn=N version=N> checkpoint → 删草稿。fork 失败或空草稿 → turn stays raw，之后每次 turn 结束的 sweep 按最旧优先重试未替换 turn。',
      '- 服务器重启（内存态丢失）→ agent/created 恢复：最后一个已完成 turn 若无 checkpoint 则 registerTurn 并立即 spawn fork；更旧的缺口由之后 turn 结束的 sweep 补。',
      '- compact_turn 工具：无 turn 内模式、无 summary 参数；只带可选 turn 参数补触发压缩 fork（缺省为最后一个已完成 turn），已在飞/已替换/未找到各有报错；主 agent 不自己写摘要（MEMORY_SECTION 已写明，摘要只由 fork 在草稿文件上产出）。',

'- prefixDumpDir 非空时，每次压缩替换落盘后把接缝处最后两个节点（新 checkpoint + 其后第一个保留节点，按它们在 request 前缀里的文本形态渲染）追加写入 <prefixDumpDir>/request-prefix-<sessionId>.txt——按 session 各建一个文件（每个替换一块、块间以分隔线隔开，文件只增不减、最早的替换边界在最前），肉眼确认替换边界用。',
      '- 替换节点 source = {kind: plugin, plugin: turn-memory, turn, turnSummaryId, version, scope: whole-turn}——scope 字段为兼容历史保留：旧日志里的 in-turn checkpoint 一律不算已替换。',
      '- expand_turn 双模式：agentic（默认；工具按 turn 的时间内部路由——end 距今 ≤ recallRecentWindowMs（默认 7200000，2 小时）的近期 turn 由 fork 回答，fork 的上下文是已完成 turn 的原始全文重放（不是 checkpoint），且仅当 provider 磁盘缓存还保留着这些 turn 直播时持久化的 prefix unit 时才是暖的、零额外模型调用；更早的 turn 由 cheap 模型读完整转录定向回答；question 必填）与 raw（原文直读、最后手段、超长按 maxRawChars 截断；question 忽略）。',
      '- 摘要与操作说明的分工：摘要只记发生了什么/决定了什么；可复用操作步骤放技能，摘要里只留名字引用。',
      '- 压缩后端：本插件（turn-memory）的 turn 摘要全部由主模型 fork 在草稿文件上产出、自己 splice 落盘——完全不依赖任何 compaction 后端；ctx.compaction 仍由本体系第二步插件 dsh-plugin-replay-compaction 提供（web 的 cordis.patch.yml 已禁用 harness 自带 dsh-compaction-basic），只服务压力自动压缩与 /compact。注意：内置 agent preset（standard / code=「PTC 模式」）各自带一个 isolate 组重新挂载 compaction-basic + command-compact + tool-result-pruner，host 补丁够不到它——这些 preset 的会话里手动 /compact 与压力压缩走 basic 引擎，不是 fold。个人 preset `vilicvane`（~/.dsh/.agent-presets/vilicvane，code 的 fork，删除了该 isolate 组、command-compact 独立成行）/compact 与压力压缩统一走 replay fold；新会话建议选它。模型分工：turn 摘要 = 主模型 fork（暖前缀、含 turn 全文重放）；session 压缩摘要 = cheap 模型（replay-compaction），互不牵扯。',
      '',
      '## 修改插件后',
      '',
      '改 index.ts / lib/*.ts → pnpm typecheck 类型校验 + pnpm test 单元测试 → 在回复里提醒用户手动重启 dsh web 生效（默认不自动调度重启，见 dsh-web-restart 技能铁律）。',
      '冒烟测试环境：headless profile $DSH_HOME/profiles/test-turn-memory（base + headless 启动 + 两轮测试驱动器 dsh-plugin-test-runner）。',
    ].join(NL),
  },
];

function apply(ctx, config) {
  const settings = resolveSettings(config);
  debugEnabled = settings.debug === true;
  dbg('apply: plugin mounted');

  /** sessionId -> { items: Map<turn, PendingSummary>, lastTurn: number } */
  const states = new Map();

  /**
   * Full-treatment test for the turn-memory machinery. Decided by durable
   * origin, not runtime ownership: the main conversation and forks qualify —
   * forks are continuable user-facing conversations, and a fork's header
   * carries no `origin` field even while a live fork agent is owned by its
   * parent agent at runtime (the agent registry's roots() only covers
   * top-level agents, so it misclassifies live forks). Only subagent-origin
   * sessions — one-shot recall children — are excluded.
   */
  function isTurnMemorySession(agent) {
    try {
      return agent !== undefined && agent.session?.header?.origin !== 'subagent';
    } catch {
      return false;
    }
  }

  ctx.systemPrompt.section({ name: 'turn-memory', order: 120, text: MEMORY_SECTION });



  for (const skill of PLUGIN_SKILLS) {
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      source: 'runtime',
      content: skill.content,
    });
  }

  ctx.tools.register(defineTool({
    name: 'expand_turn',
    description: [
      'Recall the full information of a past conversation turn, which is otherwise represented by a summary in the context.',
      'Modes:',
      '- agentic: the tool routes by the turn\'s age itself — a turn that ended recently (within recallRecentWindowMs, default 2h) is answered by a fork whose context replays the completed turns verbatim, so the target turn\'s full text is already in that context; an older turn is read in full by a cheap model. Give it a focused question.',
      '- raw: the full text of the turn is returned directly into the conversation (very large turns are truncated); the most context-consuming, use as a last resort.',
      'Defaults to agentic. question is required for agentic mode and ignored for raw.',
    ].join(' '),
    parameters: {
      turn: {
        type: 'integer',
        required: true,
        description: 'The turn number to recall (1-based, numbered by this session turns).',
      },
      question: {
        type: 'string',
        description: 'What to ask or look up about that turn. Required for agentic mode; ignored for raw.',
      },
      mode: {
        type: 'string',
        enum: ['agentic', 'raw'],
        description: 'Recall mode; defaults to agentic.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) return 'expand_turn: no owning agent session';
      const session = agent.session;
      const span = findTurnSpan(session, args.turn);
      if (span === undefined) return 'expand_turn: turn ' + args.turn + ' was not found in this session';
      const mode = args.mode ?? 'agentic';
      if (mode === 'raw') return buildTurnTranscript(session, span, settings);
      if (mode === 'agentic') {
        const question = (args.question ?? '').trim();
        if (question === '') return 'expand_turn: a question is required for agentic mode';
        const route = routeAgenticRecall(session, args.turn, span);
        if (route === 'fork') return recallViaFork(agent, exec.signal, args.turn, question);
        return recallViaSubagent(agent, exec.signal, session, span, args.turn, question);
      }
      return 'expand_turn: unknown mode ' + String(mode);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall turn ' + args.turn,
      kind: 'other',
      rawInput: { turn: args.turn, mode: args.mode ?? 'agentic' },
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'compact_turn',
    description: [
      'Compact a COMPLETED turn into one turn-summary checkpoint via a fork subagent that reads the turn from its own context (a verbatim replay of the completed turns) and refines a per-turn draft file until it is final; the checkpoint replaces the turn span (starting right after its user message, which stays verbatim on the surface) as soon as the fork finishes.',
      'Turns are compacted automatically when they end and on agent recreation after a restart. Call this tool only to fill a gap: pass a completed turn number that still has no checkpoint, or omit the argument for the latest completed turn.',
      'It runs exclusively, so other tool calls wait.',
    ].join(' '),
    parameters: {
      turn: {
        type: 'integer',
        description: 'Optional completed turn number to compact; defaults to the latest completed turn without a summary checkpoint.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) return 'compact_turn: no owning agent session';
      const session = agent.session;
      const turnArg = typeof args.turn === 'number' && Number.isInteger(args.turn) ? args.turn : undefined;
      const target = turnArg ?? findLastEvent(session, 'turn/end')?.data?.turn;
      if (typeof target !== 'number') return 'compact_turn: no completed turn in this session yet';
      const openTurn = findLastEvent(session, 'turn/start');
      if (openTurn !== undefined && openTurn.data?.turn === target) return 'compact_turn: turn ' + target + ' is the open turn — completed turns only';
      const item = registerTurn(session, target);
      if (item === undefined) {
        return replacedTurnNumbers(session).has(target)
          ? 'compact_turn: turn ' + target + ' is already replaced by its summary checkpoint'
          : 'compact_turn: turn ' + target + ' was not found in this session';
      }
      if (item.replaced) return 'compact_turn: turn ' + target + ' is already replaced by its summary checkpoint';
      if (item.forkInFlight) return 'compact_turn: a summary fork for turn ' + target + ' is already running';
      void runTurnSummary(agent, item);
      return 'compact_turn: summary fork started for turn ' + target + '; the checkpoint lands when the fork finishes';
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Compact turn',
      kind: 'other',
    }),
  }));

  /**
   * Agentic recall routing by the turn's age: a turn whose end lies inside
   * recallRecentWindowMs is answered by a fork whose context replays the
   * completed-turn log verbatim (cheap only while the provider's disk cache
   * still holds the prefix units persisted when those turns ran); an older
   * turn is read in full by the cheap model (subagent). Falls back to
   * turn-number distance when the boundary events carry no timestamp.
   */
  function routeAgenticRecall(session, turn, span) {
    const endTime = span.endTime ?? span.startTime;
    const newest = findLastEvent(session, 'turn/end')?.data?.turn ?? 0;
    return routeRecallByAge({ turn, endTime, newestTurn: newest, now: Date.now(), recentWindowMs: settings.recallRecentWindowMs });
  }

  /** AbortController fused with a timeout and the caller's signal. */
  function fusedController(signal, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }

  function recallForkPrompt(turn, question) {
    return [
      'A recall question about this coding-assistant conversation:',
      '',
      question,
      '',
      'Your context is a verbatim replay of the completed turns of the parent session, so the full original text of turn ' + turn + ' (its user message and every assistant and tool event) is already in your context. Answer the question directly from that full text. If part of it was compacted away inside this fork, use the expand_turn tool with mode raw to read the full text of turn ' + turn + ' before answering. Answer directly and concisely; quote exact paths, commands, error strings, and values where relevant.',
    ].join(NL);
  }

  function recallSubagentPrompt(turn, question, transcript) {
    return [
      'Read the transcript of one turn from a coding-assistant session, then answer the question. Quote exact values, paths, commands, identifiers, and error strings where relevant. Answer in the language of the question.',
      '',
      'Question: ' + question,
      '',
      '<turn-transcript turn="' + turn + '">',
      transcript,
      '</turn-transcript>',
    ].join(NL);
  }

  async function recallViaFork(agent, signal, turn, question) {
    const fused = fusedController(signal, settings.recallTimeoutMs);
    let run;
    try {
      run = await ctx.subagents.start('fork', {
        label: 'recall turn ' + turn,
        prompt: [{ type: 'text', text: recallForkPrompt(turn, question) }],
        parent: agent,
        signal: fused.signal,
        maxDepth: settings.maxRecallDepth,
      });
    } catch (error) {
      fused.dispose();
      return 'expand_turn (fork): could not start the recall fork: ' + errorText(error);
    }
    try {
      const result = await run.result;
      if (result.stopReason !== 'completed') return 'expand_turn (fork): recall ended with ' + JSON.stringify(result.stopReason);
      const text = extractText(result.output);
      return text === '' ? 'expand_turn (fork): the recall fork produced no answer' : text;
    } catch (error) {
      return 'expand_turn (fork): recall failed: ' + errorText(error);
    } finally {
      fused.dispose();
      try { await run.dispose(); } catch { /* resource release is best-effort */ }
    }
  }

  async function recallViaSubagent(agent, signal, session, span, turn, question) {
    const transcript = buildTurnTranscript(session, span, settings);
    const fused = fusedController(signal, settings.recallTimeoutMs);
    let run;
    try {
      run = await ctx.subagents.start('spawn', {
        label: 'recall turn ' + turn,
        prompt: [{ type: 'text', text: recallSubagentPrompt(turn, question, transcript) }],
        parent: agent,
        signal: fused.signal,
        maxDepth: settings.maxRecallDepth,
        toolFilter: { allow: [] },
        agentOptions: {
          provider: settings.cheapProvider,
          model: settings.cheapModel,
          maxTokens: settings.cheapMaxTokens,
        },
      });
    } catch (error) {
      fused.dispose();
      return 'expand_turn (subagent): could not start the recall subagent: ' + errorText(error);
    }
    try {
      const result = await run.result;
      if (result.stopReason !== 'completed') return 'expand_turn (subagent): recall ended with ' + JSON.stringify(result.stopReason);
      const text = extractText(result.output);
      return text === '' ? 'expand_turn (subagent): the recall subagent produced no answer' : text;
    } catch (error) {
      return 'expand_turn (subagent): recall failed: ' + errorText(error);
    } finally {
      fused.dispose();
      try { await run.dispose(); } catch { /* resource release is best-effort */ }
    }
  }

  /**
   * Surface-order seqs of one completed turn's replaceable span: surface
   * nodes in (startSeq, endSeq] minus the turn's own starting user message
   * (it stays verbatim on the surface) and foreign turn-summary checkpoints.
   * Shared semantics with tryReplace's span walk.
   */
  function turnSpanSeqs(session, startSeq, endSeq, turn) {
    const events = session.events;
    let initialUserSeq = null;
    for (let seq = startSeq + 1; seq <= endSeq; seq += 1) {
      const event = events[seq];
      if (event === undefined) break;
      if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === 'user') {
        initialUserSeq = seq;
        break;
      }
    }
    const spanSeqs: number[] = [];
    for (const seq of session.surface.nodes) {
      if (seq <= startSeq || seq > endSeq || seq === initialUserSeq) continue;
      if (foreignCheckpointOf(events[seq], turn)) continue;
      spanSeqs.push(seq);
    }
    return spanSeqs;
  }

  /** Draft-file path for one turn's summary fork (per-turn scratch the fork edits; deleted when the checkpoint lands). */
  function draftPathFor(session, turn) {
    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd();
    return join(cwd, '.dsh-turn-summary-' + String(session.id) + '-turn-' + turn + '.md');
  }

  /**
   * Run the turn-summary fork for one completed turn. The fork's context is a
   * verbatim replay of the session's completed turns, so it reads the turn
   * there and refines the per-turn draft file (read/edit only); when it
   * settles, the draft becomes the checkpoint and the turn is replaced
   * immediately. One turn, one fork; retries reuse the same item.
   */
  async function runTurnSummary(agent, item) {
    if (item.forkInFlight) return;
    item.forkInFlight = true;
    const session = agent.session;
    const draftPath = draftPathFor(session, item.turn);
    let run;
    try {
      // Seed the draft with the full turn transcript: the fork's tool surface
      // is read/edit only, and edit needs a non-empty anchor — an empty file
      // leaves the fork nothing to replace. The fork compresses the rendered
      // transcript in place.
      const spanSeqs = turnSpanSeqs(session, item.startSeq, item.endSeq, item.turn);
      const transcript = renderTurnSpanText(session.events, spanSeqs, { maxToolResultChars: settings.toolResultCapChars });
      if (transcript.trim() === '') {
        item.forkInFlight = false;
        dbg('runTurnSummary: turn ' + item.turn + ' has no renderable span; the turn stays raw');
        ctx.logger.warn('turn-memory: turn ' + item.turn + ' has no renderable span; the turn stays raw');
        return;
      }
      try { writeFileSync(draftPath, transcript); } catch (error) {
        item.forkInFlight = false;
        dbg('runTurnSummary: draft write failed for turn ' + item.turn + ': ' + errorText(error));
        ctx.logger.warn('turn-memory: could not write the summary draft for turn ' + item.turn + ': ' + errorText(error));
        return;
      }
      dbg('runTurnSummary: draft seeded for turn ' + item.turn + ' (' + transcript.length + ' chars, ' + spanSeqs.length + ' nodes)');
      run = await ctx.subagents.start('fork', {
        label: 'turn-summary ' + item.turn,
        prompt: [{ type: 'text', text: buildSummaryPrompt(item.turn, draftPath) }],
        parent: agent,
        signal: item.controller.signal,
        toolFilter: { allow: ['read', 'edit'] },
      });
    } catch (error) {
      item.forkInFlight = false;
      dbg('runTurnSummary: start failed for turn ' + item.turn + ': ' + errorText(error));
      ctx.logger.warn('turn-memory: could not start summary fork for turn ' + item.turn + ': ' + errorText(error));
      return;
    }
    dbg('runTurnSummary: fork started for turn ' + item.turn + ' (draft ' + draftPath + ')');
    try {
      const result = await run.result;
      dbg('runTurnSummary: fork settled for turn ' + item.turn + ' stopReason=' + String(result.stopReason));
      if (result.stopReason !== 'completed') {
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' ended with ' + JSON.stringify(result.stopReason) + '; the turn stays raw');
        return;
      }
      let draft = '';
      try { draft = readFileSync(draftPath, 'utf8'); } catch { /* missing draft */ }
      draft = draft.trim();
      if (draft === '') {
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' left no draft; the turn stays raw');
        return;
      }
      item.summary = draft;
      dbg('runTurnSummary: draft captured for turn ' + item.turn + ' (' + draft.length + ' chars)');
      const replaced = tryReplace(session, item, 'whole-turn (fork, turn ' + item.turn + ')');
      dbg('runTurnSummary: turn ' + item.turn + ' replaced=' + String(replaced));
      ctx.logger.info('turn-memory: turn ' + item.turn + ' summarized (' + draft.length + ' chars, replaced=' + String(replaced) + ')');
    } catch (error) {
      dbg('runTurnSummary: result failed for turn ' + item.turn + ': ' + errorText(error));
      ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' failed: ' + errorText(error) + '; the turn stays raw');
    } finally {
      item.forkInFlight = false;
      try { unlinkSync(draftPath); } catch { /* best-effort */ }
      try { await run.dispose(); } catch { /* resource release is best-effort */ }
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    try {
      const session = agent.session;
      dbg('idle: agent status idle, session=' + String(session.id) + ' parentSession=' + String(session.header.parentSession));
      if (!isTurnMemorySession(agent)) return;
      const lastEnd = findLastEvent(session, 'turn/end');
      if (lastEnd === undefined) return;
      const turn = lastEnd.data.turn;
      let state = states.get(session.id);
      if (state === undefined) {
        state = { items: new Map(), lastTurn: 0 };
        states.set(session.id, state);
      }
      if (state.lastTurn >= turn) {
        dbg('idle: turn ' + turn + ' already handled (lastTurn=' + state.lastTurn + ')');
        return;
      }
      state.lastTurn = turn;
      dbg('idle: agent status idle after turn ' + turn);
      // Older turns left unsummarized (restarts, missed idle events) get a
      // fork summary now, oldest first.
      const older = [...state.items.values()]
        .filter((item) => item.turn < turn && !item.replaced && item.forkInFlight !== true)
        .sort((a, b) => a.turn - b.turn);
      for (const item of older) {
        dbg('idle: turn ' + item.turn + ' left unsummarized; spawning summary fork');
        void runTurnSummary(agent, item);
      }
      // The turn that just completed goes straight to its own summary fork.
      const item = registerTurn(session, turn);
      if (item !== undefined) {
        dbg('idle: turn ' + turn + ' registered; spawning summary fork');
        void runTurnSummary(agent, item);
      }
    } catch (error) {
      dbg('idle: handling failed: ' + errorText(error));
      ctx.logger.warn('turn-memory: idle handling failed: ' + errorText(error));
    }
  });

  /**
   * Idempotent, log-driven turn registration: registers a completed turn when
   * it has no summary checkpoint yet. Shared by the idle handler, the
   * agent/created recovery and the compact_turn trigger — registration can
   * be lost when a restart lands while a turn is open, and re-deriving it
   * from the log keeps the flow independent of event delivery.
   */
  function registerTurn(session, turn) {
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return undefined;
    let state = states.get(session.id);
    if (state === undefined) {
      state = { items: new Map(), lastTurn: 0 };
      states.set(session.id, state);
    }
    const existing = state.items.get(turn);
    if (existing !== undefined) return existing;
    if (replacedTurnNumbers(session).has(turn)) {
      dbg('registerTurn: turn ' + turn + ' already replaced');
      state.lastTurn = Math.max(state.lastTurn, turn);
      return undefined;
    }
    const span = findTurnSpan(session, turn);
    if (span === undefined || span.endSeq === undefined) return undefined;
    if (!hasEventBetween(session, 'assistant/message', span.startSeq, span.endSeq)) {
      dbg('registerTurn: turn ' + turn + ' has no assistant content; skipping');
      return undefined;
    }
    state.lastTurn = Math.max(state.lastTurn, turn);
    const controller = new AbortController();
    const item = {
      turn,
      startSeq: span.startSeq,
      endSeq: span.endSeq,
      controller,
      summary: undefined,
      replaced: false,
      forkInFlight: false,
      turnSummaryId: randomUUID(),
    };
    state.items.set(turn, item);
    dbg('registerTurn: turn ' + turn + ' registered (' + span.startSeq + '..' + span.endSeq + ')');
    return item;
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!isTurnMemorySession(agent)) return;
      const session = agent.session;
      const lastEnd = findLastEvent(session, 'turn/end');
      if (lastEnd === undefined) return;
      const item = registerTurn(session, lastEnd.data.turn);
      if (item !== undefined) {
        dbg('recovery: turn ' + item.turn + ' registered on agent creation; spawning summary fork');
        void runTurnSummary(agent, item);
      }
    } catch (error) {
      dbg('recovery: handling failed: ' + errorText(error));
      ctx.logger.warn('turn-memory: resume recovery failed: ' + errorText(error));
    }
  });

  /**
   * Whether one surface node is another turn's summary checkpoint. A landed
   * checkpoint's seq falls inside the NEXT turn's span (the replacement runs
   * at that turn's first pre-step), so the plain seq-range walk would shadow
   * the previous turn's checkpoint with this turn's replacement and silently
   * erase its summary from the surface. Foreign checkpoints are excluded from
   * the replaced span; a foreign checkpoint in the middle still makes the span
   * non-contiguous and skips the replacement.
   */
  function foreignCheckpointOf(event, ownTurn) {
    if (event === undefined || event.type !== 'user/message') return false;
    const source = event.data?.source;
    return source?.kind === 'plugin' && source.plugin === SUMMARY_MARKER_PLUGIN && typeof source.turn === 'number' && source.turn !== ownTurn;
  }

  /**
   * Append the request-prefix boundary dump after a replacement lands: the
   * checkpoint node and the first kept node after it — the last two nodes at
   * the boundary — rendered the way their text reaches the front of the next
   * request. Blocks accumulate in one file per session, oldest first,
   * separated by a divider line. Disabled unless prefixDumpDir is set;
   * best-effort.
   */
  function dumpPrefixBoundary(session, mode, beforeSeq, checkpointSeq, nextSeq, replacedNodes, replacedSpan, note) {
    const dir = settings.prefixDumpDir;
    if (typeof dir !== 'string' || dir === '') return;
    try {
      mkdirSync(dir, { recursive: true });
      const file = dir + '/' + buildDumpFileName(String(session.id));
      const text = renderPrefixBoundary(
        {
          timestamp: new Date().toISOString(),
          sessionId: String(session.id),
          mode,
          beforeSeq,
          checkpointSeq,
          nextSeq,
          replacedNodes,
          replacedSpan,
          note,
        },
        beforeSeq === null || beforeSeq === undefined ? undefined : session.events[beforeSeq],
        session.events[checkpointSeq],
        nextSeq === null ? undefined : session.events[nextSeq],
      );
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, appendDumpBlock(existing, text));
      dbg('prefix-dump: ' + file + ' appended (' + mode + '; checkpoint seq ' + checkpointSeq + ', next seq ' + String(nextSeq) + ')');
    } catch (error) {
      dbg('prefix-dump: FAILED ' + errorText(error));
    }
  }

  /** Replace one completed turn with its summary checkpoint; returns false when skipped. */
  function tryReplace(session, item, via) {
    const events = session.events;
    // The turn's own user message stays on the surface: the replacement span
    // starts AFTER it, so the checkpoint never needs to repeat it — the
    // original remains in context right before the checkpoint. Falls back to
    // folding the whole span when the turn carries no user message.
    let initialUserSeq: number | null = null;
    for (let seq = item.startSeq + 1; seq <= item.endSeq; seq += 1) {
      const event = events[seq];
      if (event === undefined) break;
      if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === 'user') {
        initialUserSeq = seq;
        break;
      }
    }
    const spanSeqs: number[] = [];
    const skippedForeign: number[] = [];
    let firstIdx = -1;
    let lastIdx = -1;
    session.surface.nodes.forEach((seq, index) => {
      if (seq > item.startSeq && seq <= item.endSeq) {
        if (seq === initialUserSeq) return;
        const event = events[seq];
        if (foreignCheckpointOf(event, item.turn)) {
          skippedForeign.push(seq);
          return;
        }
        spanSeqs.push(seq);
        if (firstIdx < 0) firstIdx = index;
        lastIdx = index;
      }
    });
    if (skippedForeign.length > 0) {
      dbg('tryReplace: turn ' + item.turn + ' excluding foreign turn-summary checkpoints ' + skippedForeign.join(',') + ' from span');
    }
    if (spanSeqs.length === 0) {
      dbg('tryReplace: turn ' + item.turn + ' SKIP no surface nodes in span (' + item.startSeq + ', ' + item.endSeq + ']');
      return false;
    }
    if (lastIdx - firstIdx + 1 !== spanSeqs.length) {
      dbg('tryReplace: turn ' + item.turn + ' SKIP non-contiguous span (idx ' + firstIdx + '..' + lastIdx + ', ' + spanSeqs.length + ' nodes)');
      return false;
    }
    // Pair tool calls with their results over the LOG range, not the surface
    // nodes: tool/call events never appear on the surface, so a surface-based
    // walk would see every tool/result as unbalanced.
    const openCalls = new Set();
    for (let seq = item.startSeq + 1; seq <= item.endSeq; seq += 1) {
      const event = events[seq];
      if (event === undefined) {
        dbg('tryReplace: turn ' + item.turn + ' SKIP events[' + seq + '] undefined (events.length=' + events.length + ')');
        return false;
      }
      if (event.type === 'tool/call') {
        openCalls.add(event.data?.callId);
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.content?.[0]?.toolCallId;
        if (callId === undefined || !openCalls.has(callId)) {
          dbg('tryReplace: turn ' + item.turn + ' SKIP unbalanced tool result at seq ' + seq);
          return false;
        }
        openCalls.delete(callId);
      }
    }
    if (openCalls.size > 0) {
      dbg('tryReplace: turn ' + item.turn + ' SKIP open tool calls remain');
      return false;
    }
    // No preamble: recall guidance lives in the Conversation Memory system
    // prompt section, and identity lives in the tag and the source marker.
    const resolvedSummary = resolveVerbatimTags(session, item, item.summary);
    const checkpointText = [
      '<turn-summary turn="' + item.turn + '" version="' + TURN_SUMMARY_VERSION + '">',
      resolvedSummary,
      '</turn-summary>',
    ].join(NL);
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: checkpointText }],
      source: {
        kind: 'plugin',
        plugin: SUMMARY_MARKER_PLUGIN,
        turn: item.turn,
        turnSummaryId: item.turnSummaryId,
        version: TURN_SUMMARY_VERSION,
        scope: 'whole-turn',
      },
    }, {
      surfaceOp: { op: 'replace', start: spanSeqs[0], end: spanSeqs[spanSeqs.length - 1] },
      sourceEventSeqs: spanSeqs,
    });
    item.replaced = true;
    item.replacedNodes = spanSeqs.length;
    const surfaceAfter = session.surface.nodes;
    const checkpointSeq = surfaceAfter[firstIdx];
    const nextSeq = surfaceAfter[firstIdx + 1] ?? null;
    dumpPrefixBoundary(session, via, initialUserSeq, checkpointSeq, nextSeq, spanSeqs.length, '[' + spanSeqs[0] + ', ' + spanSeqs[spanSeqs.length - 1] + ']', initialUserSeq === null ? undefined : 'turn-starting user message seq ' + initialUserSeq + ' stays verbatim BEFORE the checkpoint');
    dbg('tryReplace: turn ' + item.turn + ' REPLACED span [' + spanSeqs[0] + ', ' + spanSeqs[spanSeqs.length - 1] + '] (' + spanSeqs.length + ' nodes)');
    ctx.logger.info('turn-memory: replaced turn ' + item.turn + ' (shadowed ' + spanSeqs.length + ' surface nodes)');
    return true;
  }

  ctx.on('agent/disposed', ({ agent }) => {
    const session = agent.session;
    const state = states.get(session?.id);
    dbg('agent-disposed: session=' + String(session?.id) + ' hadState=' + String(state !== undefined) + (state !== undefined ? ' items=' + state.items.size : ''));
    if (state === undefined) return;
    for (const item of state.items.values()) item.controller.abort();
    states.delete(session.id);
  });

  ctx.effect(() => () => {
    for (const state of states.values()) {
      for (const item of state.items.values()) item.controller.abort();
    }
    states.clear();
  });
}

export { apply, inject, name };
