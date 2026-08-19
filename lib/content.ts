import { collectMemoryImageAttachments, renderMemoryImageReference } from './memory-images.ts';

export interface ReasoningStats {
  blockCount: number;
  totalChars: number;
}

/** Return raw reasoning block texts without mixing them into ordinary transcript text. */
export function reasoningBlockTexts(value: unknown): string[] {
  const blocks: string[] = [];
  const visit = (item: unknown): void => {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (record.type === 'reasoning' && typeof record.text === 'string') {
      blocks.push(record.text);
      return;
    }
    if (Object.hasOwn(record, 'content')) visit(record.content);
  };
  visit(value);
  return blocks;
}

export function reasoningStats(value: unknown): ReasoningStats {
  const blocks = reasoningBlockTexts(value);
  return {
    blockCount: blocks.length,
    totalChars: blocks.reduce((sum, block) => sum + block.length, 0),
  };
}

export function assistantCompressionSeed(value: unknown): { content: string; rewriteRequired?: 'raw-reasoning' } {
  const visible = contentText(value);
  const reasoning = reasoningStats(value);
  return {
    content: visible !== '' || reasoning.blockCount === 0
      ? visible
      : '<raw-reasoning blocks="' + reasoning.blockCount + '" chars="' + reasoning.totalChars + '" />',
    ...(reasoning.blockCount === 0 ? {} : { rewriteRequired: 'raw-reasoning' as const }),
  };
}

/** Flatten the text-bearing parts of one durable message event for catalogs and memory input. */
export function contentText(value: unknown): string {
  const chunks: string[] = [];
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

export function eventContentText(event: any): string {
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') {
    return contentText(event.data?.message?.content);
  }
  return contentText(event?.data?.content);
}

export function eventMemoryKind(event: any): 'user' | 'assistant' | 'tool' | undefined {
  if (event?.type === 'user/message') return 'user';
  if (event?.type === 'assistant/message') return 'assistant';
  if (event?.type === 'tool/result') return 'tool';
  return undefined;
}
