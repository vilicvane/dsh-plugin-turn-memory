import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { MemoryCoordinator } from './lib/coordinator.ts';
import { contentText } from './lib/content.ts';
import { TurnNodeEditor } from './lib/editor.ts';
import {
  DRAFT_SENTINEL,
  E2E_FINAL_SENTINEL,
  E2E_TOOL_SENTINEL,
  E2E_USER_SENTINEL,
  buildCompressionPrompt,
} from './lib/prompt.ts';
import { validateProjectedToolProtocol } from './lib/tool-protocol.ts';
import { SessionMemoryCompactionEngine } from './lib/session-compaction.ts';
import type { SessionCompactionConfig } from './lib/session-compaction.ts';
import type { NodeRange, TurnNodeOutput, TurnNodeSeed } from './lib/editor.ts';

const name = 'turn-memory';
const inject = ['agents', 'llm', 'sessionQuery', 'sessions', 'subagents', 'tokenMeter', 'tools'];

const TOOL_NAMES = [
  'list_turn_nodes',
  'read_turn_nodes',
  'replace_turn_nodes',
  'finish_turn_compression',
];

const DEFAULT_SURFACE_DUMP_DIR = fileURLToPath(new URL('.tmp/', import.meta.url));

interface PluginConfig {
  enabled?: boolean;
  turnCompression?: boolean;
  e2eSmoke?: boolean;
  previewChars?: number;
  maxReadChars?: number;
  surfaceDumpDir?: string;
  sessionCompaction?: SessionCompactionConfig;
}

interface CompressionJob {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  agent: any;
  session: any;
  turn: number;
  targetSeqs: number[];
  editor: TurnNodeEditor;
  controller: AbortController;
  mutationCount: number;
  finishConfirmed: boolean;
}

function seedOf(event: any): TurnNodeSeed | undefined {
  if (event?.type === 'user/message') {
    return { kind: 'user', content: contentText(event.data?.content), sourceSeq: event.seq };
  }
  if (event?.type === 'assistant/message') {
    return { kind: 'assistant', content: contentText(event.data?.message?.content), sourceSeq: event.seq };
  }
  if (event?.type === 'tool/result') {
    return { kind: 'tool', content: contentText(event.data?.message?.content), sourceSeq: event.seq };
  }
  return undefined;
}

function prepareJob(agent: any, event: any): CompressionJob | undefined {
  const session = agent.session;
  const turn = event.data?.turn;
  if (!Number.isSafeInteger(turn)) return undefined;
  const start = session.events.findLast((candidate: any) => candidate.type === 'turn/start' && candidate.data?.turn === turn);
  if (start === undefined) return undefined;
  const targetSeqs = session.surface.nodes.filter((seq: number) => {
    if (seq <= start.seq || seq > event.seq) return false;
    const source = session.events[seq]?.data?.source;
    if (source?.plugin === 'compact') return false;
    if (source?.plugin === 'turn-memory' && Number.isSafeInteger(source.turn)) return source.turn === turn;
    return true;
  });
  if (targetSeqs.length === 0) return undefined;
  const firstIndex = session.surface.nodes.indexOf(targetSeqs[0]);
  if (firstIndex < 0 || targetSeqs.some((seq: number, index: number) => session.surface.nodes[firstIndex + index] !== seq)) {
    throw new Error('turn ' + turn + ' target is not a contiguous current surface range');
  }
  const seeds = targetSeqs.map((seq: number) => seedOf(session.events[seq]));
  if (seeds.some((seed: TurnNodeSeed | undefined) => seed === undefined)) {
    throw new Error('turn ' + turn + ' target contains a non-message surface node');
  }
  return {
    id: randomUUID(),
    parentSessionId: String(session.id),
    agent,
    session,
    turn,
    targetSeqs: [...targetSeqs],
    editor: new TurnNodeEditor(seeds as TurnNodeSeed[]),
    controller: new AbortController(),
    mutationCount: 0,
    finishConfirmed: false,
  };
}

function validateLanding(job: CompressionJob, e2eSmoke: boolean): void {
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
  const events = job.session.events;
  validateProjectedToolProtocol(nodes, events);
  const modelSource = job.targetSeqs.map((seq) => events[seq])
    .find((event) => event?.type === 'assistant/message' && event.data?.message?.source?.kind === 'model')
    ?.data?.message?.source;
  for (const node of nodes) {
    if (node.kind === 'assistant' && modelSource === undefined) throw new Error('assistant output has no original model source to inherit');
    if (node.kind === 'tool') {
      if (node.landingSeqs.length !== 1 || events[node.landingSeqs[0]]?.type !== 'tool/result') {
        throw new Error('tool output must remain a one-to-one tool/result content rewrite');
      }
    }
  }
}

function land(job: CompressionJob): void {
  const session = job.session;
  const current = session.surface.nodes;
  const firstIndex = current.indexOf(job.targetSeqs[0]);
  if (firstIndex < 0 || job.targetSeqs.some((seq, index) => current[firstIndex + index] !== seq)) {
    throw new Error('target surface changed before landing');
  }
  const events = session.events;
  const originalModelSource = job.targetSeqs.map((seq) => events[seq])
    .find((event) => event?.type === 'assistant/message' && event.data?.message?.source?.kind === 'model')
    ?.data?.message?.source;
  let fallbackStep: number | undefined;
  for (let index = job.targetSeqs.length - 1; index >= 0; index -= 1) {
    const step = events[job.targetSeqs[index]]?.data?.step;
    if (typeof step === 'number') {
      fallbackStep = step;
      break;
    }
  }
  const marker = {
    kind: 'plugin',
    plugin: 'turn-memory',
    phase: 'compression',
    turn: job.turn,
    draftId: job.id,
    originalNodes: job.targetSeqs.length,
    mutations: job.mutationCount,
  };
  for (const node of job.editor.snapshot()) {
    if (!node.changed) continue;
    const first = node.landingSeqs[0];
    const last = node.landingSeqs[node.landingSeqs.length - 1];
    const meta = {
      surfaceOp: { op: 'replace', start: first, end: last },
      sourceEventSeqs: [...node.sourceSeqs],
    };
    if (node.kind === 'user') {
      session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: node.content }],
        source: marker,
      }, meta);
      continue;
    }
    if (node.kind === 'assistant') {
      let step = fallbackStep;
      for (let index = node.sourceSeqs.length - 1; index >= 0; index -= 1) {
        const candidate = events[node.sourceSeqs[index]]?.data?.step;
        if (typeof candidate === 'number') {
          step = candidate;
          break;
        }
      }
      session.append('assistant/message', {
        turn: job.turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: {
            kind: 'model',
            provider: originalModelSource.provider,
            model: originalModelSource.model,
          },
          content: [{ type: 'text', text: node.content }],
        },
        source: marker,
      }, meta);
      continue;
    }
    const original = events[first];
    const wrapper = original.data.message.content[0];
    session.append('tool/result', {
      ...original.data,
      message: {
        ...original.data.message,
        content: [{ ...wrapper, content: [{ type: 'text', text: node.content }] }],
      },
    }, meta);
  }
}

function apply(ctx: any, config: PluginConfig = {}): void {
  if (config.enabled !== true) {
    ctx.logger.info('turn-memory: new implementation is disabled; enable explicitly for smoke testing');
    return;
  }
  const coordinator = new MemoryCoordinator();
  if (config.sessionCompaction?.enabled === true) {
    new SessionMemoryCompactionEngine(ctx, config.sessionCompaction, coordinator);
  }
  if (config.turnCompression === false) {
    ctx.logger.info('turn-memory: completed-turn compression is disabled; session compaction remains independently configured');
    return;
  }
  const previewChars = Number.isSafeInteger(config.previewChars) && (config.previewChars ?? 0) > 0 ? config.previewChars! : 120;
  const maxReadChars = Number.isSafeInteger(config.maxReadChars) && (config.maxReadChars ?? 0) > 0 ? config.maxReadChars! : 30000;
  const e2eSmoke = config.e2eSmoke === true;
  const surfaceDumpDir = typeof config.surfaceDumpDir === 'string' && config.surfaceDumpDir.trim() !== ''
    ? resolve(config.surfaceDumpDir)
    : DEFAULT_SURFACE_DUMP_DIR;
  const jobs = new Map<string, CompressionJob>();
  const stagedFinishes = new WeakMap<object, CompressionJob>();

  const jobFor = (exec: any): CompressionJob => {
    const child = exec.agent;
    const parentSessionId = child?.session?.header?.parentSession;
    if (parentSessionId === undefined) throw new Error('turn-memory editor tools are available only inside the active compression fork');
    const job = jobs.get(String(parentSessionId));
    if (job === undefined) throw new Error('no active turn-memory job for this fork parent');
    const childSessionId = String(child.session.id);
    if (job.childSessionId !== undefined && job.childSessionId !== childSessionId) {
      throw new Error('this compression job is bound to a different fork child');
    }
    job.childSessionId = childSessionId;
    return job;
  };

  ctx.tools.register(defineTool({
    name: 'list_turn_nodes',
    description: 'Return the complete rich catalog of the current isolated turn-compression working surface, including current ids, kind, size, landing position, semantic sources, state, and preview.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return jobFor(exec).editor.richCatalog(previewChars);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'read_turn_nodes',
    description: 'Read the exact current content of several node ids or continuous ranges in one call. Use generated r* ids after edits; shadowed ids are stale.',
    parameters: {
      ranges: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start: { type: 'string', required: true, description: 'First current node id.' },
            end: { type: 'string', description: 'Last current node id, inclusive; omit for one node.' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return jobFor(exec).editor.read(args.ranges as NodeRange[], maxReadChars);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'replace_turn_nodes',
    description: 'Jointly replace one current node or continuous current range with one or more ordered nodes. Select a range containing every current node whose information the outputs use; all outputs derive from that complete range. A tool output is allowed only as the sole output replacing exactly one current tool node. Returns new r* ids and the complete current structural catalog.',
    parameters: {
      start: { type: 'string', required: true, description: 'First current node id.' },
      end: { type: 'string', description: 'Last current node id, inclusive; omit for one node.' },
      nodes: {
        type: 'array',
        required: true,
        description: 'Ordered replacement nodes jointly derived from the selected range.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['user', 'assistant', 'tool'], description: 'Semantic role. Tool is valid only when it is the sole output and the selected range is exactly one current tool node.' },
            content: { type: 'string', required: true, description: 'Complete content of this output node.' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const job = jobFor(exec);
      const result = job.editor.replace(args.start, args.end, args.nodes as TurnNodeOutput[]);
      job.mutationCount += 1;
      return 'created=' + result.created.map((node) => node.id).join(',')
        + ' jointly-derived-from=' + result.sourceIndexes.map((index) => 'n' + index).join(',')
        + '\ncurrent:\n' + result.catalog;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'finish_turn_compression',
    description: 'Validate and submit the current working surface as the authoritative compressed turn transcript. This is the only accepted completion path and concludes the fork turn on success.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const job = jobFor(exec);
      validateLanding(job, e2eSmoke);
      stagedFinishes.set(exec as object, job);
      exec.concludeTurn();
      return 'turn compression accepted for commit\n' + job.editor.structuralCatalog();
    },
  }));

  ctx.on('tools/result', (exec: any, result: any) => {
    const job = stagedFinishes.get(exec as object);
    if (job === undefined) return;
    stagedFinishes.delete(exec as object);
    if (!result.isError) job.finishConfirmed = true;
  });

  const runCompression = async (job: CompressionJob): Promise<void> => {
    let run: any;
    try {
      run = await ctx.subagents.start('fork', {
        label: 'turn-memory compression ' + job.turn,
        prompt: [{ type: 'text', text: buildCompressionPrompt(job.editor, previewChars, e2eSmoke) }],
        parent: job.agent,
        signal: job.controller.signal,
        toolFilter: { allow: TOOL_NAMES },
      });
      const result = await run.result;
      if (result.stopReason !== 'completed') throw new Error('compression fork ended with ' + JSON.stringify(result.stopReason));
      if (!job.finishConfirmed) throw new Error('compression fork completed without an authoritative finish_turn_compression result');
      validateLanding(job, e2eSmoke);
      land(job);
      try {
        await ctx.sessions.flush(job.session);
        const snapshot = await ctx.sessionQuery.readSurface(job.parentSessionId);
        const surfacePath = resolve(surfaceDumpDir, 'e2e-surface-' + encodeURIComponent(job.parentSessionId) + '.json');
        await mkdir(surfaceDumpDir, { recursive: true });
        await writeFile(surfacePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
        ctx.logger.info('turn-memory: surface snapshot written to ' + surfacePath);
      } catch (error) {
        ctx.logger.warn('turn-memory: surface snapshot failed: ' + (error instanceof Error ? error.message : String(error)));
      }
      ctx.logger.info('turn-memory: turn ' + job.turn + ' compression landed (' + job.targetSeqs.length + ' -> ' + job.editor.snapshot().length + ', mutations=' + job.mutationCount + ')');
    } catch (error) {
      ctx.logger.warn('turn-memory: turn ' + job.turn + ' compression failed: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      jobs.delete(job.parentSessionId);
      if (run !== undefined) {
        try { await run.dispose(); } catch { /* best-effort child cleanup */ }
      }
    }
  };

  ctx.on('session/event', (session: any, event: any) => {
    if (event.type !== 'turn/end' || session.header?.parentSession !== undefined) return;
    if (jobs.has(String(session.id))) {
      ctx.logger.warn('turn-memory: skipped turn ' + String(event.data?.turn) + ' because a compression job is already active for this parent');
      return;
    }
    const agent = ctx.agents.get(session.id);
    if (agent === undefined) return;
    try {
      const job = prepareJob(agent, event);
      if (job === undefined) return;
      jobs.set(job.parentSessionId, job);
      queueMicrotask(() => {
        const work = runCompression(job);
        coordinator.trackTurnRewrite(job.parentSessionId, work);
        void work;
      });
    } catch (error) {
      ctx.logger.warn('turn-memory: could not prepare turn ' + String(event.data?.turn) + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  });

  ctx.effect(() => () => {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
  });
}

export { apply, inject, name };
