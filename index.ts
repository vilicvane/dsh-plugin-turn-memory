/**
 * dsh-plugin-turn-memory — turn-granular context memory for DeepSeek Harness.
 *
 * Step 1 of a two-step context-compression plan:
 *
 *  - When a root agent's turn completes, the turn is only marked pending. On
 *    the next turn the runtime context carries a pending notice, and the MAIN
 *    agent — the current context itself, with the user's new message in view —
 *    composes the previous turn's whole-turn checkpoint per the bundled
 *    dsh-compact-turn skill and compacts that turn through
 *    compact_turn(turn, summary). A one-shot FORK (same model as the
 *    conversation, sharing the warm request prefix) summarizes a turn only as
 *    a fallback when the main agent leaves it unsummarized for a whole turn.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { checkToolPairBalance, computeSpanBoundaries, computeWalkRange, shrinkCheckError } from './lib/bounds.ts';
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
  /** How long the next turn's pre-step waits for an in-flight summary fork. */
  summaryTimeoutMs: 120000,
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
  /** Surface-node count of the current turn that triggers the compact_turn tail reminder; the second tier fires at 1.5x. */
  reminderNodeThreshold: 30,
};

/** Summary instruction for the fallback per-turn summary fork (spawned only when the main agent leaves a completed turn unsummarized). */
function buildSummaryPrompt(turn) {
  return [
    'You are writing the running record for the turn that just completed in this coding-assistant session.',
    '',
    'Summarize ONLY turn ' + turn + ' — the most recent completed turn: its user request and the assistant work that followed. Earlier turns are already represented by their own summaries; reference them where this turn depends on or corrects them, but do not re-summarize them.',
    '',
    'Write a COMPACT record in the original chronological order. Keep only what a future turn needs; drop transient detail such as individual tool calls, intermediate output, and routine checks.',
    '',
    'Keep the original order with no root wrapper: each user message and each user-facing reply stays verbatim in place, and only the intermediate process between them is compressed in place — never add dialogue/summary labels or split the record into sections; each entry starts on its own line. The tail naturally carries what stands at the end and what awaits the user.',
    '',
    'Marking:',
    '- Write hindsight in natural language, not bracket tags. When a later development proves an earlier entry wrong, annotate it at the point it went wrong — for example: "I thought X might work. (It later turned out wrong.)" — and keep the correction beside the entry it revises. When this turn invalidates something from an earlier summary, say so in natural language and name that turn.',
    '- State assumptions as they were felt at the time ("I assumed X, unverified"). When a later entry disproves one, add the natural-language correction there rather than rewriting the original entry.',
    '- If the turn ended waiting for the user, include the pending question and ALL its options VERBATIM as a timeline entry — the next answer will likely refer to these options by their wording.',
    '- End the timeline with the single next action when one is clear.',
    '- Preserve VERBATIM whatever keeps your intuition about the current context: the user\'s exact wording and emphasis, your own commitments and offers, and any phrasing a later turn is likely to refer back to. Commands, paths, identifiers, and error strings stay verbatim too. A summary that loses the wording loses the thread.',
    '- Preserve read-in material (code, docs, config, output) as paths, not content: inline only short key snippets (a critical line, a value); for anything longer record the exact path plus ONE short line saying what it is and why it matters, and re-read the file with the read tool when the content is needed again — copied text goes stale, the file stays current. Do not duplicate what an earlier checkpoint, a loaded skill, or another entry of this summary already covers.',
    '- The message that started this turn stays ON the surface right before the checkpoint — the replacement span starts after it — so do NOT include it in the summary at all; its original is already in context. Every user message inside the span is therefore a steering message: keep it verbatim in its own <user-steer>…</user-steer> element.',
    '- Keep the original order — the surface already wraps the record as a turn-summary, so add no root wrapper of your own: every user message in the span is a steering message and stays verbatim in its own <user-steer>…</user-steer> element, every user-facing assistant text output stays verbatim in its own <assistant>…</assistant> element at its original position, and only the intermediate process (reasoning blocks, tool calls, tool results, routine checks) is compressed in place into a <working>…</working> element. The elements alternate in the order things happened — users may steer between replies and the assistant may alternate working and chatting — and the tags themselves mark the speaker, so no "user:"/"assistant:"/"process:" prefixes and no dialogue/summary labels or sections. The record should read like the conversation itself, just with the process shortened.',
    '- Once this summary lands, it is the only trace of this turn the main context sees: the original text is gone and can only be recovered with an expand_turn recall (or by re-reading files), each costing tokens and time. Keep whatever a future turn is likely to reference, verify, or continue — a line kept now is cheaper than a recall later.',
    '- All compaction-machinery process is transient infrastructure — compact_turn calls and probes, node counts, replacement results, pending notices and registration state, restart scheduling for compaction changes: none of it enters the summary; keep only the span\'s substantive outcomes (root causes, decisions, fixes, artifacts). After the summary lands, only the compressed content should remain in view.',
    '- Name skills and procedures instead of restating their steps ("restarted dsh web per the dsh-web-restart skill"); when unsure of the name, check the skill catalog with the skill tool.',
    '- The structure tags (<user-steer>/<assistant>/<working>) exist only inside this summary text; your output is the summary itself and nothing else.',
    '- Output only the summary text. Do not call any tool unless you must verify details of the turn you are summarizing; when detail is uncertain, verify it with the expand_turn tool (mode raw) rather than guessing.',
  ].join(NL);
}



/** Memory guidance section added to every agent's system prompt. */
const MEMORY_SECTION = [
  '## Conversation Memory',
  '',
  'Each completed turn is stored as a flowing summary that marks the turn it replaces. Summaries fold turn-level detail; when one may not contain what you need, or when you must verify what happened in earlier turns — including when the user challenges a claim about them — recall the full information with the expand_turn tool BEFORE answering. Only the original transcripts settle the facts; summaries of neighboring turns can read as contradictory.',
  '',
  'Summaries annotate hindsight in natural language: entries later proven wrong carry an inline correction ("I thought X might work. It later turned out wrong."), and assumptions are stated as they were felt at the time. Treat later corrections as authoritative over earlier entries.',
  '',
  'During a long turn, compact proactively with the compact_turn tool before context pressure forces the automatic compactor. Compose the checkpoint text yourself from your current context, following the dsh-compact-turn skill, and pass it to compact_turn as the summary argument; the tool replaces the completed part of the current turn (everything after the turn-starting message, up to the current step) with that checkpoint. Checkpoints keep the original order with no root wrapper (the surface already wraps the record): every user message (always a steering message — the turn-starting message stays outside the span) stays verbatim in a <user-steer>…</user-steer> element, every user-facing reply verbatim in an <assistant>…</assistant> element, and only the intermediate process (thinking, tool calls, tool results) is compressed in place into a <working>…</working> element — the tags themselves mark the speaker, so no prefixes and no dialogue/summary labels or sections. Compose silently: the checkpoint text goes only into the summary argument, never printed as a message, and the structure tags appear only inside checkpoint text, never in live replies. What the checkpoint replaces leaves your context; recovering it later costs an expand_turn recall — keep in the checkpoint what a future step is likely to need. The turn-starting message and the current step stay verbatim.',
  '',
  'When the runtime context carries a pending-turn notice (a completed previous turn has no summary checkpoint yet), compose that turn\'s whole-turn checkpoint FIRST, following the dsh-compact-turn skill: keep the original order with no root wrapper (the surface already wraps the record) — the previous turn\'s starting user message stays verbatim ON the surface right before the checkpoint (the replacement span starts after it), so do NOT include it in the checkpoint; every user message inside the span is a steering message and stays verbatim in its own <user-steer>…</user-steer> element, every user-facing reply verbatim in its own <assistant>…</assistant> element, and only the intermediate process compressed in place into <working>…</working> elements, in original order — the tags mark the speaker, so no prefixes, labels, or sections; the message that just opened this turn is only a HINT for what the previous turn must retain — a lens, not a task: do not think it through yet, the real thinking starts after the summary lands; compose silently — the summary text goes straight into the compact_turn call and is never shown as chat, and the structure tags belong to checkpoint text only. Then call compact_turn with the turn number and the checkpoint text as the summary argument — the call replaces the span of the previous turn on the surface (starting right after its user message, which stays verbatim), and frees context for the rest of this turn. All compaction-machinery process is transient infrastructure — compact_turn calls and probes, node counts, replacement results, pending notices and registration state, restart scheduling for compaction changes: never include it in the checkpoint and never repeat it to the user; keep only substantive outcomes (root causes, decisions, fixes, artifacts). After the replacement lands, only the compressed content should remain in view.',
  '',
  'The recall modes:',
  '',
  '1. agentic — the tool routes by the turn\'s age itself: a turn that ended recently (within recallRecentWindowMs, default 2h) is answered by a fork whose context replays the completed turns verbatim — the target turn\'s full text is already in that fork context, and the fork is cheap only while the provider\'s disk cache still holds the prefix units persisted when those turns ran (best for deep questions about recent turns); an older turn is read in full by a cheap model that answers your question or produces a directed summary. Give agentic a focused question.',
  '2. raw — the full text of the turn is returned into the conversation. Most direct, most context consumed; very large turns are truncated. Last resort.',
  '',
  'Prefer agentic for lookups; use raw only when you need to work with the full text directly. Routine continuation must not require recall — summaries are written to support it. Recall exists for deep verification and rarely needed detail.',
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
 * whole-turn flow (pending notice, compact_turn whole-turn mode, fork
 * fallback) dies after any in-turn compaction. Checkpoints written before
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
      '- 其余键与默认：summaryTimeoutMs 120000、recallTimeoutMs 180000、cheapProvider deepseek-official、cheapModel deepseek-chat、cheapMaxTokens 8192、recallRecentWindowMs 7200000、maxRawChars 500000、toolResultCapChars 20000、maxRecallDepth 4、reminderNodeThreshold 30、prefixDumpDir 留空（默认关闭）。',
      '',
      '## 行为约定',
      '',
      '- turn-memory 资格按持久化 origin 判定，不看运行时归属：origin 非 subagent 的会话（主会话与 fork，无论 live 还是 resumed）都享受完整待遇——pending 登记、压缩提醒、compact_turn 全模式可用；仅一次性召回 subagent（origin 为 subagent）不参与 pending 机制（避免为一次性会话浪费 fork 兜底模型调用），compact_turn 的 turn 内模式则任何 agent 都可以对自己会话用。',
      '- turn 结束 → 该 turn 登记为 pending，零模型调用、不生成摘要；下一条用户消息到来时，runtime 上下文出现 pending 提示，主 agent（当前上下文）先按 dsh-compact-turn 技能撰写上一 turn 的整 turn checkpoint（新消息只是保留取舍的 hint/透镜、不为其展开实质思考；上一 turn 的起始用户消息保留在 surface 上、替换 span 从它之后开始，区间内的 steer 消息逐字进 <user-steer> 元素），再用 compact_turn(turn=N, summary) 立即把上一 turn 的 span（起始用户消息之后）替换为 <turn-summary turn=N version=N> checkpoint；最新用户消息永远逐字保留。主 agent 整个下一 turn 都没做 → 该 turn 结束时由主模型 fork 兜底补摘要（晚一个 turn，再下一个 pre-step 落地）。后验修正用自然语言括注（"我觉得这样可能不错。（但是后来发现不对）"），不用方括号标记；逐字保留维持上下文直觉的措辞（用户原话、自己做出的承诺、后续可能被引用的表述）。',
      '- 某 turn 长时间没有替换节点的可能：(1) 主 agent 未调用 compact_turn 或调用失败 → 下一 turn 结束时 fork 兜底，兜底摘要在再下一个 pre-step 落地；(2) 服务器重启（内存态丢失）→ 恢复时最后一个无 checkpoint 的已完成 turn 重新登记 pending，由恢复后的主 agent 在下一条用户消息到来时撰写。',
      '- compact_turn 模型工具：长 turn 中主动压缩当前 turn 已完成部分（turn 起始消息之后、当前 step 之前），只留起始消息逐字、当前 step 不动；独占执行保证压缩事务期间 surface 稳定。摘要由当前上下文（主模型自身）撰写——撰写规则在 dsh-compact-turn 技能里，随 summary 参数传入；工具自做全部折叠：范围/配平校验、收缩校验（checkpoint 字符数必须小于被折叠节点的模型可见文本）、checkpoint 落盘（surfaceOp replace + sourceEventSeqs，与 tryReplace 同款 splice）——完全不依赖任何 compaction 后端。带 turn 参数的整 turn 模式：把已完成 turn 的整段（含用户消息）替换为带 turn-memory 标记的 turn 摘要 checkpoint（复用 tryReplace 直接落盘，不走压缩后端、无收缩校验）。turn 内压缩产生的 checkpoint 会纳入该 turn 最终的 turn 摘要替换（收敛合并，不是原文重喂）；后续再次压缩时旧 checkpoint 以一条浓缩摘要参与合并。',
      '- 条件式尾部提醒：当前 turn 的 surface 节点数超过 reminderNodeThreshold（默认 30，按节点数不按 token）时，runtime 快照末尾出现一行提醒；超过 1.5 倍时升级为更直接的警告。低于阈值时零贡献、零 token；压缩落地后 turn 缩回阈值以下，提醒自行消失。',
'- prefixDumpDir 非空时，每次压缩替换落盘后把接缝处最后两个节点（新 checkpoint + 其后第一个保留节点，按它们在 request 前缀里的文本形态渲染）追加写入 <prefixDumpDir>/request-prefix-<sessionId>.txt——按 session 各建一个文件（每个替换一块、块间以分隔线隔开，文件只增不减、最早的替换边界在最前），肉眼确认替换边界用。',
      '- 替换节点 source = {kind: plugin, plugin: turn-memory, turn, turnSummaryId, version, scope: whole-turn | in-turn}——只有 scope whole-turn 算整 turn 已替换，in-turn checkpoint 不影响 pending 流程。',
      '- expand_turn 双模式：agentic（默认；工具按 turn 的时间内部路由——end 距今 ≤ recallRecentWindowMs（默认 7200000，2 小时）的近期 turn 由 fork 回答，fork 的上下文是已完成 turn 的原始全文重放（不是 checkpoint），且仅当 provider 磁盘缓存还保留着这些 turn 直播时持久化的 prefix unit 时才是暖的、零额外模型调用；更早的 turn 由 cheap 模型读完整转录定向回答；question 必填）与 raw（原文直读、最后手段、超长按 maxRawChars 截断；question 忽略）。',
      '- 摘要与操作说明的分工：摘要只记发生了什么/决定了什么；可复用操作步骤放技能，摘要里只留名字引用。',
      '- 压缩后端：本插件（turn-memory）已不依赖任何压缩后端——turn 内与整 turn 折叠全部自做；ctx.compaction 仍由本体系第二步插件 dsh-plugin-replay-compaction 提供（web 的 cordis.patch.yml 已禁用 harness 自带 dsh-compaction-basic），只服务压力自动压缩与 /compact。注意：内置 agent preset（standard / code=「PTC 模式」）各自带一个 isolate 组重新挂载 compaction-basic + command-compact + tool-result-pruner，host 补丁够不到它——这些 preset 的会话里手动 /compact 与压力压缩走 basic 引擎，不是 fold。个人 preset `vilicvane`（~/.dsh/.agent-presets/vilicvane，code 的 fork，删除了该 isolate 组、command-compact 独立成行）三入口（/compact、压力自动压缩、compact_turn）统一走 replay fold；新会话建议选它。曾有一次针对 compaction-basic 的指令补丁，经查是死代码，已用 npm 原版 tarball 还原并删除补丁脚本。模型分工：turn 内压缩与整 turn 替换的摘要 = 当前上下文自拟（规则见 dsh-compact-turn 技能）；fork 只作整 turn 摘要兜底（同样主模型）；session 压缩摘要 = cheap 模型（replay-compaction 的 chat 默认），互不牵扯。',
      '',
      '## 修改插件后',
      '',
      '改 index.ts / lib/*.ts → pnpm typecheck 类型校验 + pnpm test 单元测试 → 走 dsh-web-restart 技能重启生效。',
      '冒烟测试环境：headless profile $DSH_HOME/profiles/test-turn-memory（base + headless 启动 + 两轮测试驱动器 dsh-plugin-test-runner）。',
    ].join(NL),
  },
  {
    name: 'dsh-compact-turn',
    description: '为 compact_turn 撰写当前 turn 已完成部分的 checkpoint 摘要。USE FOR: 长 turn 主动压缩、调用 compact_turn 之前、撰写压缩内容时。',
    content: [
      '# dsh-compact-turn:为 compact_turn 撰写 checkpoint',
      '',
      'compact_turn 把你随 summary 参数传入的文本落成 checkpoint：不带 turn 参数时替换当前 turn 起始消息之后、当前 step 之前的已完成部分（起始消息与当前 step 逐字保留）；带 turn=N 时替换已完成 turn N 的折叠区间——但该 turn 的起始用户消息保留在 surface 上、checkpoint 之前（不进折叠区间、也不写进摘要，原文已经在上下文里），区间内其余内容折叠进 checkpoint。你就是撰写这份文本的人——你当前的上下文就是被压缩区间（或其绝大部分）本身，压缩前不需要额外读取或工具调用。',
      '',
      '## 撰写规则（两种模式通用）',
      '',
      '- 用 ONE 条流动的时间线写，不加 section 标题、不填表格：每次用户请求、决定、发现、修复或有意义的产出一条，按发生顺序排列；只保留这个区间后续还需要的内容，丢掉单次工具调用、中间输出（思考块、工具结果、例行检查）等临时细节。',
      '- 后来被证明错了的条目留在原处，在出错的位置加自然语言修正（"我觉得 X 可行。（后来发现不对。）"）；永远不要删条目。假设按当时的感觉陈述（"我当时假设 X，未验证"），后面的条目推翻它时在那里补一句修正。',
      '- 逐字保留维持上下文直觉的措辞：用户原话与强调、自己做出的承诺与提议、后续可能被引用的表述；命令、路径、标识符、错误串也逐字保留。',
      '- 保留原始时序、就地摘要，用标签标注每条内容的角色：不写根标签（外面已经是 turn-summary 包裹，checkpoint 内容直接就是标签序列），按发生顺序交替排列 <user-steer>…</user-steer>（区间内用户的每条消息——起始消息总在区间外，所以区间内必是中途 steer，逐字全文）、<assistant>…</assistant>（助手面向用户的正文输出，逐字全文）、<working>…</working>（对话输出之间的中间过程——思考、工具调用与结果、例行检查、注入的运行时上下文——在它的原位置就地压缩成一句）。用户可能中途 steer 更多消息、助手也可能工作一段输出一段对白，标签按实际发生顺序任意交替即可表达。标签即主体标记，不再加「用户：」等前缀、不另设分类标记或分节。',
      '- 结构标签只属于 checkpoint 文本：<user-steer>/<assistant>/<working> 只出现在传给 compact_turn 的 summary 里，正常对白中绝不写这些标签。',
      '- 可复用流程只写技能名/脚本路径，不重述步骤。',
      '- checkpoint 必须能独立承载这段记录，并保持明显短于被替换的区间。',
      '- 压缩即移出视野：checkpoint 落地后，被替换区间的原文就不再出现在你的上下文里，日后只能靠 expand_turn 召回（近期 fork 直接回答、更早由小模型读全文）或重读文件，每次都有 token 与时间成本；将来很可能被引用、核对、延续的细节，现在多留一行比以后花一次召回便宜。',
      '- 压缩机制的全部过程内容不进 checkpoint：compact_turn 的调用与探针验证、节点数量、替换结果、pending 提示与登记状态、为压缩相关改动调度的重启，都是短暂基础设施；checkpoint 只承载区间实质内容（根因、决策、修复、产出），压缩流程的过程叙述会随它所在 turn 的压缩自然消失，无需记录。',
      '',
      '## turn 内模式（无 turn 参数）',
      '',
      '- 起始消息与当前 step 不在区间内，摘要不必复述它们。',
      '- 不要写 <verbatim> 标签：turn 内压缩不会还原标签，写什么就原样留下什么。<user-steer>/<assistant>/<working> 结构标签是给人看的纯文本标记，会原样留在 surface 上，没问题。',
      '- 有收缩校验：checkpoint 不比被折叠区间小会整笔失败（按被折叠节点的模型可见文本字符数比较）。对话输出逐字保留导致过不了校验时，只压过程摘要的粒度；仍过不了就放弃这次 turn 内压缩（整 turn 压缩没有收缩校验），不得删减对话输出。',
      '',
      '## 整 turn 模式（带 turn 参数）',
      '',
      '- 目标 turn 的起始用户消息保留在 surface 上、checkpoint 之前：不进折叠区间、不要写进摘要（原文已经在上下文里，重复反而占位置）。区间内的用户消息都是中途 steer：逐字写入各自的 <user-steer>…</user-steer> 元素，保留原位置。',
      '- 目标 turn 内的对话输出同样逐字保留在各自原始位置的 <assistant>…</assistant> 里（没有标签可代，必须全文复制进 checkpoint）。',
      '- 当前 turn 的用户新消息不属于被替换区间，不要写进摘要；它只是目标 turn 用户消息的一条提示（hint），只用来判断保留取舍——凡与新问题相关的目标 turn 细节务必保留，无关的可以压掉。不要为这条 hint 展开实质思考：真正的思考在压缩完成后开始。',
      '- 只在 runtime 上下文出现 pending 提示时使用；一次调用只处理一个 turn，按 turn 号从小到大逐个处理。',
      '- 整 turn 替换不走压缩后端，没有收缩校验；checkpoint 仍应明显短于被替换的 turn。',
      '',
      '## 调用',
      '',
      '把摘要全文作为 summary 参数调用 compact_turn；整 turn 模式另把目标 turn 号作为 turn 参数传入。撰写与调用全程静默：摘要文本只进 summary 参数，绝不以消息形式展示、绝不作为对白输出；总结过程中不产生任何对白。压缩完成后回复用户时同样只讲实质结论（发现、修复、产出），不复述压缩动作与验证过程（调用、节点数、替换结果、探针、重启调度）。',
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

  // Conditional tail reminder for long turns: a runtime-context contribution
  // evaluated per step assembly. Below the threshold it contributes nothing
  // (zero tokens, zero noise); above it the end-of-context snapshot carries
  // one stable line nudging the model toward compact_turn. The snapshot is
  // self-replacing, so the reminder disappears on its own once a compaction
  // lands and the turn shrinks back below the threshold.
  ctx.systemPrompt.context({
    name: 'turn-compact-reminder',
    order: 130,
    text: (context) => {
      try {
        const session = context.agent?.session;
        if (session === undefined || !isTurnMemorySession(context.agent)) return '';
        const turnStart = findLastEvent(session, 'turn/start');
        if (turnStart === undefined) return '';
        const turnEnd = findLastEvent(session, 'turn/end');
        if (turnEnd !== undefined && turnEnd.seq > turnStart.seq) return '';
        const nodes = session.surface.nodes;
        const firstIdx = nodes.findIndex((seq) => seq > turnStart.seq);
        if (firstIdx < 0) return '';
        const count = nodes.length - firstIdx;
        if (count < settings.reminderNodeThreshold) return '';
        const tier2 = Math.ceil(settings.reminderNodeThreshold * 1.5);
        if (count >= tier2) {
          return 'Long turn warning: the current turn spans over ' + tier2 + ' surface nodes and keeps growing. Call compact_turn NOW — it condenses the completed steps into one checkpoint and frees context; waiting for automatic pressure risks a forced stop at a worse cut point.';
        }
        return 'Long turn notice: the current turn spans over ' + settings.reminderNodeThreshold + ' surface nodes. If the current phase is complete, call compact_turn — the finished part becomes one checkpoint while the turn-starting message and the current step stay verbatim.';
      } catch {
        return '';
      }
    },
  });

  // Pending-turn notice: while a completed previous turn still has no summary
  // checkpoint, every step's runtime context carries this instruction until
  // the main agent compacts that turn itself (compact_turn with the turn
  // argument). Self-replacing: the notice disappears the moment the turn is
  // replaced.
  ctx.systemPrompt.context({
    name: 'turn-summary-pending',
    order: 131,
    text: (context) => {
      try {
        const session = context.agent?.session;
        if (session === undefined || !isTurnMemorySession(context.agent)) return '';
        let state = states.get(session.id);
        if (state === undefined || state.items.size === 0) {
          registerPendingTurn(session);
          state = states.get(session.id);
        }
        if (state === undefined || state.items.size === 0) return '';
        const turnStart = findLastEvent(session, 'turn/start');
        if (turnStart === undefined) return '';
        const currentTurn = turnStart.data?.turn;
        if (typeof currentTurn !== 'number') return '';
        const pendingTurns: number[] = [];
        for (const item of state.items.values()) {
          if (!item.replaced && item.summary === undefined && item.turn < currentTurn) pendingTurns.push(item.turn);
        }
        if (pendingTurns.length === 0) return '';
        pendingTurns.sort((a, b) => a - b);
        return 'Pending turn summary: turn ' + pendingTurns.join(', ') + ' still ' + (pendingTurns.length === 1 ? 'has' : 'have') + ' no summary checkpoint. Before anything else, compose ' + (pendingTurns.length === 1 ? 'that turn\'s' : 'those turns\'') + ' checkpoint' + (pendingTurns.length === 1 ? '' : 's') + ' following the dsh-compact-turn skill — the message that opened this turn is only a hint for what to retain (a lens, not a task: do not think it through yet, the real thinking starts after the summary lands), and it is not part of the replaced span — then call compact_turn once per turn with the turn number and the checkpoint text as the summary argument. Doing this first frees context for the rest of the turn.';
      } catch {
        return '';
      }
    },
  });

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
      'Compactly summarize the completed portion of the CURRENT turn into one checkpoint, freeing context during a long turn.',
      'Compose the checkpoint text yourself from your current context, following the dsh-compact-turn skill, and pass it as the summary argument — no subagent summarizes the span for you.',
      'The compacted range is everything after the turn-starting message up to (excluding) the current step; the turn-starting message stays verbatim and the current step is untouched.',
      'With the optional turn argument, compact a COMPLETED previous turn whole instead: the span AFTER its turn-starting user message is replaced by your checkpoint — that message stays verbatim on the surface right before the checkpoint, so do not repeat it in the checkpoint (steering messages inside the span keep their own <user-steer>…</user-steer> elements).',
      'Use it proactively when the turn is getting long and more work lies ahead, before automatic pressure compaction forces a less-informed cut. After the call the compacted span leaves your context; recover it later only via expand_turn (or re-reading files) — keep in the checkpoint what a future step is likely to need. It runs exclusively, so other tool calls wait for it.',
    ].join(' '),
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'The checkpoint text replacing the completed part of the current turn: ONE flowing chronological timeline composed per the dsh-compact-turn skill. It must stand alone as the record of the span it replaces.',
      },
      turn: {
        type: 'integer',
        description: 'Optional target turn number: compact that COMPLETED turn whole — its span after the turn-starting user message (that message stays verbatim on the surface before the checkpoint). Use only for turns the runtime context lists as pending.',
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
      // Any agent may compact its own session — the current context composes
      // the checkpoint itself and the backend runs on this session's own
      // surface. Resumed forks run as top-level agents and are naturally
      // covered; live one-shot children compacting their own throwaway
      // context is harmless.
      const turnArg = typeof args.turn === 'number' && Number.isInteger(args.turn) ? args.turn : undefined;
      if (turnArg !== undefined) {
        // Whole-turn mode: the current context composed the checkpoint for a
        // COMPLETED previous turn; replace that turn's span AFTER its
        // starting user message (the start stays verbatim on the surface, so
        // the checkpoint's <user-steer> elements cover only mid-turn steering) with
        // the turn-memory summary checkpoint. This path reuses the same
        // replacement as the fork fallback (tryReplace) and does not run a
        // compaction transaction.
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
        if (summary === '') return 'compact_turn: summary is required — compose the checkpoint text following the dsh-compact-turn skill and pass it as the summary argument';
        const openTurn = findLastEvent(session, 'turn/start');
        if (openTurn !== undefined && openTurn.data?.turn === turnArg) return 'compact_turn: turn ' + turnArg + ' is the open turn — call compact_turn without the turn argument to compact the current turn';
        let item = states.get(session.id)?.items.get(turnArg);
        if (item === undefined) {
          const registered = registerPendingTurn(session);
          if (registered?.turn === turnArg) item = registered;
        }
        if (item === undefined) return 'compact_turn: turn ' + turnArg + ' has no pending turn record in this session';
        if (item.replaced) return 'compact_turn: turn ' + turnArg + ' is already replaced by its summary checkpoint';
        item.summary = summary;
        item.settled = true;
        const replaced = tryReplace(session, item, 'whole-turn (compact_turn, turn ' + turnArg + ')');
        if (!replaced) {
          item.summary = undefined;
          return 'compact_turn: turn ' + turnArg + ' could not be replaced right now (see the turn-memory debug log); the turn stays pending and can be retried';
        }
        return 'compact_turn: turn ' + turnArg + ' replaced by the provided summary (' + item.replacedNodes + ' surface nodes converged into one turn-summary checkpoint)';
      }
      const turnStart = findLastEvent(session, 'turn/start');
      if (turnStart === undefined) return 'compact_turn: no open turn';
      const turnEnd = findLastEvent(session, 'turn/end');
      if (turnEnd !== undefined && turnEnd.seq > turnStart.seq) return 'compact_turn: no open turn';
      const events = session.events;
      const nodes = session.surface.nodes;
      const boundary = computeSpanBoundaries(nodes, events, turnStart.seq);
      if (!boundary.ok) {
        if (boundary.error === 'no-assistant-content') return 'compact_turn: no assistant content to compact yet';
        return 'compact_turn: nothing to compact yet';
      }
      const { startSeq, endSeq, nodeCount } = boundary.bounds;
      const { walkStart, walkEnd } = computeWalkRange(nodes, boundary.bounds);
      const pairError = checkToolPairBalance(events, walkStart, walkEnd);
      if (pairError !== null) return pairError;
      // The checkpoint text is composed by the current context itself, per
      // the dsh-compact-turn skill, and arrives as the summary argument; no
      // subagent summarizes the span. The fold below is fully self-contained
      // — shrink check, checkpoint append, and the surface replacement all
      // run here, mirroring the whole-turn path (tryReplace), so no
      // compaction backend is involved.
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (summary === '') return 'compact_turn: summary is required — compose the checkpoint text following the dsh-compact-turn skill and pass it as the summary argument';
      const foldedSeqs: number[] = [];
      for (let index = boundary.bounds.spanStart + 1; index < boundary.bounds.assistantIdx; index += 1) foldedSeqs.push(nodes[index]);
      const shrinkError = shrinkCheckError(events, foldedSeqs, summary.length);
      if (shrinkError !== null) return shrinkError;
      try {
        // The same checkpoint shape tryReplace appends (any-typed here
        // because the tool executor types the append narrowly).
        const checkpointData: any = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: summary }],
          source: {
            kind: 'plugin',
            plugin: SUMMARY_MARKER_PLUGIN,
            turn: turnStart.data?.turn,
            turnSummaryId: randomUUID(),
            version: TURN_SUMMARY_VERSION,
            scope: 'in-turn',
          },
        };
        const checkpointOp: any = {
          surfaceOp: { op: 'replace', start: foldedSeqs[0], end: foldedSeqs[foldedSeqs.length - 1] },
          sourceEventSeqs: foldedSeqs,
        };
        session.append('user/message', checkpointData, checkpointOp);
      } catch (error) {
        return 'compact_turn: ' + errorText(error);
      }
      // Debug aid: the landed replacement boundary, for eyeballing. The
      // checkpoint sits where the first folded node was (position
      // spanStart + 1) and the kept current step follows it.
      const surfaceAfter = session.surface.nodes;
      const checkpointPos = boundary.bounds.spanStart + 1;
      const checkpointSeq = surfaceAfter[checkpointPos];
      const nextSeq = surfaceAfter[checkpointPos + 1] ?? null;
      dumpPrefixBoundary(
        session,
        'in-turn (current turn)',
        boundary.bounds.spanStartSeq,
        checkpointSeq,
        nextSeq,
        nodeCount,
        '[' + startSeq + ', ' + endSeq + ']',
        'turn-starting user message seq ' + boundary.bounds.spanStartSeq + ' stays verbatim BEFORE the checkpoint',
      );
      return 'compact_turn: compacted ' + nodeCount + ' surface nodes of the current turn into one checkpoint; the turn-starting message and the current step stay verbatim';
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Compact current turn',
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

  /** Run the turn-summary fork for one completed turn. */
  async function summarizeTurn(agent, item) {
    let run;
    try {
      run = await ctx.subagents.start('fork', {
        label: 'turn-summary ' + item.turn,
        prompt: [{ type: 'text', text: buildSummaryPrompt(item.turn) }],
        parent: agent,
        signal: item.controller.signal,
      });
    } catch (error) {
      item.settled = true;
      item.forkInFlight = false;
      dbg('summarizeTurn: start failed for turn ' + item.turn + ': ' + errorText(error));
      ctx.logger.warn('turn-memory: could not start summary fork for turn ' + item.turn + ': ' + errorText(error));
      return;
    }
    dbg('summarizeTurn: fork started for turn ' + item.turn);
    item.forkInFlight = true;
    try {
      const result = await run.result;
      item.settled = true;
      dbg('summarizeTurn: fork settled for turn ' + item.turn + ' stopReason=' + String(result.stopReason));
      if (result.stopReason !== 'completed') {
        item.forkInFlight = false;
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' ended with ' + JSON.stringify(result.stopReason) + '; the turn stays raw');
        return;
      }
      const text = extractText(result.output);
      if (text === '') {
        item.forkInFlight = false;
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' produced no text; the turn stays raw');
        return;
      }
      item.summary = text;
      dbg('summarizeTurn: summary captured for turn ' + item.turn + ' (' + item.summary.length + ' chars)');
      ctx.logger.info('turn-memory: turn ' + item.turn + ' summarized (' + item.summary.length + ' chars)');
    } catch (error) {
      item.settled = true;
      item.forkInFlight = false;
      dbg('summarizeTurn: result failed for turn ' + item.turn + ': ' + errorText(error));
      ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' failed: ' + errorText(error) + '; the turn stays raw');
    } finally {
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
      const startEvent = findLastEvent(session, 'turn/start', lastEnd.seq);
      dbg('idle: turn ' + turn + ' startSeq=' + (startEvent?.seq) + ' endSeq=' + lastEnd.seq + ' events.length=' + session.events.length);
      if (startEvent === undefined || startEvent.data?.turn !== turn) return;
      if (!hasEventBetween(session, 'assistant/message', startEvent.seq, lastEnd.seq)) {
        dbg('idle: turn ' + turn + ' has no assistant content; skipping');
        return;
      }
      // Fallback: an older turn the main agent left unsummarized during the
      // turn that just ended gets a fork summary now (lands one turn late).
      for (const item of state.items.values()) {
        if (item.turn < turn && !item.replaced && item.summary === undefined && item.forkInFlight !== true) {
          item.settled = false;
          dbg('idle: turn ' + item.turn + ' left unsummarized by the main agent; spawning fallback summary fork');
          void summarizeTurn(agent, item);
        }
      }
      // The turn that just completed waits for the MAIN agent: the next
      // turn's runtime context carries a pending notice, and the agent
      // composes the whole-turn checkpoint itself (dsh-compact-turn skill)
      // and compacts the turn with compact_turn(turn, summary). No fork here.
      const controller = new AbortController();
      const item = {
        turn,
        startSeq: startEvent.seq,
        endSeq: lastEnd.seq,
        controller,
        settled: true,
        summary: undefined,
        replaced: false,
        forkInFlight: false,
        turnSummaryId: randomUUID(),
      };
      state.items.set(turn, item);
      dbg('idle: turn ' + turn + ' marked pending for main-session summarization');
    } catch (error) {
      dbg('idle: handling failed: ' + errorText(error));
      ctx.logger.warn('turn-memory: idle handling failed: ' + errorText(error));
    }
  });

  /**
   * Resume recovery: a server restart aborts in-flight summary forks and
   * drops in-memory state, so the last completed turn of a resumed session
   * may have no summary at all. Mark it pending once when the root agent is
   * (re)created; the resumed main agent sees the pending notice in its next
   * runtime context and composes the whole-turn checkpoint itself. Recovery
   * items never block the next pre-step — the replacement lands whenever
   * the agent compacts the turn.
   */
  /**
   * Idempotent, log-driven pending registration: registers the last completed
   * turn as pending when it has no summary checkpoint yet. Shared by the
   * agent/created recovery and the lazy self-healing paths (the pending
   * notice and the compact_turn whole-turn mode) — registration can be lost
   * when a restart lands while a turn is open or an agent resumes through a
   * path that skips lifecycle events, and re-deriving it from the log keeps
   * the whole-turn flow independent of event delivery.
   */
  function registerPendingTurn(session) {
    const lastEnd = findLastEvent(session, 'turn/end');
    if (lastEnd === undefined) return undefined;
    const turn = lastEnd.data.turn;
    let state = states.get(session.id);
    if (state === undefined) {
      state = { items: new Map(), lastTurn: 0 };
      states.set(session.id, state);
    }
    if (state.lastTurn >= turn) return state.items.get(turn);
    if (replacedTurnNumbers(session).has(turn)) {
      dbg('recovery: turn ' + turn + ' already replaced; marking handled');
      state.lastTurn = turn;
      return undefined;
    }
    state.lastTurn = turn;
    const startEvent = findLastEvent(session, 'turn/start', lastEnd.seq);
    if (startEvent === undefined || startEvent.data?.turn !== turn) return undefined;
    if (!hasEventBetween(session, 'assistant/message', startEvent.seq, lastEnd.seq)) {
      dbg('recovery: turn ' + turn + ' has no assistant content; skipping');
      return undefined;
    }
    const controller = new AbortController();
    const item = {
      turn,
      startSeq: startEvent.seq,
      endSeq: lastEnd.seq,
      controller,
      settled: true,
      summary: undefined,
      replaced: false,
      forkInFlight: false,
      recovery: true,
      turnSummaryId: randomUUID(),
    };
    state.items.set(turn, item);
    dbg('recovery: turn ' + turn + ' marked pending after session resume');
    return item;
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!isTurnMemorySession(agent)) return;
      registerPendingTurn(agent.session);
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

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    try {
      const session = agent.session;
      const isRoot = isTurnMemorySession(agent);
      const state = isRoot ? states.get(session.id) : undefined;
      const messageKinds = Array.isArray(messages) ? messages.map((message) => message?.source?.kind).join(',') : 'not-array';
      dbg('pre-step: session=' + String(session.id) + ' isRoot=' + isRoot + ' state=' + (state === undefined ? 'MISSING' : 'present(' + state.items.size + ')') + ' messages=' + messageKinds);
      if (!isRoot) return next();
      if (state === undefined || state.items.size === 0) return next();
      const userInitiated = Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user');
      if (!userInitiated) {
        dbg('pre-step: not user-initiated; skipping');
        return next();
      }
      const pending = [...state.items.values()].filter((item) => !item.settled && item.recovery !== true);
      if (pending.length > 0) {
        await Promise.race([
          Promise.allSettled(pending.map((item) => new Promise<void>((resolve) => {
            const poll = () => {
              if (item.settled) resolve();
              else setTimeout(poll, 50);
            };
            poll();
          }))),
          new Promise((resolve) => setTimeout(resolve, settings.summaryTimeoutMs)),
          new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
        for (const item of pending) {
          if (!item.settled) {
            item.controller.abort();
            ctx.logger.warn('turn-memory: summary for turn ' + item.turn + ' timed out; the turn stays raw');
          }
        }
      }
      dbg('pre-step: pending=' + pending.length + ' signalAborted=' + String(signal.aborted));
      if (signal.aborted) return next();
      const replaced = replacedTurnNumbers(session);
      dbg('pre-step: already-replaced turns=' + [...replaced].join(','));
      const items = [...state.items.values()]
        .filter((item) => item.summary !== undefined && !item.replaced && !replaced.has(item.turn))
        .sort((a, b) => a.turn - b.turn);
      dbg('pre-step: replaceable items=' + items.map((item) => 'turn ' + item.turn).join(','));
      for (const item of items) tryReplace(session, item, 'whole-turn (fork fallback, turn ' + item.turn + ')');
    } catch (error) {
      dbg('pre-step: handling failed: ' + errorText(error, true));
      ctx.logger.warn('turn-memory: pre-step handling failed: ' + errorText(error));
    }
    return next();
  });

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
