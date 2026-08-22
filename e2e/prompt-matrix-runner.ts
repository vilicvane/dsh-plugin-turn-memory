import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { foldSurface } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'turn-memory-prompt-matrix-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionQuery', 'sessions', 'tools'];

const SCENARIOS = ['typo_correction', 'goal_change', 'implementation_detail'] as const;
type Scenario = typeof SCENARIOS[number];

const FINGERPRINT_FILES = [
  'prompts/turn-compression.md',
  'lib/prompt.ts',
  'lib/editor.ts',
  'index.ts',
] as const;

interface FixtureTurn {
  originalSeqs: number[];
  originalUserSeqs: number[];
  currentNodes: any[];
}

interface ScenarioResult {
  scenario: Scenario;
  repetition: number;
  passed: boolean;
  elapsedMs: number;
  sessionId: string | null;
  replacement: string | null;
  surfacePath: string | null;
  sourceFingerprint: string;
  sourceStable: boolean;
  currentSurface: Array<{ type: string; text: string }>;
  error?: string;
}

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
    .filter((event: any) => event?.data?.source?.plugin === 'turn-memory'
      && event.data.source.phase === 'compression');
}

async function waitForCompression(session: any, timeoutMs: number): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = compressionNodes(session);
    if (found.length > 0) return found;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`timed out waiting for production-prompt compression after ${timeoutMs}ms`);
}

function fixtureTurn(session: any): FixtureTurn {
  const end = session.events.findLast((event: any) => event?.type === 'turn/end');
  if (end === undefined) throw new Error('fixture session has no completed turn');
  const start = session.events.findLast((event: any) => event?.type === 'turn/start'
    && event.data?.turn === end.data?.turn);
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

function assertCommonCompression(
  session: any,
  compressed: any[],
  phase: string,
  minimumOriginalNodes: number,
): FixtureTurn {
  assert.deepEqual(
    foldSurface(session.events).nodes,
    [...session.surface.nodes],
    `${phase}: live surface must equal full fold replay`,
  );
  const fixture = fixtureTurn(session);
  assert.ok(
    fixture.originalSeqs.length >= minimumOriginalNodes,
    `${phase}: fixture produced ${fixture.originalSeqs.length}, expected at least ${minimumOriginalNodes} original nodes`,
  );
  assert.ok(
    fixture.currentNodes.length < fixture.originalSeqs.length,
    `${phase}: production prompt did not shorten the turn (${fixture.originalSeqs.length}->${fixture.currentNodes.length})`,
  );
  assert.equal(fixture.currentNodes.at(0)?.type, 'user/message', `${phase}: compact surface must start with user`);
  assert.equal(fixture.currentNodes.at(-1)?.type, 'assistant/message', `${phase}: compact surface must end with assistant`);
  assert.ok(fixture.currentNodes.every((node) => textOf(node).trim().length > 0), `${phase}: compact surface has an empty node`);
  for (const node of compressed) {
    assert.equal(node.surfaceOp?.op, 'replace', `${phase}: compressed nodes must be replacements`);
    assert.equal(
      node.data.source.originalNodes,
      fixture.originalSeqs.length,
      `${phase}: replacement marker has the wrong original node count`,
    );
  }
  return fixture;
}

function assertTypoCorrection(session: any, compressed: any[], phase: string): FixtureTurn {
  const fixture = assertCommonCompression(session, compressed, phase, 6);
  assert.equal(fixture.originalUserSeqs.length, 2, `${phase}: fixture must contain initial request and correction`);
  const userNodes = fixture.currentNodes.filter((node) => node.type === 'user/message');
  assert.equal(userNodes.length, 1, `${phase}: typo correction must become one corrected user intent`);
  assert.equal(userNodes[0].surfaceOp?.op, 'replace', `${phase}: corrected user intent must be a replacement`);
  for (const sourceSeq of fixture.originalUserSeqs) {
    assert.ok(
      userNodes[0].sourceEventSeqs.includes(sourceSeq),
      `${phase}: corrected user intent omitted provenance ${sourceSeq}`,
    );
  }
  const user = textOf(userNodes[0]).toLowerCase();
  const retainedWork = fixture.currentNodes
    .filter((node) => node.type !== 'user/message')
    .map(textOf)
    .join('\n')
    .toLowerCase();
  assert.match(user, /home/, `${phase}: corrected intent lost home`);
  assert.match(user, /playground/, `${phase}: corrected intent lost playground`);
  assert.match(retainedWork, /\/repo/, `${phase}: compression erased the failed detour`);
  assert.match(retainedWork, /does not exist|不存在/, `${phase}: compression erased why the detour failed`);
  assert.match(retainedWork, /6/, `${phase}: compression lost the device-type conclusion`);
  assert.match(retainedWork, /9/, `${phase}: compression lost the device-count conclusion`);
  return fixture;
}

function assertGoalChange(session: any, compressed: any[], phase: string): FixtureTurn {
  const fixture = assertCommonCompression(session, compressed, phase, 7);
  assert.equal(fixture.originalUserSeqs.length, 2, `${phase}: fixture must contain initial and changed objectives`);
  const userIndexes = fixture.currentNodes
    .map((node, index) => node.type === 'user/message' ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(userIndexes.length, 2, `${phase}: evidence-driven goal change must retain two user nodes`);
  const firstUser = textOf(fixture.currentNodes[userIndexes[0]]).toLowerCase();
  const secondUser = textOf(fixture.currentNodes[userIndexes[1]]).toLowerCase();
  assert.match(firstUser, /alpha/, `${phase}: original alpha objective was lost`);
  assert.match(secondUser, /beta/, `${phase}: changed beta objective was lost`);
  assert.match(secondUser, /决定|decision|change|switch|改/, `${phase}: second user node lost decision semantics`);
  const beforeDecision = fixture.currentNodes
    .slice(userIndexes[0] + 1, userIndexes[1])
    .filter((node) => node.type !== 'user/message')
    .map(textOf)
    .join('\n');
  const afterDecision = fixture.currentNodes
    .slice(userIndexes[1] + 1)
    .filter((node) => node.type !== 'user/message')
    .map(textOf)
    .join('\n');
  assert.match(beforeDecision, /ALPHA-BLOCKED-41/, `${phase}: alpha evidence must precede the decision boundary`);
  assert.match(afterDecision, /BETA-READY-73/, `${phase}: beta result must follow the decision boundary`);
  assert.match(afterDecision, /approval|批准|确认/, `${phase}: unresolved approval state was lost`);
  return fixture;
}

function assertImplementationDetail(session: any, compressed: any[], phase: string): FixtureTurn {
  const fixture = assertCommonCompression(session, compressed, phase, 6);
  const userNodes = fixture.currentNodes.filter((node) => node.type === 'user/message');
  assert.equal(userNodes.length, 1, `${phase}: implementation scenario must retain one user objective`);
  const assistant = fixture.currentNodes
    .filter((node) => node.type !== 'user/message')
    .map(textOf)
    .join('\n');
  const required: Array<{ label: string; patterns: RegExp[] }> = [
    { label: 'implementation target lib/cobalt.ts', patterns: [/lib\/cobalt\.ts/i] },
    { label: 'CobaltGate interface', patterns: [/CobaltGate/i] },
    {
      label: 'idle -> checking -> ready | blocked state machine',
      patterns: [/idle\s*(?:->|→)\s*checking\s*(?:->|→)\s*ready\s*\|\s*blocked/i],
    },
    {
      label: 'revision compare-and-swap before commit',
      patterns: [
        /revision.{0,100}(?:\bCAS\b|compare[- ]and[- ]swap).{0,100}(?:before|之前|前).{0,40}commit/is,
        /(?:\bCAS\b|compare[- ]and[- ]swap).{0,100}revision.{0,100}(?:before|之前|前).{0,40}commit/is,
        /(?:commit|提交).{0,40}(?:before|之前|前).{0,100}revision.{0,100}(?:\bCAS\b|compare[- ]and[- ]swap)/is,
      ],
    },
    { label: '37 second timeout', patterns: [/37\s*s(?:econds?)?/i, /37\s*秒/] },
    { label: 'one-shot fallback', patterns: [/(?:one[- ]shot|一次性|单次).{0,40}fallback/is] },
    {
      label: 'rejected global mutable state because cold resume diverges',
      patterns: [
        /(?:global mutable state|全局可变状态).{0,180}(?:cold resume|冷恢复|冷启动恢复).{0,100}(?:diverg|分歧|分叉)/is,
      ],
    },
    { label: 'validation target test/cobalt.test.ts', patterns: [/test\/cobalt\.test\.ts/i] },
    { label: 'unresolved 250ms option', patterns: [/250\s*ms/i] },
    { label: 'unresolved 500ms option', patterns: [/500\s*ms/i] },
  ];
  for (const requirement of required) {
    assert.ok(
      requirement.patterns.some((pattern) => pattern.test(assistant)),
      `${phase}: compact implementation memory lost ${requirement.label}`,
    );
  }
  return fixture;
}

function assertionFor(scenario: Scenario) {
  if (scenario === 'typo_correction') return assertTypoCorrection;
  if (scenario === 'goal_change') return assertGoalChange;
  return assertImplementationDetail;
}

function setupScenario(agentCtx: any, selection: any, scenario: Scenario, runtime: any): void {
  installModelSelection(agentCtx, {
    current: { ...selection },
    assembled: undefined,
  });
  agentCtx.tools.restrict({ allow: [] });
  if (scenario === 'typo_correction') {
    agentCtx.tools.register(defineTool({
      name: 'inspect_home_fixture',
      description: 'Inspect the home-device declaration at the target named by the latest user message. Use /repo or playground exactly.',
      parameters: { target: { type: 'string', required: true, enum: ['/repo', 'playground'] } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false,
      async execute(args: any, exec: any) {
        const target = String(args.target);
        runtime.inspected.push(target);
        if (target === '/repo') {
          if (!runtime.steerSent) {
            if (exec.agent === undefined) throw new Error('inspect_home_fixture has no owning agent');
            runtime.steerSent = true;
            exec.agent.steer(createUserMessage({
              content: [{
                type: 'text',
                text: '刚才目录说错了：我一开始指的就是 playground，不是 /repo。前面的检查算作因口误走偏的试错。',
              }],
              source: { kind: 'user' },
            }));
          }
          return 'The attempt failed because /repo does not exist, so it produced no device conclusion.';
        }
        return 'Conclusion from packages/playground/src/program/home.ts: the home declares 6 device types and 9 device instances.';
      },
    }));
    return;
  }
  if (scenario === 'goal_change') {
    agentCtx.tools.register(defineTool({
      name: 'inspect_route_fixture',
      description: 'Inspect one deployment route. Inspect alpha first; after a human evidence-driven decision, inspect beta.',
      parameters: { route: { type: 'string', required: true, enum: ['alpha', 'beta'] } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false,
      async execute(args: any, exec: any) {
        const route = String(args.route);
        runtime.inspected.push(route);
        if (route === 'alpha') {
          if (!runtime.steerSent) {
            if (exec.agent === undefined) throw new Error('inspect_route_fixture has no owning agent');
            runtime.steerSent = true;
            exec.agent.steer(createUserMessage({
              content: [{
                type: 'text',
                text: '我看到了 ALPHA-BLOCKED-41。基于这个新结果，我现在决定放弃 alpha，改为评估 beta；这是看到结果后的目标变更，不是口误。',
              }],
              source: { kind: 'user' },
            }));
          }
          return 'ALPHA-BLOCKED-41: alpha cannot satisfy the immutable regional policy, so the route is unusable.';
        }
        return 'BETA-READY-73: beta passes every gate. Recommendation: use beta. Unresolved next step: obtain user approval before applying the route change.';
      },
    }));
    return;
  }
  agentCtx.tools.register(defineTool({
    name: 'derive_cobalt_contract',
    description: 'Return one exact part of the implementation-ready cobalt controller contract. Inspect architecture, failure, and validation separately before answering.',
    parameters: { area: { type: 'string', required: true, enum: ['architecture', 'failure', 'validation'] } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(args: any) {
      const area = String(args.area);
      runtime.inspected.push(area);
      if (area === 'architecture') {
        return 'COBALT-ARCH: implement lib/cobalt.ts. Interface CobaltGate.check(input): Promise<GateResult>. State machine: idle -> checking -> ready | blocked. The controller owns no global state.';
      }
      if (area === 'failure') {
        return 'COBALT-FAIL: invariant revision CAS before commit; timeout 37s; use a one-shot fallback, then surface the error. Reject global mutable state because cold resume would diverge.';
      }
      return 'COBALT-VALIDATE: add test/cobalt.test.ts. Test cold resume with the same revision and exhausted fallback. Remaining choice is retry backoff 250ms or 500ms; do not implement until the user chooses.';
    },
  }));
}

function initialPrompt(scenario: Scenario): string {
  if (scenario === 'typo_correction') {
    return 'home 中用到了哪些设备？先调用 inspect_home_fixture 检查 /repo，并根据结果回答。';
  }
  if (scenario === 'goal_change') {
    return '先调用 inspect_route_fixture 检查 alpha 部署路径，并根据检查期间我的最新决定继续。最终保留失败证据、决定原因、推荐路径和未解决的下一步。';
  }
  return '为 cobalt controller 形成可直接交接的实现方案。分别调用 derive_cobalt_contract 的 architecture、failure、validation，保留工具给出的精确接口、状态机、不变量、超时、fallback、被拒方案原因、测试与未决选择；不要写文件。';
}

function assertParentBehavior(scenario: Scenario, inspected: readonly string[]): void {
  if (scenario === 'typo_correction') {
    assert.equal(inspected[0], '/repo', 'parent must begin with the mistaken target');
    assert.ok(inspected.length >= 2, 'parent must inspect the corrected target');
    assert.ok(inspected.slice(1).every((target) => target === 'playground'), 'parent must use corrected target after steer');
    return;
  }
  if (scenario === 'goal_change') {
    assert.deepEqual(inspected, ['alpha', 'beta'], 'parent must follow the evidence-driven route change exactly once');
    return;
  }
  assert.equal(inspected.length, 3, 'parent must inspect all three contract areas exactly once');
  assert.deepEqual(new Set(inspected), new Set(['architecture', 'failure', 'validation']));
}

async function sourceFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const path of FINGERPRINT_FILES) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function runScenario(
  ctx: any,
  selection: any,
  scenario: Scenario,
  repetition: number,
): Promise<ScenarioResult> {
  const agents = ctx.get('agents');
  const sessionQuery = ctx.get('sessionQuery');
  const sessions = ctx.get('sessions');
  const runtime = { inspected: [] as string[], steerSent: false };
  const fingerprintBefore = await sourceFingerprint();
  const started = Date.now();
  let liveHandle: any;
  let coldHandle: any;
  let sessionId: string | null = null;
  let replacement: string | null = null;
  let surfacePath: string | null = null;
  let currentSurface: Array<{ type: string; text: string }> = [];
  try {
    const setup = (agentCtx: any) => setupScenario(agentCtx, selection, scenario, runtime);
    liveHandle = await agents.create({
      sessionId: `session-turn-memory-prompt-matrix-${scenario}-${repetition}-${randomUUID()}`,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    const agent = liveHandle.agent;
    sessionId = agent.session.id;
    await agent.whenIdle();
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: initialPrompt(scenario) }],
      source: { kind: 'user' },
    });
    await agent.whenIdle();
    assertParentBehavior(scenario, runtime.inspected);

    const timeoutMs = Number(process.env.TURN_MEMORY_PROMPT_EVAL_TIMEOUT_MS ?? 420000);
    const compressed = await waitForCompression(agent.session, timeoutMs);
    const assertScenario = assertionFor(scenario);
    const liveFixture = assertScenario(agent.session, compressed, 'live');
    replacement = `${liveFixture.originalSeqs.length}->${liveFixture.currentNodes.length}`;
    await sessions.flush(agent.session);
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
    assert.deepEqual(
      coldCompression.map((node) => node.seq),
      expectedCompressionSeqs,
      'cold load changed compression identities',
    );
    const coldFixture = assertScenario(coldHandle.agent.session, coldCompression, 'cold');
    await sessions.flush(coldHandle.agent.session);

    const snapshot = await sessionQuery.readSurface(sessionId);
    const expectedSurfaceEvents = coldHandle.agent.session.surface.nodes
      .map((seq: number) => coldHandle.agent.session.events[seq]);
    assert.deepEqual(snapshot.events, expectedSurfaceEvents, 'sessionQuery surface must equal cold live surface');
    const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
    surfacePath = resolve(artifactDir, `prompt-matrix-surface-${sessionId}.json`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    currentSurface = coldFixture.currentNodes.map((node) => ({ type: node.type, text: textOf(node) }));
    const fingerprintAfter = await sourceFingerprint();
    assert.equal(fingerprintAfter, fingerprintBefore, 'turn-memory production prompt sources changed during scenario');
    return {
      scenario,
      repetition,
      passed: true,
      elapsedMs: Date.now() - started,
      sessionId,
      replacement,
      surfacePath,
      sourceFingerprint: fingerprintBefore,
      sourceStable: true,
      currentSurface,
    };
  } catch (error) {
    const fingerprintAfter = await sourceFingerprint();
    return {
      scenario,
      repetition,
      passed: false,
      elapsedMs: Date.now() - started,
      sessionId,
      replacement,
      surfacePath,
      sourceFingerprint: fingerprintBefore,
      sourceStable: fingerprintAfter === fingerprintBefore,
      currentSurface,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (liveHandle !== undefined) await liveHandle.dispose();
  }
}

function wilson95(successes: number, total: number): { low: number; high: number } {
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const spread = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { low: center - spread, high: center + spread };
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

  const repetitions = Number(process.env.TURN_MEMORY_PROMPT_EVAL_RUNS ?? 1);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error('TURN_MEMORY_PROMPT_EVAL_RUNS must be an integer from 1 to 20');
  }
  const requested = (process.env.TURN_MEMORY_PROMPT_EVAL_SCENARIOS ?? SCENARIOS.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0 || requested.some((value) => !(SCENARIOS as readonly string[]).includes(value))) {
    throw new Error(`TURN_MEMORY_PROMPT_EVAL_SCENARIOS must contain only: ${SCENARIOS.join(', ')}`);
  }
  const scenarios = [...new Set(requested)] as Scenario[];
  const selection = defaultModel.currentSelection();
  const results: ScenarioResult[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const scenario of scenarios) {
      const result = await runScenario(ctx, selection, scenario, repetition);
      results.push(result);
      console.log(`PROMPT_MATRIX_RUN scenario=${scenario} repetition=${repetition}/${repetitions} ${result.passed ? 'PASS' : 'FAIL'} session=${result.sessionId ?? 'missing'} replacement=${result.replacement ?? 'missing'} elapsed_ms=${result.elapsedMs}`);
      if (result.error !== undefined) console.log(`PROMPT_MATRIX_ERROR scenario=${scenario} repetition=${repetition} ${JSON.stringify(result.error)}`);
    }
  }

  const summaries = Object.fromEntries(scenarios.map((scenario) => {
    const subset = results.filter((result) => result.scenario === scenario);
    const successes = subset.filter((result) => result.passed).length;
    const fingerprints = [...new Set(subset.map((result) => result.sourceFingerprint))];
    return [scenario, {
      runs: subset.length,
      successes,
      passRate: successes / subset.length,
      wilson95: wilson95(successes, subset.length),
      stableFingerprint: fingerprints.length === 1 && subset.every((result) => result.sourceStable),
      sourceFingerprints: fingerprints,
    }];
  }));
  const successes = results.filter((result) => result.passed).length;
  const stableFingerprint = Object.values(summaries).every((summary) => summary.stableFingerprint);
  const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
  const artifactPath = resolve(artifactDir, `prompt-matrix-${Date.now()}.json`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, JSON.stringify({
    kind: 'turn-memory-prompt-eval-matrix',
    model: selection,
    repetitions,
    scenarios,
    runs: results.length,
    successes,
    passRate: successes / results.length,
    wilson95: wilson95(successes, results.length),
    stableFingerprint,
    summaries,
    results,
  }, null, 2) + '\n', 'utf8');

  console.log(`PROMPT_MATRIX_MODEL=${JSON.stringify(selection)}`);
  for (const scenario of scenarios) {
    console.log(`PROMPT_MATRIX_SCENARIO_SUMMARY scenario=${scenario} ${JSON.stringify(summaries[scenario])}`);
  }
  console.log(`PROMPT_MATRIX_SUMMARY=${successes}/${results.length}`);
  console.log(`PROMPT_MATRIX_FINGERPRINT_STABLE=${stableFingerprint}`);
  console.log(`PROMPT_MATRIX_ARTIFACT_PATH=${artifactPath}`);
  if (successes !== results.length || !stableFingerprint) {
    throw new Error(`turn-memory prompt matrix passed ${successes}/${results.length}; fingerprint stable=${stableFingerprint}`);
  }
  console.log('PROMPT_MATRIX_RESULT=PASS');
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('turn-memory-prompt-matrix-runner requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('PROMPT_MATRIX_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
