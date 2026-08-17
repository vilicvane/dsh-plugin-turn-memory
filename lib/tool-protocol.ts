import type { TurnNodeSnapshot } from './editor.ts';

function toolCallIds(event: any): string[] {
  if (event?.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content)) return [];
  return event.data.message.content
    .filter((block: any) => block?.type === 'tool-call' && typeof block.id === 'string')
    .map((block: any) => block.id);
}

function toolResultCallId(event: any): string | undefined {
  if (event?.type !== 'tool/result') return undefined;
  const callId = event.data?.message?.source?.callId;
  return typeof callId === 'string' ? callId : undefined;
}

/** Validate the tool protocol that will remain after changed nodes become plain transcript messages. */
export function validateProjectedToolProtocol(nodes: readonly TurnNodeSnapshot[], events: readonly any[]): void {
  const pending = new Map<string, string>();
  for (const node of nodes) {
    const retained = !node.changed || node.kind === 'tool' ? events[node.landingSeqs[0]] : undefined;
    for (const callId of toolCallIds(retained)) {
      if (pending.has(callId)) throw new Error('duplicate retained tool call ' + JSON.stringify(callId));
      pending.set(callId, node.id);
    }
    const resultCallId = toolResultCallId(retained);
    if (resultCallId === undefined) continue;
    if (!pending.delete(resultCallId)) {
      throw new Error('retained tool result ' + node.id + ' has no preceding retained tool call ' + JSON.stringify(resultCallId));
    }
  }
  const dangling = pending.entries().next().value as [string, string] | undefined;
  if (dangling !== undefined) {
    throw new Error('retained tool call ' + dangling[1] + ' has no retained tool result ' + JSON.stringify(dangling[0]));
  }
}
