# Requirements: Open Collaborative AI Workspace

**Defined:** 2026-09-10
**Core Value:** AI sessions are multiplayer — a private AI chat or coding session can be shared live with colleagues, the model knows who each participant is, and everything stays attributed and auditable.

Milestone: PRD v1.0 **MVP 1 (Collaborative Workspace)** + **MVP 2 (Multiplayer Work Zone)**, plus the
first-release gaps identified in `.planning/research/FEATURES.md` §4 (accepted as v1 on 2026-09-10).
PRD section numbers are given as `PRD §n` for traceability.

## v1 Requirements

Requirements for this milestone. Each active requirement maps to exactly one roadmap phase; superseded
ones are kept for history. `[x]` = delivered in Phase 1 (2026-10-04 audit; formal phase verification pending).

### Foundation (FOUND)

- [x] **FOUND-01**: Developer can clone the repo and run `pnpm install && pnpm verify` (lint, typecheck, tests) on Node 24 LTS with pnpm 12 / Turborepo / Biome / Vitest in a TypeScript-strict monorepo (ADR-0001)
- [x] **FOUND-02**: All organization-scoped tables carry `organization_id` and are protected by PostgreSQL RLS with two database roles (`migrator` owner, `app` without bypass); the app can only reach the database through a `withTenant()` transaction helper (PRD §97, PITFALLS 1)
- [x] **FOUND-03**: A CI test enumerates every org-scoped table and proves, as the `app` role, that cross-tenant reads and writes return zero rows / fail
- [x] **FOUND-04**: `packages/contracts` defines one unified `conversations` / `messages` model (kinds: channel, dm, group, ai_chat, thread, work_session) and Zod schemas used by every API boundary (ARCHITECTURE §1)
- [ ] **FOUND-05**: Fastify Control Plane skeleton loads modules through explicit constructor wiring, exposes OpenAPI from Zod schemas, and emits OpenTelemetry traces/metrics/logs via `@fastify/otel` (ADR-0002, ADR-0003)
- [ ] **FOUND-06**: `docker compose up` minimal profile (postgres, redis, minio, api, web, one-shot `migrate`) starts and fails fast with a clear message when a required secret is missing (PRD §5.1)
- [ ] **FOUND-07**: `pnpm verify` fails on permission-bypass tokens (Semgrep), skipped policy tests, and license violations; CODEOWNERS covers db policies, auth, adapters and policy paths (PITFALLS 13)

### MVP 0 Slice (SLICE)

Thin requirements that record what Phase 1 (MVP 0) actually ships; each names the full requirement(s)
and phase that later widen it. SLICE-01…05 were written on 2026-10-02 for the shared-AI-chat slice;
SLICE-06…18 were added on 2026-10-04 after the code audit of the widened demo build (Restructure
2026-10-04 in ROADMAP.md). Superseded requirements stay listed for history and are not mapped to a phase.

- ~~**SLICE-01**~~: The operator configures one model provider (Anthropic by default) and its model through env / `*_FILE` secrets read via the `env`/`file` `SecretStore` provider; no admin UI yet (full admin configuration is AICHAT-01, Phase 5) — *Superseded 2026-10-04 by SLICE-09: providers are configured in the UI*
- ~~**SLICE-02**~~: User creates a private AI chat and sees the model's response stream in realtime with the single configured model (model choice, stop, regenerate are AICHAT-02/03, Phase 5) — *Superseded 2026-10-04: no AI chat was built in Phase 1; absorbed by AICHAT-02/03 (Phase 5)*
- ~~**SLICE-03**~~: Owner shares an AI chat in place with a specific member of the same organization; sharing is a grant on the same conversation, never a copy (teams/departments/org and the share dialog copy are MULTI-01, Phase 6) — *Superseded 2026-10-04: absorbed by MULTI-01 (Phase 6), which already covers sharing with a person*
- ~~**SLICE-04**~~: A minimal responsive web UI (Next.js + shadcn/ui) covers setup, invite acceptance, login, AI chat list, live conversation view and share action, verified at mobile and desktop widths — *Superseded 2026-10-04 by SLICE-17 (the UI covers chat, bots and Work Zone instead of an AI chat list)*
- [x] **SLICE-05**: End-to-end tests use a deterministic mock language model so CI never calls a metered provider; the real provider is exercised manually
- [x] **SLICE-06**: Every sensitive action that exists in MVP 0 writes an audit event in the same transaction with actor, agent, user, device, resource, action, result, timestamp, organization and session: setup, invitations, sign-up and sign-in, channel creation/archive/membership, bot, model-provider and secret changes, Agent Channel auth failures and cell-token rotation, device enrollment/update/revocation, and work-session creation, prompt queue/edit/cancel, approvals, interrupt and archive (failed sign-in and later actions: ORG-05, Phase 2)
- [x] **SLICE-07**: Each client keeps one cookie-authenticated WebSocket (`/ws`, Origin allowlist) and can subscribe only to topics a deny-by-default authorizer allows (`conv`, `user`, `org`, `ws`); the session is re-checked every 5 minutes and a revoked session is closed (re-evaluation on membership change: RT-01, Phase 3)
- [x] **SLICE-08**: Slack-style chat surface: a channel sidebar with an unread dot computed from read markers, Markdown messages with highlighted code blocks, @mention autocomplete of people and bots, typing indicators that expire, and cursor-paginated history (grouping and views, DMs, @channel/@here, notifications, mention badges, one shared renderer and permalinks: CHAT-02/04/05/08/09/14, Phase 4; presence: RT-04, Phase 3)
- [x] **SLICE-09**: An admin connects an organization model provider (Anthropic, OpenAI, OpenRouter) in Settings › Models; the API key is write-only, stored AES-256-GCM-encrypted in `app.secrets` (approved MVP 0 exception to `SecretReference`), never returned or logged, and an allowed-models list decides which models bots may use; members cannot manage providers (full AICHAT-01 with `SecretReference` and AI chats: Phase 5)
- [x] **SLICE-10**: An admin creates a bot in one click from a preset (name, unique username, avatar, persona instructions, model fixed from the allowed list); the bot is a first-class principal (own `agents` row, `author_kind` agent, conversation memberships), appears in member lists and mention autocomplete, can be added to channels, and has no tools (tools, scopes, Team Lead creation, DMs and AI chats: AGENT-01/02, Phase 6)
- [x] **SLICE-11**: Bots run in one OpenClaw cell per organization (pinned `openclaw@2026.9.7`, locked-down container on an internal network, admin port never published) through our native channel plugin, which talks only to Agent Channel API v1 with a hashed, rotatable cell token: it reconciles bot config from `GET /agent-channel/v1/cell`, acks provisioning → ready, receives mentions with cursor replay and posts idempotent threaded replies (thin form of v2 CLAW-01, pulled forward by the owner 2026-10-02; multi-cell, Kubernetes, sandboxing and proactive messaging stay CLAW-01…03, v2)
- [x] **SLICE-12**: In a channel or thread several humans and a bot converse live: a mention is delivered only to member bots with the server-resolved author (id, name, kind), the participant roster and bounded thread history as structured fields; display names that try to forge roster entries are neutralised; each mention gets at most one reply (idempotent per event), in the thread, attributed to the bot, with a typing indicator visible to every participant (multi-human AI chats: MULTI-02/03/04, Phase 6)
- [x] **SLICE-13**: A user pairs a device from Settings › Devices with a one-time pairing code valid for 10 minutes; the server stores only a hash of the device bearer token (the desktop app keeps it in OS-encrypted storage); the device list shows owner, online/offline, last seen, daemon version and detected runtimes (installed, signed in); the owner can share the device with the organization, and revocation closes its link and fails its sessions (Ed25519 identity, RFC 8628, active sessions, admin view: DEV-02/03, Phase 8)
- [x] **SLICE-14**: A member starts a Work Zone session on a registered project of an online paired device with Claude Code or Codex running on that device owner's own subscription login (BYO, never pooled; API-key variables stripped from the runtime by default); the session is a server-owned entity (provisioning / idle / running / waiting_approval / host_offline / completed / failed / archived); members add, edit, cancel and reorder prompts in one persisted shared queue and interrupt the running turn; approvals (once / allow for session / deny with comment) are decided exactly once by the session creator, the device owner or an admin; the live diff is repo-relative; queued prompts wait while the host is offline and a restarted daemon re-attaches with resume; sessions can be archived (grains and templates, steer, versioned queue, presence, follow, rename, search: WZ-*, Phase 10)
- [x] **SLICE-15**: The Work Zone session view, on web and desktop at 390 px and 1440 px, shows the event stream with collapsible tool cards, the shared queue panel with each prompt's author and drag/arrow reorder, edit and remove, the Changes panel with changed files and a unified diff, a header with project, host, runtime, model, branch, permission mode and participant avatars, and tokens per turn (view modes, side-by-side diff, terminal and side panels, live presence, Share, usage indicator: WZUI-03/05/06/07/09, Phase 11)
- [x] **SLICE-16**: An ad-hoc-signed macOS (arm64) Electron app supervises the Local Runtime daemon as a separate process group (pidfile reaping, restart with backoff), shows its status in the tray over a 0600 Unix socket, keeps the device token in `safeStorage`, and loads the web app in a hardened window (contextIsolation, sandbox, navigation allowlist) (bundled renderer, Windows/Linux, socket token, signing, notarization, auto-update, fuses: DESK-01/02/04, Phase 9)
- [x] **SLICE-17**: A responsive web UI (Next.js + shadcn/ui, light and dark) covers setup, login, invite acceptance, chat, bots, Settings (members and invitations, models, devices, bots runtime) and the Work Zone; every surface except invite acceptance is exercised by Playwright at 390 px and 1440 px with review screenshots
- [x] **SLICE-18**: The Fastify Control Plane wires its modules explicitly and serves OpenAPI generated from the Zod contracts at `/docs`; `compose.yaml` defines postgres, redis, a one-shot `migrate`, api, web and the OpenClaw cell (no MinIO in Phase 1); the API fails fast naming any missing secret (`NAME` or `NAME_FILE`); CI builds the api and web images on every PR; `pnpm demo:up` / `pnpm demo:reset` start and seed the demo stack (OpenTelemetry and a verified full `docker compose up`: FOUND-05/06, Phase 7)

### Identity and Authentication (AUTH)

- [x] **AUTH-01**: First run creates the organization and its first Organization Admin through a one-time setup token; no default credentials exist
- [x] **AUTH-02**: User can sign up with email and password from an invitation link and stays logged in across browser refresh and app restarts
- [x] **AUTH-03**: Admin or Team Lead can invite people by copyable link (SMTP optional) and revoke pending invitations
- [ ] **AUTH-04**: User can reset their password (email when SMTP configured, admin-issued link otherwise)
- [ ] **AUTH-05**: User can view and revoke their active sessions; every session carries a device/client identifier used for message attribution (PRD §15)
- [ ] **AUTH-06**: API, WebSocket and daemon connections are authenticated with short-lived JWTs verified against a JWKS endpoint; identity is provided by better-auth embedded in the API (STACK decision)

### Organization and Permissions (ORG)

- [ ] **ORG-01**: Admin can create and manage the hierarchy Organization → Department → Team → Project, including moving units (PRD §7)
- [ ] **ORG-02**: Admin can assign users to units with one of the four roles: Standard User, Developer, Team Lead/Manager, Organization Admin (PRD §6)
- [ ] **ORG-03**: A single `resolveEffectivePermissions` function computes permissions as the intersection Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device with explicit-deny precedence, and every route uses it (PRD §61, §82)
- [ ] **ORG-04**: Admin console provides CRUD pages for users, roles, departments, teams, projects and memberships (PRD §81 minimal)
- [ ] **ORG-05**: Every sensitive action (auth, membership, permission change, sharing, message edit/delete, session control, approval, artifact access) writes an audit event in the same transaction with actor, agent, user, device, resource, action, result, timestamp, organization and session (PRD §84)
- [ ] **ORG-06**: User can view and edit their profile (display name, avatar, status) and see other members' profiles

### Realtime (RT)

- [ ] **RT-01**: Client keeps one authenticated WebSocket and subscribes to topics it is authorised for; authorisation is re-evaluated when membership changes (PRD §85)
- [x] **RT-02**: Every durable event is persisted with a per-stream monotonic `seq` before being published over Redis; a reconnecting client replays from `afterSeq` and never loses or duplicates events (PRD §97)
- [ ] **RT-03**: Typical propagation of collaborative events between two connected clients is under 500 ms, measured in an automated test against the compose stack (PRD §85)
- [ ] **RT-04**: Presence (online/away) and typing indicators are visible per conversation and expire automatically when a client disappears
- [x] **RT-05**: A shared realtime client package handles reconnect with backoff, resume, and exposes stores consumed by web and desktop

### Chat (CHAT)

- [x] **CHAT-01**: User can create, join, leave and archive public and private channels; private membership is enforced server-side (PRD §11)
- [ ] **CHAT-02**: Sidebar groups channels by department/team with All, Mentions, Threads and AI Chats views (PRD §11.1)
- [x] **CHAT-03**: User can reply in a side-panel thread (single level, no nesting); the parent shows reply count and participants (PRD §12)
- [ ] **CHAT-04**: User can open DMs and group DMs between humans, humans and agents, and mixed groups (PRD §13)
- [ ] **CHAT-05**: Messages support a Markdown subset with syntax-highlighted code blocks, rendered by one renderer shared with AI chats and agent output
- [ ] **CHAT-06**: Author can edit and delete their own messages (edited marker, prior versions kept for audit); admins can delete any message
- [ ] **CHAT-07**: User can add emoji reactions to messages, thread replies and AI messages
- [ ] **CHAT-08**: User can @mention users, agents, @channel and @here with autocomplete; mentions generate notifications and trigger agents
- [ ] **CHAT-09**: Unread and mention badges per channel/DM, mark as read/unread, computed from read markers (`last_seq - last_read_seq`)
- [ ] **CHAT-10**: User can set notification preferences: per-channel mute, do-not-disturb, mention-only, desktop/web toggle; the notification inbox honours them (PRD §98)
- [ ] **CHAT-11**: User can search messages, people and channels with filters (channel, author, date) using PostgreSQL full-text search
- [ ] **CHAT-12**: User can attach files and images (drag-and-drop, paste) through the artifact upload pipeline with preview and download
- [ ] **CHAT-13**: User can pin messages per channel, save messages personally, and copy permalinks to messages and threads
- [ ] **CHAT-14**: Message history loads with cursor pagination and jump-to-permalink

### Direct AI Chat (AICHAT)

- [ ] **AICHAT-01**: Admin can configure organization-level model providers (API keys stored as `SecretReference` in the secret store) and an allowed-models list; personal API keys are not a supported path (PRD §54 thin slice)
- [ ] **AICHAT-02**: User can create a private AI chat, pick a model from the allowed list, and switch model per message (PRD §14)
- [ ] **AICHAT-03**: Responses stream in realtime to the author; user can stop generation (partial output persisted) and regenerate the last answer
- [ ] **AICHAT-04**: AI chats get an auto-generated title and appear in a list the user can rename, archive and search
- [ ] **AICHAT-05**: User can set custom instructions per chat and personal defaults
- [ ] **AICHAT-06**: Tool toggles (Web, Company Knowledge, MCP, Skills) exist in the chat settings; only Web search is functional in this milestone, the rest are visibly disabled (PRD §14)
- [ ] **AICHAT-07**: Every generation writes a usage record (model, provider, input/output tokens, cost estimate, requester) and the chat shows tokens per message
- [ ] **AICHAT-08**: User can attach files/images to prompts for vision-capable models via the upload pipeline
- [ ] **AICHAT-09**: User can create a read-only snapshot share link of an AI chat scoped to the organization (never public)

### Multiplayer AI Chat and Sharing (MULTI)

- [ ] **MULTI-01**: Owner can share an AI chat in place with a person, team, department or organization; sharing is a grant on the same conversation, never a copy, and the share dialog states exactly what becomes visible (PRD §16)
- [ ] **MULTI-02**: Several humans and the model participate in one conversation in realtime; every message records author, timestamp, device, context and permissions (PRD §15)
- [ ] **MULTI-03**: The model receives structural participant identity (roster in the system prompt, server-generated attributed message blocks, consecutive human messages merged) and never plain-text name prefixes that a participant could spoof
- [ ] **MULTI-04**: The model responds when @mentioned or when addressed while idle; at most one generation runs per conversation, with queued or coalesced follow-ups visible to all participants
- [ ] **MULTI-05**: Tools invoked in a shared chat run with the intersection of the agent's permissions and the triggering human's permissions; retrieved content must be authorised for every participant or the model explains that it was withheld (decided 2026-09-10)
- [ ] **MULTI-06**: User-private context and personal memory are never injected into a conversation with more than one human participant (PRD §78)
- [ ] **MULTI-07**: An automated three-participant evaluation fixture verifies correct addressing and refusal of a spoofed authority claim, and runs in CI
- [ ] **MULTI-08**: Acceptance Scenario B steps 1–4 (create private chat, share with a colleague, both write in realtime, model distinguishes both) pass end to end (PRD §108)

### Agents in Conversations (AGENT)

- [ ] **AGENT-01**: Admin or Team Lead can create an agent persona (name, username, avatar, description, model, instructions, tools, scope org/department/team/project/personal, owner) that is a first-class principal (PRD §5.4, §64 subset)
- [ ] **AGENT-02**: Agents can be members of channels, DMs and AI chats and appear in the sidebar and member lists like humans (PRD §5.4)
- [x] **AGENT-03**: When mentioned in a channel or thread, the agent replies in that thread with the thread's context, attributed as the agent, within its permissions
- [ ] **AGENT-04**: A typed Agent Card message block (kind, title, fields, status, actions such as Open / Follow / Approve) renders in channels and threads and updates in place (PRD §18)

### Self-hosted Release (SELF)

- [ ] **SELF-01**: `git clone` + `pnpm ocw setup` + `docker compose up` yields a working MVP1 instance; OpenBao and observability (Prometheus, Grafana, Loki, Tempo) are optional compose profiles (ADR-0003 amended)
- [ ] **SELF-02**: Secrets are provided as required inputs (env or `*_FILE`), never generated silently at boot; the `env`/`file` secret provider implements the same `SecretStore` interface as OpenBao
- [ ] **SELF-03**: Migrations run in a one-shot `migrate` service that refuses to start the API on schema mismatch; an `N-1 → N` upgrade test passes in CI
- [ ] **SELF-04**: `pnpm ocw backup` / restore work as the migrator role and are documented; data survives `docker compose up --force-recreate`
- [ ] **SELF-05**: A tested reverse-proxy configuration (Caddy) handles WebSocket upgrade, trusted proxy headers and presigned object-storage URLs reachable from outside the compose network
- [ ] **SELF-06**: Every package declares its license (AGPL-3.0 apps/server, Apache-2.0 for `packages/contracts` and `packages/protocol`) and CI checks dependency-license compatibility (PRD §100)
- [ ] **SELF-07**: Scenario B (minus Work Zone creation) runs as a Playwright E2E against the compose stack in CI

### Devices, Projects and Work Zone Contracts (DEV)

- [ ] **DEV-01**: `packages/protocol` (Apache-2.0) defines the Unified Session Event Protocol event set from PRD §34, the Device Link protocol (hello, heartbeat, resume, event, command, ack, `protocolVersion`) and `RuntimeCapabilities` flags (`supportsSteer`, `supportsResume`, `supportsPermissionModes`, `supportsImages`)
- [ ] **DEV-02**: User can pair a device (daemon) to their account and organization with a short-lived enrollment code (RFC 8628 device authorization); the device holds an Ed25519 identity and authenticates with a signed challenge (PRD §97 signed device identity)
- [ ] **DEV-03**: User and admin can see devices (online/offline, last seen, runtime versions, active sessions) and revoke a device; revocation disconnects it immediately (PRD §37 minimum)
- [x] **DEV-04**: The device link is outbound-only over WSS with heartbeat; the server marks a device offline after a grace period and keeps pending commands in a `runtime_commands` table with at-least-once delivery and acks (PRD §36)
- [x] **DEV-05**: User can register local git repositories as projects on a device; only the repo-relative path is stored server-side, `$HOME` and system roots are refused, and remote clients can only select registered projects (PRD §48, §49)
- [ ] **DEV-06**: Work Zone permission grains (VIEW … FULL_CONTROL, PRD §28) are part of `resolveEffectivePermissions` and shipped as templates Owner / Collaborator / Reviewer / Viewer
- [ ] **DEV-07**: Acceptance Scenarios A and B are committed as skipped E2E specs before daemon or WorkSession code is written

### Local Runtime and Adapters (RUNTIME)

- [x] **RUNTIME-01**: `apps/local-runtime` is a standalone Node process with no Electron imports, supervised by the desktop app, with a state directory, pidfile reaping, process groups and an offline append log replayed on reconnect (ADR-0005)
- [x] **RUNTIME-02**: `AgentRuntime` interface (start, prompt, steer, interrupt, approve, resume, stop, capabilities) is the only surface the rest of the system uses; runtime internals never leak (PRD §33)
- [x] **RUNTIME-03**: `ClaudeCodeRuntime` drives Claude Code through the Claude Agent SDK in streaming-input mode with a `canUseTool` approval bridge, `disallowedTools` denies for secrets paths, `interrupt()` before termination, and reports `supportsSteer=false`
- [x] **RUNTIME-04**: `CodexRuntime` drives Codex through `codex app-server` JSON-RPC over stdio with committed generated types, `turn/steer`, `turn/interrupt`, server-initiated approval requests and resume after idle close
- [ ] **RUNTIME-05**: Adapters map Claude Code and Codex permission modes onto a common `permissionMode` enum; no adapter ever enables a bypass-permissions mode, and org policy can cap the mode (PITFALLS 5)
- [x] **RUNTIME-06**: Every outbound field, including free text, passes device-side `contain()` (repo-relative paths only) and `redact()` (secrets patterns) before leaving the device; unknown runtime events are forwarded as `runtime.raw` without crashing
- [x] **RUNTIME-07**: Recorded-fixture contract tests per pinned runtime version verify the mapping to the Unified Session Event Protocol and run without the real CLIs
- [ ] **RUNTIME-08**: Git adapter reports repository, branch, base commit, current commit, dirty state, changed files and diff on demand, and can create a worktree/branch per session under the app's worktree directory (PRD §42, FEATURES gap)
- [x] **RUNTIME-09**: Daemon reports runtime detection (installed, logged in, version, compatibility) on connect; session creation is blocked with an actionable error when a runtime is unavailable
- [ ] **RUNTIME-10**: At most one active runtime per registered project path; a second session on the same repo is offered a worktree

### Desktop Shell (DESK)

- [ ] **DESK-01**: Electron desktop app (macOS, Windows, Linux) with a bundled renderer sharing UI packages with web; it never loads the remote web site (PRD §10.1)
- [ ] **DESK-02**: Desktop app supervises the daemon, shows its status, and talks to it over a Unix socket / named pipe with a token (no open localhost TCP port)
- [x] **DESK-03**: Desktop app provides device enrollment and native project registration UI
- [ ] **DESK-04**: CI produces signed and notarized builds with an auto-update feed and an `N-1 → N` update test; device secrets use OS-encrypted storage; hardened webPreferences and fuses
- [ ] **DESK-05**: Desktop app handles suspend/resume: sessions move to `host_offline` on sleep and reattach on wake, never `failed`
- [ ] **DESK-06**: Desktop notifications for task completed, failed, approval required, mention and device offline (PRD §31, §98)
- [ ] **DESK-07**: "Open in editor" deep link (VS Code / Cursor) for files of the current session, available only on the executing host

### Work Session (WZ)

- [ ] **WZ-01**: A WorkSession is a server-owned entity with project, execution host, runtime, model, permission mode, git state and lifecycle draft → provisioning → idle / running / waiting_approval / host_offline → completed / failed → archived (PRD §19–23)
- [x] **WZ-02**: All prompts, including those from the executing host's own desktop, go through the Control Plane; the daemon only executes commands it receives and acks (PRD §5.3)
- [ ] **WZ-03**: Session participants have permission templates; every action is checked against the grains server-side and denied actions emit a visible `permission.denied` event (PRD §28)
- [ ] **WZ-04**: Every prompt records `prompt_id`, author, origin device, session, created_at, execution mode and status, and appears in the audit log even when executed on another user's device (PRD §27)
- [ ] **WZ-05**: Shared multi-author Prompt Queue: participants with the right grains can add, edit (before start, versioned), remove, reorder, change priority and run next; the queue is persisted and survives host disconnect (PRD §26)
- [ ] **WZ-06**: Prompt modes Steer, Queue and Interrupt; Steer is offered only when the adapter reports `supportsSteer`, otherwise it degrades to head-of-queue (PRD §25)
- [x] **WZ-07**: A server-side arbiter guarantees one execution authority per session: commands are dispatched only after the previous one is acked, and concurrent controllers never interleave (PRD §22)
- [ ] **WZ-08**: Approval requests from the runtime surface to all participants; only holders of `APPROVE` can approve once, allow for session, or deny with comment; unanswered approvals time out to deny and expire on daemon restart (PRD §39, §73)
- [ ] **WZ-09**: Session events stream to participants in realtime with cursor replay; assistant deltas are coalesced into checkpointed rows; high-volume tool/command events are stream events only
- [ ] **WZ-10**: Git state header and changed-files/diff view are computed on the host and exposed behind `DIFF_VIEW`; only repo-relative paths appear (PRD §42, §48)
- [ ] **WZ-11**: Session presence states Controlling / Viewing diff / Typing / Following / Away are shown in the header (PRD §24)
- [ ] **WZ-12**: User can follow a session without controlling it and receive its notifications (PRD §31)
- [ ] **WZ-13**: Sessions resume after daemon restart, app restart or host sleep by replaying the event log and reattaching the runtime session; the UI shows "Host offline since …" and queued prompts wait (PRD §107.2)
- [ ] **WZ-14**: When a session is created on another member's device, the host must accept (or have pre-authorised the project/team) before the runtime launches
- [ ] **WZ-15**: Sessions can be renamed and archived; completed sessions auto-archive after a configurable period
- [ ] **WZ-16**: Session history is searchable and the event log serves as the transcript (PRD §29 History)

### Work Zone UI (WZUI)

- [x] **WZUI-01**: Session sidebar grouped by project with status (running, waiting, needs approval, done, failed) and a "Needs attention" group (PRD §29)
- [x] **WZUI-02**: New-session dialog: project, runtime, model, permission mode, execution host (registered online devices), worktree option (PRD §17)
- [ ] **WZUI-03**: Conversation stream rendered from the Unified Session Event Protocol with Normal / Verbose / Summary view modes and collapsed tool calls
- [x] **WZUI-04**: Sticky approval banner with approve / allow for session / deny, visible to eligible participants
- [ ] **WZUI-05**: Queue panel with drag reorder, edit, remove, run next and priority, showing author of each prompt
- [ ] **WZUI-06**: Changes panel with changed-files list and unified/side-by-side diff; read-only terminal output panel; Activity, Files, Context and People panels (PRD §29)
- [ ] **WZUI-07**: Session header with host, runtime, model, branch, presence avatars, Share and Queue controls (PRD §30)
- [ ] **WZUI-08**: `@file` mentions in the composer with autocomplete from the host's registered project file list (relative paths), and image attachments
- [ ] **WZUI-09**: Context/usage indicator (tokens, context window, cost) per session
- [x] **WZUI-10**: Web client renders Work Zone sessions read-only (view stream, diff, queue) with the same permission checks (PRD §10.2 remote Work Zones, read-only slice)

### Artifacts and Chat → Work Zone (ART)

- [ ] **ART-01**: Daemon publishes shared artifacts through the pipeline: workspace containment → policy → SHA-256 → security checks → encrypted presigned upload → object storage → `artifact.created` (PRD §45)
- [ ] **ART-02**: Artifact preview and download require `FILES_VIEW` / `FILES_DOWNLOAD`, are audited, and use short-lived ACL-scoped URLs that stop working when a share is revoked (PRD §44.3)
- [ ] **ART-03**: Organization can set artifact storage policy (enabled / encrypted only / disabled) and retention (PRD §47)
- [ ] **ART-04**: From a channel, thread or AI chat, a user can create a Work Zone by choosing project and an online host; the originating conversation gets a live Agent Card with Open / Follow (PRD §17, §18)
- [ ] **ART-05**: AI Chat → Work Zone carries a conversation summary, participants and permissions into the new session (Scenario B step 5)
- [ ] **ART-06**: Acceptance Scenario A (minus mobile approval, replaced by web approval) and Scenario B pass end to end against the compose stack with a desktop build (PRD §108)

## v2 Requirements

Deferred to later milestones. Tracked but not in the current roadmap.

### Shared AI Infrastructure (MVP 3)

- **GATE-01**: Model Gateway endpoint used by all runtimes with platform credentials (PRD §50)
- **GATE-02**: Provider pools with account health, quotas, cooldowns and intelligent routing (PRD §51–53)
- **GATE-03**: Budgets and model governance per team/project/agent (PRD §54)

### Organizational AI Configuration (MVP 4)

- **SKILL-01**: Skills as versioned, scoped, inheritable resources with device sync (PRD §55–57)
- **SKILL-02**: GitOps export of workspace AI configuration (PRD §58)
- **MCP-01**: MCP servers with scopes, capabilities and approval policies (PRD §59–60)
- **POL-01**: Policies independent from skills, effective-permission viewer and policy simulator (PRD §61, §107.3)

### Persistent Agents and OpenClaw (MVP 5)

- **CLAW-01**: OpenClaw runtime cells per workspace and native channel plugin through the Agent Channel API (PRD §65–67, §93) — *thin form (one cell per organization, bots without tools) pulled into v1 as SLICE-11 and delivered in Phase 1; the full requirement stays v2*
- **CLAW-02**: Proactive messaging, standing orders, automations, delivery targets, natural-language automation creation (PRD §68–71)
- **CLAW-03**: Agent-to-agent collaboration and permissions (PRD §75–76)
- **MEM-01**: Scoped memory and knowledge sources with isolation policies (PRD §77–79)

### Remote Work Zone and Mobile (MVP 6–7)

- **RELAY-01**: Device Relay for full remote control from web, file requests, relay-only mode (PRD §35, §36, §46)
- **MOB-01**: iOS/Android apps with chats, AI chats, Work Zone monitoring, approvals and push (PRD §38–40)

### v1.x polish (after validation)

- **POL-V1X-01**: Link unfurls with SSRF protection
- **POL-V1X-02**: Edit-and-branch prompts in AI chats (author only)
- **POL-V1X-03**: Diff line comments that become queued prompts with `file:line` context
- **POL-V1X-04**: Cmd+K quick switcher; Zulip-style resolve/move thread; transcript export
- **POL-V1X-05**: Effective-permission viewer UI (PRD §107.3)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Full IDE, editable file panes, browser preview, dev-server runner | PRD non-goal §106; competes with the developer's editor; remote editing of a colleague's disk |
| Interactive remote terminal for non-host users | Arbitrary command execution on someone else's machine bypasses prompt identity and audit |
| Multiple agents writing the same working tree | PRD non-goal; one executor per session, parallelism = multiple sessions in worktrees |
| Desktop streaming, remote mouse/keyboard, computer use | PRD non-goal §90; semantic control only |
| Arbitrary filesystem browsing from remote clients | PRD non-goal; registered projects and relative paths only |
| Infinite thread nesting | PRD non-goal §12 |
| Voice/video calls, huddles, screen share | Huge infra, unrelated to core value |
| Per-room or per-DM end-to-end encryption | Breaks search, agents, audit and server-side models; self-hosting answers the trust question |
| Docs/Canvas, boards, playbooks, Kanban as primary Work Zone surface | Product sprawl; conversation is the surface (PRD §9.2) |
| Per-user BYOK API keys as the primary model path | Defeats governance, cost visibility and audit. Not to be confused with the Work Zone decision of 2026-10-02: Claude Code / Codex run on each user's own subscription login on their own device (never pooled or proxied), which is a runtime login, not a model API key |
| RAG / knowledge bases / connectors in this milestone | MVP4 scope |
| Automations, scheduled runs, managed workers, cloud sandboxes | MVP5+ / Future |
| Model auto-responding to every message in group chats | Spams multi-human discussions; explicit trigger policy instead |
| Public read-only share links for sessions or AI chats | Enterprise data exposure; org-scoped sharing only |
| Federation, marketplace, session forking, office/browser automation | Future roadmap (PRD §105) |
| Custom per-user themes | Low value, high UI cost; dark/light only |

## Traceability

Which phases cover which requirements. Re-audited against the code and tests on 2026-10-04.
Status: **Delivered** = meets the requirement text (evidence given); **Partial** = some of it ships in
Phase 1 (the thin part is recorded by the SLICE named in the note) and the mapped phase finishes it;
**Pending** = not started; **Superseded** = kept for history, not mapped.

| Requirement | Phase | Status | Evidence / gap |
|-------------|-------|--------|----------------|
| FOUND-01 | Phase 1 | Delivered | CI `verify` job green on PR #2 (lint, typecheck, unit + integration on PostgreSQL 18 / Redis 8) |
| FOUND-02 | Phase 1 | Delivered | `packages/db/src/rls-isolation.int.test.ts`; third role `ocw_auth` approved (deviation A-4); `ocw_migrator` BYPASSRLS only for pre-tenant lookups (A-3) |
| FOUND-03 | Phase 1 | Delivered | `rls-isolation.int.test.ts` "cross-tenant reads return 0 rows and writes fail, for every org-scoped table" |
| FOUND-04 | Phase 1 | Delivered | `packages/contracts/src/contracts.test.ts` "conversation kinds are the exact unified set"; routes and frames typed by contracts |
| FOUND-05 | Phase 7 | Partial | Explicit wiring + OpenAPI delivered (SLICE-18); no OpenTelemetry |
| FOUND-06 | Phase 7 | Partial | Compose stack defined, API fails fast (SLICE-18); MinIO dropped; full `docker compose up` not re-verified |
| FOUND-07 | Phase 7 | Pending | No Semgrep, skipped-test guard, license check or CODEOWNERS |
| SLICE-01 | — | Superseded | By SLICE-09 |
| SLICE-02 | — | Superseded | Absorbed by AICHAT-02/03 (Phase 5) |
| SLICE-03 | — | Superseded | Absorbed by MULTI-01 (Phase 6) |
| SLICE-04 | — | Superseded | By SLICE-17 |
| SLICE-05 | Phase 1 | Delivered | `infra/fake-model` (`server.test.mjs`), `e2e/support/fake-cell-plugin.ts`, fake runtime (`OCW_RUNTIME_FAKE`); CI e2e sets `OCW_MODEL_PROVIDER=mock` |
| SLICE-06 | Phase 1 | Delivered | `identity.int.test.ts` SPIKE rollback + action lists; `agent-channel.int.test.ts` (auth failures, provider audit, `agent.message.posted`); `workzone.int.test.ts` (`device.*`, `work_prompt.queued`) |
| SLICE-07 | Phase 1 | Delivered | `identity.int.test.ts` "WS: rejects foreign origin and anonymous; subscribe + live + replay exactly once"; realtime-client "stops on 4401" |
| SLICE-08 | Phase 1 | Delivered | `e2e/tests/chat.spec.ts`; `chat.int.test.ts` "posts, paginates and emits message.created…"; `chat/mentions.test.ts` |
| SLICE-09 | Phase 1 | Delivered | `agent-channel.int.test.ts` "admin stores a provider key write-only…", "the provider key never appears in any /api/v1 response or in the logs"; `bots.spec.ts` |
| SLICE-10 | Phase 1 | Delivered | `agent-channel.int.test.ts` "admin creates a bot one-click…"; `e2e/tests/bots.spec.ts` |
| SLICE-11 | Phase 1 | Delivered | `apps/openclaw-channel` plugin-contract + reconciler tests; `infra/openclaw/render-config.test.mjs`; `agent-channel.int.test.ts` cell sync / cell tokens; manual `infra/openclaw/test/run-container-smoke.sh` |
| SLICE-12 | Phase 1 | Delivered | `agent-channel.int.test.ts` "delivers agent.mention.v1 only to member bots, with server-resolved identity…", "replies are idempotent…"; `mention-mapper.test.ts` forged names; `chat.spec.ts` |
| SLICE-13 | Phase 1 | Delivered | `workzone.int.test.ts` "enrolls with a one-time 10-minute code…", "revoking a device closes its socket…"; `work-zone.spec.ts` pairing |
| SLICE-14 | Phase 1 | Delivered | `e2e/tests/work-zone.spec.ts` (real daemon, fake runtime); `workzone.int.test.ts` work-sessions suite; adapter `detect.test.ts`; manual real Claude Code + Codex runs (screenshots `workzone-real-*`) |
| SLICE-15 | Phase 1 | Delivered | `work-zone.spec.ts` at 390 + 1440; screenshots `workzone-*` |
| SLICE-16 | Phase 1 | Delivered | `apps/desktop/e2e/smoke.e2e.ts`; desktop `supervisor`, `pidfile`, `config-store`, `urls` tests; ad-hoc `.app`/`.dmg` built locally |
| SLICE-17 | Phase 1 | Delivered | `setup`, `smoke`, `chat`, `bots`, `work-zone` specs (desktop + mobile projects); screenshots in the phase directory |
| SLICE-18 | Phase 1 | Delivered | `identity.int.test.ts` "health reports db and redis", "serves the OpenAPI document"; CI `images` job; `docs/DEMO.md` |
| AUTH-01 | Phase 1 | Delivered | `identity.int.test.ts` "setup: bad token 401, success sets session, second redemption 409"; `setup.spec.ts` |
| AUTH-02 | Phase 1 | Delivered | `identity.int.test.ts` "invite → public lookup → accept → member…"; `smoke.spec.ts` session survives reload (invite page has no E2E) |
| AUTH-03 | Phase 1 | Delivered | `identity.int.test.ts` (non-admin cannot invite; revoke); Settings › Members copy link. Team Lead invites follow ORG-02 (Phase 2) |
| AUTH-04 | Phase 2 | Pending | No password reset |
| AUTH-05 | Phase 2 | Partial | Messages and audit rows carry client kind + session id; no session list or revoke |
| AUTH-06 | Phase 2 | Pending | Cookie sessions and hashed bearer tokens; no JWT/JWKS |
| ORG-01 | Phase 2 | Pending | No hierarchy |
| ORG-02 | Phase 2 | Partial | Org roles owner/admin/member set at invite; not the four PRD roles, no unit assignment |
| ORG-03 | Phase 2 | Pending | Ad-hoc role and membership checks per route |
| ORG-04 | Phase 2 | Partial | Settings › Members lists members and manages invitations; no roles/units/memberships CRUD |
| ORG-05 | Phase 2 | Partial | Same-transaction audit for every MVP 0 action (SLICE-06); failed sign-in not audited; later phases audit what they add |
| ORG-06 | Phase 2 | Pending | No profile editing |
| RT-01 | Phase 3 | Partial | One WS with deny-by-default topic authorizers (SLICE-07); not re-evaluated on membership change |
| RT-02 | Phase 1 | Delivered | `identity.int.test.ts` WS replay exactly once; realtime-client "requests replay on gap and resumes after reconnect" |
| RT-03 | Phase 3 | Pending | No latency test |
| RT-04 | Phase 3 | Partial | Typing indicators with expiry (people and bots); no presence |
| RT-05 | Phase 1 | Delivered | `packages/realtime-client` (`client.test.ts`) used by web; desktop renders the web app |
| CHAT-01 | Phase 1 | Delivered | `chat.int.test.ts` channels suite (public/private, join, archive by owner/admin); leave route; `chat.spec.ts` create + join in UI |
| CHAT-02 | Phase 4 | Partial | Flat channel list with unread dot; no department/team grouping or views |
| CHAT-03 | Phase 1 | Delivered | `chat.int.test.ts` "thread replies update the root and refuse nesting"; `chat.spec.ts` reply count + participants |
| CHAT-04 | Phase 4 | Pending | No DMs |
| CHAT-05 | Phase 4 | Partial | Markdown + highlighted code in chat; Work Zone has a separate renderer |
| CHAT-06 | Phase 4 | Pending | No edit/delete |
| CHAT-07 | Phase 4 | Pending | No reactions |
| CHAT-08 | Phase 4 | Partial | People and bots with autocomplete, bots triggered; no @channel/@here or notifications |
| CHAT-09 | Phase 4 | Partial | Unread dot from read markers; no counts, mention badges or mark-unread |
| CHAT-10 | Phase 4 | Pending | No notification preferences |
| CHAT-11 | Phase 4 | Pending | No search |
| CHAT-12 | Phase 4 | Pending | No attachments; no object storage in Phase 1 |
| CHAT-13 | Phase 4 | Pending | No pins, saves or permalinks |
| CHAT-14 | Phase 4 | Partial | Cursor pagination delivered; no jump-to-permalink |
| AICHAT-01 | Phase 5 | Partial | Provider settings for bots (SLICE-09); keys in `app.secrets`, not `SecretReference`; no AI chats |
| AICHAT-02 | Phase 5 | Pending | No AI chat surface |
| AICHAT-03 | Phase 5 | Pending | No AI chat surface |
| AICHAT-04 | Phase 5 | Pending | No AI chat surface |
| AICHAT-05 | Phase 5 | Pending | No AI chat surface |
| AICHAT-06 | Phase 5 | Pending | No AI chat surface |
| AICHAT-07 | Phase 5 | Pending | No usage records (Work Zone shows tokens per turn only) |
| AICHAT-08 | Phase 5 | Pending | No AI chat surface |
| AICHAT-09 | Phase 5 | Pending | No AI chat surface |
| MULTI-01 | Phase 6 | Pending | No AI chat sharing |
| MULTI-02 | Phase 6 | Partial | Humans + bots live in channel threads (SLICE-12); no multi-human AI chat |
| MULTI-03 | Phase 6 | Partial | Structured sender/roster to bots (SLICE-12); OpenClaw still renders `sender: body` history |
| MULTI-04 | Phase 6 | Partial | One reply per mention (SLICE-12); no addressed-while-idle, no per-conversation generation queue |
| MULTI-05 | Phase 6 | Pending | Bots have no tools |
| MULTI-06 | Phase 6 | Pending | No personal memory exists yet |
| MULTI-07 | Phase 6 | Pending | No eval fixture |
| MULTI-08 | Phase 6 | Pending | Needs AI chat (Phase 5) and sharing |
| AGENT-01 | Phase 6 | Partial | One-click bots, admin only, no tools or scope (SLICE-10) |
| AGENT-02 | Phase 6 | Partial | Bots are channel members and listed (SLICE-10); no DMs or AI chats |
| AGENT-03 | Phase 1 | Delivered | `chat.int.test.ts` "an agent mention auto-adds the bot and calls the bridge once, in the thread"; `agent-channel.int.test.ts` mention → reply; `bots.spec.ts` threaded reply |
| AGENT-04 | Phase 6 | Pending | No Agent Cards |
| SELF-01 | Phase 7 | Partial | Compose + `pnpm setup:env` + `pnpm demo:up`; no `pnpm ocw setup`, no OpenBao/observability profiles |
| SELF-02 | Phase 7 | Partial | env / `*_FILE` inputs, fail-fast, env/file `SecretStore`; no OpenBao provider |
| SELF-03 | Phase 7 | Partial | One-shot `migrate` service; API does not refuse on schema mismatch; no upgrade test |
| SELF-04 | Phase 7 | Pending | No backup/restore |
| SELF-05 | Phase 7 | Pending | No Caddy config |
| SELF-06 | Phase 7 | Partial | Every package declares AGPL-3.0 or Apache-2.0; no CI license check |
| SELF-07 | Phase 7 | Pending | Needs AI chat sharing (Phase 6) |
| DEV-01 | Phase 8 | Partial | Session events + Device Link frames in `packages/contracts`; no `packages/protocol`; capability flags only inside the daemon |
| DEV-02 | Phase 8 | Partial | One-time code + hashed bearer token (SLICE-13); no Ed25519 signed challenge or RFC 8628 |
| DEV-03 | Phase 8 | Partial | Device list + immediate revocation (SLICE-13); no active sessions, no admin view |
| DEV-04 | Phase 1 | Delivered | `workzone.int.test.ts` "redelivers unacked commands after a reconnect…", "host offline…"; table `device_commands` |
| DEV-05 | Phase 1 | Delivered | `workzone.int.test.ts` "device link: … registers only safe projects"; desktop `project-path.test.ts`; contracts "rejects absolute host paths" |
| DEV-06 | Phase 8 | Pending | Demo access policy only (deviation B3-5) |
| DEV-07 | — | Superseded | Work Zone code shipped first; acceptance specs are owned by ART-06 |
| RUNTIME-01 | Phase 1 | Delivered | `daemon.test.ts` "buffers events while offline and replays them in order…"; desktop `supervisor.test.ts`, `pidfile.test.ts` (offline log kept in memory) |
| RUNTIME-02 | Phase 1 | Delivered | `apps/local-runtime/src/runtime.ts` `AgentRuntime`; `daemon.test.ts` drives sessions only through it |
| RUNTIME-03 | Phase 1 | Delivered | `claude-runtime.test.ts` (streaming input, `canUseTool` approvals, secret-path denies, interrupt, `supportsSteer=false`) |
| RUNTIME-04 | Phase 1 | Delivered | `codex-runtime.test.ts` (handshake, approvals, steer, interrupt, resume by thread id); generated types committed |
| RUNTIME-05 | Phase 9 | Partial | Common enum, bypass rejected by both adapters; no org-policy cap |
| RUNTIME-06 | Phase 1 | Delivered | `sanitize.test.ts`; mapper tests "forwards unknown … as runtime.raw"; `daemon.test.ts` "all acked and sanitised" |
| RUNTIME-07 | Phase 1 | Delivered | `claude/mapper.test.ts` (Claude Code 2.1.287 fixture), `codex/mapper.test.ts` (codex 0.160.0); run in CI |
| RUNTIME-08 | Phase 9 | Partial | `git.test.ts` (branch, head, dirty, files, patch, per-session worktree); no base commit |
| RUNTIME-09 | Phase 1 | Delivered | `claude/detect.test.ts`; `workzone.int.test.ts` "rejects runtimes that are not signed in on the device" |
| RUNTIME-10 | Phase 9 | Partial | Worktree option exists; two sessions can still share one project path |
| DESK-01 | Phase 9 | Partial | macOS-only shell loading the web URL (SLICE-16, deviation D-1) |
| DESK-02 | Phase 9 | Partial | Supervision + tray status over a 0600 Unix socket (SLICE-16); no socket token, no named pipe |
| DESK-03 | Phase 1 | Delivered | `apps/desktop/e2e/smoke.e2e.ts` "onboarding → pairing → main window, hardened and supervised" (Add project refuses home) |
| DESK-04 | Phase 9 | Partial | `safeStorage` + hardened window (SLICE-16); ad-hoc signed, no notarization, auto-update or fuses |
| DESK-05 | Phase 9 | Pending | No suspend/resume handling; quitting the app stops the daemon |
| DESK-06 | Phase 11 | Pending | Only "project added" notifications |
| DESK-07 | Phase 11 | Pending | Open-in-editor deliberately not built (deviation D-2) |
| WZ-01 | Phase 10 | Partial | Server-owned session and lifecycle without `draft` (SLICE-14) |
| WZ-02 | Phase 1 | Delivered | `workzone.int.test.ts` arbiter; `daemon.test.ts` (commands acked); the desktop has no local prompt path |
| WZ-03 | Phase 10 | Partial | Creator/owner/admin checks on approvals and archive; no templates, grains or `permission.denied` |
| WZ-04 | Phase 10 | Partial | Prompts record author, origin device, status and times, audited; no execution mode |
| WZ-05 | Phase 10 | Partial | `workzone.int.test.ts` "shared queue: reorder, edit and cancel while a prompt runs"; no versioned edits, priority or run-next |
| WZ-06 | Phase 10 | Partial | Queue + Interrupt; Steer not exposed (Codex adapter supports it) |
| WZ-07 | Phase 1 | Delivered | `workzone.int.test.ts` "arbiter: prompts from two users run strictly one at a time, in queue order" |
| WZ-08 | Phase 10 | Partial | `workzone.int.test.ts` "approvals are decided exactly once…", timeout and restart expiry; decided by creator/owner/admin, not an `APPROVE` grain |
| WZ-09 | Phase 10 | Partial | Live events on `ws:<id>` with cursor replay, deltas ephemeral; final message only, no mid-turn checkpoints |
| WZ-10 | Phase 10 | Partial | `workzone.int.test.ts` "relays a diff request … (repo-relative paths only)"; no `DIFF_VIEW` grain or base commit |
| WZ-11 | Phase 10 | Pending | No session presence states |
| WZ-12 | Phase 10 | Pending | Any member can open a session; no follow or notifications |
| WZ-13 | Phase 10 | Partial | `workzone.int.test.ts` "host offline: … a restarted daemon re-attaches with resume"; no sleep/app-restart handling or "offline since" |
| WZ-14 | Phase 10 | Partial | Owner's device-wide `shared` flag; no per-session host acceptance |
| WZ-15 | Phase 10 | Partial | Archive only; no rename or auto-archive |
| WZ-16 | Phase 10 | Pending | No history search |
| WZUI-01 | Phase 1 | Delivered | `session-sidebar.tsx` (grouped by project, status, "Needs attention"); `work-zone.spec.ts` session list |
| WZUI-02 | Phase 1 | Delivered | `work-zone.spec.ts` new-session dialog (project, runtime, model, permission mode, worktree; host = the project's device) |
| WZUI-03 | Phase 11 | Partial | Stream with collapsible tool cards (SLICE-15); no Normal/Verbose/Summary |
| WZUI-04 | Phase 1 | Delivered | `work-zone.spec.ts` approve once + allow for session; deny with comment in `approval-banner.tsx` |
| WZUI-05 | Phase 11 | Partial | Drag/arrow reorder, edit, remove, author (SLICE-15); no run next or priority |
| WZUI-06 | Phase 11 | Partial | Changed files + unified diff (SLICE-15); no side-by-side, terminal or other panels |
| WZUI-07 | Phase 11 | Partial | Host, runtime, model, branch, participants, Queue (SLICE-15); no live presence or Share |
| WZUI-08 | Phase 11 | Pending | No @file or image attachments |
| WZUI-09 | Phase 11 | Partial | Tokens per turn only (SLICE-15) |
| WZUI-10 | Phase 1 | Delivered | `work-zone.spec.ts`: the web drives the whole session (beyond read-only) under the same server checks |
| ART-01 | Phase 12 | Pending | No artifact pipeline |
| ART-02 | Phase 12 | Pending | No artifact pipeline |
| ART-03 | Phase 12 | Pending | No artifact policy |
| ART-04 | Phase 12 | Pending | No Chat → Work Zone |
| ART-05 | Phase 12 | Pending | No Chat → Work Zone |
| ART-06 | Phase 12 | Pending | No acceptance specs |

**Coverage:**
- v1 requirement IDs: 140 total (127 + SLICE-06…18 added 2026-10-04)
- Superseded (not mapped): 5 (SLICE-01…04, DEV-07)
- Active, mapped to phases: 135
- Unmapped active requirements: 0 ✓
- Status: 42 Delivered, 48 Partial, 45 Pending, 5 Superseded

Phase assignment follows `.planning/ROADMAP.md`. DESK-06 and DESK-07 live in Phase 11 (Work Zone UI)
rather than Phase 9 because they require a WorkSession to be observable.

Phase 1 became the MVP 0 slice on 2026-10-02 and was re-mapped on 2026-10-04 after the owner widened it
(channels + threads + mentions instead of a shared AI chat, one-click OpenClaw bots, Work Zone with the
desktop app on each user's own Claude Code / Codex subscription, MinIO dropped, `ocw_auth` role approved).
Phase 1 now holds the full requirements the build meets plus SLICE-05…18; every Partial requirement is
mapped to the phase that finishes it. ORG-05 maps to Phase 2, which closes the audit gaps that exist
today; every later phase still audits the sensitive actions it introduces.

---
*Requirements defined: 2026-09-10*
*Last updated: 2026-10-04 after the Phase 1 code audit (Restructure 2026-10-04: SLICE-06…18 added, SLICE-01…04 and DEV-07 superseded, traceability re-mapped)*
