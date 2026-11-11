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
- [x] **FOUND-05**: Fastify Control Plane skeleton loads modules through explicit constructor wiring, exposes OpenAPI from Zod schemas, and emits OpenTelemetry traces/metrics/logs via `@fastify/otel` (ADR-0002, ADR-0003)
- [x] **FOUND-06**: `docker compose up` minimal profile (postgres, redis, garage, api, web, one-shot `migrate` and the OpenClaw cell) starts and fails fast with a clear message when a required secret is missing (PRD §5.1)
- [x] **FOUND-07**: `pnpm verify` fails on permission-bypass tokens (Semgrep), skipped policy tests, and license violations; CODEOWNERS covers db policies, auth, adapters and policy paths (PITFALLS 13)

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
- [x] **AUTH-04**: User can reset their password (email when SMTP configured, admin-issued link otherwise)
- [x] **AUTH-05**: User can view and revoke their active sessions; every session carries a device/client identifier used for message attribution (PRD §15)
- [x] **AUTH-06**: API, WebSocket and daemon connections are authenticated with short-lived JWTs verified against a JWKS endpoint; identity is provided by better-auth embedded in the API (STACK decision)

### Organization and Permissions (ORG)

- [x] **ORG-01**: Admin can create and manage the hierarchy Organization → Department → Team → Project, including moving units (PRD §7)
- [x] **ORG-02**: Admin can assign users to units with one of the four roles: Standard User, Developer, Team Lead/Manager, Organization Admin (PRD §6)
- [x] **ORG-03**: A single `resolveEffectivePermissions` function computes permissions as the intersection Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device with explicit-deny precedence, and every route uses it (PRD §61, §82)
- [x] **ORG-04**: Admin console provides CRUD pages for users, roles, departments, teams, projects and memberships (PRD §81 minimal)
- [x] **ORG-05**: Every sensitive action (auth, membership, permission change, sharing, message edit/delete, session control, approval, artifact access) writes an audit event in the same transaction with actor, agent, user, device, resource, action, result, timestamp, organization and session (PRD §84)
- [x] **ORG-06**: User can view and edit their profile (display name, avatar, status) and see other members' profiles

### Realtime (RT)

- [x] **RT-01**: Client keeps one authenticated WebSocket and subscribes to topics it is authorised for; authorisation is re-evaluated when membership changes (PRD §85)
- [x] **RT-02**: Every durable event is persisted with a per-stream monotonic `seq` before being published over Redis; a reconnecting client replays from `afterSeq` and never loses or duplicates events (PRD §97)
- [x] **RT-03**: Typical propagation of collaborative events between two connected clients is under 500 ms, measured in an automated test against the compose stack (PRD §85)
- [x] **RT-04**: Presence (online/away) and typing indicators are visible per conversation and expire automatically when a client disappears
- [x] **RT-05**: A shared realtime client package handles reconnect with backoff, resume, and exposes stores consumed by web and desktop

### Chat (CHAT)

- [x] **CHAT-01**: User can create, join, leave and archive public and private channels; private membership is enforced server-side (PRD §11)
- [x] **CHAT-02**: Sidebar groups channels by department/team with All, Mentions, Threads and AI Chats views (PRD §11.1)
- [x] **CHAT-03**: User can reply in a side-panel thread (single level, no nesting); the parent shows reply count and participants (PRD §12)
- [x] **CHAT-04**: User can open DMs and group DMs between humans, humans and agents, and mixed groups (PRD §13)
- [x] **CHAT-05**: Messages support a Markdown subset with syntax-highlighted code blocks, rendered by one renderer shared with AI chats and agent output
- [x] **CHAT-06**: Author can edit and delete their own messages (edited marker, prior versions kept for audit); admins can delete any message
- [x] **CHAT-07**: User can add emoji reactions to messages, thread replies and AI messages
- [x] **CHAT-08**: User can @mention users, agents, @channel and @here with autocomplete; mentions generate notifications and trigger agents
- [x] **CHAT-09**: Unread and mention badges per channel/DM, mark as read/unread, computed from read markers (`last_seq - last_read_seq`)
- [x] **CHAT-10**: User can set notification preferences: per-channel mute, do-not-disturb, mention-only, desktop/web toggle; the notification inbox honours them (PRD §98)
- [x] **CHAT-11**: User can search messages, people and channels with filters (channel, author, date) using PostgreSQL full-text search
- [x] **CHAT-12**: User can attach files and images (drag-and-drop, paste) through the artifact upload pipeline with preview and download
- [x] **CHAT-13**: User can pin messages per channel, save messages personally, and copy permalinks to messages and threads
- [x] **CHAT-14**: Message history loads with cursor pagination and jump-to-permalink

### Direct AI Chat (AICHAT)

- [x] **AICHAT-01**: Admin can configure organization-level model providers (API keys stored as `SecretReference` in the secret store) and an allowed-models list; personal API keys are not a supported path (PRD §54 thin slice)
- [x] **AICHAT-02**: User can create a private AI chat, pick a model from the allowed list, and switch model per message (PRD §14)
- [x] **AICHAT-03**: Responses stream in realtime to the author; user can stop generation (partial output persisted) and regenerate the last answer
- [x] **AICHAT-04**: AI chats get an auto-generated title and appear in a list the user can rename, archive and search
- [x] **AICHAT-05**: User can set custom instructions per chat and personal defaults
- [x] **AICHAT-06**: Tool toggles (Web, Company Knowledge, MCP, Skills) exist in the chat settings; only Web search is functional in this milestone, the rest are visibly disabled (PRD §14)
- [x] **AICHAT-07**: Every generation writes a usage record (model, provider, input/output tokens, cost estimate, requester) and the chat shows tokens per message
- [x] **AICHAT-08**: User can attach files/images to prompts for vision-capable models via the upload pipeline
- [x] **AICHAT-09**: User can create a read-only snapshot share link of an AI chat scoped to the organization (never public)

### Multiplayer AI Chat and Sharing (MULTI)

- [x] **MULTI-01**: Owner can share an AI chat in place with a person, team, department or organization; sharing is a grant on the same conversation, never a copy, and the share dialog states exactly what becomes visible (PRD §16)
- [x] **MULTI-02**: Several humans and the model participate in one conversation in realtime; every message records author, timestamp, device, context and permissions (PRD §15)
- [x] **MULTI-03**: The model receives structural participant identity (roster in the system prompt, server-generated attributed message blocks, consecutive human messages merged) and never plain-text name prefixes that a participant could spoof
- [x] **MULTI-04**: The model responds when @mentioned or when addressed while idle; at most one generation runs per conversation, with queued or coalesced follow-ups visible to all participants
- [x] **MULTI-05**: Tools invoked in a shared chat run with the intersection of the agent's permissions and the triggering human's permissions; retrieved content must be authorised for every participant or the model explains that it was withheld (decided 2026-09-10)
- [x] **MULTI-06**: User-private context and personal memory are never injected into a conversation with more than one human participant (PRD §78)
- [x] **MULTI-07**: An automated three-participant evaluation fixture verifies correct addressing and refusal of a spoofed authority claim, and runs in CI
- [x] **MULTI-08**: Acceptance Scenario B steps 1–4 (create private chat, share with a colleague, both write in realtime, model distinguishes both) pass end to end (PRD §108)

### Agents in Conversations (AGENT)

- [x] **AGENT-01**: Admin or Team Lead can create an agent persona (name, username, avatar, description, model, instructions, tools, scope org/department/team/project/personal, owner) that is a first-class principal (PRD §5.4, §64 subset)
- [x] **AGENT-02**: Agents can be members of channels, DMs and AI chats and appear in the sidebar and member lists like humans (PRD §5.4)
- [x] **AGENT-03**: When mentioned in a channel or thread, the agent replies in that thread with the thread's context, attributed as the agent, within its permissions
- [x] **AGENT-04**: A typed Agent Card message block (kind, title, fields, status, actions such as Open / Follow / Approve) renders in channels and threads and updates in place (PRD §18)

### Personal Bots and Bot Capabilities (BOT) — added 2026-10-04 by the owner

- [x] **BOT-01**: Any member allowed by policy (new permission `bot.create_personal`, granted to every role by default, deniable by rules) can create a personal bot from the same one-click flow; a personal bot is visible to and usable by its owner only (resolver-enforced); admins see its metadata (name, owner, model, capabilities, usage) for governance but never its conversations
- [x] **BOT-02**: Creating a personal bot creates a private direct conversation between the owner and the bot that appears in the owner's chat sidebar (Bots section) and that nobody else can read (RLS + resolver); deleting or disabling the bot archives it
- [x] **BOT-03**: In a bot's direct conversation the bot answers every message without an @mention, one generation at a time, using the conversation history as context; members can also open a direct conversation with any team bot they may use (personal history, invisible to others)
- [x] **BOT-04**: Per-bot capability toggles, editable by whoever manages the bot: internet access (web search + page fetch, read-only), persistent memory (per bot and per human, user-visible and clearable), current date/time in context, reply mode in channels (mentions only / every message), and a daily usage limit (turns per day)
- [x] **BOT-05**: An Organization Admin sets a capability policy (allow/deny each capability org-wide and separately for personal bots); a bot's effective capabilities are its toggles ∩ the policy, the UI shows a disabled toggle with the reason, and dangerous tools (shell/exec, filesystem writes, browser control, gateway admin) are never offered
- [x] **BOT-06**: Capabilities are enforced in the OpenClaw cell on every turn (only the effective tools are passed; internet content is treated as untrusted data and cannot trigger other actions); every web search/fetch is audited with bot, human, domain and result, and runs with the intersection of the bot's and the triggering human's permissions
- [x] **BOT-07**: Usage per bot is metered per day; when the daily limit is reached the bot replies with a clear notice instead of calling the model; owners and admins see today's usage against the limit
- [x] **BOT-08**: Bots can use MCP servers: an Organization Admin registers MCP servers (remote HTTP/SSE, or stdio servers that run sandboxed inside the OpenClaw cell) with credentials held as `SecretReference`s, and whoever manages a bot attaches registered servers to it (personal bots only from an admin-approved list); each server's tools are listed, can be individually enabled, run only with the intersection of the bot's and the asking human's permissions, are treated as untrusted output, and every call is audited (bot, human, server, tool, result)
- [x] **BOT-09**: The OpenClaw plugin system and its Marketplace (ClawHub) are integrated: an Organization Admin browses and searches the marketplace from Settings, sees each plugin's publisher, version, permissions/tools and risk, installs a pinned version into the cell after an explicit review step, and can update or uninstall it; installs are audited and allowlisted (nothing installs itself, auto-update stays off, dangerous tool classes stay blocked regardless of what a plugin declares)
- [x] **BOT-10**: Installed plugins and MCP servers appear as capabilities in each bot's settings and in the org capability policy (BOT-05): a bot uses a plugin's tools only when it is enabled for that bot and allowed by policy; personal bots can use only plugins/MCP servers the admin allowed for personal bots; the effective set is delivered per turn to the cell and enforced by the same tool gate as internet access

### Work Zone Session Controls (WZC) — added 2026-10-05 by the owner

- [ ] **WZC-01**: In an open Work Zone session, a controller changes the model of the session's runtime from a provider-grouped picker that lists only the models the host runtime reports for that user's own subscription; the change applies from the next turn, keeps the conversation, is audited and shows live to every controller
- [ ] **WZC-02**: A reasoning menu offers only the effort levels the selected model supports, plus context window and fast mode only where the runtime reports a real choice; unsupported or policy-blocked options are hidden or disabled with the runtime's or policy's reason, and a model switch re-validates the current choice
- [ ] **WZC-03**: A permission menu offers Supervised (asks before commands and file changes on both runtimes), Auto-accept edits, Auto (where the runtime supports it), Plan and Full access, mapped onto the common `permissionMode` enum; org policy caps the mode server-side on every turn and every change is audited
- [ ] **WZC-04**: Full access runs the real bypass mode of Claude Code and Codex only through ADR-0012's path: org policy allows it, the device has it enabled locally by its owner, and the asker holds the grain; each is off by default, a persistent badge shows it to every controller, and slash commands typed in a prompt cannot raise the mode or change settings outside policy
- [ ] **WZC-05**: A device owner shares a device (e.g. a server that hosts the harnesses) with chosen members or units, each with a maximum permission mode; those people start and control sessions on it without per-session acceptance, revoking someone stops their sessions, and the device settings show whose runtime subscription is used
- [ ] **WZC-06**: A documented inventory lists every Claude Code (Agent SDK) and Codex (app-server) session option at the pinned versions as exposed, deferred or impossible with the reason; the composer matches the owner's reference screenshots at 1440 and 390 in light and dark, and never claims an option the inventory has not confirmed
- [ ] **WZC-07**: Each Work Zone session gets an automatic short title (2–5 words, ≤ 32 characters) generated from its first prompt by the session's own runtime with a small model (Claude Code: Haiku; Codex: GPT-6-Luna) on the user's subscription; it falls back to the prompt's first line when the model is unavailable or not allowed, never overwrites a title the user typed, shows live to every controller and fits the sidebar, breadcrumb and tab at 1440 and 390

### Work Zone Image Attachments (WZ-IMG) — added 2026-10-07 by the owner

- [x] **WZ-IMG-01**: Paste (Ctrl/Cmd+V), drop or attach (paperclip) a PNG, JPEG, GIF or WebP in the Work Zone composer: a removable thumbnail with upload progress and errors shows before sending, Send waits for the uploads, and sending queues the prompt with its images; at 1440 and 390, light and dark
- [x] **WZ-IMG-02**: The prompt route accepts attachment ids with a prompt only when the sender uploaded them into the session, in the same organization, as an allowed image type, within the device-link size budget (up to 4 images, each at most 2 MB as sent) and for a model that can read images; anything else is refused with a clear error, cross-tenant and other-user ids fail like missing ones, and the audit records ids and counts, never bytes
- [x] **WZ-IMG-03**: The session's device receives the images with the prompt, and the Claude Code and Codex adapters pass them to the runtime in its native input shape (Claude image blocks; Codex image data URLs on start and steer); a runtime or model without image input refuses visibly instead of dropping them, and no image data reaches acks, logs, errors or the database
- [x] **WZ-IMG-04**: The session stream and the queue show the images sent with each prompt to every controller (open full size), live; non-controllers and other tenants cannot load them; the runtime controls inventory lists composer attachments as exposed (images only)

### Self-hosted Release (SELF)

- [x] **SELF-01**: `git clone` + `pnpm ocw setup` + `docker compose up` yields a working MVP1 instance; OpenBao and observability (Prometheus, Grafana, Loki, Tempo) are optional compose profiles (ADR-0003 amended)
- [x] **SELF-02**: Secrets are provided as required inputs (env or `*_FILE`), never generated silently at boot; the `env`/`file` secret provider implements the same `SecretStore` interface as OpenBao
- [x] **SELF-03**: Migrations run in a one-shot `migrate` service that refuses to start the API on schema mismatch; an `N-1 → N` upgrade test passes in CI
- [x] **SELF-04**: `pnpm ocw backup` / restore work as the migrator role and are documented; data survives `docker compose up --force-recreate`
- [x] **SELF-05**: A tested reverse-proxy configuration (Caddy) handles WebSocket upgrade, trusted proxy headers and presigned object-storage URLs reachable from outside the compose network
- [x] **SELF-06**: Every package declares its license (AGPL-3.0 apps/server, Apache-2.0 for `packages/contracts` and `packages/protocol`) and CI checks dependency-license compatibility (PRD §100)
- [x] **SELF-07**: Scenario B (minus Work Zone creation) runs as a Playwright E2E against the compose stack in CI

### Board Channels and Record Templates (BOARD) — added 2026-10-08 by the owner

- [ ] **BOARD-01**: A channel is created as text or board; a board channel keeps the channel's members, permissions, unit, sidebar entry and search, and has configurable columns with a category (backlog, started, done, cancelled)
- [ ] **BOARD-02**: A card is the root message of a normal thread: opening it opens the thread, agents answer there, and the card shows its title and waiting state (none, us, customer, both)
- [ ] **BOARD-03**: Cards move within and across columns by pointer drag, keyboard and a "Move to…" menu; at 390 px columns are tabs; concurrent moves converge (fractional ranks, server re-rank on collision)
- [ ] **BOARD-04**: Board changes are durable realtime events on the conversation stream with seq/cursor replay; every board query path has a cross-tenant test
- [ ] **BOARD-05**: Card titles and bodies are found by chat search within the reader's readable set
- [ ] **BOARD-06**: Unit-scoped record templates define typed fields, default columns and a naming rule; new cards get deterministic titles and a user-typed title is never replaced

### Scoped Memory Files (MEM) — added 2026-10-08 by the owner

- [ ] **MEM-01**: Agent memory is stored by the platform as virtual Markdown files with relative paths in personal, agent, project, team and organization scopes, with append-only revisions, RLS and audit; each scope has a MEMORY.md
- [ ] **MEM-02**: A file-tree viewer shows the scopes, folders, subfolders and .md files the viewer may read; files render through the shared Markdown renderer (no raw HTML), are edited as Markdown with optimistic versions, and show history with diffs (1440 and 390, light and dark)
- [ ] **MEM-03**: An agent's page shows its memory files and its capabilities and skills read-only
- [ ] **MEM-04**: Agents list, read and write memory through ocw_memory_* tools decided by the resolver (agent ∩ human); a write into a shared scope becomes a proposal, never a direct write
- [ ] **MEM-05**: A proposal runs a sensitive-data detector (secrets always blocked; IBAN, cards, NIF/NIE, email, phone flagged; optional Presidio profile) and an approval card shows the diff, findings and reader count
- [ ] **MEM-06**: An approved proposal is applied by the server through a reusable approve-and-apply primitive with a one-use grant bound to the action hash; every decision is audited
- [ ] **MEM-07**: Per-folder rules (path prefix on permission rules, deny wins) decide memory read, write and promote; existing per-bot notes migrate into personal files without becoming readable by admins

### Module Access (ACCESS) — added 2026-10-08 by the owner

- [ ] **ACCESS-01**: A module catalog maps Work Zone, AI chats, bots and other modules to exact permission grains (never admin grains)
- [ ] **ACCESS-02**: Admins and leads turn a module off or on for a department, team or person from Settings as resolver rules; changes are audited and apply live
- [ ] **ACCESS-03**: Every navigation entry and section of a denied module is hidden and the API keeps refusing direct calls; tests cover deny-beats-admin and unit inheritance

### Connectors, Keychain and Agent Templates (CONN) — added 2026-10-08 by the owner

- [ ] **CONN-01**: Admins register connectors with an auth mode (org secret, per-member OAuth, per-member secret); members connect and disconnect their own account in Settings
- [ ] **CONN-02**: Per-member connector tokens are sealed per member, refreshed serially, revocable, and ask to reconnect when invalid
- [ ] **CONN-03**: Agent calls to a connector go through an API proxy that uses the requesting member's credential (agent ∩ human), are audited per call, and default to DMs when results come from a member's account
- [ ] **CONN-04**: Without a connection the agent replies with a "connect your account" card that opens Settings
- [ ] **CONN-05**: Keychain items (personal or unit scope, host allowlist) are used by handle: the API injects the secret only towards allowed hosts, the model never receives it, and every use is audited without the value
- [ ] **CONN-06**: Unit-scoped, versioned agent templates instantiate personal agents with their own memory and connections within the personal-agent caps

### Approvals and Work Zone Proposals (APPROVE) — added 2026-10-08 by the owner

- [ ] **APPROVE-01**: A per-tool approval policy (never, always, when tainted; approvers) is decided in the tool gate; only tools with a policy send their full arguments to the API
- [ ] **APPROVE-02**: A call needing approval posts a card with the exact action; approval grants exactly one call bound to the hash of tool and canonical parameters; any change is denied; decisions are audited
- [ ] **APPROVE-03**: An agent proposes a Work Zone session (project, device, prompt) as a card; the triggering person with work_session.create and device.use starts it in their name
- [ ] **APPROVE-04**: Tainted turns cannot propose Work Zone sessions or approved external actions without a human, and an agent never selects full access

### Automations and Watched Records (AUTO) — added 2026-10-08 by the owner

- [x] **AUTO-01**: A Postgres-backed scheduler runs automations (standing order, trigger, delivery target by stable IDs, the person it runs for, budget) outside the cell, audited and restart-safe
- [x] **AUTO-02**: Signed webhooks and IMAP mail trigger automations; inbound content is untrusted and yields read-only turns
- [x] **AUTO-03**: Automations can be created from natural language and are confirmed by a person in a card
- [x] **AUTO-04**: Watched records keep an API-computed hash of an external record's watched fields; a change made elsewhere is reported in the card thread as before → after on access and on schedule, never overwritten
- [x] **AUTO-05**: Each person can get a scheduled digest by DM: pending decisions, followed cards, unread mentions, Work Zone sessions waiting or finished
- [x] **AUTO-06**: A finished Work Zone session can become a summary proposal in its project's memory through the MEM promotion flow

### Agent-to-Agent Collaboration (A2A) — added 2026-10-08 by the owner

- [x] **A2A-01**: An agent consults or delegates to another agent through the API; the answer returns as a new turn and each hop is a visible, attributed thread message audited with a chain id
- [x] **A2A-02**: Effective agent-to-agent permission = source agent ∩ triggering human ∩ target visibility ∩ agent.message rules (deny wins)
- [x] **A2A-03**: Chains are bounded (depth ≤ 2, no agent twice, per-chain budget, daily limits) and the asker pays

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
- [ ] **WZUI-08**: `@file` mentions in the composer with autocomplete from the host's registered project file list (relative paths), and image attachments (the image part is delivered by WZ-IMG-01, Phase 06.1; the `@file` part stays open)
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

### Bot Sandboxes and Live Browser (SBX, BRW) — added 2026-10-14 by the owner

- [ ] **SBX-01**: Each bot has its own isolated sandbox (separate container or VM boundary, persistent workspace with a quota, CPU/memory/process limits, no host mounts or Docker socket) that no other bot or cell process can reach
- [ ] **SBX-02**: A bot reads and writes files and runs commands only inside its sandbox, through tools the Control Plane decides, audits and can stop; secrets never enter the sandbox environment
- [ ] **SBX-03**: Sandbox egress goes only through the 07.4 egress policy (public-only, per-organization allowlist); the sandbox cannot reach platform services except the Agent Channel API
- [ ] **SBX-04**: Plugins and tools refused by ADR-0010 today can be installed through the ADR-0011 approval flow when they run only inside the sandbox; platform-administration tools stay refused; 07.5 per-tool approvals apply
- [ ] **SBX-05**: People who may configure a bot browse, download, upload and delete its sandbox files from the bot page; Sandbox is a module an admin turns on per organization or unit
- [ ] **BRW-01**: A bot drives a real browser inside its sandbox through Control Plane tools (open, read, click, type), with navigation audited by host only
- [ ] **BRW-02**: People who can read the conversation watch the bot's browser live in a small floating window that can be expanded
- [ ] **BRW-03**: When a page needs a login the bot posts a platform-owned card; a person with the right takes control, signs in and hands control back; password fields never reach the bot, the model, logs or audit
- [ ] **BRW-04**: The signed-in session is sealed per member and site in the keychain, reused only for that member's turns, expires and is revocable; Browser is a module an admin turns on

### Shared Work Zone Projects (WZP) — added 2026-10-22 by the owner

- [ ] **WZP-01**: A team project is an `org_units` unit of kind `project` with direct members (member/lead) and assigned teams (teams or departments); admins and leads of the parent unit create it and assign teams; project leads and admins add members and link device repositories they can use (`device.use`); a repo links to at most one team project; every change is audited
- [ ] **WZP-02**: Project access is decided only by the resolver: team project = direct members ∪ members of assigned teams (unit subtree) ∪ admins; personal project = device owner ∪ device grantees (ADR-0012); unit-scoped and module rules (ADR-0024) apply
- [ ] **WZP-03**: A team project has one setting, "New sessions are visible to everyone in the project" (on by default; off ⇒ new sessions start as Only me); project leads and admins change it; audited
- [ ] **WZP-04**: Every session has exactly one audience — owner, project, selected assigned teams, or specific people with project access — stored like `ai_chat_grants` (one active grant per subject, soft-revoked); entries outside project access grant nothing; the creator, project leads and admins change it; the device owner and admins (explicit, audited rule) always see; a creator who left keeps read and archive; every change is audited
- [ ] **WZP-05**: Seeing is not controlling: every `work_session.*` grain on a concrete session (read, prompt, interrupt, configure, approve, archive, visibility) additionally requires the audience; control keeps today's role and device rules; no new control levels
- [ ] **WZP-06**: No session data reaches anyone outside its audience over any socket: `emitSession` no longer writes `WorkSession` DTOs on `org:<orgId>`, historical `org:` session payloads are redacted, list updates go per user; a sentinel test proves a non-audience member (including one with Work Zone off) receives no title, branch, device name or id of the session
- [ ] **WZP-07**: One rule, every reader: the list, detail, diff, controls, settings, prompts, approvals, archive, attachments, the `ws:` topic authorizer, Work Zone proposals and every count use the one SQL access function through the resolver; a restrictive RLS policy on `work_sessions`, `work_prompts`, `work_approvals` and `work_session_grants` backs it up for user requests; narrowing (audience, membership, team assignment, repo unlink, device grant) re-decides live `ws:` subscriptions within a second and removes the session from lists live
- [ ] **WZP-08**: One forward-only migration adds the tables/columns and applies D-06: existing sessions get audience `project`, which for their (still unlinked) repos means creator ∪ device owner ∪ device grantees ∪ admins; the narrowing is stated in the migration header, ADR-0030 and DEMO.md
- [ ] **WZP-09**: Session UI: one visibility chip + popover (bottom sheet below 640) with four choices, inline team/people pickers, a "who can see it now" footer, a read-only panel and inactive entries; a sidebar marker only when the audience differs from the project default; the new-session dialog groups repos under team projects and shows "Visible to: … · Change"; 1440/390, light/dark, axe, 44 px
- [ ] **WZP-10**: Project UI: `/work-zone/projects` index and `/work-zone/projects/<unitId>` (Sessions · Settings: access line, default switch, people, teams, repositories with link/unlink dialogs), and the Teams + Work Zone sections on a project unit in Settings › Organization; the Work Zone layout no longer treats `/work-zone/projects` as a session

### Work Zone Sidebar by Team (WZS) — added 2026-10-27 by the owner

- [ ] **WZS-01**: The Work Zone sidebar has one collapsible section per top-level unit (department) that holds a team project the viewer belongs to, the viewer's own departments first, then alphabetical; a project under a team shows the team as a pill; collapse state persists per browser, and a collapsed section still shows what needs the viewer and the open session, with a count of what it hides
- [ ] **WZS-02**: The sidebar lists only the team projects the viewer belongs to (direct member, member of an assigned team, or project lead); projects the viewer only manages or opens as an admin are reached through "Browse projects" and search, so an admin's sidebar never lists every project
- [ ] **WZS-03**: A project row shows its icon, name, team pill and a live count of the running sessions the viewer can see, and opens the project page, highlighted while that page is open, like a channel row
- [ ] **WZS-04**: Only active sessions appear under a project, at most 3 (approvals first, then live, then recent), then "+N more" to the project page; the open session always shows; settled history stays one click away in a collapsed Settled section limited to the viewer's sidebar scope, on the project page and in search
- [ ] **WZS-05**: A "Needs you" section on top gathers, from any project or personal repository in the viewer's scope, sessions with a pending approval the viewer may decide and the viewer's own finished turns not yet opened (within 24 h); it is hidden when empty and updates live
- [ ] **WZS-06**: A "Personal" section at the end holds the viewer's repositories not linked to a team project, with their active sessions; a session whose project the viewer may not see named sits there under its repository, and that project is never named
- [ ] **WZS-07**: "+" actions: a section "+" creates a team project in that department only where the viewer may create (preselected), a project "+" starts a session on one of its repositories, a repository "+" starts one there, and the header "+" keeps starting a new session
- [ ] **WZS-08**: With no team project the sidebar shows one discreet onboarding line ("Share sessions with your team → Create project", or a plain line for people who cannot create); search covers projects, sessions and personal repositories in grouped results; loading and error states never hide a session the viewer had
- [ ] **WZS-09**: The sidebar stays usable with hundreds of members, dozens of departments and hundreds of projects: collapsed sections, membership-only listing, caps (3 sessions per project, 15 projects per section, 5 repositories, 5 Needs-you rows), two list requests with no per-project request, and live updates only through the existing per-user delivery
- [ ] **WZS-10**: The data is additive and contract-first: each projects-index row carries its parent and top-level unit and the viewer's membership, each creatable parent its top unit, and each session row per-viewer `attention` and `teamProjectHidden`; a project the viewer may not see named is never named on any session surface (closing the 07.9 D-14 leak in the session list, detail and live frames); cross-tenant tests prove isolation
- [ ] **WZS-11**: The sidebar is one component on desktop and in the mobile drawer, verified at 1440 and 390 in light and dark: axe-clean, 44 px touch targets below 768, arrow-key navigation with focus kept on live updates; existing search, Settled, live status texts and the 07.9 visibility marker keep working

### Runtime CLI Auto-updates (RTU) — added 2026-10-28 by the owner

- [x] **RTU-01**: For each runtime the daemon reports the installed version and the install method it found from the binary's real path (native/standalone, npm, pnpm, bun, yarn, Volta, Homebrew cask/formula; apt/dnf/apk, mise, asdf, a project `node_modules`, the SDK-bundled CLI, Windows or unknown = manual), whether it can update itself as the daemon's user, and the one update command chosen from a fixed on-device table (never sent or built by the server); manual and root-owned installs show "update it with the tool that installed it" / "needs admin on this machine" and are never updated; no absolute host path leaves the device
- [x] **RTU-02**: The daemon checks the latest version of each runtime on the npm registry (the dist-tag matching the install's channel) at start and every 6 h ± jitter, and on demand; lookups are cached, failures and offline devices report `unknown`, policy `off` makes no outbound call, and the CLIs the daemon launches run with their own background updater disabled so the daemon is the one update authority
- [x] **RTU-03**: A Zod-validated compatibility manifest in `packages/contracts` (per runtime: recommended range and supported/graceful/unsupported/broken ranges, derived from the adapters' pinned fixtures) is served by the Control Plane over the Device Link; the device never fetches it elsewhere, a `broken` candidate is never installed, and an unsupported or broken installed version is flagged where members start sessions on that device (a broken one blocks the start)
- [x] **RTU-04**: An update for runtime R runs only at a moment when R has no turn in flight on the device: it waits up to 1 h for a natural idle moment, then drains (new turns for R wait, shown in the session as "Updating Claude Code…", while in-flight turns finish; a turn is never cut); idle R processes are retired first and resume on the new binary at their next turn; other runtimes are unaffected; one update per install lock, 5 min timeout, output capped and redacted, then the installed version is re-detected and the run ends succeeded, unchanged or failed; a pending update that never finds an idle moment is reported as stale
- [x] **RTU-05**: Org policy `runtimeUpdates` (`automatic` default · `notify` · `off`) in Settings › Work Zone policy, intersected with a device-local level set only on the device (desktop menu, `ocw-runtime updates …`, `OCW_RUNTIME_UPDATES`), which can only lower it; a daemon that has not received the policy from its Control Plane behaves as `notify` (checks and reports, never installs); policy and device changes take effect without a restart and are audited
- [x] **RTU-06**: The device owner and org admins (the new non-delegable `device.maintain`, decided by the resolver) see per device and runtime the version, compatibility, install method, update state and history, and can press "Update now" (it only asks the daemon to run its own detected update); grantees and other members see only the version and the compatibility flag, and version details never travel on `org:`; every available update found, every start and every result (actor user, device or `system`) is audited, with no absolute host paths and redacted output
- [x] **RTU-07**: It all works from the headless daemon on Linux and macOS (no desktop needed); the desktop app shows each runtime's status line and the device-local updates toggle; Settings › Devices, the policy section and the start-time flag are verified at 1440 and 390, light and dark

### Headless Work Zone Server (HSR) — added 2026-10-29 by the owner

- [x] **HSR-01**: The API serves the Local Runtime as one versioned file built at image build time, with the Claude Agent SDK left out of it, plus a manifest (version, SHA-256, size, minimum Node, the SDK and its peers pinned at the tested versions, the bundled packages and their permissive licenses, source) and a POSIX `install.sh`, at `/api/v1/runtime/{install.sh,bundle,bundle.sha256,version}` without authentication and rate-limited. The script's server URL comes only from `OCW_PUBLIC_API_URL`. It installs for the current user into `~/.ocw/runtime` with the pinned SDK installed beside it from the machine's own npm registry and a `~/.local/bin/ocw-runtime` shim; it verifies the checksum, refuses Node < 24, a missing npm and plain HTTP to a non-loopback host, never uses sudo and runs nothing else from the network
- [x] **HSR-02**: `ocw-runtime setup [--server] [--name] [--project]… [--service user|system|none] [--yes]` pairs (skipped when the device token still works), registers projects, installs the service and runs doctor. It prompts only on a TTY, every prompt has a flag, re-running is harmless, and it ends by printing the device's Settings › Devices link so the owner shares it there
- [x] **HSR-03**: `ocw-runtime enroll --server <url>` without `--code` prints a short user code (Crockford base32, 8 characters, 40 bits) and a verification link, then polls. The owner (with `device.pair`) sees the device's name, platform, request IP and time in Settings › Devices, even after signing in from the link, then approves (choosing the name) or denies. Approval creates the device exactly like today's enroll. Codes expire in 10 minutes and are single-use. Start, poll, lookup and decision are rate-limited per IP and per user. The poll answers only `authorization_pending`, `slow_down`, `access_denied`, `expired_token` or the token. Approval and denial are audited. `--code` still works
- [x] **HSR-04**: `ocw-runtime service install|uninstall|status|logs|restart` writes and drives a systemd user unit by default, a system unit run by a named non-root account with `--system --user-name` (root only), or a launchd LaunchAgent on macOS, with absolute node and bundle paths, the installer's PATH, `Restart=on-failure` (KeepAlive on failure), no secret and no TCP port; an optional 0600 `~/.ocw/service.env` is read by the daemon itself. It prints the `loginctl enable-linger` line when lingering is off, refuses while the desktop app or a hand-started daemon owns the same `~/.ocw`, and is never run against a real service manager by tests. `remove-project` takes a directory, a name or an id
- [x] **HSR-05**: `ocw-runtime doctor [--json]` reports ok, warn or fail with one fix line for each of these: Node, installed runtime vs server, pairing and device auth, server reachability, the daemon, the service (and linger), Claude Code and Codex installed, version compatibility and signed in (with headless sign-in instructions), git, registered projects, runtime updates level, and service.env (key names only). It exits non-zero on any fail, never prints a secret and shows home-relative paths at most
- [x] **HSR-06**: A device installed and paired headless (served bundle, device code, no desktop app anywhere) works end to end: the owner shares it with a member and links its repos to team projects from the web, and that member starts, prompts and controls a session on it from the web. Proven by an e2e spec on the served bundle paired by device code
- [x] **HSR-07**: An opt-in Linux container proof (the pinned slim `node:24` image plus `curl git ca-certificates`) runs the whole chain: `install.sh` from the isolated stack, then `setup --yes --service none`, then approval in the web UI, then a member's session with the fake runtime, and doctor's JSON. systemd and launchd are covered by unit tests of the generated files and command sequences. `docs/SERVER.md` (linked from INSTALL), DEMO owner checks and ADR-0033 record the decisions

### Organization Connector Auth (COA) — added 2026-11-06 by the owner

- [x] **COA-01**: An MCP server (remote transport) can use `org_oauth`: an admin with `mcp.manage` connects it once with the authorization code flow (the 07.4 OAuth client: RFC 9728/8414 discovery, issuer check, PKCE S256, RFC 8707 `resource`, RFC 9207 `iss`, per-issuer client choice pre-registered → CIMD → DCR); the organization's bots then call its tools with that account wherever organization-secret servers are offered, through the API connector proxy, never in the cell
- [x] **COA-02**: An MCP server can use `org_client_credentials` (RFC 6749 §4.4): client id and write-only secret, token endpoint discovered from the server's metadata or entered by the admin (HTTPS or same-origin), optional scopes, RFC 8707 `resource`; the API fetches and refreshes tokens itself
- [x] **COA-03**: Organization credentials follow ADR-0025 custody: sealed in `app.secrets` with an organization-scoped AAD, readable only through admin-guarded functions, refresh serialized across instances, `needs_reconnect` with a reason on terminal failures, revocation at the provider on disconnect, destruction on a mode switch or delete after a confirmation; connect, disconnect, reconnect-needed and each proxied call are audited without tokens; tenant isolation proven by tests
- [x] **COA-04**: The MCP server dialog offers every mode (organization headers, organization sign-in, client credentials, member sign-in, member key) and, when OAuth cannot start or finish, names the failed step (discovery, issuer, PKCE, client registration, HTTPS, token exchange, scopes) with one fix line and the redirect URI and client metadata URL to copy; the server row shows the organization connection (account label, connected by, when) and Connect / Reconnect / Disconnect for admins; 1440/390, light/dark
- [x] **COA-05**: Existing modes are unchanged and existing servers keep working after the upgrade; integration tests against a fake OAuth MCP server cover both new flows, refresh, revoke, reconnect and the bots' proxied call; an e2e spec covers the admin connecting an organization account and a bot using it; ADR-0036 records the decisions

### Bots Read Attachments (BRA) — added 2026-11-07 by the owner

- [ ] **BRA-01**: Members can attach files in every conversation where a bot answers (personal and team bot DMs, channels and threads with bots, AI chats with personas); the composer enables the paperclip there with the existing size and type limits
- [ ] **BRA-02**: A bot's turn receives the attachments of the messages it reads, decided server-side by the conversation's audience and the asker (never another conversation's files): images as image input for image-capable models, text-like documents as extracted, size-capped text; a model or bot that cannot read a type gets an explicit note so it tells the person
- [ ] **BRA-03**: A bot can copy a readable attachment into its sandbox workspace through an `ocw_*` tool decided in the Agent Channel API (same caps, quotas and lifecycle as the workspace), so its sandbox tools can process it; nothing reaches Garage except through the API
- [ ] **BRA-04**: Every attachment read or copy is audited (actor, bot, conversation, attachment id, kind, bytes) without content; extraction never executes the file, is bounded in time and size, and marks the turn tainted; tenant isolation and the F-8 audience rule are proven by tests
- [ ] **BRA-05**: Proven by integration tests and an e2e spec (fake model, desktop and mobile); README's "bots cannot read attachments" limitation removed; ADR-0037 records the decisions

### Bot Work Zone Orchestration (BWZ) — added 2026-11-09 by the owner

- [x] **BWZ-01**: A bot has a Work Zone profile set by whoever manages it (personal bot: its owner; team bot: a lead or admin): the device or server its sessions run on (the device owner consents per bot), the projects it may work in, the runtime, the model and options from the runtime-reported catalog, and the permission mode up to bypass, which needs ADR-0012's chain (organization policy ∩ device opt-in for this bot ∩ the profile) and is server-checked and audited
- [x] **BWZ-02**: A bot starts Work Zone sessions itself in an allowed project on its profile's device, choosing model and options within the profile's caps, sends follow-up prompts to sessions it started, reads their state and output (normalized, redacted, repo-relative paths only) and stops them, through `ocw_*` tools decided in the Agent Channel API; humans of the session's audience keep prompting and stopping the same session (one executor, many controllers)
- [x] **BWZ-03**: The bot is woken in the originating conversation when a session it started finishes a turn, waits for an approval, fails or ends, so it orchestrates without polling; it can mention a person to ask for help; wake-ups are bounded per session (counted against the profile's limits); a wake turn runs as the original asker, the sponsor stays accountable (D-17)
- [x] **BWZ-04**: The originating conversation shows a live Work Zone card (status, current step, last update, Open); the session page links back to that conversation; desktop and mobile
- [x] **BWZ-05**: From a turn that read outside content (MCP output, attachments, webhooks), starting or prompting a session is allowed only when an admin enabled "act on outside content" on the bot's profile, and bypass mode then only on a device its owner marked as an isolated server; otherwise the bot falls back to today's proposal card; every start, prompt, read and stop is audited without prompt content; tenant isolation proven by tests
- [x] **BWZ-06**: Bots without a profile keep today's proposals unchanged; proven by integration tests and an e2e spec (fake runtime, desktop and mobile); ADR-0038 supersedes the affected clauses of ADR-0026 and ADR-0030

### Automation Fan-out and Team Mentions (AFO) — added 2026-11-09 by the owner

- [x] **AFO-01**: A scheduled automation can run every 5 minutes or more (was 15)
- [x] **AFO-02**: One automation run can open a new conversation per new item it finds (a new thread in its channel target, or a new card in its board target), capped per run, with a per-automation dedupe key (the item's external id) so the same item never opens twice; each new conversation gets its own bot turn that carries the item as untrusted content and keeps the run's tools, including the Work Zone profile of 07.16
- [x] **AFO-03**: A bot can move and set waiting on every card its automation opened, from any turn in that card's thread, also after reading outside content when its profile allows it (BWZ-05)
- [x] **AFO-04**: In channel posts (threads and board cards included; not DMs, group DMs or AI chats), people and bots can mention a team (`@team`, an org unit by stable id): its members who can read the conversation get a mention notification; bots still never use `@channel`/`@here`; bot mentions are capped per message
- [x] **AFO-05**: Proven by integration tests and an e2e spec (fake MCP of orders → card → Work Zone session → team mention on finish), desktop and mobile; ADR-0039 records the decisions

### Bot Work Zone File Exchange (BWF) — added 2026-11-11 by the owner

- [ ] **BWF-01**: A bot with an active Work Zone profile is offered `ocw_work_session_upload` and `ocw_work_session_download` together with the four 07.16 session tools (all or none); every call re-decides the live turn, the bot's own session, the profile and the sponsor's rights in the Agent Channel API
- [ ] **BWF-02**: Upload copies only an attachment the turn may read (the 07.15 rule, as the asker) into a contained repo-relative path of the session's working tree, only while the session is idle; absolute paths, `..`, symlink escapes and existing files without `overwrite` are refused; after outside content it follows the profile's "act on outside content" like a prompt
- [ ] **BWF-03**: Download turns one contained regular file of the session into an attachment of the bot's reply in the conversation the session started in, which people open and download; one deny list (`.git`, `.claude`, `.codex`, `.mcp.json`, `.ocw-worktrees`, `.env` and keys) applies both ways; after outside content it follows the profile's flag; reading a session's output does not block downloading from it
- [ ] **BWF-04**: The device handles `session.file.write` / `session.file.read` only for a session active on it, with repo-relative paths only; bytes never cross the Device Link (a device-token HTTP stream instead); an old runtime answers "too old, update it in Settings › Devices"
- [ ] **BWF-05**: Every upload and download is audited (bot, sponsor, session, attachment, size, sha256) without a path or content
- [ ] **BWF-06**: File moves count in the bot's hourly prompt budget and the turn's 8 tool calls; at most 5 files per turn each way
- [ ] **BWF-07**: The per-file limit is configurable: the organization's "Largest file a bot moves" (default 25 MB, at most the server's `OCW_ATTACHMENT_MAX_BYTES`) and the bot's "Largest file" (at most the organization's); the lower wins, refusals name it, the check happens before any byte moves, and large files stream
- [ ] **BWF-08**: The device's `diff.result` frames never exceed the API's 256 KiB inbound limit (a large diff is shown truncated instead of closing the link)

### Operations backlog (from the 2026-10-08 research, not yet scheduled)

- **OPS-BL-01**: Organization groups — several organizations per user with a switcher, and consolidated aggregate reporting computed per organization under its own tenant context (needs an identity/tenancy ADR)
- **OPS-BL-02**: Model comparison per task (text, code, image reading) through the model gateway, opt-in, dry-run first, metered as `eval` usage
- ~~**OPS-BL-03**~~: Browser-session logins for agents — scheduled as BRW-01..04 in Phase 07.8 (2026-10-14)
- **OPS-BL-04**: Board columns synchronized from an external system's phases via connectors (two-way, compare-and-set)

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
| FOUND-05 | Phase 7 | Complete | Explicit wiring + OpenAPI (SLICE-18); OpenTelemetry traces, metrics and logs via `@fastify/otel`, off without an OTLP endpoint, redacted at the source and in the collector (ADR-0021, 07-05/07): `telemetry.int.test.ts`, `telemetry/redact.test.ts`, `compose-observability.test.mjs`; gate stage `observability` (trace in Tempo, metric in Prometheus, logs with trace id in Loki, no leaks) |
| FOUND-06 | Phase 7 | Complete | Minimal profile = postgres, redis, garage (ADR-0015, D-02), one-shot `migrate`, api, web, OpenClaw cell; compose `:?` guards and the API name a missing `NAME`/`NAME_FILE` (07-03/04/06): `infra/compose.test.mjs`, `config/env.test.ts`, `openbao.int.test.ts`; gate stage `compose` (migrate exit 0, api/web/cell healthy) on `pnpm gate:compose` and `pnpm gate:cleanroom` (07-11) |
| FOUND-07 | Phase 7 | Complete | `pnpm verify` = lint + guard + typecheck + test; guard runs five pinned Semgrep rules (permission/RLS bypass, skipped or focused policy tests, AI-telemetry prompts), the dependency-license policy, license fields and the CODEOWNERS lint (07-01): `scripts/guard/guard.test.mjs`, `node scripts/guard/run.mjs --rule-tests`, `.github/CODEOWNERS` |
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
| AUTH-04 | Phase 2 | Delivered | identity/password.int.test.ts (admin link + SMTP memory), Mailpit manual check, e2e account.spec |
| AUTH-05 | Phase 2 | Delivered | identity/sessions.int.test.ts (list/revoke/others, client kind+label), e2e account.spec |
| AUTH-06 | Phase 2 | Delivered | identity/jwt.int.test.ts, tokens.int.test.ts, device-link-auth.int.test.ts (device JWT; legacy token behind flag until Phase 8), ADR-0008 |
| ORG-01 | Phase 2 | Delivered | organization/units.int.test.ts + units.test.ts (fast-check moves, advisory lock), e2e admin-org.spec |
| ORG-02 | Phase 2 | Delivered | organization/members.int.test.ts (4 roles, last-admin guard), invitations.int.test.ts (lead ceiling), unit leads in units.int.test.ts |
| ORG-03 | Phase 2 | Delivered | permissions/resolve.test.ts (role matrix + 8 fast-check properties), authz.int.test.ts (98 routes, strict mode), guard.test.ts, ADR-0007 |
| ORG-04 | Phase 2 | Delivered | e2e admin-members.spec + admin-org.spec (Settings › Members / Organization CRUD) |
| ORG-05 | Phase 2 | Delivered | same-tx audit across identity/org/units/rules/members; failed sign-in + sign-out audited (sessions.int.test.ts); denials audited |
| ORG-06 | Phase 2 | Delivered | identity/profile.int.test.ts (member.updated emitted), e2e account.spec (name, emoji avatar, status visible across the app) |
| RT-01 | Phase 3 | Delivered | realtime-reauth.int.test.ts (removal, leave, role/rule/unit invalidators, 5-min backstop), e2e realtime-access.spec, ADR-0009 |
| RT-02 | Phase 1 | Delivered | `identity.int.test.ts` WS replay exactly once; realtime-client "requests replay on gap and resumes after reconnect" |
| RT-03 | Phase 3 | Delivered | e2e realtime-latency.spec (two real browsers, p95 message 19.6 ms / typing 4.3 ms / presence 4.6 ms vs 500 ms budget; CI artifact) |
| RT-04 | Phase 3 | Delivered | realtime-presence.int.test.ts (expiry, dead peer, crashed instance), e2e presence.spec + presence-away.spec (header, members, Work Zone) |
| RT-05 | Phase 1 | Delivered | `packages/realtime-client` (`client.test.ts`) used by web; desktop renders the web app |
| CHAT-01 | Phase 1 | Delivered | `chat.int.test.ts` channels suite (public/private, join, archive by owner/admin); leave route; `chat.spec.ts` create + join in UI |
| BOT-01 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-02 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-03 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-04 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-05 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-06 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-07 | Phase 3.1 | Complete | New (owner request 2026-10-04) |
| BOT-08 | Phase 3.1 | Complete | New (owner request 2026-10-04: MCP + OpenClaw plugins/Marketplace) |
| BOT-09 | Phase 3.1 | Complete | New (owner request 2026-10-04: MCP + OpenClaw plugins/Marketplace) |
| BOT-10 | Phase 3.1 | Complete | New (owner request 2026-10-04: MCP + OpenClaw plugins/Marketplace) |
| WZC-01 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-02 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-03 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-04 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-05 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-06 | Phase 3.2 | Pending | New (owner request 2026-10-05: Work Zone session controls, ADR-0012) |
| WZC-07 | Phase 3.2 | Pending | New (owner request 2026-10-05: automatic session titles with Haiku / GPT-6-Luna) |
| WZ-IMG-01 | Phase 06.1 | Complete | New (owner request 2026-10-07): plans 06.1-04 (composer paste/drop/paperclip, tray), 06.1-05 (gate); `work-zone-images.spec.ts`, `image-gate.test.ts` |
| WZ-IMG-02 | Phase 06.1 | Complete | New (owner request 2026-10-07): plans 06.1-01 (link, access, model gate, audit), 06.1-02 (budget, dispatch gate), 06.1-05 (gate); `images.int.test.ts`, `images.test.ts`, `images-dispatch.int.test.ts` |
| WZ-IMG-03 | Phase 06.1 | Complete | New (owner request 2026-10-07): plans 06.1-02 (dispatch, frame guard, leak scan), 06.1-03 (daemon, Claude/Codex adapters), 06.1-04 (`Images: N` e2e), 06.1-05 (gate); `images-dispatch.int.test.ts`, `daemon.test.ts`, `claude-runtime.test.ts`, `codex-runtime.test.ts`; real runtimes: owner check `human_needed` |
| WZ-IMG-04 | Phase 06.1 | Complete | New (owner request 2026-10-07): plans 06.1-01 (read scope), 06.1-04 (stream and queue), 06.1-05 (inventory row exposed, gate); `images.int.test.ts`, `work-zone-images.spec.ts`, `runtime-controls.test.ts` |
| CHAT-02 | Phase 4 | Delivered | Sections per department/team (collapsible) and views All, Mentions, Threads, AI Chats, Saved: `sidebar.int.test.ts`, `threads.int.test.ts`; `chat-sidebar.spec.ts`, `chat-day.spec.ts` |
| CHAT-03 | Phase 1 | Delivered | `chat.int.test.ts` "thread replies update the root and refuse nesting"; `chat.spec.ts` reply count + participants |
| CHAT-04 | Phase 4 | Delivered | Human DMs, group and mixed DMs up to 9 (fixed membership, bots mention-only): `dm.int.test.ts`, `group-dm.int.test.ts`, `dm-privacy.int.test.ts`; `dms.spec.ts`, `chat-day.spec.ts` |
| CHAT-05 | Phase 4 | Delivered | One streamdown + shiki `<Markdown>` for chat, threads, DMs, bot output and the Work Zone, no raw HTML (ADR-0016): `markdown.test.tsx`, `safe-url.test.ts`; `renderer.spec.ts` |
| CHAT-06 | Phase 4 | Delivered | Live edit with append-only versions and "(edited)"; delete with tombstones; admins delete where readable: `message-edit.int.test.ts`, `chat.int.test.ts`; `chat-edit.spec.ts`, `chat-day.spec.ts` |
| CHAT-07 | Phase 4 | Delivered | Reactions on messages, thread replies and bot messages (quick reactions, self-hosted picker): `reactions.int.test.ts`; `reactions-pins.spec.ts`, `chat-day.spec.ts`. Agents cannot react yet |
| CHAT-08 | Phase 4 | Delivered | @people/@bots/@channel/@here with autocomplete, permission + 1/min limit, Mentions inbox, bots triggered: `notifications.int.test.ts`; `notifications.spec.ts`, `chat-day.spec.ts` |
| CHAT-09 | Phase 4 | Delivered | Live unread and mention badges, mark read/unread synced across tabs: `unread.int.test.ts`; `unread.spec.ts`, `chat-day.spec.ts`. Wording differs: counts are over messages after `last_read_seq` (P-07), not `last_seq - last_read_seq` |
| CHAT-10 | Phase 4 | Delivered | Mute, levels (all/mentions/nothing), default level, DND, desktop/web toggles; inbox and pop-ups honour them; dock badge: `prefs.int.test.ts`; `notification-prefs.spec.ts`. Click-to-focus on macOS needs a signed build (manual) |
| CHAT-11 | Phase 4 | Delivered | PostgreSQL FTS (unaccented simple/spanish/english) + pg_trgm over the readable set, In/From/Date filters (ADR-0016): `search.int.test.ts`; `search.spec.ts`, `chat-day.spec.ts` |
| CHAT-12 | Phase 4 | Delivered | Drag-and-drop, paste and picker uploads to Garage via presigned URLs, previews, lightbox, authorized download (ADR-0015): `attachments.int.test.ts`, `message-attachments.int.test.ts`; `attachments-api.spec.ts`, `attachments.spec.ts`, `chat-day.spec.ts` |
| CHAT-13 | Phase 4 | Delivered | Pins per conversation, personal Saved view, copy link to messages and thread replies: `pins.int.test.ts`, `permalink.int.test.ts`; `reactions-pins.spec.ts`, `permalinks.spec.ts`, `chat-day.spec.ts` |
| CHAT-14 | Phase 4 | Delivered | Cursor pagination plus detached permalink windows with Jump to latest: `permalink.int.test.ts`; `permalinks.spec.ts`, `search.spec.ts` |
| AICHAT-01 | Phase 5 | Delivered | Org provider keys are `SecretReference`s read only through `secrets.resolve` (idempotent backfill with a documented rollback), one allowed list for AI chats and bots, METERED everywhere, no personal key route (ADR-0018, 05-01/05-04): `secret-ref-migration.int.test.ts`, `providers-secret-ref.int.test.ts`, `org-models.int.test.ts`, `security.int.test.ts`; `ai-chat-models.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-02 | Phase 5 | Delivered | Private owner-only AI chats, picker over the allowed list, per-message switch across the member's own ChatGPT plan (ADR-0017), org keys and the mock (05-02…05-07): `ai-chat.int.test.ts`, `org-models.int.test.ts`, `oauth.test.ts`, `signin.int.test.ts`, `plan-errors.int.test.ts`; `ai-chat.spec.ts`, `ai-chat-models.spec.ts`, `ai-chat-signin.spec.ts`, `ai-chat-plan-errors.spec.ts`, `ai-chat-day.spec.ts`. Real Sign in with ChatGPT is the owner's manual check (05-VALIDATION) |
| AICHAT-03 | Phase 5 | Delivered | WS offset deltas + one durable final message, reload resume, cross-instance Stop keeping the partial text, 409 one-generation gate, sweeper, regenerate with versions (05-03/05-06): `ai-chat.int.test.ts`, `stop.int.test.ts`, `regenerate.int.test.ts`, `ai-chat-stream.test.ts`; `ai-chat-stop.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-04 | Phase 5 | Delivered | Auto titles on the chat's own backend (ADR-0014 rules), list with rename/archive, owner-only search and ⌘K (05-10): `titles.int.test.ts`, `list.int.test.ts`, `search.int.test.ts`; `ai-chat-list.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-05 | Phase 5 | Delivered | Personal defaults and per-chat instructions in a fixed labelled order, personal dropped with a second human (05-11): `build-model-messages.test.ts`, `tools.int.test.ts`; `ai-chat-tools.spec.ts` |
| AICHAT-06 | Phase 5 | Delivered | Four toggles; Web on the plan's hosted search or the self-hosted SearXNG on org keys, disabled reasons; the other three "Not available yet" (05-11): `web-tools.test.ts`, `tools.int.test.ts`; `ai-chat-tools.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-07 | Phase 5 | Delivered | One append-only usage record per generation (every outcome), sourced prices, tokens/cost per answer, daily caps, member and admin reports (05-08/05-09): `model-prices.test.ts`, `usage.int.test.ts`, `usage-reports.int.test.ts`, `ai-format.test.ts`; `ai-chat-usage.spec.ts`, `ai-chat-usage-reports.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-08 | Phase 5 | Delivered | Images, PDFs and small text files through the Phase 4 pipeline, bytes read by the API, gated by model capability, untrusted labelling (05-12): `attachments.test.ts`, `attachments.int.test.ts`, `attachment-gate.test.ts`; `ai-chat-attachments.spec.ts`, `ai-chat-day.spec.ts` |
| AICHAT-09 | Phase 5 | Delivered | Immutable snapshot readable only when signed in to the same organization, revoke, share-scoped files, anonymous 401 (05-13): `shares.int.test.ts`, `security.int.test.ts`; `ai-chat-share.spec.ts`, `ai-chat-day.spec.ts` |
| MULTI-01 | Phase 6 | Delivered | Grants on the same chat (person/unit/org, Can chat/Can view) decided only by `aiAccessSql`, live revoke, notices, inbox, Shared with me, P-13 disclosure (ADR-0019, 06-01/02/03/04/08/12): `multiplayer.int.test.ts`, `grants.int.test.ts`, `shared.int.test.ts`, `security.int.test.ts`; `ai-chat-multiplayer.spec.ts`, `ai-chat-share-people.spec.ts`, `ai-chat-shared-inbox.spec.ts`, `ai-chat-multiplayer-day.spec.ts` |
| MULTI-02 | Phase 6 | Delivered | Several humans + the model live; `ai_message_context` per message (author, access, grant, level, model, tools, shared, answering generation); typing, presence, per-recipient lists (06-01/02/08/11): `multiplayer.int.test.ts`, `shared.int.test.ts`, `rls-isolation.int.test.ts`; `ai-chat-multiplayer.spec.ts`, `ai-chat-multiplayer-day.spec.ts` |
| MULTI-03 | Phase 6 | Delivered | Roster in the instructions, server-generated attributed blocks, merged user turns, persona blocks, `<turn_context>`; no mid-conversation system message; solo prompts byte-identical (06-02/05): `build-model-messages.test.ts`, `guard.test.ts`, `prompt-matrix.int.test.ts`, `attribution.test.mjs` |
| MULTI-04 | Phase 6 | Delivered | Ask AI / mentions decide addressing; one generation; queue derived from `ai_message_context`, coalesced turn billed to the first waiting author, visible queue chip (06-06/11): `queue.int.test.ts`, `stop.int.test.ts`, `regenerate.int.test.ts`, `ai-chat-stream.test.ts`; `ai-chat-multiplayer.spec.ts`, `ai-chat-multiplayer-day.spec.ts` |
| MULTI-05 | Phase 6 | Delivered | Web follows the asker; scoped tools only when every reader may use them and never with a unit/org grant; gate re-decides at call time; withheld explained (06-05/10): `prompt-matrix.int.test.ts`, `tools.int.test.ts`, `ai-chat-delivery.int.test.ts`, `mention-mapper.test.ts`; `ai-chat-agents.spec.ts` |
| MULTI-06 | Phase 6 | Delivered | No personal instructions once shared (a grant, a second human or a persona: D-06), never memory in AI chats; leak sweep over model requests, cell deliveries, frames, responses and columns (06-02/10/12/16): `build-model-messages.test.ts`, `multiplayer.int.test.ts`, `ai-chat-delivery.int.test.ts`, `security.int.test.ts` |
| MULTI-07 | Phase 6 | Delivered (fixture + opt-in run) | Six three-participant cases run free on every test run; opt-in metered `eval:multiplayer` (dry run, confirmation, key never printed) and `ai-eval.yml` on label/weekly/dispatch (06-05/09): `spoof-cases.ts`, `build-model-messages.test.ts`, `eval/multiplayer/eval.test.ts`. The owner's metered run is deferred (`human_needed`, 06-VALIDATION); the CI run awaits Actions billing |
| MULTI-08 | Phase 6 | Delivered | Scenario B 1–4 with the mock model at 1440 and 390, and a fresh-stack Phase 6 day (06-03/11/16): `ai-chat-multiplayer.spec.ts`, `ai-chat-multiplayer-day.spec.ts` |
| AGENT-01 | Phase 6 | Delivered | Personas scoped to organization/department/team/project/personal with an owner and tools; admins anywhere, unit leads in their subtree; unit visibility; unit deletion guard (ADR-0020, 06-01/07): `personas.int.test.ts`, `resolve.test.ts`; `agent-personas.spec.ts` |
| AGENT-02 | Phase 6 | Delivered | Agents in channels, DMs, group DMs and AI chats (added by the owner, answer through OpenClaw, flat), in member and participant lists (06-10/12): `ai-chat-delivery.int.test.ts`, `team-dm.int.test.ts`, `group-dm.int.test.ts`; `ai-chat-agents.spec.ts`, `ai-chat-multiplayer-day.spec.ts`. Real OpenClaw cell proof pending (CI billing) |
| AGENT-03 | Phase 1 | Delivered | `chat.int.test.ts` "an agent mention auto-adds the bot and calls the bridge once, in the thread"; `agent-channel.int.test.ts` mention → reply; `bots.spec.ts` threaded reply |
| AGENT-04 | Phase 6 | Delivered | Typed cards in their own table, updated in place by the posting agent only, Open (internal routes) / Follow / one audited Approve, `ocw_agent_card` tool, card-action turns, one renderer (ADR-0020, 06-13/14/15): `cards.int.test.ts`, `card-tool.test.ts`, `agent-card.test.tsx`; `agent-cards.spec.ts`, `ai-chat-multiplayer-day.spec.ts` |
| SELF-01 | Phase 7 | Complete (owner clean-machine check: human_needed) | `git clone` + `pnpm ocw setup` + `docker compose up -d --build --wait` from a fresh clone, then the compose gate on it: `pnpm gate:cleanroom` green (07-11); `proxy`/`observability`/`vault` profiles via compose `include:`, enabled later without reinstall (07-03/06/07/08): `setup.test.mjs`, `enable-*.test.mjs`, `docs/INSTALL.md`. The owner's real clean-machine install is deferred (`human_needed`, 07-11 Task 3) |
| SELF-02 | Phase 7 | Complete | Secrets written only by `ocw setup` (never at boot, never printed); env/file and OpenBao behind one `SecretStore` contract suite against real OpenBao 2.7.1; `ocw enable vault` (07-04/06): `setup.test.mjs`, `secret-store.test.ts`, `openbao.int.test.ts`, `enable-vault.test.mjs`; gate stage `vault` |
| SELF-03 | Phase 7 | Complete | One-shot `migrate`; the API refuses a behind/ahead/diverged/unmigrated schema; N-1 (`3bbcbd9`, then the previous tag) → N upgrade test on every `pnpm verify` (07-02/10): `schema-check.test.ts`, `schema-guard.int.test.ts`, `upgrade.int.test.ts`; gate stage `schema-refusal` |
| SELF-04 | Phase 7 | Complete | `pnpm ocw backup` / `restore` as `ocw_migrator` (DB, objects, cell state, OpenBao with the vault), refuses newer or tampered backups, documented in `docs/self-hosting/backup-restore.md` (07-09/10): `backup.test.mjs`, `object-store.int.test.ts`; gate stages `backup` (fresh volumes, `--consistent`, `--force-recreate`) and `vault-backup` (new machine) |
| SELF-05 | Phase 7 | Complete | Caddy `proxy` profile, one HTTPS origin, `OCW_TRUST_PROXY` (07-05/08): `compose-proxy.test.mjs`, `enable-proxy.test.mjs`, `trust-proxy.int.test.ts`, `session-ip.int.test.ts`; gate stage `proxy` (WebSocket 101 with frames, presigned PUT/GET from outside the network, tampered/unsigned 403, forged XFF ignored). Residual: `OCW_TRUST_PROXY=1` trusts any direct peer (ADR-0021) |
| SELF-06 | Phase 7 | Complete | Every package declares AGPL-3.0-only or Apache-2.0 (`packages/contracts`; `packages/protocol` does not exist yet); dependency-license policy in `pnpm guard`, with the `@anthropic-ai/claude-agent-sdk` exception and the `server-everything` clarification pending owner/legal confirmation (ADR-0021, 07-01): `guard.test.mjs` |
| SELF-07 | Phase 7 | Complete | Scenario B minus Work Zone creation through Caddy on production images with the org mock model, desktop 1440 and mobile 390, no skip allowed (07-10): `e2e/compose/scenario-b.spec.ts`, gate stage `playwright` (4 passed, 0 skipped/failed/flaky) on `pnpm gate:compose` and `pnpm gate:cleanroom`. CI: the same commands on Woodpecker (separate task) |
| BOARD-01 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| BOARD-02 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| BOARD-03 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| BOARD-04 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| BOARD-05 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| BOARD-06 | Phase 07.1 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-01 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-02 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-03 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-04 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-05 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-06 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| MEM-07 | Phase 07.2 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| ACCESS-01 | Phase 07.3 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| ACCESS-02 | Phase 07.3 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| ACCESS-03 | Phase 07.3 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-01 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-02 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-03 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-04 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-05 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| CONN-06 | Phase 07.4 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| APPROVE-01 | Phase 07.5 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| APPROVE-02 | Phase 07.5 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| APPROVE-03 | Phase 07.5 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| APPROVE-04 | Phase 07.5 | Pending | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-01 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-02 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-03 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-04 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-05 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| AUTO-06 | Phase 07.6 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| A2A-01 | Phase 07.7 | Complete (owner check in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| A2A-02 | Phase 07.7 | Complete (owner check in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| A2A-03 | Phase 07.7 | Complete (owner check in docs/DEMO.md: human_needed) | New (owner, 2026-10-08; research `.planning/research/OPS-FEATURES.md`) |
| SBX-01 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| SBX-02 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| SBX-03 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| SBX-04 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| SBX-05 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| BRW-01 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| BRW-02 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| BRW-03 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| BRW-04 | Phase 07.8 | Pending | New (owner, 2026-10-14) |
| WZP-01 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-01, 02, 04, 13) |
| WZP-02 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-02, 04, 05, 12) |
| WZP-03 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-02, 04, 06, 13) |
| WZP-04 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-01, 02, 05, 06, 10) |
| WZP-05 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-01, 05, 06) |
| WZP-06 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-01, 02, 07, 12) |
| WZP-07 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-03, 05, 06, 07, 12) |
| WZP-08 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-02, 03, 05, 08, 15) |
| WZP-09 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-09, 10, 14) |
| WZP-10 | Phase 07.9 | Pending | New (owner, 2026-10-22; plans 07.9-11, 13) |
| WZS-01 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-03, 04, 06) |
| WZS-02 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-01, 03, 04, 06) |
| WZS-03 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-01, 03, 06) |
| WZS-04 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-03, 04, 06) |
| WZS-05 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-02, 04, 06) |
| WZS-06 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-02, 03, 05, 06) |
| WZS-07 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-01, 05, 06) |
| WZS-08 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-04, 05, 06) |
| WZS-09 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-01, 02, 03, 04, 06) |
| WZS-10 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-01, 02, 06) |
| WZS-11 | Phase 07.10 | Pending | New (owner, 2026-10-27; plans 07.10-03, 04, 05, 06) |
| RTU-01 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-01, 04, 07, 11) |
| RTU-02 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-04, 05, 07, 09, 11) |
| RTU-03 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-01, 03, 06, 07, 10, 11) |
| RTU-04 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-04, 05, 07, 09, 11) |
| RTU-05 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-01, 02, 06, 07, 08, 10, 11) |
| RTU-06 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-01, 02, 06, 09, 10, 11) |
| RTU-07 | Phase 07.11 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-28; plans 07.11-08, 09, 10, 11) |
| HSR-01 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-01, 06, 09, 10, 11) |
| HSR-02 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-08, 09, 10, 11) |
| HSR-03 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-01, 02, 03, 07, 09, 11) |
| HSR-04 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-01, 03, 04, 08, 11) |
| HSR-05 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-05, 08, 09, 10, 11) |
| HSR-06 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-09, 10, 11) |
| HSR-07 | Phase 07.12 | Complete (owner checks in docs/DEMO.md: human_needed) | New (owner, 2026-10-29; plans 07.12-10, 11) |
| COA-01 | Phase 07.14 | Complete | New (owner, 2026-11-06) |
| COA-02 | Phase 07.14 | Complete | New (owner, 2026-11-06) |
| COA-03 | Phase 07.14 | Complete | New (owner, 2026-11-06) |
| COA-04 | Phase 07.14 | Complete | New (owner, 2026-11-06) |
| COA-05 | Phase 07.14 | Complete | New (owner, 2026-11-06) |
| BRA-01 | Phase 07.15 | Pending | New (owner, 2026-11-07) |
| BRA-02 | Phase 07.15 | Pending | New (owner, 2026-11-07) |
| BRA-03 | Phase 07.15 | Pending | New (owner, 2026-11-07) |
| BRA-04 | Phase 07.15 | Pending | New (owner, 2026-11-07) |
| BRA-05 | Phase 07.15 | Pending | New (owner, 2026-11-07) |
| BWZ-01 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| BWZ-02 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| BWZ-03 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| BWZ-04 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| BWZ-05 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| BWZ-06 | Phase 07.16 | Complete | New (owner, 2026-11-09) |
| AFO-01 | Phase 07.17 | Complete | New (owner, 2026-11-09) |
| AFO-02 | Phase 07.17 | Complete | New (owner, 2026-11-09) |
| AFO-03 | Phase 07.17 | Complete | New (owner, 2026-11-09) |
| AFO-04 | Phase 07.17 | Complete | New (owner, 2026-11-09) |
| AFO-05 | Phase 07.17 | Complete | New (owner, 2026-11-09) |
| BWF-01 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-02 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-03 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-04 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-05 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-06 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-07 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
| BWF-08 | Phase 07.17.1.1 | Pending | New (owner, 2026-11-11) |
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
| WZUI-08 | Phase 11 | Pending | Image attachments delivered by WZ-IMG-01 (Phase 06.1); no @file mentions |
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
- Status (recounted from the table on 2026-10-07 after Phase 6, 147 rows incl. the Phase 3.x additions): 86 Delivered,
  31 Partial, 25 Pending, 5 Superseded
- Phase 06.1 (2026-10-07) adds WZ-IMG-01…04 (owner request), all Complete: 151 rows
- Phase 7 (2026-10-08): FOUND-05…07 and SELF-01…07 Complete (10 rows from Partial/Pending); SELF-01's clean-machine check
  on real hardware is deferred to the owner (`human_needed`)

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
*Last updated: 2026-11-02 after Phase 07.6 was built (AUTO-01…06 complete; owner checks human_needed). Previously: 2026-10-29 after Phases 07.11 and 07.12 were built (RTU-01…07, HSR-01…07 complete; owner checks human_needed). Previously: 2026-10-29 when Phase 07.12 was planned (HSR-01…07 added, owner request). Previously: 2026-10-28 when Phase 07.11 was planned (RTU-01…07 added, owner request). Previously: 2026-10-27 when Phase 07.10 was planned (WZS-01…11 added, owner request). Previously: 2026-10-22 when Phase 07.9 was planned (WZP-01…10 added, owner request). Previously: 2026-10-08 after Phase 7 (FOUND-05…07, SELF-01…07 complete; FOUND-06 says Garage, not MinIO; owner clean-machine check human_needed). Previously: 2026-10-07 after Phase 6 (MULTI-01…08, AGENT-01/02/04 delivered; MULTI-07's metered run deferred to the owner). Previously: 2026-10-07 after Phase 5 (AICHAT-01…09 delivered); before that: 2026-10-06 after Phase 4 (CHAT-02, CHAT-04…14 delivered); before that: 2026-10-04 after the Phase 1 code audit (Restructure 2026-10-04: SLICE-06…18 added, SLICE-01…04 and DEV-07 superseded, traceability re-mapped)*
