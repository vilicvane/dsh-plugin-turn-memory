import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSurface } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'turn-memory-prompt-eval-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionQuery', 'sessions', 'tools'];

function textOf(event: any): string {
  const chunks: string[] = [];
  const visit = (value: any): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.type === 'text' && typeof value.text === 'string') chunks.push(value.text);
    if (Object.hasOwn(value, 'content')) visit(value.content);
  };
  visit(event?.data?.message?.content ?? event?.data?.content ?? []);
  return chunks.join('\n');
}

function compressionNodes(session: any): any[] {
  return session.surface.nodes
    .map((seq: number) => session.events[seq])
    .filter((event: any) => event?.data?.source?.plugin === 'turn-memory' && event.data.source.phase === 'compression');
}

async function waitForCompression(session: any, timeoutMs: number): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = compressionNodes(session);
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for production-prompt compression after ' + timeoutMs + 'ms');
}

function fixtureTurn(session: any): { originalSeqs: number[]; originalUserSeqs: number[]; currentNodes: any[] } {
  const end = session.events.findLast((event: any) => event?.type === 'turn/end');
  if (end === undefined) throw new Error('fixture session has no completed turn');
  const start = session.events.findLast((event: any) => event?.type === 'turn/start' && event.data?.turn === end.data?.turn);
  if (start === undefined) throw new Error('fixture completed turn has no start');
  const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result']);
  const original = session.events.filter((event: any) => event?.seq > start.seq
    && event.seq <= end.seq
    && surfaceTypes.has(event.type)
    && event.surfaceOp === 'append');
  const originalSeqs = original.map((event: any) => event.seq);
  const originalUserSeqs = original
    .filter((event: any) => event.type === 'user/message' && event.data?.source?.kind === 'user')
    .map((event: any) => event.seq);
  const originalSet = new Set(originalSeqs);
  const currentNodes = session.surface.nodes
    .map((seq: number) => session.events[seq])
    .filter((event: any) => originalSet.has(event.seq)
      || (event?.data?.source?.plugin === 'turn-memory' && event.data.source.turn === end.data.turn));
  return { originalSeqs, originalUserSeqs, currentNodes };
}

function assertPromptCompression(session: any, nodes: any[], phase: string): void {
  assert.deepEqual(foldSurface(session.events).nodes, [...session.surface.nodes], phase + ': live surface must equal full fold replay');
  const fixture = fixtureTurn(session);
  assert.ok(fixture.originalSeqs.length >= 6, phase + ': fixture did not produce a substantial multi-step turn');
  assert.equal(fixture.originalUserSeqs.length, 2, phase + ': fixture must contain the initial request and one steer');
  assert.ok(fixture.currentNodes.length < fixture.originalSeqs.length, phase + ': production prompt did not compress the turn');

  const userNodes = fixture.currentNodes.filter((node) => node.type === 'user/message');
  assert.equal(userNodes.length, 1, phase + ': typo or missing-information steer must become one corrected user intent');
  assert.equal(userNodes[0].surfaceOp?.op, 'replace', phase + ': corrected user intent must replace the superseded messages');
  for (const sourceSeq of fixture.originalUserSeqs) {
    assert.ok(userNodes[0].sourceEventSeqs.includes(sourceSeq), phase + ': corrected user intent provenance omitted user source ' + sourceSeq);
  }

  for (const node of nodes) {
    assert.equal(node.surfaceOp?.op, 'replace', phase + ': compressed nodes must be replacements');
    assert.equal(node.data.source.originalNodes, fixture.originalSeqs.length, phase + ': replacement marker has the wrong original node count');
  }

  const user = textOf(userNodes[0]).toLowerCase();
  const retainedWork = fixture.currentNodes.filter((node) => node.type !== 'user/message').map(textOf).join('\n').toLowerCase();
  assert.match(user, /home/, phase + ': consolidated user intent lost home');
  assert.match(user, /playground/, phase + ': consolidated user intent lost the steer');
  assert.match(retainedWork, /\/repo/, phase + ': compression erased the failed detour');
  assert.match(retainedWork, /does not exist|不存在/, phase + ': compression erased why the detour failed');
  assert.match(retainedWork, /6/, phase + ': compression lost the device-type conclusion');
  assert.match(retainedWork, /9/, phase + ': compression lost the device-count conclusion');
}

async function run(ctx: any): Promise<void> {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const sessionQuery = ctx.get('sessionQuery');
  const sessions = ctx.get('sessions');
  const defaultModel = ctx.get('agentDefaultModel');
  if (agents === undefined || sessionQuery === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error('required DSH services are missing');
  }

  const selection = defaultModel.currentSelection();
  const inspected: string[] = [];
  let steerSent = false;
  const setup = (agentCtx: any) => {
    installModelSelection(agentCtx, {
      current: { ...selection, reasoningEffort: 'max' },
      assembled: undefined,
    });
    agentCtx.tools.restrict({ allow: [] });
    agentCtx.tools.register(defineTool({
      name: 'inspect_home_fixture',
      description: 'Inspect the home-device declaration at the target named by the latest user message. Use /repo or playground exactly.',
      parameters: {
        target: { type: 'string', required: true, enum: ['/repo', 'playground'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false,
      async execute(args) {
        const target = String(args.target);
        inspected.push(target);
        if (target === '/repo') {
          return 'The attempt failed because /repo does not exist, so it produced no device conclusion.';
        }
        return 'Conclusion from packages/playground/src/program/home.ts: the home declares 6 device types and 9 device instances.';
      },
    }));
    agentCtx.on('agent/turn-stopping', ({ agent }: any) => {
      if (steerSent || inspected.length !== 1 || inspected[0] !== '/repo') return;
      steerSent = true;
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: '刚才目录说错了：我一开始指的就是 playground，不是 /repo。前面的检查算作因口误走偏的试错。',
        }],
        source: { kind: 'user' },
      });
    });
  };

  let liveHandle: any;
  let coldHandle: any;
  try {
    liveHandle = await agents.create({
      sessionId: 'session-turn-memory-prompt-eval-' + randomUUID(),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    const agent = liveHandle.agent;
    await agent.whenIdle();
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: 'home 中用到了哪些设备？先调用 inspect_home_fixture 检查 /repo，并根据结果回答。',
      }],
      source: { kind: 'user' },
    });
    await agent.whenIdle();
    assert.deepEqual(inspected, ['/repo', 'playground'], 'parent turn must follow the failed path and then the steer');

    const timeoutMs = Number(process.env.TURN_MEMORY_PROMPT_EVAL_TIMEOUT_MS ?? 300000);
    const compressed = await waitForCompression(agent.session, timeoutMs);
    assertPromptCompression(agent.session, compressed, 'live');
    await sessions.flush(agent.session);
    const sessionId = agent.session.id;
    const expectedCompressionSeqs = compressed.map((node) => node.seq);
    await liveHandle.dispose();
    liveHandle = undefined;

    coldHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await coldHandle.agent.whenIdle();
    const coldCompression = compressionNodes(coldHandle.agent.session);
    assert.deepEqual(coldCompression.map((node) => node.seq), expectedCompressionSeqs, 'cold load changed compression identities');
    assertPromptCompression(coldHandle.agent.session, coldCompression, 'cold');
    await sessions.flush(coldHandle.agent.session);

    const snapshot = await sessionQuery.readSurface(sessionId);
    const expectedSurfaceEvents = coldHandle.agent.session.surface.nodes
      .map((seq: number) => coldHandle.agent.session.events[seq]);
    assert.deepEqual(snapshot.events, expectedSurfaceEvents, 'sessionQuery surface must equal the cold live surface');
    const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
    const surfacePath = resolve(artifactDir, 'prompt-eval-surface-' + sessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log('PROMPT_EVAL_SESSION_ID=' + sessionId);
    const coldFixture = fixtureTurn(coldHandle.agent.session);
    const coldUser = coldFixture.currentNodes.find((node) => node.type === 'user/message');
    console.log('PROMPT_EVAL_REPLACEMENT=' + coldFixture.originalSeqs.length + '->' + coldFixture.currentNodes.length);
    console.log('PROMPT_EVAL_USER=' + JSON.stringify(textOf(coldUser)));
    console.log('PROMPT_EVAL_RETAINED_WORK=' + JSON.stringify(coldFixture.currentNodes.filter((node) => node.type !== 'user/message').map(textOf).join('\n')));
    console.log('PROMPT_EVAL_SURFACE_PATH=' + surfacePath);
    console.log('PROMPT_EVAL_RESULT=PASS');
  } finally {
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (liveHandle !== undefined) await liveHandle.dispose();
  }
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('turn-memory-prompt-eval-runner requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('PROMPT_EVAL_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
