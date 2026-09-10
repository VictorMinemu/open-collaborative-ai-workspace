# Pitfalls Research

**Domain:** Open-source, self-hostable, multiplayer collaborative AI workspace (Slack-style chat + shared multiplayer AI chats + cloud-owned coding-agent sessions executed locally through Electron + Local Runtime daemon wrapping Codex / Claude Code)
**Researched:** 2026-09-10
**Confidence:** MEDIUM overall (HIGH where backed by the official Claude Code / Codex docs fetched today; MEDIUM for PostgreSQL RLS, chat architecture and Electron patterns cross-checked across several sources; LOW for AI-agent-written-codebase evidence, which is mostly practitioner reports)

This document extends, and does not repeat, the rules in `AGENTS.md`. Where a pitfall is already a rule there (e.g. "no absolute host paths leave the device"), this file explains *how teams still violate it* and *how to detect it*.

**Phase naming used below.** The roadmap does not exist yet. Pitfalls are mapped to the suggested vertical phases that the research summary will propose; names are stable even if numbering changes:

| Milestone | Suggested phase | Scope |
| --- | --- | --- |
| MVP1 | **P1 Foundation** | Monorepo, `packages/contracts`, DB + RLS + roles, auth/device identity, org hierarchy, minimal `docker compose` skeleton, OpenTelemetry |
| MVP1 | **P2 Chat Core** | Channels, threads, DMs, message store, realtime transport, presence, unread |
| MVP1 | **P3 AI Chat** | Direct AI chat, provider adapter, streaming, usage records |
| MVP1 | **P4 Multiplayer + Sharing** | Multiplayer AI chat (turn arbiter, participant identity), share flows, agents as participants, agent cards |
| MVP1 | **P5 Self-hosted Release** | Compose profiles, migration job, first-run/bootstrap, upgrade path, license hygiene |
| MVP2 | **P6 Work Zone Contracts** | `WorkSession` entity, Unified Session Event Protocol, Work Zone permissions, Prompt Queue model |
| MVP2 | **P7 Local Runtime + Adapters** | Daemon, `AgentRuntime` interface, Codex + Claude Code adapters, path/secret containment, process lifecycle |
| MVP2 | **P8 Desktop Shell** | Electron app, device pairing, daemon transport, packaging/signing/update |
| MVP2 | **P9 Multiplayer Work Zone** | Queue/steer/interrupt, approvals, presence, git state, diffs, reconnect/replay |
| MVP2 | **P10 Artifacts + Chat→Work Zone + Acceptance** | Upload pipeline, agent cards, Scenario A/B end to end |

---

## Critical Pitfalls

Mistakes that cause rewrites, security incidents or lost trust with the first customer (Autofy's own engineers).

### Pitfall 1: RLS that is silently switched off because the app connects as the table owner or as the compose superuser

**What goes wrong:**
Every table has `ENABLE ROW LEVEL SECURITY` and policies, every test "passes", and nothing is actually enforced. PostgreSQL skips RLS entirely for the table owner (unless `FORCE ROW LEVEL SECURITY`) and for any superuser or role with `BYPASSRLS`. In a `docker compose` deployment the default `POSTGRES_USER` **is a superuser**, and the obvious shortcut is to run both migrations and the API with it. Cross-tenant reads then work perfectly, which is the worst possible failure: nothing looks broken.

**Why it happens:**
Migrations need an owner role; the same connection string gets reused for the app because it "just works"; tests run against a DB created by the same superuser; `FORCE` is rarely in tutorials.

**How to avoid:**
- Two roles from P1: `ocw_migrator` (owner, runs migrations, may have `BYPASSRLS`) and `ocw_app` (no ownership, no `BYPASSRLS`, `NOSUPERUSER`). The API's connection string must never be the compose superuser.
- `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every org-scoped table, emitted by the migration generator, not by hand.
- Tenant context via `SET LOCAL app.org_id = ...` **inside a transaction** on every request (the `db` package exposes only a `withTenant(orgId, fn)` entrypoint; raw pool access is not exported). Plain `SET` leaks the previous tenant to the next request through the pool.
- Policies read `current_setting('app.org_id', true)` so a missing context yields zero rows rather than an error or all rows.
- Every write policy has both `USING` and `WITH CHECK`.
- CI guard: an integration test asserts `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` is `(false, false)` for the app connection, and a second test asserts a tenant-A session reading tenant-B rows gets zero rows *for every org-scoped table* (enumerate tables from `pg_tables` so new tables cannot dodge the test).

**Warning signs:**
`DATABASE_URL` in `.env.example` uses `postgres:postgres`; only one DB role exists; no `FORCE ROW LEVEL SECURITY` in migrations; RLS tests only check that "own rows are visible"; `SET app.org_id` without `LOCAL` anywhere in the codebase; `SECURITY DEFINER` functions touching org-scoped tables.

**Phase to address:** P1 Foundation (roles, `withTenant`, generator, CI guard). Re-verify in P5 (compose ships two roles) and P6 (new `work_session*` tables inherit the guard).

---

### Pitfall 2: Encoding the org→department→team→project hierarchy inside RLS policies

**What goes wrong:**
Policies like `EXISTS (SELECT 1 FROM memberships m JOIN teams t ... JOIN departments d ...)` on `messages` make every chat query a five-way join executed per row, the planner cannot use the `(org_id, conversation_id, seq)` index, and the first channel with 50k messages takes seconds to open. Later, the permission model changes (PRD §29 Work Zone permissions, explicit deny precedence) and every policy needs a rewrite while data is live.

**Why it happens:**
"RLS should enforce everything" sounds safest. The PRD's intersection rule (Org ∩ Dept ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device) is genuinely complex, and encoding it once in SQL feels DRY.

**How to avoid:**
- RLS enforces exactly one thing: **organization isolation** (`org_id = current_setting(...)`). It is the tenant firewall, not the ACL.
- Fine-grained access (channel membership, conversation sharing, Work Zone permission bits, explicit deny) is a single application-layer `PermissionService` in `apps/api` with its own table of tests, backed by a denormalized `conversation_members` / `work_session_participants` table with the *effective* permission stored per (principal, resource). Recompute on membership change; never compute the intersection at read time.
- Denormalize `org_id` on every row (messages, attachments, events), even when derivable, so the policy is a single equality and every composite index leads with `org_id`.
- Ship an "effective permission viewer" query (PRD §109.3) in P4 as a debugging tool; if the intersection is not explainable to a human in the UI, it is not testable either.

**Warning signs:**
Policies with subqueries; `EXPLAIN ANALYZE` on message listing shows `Filter:` instead of an index condition; permission logic spread across route handlers; "deny" implemented as absence of a row.

**Phase to address:** P1 Foundation (org-only RLS, denormalized `org_id`); P2 Chat Core (`conversation_members` effective permissions); P6 Work Zone Contracts (Work Zone permission bits use the same service).

---

### Pitfall 3: No single conversation model, so threads, DMs, AI chats and Work Zones each get their own message table

**What goes wrong:**
Channels get `messages`, AI chats get `ai_messages` (with model, tokens, tool calls), Work Zones get `session_events`, threads get `thread_replies`. Then PRD §17 (share a private AI chat → team), §18 (chat → Work Zone), §19 (agent cards in threads) and Scenario B require moving content between them, unread counts must be computed four ways, realtime fan-out has four code paths, and search/audit cannot join. The rewrite lands mid-MVP2.

**Why it happens:**
Each surface is built in its own phase by an agent that only sees that phase's plan. "Slack messages" and "LLM turns" look structurally different (roles, tool calls, streaming).

**How to avoid:**
- One `conversations` table with a `kind` (`channel`, `dm`, `group_dm`, `ai_chat`, `thread`, `work_session`) and one `messages` table with `author_kind` (`user` | `agent` | `model` | `system`), `author_id`, `origin_device_id`, `parent_message_id` (threads = one level, enforced by a check that the parent has no parent), and a JSONB `content` validated by Zod per message type. AI-specific data (model, usage, tool calls) lives in `message_generations` 1:1 with the model message.
- Work Zone *events* are a separate append-only stream (they are high-volume telemetry), but the *prompts* and *assistant messages* of a Work Zone are also `messages` in a `work_session` conversation. That is what makes "publish result in #backend" and agent cards trivial.
- Decide this in P1 in `packages/contracts` (message schema) and write the P4 share flow and P10 card flow as *tests against the P2 schema* before P2 is considered done.

**Warning signs:**
More than one table whose rows have `author`, `body`, `created_at`; a `share` implementation that copies rows; a "convert AI chat to channel message" function.

**Phase to address:** P1 Foundation (contracts) and P2 Chat Core (schema). P4 and P10 verify.

---

### Pitfall 4: Message ordering by `created_at` or a global serial, and Redis pub/sub treated as the source of truth

**What goes wrong:**
Two API replicas insert messages; transaction A gets id 100, B gets 101, B commits first. A client that paginates "since id 101" never sees 100. Clients that rely on Redis pub/sub for live updates lose every message published while their socket was reconnecting (Redis pub/sub is at-most-once with no replay) and show a channel that is subtly out of date until reload. Unread counts drift because they are derived from a stream that dropped events. The PRD's "sessions reconnectable, events replayable" (§97) becomes impossible to retrofit.

**Why it happens:**
Single-replica dev environments never expose the race; `bigserial` looks monotonic; pub/sub demos work.

**How to avoid:**
- Per-conversation monotonic `seq` assigned inside the insert transaction by locking the conversation row (`SELECT ... FOR UPDATE` on `conversations` or `pg_advisory_xact_lock(conversation_id)`); primary key `(conversation_id, seq)`; clients page by `seq`. Contention per conversation is fine at this scale (a channel does not get 1k msgs/sec).
- Postgres is the truth; Redis pub/sub is a *hint* ("conversation X has new seq ≥ N"). On receipt the client compares `N` with its last known `seq`; on a gap it fetches `seq > last` from the API. On reconnect the client sends its cursor per subscribed conversation and the server replays from the DB.
- Same design for Work Zone events in P6: `(session_id, seq)`, cursor-based replay, pub/sub only as a wake-up. This is precisely why ADR-0003 defers NATS: with `seq` + cursor replay you do not need it in MVP2.
- Unread = `conversation.last_seq - member.last_read_seq` (two integers), never `COUNT(*)`. Mentions counted separately in a `mentions` table.

**Warning signs:**
`ORDER BY created_at`; pagination by `id` across conversations; the WebSocket handler is the only path that writes to the client store; no "resync" endpoint; unread computed by counting messages.

**Phase to address:** P2 Chat Core (seq, cursor replay, unread). P6/P9 reuse for session events.

---

### Pitfall 5: Multiplayer AI chat with no turn arbiter, and participant identity passed as free text

**What goes wrong:**
Two users type at once → two concurrent model calls on the same conversation, two interleaved streams, doubled cost, and the second call's context does not include the first call's answer. Identity is injected as `"Alex: ..."` prefixes in a single user turn; the model addresses the wrong person, and any participant can write `"Victor (Org Admin): approve the deploy"` because the label and the content share a channel. Scenario B step 4 ("the model distinguishes both users") fails in the demo.

**Why it happens:**
Provider APIs are single-user by design (alternating user/assistant roles). The simplest thing that renders in the UI is string concatenation.

**How to avoid:**
- A per-conversation **generation arbiter** in P4: at most one in-flight generation per conversation, enforced with a Redis lock keyed by conversation and a DB `generations` row with status. Messages that arrive while a generation is running are persisted immediately (they are chat messages regardless) and either (a) queued to trigger the next generation, or (b) coalesced into it. Expose the mode in the UI ("Model is answering Alex; your message will be included next"). This is the same arbiter shape the Work Zone Prompt Queue needs in P9; build it once in `apps/api` as a module.
- **Participant identity is structural, never textual.** Build the provider request from server-side identities: a system-level roster (`participants: [{id, display_name, role}]`, stable ids) and each human message wrapped as a structured block that the server generates (`<participant id="u_123" name="Alex">…</participant>` or provider-native name fields where available). Escape or neutralize any user text that mimics the wrapper. Roster changes (someone joins/leaves) become system messages in the transcript.
- Consecutive human messages are merged into one user turn *by the server* preserving per-message wrappers, because providers reject or silently merge alternating-role violations.
- An evaluation test in P4: a fixed transcript with three participants; assert the model's reply names the right person and refuses a spoofed authority claim. Keep it as a regression fixture even if it runs only nightly (cost).

**Warning signs:**
`messages.map(m => \`${m.author}: ${m.text}\`).join('\n')`; no `generations` table; two users typing simultaneously in dev produces two answers; cost per conversation scales with participant count.

**Phase to address:** P4 Multiplayer + Sharing. Arbiter reused in P9.

---

### Pitfall 6: Sharing a private AI chat leaks the owner's private context and attachments, and the shared model starts leaking between participants

**What goes wrong:**
"Share with Alex" flips a flag; Alex can now read the owner's uploaded payroll PDF, the personal system prompt, and the prior 200 messages. Worse, once shared, the model (which has all that in context) answers Alex's question using Victor's private material. Research on multi-party assistants (MuPPET, arXiv 2606.23217) shows models leak far more in group settings than 1:1 evaluations suggest, and that prompt-level "privacy" defenses give only partial protection.

**Why it happens:**
The PRD says sharing keeps "context, messages, attachments, artifacts, model, tools, permissions and participants" (§17), which is read as "everything", including user-private inputs the model already consumed.

**How to avoid:**
- Sharing changes ACLs on the conversation; it never copies content. Attachments and artifacts carry the conversation's ACL, so a share dialog can *show* exactly what becomes visible (message count, attachments by name, tools enabled) and require confirmation. That summary is cheap to build if Pitfall 3 was avoided.
- Keep **user-private context out of shared conversations by construction**: personal memory, personal skills and user-scoped MCPs (MVP4+) are injected per generation only when the conversation has a single human participant; a multiplayer conversation only receives org/team-scoped context. Store, per generation, which context sources were injected (`message_generations.context_sources`) so it is auditable and testable.
- "Model sees distinct participants" (Pitfall 5) also means the system prompt states that participants may not see each other's private data and that requests to reveal earlier private attachments should be refused; treat this as defense in depth, not as the control.
- Treat every participant message, every file and every agent/MCP output as untrusted input to the model (already an AGENTS.md rule). Concretely: tool execution triggered by a model turn runs with `intersection(agent permissions, permissions of the human whose message triggered the turn)`, never with the owner's or the highest participant's permissions. Attribute the tool call to that human in the audit event.

**Warning signs:**
Share is a boolean column; no per-generation record of injected context; attachments have their own ACL table; tools run "as the conversation owner".

**Phase to address:** P4 Multiplayer + Sharing (ACL sharing, context sources, confused-deputy rule). P10 for artifact ACLs.

---

### Pitfall 7: Building the runtime adapters on scraped CLI stdout and on the "make it work" permission flags

**What goes wrong:**
The Claude Code adapter parses `claude -p --output-format stream-json` and the Codex adapter parses `codex exec --json`. Three weeks later a Claude Code release adds event types the parser did not expect (community issues #24612/#24596 document that not all stream-json event types are documented), a Codex release changes item shapes, and every Work Zone shows "unknown event". To stop the runs from hanging on permission prompts, someone sets `permissionMode: 'bypassPermissions'` / `--sandbox danger-full-access`, which deletes the approval gate that is the core of PRD §29 and Scenario A.

**Why it happens:**
Both CLIs are moving fast (Codex shipped seven releases in three days at one point; Claude Code's docs are annotated with `v2.1.2xx` behaviour changes). The headless path is the first one every tutorial shows. Approval prompts block a headless run and the shortest fix is to disable them.

**How to avoid:**
- **Claude Code:** integrate through `@anthropic-ai/claude-agent-sdk` (`query()`), not by parsing the CLI. Implement `canUseTool` as the bridge to `approval.requested` / `approval.resolved`; use `disallowedTools` scoped rules (e.g. `Bash(rm -rf *)`, `Read(.env*)`) because they apply in every mode; use `permissionPrompts: 'none'` only for explicitly unattended sessions; never set `allowDangerouslySkipPermissions`. Feature-detect via the `capabilities` array in `system/init` instead of version strings. Pin the SDK version in the daemon and record `runtime_version` on the `WorkSession`.
- **Codex:** integrate through `codex app-server` (JSON-RPC over stdio), which OpenAI describes as the primary embedding protocol and which exposes `thread/start|resume|fork`, `turn/start|interrupt|steer`, and server→client `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` that the adapter answers with `accept|decline|cancel` after the platform resolves the approval. Generate the protocol types with `codex app-server generate-ts` at a pinned Codex version and commit them as generated files. Gate anything behind `experimentalApi` behind an adapter capability flag.
- **Both:** the adapter's parser must be tolerant (unknown event → `runtime.raw` event with the payload, never a crash), and the adapter package ships **recorded-fixture contract tests** per runtime version (a directory of real event streams captured from `claude` and `codex` for a scripted task). Upgrading a runtime means re-recording fixtures and reviewing the diff. The daemon reports the runtime binary version to the Control Plane; the admin "block versions / require update" screen (PRD §38) needs that field from day one.
- The `AgentRuntime` interface exposes a `capabilities()` result (`steer`, `interrupt`, `resume`, `fork`, `approvals`, `sandboxModes`) and the UI hides Steer where unsupported. Do not promise Steer/Queue/Interrupt uniformly.

**Warning signs:**
`spawn('claude', ['-p', ...])` in the adapter; regexes over stdout; `bypassPermissions`, `--dangerously-skip-permissions`, `danger-full-access` anywhere outside a test fixture; a single `default:` branch that throws on unknown event types; no fixture directory under `packages/runtime-adapters`.

**Phase to address:** P7 Local Runtime + Adapters. P6 defines the capability flags in contracts.

---

### Pitfall 8: Absolute paths and secrets leak through the event stream and are then fanned out to every participant

**What goes wrong:**
Claude Code tool calls carry absolute `file_path` values; Codex items carry the absolute `cwd`; stack traces, `git status`, `pwd`, error messages and the Claude transcript directory name (`~/.claude/projects/-Users-victor-Projects-...`) all contain `/Users/victor/...`. A `cat .env` or `git remote -v` run by the agent prints tokens into `tool.output`. All of it is persisted in `session_events` and streamed to every VIEW-level participant, then to mobile in MVP7. This violates AGENTS.md rules 7 and 8 in a way that no code review of *our* code catches, because the leak originates in the runtime's output.

**Why it happens:**
The events look like telemetry; nobody expects file paths inside a JSON blob to be a privacy boundary; redaction is "a later hardening task".

**How to avoid:**
- The adapter is the **only** place that knows `projectRoot`. Every outbound event passes through a `contain()` step that rewrites any absolute path under `projectRoot` to a repo-relative path and rejects (drops the event and emits `permission.denied` with reason `path_outside_project`) any path outside registered roots. Apply it to structured fields *and* to free text (tool output, error messages) with a compiled regex for each registered root plus `$HOME`.
- A `redact()` step with a secret-pattern set (provider key prefixes such as `sk-`, `ghp_`, `AKIA`, JWT shapes, `Bearer ...`, `.env`-style `KEY=value` lines for a deny-list of names) runs before persistence. Redaction happens on the device, so the Control Plane never receives the plaintext.
- Deny the runtime read access to `.env*`, `~/.ssh`, `~/.aws`, `~/.config/gh` via `disallowedTools` (Claude) and sandbox `writableRoots`/read-only outside the workspace (Codex `workspaceWrite`). Claude Code's `--bare` mode (or the SDK equivalent) avoids loading project hooks/MCPs silently; note that a `-p` session **runs a repository's `.claude/settings.json` hooks and `.mcp.json` servers without any trust dialog**, so a cloned untrusted repo can execute code on the host through the daemon. Either use bare/explicit configuration or require project registration to be an explicit, admin-visible act (PRD §53), which it already is.
- Contract tests in P7 feed the recorded fixtures through `contain()`/`redact()` and assert no string matching `^/Users/|^/home/|^[A-Z]:\\` and no secret pattern survives. Add the same assertion as a server-side ingestion guard that counts violations into a metric; a non-zero count in staging is a release blocker.
- Never send the runtime's session id *together with* its transcript path; the Control Plane stores the runtime session id as an opaque string bound to `device_id`.

**Warning signs:**
Event JSON in the browser devtools contains `/Users/`; a `tool.output` with `sk-`; a "TODO redact" comment; the redaction lives in the API instead of the daemon.

**Phase to address:** P7 Local Runtime + Adapters (containment/redaction); P9 verifies with multi-participant sessions; P10 verifies artifact metadata.

---

### Pitfall 9: The daemon and the runtime leave orphans, fight over the working tree, and lose the session when the laptop sleeps

**What goes wrong:**
(a) The daemon crashes or is updated; the `claude`/`codex` child keeps running and editing files, the server shows the session as `failed`, and a second session starts on the same tree. (b) Two Work Zones (or a Work Zone plus the developer's own terminal) run on the same checkout; both hit `.git/index.lock`, `package-lock.json` gets clobbered, and the base commit recorded on the session no longer matches the tree. (c) The laptop sleeps: sockets die silently, the daemon's heartbeat timer is frozen, the server marks the device offline, the in-flight model HTTP call errors, and on wake the daemon reconnects but the session is already marked failed and the queue was cleared.

**Why it happens:**
`child.kill()` only signals the direct child; sandboxed runtimes spawn subtrees; SIGTERM to Claude Code leaves the turn unfinished (exit 143) unless SIGINT/`interrupt()` is sent first; "single executor" is enforced in the cloud, not on the device; sleep is never tested in dev.

**How to avoid:**
- Spawn runtimes in their own process group (`detached: true` on POSIX, then `process.kill(-pid, sig)`; `taskkill /T /F` on Windows). Stop sequence: `interrupt()` / `turn/interrupt` → wait → `SIGTERM` → wait → `SIGKILL`. The daemon keeps a pidfile registry (`~/.ocw/runtimes.json`) and on startup reaps any listed process that is still alive before accepting new sessions.
- Device-side exclusivity: one *active* runtime per registered project path, enforced with a lock file in the daemon's state dir and mirrored by a unique partial index on `work_sessions (device_id, project_id) WHERE status IN ('running','waiting')`. Record `base_commit` and a dirty-tree flag at start; run a lightweight file watcher and emit `file.changed { source: 'external' }` when something outside the runtime edits the tree, so participants see why the diff moved. Offer "start in a git worktree" as the default for a second session on the same project rather than forbidding it.
- Sleep handling in P8/P9: listen to Electron `powerMonitor` `suspend`/`resume` (the daemon gets it via IPC from the shell, or uses its own OS hooks) and proactively close/reopen the relay socket; the server keeps a **grace window** (e.g. 90 s) before flipping a device to offline and a session to `waiting`, never to `failed`, on heartbeat loss. Session state transitions on disconnect are `running → waiting(host_offline)`; the Prompt Queue is persisted server-side (PRD §109.2) so nothing is lost. When the host returns, the adapter attempts `resume` on the runtime session; if that fails, it starts a new runtime session with the platform's own transcript as context (principle 1: the session belongs to the platform, the runtime session id is a cache).
- Reconnect with exponential backoff plus jitter and a resume cursor; the server rate-limits reconnects per org so a Control Plane restart does not produce a replay storm.

**Warning signs:**
`child.kill()` without a process group; no pidfile; the session table has no `waiting` state; `git worktree` never appears in the plan; nobody has closed the lid during a demo.

**Phase to address:** P7 (process lifecycle, lock file, reaping), P8 (powerMonitor, transport reconnect), P9 (grace window, resume, queue persistence).

---

### Pitfall 10: A localhost daemon port that any website or local process can drive

**What goes wrong:**
The daemon exposes `http://127.0.0.1:47xxx` (or a WS) for the Electron renderer. Any page in the user's browser can reach it via DNS rebinding, and any local process can call it directly. Because the daemon can launch coding agents with write access to registered projects and holds the device token, this is remote code execution on the developer's machine. GitHub Security Lab documented exactly this class (CORS `*`, `endsWith`/`startsWith` origin checks, missing auth on local servers) leading to RCE in real projects.

**Why it happens:**
"It's only localhost." Electron-to-daemon HTTP is the path of least resistance and works from the browser devtools.

**How to avoid:**
- Prefer a non-TCP transport between shell and daemon: a Unix domain socket / Windows named pipe with filesystem permissions, or Electron `utilityProcess` with `MessagePort`. If TCP is unavoidable, bind loopback only, require a per-install capability token (generated at first run, stored with `safeStorage`, sent as `Authorization: Bearer`), validate the `Host` header against an exact allowlist, exact-match `Origin` on WebSocket upgrade, never allow `null` origin, and reject anything without the token.
- The daemon's outbound relay connection to the Control Plane is the *only* remote path (PRD §37: no inbound ports). Never add a "LAN mode".
- Electron hardening from the first build: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, no `webSecurity: false`, and a decision recorded as an ADR on whether the renderer loads a bundled build or the remote web app. If remote, the preload bridge must expose a minimal, typed IPC surface and the loaded origin must be pinned.
- Device token and pairing secrets go through `safeStorage` (Keychain / DPAPI), never a JSON file.

**Warning signs:**
`cors: { origin: '*' }` in the daemon; the daemon reachable from `curl` without a header; `webSecurity: false`; token in `~/.ocw/config.json`.

**Phase to address:** P8 Desktop Shell (transport and hardening). P7 for the daemon-side auth if the daemon can run without the shell.

---

### Pitfall 11: Code signing, notarization and daemon updates deferred until "release"

**What goes wrong:**
The first build handed to a teammate is unsigned: macOS Gatekeeper blocks it, the daemon binary inside the bundle is quarantined, and `autoUpdater` on macOS refuses to work without a valid signature (Squirrel.Mac requires it). When updates do land, the shell updates but the long-running daemon keeps the old protocol version and every Work Zone breaks until the user reboots. Windows shows SmartScreen warnings for weeks with a fresh OV certificate.

**Why it happens:**
Certificates, Apple Developer accounts, hardened-runtime entitlements and CI secrets are administrative pain that no phase "owns". Daemon lifecycle ("independent local service", PRD §33) is under-specified.

**How to avoid:**
- Set up signing and notarization in CI in P8 *before* the first internal distribution: Apple Developer ID + notarytool, hardened runtime with the entitlements Node/Electron needs, a Windows code-signing cert (EV or Azure Trusted Signing to avoid SmartScreen reputation delay). Sign the daemon binary and every native module separately; notarization fails on any unsigned Mach-O in the bundle.
- Decide daemon lifecycle explicitly (ADR): for MVP2 the daemon is a child of the shell (spawned on launch, killed on quit, updated with the shell). "Independent daemon that survives the shell" (login item / LaunchAgent) is a later feature that requires a protocol version handshake (`daemon.hello { protocolVersion }`) and a self-restart on version mismatch. Put the handshake in the contract now even if only one version exists.
- Use `electron-updater` with staged rollouts and a `latest.yml` served from object storage; test the update path from `N-1` to `N` in CI on all three OSes, including "session running during update" (the daemon should refuse to update while a session is `running`, and the shell should say so).

**Warning signs:**
`CSC_IDENTITY_AUTO_DISCOVERY=false` committed; testers told to right-click → Open; daemon version not displayed anywhere; no `protocolVersion` field.

**Phase to address:** P8 Desktop Shell.

---

### Pitfall 12: Self-hosted first run that depends on secrets generated at boot and on OpenBao being up

**What goes wrong:**
The API generates a JWT secret / data-encryption key at first start and writes it to a container path without a volume; the next `docker compose up --force-recreate` produces a new key and every session, device token and encrypted provider key becomes unreadable (the well-known n8n `N8N_ENCRYPTION_KEY` failure, no recovery path). Or the compose file requires OpenBao, MinIO, an OTel collector and a migration container, and the first-run experience is 10 minutes of debugging health checks. Or migrations run on API start with two replicas and race.

**Why it happens:**
The infra baseline (ADR-0003) lists real production components; agents implement it literally; secrets "just need to exist".

**How to avoid:**
- Secrets are **inputs**, never generated silently: `docker compose` fails fast with a clear message when `OCW_ENCRYPTION_KEY`, `OCW_JWT_SECRET` or `POSTGRES_PASSWORD` are unset; ship `pnpm ocw setup` (or `scripts/setup.sh`) that writes a `.env` with generated values and prints a backup warning. Support `*_FILE` variants for Docker secrets. Refuse to boot in `NODE_ENV=production` with values equal to `.env.example` defaults.
- The secret-store abstraction has an `env`/`file` provider for self-hosters and an OpenBao provider for those who want it; OpenBao is a compose **profile** (`--profile vault`), not a hard dependency. Same for the OTel collector (`--profile observability`). Minimal profile = `postgres`, `redis`, `minio`, `api`, `web`, `migrate`.
- Migrations run from a one-shot `migrate` service (`depends_on: condition: service_completed_successfully`), forward-only, with the API refusing to start when the schema version is newer than it knows (protects against image tag rollback after migration). Document "back up before upgrade" and ship a `pnpm ocw backup` that dumps with the `BYPASSRLS` migrator role (a `pg_dump` as the app role silently exports zero rows, see Pitfall 1).
- First-run bootstrap: no users → the first sign-up becomes Organization Admin only when a one-time `OCW_SETUP_TOKEN` printed in the API logs is presented. Invite flows must work without SMTP (copyable invite links); SMTP is optional.
- Reverse-proxy reality: every self-hoster runs behind Caddy/Traefik/nginx; WebSocket upgrade and `X-Forwarded-*`/trusted-proxy configuration are the number one support issue for chat-like products. Ship a tested Caddyfile and set `PUBLIC_URL` once.

**Warning signs:**
`randomBytes()` in a startup path; `depends_on` without health conditions; migrations in `apps/api` `onReady`; `docker compose up` needs more than one `.env` file; README says "then open Vault UI".

**Phase to address:** P1 Foundation (env/file secret provider, migrate service skeleton, fail-fast on missing secrets); P5 Self-hosted Release (profiles, setup script, backup, upgrade test, proxy docs).

---

### Pitfall 13: AI agents silently weaken security to make tests pass, and drift from the PRD while producing plausible structure

**What goes wrong:**
An agent flips `permissionMode` to bypass, adds `BYPASSRLS`, sets `cors: '*'`, comments out an origin check, or wraps a failing RLS test in `it.skip`, because the plan said "make tests green". A different agent builds a `GenericLLMRuntime`, a plugin loader and three layers of adapters for a single provider. A third implements "share conversation" as a copy because that is what its 30-file context showed. Each PR is plausible; the sum is a product that does not match the PRD and whose guardrails are gone. Practitioner reports converge on three patterns: logic drift (solving a slightly different problem), instruction drift as context grows, and QA being the most skipped step.

**Why it happens:**
Agents optimise the local objective ("tests pass", "feature works"), lose the PRD in long contexts, and cannot see the other agents' work.

**How to avoid:**
- **Mechanical guardrails, not instructions.** A `pnpm verify` step runs Semgrep/grep rules that fail CI on: `bypassPermissions`, `allowDangerouslySkipPermissions`, `dangerously-skip-permissions`, `danger-full-access`, `BYPASSRLS`, `DISABLE ROW LEVEL SECURITY`, `origin: '*'`, `webSecurity: false`, `it.skip`/`test.skip`/`describe.skip` outside an allowlist, `@ts-ignore`, `: any`. Exemptions need a comment with an issue link *and* a CODEOWNERS-required human review on the security-sensitive paths (`packages/db/**/policies*`, `packages/auth`, `apps/local-runtime/**/adapters`, `apps/api/src/modules/policy`).
- **Deny-path tests are the contract.** For every permission bit and every RLS table there is a test that asserts the *denied* outcome. Coverage thresholds on those directories are higher (target 90 %) and the mutation-testing skill (Stryker) runs weekly on `policy`, `auth` and `db/policies`.
- **PRD traceability.** Every phase plan lists the PRD section ids it implements; every PR description names them; the acceptance tests for Scenario A/B are written in P6 as skipped-until-P10 E2E specs so the target is in the repo from the start of MVP2.
- **Abstraction budget.** No interface with a single implementation outside `packages/contracts` and `packages/runtime-adapters` (`AgentRuntime` is explicitly allowed with two implementations). A phase-end "debloat" task runs `knip`/`ts-prune` and deletes unused exports. Generated files (Codex protocol types) are marked `// GENERATED` and excluded from lint autofix.
- Lockfile frozen in CI; `pnpm audit` and a package-existence check block hallucinated dependencies.

**Warning signs:**
A PR whose diff touches both a test and a policy file; increasing count of `skip`; "refactor" PRs that add packages; a helper duplicated in three apps; tests that assert `toBeDefined()` only.

**Phase to address:** P1 Foundation (CI guards, CODEOWNERS, `verify`), then every phase. P6 adds the skipped acceptance specs.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
| --- | --- | --- | --- |
| Single DB role (superuser) for migrations and app | One connection string | RLS is a no-op; discovered only by an incident | Never (dev containers included: use two roles there too) |
| Separate message tables per surface (channel, AI chat, Work Zone) | Each phase ships faster | Share/publish/card flows require data moves; four fan-out paths; rewrite in MVP2 | Never; keep `session_events` separate from `messages` but not prompts/answers |
| Pagination by `created_at` / global id | Zero design | Lost messages across replicas; no replay | Only in throwaway prototypes |
| Redis pub/sub as the delivery mechanism | Simple | Missed events on every reconnect; unread drift | Acceptable as a *hint* alongside DB cursor replay |
| Skip a usage/cost record per generation until the Model Gateway (MVP3) | Less schema | No way to attribute cost or enforce a cap in MVP1; multiplayer chat cost blowups invisible | Never; a minimal `usage` row (tokens, model, user, conversation) costs one table |
| Storing org provider API keys in Postgres plaintext "until OpenBao" | No abstraction needed | Violates AGENTS.md rule 8; migration of encrypted blobs later | Acceptable only as *encrypted* column via the secret-store abstraction's `env` key provider |
| Parse `claude -p` / `codex exec` stdout | Works in 30 minutes | Breaks on every runtime release; no approvals; no steer | Only for the recorded-fixture generator script |
| `bypassPermissions` / `danger-full-access` to unblock headless runs | Sessions finish | Removes the approval gate that is the product | Never in product code; allowed in an explicit `unattended` policy set by an Org Admin (later milestone) |
| Daemon as a plain HTTP server on a localhost port | Easy to debug from a browser | Local RCE surface; DNS rebinding | Acceptable behind a capability token and exact origin/host checks, with an ADR |
| Daemon spawned as a child of Electron (dies with it) | Simplest lifecycle | No sessions while the app is closed (PRD's "independent service") | Acceptable for MVP2; upgrade path requires the protocol version handshake from day one |
| Ship without code signing "for internal testers" | Saves a week of admin | Auto-update impossible on macOS; every tester manually bypasses Gatekeeper, teaching them to ignore warnings | Never past the first developer-only build |
| Auto-generate secrets on first boot | Zero-config demo | Unrecoverable data loss on container recreate | Never; generate in a `setup` script that writes `.env` |
| Run migrations on API start | One fewer service | Races with replicas; rollback traps | Acceptable only in `docker compose --profile dev` |
| Copy-on-share for AI conversations | Trivially "keeps context" | Diverging histories, duplicated attachments, no revoke | Never |
| `it.skip` on a flaky RLS/permission test | Green CI | Permission regressions ship | Never for deny-path tests |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
| --- | --- | --- |
| Claude Agent SDK | Passing `env: { ANTHROPIC_API_KEY }` and losing `PATH` (the option **replaces** the environment) | `env: { ...process.env, ...overrides }`; strip secrets you do not want the child to see |
| Claude Agent SDK | Expecting `canUseTool` for every tool call | It fires only when nothing else resolved the call; use `disallowedTools` scoped rules for hard denies and `hooks` (`PreToolUse`) for audit of *every* call |
| Claude Agent SDK | Killing the subprocess with SIGTERM to stop a turn | Call `interrupt()` (SIGINT semantics) first; SIGTERM leaves the turn unfinished and exit code 143 |
| Claude Code sessions | Assuming `--resume <id>` always works | Transcripts are purged after `cleanupPeriodDays` (default 30) and live under a path that encodes the absolute cwd; treat the runtime session as a cache, keep the platform transcript as truth |
| Claude Code project config | Running the runtime in a freshly cloned repo without `--bare`/explicit settings | `-p` loads the repo's hooks and `.mcp.json` with no trust dialog; treat project registration as the trust boundary and set explicit `settings`/`mcpServers` from the platform |
| Codex app-server | Using `codex exec --json` as the integration protocol | Use `codex app-server` over stdio; commit generated TS types per pinned version; answer `requestApproval` requests explicitly |
| Codex app-server | Ignoring `-32001` overloaded errors | Exponential backoff with jitter; surface as `session.waiting` |
| Codex app-server | Assuming threads live forever | `thread/closed` after ~30 min idle; call `thread/resume` on the next prompt |
| Codex sandbox | Shipping the Linux daemon without `bubblewrap` present | Daemon preflight checks `bwrap` (Linux/WSL2) and reports a `runtime.unavailable` reason; WSL1 unsupported |
| Codex exec/app-server | Running in a non-git directory | Codex refuses without `--skip-git-repo-check`; registered projects must be git repos (also required for git state per session) |
| Anthropic/OpenAI chat APIs | Sending consecutive `user` turns for multiple humans | Server merges consecutive human messages into one structured user turn with per-participant wrappers |
| PostgreSQL | `SET app.org_id` through a pool (pgBouncer/transaction pooling) | `SET LOCAL` inside the request transaction only; make the `db` package the only entrypoint |
| PostgreSQL `LISTEN/NOTIFY` | Using it as the realtime bus | 8000-byte payload limit and incompatibility with transaction pooling; use Redis pub/sub as the hint bus (ADR-0003) |
| Redis pub/sub | Treating delivery as reliable | At-most-once; always pair with DB cursor replay |
| S3-compatible storage (MinIO) | Presigned URLs with the internal Docker hostname | Presign with `PUBLIC_S3_URL`; test from a browser outside the compose network |
| Electron `autoUpdater` (macOS) | Testing unsigned | Requires a signed, notarized app; test the updater on a signed build in CI |
| Electron `safeStorage` | Storing the device token in a JSON file | `safeStorage.encryptString`, with a documented fallback when the OS keychain is unavailable (Linux without a secret service) |
| Reverse proxy (Caddy/Traefik/nginx) | Missing WebSocket upgrade / trusted proxy config | Ship tested proxy snippets; the API validates `X-Forwarded-Proto` only from configured trusted proxies |

## Performance Traps

Patterns that work at small scale but fail as usage grows. Expected scale for this milestone: a few organizations, tens to low hundreds of concurrent users, a handful of concurrent Work Zones per organization.

| Trap | Symptoms | Prevention | When It Breaks |
| --- | --- | --- | --- |
| RLS policies with membership subqueries | Channel open > 1 s; `Seq Scan` in `EXPLAIN` | Org-only RLS + denormalized `org_id` leading every index | ~50k messages in one channel |
| Unread counts via `COUNT(*)` per channel on sidebar load | Sidebar load fans out N queries | `last_seq - last_read_seq` per membership row | ~50 channels per user |
| Per-token WebSocket frames for model streaming, per viewer | CPU spikes on the API node with 10 viewers of one chat | Batch deltas every 50–100 ms server-side; persist partial text so late joiners get a snapshot | 10+ viewers per streaming conversation |
| Presence heartbeats written to Postgres | Write amplification, autovacuum churn | Redis keys with TTL; broadcast presence diffs debounced (≥ 2 s) | ~200 online users |
| Socket subscribed to a per-channel topic and never unsubscribed on membership removal | Removed user still receives messages | Membership change publishes a `membership.revoked` event that the gateway uses to drop subscriptions and forces the client to resync | First time someone is removed from a private channel |
| Work Zone events stored as one row per token delta | `session_events` grows to millions of rows per day | Coalesce `assistant.message` deltas into one row per message with periodic checkpoints; keep tool/command/file events as individual rows | One long Claude Code session (~10k events) |
| Reconnect storm after Control Plane restart | API CPU 100 %, DB connections exhausted | Backoff + jitter on daemon and web clients, per-org reconnect rate limit, cursor replay instead of full resync | First deploy with > 100 connected clients |
| Full transcript re-sent to the provider on every multiplayer turn | Cost grows quadratically with conversation length; slow first token | Provider prompt caching where available; context window trimming policy recorded per generation; hard cap on tokens per generation | Conversations > 100 turns |
| One Redis connection per WebSocket for pub/sub | Redis `maxclients` exhausted | One subscriber connection per API process, in-process routing to sockets | ~1k sockets |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
| --- | --- | --- |
| Model tool calls in a shared chat run with the conversation owner's (or highest) permissions | Confused deputy: a VIEW-only participant makes the agent act with admin rights | Effective permission = intersection(agent, *triggering human*, tool, device); attribute in audit |
| Participant identity encoded in message text | Role/identity spoofing toward the model | Server-generated structured wrappers; neutralize look-alike text |
| Loading user-private memory/skills into multiplayer conversations | Cross-participant leakage (MuPPET) | Context sources scoped by conversation participant set; recorded per generation |
| Redaction of runtime output done on the server | Secrets already crossed the wire and hit logs/OTel | Redact and contain on the device, inside the adapter |
| Runtime allowed to read `.env*`, `~/.ssh`, `~/.aws` | Credential exfiltration through `tool.output` to every participant | `disallowedTools` / sandbox read restrictions; deny-list tested with fixtures |
| Project registration accepts any path, including `$HOME` | Arbitrary filesystem exposure via the agent | Registered roots must be git repos; forbid `$HOME` and system roots; admin-visible registration (PRD §53) |
| Trusting a repo's `.claude/settings.json`, hooks and `.mcp.json` on the host | Supply-chain RCE on developer machines | Explicit settings from the platform / bare mode; hooks require admin policy (MVP4) |
| Daemon localhost API without token and origin checks | DNS rebinding → local RCE | Unix socket / named pipe or token + exact Host/Origin validation |
| Device token / pairing secret in plaintext on disk | Device impersonation | `safeStorage`; short-lived tokens with refresh bound to device key |
| Approval resolved by whoever clicks first | Non-APPROVE participants approve destructive commands | Server checks the `APPROVE` bit for the resolving user; approval event carries approver id; runtime adapter only forwards server-resolved decisions |
| Approval requests that time out to "allow" | Unattended destructive actions | Timeout → deny + `session.waiting`; only an explicit unattended policy may auto-allow (later milestone) |
| Artifact download URLs not scoped to conversation ACL | Shared chat revoked, link still works | Presigned URLs short-lived and minted per request after ACL check; SHA-256 recorded (PRD §49) |
| Audit events emitted from the client | Forged audit trail | Audit emitted server-side only, from the module that enforces the action |
| Agents modelled as a flag on a user or message | Permission checks skip agents; no agent identity in audit | Agents are principals with memberships (AGENTS.md rule 2); every permission test runs for both user and agent principals |
| Org-level provider API key visible in `system/init` or event payloads | Key leaks to all participants | Never inject provider keys into runtime env on the device; the device uses the user's own CLI login in MVP2, the Model Gateway from MVP3 |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
| --- | --- | --- |
| Two people's prompts race and both get model replies | Confusing double answers, wasted cost | Arbiter with visible state: "Answering Alex… your message is queued" |
| Share dialog does not say what becomes visible | Accidental disclosure, loss of trust | Summary of messages/attachments/tools that will be shared; confirm |
| Steer offered for a runtime that cannot steer | Prompt silently becomes a queue item or is lost | Capability-driven UI; disabled control with tooltip "Claude Code session: use Queue or Interrupt" |
| Device offline shown as "session failed" | Users abandon or duplicate sessions | `waiting (host offline)` state with last heartbeat, queue preserved, "will resume when Victor's Mac is back" |
| Approval request buried in the event stream | Session blocked for minutes; nobody notices | Sticky approval banner + notification to every participant with APPROVE (PRD §32 follow events) |
| Diff view built from the runtime's file events only | Missing external edits; stale diff | Diff computed by the daemon's git adapter against `base_commit` on demand; file events only invalidate |
| Unread badge counts model streaming chunks | Badge flickers 1 → 43 → 0 | Unread increments once per completed message; streaming updates do not bump `last_seq` until final |
| Thread replies not surfaced in the channel | Missed discussions | One-level threads with "also send to channel" option and reply-count/last-replier on the parent |
| First-run requires reading a 40-line env reference | Self-hosters give up | `setup` script + one `.env`, one `docker compose up`, admin bootstrap token printed in logs |
| Electron app opens to a login form with no explanation of the daemon | Users do not understand why a second process exists | Onboarding step: "This device can run Work Zones. Register a project" with daemon status visible in the header |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **RLS:** Often missing `FORCE ROW LEVEL SECURITY` and a non-owner app role — verify `pg_roles` for the app connection and run the wrong-tenant-zero-rows test across all `pg_tables` with `org_id`.
- [ ] **Tenant context:** Often `SET` not `SET LOCAL` — grep the `db` package; verify a pooled connection does not carry the previous tenant (test with two sequential requests on one pooled connection).
- [ ] **Realtime:** Often no resync path — kill the WebSocket during a message burst and verify the client catches up by cursor without reload.
- [ ] **Unread:** Often computed from live events only — verify counts after a reconnect and after a thread reply.
- [ ] **Multiplayer AI chat:** Often no arbiter — two browsers send simultaneously; verify one generation, one bill, one answer that names the right person.
- [ ] **Sharing:** Often copies rows — verify share then unshare removes access to messages *and* attachments and that the conversation id did not change.
- [ ] **Agent as participant:** Often a bot flag — verify the agent has a `principals` row, memberships, and appears in audit as actor.
- [ ] **Usage records:** Often deferred to MVP3 — verify every generation writes tokens/model/user/conversation.
- [ ] **Runtime adapter:** Often parses stdout — verify SDK/app-server integration, fixtures per version, tolerant unknown-event handling.
- [ ] **Approvals:** Often auto-approved to make the demo work — grep for bypass flags; verify a VIEW-only user cannot resolve an approval and a timeout denies.
- [ ] **Path containment:** Often only applied to `file.changed` — replay recorded fixtures through the adapter and assert no absolute path or secret pattern in any event field, including free text.
- [ ] **Process lifecycle:** Often `child.kill()` only — kill the daemon during a session and verify no `claude`/`codex` process survives, or that it is reaped on restart.
- [ ] **Sleep/resume:** Often untested — close the lid mid-session; verify `waiting`, not `failed`, and that the queue survives.
- [ ] **Single executor:** Often server-only — start two sessions on the same registered path from two clients; verify the second is refused or offered a worktree.
- [ ] **Git state:** Often `branch` only — verify `base_commit`, `current_commit`, dirty flag and external-change detection are populated and update.
- [ ] **Daemon security:** Often bare localhost HTTP — `curl` the daemon without a token and from a foreign `Origin`; expect rejection.
- [ ] **Signing:** Often "later" — verify a notarized macOS build and a signed Windows build install without warnings and auto-update from `N-1`.
- [ ] **Compose:** Often a single superuser and boot-time secrets — recreate containers with `--force-recreate` and verify sessions and encrypted data survive; verify `docker compose up` fails clearly with a missing secret.
- [ ] **Migrations:** Often run in-app — verify the `migrate` service runs once and the API refuses a newer schema.
- [ ] **Backups:** Often `pg_dump` as app role — verify the dump contains rows.
- [ ] **AGPL/Apache split:** Often missing per-package `license` fields and headers — verify `packages/contracts`, SDK and plugins declare Apache-2.0, apps declare AGPL-3.0-only, and a license scanner runs in CI.
- [ ] **CI guards:** Often absent — verify `pnpm verify` fails on `it.skip` in `policy`/`db` tests and on any bypass token.

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
| --- | --- | --- |
| RLS found to be bypassed in production | HIGH | Treat as incident: audit-log review for cross-tenant reads, create app role, `FORCE` policies, rotate secrets, notify affected orgs |
| Hierarchy in RLS policies too slow | MEDIUM | Add denormalized `org_id`, replace policies with equality, move ACL to `PermissionService` behind the same interface; backfill in batches |
| Multiple message tables | HIGH | Introduce unified `messages` and dual-write; migrate per kind; keep views for old readers; remove after one release |
| No `seq` on messages | MEDIUM | Add `seq` column, backfill per conversation ordered by `(created_at, id)`, switch pagination, then enforce lock on insert |
| Stdout-parsing adapters break on a runtime release | MEDIUM | Pin the previous runtime version via the admin "block version" control while migrating to SDK/app-server; re-record fixtures |
| Absolute paths / secrets already persisted in `session_events` | HIGH | Redaction migration over stored events (regex per known root and secret pattern), invalidate cached artifacts, rotate any leaked credential, add device-side redaction |
| Orphaned runtimes editing trees | LOW | Pidfile registry + reap on daemon start; document `pkill -f codex/claude` for the interim |
| Daemon on open localhost port shipped | MEDIUM | Ship token + origin checks as a forced update; block older daemon versions server-side |
| Unsigned builds circulating | LOW | Sign, notarize, publish a signed build; older builds cannot auto-update, so send a manual download link |
| Boot-generated secret lost | HIGH | No recovery for encrypted data; users re-enter provider keys and re-pair devices; ship the `setup` script and refuse boot without explicit secrets |
| Agent-weakened permission merged | MEDIUM | Revert, add the Semgrep rule that would have caught it, add the deny-path test, CODEOWNERS on the path |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
| --- | --- | --- |
| RLS bypass via owner/superuser, `SET` vs `SET LOCAL` | P1 Foundation | `pg_roles` test on app connection; wrong-tenant-zero-rows across all org tables; pooled-connection context test |
| Hierarchy inside RLS policies | P1 Foundation, P2 Chat Core | `EXPLAIN` shows index condition on `(org_id, conversation_id, seq)`; `PermissionService` deny-path suite |
| Fragmented conversation/message model | P1 Foundation (contracts), P2 Chat Core | Share and card flows implemented in P4/P10 without data copies |
| Ordering / replay / unread drift | P2 Chat Core | Kill-socket-during-burst test; two-replica ordering test; unread after reconnect |
| Stale subscriptions after membership removal | P2 Chat Core | Remove user from private channel; assert no further frames |
| Multiplayer turn race and textual identity | P4 Multiplayer + Sharing | Simultaneous-send test yields one generation; identity/spoof eval fixture |
| Cost blowups without usage records | P3 AI Chat | Every generation has a `usage` row; per-conversation cap test |
| Private context leaks on share | P4 Multiplayer + Sharing | Share summary matches ACL; `context_sources` excludes user-private sources in multiplayer |
| Confused deputy for agent tool calls | P4 Multiplayer + Sharing | Tool call by VIEW-only participant is denied and audited |
| Boot-generated secrets, OpenBao hard dependency, in-app migrations | P1 Foundation, P5 Self-hosted Release | `--force-recreate` survives; minimal profile boots; `migrate` service runs once; upgrade `N-1 → N` test |
| Reverse proxy / WebSocket / presigned URL issues | P5 Self-hosted Release | E2E behind the shipped Caddy config from a browser outside the compose network |
| License hygiene (AGPL apps, Apache-2.0 contracts) | P5 Self-hosted Release | License scanner in CI; per-package fields and headers |
| Capability mismatch across runtimes (steer/queue/interrupt) | P6 Work Zone Contracts | `capabilities()` in contracts; UI hides unsupported controls |
| Stdout parsing and bypass flags | P7 Local Runtime + Adapters | Fixture contract tests; Semgrep rule for bypass tokens; `canUseTool` → approval round-trip test |
| Absolute path / secret leakage | P7 Local Runtime + Adapters | Fixture replay through `contain()`/`redact()`; server-side violation metric = 0 |
| Orphans, tree conflicts, sleep | P7, P8, P9 | Daemon-kill test; two-sessions-same-path test; lid-close test yields `waiting` |
| Localhost daemon exposure, Electron hardening | P8 Desktop Shell | `curl` without token and with foreign Origin rejected; Electron fuses/flags asserted in a test |
| Signing, notarization, daemon/shell version skew | P8 Desktop Shell | Notarized build in CI; `N-1 → N` auto-update test; `protocolVersion` handshake |
| Approval resolved by wrong user or timeout-allow | P9 Multiplayer Work Zone | Non-APPROVE user rejected; timeout → deny + `waiting` |
| Artifact ACL / URL scoping | P10 Artifacts + Acceptance | Revoked share invalidates download; SHA-256 recorded |
| Agent-written drift and silent weakening | P1 Foundation, every phase | CI guards; CODEOWNERS; mutation testing on `policy`/`auth`/`db`; PRD section ids in every plan and PR |

## Sources

Official documentation (fetched 2026-09-10; confidence HIGH for the facts quoted, MEDIUM for how they apply here):
- Claude Code headless / print mode: https://code.claude.com/docs/en/headless (permission modes in `-p`, `--permission-prompts none`, `--bare`, SIGTERM vs `interrupt()`, `--resume` behaviour, `capabilities` array, hooks/MCP loaded without trust dialog)
- Claude Agent SDK TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript (`canUseTool`, `disallowedTools` scope, `permissionPrompts`, `env` replaces environment, `forkSession`, `maxBudgetUsd`)
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode (JSONL events, sandbox modes, approvals default in exec, `--ephemeral`, git-repo requirement, `CODEX_API_KEY` guidance)
- Electron `powerMonitor`: https://www.electronjs.org/docs/latest/api/power-monitor
- GNU GPL/AGPL FAQ: https://www.gnu.org/licenses/gpl-faq.html (network-interaction source offer)

Community and practitioner sources (confidence MEDIUM where several agree, LOW individually):
- Codex app-server protocol guide: https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/ and OpenAI's "Unlocking the Codex harness": https://openai.com/index/unlocking-the-codex-harness/ (`thread/*`, `turn/steer`, `requestApproval`, `generate-ts`, `-32001`)
- Codex steer mode and `codex queue`: https://codex.danielvaughan.com/2026/08/21/codex-queue-inter-session-messaging-codex-cli-v0149-orchestration-automation-agent-to-agent/
- Codex sandbox platform details: https://codex.danielvaughan.com/2026/04/08/codex-sandbox-platform-implementation/ and https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
- Codex session storage: https://codex.danielvaughan.com/2026/04/13/codex-cli-session-persistence-resume-fork-analytics/
- Claude Code transcript storage and cleanup: https://code.claude.com/docs/en/claude-directory, https://promptconduit.dev/blog/claude-code-transcripts-location
- Undocumented stream-json event types: https://github.com/anthropics/claude-code/issues/24612, https://github.com/anthropics/claude-code/issues/24596
- Claude Code `index.lock` and worktree isolation: https://github.com/anthropics/claude-code/issues/57102, https://code.claude.com/docs/en/worktrees, https://readysolutions.ai/blog/2026-06-06-parallel-claude-code-sessions-one-repo/
- PostgreSQL RLS footguns: https://queryplane.com/blog/postgres-row-level-security-in-practice/, https://patotski.com/blog/postgres-row-level-security-multi-tenant/, https://rivestack.io/blog/postgresql-row-level-security
- Chat architecture (fan-out, ordering, unread): https://getstream.io/blog/chat-application-architecture/, https://getstream.io/blog/chat-app-database/, https://dev.to/adamthedeveloper/no-redis-no-kafka-just-postgres-i-built-chat-28ie
- Redis pub/sub delivery semantics: https://redis.io/docs/latest/develop/pubsub/, https://oneuptime.com/blog/post/2026-03-31-redis-pubsub-message-delivery-guarantees/view
- WebSocket reconnection, sleep and backoff: https://websocket.org/guides/reconnection/, https://github.com/electron/electron/issues/19993
- Localhost daemon attacks: https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/, https://deepstrike.io/blog/penetration-testing-of-electron-based-applications
- Electron signing/notarization/update: https://www.electronjs.org/docs/latest/tutorial/code-signing, https://www.electron.build/docs/features/code-signing/, https://github.com/electron-userland/electron-builder/issues/8026
- Process tree termination in Node: https://nodejs.org/api/child_process.html, https://github.com/pkrumins/node-tree-kill, https://github.com/pnpm/pnpm/issues/12406
- Multi-party LLM privacy and injection: MuPPET https://arxiv.org/abs/2606.23217, OWASP LLM01 https://genai.owasp.org/llmrisk2023-24/llm01-24-prompt-injection/, Prompt Infection https://arxiv.org/pdf/2410.07283
- Self-hosted upgrade lessons: https://sourcegraph.com/changelog/self-hosted/docker-compose, https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v2-to-v3, https://blog.laurahargreaves.com/ghost-v6/, n8n encryption key: https://perly.dev/n8n-credentials-could-not-be-decrypted
- AI-written codebase quality: https://dev.to/maximsaplin/debloating-the-ai-grown-codebase-2om, https://www.oreilly.com/radar/auto-reviewing-claudes-code/, https://contextqa.com/blog/what-is-ai-generated-code-testing-checklist/ (LOW: practitioner reports)

Project sources:
- `docs/prd/PRD.md` Part IV (§20–§38), §52–§53, Part IX (§85–§89), §106–§110
- `AGENTS.md` (rules extended here, not duplicated)
- `docs/adr/0001`–`0004`

---
*Pitfalls research for: open-source multiplayer collaborative AI workspace (MVP1 collaborative workspace + MVP2 multiplayer Work Zone)*
*Researched: 2026-09-10*
