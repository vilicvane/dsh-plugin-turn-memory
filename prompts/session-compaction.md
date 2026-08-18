# Session transcript compaction

Integrate assigned segment `{{assignedSegmentId}}` of {{segmentCount}} into the host-owned working checkpoint. Produce continuation memory: a shorter chronological user-assistant transcript that preserves enduring interaction, reasoning history, and unresolved state. Do not write a retrospective report.

## Select by future value

Preserve causal order, attribution, and epistemic status. Retain information that would be costly to reconstruct:

- human goals, corrections, constraints, preferences, and decisions;
- inspirations, discoveries, and hypotheses with their original uncertainty;
- trials and detours with what they proved, ruled out, or changed;
- external results, rationale, bounded conclusions, and unresolved questions.

Compress repetitive execution, adjacent working fragments, progress chatter, stale runtime snapshots, and instructions whose only purpose was to elicit an already-recorded reply. When transient context caused a failure or decision, retain the consequence and relevant condition rather than the entire scaffold.

A source node with `kind=user` is not necessarily human input. Use `origin`: `human` is actual user intent, while `plugin:*` may be injected context or an earlier checkpoint. Never attribute runtime or plugin scaffolding to the human. A later result may resolve an earlier hypothesis, but do not rewrite earlier uncertainty as if it never existed. Use only assigned canonical source and current working memory.

## Preserve lazy image memory

Canonical `<memory-image ref="..." ... />` markers are recoverable references to original image attachments whose pixels are intentionally absent from ordinary checkpoint requests.

- Preserve every marker's exact `ref` identity somewhere in the generated chronological memory; host validation rejects omissions.
- Retain useful existing visual observations as text. Call `read_memory_image` only if the assigned source cannot be compressed faithfully without inspecting the pixels again.
- Keep a marker associated with the human interaction or evidence it belongs to. Do not reinterpret it as an observation, invent a new ref, or expand it into an attachment path.

## Work from the current revision

This worker runs in `{{workerMode}}` mode. A fork inherits the parent's completed conversation, but canonical source tools remain authoritative when post-turn replacement wording differs. A fresh worker has no inherited parent history, so its complete assigned source is embedded below. Both modes edit the same host-owned checkpoint.

The checkpoint begins with one pending placeholder per segment. Earlier workers replace placeholders with `m*` user/assistant nodes:

- `pending`: the segment placeholder still needs its first rewrite;
- `editing`: an earlier worker left accepted mutations and this worker must continue them;
- `done`: the segment was authoritatively finished.

Every mutation names the exact integer revision, returns a new revision and new node ids, and makes selected ids stale. Mutation results show only a local neighborhood; use catalog, read, or search for other current memory. Future placeholders are read-only.

Global segment directory:

{{segmentCatalog}}

Assigned canonical source-node directory:

{{assignedSegmentDirectory}}

Recent causal handoff from current working memory:

{{workingHandoff}}

{{#if freshWorker}}
The fresh worker's complete assigned canonical source follows:

<assigned-source id="{{assignedSegmentId}}">
{{assignedSegmentSource}}
</assigned-source>
{{/if}}

## Integrate and finish

1. Understand the assigned segment from inherited or embedded source. Read exact source-node ids or continuous ranges only when necessary; one call may contain several ranges.
2. Inspect related working memory when the new segment resolves an earlier hypothesis, decision, or open thread. Use list, read, and search against the latest revision.
3. Call `replace_session_memory` on one current node or continuous range. First processing must include placeholder `p{{assignedSegmentIndex}}`; continuation must include generated coverage whose sources contain `{{assignedSegmentId}}`. You may include adjacent earlier memory when the new segment should merge or revise it, but never consume a future placeholder.
4. Emit ordered `user` and `assistant` semantic nodes. Consolidate boundaries with no continuing causal value; preserve meaningful decisions, corrections, and role attribution. Re-read and refine generated nodes when needed.
5. Verify source coverage, exact `<memory-image>` refs, chronology, and the latest revision. Call `finish_session_segment` with that revision. It is the only accepted success signal.

The host owns provenance, durable seqs, compaction events, checkpoint framing, token pricing, and final surface replacement. Ordinary assistant text, `DONE`, or natural completion does not submit the segment.
