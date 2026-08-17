import { randomUUID } from 'node:crypto';

/** Return the latest durable turn/end for each completed turn, oldest first. */
export function completedTurnEnds(session: any): any[] {
  const byTurn = new Map<number, any>();
  for (const event of session?.events ?? []) {
    const turn = event?.data?.turn;
    if (event?.type !== 'turn/end' || !Number.isSafeInteger(turn)) continue;
    const previous = byTurn.get(turn);
    if (previous === undefined || event.seq > previous.seq) byTurn.set(turn, event);
  }
  return [...byTurn.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * A landed compression marker is durable even after a later surface rewrite
 * shadows it, so scan the append-only event log rather than only the surface.
 */
export function compressedTurnNumbers(session: any): Set<number> {
  const turns = new Set<number>();
  for (const event of session?.events ?? []) {
    const source = event?.data?.source;
    if (source?.plugin !== 'turn-memory' || source.phase !== 'compression') continue;
    if (Number.isSafeInteger(source.turn)) turns.add(source.turn);
  }
  return turns;
}

export function findCompletedTurnEnd(session: any, turn: number): any | undefined {
  let found: any | undefined;
  for (const event of session?.events ?? []) {
    if (event?.type !== 'turn/end' || event.data?.turn !== turn) continue;
    if (found === undefined || event.seq > found.seq) found = event;
  }
  return found;
}

export function turnCompressionBypassReason(nodes: readonly { kind: string; content: string }[]): string | undefined {
  if (nodes.length > 0 && nodes[0].kind === 'user'
    && !nodes.some((node) => node.kind === 'assistant' && node.content.trim() !== '')) {
    return 'completed turn has no non-empty assistant transcript';
  }
  return undefined;
}

/**
 * Persist a successful semantic no-op without changing the visible transcript.
 * DSH has no third-party log-only event registry, so replace the turn's first
 * user node with an exact-content copy carrying the durable landing marker.
 */
export function appendNoopCompressionMarker(session: any, original: any, marker: any): any {
  if (original?.type !== 'user/message') {
    throw new Error('turn-memory no-op marker requires an original user/message landing node');
  }
  return session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: original.data.content,
    source: marker,
  }, {
    surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
    sourceEventSeqs: [original.seq],
  });
}
