# Stack Research

**Domain:** Open-source, self-hostable, multiplayer collaborative AI workspace (Slack-style chat + shared AI chats + cloud-owned coding-agent "Work Zones" executed locally via Codex / Claude Code) — MVP 1 + MVP 2
**Researched:** 2026-09-10
**Confidence:** MEDIUM overall (every version below was read from registry.npmjs.org / nodejs.org/dist on 2026-09-10; every design claim was cross-checked against the vendor's own docs or blog; the research seam caps web-verified findings at MEDIUM, so no item is tagged HIGH)

This document only decides what ADR-0001..0003 left open. Decided constraints (TypeScript monorepo, pnpm + Turborepo + Biome + Vitest, Fastify modular monolith, PostgreSQL-only + RLS, Redis, S3-compatible storage, OpenBao/KMS abstraction, OpenTelemetry, Next.js / Electron / Expo, AGPL-3.0) are taken as given; see "Concerns about decided constraints" at the end for the two places where the evidence says an ADR needs a small amendment.

---

## Decision summary (read this first)

| # | Open decision | Recommendation | Confidence |
|---|---------------|----------------|------------|
| 1 | ORM / query layer | **Drizzle ORM 1.0.0-rc.4 + drizzle-kit 1.0.0-rc.4** on the `pg` (node-postgres 8.23) driver; RLS policies declared in schema with `pgPolicy`, tenant scoped with `set_config` inside a per-request transaction; Kysely stays *internal to better-auth only*; Prisma rejected | MEDIUM |
| 2 | Self-hosted auth | **better-auth 1.7.4 embedded in Fastify** (library, not IdP) with `organization`, `deviceAuthorization`, `jwt`, `oauthProvider`, `admin` plugins now; `@better-auth/sso` + `@better-auth/scim` later. Keycloak / Zitadel / Ory rejected as *embedded* IdP; they remain supported as *upstream* IdPs through the SSO plugin | MEDIUM |
| 3 | Realtime transport | **`@fastify/websocket` 11.3 (ws 8.21) + Redis pub/sub via node-redis 6.2**, own Zod-typed envelope with per-topic sequence numbers and Postgres-backed replay. Socket.IO and Centrifugo rejected for MVP 1–2 | MEDIUM |
| 4 | AI provider layer | **Vercel AI SDK 7 (`ai` 7.0.97)** server-side inside the Model Gateway module with `@ai-sdk/anthropic` 4, `@ai-sdk/openai` 4, `@ai-sdk/google` 4, `@ai-sdk/openai-compatible` 3 (Ollama / vLLM / LiteLLM / any OpenAI-compatible proxy). Direct SDKs and a LiteLLM container rejected | MEDIUM |
| 5 | UI | **Next.js 16.3.4 (App Router, Turbopack) + React 19.3 + Tailwind CSS 4.3 + shadcn (Base UI default, `@base-ui/react` 1.8)**; TanStack Query 5.102 for server state, Zustand 5 for realtime/client state, **react-virtuoso 4.18** for message lists, streamdown 2.6 for streaming markdown. Electron renderer is a **Vite 7 + React + TanStack Router** app sharing `packages/ui` and `packages/app-core`, *not* an embedded Next.js | MEDIUM |
| 6 | Electron + Local Runtime | **Electron 44.3, electron-vite 5, electron-builder 26 + electron-updater 6**; daemon = separate TypeScript package run as an Electron `utilityProcess` in MVP 2 (headless mode later); **Codex via `codex app-server` (JSON-RPC 2.0 over stdio)**, **Claude Code via `@anthropic-ai/claude-agent-sdk` 0.3.x in streaming-input mode**; node-pty 1.1, simple-git 3.36; Electron⇄daemon IPC = JSON-RPC 2.0 over a loopback WebSocket (same client lib as the cloud connection) | MEDIUM (Codex/Claude adapters: LOW–MEDIUM, protocol still moves weekly) |
| 7 | Storage / secrets / OTel | **`@aws-sdk/client-s3` 3.1129 (+ presigner, lib-storage) with `forcePathStyle`**; **OpenBao via a thin in-house `fetch` client behind `SecretStore`** (no official Node SDK exists); **OpenTelemetry JS SDK 2.x (`sdk-node` 0.222, `sdk-trace-*` 2.11) with `@fastify/otel` 0.21**, `instrumentation-pg`, `instrumentation-redis`, `instrumentation-pino`; OTLP → OTel Collector → Prometheus/Loki/Tempo | MEDIUM |

Two amendments to decided constraints are recommended (details at the end): move **Node 22 → Node 24 LTS**, and note that **TypeScript 7 (native tsc)** is now `latest` and needs a fallback pin to `typescript@6.0.3` for any tool that still wants the JS compiler API.

---

## Recommended Stack

### Core Technologies

| Technology | Version (npm `latest`, 2026-09-10) | Purpose | Why Recommended |
|------------|------------------------------------|---------|-----------------|
| Node.js | **24.21.0** (Krypton, Active LTS → Maintenance 2026-10-20, EOL 2028-04-30) | Runtime for API, daemon, tooling | Node 22 (22.23.2) has been in Maintenance since 2025-10-21; Electron 44 embeds **Node 24.18.1**, so the daemon and the desktop app share one ABI generation; Vitest 5 / pg-boss / AI SDK 7 all require ≥ 22.12 anyway. See concerns section. |
| TypeScript | **7.0.2** (native Go `tsc`; `typescript@6` = 6.0.3 bridge) | Type checking | 8–12× faster full builds; Next.js ≥ 16.2.12 invokes the `tsc` CLI so it works; but 7.0 has **no JS compiler API until 7.1** — keep `typescript@6.0.3` pinned as a devDependency alias for any tool that needs the API (dts bundling, IDE plugins). |
| pnpm | **12.3.4** | Package manager | Rust rewrite; config now lives in `pnpm-workspace.yaml` (camelCase keys), the `pnpm` field in `package.json` is no longer read — write the workspace file from day one. |
| Turborepo | **2.10.12** | Task graph | As decided. Verify it parses the pnpm 12 lockfile in the bootstrap phase (LOW confidence risk; pnpm 12 kept lockfile v9). |
| Biome | **2.5.13** | Lint + format | 500+ rules incl. type-aware rules and cross-file linting; no ESLint needed. |
| Vitest | **5.0.0** | Tests | Requires Node ^22.12 ‖ ^24 ‖ ≥ 26 and Vite ^6.4 ‖ ^7 ‖ ^8. |
| Fastify | **5.12.3** | Control Plane HTTP + WS | As decided. |
| PostgreSQL | **18.x** (server image `postgres:18`) | Only database | Native `uuidv7()`, virtual generated columns, faster I/O; RLS is the tenant boundary. |
| Redis | **8.x** (`redis:8`, AGPL-licensed again since 8.0) or Valkey 9 | Pub/sub, presence, typing, rate limits | Both work with node-redis 6; Redis 8's AGPL license is compatible with the project's AGPL posture. |
| Drizzle ORM / Kit | **1.0.0-rc.4 / 1.0.0-rc.4** (`@rc`; stable line is 0.45.2 / 0.31.10) | Schema, migrations, queries, RLS policies | See Decision 1. |
| better-auth | **1.7.4** (+ `@better-auth/sso`, `@better-auth/scim`, `@better-auth/mcp` 1.7.4) | Identity, sessions, orgs, device grant, SSO/SCIM | See Decision 2. |
| `@fastify/websocket` + `ws` | **11.3.0 / 8.21.3** | Realtime transport | See Decision 3. |
| node-redis (`redis`) | **6.2.1** | Redis client | Redis's recommended client for new projects; ioredis 6.0.0 is "best-effort maintenance". Skip `@fastify/redis` (it wraps ioredis); write a 30-line plugin. |
| Vercel AI SDK (`ai`) | **7.0.97** | Model Gateway: streaming, tool calls, provider abstraction, telemetry | See Decision 4. |
| Zod | **4.6.1** | Contracts at every process boundary | Peer-required by AI SDK 7, better-auth, Claude Agent SDK, fastify-type-provider-zod 7. |
| Next.js / React | **16.3.4 / 19.3.0** | Web app | See Decision 5. |
| Electron | **44.3.0** (Chromium 152, Node 24.18.1, macOS 13+) | Desktop shell | See Decision 6. |
| Expo SDK | **57.0.21** (RN 0.86, React 19.2, New Architecture only) | Mobile (MVP 7, out of this milestone) | Recorded for version alignment only. Upgrade floor 57.0.17 (Hermes V1 regressions). |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pg` | 8.23.0 | Postgres driver | Always (Drizzle `node-postgres` driver). Chosen over `postgres` (postgres.js 3.4.9) because OTel `instrumentation-pg`, pg-boss, better-auth and Kysely all target `pg`. |
| `drizzle-zod` | 0.8.3 | Derive Zod schemas from tables | DTOs in `packages/contracts` that mirror tables. |
| `pg-boss` | 12.30.0 | Postgres-backed job queue | ADR-0003 "PostgreSQL-backed job table": notifications, artifact security scans, retries. Node ≥ 22.12. Swap for Temporal in MVP 5. |
| `fastify-type-provider-zod` | 7.0.0 | Zod → route validation + OpenAPI | Always; peer `zod ≥ 4.1.5`, `fastify ^5.5`, `@fastify/swagger ≥ 9.5.1`. |
| `@fastify/swagger` + `@scalar/fastify-api-reference` | 9.8.1 / 1.68.0 | OpenAPI generation + docs UI | Always (public API is a product surface for OpenClaw plugins). |
| `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/cookie`, `@fastify/sensible`, `@fastify/under-pressure` | 11.3.0 / 13.1.1 / 11.2.0 / 10.1.1 / 11.1.2 / 6.0.5 / 9.1.0 | Standard Fastify plugins | Always. `@fastify/multipart` for the artifact upload pipeline; `under-pressure` for backpressure on WS fan-out. |
| `pino` + `pino-pretty` | 10.3.1 / 13.1.3 | Logging | Always (Fastify's logger); OTel `instrumentation-pino` 0.68 injects trace ids. |
| `close-with-grace` | 2.5.0 | Graceful shutdown | Always (drain WS connections before exit). |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` | 3.1129.0 | Object storage, presigned uploads, multipart | Artifact pipeline. `forcePathStyle: true` for MinIO. |
| `@opentelemetry/sdk-node`, `sdk-trace-node`, `sdk-metrics`, `sdk-logs`, `resources`, `semantic-conventions` | 0.222.0 / 2.11.0 / 2.11.0 / 0.222.0 / 2.11.0 / 1.43.0 | OTel SDK 2.x line | Always. `sdk-node` and exporters stay on the 0.2xx numbering even in the 2.x SDK generation — that is expected. |
| `@fastify/otel` | 0.21.0 | Fastify spans | Always. `@opentelemetry/instrumentation-fastify` was deprecated Jan 2025 and **removed Mar 2026**; do not install it. |
| `@opentelemetry/instrumentation-pg`, `-redis`, `-pino`, `-undici` | 0.74.0 / 0.70.0 / 0.68.0 / (from auto-instrumentations 0.80.0) | DB, cache, logs, outbound HTTP spans | Always. Prefer an explicit list over `auto-instrumentations-node` to keep startup fast. |
| `@opentelemetry/exporter-trace-otlp-http`, `-metrics-otlp-http`, `-logs-otlp-http` | 0.222.0 | OTLP export | Always (to an OTel Collector in compose). |
| `jose` | 6.2.12 | JWT/JWS/JWK verification | Verify better-auth-issued JWTs in the WS handshake and in the daemon. |
| `uuid` (v7) | 14.0.2 | Time-ordered ids client-side | When ids must be minted before the DB round-trip (optimistic messages); DB default is `uuidv7()`. |
| `@modelcontextprotocol/sdk` | 1.30.0 | MCP client/server types | Peer of Claude Agent SDK; needed for MVP 4 MCP scopes. |
| `@ai-sdk/mcp` | 2.0.48 | MCP tools inside AI SDK | When server-side agents call MCP servers (MVP 4+). |
| `@tanstack/react-query` (+ devtools) | 5.102.8 | Server state on web/desktop | Always. |
| `zustand` | 5.0.15 | Realtime + UI state stores fed by the WS client | Always. |
| `react-virtuoso` | 4.18.13 | Virtualized message lists | Chat, threads, session event log (reverse/bottom-anchored, prepend on scroll-up, dynamic heights out of the box). |
| `streamdown` | 2.6.0 | Streaming-safe markdown rendering | Assistant messages while tokens arrive. |
| `shiki` | 4.4.3 | Syntax highlighting | Code blocks in messages and diffs. |
| `@xterm/xterm` + `@xterm/addon-fit` | 6.0.0 / 0.11.0 | Terminal view in Work Zone | MVP 2 terminal panel (read-only for VIEW, interactive for FULL_CONTROL). |
| `@pierre/diffs` | 1.4.1 | Git diff rendering (shiki-based) | MVP 2 changed-files/diff view. Alternative: `@git-diff-view/react` 0.1.7. Both young — flag for phase research. |
| `@tiptap/react` | 3.31.3 | Message composer (mentions, slash commands, cards) | MVP 1 composer. A plain textarea is acceptable for the first phase; TipTap when `@mentions` of agents land. |
| `react-hook-form` + `@hookform/resolvers` | 7.87.0 / 5.9.1 | Forms with Zod | Settings/admin forms. |
| `@dnd-kit/core` + `@dnd-kit/sortable` | 6.3.1 / 10.0.0 | Drag-reorder | Prompt Queue reorder (MVP 2). |
| `react-resizable-panels` | 4.12.4 | Sidebar / right panel layout | Work Zone UI. |
| `lucide-react`, `cmdk`, `sonner`, `date-fns` | 1.44.0 / 1.1.1 / 2.0.8 / 4.4.0 | Icons, command palette, toasts, dates | Standard shadcn companions. |
| `@tanstack/react-router` | 1.170.34 | Routing in the Electron renderer | Desktop only (Next.js handles web routing). |
| `nuqs`, `next-intl` | 2.10.1 / 4.14.3 | URL state, i18n on web | Optional; i18n can wait. |
| `@anthropic-ai/claude-agent-sdk` | 0.3.267 (bundles Claude Code 2.1.267) | Claude Code adapter | Daemon (MVP 2). Peer: `zod ^4`, `@anthropic-ai/sdk ≥ 0.93`, `@modelcontextprotocol/sdk ^1.29`. |
| `@openai/codex` | 0.154.0 | Codex CLI (`codex app-server`) | Daemon (MVP 2). Prefer the user's installed CLI; pin a minimum version. |
| `node-pty` | 1.1.0 (1.2.0-beta.15 on `@beta`) | PTY for terminal adapter | Daemon. Native module: `@electron/rebuild` 4.2.0 + `asarUnpack`. Fallback: `@homebridge/node-pty-prebuilt-multiarch` 0.14.1. |
| `simple-git` | 3.36.0 | Git adapter (status, diff, branch, worktree) | Daemon. Wraps system git, which Codex/Claude Code require anyway. |
| `chokidar`, `ignore`, `isbinaryfile`, `file-type` | 5.0.0 / 7.0.9 / 6.0.0 / 22.0.2 | File watching, gitignore semantics, binary detection | Daemon file/artifact adapters. |
| `vscode-jsonrpc` | 9.0.2 | JSON-RPC 2.0 framing (stdio / socket / MessagePort) | Daemon ⇄ Codex app-server (stdio) and Electron ⇄ daemon. |
| `execa` | 10.0.1 | Child processes | Daemon (CLI version checks, git fallbacks). |
| `electron-vite` | 5.0.0 (**peer `vite ^5 ‖ ^6 ‖ ^7`, not 8**) | Main/preload/renderer bundling | Desktop. Pin `vite@7` in `apps/desktop`. |
| `electron-builder` + `electron-updater` | 26.15.3 / 6.8.9 | Packaging, signing, auto-update | Desktop. Broadest installer formats; runs `@electron/rebuild` for native modules. |
| `@electron/fuses`, `@electron/notarize` | 2.1.3 / 3.1.1 | Hardening, macOS notarization | Desktop release phase. Keep `runAsNode` fuse **enabled** only if the daemon is launched with `ELECTRON_RUN_AS_NODE`; with `utilityProcess` you can disable it. |
| `@electron-toolkit/preload`, `@electron-toolkit/utils`, `electron-log`, `electron-store` | 3.0.2 / 4.0.0 / 5.4.4 / 11.0.2 | Preload helpers, logs, local settings | Desktop. |
| `tsdown`, `tsx` | 0.23.0 / 4.23.13 | Library/daemon bundling (rolldown), dev runner | `tsup` 8.5 still works but is in maintenance; tsdown is its successor. Enable `isolatedDeclarations` so dts generation does not need the TS JS API. |
| `@testcontainers/postgresql` | 12.1.0 | Real Postgres in Vitest | RLS/tenant-isolation tests must run against real Postgres with a non-owner role; PGlite is not sufficient for role/policy semantics. |
| `@playwright/test` | 1.63.0 | Browser E2E | Once web UI exists (ADR-0001). |
| `dependency-cruiser` | 18.2.0 | Module-boundary enforcement (ADR-0002) | When the second module exists. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `pnpm-workspace.yaml` | Workspace + all pnpm settings | pnpm 12 ignores `package.json#pnpm`; set `nodeLinker`, `saveExact: true`, `engineStrict` here. |
| `.nvmrc` / `.node-version` | Pin Node | `24.21.0` (see concerns). |
| `turbo.json` | Task graph | `dev`, `build`, `lint`, `typecheck`, `test`, `db:generate`, `db:migrate`; remote cache off (ADR-0001). |
| `biome.json` | Lint/format | Enable type-aware rules in Biome 2.5; add `noRestrictedImports` rules for cross-module imports until dependency-cruiser lands. |
| `drizzle.config.ts` | Migrations + role management | `entities.roles: { include: ['app'] }` so drizzle-kit only manages the app role; the migrator role is created by the compose init script. |
| OpenTelemetry Collector + Prometheus + Loki + Tempo + Grafana | Self-hosted observability | One `otel-collector` container receiving OTLP; Tempo for traces (ADR lists Prometheus/Grafana/Loki; add Tempo for traces). |
| `codex app-server generate-ts --out packages/runtime-codex/schemas` | TS types for the Codex protocol | Regenerate on every pinned Codex version bump; commit output. |

---

## Decision 1 — ORM / query layer: Drizzle (RC line) on `pg`

**Recommendation:** `drizzle-orm@1.0.0-rc.4` + `drizzle-kit@1.0.0-rc.4` with the `node-postgres` driver (`pg` 8.23). Confidence MEDIUM.

**Why Drizzle**

- RLS is a first-class schema concept: `pgPolicy(name, { as, to, for, using, withCheck })`, `pgRole`, and `.enableRLS()` on tables; drizzle-kit generates the `CREATE POLICY` / `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` DDL in the same migration as the table. That keeps policies reviewable next to the columns they protect, which is exactly what "tenant isolation is a test target" (ADR-0003) needs.
- SQL-shaped API: `set_config` inside `db.transaction()` is a one-liner; there is no hidden batching layer between our code and the transaction (Prisma's RLS extension has exactly that problem — see below).
- Zero runtime engine; works identically in the API, in tests (testcontainers), and in the daemon if it ever needs SQLite.
- better-auth 1.7 ships a Drizzle adapter that peer-supports both `^0.45.2` and `>=1.0.0-rc.1`, and 1.7 added "Drizzle Relations v2" support — so auth tables live in the same Drizzle schema and the same migration stream.

**Why the RC line and not 0.45.x:** v1 introduces Relational Queries v2 (a different `relations` definition). Starting a greenfield codebase on 0.45 means a guaranteed migration of every relation definition within months; starting on rc.4 means occasional RC bumps. Pin exact versions (`saveExact`), read the `v0 → v1 changes` page once, and treat the stable 1.0.0 release as a normal bump. If an RC regression blocks a phase, the fallback is `drizzle-orm@0.45.2` — the query API is the same; only relations differ.

**Tenant-scoping pattern (prescriptive)**

1. Two database roles: `migrator` (table owner, used only by `drizzle-kit migrate` in the compose init/CI job) and `app` (`NOLOGIN` inherited by the API's login role, **not** the table owner, no `BYPASSRLS`). RLS is silently bypassed for table owners unless `FORCE ROW LEVEL SECURITY` is set; using a separate app role is the safer default and is what the tests should assert.
2. Every organization-scoped table: `organization_id uuid not null` + `.enableRLS()` + one `pgPolicy` per command family using `current_setting('app.organization_id', true)::uuid`. Global tables (users, devices, providers catalog) get explicit policies too — default-deny is the goal.
3. A Fastify `onRequest` hook resolves the session → active organization and opens the request-scoped transaction: `await tx.execute(sql\`select set_config('app.organization_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)\`)`. Modules receive `tx`, never the root `db`. This is the only place `set_config` is allowed (Biome `noRestrictedImports` on the root db export outside `packages/db`).
4. The realtime and job-worker paths (no HTTP request) use the same helper (`withTenant(orgId, fn)`), because pg-boss jobs and WS handlers also read tenant data.
5. Integration test suite: for every tenant-scoped table, insert as org A, read as org B, expect zero rows; run against Postgres 18 in testcontainers with the `app` role.

**Why not Prisma (7.10 stable; 8.0 in RC):** Prisma 7 became Rust-free and much faster, but (a) the schema DSL still cannot declare policies or roles, so RLS DDL lives in hand-written SQL migrations outside the model, (b) the official RLS pattern is a client extension that wraps *every* query in a batch transaction with `set_config`, which the Prisma docs themselves say conflicts with explicit `$transaction()` calls — unacceptable for message-insert + outbox + audit writes that must share one transaction, (c) generated-client indirection is more magic for AI coding agents to reason about (ADR-0002 rationale applies).

**Why not Kysely (0.29.5):** excellent query builder and it *is* what better-auth uses internally, but it has no schema-as-code, so policies, roles and tables would be maintained in a separate migration tool (node-pg-migrate 9 or raw SQL) with no type link back to the query layer. Drizzle gives the same SQL control plus the schema. Kysely stays as a transitive dependency of better-auth only.

---

## Decision 2 — Auth/identity: better-auth embedded in Fastify

**Recommendation:** better-auth 1.7.4 as a library inside `apps/api/src/modules/identity`, Drizzle adapter, mounted at `/api/auth/*` with the documented Fastify catch-all handler. Confidence MEDIUM.

**Plugins by phase**

| Phase | Plugin | What it gives us |
|-------|--------|------------------|
| MVP 1 | `organization` (with `teams: { enabled: true }`, dynamic access control) | Organization, member, invitation, team tables; `activeOrganizationId` on session; role → permission checks. |
| MVP 1 | `admin` | Org-admin impersonation/ban primitives for the Organization Admin role. |
| MVP 1 | `jwt` + `oauthProvider` | Our server becomes an OIDC provider that issues resource-bound, short-lived JWTs (JWKS at `/api/auth/jwks`). The WS handshake, the daemon and OpenClaw plugins verify tokens with `jose` without a DB round-trip. |
| MVP 2 | `deviceAuthorization` (RFC 8628) | The Local Runtime daemon logs in with a device code shown in the desktop app / terminal; user approves in the browser; daemon receives a JWT + refresh token. Native clients authenticate with `client_id` only. |
| MVP 2 | (ours) `Device` / `DeviceSession` tables | After device-grant login the daemon generates an Ed25519 key pair (`node:crypto`), registers the public key; every WS connect presents the JWT **and** a signed nonce, giving the "signed device identity" NFR (PRD §99). better-auth does not model device keys; keep that in our Identity module. |
| Enterprise | `@better-auth/sso` 1.7.4 | OIDC and SAML upstream IdPs per organization (this is where Keycloak/Entra/Okta plug in). |
| Enterprise | `@better-auth/scim` 1.7.4 | Inbound SCIM 2.0 (users, groups, group→role projection); rebuilt in 1.7 and decoupled from the org plugin. |
| MVP 4+ | `@better-auth/mcp` 1.7.4 | MCP authorization profile (2026-07-28) when MCP servers need OAuth. |

**Org hierarchy caveat (important for the roadmap):** better-auth organizations are **flat** (org + optional teams, no nesting). The PRD needs organization → department → team → project with least-privilege intersection. Prescription: better-auth owns *authentication, sessions, org membership and invitations*; our Organization module owns `OrgUnit` (adjacency list or ltree), project membership, the four PRD roles and the effective-permission calculator. Map better-auth's org `member.role` to the PRD roles one-to-one, and store dept/team/project scopes in our tables. Do not try to bend better-auth teams into departments.

**Why a library and not an embedded IdP**

- One container fewer in `docker compose up`, and users/orgs live in the same Postgres schema that RLS protects. With Keycloak/Zitadel/Ory the user id is foreign; every `organization_id` policy needs a sync path and the hierarchy still has to be modelled on our side.
- Keycloak (26.x) is a JVM service with heavy memory; its realm model does not fit self-service multi-tenant SaaS (Keycloak's "organizations" feature is newer and thinner). Zitadel has real Organizations and is Go, but its org/role model is still not our hierarchy, and it is a second product to secure, upgrade and audit. Ory is API-first and modular, but four services (Kratos, Hydra, Keto, Oathkeeper) for what better-auth does in-process is the wrong trade for a compose-first product.
- Enterprise "bring your own IdP" is what customers actually want; the SSO plugin gives them that without us *being* the IdP.
- better-auth already covers the two hardest MVP 2 needs: RFC 8628 device grant and resource-bound JWTs.

**Watch-outs:** 1.7 required schema migrations (identity normalisation); run `@better-auth/cli generate` into Drizzle schema files and commit them rather than letting the CLI migrate at runtime. `@better-auth/cli` is on 1.4.21 — use `npx @better-auth/cli@latest` and verify it emits 1.7 schemas.

**Rejected:** Auth.js (session-centric, no org/device/SCIM story), Lucia (now a guide, not a library; you would rebuild the org/device/SSO plugins yourself), Clerk/WorkOS (hosted, not self-hostable).

---

## Decision 3 — Realtime: `@fastify/websocket` + Redis pub/sub + own protocol

**Recommendation:** one WebSocket per client on `/ws` via `@fastify/websocket` 11.3 (ws 8.21), Redis 8 pub/sub through node-redis 6.2 for cross-instance fan-out, and a small in-house protocol in `packages/protocol`. Confidence MEDIUM.

**Protocol prescription (this is what makes "replayable + reconnectable" real)**

- Envelope: `{ t: 'sub'|'unsub'|'ev'|'ack'|'rpc'|'err', topic, seq?, data }` validated with Zod on both ends; JSON in MVP 1–2 (msgpack later if ever needed).
- Topics: `conv:<id>` (channel, thread, DM, AI chat — all are `Conversation`), `session:<id>` (Work Zone), `org:<id>:presence`, `user:<id>` (notifications). Subscription is authorised server-side per topic using the effective-permission calculator; `permission.denied` is an event, not a silent drop.
- Ordering + replay: every persisted event carries a per-topic monotonically increasing `seq` (a `bigint` column filled inside the insert transaction; `SessionEvent.seq` per session, message `seq` per conversation). Clients reconnect with `sub { topic, afterSeq }`; the server streams rows `> afterSeq` from Postgres, then switches to live. This satisfies PRD §85/§97 with zero extra infrastructure and is exactly the "persist before broadcast" rule in ADR-0003.
- Ephemeral events (typing, presence, LLM token deltas, terminal output chunks) are published to Redis only, never persisted, and are marked `ephemeral: true` so clients do not expect them on replay. The final assistant message / command result is persisted as one event.
- LLM streaming: the Model Gateway emits `assistant.delta` frames every ~50 ms (coalesced), plus a persisted `assistant.message` at the end (and a checkpoint every N tokens so a crash mid-stream leaves a truncated-but-visible message rather than nothing).
- Presence: Redis hash per org with 30 s TTL refreshed by client pings; state transitions (Controlling / Viewing diff / Typing / Following / Away) are just presence payloads.
- Backpressure: `ws` `bufferedAmount` check + `@fastify/under-pressure`; drop ephemeral frames first.
- Client: `packages/realtime-client` (browser `WebSocket`, Node `ws` for the daemon, React Native's built-in WebSocket) with exponential backoff, resume, and a typed `subscribe(topic, handler)`; Zustand stores consume it.

**Why not Socket.IO (4.8.3):** it adds the engine.io framing and its own reconnection/"connection state recovery", but recovery is Redis-adapter-bounded and not backed by our Postgres event log, so we would still build the `afterSeq` replay — at which point Socket.IO only adds bytes, a second protocol and a slower release cadence (last publish 2025-12-23). Room semantics are a 40-line map keyed by topic.

**Why not Centrifugo / Soketi:** Centrifugo is genuinely good (history + recovery, presence, multiple transports, Redis/NATS engines) and is the right answer if the backend were polyglot or if raw connection counts dominated. Here every publish must pass through our permission calculator and be persisted first, so Centrifugo's model becomes "API → HTTP publish → Centrifugo → client" plus a proxy hop back for subscribe authorisation — an extra Go container and network hop in `docker compose up` for capabilities we get from Postgres `seq` + Redis. Soketi (Pusher protocol) is less maintained and has no history. **Revisit trigger:** > ~50k concurrent connections per region, or a second backend language.

**Why not SSE for LLM streaming:** SSE would work for direct AI chats, but multiplayer AI chats need the same stream fanned out to all participants and merged with presence/typing; one WS path is simpler and is what MVP 2's session events need anyway.

---

## Decision 4 — AI provider layer: Vercel AI SDK 7 inside the Model Gateway module

**Recommendation:** `ai@7.0.97` with `@ai-sdk/anthropic@4.0.52`, `@ai-sdk/openai@4.0.65`, `@ai-sdk/google@4.0.67`, `@ai-sdk/openai-compatible@3.0.47`, used only server-side in `modules/model-gateway`. Confidence MEDIUM.

**Why**

- One `streamText()` surface with a normalised stream (text, reasoning, tool-call, tool-result, file parts) across Anthropic, OpenAI, Google and every OpenAI-compatible endpoint; provider-specific knobs stay reachable via `providerOptions` (Anthropic prompt caching, OpenAI reasoning effort).
- v7 (2026-06-25) added exactly the gateway features MVP 3 will need: agent-level tool approvals (with HMAC-signed approval tokens), typed tool/runtime context (pass `{ orgId, userId, conversationId, permissions }` into tools), per-step timeouts, lifecycle callbacks, and **first-class OpenTelemetry registration** plus `node:diagnostics_channel` events — this plugs straight into the ADR-0003 OTel setup.
- `HarnessAgent` (v7) already abstracts Claude Code / Codex harnesses; it is not what we use for Work Zones (those run on the user's machine through our daemon), but it means the same `UIMessage`/part vocabulary can describe both server-side model output and Work Zone assistant events.
- Migration friction between majors is low (v6 → v7 codemod), and the provider packages are versioned independently, so a provider spec bump does not force a gateway rewrite.
- Zod 4 tool schemas are shared with `packages/contracts`.

**Multi-participant conversations (the core value) — prescription**

The SDK models `user`/`assistant`/`tool` roles, not multiple humans. Build the model input in the gateway from *our* persisted `Message` rows: a system block that lists participants (`Victor (Owner, Developer) on MacBook Pro`, `Alex (Team Lead) on web`) and the sharing/permission context; each human message becomes a `user` message whose text is prefixed with an attribution line (`[Alex · 14:02]`), and consecutive human messages are merged where a provider enforces strict alternation. Attribution stays in our DB (author, device, permissions); the model just sees it. Keep this in one function (`buildModelMessages(conversation)`) with snapshot tests — it is the single most product-defining prompt in MVP 1.

**Wire format to clients:** use the AI SDK `UIMessage` + parts types as the persisted shape of assistant messages (text, reasoning, tool-invocation, file). Do **not** use `@ai-sdk/react`'s `useChat` default HTTP transport for multiplayer chats; the stream goes through the WS topic (Decision 3). `useChat` can be wired to a custom `ChatTransport` over the WS later if the hook's optimistic-UI helpers prove valuable; for MVP 1 a Zustand conversation store is simpler and works identically in Next.js and Electron.

**Why not direct provider SDKs:** two streaming formats, two tool-call schemas, two telemetry integrations, and every new provider is a fork of that. The direct SDKs (`@anthropic-ai/sdk` 0.124, `openai` 7.13) remain transitively installed and can be reached through `provider.raw` escapes when a feature has not landed in the AI SDK provider yet.

**Why not a LiteLLM-style proxy container:** it is a Python service with its own config, secrets and upgrade cycle — the opposite of "one command install" — and it would own the per-org budgets/routing that the PRD assigns to *our* Model Gateway (MVP 3). But customers who already run LiteLLM, Portkey or an Azure OpenAI front door can be pointed at through `@ai-sdk/openai-compatible`; that is supported, not recommended.

**Codex / Claude Code in Work Zones do not go through the gateway in MVP 2.** They use the developer's own CLI login; the gateway only governs server-side chats and agents. Routing Work Zone model calls through org provider pools is an MVP 3+ concern (and depends on each vendor's terms — see Decision 6 open question).

---

## Decision 5 — UI stack

**Recommendation:** Next.js 16.3.4 + React 19.3 + Tailwind CSS 4.3.3 + shadcn CLI 4.21 on **Base UI** (`@base-ui/react` 1.8.0), TanStack Query 5.102 + Zustand 5, react-virtuoso 4.18, streamdown 2.6. Confidence MEDIUM.

**Details**

- **Next.js 16.3**: Turbopack is the default for dev and build since 16.0; React Compiler support is stable; TypeScript 7 supported by invoking the `tsc` CLI (`experimental.useTypeScriptCli` in 16.3 preview, default in later 16.3.x — verify the flag on the pinned patch). Use the App Router with a thin server surface: auth pages, SSR shell, deep links; all product UI is client components fed by the WS client. Do **not** implement the API in Next.js route handlers (Fastify is the API, ADR-0002).
- **shadcn + Base UI**: since 2026-07-03 new shadcn installs default to Base UI; the shadcn team explicitly recommends Base UI for new projects. Radix remains supported (`shadcn init -b radix`) but there is no reason to start on the deprecated default. Base UI 1.8 is production-ready (6M+ weekly downloads). Note the current package is `@base-ui/react`; the old `@base-ui-components/react` name is frozen at 1.0.0-rc.0 — do not install it.
- **Tailwind v4**: CSS-first config; shadcn's `new-york` style is the only style going forward. Put the Tailwind preset and shadcn components in `packages/ui` and consume from both Next.js and the Electron renderer.
- **State**: TanStack Query for anything REST (org tree, settings, history pages, artifacts); Zustand stores for the realtime domain (conversations, presence, session event log, prompt queue) hydrated from REST and then patched by WS events. Do not put WS state in TanStack Query's cache — the invalidation model fights with `seq`-ordered streams.
- **Virtualization**: react-virtuoso — reverse scrolling, prepending older messages without scroll jump, bottom-anchoring while streaming, sticky date headers, all built in. `@tanstack/react-virtual` 3.14 is a great headless engine but bidirectional infinite loading with dynamic heights is a known multi-week effort; not worth it for a chat product.
- **Streaming markdown**: streamdown 2.6 (handles unterminated code fences/tables while tokens arrive; shiki 4 for highlighting). react-markdown 10 is fine for static content but flickers on partial markdown.
- **Composer**: TipTap 3.31 once mentions/slash commands/cards are needed (MVP 1 "agents as participants" phase); a plain textarea before that.
- **Desktop renderer**: Vite 7 + React 19.3 + TanStack Router 1.170, sharing `packages/ui` and `packages/app-core` (stores, realtime client, feature components) with the web app. Loading the Next.js site inside Electron would tie desktop releases to web deploys and complicate offline/daemon-first flows; a bundled renderer is the standard pattern.
- **Expo (MVP 7, recorded only)**: Expo 57 pins React 19.2 while web is on 19.3. Shared packages must declare `react` as a peer dependency and never bundle it; keep `apps/mobile` in the workspace with its own React resolution (pnpm handles this; Expo recommends `nodeLinker: hoisted` for RN monorepos — decide in MVP 7).

---

## Decision 6 — Electron + Local Runtime daemon

**Recommendation:** Electron 44.3, electron-vite 5 (with Vite 7), electron-builder 26 + electron-updater 6; the daemon is `apps/local-runtime` (TypeScript, bundled with tsdown) launched by the desktop app as an Electron **`utilityProcess`** in MVP 2; adapters: Codex via `codex app-server`, Claude Code via the Agent SDK. Confidence MEDIUM for the shell; LOW–MEDIUM for the adapters because both vendor protocols change weekly.

### 6.1 Shell and packaging

- **Electron 44.3.0**: Chromium 152, **Node 24.18.1**, V8 15.2; macOS 13+ only. Electron majors ship every ~8 weeks — pin and bump on a schedule.
- **electron-vite 5.0.0** for main/preload/renderer builds. Its peer range is `vite ^5 ‖ ^6 ‖ ^7`; Vite `latest` is 8.3.0, so `apps/desktop` pins `vite@7` while the rest of the repo can use Vite 8 for Vitest. (Electron Forge 7.11's Vite plugin is still labelled experimental; electron-builder has the broadest installer/updater story and integrates `@electron/rebuild` automatically. Forge is a valid alternative if the team prefers the official toolchain.)
- **electron-builder 26.15 + electron-updater 6.8**: DMG/PKG, NSIS/MSI, AppImage/deb/rpm; generic HTTPS update feed works for self-hosters. `@electron/fuses` 2.1 to disable `runAsNode`/`nodeOptions` in production (safe because the daemon uses `utilityProcess`, not `child_process.fork`).
- **Native modules**: `node-pty` must be rebuilt for Electron's ABI (`@electron/rebuild` 4.2, run by electron-builder) and unpacked from asar (`asarUnpack: ["**/node_modules/node-pty/**"]`, including the `spawn-helper` binary on macOS).

### 6.2 Daemon process model

- MVP 2: `utilityProcess.fork('local-runtime.js')` from the main process. Rationale: same Node ABI as Electron (one rebuild for `node-pty`), crash isolation from the UI, `MessagePort` channel to the renderer, and lifecycle tied to the app — which is enough for "multiple controllers, single executor" while the developer's laptop is on.
- Design the daemon as a standalone package with **no Electron imports**: it exposes a loopback WebSocket (random port + 0600 token file in the app data dir) speaking the same JSON-RPC 2.0 + event envelope, and keeps the *outbound* WS to the Control Plane (Device Relay). The desktop renderer talks to it through `packages/realtime-client`, exactly like it talks to the cloud. This makes the later headless mode (system Node 24, or a Node SEA binary, or the PRD's future Rust rewrite) a packaging change, not an architecture change.
- IPC framing: `vscode-jsonrpc` 9.0.2 (mature, supports stdio, sockets and MessagePort) for daemon ⇄ Codex app-server and Electron ⇄ daemon. `electron-trpc` (last published 2024-12) is not maintained; skip.

### 6.3 Codex adapter — use `codex app-server`, not `@openai/codex-sdk`

- `codex app-server` (in `@openai/codex` 0.154.0) is a long-lived **JSON-RPC 2.0** process, stdio by default (newline-delimited JSON), also Unix socket and WebSocket (WebSocket is documented as experimental and "unsupported for production workloads" — use stdio). It is the same backend behind OpenAI's VS Code extension and desktop app.
- Method map onto the PRD's Work Zone concepts: `thread/start` / `thread/resume` / `thread/fork` (session), `turn/start` (prompt → run), **`turn/steer`** (append input to the active turn with `expectedTurnId` — PRD "Steer"), **`turn/interrupt`** (PRD "Interrupt"), plus `thread/list`, `model/list`. Items: `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`; deltas `item/agentMessage/delta`, `item/commandExecution/outputDelta`. Server→client **approval requests** for command execution and file changes (`accept` / `acceptForSession` / `decline` / `cancel`) map directly to `approval.requested` / `approval.resolved` and to the mobile approval flow.
- Generate TypeScript types with `codex app-server generate-ts --out <dir>` from the pinned CLI version and commit them; there is no separately published TS client package.
- `@openai/codex-sdk` 0.154.0 wraps `codex exec` JSONL: `startThread/resumeThread`, `run()` (buffers a whole turn) / `runStreamed()`. It has no steer, interrupt or approval hooks, so it cannot implement the Prompt Queue or approvals. Use it only for one-shot server-side automations (MVP 5), if at all.
- Auth: Codex uses the developer's ChatGPT/API login; the daemon never sees the token. Require the user-installed CLI (version-checked ≥ 0.154) rather than bundling `@openai/codex`, so their login and config live where they expect.

### 6.4 Claude Code adapter — Claude Agent SDK, streaming-input mode

- `@anthropic-ai/claude-agent-sdk` 0.3.267 (bundles Claude Code 2.1.267 as a native optional dependency; SDK minor tracks the CLI). Use `query({ prompt: AsyncIterable<SDKUserMessage>, options })` — the documented "streaming input mode", which gives **queued messages while a turn runs, interruption (`AbortController`), image inputs, permission requests surfaced to us, and session management**. Single-message mode explicitly lacks queueing and interruption.
- Mapping: `canUseTool` → `approval.requested` (route to cloud, wait for `approval.resolved`, return `allow`/`deny`); `hooks` (PreToolUse/PostToolUse/SessionStart/SessionEnd) → `tool.*`, `session.*`; `includePartialMessages: true` → `assistant.delta`; `resume` / `forkSession` / `resumeSessionAt` → session resume and (future) session forking; `permissionMode` + `allowedTools`/`disallowedTools` → Work Zone permission projection. "Steer" for Claude Code = pushing a new `SDKUserMessage` into the input iterable mid-turn (Claude Code queues/steers it); "Interrupt" = abort + resume with a new prompt.
- The V2 session API (`unstable_v2_createSession`) was **removed in 0.3.142**; do not design around it. `startup()` pre-warm can hide subprocess spawn latency.
- Equivalent low-level path is `claude -p --output-format stream-json --input-format stream-json`; the SDK is that plus typing. Prefer the SDK.
- **Open question for the MVP 2 research flag:** whether third-party harnesses may drive Claude Code with a *subscription* (Claude Pro/Max) login versus an API key, and the analogous Codex terms. Vendor policy here changed during 2026 and could not be verified from primary sources in this pass; treat it as a legal/product risk to confirm before building the adapters, and design the adapter so the credential source is the user's own CLI login.

### 6.5 Terminal, git, files

- **node-pty 1.1.0** for the Terminal adapter; stream chunks as ephemeral `command.output` frames; persist only command start/end + truncated tail. `@xterm/xterm` 6 renders on all clients.
- **simple-git 3.36** for the Git adapter (status, branch, base/current commit, `diff --name-status`, unified diffs, worktree list). It shells out to system git, which Codex and Claude Code require anyway, and stays correct on large repos, hooks and worktrees. `isomorphic-git` 1.41 (pure JS) is slower on big repos and diverges from real git behaviour; not recommended.
- Never send absolute paths: the daemon maps every path to `project-relative` before emitting `file.changed` / `git.diff` (PRD §48, PROJECT.md constraints). `chokidar` 5 + `ignore` 7 for change detection with `.gitignore` semantics; `isbinaryfile` / `file-type` before uploading artifacts.

---

## Decision 7 — Object storage, secrets, OpenTelemetry

- **S3**: `@aws-sdk/client-s3` 3.1129 + `@aws-sdk/s3-request-presigner` (browser/desktop direct uploads via presigned PUT) + `@aws-sdk/lib-storage` (multipart, resumable uploads — PRD NFR). `forcePathStyle: true`, `endpoint` from env, server-side encryption headers or client-side envelope encryption with keys from the secret store (the PRD's "encrypted upload"). The `minio` npm client (8.0.7) works but is vendor-shaped; the AWS SDK works with MinIO, Garage, SeaweedFS, R2 and real S3 unchanged. *Compose note (LOW confidence, verify in the infra phase):* MinIO's community edition has been shedding features; keep the S3 API as the contract and be ready to swap the compose image for Garage or SeaweedFS.
- **OpenBao**: there is **no official JavaScript client** (official libs are Go and Rust; the Vault ecosystem clients are community). Write a ~200-line typed client on Node's `fetch`/`undici` covering AppRole login + token renewal, KV v2 read/write, and Transit encrypt/decrypt/datakey, behind the ADR-0003 `SecretStore` interface (`resolve(SecretReference)`, `encrypt`, `decrypt`, `rotate`). The API surface is small, the abstraction must also fit AWS/GCP KMS, and it avoids depending on `node-vault` 0.12 (published 2026-04, sparse) or `@litehex/node-vault` 1.1.7 (Zod-typed, updated 2026-08 — acceptable if the team prefers not to own the client, LOW confidence on longevity).
- **OpenTelemetry**: `@opentelemetry/sdk-node` 0.222 (SDK 2.x generation; `sdk-trace-node`/`sdk-metrics`/`resources` 2.11, `api` 1.9.1) with an explicit instrumentation list: **`@fastify/otel` 0.21** (the removed `instrumentation-fastify` must not be used; register with `registerOnInitialization: true`), `instrumentation-pg` 0.74, `instrumentation-redis` 0.70 (node-redis), `instrumentation-pino` 0.68 (trace-id injection + log export), `instrumentation-undici`. AI SDK 7's telemetry registration feeds model spans (tokens, TTFT, tool calls) into the same tracer. OTLP/HTTP exporters → one `otel-collector` container → Prometheus (metrics), Loki (logs), **Tempo (traces — add to the ADR-0003 list)**, Grafana. Daemon and Electron main also ship OTLP to the Control Plane's collector endpoint when the user opts in.

---

## Verified versions of already-decided tools

| Tool | ADR assumption | Verified 2026-09-10 | Action |
|------|----------------|---------------------|--------|
| Node.js | 22 LTS, pinned 22.17.0 | 22.23.2 is latest 22.x and in **Maintenance** since 2025-10-21 (EOL 2027-04-30); **24.21.0** is Active LTS (Maintenance from 2026-10-20, EOL 2028-04-30); 26.8.2 becomes LTS 2026-10-28 | Amend ADR-0001 to Node 24 (see concerns); at minimum bump `.nvmrc` to 22.23.2 |
| pnpm | — | 12.3.4 | Use `pnpm-workspace.yaml` for all config |
| Turborepo | — | 2.10.12 | — |
| Biome | — | 2.5.13 | — |
| Vitest | — | 5.0.0 (needs Node ≥ 22.12, Vite ≥ 6.4) | — |
| TypeScript | strict | 7.0.2 (`latest`), 6.0.3 (`typescript@6`) | Pin 7.0.x; keep 6.0.3 alias for tools needing the JS API |
| Fastify | 5 | 5.12.3 | — |
| Next.js | — | 16.3.4 (React 19.3.0) | — |
| Electron | — | 44.3.0 | — |
| Expo | — | 57.0.21 (RN 0.86, React 19.2) | MVP 7 |
| Zod | — | 4.6.1 | — |
| Playwright | — | 1.63.0 | — |

---

## Installation

```bash
# Workspace tooling (root)
corepack enable && corepack prepare pnpm@12.3.4 --activate
pnpm add -Dw turbo@2.10.12 @biomejs/biome@2.5.13 typescript@7.0.2 typescript6@npm:typescript@6.0.3 vitest@5.0.0 tsx@4.23.13 tsdown@0.23.0 @playwright/test@1.63.0 dependency-cruiser@18.2.0 @testcontainers/postgresql@12.1.0

# apps/api — Control Plane
pnpm add fastify@5.12.3 @fastify/websocket@11.3.0 @fastify/cors@11.3.0 @fastify/helmet@13.1.1 @fastify/rate-limit@11.2.0 @fastify/multipart@10.1.1 @fastify/cookie@11.1.2 @fastify/sensible@6.0.5 @fastify/under-pressure@9.1.0 @fastify/swagger@9.8.1 @scalar/fastify-api-reference@1.68.0 fastify-type-provider-zod@7.0.0 fastify-plugin@6.0.0 close-with-grace@2.5.0 pino@10.3.1 zod@4.6.1 \
  drizzle-orm@1.0.0-rc.4 pg@8.23.0 drizzle-zod@0.8.3 pg-boss@12.30.0 redis@6.2.1 \
  better-auth@1.7.4 @better-auth/sso@1.7.4 @better-auth/scim@1.7.4 jose@6.2.12 uuid@14.0.2 \
  ai@7.0.97 @ai-sdk/anthropic@4.0.52 @ai-sdk/openai@4.0.65 @ai-sdk/google@4.0.67 @ai-sdk/openai-compatible@3.0.47 \
  @aws-sdk/client-s3@3.1129.0 @aws-sdk/s3-request-presigner@3.1129.0 @aws-sdk/lib-storage@3.1129.0 undici@8.10.2 \
  @opentelemetry/api@1.9.1 @opentelemetry/sdk-node@0.222.0 @opentelemetry/sdk-trace-node@2.11.0 @opentelemetry/sdk-metrics@2.11.0 @opentelemetry/sdk-logs@0.222.0 @opentelemetry/resources@2.11.0 @opentelemetry/semantic-conventions@1.43.0 @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 @opentelemetry/exporter-logs-otlp-http@0.222.0 @fastify/otel@0.21.0 @opentelemetry/instrumentation-pg@0.74.0 @opentelemetry/instrumentation-redis@0.70.0 @opentelemetry/instrumentation-pino@0.68.0
pnpm add -D drizzle-kit@1.0.0-rc.4 @types/pg pino-pretty@13.1.3

# apps/web — Next.js
pnpm add next@16.3.4 react@19.3.0 react-dom@19.3.0 @tanstack/react-query@5.102.8 zustand@5.0.15 react-virtuoso@4.18.13 streamdown@2.6.0 shiki@4.4.3 better-auth@1.7.4 react-hook-form@7.87.0 @hookform/resolvers@5.9.1 lucide-react@1.44.0 cmdk@1.1.1 sonner@2.0.8 date-fns@4.4.0 react-resizable-panels@4.12.4 @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0
pnpm add -D tailwindcss@4.3.3 @tailwindcss/postcss @tanstack/react-query-devtools@5.102.8
pnpm dlx shadcn@4.21.0 init            # Base UI is the default; do not pass -b radix

# apps/desktop — Electron
pnpm add electron-updater@6.8.9 electron-log@5.4.4 electron-store@11.0.2 @electron-toolkit/preload@3.0.2 @electron-toolkit/utils@4.0.0 @tanstack/react-router@1.170.34 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @pierre/diffs@1.4.1
pnpm add -D electron@44.3.0 electron-vite@5.0.0 vite@7 @vitejs/plugin-react@6.1.1 electron-builder@26.15.3 @electron/rebuild@4.2.0 @electron/fuses@2.1.3 @electron/notarize@3.1.1

# apps/local-runtime — daemon
pnpm add @anthropic-ai/claude-agent-sdk@0.3.267 @modelcontextprotocol/sdk@1.30.0 node-pty@1.1.0 simple-git@3.36.0 vscode-jsonrpc@9.0.2 ws@8.21.3 chokidar@5.0.0 ignore@7.0.9 isbinaryfile@6.0.0 file-type@22.0.2 execa@10.0.1 zod@4.6.1 jose@6.2.12
# Codex: require user-installed `codex` >= 0.154.0; types via `codex app-server generate-ts`
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Drizzle 1.0-rc | Drizzle 0.45.2 stable | If an RC regression blocks a phase; same query API, older relations syntax |
| Drizzle | Prisma 7 | Teams that value the generated client and Prisma Studio over transaction control and in-schema RLS; not this project |
| Drizzle | Kysely + node-pg-migrate | If you want zero schema abstraction and hand-written SQL migrations everywhere |
| better-auth (library) | Zitadel (embedded IdP) | If the product must be an IdP for third parties at launch or needs SCIM/SAML on day one with a UI you do not want to build |
| better-auth (library) | Keycloak | Enterprise deployments that already standardise on Keycloak — support them as an upstream IdP via the SSO plugin instead |
| `@fastify/websocket` + Redis | Centrifugo | > ~50k concurrent connections per region, polyglot backends, or when history/recovery must live outside Postgres |
| `@fastify/websocket` + Redis | Socket.IO | Only if a client platform lacks a decent native WebSocket (none of ours do) |
| AI SDK 7 | Direct provider SDKs | A provider feature not yet exposed through the AI SDK provider; use the `raw` escape, do not fork the path |
| AI SDK 7 | LiteLLM / Portkey proxy | Customer already runs one — connect via `@ai-sdk/openai-compatible` |
| shadcn on Base UI | shadcn on Radix (`-b radix`) | Existing Radix codebase; not applicable to greenfield |
| react-virtuoso | `@tanstack/react-virtual` | Grids/tables or non-chat lists where headless control matters |
| electron-vite + electron-builder | Electron Forge (Vite template) | If the team wants the official toolchain and accepts the experimental Vite plugin |
| `utilityProcess` daemon | Standalone Node SEA daemon | Headless hosts (CI runners, servers) — MVP 6+ |
| `codex app-server` | `@openai/codex-sdk` | One-shot, non-interactive automations that never need steer/interrupt/approvals |
| In-house OpenBao client | `@litehex/node-vault` 1.1.7 | If owning ~200 lines of HTTP client is unwanted; check maintenance cadence first |
| AWS SDK v3 S3 | `minio` JS client | Only if MinIO-specific admin APIs are needed (they are not in MVP 1–2) |
| node-redis | ioredis 6.0 | Existing Cluster/Sentinel-heavy code; Redis itself recommends node-redis for new projects |
| pg-boss | graphile-worker 0.18 | Preference for its job-function model; both are Postgres-only and fine |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@opentelemetry/instrumentation-fastify` | Deprecated Jan 2025, removed from contrib Mar 2026 | `@fastify/otel` 0.21 |
| `@base-ui-components/react` | Old package name frozen at 1.0.0-rc.0 | `@base-ui/react` 1.8.0 |
| `unstable_v2_createSession` (Claude Agent SDK V2) | Removed in SDK 0.3.142 | `query()` with `AsyncIterable<SDKUserMessage>` |
| `@openai/codex-sdk` for interactive sessions | Buffers per turn; no steer/interrupt/approval hooks | `codex app-server` JSON-RPC over stdio |
| Codex app-server **WebSocket** transport in production | Documented as experimental/unsupported | stdio transport |
| `electron-trpc` | Unmaintained since 2024-12 | `vscode-jsonrpc` over MessagePort / loopback WS |
| `child_process.fork` from Electron main | Depends on the `runAsNode` fuse you should disable | `utilityProcess.fork` |
| Socket.IO | Second protocol layer, slower cadence, replay not Postgres-backed | `@fastify/websocket` + own envelope |
| Prisma client-extension RLS | Wraps every query in a batch transaction; breaks explicit `$transaction` | Drizzle `db.transaction` + `set_config` |
| Running RLS tests as the table-owner role | Owners bypass RLS unless forced; tests pass vacuously | Dedicated `app` role in testcontainers |
| `package.json#pnpm` config | Ignored by pnpm 12 | `pnpm-workspace.yaml` |
| Vite 8 in `apps/desktop` | electron-vite 5 peer range stops at Vite 7 | `vite@7` in the desktop app only |
| `@fastify/redis` | Wraps ioredis (maintenance mode) | 30-line plugin around node-redis 6 |
| `isomorphic-git` for the Git adapter | Slow on large repos, behavioural drift from real git | `simple-git` over system git |
| `react-markdown` for streaming assistant text | Flickers on partial markdown | `streamdown` |
| `tsup` for new packages | Maintenance mode | `tsdown` |
| Next.js route handlers as the API | Violates ADR-0002; splits auth, RLS and OTel across two servers | Fastify `apps/api` |
| `useChat` default HTTP transport for multiplayer chats | Bypasses the WS fan-out and `seq` replay | WS topic → Zustand store (custom `ChatTransport` later if wanted) |

---

## Stack Patterns by Variant

**If a Work Zone runtime is added (OpenCode, MVP 3+):**
- Implement it as another `AgentRuntime` adapter in `apps/local-runtime` speaking the same internal event vocabulary; OpenCode exposes an HTTP/SSE server, so wrap it the way the Codex adapter wraps JSON-RPC.
- Because adapters normalise into `packages/protocol` events, no Control Plane change should be required.

**If an organisation brings its own OpenAI-compatible gateway (LiteLLM, Azure front door):**
- Register it as a `Provider` of kind `openai-compatible` and instantiate `createOpenAICompatible({ baseURL, apiKey: resolve(SecretReference) })` per provider pool.

**If connection counts outgrow a single Fastify pod's fan-out (post-MVP):**
- Introduce NATS JetStream per ADR-0003's trigger; the `seq` + replay contract already isolates the transport, so only `packages/realtime-server` changes.

**If the daemon must run headless (MVP 6 Device Relay on servers/CI):**
- Package `apps/local-runtime` as a Node SEA (Node 24) or run with system Node 24; `node-pty` then needs the Node ABI prebuild instead of the Electron rebuild — keep both build targets in CI from MVP 2 so the switch is exercised.

**If TypeScript 7.0 breaks a tool (dts bundling, editor plugin):**
- Point that tool at the `typescript6` alias (6.0.3) while `tsc --noEmit` stays on 7.0; remove the alias when TypeScript 7.1 ships the stable JS API.

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `vitest@5.0.0` | Node `^22.12 ‖ ^24 ‖ ≥26`, `vite ^6.4 ‖ ^7 ‖ ^8` | Node 22.17 (current ADR pin) is inside the range, but Node 24 is recommended |
| `electron-vite@5.0.0` | `vite ^5 ‖ ^6 ‖ ^7` | **Not** Vite 8; pin `vite@7` in `apps/desktop` |
| `fastify-type-provider-zod@7.0.0` | `fastify ^5.5`, `zod ≥4.1.5`, `@fastify/swagger ≥9.5.1` | Zod 4.6.1 OK |
| `ai@7.0.97`, `@ai-sdk/*@4` | Node ≥ 22, `zod ^3.25.76 ‖ ^4.1.8` | Zod 4.6.1 OK |
| `@anthropic-ai/claude-agent-sdk@0.3.267` | `zod ^4`, `@anthropic-ai/sdk ≥0.93`, `@modelcontextprotocol/sdk ^1.29` | Bundles Claude Code 2.1.267; SDK minor == CLI minor |
| `better-auth@1.7.4` | `drizzle-orm ^0.45.2 ‖ ≥1.0.0-rc.1 <2`, `drizzle-kit ≥0.31.4 ‖ ≥1.0.0-beta.1`, `pg ^8`, `next ^16`, `react ^19`, `vitest ^5` | Internally depends on `kysely ^0.28.17 ‖ ^0.29` |
| `next@16.3.4` | `react ^19`, Node ≥ 20.9, `@opentelemetry/api ^1.1`, `@playwright/test ^1.51` | TypeScript 7 via tsc CLI (≥ 16.2.12) |
| `@ai-sdk/react@4.0.100` | `react ^18 ‖ ~19.0.1 ‖ ~19.1.2 ‖ ^19.2.1` | React 19.3 OK if the hook is adopted later |
| `pg-boss@12.30.0` | Node ≥ 22.12 | — |
| `@fastify/otel@0.21.0` | `@opentelemetry/api ^1.9` | Register before Fastify instance creation or with `registerOnInitialization` |
| `node-pty@1.1.0` | Electron 44 ABI via `@electron/rebuild@4.2.0` | Must be `asarUnpack`ed; `spawn-helper` on macOS |
| `expo@57.0.21` | `react-native 0.86`, React 19.2 | React version differs from web (19.3): shared packages declare React as peer only |
| `typescript@7.0.2` | Next ≥ 16.2.12, Biome 2.5, Vitest 5 (no tsc dependency) | No JS compiler API until 7.1; keep `typescript@6.0.3` alias |
| `drizzle-orm@1.0.0-rc.4` | `drizzle-kit@1.0.0-rc.4`, `pg ≥ 8`, `@opentelemetry/api ^1.4.1` | Pin both to the same RC |

---

## Concerns about decided constraints

1. **Node 22 LTS (ADR-0001) should become Node 24 LTS.** Evidence from nodejs.org's release index and schedule: 22.x entered Maintenance on 2025-10-21 and the pinned 22.17.0 is six patch releases behind (22.23.2). Node 24.21.0 is the Active LTS today, Electron 44 embeds Node 24.18.1 (so the daemon and shell align), and Vitest 5 / pg-boss 12 / AI SDK 7 all require ≥ 22.12 — nothing in the chosen stack needs 22 specifically. The "odd-numbered releases are not used" rule is preserved. Proposed amendment: `.nvmrc = 24.21.0`, revisit when 26 becomes LTS on 2026-10-28 only if Electron's bundled Node moves with it. If the ADR is kept on 22, bump the pin to 22.23.2 immediately.
2. **TypeScript strict (ADR-0001) is unaffected, but the `typescript` package major changed under us.** `typescript@latest` is now 7.0.2 with the native compiler and no JS API. This is good for `pnpm verify` speed but must be recorded: add the 6.0.3 alias for API consumers and note that TypeScript 7.1 removes the need for it.
3. **ADR-0003 observability list omits a trace backend.** Prometheus/Grafana/Loki cover metrics and logs; add Grafana Tempo (or Jaeger) for traces, otherwise OTel traces have nowhere to go in compose.
4. **Not a challenge, but a scope note on "Redis":** Redis 8 reverted to AGPL (compatible with this project); Valkey is a drop-in if a customer objects. node-redis 6 supports both.

None of these change the architecture; they are pin/list corrections.

---

## Sources

Versions (read directly from the registries on 2026-09-10; classified MEDIUM by the research seam because registry lookups are not a curated provider):
- registry.npmjs.org `npm view <pkg> version|dist-tags|peerDependencies|engines|time.modified` for every package listed above
- https://nodejs.org/dist/index.json and https://raw.githubusercontent.com/nodejs/Release/main/schedule.json — Node 22/24/26 versions, LTS and EOL dates

Primary documentation fetched (MEDIUM — web-verified, cross-checked with registry data):
- https://orm.drizzle.team/docs/rls — `pgPolicy`, `pgRole`, `enableRLS`, role management in drizzle-kit
- https://orm.drizzle.team/docs/latest-releases and the drizzle-orm `rc`/`beta` dist-tags — 1.0.0-rc.4 status, Relational Queries v2
- https://better-auth.com/blog/1-7 — 1.7 release (2026-08-17): device authorization (RFC 8628), SCIM rebuild, SSO bridge, `@better-auth/mcp`, breaking schema changes
- https://better-auth.com/docs/plugins/device-authorization — endpoints and CLI/daemon token flow
- https://better-auth.com/docs/plugins/organization — flat org model, teams, dynamic access control, schema tables
- https://better-auth.com/docs/integrations/fastify — catch-all handler, `fromNodeHeaders`
- https://centrifugal.dev/docs/getting-started/comparisons — Centrifugo vs Socket.IO vs raw WS + Redis
- https://vercel.com/blog/ai-sdk-7 — AI SDK 7 (2026-06-25) features; https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- https://nextjs.org/blog/next-16 and https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli — Turbopack default, TypeScript 7 support
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default — Base UI default (2026-07-03), `-b radix` flag
- https://expo.dev/changelog/sdk-57 — SDK 57 (2026-06-30), RN 0.86, React 19.2
- https://code.claude.com/docs/en/agent-sdk/typescript — `query()` options, permissions, hooks, sessions, `startup()`
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode — streaming input mode capabilities (queueing, interruption)
- https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview — V2 session API removed in 0.3.142
- https://developers.openai.com/codex/app-server (served from learn.chatgpt.com/docs/app-server) — JSON-RPC methods, items, approvals, transports, `generate-ts`
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md — `@openai/codex-sdk` API and limits
- https://www.electronjs.org/blog/electron-44-0 — Chromium 152 / Node 24.18.1 / macOS 13+
- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules and https://github.com/electron/rebuild — ABI rebuild requirements
- https://www.electronjs.org/docs/latest/tutorial/fuses — `runAsNode` fuse vs `utilityProcess`
- https://www.npmjs.com/package/@opentelemetry/instrumentation-fastify and https://github.com/fastify/otel — removal of contrib Fastify instrumentation in favour of `@fastify/otel`
- https://redis.io/docs/latest/develop/clients/ioredis/ and https://github.com/redis/ioredis — node-redis recommended for new projects
- https://openbao.org/api-docs/libraries/ — no official JS client (page fetched via curl; Go/Rust official)
- https://pnpm.io/blog/releases/12.0 and https://pnpm.io/migration — config moved to `pnpm-workspace.yaml`
- https://github.com/vitest-dev/vitest/releases/tag/v5.0.0 — Node/Vite requirements
- https://www.infoq.com/news/2026/08/typescript-7-released/ — TypeScript 7.0 native compiler, JS API deferred to 7.1

Secondary / community (LOW — used only for framing, not for any version or API claim):
- https://theroadtoenterprise.com/blog/postgres-rls-multi-tenant-saas — transaction-scoped `set_config` pattern
- https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security — Prisma RLS extension and its `$transaction` limitation
- https://devhandbook.io/blog/2026-08-08-self-hosted-auth-sso-showdown/ — Keycloak / Zitadel / Ory positioning
- https://www.pkgpulse.com/guides/tanstack-virtual-vs-react-window-vs-react-virtuoso-2026 — virtualization comparison for chat
- https://www.deskifier.com/blog/electron-forge-vs-electron-builder — Forge vs builder framing
- https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/ — `turn/steer` semantics (corroborated by the official app-server docs)

---
*Stack research for: Open Collaborative AI Workspace (MVP 1 + MVP 2)*
*Researched: 2026-09-10*
