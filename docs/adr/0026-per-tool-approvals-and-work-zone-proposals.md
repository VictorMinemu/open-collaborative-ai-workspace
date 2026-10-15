# ADR-0026: Per-tool approvals and Work Zone proposals

## Status

Accepted (owner decisions C-01 … C-05 and D-01 … D-05 in
`.planning/phases/07.5-per-tool-approvals-and-work-zone-proposals/07.5-CONTEXT.md`, D-04 being the accepted research
design; planner decisions P-01 … P-13 in `07.5-01-PLAN.md`; owner decision of 2026-10-13 on self-approval; recorded at
the phase gate, plan 07.5-15, with the decisions taken during execution and the real-cell observations).
**Date:** 2026-10-15. **Extends** [ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (the tool gate,
taint and the OpenClaw upgrade checklist), [ADR-0020](0020-agent-personas-and-agent-cards.md) (who a card-action turn
belongs to) and [ADR-0023](0023-scoped-memory-files-and-approve-and-apply.md) (the approve-and-apply primitive). None
of them is edited. Supersedes nothing.

## Context

Bots already act through `ocw_*` tools and admin-registered MCP servers, decided call by call by the Agent Channel
API's gate (ADR-0010) and limited by taint: after untrusted content, a turn may not take a side-effecting action. That
blocks the useful "read, then write" turn entirely, and it gives an organization no way to say "this one tool always
needs a person". Two needs came together (OPS F10, F11; APPROVE-01 … APPROVE-04):

1. **Per-tool approvals.** An organization decides, per tool, whether a bot's call needs a person first, and who that
   person is. The person must see exactly what will run, and their yes must allow exactly that call once.
2. **Work Zone proposals.** A bot may suggest a Work Zone session (project, device, prompt), but the session runs on a
   person's device under that person's name, so only that person may start it, and never from a turn that read outside
   content.

OpenClaw has approval features of its own (`requireApproval` on `before_tool_call`, exec approvals). They resolve
inside the cell, outside our cards, resolver and audit (C-01), so they stay unused.

## Decision

### Policies

- A rule is `(scope, tool pattern, mode, approvers)`: scope the organization or a unit; pattern an exact tool name or
  `<safe>__*` for a whole MCP server or connector; mode `never`, `always` or `when_tainted`; approvers `requester`,
  `unit_leads` (unit rules only), `admins` or up to 20 named `users`. Approvable tools are every MCP, plugin and connector
  tool and `ocw_http_request`; `ocw_*` built-ins and the web tools never are.
- Applicable rules are the organization's, the agent's unit subtree's and the human's units' subtrees'; the
  **strictest mode wins** (`always` > `when_tainted` > `never`). A unit rule may only add approvals: a unit rule weaker
  than an inherited one is refused (409 `policy_weaker_than_inherited`). Approvers come from the highest-scope rule
  carrying the effective mode. When an organization rule and a unit rule have the same mode, the upper (organization) rule's approvers win; a unit rule changes approvers only when it is stricter.
- `tool_approval.manage` (surface `team`) lets admins manage every scope and leads the units they lead, decided by the
  resolver; agents never hold it. Every change is audited (`tool_approval_policy.created|updated|deleted`) with ids and
  the rule's fields only, behind an `expectedVersion`. A unit that still has rules cannot be deleted (409
  `unit_has_policies`, like keys and templates): the cascade would drop the rules without their audit rows.

### The gate: one decision in three routes

- At delivery the API flags every offered tool with an effective rule (`turn.toolFlags[tool].approval`). **Only flagged
  tools send their full arguments** (≤ 32 KB) to the API; for every other tool the request body has no `arguments` key
  at all (structural, proven by a sentinel sweep and by the real cell).
- `approvalForCall()` decides in the same transaction in all three agent-action routes — `/tool-calls`,
  `/connectors/call` and `/http-requests` — after the connection, key and host checks and before any credential or
  outbound call, and never waits for a person: `none` (no rule, or `when_tainted` on a clean turn), `grant` (a usable
  grant for this exact action), `required` (one pending request with its card), or a refusal. A rule added or removed
  while a turn runs is `policy_changed` (no flag was delivered) or plain `none`.
- **Canonical JSON (RFC 8785)** is implemented in `packages/contracts` (no package: the two audited candidates were too
  new to trust, and the RFC vectors are small). Lone surrogates, NaN, ±Infinity, `undefined` and non-plain values are
  refused.
- **The grant is bound to the action, not to a turn.** Its hash is
  `actionHash("tool.call", [agentId, requestedForUserId, conversationId, tool, sha256(canonical arguments)])`. Changed
  values are a new request. Consequence (accepted): the asker's next ordinary turn in the same conversation, with the
  same tool and the same arguments, may use a grant approved for them; it is still used exactly once.
- **Lifetimes.** A request is pending 24 h; an approved grant is usable until `min(decided_at + 15 min, expires_at)`;
  the same action denied in the last 24 h is refused without a new card (`approval_denied`, naming the decider and
  quoting their note); at most 5 pending per (agent, requester); a retry with the same (event, toolCallId) returns the
  same request; a grant used within its window answers `approval_used` to a second identical call.
- **Consumption at dispatch.** The grant is consumed inside the claim transaction of the call it allows, and never given
  back on a later failure; with a rule in force the caps are checked first, so a grant is never spent on a call the cap
  would refuse. The grant lifts taint **for that one call only**.
- **A re-run never launders taint.** A request made from a tainted turn is stored with that taint, and its re-run turn
  starts tainted: the approved call runs, an unruled side-effecting call in the same turn is still refused.

### The cell

- Fixed sentences only reach the model (UI-SPEC copy): "This action needs approval…", pending, denied by {name} with
  the note, used, too large, invalid. Nothing of the API's error bodies.
- **The params pin.** Our `before_tool_call` gate runs at `TOOL_GATE_PRIORITY` (10 000); a second handler at
  `TOOL_PIN_PRIORITY` (−10 000) returns exactly the params the API checked for a flagged call. **Observed in OpenClaw
  2026.9.7** (07.5-15, the real-cell smoke runs OpenClaw's own hook runner with our gate and pin and three rewriting
  plugins; `hooks-*.mjs` `runBeforeToolCall`): handlers run highest priority first; each gets its own copy of the
  original event; the last returned `params` win and are then merged shallowly over the original params; a `block`
  stops the chain. So the pin holds against any plugin registered above −10 000 (proven: priorities 5 000, 0 and
  −9 999 all rewrote and lost). Two residuals are recorded, not fixed: a plugin registered **below** −10 000 rewrites
  after the pin and wins, and a plugin that answers OpenClaw's own `requireApproval` before the pin freezes its params.
  Both need trusted code in the cell; only `ocw`, `openai`, the bundled search plugins and admin-approved marketplace
  plugins (ADR-0011) ever load there.
- **The re-run belongs to the requester (extends ADR-0020).** For `grant` kinds the card-action turn is delivered for
  `requested_for_user_id` (`CardAction.turnUserId`): the asker's tools, credentials, daily limit and
  `agent_turns.user_id`; the decider is named in the sentence and in `cardAction.decidedBy`, and `cardAction.grant`
  carries `{tool, arguments, useBy}`. The plugin turns it into an "Approved action" block: call `tool` once with exactly
  these canonical arguments before `useBy`. If the requester no longer reads the conversation, no turn is delivered.
  `server_apply` kinds and plain cards keep the decider as the turn's human, and **no card-action turn is delivered to
  a human who does not read the card's conversation** (a decision taken from `/approvals`): it would be metered for a
  reply that is refused (WINDOWS #204). A connector grant names the logical `<safe>__<tool>`; the bot uses it through
  `ocw_connector_call` (proven in the real cell with the fake model following the block).
- OpenClaw's `requireApproval` and exec approvals stay unused.

### Who decides, and what each reader sees

- `canDecide` is decided live by the resolver on the rule in force now; a `users` rule whose people are all gone has
  no approver. **Self-approval follows the decision right** (ADR-0023 decision 15 as amended): a requester who holds the
  right decides their own request and the audit says `selfApproved`; one who does not reads "You can't approve your own
  request".
- **Card audience.** `exact` only in a DM whose single human is the requester (title, tool, source, every value).
  `review_only` when a value was cut at 500 characters or the arguments need more than 12 fields: no in-card Approve,
  and the server refuses an Approve from the card route (409 `review_required`); Deny stays. `summary` everywhere else:
  title, tool and source only, no value in the card, its message or its realtime events, and no in-card Approve.
  Approvers review the exact action at `/approvals/<id>`.
- **The `/approvals` inbox** lists `tool.call` and `work_zone.start` only, with its own badge; Memory's badge counts
  `memory.write` only, so the two never count the same request. Approvers learn through the badge and realtime, no bell
  notification kind (P-12).

### Work Zone proposals

- `ocw_work_zone_projects` and `ocw_start_work_zone(projectId, deviceId, prompt, runtime?)` are offered on a delivered
  turn whose human holds `work_session.create` (07.3's module deny removes them), and sit in every served bot's
  `alsoAllow` like `ocw_board_card` (each turn narrows). The body carries ids and the tool's fields only: **a mode, a
  model, full access or a user cannot be expressed** (closed schema, strict server body).
- The API runs a human start's checks for the turn's human, refuses tainted turns, slash-command prompts (trimmed),
  missing projects or devices, unshared devices, offline devices and unavailable runtimes without storing anything,
  caps pending proposals at 3 per (agent, requester), and posts a platform-owned `work_zone` card for kind
  `work_zone.start` (`server_apply`, 24 h). **Only the requester may Start**, live with `work_session.create`; Start
  runs `createWorkSession` as them in their decision transaction with no mode, so the session starts at `default`
  ("Supervised") and is only ever lowered, and its first prompt records `proposed_by_agent_id`. A failed Start is the
  request's result code, told to the bot (`cardAction.resultCode`). `work_zone_proposals.work_session_id` and the card
  message id leave Phase 12 its live card.
- The human route lowers too: `POST /work-sessions` without a picked mode starts at the highest mode the member may use
  (e.g. `plan` under a capped grant); a picked mode is never lowered, it is refused with its reason (WINDOWS #205).

### Storage, retention and lock order

- Three tables under forced RLS (`tool_approval_policies`, `tool_call_approvals`, `work_zone_proposals`); every
  reference is a composite foreign key with `organization_id`; the stored action and the proposal are immutable by
  trigger, and the app role may not truncate them. Arguments are stored only in
  `tool_call_approvals.arguments_canonical`, retained with the organization's data (no purge in 07.5), readable only by
  the deciders and the requester through the view; never in audit rows, logs, the ledger, realtime events or summary
  cards.
- **One stream lock order** for every transaction that fans out: the conversation, then `user:` streams in ascending
  id order, then the cell — what a message post does. A request locks its card's conversation and announced people up
  front; a `server_apply` decision locks the card's conversation and every `user:` stream its `apply` and `announce`
  will touch before `apply` runs (`ApprovalKind.applyTopics`, used by memory); notifications append in ascending
  recipient order (07.5-16, WINDOWS #222, #224). No retry on `40P01`: the order is the fix.

## Consequences

- An organization can require a person for exactly the tools it cares about, and the person sees and approves exactly
  one call; a bot can no longer be talked into changing the values between the yes and the run (hash at decision,
  re-check at claim, pin in the cell).
- "Read, then write" is possible again without lifting taint for a whole turn: the approved call runs; nothing else
  does.
- **The OpenClaw upgrade checklist (ADR-0010) gains:** re-run `SMOKE_ONLY=approval` on the new image and confirm that
  `PIN_HOLDS` still prints (handlers ordered by priority, isolated events, last params win), and record any change of
  the two residuals; confirm the Work Zone tools still reach the model through `alsoAllow` (`SMOKE_ONLY=work_zone`).
- A bot's next ordinary turn may use a grant approved for the same action (bound to the action, not to the turn).
- Approved grants that are never used keep a "running" card; the client derives "Not used" after `useBy`.
- An `ocw_http_request` URL normalised differently is a different action, so a new approval.

### Upgrade cost of the 07.5 migration

One forward-only migration, `20261014125609_tool_approvals`, runs in the one-shot `migrate` service of an upgrade:

| Change | Cost |
| --- | --- |
| Three new empty tables, their indexes and the two immutability triggers | Instant |
| `agent_tool_calls.approval_id`, `work_prompts.proposed_by_agent_id` (nullable, no default) | Catalog-only |
| Five `UNIQUE (organization_id, id[, device_id])` constraints on `agents`, `devices`, `org_units`, `projects`, `work_sessions` (composite foreign-key targets) | One index build per table under a `SHARE` lock (writes to that table wait). Measured on PostgreSQL 18 (Docker, 07.5-15): 195 ms for `(organization_id, id)` and 216 ms for `(organization_id, id, device_id)` on 1 000 000 rows (211 MB), warm cache. These tables hold hundreds to thousands of rows in practice |

`post-migrate.sql` adds `REVOKE TRUNCATE` on the two immutable tables; it is idempotent and instant. Rollback is a
restore (backup-restore.md); the migration header lists the manual statements.

### Validation

Unit, integration (real PostgreSQL and Redis, the phase cross-tenant matrix, races, a sentinel leak sweep, lock-order
deadlock tests), real-browser e2e at 1440 and 390 in light and dark, the real OpenClaw 2026.9.7 cell
(`SMOKE_ONLY=approval,work_zone`) and `pnpm gate:compose` on release images; recorded in `07.5-VALIDATION.md`. **Owner
check pending:** `docs/DEMO.md` › Per-tool approvals and Work Zone proposals.

### Deferred

- A purge of stored arguments after a retention period.
- Approval digests and bell notifications (07.6).
- Phase 12's live Work Zone card on top of the proposal card.
