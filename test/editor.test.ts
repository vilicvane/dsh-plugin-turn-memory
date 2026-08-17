import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TurnNodeEditor } from '../lib/editor.ts';

const editor = () => new TurnNodeEditor([
  { kind: 'user', content: 'alpha', sourceSeq: 10 },
  { kind: 'tool', content: 'beta tool output', sourceSeq: 11 },
  { kind: 'assistant', content: 'gamma', sourceSeq: 12 },
  { kind: 'assistant', content: 'delta', sourceSeq: 13 },
]);

describe('TurnNodeEditor', () => {
  it('supports merge followed by refinement using the generated id', () => {
    const draft = editor();
    const first = draft.replace('n2', 'n3', 'assistant', 'draft summary');
    assert.equal(first.created.id, 'r1');
    assert.deepEqual(first.created.sourceSeqs, [11, 12]);
    assert.match(first.catalog, /n1 user covers=n1 unchanged/);
    assert.match(first.catalog, /r1 assistant covers=n2\.\.n3 changed/);

    const second = draft.replace('r1', 'n4', 'assistant', 'final summary');
    assert.equal(second.created.id, 'r2');
    assert.deepEqual(second.created.sourceSeqs, [11, 12, 13]);
    assert.deepEqual(draft.snapshot().map((node) => node.id), ['n1', 'r2']);
    draft.validateFinal();
  });

  it('invalidates shadowed ids', () => {
    const draft = editor();
    draft.replace('n2', 'n3', 'assistant', 'summary');
    assert.throws(() => draft.replace('n2', undefined, 'assistant', 'again'), /unknown or stale node id/);
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
    assert.match(catalog, /^n1 \| user \| 5 chars \| covers=n1 \| unchanged/m);
    assert.match(catalog, /preview="beta to…"/);
    assert.doesNotMatch(catalog, /\| 10 \|/);
  });

  it('rejects empty K-to-zero-shaped replacements', () => {
    assert.throws(() => editor().replace('n1', 'n2', 'assistant', '  '), /must not be empty/);
  });
});
