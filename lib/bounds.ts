/**
 * Pure span-boundary logic for compact_turn in-turn mode, extracted from the
 * plugin entry so the boundary cases can be unit-tested without booting the
 * plugin. Surface nodes are a position-ordered array of seqs; the events
 * array is seq-indexed (holes allowed outside the walked range; the walked
 * range itself must be complete).
 */

/** Structural view of a session log event (live seq === index). */
export interface SessionEventLike {
  type: string;
  seq: number;
  data?: Record<string, any>;
}

export interface SpanBoundaries {
  /** Position of the open turn first surface node (its user message). */
  spanStart: number;
  /** Seq of that first node. */
  spanStartSeq: number;
  /** Seq of the first node INSIDE the compacted range. */
  startSeq: number;
  /** Position of the current step assistant message (right edge of the cut, kept verbatim). */
  assistantIdx: number;
  /** Seq of the last node INSIDE the compacted range. */
  endSeq: number;
  /** Number of surface nodes inside the compacted range. */
  nodeCount: number;
}

export type SpanBoundaryError = 'nothing-to-compact' | 'no-assistant-content';

export type SpanBoundaryResult =
  | { ok: true; bounds: SpanBoundaries }
  | { ok: false; error: SpanBoundaryError };

export function computeSpanBoundaries(
  nodes: readonly number[],
  events: readonly (SessionEventLike | undefined)[],
  turnStartSeq: number,
): SpanBoundaryResult {
  // The open turn first surface node (its user message) is the node with the
  // SMALLEST seq above the turn/start event — not the first such node in
  // position order. Earlier turns replacement checkpoints sit before it in
  // position order while carrying seqs above the turn start (a replacement
  // lands after the turn ends, so its seq exceeds the seqs of the kept nodes
  // that follow it), and a positional findIndex stops one node early on such
  // a checkpoint — folding the user message into the compacted range. The
  // user message must stay verbatim, so pick the smallest seq instead.
  let spanStart = -1;
  let spanStartSeq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index];
    if (seq > turnStartSeq && seq < spanStartSeq) {
      spanStartSeq = seq;
      spanStart = index;
    }
  }
  if (spanStart < 0) return { ok: false, error: 'nothing-to-compact' };
  // The current step assistant message (the last assistant node) carries
  // open tool calls, so it and everything after stay verbatim.
  let assistantIdx = -1;
  for (let index = nodes.length - 1; index > spanStart; index -= 1) {
    if (events[nodes[index]]?.type === 'assistant/message') {
      assistantIdx = index;
      break;
    }
  }
  if (assistantIdx < 0) return { ok: false, error: 'no-assistant-content' };
  if (assistantIdx <= spanStart + 1) return { ok: false, error: 'nothing-to-compact' };
  return {
    ok: true,
    bounds: {
      spanStart,
      spanStartSeq,
      startSeq: nodes[spanStart + 1],
      assistantIdx,
      endSeq: nodes[assistantIdx - 1],
      nodeCount: assistantIdx - spanStart - 1,
    },
  };
}

export interface WalkRange {
  walkStart: number;
  walkEnd: number;
}

export function computeWalkRange(nodes: readonly number[], bounds: SpanBoundaries): WalkRange {
  // The slice endpoints are surface positions, but the pairing walk needs
  // log positions: after an earlier in-turn checkpoint, surface order and
  // seq order diverge (the checkpoint seq exceeds the seqs of the kept step
  // that follows it in surface order), so walking [startSeq, endSeq] as a
  // raw seq interval would split the kept step own tool pair. Walk the
  // slice seq span instead.
  let walkStart = bounds.startSeq;
  let walkEnd = bounds.endSeq;
  for (let index = bounds.spanStart + 1; index < bounds.assistantIdx; index += 1) {
    const seq = nodes[index];
    if (seq < walkStart) walkStart = seq;
    if (seq > walkEnd) walkEnd = seq;
  }
  return { walkStart, walkEnd };
}

export function checkToolPairBalance(
  events: readonly (SessionEventLike | undefined)[],
  walkStart: number,
  walkEnd: number,
): string | null {
  const openCalls = new Set<string>();
  for (let seq = walkStart; seq <= walkEnd; seq += 1) {
    const event = events[seq];
    if (event === undefined) return 'compact_turn: session events incomplete; compact later';
    if (event.type === 'tool/call') {
      openCalls.add(String(event.data?.callId));
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.content?.[0]?.toolCallId;
      if (callId === undefined || !openCalls.has(String(callId))) {
        return 'compact_turn: the cut would cross an open tool pair; compact later';
      }
      openCalls.delete(String(callId));
    }
  }
  if (openCalls.size > 0) return 'compact_turn: the cut would leave an open tool call; compact later';
  return null;
}

/** Chars of the text blocks one message-shaped record carries. */
function blocksTextSize(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') total += record.text.length;
  }
  return total;
}

/** Chars of model-visible text one folded event contributes. */
export function eventTextSize(event: SessionEventLike | undefined): number {
  if (event === undefined) return 0;
  if (event.type === 'user/message') return blocksTextSize(event.data?.content);
  if (event.type === 'assistant/message') return blocksTextSize(event.data?.message?.content);
  if (event.type === 'tool/result') return blocksTextSize(event.data?.message?.content?.[0]?.content);
  return 0;
}

/** Total chars of the folded surface nodes, for the shrink check. */
export function foldedSpanSize(
  events: readonly (SessionEventLike | undefined)[],
  seqs: readonly number[],
): number {
  let total = 0;
  for (const seq of seqs) total += eventTextSize(events[seq]);
  return total;
}

/**
 * Chars of the span's opening node when it is this turn's earlier in-turn
 * checkpoint (a user/message carrying the turn-memory plugin source marker).
 * The append rule copies that fragment verbatim into every new checkpoint, so
 * the shrink check cancels it out on both sides and compares only the new
 * fragments against the new content.
 */
export function carriedCheckpointChars(
  events: readonly (SessionEventLike | undefined)[],
  seqs: readonly number[],
): number {
  if (seqs.length === 0) return 0;
  const event = events[seqs[0]];
  if (event?.type !== 'user/message') return 0;
  const source = event.data?.source as { kind?: unknown; plugin?: unknown } | undefined;
  if (source?.kind !== 'plugin' || source.plugin !== 'turn-memory') return 0;
  return eventTextSize(event);
}

/**
 * Shrink guard for the self-fold: the checkpoint must be strictly smaller
 * than the folded span (measured in chars of model-visible text), otherwise
 * the whole fold is refused — the same contract the compaction backend used
 * to enforce for the transaction. When the span opens with an earlier
 * checkpoint of this same turn (append mode), the comparison is incremental:
 * the copied fragment cancels out and only the new fragments must beat the
 * new content — tightening already-summarized parts is neither required nor
 * accepted.
 */
export function shrinkCheckError(
  events: readonly (SessionEventLike | undefined)[],
  seqs: readonly number[],
  checkpointChars: number,
): string | null {
  const folded = foldedSpanSize(events, seqs);
  const carried = carriedCheckpointChars(events, seqs);
  if (carried > 0) {
    if (checkpointChars < carried) {
      return 'compact_turn: the checkpoint must begin with the previous checkpoint copied verbatim (' + carried + ' chars) — do not rewrite or shrink already-summarized fragments';
    }
    const foldedNew = folded - carried;
    const checkpointNew = checkpointChars - carried;
    if (checkpointNew < foldedNew) return null;
    return 'compact_turn: the new fragments (' + checkpointNew + ' chars) are not smaller than the new span content (' + foldedNew + ' chars); tighten only the NEW content — the copied checkpoint cancels out on both sides — or compact a smaller range';
  }
  if (checkpointChars < folded) return null;
  return 'compact_turn: the checkpoint (' + checkpointChars + ' chars) is not smaller than the folded span (' + folded + ' chars); write a tighter summary or compact a smaller range';
}