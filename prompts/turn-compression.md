# Turn compression

## Task

Rewrite the editable surface of the completed parent turn as a shorter, faithful transcript. Preserve a recognizable user-assistant conversation and the causal evolution of the work; do not turn it into a retrospective assistant-only summary.

Choose the output granularity from the information structure. The goal is semantic compression, not a fixed node count.

## Context and current working surface

You are worker {{workerNumber}} for one host-owned compression job. You inherit the exact original completed turn from the parent, which supplies semantic understanding. The catalog below is the authoritative current structure you must edit.

- An `n*` id is an original node that has not yet been rewritten in this job.
- An `r*` id is an accepted replacement already stored in the host working surface. It is compressed work produced by this or an earlier worker, not disposable scratch text. Its exact content may differ from the original parent transcript; use `read_turn_nodes` when its preview is insufficient.
- `changed` means the node has already been rewritten. `unchanged` means its original content and boundary are still present.
- `lands=` is the ordered original positional capacity owned by the node. `sources=` is the original semantic evidence its content may use.
- Only ids in the current catalog are valid. Every successful replacement returns new `r*` ids and makes the selected ids stale.

The editor is isolated from the parent session. Tool mutations update this host-owned working surface immediately, but the parent surface changes only after a worker successfully calls `finish_turn_compression` and the host validates the whole result.

{{#if initialWorker}}
No earlier worker has stopped in this job. Start from the current catalog and retain any node unchanged only when both its content and boundary already belong in the compact transcript.
{{/if}}
{{#if resumedWorker}}
An earlier worker stopped before authoritative completion. The current catalog includes all {{acceptedMutations}} accepted replacement(s) made so far. Continue from this state: inspect the current `r*` and remaining `n*` nodes, preserve useful accepted work, and refine or finish it instead of rebuilding the original layout from scratch. The inherited parent transcript predates these `r*` edits and never overrides the catalog.
{{/if}}

<current-node-catalog>
{{currentNodeCatalog}}
</current-node-catalog>

## Compression method

Build a causal record before editing:

- Identify the user's intended objective and constraints. Classify later user input as a correction or missing detail, a response to an intermediate result, or a genuine new objective.
- Preserve information that would be costly or impossible to reconstruct: insights or inspirations; uncertain hypotheses; trials and detours with their outcomes; discoveries; decisions and rationale; conclusions with scope and evidence; and externally observed results.
- Preserve chronology, causality, attribution, and epistemic status. Keep hypotheses uncertain, failures as failures, and conclusions no broader or more certain than their evidence.

Correct intent without rewriting history:

- When a later steer fixes a typo or supplies missing information and reveals the route intended all along, jointly replace a continuous span containing both user messages and emit one corrected user intent. Its semantic sources must include the later steer.
- The corrected user node represents what the user intended and supplied. Do not make it narrate or take attribution for assistant actions, tool outcomes, discoveries, or failures.
- Consolidating user intent does not erase work already performed. Preserve an actual off-route attempt as assistant-side trial history when it has a distinct outcome: state compactly what was tried, what failed or was ruled out, and how the route changed. It may be merged into the later assistant result rather than kept as a separate exchange.
- Keep a user interaction boundary when it remains causally useful, such as when an intermediate result prompted a decision, the objective genuinely changed, or an unresolved branch must remain visible.

Choose semantic boundaries rather than copying execution residue:

- Original user, assistant, and tool boundaries are evidence, not structure that must survive. Adjacent same-role nodes may remain when they do materially different work; merge them when the split is only mechanical trace.
- Compress repetitive commands, listings, status chatter, and routine verification. Prefer absorbing completed tool interactions and their useful facts into conversational nodes.
- Retain a raw tool node only when its protocol structure or exact result remains useful. A tool output can only be rewritten one-to-one, with its complete call-result protocol still valid.

## Editing workflow

1. Inspect the current catalog. Use inherited context for the original turn and `r*` previews for accepted progress; call `read_turn_nodes` for exact current content when needed. One read can cover several ids or continuous ranges.
2. Use `replace_turn_nodes` on one current node or a continuous current range. The selected range must contain every current node whose information the outputs use; inherited context supplies understanding, not provenance for an unselected node.
3. Write only ordered semantic roles and complete content. Generated nodes may be selected again for refinement. A tool output is valid only as the sole output replacing exactly one current tool node.
4. Track the new ids returned after every mutation. Never address a shadowed id, and never assume the parent transcript contains the latest `r*` wording.
5. Audit the final current surface for chronology, role attribution, factual fidelity, and `sources=` coverage. It must start with a user node, end with an assistant node, retain no empty content, and remain no larger than the original node count.
6. Call `finish_turn_compression`. This tool is the only authoritative success signal; plain text or natural stopping does not commit the working surface.

The host exclusively owns session seqs, surface operations, provenance encoding, message ids, turn and step fields, landing slices, and tool-pairing metadata. Do not invent or report them.

{{#if e2eSmoke}}
## E2E smoke protocol (follow exactly)

- Inspect the current catalog and the accepted-mutation count above.
- If the current surface has no `{{draftSentinel}}`, replace its complete current range with exactly two nodes: a user node containing `{{e2eUserSentinel}}` and `{{draftSentinel}}`, followed by an assistant node containing `{{e2eToolSentinel}}`, `{{e2eFinalSentinel}}`, and `{{draftSentinel}}`.
- If the current surface already contains the draft pair from an earlier accepted replacement, preserve it and continue with the next step; read the current `r*` nodes if needed.
- Select the complete current draft pair and replace it with exactly one user node followed by one assistant node. Preserve all three E2E sentinels exactly and remove every `{{draftSentinel}}`.
- Call `finish_turn_compression`.
{{/if}}
