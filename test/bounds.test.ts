import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkToolPairBalance, computeSpanBoundaries, computeWalkRange, eventTextSize, foldedSpanSize, shrinkCheckError, type SessionEventLike } from '../lib/bounds.ts';

const ev = (seq: number, type: string, data: Record<string, any> = {}): SessionEventLike => ({ seq, type, data });

/** Dense seq-indexed array from a sparse event list. */
function eventsOf(...list: SessionEventLike[]): (SessionEventLike | undefined)[] {
  const arr: (SessionEventLike | undefined)[] = [];
  for (const e of list) arr[e.seq] = e;
  return arr;
}

describe('computeSpanBoundaries', () => {
  it('first compaction with no prior checkpoints: range starts right after the user message', () => {
    // surface: user message (8), runtime snapshot (9), work (12,15), current step (18)
    const nodes = [8, 9, 12, 15, 18];
    const events = eventsOf(
      ev(8, 'user/message'),
      ev(9, 'user/message'),
      ev(12, 'assistant/message'),
      ev(13, 'tool/result'),
      ev(15, 'assistant/message'),
      ev(18, 'assistant/message'),
    );
    const r = computeSpanBoundaries(nodes, events, 7);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.bounds.spanStart, 0);
    assert.equal(r.bounds.spanStartSeq, 8);
    assert.equal(r.bounds.startSeq, 9);
    assert.equal(r.bounds.assistantIdx, 4);
    assert.equal(r.bounds.endSeq, 15);
    assert.equal(r.bounds.nodeCount, 3);
  });

  it('REGRESSION: prior replacement checkpoints with larger seqs must not swallow the user message', () => {
    // Mirrors the real failure: turn summaries of turns 1-8 carry seqs far
    // above the open turn start (308406) and sit before the user message
    // (308409) in position order. The old positional findIndex stopped on
    // 323138 and set startSeq = nodes[spanStart+1] = 308409 — the user
    // message itself, folded into the range.
    const nodes = [41277, 43969, 48818, 203339, 211106, 269937, 323138, 308409, 308410, 308415, 308418, 308422, 308426, 308430];
    const events = eventsOf(
      ev(308409, 'user/message'),
      ev(308410, 'user/message'),
      ev(308415, 'assistant/message'),
      ev(308417, 'tool/call', { callId: 'c1' }),
      ev(308418, 'tool/result', { message: { content: [{ toolCallId: 'c1', content: [] }] } }),
      ev(308422, 'assistant/message'),
      ev(308425, 'tool/result', { message: { content: [{ toolCallId: 'c2', content: [] }] } }),
      ev(308426, 'assistant/message'),
      ev(308430, 'assistant/message'),
    );
    const r = computeSpanBoundaries(nodes, events, 308406);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.bounds.spanStart, 7, 'spanStart must be the user message position, not the turn-8 checkpoint');
    assert.equal(r.bounds.spanStartSeq, 308409, 'user message seq');
    assert.equal(r.bounds.startSeq, 308410, 'the runtime snapshot right after the user message');
    assert.equal(r.bounds.assistantIdx, 13);
    assert.equal(r.bounds.endSeq, 308426);
    assert.equal(r.bounds.nodeCount, 5);
  });

  it('keeps the current step verbatim even when tool results trail it', () => {
    const nodes = [8, 9, 12, 15, 18, 19];
    const events = eventsOf(
      ev(8, 'user/message'),
      ev(9, 'user/message'),
      ev(12, 'assistant/message'),
      ev(13, 'tool/result'),
      ev(15, 'assistant/message'),
      ev(18, 'assistant/message'),
      ev(19, 'tool/result'),
    );
    const r = computeSpanBoundaries(nodes, events, 7);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.bounds.assistantIdx, 4, 'last assistant node is the current step message');
    assert.equal(r.bounds.endSeq, 15);
    assert.equal(r.bounds.nodeCount, 3);
  });

  it('nothing-to-compact when no surface node follows the turn start', () => {
    const r = computeSpanBoundaries([323138], eventsOf(ev(323138, 'user/message')), 400000);
    assert.deepEqual(r, { ok: false, error: 'nothing-to-compact' });
  });

  it('no-assistant-content when no assistant node follows the user message', () => {
    const r = computeSpanBoundaries([10, 11], eventsOf(ev(10, 'user/message'), ev(11, 'user/message')), 9);
    assert.deepEqual(r, { ok: false, error: 'no-assistant-content' });
  });

  it('nothing-to-compact when the only assistant node is the current step right after the user message', () => {
    const r = computeSpanBoundaries([10, 11], eventsOf(ev(10, 'user/message'), ev(11, 'assistant/message')), 9);
    assert.deepEqual(r, { ok: false, error: 'nothing-to-compact' });
  });
});

describe('computeWalkRange', () => {
  it('expands the walk over the slice seq span when a checkpoint seq exceeds the kept step', () => {
    // An earlier in-turn checkpoint (999) sits inside the slice in position
    // order but carries a seq larger than the kept step that follows it.
    const nodes = [10, 11, 999, 12, 15, 20];
    const events = eventsOf(
      ev(10, 'user/message'),
      ev(11, 'user/message'),
      ev(999, 'user/message'),
      ev(12, 'assistant/message'),
      ev(15, 'assistant/message'),
      ev(20, 'assistant/message'),
    );
    const b = computeSpanBoundaries(nodes, events, 9);
    assert.ok(b.ok);
    if (!b.ok) return;
    const w = computeWalkRange(nodes, b.bounds);
    assert.equal(w.walkStart, 11);
    assert.equal(w.walkEnd, 999);
  });
});

describe('checkToolPairBalance', () => {
  it('balanced pairs inside the walk pass', () => {
    const events = eventsOf(
      ev(11, 'user/message'),
      ev(12, 'tool/call', { callId: 'c1' }),
      ev(13, 'tool/result', { message: { content: [{ toolCallId: 'c1', content: [] }] } }),
      ev(14, 'tool/call', { callId: 'c2' }),
      ev(15, 'tool/result', { message: { content: [{ toolCallId: 'c2', content: [] }] } }),
    );
    assert.equal(checkToolPairBalance(events, 11, 15), null);
  });

  it('an open call left at the end of the walk is rejected', () => {
    const events = eventsOf(
      ev(12, 'tool/call', { callId: 'c1' }),
      ev(13, 'assistant/message'),
      ev(14, 'assistant/message'),
      ev(15, 'assistant/message'),
    );
    assert.equal(checkToolPairBalance(events, 12, 15), 'compact_turn: the cut would leave an open tool call; compact later');
  });

  it('a result whose call lies outside the walk is rejected', () => {
    const events = eventsOf(
      ev(12, 'assistant/message'),
      ev(13, 'tool/result', { message: { content: [{ toolCallId: 'cX', content: [] }] } }),
      ev(14, 'assistant/message'),
    );
    assert.equal(checkToolPairBalance(events, 12, 14), 'compact_turn: the cut would cross an open tool pair; compact later');
  });

  it('a hole in the walked range is rejected', () => {
    const events = eventsOf(
      ev(12, 'assistant/message'),
      ev(15, 'assistant/message'),
    );
    assert.equal(checkToolPairBalance(events, 12, 15), 'compact_turn: session events incomplete; compact later');
  });
});

describe('eventTextSize', () => {
  it('counts user message text', () => {
    assert.equal(eventTextSize(ev(8, 'user/message', { content: [{ type: 'text', text: 'hello' }] })), 5);
  });

  it('counts assistant message text across blocks', () => {
    assert.equal(
      eventTextSize(ev(9, 'assistant/message', { message: { content: [{ type: 'text', text: 'ab' }, { type: 'tool-call', name: 'x', arguments: '{}' }] } })),
      2,
    );
  });

  it('counts tool result payload text', () => {
    assert.equal(
      eventTextSize(ev(10, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'abcde' }] }] } })),
      5,
    );
  });

  it('returns 0 for non-message events and holes', () => {
    assert.equal(eventTextSize(ev(11, 'tool/call', {})), 0);
    assert.equal(eventTextSize(undefined), 0);
  });
});

describe('foldedSpanSize and shrinkCheckError', () => {
  it('sums the folded nodes text', () => {
    const events = eventsOf(
      ev(9, 'user/message', { content: [{ type: 'text', text: 'aaaa' }] }),
      ev(10, 'assistant/message', { message: { content: [{ type: 'text', text: 'bbbbbb' }] } }),
    );
    assert.equal(foldedSpanSize(events, [9, 10]), 10);
  });

  it('a strictly smaller checkpoint passes', () => {
    const events = eventsOf(ev(9, 'user/message', { content: [{ type: 'text', text: 'aaaaaaaaaa' }] }));
    assert.equal(shrinkCheckError(events, [9], 9), null);
  });

  it('an equal or larger checkpoint is refused with the size detail', () => {
    const events = eventsOf(ev(9, 'user/message', { content: [{ type: 'text', text: 'aaaaa' }] }));
    const error = shrinkCheckError(events, [9], 5);
    assert.ok(error !== null && error.includes('not smaller than the folded span'));
    assert.ok(error.includes('5 chars'));
  });
});