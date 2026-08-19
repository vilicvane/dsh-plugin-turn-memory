import { randomUUID } from 'node:crypto';

import { reasoningBlockTexts } from './content.ts';

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

/**
 * Return turns whose latest durable lifecycle marker says compression was
 * queued but has not landed. This is the cold-recovery boundary: an old turn
 * with no marker predates plugin observation and must not be backfilled merely
 * because somebody later opens or forks that session.
 */
export function pendingTurnNumbers(session: any): Set<number> {
  const latestPhase = new Map<number, 'pending' | 'compression'>();
  for (const event of session?.events ?? []) {
    const source = event?.data?.source;
    if (source?.plugin !== 'turn-memory'
      || (source.phase !== 'pending' && source.phase !== 'compression')
      || !Number.isSafeInteger(source.turn)) continue;
    latestPhase.set(source.turn, source.phase);
  }
  return new Set([...latestPhase].filter(([, phase]) => phase === 'pending').map(([turn]) => turn));
}

export function findCompletedTurnEnd(session: any, turn: number): any | undefined {
  let found: any | undefined;
  for (const event of session?.events ?? []) {
    if (event?.type !== 'turn/end' || event.data?.turn !== turn) continue;
    if (found === undefined || event.seq > found.seq) found = event;
  }
  return found;
}

/** Current-surface raw reasoning means an older completion marker no longer satisfies this implementation's contract. */
export function turnHasUnrewrittenReasoning(session: any, turn: number): boolean {
  for (const seq of session?.surface?.nodes ?? []) {
    const event = session.events[seq];
    if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue;
    if (reasoningBlockTexts(event.data?.message?.content).length > 0) return true;
  }
  return false;
}

/** Select one turn's current surface, including a late turn-memory marker appended after turn/end. */
export function turnSurfaceSeqs(session: any, turn: number, startSeq: number, endSeq: number): number[] {
  return (session?.surface?.nodes ?? []).filter((seq: number) => {
    if (seq <= startSeq) return false;
    const source = session.events[seq]?.data?.source;
    if (source?.plugin === 'compact') return false;
    if (source?.plugin === 'turn-memory' && Number.isSafeInteger(source.turn)) return source.turn === turn;
    return seq <= endSeq;
  });
}

export function turnCompressionBypassReason(nodes: readonly { kind: string; content: string }[]): string | undefined {
  if (nodes.length > 0 && nodes[0].kind === 'user'
    && !nodes.some((node) => node.kind === 'assistant' && node.content.trim() !== '')) {
    return 'completed turn has no non-empty assistant transcript';
  }
  return undefined;
}

/** Persist lifecycle metadata as an exact-content user replacement. */
export function appendTurnMarkerCopy(session: any, original: any, marker: any): any {
  if (original?.type !== 'user/message') {
    throw new Error('turn-memory marker requires an original user/message landing node');
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
