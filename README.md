# dsh-plugin-turn-memory

Turn-granular context memory for DeepSeek Harness: step 1 of a two-step
context-compression plan.

When a top-level (root or resumed fork) session's turn completes, the plugin
writes the turn's raw transcript into a temporary draft file and spawns a
fork of the main session — a subagent whose context replays the completed
turns verbatim, including the turn being summarized. The draft is seeded
with the turn's full transcript already in the checkpoint's tag format:
numbered segments — verbatim <user-steer:N>/<assistant:N> content, raw
process inside <working:N> blocks — each id unique so the fork can target
segments without reproducing their old content. Only real user input is a
<user-steer> segment: injected context (runtime snapshots, skill catalogs,
system reminders) lands in <working:N> under an [injected: ...] marker and
must be compressed to one line like the rest of the process. The fork compresses in
place: it shortens each <working:N> content with draft_replace_segment
(passing the bare new content, no tags or surrounding newlines — the tool
pads the tag lines itself; targeting by id from its context, never
re-reading the whole file;
draft_read_segment and draft_grep serve partial lookups) until it holds the
whole-turn checkpoint, replies DONE, and the plugin verifies the shape (same
segment sequence, verbatim segments byte-for-byte), reads the file back,
replaces the turn's span on the surface with that checkpoint, and deletes
the draft. The replacement covers the turn's span starting right after its
own starting user message — that message stays verbatim on the surface, so
the checkpoint never repeats it, and steer messages inside the span stay
verbatim in their own <user-steer> elements. The newest user message always
stays verbatim. Raw events remain in the append-only log for replay and
recall. The pre-compression transcript of the most recently summarized turn
is kept next to the draft at .dsh-turn-raw-<sessionId>-turn-<N>.md
(overwritten per turn) so the next turn can eyeball the landed checkpoint
against it and judge how well the fork summarized.

The expand_turn tool recalls a turn's full transcript in two modes:

- agentic — the model asks a question and the recall routes by the turn's
  age: recent turns (ended within recallRecentWindowMs, default 2h) use a
  fork whose context replays the completed turns verbatim — the target
  turn's full original text is already in that context, and the fork is
  cheap only while the provider's disk cache still holds the prefix units
  persisted when those turns ran; older turns use a subagent, where a
  cheap model reads the turn's full text and answers the targeted
  question.
- raw — the turn's full text is returned directly into the conversation;
  very large turns are truncated; the fallback when the agentic answer
  needs the full text.

The default mode is agentic; the time routing is internal to the tool.

There is no in-turn compaction. The compact_turn tool only takes a turn
argument and triggers the turn-end fork for that turn: it exists so the main
agent can re-trigger summarization when it notices a completed turn that is
still raw (for example after a restart). The replacement span starts right
after that turn's own starting user message, which stays verbatim on the
surface. Session compaction keeps its own cheap-model summarizer; the two
never mix.

## Summary format (version 5)

Each checkpoint is a single user message whose body is a sequence of role
tags in the order things happened — no root wrapper (the surface already
wraps the record as a turn-summary):

    <user-steer:1>steering message, verbatim</user-steer:1>
    <working:2>process between the messages, compressed in place</working:2>
    <assistant:3>user-facing output, verbatim</assistant:3>
    <working:4>…</working:4>
    <assistant:5>…</assistant:5>

    Segment ids are unique, ascending, and stable: the fork replaces a
    segment by id (draft_replace_segment) without reproducing old content.
    Each tag occupies its own line exactly — the parser matches line-start
    to line-end, so inline tag examples inside content never parse as
    segments.

Marking rules:

- Hindsight in natural language, not bracket tags: when a later development
  proves an earlier entry wrong, the correction stays beside the entry it
  revises ("I thought X might work. It later turned out wrong.");
  assumptions are stated as felt at the time, and later corrections are
  authoritative.
- Whatever keeps intuition about the current context is preserved verbatim:
  user wording and emphasis, the assistant's own commitments and offers, and
  phrasing later turns are likely to refer to — plus commands, paths,
  identifiers, and error strings.
- The checkpoint keeps the original order with no root wrapper (the surface
  already wraps the record as a turn-summary): the turn's starting user
  message stays verbatim on the surface before the checkpoint and never
  appears inside it; every steering message inside the span stays verbatim
  in its own <user-steer:N>…</user-steer:N> element, every user-facing
  assistant text output stays verbatim in its own <assistant:N>…</assistant:N>
  element at its original position, and only the intermediate process
  (reasoning, tool calls, tool results, routine checks) is compressed in
  place into a <working:N>…</working:N> element. The tags alternate in the
  order things happened and mark the speaker, so no prefixes, labels, or
  separate sections — the checkpoint reads like the conversation itself
  with the process shortened.
- Checkpoints already inside the span (a <turn-summary> block from a
  compressed earlier turn) are not covered-and-skippable: copy their
  fragments byte-for-byte into the new checkpoint at their original
  positions (hindsight annotations allowed), then summarize only the
  remaining content and append it in order — copying beats tightening, and
  omitting or rewriting already-summarized parts silently loses history.
- The structure tags appear only inside checkpoint text, never in live
  conversation output.
- Read-in material (code, docs, config, output) is preserved as paths, not
  content: short key snippets may be inline; anything longer is recorded as
  the exact path plus one line saying what it is and why — re-read with the
  read tool when the content is needed again, since copied text goes stale.
- Once the checkpoint lands, it is the only trace of the turn the main
  context sees: the original can only be recovered with an expand_turn
  recall (or by re-reading files), each costing tokens and time — a line
  kept now is cheaper than a recall later.
- Compaction machinery (compact_turn calls, node counts, replacement
  results, restart scheduling) never enters the checkpoint and is never
  repeated to the user; checkpoints keep substance only (root causes,
  decisions, fixes, artifacts).
- Reusable procedures are referenced by name (skill or script path) instead
  of being restated; the steps live in skills loaded on demand.

## Install

From GitHub:

    dsh plugin --profile web add github:vilicvane/dsh-plugin-turn-memory

From a local directory (development):

    dsh plugin --profile web add link:/path/to/dsh-plugin-turn-memory

Then append an insert row to the profile's cordis.patch.yml:

    - insert:
        - id: turn-memory
          name: dsh-plugin-turn-memory

Restart the profile app to load the plugin. Note for directory links: the
plugin depends on @deepseek-ai/dsh-tools; run pnpm install inside the plugin
directory once so that dependency resolves. Git/npm installs resolve
dependencies normally.

## Development (TypeScript)

The plugin is TypeScript with erasable-only syntax and has NO build step:
node (>= 23.6; this machine runs 24.x) executes the sources directly via
native type stripping, so the entry stays index.ts and the edit-reload loop
stays single-source.

    index.ts        plugin entry (structurally typed, incremental)
    lib/render.ts   pure turn-transcript rendering for the draft file
    lib/routing.ts  pure agentic-recall age routing
    test/*.test.ts  node:test unit tests for the lib modules

Run both checks after edits, then remind the user to restart dsh web
manually (no automatic restarts — see the dsh-web-restart skill):

    pnpm test        # unit tests (node --test, type stripping)
    pnpm typecheck   # tsc --noEmit

tsconfig enforces erasableSyntaxOnly (no enums/namespaces — node's type
stripper rejects them) and allowImportingTsExtensions (imports spell out the
.ts extension, which is what the stripper requires). The lib/ modules are
fully strict-typed; the entry file consumes the harness runtime structurally
and is typed incrementally.

## Config

All keys optional, with defaults:

    roundTimeoutMs: 180000
    recallTimeoutMs: 180000
    cheapProvider: deepseek-official
    cheapModel: deepseek-chat
    cheapMaxTokens: 8192
    recallRecentWindowMs: 7200000
    maxRawChars: 500000
    toolResultCapChars: 20000
    maxRecallDepth: 4
    debug: false
    prefixDumpDir: ''

debug writes pipeline traces to $DSH_HOME/turn-memory-debug.log.
roundTimeoutMs bounds each draft-file turn of the summary fork (the fork
keeps editing the draft across turns; a fresh turn starts when the previous
one settles, timed out, or was cancelled).
prefixDumpDir, when non-empty, makes every landed compaction replacement
append one block to request-prefix-<sessionId>.txt in that directory — one
accumulating file per session: the checkpoint
node and the first kept node after it — the last two nodes at the
replacement boundary — rendered the way their text reaches the front of
the next request. Blocks accumulate oldest-first, separated by a divider
line, so the file keeps every replacement boundary on record. A debug aid
for eyeballing where folded spans end and kept content begins.
recallRecentWindowMs is the agentic mode's recent-turn window: turns that
ended within it route to fork (whose context replays the completed turns
verbatim and is warm only while the provider's disk cache retains the
prefix units persisted when those turns ran), older ones to the
cheap-model subagent. The 2h default follows DeepSeek's documented
best-effort cache retention of "a few hours to a few days" (lower bound).

## Behavior notes

- Summaries are best-effort: the fork edits the draft file turn by turn
  until the draft is complete or the time budget runs out; a failed,
  timed-out, or cancelled fork leaves the turn raw and the draft file is
  deleted, so step 2 of the plan falls back to the raw transcript for that
  turn.
- The replacement is a user/message with the turn-memory source marker
  (turn number, summary id, format version, scope whole-turn). No custom
  session event type is introduced, so logs stay loadable by unmodified
  harnesses.
- Restart recovery: when a top-level agent is (re)created, the last completed
  turn that has no summary checkpoint is registered again and a summary fork
  is spawned for it right away. Older gaps stay raw by design.
- Turn-memory eligibility is decided by the durable session origin, not by
  runtime ownership: sessions whose origin is not subagent — the main
  session and forks, live or resumed — get the full turn-memory experience
  (registration and the summary fork). One-shot recall subagents
  (origin subagent) are excluded so their throwaway sessions never cost a
  fork.
- Requires the fork and spawn subagent providers for the summary fork and
  expand_turn recall (both ship with @deepseek-ai/dsh-base).

## Bundled skills

The plugin bundles its operational knowledge as runtime skills (rank 250),
registered when the plugin loads:

- dsh-web-restart — restarting the dsh web server after profile/plugin
  changes.
- dsh-session-log-inspect — inspecting session logs (zstd decompression,
  event vocabulary, surface replacement checks).
- dsh-turn-memory — this plugin's configuration, behavior, and known
  degradation paths.

They appear in the skill catalog as soon as the plugin loads. Project-level
skills override them; user-level file skills with the same names are
shadowed.

## Deployment on this machine

The two-step system's host wiring lives in `~/.dsh/profiles/web/cordis.patch.yml`
(compaction-basic disabled, command-compact re-enabled, turn-memory inserted
before replay-compaction). The shipped agent presets mount their own
compaction stack that host patches cannot reach; the personal preset
`~/.dsh/.agent-presets/vilicvane` (a fork of `code` / PTC 模式) removes it so
all compaction entry points resolve the replay fold. See
`dsh-plugin-replay-compaction`'s README and the preset's own README for the
details.

## License

MIT
