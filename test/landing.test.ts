import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TurnNodeEditor } from '../lib/editor.ts';
import { land, validateLanding } from '../lib/landing.ts';

/**
 * Minimal session double. `append` records the event and applies a positional
 * replacement to `surface.nodes`; the runtime handle validates and mutates the
 * same way, so a landing branch that would not load still reproduces here. The
 * third argument is the runtime's `{ surfaceOp, sourceEventSeqs }` intent object.
 */
function fixtureSession(): any {
  const events: any[] = [];
  const surface = { nodes: [] as number[] };
  const append = (type: string, data: any, options?: { surfaceOp?: any; sourceEventSeqs?: number[] }): any => {
    const surfaceOp = options?.surfaceOp;
    const event: any = {
      seq: events.length,
      type,
      data,
      ...(options?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    };
    events.push(event);
    if (surfaceOp === 'append') {
      surface.nodes.push(event.seq);
    } else if (surfaceOp !== null && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
      const first = surfaceOp.startSeq ?? surfaceOp.start;
      const last = surfaceOp.endSeq ?? surfaceOp.end;
      const firstIndex = surface.nodes.indexOf(first);
      const lastIndex = surface.nodes.indexOf(last);
      if (firstIndex < 0 || lastIndex < firstIndex) throw new Error('invalid replace surfaceOp');
      surface.nodes.splice(firstIndex, lastIndex - firstIndex + 1, event.seq);
    }
    return event;
  };
  return {
    events,
    snapshotEvents: () => events,
    eventAt: (seq: number) => events[seq],
    surface,
    header: {},
    append,
  };
}

/** A completed turn, i.e. exactly the state in which compression lands. */
function completedTurnSession(): any {
  const session = fixtureSession();
  session.append('turn/start', { turn: 1 });
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'original question' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: 'original answer' }],
    },
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

/** A completed turn whose surface also carries a tool result (seqs 1, 3, 4, 7). */
function toolTurnSession(): any {
  const session = fixtureSession();
  session.append('turn/start', { turn: 1 });
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'original question' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool-call', id: 'call-1', name: 'read_turn_nodes', arguments: { ids: ['n1'] } },
      ],
    },
  }, { surfaceOp: 'append' });
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 't1',
      role: 'tool',
      source: { callId: 'call-1' },
      content: [{ type: 'text', text: 'tool output' }],
    },
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: {
      id: 'a2',
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
    },
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 2 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

function toolTurnEditor(): TurnNodeEditor {
  return new TurnNodeEditor([
    { kind: 'user', content: 'original question', sourceSeq: 1 },
    { kind: 'assistant', content: 'let me look', sourceSeq: 3, toolCallIds: ['call-1'] },
    { kind: 'tool', content: 'tool output', sourceSeq: 4, toolResultCallId: 'call-1' },
    { kind: 'assistant', content: 'final answer', sourceSeq: 7 },
  ]);
}

function editorFor(session: any): TurnNodeEditor {
  return new TurnNodeEditor([
    { kind: 'user', content: 'original question', sourceSeq: 1 },
    { kind: 'assistant', content: 'original answer', sourceSeq: 3 },
  ]);
}

function jobFor(session: any, editor: TurnNodeEditor, targetSeqs: number[] = [1, 3]): any {
  return {
    id: 'draft-1',
    session,
    turn: 1,
    targetSeqs,
    editor,
    mutationCount: 1,
    workerNumber: 1,
  };
}

function landedEvents(session: any, from: number): any[] {
  return session.events.slice(from);
}

describe('compression landing', () => {
  test('an unchanged turn lands as one marker copy', () => {
    const session = completedTurnSession();
    const editor = editorFor(session);
    const job = jobFor(session, editor);
    validateLanding(job, false);
    land(job);

    const events = landedEvents(session, 6);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'user/message');
    assert.deepEqual(event.data.content, [{ type: 'text', text: 'original question' }]);
    assert.equal(event.data.source.kind, 'turn-memory-compression');
    assert.equal(event.data.source.turn, 1);
    assert.equal(event.data.source.draftId, 'draft-1');
    assert.equal(event.data.source.originalNodes, 2);
    assert.equal(event.data.source.mutations, 1);
    assert.equal(event.data.source.workerAttempts, 1);
    assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 });
    assert.deepEqual(event.sourceEventSeqs, [1]);
    assert.deepEqual(session.surface.nodes, [event.seq, 3]);
  });

  test('a user-only rewrite lands as user/message replacements', () => {
    const session = completedTurnSession();
    const editor = editorFor(session);
    editor.replace('n1', 'n1', [{ kind: 'user', content: 'rewritten question' }]);
    const job = jobFor(session, editor);
    validateLanding(job, false);
    land(job);

    const events = landedEvents(session, 6);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'user/message');
    assert.deepEqual(event.data.content, [{ type: 'text', text: 'rewritten question' }]);
    assert.equal(event.data.source.kind, 'turn-memory-compression');
    assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 });
    assert.deepEqual(session.surface.nodes, [event.seq, 3]);
  });

  test('a structural merge of a completed turn lands as one user/message checkpoint', () => {
    const session = toolTurnSession();
    const editor = toolTurnEditor();
    editor.replace('n2', 'n3', [{ kind: 'assistant', content: 'merged answer' }]);
    const job = jobFor(session, editor, [1, 3, 4, 7]);
    const from = session.events.length;
    validateLanding(job, false);
    land(job);

    const events = landedEvents(session, from);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'user/message');
    assert.deepEqual(event.data.content, [{
      type: 'text',
      text: 'User: original question\n\nAssistant: merged answer\n\nAssistant: final answer',
    }]);
    assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 7 });
    assert.deepEqual([...event.sourceEventSeqs].sort((a, b) => a - b), [1, 3, 4, 7]);
    assert.deepEqual(session.surface.nodes, [event.seq]);
  });

  test('a rewritten assistant collapses into a checkpoint and never appends an assistant event', () => {
    const session = completedTurnSession();
    const editor = editorFor(session);
    editor.replace('n2', 'n2', [{ kind: 'assistant', content: 'rewritten answer' }]);
    const job = jobFor(session, editor);
    // The old landing required a model source to inherit for a rewritten assistant node.
    validateLanding(job, false);
    land(job);

    const events = landedEvents(session, 6);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'user/message');
    assert.deepEqual(event.data.content, [{
      type: 'text',
      text: 'User: original question\n\nAssistant: rewritten answer',
    }]);
    assert.equal(event.data.source.kind, 'turn-memory-compression');
    assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 });
    assert.deepEqual(event.sourceEventSeqs, [1, 3]);
    assert.deepEqual(session.surface.nodes, [event.seq]);

    // This is the invariant the corrupting landing violated: after turn/end only
    // user/message may be appended, so an assistant/tool event can never land here.
    for (const appended of events) {
      assert.notEqual(appended.type, 'assistant/message');
      assert.notEqual(appended.type, 'tool/call');
      assert.notEqual(appended.type, 'tool/result');
    }
  });

  test('every landing branch leaves only user/message events behind', () => {
    const branchOf = (mutate: (editor: TurnNodeEditor) => void) => {
      const session = completedTurnSession();
      const editor = editorFor(session);
      mutate(editor);
      const job = jobFor(session, editor);
      validateLanding(job, false);
      land(job);
      return landedEvents(session, 6);
    };

    const noop = branchOf(() => {});
    const userOnly = branchOf((editor) => {
      editor.replace('n1', 'n1', [{ kind: 'user', content: 'rewritten question' }]);
    });
    const checkpoint = branchOf((editor) => {
      editor.replace('n2', 'n2', [{ kind: 'assistant', content: 'rewritten answer' }]);
    });

    for (const events of [noop, userOnly, checkpoint]) {
      assert.ok(events.length > 0);
      assert.ok(events.every((event) => event.type === 'user/message'));
      assert.ok(events.every((event) => event.data.source.kind === 'turn-memory-compression'));
    }
  });

  test('refuses to land when the target slice is no longer contiguous', () => {
    const session = completedTurnSession();
    const editor = editorFor(session);
    const job = jobFor(session, editor);
    session.surface.nodes.splice(0, 2, 3, 1);
    assert.throws(() => land(job), /target surface changed before landing/);
  });
});
