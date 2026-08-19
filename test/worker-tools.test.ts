import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerToolScope } from '../lib/worker-tools.ts';

describe('WorkerToolScope', () => {
  it('keeps definitions global-free and attaches them only to the marked agent', () => {
    let created: ((event: any) => void) | undefined;
    const globalRegistrations: string[] = [];
    const ctx = {
      tools: { register: (definition: any) => globalRegistrations.push(definition.name) },
      on(name: string, listener: (event: any) => void) {
        assert.equal(name, 'agent/created');
        created = listener;
      },
    };
    const definitions = [{ name: 'internal_a' }, { name: 'internal_b' }];
    const scope = new WorkerToolScope(ctx, definitions);
    const startOptions = scope.startOptions();

    assert.deepEqual(globalRegistrations, []);
    assert.equal(startOptions.persona,
      'You are an isolated turn-memory worker. Follow the complete task contract in the current user message.');
    assert.deepEqual(startOptions.agentOptions, scope.agentOptions());

    const observed = (options: any) => {
      const restrictions: any[] = [];
      const registrations: string[] = [];
      let runtimeContextSuppressions = 0;
      const sections: any[] = [];
      created!({
        agent: {
          options,
          ctx: {
            systemPrompt: {
              suppressRuntimeContext: () => { runtimeContextSuppressions += 1; },
              section: (section: any) => sections.push(section),
            },
            tools: {
              restrict: (filter: any) => restrictions.push(filter),
              register: (definition: any) => registrations.push(definition.name),
            },
          },
        },
      });
      return { restrictions, registrations, runtimeContextSuppressions, sections };
    };

    assert.deepEqual(observed({}), {
      restrictions: [],
      registrations: [],
      runtimeContextSuppressions: 0,
      sections: [],
    });
    assert.deepEqual(observed(startOptions.agentOptions), {
      restrictions: [{ allow: [] }],
      registrations: ['internal_a', 'internal_b'],
      runtimeContextSuppressions: 1,
      sections: [{
        name: 'turn-memory:worker',
        order: 0,
        text: 'You are an isolated turn-memory worker. Follow the complete task contract in the current user message.',
        complete: true,
      }],
    });
  });

  it('rejects empty and duplicate definition sets', () => {
    const ctx = { on() {} };
    assert.throws(() => new WorkerToolScope(ctx, []), /non-empty/);
    assert.throws(() => new WorkerToolScope(ctx, [{ name: 'same' }, { name: 'same' }]), /uniquely named/);
  });
});
