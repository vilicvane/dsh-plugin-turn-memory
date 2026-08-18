import { randomUUID } from 'node:crypto';

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Process-local marker used to attach one plugin-owned worker scope. */
    turnMemoryWorkerToolScope?: string;
  }
}

const WORKER_SYSTEM_PROMPT = 'You are an isolated turn-memory worker. Follow the complete task contract in the current user message.';

/**
 * Attach the private tools and prompt boundary only to the exact in-process
 * worker whose AgentOptions carry this scope's marker. agent/created dispatch
 * is synchronous and precedes the child's first prompt.
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
      // A complete scoped section excludes global personas and plugin guidance;
      // runtime suppression excludes freshly assembled dynamic plugin context.
      // Historical snapshots already inherited from a fork remain source
      // evidence in the child session and are handled by the task protocol.
      agent.ctx.systemPrompt.suppressRuntimeContext();
      agent.ctx.systemPrompt.section({
        name: 'turn-memory:worker',
        order: 0,
        text: WORKER_SYSTEM_PROMPT,
        complete: true,
      });
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
