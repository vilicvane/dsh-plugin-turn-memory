import { eventContentText, eventMemoryKind } from './content.ts';

export interface PricedNode {
  seq: number;
  tokens: number;
}

export interface SessionSegment {
  id: string;
  index: number;
  seqs: number[];
  tokens: number;
  turns: number[];
  firstPreview: string;
  lastPreview: string;
}

interface TurnUnit {
  key: string;
  seqs: number[];
  tokens: number;
  turns: number[];
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

function preview(value: string, limit: number): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + '…';
}

function eventTurns(session: any): Map<number, number> {
  const turns = new Map<number, number>();
  let openTurn: number | undefined;
  for (const event of session.events as any[]) {
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) openTurn = event.data.turn;
    const isCompactionCheckpoint = event?.data?.source?.plugin === 'compact';
    const markerTurn = event?.data?.source?.plugin === 'turn-memory' && Number.isSafeInteger(event.data.source.turn)
      ? event.data.source.turn
      : undefined;
    const explicitTurn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : undefined;
    const turn = isCompactionCheckpoint ? undefined : markerTurn ?? explicitTurn ?? openTurn;
    if (turn !== undefined) turns.set(event.seq, turn);
    if (event?.type === 'turn/end' && event.data?.turn === openTurn) openTurn = undefined;
  }
  return turns;
}

function renderTurnRange(turns: readonly number[]): string {
  if (turns.length === 0) return 'standalone';
  const first = turns[0];
  const last = turns[turns.length - 1];
  return first === last ? 'turn=' + first : 'turns=' + first + '..' + last;
}

function eventOrigin(event: any): string {
  const source = event?.data?.source ?? event?.data?.message?.source;
  if (source?.kind === 'user') return 'human';
  if (source?.kind === 'model') return 'model:' + String(source.provider ?? '?') + '/' + String(source.model ?? '?');
  if (source?.kind === 'plugin') return 'plugin:' + String(source.plugin ?? '?');
  if (event?.type === 'tool/result') return 'tool';
  return source?.kind === undefined ? 'unknown' : String(source.kind);
}

/** Stable semantic unit keys for current surface positions; equal adjacent keys belong to one completed turn. */
export function sessionSurfaceUnitKeys(session: any, seqs: readonly number[]): string[] {
  const turnBySeq = eventTurns(session);
  return seqs.map((seq) => {
    const turn = turnBySeq.get(seq);
    return turn === undefined ? 'standalone:' + seq : 'turn:' + turn;
  });
}

/** Group a selected canonical surface range into token-budgeted, turn-aligned segments. */
export function buildSessionSegments(
  session: any,
  pricedNodes: readonly PricedNode[],
  maxTokens: number,
  previewChars = 120,
): SessionSegment[] {
  if (pricedNodes.length === 0) throw new Error('session segmentation requires at least one selected surface node');
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('segment maxTokens must be positive');
  const turnBySeq = eventTurns(session);
  const units: TurnUnit[] = [];
  for (const priced of pricedNodes) {
    const event = session.events[priced.seq];
    if (event === undefined || event.seq !== priced.seq) throw new Error('session compaction: surface seq ' + priced.seq + ' has no matching event');
    if (eventMemoryKind(event) === undefined) throw new Error('session compaction: surface seq ' + priced.seq + ' is not a message node');
    const turn = turnBySeq.get(priced.seq);
    const key = turn === undefined ? 'standalone:' + priced.seq : 'turn:' + turn;
    const last = units[units.length - 1];
    if (last !== undefined && last.key === key) {
      last.seqs.push(priced.seq);
      last.tokens += priced.tokens;
      continue;
    }
    units.push({ key, seqs: [priced.seq], tokens: priced.tokens, turns: turn === undefined ? [] : [turn] });
  }

  const groups: TurnUnit[][] = [];
  let current: TurnUnit[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    if (current.length > 0 && currentTokens + unit.tokens > maxTokens) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += unit.tokens;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const seqs = group.flatMap((unit) => unit.seqs);
    const turns = [...new Set(group.flatMap((unit) => unit.turns))];
    const firstText = eventContentText(session.events[seqs[0]]);
    const lastText = eventContentText(session.events[seqs[seqs.length - 1]]);
    return {
      id: 's' + (index + 1),
      index: index + 1,
      seqs,
      tokens: group.reduce((total, unit) => total + unit.tokens, 0),
      turns,
      firstPreview: preview(firstText, previewChars),
      lastPreview: preview(lastText, previewChars),
    };
  });
}

export function renderSegmentCatalog(
  segments: readonly SessionSegment[],
  status: (segment: number) => string,
): string {
  return segments.map((segment) => [
    segment.id,
    renderTurnRange(segment.turns),
    'nodes=' + segment.seqs.length,
    'tokens~' + segment.tokens,
    'status=' + status(segment.index),
    'first=' + JSON.stringify(segment.firstPreview),
    'last=' + JSON.stringify(segment.lastPreview),
  ].join(' | ')).join('\n');
}

export function renderSegmentSource(session: any, segment: SessionSegment): string {
  const turnBySeq = eventTurns(session);
  return segment.seqs.map((seq, index) => {
    const event = session.events[seq];
    const kind = eventMemoryKind(event);
    const turn = turnBySeq.get(seq);
    return [
      '<source-node id="' + segment.id + 'n' + (index + 1) + '" kind="' + kind + '" origin="' + eventOrigin(event) + '"' + (turn === undefined ? '' : ' turn="' + turn + '"') + '>',
      eventContentText(event),
      '</source-node>',
    ].join('\n');
  }).join('\n\n');
}

export function renderSegmentNodeDirectory(session: any, segment: SessionSegment, previewChars = 120): string {
  const turnBySeq = eventTurns(session);
  return segment.seqs.map((seq, index) => {
    const event = session.events[seq];
    const text = eventContentText(event);
    const turn = turnBySeq.get(seq);
    return [
      segment.id + 'n' + (index + 1),
      String(eventMemoryKind(event)),
      'origin=' + eventOrigin(event),
      turn === undefined ? 'standalone' : 'turn=' + turn,
      text.length + ' chars',
      'preview=' + JSON.stringify(preview(text, previewChars)),
    ].join(' | ');
  }).join('\n');
}

export interface SourceNodeRange {
  start: string;
  end?: string;
}

export function readSessionSourceNodes(
  session: any,
  segments: readonly SessionSegment[],
  ranges: readonly SourceNodeRange[],
  maxChars: number,
): string {
  if (ranges.length === 0) throw new Error('at least one source-node range is required');
  const ordered = segments.flatMap((segment) => segment.seqs.map((seq, index) => ({
    id: segment.id + 'n' + (index + 1),
    segment,
    seq,
    index,
  })));
  const byId = new Map(ordered.map((node, index) => [node.id, index]));
  const selected: typeof ordered = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const start = byId.get(range.start);
    const end = byId.get(range.end ?? range.start);
    if (start === undefined) throw new Error('unknown session source-node id ' + JSON.stringify(range.start));
    if (end === undefined) throw new Error('unknown session source-node id ' + JSON.stringify(range.end));
    if (start > end) throw new Error('source-node range is reversed: ' + range.start + '..' + (range.end ?? range.start));
    for (const node of ordered.slice(start, end + 1)) {
      if (!seen.has(node.id)) {
        selected.push(node);
        seen.add(node.id);
      }
    }
  }
  const turnBySeq = eventTurns(session);
  const rendered = selected.map((node) => {
    const event = session.events[node.seq];
    const turn = turnBySeq.get(node.seq);
    return [
      '<source-node id="' + node.id + '" kind="' + eventMemoryKind(event) + '" origin="' + eventOrigin(event) + '"' + (turn === undefined ? '' : ' turn="' + turn + '"') + '>',
      eventContentText(event),
      '</source-node>',
    ].join('\n');
  }).join('\n\n');
  if (rendered.length > maxChars) {
    throw new Error('requested session source-node content is ' + rendered.length + ' chars, above the ' + maxChars + '-char limit');
  }
  return rendered;
}
