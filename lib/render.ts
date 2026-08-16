/**
 * Pure rendering of one completed turn's span into the draft text the
 * turn-summary fork compresses in place. The draft is already in the
 * checkpoint's FINAL tag format — <user-steer> and <assistant> contents
 * verbatim, raw process inside <working> blocks — so source and target share
 * one vocabulary and the fork only shortens <working> contents in place,
 * never restructures. Extracted from the plugin entry so the rendering is
 * unit-testable without booting the plugin.
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

/** The three tag roles of the checkpoint format. */
export type SpanSegmentKind = 'user-steer' | 'assistant' | 'working';

/** One role-tagged piece of the draft. */
export interface SpanSegment {
  kind: SpanSegmentKind;
  text: string;
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

/** Render one span event into its tag-format segments; [] when the type carries nothing. */
export function renderSpanSegments(event: RenderEventLike | undefined, options?: RenderOptions): SpanSegment[] {
  if (event === undefined) return [];
  const cap = options?.maxToolResultChars ?? 12000;
  const type = event.type ?? '';
  if (type === 'user/message') {
    const parts: string[] = [];
    for (const part of event.data?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.type === 'string') parts.push('[' + part.type + ']');
    }
    return [{ kind: 'user-steer', text: parts.join('') }];
  }
  if (type === 'assistant/message') {
    const segments: SpanSegment[] = [];
    for (const part of event.data?.message?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') segments.push({ kind: 'assistant', text: part.text });
      else if (part.type === 'tool-call') segments.push({ kind: 'working', text: '[tool call: ' + (typeof part.name === 'string' ? part.name : 'unknown') + ']' });
      else if (typeof part.type === 'string') segments.push({ kind: 'working', text: '[' + part.type + ']' });
    }
    return segments;
  }
  if (type === 'tool/result') {
    const text = collectText(event.data?.message?.content);
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    const shown = text.length > cap ? text.slice(0, cap) + ' ... [truncated, ' + text.length + ' chars total]' : text;
    return [{ kind: 'working', text: '[tool/result' + (name === '' ? '' : ': ' + name) + ']' + NL + shown }];
  }
  return [];
}

/** Render the whole span (surface-order seqs) as one draft in the checkpoint's tag format, adjacent working pieces coalesced into one <working> block. */
export function renderTurnSpanText(
  events: readonly (RenderEventLike | undefined)[],
  seqs: readonly number[],
  options?: RenderOptions,
): string {
  let out = '';
  let workingOpen = false;
  const closeWorking = () => {
    if (workingOpen) {
      out += NL + '</working>' + NL;
      workingOpen = false;
    }
  };
  for (const seq of seqs) {
    for (const segment of renderSpanSegments(events[seq], options)) {
      if (segment.kind === 'working') {
        out += workingOpen ? NL : '<working>' + NL;
        workingOpen = true;
        out += segment.text;
      } else {
        closeWorking();
        out += '<' + segment.kind + '>' + NL + segment.text + NL + '</' + segment.kind + '>' + NL;
      }
    }
  }
  closeWorking();
  return out;
}
