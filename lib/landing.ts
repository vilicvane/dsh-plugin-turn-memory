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
import { assertMemoryImagesRetained } from './memory-images.ts';
import { compressionTurnSource, isTurnMemorySource } from './message-source.ts';
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

/** Host-injected user messages that are never a human request. */
const HOST_SCAFFOLDING_KINDS: ReadonlySet<string> = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
  'skill-invocation',
  'tool-jobs',
]);

/** Context forms that mark an injected message rather than human input. */
const HOST_SCAFFOLDING_FORMS: ReadonlySet<string> = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'notice',
]);

/**
 * Whether one user/message source is host scaffolding rather than human input.
 *
 * Steering is ordinary human input carried by a plain `user` source, so a steered
 * segment still counts as human: the merged intent belongs in a user node even when
 * the segment opened with a continuation notice. Unknown kinds stay human, which
 * keeps the stricter user-first shape for anything this plugin does not recognize.
 */
export function isHostScaffoldingSource(source: any): boolean {
  if (source === null || typeof source !== 'object') return false;
  if (isTurnMemorySource(source)) return true;
  if (HOST_SCAFFOLDING_KINDS.has(source.kind)) return true;
  if (typeof source.form === 'string' && HOST_SCAFFOLDING_FORMS.has(source.form)) return true;
  return false;
}

/** Lifecycle marker kinds that copy an existing message instead of adding a new one. */
const LIFECYCLE_MARKER_KINDS: ReadonlySet<string> = new Set([
  'turn-memory-pending',
  'turn-memory-failed',
]);

/**
 * Resolve the message a lifecycle marker copy replaced.
 *
 * `turn/end` rewrites the turn's leading user message into a `turn-memory-pending` copy
 * carrying the marker source, so the recorded source alone no longer says whether the
 * human or the host opened the turn. The copy keeps the shadowed seq in
 * `sourceEventSeqs`, so provenance (and steering added later in the turn) stays readable.
 */
export function resolveHumanSource(event: any, events: readonly any[]): any {
  let current = event;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    const source = current?.data?.source;
    if (!LIFECYCLE_MARKER_KINDS.has(source?.kind)) return source;
    const originSeq = Array.isArray(current?.sourceEventSeqs) ? current.sourceEventSeqs[0] : undefined;
    if (!Number.isSafeInteger(originSeq) || events[originSeq] === undefined) return source;
    current = events[originSeq];
  }
  return current?.data?.source;
}

/** Whether the compressed segment carries any human input at all. */
export function turnHasHumanInput(job: LandingJob, events: readonly any[]): boolean {
  for (const seq of job.targetSeqs) {
    const event = events[seq];
    if (event?.type !== 'user/message') continue;
    if (!isHostScaffoldingSource(resolveHumanSource(event, events))) return true;
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
  assertMemoryImagesRetained(
    job.targetSeqs.map((seq) => events[seq]?.data),
    nodes.map((node) => node.content).join('\n'),
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
  if (nodes.every((node) => !node.changed || node.kind === 'user')) {
    for (const node of nodes) {
      if (!node.changed) continue;
      const first = node.landingSeqs[0];
      const last = node.landingSeqs[node.landingSeqs.length - 1];
      appendLanding(session, 'user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: node.content }],
        source: marker,
      }, first, last, replacementEventSourceSeqs(node));
    }
    return;
  }
  const checkpoint = nodes
    .map((node) => (node.kind === 'tool' ? 'Tool result' : node.kind === 'assistant' ? 'Assistant' : 'User') + ': ' + node.content)
    .join('\n\n');
  appendLanding(session, 'user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: checkpoint }],
    source: marker,
  }, startSeq, endSeq, [...new Set([...nodes.flatMap((node) => node.sourceSeqs), ...job.targetSeqs])]);
}

export function land(job: LandingJob): void {
  const session = job.session;
  const current = session.surface.nodes;
  const firstIndex = current.indexOf(job.targetSeqs[0]);
  if (firstIndex < 0 || job.targetSeqs.some((seq, index) => current[firstIndex + index] !== seq)) {
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
