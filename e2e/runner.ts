import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSurface } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TURN_TOOL_NAMES } from '../index.ts';
import { SESSION_TOOL_NAMES } from '../lib/session-compaction.ts';
import { READ_MEMORY_IMAGE_TOOL_NAME } from '../lib/memory-images.ts';
import { READ_SESSION_HISTORY_TOOL_NAME } from '../lib/session-history.ts';
import {
  TURN_CONTINUATION_TOOL_NAME,
  continuationRequestForTurn,
} from '../lib/turn-continuation.ts';

const name = 'turn-memory-e2e-runner';
const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessionQuery', 'sessions', 'tools'];

const USER_SENTINEL = 'E2E-USER-GAMMA-194';
const TOOL_SENTINEL = 'E2E-FIXTURE-ALPHA-771';
const FINAL_SENTINEL = 'PARENT-FINAL-BETA-332';
const CONTINUATION_SENTINEL = 'CONTINUATION-DELTA-908';
const DRAFT_SENTINEL = '__DRAFT_PASS__';
const INTERNAL_TOOL_NAMES = [...TURN_TOOL_NAMES, ...SESSION_TOOL_NAMES];
const CONTINUATION_CONTEXT_NAME = 'turn-memory:long-turn-continuation';
const E2E_PARENT_TOOL_NAMES = new Set([
  'turn_memory_e2e_fixture',
  READ_MEMORY_IMAGE_TOOL_NAME,
  READ_SESSION_HISTORY_TOOL_NAME,
  TURN_CONTINUATION_TOOL_NAME,
]);

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
  assert.ok(visible.has(READ_MEMORY_IMAGE_TOOL_NAME), phase + ': public lazy-memory image tool is missing');
  assert.ok(visible.has(READ_SESSION_HISTORY_TOOL_NAME), phase + ': public append-only history fallback is missing');
  assert.ok(visible.has(TURN_CONTINUATION_TOOL_NAME), phase + ': public long-turn continuation tool is missing');
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

async function waitForContinuation(session: any, timeoutMs: number): Promise<{ user: any; assistant: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const user = session.events.find((event: any) =>
      event?.type === 'user/message'
      && event.data?.source?.plugin === 'turn-memory'
      && event.data.source.phase === 'continuation');
    const assistant = user === undefined ? undefined : session.events.find((event: any) =>
      event?.type === 'assistant/message'
      && event.seq > user.seq
      && textOf(event).includes(CONTINUATION_SENTINEL));
    if (user !== undefined && assistant !== undefined) return { user, assistant };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the automatic continuation turn after ' + timeoutMs + 'ms');
}

function assertProjection(session: any, nodes: any[], phase: string): void {
  const folded = foldSurface(session.events);
  assert.deepEqual(folded.nodes, [...session.surface.nodes], phase + ': live surface must equal full fold replay');
  assert.equal(compressionNodes(session).length, 2, phase + ': expected exactly one compressed user-assistant exchange on surface');
  assert.equal(nodes[0].type, 'user/message', phase + ': first compressed node must be a user message');
  assert.equal(nodes[1].type, 'assistant/message', phase + ': second compressed node must be an assistant message');
  for (const node of nodes) {
    assert.equal(node.surfaceOp?.op, 'replace', phase + ': compressed nodes must be positional replacements');
    assert.equal(new Set(node.sourceEventSeqs).size, node.sourceEventSeqs.length,
      phase + ': replacement source provenance must not contain duplicates');
    assert.ok(node.sourceEventSeqs.length >= node.data.source.originalNodes,
      phase + ': each output must cite the complete joint semantic source range and its landing coverage');
    assert.ok(node.data.source.originalNodes >= 4, phase + ': fixture turn should exercise a four-node-or-larger joint rewrite');
    assert.ok(node.data.source.mutations >= 2, phase + ': generated ids should have been edited again');
    assert.equal(node.data.source.workerAttempts, 2,
      phase + ': accepted progress should reset a one-attempt budget and allow a fresh-spawn recovery worker');
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
  const agentPresets = ctx.get('agentPresets');
  if (agents === undefined || sessionQuery === undefined || sessions === undefined || defaultModel === undefined
    || agentPresets === undefined) {
    throw new Error('required DSH services are missing');
  }
  const selection = defaultModel.currentSelection();
  const workerProviders: string[] = [];
  const disposeLifecycle = ctx.on('subagent/start', (info: any) => workerProviders.push(String(info.provider)));
  let fixtureCalls = 0;
  const setup = async (agentCtx: any) => {
    // rc.8's shipped minimal preset suppresses every runtime context, including
    // the continuation notice this scenario exercises. Use a runtime-enabled
    // shipped composition, then isolate the parent request to this fixture's
    // persona, public tools, and the one context under test.
    await agentPresets.mount(agentCtx, 'standard');
    agentCtx.systemPrompt.section({
      name: 'turn-memory:e2e-parent-persona',
      order: 0,
      complete: true,
      text: 'You are a deterministic Turn Memory E2E agent. Follow the user request and active host runtime context exactly.',
    });
    agentCtx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: () => Promise<any>) => {
      const assembled = await next();
      return {
        ...assembled,
        contexts: assembled.contexts.filter((entry: any) => entry.name === CONTINUATION_CONTEXT_NAME),
        tools: assembled.tools.filter((tool: any) => E2E_PARENT_TOOL_NAMES.has(tool.name)),
      };
    });
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
  let continuationLiveHandle: any;
  let continuationRecoveryHandle: any;
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
    assert.deepEqual(workerProviders, ['fork', 'spawn'],
      'turn recovery must begin with one parent fork and continue accepted progress in a fresh spawn');
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

    continuationLiveHandle = await agents.create({
      sessionId: 'session-turn-memory-continuation-e2e-' + randomUUID(),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await continuationLiveHandle.agent.whenIdle();
    continuationLiveHandle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: USER_SENTINEL + ': Call turn_memory_e2e_fixture exactly once. After it returns, the remaining work is: '
          + FINAL_SENTINEL + ': reply with exactly ' + CONTINUATION_SENTINEL
          + ' and do no other work. Follow any active Turn Memory continuation instruction before completing that remaining work.',
      }],
      source: { kind: 'user' },
    });
    await continuationLiveHandle.agent.whenIdle();
    const continuationRequest = continuationRequestForTurn(continuationLiveHandle.agent.session, 1);
    assert.notEqual(continuationRequest, undefined, 'long live turn did not record a durable continuation request');
    assert.equal(compressionNodes(continuationLiveHandle.agent.session).length, 0,
      'continuation fixture should defer live compression until recovery');
    const continuationSessionId = continuationLiveHandle.agent.session.id;
    await sessions.flush(continuationLiveHandle.agent.session);
    await continuationLiveHandle.dispose();
    continuationLiveHandle = undefined;

    continuationRecoveryHandle = await agents.resume({
      resumeSessionId: continuationSessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    const continuationCompressed = await waitForCompression(continuationRecoveryHandle.agent.session, timeoutMs);
    assert.deepEqual(workerProviders, ['fork', 'spawn', 'fork', 'spawn'],
      'each turn job must begin with one fork and use a fresh spawn for its recovery worker');
    assertProjection(continuationRecoveryHandle.agent.session, continuationCompressed, 'continuation recovery');
    const continued = await waitForContinuation(continuationRecoveryHandle.agent.session, timeoutMs);
    assert.match(textOf(continued.user), /not new human input/,
      'automatic follow-up did not disclose its plugin origin');
    assert.ok(continued.assistant.data.turn > continuationRequest!.turn,
      'automatic continuation did not open a later turn');
    await sessions.flush(continuationRecoveryHandle.agent.session);
    const continuationSnapshot = await sessionQuery.readSurface(continuationSessionId);
    const continuationSurfacePath = resolve(artifactDir, 'e2e-surface-' + continuationSessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(continuationSurfacePath, JSON.stringify(continuationSnapshot, null, 2) + '\n', 'utf8');

    const surfacePath = resolve(artifactDir, 'e2e-surface-' + sessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log('E2E_SESSION_ID=' + sessionId);
    console.log('E2E_REPLACEMENT=' + compressed[0].data.source.originalNodes + '->2');
    console.log('E2E_MUTATIONS=' + compressed[0].data.source.mutations);
    console.log('E2E_WORKER_ATTEMPTS=' + compressed[0].data.source.workerAttempts);
    console.log('E2E_RECOVERY=agent-resume-backfill');
    console.log('E2E_CONTINUATION=compressed-then-followup');
    console.log('E2E_CONTINUATION_SURFACE_PATH=' + continuationSurfacePath);
    console.log('E2E_SURFACE_PATH=' + surfacePath);
    console.log('E2E_RESULT=PASS');
  } finally {
    disposeLifecycle();
    if (continuationRecoveryHandle !== undefined) await continuationRecoveryHandle.dispose();
    if (continuationLiveHandle !== undefined) await continuationLiveHandle.dispose();
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
