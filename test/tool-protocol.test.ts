import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TurnNodeSnapshot } from '../lib/editor.ts';
import {
  describeProjectedToolProtocolIssue,
  projectedToolProtocolIssue,
  validateProjectedToolProtocol,
  withProjectedToolProtocolWarning,
} from '../lib/tool-protocol.ts';

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
    ], events), /structured tool result n2 has no retained structured call.*plain node r1.*range r1\.\.n2/s);
  });

  it('rejects retaining only the call', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    assert.throws(() => validateProjectedToolProtocol([
      node({ id: 'n1', landingSeqs: [1] }),
      node({ id: 'r1', changed: true, kind: 'assistant', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
    ], events), /structured tool call n1 has no retained structured result.*plain node r1.*range n1\.\.r1/s);
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

  it('returns an actionable issue before final validation', () => {
    const events = [undefined, callEvent('call-1'), resultEvent('call-1')];
    const issue = projectedToolProtocolIssue([
      node({ id: 'r1', changed: true, landingSeqs: [1], landingIndexes: [1] }),
      node({ id: 'n2', kind: 'tool', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
    ], events);
    assert.deepEqual(issue, {
      kind: 'missing-call',
      nodeId: 'n2',
      relatedNodeId: 'r1',
      range: 'r1..n2',
    });
    assert.match(describeProjectedToolProtocolIssue(issue!), /kind="tool".*cannot recreate a removed call/);
    assert.match(
      withProjectedToolProtocolWarning('created=r1', [
        node({ id: 'r1', changed: true, landingSeqs: [1], landingIndexes: [1] }),
        node({ id: 'n2', kind: 'tool', landingSeqs: [2], landingIndexes: [2], sourceSeqs: [2], sourceIndexes: [2] }),
      ], events),
      /^created=r1\n\nprotocol-warning:.*range r1\.\.n2/s,
    );
    assert.equal(withProjectedToolProtocolWarning('created=r1', [
      node({ id: 'r1', changed: true, landingSeqs: [1, 2], landingIndexes: [1, 2], sourceSeqs: [1, 2], sourceIndexes: [1, 2] }),
    ], events), 'created=r1');
  });
});
