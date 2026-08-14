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

## Summary format (version 3)

Each checkpoint is a single user message:

    <turn-summary turn="12" version="3">
    ## Timeline
    - [chronological entries: user requests, decisions, discoveries, fixes]
    ## Current State
    - [what stands when the turn ends]
    ## Open Questions and Pending Input
    - [pending questions, reproduced VERBATIM]
    ## Next Step
    - [the single next action, or (none)]
    </turn-summary>

Marking rules:

- Superseded ideas, methods, and conclusions carry a leading [outdated]
  marker; when a turn invalidates something from an earlier summary, it names
  that turn.
- Untested assumptions carry a leading [assumption] marker.
- User wording, commands, paths, identifiers, and error strings are quoted
  verbatim wherever wording matters.
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

debug writes pipeline traces to $DSH_HOME/turn-memory-debug.log.

## Behavior notes

- Summaries are best-effort. A failed, timed-out, or cancelled summary fork
  leaves the turn raw; step 2 of the plan then falls back to the raw
  transcript for that turn.
- Turns that experienced mid-turn compaction are not replaced (the surface
  already carries a checkpoint for part of the turn).
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

They appear in the skill catalog as soon as the plugin loads. Project-level
skills override them; user-level file skills with the same names are
shadowed.

## License

MIT
