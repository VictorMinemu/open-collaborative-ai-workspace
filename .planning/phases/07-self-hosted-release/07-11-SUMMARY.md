---
phase: 07-self-hosted-release
plan: 11
subsystem: release-gate
status: complete
tags: [gate, cleanroom, self-hosting, docs, adr, requirements, ci]
requires:
  - phase: 07-01 … 07-10
    provides: "guard, schema guard, gate harness, pnpm ocw, OTel, OpenBao, observability, Caddy, backup/restore, pnpm gate:compose"
provides:
  - "pnpm gate:cleanroom [--block NN] [--run-id ID] [--keep] | --down <clone>/.env"
  - "lib.mjs acquireLock: OCW_GATE_LOCK_INHERIT=1 lets a child run under its parent's gate lock"
  - "docs/INSTALL.md (with 'Clean-machine check'); ADR-0021; FOUND-06 wording and Phase 7 traceability; 07-VALIDATION.md"
affects: [phase-verification, ci-woodpecker, v0.1.0-tag]
tech-stack:
  added: []
  patterns:
    - "Clean room = git clone --no-local of HEAD under the temp dir, the documented commands run verbatim in it, then the clone's own compose gate (--attach) under the parent's lock"
    - "Before an un-scoped `docker compose up` (no -p), `docker compose config --format json` of the clone is checked: project, every published port, every ocw-* image tag"
key-files:
  created:
    - scripts/gate/cleanroom.mjs
    - scripts/gate/cleanroom.test.mjs
    - docs/INSTALL.md
    - docs/adr/0021-self-hosted-release.md
    - .planning/phases/07-self-hosted-release/07-VALIDATION.md
  modified:
    - scripts/gate/lib.mjs
    - scripts/gate/lib.test.mjs
    - package.json
    - README.md
    - docs/DEMO.md
    - AGENTS.md
    - .planning/REQUIREMENTS.md
decisions:
  - "The clean room runs the clone's own scripts/gate/compose-gate.mjs (not this checkout's), so ocw backup/restore, Playwright and compose paths all resolve inside the clone; the gate lock is inherited by the child only when the holder is its parent and OCW_GATE_LOCK_INHERIT=1"
  - "Clean-room image tag is cleanroom-<sha12>-<runId> (not cleanroom-<sha>), so teardown only ever removes this run's images (07-03's rule)"
  - "`pnpm install --frozen-lockfile` runs in the clone after the install, as gate tooling only (Playwright); the documented install itself is unchanged"
  - "Owner's clean-machine check deferred under delegated autonomy: human_needed (SUMMARY, VALIDATION, REQUIREMENTS SELF-01, INSTALL)"
  - "CI = self-hosted Woodpecker at https://ci.autofy.ing (separate task); .github/workflows stays for when Actions billing returns"
metrics:
  duration: "~2 h 45 min wall clock (3 tracer clean-room runs, verify, full compose gate, final clean room)"
  completed: 2026-10-08
actuals:
  tokens: 21000   # chars/4 over git diff 8db72c2..HEAD including this SUMMARY and 07-VALIDATION.md
  tasks: 2        # Tasks 1-2 done; Task 3 (owner) deferred
  commits: 7
---

# Phase 7 Plan 11: Clean-room install gate, release docs, ADR-0021 and the phase gate Summary

**`pnpm gate:cleanroom` clones HEAD into the temp directory. It installs with exactly the documented commands
(`pnpm ocw setup`, `pnpm ocw enable proxy`, `docker compose up -d --build --wait`), runs the clone's own compose gate
against the result, and removes everything. On HEAD `3e48c44` it was green in 348 s: install 79 s, Scenario B 4/4
with 0 skipped, proxy, schema refusal and backup. The whole local gate is green on that HEAD, one command at a time.
`docs/INSTALL.md`, ADR-0021 and the requirements close the phase. The owner's clean-machine check is deferred
(`human_needed`).**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `3a0b3a2` | feat(gate): pnpm gate:cleanroom installs a fresh clone with the documented commands and runs its compose gate |
| 1 | `99b4ac5` | fix(gate): cleanroom spawns pnpm through /bin/sh (shebang-less pnpm stubs) and reports spawn errors |
| 1 | `aa8e4c2` | fix(gate): cleanroom runs the clone's compose gate by its real path (macOS /var → /private/var) |
| 2 | `7efca4f` | docs: self-hosted install guide and ADR-0021 for the self-hosted release |
| 2 | `3e48c44` | docs(07-11): FOUND-06 names Garage; FOUND-05..07 and SELF-01..07 traced to their evidence |
| 2 | (final) | docs(07-11): validation sign-off, install timings and plan summary |

Branch `wt/07-11` (worktree `ocw-07-11`), base `8db72c2`. Nothing pushed or merged, no tag (D-17: the orchestrator
tags `v0.1.0` after the merge).

## Gate record (HEAD `3e48c44`, 2026-10-08, one command at a time)

| # | Command | Result |
|---|---------|--------|
| 1 | `pnpm install --frozen-lockfile` | exit 0 (2.7 s, warm store) |
| 2 | `pnpm verify` | **exit 0**, 10 min 14 s. Lint: 0 errors, the 4 known `apps/local-runtime` warnings. Guard: semgrep ok; licenses ok (998 package versions, 1 exception printed: claude-agent-sdk, pending owner/legal confirmation); fields ok; codeowners ok. Typecheck: 8/8. Vitest: **203 files, 2816 tests passed** |
| 3 | `pnpm typecheck --force` | exit 0, 8/8 tasks, 0 cached |
| 4 | `npm ci --prefix infra/mcp-sandbox --ignore-scripts --no-audit --no-fund && node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` | exit 0, **331/331 pass**, 0 fail, 0 skipped (79 suites). 07-10's baseline was 310; this plan adds 9 (2 lock-inheritance + 7 clean-room) |
| 5 | `node scripts/guard/run.mjs --rule-tests` | exit 0: rules.sql 1/1, rules.ts 4/4 |
| 6 | `HOME=<tmp> pnpm --filter @ocw/local-runtime test` | exit 0, **18 files, 313/313** |
| 7 | `HOME=<tmp> env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` | exit 0, **11 files, 88/88** |
| 8 | `pnpm gate:compose --with-observability --with-vault` | **exit 0, ok: true, 8/8 stages, 604 s** (run `muz211qh8f17`, tag `gate-3e48c442d031-muz211qh8f17`). Details below |
| 9 | `pnpm gate:cleanroom` | **exit 0, ok: true, 348 s** (run `muz2ecq2d5e3`, tag `cleanroom-3e48c442d031-muz2ecq2d5e3`). Details below |
| — | After both runs | 0 `ocw-gate-*` / `ocw-cleanroom-*` containers, volumes, networks or images. No lock, no temp dirs. `demo-untouched` ok every run (2 `:local` images, 5 demo containers). `.github/workflows`, `.woodpecker` and `infra/ci-runner` untouched |

### `pnpm gate:compose --with-observability --with-vault`

| Stage | ms |
|-------|----|
| harness | disk 13.6 GB free; build 55 364 (api 213 MB, web 95 MB, openclaw 1203 MB, fake-model 77 MB); up 28 106 |
| compose | 177 |
| playwright | 18 133. **setup 1/1, desktop 2/2, mobile 1/1; 0 skipped, 0 unexpected, 0 flaky** |
| proxy | 852 |
| schema-refusal | 69 470 |
| backup | 149 294 |
| observability | 88 564 |
| vault | 59 469 |
| vault-backup | 86 386 |
| teardown | 32 278, 4 images removed; build cache 46 records pruned (only this run's) |

### `pnpm gate:cleanroom`

| Step | ms | Evidence |
|------|----|----------|
| clone | 3 012 | `git clone --no-local` + `checkout --detach 3e48c44`; the clone had no `.env` |
| ports-free | 2 | 3400-3404, 3405, 3443, 3480 |
| ocw-setup | 3 541 | `pnpm ocw setup --ports 34 --project ocw-cleanroom-muz2ecq2d5e3 --image-tag cleanroom-3e48c442d031-muz2ecq2d5e3`. pnpm installed the workspace first (`node_modules` present). Output named keys only |
| ocw-enable-proxy | 389 | `pnpm ocw enable proxy --site-address localhost --no-up` → `https://localhost:3443` |
| gate-keys | 1 | Adds only `COMPOSE_FILE`, `OCW_MODEL_PROVIDER`, `OCW_SIGNIN_RATE_LIMIT_PER_MINUTE`, `OCW_PUBLISH_ADDRESS` |
| disk-free | 260 | 10.9 GB free |
| compose-config | 113 | Project `ocw-cleanroom-muz2ecq2d5e3`; ports 3400, 3401, 3402, 3403, 3404, 3443, 3480; 4 `ocw-*` images, all with the run tag |
| **compose-up** | **78 698** | `docker compose up -d --build --wait` in the clone, verbatim, no `-p` |
| gate-tooling | 393 | `pnpm install --frozen-lockfile` in the clone |
| **compose-gate** | 238 477 | The clone's `node scripts/gate/compose-gate.mjs --attach <clone>/.env`: compose 159, **playwright 17 681 (4 passed: setup 1, desktop 2, mobile 1; 0 skipped/unexpected/flaky)**, proxy 951, schema-refusal 68 851, backup 150 297 |
| teardown | 22 346 | `down -v --remove-orphans`, 4 images removed, 46 build-cache records pruned, temp root removed |
| demo-untouched | — | ok |

Tracer runs before the final one:

- run 1 (`3a0b3a2`) failed at `ocw-setup` (spawn ENOEXEC; deviation 1);
- run 2 (`99b4ac5`) installed fine (up 82 s) but the child gate never started (deviation 2);
- run 3 (`aa8e4c2`) was green in 368 s (up 94 s).

Every run tore down completely.

## CI commands (D-12) with this gate's results

For the Woodpecker task (https://ci.autofy.ing). `.woodpecker/**` and `.github/workflows/**` were not touched. These
are the exact commands from the 07-10 SUMMARY, plus the release step:

```bash
pnpm install --frozen-lockfile
pnpm verify                                              # lint + guard (semgrep: uv or Docker) + typecheck + vitest (Docker: testcontainers)
node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs' # needs Docker (compose config, caddy adapt); run `npm ci --prefix infra/mcp-sandbox --ignore-scripts --no-audit --no-fund` first
node scripts/guard/run.mjs --rule-tests                  # Semgrep rule tests (07-01)
pnpm gate:compose --with-observability --with-vault      # the full release gate (~10 min warm, Docker, >= 6 GB free)
```

Plus, from the plan's list:

```bash
pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test   # desktop: env -u ELECTRON_RUN_AS_NODE; a throwaway HOME
pnpm exec playwright install --with-deps chromium                          # Linux runner; the gate also runs `playwright install chromium` itself
pnpm gate:cleanroom                                                        # release or nightly (~6 min warm); needs a clean checkout
```

| CI command | Result on `3e48c44` |
|------------|---------------------|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm verify` | ok: 203 files / 2816 tests, guard ok |
| `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` | ok: 331/331 |
| `node scripts/guard/run.mjs --rule-tests` | ok: 5/5 |
| `pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test` | ok: 313/313 and 88/88 |
| `pnpm gate:compose --with-observability --with-vault` | ok: 8/8 stages, Playwright 4/0/0/0, 604 s |
| `pnpm gate:cleanroom` | ok: 348 s, install 79 s, inner gate 5/5 stages, Playwright 4/0/0/0 |

Notes for the CI task:

- **Faster PR variant:** `pnpm gate:compose`, the default 5 stages, about 6 min warm.
- **Disk floor:** `OCW_GATE_MIN_FREE_GB` (default 6) applies to both gates.
- **Busy ports:** `--block NN` moves either gate off 34xx.
- **Pass/fail:** stdout is one JSON summary, and exit 0 means pass.
- **Clean checkout:** `gate:cleanroom` exits 2 on a dirty tree, so CI must run it on the checked-out commit.

## Task 2 output

- **`docs/INSTALL.md`** covers:
  - requirements, with the measured warm build time;
  - install, what runs, and the expose / observe / OpenBao commands;
  - backup, restore and upgrade, linked to the topic guides;
  - a second instance (`--ports 35`);
  - troubleshooting, with the compose missing-secret line, the API's `Invalid API configuration` line and the
    schema-guard messages verbatim, plus port conflicts and slow first builds;
  - uninstall;
  - **Clean-machine check**: the owner's steps, and a table recording the result as deferred (`human_needed`).
- **README:** "Status" says MVP 1 is self-hostable. "Self-hosting" shows the three commands and links INSTALL.md.
- **DEMO.md:** one pointer line under the title.
- **AGENTS.md:** the `pnpm verify` comment now lists the guard; the self-hosted line is
  `pnpm ocw setup && docker compose up -d --build --wait`; `pnpm gate:compose` was added; "Built so far" includes
  Phase 7; the secrets and observability rows cite 0021. It is **199 lines**, and no GSD block was touched.
- **ADR-0021** is Accepted, except the two license points, which are **pending owner/legal confirmation**:
  - the claude-agent-sdk exception, with its fallback of a separate optional Claude adapter download;
  - the server-everything clarification.

  It also records:
  - Woodpecker CI at https://ci.autofy.ing, with GitHub Actions kept in the repository;
  - the `OCW_TRUST_PROXY=1` residual risk: host processes and compose-network containers can forge
    `X-Forwarded-For`;
  - vault backups contain the seal key;
  - the N-1 rule (`3bbcbd9`, then the previous tag);
  - everything else the plan lists.
- **REQUIREMENTS:**
  - FOUND-06 now reads "postgres, redis, garage, api, web, one-shot `migrate` and the OpenClaw cell";
  - FOUND-05…07 and SELF-01…07 are checked and traced as `Phase 7 | Complete | <evidence>`;
  - SELF-01 is "Complete (owner clean-machine check: human_needed)";
  - a coverage line and "Last updated" were added.
- **07-VALIDATION.md:** created and signed off (deviation 4).

Acceptance greps (all as expected):

- `Clean-machine check`, `pending owner/legal confirmation` and `FOUND-06` are present;
- FOUND-06 with garage: 1 line; FOUND-06 with minio: 0;
- SELF rows: 7;
- `docs/INSTALL.md` is linked from README and DEMO;
- `docs/adr` holds no change other than 0021.

## Task 3: owner checkpoint

**Deferred (`human_needed`).** Under the owner's delegated autonomy, the orchestrator recorded the clean-machine install
on real hardware as deferred. The executor did not run it, and it never used the owner's machines or demo.

- **Where it is recorded:** this SUMMARY, `07-VALIDATION.md` (`manual_pending: human_needed`), the REQUIREMENTS
  SELF-01 row, and the `docs/INSTALL.md` "Clean-machine check" table.
- **How to resume:** follow `docs/INSTALL.md` → "Clean-machine check" (steps 1-7) on a fresh VM, then record the date,
  machine, timings and result in its table. A failure becomes a gap-closure task with the exact step and error.

## Deviations from Plan

1. **[Rule 3 - Blocking] pnpm spawned through `/bin/sh`.** The nvm `pnpm` is a native-binary placeholder stub with no
   shebang, so `spawnSync("pnpm")` failed with ENOEXEC (tracer run 1: `ocw-setup exited null`). This is the same cause
   07-01 hit. The arguments go as `"$@"` and are never interpolated. Spawn errors are now reported. Commit `99b4ac5`.
2. **[Rule 1 - Bug] Clone path resolved with `realpath`.** On macOS `tmpdir()` is `/var/folders/…`, a symlink to
   `/private/var/…`. The clone's `compose-gate.mjs` compares `import.meta.url` (symlinks resolved) with `argv[1]`, so
   its `main()` never ran and it exited 0 with no output (tracer run 2). The gate caught it as "exited 0 without a JSON
   summary". Commit `aa8e4c2`.
3. **[Rule 3] Lock inheritance in `lib.mjs` (owned by 07-03).** The child gate would otherwise wait for the lock its
   parent holds; 07-10 hit the same problem in deviation 9.
   - `OCW_GATE_LOCK_INHERIT=1` lets a child proceed only when the lock holder is its own parent (`process.ppid`). Its
     release is a no-op.
   - RED was observed (the inheritance test failed) before the change. 2 new tests.
4. **[Orchestrator instruction] `07-VALIDATION.md` created.** The plan says not to create it when it is missing. The
   orchestrator asked for the deferral to be recorded in VALIDATION, so it was created in the 06-VALIDATION shape and
   signed off.
5. **Tag shape `cleanroom-<sha12>-<runId>`**, not `cleanroom-<sha>`, for the same safety reason as 07-03 deviation 1:
   only images carrying the run id are removed.
6. **Gate tooling step.** `pnpm install --frozen-lockfile` runs in the clone *after* the documented install, so the
   clone's own Playwright can run. In practice `pnpm ocw setup` had already installed the workspace (pnpm 12 installs
   before running a script), so the step took 0.4 s.
7. **Extra safety check before the un-scoped `up`.** `docker compose config --format json` of the clone must show the
   run's project, only block ports and only run-tagged `ocw-*` images. Without this check, the documented command
   (no `-p`) would rely on `.env` alone.
8. **[Process] `cleanroom.test.mjs` written after `cleanroom.mjs`.** It covers the pure helpers; the script itself is
   proven by the gate runs. No RED was observed for these 7 tests.
9. **INSTALL.md uses Grafana's real default port 3301,** and notes Compose's expected `pull access denied for ocw-api`
   line, which was seen in every clean-room `up`.

## Known Stubs

None. The INSTALL "Clean-machine check" table holds `_pending_` cells on purpose: it is the owner's record (Task 3,
`human_needed`).

## Broken-windows entries (for the orchestrator's WINDOWS.md; not written here)

- `unmet-truth` | `docs/INSTALL.md` | the owner's clean-machine install on real hardware is deferred (`human_needed`,
  07-11 Task 3). This includes the Linux check of OpenBao's capabilities from 07-06.
- `deviation` | `scripts/guard/license-policy.json` / ADR-0021 | the `@anthropic-ai/claude-agent-sdk` exception and the
  `server-everything` clarification are pending owner/legal confirmation before public distribution.
- `deviation` | `apps/api/src/config/env.ts` / ADR-0021 | `OCW_TRUST_PROXY=1` trusts any direct peer, so host processes
  and compose-network containers can forge `X-Forwarded-For`. The mitigation (a fixed proxy address/CIDR) is
  documented, and making it the default is deferred.
- `deviation` | `scripts/ocw/backup.mjs` / ADR-0021 | a backup taken with the vault on contains OpenBao's seal key and
  is as sensitive as `.env`.
- `deviation` | `scripts/gate/lib.mjs` | a child may inherit the gate lock (`OCW_GATE_LOCK_INHERIT=1`, holder must be
  its parent).
- `unrun-verify` | CI | no Woodpecker run of the command list exists yet (separate task).

## Open items

- **v0.1.0 tag (orchestrator, after merge).** Afterwards, the N-1 sentence in `docs/self-hosting/backup-restore.md`
  should say "the previous release tag". Run `pnpm --filter @ocw/db upgrade:baseline v0.1.0` for the next phase.
- **`pull_policy: build`** on the locally built services in `compose.yaml` would remove Compose's
  `pull access denied for ocw-api` line during install. It is cosmetic and documented.
- **`compose-gate.mjs` `main()` guard and symlinks.** The guard compares `import.meta.url` with `argv[1]` without
  `realpath`. Any caller passing a symlinked path gets a silent exit 0. The clean room now passes the real path; a
  `realpathSync(argv[1])` in the guard would fix it for every caller.
- **The demo's OpenClaw cell was recreated at 2026-10-08T04:45:57Z (23:45:57 local), during this plan's test window.**
  The demo's `demo-up.log` has the same mtime, so this came from an external `pnpm demo:up`. Nothing in this plan runs
  `demo-up` or references the demo cell in a test, and nothing under `~/.ocw-demo` was read. Each gate's before/after
  fingerprint was identical; the gate:compose snapshot was taken after the recreation.
- **Carried from 07-10:**
  - `pnpm gate:compose --steps <unknown>` prints a stack trace;
  - a restore onto fresh volumes gets a new Caddy CA;
  - `ocw backup`'s `compose start` re-runs the idempotent `migrate`.
- **Docker disk:** 13.6 GB free before the compose gate and 10.9 GB before the final clean room. All of this plan's
  images, volumes, networks and build-cache records were removed; nothing was pruned globally. The logs are in
  `/tmp/ocw-0711-logs/` and contain no secret values.

## Threat Flags

None beyond the plan's register.

| Threat | Mitigation in place |
|--------|---------------------|
| T-07-11-01 | The full local gate, including the clean clone, both profiles and Scenario B |
| T-07-11-02 | `assertSafe`, the lock, the `ocw-cleanroom-*` project, 34xx ports, run-tagged images, the compose-config check, the teardown check and demo fingerprints |
| T-07-11-03 | INSTALL reads the setup token with `grep` on the operator's own server, never prints secrets, and flags backups and `secrets/` as sensitive |
| T-07-11-04 | ADR-0021 marks the exception pending owner/legal confirmation, with a fallback |
| T-07-11-05 | The owner's clean-machine check is recorded as `human_needed` |

## Self-Check: PASSED

- Files exist: `scripts/gate/cleanroom.mjs`, `scripts/gate/cleanroom.test.mjs`, `docs/INSTALL.md`,
  `docs/adr/0021-self-hosted-release.md`, `07-VALIDATION.md`.
- Commits exist on `wt/07-11`: `3a0b3a2`, `99b4ac5`, `aa8e4c2`, `7efca4f`, `3e48c44`. No commit deletes a tracked file.
