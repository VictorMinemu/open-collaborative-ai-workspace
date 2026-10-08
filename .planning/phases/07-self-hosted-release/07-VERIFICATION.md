---
phase: 07-self-hosted-release
verified: 2026-10-08T05:25:38Z
status: human_needed
score: 5/6 roadmap success criteria verified (SC6 partial); 53/54 plan truths verified; 3 owner items open
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "SC6 / FOUND-07: `pnpm verify` fails a change that introduces a skipped policy test"
    status: partial
    reason: >-
      `ocw.skipped-policy-test` only scans a filename allowlist (.semgrep/rules.yml:57-69). The rule's own message
      defines policy tests as "tests that prove permissions, RLS and tenant isolation", but about 38 test files that
      assert cross-tenant denial or RLS are outside the allowlist. Probe: `it.skip` added to copies of
      search.int.test.ts, ai-chat/security.int.test.ts and chat/dm-privacy.int.test.ts in a temp tree passed
      `node scripts/guard/run.mjs --only semgrep --root <tmp>`. Only chat/access.int.test.ts was flagged.
      Example: apps/api/src/modules/search/search.int.test.ts:383 ("RLS: org A's readable ids searched from org B's
      tenant find nothing") can be skipped and `pnpm verify` stays green.
    artifacts:
      - path: ".semgrep/rules.yml"
        issue: "lines 57-69: the paths.include allowlist misses tenant-isolation suites (search, ai-chat/security, ai-chat/shares, chat/dm-privacy, chat/*, artifact/attachments, agent-channel/*, notification/*, realtime-reauth, workzone, …)"
    missing:
      - "Widen `ocw.skipped-policy-test` paths.include to `/apps/api/src/**/*.test.ts` and `/packages/*/src/**/*.test.ts`. This costs nothing: there is no `.skip/.todo/.skipIf/.runIf/xit/xdescribe` in apps/api/src or packages/*/src today (grep). Alternatively, any other rule that catches every test asserting tenant isolation."
      - "Add a fixture/guard test: a skip in a non-allowlisted tenant-isolation file (e.g. modules/search/*.int.test.ts) fails `pnpm guard`"
      - "Or, if the owner accepts the narrower scope as built (07-RESEARCH Q7 chose these globs on purpose), add an override for this truth"
human_verification:
  - test: "Owner's clean-machine install on real hardware: docs/INSTALL.md → 'Clean-machine check' steps 1-7 on a fresh VM (git clone, `pnpm ocw setup`, `docker compose up -d --build --wait`, setup page, then proxy/observability/vault/backup), and record the date, machine, timings and result in its table"
    expected: "A working MVP 1 instance with no step beyond the guide. The Linux check of OpenBao's capabilities (07-06) passes. Any failure becomes a gap-closure task naming the step and the error"
    why_human: "D-10. The clean room (`pnpm gate:cleanroom`) simulates this on the owner's Mac with a warm build cache. Only a real clean machine proves cold build time, Linux Docker behaviour and the docs as read by a new person"
  - test: "Confirm or reject the `@anthropic-ai/claude-agent-sdk` license exception and the `server-everything` clarification (scripts/guard/license-policy.json, ADR-0021 §11)"
    expected: "Owner/legal confirm both before public distribution, or ADR-0021's fallback applies (a separate optional Claude adapter download)"
    why_human: "Legal judgement (D-14). The guard admits the package only through this one documented exception"
  - test: "First Woodpecker run of the CI command list in 07-11-SUMMARY ('CI commands (D-12)'): `pnpm install --frozen-lockfile`, `pnpm verify`, `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'`, `node scripts/guard/run.mjs --rule-tests`, the local-runtime/desktop tests, `pnpm gate:compose --with-observability --with-vault` (or the default 5-stage variant on PRs), `pnpm gate:cleanroom` (release/nightly)"
    expected: "Every command exits 0 on the Woodpecker runner and posts a status to the PR. Playwright reports 4 passed, 0 skipped/failed/flaky"
    why_human: "The 'in CI' parts of SC3 (N-1 test) and SC5 (license check, Scenario B on compose) have run only as local entry points plus the local gate (D-01, D-12). Woodpecker (PR #23) is a separate task and has never run this list"
---

# Phase 7: Self-hosted Release. Verification Report

**Phase goal:** Any engineering team can install, upgrade, back up, observe and expose an MVP 1 instance with one
command each, and the MVP 1 acceptance scenario runs against that exact stack in CI. This phase is the milestone gate
for Autofy's own engineers as first customer.
**Verified:** 2026-10-08T05:25:38Z, branch `feat/phase-7-self-hosted` at `ee65f5a` (all 11 plans plus main's #24)
**Status:** gaps_found (one small, partial gap; see below). Once it is closed or overridden, the status is `human_needed` (3 owner items)
**Re-verification:** No (initial verification)

> **MVP-mode note.** ROADMAP marks Phase 7 `Mode: mvp`, but `user-story.validate` returns `false` because the goal is
> not a User Story. Phase 6 set the precedent, and the user asked for this verification explicitly, so this report
> uses the standard goal-backward method plus an operator-flow table. Rewriting the goal is optional roadmap cleanup,
> not a gap.

## Operator Flow Coverage

| Step (one command each) | Evidence in code | Status |
|---|---|---|
| Install: `pnpm ocw setup` + `docker compose up -d --build --wait` | `scripts/ocw/setup.mjs` (secrets generated at setup, 0600, names only); `compose.yaml` minimal profile + `include:` of 3 profile files; `scripts/gate/cleanroom.mjs` runs exactly these in a fresh clone | ✓ (owner's real machine: human) |
| Expose: `pnpm ocw enable proxy --site-address <host>` | `scripts/ocw/enable-proxy.mjs:52-53` (`OCW_TRUST_PROXY=1`, `OCW_PUBLISH_ADDRESS=127.0.0.1`); `infra/caddy/Caddyfile` | ✓ |
| Observe: `pnpm ocw enable observability` | `apps/api/src/telemetry.ts` (preload in the image CMD, `apps/api/Dockerfile` last line); `infra/observability/compose.yaml` (5 pinned images, Grafana on loopback, no default password) | ✓ |
| Secrets to OpenBao: `pnpm ocw enable vault` | `apps/api/src/lib/openbao.ts`, `config/env.ts:327-385` `loadConfig` | ✓ |
| Back up / restore: `pnpm ocw backup`, `pnpm ocw restore DIR --yes` | `scripts/ocw/backup.mjs` (pg_dump as `ocw_migrator`, objects, cell, vault data + seal key), `scripts/ocw/restore.mjs` | ✓ |
| Upgrade: new checkout + `docker compose up` (migrate, then the schema guard) | `apps/api/src/main.ts:18-23`, `packages/db/src/schema-check.ts`, `apps/api/src/upgrade.int.test.ts` | ✓ |
| Scenario B on that exact stack "in CI" | `e2e/compose/scenario-b.spec.ts` through Caddy on production images; `pnpm gate:compose` | ✓ locally; first Woodpecker run: human |

## Goal Achievement

### Roadmap success criteria (the contract)

| # | Success criterion | Status | Evidence |
|---|---|---|---|
| 1 | clone + `pnpm ocw setup` + `docker compose up` gives a working instance on a clean machine; OpenBao and observability are optional profiles enabled later without reinstall; the API emits OTel traces, metrics and logs via `@fastify/otel` | ✓ VERIFIED (clean machine: human) | `compose.yaml:11` `include:` caddy/observability/openbao, each service `profiles: [...]`. `telemetry.ts:15,100` loads no SDK without an endpoint and wires `FastifyOtelInstrumentation`, http, pg and pino with OTLP trace/metric/log exporters. The image CMD preloads it. `enable-observability.mjs` recreates only the api. Gate stages `compose`, `observability` and `vault` were green (07-11 gate record). The clean-room run was green. A real clean machine is the owner's item |
| 2 | Secrets are required inputs (env or `*_FILE`), never generated at boot; env/file and OpenBao implement one `SecretStore` | ✓ VERIFIED | `secret-store.ts:23-26` interface. `createEnvFileSecretStore` and `createOpenBaoSecretStore` (`openbao.ts:39-150`) both return it. `openbao.int.test.ts` runs one `describe.each(providers)` contract over env/file, OpenBao (AppRole, real 2.7.1) and the chained store. `loadConfig` accepts references only for the 4 API-only secrets (`env.ts:337-341`). Compose `:?` guards name missing secrets. The API generates no secret (grep: no `randomBytes` in config/main/app). `ocw setup` prints key names only (`env-file.mjs:160-166` refuses non-key strings) |
| 3 | One-shot `migrate`; the API refuses to start on schema mismatch; N-1 → N upgrade test passes in CI; `ocw backup`/restore as the migrator role; data survives `--force-recreate` | ✓ VERIFIED ("in CI": human) | `main.ts:19-23` calls `checkSchema` after `loadConfig` and before `buildApp`, then exits 1 with `describeSchemaMismatch`. `schema-check.ts:32-51` covers behind/ahead/diverged/missing. `post-migrate.sql:28-29` grants `ocw_app` SELECT. `schema-guard.int.test.ts` spawns the API and checks exit 1 for each case. `upgrade.int.test.ts` restores the `3bbcbd9` golden dump, migrates it, checks schema ok, row counts, tenant isolation, FORCE RLS and sealed-secret decrypt, and gets `/health` 200. It is in vitest's `integration` project, so it runs in `pnpm verify`. Gate stage `schema-refusal` checks the real image. `backup.mjs:232-250` runs `pg_dump -Fc` as `ocw_migrator`. `backup-roundtrip.mjs:436-444` covers `--force-recreate` |
| 4 | The documented Caddy config passes a test for WebSocket upgrade, trusted proxy headers and presigned URLs reachable from outside the network | ✓ VERIFIED | `Caddyfile`: admin off, `/agent-channel` 404, Host kept and bucket prefix not stripped for `garage:3900`. `proxy-check.mjs:347-605` checks ws-upgrade (101 + frames), presign PUT/GET, tampered and unsigned 403, xff-ignored, Secure cookie, agent-channel 404 and loopback ports. Trust proxy: `app.ts:110` → `fastifyTrustProxy` (`env.ts:79-84`). better-auth gets `x-forwarded-for` rewritten to `req.ip` on every session-creating path (`identity/client-ip.ts:9-11`, used in `routes.ts:115`, `routes.ts:170` setup and `invitations.ts:438` accept). `trust-proxy.int.test.ts` and `session-ip.int.test.ts` cover the default and `=1`. Documented in `docs/self-hosting/reverse-proxy.md` |
| 5 | Every package declares its license (AGPL apps/server, Apache contracts/protocol); CI checks dependency licenses; Scenario B (no Work Zone) runs as Playwright E2E against compose in CI | ✓ VERIFIED ("in CI": human; license exception: human) | All 11 manifests the guard scans (root, 5 apps, 4 packages, infra/mcp-sandbox) declare AGPL-3.0-only or Apache-2.0 (contracts, realtime-client and openclaw-channel are Apache with LICENSE files; `packages/protocol` does not exist and the guard checks it once it does). `licenses.mjs` scans the full `pnpm licenses list -r` graph plus the mcp-sandbox lockfile (`guard.test.mjs` 21/21 here). Scenario B steps 1-4 on the mock org model, no `/api/v1/test/*` (`seedPlan` is not imported), `forbidOnly`, retries 0. `assertPlaywrightStats` (`lib.mjs:319-328`) fails on 0 expected or any skipped/failed/flaky test |
| 6 | `pnpm verify` fails on a permission-bypass token (Semgrep), a skipped policy test or a license violation; CODEOWNERS covers db policies, auth, adapters, policy paths | ⚠️ PARTIAL (gap) | `package.json`: `verify = lint && guard && typecheck && test`. Semgrep fails closed (`run.mjs:58-65,88-92`). Bypass-token, RLS-bypass, focused-test and AI-telemetry rules plus the license and CODEOWNERS lint all pass `guard.test.mjs` (21/21, run here). **Skipped policy tests are caught only in allowlisted files.** The probe showed `it.skip` in search, ai-chat/security and chat/dm-privacy isolation tests passes the guard (see Gaps) |

**Score:** 5/6 roadmap SCs verified, 1 partial. Plan must-haves: 53/54 truths verified. The exception is the coverage
side of 07-01 truth 2, which holds for the paths the plan declared. 0 truths are present but behavior-unverified.

### Plan must-haves (11 plans, 54 truths)

| Plan | Truths | Result | Notes |
|---|---|---|---|
| 07-01 Guardrails | 6 | 5 ✓, 1 ⚠️ partial | Truth 2 holds for the declared paths, but the policy-test set misses tenant-isolation suites (gap). CODEOWNERS: 23 patterns, all @VictorMinemu, lint enforced, no enforcement setting |
| 07-02 Schema guard, N-1 | 5 | 5 ✓ | Append-only proof in `upgrade.int.test.ts:85-98`. `HEAD_ONLY` is hardcoded (`:247+`), so each future migration must update it. That is intended: the test enforces it |
| 07-03 Gate harness | 5 | 5 ✓ | `assertSafe` (`lib.mjs:106-134`) refuses the demo project, demo ports (`DEMO.ports`), the `local` tag and env files outside tmp or `.env.demo`/`~/.ocw-demo`. `demoSnapshot` before and after every gate. `.dockerignore` excludes `secrets/` and `backups/` |
| 07-04 `pnpm ocw` | 5 | 5 ✓ | 113/113 Docker-free node tests run here (ocw, setup-env, env-file, backup, enable-*, gate lib, cleanroom, compose-gate) |
| 07-05 OTel, trust proxy | 4 | 4 ✓ | `resourceDetectors: []`, `RedactingSpanExporter`/`RedactingLogRecordExporter` (drop `url.query/url.full/http.target/http.url`, sensitive keys, scrub host paths). Request log serializer strips the query (`app.ts:88-93`). No `experimental_telemetry` and no redis/undici instrumentation (grep). Pins approved per 07-05-SUMMARY:54 |
| 07-06 OpenBao | 5 | 5 ✓ | No `ports:` and server mode in `infra/openbao/compose.yaml`. Errors name the reference or address, never values |
| 07-07 Observability | 5 | 5 ✓ | Images pinned by digest. Grafana at `127.0.0.1:3301`, anonymous off, refuses to start without a password |
| 07-08 Caddy | 5 | 5 ✓ | See SC4 |
| 07-09 Backup/restore | 5 | 5 ✓ | Checksums, refusal of a newer backup and `--yes` checked before any change (`restore.mjs:63-140`). Vault data and seal key included (`backup.mjs:303-337`) |
| 07-10 Scenario B, gate | 4 | 4 ✓ | 8 stages in canonical order, `demo-untouched` step, JSON summary |
| 07-11 Release gate, docs | 5 | 5 ✓ | `gate:cleanroom`, INSTALL.md (218 lines, 'Clean-machine check'), ADR-0021 (only new ADR; no accepted ADR edited), FOUND-06 says Garage, AGENTS.md 199 lines. Owner check explicitly deferred |

Prohibitions honoured (grep over `61213a7...HEAD`, 109 files): no `.github/workflows/**`, `.woodpecker/**` or
`infra/ci-runner/**` change; no drizzle migration added; no git tag; no accepted ADR edited; no test-only route in
the compose spec; no `TBD/FIXME/XXX/TODO/HACK` marker in any phase file.

### "In CI" items (D-01, D-12)

| Criterion | Local entry point | Local gate result | CI status |
|---|---|---|---|
| N-1 → N upgrade test (SC3) | `pnpm verify` (vitest `integration` project) | 203 files / 2817 tests green (after #24) | GitHub `ci.yml:29` already runs `pnpm verify` (Actions blocked by billing). Woodpecker: not yet run (human) |
| Dependency-license check (SC5) | `pnpm guard` inside `pnpm verify` | guard ok (licenses: 1 exception printed) | Same as above |
| Semgrep / skipped tests / licenses (SC6) | `pnpm guard`; `node scripts/guard/run.mjs --rule-tests` | ok; rule tests 5/5 | Same as above |
| Scenario B on compose (SC5) | `pnpm gate:compose [--with-observability --with-vault]`, `pnpm gate:cleanroom` | 8/8 stages, Playwright 4 passed / 0 skipped; clean room ok | Not in `ci.yml` (D-12: phase did not touch it); in the Woodpecker command list (07-11-SUMMARY). First run: human |
| Node tests for scripts/infra | `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` | 331/331 | `ci.yml:32` runs only `scripts/**`. Woodpecker list has both |

### Required artifacts

| Artifact | Status | Details |
|---|---|---|
| `packages/db/src/schema-check.ts` | ✓ VERIFIED | Exported from `@ocw/db`, called by `main.ts` |
| `packages/db/test/upgrade/phase-5-3bbcbd9.sql`, `scripts/upgrade-baseline.mjs` | ✓ VERIFIED | Header names the ref and the regeneration command; synthetic data asserted |
| `apps/api/src/telemetry.ts`, `telemetry/redact.ts` | ✓ VERIFIED | Wired by the Dockerfile CMD and `start`/`dev` scripts |
| `apps/api/src/lib/secret-store.ts`, `lib/openbao.ts` | ✓ VERIFIED | Wired by `loadConfig` → `main.ts:9` |
| `apps/api/src/modules/identity/client-ip.ts` | ✓ VERIFIED | Used on all three better-auth session-creating paths |
| `scripts/ocw.mjs` + `scripts/ocw/{setup,enable-vault,enable-observability,enable-proxy,backup,restore}.mjs` | ✓ VERIFIED | `"ocw": "node -- scripts/ocw.mjs"` |
| `scripts/gate/{lib,compose-gate,cleanroom,proxy-check,schema-refusal,backup-roundtrip,observability-smoke,vault-check}.mjs` | ✓ VERIFIED | `gate:compose`, `gate:cleanroom` in root `package.json` |
| `infra/{caddy,observability,openbao}/compose.yaml`, `Caddyfile`, collector/tempo/prometheus/loki/grafana configs | ✓ VERIFIED | Included by `compose.yaml:11` |
| `e2e/compose/scenario-b.spec.ts`, `e2e/playwright.compose.config.ts` | ✓ VERIFIED | Run by `compose-gate.mjs` `runPlaywright` |
| `.semgrep/rules.yml`, `scripts/guard/*`, `.github/CODEOWNERS` | ✓ / ⚠️ | Wired into verify. Skipped-policy coverage is partial |
| `docs/INSTALL.md`, `docs/self-hosting/*.md` (4), ADR-0021 | ✓ VERIFIED | Substantive (123-218 lines each) |

### Key links

| From | To | Via | Status |
|---|---|---|---|
| `package.json` verify | `scripts/guard/run.mjs` | `pnpm lint && pnpm guard && …` | WIRED |
| `run.mjs` | `.semgrep/rules.yml` | `semgrep scan --config … --error --metrics=off` (uvx pin, Docker fallback, fail closed) | WIRED |
| `main.ts` | `schema-check.ts` | `checkSchema(env.DATABASE_URL)` before `buildApp`, exit 1 | WIRED |
| `post-migrate.sql` | `drizzle.__drizzle_migrations` | `GRANT USAGE/SELECT … TO ocw_app` (lines 28-29) | WIRED |
| `main.ts` | `config/env.ts` | `await loadConfig()` (EnvError → exit 1) | WIRED |
| `env.ts` | `lib/openbao.ts` | Created only when an `openbao://` ref is present | WIRED |
| `apps/api/Dockerfile` | `telemetry.ts` | `CMD node --import tsx --import ./src/telemetry.ts src/main.ts` | WIRED |
| `enable-observability.mjs` | api `OTEL_EXPORTER_OTLP_ENDPOINT` | `OCW_OTEL_ENDPOINT` → `compose.yaml:137` | WIRED |
| `app.ts` | `OCW_TRUST_PROXY` | `trustProxy: fastifyTrustProxy(env.OCW_TRUST_PROXY)` | WIRED |
| identity routes | better-auth | `headersForAuth(req)` (XFF = resolved `req.ip`) | WIRED |
| `enable-proxy.mjs` | api/web publish | `OCW_TRUST_PROXY=1`, `OCW_PUBLISH_ADDRESS=127.0.0.1` | WIRED |
| `Caddyfile` | `garage:3900` | `handle` (prefix kept, Host untouched) | WIRED |
| `backup.mjs` / `restore.mjs` | postgres / migrate | `pg_dump -Fc` as `ocw_migrator`; `run --rm migrate` → drop → `pg_restore --single-transaction` → migrate | WIRED |
| `compose-gate.mjs` | 5 step modules + Playwright config | `run(ctx)` in sequence; `playwright test -c e2e/playwright.compose.config.ts` | WIRED |
| `cleanroom.mjs` | `docs/INSTALL.md` | Same commands (`ocw setup`, `ocw enable proxy`, `docker compose up -d --build --wait`) | WIRED |
| `license-policy.json` | ADR-0021 | exception `adr` field (line 41) | WIRED |

### Behavioral spot-checks (run by this verifier; read-only, no Docker gates)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Guard rules, licenses, fields, CODEOWNERS, repo passes | `node --test scripts/guard/guard.test.mjs` | 21/21 pass (Semgrep via uvx) | ✓ PASS |
| ocw CLI, setup (no secret printed), backup/restore, enable-*, gate harness, clean room | `node --test` on 10 Docker-free test files | 113/113 pass | ✓ PASS |
| Schema check, OTel redaction, env/config, SecretStore, identity (client IP) | `npx vitest run --project unit` on 5 targets | 5 files, 70 tests pass | ✓ PASS |
| Skipped policy test outside the allowlist fails the guard | temp tree + `node scripts/guard/run.mjs --only semgrep --root <tmp>` | only `chat/access.int.test.ts:2` flagged; skips in `search`, `ai-chat/security`, `chat/dm-privacy` passed | ✗ FAIL (gap) |
| plugin-runtime lockfile licenses covered | every `infra/openclaw/plugin-runtime/package-lock.json` entry looked up in `pnpm-lock.yaml` | 0 of 96 missing | ✓ PASS |

Integration tests (testcontainers) and the Docker gates were not re-run. The user's local gate evidence is accepted
and matches the 07-11 gate record: verify 203 files / 2817 tests, `gate:compose --with-observability --with-vault`
8/8 with Playwright 4/0, `gate:cleanroom` ok, node tests 331/331.

### Requirements coverage

| Requirement | Plans | Status | Evidence |
|---|---|---|---|
| SELF-01 | 03, 04, 06, 07, 08, 10, 11 | ✓ SATISFIED (clean machine: human) | SC1 |
| SELF-02 | 04, 06 | ✓ SATISFIED | SC2 |
| SELF-03 | 02, 10 | ✓ SATISFIED (Woodpecker: human) | SC3 |
| SELF-04 | 09, 10 | ✓ SATISFIED | SC3 |
| SELF-05 | 05, 08 | ✓ SATISFIED | SC4 |
| SELF-06 | 01 | ✓ SATISFIED (license exception: human) | SC5 |
| SELF-07 | 10 | ✓ SATISFIED (Woodpecker: human) | SC5 |
| FOUND-05 | 05, 07 | ✓ SATISFIED | SC1 |
| FOUND-06 | 03, 11 | ✓ SATISFIED | Minimal profile with Garage; compose `:?` guards; wording fixed |
| FOUND-07 | 01 | ⚠️ PARTIAL | SC6 gap (skipped-test coverage) |

No orphaned requirement: all 10 IDs mapped to Phase 7 appear in plan frontmatter.

### Anti-patterns and findings

| File | Line | Finding | Severity |
|---|---|---|---|
| `.semgrep/rules.yml` | 57-69 | Skipped-policy-test allowlist misses tenant-isolation suites | ⚠️ Gap (partial SC6) |
| `scripts/ocw/restore.mjs` | 172 | Log says "(one transaction)", but the `DROP SCHEMA` (173-183) and `pg_restore --single-transaction` (184-190) are two transactions. `docs/self-hosting/backup-restore.md:107` describes the real behavior: a failed restore leaves empty schemas, and you re-run it | ℹ️ Info (wording) |
| `infra/openclaw/plugin-runtime/package.json` | 1-5 | No `license` field. `collectPackages` scans only one level under `infra/` (`scripts/guard/licenses.mjs:186-195`). Its dependencies are all in the pnpm graph, so dependency licenses are still checked | ℹ️ Info |
| `compose.yaml` (api) | — | No `depends_on: openbao` in vault mode, so a cold start may exit once and retry (documented, WINDOWS) | ℹ️ Info |
| `apps/api/src/config/env.ts` | 79-84 | `OCW_TRUST_PROXY=1` trusts any direct peer (ADR-0021 residual; API published on loopback in proxy mode) | ℹ️ Info (accepted risk) |
| `infra/openclaw/entrypoint.mjs` | 41-44 | Generates a per-start `OPENCLAW_GATEWAY_TOKEN` when unset (loopback-only inside the container, never persisted). Not an operator secret and outside SC2's API scope | ℹ️ Info |
| `scripts/gate/compose-gate.mjs` | 361 | `main()` guard compares `import.meta.url` to `argv[1]` without `realpath`: a symlinked path exits 0 silently (07-11 open item) | ℹ️ Info |

## Human Verification Required

### 1. Owner's clean-machine install
**Test:** Run docs/INSTALL.md "Clean-machine check" steps 1-7 on a fresh VM and fill in its table.
**Expected:** A working instance by following the guide alone. The OpenBao capabilities work on Linux.
**Why human:** D-10. The clean room ran on the owner's Mac with a warm cache.

### 2. License confirmations
**Test:** Confirm the claude-agent-sdk exception and the server-everything clarification (ADR-0021 §11).
**Expected:** Confirmed, or the ADR's fallback is adopted before public distribution.
**Why human:** Legal judgement (D-14).

### 3. First Woodpecker run of the CI command list
**Test:** Wire the 07-11-SUMMARY command list in Woodpecker (PR #23) and run it on this branch.
**Expected:** All commands exit 0. Playwright reports 4 passed and 0 skipped/failed/flaky.
**Why human:** CI has never run these. The "in CI" parts of SC3 and SC5 rest on the local gate (D-01, D-12).

## Gaps Summary

There is one real gap, and it is small. FOUND-07 / SC6 says `pnpm verify` fails on "a skipped policy test". The
Semgrep rule exists, is wired into `pnpm verify` and works, but only for a filename allowlist. That list misses most
suites that actually prove tenant isolation. A probe showed that `it.skip` on the RLS test at
`apps/api/src/modules/search/search.int.test.ts:383` (and in `ai-chat/security`, `chat/dm-privacy`) passes the guard.

The fix costs nothing. Nothing in `apps/api/src` or `packages/*/src` is skipped today, so the include list can become
`/apps/api/src/**/*.test.ts` and `/packages/*/src/**/*.test.ts`, plus one guard test.

If the owner prefers the scope as researched (07-RESEARCH Q7), accept it with an override:

```yaml
overrides:
  - must_have: "SC6 / FOUND-07: `pnpm verify` fails a change that introduces a skipped policy test"
    reason: "Policy tests are the allowlisted paths in .semgrep/rules.yml (07-RESEARCH Q7); other isolation suites accepted as out of scope"
    accepted_by: "VictorMinemu"
    accepted_at: "<ISO timestamp>"
```

Every other criterion is met through real code paths:

- the schema guard before listen;
- the N-1 golden-dump upgrade inside `pnpm verify`;
- no secret printed (enforced by `reportWritten` and tests);
- one `SecretStore` contract over env/file and real OpenBao;
- OTel redaction at the source;
- trust proxy honoured by Fastify and by better-auth;
- the Caddy proxy checks;
- backup/restore including vault data and the seal key;
- the guard inside verify;
- Scenario B through Caddy on production images;
- the anti-demo `assertSafe`;
- both gate entry points and the CI command list.

After the gap is closed or overridden, the phase is `human_needed` on the three owner items.

---

_Verified: 2026-10-08T05:25:38Z_
_Verifier: Claude (gsd-verifier)_


## Gap closure (orchestrator, 2026-10-08)

- SC6 / FOUND-07 gap closed: `.semgrep/rules.yml` `ocw.skipped-policy-test` now includes `/apps/api/src/**/*.test.ts`
  and `/packages/*/src/**/*.test.ts`. New guard test "a skipped test anywhere in the API or the packages fails" failed
  first and passes now (guard tests 22/22, `--rule-tests` ok, repo scan clean).
- Status after closure: **human_needed** (6/6 roadmap criteria in code; owner items: clean-machine install, license
  confirmations, first Woodpecker run of the command list).
