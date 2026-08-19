import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function positiveInteger(value, fallback, name, maximum) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

function match(text, pattern) {
  return pattern.exec(text)?.[1] ?? null;
}

function wilson95(successes, total) {
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const spread = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { low: center - spread, high: center + spread };
}

const projectDir = resolve(import.meta.dirname, '..');
const fingerprintFiles = [
  'prompts/turn-compression.md',
  'lib/prompt.ts',
  'lib/editor.ts',
  'index.ts',
];

function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const path of fingerprintFiles) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(resolve(projectDir, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const runs = positiveInteger(process.env.TURN_MEMORY_PROMPT_EVAL_RUNS, 3, 'TURN_MEMORY_PROMPT_EVAL_RUNS', 50);
const runTimeoutMs = positiveInteger(
  process.env.TURN_MEMORY_PROMPT_EVAL_RUN_TIMEOUT_MS,
  600000,
  'TURN_MEMORY_PROMPT_EVAL_RUN_TIMEOUT_MS',
  3600000,
);
const results = [];

for (let index = 0; index < runs; index += 1) {
  const fingerprintBefore = sourceFingerprint();
  const started = Date.now();
  const child = spawnSync('bash', ['scripts/e2e-prompt.sh'], {
    cwd: projectDir,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: runTimeoutMs,
  });
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  const fingerprintAfter = sourceFingerprint();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const sourceStable = fingerprintBefore === fingerprintAfter;
  const passed = child.status === 0 && /^PROMPT_EVAL_RESULT=PASS$/m.test(stdout) && sourceStable;
  const result = {
    run: index + 1,
    passed,
    elapsedMs: Date.now() - started,
    sourceFingerprint: fingerprintBefore,
    sourceStable,
    exitStatus: child.status,
    signal: child.signal,
    error: child.error?.stack ?? child.error?.message ?? null,
    sessionId: match(stdout, /^PROMPT_EVAL_SESSION_ID=(.+)$/m),
    replacement: match(stdout, /^PROMPT_EVAL_REPLACEMENT=(.+)$/m),
    user: match(stdout, /^PROMPT_EVAL_USER=(.+)$/m),
    retainedWork: match(stdout, /^PROMPT_EVAL_RETAINED_WORK=(.+)$/m),
    surfacePath: match(stdout, /^PROMPT_EVAL_SURFACE_PATH=(.+)$/m),
  };
  results.push(result);
  console.log(`PROMPT_EVAL_REPEAT_RUN=${index + 1}/${runs} ${passed ? 'PASS' : 'FAIL'} session=${result.sessionId ?? 'missing'} elapsed_ms=${result.elapsedMs}`);
}

const successes = results.filter((result) => result.passed).length;
const fingerprints = [...new Set(results.map((result) => result.sourceFingerprint))];
const stableFingerprint = fingerprints.length === 1 && results.every((result) => result.sourceStable);
const interval = wilson95(successes, results.length);
const artifactDir = resolve(process.env.TURN_MEMORY_E2E_ARTIFACT_DIR ?? '.tmp');
const artifactPath = resolve(artifactDir, `prompt-eval-repeat-${Date.now()}.json`);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(artifactPath, JSON.stringify({
  kind: 'turn-memory-prompt-eval-repeat',
  runs: results.length,
  successes,
  passRate: successes / results.length,
  wilson95: interval,
  stableFingerprint,
  sourceFingerprints: fingerprints,
  results,
}, null, 2) + '\n', 'utf8');

console.log(`PROMPT_EVAL_REPEAT_SUMMARY=${successes}/${results.length}`);
console.log(`PROMPT_EVAL_REPEAT_PASS_RATE=${(successes / results.length).toFixed(4)}`);
console.log(`PROMPT_EVAL_REPEAT_WILSON95=${interval.low.toFixed(4)},${interval.high.toFixed(4)}`);
console.log(`PROMPT_EVAL_REPEAT_SOURCE_FINGERPRINTS=${JSON.stringify(fingerprints)}`);
console.log(`PROMPT_EVAL_REPEAT_FINGERPRINT_STABLE=${stableFingerprint}`);
console.log(`PROMPT_EVAL_REPEAT_ARTIFACT_PATH=${artifactPath}`);
if (successes !== results.length || !stableFingerprint) process.exitCode = 1;
