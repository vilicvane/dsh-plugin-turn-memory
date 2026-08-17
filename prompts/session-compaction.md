# Session transcript compaction

Integrate assigned segment `{{assignedSegmentId}}` of {{segmentCount}} into the host-owned working checkpoint. Build continuation memory: a shorter chronological transcript that lets the parent continue with the enduring interaction, reasoning history, and unresolved state intact. Do not write a retrospective report.

## Select information by future value

Preserve user and assistant roles and the causal order between them. Compress repetitive execution and adjacent working fragments into semantic units. Retain information that would be costly to reconstruct:

- human goals, corrections, constraints, preferences, and decisions;
- inspirations, discoveries, and hypotheses with their original uncertainty;
- trials and detours with what they proved, ruled out, or changed;
- external results, decisions with rationale, conclusions with limits, and unresolved questions.

Omit content that was only scaffolding for the old request unless it changed the work or still constrains the future. Typical disposable material includes repeated logs, progress chatter, stale cwd/sandbox/approval/runtime snapshots, tool availability boilerplate, and instructions whose only purpose was to elicit an already-recorded reply. If transient context caused a failure or decision, preserve that consequence and the relevant condition, not the whole snapshot.

A source node with `kind=user` is not necessarily human input. Use its `origin`: `human` is actual user intent; `plugin:*` can be injected context or an earlier memory checkpoint. Never attribute plugin/runtime scaffolding to the human merely because its projected role is user.

A later result may resolve an earlier hypothesis, but do not rewrite earlier uncertainty as if it never existed. Do not invent facts or import content from outside the assigned canonical source and current working checkpoint.

## Understand the host-owned state

This worker runs in `{{workerMode}}` mode. A fork understands the parent's completed conversation, but its inherited prefix can predate post-turn replacements; the canonical source-node directory and read tool are authoritative whenever a preview is insufficient. A fresh worker has no inherited parent history, so its assigned source is embedded below. In both modes the host editor is authoritative.

The working checkpoint starts with one pending placeholder per segment. Earlier workers replace their placeholders with `m*` user/assistant memory nodes. The assigned segment can be:

- `pending`: its placeholder still needs its first rewrite;
- `editing`: an earlier worker made accepted mutations before stopping, so continue from those generated nodes;
- `done`: already authoritative and not assigned again.

Every mutation names the current integer revision. Success returns a new revision, new node ids, and a local neighborhood; replaced ids become stale. Use catalog, read, or search when that neighborhood is insufficient. Future segment placeholders are read-only.

Global segment directory:

{{segmentCatalog}}

Assigned canonical source-node directory:

{{assignedSegmentDirectory}}

Recent causal handoff from the working checkpoint:

{{workingHandoff}}

{{#if freshWorker}}
The fresh worker's complete assigned canonical source follows:

<assigned-source id="{{assignedSegmentId}}">
{{assignedSegmentSource}}
</assigned-source>
{{/if}}

## Edit and submit

1. Understand the assigned segment in the inherited conversation or embedded source. Read exact source-node ids or continuous ranges only when needed; one call may contain several ranges.
2. Inspect related working memory. Search or read older nodes when the new segment resolves an earlier hypothesis, decision, or open thread.
3. Call `replace_session_memory` on one current node or a continuous range. First processing must include placeholder `p{{assignedSegmentIndex}}`; continuation must include generated coverage whose sources contain `{{assignedSegmentId}}`. You may include adjacent earlier memory when the new segment should merge or revise it. Never consume a future placeholder.
4. Emit ordered `user` and `assistant` nodes. Boundaries represent meaningful interaction units, not mandatory alternation. Consolidate source boundaries that carry no continuing semantic value.
5. Re-read and refine generated `m*` nodes with the latest revision when needed.
6. Call `finish_session_segment` with the latest revision. This is the only accepted success signal.

The host owns provenance, durable seqs, compaction events, checkpoint framing, token pricing, and final surface replacement. Do not put that metadata in memory content. Ordinary assistant text, `DONE`, or natural turn completion does not submit the segment.
