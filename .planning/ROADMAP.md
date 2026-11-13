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
- [x] **Phase 3: Realtime Presence and Latency** - Subscription re-authorisation on membership change, sub-500 ms propagation test on the compose stack, presence with expiry (typing already ships)
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

**Goal**: Every member can have their own private bot that lives as a direct chat in their sidebar and answers every message, and every bot — personal or team — has explicit, admin-governed capabilities (internet, memory, reply mode, time context, usage limit, MCP servers and OpenClaw Marketplace plugins) enforced in the OpenClaw cell on every turn
**Mode:** mvp
**Requirements**: BOT-01, BOT-02, BOT-03, BOT-04, BOT-05, BOT-06, BOT-07, BOT-08, BOT-09, BOT-10
**Depends on:** Phase 3
**Success Criteria** (what must be TRUE):

  1. A Developer creates a personal bot in one click; a private direct chat with it appears in their sidebar, the bot answers every message there without an @mention, and no other member (admins included) can read that conversation or use the bot
  2. Any member opens a private direct chat with a team bot they may use; their history is invisible to other members
  3. A bot owner/manager toggles internet access, memory, reply mode, date/time context and a daily limit; with internet on the bot answers a question that needs a web lookup and the search/fetch is audited, with it off no web tool reaches the model (proven in the cell contract tests and an e2e with the fake model)
  4. An Organization Admin denies a capability org-wide (or for personal bots only) and every affected bot loses it on the next turn; the bot's settings show the toggle disabled with the reason; shell/exec, filesystem writes and browser control are never offered
  5. When a bot reaches its daily limit it replies with a clear notice and makes no model call; owners and admins see usage against the limit; memory is visible to the human it belongs to and can be cleared
  6. An Organization Admin registers an MCP server (remote or cell-sandboxed stdio) with a secret-store credential, a bot manager attaches it to a bot and enables some of its tools, and the bot calls one of those tools in a conversation; the call is audited, runs within the asking human's permissions, and a tool that is not enabled never reaches the model
  7. An Organization Admin browses the OpenClaw Marketplace (ClawHub) from Settings, reviews a plugin (publisher, version, declared tools, risk) and installs a pinned version into the cell; the plugin's tools become a capability that can be enabled per bot and capped by policy, a bot uses them in a conversation, and the plugin can be updated or uninstalled — all audited, with dangerous tool classes blocked whatever the plugin declares

**Plans:** 15/15 plans complete
**Research:** needed (OpenClaw 2026.9.7 web search/fetch tools and their providers — keyless vs API key, memory plugin and per-agent/per-peer scoping, per-turn tool allowlist, DM routing in the channel plugin; resolver grants for personal bots; DM conversation model reuse; OpenClaw MCP client support (stdio/HTTP, sandboxing), OpenClaw plugin install/update/uninstall at runtime and the ClawHub marketplace API — catalog, metadata, signing/provenance)
**UI hint**: yes

Plans:

- [x] 03.1-01-PLAN.md — Wave 1: tracer — whole-phase migration, six permissions, resolver agent resource; one-click personal bot → private DM under Bots → answers without @mention (real cell + fake model smoke, browser e2e); privacy hardening
- [x] 03.1-02-PLAN.md — Wave 2: team-bot DMs for every member; personal bots invisible to others (lists, events, autocomplete); admin governance (disable/delete) and DM archiving; personal-bot limit
- [x] 03.1-03-PLAN.md — Wave 2: capability model contracts, pure effective decision with reasons, bot capabilities / org policy / governance routes, per-turn `turn` block and `agent_turns` ledger
- [x] 03.1-04-PLAN.md — Wave 3: cell enforcement — lockdown v2, bundled DuckDuckGo/SearXNG search, fail-closed tool gate with API re-decision and audit, taint and caps, DM session isolation, SearXNG profile
- [x] 03.1-05-PLAN.md — Wave 3: daily usage limits — atomic counter, notice instead of a model call, channel notice once per day
- [x] 03.1-06-PLAN.md — Wave 3: capabilities UI (toggles with reasons, usage meter, bot settings sheet) and Settings › Bot policy with personal-bot governance
- [x] 03.1-07-PLAN.md — Wave 4: per-human bot memory in Postgres via `ocw_memory_save`, DM-only, visible and clearable, taint-protected
- [x] 03.1-08-PLAN.md — Wave 4: reply mode "every message" with loop/flood guardrails; asking human's local date/time
- [x] 03.1-09-PLAN.md — Wave 4: MCP server registry API (write-only secret credentials, safe names, URL policy, probe request) and fake MCP server
- [x] 03.1-10-PLAN.md — Wave 5: MCP in the cell — probe via SDK 1.30.0, `mcp.servers` rendering with env refs, gated and audited MCP calls, taint for MCP output
- [x] 03.1-11-PLAN.md — Wave 5: Marketplace API — ClawHub proxy without telemetry, risk scorer, pinned approve/update/uninstall, fake ClawHub
- [x] 03.1-12-PLAN.md — Wave 6: Marketplace executor in the cell — digest-verified installs behind `security.installPolicy`, boot persistence, report route; official DuckDuckGo install/uninstall and a plugin tool used in a conversation (real cell)
- [x] 03.1-13-PLAN.md — Wave 7: Settings › Marketplace, Settings › MCP servers and per-bot tool toggles; browser e2e of a bot using an MCP tool and a plugin tool
- [x] 03.1-14-PLAN.md — Wave 7 (optional, may slip without blocking SC6): hardened stdio MCP sandbox sidecar
- [x] 03.1-15-PLAN.md — Wave 8: ADR-0010/0011, AGENTS.md and DEMO.md; real-cell proof against the isolated stack (real ClawHub, real web search, MCP tool, audit, uninstall); phase gate

### Phase 03.2: Work Zone session controls (INSERTED)

**Goal**: Inside one Work Zone chat, a controller changes the model, the thinking level and the permission mode, and reaches every option Claude Code and Codex expose, from a composer that matches the reference layout (provider-grouped model picker, reasoning menu, permission menu). Every control is driven by what the runtime reports: an option is never shown as available unless the adapter has confirmed it
**Mode:** mvp
**Requirements**: WZC-01, WZC-02, WZC-03, WZC-04, WZC-05, WZC-06, WZC-07
**Depends on:** Phase 03.1; pulls forward part of Phase 8 (device grains), Phase 9 (org-capped permission modes), Phase 10 (host acceptance) and Phase 11 (capability-driven controls)
**Decisions:** ADR-0012 (owner, 2026-10-05): real Full access mode and shared devices
**Reference:** `.planning/phases/03.2-work-zone-session-controls/reference/` (owner's screenshots, 2026-10-05)
**Success Criteria** (what must be TRUE):

  1. In an open session the composer shows a model picker grouped by runtime (Claude Code, Codex) that lists only the models the host runtime reports for that user's own subscription. Choosing another model of the same runtime applies from the next turn, keeps the conversation and is audited. Proven with recorded adapter fixtures per pinned runtime version and an e2e
  2. A reasoning menu offers only the levels the selected model supports (Claude Code effort / thinking, Codex reasoning effort), plus context window and fast mode when the runtime reports them. Unsupported options are hidden or shown disabled with the reason; switching models re-validates the current choice
  3. A permission menu offers *Supervised* (ask before commands and edits), *Auto-accept edits*, *Auto* where the runtime supports it, and *Full access* — the real bypass mode of Claude Code and Codex (ADR-0012) — mapped onto the common `permissionMode` enum. Full access is offered only when org policy, the device owner's opt-in and the asker's grain all allow it (each off by default), is checked server-side on every turn, shows a persistent badge to every controller and is audited; slash commands typed in a prompt cannot raise the mode
  4. A documented inventory lists every option of Claude Code (Agent SDK) and Codex (app-server) at the pinned versions with its status: exposed, deferred or impossible, and why. Each exposed option is reachable from the same chat (menus or slash commands), and nothing in the UI claims an option the inventory has not confirmed
  5. A device owner marks a device (e.g. a server hosting the harnesses) as *shared* with chosen members or units, each with a maximum permission mode; those people start and control sessions on it without the owner accepting each session or action, revoking someone stops their sessions, and the device settings show whose runtime subscription is used (ADR-0012)
  6. The whole session screen (sidebar, header, stream with turn summaries and changed-files card, agent-working bar, composer, worktree/branch footer — `reference/ref-4-layout.png`) and the composer menus match the reference screenshots at 1440 and 390 in light and dark (side-by-side review recorded in the phase), every change made by one controller shows live to the others, and the single execution authority is unchanged
  7. A new session gets an automatic short title (2–5 words, ≤ 32 characters) that describes the request, generated from the first prompt by the session's runtime with a small model (Claude Code: Haiku; Codex: GPT-6-Luna) on the user's own subscription; if that model is unavailable or not allowed the first line of the prompt is kept, a title typed by the user is never replaced, and the title fits the sidebar, breadcrumb and tab at 1440 and 390

**Plans:** 12 plans
**Research:** needed (Agent SDK `setModel` / `setPermissionMode` / effort and thinking options and model listing at the pinned version; `codex app-server` per-turn model, effort, approval policy and sandbox overrides and `model/list`; plan mode, fast mode and context window support; how to cap modes by org policy; research for cross-provider switching and multi-agent sessions is in `.planning/research/` as input for later phases)
**UI hint**: yes

Plans:

- [ ] 03.2-01-PLAN.md — Wave 1: tracer — whole-phase contracts (settings, catalog, controls, policy, slash, inventory) and the only migration; a model change flows composer → API → `session.configure` → daemon → fake runtime → `session.settings` → second controller
- [ ] 03.2-02-PLAN.md — Wave 2: Claude Code adapter — between-turn settings, every init forwarded, runtime catalog with context-window probe, per-turn cap, slash backstop; fixtures at 2.1.289
- [ ] 03.2-03-PLAN.md — Wave 2: Codex adapter — per-turn overrides, Supervised = read-only + untrusted, `model/list` catalog, `thread/settings/updated`, `/compact`; fixtures at 0.160.0
- [ ] 03.2-04-PLAN.md — Wave 2: Work Zone policy and server-side intersection (policy ∩ device opt-in ∩ cap ∩ grain ∩ catalog), per-turn mode audit, downgrades, unauthorized-bypass fail-closed
- [ ] 03.2-05-PLAN.md — Wave 3: shared devices — grants per member/unit with max mode, no per-session acceptance, revocation stops sessions, "Runs on X's login"
- [ ] 03.2-06-PLAN.md — Wave 3: Full access through ADR-0012 — device-local opt-in (desktop menu, CLI, env), daemon refusal, real bypass in both adapters only when authorized
- [ ] 03.2-07-PLAN.md — Wave 3: slash commands routed through the settings path or refused; `POST /prompts` is no back door
- [ ] 03.2-08-PLAN.md — Wave 3: Settings › Work Zone policy page
- [ ] 03.2-09-PLAN.md — Wave 4: reference composer — model picker, reasoning and permission menus (ref-1..3), mobile sheets, catalog-driven New session dialog
- [ ] 03.2-10-PLAN.md — Wave 5: session screen layout per ref-4 — sidebar rows, breadcrumb header + Full access badge, turn summaries, changes card, agent bar, footer strip
- [ ] 03.2-11-PLAN.md — Wave 6: documented inventory with parity tests, ADR-0013, AGENTS.md/DEMO.md, side-by-side reference review, phase gate
- [ ] 03.2-12-PLAN.md — Wave 7: automatic session titles (WZC-07) — tracer: `title_source` migration, `session.title` → device → `title.result`, typed title kept, live in sidebar/breadcrumb/tab; Claude Code Haiku one-shot and Codex GPT-6-Luna ephemeral thread with one fixture each; fallbacks, `wz-title-*` fit screenshots, ADR-0014

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

**Plans:** 13 plans
**Research:** needed only for the object-storage choice (MinIO community-edition trajectory vs Garage/SeaweedFS); the rest is standard Slack-model chat over the Phase 1 model and realtime client
**UI hint**: yes

Plans:

- [ ] 04-01-PLAN.md — Wave 1: tracer — every Phase 4 contract and the only migration (`*_chat_workspace`); an author's edit reaches a second member live with an (edited) marker and an append-only version; delete with tombstones (admins only where readable, never DMs); the readable-set helper
- [ ] 04-02-PLAN.md — Wave 1: one shared Markdown renderer for chat, threads, DMs, agent output and the Work Zone (XSS fixtures, web unit project), then streamdown + shiki after a package-legitimacy checkpoint
- [ ] 04-03-PLAN.md — Wave 2: permalinks — copy link, `around`/`after` pages, detached history with highlight and "Jump to latest", thread-reply and DM anchors
- [ ] 04-04-PLAN.md — Wave 2: Garage object storage in compose (ADR-0015), Artifact module (presign, sniff, renditions, authorized download, audit, sweeper), harness and CI storage
- [ ] 04-05-PLAN.md — Wave 3: emoji reactions (frimousse picker), pins with a pinned sheet, personal saves with the Saved view
- [ ] 04-06-PLAN.md — Wave 3: PostgreSQL full-text search (messages, people, channels, filters) on the resolver's readable set, ⌘K palette and results page
- [ ] 04-07-PLAN.md — Wave 4: human DMs and group/mixed DMs (fixed membership, mention-only bots, no shared memory) and the DM privacy suite
- [ ] 04-08-PLAN.md — Wave 5: sidebar grouped by department/team (unit on create/move, unit-scoped rules) and the All, Threads, AI Chats and Saved views
- [ ] 04-09-PLAN.md — Wave 6: Notification module — mentions, DMs, thread replies, @channel/@here (online set, permission, rate limit), Mentions inbox
- [ ] 04-10-PLAN.md — Wave 7: unread and mention badges counted over messages, mark read/unread synced across devices
- [ ] 04-11-PLAN.md — Wave 8: notification preferences (mute, DND, levels, desktop/web toggles), OS notifications while the app runs, title count and desktop dock badge
- [ ] 04-12-PLAN.md — Wave 8: attachments in chat — drag-and-drop, paste, progress, previews, lightbox, file cards, downloads
- [ ] 04-13-PLAN.md — Wave 9: phase gate — cross-feature e2e, full regression, 1440/390 light/dark review, ADR-0016, AGENTS.md/DEMO.md/traceability, validation sign-off

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

**Plans:** 15 plans in 12 waves (validation strategy: `05-VALIDATION.md`; owner decisions D-01 … D-08 in `05-CONTEXT.md`, planner decisions P-01 … P-14 in `05-01-PLAN.md`)
**Research:** standard (AI SDK 7 `streamText` and provider packages are documented in STACK; the model integration contract is captured by `/gsd-ai-integration-phase` during planning)
**UI hint**: yes

Plans:

- [ ] 05-01-PLAN.md — Wave 1 [BLOCKING]: every Phase 5 contract and both migrations (`*_ai_chat`; `*_provider_secret_refs` with the SecretReference backfill, proven on legacy rows with a documented rollback); RLS and append-only proofs on fresh PostgreSQL
- [ ] 05-02-PLAN.md — Wave 2: API tracer — package-legitimacy gate for the AI SDK 7 pins (approved); model gateway + run loop: one ChatGPT-plan turn streams to a WebSocket subscriber from the fake Responses API and persists with a usage record; owner-only privacy and static prompt/model guards
- [ ] 05-03-PLAN.md — Wave 3: browser tracer — harness wiring to the fakes, `/chat/ai/new` and `/chat/ai/[chatId]`, streaming screen with footer and "Using ChatGPT plan · Manage usage", reconnect-safe stitching, first e2e at 1440/390
- [ ] 05-04-PLAN.md — Wave 4: org provider keys on SecretReferences (cell included; resolution from `secret_ref` only; migrated rows still serve bots), org-key and mock backends, one allowed list for chats and bots, grouped model picker with METERED labels, per-message model switch
- [ ] 05-05-PLAN.md — Wave 4: Sign in with ChatGPT per member (PKCE, paste redirect, ID-token/JWKS and scope checks, serialized refresh, revoke), fake SIWC server, Settings › AI chat card, ADR-0017 (proposed)
- [ ] 05-06-PLAN.md — Wave 5: stop across API instances (partial kept), one-generation gate, interrupted-generation sweeper and shutdown, reload resume, regenerate (also with another model) with append-only versions
- [ ] 05-07-PLAN.md — Wave 5: ChatGPT-plan errors and UX (usage-limit dialog with Manage usage, no silent billing switch, not-eligible fallback, reconnect, Continue with ChatGPT, welcome dialog) and the desktop loopback sign-in
- [ ] 05-08-PLAN.md — Wave 6: metering — sourced prices, one record per outcome, tokens/cost per message, atomic daily caps with no model call at the cap, admin AI chat policy
- [ ] 05-09-PLAN.md — Wave 7: usage reports — admin by member and by model (7/30/90 days), member's own today/30-day usage
- [ ] 05-10-PLAN.md — Wave 7: auto titles per backend (ADR-0014 contract), AI chats list and sidebar section, rename/archive, owner-only search in the palette and results
- [ ] 05-11-PLAN.md — Wave 8: personal and per-chat instructions; Web / Company Knowledge / MCP / Skills toggles with only Web functional (hosted search on the plan, SearXNG on org keys) and every disabled state explained
- [ ] 05-12-PLAN.md — Wave 9: files and images to vision/PDF-capable models through the Phase 4 upload pipeline, server-read bytes, untrusted content that cannot trigger tools, capability gating in the composer
- [ ] 05-13-PLAN.md — Wave 10: org-scoped read-only snapshot share links (never public), revoke, share-scoped images, audit
- [ ] 05-14-PLAN.md — Wave 11: ChatGPT/Claude.ai-quality polish of every AI chat screen, 1440/390 light/dark review (`05-UI-REVIEW.md`), keyboard and screen-reader pass
- [ ] 05-15-PLAN.md — Wave 12: phase gate — cross-feature e2e, leak and anonymous-access sweep, full regression, ADR-0017 accepted + ADR-0018, AGENTS.md/DEMO.md/traceability, validation sign-off, owner's real sign-in check

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

**Plans:** 16 plans in 8 waves (validation strategy: `06-VALIDATION.md`; owner decisions D-01 … D-08 in `06-CONTEXT.md`, planner decisions P-01 … P-16 in `06-01-PLAN.md`)

Plans:

- [ ] 06-01-PLAN.md — Wave 1 [BLOCKING]: every Phase 6 contract and the single migration (`*_multiplayer_ai`: grants, message context, Agent Cards, follows, `agents.unit_id`, notification kinds) proven on fresh PostgreSQL under tenant RLS
- [ ] 06-02-PLAN.md — Wave 2: API tracer — Víctor shares his AI chat with Alex in place; Alex reads, subscribes and writes; the model answers Alex on Alex's plan with roster + attributed blocks; owner-only management and solo chats unchanged
- [ ] 06-03-PLAN.md — Wave 3: browser tracer — Scenario B steps 1–4 at 1440/390 (share dialog with disclosure, "Shared with me", author names), fake model replies from attributed prompts
- [ ] 06-04-PLAN.md — Wave 3: grants complete — team/department/organization subjects, levels, live revocation, notice rows, search and files follow grants
- [ ] 06-05-PLAN.md — Wave 3: prompt builder complete — persona blocks, file labels, notices, withheld tools, six spoof cases as free fixtures, provider wire matrix (plan, OpenAI, Anthropic, openai-compatible)
- [ ] 06-06-PLAN.md — Wave 3: one-generation arbiter — addressing, message-derived queue, coalesced turns billed to the first waiting author, skips, sweeper pickup
- [ ] 06-07-PLAN.md — Wave 3: agent personas — scope (org/department/team/project/personal), owner, Team Lead creation and configuration, unit visibility, Bots UI
- [ ] 06-08-PLAN.md — Wave 4: shared chats in the sidebar, unread, inbox and notifications (direct shares, mentions), per-recipient live summaries
- [ ] 06-09-PLAN.md — Wave 4: three-participant spoofing/addressing eval — deterministic grader, opt-in local metered runner, label/weekly workflow (never every PR)
- [ ] 06-10-PLAN.md — Wave 5: agents in AI chats through OpenClaw — members API, flat deliveries with attributed history, audience-aware tool intersection, no memory
- [ ] 06-11-PLAN.md — Wave 6: live multiplayer UI — typing, Ask AI and @ suggestions, queue chip with requester-only Stop, addressing states, payer labels
- [ ] 06-12-PLAN.md — Wave 7: share UI complete (teams, departments, organization, levels, removal) + participants with presence + add/remove agents
- [ ] 06-13-PLAN.md — Wave 6: Agent Cards API — post/update through the Agent Channel API, in-place updates, follow notifications, single audited decisions delivered to the agent
- [ ] 06-14-PLAN.md — Wave 7: `ocw_agent_card` cell tool and card-decision turns in the OpenClaw plugin
- [ ] 06-15-PLAN.md — Wave 7: Agent Card renderer in channels, threads, DMs and AI chats with Follow and Approve
- [ ] 06-16-PLAN.md — Wave 8: phase gate — fresh-stack day, leak/access sweep, ADR-0019 + ADR-0020, AGENTS.md/DEMO.md/traceability, validation sign-off, owner's metered eval and OpenAI terms check

**Research:** needed (prompt assembly for the AI chat run loop across Anthropic / OpenAI / Google / openai-compatible — alternation rules, mid-conversation system messages, prompt caching; whether bots in shared AI chats answer through OpenClaw or the AI SDK loop; the participant-spoofing eval fixture and its metered-model budget)
**UI hint**: yes

### Phase 06.1: Work Zone image attachments (INSERTED)

**Goal**: A controller pastes (Ctrl/Cmd+V), drops or attaches images in the Work Zone composer and the session's runtime (Claude Code or Codex) receives them with the prompt; everyone in the session sees the sent images in the stream. Reuses the Phase 4 attachment pipeline (Garage, presigned upload, sniffing, renditions); the API is the only ACL and forwards bytes to the device as `PromptPayload.images`.
**Requirements**: WZ-IMG-01 (paste/drop/attach with previews), WZ-IMG-02 (API accepts attachment ids with a prompt; access, tenant, type and size checked; audited), WZ-IMG-03 (device receives the images; both adapters pass them to the runtime), WZ-IMG-04 (stream shows sent images to every controller)
**Depends on:** Phase 6
**Reason:** owner, 2026-10-07: "no puedo pegar imágenes en Work Zone con Ctrl+V" — diagnosed as not built (inventory row "Composer: attachments | deferred"); owner: "haz el arreglo recomendado".
**Success Criteria** (what must be TRUE):

  1. Pasting, dropping or picking a PNG/JPEG/GIF/WebP in the Work Zone composer shows a removable thumbnail; sending queues the prompt with its images; at 1440 and 390, light and dark
  2. The prompt route accepts only attachments the sender uploaded in the same organization, of an allowed image type, within the device-link size budget; anything else is refused with a clear error, and cross-tenant attempts fail (integration test)
  3. The device adapters receive the images and pass them to Claude Code and Codex in their native input shape (adapter tests); a runtime/model without image input refuses visibly instead of dropping them
  4. The session stream shows the images sent with each prompt to every controller; the inventory row for composer attachments is updated from deferred to shipped

**Plans:** 5 plans in 4 waves (research and planner decisions P-01 … P-13: `06.1-RESEARCH.md`, `06.1-01-PLAN.md`; owner decisions D-01 … D-08 in `06.1-CONTEXT.md`)

Plans:

- [ ] 06.1-01-PLAN.md — Wave 1: contracts, `*_work_prompt_images` migration and the link — Phase 4 upload into the session (scope delegate), prompt ↔ image link, `WorkPrompt.attachments` for every controller, model gate at submit and dispatch, tenant isolation and refusal matrix (Garage)
- [ ] 06.1-02-PLAN.md — Wave 2: dispatch — ids-only prompt commands, flush select → hydrate (outside the transaction) → send → mark, small-PNG original or ≤ 2000 px rendition, 2 MiB budget from recorded sizes, frame guard on every outbound frame, leak scan (FakeDevice)
- [ ] 06.1-03-PLAN.md — Wave 2 (parallel): device and adapters — pinned `maxPayload`, refusal without image support, no image data in acks/logs, fake runtime images, Claude/Codex image input tests (start and steer, replay leak), Codex `imageInput`
- [ ] 06.1-04-PLAN.md — Wave 3: web — paste, drop and paperclip with tray, prompt bubble and queue thumbnails for every controller, refusals and model gate, e2e at 1440/390 light/dark
- [ ] 06.1-05-PLAN.md — Wave 4: phase gate — inventory row exposed (D-08), full local regression, DEMO.md and WZ-IMG traceability, owner's real-runtime check

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

**Plans:** 11 plans in 4 waves (owner/orchestrator decisions D-01 … D-18 in `07-CONTEXT.md`; plan map, cross-plan contracts and executor rules in `07-01-PLAN.md`; CI command list in `07-11-PLAN.md`)

Plans:

- [ ] 07-01-PLAN.md — Wave 1: guardrails in `pnpm verify` — Semgrep rules (bypass tokens, RLS bypass, skipped/focused policy tests, prompt-recording AI telemetry), dependency and package licenses with the claude-agent-sdk exception pending the owner, CODEOWNERS, root entry points
- [ ] 07-02-PLAN.md — Wave 1: schema guard (API refuses a mismatched database) and the N-1 → N upgrade test on a committed Phase 5 (`3bbcbd9`) dump
- [ ] 07-03-PLAN.md — Wave 1 (phase tracer): the compose stack on freshly built images in an isolated gate project (`OCW_IMAGE_TAG`, 34xx), profile includes, gate harness with the demo-safety guard, compose config tests
- [ ] 07-04-PLAN.md — Wave 1: `pnpm ocw` CLI and `ocw setup` (secrets at setup time, never printed, port blocks), `setup:env` shim
- [ ] 07-05-PLAN.md — Wave 1: API OpenTelemetry via `@fastify/otel` (off by default, redacted) after the package gate, and `OCW_TRUST_PROXY`
- [ ] 07-06-PLAN.md — Wave 2: OpenBao behind `SecretStore` (`openbao://` references for the four API-only secrets), `vault` profile, `ocw enable vault`
- [ ] 07-07-PLAN.md — Wave 2: `observability` profile (collector, Tempo, Prometheus, Loki, Grafana), image telemetry preload, `ocw enable observability`
- [ ] 07-08-PLAN.md — Wave 2: Caddy `proxy` profile on one HTTPS origin, `ocw enable proxy`, WebSocket / presigned URL / trusted header checks
- [ ] 07-09-PLAN.md — Wave 2: `ocw backup` / `ocw restore` as `ocw_migrator` (DB, objects, cell state), `--force-recreate` survival, backup/restore/upgrade runbook
- [ ] 07-10-PLAN.md — Wave 3: production-safe Scenario B through Caddy on real images (1440/390) and `pnpm gate:compose` running every compose-level check, optional profiles included
- [ ] 07-11-PLAN.md — Wave 4: release gate — `pnpm gate:cleanroom`, full local gate and CI command list, `docs/INSTALL.md`, ADR-0021, FOUND-06 wording (Garage) and traceability, owner's clean-machine check

**Research:** needed (`@fastify/otel` wiring and the observability profile; backup/restore and upgrade tooling; presigned URLs through Caddy)
**UI hint**: no

---

**MVP 1 boundary.** Phases 1–7 complete MVP 1 (Collaborative Workspace): self-hosted release plus
Scenario B without Work Zone creation. Phases 8–12 below complete MVP 2 (Multiplayer Work Zone) on top
of the thin Work Zone that Phase 1 already ships.

---

**Operations features (inserted 2026-10-08, owner).** Phases 07.1–07.7 turn the 2026-10-06 operations meeting into
generic capabilities for any organization (research: `.planning/research/OPS-FEATURES.md`). Each feature is owned by the
Control Plane (an `ocw_*` plugin tool → Agent Channel API decides and audits → Agent Card when a human approves);
OpenClaw's in-cell equivalents stay off. **Execution order:** 07.3 → 07.1 → 07.2 → 07.4 → 07.5 → 07.8 → 07.9 → 07.10 → 07.11 → 07.12 → 07.14 → 07.15 → 07.16 → 07.17 → 07.13 → 07.6 → 07.7 (07.8 added 2026-10-14, 07.9 added 2026-10-22 and 07.11 added 2026-10-28 and 07.12 added 2026-10-29 and 07.13 and 07.14 added 2026-11-06 and 07.15 added 2026-11-07 and 07.16 and 07.17 added 2026-11-09 by the owner), one phase at a time, each rebased on main; prerequisite: PR #25 merged. Deferred to the backlog: organization groups (F16), model comparison per task
(F17), ERP-driven board columns beyond watched records.

### Phase 07.1: Board channels and record templates (INSERTED)

**Goal**: Any team runs a workflow (case files, orders, tickets, candidates) as a board channel whose cards are threads
with their agent, with a colour-coded waiting state, keyboard- and touch-accessible moves, live multi-user ordering, and
record templates that name cards consistently
**Requirements**: BOARD-01, BOARD-02, BOARD-03, BOARD-04, BOARD-05, BOARD-06
**Depends on:** Phase 7; Phase 07.3 (executes first)
**Research:** done (`OPS-FEATURES.md` F12, F14)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. Creating a channel offers text or board; a board channel inherits the channel's members, permissions, unit, sidebar
     and search, and shows configurable columns with a category (backlog/started/done/cancelled)
  2. A card is the root message of a normal thread: clicking it opens the thread panel, agents answer there, and the card
     shows its waiting state (none/us/customer/both) and title
  3. Cards move between and within columns by drag and drop, by keyboard and by a "Move to…" menu; at 390 px columns are
     tabs; two people moving cards at once converge without lost moves (fractional ranks, server re-rank on collision)
  4. Board changes arrive live through the conversation stream with seq/cursor replay; every board query path has a
     cross-tenant test; card titles and bodies are searchable like messages
  5. A unit-scoped record template defines fields, default columns and a naming rule; new cards get deterministic titles
     and a user-typed title is never replaced
**Plans:** 14 plans in 6 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [ ] 07.1-01-PLAN.md — Wave 1: Contracts first for the whole phase, and the approved dependencies installed exactly.
- [ ] 07.1-02-PLAN.md — Wave 1: One forward-only migration for the whole phase: the layout flag, the four board tables, `COLLATE "C"` ranks and the
- [ ] 07.1-03-PLAN.md — Wave 2: The board core inside the chat module: board channels, the snapshot, cards as thread roots with deterministic titles,
- [ ] 07.1-04-PLAN.md — Wave 2: The browser's board cache and the presentational pieces the board view (07.1-08) assembles, to the UI-SPEC: query,
- [ ] 07.1-05-PLAN.md — Wave 3: Prove and harden the board's access, replay and agent answering on top of 07.1-03's routes and guards.
- [ ] 07.1-06-PLAN.md — Wave 3: Card text edits that keep the board, the message and search in step; the never-replace rule for typed titles; and
- [ ] 07.1-07-PLAN.md — Wave 3: Unit-scoped record templates and their use when a board channel is created.
- [ ] 07.1-08-PLAN.md — Wave 3: The board channel in the web app, to `07.1-UI-SPEC.md`: creation, the toolbar, the board view at 1440 and 390,
- [ ] 07.1-09-PLAN.md — Wave 4: The board stays correct for several people at once: live updates, convergent simultaneous moves, offline catch-up with
- [ ] 07.1-10-PLAN.md — Wave 4: Agents act on boards only through the Agent Channel API: create, move and set the waiting state, decided for the turn's
- [ ] 07.1-11-PLAN.md — Wave 4: Column management, the card strip, card text editing and card deletion in the board UI, on top of 07.1-06's API and to
- [ ] 07.1-12-PLAN.md — Wave 4: Record templates in the web app, to `07.1-UI-SPEC.md`: managed on the unit page in their own card, chosen when a board
- [ ] 07.1-13-PLAN.md — Wave 5: The OpenClaw plugin side of agents on boards, and the browser proof that agents answer in card threads and create and
- [ ] 07.1-14-PLAN.md — Wave 6: Prove Phase 07.1 end to end and record it: cross-tenant route coverage, the full local gate, ADR-0022, DEMO.md and

### Phase 07.2: Scoped memory files and governed promotion (INSERTED)

**Goal**: Agents keep their memory as Markdown files in folders the platform owns — personal, agent, project, team and
organization scopes — that people browse, read and edit in a file-tree viewer with history, while anything an agent
wants to put into a shared scope goes through a detector and a human approval that the server applies
**Requirements**: MEM-01, MEM-02, MEM-03, MEM-04, MEM-05, MEM-06, MEM-07
**Depends on:** Phase 07.3, Phase 07.1
**Research:** done (`OPS-FEATURES.md` F4, F5); owner requirement: a folder/subfolder viewer of `.md` memory files
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. Memory lives in Postgres as virtual `.md` files (relative paths, folders from paths) per scope with append-only
     revisions, RLS and audit; each scope has a `MEMORY.md`; existing per-bot notes are migrated without making them
     readable by admins
  2. A file-tree viewer (web, 1440 and 390, light and dark) lists scopes, folders and files the viewer may read; files
     render through the shared `<Markdown>` (no raw HTML), edit as Markdown source with optimistic versions, and show
     history with diffs; an agent's page shows its memory and its capabilities/skills read-only
  3. Agents read and list memory through `ocw_memory_*` tools decided by the resolver (agent ∩ human) and write their own
     scopes directly; a write into a shared scope becomes a proposal, never a direct write
  4. A proposal runs the detector (secrets always blocked; IBAN, cards, NIF/NIE, email, phone and similar flagged;
     optional Presidio profile), posts an approval card showing the diff, findings and reader count, and on approval the
     **server** applies it (a reusable approve-and-apply primitive with a one-use grant bound to the action hash)
  5. Per-folder rules (path prefix on permission rules, deny wins) decide read/write/promote; cross-tenant and
     cross-unit tests prove a scope never leaks
**Plans:** 17 plans in 8 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [ ] 07.2-01-PLAN.md — Wave 1: Define, in `packages/contracts`, every shape the phase exchanges: the memory path grammar and limits, scope/file/
- [ ] 07.2-02-PLAN.md — Wave 1: Create the memory and approval tables with tenant isolation, a restrictive owner-only policy for personal rows,
- [ ] 07.2-03-PLAN.md — Wave 2: Teach the single authorization authority about memory: a `memory` resource with a path, path-prefix rules with deny
- [ ] 07.2-04-PLAN.md — Wave 2: Move the secret patterns from the Local Runtime into contracts without changing `redact()`'s output, and build the
- [ ] 07.2-05-PLAN.md — Wave 2: Add Presidio as detector layer 2: an API client that is off by default, bounded by a 2 s timeout and fail-open with a
- [ ] 07.2-06-PLAN.md — Wave 2: Build the reusable approve-and-apply primitive: a registry of kinds, a decision transaction that recomputes the action
- [ ] 07.2-07-PLAN.md — Wave 2: Give OpenClaw bots the four memory tools as thin, pre-validating forwarders to the Agent Channel API, keep the
- [ ] 07.2-08-PLAN.md — Wave 3: Build the memory domain and its human REST API: lazy scopes with a `MEMORY.md`, file operations with optimistic
- [ ] 07.2-09-PLAN.md — Wave 4: Implement memory proposals and the `memory.write` approval kind on top of the primitive: detection on added text,
- [ ] 07.2-10-PLAN.md — Wave 5: Ship the browse-and-read half of the memory viewer: navigation entry, pages, the accessible tree, the reading pane,
- [ ] 07.2-11-PLAN.md — Wave 5: Expose memory to agents through the Agent Channel (decided, audited, audience-bound), offer the tools in turns, and move
- [ ] 07.2-12-PLAN.md — Wave 6: Complete the viewer with Markdown-source editing (optimistic versions, conflicts), history with diffs and restore, file
- [ ] 07.2-13-PLAN.md — Wave 7: Build the reviewer side of governed promotion: the approvals inbox and review page (memory proposals and a generic view
- [ ] 07.2-14-PLAN.md — Wave 7: Give every bot a page that shows its memory and its capabilities and skills read-only, and connect the DM memory panel
- [ ] 07.2-15-PLAN.md — Wave 8: Prove the phase end to end: a leak sweep across search, realtime, logs, audit and notifications; the real-cell smoke
- [ ] 07.2-16-PLAN.md — Wave 4: Add memory full-text search over the readable set: the same three unaccented text configurations as chat, snippets
- [ ] 07.2-17-PLAN.md — Wave 6: Make the chat card a trustworthy mirror of a memory approval: server-owned look, visible change preview, warnings,

### Phase 07.3: Module access per unit (INSERTED)

**Goal**: Admins and leads turn whole modules (Work Zone, AI chats, bots, …) on or off for a department, team or person
from Settings, expressed as resolver deny rules so the UI hides what the API already refuses
**Requirements**: ACCESS-01, ACCESS-02, ACCESS-03
**Depends on:** Phase 7; PR #25 (Agent Channel trigger hardening) merged before any 07.x phase executes
**Research:** done (`OPS-FEATURES.md` F15)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. A module catalog in contracts maps each module to exact permission grains (no admin grains such as `device.revoke`)
  2. A Settings panel creates and removes module rules per unit or person; changes are audited and apply live
  3. Every navigation entry and section (incl. AI chats in the chat sidebar) hides when the module is denied, and the API
     keeps refusing direct calls; tests cover deny-beats-admin and unit inheritance
**Plans:** 4 plans in 3 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [ ] 07.3-01-PLAN.md — Wave 1: Contracts first: `ai_chat.read`, `unit.modules.manage`, the module catalog and the module-access request/response
- [ ] 07.3-02-PLAN.md — Wave 2: Ship `GET` and `PUT /api/v1/module-access` on top of the existing rules table, audit and realtime event, with admin
- [ ] 07.3-03-PLAN.md — Wave 2: Hide every navigation entry and section of a denied module and gate every deep link with an in-place off state,
- [ ] 07.3-04-PLAN.md — Wave 3: Ship the Modules panel (unit card for admins and leads, Settings › Modules for admins), the account-entry gating, and

### Phase 07.4: Per-member connectors, agent keychain and templates (INSERTED)

**Goal**: A shared agent acts with the credentials of the person who asked — each member connects their own MCP, ERP or
CRM account once, sessions refresh themselves, and secrets are used by reference and never seen by the model — and
people start their own agent from a template
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-04, CONN-05, CONN-06
**Depends on:** Phase 07.3, Phase 07.2
**Research:** done (`OPS-FEATURES.md` F1, F2, F3)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. Admins register connectors with an auth mode (`org_secret`, `per_member_oauth`, `per_member_secret`); members
     connect and disconnect their account in Settings; tokens are sealed per member, refresh serialized, and a revoked or
     expired grant asks to reconnect
  2. Agent tool calls to a connector go through an API proxy that uses the requesting member's credential (agent ∩
     human), audited per call; without a connection the agent replies with a "connect your account" card; results from a
     member's account default to DMs (audience rule)
  3. Keychain items (personal or unit scope, host allowlist) are used by handle: the API injects the secret only towards
     allowed hosts, the model never receives it, and every use is audited without the value
  4. Unit-scoped, versioned agent templates instantiate personal agents with their own memory and connections, within the
     personal-agent caps
**Plans:** 14 plans in 5 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [ ] 07.4-01-PLAN.md — Wave 1: Define every shared shape of Phase 07.4 once, in `packages/contracts`, so the API, the web, the plugin mirror and the
- [ ] 07.4-02-PLAN.md — Wave 1: Create the single 07.4 migration with every table and column the phase needs, under the platform's tenant isolation,
- [ ] 07.4-03-PLAN.md — Wave 1: Install the two approved packages and build the public-only, IP-pinned egress guard that every new outbound call of
- [ ] 07.4-04-PLAN.md — Wave 1: Build the fake OAuth-protected MCP server and authorization server that 07.4's integration and e2e tests run against,
- [ ] 07.4-05-PLAN.md — Wave 2: Give the API a spec-correct OAuth 2.1 client for MCP servers and an MCP tool client, both bound to the egress guard,
- [ ] 07.4-06-PLAN.md — Wave 2: Extend the existing MCP server registry (one registry, research Pattern 1) with auth modes and per-member OAuth
- [ ] 07.4-07-PLAN.md — Wave 2: Build the keychain module: storage of agent-usable secrets by reference, the rules that decide when an agent may use
- [ ] 07.4-08-PLAN.md — Wave 2: Let units publish versioned agent templates and let members instantiate them as personal agents within the
- [ ] 07.4-09-PLAN.md — Wave 2: Add the three fixed `ocw_*` tools to the OpenClaw channel plugin as thin, credential-free callers of the Agent Channel
- [ ] 07.4-10-PLAN.md — Wave 3: Implement the connectors module's member side: connect (OAuth and secret), callback, CIMD document, credential
- [ ] 07.4-11-PLAN.md — Wave 3: Decide, per turn and per call, which member-account tools an agent may use where, and give the cell a keychain proxy
- [ ] 07.4-12-PLAN.md — Wave 4: Finish the connector path: the Agent Channel routes that list and call per-member connector tools with the asker's
- [ ] 07.4-13-PLAN.md — Wave 4: Give members and admins the account settings pages of this phase — Connections and Keychain — plus the MCP page's
- [ ] 07.4-14-PLAN.md — Wave 5: Prove Phase 07.4 end to end in a real browser, record its decisions in ADR-0025, document it for operators, and run

### Phase 07.5: Per-tool approvals and Work Zone proposals (INSERTED)

**Goal**: Organizations decide per tool which agent actions need a human first; the human sees the exact action in a
card and approves it once, and agents can propose Work Zone sessions that a person starts with one click
**Requirements**: APPROVE-01, APPROVE-02, APPROVE-03, APPROVE-04
**Depends on:** Phase 07.3, Phase 07.2, Phase 07.4
**Research:** done (`OPS-FEATURES.md` F10, F11)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. A per-tool approval policy (`never | always | when_tainted`, approvers) is decided in the tool gate; only tools with
     a policy send their full arguments to the API
  2. A tool call needing approval posts a card with the exact action (recipient, amount, body…); approving grants exactly
     one call bound to the hash of tool + canonical parameters; any change is denied; all decisions are audited
  3. An agent proposes a Work Zone session (project, device, prompt) as a card; the triggering person with
     `work_session.create` and `device.use` starts it in their name; tainted turns cannot propose, and full access is never
     chosen by an agent
**Plans:** 16 plans in 7 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [ ] 07.5-01-PLAN.md — Wave 1: Contracts first for the whole phase: canonical JSON (RFC 8785), policy and grain contracts, tool-call request and
- [ ] 07.5-02-PLAN.md — Wave 1: Create the storage of the phase: per-tool approval policies, the stored action behind every `tool.call` approval, Work
- [ ] 07.5-03-PLAN.md — Wave 2: Create the `tool-approval` API module's policy half: storage access, the pure strictest-wins resolver, the per-turn
- [ ] 07.5-04-PLAN.md — Wave 2: Make the cell's gate approval-aware without ever waiting for a human: send arguments only for policy tools, let the
- [ ] 07.5-05-PLAN.md — Wave 2: Extract session creation from `POST /work-sessions` into `createWorkSession` so the Work Zone proposal kind (08) starts
- [ ] 07.5-06-PLAN.md — Wave 2: Extend 07.2's approve-and-apply primitive without redesigning it: requester-bound re-runs for grant kinds (the
- [ ] 07.5-07-PLAN.md — Wave 3: Register the `tool.call` grant kind on 07.2's primitive and implement `approvalForCall`, the one decision function the
- [ ] 07.5-08-PLAN.md — Wave 3: Let agents propose Work Zone sessions as approval cards that only the triggering person can start, through the same
- [ ] 07.5-09-PLAN.md — Wave 3: Give admins and leads the screen that decides which bot actions need a person, built on the policy API.
- [ ] 07.5-10-PLAN.md — Wave 3: Give bots the two Work Zone proposal tools in the cell, as credential-free, mode-free callers of the API.
- [ ] 07.5-11-PLAN.md — Wave 4: Wire the approval decision into every agent action route and the turn flags, so policy tools need a person, an approval
- [ ] 07.5-12-PLAN.md — Wave 4: Build the `/approvals` inbox shell with its navigation badge and the Work Zone proposal review, and give the e2e fake
- [ ] 07.5-13-PLAN.md — Wave 5: Add the action review to the `/approvals` shell so approvers decide on the exact call, and prove the approval journey
- [ ] 07.5-14-PLAN.md — Wave 6: Render the two 07.5 linked cards in chat (actions and Work Zone proposals) as faithful, audience-safe mirrors of their
- [ ] 07.5-15-PLAN.md — Wave 7: Prove the phase in the real cell and on one fresh stack, record the decision as ADR-0026, and sign the validation
- [ ] 07.5-16-PLAN.md — Wave 5: Prove, through the real agent-action routes wired in 11, that approvals hold under concurrency, retries, replay and

### Phase 07.6: Automations and watched records (INSERTED)

**Goal**: Agents work on a schedule and on events — signed webhooks and incoming mail create or update threads and board
cards — and they notice when a record changed outside the platform; people get a personal digest and finished Work Zone
sessions feed project memory through the promotion flow
**Requirements**: AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05, AUTO-06
**Depends on:** Phase 07.1, Phase 07.2, Phase 07.3, Phase 07.4, Phase 07.5; since the 2026-10-30 revision also Phase
07.8 (sandbox tools in unattended run turns, D-12) and Phase 07.9 (linked team projects and session audience, D-10, D-11)
**ADR:** 0028 (reserved for this phase; 0027 is reserved for 07.7 and 0029–0033 are taken by 07.8–07.12, D-13)
**Research:** done (`OPS-FEATURES.md` F6, F8, F9, F13)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. A Postgres-backed job scheduler runs automations (standing order + trigger + delivery target by stable IDs + the
     person it runs for + budget), audited, survives restarts, and never runs inside the cell
  2. Signed webhooks (Standard Webhooks) and IMAP mail are triggers; inbound content is untrusted (read-only turns);
     automations can be created from natural language and confirmed in a card
  3. Watched records keep an API-computed hash of an external record's watched fields; on access (and on schedule) a
     change made elsewhere is reported in the card's thread as before → after, without overwriting
  4. A per-person digest (pending decisions, followed cards, unread mentions, Work Zone sessions waiting or finished)
     arrives by DM on that person's schedule
  5. A finished Work Zone session can become a summary proposal in its project's memory (07.2 flow)

**Plans:** 24 plans in 7 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [x] 07.6-01-PLAN.md — Wave 1: Contracts first for the whole phase.
- [x] 07.6-02-PLAN.md — Wave 1: The database half of the phase: one migration, RLS on every table, the ids-only SECURITY DEFINER functions the job
- [x] 07.6-03-PLAN.md — Wave 1: The job runtime the whole phase runs on, after a package legitimacy gate, plus the module wiring later plans rely on.
- [x] 07.6-04-PLAN.md — Wave 1: The fakes the phase tests against (Wave 0): a mail server for IMAP and a "changed elsewhere" ERP for watched records.
- [x] 07.6-05-PLAN.md — Wave 2: The automation entity as a REST resource: CRUD, schedules and time zones, access and target rules, run history, Run
- [x] 07.6-06-PLAN.md — Wave 2: The proactive-delivery primitive: an automation run becomes a cell turn bound to an anchor message and a person, with
- [x] 07.6-07-PLAN.md — Wave 3: Watched records: link a board card to an external record, hash its watched fields in the API, check on access and on
- [x] 07.6-08-PLAN.md — Wave 2: Work Zone sessions feed project memory: the session's unit read from 07.9's linked repositories, the summary job, the system-origin proposal, the per-viewer
- [x] 07.6-09-PLAN.md — Wave 3: The phase's API tracer: scheduled automations actually run — tick, fire, re-decision, budgets, breaker, no-reply,
- [x] 07.6-10-PLAN.md — Wave 5: Signed webhooks as a trigger: endpoint lifecycle inside the automation, the public route with verification, replay
- [x] 07.6-11-PLAN.md — Wave 5: IMAP mail as a trigger: mailbox lifecycle inside the automation, Keychain-only sign-in, pinned TLS connections,
- [x] 07.6-12-PLAN.md — Wave 4: Natural-language creation: the bot proposes, the person confirms in a card (or edits it in the editor), the server
- [x] 07.6-13-PLAN.md — Wave 4: The personal digest: settings, deterministic sections, DM delivery by the chosen bot, optional metered summary,
- [x] 07.6-14-PLAN.md — Wave 5: Compare-and-set writes to watched records through the cell tool, with approvals, conflict reporting and note-back.
- [x] 07.6-15-PLAN.md — Wave 5: The automations UI tracer: Bots › Automations list, editor (schedule trigger), run history and the platform-card
- [x] 07.6-16-PLAN.md — Wave 5: The digest settings page.
- [x] 07.6-17-PLAN.md — Wave 6: Watched records in the browser: link dialog, tile indicator, strip row with Check now, and the change/conflict cards in
- [x] 07.6-18-PLAN.md — Wave 6: The trigger UI: webhook and mailbox panels inside the editor, the What happens section, the secret reveal, and the
- [x] 07.6-19-PLAN.md — Wave 7: The phase gate: release images, the full suite on one stack, CI, documentation, ADR-0028 and the signed validation.
- [x] 07.6-20-PLAN.md — Wave 2: Everything the cell needs for this phase, in one plan: delivering automation runs as turns and the two new tools.
- [x] 07.6-21-PLAN.md — Wave 4: Inbound processing: every webhook or mail item becomes a deterministic post (thread, DM or board card) and, if asked,
- [x] 07.6-22-PLAN.md — Wave 3: The Work Zone → memory UI: the session memory strip and its dialogs; repository linking stays 07.9's.
- [x] 07.6-23-PLAN.md — Wave 6: The natural-language proposal in the browser: the decider-only card, confirm and discard, and Edit → draft editor.
- [x] 07.6-24-PLAN.md — Wave 6: Prove the phase's security properties across all modules and the cell side in a real OpenClaw container.

### Phase 07.7: Agent-to-agent collaboration (INSERTED)

**Goal**: An agent consults or delegates to another agent through the platform, within a permission matrix of who may
message whom, with every hop visible in the thread, audited and bounded
**Requirements**: A2A-01, A2A-02, A2A-03
**Depends on:** Phase 07.3, Phase 07.5; since the 2026-11-02 revision also Phase 07.6 (job runtime, proactive delivery,
self-validated cell tools, taint at start; D-07 … D-12) and Phase 07.8 (hop turns are unattended: sandbox tools under
07.8's rules, never the browser; D-13)
**ADR:** 0027 (reserved for this phase; Proposed in 07.7-02, accepted at the gate 07.7-11, D-16)
**Research:** done (`OPS-FEATURES.md` F7; re-checked against `main` 441a0561 on 2026-11-02)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. `ocw_consult_agent` delivers a question to another agent through the API; the answer returns as a new turn; each
     hop is a visible, attributed thread message audited with a chain id
  2. Effective permission = source agent ∩ triggering human ∩ target visibility ∩ `agent.message` rules (deny wins)
  3. Depth ≤ 2, no agent twice per chain, per-chain budget and daily limits stop loops; the asker pays

**Plans:** 11 plans in 5 waves (UI-SPEC/VALIDATION in the phase folder)

Plans:

- [x] 07.7-01-PLAN.md — Wave 1: Contracts first for the whole phase.
- [x] 07.7-02-PLAN.md — Wave 1: Ledger tables with RLS, loop guards as constraints, chain context on the turn ledger, the expired-hops function and the `consult.tick` queue, the Bots
- [x] 07.7-03-PLAN.md — Wave 2: Make `agent.message` decisions follow D-02 exactly and give admins the two writers of those rules.
- [x] 07.7-04-PLAN.md — Wave 2: Build `POST /agent-channel/v1/consultations` end to end on 07.6's primitives: the self-validated route and the claim, the canonical decision, guards, the question posted with `postAgentMessageIn`, the chain and
- [x] 07.7-05-PLAN.md — Wave 2: Add `ocw_consult_agent`, `agent.consult_reply.v1` handling, the turn-done call and initial taint to the OpenClaw plugin.
- [x] 07.7-06-PLAN.md — Wave 3: Close hops on the turn-done signal, deliver the answer back as `agent.consult_reply.v1` on 07.6's delivery pattern, pin consult turns as valid
- [x] 07.7-07-PLAN.md — Wave 3: Pin OpenClaw's in-cell agent-to-agent off and prove a two-bot consult in a real cell.
- [x] 07.7-08-PLAN.md — Wave 3: Ship the organization switch and the per-bot consult rules in the web app, to the UI contract above.
- [x] 07.7-09-PLAN.md — Wave 4: Time out unanswered hops and cancel orphaned chains, exactly once, per organization, on `core.jobs`.
- [x] 07.7-10-PLAN.md — Wave 4: Render consult hops in threads with live status and Stop, and prove a two-bot consult in the browser.
- [x] 07.7-11-PLAN.md — Wave 5: Gate the phase: the security route table, the release images, full verification on fresh infrastructure, ADR-0027 accepted, docs and the signed

### Phase 07.8: Bot sandboxes, plugins and live browser (INSERTED)

**Goal**: Each bot works in its own isolated sandbox where it can write files, run commands and use plugins that today
are refused, and it can drive a real browser that people watch live in a small floating window and take over to sign
in themselves, so the bot never sees a password; the Control Plane still decides, audits and can stop everything
**Requirements**: SBX-01, SBX-02, SBX-03, SBX-04, SBX-05, BRW-01, BRW-02, BRW-03, BRW-04
**Depends on:** Phase 07.3, Phase 07.4, Phase 07.5
**Research:** needed (OpenClaw native sandbox vs a platform sandbox broker; gVisor/rootless isolation; live view
transport; prior art Steel Browser, neko; `.planning/research/OPS-FEATURES.md` F2 part 2)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. Every bot runs file, shell and plugin tools only inside its own sandbox (no host mounts, no Docker socket, CPU,
     memory, disk and process limits, egress only through the 07.4 policy); one bot can never see another bot's sandbox
  2. Plugins and tools that ADR-0010 refuses today can be installed through the ADR-0011 approval flow when they run
     only inside the sandbox; platform-administration tools stay refused; 07.5 approval policies apply to them
  3. People who may configure a bot browse, download and upload its sandbox files from the bot page
  4. A bot drives a browser in its sandbox; people who can read the conversation watch it live in a floating window,
     and a person with the right can take control, sign in and hand control back; password fields never reach the
     bot, the model or the audit
  5. A signed-in browser session is kept sealed per member and site in the keychain, reused only for that member's
     turns, and revocable; Sandbox and Browser are modules an admin turns on per organization or unit
**Plans:** 30 plans in 9 waves (UI-SPEC/VALIDATION in the phase folder; W1 is the brief's Wave 0: contracts 01 and 30, migration, spikes; revised after the plan check, D-13 added)

Plans:

- [ ] 07.8-01-PLAN.md — Wave 1: Contracts part 01a: the sandbox and sandboxd protocol (incl. site lock and package dependency trees), bot capabilities with the D-13 member-data flags, the turn activity; the phase hub (plan map, shared files, P-01…P-18)
- [ ] 07.8-02-PLAN.md — Wave 1: Create the storage of the phase under tenant RLS, with the owner-only policy on browser sessions, named constraints
- [ ] 07.8-03-PLAN.md — Wave 1: Run the three blocking spikes with throwaway code, record each outcome with evidence and the chosen path, and fill
- [ ] 07.8-04-PLAN.md — Wave 2: Create the `@ocw/sandboxd` workspace package with its Docker client, fixed spec builder, label-scoped lifecycle and
- [ ] 07.8-05-PLAN.md — Wave 2: Create the API `sandbox` module (sandboxd client, availability service, kill switch), the Agent Channel exec route
- [ ] 07.8-06-PLAN.md — Wave 2: Add the 15 confined tools to the OpenClaw channel plugin as static, self-validated, credential-free callers with
- [ ] 07.8-07-PLAN.md — Wave 2: Build the browser container: the stdio agent on `playwright-core@1.63.0`, its redacting snapshot serializer and
- [ ] 07.8-08-PLAN.md — Wave 3: Write `scripts/sandbox-proof.sh` (real cell + real API + real sandboxd + `sbx`), give `scripts/e2e-isolated.sh` the
- [ ] 07.8-09-PLAN.md — Wave 3: Implement the file operations, the `files` helper container, the soft quota, the idle sweeper, usage sampling and the
- [ ] 07.8-10-PLAN.md — Wave 3: Add the bot file and process routes to `agent-channel/sandbox.ts`, the share-to-reply attachment path, and the
- [ ] 07.8-11-PLAN.md — Wave 3: Build the people-facing half of the sandbox module: file routes decided by the resolver, the status DTO, stop and
- [ ] 07.8-12-PLAN.md — Wave 3: Extract the 07.4 classification into `@ocw/egress-policy`, build the `sandbox-egress` proxy as the second entrypoint
- [ ] 07.8-13-PLAN.md — Wave 4: Give `sandboxd` the per-bot browser container and its agent link, the egress container with per-network policy and
- [ ] 07.8-14-PLAN.md — Wave 4: Add the Agent Channel browser routes, the browser module's context service, the turn offering of the browser tools,
- [ ] 07.8-15-PLAN.md — Wave 4: Build the bot page's Sandbox tab (status card, tree, preview, upload, download, delete, stop, restart), extract the
- [ ] 07.8-16-PLAN.md — Wave 5: Build the live-view WebSocket hub, the takeover lease, the privacy filter for takeovers and member sessions, the
- [ ] 07.8-17-PLAN.md — Wave 5: Sandbox packages in `sandboxd`: full dependency-tree review in a throwaway container, install only from the recorded set (`npm ci`, `pip --no-deps --require-hashes`, per-file sha256), removal, and a smoke that refuses a dependency republished after approval
- [ ] 07.8-18-PLAN.md — Wave 4: API sandbox packages on ADR-0011's pinned-approval model: review token bound to the tree hash, stored lockfile, installs at sandbox start, `package_changed_upstream`, risk verdicts, the R12 native-plugin reason
- [ ] 07.8-19-PLAN.md — Wave 5: Build Settings › Sandbox & Browser (organization switch, isolation, limits, network, kill switch) and the module
- [ ] 07.8-20-PLAN.md — Wave 5: Render the server-composed turn activity in chat (collapsed group, steps, live label), the shared `HostChip`, and the
- [ ] 07.8-21-PLAN.md — Wave 6: Build the platform-owned sign-in card, the seal-on-hand-back path, sealed browser sessions per member × site × bot
- [ ] 07.8-22-PLAN.md — Wave 6: Build the desktop live view: provider, socket, frame, header, activity line, small window, large view, takeover with
- [ ] 07.8-23-PLAN.md — Wave 6: Build the Sandbox packages section (list, add dialog, review sheet, row actions) inside Settings › Sandbox & Browser
- [ ] 07.8-24-PLAN.md — Wave 6: Compose profile `sandbox` (sandboxd image gate, control network limited to api and sandboxd, setup token), Woodpecker sandbox smokes plus the real-stack `sandbox-proof` step with env parity, `gate:compose --with-sandbox`
- [ ] 07.8-25-PLAN.md — Wave 7: F-8 and D-13 data flow: downloads routed by session, `ocw_sandbox_import` with the resolver's audience-cover check, the team-bot `member_data` rule, and the requester-approval floor for egress-capable exec after member data
- [ ] 07.8-26-PLAN.md — Wave 7: Build the sign-in card body, the phone live view (dock, full sheet, touch, hidden keyboard, phone viewport, Back),
- [ ] 07.8-27-PLAN.md — Wave 7: Build the Keychain "Browser sessions" section and the bot page's Browser tab on the 21 routes, proven at both widths
- [ ] 07.8-28-PLAN.md — Wave 8: Prove the phase's security properties across every layer: the registry-driven cross-tenant matrix, the API sentinel
- [ ] 07.8-29-PLAN.md — Wave 9: Run the full gate, fix what it finds at the source, write ADR-0029 (incl. D-13, the single shared hop, full-tree pinning, the durable cursor) and the operator and owner docs, update STATUS, AGENTS and CODEOWNERS, sign VALIDATION
- [ ] 07.8-30-PLAN.md — Wave 1: Contracts part 01b, in parallel with 01: browser and live-view protocol, modules and permissions, 07.5 approval hooks (incl. the D-13 `open` action) and agent cards, and the web module maps

### Phase 07.9: Shared Work Zone projects and session visibility (INSERTED)

**Goal**: In a team project every member with access to the project can work in it, and the project decides whether new
Work Zone sessions start public (visible to everyone with project access) or private (only the owner). Any session can
be opened up or narrowed at any time: to everyone with project access, to the project's assigned teams, or to specific
people. Who can see a session is obvious at a glance, with very little visual noise, on desktop and mobile, and every
change of visibility is decided by the permission resolver and audited.
**Requirements**: WZP-01, WZP-02, WZP-03, WZP-04, WZP-05, WZP-06, WZP-07, WZP-08, WZP-09, WZP-10
**Depends on:** Phase 07.8 (merged first); builds on the Work Zone (MVP 2–4), projects and the OrgUnit permission
resolver (ADR-0024).
**Research:** done (`07.9-RESEARCH.md`; UI-SPEC approved)
**UI hint**: yes
**Success Criteria** (what must be TRUE):

  1. A team project is an organization unit with members, assigned teams and linked device repositories; project
     access is its members ∪ the members of its assigned teams ∪ admins; admins and leads create and shape projects per
     ADR-0024, linking a repo needs the device, and every change is audited
  2. Each team project sets whether new sessions start visible to the whole project (on by default); every session has
     exactly one audience (Only me, Project, selected teams, specific people), changed by its creator, project leads or
     admins and never reaching beyond project access; the device owner and admins always see (admin-only views are
     audited); a creator who left keeps read and archive
  3. One resolver rule decides every reader (list, detail, diff, controls, prompts, approvals, attachments, `ws:`,
     proposals, counts), backed by a restrictive RLS policy for user requests; narrowing removes live views and list
     rows within a second
  4. No session data reaches anyone outside its audience over any socket, including stored `org:` history
  5. Existing sessions narrow on purpose (D-06), stated in the migration, ADR-0030 and DEMO.md
  6. The chip, popover, sidebar marker, new-session line and project pages are clear and low-noise at 1440 and 390, in
     light and dark, axe-clean
**Plans:** 15 plans in 7 waves (UI-SPEC/VALIDATION in the phase folder; 05 is the end-to-end tracer, 15 the gate)

Plans:

- [ ] 07.9-01-PLAN.md — Wave 1: Contracts for the whole phase (session audience, team projects, the two grains, realtime events and the revoke cause) and the phase hub (plan map, shared files, P-01…P-15)
- [ ] 07.9-02-PLAN.md — Wave 1: Storage under tenant RLS, the one migration with the deliberate D-06 narrowing and the `org:` history redaction, and the SQL access functions (the single rule)
- [ ] 07.9-03-PLAN.md — Wave 2: Fixture-first: existing API tests that rely on org-wide visibility get explicit access (team project or device share) before the flip
- [ ] 07.9-04-PLAN.md — Wave 2: Team projects API (`/work-projects*`), the `work_project` resource, creator auto-lead, `unit_has_repositories`, `Project.teamProject`
- [ ] 07.9-05-PLAN.md — Wave 3: Phase tracer, the flip: audience precondition, one `sessionFacts`, every reader, list summary, SQL ⇔ TS parity, the narrowing on the suite
- [ ] 07.9-06-PLAN.md — Wave 4: Visibility API (GET/PUT, people, draft preview), audience on create with the project default and the D-13 start rule, proposals, admin audit, `viewerState`
- [ ] 07.9-07-PLAN.md — Wave 4: Per-user session delivery (D-08) with the sentinel, live re-authorization with `cause`, invalidators, realtime client and web list
- [ ] 07.9-08-PLAN.md — Wave 4: Existing e2e journeys under D-06 with explicit access, and the e2e project helpers
- [ ] 07.9-09-PLAN.md — Wave 4: Web labels library, sidebar marker, grouping by team project, home copy
- [ ] 07.9-10-PLAN.md — Wave 5: Web visibility chip, popover, bottom sheet, pickers, footer, access-lost cause, creator-left line (UI tracer)
- [ ] 07.9-11-PLAN.md — Wave 5: Web projects index and project page (Sessions), New project, routing fix, sidebar Projects link
- [ ] 07.9-12-PLAN.md — Wave 5: RLS backstop for user requests, the whole API under it, cross-tenant matrix, list performance at 5,000 sessions
- [ ] 07.9-13-PLAN.md — Wave 6: Web project Settings tab and dialogs, Settings › Organization project sections
- [ ] 07.9-14-PLAN.md — Wave 6: Web new-session dialog: repos grouped under team projects and "Visible to: … · Change"
- [ ] 07.9-15-PLAN.md — Wave 7: Phase gate: full local gate and CI, ADR-0030, DEMO owner checks, STATUS, AGENTS row, CODEOWNERS, signed VALIDATION

### Phase 07.10: Work Zone sidebar by team (INSERTED)

**Goal**: The Work Zone sidebar is organised like the chat sidebar, by team. It scales to many people and many
projects:

- **Sections:** one collapsible section per department, remembered per person. Your own units come first.
- **Projects:** each section lists only the team projects the viewer belongs to (directly or through a team). Each one
  shows a live-session count, and clicking it opens the project page, as clicking a channel opens the channel.
- **Sessions:** only active sessions appear under their project (at most 3, then "+N more").
- **"Needs you":** a section on top gathers the sessions waiting on the viewer's approval or turn, from any project.
- **Personal:** a section at the end holds the viewer's unlinked repositories.
- **"+" buttons:** one per section creates a project there; one per project starts a session in it.
- **Other projects** are reached through "Browse projects".

The sidebar is the same on desktop and in the mobile drawer, and adds very little visual noise.
**Requirements**: WZS-01, WZS-02, WZS-03, WZS-04, WZS-05, WZS-06, WZS-07, WZS-08, WZS-09, WZS-10, WZS-11
**Depends on:** Phase 07.9
**UI hint**: yes (`07.10-UI-SPEC.md` approved)
**Success Criteria** (what must be TRUE):

  1. One collapsible section per department holding the team projects the viewer belongs to (member, through a team,
     or lead), own departments first; collapse is remembered, and a collapsed section keeps what needs the viewer and
     the open session
  2. Project rows open the project page and show a team pill and a live count; at most 3 active sessions under each,
     then "+N more"; settled history stays one click away (a collapsed Settled section, the project page, search)
  3. "Needs you" gathers approvals the viewer can decide and the viewer's finished turns; Personal holds unlinked
     repositories; "+" creates a project where the viewer may and starts a session in a project or repository; every
     other project is reached through Browse projects and search
  4. Two list requests serve the sidebar at any organization size; a project the viewer cannot open is never named on
     any surface (sidebar, tooltips, search, accessible names, the session list, detail and live frames), with
     cross-tenant tests
  5. One component on desktop and in the mobile drawer: 1440 and 390, light and dark, axe-clean, 44 px touch targets,
     arrow-key navigation; existing search, Settled, live status texts and the 07.9 visibility marker keep working
**Plans:** 6 plans in 4 waves (UI-SPEC/VALIDATION in the phase folder; 01 is the hub, 03 the end-to-end tracer, 06 the gate)

Plans:

- [ ] 07.10-01-PLAN.md — Wave 1: Projects index data (parent, top unit, membership; parents' top unit) and the phase hub (plan map, shared files, PD-01…PD-14)
- [ ] 07.10-02-PLAN.md — Wave 1: Session rows per viewer: the 07.9 D-14 leak proven and closed on list, detail, `user:` and `ws:`; `attention`
- [ ] 07.10-03-PLAN.md — Wave 2: Web tracer: the sidebar by department (sections, project rows, sub-rows, Personal, collapse, shared header), existing specs moved
- [ ] 07.10-04-PLAN.md — Wave 3: Needs you and the seen map, Settled in scope, grouped search, sessions-request states, arrow keys
- [ ] 07.10-05-PLAN.md — Wave 3: "+" actions (section, project, repository), onboarding line, projects-request states
- [ ] 07.10-06-PLAN.md — Wave 4: Phase gate: full local gate, full isolated e2e, `gate:compose`, ADR-0031, DEMO owner checks, STATUS, AGENTS, CODEOWNERS, signed VALIDATION

### Phase 07.11: Runtime CLI auto-updates (INSERTED)

**Goal**: The Claude Code and Codex CLIs that the Local Runtime drives stay up to date on every device without anyone
touching it — above all on server-type shared devices (a headless daemon, often Linux, where several members run shared
sessions on the owner's login), and on members' own computers too. Modeled on T3 Code's provider maintenance (studied
from its shipped bundle, 2026-10-28):

- **Install method:** the daemon finds how each CLI was installed and the one command that updates it (native
  `claude update` / `codex update`; npm, pnpm, bun, yarn or Volta global; Homebrew). mise, WinGet or anything unknown is
  "update it with the tool that installed it" — reported, never guessed.
- **Latest and compatible:** the latest version comes from the npm registry; a compatibility manifest (per runtime:
  supported / graceful / unsupported / broken ranges and a recommended range, derived from the adapters' pinned
  fixtures) is bundled in `packages/contracts` and served by our own Control Plane, never fetched from a third party.
  A version the manifest calls broken is never installed.
- **Never interrupts anyone:** an update runs only when that runtime is idle on the device (no turn running); new turns
  for it wait and then start on the new version; long-lived processes (Codex `app-server`) are recycled between turns.
  One update per install lock, 5 min timeout, capped output, then the installed version is verified (succeeded /
  unchanged / failed).
- **Who decides:** an org policy (automatic, default · notify only · off) intersected with a device-local opt-out, like
  Full access. The device owner and admins see each device's runtime versions, compatibility, update status and history
  in Settings › Devices and can press "Update now"; every update (automatic or manual) is audited.
- **Headless first:** everything works from the daemon alone; the desktop app only shows the status.

**Requirements**: RTU-01, RTU-02, RTU-03, RTU-04, RTU-05, RTU-06, RTU-07
**Depends on:** Phase 07.10 (adapters from 03.2, shared devices from 03.2-05)
**Success Criteria** (what must be TRUE):

  1. A device reports, per runtime, the installed version, how it was installed, whether it can update itself and the
     exact update command; unknown or tool-managed installs say so and are never updated
  2. With the policy on automatic, an outdated runtime updates itself on a shared server device while other members'
     sessions on that device keep running: no turn is cut, queued turns start on the new version, and the result is
     verified and audited
  3. A version marked broken in the Control Plane's compatibility manifest is never installed, and a device running an
     unsupported version is flagged where members start sessions on it
  4. The device owner and admins see versions, status and history per device and can update now; members never can;
     the org policy and the device opt-out are honoured and audited
  5. Works on a headless Linux daemon and on macOS; Settings › Devices at 1440 and 390, light and dark

**Plans:** 11 plans in 6 waves (CONTEXT/RESEARCH/PATTERNS/VALIDATION/COVERAGE in the phase folder; 01 is the hub, 09 the end-to-end tracer, 11 the gate)

Plans:
**Wave 1**

- [x] 07.11-01-PLAN.md — Wave 1: Contracts (versions, levels, manifest, statuses, frames, history DTOs, `runtime.update` event), `device.maintain`, and the phase hub (plan map, shared files, PD-01…PD-19)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.11-02-PLAN.md — Wave 2: Storage and the org policy field: one migration (`runtime_updates`, `runtime_maintenance`, `device_runtime_updates`), `CommandKind` `runtime.update`, policy save/audit, RLS
- [x] 07.11-03-PLAN.md — Wave 2: Compatibility at session start: a broken version refuses a start, `runtimeCompatibility` on every device, test-only manifest injection
- [x] 07.11-04-PLAN.md — Wave 2: Daemon maintenance core: install-method resolver (fixed table), registry client (channels, cache), runner (lock, timeout, output, verify), fake CLI
- [x] 07.11-05-PLAN.md — Wave 2: Never interrupt: adapters' `activeTurns` / `retireIdle` / lazy resume, CLI self-updaters off, the per-runtime gate

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.11-06-PLAN.md — Wave 3: API device maintenance: frame handlers, history, audit, Update now, `runtime.config` push, owner/admin-only details
- [x] 07.11-07-PLAN.md — Wave 3: Daemon wiring: the `RuntimeMaintenance` orchestrator, frames, gate on commands, drain and stale, `runtime.update` command, CLI and control socket triggers

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.11-08-PLAN.md — Wave 4: Device-local level (runtime.json, env, `ocw-runtime updates automatic|notify|off`, reload) and the desktop status lines and toggle
- [x] 07.11-09-PLAN.md — Wave 4: Phase end-to-end tracer on the real stack (busy device, held turn, owner view, audit), Update now / member / off, headless Linux proof

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.11-10-PLAN.md — Wave 5: Web: Settings › Devices runtime updates block, Update now, history sheet, member flags, policy select, new-session flag, session line; 1440/390 light/dark

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 07.11-11-PLAN.md — Wave 6: Phase gate: full local gate, full isolated e2e, Linux proof, `gate:compose`, ADR-0032, DEMO owner checks, INSTALL, STATUS, AGENTS, CODEOWNERS, signed VALIDATION

### Phase 07.12: Headless Work Zone server (INSERTED)

**Goal**: Anyone can turn a server (or any spare machine) into a Work Zone device without the desktop app: install the
Local Runtime from their own workspace with one command, pair it from the terminal, run it as a service, check it, and
let members and teams run their shared sessions there.

- **Install from your own server:** `curl -fsSL https://<workspace>/install.sh | sh` fetches the runtime bundle the API
  serves (no third party); Node 24 is required and checked.
- **One setup command:** `ocw-runtime setup` (interactive, or fully by flags for scripts) pairs, names the device,
  registers repositories, installs the service and runs the checks.
- **Pair from a terminal:** `ocw-runtime enroll --server <url>` shows a short code and a link; the owner approves it in
  Settings › Devices. The existing `--code` flow stays.
- **Runs as a service:** `ocw-runtime service install|uninstall|status|logs` (systemd on Linux, user or system unit;
  launchd on macOS), restarts on failure, never a TCP port.
- **Doctor:** `ocw-runtime doctor [--json]` checks Node, pairing, server reachability, Claude Code and Codex installed
  and signed in (headless sign-in instructions), git, projects, the service and the update level.
- **Sharing stays in the web:** the owner shares the device with members and teams as today (03.2-05, 07.9); the CLI
  prints the link.

**Requirements**: HSR-01, HSR-02, HSR-03, HSR-04, HSR-05, HSR-06, HSR-07
**Depends on:** Phase 07.11 (runtime CLI updates on the same daemon)
**Success Criteria** (what must be TRUE):

  1. On a clean Linux server with Node 24, one command installs `ocw-runtime` from the workspace itself, and
     `ocw-runtime setup` leaves a paired device running as a service that survives a reboot and a crash
  2. Pairing works from a terminal without copying a code from the web: the owner approves a short code in Settings ›
     Devices; codes expire, are single-use and rate-limited, and every approval is audited
  3. `ocw-runtime doctor` reports every prerequisite with a fix line, in text and `--json`, and never prints a secret or
     sends an absolute path to the server
  4. Members the owner shares the device with start and run sessions on it from the web, with no desktop app anywhere
  5. Proven in a Linux container end to end (install script → setup → session from the web) and documented in
     `docs/SERVER.md`; macOS launchd covered by unit tests

**Plans:** 11 plans in 5 waves (CONTEXT/RESEARCH/VALIDATION/COVERAGE in the phase folder; 01 is the hub, 09 the end-to-end tracer, 10 the container proof, 11 the gate)

Plans:
**Wave 1**

- [x] 07.12-01-PLAN.md — Wave 1: Contracts (dist manifest, device-code pairing, enroll answer fields), the self-contained bundle (esbuild, SDK external), `ocw-runtime version`, local records, and the phase hub (plan map, shared files, PD-01…PD-19)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.12-02-PLAN.md — Wave 2: API device-code pairing: Redis pending request, `device.pair` approval, `enrollWithCodeHash`, RFC 8628 answers, limits, audit, org B
- [x] 07.12-03-PLAN.md — Wave 2: CLI terminal pairing (`enroll --server` without a code), `remove-project <dir|name|id>`, `~/.ocw/service.env` read by the daemon (D-12)
- [x] 07.12-04-PLAN.md — Wave 2: Service module: systemd user/system units, launchd LaunchAgent, injected exec with the test guard, one runtime owner per `~/.ocw`
- [x] 07.12-05-PLAN.md — Wave 2: Doctor module: every D-05 check with a fix line, headless sign-in lines, text and JSON, safe to paste

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.12-06-PLAN.md — Wave 3: API distribution: `/api/v1/runtime/{install.sh,bundle,bundle.sha256,version}`, `install.sh` (SDK from npm beside the bundle), the image stage, the compose-gate check
- [x] 07.12-07-PLAN.md — Wave 3: Web: Add a device › Server tab, the `?pair=` approve dialog, login keeps `?pair=`; 1440/390 light/dark
- [x] 07.12-08-PLAN.md — Wave 3: `ocw-runtime setup` and the `service` and `doctor` CLI commands

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.12-09-PLAN.md — Wave 4: Phase end-to-end tracer: install.sh from the API → setup → web approval → bundled daemon → shared with a member and a team project → the member's sessions
- [x] 07.12-10-PLAN.md — Wave 4: Opt-in Linux container proof (pinned slim `node:24` + curl git ca-certificates): the whole chain, doctor JSON, no-systemd refusal

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.12-11-PLAN.md — Wave 5: Phase gate: full gate, container proof, `gate:compose`, `docs/SERVER.md`, INSTALL, DEMO owner checks, STATUS, AGENTS, CODEOWNERS, ADR-0033, signed VALIDATION

### Phase 07.16: Bot Work Zone orchestration (INSERTED)

**Goal**: A bot runs Work Zone sessions itself: its profile says on which device or server, in which projects, with which
runtime, model and permission mode (bypass included, through ADR-0012's chain); it starts sessions, sends them prompts,
reads their output and keeps orchestrating until they finish or need help, and the conversation shows a live card that
opens the session and comes back.

- **Profile:** per bot, set by its owner (personal) or a lead/admin (team); the device owner consents per bot; caps on
  projects, model, options and mode; bypass only when organization policy ∩ device opt-in ∩ profile allow it.
- **Control:** `ocw_*` tools to start, prompt, read and stop, decided in the Agent Channel API; humans keep prompting
  the same session; one executor.
- **Wake-ups:** session transitions (turn done, waiting for approval, failed, ended) wake the bot in the originating
  conversation, bounded by the profile; the wake runs as the original asker (D-17).
- **Outside content (owner decision 2026-11-09, option 1):** from a tainted turn only with the admin-only "act on outside
  content" profile flag, and bypass then only on a device marked as an isolated server; otherwise the proposal card.
- **Card:** live Work Zone card in the conversation, back link from the session; desktop and mobile.

**Requirements**: BWZ-01, BWZ-02, BWZ-03, BWZ-04, BWZ-05, BWZ-06
**Depends on:** Phase 07.5 (proposals, taint), Phase 07.12 (shared Work Zone projects), ADR-0012 (bypass chain), ADR-0033 (headless servers)
**ADR:** 0038 (supersedes the bot-start clauses of ADR-0026 and the "seeing is not controlling" clause of ADR-0030 for bots)
**Success Criteria** (what must be TRUE):

  1. An admin gives a team bot a profile (a headless server, two projects, Claude Code, a model, bypass allowed by the
     org and opted in on that server for this bot); in a channel a member asks the bot to fix something and the bot
     starts the session there without anyone pressing Start
  2. The bot sends follow-up prompts, reads the output, and when the session finishes it reports in the thread and
     mentions the asker; when the session waits for an approval it mentions the people who can approve
  3. The thread shows a live card (status, current step, Open); Open goes to the session and its back link returns to
     the thread; desktop 1440 and mobile 390
  4. From a turn that read an MCP result the bot starts only if "act on outside content" is on, and in bypass only on
     an isolated server; otherwise it posts today's proposal card; every action is audited without prompt content
  5. A bot without a profile behaves exactly as today; integration tests, tenant isolation tests and an e2e spec
     (fake runtime) pass; ADR-0038 records the decisions

**Plans:** 22/22 plans complete

Plans:
**Wave 1**

- [x] 07.16-01-PLAN.md — Wave 1: Bot-facing contracts (four `ocw_work_session_*` tools, `TurnContext.workZone`, refusals and sentences, redacted read model, `agent.work_session.v1`, profile/consent views, card helpers), the plugin mirror, and the phase hub (plan map, shared files, PD-01…PD-30)
- [x] 07.16-02-PLAN.md — Wave 1: Control-plane contracts: `bot_profile` denial reason, device host kind and isolated server, prompt/session agent and taint fields, per-viewer origin, org bot-session cap, `AgentControlsLayer`
- [x] 07.16-03-PLAN.md — Wave 1: The one additive migration (profiles, profile projects, consents, bot session side table, agent/taint/device/policy/turn columns), RLS backstop, `work_session.bot_sync` queue, upgrade proof
- [x] 07.16-04-PLAN.md — Wave 1: ADR-0038 (Accepted; supersedes the quoted ADR-0026/0030/0028 clauses for bots) and AGENTS.md rows

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.16-05-PLAN.md — Wave 2: Device facts end to end: `ocw-runtime isolated-server`, host kind, hello/capabilities → hub → `GET /devices`; FakeDevice turn/approval helpers
- [x] 07.16-06-PLAN.md — Wave 2: The agent layer in the one controls context and `createWorkSession({ agent })` / `queueWorkPrompt` agent author and taint
- [x] 07.16-07-PLAN.md — Wave 2: Profile and consent API (`bot-profile.ts`, `profileStatus`, admin-only outside-content flag, device-owner/admin consent, org cap)
- [x] 07.16-08-PLAN.md — Wave 2: Plugin tools `ocw_work_session_start|prompt|read|stop`, guard sets (route decides taint, session-output mark), turn scoping, manifest
- [x] 07.16-09-PLAN.md — Wave 2: Plugin wake event and the "Your Work Zone" / "Work Zone session update" blocks

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.16-10-PLAN.md — Wave 3: Per-turn dispatch under the bot's cap, `bot_not_allowed`, agent-aware re-authorization, `submitWorkPrompt`/`archiveWorkSession` extraction
- [x] 07.16-11-PLAN.md — Wave 3: The turn offer (`workZoneOfferFor`, four turn-scoped tools, `workZone`); bots without a profile byte-identical
- [x] 07.16-12-PLAN.md — Wave 3: Web: the bot sheet's Work Zone profile section
- [x] 07.16-13-PLAN.md — Wave 3: Web: device bot consents, the Isolated server fact, "Bot sessions at once"
- [x] 07.16-14-PLAN.md — Wave 3: Real-cell smoke `bot_work_sessions`

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.16-15-PLAN.md — Wave 4: The start route as the sponsor (caps, audience, live card, claim options, D-20 start rule): the phase's API end to end

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.16-16-PLAN.md — Wave 5: Prompt and stop routes; own sessions only; people keep control
- [x] 07.16-17-PLAN.md — Wave 5: The redacted read route and the session-output flag
- [x] 07.16-18-PLAN.md — Wave 5: Back link (per-viewer origin), agent author and taint marks, the live Work Zone card in chat

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 07.16-19-PLAN.md — Wave 6: Outside content: admin-flag path, isolated-only bypass, sticky taint, the proposal fallback
- [x] 07.16-20-PLAN.md — Wave 6: Wake-ups and card refresh (`setStatus` hook → `work_session.bot_sync` → card + `agent.work_session.v1`)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 07.16-21-PLAN.md — Wave 7: The browser journey e2e (fake cell, fake runtime, desktop 1440 and mobile 390, light and dark)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 07.16-22-PLAN.md — Wave 8: Phase gate: every CI workflow green, README/DEMO/STATUS/SERVER, CODEOWNERS and guard, signed VALIDATION

### Phase 07.17: Automation fan-out and team mentions (INSERTED)

**Goal**: An automation watches a source (for example new orders through an MCP every 10 minutes) and, for each new item,
opens its own conversation (a thread in a channel or a card on a board), where the bot reads the context, works in the
Work Zone through its 07.16 profile, moves the card through the columns and mentions a team or a person when it finishes
or needs help.

- **Schedule:** minimum interval 5 minutes.
- **Fan-out:** one run opens one conversation per new item, capped per run, deduplicated by the item's external id; each
  conversation gets its own bot turn with the item as untrusted content.
- **Board:** the bot moves and sets waiting on every card its automation opened.
- **Team mentions:** `@team` (org unit by stable id) notifies its members who read the conversation; for people and bots.

**Requirements**: AFO-01, AFO-02, AFO-03, AFO-04, AFO-05
**Depends on:** Phase 07.16, Phase 07.10 (automations), Phase 07.1 (boards)
**ADR:** 0039
**Success Criteria** (what must be TRUE):

  1. An automation every 10 minutes reads a fake orders MCP; two new orders open two cards on a board; the next run
     opens none for the same orders
  2. In each card the bot reads the order's documents, starts a Work Zone session through its profile, moves the card
     to a started column, and to done (or waiting) at the end
  3. On finish or when it needs help the bot mentions a team; its members who read the board get a notification
  4. Integration tests (dedupe, caps, tenant isolation, team mention audience) and an e2e spec pass on desktop and mobile;
     ADR-0039 records the decisions

**Plans:** 19/19 plans complete

Plans:
**Wave 1**

- [x] 07.17-01-PLAN.md — Wave 1: Contracts (`ocw_conversation_open` request/answer, fan-out and escalation settings, `agent.automation_item.v1`, `MessageMention` with `unit`, `unitHandle`, `team_mention`), the plugin mirror, and the phase hub (plan map, shared files, PD-01…PD-26)
- [x] 07.17-02-PLAN.md — Wave 1: The one migration (`automation_conversations`, fan-out columns, `org_units.handle` backfill, `notifications.unit_id`, caps 5 min / 288 in DB and code), RLS, the `automation.item` queue, upgrade proof
- [x] 07.17-03-PLAN.md — Wave 1: ADR-0039 (Accepted; supersedes the quoted ADR-0028/0022/0038 clauses), AGENTS.md row, COVERAGE.md

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.17-04-PLAN.md — Wave 2: Every 5 minutes in the editor (interval presets, summary, runs-a-day prefill, daily-limit warning), self-hosting limits
- [x] 07.17-05-PLAN.md — Wave 2: Fan-out and escalation settings on automations, the "<name> · Runs" thread, run `opened` counts
- [x] 07.17-06-PLAN.md — Wave 2: Unit handles generated once in the organization API, `reach` and `viewerInReach`
- [x] 07.17-07-PLAN.md — Wave 2: Team mentions resolve on channel posts (people and bots, ≤ 3 teams per bot message), never in DMs/AI chats, never to the cell
- [x] 07.17-08-PLAN.md — Wave 2: Bots move and set waiting on the cards their automation opened (D-06, D-12)
- [x] 07.17-09-PLAN.md — Wave 2: Plugin: the `ocw_conversation_open` tool and the board/open guard rules
- [x] 07.17-10-PLAN.md — Wave 2: Plugin: item turns, the fan-out instruction and the escalation sentence

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.17-11-PLAN.md — Wave 3: The fan-out offer on run turns (`conversationOpen`, `automationRun.fanOut`, escalation)
- [x] 07.17-12-PLAN.md — Wave 3: Team mention notifications (subtree ∩ readers, ≤ 200, `team_mention`, inbox `unit`)
- [x] 07.17-13-PLAN.md — Wave 3: Web: `@team` in the composer, chips, reach confirmation, inbox label, handles on the organization page
- [x] 07.17-14-PLAN.md — Wave 3: Web: the editor's "For each new item" and "When it needs people" sections, run history counts
- [x] 07.17-15-PLAN.md — Wave 3: Real-cell smoke `automation-fan-out`

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.17-16-PLAN.md — Wave 4: The open route `POST /agent-channel/v1/conversations/open` (dedupe, caps, races, taint, audit): the phase's API end to end

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.17-17-PLAN.md — Wave 5: One child turn per opened item (`automation.item` worker, `agent.automation_item.v1`, 07.16 Work Zone tools) and the per-order API journey

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 07.17-18-PLAN.md — Wave 6: The browser journey e2e (fake orders MCP → cards → Work Zone → moves → @team; desktop 1440 and mobile 390, light and dark)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 07.17-19-PLAN.md — Wave 7: Phase gate: every CI workflow green, README/DEMO/STATUS, CODEOWNERS and guard, signed VALIDATION

### Phase 07.17.1: Runtime self-update from the browser: one click in Settings › Devices updates a headless server's OCW runtime to the version the workspace serves (bundle verified, idle gate, service restart) (INSERTED)

**Goal:** In Settings › Devices a headless server's OCW Local Runtime updates to the build its workspace serves with one
click (owner or admin, `device.maintain`), and by itself at the device's effective 07.11 level (`off` keeps the click),
never cutting a running turn, verifying every download (bundle and lockfile against the manifest) and restarting through
systemd or launchd; a failure keeps the running version and the doctor names an update that did not come back.
**Requirements**: RSU-01, RSU-02, RSU-03, RSU-04, RSU-05, RSU-06, RSU-07, RSU-08
**Depends on:** Phase 07.17
**ADR:** 0040
**Plans:** 11/11 plans executed

Plans:
**Wave 1**

- [x] 07.17.1-01-PLAN.md — Wave 1: Contracts (`RuntimeUpdateTarget`, builds, strict `self`, `served`, refusals) and the phase hub (plan map, PD-01…PD-27, edges E1–E30)
- [x] 07.17.1-02-PLAN.md — Wave 1: ADR-0040, AGENTS.md row, runtime version 0.3.1 and the release tag check
- [x] 07.17.1-03-PLAN.md — Wave 1: API distribution: `GET /api/v1/runtime/npm-shrinkwrap.json`, `runtimeExternalFiles`, one shared dist store, `servedRuntime()`

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.17.1-04-PLAN.md — Wave 2: The one migration (`ocw-runtime` in the CHECK, `from_build` / `to_build`, `HEAD_ONLY`)
- [x] 07.17.1-05-PLAN.md — Wave 2: Daemon prepare and switch (verified download, fixed `npm ci`, staging, atomic `current`, marker), fake npm, harness
- [x] 07.17.1-06-PLAN.md — Wave 2: Web: the Runtime row in Settings › Devices (every view, own test ids) and the held-turn line

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.17.1-07-PLAN.md — Wave 3: Supervision (D-12), running build, boot reconcile and prune, doctor findings
- [x] 07.17.1-08-PLAN.md — Wave 3: The self-update job: one idle decision across runtimes, exclusion with 07.11, levels and cadence
- [x] 07.17.1-09-PLAN.md — Wave 3: The API route and DTO (preconditions, audit with builds, abandoned runs, held prompts survive the restart): the phase's API end to end

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.17.1-10-PLAN.md — Wave 4: Daemon wiring (command, snapshot `self`, boot frames, exit 75, CLI hook): the phase's device end to end

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.17.1-11-PLAN.md — Wave 5: Phase gate: e2e views with axe, docs and v0.3.1 notes, CI evidence, the owner's Server-1 UAT (blocking)

### Phase 07.17.1.1: Bot file exchange with its Work Zone sessions: upload chat attachments into the session's working tree and download session files back to the chat as attachments (INSERTED)

**Goal:** A bot that started a Work Zone session moves files between that session and the conversation it started it
from: it uploads an attachment of the thread into the session's working tree and downloads a file of the session back to
the conversation as an attachment people open and download, each bounded by a per-file limit the organization and the
bot's profile configure (the lower wins), decided server-side, audited, and never sending an absolute path.

- **Tools:** `ocw_work_session_upload` and `ocw_work_session_download`, offered with the four 07.16 tools, all or none.
- **Transport:** commands carry no bytes; files stream over `/api/v1/runtime/files/:transferId` with the device token.
- **Rules:** origin conversation only; uploads only while the session is idle; one deny list (`.git`, `.claude`,
  `.codex`, `.mcp.json`, `.ocw-worktrees`, secrets) both ways; 5 files per turn each way; the hourly prompt budget.

**Requirements**: BWF-01, BWF-02, BWF-03, BWF-04, BWF-05, BWF-06, BWF-07, BWF-08
**Depends on:** Phase 07.17.1 + PR #71 merged into main
**ADR:** 0041
**Success Criteria** (what must be TRUE):

  1. A bot uploads a thread attachment into the session it started and the file shows in the session's changes; a
     file outside the turn's reach, above the limit or at a denied path never moves
  2. A bot downloads a session file; its reply carries it and people download it
  3. "Largest file a bot moves" (organization) and "Largest file" (bot) are configurable; the lower wins and refusals
     name it
  4. Integration tests (containment, transport, caps, taint, tenant isolation) and an e2e spec pass on desktop and
     mobile; ADR-0041 records the decisions

**Plans:** 15/15 plans executed

Plans:

- [x] 07.17.1.1-01-PLAN.md — Wave 1: Contracts and the plugin mirror (tools, path rule, deny list, limits, device commands) + the phase hub
- [x] 07.17.1.1-02-PLAN.md — Wave 1: ADR-0041 and the AGENTS.md row
- [x] 07.17.1.1-03-PLAN.md — Wave 2: The migration (limit columns, transfer ledger, hourly load)
- [x] 07.17.1.1-04-PLAN.md — Wave 2: The daemon (containment, `session.file.read|write`, transfer requests, bounded diff frame)
- [x] 07.17.1.1-05-PLAN.md — Wave 2: The plugin (two tools, guard sets, Work Zone block line, real-cell smoke)
- [x] 07.17.1.1-06-PLAN.md — Wave 3: The limits in the API (policy and profile, `loadBotFileLimit`)
- [x] 07.17.1.1-07-PLAN.md — Wave 3: Transfer read side (device JWT auth, ledger primitives, `GET /api/v1/runtime/files/:transferId`)
- [x] 07.17.1.1-08-PLAN.md — Wave 4: Transfer write side (multipart storage, `PUT …/:transferId`, pre-claim refusals)
- [x] 07.17.1.1-09-PLAN.md — Wave 4: Web: "Largest file a bot moves" and the profile's "Largest file"
- [x] 07.17.1.1-10-PLAN.md — Wave 4: The offer of six tools with the file limit; shared route helpers
- [x] 07.17.1.1-11-PLAN.md — Wave 5: The work-session file service (prepare, wait, finish, caps, audit, injectable deadline)
- [x] 07.17.1.1-12-PLAN.md — Wave 6: The upload route (the phase's API end to end, upload) and its own refusals
- [x] 07.17.1.1-13-PLAN.md — Wave 7: The download route and the refusal matrix both tools share
- [x] 07.17.1.1-14-PLAN.md — Wave 8: The browser journey e2e (upload, download, limit refusal; desktop and mobile)
- [x] 07.17.1.1-15-PLAN.md — Wave 9: Docs, guard, proxy body check and the phase gate (signed VALIDATION)

### Phase 07.17.1.1.2: Long-running bot tasks: a bot keeps working across turns on its own (bounded, visible, stoppable) and is woken when its sandbox processes finish (INSERTED)

**Goal:** A bot takes on a request that needs many turns and keeps working on it by itself until it is done, without a
person re-prompting: it starts a task, the platform delivers its next turn in the same thread, it is woken when its long
sandbox processes or its Work Zone sessions finish (or after a timer), it reports progress on a live task card people
can stop, and budgets (turns, hours, running tasks, the daily limit) stop it so it never runs away. No more "no tengo
ejecución en segundo plano".

- **Tools:** `ocw_task_start`, `ocw_task_continue`, `ocw_task_finish` (not side-effecting, outside the 8 calls).
- **Scheduling:** the API only (`bot_task.continue`, derived event ids, the turn-done release, a minute tick); OpenClaw
  cron and heartbeat stay off; every turn re-decided as the person who asked, taint sticky, no browser.
- **Visible and bounded:** a platform task card with Stop; one progress message per 5 turns or 10 minutes; Settings ›
  Bot policy "Long tasks" (40 turns, 8 h, 10 running by default); AI chats out.

**Requirements**: BTASK-01, BTASK-02, BTASK-03, BTASK-04, BTASK-05, BTASK-06, BTASK-07, BTASK-08, BTASK-09, BTASK-10, BTASK-11
**Depends on:** Phase 07.17.1.1; runs after Phase 07.17.1.1.1 on the same branch (`feat/0.3.2-bot-files-and-long-tasks`)
**ADR:** 0042
**Success Criteria** (what must be TRUE):

  1. Asked for a job that needs many turns, a bot starts a task and keeps working in the thread by itself until it
     finishes or is blocked; nobody re-prompts it and it never claims background work it has not scheduled
  2. Its long sandbox commands and its Work Zone sessions wake it when they finish; it can wait on a timer
  3. A live task card shows the goal, status, turns used of max, elapsed time and the last progress; the person it runs
     for, the thread's moderators and the bot's managers can Stop it, and stopping is immediate
  4. Budgets stop a task with one message mentioning the person; Settings › Bot policy has "Long tasks" and its limits;
     the bot's capabilities show it
  5. Integration tests (single delivery, budgets, safety, tenant isolation), the cell smoke and an e2e spec pass on
     desktop and mobile; ADR-0042 records the decisions

**Plans:** 14/14 plans executed

Plans:

- [x] 07.17.1.1.2-01-PLAN.md — Wave 1: Contracts and the plugin mirror (tools, bodies, `TurnTask`, `agent.task.v1`, task card, sandboxd `process` event) + the phase hub
- [x] 07.17.1.1.2-02-PLAN.md — Wave 1: ADR-0042, the AGENTS.md row in place, the BTASK requirements
- [x] 07.17.1.1.2-03-PLAN.md — Wave 1: The migration (`bot_tasks`, `bot_task_processes`, `task_id` columns, policy limits, card kind, tick lister, two queues)
- [x] 07.17.1.1.2-04-PLAN.md — Wave 2: Policy and capability ("Allow long tasks", limits, `loadTaskPolicy`, Settings and the capabilities row)
- [x] 07.17.1.1.2-05-PLAN.md — Wave 2: The plugin (three tools, gate, bridge quiet/done, "Your task" block, persona paragraph)
- [x] 07.17.1.1.2-06-PLAN.md — Wave 3: The real-cell smoke (scenario `bot_tasks`, every scenario's tool lists)
- [x] 07.17.1.1.2-07-PLAN.md — Wave 3: The offer (`taskOfferFor`, the `task` trigger, task tools, `turn.task`, ledger link)
- [x] 07.17.1.1.2-08-PLAN.md — Wave 4: The cell routes and Stop (state machine, card, org cap, audit; the phase's API end to end, start)
- [x] 07.17.1.1.2-09-PLAN.md — Wave 5: The continuation (three transactions, turn-done hook, tick, budgets, nudge, safety; API end to end, continuation)
- [x] 07.17.1.1.2-10-PLAN.md — Wave 5: The card's task link, `viewerCan.stop` and the web task card with Stop
- [x] 07.17.1.1.2-11-PLAN.md — Wave 6: Sandbox process wake-ups (fake and real sandboxd `process` event → tolerant consumer → task)
- [x] 07.17.1.1.2-12-PLAN.md — Wave 6: Work Zone session wake-ups (`bot_work_sessions.task_id`, the wake as a task turn)
- [x] 07.17.1.1.2-13-PLAN.md — Wave 7: The browser journey e2e (fake cell task tools; desktop and mobile, axe)
- [x] 07.17.1.1.2-14-PLAN.md — Wave 8: Docs and v0.3.2 notes, guard (Semgrep rule, CODEOWNERS), security walk, phase gate and owner UAT

### Phase 07.17.1.1.1: Sandbox document toolkit: bots read PDFs (incl. scanned, OCR), images, Office files and archives with tools baked into the sbx image (INSERTED)

**Goal:** A bot reads, converts and searches the files people give it inside its own sandbox without installing
anything: PDFs with a text layer, scanned PDFs and images (OCR in Spanish and English), Word, Excel, PowerPoint and
OpenDocument files, CSV/JSON/XML/HTML, e-mails and archives, through a toolkit baked into the `sbx` image at build
time and one helper, `ocw-extract`, that prints bounded UTF-8 text of any supported file and reads whole folders in
resumable chunks; the bot is told the toolkit exists, and existing bots get it at their sandbox's next start.

- **Toolkit:** poppler, qpdf, tesseract eng+spa, LibreOffice nogui (finalized no-macro config), ImageMagick with an
  allow-list policy, 7zip, exiftool, catdoc, unrtf, msgconvert; a hash-locked Python venv at `/opt/ocw-tools`.
- **Rules:** Debian bookworm `main` only, wheels with hashes, licenses guarded, packages approved before merge on
  scripted evidence; the
  egress proxy and package approval flow unchanged; everything runs as 10001 inside the sandbox limits.

**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04, DOC-05, DOC-06, DOC-07, DOC-08, DOC-09
**Depends on:** Phase 07.17.1.1
**ADR:** 0043
**Success Criteria** (what must be TRUE):

  1. Through sandboxd as 10001, on runc and gVisor, `ocw-extract` returns the text of a scanned PDF (OCR), a text PDF,
     a Spanish PNG, docx, xlsx, pptx, odt, an e-mail and a zip listing; stdout fits the 16 KiB tail
  2. `ocw-extract --batch` mirrors a folder or archive into `.txt` files and an index under /workspace without
     touching the originals and resumes in chunks under 600 s (exit 75 until done); archive bombs, traversal and
     links are refused
  3. A document macro never runs under conversion (with a positive control or a stated configuration-only proof);
     ImageMagick refuses PS/PDF/URL/MSL/TEXT; no gs, Java, Firebird or GStreamer; the image stays ≤ 1300 MiB
  4. A stopped bot shell on an old image or environment is re-created with its volumes; a running one is never cut
  5. The bot's exec tool and attachments how-to name the toolkit; ADR-0043 records the decisions and the
     LibreOffice residual risk; the owner's UAT: Gertru reads the knowledge pack's 589 PDFs, scans included

**Plans:** 7/7 plans executed

Plans:

- [x] 07.17.1.1.1-01-PLAN.md — Wave 1: The image: Debian toolkit, ImageMagick policy, LibreOffice finalized config, image tests in CI, `SHELL_ENV` (+ the phase hub)
- [x] 07.17.1.1.1-02-PLAN.md — Wave 1: The Python supply chain: hash lock, license records, guard for Python locks, scripted pre-install evidence (age ≥ 14 days, yanked, OSV, legitimacy, closure)
- [x] 07.17.1.1.1-03-PLAN.md — Wave 2: The venv layer and `ocw-extract` (every type, OCR, bounds, batch with resume and archive caps; TDD in the image)
- [x] 07.17.1.1.1-04-PLAN.md — Wave 2: sandboxd re-creates a stopped shell on image or env drift (fake Docker)
- [x] 07.17.1.1.1-05-PLAN.md — Wave 3: Real-Docker smokes: `docs` through sandboxd on runc and gVisor (the phase end to end), the macro control, `drift`
- [x] 07.17.1.1.1-06-PLAN.md — Wave 3: The bot is told (exec tool description, attachments clause)
- [x] 07.17.1.1.1-07-PLAN.md — Wave 4: ADR-0043, requirements, AGENTS.md row, docs, v0.3.2 notes, signed VALIDATION, phase gate with the supply-chain approval before merge (blocking, on evidence) and the owner's UAT

### Phase 07.13: Work Zone local browser (INSERTED)

**Goal**: A Work Zone session can use a browser, the way bots can, but on the session's own device: Claude Code and
Codex open pages (including the device's own `localhost` dev servers), read them, click, type and take screenshots,
while everyone who can see the session watches it live in the web. Teams already running OCW get it by upgrading,
with no manual step on any device.

- **On the device, not the server:** the Local Runtime starts an isolated Chromium (its own throwaway profile per
  session, never the user's real browser or cookies) on the machine that runs the session, desktop app or headless
  server, so it reaches `localhost` and the device's network.
- **One tool set for both runtimes:** the runtime exposes the browser to Claude Code (Agent SDK) and Codex
  (app-server) as the same tools, normalized at the adapter edge; nothing outside the adapter depends on either.
- **Governed like the bots' browser (ADR-0029) where it applies:** org policy ∩ device opt-in decides it, per-tool
  approvals apply, every navigation and action is audited, and page content is treated as untrusted input.
- **Live view:** the session's audience sees the page (frames) in the session view; no absolute path and no cookie
  leaves the device.
- **Delivered by the upgrade:** `ocw upgrade` on the server is enough on the server side; the runtime fetches a pinned,
  checksum-verified browser build by itself the first time it is needed; headless runtimes update their own bundle from
  the workspace under the runtime updates level (07.11), and the desktop app tells its user when a newer app is out.

**Requirements**: WZB-01, WZB-02, WZB-03, WZB-04, WZB-05, WZB-06, WZB-07
**Depends on:** Phase 07.12 (headless runtime, served bundle), Phase 07.8 (browser governance), Phase 07.11 (updates level)
**ADR:** 0035
**Success Criteria** (what must be TRUE):

  1. In a Work Zone session on a desktop device and on a headless server, Claude Code and Codex can open a page served
     on the device's `localhost`, read it, act on it and return a screenshot, through the same browser tools
  2. The browser is off unless the organization's policy and the device both allow it; each navigation and action is
     audited without page content, absolute paths or cookies, and per-tool approval rules apply to the browser tools
  3. Each session gets a fresh, isolated browser profile that is deleted when the session ends; the user's own browser
     profile and cookies are never read
  4. Everyone in the session's audience sees the browser live in the session view (light/dark, 1440 and 390 widths)
  5. A team on `v0.2.x` that runs `ocw upgrade` gets the feature with no manual step on headless devices (the runtime
     updates itself and fetches the pinned browser on first use, checksum-verified), and desktop users are told a new
     app version is available; an older runtime shows a clear "update this device" state instead of failing
  6. Proven by an e2e spec (fake runtime driving the real local browser against a local page) and a container proof on
     the headless runtime; documented in `docs/SERVER.md`, the README and ADR-0035

**Plans:** 0 plans

Plans:

- [ ] TBD (run /gsd-plan-phase 07.13 to break down)

### Phase 07.14: Organization connector auth (INSERTED)

**Goal**: An admin can register any MCP server whatever its authentication, and give the organization's bots one shared
account on it: sign in once with OAuth for the whole organization, or use OAuth client credentials, besides the
existing organization headers, member sign-in and member keys. When OAuth cannot work, the admin sees which step failed
and how to fix it.

- **Organization sign-in (OAuth):** an admin with `mcp.manage` connects the server once (authorization code + PKCE,
  the existing per-issuer client choice); the organization's bots use that account everywhere organization secrets
  apply. The token is sealed for the organization and connector, refreshed by the API and never reaches the cell.
- **Client credentials (OAuth, machine to machine):** client id and secret, token endpoint discovered from the server
  (or entered), scopes and RFC 8707 `resource`; tokens fetched and refreshed by the API.
- **Diagnosis:** the dialog and the server row say which OAuth step failed (discovery, issuer, PKCE, client
  registration, HTTPS, token exchange) with one fix line, and give the redirect URI and client metadata URL to copy.
- **Same custody and audit as member connectors (ADR-0025):** sealed in `app.secrets`, serialized refresh, reconnect
  states, revocation on disconnect, every connect/disconnect/use audited, egress guard on every request.

**Requirements**: COA-01, COA-02, COA-03, COA-04, COA-05
**Depends on:** Phase 07.4 (connectors, OAuth client, custody)
**ADR:** 0036
**Success Criteria** (what must be TRUE):

  1. An admin adds an OAuth-only MCP server in organization sign-in mode, connects it once, and a bot in any channel
     calls its tools with that account; members never see or handle the token
  2. A server that only offers client credentials works with a client id and secret, including refresh before expiry
  3. Disconnect revokes at the provider; an expired or revoked grant shows "Reconnect" to admins and the bot's tool
     fails with a clear reason; switching mode or deleting the server destroys the stored credential after a confirmation
  4. When a sign-in cannot start or finish, the admin sees the failed step and a fix line; nothing secret is shown
  5. Existing servers (organization headers, member sign-in, member keys) behave exactly as before; covered by
     integration tests on a fake OAuth MCP server (authorization code with PKCE, client credentials, refresh, revoke),
     tenant isolation tests and an e2e spec in the web

**Plans:** 14/14 plans complete

Plans:
**Wave 1**

- [x] 07.14-01-PLAN.md — Wave 1: Contracts (five modes, shared predicates and mode lists, D-10 failure codes and fix lines, `OrgConnection`, client-credential input, Test sign-in DTOs), the web on the predicates, and the phase hub (plan map, shared files, PD-01…PD-18, edge coverage)
- [x] 07.14-02-PLAN.md — Wave 1: Migration: `auth_mode` widened, `mcp_servers.auth_failure`, `connector_org_connections` (tenant RLS, composite FK), N-1 → N upgrade test
- [x] 07.14-03-PLAN.md — Wave 1: Fake OAuth MCP server: client-credentials grant, diagnosis scenarios, pre-registered CC clients for the API stack and e2e

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07.14-04-PLAN.md — Wave 2: OAuth client: failure `step`, client-credentials discovery and grant, registration-free client preview, `diagnose()`
- [x] 07.14-05-PLAN.md — Wave 2: Registry: org modes in create/update/delete, `org_connection_exists` confirm and destroy, D-14 clients kept, DTO `orgConnection`/`authFailure`, cell stays org headers only
- [x] 07.14-06-PLAN.md — Wave 2: Classification consumers: per-tool approvals, templates and member-account shares on the predicates

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07.14-07-PLAN.md — Wave 3: Organization custody and sign-in: credential module over a principal, `flow.ts`, `org-routes.ts` connect/disconnect, the callback's organization branch, re-probe by mode, AAD and tenant isolation

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07.14-08-PLAN.md — Wave 4: Bots use the organization's account: proxy credential by mode, turn-policy split, organization messages and audit (phase API end-to-end tracer)
- [x] 07.14-09-PLAN.md — Wave 4: Client credentials end to end in the API (save, serialized re-grant, issuer pin, revoke) and the Test sign-in route
- [x] 07.14-10-PLAN.md — Wave 4: Watched records read and write with organization accounts (workspace access)
- [x] 07.14-11-PLAN.md — Wave 4: Web server row: organization connection, Connect/Reconnect/Disconnect, failure box, arrival banners; 1440/390 light/dark

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 07.14-12-PLAN.md — Wave 5: Web dialog: five grouped modes, client-credential fields, org mode-switch confirm, Test sign-in panel; 1440/390 light/dark

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 07.14-13-PLAN.md — Wave 6: Browser end to end (admin connects, a member's bot uses it, Disconnect bites), leak sweep with organization canaries, Semgrep `ocw.raw-auth-mode`

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 07.14-14-PLAN.md — Wave 7: Phase gate: full gate, `gate:compose`, ADR-0036, connectors and reverse-proxy docs, DEMO owner check, STATUS, AGENTS, CODEOWNERS, signed VALIDATION

### Phase 07.15: Bots read attachments (INSERTED)

**Goal**: People can attach files where they talk to bots (a personal bot's DM, a team bot's DM, a channel or thread with a
bot, an AI chat with a persona) and the bot actually reads them: images as images for models that see, text-like
documents (text, Markdown, CSV, JSON, code, PDF, Office documents where extraction is reliable) as extracted text, and any
file inside the bot's sandbox workspace so its tools can work on it. Nothing becomes readable to anyone who could not
already read the conversation.

- **Composer:** the paperclip is enabled in bot DMs and channels with bots (today `dm-view.tsx` disables it for bots).
- **What the bot gets:** the turn carries the attachments of the messages it reads; images go to image-capable models
  (as AI chats do, ADR-0018), text is extracted server-side with size caps, other files are offered to the sandbox.
- **Rules:** the bot reads only attachments of the conversation it answers in, acting for the asker, through the Agent
  Channel API (never Garage directly); results stay in that conversation (F-8, ADR-0029); every read is audited without
  content; attachments are untrusted input (taint).
- **Honest limits:** when a model or bot cannot read a type, the bot says so instead of ignoring the file.

**Requirements**: BRA-01, BRA-02, BRA-03, BRA-04, BRA-05
**Depends on:** Phase 07.8 (sandbox), Phase 06.1 (image attachments in the Work Zone), Phase 4 (chat attachments)
**ADR:** 0037
**Success Criteria** (what must be TRUE):

  1. A member attaches an image and a PDF in their personal bot's DM; the bot describes the image (image-capable model)
     and answers from the PDF's text; with a text-only model it says it cannot see the image
  2. In a channel with a team bot, a file attached to the message that mentions the bot (or earlier in the thread it
     reads) reaches the bot under the same audience rules; a file in a conversation the asker cannot read never does
  3. A CSV attached in a DM lands in the bot's sandbox workspace on request and the bot's sandbox tools can process it;
     the copy follows the workspace's existing lifecycle and quotas
  4. Every read is audited (who, bot, attachment id, kind, bytes) without content; extraction is size-capped and never
     executes the file; the leak/taint rules hold
  5. Proven by integration tests and an e2e spec (fake model) on desktop and mobile; README's known limitation removed;
     ADR-0037 records the decisions

**Plans:** 11 plans

Plans:
**Wave 1**

- [ ] 07.15-01-PLAN.md — Wave 1: Contracts (turn attachments with per-bot access and notes, the turn's budget fields, `ocw_attachment_read`, the read request, answer, refusal codes and sentences) and the plugin mirror; the phase hub (plan map, shared files, PD-01…PD-18, edge coverage)
- [ ] 07.15-02-PLAN.md — Wave 1: Migration: `agent_turns.attachment_reads` / `attachment_chars` (additive, defaults), schema and upgrade tests
- [ ] 07.15-03-PLAN.md — Wave 1: The one row rule (D-16) in `agent-channel/attachment-access.ts`, `ocw_sandbox_import` fixed with it and audited as `bot.attachment_imported`, the test upload helpers
- [ ] 07.15-04-PLAN.md — Wave 1: The bot read layer in `artifact/extract` (kind, text decode and cut, untrusted block shared with AI chats, image rendition)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 07.15-05-PLAN.md — Wave 2: PDF text in a bounded Worker with `unpdf@1.9.1` (deadline, heap, pages, characters, concurrency)
- [ ] 07.15-06-PLAN.md — Wave 2: Cell plugin: `ocw_attachment_read`, its own guard budget, the Attachments block, the files-only body, manifest and turn-scoped registration
- [ ] 07.15-07-PLAN.md — Wave 2: Delivery: the turn lists the files of the messages it reads, per bot, and offers the read tool only then

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 07.15-08-PLAN.md — Wave 3: The read route `POST /agent-channel/v1/attachments/read` (phase API end-to-end tracer): decision, budget claim, extraction, audit; tenant, audience, concurrency, taint and leak proofs
- [ ] 07.15-10-PLAN.md — Wave 3: Real-cell smoke `bot_attachments` (files-only message, read with the turn's ids, image part, refusals, reads past the cap of 8)

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 07.15-09-PLAN.md — Wave 4: Web paperclip in bot DMs and the browser end to end (fake cell, desktop and mobile; text-only model, channel thread, CSV into the sandbox; screenshots 1440/390 light/dark, axe)

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 07.15-11-PLAN.md — Wave 5: Phase gate: full gate, smoke, `gate:compose` (unpdf and the worker in the image), ADR-0037, README limitation removed, DEMO owner check, STATUS, AGENTS, CODEOWNERS, signed VALIDATION

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
| 3. Realtime Presence and Latency | MVP 1 | 6/6 | Complete | 2026-10-05 |
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
