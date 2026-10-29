# Phase 07.12 — Deferred items

Out-of-scope findings logged by executors (not fixed in the plan that found them).

## From 07.12-08

- **`cli.test.ts` › "ocw-runtime run reads ~/.ocw/service.env" › "a group- or world-readable file is refused…"
  is intermittent.** It failed once in 7 local runs (fast, about 210 ms) and passed on every rerun. Likely cause:
  `run()` in `apps/local-runtime/src/cli.ts` installs its SIGTERM handler only after `daemon.start()` resolves, while
  the test sends SIGTERM as soon as the control socket file exists. A SIGTERM in that window ends the process with
  the default action (exit code null, not 0). Fix candidates: install the signal handlers before `daemon.start()`, or
  have the test wait for the daemon's "started" log line. Not touched in 08 (plan 03's test and code).
- **`cli.test.ts` › "ocw-runtime updates (07.11)" › "daemon running: status prints…"** failed once under load and
  passed on every rerun, as plan 03 also recorded. Not touched.
