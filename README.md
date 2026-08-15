# dsh-plugin-turn-memory

Turn-granular context memory for DeepSeek Harness: step 1 of a two-step
context-compression plan.

Every time a root session's turn completes, a one-shot fork (same model as the
conversation, sharing its warm request prefix) writes an independent flowing
summary of that turn alone. At the pre-step of the next user-initiated turn,
each summarized turn is replaced on the model-visible surface by its summary
checkpoint. The newest user message always stays verbatim, and the raw events
remain in the append-only log for replay and recall.

The expand_turn tool recalls a turn's full transcript in three modes:

- fork — the main model continues from the conversation state at that turn,
  with the warm request prefix; best for deep questions about a recent turn.
- subagent — a cheap model reads the turn's full text and answers a targeted
  question or produces a directed summary.
- raw — the turn's full text is returned directly into the conversation;
  very large turns are truncated; last resort.

The model picks the mode itself (default auto routes recent turns to fork and
older turns to subagent).

The compact_turn tool lets the model compact proactively during a long turn:
it replaces the completed part of the current turn (everything after the
turn-starting message, up to the current step) with one checkpoint, keeping
the turn-starting message and the current step verbatim. The checkpoint text
is composed by the current context itself — the composing rules live in the
bundled dsh-compact-turn skill and the text arrives as the tool's summary
argument — so no fork or subagent summarizes the span. The tool validates
the range (root session, tool-pair balance) and runs exclusively so the
compaction transaction never races another tool call; the transaction
itself — lock, whole-surface stability, shrink check, durability — stays in
the mounted compaction backend through compactRegionWithSummary, and
backends without that entry summarize the range themselves. Session
compaction keeps its own cheap-model summarizer; the two never mix.

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
- Read-in material (code, docs, config, output) that the turn relied on or
  future turns will likely need is preserved verbatim enough to avoid
  re-reading, each passage with one line saying why it matters.
- Long verbatim passages (roughly over 800 characters) become placeholder
  tags — <verbatim kind="turn-prompt"/> for the message that started the
  turn, <verbatim kind="tool-result" callId="CALL_ID"/> for a tool result —
  and the harness replaces every tag with the original text when the
  checkpoint lands. Tags save output tokens, never omit content.
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

## Config

All keys optional, with defaults:

    summaryTimeoutMs: 120000
    recallTimeoutMs: 180000
    cheapProvider: deepseek-official
    cheapModel: deepseek-chat
    cheapMaxTokens: 4096
    recentTurnThreshold: 3
    maxRawChars: 200000
    toolResultCapChars: 20000
    maxRecallDepth: 4
    debug: false
    reminderNodeThreshold: 30

debug writes pipeline traces to $DSH_HOME/turn-memory-debug.log.
reminderNodeThreshold is the surface-node count of the current turn that
triggers the compact_turn tail reminder (second tier at 1.5x).

## Behavior notes

- Summaries are best-effort. A failed, timed-out, or cancelled summary fork
  leaves the turn raw; step 2 of the plan then falls back to the raw
  transcript for that turn.
- A turn that experienced mid-turn compaction (proactive compact_turn or
  automatic pressure) is still replaced at its end: the span includes the
  turn's own compaction checkpoints, so the final turn summary converges the
  mid-turn checkpoint and the tail into one record.
- The replacement is a user/message with the turn-memory source marker
  (turn number, summary id, format version). No custom session event type
  is introduced, so logs stay loadable by unmodified harnesses.
- Restart recovery: when a root agent is (re)created, the last completed
  turn that has no summary checkpoint is re-summarized once (recovery fork,
  non-blocking for the next message). Older gaps stay raw by design.
- Only root sessions are summarized; subagent sessions are ignored.
- Requires the fork and spawn subagent providers (both ship with
  @deepseek-ai/dsh-base).

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
  completed part of the current turn; read it before every proactive
  compaction, then pass the text as the tool's summary argument.

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
