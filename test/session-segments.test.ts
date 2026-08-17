import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildSessionSegments, readSessionSourceNodes, renderSegmentNodeDirectory, renderSegmentSource } from '../lib/session-segments.ts';
import { selectSessionCompactionRange } from '../lib/session-compaction.ts';

function event(type: string, seq: number, data: any = {}): any {
  return { type, seq, data };
}

describe('session segmentation', () => {
  test('packs complete turns without splitting an oversized turn', () => {
    const events = [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }),
      event('assistant/message', 2, { turn: 1, message: { content: [{ type: 'text', text: 'first answer' }] } }),
      event('turn/end', 3, { turn: 1 }),
      event('turn/start', 4, { turn: 2 }),
      event('user/message', 5, { content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }),
      event('assistant/message', 6, { turn: 2, message: { content: [{ type: 'text', text: 'second answer' }] } }),
      event('turn/end', 7, { turn: 2 }),
    ];
    const session = { events };
    const segments = buildSessionSegments(session, [
      { seq: 1, tokens: 7 },
      { seq: 2, tokens: 7 },
      { seq: 5, tokens: 3 },
      { seq: 6, tokens: 3 },
    ], 10);
    assert.deepEqual(segments.map((segment) => ({ seqs: segment.seqs, tokens: segment.tokens, turns: segment.turns })), [
      { seqs: [1, 2], tokens: 14, turns: [1] },
      { seqs: [5, 6], tokens: 6, turns: [2] },
    ]);
    assert.match(renderSegmentNodeDirectory(session, segments[0]), /s1n1 \| user \| origin=human \| turn=1/);
    assert.match(renderSegmentSource(session, segments[0]), /first answer/);
    const selected = readSessionSourceNodes(session, segments, [
      { start: 's1n2' },
      { start: 's2n1', end: 's2n2' },
    ], 10_000);
    assert.doesNotMatch(selected, /first question/);
    assert.match(selected, /first answer/);
    assert.match(selected, /second question/);
    assert.match(selected, /second answer/);
  });

  test('recognizes post-turn turn-memory replacements as their original turn', () => {
    const events: any[] = [];
    events[0] = event('turn/start', 0, { turn: 1 });
    events[1] = event('user/message', 1, { content: [{ type: 'text', text: 'raw' }], source: { kind: 'user' } });
    events[2] = event('turn/end', 2, { turn: 1 });
    events[3] = event('user/message', 3, {
      content: [{ type: 'text', text: 'compressed user' }],
      source: { kind: 'plugin', plugin: 'turn-memory', turn: 1 },
    });
    events[4] = event('assistant/message', 4, {
      message: { content: [{ type: 'text', text: 'compressed assistant' }] },
      source: { kind: 'plugin', plugin: 'turn-memory', turn: 1 },
    });
    const segments = buildSessionSegments({ events }, [{ seq: 3, tokens: 2 }, { seq: 4, tokens: 2 }], 100);
    assert.deepEqual(segments[0].turns, [1]);
    assert.deepEqual(segments[0].seqs, [3, 4]);
  });

  test('range selection excludes the current unfinished turn and includes a late prior-turn replacement', () => {
    const events: any[] = [];
    events[0] = event('turn/start', 0, { turn: 1 });
    events[1] = event('user/message', 1, { content: [{ type: 'text', text: 'old user' }], source: { kind: 'user' } });
    events[2] = event('assistant/message', 2, { turn: 1, message: { content: [{ type: 'text', text: 'old assistant' }] } });
    events[3] = event('turn/end', 3, { turn: 1 });
    events[4] = event('turn/start', 4, { turn: 2 });
    events[5] = event('user/message', 5, { content: [{ type: 'text', text: 'current user' }], source: { kind: 'user' } });
    events[6] = event('user/message', 6, {
      content: [{ type: 'text', text: 'late rewrite of turn one' }],
      source: { kind: 'plugin', plugin: 'turn-memory', turn: 1 },
    });
    const session = { events, surface: { nodes: [6, 5], replaceGeneration: 1 } };
    const range = selectSessionCompactionRange(session, { nodes: [{ seq: 6, tokens: 5 }, { seq: 5, tokens: 2 }] }, 0);
    assert.deepEqual(range, { start: 6, end: 6 });
  });

  test('range selection moves a node-level retention cut back to a complete-turn boundary', () => {
    const events = [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { content: [{ type: 'text', text: 'u1' }], source: { kind: 'user' } }),
      event('assistant/message', 2, { turn: 1, message: { content: [{ type: 'text', text: 'a1' }] } }),
      event('turn/end', 3, { turn: 1 }),
      event('turn/start', 4, { turn: 2 }),
      event('user/message', 5, { content: [{ type: 'text', text: 'u2' }], source: { kind: 'user' } }),
      event('assistant/message', 6, { turn: 2, message: { content: [{ type: 'text', text: 'a2' }] } }),
      event('turn/end', 7, { turn: 2 }),
    ];
    const session = { events, surface: { nodes: [1, 2, 5, 6], replaceGeneration: 0 } };
    const range = selectSessionCompactionRange(session, { nodes: [
      { seq: 1, tokens: 2 }, { seq: 2, tokens: 2 }, { seq: 5, tokens: 2 }, { seq: 6, tokens: 2 },
    ] }, 0);
    assert.deepEqual(range, { start: 1, end: 2 });
  });
});
