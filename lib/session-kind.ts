/** User-owned conversations include lineage forks; only internal delegated agents are excluded. */
export function isUserConversationSession(session: any): boolean {
  if (session?.header === undefined) return false;
  if (session.header.origin === 'subagent') return false;
  return (session.header.delegationDepth ?? 0) === 0;
}
