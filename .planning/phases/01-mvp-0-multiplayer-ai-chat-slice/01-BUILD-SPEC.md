# Phase 1 — MVP 0 Build Spec (investor demo)

**Owner decision 2026-10-02:** ship overnight a working web + desktop product with (1) Slack-style chat
(channels + threads + @mentions), (2) a one-click OpenClaw bot configurator (bots are first-class
members you @mention in channels/threads), (3) a Work Zone that runs Claude Code on a paired desktop
against a registered repo, controlled from web or desktop, so the product can be improved from its own
UI. This spec is the single coordination contract for every build agent. `01-RESEARCH.md` holds the
verified technical detail (versions, RLS, better-auth, realtime, pitfalls) — follow it unless this file
overrides it.

Locked owner decisions: Work Zone runs on the user's SUBSCRIPTIONS — Claude via the local Claude Code login and Codex via the local `codex` CLI login (ChatGPT); no API keys required, API-key env vars stripped from child processes by default. MinIO dropped (no object store in Phase 1). Third DB role `ocw_auth` + schema
`auth` approved. Bot model fixed per bot (chosen at creation from an org allowed list). OpenClaw from MVP 0.

## Non-negotiables (from AGENTS.md — never trade these for speed)
- Tenant isolation: org-scoped tables in schema `app`, FORCE RLS, `withTenant()` only, `nullif` policies.
- Every sensitive action → `audit.record(tx, …)` in the same transaction.
- Agents are first-class principals (own table, memberships, author_kind `agent`), never a bot flag.
- No absolute host paths leave the device; only repo-relative paths and opaque project ids.
- Secrets never in DB plaintext/logs/prompts; env or `*_FILE` via `SecretStore`; DB stores `SecretReference`s.
  Exception allowed for the demo: provider API keys entered in the admin UI are stored encrypted
  (AES-256-GCM with `OCW_ENCRYPTION_KEY`) in `app.secrets` and referenced by id — never returned by the API.
- Never enable bypass-permissions modes in any runtime. Never expose a TCP port for the daemon.
- OpenClaw only talks to our Agent Channel API, never to DB/Redis/internals.
- CI/tests never call metered models (mock providers).
- English for code/docs/commits. Conventional Commits with scope (`api`, `web`, `db`, `contracts`, …).

## Monorepo
```
package.json (packageManager pnpm@12.8.1; scripts dev/lint/typecheck/test/verify/e2e)
pnpm-workspace.yaml  turbo.json  biome.json  .nvmrc (24.21.0)  compose.yaml  compose.e2e.yaml  .env.example
apps/api            Fastify 5 modular monolith (modules below), port 4000
apps/web            Next.js 16 App Router + Tailwind 4 + shadcn (Base UI), port 3000
apps/desktop        Electron shell: pairs device, supervises local-runtime, opens the web UI
apps/local-runtime  Daemon: outbound WS to API, project registry, Claude Code adapter (Agent SDK), git
apps/openclaw-channel  OpenClaw native channel plugin → our Agent Channel API
packages/config     tsconfig base, biome preset
packages/contracts  Zod: domain, REST DTOs, realtime envelope, Agent Channel API, Unified Session Event Protocol, Device Link protocol (Apache-2.0)
packages/db         Drizzle schema (app + auth), migrations, bootstrap SQL, withTenant
packages/realtime-client  framework-agnostic WS client (backoff, resume, gap detection) + zustand/vanilla stores
e2e/                Playwright
```
If TypeScript 7 / pnpm 12 / Drizzle rc cause friction that costs > 20 min, fall back (TS 6/5.9, pnpm 11,
drizzle 0.45.3) and record it in `01-DEVIATIONS.md`. Working software tonight beats version purity.

## API modules (apps/api/src/modules/<name>/index.ts public interface; explicit constructor wiring in app.ts)
identity · organization (members list, roles owner/admin/member) · audit · realtime · chat · agent ·
agent-channel · secrets · device · work-session

## Data model (schema `app`, all with organization_id + RLS unless noted)
- `org_members` projection (user_id, display_name, avatar_url, role) maintained by identity in same tx.
- `principals` view not needed; author refs use (`author_kind` 'user'|'agent'|'system', `author_id`).
- `conversations(id uuidv7, organization_id, kind 'channel'|'dm'|'group'|'ai_chat'|'thread'|'work_session', name, slug, topic, visibility 'public'|'private', parent_conversation_id, root_message_id, created_by, archived_at, created_at)` — channel threads: kind `thread`, parent = channel, root_message_id = the parent message.
- `conversation_members(conversation_id, organization_id, member_kind 'user'|'agent', member_id, role 'owner'|'member', joined_at)`.
- `messages(id, organization_id, conversation_id, seq, author_kind, author_id, body text (markdown), mentions jsonb [{kind:'user'|'agent', id}], status 'sent'|'streaming'|'completed'|'failed', thread_id null, reply_count int, last_reply_at, client_kind, session_id, created_at, edited_at)`.
- `streams(id text 'conv:<id>'|'user:<id>'|'org:<id>'|'ws:<id>', organization_id, last_seq)`, `stream_events(stream_id, seq, organization_id, type, payload jsonb, created_at)`.
- `audit_events` per research Pattern 10 (append-only).
- `agents(id, organization_id, name, username unique per org, avatar_url, description, instructions, model_provider, model_id, runtime 'openclaw', status 'provisioning'|'ready'|'error'|'disabled', runtime_ref jsonb (OpenClaw agent id etc.), created_by, created_at)`.
- `agent_credentials(id, organization_id, agent_id null, kind 'channel_plugin', token_hash, created_at, revoked_at)` — Agent Channel API service tokens (store sha256 only).
- `secrets(id, organization_id, name, kind 'provider_api_key', provider, ciphertext, iv, tag, created_by, created_at)` — never selected into API responses.
- `model_providers(id, organization_id, provider 'anthropic'|'openai'|'openrouter'|'mock', secret_id, allowed_models text[], enabled)`.
- `devices(id, organization_id, owner_user_id, name, platform, token_hash, status 'online'|'offline', last_seen_at, runtime_info jsonb, revoked_at, created_at)`; `device_enrollments(code_hash, organization_id, user_id, expires_at, consumed_at)`.
- `projects(id, organization_id, device_id, name, git_remote, default_branch, created_by, created_at)` — NO absolute path column, ever.
- `work_sessions(id, organization_id, conversation_id (kind work_session), project_id, device_id, runtime 'claude-code'|'codex', model, permission_mode 'default'|'acceptEdits'|'plan', status 'provisioning'|'idle'|'running'|'waiting_approval'|'host_offline'|'completed'|'failed'|'archived', title, created_by, runtime_session_id, created_at, updated_at)`.
- `work_prompts(id, organization_id, work_session_id, author_user_id, origin_device_id null, body, status 'queued'|'dispatched'|'running'|'completed'|'failed'|'cancelled', position, created_at, dispatched_at, completed_at)`.
- `work_approvals(id, organization_id, work_session_id, request jsonb (tool, input summary, repo-relative paths), status 'pending'|'approved'|'denied'|'expired', decided_by, decision 'once'|'session'|'deny', comment, created_at, decided_at)`.
- `work_events(work_session_id, seq, organization_id, type, payload, created_at)` OR reuse stream_events with stream `ws:<id>` (preferred: reuse).

Schema `auth` (better-auth tables, `ocw_auth` role only): user, session, account, verification, organization,
member, invitation, instance_setup.

## REST surface (all under /api/v1, cookie session; Zod-typed; OpenAPI at /docs)
- identity: `POST /setup`, `GET /setup/status`, `POST /invitations`, `GET /invitations/:id`, `POST /invitations/:id/accept`, `DELETE /invitations/:id`, `GET /me`; better-auth allowlist under `/api/auth/*` (sign-in/email, sign-out, get-session).
- organization: `GET /members`.
- chat: `GET/POST /channels`, `POST /channels/:id/join|leave`, `GET /conversations/:id/messages?before&limit`, `POST /conversations/:id/messages {body, mentions, threadRootId?}`, `GET /messages/:id/thread`, `POST /channels/:id/members {kind,id}` (add agent/user).
- agent: `GET/POST /agents` (one-click create: name, avatar, instructions, model), `PATCH /agents/:id`, `DELETE /agents/:id`, `POST /agents/:id/channels/:channelId` (add to channel). `GET/POST /model-providers` (admin: provider + API key → secrets), `GET /models` (allowed list).
- agent-channel (consumed ONLY by the OpenClaw plugin, bearer service token): see OpenClaw section.
- device: `POST /devices/enrollments` (user → short code, 10 min), `POST /devices/enroll {code, name, platform}` (desktop → device token, returned once), `GET /devices`, `DELETE /devices/:id` (revoke → disconnect).
- projects: `GET /projects`, (projects are registered by the daemon over the Device Link).
- work-session: `GET/POST /work-sessions`, `GET /work-sessions/:id`, `POST /work-sessions/:id/prompts`, `PATCH /work-sessions/:id/prompts/:pid` (edit/reorder/cancel while queued), `POST /work-sessions/:id/interrupt`, `POST /work-sessions/:id/approvals/:aid {decision, comment}`, `GET /work-sessions/:id/diff`, `POST /work-sessions/:id/archive`.

## Realtime
Browser: `GET /ws` (cookie, Origin check) with envelope from research Pattern 5 (`sub/unsub/ping` → `ev/eph/subscribed/resync/err`). Topics: `conv:<id>`, `user:<id>`, `org:<id>` (channel list, agents, devices, sessions changes), `ws:<id>` (work session events).
Device: `GET /runtime/ws` with `Authorization: Bearer <device token>`; Device Link frames (contracts): `hello{protocolVersion, device, runtimes:[{id:'claude-code', installed, version, loggedIn}]}`, `projects.sync{projects:[{localId, name, gitRemote, defaultBranch}]}`, `heartbeat`, server→device `command{id, kind:'session.start'|'prompt'|'interrupt'|'approval.resolve'|'session.stop'|'diff.request', sessionId, payload}`, device→server `ack{commandId}`, `event{sessionId, event: SessionEvent}`, `diff.result{requestId, files:[{path(relative), status, additions, deletions}], patch}`.

## Unified Session Event Protocol (contracts, subset for MVP 0)
`session.started`, `session.state{status}`, `prompt.started{promptId}`, `assistant.delta{messageId,text}` (ephemeral), `assistant.message{messageId,text}`, `tool.started{toolUseId,name,summary}`, `tool.completed{toolUseId,ok,summary,output?(truncated)}`, `approval.requested{approvalId,tool,summary,paths[]}`, `approval.resolved{approvalId,decision}`, `prompt.completed{promptId, usage, costUsd?}`, `session.error{message}`, `runtime.raw{type,data}`. All text fields pass `redact()` (secrets) and `contain()` (absolute paths → repo-relative) on the device before leaving.

## OpenClaw (details come from the research addendum in 01-RESEARCH.md — read it)
- `openclaw` service in compose running the OpenClaw gateway with our channel plugin installed from `apps/openclaw-channel`.
- One-click bot: web form (name, avatar emoji/url, personality/instructions, model from allowed list) → `POST /agents` → API persists agent (status provisioning) → provisions the agent in the OpenClaw gateway (config/API per addendum) → status ready → bot appears in the members list and can be added to channels. Delete/disable deprovisions.
- Inbound: a message in a channel/thread that @mentions the bot (or a DM to it) → agent-channel delivers to the plugin (WS or long-poll, plugin-initiated, bearer token) with conversation id, thread root, author (id, display name, kind), participant roster, recent thread context, mentions.
- Outbound: plugin posts the agent reply → `POST /agent-channel/v1/messages` → stored with author_kind `agent`, in the thread (reply in thread when triggered from a thread or channel root message), realtime fan-out, typing indicator while generating (`eph` `agent.typing`).
- Tools: OpenClaw dangerous tools (exec, fs write outside its sandbox, browser) disabled by default for MVP 0 bots.
- Model credentials: from the org model provider configured in admin settings; injected into OpenClaw via env/secret file at provisioning time, never via chat.
- CI: mock OpenAI-compatible endpoint (tiny server in `compose.e2e.yaml`) so the real OpenClaw + plugin path runs without a paid model.

## Web UI (design-conscious; responsive; verified at 390px and 1440px; dark+light)
App shell: left rail (Chat · Bots · Work Zone · Settings), workspace switcher with org name, user menu.
- Auth: `/setup` (token + admin + org), `/login`, `/invite/[id]`.
- Chat: sidebar channel list (+ create channel), channel view with message list, composer with @mention autocomplete (users + bots), thread side panel (reply count, participants), bot messages with bot badge + avatar, typing indicator, unread dot (simple). Markdown + code highlighting in messages.
- Bots: gallery of bots (status chip), "New bot" one-click sheet with presets (e.g. "Product Manager", "Code Reviewer", "Researcher") prefilled → Create → live status provisioning→ready → "Add to channel". Settings › Models: add provider API key, choose allowed models.
- Work Zone: session sidebar grouped by project with status chips; "New session" dialog (device, project, model, permission mode); session view: event stream (assistant messages, collapsible tool calls), composer (adds to shared queue), queue panel (author, edit/remove/reorder), sticky approval banner (approve once / allow for session / deny), Changes panel (files + unified diff), header (host device, runtime, branch, presence). Devices page: add device → shows pairing code.
- Visual quality: shadcn components, consistent spacing, empty states with clear CTA, no filler copy.

## Desktop (apps/desktop, Electron)
First launch: server URL (default http://localhost:3000 / api 4000) + pairing code → `POST /devices/enroll` → token stored with `safeStorage`. Supervises `local-runtime` as a child process (Unix socket for status, no TCP port). Main window loads the web app URL (deviation from DESK-01 bundled renderer, recorded in 01-DEVIATIONS.md) with contextIsolation, sandbox, no nodeIntegration, narrow preload exposing `ocw.desktop.{status, addProject(pick folder), openInEditor(relPath)}`. Tray shows daemon status. "Add project" uses the native folder picker → daemon registers it (absolute path stays in the daemon's local store `~/.ocw/projects.json`). Run with `pnpm --filter @ocw/desktop dev`; package an unsigned macOS .app with electron-builder if time permits.

## Local runtime (apps/local-runtime)
Node daemon. Connects outbound to `/runtime/ws`, reconnect with backoff, offline append log replay. Claude Code adapter via `@anthropic-ai/claude-agent-sdk` `query()` with streaming input (AsyncIterable of user messages), `cwd` = project path (or a git worktree per session under `<repo>/.ocw-worktrees/<session>` when requested), `permissionMode` from session (never `bypassPermissions`), `canUseTool` → emits `approval.requested` and awaits `approval.resolve` command (timeout → deny), `disallowedTools`/deny rules for secret paths (`.env*`, `~/.ssh`, keychains). Interrupt via `query.interrupt()`. Maps SDK messages → Unified Session Event Protocol; unknown → `runtime.raw`. Runtime detection: `claude --version` + auth status. Auth: the user's local subscription logins only (Claude Code CLI via `pathToClaudeCodeExecutable`; Codex via `codex app-server` with the ChatGPT login); ANTHROPIC_API_KEY/OPENAI_API_KEY stripped from child env unless explicitly opted in. Codex adapter: `codex app-server` JSON-RPC, sandbox workspace-write, approval policy on-request, never danger-full-access. Git adapter: branch, head, dirty, `git diff --stat` + patch (repo-relative).

## Verification (definition of done for the demo)
1. `pnpm install && pnpm verify` green. 2. `docker compose up` brings up postgres, redis, migrate, api, web, openclaw; `/health` ok. 3. Playwright E2E (mock models): setup → invite → second user joins → create channel → one-click create bot → add bot to channel → human A @mentions bot in a thread → bot replies in thread naming A; human B sees it live. 4. RLS cross-tenant test green. 5. Work Zone E2E with a fake daemon (contracts-level) green; manual demo with real desktop + Claude Code on this repo: create session, prompt "add X", approval appears in web, approve, diff shows. 6. Screenshots of every main screen at desktop + mobile width in `.planning/phases/01-…/screenshots/`.

## OpenClaw decisions (orchestrator, 2026-10-02, owner delegated control)
Resolving the open questions of Addendum A in 01-RESEARCH.md:
1. OpenClaw's own server-generated sender metadata + sanitized `sender: body` history is accepted as MVP 0's structural identity (we feed it structured, server-verified author ids/names; never trust text prefixes).
2. Bot config sync lives in the plugin: the plugin reads `GET /agent-channel/v1/cell` (bots + model + instructions) and reconciles OpenClaw agent entries; API never gets an OpenClaw admin token. Fallback if the sync proves impossible: API-side responder behind the same Agent Channel API (documented in the addendum).
3. Pin `openclaw@2026.9.7` (the version verified locally).
4. Real-OpenClaw E2E runs on main/nightly and locally; PR CI runs the plugin contract tests + API E2E with the fake model.
5. Default real model for new bots: `claude-sonnet-5-5` (metered; owner configures their own provider key in Settings › Models).
6. Docker disk: ~8 GB free in the Docker VM. Do not prune other projects' images/volumes. Use slim base images, `docker image prune` only for images you built, prefer `extended` multi-stage builds with small runtime layers. OpenClaw admin port 18789 is never published; the OpenClaw container sits on an internal network with egress only to the model provider (and the fake model in e2e).
