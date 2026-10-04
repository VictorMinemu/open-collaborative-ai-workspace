# Roadmap: Open Collaborative AI Workspace

## Overview

This milestone delivers PRD v1.0 **MVP 1 (Collaborative Workspace)** and **MVP 2 (Multiplayer Work
Zone)** as twelve vertical phases. Phase 1 shipped as the **MVP 0 Collaborative Workspace Demo Slice**:
the owner widened it on 2026-10-02 for an investor demo, so instead of one shared AI chat it delivers
thin, working versions of all three modes — Slack-style channels with threads and @mentions, one-click
OpenClaw bots that answer in threads knowing who asked, and a Work Zone that runs Claude Code or Codex
on a member's own paired machine and subscription while the session, queue, approvals and diff live in
the Control Plane — plus a macOS desktop shell, all on the foundations that are ruinous to retrofit
(RLS tenant boundary, unified `conversations`/`messages` model, per-stream `seq`/replay,
same-transaction audit). Phases 2–7 widen it into MVP 1: the permission resolver and org hierarchy,
presence and latency, the complete chat surface, admin-configured direct AI chat, multiplayer AI chat
with shared-context safety and full agent personas, and the self-hosted release with the MVP 1
acceptance scenario running in CI. Phases 8–12 turn the thin Work Zone into MVP 2: a trusted device
protocol, a productised desktop shell and adapters, the complete cloud-owned WorkSession, the complete
Work Zone UI, and finally artifacts, Chat → Work Zone creation and the full MVP 2 acceptance run.

Design rules that hold across every phase: one conversation model for every surface (sharing is a
grant, never a copy); the WorkSession lives in the cloud and the daemon only connects outbound; the
single-executor arbiter built for Work Zones in Phase 1 is the shape Phase 6 reuses for one generation
per AI chat and Phase 10 completes; no absolute path or secret ever leaves a device; every sensitive
action is audited in the same transaction.

**Project mode:** mvp (each phase ships an end-to-end user capability)
**Granularity:** fine (natural boundaries kept; 12 phases)
**Requirements covered:** 135/135 active v1 requirements mapped (140 IDs; 5 superseded — see Coverage)

## Milestone Boundary

| Milestone | Phases | Exit condition |
|-----------|--------|----------------|
| **MVP 0 — Collaborative Workspace Demo Slice** | 1 | The `docs/DEMO.md` script (chat → one-click bot → Work Zone on a paired Mac) runs end to end on one machine; CI runs `pnpm verify`, the Playwright E2E suite (setup, chat, bots, Work Zone at desktop and mobile widths, deterministic fakes) and the image builds on every PR |
| **MVP 1 — Collaborative Workspace** | 2–7 (on top of MVP 0) | Self-hosted release via `docker compose up`; Acceptance Scenario B steps 1–4 (multiplayer AI chat, minus Work Zone creation) pass as a Playwright E2E in CI |
| **MVP 2 — Multiplayer Work Zone** | 8–12 (on top of the Phase 1 Work Zone slice) | Scenario A (minus mobile approval, replaced by web approval) and full Scenario B pass end to end against the compose stack with a signed desktop build |

**Parallel workstreams:** Phase 8 (Device Trust, Protocol and Work Zone Permissions) and Phase 9
(Desktop Shell and Adapter Hardening) can run as parallel workstreams once Phase 8's first
deliverable, `packages/protocol` (DEV-01), is merged. Phase 10 requires both.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**MVP 0 — Collaborative Workspace Demo Slice**

- [ ] **Phase 1: MVP 0 — Collaborative Workspace Demo Slice** - Executed and demo-verified (formal verification pending): strict monorepo with RLS and same-transaction audit, setup / invite / login, one WebSocket with seq replay, Slack-style channels and threads with @mentions, one-click OpenClaw bots through the Agent Channel API, device pairing, Work Zone sessions with Claude Code / Codex on the user's own subscription, a macOS desktop shell, and Playwright E2E with deterministic fakes

**MVP 1 — Collaborative Workspace**

- [x] **Phase 2: Identity and Organization** - Password reset, session management, org hierarchy with four roles, one effective-permission resolver adopted by every Phase 1 route (chat, bots, devices, Work Zone, realtime), JWT/JWKS auth, admin console, profiles and the remaining audit gaps
- [ ] **Phase 3: Realtime Presence and Latency** - Subscription re-authorisation on membership change, sub-500 ms propagation test on the compose stack, presence with expiry (typing already ships)
- [ ] **Phase 4: Chat** - Completes chat on the Phase 1 channels and threads: grouped sidebar and views, DMs, one shared Markdown renderer, edit/delete, reactions, @channel/@here and notifications, badges, search, attachments (adds S3-compatible object storage), pins and permalinks
- [ ] **Phase 5: Direct AI Chat** - Private streaming AI chats with model choice, stop, regenerate, titles, instructions, usage metering and attachments; Phase 1 provider settings move to `SecretReference`s and govern AI chats and bots
- [ ] **Phase 6: Multiplayer AI Chat, Shared-Context Safety and Agents** - AI chats shared in place from a person to the whole organization, several humans and the model with structural identity and one generation at a time (Scenario B steps 1–4), intersected tool permissions, no private memory in multi-human chats, the spoofing eval, full agent personas in DMs and AI chats, Agent Cards
- [ ] **Phase 7: Self-hosted Release** - `pnpm ocw setup` + verified `docker compose up`, OpenTelemetry, secrets as inputs, migrate service, backup/upgrade tests, Caddy config, license checks and Scenario B E2E (MVP 1 acceptance), CI guardrails (bypass tokens, skipped policy tests, licenses, CODEOWNERS)

**MVP 2 — Multiplayer Work Zone**

- [ ] **Phase 8: Device Trust, Protocol and Work Zone Permissions** - `packages/protocol` with runtime capabilities, Ed25519 / RFC 8628 device identity replacing the MVP 0 bearer token, device views with active sessions for users and admins, Work Zone permission grains and templates
- [ ] **Phase 9: Desktop Shell and Adapter Hardening** - Signed, notarized, auto-updating desktop app for macOS, Windows and Linux with a bundled renderer, token-authenticated local socket and sleep/wake handling; org-capped permission modes, git base commit, one runtime per working tree
- [ ] **Phase 10: WorkSession Core** - Completes the Phase 1 session: grain-checked participants with `permission.denied`, prompt execution modes with Steer, versioned queue with priority and run-next, delta checkpoints, presence and follow, host acceptance, resume across sleep and app restart, rename/auto-archive and history search
- [ ] **Phase 11: Work Zone UI** - Completes the Phase 1 session UI: view modes, side-by-side diff, terminal and side panels, presence and Share in the header, `@file` and images, usage indicator, desktop notifications and open-in-editor
- [ ] **Phase 12: Artifacts, Chat → Work Zone and MVP 2 Acceptance** - Artifact upload pipeline with policy and ACL-scoped downloads, Work Zone creation from any conversation with a live Agent Card, Scenarios A and B end to end

## Phase Details

### Phase 1: MVP 0 — Collaborative Workspace Demo Slice

**Goal**: The three modes of the product — chat, bots and Work Zone — work end to end in thin form for one organization, on the web and in a macOS desktop app, on top of the foundations that are ruinous to retrofit, so the owner can demo the product to investors and Autofy's team can use it internally
**Mode:** mvp
**Status:** Executed 2026-10-02…04 from `01-BUILD-SPEC.md` by parallel agents (no PLAN.md files; see `01-STAGE-A-HANDOFF.md`, `01-DEVIATIONS.md`, `01-AGENT-CHANNEL-API.md`, `docs/DEMO.md`); demo-verified; formal `01-VERIFICATION.md` pending. The phase directory keeps its original slug `01-mvp-0-multiplayer-ai-chat-slice`.
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, AUTH-01, AUTH-02, AUTH-03, RT-02, RT-05, CHAT-01, CHAT-03, AGENT-03, DEV-04, DEV-05, RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04, RUNTIME-06, RUNTIME-07, RUNTIME-09, DESK-03, WZ-02, WZ-07, WZUI-01, WZUI-02, WZUI-04, WZUI-10, SLICE-05, SLICE-06, SLICE-07, SLICE-08, SLICE-09, SLICE-10, SLICE-11, SLICE-12, SLICE-13, SLICE-14, SLICE-15, SLICE-16, SLICE-17, SLICE-18
**Success Criteria** (what is verified, and by what):

  1. `pnpm verify` (Biome, `tsc` in every workspace, Vitest unit + integration against real PostgreSQL 18 / Redis 8 containers) and the daemon and desktop package suites pass in the CI `verify` job on PR #2; the CI `e2e` job passes all 9 Playwright runs (setup, then smoke, chat, bots and Work Zone at 1440 px and 390 px) and the `images` job builds the api and web images (CI run 37208718594, 2026-10-04); the API serves `/health` and OpenAPI from the Zod contracts (`identity.int.test.ts` "health reports db and redis", "serves the OpenAPI document")
  2. Tenant isolation is proven as the `app` role for every org-scoped table (`packages/db/src/rls-isolation.int.test.ts` "every app table is org-scoped with RLS + FORCE + policy", "cross-tenant reads return 0 rows and writes fail…") and again per module (`chat.int.test.ts` "cross-tenant…", `agent-channel.int.test.ts` "a cell of another organization…", `workzone.int.test.ts` "tenant isolation"); setup, invitations, chat membership, bots, providers, devices and Work Zone actions are audited in the same transaction (`identity.int.test.ts` "SPIKE … roll back atomically on failure")
  3. An admin redeems the one-time setup token, invites a colleague by copyable link and the colleague signs up and stays signed in across reload (`e2e/tests/setup.spec.ts`, `smoke.spec.ts` "login → app shell → navigate → sign out", `identity.int.test.ts` "invite → public lookup → accept → member…"); one cookie-authenticated WebSocket replays missed events exactly once (`identity.int.test.ts` "WS: rejects foreign origin and anonymous; subscribe + live + replay exactly once")
  4. Two people create, join and talk in a channel live, reply in single-level threads with reply counts and participants, and @mention with autocomplete (`e2e/tests/chat.spec.ts` "chat: live messages, threads, mentions and a bot reply" at 1440 px and 390 px; its simulated bot typing + reply step runs only when the API has `NODE_ENV=test`); bot mentions, threaded attributed replies and agent typing are covered by `chat.int.test.ts` and criterion 5
  5. An admin connects a model provider with a write-only key, creates a bot in one click from a preset, the OpenClaw cell provisions it to Ready live, the bot is added to a channel and answers a mention in the thread naming the asker, and the key never reaches an API response, log, audit row or stream payload (`e2e/tests/bots.spec.ts` "models → one-click bot → ready via the cell → add to channel" with the fake cell plugin; `agent-channel.int.test.ts`; `apps/openclaw-channel` contract tests; the real OpenClaw cell via `infra/openclaw/test/run-container-smoke.sh`, manual)
  6. A user pairs a device with a one-time code, the real daemon registers a scratch repository, a Work Zone session starts from the web, a second prompt queues behind the first, approvals are granted once and for the session, and the Changes panel shows the repo-relative diff (`e2e/tests/work-zone.spec.ts` "Work Zone: pair a device, run a session, approve, review changes", daemon in fake-runtime mode); the arbiter, shared queue, single-decision approvals, command redelivery, host-offline resume, relative-only diff and revocation are covered by `workzone.int.test.ts`; both adapters are tested against recorded Claude Code 2.1.287 and codex 0.160.0 fixtures; real Claude Code and Codex sessions on subscription logins were run manually (screenshots `workzone-real-*`)
  7. The macOS desktop app onboards, pairs, registers a project (refusing the home folder, never sending the absolute path to the web) and supervises the daemon in a hardened window (`apps/desktop/e2e/smoke.e2e.ts` "onboarding → pairing → main window, hardened and supervised")
  8. CI never calls a metered model: the E2E job runs with `OCW_MODEL_PROVIDER=mock`, the fake model server, the fake cell plugin and the fake runtime (SLICE-05)

**Not verified (known limits)**: full `docker compose up` with the api/web images on a clean machine (the demo runs API and web natively via `pnpm demo:up`); the real OpenClaw + real model path in CI; the desktop app on another Mac (ad-hoc signed, deviation D-7); ADRs for the "research" stack rows are still owed (Stage A handoff)
**Plans**: none — executed from `01-BUILD-SPEC.md`
**UI hint**: yes

### Phase 2: Identity and Organization

**Goal**: Every route — including every Phase 1 route: setup, invitations, channels and messages, bots and model providers, devices, Work Zone sessions and realtime subscriptions — is permission-checked through one resolver, an Organization Admin arranges members into departments, teams and projects with the four PRD roles, and users manage their passwords, sessions and profiles
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AUTH-04, AUTH-05, AUTH-06, ORG-01, ORG-02, ORG-03, ORG-04, ORG-05, ORG-06
**Success Criteria** (what must be TRUE):

  1. User resets their password (email when SMTP is configured, admin-issued link otherwise) and views and revokes their active sessions, each carrying the device/client identifier that Phase 1 already records on messages and audit rows
  2. Admin creates and rearranges Organization → Department → Team → Project (including moving units), assigns members with one of Standard User / Developer / Team Lead-Manager / Organization Admin (replacing the MVP 0 owner/admin/member roles), Team Leads can invite and revoke invitations, and users, roles, units and memberships are managed from CRUD pages in the admin console (extending Settings › Members)
  3. A single `resolveEffectivePermissions` intersection (Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device) with explicit-deny precedence decides every route, and every Phase 1 route (setup, invitations, channels, messages, bots, providers, devices, Work Zone, realtime subscription) is migrated to it with no ad-hoc role or membership check left
  4. API and WebSocket connections authenticate with short-lived JWTs verifiable against a JWKS endpoint; the Phase 1 cookie-authenticated WebSocket moves to short-lived JWT/JWKS verification without breaking reconnect and replay
  5. Users view and edit their own profile (display name, avatar, status) and see other members' profiles; hierarchy, role, membership, session-revocation and failed sign-in attempts are audited (same transaction where there is a domain write), closing the gaps left by the Phase 1 audit (SLICE-06); every later phase audits the sensitive actions it introduces

**Plans**: 15 plans in 5 waves (validation strategy: `02-VALIDATION.md`)

Plans:

- [ ] 02-01-PLAN.md — Wave 1: restore-checked backup of the demo DB; one isolated commit with the role migration (owner/admin→admin, member→developer), phase schema and permission contracts; code follows with no capability lost; approved packages; isolated e2e stack (`scripts/e2e-isolated.sh`)
- [ ] 02-02-PLAN.md — Wave 2: resolveEffectivePermissions tracer (channel archive), every layer proven (matrix + fast-check), authz coverage registry, legacy guard, /me/permissions, web useCan and gated navigation
- [ ] 02-03-PLAN.md — Wave 2: better-auth jwt plugin + JWKS, session client kind/label, cookie authenticate split, audit rows inherit session/client, revocation fan-out, wave-3 DTO contracts
- [ ] 02-04-PLAN.md — Wave 3: chat (channels, messages, threads, bot replies, conv topic) on the resolver with viewerCan
- [ ] 02-05-PLAN.md — Wave 3: devices and Work Zone (approvals with Tool layer, device.use, ws topic) on the resolver with viewerCan
- [ ] 02-06-PLAN.md — Wave 3: hierarchy API (CRUD + move), unit memberships with leads, deny/allow rules API, org/user topics on the resolver
- [ ] 02-07-PLAN.md — Wave 3: member directory and profiles, role changes with last-admin guard, deactivate/reactivate, Team-Lead invitations
- [ ] 02-08-PLAN.md — Wave 3: JWT verification for REST (Bearer) and the browser WebSocket (subprotocol), revocation closes sockets, realtime-client token refresh
- [ ] 02-09-PLAN.md — Wave 3: sessions list/revoke, password reset (SMTP or admin link), change password, profile API, failed sign-in and sign-out audit
- [ ] 02-10-PLAN.md — Wave 4: bots, providers and the OpenClaw cell on the resolver (cell and agent principals, agent ∩ human)
- [ ] 02-11-PLAN.md — Wave 4: Device Link device-JWT exchange in the daemon, legacy device token behind a flag until Phase 8
- [ ] 02-12-PLAN.md — Wave 4: admin console › Members (roles, invitations, lifecycle, reset links, role matrix, profile sheet)
- [ ] 02-13-PLAN.md — Wave 4: admin console › Organization (tree, create/rename/move/delete, unit members and leads, read-only rules)
- [ ] 02-14-PLAN.md — Wave 4: account pages (Profile, Security sessions + change password, reset-password, forgot password)
- [ ] 02-15-PLAN.md — Wave 5: strict authz coverage, AuthContext without role, clean guard, demo seed + DEMO.md, ADR-0007/0008, phase gate

**Research:** needed (mapping flat better-auth orgs/teams onto the ltree hierarchy, oauthProvider/JWKS for WS and daemon verification; better-auth schema generation into Drizzle already exists from Phase 1)
**UI hint**: yes

### Phase 3: Realtime Presence and Latency

**Goal**: Subscriptions follow membership, collaborative events reach other connected clients in under 500 ms on the compose stack, and people see who is online in each conversation, on top of the Phase 1 WebSocket, seq replay, shared realtime client and typing indicators
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: RT-01, RT-03, RT-04
**Success Criteria** (what must be TRUE):

  1. An automated test against the compose stack measures typical propagation of collaborative events between two connected clients under 500 ms
  2. Presence (online/away) for other connected users appears per conversation and expires automatically when a client disappears; the Phase 1 typing indicators keep expiring the same way
  3. A client loses a subscription automatically when its membership is removed (leaving or being removed from a channel, losing access to a Work Zone session), with authorisation resolved through the Phase 2 `resolveEffectivePermissions` resolver

**Plans**: 6 plans in 4 waves (validation strategy: `03-VALIDATION.md`; decisions D-01 … D-09 and research notes in `03-01-PLAN.md`)

Plans:

- [ ] 03-01-PLAN.md — Wave 1: tracer — "here now" presence in the channel header end to end (contract, Redis store, gateway, client store, header, two-browser e2e) and expiry when a client vanishes (heartbeat, sweep, ping liveness)
- [ ] 03-02-PLAN.md — Wave 2: Away state end to end (activity monitor, `presence` op with throttle and rate cap, provider wiring, two-browser e2e)
- [ ] 03-03-PLAN.md — Wave 2: presence in the channel member list and the Work Zone session header (desktop and mobile), screenshots
- [ ] 03-04-PLAN.md — Wave 3: subscriptions follow channel membership — invalidators after commit, re-decision through the resolver, `revoked` frame, access-lost state; race-free and fail-safe
- [ ] 03-05-PLAN.md — Wave 3: RT-03 latency spec with two real web clients (p50/p95 < 500 ms for message, typing, presence) in the CI e2e job, report artifact
- [ ] 03-06-PLAN.md — Wave 4: role, rule and unit changes re-decide live subscriptions, periodic backstop, Work Zone access-lost state, ADR-0009, demo notes, phase gate

**Research:** standard (Redis-backed presence with expiry over the Phase 1 WebSocket is a known pattern)
**UI hint**: yes

### Phase 03.1: Personal Bots and Bot Capabilities (INSERTED)

**Goal**: Every member can have their own private bot that lives as a direct chat in their sidebar and answers every message, and every bot — personal or team — has explicit, admin-governed capabilities (internet, memory, reply mode, time context, usage limit) enforced in the OpenClaw cell on every turn
**Mode:** mvp
**Requirements**: BOT-01, BOT-02, BOT-03, BOT-04, BOT-05, BOT-06, BOT-07
**Depends on:** Phase 3
**Success Criteria** (what must be TRUE):
  1. A Developer creates a personal bot in one click; a private direct chat with it appears in their sidebar, the bot answers every message there without an @mention, and no other member (admins included) can read that conversation or use the bot
  2. Any member opens a private direct chat with a team bot they may use; their history is invisible to other members
  3. A bot owner/manager toggles internet access, memory, reply mode, date/time context and a daily limit; with internet on the bot answers a question that needs a web lookup and the search/fetch is audited, with it off no web tool reaches the model (proven in the cell contract tests and an e2e with the fake model)
  4. An Organization Admin denies a capability org-wide (or for personal bots only) and every affected bot loses it on the next turn; the bot's settings show the toggle disabled with the reason; shell/exec, filesystem writes and browser control are never offered
  5. When a bot reaches its daily limit it replies with a clear notice and makes no model call; owners and admins see usage against the limit; memory is visible to the human it belongs to and can be cleared
**Plans:** 0 plans
**Research:** needed (OpenClaw 2026.9.7 web search/fetch tools and their providers — keyless vs API key, memory plugin and per-agent/per-peer scoping, per-turn tool allowlist, DM routing in the channel plugin; resolver grants for personal bots; DM conversation model reuse)
**UI hint**: yes

Plans:

- [ ] TBD (run /gsd-plan-phase 03.1 to break down)

### Phase 4: Chat

**Goal**: A team can do its daily conversation in the workspace — completing the Phase 1 channels, threads and mentions with DMs, notifications, search and files — with every message attributed, editable under audit and delivered in realtime
**Mode:** mvp
**Depends on**: Phase 3 (builds on the Phase 1 conversation model, chat surface and realtime client)
**Requirements**: CHAT-02, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08, CHAT-09, CHAT-10, CHAT-11, CHAT-12, CHAT-13, CHAT-14
**Success Criteria** (what must be TRUE):

  1. The sidebar groups channels by department/team with All, Mentions, Threads and AI Chats views (channel create / join / leave / archive and private-channel enforcement already ship from Phase 1)
  2. User opens DMs and group DMs between humans, humans and agents, or mixed groups (single-level threads already ship from Phase 1)
  3. Messages in chat, AI chats, agent output and the Work Zone render through one shared Markdown renderer (Phase 1 has separate chat and Work Zone renderers), and support edit and delete (edited marker, prior versions kept for audit, admins can delete any), emoji reactions, @channel and @here alongside the existing people and bot mentions, with mentions generating notifications, pins, personal saves and permalinks
  4. Unread and mention badges with counts per channel/DM update in realtime from the Phase 1 read markers with mark-as-read/unread; user can mute a channel, set do-not-disturb or mention-only and toggle desktop/web, and the notification inbox honours those preferences
  5. User finds messages, people and channels through full-text search with channel/author/date filters, attaches files and images by drag-and-drop or paste (preview and download) through the artifact upload pipeline on S3-compatible object storage added to the compose stack (MinIO was dropped from Phase 1), and history jumps to a permalink on top of the Phase 1 cursor pagination

**Plans**: TBD
**Research:** needed only for the object-storage choice (MinIO community-edition trajectory vs Garage/SeaweedFS); the rest is standard Slack-model chat over the Phase 1 model and realtime client
**UI hint**: yes

### Phase 5: Direct AI Chat

**Goal**: A user holds a private, streaming AI conversation with organization-configured models and every generation metered — a new AI chat run loop (AI SDK 7) next to the bots' OpenClaw path, with the Phase 1 Settings › Models providers moved to `SecretReference`s that govern AI chats as well as bots
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: AICHAT-01, AICHAT-02, AICHAT-03, AICHAT-04, AICHAT-05, AICHAT-06, AICHAT-07, AICHAT-08, AICHAT-09
**Success Criteria** (what must be TRUE):

  1. Admin configures organization-level model providers with API keys held as `SecretReference` in the secret store (the Phase 1 keys encrypted in `app.secrets` are migrated) and an allowed-models list that governs AI chats and bots; there is no path for a user to enter a personal API key
  2. User creates a private AI chat, picks a model from the allowed list and can switch it per message, watches the response stream in realtime, stops generation with the partial output kept, and regenerates the last answer
  3. Each chat gets an auto-generated title and appears in a list the user can rename, archive and search; custom instructions apply per chat and as personal defaults
  4. Every generation writes a usage record (model, provider, input/output tokens, cost estimate, requester) and the chat shows tokens per message; the settings expose Web, Company Knowledge, MCP and Skills toggles with only Web search functional and the rest visibly disabled
  5. User attaches files and images to a prompt for vision-capable models through the upload pipeline, and can create an organization-scoped read-only snapshot share link that is never public

**Plans**: TBD
**Research:** standard (AI SDK 7 `streamText` and provider packages are documented in STACK; the model integration contract is captured by `/gsd-ai-integration-phase` during planning)
**UI hint**: yes

### Phase 6: Multiplayer AI Chat, Shared-Context Safety and Agents

**Goal**: A private AI chat becomes multiplayer — shared in place with a person, team, department or the whole organization, with several humans and the model in one conversation, structural participant identity and one generation at a time — without leaking context, and agents become full personas in channels, DMs and AI chats
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: MULTI-01, MULTI-02, MULTI-03, MULTI-04, MULTI-05, MULTI-06, MULTI-07, MULTI-08, AGENT-01, AGENT-02, AGENT-04
**Success Criteria** (what must be TRUE):

  1. Owner shares an AI chat in place with a person, team, department or the whole organization; the share dialog states exactly what becomes visible (context, messages, attachments, artifacts, model, tools, permissions, participants), and every recipient gets a grant on the same record, never a copy
  2. Several humans and the model write in one AI chat in realtime and every message records author, timestamp, device, context and permissions; the model receives a roster and server-generated attributed blocks (never plain-text name prefixes; the Phase 1 bots already get structured sender and roster fields), responds when @mentioned or addressed while idle, and at most one generation runs per conversation with queued or coalesced follow-ups visible to all; Acceptance Scenario B steps 1–4 pass as a Playwright E2E with the mock model
  3. Tools invoked in a shared chat run with the intersection of the agent's and the triggering human's permissions, and content not authorised for every participant is withheld with an explanation from the model; no user-private context or personal memory is injected once a second human participant is present
  4. A three-participant evaluation fixture verifies correct addressing and refusal of a spoofed authority claim; because it calls a metered model it runs in CI on a schedule or behind an explicit PR label, never on every PR
  5. Admin or Team Lead creates an agent persona that extends the Phase 1 one-click bots with tools, a scope (org/department/team/project/personal) and an owner; agents are members of DMs and AI chats as well as channels, and post typed Agent Cards (kind, title, fields, status, Open / Follow / Approve actions) that update in place (in-thread replies on mention already ship from Phase 1)

**Plans**: TBD
**Research:** needed (prompt assembly for the AI chat run loop across Anthropic / OpenAI / Google / openai-compatible — alternation rules, mid-conversation system messages, prompt caching; whether bots in shared AI chats answer through OpenClaw or the AI SDK loop; the participant-spoofing eval fixture and its metered-model budget)
**UI hint**: yes

### Phase 7: Self-hosted Release

**Goal**: Any engineering team can install, upgrade, back up, observe and expose an MVP 1 instance with one command each, and the MVP 1 acceptance scenario runs against that exact stack in CI — the milestone gate for Autofy's own engineers as first customer
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: SELF-01, SELF-02, SELF-03, SELF-04, SELF-05, SELF-06, SELF-07, FOUND-05, FOUND-06, FOUND-07
**Success Criteria** (what must be TRUE):

  1. `git clone` + `pnpm ocw setup` + `docker compose up` yields a working MVP 1 instance, verified on a clean machine (the Phase 1 compose file is defined but its full api/web run was never re-verified); OpenBao and observability (Prometheus, Grafana, Loki, Tempo) are optional compose profiles that can be enabled later without reinstalling, and the API emits OpenTelemetry traces, metrics and logs via `@fastify/otel` into that profile
  2. Secrets are required inputs (env or `*_FILE`) and are never generated silently at boot (already true for the API); the env/file secret provider and the OpenBao client implement the same `SecretStore` interface
  3. Migrations run in the one-shot `migrate` service and the API refuses to start on schema mismatch; an `N-1 → N` upgrade test passes in CI; `pnpm ocw backup` / restore work as the migrator role and data survives `docker compose up --force-recreate`
  4. The documented Caddy reverse-proxy configuration passes a test covering WebSocket upgrade, trusted proxy headers and presigned object-storage URLs reachable from outside the compose network
  5. Every package declares its license (AGPL-3.0 apps/server, Apache-2.0 for `packages/contracts` and `packages/protocol`), CI checks dependency-license compatibility, and Scenario B (minus Work Zone creation) runs as a Playwright E2E against the compose stack in CI
  6. `pnpm verify` fails a change that introduces a permission-bypass token (Semgrep), a skipped policy test or a license violation, and CODEOWNERS covers db policies, auth, adapters and policy paths

**Plans**: TBD
**Research:** needed (`@fastify/otel` wiring and the observability profile; backup/restore and upgrade tooling; presigned URLs through Caddy)
**UI hint**: no

---

**MVP 1 boundary.** Phases 1–7 complete MVP 1 (Collaborative Workspace): self-hosted release plus
Scenario B without Work Zone creation. Phases 8–12 below complete MVP 2 (Multiplayer Work Zone) on top
of the thin Work Zone that Phase 1 already ships.

---

### Phase 8: Device Trust, Protocol and Work Zone Permissions

**Goal**: The MVP 0 device link becomes a trusted, versioned protocol — session events, Device Link frames and runtime capabilities live in `packages/protocol`, devices carry a signed Ed25519 identity paired through RFC 8628, users and admins see and revoke devices with their active sessions, and Work Zone permission grains exist in the resolver before the WorkSession is completed
**Mode:** mvp
**Depends on**: Phase 7 (MVP 1 released); builds on Phase 2 permissions and the Phase 1 device link
**Parallel with**: Phase 9 (once DEV-01 `packages/protocol` is merged)
**Requirements**: DEV-01, DEV-02, DEV-03, DEV-06
**Success Criteria** (what must be TRUE):

  1. `packages/protocol` (Apache-2.0) ships the Unified Session Event Protocol event set, the Device Link protocol (hello, heartbeat, resume, event, command, ack, `protocolVersion`) and `RuntimeCapabilities` flags (`supportsSteer`, `supportsResume`, `supportsPermissionModes`, `supportsImages`) as Zod schemas the daemon and server both import (in Phase 1 these live in `packages/contracts` and the capability flags only inside the daemon)
  2. User pairs a device to their account and organization with a short-lived RFC 8628 enrollment code; the device holds an Ed25519 identity and authenticates on `/runtime/ws` with a signed challenge instead of the MVP 0 hashed bearer token
  3. User and admin see devices (online/offline, last seen, runtime versions, active sessions) and can revoke one, which disconnects it immediately (the outbound-only link with grace period, at-least-once commands and registered projects already ship from Phase 1: DEV-04, DEV-05)
  4. Work Zone permission grains (VIEW … FULL_CONTROL) resolve through `resolveEffectivePermissions` with Owner / Collaborator / Reviewer / Viewer templates, ready to replace the MVP 0 demo access policy in Phase 10

**Plans**: TBD
**Research:** standard (Ed25519 challenge auth and the RFC 8628 device grant are standard; the protocol shape exists in `packages/contracts`)
**UI hint**: no

DEV-07 (acceptance specs committed before any daemon or WorkSession code) is superseded: that code
shipped in Phase 1, and Scenarios A and B are owned by ART-06 (Phase 12).

### Phase 9: Desktop Shell and Adapter Hardening

**Goal**: The MVP 0 desktop app and adapters become a product — a signed, auto-updating desktop app for macOS, Windows and Linux with a bundled renderer that supervises the daemon over an authenticated local socket and survives sleep, and adapters that respect org-capped permission modes, report the git base commit and keep one runtime per working tree
**Mode:** mvp
**Depends on**: Phase 8 (DEV-01 `packages/protocol`; device identity from DEV-02 when available)
**Parallel with**: Phase 8
**Requirements**: RUNTIME-05, RUNTIME-08, RUNTIME-10, DESK-01, DESK-02, DESK-04, DESK-05
**Success Criteria** (what must be TRUE):

  1. Developer installs the signed and notarized desktop app (macOS, Windows, Linux) from the auto-update feed; it renders a bundled UI that shares packages with web and never loads the remote web site (MVP 0 loads the web URL, deviation D-1), and it talks to the daemon over a Unix socket / named pipe with a token (MVP 0: a 0600 Unix socket on macOS only)
  2. Both adapters map their permission modes onto the common `permissionMode` enum and organization policy can cap the mode (rejecting bypass-permissions modes already ships from Phase 1)
  3. The git adapter also reports the base commit next to branch, current commit, dirty state, changed files, diff and the per-session worktree that already ship; a second session on the same registered project path is offered a worktree instead of a second runtime on the same tree
  4. Sleeping the host parks its sessions as `host_offline` and waking reattaches them, never `failed`; the daemon survives an app restart with no orphaned processes; device secrets live in OS-encrypted storage behind hardened webPreferences and Electron fuses, and an `N-1 → N` desktop update test passes in CI

**Plans**: TBD
**Research:** needed (macOS notarization entitlements and Electron fuses; Windows named pipes; Linux `bwrap` preflight; bundled renderer vs web reuse; vendor terms for driving Claude Code / Codex on subscription logins; record the ADR-0005 validation result from the Phase 1 build)
**UI hint**: yes

### Phase 10: WorkSession Core

**Goal**: The Phase 1 Work Zone slice becomes the complete cloud-owned WorkSession — grain-checked participants, full prompt identity with execution modes, a versioned shared queue with Steer, live presence and following, host acceptance, resume across sleep and restarts, and searchable history — provable from the API
**Mode:** mvp
**Depends on**: Phase 8, Phase 9
**Requirements**: WZ-01, WZ-03, WZ-04, WZ-05, WZ-06, WZ-08, WZ-09, WZ-10, WZ-11, WZ-12, WZ-13, WZ-14, WZ-15, WZ-16
**Success Criteria** (what must be TRUE):

  1. A WorkSession moves through draft → provisioning → idle / running / waiting_approval / host_offline → completed / failed → archived; when the host is another member's device, that host must accept (or have pre-authorised the project/team) before the runtime launches, replacing the MVP 0 device-wide `shared` flag
  2. Participants hold permission templates; every action is checked against the Phase 8 grains server-side and a participant lacking a grain gets a visible `permission.denied` event, replacing the MVP 0 demo access policy (deviation B3-5); every prompt records `prompt_id`, author, origin device, session, created_at, execution mode and status in the audit log (Control Plane routing and the single-executor arbiter already ship from Phase 1: WZ-02, WZ-07)
  3. The shared queue adds versioned edits, priority and run-next to the existing add / edit / cancel / reorder; Steer is offered only when the adapter reports `supportsSteer` (otherwise head-of-queue), and Interrupt stops the current turn
  4. Only `APPROVE` holders can approve once, allow for session or deny with comment (timeouts and restart expiry already ship); assistant deltas are checkpointed into rows during a turn so a reconnecting participant replays them by cursor; git state including the base commit and the changed files/diff are exposed behind `DIFF_VIEW` with only repo-relative paths
  5. Session presence (Controlling / Viewing diff / Typing / Following / Away) is tracked per participant, a user can follow a session without controlling it and receive its notifications, sessions resume after app restart or host sleep as well as daemon restart (showing "Host offline since …" while queued prompts wait), and sessions can be renamed, auto-archived after a configurable period and searched with the event log as transcript

**Plans**: TBD
**Research:** standard (extends the Phase 1 state machine, arbiter and approval round-trip; the risk is discipline, not unknowns)
**UI hint**: no

### Phase 11: Work Zone UI

**Goal**: Desktop and web users see and control a live multiplayer session with the affordances of the official coding-agent GUIs, completing the Phase 1 session view with capability-driven controls that never offer what the runtime cannot do
**Mode:** mvp
**Depends on**: Phase 10
**Requirements**: WZUI-03, WZUI-05, WZUI-06, WZUI-07, WZUI-08, WZUI-09, DESK-06, DESK-07
**Success Criteria** (what must be TRUE):

  1. The conversation stream renders the Unified Session Event Protocol in Normal / Verbose / Summary modes (collapsed tool cards already ship); the queue panel adds run next and priority to drag reorder, edit, remove and authors (the session sidebar, new-session dialog, approval banner and web control already ship from Phase 1: WZUI-01, WZUI-02, WZUI-04, WZUI-10)
  2. The Changes panel adds side-by-side diff to the unified diff, a read-only terminal panel shows command output, Activity / Files / Context / People panels are available, and the header adds live presence avatars, a Share control and a context/usage indicator (tokens, context window, cost)
  3. The composer autocompletes `@file` mentions from the host's registered project file list (relative paths) and accepts image attachments; "Open in editor" (VS Code / Cursor) deep links work for files of the current session only on the executing host, behind an editor allowlist (deviation D-2)
  4. Desktop notifications fire for task completed, task failed, approval required, mention and device offline

**Plans**: TBD
**Research:** needed (diff-rendering library choice — `@pierre/diffs` vs `@git-diff-view/react`, both young; xterm streaming performance with coalesced chunks)
**UI hint**: yes

### Phase 12: Artifacts, Chat → Work Zone and MVP 2 Acceptance

**Goal**: Work Zones produce shareable artifacts governed by organization policy, any conversation can spawn a Work Zone that reports back through a live Agent Card, and both PRD acceptance scenarios pass end to end against the self-hosted stack with a desktop build
**Mode:** mvp
**Depends on**: Phase 11 (uses Phase 4 conversations and object storage and Phase 6 Agent Cards)
**Requirements**: ART-01, ART-02, ART-03, ART-04, ART-05, ART-06
**Success Criteria** (what must be TRUE):

  1. The daemon publishes a shared artifact through workspace containment → policy → SHA-256 → security checks → encrypted presigned upload → object storage and participants receive `artifact.created`; preview and download require `FILES_VIEW` / `FILES_DOWNLOAD`, are audited, and use short-lived ACL-scoped URLs that stop working when a share is revoked
  2. An Organization Admin sets the artifact storage policy (enabled / encrypted only / disabled) and retention, and the daemon and server honour it
  3. From a channel, thread or AI chat a user creates a Work Zone by choosing a project and an online host; the originating conversation gets a live Agent Card with Open / Follow that updates as the session progresses, and an AI Chat → Work Zone carries the conversation summary, participants and permissions into the new session
  4. Acceptance Scenario A (with web approval in place of mobile) and full Scenario B pass end to end in CI against the compose stack with a signed desktop build

**Plans**: TBD
**Research:** standard (presigned S3 pipeline is standard; the Phase 1 Work Zone E2E is the starting point for the acceptance specs)
**UI hint**: yes

## Coverage

| Category | Requirements | Phase |
|----------|--------------|-------|
| FOUND | FOUND-01 … FOUND-04 (4) | 1 |
| FOUND | FOUND-05, FOUND-06, FOUND-07 (3) | 7 |
| SLICE | SLICE-05 … SLICE-18 (14) | 1 |
| SLICE | SLICE-01 … SLICE-04 (4) | superseded |
| AUTH | AUTH-01 … AUTH-03 (3) | 1 |
| AUTH | AUTH-04 … AUTH-06 (3) | 2 |
| ORG | ORG-01 … ORG-06 (6) | 2 |
| RT | RT-02, RT-05 (2) | 1 |
| RT | RT-01, RT-03, RT-04 (3) | 3 |
| CHAT | CHAT-01, CHAT-03 (2) | 1 |
| CHAT | CHAT-02, CHAT-04 … CHAT-14 (12) | 4 |
| AICHAT | AICHAT-01 … AICHAT-09 (9) | 5 |
| MULTI | MULTI-01 … MULTI-08 (8) | 6 |
| AGENT | AGENT-03 (1) | 1 |
| AGENT | AGENT-01, AGENT-02, AGENT-04 (3) | 6 |
| SELF | SELF-01 … SELF-07 (7) | 7 |
| DEV | DEV-04, DEV-05 (2) | 1 |
| DEV | DEV-01, DEV-02, DEV-03, DEV-06 (4) | 8 |
| DEV | DEV-07 (1) | superseded |
| RUNTIME | RUNTIME-01 … RUNTIME-04, RUNTIME-06, RUNTIME-07, RUNTIME-09 (7) | 1 |
| RUNTIME | RUNTIME-05, RUNTIME-08, RUNTIME-10 (3) | 9 |
| DESK | DESK-03 (1) | 1 |
| DESK | DESK-01, DESK-02, DESK-04, DESK-05 (4) | 9 |
| DESK | DESK-06, DESK-07 (2) | 11 |
| WZ | WZ-02, WZ-07 (2) | 1 |
| WZ | WZ-01, WZ-03 … WZ-06, WZ-08 … WZ-16 (14) | 10 |
| WZUI | WZUI-01, WZUI-02, WZUI-04, WZUI-10 (4) | 1 |
| WZUI | WZUI-03, WZUI-05 … WZUI-09 (6) | 11 |
| ART | ART-01 … ART-06 (6) | 12 |

**Total:** 140 v1 requirement IDs: 135 active and mapped (Phase 1: 42, Phase 2: 9, Phase 3: 3,
Phase 4: 12, Phase 5: 9, Phase 6: 11, Phase 7: 10, Phase 8: 4, Phase 9: 7, Phase 10: 14, Phase 11: 8,
Phase 12: 6), 5 superseded, 0 orphaned, 0 duplicated. Per-requirement status and evidence live in the
REQUIREMENTS.md traceability table.

**Adjustments to the research suggestion:** DESK-06 (desktop notifications for task completed /
failed / approval required / mention / device offline) and DESK-07 (open-in-editor for files of the
current session) are placed in Phase 11 rather than Phase 9 because their observable behaviour needs
a WorkSession to exist (Phase 10); SUMMARY.md's Phase 11 deliverables already list both. Everything
else follows the reconciled 12-phase structure in `.planning/research/SUMMARY.md`.

**Restructure 2026-10-02 (MVP 0):** the core value (multiplayer AI chat) was only demonstrable at
Phase 6, after a near-complete Slack clone, so Phase 1 became a thin vertical slice deliverable in
1–2 weeks. It keeps the foundations that are ruinous to retrofit (FOUND-01…06) and pulls forward
AUTH-01…03 (setup token, invite, signup), ORG-05 (same-transaction audit, applied to the sensitive
actions that exist in each phase; later phases extend it), RT-01, RT-02, RT-05 (one WebSocket, seq
replay, shared realtime client) and MULTI-02, MULTI-03, MULTI-04, MULTI-08 (live multi-human AI chat,
structural identity, one generation per conversation, Scenario B steps 1–4), plus five thin SLICE
requirements (single env-configured model, private streaming chat, person-to-person share, minimal
responsive web UI, deterministic mock model for E2E). FOUND-07 (CI guardrails) moved to Phase 7;
Phases 2, 3 and 6 were narrowed to what remains; numbering 1–12 is unchanged and the total grew from
122 to 127.

**Restructure 2026-10-04 (Phase 1 re-mapped to what was built):** on 2026-10-02 the owner widened
Phase 1 for an investor demo — Slack-style channels, threads and @mentions instead of a ChatGPT-style
shared AI chat; one-click OpenClaw bots from MVP 0 (model fixed per bot); a Work Zone with the desktop
app running Claude Code / Codex on each user's own subscription (BYO, never pooled); MinIO dropped from
Phase 1; a third DB role `ocw_auth` approved. It was built from `01-BUILD-SPEC.md` without PLAN.md
files. On 2026-10-04 every v1 requirement was audited against the code and tests: 42 delivered (28 full
requirements plus SLICE-05…18), 48 partial, 45 not started. Phase 1 was renamed **MVP 0 — Collaborative
Workspace Demo Slice** and now maps the full requirements the build meets — including Work Zone pieces
originally planned for Phases 8–11 (DEV-04/05, RUNTIME-01…04/06/07/09, DESK-03, WZ-02/07,
WZUI-01/02/04/10) and AGENT-03, CHAT-01/03 from Phases 4 and 6 — plus thirteen new thin requirements
SLICE-06…18 for the parts that ship only partially (SLICE-11 is the thin form of v2 CLAW-01, pulled into
v1). SLICE-01…04 are superseded (no AI chat was built: SLICE-02 → AICHAT-02/03, SLICE-03 → MULTI-01;
SLICE-01 → SLICE-09, SLICE-04 → SLICE-17), and DEV-07 is superseded because its "before any code"
ordering can no longer hold (acceptance specs stay with ART-06). Partial or pending requirements that
were in Phase 1 moved to the phase that finishes them: FOUND-05/06 → 7, ORG-05 → 2, RT-01 → 3,
MULTI-02/03/04/08 → 6. Later phases keep their numbers; their requirement lists and success criteria
were trimmed so none claims work that already exists, Phase 4 now adds the object storage that Phase 1
dropped, and Phases 8 and 9 were renamed to what they still have to do (device trust and protocol;
desktop and adapter hardening). The v1 total grew from 127 to 140 IDs, of which 135 are active.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 ‖ 9 → 10 → 11 → 12
(Phases 8 and 9 may run as parallel workstreams after DEV-01 lands; both must complete before 10.)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. MVP 0 — Collaborative Workspace Demo Slice | MVP 0 | built from 01-BUILD-SPEC.md (no plans) | Executed, demo-verified; formal verification pending | - |
| 2. Identity and Organization | MVP 1 | 15/15 | Complete | 2026-10-04 |
| 3. Realtime Presence and Latency | MVP 1 | 0/6 | Planned | - |
| 4. Chat | MVP 1 | 0/TBD | Not started | - |
| 5. Direct AI Chat | MVP 1 | 0/TBD | Not started | - |
| 6. Multiplayer AI Chat, Shared-Context Safety and Agents | MVP 1 | 0/TBD | Not started | - |
| 7. Self-hosted Release | MVP 1 | 0/TBD | Not started | - |
| 8. Device Trust, Protocol and Work Zone Permissions | MVP 2 | 0/TBD | Not started | - |
| 9. Desktop Shell and Adapter Hardening | MVP 2 | 0/TBD | Not started | - |
| 10. WorkSession Core | MVP 2 | 0/TBD | Not started | - |
| 11. Work Zone UI | MVP 2 | 0/TBD | Not started | - |
| 12. Artifacts, Chat → Work Zone and MVP 2 Acceptance | MVP 2 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-09-10*
*Restructured: 2026-10-02 (Phase 1 → MVP 0 Multiplayer AI Chat Slice); 2026-10-04 (Phase 1 → MVP 0 Collaborative Workspace Demo Slice, requirements re-mapped after the code audit)*
*Source: .planning/REQUIREMENTS.md (140 v1 requirement IDs, 135 active), .planning/research/SUMMARY.md (12-phase suggestion), PRD v1.0 MVP 1 + MVP 2*
