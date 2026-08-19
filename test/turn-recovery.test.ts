import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendTurnMarkerCopy,
  completedTurnEnds,
  compressedTurnNumbers,
  findCompletedTurnEnd,
  pendingTurnNumbers,
  turnHasUnrewrittenReasoning,
  turnSurfaceSeqs,
  turnCompressionBypassReason,
} from '../lib/turn-recovery.ts';
import { Session, foldSurface } from '@deepseek-ai/dsh-session';

describe('turn recovery event scans', () => {
  it('bypasses structurally impossible turns with no assistant transcript', () => {
    assert.equal(turnCompressionBypassReason([
      { kind: 'user', content: 'request whose first model call failed' },
    ]), 'completed turn has no non-empty assistant transcript');
    assert.equal(turnCompressionBypassReason([
      { kind: 'user', content: 'request' },
      { kind: 'assistant', content: '   ' },
    ]), 'completed turn has no non-empty assistant transcript');
    assert.equal(turnCompressionBypassReason([
      { kind: 'user', content: 'request' },
      { kind: 'assistant', content: 'partial work worth compressing' },
    ]), undefined);
    assert.equal(turnCompressionBypassReason([
      { kind: 'user', content: 'request' },
      { kind: 'assistant', content: '<raw-reasoning blocks="1" chars="85603" />' },
    ]), undefined);
  });

  it('deduplicates completed turns by their latest end and preserves event order', () => {
    const session = {
      events: [
        undefined,
        { seq: 1, type: 'turn/end', data: { turn: 2 } },
        { seq: 2, type: 'turn/end', data: { turn: 1 } },
        { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'repaired' } } },
        { seq: 4, type: 'turn/end', data: { turn: '3' } },
      ],
    };

    assert.deepEqual(completedTurnEnds(session).map((event) => event.seq), [2, 3]);
    assert.equal(findCompletedTurnEnd(session, 2)?.seq, 3);
    assert.equal(findCompletedTurnEnd(session, 3), undefined);
  });

  it('recognizes durable turn-memory landings outside the current surface', () => {
    const session = {
      surface: { nodes: [4] },
      events: [
        undefined,
        { seq: 1, type: 'turn/end', data: { turn: 1 } },
        {
          seq: 2,
          type: 'assistant/message',
          data: { source: { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 1 } },
        },
        { seq: 3, type: 'turn/end', data: { turn: 2 } },
        {
          seq: 4,
          type: 'user/message',
          data: { source: { kind: 'plugin', plugin: 'compact', phase: 'compression', turn: 2 } },
        },
      ],
    };

    assert.deepEqual([...compressedTurnNumbers(session)], [1]);
  });

  it('recovers only explicitly pending turns instead of backfilling pre-plugin history', () => {
    const session = {
      events: [
        undefined,
        { seq: 1, type: 'turn/end', data: { turn: 1 } },
        { seq: 2, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'turn-memory', phase: 'pending', turn: 2 } } },
        { seq: 3, type: 'turn/end', data: { turn: 2 } },
        { seq: 4, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'turn-memory', phase: 'pending', turn: 3 } } },
        { seq: 5, type: 'assistant/message', data: { source: { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 3 } } },
      ],
    };

    assert.deepEqual([...pendingTurnNumbers(session)], [2]);
    assert.equal(pendingTurnNumbers({ events: session.events.slice(0, 2) }).size, 0,
      'an old completed turn with no plugin marker is outside the recovery boundary');
  });

  it('detects legacy reasoning no-ops and includes their late marker in the rewrite range', () => {
    const session = {
      surface: { nodes: [5, 3, 6] },
      events: [
        undefined,
        { seq: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'original' }] } },
        {
          seq: 3,
          type: 'assistant/message',
          data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'important thought' }] } },
        },
        { seq: 4, type: 'turn/end', data: { turn: 1 } },
        {
          seq: 5,
          type: 'user/message',
          data: { source: { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 1 } },
        },
        { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: 'later turn' }] } },
      ],
    };

    assert.equal(turnHasUnrewrittenReasoning(session, 1), true);
    assert.deepEqual(turnSurfaceSeqs(session, 1, 1, 4), [5, 3]);
    session.surface.nodes = [5, 6];
    assert.equal(turnHasUnrewrittenReasoning(session, 1), false);
  });

  it('persists a semantic no-op as an idempotence marker without changing transcript text', () => {
    const session = Session.create('turn-recovery-noop' as any);
    const user = session.append('user/message', {
      id: 'user-original' as any,
      role: 'user',
      content: [{ type: 'text', text: '已经很短' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });
    const assistant = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-original' as any,
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: '无需再压缩。' }],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [] });
    const marker = { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 1, mutations: 0 };

    const landed = appendTurnMarkerCopy(session, user, marker);

    assert.deepEqual(session.surface.nodes, [landed.seq, assistant.seq]);
    assert.deepEqual(foldSurface(session.events).nodes, [landed.seq, assistant.seq]);
    assert.deepEqual(session.deriveMessages().map((message) => message.content[0]), [
      { type: 'text', text: '已经很短' },
      { type: 'text', text: '无需再压缩。' },
    ]);
    assert.deepEqual([...compressedTurnNumbers(session)], [1]);

    const cold = Session.create('turn-recovery-noop-cold' as any, session.events);
    assert.deepEqual(cold.surface.nodes, [landed.seq, assistant.seq]);
    assert.deepEqual(cold.deriveMessages().map((message) => message.content[0]), session.deriveMessages().map((message) => message.content[0]));
    assert.deepEqual([...compressedTurnNumbers(cold)], [1]);
  });
});
