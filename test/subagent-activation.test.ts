import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startWorker, workerActivationSpec } from '../lib/subagent-activation.ts';

describe('worker activation', () => {
  it('builds the 0.2 startActivation spec without retired one-shot fields', () => {
    const signal = new AbortController().signal;
    const parent = { id: 'parent' };
    const prompt = [{ type: 'text', text: 'task' }];
    const spec = workerActivationSpec({
      provider: 'fork',
      label: 'turn-memory compression 7 (fork worker 1)',
      prompt,
      parent,
      signal,
      agentOptions: { turnMemoryWorkerToolScope: 'marker' },
    });
    assert.deepEqual(spec, {
      provider: 'fork',
      label: 'turn-memory compression 7 (fork worker 1)',
      request: { prompt, parent, agentOptions: { turnMemoryWorkerToolScope: 'marker' } },
      signal,
      delivery: 'caller',
    });
    assert.deepEqual(Object.keys(spec.request).sort(), ['agentOptions', 'parent', 'prompt']);
    assert.equal('persona' in spec.request, false);
    assert.equal('persona' in spec, false);
  });

  it('routes every worker through startActivation and returns its activation', async () => {
    const calls: unknown[] = [];
    const activation = { result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} };
    const activator = {
      startActivation(spec: unknown) {
        calls.push(spec);
        return Promise.resolve(activation);
      },
    };
    const run = await startWorker(activator, {
      provider: 'spawn',
      label: 'session memory segment (fresh-spawn)',
      prompt: [],
      parent: {},
      signal: new AbortController().signal,
    });
    assert.equal(run, activation);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).delivery, 'caller');
    assert.equal((calls[0] as any).provider, 'spawn');
    assert.equal('persona' in (calls[0] as any).request, false);
  });
});
