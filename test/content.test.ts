import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assistantCompressionSeed,
  contentText,
  reasoningBlockTexts,
  reasoningStats,
} from '../lib/content.ts';

describe('reasoning content boundaries', () => {
  it('keeps reasoning out of ordinary transcript text while exposing raw blocks separately', () => {
    const content = [
      { type: 'reasoning', text: 'private exploration' },
      { type: 'text', text: 'visible conclusion' },
      { type: 'reasoning', text: 'second thought' },
    ];
    assert.equal(contentText(content), 'visible conclusion');
    assert.deepEqual(reasoningBlockTexts(content), ['private exploration', 'second thought']);
    assert.deepEqual(reasoningStats(content), { blockCount: 2, totalChars: 33 });
  });

  it('turns reasoning-only assistant output into a rewrite-required editor seed', () => {
    assert.deepEqual(assistantCompressionSeed([
      { type: 'reasoning', text: 'long but model-visible only as reasoning' },
    ]), {
      content: '<raw-reasoning blocks="1" chars="40" />',
      rewriteRequired: 'raw-reasoning',
    });
    assert.deepEqual(assistantCompressionSeed([
      { type: 'reasoning', text: 'analysis' },
      { type: 'text', text: 'answer' },
    ]), {
      content: 'answer',
      rewriteRequired: 'raw-reasoning',
    });
    assert.deepEqual(assistantCompressionSeed([{ type: 'text', text: 'answer' }]), { content: 'answer' });
  });
});
