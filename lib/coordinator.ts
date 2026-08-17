/** Per-session barrier between completed-turn rewriting and session compaction. */
export class MemoryCoordinator {
  private readonly turnRewrites = new Map<string, Promise<void>>();

  trackTurnRewrite(sessionId: string, work: Promise<void>): void {
    this.turnRewrites.set(sessionId, work);
    void work.finally(() => {
      if (this.turnRewrites.get(sessionId) === work) this.turnRewrites.delete(sessionId);
    }).catch(() => undefined);
  }

  async waitForTurnRewrite(sessionId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.turnRewrites.get(sessionId);
    if (pending === undefined) return;
    signal?.throwIfAborted();
    if (signal === undefined) {
      await pending;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    });
    signal.throwIfAborted();
  }
}
