# Phase 7: Self-hosted Release - Research

**Researched:** 2026-10-08 (branch `feat/phase-7-self-hosted` @ 099cfb1 = main 5b7d3e9 + 07-CONTEXT; installed packages read
from the main worktree's `node_modules`, same lockfile)
**Domain:** Docker Compose release engineering, PostgreSQL backup/upgrade with RLS roles, OpenTelemetry for Fastify 5 on
Node 24 ESM, OpenBao, Caddy, license/policy guardrails, Playwright against a compose stack
**Confidence:** HIGH for everything read from code or proven by a throwaway experiment this session (listed in Sources);
MEDIUM for observability-backend config details and the OpenBao server-mode profile (smoke-tested only at execution)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: CI is unavailable (GitHub Actions blocked by account billing).** Every check this phase adds to CI
  (upgrade test, license check, Semgrep, Scenario B on compose) must also have a **local entry point** (a `pnpm`
  script or `scripts/*.sh`) that runs the same thing, and the local gate is the merge evidence until CI returns.
  Update `.github/workflows/ci.yml` too, so CI runs them when billing is back. Do not build a self-hosted runner
  (owner decision pending: fix billing vs self-hosted runner).
- **D-02: Object storage is Garage (ADR-0015), not MinIO.** FOUND-06's "minio" wording is outdated; the minimal
  profile is postgres, redis, garage (+ its key setup), migrate, api, web, and the OpenClaw cell where the current
  `compose.yaml` already defines it. Update REQUIREMENTS wording accordingly.
- **D-03: `pnpm ocw` CLI.** One small Node CLI in the repo (no new heavy dependency) with `setup` (wraps/replaces
  `pnpm setup:env`: generates required secrets into `.env` or `*_FILE` files **at setup time, never at boot**, prints
  what it wrote, never prints secret values), `backup`, `restore` (as the migrator role; DB + object storage +
  anything else stateful; documented), and whatever else the success criteria need. Existing `setup:env` behaviour and
  tests must keep working (alias or migrate the tests).
- **D-04: Secrets.** The API already fails fast naming a missing secret (`NAME` or `NAME_FILE`) — keep it. The
  `SecretStore` interface has `env`/`file` and an OpenBao client implementing the same interface, tested (OpenBao in an
  optional compose profile; integration test against a real OpenBao dev container is acceptable).
- **D-05: Observability.** `@fastify/otel` (+ OpenTelemetry SDK) in the API emitting traces, metrics and logs; an
  optional compose profile with Prometheus, Grafana, Loki, Tempo (all self-hosted, pinned versions, no paid service).
  Off by default; enabling it later needs no reinstall. Never export prompt contents, secrets, tokens or absolute host
  paths in spans/logs.
- **D-06: Migrations.** One-shot `migrate` service; the API refuses to start on schema mismatch with a clear message;
  an `N-1 → N` upgrade test (previous release's schema + data → current migrations → API boots, data intact).
  Define "N-1" concretely (e.g. the previous tagged release or the migration set at `main~` / the last phase merge).
- **D-07: Caddy.** A documented Caddy reverse-proxy config (optional compose profile or example file) with a test
  proving WebSocket upgrade, trusted proxy headers and presigned Garage URLs reachable from outside the compose network.
- **D-08: Licenses and policy gates.** Every package.json declares its license (AGPL-3.0-only apps/server; Apache-2.0
  `packages/contracts` and `packages/protocol` if it exists). Dependency-license compatibility check with a free tool.
  Semgrep (open-source CLI, local rules in the repo) fails on permission-bypass tokens; a check fails on skipped policy
  tests; both wired into `pnpm verify` (keep `pnpm verify` fast enough — if Semgrep is slow, a separate `pnpm` script
  called by verify is fine). CODEOWNERS covering db policies, auth, adapters and policy paths (owner: @VictorMinemu).
- **D-09: Scenario B on compose.** Playwright E2E of Scenario B minus Work Zone creation against the compose stack
  (real images, not the dev servers), with the fake model / fakes, no real provider. Local entry point per D-01.
- **D-10: Clean-machine verification** is simulated locally with a fresh clone in a temp directory, a **separate
  compose project name and non-default ports**; the owner repeats it on a real clean machine (human_needed).
- **D-11: Never disturb the running demo** (compose project `t3code-81d72154`, ports 3000/4000, `ocw-demo-*`,
  `~/.ocw-demo`, the `ocw` DB). All phase tests use their own compose projects, ports and volumes, and clean them up.

### Claude's Discretion
- CLI implementation details, profile names, exact tool choices for license checking, how "N-1" is pinned, plan split.

### Deferred Ideas (OUT OF SCOPE)
None listed in CONTEXT.md. Phase boundary: device trust, Work Zone permissions and MVP 2 work are Phase 8+.

**Orchestrator constraint for this research (overrides the D-01 sentence "Update `.github/workflows/ci.yml` too"):**
another agent is setting up a self-hosted runner on the owner's Mac; this phase must not touch `.github/workflows/**`
or `infra/ci-runner/**`. Every check gets a local entry point; the CI wiring is handed off (see Open Question 1).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research support |
|----|-------------------------------|------------------|
| SELF-01 | `git clone` + `pnpm ocw setup` + `docker compose up` yields a working MVP1 instance; OpenBao and observability (Prometheus, Grafana, Loki, Tempo) are optional compose profiles (ADR-0003 amended) | Q1 (gaps), Q3, Q9; profiles via compose `include:` + `COMPOSE_PROFILES` in `.env` (both verified) |
| SELF-02 | Secrets are provided as required inputs (env or `*_FILE`), never generated silently at boot; the `env`/`file` secret provider implements the same `SecretStore` interface as OpenBao | Q2; OpenBao 2.7.1 KV v2 + AppRole verified against a dev container |
| SELF-03 | Migrations run in a one-shot `migrate` service that refuses to start the API on schema mismatch; an `N-1 → N` upgrade test passes in CI | Q4; drizzle 1.0.0-rc.4 migrations table read from source; N-1 = Phase 5 merge `3bbcbd9` |
| SELF-04 | `pnpm ocw backup` / restore work as the migrator role and are documented; data survives `docker compose up --force-recreate` | Q5; dump + drop-schemas + restore + re-migrate as `ocw_migrator` verified on postgres:18 |
| SELF-05 | A tested reverse-proxy configuration (Caddy) handles WebSocket upgrade, trusted proxy headers and presigned object-storage URLs reachable from outside the compose network | Q6; presigned PUT/GET through Caddy 2.11.7 → Garage v2.4.1 verified (200, tampered 403) |
| SELF-06 | Every package declares its license (AGPL-3.0 apps/server, Apache-2.0 for `packages/contracts` and `packages/protocol`) and CI checks dependency-license compatibility (PRD §100) | Q7; all 11 package.json already declare a license; `pnpm licenses list --json -r` in 0.5 s |
| SELF-07 | Scenario B (minus Work Zone creation) runs as a Playwright E2E against the compose stack in CI | Q8; existing spec needs the non-production ChatGPT seed → new production-safe spec on the mock org model |
| FOUND-05 | Fastify Control Plane … emits OpenTelemetry traces/metrics/logs via `@fastify/otel` (ADR-0002, ADR-0003) | Q3; ESM + tsx spike proved fastify/http/pg spans and pino log export without a loader hook |
| FOUND-06 | `docker compose up` minimal profile (postgres, redis, ~~minio~~ garage, api, web, one-shot `migrate`) starts and fails fast with a clear message when a required secret is missing (PRD §5.1) | Q1; `:?` guards exist; wording fix per D-02 |
| FOUND-07 | `pnpm verify` fails on permission-bypass tokens (Semgrep), skipped policy tests, and license violations; CODEOWNERS covers db policies, auth, adapters and policy paths (PITFALLS 13) | Q7; Semgrep 1.178.0 via `uvx` scans the repo in 1.9 s; current hits listed |
</phase_requirements>

## Summary

Phase 7 is release engineering on top of a stack that is mostly built but whose **full compose run has not been
exercised since Phase 1**: the demo runs API and web natively (`scripts/demo-up.sh`), CI's e2e job also runs them
natively, and CI itself has been blocked (billing), so the `images` job has not proven the api/web/openclaw builds for
Phases 2–6.1. The first executable task of the phase must therefore be a tracer that builds the images under a unique
tag and boots the whole stack in an isolated compose project on non-default ports. Everything else hangs off that
harness: Scenario B, the Caddy test, backup/restore, `--force-recreate`, the schema-refusal check and the observability
smoke all run as steps of one Node gate script (`scripts/gate/compose-gate.mjs`), and the clean-machine simulation is
that same gate run from a fresh `git clone` in a temp directory.

Five findings change the plan materially. (1) The current Scenario B spec cannot run on a production image: it seeds a
fake ChatGPT plan through `/api/v1/test/ai/chatgpt-plan`, which only exists when `NODE_ENV !== "production"`; the mock
org model (`OCW_MODEL_PROVIDER=mock`) is allowed in production and becomes everyone's default when no plan is
connected, so a new production-safe spec is straightforward. (2) OpenTelemetry works on Node 24.21 + tsx **without**
the experimental ESM loader (spike: fastify, http and pg spans plus pino log export all appeared), but the defaults
leak: `@fastify/otel` records `url.path` with the query string, `instrumentation-http` records `url.query`, and the
default `ProcessDetector` exports the absolute executable path and command line. (3) `pg_dump`/`pg_restore` as
`ocw_migrator` work because the migrator owns `app`, `auth`, `drizzle` and the two trusted extensions and has
`BYPASSRLS`; a safe restore is "drop the three schemas → `pg_restore --single-transaction` → run `migrate` again",
which also makes restoring an older backup an upgrade. (4) Presigned Garage URLs work through Caddy on the **same
origin** as the app if Caddy routes `/<bucket>/*` to Garage with the Host header untouched (Caddy's default): verified
PUT 200 / GET 200 / tampered 403 / unsigned 403. (5) The API's `trustProxy: true` lets any client spoof
`X-Forwarded-For` today (sign-in rate limit and audit IP); it must become an explicit setting, `false` by default and
`1` behind Caddy.

**Primary recommendation:** build one Node gate (`pnpm gate:compose`) that owns an isolated compose project
(`ocw-gate-<id>`, ports in a 34xx block, images tagged `gate-<sha>`) and runs every heavy check against real images;
keep `pnpm verify` fast by adding a ~3 s `pnpm guard` (Semgrep via pinned `uvx`, native `pnpm licenses`, CODEOWNERS
lint) and making the N-1 upgrade test an ordinary integration test on a committed golden dump.

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|------------|-------------|----------------|-----------|
| Secret generation (`pnpm ocw setup`) | Operator CLI (host) | — | Secrets are inputs written once at setup (Pitfall 12); never in a boot path |
| Secret resolution (env/file/OpenBao) | API (boot, `SecretStore`) | OpenBao (vault profile) | Only the API holds app secrets; OpenBao is optional storage behind one interface |
| Schema migration | One-shot `migrate` container (`ocw_migrator`) | PostgreSQL | Forward-only; the API never migrates (Pitfall 12) |
| Schema-version guard | API boot (`ocw_app` reads `drizzle.__drizzle_migrations`) | — | Protects against image rollback and skipped `migrate` |
| Backup / restore | Operator CLI → `docker compose exec/run` | postgres container (pg tools), api image (S3 SDK) | No host tools beyond Docker + Node; pg tools match server version |
| TLS, routing, client IP | Caddy (proxy profile) | API (`trustProxy` = 1 hop) | Caddy overwrites `X-Forwarded-*` from untrusted clients |
| Presigned object URLs | API (presigner on `OCW_S3_PUBLIC_URL`) | Caddy → Garage (Host preserved) | SigV4 signs the Host; the proxy must not rewrite it |
| Telemetry emission + redaction | API process (OTel SDK) | Collector (defense in depth) | Redaction must hold even if operators point OTLP elsewhere |
| Telemetry storage/visualisation | Observability profile (Prometheus, Loki, Tempo, Grafana) | — | Optional, self-hosted |
| Policy guardrails | `pnpm guard` (dev machine / CI) | CODEOWNERS (GitHub) | Mechanical checks, not instructions (Pitfall 13) |
| Acceptance (Scenario B) | Playwright on host → Caddy → compose images | fake-model container | Real images, no real provider |

## Project Constraints (from CLAUDE.md / AGENTS.md)

- English for code, docs, commits; Conventional Commits with scope (`feat(api):`, `chore:`, `docs(07):` …).
- ADR for every architectural/stack decision (`docs/adr/NNNN-…`; next free number **0021**); never edit an accepted ADR
  (ADR-0003 says MinIO and `vault`/`observability` profiles; supersede/extend, do not edit).
- PRD is authoritative; REQUIREMENTS FOUND-06 wording changes (minio → garage) per D-02.
- Modules only through public `index.ts`; explicit constructor wiring, no DI container (ADR-0002).
- Contracts first (Zod in `packages/contracts`); Zod at every boundary.
- Tests colocated `*.test.ts`; integration tests against real ephemeral PostgreSQL (testcontainers), never DB mocks;
  failing test first (TDD).
- No `any`, no `@ts-ignore` without comment + issue link.
- Tenant isolation is a test target; the app connects as `ocw_app` (no RLS bypass).
- Never weaken a permission check, RLS policy or approval gate to make a test pass; bypass modes only via ADR-0012.
- Never commit secrets/.env; never log absolute host paths, prompts with credentials or provider keys.
- No paid/metered service; open source first; everything works with `docker compose up`.
- Exact dependency versions; pnpm `minimumReleaseAge: 10080` (7 days) and `allowBuilds` allowlist in
  `pnpm-workspace.yaml` — new packages must be ≥ 7 days old on install day.
- `pnpm verify` must pass before any commit; show verification output before claiming done.
- Destructive commands and migrations against non-ephemeral DBs need human confirmation → `ocw restore` requires
  `--yes`, and no phase test touches the demo DB (D-11).
- Developer profile: outcome first, proportional solutions, no unrequested mechanisms, never regress the demo.

## Standard Stack

### Core (new in this phase)

| Library / image | Version (pin) | Purpose | Why standard |
|-----------------|---------------|---------|--------------|
| `@opentelemetry/sdk-node` | 0.222.0 (2026-08-31) | SDK bootstrap (traces, metrics, logs) | Official; STACK.md Decision 7 [VERIFIED: npm registry] |
| `@opentelemetry/api` | 1.9.1 | API | Peer of everything [VERIFIED: npm registry] |
| `@opentelemetry/exporter-{trace,metrics,logs}-otlp-http` | 0.222.0 | OTLP/HTTP (JSON) → collector | JSON is greppable in tests; collector accepts it [VERIFIED: npm registry] |
| `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base` | 2.11.0 | Metric reader, explicit resource, processors/in-memory exporter for tests | Same generation as sdk-node 0.222 [VERIFIED: npm registry] |
| `@opentelemetry/sdk-logs` | 0.222.0 | Log record processors | Same generation [VERIFIED: npm registry] |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Attribute names | Already in the lockfile [VERIFIED: node_modules] |
| `@fastify/otel` | 0.21.0 (0.21.1 if installing on/after 2026-10-09) | Fastify request/hook spans, sets `http.route` | `@opentelemetry/instrumentation-fastify` was removed (STACK.md) [VERIFIED: npm registry] |
| `@opentelemetry/instrumentation-http` | 0.222.0 | Server/client spans + `http.server.request.duration` metric | Required by `@fastify/otel` for propagation [CITED: @fastify/otel README] |
| `@opentelemetry/instrumentation-pg` | 0.74.0 | DB spans (`db.query.text`, no parameter values by default) | Verified in spike |
| `@opentelemetry/instrumentation-pino` | 0.68.0 | `trace_id` injection + log export (parses the already-redacted line) | Verified in spike |
| Semgrep CLI (PyPI) | 1.178.0 (2026-09-23), run via `uvx --from semgrep==1.178.0 semgrep` | Policy rules | LGPL-2.1+, local rules, `--metrics=off` [VERIFIED: PyPI, uvx run] |
| `caddy` | `2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | Reverse proxy + auto TLS | Verified with Garage this session |
| `openbao/openbao` | `2.7.1@sha256:6d2b93856e3fcf7b18ad855a0b51eaba474dc8b79cf554379ea32034797d2acf` | Optional secret store (`vault` profile) | MPL-2.0; digest verified on pull |
| `otel/opentelemetry-collector-contrib` | `0.161.0@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1` | OTLP fan-out, defense-in-depth redaction | `transform`/`attributes` processors are contrib-only |
| `prom/prometheus` | `v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e` | Metrics (OTLP receiver) | `--web.enable-otlp-receiver` [CITED: prometheus.io/docs/guides/opentelemetry] |
| `grafana/loki` | `3.7.8@sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193` | Logs (native OTLP at `/otlp`) | [CITED: grafana.com/docs/loki/latest/send-data/otel] |
| `grafana/tempo` | `3.1.0@sha256:3076b8dcdfb32fd6bc5ccef85e7b7313e6199b9cb84366257fc17ecb696db5fd` | Traces (monolithic, local storage, no Kafka) | [CITED: Tempo migrate-to-3 guide]; fallback `3.0.3` |
| `grafana/grafana` | `13.2.3@sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572` | Dashboards | Provisioned datasources only |

Digests are the Docker Hub index digests fetched 2026-10-08 [VERIFIED: hub.docker.com API]. Pin `image: name:tag@sha256:…`
like `searxng` already is in `compose.yaml:193`.

### Not added (decided against)

| Instead of | Could use | Why not |
|-----------|-----------|---------|
| In-house OpenBao `fetch` client (~150 lines) | `node-vault`, `@litehex/node-vault` | STACK.md Decision 7: no official JS client; the API surface we need is 3 calls |
| `pnpm licenses list --json -r` + 80-line script | `license-checker` (last publish 2022), `license-checker-rseidelsohn`, `licensee` | Native, 0.5 s, understands pnpm workspaces; no new dependency |
| Semgrep via `uvx` (pinned) | Homebrew semgrep (1.157 locally, unpinned), Docker `semgrep/semgrep:1.178.0` | `uvx` is pinned and fast; Docker image is the fallback when `uv` is absent |
| Redis / undici OTel instrumentations | `instrumentation-redis`, `instrumentation-undici` | Redis PUBLISH payloads carry chat content; outbound fetch spans add `url.full`; not needed for D-05 |
| `grafana/otel-lgtm` all-in-one | — | Grafana markets it for dev/demo; D-05 names the four components |
| Second hostname for S3 | `files.example.com` | Same-origin `/<bucket>/*` route works (verified) and needs no extra DNS/cert/CORS |
| bash gate scripts | Node `.mjs` | macOS ships bash 3.2 (verified); BSD vs GNU `sed`/`date`/`mktemp` differences |

**Installation (apps/api only; on/after the 7-day window):**
```bash
pnpm --filter @ocw/api add -E @opentelemetry/api@1.9.1 @opentelemetry/sdk-node@0.222.0 \
  @opentelemetry/sdk-metrics@2.11.0 @opentelemetry/sdk-logs@0.222.0 @opentelemetry/sdk-trace-base@2.11.0 \
  @opentelemetry/resources@2.11.0 @opentelemetry/semantic-conventions@1.43.0 \
  @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 \
  @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/instrumentation-http@0.222.0 \
  @opentelemetry/instrumentation-pg@0.74.0 @opentelemetry/instrumentation-pino@0.68.0 @fastify/otel@0.21.0
```

## Package Legitimacy Audit

| Package | Registry | Age (pinned version) | Source repo | Verdict (seam) | Disposition |
|---------|----------|----------------------|-------------|----------------|-------------|
| `@opentelemetry/api` 1.9.1 | npm | 6 mo | github.com/open-telemetry/opentelemetry-js | OK | Approved |
| `@opentelemetry/semantic-conventions` 1.43.0 | npm | 3 mo (already installed) | same | OK | Approved |
| `@opentelemetry/sdk-node`, `sdk-logs`, `api-logs`, exporters, `instrumentation`, `instrumentation-http` 0.222.0; `sdk-metrics`, `resources`, `sdk-trace-base` 2.11.0 | npm | 38 days | opentelemetry-js | SUS ("too-new" — the seam checks the **latest** 0.223.0 / 2.12.0 published 2026-10-06, not our pins) | Flagged — one consolidated `checkpoint:human-verify` before the install task |
| `@opentelemetry/instrumentation-pg` 0.74.0, `instrumentation-pino` 0.68.0 | npm | 38 days | opentelemetry-js-contrib | SUS (same reason) | Flagged — same checkpoint |
| `@fastify/otel` 0.21.0 | npm | 32 days | github.com/fastify/otel | SUS (latest 0.21.1 is 6 days old) | Flagged — same checkpoint |

No `postinstall`/`install` scripts on any pinned version [VERIFIED: `npm view <pkg>@<ver> scripts`]; all Apache-2.0 except
`@fastify/otel` (MIT). pnpm's `minimumReleaseAge: 10080` mechanically refuses anything younger than 7 days.
**Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** the OTel set above (age heuristic on `latest`).
Note: `@fastify/otel@0.21.0` depends on `@opentelemetry/instrumentation@^0.221.0`, so a second (0.221.x) copy is nested
under it; the spike showed this works. `0.21.1` depends on `^0.222.0` and becomes installable 2026-10-09 ~08:43 UTC.

---

## Q1. Current state: what `docker compose up` runs and what is missing

**What `compose.yaml` defines today** [VERIFIED: compose.yaml:13-241, read this session]:

| Service | Image | Notes |
|---------|-------|-------|
| `postgres` | `postgres:18` | volume `pgdata:/var/lib/postgresql` (correct parent for PG 18), loopback `${OCW_POSTGRES_PORT:-54329}` |
| `redis` | `redis:8` | no named volume (anonymous `/data` from the image); ephemeral by ADR-0003 |
| `garage` | `dxflrs/garage:v2.4.1` | `["/garage","server","--single-node","--default-bucket"]` creates layout, key and bucket from `GARAGE_DEFAULT_*`; volumes `garage-meta`, `garage-data`; loopback `${OCW_S3_PORT:-3900}`; no healthcheck (no shell in image) |
| `migrate` | `ocw-api:local` (built from `apps/api/Dockerfile`) | `working_dir: /app/packages/db`, `command: ["node", "--import", "tsx", "src/migrate-cli.ts"]`, superuser bootstrap + `ocw_migrator` migrations |
| `api` | `ocw-api:local` | `NODE_ENV: production`, `ports: "${OCW_API_PORT:-4000}:4000"` (**all interfaces**), depends on `migrate: service_completed_successfully`, `redis: service_healthy`, `garage: service_started`; healthcheck in Dockerfile (`fetch('http://127.0.0.1:4000/health')`) |
| `web` | `ocw-web:local` | `OCW_PUBLIC_API_URL` read at request time; `ports: "${OCW_WEB_PORT:-3000}:3000"` |
| `openclaw` | `ocw-openclaw:local` (~5 GB) | cell token via compose secret `environment: OCW_CELL_TOKEN`; volume `openclaw-state:/home/node/.openclaw` |
| `searxng` | profile `search` | pinned by digest (the pattern to copy) |
| `mcp-sandbox` | profile `mcp-sandbox` | internal network only |

`compose.e2e.yaml` adds `fake-model` and puts api/openclaw on an internal network with `OCW_MODEL_PROVIDER: mock`.
Required secrets already fail fast at interpolation time with `:?` guards (`compose.yaml:9-10,20,76,93-95,100`), and the
API fails fast naming `NAME`/`NAME_FILE` (`apps/api/src/config/env.ts:243-256`). FOUND-06's behaviour exists; it needs a
test and the wording fix.

**Gaps against the success criteria**

1. **The full image path is unproven.** Nothing has booted `api`/`web`/`openclaw` images since Phase 1 (ROADMAP
   "Not verified"), and CI's `images` job cannot run (D-01). Risks to check first: the pruned `--prod` install still
   has every runtime import (only `import type` from `ws` was found outside tests — erased by tsx); `sharp` builds under
   `allowBuilds`; the web standalone bundle includes workspace packages. → Wave-1 tracer task.
2. **Image tags collide with the demo (D-11).** Every service hard-codes `:local`; the demo's running cell uses
   `ocw-openclaw:local` (built 7 h before this research). A gate `--build` would retag it. → `image:
   ocw-<svc>:${OCW_IMAGE_TAG:-local}` on api, migrate, web, openclaw, fake-model, mcp-sandbox.
3. **No schema-version guard, no backup/restore, no proxy, no observability/vault profiles** (Q3–Q6).
4. **Ports are parameterized but public URLs are not derived from them.** Changing `OCW_API_PORT` without
   `OCW_PUBLIC_API_URL` breaks the web; `pnpm ocw setup --ports …` must write both.
5. **API published on 0.0.0.0 with `trustProxy: true`** (`apps/api/src/app.ts:88`) → spoofable client IP (Q6).
6. **Garage key setup is already automatic** (`--default-bucket`); the only operator duty is keeping
   `GARAGE_RPC_SECRET` and the key pair stable across restarts (setup writes them once; `--force` rotates — document).
7. **OpenClaw cell** is part of the default stack; Scenario B does not need it, but the gate should keep it in (it is
   the MVP1 instance) and wait for `healthy`.
8. **mcp-sandbox** needs nothing for this phase (profile stays off; it is not stateful, no backup).

## Q2. Secrets

**Today** [VERIFIED: apps/api/src/lib/secret-store.ts:8-34; apps/api/src/config/env.ts:219-256; packages/db/src/env.ts:4-10]:

```ts
export type SecretReference =
  | { provider: "env"; key: string }
  | { provider: "file"; path: string }
  | { provider: "db"; secretId: string; organizationId: string };
export interface SecretStore {
  resolveSync(ref: SecretReference): string;
}
```
`SECRET_VARS` = `"DATABASE_URL", "AUTH_DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "OCW_SETUP_TOKEN",
"OCW_ENCRYPTION_KEY", "OCW_CELL_TOKEN", "OCW_SMTP_URL"` are read with `readEnvOrFile` (`NAME`, else file at
`NAME_FILE`), then Zod-validated; errors read `  - NAME: <msg> (set NAME or NAME_FILE)`. `OCW_S3_SECRET_ACCESS_KEY` is
resolved through `SecretStore.resolveSync({ provider: "env", key })` (`apps/api/src/modules/artifact/storage.ts:79-101`).
Nothing is generated at boot; `scripts/setup-env.mjs` generates everything at setup time (mode 0600).

**OpenBao design (recommended)**

- **Interface:** keep `resolveSync` (callers are synchronous) and make OpenBao a *preloaded* store:
  `await createOpenBaoSecretStore(cfg)` logs in, reads one KV v2 secret, keeps the fields in memory, and serves
  `resolveSync`. Add `{ provider: "openbao"; mount: string; path: string; field: string }` to `SecretReference`. A
  `createChainedSecretStore([envFile, openBao])` keeps env/file precedence. One shared contract test runs
  `describe.each` over both stores (the "same interface" proof for SELF-02).
- **How a secret points to OpenBao without breaking compose `:?` guards:** the env value is a reference URI, e.g.
  `OCW_ENCRYPTION_KEY=openbao://secret/ocw/api#OCW_ENCRYPTION_KEY`. `loadEnv` becomes `loadConfig()` (async): it
  resolves any `SECRET_VARS` value starting with `openbao://` through the store before Zod parsing. Compose stays
  unchanged, the guard still fires when the variable is missing, and the value in `.env` is a reference, not a secret
  (AGENTS principle 8). `pnpm ocw vault migrate` writes the values into KV and rewrites the `.env` lines.
- **Which secrets can move:** API-only ones — `BETTER_AUTH_SECRET`, `OCW_ENCRYPTION_KEY`, `OCW_SETUP_TOKEN`,
  `OCW_SMTP_URL`. The DB passwords (also used by postgres/migrate), `OCW_CELL_TOKEN` (shared with the cell) and the S3
  key pair (shared with Garage) stay env/file.
- **KV v2 wire format** [VERIFIED: openbao/openbao:2.7.1 dev container, this session]: dev mode mounts `secret/` as KV
  `{"version":"2"}`; `GET /v1/secret/data/<path>` with header `X-Vault-Token` returns `{ data: { data: {...},
  metadata: { version, created_time, … } } }`; 403 `{"errors":["permission denied"]}` outside policy or with a bad
  token; 404 for a missing path.
- **Auth for self-hosted: AppRole** (`POST /v1/auth/approle/login {role_id, secret_id}` → `auth.client_token`,
  `lease_duration` 3600, `renewable: true`, policies `["default","ocw-api"]` — verified). Read once at boot, then
  optionally `POST /v1/auth/token/revoke-self`; no renewal loop needed. Token auth (`OCW_OPENBAO_TOKEN[_FILE]`) as the
  simple/dev alternative. Config vars: `OCW_OPENBAO_ADDR`, `OCW_OPENBAO_ROLE_ID`, `OCW_OPENBAO_SECRET_ID[_FILE]`,
  `OCW_OPENBAO_TOKEN[_FILE]`.
- **Errors:** 403/401 → `EnvError` naming the path and the policy hint, never the value; 404 or missing field →
  `MissingSecretError` naming `openbao://…#FIELD`; network error → fail fast at boot with the address.
- **Tests:** `apps/api/src/lib/openbao.int.test.ts` with testcontainers `GenericContainer("openbao/openbao:2.7.1@sha256:6d2b…")`,
  env `BAO_DEV_ROOT_TOKEN_ID`, `BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200` (image default cmd is
  `["server","-dev","-dev-no-store-token"]`), wait on `/v1/sys/health`; set up approle + policy with the root token as in
  the experiment; assert read, 403, 404, bad secret_id, and that error messages never contain the canary value.
- **Compose `vault` profile** (ADR-0003 name): `openbao` server mode (not dev mode — dev is in-memory), storage on a
  named volume, `seal "static"` auto-unseal with a 32-byte key file generated by `pnpm ocw setup --vault` (OpenBao docs:
  static seal exists and is configured by a `seal "static"` block with `current_key_id`/`current_key`
  [CITED: openbao.org/docs/configuration/seal/static]; exact HCL [ASSUMED] — smoke-test it). Not published, or
  loopback-only. `pnpm ocw vault init` runs `bao operator init` once, enables `secret/` KV v2 and AppRole, writes
  policy `path "secret/data/ocw/*" { capabilities = ["read"] }`, creates role `ocw-api`, writes role_id/secret_id
  into `.env`, revokes the root token.

## Q3. Observability

**Spike result** (throwaway, Node 24.21.0, `fastify@5.12.5`, `pg@8.23.0`, `pino@10.3.1`, `tsx@4.23.15`, the pins
above): `node --import tsx --import ./telemetry.ts app.ts` produced `@fastify/otel` `request` + handler spans with
`http.route`, an `instrumentation-http` server span, `pg.query:SELECT` with `db.query.text` (no parameter values),
pino stdout lines with `trace_id`/`span_id`, and OTel log records — **with and without**
`--experimental-loader=@opentelemetry/instrumentation/hook.mjs`. Node 24's CJS hooks patch packages imported from ESM.
Recommendation: no loader flag (it prints an ExperimentalWarning and OTel docs mark it as transitional
[CITED: github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md]); keep a test that fails if pg spans
disappear.

**Leaks found in the spike (must be redacted):**
- `@fastify/otel` request span: `"url.path":"/items/42?token=QUERY-CANARY"` (query string included) [VERIFIED:
  `@fastify/otel@0.21.0/index.js` sets `[ATTR_URL_PATH]: request.url`].
- `instrumentation-http` server span: `"url.query":"token=QUERY-CANARY"`.
- Pino request log (stdout and exported): `"req":{"url":"/items/42?token=QUERY-CANARY",…}`.
- Default resource detectors: `process.executable.path` (absolute host path, e.g. `/Users/…/node`) and
  `process.command_args`.
- AI SDK 7: `experimental_telemetry` records inputs/outputs **by default** (`recordInputs`/`recordOutputs`, "Enabled by
  default") [VERIFIED: ai@7.0.122 dist/index.d.ts:1070-1085]. Do not enable it in this phase; add a Semgrep rule.
- Not leaking: pino redaction applies to exported logs (OTel stream parses the serialized line; verified with a
  redacted field → `"[Redacted]"`); pg parameter values are not recorded (`enhancedDatabaseReporting` off by default).

**Wiring (explicit, one file, no-op by default)** — `apps/api/src/telemetry.ts`, loaded with
`node --import tsx --import ./src/telemetry.ts src/main.ts` (Dockerfile `CMD`, `start`, `dev`):
- Start the SDK **only** when `OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty; otherwise return before importing the SDK.
  (Started without config, NodeSDK logs `OTEL_METRICS_EXPORTER is empty. Using default otlp exporter.` and would push to
  localhost.) Never throw: on SDK init error, `console.warn` once and continue.
- `resourceDetectors: []` + `resource: resourceFromAttributes({ "service.name": "ocw-api", "service.version":
  API_VERSION, "deployment.environment.name": NODE_ENV })`.
- `spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))]`,
  `metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]`,
  `logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]`
  (field names verified in `sdk-node@0.222.0` `types.d.ts`; **sdk-logs 0.222 processors take an options object** —
  `new SimpleLogRecordProcessor(exporter)` fails at runtime with `Cannot read properties of undefined (reading 'export')`,
  hit in the spike).
- `instrumentations: [new HttpInstrumentation(), new PgInstrumentation(), new PinoInstrumentation(),
  new FastifyOtelInstrumentation({ registerOnInitialization: true, ignorePaths: (o) => o.url === "/health" })]`.
- `RedactingSpanExporter`: before export, replace `url.path` with `http.route` (or drop it), delete `url.query`,
  `url.full`, `http.target`, `http.url`; cap `exception.message` length; drop any attribute whose key matches
  `/token|secret|password|authorization|cookie|prompt/i`. Unit-tested with fabricated spans (canaries).
- Pino: add `serializers.req` in `app.ts` that strips the query string from `req.url` (fixes stdout too).
- Metrics: `http.server.request.duration` (from instrumentation-http, labelled with `http.route` that `@fastify/otel`
  sets on RPC metadata) is enough for D-05; runtime metrics optional.

**Observability profile** (`observability`, ADR-0003 name) in `infra/observability/compose.yaml`, included from
`compose.yaml`:
- `otel-collector` (contrib 0.161.0): receivers `otlp` (http 4318, grpc 4317); processors `memory_limiter`, `batch`,
  `transform`/`attributes` deleting `url.query`/`url.full` (defense in depth); exporters `otlp/tempo` (`tempo:4317`,
  insecure), `otlphttp/prometheus` (`http://prometheus:9090/api/v1/otlp`), `otlphttp/loki` (`http://loki:3100/otlp`).
- `prometheus` v3.13.4 with `--web.enable-otlp-receiver`, `otlp.promote_resource_attributes: [service.name,
  service.version]`, `storage.tsdb.out_of_order_time_window: 30m` [CITED: prometheus.io/docs/guides/opentelemetry],
  retention `--storage.tsdb.retention.time=15d`.
- `loki` 3.7.8 single binary, filesystem storage, `limits_config.allow_structured_metadata: true` (default in 3.x)
  [CITED: grafana.com/docs/loki/latest/send-data/otel].
- `tempo` 3.1.0 monolithic, local backend, `distributor.receivers.otlp`; no `ingester`/`compactor` blocks (removed in
  3.0, no Kafka in monolithic mode) [CITED: grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/migrate-to-3];
  exact YAML [ASSUMED] → smoke test.
- `grafana` 13.2.3 with provisioned datasources (Prometheus, Loki with `derivedFields` → Tempo, Tempo with
  traces-to-logs → Loki); admin password from `GF_SECURITY_ADMIN_PASSWORD__FILE` or an env value written by setup
  (never the default `admin`); published `127.0.0.1:${OCW_GRAFANA_PORT:-3301}`; anonymous off.
- Named volumes per backend. Telemetry is not backed up (documented).
- **Enable later without reinstall:** `pnpm ocw enable observability` appends `observability` to `COMPOSE_PROFILES`,
  sets `OCW_OTEL_ENDPOINT=http://otel-collector:4318` and the Grafana password in `.env`, then `docker compose up -d`
  recreates only `api` and starts the profile. Compose honours `COMPOSE_PROFILES`/`COMPOSE_FILE` from `.env`
  [VERIFIED: compose v5.3.1 experiment]. `compose.yaml` passes `OTEL_EXPORTER_OTLP_ENDPOINT: ${OCW_OTEL_ENDPOINT:-}` and
  `OTEL_SERVICE_NAME: ocw-api` to `api`.

## Q4. Migrations, schema guard, N-1 → N

**How drizzle 1.0.0-rc.4 tracks migrations** (there is **no** `meta/_journal.json` any more — `readMigrationFiles`
throws if one exists): local migrations are the folders under `packages/db/drizzle/`, sorted by name, each with
`hash = sha256(migration.sql)` [VERIFIED: drizzle-orm migrator.js:7-33]. The DB table is
`drizzle.__drizzle_migrations (id serial, hash text, created_at bigint, name text, applied_at timestamptz)`, and
pending = local names not in the DB names [VERIFIED: pg-core/async/session.js:136-172; migrator.utils.js
`getMigrationsToRun`]. Verified on a real run: 17 rows, newest `20261007173205_work_prompt_image_order`.

**Schema guard (API refuses to start):** `packages/db/src/schema-check.ts`:
```ts
import { readMigrationFiles } from "drizzle-orm/migrator";
// local = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).map(m => ({ name: m.name, hash: m.hash }))
// db    = select name, hash from drizzle.__drizzle_migrations order by id   (as ocw_app)
// ok        : same names in order and equal hashes
// behind    : db ⊂ local          → "Database schema is behind this API (N pending, newest X). Run: docker compose run --rm migrate"
// ahead     : db has names local lacks → "Database was migrated by a newer release (unknown: Y). Restore a backup or run the newer image."
// diverged  : same name, different hash → "Migration X was modified after it was applied."
// missing   : schema/table absent or permission denied → treated as behind ("never migrated")
```
Called in `apps/api/src/main.ts` after `loadConfig()` and before `buildApp`; `console.error` + `process.exit(1)`
(same shape as `EnvError`). `post-migrate.sql` must add `GRANT USAGE ON SCHEMA drizzle TO ocw_app; GRANT SELECT ON
drizzle.__drizzle_migrations TO ocw_app;` (today no grant exists — `packages/db/sql/post-migrate.sql:6-24`). Every dev
path already migrates before starting the API (`demo-up.sh:20`, `e2e-isolated.sh:143`, CI e2e), so the guard does not
regress them. Compose behaviour: `migrate` fails → `api` never starts; image rollback → `api` exits 1 and restarts
with the message (`restart: unless-stopped`), `web` stays waiting on `api: service_healthy`.

**N-1 definition:** the **Phase 5 merge on main, `3bbcbd9`** (last merge whose migration set is a strict prefix of
HEAD's and differs from it). From it to HEAD: 3 migrations (`20261007073058_multiplayer_ai` 91 lines,
`20261007163629_work_prompt_images`, `20261007173205_work_prompt_image_order`) + a changed `post-migrate.sql`
(+21 lines). Checked: every baseline migration file is byte-identical at HEAD (append-only holds). Phase 6.1's merge
`5b7d3e9` = HEAD's set, so it would be a no-op upgrade. Rule: at the end of this phase tag `v0.1.0` (MVP 1); from then
on N-1 = the previous release tag.

**Upgrade test design (fast, in `pnpm test`):**
- Committed golden dump `packages/db/test/upgrade/phase-5-3bbcbd9.sql` (plain `pg_dump -Fp` as `ocw_migrator`,
  reviewable text) containing the N-1 schema, its `drizzle.__drizzle_migrations` rows and representative data
  (organization, admin + member users/accounts, org_members, a channel with messages + versions + thread, a DM, an AI
  chat with a turn and usage record, an agent/bot, an encrypted `app.secrets` row sealed with a fixed test key, a
  model provider with `secret_ref`, audit and stream events, an attachment row).
- Generated reproducibly by `packages/db/scripts/upgrade-baseline.mjs <ref>`: `git archive <ref> packages/db/drizzle
  packages/db/sql` → temp dir → fresh `postgres:18` testcontainer → bootstrap + migrate with those files → load
  `packages/db/test/upgrade/seed-phase-5.sql` → `pg_dump`. Committing the dump keeps the test working in shallow
  clones and without git.
- `packages/db/src/upgrade.int.test.ts`: fresh testcontainer → bootstrap roles → restore the golden dump as
  `ocw_migrator` (same code path as `ocw restore`) → `runMigrations()` (HEAD) → assertions: schema check `ok`; row
  counts per seeded table unchanged; seeded rows readable as `ocw_app` inside `withTenant` and invisible cross-tenant;
  FORCE RLS on every org table; the sealed secret still decrypts with the test key; `buildApp()` boots against it and
  `/health` is 200. Second test: append-only guard — every baseline migration name+hash equals HEAD's.
- Image-level upgrade (old images → new images) is optional in the compose gate; the DB test is the CI-grade check.

## Q5. Backup and restore

**Verified this session on `postgres:18` with the real migrations and roles:**
- `pg_dump -Fc` as `ocw_migrator` (full database, no `-n`) dumps schemas `app`, `auth`, `drizzle` (all owned by
  `ocw_migrator`), extensions `pg_trgm` and `unaccent` (in schema `app`), policies, grants. With `-n app -n auth -n
  drizzle` the extensions are **dropped from the dump** (restore would then fail on functions using `unaccent`) → dump
  the whole database.
- Restore into an empty database as `ocw_migrator` (`pg_restore --exit-on-error --single-transaction`) → exit 0; RLS
  intact (`ocw_app` sees 0 rows without tenant, 1 with `set_config('app.organization_id', …, true)`), 17 migration rows,
  56 policies, `relforcerowsecurity = t`.
- `pg_restore --clean --if-exists` over a live schema also works, **but** leaves objects that are not in the dump
  (tables added by newer migrations), after which `migrate` would try to create them again. The safe sequence (verified):
  `DROP SCHEMA IF EXISTS app, auth, drizzle CASCADE` as `ocw_migrator` (also drops the two extensions it owns) →
  `pg_restore --exit-on-error --single-transaction` → run `migrate` (idempotent; upgrades an older backup; re-applies
  grants/policies) → start the app.
- `ocw_migrator` has `BYPASSRLS`, so the dump is complete (a dump as `ocw_app` would export zero rows — Pitfall 1).

**`pnpm ocw backup [--out DIR] [--project NAME] [--env-file F] [--consistent]`** (Node, builtins only):
1. `docker compose exec -T postgres pg_dump -U ocw_migrator -d ocw -Fc` → `DIR/db.dump` (server-version pg tools;
   inside the container the official image's local socket auth applies; pass `PGPASSWORD` from `.env` to be explicit).
2. Objects through the S3 API using the api image and its own config:
   `docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v DIR:/backup api node --import tsx
   src/cli/object-store.ts export /backup/objects` → one file per key + `objects.json` (key, size, ETag,
   content-type, sha256). Works for any S3 backend.
3. `openclaw-state` volume: `docker compose stop openclaw` (SQLite auth store inside), tar the volume through a
   throwaway container using an image already present (e.g. the postgres image), `start openclaw`.
4. `manifest.json`: created_at, API version, git sha, migration names (= schema version), component checksums, compose
   project. Files written 0600 in a 0700 directory; **the backup contains secrets** (sealed `app.secrets`, cell
   sign-ins) and needs `.env` (`OCW_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`) to be usable — back `.env` up separately;
   `ocw backup` never copies `.env` by default.
5. Default is online (pg_dump is transactionally consistent; objects listed after the dump → at worst unreferenced
   extras); `--consistent` stops `api web openclaw` for the duration.

**`pnpm ocw restore DIR --yes`:** verify checksums → refuse if the manifest lists migrations unknown to this code
(newer backup) → `stop api web openclaw` → `up -d --wait postgres redis garage` → `run --rm migrate` (ensures roles on
a fresh volume) → drop schemas → `pg_restore` (stdin, custom format) → `run --rm migrate` → objects import (PUT with
stored content type; Garage on a fresh volume recreates key + bucket from `.env`) → restore `openclaw-state` →
`up -d --wait`. Requires `--yes` (destructive; AGENTS).

**`--force-recreate` survival:** all state is in named volumes (`pgdata`, `garage-meta`, `garage-data`,
`openclaw-state`); `up --force-recreate` keeps named volumes and reuses anonymous ones unless `-V`. Redis is ephemeral by
design (ADR-0003: "Nothing durable lives only in Redis"). Gate check: counts + sign-in + attachment download before
and after `docker compose up -d --force-recreate --wait`.

## Q6. Caddy

**Topology (recommended): one origin** `https://{$OCW_SITE_ADDRESS}`:
```caddyfile
{
	admin off
}
{$OCW_SITE_ADDRESS} {
	encode zstd gzip
	@agentchannel path /agent-channel/*
	respond @agentchannel 404                 # cell ↔ API traffic stays on the compose network
	@api path /api/* /ws /runtime/ws /docs /docs/* /health
	handle @api {
		reverse_proxy api:4000
	}
	@objects path /{$OCW_S3_BUCKET}/*        # presigned Garage URLs: Host passes through unchanged
	handle @objects {
		reverse_proxy garage:3900
	}
	handle {
		reverse_proxy web:3000
	}
}
```
API prefixes are `/api/v1/*`, `/api/auth/*` (better-auth `basePath`), `/ws`, `/runtime/ws`, `/agent-channel/v1/*`,
`/docs`, `/health` (`apps/api/src/modules/*/index.ts` prefixes; `identity/auth.ts:96`); the web has no `/api` routes and
reads only `OCW_PUBLIC_API_URL` (browser calls the API directly, `apps/web/lib/runtime-config.ts`), so one origin
gives `OCW_PUBLIC_WEB_URL = OCW_PUBLIC_API_URL = OCW_S3_PUBLIC_URL = https://<site>`: no CORS, same-site cookies,
`wss://<site>/ws`.

**Presigned URLs** — verified this session: `S3Client({ endpoint: "https://localhost:18743", forcePathStyle: true,
requestChecksumCalculation: "WHEN_REQUIRED" })` (same options as `storage.ts:55-70`) signs
`https://localhost:18743/ocw-attachments/<key>?X-Amz-…`; through `caddy:2.11.7-alpine` (`tls internal` for
`localhost`) to Garage v2.4.1: **PUT 200, GET 200, tampered key 403, unsigned 403**. Why it works: SigV4 signs Host and
path; Caddy forwards Host unchanged by default ("By default, Caddy passes through incoming headers—including `Host`—to
the backend") [CITED: caddyserver.com/docs/caddyfile/directives/reverse_proxy]; Garage has no `root_domain` so only
path-style is used. **Never** mount S3 under a stripped prefix (`handle_path /s3/*`): the signed path would differ.

**Trusted proxy headers:** Caddy ignores incoming `X-Forwarded-*` from untrusted clients and sets fresh
`X-Forwarded-For/Proto/Host` ("by default, the proxy will ignore their values from incoming requests, to prevent
spoofing"; `trusted_proxies` default: none) [CITED: caddyserver.com docs]. The API side: replace `trustProxy: true`
(`app.ts:88`) with `env.OCW_TRUST_PROXY` (`false` | `true` | hop count | comma list of IPs/CIDRs; **default `false`**).
Proxy mode sets `OCW_TRUST_PROXY=1` and `OCW_PUBLISH_ADDRESS=127.0.0.1` (compose ports become
`"${OCW_PUBLISH_ADDRESS:-0.0.0.0}:${OCW_API_PORT:-4000}:4000"`) so only Caddy reaches the API from outside.
Nothing reads `req.protocol`/`req.hostname` today (grep), and no proxy sets XFF today, so `false` regresses nothing.
`req.ip` feeds the sign-in rate limit and audit (`identity/routes.ts:80` writes `metadata: { email, ip: req.ip, … }`
for `"user.sign_in_failed"`). better-auth reads `x-forwarded-for` itself for the session IP [ASSUMED]; Caddy's
overwrite makes that correct behind the proxy.

**Compose:** `infra/caddy/compose.yaml` (profile `proxy`, included), ports
`${OCW_PROXY_HTTP_PORT:-80}:80`, `${OCW_PROXY_HTTPS_PORT:-443}:443` (+ `443/udp`), volumes `caddy-data`
(certificates — back up or lose rate-limit budget), `caddy-config`. Env `OCW_SITE_ADDRESS`, `OCW_S3_BUCKET`.
`pnpm ocw setup --domain ocw.example.com` writes the site address, public URLs, `OCW_TRUST_PROXY=1`,
`OCW_PUBLISH_ADDRESS=127.0.0.1`, `COMPOSE_PROFILES=proxy`.

**Automated local test** (part of the compose gate; `localhost` gets Caddy's internal CA automatically):
`OCW_SITE_ADDRESS=localhost`, `OCW_PROXY_HTTPS_PORT=<34xx>`, base URL `https://localhost:<port>`, Playwright and
Node requests with `ignoreHTTPSErrors`. Checks: (a) Scenario B + `attachments-api.spec.ts` through the proxy (browser
WebSocket realtime; browser presigned PUT; API 302 → presigned GET); (b) `scripts/gate/proxy-check.mjs`: failed
sign-in with `X-Forwarded-For: 203.0.113.77` → latest `user.sign_in_failed` row's `metadata->>'ip'` ≠ the spoofed IP
(read with `docker compose exec -T postgres psql -U postgres -d ocw -Atc …` in the gate project); sign-in response
cookie carries `Secure` over https; `/agent-channel/v1/*` → 404 via proxy; a raw WebSocket upgrade to `/ws` with a
JWT from `/api/auth/token` gets `101` (Node `ws`, `Origin` = site).

## Q7. Licenses, Semgrep, skipped tests, CODEOWNERS

**Package license fields** — all present [VERIFIED: each package.json read via node this session]:
root `AGPL-3.0-only`; `apps/api`, `apps/web`, `apps/desktop`, `apps/local-runtime`, `packages/db`, `packages/config`,
`infra/mcp-sandbox` `AGPL-3.0-only`; `packages/contracts`, `packages/realtime-client`, `apps/openclaw-channel`
`Apache-2.0` (PRD §102: protocol/SDK/plugins Apache 2.0). `packages/protocol` does not exist yet (Phase 8). Gaps:
`apps/openclaw-channel` and `packages/realtime-client` have **no LICENSE file** (only `packages/contracts/LICENSE`).
Add a guard test: every workspace `package.json` license ∈ {`AGPL-3.0-only`, `Apache-2.0`} and Apache packages ship a
LICENSE file.

**Dependency-license check:** `pnpm licenses list --json -r` (pnpm 12.8.1; 0.5 s) returns
`{ "<SPDX expr>": [{ name, versions, paths, license, homepage }] }` [VERIFIED: run this session]. Use the **full** graph
(not `--prod`): `--prod` omitted the platform binaries (`@img/sharp-libvips-darwin-arm64`, LGPL-3.0-or-later) that ship
inside the api image. Current graph: MIT 600, Apache-2.0 76, ISC 41, BSD-3-Clause 25, BlueOak-1.0.0 10, BSD-2-Clause
7, MIT OR Apache-2.0 2, MPL-2.0 2 (lightningcss), Unlicense 2, LGPL-3.0-or-later 1, Python-2.0 1 (argparse),
CC-BY-4.0 1 (caniuse-lite data), (AFL-2.1 OR BSD-3-Clause) 1, WTFPL 1, (WTFPL OR MIT) 1, WTFPL OR ISC 1, MIT-0 1,
0BSD 1, (MIT OR CC0-1.0) 1, **Unknown 2: `@anthropic-ai/claude-agent-sdk` and its darwin-arm64 binary** (`license:
"SEE LICENSE IN README.md"`, Anthropic commercial terms; prod dependency of `apps/local-runtime`).
Policy file `scripts/guard/license-policy.json`: allow `MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0,
Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0, Zlib, MPL-2.0, LGPL-2.1-or-later, LGPL-3.0-or-later, GPL-3.0-or-later,
AGPL-3.0-only, AGPL-3.0-or-later, CC-BY-4.0` (data only), `WTFPL`; deny anything else including `GPL-2.0-only`,
`SSPL-*`, `BUSL-*`, `Elastic-2.0`, `CC-BY-NC-*`, `UNLICENSED`, `Unknown`. Evaluate `OR` → any allowed; `AND` → all;
anything unparseable fails closed. Exceptions are explicit entries `{ name, reason, owner-approved }` — the
claude-agent-sdk entry needs the owner's decision (Open Question 3). `infra/mcp-sandbox` is an npm project: read
`infra/mcp-sandbox/package-lock.json` `packages[*].license` with the same policy.

**Semgrep:** `uvx --from semgrep==1.178.0 semgrep scan --config .semgrep/ --metrics=off --disable-version-check
--error apps packages infra e2e scripts` — 1.9 s warm (10.8 s first install) on this repo, 887 files [VERIFIED: run].
Fallback `docker run --rm -v "$PWD:/src" semgrep/semgrep:1.178.0@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b`.
No uv and no Docker → fail closed with an install hint (never skip silently). Rule tests with `semgrep --test .semgrep/`
(annotated fixtures under `.semgrep/tests/`, excluded from the main scan). Rules:
- `ocw.permission-bypass-token` (generic regex: `bypassPermissions|danger-full-access|allowDangerouslySkipPermissions|
  dangerously-skip-permissions|dangerouslySkipPermissions`) with a path allowlist = the ADR-0012 path:
  `apps/local-runtime/src/claude/`, `apps/local-runtime/src/codex/`, `apps/local-runtime/scripts/record-fixture.ts`,
  `packages/contracts/src/runtime-controls/`, `packages/contracts/src/session-events.ts`,
  `packages/contracts/src/device-link.ts`, plus the tests that assert refusal. With that allowlist the current repo
  still reports: `apps/api/src/modules/work-session/turn-mode.int.test.ts` (6), `apps/local-runtime/src/daemon.test.ts`
  (3), `packages/contracts/src/session-settings.test.ts` (6), `packages/contracts/src/slash-commands.test.ts` (1),
  `packages/db/src/rls-isolation.int.test.ts` (3) → add these test files to the allowlist (they assert denial).
- `ocw.rls-bypass` (`BYPASSRLS|DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY`) allowlisted only in
  `packages/db/sql/bootstrap.sql` and `rls-isolation.int.test.ts`; `post-migrate.sql:55` mentions `BYPASSRLS` in a
  comment → reword the comment or allowlist the line.
- `ocw.skipped-policy-test` (TypeScript patterns `$X.skip(...)`, `$X.todo(...)`, `$X.skipIf(...)(...)`,
  `$X.runIf(...)(...)`, `xit(...)`, `xdescribe(...)`) with `paths.include` = policy tests:
  `packages/db/src/**/*.test.ts`, `packages/contracts/src/permissions*.test.ts`, `apps/api/src/authz*.test.ts`,
  `apps/api/src/modules/organization/**`, `apps/api/src/modules/**/{access,grants,policy,permissions,members}*.test.ts`,
  `apps/api/src/modules/bot-capabilities/**/*.test.ts`, `apps/local-runtime/src/codex/mode-policy.test.ts`. Today there
  are **no** `.skip/.todo/.only` in any Vitest suite (grep); e2e uses conditional `test.skip(!FAKE_URL, …)` — out of
  scope of this rule.
- `ocw.focused-test` (`$X.only(...)`) everywhere in `apps/**/src`, `packages/**/src`, `e2e/` (a stray `.only` silently
  narrows `pnpm test`); plus `allowOnly: false` in `vitest.config.ts`.
- `ocw.ai-telemetry-records-prompts`: `experimental_telemetry: {...}` without `recordInputs: false` and
  `recordOutputs: false`.
- Optional, cheap: `ocw.cors-wildcard` (`origin: "*"` / `origin: true` in `@fastify/cors` registration).

**Wiring:** `pnpm guard` = `node scripts/guard/run.mjs` (semgrep → licenses → license fields → CODEOWNERS lint) and
`pnpm verify` = `pnpm lint && pnpm guard && pnpm typecheck && pnpm test`. Adds ~3 s.

**CODEOWNERS** (`.github/CODEOWNERS`; not in `workflows/`), all `@VictorMinemu`:
```
/packages/db/sql/                                  # bootstrap roles, FORCE RLS, policies, grants
/packages/db/drizzle/
/packages/db/src/schema/
/packages/db/src/tenant.ts
/packages/db/src/migrate*.ts
/packages/contracts/src/permissions*
/packages/contracts/src/runtime-controls/
/apps/api/src/authz.ts
/apps/api/src/modules/identity/                    # auth
/apps/api/src/modules/organization/permissions/    # resolver, policy
/apps/api/src/modules/secrets/
/apps/api/src/lib/secret-store.ts
/apps/api/src/modules/ai-chat/grants.ts            # aiAccessSql resolver
/apps/api/src/modules/chat/access.ts
/apps/api/src/modules/bot-capabilities/
/apps/api/src/modules/work-session/policy*
/apps/local-runtime/src/claude/                    # adapters
/apps/local-runtime/src/codex/
/infra/openclaw/install-policy.mjs
/.semgrep/
/scripts/guard/
/.github/
/docs/adr/
```
Add `scripts/guard/codeowners.mjs`: every pattern matches ≥ 1 tracked file (`git ls-files`), so the file cannot rot.
Enforcement needs branch protection "Require review from Code Owners"; with one owner who also authors every PR,
GitHub would block self-merges → owner decision (Open Question 4); the file itself satisfies FOUND-07.

## Q8. Scenario B

**Definition** [VERIFIED: docs/prd/PRD.md:3579-3585, §110]: 1. Víctor creates a private AI Chat. 2. He shares it with
Alex. 3. Both write in real time. 4. The model distinguishes both users. 5. From the chat they create a Work Zone
(excluded for MVP 1, ROADMAP line 35).

**Existing coverage:** `e2e/tests/ai-chat-multiplayer.spec.ts` (06-03, steps 1–4 at 1440/390, share dialog with the
P-13 disclosure, "Shared with me", "Hi Alex! (participants: …)") and `ai-chat-multiplayer-day.spec.ts` (06-16). Both
call `seedPlan()` → `POST /api/v1/test/ai/chatgpt-plan`, mounted only when `NODE_ENV !== "production" &&
OCW_MODEL_PROVIDER === "mock" && OCW_CHATGPT_API_BASE_URL !== null`
(`apps/api/src/modules/model-gateway/chatgpt-plan/routes.ts:93-99`), and the ChatGPT base-URL overrides are refused in
production by `env.ts:199-209`. They cannot run against the compose `api` (`NODE_ENV: production`).

**Production-safe path:** with `OCW_MODEL_PROVIDER=mock` (not refused in production), the model list appends the mock
(`mock:mock/mock-1`, label "Mock (E2E)") and, with no plan connected, the default is "anything available" → the mock
(`model-gateway/index.ts:405-430`). `OCW_AI_MOCK_BASE_URL` defaults to `OCW_MOCK_MODEL_BASE_URL`
(`http://fake-model:18999/v1` in `compose.e2e.yaml`). Admin setup (`setup.spec.ts`), members (`ensureMember` via
`/api/v1/members` + invitations) and sharing (`/api/v1/ai-chats/:id/grants` or the dialog) need no test routes.

**New spec** `e2e/compose/scenario-b.spec.ts` (serial, desktop + mobile projects): Víctor (admin-invited) opens a new
AI chat → default model chip "Mock (E2E)" → sends → mock answers him; opens the share dialog, checks the disclosure,
shares with Alex (Can chat); Alex finds it under "Shared with me"; both pages open; Alex writes → Víctor's page shows it
live (WebSocket through Caddy); the mock answers "Hi Alex! (participants: Alex …, Víctor …)"; Víctor writes → answer
names Víctor. Reuse helpers from `e2e/support/ai-chat.ts` and `actors.ts` (do not call `seedPlan`).
`e2e/playwright.compose.config.ts`: `testDir` covering `tests/setup.spec.ts`, `tests/attachments-api.spec.ts` and
`compose/*.spec.ts`; `use.ignoreHTTPSErrors: true`; base URL / API URL / setup token from env (the gate passes
`OCW_E2E_BASE_URL=OCW_E2E_API_URL=https://localhost:<port>` and `OCW_SETUP_TOKEN` from the gate env file); JSON
reporter. **The gate fails if any test is skipped** (`stats.skipped === 0 && stats.expected > 0`), because several
specs self-skip when an env var is missing and a green all-skipped run is the classic false pass.

**Running it:** `pnpm gate:compose` (local; same command for the future CI job) builds images tagged `gate-<sha>`,
starts `compose.yaml + compose.e2e.yaml` with `COMPOSE_PROFILES=proxy` under project `ocw-gate-<id>`, waits, runs
Playwright from the host checkout (Chromium from `pnpm exec playwright install chromium`), tears down. Production
rate limits stay at defaults (the spec signs in fewer than 30 times per minute); if needed, pass
`OCW_SIGNIN_RATE_LIMIT_PER_MINUTE` through `compose.e2e.yaml` (the base `api` service does not forward it today).

## Q9. Clean-machine simulation

`pnpm gate:cleanroom` (`scripts/gate/cleanroom.mjs`):
1. Refuse if the working tree is dirty (the clone tests commits, not edits); `git clone --no-local <repo> <tmp>/ocw` and
   `git checkout <HEAD sha>`. A clone avoids untracked files leaking into `COPY . .` image builds.
2. In the clone: `pnpm ocw setup --ports 34 --site-address localhost --profiles proxy` (writes `.env` there: every port
   in the `34xx` block — web 3400, api 3401, postgres 3402, redis 3403, s3 3404, proxy 3443/3480 — verified free and
   not in Node fetch's blocked list; `OCW_IMAGE_TAG=cleanroom-<sha>`; `COMPOSE_PROJECT_NAME=ocw-cleanroom-<id>`).
   Note: `pnpm <script>` in a fresh clone **auto-runs `pnpm install` first** (pnpm 12, observed: "Done in 2.6s" with a
   warm store) — on a truly clean machine this downloads all deps; the owner's real-machine run (human_needed)
   measures that.
3. `docker compose up -d --build --wait` (exactly the documented command; project/ports come from the clone's `.env`).
4. Run the same gate steps against it (`node scripts/gate/compose-gate.mjs --attach` re-using the clone's env).
5. Always `docker compose down -v --remove-orphans`, remove `ocw-*:cleanroom-<sha>` images and the temp dir (unless
   `--keep`). A lock file `/tmp/ocw-gate.lock` (Node `fs.openSync(…, "wx")` with stale-PID check, as in
   `e2e-isolated.sh`) serializes gate runs.

D-11 safety rules for every gate/test: always `-p <unique project>` and an explicit env file; never `docker compose`
without `-p` in the main worktree; ports outside {3000, 4000, 3900, 54329, 63799, 4290–4292, 3290}; never
`docker volume rm`/`image rm` except names carrying the run id; never read the repo's `.env`.

## Q10. Proposed plan split (waves, file ownership)

Cross-plan contracts fixed here so parallel plans agree: env names `OCW_IMAGE_TAG`, `OCW_PUBLISH_ADDRESS`,
`OCW_TRUST_PROXY`, `OCW_OTEL_ENDPOINT` (→ api `OTEL_EXPORTER_OTLP_ENDPOINT`), `OCW_SITE_ADDRESS`,
`OCW_PROXY_HTTP_PORT`, `OCW_PROXY_HTTPS_PORT`, `OCW_GRAFANA_PORT`, `OCW_GRAFANA_ADMIN_PASSWORD`, `OCW_OPENBAO_ADDR`,
`OCW_OPENBAO_ROLE_ID`, `OCW_OPENBAO_SECRET_ID`, `OCW_OPENBAO_TOKEN`; reference URI `openbao://<mount>/<path>#<field>`;
profiles `proxy`, `observability`, `vault`; CLI = `scripts/ocw.mjs` dispatching to `scripts/ocw/<command>.mjs` **by
file name** (later plans add files, never edit the dispatcher).

| Wave | Plan | Requirements | Owns (only this plan edits) |
|------|------|--------------|-----------------------------|
| 1 | **07-01 Guardrails** | FOUND-07, SELF-06 | `.semgrep/**`, `.semgrepignore`, `scripts/guard/**`, `.github/CODEOWNERS`, `apps/openclaw-channel/LICENSE`, `packages/realtime-client/LICENSE`, `vitest.config.ts`, root `package.json` (adds `guard`, `verify`, and the `ocw` alias → `node scripts/ocw.mjs`); allowlists the `BYPASSRLS` comment at `post-migrate.sql:55` instead of editing that file |
| 1 | **07-02 Schema guard + N-1 upgrade test** | SELF-03 | `packages/db/src/schema-check.ts(+test)`, `packages/db/src/index.ts`, `packages/db/sql/post-migrate.sql` (grant), `packages/db/scripts/upgrade-baseline.mjs`, `packages/db/test/upgrade/**`, `packages/db/src/upgrade.int.test.ts`, `apps/api/src/main.ts` |
| 1 | **07-03 Compose base + `ocw setup`** (tracer) | SELF-01 (base), FOUND-06 | `compose.yaml`, `compose.e2e.yaml`, stub `infra/{caddy,observability,openbao}/compose.yaml` (`services: {}`), `scripts/ocw.mjs`, `scripts/ocw/setup.mjs`, `scripts/setup-env.mjs` (shim), `scripts/ocw/*.test.mjs`, `infra/compose.test.mjs`, `docs/self-hosting/install.md`; first task: build images under a unique tag and boot the full stack in `ocw-gate-*` |
| 1 | **07-04 API telemetry** | FOUND-05 (app side) | `apps/api/src/telemetry.ts`, `apps/api/src/telemetry/**`, `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/Dockerfile` (CMD), `apps/api/src/app.ts` (req serializer + `trustProxy` from env), `apps/api/src/config/env.ts` (`OCW_TRUST_PROXY` only) |
| 2 | **07-05 Secrets + OpenBao** | SELF-02 | `apps/api/src/lib/secret-store.ts`, `apps/api/src/lib/openbao.ts(+int test)`, `apps/api/src/config/env.ts` (`loadConfig`), `apps/api/src/main.ts` (after 07-02), `infra/openbao/**` (replaces stub), `scripts/ocw/vault.mjs`, `docs/self-hosting/secrets.md` |
| 2 | **07-06 Observability profile** | SELF-01 (profile), FOUND-05 | `infra/observability/**` (replaces stub), `scripts/ocw/enable.mjs`, `scripts/gate/observability-smoke.mjs`, `docs/self-hosting/observability.md` |
| 2 | **07-07 Caddy** | SELF-05 | `infra/caddy/**` (replaces stub), `scripts/gate/proxy-check.mjs`, `docs/self-hosting/reverse-proxy.md` |
| 2 | **07-08 Backup / restore** | SELF-04 | `scripts/ocw/backup.mjs`, `scripts/ocw/restore.mjs`, `apps/api/src/cli/object-store.ts(+int test on testcontainers Garage via testing-storage.ts)`, `docs/self-hosting/backup-restore.md`, `docs/self-hosting/upgrade.md` |
| 3 | **07-09 Scenario B + release gate + clean room** | SELF-07, SELF-01 (verified), D-09/10 | `e2e/compose/**`, `e2e/playwright.compose.config.ts`, `scripts/gate/compose-gate.mjs`, `scripts/gate/cleanroom.mjs`, root `package.json` (`gate:compose`, `gate:cleanroom`), `README.md`, `docs/self-hosting/README.md`, `docs/adr/0021-self-hosted-release.md`, `.planning/REQUIREMENTS.md` (FOUND-06 wording), human-needed checkpoint (real clean machine) |

Shared-file notes: only 07-02 edits `post-migrate.sql` (07-01 allowlists its `BYPASSRLS` comment). `apps/api/src/main.ts`: 07-02 (wave 1) then 07-05 (wave 2). `env.ts`: 07-04
(wave 1) then 07-05 (wave 2). `compose.yaml`: only 07-03; profile plans own their included files. Root
`package.json`: 07-01 (wave 1) and 07-09 (wave 3) only. `pnpm-lock.yaml`: only 07-04.

## Architecture Patterns

### System Architecture Diagram

```
operator ──pnpm ocw setup──► .env (secrets, ports, COMPOSE_PROFILES, refs openbao://…)
   │
   └─docker compose up──►┌───────────────────────── compose project ─────────────────────────────┐
                         │ postgres ◄─(superuser bootstrap, ocw_migrator)── migrate (one-shot)      │
                         │    ▲                                                                     │
browser ──https──► caddy ┼─/api,/ws,/runtime/ws,/docs,/health──► api ──► redis                    │
  (proxy profile)        │   │                                    │  ├─ schema guard (ocw_app reads drizzle.__drizzle_migrations)
                         │   ├─/<bucket>/* (Host kept)──► garage ◄─┘  ├─ SecretStore: env/file ─or─► openbao (vault)
                         │   ├─/agent-channel/* ──► 404             └─ OTel SDK ─OTLP─► otel-collector (observability)
                         │   └─ everything else ──► web                                   ├─► tempo  (traces)
                         │ openclaw cell ──► api /agent-channel (internal)                ├─► prometheus (metrics)
                         │                                                                └─► loki   (logs) ◄── grafana
                         └──────────────────────────────────────────────────────────────────────────┘
pnpm ocw backup ──exec──► postgres pg_dump (ocw_migrator) │ run api image ──S3──► garage │ tar openclaw-state
pnpm gate:compose ──► isolated project ocw-gate-<id> ──► Playwright (Scenario B) via caddy ──► checks ──► down -v
```

### Recommended layout

```
scripts/ocw.mjs                 # dispatcher (by file name)
scripts/ocw/{setup,backup,restore,enable,vault}.mjs (+ *.test.mjs)
scripts/guard/{run,semgrep,licenses,license-fields,codeowners}.mjs + license-policy.json
scripts/gate/{compose-gate,cleanroom,proxy-check,observability-smoke}.mjs
.semgrep/{rules.yml,tests/**}
infra/{caddy,observability,openbao}/compose.yaml (+ configs)
apps/api/src/{telemetry.ts,telemetry/redact.ts,lib/openbao.ts,cli/object-store.ts}
packages/db/src/schema-check.ts; packages/db/test/upgrade/*.sql; packages/db/scripts/upgrade-baseline.mjs
e2e/compose/scenario-b.spec.ts; e2e/playwright.compose.config.ts
docs/self-hosting/*.md; docs/adr/0021-self-hosted-release.md
```

### Pattern: compose `include:` for optional profiles
Verified with Compose v5.3.1: `include: [infra/obs/compose.yaml, infra/vault/compose.yaml]` merges services; a file
with `services: {}` is valid; profile services in included files stay off until `COMPOSE_PROFILES` names them; relative
volume paths resolve from the included file's directory.

### Pattern: one-shot dependency with `--wait`
Verified: `docker compose up -d --wait` returns 0 when a `service_completed_successfully` one-shot exits 0 and its
dependent becomes healthy (Compose v5.3.1).

### Anti-patterns to avoid
- Running `docker compose` in the main worktree without `-p` (default project + default ports = the demo's).
- `--build` with the default `:local` tags (overwrites the demo's `ocw-openclaw:local`).
- Exporting `url.path`/`url.query` or default resource detectors; enabling AI SDK telemetry with default recording.
- `pg_dump -n app -n auth -n drizzle` (loses extensions); `pg_dump` as `ocw_app` (zero rows).
- `pg_restore --clean` over a newer schema without dropping the schemas first.
- Mounting Garage under a stripped path prefix in Caddy; rewriting `Host` for Garage.
- `trustProxy: true` with the API reachable directly.
- Bash 4 features in scripts (macOS bash is 3.2.57).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Migration bookkeeping | own migrations table/journal | `readMigrationFiles` + `drizzle.__drizzle_migrations` | Same names/hashes drizzle uses to decide what runs |
| Logical backup | custom SQL export | `pg_dump -Fc` / `pg_restore` in the postgres container | Ordering, ACLs, policies, extensions |
| TLS / ACME / WS proxying | nginx config + certbot | Caddy (auto HTTPS, internal CA for localhost) | Verified end to end |
| Fastify spans | manual hooks | `@fastify/otel` | Maintained by Fastify; contrib instrumentation removed |
| Trace↔log correlation | manual `trace_id` mixin | `instrumentation-pino` | Verified injection + export |
| License inventory | crawl `node_modules` | `pnpm licenses list --json -r` | Native, workspace-aware |
| Policy grep | ad-hoc `grep` in verify | Semgrep rules with path allowlists + `--test` fixtures | Precise, testable, fast |
| OTLP fan-out/storage | API exporting straight to 3 backends | OTel Collector | Redaction/batching point; operators can redirect |

## Common Pitfalls

1. **Demo collision (D-11).** Default project, default ports, default image tags. *Avoid:* unique `-p`, explicit env
   file, `OCW_IMAGE_TAG`, 34xx ports, cleanup traps. *Warning sign:* any test command without `-p`.
2. **All-skipped green run.** Specs self-skip without env (`test.skip(!FAKE_URL…)`). *Avoid:* JSON reporter + assert
   `skipped === 0`.
3. **Production image ≠ test routes.** `/api/v1/test/*` and ChatGPT overrides are refused in production. *Avoid:* mock
   org model; never set `NODE_ENV=test` in the compose gate.
4. **Telemetry leaks** (query strings, process path, AI SDK prompt recording). *Avoid:* redacting exporter + pino
   serializer + `resourceDetectors: []` + Semgrep rule + canary test.
5. **SDK API drift.** `SimpleLogRecordProcessor({ exporter })` (options object) in sdk-logs 0.222; NodeSDK plural
   options (`spanProcessors`, `metricReaders`, `logRecordProcessors`). Training-data snippets break at runtime.
6. **Telemetry taking the API down.** Unreachable collector or bad config must never crash boot; SDK only starts with
   an endpoint.
7. **Restore leaves newer objects behind.** Drop schemas before `pg_restore`; run `migrate` after.
8. **Backups without `.env` are useless** (encrypted secrets, JWKS). Document; keep `.env` out of the archive by
   default; archive is sensitive (0600).
9. **pnpm `minimumReleaseAge`.** OTel 0.223 / `@fastify/otel` 0.21.1 are refused before 2026-10-13 / 10-09.
10. **`--prod` license scan misses platform binaries** (LGPL libvips). Scan the full graph.
11. **First clean-machine boot is slow** (openclaw image ≈ 5 GB; pnpm auto-install). Generous gate timeouts; doc it.
12. **Schema guard permission.** `ocw_app` has no grant on `drizzle` today; without the post-migrate grant the guard
    reports "never migrated" on every boot.
13. **Garage key rotation.** `setup --force` rotates `OCW_S3_*` and `GARAGE_RPC_SECRET`; restored objects need the
    current key pair — restore uses the API's configured keys (never the backup's).
14. **Self-merge with CODEOWNERS enforcement** blocks a single-owner repo.

## Code Examples

### Telemetry bootstrap (no-op unless configured)
```ts
// apps/api/src/telemetry.ts — loaded by `node --import tsx --import ./src/telemetry.ts src/main.ts`
// Field names verified against @opentelemetry/sdk-node@0.222.0 build/src/types.d.ts.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
    const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
    const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
    const { PinoInstrumentation } = await import("@opentelemetry/instrumentation-pino");
    const { default: FastifyOtelInstrumentation } = await import("@fastify/otel");
    const { RedactingSpanExporter } = await import("./telemetry/redact");
    new NodeSDK({
      resourceDetectors: [], // default ProcessDetector exports absolute executable path + argv
      resource: resourceFromAttributes({ "service.name": "ocw-api" }),
      spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))],
      metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
      logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
      instrumentations: [
        new HttpInstrumentation(),
        new PgInstrumentation(),
        new PinoInstrumentation(),
        new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      ],
    }).start();
  } catch (err) {
    console.warn("telemetry disabled:", err instanceof Error ? err.message : err);
  }
}
```
(Whether `BatchLogRecordProcessor` takes `{ exporter }` like the simple one is [ASSUMED] — check the `.d.ts` at
install; `SimpleLogRecordProcessor` does, verified.)

### OpenBao preload (shape)
```ts
// AppRole login then one KV v2 read; verified wire format on openbao/openbao:2.7.1
const login = await fetch(`${addr}/v1/auth/approle/login`, { method: "POST", body: JSON.stringify({ role_id, secret_id }) });
const token = (await login.json()).auth.client_token as string;
const res = await fetch(`${addr}/v1/${mount}/data/${path}`, { headers: { "X-Vault-Token": token } });
// 200 → (await res.json()).data.data  |  403 → policy/token error  |  404 → missing path
```

### Restore core (verified sequence, run as ocw_migrator)
```bash
docker compose -p "$P" run --rm migrate                                   # roles exist (fresh volume ok)
docker compose -p "$P" exec -T postgres psql -U ocw_migrator -d ocw -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS app, auth, drizzle CASCADE'
docker compose -p "$P" exec -T postgres pg_restore -U ocw_migrator -d ocw --exit-on-error --single-transaction < db.dump
docker compose -p "$P" run --rm migrate                                   # upgrade older backups, re-apply grants
```

## State of the Art

| Old approach | Current approach | When | Impact |
|--------------|------------------|------|--------|
| `@opentelemetry/instrumentation-fastify` | `@fastify/otel` | contrib removed it Mar 2026 (STACK.md) | Only `@fastify/otel` |
| `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` for ESM | Not needed for CJS deps on Node 24 (spike); `module.register` is the documented future | 2026 | Simpler CMD |
| drizzle `meta/_journal.json` | folder-per-migration + `name`/`applied_at` columns | drizzle 1.0 RC | Guard compares names + hashes |
| Tempo 2.x ingester/compactor config | Tempo 3 monolithic without those blocks | Tempo 3.0 (2026-05-28) | Use 3.x-shaped config |
| Prometheus scraping a collector exporter | Prometheus native OTLP receiver | Prometheus 3.x | Fewer moving parts |
| MinIO (ADR-0003) | Garage (ADR-0015) | Phase 4 | FOUND-06 wording |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | Tempo 3.1 monolithic config needs only `server`, `distributor.receivers.otlp`, `storage.trace.local` | Q3 | Profile smoke fails → fall back to 3.0.3 or adjust YAML |
| A2 | OpenBao HCL: `storage "file"` + `seal "static" { current_key_id, current_key = "file://…" }` | Q2 | Vault profile does not start → adjust per openbao.org docs |
| A3 | better-auth takes the session IP from `x-forwarded-for` | Q6 | Session list shows the proxy IP; cosmetic |
| A4 | `BatchLogRecordProcessor` takes `{ exporter }` in sdk-logs 0.222 | Code example | Typecheck catches it |
| A5 | The api/web/openclaw images still build at HEAD (unbuilt since CI stopped) | Q1 | Tracer task finds and fixes; first-task risk |
| A6 | Services in included compose files share the project `default` network | Q10 | Caddy cannot reach api → define networks explicitly |
| A7 | Prometheus 3.13.x is a long-lived patch line (3.13.4 published after 3.15.0) | Stack | Use 3.15.0 instead; no functional impact |
| A8 | Grafana/Loki/Tempo/Prometheus/collector fit next to the stack in Docker Desktop's 16 GB | Q3 | Gate runs the profile as a separate step |
| A9 | The claude-agent-sdk license is acceptable as a documented exception | Q7 | Owner decision; may require making the Claude adapter an optional download |

## Open Questions

1. **CI wiring (D-01 vs orchestrator).** D-01 says update `ci.yml`; this research was told not to touch
   `.github/workflows/**` (self-hosted runner work in parallel). *Recommendation:* no workflow edits in Phase 7; the gate
   plan's SUMMARY lists the exact commands (`pnpm verify`, `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'`,
   `pnpm gate:compose`) for the runner agent; the local runs are the merge evidence.
2. **Setup token printing.** `setup-env.mjs:104` prints the setup token; D-03 says never print secret values.
   *Recommendation:* print "`OCW_SETUP_TOKEN` written to .env" plus `pnpm ocw setup-token` to show it on explicit
   request; no existing test asserts the printout.
3. **`@anthropic-ai/claude-agent-sdk` license** (Anthropic commercial terms) in the AGPL daemon. *Recommendation:*
   explicit, owner-approved exception in `license-policy.json` now; legal review before public distribution.
4. **CODEOWNERS enforcement.** Turning on "Require review from Code Owners" blocks single-owner self-merges.
   *Recommendation:* ship the file + lint; leave enforcement off until a second maintainer exists.
5. **Vault scope.** *Recommendation:* client + contract tests + `vault` profile + `ocw vault init/migrate` for the four
   API-only secrets; DB passwords, cell token and S3 keys stay env/file (shared with other containers).
6. **Release tag.** Tag `v0.1.0` at phase merge so the next N-1 baseline is a real release.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker Desktop | everything | ✓ | Engine 29.6.2, 8 CPU, 16 GB VM | — |
| Docker Compose | `include:`, `!reset`, `--wait` | ✓ | v5.3.1 | — |
| Node | CLI, gate, tests | ✓ | v24.21.0 (= `.nvmrc`) | — |
| pnpm | workspace | ✓ | 12.8.1 (corepack) | — |
| uv / uvx | Semgrep pin | ✓ | 0.10.0 | Docker `semgrep/semgrep:1.178.0` |
| Semgrep (Homebrew) | — | ✓ | 1.157.0 (unpinned; not used) | uvx pin |
| Python | uvx | ✓ | 3.14.7 | uv-managed Python |
| Playwright + Chromium | Scenario B | ✓ (lockfile 1.63.0) | — | `pnpm exec playwright install chromium` |
| Host `pg_dump` | — | ✓ libpq (not needed) | — | container tools |
| bash | scripts | 3.2.57 only | — | write gate/CLI in Node |
| Disk | images | 60 GiB free | — | `docker system prune` of gate tags only |

No missing blockers. Images pulled for experiments and left in the local cache: `openbao/openbao:2.7.1`,
`caddy:2.11.7-alpine` (dxflrs/garage and postgres:18 were already present). All experiment containers, networks and
volumes (`ocw7-research-*`) were removed.

## Validation Architecture

### Test framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (`unit`, `integration` with testcontainers, `web`); `node --test` for `scripts/**` and `infra/**`; Playwright 1.63.0; Semgrep `--test` |
| Config | `vitest.config.ts`, `e2e/playwright.compose.config.ts` (new), `.semgrep/` (new) |
| Quick run | `pnpm exec vitest run --project unit <file>`; `node --test scripts/ocw/<x>.test.mjs`; `pnpm guard` |
| Full suite | `pnpm verify` (lint + guard + typecheck + unit + integration incl. upgrade and OpenBao); `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'`; `pnpm gate:compose` |
| Phase gate | `pnpm gate:cleanroom` (fresh clone; human repeats on a real clean machine) |

### Requirements → tests
| Req | Behaviour | Type | Command / file | Exists |
|-----|-----------|------|----------------|--------|
| FOUND-06 | missing required secret → compose names it; minimal profile boots | node test + gate | `infra/compose.test.mjs` (`docker compose config` with a key missing); gate `up --wait` | ❌ |
| SELF-01 | clone + `ocw setup` + `compose up` → working instance; profiles off by default, enable later w/o reinstall | gate | `pnpm gate:cleanroom`; `scripts/ocw/setup.test.mjs`, `enable.test.mjs` | ❌ |
| SELF-02 | env/file and OpenBao satisfy one contract; `openbao://` refs; errors never contain values | int | `apps/api/src/lib/openbao.int.test.ts`, `secret-store.test.ts` | ❌ |
| SELF-03 | guard: ok / behind / ahead / diverged; N-1 golden dump → HEAD → API boots, data intact; append-only | unit + int + gate | `packages/db/src/schema-check.test.ts`, `upgrade.int.test.ts`; gate step "bogus migration row → api exits 1 with message" | ❌ |
| SELF-04 | backup → mutate → restore → original state; `--force-recreate` keeps data | int + gate | `apps/api/src/cli/object-store.int.test.ts`; `scripts/ocw/backup.test.mjs` (arg/manifest logic); gate steps | ❌ |
| SELF-05 | WS upgrade, trusted headers, presigned URLs via Caddy | gate | Scenario B + `attachments-api.spec.ts` via proxy; `scripts/gate/proxy-check.mjs` | ❌ |
| SELF-06 | license fields; dependency licenses | node test | `scripts/guard/licenses.test.mjs`, `license-fields.test.mjs` (fixtures for allow/deny/OR/AND/unknown) | ❌ |
| SELF-07 | Scenario B 1–4 on compose images, 1440 + 390, no skips | e2e | `e2e/compose/scenario-b.spec.ts` via `pnpm gate:compose` | ❌ |
| FOUND-05 | spans (fastify, http, pg), metric, logs with trace ids; canaries absent | unit + gate | `apps/api/src/telemetry/redact.test.ts`; `telemetry.int.test.ts` (child process, in-memory exporters); `scripts/gate/observability-smoke.mjs` (Tempo/Prometheus/Loki APIs + collector debug output grep) | ❌ |
| FOUND-07 | verify fails on bypass token / skipped policy test / license violation; CODEOWNERS valid | semgrep test + node test | `semgrep --test .semgrep/`; `scripts/guard/run.test.mjs` (temp fixture files make `pnpm guard` exit ≠ 0) | ❌ |

### Sampling rate
- Per task commit: the quick command for the touched area + `pnpm guard`.
- Per wave merge: `pnpm verify` + `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'`.
- Phase gate: `pnpm gate:compose` (with `--with-observability --with-vault`) then `pnpm gate:cleanroom`, both green
  before `/gsd-verify-work`.

### Wave 0 gaps
None as a separate wave — each plan creates its tests first (TDD). The gate harness (`compose-gate.mjs`) starts in
07-03 as the tracer (boot + health) and grows step by step in later plans' verification, finalized in 07-09.

## Security Domain

Config: `security_enforcement: true`, ASVS level 1, block on high.

| ASVS category | Applies | Control |
|---------------|---------|---------|
| V1 Architecture | yes | profiles optional; API unpublished behind proxy; one origin |
| V2 Authentication | yes (indirect) | `Secure` cookies over https verified in gate; setup token not printed |
| V3 Session | yes | same-site single origin; JWT for WS unchanged |
| V4 Access control | yes | `/agent-channel/*` blocked at proxy; CODEOWNERS + Semgrep on policy paths; RLS preserved through backup/restore (verified) |
| V5 Input validation | yes | Zod config (`OCW_TRUST_PROXY`, `openbao://` URIs); restore manifest validated |
| V6 Cryptography | yes | no hand-rolled crypto; OpenBao static seal key 32 random bytes; secrets 0600 |
| V7 Errors & logging | yes | redacting exporter, query-stripping serializer, no process path in resource, AI telemetry rule |
| V8 Data protection | yes | backups 0600/0700, contain secrets, `.env` separate; telemetry excludes prompts |
| V10 Malicious code / supply chain | yes | `minimumReleaseAge`, digest-pinned images, license policy, Semgrep |
| V12 Files | yes | presigned URLs unchanged; tampered/unsigned 403 verified |
| V14 Configuration | yes | Grafana admin password from setup; OpenBao not published; Caddy `admin off` |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| XFF spoofing to evade sign-in rate limit / forge audit IP | Spoofing | `OCW_TRUST_PROXY` default false; 1 hop behind Caddy; API port loopback in proxy mode |
| Tokens in URLs exported to telemetry | Info disclosure | route-template paths, query removal, pino serializer, collector transform |
| Restore of a tampered/newer backup | Tampering | checksums in manifest, refuse unknown migrations, `--yes`, single-transaction restore |
| Image rollback over a newer schema | Tampering | schema guard refuses to start |
| Gate tests destroying the demo | DoS | unique project/ports/tags, explicit env file, lock, scoped cleanup |
| Weakened policy by agents | Elevation | Semgrep rules + CODEOWNERS + skipped-test rule in `pnpm verify` |
| Default Grafana/OpenBao credentials | Elevation | generated at setup, never defaults; services unpublished or loopback |

## Sources

### Primary (HIGH — read or executed this session)
- Code: `compose.yaml`, `compose.e2e.yaml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/api/src/{main.ts,app.ts,config/env.ts,lib/secret-store.ts}`,
  `apps/api/src/modules/{artifact/storage.ts,identity/routes.ts,identity/auth.ts,model-gateway/index.ts,model-gateway/chatgpt-plan/routes.ts}`,
  `packages/db/src/{migrate.ts,migrate-cli.ts,env.ts,testing.ts}`, `packages/db/sql/*.sql`, `scripts/{setup-env.mjs,setup-env.test.mjs,demo-up.sh,demo-reset.sh,e2e-isolated.sh}`,
  `e2e/playwright.config.ts`, `e2e/tests/{env.ts,setup.spec.ts,ai-chat-multiplayer.spec.ts,attachments-api.spec.ts}`, `.github/workflows/ci.yml` (read only),
  `infra/garage/*`, `infra/openclaw/README.md`, `docs/adr/0003`, `docs/adr/0015`, `.planning/research/{STACK,PITFALLS}.md`, PRD §102/§110.
- Installed sources: `drizzle-orm@1.0.0-rc.4` (`migrator.js`, `pg-core/async/session.js`, `up-migrations/pg.js`, `migrator.utils.js`);
  `ai@7.0.122` `dist/index.d.ts`; `@fastify/otel@0.21.0` `index.js`; `@opentelemetry/sdk-node@0.222.0` `types.d.ts`, `sdk.js`;
  `@opentelemetry/instrumentation-pino@0.68.0` `instrumentation.js`, `log-sending-utils.js`.
- Experiments (throwaway, cleaned up): OpenBao 2.7.1 dev container (KV v2, AppRole, policy, renew-self, 403/404);
  postgres:18 + real migrations (dump/restore as migrator, clean restore, drop-schemas + re-migrate); OTel spike
  (Node 24 + tsx; spans/logs; leaks; loader not required); Caddy 2.11.7 + Garage v2.4.1 presign PUT/GET/tamper;
  Compose `--wait` with one-shot, `include:` with empty and profile files, `COMPOSE_PROFILES`/`COMPOSE_FILE` from `.env`;
  `pnpm licenses list --json [-r] [--prod]`; Semgrep 1.178.0 via uvx on the repo; fresh clone + `pnpm <script>` auto-install.
- Registries: npm (`npm view` versions, publish times, deps, scripts, licenses); PyPI (semgrep); Docker Hub tag digests;
  GitHub releases (Caddy, Tempo, Loki, OpenBao, Prometheus).

### Secondary (MEDIUM — official docs)
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (Host passthrough, X-Forwarded-* handling, WebSockets, no request buffering)
- https://caddyserver.com/docs/caddyfile/options (`trusted_proxies` default none, `admin off`)
- https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md (ESM loader guidance)
- https://prometheus.io/docs/guides/opentelemetry/ (`--web.enable-otlp-receiver`, `/api/v1/otlp/v1/metrics`, OOO window)
- https://grafana.com/docs/loki/latest/send-data/otel/ (`/otlp`, `allow_structured_metadata`)
- https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/migrate-to-3/ (monolithic, removed blocks, no Kafka)
- https://openbao.org/docs/configuration/seal/static/ (static auto-unseal)
- `@fastify/otel` README (npm) — `registerOnInitialization`, `ignorePaths`, requires instrumentation-http

### Tertiary (LOW)
- Prometheus 3.13 as a long-lived line (inferred from release order only).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (registry-verified pins; spike ran the exact npm versions)
- Migrations / backup / restore: HIGH (executed against postgres:18 with the real migrations and roles)
- Caddy + presigned URLs: HIGH (executed); trusted-proxy behaviour MEDIUM (docs + code reading; gate proves it)
- OpenBao client: HIGH; OpenBao server-mode profile: MEDIUM (docs only)
- Observability backends config: MEDIUM (docs; smoke test at execution)
- Scenario B path: HIGH (code read: production gates and mock default)

**Research date:** 2026-10-08
**Valid until:** 2026-10-22 for npm/image pins (OTel ships monthly); 2026-11-08 for the rest
