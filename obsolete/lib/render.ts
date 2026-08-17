/**
 * Pure rendering of one completed turn's span into the JSONL draft the
 * turn-summary fork edits. One JSON object per ORIGINAL surface node —
 * {"seq":N,"kind":"user|assistant|tool|context","content":"..."} — so the
 * draft's editing unit equals the surface node, and each kept node maps
 * 1:1 to a same-role replacement event when the checkpoint lands (N -> M
 * with M <= N: the fork compresses tool/context lines to one short line or
 * empties them to drop the node; user/assistant text stays byte for byte).
 * Extracted from the plugin entry so rendering is unit-testable.
 *
 * Style matches the entry file: plain string concatenation, no template
 * literals, so sources stay embeddable without quoting hazards.
 */

/** Structural view of one log event (the parts the renderer reads). */
export interface RenderEventLike {
  type?: string;
  data?: {
    content?: readonly {
      type?: string;
      text?: string;
      name?: string;
      content?: readonly { type?: string; text?: string }[];
    }[];
    source?: { kind?: string; plugin?: string };
    name?: string;
    message?: {
      content?: readonly {
        type?: string;
        text?: string;
        name?: string;
        content?: readonly { type?: string; text?: string }[];
      }[];
      name?: string;
    };
  };
}

export interface RenderOptions {
  /** Cap for one tool result's text; longer results are truncated with a marker. */
  maxToolResultChars?: number;
}

/** One draft line: the role of one original surface node plus its editable content. */
export interface DraftNode {
  /** The original node's seq — the draft line id. */
  seq: number;
  /** user = real user input (verbatim), assistant = assistant text (verbatim), tool = tool result (compressible), context = injected context (droppable). */
  kind: 'user' | 'assistant' | 'tool' | 'context';
  content: string;
}

const NL = String.fromCharCode(10);

/** Join the text blocks of one content array, descending one level into tool-result wrappers. */
function collectText(blocks: readonly { type?: string; text?: string; content?: readonly { type?: string; text?: string }[] }[] | undefined): string {
  let out = '';
  for (const block of blocks ?? []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
    else if (block.type === 'tool-result') out += collectText(block.content);
  }
  return out;
}

/** Render ONE original surface node into its draft line; undefined when the node type carries nothing. */
export function renderSpanNode(event: RenderEventLike | undefined, options?: RenderOptions): DraftNode | undefined {
  if (event === undefined) return undefined;
  const cap = options?.maxToolResultChars ?? 12000;
  const type = event.type ?? '';
  if (type === 'user/message') {
    const parts: string[] = [];
    for (const part of event.data?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.type === 'string') parts.push('[' + part.type + ']');
    }
    const text = parts.join('');
    const source = event.data?.source;
    if (source?.kind === 'user') return { seq: 0, kind: 'user', content: text };
    const marker = typeof source?.plugin === 'string' && source.plugin !== '' ? source.plugin : (typeof source?.kind === 'string' && source.kind !== '' ? source.kind : 'context');
    return { seq: 0, kind: 'context', content: '[injected: ' + marker + ']' + NL + text };
  }
  if (type === 'assistant/message') {
    // Text only — tool-call blocks are process, and their outcome lives in
    // the tool/result node that follows, so the verbatim assistant line
    // carries just the user-facing text.
    const parts: string[] = [];
    for (const part of event.data?.message?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
    return { seq: 0, kind: 'assistant', content: parts.join(NL) };
  }
  if (type === 'tool/result') {
    const text = collectText(event.data?.message?.content);
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    const shown = text.length > cap ? text.slice(0, cap) + ' ... [truncated, ' + text.length + ' chars total]' : text;
    return { seq: 0, kind: 'tool', content: '[tool/result' + (name === '' ? '' : ': ' + name) + ']' + NL + shown };
  }
  return undefined;
}

/** Render the whole span (surface-order seqs) as one JSONL draft — one line per original node, the node's seq as its id. */
export function renderSpanDraft(
  events: readonly (RenderEventLike | undefined)[],
  seqs: readonly number[],
  options?: RenderOptions,
): string {
  let out = '';
  for (const seq of seqs) {
    const node = renderSpanNode(events[seq], options);
    if (node === undefined) continue;
    node.seq = seq;
    out += JSON.stringify(node) + NL;
  }
  return out;
}
