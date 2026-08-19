import { defineTool } from '@deepseek-ai/dsh-tools';

import { contentText, eventMemoryKind, reasoningStats } from './content.ts';
import { collectMemoryImageAttachments, renderMemoryImageReference } from './memory-images.ts';

export const READ_SESSION_HISTORY_TOOL_NAME = 'read_session_history';

export interface SessionHistoryConfig {
  enabled?: boolean;
  maxReadChars?: number;
  catalogTurns?: number;
}

interface ResolvedSessionHistoryConfig {
  maxReadChars: number;
  catalogTurns: number;
}

interface CompletedTurnSpan {
  turn: number;
  startIndex: number;
  endIndex: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('turn-memory ' + name + ' must be a positive integer');
  }
  return value;
}

function resolveConfig(config: SessionHistoryConfig = {}): ResolvedSessionHistoryConfig {
  return {
    maxReadChars: positiveInteger(config.maxReadChars, 160_000, 'sessionHistory.maxReadChars'),
    catalogTurns: positiveInteger(config.catalogTurns, 40, 'sessionHistory.catalogTurns'),
  };
}

function completedTurnSpans(session: any): CompletedTurnSpan[] {
  const spans: CompletedTurnSpan[] = [];
  let open: { turn: number; startIndex: number } | undefined;
  for (let index = 0; index < (session.events?.length ?? 0); index += 1) {
    const event = session.events[index];
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      open = { turn: event.data.turn, startIndex: index };
      continue;
    }
    if (event?.type === 'turn/end' && open !== undefined && event.data?.turn === open.turn) {
      spans.push({ turn: open.turn, startIndex: open.startIndex, endIndex: index });
      open = undefined;
    }
  }
  return spans;
}

function spanEvents(session: any, span: CompletedTurnSpan): any[] {
  return session.events.slice(span.startIndex + 1, span.endIndex)
    .filter((event: any) => eventMemoryKind(event) !== undefined);
}

function eventContent(event: any): unknown {
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') {
    return event.data?.message?.content;
  }
  return event?.data?.content;
}

function xmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function eventOrigin(event: any): string {
  const source = event?.data?.source ?? event?.data?.message?.source;
  if (source?.kind === 'user') return 'human';
  if (source?.kind === 'model') return 'model:' + String(source.provider ?? '?') + '/' + String(source.model ?? '?');
  if (source?.kind === 'plugin') return 'plugin:' + String(source.plugin ?? '?');
  if (event?.type === 'tool/result') return 'tool';
  return source?.kind === undefined ? 'unknown' : String(source.kind);
}

/** Render the original durable block order, including reasoning that ordinary surface text omits. */
export function renderRawSessionContent(value: unknown): string {
  const chunks: string[] = [];
  let reasoningIndex = 0;
  const visit = (item: unknown): void => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') {
      chunks.push(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      chunks.push(record.text);
      return;
    }
    if (record.type === 'reasoning' && typeof record.text === 'string') {
      reasoningIndex += 1;
      chunks.push('<reasoning-block index="' + reasoningIndex + '" chars="' + record.text.length + '">\n'
        + record.text + '\n</reasoning-block>');
      return;
    }
    if (record.type === 'image') {
      const ref = collectMemoryImageAttachments(record)[0];
      if (ref !== undefined) chunks.push(renderMemoryImageReference(ref));
      return;
    }
    if (record.type === 'tool-call') {
      chunks.push('[tool-call ' + String(record.name ?? 'unknown') + ' arguments=' + String(record.arguments ?? '') + ']');
      return;
    }
    if (Object.hasOwn(record, 'content')) visit(record.content);
  };
  visit(value);
  return chunks.join('\n').trim();
}

function compressedTurnNumbers(session: any): Set<number> {
  const turns = new Set<number>();
  for (const event of session.events as readonly any[]) {
    const source = event?.data?.source;
    if (source?.plugin === 'turn-memory' && source.phase === 'compression' && Number.isSafeInteger(source.turn)) {
      turns.add(source.turn);
    }
  }
  return turns;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function preview(value: string, limit = 120): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…';
}

export function renderSessionHistoryCatalog(
  session: any,
  beforeTurn?: number,
  limit = 40,
): string {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error('session history catalog limit must be an integer from 1 to 100');
  }
  if (beforeTurn !== undefined && (!Number.isSafeInteger(beforeTurn) || beforeTurn <= 0)) {
    throw new Error('session history beforeTurn must be a positive integer');
  }
  const compressed = compressedTurnNumbers(session);
  const spans = completedTurnSpans(session)
    .filter((span) => beforeTurn === undefined || span.turn < beforeTurn)
    .slice(-limit)
    .reverse();
  if (spans.length === 0) return 'No completed session turns found for this catalog page.';
  const lines = spans.map((span) => {
    const events = spanEvents(session, span);
    const reasoning = events.reduce((total, event) => total + reasoningStats(eventContent(event)).totalChars, 0);
    const visible = events.reduce((total, event) => total + contentText(eventContent(event)).length, 0);
    const firstUser = events.find((event) => event.type === 'user/message');
    return 'turn=' + span.turn
      + ' | nodes=' + events.length
      + ' | visible-chars=' + visible
      + ' | reasoning-chars=' + reasoning
      + ' | memory=' + (compressed.has(span.turn) ? 'compressed' : 'raw')
      + ' | user=' + JSON.stringify(preview(contentText(firstUser?.data?.content)));
  });
  const oldest = spans[spans.length - 1].turn;
  lines.push('Use turn=<n> to read one original completed turn, including reasoning. For older entries, call again with beforeTurn=' + oldest + '.');
  return lines.join('\n');
}

export function renderSessionTurnHistory(session: any, turn: number): string {
  if (!Number.isSafeInteger(turn) || turn <= 0) throw new Error('session history turn must be a positive integer');
  const span = completedTurnSpans(session).find((candidate) => candidate.turn === turn);
  if (span === undefined) throw new Error('completed session turn ' + turn + ' was not found');
  const current = new Set<number>(session.surface?.nodes ?? []);
  const nodes = spanEvents(session, span).map((event) => {
    const seq = Number(event.seq);
    return '<session-history-node seq="' + seq
      + '" kind="' + eventMemoryKind(event)
      + '" origin="' + xmlAttribute(eventOrigin(event))
      + '" surface="' + (current.has(seq) ? 'current' : 'shadowed') + '">\n'
      + renderRawSessionContent(eventContent(event))
      + '\n</session-history-node>';
  });
  return '<session-history turn="' + turn + '" source="append-only-original">\n'
    + nodes.join('\n\n')
    + '\n</session-history>';
}

/** Public, read-only fallback over the calling agent's own append-only session log. */
export function createReadSessionHistoryTool(config: SessionHistoryConfig = {}): any {
  const resolved = resolveConfig(config);
  return defineTool({
    name: READ_SESSION_HISTORY_TOOL_NAME,
    description: 'Recover costly detail omitted by compressed conversation memory from this session\'s append-only original turns. Omit turn to list recent completed turns; provide turn to read its original user, assistant, reasoning, and tool-result nodes. Use as an on-demand fallback, not as routine context replay.',
    parameters: {
      turn: { type: 'number', description: 'Completed turn number to read. Omit to list a recent-turn catalog.' },
      beforeTurn: { type: 'number', description: 'Catalog only: list turns older than this exclusive turn number.' },
      limit: { type: 'number', description: 'Catalog only: number of turns from 1 to 100; defaults to the plugin catalogTurns setting.' },
      offset: { type: 'number', description: 'Read only: zero-based character offset into the rendered original turn; defaults to 0.' },
    },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args: { turn?: number; beforeTurn?: number; limit?: number; offset?: number }, exec: any) {
      const session = exec.agent?.session;
      if (session === undefined) throw new Error('read_session_history requires an owning agent session');
      if (args.turn === undefined) {
        if (args.offset !== undefined) throw new Error('session history offset requires turn');
        return renderSessionHistoryCatalog(session, args.beforeTurn, args.limit ?? resolved.catalogTurns);
      }
      if (args.beforeTurn !== undefined || args.limit !== undefined) {
        throw new Error('session history beforeTurn and limit are catalog-only parameters');
      }
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('session history offset must be a non-negative integer');
      const full = renderSessionTurnHistory(session, args.turn);
      if (offset >= full.length && full.length > 0) {
        throw new Error('session history offset ' + offset + ' is outside the ' + full.length + '-character turn');
      }
      const end = Math.min(full.length, offset + resolved.maxReadChars);
      const body = full.slice(offset, end);
      if (offset === 0 && end === full.length) return body;
      return '<session-history-excerpt turn="' + args.turn + '" chars="' + offset + '..' + end
        + '" total-chars="' + full.length + '">\n' + body + '\n</session-history-excerpt>\n'
        + (end < full.length ? 'Continue with turn=' + args.turn + ' offset=' + end + '.' : 'End of original turn.');
    },
  });
}
