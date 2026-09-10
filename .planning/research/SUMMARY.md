# Project Research Summary

**Project:** Open Collaborative AI Workspace
**Domain:** Open-source, self-hostable, multiplayer collaborative AI workspace (Slack-style chat + shareable multiplayer AI chats + cloud-owned coding-agent "Work Zones" executed locally via Codex / Claude Code)
**Researched:** 2026-09-10
**Confidence:** MEDIUM

Milestone scope: PRD MVP 1 (Collaborative Workspace) + MVP 2 (Multiplayer Work Zone). Core value under test: **AI sessions are multiplayer** — a private AI chat or coding session shared live with a colleague, with the model aware of who each participant is and everything attributed and auditable.

## Executive Summary

This is a three-surface product (team chat, shared AI chats, multiplayer coding-agent sessions) whose closest existing references are each one-third of it: Slack/Zulip/Mattermost for chat, ChatGPT group chats and Dust for shared AI conversations, and Happier/Paseo/Claude Code desktop/Codex app for agent sessions. Nobody combines live multi-human AI conversations with an org hierarchy, server-enforced permissions, prompt identity/audit, and local execution on a colleague's machine; that combination is the product. Experts in each adjacent space converge on the same building blocks the ADRs already chose: a single API process with one WebSocket per client, Postgres as the only source of truth with a per-stream monotonic sequence and cursor replay, Redis strictly for fan-out/presence/locks, and runtime-specific behaviour normalised at the edge by adapters.

The recommended approach is to keep the decided constraints (TypeScript monorepo, Fastify modular monolith, PostgreSQL+RLS, Redis, S3, OpenBao abstraction, OTel) and fill the open decisions as follows: Drizzle 1.0-rc on `pg` with RLS policies in schema and a `withTenant` transaction helper as the only DB entrypoint; better-auth embedded in Fastify (org, admin, jwt, oauthProvider now; deviceAuthorization for MVP 2; SSO/SCIM later) with the org→dept→team→project hierarchy modelled in our own `org_units` (ltree) tables rather than bent into better-auth's flat orgs; `@fastify/websocket` + Redis pub/sub with an in-house Zod envelope and Postgres-backed replay; Vercel AI SDK 7 server-side in the agent/model-gateway module; Next.js 16 + React 19 + Tailwind 4 + shadcn (Base UI) with react-virtuoso and streamdown; Electron 44 with a daemon that talks to Codex via `codex app-server` (JSON-RPC over stdio) and to Claude Code via the Agent SDK in streaming-input mode. Two design rules dominate everything: **one `conversations`/`messages` model for every surface** (sharing is a grant, never a copy) and **the WorkSession lives in the cloud, the daemon only connects outbound**.

The key risks are all "looks done but isn't" failures: RLS silently bypassed because the app connects as the table owner/superuser; a multiplayer AI chat with no turn arbiter and identity injected as free text (spoofable, double generations); runtime adapters built on scraped stdout with approvals disabled to make headless runs finish; absolute paths and secrets leaking from runtime output into every participant's event stream; and AI coding agents weakening guardrails (`it.skip`, `bypassPermissions`, `BYPASSRLS`) to get tests green. Mitigation is mechanical, not advisory: two DB roles and deny-path tenant tests from the first migration, a server-side generation arbiter reused for both AI chats and Work Zones, SDK/app-server adapters with recorded-fixture contract tests and device-side `contain()`/`redact()`, and a `pnpm verify` CI gate with Semgrep rules and CODEOWNERS on security paths from the foundation phase onward.

## Key Findings

### Recommended Stack

STACK.md (MEDIUM; every version read from the registries on 2026-09-10) resolves all six decisions PROJECT.md left open and confirms the decided tools. It also proposes amendments to ADR-0001 and ADR-0003; these are listed under "Decisions to Revisit" below and must be accepted or rejected explicitly, not silently absorbed.

**Core technologies:**
- Node 24.21.0 LTS + TypeScript 7.0.2 (with `typescript@6.0.3` alias), pnpm 12, Turborepo 2.10, Biome 2.5, Vitest 5: runtime and tooling — Node 24 matches Electron 44's embedded Node; TS 7 native compiler is 8-12x faster but has no JS API until 7.1
- Fastify 5.12 + `fastify-type-provider-zod` + `@fastify/swagger`/Scalar: Control Plane HTTP + WS — as decided; Zod 4 contracts at every boundary
- PostgreSQL 18 + Drizzle ORM 1.0.0-rc.4 on `pg` 8.23: only database, schema, migrations, RLS policies in code — RLS is a first-class schema concept; transaction-scoped `set_config`; Prisma rejected for its batch-transaction RLS extension, Kysely for lacking schema-as-code
- better-auth 1.7.4 (library in Fastify, Drizzle adapter): identity, sessions, orgs, invitations, RFC 8628 device grant, JWT/JWKS — one fewer container than Keycloak/Zitadel/Ory; enterprise IdPs plug in later via the SSO plugin
- `@fastify/websocket` 11.3 + node-redis 6.2 + own protocol (`packages/protocol`): realtime — Socket.IO/Centrifugo rejected because replay must be Postgres-backed and publish must pass our permission calculator anyway
- Vercel AI SDK 7 (`ai` 7.0.97, `@ai-sdk/anthropic|openai|google|openai-compatible`): server-side model calls, streaming, tools, OTel — one normalised stream across providers; LiteLLM container rejected (Python service, owns budgets the PRD assigns to our gateway)
- Next.js 16.3 + React 19.3 + Tailwind 4.3 + shadcn on Base UI, TanStack Query 5, Zustand 5, react-virtuoso 4.18, streamdown 2.6, shiki 4: web UI — Turbopack default; WS state in Zustand, REST state in TanStack Query
- Electron 44.3 + electron-vite 5 (Vite 7 pinned) + electron-builder 26 / electron-updater 6; daemon = `apps/local-runtime` bundled with tsdown; `@anthropic-ai/claude-agent-sdk` 0.3.x; user-installed `codex` >= 0.154 via `codex app-server`; node-pty 1.1, simple-git 3.36, vscode-jsonrpc 9
- `@aws-sdk/client-s3` 3 with `forcePathStyle`; in-house ~200-line OpenBao client behind `SecretStore` (no official JS SDK exists); OTel SDK 2.x with `@fastify/otel` 0.21 (the contrib Fastify instrumentation was removed in 2026-03), `instrumentation-pg|redis|pino`; pg-boss 12 for the Postgres job table

**Do not use:** `@opentelemetry/instrumentation-fastify`, `@base-ui-components/react`, `@openai/codex-sdk` for interactive sessions, Codex app-server WebSocket transport, `electron-trpc`, Socket.IO, Prisma RLS extension, `package.json#pnpm`, Vite 8 in the desktop app, `isomorphic-git`, `react-markdown` for streaming, `tsup`, Next.js route handlers as the API.

### Expected Features

FEATURES.md (MEDIUM; 30+ sources, official docs for Claude Code, Codex, Conductor, Cursor, Devin, Zulip, Open WebUI, Happier) maps every feature to the PRD and lists 15 MVP1 and 14 MVP2 items the PRD is silent on but users will notice on day one. The roadmapper should treat the "PRD gaps" as requirements, not nice-to-haves.

**Must have (table stakes):**
- Auth, email invites (copyable links, SMTP optional), password reset, org bootstrap on first `docker compose up`, minimal admin CRUD (users, roles, departments, teams, projects) — PRD gap; nothing works without it
- Channels (public/private), side-panel threads, DMs and group DMs, realtime with presence/typing, unread and mention badges, notification preferences (mute, DND, mention-only) — every team chat has these
- Markdown + code blocks (one renderer shared with AI chats and agent output), edit/delete with audit, reactions, attachments via the upload pipeline, pins/permalinks, Postgres FTS search — Slack baseline
- Org-level model provider configuration (keys in secret store, allowed models) as a thin slice of the MVP3 gateway; AI chat basics: streaming, stop, regenerate, auto-title, list/rename/archive, custom instructions, per-generation usage row
- Work Zone solo baseline at parity with the free official GUIs: session sidebar with status, new-session dialog (project, runtime, model, permission mode, host), event stream with Normal/Verbose/Summary view modes, approval prompts, permission modes mapped across runtimes, interrupt, queue, changed files + diff, git state header, read-only terminal stream, worktree-per-session option, resume/reattach with explicit "host offline" state, runtime detection/version report, open-in-editor, desktop notifications
- Device pairing/revocation for the daemon (minimum of PRD §38)

**Should have (competitive):**
- Live multiplayer AI chat with structural attribution, participant-aware prompt assembly, explicit response-trigger policy and serialised generation — the core value
- In-place progressive sharing (private → person → team) as grants on the same conversation, with a share dialog that shows exactly what becomes visible
- Agents as first-class participants (hosted persona entity: model + instructions + tools + scope) in channels/DMs with thread-aware mention replies, and typed Agent Cards with `[Open] [Follow] [Approve]` actions
- WorkSession as an org-owned entity executed on any paired member device; multiple controllers, single executor with server-side arbitration; prompt identity + audit; 15 permission grains shipped as 3-4 templates (Owner / Collaborator / Reviewer / Viewer); shared multi-author Prompt Queue with priority and run-next; steer only where the adapter reports `supportsSteer` (Codex yes, Claude Code no → head-of-queue)
- Chat → Work Zone creation with host consent and a live agent card posted back to the originating thread
- Session presence states (Controlling / Viewing diff / Typing / Following / Away) and Follow Session

**Defer (v1.x / v2+):**
- Link unfurls, edit-and-branch prompts, diff line comments as queued prompts, Zulip-style resolve/move thread, Cmd+K switcher, effective-permission viewer, transcript export — v1.x once the underlying model is stable
- Model Gateway/pools/budgets (MVP3), skills/MCP/policies (MVP4), OpenClaw/automations/scheduled runs (MVP5), Device Relay/mobile (MVP6-7), managed workers, session forking, federation
- Anti-features never to build: voice/video, per-room E2E, infinite threads, docs/boards, per-user BYOK as the primary path, auto-responding model on every group message, interactive remote terminal for non-host users, full IDE panes, public share links for sessions, multiple agents on one working tree

### Architecture Approach

ARCHITECTURE.md (MEDIUM; HIGH where it restates PRD/ADRs, MEDIUM for the runtime contracts verified against official docs on 2026-09-10) describes a Fastify modular monolith of 11 modules wired by explicit constructor injection (no DI container), a persist-then-publish realtime core with a per-stream `seq` allocated under a stream row lock, one `conversations`/`messages` model with `kind` for channel/dm/group/ai_chat/thread, grants-not-copies sharing, an `organization.resolveEffectivePermissions` intersection function used by every route, RLS that enforces only the organization boundary, and a Local Runtime daemon that normalises Claude/Codex events into the Unified Session Event Protocol on-device before anything crosses the wire. Everything the server wants a device to do is a `runtime_commands` row delivered over the outbound device link and acked; the arbiter reacts to acks, which turns "host went to sleep" into a visible, recoverable `host_offline` state rather than data loss.

**Major components:**
1. `apps/api` modules: identity, organization, realtime, chat, agent, artifact, audit, notification (MVP1); project, device, worksession (MVP2). Each exposes only `index.ts`; `dependency-cruiser` enforces boundaries from the second module.
2. `apps/api/src/ws/`: transport-only `/ws` (clients, one socket, many topic subscriptions with `afterSeq` replay) and `/runtime/ws` (devices, Ed25519 challenge auth, commands down / events up).
3. `packages/db`: Drizzle schema, RLS policies, `withTenant()` as the sole entrypoint, monthly-partitioned `stream_events`; `packages/contracts` (HTTP Zod schemas) and `packages/protocol` (Unified Session Event Protocol + Device Link protocol), both Apache-2.0.
4. `apps/local-runtime` daemon: device link client with offline append log, SessionSupervisor, `AgentRuntime` adapters (ClaudeCodeRuntime via Agent SDK, CodexRuntime via app-server), Git/FS adapters with containment and redaction, project registry (absolute paths never leave the device).
5. `apps/web` (Next.js) and `apps/desktop` (Electron shell + daemon supervisor + Work Zone UI) sharing `packages/ui` and `packages/sdk`/`app-core`.

**Key patterns:** persist-then-publish with per-stream seq; single executor claimed by Redis `SET NX PX` lock (AI run loop per conversation, prompt arbiter per session); adapter normalises at the edge; grants not copies; commands table for at-least-once daemon delivery; multi-human prompt assembly = roster in system prompt + structured `<message author=...>` blocks + server-side merge of consecutive human messages + ~1.5 s debounce + one active run per conversation.

### Critical Pitfalls

PITFALLS.md (MEDIUM; HIGH for facts from official Claude Code / Codex docs) lists 13 critical pitfalls. The five that would cause rewrites or incidents if missed:

1. **RLS silently off** (app connects as owner/superuser, `SET` instead of `SET LOCAL`) — two roles (`migrator` owner, `app` NOBYPASSRLS) from the first migration, `FORCE ROW LEVEL SECURITY` emitted by the generator, `withTenant` as the only DB entrypoint, CI test that enumerates `pg_tables` and asserts zero cross-tenant rows as the app role, plus a `pg_roles` assertion on the app connection.
2. **Fragmented conversation model + ordering by `created_at`/global serial + Redis as truth** — one `conversations`/`messages` schema decided in contracts before chat is built; `(stream_id, seq)` allocated under a row lock; Redis only as a hint; unread = `last_seq - last_read_seq`; write the share and agent-card flows as tests against the chat schema before the chat phase closes.
3. **Multiplayer AI chat without an arbiter and with textual identity** — per-conversation generation arbiter (Redis lock + `model_runs` row, one in-flight run, queued/coalesced follow-ups visible in the UI); identity is structural (server-generated wrappers, escaped user text); tools run with `intersection(agent, triggering human)`; user-private context never injected into multi-participant conversations; a fixed three-participant eval fixture asserting correct addressing and refusal of a spoofed authority claim.
4. **Adapters on scraped stdout with approvals bypassed; paths/secrets leaking through events** — Agent SDK `query()` with `canUseTool` → approval round-trip; `codex app-server` with committed `generate-ts` types; tolerant parsers (`runtime.raw` on unknown events); recorded-fixture contract tests per runtime version; `contain()`/`redact()` on the device applied to structured fields and free text; `disallowedTools`/sandbox denies for `.env*`, `~/.ssh`, `~/.aws`; Semgrep rule failing CI on any bypass token.
5. **Daemon/Electron lifecycle: orphans, working-tree fights, sleep, open localhost port, unsigned builds, boot-generated secrets** — process groups + pidfile reaping, one active runtime per registered path with worktree offered for the second, `powerMonitor` + 90 s server grace → `waiting(host_offline)` never `failed`, Unix socket / named pipe or token + exact Origin/Host for shell↔daemon, signing/notarization in CI before the first internal build, `protocolVersion` handshake in the contract now, secrets as required inputs written by a `setup` script, one-shot `migrate` service.

Cross-cutting: **AI agents weaken guardrails to pass tests** — `pnpm verify` with grep/Semgrep rules, CODEOWNERS on `packages/db/**/policies*`, auth, adapters and policy paths, deny-path tests with 90% coverage targets and weekly mutation testing, PRD section ids in every plan and PR, Scenario A/B acceptance specs committed as skipped E2E tests at the start of MVP2.

## Decisions to Revisit (ADR amendments surfaced by research)

These are explicit proposals for the roadmapper/owner to accept or reject in Phase 1; they are not silently applied.

| ADR | Current | Proposed amendment | Evidence | Recommendation |
|-----|---------|--------------------|----------|----------------|
| ADR-0001 | Node 22 LTS, pinned 22.17.0 | **Node 24.21.0 LTS** (`.nvmrc`); revisit only when Node 26 is LTS *and* Electron follows | 22.x in Maintenance since 2025-10-21 and six patches behind; Electron 44 embeds Node 24.18.1 so daemon and shell share one ABI; Vitest 5 / pg-boss 12 / AI SDK 7 all need >= 22.12, nothing needs 22 specifically | **Accept.** Even-numbered rule preserved. If rejected, bump the pin to 22.23.2 immediately. |
| ADR-0001 | TypeScript strict (implicit `typescript@latest`) | Pin `typescript@7.0.x` (native compiler) plus a `typescript6@npm:typescript@6.0.3` alias for tools needing the JS compiler API; drop alias at TS 7.1 | TS 7.0 shipped without the JS API; Next >= 16.2.12 and Biome invoke the `tsc` CLI; enable `isolatedDeclarations` so dts generation does not need the API | **Accept** as a note in ADR-0001. |
| ADR-0003 | Observability = Prometheus/Grafana/Loki | Add **Grafana Tempo** (or Jaeger) for traces | OTel traces otherwise have no backend in compose | **Accept.** |
| ADR-0003 | OpenBao/KMS abstraction | Keep the abstraction; add `env`/`file` secret provider; OpenBao and OTel collector become compose **profiles**, not hard dependencies; minimal profile = postgres, redis, minio, api, web, migrate | First-run friction (PITFALLS 12); no official OpenBao JS client, so a ~200-line in-house client sits behind `SecretStore` | **Accept.** Consistent with "one command install". |
| ADR-0003 (note) | Redis | Redis 8 is AGPL again; Valkey 9 is a drop-in via node-redis 6 | License compatibility | Record only. |
| New ADR needed | — | Daemon process model: STACK.md recommends Electron `utilityProcess`; ARCHITECTURE.md and PITFALLS.md recommend a **standalone detached process** with a Unix socket / named pipe (utilityProcess cannot pipe stdin and dies with the app, blocking MVP6 headless mode) | Both agree the daemon package has no Electron imports and speaks the same JSON-RPC/envelope either way | **Recommend the standalone detached process** (ARCHITECTURE/PITFALLS position) with Electron as supervisor in MVP2; write the ADR in the daemon phase. `utilityProcess` remains a valid fallback if native-module rebuild cost dominates. |
| New ADR needed | — | Electron renderer: STACK.md says Vite 7 + TanStack Router bundle sharing `packages/ui`/`app-core`; ARCHITECTURE.md says "loads the same web bundle" | Both agree the renderer must not load the remote Next.js site | **Recommend the bundled Vite renderer** (STACK position); record in the desktop phase ADR. |

## Implications for Roadmap

### Reconciling the three independently proposed orderings

| Source | Ordering | Where it differs |
|--------|----------|------------------|
| ARCHITECTURE.md | 0 Foundation → 1 Identity+Org → 2 Realtime core → 3 Chat → 4a/4b/4c AI chats + compose acceptance → 5 Device+Project ‖ 6 Daemon → 7 WorkSession core → 8 Electron → 9 Artifacts + Chat→WZ | Folds self-hosted release into 4c; puts Electron *after* WorkSession core ("render a session that already works from curl"); device/project as a separate MVP2 step |
| PITFALLS.md | P1 Foundation → P2 Chat Core → P3 AI Chat → P4 Multiplayer+Sharing → P5 Self-hosted Release → P6 Work Zone Contracts → P7 Daemon+Adapters → P8 Desktop Shell → P9 Multiplayer Work Zone → P10 Artifacts+Chat→WZ+Acceptance | Separate self-hosted release phase; a contracts-only phase (P6) before any Work Zone code; Desktop Shell (P8) *before* the multiplayer Work Zone (P9); device identity partly in P1 |
| FEATURES.md | "MVP1 foundations" (auth, hierarchy, admin, chat) → AI chats → Work Zone foundation (Electron + daemon + pairing + adapters) → WorkSession + queue → artifacts + Chat→WZ | Groups Electron with the daemon as one "foundation" |

**Resolution adopted below:**
- Identity/org and realtime core are split from the monorepo foundation (ARCHITECTURE) rather than merged into one P1 (PITFALLS), because each is a shippable vertical (admin can invite and manage; two browsers see the same channel) and merging them yields a phase too large to plan.
- A **dedicated self-hosted release phase** (PITFALLS P5) is kept rather than ARCHITECTURE's 4c footnote: compose profiles, setup script, migrate service, backup, upgrade test and proxy docs are a week of work with their own pitfalls and they gate the "first customer" (Autofy's own engineers) milestone.
- **Work Zone contracts** (PITFALLS P6) are folded into the Device+Project phase as its first deliverable rather than standing alone; a phase with no runnable output is hard to verify, but the capability flags, event protocol and skipped acceptance specs must exist before the daemon and WorkSession phases start.
- **Desktop shell placement:** ARCHITECTURE's "WorkSession core before Electron" wins for the *session control plane*, but PITFALLS' point that pairing, signing and daemon transport cannot be deferred wins for the *shell skeleton*. So the daemon phase includes a minimal Electron shell (enrollment, project registration, daemon supervisor, signed CI build) and the full Work Zone UI comes after WorkSession core. This also matches FEATURES' "Electron + daemon + pairing" foundation grouping.
- Where FEATURES flagged PRD gaps, they are assigned to the phase that owns the surface (listed under "Addresses").

### Phase 1: Foundation
**Rationale:** Every table needs `organization_id` and RLS, every route needs `assertCan`, and every later phase inherits the CI guards; retrofitting any of these is the most expensive rework in the system (PITFALLS 1, 2, 3, 12, 13).
**Delivers:** pnpm 12 / Turborepo / Biome / Vitest monorepo on Node 24 + TS 7; `packages/contracts` with the unified `conversations`/`messages` schema decided; `packages/db` with Drizzle, two DB roles, `withTenant`, `FORCE RLS` generator, tenant-isolation test harness on testcontainers; Fastify skeleton with module loader, Zod type provider, OpenAPI, `@fastify/otel`; `docker compose` minimal profile with a one-shot `migrate` service and fail-fast on missing secrets; `pnpm verify` (Semgrep bypass rules, skip guard, license scanner) and CODEOWNERS; ADR amendments (Node 24, TS 7, Tempo, secret providers) accepted or rejected.
**Addresses:** PROJECT.md constraint compliance; nothing user-facing yet.
**Avoids:** RLS bypass, hierarchy-in-RLS, fragmented message model, boot-generated secrets, agent-weakened guardrails.
**Uses:** Node 24, TS 7 + 6 alias, Drizzle 1.0-rc, `@testcontainers/postgresql`, `dependency-cruiser`, OTel SDK 2.x.

### Phase 2: Identity and Organization
**Rationale:** Roles, memberships and the effective-permission resolver are the substrate for channels, sharing and Work Zone permissions; better-auth's flat org model must be wrapped by our hierarchy before any resource references it.
**Delivers:** better-auth embedded (organization, admin, jwt, oauthProvider plugins), email/password sign-up, copyable invite links, password reset, first-run admin bootstrap via `OCW_SETUP_TOKEN`; `org_units` (ltree), projects, memberships, four PRD roles, `resolveEffectivePermissions` with explicit-deny precedence; audit module (same-transaction writes); minimal admin CRUD UI (users, roles, departments, teams, projects); Next.js shell with auth pages.
**Addresses:** FEATURES MVP1 gaps 1 and 13 (auth/onboarding, admin console).
**Avoids:** Bending better-auth teams into departments; permission logic scattered across handlers.
**Implements:** identity, organization, audit modules; `apps/web` skeleton.

### Phase 3: Realtime Core
**Rationale:** Chat without replayable realtime is a prototype; building the seq/cursor machinery first means messages, AI runs and session events share one path (ARCHITECTURE ordering 2-before-3; PITFALLS 4).
**Delivers:** `/ws` gateway with JWT auth on upgrade, topic subscriptions authorised by `organization.authorizeTopic`, `streams`/`stream_events` with per-stream seq under row lock, Redis fan-out (one subscriber connection per process), `afterSeq` replay and `resync`, presence (Redis TTL + sweeper), typing, notification inbox on `user:{id}`, `packages/realtime-client` with backoff/resume, Zustand stores.
**Addresses:** PRD < 500 ms propagation, reconnectable/replayable (§85, §97).
**Avoids:** Redis as source of truth, global serial ordering, stale subscriptions after membership removal, per-token frames per viewer.
**Uses:** `@fastify/websocket` 11.3, node-redis 6.2, `@fastify/under-pressure`, `jose`.

### Phase 4: Chat
**Rationale:** First usable product; exercises the unified conversation model and realtime core with the highest-volume surface before AI is added.
**Delivers:** public/private channels with sidebar sections by org unit, side-panel threads (one level, enforced), DMs and group DMs, messages (Markdown subset, code blocks via shiki, react-virtuoso lists), edit/delete with audit, reactions, @mentions → notifications, unread/mention badges (`last_seq - last_read_seq`), notification preferences (mute, DND, mention-only), pins/permalinks, Postgres FTS search, attachments through the artifact module (browser upload, presigned PUT, SHA-256 on finalize), user profiles/status.
**Addresses:** FEATURES MVP1 gaps 2-8 and 14; PROJECT.md channels/threads/DMs requirement.
**Avoids:** Separate message tables per surface (share/card flows written as tests against this schema before the phase closes); `COUNT(*)` unread.
**Uses:** react-virtuoso, streamdown, shiki, `@fastify/multipart`, `@aws-sdk/client-s3` with `forcePathStyle`.

### Phase 5: Direct AI Chat
**Rationale:** The streaming run loop, `ModelProvider`/AI SDK integration and usage records must exist before attribution and arbitration make sense (ARCHITECTURE 4a before 4b; PITFALLS "usage records never deferred").
**Delivers:** org-level provider configuration (keys as `SecretReference`, allowed models) as a thin MVP3 precursor; agent module with AI SDK 7 `streamText`, `model_runs`, partial-text flush every ~1 s, ephemeral `message.delta` on `conv:{id}`, durable `message.completed`; stop/regenerate, auto-title, chat list/rename/archive/search, custom instructions, tool toggles (web search only, rest greyed out), per-generation usage row, attachments in prompts, read-only snapshot share link; the "agent persona" entity (name, model, instructions, tools, scope, owner).
**Addresses:** FEATURES MVP1 gaps 9, 10, 12; PROJECT.md Direct AI Chats.
**Avoids:** Per-user BYOK as the primary path; cost blowups invisible without usage rows.
**Uses:** `ai` 7, `@ai-sdk/*` 4, OpenBao client / env secret provider, AI SDK OTel registration.

### Phase 6: Multiplayer AI Chat, Sharing and Agents in Conversations
**Rationale:** This is where the core value is proven; it must be finished and demonstrated (Scenario B minus Work Zone creation) before MVP2 starts. It reuses the run loop from Phase 5 and produces the arbiter that Phase 10 reuses.
**Delivers:** `buildModelMessages(conversation)` with roster system prompt, structured attributed blocks, consecutive-message merge, operator notices (snapshot-tested; nightly three-participant eval fixture incl. spoof refusal); generation arbiter (Redis lock + partial unique index, ~1.5 s debounce, queue/coalesce/interrupt with visible state); grants-based sharing (private → person → team/unit/org) with a share dialog summarising what becomes visible; `context_sources` recorded per generation and user-private context excluded from multi-participant conversations; tool calls with `intersection(agent, triggering human)` permissions; agents as principals with memberships in channels/DMs, mention-triggered thread-aware replies; typed Agent Card message block schema; TipTap composer with mentions.
**Addresses:** FEATURES MVP1 gaps 11, 15; PROJECT.md multiplayer + shareable + agents-as-participants requirements.
**Avoids:** Turn race, textual identity, private-context leakage on share, confused deputy, copy-on-share, auto-respond on every message.
**Implements:** the `agent` module's arbitration; `conversation_grants`; Agent Card contract.

### Phase 7: Self-hosted Release (MVP1 acceptance)
**Rationale:** "Every essential feature must run self-hosted with `docker compose up`" is a PROJECT.md constraint and the first customer (Autofy engineers) needs a real deployment; the upgrade/backup/proxy failures in PITFALLS 12 are the top support issues for chat products.
**Delivers:** compose profiles (minimal / vault / observability with Tempo), `pnpm ocw setup` writing `.env`, `*_FILE` secrets, `migrate` service with schema-version refusal, `pnpm ocw backup` as migrator role, `--force-recreate` survival test, `N-1 → N` upgrade test, tested Caddyfile with WS upgrade and trusted-proxy config, `PUBLIC_S3_URL` presign check from outside the compose network, per-package AGPL/Apache-2.0 license fields and CI scanner, Scenario B E2E (Playwright) run against the compose stack.
**Addresses:** PROJECT.md `docker compose up` requirement; PRD §5.1, §100.
**Avoids:** Boot-generated secrets, OpenBao hard dependency, in-app migrations, `pg_dump` as app role, reverse-proxy WebSocket failures, license hygiene gaps.

### Phase 8: Device, Project and Work Zone Contracts (MVP2 foundation)
**Rationale:** The daemon and the WorkSession core can be built in parallel only if `packages/protocol` and the device link are fixed first; the acceptance targets for Scenario A must be in the repo before the code that satisfies them (PITFALLS P6, 13).
**Delivers:** Unified Session Event Protocol and Device Link protocol (`hello`/`heartbeat`/`resume`/`event`/`command`/`ack`, `protocolVersion`) in `packages/protocol` with `RuntimeCapabilities` flags; better-auth `deviceAuthorization` (RFC 8628) + Ed25519 device identity, enrollment codes, challenge auth on `/runtime/ws`, device status/revocation, heartbeat with 90 s grace, `runtime_commands` at-least-once delivery; projects, repositories, `project_devices` (no absolute paths, git repos only, `$HOME`/system roots forbidden, admin-visible); Work Zone permission grains + templates in `resolveEffectivePermissions`; Scenario A/B E2E specs committed as skipped.
**Addresses:** FEATURES MVP2 gaps 6, 7, 14; PROJECT.md `WorkSession` permissions and execution host.
**Avoids:** Capability mismatch across runtimes; device impersonation; bearer tokens on the device link.
**Uses:** better-auth device plugin, `jose`, `node:crypto` Ed25519.

### Phase 9: Local Runtime Daemon, Adapters and Desktop Shell Skeleton
**Rationale:** Adapters are the highest-uncertainty integration (vendor protocols change weekly) and must be validated against recorded fixtures with a fake server before the WorkSession arbiter depends on them; pairing, signing and the shell↔daemon transport cannot be deferred to "release" (PITFALLS 7, 8, 9, 10, 11). Can run in parallel with Phase 8's server work against `packages/protocol`.
**Delivers:** `apps/local-runtime` (standalone, no Electron imports, state dir, offline append log, pidfile reaping, process groups, one active runtime per registered path with worktree offer); `AgentRuntime` interface; ClaudeCodeRuntime (Agent SDK streaming input, `canUseTool` bridge, `disallowedTools` denies, feature detection via `system/init.capabilities`, `steer=false`); CodexRuntime (`codex app-server` stdio, committed `generate-ts` types, `turn/steer`, approval requests, `-32001` backoff, `thread/resume` after idle close); Git adapter (`-C root --relative`, base/head commit, dirty, changed files, diff on demand capped); `contain()`/`redact()` on every outbound field including free text; recorded-fixture contract tests per pinned runtime version; runtime detection/login/version report; minimal Electron shell: renderer bundle (Vite 7 + TanStack Router), daemon supervisor, enrollment UI, native project picker, Unix socket / named pipe transport with token, `safeStorage` for device secrets, hardened webPreferences and fuses, signed + notarized CI build with electron-updater feed and `N-1 → N` update test, `powerMonitor` suspend/resume hooks; daemon process-model and renderer ADRs written.
**Addresses:** FEATURES MVP2 gaps 1 (permission-mode mapping), 5, 7; PROJECT.md Electron + daemon + adapters requirements.
**Avoids:** Stdout parsing, bypass flags, path/secret leakage, orphans, localhost RCE, unsigned builds, `env` option replacing PATH in the Agent SDK, untrusted repo hooks/MCP executed on the host.
**Uses:** `@anthropic-ai/claude-agent-sdk` 0.3.x, user-installed `codex` >= 0.154, `vscode-jsonrpc`, simple-git, node-pty (rebuilt for Electron ABI, `asarUnpack`), electron-vite 5, electron-builder 26, `@electron/fuses`, `@electron/notarize`.

### Phase 10: WorkSession Core (multiplayer Work Zone control plane)
**Rationale:** The Work Zone should work end to end from `curl` before UI is built on it, so arbiter and reconnect bugs are not hidden by optimistic rendering (ARCHITECTURE 7 before 8). Reuses the Phase 6 arbiter shape.
**Delivers:** `work_sessions` state machine (draft → provisioning → idle/running/waiting_approval/host_offline → completed → archived), participants + permission templates, prompt identity (`author`, `origin_device`, `mode`, `status`), server-side multi-author Prompt Queue (add/edit/remove/reorder/run-next/priority, edits versioned and audited), arbiter (queue / steer-if-capable / interrupt, dispatch only on ack), approval round-trip with `APPROVE` check, timeout → deny, `approval.expired` on daemon restart; event ingestion into `session:{id}` streams with delta coalescing and monthly partitions; git state + changed files + diff-on-demand behind `DIFF_VIEW`; `permission.denied` as a visible event; session presence hash; Follow Session notifications; resume/reattach reconciliation on device reconnect; host consent for sessions created by others; session lifecycle (rename, archive, auto-archive).
**Addresses:** FEATURES MVP2 gaps 2, 3, 4, 12, 13; PROJECT.md prompt identity/queue, steer/queue/interrupt, single executor, server-side permissions, git state.
**Avoids:** Approval by wrong user or timeout-allow, `failed` on host offline, tokens as rows, session state in the desktop app.

### Phase 11: Work Zone UI
**Rationale:** Renders a session that already works; the UI is where capability-driven affordances (Steer hidden for Claude Code), view modes and approval banners make the multiplayer semantics legible.
**Delivers:** desktop and web (read-only) Work Zone: session sidebar grouped by project with status and "Needs attention", new-session dialog (project, runtime, model, permission mode, host), conversation stream with Normal/Verbose/Summary, sticky approval banner, queue panel with drag reorder, changes/diff view (`@pierre/diffs` or `@git-diff-view/react`, flagged for research), git state header, read-only xterm terminal stream, people/presence header, activity, `@file` mentions from host file list, open-in-editor deep link on the host, usage/context indicator, desktop notifications, daemon status and onboarding step in the header.
**Addresses:** FEATURES MVP2 gaps 8, 9, 10, 11; Work Zone table stakes at parity with official GUIs.
**Avoids:** Steer offered where unsupported, approvals buried in the stream, diff built from file events only, unread flicker from streaming chunks.
**Uses:** `@xterm/xterm` 6, `@dnd-kit`, `react-resizable-panels`, `@pierre/diffs`.

### Phase 12: Artifacts, Chat → Work Zone and MVP2 Acceptance
**Rationale:** Artifacts and chat-to-session creation are integrations across everything else and are exactly what Scenarios A and B exercise; last so the acceptance run is honest.
**Delivers:** daemon artifact pipeline (containment → policy → SHA-256 → security checks → presigned encrypted upload → finalize → `artifact.created`), downloads behind `FILES_DOWNLOAD` with audit and ACL-scoped short-lived URLs; create-Work-Zone-from-chat dialog (project, online host from `project_devices`, host consent), AI Chat → Work Zone carrying summary + participants + permissions; live agent card lifecycle in the originating thread; Scenario A (minus mobile approval) and Scenario B end to end; MVP2 acceptance against the compose stack with a desktop build.
**Addresses:** PROJECT.md basic shared artifacts, Chat → Work Zone, acceptance scenarios.
**Avoids:** Artifact URLs surviving revoked shares; absolute paths in artifact metadata.

### Phase Ordering Rationale

- **Data model before surfaces:** Phases 1-3 fix the tenant boundary, the permission resolver, the unified conversation model and the seq/replay contract; everything after is a consumer. All three research files independently identified retrofitting these as the dominant rewrite risk.
- **Solo before multiplayer, twice:** direct AI chat (5) before multiplayer AI chat (6); WorkSession core from `curl` (10) before Work Zone UI (11). The arbiter built in 6 is the same shape reused in 10, so the core value is proven once in MVP1 and reused, not reinvented, in MVP2.
- **Contracts and fixtures before integration:** Phase 8's protocol and Phase 9's recorded fixtures let the server and daemon be built in parallel and give the cheapest insurance against vendor drift (PRD §109.1).
- **Release hygiene is a phase, not a footnote:** Phase 7 (compose) and the signing/transport slice inside Phase 9 exist because PITFALLS documents both as "deferred until release" failures with no recovery path.
- **Milestone boundary:** Phases 1-7 = MVP1 (Scenario B without Work Zone creation, self-hosted). Phases 8-12 = MVP2 (Scenario A minus mobile approval, Scenario B complete). Phases 8 and 9 can be planned as parallel workstreams.

### Research Flags

Phases likely needing `/gsd-plan-phase --research-phase`:
- **Phase 2 (Identity/Org):** better-auth 1.7 schema generation into Drizzle (`@better-auth/cli` lags at 1.4.x), mapping flat orgs + teams onto our ltree hierarchy, oauthProvider/JWKS for WS and daemon verification.
- **Phase 6 (Multiplayer AI chat):** prompt-assembly evaluation across Anthropic/OpenAI/Google/openai-compatible providers (alternation rules, mid-conversation system messages, prompt caching), debounce tuning, the participant-spoofing eval fixture.
- **Phase 9 (Daemon/adapters/shell):** Agent SDK bundling inside a packaged daemon, Codex app-server version pinning and `generate-ts` workflow, whether third-party harnesses may drive Claude Code / Codex on *subscription* logins (legal/product risk flagged by STACK.md, unverifiable from primary sources), node-pty rebuild for Electron 44, Windows named pipes, macOS notarization entitlements, Linux `bwrap` preflight for Codex sandbox, daemon process-model ADR (utilityProcess vs detached).
- **Phase 11 (Work Zone UI):** diff-rendering library choice (`@pierre/diffs` 1.4 vs `@git-diff-view/react` 0.1, both young), xterm streaming performance with coalesced chunks.
- **Phase 7 (Self-hosted release):** MinIO community-edition feature shedding (swap to Garage/SeaweedFS?), pnpm 12 lockfile compatibility with Turborepo 2.10 (LOW confidence in STACK.md).

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** monorepo, Drizzle RLS, testcontainers, OTel, compose are well documented; the prescriptions in STACK/ARCHITECTURE/PITFALLS are already concrete.
- **Phase 3 (Realtime core):** `@fastify/websocket` + Redis fan-out + Postgres seq is a known pattern; ARCHITECTURE gives the table DDL and reconnect algorithm.
- **Phase 4 (Chat):** Slack-model chat over the Phase 3 primitives; FEATURES is exhaustive on expectations.
- **Phase 8 (Device/Project/Contracts):** Ed25519 challenge auth, RFC 8628, commands table are standard; the protocol shape is fully specified in ARCHITECTURE.
- **Phase 10 (WorkSession core):** state machine, arbiter and approval round-trip are specified step by step; the risk is discipline, not unknowns.
- **Phase 12 (Artifacts/acceptance):** presigned S3 pipeline is standard; acceptance specs exist from Phase 8.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Every version read from registries and vendor docs on 2026-09-10, but the research seam caps web-verified claims at MEDIUM; Codex/Claude adapter APIs LOW-MEDIUM (protocols move weekly); Drizzle is on an RC line; TS 7 tooling ecosystem is fresh |
| Features | MEDIUM | Synthesis of 30+ sources with official docs for the key runtimes; several vendor pages were unreachable (OpenAI group chats 403, Codex app worktrees redirect, Mattermost docs 404) and fast-moving products need re-verification at planning time |
| Architecture | MEDIUM | HIGH where it restates PRD/ADRs; runtime contracts (Agent SDK `canUseTool`, app-server `turn/steer`, approvals) verified against official docs; the multi-human prompt-assembly design and arbiter are opinionated recommendations to be ratified as ADRs |
| Pitfalls | MEDIUM | HIGH for facts from Claude Code / Codex official docs (permission modes, SIGTERM vs interrupt, `env` replacement, hooks loaded without trust dialog); RLS/chat/Electron patterns consistent across multiple community sources; AI-agent-drift evidence is practitioner reports (LOW) |

**Overall confidence:** MEDIUM

### Gaps to Address

- **Vendor terms for driving Claude Code / Codex through a third-party harness on subscription logins:** unverifiable from primary sources; confirm before Phase 9 and design adapters so the credential source is always the user's own CLI login. If disallowed, MVP2 needs API-key mode, which pulls the Model Gateway forward.
- **Daemon process model (utilityProcess vs detached process) and renderer bundle:** STACK.md and ARCHITECTURE/PITFALLS disagree; recommendation recorded above, ADR due in Phase 9.
- **`apps/local-runtime` vs `apps/runtime` naming and `packages/sdk` vs `packages/app-core`:** cosmetic divergence between STACK and ARCHITECTURE; settle in Phase 1's structure.
- **Whether Work Zone prompts/assistant messages are also `messages` rows in a `work_session` conversation (PITFALLS) or only `session:{id}` stream events (ARCHITECTURE):** PITFALLS' argument (cards and "publish result in #backend" become trivial) is stronger; decide in Phase 1 contracts, keep high-volume tool/command events as stream events only.
- **Context-visibility rule in shared AI chats** (whose permissions bound tools/knowledge): FEATURES leaves it open; PITFALLS/ARCHITECTURE recommend `intersection(agent, triggering human)` with retrieved content authorised for all participants or blocked with explanation. Ratify in Phase 6 requirements.
- **Drizzle 1.0 RC stability:** fallback to 0.45.2 is documented; watch for the stable release during Phase 1.
- **pnpm 12 lockfile + Turborepo 2.10** and **MinIO community-edition trajectory:** verify in Phase 1 and Phase 7 respectively.
- **Multi-provider prompt assembly:** verified for Anthropic; OpenAI/Google/openai-compatible alternation and system-message behaviour need a test matrix in Phase 6.
- **Expo/React version split (19.2 vs 19.3):** out of milestone; shared packages must declare React as a peer from Phase 1 to keep MVP7 cheap.

## Sources

### Primary (HIGH confidence)
- `docs/prd/PRD.md` v1.0, `docs/adr/0001`–`0004`, `AGENTS.md`, `.planning/PROJECT.md` — project constraints and scope
- https://code.claude.com/docs/en/agent-sdk/typescript, /streaming-vs-single-mode, /user-input, /headless, /desktop, /interactive-mode — Agent SDK `query()`, `canUseTool`, permission modes, queue/interrupt semantics, `env` replacement, SIGTERM behaviour, hooks without trust dialog
- https://learn.chatgpt.com/docs/app-server.md (developers.openai.com/codex/app-server), https://learn.chatgpt.com/docs/codex/cli, /non-interactive-mode — Codex app-server JSON-RPC methods, `turn/steer`, approvals, `generate-ts`, sandbox modes

### Secondary (MEDIUM confidence)
- registry.npmjs.org and nodejs.org release index/schedule — every version and LTS date in STACK.md (2026-09-10)
- https://orm.drizzle.team/docs/rls, https://better-auth.com/blog/1-7 and plugin docs, https://vercel.com/blog/ai-sdk-7, https://nextjs.org/blog/next-16, https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default, https://www.electronjs.org/blog/electron-44-0, https://github.com/fastify/otel, https://pnpm.io/blog/releases/12.0, https://github.com/vitest-dev/vitest/releases/tag/v5.0.0, https://www.infoq.com/news/2026/08/typescript-7-released/ — stack decisions
- https://centrifugal.dev/docs/getting-started/comparisons, https://redis.io/docs/latest/develop/pubsub/ — realtime transport trade-offs and delivery semantics
- Official product docs for Conductor, Cursor Slack, Devin Slack, Claude project sharing, Open WebUI, Zulip, Happier, Paseo, OpenCode, Dust, Inline — feature landscape
- https://www.electronjs.org/docs/latest/api/power-monitor, /tutorial/code-signing, /tutorial/fuses, /api/utility-process — desktop lifecycle and hardening
- Postgres RLS practice (queryplane, patotski, rivestack, theroadtoenterprise) and chat architecture (getstream) — consistent across sources

### Tertiary (LOW confidence)
- OpenAI group chats announcements (substack, VentureBeat; official page 403), Codex app intro, MacRumors Claude Code desktop redesign — competitor features, re-verify at planning time
- codex.danielvaughan.com app-server/sandbox/session guides — corroborated by official docs but community-authored
- MuPPET (arXiv 2606.23217), MUCA (arXiv 2401.04883), HUMA (arXiv 2511.17315), OWASP LLM01 — multi-party privacy and speaker-labelling conclusions
- Practitioner reports on AI-grown codebases (dev.to, O'Reilly Radar, contextqa) — drift and guardrail-weakening patterns
- github.blog localhost/DNS-rebinding write-up, deepstrike Electron pentest notes — daemon exposure class
- Self-hosting upgrade post-mortems (Sourcegraph, Langfuse, Ghost, n8n encryption key) — first-run and upgrade pitfalls

---
*Research completed: 2026-09-10*
*Ready for roadmap: yes*
