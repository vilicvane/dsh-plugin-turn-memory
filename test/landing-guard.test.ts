import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  appendLanding,
  assertLandingEventSafe,
  assertLandingEventsSafe,
  openTurnCoordinates,
} from '../lib/landing-guard.ts';

/**
 * Minimal session double: `append` records the event and applies a positional
 * replacement to `surface.nodes` exactly like the runtime handle does. The third
 * argument is the runtime's `{ surfaceOp, sourceEventSeqs }` intent object.
 */
function fixtureSession(): any {
  const events: any[] = [];
  const surface = { nodes: [] as number[] };
  const append = (type: string, data: any, options?: { surfaceOp?: any; sourceEventSeqs?: number[] }): any => {
    const surfaceOp = options?.surfaceOp;
    const event: any = {
      seq: events.length,
      type,
      data,
      ...(options?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    };
    events.push(event);
    if (surfaceOp === 'append') {
      surface.nodes.push(event.seq);
    } else if (surfaceOp !== null && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
      const first = surfaceOp.startSeq ?? surfaceOp.start;
      const last = surfaceOp.endSeq ?? surfaceOp.end;
      const firstIndex = surface.nodes.indexOf(first);
      const lastIndex = surface.nodes.indexOf(last);
      if (firstIndex < 0 || lastIndex < firstIndex) throw new Error('invalid replace surfaceOp');
      surface.nodes.splice(firstIndex, lastIndex - firstIndex + 1, event.seq);
    }
    return event;
  };
  return {
    events,
    snapshotEvents: () => events,
    eventAt: (seq: number) => events[seq],
    surface,
    header: {},
    append,
  };
}

function userMessage(text: string): any {
  return { id: 'm-' + text, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function completedTurn(session: any): any {
  session.append('turn/start', { turn: 1 });
  session.append('user/message', userMessage('question'), { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

const closed = { turn: null, step: null };

describe('open turn coordinates', () => {
  test('starts closed and follows turn and step lifecycle', () => {
    assert.deepEqual(openTurnCoordinates([]), { turn: null, step: null });

    const turnOnly = [{ type: 'turn/start', data: { turn: 3 } }];
    assert.deepEqual(openTurnCoordinates(turnOnly), { turn: 3, step: null });

    const withStep = [...turnOnly, { type: 'step/start', data: { turn: 3, step: 2 } }];
    assert.deepEqual(openTurnCoordinates(withStep), { turn: 3, step: 2 });

    const afterStep = [...withStep, { type: 'step/end', data: { turn: 3, step: 2 } }];
    assert.deepEqual(openTurnCoordinates(afterStep), { turn: 3, step: null });

    const afterTurn = [...afterStep, { type: 'turn/end', data: { turn: 3 } }];
    assert.deepEqual(openTurnCoordinates(afterTurn), { turn: null, step: null });
  });

  test('a second turn replaces the first instead of reopening it', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { turn: 2, step: 1 } },
    ];
    assert.deepEqual(openTurnCoordinates(events), { turn: 2, step: 1 });
  });

  test('ignores unrelated events and non-lifecycle messages', () => {
    const events = [
      { type: 'session/created', data: {} },
      { type: 'user/message', data: userMessage('hi') },
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'assistant/message', data: { turn: 4, step: 1 } },
      { type: 'step/start', data: { turn: 4, step: 1 } },
    ];
    assert.deepEqual(openTurnCoordinates(events), { turn: 4, step: 1 });
  });
});

describe('landing event safety', () => {
  test('refuses step-gated events after turn/end', () => {
    for (const type of ['assistant/message', 'tool/call', 'assistant/attempt', 'system/message', 'developer/message']) {
      assert.throws(
        () => assertLandingEventSafe(type, { turn: 1, step: 1 }, { op: 'replace', startSeq: 0, endSeq: 0 }, closed),
        /outside an open turn\/step/,
        type,
      );
    }
    assert.throws(
      () => assertLandingEventSafe('tool/result', { turn: 1, step: 1 }, 'append', closed),
      /outside an open turn\/step/,
    );
  });

  test('refuses turn-gated events after turn/end', () => {
    for (const type of ['tool/result', 'request/header', 'request/context', 'llm/retry']) {
      assert.throws(
        () => assertLandingEventSafe(type, {}, { op: 'replace', startSeq: 0, endSeq: 0 }, closed),
        /outside an open turn$/,
        type,
      );
    }
  });

  test('admits user/message wherever it lands', () => {
    assert.doesNotThrow(() => assertLandingEventSafe('user/message', { role: 'user' }, { op: 'replace', startSeq: 0, endSeq: 0 }, closed));
    assert.doesNotThrow(() => assertLandingEventSafe('user/message', { role: 'user' }, { op: 'replace', startSeq: 0, endSeq: 0 }, { turn: 1, step: 2 }));
  });

  test('requires matching coordinates when a step is open', () => {
    const open = { turn: 3, step: 2 };
    assert.doesNotThrow(() => assertLandingEventSafe('assistant/message', { turn: 3, step: 2 }, 'append', open));
    assert.doesNotThrow(() => assertLandingEventSafe('tool/call', { turn: 3, step: 2 }, { op: 'replace', startSeq: 1, endSeq: 1 }, open));
    assert.doesNotThrow(() => assertLandingEventSafe('tool/result', { turn: 3, step: 2 }, 'append', open));
    assert.throws(
      () => assertLandingEventSafe('assistant/message', { turn: 2, step: 2 }, 'append', open),
      /outside an open turn\/step/,
    );
    assert.throws(
      () => assertLandingEventSafe('assistant/message', { turn: 3, step: 3 }, 'append', open),
      /outside an open turn\/step/,
    );
  });

  test('admits a tool/result replacement with only an open turn', () => {
    assert.doesNotThrow(() => assertLandingEventSafe('tool/result', { turn: 3, step: 9 }, { op: 'replace', startSeq: 1, endSeq: 1 }, { turn: 3, step: null }));
    assert.throws(
      () => assertLandingEventSafe('assistant/message', { turn: 3, step: 1 }, 'append', { turn: 3, step: null }),
      /outside an open turn\/step/,
    );
  });

  test('fails closed on non-numeric open coordinates', () => {
    assert.throws(
      () => assertLandingEventSafe('assistant/message', { turn: 3, step: 1 }, 'append', { turn: Number.NaN, step: 1 }),
      /outside an open turn\/step/,
    );
  });
});

describe('appendLanding', () => {
  test('refuses an illegal append without writing anything', () => {
    const session = completedTurn(fixtureSession());
    const before = session.events.length;
    assert.throws(
      () => appendLanding(session, 'assistant/message', { turn: 1, step: 1 }, 1, 1, [1]),
      /outside an open turn\/step/,
    );
    assert.equal(session.events.length, before);
    assert.deepEqual(session.surface.nodes, [1, 3]);
  });

  test('appends a user/message replacement', () => {
    const session = completedTurn(fixtureSession());
    const event = appendLanding(session, 'user/message', userMessage('checkpoint'), 1, 1, [1]);
    assert.equal(event.type, 'user/message');
    assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 });
    assert.deepEqual(event.sourceEventSeqs, [1]);
    assert.deepEqual(session.surface.nodes, [event.seq, 3]);
  });
});

describe('landing post-condition', () => {
  test('accepts a landing tail and rejects a late assistant append', () => {
    const session = completedTurn(fixtureSession());
    const appendedFrom = session.events.length;
    appendLanding(session, 'user/message', userMessage('checkpoint'), 1, 1, [1]);
    assert.doesNotThrow(() => assertLandingEventsSafe(session, appendedFrom));

    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'rogue', role: 'assistant', content: [{ type: 'text', text: 'late' }], source: { kind: 'model', provider: 'test', model: 'test' } },
    }, { surfaceOp: 'append' });
    assert.throws(() => assertLandingEventsSafe(session, appendedFrom), /outside an open turn\/step/);
  });

  test('ignores events recorded before the landing window', () => {
    const session = completedTurn(fixtureSession());
    const appendedFrom = session.events.length;
    assert.doesNotThrow(() => assertLandingEventsSafe(session, appendedFrom));
    appendLanding(session, 'user/message', userMessage('checkpoint'), 1, 1, [1]);
    assert.doesNotThrow(() => assertLandingEventsSafe(session, appendedFrom));
  });
});
