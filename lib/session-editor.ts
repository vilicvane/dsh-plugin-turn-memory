export type SessionMemoryKind = 'user' | 'assistant';

export interface SessionMemoryOutput {
  kind: SessionMemoryKind;
  content: string;
}

export interface SessionMemoryNode {
  id: string;
  kind: SessionMemoryKind | 'pending';
  content: string;
  sourceSegments: number[];
}

export interface SessionMemoryRange {
  start: string;
  end?: string;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

function preview(value: string, limit: number): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + '…';
}

function clone(node: SessionMemoryNode): SessionMemoryNode {
  return { ...node, sourceSegments: [...node.sourceSegments] };
}

function renderSources(sources: readonly number[]): string {
  const ranges: string[] = [];
  let start = sources[0];
  let end = start;
  const flush = (): void => { ranges.push(start === end ? 's' + start : 's' + start + '..s' + end); };
  for (const source of sources.slice(1)) {
    if (source === end + 1) {
      end = source;
      continue;
    }
    flush();
    start = source;
    end = source;
  }
  flush();
  return ranges.join(',');
}

/** Host-owned, revisioned draft of one final session checkpoint. */
export class SessionMemoryEditor {
  readonly segmentCount: number;
  private nodes: SessionMemoryNode[];
  private processed = new Set<number>();
  private nextMemoryId = 1;
  private currentRevision = 0;

  constructor(segmentCount: number) {
    if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
      throw new Error('session memory editor requires a positive segment count');
    }
    this.segmentCount = segmentCount;
    this.nodes = Array.from({ length: segmentCount }, (_, index) => ({
      id: 'p' + (index + 1),
      kind: 'pending' as const,
      content: '',
      sourceSegments: [index + 1],
    }));
  }

  get revision(): number {
    return this.currentRevision;
  }

  snapshot(): SessionMemoryNode[] {
    return this.nodes.map(clone);
  }

  status(segment: number): 'pending' | 'editing' | 'done' {
    this.assertSegment(segment);
    if (this.processed.has(segment)) return 'done';
    return this.nodes.some((node) => node.kind === 'pending' && node.sourceSegments.includes(segment)) ? 'pending' : 'editing';
  }

  catalog(cursor = 0, limit = 80, previewChars = 120): string {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('memory catalog cursor must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) throw new Error('memory catalog limit must be between 1 and 200');
    const page = this.nodes.slice(cursor, cursor + limit);
    const lines = page.map((node, offset) => [
      (cursor + offset + 1) + '.',
      node.id,
      node.kind,
      'sources=' + renderSources(node.sourceSegments),
      node.kind === 'pending' ? 'placeholder' : node.content.length + ' chars',
      node.kind === 'pending' ? '' : 'preview=' + JSON.stringify(preview(node.content, previewChars)),
    ].filter(Boolean).join(' '));
    const next = cursor + page.length < this.nodes.length ? cursor + page.length : null;
    return 'revision=' + this.revision + ' total=' + this.nodes.length + ' cursor=' + cursor + ' next=' + String(next)
      + (lines.length === 0 ? '' : '\n' + lines.join('\n'));
  }

  tail(maxChars: number, previewChars = 120): string {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error('memory tail maxChars must be positive');
    const selected: SessionMemoryNode[] = [];
    let chars = 0;
    for (let index = this.nodes.length - 1; index >= 0; index -= 1) {
      const node = this.nodes[index];
      if (node.kind === 'pending') continue;
      if (selected.length > 0 && chars + node.content.length > maxChars) break;
      selected.unshift(node);
      chars += node.content.length;
    }
    if (selected.length === 0) return this.catalog(0, Math.min(this.nodes.length, 20), previewChars);
    return 'revision=' + this.revision + '\n' + selected.map((node) => [
      '<memory-node id="' + node.id + '" kind="' + node.kind + '" sources="' + renderSources(node.sourceSegments) + '">',
      node.content,
      '</memory-node>',
    ].join('\n')).join('\n\n');
  }

  read(ranges: readonly SessionMemoryRange[], maxChars: number): string {
    if (ranges.length === 0) throw new Error('at least one memory range is required');
    const selected: SessionMemoryNode[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
      const start = this.indexOf(range.start);
      const end = this.indexOf(range.end ?? range.start);
      if (start > end) throw new Error('memory read range is reversed: ' + range.start + '..' + (range.end ?? range.start));
      for (const node of this.nodes.slice(start, end + 1)) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          selected.push(node);
        }
      }
    }
    const rendered = selected.map((node) => node.kind === 'pending'
      ? '<pending id="' + node.id + '" segment="' + renderSources(node.sourceSegments) + '" />'
      : [
        '<memory-node id="' + node.id + '" kind="' + node.kind + '" sources="' + renderSources(node.sourceSegments) + '">',
        node.content,
        '</memory-node>',
      ].join('\n')).join('\n\n');
    if (rendered.length > maxChars) {
      throw new Error('requested memory content is ' + rendered.length + ' chars, above the ' + maxChars + '-char limit');
    }
    return 'revision=' + this.revision + '\n' + rendered;
  }

  search(query: string, limit: number, previewChars = 240): string {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') throw new Error('memory search query must not be empty');
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 50) throw new Error('memory search limit must be between 1 and 50');
    const matches = this.nodes.filter((node) => node.kind !== 'pending' && node.content.toLocaleLowerCase().includes(needle)).slice(0, limit);
    return 'revision=' + this.revision + ' matches=' + matches.length + '\n' + matches.map((node) => [
      node.id,
      node.kind,
      'sources=' + renderSources(node.sourceSegments),
      'preview=' + JSON.stringify(preview(node.content, previewChars)),
    ].join(' | ')).join('\n');
  }

  replace(
    activeSegment: number,
    expectedRevision: number,
    startId: string,
    endId: string | undefined,
    outputs: readonly SessionMemoryOutput[],
  ): { revision: number; created: SessionMemoryNode[]; neighborhood: string } {
    this.assertSegment(activeSegment);
    this.assertRevision(expectedRevision);
    if (outputs.length === 0) throw new Error('session memory replacement requires at least one output node');
    for (const [index, output] of outputs.entries()) {
      if (output.kind !== 'user' && output.kind !== 'assistant') throw new Error('memory output ' + (index + 1) + ' has invalid kind');
      if (output.content.trim() === '') throw new Error('memory output ' + (index + 1) + ' must not be empty');
    }
    const start = this.indexOf(startId);
    const end = this.indexOf(endId ?? startId);
    if (start > end) throw new Error('memory replacement range is reversed: ' + startId + '..' + (endId ?? startId));
    const removed = this.nodes.slice(start, end + 1);
    const sources = [...new Set(removed.flatMap((node) => node.sourceSegments))].sort((left, right) => left - right);
    if (!sources.includes(activeSegment)) {
      throw new Error('replacement must include the assigned segment s' + activeSegment + ' placeholder or generated coverage');
    }
    const future = sources.find((source) => source > activeSegment);
    if (future !== undefined) throw new Error('replacement cannot consume future segment s' + future);
    const created = outputs.map((output): SessionMemoryNode => ({
      id: 'm' + this.nextMemoryId++,
      kind: output.kind,
      content: output.content.trim(),
      sourceSegments: [...sources],
    }));
    this.nodes.splice(start, removed.length, ...created);
    this.currentRevision += 1;
    this.assertCoverage();
    return {
      revision: this.currentRevision,
      created: created.map(clone),
      neighborhood: this.neighborhood(created.map((node) => node.id), 2, 160),
    };
  }

  finishSegment(segment: number, expectedRevision: number): number {
    this.validateSegmentFinish(segment, expectedRevision);
    this.processed.add(segment);
    this.currentRevision += 1;
    return this.currentRevision;
  }

  validateSegmentFinish(segment: number, expectedRevision: number): void {
    this.assertSegment(segment);
    this.assertRevision(expectedRevision);
    for (let prior = 1; prior < segment; prior += 1) {
      if (!this.processed.has(prior)) throw new Error('cannot finish s' + segment + ' before s' + prior);
    }
    if (this.processed.has(segment)) throw new Error('segment s' + segment + ' is already finished');
    if (this.nodes.some((node) => node.kind === 'pending' && node.sourceSegments.includes(segment))) {
      throw new Error('segment s' + segment + ' still has an unresolved placeholder');
    }
    if (!this.nodes.some((node) => node.kind !== 'pending' && node.sourceSegments.includes(segment))) {
      throw new Error('segment s' + segment + ' has no generated memory coverage');
    }
  }

  validateFinal(): void {
    if (this.nodes.length === 0) throw new Error('final session memory is empty');
    if (this.nodes.some((node) => node.kind === 'pending')) throw new Error('final session memory still contains pending segments');
    for (let segment = 1; segment <= this.segmentCount; segment += 1) {
      if (!this.processed.has(segment)) throw new Error('segment s' + segment + ' was not authoritatively finished');
      if (!this.nodes.some((node) => node.sourceSegments.includes(segment))) throw new Error('final memory omitted segment s' + segment);
    }
    this.assertCoverage();
  }

  renderCheckpoint(): string {
    this.validateFinal();
    return [
      '# Session memory checkpoint',
      '',
      'This is a compressed chronological transcript of earlier conversation. Preserve its user/assistant roles, uncertainty, trials, decisions, and causal ordering when continuing the session.',
      '',
      '<conversation-memory version="1">',
      ...this.nodes.flatMap((node) => [
        '<message role="' + node.kind + '">',
        node.content,
        '</message>',
        '',
      ]),
      '</conversation-memory>',
    ].join('\n').trim();
  }

  private neighborhood(ids: readonly string[], radius: number, previewChars: number): string {
    const indexes = ids.map((id) => this.indexOf(id));
    const start = Math.max(0, Math.min(...indexes) - radius);
    const end = Math.min(this.nodes.length, Math.max(...indexes) + radius + 1);
    return this.nodes.slice(start, end).map((node, offset) => [
      (start + offset + 1) + '.',
      node.id,
      node.kind,
      'sources=' + renderSources(node.sourceSegments),
      node.kind === 'pending' ? 'placeholder' : 'preview=' + JSON.stringify(preview(node.content, previewChars)),
    ].join(' ')).join('\n');
  }

  private indexOf(id: string): number {
    const index = this.nodes.findIndex((node) => node.id === id);
    if (index < 0) throw new Error('unknown or stale memory node id ' + JSON.stringify(id));
    return index;
  }

  private assertSegment(segment: number): void {
    if (!Number.isSafeInteger(segment) || segment < 1 || segment > this.segmentCount) {
      throw new Error('invalid session segment s' + segment);
    }
  }

  private assertRevision(expected: number): void {
    if (!Number.isSafeInteger(expected) || expected !== this.currentRevision) {
      throw new Error('stale session memory revision ' + String(expected) + '; current revision is ' + this.currentRevision);
    }
  }

  private assertCoverage(): void {
    for (let segment = 1; segment <= this.segmentCount; segment += 1) {
      if (!this.nodes.some((node) => node.sourceSegments.includes(segment))) {
        throw new Error('working session memory lost segment s' + segment + ' coverage');
      }
    }
    for (const node of this.nodes) {
      if (node.sourceSegments.length === 0) throw new Error('memory node ' + node.id + ' has no segment provenance');
      for (const source of node.sourceSegments) this.assertSegment(source);
    }
  }
}
