import { randomUUID } from 'node:crypto';

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Process-local marker used to attach one plugin-owned worker tool scope. */
    turnMemoryWorkerToolScope?: string;
  }
}

/**
 * Keep host editor tools out of the global registry and attach them only to
 * the exact in-process worker whose AgentOptions carry this scope's marker.
 * agent/created dispatch is synchronous and precedes the child's first prompt.
 */
export class WorkerToolScope {
  private readonly marker = randomUUID();

  constructor(ctx: any, definitions: readonly any[]) {
    const names = definitions.map((definition) => definition.name);
    if (names.length === 0 || new Set(names).size !== names.length) {
      throw new Error('worker tool scope requires non-empty, uniquely named definitions');
    }
    ctx.on('agent/created', ({ agent }: any) => {
      if (agent?.options?.turnMemoryWorkerToolScope !== this.marker) return;
      // Restrictions hide inherited/global capabilities. Agent-local tools are
      // merged afterward, so only the definitions below reach the worker.
      agent.ctx.tools.restrict({ allow: [] });
      for (const definition of definitions) agent.ctx.tools.register(definition);
    });
  }

  agentOptions(): { turnMemoryWorkerToolScope: string } {
    return { turnMemoryWorkerToolScope: this.marker };
  }
}
