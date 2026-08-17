import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionMemoryEditor } from '../lib/session-editor.ts';
import { buildSessionCompactionPrompt } from '../lib/session-prompt.ts';
import { buildSessionSegments } from '../lib/session-segments.ts';

function fixture(): { session: any; editor: SessionMemoryEditor; segments: ReturnType<typeof buildSessionSegments> } {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'keep inspiration delta' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'failed route taught epsilon' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ];
  const session = { events };
  const segments = buildSessionSegments(session, [{ seq: 1, tokens: 3 }, { seq: 2, tokens: 4 }], 100);
  return { session, editor: new SessionMemoryEditor(1), segments };
}

test('session prompt is a complete fork protocol without duplicating full source', () => {
  const { session, editor, segments } = fixture();
  const prompt = buildSessionCompactionPrompt({ editor, segments, assigned: segments[0], session, workerMode: 'fork', warmupChars: 1000 });
  assert.match(prompt, /shorter chronological transcript/);
  assert.match(prompt, /inspirations, discoveries, and hypotheses/);
  assert.match(prompt, /stale cwd\/sandbox\/approval\/runtime snapshots/);
  assert.match(prompt, /origin=human/);
  assert.match(prompt, /current integer revision/);
  assert.match(prompt, /finish_session_segment/);
  assert.match(prompt, /preview="keep inspiration delta"/);
  assert.doesNotMatch(prompt, /<assigned-source/);
});

test('fresh spawn prompt embeds the complete assigned source', () => {
  const { session, editor, segments } = fixture();
  const prompt = buildSessionCompactionPrompt({ editor, segments, assigned: segments[0], session, workerMode: 'fresh-spawn', warmupChars: 1000 });
  assert.match(prompt, /<assigned-source id="s1">/);
  assert.match(prompt, /failed route taught epsilon/);
});
