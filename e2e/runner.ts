import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSurface } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'turn-memory-e2e-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionQuery', 'sessions', 'tools'];

const TOOL_SENTINEL = 'E2E-FIXTURE-ALPHA-771';
const FINAL_SENTINEL = 'PARENT-FINAL-BETA-332';
const DRAFT_SENTINEL = '__DRAFT_PASS__';

function textOf(event: any): string {
  return (event?.data?.message?.content ?? event?.data?.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('');
}

function checkpoints(session: any): any[] {
  return session.surface.nodes
    .map((seq: number) => session.events[seq])
    .filter((event: any) => event?.data?.source?.plugin === 'turn-memory' && event.data.source.phase === 'editor-smoke');
}

async function waitForCheckpoint(session: any, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = checkpoints(session);
    if (found.length > 0) return found[found.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the turn-memory replacement after ' + timeoutMs + 'ms');
}

function assertProjection(session: any, checkpoint: any, phase: string): void {
  const folded = foldSurface(session.events);
  assert.deepEqual(folded.nodes, [...session.surface.nodes], phase + ': live surface must equal full fold replay');
  assert.equal(checkpoints(session).length, 1, phase + ': expected exactly one turn-memory checkpoint on surface');
  assert.equal(checkpoint.type, 'assistant/message', phase + ': checkpoint must be a complete assistant message');
  assert.equal(checkpoint.surfaceOp?.op, 'replace', phase + ': checkpoint must be a positional replacement');
  assert.equal(checkpoint.sourceEventSeqs.length, checkpoint.data.source.originalNodes, phase + ': coverage metadata must match original node count');
  assert.ok(checkpoint.data.source.originalNodes >= 3, phase + ': fixture turn should exercise a multi-node merge');
  assert.ok(checkpoint.data.source.mutations >= 2, phase + ': generated id should have been edited again');
  const text = textOf(checkpoint);
  assert.ok(text.includes(TOOL_SENTINEL), phase + ': tool-result sentinel missing from summary');
  assert.ok(text.includes(FINAL_SENTINEL), phase + ': final assistant sentinel missing from summary');
  assert.ok(!text.includes(DRAFT_SENTINEL), phase + ': draft-pass sentinel leaked into final summary');
  const derivedText = session.deriveMessages().flatMap((message: any) => message.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');
  assert.ok(derivedText.includes(TOOL_SENTINEL) && derivedText.includes(FINAL_SENTINEL), phase + ': deriveMessages lost checkpoint text');
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
  let fixtureCalls = 0;
  const setup = (agentCtx: any) => {
    installModelSelection(agentCtx, {
      current: { ...selection, reasoningEffort: 'off' },
      assembled: undefined,
    });
    agentCtx.tools.register(defineTool({
      name: 'turn_memory_e2e_fixture',
      description: 'Deterministic fixture for the turn-memory e2e test. Call exactly once when instructed.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false,
      async execute() {
        fixtureCalls += 1;
        return TOOL_SENTINEL + ': the fixture tool observed cobalt=17 and path=/tmp/turn-memory-e2e.';
      },
    }));
  };

  let liveHandle: any;
  let coldHandle: any;
  try {
    liveHandle = await agents.create({
      sessionId: 'session-turn-memory-e2e-' + randomUUID(),
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
        text: 'Call turn_memory_e2e_fixture exactly once. After it returns, reply with exactly: ' + FINAL_SENTINEL + ': parent turn complete.',
      }],
      source: { kind: 'user' },
    });
    await agent.whenIdle();
    assert.equal(fixtureCalls, 1, 'parent fixture tool should run exactly once');
    const timeoutMs = Number(process.env.TURN_MEMORY_E2E_TIMEOUT_MS ?? 240000);
    const checkpoint = await waitForCheckpoint(agent.session, timeoutMs);
    assertProjection(agent.session, checkpoint, 'live');
    await sessions.flush(agent.session);
    const sessionId = agent.session.id;
    const expectedCheckpointSeq = checkpoint.seq;
    await liveHandle.dispose();
    liveHandle = undefined;

    coldHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await coldHandle.agent.whenIdle();
    const coldCheckpoint = checkpoints(coldHandle.agent.session)[0];
    assert.ok(coldCheckpoint !== undefined, 'cold load lost the replacement checkpoint');
    assert.equal(coldCheckpoint.seq, expectedCheckpointSeq, 'cold load changed checkpoint identity');
    assertProjection(coldHandle.agent.session, coldCheckpoint, 'cold');
    await sessions.flush(coldHandle.agent.session);
    const snapshot = await sessionQuery.readSurface(sessionId);
    const expectedSurfaceEvents = coldHandle.agent.session.surface.nodes
      .map((seq: number) => coldHandle.agent.session.events[seq]);
    assert.deepEqual(snapshot.events, expectedSurfaceEvents, 'sessionQuery surface must equal the cold live surface');
    const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
    const surfacePath = resolve(artifactDir, 'e2e-surface-' + sessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log('E2E_SESSION_ID=' + sessionId);
    console.log('E2E_REPLACEMENT=' + checkpoint.data.source.originalNodes + '->1');
    console.log('E2E_MUTATIONS=' + checkpoint.data.source.mutations);
    console.log('E2E_SURFACE_PATH=' + surfacePath);
    console.log('E2E_RESULT=PASS');
  } finally {
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (liveHandle !== undefined) await liveHandle.dispose();
  }
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('turn-memory-e2e-runner requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('E2E_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
