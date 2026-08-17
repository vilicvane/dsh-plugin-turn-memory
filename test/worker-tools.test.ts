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

    assert.deepEqual(globalRegistrations, []);

    const observed = (options: any) => {
      const restrictions: any[] = [];
      const registrations: string[] = [];
      created!({
        agent: {
          options,
          ctx: {
            tools: {
              restrict: (filter: any) => restrictions.push(filter),
              register: (definition: any) => registrations.push(definition.name),
            },
          },
        },
      });
      return { restrictions, registrations };
    };

    assert.deepEqual(observed({}), { restrictions: [], registrations: [] });
    assert.deepEqual(observed(scope.agentOptions()), {
      restrictions: [{ allow: [] }],
      registrations: ['internal_a', 'internal_b'],
    });
  });

  it('rejects empty and duplicate definition sets', () => {
    const ctx = { on() {} };
    assert.throws(() => new WorkerToolScope(ctx, []), /non-empty/);
    assert.throws(() => new WorkerToolScope(ctx, [{ name: 'same' }, { name: 'same' }]), /uniquely named/);
  });
});
