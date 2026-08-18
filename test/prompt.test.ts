import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TurnNodeEditor } from '../lib/editor.ts';
import {
  DRAFT_SENTINEL,
  E2E_FINAL_SENTINEL,
  E2E_TOOL_SENTINEL,
  E2E_USER_SENTINEL,
  buildCompressionPrompt,
  renderPromptTemplate,
} from '../lib/prompt.ts';

const correctedRequestEditor = () => new TurnNodeEditor([
  { kind: 'user', content: 'home 中用到了哪些设备？', sourceSeq: 10 },
  { kind: 'assistant', content: '尝试 /repo 失败，尚未得到结果。', sourceSeq: 11 },
  { kind: 'user', content: 'playground', sourceSeq: 12 },
  { kind: 'assistant', content: '改查 playground 后得到 6 类、9 个设备。', sourceSeq: 13 },
]);

describe('buildCompressionPrompt', () => {
  it('renders one coherent production contract for corrected requests and valuable detours', () => {
    const prompt = buildCompressionPrompt(correctedRequestEditor(), {
      previewChars: 120,
      e2eSmoke: false,
      workerNumber: 1,
      acceptedMutations: 0,
    });

    assert.match(prompt, /inspirations and discoveries/);
    assert.match(prompt, /trials and detours with what they proved or ruled out/);
    assert.match(prompt, /later steer fixes a typo or reveals the intended route/);
    assert.match(prompt, /Select every current node whose information the outputs use/);
    assert.match(prompt, /Adjacent same-role semantic nodes are allowed/);
    assert.match(prompt, /Inherited context supplies understanding, not provenance/);
    assert.match(prompt, /Audit the complete current surface/);
    assert.match(prompt, /Preserve actual off-route assistant work compactly/);
    assert.match(prompt, /Never attribute assistant actions, tool outcomes/);
    assert.match(prompt, /`n\*` is an unchanged original node/);
    assert.match(prompt, /`r\*` is an accepted replacement/);
    assert.match(prompt, /<memory-image ref="\.\.\."/);
    assert.match(prompt, /read_memory_image/);
    assert.match(prompt, /Runtime-context snapshots, `<turn-memory-continuation>` reminders/);
    assert.match(prompt, /not human requests/);
    assert.match(prompt, /intentional continuation should leave a compact assistant account/);
    assert.match(prompt, /No earlier worker has stopped/);
    assert.doesNotMatch(prompt, /An earlier worker stopped before authoritative completion/);
    assert.match(prompt, /n1 \| user .*home 中用到了哪些设备/);
    assert.match(prompt, /n3 \| user .*playground/);
    assert.doesNotMatch(prompt, /E2E smoke protocol/);
  });

  it('renders a resumed worker against accepted r* progress instead of the original layout', () => {
    const editor = correctedRequestEditor();
    editor.replace('n1', 'n2', [{ kind: 'user', content: '查询 playground 中使用的设备；此前误查 home。' }]);
    const prompt = buildCompressionPrompt(editor, {
      previewChars: 120,
      e2eSmoke: false,
      workerNumber: 2,
      acceptedMutations: 1,
    });

    assert.match(prompt, /worker 2/);
    assert.match(prompt, /An earlier worker stopped before authoritative completion/);
    assert.match(prompt, /contains all 1 accepted replacement\(s\)/);
    assert.match(prompt, /do not rebuild from the inherited original layout/);
    assert.match(prompt, /r1 \| user .*changed/);
    assert.doesNotMatch(prompt, /No earlier worker has stopped/);
  });

  it('keeps deterministic smoke instructions isolated from production behavior', () => {
    const prompt = buildCompressionPrompt(correctedRequestEditor(), {
      previewChars: 120,
      e2eSmoke: true,
      workerNumber: 1,
      acceptedMutations: 0,
    });

    assert.match(prompt, /E2E smoke protocol \(follow exactly\)/);
    assert.match(prompt, /earlier accepted replacement already created that draft pair/);
    for (const sentinel of [E2E_USER_SENTINEL, E2E_TOOL_SENTINEL, E2E_FINAL_SENTINEL, DRAFT_SENTINEL]) {
      assert.ok(prompt.includes(sentinel));
    }
  });

  it('renders scalar values and strict non-nested conditionals', () => {
    const template = 'before {{value}}\n{{#if enabled}}inside {{value}}{{/if}}\nafter';
    assert.equal(renderPromptTemplate(template, { value: 'X', enabled: true }), 'before X\ninside X\nafter');
    assert.equal(renderPromptTemplate(template, { value: 'X', enabled: false }), 'before X\nafter');
    assert.throws(() => renderPromptTemplate('{{missing}}', {}), /unknown prompt-template value/);
    assert.throws(() => renderPromptTemplate('{{#if missing}}x{{\/if}}', {}), /unknown prompt-template condition/);
    assert.throws(() => renderPromptTemplate('{{#if enabled}}x', { enabled: true }), /unsupported or unresolved/);
  });
});
