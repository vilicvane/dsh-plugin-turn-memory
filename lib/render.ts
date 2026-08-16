/**
 * Pure rendering of one completed turn's span into the draft text that the
 * turn-summary fork compresses in place: a sequence of marker lines and the
 * message text the fork must preserve or compress. Extracted from the plugin
 * entry so the rendering is unit-testable without booting the plugin.
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

/** Render one span event into its draft block, or '' when the type carries nothing. */
export function renderSpanEvent(event: RenderEventLike | undefined, options?: RenderOptions): string {
  if (event === undefined) return '';
  const cap = options?.maxToolResultChars ?? 12000;
  const type = event.type ?? '';
  if (type === 'user/message') {
    const parts: string[] = [];
    for (const part of event.data?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.type === 'string') parts.push('[' + part.type + ']');
    }
    return '### User' + NL + parts.join('') + NL;
  }
  if (type === 'assistant/message') {
    const lines: string[] = ['### Assistant'];
    for (const part of event.data?.message?.content ?? []) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text);
      else if (part.type === 'tool-call') lines.push('[tool call: ' + (typeof part.name === 'string' ? part.name : 'unknown') + ']');
    }
    return lines.join(NL) + NL;
  }
  if (type === 'tool/result') {
    const text = collectText(event.data?.message?.content);
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    const shown = text.length > cap ? text.slice(0, cap) + ' ... [truncated, ' + text.length + ' chars total]' : text;
    return '### Tool result' + (name === '' ? '' : ': ' + name) + NL + shown + NL;
  }
  return '';
}

/** Render the whole span (surface-order seqs) as one draft text. */
export function renderTurnSpanText(
  events: readonly (RenderEventLike | undefined)[],
  seqs: readonly number[],
  options?: RenderOptions,
): string {
  const parts: string[] = [];
  for (const seq of seqs) {
    const block = renderSpanEvent(events[seq], options);
    if (block !== '') parts.push(block);
  }
  return parts.join(NL);
}
