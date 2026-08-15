/** Pure agentic-recall routing by turn age (testable without the plugin runtime). */

export type RecallRoute = 'fork' | 'subagent';

export interface RecallRoutingInput {
  /** Target turn number. */
  turn: number;
  /** Turn boundary time in epoch ms (end time, or start time as fallback); undefined when the boundary events carry no timestamp. */
  endTime: number | undefined;
  /** Turn number of the newest completed turn/end event (0 when unknown). */
  newestTurn: number;
  /** Current epoch ms. */
  now: number;
  /** Age window in ms: a turn whose end lies inside it routes to fork. */
  recentWindowMs: number;
}

export function routeRecallByAge(input: RecallRoutingInput): RecallRoute {
  const { turn, endTime, newestTurn, now, recentWindowMs } = input;
  if (typeof endTime === 'number') {
    return now - endTime <= recentWindowMs ? 'fork' : 'subagent';
  }
  // No timestamp: fall back to newest-2 turn-number distance.
  return turn >= newestTurn - 2 ? 'fork' : 'subagent';
}