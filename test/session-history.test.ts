import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createReadSessionHistoryTool,
  renderRawSessionContent,
  renderSessionHistoryCatalog,
  renderSessionTurnHistory,
} from '../lib/session-history.ts';

function fixture(): any {
  const events: any[] = [
    { seq: 0, type: 'session' },
    { seq: 1, type: 'turn/start', data: { turn: 7 } },
    {
      seq: 2,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'build the transfer' }] },
    },
    {
      seq: 3,
      type: 'assistant/message',
      data: {
        turn: 7,
        message: {
          source: { kind: 'model', provider: 'fixture', model: 'reasoner' },
          content: [
            { type: 'reasoning', text: 'derive a=94 and preserve the LOI edge case' },
            { type: 'text', text: 'ready to implement' },
          ],
        },
      },
    },
    {
      seq: 4,
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'probe passed' }] }] } },
    },
    { seq: 5, type: 'turn/end', data: { turn: 7 } },
    {
      seq: 6,
      type: 'assistant/message',
      data: {
        source: { kind: 'plugin', plugin: 'turn-memory', phase: 'compression', turn: 7 },
        message: { content: [{ type: 'text', text: 'compressed memory' }] },
      },
    },
  ];
  return { id: 'session-fixture', header: {}, events, surface: { nodes: [2, 6] } };
}

describe('append-only session history fallback', () => {
  test('renders reasoning in original block order and lists compressed turns', () => {
    assert.equal(renderRawSessionContent([
      { type: 'text', text: 'before' },
      { type: 'reasoning', text: 'hidden detail' },
      { type: 'text', text: 'after' },
    ]), 'before\n<reasoning-block index="1" chars="13">\nhidden detail\n</reasoning-block>\nafter');

    const catalog = renderSessionHistoryCatalog(fixture());
    assert.match(catalog, /turn=7/);
    assert.match(catalog, /reasoning-chars=42/);
    assert.match(catalog, /memory=compressed/);
    assert.match(catalog, /build the transfer/);

    const turn = renderSessionTurnHistory(fixture(), 7);
    assert.match(turn, /source="append-only-original"/);
    assert.match(turn, /seq="3" kind="assistant" origin="model:fixture\/reasoner" surface="shadowed"/);
    assert.match(turn, /derive a=94 and preserve the LOI edge case/);
    assert.match(turn, /probe passed/);
    assert.doesNotMatch(turn, /compressed memory/);
  });

  test('uses one tool for catalog discovery and bounded exact-turn paging', async () => {
    const session = fixture();
    const tool: any = createReadSessionHistoryTool({ maxReadChars: 80, catalogTurns: 12 });
    const exec = { agent: { session } };

    const catalog = await tool.execute({}, exec);
    assert.match(catalog, /Use turn=<n>/);

    const first = await tool.execute({ turn: 7 }, exec);
    assert.match(first, /session-history-excerpt/);
    assert.match(first, /Continue with turn=7 offset=80/);
    const second = await tool.execute({ turn: 7, offset: 80 }, exec);
    assert.match(second, /chars="80\.\./);

    await assert.rejects(() => tool.execute({ offset: 1 }, exec), /offset requires turn/);
    await assert.rejects(() => tool.execute({ turn: 7, limit: 2 }, exec), /catalog-only/);
    await assert.rejects(() => tool.execute({ turn: 99 }, exec), /was not found/);
  });
});
