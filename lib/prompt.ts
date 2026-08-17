import { readFileSync } from 'node:fs';

import type { TurnNodeEditor } from './editor.ts';

export const DRAFT_SENTINEL = '__DRAFT_PASS__';
export const E2E_USER_SENTINEL = 'E2E-USER-GAMMA-194';
export const E2E_TOOL_SENTINEL = 'E2E-FIXTURE-ALPHA-771';
export const E2E_FINAL_SENTINEL = 'PARENT-FINAL-BETA-332';

type TemplateValue = string | number | boolean;

const promptTemplateUrl = new URL('../prompts/turn-compression.md', import.meta.url);
const conditionalPattern = /{{#if\s+([A-Za-z_][A-Za-z0-9_]*)}}\n?([\s\S]*?){{\/if}}(\n|$)/g;
const valuePattern = /{{([A-Za-z_][A-Za-z0-9_]*)}}/g;

/** Render the deliberately small prompt-template language: scalar values and non-nested #if blocks. */
export function renderPromptTemplate(template: string, values: Readonly<Record<string, TemplateValue>>): string {
  const renderedConditionals = template.replace(conditionalPattern, (_match, name: string, body: string, suffix: string) => {
    if (!Object.hasOwn(values, name)) throw new Error('unknown prompt-template condition ' + JSON.stringify(name));
    return values[name] ? body + suffix : '';
  });
  const renderedValues = renderedConditionals.replace(valuePattern, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error('unknown prompt-template value ' + JSON.stringify(name));
    return String(values[name]);
  });
  const unresolved = renderedValues.match(/{{[^\n]*}}/);
  if (unresolved !== null) throw new Error('unsupported or unresolved prompt-template expression ' + JSON.stringify(unresolved[0]));
  return renderedValues.trim();
}

/** Render the complete model-facing contract for one turn-compression fork. */
export function buildCompressionPrompt(
  editor: TurnNodeEditor,
  previewChars: number,
  e2eSmoke: boolean,
): string {
  const template = readFileSync(promptTemplateUrl, 'utf8');
  return renderPromptTemplate(template, {
    initialNodeCatalog: editor.richCatalog(previewChars),
    e2eSmoke,
    originalCount: editor.originalCount,
    e2eUserSentinel: E2E_USER_SENTINEL,
    e2eToolSentinel: E2E_TOOL_SENTINEL,
    e2eFinalSentinel: E2E_FINAL_SENTINEL,
    draftSentinel: DRAFT_SENTINEL,
  });
}
