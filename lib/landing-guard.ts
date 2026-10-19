/**
 * Turn compression always lands *after* `turn/end`: the durable turn boundary is what
 * makes the range immutable in the first place. At that moment the V4 relational
 * invariant that `SessionLogScanner.finish()` enforces on the next cold load has
 * `turn === null` and `step === null`, and only `user/message` may be appended there.
 *
 * The old landing code appended `assistant/message` copies with the coordinates of the
 * already-closed turn. Those events are legal to write into the append-only log (the
 * writer does not replay relationships) but illegal to load, which is exactly how
 * session e0ba7a2e became unreadable: `assistant/message does not match an open turn
 * and step`. This module refuses that class of landing up front, so a future branch
 * cannot silently reintroduce it.
 *
 * The gate deliberately lives on the landing path rather than inside
 * `appendReplacing()`: the legacy e2e fixture in `e2e/session-compaction-runner.ts`
 * appends an assistant copy on purpose while documenting older runtime behaviour.
 */
import { appendReplacing } from './surface-op.ts';

export interface OpenTurnCoordinates {
  turn: number | null;
  step: number | null;
}

/** Mirrors upstream `STEP_EVENT_TYPES`, plus the types that go through `tool()`. */
const STEP_GATED = new Set([
  'system/message',
  'developer/message',
  'assistant/attempt',
  'assistant/message',
  'tool/call',
]);

/** Upstream routes these through `requireTurn()`: any open turn is enough. */
const TURN_GATED = new Set([
  'request/header',
  'request/context',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'llm/retry',
  'llm/retry-started',
]);

function advanceTurnCoordinates(coordinates: OpenTurnCoordinates, event: any): OpenTurnCoordinates {
  if (event?.type === 'turn/start') return { turn: Number(event.data?.turn), step: null };
  if (event?.type === 'step/start') return { turn: coordinates.turn, step: Number(event.data?.step) };
  if (event?.type === 'step/end') return { turn: coordinates.turn, step: null };
  if (event?.type === 'turn/end') return { turn: null, step: null };
  return coordinates;
}

export function openTurnCoordinates(events: readonly any[]): OpenTurnCoordinates {
  let coordinates: OpenTurnCoordinates = { turn: null, step: null };
  for (const event of events) coordinates = advanceTurnCoordinates(coordinates, event);
  return coordinates;
}

/**
 * Rejects a landing event that the relational invariant would refuse at load time.
 * Mirrors `Relationships.accept()`: the event is judged against the coordinates that
 * are open *before* it, and an open coordinate is compared by value, so a non-number
 * open turn or step never matches (fail closed).
 */
export function assertLandingEventSafe(
  type: string,
  data: any,
  surfaceOp: any,
  coordinates: OpenTurnCoordinates,
): void {
  const needsStep = STEP_GATED.has(type) || (type === 'tool/result' && surfaceOp === 'append');
  if (needsStep) {
    if (coordinates.turn === null || coordinates.step === null
      || data?.turn !== coordinates.turn || data?.step !== coordinates.step) {
      throw new Error('turn-memory: refusing to land ' + type + ' outside an open turn/step');
    }
    return;
  }
  if ((type === 'tool/result' || TURN_GATED.has(type)) && coordinates.turn === null) {
    throw new Error('turn-memory: refusing to land ' + type + ' outside an open turn');
  }
}

/** Append a replacement only if the pre-append coordinates admit the event. */
export function appendLanding(
  session: any,
  type: string,
  data: any,
  first: number,
  last: number,
  sourceEventSeqs?: number[],
): any {
  assertLandingEventSafe(
    type,
    data,
    { op: 'replace', startSeq: first, endSeq: last },
    openTurnCoordinates(session.snapshotEvents()),
  );
  return appendReplacing(session, type, data, first, last, sourceEventSeqs);
}

/**
 * Post-condition for `land()`: every event appended since `sinceIndex` must have been
 * legal at its own position. Catches a landing branch that appends through the raw
 * session handle instead of `appendLanding()`, so the guard cannot be bypassed by
 * adding another append call.
 */
export function assertLandingEventsSafe(session: any, sinceIndex: number): void {
  const events = session.snapshotEvents();
  let coordinates: OpenTurnCoordinates = { turn: null, step: null };
  let index = 0;
  for (; index < sinceIndex && index < events.length; index += 1) {
    coordinates = advanceTurnCoordinates(coordinates, events[index]);
  }
  for (; index < events.length; index += 1) {
    const event = events[index];
    assertLandingEventSafe(String(event?.type ?? ''), event?.data, event?.surfaceOp, coordinates);
    coordinates = advanceTurnCoordinates(coordinates, event);
  }
}
