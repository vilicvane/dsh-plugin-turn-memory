import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSpanSegments, renderTurnSpanText } from '../lib/render.ts';
import type { RenderEventLike } from '../lib/render.ts';

const user = (text: string): RenderEventLike => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
});

const injected = (text: string, plugin = '@deepseek-ai/dsh-system-prompt'): RenderEventLike => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } },
});

const assistant = (blocks: { type: string; text?: string; name?: string }[]): RenderEventLike => ({
  type: 'assistant/message',
  data: { message: { content: blocks } },
});

const result = (name: string, text: string): RenderEventLike => ({
  type: 'tool/result',
  data: {
    name,
    message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
  },
});

describe('renderSpanSegments', () => {
  it('wraps a user message as a verbatim user-steer segment', () => {
    assert.deepEqual(renderSpanSegments(user('你好')), [{ kind: 'user-steer', text: '你好' }]);
  });

  it('classifies injected context (skill catalogs, snapshots) as compressible working with an [injected: ...] marker', () => {
    assert.deepEqual(renderSpanSegments(injected('runtime snapshot text')), [
      { kind: 'working', text: '[injected: @deepseek-ai/dsh-system-prompt]\nruntime snapshot text' },
    ]);
  });

  it('falls back to the source kind in the injected marker when no plugin name exists', () => {
    assert.deepEqual(renderSpanSegments(injected('x', '')), [
      { kind: 'working', text: '[injected: plugin]\nx' },
    ]);
  });

  it('splits assistant content into assistant and working segments in block order', () => {
    assert.deepEqual(renderSpanSegments(assistant([
      { type: 'text', text: 'reply' },
      { type: 'tool-call', name: 'edit' },
    ])), [
      { kind: 'assistant', text: 'reply' },
      { kind: 'working', text: '[tool call: edit]' },
    ]);
  });

  it('renders a tool result into a working segment with its name and text, descending into the wrapper', () => {
    assert.deepEqual(renderSpanSegments(result('read', 'file text')), [
      { kind: 'working', text: '[tool/result: read]\nfile text' },
    ]);
  });

  it('truncates long tool results at the cap', () => {
    assert.deepEqual(renderSpanSegments(result('read', 'abcdefgh'), { maxToolResultChars: 4 }), [
      { kind: 'working', text: '[tool/result: read]\nabcd ... [truncated, 8 chars total]' },
    ]);
  });

  it('returns no segments for non-message types', () => {
    assert.deepEqual(renderSpanSegments({ type: 'turn/start', data: {} }), []);
    assert.deepEqual(renderSpanSegments(undefined), []);
  });
});

describe('renderTurnSpanText', () => {
  it('renders the span in the checkpoint tag format, skipping empty types', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[10] = user('第一句');
    events[11] = assistant([{ type: 'text', text: '第一答' }]);
    events[12] = { type: 'turn/end', data: {} };
    const text = renderTurnSpanText(events, [10, 11, 12]);
    assert.equal(text, '<user-steer:1>\n第一句\n</user-steer:1>\n<assistant:2>\n第一答\n</assistant:2>\n');
  });

  it('coalesces adjacent working pieces into one <working> block', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[10] = assistant([{ type: 'tool-call', name: 'edit' }]);
    events[11] = result('edit', 'ok');
    events[12] = assistant([{ type: 'tool-call', name: 'read' }]);
    events[13] = result('read', 'file text');
    const text = renderTurnSpanText(events, [10, 11, 12, 13]);
    assert.equal(
      text,
      '<working:1>\n[tool call: edit]\n[tool/result: edit]\nok\n[tool call: read]\n[tool/result: read]\nfile text\n</working:1>\n',
    );
  });

  it('keeps role blocks in original order with working runs interleaved', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[10] = user('steer');
    events[11] = assistant([{ type: 'text', text: '答复' }, { type: 'tool-call', name: 'edit' }]);
    events[12] = result('edit', 'ok');
    events[13] = assistant([{ type: 'text', text: '后续答复' }]);
    const text = renderTurnSpanText(events, [10, 11, 12, 13]);
    assert.equal(
      text,
      '<user-steer:1>\nsteer\n</user-steer:1>\n<assistant:2>\n答复\n</assistant:2>\n<working:3>\n[tool call: edit]\n[tool/result: edit]\nok\n</working:3>\n<assistant:4>\n后续答复\n</assistant:4>\n',
    );
  });
});
