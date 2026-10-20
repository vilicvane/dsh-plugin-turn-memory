import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

import { MemoryCoordinator } from './lib/coordinator.ts';
import { assistantCompressionSeed, contentText } from './lib/content.ts';
import { TurnNodeEditor } from './lib/editor.ts';
import { buildCompressionPrompt } from './lib/prompt.ts';
import {
  eventToolCallIds,
  eventToolResultCallId,
  withProjectedToolProtocolWarning,
} from './lib/tool-protocol.ts';
import { SessionMemoryCompactionEngine } from './lib/session-compaction.ts';
import { startWorker } from './lib/subagent-activation.ts';
import { land, validateLanding } from './lib/landing.ts';
import {
  failedTurnSource,
  isTurnMemorySource,
  pendingTurnSource,
} from './lib/message-source.ts';
import {
  appendTurnMarkerCopy,
  completedTurnEnds,
  compressedTurnNumbers,
  findCompletedTurnEnd,
  pendingTurnNumbers,
  turnHasUnrewrittenReasoning,
  turnCompressionBypassReason,
  turnMarkerOriginal,
  turnSurfaceSeqs,
} from './lib/turn-recovery.ts';
import { WorkerToolScope } from './lib/worker-tools.ts';
import { createReadMemoryImageTool } from './lib/memory-images.ts';
import { DEFAULT_REMINDER_INTERVAL_NODES, TurnContinuationController } from './lib/turn-continuation.ts';
import { ThoughtHintsController } from './lib/thought-hints.ts';
import { isUserConversationSession } from './lib/session-kind.ts';
import { createReadSessionHistoryTool, renderRawSessionContent } from './lib/session-history.ts';
import type { SessionCompactionConfig } from './lib/session-compaction.ts';
import type { SessionHistoryConfig } from './lib/session-history.ts';
import type { TurnContinuationConfig } from './lib/turn-continuation.ts';
import type { ThoughtHint, ThoughtHintsConfig } from './lib/thought-hints.ts';
import type { NodeRange, TurnNodeOutput, TurnNodeSeed } from './lib/editor.ts';

const name = 'turn-memory';
const inject = ['agents', 'llm', 'sessionQuery', 'sessions', 'subagents', 'systemPrompt', 'tokenMeter', 'tools'];

export const TURN_TOOL_NAMES = [
  'list_turn_nodes',
  'read_turn_nodes',
  'replace_turn_nodes',
  'finish_turn_compression',
];

const DEFAULT_SURFACE_DUMP_DIR = fileURLToPath(new URL('.tmp/', import.meta.url));

/**
 * In-process retry budget for a queued turn whose compression attempt failed.
 * A durable pending marker only brings such a turn back when the agent is
 * recreated, so a transient failure (a concurrent session-compaction rewrite,
 * a lost flush) would otherwise idle the session until a restart. Retries are
 * bounded because worker failures already consumed `turnWorkerAttempts`.
 */
const TURN_FAILURE_RETRIES = 2;
const TURN_FAILURE_RETRY_DELAY_MS = 10_000;

interface PluginConfig {
  enabled?: boolean;
  turnCompression?: boolean;
  turnWorkerAttempts?: number;
  e2eSmoke?: boolean;
  e2eInterruptAfterFirstMutation?: boolean;
  e2eDeferTurnCompressionUntilResume?: boolean;
  previewChars?: number;
  maxReadChars?: number;
  surfaceDumpDir?: string;
  turnContinuation?: TurnContinuationConfig;
  thoughtHints?: ThoughtHintsConfig;
  sessionHistory?: SessionHistoryConfig;
  sessionCompaction?: SessionCompactionConfig;
}

// Cordis reads this schema for profile validation and for the settings form that
// writes the current profile patch. Only `turnContinuation.reminderIntervalNodes`
// is volatile, so it is the only field the form exposes; everything else stays
// editable through the Cordis configuration files.
export const Config = z.object({
  enabled: z.boolean(),
  turnCompression: z.boolean(),
  turnWorkerAttempts: z.number(),
  e2eSmoke: z.boolean(),
  e2eInterruptAfterFirstMutation: z.boolean(),
  e2eDeferTurnCompressionUntilResume: z.boolean(),
  previewChars: z.number(),
  maxReadChars: z.number(),
  surfaceDumpDir: z.string(),
  turnContinuation: z.object({
    enabled: z.boolean(),
    reminderIntervalNodes: z.number().step(1).min(1).default(DEFAULT_REMINDER_INTERVAL_NODES).volatile(),
  }),
  thoughtHints: z.object({
    enabled: z.boolean(),
    provider: z.string(),
    model: z.string(),
    minimumChars: z.number(),
    maxTokens: z.number(),
    timeoutMs: z.number(),
  }),
  sessionHistory: z.object({
    enabled: z.boolean(),
    maxReadChars: z.number(),
    catalogTurns: z.number(),
  }),
  sessionCompaction: z.object({
    enabled: z.boolean(),
    auto: z.boolean(),
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number(),
    segmentTokens: z.number(),
    previewChars: z.number(),
    maxReadChars: z.number(),
    warmupChars: z.number(),
    workerMaxTokens: z.number(),
    workerAttempts: z.number(),
    workerTimeoutMs: z.number(),
    compactionRetries: z.number(),
    e2eInterruptSessionAfterFirstMutation: z.boolean(),
  }),
});

interface CompressionJob {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  agent: any;
  session: any;
  turn: number;
  targetSeqs: number[];
  editor: TurnNodeEditor;
  controller: AbortController;
  mutationCount: number;
  finishConfirmed: boolean;
  workerNumber: number;
  thoughtHints: ThoughtHint[];
}

function seedOf(event: any): TurnNodeSeed | undefined {
  const markerSources = isTurnMemorySource(event?.data?.source)
    && event?.surfaceOp?.op === 'replace'
    && Array.isArray(event.sourceEventSeqs)
    && event.sourceEventSeqs.length > 0
    ? [...event.sourceEventSeqs]
    : undefined;
  if (event?.type === 'user/message') {
    return {
      kind: 'user',
      content: contentText(event.data?.content),
      sourceSeq: event.seq,
      ...(markerSources === undefined ? {} : { sourceSeqs: markerSources }),
    };
  }
  if (event?.type === 'assistant/message') {
    const seed = assistantCompressionSeed(event.data?.message?.content);
    const toolCallIds = eventToolCallIds(event);
    return {
      kind: 'assistant',
      content: seed.content,
      ...(seed.rewriteRequired === undefined
        ? {}
        : { exactContent: renderRawSessionContent(event.data?.message?.content) }),
      sourceSeq: event.seq,
      ...(markerSources === undefined ? {} : { sourceSeqs: markerSources }),
      ...(seed.rewriteRequired === undefined ? {} : { rewriteRequired: seed.rewriteRequired }),
      ...(toolCallIds.length === 0 ? {} : { toolCallIds }),
    };
  }
  if (event?.type === 'tool/result') {
    const toolResultCallId = eventToolResultCallId(event);
    return {
      kind: 'tool',
      content: contentText(event.data?.message?.content),
      sourceSeq: event.seq,
      ...(markerSources === undefined ? {} : { sourceSeqs: markerSources }),
      ...(toolResultCallId === undefined ? {} : { toolResultCallId }),
    };
  }
  return undefined;
}

function prepareJob(agent: any, event: any): CompressionJob | undefined {
  const session = agent.session;
  const turn = event.data?.turn;
  if (!Number.isSafeInteger(turn)) return undefined;
  const start = session.snapshotEvents().findLast((candidate: any) => candidate.type === 'turn/start' && candidate.data?.turn === turn);
  if (start === undefined) throw new Error('turn ' + turn + ' has a durable turn/end but no matching turn/start');
  const targetSeqs = turnSurfaceSeqs(session, turn, start.seq, event.seq);
  if (targetSeqs.length === 0) return undefined;
  const firstIndex = session.surface.nodes.indexOf(targetSeqs[0]);
  if (firstIndex < 0 || targetSeqs.some((seq: number, index: number) => session.surface.nodes[firstIndex + index] !== seq)) {
    throw new Error('turn ' + turn + ' target is not a contiguous current surface range');
  }
  const seeds = targetSeqs.map((seq: number) => seedOf(session.snapshotEvents()[seq]));
  if (seeds.some((seed: TurnNodeSeed | undefined) => seed === undefined)) {
    throw new Error('turn ' + turn + ' target contains a non-message surface node');
  }
  return {
    id: randomUUID(),
    parentSessionId: String(session.id),
    agent,
    session,
    turn,
    targetSeqs: [...targetSeqs],
    editor: new TurnNodeEditor(seeds as TurnNodeSeed[]),
    controller: new AbortController(),
    mutationCount: 0,
    finishConfirmed: false,
    workerNumber: 0,
    thoughtHints: [],
  };
}

function apply(ctx: any, config: PluginConfig = {}): void {
  if (config.enabled !== true) {
    ctx.logger.info('turn-memory: new implementation is disabled; enable explicitly for smoke testing');
    return;
  }
  const coordinator = new MemoryCoordinator();
  if (config.sessionHistory?.enabled !== false) {
    ctx.tools.register(createReadSessionHistoryTool(config.sessionHistory));
  }
  const thoughtHints = config.turnCompression !== false && config.thoughtHints?.enabled === true
    ? new ThoughtHintsController(ctx, config.thoughtHints)
    : undefined;
  const readMemoryImageTool = createReadMemoryImageTool(ctx);
  ctx.inject(['attachments'], (imageCtx: any) => {
    imageCtx.tools.register(readMemoryImageTool);
  });
  if (config.sessionCompaction?.enabled === true) {
    new SessionMemoryCompactionEngine(ctx, config.sessionCompaction, coordinator, [readMemoryImageTool]);
  }
  if (config.turnCompression === false) {
    ctx.logger.info('turn-memory: completed-turn compression is disabled; session compaction remains independently configured');
    return;
  }
  const previewChars = Number.isSafeInteger(config.previewChars) && (config.previewChars ?? 0) > 0 ? config.previewChars! : 120;
  const maxReadChars = Number.isSafeInteger(config.maxReadChars) && (config.maxReadChars ?? 0) > 0 ? config.maxReadChars! : 30000;
  const turnNoProgressAttempts = Number.isSafeInteger(config.turnWorkerAttempts) && (config.turnWorkerAttempts ?? 0) > 0
    ? config.turnWorkerAttempts!
    : 3;
  const e2eSmoke = config.e2eSmoke === true;
  const e2eInterruptAfterFirstMutation = config.e2eInterruptAfterFirstMutation === true;
  const e2eDeferTurnCompressionUntilResume = config.e2eDeferTurnCompressionUntilResume === true;
  const surfaceDumpDir = typeof config.surfaceDumpDir === 'string' && config.surfaceDumpDir.trim() !== ''
    ? resolve(config.surfaceDumpDir)
    : DEFAULT_SURFACE_DUMP_DIR;
  const turnContinuation = config.turnContinuation?.enabled === false
    ? undefined
    : new TurnContinuationController(ctx, config.turnContinuation);
  const jobs = new Map<string, CompressionJob>();
  const pendingTurns = new Map<string, Map<number, Set<string>>>();
  const pumps = new Map<string, Promise<void>>();
  const turnFailures = new Map<string, Map<number, number>>();
  const stagedFinishes = new WeakMap<object, CompressionJob>();
  let disposed = false;

  const jobFor = (exec: any): CompressionJob => {
    const child = exec.agent;
    const parentSessionId = child?.session?.header?.parentSession;
    if (parentSessionId === undefined) throw new Error('turn-memory editor tools are available only inside the active compression fork');
    const job = jobs.get(String(parentSessionId));
    if (job === undefined) throw new Error('no active turn-memory job for this fork parent');
    const childSessionId = String(child.session.id);
    if (job.childSessionId !== undefined && job.childSessionId !== childSessionId) {
      throw new Error('this compression job is bound to a different fork child');
    }
    job.childSessionId = childSessionId;
    return job;
  };

  const turnToolDefinitions: any[] = [readMemoryImageTool];
  const addTurnTool = (definition: any): void => { turnToolDefinitions.push(definition); };

  addTurnTool(defineTool({
    name: 'list_turn_nodes',
    description: 'Return the complete rich catalog of the authoritative host-owned turn working surface. Current n* ids are unchanged original nodes; current r* ids are accepted rewrites. tool-results= and tool-call= identify current structured protocol peers; missing means the draft must be repaired before finish.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return jobFor(exec).editor.richCatalog(previewChars);
    },
  }));

  addTurnTool(defineTool({
    name: 'read_turn_nodes',
    description: 'Read exact content from the current host-owned working surface, including actionable tool-call/result peer node ids. Unchanged reasoning-bearing n* nodes include their original reasoning blocks; r* nodes contain accepted compressed work. Several ids or continuous ranges may be read together and long selections can be paged with offset; shadowed ids are stale.',
    parameters: {
      ranges: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: { type: 'string', required: true, description: 'First current node id.' },
            end: { type: 'string', description: 'Last current node id, inclusive; omit for one node.' },
          },
        },
      },
      offset: { type: 'number', description: 'Zero-based character offset into the same rendered selection; defaults to 0.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return jobFor(exec).editor.read(args.ranges as NodeRange[], maxReadChars, args.offset ?? 0);
    },
  }));

  addTurnTool(defineTool({
    name: 'replace_turn_nodes',
    description: 'Jointly replace one current node or continuous current range with one or more ordered nodes. Select every current node whose information the outputs use; output count cannot exceed the range\'s summed capacity. kind="tool" preserves one structured tool result and is allowed only as the sole output replacing exactly one current tool node; it remains valid only while the catalog names a retained tool-call peer. To compress tool work as prose, replace the continuous call/result interaction together with ordinary user/assistant nodes. The host accepts the draft and immediately reports any protocol mismatch with its repair range.',
    parameters: {
      start: { type: 'string', required: true, description: 'First current node id.' },
      end: { type: 'string', description: 'Last current node id, inclusive; omit for one node.' },
      nodes: {
        type: 'array',
        required: true,
        description: 'Non-empty ordered replacement nodes jointly derived from the selected range.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['user', 'assistant', 'tool'], description: 'Semantic role. "tool" means a retained structured result, not prose about tool work; it cannot create a structured call.' },
            content: { type: 'string', required: true, description: 'Complete content of this output node.' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const job = jobFor(exec);
      const result = job.editor.replace(args.start, args.end, args.nodes as TurnNodeOutput[]);
      job.mutationCount += 1;
      const output = 'created=' + result.created.map((node) => node.id).join(',')
        + ' jointly-derived-from=' + result.sourceRanges
        + '\ncurrent:\n' + result.catalog;
      if (e2eInterruptAfterFirstMutation && job.workerNumber === 1 && job.mutationCount === 1) {
        exec.concludeTurn();
      }
      return withProjectedToolProtocolWarning(output, job.editor.snapshot(), job.session.snapshotEvents());
    },
  }));

  addTurnTool(defineTool({
    name: 'finish_turn_compression',
    description: 'Validate and submit the complete current host-owned working surface as the authoritative compressed turn transcript. This is the only accepted completion path and concludes the active worker on success.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const job = jobFor(exec);
      validateLanding(job, e2eSmoke);
      stagedFinishes.set(exec as object, job);
      exec.concludeTurn();
      return 'turn compression accepted for commit\n' + job.editor.structuralCatalog();
    },
  }));

  const turnWorkerTools = new WorkerToolScope(ctx, turnToolDefinitions);

  ctx.on('tools/result', (exec: any, result: any) => {
    const job = stagedFinishes.get(exec as object);
    if (job === undefined) return;
    stagedFinishes.delete(exec as object);
    if (!result.isError) job.finishConfirmed = true;
  });

  const persistLanding = async (job: CompressionJob): Promise<boolean> => {
    try {
      await ctx.sessions.flush(job.session);
    } catch (error) {
      ctx.logger.warn('turn-memory: compression landing flush failed: '
        + (error instanceof Error ? error.message : String(error)));
      return false;
    }
    try {
      const snapshot = await ctx.sessionQuery.readSurface(job.parentSessionId);
      const surfacePath = resolve(surfaceDumpDir, 'e2e-surface-' + encodeURIComponent(job.parentSessionId) + '.json');
      await mkdir(surfaceDumpDir, { recursive: true });
      await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      ctx.logger.info('turn-memory: surface snapshot written to ' + surfacePath);
    } catch (error) {
      ctx.logger.warn('turn-memory: surface snapshot failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    return true;
  };

  const runCompression = async (job: CompressionJob): Promise<boolean> => {
    try {
      let completed = false;
      let lastError: unknown;
      let noProgressAttempts = 0;
      while (noProgressAttempts < turnNoProgressAttempts) {
        job.controller.signal.throwIfAborted();
        job.workerNumber += 1;
        job.childSessionId = undefined;
        job.finishConfirmed = false;
        const mutationsBefore = job.mutationCount;
        const provider = job.workerNumber === 1 ? 'fork' : 'spawn';
        const workerMode = provider === 'fork' ? 'fork' : 'fresh-spawn';
        let run: any;
        try {
          run = await startWorker(ctx.subagents, {
            provider,
            label: 'turn-memory compression ' + job.turn + ' (' + workerMode + ' worker ' + job.workerNumber + ')',
            prompt: [{
              type: 'text',
              text: buildCompressionPrompt(job.editor, {
                previewChars,
                e2eSmoke,
                workerNumber: job.workerNumber,
                acceptedMutations: job.mutationCount,
                workerMode,
                thoughtHints: job.thoughtHints,
              }),
            }],
            parent: job.agent,
            signal: job.controller.signal,
            ...turnWorkerTools.startOptions(),
          });
          const result = await run.result;
          if (result.stopReason !== 'completed') {
            throw new Error(provider + ' worker ended with ' + JSON.stringify(result.stopReason));
          }
          if (!job.finishConfirmed) {
            throw new Error(provider + ' worker completed without an authoritative finish_turn_compression result');
          }
          completed = true;
          break;
        } catch (error) {
          lastError = error;
          if (job.controller.signal.aborted) job.controller.signal.throwIfAborted();
          const accepted = job.mutationCount - mutationsBefore;
          if (accepted > 0) {
            noProgressAttempts = 0;
          } else {
            noProgressAttempts += 1;
          }
          const continuation = noProgressAttempts < turnNoProgressAttempts
            ? '; starting a fresh same-model worker from ' + job.mutationCount + ' accepted mutation(s)'
            : '';
          const progress = accepted > 0
            ? '; accepted progress reset consecutive no-progress attempts to 0/' + turnNoProgressAttempts
            : '; consecutive no-progress attempts=' + noProgressAttempts + '/' + turnNoProgressAttempts;
          ctx.logger.warn('turn-memory: turn ' + job.turn + ' worker ' + job.workerNumber
            + ' failed after ' + accepted + ' new mutation(s): '
            + (error instanceof Error ? error.message : String(error)) + progress + continuation);
        } finally {
          if (run !== undefined) {
            try { await run.dispose(); } catch { /* best-effort child cleanup */ }
          }
        }
      }
      if (!completed) {
        throw new Error('compression exhausted ' + turnNoProgressAttempts
          + ' consecutive no-progress worker attempts', { cause: lastError });
      }
      validateLanding(job, e2eSmoke);
      land(job);
      if (!await persistLanding(job)) return false;
      ctx.logger.info('turn-memory: turn ' + job.turn + ' compression landed (' + job.targetSeqs.length + ' -> '
        + job.editor.snapshot().length + ', mutations=' + job.mutationCount + ', workerAttempts=' + job.workerNumber + ')');
      return true;
    } catch (error) {
      ctx.logger.warn('turn-memory: turn ' + job.turn + ' compression failed: ' + (error instanceof Error ? error.message : String(error)));
      return false;
    } finally {
      if (jobs.get(job.parentSessionId) === job) jobs.delete(job.parentSessionId);
    }
  };

  const enqueueTurn = (sessionId: string, turn: number, source: string): boolean => {
    if (!Number.isSafeInteger(turn)) {
      ctx.logger.warn('turn-memory: ignored ' + source + ' with invalid turn ' + String(turn) + ' for session ' + sessionId);
      return false;
    }
    let turns = pendingTurns.get(sessionId);
    if (turns === undefined) {
      turns = new Map();
      pendingTurns.set(sessionId, turns);
    }
    let sources = turns.get(turn);
    const added = sources === undefined;
    if (sources === undefined) {
      sources = new Set();
      turns.set(turn, sources);
    }
    sources.add(source);
    return added;
  };

  /**
   * One queued turn, end to end. Returns undefined when it is settled and a
   * reason string when it is not, so every failure path reaches failTurn() and
   * none of them can drop the queue entry.
   */
  const processTurn = async (agent: any, turn: number, sources: string): Promise<string | undefined> => {
    const sessionId = String(agent.session.id);
    if (compressedTurnNumbers(agent.session).has(turn) && !turnHasUnrewrittenReasoning(agent.session, turn)) {
      thoughtHints?.discardTurn(sessionId, turn);
      ctx.logger.info('turn-memory: turn ' + turn + ' is already compressed; removed duplicate queued work');
      await turnContinuation?.dispatchAfterCompression(agent, turn);
      return undefined;
    }
    const event = findCompletedTurnEnd(agent.session, turn);
    if (event === undefined) return 'no durable turn/end in the session log';
    const job = prepareJob(agent, event);
    if (job === undefined) {
      thoughtHints?.discardTurn(sessionId, turn);
      return 'no eligible current surface range; it may already be shadowed by another rewrite';
    }
    if (thoughtHints !== undefined) {
      job.thoughtHints = await thoughtHints.collectForTurn(job.session, turn, job.targetSeqs);
      ctx.logger.info('turn-memory: turn ' + turn + ' collected ' + job.thoughtHints.length
        + ' long-thought hint(s) before compression');
    }
    const bypassReason = turnCompressionBypassReason(job.editor.snapshot());
    if (bypassReason !== undefined) {
      ctx.logger.info('turn-memory: recording turn ' + turn + ' as a durable no-op without a worker: ' + bypassReason);
      land(job);
      if (!await persistLanding(job)) return 'the durable no-op marker was not persisted';
      ctx.logger.info('turn-memory: turn ' + turn + ' no-op marker landed (' + job.targetSeqs.length
        + ' nodes, workerAttempts=0)');
      await turnContinuation?.dispatchAfterCompression(agent, turn);
      return undefined;
    }
    jobs.set(sessionId, job);
    ctx.logger.info('turn-memory: starting turn ' + turn + ' compression from ' + sources);
    if (!await runCompression(job)) return 'compression did not land';
    await turnContinuation?.dispatchAfterCompression(agent, turn);
    return undefined;
  };

  const recordTurnFailure = async (session: any, turn: number, reason: string): Promise<void> => {
    const original = turnMarkerOriginal(session, turn);
    if (original === undefined) {
      ctx.logger.warn('turn-memory: turn ' + turn + ' has no user node for a durable failure marker');
      return;
    }
    appendTurnMarkerCopy(session, original, failedTurnSource(turn, reason));
    await ctx.sessions.flush(session);
  };

  const failTurn = async (agent: any, sessionId: string, turn: number, reason: string): Promise<void> => {
    let failures = turnFailures.get(sessionId);
    if (failures === undefined) {
      failures = new Map();
      turnFailures.set(sessionId, failures);
    }
    const attempts = (failures.get(turn) ?? 0) + 1;
    if (attempts <= TURN_FAILURE_RETRIES) {
      failures.set(turn, attempts);
      enqueueTurn(sessionId, turn, 'retry after failure');
      ctx.logger.warn('turn-memory: turn ' + turn + ' of session ' + sessionId + ' failed (' + reason
        + '); retrying in ' + TURN_FAILURE_RETRY_DELAY_MS + 'ms, attempt ' + attempts + '/' + TURN_FAILURE_RETRIES);
      await new Promise<void>((settle) => setTimeout(settle, TURN_FAILURE_RETRY_DELAY_MS));
      return;
    }
    failures.delete(turn);
    if (failures.size === 0) turnFailures.delete(sessionId);
    ctx.logger.warn('turn-memory: turn ' + turn + ' of session ' + sessionId + ' failed ' + attempts
      + ' time(s); recording a durable failure marker: ' + reason);
    await recordTurnFailure(agent.session, turn, reason);
  };

  const drainTurns = async (sessionId: string): Promise<void> => {
    while (!disposed) {
      const turns = pendingTurns.get(sessionId);
      const nextTurn = turns === undefined ? undefined : [...turns.keys()].sort((left, right) => left - right)[0];
      if (nextTurn === undefined) {
        pendingTurns.delete(sessionId);
        return;
      }
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) {
        ctx.logger.warn('turn-memory: session ' + sessionId + ' has ' + turns!.size
          + ' queued turn(s), but its agent is unavailable; they will be retried when the agent is created');
        return;
      }
      const sources = [...(turns!.get(nextTurn) ?? [])].join(', ');
      turns!.delete(nextTurn);
      if (turns!.size === 0) pendingTurns.delete(sessionId);
      const reason = await processTurn(agent, nextTurn, sources)
        .catch((error: unknown) => error instanceof Error ? error.message : String(error));
      if (reason === undefined) {
        const failures = turnFailures.get(sessionId);
        failures?.delete(nextTurn);
        if (failures?.size === 0) turnFailures.delete(sessionId);
        continue;
      }
      await failTurn(agent, sessionId, nextTurn, reason);
    }
  };

  const ensurePump = (sessionId: string): void => {
    if (disposed || pumps.has(sessionId)) return;
    if (ctx.agents.get(sessionId) === undefined) {
      const count = pendingTurns.get(sessionId)?.size ?? 0;
      ctx.logger.warn('turn-memory: queued ' + count + ' turn(s) for session ' + sessionId
        + ', but no agent is currently available');
      return;
    }
    const work = Promise.resolve().then(() => drainTurns(sessionId));
    pumps.set(sessionId, work);
    coordinator.trackTurnRewrite(sessionId, work);
    void work.finally(() => {
      if (pumps.get(sessionId) === work) pumps.delete(sessionId);
      if (!disposed && (pendingTurns.get(sessionId)?.size ?? 0) > 0 && ctx.agents.get(sessionId) !== undefined) {
        queueMicrotask(() => ensurePump(sessionId));
      }
    }).catch((error) => {
      ctx.logger.warn('turn-memory: turn queue for session ' + sessionId + ' failed: '
        + (error instanceof Error ? error.message : String(error)));
    });
  };

  ctx.on('session/event', (session: any, event: any) => {
    if (event.type !== 'turn/end' || !isUserConversationSession(session)) return;
    // Session.append() cannot re-enter the session/event publication boundary.
    // Defer both the durable marker and the queue so job preparation can only
    // observe the post-marker surface.
    queueMicrotask(() => {
      if (disposed) return;
      try {
        const sessionId = String(session.id);
        const turn = event.data?.turn;
        if (Number.isSafeInteger(turn)
          && !compressedTurnNumbers(session).has(turn)
          && !pendingTurnNumbers(session).has(turn)) {
          const user = turnMarkerOriginal(session, turn);
          if (user === undefined) {
            ctx.logger.warn('turn-memory: turn ' + String(turn) + ' has no user node for a durable pending marker; live processing remains available but cold recovery is not guaranteed');
          } else {
            appendTurnMarkerCopy(session, user, pendingTurnSource(turn));
            void ctx.sessions.flush(session).catch((error: unknown) => {
              ctx.logger.warn('turn-memory: pending marker flush failed for turn ' + String(turn) + ': '
                + (error instanceof Error ? error.message : String(error)));
            });
          }
        }
        if (e2eDeferTurnCompressionUntilResume) {
          ctx.logger.info('turn-memory: e2e deferred live turn ' + String(turn) + ' until agent resume recovery');
          return;
        }
        const added = enqueueTurn(sessionId, turn, 'live turn/end');
        if (added && jobs.has(sessionId)) {
          ctx.logger.info('turn-memory: queued turn ' + String(turn) + ' behind the active compression for session ' + sessionId);
        }
        if (ctx.agents.get(sessionId) === undefined) {
          ctx.logger.warn('turn-memory: queued turn ' + String(turn) + ' from turn/end, but session ' + sessionId
            + ' has no active agent; recovery will retry it on agent creation');
        }
        ensurePump(sessionId);
      } catch (error) {
        ctx.logger.warn('turn-memory: failed to observe completed turn: '
          + (error instanceof Error ? error.message : String(error)));
      }
    });
  });

  ctx.on('agent/created', ({ agent }: any) => {
    const session = agent?.session;
    if (!isUserConversationSession(session)) return;
    queueMicrotask(() => {
      if (disposed) return;
      const sessionId = String(session.id);
      const ends = completedTurnEnds(session);
      const compressed = compressedTurnNumbers(session);
      const pending = pendingTurnNumbers(session);
      let queued = 0;
      let staleReasoning = 0;
      for (const end of ends) {
        const stale = compressed.has(end.data.turn) && turnHasUnrewrittenReasoning(session, end.data.turn);
        if (stale) staleReasoning += 1;
        const continuationPending = turnContinuation?.needsDispatchAfterCompression(session, end.data.turn) === true;
        if (!pending.has(end.data.turn) && !stale && !continuationPending) continue;
        if (enqueueTurn(sessionId, end.data.turn, 'agent recovery scan')) queued += 1;
      }
      if (ends.length > 0 || (pendingTurns.get(sessionId)?.size ?? 0) > 0) {
        const landed = ends.filter((end) => compressed.has(end.data.turn)).length;
        ctx.logger.info('turn-memory: recovery scan for session ' + sessionId + ': completed=' + ends.length
          + ', compressedMarkers=' + landed + ', pendingMarkers=' + pending.size
          + ', staleReasoning=' + staleReasoning + ', newlyQueued=' + queued
          + ', pending=' + (pendingTurns.get(sessionId)?.size ?? 0));
      }
      ensurePump(sessionId);
    });
  });

  ctx.effect(() => () => {
    disposed = true;
    for (const job of jobs.values()) job.controller.abort();
    thoughtHints?.dispose();
    jobs.clear();
    pendingTurns.clear();
    pumps.clear();
    turnFailures.clear();
  });
}

export { apply, inject, name };
