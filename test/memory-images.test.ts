import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { contentText } from '../lib/content.ts';
import {
  assertMemoryImagesRetained,
  collectMemoryImageReferenceIds,
  createReadMemoryImageTool,
  materializeMemoryImages,
  memoryImageAlias,
  memoryImageReferenceIds,
  memoryImageRefMatches,
  renderMemoryImageReference,
} from '../lib/memory-images.ts';

const image = {
  attachmentId: 'sha256:abc123',
  mediaType: 'image/jpeg' as const,
  bytes: 10847,
  width: 240,
  height: 320,
  name: 'camera & "room".jpg',
};

describe('lazy memory images', () => {
  test('projects image blocks into canonical lazy markers beside text', () => {
    const marker = renderMemoryImageReference(image);
    // The marker carries a short host-assigned handle, never the 64-character digest.
    assert.equal(marker, '<memory-image ref="img-abc123" media-type="image/jpeg" width="240" height="320" bytes="10847" name="camera &amp; &quot;room&quot;.jpg" />');
    assert.equal(memoryImageAlias('sha256:abc123'), 'img-abc123');
    assert.equal(contentText([
      { type: 'image', attachment: image },
      { type: 'text', text: 'describe this image' },
    ]), marker + '\ndescribe this image');
    assert.deepEqual([...memoryImageReferenceIds(marker)], ['img-abc123']);
  });

  test('finds nested image blocks and treats every image as host-retained', () => {
    const source = [{
      type: 'tool-result',
      content: [{ type: 'image', attachment: image }],
    }];
    assert.deepEqual([...collectMemoryImageReferenceIds(source)], ['sha256:abc123']);
    assert.doesNotThrow(() => assertMemoryImagesRetained(source, renderMemoryImageReference(image), 'fixture'));
    // Canonical ids, short handles, and unambiguous digest prefixes all address the image.
    assert.doesNotThrow(() => assertMemoryImagesRetained(source, '<memory-image ref="sha256:abc123" />', 'fixture'));
    assert.doesNotThrow(() => assertMemoryImagesRetained(source, '<memory-image ref="img-abc123" />', 'fixture'));
    assert.doesNotThrow(() => assertMemoryImagesRetained(source, '<memory-image ref="abc123" />', 'fixture'));
    // A rewrite that drops the marker is repaired by the host, never rejected.
    assert.equal(materializeMemoryImages('text only', [image]), 'text only\n\n' + renderMemoryImageReference(image));
    assert.equal(materializeMemoryImages(renderMemoryImageReference(image), [image]), renderMemoryImageReference(image));
    assert.throws(() => assertMemoryImagesRetained(source, 'text only', 'fixture'), /omitted lazy image reference/);
    // A marker-shaped string that carries no attachment is not an image of the turn.
    assert.doesNotThrow(() => assertMemoryImagesRetained([{ type: 'user/message', data: { content: [{ type: 'text', text: '<memory-image ref="..." />' }] } }], 'text only', 'fixture'));
  });

  test('matches canonical ids, short handles, and unique digest prefixes', () => {
    assert.equal(memoryImageRefMatches('sha256:abc123', 'sha256:abc123'), true);
    assert.equal(memoryImageRefMatches('img-abc123', 'sha256:abc123'), true);
    assert.equal(memoryImageRefMatches('abc123', 'sha256:abc123'), true);
    assert.equal(memoryImageRefMatches('abc', 'sha256:abc123'), false, 'prefixes shorter than six characters stay ambiguous');
    assert.equal(memoryImageRefMatches('img-ffffffffffffff', 'sha256:abc123'), false);
  });

  test('loads only a ref present in the active root session and renders an image block', async () => {
    const rootSession = {
      id: 'root-session',
      header: {},
      snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; },
      events: [{ type: 'user/message', data: { content: [{ type: 'image', attachment: image }] } }],
      requestHeader: () => ({ config: { provider: 'fixture', model: 'vision' } }),
    };
    const childSession = {
      id: 'child-session',
      header: { parentSession: 'root-session' },
      snapshotEvents(): readonly any[] { return this.events; }, eventAt(seq: number): any { return this.events[seq]; },
      events: [],
      requestHeader: () => ({ config: { provider: 'fixture', model: 'vision' } }),
    };
    let read = 0;
    const ctx = {
      get(name: string) {
        if (name === 'agents') return { get: (id: string) => id === 'root-session' ? { session: rootSession } : undefined };
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
        if (name === 'attachments') return {
          readImage: async (ref: unknown) => {
            read += 1;
            assert.deepEqual(ref, image);
            return { ref: image, data: new Uint8Array([1, 2, 3]) };
          },
        };
        return undefined;
      },
    };
    const tool: any = createReadMemoryImageTool(ctx);
    const exec = { agent: { session: childSession, options: {} }, signal: new AbortController().signal };
    const value = await tool.execute({ ref: image.attachmentId }, exec);
    assert.equal(read, 1);
    const rendered = tool.output.render({ ref: image.attachmentId }, value);
    assert.equal(rendered[1].type, 'image');
    assert.equal(rendered[1].attachment.attachmentId, image.attachmentId);
    // The short handle and a digest prefix resolve to the same attachment.
    await tool.execute({ ref: 'img-abc123' }, exec);
    await tool.execute({ ref: 'abc123' }, exec);
    assert.equal(read, 3);
    await assert.rejects(() => tool.execute({ ref: 'sha256:not-in-session' }, exec), /no single memory image matches ref/);

    const textOnlyTool: any = createReadMemoryImageTool({
      get(name: string) {
        if (name === 'agents') return ctx.get(name);
        if (name === 'attachments') return ctx.get(name);
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) };
        return undefined;
      },
    });
    await assert.rejects(() => textOnlyTool.execute({ ref: image.attachmentId }, exec), /does not declare image input/);
    assert.equal(read, 3, 'text-only route must fail before reading attachment bytes');
  });
});
