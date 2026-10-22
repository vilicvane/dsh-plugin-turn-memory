import { defineTool } from '@deepseek-ai/dsh-tools';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';

export const READ_MEMORY_IMAGE_TOOL_NAME = 'read_memory_image';

const ATTACHMENT_ID_PREFIX = 'sha256:';
/** Hexadecimal characters kept from the digest to build the short handle. */
const ALIAS_HEX_LENGTH = 10;
/** Shortest prefix accepted when a caller passes bare digest characters. */
const MIN_PREFIX_LENGTH = 6;

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

/**
 * Short host-assigned handle for one durable image attachment.
 *
 * The canonical attachment id is a 64-character sha256 digest, so asking a model to
 * reproduce it verbatim is error-prone: one mistyped character makes the image look
 * missing forever. The handle is derived from that digest, which keeps it stable,
 * collision-safe enough for a session, and recoverable without any mutable registry.
 */
export function memoryImageAlias(attachmentId: string): string {
  const hex = attachmentId.startsWith(ATTACHMENT_ID_PREFIX)
    ? attachmentId.slice(ATTACHMENT_ID_PREFIX.length)
    : attachmentId;
  return 'img-' + hex.toLowerCase().slice(0, ALIAS_HEX_LENGTH);
}

/** Render one eager image block as a stable, model-readable lazy memory handle. */
export function renderMemoryImageReference(ref: MemoryImageAttachmentRef): string {
  const attributes = [
    'ref="' + xmlAttribute(memoryImageAlias(ref.attachmentId)) + '"',
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

/** Digest characters of one canonical attachment id, or the id itself when unprefixed. */
export function memoryImageDigest(attachmentId: string): string {
  return (attachmentId.startsWith(ATTACHMENT_ID_PREFIX)
    ? attachmentId.slice(ATTACHMENT_ID_PREFIX.length)
    : attachmentId).toLowerCase();
}

/**
 * Whether one marker `ref` addresses the given attachment.
 *
 * Accepts the short handle, the canonical id, and any unambiguous digest prefix, so a
 * caller never has to reproduce 64 characters and older checkpoints keep resolving.
 */
export function memoryImageRefMatches(ref: string, attachmentId: string): boolean {
  const normalized = ref.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized === attachmentId.toLowerCase()) return true;
  if (normalized === memoryImageAlias(attachmentId)) return true;
  const candidate = normalized.startsWith('img-')
    ? normalized.slice('img-'.length)
    : normalized.startsWith(ATTACHMENT_ID_PREFIX)
      ? normalized.slice(ATTACHMENT_ID_PREFIX.length)
      : normalized;
  return candidate.length >= MIN_PREFIX_LENGTH && memoryImageDigest(attachmentId).startsWith(candidate);
}

function textAddressesAttachment(text: string, attachmentId: string): boolean {
  for (const ref of memoryImageReferenceIds(text)) {
    if (memoryImageRefMatches(ref, attachmentId)) return true;
  }
  return false;
}

/**
 * Make every attachment of a source turn addressable in the given text.
 *
 * The host, not the model, owns image identity: a rewrite that drops or mangles a marker
 * still keeps the image readable, and no checkpoint can be lost to a mistyped digest.
 */
export function materializeMemoryImages(
  text: string,
  attachments: readonly MemoryImageAttachmentRef[],
): string {
  const missing = attachments.filter((attachment) => !textAddressesAttachment(text, attachment.attachmentId));
  if (missing.length === 0) return text;
  const markers = [...new Map(missing.map((attachment) => [attachment.attachmentId, attachment])).values()]
    .map((attachment) => renderMemoryImageReference(attachment));
  const body = text.trim();
  return body === '' ? markers.join('\n') : body + '\n\n' + markers.join('\n');
}

/** Attachments carried by the given event data values, in first-seen order. */
export function collectMemoryImageAttachmentsOf(values: readonly unknown[]): MemoryImageAttachmentRef[] {
  const byId = new Map<string, MemoryImageAttachmentRef>();
  for (const value of values) {
    for (const attachment of collectMemoryImageAttachments(value)) {
      if (!byId.has(attachment.attachmentId)) byId.set(attachment.attachmentId, attachment);
    }
  }
  return [...byId.values()];
}

export function assertMemoryImagesRetained(source: unknown, outputText: string, stage: string): void {
  const missing = collectMemoryImageAttachments(source)
    .filter((attachment) => !textAddressesAttachment(outputText, attachment.attachmentId));
  if (missing.length > 0) {
    throw new Error(stage + ' omitted lazy image reference(s): '
      + missing.map((attachment) => renderMemoryImageReference(attachment)).join(', '));
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

/** Every image attachment readable from the current session and its active parents. */
function readableAttachments(ctx: any, exec: any): MemoryImageAttachmentRef[] {
  const values: unknown[] = [];
  for (const session of candidateSessions(ctx, exec)) {
    for (const event of session.snapshotEvents() as readonly any[]) values.push(event?.data);
  }
  return collectMemoryImageAttachmentsOf(values);
}

/**
 * Resolve one caller-supplied handle against the readable attachments.
 *
 * Exact canonical ids win; otherwise the short handle or a digest prefix resolves when it
 * is unambiguous, which is what keeps a mistyped or abbreviated ref recoverable.
 */
function referencedAttachment(
  attachments: readonly MemoryImageAttachmentRef[],
  ref: string,
): MemoryImageAttachmentRef | undefined {
  const exact = attachments.find((candidate) => candidate.attachmentId.toLowerCase() === ref.toLowerCase());
  if (exact !== undefined) return exact;
  const matches = attachments.filter((candidate) => memoryImageRefMatches(ref, candidate.attachmentId));
  return matches.length === 1 ? matches[0] : undefined;
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
    description: 'Load the pixels for one image retained in compressed conversation memory. Use it when the textual memory is insufficient and visual inspection is necessary.',
    parameters: {
      ref: {
        type: 'string',
        required: true,
        description: 'The short ref attribute of a <memory-image /> marker, for example img-1a2b3c4d5e.',
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
      const attachments = readableAttachments(ctx, exec);
      const attachment = referencedAttachment(attachments, ref);
      if (attachment === undefined) {
        const handles = attachments.map((candidate) => memoryImageAlias(candidate.attachmentId)
          + (candidate.name === undefined ? '' : ' (' + candidate.name + ')'));
        throw new Error('no single memory image matches ref ' + JSON.stringify(ref)
          + '; available handles: ' + (handles.length === 0 ? '(none)' : handles.join(', ')));
      }
      const store = ctx.get('attachments');
      if (store === undefined) throw new Error('cannot read memory image: no attachment service is mounted');
      await assertImageCapableRoute(ctx, exec, ref);
      const stored = await store.readImage(attachment, exec.signal);
      return { image: stored.ref };
    },
  });
}
