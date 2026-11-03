# ADR-0027: Agents consult each other asynchronously through the Agent Channel, bounded by database guards

## Status

Status: Proposed. **Date:** 2026-11-02. **Deciders:** Víctor Ruiz (Autofy Labs). Written in plan 07.7-02 from the
owner's decisions C-01 … C-05 and D-01 … D-05 in `.planning/phases/07.7-agent-to-agent-collaboration/07.7-CONTEXT.md`,
the orchestrator's 2026-11-02 alignment with `main` 441a0561 (D-06 … D-16), the planner decisions P-01 … P-20 in
`07.7-01-PLAN.md` and `07.7-RESEARCH.md`, so every 07.7 executor reads the same design. It stays **Proposed** until
the phase gate (07.7-11) records what shipped and accepts it (D-16); an accepted ADR is never edited, so anything that
changes during the phase lands in the acceptance, not here. The number was reserved by 07.7 (ADR-0028 names it).

**Builds on, none edited:** [0007](0007-roles-hierarchy-and-permission-resolver.md) (the resolver decides every grain;
deny wins), [0010](0010-personal-bots-capability-model-and-tool-gate.md) and
[0011](0011-openclaw-marketplace-trust-model-and-mcp.md) (what a cell may run; `isDangerousToolName`; the tool gate),
[0019](0019-multiplayer-ai-chats.md) (the asker pays), [0020](0020-agent-personas-and-agent-cards.md) (agents act
through the Agent Channel API), [0024](0024-module-access-per-unit.md) (modules are catalog deny rules),
[0026](0026-per-tool-approvals-and-work-zone-proposals.md) (per-tool approvals; `ocw_` built-ins are never approvable),
[0028](0028-automations-and-job-scheduler.md) (the `core.jobs` runtime, proactive delivery, the self-validated tool
route, `taintedAtStart`), [0029](0029-bot-sandboxes-plugins-and-live-browser.md) (sandbox tools per turn, never the
browser in an unattended turn).

## Context

The PRD asks for agents that work together: §79 (`@backend … hand it over to @qa`, "full traceability must be
preserved") and §80 (control of Agent → Agent, with `can_message` / `cannot_message` lists). Today an agent can never
trigger another: delivery drops every mention whose author is not a human, reply mode `all` ignores agent-authored
messages, and an agent's own `@handles` are stored but never dispatched. That is the right base. Letting a model's
typed `@qa` wake another bot would turn any prompt injection into a delegation, and OpenClaw's in-cell
`sessions_send` / `tools.agentToAgent` would bypass the resolver, RLS, audit and taint (C-01, principles 6, 9, 12).

What is needed is a server-built consult: one agent asks another a question on behalf of the same human, the hop is a
visible thread message, the answer comes back as a new turn, permission is the intersection of everyone involved, and
loops, fan-out and cost are bounded by something stronger than API code.

## Decision

### 1. The consult is asynchronous and goes through the Agent Channel (D-01, D-07, D-08)

- The cell tool is `ocw_consult_agent(target, question, mode?)` (mode `consult` or `handoff`). It calls
  `POST /agent-channel/v1/consultations`, built like 07.6's `/automations/propose`: a strict body (event, agent,
  intent); tx0 finds the turn's human H; tx1 runs as H (`withTenant({organizationId, userId: H})`): `liveTurn`
  (404 `unknown_turn`), the tool on the turn (`not_in_turn`), `claimToolCall` (the per-turn cap of 8; always
  side-effecting, so a tainted turn is refused `tainted`; every refusal is recorded by the claim with its code), then
  the consult. Answers are `{ok, code?, sentence}` with a model-facing sentence the plugin relays, never an API error
  body. The tool returns at once; it never blocks a cell slot waiting for the other bot.
- The question is posted with `postAgentMessageIn` in the route's own transaction: author the asking bot, body
  `@<handle> <question>`, in the asking turn's thread, key `consult:<idempotencyKey>`. The chain upsert, the budget
  update and the hop insert run in the post's `onInserted` hook, so a message without its hop, or a hop without its
  message, never exists. A retry of the same key answers the stored hop.
- The target's turn is built with `buildMentionEvents` from a server-built `AgentMention` whose structural author is H
  (`author.kind = "user"`, `trigger: "consult"`), exactly as `deliverAutomationRun` and `emitCardAction` do; the event's
  `message.author` is then set to the asking bot and its `origin {agent, chainId, hopId, depth, mode, onBehalfOf}`, and
  it is appended as `agent.mention.v1`. Chat never emits an agent-authored mention: the refusal of non-human authors in
  mention delivery stays exactly as it is, and bot-authored `@mentions` stay inert (pinned by a regression test).
- The answer returns the same way, re-typed `agent.consult_reply.v1` (`consultReply {outcome, answerMessageId}`), as a
  new turn of the asking bot. A turn's end is signalled by the bridge (`POST /agent-channel/v1/turns/:eventId/done`,
  `replied` | `failed`), so a long or chunked reply and a turn that itself consulted someone are handled correctly: a
  turn that opened a pending consult never closes its own parent hop. The answer is the turn's first post
  (`agent_turns.reply_message_id`, recorded by the `/messages` and `/cards` hooks).
- Every hop is an ordinary, attributed thread message, searchable and visible to the thread's readers; each hop's
  status is chat side data (`Message.consult`) announced as `message.updated` (D-15). Audits (`agent.consult.requested`,
  `.refused`, `.answered`, `.failed`, `.timed_out`, `agent.chain.cancelled`) carry the chain and hop ids and message
  ids, never question or answer text.
- `handoff` creates the same hop and message but expects no reply; the target may continue the chain at depth + 1.
- A consult hop turn is an ordinary ledger turn, so the target's answer and the asker's reply are accepted by the
  existing trigger rule of PR #25 (a post names a live turn of the posting bot, and the human is that turn's) with no
  new trigger code (D-06).

### 2. One resolver decision on `agent.message` (D-02, D-04, D-14)

- A new grain `agent.message` (surface `bots`, delegable, held by every role, **not** in `AGENT_PERMISSIONS`). The
  decision is one resolver call: principal the source agent acting on behalf of H, resource the target agent, with the
  per-target object in the existing `tool` column as `agent:<uuid>`. The agent pass sees rules only (closed by default
  for agents); the human pass sees H's role grant, rules and target visibility through the `unit_agent` and
  personal-bot preconditions extended to `agent.message`. Effective permission = source agent ∩ H ∩ target visibility
  ∩ `agent.message` rules, deny wins (principle 6).
- The organization switch ("Bots may consult each other", Settings › Bot policy) is exactly one organization-scope
  rule `{everyone, agent.message, tool null, allow}`; **off by default**. Per-bot rules map PRD §80: outbound `any`
  (`{agent A, allow}`), `only` (`{agent A, allow, tool agent:<B>}` per B), `none` (`{agent A, deny}`), "never ask"
  (`{agent A, deny, tool agent:<B>}`), inbound off (`{everyone, deny, tool agent:<A>}`). Only admins edit them in v1
  (`rule.read` / `rule.manage`), through 07.3's rule writers (per-row audit, live `permission_rules.updated`).
- `agent.message` joins the Bots module's catalog patterns (10 after 07.6's 9), so Bots off also stops consults. A
  data-only migration (`*_bots_off_agent_message_backfill`, the rule of 07.6's `bots_off_automation_backfill`) adds the
  `agent.message` deny row, without author, tool or folder, next to every complete 9-pattern Bots-off set, idempotent;
  partial (custom) sets are untouched and no allow row is ever written.
- The decision is re-run at every hop with live rules: offering targets to a turn (`turn.consult.targets`, ≤ 20), the
  request, and each delivery.

### 3. Loop guards are database constraints (D-03, D-04, D-14)

`app.agent_chains` (one per root turn, `root_event_id` unique) and `app.agent_chain_hops` carry the guards, so racing
requests are decided by PostgreSQL, never by a read-then-write:

| Guard | Enforcement |
|---|---|
| depth ≤ 2 | `agent_chain_hops_depth_check` (1..2), `agent_chain_hops_parent_depth_check` (a parent exactly at depth 2), `agent_chain_hops_source_depth_check` (depth 1 is asked by the root), `agent_chain_hops_parent_fk` (a depth-2 hop is asked by the target of its parent, in the same chain, and that parent was asked by the chain's root, so it is at depth 1: a hop parented on a depth-2 hop fails the key) |
| no agent twice per chain | `agent_chain_hops_target_once` unique (chain, target); `agent_chain_hops_not_root` against the chain's real root (the hops' chain key carries `root_agent_id`); `agent_chain_hops_not_self` |
| hop budget 3 per chain | conditional `UPDATE … SET hops_used = hops_used + 1 WHERE status = 'active' AND hops_used < hop_budget`; `agent_chains_budget_check`. Every hop counts, refused ones too |
| one pending consult per source, per chain | partial unique `agent_chain_hops_one_pending` (chain, source) `WHERE status = 'pending'`. PRD §80 says "one open question per bot in each chain at a time": a bot taking part in several people's chains may have one open in each; its daily limit bounds the total (CR-B-02) |
| retries | `agent_chain_hops_idempotency` unique (source, key); `question_message_id` unique |
| daily limits | unchanged: every hop turn passes `turnPolicy` and counts against its own bot's `dailyLimit` |
| fan-out per turn | unchanged: the claim's cap of 8 tool calls per turn |

Every foreign key onto an organization-scoped table carries `organization_id` (FKs bypass RLS, so another
organization's id fails the key itself). `agent_turns` gains the chain context as plain ledger ids (`chain_id`,
`chain_depth` 0..2, `answering_hop_id`, `returning_hop_id`, `reply_message_id`; no FK, like `message_id`); every older
turn reads as outside any chain. Both tables get FORCE RLS and `tenant_isolation` from post-migrate's generic loop.

### 4. Timeouts on the job runtime (D-11)

A hop has a 5-minute deadline; opening a child bumps its parent to at least the child's deadline + 2 minutes. One
global `consult.tick` queue on `core.jobs` (in the migrator's `JOB_QUEUE_NAMES` and the API's `JOB_QUEUES`, empty
payload), cron `* * * * *` UTC, evaluated once across replicas, reads the ids-only SECURITY DEFINER
`app.expired_agent_chain_hops(p_limit, p_now)` and handles each hop in its own organization as the chain's human:
`pending → timed_out` (conditional), audit, and an `agent.consult_reply.v1` with `outcome: "timed_out"` and a server
sentence, so the asker can tell the person. No new `setInterval` sweeper (ADR-0028 keeps those only for loops that
predate it). A hop therefore times out between 5 and 6 minutes after it opened.

The chain's human or a channel moderator (`message.delete_any`) may Stop a chain: the chain and every pending hop
become `cancelled`, late answers still post (they are visible messages) but deliver nothing. A chain whose thread root
is deleted, or whose human no longer reads the channel, is cancelled `auto` lazily at request, return and sweep time.

### 5. Who pays, taint, approvals and sandboxes (D-09, D-10, D-12, D-13)

- **The root human pays every hop** (ADR-0019): every hop turn records `user_id = H` and decides its tools as agent ∩ H;
  for an automation root, H is the run-as person. Each turn meters its own bot's daily limit; cell bots run on
  organization models and providers; no member's personal plan is ever spent by a chain, and no `ai_usage_records`
  row is written.
- **Taint and member data flow forward** through 07.6's `taintedAtStart`: the asker's return turn starts with the
  target turn's taint (and its member data, like a 07.5 re-run); any turn in a thread holding inbound content is
  tainted as today. A turn that starts tainted is never offered the consult tool, and the claim refuses it anyway.
- **07.5 approvals break the chain.** `ocw_consult_agent` can never carry an approval policy (`isApprovableTool`
  refuses every `ocw_` built-in outside `APPROVABLE_BUILTINS`). A hop turn that needs an approval ends normally ("I
  need Víctor's approval…"), which answers the hop; the card-action turn that follows a decision carries no chain
  context. Card-action turns may open a chain of their own as its root.
- **Hop turns are unattended** (`trigger: "consult"`): never an `ocw_browser_*` tool, so no bot drives a browser or asks
  a person to sign in for a request they did not address to it; `ocw_sandbox_*` tools are decided per hop turn exactly
  as for a direct mention (40 calls per turn each). Otherwise a hop turn gets what a direct mention of that bot by H in
  that thread would get: a chain never widens H's rights.
- **Automations may consult** under every chain rule: a schedule or Run-now run turn in a channel that does not start
  tainted is offered the tool; webhook and mail runs start tainted and never are. The run's `answered` / `no_reply`
  state follows only the bot's own reply in the anchor's thread.

### 6. OpenClaw's in-cell agent-to-agent stays off (D-02, D-04)

The cell renders `tools.agentToAgent.enabled = false` and `tools.sessions.visibility = "self"` (2026.9.7 defaults the
first to `true`), keeps `group:sessions` denied and the `minimal` profile, and `isDangerousToolName` also refuses the
`conversations_` and `agents_` prefixes and `subagents`. The real-cell smoke proves the cell boots with both keys; if
it refuses one, the phase stops and reports instead of dropping the pin.

### 7. v1 scope (D-04)

Channels only (board channels and threads included); no DMs, group DMs or AI chats; personal bots neither consult nor
are consulted; the target must already be a member of the channel (no auto-add); only admins edit consult rules; the
consult tool is not offered to reply-mode turns or at depth 2.

## Consequences

- Agent-to-agent collaboration works without opening any in-cell channel between bots: every hop goes through the
  resolver, RLS, the claim, taint and audit, and is a visible message with full traceability (PRD §79).
- Agents carry no unit paths, so a unit-scoped rule cannot say "the agents **of** unit X may not consult"; that is
  expressed per source agent (rules on the target's unit do work, through the resource path). Deny always wins, so a
  per-bot `only` list cannot narrow below the organization switch while it is on; the settings UI says so and shows a
  server-computed "Right now" summary.
- **Channel audience caveat:** a hop's answer is computed with H's rights and posted in the thread, so it is visible
  to the thread's readers, the same as a direct mention of that bot by H today. A chain does not widen this, and v1
  keeps consults out of DMs and AI chats where audiences differ.
- There is no in-flight abort: Stop prevents new consults and return turns, but a model call already running in the
  cell finishes. Timeouts land within a minute after the deadline (the tick's resolution).
- Turning Bots off keeps reading `off` after the catalog change because of the backfill; a set an admin edited by hand
  reads `custom` as before.
- The two new tables and five ledger columns are additive; every existing row keeps its value.

### Deferred

Consults in DMs, group DMs and AI chats (a "side thread" design); personal bots as askers or targets; lead-edited
consult rules for their units' personas (07.3's `unit.modules.manage` pattern); "Meeting" (several agents in one live
session, OPS-FEATURES F7); Agent → External Agent (federation, PRD §80); aborting a turn already running in the cell
(`agent.turn.cancel.v1`).
