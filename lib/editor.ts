export type TurnNodeKind = 'user' | 'assistant' | 'tool';

export interface TurnNodeSeed {
  kind: TurnNodeKind;
  content: string;
  sourceSeq: number;
}

export interface TurnNodeSnapshot {
  id: string;
  kind: TurnNodeKind;
  content: string;
  sourceSeqs: number[];
  originalIndexes: number[];
  changed: boolean;
}

export interface NodeRange {
  start: string;
  end?: string;
}

export interface ReplaceResult {
  created: TurnNodeSnapshot;
  catalog: string;
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

function preview(value: string, limit: number): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + '…';
}

function cloneNode(node: TurnNodeSnapshot): TurnNodeSnapshot {
  return {
    ...node,
    sourceSeqs: [...node.sourceSeqs],
    originalIndexes: [...node.originalIndexes],
  };
}

/** Mutable, isolated working surface used by one summary fork. */
export class TurnNodeEditor {
  readonly originalCount: number;
  private nodes: TurnNodeSnapshot[];
  private nextReplacement = 1;

  constructor(seeds: readonly TurnNodeSeed[]) {
    if (seeds.length === 0) throw new Error('turn node editor requires at least one seed node');
    this.originalCount = seeds.length;
    this.nodes = seeds.map((seed, index) => ({
      id: 'n' + (index + 1),
      kind: seed.kind,
      content: seed.content,
      sourceSeqs: [seed.sourceSeq],
      originalIndexes: [index + 1],
      changed: false,
    }));
  }

  snapshot(): TurnNodeSnapshot[] {
    return this.nodes.map(cloneNode);
  }

  richCatalog(previewChars = 120): string {
    return this.nodes.map((node) => [
      node.id,
      node.kind,
      node.content.length + ' chars',
      'covers=' + this.coverage(node),
      node.changed ? 'changed' : 'unchanged',
      'preview=' + JSON.stringify(preview(node.content, previewChars)),
    ].join(' | ')).join('\n');
  }

  structuralCatalog(): string {
    return this.nodes.map((node, index) => [
      (index + 1) + '.',
      node.id,
      node.kind,
      'covers=' + this.coverage(node),
      node.changed ? 'changed' : 'unchanged',
    ].join(' ')).join('\n');
  }

  replace(startId: string, endId: string | undefined, kind: TurnNodeKind, content: string): ReplaceResult {
    if (content.trim() === '') throw new Error('replacement content must not be empty');
    const start = this.indexOf(startId);
    const end = this.indexOf(endId ?? startId);
    if (start > end) throw new Error('replacement range is reversed: ' + startId + '..' + (endId ?? startId));
    const removed = this.nodes.slice(start, end + 1);
    const created: TurnNodeSnapshot = {
      id: 'r' + this.nextReplacement++,
      kind,
      content,
      sourceSeqs: removed.flatMap((node) => node.sourceSeqs),
      originalIndexes: removed.flatMap((node) => node.originalIndexes),
      changed: true,
    };
    this.nodes.splice(start, removed.length, created);
    this.assertPartition();
    return { created: cloneNode(created), catalog: this.structuralCatalog() };
  }

  read(ranges: readonly NodeRange[], maxChars: number): string {
    if (ranges.length === 0) throw new Error('at least one node range is required');
    const selected: TurnNodeSnapshot[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
      const start = this.indexOf(range.start);
      const end = this.indexOf(range.end ?? range.start);
      if (start > end) throw new Error('read range is reversed: ' + range.start + '..' + (range.end ?? range.start));
      for (const node of this.nodes.slice(start, end + 1)) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          selected.push(node);
        }
      }
    }
    const rendered = selected.map((node) => [
      '<node id="' + node.id + '" kind="' + node.kind + '" covers="' + this.coverage(node) + '">',
      node.content,
      '</node>',
    ].join('\n')).join('\n\n');
    if (rendered.length > maxChars) {
      throw new Error('requested node content is ' + rendered.length + ' chars, above the ' + maxChars + '-char limit; request a smaller range');
    }
    return rendered;
  }

  validateFinal(): void {
    if (this.nodes.length === 0) throw new Error('final working surface is empty');
    if (this.nodes.length > this.originalCount) throw new Error('final node count exceeds original node count');
    for (const node of this.nodes) {
      if (node.content.trim() === '') throw new Error('final node ' + node.id + ' has empty content');
    }
    this.assertPartition();
  }

  private indexOf(id: string): number {
    const index = this.nodes.findIndex((node) => node.id === id);
    if (index < 0) throw new Error('unknown or stale node id ' + JSON.stringify(id) + '; current ids: ' + this.nodes.map((node) => node.id).join(', '));
    return index;
  }

  private coverage(node: TurnNodeSnapshot): string {
    const first = node.originalIndexes[0];
    const last = node.originalIndexes[node.originalIndexes.length - 1];
    return first === last ? 'n' + first : 'n' + first + '..n' + last;
  }

  private assertPartition(): void {
    const flattened = this.nodes.flatMap((node) => node.originalIndexes);
    if (flattened.length !== this.originalCount) throw new Error('working surface lost or duplicated original coverage');
    for (let index = 0; index < flattened.length; index += 1) {
      if (flattened[index] !== index + 1) throw new Error('working surface coverage is not an ordered contiguous partition');
    }
    for (const node of this.nodes) {
      for (let index = 1; index < node.originalIndexes.length; index += 1) {
        if (node.originalIndexes[index] !== node.originalIndexes[index - 1] + 1) {
          throw new Error('node ' + node.id + ' has non-contiguous original coverage');
        }
      }
    }
  }
}
