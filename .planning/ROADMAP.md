# Roadmap: Open Collaborative AI Workspace

## Overview

This milestone delivers PRD v1.0 **MVP 1 (Collaborative Workspace)** and **MVP 2 (Multiplayer Work
Zone)** as twelve vertical phases. Phases 1–3 fix the things that are ruinous to retrofit — the
tenant boundary (RLS), the permission resolver, the unified `conversations`/`messages` model and the
per-stream `seq`/replay contract. Phases 4–6 build the chat surface, the direct AI chat and then the
multiplayer AI chat that proves the core value (AI sessions are multiplayer). Phase 7 turns that into
a self-hosted release with the MVP 1 acceptance scenario running in CI. Phases 8–12 add the Work
Zone: device pairing and protocol contracts, the Local Runtime daemon with Claude Code / Codex
adapters and the desktop shell, the cloud-owned WorkSession control plane, the Work Zone UI, and
finally artifacts, Chat → Work Zone creation and the full MVP 2 acceptance run.

Design rules that hold across every phase: one conversation model for every surface (sharing is a
grant, never a copy); the WorkSession lives in the cloud and the daemon only connects outbound; the
arbiter built once for AI chats (Phase 6) is reused for Work Zones (Phase 10); no absolute path or
secret ever leaves a device; every sensitive action is audited in the same transaction.

**Project mode:** mvp (each phase ships an end-to-end user capability)
**Granularity:** fine (natural boundaries kept; 12 phases)
**Requirements covered:** 122/122 v1 requirements (see Coverage)

## Milestone Boundary

| Milestone | Phases | Exit condition |
|-----------|--------|----------------|
| **MVP 1 — Collaborative Workspace** | 1–7 | Self-hosted release via `docker compose up`; Acceptance Scenario B steps 1–4 (multiplayer AI chat, minus Work Zone creation) pass as a Playwright E2E in CI |
| **MVP 2 — Multiplayer Work Zone** | 8–12 | Scenario A (minus mobile approval, replaced by web approval) and full Scenario B pass end to end against the compose stack with a signed desktop build |

**Parallel workstreams:** Phase 8 (Device, Project and Work Zone Contracts) and Phase 9 (Local
Runtime Daemon, Adapters and Desktop Shell) can run as parallel workstreams once Phase 8's first
deliverable, `packages/protocol` (DEV-01), is merged. Phase 9's adapters are developed against
recorded fixtures and a fake server, so they do not wait for the rest of Phase 8. Phase 10 requires
both.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**MVP 1 — Collaborative Workspace**

- [ ] **Phase 1: Foundation** - Monorepo, tenant-safe database layer, API skeleton, compose profile and CI guardrails every later phase inherits
- [ ] **Phase 2: Identity and Organization** - Bootstrap, invites, sessions, org hierarchy with four roles, effective-permission resolver, audit log and admin console
- [ ] **Phase 3: Realtime Core** - One authenticated WebSocket per client, per-stream seq with replay, presence and typing, shared realtime client under 500 ms
- [ ] **Phase 4: Chat** - Channels, threads, DMs, Markdown messages, mentions, badges, notifications, search, attachments, pins and permalinks
- [ ] **Phase 5: Direct AI Chat** - Org-configured providers and private streaming AI chats with stop, regenerate, titles, instructions, usage metering and attachments
- [ ] **Phase 6: Multiplayer AI Chat, Sharing and Agents in Conversations** - In-place sharing, live multi-human AI chats with structural participant identity, one generation per conversation, agents as first-class members with Agent Cards
- [ ] **Phase 7: Self-hosted Release** - `pnpm ocw setup` + `docker compose up`, secrets as inputs, migrate service, backup/upgrade tests, Caddy config, license checks and Scenario B E2E (MVP 1 acceptance)

**MVP 2 — Multiplayer Work Zone**

- [ ] **Phase 8: Device, Project and Work Zone Contracts** - Session event and device link protocols, device pairing and revocation, registered projects, Work Zone permission grains and skipped acceptance specs
- [ ] **Phase 9: Local Runtime Daemon, Adapters and Desktop Shell** - Standalone daemon with Claude Code and Codex adapters behind `AgentRuntime`, containment/redaction, git adapter and a signed Electron shell that pairs and supervises it
- [ ] **Phase 10: WorkSession Core** - Cloud-owned WorkSession lifecycle, prompt identity, shared prompt queue, steer/queue/interrupt, single-executor arbiter, approvals, event streaming and resume
- [ ] **Phase 11: Work Zone UI** - Session sidebar, new-session dialog, event stream views, approval banner, queue panel, diff and terminal panels, header presence, notifications and web read-only view
- [ ] **Phase 12: Artifacts, Chat → Work Zone and MVP 2 Acceptance** - Artifact upload pipeline with policy and ACL-scoped downloads, Work Zone creation from any conversation with a live Agent Card, Scenarios A and B end to end

## Phase Details

### Phase 1: Foundation
**Goal**: The monorepo, tenant-safe database layer, Control Plane skeleton, minimal compose profile and CI guardrails exist, so every later phase inherits RLS, shared contracts, observability and bypass detection instead of retrofitting them
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, FOUND-07
**Success Criteria** (what must be TRUE):
  1. A developer clones the repo and runs `pnpm install && pnpm verify` on Node 24 LTS and gets green lint, typecheck and tests in a TypeScript-strict pnpm 12 / Turborepo / Biome / Vitest monorepo
  2. `docker compose up` (minimal profile: postgres, redis, minio, migrate, api, web) starts, the API answers a health check and serves OpenAPI generated from the Zod contracts with OpenTelemetry traces emitted, and a missing required secret makes the stack fail fast with a clear message
  3. A CI test enumerates every org-scoped table and proves, connected as the `app` role, that cross-tenant reads return zero rows and cross-tenant writes fail; the only way application code reaches the database is the `withTenant()` transaction helper
  4. `pnpm verify` fails a change that introduces a permission-bypass token, a skipped policy test or a license violation, and CODEOWNERS covers db policies, auth, adapters and policy paths
  5. `packages/contracts` publishes the unified `conversations` / `messages` model (kinds channel, dm, group, ai_chat, thread, work_session) and every API boundary validates against those Zod schemas
**Plans**: TBD
**Research:** standard (monorepo, Drizzle RLS, testcontainers, OTel and compose are prescribed concretely in STACK/ARCHITECTURE/PITFALLS; accept or reject the ADR amendments — Node 24, TS 7 alias, Tempo, env/file secret provider — as the first decision of this phase)
**UI hint**: no

### Phase 2: Identity and Organization
**Goal**: An Organization Admin can bootstrap the instance, invite people, arrange them into departments, teams and projects with the four PRD roles, and every action is permission-checked through one resolver and audited
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, ORG-01, ORG-02, ORG-03, ORG-04, ORG-05, ORG-06
**Success Criteria** (what must be TRUE):
  1. On first run an admin redeems the one-time setup token to create the organization and its first Organization Admin; no default credentials exist anywhere
  2. An invited person signs up from a copyable invite link (SMTP optional) with email and password, stays logged in across browser refresh and app restart, can reset their password, and can view and revoke their active sessions, each carrying a device/client identifier; admins and team leads can revoke pending invitations
  3. Admin creates and rearranges Organization → Department → Team → Project (including moving units), assigns members with one of Standard User / Developer / Team Lead-Manager / Organization Admin, and manages users, roles, units and memberships from CRUD pages in the admin console
  4. Every route resolves permissions through a single `resolveEffectivePermissions` intersection (Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device) with explicit-deny precedence, and API and WebSocket connections authenticate with short-lived JWTs verifiable against a JWKS endpoint
  5. Every sensitive action appears in the audit log with actor, agent, user, device, resource, action, result, timestamp, organization and session, written in the same transaction; users can view and edit their own profile (display name, avatar, status) and see other members' profiles
**Plans**: TBD
**Research:** needed (better-auth 1.7 schema generation into Drizzle, mapping flat better-auth orgs/teams onto the ltree hierarchy, oauthProvider/JWKS for WS and daemon verification)
**UI hint**: yes

### Phase 3: Realtime Core
**Goal**: Two connected clients see each other's events in under 500 ms over one authenticated WebSocket, and a client that drops and reconnects replays exactly what it missed — the single delivery path that messages, AI runs and session events will all use
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: RT-01, RT-02, RT-03, RT-04, RT-05
**Success Criteria** (what must be TRUE):
  1. A client opens one authenticated WebSocket, subscribes only to topics it is authorised for, and loses a subscription automatically when its membership is removed
  2. Every durable event carries a per-stream monotonic `seq` persisted before publish; a client that disconnects and reconnects with `afterSeq` receives every missed event exactly once, with no gaps or duplicates, proven by an automated test
  3. An automated test against the compose stack measures typical propagation between two connected clients under 500 ms
  4. Presence (online/away) and typing indicators for other connected users appear per conversation and expire automatically when a client disappears
  5. Web (and later desktop) consume one shared realtime client package that reconnects with backoff, resumes from the last seq and exposes stores the UI reads from
**Plans**: TBD
**Research:** standard (`@fastify/websocket` + Redis fan-out + Postgres seq is a known pattern; ARCHITECTURE gives the table DDL and reconnect algorithm)
**UI hint**: no

### Phase 4: Chat
**Goal**: A team can do its daily conversation in the workspace — channels, threads, DMs, mentions, search and files — with every message attributed, editable under audit and delivered in realtime
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08, CHAT-09, CHAT-10, CHAT-11, CHAT-12, CHAT-13, CHAT-14
**Success Criteria** (what must be TRUE):
  1. User creates, joins, leaves and archives public and private channels shown in a sidebar grouped by department/team with All, Mentions, Threads and AI Chats views; a non-member cannot read a private channel even through the API
  2. User replies in a side-panel thread (single level, nesting refused) whose parent shows reply count and participants, and opens DMs and group DMs between humans, humans and agents, or mixed groups
  3. Messages render a Markdown subset with syntax-highlighted code through one shared renderer, and support edit and delete (edited marker, prior versions kept for audit, admins can delete any), emoji reactions, @mentions of users, agents, @channel and @here with autocomplete that generate notifications, pins, personal saves and permalinks
  4. Unread and mention badges per channel/DM update in realtime from read markers with mark-as-read/unread; user can mute a channel, set do-not-disturb or mention-only and toggle desktop/web, and the notification inbox honours those preferences
  5. User finds messages, people and channels through full-text search with channel/author/date filters, attaches files and images by drag-and-drop or paste (preview and download) through the artifact upload pipeline, and history loads with cursor pagination and jump-to-permalink
**Plans**: TBD
**Research:** standard (Slack-model chat over the Phase 3 primitives; FEATURES is exhaustive on expectations)
**UI hint**: yes

### Phase 5: Direct AI Chat
**Goal**: A user holds a private, streaming AI conversation using organization-configured models, with every generation metered — the run loop, provider layer and usage records that multiplayer AI chat builds on
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: AICHAT-01, AICHAT-02, AICHAT-03, AICHAT-04, AICHAT-05, AICHAT-06, AICHAT-07, AICHAT-08, AICHAT-09
**Success Criteria** (what must be TRUE):
  1. Admin configures organization-level model providers (API keys held as `SecretReference` in the secret store) and an allowed-models list; there is no path for a user to enter a personal API key
  2. User creates a private AI chat, picks a model from the allowed list and can switch it per message, watches the response stream in realtime, stops generation with the partial output kept, and regenerates the last answer
  3. Each chat gets an auto-generated title and appears in a list the user can rename, archive and search; custom instructions apply per chat and as personal defaults
  4. Every generation writes a usage record (model, provider, input/output tokens, cost estimate, requester) and the chat shows tokens per message; the settings expose Web, Company Knowledge, MCP and Skills toggles with only Web search functional and the rest visibly disabled
  5. User attaches files and images to a prompt for vision-capable models through the upload pipeline, and can create an organization-scoped read-only snapshot share link that is never public
**Plans**: TBD
**Research:** standard (AI SDK 7 `streamText` and provider packages are documented in STACK; the model integration contract is captured by `/gsd-ai-integration-phase` during planning)
**UI hint**: yes

### Phase 6: Multiplayer AI Chat, Sharing and Agents in Conversations
**Goal**: The core value is proven — a private AI chat becomes a live shared conversation where the model knows who each participant is, generation is arbitrated, and agents take part in channels and DMs as first-class members
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: MULTI-01, MULTI-02, MULTI-03, MULTI-04, MULTI-05, MULTI-06, MULTI-07, MULTI-08, AGENT-01, AGENT-02, AGENT-03, AGENT-04
**Success Criteria** (what must be TRUE):
  1. Owner shares an AI chat in place with a person, team, department or organization; the share dialog states exactly what becomes visible, and the recipient sees the same conversation (context, messages, attachments, artifacts, model, tools, permissions, participants) as a grant on the same record, never a copy
  2. Two or more humans and the model write in one conversation in realtime; every message records author, timestamp, device, context and permissions; the model addresses each participant correctly from structural identity (roster plus server-generated attributed blocks, never spoofable name prefixes), a spoofed authority claim inside a message is refused by the CI three-participant evaluation fixture, and Acceptance Scenario B steps 1–4 pass end to end
  3. The model responds when @mentioned or when addressed while idle; at most one generation runs per conversation and queued or coalesced follow-ups are visible to all participants
  4. Tools invoked in a shared chat run with the intersection of the agent's and the triggering human's permissions, content not authorised for every participant is withheld with an explanation, and no user-private context or personal memory is injected once a second human is present
  5. Admin or Team Lead creates an agent persona (name, username, avatar, model, instructions, tools, scope, owner); the agent is a member of channels, DMs and AI chats like a human, replies in-thread when mentioned using the thread's context within its permissions, and posts typed Agent Cards (kind, title, fields, status, Open / Follow / Approve actions) that update in place
**Plans**: TBD
**Research:** needed (prompt-assembly behaviour across Anthropic / OpenAI / Google / openai-compatible providers — alternation rules, mid-conversation system messages, prompt caching; debounce tuning; the participant-spoofing eval fixture)
**UI hint**: yes

### Phase 7: Self-hosted Release
**Goal**: Any engineering team can install, upgrade, back up and expose an MVP 1 instance with one command each, and the MVP 1 acceptance scenario runs against that exact stack in CI — the milestone gate for Autofy's own engineers as first customer
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: SELF-01, SELF-02, SELF-03, SELF-04, SELF-05, SELF-06, SELF-07
**Success Criteria** (what must be TRUE):
  1. `git clone` + `pnpm ocw setup` + `docker compose up` yields a working MVP 1 instance; OpenBao and observability (Prometheus, Grafana, Loki, Tempo) are optional compose profiles that can be enabled later without reinstalling
  2. Secrets are required inputs (env or `*_FILE`) and are never generated silently at boot; the env/file secret provider and the OpenBao client implement the same `SecretStore` interface
  3. Migrations run in a one-shot `migrate` service and the API refuses to start on schema mismatch; an `N-1 → N` upgrade test passes in CI; `pnpm ocw backup` / restore work as the migrator role and data survives `docker compose up --force-recreate`
  4. The documented Caddy reverse-proxy configuration passes a test covering WebSocket upgrade, trusted proxy headers and presigned object-storage URLs reachable from outside the compose network
  5. Every package declares its license (AGPL-3.0 apps/server, Apache-2.0 for `packages/contracts` and `packages/protocol`), CI checks dependency-license compatibility, and Scenario B (minus Work Zone creation) runs as a Playwright E2E against the compose stack in CI
**Plans**: TBD
**Research:** needed (MinIO community-edition feature shedding and Garage/SeaweedFS fallback; pnpm 12 lockfile compatibility with Turborepo 2.10)
**UI hint**: no

---

**MVP 1 boundary.** Phases 1–7 complete MVP 1 (Collaborative Workspace): self-hosted release plus
Scenario B without Work Zone creation. Phases 8–12 below are MVP 2 (Multiplayer Work Zone).

---

### Phase 8: Device, Project and Work Zone Contracts
**Goal**: A member's machine can be paired, seen, revoked and trusted with registered projects, and the protocols and permission grains that the daemon and WorkSession phases build against are fixed in code — with the acceptance targets committed — before either starts
**Mode:** mvp
**Depends on**: Phase 7 (MVP 1 released); builds on Phase 2 permissions and Phase 3 streams
**Parallel with**: Phase 9 (once DEV-01 `packages/protocol` is merged)
**Requirements**: DEV-01, DEV-02, DEV-03, DEV-04, DEV-05, DEV-06, DEV-07
**Success Criteria** (what must be TRUE):
  1. `packages/protocol` (Apache-2.0) ships the Unified Session Event Protocol event set, the Device Link protocol (hello, heartbeat, resume, event, command, ack, `protocolVersion`) and `RuntimeCapabilities` flags (`supportsSteer`, `supportsResume`, `supportsPermissionModes`, `supportsImages`) as Zod schemas the daemon and server both import
  2. User pairs a device to their account and organization with a short-lived enrollment code (RFC 8628); the device holds an Ed25519 identity, authenticates on `/runtime/ws` with a signed challenge, connects outbound-only with heartbeat, and is marked offline after the grace period
  3. User and admin see devices (online/offline, last seen, runtime versions, active sessions) and can revoke one, which disconnects it immediately; commands issued while a device is offline wait in `runtime_commands` and are delivered at-least-once with acks when it returns
  4. A paired device registers local git repositories as projects; only the repo-relative path is stored server-side, `$HOME` and system roots are refused, and remote clients can only select registered projects
  5. Work Zone permission grains (VIEW … FULL_CONTROL) resolve through `resolveEffectivePermissions` with Owner / Collaborator / Reviewer / Viewer templates, and Acceptance Scenarios A and B are committed as skipped E2E specs before any daemon or WorkSession code exists
**Plans**: TBD
**Research:** standard (Ed25519 challenge auth, RFC 8628 device grant and the commands table are standard; the protocol shape is fully specified in ARCHITECTURE)
**UI hint**: no

### Phase 9: Local Runtime Daemon, Adapters and Desktop Shell
**Goal**: A developer installs a signed desktop app that pairs the machine, supervises a standalone Local Runtime daemon, and drives Claude Code and Codex through one `AgentRuntime` interface with nothing sensitive ever leaving the device
**Mode:** mvp
**Depends on**: Phase 8 (DEV-01 `packages/protocol`; enrollment UI integrates against DEV-02 when available)
**Parallel with**: Phase 8 (adapters are built against recorded fixtures and a fake server)
**Requirements**: RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04, RUNTIME-05, RUNTIME-06, RUNTIME-07, RUNTIME-08, RUNTIME-09, RUNTIME-10, DESK-01, DESK-02, DESK-03, DESK-04, DESK-05
**Success Criteria** (what must be TRUE):
  1. Developer installs the signed and notarized desktop app (macOS, Windows, Linux) from the auto-update feed; it never loads the remote web site, supervises the daemon and shows its status over a Unix socket / named pipe with a token (no open localhost port), and offers device enrollment and native project registration
  2. Through the `AgentRuntime` interface (start, prompt, steer, interrupt, approve, resume, stop, capabilities) the daemon runs both a Claude Code session (Agent SDK streaming input, `canUseTool` approval bridge, `disallowedTools` denies for secret paths, `interrupt()` before termination, `supportsSteer=false`) and a Codex session (`codex app-server` JSON-RPC with committed generated types, `turn/steer`, `turn/interrupt`, server-initiated approvals, resume after idle close); runtime internals never leak past the adapter
  3. Both adapters map their permission modes onto one `permissionMode` enum, no adapter can enable a bypass-permissions mode and org policy caps the mode; every outbound field including free text passes device-side `contain()` and `redact()`, unknown runtime events are forwarded as `runtime.raw`, and recorded-fixture contract tests per pinned runtime version verify the mapping in CI without the real CLIs
  4. On connect the daemon reports runtime detection (installed, logged in, version, compatibility) and session creation with an unavailable runtime fails with an actionable error; the git adapter reports repository, branch, base and current commit, dirty state, changed files and diff on demand and creates a worktree/branch per session; a second session on the same repo is offered a worktree
  5. Sleeping the host marks the device offline and waking reconnects it with the offline append log replayed, so a session is parked as `host_offline` rather than `failed`; the daemon survives app restart with no orphaned processes (pidfile reaping, process groups), device secrets live in OS-encrypted storage behind hardened webPreferences and fuses, and an `N-1 → N` desktop update test passes in CI
**Plans**: TBD
**Research:** needed (Agent SDK bundling in a packaged daemon; Codex app-server version pinning and `generate-ts` workflow; vendor terms for driving Claude Code / Codex on subscription logins; node-pty rebuild for Electron 44; Windows named pipes; macOS notarization entitlements; Linux `bwrap` preflight; validate ADR-0005 with the adapter spike)
**UI hint**: yes

### Phase 10: WorkSession Core
**Goal**: A Work Zone session is a cloud-owned entity that several people control through the Control Plane while exactly one runtime on one host executes — provable from the API alone before any Work Zone UI exists
**Mode:** mvp
**Depends on**: Phase 8, Phase 9
**Requirements**: WZ-01, WZ-02, WZ-03, WZ-04, WZ-05, WZ-06, WZ-07, WZ-08, WZ-09, WZ-10, WZ-11, WZ-12, WZ-13, WZ-14, WZ-15, WZ-16
**Success Criteria** (what must be TRUE):
  1. A user creates a WorkSession (project, execution host, runtime, model, permission mode) and it moves through draft → provisioning → idle / running / waiting_approval / host_offline → completed / failed → archived; when the host is another member's device, that host must accept (or have pre-authorised the project/team) before the runtime launches
  2. Every prompt, including one typed on the executing host's own desktop, goes through the Control Plane and records `prompt_id`, author, origin device, session, created_at, execution mode and status in the audit log; the daemon only executes commands it received and acked; a participant lacking a grain gets a visible `permission.denied` event instead of the action
  3. Participants with the right grains add, edit (versioned, before start), remove, reorder, change priority and run-next prompts in a shared queue that is persisted and survives host disconnect; Steer is offered only when the adapter reports `supportsSteer` (otherwise head-of-queue), Interrupt stops the current turn, and the server-side arbiter dispatches the next command only after the previous one is acked so concurrent controllers never interleave
  4. Runtime approval requests surface to all participants; only `APPROVE` holders can approve once, allow for session, or deny with comment; unanswered approvals time out to deny and expire on daemon restart; session events stream to participants in realtime with cursor replay (assistant deltas coalesced into checkpointed rows, high-volume tool/command events stream-only) and git state plus changed files/diff are exposed behind `DIFF_VIEW` with only repo-relative paths
  5. Session presence (Controlling / Viewing diff / Typing / Following / Away) is tracked per participant, a user can follow a session without controlling it and receive its notifications, sessions resume after daemon restart, app restart or host sleep by replaying the event log and reattaching the runtime (showing "Host offline since …" while queued prompts wait), and sessions can be renamed, archived (auto-archive after a configurable period) and searched with the event log as transcript
**Plans**: TBD
**Research:** standard (state machine, arbiter and approval round-trip are specified step by step in ARCHITECTURE; reuses the Phase 6 arbiter shape — the risk is discipline, not unknowns)
**UI hint**: no

### Phase 11: Work Zone UI
**Goal**: Desktop users see and control a live multiplayer session with the affordances of the official coding-agent GUIs, with capability-driven controls that never offer what the runtime cannot do, and web users can watch the same session read-only
**Mode:** mvp
**Depends on**: Phase 10
**Requirements**: WZUI-01, WZUI-02, WZUI-03, WZUI-04, WZUI-05, WZUI-06, WZUI-07, WZUI-08, WZUI-09, WZUI-10, DESK-06, DESK-07
**Success Criteria** (what must be TRUE):
  1. The session sidebar groups sessions by project with status (running, waiting, needs approval, done, failed) and a "Needs attention" group; the new-session dialog offers project, runtime, model, permission mode, execution host (registered online devices) and a worktree option
  2. The conversation stream renders the Unified Session Event Protocol in Normal / Verbose / Summary modes with collapsed tool calls; a sticky approval banner with approve / allow for session / deny appears for eligible participants; the queue panel supports drag reorder, edit, remove, run next and priority and shows each prompt's author
  3. The Changes panel lists changed files with unified and side-by-side diff, a read-only terminal panel shows command output, Activity / Files / Context / People panels are available, and the header shows host, runtime, model, branch, presence avatars, Share and Queue controls plus a context/usage indicator (tokens, context window, cost)
  4. The composer autocompletes `@file` mentions from the host's registered project file list (relative paths) and accepts image attachments; "Open in editor" (VS Code / Cursor) deep links work for files of the current session only on the executing host
  5. Desktop notifications fire for task completed, task failed, approval required, mention and device offline; the web client renders Work Zone sessions read-only (stream, diff, queue) under the same server-side permission checks
**Plans**: TBD
**Research:** needed (diff-rendering library choice — `@pierre/diffs` vs `@git-diff-view/react`, both young; xterm streaming performance with coalesced chunks)
**UI hint**: yes

### Phase 12: Artifacts, Chat → Work Zone and MVP 2 Acceptance
**Goal**: Work Zones produce shareable artifacts governed by organization policy, any conversation can spawn a Work Zone that reports back through a live Agent Card, and both PRD acceptance scenarios pass end to end against the self-hosted stack with a desktop build
**Mode:** mvp
**Depends on**: Phase 11 (uses Phase 4 conversations and Phase 6 Agent Cards)
**Requirements**: ART-01, ART-02, ART-03, ART-04, ART-05, ART-06
**Success Criteria** (what must be TRUE):
  1. The daemon publishes a shared artifact through workspace containment → policy → SHA-256 → security checks → encrypted presigned upload → object storage and participants receive `artifact.created`; preview and download require `FILES_VIEW` / `FILES_DOWNLOAD`, are audited, and use short-lived ACL-scoped URLs that stop working when a share is revoked
  2. An Organization Admin sets the artifact storage policy (enabled / encrypted only / disabled) and retention, and the daemon and server honour it
  3. From a channel, thread or AI chat a user creates a Work Zone by choosing a project and an online host; the originating conversation gets a live Agent Card with Open / Follow that updates as the session progresses, and an AI Chat → Work Zone carries the conversation summary, participants and permissions into the new session
  4. Acceptance Scenario A (with web approval in place of mobile) and full Scenario B pass end to end in CI against the compose stack with a signed desktop build
**Plans**: TBD
**Research:** standard (presigned S3 pipeline is standard; acceptance specs exist from Phase 8)
**UI hint**: yes

## Coverage

| Category | Requirements | Phase |
|----------|--------------|-------|
| FOUND | FOUND-01 … FOUND-07 (7) | 1 |
| AUTH | AUTH-01 … AUTH-06 (6) | 2 |
| ORG | ORG-01 … ORG-06 (6) | 2 |
| RT | RT-01 … RT-05 (5) | 3 |
| CHAT | CHAT-01 … CHAT-14 (14) | 4 |
| AICHAT | AICHAT-01 … AICHAT-09 (9) | 5 |
| MULTI | MULTI-01 … MULTI-08 (8) | 6 |
| AGENT | AGENT-01 … AGENT-04 (4) | 6 |
| SELF | SELF-01 … SELF-07 (7) | 7 |
| DEV | DEV-01 … DEV-07 (7) | 8 |
| RUNTIME | RUNTIME-01 … RUNTIME-10 (10) | 9 |
| DESK | DESK-01 … DESK-05 (5) | 9 |
| DESK | DESK-06, DESK-07 (2) | 11 |
| WZ | WZ-01 … WZ-16 (16) | 10 |
| WZUI | WZUI-01 … WZUI-10 (10) | 11 |
| ART | ART-01 … ART-06 (6) | 12 |

**Total:** 122 v1 requirements, 122 mapped, 0 orphaned, 0 duplicated.

**Adjustments to the research suggestion:** DESK-06 (desktop notifications for task completed /
failed / approval required / mention / device offline) and DESK-07 (open-in-editor for files of the
current session) are placed in Phase 11 rather than Phase 9 because their observable behaviour needs
a WorkSession to exist (Phase 10); SUMMARY.md's Phase 11 deliverables already list both. Everything
else follows the reconciled 12-phase structure in `.planning/research/SUMMARY.md`.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 ‖ 9 → 10 → 11 → 12
(Phases 8 and 9 may run as parallel workstreams after DEV-01 lands; both must complete before 10.)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | MVP 1 | 0/TBD | Not started | - |
| 2. Identity and Organization | MVP 1 | 0/TBD | Not started | - |
| 3. Realtime Core | MVP 1 | 0/TBD | Not started | - |
| 4. Chat | MVP 1 | 0/TBD | Not started | - |
| 5. Direct AI Chat | MVP 1 | 0/TBD | Not started | - |
| 6. Multiplayer AI Chat, Sharing and Agents in Conversations | MVP 1 | 0/TBD | Not started | - |
| 7. Self-hosted Release | MVP 1 | 0/TBD | Not started | - |
| 8. Device, Project and Work Zone Contracts | MVP 2 | 0/TBD | Not started | - |
| 9. Local Runtime Daemon, Adapters and Desktop Shell | MVP 2 | 0/TBD | Not started | - |
| 10. WorkSession Core | MVP 2 | 0/TBD | Not started | - |
| 11. Work Zone UI | MVP 2 | 0/TBD | Not started | - |
| 12. Artifacts, Chat → Work Zone and MVP 2 Acceptance | MVP 2 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-09-10*
*Source: .planning/REQUIREMENTS.md (122 v1 requirements), .planning/research/SUMMARY.md (12-phase suggestion), PRD v1.0 MVP 1 + MVP 2*
