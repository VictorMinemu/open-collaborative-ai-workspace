# Architecture Research

**Domain:** Open-source, self-hostable, multiplayer collaborative AI workspace (Slack-style chat + shareable multiplayer AI chats + cloud-owned coding-agent sessions executed on developer machines)
**Researched:** 2026-09-10
**Confidence:** MEDIUM overall. HIGH where the PRD/ADRs prescribe (Fastify modular monolith, PostgreSQL+RLS, Redis pub/sub, S3, Electron + daemon). MEDIUM for external runtime contracts (Claude Agent SDK, Codex app-server, @fastify/websocket, Drizzle RLS: verified against official docs today). MEDIUM for the design recommendations that are this document's synthesis; they are opinionated and should be turned into ADRs as each phase starts.

Scope: PRD MVP 1 (Collaborative Workspace) and MVP 2 (Multiplayer Work Zone). Everything else is mentioned only where it constrains a seam we must leave open.

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                                      │
│  ┌──────────────┐   ┌──────────────────────────────┐   ┌──────────────────┐  │
│  │ Web (Next.js)│   │ Desktop (Electron)           │   │ Mobile (MVP7)    │  │
│  │ chat, AI chat│   │ same web UI + Work Zone UI   │   │                  │  │
│  │ admin, WZ RO │   │ + daemon supervisor          │   │                  │  │
│  └──────┬───────┘   └───────┬──────────────┬───────┘   └────────┬─────────┘  │
│         │ HTTPS + WSS       │ HTTPS + WSS  │ local socket        │            │
└─────────┼───────────────────┼──────────────┼──────────────────────┼────────────┘
          │                   │              │                      │
          ▼                   ▼              │                      ▼
┌──────────────────────────────────────────┐ │   ┌──────────────────────────────┐
│ CONTROL PLANE  apps/api (Fastify)        │ │   │ LOCAL RUNTIME DAEMON          │
│                                          │ │   │ apps/runtime (Node, headless) │
│  HTTP API (Zod contracts, OpenAPI)       │ │   │                               │
│  WS Gateway /ws  (clients)               │ │   │  Device Link client (WSS)     │
│  WS Gateway /runtime/ws (devices) ◄──────┼─┼───┤  Session Supervisor           │
│                                          │ │   │  AgentRuntime adapters        │
│  modules/                                │ └──►│    ClaudeCodeRuntime          │
│   identity  organization  chat  realtime │     │    CodexRuntime               │
│   agent  artifact  audit  notification   │     │  Git / FS / Artifact adapters │
│   project  device  worksession  (MVP2)   │     │  Project registry (abs paths) │
│                                          │     │  Local control socket         │
│  packages/protocol = Unified Session     │     └───────────┬───────────────────┘
│  Event Protocol + Device Link protocol   │                 │ spawn / JSON-RPC
└───────┬───────────────┬──────────┬───────┘                 ▼
        │               │          │               ┌───────────────────────┐
        ▼               ▼          ▼               │ claude (Agent SDK)    │
┌──────────────┐ ┌────────────┐ ┌──────────────┐   │ codex app-server      │
│ PostgreSQL   │ │ Redis      │ │ S3 / MinIO   │   │ git, shell            │
│ (RLS, event  │ │ pub/sub,   │ │ artifacts,   │   └───────────────────────┘
│  log, queue) │ │ presence,  │ │ attachments  │
│              │ │ locks      │ │              │   ┌───────────────────────┐
└──────────────┘ └────────────┘ └──────────────┘   │ OpenBao (secret refs) │
                                                   │ OTel → Prom/Grafana   │
                                                   └───────────────────────┘
```

Two things in this diagram are the whole point and must never be compromised:

1. **The WorkSession lives in the cloud, not in the UI.** Even the Electron app running on the execution host sends prompts through the Control Plane; it does not talk to the daemon for session control. One code path for Víctor's desktop, Alex's desktop, the web and (later) mobile. The local socket between Electron and the daemon is only for local concerns (enrollment, project registration via native folder picker, daemon health, local file preview).
2. **The daemon only ever connects outbound.** No listening ports on developer machines. MVP2 needs the daemon↔backend link; MVP6 ("Device Relay") adds remote controllers on top of the same link without changing it.

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| HTTP API | CRUD for every entity, auth, sharing, prompt-queue mutations, approvals, artifact presign/finalize | Fastify routes per module, Zod schemas from `packages/contracts`, `@fastify/swagger` |
| Client WS Gateway (`/ws`) | One multiplexed socket per client; subscribe/unsubscribe to topics; replay from cursors; push events; ephemeral typing/presence | `@fastify/websocket` 11.x (ws 8) with `preHandler` auth on the upgrade request |
| Device WS Gateway (`/runtime/ws`) | Authenticated socket per device; commands down (dispatch prompt, interrupt, steer, approval response, file request), events up (Unified Session Events, heartbeat, git state) | Same plugin, separate route + separate auth (device signature) |
| Realtime module | Persist durable events with per-stream sequence, publish to Redis, fan out to local sockets, presence registry | Postgres `stream_events` table + Redis pub/sub + in-process subscription map |
| Chat module | Channels, threads, DMs, AI chats, messages, participants, grants (sharing) | Plain service functions over Drizzle; emits domain events to Realtime |
| Agent module | Agents as participants; model runs for AI chats; prompt assembly for multi-human conversations; streaming | Server-side run loop calling provider SDK (Anthropic SDK / OpenAI SDK behind a thin `ModelProvider` interface, see STACK.md) |
| WorkSession module (MVP2) | WorkSession state machine, participants + permission matrix, Prompt Queue + arbiter, session event ingestion, approvals, git state, changed files | Postgres tables, Redis lock per session, commands table for at-least-once delivery to daemon |
| Device module (MVP2) | Device enrollment (Ed25519 identity), authorization state, online/offline, heartbeat, registered projects per device, command routing | Postgres `devices`, Redis `device:{id}:online`, socket registry |
| Project module (MVP2) | Projects, repositories, project ↔ org unit, project ↔ device registrations (no absolute paths) | Plain CRUD |
| Artifact module | Attachment/artifact metadata, presigned upload/download, policy checks, retention | S3 presigned URLs, SHA-256 verification on finalize |
| Audit module | Append-only audit events for every sensitive action | Insert-only table, written inside the same transaction as the action |
| Notification module | In-app inbox (mentions, approvals required, task completed); email/push later | Postgres `notifications` + `user:{id}` realtime topic |
| Local Runtime Daemon | Owns processes, absolute paths, runtime credentials, offline event buffer; translates runtime-native events into the Unified Session Event Protocol | Standalone Node 22 process (`apps/runtime`), packaged with Electron but independently runnable |
| Electron app | UI shell (loads the same React app as web), daemon supervisor, native folder picker, OS keychain access | Electron + React; `contextBridge` to renderer; NDJSON over local socket to daemon |

---

## Recommended Project Structure

```
apps/
├── api/                          # Fastify modular monolith (ADR-0002)
│   └── src/
│       ├── app.ts                # builds Fastify, registers modules in dependency order
│       ├── plugins/              # infra plugins: db, redis, s3, secrets, otel, auth-context
│       ├── ws/                   # transport only: /ws and /runtime/ws routes, framing, auth
│       └── modules/
│           ├── identity/         # users, credentials, sessions, tokens          (MVP1)
│           ├── organization/     # orgs, org_units, memberships, roles, effective permissions (MVP1)
│           ├── chat/             # conversations, messages, threads, grants      (MVP1)
│           ├── realtime/         # stream_events, cursors, publish, presence     (MVP1)
│           ├── agent/            # agents, model runs, prompt assembly, streaming (MVP1)
│           ├── artifact/         # attachments + artifacts, presign, policy      (MVP1 basic, MVP2 full)
│           ├── audit/            # append-only audit events                      (MVP1)
│           ├── notification/     # in-app inbox                                  (MVP1)
│           ├── project/          # projects, repositories, device registrations  (MVP2)
│           ├── device/           # enrollment, identity, heartbeat, command routing (MVP2)
│           └── worksession/      # WorkSession, prompt queue, arbiter, approvals, git state (MVP2)
│           # each module: index.ts (public API) · routes.ts · service.ts · repo.ts · schema.ts · events.ts
├── web/                          # Next.js: chat, AI chats, admin, read-only Work Zone
├── desktop/                      # Electron shell; loads apps/web UI bundle; supervises daemon
└── runtime/                      # Local Runtime Daemon (headless Node binary)
    └── src/
        ├── main.ts               # entry; state dir; control socket; device link
        ├── link/                 # outbound WSS client, heartbeat, reconnect, offline buffer
        ├── sessions/             # SessionSupervisor: one runtime process per active session
        ├── adapters/
        │   ├── AgentRuntime.ts   # interface + capability flags
        │   ├── claude-code/      # Agent SDK (streaming input mode) → Unified events
        │   ├── codex/            # codex app-server JSON-RPC → Unified events
        │   ├── git/              # state + diff capture, relative paths only
        │   └── fs/               # containment checks, artifact pipeline client
        └── projects/             # project_id → absolute path registry (never leaves the device)
packages/
├── contracts/                    # Zod schemas for HTTP API + shared TS types (Apache-2.0)
├── protocol/                     # Unified Session Event Protocol + Device Link protocol (Apache-2.0)
├── db/                           # Drizzle schema, migrations, RLS policies, tenant tx helper
├── ui/                           # shared React components (web + desktop)
└── sdk/                          # typed client for the API + WS (used by web, desktop, mobile)
```

### Structure Rationale

- **`modules/<name>/index.ts` is the only import surface** (ADR-0002). Enforce with `dependency-cruiser` from the first two modules. Cross-module reads go through service functions, never through another module's tables.
- **`apps/api/src/ws/` is transport, not a module.** It authenticates the socket, parses frames and calls `realtime` (client sockets) or `device` (runtime sockets). This keeps `realtime` free of ws-library types and testable in-process.
- **`packages/protocol` is separate from `packages/contracts`** because the daemon and third-party runtimes (OpenClaw in MVP5, community adapters) depend on the protocol but must not pull the whole HTTP API surface. Both are Apache-2.0 per PRD §102.
- **`apps/runtime` is not an Electron utility process.** `utilityProcess.fork` cannot pipe stdin and dies with the app; the daemon must be independently launchable so that MVP6 remote control works with the UI closed. Electron is just its supervisor and first client.

---

## 1. Module Boundaries in the Fastify Modular Monolith

### Module map and MVP need

| Module | Owns (tables) | Public interface (examples) | Depends on | MVP1 | MVP2 |
|--------|---------------|-----------------------------|------------|------|------|
| identity | users, credentials, auth_sessions, api_tokens | `authenticate(req)`, `getUser(id)`, `issueToken()` | — | yes | yes |
| organization | organizations, org_units, memberships, roles, role_permissions | `resolveEffectivePermissions(actor, resource)`, `assertCan(...)`, `listUnits(orgId)`, `isMember(...)` | identity | yes | yes |
| realtime | stream_events, stream_cursors (internal), presence (Redis) | `appendEvent(tx, stream, type, payload)`, `replay(stream, afterSeq)`, `publishEphemeral(topic, payload)`, `subscribe(socket, topic)` | organization (topic authorization callback) | yes | yes |
| chat | conversations, conversation_participants, conversation_grants, messages, message_attachments, reactions | `createConversation`, `postMessage`, `share(conversation, principal, level)`, `canRead(user, conversation)` | organization, realtime, artifact, audit, notification | yes | yes |
| agent | agents, agent_memberships (which conversations), model_runs | `triggerRun(conversationId, cause)`, `cancelRun(runId)`, `listAgents(scope)` | chat, organization, realtime, audit | yes | yes |
| artifact | attachments, artifacts, artifact_permissions, storage_policies | `presignUpload(...)`, `finalize(...)`, `presignDownload(...)`, `checkPolicy(org, kind, size)` | organization, audit | basic | full |
| audit | audit_events | `record(tx, {actor, action, resource, result, ...})` | — | yes | yes |
| notification | notifications, notification_prefs | `notify(userIds, kind, payload)` | realtime | in-app | in-app |
| project | projects, repositories, project_devices | `registerOnDevice(project, device)`, `listForUser(user)` | organization, device | — | yes |
| device | devices, device_heartbeats (Redis), runtime_commands | `enroll(...)`, `verifyChallenge(...)`, `sendCommand(deviceId, cmd)`, `isOnline(deviceId)` | identity, organization, audit | — | yes |
| worksession | work_sessions, work_session_participants, work_session_permissions, prompts, prompt_queue_items, session_events (via realtime streams), approval_requests, repository_states, session_artifacts | `create(...)`, `join(...)`, `enqueuePrompt(...)`, `reorder(...)`, `interrupt(...)`, `resolveApproval(...)`, `ingestEvent(deviceId, event)` | project, device, realtime, artifact, organization, audit, notification, chat (card posting) | — | yes |

Deferred modules and the seam they will plug into: **model-gateway** (MVP3) replaces the `ModelProvider` interface inside `agent`; **skills / mcp / policy** (MVP4) hook into `organization.resolveEffectivePermissions` and the daemon's session bootstrap; **automation / openclaw-channel** (MVP5) consume `chat` and `agent` public APIs only; **device-relay** (MVP6) extends `device` command routing to web/mobile controllers; **federation** stays out.

### Module wiring (no DI container)

```typescript
// apps/api/src/app.ts (sketch)
const audit = createAuditModule({ db });
const identity = createIdentityModule({ db, audit });
const organization = createOrganizationModule({ db, identity, audit });
const realtime = createRealtimeModule({ db, redis, authorizeTopic: organization.authorizeTopic });
const notification = createNotificationModule({ db, realtime });
const artifact = createArtifactModule({ db, s3, organization, audit });
const chat = createChatModule({ db, organization, realtime, artifact, audit, notification });
const agent = createAgentModule({ db, chat, organization, realtime, audit, modelProvider });
// MVP2
const device = createDeviceModule({ db, redis, identity, organization, audit });
const project = createProjectModule({ db, organization, device });
const worksession = createWorkSessionModule({ db, redis, project, device, realtime, artifact, organization, audit, notification, chat });

for (const m of [identity, organization, realtime, notification, artifact, chat, agent, device, project, worksession]) {
  await app.register(m.routes, { prefix: "/api/v1" });
}
```

Rule: a module receives *interfaces*, not the whole app. `worksession` gets `chat.postAgentCard(...)`, not `chat`'s tables. This is what makes later extraction (folder → service) cheap.

---

## 2. Realtime Architecture

### Topology

```
client ──WSS /ws──► API instance A ──┐
client ──WSS /ws──► API instance A   │   Redis pub/sub  channel = topic
client ──WSS /ws──► API instance B ◄─┴──────────────────────────────────┐
                                                                        │
write path:  HTTP mutation ─► tx { insert row + appendEvent(stream) + audit } ─► COMMIT ─► PUBLISH topic
```

- **One socket per client, many subscriptions.** Not one socket per conversation. The client sends `{op:"sub", topic, afterSeq?}`; the server authorizes via `organization.authorizeTopic(user, topic)` and stores the subscription in an in-process map `topic → Set<socket>`. Each API instance subscribes to a Redis channel per topic it has at least one local subscriber for (subscribe on first local sub, unsubscribe on last).
- **Topics** (stable naming, used as Redis channel and as `stream_id`):
  - `conv:{conversationId}` — messages, edits, reactions, participant changes, AI-run lifecycle, token deltas (ephemeral)
  - `session:{workSessionId}` — Unified Session Events (MVP2)
  - `user:{userId}` — notifications, inbox, "your device went offline"
  - `org:{orgId}:presence` — online/away presence changes (ephemeral)
  - `device:{deviceId}` — device status (MVP2)

### Durable vs ephemeral events

| Class | Examples | Storage | Delivery |
|-------|----------|---------|----------|
| Durable | `message.created`, `message.updated`, `participant.joined`, `conversation.shared`, `run.started`, `run.completed`, every Unified Session Event except deltas | `stream_events` row **inside the mutation's transaction**, then Redis publish after commit | Replayable by cursor |
| Ephemeral | `typing`, presence heartbeats, `message.delta` (assistant tokens), `assistant.thinking` deltas, `command.output.delta` beyond what is coalesced | Redis only | Best effort; reconcile from snapshot |

Redis pub/sub is fire-and-forget: a slow subscriber is dropped and there is no replay. That is why nothing durable lives only in Redis (ADR-0003) and why reconnect always reconciles from Postgres.

### Event log table and per-stream sequence

```sql
CREATE TABLE streams (
  id               text PRIMARY KEY,          -- 'conv:<uuid>' | 'session:<uuid>' | 'user:<uuid>'
  organization_id  uuid NOT NULL,
  last_seq         bigint NOT NULL DEFAULT 0
);

CREATE TABLE stream_events (
  stream_id        text NOT NULL REFERENCES streams(id),
  seq              bigint NOT NULL,
  organization_id  uuid NOT NULL,
  type             text NOT NULL,             -- 'message.created', 'assistant.message', ...
  payload          jsonb NOT NULL,
  actor_user_id    uuid,
  actor_device_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, seq)
);
-- RLS: organization_id = current_setting('app.org_id')::uuid
```

`seq` must be **strictly monotonic in commit order per stream**; a plain `bigserial` is not (a lower id can commit after a higher one, and a client that saw the higher one would skip it forever). Allocate under the stream row lock inside the same transaction:

```typescript
// packages/db/src/events.ts
export async function appendEvent(tx: Tx, streamId: string, type: string, payload: unknown, actor: Actor) {
  const [{ last_seq }] = await tx.execute(sql`
    UPDATE streams SET last_seq = last_seq + 1 WHERE id = ${streamId} RETURNING last_seq`);
  await tx.insert(streamEvents).values({ streamId, seq: last_seq, type, payload, ...actor });
  return last_seq; // publish {streamId, seq, type, payload} to Redis AFTER tx commits
}
```

This serializes writers per conversation/session, which is exactly the ordering guarantee a chat needs; contention is per-stream, not global. Streams are created lazily (`INSERT ... ON CONFLICT DO NOTHING`) when a conversation or session is created.

Volume control for Work Zones: coalesce `command.output` and `assistant.message` deltas in the daemon (flush every 100 ms or 4 KB) into durable `*.chunk` events; keep per-token deltas ephemeral. Retention: partition `stream_events` by month from day one (cheap now, painful later) and prune ephemeral-class streams per org policy.

### Reconnect semantics

1. Client keeps `lastSeq` per subscribed durable topic (in memory; persisted in IndexedDB for the desktop/web so a page reload also resumes).
2. On (re)connect, client sends `{op:"sub", topic, afterSeq}` for each topic.
3. Server: authorize → start buffering live Redis events for that socket/topic → `SELECT ... WHERE stream_id=$1 AND seq>$2 ORDER BY seq LIMIT 500` → send replay batch → flush buffered live events with `seq > last replayed` → mark subscription live.
4. If the gap exceeds the limit (or the cursor is older than retention) the server answers `{op:"resync", topic}` and the client reloads the view from the HTTP snapshot endpoint, then subscribes with the snapshot's `seq` (every snapshot response carries the stream's `last_seq`).
5. Client dedupes by `(topic, seq)`; ephemeral events carry no seq and are simply applied.
6. Heartbeat: ws ping every 25 s, close after 2 missed; client reconnects with exponential backoff + jitter (1 s → 30 s).

Streaming assistant text across a reconnect: the `messages` row is created at run start with `status='streaming'`; the run loop flushes partial `content` into that row every ~1 s (a row update, not events). A reconnecting client loads the message snapshot (partial text) and continues receiving `message.delta`. The durable `message.completed` event closes it.

### Presence

- `presence:{orgId}:{userId}` Redis string with 60 s TTL, refreshed by the client heartbeat every 25 s; `SET` publishes `presence.online`, expiry is detected by a keyspace-notification listener or, simpler and more robust, by a 30 s sweeper that compares `SMEMBERS presence:{orgId}` against key existence and publishes `presence.offline`.
- Work Zone presence states (Controlling / Viewing diff / Typing / Following / Away) live in a Redis hash `session:{id}:presence` (field per user, value = state + updatedAt, hash TTL refreshed) and are broadcast ephemerally on `session:{id}`.
- Typing is ephemeral on `conv:{id}` with a 3 s client-side expiry; never touches Postgres.

### Horizontal scaling note

Any API instance can serve any socket; Redis fan-out makes local subscription maps sufficient. The only per-session single-writer is the **prompt arbiter** (Work Zone) and the **AI run loop** (AI chat), both claimed with a Redis lock (`SET run:{conversationId} <instance> NX PX 30000`, renewed while running). NATS JetStream is not needed for MVP1/MVP2: replay is served from Postgres, fan-out from Redis (ADR-0003 revisit triggers unchanged).

---

## 3. Multiplayer AI Chat

### Data model (chat module)

```
conversations           id, organization_id, kind ('channel'|'dm'|'group'|'ai_chat'|'thread'),
                        parent_conversation_id (threads), owner_user_id, org_unit_id?, project_id?,
                        visibility ('private'|'members'|'unit'|'org'), ai_config jsonb
                        (model, tools, permission_mode, system_prompt_ref), created_at
conversation_participants  conversation_id, principal_type ('user'|'agent'), principal_id,
                        role ('owner'|'editor'|'viewer'), added_by, joined_at
conversation_grants     conversation_id, grantee_type ('user'|'org_unit'|'project'|'org'),
                        grantee_id, level ('view'|'comment'|'edit'), granted_by, created_at
messages                id, conversation_id, organization_id, seq (from stream), author_type
                        ('user'|'agent'|'system'), author_id, device_id?, reply_to?, content jsonb
                        (blocks: text/image/document/tool_use/tool_result/card), model_run_id?,
                        status ('sent'|'streaming'|'completed'|'interrupted'|'failed'),
                        context_snapshot jsonb, permissions_snapshot jsonb, created_at, edited_at
model_runs              id, conversation_id, agent_id, triggered_by_message_id, status
                        ('queued'|'running'|'completed'|'cancelled'|'failed'), started_at, ended_at,
                        usage jsonb, error?
```

- **Sharing without copying is a grant, not a fork.** "Private → shared with Alex → shared with Backend team" is `INSERT INTO conversation_grants` twice; the conversation id, messages, attachments, artifacts, `ai_config` and participants never move. `canRead(user, conversation)` = owner ∨ participant ∨ ∃ grant where grantee ∈ {user, user's org units (including ancestors via ltree), user's projects, org}. Late joiners see full history (same as a Slack channel; PRD §17 requires context preservation).
- **Per-message permissions** (PRD §16) are two things: (a) `permissions_snapshot` — what the author was allowed to do and which tools the model had at that instant (auditable, immutable); (b) live edit/delete rights derived from conversation grants (author or owner). Do not build per-message ACLs; they make replay and RLS unmanageable.
- **`context_snapshot`** records device, client, model and run id so an audit line can say "sent from Alex's iPhone while run 42 was streaming".

### Representing several humans to one model

Verified constraints (Anthropic Messages API, via the claude-api reference): `user` and `assistant` turns must alternate; there is no per-message author field; Claude Opus 5-family models accept mid-conversation `system` messages inside `messages[]` as an operator channel that does not break the cached prefix. Design that respects this and stays provider-neutral (OpenAI-compatible providers behave the same on alternation):

1. **Roster in the system prompt** (stable prefix, cacheable): "This is a shared conversation. Participants: Víctor (Team Lead, Backend), Alex (Developer, Backend). Each user message is labelled with its author. Address people by name; when participants disagree, say so explicitly." Update only when the roster changes.
2. **Every human message is rendered as an attributed block** inside a `user` turn:
   ```xml
   <message author="Víctor" user_id="u_1" role="Team Lead" at="2026-09-10T10:42:03Z">Propose an architecture.</message>
   ```
   Attachments become `document`/`image` blocks placed after the attributed text block, inside the same turn.
3. **Consecutive human messages are merged into one `user` turn** in chronological order (this is what makes alternation hold). The merge is done at prompt-assembly time from the `messages` table; the stored messages stay separate rows with separate authors.
4. **Assistant turns are replayed verbatim** (text, tool_use, tool_result pairs, thinking blocks when the same model is reused) so tool loops and caching keep working.
5. **Operator notices** ("Alex joined", "model switched to X", "tools restricted") go into a mid-conversation `system` message on providers that support it and into a `<system_notice>` block inside the next user turn otherwise. The `ModelProvider` interface exposes `supportsMidConversationSystem` so `agent` chooses.

This is the same conclusion the multi-user-chat literature reaches (MUCA "what/when/who", HUMA): explicit speaker labels are mandatory, and the assistant must not answer every message in a group.

### Turn arbitration ("when does the model speak?")

- **Direct AI chat (one human):** run after every human message.
- **Multiplayer AI chat:** run is triggered by a human message, but with a **debounce window of ~1.5 s** after the last human message so that two people typing at once produce one turn with both messages; an explicit "send to model" action or an `@model` mention bypasses the debounce. Channels/DMs with an agent participant trigger only on mention, reply-to-agent, or thread the agent is in (PRD §13, §19).
- **One active run per conversation**, enforced by a partial unique index `(conversation_id) WHERE status='running'` plus the Redis lock for the executing instance. Messages that arrive while a run is in progress are **queued** (default): when the run completes, `agent.triggerRun` fires again and the new turn contains all messages since the last assistant turn. A participant with `edit` level can **interrupt**: the run is cancelled, the partial assistant message is persisted with `status='interrupted'` (visible to everyone, attributed to the model), and a new run starts.
- Runs execute inside the API process that acquired the lock, stream through `conv:{id}` (ephemeral `message.delta`), flush partial text into the row every ~1 s, and finish with durable `message.completed` + `run.completed` + audit + usage.

### Streaming to all participants

All subscribers of `conv:{id}` receive the same `message.delta` stream regardless of who triggered the run; there is no per-user stream. Clients render the streaming message from the snapshot + deltas; there is no client-side "my request" special case. Token usage and cost are attributed to the *triggering user* (and later to the org budget, MVP3).

---

## 4. Work Zone

### Entities (worksession module)

```
work_sessions            id, organization_id, project_id, owner_user_id, host_device_id, runtime
                         ('claude_code'|'codex'|'opencode'), runtime_session_ref (opaque; Claude session_id /
                         Codex threadId, for resume), title, status, model, permission_policy jsonb,
                         source_conversation_id?, source_message_id?, created_at, ended_at
work_session_participants  session_id, user_id, permissions text[] (VIEW..FULL_CONTROL), added_by
prompts                  id, session_id, author_user_id, origin_device_id, text, attachments,
                         execution_mode ('queue'|'steer'|'interrupt'), status ('queued'|'running'|
                         'completed'|'failed'|'cancelled'), position, priority, created_at, started_at, ended_at
approval_requests        id, session_id, prompt_id?, runtime_ref (toolUseID / JSON-RPC id), kind
                         ('command'|'file_change'|'permission'|'question'), payload jsonb, status
                         ('pending'|'approved'|'denied'|'expired'), resolved_by, resolved_at, decision jsonb
repository_states        session_id, captured_at, repo_relative_root, branch, base_commit, head_commit,
                         dirty bool, ahead, behind, changed_files jsonb [{path,status,+,-}]
session_artifacts        id, session_id, artifact_id, relative_path, sha256, size, published_by
runtime_commands         id (seq per device), device_id, session_id?, type, payload, status
                         ('pending'|'sent'|'acked'|'failed'), created_at, acked_at
```

Session events are `stream_events` on `session:{id}`; no separate table.

### WorkSession state machine

```
draft ──create──► provisioning ──daemon accepted──► idle
                       │ (host offline / rejected)      │ prompt dispatched
                       ▼                                ▼
                     failed ◄──── runtime error ───── running ◄──────────────┐
                                                        │ approval.requested │ approval.resolved
                                                        ▼                    │
                                                  waiting_approval ──────────┘
   any active state ──heartbeat lost──► host_offline ──reconnect──► (previous state, arbiter re-syncs)
   idle | host_offline ──end──► completed ──► archived
```

- `idle`: runtime process alive, no turn in progress. The arbiter dispatches the head of the queue when `auto_run_next` is on (default on), otherwise waits for an explicit `run-next`.
- `host_offline` is not terminal: the queue is persisted server-side; on reconnect the daemon reports its view (`runtime_session_ref`, whether the process is still alive, last emitted event seq) and the arbiter reconciles: if the runtime died, resume it (`resume` option / `thread/resume`) before dispatching.

### Prompt Queue arbitration ("multiple controllers, one executor")

The arbiter is a server-side function in `worksession` guarded by the per-session Redis lock and driven by two inputs: queue mutations (HTTP) and runtime events (device link).

```
on prompt.enqueue(mode=queue)        → insert queued at tail (or by priority); if session idle → dispatch
on prompt.enqueue(mode=steer)        → if runtime.capabilities.steer && running → send steer(text) to daemon,
                                        mark prompt 'running' (attached to current turn)
                                        else → insert at head with priority=high (degrade to queue)
on prompt.enqueue(mode=interrupt)    → send interrupt; on turn.completed(interrupted) → dispatch this prompt first
on reorder / edit / remove           → only prompts in status 'queued'; edit creates a new version, audit both
on session.waiting | turn.completed  → mark running prompt completed/failed; dispatch next if auto_run_next
on approval.requested                → session → waiting_approval; notify APPROVE-capable participants
on approval.resolved (HTTP)          → validate permission APPROVE; persist; send approval.respond command
```

Permission checks happen **before** the arbiter (PROMPT, STEER, QUEUE, REORDER_QUEUE, CANCEL, APPROVE, FULL_CONTROL). `permission.denied` is itself a session event so everyone sees the attempt (PRD §35).

Prompt identity: the daemon receives `{promptId, authorUserId, originDeviceId, text}` and passes the text to the runtime; the *runtime* only ever sees an ordinary user message, but every Unified event the daemon emits during that turn carries `promptId`, so attribution survives even though the code ran on someone else's machine.

### AgentRuntime adapter interface (packages/protocol + apps/runtime)

```typescript
export interface RuntimeCapabilities {
  steer: boolean;            // append input to the active turn without cancelling it
  interrupt: boolean;
  resume: boolean;           // reattach to a persisted runtime session
  approvals: "native" | "none";
  partialOutput: boolean;    // token-level deltas
}

export interface AgentRuntime {
  readonly kind: "claude_code" | "codex" | "opencode";
  readonly capabilities: RuntimeCapabilities;
  start(opts: { cwd: string; model?: string; permissionPolicy: PermissionPolicy; resumeRef?: string }): Promise<{ runtimeSessionRef: string }>;
  submitPrompt(p: { promptId: string; text: string; attachments?: LocalAttachment[] }): Promise<void>;
  steer(p: { promptId: string; text: string }): Promise<void>;       // throws if !capabilities.steer
  interrupt(): Promise<void>;
  respondApproval(r: { runtimeRef: string; decision: ApprovalDecision }): Promise<void>;
  stop(): Promise<void>;
  events(): AsyncIterable<UnifiedSessionEvent>;   // already normalized, relative paths only
}
```

### Mapping runtime streams onto the Unified Session Event Protocol

**Claude Code → use `@anthropic-ai/claude-agent-sdk` in streaming-input mode** (not raw `claude -p`). Verified today against the official docs: `query({ prompt: AsyncIterable<SDKUserMessage>, options })` keeps one long-lived process, queues additional user messages sequentially, exposes `interrupt()`, `resume`/`forkSession`, `includePartialMessages` (`stream_event` deltas), `hooks`, and routes permission prompts to `canUseTool(toolName, input, { signal, suggestions })` which returns `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }` and may stay pending indefinitely (the turn pauses). The raw CLI (`claude -p --output-format stream-json --input-format stream-json`) emits the same message types (`system/init` with `session_id` and `capabilities[]`, `assistant`, `user`, `result`, `stream_event`) and is the fallback if the SDK cannot be bundled.

| Claude Agent SDK message | Unified event |
|---|---|
| `system` (`subtype: init`, `session_id`, `model`, `tools`, `capabilities`) | `session.started` (store `session_id` as `runtime_session_ref`) |
| `stream_event` with `text_delta` / `thinking_delta` | `assistant.message` chunk (coalesced) / `assistant.thinking` (ephemeral) |
| `assistant` message containing `tool_use` blocks | `tool.requested` then `tool.started` (Bash → also `command.started` with the command string) |
| `user` message containing `tool_result` | `tool.output` (+ `command.completed` for Bash; `file.changed` for Write/Edit, path relativized) |
| `canUseTool` invocation (Bash/Write/Edit or `AskUserQuestion`) | `approval.requested {kind: command\|file_change\|question, runtimeRef: toolUseID}`; resolved by `respondApproval` → returns from the callback |
| `system` `subtype: permission_denied` / `api_retry` | `permission.denied` / `session.waiting {reason}` |
| `result` (`subtype: success` or `error_*`) | `session.completed` or `session.failed` for the turn, then `session.waiting` (idle) |
| `interrupt()` → result | `session.waiting {reason: interrupted}` |
| `hook_*`, `task_progress` (subagents, `parent_tool_use_id`) | `tool.output` annotated with `parentToolUseId` (UI groups them) |

Steer on Claude Code: additional user messages sent mid-turn are queued by the SDK and processed after the current turn; there is no native "append to the running turn" call. So `capabilities.steer = false` for `ClaudeCodeRuntime` in MVP2 (Steer degrades to head-of-queue), unless the `capabilities[]` array in `system/init` proves otherwise at runtime; treat that as feature detection, not a version check. Run **without** `--bare` so the developer's subscription login and project `CLAUDE.md`/MCP config apply; pass `permissionMode` from the server's `permission_policy` and let `canUseTool` be the only path to human approval. Use SIGINT/`interrupt()` to end a turn cleanly; SIGTERM leaves the turn unfinished (exit 143) but the session is resumable.

**Codex → use `codex app-server` over stdio (JSON-RPC 2.0), not `codex exec --json`.** Verified today: `initialize`/`initialized` handshake; `thread/start` (model, cwd, `approvalPolicy: never|onRequest|unlessTrusted`, `sandbox: readOnly|workspaceWrite|externalSandbox|dangerFullAccess`), `thread/resume`, `turn/start`, `turn/interrupt`, and **`turn/steer`** (append input to the active turn). Server-initiated approval requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (decisions `accept | acceptForSession | decline | cancel`), `item/permissions/requestApproval`, `mcpServer/elicitation/request`. `codex exec --json` is output-only JSONL with no approvals, interrupt or steer, so it cannot back a multiplayer session.

| Codex app-server notification / request | Unified event |
|---|---|
| `thread/started` | `session.started` (`runtime_session_ref = threadId`) |
| `turn/started` | `prompt.updated {status: running}` |
| `item/started` `agentMessage` + `item/agentMessage/delta` | `assistant.message` chunks |
| `item/reasoning/*Delta` | `assistant.thinking` (ephemeral) |
| `item/started` `commandExecution` / `item/commandExecution/outputDelta` / `item/completed` | `command.started` / `tool.output` (coalesced) / `command.completed {exitCode}` |
| `item/completed` `fileChange` (`changes[{path, kind, diff}]`) | `file.changed` per path + `git.diff` (paths relativized) |
| `item/*` `mcpToolCall`, `webSearch` | `tool.requested` / `tool.started` / `tool.output` |
| `turn/diff/updated` | `git.diff` (aggregated unified diff) |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | `approval.requested {kind, runtimeRef: jsonrpc id}`; answered with the JSON-RPC response on `respondApproval` |
| `turn/completed {status: completed\|interrupted\|failed}` | `session.completed` / `session.waiting {interrupted}` / `session.failed` |
| `turn/steer` accepted | `execution.steered` |

`CodexRuntime.capabilities = { steer: true, interrupt: true, resume: true, approvals: "native", partialOutput: true }`.

### Approval round-trip

```
runtime asks ─► adapter emits approval.requested ─► daemon sends to backend ─► worksession persists
approval_requests(pending) + appends session event + notifies APPROVE-capable participants
◄─ participant resolves via POST /work-sessions/:id/approvals/:approvalId {decision}
◄─ worksession validates APPROVE permission, persists approval.resolved (+ audit: who, from which device)
◄─ runtime_commands row {type: approval.respond} sent on device link, acked by daemon
◄─ adapter resolves the pending canUseTool promise / JSON-RPC response
```

- If the daemon restarts while an approval is pending, the in-memory promise is lost: the daemon reports `approval.expired` on reconnect, the server marks the request `expired`, and the arbiter resumes the runtime session (Claude Code continues the unfinished turn on resume; Codex re-asks). This is acceptable for MVP2; the Agent SDK's `PreToolUse` `defer` decision is the future path for long-lived waits.
- Decisions are stored normalized (`allow | allow_for_session | deny | cancel`, plus `updatedInput`/answers for `AskUserQuestion`) so the audit line reads identically for both runtimes.

### Git state capture and diff streaming (daemon Git adapter)

- After `session.started`, after every `file.changed`, and at `turn/completed` (debounced 500 ms): `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git status --porcelain=v2 --branch`, `git diff --numstat` (+ `--cached`). Emit `git.state` with `{branch, baseCommit (captured once at session start), headCommit, dirty, ahead, behind}` and `git.diff` with `changedFiles[{path, status, additions, deletions}]`.
- Full patches are **pulled, not pushed**: the client asks `GET /work-sessions/:id/diff?path=` → server checks `DIFF_VIEW` → `runtime_commands {type: file.diff.request}` → daemon returns the unified diff (capped, e.g. 512 KB) → server relays; only cache small patches in `repository_states`. This keeps the event log small and respects "source files are not uploaded automatically" (PRD §48.1).
- Every path is made relative to the registered project root by the daemon; anything that resolves (after `realpath`, symlinks included) outside that root is rejected with `permission.denied {reason: containment}` before it leaves the machine (PRD §52).

### Artifact publishing (daemon → S3 → server)

```
local file ─► containment (realpath inside project root, no symlink escape)
           ─► policy (server-provided: max size, allowed types, cloud storage enabled / encrypted-only / disabled)
           ─► SHA-256 (streamed)
           ─► security checks (size, type sniffing, deny-list, secret scan on text)
           ─► POST /artifacts/presign {sessionId, relativePath, sha256, size, contentType}
           ─► PUT to S3 presigned URL (TLS; SSE-KMS/SSE-S3 at rest in MVP2; client-side envelope encryption later)
           ─► POST /artifacts/:id/finalize  (server verifies object checksum = sha256, sets status=available)
           ─► session event artifact.created {artifactId, relativePath, sha256, size}
```

Downloads are presigned GETs behind `FILES_DOWNLOAD`, audited per download (`file.downloaded`). Attachments in chat use the same `artifact` module with `kind='attachment'` and no containment step (browser upload).

---

## 5. Local Runtime Daemon ↔ Electron ↔ Backend

### Process model

```
Electron main ── spawn(detached, own state dir) ──► apps/runtime daemon
      │  contextBridge/ipcRenderer                     │  stdio JSON-RPC / child processes
      ▼                                                ▼
Electron renderer (React UI, same bundle as web)   claude (Agent SDK) · codex app-server · git
      │                                                │
      └── HTTPS/WSS to Control Plane ◄────────────────┘ WSS /runtime/ws (outbound only)
```

- The daemon is a **standalone Node 22 binary** (`apps/runtime`), packaged inside the Electron app but started as a detached child with its own state directory (`~/Library/Application Support/<app>/runtime/`, `%APPDATA%\<app>\runtime`, `~/.local/state/<app>/runtime`). In MVP2 Electron is its supervisor (start on app launch, restart on crash, stop on quit); registering it as a launchd agent / systemd user service / Windows service is the MVP6 step, and nothing in MVP2 should assume the UI is running.
- Electron ↔ daemon: NDJSON over a Unix domain socket / Windows named pipe in the state dir, mode 0600, plus a per-boot random token written to a 0600 file that the client must present in its first frame. `utilityProcess.fork` is rejected because it cannot pipe stdin and dies with the app.
- Renderer never talks to the daemon directly; it calls `window.desktop.*` (contextBridge) → main → socket. The renderer's *session* traffic goes to the Control Plane exactly like the web app.

### Device identity and authentication

1. **Enrollment.** User is logged in inside Electron. Electron requests a short-lived enrollment code (`POST /devices/enrollment-codes`, 10 min, single use). Daemon generates an **Ed25519 keypair** (`crypto.generateKeyPairSync("ed25519")`), stores the private key in its state dir with mode 0600 (macOS Keychain / DPAPI wrapping is a hardening step; Electron `safeStorage` is main-process-only and unavailable to the daemon, so do not design around it), and calls `POST /devices/enroll {enrollmentCode, publicKey, deviceInfo: {name, os, arch, runtimeVersion, runtimes: {claude_code, codex}}}`. Server creates `devices {id, organization_id, owner_user_id, public_key, status}`; `status` is `authorized` immediately or `pending` when the org policy requires admin approval (PRD §38).
2. **Connection.** Daemon opens `WSS /runtime/ws`. Server sends `challenge {nonce, expiresAt}`. Daemon replies `hello {deviceId, signature = Ed25519(nonce ‖ deviceId ‖ serverHost ‖ timestamp), runtimeVersion, activeSessions[]}`. Server verifies against the stored key, checks `status='authorized'` and version policy, binds the socket to `(deviceId, ownerUserId, organizationId)`. No bearer tokens on the device link; revoking a device flips `status` and the server closes the socket.
3. **Authority model.** The device acts *for its owner*: it may only host sessions on projects registered to it and whose owner is a member; prompts from other participants are authored by them (prompt identity) but executed under the owner's local runtime credentials. Provider credentials never leave the device in MVP2 (Model Gateway is MVP3).

### Heartbeat and reconnect

- Daemon sends `heartbeat {ts, load, activeSessions:[{sessionId, runtimeSessionRef, state, lastEventSeq}], pendingApprovals}` every 20 s; server stores `device:{id}:online` in Redis with 45 s TTL and publishes `device.online/offline` on `device:{id}` and `user:{ownerId}`; session-level `session.waiting {reason: host_offline}` is appended to every affected `session:{id}` stream when the key expires.
- Reconnect: exponential backoff with jitter (1 s → 30 s cap), then `resume {sessions:[{sessionId, lastAckedCommandId, lastEmittedEventSeq}]}`.
  - Server → daemon: resend all `runtime_commands` for that device with `status IN ('pending','sent')` in id order (at-least-once; daemon dedupes by command id).
  - Daemon → server: replay its **on-disk append log** of un-acked events per session (`{sessionId, daemonSeq, event}`); the server dedupes on `(session_id, daemon_seq)` and assigns the stream `seq` on ingest. This is what turns "host went to sleep for 10 minutes" into a gap, not a loss.
- Commands are acked individually (`ack {commandId}`); the arbiter treats a prompt as dispatched only after the ack, so a prompt is never silently lost between the queue and the runtime.

### What state lives where

| State | Owner | Notes |
|-------|-------|-------|
| WorkSession, participants, permissions, prompt queue, approvals, session events, artifacts metadata, git snapshots, device registry | **Control Plane (Postgres)** | Source of truth; survives any client or daemon restart |
| Ephemeral presence, typing, online flags, arbiter/run locks | **Redis** | Reconstructible |
| Absolute paths (project root mapping), runtime processes, `runtime_session_ref` bookkeeping, provider/OAuth credentials, local MCP config, offline event buffer, private key | **Daemon (state dir)** | Never sent to the server (PRD §52); `runtime_session_ref` is sent as an opaque string only |
| Window state, local preferences, cached snapshots and cursors | **Electron / web client** | Nothing authoritative |

---

## 6. Multi-Tenant Data Model and RLS

### Organization hierarchy

```
organizations(id, slug, name, settings)
org_units(id, organization_id, parent_id NULL for top, kind 'department'|'team', name, path ltree)
projects(id, organization_id, org_unit_id (owning team), name, settings)
repositories(id, project_id, organization_id, provider, remote_url, default_branch)
memberships(id, organization_id, user_id, scope_type 'organization'|'org_unit'|'project',
            scope_id, role 'standard'|'developer'|'lead'|'admin', granted_by, created_at)
role_permissions(role, permission)          -- static seed, per PRD §7
```

- `org_units` with `kind` + `ltree path` (not separate `departments`/`teams` tables): the PRD example already nests `IT → Backend → Team Alpha`, so depth is variable. Ancestor/descendant queries are `path <@ '...'`; membership in a unit implies membership in its descendants for *visibility* (a department lead can see team channels) but not for *roles* unless explicitly granted.
- The four PRD roles are **org-level roles**; a `lead` at a unit scope is a `standard`/`developer` elsewhere. Roles map to permission sets in `role_permissions`; resources add their own grants (`conversation_grants`, `work_session_participants.permissions`, `artifact_permissions`).

### Effective permissions as an intersection

Implemented once, in `organization.resolveEffectivePermissions(actor, resource, action)`, used by every route and by the future "effective permission viewer":

```
allowed(action) =
      roleAllows(actor.role@org ∪ actor.roles@unit ancestors of resource, action)
  ∧   resourceGrantAllows(resource, actor, action)         -- conversation / work session / artifact ACL
  ∧   unitPolicyAllows(resource.org_unit path, action)     -- MVP4 policies; returns true in MVP1/2
  ∧   devicePolicyAllows(actor.device, action)             -- MVP2: device authorized + version ok
  ∧   ¬ explicitDeny(any layer)                            -- deny always wins
```

Every layer is a pure function over already-loaded rows; the resolver is memoized per request. Audit records the *decision* and the layer that denied, which is the "explicit deny precedence" the PRD asks for.

### RLS strategy

- **RLS enforces the tenant boundary (organization), not fine-grained ACL.** Every org-scoped table carries `organization_id`; the policy is `USING (organization_id = current_setting('app.org_id', true)::uuid)` with a matching `WITH CHECK`. Per-conversation or per-session visibility stays in application code via `resolveEffectivePermissions`: putting grant joins into RLS policies is slow and makes replay/cursor queries unpredictable.
- **Two database roles.** Migrations run as the owner role; the API connects as `app_user` (`NOBYPASSRLS`, not the table owner — owners and superusers bypass RLS silently). A `service` code path that must cross tenants (admin metrics, federation later) uses a separate role and is audited.
- **Transaction-scoped context only.** `SET LOCAL` / `set_config(name, value, true)` inside the transaction, never session `SET`: with pooled connections a session-level setting leaks the previous request's tenant into the next one. This also keeps PgBouncer transaction mode possible later.

```typescript
// packages/db/src/tenant.ts
export async function withTenant<T>(db: Db, ctx: { orgId: string; userId?: string; deviceId?: string }, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.org_id', ${ctx.orgId}, true),
             set_config('app.user_id', ${ctx.userId ?? ""}, true),
             set_config('app.device_id', ${ctx.deviceId ?? ""}, true)`);
    return fn(tx);
  });
}
```

Drizzle declares policies in the schema (`pgTable(...).withRLS()` / `pgPolicy(name, { for, to, using, withCheck })`, `pgRole`) and drizzle-kit emits them in migrations when `entities.roles` is enabled, so RLS is versioned with the schema.

- **Indexes lead with `organization_id`** (`(organization_id, conversation_id, created_at)` etc.); without that RLS filtering is orders of magnitude slower.
- **Tenant isolation is a test target** (ADR-0003): an integration test seeds two orgs and asserts that every module's read path returns zero rows across the boundary when connected as `app_user`.
- **Device link context.** Events ingested from `/runtime/ws` run under `withTenant({ orgId: device.organizationId, deviceId })`; a device can never write into another org.

---

## Architectural Patterns

### Pattern 1: Persist-then-publish with per-stream sequence

**What:** Every durable realtime event is written to `stream_events` inside the business transaction (sequence allocated under the stream row lock), published to Redis only after commit, and reconciled by cursor on reconnect.
**When to use:** All chat and session events; anything a late/reconnecting client must not miss.
**Trade-offs:** One extra row per event and a per-stream lock; in exchange, ordering and replay are exact and no message broker is needed in MVP1/2. A crash between commit and publish delays delivery until the next event or reconnect (a cheap outbox poller closes that gap later if it matters).

### Pattern 2: Single executor claimed by lock, many controllers through the API

**What:** The AI run loop (per conversation) and the prompt arbiter (per Work Session) are claimed with a Redis `SET NX PX` lock by whichever API instance handles the trigger; everyone else mutates state through the API and observes through the stream.
**When to use:** Any place where the PRD says "multiple controllers, one execution authority".
**Trade-offs:** Simple and horizontally scalable; if the lock holder dies mid-run, the lock expires and the run is marked failed/interrupted rather than transparently resumed (acceptable for MVP; NATS/Temporal would be the upgrade).

### Pattern 3: Adapter normalizes at the edge

**What:** Runtime-specific event shapes are converted to the Unified Session Event Protocol *inside the daemon*, together with path relativization and containment. The Control Plane never sees Claude/Codex-specific payloads.
**When to use:** Every runtime, including OpenClaw in MVP5.
**Trade-offs:** Some fidelity is lost (keep an `raw` field only in local daemon logs, never uploaded); in exchange the server, UI and audit are runtime-agnostic and a new runtime is one adapter.

### Pattern 4: Grants, not copies, for sharing

**What:** Sharing an AI chat, session or artifact adds a grant row; the resource id never changes.
**When to use:** All "private → user → team" flows.
**Trade-offs:** `canRead` is a small join over memberships; there is no divergence between "original" and "shared copy", which is what makes multiplayer possible at all.

### Pattern 5: Commands table for daemon delivery

**What:** Everything the server wants a device to do is a `runtime_commands` row (id, type, payload, status) delivered over the socket and acked; the arbiter reacts to acks, not to sends.
**When to use:** Prompt dispatch, steer, interrupt, approval responses, diff/file requests.
**Trade-offs:** At-least-once with dedupe on the daemon; slightly more bookkeeping, but the "host disconnect" risk (PRD §109.2) becomes a visible, recoverable state.

---

## Data Flow

### Flow A: human message in a multiplayer AI chat

```
Alex types ─► POST /conversations/:id/messages
  ─► withTenant(tx): assertCan(EDIT) · insert messages · appendEvent(conv:id, message.created) · audit
  ─► COMMIT ─► PUBLISH conv:id ─► every subscribed socket (Víctor, Alex, web, desktop) renders it
  ─► agent.triggerRun (debounced 1.5 s; lock run:conv) ─► assemble prompt (roster + attributed merged user turns)
  ─► stream from provider ─► message row (status streaming, partial flush) + ephemeral message.delta on conv:id
  ─► finish ─► message.completed + run.completed (durable) ─► audit + usage
```

### Flow B: prompt queued into a Work Zone from another machine

```
Alex ─► POST /work-sessions/:id/prompts {text, mode: queue}
  ─► assertCan(QUEUE) · insert prompts(queued) · appendEvent(session:id, prompt.queued) · audit ─► COMMIT/PUBLISH
  ─► arbiter (lock session:id): session idle? ─► insert runtime_commands {prompt.dispatch} ─► device socket
  ─► daemon acks ─► prompts.status=running · prompt.updated ─► adapter.submitPrompt ─► runtime turn
  ─► Unified events flow up (assistant.message, tool.*, command.*, file.changed, git.diff)
  ─► ingest: withTenant(device org) · appendEvent(session:id, ...) ─► PUBLISH ─► Víctor's desktop, Alex's web
  ─► approval.requested ─► waiting_approval · notify APPROVE holders ─► Víctor approves (any device)
  ─► runtime_commands {approval.respond} ─► adapter resolves ─► ... ─► turn/completed ─► session.waiting ─► next prompt
```

### Flow C: Chat → Work Zone

```
"@codex fix it" in #backend ─► client opens create dialog (project, host device from project_devices where device online)
  ─► POST /work-sessions {projectId, hostDeviceId, runtime, sourceConversationId, sourceMessageId, firstPrompt}
  ─► worksession.create (provisioning) ─► runtime_commands {session.start {projectId, runtime, permissionPolicy}}
  ─► daemon resolves project root locally, starts adapter ─► session.started ─► idle ─► first prompt dispatched
  ─► chat.postAgentCard(sourceConversation, {sessionId, host, runtime, status}) ─► card updates on status events
```

### Key Data Flows

1. **Authorization always precedes persistence**, and the audit row is written in the same transaction as the action.
2. **Realtime is derived from persistence**, never the other way around: clients can always rebuild from HTTP snapshots + cursors.
3. **Absolute paths and credentials flow only downward** (server → daemon carries project ids and policies; daemon → server carries relative paths and opaque refs).

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Autofy (tens of users, a few orgs) | Single API instance is fine; Redis still required because the arbiter/run locks and presence rely on it. Docker compose: api, web, postgres, redis, minio, openbao, otel stack (ADR-0003). |
| 1k–10k users, hundreds of orgs | 2–4 API instances behind a load balancer with sticky-less WebSockets (Redis fan-out makes it work). Partition `stream_events` monthly; move ephemeral deltas fully off Postgres; add the outbox poller. PgBouncer in transaction mode (compatible with `SET LOCAL`). |
| 10k+ users / many concurrent Work Zones | Split the device gateway (`/runtime/ws`) and the client gateway into separately scaled processes (same code, different entrypoints) before splitting modules. Replace Redis pub/sub with NATS JetStream for session streams (ADR-0003 trigger). Consider Redis Cluster sharded pub/sub. |

### Scaling Priorities

1. **First bottleneck: `stream_events` growth from Work Zones.** Coalesce deltas, keep tokens ephemeral, partition by month, retention per org. Detect via rows/day per session.
2. **Second bottleneck: hot conversations with many subscribers across instances.** Each instance subscribes once per topic, so fan-out cost is O(instances) on Redis and O(sockets) locally; fine until thousands of sockets per topic, then move to sharded pub/sub / NATS.
3. **Third: provider streaming concurrency in the API process.** Runs are I/O bound; if they start starving request handling, move `agent` run loops to a worker entrypoint of the same monolith (folder → process, ADR-0002 promise).

---

## Anti-Patterns

### Anti-Pattern 1: Session state in the desktop app

**What people do:** Let the Electron app on the host own the session and "mirror" it to the cloud.
**Why it's wrong:** Alex's view diverges from Víctor's; handover between devices (PRD §41) and mobile approvals become impossible; audit is incomplete.
**Do this instead:** Cloud-owned WorkSession; the host desktop is just another controller plus a supervisor for the daemon.

### Anti-Pattern 2: Redis as the event source of truth

**What people do:** Publish events to Redis and only sometimes persist them.
**Why it's wrong:** Pub/sub drops slow consumers and has no replay; a laptop lid closing loses history.
**Do this instead:** Persist with a per-stream seq first, publish after commit, replay by cursor.

### Anti-Pattern 3: Global sequence for ordering

**What people do:** Use a `bigserial` id as the cursor.
**Why it's wrong:** Ids are not commit-ordered; a client can permanently skip an event that committed late with a lower id.
**Do this instead:** Per-stream counter allocated under the stream row lock inside the same transaction.

### Anti-Pattern 4: Session-level `SET app.org_id`

**What people do:** Set the tenant once when a connection is opened.
**Why it's wrong:** Pooled connections carry the previous tenant into the next request; the most common way RLS-based isolation is silently broken.
**Do this instead:** `set_config(..., true)` / `SET LOCAL` inside every transaction; connect as a non-owner role.

### Anti-Pattern 5: Sharing by copying the conversation

**What people do:** "Share" creates a snapshot conversation for the recipient.
**Why it's wrong:** Two histories diverge immediately; multiplayer is impossible; artifacts and permissions duplicate.
**Do this instead:** Grants on the same conversation id.

### Anti-Pattern 6: Runtime-specific payloads in the Control Plane

**What people do:** Store raw Claude/Codex JSON in `session_events` and let the UI switch on runtime.
**Why it's wrong:** Every new runtime touches server, UI, audit and mobile; the PRD's mitigation for runtime fragmentation evaporates.
**Do this instead:** Normalize in the daemon adapter; the server only knows the Unified protocol.

### Anti-Pattern 7: `codex exec --json` / `claude -p` one-shot per prompt

**What people do:** Spawn a fresh process per prompt and parse its JSONL.
**Why it's wrong:** No approvals, no interrupt, no steer, no shared context between prompts from different people; the runtime session ref changes every time.
**Do this instead:** Long-lived `codex app-server` thread and Agent SDK streaming-input session per Work Zone, resumed by ref after daemon restarts.

### Anti-Pattern 8: Absolute paths "just in the diff header"

**What people do:** Forward `git diff` output unmodified.
**Why it's wrong:** `diff --git a/Users/victor/...` leaks the host layout (PRD §52).
**Do this instead:** Run git with `-C <root>` and `--relative`, relativize every path in the adapter, reject anything outside the root.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Claude Code (host) | `@anthropic-ai/claude-agent-sdk` in the daemon, streaming input mode, `canUseTool` for approvals, `resume` after restarts; fallback `claude -p --output-format stream-json --input-format stream-json` | Requires Claude Code installed and authenticated on the host; do not use `--bare` (it disables subscription login and project config). Feature-detect via `system/init.capabilities`. Verified 2026-09-10 (MEDIUM). |
| Codex (host) | `codex app-server` child process over stdio JSON-RPC; `thread/start` with `approvalPolicy` + `sandbox` from the server policy; `turn/steer`, `turn/interrupt`; answer `item/*/requestApproval` | Do not use `codex exec --json`. Verified 2026-09-10 (MEDIUM). |
| Model providers (AI chat, server-side) | Thin `ModelProvider` interface in `agent` (Anthropic SDK first, streaming); org-level keys as `SecretReference` in OpenBao | Becomes the Model Gateway in MVP3; keep the interface narrow (`stream(messages, config)`). |
| PostgreSQL | Drizzle + `withTenant` transaction helper; RLS policies in migrations; monthly partitions for `stream_events` | Connect as `app_user` (NOBYPASSRLS). |
| Redis | pub/sub per topic; `SET NX PX` locks; presence keys with TTL | Nothing durable. |
| S3 / MinIO | Presigned PUT/GET; checksum verification on finalize; SSE at rest | Client-side encryption is a later hardening step. |
| OpenBao | `SecretReference` resolved by a `secrets` plugin at use time | Never store secrets in tables or skills. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| any module ↔ realtime | `appendEvent(tx, ...)` inside the caller's transaction; `publish` after commit | realtime never imports other modules' tables |
| chat ↔ agent | agent calls `chat.postMessage`/`chat.updateMessage`; chat calls `agent.triggerRun` on message events | no shared tables |
| worksession ↔ device | worksession enqueues `runtime_commands` via `device.sendCommand`; device delivers ingested events to `worksession.ingestEvent` | device knows sockets, worksession knows sessions |
| worksession ↔ chat | `chat.postAgentCard(...)` and card updates | cards are message content blocks of kind `card` |
| api `ws/` ↔ realtime/device | thin transport adapters; auth via `identity` (client) or `device.verifyChallenge` (device) | ws-library types stop at this layer |
| Electron main ↔ daemon | NDJSON over local socket, token-authenticated | enrollment, project registration, health, local preview only |
| daemon ↔ Control Plane | Device Link protocol (`packages/protocol`): `hello`, `heartbeat`, `resume`, `event`, `command`, `ack` | outbound only; signed challenge auth |

---

## 7. Suggested Build Order (MVP1 + MVP2)

Each step is an end-to-end vertical slice where possible (PROJECT.md: vertical MVP phasing). Arrows show hard dependencies.

```
0  Foundation ──────────────────────────────────────────────────────────────┐
   monorepo · packages/contracts · packages/db (migrations, RLS harness,   │
   withTenant, tenant-isolation test) · api skeleton + module loader       │
   + dependency-cruiser · OTel · docker compose (pg, redis, minio, openbao)│
                                                                            ▼
1  Identity + Organization ─────────────────────────────────────────────────┐
   auth (self-hosted, per STACK.md) · orgs · org_units(ltree) · memberships│
   · roles · resolveEffectivePermissions · audit module · admin CRUD UI    │
                                                                            ▼
2  Realtime core ───────────────────────────────────────────────────────────┐
   /ws gateway with auth · subscriptions · streams/stream_events + seq ·   │
   Redis fan-out · replay/resync · presence · notification inbox topic     │
                                                                            ▼
3  Chat (first usable product) ────────────────────────────────────────────┐
   channels · threads (side panel) · DMs/groups · messages · reactions ·   │
   mentions → notifications · basic attachments (artifact module, browser  │
   upload) · web UI                                                         │
                                                                            ▼
4  AI chats ───────────────────────────────────────────────────────────────┐
   4a direct AI chat: agent module, ModelProvider, model_runs, streaming   │
   4b multiplayer: roster/attribution prompt assembly, debounce, queue/    │
      interrupt, grants-based sharing (user → team), agents in channels/DMs │
      (mention-triggered), agent cards   ── Scenario B (except WZ creation) │
   4c docker compose up end-to-end · MVP1 acceptance                        │
                                                                            ▼
5  Device + Project (MVP2 foundation) ─────────────────────────────────────┐
   devices · enrollment · Ed25519 challenge auth · /runtime/ws gateway ·   │
   heartbeat/online · runtime_commands + ack · projects · repositories ·   │
   project_devices (registration without absolute paths)                   │
                                                                            ▼
6  Local Runtime daemon (parallel with 5 against packages/protocol) ──────┐
   apps/runtime skeleton · state dir · local control socket · device link  │
   client (hello/heartbeat/resume/offline buffer) · AgentRuntime interface │
   · ClaudeCodeRuntime (Agent SDK) · CodexRuntime (app-server) · Git       │
   adapter · containment · adapter conformance tests (recorded fixtures)   │
                                                                            ▼
7  WorkSession core ───────────────────────────────────────────────────────┐
   entities · state machine · permission matrix · event ingestion into     │
   session streams · prompt queue + arbiter (queue/steer/interrupt,        │
   reorder/edit/remove/run-next/priority) · approvals round-trip ·         │
   git state + changed files · diff on demand                              │
                                                                            ▼
8  Electron app ───────────────────────────────────────────────────────────┐
   shell loading the web bundle · daemon supervisor · enrollment UI ·      │
   project registration (native picker) · Work Zone UI (conversation,     │
   queue, changes, files, people, activity) · web read-only Work Zone      │
                                                                            ▼
9  Artifacts from sessions + Chat → Work Zone ────────────────────────────┐
   daemon artifact pipeline (containment → policy → SHA-256 → checks →     │
   presigned upload → finalize) · downloads with audit · create-from-chat  │
   dialog · agent card lifecycle · Scenario A (minus mobile approval) ·    │
   Scenario B complete · MVP2 acceptance                                    │
```

**Ordering rationale**

- 1 before everything: every table needs `organization_id` and every route needs `assertCan`; retrofitting RLS and permission checks is the most expensive rework in this system.
- 2 before 3: chat without replayable realtime is a prototype, not the product; building the cursor/seq machinery first means messages, AI runs and session events share one path.
- 4a before 4b: the streaming run loop and `ModelProvider` are needed before attribution and arbitration make sense; 4b is where the core value ("AI sessions are multiplayer") is proven, so it must be finished before MVP2 starts.
- 5 and 6 in parallel: the daemon can be built against `packages/protocol` with a fake server, and the device gateway against a fake daemon; they meet in 7. Adapter conformance tests using recorded Claude/Codex fixtures are the cheapest insurance against runtime drift (PRD §109.1).
- 7 before 8: the Work Zone UI should render a session that already works from `curl`; UI-first here would hide arbiter bugs behind optimistic rendering.
- 9 last: artifacts and chat→WZ creation are integrations across everything else and are what the acceptance scenarios exercise.

**Phases that will need deeper research when planned:** 1 (self-hosted auth choice; SCIM later), 4b (prompt-assembly evaluation across providers, debounce tuning), 6 (Agent SDK bundling inside a packaged daemon, Codex app-server version pinning, Windows named pipes), 8 (Electron packaging/signing/auto-update, daemon lifecycle on each OS). Phases 2, 3, 5, 7 follow well-known patterns.

---

## Sources

Confidence tiers are from `classify-confidence` (official docs fetched directly rank MEDIUM in this environment because they were not cross-verified by a second provider; PRD/ADR facts are HIGH as project constraints).

- PRD v1.0 `docs/prd/PRD.md` Parts II–V, IX, X, XII; ADR-0002, ADR-0003 (HIGH: project constraints)
- Claude Agent SDK TypeScript reference — https://code.claude.com/docs/en/agent-sdk/typescript (MEDIUM, fetched 2026-09-10)
- Claude Agent SDK streaming input — https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode (MEDIUM, fetched 2026-09-10)
- Claude Agent SDK approvals and user input (`canUseTool` contract) — https://code.claude.com/docs/en/agent-sdk/user-input (MEDIUM, fetched 2026-09-10)
- Claude Code headless / `claude -p` stream-json — https://code.claude.com/docs/en/headless (MEDIUM, fetched 2026-09-10)
- Codex App Server protocol — https://learn.chatgpt.com/docs/app-server.md (redirect of developers.openai.com/codex/app-server) (MEDIUM, fetched 2026-09-10)
- Codex `exec --json` event cheatsheet — https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/ (LOW, community)
- @fastify/websocket README and npm metadata (v11.3.0, ws 8, Fastify 5) — https://github.com/fastify/fastify-websocket , https://registry.npmjs.org/@fastify/websocket/latest (MEDIUM)
- Drizzle ORM RLS — https://orm.drizzle.team/docs/rls (MEDIUM)
- Postgres RLS multi-tenant production patterns (SET LOCAL, non-owner role, leading tenant index) — https://theroadtoenterprise.com/blog/postgres-rls-multi-tenant-saas , https://queryplane.com/blog/postgres-row-level-security-in-practice/ , https://patotski.com/blog/postgres-row-level-security-multi-tenant/ (LOW, community; consistent across sources)
- Redis pub/sub semantics and fan-out with WebSockets — https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis , https://oneuptime.com/blog/post/2026-03-31-redis-fan-out-pattern/view (LOW, community)
- Electron `utilityProcess` — https://www.electronjs.org/docs/latest/api/utility-process (MEDIUM); `safeStorage` not available in utility processes — https://github.com/electron/electron/issues/42869 (LOW); persistent daemon behind Electron — https://superset.sh/blog/terminal-daemon-deep-dive (LOW)
- Multi-user chat assistant research: MUCA — https://arxiv.org/html/2401.04883v4 ; HUMA — https://arxiv.org/html/2511.17315 (LOW for design guidance; used only for the "label every speaker / don't answer every message" conclusions)
- Anthropic Messages API constraints (turn alternation, mid-conversation system messages, prompt caching) — bundled claude-api reference (MEDIUM)

---
*Architecture research for: Open Collaborative AI Workspace (MVP1 + MVP2)*
*Researched: 2026-09-10*
