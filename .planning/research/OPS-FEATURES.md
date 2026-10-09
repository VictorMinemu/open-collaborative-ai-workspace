# Operations features research (2026-10-08)

Source: owner meeting of 2026-10-06 (Plaud recording "Proyecto Inline, arquitectura de agentes IA y gestión de
expedientes"), turned into 17 generic features, researched by five parallel agents against `main` at `4644fcd` and
reviewed by the orchestrator (key code claims spot-checked). Research only; nothing here is built yet.

**Cross-cutting conclusion.** OCW owns memory, credentials, automations and approvals in the Control Plane. OpenClaw's
native equivalents (file memory, cron, webhooks, `sessions_send`, exec approvals, per-requester MCP OAuth) run inside
the cell, bypass our API, RLS, resolver and audit, and conflict with principles 6, 9 and 12. The cell keeps them off:
memory slot `none`, `read/write/edit/ls` denied, `group:automation|sessions|messaging` denied, heartbeat `0m`
(`infra/openclaw/render-config.mjs:37-66,179,208-214`). The working pattern is: an `ocw_*` plugin tool → Agent Channel
API decides (resolver, agent ∩ human, taint) and audits → Agent Card when a human must approve.

Facts every plan relies on:
- Every tool call already passes `before_tool_call` → `POST /tool-calls` (fail-closed, 10 s timeout), re-decided with
  live policy, per-turn limits and taint, audited `bot.tool_call` (`apps/openclaw-channel/src/tool-guard.ts:162,254-291,349-363`,
  `apps/api/src/modules/agent-channel/tool-calls.ts:140-237`). **Only `query`/`url` params travel** (`tool-guard.ts:97-103`).
- The API knows the requester of a turn (`agent_turns.user_id`, `packages/db/src/schema/app.ts:612-632`); the resolver
  supports "agent acting for a human" (`apps/api/src/modules/organization/permissions/facts.ts:6-10`).
- A card decision is delivered to the agent as a new turn (`apps/api/src/modules/agent-channel/cards.ts:110-114`); there
  is no server-side "apply on approve" hook yet.
- Bots only post in reply to a human (`cards.ts:50-80`); agent mentions never reach the cell (`agent-channel/mentions.ts:78-79`).
- Per-member sealed tokens with serialized refresh and `needs_reconnect` exist for the ChatGPT plan (ADR-0017,
  `apps/api/src/modules/secrets/index.ts:30-45`, `model-gateway/chatgpt-plan/credentials.ts`).
- `ai_usage_records.kind` allows only `chat|title` (`app.ts:1311,1331`).

## Shared building blocks (plan them once, reuse)
1. **Approve-and-apply**: an approval card whose decision the *server* applies, with a one-use grant bound to a hash of
   the exact action (tool + canonical params). Consumers: memory promotion (F5), per-tool approval (F10), Work Zone
   dispatch (F11), watched-record writes (F13).
2. **Full arguments in the tool gate**, only for tools with an approval policy (consumers F10, previews).
3. **Postgres job scheduler** (pg-boss or graphile-worker, MIT; ADR-0003 defers Temporal; today only `setInterval`
   sweepers, `apps/api/src/modules/ai-chat/sweeper.ts:100`). Consumers F6, F8, F9, F13.
4. **API-side connector proxy with per-member credentials** (F1) — also the clean path for boards fed by an ERP (F12/F13).
5. **`ocw_*` plugin tools** decided and audited in the API (existing pattern, `apps/openclaw-channel/src/memory-tool.ts`,
   `card-tool.ts`).

## A. Identity and credentials
**F1 Per-member connections (MCP/ERP/CRM).** Connector auth modes `org_secret` (today) | `per_member_oauth` |
`per_member_secret`. Members connect in Settings; tokens sealed with AAD `<org>:<user>:connector:<id>` (reuse ADR-0017
sealing/refresh). A plugin tool calls `POST /agent-channel/v1/connectors/:id/call` with the turn's `eventId`; the API
resolves the requester, opens *their* token, calls the remote MCP with `Authorization: Bearer`, audits in
`agent_tool_calls`. Not connected → "connect your account" card. MCP authorization spec allows one client holding
per-user grants (PKCE S256, RFC 8707 `resource`, CIMD replacing DCR) —
https://modelcontextprotocol.io/specification/latest/basic/authorization ; Claude/Open WebUI do this server-side
(https://claude.com/docs/connectors/building/authentication, https://docs.openwebui.com/features/extensibility/mcp). The
callback lands on the API, which removes ADR-0011's public-origin blocker. Rejected: OpenClaw `oauth.identity:
"per-requester"` (tokens in the cell's SQLite, needs `gateway.publicOrigin`, single-use bearer links, no per-user
revoke — https://docs.openclaw.ai/gateway/config-extensions). Today MCP servers are gateway-global with static `${ENV}`
headers (`infra/openclaw/render-config.mjs:201-203`, `apps/openclaw-channel/src/reconciler.ts:107-124,396-411`).
Results fetched with one member's account are visible to every reader of a shared chat → default to DMs (ADR-0019
audience rule). Conditions: legacy systems without OAuth use `per_member_secret`; CIMD needs a public HTTPS URL per
install (else pre-registered client); ID-JAG enterprise auth unconfirmed.

**F2 Agent keychain.** `vault_items` (scope personal | unit/org with resolver grants; kind api_key | basic | oauth |
browser_session; host allowlist). The agent sees only a handle; the API injects the header only to allowlisted hosts
(e.g. `ocw_http_request(secretHandle, url…)`); audit `secret.used` (agent, human, host, result; never the value).
Storage via `SecretReference` (`db`/`openbao`, `apps/api/src/lib/secret-store.ts:9-13`). Prior art: Arcade, Composio,
1Password agentic autofill, Bitwarden Agent Access SDK. Not viable: "a command that injects the secret" (no `exec`).
Browser-popup login needs a separate hardened browser cell: remote browser streamed to the user + sealed Playwright
`storageState` (safest) vs Electron cookie export (infostealer pattern, MITRE T1539; breaks with DBSC device-bound
sessions; some ToS forbid automation). Recommendation: OAuth and keys first; browser sessions last resort, later phase.

**F3 Agent templates.** Versioned `agent_templates` (unit scope; instructions, model, capability toggles, granted
tools, required connectors). Instantiating creates a personal bot with `template_id/template_version`; memory is already
per bot × human (`app.ts:694-709`); credentials via F1; policy caps applied per turn (ADR-0010). Cheap: each OCW bot is
already its own OpenClaw agent (`reconciler.ts:189-214`). Open: fork vs linked layer on template updates; fit with the
3-personal-bot cap (ADR-0010); alternative "one shared bot acting per requester".

## B. Memory (owner requirement: a folder/subfolder file viewer of `.md` files where bots keep their memory)
OpenClaw memory = Markdown in a per-agent workspace (`MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md`), `memory_search`
/`memory_get` (SQLite FTS5 + vectors), "dreaming" consolidation; all **off** in our cell; demo workspaces exist and are
empty. OCW memory today = 500-char notes per (bot, human) in `agent_memories`, DM-only, rejected when the turn read
untrusted content, never readable by admins (`app.ts:694-711`, `apps/api/src/modules/bot-capabilities/memory.ts:9-15`,
ADR-0010:90-95). SDK extension points exist (`registerMemoryCapability`, `registerMemoryCorpusSupplement`), untested.

**F4 Scoped memory as files + viewer.** OCW owns memory as **virtual `.md` files in Postgres**: `memory_files`
(scope_kind personal|agent|project|team|org, repo-style relative path, content, version) + append-only
`memory_file_revisions`; each scope has `MEMORY.md` and free subfolders (`topics/people/INDEX.md`, `jobs/`…); folders
derive from paths. Bot access through `ocw_memory_list/read/propose` (pattern of `ocw_memory_save`). Why not the cell's
files: single-container volume, no RLS/audit/history, would reopen `read/write`. Viewer: react-arborist tree (MIT,
virtualized, ARIA — https://www.npmjs.com/package/react-arborist), read via the existing `<Markdown variant="document">`
(`apps/web/components/markdown/markdown.tsx:301`, no raw HTML), edit with CodeMirror 6 over Markdown source, history and
diffs with `@codemirror/merge` (unified view on mobile), optimistic `version`. Desktop: tree | file | history; 390 px:
full-screen tree → file screen with View/Edit/History tabs + breadcrumb. Read-only panel of the agent's skills and
capabilities (`bot-capabilities/capabilities.ts:90`). FTS search like chat (ADR-0016). Not yet: semantic search
(`postgres:18` image has no pgvector, `compose.yaml:23`; no embeddings in the gateway). Migrating existing notes into
personal files must keep "admins never read them".

**F5 Explicit promotion to shared memory.** Permissions `memory.read|write|promote` decided by
`resolveEffectivePermissions` on the scope's unit (ADR-0007); a bot acting for a human gets agent ∩ human. Per-folder
rules: `permission_rules` already has `scopeUnitId`, subject and allow/deny (`app.ts:120-140`); add a path prefix
(deny wins). Agents never write shared scopes directly: they create a `memory_proposal` (diff, target path, detector
findings) → approval Agent Card (kind exists, ADR-0020) → unit leads decide → **the API applies** the revision (building
block 1). Detector: (1) TypeScript regex/checksums — secrets (reuse `redact()` patterns, `apps/local-runtime/src/sanitize.ts:84`),
IBAN, cards (Luhn), NIF/NIE, email, phone — free; (2) Presidio as optional compose profile (MIT; `ES_NIF`, `ES_NIE`,
`ES_PASSPORT`, spaCy NER — https://github.com/microsoft/presidio); (3) model classifier (salaries, health, evaluations)
via model-gateway, only on promotions, metered. Secrets always blocked; other findings highlighted in the card with the
reader count ("14 people will see this"); never auto-approved. Salaries are not a Presidio entity → custom recognizer or
classifier. Presidio's own "no guarantee" caveat; Spanish accuracy unmeasured.

**F6 Work done outside chat → memory.** Work Zone events are already stored and sanitized (`work-session/service.ts:230,1017`,
`stream_events`). On `completed|archived` (`app.ts:1062-1072`) a server-side summary (model-gateway) becomes a proposal
in project memory through F5. Attachments' text via the artifact module, same path. Engines: Supermemory **does not fit**
(local mode "one machine, one process, one API key", organizations need Enterprise —
https://supermemory.ai/docs/self-hosting/local-vs-enterprise; violates principle 10); mem0 (Apache-2.0, LLM per write),
Graphiti (Apache-2.0, needs Neo4j/FalkorDB), Zep CE deprecated, Letta overlaps OpenClaw → recommended: Markdown in
Postgres + FTS, pgvector later. Conditions: mapping Work Zone repository → project unit (none today,
`app.ts:1022-1040`); who pays the summary (proposal: session owner); no meeting source (import as documents).

## C. Agents and automation
**F7 Agent-to-agent with permissions.** `ocw_consult_agent(targetAgentId, question)` through the API, delivered as
`agent.mention.v1` with `origin {agentId, chainId, depth}`; reply returns as a new turn (like card decisions, ADR-0020 §6).
Effective permission = source agent ∩ triggering human ∩ target visibility (`bot.read`/unit agent) ∩ new `agent.message`
rules (deny wins) → PRD §80 `can_message` matrix. Each exchange is a visible thread message (PRD §79) audited with
`chainId`. Loop guards: depth ≤ 2, no agent twice per chain, per-chain hop budget, counts against each bot's
`dailyLimit` (`packages/contracts/src/bot-capabilities.ts:40`); the asker pays (ADR-0019). Rejected: OpenClaw
`sessions_send`/`sessions_spawn` (in-cell, bypasses the API, agent-to-agent on by default —
https://docs.openclaw.ai/concepts/session-tool). Meeting: deferred.

**F8 Personal digest.** A per-user scheduled automation (timezone): deterministic OCW query (cards awaiting my decision,
followed cards, unread mentions, Work Zone sessions awaiting approval/finished, new artifacts) → optional LLM summary by
the personal bot → DM. Customer reminders are drafts going through F10. Teammates'/customer data needs CRM/mail via
approved MCP (ADR-0011). LLM summary is metered.

**F9 Scheduled and event automations.** `Automation` entity in the Control Plane: standing order + trigger + delivery
target (stable IDs) + human it runs for + budget (PRD §73-75). Scheduler = building block 3. On fire, the API delivers
a turn to the cell like a mention; extend `/messages` for proactive posts to the target. NL creation (§74) via the
existing `automation` card kind + human confirmation. Triggers: signed webhooks (Standard Webhooks, HMAC-SHA256,
secret in SecretStore); mail via ImapFlow (MIT now; older versions AGPL — verify) or inbound SMTP (smtp-server +
postal-mime). Inbound content is untrusted → read-only turn by the taint rule (`tool-calls.ts:173-198`). Not
recommended: OpenClaw cron/webhooks/Gmail Pub/Sub (state in the cell, bypasses audit). Gmail push needs a GCP project,
public endpoint and 7-day `watch` renewal → optional. WhatsApp Cloud API is **paid per message** and its terms forbid
general-purpose AI assistants (own customer service allowed) → owner decision. n8n (SUL forbids letting users configure
flows "through your product") and Windmill (no wrapping as a managed service; CE ≤ 50 users) excluded; Activepieces
(MIT outside `ee/`) only as an optional MCP source; Temporal only for multi-step flows later. Build the core ourselves.
(License reading is ours, not legal advice.)

**F10 Per-tool approval before external actions.** Policy per tool (`approval: never | always | when_tainted`,
approvers) decided in `POST /tool-calls`; the gate sends full arguments only for tools with a policy (building block 2);
the API answers `approval_required`, posts an `approval` card showing the exact action (recipient, amount, body) and the
gate blocks the call; on approve, the audited decision returns as a new turn carrying a **one-use grant bound to a hash
of tool + canonical params** (any change → deny); approval may lift taint for that single call. OpenClaw
`requireApproval` exists in current docs (https://docs.openclaw.ai/plugins/hooks/tool-policy) but is not declared in our
2026.9.7 typings (`apps/openclaw-channel/src/openclaw-sdk.d.ts:107-111`) and resolves via `/approve`, outside our cards;
our hook's 10 s timeout cannot wait for a human.

**F11 Bot → Work Zone.** `ocw_start_work_zone(projectId, deviceId, prompt)` posts a `work_zone` card in "proposed"
state; the triggering human (with `work_session.create` + `device.use`) presses Start and the session is created in
their name (`apps/api/src/modules/work-session/routes.ts:309-327`); the bot is the prompt author "on behalf of". Fits
Phase 12 (live card) and ADR-0012 shared devices; the device's logged-in subscription pays. Risks: never dispatch from a
tainted turn, never `fullAccess` without a human, budget. Auto-start without a click needs Phases 8 and 10.

## D. Structured work (highest interest in the meeting)
**F12 Board channels.** Keep `conversations.kind='channel'` and add `layout: 'text'|'board'` (a new kind would touch ~35
`kind === "channel"` sites; resolver reads `["channel","dm","group"]`, `apps/api/src/modules/chat/access.ts:27`; search
`SEARCH_KINDS`, `search/index.ts:38`) → inherits slug, members, permissions, sidebar per unit (`app.ts:223`), search.
Tables `board_columns` (name, rank, category backlog|started|done|cancelled, optional `external_state_id`) and
`board_cards` (PK `message_id` like `message_cards` `app.ts:1519`; column_id, `rank text`, `waiting_on`
none|us|customer|both, external_ref, version). **A card is the root message of a normal thread**
(`messages.threadId`, `app.ts:292`); the agent answers there with existing `delivery:"thread"`
(`chat/index.ts:428,482`); message body = plain-text summary (Agent Card trick, `app.ts:1515`) so `search_tsv` works.
RLS automatic for `organization_id` tables (`packages/db/sql/post-migrate.sql:33-52`) + cross-tenant test. Durable
realtime events `board.card_upserted`, `board.columns_updated` (`packages/contracts/src/realtime.ts:130`) on the `conv:`
stream with seq/cursor replay. Web: clicking a card opens the existing `thread-panel.tsx`; create-channel dialog
(`apps/web/components/chat/create-channel-dialog.tsx:134`) gets text/board (no voice). DnD: `@dnd-kit` (MIT, keyboard +
ARIA; core 6.3.1 stable but no release since 12/2024; `@dnd-kit/react` 0.5 pre-1.0); pragmatic-drag-and-drop rejected
(no keyboard drag); always a "Move to…" menu; 390 px = column tabs + "Move to…". Order with fractional indexing
(`fractional-indexing`, CC0) + server re-rank on collision (Figma pattern); LexoRank rebalancing unnecessary at ~10–12
cards/day/team. Prior art: Slack Lists (item = thread; board = group-by), Linear/Plane (free columns over fixed
categories). Focalboard/Mattermost Boards community-only since 2023-09-15 — do not base on it. **Size: medium (~6–8
plans)**; columns synced from an ERP via MCP make it large → separate phase (API has no MCP client; MCP calls leave the
cell, ADR-0011; the agent can read phases with its MCP tool and publish them through a new Agent Channel endpoint, or
use the F1 connector proxy). Sync rules: ERP owns phase and record data, OCW owns conversation, in-column order and
`waiting_on`; compare-and-set (If-Match style); idempotency keys per transition (like `messages_author_client_msg_uq`,
`app.ts:308`); dedupe inbound webhooks by stable `event_id`.

**F13 Watched records.** `watched_records` (card, mcp_server, external_ref, snapshot of the template's watched fields,
`snapshot_hash` = sha256 over RFC 8785 canonical JSON computed by the API, `last_written_hash`, `checked_at`).
Check-on-access: when someone writes in the thread the agent re-reads the record; changed and not by us → a thread
message with an Agent Card of fields before → after (`message_cards.fields`, PATCH with version,
`agent-channel/cards.ts:35`). Agent changes are also noted back in the ERP with an audit event. Background checks wait
for the scheduler. External content is untrusted (taint, `agent-channel/memories.ts:24`). Depends on the ERP MCP
exposing a version/`updated_at` and a note-writing tool.

**F14 Templates and naming.** `record_templates` per unit: typed fields (Zod), default columns with category and
initial `waiting_on`, naming rule (`{prefix}-{seq:0000} · {customer} · {summary}`) with a per-board counter. Project
templates create the `kind='project'` unit (`app.ts:77`), its board and channels. Reuse `TitleSource` user|heuristic|auto
(`packages/contracts/src/session-title.ts:11`); a user-typed title is never replaced (`ai-chat/titles.ts:26-37`). Model
only fills `{summary}`; who pays for card titles is a product decision (AI chats: owner, `titles.ts:29`).

## E. Organization
**F15 Modules per team/department/person.** The resolver already expresses it with deny rules (unit or user scope;
deny beats any grant incl. admin role — `apps/api/src/modules/organization/permissions/resolve.ts:175-262`; rule shape
`packages/contracts/src/permissions.ts:271-293`). Build: a module catalog in contracts (`workzone → work_session.*` +
explicit device-use grains, not `device.*` which includes admin `device.revoke`; `ai_chat → ai_chat.*`; `bots →
bot.read, bot.create_personal, …`), a Settings panel that creates/deletes those rules (today rules UI is read-only,
`apps/web/components/settings/unit-rules-card.tsx:19`), hide "AI chats" with `useCan("ai_chat.use")` (today rendered
unconditionally, `chat-sidebar.tsx:430`, API already 403s). UI already hides Bots/Work Zone from `/me/permissions`
(`apps/web/components/shell/nav.ts:24-31`), refreshes on `permissionRulesUpdated`, realtime re-decides subscriptions
(ADR-0009), audit exists (`permission_rule.created/deleted`, `authz.denied`). No feature flags (would duplicate the
resolver). Phase 8 Work Zone grains must join the same prefix.

**F16 Organization groups.** Step 1: multi-org per user with a switcher (better-auth `organization.setActive`,
`session.activeOrganizationId`, unlimited orgs by default — https://www.better-auth.com/docs/plugins/organization) + our
own switch endpoint (none in the allowlist, `identity/routes.ts:10-17`) + `WorkspaceSwitcher` list
(`workspace-switcher.tsx:56-71`). Step 2: `org_group` + a reporting service running one query **per org under
`withTenant(org)`** and aggregating in the app; aggregates only, `group.report` required in every org. Never a
BYPASSRLS role or multi-org policies (`post-migrate.sql:44-48`, `rls-isolation.int.test.ts`). Blockers: single-org
assumptions (`identity/service.ts:139-160`, `auth.ts:154-171`, `authenticate.ts:55-66`, cell token bound to the instance
org) → identity/tenancy change needing plan mode and an ADR. Federation (PRD §91-92) solves a different problem.

**F17 Model comparison per task.** Generalize the opt-in, confirm-gated, dry-run-first `eval:multiplayer` runner
(`apps/api/src/eval/multiplayer/run.ts:13-33`) to suites per task (text, code, image reading) using `orgLanguageModel`
(never strings). Needs `kind='eval'` in `ai_usage_records` (and nullable `conversationId`), measured (not heuristic)
vision (`model-gateway/registry.ts:80-96`). promptfoo (MIT, owned by OpenAI since 2026; server has no auth) and
inspect-ai (MIT) only as local developer tools. Metered: dry-run and caps mandatory.

## Limits
OpenClaw facts come from current docs and the docs inside the 2026.9.7 image, not runtime tests. Unconfirmed:
`requireApproval` in our version; OpenClaw `per-requester` details; `memory_search` over our store. No OAuth flow, ERP or
ERP MCP tested; Presidio Spanish accuracy and summary costs unmeasured. License readings (n8n, Windmill, ImapFlow change)
are not legal advice. WhatsApp per-country prices and EU regulatory status not checked.
