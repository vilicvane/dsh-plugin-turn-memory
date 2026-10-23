import { isTurnMemorySource, pluginSourceName } from './message-source.ts';

/**
 * Message provenance shared by every surface reader.
 *
 * Two questions look alike and are asked in different places, so they are kept as two
 * explicit predicates over one vocabulary instead of one overloaded table:
 *
 * 1. `isInjectedHostSource` — "is this user message anything other than a human
 *    request?" Turn compression asks it to decide whether a compressed segment owes a
 *    `User:` opening. One-shot notices belong here: a notification is not a person, so
 *    the segment that only holds one reads as assistant memory.
 * 2. `isReSuppliedHostContext` — "is this node host context that carries no
 *    conversation-specific information?" Session compaction asks it to decide what to
 *    hand the worker as memory. Notices stay out of this set: a settlement notice
 *    carries a subagent's closing message and a job notice carries an external result,
 *    and dropping them would lose evidence.
 */

/** Host-injected message kinds that are never a human request. */
const INJECTED_HOST_KINDS: ReadonlySet<string> = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
  'skill-invocation',
  'tool-jobs',
]);

/** Context forms mark a message the harness formed rather than one a person wrote. */
const INJECTED_HOST_FORMS: ReadonlySet<string> = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
]);

/**
 * Host context that every step re-supplies: workspace instructions, runtime snapshots,
 * and skill catalogs. A checkpoint neither quotes nor summarizes them because the next
 * step regenerates the same text. `instructions` also covers an invoked skill body,
 * which stays available in its own file.
 */
const RE_SUPPLIED_HOST_KINDS: ReadonlySet<string> = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
]);

const RE_SUPPLIED_HOST_FORMS: ReadonlySet<string> = new Set([
  'instructions',
  'catalog',
  'snapshot',
]);

/** Lifecycle marker kinds that copy one existing message instead of adding a new one. */
const LIFECYCLE_MARKER_KINDS: ReadonlySet<string> = new Set([
  'turn-memory-pending',
  'turn-memory-failed',
]);

/** The source recorded for one message node, whichever envelope carries it. */
export function messageSourceOf(event: any): any {
  return event?.data?.source ?? event?.data?.message?.source;
}

/**
 * Resolve the message a lifecycle marker copy replaced.
 *
 * `turn/end` rewrites the turn's leading user message into a `turn-memory-pending` copy
 * carrying the marker source, so the recorded source alone no longer says whether the
 * human or the host opened the turn. The copy keeps the shadowed seq in
 * `sourceEventSeqs`, so provenance stays readable across the rewrite.
 */
export function resolveLifecycleSource(event: any, events: readonly any[]): any {
  let current = event;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const source = messageSourceOf(current);
    if (!LIFECYCLE_MARKER_KINDS.has(source?.kind)) return source;
    const originSeq = Array.isArray(current?.sourceEventSeqs) ? current.sourceEventSeqs[0] : undefined;
    if (!Number.isSafeInteger(originSeq) || events[originSeq] === undefined) return source;
    current = events[originSeq];
  }
  return messageSourceOf(current);
}

/** Whether one source records a human act: a typed message or an approval decision. */
export function isHumanSource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (isTurnMemorySource(source)) return false;
  return source.kind === 'user' || source.kind === 'user-approval';
}

/**
 * Whether one user message is host-injected rather than a human request.
 *
 * Steering is ordinary human input carried by a plain `user` source, so a steered
 * segment still counts as human: the merged intent belongs in a user node even when
 * the segment opened with a continuation notice. Unknown kinds stay human, which keeps
 * the stricter user-first shape for anything this plugin does not recognize.
 */
export function isInjectedHostSource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (isTurnMemorySource(source)) return true;
  if (INJECTED_HOST_KINDS.has(source.kind)) return true;
  return typeof source.form === 'string' && INJECTED_HOST_FORMS.has(source.form);
}

/**
 * Whether one node is host context that carries no conversation-specific information.
 *
 * `turn-memory-compression` checkpoints are memory and stay in; continuation notices and
 * hints are bookkeeping and go. Lifecycle copies are resolved by the caller first, so a
 * copied human message keeps its place.
 */
export function isReSuppliedHostContext(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (isTurnMemorySource(source)) {
    // A checkpoint is memory. The bundled 0.1.x `plugin` source wrote compressed turns in
    // that shape too, so it stays as well; only the notice-like markers are bookkeeping.
    return source.kind !== 'turn-memory-compression' && source.kind !== 'plugin';
  }
  if (RE_SUPPLIED_HOST_KINDS.has(source.kind)) return true;
  return typeof source.form === 'string' && RE_SUPPLIED_HOST_FORMS.has(source.form);
}

/**
 * Render the `origin` label of one message node for model-facing source listings.
 *
 * `human` names actual user intent, `host:<kind>` names harness bookkeeping, and
 * `plugin:<name>` names an earlier checkpoint or another plugin's message.
 */
export function describeEventOrigin(event: any, events: readonly any[]): string {
  const source = resolveLifecycleSource(event, events);
  if (source?.kind === 'model') {
    return 'model:' + String(source.provider ?? '?') + '/' + String(source.model ?? '?');
  }
  if (isHumanSource(source)) return 'human';
  const plugin = pluginSourceName(source);
  if (plugin !== undefined) return 'plugin:' + plugin;
  if (isInjectedHostSource(source)) return 'host:' + String(source.kind ?? 'message');
  if (event?.type === 'tool/result') return 'tool';
  return source?.kind === undefined ? 'unknown' : String(source.kind);
}
