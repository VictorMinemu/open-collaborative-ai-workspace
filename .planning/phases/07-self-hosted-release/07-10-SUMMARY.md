---
phase: 07-self-hosted-release
plan: 10
subsystem: release-gate
status: complete
tags: [gate, playwright, scenario-b, caddy, backup, openbao, compose, self-hosting]
requires:
  - phase: 07-03
    provides: "scripts/gate/lib.mjs harness (withGateStack, assertSafe, ensureAdmin, demo fingerprint)"
  - phase: 07-04
    provides: "ocw setup --ports/--project/--image-tag"
  - phase: 07-06
    provides: "vault profile, ocw enable vault, vault-check step"
  - phase: 07-07
    provides: "observability profile, observability-smoke step"
  - phase: 07-08
    provides: "proxy profile, ocw enable proxy, proxy-check step, compose.loopback.yaml"
  - phase: 07-09
    provides: "ocw backup / restore, backup-roundtrip step"
provides:
  - "pnpm gate:compose [--steps a,b] [--with-observability] [--with-vault] [--block NN] [--keep|--attach F|--down F]"
  - "e2e/compose/scenario-b.spec.ts + e2e/playwright.compose.config.ts (setup → desktop 1440 / mobile 390)"
  - "scripts/gate/schema-refusal.mjs (compose-level rollback refusal)"
  - "lib.mjs: createGateEnv via ocw setup + ocw enable proxy, assertPlaywrightStats, playwrightSummary, trustCaddyRoot, behindProxy"
  - "ocw backup / restore carry OpenBao data + secrets/ when the vault profile is on; backup-roundtrip.mjs runVault"
affects: [07-11]
tech-stack:
  added: []
  patterns:
    - "One gate stack, stages in canonical order; each stage records its own checks, a failure does not stop later stages (except compose health)"
    - "Playwright runs from the host with an explicit child env (base URL, setup token from the gate env file); JSON report → no-skip assertion"
    - "Node-side gate checks keep TLS verification on: Caddy's local root is trusted per process, re-read after fresh volumes"
key-files:
  created:
    - e2e/compose/scenario-b.spec.ts
    - e2e/playwright.compose.config.ts
    - scripts/gate/schema-refusal.mjs
    - scripts/gate/compose-gate.test.mjs
  modified:
    - scripts/gate/compose-gate.mjs
    - scripts/gate/lib.mjs
    - scripts/gate/lib.test.mjs
    - scripts/gate/backup-roundtrip.mjs
    - scripts/gate/proxy-check.mjs
    - scripts/gate/vault-check.mjs
    - scripts/ocw/backup.mjs
    - scripts/ocw/restore.mjs
    - scripts/ocw/backup.test.mjs
    - compose.e2e.yaml
    - docs/self-hosting/backup-restore.md
    - docs/self-hosting/secrets.md
decisions:
  - "Every gate stack runs behind Caddy: createGateEnv = ocw setup --ports NN --project --image-tag + ocw enable proxy --site-address localhost --no-up; step CLIs (--up) inherit it"
  - "The compose stage skips its admin check when Playwright follows, so the setup project does first-run setup in the browser (it self-skips otherwise, and the gate accepts no skip)"
  - "Gate sign-in limit 600/min via compose.e2e.yaml pass-through (default 30 = the api's own); compose.yaml and the product default are unchanged"
  - "Vault backups include OpenBao's raft volume, the seal key and the init (recovery) material; restore refuses them onto an env file without the vault profile"
  - "Scenario B's solo answer is the fake model's chat-completions reply ('Hi there! [tools: 0]'); the attributed replies are identical to Phase 6's"
  - "Observability and vault run in-process as run(ctx) on the gate stack (same semantics as --attach <envFile>; a child --attach would wait on the gate lock held by the parent)"
metrics:
  duration: "~2 h 15 min wall clock (two gate builds, one attach run, two pnpm verify runs)"
  completed: 2026-10-08
actuals:
  tokens: 22355   # chars/4 over git diff 29e9c89..b371efb (16 files, +1427/-92)
  tasks: 3
  commits: 8
---

# Phase 7 Plan 10: Scenario B through Caddy and the one-command compose gate Summary

**`pnpm gate:compose --with-observability --with-vault` builds this checkout's images, boots one isolated stack
behind Caddy, and runs every check in sequence: Scenario B in Chromium at 1440 and 390, the attachments flow, proxy,
schema refusal, backup/restore/force-recreate, observability, vault, and a vault-aware backup restored onto a new
machine. It then tears everything down. The run on committed HEAD `b371efb` was green: 8/8 stages, Playwright
4 passed, 0 skipped, 0 failed, 0 flaky, 593 s in total.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `6593a6a` | feat(gate): gate env from ocw setup and ocw enable proxy, Playwright no-skip guard |
| add. 1 | `049412e` | feat(ocw): backup and restore include OpenBao data and secrets/ when the vault profile is on |
| add. 1 | `7b022c1` | docs(self-hosting): vault backups carry OpenBao data and its seal key |
| add. 1 / 3 | `c2e3c4e` | test(gate): vault backup round trip onto a new machine; trust Caddy behind the proxy |
| 2 | `b9dbdb3` | feat(gate): schema-refusal step proves an image rollback over a newer schema is refused on compose |
| 1 | `ea48618` | test(e2e): Scenario B through Caddy on production images at 1440 and 390 |
| 1-3 | `b371efb` | feat(gate): pnpm gate:compose runs every compose-level check of the phase on one stack |

The eighth commit is this SUMMARY together with the screenshots. Branch `wt/07-10` (worktree `ocw-07-10`), base `29e9c89`. Nothing was pushed or merged.

## Results (exact)

| Check | Result |
|-------|--------|
| `node --test scripts/ocw/backup.test.mjs` | 22/22 pass (14 existing, 8 new vault tests), 0 skipped |
| `node --test scripts/gate/lib.test.mjs scripts/gate/compose-gate.test.mjs` | 18/18 pass (lib 14, compose-gate 4), 0 skipped |
| `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` | **310/310 pass, 0 fail, 0 skipped**. Baseline was 295; this plan adds 15 |
| `pnpm verify` (tree = the 7 code commits) | **exit 0**: lint 0 errors (the 4 known `apps/local-runtime` warnings); guard semgrep, licenses, fields and codeowners ok; typecheck ok; vitest **203 files, 2816 tests passed** |
| `pnpm gate:compose --steps compose,playwright --keep` (tracer, dirty tree) | **failed as designed**: the setup project was **skipped** (the compose admin check had redeemed the token) and `assertPlaywrightStats` failed the stage. This was fixed (deviation 2) |
| `pnpm gate:compose --attach <kept env> --steps proxy,schema-refusal,backup --with-observability --with-vault` | proxy, backup, observability and **vault-backup ok**. schema-refusal and vault failed on stack races, fixed (deviations 3 and 4). A re-run of schema-refusal on that stack, with the vault on, passed |
| **`OCW_E2E_SCREENSHOT_DIR=… pnpm gate:compose --with-observability --with-vault`** (clean tree `b371efb`) | **exit 0, ok: true, 8/8 stages, 593 s** |
| After the run | 0 `ocw-gate-*` containers, volumes or networks; 0 `gate-*` images; no lock, no temp dirs; 47 cache records pruned. `demo-untouched` ok (2 `:local` images, 5 demo containers) |
| Acceptance greps | `seedPlan\|/api/v1/test/` in scenario-b.spec.ts: none. `playwright.compose.config` in compose-gate.mjs: present. `newer release` in schema-refusal.mjs: present |

### Final run `muz0hy99a6a4` (tag `gate-b371efb62f0b-muz0hy99a6a4`, https://localhost:3443)

| Stage | ms | Evidence |
|-------|----|----------|
| harness | build 59 300, up 24 254 | 11.4 GB free. Image sizes: api 213 MB, web 95 MB, openclaw 1203 MB, fake-model 77 MB |
| compose | 213 | `migrate` exited 0. api `/health` 200, web `/login` 200, cell healthy (the admin check is skipped because Playwright follows) |
| **playwright** | 21 457 | **setup 1/1, desktop 2/2 (Scenario B, attachments API), mobile 1/1 (Scenario B). 0 skipped, 0 unexpected, 0 flaky** |
| proxy | 933 | The env written by `ocw enable proxy` is verified, and Caddy listens on `127.0.0.1:3443`. api/web are bound to loopback, and LAN connections are refused. An untrusted fetch is refused with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. ws 101 `ocw.v1` with a `message.created` frame. Presigned PUT/GET 200 with identical bytes; tampered → 403, unsigned → 403. Forged XFF ignored: audit and session record `192.168.192.1`. Cookie is `__Secure-` with HttpOnly and Secure. agent-channel → 404 |
| schema-refusal | 69 514 | For 60 s: never healthy and `/health` never 200, state `restarting`. Log line: "Database was migrated by a newer release (unknown: 29991231235959_gate_refusal_545a56)…". Recovery: row removed, force-recreate exit 0, `/health` 200 |
| backup | 149 845 | Backup files 0600, no secret printed. Restore matches on rows, deletions, bytes, both sign-ins, the bucket, cell state and RLS. Fresh volumes: restore takes 26 s with identical results. `--consistent` restarts the writers. `--force-recreate`: counts `4,4,4,17,3,17` identical, sign-in and download ok |
| observability | 71 155 | Only the api is recreated. Tempo has 35 spans (fastify `request`, `GET /api/v1/me`, `pg.query`). Prometheus has the route-labelled metric. Loki holds 2 lines with the trace id. No leaks. Grafana: 3 datasources OK, `admin:admin` and anonymous get 401, an empty or `admin` password is refused. Memory: grafana 599 MiB, collector 141, loki 54, tempo 40, prometheus 29 |
| vault | 58 545 | `ocw enable vault` exits 0 and leaks 0 values. All 4 secrets became `openbao://` refs. The api is healthy on refs; the old session and a fresh sign-in both work. OpenBao is unpublished. Restart auto-unseals. `secrets/` is 700, its files 600. Logs are clean (5 values checked) |
| **vault-backup** | 86 442 | Backup holds `openbao-data.tar` (3.36 MB), `openbao-seal.key` and `openbao-init.json`, with `components.vault` true. **New machine** (`down -v`: 0 volumes left, `secrets/` deleted) → restore exit 0 (36 s). The api is healthy on refs; the **session from before is valid**; a fresh sign-in works; the seal key is restored byte-identical with mode 0600; the init material is back; rows are identical (`4,4,5,18,3,17`) |
| teardown | 32 531 + 17 336 | 4 images removed, 47 build-cache records pruned |

Memory with both profiles on a 16 GB Docker VM shared with ~7.5 GB of other projects was fine. Observability did not
have to be stopped before the vault stage (A8 held).

### Screenshots (`.planning/phases/07-self-hosted-release/screenshots/`, final run, reviewed)

`scenario-b-1-private-chat`, `-2-share-dialog`, `-3-shared-with-me`, `-4-alex-live-on-victors-page`,
`-5-answers-victor` and `-5-answers-alex` at `-1440` and `-390`, plus `setup-1440` and `setup-390`. They show:
- the mock chip and the "not metered" footer;
- the disclosure in the share dialog (a bottom sheet at 390);
- "Shared with me" with the owner's name;
- Alex's turn on Víctor's page without a reload;
- answers that name each asker, with "for you" / "for Alex Kim" footers.

The share dialog and the step-4 shot also catch the transient "Shared with Alex Kim" toast. That is product
behaviour, not a defect.

## CI commands (for 07-11 / the Woodpecker task; `.woodpecker/**` and `.github/workflows/**` untouched)

```bash
pnpm install --frozen-lockfile
pnpm verify                                              # lint + guard (semgrep: uv or Docker) + typecheck + vitest (Docker: testcontainers)
node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs' # 310 tests; needs Docker (compose config, caddy adapt)
node scripts/guard/run.mjs --rule-tests                  # Semgrep rule tests (07-01)
pnpm gate:compose --with-observability --with-vault      # the full release gate (~10 min warm, Docker, >= 6 GB free)
```

- **Faster PR variant:** `pnpm gate:compose`, the default stages without the two profiles (about 6 min warm).
- **Optional env:**
  - `OCW_E2E_SCREENSHOT_DIR=<dir>` saves the Scenario B screenshots, which can be kept as artifacts.
  - `OCW_GATE_MIN_FREE_GB` sets the disk floor (default 6).
  - `PLAYWRIGHT_BROWSERS_PATH` caches Chromium. The gate runs `playwright install chromium` itself.
- **Ports:** `--block NN` moves the stack to ports NN00-NN99 when 34xx is busy.
- **Pass/fail:** stdout is one JSON summary (`ok`, `stages`, `playwright`, `steps`), and exit 0 means everything passed.
- **Runner requirements:** the runner needs Node 24, pnpm 12, Docker with Compose 5.x, and loopback ports. A Linux runner sees real client IPs behind Caddy, so the 600/min gate limit is only headroom there.

## Deviations from Plan

1. **[Additions from the orchestrator, test first] Vault-aware `ocw backup` / `ocw restore`.**
   - RED: 9 failing tests in `backup.test.mjs`, written before the code.
   - GREEN: 22/22 (`049412e`).
   - Proof on a real stack: the `vault-backup` stage (`runVault`, `c2e3c4e`) restores onto a new machine.
   - Docs updated (`7b022c1`). They state that such a backup can unseal OpenBao by itself and must be kept as private as `.env`.
2. **[Rule 1 - Bug] The compose stage redeemed the setup token before Playwright.**
   - Symptom: the `setup` project self-skipped. The new `assertPlaywrightStats` caught it and failed the run (T-07-10-02 working as intended).
   - Fix: the compose stage skips its admin check when the playwright stage follows. Later stages call `ensureAdmin`, which signs in the admin that Playwright created.
3. **[Rule 1 - Test robustness] schema-refusal recovery.**
   - `up -d --no-deps --wait api` exited 1 against a container still in Docker's restart backoff, although `/health` then answered 200.
   - Recovery now force-recreates the api, which is what an operator does once the database matches the image.
4. **[Rule 3 - Shared stack] `vault-check` `admin-before` hit `fetch failed`.**
   - This happened right after `up --wait api` recreated the api (the Docker Desktop port-forward lag that 07-09 also saw).
   - The check now waits for `/health` before signing in. No check was removed.
5. **[Rule 1] The org mock's solo reply is `Hi there! [tools: 0]`, not `Echo: …`.**
   - `Echo: …` is the ChatGPT-plan Responses path that the Phase 6 spec used through `seedPlan`. The org mock goes through chat completions on the fake model.
   - The attributed answers are unchanged: "Hi Alex Kim! (participants: Alex Kim, Víctor Ruiz) Echo: …".
6. **[Rule 2] Every gate stack runs behind Caddy.** This includes the standalone `--up` modes of the steps.
   - `backup-roundtrip` trusts Caddy's local root for presigned https URLs, again after fresh volumes (a new `caddy-data` is a new CA).
   - `proxy-check`'s `enableProxy` now verifies an env that `ocw enable proxy --no-up` already wrote. Before, it accepted it without a check.
7. **Rate limit:** `compose.e2e.yaml` now forwards `OCW_SIGNIN_RATE_LIMIT_PER_MINUTE` (default 30), and gate env files set 600. `compose.yaml` and the api default are unchanged.
8. **[Process] TDD and commits.**
   - RED was observed for the vault backup tests (9 failing) and the lib tests (missing exports). Each was committed together with its implementation, so every commit's tree passes `pnpm verify`.
   - One full `pnpm verify` covered the 7 code commits; the tree at `b371efb` is exactly the verified tree.
   - `--steps playwright` alone was not run as a separate build. The tracer used `--steps compose,playwright`, and the final full run includes the playwright stage on a fresh stack. That keeps the run plan to two stack builds plus one `--attach` run, as requested.
9. **Observability/vault in-process.** They run as `run(ctx)` on the gate stack, which has the same semantics as `observability-smoke.mjs --attach <envFile>`, including its own overrides. Spawning a child with `--attach` would wait on the gate lock that the parent holds.

## Known Stubs

None.

## Broken-windows entries (for the orchestrator's WINDOWS.md; not written here)

- `deviation` | `scripts/gate/compose-gate.mjs` | the compose stage's admin check is skipped when Playwright runs in the same gate. Admin setup is then proved by the browser `setup` test.
- `deviation` | `compose.e2e.yaml` / `scripts/gate/lib.mjs` | gate stacks raise the sign-in limit to 600/min, because Docker Desktop shows every client behind Caddy as the gateway IP. The product default stays 30.
- `deviation` | `scripts/ocw/backup.mjs` | with the vault profile on, a backup now contains the OpenBao seal key and the recovery material. It is self-sufficient but as sensitive as `.env`; this is documented.
- `unrun-verify` | `scripts/gate/compose-gate.mjs` | `pnpm gate:compose --steps playwright` (exactly) and the default `pnpm gate:compose` were not run as separate builds. The full run `--with-observability --with-vault` is their superset, and it includes the playwright stage on a fresh stack.

## Open items

- **Usage error:** `pnpm gate:compose --steps <unknown>` exits 1 with a stack trace. It should print a usage message and exit 2. This is cosmetic, and nothing has started at that point.
- **Caddy root on fresh volumes:** a restore onto fresh volumes gives Caddy a new local CA. Browsers that trusted the old root (`OCW_PROXY_TLS=internal`) have to trust the new one, unless the operator also backs up `caddy-data` (documented as optional in backup-restore.md).
- **`--attach` needs a fresh stack for Playwright:** the `setup` test self-skips on a used stack, so a Playwright stage on a used stack fails the no-skip rule by design. The other stages compose on used stacks.
- **From 07-09 (still open):** `docker compose start` in `ocw backup` also re-runs the one-shot `migrate`. It is idempotent, and the vault pause uses the same pattern.

## Threat Flags

None beyond the plan's register.

| Threat | Mitigation in place |
|--------|---------------------|
| T-07-10-01 | `assertSafe` runs first in `createGateEnv`, plus the lock, 34xx ports, gate tags, and the demo fingerprint (demo-untouched ok) |
| T-07-10-02 | `assertPlaywrightStats` caught a real skip during the tracer |
| T-07-10-03 | No test route, no seeding, production images |
| T-07-10-04 | The setup token only reaches the Playwright child's environment; the repo `.env` is never read |
| T-07-10-05 | The schema-refusal stage |

The new surface is the vault backup. It holds the seal key with the data. Files are 0600 in a 0700 directory, the
backup is checksummed, and docs/self-hosting/backup-restore.md flags it as sensitive.

## Self-Check: PASSED

- Files exist: e2e/compose/scenario-b.spec.ts, e2e/playwright.compose.config.ts, scripts/gate/schema-refusal.mjs,
  scripts/gate/compose-gate.test.mjs, and the 14 screenshots.
- Commits exist on `wt/07-10`: 6593a6a, 049412e, 7b022c1, c2e3c4e, b9dbdb3, ea48618, b371efb. No commit deletes a
  tracked file.
