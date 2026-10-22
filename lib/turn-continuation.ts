import type { Volatile } from '@deepseek-ai/cosmokit';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { continuationRequestOf, continuationTurnSource, isRuntimeContextSource } from './message-source.ts';
import { measureSessionForCompaction } from './session-compaction.ts';
import { isUserConversationSession } from './session-kind.ts';

export const TURN_CONTINUATION_TOOL_NAME = 'continue_after_turn_compression';

const CONTINUATION_CONTEXT_NAME = 'turn-memory:long-turn-continuation';

export const DEFAULT_REMINDER_INTERVAL_NODES = 120;

export interface TurnContinuationConfig {
  enabled?: boolean;
  /** Plain number in Cordis YAML; the live settings form writes a volatile wrapper. */
  reminderIntervalNodes?: number | Volatile<number>;
}

/**
 * A durable "continue after this turn" request. It carries no payload: the next
 * turn resumes from the compressed checkpoint, so the model no longer has to
 * restate the turn in a handoff that would both duplicate that checkpoint and
 * give the compression worker a second, competing account of the same work.
 */
export interface TurnContinuationRequest {
  version: 2;
  requestId: string;
  turn: number;
}

function isRootAgent(agent: any): boolean {
  return isUserConversationSession(agent?.session);
}

export function openTurnNumber(session: any): number | null {
  for (let index = session.snapshotEvents().length - 1; index >= 0; index -= 1) {
    const event = session.snapshotEvents()[index];
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start') {
      return Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
    }
  }
  return null;
}

function turnStartSeq(session: any, turn: number): number | undefined {
  return session.snapshotEvents().findLast((event: any) =>
    event?.type === 'turn/start' && event.data?.turn === turn)?.seq;
}

function isRuntimeContextSnapshot(event: any): boolean {
  return event?.type === 'user/message' && isRuntimeContextSource(event.data?.source);
}

/** Count append-origin model-visible nodes in the open turn, excluding replaceable runtime snapshots. */
export function countOpenTurnNodes(session: any, turn: number): number {
  const start = turnStartSeq(session, turn);
  if (start === undefined) throw new Error('turn continuation: open turn ' + turn + ' has no matching turn/start');
  let nodes = 0;
  for (const seq of session.surface.nodes as number[]) {
    if (seq <= start) continue;
    const event = session.snapshotEvents()[seq];
    if (event?.surfaceOp !== 'append' || isRuntimeContextSnapshot(event)) continue;
    if (deriveEventMessage(event) !== null) nodes += 1;
  }
  return nodes;
}

export function continuationMilestone(openTurnNodes: number, reminderIntervalNodes: number): number {
  return Math.floor(openTurnNodes / reminderIntervalNodes) * reminderIntervalNodes;
}

function numericMarkerAttribute(text: string, name: string): number | undefined {
  const match = new RegExp('\\b' + name + '="(\\d+)"').exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function announcedMilestone(text: string, turn: number): number | undefined {
  const direct = /^Turn Memory continuation required — (\d+)-node milestone$/m.exec(text);
  if (direct !== null) {
    const value = Number(direct[1]);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  // Keep recognizing snapshots written before the model-facing XML wrappers
  // were removed, so a restart does not repeat an already shown milestone.
  if (numericMarkerAttribute(text, 'turn') !== turn) return undefined;
  return numericMarkerAttribute(text, 'milestone-nodes');
}

export function latestAnnouncedMilestone(session: any, turn: number): number {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return 0;
  let latest = 0;
  for (const event of session.snapshotEvents() as any[]) {
    if (event?.seq <= start
      || event?.type !== 'user/message'
      || !isRuntimeContextSource(event.data?.source)
      || !Array.isArray(event.data.source.sections)) continue;
    for (const section of event.data.source.sections) {
      if (section?.name !== CONTINUATION_CONTEXT_NAME || typeof section.text !== 'string') continue;
      const milestone = announcedMilestone(section.text, turn);
      if (milestone !== undefined) latest = Math.max(latest, milestone);
    }
  }
  return latest;
}

export function continuationRequestForTurn(session: any, turn: number): TurnContinuationRequest | undefined {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return undefined;
  const end = session.snapshotEvents().findLast((event: any) =>
    event?.type === 'turn/end' && event.data?.turn === turn)?.seq ?? Number.POSITIVE_INFINITY;
  // 0.2 carries the outcome on the tool-role message itself: `ContentBlockMap` has no
  // `tool-result` block, so only `message.isError` marks a failed invocation.
  const successful = new Set<string>();
  for (const event of session.snapshotEvents() as any[]) {
    const message = event?.data?.message;
    if (event?.type === 'tool/result'
      && event.data?.turn === turn
      && message?.role === 'tool'
      && message?.source?.kind === 'tool'
      && typeof message.source.callId === 'string'
      && message.isError !== true) successful.add(message.source.callId);
  }
  for (let index = session.snapshotEvents().length - 1; index >= 0; index -= 1) {
    const event = session.snapshotEvents()[index];
    if (event?.seq <= start || event?.seq >= end) continue;
    if (event.type === 'tool/ptc-dispatch'
      && event.data?.name === TURN_CONTINUATION_TOOL_NAME
      && event.data?.isError === false
      && typeof event.data?.subCallId === 'string') {
      return requestFromCall(event.data.subCallId, turn);
    }
    if (event?.type !== 'tool/call'
      || event.data?.turn !== turn
      || event.data?.name !== TURN_CONTINUATION_TOOL_NAME
      || !successful.has(event.data?.callId)) continue;
    return requestFromCall(event.data.callId, turn);
  }
  return undefined;
}

function requestFromCall(requestId: string, turn: number): TurnContinuationRequest {
  return { version: 2, requestId, turn };
}

function isContinuationMessage(message: any, requestId: string): boolean {
  return continuationRequestOf(message?.source) === requestId;
}

/** Inbox insertion and claimed user/message both prove that a request was already delivered. */
export function continuationWasDelivered(session: any, requestId: string): boolean {
  for (const event of session.snapshotEvents() as any[]) {
    if (event?.type === 'user/message' && isContinuationMessage(event.data, requestId)) return true;
    if (event?.type === 'agent/inbox/spliced'
      && Array.isArray(event.data?.inserted)
      && event.data.inserted.some((message: any) => isContinuationMessage(message, requestId))) return true;
  }
  return false;
}

/** A later turn already started, so this continuation can no longer be the next turn. */
export function supersededByLaterTurn(session: any, turn: number): boolean {
  return (session?.snapshotEvents() ?? []).some((event: any) =>
    event?.type === 'turn/start'
    && Number.isSafeInteger(event.data?.turn)
    && event.data.turn > turn);
}

export function buildTurnContinuationContext(options: {
  turn: number;
  openTurnNodes: number;
  milestoneNodes: number;
  reminderIntervalNodes: number;
  estimatedContextTokens?: number;
}): string {
  const nextMilestone = options.milestoneNodes + options.reminderIntervalNodes;
  const contextStatus = 'Current open turn: ' + options.openTurnNodes + ' nodes. '
    + (options.estimatedContextTokens === undefined
      ? ''
      : 'Estimated full context: ' + options.estimatedContextTokens + ' tokens. ')
    + 'Next reminder milestone: ' + nextMilestone + ' nodes.';
  return [
    'Turn Memory continuation required — ' + options.milestoneNodes + '-node milestone',
    contextStatus,
    'This turn ends here; a fresh turn continues from the compressed memory.',
    '- If an atomic mutation is already in progress, finish only that mutation first.',
    '- End the turn with `' + TURN_CONTINUATION_TOOL_NAME + '` (no arguments) as the last action;'
      + ' the host compresses this turn and continues from that memory in a new turn.',
    '- If the whole task finishes in the next few actions, finish it within this turn.',
  ].join('\n');
}

export function buildTurnContinuationMessage(request: TurnContinuationRequest): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        'Turn Memory automatic continuation after compressed turn ' + request.turn,
        'This is host control context, not new human input.',
        'Resume the unfinished work now from the compressed turn above.',
      ].join('\n'),
    }],
    source: continuationTurnSource(request.turn, request.requestId),
  });
}

export class TurnContinuationController {
  private readonly ctx: any;
  private readonly reminderInterval: number | Volatile<number>;
  private readonly warnedMeasurements = new WeakSet<object>();
  private readonly warnedContextMeasurements = new WeakSet<object>();

  constructor(ctx: any, config: TurnContinuationConfig = {}) {
    this.ctx = ctx;
    this.reminderInterval = config.reminderIntervalNodes ?? DEFAULT_REMINDER_INTERVAL_NODES;
    if (!Number.isSafeInteger(this.reminderIntervalNodes) || this.reminderIntervalNodes <= 0) {
      throw new Error('turn continuation reminderIntervalNodes must be a positive safe integer');
    }
    ctx.tools.register(defineTool({
      name: TURN_CONTINUATION_TOOL_NAME,
      description: 'Call, with no arguments, as the last action of a turn when the active Turn Memory continuation notice requires a silent handoff. The host then compresses this turn and continues the work automatically in a new turn from that compressed memory; nothing you write here is carried over separately.',
      parameters: {},
      output: {
        schema: { type: 'string' as const },
        render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
      },
      isConcurrencySafe: () => false,
      execute: async (_args: any, exec: any) => {
        const agent = exec.agent;
        if (!isRootAgent(agent)) throw new Error('turn continuation is available only in a root conversation');
        const turn = openTurnNumber(agent.session);
        if (turn === null) throw new Error('turn continuation requires an open turn');
        const existing = continuationRequestForTurn(agent.session, turn);
        if (existing !== undefined) {
          exec.concludeTurn();
          return 'Continuation is already queued for this turn; end the turn now.';
        }
        const openTurnNodes = countOpenTurnNodes(agent.session, turn);
        if (openTurnNodes < this.reminderIntervalNodes) {
          throw new Error('turn continuation is not active: open turn nodes ' + openTurnNodes
            + ' are below first reminder milestone ' + this.reminderIntervalNodes);
        }
        exec.concludeTurn();
        return 'Continuation queued. This turn will end; after compression the host will start the next turn automatically.';
      },
    }));
    ctx.systemPrompt.context({
      name: CONTINUATION_CONTEXT_NAME,
      order: 160,
      text: (assembly: any) => this.contextFor(assembly.agent),
    });
  }

  /** A settings-form write swaps the wrapped value, so every read takes the current one. */
  private get reminderIntervalNodes(): number {
    return typeof this.reminderInterval === 'number'
      ? this.reminderInterval
      : this.reminderInterval.get();
  }

  contextFor(agent: any): string {
    if (!isRootAgent(agent)) return '';
    const turn = openTurnNumber(agent.session);
    if (turn === null || continuationRequestForTurn(agent.session, turn) !== undefined) return '';
    try {
      const openTurnNodes = countOpenTurnNodes(agent.session, turn);
      const milestoneNodes = continuationMilestone(openTurnNodes, this.reminderIntervalNodes);
      if (milestoneNodes === 0 || milestoneNodes <= latestAnnouncedMilestone(agent.session, turn)) return '';
      let estimatedContextTokens: number | undefined;
      try {
        estimatedContextTokens = measureSessionForCompaction(this.ctx.tokenMeter, agent.session).measurement.totalTokens;
      } catch (error) {
        if (!this.warnedContextMeasurements.has(agent.session)) {
          this.warnedContextMeasurements.add(agent.session);
          this.ctx.logger.warn('turn-memory: could not estimate complete context for continuation notice: '
            + (error instanceof Error ? error.message : String(error)));
        }
      }
      return buildTurnContinuationContext({
        turn,
        openTurnNodes,
        milestoneNodes,
        reminderIntervalNodes: this.reminderIntervalNodes,
        estimatedContextTokens,
      });
    } catch (error) {
      if (!this.warnedMeasurements.has(agent.session)) {
        this.warnedMeasurements.add(agent.session);
        this.ctx.logger.warn('turn-memory: could not estimate open turn for continuation notice: '
          + (error instanceof Error ? error.message : String(error)));
      }
      return '';
    }
  }

  needsDispatchAfterCompression(session: any, turn: number): boolean {
    const request = continuationRequestForTurn(session, turn);
    return request !== undefined
      && !continuationWasDelivered(session, request.requestId)
      && !supersededByLaterTurn(session, turn);
  }

  async dispatchAfterCompression(agent: any, turn: number): Promise<boolean> {
    const request = continuationRequestForTurn(agent.session, turn);
    if (request === undefined || continuationWasDelivered(agent.session, request.requestId)) return false;
    // Compression of an older turn may land after the session has already moved on —
    // notably after a restart backfills turns that were never compressed. Dispatching
    // that continuation then would start a stale turn and push every later continuation
    // one turn further behind, so the newest turn owns the continuation instead.
    if (supersededByLaterTurn(agent.session, turn)) {
      this.ctx.logger.info('turn-memory: continuation for turn ' + turn + ' is superseded by a later turn; skipped');
      return false;
    }
    agent.followup(buildTurnContinuationMessage(request));
    try {
      await this.ctx.sessions.flush(agent.session);
    } catch (error) {
      this.ctx.logger.warn('turn-memory: continuation ' + request.requestId
        + ' was queued but its immediate flush failed: ' + (error instanceof Error ? error.message : String(error)));
    }
    this.ctx.logger.info('turn-memory: dispatched continuation ' + request.requestId
      + ' for compressed turn ' + turn);
    return true;
  }
}
