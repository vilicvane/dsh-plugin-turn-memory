import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type { MemoryCoordinator } from './coordinator.ts';
import { buildSessionCompactionPrompt } from './session-prompt.ts';
import { SessionMemoryEditor } from './session-editor.ts';
import type { SessionMemoryOutput, SessionMemoryRange } from './session-editor.ts';
import {
  buildSessionSegments,
  readSessionSourceNodes,
  renderSegmentCatalog,
  renderSegmentSource,
  sessionSurfaceUnitKeys,
} from './session-segments.ts';
import type { PricedNode, SessionSegment } from './session-segments.ts';
import type { SourceNodeRange } from './session-segments.ts';
import { WorkerToolScope } from './worker-tools.ts';
import { assertMemoryImagesRetained } from './memory-images.ts';
import { isUserConversationSession } from './session-kind.ts';

export const SESSION_TOOL_NAMES = [
  'list_session_segments',
  'read_session_source_nodes',
  'list_session_memory',
  'read_session_memory',
  'search_session_memory',
  'replace_session_memory',
  'finish_session_segment',
];

export interface SessionCompactionConfig {
  enabled?: boolean;
  auto?: boolean;
  thresholdRatio?: number;
  retainRatio?: number;
  retainTokens?: number;
  segmentTokens?: number;
  previewChars?: number;
  maxReadChars?: number;
  warmupChars?: number;
  workerMaxTokens?: number;
  workerAttempts?: number;
  workerTimeoutMs?: number;
  compactionRetries?: number;
  e2eInterruptSessionAfterFirstMutation?: boolean;
}

interface ResolvedSessionCompactionConfig {
  auto: boolean;
  thresholdRatio: number;
  retainRatio?: number;
  retainTokens?: number;
  segmentTokens: number;
  previewChars: number;
  maxReadChars: number;
  warmupChars: number;
  workerMaxTokens: number;
  workerAttempts: number;
  workerTimeoutMs: number;
  compactionRetries: number;
  e2eInterruptSessionAfterFirstMutation: boolean;
}

interface SurfaceSelection {
  start: number;
  end: number;
  startIndex: number;
  endIndex: number;
  shadowedSeqs: number[];
}

interface SessionMeasurement {
  totalTokens: number;
  surfaceTokens: number;
  nodes: PricedNode[];
}

interface SessionMeasurementResult {
  measurement: SessionMeasurement;
  fallbackSeq?: number;
}

interface SessionCompactionJob {
  parentSessionId: string;
  agent: any;
  session: any;
  segments: SessionSegment[];
  editor: SessionMemoryEditor;
  activeSegment?: number;
  activeChildSessionId?: string;
  finishConfirmed: boolean;
  e2eInterrupted: boolean;
}

interface StagedFinish {
  job: SessionCompactionJob;
  segment: number;
  revision: number;
}

interface TransactionOptions {
  owner: 'current-turn' | null;
  stability: 'whole-surface' | 'selected-span';
  sourceCommandId?: any;
  flush?: () => Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(name + ' must be a positive integer');
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(name + ' must be a non-negative integer');
  return resolved;
}

function ratio(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved >= 1) throw new Error(name + ' must be greater than 0 and less than 1');
  return resolved;
}

function resolveConfig(config: SessionCompactionConfig = {}): ResolvedSessionCompactionConfig {
  if (config.retainRatio !== undefined && config.retainTokens !== undefined) {
    throw new Error('session compaction retainRatio and retainTokens are mutually exclusive');
  }
  return {
    auto: config.auto !== false,
    thresholdRatio: ratio(config.thresholdRatio, 0.8, 'session compaction thresholdRatio'),
    ...(config.retainTokens === undefined
      ? { retainRatio: ratio(config.retainRatio, 0.16, 'session compaction retainRatio') }
      : { retainTokens: nonNegativeInteger(config.retainTokens, 0, 'session compaction retainTokens') }),
    segmentTokens: positiveInteger(config.segmentTokens, 32_000, 'session compaction segmentTokens'),
    previewChars: positiveInteger(config.previewChars, 120, 'session compaction previewChars'),
    maxReadChars: positiveInteger(config.maxReadChars, 160_000, 'session compaction maxReadChars'),
    warmupChars: positiveInteger(config.warmupChars, 16_000, 'session compaction warmupChars'),
    workerMaxTokens: positiveInteger(config.workerMaxTokens, 8_192, 'session compaction workerMaxTokens'),
    workerAttempts: positiveInteger(config.workerAttempts, 2, 'session compaction workerAttempts'),
    workerTimeoutMs: positiveInteger(config.workerTimeoutMs, 300_000, 'session compaction workerTimeoutMs'),
    compactionRetries: nonNegativeInteger(config.compactionRetries, 1, 'session compaction compactionRetries'),
    e2eInterruptSessionAfterFirstMutation: config.e2eInterruptSessionAfterFirstMutation === true,
  };
}

function errorText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(': ');
}

function estimatedHeaderTokens(header: any): number {
  const systemTokens = typeof header?.system === 'string' ? Math.ceil(header.system.length / 4) + 4 : 0;
  const toolsTokens = Array.isArray(header?.tools) && header.tools.length > 0
    ? Math.ceil(JSON.stringify(header.tools).length / 4) + 4
    : 0;
  return systemTokens + toolsTokens;
}

function replacementAssistantSeq(error: unknown, session: any): number | undefined {
  const match = /token meter: assistant\/message at seq (\d+) has no matching step\/start event/.exec(errorText(error));
  if (match === null) return undefined;
  const seq = Number(match[1]);
  const event = session.events[seq];
  if (event?.type !== 'assistant/message'
    || event.surfaceOp?.op !== 'replace'
    || event.data?.source?.plugin !== 'turn-memory') return undefined;
  return seq;
}

/**
 * Price the canonical surface directly when upstream token-meter cannot replay
 * a post-turn assistant replacement as a provider step. The fallback is
 * deliberately restricted to turn-memory replacement events; unrelated log
 * corruption still fails closed.
 */
export function measureSessionForCompaction(meter: any, session: any): SessionMeasurementResult {
  try {
    return { measurement: meter.measure(session) as SessionMeasurement };
  } catch (error) {
    const fallbackSeq = replacementAssistantSeq(error, session);
    if (fallbackSeq === undefined) throw error;
    const nodes = (session.surface.nodes as number[]).map((seq): PricedNode => {
      const event = session.events[seq];
      const message = event === undefined ? null : deriveEventMessage(event);
      if (message === null) throw new Error('session compaction: surface seq ' + seq + ' has no model-visible message');
      return { seq, tokens: meter.estimateMessage(message) };
    });
    const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
    return {
      fallbackSeq,
      measurement: {
        totalTokens: surfaceTokens + estimatedHeaderTokens(session.requestHeader?.()),
        surfaceTokens,
        nodes,
      },
    };
  }
}

function conversationTarget(agent: any): { provider: string; model: string } | undefined {
  const routed = agent.session.requestHeader()?.config;
  if (typeof routed?.provider === 'string' && routed.provider !== '' && typeof routed?.model === 'string' && routed.model !== '') {
    return { provider: routed.provider, model: routed.model };
  }
  if (typeof agent.options?.provider === 'string' && agent.options.provider !== ''
    && typeof agent.options?.model === 'string' && agent.options.model !== '') {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return undefined;
}

function inspectEntryState(events: readonly any[]): {
  openTurn: number | null;
  openTurnStart?: number;
  activeCompaction?: any;
  latestEndSeedSeq?: number;
} {
  let openTurn: number | null = null;
  let openTurnStart: number | undefined;
  let turnKnown = false;
  let activeCompaction: any;
  let compactionKnown = false;
  let latestEndSeedSeq: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (latestEndSeedSeq === undefined && event?.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!compactionKnown) {
      if (event?.type === 'compaction/start') {
        activeCompaction = event;
        compactionKnown = true;
      } else if (event?.type === 'compaction/end') {
        compactionKnown = true;
      }
    }
    if (!turnKnown) {
      if (event?.type === 'turn/start') {
        openTurn = event.data.turn;
        openTurnStart = event.seq;
        turnKnown = true;
      } else if (event?.type === 'turn/end') {
        turnKnown = true;
      }
    }
    if (turnKnown && compactionKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, openTurnStart, activeCompaction, latestEndSeedSeq };
}

function assertNoActiveCompaction(session: any, stage: string): void {
  const state = inspectEntryState(session.events);
  if (state.activeCompaction === undefined) return;
  if (state.latestEndSeedSeq !== undefined && state.latestEndSeedSeq > state.activeCompaction.seq) return;
  throw new ManualCompactionError('busy', stage + ': session compaction lock is already active');
}

function belongsToOpenTurn(event: any, openTurn: number, openTurnStart: number): boolean {
  if (event?.data?.source?.plugin === 'compact') return false;
  if (event?.data?.source?.plugin === 'turn-memory' && Number.isSafeInteger(event.data.source.turn)) {
    return event.data.source.turn === openTurn;
  }
  if (Number.isSafeInteger(event?.data?.turn)) return event.data.turn === openTurn;
  return event?.type === 'user/message' && event.seq > openTurnStart;
}

function completedPrefixLength(session: any): number {
  const state = inspectEntryState(session.events);
  if (state.openTurn === null || state.openTurnStart === undefined) return session.surface.nodes.length;
  const firstCurrent = session.surface.nodes.findIndex((seq: number) => belongsToOpenTurn(session.events[seq], state.openTurn!, state.openTurnStart!));
  return firstCurrent < 0 ? session.surface.nodes.length : firstCurrent;
}

export function selectSessionCompactionRange(
  session: any,
  measurement: { nodes: readonly PricedNode[] },
  retainTokens: number,
): { start: number; end: number } | null {
  const surface = session.surface.nodes as number[];
  if (surface.length !== measurement.nodes.length || surface.some((seq, index) => seq !== measurement.nodes[index]?.seq)) {
    throw new Error('session compaction: token-meter surface does not match the current session surface');
  }
  if (surface.length === 0) return null;
  let accumulated = 0;
  let keepFrom = surface.length;
  for (let index = measurement.nodes.length - 1; index >= 0; index -= 1) {
    accumulated += measurement.nodes[index].tokens;
    keepFrom = index;
    if (accumulated >= retainTokens) break;
  }
  const selectable = completedPrefixLength(session);
  let endExclusive = Math.min(keepFrom, selectable);
  const unitKeys = sessionSurfaceUnitKeys(session, surface);
  while (endExclusive > 0) {
    const balanced = toolPairingBalancedAfter(session, surface[endExclusive - 1]);
    const unitBoundary = endExclusive === surface.length || unitKeys[endExclusive - 1] !== unitKeys[endExclusive];
    if (balanced && unitBoundary) break;
    endExclusive -= 1;
  }
  if (endExclusive <= 0) return null;
  if (!toolPairingBalancedBefore(session, surface[0])) throw new Error('session compaction: surface head is not tool-pairing balanced');
  return { start: surface[0], end: surface[endExclusive - 1] };
}

function validateSurfaceRegion(session: any, start: number, end: number): SurfaceSelection {
  const nodes = session.surface.nodes as number[];
  const startIndex = nodes.indexOf(start);
  const endIndex = nodes.indexOf(end);
  if (startIndex < 0) throw new Error('session compactRegion: start seq ' + start + ' not found in surface');
  if (endIndex < 0) throw new Error('session compactRegion: end seq ' + end + ' not found in surface');
  if (startIndex > endIndex) throw new Error('session compactRegion: reversed surface range');
  if (!toolPairingBalancedBefore(session, start)) throw new Error('session compactRegion: start boundary splits a tool pair');
  if (!toolPairingBalancedAfter(session, end)) throw new Error('session compactRegion: end boundary splits a tool pair');
  const unitKeys = sessionSurfaceUnitKeys(session, nodes);
  if (startIndex > 0 && unitKeys[startIndex - 1] === unitKeys[startIndex]) {
    throw new Error('session compactRegion: start boundary splits a completed turn');
  }
  if (endIndex + 1 < nodes.length && unitKeys[endIndex] === unitKeys[endIndex + 1]) {
    throw new Error('session compactRegion: end boundary splits a completed turn');
  }
  const selectable = completedPrefixLength(session);
  if (endIndex >= selectable) throw new Error('session compactRegion: range includes the current unfinished turn');
  return { start, end, startIndex, endIndex, shadowedSeqs: nodes.slice(startIndex, endIndex + 1) };
}

/** Custom session-level compaction service backed by revisioned main-model subagent workers. */
export class SessionMemoryCompactionEngine extends CompactionEngine {
  private readonly config: ResolvedSessionCompactionConfig;
  private readonly coordinator: MemoryCoordinator;
  private readonly jobs = new Map<string, SessionCompactionJob>();
  private readonly stagedFinishes = new WeakMap<object, StagedFinish>();
  private readonly overflowRecovered = new WeakSet<object>();
  private readonly measurementFallbackWarned = new WeakSet<object>();
  private readonly workerTools: WorkerToolScope;
  private readonly sharedWorkerTools: readonly any[];

  constructor(ctx: any, config: SessionCompactionConfig, coordinator: MemoryCoordinator, sharedWorkerTools: readonly any[] = []) {
    super(ctx);
    this.config = resolveConfig(config);
    this.coordinator = coordinator;
    this.sharedWorkerTools = sharedWorkerTools;
    this.workerTools = this.createWorkerTools();
    if (this.config.auto) this.registerAutomaticCompaction();
    ctx.logger.info('turn-memory: session compaction mounted (main-model fork first, segmentTokens=' + this.config.segmentTokens + ')');
  }

  async compactIfNeeded(agent: any, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    // This engine rewrites durable parent history. Compaction workers and other
    // child agents must fail/fallback normally instead of recursively compacting
    // their inherited session while producing the parent's checkpoint.
    if (!isUserConversationSession(agent.session)) return null;
    await this.coordinator.waitForTurnRewrite(String(agent.session.id), signal);
    signal.throwIfAborted();
    const target = conversationTarget(agent);
    if (target === undefined) return null;
    assertNoActiveCompaction(agent.session, 'automatic session compaction');
    const meter = (this.ctx as any).tokenMeter;
    let measurement = this.measureSession(agent.session);
    let retainTokens = 0;
    let thresholdTokens = 0;
    if (trigger === 'pressure') {
      const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
      if (context === undefined) throw new Error('session compaction: no contextWindow for ' + target.provider + '/' + target.model);
      thresholdTokens = Math.floor(context.contextWindow * this.config.thresholdRatio);
      if (measurement.totalTokens < thresholdTokens) return null;
      retainTokens = this.config.retainTokens ?? Math.floor(context.contextWindow * this.config.retainRatio!);
    }
    let result: CompactionResult | null = null;
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt += 1) {
      const range = selectSessionCompactionRange(agent.session, measurement, retainTokens);
      if (range === null) return result;
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = this.measureSession(agent.session);
      if (trigger === 'context-overflow' || measurement.totalTokens < thresholdTokens) return result;
    }
    throw new Error('session compaction remains above threshold after ' + (this.config.compactionRetries + 1) + ' attempts');
  }

  async compactRegion(start: number, end: number, agent: any, signal?: AbortSignal): Promise<CompactionResult> {
    await this.coordinator.waitForTurnRewrite(String(agent.session.id), signal);
    return this.compactSurfaceRegion(agent, start, end, {
      owner: 'current-turn',
      stability: 'whole-surface',
    }, signal);
  }

  compactNow(agent: any, signal: AbortSignal, sourceCommandId?: any): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async (agentSignal: AbortSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          await this.coordinator.waitForTurnRewrite(String(agent.session.id), operationSignal);
          operationSignal.throwIfAborted();
          const range = selectSessionCompactionRange(agent.session, this.measureSession(agent.session), 0);
          if (range === null) return null;
          return await this.compactSurfaceRegion(agent, range.start, range.end, {
            owner: null,
            stability: 'selected-span',
            ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            flush: async () => { await this.ctx.sessions.flush(agent.session); },
          }, operationSignal);
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual session compaction was cancelled', { cause: error });
          }
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof ManualCompactionError) return Promise.reject(error);
      throw new ManualCompactionError('busy', 'manual session compaction requires an idle agent', { cause: error });
    }
  }

  private createWorkerTools(): WorkerToolScope {
    const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
    const definitions: any[] = [...this.sharedWorkerTools];
    const add = (definition: any): void => { definitions.push(definition); };
    add(defineTool({
      name: 'list_session_segments',
      description: 'List the compact global directory of source segments for the active session-compaction worker. It returns metadata and previews, not every source node body.',
      parameters: {},
      output,
      isConcurrencySafe: () => true,
      execute: async (_args: unknown, exec: any) => {
        const job = this.jobFor(exec);
        return 'revision=' + job.editor.revision + '\n' + renderSegmentCatalog(job.segments, (segment) => job.editor.status(segment));
      },
    }));
    add(defineTool({
      name: 'read_session_source_nodes',
      description: 'Read exact source content for several opaque node ids or continuous node ranges in one call. Requests above the host character cap fail and should be narrowed.',
      parameters: {
        ranges: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'string', required: true },
              end: { type: 'string' },
            },
          },
        },
      },
      output,
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => {
        const job = this.jobFor(exec);
        if (job.activeSegment === undefined) throw new Error('session compaction worker has no assigned segment');
        const prefix = 's' + job.activeSegment + 'n';
        for (const range of args.ranges as SourceNodeRange[]) {
          if (!range.start.startsWith(prefix) || (range.end !== undefined && !range.end.startsWith(prefix))) {
            throw new Error('source-node reads are limited to assigned segment s' + job.activeSegment);
          }
        }
        return readSessionSourceNodes(job.session, job.segments, args.ranges as SourceNodeRange[], this.config.maxReadChars);
      },
    }));
    add(defineTool({
      name: 'list_session_memory',
      description: 'Page through the current host-owned working-checkpoint node directory at its current revision.',
      parameters: {
        cursor: { type: 'number', description: 'Zero-based node offset; defaults to 0.' },
        limit: { type: 'number', description: 'Page size from 1 to 200; defaults to 80.' },
      },
      output,
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => this.jobFor(exec).editor.catalog(args.cursor ?? 0, args.limit ?? 80, this.config.previewChars),
    }));
    add(defineTool({
      name: 'read_session_memory',
      description: 'Read exact current working-checkpoint nodes by id or continuous id ranges. Replaced ids are stale.',
      parameters: {
        ranges: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'string', required: true },
              end: { type: 'string' },
            },
          },
        },
      },
      output,
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => this.jobFor(exec).editor.read(args.ranges as SessionMemoryRange[], this.config.maxReadChars),
    }));
    add(defineTool({
      name: 'search_session_memory',
      description: 'Case-insensitively search current generated memory content and return matching ids with previews.',
      parameters: {
        query: { type: 'string', required: true },
        limit: { type: 'number', description: 'Maximum matches from 1 to 50; defaults to 20.' },
      },
      output,
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => this.jobFor(exec).editor.search(args.query, args.limit ?? 20),
    }));
    add(defineTool({
      name: 'replace_session_memory',
      description: 'At an exact revision, replace one current memory node or continuous range with ordered user/assistant nodes. The range must cover the assigned segment and may include earlier memory, but never a future placeholder. Returns the new revision and local neighborhood.',
      parameters: {
        expectedRevision: { type: 'number', required: true },
        start: { type: 'string', required: true },
        end: { type: 'string' },
        nodes: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, enum: ['user', 'assistant'] },
              content: { type: 'string', required: true },
            },
          },
        },
      },
      output,
      isConcurrencySafe: () => false,
      execute: async (args: any, exec: any) => {
        const job = this.jobFor(exec);
        if (job.activeSegment === undefined) throw new Error('session compaction worker has no assigned segment');
        const result = job.editor.replace(job.activeSegment, args.expectedRevision, args.start, args.end, args.nodes as SessionMemoryOutput[]);
        if (this.config.e2eInterruptSessionAfterFirstMutation && !job.e2eInterrupted && job.activeSegment === 1) {
          job.e2eInterrupted = true;
          exec.concludeTurn();
        }
        return 'revision=' + result.revision + ' created=' + result.created.map((node) => node.id).join(',')
          + '\nlocal-neighborhood:\n' + result.neighborhood;
      },
    }));
    add(defineTool({
      name: 'finish_session_segment',
      description: 'Validate and submit the assigned segment at the exact current revision. This is the worker’s only accepted completion path and concludes its turn on success.',
      parameters: {
        expectedRevision: { type: 'number', required: true },
      },
      output,
      isConcurrencySafe: () => false,
      execute: async (args: any, exec: any) => {
        const job = this.jobFor(exec);
        if (job.activeSegment === undefined) throw new Error('session compaction worker has no assigned segment');
        job.editor.validateSegmentFinish(job.activeSegment, args.expectedRevision);
        this.stagedFinishes.set(exec as object, { job, segment: job.activeSegment, revision: args.expectedRevision });
        exec.concludeTurn();
        return 'segment s' + job.activeSegment + ' accepted at revision=' + args.expectedRevision;
      },
    }));
    this.ctx.on('tools/result', (exec: any, result: any) => {
      const staged = this.stagedFinishes.get(exec as object);
      if (staged === undefined) return;
      this.stagedFinishes.delete(exec as object);
      if (result.isError) return;
      staged.job.editor.finishSegment(staged.segment, staged.revision);
      staged.job.finishConfirmed = true;
    });
    return new WorkerToolScope(this.ctx, definitions);
  }

  private measureSession(session: any): SessionMeasurement {
    const result = measureSessionForCompaction((this.ctx as any).tokenMeter, session);
    if (result.fallbackSeq !== undefined && !this.measurementFallbackWarned.has(session)) {
      this.measurementFallbackWarned.add(session);
      this.ctx.logger.warn('turn-memory: token-meter rejected replacement assistant/message seq '
        + result.fallbackSeq + '; session compaction is using canonical-surface heuristic pricing');
    }
    return result.measurement;
  }

  private jobFor(exec: any): SessionCompactionJob {
    const child = exec.agent;
    const parentSessionId = child?.session?.header?.parentSession;
    if (parentSessionId === undefined) throw new Error('session memory tools are available only inside an active compaction worker');
    const job = this.jobs.get(String(parentSessionId));
    if (job === undefined) throw new Error('no active session compaction job for this worker parent');
    const childSessionId = String(child.session.id);
    if (job.activeChildSessionId !== undefined && job.activeChildSessionId !== childSessionId) {
      throw new Error('session compaction job is bound to a different active worker');
    }
    job.activeChildSessionId = childSessionId;
    return job;
  }

  private async runWorkers(job: SessionCompactionJob, target: { provider: string; model: string }, signal?: AbortSignal): Promise<void> {
    this.jobs.set(job.parentSessionId, job);
    try {
      for (const segment of job.segments) {
        job.activeSegment = segment.index;
        let completed = false;
        let lastError: unknown;
        let workerNumber = 0;
        let noProgressAttempts = 0;
        while (noProgressAttempts < this.config.workerAttempts) {
          signal?.throwIfAborted();
          workerNumber += 1;
          const provider = workerNumber === 1 ? 'fork' : 'spawn';
          const workerMode = provider === 'fork' ? 'fork' : 'fresh-spawn';
          job.activeChildSessionId = undefined;
          job.finishConfirmed = false;
          const revisionBefore = job.editor.revision;
          let run: any;
          const timeoutSignal = AbortSignal.timeout(this.config.workerTimeoutMs);
          const workerSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
          const workerScope = this.workerTools.startOptions();
          try {
            run = await (this.ctx as any).subagents.start(provider, {
              label: 'session memory ' + segment.id + ' (' + workerMode + ')',
              prompt: [{ type: 'text', text: buildSessionCompactionPrompt({
                editor: job.editor,
                segments: job.segments,
                assigned: segment,
                session: job.session,
                workerMode,
                warmupChars: this.config.warmupChars,
                previewChars: this.config.previewChars,
              }) }],
              parent: job.agent,
              signal: workerSignal,
              persona: workerScope.persona,
              agentOptions: {
                provider: target.provider,
                model: target.model,
                maxTokens: this.config.workerMaxTokens,
                ...workerScope.agentOptions,
              },
            });
            const result = await run.result;
            if (result.stopReason !== 'completed') throw new Error(provider + ' worker ended with ' + JSON.stringify(result.stopReason));
            if (!job.finishConfirmed) throw new Error(provider + ' worker completed without finish_session_segment');
            completed = true;
            this.ctx.logger.info('turn-memory: session segment ' + segment.id + ' finished by ' + provider + ' at revision ' + job.editor.revision);
            break;
          } catch (error) {
            lastError = error;
            if (signal?.aborted) signal.throwIfAborted();
            const accepted = job.editor.revision - revisionBefore;
            if (accepted > 0) noProgressAttempts = 0;
            else noProgressAttempts += 1;
            const progress = accepted > 0
              ? '; accepted revision progress reset consecutive no-progress attempts to 0/' + this.config.workerAttempts
              : '; consecutive no-progress attempts=' + noProgressAttempts + '/' + this.config.workerAttempts;
            const continuation = noProgressAttempts < this.config.workerAttempts
              ? '; starting a fresh same-model worker from revision ' + job.editor.revision
              : '';
            this.ctx.logger.warn('turn-memory: session segment ' + segment.id + ' ' + provider + ' worker ' + workerNumber
              + ' failed after ' + accepted + ' accepted revision(s): ' + errorText(error) + progress + continuation);
          } finally {
            if (run !== undefined) {
              try { await run.dispose(); } catch { /* best-effort child cleanup */ }
            }
          }
        }
        if (!completed) throw new Error('session segment ' + segment.id + ' exhausted ' + this.config.workerAttempts
          + ' consecutive no-progress worker attempts', { cause: lastError });
      }
      job.editor.validateFinal();
    } finally {
      this.jobs.delete(job.parentSessionId);
      job.activeSegment = undefined;
      job.activeChildSessionId = undefined;
    }
  }

  private async compactSurfaceRegion(
    agent: any,
    start: number,
    end: number,
    options: TransactionOptions,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted();
    const session = agent.session;
    const selection = validateSurfaceRegion(session, start, end);
    const entry = inspectEntryState(session.events);
    assertNoActiveCompaction(session, 'session compaction');
    let owner: number | null;
    if (options.owner === null) {
      if (entry.openTurn !== null) throw new ManualCompactionError('busy', 'manual session compaction found an open turn');
      owner = null;
    } else {
      if (entry.openTurn === null) throw new Error('automatic session compaction requires an open turn');
      owner = entry.openTurn;
    }
    const measurement = this.measureSession(session);
    const selectedPriced = measurement.nodes.slice(selection.startIndex, selection.endIndex + 1) as PricedNode[];
    if (selectedPriced.length !== selection.shadowedSeqs.length
      || selectedPriced.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
      throw new Error('session compaction selected surface changed before the durable start marker');
    }
    const shadowedTokenCount = selectedPriced.reduce((total, node) => total + node.tokens, 0);
    const target = conversationTarget(agent);
    if (target === undefined) throw new Error('session compaction has no parent provider/model route');
    const segments = buildSessionSegments(session, selectedPriced, this.config.segmentTokens, this.config.previewChars);
    const job: SessionCompactionJob = {
      parentSessionId: String(session.id),
      agent,
      session,
      segments,
      editor: new SessionMemoryEditor(segments.length),
      finishConfirmed: false,
      e2eInterrupted: false,
    };
    const compactionId = CompactionId(randomUUID());
    const lifecycle = {
      compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      turn: owner,
    };
    const startEvent = session.append('compaction/start', lifecycle);
    let closed = false;
    let result: CompactionResult | undefined;
    let failure: unknown;
    let flushFailure: unknown;
    try {
      await this.runWorkers(job, target, signal);
      signal?.throwIfAborted();
      const currentSelection = validateSurfaceRegion(session, start, end);
      if (!isDeepStrictEqual(currentSelection.shadowedSeqs, selection.shadowedSeqs)) {
        throw new Error('session compaction selected span changed while workers ran');
      }
      const currentMeasurement = this.measureSession(session);
      if (options.stability === 'whole-surface' && !isDeepStrictEqual(currentMeasurement.nodes, measurement.nodes)) {
        throw new Error('session compaction surface changed while workers ran');
      }
      if (options.stability === 'selected-span') {
        const currentPriced = currentMeasurement.nodes.slice(currentSelection.startIndex, currentSelection.endIndex + 1);
        if (!isDeepStrictEqual(currentPriced, selectedPriced)) throw new Error('session compaction selected span was repriced while workers ran');
      }
      const checkpointText = job.editor.renderCheckpoint();
      assertMemoryImagesRetained(
        selection.shadowedSeqs.map((seq) => session.events[seq]?.data),
        checkpointText,
        'session compaction',
      );
      const summary = [{ type: 'text' as const, text: checkpointText }];
      const checkpointMessage = createUserMessage({
        content: summary,
        source: compactCheckpointSource(compactionId, options.sourceCommandId),
      });
      const checkpointTokens = (this.ctx as any).tokenMeter.estimateMessage(checkpointMessage);
      if (checkpointTokens >= shadowedTokenCount) {
        throw new Error('session checkpoint is not smaller than its source (' + checkpointTokens + ' >= ' + shadowedTokenCount + ' estimated tokens)');
      }
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
        summary,
        shadowedRange: { start, end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
        provider: target.provider,
        model: target.model,
        maxTokens: this.config.workerMaxTokens,
      });
      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', start, end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
      });
      const endEvent = session.append('compaction/end', lifecycle);
      closed = true;
      result = {
        compactionId,
        ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary,
        shadowedRange: { start, end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
      };
    } catch (error) {
      failure = error;
      if (!closed) {
        try {
          session.append('compaction/end', { ...lifecycle, error: errorText(error) });
          closed = true;
        } catch (closeError) {
          failure = new Error('session compaction failed and its end marker could not be appended', { cause: closeError });
        }
      }
    }
    if (closed && options.flush !== undefined) {
      try { await options.flush(); } catch (error) { flushFailure = error; }
    }
    signal?.throwIfAborted();
    if (failure !== undefined) {
      if (options.owner === null) throw new ManualCompactionError('summary', 'manual session compaction failed', { cause: failure });
      throw failure;
    }
    if (flushFailure !== undefined) throw new ManualCompactionError('persistence', 'manual session compaction durability checkpoint failed', { cause: flushFailure });
    if (result === undefined) throw new Error('session compaction closed without a result');
    this.ctx.logger.info('turn-memory: session compaction committed ' + selection.shadowedSeqs.length + ' nodes in ' + segments.length + ' segments (~' + shadowedTokenCount + ' tokens)');
    return result;
  }

  private registerAutomaticCompaction(): void {
    this.ctx.on('agent/pre-step', async ({ agent, signal }: any, next: () => Promise<any>) => {
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal);
        } catch (error) {
          this.ctx.logger.warn('turn-memory: automatic session compaction failed: ' + errorText(error) + '; continuing the turn');
        }
      }
      return next();
    });
    this.ctx.on('agent/status', ({ agent, status }: any) => {
      if (status === 'idle') this.overflowRecovered.delete(agent);
    });
    this.ctx.on('agent/request-error', async ({ agent, failure, signal }: any, next: () => Promise<any>) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      if (this.overflowRecovered.has(agent)) return next();
      const generation = agent.session.surface.replaceGeneration;
      try {
        const result = await this.compactIfNeeded(agent, 'context-overflow', signal);
        if (result === null || signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
        this.overflowRecovered.add(agent);
        return { kind: 'retry' };
      } catch (error) {
        this.ctx.logger.warn('turn-memory: context-overflow session compaction failed: ' + errorText(error));
        return next();
      }
    });
  }
}
