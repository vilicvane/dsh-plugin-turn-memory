---
name: turn-memory-prompt-refactor
description: Refactor the turn-memory fork subagent prompt as one coherent design. Use whenever changing, optimizing, debugging, or reviewing buildPrompt, node-catalog wording, compression-tool descriptions, completion instructions, or the E2E-only prompt protocol in this project.
---

# Turn Memory Prompt Refactor

Treat every prompt change as a refactor of the complete model-facing contract. Never fix behavior by appending a local warning, exception, repeated prohibition, or one-run-specific instruction.

## Reconstruct from product intent

Treat these as stable requirements to reconstruct the prompt from, not as wording that must appear verbatim:

- Compress the transcript; do not replace it with a retrospective assistant-only summary.
- Preserve the overall chronology, causal progression, and recognizable user-assistant interaction. The compressed surface should still read like a conversation.
- Merge low-value continuous working traces and supplementary steers when they form one coherent interaction. In particular, support semantic `user → assistant → user → assistant` to `user → assistant` compression: the new user node combines the human intent and later steer, while the new assistant node combines the response, adjustment, and outcome.
- Preserve temporally or causally decisive moments at higher fidelity and, when useful, as separate nodes. This includes changed direction, corrections, constraints, discoveries, failures, decisions, and externally visible results.
- Choose granularity from the interaction's information structure. Do not target a fixed node count or collapse a turn to one assistant node by default.
- Treat the preceding 4→2 example as a joint semantic K→M rewrite. Its role-specific outputs depend on interleaved, non-contiguous source nodes inside one continuous input span. Do not fake it with misleading per-node coverage or weaken the product requirement to fit a K→1 editor; redesign the editing contract when necessary.

When the user clarifies another original prompt requirement, update this section so later refactors begin from product intent rather than inheriting the current prompt by accident.

## Establish the complete contract

Before editing:

1. Read the entire `buildPrompt` implementation, not only the suspected line.
2. Read every tool name, description, parameter description, return shape, and validation rule visible to the fork subagent.
3. Read the applicable confirmed agreements in `design.md`. Do not silently change their semantics. Research and confirm any new design decision before recording or implementing it.
4. Inspect the concrete evidence that motivated the change, such as an E2E trace, tool-call sequence, landed surface, or failure. Separate observed behavior from the proposed explanation.
5. Restate the prompt's objective and invariants without borrowing its current wording. Cover at least:
   - what the subagent must produce;
   - what context and node identity mean;
   - which tools change or reveal state;
   - which metadata belongs exclusively to the host;
   - how successful completion is signaled.

Treat the main prompt, initial catalog, tool affordances, tool results, host validation, and completion path as one protocol. A wording change in one part requires checking every other part for consistency.

## Refactor the whole prompt

Draft the resulting prompt as a complete replacement before applying edits. Reconsider every existing instruction; retaining a line unchanged must be a deliberate choice, not a default.

Use this structure only where each section earns its place:

1. Task and desired result.
2. Context and working-surface model.
3. Available editing and reading workflow.
4. Hard constraints and ownership boundaries.
5. Authoritative completion condition.

Prefer direct, positive instructions in execution order. Remove duplication, obsolete cautions, implied contradictions, and details already expressed more precisely by tool schemas or results. Keep critical constraints salient without stating the same rule in several forms.

Do not preserve old wording merely for textual compatibility. Preserve behavior only when it remains part of the reconstructed contract.

Keep deterministic E2E instructions isolated from the production prompt. Never distort production compression behavior to make a smoke fixture pass.

## Review from the model's perspective

Read the final rendered prompt from beginning to end and simulate this path:

1. Understand the inherited conversation and map it to the initial catalog.
2. Decide whether any full node content must be read.
3. Perform one or more joint K→M replacements while tracking newly returned ids, shared semantic sources, landing slices, and stale ids.
4. Re-read or refine generated nodes if needed.
5. Finish through the sole authoritative completion tool.

At each step, ask whether the model has exactly the information needed, whether two instructions can be interpreted differently, and whether the tool description and host behavior make the same promise. Resolve ambiguity by redesigning the complete prompt or protocol wording, not by adding a nearby exception.

## Validate the refactor

Review the full before-and-after rendered prompt, not just the source diff. Check task clarity, instruction ordering, token economy, terminology, tool-state transitions, stale-id handling, and termination behavior.

Run `pnpm check` after any prompt-facing change. Run `pnpm e2e` when changing prompt text, tool-facing wording, E2E instructions, validation, or landing behavior, then inspect the resulting tool-call sequence and dumped surface rather than accepting process exit alone.

If validation exposes a new failure, return to the complete-contract step. Do not stack another corrective sentence onto the last draft.

The work is complete only when the final prompt stands on its own as a coherent protocol, all model-facing descriptions agree with host behavior, production and E2E concerns remain separated, and the observed result supports the intended behavior.
