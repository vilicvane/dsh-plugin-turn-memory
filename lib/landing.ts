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
import { compressionTurnSource } from './message-source.ts';
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

export function validateLanding(job: LandingJob, e2eSmoke: boolean): void {
  job.editor.validateFinal();
  const nodes = job.editor.snapshot();
  if (nodes[0].kind !== 'user' || nodes[nodes.length - 1].kind !== 'assistant') {
    throw new Error('compressed turn must start with a user node and end with an assistant node');
  }
  if (e2eSmoke) {
    if (job.mutationCount < 2) throw new Error('e2e smoke requires at least two successful replacements');
    if (nodes.length !== 2 || nodes[0].kind !== 'user' || nodes[1].kind !== 'assistant') {
      throw new Error('e2e smoke requires one final user-assistant exchange');
    }
    if (!nodes[0].content.includes(E2E_USER_SENTINEL)) throw new Error('e2e smoke user node must preserve its exact sentinel');
    if (!nodes[1].content.includes(E2E_TOOL_SENTINEL) || !nodes[1].content.includes(E2E_FINAL_SENTINEL)) {
      throw new Error('e2e smoke assistant node must preserve both exact sentinels');
    }
    if (nodes.some((node) => node.content.includes(DRAFT_SENTINEL))) {
      throw new Error('e2e smoke draft sentinel still exists; refine the generated nodes before finishing');
    }
  }
  const events = job.session.snapshotEvents();
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
