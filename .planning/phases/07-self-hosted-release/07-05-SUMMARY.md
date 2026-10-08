---
phase: 07-self-hosted-release
plan: 05
subsystem: api
status: complete
tags: [opentelemetry, observability, redaction, trust-proxy, security]
requires: []
provides:
  - "apps/api/src/telemetry.ts preload (off unless OTEL_EXPORTER_OTLP_ENDPOINT is set)"
  - "RedactingSpanExporter / RedactingLogRecordExporter / scrubString / stripQueryStrings (apps/api/src/telemetry/redact.ts)"
  - "OCW_TRUST_PROXY env + fastifyTrustProxy (apps/api/src/config/env.ts)"
  - "query-free request log serializer + logMethod hook (apps/api/src/app.ts)"
  - "API_VERSION in apps/api/src/version.ts (re-exported by app.ts)"
affects: [07-07 (image CMD preload, observability profile), 07-08 (Caddy sets OCW_TRUST_PROXY=1, publishes API on 127.0.0.1), 07-01 (Semgrep AI-telemetry rule)]
tech-stack:
  added: ["@fastify/otel 0.21.0", "@opentelemetry/sdk-node 0.222.0", "@opentelemetry/api 1.9.1", "OTLP/HTTP exporters 0.222.0", "instrumentation-http 0.222.0", "instrumentation-pg 0.74.0", "instrumentation-pino 0.68.0", "sdk-metrics/resources/sdk-trace-base 2.11.0", "sdk-logs 0.222.0", "semantic-conventions 1.43.0"]
  patterns: ["preload with dynamic SDK imports behind an env gate", "redaction at the exporter (copy, never mutate)", "child-process API + local OTLP receiver integration test"]
key-files:
  created:
    - apps/api/src/telemetry.ts
    - apps/api/src/telemetry/redact.ts
    - apps/api/src/telemetry/redact.test.ts
    - apps/api/src/telemetry.int.test.ts
    - apps/api/src/trust-proxy.int.test.ts
    - apps/api/src/version.ts
  modified:
    - apps/api/package.json
    - packages/db/package.json
    - pnpm-lock.yaml
    - apps/api/src/app.ts
    - apps/api/src/config/env.ts
    - apps/api/src/config/env.test.ts
decisions:
  - "Hop-count OCW_TRUST_PROXY is translated to a proxy-addr function because Fastify 5.12.5 fails closed on a numeric trustProxy (trusts nothing)"
  - "@ocw/db also pins @opentelemetry/api 1.9.1 so drizzle-orm (optional OTel peer) resolves to one variant shared with @ocw/api"
  - "Exported logs get the same redaction as spans (RedactingLogRecordExporter): sensitive keys at any depth, query strings and host paths scrubbed"
  - "Pino logMethod hook strips query strings from free-text messages (Fastify's 'Route GET:/x?… not found')"
  - "/health is ignored by both @fastify/otel and the http server instrumentation (healthcheck noise)"
metrics:
  duration: "~95 min wall clock (three full pnpm verify runs of 11-14 min each, one re-run after a session interruption)"
  completed: 2026-10-07
actuals:
  tokens: 12900
  tasks: 3
  commits: 3
---

# Phase 7 Plan 05: OpenTelemetry in the API (off by default, redacted) and OCW_TRUST_PROXY Summary

The API now emits OpenTelemetry over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. That covers `@fastify/otel` request spans with `http.route`, http server spans, pg query spans, the `http.server.request.duration` metric and pino logs carrying `trace_id`. Query strings, credentials, prompts, argv and host paths are stripped before export. Without the endpoint no SDK module is loaded. The client IP now comes from `X-Forwarded-For` only when `OCW_TRUST_PROXY` says so.

## Package legitimacy gate (Task 1)

**Approved** by the orchestrator under the owner's delegated autonomy (checkpoint resolved before this executor ran). The orchestrator checked the pins with `npm view`:
- `@fastify/otel@0.21.0` comes from github.com/fastify/otel, was published 2026-09-06, and has no install scripts.
- `@opentelemetry/sdk-node@0.222.0`, `api@1.9.1`, `instrumentation-pg@0.74.0`, `instrumentation-pino@0.68.0` and `exporter-logs-otlp-http@0.222.0` come from the official open-telemetry repos and have no install scripts.

They were installed exactly at the plan's pins with `pnpm --filter @ocw/api add -E …`. `minimumReleaseAge` was unchanged and accepted every pin; no exclusion was added.

**Resolved versions:** `@fastify/otel` 0.21.0; `@opentelemetry/api` 1.9.1; `sdk-node`, `sdk-logs`, `exporter-{trace,metrics,logs}-otlp-http`, `instrumentation-http` and `instrumentation` 0.222.0; `sdk-metrics`, `sdk-trace-base`, `sdk-trace`, `resources` and `core` 2.11.0; `instrumentation-pg` 0.74.0; `instrumentation-pino` 0.68.0; `semantic-conventions` 1.43.0.

**Nested duplicates:** `@fastify/otel` brings its own `@opentelemetry/instrumentation@0.221.0` and `@opentelemetry/api-logs@0.221.0`, as the research predicted. `sdk-node` also pulls in unused grpc, proto, zipkin and prometheus exporters. They are only loaded when telemetry is on, and our code never imports them.

**Peer variants:** better-auth, next and vitest now resolve to their `@opentelemetry/api` peer variants. better-auth 1.7.6 emits its own spans, and only operation, model and route names were checked in those. drizzle-orm's tracing is compiled out (`hasTelemetry = false`).

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1-2 (deps) | e32a286 | chore(api): add the approved OpenTelemetry packages |
| 2 | 22c2a6e | feat(api): OpenTelemetry preload, off by default and redacted at the source |
| 3 | 49679d2 | feat(api): OCW_TRUST_PROXY and query-free request logs |

## Results (exact)

- **RED observed before implementation:**
  - `redact.test.ts`: failed (module missing).
  - `telemetry.int.test.ts`: the child exited with `ERR_MODULE_NOT_FOUND` for `src/telemetry.ts` (2 failed, 2 skipped).
  - Task 3: env cases 3 failed / 12 passed.
  - Task 3 integration, 4 failed: stdout contained `QUERY-CANARY`; `req.url` was `'/health?token=X'`; the audit IP was `'203.0.113.77'` by default; the 4th spoofed sign-in got 401 instead of 429.
- **Mutation check:** with the span exporter unwrapped and default resource detectors restored, the leak test fails ("not to contain 'QUERY-CANARY'"). The original file was restored afterwards.
- **Unit:** `env.test.ts` 16 passed, `redact.test.ts` 11 passed (27/27).
- **Integration:** `telemetry.int.test.ts` 8, `trust-proxy.int.test.ts` 4 and `identity.int.test.ts` (regression) together gave 21/21 passed across 3 files, with 0 skipped.
- **`pnpm typecheck --force`:** 8/8 tasks successful.
- **`pnpm verify`** (lint + typecheck + all tests):
  - deps commit: 193 files, 2716 tests passed;
  - Task 2 commit: 195 files, 2731 tests passed;
  - Task 3 commit: 196 files, 2743 tests passed (12m36s).
  - Lint shows 4 pre-existing warnings in `apps/local-runtime`, out of scope.

## What the tests prove

- The real API process runs with `node --import tsx --import ./src/telemetry.ts src/main.ts` against testcontainers PostgreSQL and Redis and a local OTLP receiver. It produces:
  - a `@fastify/otel` `request` span with `http.route=/api/v1/me`, an instrumentation-http SERVER span with `http.route` and a `pg.query*` span with `db.query.text`, all in one trace;
  - `http.server.request.duration` labelled `http.route=/api/v1/me`;
  - pino log records whose `traceId`/`spanId` match exported spans, plus `trace_id` on stdout.
- Absent from every exported body (traces, metrics, logs): the query canary, an `Authorization: Bearer` canary, the session cookie value, the setup token, `process.executable.path`, `process.command_args` and the repository's absolute path. The query, cookie, authorization and path checks also hold on stdout.
- With no endpoint (and per-signal endpoints pointed at the receiver), the API boots, `/health` returns 200 and the receiver gets 0 requests. Nothing telemetry-related appears on stdout.
- With the endpoint pointing at a closed port, `/health` keeps returning 200 while exports fail, and the process stays alive.
- Request logs go through the `logStream` hook: `GET /health?token=X` is logged with `req.url` `/health`, and the `/nope?token=X` route-not-found message carries no `token=`.
- `OCW_TRUST_PROXY` unset: a forged `X-Forwarded-For` is not the audited `metadata.ip`, and rotating forged addresses still hits 429 on the 4th sign-in (limit 3).
- `OCW_TRUST_PROXY=1`: the audit records `203.0.113.77`. The same forwarded IP is limited after 3 attempts, while another forwarded IP gets its own bucket.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] drizzle-orm split into two peer variants**
- **Found during:** dependency install.
- **Issue:** adding `@opentelemetry/api` to `@ocw/api` made pnpm resolve drizzle-orm (which has an optional OTel peer) to a different variant than `@ocw/db`'s. That produced two drizzle copies, and `tsc` failed on `CodecsCollection` incompatibility.
- **Fix:** `@ocw/db` pins `@opentelemetry/api` 1.9.1 too. I pointed its lockfile entry at the shared variant and removed the orphan snapshot. `pnpm install --frozen-lockfile` passes. I did not run `pnpm dedupe`, which would also have changed unrelated semver resolutions.
- **Files:** `packages/db/package.json`, `pnpm-lock.yaml`. **Commit:** e32a286.

**2. [Rule 1 - Bug] Fastify 5.12.5 ignores a numeric `trustProxy`**
- **Found during:** Task 3.
- **Issue:** `lib/request.js` returns `() => false` for a number ("Hop-count-only trust cannot validate the immediate peer. Fail closed"), and Fastify's types omit `number`. Passing `OCW_TRUST_PROXY=1` through as-is would never honour the header behind Caddy.
- **Fix:** `fastifyTrustProxy()` turns a count into `(addr, hop) => hop < n`, which is the proxy-addr hop semantics D-18 asked for. Booleans and lists pass through unchanged. Unit-tested, and the int test proves `1` works.
- **Consequence:** the plan's literal acceptance grep `trustProxy: env.OCW_TRUST_PROXY` now reads `trustProxy: fastifyTrustProxy(env.OCW_TRUST_PROXY)`. The intent (trust taken from the env) holds.
- **Commit:** 49679d2.

**3. [Rule 2 - Critical] Leaks the plan's list did not cover**
- **Route-not-found message.** Fastify logs `Route GET:/x?token=… not found` as free text, so the req serializer alone left the query on stdout and in exported logs. Fix: a pino `hooks.logMethod` strips query strings from string arguments.
- **Error stacks and messages in exported logs.** These can carry absolute host paths and sensitive keys. Fix: `RedactingLogRecordExporter` applies the span rules at any depth.
- **Exception stack traces in span events.** These carry host paths. Fix: they are scrubbed, with the repository root replaced by `<app>` and home by `~`. Exception and status messages are scrubbed and capped at 512 characters.
- **Commits:** 22c2a6e, 49679d2.

**4. [Rule 3] `API_VERSION` moved to `src/version.ts`**
- Importing it from `app.ts` in the preload would load the whole app before the instrumentations patch `pg`/`pino`. `app.ts` re-exports it, so callers are unchanged.

**5. [Process] RED tests were not committed separately**
- The orchestrator's rule "`pnpm verify` green before every commit" conflicts with a failing-test commit. Tests were written first and observed failing (output above), then committed together with the implementation once verify was green. The dependency commit was verified with the RED files moved aside.

**6. [Process] Session interruption**
- The Task 3 verify was killed by the session ending (SIGTERM, not a test failure). It was re-run from scratch after resume and passed (numbers above).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: spoofing | apps/api/src/config/env.ts | With a hop count (`OCW_TRUST_PROXY=1`), any peer that reaches the API directly (another compose container, or a host process if the port is published on 0.0.0.0) can set `X-Forwarded-For`. Fastify itself refuses hop counts for this reason. 07-08 must publish the API on 127.0.0.1 in proxy mode as planned, or set the Caddy address/CIDR instead of `1`. Default `false` is safe. |
| threat_flag: info-disclosure | apps/api/src/telemetry.ts | better-auth 1.7.6 now emits its own spans (operation, model and route names; exceptions go through our redaction). The OTLP endpoint is operator-chosen and may be a third party; redaction runs in-process regardless. |

## Known Stubs

None.

## Open items

- **Semgrep check pending.** The acceptance check `node scripts/guard/run.mjs --only semgrep` (the AI-telemetry rule) can only run once 07-01 merges. `experimental_telemetry` is not used anywhere in this plan.
- **Image CMD and compose wiring.** `apps/api/Dockerfile` was not edited (07-03 owns it). 07-07 moves the CMD to `--import ./src/telemetry.ts` and passes `OTEL_EXPORTER_OTLP_ENDPOINT` in compose. `OCW_TRUST_PROXY` is not in `compose.yaml` yet, so the default is false; 07-08 sets it.
- **better-auth session IP.** better-auth may read `x-forwarded-for` on its own when it records `session.ipAddress` (an assumption from research, not verified here). Behind Caddy this is correct. When the API is reached directly, that field could still be spoofed. The sign-in audit and the rate limit use `req.ip` and are fixed.
- **Lockfile merge.** This plan changed `pnpm-lock.yaml` and `packages/db/package.json`. The orchestrator resolves the merge with wave-1 siblings; afterwards, re-check that there is a single `drizzle-orm@1.0.0-rc.4(@opentelemetry/api@1.9.1)…` snapshot.

## Broken-windows entries (for the orchestrator to record in WINDOWS.md)

- `deviation` | `apps/api/src/app.ts` | acceptance grep `trustProxy: env.OCW_TRUST_PROXY` reads `trustProxy: fastifyTrustProxy(env.OCW_TRUST_PROXY)` (Fastify fails closed on numeric trustProxy).
- `unrun-verify` | `scripts/guard/run.mjs` | `--only semgrep` acceptance pending the 07-01 merge.

## Self-Check: PASSED

- FOUND: apps/api/src/telemetry.ts, apps/api/src/telemetry/redact.ts, apps/api/src/telemetry/redact.test.ts, apps/api/src/telemetry.int.test.ts, apps/api/src/trust-proxy.int.test.ts, apps/api/src/version.ts
- FOUND commits: e32a286, 22c2a6e, 49679d2
- `grep '"@fastify/otel": "0.21.0"' apps/api/package.json` matches; `grep "resourceDetectors: \[\]" apps/api/src/telemetry.ts` matches; `grep OCW_TRUST_PROXY apps/api/src/config/env.ts` matches
