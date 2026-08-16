/**
 * Pure draft-file operations for the turn-summary fork's segment tools. The
 * draft is a sequence of numbered segments — <user-steer:N>, <assistant:N>,
 * <working:N> — each with a unique ascending id, so the fork can target one
 * segment by id without reproducing its old content and without re-reading
 * the file. Extracted from the plugin entry so the parsing and shape checks
 * are unit-testable without booting the plugin.
 *
 * Style matches the entry file: plain string concatenation, no template
 * literals, so sources stay embeddable without quoting hazards.
 */

/** The three tag roles of the checkpoint format. */
export type DraftSegmentKind = 'user-steer' | 'assistant' | 'working';

/** One numbered segment of a draft. */
export interface DraftSegment {
  id: number;
  kind: DraftSegmentKind;
  /** Inner text between the tags, without the tags. */
  content: string;
}

const NL = String.fromCharCode(10);

/** A compressed <working> block is one flowing line; anything this long still holds raw transcript and fails the shape guard. */
export const MAX_WORKING_CHARS = 2000;

/** Strict segment pairing: the opening and closing tags each occupy their OWN line exactly (^…$ per line), the kind is one of the three fixed names, the closing repeats the opening's kind and id by backreference, and the body matches greedily — inline tag examples inside content never parse as segments. */
const DRAFT_SEGMENT_PATTERN = /^<(user-steer|assistant|working):(\d+)>([\s\S]*)^<\/\1:\2>$/gm;

/** Parse every numbered segment of a draft, in order. */
export function parseDraftSegments(text: string): DraftSegment[] {
  const segments: DraftSegment[] = [];
  for (const match of text.matchAll(DRAFT_SEGMENT_PATTERN)) {
    segments.push({
      id: Number(match[2]),
      kind: match[1] as DraftSegmentKind,
      content: match[3],
    });
  }
  return segments;
}

/** Error text listing the draft's segment ids, for unknown-id messages. */
export function segmentIdList(text: string): string {
  const ids = parseDraftSegments(text).map((segment) => String(segment.id));
  return ids.length === 0 ? 'none' : ids.join(', ');
}

/** Replace the inner content of the segment with the given id; the tag and id stay. The content may be passed bare (no tags, no surrounding newlines) — the tool pads the tag lines itself so the line-anchored parser always keeps the tags on their own lines. */
export function replaceSegmentContent(text: string, id: number, content: string): string | null {
  for (const match of text.matchAll(DRAFT_SEGMENT_PATTERN)) {
    if (Number(match[2]) !== id) continue;
    const opening = '<' + match[1] + ':' + match[2] + '>';
    const closing = '</' + match[1] + ':' + match[2] + '>';
    const inner = content.replace(/^\s+/, '').replace(/\s+$/, '');
    const start = match.index;
    const end = start + match[0].length;
    return text.slice(0, start) + opening + NL + inner + NL + closing + text.slice(end);
  }
  return null;
}

/** Inner content of the segment with the given id, or null when unknown. */
export function readSegmentContent(text: string, id: number): string | null {
  for (const match of text.matchAll(DRAFT_SEGMENT_PATTERN)) {
    if (Number(match[2]) === id) return match[3];
  }
  return null;
}

/** One grep hit: the segment it lives in plus matching lines with global line numbers. */
export interface DraftGrepHit {
  id: number;
  kind: DraftSegmentKind;
  lines: { lineNumber: number; text: string }[];
}

/** Search every segment for a JS regular expression; return hits with global line numbers. */
export function grepSegments(text: string, pattern: string): DraftGrepHit[] | string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return 'draft_grep: invalid pattern: ' + String(error instanceof Error ? error.message : error);
  }
  const hits: DraftGrepHit[] = [];
  for (const match of text.matchAll(DRAFT_SEGMENT_PATTERN)) {
    const kind = match[1] as DraftSegmentKind;
    const id = Number(match[2]);
    const content = match[3];
    if (!regex.test(content)) continue;
    regex.lastIndex = 0;
    const contentStart = match.index + match[0].indexOf(match[3]);
    const startLine = (text.slice(0, contentStart).match(/\n/g)?.length ?? 0) + 1;
    const hitLines: { lineNumber: number; text: string }[] = [];
    const contentLines = content.split(NL);
    for (let i = 0; i < contentLines.length; i += 1) {
      const lineText = contentLines[i];
      if (regex.test(lineText)) {
        regex.lastIndex = 0;
        hitLines.push({ lineNumber: startLine + i, text: lineText });
      }
    }
    if (hitLines.length > 0) hits.push({ id, kind, lines: hitLines });
  }
  return hits;
}

/**
 * Shape guard between the seeded draft and the fork's final draft: same
 * segment sequence (id and kind per position) and byte-identical
 * <user-steer>/<assistant> contents. Returns null when the final draft is
 * acceptable, otherwise an error naming the first divergence.
 */
export function draftShapeCheck(seedText: string, finalText: string): string | null {
  const seeded = parseDraftSegments(seedText);
  const finalSegments = parseDraftSegments(finalText);
  if (finalSegments.length !== seeded.length) {
    return 'the draft has ' + finalSegments.length + ' segments but the seeded transcript had ' + seeded.length;
  }
  for (let i = 0; i < seeded.length; i += 1) {
    const before = seeded[i];
    const after = finalSegments[i];
    if (after.id !== before.id || after.kind !== before.kind) {
      return 'segment ' + i + ' changed from <' + before.kind + ':' + before.id + '> to <' + after.kind + ':' + after.id + '>';
    }
    if (before.kind !== 'working' && after.content !== before.content) {
      return 'the <' + before.kind + ':' + before.id + '> segment changed — verbatim segments must stay byte for byte';
    }
    if (after.kind === 'working' && after.content.length > MAX_WORKING_CHARS) {
      return 'the <working:' + after.id + '> segment is still ' + after.content.length + ' chars of raw transcript — compress it to one flowing line';
    }
  }
  return null;
}
