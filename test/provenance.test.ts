import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  describeEventOrigin,
  isInjectedHostSource,
  isReSuppliedHostContext,
  resolveLifecycleSource,
} from '../lib/provenance.ts';
import { buildSessionSegments, renderSegmentNodeDirectory, renderSegmentSource } from '../lib/session-segments.ts';

function event(type: string, seq: number, data: any = {}): any {
  return { type, seq, data };
}

const session = (events: any[]): any => ({ events, snapshotEvents: () => events });

describe('message provenance', () => {
  test('classifies injected host messages and re-supplied context differently', () => {
    // A notice is host-injected, but it is not re-supplied context: a settlement notice
    // carries a subagent's closing message, so session compaction must keep it.
    const settled = { kind: 'subagent-settled', form: 'notice' };
    assert.equal(isInjectedHostSource(settled), true);
    assert.equal(isReSuppliedHostContext(settled), false);

    // A skill body arrives once per invocation; its file still holds the same text.
    const skill = { kind: 'skill-invocation', form: 'instructions' };
    assert.equal(isInjectedHostSource(skill), true);
    assert.equal(isReSuppliedHostContext(skill), true);

    // Snapshots and catalogs are regenerated every step.
    assert.equal(isReSuppliedHostContext({ kind: 'runtime-context', form: 'snapshot' }), true);
    assert.equal(isReSuppliedHostContext({ kind: 'skill-catalog', form: 'catalog' }), true);
    assert.equal(isReSuppliedHostContext({ kind: 'agent-instructions', form: 'instructions' }), true);

    // A checkpoint is memory: it is not a human request (first predicate) but it is also
    // not re-supplied context (second predicate), so session compaction keeps it.
    const checkpoint = { kind: 'turn-memory-compression', turn: 3 };
    assert.equal(isInjectedHostSource(checkpoint), true);
    assert.equal(isReSuppliedHostContext(checkpoint), false);
    // 0.1.x bundled every plugin source into one `plugin` kind and wrote compressed turns
    // that way; session compaction still keeps them as memory.
    assert.equal(isReSuppliedHostContext({ kind: 'plugin', plugin: 'turn-memory', turn: 3 }), false);
    assert.equal(isReSuppliedHostContext({ kind: 'turn-memory-continuation', form: 'notice' }), true);
    for (const human of [{ kind: 'user' }, { kind: 'user-approval' }, { kind: 'agent-message', form: 'relay' }]) {
      assert.equal(isInjectedHostSource(human), false);
      assert.equal(isReSuppliedHostContext(human), false);
    }
  });

  test('resolves a lifecycle marker copy back to the message it replaced', () => {
    const events: any[] = [];
    events[1] = event('user/message', 1, { source: { kind: 'user' } });
    events[2] = {
      ...event('user/message', 2, { source: { kind: 'turn-memory-pending', turn: 1 } }),
      sourceEventSeqs: [1],
    };
    events[3] = {
      ...event('user/message', 3, { source: { kind: 'turn-memory-failed', turn: 1 } }),
      sourceEventSeqs: [2],
    };
    assert.equal(resolveLifecycleSource(events[3], events).kind, 'user');
    assert.equal(isInjectedHostSource(resolveLifecycleSource(events[3], events)), false);
    // A copy of a continuation notice still resolves to the notice.
    const notice = event('user/message', 4, { source: { kind: 'turn-memory-continuation', form: 'notice' } });
    const copy = { ...event('user/message', 5, { source: { kind: 'turn-memory-pending', turn: 2 } }), sourceEventSeqs: [4] };
    assert.equal(isInjectedHostSource(resolveLifecycleSource(copy, [undefined, undefined, undefined, undefined, notice])), true);
  });

  test('labels origin so a copied human message still reads as human', () => {
    const events: any[] = [];
    events[1] = event('user/message', 1, { source: { kind: 'user' } });
    events[2] = {
      ...event('user/message', 2, { source: { kind: 'turn-memory-pending', turn: 1 } }),
      sourceEventSeqs: [1],
    };
    assert.equal(describeEventOrigin(events[2], events), 'human');
    assert.equal(describeEventOrigin(event('user/message', 3, { source: { kind: 'user-approval' } }), []), 'human');
    assert.equal(describeEventOrigin(event('user/message', 4, { source: { kind: 'subagent-settled', form: 'notice' } }), []), 'host:subagent-settled');
    assert.equal(describeEventOrigin(event('user/message', 5, { source: { kind: 'turn-memory-compression', turn: 2 } }), []), 'plugin:turn-memory');
    assert.equal(describeEventOrigin(event('assistant/message', 6, { message: { source: { kind: 'model', provider: 'p', model: 'm' } } }), []), 'model:p/m');
    assert.equal(describeEventOrigin(event('tool/result', 7, {}), []), 'tool');
  });

  test('session segmentation drops re-supplied context and keeps result-bearing notices', () => {
    const events: any[] = [];
    events[0] = event('turn/start', 0, { turn: 1 });
    events[1] = event('user/message', 1, { content: [{ type: 'text', text: 'please fix the build' }], source: { kind: 'user' } });
    events[2] = event('user/message', 2, {
      content: [{ type: 'text', text: '<skill_content name="code">…</skill_content>' }],
      source: { kind: 'skill-invocation', form: 'instructions' },
    });
    events[3] = event('user/message', 3, {
      content: [{ type: 'text', text: 'Background subagent s2 finished. Its closing message: tests pass.' }],
      source: { kind: 'subagent-settled', form: 'notice' },
    });
    events[4] = event('user/message', 4, {
      content: [{ type: 'text', text: 'Turn Memory automatic continuation after compressed turn 0' }],
      source: { kind: 'turn-memory-continuation', form: 'notice' },
    });
    events[5] = event('assistant/message', 5, { message: { content: [{ type: 'text', text: 'fixed' }] } });
    events[6] = {
      ...event('user/message', 6, {
        content: [{ type: 'text', text: 'please fix the build' }],
        source: { kind: 'turn-memory-pending', turn: 1 },
      }),
      sourceEventSeqs: [1],
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    };
    events[7] = event('turn/end', 7, { turn: 1 });
    const eventsSession = session(events);
    // Current surface order: the pending copy replaced the human message in place.
    const segments = buildSessionSegments(eventsSession, [
      { seq: 6, tokens: 3 }, { seq: 2, tokens: 20 }, { seq: 3, tokens: 4 }, { seq: 4, tokens: 3 }, { seq: 5, tokens: 2 },
    ], 100);
    assert.deepEqual(segments.flatMap((segment) => segment.seqs), [6, 3, 5]);
    const directory = renderSegmentNodeDirectory(eventsSession, segments[0]);
    assert.match(directory, /origin=human \| turn=1/);
    assert.match(renderSegmentSource(eventsSession, segments[0]), /please fix the build/);
  });
});
