import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { measureSessionForCompaction } from './session-compaction.ts';
import { isUserConversationSession } from './session-kind.ts';

export const TURN_CONTINUATION_TOOL_NAME = 'continue_after_turn_compression';

const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt';
const CONTINUATION_CONTEXT_NAME = 'turn-memory:long-turn-continuation';

export interface TurnContinuationConfig {
  enabled?: boolean;
  reminderIntervalNodes?: number;
}

export interface TurnContinuationRequest {
  version: 1;
  requestId: string;
  turn: number;
  handoff: string;
}

function isRootAgent(agent: any): boolean {
  return isUserConversationSession(agent?.session);
}

export function openTurnNumber(session: any): number | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start') {
      return Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
    }
  }
  return null;
}

function turnStartSeq(session: any, turn: number): number | undefined {
  return session.events.findLast((event: any) =>
    event?.type === 'turn/start' && event.data?.turn === turn)?.seq;
}

function isRuntimeContextSnapshot(event: any): boolean {
  return event?.type === 'user/message'
    && event.data?.source?.kind === 'plugin'
    && event.data.source.plugin === SYSTEM_PROMPT_PLUGIN;
}

/** Count append-origin model-visible nodes in the open turn, excluding replaceable runtime snapshots. */
export function countOpenTurnNodes(session: any, turn: number): number {
  const start = turnStartSeq(session, turn);
  if (start === undefined) throw new Error('turn continuation: open turn ' + turn + ' has no matching turn/start');
  let nodes = 0;
  for (const seq of session.surface.nodes as number[]) {
    if (seq <= start) continue;
    const event = session.events[seq];
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

export function latestAnnouncedMilestone(session: any, turn: number): number {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return 0;
  let latest = 0;
  for (const event of session.events as any[]) {
    if (event?.seq <= start
      || event?.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== SYSTEM_PROMPT_PLUGIN
      || !Array.isArray(event.data.source.sections)) continue;
    for (const section of event.data.source.sections) {
      if (section?.name !== CONTINUATION_CONTEXT_NAME || typeof section.text !== 'string') continue;
      if (numericMarkerAttribute(section.text, 'turn') !== turn) continue;
      const milestone = numericMarkerAttribute(section.text, 'milestone-nodes');
      if (milestone !== undefined) latest = Math.max(latest, milestone);
    }
  }
  return latest;
}

export function continuationRequestForTurn(session: any, turn: number): TurnContinuationRequest | undefined {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return undefined;
  const end = session.events.findLast((event: any) =>
    event?.type === 'turn/end' && event.data?.turn === turn)?.seq ?? Number.POSITIVE_INFINITY;
  const successful = new Set<string>();
  for (const event of session.events as any[]) {
    const block = event?.data?.message?.content?.[0];
    if (event?.type === 'tool/result'
      && event.data?.turn === turn
      && event.data?.message?.source?.kind === 'tool'
      && typeof event.data.message.source.callId === 'string'
      && block?.type === 'tool-result'
      && block.isError !== true) successful.add(event.data.message.source.callId);
  }
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.seq <= start || event?.seq >= end) continue;
    if (event.type === 'tool/code-dispatch'
      && event.data?.name === TURN_CONTINUATION_TOOL_NAME
      && event.data?.isError === false
      && typeof event.data?.subCallId === 'string') {
      const request = requestFromArguments(event.data.subCallId, turn, event.data.arguments);
      if (request !== undefined) return request;
      continue;
    }
    if (event?.type !== 'tool/call'
      || event.data?.turn !== turn
      || event.data?.name !== TURN_CONTINUATION_TOOL_NAME
      || !successful.has(event.data?.callId)) continue;
    try {
      const request = requestFromArguments(event.data.callId, turn, JSON.parse(event.data.arguments));
      if (request !== undefined) return request;
    } catch {
      continue;
    }
  }
  return undefined;
}

function requestFromArguments(requestId: string, turn: number, args: any): TurnContinuationRequest | undefined {
  const handoff = typeof args?.handoff === 'string' ? args.handoff.trim() : '';
  if (handoff === '') return undefined;
  return { version: 1, requestId, turn, handoff };
}

function isContinuationMessage(message: any, requestId: string): boolean {
  const source = message?.source;
  return source?.kind === 'plugin'
    && source.plugin === 'turn-memory'
    && source.phase === 'continuation'
    && source.requestId === requestId;
}

/** Inbox insertion and claimed user/message both prove that a request was already delivered. */
export function continuationWasDelivered(session: any, requestId: string): boolean {
  for (const event of session.events as any[]) {
    if (event?.type === 'user/message' && isContinuationMessage(event.data, requestId)) return true;
    if (event?.type === 'agent/inbox/spliced'
      && Array.isArray(event.data?.inserted)
      && event.data.inserted.some((message: any) => isContinuationMessage(message, requestId))) return true;
  }
  return false;
}

export function buildTurnContinuationContext(options: {
  turn: number;
  openTurnNodes: number;
  milestoneNodes: number;
  reminderIntervalNodes: number;
  estimatedContextTokens?: number;
}): string {
  const contextAttribute = options.estimatedContextTokens === undefined
    ? ''
    : ' context-estimated-tokens="' + options.estimatedContextTokens + '"';
  return [
    '<turn-memory-continuation turn="' + options.turn + '" milestone-nodes="' + options.milestoneNodes
      + '" open-turn-nodes="' + options.openTurnNodes + '" reminder-interval-nodes="'
      + options.reminderIntervalNodes + '"' + contextAttribute + '>',
    'This turn has ' + options.openTurnNodes + ' nodes.'
      + (options.estimatedContextTokens === undefined
        ? ''
        : ' The whole context is estimated at ' + options.estimatedContextTokens + ' tokens.'),
    '<assistant-self-check>',
    'I need to stop and summarize this turn now by calling `' + TURN_CONTINUATION_TOOL_NAME
      + '` with what I finished, the current state, and the exact next work.',
    'I should continue this turn only if the whole task will finish in the next few actions. If one atomic mutation is in progress, I will finish only that mutation first.',
    'The host will then compress this turn and continue the work automatically in a new turn.',
    '</assistant-self-check>',
    '</turn-memory-continuation>',
  ].join('\n');
}

export function buildTurnContinuationMessage(request: TurnContinuationRequest): any {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<turn-memory-continuation from-turn="' + request.turn + '">',
        'Automatic continuation after compression, not new human input.',
        'Continue the unfinished work now from this handoff: ' + request.handoff,
        '</turn-memory-continuation>',
      ].join('\n'),
    }],
    source: {
      kind: 'plugin',
      plugin: 'turn-memory',
      form: 'notice',
      summary: 'Continue work after compressing turn ' + request.turn,
      phase: 'continuation',
      requestId: request.requestId,
      fromTurn: request.turn,
    },
  });
}

export class TurnContinuationController {
  readonly reminderIntervalNodes: number;
  private readonly ctx: any;
  private readonly warnedMeasurements = new WeakSet<object>();
  private readonly warnedContextMeasurements = new WeakSet<object>();

  constructor(ctx: any, config: TurnContinuationConfig = {}) {
    const reminderIntervalNodes = config.reminderIntervalNodes ?? 30;
    if (!Number.isSafeInteger(reminderIntervalNodes) || reminderIntervalNodes <= 0) {
      throw new Error('turn continuation reminderIntervalNodes must be a positive safe integer');
    }
    this.ctx = ctx;
    this.reminderIntervalNodes = reminderIntervalNodes;
    ctx.tools.register(defineTool({
      name: TURN_CONTINUATION_TOOL_NAME,
      description: 'When the long-turn notice tells you to stop, summarize the handoff and end this turn. Work continues automatically after compression.',
      parameters: {
        handoff: {
          type: 'string',
          required: true,
          description: 'Concise completed progress, current state, and exact next work.',
        },
      },
      output: {
        schema: { type: 'string' as const },
        render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
      },
      isConcurrencySafe: () => false,
      execute: async (args: any, exec: any) => {
        const agent = exec.agent;
        if (!isRootAgent(agent)) throw new Error('turn continuation is available only in a root conversation');
        const turn = openTurnNumber(agent.session);
        if (turn === null) throw new Error('turn continuation requires an open turn');
        const existing = continuationRequestForTurn(agent.session, turn);
        if (existing !== undefined) {
          exec.concludeTurn();
          return 'turn ' + turn + ' already has continuation request ' + existing.requestId;
        }
        const openTurnNodes = countOpenTurnNodes(agent.session, turn);
        if (openTurnNodes < this.reminderIntervalNodes) {
          throw new Error('turn continuation is not active: open turn nodes ' + openTurnNodes
            + ' are below first reminder milestone ' + this.reminderIntervalNodes);
        }
        const handoff = typeof args.handoff === 'string' ? args.handoff.trim() : '';
        if (handoff === '') throw new Error('turn continuation handoff must not be empty');
        exec.concludeTurn();
        return 'continuation ' + String(exec.callId) + ' queued; this turn will end and the next turn will start after compression';
      },
    }));
    ctx.systemPrompt.context({
      name: CONTINUATION_CONTEXT_NAME,
      order: 160,
      text: (assembly: any) => this.contextFor(assembly.agent),
    });
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
    return request !== undefined && !continuationWasDelivered(session, request.requestId);
  }

  async dispatchAfterCompression(agent: any, turn: number): Promise<boolean> {
    const request = continuationRequestForTurn(agent.session, turn);
    if (request === undefined || continuationWasDelivered(agent.session, request.requestId)) return false;
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
