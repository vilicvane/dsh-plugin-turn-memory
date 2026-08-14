/**
 * dsh-plugin-turn-memory — turn-granular context memory for DeepSeek Harness.
 *
 * Step 1 of a two-step context-compression plan:
 *
 *  - When a root agent's turn completes, a one-shot FORK (same model as the
 *    conversation, sharing the warm request prefix) writes an independent
 *    structured summary of that turn alone.
 *  - Replacement is deferred to the pre-step of the next user-initiated turn:
 *    each summarized turn is replaced on the model-visible surface by its
 *    summary checkpoint, so the newest user message always stays verbatim.
 *  - The replacement checkpoint is a user/message carrying the turn-memory
 *    source marker (turn number, summary id, format version). The raw events
 *    remain in the append-only log for replay and recall; the checkpoint is
 *    the durable summary record. No custom session event type is introduced,
 *    so logs stay loadable by unmodified harnesses.
 *  - The expand_turn tool recalls a turn's full transcript in three modes:
 *    fork (main-model continuation), subagent (cheap-model directed read),
 *    raw (transcript into context). The model picks the mode itself.
 *
 * Replacement of turns that experienced mid-turn compaction is skipped (the
 * surface already carries a checkpoint for part of the turn); the turn then
 * stays as-is and step 2 falls back to the raw transcript.
 *
 * Note on style: this file intentionally uses plain string concatenation and
 * String.fromCharCode(10) for newlines (no template literals, no backslash
 * escapes) so it can be embedded and generated without quoting hazards.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { defineTool } from '@deepseek-ai/dsh-tools';

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
const TURN_SUMMARY_VERSION = 3;

/** The plugin field of the checkpoint source marker. */
const SUMMARY_MARKER_PLUGIN = 'turn-memory';

/** Default settings; every key is overridable through the profile row config. */
const DEFAULT_SETTINGS = {
  /** How long the next turn's pre-step waits for an in-flight summary fork. */
  summaryTimeoutMs: 120000,
  /** How long one recall fork/subagent may run before it is aborted. */
  recallTimeoutMs: 180000,
  /** Cheap model used by the recall tool's subagent mode. */
  cheapProvider: 'deepseek-official',
  cheapModel: 'deepseek-chat',
  cheapMaxTokens: 4096,
  /** Recent window for auto mode: turns this close to the newest turn use fork. */
  recentTurnThreshold: 3,
  /** Cap on the raw transcript returned into context. */
  maxRawChars: 200000,
  /** Cap per tool result inside a transcript. */
  toolResultCapChars: 20000,
  /** Absolute delegation-depth cap for recall children. */
  maxRecallDepth: 4,
  /** Write pipeline traces to /home/vilicvane/.dsh/turn-memory-debug.log. */
  debug: false,
};

/** Summary instruction sent to the per-turn summary fork. */
function buildSummaryPrompt(turn) {
  return [
    'You are writing the running record for the turn that just completed in this coding-assistant session.',
    '',
    'Summarize ONLY turn ' + turn + ' — the most recent completed turn: its user request and the assistant work that followed. Earlier turns are already represented by their own summaries; reference them where this turn depends on or corrects them, but do not re-summarize them.',
    '',
    'Write a COMPACT flowing chronological record — a timeline, not a form. Keep only what a future turn needs; drop transient detail such as individual tool calls, intermediate output, and routine checks.',
    '',
    'Use EXACTLY this structure:',
    '',
    '## Timeline',
    '- [chronological entries: one per user request, decision, discovery, fix, or meaningful outcome, in the order they happened]',
    '',
    '## Current State',
    '- [what stands when the turn ends: artifacts, configurations, running processes, open threads]',
    '',
    '## Open Questions and Pending Input',
    '- [questions awaiting the user; reproduce the question and its options VERBATIM — the next answer will likely refer to these options by their wording]',
    '',
    '## Next Step',
    '- [the single next action, or (none)]',
    '',
    'Marking:',
    '- Mark superseded or disproven ideas, methods, and conclusions with a leading [outdated]: entry. When this turn invalidates something from an earlier summary, name that turn ("[outdated] turn 3 assumed X — this turn showed Y").',
    '- Mark untested assumptions and tentative conclusions with a leading [assumption]: entry, so later turns treat them as unverified.',
    '- Quote user wording, commands, paths, identifiers, and error strings VERBATIM wherever wording matters.',
    '- Preserve read-in material (code, docs, config, output) that this turn relied on or that future turns will likely need, verbatim enough to avoid re-reading — judge relevance broadly: include what you expect to help later, not only what was used right now. For each kept passage, add ONE short line saying why it matters and what it is for. Do not duplicate what an earlier checkpoint, a loaded skill, or another entry of this summary already covers.',
    '- Large verbatim passages: do not reproduce a passage longer than roughly 800 characters into the summary. Emit one placeholder tag instead — <verbatim kind="turn-prompt"/> for the message that started this turn, <verbatim kind="tool-result" callId="CALL_ID"/> for a tool result (the call id is visible on the tool-result block) — with ONE short line beside it saying what the passage is and why it matters. The harness replaces every tag with the original text when the checkpoint lands; tags exist only to save output tokens, never to omit content.',
    '- Name skills and procedures instead of restating their steps ("restarted dsh web per the dsh-web-restart skill"); when unsure of the name, check the skill catalog with the skill tool.',
    '- Output only the summary text. Do not call any tool unless you must verify details of the turn you are summarizing; when detail is uncertain, verify it with the expand_turn tool (mode raw) rather than guessing.',
  ].join(NL);
}

/** Memory guidance section added to every agent's system prompt. */
const MEMORY_SECTION = [
  '## Conversation Memory',
  '',
  'Each completed turn is stored as a flowing summary that marks the turn it replaces. Summaries fold turn-level detail; when one may not contain what you need, or when you must verify what happened in earlier turns — including when the user challenges a claim about them — recall the full information with the expand_turn tool BEFORE answering. Only the original transcripts settle the facts; summaries of neighboring turns can read as contradictory.',
  '',
  'Summaries mark superseded ideas, methods, and conclusions with [outdated] and unverified assumptions with [assumption]; treat marked items accordingly.',
  '',
  'The recall modes, in order of fidelity:',
  '',
  '1. fork — the main model continues from the conversation state at that turn, with the warm request prefix. Best for deep questions about a recent turn. Use only for recent turns; for older ones it may be slow.',
  '2. subagent — a cheaper model reads the full text of the turn and answers a targeted question or produces a directed summary. Best for specific lookups.',
  '3. raw — the full text of the turn is returned into the conversation. Most direct, most context consumed; very large turns are truncated. Last resort.',
  '',
  'Choose the mode yourself: prefer fork for recent turns, subagent for targeted detail, raw only when you need to work with the full text directly. Routine continuation must not require recall — summaries are written to support it. Recall exists for deep verification and rarely needed detail.',
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
  const parts = [];
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
function findLastEvent(session, type, beforeSeq) {
  const events = session.events;
  const limit = beforeSeq === undefined ? events.length : Math.min(beforeSeq, events.length);
  for (let index = limit - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return events[index];
  }
  return undefined;
}

const VERBATIM_KIND_PATTERN = /kind="([^"]*)"/;
const VERBATIM_CALL_ID_PATTERN = /callId="([^"]*)"/;

/** Resolve one verbatim tag against the turn's log events; undefined when unresolvable. */
function resolveVerbatim(session, item, kind, callId) {
  const events = session.events;
  if (kind === 'turn-prompt') {
    for (let seq = item.startSeq + 1; seq <= item.endSeq; seq += 1) {
      const event = events[seq];
      if (event === undefined) break;
      if (event.type === 'user/message' && event.surfaceOp === 'append') {
        return extractText(event.data?.content ?? []);
      }
    }
    return undefined;
  }
  if (kind === 'tool-result' && typeof callId === 'string') {
    for (let seq = item.startSeq + 1; seq <= item.endSeq; seq += 1) {
      const event = events[seq];
      if (event === undefined) break;
      if (event.type === 'tool/result' && event.data?.message?.content?.[0]?.toolCallId === callId) {
        return extractText(event.data.message.content[0].content ?? []);
      }
    }
    return undefined;
  }
  return undefined;
}

/** Replace every verbatim tag in a summary with the turn's original text. */
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
    const callId = VERBATIM_CALL_ID_PATTERN.exec(tag)?.[1];
    const resolved = resolveVerbatim(session, item, kind, callId);
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

/** Locate one turn's event span: (turn/start seq, turn/end seq]; open turns extend to the log tail. */
function findTurnSpan(session, turn) {
  let startSeq;
  let endSeq;
  for (const event of session.events) {
    if (event.type === 'turn/start' && event.data?.turn === turn) startSeq = event.seq;
    if (event.type === 'turn/end' && event.data?.turn === turn) endSeq = event.seq;
  }
  if (startSeq === undefined) return undefined;
  return { startSeq, endSeq: endSeq ?? session.events.length - 1 };
}

/** Whether any event of the given type sits inside (startSeq, endSeq]. */
function hasEventBetween(session, type, startSeq, endSeq) {
  for (let seq = startSeq + 1; seq <= endSeq; seq += 1) {
    if (session.events[seq]?.type === type) return true;
  }
  return false;
}

/** Turns whose spans already carry a turn-memory summary checkpoint. */
function replacedTurnNumbers(session) {
  const out = new Set();
  for (const seq of session.surface.nodes) {
    const event = session.events[seq];
    if (event === undefined || event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source?.plugin === SUMMARY_MARKER_PLUGIN && typeof source.turn === 'number') out.add(source.turn);
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
  const lines = [];
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
      '- 其余键与默认：summaryTimeoutMs 120000、recallTimeoutMs 180000、cheapProvider deepseek-official、cheapModel deepseek-chat、cheapMaxTokens 4096、recentTurnThreshold 3、maxRawChars 200000、toolResultCapChars 20000、maxRecallDepth 4。',
      '',
      '## 行为约定',
      '',
      '- turn 结束 → 主模型 fork 生成流水摘要（Timeline/Current State/Open Questions and Pending Input/Next Step）；下一条用户消息的 pre-step → 上一 turn 被 <turn-summary turn=N version=N> checkpoint 替换；最新用户消息永远逐字保留。',
      '- 某 turn 没有替换节点的三种可能：(1) 该 turn 内发生过中途压缩（有意跳过）；(2) 摘要 fork 失败/超时；(3) 服务器重启（内存态丢失、fork 被中止）。重启恢复：根 agent 重建时，最后一个无 checkpoint 的已完成 turn 会被补摘要一次；更早的空缺保持原文。',
      '- 替换节点 source = {kind: plugin, plugin: turn-memory, turn, turnSummaryId, version}。',
      '- expand_turn 三档：fork（主模型延续、吃暖前缀、适合近期）、subagent（便宜模型定向总结）、raw（原文直读、最后手段）；auto 按 recentTurnThreshold 路由，模型自选。',
      '- 摘要与操作说明的分工：摘要只记发生了什么/决定了什么；可复用操作步骤放技能，摘要里只留名字引用。',
      '',
      '## 修改插件后',
      '',
      '改 index.js → node --check 语法校验 → 走 dsh-web-restart 技能重启生效。',
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
      '- fork: the main model continues from the conversation state at that turn, with the warm request prefix. Best for deep questions about a recent turn.',
      '- subagent: a cheaper model reads the full text of the turn and answers a targeted question or produces a directed summary.',
      '- raw: the full text of the turn is returned directly into the conversation (very large turns are truncated); the most context-consuming, use as a last resort.',
      'Default mode auto picks fork for recent turns and subagent otherwise. question is required for fork and subagent modes and ignored for raw.',
    ].join(' '),
    parameters: {
      turn: {
        type: 'integer',
        required: true,
        description: 'The turn number to recall (1-based, numbered by this session turns).',
      },
      question: {
        type: 'string',
        description: 'What to ask or look up about that turn. Required for fork and subagent modes; ignored for raw.',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'fork', 'subagent', 'raw'],
        description: 'Recall mode; defaults to auto.',
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
      const mode = (args.mode ?? 'auto') === 'auto' ? resolveAutoMode(session, args.turn) : args.mode;
      if (mode === 'raw') return buildTurnTranscript(session, span, settings);
      const question = (args.question ?? '').trim();
      if (question === '') return 'expand_turn: a question is required for ' + mode + ' mode';
      if (mode === 'fork') return recallViaFork(agent, exec.signal, args.turn, question);
      if (mode === 'subagent') return recallViaSubagent(agent, exec.signal, session, span, args.turn, question);
      return 'expand_turn: unknown mode ' + String(mode);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall turn ' + args.turn,
      kind: 'other',
      rawInput: { turn: args.turn, mode: args.mode ?? 'auto' },
    }),
  }));

  /** Route auto mode: recent turns fork, older turns use the cheap subagent. */
  function resolveAutoMode(session, turn) {
    const lastEnd = findLastEvent(session, 'turn/end');
    const newest = lastEnd?.data?.turn ?? 0;
    return turn >= newest - settings.recentTurnThreshold + 1 ? 'fork' : 'subagent';
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
      'The question concerns turn ' + turn + '. Earlier turns are stored as summaries; the full raw transcript of every completed turn is available in this session log. If the summaries do not contain the detail you need, use the expand_turn tool with mode raw to read the full text of turn ' + turn + ' before answering. Answer the question directly and concisely; quote exact paths, commands, error strings, and values where relevant.',
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
      return 'expand_turn (fork): could not start the recall fork: ' + (error?.message ?? error);
    }
    try {
      const result = await run.result;
      if (result.stopReason !== 'completed') return 'expand_turn (fork): recall ended with ' + JSON.stringify(result.stopReason);
      const text = extractText(result.output);
      return text === '' ? 'expand_turn (fork): the recall fork produced no answer' : text;
    } catch (error) {
      return 'expand_turn (fork): recall failed: ' + (error?.message ?? error);
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
      return 'expand_turn (subagent): could not start the recall subagent: ' + (error?.message ?? error);
    }
    try {
      const result = await run.result;
      if (result.stopReason !== 'completed') return 'expand_turn (subagent): recall ended with ' + JSON.stringify(result.stopReason);
      const text = extractText(result.output);
      return text === '' ? 'expand_turn (subagent): the recall subagent produced no answer' : text;
    } catch (error) {
      return 'expand_turn (subagent): recall failed: ' + (error?.message ?? error);
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
      dbg('summarizeTurn: start failed for turn ' + item.turn + ': ' + (error?.message ?? error));
      ctx.logger.warn('turn-memory: could not start summary fork for turn ' + item.turn + ': ' + (error?.message ?? error));
      return;
    }
    dbg('summarizeTurn: fork started for turn ' + item.turn);
    try {
      const result = await run.result;
      item.settled = true;
      dbg('summarizeTurn: fork settled for turn ' + item.turn + ' stopReason=' + String(result.stopReason));
      if (result.stopReason !== 'completed') {
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' ended with ' + JSON.stringify(result.stopReason) + '; the turn stays raw');
        return;
      }
      const text = extractText(result.output);
      if (text === '') {
        ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' produced no text; the turn stays raw');
        return;
      }
      item.summary = text;
      dbg('summarizeTurn: summary captured for turn ' + item.turn + ' (' + item.summary.length + ' chars)');
      ctx.logger.info('turn-memory: turn ' + item.turn + ' summarized (' + item.summary.length + ' chars)');
    } catch (error) {
      item.settled = true;
      dbg('summarizeTurn: result failed for turn ' + item.turn + ': ' + (error?.message ?? error));
      ctx.logger.warn('turn-memory: summary fork for turn ' + item.turn + ' failed: ' + (error?.message ?? error) + '; the turn stays raw');
    } finally {
      try { await run.dispose(); } catch { /* resource release is best-effort */ }
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    try {
      const session = agent.session;
      dbg('idle: agent status idle, session=' + String(session.id) + ' parentSession=' + String(session.header.parentSession));
      if (session.header.parentSession !== undefined) return;
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
      const controller = new AbortController();
      const item = {
        turn,
        startSeq: startEvent.seq,
        endSeq: lastEnd.seq,
        controller,
        settled: false,
        summary: undefined,
        replaced: false,
        turnSummaryId: randomUUID(),
      };
      state.items.set(turn, item);
      dbg('idle: spawning summary fork for turn ' + turn);
      void summarizeTurn(agent, item);
    } catch (error) {
      dbg('idle: handling failed: ' + (error?.message ?? error));
      ctx.logger.warn('turn-memory: idle handling failed: ' + (error?.message ?? error));
    }
  });

  /**
   * Resume recovery: a server restart aborts in-flight summary forks and
   * drops in-memory state, so the last completed turn of a resumed session
   * may have no summary at all. Re-summarize it once when the root agent is
   * (re)created. Recovery items never block the next pre-step — the
   * replacement lands at the first user pre-step where the summary is ready.
   */
  ctx.on('agent/created', ({ agent }) => {
    try {
      const session = agent.session;
      if (session.header.parentSession !== undefined) return;
      const lastEnd = findLastEvent(session, 'turn/end');
      if (lastEnd === undefined) return;
      const turn = lastEnd.data.turn;
      let state = states.get(session.id);
      if (state === undefined) {
        state = { items: new Map(), lastTurn: 0 };
        states.set(session.id, state);
      }
      if (state.lastTurn >= turn) return;
      if (replacedTurnNumbers(session).has(turn)) {
        dbg('recovery: turn ' + turn + ' already replaced; marking handled');
        state.lastTurn = turn;
        return;
      }
      state.lastTurn = turn;
      const startEvent = findLastEvent(session, 'turn/start', lastEnd.seq);
      if (startEvent === undefined || startEvent.data?.turn !== turn) return;
      if (!hasEventBetween(session, 'assistant/message', startEvent.seq, lastEnd.seq)) {
        dbg('recovery: turn ' + turn + ' has no assistant content; skipping');
        return;
      }
      if (hasEventBetween(session, 'compaction/start', startEvent.seq, lastEnd.seq) || hasEventBetween(session, 'compaction/summary', startEvent.seq, lastEnd.seq)) {
        dbg('recovery: turn ' + turn + ' experienced mid-turn compaction; skipping');
        return;
      }
      const controller = new AbortController();
      const item = {
        turn,
        startSeq: startEvent.seq,
        endSeq: lastEnd.seq,
        controller,
        settled: false,
        summary: undefined,
        replaced: false,
        recovery: true,
        turnSummaryId: randomUUID(),
      };
      state.items.set(turn, item);
      dbg('recovery: respawning summary fork for turn ' + turn + ' after session resume');
      void summarizeTurn(agent, item);
    } catch (error) {
      dbg('recovery: handling failed: ' + (error?.message ?? error));
      ctx.logger.warn('turn-memory: resume recovery failed: ' + (error?.message ?? error));
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

  /** Replace one completed turn with its summary checkpoint; returns false when skipped. */
  function tryReplace(session, item) {
    const events = session.events;
    const spanSeqs = [];
    const skippedForeign = [];
    let firstIdx = -1;
    let lastIdx = -1;
    session.surface.nodes.forEach((seq, index) => {
      if (seq > item.startSeq && seq <= item.endSeq) {
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
    if (hasEventBetween(session, 'compaction/start', item.startSeq, item.endSeq) || hasEventBetween(session, 'compaction/summary', item.startSeq, item.endSeq)) {
      dbg('tryReplace: turn ' + item.turn + ' SKIP compaction events in span');
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
      },
    }, {
      surfaceOp: { op: 'replace', start: spanSeqs[0], end: spanSeqs[spanSeqs.length - 1] },
      sourceEventSeqs: spanSeqs,
    });
    item.replaced = true;
    dbg('tryReplace: turn ' + item.turn + ' REPLACED span [' + spanSeqs[0] + ', ' + spanSeqs[spanSeqs.length - 1] + '] (' + spanSeqs.length + ' nodes)');
    ctx.logger.info('turn-memory: replaced turn ' + item.turn + ' (shadowed ' + spanSeqs.length + ' surface nodes)');
    return true;
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    try {
      const session = agent.session;
      const isRoot = session.header.parentSession === undefined;
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
          Promise.allSettled(pending.map((item) => new Promise((resolve) => {
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
      for (const item of items) tryReplace(session, item);
    } catch (error) {
      dbg('pre-step: handling failed: ' + (error?.message ?? error) + ' STACK ' + String(error?.stack).slice(0, 300));
      ctx.logger.warn('turn-memory: pre-step handling failed: ' + (error?.message ?? error));
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
