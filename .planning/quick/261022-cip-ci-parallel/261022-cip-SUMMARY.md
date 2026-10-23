---
phase: quick-261022-cip
plan: 01
status: complete
subsystem: ci
tags: [woodpecker, dind, ci, parallel, isolation]
requires: []
provides:
  - "Woodpecker workflows isolated per slot (compose projects, label namespaces, names, port blocks, dirs) so they can run in parallel on one dind"
  - "infra/ci/slot-reset.sh (own slot only), infra/ci/slot-lease.sh (one run per slot across pipelines)"
  - "ocw-ci:<commit> step images; concurrency-safe disk-budget.sh"
  - "verify/e2e/cell-smoke/sandbox on pull_request + manual only; push to main runs images + housekeeping"
affects: [".woodpecker/*.yaml", "infra/ci/", "scripts/e2e-isolated.sh", "scripts/sandbox-proof.sh", "infra/sandbox/test/", "infra/openclaw/test/run-container-smoke.sh", "e2e/"]
tech-stack:
  added: []
  patterns:
    - "CI slot: every Docker object and dir of a workflow run is ocw-ci-<slot>[-*]; its reset matches only that prefix"
    - "Liveness of a Woodpecker workflow = its wp_* workflow volume exists (and is younger than 150 min)"
key-files:
  created:
    - infra/ci/README.md
    - infra/ci/wp-lib.sh
    - infra/ci/slot-lease.sh
    - infra/ci/slot-reset.sh
    - infra/ci/fake-docker.mjs
    - infra/ci/slots.test.mjs
    - infra/ci/slot-lease.test.mjs
    - infra/ci/disk-budget.test.mjs
  modified:
    - .woodpecker/verify.yaml
    - .woodpecker/e2e.yaml
    - .woodpecker/cell-smoke.yaml
    - .woodpecker/sandbox.yaml
    - .woodpecker/images.yaml
    - .woodpecker/housekeeping.yaml
    - infra/ci/build-image.sh
    - infra/ci/disk-budget.sh
    - infra/ci/gvisor-dind.sh
    - infra/ci/smoke-reset.sh
    - scripts/e2e-isolated.sh
    - scripts/sandbox-proof.sh
    - scripts/e2e-env-parity.test.mjs
    - e2e/support/bot-tools.ts
  deleted:
    - infra/ci/e2e-reset.sh
decisions:
  - "Port blocks via the existing `pnpm setup:env --ports NN`: e2e-desktop 21, e2e-mobile 22, sandbox 24 (below 32768, clear of dind's 2375 and the fetch bad-port list)"
  - "Same-slot runs of different pipelines are serialized by a lease whose holder is alive while its Woodpecker workflow volume exists; a cancelled run is taken over at once"
  - "Step image tagged by commit (ocw-ci:${CI_COMMIT_SHA}) instead of a shared ocw-ci:local"
  - "images.yaml publishes nothing; it stays on push to main as a cached build check, with housekeeping"
metrics:
  duration: "~4 h (incl. waiting for the dind)"
  completed: 2026-10-22
actuals:
  tokens: 30000
  tasks: 6
  commits: 4
---

# Quick 261022-cip: Woodpecker workflows in parallel on one dind — Summary

**The Woodpecker workflows can now run side by side on the one `woodpecker-dind` daemon. Each heavy workflow, and
each e2e viewport, owns a slot: its compose projects, label namespaces, names, port block and directories never meet
another slot's. Each reset removes only its own slot's objects. A push to main now runs images and housekeeping only.
Two e2e stacks ran concurrently on one Docker daemon and passed. That proof ran on local Docker, because the CI dind
was never idle during the task.**

## Isolation scheme (`infra/ci/README.md`)

| Workflow | Slot | Compose projects | Ports | Namespaces / names | Dirs (`/home/ocw-ci`) |
|---|---|---|---|---|---|
| verify | `verify` | none | none fixed (testcontainers random, 32768+) | none | `ws/verify` |
| e2e desktop | `e2e-desktop` | `ocw-ci-e2e-desktop` | block 21: 2100 web, 2101 API, 2102 pg, 2103 redis, 2104 Garage, 2191 fake | none | `ws/e2e-desktop` |
| e2e mobile | `e2e-mobile` | `ocw-ci-e2e-mobile` | block 22: 2200-2204, 2291 | none | `ws/e2e-mobile` |
| cell-smoke | `cell-smoke` | none | none | names `ocw-ci-cell-smoke-*` | `ws/`, `tmp/cell-smoke` |
| sandbox | `sandbox` | `ocw-ci-sandbox`, `ocw-ci-sandbox-storage` | block 24: 2400/2401 runner web/API, 2402 pg, 2403 redis, 2491 fake, 2492 Garage, 2493 sandboxd | `ocw-ci-sandbox-{smoke-*,e2e,proof,gvisor}` | `ws/`, `tmp/sandbox`, `run/ocw-ci-sandbox-gvisor` |
| images, housekeeping | none | none | none | none | none |

- **Resets.** `infra/ci/slot-reset.sh` (replaces `e2e-reset.sh` and the CI use of `smoke-reset.sh`) removes only
  objects whose compose project, `ocw.namespace` or name is `ocw-ci-<slot>` or `ocw-ci-<slot>-*`. It never prunes. The
  next run of the same slot still cleans up after a cancelled run.
- **Leases.** `infra/ci/slot-lease.sh`: two pipelines (two open PRs) never run the same slot at once. A holder counts
  as alive while its Woodpecker workflow volume (`wp_*`) exists. A cancelled run is taken over at once. The repo
  already cancels the previous pipeline of the same PR.
- **Step image.** Each pipeline builds and uses `ocw-ci:<commit sha>`, so there is no shared `ocw-ci:local` tag to
  race on.
- **pnpm store.** It stays shared. pnpm's content-addressable store is safe for concurrent installs, and the global
  virtual store is off.
- **`disk-budget.sh`.**
  - Always: it removes only dangling images, plus containers, networks and volumes older than 3 h.
  - Only when no other workflow is running: tag clean-up, the unused-image prune and dropping the caches.
- **Testcontainers.** They use only random ports and no names, and run only in verify.
- **gVisor.** The nested gVisor daemon is named and labelled per slot.

## Push to main

verify, e2e, cell-smoke and sandbox run on `pull_request` and `manual` only. `images.yaml` publishes nothing (its
`:ci` tags stay on the dind). It stays on push to main as a cached build check, together with housekeeping. Housekeeping
now lists the other workflows as optional dependencies (`{name, optional: true}`, Woodpecker 3.19). The GitHub
`ci.yml` is unchanged: no parity test covers its triggers, and each of its jobs gets its own runner.

## Verification

| Check | Result |
|---|---|
| `node --test 'infra/ci/*.test.mjs' scripts/e2e-env-parity.test.mjs` | 34/34 (slots 15, slot-lease 7, disk-budget 3, parity 9) |
| Mutation checks | 5 of 5 caught: mobile block = desktop block → slots and parity fail; another slot's prefix in cell-smoke → 3 fail; reset matching `prefix*` without the dash → 5 fail; lease without the mutex → the concurrency test fails; the old `disk-budget.sh` → 3/3 fail |
| `pnpm verify` | green: 366 files, 5933 tests (lint, guard, typecheck, test) |
| `pnpm typecheck --force` | 10/10 |
| `woodpecker-cli lint` (v3.19.0) | all 6 valid; same warnings as before (`network_mode`, `runs_on`) |
| Commit states 1 and 2 | node tests green in a scratch worktree at each commit |

**Concurrent proof (local Docker, not the CI dind).**

- **Why not the dind.** Pipelines 51, 52, 53, 54 and 55 (PR #33) ran back to back for about 5 h. The dind was never
  idle, so nothing was run on it.
- **How it ran.** The `e2e` step of `e2e.yaml` was run as host processes, once per viewport and at the same time: block
  21 and block 22 on one Docker daemon, each with `slot-reset.sh`, `setup:env --ports` and its own compose project.
- **Results.**
  - Both stacks were healthy side by side.
  - `connectors.spec`, `mcp-servers.spec` and `chat.spec` passed on both viewports: 11 passed, plus 2 passed on a
    re-run. The 2 failures of the first run came from the harness (`CI=true` instead of `CI=woodpecker` for the
    superuser guard), not from the change.
  - The connector specs use the derived `fake-mcp:2191` / `fake-mcp:2291`.
  - `slot-reset` for e2e-desktop, verify, cell-smoke and sandbox, run while mobile was up: mobile stayed healthy, and
    `chat.spec` passed on it right after.
- **Cleanup.** 0 `ocw-ci-*` containers, volumes or networks are left. The running containers are the same as before
  (the demo included), and the ports are free.

## Commits

- `b969bd4d` refactor(e2e): the smokes', proof's and isolated runner's names and ports can be set by the caller
- `2c02d01a` ci: each Woodpecker workflow runs in its own slot so several can share the dind daemon
- `52b58541` ci: the heavy workflows run on pull requests and manual runs, not again on push to main

## Deviations

1. **[Rule 2] Same-slot lease across pipelines.** This was not asked for. Without it, two open PRs would share a slot's
   ports, and one PR's reset would remove the other's objects.
2. **[Rule 1] The e2e specs hard-coded `fake-mcp:4291`.** The host now takes its port from `OCW_E2E_FAKE_URL`.
3. **[Rule 3] The CI dind proof was not run.** The dind was never idle. The kit to run it by hand (step scripts
   generated from the YAML) is ready.

## Open

- **First real parallel run.** After `WOODPECKER_MAX_WORKFLOWS=3`, the first real parallel run is the evidence still
  owed. Watch it for slot waits, host load and disk.
- **Rebase.** The branch is based on `23d583de`. PR #33 has moved on to `ed77540b`, so rebase before merging.

## Self-Check: PASSED
