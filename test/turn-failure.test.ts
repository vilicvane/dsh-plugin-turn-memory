import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendTurnMarkerCopy,
  compressedTurnNumbers,
  pendingTurnNumbers,
  turnMarkerOriginal,
} from '../lib/turn-recovery.ts';
import {
  failedTurnSource,
  pendingTurnSource,
  pluginSourceName,
  turnMemoryMarkerOf,
  turnMemoryMarkerTurn,
} from '../lib/message-source.ts';
import { Session } from '@deepseek-ai/dsh-session';

/** One completed turn, i.e. the state a queued compression job starts from. */
function completedTurnSession(name: string): any {
  const session = Session.create(name as any);
  session.append('turn/start', { turn: 1 });
  session.append('user/message', {
    id: 'user-original' as any,
    role: 'user',
    content: [{ type: 'text', text: 'original request' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'assistant-original' as any,
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'work done' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

function latestUserSource(session: any): any {
  const events = session.snapshotEvents();
  for (let seq = events.length - 1; seq > 0; seq -= 1) {
    if (events[seq]?.type === 'user/message') return events[seq].data.source;
  }
  return undefined;
}

describe('turn failure markers', () => {
  it('finds the user node that carries a turn marker', () => {
    const session = completedTurnSession('turn-failure-anchor');

    const user = turnMarkerOriginal(session, 1);
    assert.equal(user.type, 'user/message');
    assert.deepEqual(user.data.content, [{ type: 'text', text: 'original request' }]);

    const marked = appendTurnMarkerCopy(session, user, pendingTurnSource(1));
    assert.equal(turnMarkerOriginal(session, 1).seq, marked.seq,
      'a later marker copy becomes the anchor so a failure can replace the pending one');
    assert.equal(turnMarkerOriginal(session, 2), undefined, 'a turn that never started has no anchor');
  });

  it('records a failure without claiming the turn is compressed', () => {
    const session = completedTurnSession('turn-failure-phase');
    appendTurnMarkerCopy(session, turnMarkerOriginal(session, 1), pendingTurnSource(1));
    appendTurnMarkerCopy(session, turnMarkerOriginal(session, 1), failedTurnSource(1, 'compression did not land'));

    const source = latestUserSource(session);
    assert.equal(turnMemoryMarkerOf(source), undefined, 'a failure is not a lifecycle phase');
    assert.equal(turnMemoryMarkerTurn(source), 1);
    assert.equal(pluginSourceName(source), 'turn-memory');
    assert.equal(source.reason, 'compression did not land');
    assert.deepEqual([...pendingTurnNumbers(session)], [1], 'the turn stays pending for cold recovery');
    assert.deepEqual([...compressedTurnNumbers(session)], []);
  });

  it('keeps the transcript intact after a failure marker lands', () => {
    const session = completedTurnSession('turn-failure-cold');
    appendTurnMarkerCopy(session, turnMarkerOriginal(session, 1), failedTurnSource(1, 'compression did not land'));

    const text = (target: any) => target.deriveMessages().map((message: any) => message.content[0]);
    const expected = [
      { type: 'text', text: 'original request' },
      { type: 'text', text: 'work done' },
    ];
    assert.deepEqual(text(session), expected);

    const cold = Session.create('turn-failure-cold-reload' as any, session.snapshotEvents());
    assert.deepEqual(text(cold), expected);
    assert.deepEqual([...pendingTurnNumbers(cold)], [], 'a failure alone does not open the cold-recovery boundary');
  });
});
