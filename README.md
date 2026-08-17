# dsh-plugin-turn-memory

The active implementation is being rebuilt from the researched agreements in
[`design.md`](./design.md). The previous implementation is retained under
`obsolete/` for investigation only.

The plugin now has two coordinated layers:

- completed-turn compression uses a parent `fork` and lands an N→M transcript rewrite;
- optional root-session compaction provides `ctx.compaction`, processes a selected completed-history range through sequential main-model workers, and commits one standard durable checkpoint only after the host-owned working draft is complete.

The master plugin remains disabled by default. Completed-turn compression is on
when the plugin is enabled unless `turnCompression: false`. Session compaction
is separately opt-in through `sessionCompaction.enabled: true`.

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
| `turnCompression` | `true` | Compresses each completed root-session turn with a forked main-model worker. |
| `previewChars` | `120` | Characters shown for each node in the turn catalog. |
| `maxReadChars` | `30000` | Maximum text returned by a turn-node read. |
| `surfaceDumpDir` | plugin `.tmp/` | Directory receiving the latest folded-surface snapshot for each session. |
| `sessionCompaction.enabled` | `false` | Registers turn-memory as the profile's `ctx.compaction` provider. |
| `sessionCompaction.auto` | `true` | Enables automatic compaction under token pressure. |
| `sessionCompaction.thresholdRatio` | `0.8` | Context-window ratio at which automatic compaction starts. |
| `sessionCompaction.retainRatio` | `0.16` | Approximate newest-history share kept outside the selected compaction range. |
| `sessionCompaction.retainTokens` | unset | Absolute alternative to `retainRatio`; do not set both. |
| `sessionCompaction.segmentTokens` | `32000` | Approximate source-token budget assigned to each sequential worker. |
| `sessionCompaction.workerAttempts` | `2` | Attempts allowed per segment; later attempts can use a fresh same-model worker. |
| `sessionCompaction.workerMaxTokens` | `8192` | Output-token limit for each session worker. |
| `sessionCompaction.workerTimeoutMs` | `300000` | Timeout for each worker attempt. |

Each session segment first uses the parent's provider/model through `fork`. If that cannot run near context pressure, later attempts use the same main model through fresh `spawn`, with the assigned canonical source embedded in the prompt. Both prompt files are read for each new worker, so prompt edits do not require a Web restart.

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

It disables the stock backend in the test overlay, creates three completed turns, injects the same post-turn assistant replacement produced by turn-memory, and first proves that upstream token-meter rejects that lifecycle shape. It then forces the first two turns into separate segments, calls the custom engine manually through its canonical-surface pricing fallback, asserts that both workers use `fork`, verifies standard event adjacency, checkpoint provenance, and the untouched retained tail, then flushes and cold-resumes the exact session.

When production prompt behavior changes, also run the qualitative steer
regression:

```bash
pnpm e2e:prompt
```

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
multi-node tool turn, waits for the turn-end fork to perform `n* -> r1 -> r2`,
lands the actual replacement, checks live `foldSurface()` and
`deriveMessages()`, flushes persistence, destroys the live agent, cold-resumes
the same session, and repeats the projection checks. Success ends with
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
