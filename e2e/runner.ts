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
    .map((seq: number) => session.snapshotEvents()[seq])
    .filter((event: any) => event?.data?.source?.kind === 'turn-memory-compression');
}

function assertInternalToolsHidden(session: any, phase: string): void {
  const visible = new Set((session.requestHeader()?.tools ?? []).map((tool: any) => tool.name));
  assert.ok(visible.has(READ_MEMORY_IMAGE_TOOL_NAME), phase + ': public lazy-memory image tool is missing');
  assert.ok(visible.has(READ_SESSION_HISTORY_TOOL_NAME), phase + ': public append-only history fallback is missing');
  assert.ok(visible.has(TURN_CONTINUATION_TOOL_NAME), phase + ': public long-turn continuation tool is missing');
  for (const name of INTERNAL_TOOL_NAMES) {
    assert.ok(!visible.has(name), phase + ': internal worker tool leaked into the parent request header: ' + name);
  }
  const continuationTool = (session.requestHeader()?.tools ?? [])
    .find((tool: any) => tool.name === TURN_CONTINUATION_TOOL_NAME);
  assert.deepEqual(continuationTool?.parameters, { type: 'object', properties: {} },
    phase + ': the continuation request tool must be payload-free');
}

async function waitForCompression(session: any, timeoutMs: number, expected = 1): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = compressionNodes(session);
    if (found.length >= expected) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for ' + expected + ' turn-memory compression(s) after ' + timeoutMs + 'ms');
}

/**
 * Waits for the host-driven continuation turn to open. The continued turn is told nothing
 * by the host beyond the fixed three-line message: whatever the compressed checkpoint
 * preserved is the whole task. The assertion therefore stops at the mechanism (fixed
 * message inside a turn after the compressed one) instead of requiring the model to
 * reproduce a sentinel that the checkpoint may legitimately have compressed away.
 * Note the event order: `followup` opens the turn first (`turn/start`) and the queued
 * continuation message is spliced into it afterwards, so the enclosing `turn/start`
 * precedes the continuation message rather than following it.
 */
async function waitForContinuation(session: any, timeoutMs: number, fromTurn: number): Promise<{ user: any; turnStart: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = session.snapshotEvents();
    const user = events.find((event: any) =>
      event?.type === 'user/message'
      && event.data?.source?.kind === 'turn-memory-continuation');
    const turnStart = user === undefined ? undefined : events.find((event: any) =>
      event?.type === 'turn/start'
      && event.seq <= user.seq
      && (event.data?.turn ?? 0) > fromTurn);
    if (user !== undefined && turnStart !== undefined) return { user, turnStart };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the automatic continuation turn after ' + timeoutMs + 'ms');
}

function assertCheckpointShape(event: any, phase: string, expected: 'User' | 'Assistant'): void {
  const text = textOf(event);
  assert.ok(text.length > 0, phase + ': checkpoint must not be empty');
  assert.ok(text.startsWith(expected + ': '),
    phase + ': checkpoint must start with "' + expected + ': " but starts with ' + JSON.stringify(text.slice(0, 40)));
}

function assertProjection(session: any, nodes: any[], phase: string): void {
  const folded = foldSurface(session.snapshotEvents());
  assert.deepEqual(folded.nodes, [...session.surface.nodes], phase + ': live surface must equal full fold replay');
  // 0.2.1 lands a changed turn as one `user/message` checkpoint whenever any changed node
  // is not a user node: the whole range is replaced by a single message whose text is the
  // role-prefixed `User: … / Assistant: … / Tool result: …` collapse.
  assert.equal(nodes.length, 1, phase + ': fixture turn must fold into a single checkpoint');
  const checkpoint = nodes[0];
  assert.equal(checkpoint.type, 'user/message', phase + ': compressed range must land as a user message');
  assert.equal(checkpoint.surfaceOp?.op, 'replace', phase + ': compressed range must be a positional replacement');
  assert.equal(new Set(checkpoint.sourceEventSeqs).size, checkpoint.sourceEventSeqs.length,
    phase + ': replacement source provenance must not contain duplicates');
  assert.ok(checkpoint.sourceEventSeqs.length >= checkpoint.data.source.originalNodes,
    phase + ': the checkpoint must cite the complete joint semantic source range and its landing coverage');
  assert.ok(checkpoint.data.source.originalNodes >= 4,
    phase + ': fixture turn should exercise a four-node-or-larger joint rewrite');
  assert.ok(checkpoint.data.source.mutations >= 2, phase + ': generated ids should have been edited again');
  assert.equal(checkpoint.data.source.workerAttempts, 2,
    phase + ': accepted progress should reset a one-attempt budget and allow a fresh-spawn recovery worker');
  const checkpointText = textOf(checkpoint);
  assert.ok(!checkpointText.includes(DRAFT_SENTINEL), phase + ': draft-pass sentinel leaked into final compression');
  assert.ok(checkpointText.includes(USER_SENTINEL), phase + ': initial user sentinel missing from the checkpoint');
  assert.ok(checkpointText.includes(TOOL_SENTINEL), phase + ': tool-result sentinel missing from the checkpoint');
  assert.ok(checkpointText.includes(FINAL_SENTINEL), phase + ': final assistant sentinel missing from the checkpoint');
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
  // The continuation notice is a runtime context. A scenario that does not exercise
  // it must hide it, otherwise the model can request a handoff in the fixture turn and
  // the host opens a follow-up turn whose compression legitimately changes the surface
  // between the recovery and cold loads. The continuation scenario lifts the gate for
  // the live turn that must hand off, then closes it again so the resumed turn finishes
  // in one reply instead of chaining another handoff.
  const runtimeContextGate = { enabled: true };
  const createSetup = (contextNames: readonly string[]) => async (agentCtx: any) => {
    // rc.8's shipped minimal preset suppresses every runtime context, including
    // the continuation notice this scenario exercises. Use a runtime-enabled
    // shipped composition, then isolate the parent request to this fixture's
    // persona, public tools, and the contexts under test.
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
        contexts: assembled.contexts.filter((entry: any) =>
          runtimeContextGate.enabled && contextNames.includes(entry.name)),
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
  const setup = createSetup([]);
  const continuationSetup = createSetup([CONTINUATION_CONTEXT_NAME]);
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
    const coldSeqs = coldCompression.map((node) => node.seq);
    for (const seq of expectedCompressionSeqs) {
      assert.ok(coldSeqs.includes(seq), 'second cold load dropped a recovered compression identity: ' + seq);
    }
    // A follow-up turn that the host opened after the recovered compression may itself be
    // compressed before or during this load; that is new work, not a duplicated identity.
    for (const node of coldCompression) {
      const expected = compressed.find((entry) => entry.seq === node.seq);
      if (expected === undefined) {
        assert.ok(node.data.source.turn > compressed[0].data.source.turn,
          'second cold load produced an unexpected earlier compression at seq ' + node.seq);
        continue;
      }
      assert.equal(node.data.source.turn, expected.data.source.turn,
        'second cold load changed a recovered compression turn at seq ' + node.seq);
      assert.equal(node.data.source.originalNodes, expected.data.source.originalNodes,
        'second cold load changed a recovered compression identity at seq ' + node.seq);
    }
    assertProjection(coldHandle.agent.session,
      coldCompression.filter((node) => expectedCompressionSeqs.includes(node.seq)), 'cold');
    await sessions.flush(coldHandle.agent.session);
    const snapshot = await sessionQuery.readSurface(sessionId);
    const expectedSurfaceEvents = coldHandle.agent.session.surface.nodes
      .map((seq: number) => coldHandle.agent.session.snapshotEvents()[seq]);
    assert.deepEqual(snapshot.events, expectedSurfaceEvents, 'sessionQuery surface must equal the cold live surface');
    const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');

    continuationLiveHandle = await agents.create({
      sessionId: 'session-turn-memory-continuation-e2e-' + randomUUID(),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: continuationSetup,
    });
    await continuationLiveHandle.agent.whenIdle();
    continuationLiveHandle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        // The remaining work has to look genuinely long, otherwise the continuation notice's
        // "finish in the next few actions" exemption lets the model skip the handoff call.
        // The continued turn is the opposite case: the whole task finishes in one reply there,
        // so the same exemption must stop it from handing off a second time. Name the two turns
        // explicitly, otherwise a model that just called the fixture reads its own first turn as
        // the continued one and finishes the whole task instead of handing off.
        text: USER_SENTINEL + ': This is the first turn and nothing has been compressed yet.'
          + ' Call turn_memory_e2e_fixture exactly once in this turn, then end this turn by calling'
          + ' continue_after_turn_compression exactly once, as the active Turn Memory continuation'
          + ' instruction requires. The remaining work (a multi-step review) runs in the continued turn'
          + ' that follows the compression, not here. Only in that continued turn does the whole task'
          + ' finish in a single reply: do not call turn_memory_e2e_fixture again, do not hand off'
          + ' again, and reply with exactly ' + CONTINUATION_SENTINEL + ': ' + FINAL_SENTINEL + '.',
      }],
      source: { kind: 'user' },
    });
    await continuationLiveHandle.agent.whenIdle();
    const continuationRequest = continuationRequestForTurn(continuationLiveHandle.agent.session, 1);
    assert.notEqual(continuationRequest, undefined, 'long live turn did not record a durable continuation request');
    assert.equal(continuationRequest!.version, 2, 'continuation request must not carry model prose');
    assert.ok(!('handoff' in continuationRequest!), 'continuation request must be payload-free');
    assert.equal(compressionNodes(continuationLiveHandle.agent.session).length, 0,
      'continuation fixture should defer live compression until recovery');
    const continuationSessionId = continuationLiveHandle.agent.session.id;
    await sessions.flush(continuationLiveHandle.agent.session);
    await continuationLiveHandle.dispose();
    continuationLiveHandle = undefined;

    // The durable request is already recorded, so the resumed turn no longer needs the
    // notice; without it the model finishes the single remaining reply instead of asking
    // for a second handoff (which the notice's milestone would otherwise invite).
    runtimeContextGate.enabled = false;
    continuationRecoveryHandle = await agents.resume({
      resumeSessionId: continuationSessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: continuationSetup,
    });
    const continuationCompressed = await waitForCompression(continuationRecoveryHandle.agent.session, timeoutMs);
    assert.deepEqual(workerProviders, ['fork', 'spawn', 'fork', 'spawn'],
      'each turn job must begin with one fork and use a fresh spawn for its recovery worker');
    assertProjection(continuationRecoveryHandle.agent.session, [continuationCompressed[0]], 'continuation recovery');
    assertCheckpointShape(continuationCompressed[0], 'continuation recovery', 'User');
    const continued = await waitForContinuation(
      continuationRecoveryHandle.agent.session, timeoutMs, continuationRequest!.turn);
    assert.match(textOf(continued.user), /not new human input/,
      'automatic follow-up did not disclose its plugin origin');
    assert.equal(textOf(continued.user),
      'Turn Memory automatic continuation after compressed turn ' + continuationRequest!.turn + '\n'
      + 'This is host control context, not new human input.\n'
      + 'Resume the unfinished work now from the compressed turn above.',
      'automatic follow-up must be the fixed payload-free continuation message');
    assert.ok(continued.turnStart.data.turn > continuationRequest!.turn,
      'automatic continuation did not open a later turn');

    // The continued turn has no human input — its only user message is the host
    // continuation — so the logical-turn shape rule requires an assistant-first
    // checkpoint. Compression is deferred until a resume, which doubles as proof that
    // the assistant-first checkpoint survives a cold load.
    await continuationRecoveryHandle.agent.whenIdle();
    await sessions.flush(continuationRecoveryHandle.agent.session);
    await continuationRecoveryHandle.dispose();
    continuationRecoveryHandle = undefined;
    continuationRecoveryHandle = await agents.resume({
      resumeSessionId: continuationSessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: continuationSetup,
    });
    const shapedCompressed = await waitForCompression(continuationRecoveryHandle.agent.session, timeoutMs, 2);
    assert.deepEqual(workerProviders, ['fork', 'spawn', 'fork', 'spawn', 'fork', 'spawn'],
      'the continuation-only turn must run its own fork job and spawn recovery worker');
    assertProjection(continuationRecoveryHandle.agent.session, [shapedCompressed[1]], 'continuation-only turn');
    assertCheckpointShape(shapedCompressed[0], 'continuation recovery', 'User');
    assertCheckpointShape(shapedCompressed[1], 'continuation-only turn', 'Assistant');
    await sessions.flush(continuationRecoveryHandle.agent.session);
    const continuationSnapshot = await sessionQuery.readSurface(continuationSessionId);
    const continuationSurfacePath = resolve(artifactDir, 'e2e-surface-' + continuationSessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(continuationSurfacePath, JSON.stringify(continuationSnapshot, null, 2) + '\n', 'utf8');

    const surfacePath = resolve(artifactDir, 'e2e-surface-' + sessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log('E2E_SESSION_ID=' + sessionId);
    console.log('E2E_REPLACEMENT=' + compressed[0].data.source.originalNodes + '->' + compressed.length);
    console.log('E2E_MUTATIONS=' + compressed[0].data.source.mutations);
    console.log('E2E_WORKER_ATTEMPTS=' + compressed[0].data.source.workerAttempts);
    console.log('E2E_RECOVERY=agent-resume-backfill');
    console.log('E2E_CONTINUATION=compressed-then-followup');
    console.log('E2E_SHAPES=human-user,' + 'continuation-only-assistant');
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
