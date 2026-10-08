---
phase: 07-self-hosted-release
plan: 03
subsystem: infra
status: complete
tags: [compose, docker, gate, self-hosting, safety]
requires: []
provides:
  - "scripts/gate/lib.mjs: DEMO, gatePorts, assertSafe, acquireLock, createGateEnv, composeCmd, gateContext, withGateStack, ensureAdmin, teardownGateStack (+ demoSnapshot/diffDemo, disk/build-cache helpers)"
  - "scripts/gate/compose-gate.mjs: tracer CLI (--run-id, --keep, --attach <envFile>, --down <envFile>) and run(ctx) step"
  - "compose contract: ocw-<svc>:${OCW_IMAGE_TAG:-local}, include of infra/{caddy,observability,openbao}/compose.yaml, api pass-throughs, OCW_PUBLISH_ADDRESS"
affects: [07-06, 07-07, 07-08, 07-09, 07-10, 07-11]
tech-stack:
  added: []
  patterns:
    - "Every gate Docker call: assertSafe → docker with a minimal env (no inherited OCW_*/COMPOSE_*) → explicit --env-file and -p"
    - "Per-run image tag gate-<sha12>[-dirty]-<runId>; teardown removes only names carrying the run id"
    - "Build-cache records created by the run are pruned at teardown (shared/in-use/older records never touched)"
key-files:
  created:
    - scripts/gate/lib.mjs
    - scripts/gate/lib.test.mjs
    - scripts/gate/compose-gate.mjs
    - infra/compose.test.mjs
    - infra/caddy/compose.yaml
    - infra/observability/compose.yaml
    - infra/openbao/compose.yaml
  modified:
    - compose.yaml
    - compose.e2e.yaml
    - .dockerignore
decisions:
  - "Gate image tag carries the run id (gate-<sha>[-dirty]-<runId>), not just the sha, so teardown can never remove another run's images"
  - "Gate env binds api/web to 127.0.0.1 (OCW_PUBLISH_ADDRESS) and uses http://127.0.0.1:34xx public URLs"
  - "Gate refuses to start with less than 6 GB free on the Docker disk (OCW_GATE_MIN_FREE_GB) and prunes its own build cache (OCW_GATE_KEEP_BUILD_CACHE=1 keeps it)"
  - "Compose honours COMPOSE_PROJECT_NAME / COMPOSE_FILE / COMPOSE_PROFILES from --env-file (verified on v5.3.1); lib still passes -p and -f explicitly"
metrics:
  duration: "~3 h (including two full pnpm verify runs and six gate runs)"
  completed: 2026-10-08
actuals:
  tokens: 15100
  tasks: 2
  commits: 9
---

# Phase 7 Plan 03: Compose gate tracer and the anti-demo guard Summary

The whole self-hosted stack now builds from real images and boots in an isolated `ocw-gate-<id>` project on loopback
34xx ports. Every check passes (migrate exits 0, api `/health` 200, web `/login` 200, cell healthy, admin
setup/sign-in), and the stack is torn down with nothing left behind. The demo's `:local` images, containers and ports
are byte-for-byte unchanged. The tracer found no Dockerfile defect, so no Dockerfile was changed.

## Results

- **Harness and contract tests:** `node --test scripts/gate/lib.test.mjs infra/compose.test.mjs infra/garage/compose-garage.test.mjs`
  ran 31 tests: 31 pass, 0 fail, 0 skipped. That is 11 in lib, 15 in compose and 5 in garage.
- **Full `pnpm verify`:** exit 0, 193 test files and 2716 tests passed. Lint reports 4 warnings that were already there.
- **Gate verify command from the plan** (the `:local` diff around `node scripts/gate/compose-gate.mjs`): exit 0 and an
  empty diff. The no-leftover check (`docker ps -aq` / `docker volume ls -q --filter name=ocw-gate-`): exit 0.
- **Final run on HEAD `ce60157`** (tag `gate-ce60157c00b1-muyu8rzjf286`): 90 s in total. Build 49 s, up 29 s,
  teardown 4.4 s, build-cache prune 5.9 s (26 records). Every step was ok.
- **Six gate runs in total:** t1, a default run, a third run, keep1 (keep/attach/down), keep2 (the same cycle) and the
  final run. All passed. Build times ranged from 49 to 84 s on a warm cell cache and up from 29 to 53 s.
- **Image sizes** (`docker image inspect .Size`, content size in the containerd store):

| Image | Size |
| --- | --- |
| ocw-api | 216 MB |
| ocw-web | 95 MB |
| ocw-openclaw | 1203 MB (`docker images` shows the unpacked `ocw-openclaw:local` at 5.16 GB) |
| ocw-fake-model | 77 MB |

- **Demo `:local` image ids.** These were the same at session start and after every run:
  - `ocw-fake-model:local sha256:987d05d0f56d7658836ee0eea0143abf7a62e830b7974b23c236af7028755860`
  - `ocw-openclaw:local sha256:3ac11416d0d6ca9dd44f2e56ec95dbe624e0d480886064fa3f8090c4dbfaf92d`

  The `t3code-81d72154` containers (postgres, redis, garage), `ocw-demo-openclaw` and `ocw-demo-model` kept the same
  ids and states, and ports 3000/4000 did not change. `ocw-api:local` and `ocw-web:local` do not exist on this machine.
- **Docker disk:** 8.8 GB free at the start and 8.7 GB at the end. Nothing named `ocw-gate-*` is left: no container,
  volume, network, image, temp env dir or lock.

## Tasks

| Task | Commits |
| --- | --- |
| 1. Gate tracer (guard first, then compose, then build/up/health/teardown) | 52e88af (RED), 67a3fef, fc3f52e, b8043e7, e2a8142, 5ceb951, ce60157 |
| 2. Compose contract tests | c6f76ef (RED: 4 of 15 failed before fc3f52e) |

## Deviations from Plan

1. **[Rule 2 - Safety] The image tag includes the run id.** It is `gate-<sha12>[-dirty]-<runId>`, not `gate-<sha>`.
   The plan's own prohibition says nothing may be removed unless its name carries the run id. With a sha-only tag, a
   second run at the same commit would remove the images under a `--keep` stack. Commit 67a3fef.
2. **[Rule 2 - Safety] Docker runs with a minimal environment.** Docker only gets PATH, HOME, USER, TMPDIR, LANG and
   DOCKER_*. Process env beats `--env-file` in compose interpolation, so an exported `OCW_API_PORT=4000` or
   `COMPOSE_PROJECT_NAME` would otherwise redirect a gate stack onto the demo. Commit 67a3fef.
3. **[Rule 2 - Safety] Disk-free floor and build-cache cleanup.** These were not in the plan. Docker's disk sat at 95%
   (8.8 GB free), and one gate build leaves about 2.3 GB of BuildKit cache. The gate now refuses to start below
   6 GB free, and at teardown it prunes only the cache records it created. Shared, in-use and older records are never
   touched. Commits 67a3fef and 5ceb951; 5ceb951 fixes a fixed 3-pass loop that left the tails of long parent chains
   behind.
4. **[Rule 2] `DEMO.ports` also refuses 5432 and 6379.** The owner listed them as demo ports. This is stricter than the
   interface block and does not affect any 34xx block.
5. **[Rule 2] Additions beyond the plan's interface** (later plans need them):
   - `--down <envFile>` / `teardownGateStack`, which cleans up a `--keep` stack, including its build cache (ce60157).
   - The `admin` check step, which exercises `ensureAdmin` (setup, then sign-in).
   - `demo-untouched`, `ports-free` and `disk-free` steps.
   - Image sizes in the build step.
6. **`acquireLock` is async.** It returns `Promise<release>`, because a bounded wait inside a sync function would
   block the event loop.
7. **`ctx.env` is not enumerable.** `JSON.stringify(ctx)` therefore never prints secrets. `ctx` also exposes
   `projectDir`: the env file's directory when it holds a `compose.yaml` (a clean-room clone), else this repo.
8. **No root `package.json` script.** 07-01 owns root `package.json` in this wave, so `pnpm gate:compose` is left for
   07-10. The entry point today is `node scripts/gate/compose-gate.mjs`.
9. **Commit verification.** A full `pnpm verify` ran three times: at baseline, before the first five commits, and
   before ce60157. The two small `.mjs`-only commits in between (e2a8142, 5ceb951) were checked with biome and the node
   tests only. No `.mjs` file under `scripts/` or `infra/` is part of vitest or typecheck.

No Dockerfile, `apps/api/package.json` or `pnpm-lock.yaml` change was needed.

## Notes for later plans

- Step convention: `scripts/gate/<step>.mjs` exports `async run(ctx) → { name, ok, details }` and pushes its
  sub-checks to `ctx.steps`. Its CLI takes `--up` (`withGateStack({ profiles })`) or `--attach <envFile>`. It has been
  verified on a used stack: in the attach run, `admin` signed in with `created: false`.
- `node scripts/gate/compose-gate.mjs` is the local entry point for the CI task (D-12). Exit 0 means pass; the JSON
  summary is on stdout.
- With `--keep`, cache is pruned only by a later `--down`. Always pair the two.

## Known Stubs

- `infra/caddy/compose.yaml`, `infra/observability/compose.yaml` and `infra/openbao/compose.yaml` are intentionally
  `services: {}`. They are filled by 07-08 (proxy), 07-07 (observability) and 07-06 (vault).
- The `compose.yaml` header names `pnpm ocw setup`, which 07-04 adds in this wave. Until it merges, `pnpm setup:env`
  still works.

## Broken-windows entries (for WINDOWS.md; not written there per instructions)

- **kind deviation, phase 7:** `pnpm gate:compose` is not wired yet because root `package.json` belongs to 07-01. 07-10
  adds it.
- **kind stub, phase 7:** `infra/{caddy,observability,openbao}/compose.yaml` are `services: {}` stubs. They are owned
  by 07-08, 07-07 and 07-06.

## Threat Flags

None. The gate adds no network surface: api/web bind 127.0.0.1 in gate stacks, and the env files are 0600 in the temp
dir and removed at teardown. T-07-03-01..05 are mitigated as planned.

## Self-Check: PASSED

- The files exist: scripts/gate/{lib.mjs, lib.test.mjs, compose-gate.mjs}, infra/compose.test.mjs and the three
  stubs.
- The commits exist on wt/07-03: 52e88af, 67a3fef, c6f76ef, fc3f52e, b8043e7, e2a8142, 5ceb951, ce60157.
