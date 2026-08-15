/**
 * Pure rendering and accumulation for the request-prefix boundary dump
 * appended after each compaction replacement lands: the checkpoint node and
 * the first kept node after it — the last two nodes at the boundary —
 * rendered the way their message text reaches the front of the next request.
 * Blocks accumulate per session file, separated by a divider line, so every
 * replacement boundary stays on record. Extracted from the plugin entry so
 * the rendering is unit-testable without booting the plugin.
 *
 * Style matches the entry file: plain string concatenation, no template
 * literals, so sources stay embeddable without quoting hazards.
 */

/** Structural view of a surface node event (the parts the dump renders). */
export interface BoundaryNodeLike {
  type?: string;
  data?: {
    content?: readonly {
      type?: string;
      text?: string;
      name?: string;
      toolCallId?: string;
    }[];
    name?: string;
    message?: {
      content?: readonly {
        type?: string;
        text?: string;
        name?: string;
        toolCallId?: string;
      }[];
      name?: string;
    };
  };
}

/** Fixed header facts for one dump. */
export interface PrefixBoundaryMeta {
  /** ISO timestamp of the dump. */
  timestamp: string;
  sessionId: string;
  /** How the replacement was made: 'in-turn (current turn)' | 'whole-turn (compact_turn, turn 7)' | 'whole-turn (fork fallback, turn 5)'. */
  mode: string;
  /** Seq of the landed checkpoint node. */
  checkpointSeq: number;
  /** Seq of the first kept node after the checkpoint, or null when the replaced span ran to the surface tail. */
  nextSeq: number | null;
  /** Surface nodes the checkpoint replaced. */
  replacedNodes: number;
  /** '[startSeq, endSeq]' of the replaced span. */
  replacedSpan: string;
  /** Optional extra line, e.g. the kept turn-starting message note. */
  note?: string;
}

const NL = String.fromCharCode(10);

/** Name of one session's dump file: request-prefix-<sessionId>.txt, with any character outside [A-Za-z0-9._-] replaced by "_". */
export function buildDumpFileName(sessionId: string): string {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_');
  return 'request-prefix-' + (safe === '' ? 'unknown' : safe) + '.txt';
}

/** Render one surface node the way its text reaches the request front. */
export function renderBoundaryNode(event: BoundaryNodeLike | undefined): string {
  if (event === undefined) return '[none]';
  const type = event.type ?? 'unknown';
  if (type === 'user/message' || type === 'assistant/message') {
    const parts: string[] = [];
    for (const part of event.data?.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.type === 'string') parts.push('[' + part.type + ']');
    }
    const text = parts.join('');
    if (text === '') return '[' + type + ': no text content]';
    return text;
  }
  if (type === 'tool/result') {
    const first = event.data?.message?.content?.[0];
    const name = event.data?.name ?? event.data?.message?.name ?? first?.name ?? '';
    const callId = typeof first?.toolCallId === 'string' ? first.toolCallId : '';
    const label = name === '' ? (callId === '' ? 'tool/result' : 'tool/result callId=' + callId) : 'tool/result: ' + name;
    return '[' + label + ']';
  }
  return '[' + type + ']';
}

/**
 * Render one boundary dump: a small header plus the checkpoint node and the
 * first kept node after it, each shown the way its text reaches the request
 * front. When nextSeq is null the replaced span ran to the surface tail and
 * the second block is omitted.
 */
export function renderPrefixBoundary(
  meta: PrefixBoundaryMeta,
  checkpoint: BoundaryNodeLike | undefined,
  next: BoundaryNodeLike | undefined,
): string {
  const lines = [
    '# request-prefix boundary — ' + meta.timestamp,
    'session: ' + meta.sessionId,
    'mode: ' + meta.mode,
    'checkpoint: seq ' + meta.checkpointSeq + ' (' + meta.replacedNodes + ' surface nodes replaced, span ' + meta.replacedSpan + ')',
    'next: ' + (meta.nextSeq === null ? 'none — the replaced span ran to the surface tail' : 'seq ' + meta.nextSeq + ' (kept verbatim)'),
  ];
  if (typeof meta.note === 'string' && meta.note !== '') lines.push('note: ' + meta.note);
  lines.push('==== checkpoint node (seq ' + meta.checkpointSeq + ') ====');
  lines.push(renderBoundaryNode(checkpoint));
  if (meta.nextSeq !== null) {
    lines.push('==== next node (seq ' + meta.nextSeq + ') ====');
    lines.push(renderBoundaryNode(next));
  }
  return lines.join(NL) + NL;
}

/** Divider line between consecutive dump blocks in the accumulated file. */
export const DUMP_BLOCK_SEPARATOR = '================ next replacement ================';

/**
 * Append one boundary dump block to the accumulated file content: the first
 * block lands verbatim, every later block follows the divider line. Blocks
 * keep their chronological order — oldest boundary first, newest last.
 */
export function appendDumpBlock(existing: string, block: string): string {
  if (existing === '') return block;
  return existing + NL + DUMP_BLOCK_SEPARATOR + NL + NL + block;
}
