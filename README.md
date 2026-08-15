# dsh-plugin-turn-memory

Turn-granular context memory for DeepSeek Harness: step 1 of a two-step
context-compression plan.

When a root session's turn completes, the turn is only marked pending — no
summary runs yet. On the next turn, the runtime context carries a pending
notice and the main agent itself — the current context, with the user's new
message in view — composes the previous turn's whole-turn checkpoint
following the bundled dsh-compact-turn skill, then compacts that turn with
compact_turn(turn, summary). The replacement covers the turn's whole span,
its own user message included, so the newest user message always stays
verbatim. A one-shot fork (same model as the conversation, sharing its warm
request prefix) writes the summary only as a fallback when the main agent
leaves a turn unsummarized for a whole turn. Raw events remain in the
append-only log for replay and recall.

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

The compact_turn tool lets the model compact proactively during a long turn:
it replaces the completed part of the current turn (everything after the
turn-starting message, up to the current step) with one checkpoint, keeping
the turn-starting message and the current step verbatim. With the optional
turn argument it compacts a completed previous turn whole instead — the
span includes that turn's own user message, so the checkpoint must preserve
its request verbatim; this is the call the pending notice asks for. The
checkpoint text is composed by the current context itself — the composing
rules live in the bundled dsh-compact-turn skill and the text arrives as
the tool's summary argument — so no fork or subagent summarizes the span.
For the current-turn mode the tool validates the range (root session,
tool-pair balance) and runs exclusively so the compaction transaction never
races another tool call; the transaction itself — lock, whole-surface
stability, shrink check, durability — stays in the mounted compaction
backend through compactRegionWithSummary, and backends without that entry
summarize the range themselves. The whole-turn mode reuses the same
replacement path as the fallback fork (turn-memory marker checkpoint, no
compaction transaction). Session compaction keeps its own cheap-model
summarizer; the two never mix.

A conditional tail reminder backs it up: once the current turn spans more
than reminderNodeThreshold surface nodes (default 30, counted by nodes, not
tokens), the end-of-context runtime snapshot carries one stable line nudging
the model toward compact_turn; at 1.5x the threshold the line escalates to a
direct warning. Below the threshold the reminder contributes nothing — zero
tokens, zero noise — and it disappears on its own once a compaction lands.

## Summary format (version 4)

Each checkpoint is a single user message whose body is ONE flowing timeline —
no section headers, no forms:

    <turn-summary turn="12" version="4">
    - [one entry per user request, decision, discovery, fix, or meaningful
      outcome, in the order they happened]
    - [tail entries naturally carry current state, pending input, next step]
    </turn-summary>

Marking rules:

- Hindsight is written in natural language, not bracket tags: when a later
  development proves an earlier entry wrong, the correction is annotated
  inline at the point it went wrong — "I thought X might work. (It later
  turned out wrong.)" — and stays beside the entry it revises. Assumptions
  are stated as they were felt at the time; later corrections are
  authoritative over earlier entries.
- Whatever keeps intuition about the current context is preserved verbatim:
  user wording and emphasis, the assistant's own commitments and offers, and
  any phrasing later turns are likely to refer back to — plus commands,
  paths, identifiers, and error strings.
- Read-in material (code, docs, config, output) is preserved as paths, not
  content: short key snippets (a critical line, a value) may be inline, but
  anything longer is recorded as the exact path plus one line saying what it
  is and why it matters — re-read the file with the read tool when the
  content is needed again, since copied text goes stale.
- Once the checkpoint lands, it is the only trace of the turn the main
  context sees: the original text can only be recovered with an expand_turn
  recall (or by re-reading files), each costing tokens and time. Keep
  whatever a future turn is likely to reference, verify, or continue — a
  line kept now is cheaper than a recall later.
- The message that started the turn is reproduced verbatim as the first
  timeline entry; when it is long, a placeholder tag
  <verbatim kind="turn-prompt"/> takes its place and the harness swaps the
  tag back to the original message when the checkpoint lands. The tag saves
  output tokens, never omits content.
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
    lib/bounds.ts   pure span-boundary logic for compact_turn
    lib/routing.ts  pure agentic-recall age routing
    test/*.test.ts  node:test unit tests for the lib modules

Run both checks after edits, then restart per the dsh-web-restart skill:

    pnpm test        # unit tests (node --test, type stripping)
    pnpm typecheck   # tsc --noEmit

tsconfig enforces erasableSyntaxOnly (no enums/namespaces — node's type
stripper rejects them) and allowImportingTsExtensions (imports spell out the
.ts extension, which is what the stripper requires). The lib/ modules are
fully strict-typed; the entry file consumes the harness runtime structurally
and is typed incrementally.

## Config

All keys optional, with defaults:

    summaryTimeoutMs: 120000
    recallTimeoutMs: 180000
    cheapProvider: deepseek-official
    cheapModel: deepseek-chat
    cheapMaxTokens: 8192
    recallRecentWindowMs: 7200000
    maxRawChars: 500000
    toolResultCapChars: 20000
    maxRecallDepth: 4
    debug: false
    reminderNodeThreshold: 30
    prefixDumpDir: ''

debug writes pipeline traces to $DSH_HOME/turn-memory-debug.log.
reminderNodeThreshold is the surface-node count of the current turn that
triggers the compact_turn tail reminder (second tier at 1.5x).
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

- Summaries are best-effort. If the main agent leaves a turn unsummarized
  for a whole turn, a fallback fork summarizes it (one turn late); a failed,
  timed-out, or cancelled fork leaves the turn raw and step 2 of the plan
  falls back to the raw transcript for that turn.
- A turn that experienced mid-turn compaction (proactive compact_turn or
  automatic pressure) is still replaced at its end: the span includes the
  turn's own compaction checkpoints, so the final turn summary converges the
  mid-turn checkpoint and the tail into one record.
- The replacement is a user/message with the turn-memory source marker
  (turn number, summary id, format version). No custom session event type
  is introduced, so logs stay loadable by unmodified harnesses.
- Restart recovery: when a root agent is (re)created, the last completed
  turn that has no summary checkpoint is marked pending again, and the
  resumed main agent composes its summary at the start of the next turn
  (non-blocking). Older gaps stay raw by design.
- Only root sessions are summarized; subagent sessions are ignored.
- Requires the fork and spawn subagent providers for the fallback fork and
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
- dsh-compact-turn — how to compose the compact_turn checkpoint for the
  completed part of the current turn and for whole completed turns; read it
  before every proactive compaction, then pass the text as the tool's
  summary argument.

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
