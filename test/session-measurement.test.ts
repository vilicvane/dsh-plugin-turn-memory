import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { measureSessionForCompaction } from '../lib/session-compaction.ts';

function replacementEvent(seq: number): any {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-' + seq,
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'compressed assistant memory' }],
      },
      source: { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 1 },
    },
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  };
}

describe('measureSessionForCompaction', () => {
  test('reprices the canonical surface after token-meter rejects a turn-memory assistant replacement', () => {
    const event = replacementEvent(2);
    const session = {
      events: [undefined, undefined, event],
      surface: { nodes: [2] },
      requestHeader: () => ({ system: 'system', tools: [] }),
    };
    const meter = {
      measure: () => { throw new Error('token meter: assistant/message at seq 2 has no matching step/start event'); },
      estimateMessage: (message: any) => message.content[0].text.length + 4,
    };

    const result = measureSessionForCompaction(meter, session);

    assert.equal(result.fallbackSeq, 2);
    assert.deepEqual(result.measurement.nodes, [{ seq: 2, tokens: 31 }]);
    assert.equal(result.measurement.surfaceTokens, 31);
    assert.equal(result.measurement.totalTokens, 37);
  });

  test('does not hide unrelated token-meter failures', () => {
    const event = replacementEvent(2);
    event.data.source.plugin = 'another-plugin';
    const expected = new Error('token meter: assistant/message at seq 2 has no matching step/start event');
    const session = { events: [undefined, undefined, event], surface: { nodes: [2] } };
    const meter = { measure: () => { throw expected; } };

    assert.throws(() => measureSessionForCompaction(meter, session), (error) => error === expected);
  });
});
