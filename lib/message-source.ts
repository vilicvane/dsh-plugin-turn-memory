/**
 * Durable attribution for the messages and surface markers this plugin owns.
 *
 * DSH 0.2 replaced the shared `plugin` source kind with per-producer kinds:
 * every producer declares its own `kind` in its own module, and consumers fall
 * back gracefully for kinds they do not know. Markers already written by
 * 0.1.5 keep the old shape, so every predicate here accepts both generations
 * while the constructors only ever write the new one.
 */

import { boundContextSummary } from '@deepseek-ai/dsh-llm';

/** Surface marker saying the turn's compression is queued but has not landed. */
export interface TurnMemoryPendingSource {
  readonly kind: 'turn-memory-pending';
  readonly turn: number;
}

/** Surface marker saying the turn's compression landed. */
export interface TurnMemoryCompressionSource {
  readonly kind: 'turn-memory-compression';
  readonly turn: number;
  readonly draftId: string;
  readonly originalNodes: number;
  readonly mutations: number;
  readonly workerAttempts: number;
}

/** Surface marker saying the turn's compression gave up after failed retries. */
export interface TurnMemoryFailureSource {
  readonly kind: 'turn-memory-failed';
  readonly turn: number;
  readonly reason: string;
}

/** Host control context that resumes work after the turn was compressed. */
export interface TurnMemoryContinuationSource {
  readonly kind: 'turn-memory-continuation';
  /** A host notice shown without expanding the row (`notice` context form). */
  readonly form: 'notice';
  /** One-line account of what the continuation resumes. */
  readonly summary: string;
  readonly requestId: string;
  readonly fromTurn: number;
}

/** Internal hint fed to the compression model; never lands in a session. */
export interface TurnMemoryHintSource {
  readonly kind: 'turn-memory-hint';
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-memory-pending': TurnMemoryPendingSource;
    'turn-memory-compression': TurnMemoryCompressionSource;
    'turn-memory-failed': TurnMemoryFailureSource;
    'turn-memory-continuation': TurnMemoryContinuationSource;
    'turn-memory-hint': TurnMemoryHintSource;
  }
}

export interface CompressionTurnSourceInput {
  turn: number;
  draftId: string;
  originalNodes: number;
  mutations: number;
  workerAttempts: number;
}

export function pendingTurnSource(turn: number): TurnMemoryPendingSource {
  return { kind: 'turn-memory-pending', turn };
}

export function compressionTurnSource(input: CompressionTurnSourceInput): TurnMemoryCompressionSource {
  return {
    kind: 'turn-memory-compression',
    turn: input.turn,
    draftId: input.draftId,
    originalNodes: input.originalNodes,
    mutations: input.mutations,
    workerAttempts: input.workerAttempts,
  };
}

export function failedTurnSource(turn: number, reason: string): TurnMemoryFailureSource {
  return {
    kind: 'turn-memory-failed',
    turn,
    reason: boundContextSummary(reason),
  };
}

export function continuationTurnSource(turn: number, requestId: string): TurnMemoryContinuationSource {
  return {
    kind: 'turn-memory-continuation',
    form: 'notice',
    summary: boundContextSummary('Continue work after compressing turn ' + turn),
    requestId,
    fromTurn: turn,
  };
}

export const TURN_MEMORY_HINT_SOURCE: TurnMemoryHintSource = { kind: 'turn-memory-hint' };

const TURN_MEMORY_KINDS: ReadonlySet<string> = new Set([
  'turn-memory-pending',
  'turn-memory-compression',
  'turn-memory-failed',
  'turn-memory-continuation',
  'turn-memory-hint',
]);

/** DSH 0.1.5 bundled every plugin source into one shared `plugin` kind. */
function isLegacyPluginSource(source: any): boolean {
  return source !== null && typeof source === 'object' && source.kind === 'plugin';
}

export interface TurnMemoryMarker {
  readonly phase: 'pending' | 'compression';
  readonly turn: number;
}

/** Read one lifecycle marker, accepting both the per-kind and the legacy shape. */
export function turnMemoryMarkerOf(source: any): TurnMemoryMarker | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  if (isLegacyPluginSource(source)) {
    if (source.plugin !== 'turn-memory') return undefined;
    if (source.phase !== 'pending' && source.phase !== 'compression') return undefined;
    return Number.isSafeInteger(source.turn) ? { phase: source.phase, turn: source.turn } : undefined;
  }
  if (!Number.isSafeInteger(source.turn)) return undefined;
  if (source.kind === 'turn-memory-pending') return { phase: 'pending', turn: source.turn };
  if (source.kind === 'turn-memory-compression') return { phase: 'compression', turn: source.turn };
  return undefined;
}

/** The turn a marker attributes an event to, regardless of which lifecycle phase it records. */
export function turnMemoryMarkerTurn(source: any): number | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  if (isLegacyPluginSource(source)) {
    if (source.plugin !== 'turn-memory') return undefined;
    return Number.isSafeInteger(source.turn) ? source.turn : undefined;
  }
  if (!TURN_MEMORY_KINDS.has(source.kind)) return undefined;
  return Number.isSafeInteger(source.turn) ? source.turn : undefined;
}

/** The continuation request a resumable host notice carries. */
export function continuationRequestOf(source: any): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  if (source.kind === 'turn-memory-continuation' && typeof source.requestId === 'string') return source.requestId;
  if (isLegacyPluginSource(source) && source.plugin === 'turn-memory'
    && source.phase === 'continuation' && typeof source.requestId === 'string') return source.requestId;
  return undefined;
}

/** Any source this plugin wrote, in either generation. */
export function isTurnMemorySource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (isLegacyPluginSource(source)) return source.plugin === 'turn-memory';
  return TURN_MEMORY_KINDS.has(source.kind);
}

/** Compaction checkpoints are excluded from turn ranges in both generations. */
export function isCompactionCheckpointSource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (source.kind === 'compact-checkpoint') return true;
  return isLegacyPluginSource(source) && source.plugin === 'compact';
}

/** Durable runtime context snapshots, which are not part of a turn transcript. */
export function isRuntimeContextSource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (source.kind === 'runtime-context') return true;
  return isLegacyPluginSource(source) && source.plugin === '@deepseek-ai/dsh-system-prompt';
}

/** Plugin name reported for one source, keeping the 0.1.5 `plugin:<name>` rendering. */
export function pluginSourceName(source: any): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  if (isLegacyPluginSource(source)) {
    return typeof source.plugin === 'string' && source.plugin !== '' ? source.plugin : undefined;
  }
  if (TURN_MEMORY_KINDS.has(source.kind)) return 'turn-memory';
  if (source.kind === 'compact-checkpoint') return 'compact';
  return undefined;
}
