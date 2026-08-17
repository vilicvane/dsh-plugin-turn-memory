import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSurface } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TURN_TOOL_NAMES } from '../index.ts';
import { SESSION_TOOL_NAMES } from '../lib/session-compaction.ts';

const name = 'turn-memory-e2e-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionQuery', 'sessions', 'tools'];

const USER_SENTINEL = 'E2E-USER-GAMMA-194';
const TOOL_SENTINEL = 'E2E-FIXTURE-ALPHA-771';
const FINAL_SENTINEL = 'PARENT-FINAL-BETA-332';
const DRAFT_SENTINEL = '__DRAFT_PASS__';
const INTERNAL_TOOL_NAMES = [...TURN_TOOL_NAMES, ...SESSION_TOOL_NAMES];

function textOf(event: any): string {
  return (event?.data?.message?.content ?? event?.data?.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('');
}

function compressionNodes(session: any): any[] {
  return session.surface.nodes
    .map((seq: number) => session.events[seq])
    .filter((event: any) => event?.data?.source?.plugin === 'turn-memory' && event.data.source.phase === 'compression');
}

function assertInternalToolsHidden(session: any, phase: string): void {
  const visible = new Set((session.requestHeader()?.tools ?? []).map((tool: any) => tool.name));
  for (const name of INTERNAL_TOOL_NAMES) {
    assert.ok(!visible.has(name), phase + ': internal worker tool leaked into the parent request header: ' + name);
  }
}

async function waitForCompression(session: any, timeoutMs: number): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = compressionNodes(session);
    if (found.length === 2) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the turn-memory compression after ' + timeoutMs + 'ms');
}

function assertProjection(session: any, nodes: any[], phase: string): void {
  const folded = foldSurface(session.events);
  assert.deepEqual(folded.nodes, [...session.surface.nodes], phase + ': live surface must equal full fold replay');
  assert.equal(compressionNodes(session).length, 2, phase + ': expected exactly one compressed user-assistant exchange on surface');
  assert.equal(nodes[0].type, 'user/message', phase + ': first compressed node must be a user message');
  assert.equal(nodes[1].type, 'assistant/message', phase + ': second compressed node must be an assistant message');
  for (const node of nodes) {
    assert.equal(node.surfaceOp?.op, 'replace', phase + ': compressed nodes must be positional replacements');
    assert.equal(node.sourceEventSeqs.length, node.data.source.originalNodes, phase + ': each output must cite the complete joint source range');
    assert.ok(node.data.source.originalNodes >= 4, phase + ': fixture turn should exercise a four-node-or-larger joint rewrite');
    assert.ok(node.data.source.mutations >= 2, phase + ': generated ids should have been edited again');
    assert.equal(node.data.source.workerAttempts, 2,
      phase + ': accepted progress should reset a one-attempt budget and allow a second fork');
    assert.ok(!textOf(node).includes(DRAFT_SENTINEL), phase + ': draft-pass sentinel leaked into final compression');
  }
  assert.ok(textOf(nodes[0]).includes(USER_SENTINEL), phase + ': initial user sentinel missing from compressed user node');
  assert.ok(textOf(nodes[1]).includes(TOOL_SENTINEL), phase + ': tool-result sentinel missing from compressed assistant node');
  assert.ok(textOf(nodes[1]).includes(FINAL_SENTINEL), phase + ': final assistant sentinel missing from compressed assistant node');
  const derivedText = session.deriveMessages().flatMap((message: any) => message.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');
  assert.ok(
    derivedText.includes(USER_SENTINEL) && derivedText.includes(TOOL_SENTINEL) && derivedText.includes(FINAL_SENTINEL),
    phase + ': deriveMessages lost compressed transcript text',
  );
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
      current: { ...selection },
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
  let recoveryHandle: any;
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
        text: USER_SENTINEL + ': Call turn_memory_e2e_fixture exactly once. After it returns, reply with exactly: ' + FINAL_SENTINEL + ': parent turn complete.',
      }],
      source: { kind: 'user' },
    });
    await agent.whenIdle();
    assert.equal(fixtureCalls, 1, 'parent fixture tool should run exactly once');
    assertInternalToolsHidden(agent.session, 'live parent');
    const timeoutMs = Number(process.env.TURN_MEMORY_E2E_TIMEOUT_MS ?? 240000);
    await sessions.flush(agent.session);
    assert.equal(compressionNodes(agent.session).length, 0, 'live turn should be intentionally left uncompressed for recovery');
    const sessionId = agent.session.id;
    await liveHandle.dispose();
    liveHandle = undefined;

    recoveryHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await recoveryHandle.agent.whenIdle();
    assertInternalToolsHidden(recoveryHandle.agent.session, 'recovered parent');
    const compressed = await waitForCompression(recoveryHandle.agent.session, timeoutMs);
    assertProjection(recoveryHandle.agent.session, compressed, 'recovered');
    await sessions.flush(recoveryHandle.agent.session);
    const expectedCompressionSeqs = compressed.map((node) => node.seq);
    await recoveryHandle.dispose();
    recoveryHandle = undefined;

    coldHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await coldHandle.agent.whenIdle();
    const coldCompression = compressionNodes(coldHandle.agent.session);
    assert.deepEqual(coldCompression.map((node) => node.seq), expectedCompressionSeqs,
      'second cold load duplicated or changed recovered compression identities');
    assertProjection(coldHandle.agent.session, coldCompression, 'cold');
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
    console.log('E2E_REPLACEMENT=' + compressed[0].data.source.originalNodes + '->2');
    console.log('E2E_MUTATIONS=' + compressed[0].data.source.mutations);
    console.log('E2E_WORKER_ATTEMPTS=' + compressed[0].data.source.workerAttempts);
    console.log('E2E_RECOVERY=agent-resume-backfill');
    console.log('E2E_SURFACE_PATH=' + surfacePath);
    console.log('E2E_RESULT=PASS');
  } finally {
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (recoveryHandle !== undefined) await recoveryHandle.dispose();
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
