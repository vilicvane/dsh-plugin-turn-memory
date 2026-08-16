import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  draftShapeCheck,
  grepSegments,
  MAX_WORKING_CHARS,
  parseDraftSegments,
  readSegmentContent,
  replaceSegmentContent,
  segmentIdList,
} from '../lib/draft.ts';

const DRAFT = '<user-steer:1>\n你好\n</user-steer:1>\n<working:2>\n[tool call: edit]\n[tool/result: edit]\nok\n</working:2>\n<assistant:3>\n答复\n</assistant:3>\n';

describe('parseDraftSegments', () => {
  it('parses numbered segments in order with their inner content', () => {
    const segments = parseDraftSegments(DRAFT);
    assert.deepEqual(segments.map((segment) => [segment.id, segment.kind]), [
      [1, 'user-steer'],
      [2, 'working'],
      [3, 'assistant'],
    ]);
    assert.equal(segments[0].content, '\n你好\n');
    assert.equal(segments[1].content, '\n[tool call: edit]\n[tool/result: edit]\nok\n');
  });

  it('returns no segments for unrelated text', () => {
    assert.deepEqual(parseDraftSegments('no tags here'), []);
  });

  it('does not truncate content at an inline closing-tag example (greedy + line anchors)', () => {
    const draft = '<working:2>\n写成 </working:2> 即可\n</working:2>\n';
    const segments = parseDraftSegments(draft);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].content, '\n写成 </working:2> 即可\n');
  });

  it('ignores inline tag examples inside content as segments (line anchors)', () => {
    const draft = '<assistant:1>\n格式是 <working:9>摘要</working:9>，闭标签 </working:9> 也行\n</assistant:1>\n';
    const segments = parseDraftSegments(draft);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].id, 1);
    assert.equal(segments[0].kind, 'assistant');
    assert.ok(segments[0].content.includes('<working:9>摘要</working:9>'));
  });

  it('ignores indented tag lines inside content (strict line anchors)', () => {
    const draft = '<working:2>\n   <user-steer:9>x</user-steer:9>\n</working:2>\n';
    const segments = parseDraftSegments(draft);
    assert.equal(segments.length, 1);
    assert.ok(segments[0].content.includes('   <user-steer:9>'));
  });
});

describe('replaceSegmentContent', () => {
  it('replaces only the target segment and keeps tags and ids', () => {
    const next = replaceSegmentContent(DRAFT, 2, '\n一句话摘要\n');
    assert.ok(next !== null);
    assert.equal(next, '<user-steer:1>\n你好\n</user-steer:1>\n<working:2>\n一句话摘要\n</working:2>\n<assistant:3>\n答复\n</assistant:3>\n');
  });

  it('returns null for an unknown id', () => {
    assert.equal(replaceSegmentContent(DRAFT, 9, 'x'), null);
  });

  it('pads bare content so tags stay on their own lines and the segment re-parses', () => {
    const next = replaceSegmentContent(DRAFT, 2, '实现…全过。');
    assert.ok(next !== null);
    assert.equal(next, '<user-steer:1>\n你好\n</user-steer:1>\n<working:2>\n实现…全过。\n</working:2>\n<assistant:3>\n答复\n</assistant:3>\n');
    const segments = parseDraftSegments(next ?? '');
    assert.deepEqual(segments.map((segment) => [segment.id, segment.kind]), [
      [1, 'user-steer'],
      [2, 'working'],
      [3, 'assistant'],
    ]);
  });

  it('trims surrounding whitespace the fork may have added', () => {
    const next = replaceSegmentContent(DRAFT, 2, '\n  一句话摘要  \n');
    assert.ok(next !== null);
    assert.ok((next ?? '').includes('<working:2>\n一句话摘要\n</working:2>'));
  });
});

describe('readSegmentContent', () => {
  it('returns the inner content of a known segment', () => {
    assert.equal(readSegmentContent(DRAFT, 1), '\n你好\n');
  });

  it('returns null for an unknown id', () => {
    assert.equal(readSegmentContent(DRAFT, 9), null);
  });
});

describe('segmentIdList', () => {
  it('lists the draft segment ids', () => {
    assert.equal(segmentIdList(DRAFT), '1, 2, 3');
  });

  it('says none for an empty draft', () => {
    assert.equal(segmentIdList(''), 'none');
  });
});

describe('grepSegments', () => {
  it('returns the segment and matching lines with global line numbers', () => {
    const hits = grepSegments(DRAFT, '答复');
    assert.ok(Array.isArray(hits));
    const list = hits as { id: number; kind: string; lines: { lineNumber: number; text: string }[] }[];
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 3);
    assert.equal(list[0].kind, 'assistant');
    assert.equal(list[0].lines[0].lineNumber, 10);
    assert.equal(list[0].lines[0].text, '答复');
  });

  it('reports no matches', () => {
    const hits = grepSegments(DRAFT, '不存在');
    assert.ok(Array.isArray(hits));
    assert.equal((hits as unknown[]).length, 0);
  });

  it('rejects an invalid pattern with an error string', () => {
    assert.equal(typeof grepSegments(DRAFT, '('), 'string');
  });
});

describe('draftShapeCheck', () => {
  it('accepts a draft whose working content was compressed', () => {
    const final = replaceSegmentContent(DRAFT, 2, '\n一句话摘要\n');
    assert.equal(draftShapeCheck(DRAFT, final ?? ''), null);
  });

  it('rejects a draft with a different segment count', () => {
    const error = draftShapeCheck(DRAFT, '<user-steer:1>\n你好\n</user-steer:1>\n');
    assert.ok(error !== null && error.includes('segments'));
  });

  it('rejects a draft with a changed id or kind', () => {
    const error = draftShapeCheck(DRAFT, DRAFT.replace('<working:2>', '<assistant:2>').replace('</working:2>', '</assistant:2>'));
    assert.ok(error !== null && error.includes('changed from'));
  });

  it('rejects a draft whose verbatim segment content changed', () => {
    const error = draftShapeCheck(DRAFT, DRAFT.replace('\n你好\n</user-steer:1>', '\n改了\n</user-steer:1>'));
    assert.ok(error !== null && error.includes('byte for byte'));
  });

  it('rejects a working segment that still holds raw transcript', () => {
    const raw = 'x'.repeat(MAX_WORKING_CHARS + 1);
    const final = replaceSegmentContent(DRAFT, 2, '\n' + raw + '\n');
    const error = draftShapeCheck(DRAFT, final ?? '');
    assert.ok(error !== null && error.includes('still') && error.includes('working:2'));
  });

  it('accepts a working segment right at the cap', () => {
    const final = replaceSegmentContent(DRAFT, 2, '\n' + 'y'.repeat(MAX_WORKING_CHARS - 2) + '\n');
    assert.equal(draftShapeCheck(DRAFT, final ?? ''), null);
  });
});
