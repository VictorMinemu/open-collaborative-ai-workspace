# ADR-0028: Automations run on a PostgreSQL job queue; inbound content is read-only; watched records hash in the API

## Status

Status: Accepted. **Date:** 2026-11-02. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.6-19) from the owner's decisions C-01 … C-05 and D-01 … D-13 in
`.planning/phases/07.6-automations-and-watched-records/07.6-CONTEXT.md` (D-10 … D-13 from the 2026-10-30 revision
against main after 07.8 … 07.12), the planner decisions P-01 … P-22 in `07.6-01-PLAN.md`, and the decisions taken
while the phase ran (the 07.6 SUMMARYs, plans 01 … 24). The number was reserved by D-07 and kept by D-13: ADR-0027 is
07.7's, 0029 … 0033 belong to 07.8 … 07.12.

**Supersedes in part, without editing it:** [ADR-0003](0003-infrastructure-baseline.md) deferred Temporal "until
scheduled automations, retries and idempotent delivery are implemented" and allowed "a PostgreSQL-backed job table"
until then. This ADR is the new ADR that trigger asked for: the job runtime is **pg-boss inside PostgreSQL**, and
Temporal stays deferred until the platform needs multi-step durable workflows (§ Deferred). NATS JetStream stays
deferred as ADR-0003 says.

**Builds on, none edited:** [0007](0007-roles-hierarchy-and-permission-resolver.md) (the resolver decides every grain),
[0010](0010-personal-bots-capability-model-and-tool-gate.md) and [0011](0011-openclaw-marketplace-trust-model-and-mcp.md) (what a cell may run;
`isDangerousToolName`), [0018](0018-ai-chat-run-loop-and-model-gateway.md) (model calls only through the gateway and
`buildModelMessages`), [0019](0019-multiplayer-ai-chats.md) (the asker pays), [0020](0020-agent-personas-and-agent-cards.md)
(Agent Cards through the Agent Channel API), [0022](0022-board-channels-and-record-templates.md) (boards as targets),
[0023](0023-scoped-memory-files-and-approve-and-apply.md) (memory proposals and approve-and-apply),
[0025](0025-per-member-connectors-keychain-and-agent-templates.md) (connectors, Keychain, egress),
[0026](0026-per-tool-approvals-and-work-zone-proposals.md) (per-tool approvals, `canonicalJson`),
[0029](0029-bot-sandboxes-plugins-and-live-browser.md) (sandbox tools in unattended run turns, never the browser: D-12),
[0030](0030-shared-work-zone-projects-and-session-visibility.md) and
[0031](0031-work-zone-sidebar-and-per-viewer-session-fields.md) (Work Zone summaries go to the team project a repository
is linked to; session reads only through `app.work_session_access`; per-user delivery: D-10, D-11).

## Context

The PRD (§72 proactive messaging, §73 standing orders and automations, §74 natural-language creation, §75 delivery
targets) asks for agents that act without being asked: a weekly report, a reaction to an incoming webhook or mail, a
record someone else changed. `.planning/research/OPS-FEATURES.md` grouped the requests as F6 (Work Zone sessions feed
project memory), F8 (a personal digest), F9 (scheduled and event-driven automations) and F13 (watched external
records). OpenClaw has its own cron, webhooks and `sessions_send`; using them would schedule and receive outside the
Control Plane, bypass the resolver, the audit and the taint rules, and tie automations to a cell (C-01, principles 1,
6, 9, 12).

Three hard problems shaped the design: a scheduler that is safe with several API replicas and restarts without a new
service (principle 10); content from the outside world (a webhook body, a mail) that must never steer a bot into side
effects; and writes to an external system that must never overwrite a change someone else made since the bot read it.

## Decision

### 1. The job runtime: pg-boss 12 in PostgreSQL (D-01, D-07, D-09)

- **Library.** `pg-boss` 12.38.0 (MIT), pinned in `packages/db` and `apps/api`; `cron-parser` 5.10.2 for schedules.
  No new service: jobs live in the `pgboss` schema of the existing database.
- **Installed by the migrator.** `installJobSchema` runs in `runMigrations` as `ocw_migrator`: it creates or upgrades the
  `pgboss` schema, waits (bounded, 5 min) for pg-boss's async migrations, and creates every queue of the closed catalog
  `JOB_QUEUE_NAMES` (`automation.tick`, `automation.fire`, `automation.inbound`, `mailbox.tick`, `mailbox.poll`,
  `watched.tick`, `watched.check`, `work_session.summarize`, `maintenance.daily`). Standard queues only (a partitioned
  queue runs `CREATE TABLE` as its caller); completed jobs are kept two days.
- **The API never runs DDL.** It starts pg-boss as `ocw_app` with `migrate: false` and no reindex; at boot it reads the
  queues and refuses to start on a missing one with `JobsSchemaError` ("pg-boss schema missing or outdated: run the
  migrate service"). An event-trigger test proves no DDL is issued as `ocw_app`. Upgrades are the existing migrate step.
- **Ids-only jobs.** Each queue has a strict Zod payload of ids and closed enums (`{ organizationId, runId }` …).
  Handlers re-open `withTenant` for the job's organization and re-read by id; a row RLS hides is a no-op, so a forged
  cross-tenant job does nothing (tested). Handlers are idempotent (at-least-once delivery).
- **Transactional enqueue.** Jobs are sent inside the request's or worker's own transaction (`fromDrizzle(tx)`), so a
  rolled-back request leaves no job and a committed one always has its job.
- **Our own schedules.** Per-automation schedules and time zones live in RLS-protected `app.automations`, not in
  pg-boss. One global UTC tick per minute (`automation.tick`, evaluated once across replicas through pg-boss's cron
  claim) calls an ids-only `SECURITY DEFINER` function for due automations and enqueues their fires.
- **Replicas and shutdown.** Any number of API replicas may run workers (`OCW_JOBS_WORKER`, default `on`, `off` under
  `NODE_ENV=test`): pg-boss fetches with `SKIP LOCKED`, so each job runs once and each tick once per interval (two
  instances tested). `stop()` lets in-flight handlers finish (up to 8 s) before the pool closes; queued jobs stay for
  the next start. Jobs start in Fastify's `onReady` after every module registered its workers.
- **Existing sweepers stay on `setInterval`.** The AI chat sweeper, artifact cleanup and the other pre-07.6 loops are
  not migrated; only 07.6's work runs on the queue.

### 2. The automation (D-01, D-07, P-04; PRD §73-75)

- **Entity.** `app.automations` = a standing order (instructions) + a trigger (`schedule`, `webhook`, `mail`) + a target
  by stable ids (`channel`, `thread`, `dm`, `board` with a column: R2) + the bot + the run-as person + a budget
  (`max_runs_per_day`). Runs are `app.automation_runs` (`queued → delivered → answered`, or `skipped`, `failed`,
  `no_reply`), one per scheduled instant (unique), with their reason codes.
- **Run-as = creator.** A database `CHECK` ties `run_as_user_id` to `created_by`. An automation always acts as the person
  who made it: their access, their bot visibility, their budget. Nobody runs as someone else.
- **Managers pause and delete, never edit, resume or run.** `automation.manage` (admin surface, non-delegable) lists
  everyone's automations and may pause and delete them; editing, Resume and Run now are the run-as person's alone, and
  Resume also needs their live `automation.create` (P-04, D-09). The web shows managers no Resume (07.6-15).
- **Grains.** `automation.create` (default: every member), `automation.webhook` (leads and admins; delegable by an allow
  rule), `automation.manage` (admins), `record.watch`. Both new Bots-module grains join the Bots module catalog; a
  data-only migration (`20261030071644_bots_off_automation_backfill`) adds their deny rows to organizations, units and
  people that turned Bots off before 07.6, as 07.4's backfill did for its grains (ADR-0025's migration table precedent).
- **Targets are decided, not trusted.** `decideTarget` runs at create, update and every fire: the bot is live and
  readable by the creator, personal bots deliver only to their owner's DM, a channel target is a text channel both the
  creator and the bot may post in, a board target is a board channel and one of its columns, a thread root is a live
  top-level message. Every unreadable target answers the same `target_not_postable`, decided creator-first, so nothing
  about a conversation the creator cannot read leaks. A targeted board column cannot be deleted (409
  `board_column_has_automations`, the FK is `NO ACTION`).
- **Schedules and time zones.** A five-field cron in an IANA zone (engine aliases that resolve into the listed set
  are accepted, so `Asia/Kolkata` and `Asia/Calcutta` both save). DST (pinned with cron-parser 5.10.2): a wall time in
  a spring-forward gap runs one hour later that day (02:30 on 2026-03-29 in Madrid → 03:30 CEST); in a fall-back
  overlap it runs once, at the first occurrence. `L` is accepted alone in the day-of-month field ("Every month · Last
  day"). Day lists read as "Weekdays" when they are Monday to Friday. A schedule is too frequent when two of its next
  10 instants are closer than `min_schedule_minutes`.
- **Fire-time re-decision (`decideFire`).** At every fire the runner re-decides as the run-as person: automation active,
  person active with `automation.create`, bot live and readable, target postable with the bot as a member, then the
  daily budget. A refusal skips the run with its reason and posts nothing.
- **Late ticks.** `next_run_at = nextRunAfter(schedule, scheduledFor)`, and if that is still not after now,
  `nextRunAfter(schedule, now)`: one run for the oldest due instant (fired when at most 6 h old, skipped as `missed`
  otherwise), never a catch-up burst.
- **Runs per day** are counted at fire in the automation's zone (the local day start), excluding skipped runs;
  webhook and mail automations use UTC. Run now at the cap records a `skipped` run (`runs_per_day`) and enqueues
  nothing, still answering 202 with the run id so the history says why.
- **Breaker.** Three failing outcomes in a row pause the automation as `needs_attention` with the last reason in
  `paused_reason`. Failing outcomes: `failed`, `no_reply`, and skips that mean lost access and never heal on their own
  (`agent_not_member`, `target_not_postable`, `run_as_not_allowed`, `agent_disabled`, `bot_not_readable`,
  `delivery_failed`). Budget and timing skips (`runs_per_day`, `hourly_cap`, `missed`, `paused`, `nothing_new`) leave the
  streak; an answer resets it.
- **No reply.** A delivered run nobody answered within 15 minutes becomes `no_reply`; its card says so.
- **Limits** live in `app.bot_policies` per organization: 10 automations per person, a 15-minute minimum interval, 30
  inbound items per hour per automation, at most 96 runs a day per automation (schema ceiling 288). They have no
  Settings control yet (§ Deferred).
- **Editor version.** `PATCH` carries the version the editor loaded (`expectedVersion`); a stale one is 409 "This
  automation changed while you were editing. Reload it."

### 3. Proactive delivery through the Agent Channel (D-03, D-08, P-03)

- **The run anchor.** Each run posts a **platform-owned** `automation` card at the target (badge "Created by the
  workspace"; agents cannot `PATCH` it; only `updatePlatformCard` changes its status label and notices), then delivers
  `agent.automation_run.v1` to the bot's cell as the bot's turn **for the run-as person**. Delivery is the recorded run
  event; the run is `delivered` whether or not a cell answers.
- **The only new trigger.** D-08 (PR #25) made every Agent Channel post need a live turn. 07.6 adds exactly one allowed
  trigger, the run anchor: the bot's reply in the anchor's thread is posted on behalf of the run-as person (chat's
  confused-deputy check decides agent ∩ that person), marks the run `answered` in the same transaction and turns the
  card to Done. A reply to the anchor of a deleted automation is 409 `automation_inactive` (detected from the anchor's
  server-set key `run:<runId>` after the cascade).
- **Unattended run turns (D-12).** A run turn is unattended: it is offered 07.8's `ocw_sandbox_*` tools under the
  organization's sandbox switch, kill switch, resolver, bot switch, taint flags and the 40-calls-per-turn cap, and never
  an `ocw_browser_*` tool (sign-in and live control need the person). A forged browser call is `policy_changed`, the
  41st sandbox call `budget_exhausted`.
- **The cell keeps OpenClaw's own automation off.** The rendered cell config pins `cron.enabled=false` and
  `hooks.enabled=false` and keeps `group:automation` / `group:sessions` (incl. `sessions_send`) denied. The Control Plane
  is the only scheduler and the only webhook ingress (C-01).
- **Who pays.** The run-as person: the bot's daily limit and their model access apply (ADR-0019's "the asker pays").

### 4. Inbound content is untrusted and read-only (D-02, D-07)

- **The platform posts first.** A webhook payload or a mail becomes an `app.automation_events` row; the inbound worker
  (`automation.inbound`, as the run-as person) posts it deterministically before any model or tool call: a
  "Received" card in a thread, a DM, or a new board card with the item as its first reply (fenced full text, the amber
  "Outside content from …" notice first). Follow-ups thread by the mail's thread key (first `References` id, then
  `In-Reply-To`, then `Message-ID`) or a webhook payload pointer. Paused automations record the item `not_run`
  (`paused`), as do the hourly cap and lost access.
- **Taint at birth.** The run is inserted `tainted` and anchored on the inbound card; its turn starts tainted
  (`taintedAtStart`), and the item reaches the bot only in `automationRun.inbound`, a separate, capped, untrusted block
  (the cell renders it as `external`; the API's message is a server sentence). Side-effecting tools are refused on a
  tainted turn as in ADR-0026 (a per-call approval can still lift it).
- **Taint propagates.** A later turn starts tainted when anything it reads came from outside: the thread root, any
  message in its history window (flat DMs included), a board card filed from an event, or the anchor of a tainted run.
  This applies to a person's @mention too. No proposal (`ocw_automation_propose` refuses tainted turns with code
  `tainted`) and no record write without a matching approval come out of such a turn.
- **Retention.** `maintenance.daily` clears `subject`, `sender`, `body_text` and `body_json` of items older than 30 days
  together (`content_purged_at`); ids, counts and results stay for the deliveries list.

### 5. Signed webhooks (D-02, D-09)

- **Standard Webhooks** via `standardwebhooks` 1.1.1 (MIT). `POST /api/v1/hooks/:publicId` (26 Crockford base32
  characters), public, in its own Fastify scope, checks in order: the rate limit (60 a minute per URL) → body size (64
  KiB, 413) → the public id (malformed or unknown **404**; tombstoned or unlinked **410**, so a deleted endpoint tells
  its sender to stop) → signature and timestamp (±5 minutes, HMAC over the exact bytes, constant time, multi-signature
  `v1,` list; one fixed 401 body, the reason `signature` or `timestamp` recorded) → JSON payload → the event, idempotent
  on (`endpoint`, `webhook-id`): a repeat is 200 `duplicate` and only bumps a counter.
- **Secrets.** `whsec_…` shown once at create and at rotation, sealed with the endpoint's AAD. Rotation keeps **one**
  previous secret for 24 hours; a second rotation inside the grace retires the oldest at once.
- **Rate limits in Redis, everywhere.** `@fastify/rate-limit` takes one store per app, so every rate-limited route
  (identity's included, numbers unchanged) now counts in Redis and holds across replicas. A Redis failure **fails the
  request closed** (`skipOnError: false`), where the in-memory store never failed. Rejections are recorded at most once
  per endpoint and minute.
- **Logging.** No body, header value or secret reaches a log, an audit row, an error or a job; the scope's error
  handler logs only error codes (canary-tested).

### 6. IMAP mail with Keychain items only (D-02, R8)

- **Credentials.** A mailbox stores only a Keychain item id (07.4); there is no username or password field in its
  request, row or DTO. At save, every poll and the test route the API opens the item through `basicCredentialsFor`:
  the item is the person's own or a readable unit/organization item, of kind `basic` ("Username & password"), allowed
  `vault.use` by the resolver, and its allowed hosts name the configured `host:port` (a pattern without a port means
  993). App passwords are the supported path; IMAP OAuth is deferred.
- **Pinned TLS.** The client connects to the address the egress guard resolved and checked (`resolveEgressAddress`,
  sharing `egress.fetch`'s rules: public only, RFC 1918 only with an admin private-host entry), with implicit TLS,
  `servername` = the configured host, `rejectUnauthorized: true`, TLS 1.2+. Plain IMAP only for test host names, which
  production refuses.
- **Read-only.** `EXAMINE` (a read-only mailbox lock) and `BODY.PEEK`: mail stays unseen, nothing is moved or deleted.
  ImapFlow 2.9.1 (MIT) with its logger off; postal-mime 4.1.4 (MIT) parses a source capped at 256 KiB; text capped at
  32 768 characters; HTML converted to text by a linear scanner.
- **Idempotency and loops.** Keyed by `Message-ID` (or `uid:sha256(UIDVALIDITY:UID)` without one); a repeat only bumps
  `duplicate_count`; a `UIDVALIDITY` change re-baselines. Loop mail is skipped: our own `X-OCW-Automation-Run` header,
  the mailbox's own address, `Auto-Submitted` (RFC 3834) and `Precedence: bulk|junk|list`.
- **Polling.** `mailbox.tick` claims due mailboxes through `app.due_mailboxes` (5 … 60-minute intervals). The baseline
  (cursor = UIDNEXT − 1) runs after the save commits, never inside a transaction holding a connection. `auth_failed`
  backs off 30 minutes and is polled at once when its Keychain item changes. Failures are fixed codes (`auth_failed`,
  `key_not_usable`, `host_not_allowed`, `unreachable`, `folder_missing`, `certificate`, `unknown`); no server text is
  stored.

### 7. Natural-language creation (D-03, PRD §74)

- `ocw_automation_propose` (a built-in, side-effecting, never on tainted turns) is offered on untainted turns of a person
  with `automation.create` in their one-person DM with the bot or a channel they may post in; never in group DMs,
  shared DMs or AI chats. It stores a draft and posts an `automation` approval card (ADR-0023's approve-and-apply).
- **Decider rule.** Only the draft's run-as person (the person who asked) may decide, with live `automation.create` and a
  target that still passes `decideTarget`; nobody else sees the review (404) or may decide on the card (403).
- **Hash tuple.** The approval binds `[draft.id, agent_id, run_as_user_id, schedule_cron, time_zone, target_kind,
  conversation_id, thread_root_message_id, sha256(instructions), max_runs_per_day]`; a changed draft is 409
  `approval_action_changed`.
- **Created with changes.** Editing the draft in the automation editor (`?draft=<approvalId>`) saves through
  `ApprovalService.applyOwn`: the full create rules run on the person's edits, the request closes `applied` with
  `edited`, and the card reads "Created with changes". A draft that is no longer open shows "This proposal is no longer
  open". The card's Instructions are a full-width block and its kind row wraps.

### 8. Watched records (D-04, D-09, F13)

- **The hash is the API's.** `sha256` over 07.5's `canonicalJson` (RFC 8785; the codebase's one implementation, no
  `canonicalize` package) of the board template's watched fields, read through 07.4 connectors. The first check after a
  link or a fields edit is a silent baseline.
- **Checks.** On access (a person's reply, the thread opened when the last check is over a minute old, Check now; one
  minute per watch, the Check now cooldown per viewer) and on schedule (`watched.tick`, 15 min … 1 day, at most 500
  claims per tick). A change is reported in the card's thread as before → after (Detected time in UTC with the zone
  named).
- **Tool rule.** The read tool must be recorded read-only and not destructive; every tool a watch names must pass
  `isDangerousToolName` and be granted to the watch's bot; re-checked before every read, failing closed.
- **Whose credentials.** Org-secret connectors are read API-side with their admin-set headers (`orgSecretHeaders`, the
  one reveal point, used only as request headers of a guarded call). Per-member connectors read with the linker's own
  credential and need their active share on the board (`member_account`); a revoked share pauses silently.
- **The options route.** `GET /watched-records/options` (post rights + `record.watch` on the board) gives the dialog
  its connectors, tools and bots, since `/mcp-servers` is admin-only.
- **Compare-and-set writes.** `ocw_record_update` is offered only to the watch's own bot in its card's thread. Checks in
  order: the turn → the tool on the turn → the record is watched → only watched fields → connector, tools and the
  requester's own connection and share → caps → 07.5's `approvalForCall` (the approved arguments are `{record,
  connector, changes}`, so the record is in the hash, and the re-run repeats exactly them) → taint. Then, outside any
  transaction: re-read with the requester's connection → hash ≠ snapshot = conflict ("Not saved" card, nothing
  written) → `last_written_hash` set to the expected result while the snapshot is still the compared one (an access
  check racing the write stays silent) → write (with `expectedUpdatedAt` when the record exposes one; an ERP version
  refusal is a conflict too) → re-read → note-back in the external system when its tool exists (a failure never undoes
  the write).

### 9. The personal digest (D-05, F8)

- A digest is an automation (`action_kind = 'digest'`, run as its person, DM from a bot they can DM; personal bot
  preselected). Sections are re-checked at send time through each surface's own rule: approvals waiting for you, cards
  you follow, unread mentions, Work Zone sessions (only through `app.work_session_access` + `work_session.read`, D-11).
- **Since** = the last answered run (test sends included), else 24 hours. Skip-empty records `nothing_new` (neutral for
  the breaker). At most 5 runs a day, schedule and tests together.
- The optional summary is **off by default**, metered as `digest` usage for the person, escaped plain text (≤ 600
  characters) above the list; its model call runs inside the run's fire transaction with a 20 s deadline;
  `summary_skipped_limit` / `summary_failed` leave the run answered.

### 10. Work Zone sessions feed project memory (D-06 as revised by D-10, D-11; F6)

- **The project is 07.9's.** A session's unit is the team project its repository is linked to
  (`work_project_repos`); 07.6 adds no mapping table, normaliser, route or audit. An unlinked repository's strip sends
  people who may link (`work_project.manage` + `device.use`) to 07.9's flow.
- **Manual and opt-in automatic.** "Propose to memory" on a finished session, and an opt-in per-person setting, **off by
  default**. The owner pays: their default model's small model, their cap, one `session_summary` usage record per
  billed summary (a second summary of the same session gets its own subject).
- **A system proposal.** The summary becomes a 07.2 proposal with a new origin `{kind: "system", source:
  "work_session"}` requested for the owner, into the unit's shared scope at `work-zone/<date>-<slug>-<hex>.md`, with
  the 07.2 secret prescan and a pending cap per person; a lead applies it. The model call lives in
  `ai-chat/one-shot.ts` (the fourth `MODEL_CALLERS` door, ADR-0018 guard).
- **Per viewer.** Every read goes through `sessionFacts` + `work_session.read`; `canPropose`, `canMap` and `model` exist
  only on `GET /work-sessions/:id/memory`; `work_session_memory.updated` frames go to each reader's `user:` topic
  (ephemeral), never to `ws:` or `org:`.

### 11. Usage kinds

`digest` and `session_summary` join `chat` and `title` in `ai_usage_records`: they need a `subject_id` and no
`generation_id` (a database check), one row per (subject, kind).

### 12. Audit

Every mutation and every decision is audited with ids, counts and codes only — never instructions, schedules, payloads,
mail text, record values, field labels or external ids: `automation.created|updated|paused|resumed|deleted`,
`automation.run_started|run_delivered|run_answered|run_skipped|run_failed`, `automation.proposed|proposal_refused`,
`webhook.received`, `mailbox.created|updated|deleted|tested|poll_failed`, `mail.received`,
`watched_record.linked|updated|unlinked|previewed|changed|paused|check_failed|written|note_written|note_failed|write_refused`,
`digest.saved|sent`, `work_session.summary_proposed|summary_failed`, `work_memory.preferences_updated`, plus the 07.2
approval and memory events and `bot.tool_call`. A route-coverage guard and a canary sweep over every `pgboss` table
(`security.int.test.ts`) prove the rule.

## Consequences

- **What self-hosters run: nothing new.** `docker compose up` is enough; the migrate service installs `pgboss` with the
  rest. The release gate (`pnpm gate:compose --with-sandbox`) proves on the release images that migrate installs the
  schema, the API boots as `ocw_app`, an automation's Run now delivers its run card, and the `pgboss` schema survives
  the backup round trip. `docs/self-hosting/automations.md` is the operator's page; `OCW_JOBS_WORKER` is the one new knob.
- **Redis is now on the path of every rate-limited request.** If Redis is down, those routes refuse instead of letting
  requests through.
- **Limits and retention.** The caps of § 2, 64 KiB webhook bodies, 60 webhook calls a minute per URL, 30 inbound items
  an hour per automation, 30 days of inbound content, two days of finished jobs.
- **Model spend is opt-in** (digest summary, automatic session summaries) and always billed to the person who benefits.
- **Every new 07.6 route** must be added to `security.int.test.ts`'s route table; the security-sensitive paths are in
  `.github/CODEOWNERS`.

### Validation

Unit, web and integration tests (real PostgreSQL and Redis, GreenMail for IMAP, the fake ERP MCP, two pg-boss
instances), the isolated e2e on both Playwright projects with the real sandbox broker and GreenMail (every 07.6 spec and
the 07.1/07.8/07.9 regressions), the real-cell smoke (`automation`, `automation-tools`) and `pnpm gate:compose
--with-sandbox`; recorded in `07.6-VALIDATION.md`. **Owner check pending:** `docs/DEMO.md` › Automations and watched
records (a real mailbox with an app password and a real ERP MCP).

### Deferred

- From the phase brief: Gmail push, WhatsApp (paid per message, restricts AI assistants; owner decision), IMAP OAuth,
  inbound SMTP, attachments of inbound mail, an "adopt" flow for automations whose creator left, two-way sync of board
  columns with external records.
- Temporal: until multi-step durable workflows (human waits, compensation, long sagas) exist; NATS as ADR-0003.
- Found while building: a Settings control for the automation caps; the deliveries list cannot yet tell "not posted
  yet" from "posted and purged"; the mail run card's Source reads the automation's name, not the mailbox address;
  usage reports still detect titles by key suffix (digest and session-summary rows read "0 answers"); managers' lists
  refresh on focus, not live; `work_session_memory.updated` is ephemeral; `ocw_record_update` is not yet in the
  tool-approval editor's catalog (rules can be added through the API); `automation_events.board_card_message_id` has no
  index.
