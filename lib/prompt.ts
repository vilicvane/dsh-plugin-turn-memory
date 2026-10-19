import { readFileSync } from 'node:fs';

import type { TurnNodeEditor } from './editor.ts';
import type { ThoughtHint } from './thought-hints.ts';

export const DRAFT_SENTINEL = '__DRAFT_PASS__';
export const E2E_USER_SENTINEL = 'E2E-USER-GAMMA-194';
export const E2E_TOOL_SENTINEL = 'E2E-FIXTURE-ALPHA-771';
export const E2E_FINAL_SENTINEL = 'PARENT-FINAL-BETA-332';

type TemplateValue = string | number | boolean;

export interface CompressionPromptOptions {
  previewChars: number;
  e2eSmoke: boolean;
  workerNumber: number;
  acceptedMutations: number;
  workerMode: 'fork' | 'fresh-spawn';
  thoughtHints?: readonly ThoughtHint[];
}

const promptTemplateUrl = new URL('../prompts/turn-compression.md', import.meta.url);
const conditionalPattern = /{{#if\s+([A-Za-z_][A-Za-z0-9_]*)}}\n?([\s\S]*?){{\/if}}(\n|$)/g;
const valuePattern = /{{([A-Za-z_][A-Za-z0-9_]*)}}/g;

function renderThoughtHints(editor: TurnNodeEditor, hints: readonly ThoughtHint[]): string {
  const current = editor.snapshot();
  const entries = hints.map((hint) => ({
    currentNodeIds: current.filter((node) => node.sourceSeqs.includes(hint.assistantSeq)).map((node) => node.id),
    reasoningBlock: hint.blockIndex,
    originalChars: hint.chars,
    hints: hint.text,
  }));
  return JSON.stringify(entries, null, 2).replaceAll('<', '\\u003c');
}

/** Render the deliberately small prompt-template language: scalar values and non-nested #if blocks. */
export function renderPromptTemplate(template: string, values: Readonly<Record<string, TemplateValue>>): string {
  const renderedConditionals = template.replace(conditionalPattern, (_match, name: string, body: string, suffix: string) => {
    if (!Object.hasOwn(values, name)) throw new Error('unknown prompt-template condition ' + JSON.stringify(name));
    return values[name] ? body + suffix : '';
  });
  // Substitute values through single-use placeholders so model- or tool-authored
  // text is inserted as literal content. Transcripts legitimately contain
  // `{{...}}` (for example source-code excerpts) and must not be re-read as
  // template syntax.
  const tokens: string[] = [];
  const staged = renderedConditionals.replace(valuePattern, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error('unknown prompt-template value ' + JSON.stringify(name));
    tokens.push(String(values[name]));
    return '\u0001' + tokens.length + '\u0001';
  });
  const unresolved = staged.match(/{{[^\n]*}}/);
  if (unresolved !== null) throw new Error('unsupported or unresolved prompt-template expression ' + JSON.stringify(unresolved[0]));
  return staged.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => tokens[Number(index) - 1]).trim();
}

/** Render the complete model-facing contract for one turn-compression fork. */
export function buildCompressionPrompt(
  editor: TurnNodeEditor,
  options: CompressionPromptOptions,
): string {
  const template = readFileSync(promptTemplateUrl, 'utf8');
  const thoughtHints = options.thoughtHints ?? [];
  return renderPromptTemplate(template, {
    currentNodeCatalog: editor.richCatalog(options.previewChars),
    e2eSmoke: options.e2eSmoke,
    initialWorker: options.workerNumber === 1,
    resumedWorker: options.workerNumber > 1,
    forkWorker: options.workerMode === 'fork',
    freshWorker: options.workerMode === 'fresh-spawn',
    workerNumber: options.workerNumber,
    acceptedMutations: options.acceptedMutations,
    originalCount: editor.originalCount,
    hasThoughtHints: thoughtHints.length > 0,
    thoughtHints: renderThoughtHints(editor, thoughtHints),
    e2eUserSentinel: E2E_USER_SENTINEL,
    e2eToolSentinel: E2E_TOOL_SENTINEL,
    e2eFinalSentinel: E2E_FINAL_SENTINEL,
    draftSentinel: DRAFT_SENTINEL,
  });
}
