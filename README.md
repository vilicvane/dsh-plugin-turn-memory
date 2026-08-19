# dsh-plugin-turn-memory

The active implementation is being rebuilt from the researched agreements in
[`design.md`](./design.md). The previous implementation is retained under
`obsolete/` for investigation only.

The plugin now has two coordinated layers:

- completed-turn compression uses a parent `fork` and lands an N→M transcript rewrite;
- optional long-thought preprocessing starts asynchronous small-model recall hints as soon as each complete long reasoning block arrives, then gives successful hints to the normal main-model turn worker without replacing its raw parent context;
- long root turns receive a model-visible handoff reminder and can continue in a fresh turn after their completed-turn compression lands;
- optional root-session compaction provides `ctx.compaction`, processes a selected completed-history range through sequential main-model workers, and commits one standard durable checkpoint only after the host-owned working draft is complete.
- compressed image blocks can become durable `<memory-image ref="..." />` text references; `read_memory_image` reloads the original pixels on demand instead of placing them in every later model request.
- `read_session_history` can recover one completed turn's original append-only user, assistant, reasoning, and tool-result nodes when compressed memory omitted a costly detail.

The master plugin remains disabled by default. Completed-turn compression is on
when the plugin is enabled unless `turnCompression: false`. Session compaction
is separately opt-in through `sessionCompaction.enabled: true`.

Observed completed user-conversation turns receive a durable pending marker and
are recovered after an agent cold resume until their final landing exists. The
plugin does not backfill marker-free history merely because an old session is
opened after installation. UI-created lineage forks are user conversations and
participate normally; internal subagents do not. A legacy turn-memory no-op
whose current surface still contains raw reasoning is also migrated once.

## Install

Add the package to a DSH profile from GitHub:

```sh
dsh plugin --profile web add github:vilicvane/dsh-plugin-turn-memory
```

For local development, link the working tree instead:

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-turn-memory
```

Then register the plugin in the profile's `cordis.patch.yml`. For the `web`
profile this is normally `$DSH_HOME/profiles/web/cordis.patch.yml`. Restart
`dsh web` after installing the package or changing the profile configuration.

## Configuration

### Completed-turn compression only

This mode leaves the profile's existing whole-session compaction backend
untouched:

```yaml
- insert:
    - id: turn-memory
      name: dsh-plugin-turn-memory
      config:
        enabled: true
        turnCompression: true
        turnContinuation:
          enabled: true
          reminderIntervalNodes: 30
        thoughtHints:
          enabled: true
          provider: ollama
          model: your-small-model-id
          minimumChars: 16000
          maxTokens: 1024
          timeoutMs: 120000
        sessionHistory:
          enabled: true
          maxReadChars: 160000
          catalogTurns: 40
```

### Completed-turn and whole-session compaction

Only one plugin may provide `ctx.compaction`. Disable `compaction-basic` and
remove or disable any other session-compaction provider before enabling this
layer. Re-enable `command-compact` when the Web profile has disabled it; its
`/compact` command will call turn-memory's engine.

```yaml
- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: false

- insert:
    - id: turn-memory
      name: dsh-plugin-turn-memory
      config:
        enabled: true
        turnCompression: true
        sessionCompaction:
          enabled: true
          auto: true
          thresholdRatio: 0.8
          retainRatio: 0.16
          segmentTokens: 32000
          workerAttempts: 2
```

Set `turnCompression: false` in the same configuration to use only the
whole-session layer. Set `sessionCompaction.auto: false` to disable pressure
triggering while keeping manual `/compact` available.

The main tuning options are:

| Key | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `false` | Enables the plugin. |
| `turnCompression` | `true` | Compresses each completed root-session turn with a main-model fork, then fresh same-model recovery workers when needed. |
| `turnWorkerAttempts` | `3` | Consecutive failed workers allowed without an accepted replacement. Every successful replacement resets this budget. |
| `turnContinuation.enabled` | `true` | Lets a long root turn explicitly hand off, end, compress, and resume as a new turn. |
| `turnContinuation.reminderIntervalNodes` | `30` | Open-turn surface-node interval for one-shot continuation reminders: 30, 60, 90, and so on. |
| `thoughtHints.enabled` | `false` | Preprocesses complete long reasoning blocks with a configured auxiliary model before normal turn compression. |
| `thoughtHints.provider` | required when enabled | Provider route for the auxiliary one-shot request. |
| `thoughtHints.model` | required when enabled | Model id for the auxiliary one-shot request. |
| `thoughtHints.minimumChars` | `16000` | Minimum raw reasoning-block character count that starts a hint request. |
| `thoughtHints.maxTokens` | `1024` | Maximum output tokens for one compact recall-index response. |
| `thoughtHints.timeoutMs` | `120000` | Per-block auxiliary request timeout; timeout degrades to no hint. |
| `sessionHistory.enabled` | `true` | Exposes the read-only `read_session_history` fallback over the calling session's append-only completed turns. |
| `sessionHistory.maxReadChars` | `160000` | Maximum original-turn characters returned per read; larger turns are paged by `offset`. |
| `sessionHistory.catalogTurns` | `40` | Default number of recent completed turns listed when `turn` is omitted. |
| `previewChars` | `120` | Characters shown for each node in the turn catalog. |
| `maxReadChars` | `30000` | Maximum text returned by a turn-node read. |
| `surfaceDumpDir` | plugin `.tmp/` | Directory receiving the latest folded-surface snapshot for each session. |
| `sessionCompaction.enabled` | `false` | Registers turn-memory as the profile's `ctx.compaction` provider. |
| `sessionCompaction.auto` | `true` | Enables automatic compaction under token pressure. |
| `sessionCompaction.thresholdRatio` | `0.8` | Context-window ratio at which automatic compaction starts. |
| `sessionCompaction.retainRatio` | `0.16` | Approximate newest-history share kept outside the selected compaction range. |
| `sessionCompaction.retainTokens` | unset | Absolute alternative to `retainRatio`; do not set both. |
| `sessionCompaction.segmentTokens` | `32000` | Approximate source-token budget assigned to each sequential worker. |
| `sessionCompaction.workerAttempts` | `2` | Consecutive failed workers allowed per segment without an accepted revision. Every successful replacement resets this budget. |
| `sessionCompaction.workerMaxTokens` | `8192` | Output-token limit for each session worker. |
| `sessionCompaction.workerTimeoutMs` | `300000` | Timeout for each worker attempt. |
| `sessionCompaction.compactionRetries` | `1` | Additional pressure-compaction passes allowed when a successful checkpoint still leaves the surface above `thresholdRatio`. |

Each session segment first uses the parent's provider/model through `fork`. If it stops without an authoritative finish, continuation workers use the same main model through fresh `spawn`, with the assigned canonical source and accepted host-owned revision embedded in the prompt. A provider error, timeout, max-token stop, or missing finish consumes the budget only when that worker produced no accepted revision. Turn, session, and thought-hint prompt files are read for each new request, so prompt edits do not require a Web restart.

When thought hints are enabled, each root-session `assistant/chunk` reasoning `block-end` at or above `minimumChars` immediately starts an independent `ctx.llm.stream()` call. The model sees only the fixed `prompts/thought-hints.md` system prompt followed by one user message containing the raw reasoning block. Several blocks may run concurrently. At durable `turn/end`, compression waits for the calls that belong to assistant messages actually present on that turn's current surface; a cold resume regenerates missing calls from those durable reasoning blocks. Failed or empty hints are omitted and never block compression because the parent fork still inherits the complete original reasoning. Hints are advisory recall indexes only, are never persisted as transcript nodes, and every original assistant node carrying reasoning must still be rewritten before landing.

At each multiple of `turnContinuation.reminderIntervalNodes` reached by one root turn, its dynamic runtime context gives the model a short first-person `<assistant-self-check>` to stop, summarize the handoff, and call `continue_after_turn_compression`. This remains plugin context rather than a fabricated durable assistant message. The model may keep the current turn only when the whole task will finish in the next few actions; an in-progress atomic mutation is finished before handing off. The counter includes append-origin model-visible messages in the open turn and excludes replaceable runtime snapshots. The notice includes the current node count and estimated token size of the entire canonical context. Durable runtime snapshots remember which milestones were already shown, including across a restart. The successful durable native tool pair or Code Mode sub-dispatch records completed progress, current state, and exact next work, then concludes the turn. The plugin first lands and flushes normal completed-turn compression, then submits an automatic plugin-sourced follow-up as a separate ordinary turn. If compression has not succeeded, continuation does not start; cold-resume recovery can finish the missing compression and dispatch the still-pending request without duplicating an already inserted follow-up.

The plugin exposes `read_memory_image` to the main conversation and both compression-worker types when the profile has an attachment store. Compression retains the content-addressed attachment id rather than a local path, and the tool accepts only ids that really occur in the current session or its active root parent. The original pixels are loaded only for the tool request and only when the active model declares image input.

The main tool catalog also exposes `read_session_history` by default. With no `turn` it lists recent completed turns and their visible/reasoning sizes; with `turn=<n>` it reads that turn's original append-only message nodes, including reasoning shadowed by later surface replacement. Reads are limited to the calling agent's own session and are paged by character offset. This is an on-demand recovery path: it does not restore raw history to the standing surface or make it part of every request.

Provider-confirmed context overflow has a fixed one-shot recovery policy: compact once and replay the failed main-model request only after a durable surface replacement was committed. If that replay also overflows, the provider error is preserved rather than starting another compaction loop. This is independent of `sessionCompaction.compactionRetries`, which controls additional successful pressure compactions when one checkpoint still leaves the session above the configured threshold.

## Verification workflow

Run the fast deterministic checks after every edit:

```bash
pnpm check
```

Run the real end-to-end smoke when the change touches plugin wiring, prompts,
tools, surface landing, or persistence:

```bash
pnpm e2e
```

Run the dedicated session-compaction E2E after changing pressure selection, segmentation, session tools, worker orchestration, checkpoint rendering, or the compaction transaction:

```bash
pnpm e2e:session
```

It disables the stock backend in the test overlay, creates three completed turns, injects the same post-turn assistant replacement produced by turn-memory, and first proves that upstream token-meter rejects that lifecycle shape. It then forces the first two turns into separate segments and calls the custom engine manually through its canonical-surface pricing fallback. With a one-failure budget, the first segment's fork is deliberately stopped after an accepted mutation; the test requires a fresh-spawn continuation to finish it, then requires the next segment to begin with a fork. Finally it verifies standard event adjacency, checkpoint provenance, the untouched retained tail, persistence, and a cold resume of the exact session.

When production prompt behavior changes, also run the qualitative steer
regression:

```bash
pnpm e2e:prompt
```

Repeat the same independent real-model scenario to measure observed stability:

```bash
TURN_MEMORY_PROMPT_EVAL_RUNS=3 pnpm e2e:prompt:repeat
```

The repeat wrapper retains every session and surface path, then reports the
pass rate and a Wilson 95% confidence interval under `.tmp/`.

Run the broader production-prompt matrix to cover typo consolidation, a genuine
evidence-driven objective change, and implementation-detail retention:

```bash
TURN_MEMORY_PROMPT_EVAL_RUNS=2 pnpm e2e:prompt:matrix
```

Every scenario performs real parent work, automatic turn compression, a cold
resume, full surface replay, and `sessionQuery` comparison. The matrix accepts
variable valid node counts but requires causal user/assistant boundaries and
scenario-specific continuation details. It fingerprints the production prompt,
renderer, editor, and plugin entry before and after each session so concurrent
edits fail the run instead of mixing prompt versions. Use
`TURN_MEMORY_PROMPT_EVAL_SCENARIOS=goal_change` to isolate one scenario.

This creates a real multi-step turn whose first `/repo` attempt fails and whose
later user steer says `playground`. Unlike the deterministic smoke protocol, it
uses the production compression prompt and requires the two user messages to
become one corrected intent whose provenance includes both sources. Assistant
work may remain in more than one semantic node, but together it must retain both
the failed detour and the final 6-type/9-device conclusion. It checks live folding, persistence,
cold loading, and session-query projection, then writes
`.tmp/prompt-eval-surface-<session-id>.json` for inspection.

The e2e workflow uses the dedicated `~/.dsh/profiles/test-turn-memory` profile
and the configured real model. It creates a fresh parent session, forces a
multi-node tool turn, intentionally leaves its live `turn/end` uncompressed,
flushes persistence, destroys the agent, and cold-resumes the same session.
The recovery scan must then start the missed compression. The runner interrupts
its first worker after an accepted `n* -> r*` mutation and verifies that a
fresh-spawn recovery worker continues those `r*` nodes through the final rewrite. It checks live
`foldSurface()` and `deriveMessages()`, flushes, cold-resumes a second time, and
verifies that durable recovery detection neither duplicates nor changes the
replacement identities. Success ends with
`E2E_RESULT=PASS`, prints the retained test session id, and writes the exact
`sessionQuery.readSurface()` snapshot to
`.tmp/e2e-surface-<session-id>.json`. The `E2E_SURFACE_PATH` output contains
its absolute path for direct inspection.

The runner requests shutdown through DSH's bounded `appExit` service rather
than calling `process.exit()`, so persistence and plugin teardown are drained.

Every enabled turn-memory instance also flushes and writes its complete folded
surface after a successful replacement. By default the latest snapshot for each
session is written to `.tmp/e2e-surface-<session-id>.json` beside this plugin;
`surfaceDumpDir` changes the destination but leaving it unset does not disable
the dump.
