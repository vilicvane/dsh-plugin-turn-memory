import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appendDumpBlock, buildDumpFileName, DUMP_BLOCK_SEPARATOR, renderBoundaryNode, renderPrefixBoundary } from '../lib/prefix.ts';
import type { BoundaryNodeLike, PrefixBoundaryMeta } from '../lib/prefix.ts';

const userMessage = (text: string): BoundaryNodeLike => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
});

const meta = (over: Partial<PrefixBoundaryMeta> = {}): PrefixBoundaryMeta => ({
  timestamp: '2026-08-15T22:00:00.000Z',
  sessionId: 'sess-1',
  mode: 'in-turn (current turn)',
  checkpointSeq: 9001,
  nextSeq: 9002,
  replacedNodes: 3,
  replacedSpan: '[7000, 8000]',
  note: 'turn-starting user message seq 6000 stays verbatim BEFORE the checkpoint',
  ...over,
});

describe('renderBoundaryNode', () => {
  it('user message: joins all text parts', () => {
    const node: BoundaryNodeLike = {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    };
    assert.equal(renderBoundaryNode(node), 'ab');
  });

  it('assistant message: text plus non-text placeholders', () => {
    const node: BoundaryNodeLike = {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use' }, { type: 'text', text: 'bye' }] },
    };
    assert.equal(renderBoundaryNode(node), 'hi[tool_use]bye');
  });

  it('message without text content', () => {
    assert.equal(renderBoundaryNode({ type: 'user/message', data: {} }), '[user/message: no text content]');
  });

  it('tool result renders name', () => {
    const node: BoundaryNodeLike = {
      type: 'tool/result',
      data: { message: { content: [{ toolCallId: 'call-9' }], name: 'browser' } },
    };
    assert.equal(renderBoundaryNode(node), '[tool/result: browser]');
  });

  it('tool result without name renders call id', () => {
    const node: BoundaryNodeLike = {
      type: 'tool/result',
      data: { message: { content: [{ toolCallId: 'call-9' }] } },
    };
    assert.equal(renderBoundaryNode(node), '[tool/result callId=call-9]');
  });

  it('other types and undefined', () => {
    assert.equal(renderBoundaryNode({ type: 'step/summary' }), '[step/summary]');
    assert.equal(renderBoundaryNode(undefined), '[none]');
  });
});

describe('renderPrefixBoundary', () => {
  it('full boundary with a next node', () => {
    const text = renderPrefixBoundary(meta(), userMessage('CHECKPOINT'), userMessage('NEXT'));
    assert.ok(text.startsWith('# request-prefix boundary — 2026-08-15T22:00:00.000Z\n'));
    assert.ok(text.includes('mode: in-turn (current turn)'));
    assert.ok(text.includes('checkpoint: seq 9001 (3 surface nodes replaced, span [7000, 8000])'));
    assert.ok(text.includes('next: seq 9002 (kept verbatim)'));
    assert.ok(text.includes('note: turn-starting user message seq 6000 stays verbatim BEFORE the checkpoint'));
    assert.ok(text.includes('==== checkpoint node (seq 9001) ====\nCHECKPOINT\n'));
    assert.ok(text.includes('==== next node (seq 9002) ====\nNEXT\n'));
  });

  it('span to the surface tail has no next block and no note line', () => {
    const text = renderPrefixBoundary(meta({ nextSeq: null, note: undefined }), userMessage('CHECKPOINT'), undefined);
    assert.ok(text.includes('next: none — the replaced span ran to the surface tail'));
    assert.ok(!text.includes('==== next node'));
    assert.ok(!text.includes('note:'));
  });
});

describe('appendDumpBlock', () => {
  it('first block lands verbatim', () => {
    assert.equal(appendDumpBlock('', 'BLOCK-A\n'), 'BLOCK-A\n');
  });

  it('second block follows the divider line and keeps the first', () => {
    const text = appendDumpBlock('BLOCK-A\n', 'BLOCK-B\n');
    assert.ok(text.startsWith('BLOCK-A\n\n' + DUMP_BLOCK_SEPARATOR + '\n\nBLOCK-B\n'));
  });

  it('three blocks accumulate oldest-first', () => {
    const text = appendDumpBlock(appendDumpBlock('BLOCK-A\n', 'BLOCK-B\n'), 'BLOCK-C\n');
    const a = text.indexOf('BLOCK-A');
    const b = text.indexOf('BLOCK-B');
    const c = text.indexOf('BLOCK-C');
    const sep = text.indexOf(DUMP_BLOCK_SEPARATOR);
    const lastSep = text.lastIndexOf(DUMP_BLOCK_SEPARATOR);
    assert.ok(a >= 0 && b > a && c > b, 'blocks stay in chronological order');
    assert.ok(sep >= 0 && lastSep > sep, 'one divider per appended block');
    assert.ok(text.endsWith('BLOCK-C\n'));
  });
});

describe('buildDumpFileName', () => {
  it('wraps a session id in the request-prefix name', () => {
    assert.equal(
      buildDumpFileName('9ef62b3f-178e-43b3-9a30-c67c036b7a05'),
      'request-prefix-9ef62b3f-178e-43b3-9a30-c67c036b7a05.txt',
    );
  });

  it('replaces characters outside the safe set with underscores', () => {
    assert.equal(buildDumpFileName('a/b:c*d?e'), 'request-prefix-a_b_c_d_e.txt');
  });

  it('keeps dots, dashes and underscores', () => {
    assert.equal(buildDumpFileName('a.b-c_d'), 'request-prefix-a.b-c_d.txt');
  });

  it('falls back to unknown for an empty session id', () => {
    assert.equal(buildDumpFileName(''), 'request-prefix-unknown.txt');
  });
});
