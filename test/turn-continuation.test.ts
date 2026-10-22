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
  DEFAULT_REMINDER_INTERVAL_NODES,
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
  return { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq], surface, header: {}, append };
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
    }), { op: 'replace', startSeq: 0, endSeq: 0 });
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
    assert.match(notice, /This turn ends here; a fresh turn continues from the compressed memory/);
    assert.match(notice, /End the turn with `continue_after_turn_compression` \(no arguments\) as the last action/);
    assert.match(notice, /the host compresses this turn and continues from that memory in a new turn/);
    assert.doesNotMatch(notice, /wrap-up|progress summary/);
    assert.match(notice, /whole task finishes in the next few actions, finish it within this turn/);
    assert.doesNotMatch(notice, /handoff/);
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
    assert.match(secondNotice, /This turn ends here; a fresh turn continues from the compressed memory/);

    let concluded = false;
    const tool = tools.get(TURN_CONTINUATION_TOOL_NAME);
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-continuation-1',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: '{}',
    });
    const result = await tool.execute({}, {
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
        role: 'tool',
        source: { kind: 'tool', callId: 'call-continuation-1' },
        toolCallId: 'call-continuation-1',
        content: [{ type: 'text', text: result }],
        isError: false,
      },
    });
    const request = continuationRequestForTurn(session, 1);
    assert.deepEqual(request, { version: 2, requestId: 'call-continuation-1', turn: 1 });
    assert.equal(contexts[0].text({ agent }), '');
    assert.equal(controller.needsDispatchAfterCompression(session, 1), true);

    assert.equal(await controller.dispatchAfterCompression(agent, 1), true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content[0].text, /not new human input/);
    assert.match(delivered[0].content[0].text, /Resume the unfinished work now from the compressed turn above/);
    assert.doesNotMatch(delivered[0].content[0].text, /handoff/);
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
    await assert.rejects(tool.execute({}, {
      agent: { session }, concludeTurn() {},
    }), /below first reminder milestone/);
    session.header.parentSession = 'parent';
    session.header.origin = 'subagent';
    session.header.delegationDepth = 1;
    await assert.rejects(tool.execute({}, {
      agent: { session }, concludeTurn() {},
    }), /root conversation/);
  });

  test('does not dispatch a continuation superseded by a later turn', async () => {
    const tools = new Map<string, any>();
    let flushes = 0;
    const ctx = {
      tokenMeter: meter,
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
      systemPrompt: { context() {} },
      sessions: { flush: async () => { flushes += 1; } },
      logger: { info() {}, warn() {} },
    };
    const controller = new TurnContinuationController(ctx, { reminderIntervalNodes: 1 });
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('work'), 'append');
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-superseded',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: '{}',
    });
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'result-superseded',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-superseded' },
        toolCallId: 'call-superseded',
        content: [{ type: 'text', text: 'Continuation queued.' }],
        isError: false,
      },
    });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal(controller.needsDispatchAfterCompression(session, 1), true);
    session.append('turn/start', { turn: 2 });
    assert.equal(controller.needsDispatchAfterCompression(session, 1), false);
    const delivered: any[] = [];
    assert.equal(await controller.dispatchAfterCompression({ session, followup: (value: any) => delivered.push(value) }, 1), false);
    assert.equal(delivered.length, 0);
    assert.equal(flushes, 0);
  });

  test('records a payload-free request that does not depend on model prose', async () => {
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

    let concluded = false;
    const tool = tools.get(TURN_CONTINUATION_TOOL_NAME);
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} },
      'the continuation request takes no payload');
    const result = await tool.execute({}, {
      agent: { session },
      callId: 'call-payload-free',
      concludeTurn: () => { concluded = true; },
    });
    assert.equal(concluded, true);

    session.append('tool/call', {
      turn: 4,
      step: 1,
      callId: 'call-payload-free',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: '{}',
    });
    session.append('tool/result', {
      turn: 4,
      step: 1,
      message: {
        id: 'result-payload-free',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-payload-free' },
        toolCallId: 'call-payload-free',
        content: [{ type: 'text', text: result }],
        isError: false,
      },
    });
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });

    assert.deepEqual(continuationRequestForTurn(session, 4), {
      version: 2,
      requestId: 'call-payload-free',
      turn: 4,
    });
  });

  test('recovers a successful ptc-mode sub-dispatch as the same durable request', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 3 });
    session.append('tool/ptc-dispatch-start', {
      rootCallId: 'run-code-1',
      parentCallId: 'run-code-1',
      subCallId: 'run-code-1:ptc:0',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: {},
    });
    session.append('tool/ptc-dispatch', {
      rootCallId: 'run-code-1',
      parentCallId: 'run-code-1',
      subCallId: 'run-code-1:ptc:0',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: {},
      isError: false,
      content: [{ type: 'text', text: 'queued' }],
    });
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });

    assert.deepEqual(continuationRequestForTurn(session, 3), {
      version: 2,
      requestId: 'run-code-1:ptc:0',
      turn: 3,
    });
  });

  test('ignores a failed tool result when recovering the durable request', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 5 });
    session.append('tool/call', {
      turn: 5,
      step: 1,
      callId: 'call-failed-continuation',
      name: TURN_CONTINUATION_TOOL_NAME,
      arguments: '{}',
    });
    session.append('tool/result', {
      turn: 5,
      step: 1,
      message: {
        id: 'result-failed-continuation',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-failed-continuation' },
        toolCallId: 'call-failed-continuation',
        content: [{ type: 'text', text: 'rejected' }],
        isError: true,
      },
    });
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } });

    assert.equal(continuationRequestForTurn(session, 5), undefined,
      'message-level isError must veto the request, not a legacy content block');
  });
});

test('defaults the first continuation milestone to 120 open-turn nodes', () => {
  assert.equal(DEFAULT_REMINDER_INTERVAL_NODES, 120);
  assert.equal(continuationMilestone(119, DEFAULT_REMINDER_INTERVAL_NODES), 0,
    'a 119-node open turn stays below the first milestone');
  assert.equal(continuationMilestone(120, DEFAULT_REMINDER_INTERVAL_NODES), 120);
  assert.equal(continuationMilestone(239, DEFAULT_REMINDER_INTERVAL_NODES), 120,
    'milestones stay at 120 until the next full interval');
  assert.equal(continuationMilestone(240, DEFAULT_REMINDER_INTERVAL_NODES), 240);
});
