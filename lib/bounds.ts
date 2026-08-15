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