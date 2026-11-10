# ADR-0038: Bots orchestrate Work Zone sessions through a sponsored profile

## Status

Status: Accepted. **Date:** 2026-11-09. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.16-04), before any behaviour lands, from the owner's request of 2026-11-09 and decisions D-01 … D-22 in
`.planning/phases/07.16-bot-work-zone-orchestration/07.16-CONTEXT.md` (D-17 … D-22 are the addendum that resolved the
research's open questions), the planner decisions PD-03 … PD-22, PD-29 and PD-30 in `07.16-01-PLAN.md`, and the
research in `07.16-RESEARCH.md`. The owner's full-autonomy grant makes CONTEXT's locked decisions the acceptance.

**Supersedes, for bots with a Work Zone profile only, without editing them:** two clauses of
[ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md), D-05 of
[ADR-0030](0030-shared-work-zone-projects-and-session-visibility.md) and §3 of
[ADR-0028](0028-automations-and-job-scheduler.md), each quoted verbatim below. For every bot without a profile, and for
every person, those clauses stay exactly as written.

**Builds on:** [ADR-0012](0012-full-access-mode-and-shared-devices.md) (the Full access chain and shared devices),
[ADR-0020](0020-agent-personas-and-agent-cards.md) (Agent Cards through the Agent Channel API),
[ADR-0027](0027-agent-to-agent-consultations.md) (who pays a cell turn; unattended turns),
[ADR-0031](0031-work-zone-sidebar-and-per-viewer-session-fields.md) (per-viewer session fields) and
[ADR-0033](0033-headless-work-zone-server.md) (headless service daemons).

### Superseded clauses

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "**Work Zone proposals.** A bot may suggest a Work Zone session (project, device, prompt), but the session runs on a person's device under that person's name, so only that person may start it, and never from a turn that read outside content." | ADR-0026, Context, item 2 | A bot with an active profile starts sessions itself, in its sponsor's name, on its profile's device (D-01, D-02, D-05). From a tainted turn it may do so only when an admin turned on `actOnOutsideContent`, and Full access then only on an isolated server (D-08). Without the flag, a tainted turn may still create a proposal, marked as such (D-18). | A bot without a profile only proposes, and only the person starts it. |
| "The body carries ids and the tool's fields only: **a mode, a model, full access or a user cannot be expressed** (closed schema, strict server body)." | ADR-0026, Decision, Work Zone proposals | `ocw_work_session_start` may carry a model, reasoning effort, fast mode, context window and permission mode, always within the profile's sets and the device's catalog (PD-09). It still cannot name a user, a device, an audience or a worktree. | Unchanged for `ocw_start_work_zone`. |
| "**Only the requester may Start**, live with `work_session.create`;" | ADR-0026, Decision, Work Zone proposals | A bot session needs no Start: the bot's start tool creates it, with the sponsor's rights (PD-03). | Unchanged for proposals, including the D-18 proposal from a tainted turn. |
| "**Seeing is not controlling.** The audience decides who sees and follows a session: its list entry, header, stream, diff, attachments and approvals view. Prompting, interrupting, configuring, approving and archiving keep their rules (role permissions and device access, ADR-0012), **and** the person must be in the audience." | ADR-0030, Decision, D-05 | For bots: a bot prompts and stops only the sessions it started, through its sponsor's rights and its profile. It is not an audience member and never approves (PD-13). | Unchanged for people: everyone in the audience keeps exactly this rule on bot sessions too. |
| "**The only new trigger.** D-08 (PR #25) made every Agent Channel post need a live turn. 07.6 adds exactly one allowed trigger, the run anchor" | ADR-0028, §3 | A second server-originated trigger is added: the wake turn of a bot's Work Zone session (`agent.work_session.v1`, `trigger: "work_session"`), anchored on the live card (D-09, PD-16). | The run anchor and every other rule of §3. |

## Context

On 2026-11-09 the owner asked for bots that run Work Zone sessions themselves:

- start a session in a chosen project, choosing the model and the options;
- keep orchestrating it, sending prompts and reading the output, until it finishes or needs help;
- mention a person when it needs help;
- show a card in the chat that opens the session, with a way back to the chat;
- per bot, a configured computer or server, model and permissions, including the mode without permission prompts.

Until now a bot could only propose a session (ADR-0026). A person reviewed the prompt and pressed Start, the session
ran in that person's name at `default` mode, and nothing reached the bot afterwards. No Agent Channel route read a
session, and session output streamed only to the session's audience on `ws:<id>`. A turn that had read outside content
could not even propose.

The research found every needed seam in place: one `createWorkSession`, one `queueWorkPrompt` with the arbiter
`tryDispatch`, one `ControlsContext` loader, one `setStatus` for every state change, the automation-run anchor as the
template for a server-originated bot turn (ADR-0028), and platform-owned cards (ADR-0020). The design reuses each of
them and forks none.

**Outside content (owner decision, option 1, D-08).** The owner chose the stricter of the offered options. A turn that
read outside content (MCP output, attachments, webhooks, mail, the web) may start or prompt a session only when an
admin turned on the profile's `actOnOutsideContent`, with a warning in words. Full access then runs only on a device
its owner marked as an isolated server. Otherwise the bot falls back to the proposal card.

## Decision

### 1. One profile per bot, and its sponsor (D-01, D-02, PD-04, PD-05)

- A bot has at most one **Work Zone profile** (`app.bot_work_zone_profiles` and its project join table, tenant RLS).
  It names, by stable id: the device; the allowed projects (at most 50); the runtime (Claude Code or Codex); the
  default model, reasoning effort and context window, and the sets the bot may choose from; fast mode (`off`,
  `allowed`, `on`); the default and maximum permission mode; whether each session gets its own worktree; the limits;
  and `actOnOutsideContent` (D-01).
- Whoever holds `bot.configure` on the bot edits the profile. No new permission exists: a personal bot's owner; for a
  team bot, admins, its owner and the leads of a unit on its path.
- **The saver is the sponsor** (D-02). The sponsor is the identity every session check uses (`work_session.create`,
  `device.use`, project access, ADR-0030), and is accountable in audit. A change of sponsor is a re-save.
- Validation at save runs against the sponsor's live controls for (device, runtime):
  - the device is usable by the sponsor and not revoked;
  - every project is on that device and startable by the sponsor;
  - every default and allowed model, effort and context window is in the runtime-reported catalog and available to
    the sponsor; options marked `not_confirmed` are never allowed, and the defaults are always members of the sets;
  - `defaultMode` ≤ `maxMode`; a `maxMode` of Full access needs the org policy and the sponsor's `device.full_access`.
- `actOnOutsideContent` changes only with `work_zone.manage` at the organization (admins). When a non-admin who is not
  the current sponsor saves, the flag resets to false, audited: the admin accepted the warning for the previous
  sponsor's rights.
- **Status is decided live** (PD-05), in this order:
  `bot_disabled` → `no_consent` → `device_revoked` → `sponsor_inactive` → `sponsor_not_allowed` →
  `sponsor_device_access` → `no_projects` → `org_disabled`. A sponsor who lost a right disables the profile, and the
  bot is told why with a fixed sentence. The status is re-checked at every tool call and at every dispatch.

### 2. Device consent and the isolated server (D-03, D-19, D-22, PD-06, PD-18)

- The device's owner grants a bot the use of the device once (`app.device_bot_consents`, soft-revoked like device
  grants) (D-03). Without a live consent the profile is inactive.
- On a device reported as a headless service (ADR-0033), an admin (`work_zone.manage`) may also grant, update and
  revoke (D-22). On every other device only its owner may.
- The consent carries a separate, explicit **"Allow Full access for this bot"** checkbox (D-04). The API stores it
  even while the device's own Full access opt-in is off, because the chain is decided live; the web disables it with
  the reason.
- Every grant, update and revoke is audited and runs the existing device re-authorization sweep. Profile saves and
  deletes do the same for the old and the new device.
- **Isolated server** (D-19): set only on the device (`ocw-runtime isolated-server on|off|status`, or
  `OCW_ISOLATED_SERVER`), reported in the device's own `hello` and `capabilities` frames, and never settable from the
  web or the API. The API honours it only when the device reports `host_kind = 'service'` (PD-18). The host kind comes
  from `OCW_RUNTIME_HOST` (the desktop launcher sets `desktop`), otherwise from the installed bundle of ADR-0033.
  Settings shows it read-only ("Set on the device"), like Full access.

### 3. The bypass chain: ADR-0012, plus the bot (D-04, D-08, PD-08)

A bot turn runs in Full access only when **all** of these hold:

1. the organization policy allows Full access (ADR-0012);
2. the device's own Full access opt-in is on (ADR-0012);
3. the sponsor holds `device.full_access` on the device, within the device's cap (ADR-0012's grain);
4. the consent's per-bot `allowFullAccess` is on (D-04);
5. the profile's `maxMode` is Full access (D-04);
6. the session was never tainted, **or** the device is an isolated server (D-08).

It is checked at start, at every dispatch and by re-authorization, and audited. The daemon keeps its own opt-in gate.
No layer of ADR-0012 is removed, and nothing outside this chain enables a bypass mode.

### 4. One controls context with an agent layer (PD-07)

- `loadControlsContext` takes an optional agent layer (`AgentControlsLayer`). The sponsor's own computation is
  unchanged (`modeCap` stays theirs); the layer only adds a last check to each control.
- A mode above the profile's maximum, Full access outside §3, and a model, effort, context window or fast mode outside
  the profile's sets each report the reason `bot_profile` ("Above this bot's Work Zone profile").
- That check comes after the existing `org_policy → device_opt_in → device_grant → denied_for_you → runtime` reasons,
  so a member's own limit keeps its own reason.
- Start, settings changes, the highest available mode, the per-turn mode and re-authorization all read only this
  context. There is no second permission path.

### 5. Four tools, run as the sponsor (D-05, D-06, PD-03, PD-09)

- `ocw_work_session_start`, `ocw_work_session_prompt`, `ocw_work_session_read` and `ocw_work_session_stop` are
  builtins (D-05). The OpenClaw plugin sends them to the Agent Channel API, which decides and audits them
  (`agent-channel/work-sessions.ts`, `work-session-read.ts`). They are never approvable through ADR-0026 rules,
  self-validated in the cell and turn-scoped (never in `GET /cell`).
- Their bodies are strict and carry the turn's event, the bot and the tool's own fields. **No body can name a user, a
  device, an audience or a worktree** (PD-09):
  - the device and the runtime come from the profile;
  - the identity comes from the sponsor;
  - the audience is decided by the server (§7);
  - the worktree comes from `profile.worktree`.
- A model or option the bot asks for must be in the profile's set **and** in the device's catalog; when absent, the
  profile default applies. A slash command is never a bot prompt (`prompt_not_allowed`).
- **The sponsor's transaction** (PD-03). Each route first finds the turn and the bot's profile without a user context.
  It then opens a transaction as the sponsor. There it re-checks that the turn is live and the asker still reads the
  conversation (else 404 `unknown_turn`), checks the tool is on the turn and the profile is active, claims the call,
  and only then calls the one `createWorkSession` / `submitWorkPrompt` / archive.
  - Running as the asker is impossible: the session's RLS backstop admits a new row only for `created_by = app.user_id`.
  - `agent_tool_calls.user_id` stays the asker.
- **Sessions a bot starts are its sessions** (D-06): `work_sessions.created_by` = the sponsor,
  `started_by_agent_id` = the bot, and `app.bot_work_sessions` keeps the origin conversation, thread and message, the
  card message and the wake state.
  - A bot prompt keeps `author_user_id` = the sponsor (every reader, the arbiter and audit keep working), with
    `author_agent_id` = the bot.
  - Prompts from a tainted turn have `tainted = true`.
- Every refusal is a closed code with a fixed sentence the bot can pass on (`BOT_WORK_SESSION_SENTENCES`), never an API
  error body.

### 6. Caps and one executor per tree (D-15, PD-10, PD-22)

- Limits (D-15, PD-22), each tunable within its bounds:

  | Limit | Default | Range | Scope |
  | --- | --- | --- | --- |
  | Concurrent sessions (`max_concurrent`) | 2 | 1..10 | per bot |
  | Prompts per hour (`prompts_per_hour`) | 30 | 1..120 | per bot |
  | Wake-ups per session per day (`wakes_per_session_day`) | 20 | 0..100 | per bot |
  | Bot sessions at once (`bot_sessions_max`) | 10 | 0..1000 | per organization; 0 means bots never start sessions |

  Read sizes are capped by `BOT_WORK_ZONE_LIMITS`.
- Start order (PD-10), in the sponsor's transaction after the claim, under a per-bot advisory lock and a second
  per-organization lock:
  1. bot concurrency (`too_many_sessions`);
  2. organization concurrency (`org_limit`);
  3. prompts in the last hour, the first prompt included (`prompt_rate`);
  4. project (`project_not_allowed`);
  5. model and options (`setting_not_allowed` with the field), then mode (`mode_not_allowed`);
  6. working tree (`tree_busy`);
  7. audience;
  8. `createWorkSession`, whose own failures map to the same closed codes.
- **One executor per working tree** (principle 4). With `worktree` on (the default) each session gets its own tree.
  With it off, a start is refused while any active session, a person's or a bot's, runs on the same project without a
  worktree.
- People's starts are untouched.

### 7. Audience from the existing kinds only (D-07, PD-11)

- The audience is decided server-side, never by the bot, and is never wider than the origin conversation's readers
  (R) ∩ the project's audience (P). Only the existing kinds of ADR-0030 are used:
  - P ⊆ R → `project`;
  - otherwise S = (R ∩ P) without the sponsor; when 1 ≤ |S| ≤ 100 → `people` with S;
  - when |S| > 100 → `people` with only the requester, if the requester has project access, else `owner`;
  - S empty → `owner`.
- The sponsor (as creator) and the device owner always see the session. People in the audience keep the visibility
  panel's rights.
- **Accepted limitation:** a `people` audience is a snapshot. Someone who later joins the conversation does not join
  the session, and someone who leaves it stays in the session's audience until removed there.

### 8. A bot controls only its own sessions; people keep control (PD-13)

- A bot prompts and stops only sessions with `started_by_agent_id` = itself and its own `bot_work_sessions` row.
  Anything else, including another bot's or a person's session, is `not_your_session`.
- Prompting needs an active profile and the hourly rate. An archived session answers `session_ended`.
- **Stop = archive.** It is allowed with an inactive profile, since a bot may always end its own session, and it
  records `stopped_by_agent` so the bot is not woken by its own stop. Interrupt is not exposed to bots.
- People in the audience keep prompting, interrupting and archiving the same session with their own rights, through
  the one arbiter: many controllers, one executor.
- **A bot never approves a runtime approval** (D-10). No route exists for it. A non-bypass session's approvals go to
  people.

### 9. The redacted read model and the session-output flag (D-05, D-20, PD-14, PD-15)

- `ocw_work_session_read` returns a normalized, bounded snapshot (PD-14):
  - status, runtime, model, mode, title and project name;
  - queue counts and the bot's own prompts (never a person's prompt text);
  - the newest assistant output after the cursor, at most 6 000 characters with the tail kept and `truncated` set;
  - at most 10 tool summaries;
  - the latest changes as at most 50 repo-relative files;
  - pending approvals (tool, repo-relative paths, summary);
  - up to 3 deciders, the error and the snapshot cursor.
- Every text passes `redactSecrets`; paths were already contained and redacted on the device (principle 7).
- The snapshot reads the stream's last `seq` first, then rows up to it. A read is allowed with an inactive profile, so
  the bot can report a failure. It counts against the turn's tool cap and is audited with ids, the cursor and a
  character count only.
- **Session output is not trusted input** (D-20). The runtime may have read web pages or untrusted files. A successful
  read sets `agent_turns.session_output_read`. From then on the claim refuses every other side-effecting call of the
  turn, except `ocw_work_session_prompt` and `ocw_work_session_stop` on the bot's own sessions.
  `ocw_work_session_start` after a read answers `session_output`. An ADR-0026 grant lifts it exactly as it lifts the
  taint. The plugin mirrors the flag locally. It does not mark prompts tainted.

### 10. Outside content (D-08, D-18, PD-15)

- **Start and prompt from a tainted turn** are allowed only with the profile's `actOnOutsideContent` on (claimed and
  audited with `outsideContent: true`). An admin turns it on, after this warning in words: "When this is on, the bot
  may start and prompt sessions right after reading outside content (MCP results, attachments, webhooks, mail, web
  pages). Text written by others can then steer what runs on the device. Full access still needs an isolated server."
- Full access after outside content runs only on an isolated server: an explicit request answers
  `outside_content_bypass`, an implicit default is lowered by the context.
- **Taint is sticky.** The session gets `tainted_at`, and from then on no bot turn of that session runs in Full access
  on a non-isolated device, even from clean turns.
- **Tainted prompts are visible** to people. The session's history marks them "After outside content".
- **The proposal fallback** (D-18). Without the flag, a tainted start creates no session. The route creates today's
  proposal itself (project, device, runtime, prompt; mode `default`) with `work_zone_proposals.tainted = true`, and
  answers `proposed`. The card shows the notice "Proposed after reading outside content. Read the prompt before you
  start it." A person still reviews the exact prompt and presses Start, which marks the first prompt tainted. This is
  the same reasoning ADR-0026 uses for an approval lifting taint for one call.
- A tainted prompt without the flag answers `outside_content`, with no fallback: a person can prompt. Stop is never
  blocked by taint.

### 11. Wake-ups: the second server-originated trigger (D-09, D-10, D-11, D-17, PD-16)

- **Trigger** (D-09). When a bot's session changes state, `setStatus` marks one pending wake per session
  (`bot_work_sessions.wake_pending`, the debounce). Only when it flipped, it enqueues the ids-only job
  `work_session.bot_sync` 3 s later.
- **What the handler does.** It always refreshes the live card when its fields changed. It wakes the bot only for a
  wake-worthy transition, and only when the pair (status, last completed prompt) differs from the last wake, which
  makes it idempotent across retries. The wake-worthy transitions:
  - `turn_done`: idle, nothing queued, and a newer completed prompt;
  - `waiting_approval`;
  - `failed`;
  - `ended`: completed, or archived by someone other than the bot;
  - `offline`: the device is offline.
- **Budget.** At most `wakes_per_session_day` per session per day (default 20). Past it, the card shows the neutral
  notice "Wake-up limit reached for today." and the skip is audited.
- **The wake turn's human is the original asker** (D-17), re-checked at each wake. If the asker no longer reads the
  conversation or is inactive, there is no wake, and the card shows "The bot can't post here any more."
- **Delivery.** The turn is delivered through `buildMentionEvents` on the card message as `agent.work_session.v1`,
  with `trigger: "work_session"`. It is unattended: no browser tools, no attachment listing. It starts tainted when the
  session is. Its body is a summary composed only from structured facts:
  - the transition, project name and turn number;
  - queued and changed-file counts, and the branch through `redactSecrets`;
  - pending approval counts and their tool names.
  It never contains runtime text, so a wake turn does not start with `session_output_read`.
- **Deciders** (D-10). The wake names up to 3 people the resolver allows to approve on the session: the sponsor
  first, then the device owner, then others by name. The bot cannot approve, the wake says so, and the bot mentions
  them (D-11: bots already notify the people they @mention; team mentions are 07.17).
- **Who pays and who is accountable** (D-09 as refined by D-17). Cell turns write no `ai_usage_records` row
  (ADR-0027 §5), and the bot's daily turn limit applies as for every turn. The asker is the turn's human. The sponsor
  stays accountable through the session's identity and subscription, the profile's limits and every audit row
  (`sponsorUserId`).

### 12. Where the tools are offered, and the asker's gate (D-21, PD-17)

- The four tools are offered, turn-scoped, on deliveries with `trigger` `mention`, `reply_mode` or `work_session`, in
  every conversation where `ocw_start_work_zone` can be offered today. Two conditions apply: the bot's profile is
  active, and the asker passes the Work Zone module gate (`work_session.read` at org scope) and reads the
  conversation (D-21).
- The asker needs no `work_session.create`: the session runs under the sponsor's rights.
- They are never offered on automation runs (07.17) or consult hops (ADR-0027's hops are unattended, and a consulted
  bot was not asked to start sessions).
- `ocw_start_work_zone` and `ocw_work_zone_projects` keep their offer rule unchanged. A bot without a profile gets
  byte-identical turns.

### 13. The live card and the way back (D-12, D-13, PD-12, PD-19)

- **The live card** (D-12). The start transaction posts a platform-owned `work_zone` Agent Card in the origin
  conversation's thread, on behalf of the requester (ADR-0020's surface). It shows:
  - the title "Work Zone · <project>";
  - Runtime, Project (the repository name, never the team project name), Device, Model, Mode ("Full access" for
    bypass), Step and Updated;
  - a status derived from the session's state;
  - the actions Open session (`/work-zone/<id>`) and Follow.
- **The card is viewer-neutral** (ADR-0031). It never carries a prompt, output, tool summary, error text or title
  (titles derive from prompts). Only the `bot_sync` handler updates it, server-side.
- A reader of the channel outside the session's audience sees the card, but the session itself answers 404 to them.
- **The way back** (D-13). `GET /work-sessions/:id` adds a per-viewer `origin`: the conversation, its kind and name,
  the thread and the card message. It appears only when the session has a `bot_work_sessions` row and the viewer can
  read that conversation, and never on `ws:` or `user:` frames.
- The session page shows "Back to <conversation>" from it, on desktop and mobile; browser back also works.
- **No `returnTo` parameter is read.** The stored origin is D-13's "or the stored origin". A client-supplied return
  target would be an open-redirect surface, and a viewer who cannot read the origin must not learn it.

### 14. Audit (D-14, PD-21)

- Agent actions are audited with `actorKind: "agent"`, the bot as actor and agent, the asker as user, the device and
  the session. Metadata: event id, `sponsorUserId`, project, session, mode, model, outcome, `outsideContent` and
  `promptChars`.
- Names:
  - `bot.work_session_started`, `bot.work_session_proposed`, `bot.work_session_prompted`, `bot.work_session_read`,
    `bot.work_session_stopped`, `bot.work_session_refused`;
  - `bot.work_session_woken`, `bot.work_session_wake_skipped`;
  - `bot.work_zone_profile_saved`, `bot.work_zone_profile_deleted`, `bot.work_zone_profile_outside_content_changed`;
  - `device.bot_consent_granted`, `device.bot_consent_updated`, `device.bot_consent_revoked`.
- **Never in a record:** prompt text, output, file names, paths or titles. This holds for audit rows, job payloads, log
  lines and `agent_tool_calls` rows, which carry ids, counts and lengths only.

### 15. Upgrade (D-16)

- One additive migration (`20261109173604_bot_work_zone`): four new tables and nullable or defaulted columns.
- Older code keeps working against the new schema.
- A bot without a profile behaves exactly as before. Nothing starts until a profile, a consent and, for Full access,
  the org policy, the device opt-in and the per-bot consent all exist.

## Consequences

- **What people see.** A bot answers a request by starting a session itself. A live card in the thread shows the
  runtime, project, device, model, mode, current step and last update, and opens the session. The session page leads
  back to the conversation.
  - Prompts a bot sent show the bot as author "for" its sponsor; prompts sent after outside content carry a visible
    chip.
  - Settings gain a Work Zone section on the bot, a Bots block and a read-only "Isolated server" row on the device, and
    an organization "Bot sessions at once" field (PD-20, built from the existing settings components, light and dark,
    desktop and mobile).
- **What bots can do.** Start sessions in their profile's projects on their profile's device, choose the model and the
  options within the profile, prompt, read and stop the sessions they started, and be woken when those sessions finish
  a turn, need an approval, fail, end or go offline. They can mention people for help.
- **What bots cannot do.**
  - Name a user, a device, an audience or a worktree.
  - Control a session they did not start.
  - Approve a runtime approval.
  - Run Full access outside §3.
  - Start or prompt after outside content without the admin's flag.
  - Start another session after reading session output in the same turn.
  - Use these tools on automation runs or consult hops.
- **Limits.** The caps in §6, the read caps and the daily wake budget bound a misbehaving bot. A `people` audience is a
  snapshot (§7). The bot's sponsor carries the session's rights: when they lose one, the bot stops.
- **The bot's own reports are visible by design** (RESEARCH Pitfall 6). What the bot writes in the origin
  conversation about a session (a summary, an excerpt, a link) is visible to that conversation's readers, who may be
  wider than the session's audience. The owner asked for the bot to report in the thread. The card itself stays
  viewer-neutral, and the bot only ever sees what its read model returns.
- **Release skew.** An older OpenClaw plugin skips the unknown `agent.work_session.v1` event and lacks the four tools,
  so its bots keep proposing as before. An older API never offers the tools.
- **Out of scope** (PD-30):
  - automation fan-out, the 5-minute schedule, team mentions and wider board moves (07.17);
  - a bot approving runtime approvals, and a bot controlling sessions it did not start;
  - bots driving the local browser (07.13);
  - per-person view, prompt and control levels (Phase 8 and 10);
  - Work Zone tools on automation runs and consult hops;
  - a live card for sessions people start (Phase 12 may reuse this renderer).
- AGENTS.md gains a "Bot Work Zone orchestration" row citing this record. Its ADR-0026 row now says that bots
  **without a Work Zone profile** propose sessions only the asker starts.

## Amendment (code review)

*Amended 2026-11-09, before the phase merged, from `07.16-REVIEW.md`. The decisions above stand; these points replace
or complete the parts they name.*

**The session-output mark is carried like the taint (CR-02).** This completes §9's "An ADR-0026 grant lifts it exactly
as it lifts the taint". `agent_turns.session_output_read` now travels everywhere `tainted` does for a turn that
continues another one:

- an ADR-0026 re-run starts with the mark when the asking turn has it (read live from the asking turn, as member data
  is), and the grant lifts it for its one claimed call only;
- an ADR-0027 consult return turn starts with it when the asking turn or a turn that answered the hop has it, and a
  read made after the answer came back marks the still-running return turns (the late-taint walk);
- the approval's card, headline and review show "Outside content" when the asking turn read a session's output, so
  the person who decides is warned. The stored request's own `tainted` is unchanged, and a re-run is never tainted by
  a session read alone.

**A bot's prompt that restarts a finished session is held to the start's caps (CR-03).** This completes §6 and §8
("Prompting needs an active profile and the hourly rate"). A prompt to a `completed` or `failed` session restarts it,
so it becomes active again. Under the bot's lock and then the organization's lock, the prompt is refused with
`too_many_sessions`, `org_limit` or (without a worktree, another active session on the same tree) `tree_busy`,
exactly as a start would be. People's prompts are unchanged.

**The wake's summary carries no runtime string (WR-01).** This replaces, in §11's Delivery list, "queued and
changed-file counts, and the branch through `redactSecrets`" and "pending approval counts and their tool names". The
branch and the tool names are chosen by the runtime, which may have been steered by what it read, and the summary is
the mention's text in the asker's name on a turn that starts without `session_output_read`. The summary now holds
fixed sentences, the repository name, the turn number and counts only (queued prompts, changed files, pending
approvals). The bot learns the branch and the tools through `ocw_work_session_read`, which sets the D-20 mark.

**After a read, the bot prompts only the session it read (WR-02).** This narrows §9's "except
`ocw_work_session_prompt` and `ocw_work_session_stop` on the bot's own sessions". A session's output could otherwise
steer a prompt into another of the bot's sessions, one in Full access on a non-isolated device included, without
marking it tainted. Now:

- a prompt on a turn with the mark is exempt only when the turn's successful reads (its allowed
  `ocw_work_session_read` calls) read that session and no other; otherwise it answers `session_output`, whose
  sentence now says the turn can prompt only the one session it read;
- a turn that carries the mark from another turn (a re-run, a consult return, a wake) names no session: it reads the
  session first;
- a wake turn starts with the mark when the bot already read that session from a turn in the same conversation,
  since the wake resumes that context;
- stop stays exempt for every one of the bot's own sessions: it only ends work.

A prompt to the session the turn read is still not marked tainted: that output came from the same runtime, which
already holds it.

**What a bot's session runs stays inside the profile's sets, defaults included (WR-03).** This completes §5's "when
absent, the profile default applies". A profile may restrict the models, efforts or context windows and name no
default. Then:

- a start with no model runs on the profile's first allowed model, never on the runtime's default outside the set;
- `createWorkSession` checks the effective values of a bot's start against the agent layer: the model named or the
  catalog's default, and that model's default effort and selectable context window when the bot names none. A value
  outside the set answers `setting_not_allowed` with the field (reason `bot_profile`), so the bot names a listed
  value. A fixed context window is never checked.

**The profile must still cover the session, not only be active (WR-04).** This completes §1's "re-checked at every
tool call and at every dispatch". For a session the bot started, the arbiter (`botLayerForSession`) and the prompt
route also require the profile's device and runtime to be the session's, and the session's project to be one of the
projects the profile lists and the sponsor can still start in. Otherwise the arbiter refuses the bot's queued prompt
(`bot_not_allowed`) and the prompt route answers up front: `profile_inactive` for another device or runtime,
`project_not_allowed` for the project, never `queued`. Read and stop are unchanged.

**A session keeps the sponsor it was started under (WR-05).** This completes D-02's "a change of sponsor is a re-save"
for live sessions. Start, read and stop already ran as the session's sponsor (`bot_work_sessions.sponsor_user_id`);
a prompt ran as the profile's current one. When someone else has re-saved the profile since the start, a prompt to
that session answers `profile_inactive`, and the bot starts a new session under the new sponsor. The bot may still
read and stop the old one.
