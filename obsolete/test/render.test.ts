import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSpanDraft, renderSpanNode } from '../lib/render.ts';
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

describe('renderSpanNode', () => {
  it('classifies a real user message as a verbatim user line', () => {
    const node = renderSpanNode(user('你好'));
    assert.deepEqual(node, { seq: 0, kind: 'user', content: '你好' });
  });

  it('classifies injected context as a droppable context line with an [injected: ...] marker', () => {
    const node = renderSpanNode(injected('runtime snapshot'));
    assert.deepEqual(node, { seq: 0, kind: 'context', content: '[injected: @deepseek-ai/dsh-system-prompt]\nruntime snapshot' });
  });

  it('keeps assistant text only — tool-call blocks are dropped from the line', () => {
    const node = renderSpanNode(assistant([
      { type: 'text', text: '答复' },
      { type: 'tool-call', name: 'read' },
    ]));
    assert.deepEqual(node, { seq: 0, kind: 'assistant', content: '答复' });
  });

  it('renders a tool result into a tool line with its name and text', () => {
    const node = renderSpanNode(result('read', 'file text'));
    assert.deepEqual(node, { seq: 0, kind: 'tool', content: '[tool/result: read]\nfile text' });
  });

  it('truncates tool result text past the cap with a marker', () => {
    const node = renderSpanNode(result('big', 'x'.repeat(100)), { maxToolResultChars: 20 });
    assert.ok(node?.content.includes('[truncated, 100 chars total]'));
    assert.ok(node!.content.length < 120);
  });
});

describe('renderSpanDraft', () => {
  it('renders one JSON line per original node with its seq as the id', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[10] = user('steer');
    events[11] = assistant([{ type: 'text', text: '答复' }]);
    events[12] = result('read', 'ok');
    const text = renderSpanDraft(events, [10, 11, 12]);
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { seq: 10, kind: 'user', content: 'steer' },
      { seq: 11, kind: 'assistant', content: '答复' },
      { seq: 12, kind: 'tool', content: '[tool/result: read]\nok' },
    ]);
  });

  it('escapes newlines inside content so each line parses independently', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[1] = user('第一行\n第二行');
    const text = renderSpanDraft(events, [1]);
    const rawLines = text.trim().split('\n');
    assert.equal(rawLines.length, 1);
    assert.deepEqual(JSON.parse(rawLines[0]), { seq: 1, kind: 'user', content: '第一行\n第二行' });
  });
});
