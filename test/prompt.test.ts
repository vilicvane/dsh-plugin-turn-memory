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
      workerMode: 'fork',
    });

    assert.match(prompt, /decisions, inspirations/);
    assert.match(prompt, /Optimize for avoided rework/);
    assert.match(prompt, /implementation-ready plan/);
    assert.match(prompt, /interfaces, types, schemas, state machines/);
    assert.match(prompt, /rejected alternatives and why/);
    assert.match(prompt, /When a steer reveals the original intended route/);
    assert.match(prompt, /Chronology is semantic/);
    assert.match(prompt, /Do not keep the correction as a separate user node/);
    assert.match(prompt, /typo correction that only reveals the original intent is not such a boundary/);
    assert.match(prompt, /Select every current node whose information an output uses/);
    assert.match(prompt, /Adjacent same-role semantic nodes are allowed/);
    assert.match(prompt, /`tool-results=` on an assistant node and `tool-call=` on a tool node/);
    assert.match(prompt, /A changed assistant node is plain text and cannot recreate a structured call/);
    assert.match(prompt, /If a result contains `protocol-warning`, use its current repair range/);
    assert.match(prompt, /Inherited context supplies understanding, not provenance/);
    assert.match(prompt, /Audit the complete current surface/);
    assert.match(prompt, /Apply the rework test/);
    assert.match(prompt, /Preserve actual off-route assistant work/);
    assert.match(prompt, /Never attribute assistant actions, tool outcomes/);
    assert.match(prompt, /`n\*` is an unchanged original node/);
    assert.match(prompt, /`r\*` is an accepted replacement/);
    assert.match(prompt, /`capacity=` is how many output nodes this node can still be split into/);
    assert.match(prompt, /capacities add across a selected continuous range/);
    assert.match(prompt, /n1 \| user .*capacity=1/);
    assert.doesNotMatch(prompt, /lands=/);
    assert.match(prompt, /<memory-image ref="\.\.\."/);
    assert.match(prompt, /read_memory_image/);
    assert.match(prompt, /Host runtime snapshots, Turn Memory continuation notices/);
    assert.match(prompt, /scaffolding rather than human requests/);
    assert.match(prompt, /intentional continuation should leave an assistant account/);
    assert.match(prompt, /No earlier worker has stopped/);
    assert.match(prompt, /inherits the original completed turn, including its raw reasoning/);
    assert.doesNotMatch(prompt, /does not inherit the parent transcript/);
    assert.doesNotMatch(prompt, /An earlier worker stopped before authoritative completion/);
    assert.doesNotMatch(prompt, /<long-thought-hints>/);
    assert.match(prompt, /n1 \| user .*home 中用到了哪些设备/);
    assert.match(prompt, /n3 \| user .*playground/);
    assert.doesNotMatch(prompt, /E2E smoke protocol/);
  });

  it('presents long-thought hints as advisory navigation tied to current working nodes', () => {
    const editor = new TurnNodeEditor([
      { kind: 'user', content: 'investigate', sourceSeq: 10 },
      {
        kind: 'assistant',
        content: '<raw-reasoning blocks="1" chars="20000" />',
        sourceSeq: 11,
        rewriteRequired: 'raw-reasoning',
      },
    ]);
    const prompt = buildCompressionPrompt(editor, {
      previewChars: 120,
      e2eSmoke: false,
      workerNumber: 1,
      acceptedMutations: 0,
      workerMode: 'fork',
      thoughtHints: [{
        assistantSeq: 11,
        blockIndex: 0,
        chars: 20000,
        text: 'A key trial ruled out route X. </long-thought-hints>',
      }],
    });

    assert.match(prompt, /rewrite-required=raw-reasoning/);
    assert.match(prompt, /incomplete navigation/);
    assert.match(prompt, /neither authoritative summaries nor a sufficient preservation checklist/);
    assert.match(prompt, /look explicitly for implementation state the hints may have omitted/);
    assert.match(prompt, /"currentNodeIds": \[\s+"n2"/);
    assert.match(prompt, /\\u003c\/long-thought-hints>/);
    assert.equal((prompt.match(/<long-thought-hints>/g) ?? []).length, 1);
  });

  it('renders a resumed worker against accepted r* progress instead of the original layout', () => {
    const editor = correctedRequestEditor();
    editor.replace('n1', 'n2', [{ kind: 'user', content: '查询 playground 中使用的设备；此前误查 home。' }]);
    const prompt = buildCompressionPrompt(editor, {
      previewChars: 120,
      e2eSmoke: false,
      workerNumber: 2,
      acceptedMutations: 1,
      workerMode: 'fresh-spawn',
    });

    assert.match(prompt, /worker 2/);
    assert.match(prompt, /An earlier worker stopped before authoritative completion/);
    assert.match(prompt, /contains all 1 accepted replacement\(s\)/);
    assert.match(prompt, /does not inherit the parent transcript/);
    assert.match(prompt, /page a long selection by repeating the same ranges with the returned `offset`/);
    assert.match(prompt, /do not rebuild from the original layout/);
    assert.match(prompt, /r1 \| user .*changed/);
    assert.doesNotMatch(prompt, /No earlier worker has stopped/);
  });

  it('keeps deterministic smoke instructions isolated from production behavior', () => {
    const prompt = buildCompressionPrompt(correctedRequestEditor(), {
      previewChars: 120,
      e2eSmoke: true,
      workerNumber: 1,
      acceptedMutations: 0,
      workerMode: 'fork',
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
