import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ThoughtHintsController } from '../lib/thought-hints.ts';

const prompt = readFileSync(new URL('../prompts/thought-hints.md', import.meta.url), 'utf8').trim();

function success(text: string): AsyncIterable<any> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

function failure(message: string): AsyncIterable<any> {
  return (async function* () {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message, code: 'TEST_FAILURE' } },
    };
  })();
}

function fixture(
  respond: (rawThought: string, options: any) => AsyncIterable<any> = (raw) => success('hint for ' + raw),
  overrides: Record<string, unknown> = {},
) {
  const calls: any[] = [];
  const logs: string[] = [];
  const listeners = new Map<string, Array<(payload: any) => void>>();
  const ctx = {
    llm: {
      stream(options: any) {
        calls.push(options);
        return respond(options.messages[0].content[0].text, options);
      },
    },
    logger: {
      info(value: string) { logs.push('info ' + value); },
      warn(value: string) { logs.push('warn ' + value); },
    },
    on(event: string, handler: (payload: any) => void) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
  };
  const controller = new ThoughtHintsController(ctx, {
    provider: 'local-test',
    model: 'small-test',
    minimumChars: 4,
    maxTokens: 123,
    ...overrides,
  });
  const emit = (event: string, payload: any): void => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  return { calls, controller, logs, emit };
}

/**
 * Replays a live model attempt the way 0.1.5 dispatches it: one `start` frame
 * (carrying the turn/step) followed by `block-end` reasoning chunks. Replaces
 * the pre-0.1.5 durable `assistant/chunk` events, which no longer exist.
 */
function emitStream(
  emit: (event: string, payload: any) => void,
  session: any,
  turn: number,
  step: number,
  blocks: Array<{ index: number; text: string }>,
  attemptId = 'attempt-1',
): void {
  emit('agent/assistant-stream', { agent: { session }, frame: { type: 'start', attemptId, revision: 1, turn, step } });
  for (const block of blocks) {
    emit('agent/assistant-stream', {
      agent: { session },
      frame: {
        type: 'chunk',
        attemptId,
        revision: 1,
        index: block.index,
        time: 0,
        chunk: { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } },
      },
    });
  }
}

function assistantMessage(turn: number, step: number, seq: number, thoughts: string[]): any {
  return {
    seq,
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        content: thoughts.map((text) => ({ type: 'reasoning', text })),
      },
      stream: thoughts.map((text, index) => ({ type: 'reasoning-chunks', time0: 0, index, dt: [], texts: [text] })),
    },
  };
}

describe('ThoughtHintsController', () => {
  it('asks for implementation-ready continuation state rather than a general summary', () => {
    assert.match(prompt, /re-derivation cost/);
    assert.match(prompt, /implementation-ready work products/);
    assert.match(prompt, /interfaces, types, schemas, state machines/);
    assert.match(prompt, /rejected alternatives/);
    assert.match(prompt, /do not reduce it to a topic label/);
    assert.match(prompt, /offer further work/);
  });

  it('starts at block-end and sends only the fixed system prompt plus one raw-thought user message', async () => {
    const { calls, controller, emit } = fixture();
    const session: any = { id: 's1', header: {}, events: [], snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; } };
    session.events[2] = assistantMessage(1, 1, 2, ['long thought']);

    emitStream(emit, session, 1, 1, [{ index: 0, text: 'long thought' }]);
    assert.equal(calls.length, 1, 'request starts before turn collection');
    assert.equal(calls[0].system, prompt);
    assert.equal(calls[0].provider, 'local-test');
    assert.equal(calls[0].model, 'small-test');
    assert.equal(calls[0].maxTokens, 123);
    assert.equal(calls[0].purpose, 'compaction');
    assert.equal(calls[0].messages.length, 1);
    assert.equal(calls[0].messages[0].role, 'user');
    assert.deepEqual(calls[0].messages[0].content, [{ type: 'text', text: 'long thought' }]);
    assert.equal(Object.hasOwn(calls[0], 'tools'), false);

    assert.deepEqual(await controller.collectForTurn(session, 1, [2]), [{
      assistantSeq: 2,
      blockIndex: 0,
      chars: 12,
      text: 'hint for long thought',
    }]);
    controller.dispose();
  });

  it('starts several long blocks independently and ignores short thoughts', async () => {
    const { calls, controller, emit } = fixture();
    const session: any = { id: 's2', header: {}, events: [], snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; } };
    session.events[4] = assistantMessage(3, 4, 4, ['first long thought', 'no', 'second long thought']);

    emitStream(emit, session, 3, 4, [
      { index: 0, text: 'first long thought' },
      { index: 1, text: 'no' },
      { index: 2, text: 'second long thought' },
    ]);
    assert.equal(calls.length, 2, 'both eligible requests launch without waiting for turn/end');

    const hints = await controller.collectForTurn(session, 3, [4]);
    assert.deepEqual(hints.map((hint) => hint.blockIndex), [0, 2]);
    assert.deepEqual(hints.map((hint) => hint.text), ['hint for first long thought', 'hint for second long thought']);
    controller.dispose();
  });

  it('regenerates missing hints from durable assistant reasoning during recovery', async () => {
    const { calls, controller } = fixture();
    const session: any = { id: 'cold', header: {}, events: [], snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; } };
    session.events[1] = assistantMessage(8, 2, 1, ['durable long thought']);

    assert.equal(calls.length, 0);
    const hints = await controller.collectForTurn(session, 8, [1]);
    assert.equal(calls.length, 1);
    assert.deepEqual(hints, [{
      assistantSeq: 1,
      blockIndex: 0,
      chars: 20,
      text: 'hint for durable long thought',
    }]);
    controller.dispose();
  });

  it('drops failed or empty hint calls without blocking successful hints', async () => {
    const { controller, logs, emit } = fixture((raw) => {
      if (raw.startsWith('bad')) return failure('offline');
      if (raw.startsWith('empty')) return success('   ');
      return success('kept hint');
    });
    const session: any = { id: 'degrade', header: {}, events: [], snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; } };
    session.events[4] = assistantMessage(5, 1, 4, ['bad long thought', 'empty long thought', 'good long thought']);
    emitStream(emit, session, 5, 1, [
      { index: 0, text: 'bad long thought' },
      { index: 1, text: 'empty long thought' },
      { index: 2, text: 'good long thought' },
    ]);

    assert.deepEqual(await controller.collectForTurn(session, 5, [4]), [{
      assistantSeq: 4,
      blockIndex: 2,
      chars: 17,
      text: 'kept hint',
    }]);
    assert.ok(logs.some((line) => line.includes('raw reasoning remains available')));
    controller.dispose();
  });

  it('degrades a stuck auxiliary request to no hint after its timeout', async () => {
    const stuck = (_raw: string, options: any): AsyncIterable<any> => (async function* () {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    })();
    const { controller, logs, emit } = fixture(stuck, { timeoutMs: 10 });
    const session: any = { id: 'timeout', header: {}, events: [], snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; } };
    session.events[2] = assistantMessage(9, 1, 2, ['stuck long thought']);
    emitStream(emit, session, 9, 1, [{ index: 0, text: 'stuck long thought' }]);

    assert.deepEqual(await controller.collectForTurn(session, 9, [2]), []);
    assert.ok(logs.some((line) => line.includes('raw reasoning remains available')));
    controller.dispose();
  });
});
