import type { TurnNodeSnapshot } from './editor.ts';

export function eventToolCallIds(event: any): string[] {
  if (event?.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content)) return [];
  return event.data.message.content
    .filter((block: any) => block?.type === 'tool-call' && typeof block.id === 'string')
    .map((block: any) => block.id);
}

export function eventToolResultCallId(event: any): string | undefined {
  if (event?.type !== 'tool/result') return undefined;
  const callId = event.data?.message?.source?.callId;
  return typeof callId === 'string' ? callId : undefined;
}

export interface ProjectedToolProtocolIssue {
  kind: 'duplicate-call' | 'missing-call' | 'missing-result';
  nodeId: string;
  relatedNodeId?: string;
  range?: string;
}

function retainedEvent(node: TurnNodeSnapshot, events: readonly any[]): any {
  return !node.changed || node.kind === 'tool' ? events[node.landingSeqs[0]] : undefined;
}

function originalCallSeq(nodes: readonly TurnNodeSnapshot[], events: readonly any[], callId: string): number | undefined {
  for (const node of nodes) {
    for (const seq of node.landingSeqs) {
      if (eventToolCallIds(events[seq]).includes(callId)) return seq;
    }
  }
  return undefined;
}

function originalResultSeq(nodes: readonly TurnNodeSnapshot[], events: readonly any[], callId: string): number | undefined {
  for (const node of nodes) {
    for (const seq of node.landingSeqs) {
      if (eventToolResultCallId(events[seq]) === callId) return seq;
    }
  }
  return undefined;
}

function nodeCoveringSeq(nodes: readonly TurnNodeSnapshot[], seq: number | undefined): string | undefined {
  if (seq === undefined) return undefined;
  return nodes.find((node) => node.landingSeqs.includes(seq))?.id;
}

function currentRange(nodes: readonly TurnNodeSnapshot[], firstId: string, secondId: string | undefined): string | undefined {
  if (secondId === undefined || firstId === secondId) return firstId;
  const first = nodes.findIndex((node) => node.id === firstId);
  const second = nodes.findIndex((node) => node.id === secondId);
  if (first < 0 || second < 0) return undefined;
  return first < second ? firstId + '..' + secondId : secondId + '..' + firstId;
}

/** Find the first structured call/result mismatch in the current projected surface. */
export function projectedToolProtocolIssue(
  nodes: readonly TurnNodeSnapshot[],
  events: readonly any[],
): ProjectedToolProtocolIssue | undefined {
  const pending = new Map<string, string>();
  for (const node of nodes) {
    const retained = retainedEvent(node, events);
    for (const callId of eventToolCallIds(retained)) {
      const firstCallNode = pending.get(callId);
      if (firstCallNode !== undefined) {
        return {
          kind: 'duplicate-call',
          nodeId: node.id,
          relatedNodeId: firstCallNode,
          range: currentRange(nodes, firstCallNode, node.id),
        };
      }
      pending.set(callId, node.id);
    }
    const resultCallId = eventToolResultCallId(retained);
    if (resultCallId === undefined) continue;
    if (!pending.delete(resultCallId)) {
      const coveredCallNode = nodeCoveringSeq(nodes, originalCallSeq(nodes, events, resultCallId));
      return {
        kind: 'missing-call',
        nodeId: node.id,
        ...(coveredCallNode === undefined ? {} : { relatedNodeId: coveredCallNode }),
        range: currentRange(nodes, node.id, coveredCallNode),
      };
    }
  }
  const dangling = pending.entries().next().value as [string, string] | undefined;
  if (dangling === undefined) return undefined;
  const [callId, callNodeId] = dangling;
  const coveredResultNode = nodeCoveringSeq(nodes, originalResultSeq(nodes, events, callId));
  return {
    kind: 'missing-result',
    nodeId: callNodeId,
    ...(coveredResultNode === undefined ? {} : { relatedNodeId: coveredResultNode }),
    range: currentRange(nodes, callNodeId, coveredResultNode),
  };
}

/** Explain the one repair action available through the working-surface editor. */
export function describeProjectedToolProtocolIssue(issue: ProjectedToolProtocolIssue): string {
  if (issue.kind === 'duplicate-call') {
    return 'structured tool call ' + issue.nodeId + ' duplicates the call retained by ' + issue.relatedNodeId
      + '. Rewrite the current range ' + (issue.range ?? issue.nodeId)
      + ' as ordinary user/assistant transcript nodes.';
  }
  const missing = issue.kind === 'missing-call' ? 'call' : 'result';
  const retained = issue.kind === 'missing-call' ? 'result' : 'call';
  const covered = issue.relatedNodeId === undefined
    ? ''
    : ' The original ' + missing + ' is now covered by plain node ' + issue.relatedNodeId + '.';
  return 'structured tool ' + retained + ' ' + issue.nodeId + ' has no retained structured ' + missing + '.'
    + covered
    + ' Rewrite the continuous current range ' + (issue.range ?? issue.nodeId)
    + ' together as ordinary user/assistant transcript nodes. `kind="tool"` preserves a structured result; it cannot recreate a removed call.';
}

/** Add immediate model-facing repair guidance while keeping the accepted draft editable. */
export function withProjectedToolProtocolWarning(
  output: string,
  nodes: readonly TurnNodeSnapshot[],
  events: readonly any[],
): string {
  const issue = projectedToolProtocolIssue(nodes, events);
  return issue === undefined
    ? output
    : output + '\n\nprotocol-warning: this draft cannot finish yet. '
      + describeProjectedToolProtocolIssue(issue);
}

/** Validate the tool protocol that will remain after changed nodes become plain transcript messages. */
export function validateProjectedToolProtocol(nodes: readonly TurnNodeSnapshot[], events: readonly any[]): void {
  const issue = projectedToolProtocolIssue(nodes, events);
  if (issue !== undefined) throw new Error(describeProjectedToolProtocolIssue(issue));
}
