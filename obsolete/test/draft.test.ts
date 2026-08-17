import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assistantUnitBlocks,
  buildReplacementUnits,
  draftShapeCheck,
  grepDraftLines,
  lineIdList,
  pairToolUnits,
  parseDraftLines,
  readLineContent,
  replaceLineContent,
  unitLandingStep,
} from '../lib/draft.ts';

const line = (seq: number, kind: string, content: string) => JSON.stringify({ seq, kind, content });

const SEED = [
  line(10, 'user', '你好'),
  line(11, 'assistant', '答复'),
  line(12, 'tool', '[tool/result: read]\nfile text'),
  line(13, 'context', '[injected: p]\nsnapshot'),
].join('\n') + '\n';

describe('parseDraftLines', () => {
  it('parses JSON lines in order', () => {
    const parsed = parseDraftLines(SEED);
    assert.ok(!Array.isArray(parsed) || parsed.length === 4);
    if (Array.isArray(parsed)) {
      assert.deepEqual(parsed.map((l) => [l.seq, l.kind]), [[10, 'user'], [11, 'assistant'], [12, 'tool'], [13, 'context']]);
    }
  });

  it('rejects malformed JSON with an error string', () => {
    const parsed = parseDraftLines('not json\n');
    assert.equal(typeof parsed, 'string');
  });

  it('rejects an invalid kind', () => {
    const parsed = parseDraftLines(line(1, 'nope', 'x') + '\n');
    assert.equal(typeof parsed, 'string');
  });

  it('rejects non-ascending seqs', () => {
    const parsed = parseDraftLines(line(2, 'user', 'a') + '\n' + line(1, 'user', 'b') + '\n');
    assert.equal(typeof parsed, 'string');
  });
});

describe('readLineContent / replaceLineContent / lineIdList', () => {
  it('reads the content of one line by its node seq', () => {
    assert.equal(readLineContent(SEED, 12), '[tool/result: read]\nfile text');
    assert.equal(readLineContent(SEED, 99), null);
  });

  it('replaces one line keeping its seq and kind, and lists ids on unknown', () => {
    const next = replaceLineContent(SEED, 12, 'one-line summary');
    assert.ok(next !== null);
    assert.equal(readLineContent(next!, 12), 'one-line summary');
    assert.equal(replaceLineContent(SEED, 99, 'x'), null);
    assert.equal(lineIdList(SEED), '10, 11, 12, 13');
  });
});

describe('grepDraftLines', () => {
  it('returns matching lines with global line numbers', () => {
    const hits = grepDraftLines(SEED, 'file text');
    assert.ok(Array.isArray(hits));
    if (Array.isArray(hits)) {
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 12);
      assert.equal(hits[0].kind, 'tool');
      assert.ok(hits[0].lines[0].text.includes('file text'));
    }
  });

  it('reports invalid patterns as a string', () => {
    assert.equal(typeof grepDraftLines(SEED, '('), 'string');
  });
});

describe('draftShapeCheck', () => {
  it('accepts compressed tool/context lines', () => {
    const final = SEED
      .replace(line(12, 'tool', '[tool/result: read]\nfile text'), line(12, 'tool', 'one-line summary'))
      .replace(line(13, 'context', '[injected: p]\nsnapshot'), line(13, 'context', ''));
    assert.equal(draftShapeCheck(SEED, final), null);
  });

  it('rejects a changed user or assistant line', () => {
    const final = SEED.replace(line(11, 'assistant', '答复'), line(11, 'assistant', '改了'));
    const error = draftShapeCheck(SEED, final);
    assert.ok(error !== null && error.includes('byte for byte'));
  });

  it('rejects a changed seq or kind', () => {
    const final = SEED.replace(line(12, 'tool', '[tool/result: read]\nfile text'), line(12, 'assistant', 'x'));
    const error = draftShapeCheck(SEED, final);
    assert.ok(error !== null && error.includes('changed from'));
  });

  it('rejects a different line count', () => {
    const final = SEED.split('\n').slice(0, 3).join('\n') + '\n';
    const error = draftShapeCheck(SEED, final);
    assert.ok(error !== null && error.includes('lines'));
  });
});

describe('buildReplacementUnits', () => {
  it('groups kept lines by role, merges adjacent user/assistant, and routes drops away from tool units', () => {
    const spanSeqs = [10, 11, 12, 13, 14, 15, 16, 17];
    const lines = [
      { seq: 10, kind: 'user' as const, content: '你好' },
      { seq: 11, kind: 'assistant' as const, content: 'A1' },
      { seq: 12, kind: 'tool' as const, content: '' },
      { seq: 13, kind: 'tool' as const, content: 'T summary' },
      { seq: 14, kind: 'context' as const, content: '' },
      { seq: 15, kind: 'assistant' as const, content: 'A2' },
      { seq: 16, kind: 'tool' as const, content: '' },
      { seq: 17, kind: 'context' as const, content: 'policy note' },
    ];
    const units = buildReplacementUnits(spanSeqs, lines);
    assert.ok(Array.isArray(units));
    if (Array.isArray(units)) {
      assert.deepEqual(units, [
        { role: 'user', text: '你好', coveredSeqs: [10] },
        { role: 'assistant', text: 'A1', coveredSeqs: [11, 12] },
        { role: 'tool', text: 'T summary', coveredSeqs: [13] },
        { role: 'assistant', text: 'A2\npolicy note', coveredSeqs: [14, 15, 16, 17] },
      ]);
    }
  });

  it('keeps a 1:1 tool unit and absorbs a trailing drop into an empty assistant unit', () => {
    const units = buildReplacementUnits([20, 21], [
      { seq: 20, kind: 'tool' as const, content: 'summary' },
      { seq: 21, kind: 'tool' as const, content: '' },
    ]);
    assert.ok(Array.isArray(units));
    if (Array.isArray(units)) {
      assert.deepEqual(units, [
        { role: 'tool', text: 'summary', coveredSeqs: [20] },
        { role: 'assistant', text: '', coveredSeqs: [21] },
      ]);
    }
  });

  it('gives a leading drop before a tool unit its own empty assistant unit', () => {
    const units = buildReplacementUnits([30, 31], [
      { seq: 30, kind: 'context' as const, content: '' },
      { seq: 31, kind: 'tool' as const, content: 's' },
    ]);
    assert.ok(Array.isArray(units));
    if (Array.isArray(units)) {
      assert.deepEqual(units, [
        { role: 'assistant', text: '', coveredSeqs: [30] },
        { role: 'tool', text: 's', coveredSeqs: [31] },
      ]);
    }
  });

  it('yields one empty assistant unit when everything is dropped', () => {
    const units = buildReplacementUnits([1, 2, 3], [
      { seq: 1, kind: 'tool' as const, content: '' },
      { seq: 2, kind: 'context' as const, content: '' },
      { seq: 3, kind: 'assistant' as const, content: '' },
    ]);
    assert.deepEqual(units, [{ role: 'assistant', text: '', coveredSeqs: [1, 2, 3] }]);
  });

  it('reports a missing draft line for a spanned node', () => {
    const units = buildReplacementUnits([1, 2], [{ seq: 1, kind: 'tool' as const, content: 'x' }]);
    assert.equal(typeof units, 'string');
  });
});

describe('assistantUnitBlocks', () => {
  it('emits a text block only when the unit has text', () => {
    assert.deepEqual(assistantUnitBlocks({ role: 'assistant', text: 'hi', coveredSeqs: [1] }), [
      { type: 'text', text: 'hi' },
    ]);
  });

  it('emits tool-call blocks for the pairing calls', () => {
    assert.deepEqual(assistantUnitBlocks({ role: 'assistant', text: '', coveredSeqs: [2], toolCalls: [{ id: 'c1', name: 'run', arguments: '{}' }] }), [
      { type: 'tool-call', id: 'c1', name: 'run', arguments: '{}' },
    ]);
  });

  it('emits an empty array for an assistant unit with neither text nor calls', () => {
    assert.deepEqual(assistantUnitBlocks({ role: 'assistant', text: '', coveredSeqs: [3] }), []);
  });
});

describe('pairToolUnits', () => {
  const callOf = (unit: { role: string; text: string; coveredSeqs: number[] }) =>
    unit.role === 'tool' ? { id: 'call-' + unit.coveredSeqs[0], name: 'run_code', arguments: '{}' } : undefined;

  it('attaches the tool-call block to the assistant unit preceding a tool unit', () => {
    const units = pairToolUnits([
      { role: 'assistant' as const, text: '', coveredSeqs: [30] },
      { role: 'tool' as const, text: 'summary', coveredSeqs: [31] },
    ], callOf);
    assert.deepEqual(units, [
      { role: 'assistant', text: '', coveredSeqs: [30], toolCalls: [{ id: 'call-31', name: 'run_code', arguments: '{}' }] },
      { role: 'tool', text: 'summary', coveredSeqs: [31] },
    ]);
  });

  it('folds a tool unit into a preceding user unit', () => {
    const units = pairToolUnits([
      { role: 'user' as const, text: 'steer', coveredSeqs: [10] },
      { role: 'tool' as const, text: 'summary', coveredSeqs: [11] },
    ], callOf);
    assert.deepEqual(units, [
      { role: 'user', text: 'steer\nsummary', coveredSeqs: [10, 11] },
    ]);
  });

  it('folds a leading tool unit into the next non-tool unit', () => {
    const units = pairToolUnits([
      { role: 'tool' as const, text: 'summary', coveredSeqs: [20] },
      { role: 'assistant' as const, text: 'reply', coveredSeqs: [21] },
    ], callOf);
    assert.deepEqual(units, [
      { role: 'assistant', text: 'summary\nreply', coveredSeqs: [20, 21] },
    ]);
  });

  it('folds a tool unit into the preceding assistant unit when the call is unresolvable', () => {
    const units = pairToolUnits([
      { role: 'assistant' as const, text: 'before', coveredSeqs: [40] },
      { role: 'tool' as const, text: 'summary', coveredSeqs: [41] },
    ], () => undefined);
    assert.deepEqual(units, [
      { role: 'assistant', text: 'before\nsummary', coveredSeqs: [40, 41] },
    ]);
  });

  it('degrades a lone tool unit to an assistant unit', () => {
    const units = pairToolUnits([
      { role: 'tool' as const, text: 'summary', coveredSeqs: [50] },
    ], callOf);
    assert.deepEqual(units, [
      { role: 'assistant', text: 'summary', coveredSeqs: [50] },
    ]);
  });

  it('leaves non-tool units untouched', () => {
    const units = pairToolUnits([
      { role: 'assistant' as const, text: 'a', coveredSeqs: [1] },
      { role: 'user' as const, text: 'u', coveredSeqs: [2] },
    ], callOf);
    assert.deepEqual(units, [
      { role: 'assistant', text: 'a', coveredSeqs: [1] },
      { role: 'user', text: 'u', coveredSeqs: [2] },
    ]);
  });
});

describe('unitLandingStep', () => {
  const stepOf = (steps: Record<number, number>) => (seq: number) => steps[seq];

  it('takes the step of the last covered node that has one', () => {
    const steps = stepOf({ 10: 1, 12: 2, 14: 3 });
    assert.equal(unitLandingStep([10, 11, 12, 13], [10, 11, 12, 13, 14], steps), 2);
  });

  it('falls back to the last stepped node of the whole span', () => {
    const steps = stepOf({ 14: 3 });
    assert.equal(unitLandingStep([10, 11], [10, 11, 12, 13, 14], steps), 3);
  });

  it('returns undefined when nothing in the span has a step', () => {
    const steps = () => undefined;
    assert.equal(unitLandingStep([10, 11], [10, 11, 12], steps), undefined);
  });
});
