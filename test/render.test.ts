import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSpanEvent, renderTurnSpanText } from '../lib/render.ts';
import type { RenderEventLike } from '../lib/render.ts';

const user = (text: string): RenderEventLike => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
});

const assistant = (blocks: { type: string; text?: string; name?: string }[]): RenderEventLike => ({
  type: 'assistant/message',
  data: { message: { content: blocks } },
});

describe('renderSpanEvent', () => {
  it('renders a user message with a marker line', () => {
    assert.equal(renderSpanEvent(user('你好')), '### User\n你好\n');
  });

  it('renders assistant text and tool-call placeholders', () => {
    const text = renderSpanEvent(assistant([
      { type: 'text', text: 'reply' },
      { type: 'tool-call', name: 'edit' },
    ]));
    assert.equal(text, '### Assistant\nreply\n[tool call: edit]\n');
  });

  it('renders a tool result with its name and text, descending into the wrapper', () => {
    const event: RenderEventLike = {
      type: 'tool/result',
      data: {
        name: 'read',
        message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file text' }] }] },
      },
    };
    assert.equal(renderSpanEvent(event), '### Tool result: read\nfile text\n');
  });

  it('truncates long tool results at the cap', () => {
    const event: RenderEventLike = {
      type: 'tool/result',
      data: {
        name: 'read',
        message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'abcdefgh' }] }] },
      },
    };
    const text = renderSpanEvent(event, { maxToolResultChars: 4 });
    assert.equal(text, '### Tool result: read\nabcd ... [truncated, 8 chars total]\n');
  });

  it('returns empty text for non-message types', () => {
    assert.equal(renderSpanEvent({ type: 'turn/start', data: {} }), '');
    assert.equal(renderSpanEvent(undefined), '');
  });
});

describe('renderTurnSpanText', () => {
  it('joins span blocks with blank lines and skips empty types', () => {
    const events: (RenderEventLike | undefined)[] = [];
    events[10] = user('第一句');
    events[11] = assistant([{ type: 'text', text: '第一答' }]);
    events[12] = { type: 'turn/end', data: {} };
    const text = renderTurnSpanText(events, [10, 11, 12]);
    assert.equal(text, '### User\n第一句\n\n### Assistant\n第一答\n');
  });
});
