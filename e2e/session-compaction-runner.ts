import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { foldSurface } from '@deepseek-ai/dsh-session';

const name = 'turn-memory-session-compaction-e2e-runner';
const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'compaction', 'sessionQuery', 'sessions', 'tokenMeter'];

const ALPHA = 'SESSION-MEMORY-ALPHA-731';
const BETA = 'SESSION-MEMORY-BETA-947';
const GAMMA = 'SESSION-MEMORY-GAMMA-563';

function textOf(event: any): string {
  const blocks = event?.data?.content ?? event?.data?.message?.content ?? [];
  return blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
}

async function completedTurn(agent: any, text: string): Promise<void> {
  agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  await agent.whenIdle();
}

function appendPostTurnAssistantReplacement(session: any): number {
  const originalSeq = session.surface.nodes.find((seq: number) => session.events[seq]?.type === 'assistant/message');
  assert.notEqual(originalSeq, undefined, 'compatibility fixture needs an assistant surface node');
  const original = session.events[originalSeq!];
  const replacement = session.append('assistant/message', {
    ...original.data,
    message: { ...original.data.message, id: randomUUID() },
    source: {
      kind: 'plugin',
      plugin: 'turn-memory',
      phase: 'compression',
      turn: original.data.turn,
      draftId: randomUUID(),
      originalNodes: 1,
      mutations: 1,
    },
  }, {
    surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
    sourceEventSeqs: [originalSeq],
  });
  return replacement.seq;
}

function assertCompacted(session: any, result: any, phase: string): any {
  assert.deepEqual(foldSurface(session.events).nodes, [...session.surface.nodes], phase + ': live surface differs from replay fold');
  const start = session.events[result.startSeq];
  const summary = session.events[result.summarySeq];
  const replacement = session.events[result.summarySeq + 1];
  const end = session.events[result.endSeq];
  assert.equal(start.type, 'compaction/start', phase + ': missing start marker');
  assert.equal(summary.type, 'compaction/summary', phase + ': missing summary event');
  assert.equal(replacement.type, 'user/message', phase + ': summary must be immediately followed by checkpoint replacement');
  assert.equal(end.type, 'compaction/end', phase + ': missing end marker');
  assert.equal(replacement.data.source.plugin, 'compact', phase + ': checkpoint provenance is not standard compact source');
  assert.equal(replacement.data.source.compactionId, result.compactionId, phase + ': checkpoint compaction id mismatch');
  assert.deepEqual(replacement.sourceEventSeqs.slice(-result.shadowedSeqs.length), result.shadowedSeqs, phase + ': replacement lost exact shadowed provenance');
  const checkpoint = textOf(replacement);
  assert.match(checkpoint, /# Session memory checkpoint/, phase + ': checkpoint framing missing');
  assert.match(checkpoint, /<message role="user">|<message role="assistant">/, phase + ': checkpoint lost transcript roles');
  assert.match(checkpoint, /failed migration[\s\S]{0,240}cache key[\s\S]{0,120}causal/i, phase + ': checkpoint lost the first decision and its evidence');
  assert.match(checkpoint, /host-owned revisioned checkpoint/i, phase + ': checkpoint lost the later implementation correction');
  assert.ok(!checkpoint.includes(GAMMA), phase + ': checkpoint imported the retained third turn from outside the selected range');
  assert.doesNotMatch(checkpoint, /Runtime context snapshot|workspace-write|approval policy/, phase + ': checkpoint retained stale host runtime scaffolding');
  return replacement;
}

async function run(ctx: any): Promise<void> {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const compaction = ctx.get('compaction');
  const sessions = ctx.get('sessions');
  const sessionQuery = ctx.get('sessionQuery');
  const tokenMeter = ctx.get('tokenMeter');
  const defaultModel = ctx.get('agentDefaultModel');
  const agentPresets = ctx.get('agentPresets');
  if (agents === undefined || compaction === undefined || sessions === undefined || sessionQuery === undefined
    || tokenMeter === undefined || defaultModel === undefined || agentPresets === undefined) {
    throw new Error('session compaction e2e requires agent, compaction, persistence, query, token-meter, and default-model services');
  }
  const selection = defaultModel.currentSelection();
  const workerProviders: string[] = [];
  const disposeLifecycle = ctx.on('subagent/start', (info: any) => workerProviders.push(String(info.provider)));
  const setup = async (agentCtx: any): Promise<void> => {
    await agentPresets.mount(agentCtx, 'minimal');
    installModelSelection(agentCtx, {
      current: { ...selection },
      assembled: undefined,
    });
    agentCtx.tools.restrict({ allow: [] });
  };

  let liveHandle: any;
  let coldHandle: any;
  try {
    liveHandle = await agents.create({
      sessionId: 'session-memory-compaction-e2e-' + randomUUID(),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    const agent = liveHandle.agent;
    await agent.whenIdle();
    const repetitive = 'Mechanically repeated build trace with no new information. '.repeat(220);
    await completedTurn(agent, ALPHA + ': We decided to preserve the failed migration because it proved the cache key was causal.\n' + repetitive
      + '\nReply exactly: alpha recorded.');
    await completedTurn(agent, BETA + ': Correction: the chosen implementation is the host-owned revisioned checkpoint, while the earlier migration remains useful evidence.\n'
      + repetitive + '\nReply exactly: beta recorded.');
    await completedTurn(agent, GAMMA + ': This third turn must remain verbatim in the retained tail and must not be copied into the checkpoint.\n'
      + repetitive + '\nReply exactly: gamma recorded.');

    const replacementSeq = appendPostTurnAssistantReplacement(agent.session);
    assert.throws(
      () => tokenMeter.measure(agent.session),
      new RegExp('assistant/message at seq ' + replacementSeq + ' has no matching step/start event'),
      'fixture no longer reproduces the upstream token-meter incompatibility',
    );

    const result = await compaction.compactNow(agent, new AbortController().signal);
    assert.notEqual(result, null, 'manual session compaction unexpectedly found no range');
    assert.deepEqual(workerProviders, ['fork', 'spawn', 'fork'],
      'accepted revision progress must reset a one-attempt no-progress budget and continue segment one in a fresh spawn');
    const replacement = assertCompacted(agent.session, result, 'live');
    await sessions.flush(agent.session);
    const sessionId = String(agent.session.id);
    await liveHandle.dispose();
    liveHandle = undefined;

    coldHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await coldHandle.agent.whenIdle();
    const coldReplacement = coldHandle.agent.session.events[replacement.seq];
    assert.equal(coldReplacement?.data?.source?.compactionId, result.compactionId, 'cold load lost checkpoint identity');
    assertCompacted(coldHandle.agent.session, result, 'cold');
    const snapshot = await sessionQuery.readSurface(sessionId);
    const expected = coldHandle.agent.session.surface.nodes.map((seq: number) => coldHandle.agent.session.events[seq]);
    assert.deepEqual(snapshot.events, expected, 'sessionQuery surface differs from cold live surface');
    const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
    const surfacePath = resolve(artifactDir, 'session-compaction-surface-' + sessionId + '.json');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log('SESSION_COMPACTION_E2E_SESSION_ID=' + sessionId);
    console.log('SESSION_COMPACTION_E2E_SHADOWED=' + result.shadowedSeqs.length);
    console.log('SESSION_COMPACTION_E2E_SURFACE_PATH=' + surfacePath);
    console.log('SESSION_COMPACTION_E2E_RESULT=PASS');
  } finally {
    disposeLifecycle();
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (liveHandle !== undefined) await liveHandle.dispose();
  }
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('session compaction e2e requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('SESSION_COMPACTION_E2E_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
