import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SessionMemoryEditor } from '../lib/session-editor.ts';

describe('SessionMemoryEditor', () => {
  test('processes sequential placeholders and lets a later segment revise earlier memory', () => {
    const editor = new SessionMemoryEditor(2);
    const first = editor.replace(1, 0, 'p1', undefined, [
      { kind: 'user', content: 'asked for an implementation' },
      { kind: 'assistant', content: 'tried route A and kept hypothesis H open' },
    ]);
    assert.equal(first.revision, 1);
    assert.deepEqual(first.created.map((node) => node.id), ['m1', 'm2']);
    assert.equal(editor.status(1), 'editing');
    assert.equal(editor.finishSegment(1, 1), 2);
    assert.equal(editor.status(1), 'done');

    const second = editor.replace(2, 2, 'm2', 'p2', [
      { kind: 'assistant', content: 'route A failed for reason R; later evidence confirmed H and led to route B' },
      { kind: 'user', content: 'kept the clarified constraint that selected route B' },
    ]);
    assert.equal(second.revision, 3);
    assert.deepEqual(second.created[0].sourceSegments, [1, 2]);
    editor.finishSegment(2, 3);
    editor.validateFinal();

    const rendered = editor.renderCheckpoint();
    assert.match(rendered, /<message role="user">/);
    assert.match(rendered, /route A failed for reason R/);
    assert.doesNotMatch(rendered, /<pending/);
  });

  test('continues a partially edited segment after a worker stops', () => {
    const editor = new SessionMemoryEditor(1);
    editor.replace(1, 0, 'p1', undefined, [{ kind: 'assistant', content: 'partial draft' }]);
    assert.equal(editor.status(1), 'editing');
    editor.replace(1, 1, 'm1', undefined, [
      { kind: 'user', content: 'original intent' },
      { kind: 'assistant', content: 'finished causal record' },
    ]);
    editor.finishSegment(1, 2);
    editor.validateFinal();
  });

  test('rejects stale revisions and consuming future placeholders', () => {
    const editor = new SessionMemoryEditor(2);
    assert.throws(
      () => editor.replace(1, 1, 'p1', undefined, [{ kind: 'user', content: 'stale' }]),
      /stale session memory revision/,
    );
    assert.throws(
      () => editor.replace(1, 0, 'p1', 'p2', [{ kind: 'user', content: 'too much' }]),
      /future segment s2/,
    );
  });

  test('supports paged catalogs, exact reads, and search', () => {
    const editor = new SessionMemoryEditor(1);
    editor.replace(1, 0, 'p1', undefined, [
      { kind: 'user', content: 'alpha question' },
      { kind: 'assistant', content: 'beta conclusion' },
    ]);
    assert.match(editor.catalog(0, 1), /next=1/);
    assert.match(editor.read([{ start: 'm1', end: 'm2' }], 10_000), /beta conclusion/);
    assert.match(editor.search('BETA', 10), /m2/);
  });
});
