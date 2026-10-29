# Phase 07.12 — Deferred items

Out-of-scope findings logged by executors (not fixed in the plan that found them).

## From 07.12-08

- **Closed (orchestrator, `43f3b4cc`).** `cli.test.ts` › "ocw-runtime run reads ~/.ocw/service.env" › "a group- or
  world-readable file is refused…" was intermittent: `run()` installed its SIGTERM handler only after
  `daemon.start()` resolved, so a SIGTERM in that window ended the process with the default action. `run()` now
  installs the signal handlers before the daemon starts.
- **Closed (orchestrator, `0d5f9f4e`).** `cli.test.ts` › "ocw-runtime updates (07.11)" › "daemon running: status
  prints…" failed under load: it read the updates status before the daemon's first version probe had finished. The
  test now waits for the first probe.

## From 07.12-11

None open. Two gate findings were fixed at their source (see `07.12-11-SUMMARY.md`): the doctor's `updates` check
now reports the running daemon's level, and the served runtime's manifest names its source commit on compose and
gate builds.
