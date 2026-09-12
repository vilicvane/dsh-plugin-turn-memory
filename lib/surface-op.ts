/**
 * DSH 0.1.2 spells a positional surface replacement `{ op: "replace", start, end }`;
 * DSH 0.1.5 renamed those fields to `startSeq`/`endSeq` and rejects the old names.
 * Which spelling is legal is decided by the runtime that owns the session, not by
 * the plugin, so try the current spelling first and fall back to the legacy one when
 * the runtime rejects the op itself. Both runtimes validate the op before mutating
 * anything, so a rejected attempt never leaves a half-appended event behind.
 */
export function appendReplacing(
  session: any,
  type: string,
  data: any,
  first: number,
  last: number,
  sourceEventSeqs?: number[],
): any {
  const provenance = sourceEventSeqs === undefined ? {} : { sourceEventSeqs };
  try {
    return session.append(type, data, {
      ...provenance,
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
    });
  } catch (error) {
    if (!/invalid replace surfaceOp/i.test(String((error as Error)?.message ?? error))) throw error;
    return session.append(type, data, {
      ...provenance,
      surfaceOp: { op: 'replace', start: first, end: last },
    });
  }
}
