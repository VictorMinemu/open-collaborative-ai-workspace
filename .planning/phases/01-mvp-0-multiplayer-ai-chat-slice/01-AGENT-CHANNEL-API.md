# Agent Channel API v1 — contract (MVP 0)

The only surface the OpenClaw channel plugin (`apps/openclaw-channel`) talks to (AGENTS principle 9).
Canonical Zod types: `packages/contracts/src/agent-channel.ts` (import them; do not copy). Implementation:
`apps/api/src/modules/agent-channel/`. Test double that speaks it: `e2e/support/fake-cell-plugin.ts`.
Shapes follow `01-RESEARCH.md` Addendum A §A2; everything beyond the addendum is additive.

## Model

- **Cell** = one OpenClaw gateway serving one organization. MVP 0: `cellId == organizationId`.
- **Cell stream** `cell:<cellId>` reuses the realtime `stream_events` table: per-stream monotonic `seq`,
  replay from PostgreSQL, live fan-out through Redis. Browsers can never subscribe to `cell:` topics.
- One plugin account per cell; the plugin picks the OpenClaw agent per event (`route.agentId = event.agent.id`,
  session key `…:thread:<thread.rootMessageId>`).

## Auth

Every request (HTTP and the WebSocket upgrade): `Authorization: Bearer <cell token>`. 401
`{"error":{"code":"invalid_cell_token"}}` otherwise (throttled audit `agent_channel.auth_failed`, result `denied`).
The WebSocket upgrade is refused with 403 when an `Origin` header is present (browsers).

| Token source | How | Rotation |
| --- | --- | --- |
| `OCW_CELL_TOKEN` / `OCW_CELL_TOKEN_FILE` (API env) | Operator bootstrap. `pnpm setup:env` writes it to `.env`; compose passes the same value to `api` and `openclaw`. Compared in constant time; bound to the instance's organization (first org). 503 `setup_required` before `/setup` has run. | Change the env var on both services and restart. |
| UI token | Settings › Bots runtime → "Generate token" (`POST /api/v1/agent-cell/token`, admin). Shown once; only SHA-256 stored in `app.agent_credentials` (kind `channel_plugin`, `agent_id` null). | Generating a new one revokes the previous UI token. The env token is unaffected. |

The token authorises acting as any bot of its cell and nothing else; it never opens `/api/v1/*`.

## Endpoints (`/agent-channel/v1`)

### `GET /cell` → `CellSnapshot`

Fetched on start, on reconnect and on every `cell.config.changed`. `cache-control: no-store`. Audited as
`agent_cell.config_read` (which provider ids were delivered, never keys).

```jsonc
{
  "protocolVersion": 1,
  "cellId": "0199…org", "organizationId": "0199…org",
  "topic": "cell:0199…org",
  "lastSeq": 42,                       // sub with this to go live without replay
  "agents": [{
    "id": "0199…agt", "handle": "archie", "displayName": "Archie",
    "avatarUrl": "🏛️", "description": "Architecture reviewer",
    "instructions": "You review architecture decisions…",
    "status": "provisioning",          // provisioning | ready | error | disabled — provision all but disabled
    "modelRef": "anthropic/claude-sonnet-5-5",
    "model": { "provider": "anthropic", "providerId": "anthropic", "id": "claude-sonnet-5-5" },
    "updatedAt": "2026-10-02T18:00:00.000Z"
  }],
  "providers": [{
    "id": "anthropic",                 // OpenClaw models.providers.<id>; prefix of modelRef
    "kind": "anthropic",
    "api": "anthropic-messages",       // or "openai-completions"
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-…",              // decrypted on demand; see "Provider keys" below
    "models": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"]
  }, {
    "id": "fake", "kind": "mock", "api": "openai-completions",
    "baseUrl": "http://fake-model:18999/v1", "apiKey": "mock-key-not-secret", "models": ["mock-1"]
  }]
}
```

Provider id ↔ kind: `anthropic`→`anthropic`, `openai`→`openai`, `openrouter`→`openrouter`,
`openai-compatible`→`openai-compatible`, `mock`→`fake` (only when the API runs with `OCW_MODEL_PROVIDER=mock`).
Deleted bots are omitted (the reconciler removes OpenClaw agent entries it no longer sees).

### `GET /ws` (WebSocket)

Plugin → server frames (`AgentChannelClientFrame`):

```jsonc
{ "op": "sub", "topic": "cell:<cellId>", "afterSeq": 41 }   // replay seq > 41, then live, exactly once per seq
{ "op": "sub", "topic": "cell:<cellId>" }                  // NO afterSeq = start live (no replay, by design)
{ "op": "ping" }
```

Server → plugin frames (same envelope as the browser socket):

```jsonc
{ "op": "ev", "topic": "cell:<cellId>", "seq": 42, "type": "agent.mention.v1", "data": { …event, "seq": 42 } }
{ "op": "subscribed", "topic": "cell:<cellId>", "lastSeq": 42 }
{ "op": "resync", "topic": "cell:<cellId>" }   // gap > 500 events: refetch GET /cell, sub with its lastSeq
{ "op": "err", "code": "forbidden" | "bad_frame" | "subscribe_failed", "topic"?: "…", "message"?: "…" }
{ "op": "pong" }
```

- `data.seq` always equals the frame `seq` (the plugin's cursor; persist it in the plugin state store).
- Subscribing to any topic other than the token's own `cell:<cellId>` → `err forbidden`.
- The server pings every 20 s at protocol level and terminates silent sockets. Connection state drives the
  "Bots runtime" presence (Redis, shared across API instances; ephemeral `cell.presence` on `org:<id>`).

#### Event `agent.mention.v1` (`AgentMentionEvent`)

Appended **in the same transaction** as the human message, one event per mentioned bot that is live, not
disabled and a member of the conversation (or its parent channel). Only human-authored mentions are delivered
(no agent ↔ agent loops). Identity is server-resolved from the org directory, never from message text.

```jsonc
{
  "eventId": "0199…", "seq": 42, "type": "agent.mention.v1",
  "organizationId": "0199…org", "cellId": "0199…org",
  "agent": { "id": "0199…agt", "handle": "archie", "displayName": "Archie" },
  "conversation": { "id": "0199…chan", "kind": "channel", "name": "architecture" },
  "thread": { "rootMessageId": "0199…root" },   // = message.id when posted at channel level
  "message": {
    "id": "0199…msg", "text": "@archie what do you think?", "createdAt": "2026-10-02T18:01:00.000Z",
    "author": { "kind": "user", "id": "0199…victor", "displayName": "Víctor Ruiz" },
    "mentions": [{ "kind": "agent", "id": "0199…agt" }]
  },
  "threadHistory": [                              // oldest first, max 50, EXCLUDES the current message
    { "id": "0199…root", "author": { "kind": "user", "id": "0199…victor", "displayName": "Víctor Ruiz" }, "text": "Should we split the API?", "createdAt": "…" },
    { "id": "0199…r1",   "author": { "kind": "user", "id": "0199…alex",   "displayName": "Alex" },        "text": "I think not yet.",        "createdAt": "…" }
  ],
  "roster": [
    { "kind": "user", "id": "0199…victor", "displayName": "Víctor Ruiz", "role": "owner" },
    { "kind": "user", "id": "0199…alex", "displayName": "Alex", "role": "member" },
    { "kind": "agent", "id": "0199…agt", "displayName": "Archie", "handle": "archie" }
  ]
}
```

Plugin mapping (A2.4): `message.author.id/displayName` → `SenderId/SenderName`; `roster` → `GroupMembers`;
`threadHistory` → `chat_window` (`relation: "before_current_message"`, sender `"<displayName> <id>"`);
`thread.rootMessageId` → `MessageThreadId`; `WasMentioned = ExplicitlyMentionedBot = true`.

#### Event `cell.config.changed` (`CellConfigChangedEvent`)

```jsonc
{ "type": "cell.config.changed", "organizationId": "…", "cellId": "…", "seq": 43,
  "reason": "agent.created" | "agent.updated" | "agent.disabled" | "agent.enabled" | "agent.deleted" | "providers.updated",
  "agentId": "0199…agt" | null }
```

A hint: refetch `GET /cell` and reconcile (write `agents.entries.<id>` / `models.providers.<id>` only on diff),
then ack each provisioned bot with `POST /agents/:id/status`.

### `POST /messages` (`AgentChannelPostMessage` → `AgentChannelPostMessageResponse`)

```jsonc
// request
{ "agentId": "0199…agt", "conversationId": "0199…chan",
  "threadRootMessageId": "0199…root",          // from event.thread.rootMessageId (null = top level)
  "inReplyToMessageId": "0199…msg",            // from event.message.id: attribution to the triggering human
  "text": "Asked by Víctor Ruiz…",             // markdown, 1..20000 chars
  "idempotencyKey": "evt:<eventId>" }          // 1..200 chars
// 200
{ "messageId": "0199…", "created": true, "conversationId": "0199…chan", "threadRootMessageId": "0199…root" }
```

- **Idempotent** on `(agentId, idempotencyKey)`: a retry returns the original `messageId` with `created: false`
  (at-least-once delivery is safe). Recommended key: `evt:<eventId>`.
- Checks: bot exists in this cell (404 `agent_not_found`), not disabled (403 `agent_disabled`), member of the
  conversation or its parent channel (403 `not_a_member`), thread root belongs to the conversation (400
  `invalid_thread_root`; a reply id is normalised to its root). 503 `chat_unavailable` if chat is not wired.
- Stored through `core.chatAgent.postAgentMessage` (chat owns messages): `author_kind = 'agent'`, realtime
  fan-out on `conv:<id>`. Chat audits `agent.message.posted` in the same transaction (`actor_kind = 'agent'`,
  `agent_id`); agent-channel opens that transaction with the triggering human (author of `inReplyToMessageId`)
  as tenant user, so the row's `user_id` = who asked.

### `POST /typing` (`AgentChannelTyping` → `{ ok: true }`)

`{ "agentId", "conversationId", "threadRootMessageId"?: id|null, "typing"?: true }`. `typing: true` calls chat's
`agentTyping` (ephemeral `agent.typing` on `conv:<id>`); `false` is accepted and is a no-op: clients clear the
indicator when the agent's message arrives or after 12 s. Same membership checks as `/messages`.

### `POST /agents/:id/status` (`AgentChannelStatusReport` → `Agent`)

`{ "status": "ready" | "error", "detail"?: "model not found" }` (detail ≤ 500 chars, shown to admins, never
secrets). Ignored for disabled bots (returns them unchanged). Emits `agent.updated` on `org:<id>` (live
status chip) and audits `agent.status_changed` (actor `system`, source `openclaw_cell`).

### Subscription sign-in (additive, 2026-10-04, ADR-0006)

Lets bots use the customer's own **ChatGPT subscription through Codex** (`openai-codex`). The device-code
sign-in runs **inside the cell** with OpenClaw's own login flow; the tokens stay in OpenClaw's auth store on
the cell volume and OpenClaw refreshes them. The API never receives a token. Older plugins ignore the new
event types and the new snapshot field.

Cell events on `cell:<cellId>` (durable, same transaction as the audit row):

```jsonc
{ "type": "provider.auth.start",  "flowId": "0199…", "provider": "openai-codex", "method": "device-code",
  "startBefore": "2026-10-04T16:00:00.000Z" }      // ignore when seen later (replay after downtime)
{ "type": "provider.auth.cancel", "flowId": "0199…", "provider": "openai-codex" }
{ "type": "provider.auth.revoke", "provider": "openai-codex" }   // admin disconnected: delete stored sign-in
```

`POST /provider-auth` (`AgentChannelProviderAuthReport` → `{ ok: true }`):

```jsonc
{ "provider": "openai-codex", "flowId": "0199…", "reporterId": "cell-<uuid>",
  "state": "pending", "verificationUrl": "https://auth.openai.com/codex/device",
  "userCode": "E18P-OYM9T", "expiresAt": "…" }                           // the only place the code travels
{ …, "state": "connected", "account": { "email": "owner@acme.com", "planType": "pro" } }
{ …, "state": "error", "error": { "code": "expired" | "denied" | "unsupported" | "failed", "message": "…" } }
{ "provider": "openai-codex", "flowId": null, "reporterId": "…", "state": "disconnected" }  // credentials lost
{ "provider": "openai-codex", "flowId": null, "reporterId": "…", "state": "connected", "account": {…} } // identity refresh
```

- The first `reporterId` that reports on a flow owns it; others get 409 `flow_claimed` and must abort.
  409 `unknown_flow` / `flow_closed` likewise stop the attempt.
- Flow state (code included) lives in Redis with a TTL (code ≤ 15 min, finished flows 10 min). A flow with no
  `pending` report after 45 s reads as `cell_offline`; an unapproved code past `expiresAt` reads as `expired`.
- `connected` upserts `model_providers` (`openai-codex`, no secret, `account` = identity only), audits
  `model_provider.connected` with the admin who started the flow as `user_id`, and emits
  `cell.config.changed {reason: "providers.updated"}`. `error` audits `model_provider.connect_failed`.
  `disconnected` flags `account.needsReconnect` and audits `model_provider.credentials_lost`.
- Browsers get only `provider.auth.updated {provider, state}` (ephemeral, `org:<id>`); admins read the code
  from `GET /api/v1/model-providers/openai-codex/auth`.

`GET /cell` adds `subscriptions` (absent on older APIs):

```jsonc
"subscriptions": [{ "id": "openai-codex", "kind": "openai-codex", "runtimeProvider": "openai",
                    "models": ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna"],
                    "account": { "email": "owner@acme.com" } }]
```

Bots on a subscription carry `modelRef: "openai-codex/<model>"`. The plugin maps it to OpenClaw's
`openai/<model>` and pins `agents.entries.<bot>.models["openai/<model>"].agentRuntime.id = "openclaw"` (the
embedded runtime, never the native Codex harness). A bot whose subscription the cell holds no sign-in for is
acked `error` ("…not signed in on the bot runtime…"). When an OpenAI API key is configured too, the plugin
writes that provider as `ocw-openai` (OpenClaw keeps ChatGPT sign-ins and OpenAI keys under one id).

Admin endpoints (cookie session, `/api/v1`, owner/admin only, `cache-control: no-store`):
`GET /model-providers/openai-codex/auth` → `ProviderAuthStatus` · `POST …/auth {restart?}` → start (409
`cell_offline` without a connected cell; idempotent while a flow is active) · `DELETE …/auth` → cancel ·
`DELETE /model-providers/openai-codex` → disconnect (audited `model_provider.disconnected`, emits
`provider.auth.revoke`). `POST /model-providers` edits only `allowedModels` / `enabled` of a connected
subscription and rejects keys (400 `subscription_provider`, 409 `not_connected`).

### Not implemented (by design)

`POST /acks`: the plugin keeps its own cursor (Addendum A2.1 "pick one"). DMs, attachments, cards, approvals
and proactive messages are deferred (A2.1).

## Bot status machine

`provisioning` (created, re-enabled, or name/handle/instructions/model/description edited) → `ready` | `error`
(only via the cell's status report) · any → `disabled` (admin) · `disabled` → `provisioning` (admin re-enables)
· delete = soft delete (`deleted_at`; leaves every channel; old messages keep the author).

## Provider keys (trade-off, owner decision)

Admins enter provider keys in Settings › Models. They are stored AES-256-GCM encrypted (`OCW_ENCRYPTION_KEY`,
AAD = org id) in `app.secrets` and never returned by `/api/v1` (only `hasKey` + last 4 chars). The cell needs
the real key to call the model, so `GET /cell` decrypts on demand and returns it **only** over this
bearer-authenticated channel, `no-store`, never logged (Fastify logs no bodies; `authorization` is redacted;
an integration test scans every `/api/v1` body, every log line, audit metadata and stream payloads for the key).
Consequences: whoever holds the cell token can read the org's provider keys (the cell token is therefore as
sensitive as the keys); the key lives in OpenClaw's memory/config. The plugin should write it through an
OpenClaw secret ref (env/store) rather than plaintext config where possible. Phase 2 replaces the static cell
token with short-lived credentials behind the same `authenticateCell` seam.

## Environment

| Var | Where | Purpose |
| --- | --- | --- |
| `OCW_CELL_TOKEN` (`_FILE`) | api + openclaw | Bootstrap cell token (≥ 32 chars). `pnpm setup:env` generates it. |
| `OCW_MODEL_PROVIDER` | api | `mock` → offers `fake/mock-1` to bots and sends the `fake` provider to the cell. Set by `compose.e2e.yaml`. |
| `OCW_MOCK_MODEL_BASE_URL` | api | Fake model URL as seen from openclaw (default `http://fake-model:18999/v1`). |
| `OCW_API_URL` (plugin side) | openclaw | e.g. `http://api:4000` (internal network). |

## Admin endpoints (cookie session, `/api/v1`)

`GET /agent-cell` (admin) → `AgentCellStatus { cellId, connected, connections, connectedAt, lastSeenAt,
envTokenConfigured, uiTokenCreatedAt }` · `POST /agent-cell/token` (admin) → `{ token, createdAt }` (once).
Bots and providers: `GET/POST /model-providers`, `DELETE /model-providers/:provider`, `GET /models`,
`GET/POST /agents`, `GET/PATCH/DELETE /agents/:id`. Add to channel is chat's `POST /channels/:id/members
{kind:'agent', id}`.

## Differences from Addendum A (all additive or clarifying)

1. `cellId = organizationId`; no `agent_cells` table in MVP 0.
2. `sub` without `afterSeq` starts live (the browser socket replays from 0); `data.seq` is injected per frame.
3. `GET /cell` adds `instructions`, `avatarUrl`, `description`, `model`, `providers` (keys) and `protocolVersion`.
4. `POST /agents/:id/status` and `POST /typing` added; `POST /acks` not implemented.
5. Roster entries carry `role` (users) / `handle` (agents) as optional fields.
6. `agent.message.posted` is audited by chat inside the message transaction (only when `created`); the triggering
   human is carried as the tenant user of that transaction.
7. Chat auto-adds a mentioned bot to the channel (audited by chat) before emitting the mention, so "member of
   the conversation" holds for every delivered mention.
