# ADR-0039: Automations open one conversation per new item, bots move the cards they opened, and people and bots mention teams

## Status

Status: Accepted. **Date:** 2026-11-10. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.17-03), before any behaviour lands, from the owner's request of 2026-11-09 and decisions D-01 … D-18 in
`.planning/phases/07.17-automation-fan-out-and-team-mentions/07.17-CONTEXT.md` (D-10 … D-18 are the addendum that
resolved the research's open questions; D-17 changed the research default to avoid a regression), the planner
decisions PD-04 … PD-17 and PD-26 in `07.17-01-PLAN.md`, and the research in `07.17-RESEARCH.md`. The owner's
full-autonomy grant makes CONTEXT's locked decisions the acceptance. One point comes from the storage plan already
built (07.17-02): unit handles are capped at 40 characters and filled by a `BEFORE INSERT` trigger (§ 9).

**Supersedes, without editing them:** the clauses of [ADR-0028](0028-automations-and-job-scheduler.md),
[ADR-0022](0022-board-channels-and-record-templates.md) and [ADR-0038](0038-bot-work-zone-orchestration.md) quoted
verbatim below, each only as far as the "What replaces it" column says. **Completes** ADR-0038 § 9 (D-12). Everything
else in those records stays exactly as written.

**Builds on:** [ADR-0020](0020-agent-personas-and-agent-cards.md) (agents act only through the Agent Channel API,
platform-owned cards), [ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md) (taint and per-call grants),
[ADR-0027](0027-agent-to-agent-consultations.md) (restated unchanged: bot-typed mentions never deliver to bots),
[ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md) (unattended turns get no browser tools) and ADR-0038 (the
bot's Work Zone profile, `actOnOutsideContent`, the session-output mark).

### Superseded clauses

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "**Limits** live in `app.bot_policies` per organization: 10 automations per person, a 15-minute minimum interval, 30 inbound items per hour per automation, at most 96 runs a day per automation (schema ceiling 288)." | ADR-0028, § 2 | A 5-minute minimum interval and at most 288 runs a day per automation, as the organization defaults; rows still holding 15 and 96 move to 5 and 288 (D-01, D-11, § 1). | 10 automations per person, 30 inbound items an hour, the 288 schema ceiling, the per-automation default of 24 runs a day, the breaker, the no-reply sweep, the bot's daily turn limit, no Settings control yet. |
| "**The only new trigger.** D-08 (PR #25) made every Agent Channel post need a live turn. 07.6 adds exactly one allowed trigger, the run anchor" | ADR-0028, § 3 (already amended by ADR-0038 for `work_session`) | A third server-originated trigger: the automation item turn (`agent.automation_item.v1`, `trigger: "automation_item"`), anchored on the root the run opened, one per opened item (D-04, § 6). | The run anchor, the run-as person, the confused-deputy check and every other rule of § 3. |
| "Each run posts a **platform-owned** `automation` card at the target" | ADR-0028, § 3, the run anchor | For fan-out automations only, the run card is a reply in one per-automation run log thread, "<name> · Runs"; no board card per run (D-10, § 3). | Non-fan-out automations post exactly as today. The run card stays platform-owned and is changed only through `updatePlatformCard`. |
| "Side-effecting tools are refused on a tainted turn as in ADR-0026 (a per-call approval can still lift it)." | ADR-0028, § 4 | Two exceptions: `ocw_conversation_open` in the run's own target on a tainted run turn (D-05, § 7), and the card moves of § 8 (D-06). | Every other side-effecting tool on a tainted turn; a per-call approval still lifts the taint for one call. |
| "refused once the turn is tainted" | ADR-0022, decision 6 | A move or a waiting change of the card an automation of this bot opened, on that card's own thread, is allowed on a tainted turn when the bot's profile has `actOnOutsideContent` (D-06, § 8). | Card creation (`POST /board/cards`) on a tainted turn stays refused; every other board call on a tainted turn too. |
| "**An agent may move a card or set its waiting state only on the turn thread's card or on a card it created in this conversation**" | ADR-0022, decision 6 | A bot may also move and set waiting on any card its automation opened, from any turn in that card's thread, including item turns and wake turns (D-06, § 8). | P-03: agents never edit card text or fields. The rule for every other card. |
| "They are never offered on automation runs (07.17) or consult hops" | ADR-0038, § 12 | The four `ocw_work_session_*` tools are offered on automation item turns, on the same conditions as a mention by the run-as person (D-04, § 6). | Never on run turns or consult hops. |
| "From then on the claim refuses every other side-effecting call of the turn, except `ocw_work_session_prompt` and `ocw_work_session_stop` on the bot's own sessions." | ADR-0038, § 9 (as narrowed by its amendment, WR-02) | **Completed**, not replaced: the § 8 card move is a third exception after a session read, on the same three conditions (D-12). | `ocw_work_session_start` after a read still answers `session_output`; every other call stays refused. |

## Context

On 2026-11-09 the owner described one flow:

- an automation checks an orders MCP every 10 minutes;
- for each new order it opens a new thread in a channel, or a new card on a board;
- the bot reads the order's documents (in their case the vehicle's), starts working in the Work Zone and keeps
  orchestrating, reading the output;
- when it finishes or needs help it mentions a team or a person, who gets a notification;
- it moves the card to the right column.

Every seam exists: the run turn (ADR-0028), the Work Zone profile and wake-ups (ADR-0038), the board tool (ADR-0022),
mentions and notifications. The research found what stops the flow today:

1. **The caps.** The organization cap is 96 runs a day, and every 10 minutes is 144. The minimum interval is 15 minutes.
   A team bot's default daily limit is 100 turns, before any item turn or wake.
2. **One run card per run.** Every run posts a run card at the target, and on a board that is a new board card: 144 junk
   cards a day. A quiet run that posts nothing becomes `no_reply`, and three in a row pause the automation.
3. **Eight tool calls per turn.** Opening items one call at a time would cap a run at eight items.
4. **The board rule for tainted turns.** Every turn in the flow read outside content (the MCP, the documents, the
   session's output), so ADR-0022 refuses the move, and ADR-0038 § 9 refuses it after a session read.
5. **No team mentions.** Mentions are users or agents only, and units have no handle.

## Decision

### 1. The schedule minimum and the caps (D-01, D-11, PD-04)

- `bot_policies.min_schedule_minutes` defaults to 5 and `max_runs_per_day_cap` to 288. The migration moves rows still
  holding 15 and 96 (no route writes them, so they are defaults); any other value an admin set stays.
- `validateSchedule` is unchanged and still decides at create, update, preview, the natural-language proposal and the
  digest, with the organization's value.
- New automations still default to 24 runs a day. The editor pre-fills `min(cap, floor(1440 / N))` when the person
  picks "Every N minutes", and warns (non-blocking) when the expected turns a day exceed the bot's daily limit.
- Every existing guard stays: the per-automation runs a day, the organization cap, the breaker, the bot's daily turn
  limit and the no-reply sweep.

### 2. Fan-out settings and where they are allowed (D-02, D-16, PD-05)

- Stored on `automations`: `fan_out_enabled` (default false), `fan_out_per_run` (default 10, 1 … 25) and
  `fan_out_per_day` (default 100, 1 … 500, at least the per-run value).
- Allowed only for `action_kind = agent_turn`, `trigger_kind = schedule` (Run now included) and a `channel` or `board`
  target. A database check and the API's 400 `fan_out_not_allowed` enforce it.
- Webhook and mail automations keep one item per event (D-16). A natural-language proposal never sets fan-out; the
  person turns it on in the editor.
- Turning fan-out off keeps the dedupe rows and the run log root; turning it on again reuses both. With fan-out off,
  runs, cards and turns are byte-identical to today.

### 3. The run log thread (D-10, PD-06)

- A fan-out automation's runs anchor in one thread at its target. The first fan-out run posts a platform-owned
  `automation` card, top-level, titled "<name> · Runs", with the schedule, "Up to <perRun> per run · <perDay> a day",
  "Open automation" and Follow. Its id is stored in `automations.run_log_message_id`.
- Every run then posts its usual run card (`run:<runId>`) as a reply in that thread and is delivered there.
- A deleted root is replaced by the next run. It is created under the run → automation lock, so two concurrent runs
  create one root.
- **Fallback.** If a board channel refuses a top-level non-card message, the root is one pinned board card titled
  "<name> · Runs" in the board's first column, with the same reuse rules. The plan that builds it records which branch
  shipped.
- The open call marks the run answered, an empty list too ("Nothing new"), so quiet runs never trip the breaker.

### 4. The batch tool `ocw_conversation_open` (D-02, D-03, D-15, PD-07)

- One call carries a batch of items `{ externalKey, title, body }` (key ≤ 200, title ≤ 200, body ≤ 4 000 characters,
  at most 25 items). It is served by `POST /agent-channel/v1/conversations/open` in
  `agent-channel/conversations-open.ts`, which hands the work to `automation/fan-out.ts`.
- **Route order** (the 07.16 two-transaction pattern):
  1. Without a user: this bot's `agent_turns` row (else 404 `unknown_turn`, audited) and its run through
     `automation_runs.agent_event_id` (none: `not_a_run`).
  2. As the run-as person: the live turn, the tool on the turn (`not_in_turn`), the automation active
     (`automation_inactive`) with fan-out on (`fan_out_off`), the claim (`cap_reached` from the turn's tool cap), the
     run lock, then the automation lock (the runner's order), then the caps (§ 5).
  3. Per item, in request order: insert first, then post.
- **Only the run's own target.** The request names no target, run, person or conversation (strict schema). A board
  target gets a card through `createBoardCard` in `automations.board_column_id`; a channel target gets a top-level
  message with the title in bold and the body fenced. Only run turns open: never item, wake, consult or person turns.
- **Dedupe by a hashed key** (D-03). The key is stored only as the sha256 hex of its NFC-normalised, trimmed form, unique
  per automation (`automation_conversations_key_uq`). A conflict (a duplicate in the same request, an earlier run, or
  a concurrent run's committed insert) answers the existing conversation with `opened: false`.
- **"Never posts again"** means: no second card or thread, no second item turn and no edit of the existing root.
- **Titles** (D-15). On a board with a naming rule the bot's typed title is used, as for run and inbound cards; the
  board's number prefix still applies.
- **Bot-written text never notifies anyone.** Title and body pass `defuseMentions`; the channel body is fenced with
  `textFence`.
- A post refusal rolls the transaction back and answers `target_not_postable`, recorded in a fresh transaction.
- Refusals carry fixed sentences from the contracts: `not_in_turn`, `not_a_run`, `automation_inactive`,
  `fan_out_off`, `target_not_postable`, `cap_reached`.

### 5. Caps (D-02, PD-08)

- Per run: the rows of this run against `fan_out_per_run`. Per day: the automation's rows since the start of its local
  day (`automations.time_zone`) against `fan_out_per_day`. Both are counted under the automation lock.
- Items past a cap answer `refused: "run_cap"` or `"day_cap"` and post nothing; the answer returns `remainingRun` and
  `remainingDay`.
- The run turn's 8 tool calls, the bot's daily turn limit (one per item turn) and the 07.16 session caps still apply.
  Extra items' Work Zone starts answer `too_many_sessions`, and the bot says so in the thread.

### 6. One item turn per opened item (D-04, D-09, PD-09)

- Each opened item enqueues one ids-only `automation.item` job. Its handler, as the run-as person, delivers one turn
  `agent.automation_item.v1` (`trigger: "automation_item"`) on the opened root, with a derived event id so a retry never
  makes a second turn. The item's title and text are read from the root, never from the job.
- The handler skips with a reason when the automation is paused, the bot is disabled or no longer a member, the run-as
  person cannot read the conversation, the root is gone, or the bot's daily limit is reached.
- **Tools.** What the turn policy gives the run-as person in that thread (connectors, the board tool on boards, the
  sandbox, memory), plus the 07.16 Work Zone tools through `workZoneOfferFor` with the run-as person as the asker. Never
  `ocw_conversation_open` and never a consult.
- **Unattended.** No browser tools and no attachment listing (ADR-0029 D-12).
- **Tainted.** The item turn starts tainted (§ 7). A Work Zone start therefore needs the profile's
  `actOnOutsideContent`; without it, it falls back to ADR-0038's proposal card.
- **Documents** (D-09). The bot reads them through the tools it already has: connectors, memory, attachments and the
  sandbox. Nothing new.

### 7. Taint (D-05, PD-10)

- On a tainted run turn (the run read the MCP), the open call is claimed with the taint condition omitted and audited
  with `outsideContent: true`. Opening conversations in the run's own target is not a write outside the platform.
  Nothing else on the run turn is loosened.
- **Opened roots are outside content.** `automation_conversations.root_message_id` joins `inboundRooted`, so every
  later turn in such a thread starts tainted: the item turn, a person's @mention and the 07.16 wakes.
- The run log root does not. Run turns keep calling read-only connector tools at a clean start; a run's own taint is
  the claim's, as today.

### 8. Board moves on automation-opened cards (D-06, D-12, PD-11)

- In `gateTurn`, for `PATCH /board/cards/:messageId` only (a move or a waiting change; the body cannot carry text), the
  taint condition and the session-output condition are omitted when all three hold:
  1. the card is the turn thread's card;
  2. an automation whose `agent_id` is this bot opened it (`automation_conversations.root_message_id`);
  3. the bot's profile has `actOnOutsideContent`.
- This holds also after `ocw_work_session_read` set the session-output mark (D-12): the owner's flow is wake → read →
  move to Done.
- The call still counts against the turn's tool cap, and the board audit carries `outsideContent: true` and/or
  `sessionOutputExempt: true`.
- `POST /board/cards` keeps refusing tainted turns. Untainted turns are unchanged. Bots never edit text or fields
  (P-03).
- The plugin moves `ocw_board_card` from always-side-effecting to route-decides-taint, and its board tool refuses
  `create` locally on a tainted turn, so the local block still covers card creation.

### 9. Unit handles (D-14, PD-12)

- Every org unit has a stored `org_units.handle`, generated once from its name with `unitHandle`. A clash adds `-2`,
  `-3` and so on until it differs from every other unit handle of the organization and every live bot username (a
  deleted bot's username is free again). Renames and moves never change it; editing is deferred.
- **At most 40 characters** (07.17-02 deviation). For a `-N` suffix the base is cut to `40 - len(suffix)` and its
  trailing `.`, `_` and `-` trimmed, so every handle matches the 40-character mention token and can always be typed.
- **Filled by a trigger** (07.17-02 deviation). `app.org_unit_handle(org, name)` allocates handles in SQL. The
  migration's ordered backfill uses it, and the `org_units_fill_handle` `BEFORE INSERT` trigger uses it whenever an
  insert omits the handle. Older writers, `createUnit` and direct inserts therefore keep working against the NOT NULL
  column. A TypeScript allocator under the organization lock must give the same result for the same state.
- Only `team` and `department` units are mentionable; a `project` unit has a handle but never resolves.

### 10. Team mentions (D-07, D-17, D-18, PD-13)

- A team mention is stored as `{ kind: "unit", id }` in `messages.mentions`: a stable id, never a name (principle 11).
- **Precedence** on a handle clash: agents, then users, then units. A unit whose handle a person or bot shadows does not
  resolve, and the composer does not offer it.
- **Where they resolve.** Only on channel posts: top-level messages, threads and board cards (a `channel` conversation,
  or a `thread` whose parent is a channel). Never in DMs, group DMs, AI chats or Work Zone conversations.
- **Who may mention.** A human author needs `unit.read` on the unit (the resolver). For a bot author, the turn's human
  needs it.
- **The bot cap is for team mentions only** (D-17). Only the first 3 distinct units of a bot's message resolve
  (`TEAM_MENTION_LIMITS.botUnitsPerMessage`). Bot @person mentions keep today's behaviour, with no new cap. Bots still
  have no `@channel` or `@here` (`mentionAll` stays null).
- **No new grain** (D-18). A human team mention needs posting rights and `unit.read`. The composer asks for
  confirmation above 20 recipients.
- **Bots are never woken by a team** (ADR-0027 unchanged). The cell event's mentions are `principalMentions(…)`, so a
  unit never reaches the cell, and `dispatchAgentMentions` reads only `agent` mentions. The plugin contract is
  unchanged.

### 11. The audience (D-07, D-13, D-18, PD-14)

- A new message with unit mentions offers the notification kind `team_mention` to the active members of each unit's
  subtree (`org_units.path @> ARRAY[unit]`, so a department reaches its teams). The author is excluded.
- At most 200 recipients per message: the first 200 distinct users by user id across the message's units.
- A direct mention, `@channel` and a DM keep their stronger rank. The resolver's `isReadable` keeps only people who
  can read the conversation.
- `notifications.unit_id` is the first unit that reached the person; the inbox reads "mentioned @<handle>".
- Edits never fan out team mentions, as for `@channel`. Mention filters and notify levels treat `team_mention` as a
  mention.

### 12. Escalation targets (D-08, PD-15)

- An `agent_turn` automation may name up to 5 people or teams by id (`automations.escalation_targets`), whom its bot is
  told to mention when it finishes or needs help.
- Validated at save: people must be active members who can read the target conversation; units must be a team or
  department the run-as person can read (`unit.read`). Anything else is 400 `escalation_not_allowed` (one code).
- Resolved at delivery of run and item events to `{ kind, id, handle, displayName }`, dropping gone or no longer valid
  ones. The plugin renders one sentence. The bot's mention then follows § 10.

### 13. Audit and what never enters a record (principle 12, PD-17)

- `automation.conversation_opened` per open call: ids and counts (`opened`, `existing`, `refused`) and
  `outsideContent`.
- `automation.item_delivered` and `automation.item_skipped` with the item, run and event ids and a reason code.
- `automation.updated` gains `{ fanOut, perRun, perDay, escalationCount }`. The board audit gains `outsideContent` and
  `sessionOutputExempt`.
- **Never** in an audit row, a job payload, a log line or an `agent_tool_calls` row: an external key (clear or hashed),
  an item title or body, a unit name or handle.

### 14. Upgrade and release skew (PD-16)

- One additive migration (`20261110081210_automation_fan_out`): the dedupe table `app.automation_conversations` (tenant
  RLS, no TRUNCATE), defaulted or nullable automation columns, `notifications.unit_id`, the `team_mention` kind, the
  unit handle backfill and the two caps updates. No drop, rename or rewrite. Older code keeps working against it.
- Contracts are additive: the new DTO and event fields are optional. An older plugin skips `agent.automation_item.v1`,
  lacks the open tool and strips the run event's new fields harmlessly.

## Consequences

- **What people see.**
  - A fan-out automation keeps its runs in one "<name> · Runs" thread.
  - Each new item gets one card or one thread, opened once, where the bot works and reports.
  - `@team` chips in channels and threads, with team notifications in the inbox.
  - In the editor: "Every few minutes", the fan-out section, escalation people and teams, and the daily-limit warning.
- **What bots can do.** Open one conversation per new item in their run's own target, work each item in its own turn
  with their Work Zone profile, move and set waiting on the cards their automation opened (after outside content only
  with the admin's flag), and mention up to 3 teams per message.
- **What bots cannot do.**
  - Edit card text or fields (P-03).
  - Use `@channel` or `@here`.
  - Open conversations anywhere but their run's target, or from any turn but a run turn.
  - Fan out from webhooks or mail.
  - Wake another bot through a team.
- **The limits cost.** A 5-minute schedule is 288 runs a day, each a turn on the bot's daily limit, plus one turn per
  item and the wakes of each session. The owner must raise the bot's daily limit for the flow to run all day; the editor
  warns.
  - Work Zone runs two bot sessions at once by default, so extra items answer `too_many_sessions`. The bot says so; a
    person can re-ask. There is no retry queue.
- **Release skew.** Fan-out automations need the matching cell image. An older cell lacks the tool and skips the item
  event: its runs answer as before and open nothing.
- **Unit handles.** A handle a person or bot shadows does not resolve to the team. Handles cannot be edited yet; a
  rename keeps the old handle.
- **Out of scope** (PD-26):
  - new trigger sources (the "poll" is a scheduled run whose bot calls the MCP);
  - bots editing card text or fields;
  - `@channel` / `@here` for bots;
  - editing unit handles;
  - fan-out from webhooks or mail (D-16);
  - a retry queue for items refused `too_many_sessions`;
  - natural-language proposals with fan-out;
  - listing attachments on unattended turns.
- AGENTS.md gains an "Automation fan-out and team mentions" row citing this record, right after "Jobs and automations".

## Amendment (code review), 2026-11-10

The phase's code review (`.planning/phases/07.17-automation-fan-out-and-team-mentions/07.17-REVIEW.md`) changed the
documented behaviour below. The accepted text above stays as written; where it disagrees, this section decides.

- **CR-01, § 7 (taint of the run log thread).** A fan-out run turn is delivered with an empty `threadHistory`: the run
  log is for people, and a run turn never reads an earlier run's reply. The run log thread counts as outside content
  for every other turn that reads it (a person's @mention, reply mode) once any run anchored in it started tainted or
  has a tainted turn (`agent_turns.tainted`, read live, so a taint reached mid-turn counts; `runLogTainted`). Fan-out
  run turns keep their clean start. Non-fan-out runs are unchanged.
- **CR-02, § 11 (the 200 cap).** Replaces "the first 200 distinct users by user id across the message's units":
  readers are decided before the cap. The candidates (at most 2 000, `TEAM_MENTION_CANDIDATES`; in a non-public
  channel only its user members, since only members read it) are walked in mention order (the first unit that reached
  a person, then user id) through the resolver's `isReadable`, and the first 200 readers are notified. `deliver`'s
  reader check stays as the backstop.
- **WR-01, § 6 and § 13 (an item whose delivery keeps failing).** A delivery that fails for a reason that is not a
  refusal is retried by the queue; its last attempt marks the item `failed` with `delivery_failed` and audits
  `automation.item_skipped` with result `error` (ids and the reason only).
- **WR-02, § 5, § 6 and Consequences (items refused for capacity).** Replaces "There is no retry queue" and removes "a
  retry queue for items refused `too_many_sessions`" from Out of scope. An item whose own turn's Work Zone start
  answers `too_many_sessions` waits (`automation_conversations.status = 'waiting'`, reason `session_capacity`); when one
  of the bot's sessions leaves the active states, the `work_session.bot_sync` handler queues again as many of the bot's
  waiting items as it has free sessions, oldest first (`FOR UPDATE SKIP LOCKED`, active automations only). An item whose
  turn finds the bot at its daily limit waits too (reason `agent_daily_limit`, the limit notice as before, no longer
  `skipped`); the scheduler tick queues it again once its automation's local day has changed, at most `fan_out_per_day`
  per automation (`app.day_waiting_automation_items`, ids only). A queued-again item has `attempt + 1` and a new derived
  event id (`itemEventId(itemId, attempt)`, attempt 0 unchanged), so it is a new turn; after
  `FAN_OUT_LIMITS.itemAttemptsMax` (5) it is skipped with its waiting reason. Audits `automation.item_waiting` and
  `automation.item_requeued` carry ids, the reason and the attempt only. The run history shows "N waiting". One
  additive migration (`20261110124940_automation_item_waiting`: the `attempt` column, a partial index, the status check
  widened by `waiting`).
- **WR-03, § 8 condition 3.** "The bot's profile has `actOnOutsideContent`" now reads "the bot's profile is active
  (`profileStatus`, the start route's rule: the bot enabled, a live consent, the device not revoked, the sponsor an
  active member who may still start there, a live project, bot sessions on in the organization) and has
  `actOnOutsideContent`". A profile that lost any of these lifts no taint and no session-output mark.
- **WR-04, § 9, § 10 and § 12 (shadowed unit handles).** An escalation target is a unit only while no person or bot
  holds its handle (the mention directory's `byHandle`): a shadowed unit is refused at save and dropped at delivery,
  and the editor's picker does not offer it. Bot create and rename refuse a username equal to a team's or department's
  handle (409 `username_taken`), and a name-derived username steps past one (`logistics-2`). The allocator still does
  not skip people's handles: they are derived from names and e-mails that change after a unit exists, so the
  resolve-time rule above is what holds; a SQL twin of `userHandle` would also be needed to keep § 9's parity.
