import { defineTool } from '@deepseek-ai/dsh-tools';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';

export const READ_MEMORY_IMAGE_TOOL_NAME = 'read_memory_image';

export interface MemoryImageAttachmentRef {
  attachmentId: string;
  mediaType: ImageMediaType;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

const xmlAttribute = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

function imageAttachmentRef(value: unknown): MemoryImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.attachmentId !== 'string' || record.attachmentId === '') return undefined;
  if (record.mediaType !== 'image/png' && record.mediaType !== 'image/jpeg'
    && record.mediaType !== 'image/webp' && record.mediaType !== 'image/gif') return undefined;
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) return undefined;
  if (!Number.isSafeInteger(record.width) || (record.width as number) <= 0) return undefined;
  if (!Number.isSafeInteger(record.height) || (record.height as number) <= 0) return undefined;
  return {
    attachmentId: record.attachmentId,
    mediaType: record.mediaType,
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...(typeof record.name === 'string' && record.name !== '' ? { name: record.name } : {}),
  };
}

/** Render one eager image block as a stable, model-readable lazy memory handle. */
export function renderMemoryImageReference(ref: MemoryImageAttachmentRef): string {
  const attributes = [
    'ref="' + xmlAttribute(ref.attachmentId) + '"',
    'media-type="' + xmlAttribute(ref.mediaType) + '"',
    'width="' + ref.width + '"',
    'height="' + ref.height + '"',
    'bytes="' + ref.bytes + '"',
    ...(ref.name === undefined ? [] : ['name="' + xmlAttribute(ref.name) + '"']),
  ];
  return '<memory-image ' + attributes.join(' ') + ' />';
}

/** Collect every canonical image attachment nested in message or tool-result content. */
export function collectMemoryImageAttachments(value: unknown): MemoryImageAttachmentRef[] {
  const refs = new Map<string, MemoryImageAttachmentRef>();
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || item === undefined || typeof item !== 'object') return;
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'image') {
      const ref = imageAttachmentRef(record.attachment);
      if (ref !== undefined) refs.set(ref.attachmentId, ref);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...refs.values()];
}

/** Read the reference identities retained in canonical marker text. */
export function memoryImageReferenceIds(text: string): Set<string> {
  const ids = new Set<string>();
  const pattern = /<memory-image\b[^>]*\bref="([^"]+)"[^>]*\/>/g;
  for (const match of text.matchAll(pattern)) ids.add(match[1]);
  return ids;
}

export function collectMemoryImageReferenceIds(value: unknown): Set<string> {
  const ids = new Set(collectMemoryImageAttachments(value).map((ref) => ref.attachmentId));
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const id of memoryImageReferenceIds(item)) ids.add(id);
      return;
    }
    if (item === null || item === undefined || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    for (const child of Object.values(item as Record<string, unknown>)) visit(child);
  };
  visit(value);
  return ids;
}

export function assertMemoryImagesRetained(source: unknown, outputText: string, stage: string): void {
  const retained = memoryImageReferenceIds(outputText);
  const missing = [...collectMemoryImageReferenceIds(source)].filter((ref) => !retained.has(ref));
  if (missing.length > 0) {
    throw new Error(stage + ' omitted lazy image reference(s): ' + missing.join(', '));
  }
}

function candidateSessions(ctx: any, exec: any): any[] {
  const sessions: any[] = [];
  const seen = new Set<string>();
  let session = exec.agent?.session;
  while (session !== undefined) {
    const id = String(session.id);
    if (seen.has(id)) break;
    seen.add(id);
    sessions.push(session);
    const parentId = session.header?.parentSession;
    if (parentId === undefined) break;
    session = ctx.get('agents')?.get(String(parentId))?.session;
  }
  return sessions;
}

function referencedAttachment(ctx: any, exec: any, ref: string): MemoryImageAttachmentRef | undefined {
  for (const session of candidateSessions(ctx, exec)) {
    for (const event of session.events as readonly any[]) {
      const found = collectMemoryImageAttachments(event?.data).find((candidate) => candidate.attachmentId === ref);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function assertImageCapableRoute(ctx: any, exec: any, ref: string): Promise<void> {
  const routed = exec.agent?.session.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec.agent?.options?.provider;
  const model = routed?.model ?? exec.agent?.options?.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot read memory image ' + JSON.stringify(ref) + ': the current model route could not be resolved');
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal);
  if (!Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
    throw new Error('cannot read memory image ' + JSON.stringify(ref) + ': model ' + JSON.stringify(model)
      + ' does not declare image input');
  }
}

/** Public lazy-memory tool shared by the main agent and both compression worker scopes. */
export function createReadMemoryImageTool(ctx: any): any {
  return defineTool({
    name: READ_MEMORY_IMAGE_TOOL_NAME,
    description: 'Load the pixels for one <memory-image ref="..." /> retained in compressed conversation memory. Use only when the textual memory is insufficient and visual inspection is necessary.',
    parameters: {
      ref: {
        type: 'string',
        required: true,
        description: 'Exact ref attribute copied from a <memory-image /> marker in conversation memory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args: unknown, value: { image: MemoryImageAttachmentRef }) => [{
        type: 'text',
        text: 'Loaded memory image ' + value.image.attachmentId + ' (' + value.image.mediaType + ', '
          + value.image.width + 'x' + value.image.height + ' px, ' + value.image.bytes + ' bytes).',
      }, {
        type: 'image',
        attachment: {
          ...value.image,
          attachmentId: AttachmentId(value.image.attachmentId),
        },
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { ref: string }, exec: any) {
      const ref = args.ref.trim();
      if (ref === '') throw new Error('memory image ref must be a non-empty string');
      const attachment = referencedAttachment(ctx, exec, ref);
      if (attachment === undefined) {
        throw new Error('memory image ref is not present in this session or its active root parent: ' + JSON.stringify(ref));
      }
      const attachments = ctx.get('attachments');
      if (attachments === undefined) throw new Error('cannot read memory image: no attachment service is mounted');
      await assertImageCapableRoute(ctx, exec, ref);
      const stored = await attachments.readImage(attachment, exec.signal);
      return { image: stored.ref };
    },
  });
}
