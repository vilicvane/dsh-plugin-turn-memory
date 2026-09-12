import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

import { reasoningBlockTexts } from './content.ts';
import { isUserConversationSession } from './session-kind.ts';

export interface ThoughtHintsConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
  minimumChars?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ThoughtHint {
  assistantSeq: number;
  blockIndex: number;
  chars: number;
  text: string;
}

interface ResolvedThoughtHintsConfig {
  provider: string;
  model: string;
  minimumChars: number;
  maxTokens: number;
  timeoutMs: number;
}

interface HintTask {
  sessionId: string;
  turn: number;
  promise: Promise<string | undefined>;
}

const promptUrl = new URL('../prompts/thought-hints.md', import.meta.url);

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('turn-memory ' + name + ' must be a positive integer');
  return value;
}

function resolveConfig(config: ThoughtHintsConfig): ResolvedThoughtHintsConfig {
  const provider = config.provider?.trim();
  const model = config.model?.trim();
  if (provider === undefined || provider === '') throw new Error('turn-memory thoughtHints.provider is required when thought hints are enabled');
  if (model === undefined || model === '') throw new Error('turn-memory thoughtHints.model is required when thought hints are enabled');
  return {
    provider,
    model,
    minimumChars: positiveInteger(config.minimumChars, 16000, 'thoughtHints.minimumChars'),
    maxTokens: positiveInteger(config.maxTokens, 1024, 'thoughtHints.maxTokens'),
    timeoutMs: positiveInteger(config.timeoutMs, 120000, 'thoughtHints.timeoutMs'),
  };
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function taskKey(sessionId: string, turn: number, step: number, blockIndex: number, text: string): string {
  return [sessionId, turn, step, blockIndex, fingerprint(text)].join(':');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** In-memory, best-effort preprocessing for long reasoning blocks. */
export class ThoughtHintsController {
  readonly minimumChars: number;
  private readonly ctx: any;
  private readonly config: ResolvedThoughtHintsConfig;
  private readonly controller = new AbortController();
  private readonly tasks = new Map<string, HintTask>();
  private readonly attemptPositions = new Map<string, { sessionId: string; turn: number; step: number }>();

  constructor(ctx: any, config: ThoughtHintsConfig) {
    this.ctx = ctx;
    this.config = resolveConfig(config);
    this.minimumChars = this.config.minimumChars;
    ctx.on('agent/assistant-stream', ({ agent, frame }: any) => this.observeFrame(agent, frame));
  }

  /**
   * Live reasoning arrives through the process-local `agent/assistant-stream`
   * dispatch on 0.1.5 (durable `assistant/chunk` events no longer exist).
   * Chunk frames carry no turn/step, so they are remembered per attempt.
   */
  private observeFrame(agent: any, frame: any): void {
    const attemptId = frame?.attemptId;
    if (typeof attemptId !== 'string') return;
    if (frame.type === 'end') {
      this.attemptPositions.delete(attemptId);
      return;
    }
    if (frame.type === 'start') {
      const session = agent?.session;
      const turn = frame.turn;
      const step = frame.step;
      if (!isUserConversationSession(session) || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return;
      this.attemptPositions.set(attemptId, { sessionId: String(session.id), turn, step });
      return;
    }
    if (frame.type !== 'chunk') return;
    const position = this.attemptPositions.get(attemptId);
    if (position === undefined) return;
    const chunk = frame.chunk;
    if (chunk?.type !== 'block-end' || chunk.block?.type !== 'reasoning'
      || typeof chunk.block.text !== 'string' || chunk.block.text.length < this.minimumChars
      || !Number.isSafeInteger(chunk.index)) return;
    this.ensureTask(position.sessionId, position.turn, position.step, chunk.index, chunk.block.text);
  }

  async collectForTurn(session: any, turn: number, surfaceSeqs: readonly number[]): Promise<ThoughtHint[]> {
    const sessionId = String(session.id);
    const requested: Array<{ assistantSeq: number; blockIndex: number; chars: number; task: HintTask }> = [];
    for (const seq of surfaceSeqs) {
      const event = session.snapshotEvents()[seq];
      if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue;
      const step = event.data?.step;
      if (!Number.isSafeInteger(step)) continue;
      const reasoning = reasoningBlockTexts(event.data?.message?.content);
      const blockEnds = this.reasoningBlockEnds(session, event, turn, step);
      const usedEnds = new Set<number>();
      for (const [contentIndex, text] of reasoning.entries()) {
        if (text.length < this.minimumChars) continue;
        let endIndex = blockEnds.findIndex((candidate, index) => !usedEnds.has(index)
          && candidate.index === contentIndex && candidate.text === text);
        if (endIndex < 0) {
          endIndex = blockEnds.findIndex((candidate, index) => !usedEnds.has(index) && candidate.text === text);
        }
        if (endIndex >= 0) usedEnds.add(endIndex);
        const blockIndex = endIndex < 0 ? contentIndex : blockEnds[endIndex].index;
        requested.push({
          assistantSeq: seq,
          blockIndex,
          chars: text.length,
          task: this.ensureTask(sessionId, turn, step, blockIndex, text),
        });
      }
    }

    const results = await Promise.all(requested.map(async (item): Promise<ThoughtHint | undefined> => {
      const text = await item.task.promise;
      if (text === undefined) return undefined;
      return {
        assistantSeq: item.assistantSeq,
        blockIndex: item.blockIndex,
        chars: item.chars,
        text,
      };
    }));
    this.dropTurn(sessionId, turn);
    return results.filter((hint): hint is ThoughtHint => hint !== undefined);
  }

  discardTurn(sessionId: string, turn: number): void {
    this.dropTurn(sessionId, turn);
  }

  dispose(): void {
    this.controller.abort();
    this.tasks.clear();
  }

  private reasoningBlockEnds(session: any, messageEvent: any, turn: number, step: number): Array<{ index: number; text: string }> {
    const result: Array<{ index: number; text: string }> = [];
    const stream = messageEvent.data?.stream;
    if (Array.isArray(stream)) {
      // 0.1.5 embeds the exact timed stream on the assistant message; reasoning
      // records carry the real block index and the joined text.
      for (const record of stream) {
        if (record?.type !== 'reasoning-chunks' || !Number.isSafeInteger(record.index)
          || !Array.isArray(record.texts)) continue;
        const text = record.texts.filter((part: unknown) => typeof part === 'string').join('');
        if (text !== '') result.push({ index: record.index, text });
      }
      return result;
    }
    // Legacy durable form (pre-0.1.5) cited block-end chunks by source event seq.
    for (const seq of messageEvent.sourceEventSeqs ?? []) {
      const source = session.snapshotEvents()[seq];
      const chunk = source?.data?.chunk;
      if (source?.type !== 'assistant/chunk' || source.data?.turn !== turn || source.data?.step !== step
        || chunk?.type !== 'block-end' || chunk.block?.type !== 'reasoning'
        || typeof chunk.index !== 'number' || typeof chunk.block.text !== 'string') continue;
      result.push({ index: chunk.index, text: chunk.block.text });
    }
    return result;
  }

  private ensureTask(sessionId: string, turn: number, step: number, blockIndex: number, thought: string): HintTask {
    const key = taskKey(sessionId, turn, step, blockIndex, thought);
    const existing = this.tasks.get(key);
    if (existing !== undefined) return existing;
    const task: HintTask = {
      sessionId,
      turn,
      promise: this.generate(turn, step, blockIndex, thought),
    };
    this.tasks.set(key, task);
    return task;
  }

  private async generate(turn: number, step: number, blockIndex: number, thought: string): Promise<string | undefined> {
    try {
      this.ctx.logger.info('turn-memory: starting thought hints for turn ' + turn + ', step ' + step
        + ', block ' + blockIndex + ' (' + thought.length + ' chars, '
        + this.config.provider + '/' + this.config.model + ')');
      const assembler = new BlockAssembler();
      const system = readFileSync(promptUrl, 'utf8').trim();
      const message = createUserMessage({
        content: [{ type: 'text', text: thought }],
        source: { kind: 'plugin', plugin: 'turn-memory' },
      });
      for await (const chunk of this.ctx.llm.stream({
        provider: this.config.provider,
        model: this.config.model,
        system,
        messages: [message],
        maxTokens: this.config.maxTokens,
        purpose: 'compaction',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })) {
        assembler.push(chunk);
      }
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(finish.failure.message + ' (' + finish.failure.code + ')');
      }
      const text = assembler.blocks()
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text === '') {
        this.ctx.logger.warn('turn-memory: thought hints were empty for turn ' + turn + ', step ' + step
          + ', block ' + blockIndex + '; raw reasoning remains available');
        return undefined;
      }
      this.ctx.logger.info('turn-memory: completed thought hints for turn ' + turn + ', step ' + step
        + ', block ' + blockIndex + ' (' + text.length + ' chars)');
      return text;
    } catch (error) {
      if (this.controller.signal.aborted) return undefined;
      this.ctx.logger.warn('turn-memory: thought hints failed for turn ' + turn + ', step ' + step
        + ', block ' + blockIndex + ': ' + errorText(error) + '; raw reasoning remains available');
      return undefined;
    }
  }

  private dropTurn(sessionId: string, turn: number): void {
    for (const [key, task] of this.tasks) {
      if (task.sessionId === sessionId && task.turn === turn) this.tasks.delete(key);
    }
  }
}
