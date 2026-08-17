/**
 * Pure JSONL draft-file operations for the turn-summary fork's segment
 * tools. The draft is one JSON object per ORIGINAL surface node —
 * {"seq":N,"kind":"user|assistant|tool|context","content":"..."} — the node
 * seq doubles as the line id, so the fork targets one node by id without
 * reproducing old content and without anchor regexes. The same lines drive
 * the N -> M landing: each kept line becomes one same-role replacement
 * event, consecutive same-role nodes merge, emptied lines drop their node.
 * Extracted from the plugin entry so parsing, shape checks, and unit
 * grouping are unit-testable without booting the plugin.
 *
 * Style matches the entry file: plain string concatenation, no template
 * literals, so sources stay embeddable without quoting hazards.
 */

/** The four line kinds of the draft. */
export type DraftKind = 'user' | 'assistant' | 'tool' | 'context';

/** One parsed draft line. */
export interface DraftLine {
  /** The original node seq — the line id. */
  seq: number;
  kind: DraftKind;
  content: string;
}

/** Tool-call provenance attached to the assistant unit directly preceding a kept tool unit. */
export interface ReplacementToolCall {
  /** The call id, matching the tool/result's message source callId. */
  id: string;
  /** The tool name from the original tool/call event. */
  name: string;
  /** The original arguments string from the tool/call event. */
  arguments: string;
}

/** One landing unit: a same-role replacement event covering a run of original nodes. */
export interface ReplacementUnit {
  /** Replacement event role: user/message, assistant/message, or tool/result. */
  role: 'user' | 'assistant' | 'tool';
  /** The replacement node's text content. */
  text: string;
  /** Original node seqs this unit shadows, in surface order. */
  coveredSeqs: number[];
  /** Tool-call blocks to land in this unit's assistant content (assistant units only). */
  toolCalls?: ReplacementToolCall[];
}

const NL = String.fromCharCode(10);

/** Parse a JSONL draft into ordered lines; returns an error string on any malformed line. */
export function parseDraftLines(text: string): DraftLine[] | string {
  const lines: DraftLine[] = [];
  for (const raw of text.split(NL)) {
    if (raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return 'draft line is not valid JSON: ' + raw.slice(0, 80);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'draft line is not an object: ' + raw.slice(0, 80);
    const record = value as { seq?: unknown; kind?: unknown; content?: unknown };
    if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq)) return 'draft line has no integer seq: ' + raw.slice(0, 80);
    if (record.kind !== 'user' && record.kind !== 'assistant' && record.kind !== 'tool' && record.kind !== 'context') return 'draft line has an invalid kind: ' + raw.slice(0, 80);
    if (typeof record.content !== 'string') return 'draft line has no string content: ' + raw.slice(0, 80);
    if (lines.length > 0 && record.seq <= lines[lines.length - 1].seq) return 'draft line seqs must be strictly ascending (line ' + lines.length + ')';
    lines.push({ seq: record.seq, kind: record.kind, content: record.content });
  }
  return lines;
}

/** Error text listing the draft's line ids, for unknown-id messages. */
export function lineIdList(text: string): string {
  const parsed = parseDraftLines(text);
  if (typeof parsed === 'string') return parsed;
  const ids = parsed.map((line) => String(line.seq));
  return ids.length === 0 ? 'none' : ids.join(', ');
}

/** Content of the line with the given node seq, or null when unknown. */
export function readLineContent(text: string, id: number): string | null {
  const parsed = parseDraftLines(text);
  if (typeof parsed === 'string') return null;
  for (const line of parsed) if (line.seq === id) return line.content;
  return null;
}

/** Replace the content of the line with the given node seq; the seq and kind stay. Returns null when the id is unknown. */
export function replaceLineContent(text: string, id: number, content: string): string | null {
  const rawLines = text.split(NL);
  let found = false;
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as { seq?: unknown; kind?: unknown };
    if (record.seq !== id) continue;
    const kind = record.kind;
    rawLines[i] = JSON.stringify({ seq: id, kind, content });
    found = true;
    break;
  }
  if (!found) return null;
  return rawLines.join(NL);
}

/** One grep hit: the line it lives in plus matching lines with global line numbers. */
export interface DraftGrepHit {
  id: number;
  kind: DraftKind;
  lines: { lineNumber: number; text: string }[];
}

/** Search every draft line for a JS regular expression; return hits with global line numbers. */
export function grepDraftLines(text: string, pattern: string): DraftGrepHit[] | string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return 'draft_grep: invalid pattern: ' + String(error instanceof Error ? error.message : error);
  }
  const rawLines = text.split(NL);
  const hits: DraftGrepHit[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as { seq?: unknown; kind?: unknown; content?: unknown };
    if (typeof record.content !== 'string' || !regex.test(record.content)) continue;
    regex.lastIndex = 0;
    const contentLines = record.content.split(NL);
    const hitLines: { lineNumber: number; text: string }[] = [];
    for (let j = 0; j < contentLines.length; j += 1) {
      if (regex.test(contentLines[j])) {
        regex.lastIndex = 0;
        hitLines.push({ lineNumber: i + 1, text: contentLines[j] });
      }
    }
    if (hitLines.length > 0) hits.push({ id: record.seq as number, kind: record.kind as DraftKind, lines: hitLines });
  }
  return hits;
}

/**
 * Shape guard between the seeded draft and the fork's final draft: same
 * line sequence (seq and kind per position, strictly ascending) and
 * byte-identical user/assistant contents. tool/context contents may change
 * (compressed to one line or emptied to drop the node). Returns null when
 * the final draft is acceptable, otherwise an error naming the first
 * divergence.
 */
export function draftShapeCheck(seedText: string, finalText: string): string | null {
  const seeded = parseDraftLines(seedText);
  const finalLines = parseDraftLines(finalText);
  if (typeof seeded === 'string') return 'seeded draft is malformed: ' + seeded;
  if (typeof finalLines === 'string') return 'final draft is malformed: ' + finalLines;
  if (finalLines.length !== seeded.length) {
    return 'the draft has ' + finalLines.length + ' lines but the seeded transcript had ' + seeded.length;
  }
  for (let i = 0; i < seeded.length; i += 1) {
    const before = seeded[i];
    const after = finalLines[i];
    if (after.seq !== before.seq || after.kind !== before.kind) {
      return 'line ' + i + ' changed from seq ' + before.seq + ' kind ' + before.kind + ' to seq ' + after.seq + ' kind ' + after.kind;
    }
    if ((before.kind === 'user' || before.kind === 'assistant') && after.content !== before.content) {
      return 'the ' + before.kind + ' line (seq ' + before.seq + ') changed — user and assistant content must stay byte for byte';
    }
  }
  return null;
}

/**
 * Group a span's original nodes into landing units from the fork's final
 * draft lines. Kept lines (non-empty content) become same-role replacement
 * events — tool lines 1:1 (the harness only allows a tool/result replacement
 * to shadow exactly one node), consecutive user/assistant lines merge, kept
 * context lines ride along as assistant narrative. Emptied lines drop their
 * node: the dropped seq attaches to the previous non-tool unit, otherwise
 * to the next non-tool unit, otherwise it forms an empty assistant unit of
 * its own — tool units never absorb drops. All dropped yields one empty
 * assistant unit shadowing the whole span.
 */
export function buildReplacementUnits(spanSeqs: readonly number[], lines: readonly DraftLine[]): ReplacementUnit[] | string {
  const bySeq = new Map<number, DraftLine>();
  for (const line of lines) bySeq.set(line.seq, line);
  const units: ReplacementUnit[] = [];
  let pendingDrops: number[] = [];
  const current = () => (units.length === 0 ? null : units[units.length - 1]);
  for (const seq of spanSeqs) {
    const line = bySeq.get(seq);
    if (line === undefined) return 'no draft line for node seq ' + seq;
    const keep = line.content.trim() !== '';
    const role = keep ? (line.kind === 'context' ? 'assistant' : line.kind) : 'drop';
    if (role === 'drop') {
      pendingDrops.push(seq);
      continue;
    }
    const last = current();
    if (pendingDrops.length > 0) {
      if (last !== null && last.role !== 'tool') {
        last.coveredSeqs.push(...pendingDrops);
        pendingDrops = [];
      } else if (role !== 'tool') {
        // This new non-tool unit absorbs the leading drops.
      } else {
        units.push({ role: 'assistant', text: '', coveredSeqs: pendingDrops });
        pendingDrops = [];
      }
    }
    const now = current();
    if (now !== null && now.role === role && role !== 'tool') {
      now.text += (now.text === '' ? '' : NL) + line.content;
      now.coveredSeqs.push(seq);
    } else {
      units.push({ role, text: line.content, coveredSeqs: pendingDrops.concat([seq]) });
      pendingDrops = [];
    }
  }
  if (pendingDrops.length > 0) {
    const last = current();
    if (last !== null && last.role !== 'tool') last.coveredSeqs.push(...pendingDrops);
    else units.push({ role: 'assistant', text: '', coveredSeqs: pendingDrops });
  }
  if (units.length === 0) {
    return [{ role: 'assistant', text: '', coveredSeqs: [...spanSeqs] }];
  }
  return units;
}

/** Provider-facing content block for one assistant replacement unit. */
export type ReplacementContentBlock = { type: 'text'; text: string } | ReplacementToolCall & { type: 'tool-call' };

/**
 * Content blocks for one assistant replacement unit's message: its text when
 * present plus the tool-call blocks pairing any kept tool units that follow.
 * An assistant unit with neither produces an empty content array, which the
 * harness projects to no provider message at all.
 */
export function assistantUnitBlocks(unit: ReplacementUnit): ReplacementContentBlock[] {
  const blocks: ReplacementContentBlock[] = [];
  if (unit.text !== '') blocks.push({ type: 'text', text: unit.text });
  for (const call of unit.toolCalls ?? []) blocks.push({ type: 'tool-call', ...call });
  return blocks;
}

/**
 * Post-process landing units into a provider-safe sequence. The provider
 * rejects a tool message whose directly preceding assistant message carries
 * no matching tool-call block, so every kept tool unit must follow an
 * assistant unit that carries the call. callOf resolves one tool unit's
 * original call metadata (id/name/arguments) from the log; undefined means
 * the pairing cannot be established.
 *
 * - a tool unit after an assistant unit (with resolvable call): the
 *   assistant gains the tool-call block and the tool unit stays a 1:1
 *   rewrite;
 * - otherwise (kept user line before it, first unit, or unresolvable call):
 *   the tool line folds into a neighbouring non-tool unit — the previous
 *   one when it exists and is not a tool, else the next one — so no
 *   unpaired tool message reaches the surface;
 * - a lone tool unit with no usable neighbour degrades to an assistant
 *   unit carrying the tool text.
 */
export function pairToolUnits(units: readonly ReplacementUnit[], callOf: (unit: ReplacementUnit) => ReplacementToolCall | undefined): ReplacementUnit[] {
  const out: ReplacementUnit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const source = units[i];
    const unit: ReplacementUnit = {
      role: source.role,
      text: source.text,
      coveredSeqs: [...source.coveredSeqs],
      ...(source.toolCalls === undefined ? {} : { toolCalls: [...source.toolCalls] }),
    };
    if (unit.role !== 'tool') {
      out.push(unit);
      continue;
    }
    const prev = out[out.length - 1];
    const call = callOf(unit);
    if (prev !== undefined && prev.role === 'assistant' && call !== undefined) {
      prev.toolCalls = [...(prev.toolCalls ?? []), call];
      out.push(unit);
      continue;
    }
    if (prev !== undefined && prev.role !== 'tool') {
      prev.text = prev.text === '' ? unit.text : prev.text + NL + unit.text;
      prev.coveredSeqs.push(...unit.coveredSeqs);
      continue;
    }
    const next = units[i + 1];
    if (next !== undefined && next.role !== 'tool') {
      out.push({
        role: next.role,
        text: unit.text + (next.text === '' ? '' : NL) + next.text,
        coveredSeqs: [...unit.coveredSeqs, ...next.coveredSeqs],
        ...(next.toolCalls === undefined ? {} : { toolCalls: [...next.toolCalls] }),
      });
      i += 1;
      continue;
    }
    // Lone tool unit: an assistant message carrying the tool line keeps the
    // surface protocol-valid.
    unit.role = 'assistant';
    out.push(unit);
  }
  return out;
}

/**
 * The step to stamp on one replacement unit's event data: the step of the
 * last covered original node that carries one, else the step of the last
 * node of the whole span that carries one, else undefined. The canonical
 * assistant/message shape carries data.turn + data.step, and the web
 * trajectory groups cells by them — a checkpoint node without them renders
 * as its own "Turn undefined / Step undefined" section instead of inside
 * the summarized turn.
 */
export function unitLandingStep(coveredSeqs: readonly number[], spanSeqs: readonly number[], stepOf: (seq: number) => number | undefined): number | undefined {
  for (let i = coveredSeqs.length - 1; i >= 0; i -= 1) {
    const step = stepOf(coveredSeqs[i]);
    if (step !== undefined) return step;
  }
  for (let i = spanSeqs.length - 1; i >= 0; i -= 1) {
    const step = stepOf(spanSeqs[i]);
    if (step !== undefined) return step;
  }
  return undefined;
}
