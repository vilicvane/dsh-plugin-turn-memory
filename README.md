# dsh-plugin-turn-memory

The active implementation is being rebuilt from the researched agreements in
[`design.md`](./design.md). The previous implementation is retained under
`obsolete/` for investigation only.

The current smoke slice implements D-002's isolated in-memory node editor and
four fork-only tools. It is disabled by default; the e2e overlay explicitly
enables it with a controlled turn-selection and two-pass prompt so those test
rules cannot become accidental product behavior.

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
