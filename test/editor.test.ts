import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TurnNodeEditor } from '../lib/editor.ts';

const editor = () => new TurnNodeEditor([
  { kind: 'user', content: 'initial request', sourceSeq: 10 },
  { kind: 'assistant', content: 'first response', sourceSeq: 11 },
  { kind: 'user', content: 'supplementary steer', sourceSeq: 12 },
  { kind: 'assistant', content: 'adjusted response', sourceSeq: 13 },
]);

describe('TurnNodeEditor', () => {
  it('jointly compresses user-assistant-user-assistant into user-assistant', () => {
    const draft = editor();
    const result = draft.replace('n1', 'n4', [
      { kind: 'user', content: 'combined request and steer' },
      { kind: 'assistant', content: 'combined response and adjustment' },
    ]);

    assert.deepEqual(result.created.map((node) => node.id), ['r1', 'r2']);
    assert.deepEqual(result.created.map((node) => node.kind), ['user', 'assistant']);
    assert.deepEqual(result.created[0].landingIndexes, [1, 2]);
    assert.deepEqual(result.created[1].landingIndexes, [3, 4]);
    assert.deepEqual(result.created[0].sourceIndexes, [1, 2, 3, 4]);
    assert.deepEqual(result.created[1].sourceIndexes, [1, 2, 3, 4]);
    assert.deepEqual(result.created[0].sourceSeqs, [10, 11, 12, 13]);
    assert.deepEqual(result.created[1].sourceSeqs, [10, 11, 12, 13]);
    assert.match(result.catalog, /r1 user lands=n1\.\.n2 sources=n1\.\.n4 changed/);
    assert.match(result.catalog, /r2 assistant lands=n3\.\.n4 sources=n1\.\.n4 changed/);
    draft.validateFinal();
  });

  it('can split and refine a generated node within its original landing capacity', () => {
    const draft = editor();
    const merged = draft.replace('n1', 'n4', [{ kind: 'assistant', content: 'draft' }]);
    assert.equal(merged.created[0].id, 'r1');

    const refined = draft.replace('r1', undefined, [
      { kind: 'user', content: 'combined request' },
      { kind: 'assistant', content: 'final response' },
    ]);
    assert.deepEqual(refined.created.map((node) => node.id), ['r2', 'r3']);
    assert.deepEqual(refined.created[0].landingIndexes, [1, 2]);
    assert.deepEqual(refined.created[1].landingIndexes, [3, 4]);
    assert.deepEqual(refined.created[0].sourceIndexes, [1, 2, 3, 4]);
    assert.deepEqual(draft.snapshot().map((node) => node.id), ['r2', 'r3']);
    draft.validateFinal();
  });

  it('invalidates shadowed ids', () => {
    const draft = editor();
    draft.replace('n2', 'n3', [{ kind: 'assistant', content: 'compressed work' }]);
    assert.throws(
      () => draft.replace('n2', undefined, [{ kind: 'assistant', content: 'again' }]),
      /unknown or stale node id/,
    );
  });

  it('batch reads several ids and ranges with one output cap', () => {
    const draft = editor();
    const text = draft.read([{ start: 'n1' }, { start: 'n3', end: 'n4' }], 1000);
    assert.match(text, /id="n1"/);
    assert.doesNotMatch(text, /id="n2"/);
    assert.match(text, /id="n3"/);
    assert.match(text, /id="n4"/);
    assert.throws(() => draft.read([{ start: 'n1', end: 'n4' }], 20), /above the 20-char limit/);
  });

  it('returns rich initial metadata without exposing raw seqs as ids', () => {
    const catalog = editor().richCatalog(8);
    assert.match(catalog, /^n1 \| user \| 15 chars \| lands=n1 \| sources=n1 \| unchanged/m);
    assert.match(catalog, /preview="initial…"/);
    assert.doesNotMatch(catalog, /\| 10 \|/);
  });

  it('rejects empty output sets, empty content, and expansion beyond landing capacity', () => {
    const draft = editor();
    assert.throws(() => draft.replace('n1', 'n2', []), /at least one output node/);
    assert.throws(() => draft.replace('n1', 'n2', [{ kind: 'assistant', content: '  ' }]), /must not be empty/);
    assert.throws(() => draft.replace('n1', undefined, [
      { kind: 'user', content: 'one' },
      { kind: 'assistant', content: 'two' },
    ]), /only 1 original landing positions/);
  });

  it('allows tool output only as a one-to-one tool rewrite', () => {
    const draft = new TurnNodeEditor([
      { kind: 'assistant', content: 'call', sourceSeq: 10 },
      { kind: 'tool', content: 'result', sourceSeq: 11 },
      { kind: 'assistant', content: 'answer', sourceSeq: 12 },
    ]);
    assert.doesNotThrow(() => draft.replace('n2', undefined, [{ kind: 'tool', content: 'short result' }]));
    assert.throws(
      () => draft.replace('n1', 'r1', [{ kind: 'tool', content: 'invalid merge' }]),
      /only as a one-to-one rewrite/,
    );
  });
});
