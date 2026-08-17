export type TurnNodeKind = 'user' | 'assistant' | 'tool';

export interface TurnNodeSeed {
  kind: TurnNodeKind;
  content: string;
  sourceSeq: number;
}

export interface TurnNodeOutput {
  kind: TurnNodeKind;
  content: string;
}

export interface TurnNodeSnapshot {
  id: string;
  kind: TurnNodeKind;
  content: string;
  /** Durable events that semantically contribute to this node. */
  sourceSeqs: number[];
  sourceIndexes: number[];
  /** Disjoint positional slice used only to land this node on the surface. */
  landingSeqs: number[];
  landingIndexes: number[];
  changed: boolean;
}

export interface NodeRange {
  start: string;
  end?: string;
}

export interface ReplaceResult {
  created: TurnNodeSnapshot[];
  sourceIndexes: number[];
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
    sourceIndexes: [...node.sourceIndexes],
    landingSeqs: [...node.landingSeqs],
    landingIndexes: [...node.landingIndexes],
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function renderIndexes(indexes: readonly number[]): string {
  const ranges: string[] = [];
  let start = indexes[0];
  let end = start;
  const flush = () => ranges.push(start === end ? 'n' + start : 'n' + start + '..n' + end);
  for (const index of indexes.slice(1)) {
    if (index === end + 1) {
      end = index;
      continue;
    }
    flush();
    start = index;
    end = index;
  }
  flush();
  return ranges.join(',');
}

function partition<T>(values: readonly T[], count: number): T[][] {
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * values.length / count);
    const end = Math.floor((index + 1) * values.length / count);
    return values.slice(start, end);
  });
}

/** Mutable, isolated working surface used by one compression fork. */
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
      sourceIndexes: [index + 1],
      landingSeqs: [seed.sourceSeq],
      landingIndexes: [index + 1],
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
      'lands=' + renderIndexes(node.landingIndexes),
      'sources=' + renderIndexes(node.sourceIndexes),
      node.changed ? 'changed' : 'unchanged',
      'preview=' + JSON.stringify(preview(node.content, previewChars)),
    ].join(' | ')).join('\n');
  }

  structuralCatalog(): string {
    return this.nodes.map((node, index) => [
      (index + 1) + '.',
      node.id,
      node.kind,
      'lands=' + renderIndexes(node.landingIndexes),
      'sources=' + renderIndexes(node.sourceIndexes),
      node.changed ? 'changed' : 'unchanged',
    ].join(' ')).join('\n');
  }

  replace(startId: string, endId: string | undefined, outputs: readonly TurnNodeOutput[]): ReplaceResult {
    if (outputs.length === 0) throw new Error('replacement requires at least one output node');
    for (const [index, output] of outputs.entries()) {
      if (output.content.trim() === '') throw new Error('replacement output ' + (index + 1) + ' must not be empty');
    }
    const start = this.indexOf(startId);
    const end = this.indexOf(endId ?? startId);
    if (start > end) throw new Error('replacement range is reversed: ' + startId + '..' + (endId ?? startId));
    const removed = this.nodes.slice(start, end + 1);
    const landing = removed.flatMap((node) => node.landingIndexes.map((originalIndex, index) => ({
      originalIndex,
      seq: node.landingSeqs[index],
    })));
    if (outputs.some((output) => output.kind === 'tool')
      && (outputs.length !== 1 || removed.length !== 1 || removed[0].kind !== 'tool' || landing.length !== 1)) {
      throw new Error('a tool output is valid only as a one-to-one rewrite of one current tool node');
    }
    if (outputs.length > landing.length) {
      throw new Error('replacement has ' + outputs.length + ' outputs but the selected range owns only ' + landing.length + ' original landing positions');
    }
    const sourceSeqs = unique(removed.flatMap((node) => node.sourceSeqs));
    const sourceIndexes = unique(removed.flatMap((node) => node.sourceIndexes)).sort((left, right) => left - right);
    const slices = partition(landing, outputs.length);
    const created = outputs.map((output, index): TurnNodeSnapshot => ({
      id: 'r' + this.nextReplacement++,
      kind: output.kind,
      content: output.content,
      sourceSeqs: [...sourceSeqs],
      sourceIndexes: [...sourceIndexes],
      landingSeqs: slices[index].map((item) => item.seq),
      landingIndexes: slices[index].map((item) => item.originalIndex),
      changed: true,
    }));
    this.nodes.splice(start, removed.length, ...created);
    this.assertPartition();
    return {
      created: created.map(cloneNode),
      sourceIndexes: [...sourceIndexes],
      catalog: this.structuralCatalog(),
    };
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
      '<node id="' + node.id + '" kind="' + node.kind + '" lands="' + renderIndexes(node.landingIndexes) + '" sources="' + renderIndexes(node.sourceIndexes) + '">',
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

  private assertPartition(): void {
    const flattened = this.nodes.flatMap((node) => node.landingIndexes);
    if (flattened.length !== this.originalCount) throw new Error('working surface lost or duplicated original landing coverage');
    for (let index = 0; index < flattened.length; index += 1) {
      if (flattened[index] !== index + 1) throw new Error('working surface landing coverage is not an ordered contiguous partition');
    }
    for (const node of this.nodes) {
      if (node.landingIndexes.length === 0 || node.landingSeqs.length !== node.landingIndexes.length) {
        throw new Error('node ' + node.id + ' has invalid landing coverage');
      }
      if (node.sourceIndexes.length === 0 || node.sourceSeqs.length !== node.sourceIndexes.length) {
        throw new Error('node ' + node.id + ' has invalid semantic sources');
      }
      for (const index of node.landingIndexes) {
        if (!node.sourceIndexes.includes(index)) throw new Error('node ' + node.id + ' semantic sources omit landing index n' + index);
      }
    }
  }
}
