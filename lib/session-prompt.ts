import { readFileSync } from 'node:fs';

import { renderPromptTemplate } from './prompt.ts';
import type { SessionMemoryEditor } from './session-editor.ts';
import type { SessionSegment } from './session-segments.ts';
import { renderSegmentCatalog, renderSegmentNodeDirectory, renderSegmentSource } from './session-segments.ts';

const promptTemplateUrl = new URL('../prompts/session-compaction.md', import.meta.url);

export function buildSessionCompactionPrompt(options: {
  editor: SessionMemoryEditor;
  segments: readonly SessionSegment[];
  assigned: SessionSegment;
  session: any;
  workerMode: 'fork' | 'fresh-spawn';
  warmupChars: number;
  previewChars?: number;
}): string {
  const template = readFileSync(promptTemplateUrl, 'utf8');
  const source = renderSegmentSource(options.session, options.assigned);
  const directory = renderSegmentNodeDirectory(options.session, options.assigned, options.previewChars ?? 120);
  return renderPromptTemplate(template, {
    assignedSegmentId: options.assigned.id,
    assignedSegmentIndex: options.assigned.index,
    segmentCount: options.segments.length,
    workerMode: options.workerMode,
    freshWorker: options.workerMode === 'fresh-spawn',
    segmentCatalog: renderSegmentCatalog(options.segments, (segment) => options.editor.status(segment)),
    assignedSegmentDirectory: directory,
    workingHandoff: options.editor.tail(options.warmupChars),
    assignedSegmentSource: source,
  });
}
