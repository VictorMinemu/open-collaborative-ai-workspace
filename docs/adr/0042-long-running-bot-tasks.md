# ADR-0042: A bot keeps working on a long task by itself, scheduled by the platform

## Status

Status: Accepted. **Date:** 2026-11-12. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.17.1.1.2-02), before any behaviour lands; ships in v0.3.2. On ocw.autofy.ing (v0.3.1) the bot "Gertru"
was asked to read a company knowledge pack of 3 030 files and answered, after every turn:

> "No tengo una ejecución autónoma en segundo plano habilitada, así que no voy a decirte que seguiré trabajando
> después de responder"

(I have no autonomous background execution enabled, so I will not tell you I will keep working after I reply.) The
person had to keep writing "continúa" and "haz la tarea". The owner, quoted as said:

> "ahora mismo dicen que no tienen habilitado la ejecución en segundo plano lo cual es muy malo; el bot debe ser más
> proactivo y que haga las tareas y que pueda hacer tareas de larga duración"

(Right now they say background execution is not enabled, which is very bad; the bot must be more proactive, do the
tasks, and be able to do long-running tasks.) The decisions are D-01 … D-14 in
`.planning/phases/07.17.1.1.2-long-running-bot-tasks-a-bot-keeps-working-across-turns-on-i/07.17.1.1.2-CONTEXT.md`
(D-08 … D-14 were decided after the research, under the owner's full-autonomy grant), the planner decisions PD-01 …
PD-28 and the flagged assumptions A-01 … A-05 in `07.17.1.1.2-01-PLAN.md`, and the research in
`07.17.1.1.2-RESEARCH.md`. The owner's full-autonomy grant makes CONTEXT's locked decisions the acceptance.

**Supersedes, without editing them:** the clauses of [ADR-0028](0028-automations-and-job-scheduler.md) and
[ADR-0038](0038-bot-work-zone-orchestration.md) quoted verbatim below, each only as far as the "What replaces it"
column says. Everything else in those records stays exactly as written.

**Builds on:**

- [ADR-0019](0019-multiplayer-ai-chats.md): the asker pays; the task's requester is the asker of the turn that started
  it, and every task turn runs for and is paid by that person.
- [ADR-0020](0020-agent-personas-and-agent-cards.md): Agent Cards, and the platform-owned card that only the platform
  changes.
- [ADR-0027](0027-agent-to-agent-consultations.md): the cell's turn-done signal, the minute tick for lost work, the
  "requester or channel moderator" Stop rule, and the fact that the cell has no in-flight abort.
- [ADR-0028](0028-automations-and-job-scheduler.md): pg-boss with ids-only jobs; the Control Plane is the only
  scheduler (C-01); OpenClaw's cron and heartbeat stay off in the cell.
- [ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md) and
  [ADR-0043](0043-sandbox-document-toolkit.md): the sandbox, its background processes, and `ocw-extract --batch`,
  whose exit codes a task waits on.
- [ADR-0038](0038-bot-work-zone-orchestration.md) and its amendments: the `work_session.bot_sync` wake, which is the
  template of a continuation (derived event id, three transactions, live card) and which now also wakes a task.
- [ADR-0039](0039-automation-fan-out-and-team-mentions.md): the automation item turn, the third server-originated
  trigger, so a task continuation is the fourth.

### Superseded clauses

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "**The only new trigger.** D-08 (PR #25) made every Agent Channel post need a live turn. 07.6 adds exactly one allowed trigger, the run anchor" | ADR-0028, § 3 (already amended by ADR-0038 for `work_session` and by ADR-0039 for `automation_item`) | A fourth server-originated trigger is added: the continuation of a bot's own task (`agent.task.v1`, `trigger: "task"`), anchored on the task card (D-02, § 3). | The run anchor, the run-as person, the confused-deputy check, OpenClaw's automation kept off in the cell (the Control Plane is the only scheduler) and every other rule of § 3. |
| "### 11. Wake-ups: the second server-originated trigger (D-09, D-10, D-11, D-17, PD-16)" | ADR-0038, § 11, heading | The Work Zone wake stays the second trigger; a task continuation is a further one (`agent.task.v1`, `trigger: "task"`, § 3). A wake of a session that a task turn started is delivered as that task's turn when the task waits for it (§ 5). | Every rule of § 11: the debounce, the wake-worthy transitions, the daily wake budget, the original asker re-checked at each wake, delivery on the live card, the structured-facts body, the deciders, who pays. |

## Context

A bot turn today is one model call that answers one event: a person's mention or reply, an automation's run or item,
a consult hop, or a wake of the bot's Work Zone session. Nothing lets a bot ask for its own next turn. The research
(`07.17.1.1.2-RESEARCH.md` § 6) found:

1. **No "no background execution" text exists in the code.** A search of the plugin, the API, the contracts and the
   cell config finds only sandbox `background` flags and the cell config's comment that bots speak only when
   addressed. The sentence the owner saw is the model's own, and it was honest:
   - it has no tool that schedules its next turn;
   - the persona prompt asks for concise replies ("Keep replies concise unless asked for detail.");
   - OpenClaw's cron is pinned off and its heartbeat is `"0m"` in the cell by design (ADR-0028 C-01), and its session
     and automation tools are denied.
2. **A continuation fits an existing seam.** Server-originated turns are all built one way: a module calls
   `buildMentionEvents` with a named trigger, `turnPolicy` re-decides the tools as the person the turn runs for, meters
   the bot's daily limit and writes the `agent_turns` ledger. The 07.16 Work Zone wake is a working copy of what a
   continuation needs.
3. **The bridge treats a silent turn as a failure.** A turn without visible text is re-dispatched with a failure
   reply, and only chain turns report done. Quiet continuations would trip both.
4. **Sandboxd has no end signal.** Background processes live in its memory and their end is seen only when someone
   polls. Its event feed has four types (`state`, `usage`, `egress`, `browser`).
5. **ADR-0043 already chunks the long jobs.** `ocw-extract --batch` sizes its budget from `SBX_EXEC_DEADLINE_S`, so a
   chunk ends 130 s before the exec deadline. It exits **75** only when it made progress and there is more to do, and
   **8** when a run made no progress (do not run it again). Bots run batches with `background true` and
   `timeoutSeconds 600`; `execTimeoutMaxSeconds` stays 600 (A-03). What was missing is a way for the bot to wait for
   the chunk and be woken when it ends.

So the fix is a platform entity, three tools, one more trigger, and one guidance paragraph, not a changed sentence.

## Decision

### 1. A task is a platform entity (D-01, PD-05)

- `app.bot_tasks`, organization-scoped with RLS: the bot, the conversation and its thread (no thread in `dm` and
  `group`), the task card, the requester (the asker of the turn that started it), the goal, the progress note, the
  next step, the final summary, the turn count and its maximum, start, update, deadline and finish times, the current
  wait, the taint flag and the visible-progress marks.
- **One active task per bot per thread**, by a partial unique index over the active states, so two concurrent starts
  leave exactly one row.
- **States:** `running` (a turn of the task is in flight) and `waiting` (the next turn is scheduled) are active;
  `done`, `failed` and `stopped` are terminal.
- **Transitions:**
  - Start: `running`, turn 1, the start turn is the task's current turn.
  - Continue: `waiting`, with a wait (§ 5) and a bumped wait sequence.
  - Delivery of a wait: `running`, turn + 1, the delivered turn becomes the current one.
  - Finish: `done` (outcome `done`) or `failed` (outcome `blocked`).
  - Stops: `stopped` for a budget, the daily limit, access loss, an unavailable bot, the policy or a person; `failed`
    for no progress and errors.
  - Every terminal transition sets the finish time, clears the wait and bumps the wait sequence, so a job already
    queued finds nothing to deliver.
- **One execution authority per task.** A control call is accepted only when the task is waiting or the calling turn
  is the task's current turn; otherwise it is refused `task_busy`.
- Sandbox processes the task waits on live in `app.bot_task_processes` (§ 5).

### 2. Three tools with strict ids-and-notes bodies (D-02, A-04)

- `ocw_task_start { eventId, agentId, goal }`, `ocw_task_continue { eventId, agentId, progress, nextStep,
  afterSeconds?, waitFor? }` and `ocw_task_finish { eventId, agentId, summary, outcome: done | blocked }`, sent by the
  plugin to `POST /agent-channel/v1/tasks/start|continue|finish`.
- **The bodies name no person, conversation, task id, budget or time** the API decides; it reads them from the turn
  and the task row. A `userId`, `conversationId`, `taskId`, `maxTurns` or `at` key is a parse error.
- **Text rules:** a one-line goal of at most 200 characters, one-line notes of at most 500, a summary of at most
  1 000 with newlines. Each refuses blank text, control characters and every bidi control.
- `afterSeconds` is a whole number from 0 to 3 600. `waitFor` is exactly one of `{ processId }` or `{ workSessionId }`.
- **Answers** are discriminated on `ok`: a task id, its maximum turns and its deadline for a start; the next wake
  (`after_turn`, `at`, `on_process`, `on_session`), the turns left and `quiet` for a continue; the final status for a
  finish; or one closed refusal code with a fixed sentence (`not_in_turn`, `task_active`, `no_task`,
  `not_requester`, `task_busy`, `task_stopped`, `budget_turns`, `budget_time`, `policy_off`, `org_cap`,
  `wait_unknown`, and the plugin's local `once_per_turn`).
- **The offer** (PD-07):
  - `start`: no active task, and a turn triggered by a mention, a reply-mode message, a Work Zone wake or an
    automation item. **All three tools** are offered (A-04), so the start turn can continue in the same turn instead
    of wasting a nudge turn. Continue and finish answer `no_task` until a start succeeded.
  - `control`: the task's current turn, or the requester's turn while the task waits. Continue and finish.
  - `view`: any other turn in that thread. No task tools, only the task's state.
- Each tool may be called once per turn. They are builtins, never approvable, self-validated, turn-scoped and never
  on `/tool-calls`.

### 3. The fourth server-originated trigger: `agent.task.v1` (D-02, P4)

- A continuation is the event `agent.task.v1` with `trigger: "task"`, built exactly like a mention of the bot on its
  task card (`threadRootId` is the card in `dm` and `group`, the task's thread root elsewhere). Its structural author
  is the requester.
- **Its text is a fixed server sentence** with the turn number, for example "Continue your task (turn 7 of 40).", or
  the timer, process or nudge variant. It never carries the bot's own text.
- **The bot's notes travel only in `turn.task`**, the "Your task (your own notes)" block: goal, status, progress, next
  step, turn n of N, times, the wait and up to 10 finished processes, each through a one-line sanitizer.
- `turn.task` is present on every turn of the bot in a thread with its active task, so a person's own turn there sees
  the task too. An older plugin skips the unknown event type and strips the field.

### 4. The API is the only scheduler (PD-06)

- **One job, ids only:** `bot_task.continue { organizationId, taskId }`, with no singleton key, so a queued backstop
  never swallows an earlier job. Extra jobs are harmless: the handler decides under `FOR UPDATE`.
- **Derived event ids.** A continuation's event id is a UUIDv8 from the SHA-256 of the task id and its wait sequence
  (the `wakeEventId` recipe). A retry, a second job, the tick and a process event for the same wait all name the same
  turn, so it is delivered once.
- **Three transactions,** as the Work Zone wake: decide without a user, deliver as the requester, then confirm or give
  the wait back.
- **Readiness.** A waiting task is delivered only when its wake time has come **and** its current turn reported done,
  or that turn is older than 30 minutes (lost).
- **The turn-done release.** The cell's `POST /turns/:eventId/done`, now reported for every task turn, marks the turn
  done, shortens a `turn` or `nudge` wait to 5 s from now and enqueues the job. A plain continue therefore waits for
  its own turn to end, then 5 s.
- **The backstop and the tick.** A plain continue's wake time is 30 minutes after the call, so a cell that never
  reports done still gets its next turn. The minute tick `bot_task.tick` lists due tasks through a `SECURITY DEFINER`
  function that returns ids only, 100 per tick: waits past their wake time, running tasks with no update for
  30 minutes, tasks past their deadline, and tasks of a disabled or archived bot.
- **OpenClaw's cron and heartbeat stay off.** No plugin timer, `sessions_send` or cell-side schedule is added (P2).

### 5. Wakes: timers, sandbox processes and Work Zone sessions (D-03, PD-13, PD-14)

- **Timer.** `afterSeconds = n > 0` wakes the task at now + max(n, 5 s). Absent or 0 is a plain continue (§ 4).
- **Every wake time is capped at the task's deadline.**
- **Sandbox processes** (BTASK-04):
  - sandboxd marks a process yielded when it answers `running` to a background exec, and emits one `process` event
    when it ends (exit, kill, timeout), guarded so it is reported once. The event carries ids and numbers only: the
    process id, the status, the exit code and the duration, never argv, a path or output.
  - `/sandbox/exec` links a background run of a task turn to the task in `bot_task_processes`, with a deadline of the
    effective timeout + 60 s.
  - The API's exactly-once event consumer handles the event in its organization's transaction, after the cursor check.
    When the task waits on that process, the wake time becomes now and the job is enqueued. A process that ends while
    the task is not waiting on it is only recorded and listed once in the next task turn's finished processes.
  - A lost process (sandboxd restarted, the shell killed) wakes the task at its deadline with status `lost`.
  - The consumer parses each event on its own and skips an unknown type, so a newer sandboxd never stalls an older
    API.
- **What this means for ADR-0043's batches.** The bot starts `ocw-extract --batch` with `background true` and
  `timeoutSeconds 600`, then calls `ocw_task_continue` with `waitFor: { processId }`. It is woken with the exit code
  when the chunk ends:
  - **75**: the chunk made progress and there is more; the bot runs the same batch again and waits again;
  - **8**: no progress; the bot does not run it again, and reports or finishes `blocked`;
  - **0**: the batch is complete; the bot reads `_index.tsv` and the text mirror.
  The API passes the exit code through and never interprets it: the meaning lives in the toolkit and in the bot's
  guidance. One chunk is one wait and one task turn, so a chunk never needs more than the 600 s exec cap.
- **Work Zone sessions** (BTASK-05). A session started by `ocw_work_session_start` from a task turn records the task.
  When its 07.16 wake fires and the requester is the session's requester:
  - a task that waits within its budget consumes the wait, and the wake is delivered as that task's `control` turn;
  - a task over its budget is stopped, and the wake goes out as a plain wake;
  - a running task gets a `view` turn.
  The wake keeps its own dedupe and daily wake budget. `waitFor: { workSessionId }` waits at most 60 minutes (or
  `afterSeconds`) for a session of this task that has not ended; any other session is `wait_unknown`.

### 6. Budgets and stops (D-04, PD-09, PD-18)

- **Per task:** at most 40 turns (organization limit up to 200) and 8 hours (up to 24). Both are snapshotted at start;
  later policy changes do not move them, except "Allow long tasks" off, which stops the task at its next continue or
  delivery.
- **Per organization:** at most 10 running tasks (0 to 100; 0 turns long tasks off), counted under an advisory lock
  at start, so two concurrent starts cannot both take the last slot.
- **The bot's daily turn limit** meters every continuation through `turnPolicy`. At the limit no turn is delivered,
  the generic limit notice is skipped, and the task stops `daily_limit`.
- **One message when a task stops.** After commit, the platform posts as the bot in the task's thread
  `@<requester handle> ` plus one fixed sentence, for example "I stopped this task after 40 turns, the limit for one
  task. The card shows where it got to.", resolved to a structural mention server-side and keyed `task:<id>:end`.
  There is no message when the sentence is null (done, stopped by a person, access lost, the bot unavailable, an
  error) or when the requester can no longer read the conversation; a card notice says what happened instead.

### 7. The task card and Stop (D-05, PD-11, PD-12)

- **The card.** The start route posts a **platform-owned** Agent Card of kind `task` in the asker's message thread,
  keyed `task:<id>`, and the requester follows it. The bot cannot patch it (`card_platform_owned`); a card deleted
  mid-task stops the task as access lost, with no message.
  - Title: the goal. Fields: "Progress" and "Next step". Status label: Working, Waiting, Done, Blocked, Failed or
    Stopped.
  - The card status stays `running` across turns, so followers hear only the end.
  - The numbers (turns used of max, elapsed time, the requester, the wait) travel in `AgentCard.task`, composed by the
    platform for every reader, never by the bot.
- **Stop:** `POST /api/v1/bot-tasks/:id/stop`.
  - Allowed for the requester, a moderator of the channel (`message.delete_any`, the chain Stop's rule) and the bot's
    managers (`bot.configure` for a personal bot's owner, `bot.manage` / `bot.manage_unit` for team bots); 403
    `not_task_owner` for anyone else.
  - 404 `task_not_found` when the caller cannot read the task's conversation; RLS hides other organizations.
  - Idempotent. Stopping is immediate for the platform: no new turn is delivered. The in-flight turn finishes (the
    cell has no abort, ADR-0027), and its later continue answers `task_stopped`.
  - The card shows Stop only to the people the same rule allows, through `viewerCan.stop`.

### 8. Visible progress: one post per 5 turns or 10 minutes (D-11, PD-10)

- The card is refreshed on every state change, so it updates in place every turn.
- A task turn's text is dropped only when its continue answered `quiet: true`.
- `quiet` is true only for a platform-delivered task turn (not the start turn) less than 5 turns and less than
  10 minutes after the last visible post. When not quiet, the API records the new last post.
- A person's own turn, a finish and every platform stop message always post.

### 9. Proactive guidance (D-06, D-14, PD-16)

- `buildPersonaPrompt` appends **one separate paragraph** after its existing reply line, chosen by the turn's offer;
  no other line of the prompt is rewritten. ADR-0043's toolkit guidance stays where it is (the attachments how-to and
  the sandbox tool descriptions), so the two phases never edit the same paragraph.
  - `offer`: start a task when a request needs more than one turn; keep going, and call `ocw_task_continue` with
    progress and the next step instead of asking whether to continue; wait for background commands and Work Zone
    sessions with `waitFor` instead of polling; **never say you will keep working unless `ocw_task_continue` answered
    ok**; finish with `done`, or with `blocked` when you need the person.
  - `active`: do as much as you can this turn, then continue or finish; on task turns reply only at milestones,
    because the card shows progress.
  - `view`: a task of yours for another person runs here; answer this person and do not continue that task.
- **The bridge** accepts a silent task turn when it called continue or finish: no re-dispatch, no failure reply. It
  drops the text of a quiet turn, and reports done for every turn that lists a task tool or is an `agent.task.v1`.
- This replaces today's honest "no background execution" behaviour: the bot now has a real way to schedule its next
  turn, and the guidance tells it to use it and never claim one it has not scheduled.

### 10. Safety: every turn is re-decided as the requester (D-07, D-08, D-09, PD-15)

- **The same intersection every turn.** Each continuation is a turn of the bot for the requester, re-decided by
  `turnPolicy` (the requester ∩ the bot ∩ the resources). A task never widens what a turn may do.
- **The taint is sticky** (D-08). A task turn starts tainted when the task is tainted or any of its turns was; the task
  then stays tainted to the end. The Work Zone session-output mark is set as in the wake. Task tools are not
  side-effecting, so a tainted task still continues, and the budgets stop it (A-01). Work Zone starts after outside
  content keep ADR-0038's outside-content rule unchanged.
- **Continuation turns have no browser tools** (D-09), like other unattended turns, but they list the thread's
  attachments under the 07.15 rules, decided as the requester.
- **What stops the task:**
  - the requester can no longer read the conversation, or was deactivated: `access_lost`, no message;
  - the bot is disabled, archived or removed from the conversation: `bot_unavailable`, also found by the tick;
  - "Allow long tasks" off for the organization, for personal bots, or on the bot's own toggle: `policy_off` at the
    next continue or delivery, with one message.
- **Policy.** Settings › Bot policy gets "Allow long tasks" (default on, with its personal sub-switch) and the three
  limits; the bot's capabilities show "Long tasks" like every other capability (BTASK-08).
- No new listening port, permission or grain; jobs carry ids only (P3, P7).

### 11. Task tools are not side-effecting and are outside the 8 calls (D-13, A-01)

- The three tools only schedule this bot's own next turn for the same person within the budgets. Their flags are
  `{ untrustedOutput: false, sideEffecting: false }`, so they read nothing from outside and are allowed on tainted
  turns.
- They do not count toward the 8 tool calls per turn (`MAX_TOOL_CALLS_PER_TURN`): a turn that used its 8 calls can
  still continue or finish. The plugin's once-per-turn rule bounds them instead.
- Their claims are recorded in `agent_tool_calls` without counting toward the cap.

### 12. One nudge, then stop (D-12, PD-06)

- A task turn that ends without `ocw_task_continue` or `ocw_task_finish` gets **one** automatic nudge turn: the task
  waits with kind `nudge`, and the turn's sentence says the last turn ended without a task call.
- A second such turn in a row stops the task `no_progress`: status `failed`, label Blocked, and one message mentioning
  the requester.
- A successful continue clears the nudge mark.

### 13. AI chats are out of scope (D-10)

- Tasks run in channels, threads and DMs only. A mention of a bot in an AI chat never carries the task tools, and the
  start route refuses it `not_in_turn`. AI chats keep their own generation model (ADR-0019, ADR-0020).

### 14. Audit with ids and counts only (PD-19, principle 12)

- `bot.task_started`, `bot.task_continued` (each delivered continuation), `bot.task_finished`, `bot.task_stopped` and
  `bot.task_refused`.
- Actor and agent: the bot. User: the requester. Resource: the task (`bot_task`, its id).
- Metadata: ids, counts, reasons and durations only: the task, conversation and event ids, turns used and max, the
  wait kind, the reason, the outcome, who stopped it, the process id.
- **Never** a goal, a progress note, a next step, a summary or a message text in an audit row, `agent_tool_calls`, a
  job payload or a log line (P1). The notes are the bot's own untrusted text and live only in the task row and the
  card. A Semgrep rule guards it.

### 15. Upgrade and release skew (PD-21, PD-23)

- **One additive migration**, generated after ADR-0043's: two tables, nullable or defaulted columns
  (`agent_turns.task_id`, `bot_work_sessions.task_id`, the three policy limits) and the card kind check widened. It
  is forward-only, and older rows need no backfill.
- **Two queues**, `bot_task.continue` and `bot_task.tick`, registered like every other queue.
- **Skew.** Every new field is optional. An older plugin lacks the tools (not in its tool list), skips
  `agent.task.v1` and strips `turn.task`. An older web ignores `card.task`. An older API never offers the tools. An
  older API's event consumer would reject the new sandboxd `process` event, so both ship in the same release and the
  new consumer skips unknown types.

## Consequences

- **What people see.** Ask a bot for a long job and it says it started a task. A live card in the thread shows the
  goal, "Turn 7 of 40", the elapsed time, what it is waiting for and its last progress. The thread gets a progress
  message at most every 5 turns or 10 minutes, and the end. The requester, the channel's moderators and the bot's
  managers can Stop it.
- **Cost is bounded.** A task costs at most its turns (40 by default, 200 at most) and its hours (8 by default, 24 at
  most). Every turn also counts in the bot's daily limit, and the organization runs at most its running cap (10 by
  default) at once. Each continuation is a full model call with the thread's history (RESEARCH Pitfall 10); a turn
  that waits on a sandbox process costs nothing while it waits.
- **The owner's 3 030-file job.** It is chunked by `ocw-extract --batch` into runs of at most about 470 s, one task
  turn per chunk. Its length depends on the files, so the 40-turn default may not finish it; the card then says the
  task used its turns, and the person or an admin raises the organization limit.
- **What the owner checks in UAT** (A-05, the phase gate):
  - that a real model starts a task instead of asking "¿continúo?" (prompt effectiveness);
  - that the cadence of visible posts feels right in a real thread;
  - the 3 030-file job end to end on ocw.autofy.ing: background chunks, exit 75 wakes and the final summary.
- **What bots cannot do.** Schedule a turn for another person, conversation or bot; choose a budget or a time beyond
  `afterSeconds`; widen a turn's tools; use the browser on a continuation; keep working after a Stop; post through the
  task card.
- **Deferred** (PD-25):
  - tasks that span several conversations or bots;
  - a task list page per bot;
  - per-bot overrides of the limits;
  - longer sandbox exec timeouts (`execTimeoutMaxSeconds` stays 600; long jobs are chunked across waits);
  - a person's message implicitly pausing a task;
  - shorter history on task turns;
  - tasks in AI chats.
- AGENTS.md's "Jobs and automations" row names long bot tasks and cites this record next to ADR-0028.
