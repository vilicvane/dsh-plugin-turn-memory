# Turn compression

Rewrite the editable surface of the completed parent turn as a compact, faithful transcript. Preserve a recognizable user-assistant conversation and the causal evolution of the work; do not produce a retrospective assistant-only summary.

You already have the exact completed turn in inherited context. The catalog maps its current surface nodes to opaque ids in an isolated in-memory editor. Original node boundaries are editable structure, not facts that must survive.

<initial-node-catalog>
{{initialNodeCatalog}}
</initial-node-catalog>

## Embedded compression skill

Apply this procedure directly to the inherited turn. The catalog is for addressing nodes, not for discovering a conversation you already know.

1. Build the causal record.
   - Identify the user's intended objective and constraints, then classify later user input as a correction or missing detail, a response to an intermediate result, or a genuine new objective.
   - Inventory information that would be costly or impossible to reconstruct: insights or inspirations; uncertain hypotheses; trials and detours with their outcomes; discoveries; decisions and rationale; conclusions with scope and evidence; and externally observed results.
   - Preserve chronology, causality, attribution, and epistemic status. Keep hypotheses uncertain, failures as failures, and conclusions no broader or more certain than their evidence.

2. Correct intent without rewriting history.
   - When a later steer fixes a typo or supplies missing information and reveals the route intended all along, replace a continuous span containing both user messages and emit one corrected user intent. Its semantic sources must include the later steer; do not retain the superseded wording as a separate user exchange.
   - The corrected user node represents what the user intended and what the user supplied. Do not make it narrate or take attribution for assistant actions, tool outcomes, discoveries, or failures.
   - Consolidating user intent does not erase work already performed. Preserve an actual off-route attempt as assistant-side trial history when it has a distinct outcome: state compactly what was tried, why it failed or what it ruled out, and how the route changed. This trial may be merged into the later assistant result; it need not remain a separate exchange or raw tool trace.
   - Keep a user interaction boundary when it remains causally useful—for example, an intermediate result prompted a decision, the user genuinely changed objectives, or an unresolved branch must remain visible.

3. Choose semantic boundaries and compress.
   - Choose granularity from the retained information, with no fixed node count. Original user, assistant, and tool boundaries are evidence for the rewrite, not a structure to copy.
   - Node boundaries represent semantic work units, not forced role alternation. Adjacent same-role nodes may remain when they do materially different things; merge them when the split is only execution residue.
   - Compress repetitive commands, listings, and status chatter. Prefer absorbing completed tool interactions and their useful information into conversational nodes. Retain raw tool nodes only when their protocol structure or exact result remains useful; then preserve the complete call-result pair.

4. Edit and verify the working surface.
   - Use `replace_turn_nodes` on one current node or continuous current range with one or more ordered outputs. Select a range containing every current node whose information the outputs use; inherited context helps understanding but is not provenance for an unselected node.
   - A tool output is allowed only when the replacement selects exactly one current tool node and produces exactly that one tool node—never include a tool output in a multi-output replacement.
   - Keep an existing node unchanged only when both its content and boundary already belong in the compact transcript. Successful replacements return new `r*` ids plus the complete structural catalog; shadowed ids are stale, and generated nodes may be selected again.
   - The inherited context and previews should usually suffice. Use `read_turn_nodes` when exact current text is needed; one call can read several ids or ranges.
   - Before finishing, audit every retained fact for role attribution and `sources=` coverage. If content uses a steer, trial, discovery, or result outside its sources—or assigns assistant/tool evidence to the user—redo the edit with the right range and role.
   - Write only semantic roles and content. The host owns session seqs, surface operations, provenance, message ids, turn and step fields, landing slices, and tool-pairing metadata.
   - Submit the desired surface with `finish_turn_compression`. Plain text, natural stopping, or any other signal is not an accepted result.

{{#if e2eSmoke}}
## E2E smoke protocol (follow exactly)

- First replace the entire current range `n1..n{{originalCount}}` with exactly two nodes: a user node containing `{{e2eUserSentinel}}` and `{{draftSentinel}}`, followed by an assistant node containing both `{{e2eToolSentinel}}` and `{{e2eFinalSentinel}}` and also `{{draftSentinel}}`.
- Then select both returned `r*` ids in a second `replace_turn_nodes` call and refine them into exactly one user node followed by one assistant node. Preserve all three E2E sentinels exactly and remove every `{{draftSentinel}}`.
- Finally call `finish_turn_compression`.
{{/if}}
