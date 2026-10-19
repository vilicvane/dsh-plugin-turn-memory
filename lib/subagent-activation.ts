/**
 * The 0.2 activation surface used by turn-memory workers. DSH 0.1.5 exposed
 * `subagents.start(name, request)`; 0.2 replaced it with `startActivation(spec)`
 * and dropped the per-child `persona`. Keeping this narrow interface in one
 * place makes a future API removal a typecheck failure at both worker sites
 * instead of a runtime `TypeError` swallowed by the logger.
 */
export interface WorkerActivationRequest {
  prompt: readonly unknown[];
  parent: unknown;
  agentOptions?: Record<string, unknown>;
}

export interface WorkerActivationSpec {
  provider: string;
  label: string;
  request: WorkerActivationRequest;
  signal: AbortSignal;
  delivery: 'caller';
}

export interface WorkerActivation {
  result: Promise<{ stopReason: string } & Record<string, unknown>>;
  dispose(): Promise<void>;
}

export interface WorkerActivator {
  startActivation(spec: WorkerActivationSpec): Promise<WorkerActivation>;
}

export interface WorkerStart {
  provider: string;
  label: string;
  prompt: readonly unknown[];
  parent: unknown;
  signal: AbortSignal;
  agentOptions?: Record<string, unknown>;
}

/** Build the 0.2 activation spec; never reintroduce the retired one-shot fields. */
export function workerActivationSpec(start: WorkerStart): WorkerActivationSpec {
  return {
    provider: start.provider,
    label: start.label,
    request: {
      prompt: start.prompt,
      parent: start.parent,
      ...(start.agentOptions === undefined ? {} : { agentOptions: start.agentOptions }),
    },
    signal: start.signal,
    delivery: 'caller',
  };
}

/** Start one worker through the 0.2 activation API. */
export function startWorker(activator: WorkerActivator, start: WorkerStart): Promise<WorkerActivation> {
  return activator.startActivation(workerActivationSpec(start));
}
