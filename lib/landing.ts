/**
 * Landing of a compressed completed turn.
 *
 * `land()` runs after `turn/end`, so the V4 relational invariant leaves exactly one
 * legal event type for this position: `user/message`. Extracted from the plugin entry
 * so the landing branches are unit-testable without booting the plugin.
 */
import { randomUUID } from 'node:crypto';

import { replacementEventSourceSeqs } from './editor.ts';
import { appendLanding, assertLandingEventsSafe } from './landing-guard.ts';
import {
  assertMemoryImagesRetained,
  collectMemoryImageAttachmentsOf,
  materializeMemoryImages,
} from './memory-images.ts';
import { compressionTurnSource } from './message-source.ts';
import { isInjectedHostSource, resolveLifecycleSource } from './provenance.ts';
import {
  DRAFT_SENTINEL,
  E2E_FINAL_SENTINEL,
  E2E_TOOL_SENTINEL,
  E2E_USER_SENTINEL,
} from './prompt.ts';
import { validateProjectedToolProtocol } from './tool-protocol.ts';
import { appendTurnMarkerCopy } from './turn-recovery.ts';
import type { TurnNodeEditor } from './editor.ts';

/** Structural subset of `CompressionJob`; the plugin job is assignable as-is. */
export interface LandingJob {
  id: string;
  session: any;
  turn: number;
  targetSeqs: number[];
  /** Host-owned surface nodes inside the span; the checkpoint shadows them too. */
  hostSeqs?: number[];
  editor: TurnNodeEditor;
  mutationCount: number;
  workerNumber: number;
}

/** How one compressed segment sits inside the logical turn it belongs to. */
export interface LandingShape {
  /**
   * Whether this segment ends the logical turn. Compression splits one logical turn
   * into several physical turns, so only the final segment has to end in a
   * conclusion; a segment that hands off may stop on its last tool result.
   */
  closesLogicalTurn: boolean;
}

/** Whether the compressed segment carries any human input at all. */
export function turnHasHumanInput(job: LandingJob, events: readonly any[]): boolean {
  for (const seq of job.targetSeqs) {
    const event = events[seq];
    if (event?.type !== 'user/message') continue;
    if (!isInjectedHostSource(resolveLifecycleSource(event, events))) return true;
  }
  return false;
}

export function validateLanding(
  job: LandingJob,
  e2eSmoke: boolean,
  shape: LandingShape = { closesLogicalTurn: true },
): void {
  job.editor.validateFinal();
  const nodes = job.editor.snapshot();
  const events = job.session.snapshotEvents();
  const humanInput = turnHasHumanInput(job, events);
  const startsWithUser = nodes[0].kind === 'user';
  if (humanInput && !startsWithUser) {
    throw new Error('compressed turn carries human input, so it must start with a user node');
  }
  if (!humanInput && startsWithUser) {
    throw new Error('compressed turn has no human input, so it must not start with a user node;'
      + ' host scaffolding is not a user request');
  }
  if (shape.closesLogicalTurn && nodes[nodes.length - 1].kind !== 'assistant') {
    throw new Error('compressed turn ends the logical turn, so it must end with an assistant node');
  }
  if (e2eSmoke) {
    if (job.mutationCount < 2) throw new Error('e2e smoke requires at least two successful replacements');
    // The smoke scenario asserts the human-input exchange shape. A continuation round
    // has no human input, so it legitimately starts with the assistant and only keeps
    // the draft-sentinel check.
    if (humanInput) {
      if (nodes.length !== 2 || nodes[0].kind !== 'user' || nodes[1].kind !== 'assistant') {
        throw new Error('e2e smoke requires one final user-assistant exchange');
      }
      if (!nodes[0].content.includes(E2E_USER_SENTINEL)) throw new Error('e2e smoke user node must preserve its exact sentinel');
      if (!nodes[1].content.includes(E2E_TOOL_SENTINEL) || !nodes[1].content.includes(E2E_FINAL_SENTINEL)) {
        throw new Error('e2e smoke assistant node must preserve both exact sentinels');
      }
    }
    if (nodes.some((node) => node.content.includes(DRAFT_SENTINEL))) {
      throw new Error('e2e smoke draft sentinel still exists; refine the generated nodes before finishing');
    }
  }
  // The host owns image identity, so validation runs on the materialized memory rather
  // than on the worker's draft: a dropped marker is restored, never rejected.
  assertMemoryImagesRetained(
    job.targetSeqs.map((seq) => events[seq]?.data),
    landingNodeTexts(job, events).join('\n'),
    'turn compression',
  );
  // A landing that keeps every changed node a user node rewrites those nodes as
  // user/message replacements, so the projected tool protocol still has to match.
  // Anything else collapses the whole turn into one plain user/message checkpoint,
  // which retains no structured tool events and therefore cannot violate it.
  if (nodes.every((node) => !node.changed || node.kind === 'user')) {
    validateProjectedToolProtocol(nodes, events);
  }
}

/**
 * Final node texts with every image of the segment addressable.
 *
 * Image identity is host-owned: each node keeps the markers it already carries, and any
 * image whose marker the rewrite dropped is appended to the node whose sources carried it.
 * Leftovers land on the final node so no attachment of the segment is ever lost.
 */
function landingNodeTexts(job: LandingJob, events: readonly any[]): string[] {
  const texts = job.editor.snapshot().map((node) => materializeMemoryImages(
    node.content,
    collectMemoryImageAttachmentsOf(node.sourceSeqs.map((seq) => events[seq]?.data)),
  ));
  const segmentAttachments = collectMemoryImageAttachmentsOf(job.targetSeqs.map((seq) => events[seq]?.data));
  if (texts.length > 0 && segmentAttachments.length > 0) {
    texts[texts.length - 1] = materializeMemoryImages(texts[texts.length - 1], segmentAttachments);
  }
  return texts;
}

function emitLanding(job: LandingJob, marker: any, events: readonly any[]): void {
  const session = job.session;
  const nodes = job.editor.snapshot();
  if (nodes.every((node) => !node.changed)) {
    appendTurnMarkerCopy(session, events[job.targetSeqs[0]], marker);
    return;
  }
  const startSeq = job.targetSeqs[0];
  const endSeq = job.targetSeqs[job.targetSeqs.length - 1];
  // After `turn/end` no turn or step is open, and the invariant only admits
  // user/message there: assistant/message, tool/call and an appended tool/result all
  // require the coordinates of the currently open step, while a tool/result
  // replacement requires an open turn. A changed user node can therefore still land as
  // one user/message replacement; a changed assistant or tool node, or any structural
  // merge/split, has to collapse into one user/message checkpoint.
  const texts = landingNodeTexts(job, events);
  if (nodes.every((node) => !node.changed || node.kind === 'user')) {
    for (const [index, node] of nodes.entries()) {
      if (!node.changed) continue;
      const first = node.landingSeqs[0];
      const last = node.landingSeqs[node.landingSeqs.length - 1];
      appendLanding(session, 'user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: texts[index] }],
        source: marker,
      }, first, last, [...new Set([
        ...replacementEventSourceSeqs(node),
        ...hostSeqsWithin(session, first, last, job.hostSeqs ?? []),
      ])]);
    }
    return;
  }
  const checkpoint = nodes
    .map((node, index) => (node.kind === 'tool' ? 'Tool result' : node.kind === 'assistant' ? 'Assistant' : 'User') + ': ' + texts[index])
    .join('\n\n');
  appendLanding(session, 'user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: checkpoint }],
    source: marker,
  }, startSeq, endSeq, [...new Set([
    ...nodes.flatMap((node) => node.sourceSeqs),
    ...job.targetSeqs,
    ...(job.hostSeqs ?? []),
  ])]);
}

/**
 * Host-owned nodes that sit between two landing seqs and therefore get shadowed by the
 * replacement. The invariant requires every shadowed surface node in `sourceEventSeqs`.
 */
function hostSeqsWithin(
  session: any,
  first: number,
  last: number,
  hostSeqs: readonly number[],
): number[] {
  if (hostSeqs.length === 0) return [];
  const nodes: number[] = session.surface.nodes;
  const start = nodes.indexOf(first);
  const end = nodes.indexOf(last);
  if (start < 0 || end < start) return [];
  const hostSet = new Set(hostSeqs);
  return nodes.slice(start, end + 1).filter((seq: number) => hostSet.has(seq));
}

export function land(job: LandingJob): void {
  const session = job.session;
  const current = session.surface.nodes;
  const hostSeqs = job.hostSeqs ?? [];
  const targetSet = new Set(job.targetSeqs);
  const hostSet = new Set(hostSeqs);
  const firstIndex = current.indexOf(job.targetSeqs[0]);
  const lastIndex = current.indexOf(job.targetSeqs[job.targetSeqs.length - 1]);
  if (firstIndex < 0 || lastIndex < firstIndex) throw new Error('target surface changed before landing');
  const span: number[] = current.slice(firstIndex, lastIndex + 1);
  const landed = span.filter((seq: number) => targetSet.has(seq));
  if (landed.length !== job.targetSeqs.length
    || landed.some((seq: number, index: number) => seq !== job.targetSeqs[index])
    || span.some((seq: number) => !targetSet.has(seq) && !hostSet.has(seq))) {
    throw new Error('target surface changed before landing');
  }
  const events = session.snapshotEvents();
  const appendedFrom = events.length;
  const marker = compressionTurnSource({
    turn: job.turn,
    draftId: job.id,
    originalNodes: job.targetSeqs.length,
    mutations: job.mutationCount,
    workerAttempts: job.workerNumber,
  });
  emitLanding(job, marker, events);
  // Belt and braces: a branch that appends through the raw session handle instead of
  // `appendLanding()` still cannot leave an unloadable event behind.
  assertLandingEventsSafe(session, appendedFrom);
}
