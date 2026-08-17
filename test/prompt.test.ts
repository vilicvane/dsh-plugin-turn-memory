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
    const prompt = buildCompressionPrompt(correctedRequestEditor(), 120, false);

    assert.match(prompt, /Original node boundaries are editable structure, not facts that must survive/);
    assert.match(prompt, /insights or inspirations/);
    assert.match(prompt, /trials and detours with their outcomes/);
    assert.match(prompt, /fixes a typo or supplies missing information/);
    assert.match(prompt, /semantic sources must include the later steer/);
    assert.match(prompt, /Adjacent same-role nodes may remain/);
    assert.match(prompt, /inherited context helps understanding but is not provenance/);
    assert.match(prompt, /audit every retained fact for role attribution and `sources=` coverage/);
    assert.match(prompt, /Consolidating user intent does not erase work already performed/);
    assert.match(prompt, /Do not make it narrate or take attribution for assistant actions/);
    assert.match(prompt, /Apply this procedure directly to the inherited turn/);
    assert.match(prompt, /n1 \| user .*home 中用到了哪些设备/);
    assert.match(prompt, /n3 \| user .*playground/);
    assert.doesNotMatch(prompt, /Leave useful nodes unchanged/);
    assert.doesNotMatch(prompt, /E2E smoke protocol/);
  });

  it('keeps deterministic smoke instructions isolated from production behavior', () => {
    const prompt = buildCompressionPrompt(correctedRequestEditor(), 120, true);

    assert.match(prompt, /E2E smoke protocol \(follow exactly\)/);
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
