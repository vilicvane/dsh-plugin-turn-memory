import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TurnNodeSnapshot } from '../lib/editor.ts';
import { validateProjectedToolProtocol } from '../lib/tool-protocol.ts';

const node = (overrides: Partial<TurnNodeSnapshot>): TurnNodeSnapshot => ({
  id: 'n1',
  kind: 'assistant',
  content: '',
  sourceSeqs: [1],
  sourceIndexes: [1],
  landingSeqs: [1],
  landingIndexes: [1],
  changed: false,
  ...overrides,
});

const callEvent = (id: string) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'tool-call', id, name: 'fixture', arguments: '{}' }] } },
});

const resultEvent = (id: string) => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId: id } } },
});

describe('validateProjectedToolProtocol', () => {
  it('accepts a retained call/result pair', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.doesNotThrow(() => validateProjectedToolProtocol([
      node({ id: 'n1', landingSeqs: [1] }),
      node({ id: 'n2', kind: 'tool', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
    ], events));
  });

  it('accepts jointly absorbing both sides into a plain assistant node', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.doesNotThrow(() => validateProjectedToolProtocol([
      node({ id: 'r1', changed: true, landingSeqs: [1, 2], landingIndexes: [1, 2], sourceSeqs: [1, 2], sourceIndexes: [1, 2] }),
    ], events));
  });

  it('rejects retaining only the result', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.throws(() => validateProjectedToolProtocol([
      node({ id: 'r1', changed: true, landingSeqs: [1], landingIndexes: [1] }),
      node({ id: 'n2', kind: 'tool', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
    ], events), /no preceding retained tool call/);
  });

  it('rejects retaining only the call', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.throws(() => validateProjectedToolProtocol([
      node({ id: 'n1', landingSeqs: [1] }),
      node({ id: 'r1', changed: true, kind: 'assistant', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
    ], events), /no retained tool result/);
  });

  it('accepts a one-to-one tool content rewrite paired with the original call', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.doesNotThrow(() => validateProjectedToolProtocol([
      node({ id: 'n1', landingSeqs: [1] }),
      node({
        id: 'r1',
        kind: 'tool',
        changed: true,
        landingSeqs: [2],
        landingIndexes: [2],
        sourceSeqs: [1, 2],
        sourceIndexes: [1, 2],
      }),
    ], events));
  });
});
