import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TURN_CONTINUATION_TOOL_NAME,
  TurnContinuationController,
  countOpenTurnNodes,
  continuationMilestone,
  continuationRequestForTurn,
  continuationWasDelivered,
  latestAnnouncedMilestone,
  openTurnNumber,
} from '../lib/turn-continuation.ts';

function message(text: string, source: any = { kind: 'user' }): any {
  return { id: 'm-' + text, role: 'user', content: [{ type: 'text', text }], source };
}

function fixtureSession(): any {
  const events: any[] = [];
  const surface = { nodes: [] as number[] };
  const append = (type: string, data: any, surfaceOp?: any): any => {
    const event = { seq: events.length, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) };
    events.push(event);
    if (surfaceOp === 'append') surface.nodes.push(event.seq);
    return event;
  };
  return { events, surface, header: {}, append };
}

const meter = {
  measure(): any {
    return { totalTokens: 111, surfaceTokens: 0, nodes: [] };
  },
};

describe('turn continuation measurement', () => {
  test('counts only append-origin open-turn messages and excludes runtime snapshots', () => {
    const session = fixtureSession();
    session.append('user/message', message('old'), 'append');
    session.append('turn/start', { turn: 2 });
    session.append('user/message', message('12345'), 'append');
    session.append('user/message', message('runtime-noise', {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [],
    }), 'append');
    session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '1234567' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 'append');
    const replacement = session.append('user/message', message('old-checkpoint', {
      kind: 'plugin', plugin: 'compact', form: 'notice', summary: 'checkpoint',
    }), { op: 'replace', start: 0, end: 0 });
    session.surface.nodes.unshift(replacement.seq);

    assert.equal(openTurnNumber(session), 2);
    assert.equal(countOpenTurnNodes(session, 2), 2);
    assert.equal(continuationMilestone(2, 2), 2);
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    assert.equal(openTurnNumber(session), null);
  });

  test('recognizes a pre-migration tagged milestone snapshot', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 3 });
    const notice = [
      '<turn-memory-continuation turn="3" open-turn-nodes="34" milestone-nodes="32">',
      '<assistant-self-check>I need to stop and hand off now.</assistant-self-check>',
      '</turn-memory-continuation>',
    ].join('\n');
    session.append('user/message', message(notice, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: 'turn-memory:long-turn-continuation', text: notice }],
    }), 'append');

    assert.equal(latestAnnouncedMilestone(session, 3), 32);
  });
});

describe('turn continuation lifecycle', () => {
  test('requests, ends, dispatches, and durably deduplicates a continuation', async () => {
    const tools = new Map<string, any>();
    const contexts: any[] = [];
    let flushes = 0;
    const ctx = {
      tokenMeter: meter,
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
      systemPrompt: { context: (context: any) => contexts.push(context) },
      sessions: { flush: async () => { flushes += 1; } },
      logger: { info() {}, warn() {} },
    };
    const controller = new TurnContinuationController(ctx, { reminderIntervalNodes: 2 });
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('123456789'), 'append');
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'tool call' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 'append');
    const delivered: any[] = [];
    const agent = {
      session,
      followup(value: any) {
        delivered.push(value);
        session.append('agent/inbox/spliced', {
          target: 'next-turn', start: 0, inserted: [value],
        });
      },
    };

    const notice = contexts[0].text({ agent });
    assert.match(notice, /Turn Memory continuation required — 2-node milestone/);
    assert.match(notice, /Current open turn: 2 nodes/);
    assert.match(notice, /Estimated full context: 111 tokens/);
    assert.match(notice, /Next reminder milestone: 4 nodes/);
    assert.match(notice, /Stop this turn and hand off now/);
    assert.match(notice, /Call `continue_after_turn_compression`/);
    assert.match(notice, /whole task will finish in the next few actions/);
    assert.match(notice, new RegExp(TURN_CONTINUATION_TOOL_NAME));
    assert.doesNotMatch(notice, /<turn-memory-continuation|<assistant-self-check>/);
    assert.ok(notice.length < 900, 'continuation notice should stay concise');
    session.append('user/message', message(notice, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: 'turn-memory:long-turn-continuation', text: notice }],
    }), 'append');
    assert.equal(latestAnnouncedMilestone(session, 1), 2);
    assert.equal(contexts[0].text({ agent }), '', 'the same milestone must be shown only once');
    session.append('user/message', message('1234567'), 'append');
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'next' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 'append');
    const secondNotice = contexts[0].text({ agent });
    assert.match(secondNotice, /Turn Memory continuation required — 4-node milestone/);
    assert.match(secondNotice, /Stop this turn and hand off now/);

    let concluded = false;
    const tool = tools.get(TURN_CONTINUATION_TOOL_NAME);
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-continuation-1',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: JSON.stringify({ handoff: 'Run the remaining verification.' }),
    });
    const result = await tool.execute({ handoff: 'Run the remaining verification.' }, {
      agent,
      callId: 'call-continuation-1',
      concludeTurn: () => { concluded = true; },
    });
    assert.equal(concluded, true);
    assert.match(result, /queued/);
    assert.equal(continuationRequestForTurn(session, 1), undefined,
      'a tool call is not authoritative before its successful result');
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'result-continuation-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-continuation-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-continuation-1',
          content: [{ type: 'text', text: result }],
          isError: false,
        }],
      },
    });
    const request = continuationRequestForTurn(session, 1);
    assert.equal(request?.handoff, 'Run the remaining verification.');
    assert.equal(contexts[0].text({ agent }), '');
    assert.equal(controller.needsDispatchAfterCompression(session, 1), true);

    assert.equal(await controller.dispatchAfterCompression(agent, 1), true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content[0].text, /not new human input/);
    assert.match(delivered[0].content[0].text, /Resume the unfinished work now/);
    assert.doesNotMatch(delivered[0].content[0].text, /<turn-memory-continuation/);
    assert.equal(continuationWasDelivered(session, request!.requestId), true);
    assert.equal(controller.needsDispatchAfterCompression(session, 1), false);
    assert.equal(await controller.dispatchAfterCompression(agent, 1), false);
    assert.equal(delivered.length, 1);
    assert.equal(flushes, 1);
  });

  test('rejects premature and child-agent requests', async () => {
    const tools = new Map<string, any>();
    const ctx = {
      tokenMeter: meter,
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
      systemPrompt: { context() {} },
      sessions: { flush: async () => {} },
      logger: { info() {}, warn() {} },
    };
    new TurnContinuationController(ctx, { reminderIntervalNodes: 2 });
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('short'), 'append');
    const tool = tools.get(TURN_CONTINUATION_TOOL_NAME);
    await assert.rejects(tool.execute({ handoff: 'next' }, {
      agent: { session }, concludeTurn() {},
    }), /below first reminder milestone/);
    session.header.parentSession = 'parent';
    session.header.origin = 'subagent';
    session.header.delegationDepth = 1;
    await assert.rejects(tool.execute({ handoff: 'next' }, {
      agent: { session }, concludeTurn() {},
    }), /root conversation/);
  });

  test('accepts and recovers detailed handoffs without an arbitrary length cap', async () => {
    const tools = new Map<string, any>();
    const ctx = {
      tokenMeter: meter,
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
      systemPrompt: { context() {} },
      sessions: { flush: async () => {} },
      logger: { info() {}, warn() {} },
    };
    new TurnContinuationController(ctx, { reminderIntervalNodes: 1 });
    const session = fixtureSession();
    session.append('turn/start', { turn: 4 });
    session.append('user/message', message('begin'), 'append');
    const handoff = 'Detailed continuation state. '.repeat(100);
    assert.ok(handoff.length > 2_000);

    let concluded = false;
    const tool = tools.get(TURN_CONTINUATION_TOOL_NAME);
    const result = await tool.execute({ handoff }, {
      agent: { session },
      callId: 'call-long-handoff',
      concludeTurn: () => { concluded = true; },
    });
    assert.equal(concluded, true);

    session.append('tool/call', {
      turn: 4,
      step: 1,
      callId: 'call-long-handoff',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: JSON.stringify({ handoff }),
    });
    session.append('tool/result', {
      turn: 4,
      step: 1,
      message: {
        id: 'result-long-handoff',
        role: 'user',
        source: { kind: 'tool', callId: 'call-long-handoff' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-long-handoff',
          content: [{ type: 'text', text: result }],
          isError: false,
        }],
      },
    });
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });

    assert.equal(continuationRequestForTurn(session, 4)?.handoff, handoff.trim());
  });

  test('recovers a successful Code Mode sub-dispatch as the same durable request', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 3 });
    session.append('tool/code-dispatch-start', {
      rootCallId: 'run-code-1',
      parentCallId: 'run-code-1',
      subCallId: 'run-code-1:code:0',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: { handoff: 'Resume the code-mode verification.' },
    });
    session.append('tool/code-dispatch', {
      rootCallId: 'run-code-1',
      parentCallId: 'run-code-1',
      subCallId: 'run-code-1:code:0',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: { handoff: 'Resume the code-mode verification.' },
      isError: false,
      content: [{ type: 'text', text: 'queued' }],
    });
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });

    assert.deepEqual(continuationRequestForTurn(session, 3), {
      version: 1,
      requestId: 'run-code-1:code:0',
      turn: 3,
      handoff: 'Resume the code-mode verification.',
    });
  });
});
