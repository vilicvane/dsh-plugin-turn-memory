import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUserConversationSession } from '../lib/session-kind.ts';

describe('session lineage classification', () => {
  it('accepts roots and user-created lineage forks', () => {
    assert.equal(isUserConversationSession({ header: {} }), true);
    assert.equal(isUserConversationSession({
      header: { parentSession: 'parent', delegationDepth: 0 },
    }), true);
  });

  it('rejects current and legacy internal subagents', () => {
    assert.equal(isUserConversationSession({
      header: { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    }), false);
    assert.equal(isUserConversationSession({
      header: { parentSession: 'parent', delegationDepth: 1 },
    }), false);
    assert.equal(isUserConversationSession(undefined), false);
  });
});
