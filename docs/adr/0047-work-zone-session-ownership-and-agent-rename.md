# ADR-0047: Work Zone session owners move by Assign to me on servers; people and the session's agent rename sessions under naming rules

## Status

Status: Accepted. **Date:** 2026-11-27. **Deciders:** Víctor Ruiz (Autofy Labs). Requested by the owner on 2026-11-27
("en la Work Zone una vista para ver de quién es cada sesión y poder asignársela a sí mismo; asignarse solo cuando sea
en un servidor […]; renombrar a mano las sesiones; una herramienta para que la IA las renombre siguiendo una forma
especificada") and decided under the owner's standing autonomy grant: decisions D-01 … D-15 in
`.planning/phases/07.13.1.1-work-zone-session-owners-a-sessions-by-person-view-assign-to/07.13.1.1-CONTEXT.md`, taken
from the research in `07.13.1.1-RESEARCH.md` in the same folder. The owner approved the proposal as written
("publícalo todo"). First shipped in v0.5.3.

**Extends, without editing them:** [ADR-0014](0014-automatic-session-titles-on-the-device.md) (titles),
[ADR-0030](0030-shared-work-zone-projects-and-session-visibility.md) (the owner's place in a session's audience) and
[ADR-0035](0035-work-zone-local-browser.md) (the on-device tool bridge). **Supersedes:** none.

**Builds on:** [ADR-0012](0012-full-access-mode-and-shared-devices.md) (device sharing, `device.use`, Full access),
ADR-0014, ADR-0030, [ADR-0031](0031-work-zone-sidebar-and-per-viewer-session-fields.md) (per-viewer fields only on
per-viewer surfaces), [ADR-0033](0033-headless-work-zone-server.md) (headless servers and their host kind), ADR-0035
and [ADR-0038](0038-bot-work-zone-orchestration.md) (bot-started sessions and their sponsor).

## Context

- **The owner already exists.** `work_sessions.created_by` is read as the session's owner everywhere: the SQL rule
  `app.work_session_access` emits `creator` / `creator_left` from it, the RLS `audience_backstop` lets that user write
  the row, the resolver's `creator` relation grants approve, archive and visibility, the contracts and the web call it
  "owner" (`createdBy`, `createdByName`), and a bot-started session's sponsor is that column (ADR-0038). Nothing
  could move it.
- **Only the device knows what it is.** `devices.host_kind` (`desktop` | `service`, null when not reported) comes from
  the Device Link hello (`DeviceInfo.host`); no server or web route sets it (ADR-0033). The desktop app's daemon says
  `desktop`; an installed headless runtime says `service`.
- **Titles have a source.** `title_source` is `user` (typed, never replaced), `heuristic` (the first line) or `auto`
  (generated on the device). The device titles once, from the first prompt, at 2–5 words and 32 characters (ADR-0014).
  People could not rename a session afterwards, the agent could not either, and nothing told the generator how a
  company names its work.

## Decision

### 1. The owner is `created_by`, and Assign to me moves it (D-02, D-03, D-11)

Option A of the research: Assign to me UPDATEs `work_sessions.created_by` under the session lock, in the new owner's
own tenant transaction. Every owner rule moves at once: `app.work_session_access`, the visibility summary, the viewers
list, the RLS backstop and the resolver's `creator` relation. **No SQL function, RLS policy or column changes for
ownership.** The backstop judges the UPDATE as it should: `USING` sees the new owner as a viewer of the old row and
`WITH CHECK` sees them as the owner of the new one; the previous owner cannot reclaim the row through a raw query.

| | A. UPDATE `created_by` (chosen) | B. A new `owner_user_id` |
| --- | --- | --- |
| SQL / RLS | unchanged; every rule follows | two CASEs, the summary and two backstop clauses rewritten |
| TypeScript | the new routes only | ~50 call sites renamed; a missed one keeps the old creator's rights |
| Migration | none for ownership | a NOT NULL column filled from another, which N-1 code would not insert |
| History | the immutable `work_session.created` audit, `work_session.assigned` and a timeline line | the same, plus the column |

The original creator is never erased: `work_session.created` keeps them, every transfer writes one
`work_session.assigned` row, and the timeline gets the server-only event `session.owner_changed { fromUserId,
toUserId }` ("Ana took over this session from Luis"). It is in `SERVER_ONLY_SESSION_EVENTS` beside `account.switched`,
so a device can never write it. The session's conversation follows: the new owner becomes its `owner` member, the
previous one a `member`. The schema now reads `created_by` as "the session's owner, its creator until an Assign to me".

### 2. Who may, and where (D-04, D-05, D-12)

`POST /api/v1/work-sessions/:id/assign` decides, in this order, with `decideAssign` (`assign.ts`):

1. The session is locked in the caller's tenant transaction; outside the audience, another organization's id or a row
   RLS hides is 404 `SESSION_NOT_FOUND`.
2. The caller may prompt the session (`work_session.prompt` through the resolver): read, audience, the Work Zone
   module and the revoked-device gate. A reader who cannot prompt cannot take a session over. A revoked device answers
   409 `device_revoked`, any other denial the resolver's 403.
3. Not started by a bot (`started_by_agent_id` set): 409 `bot_session`. The ADR-0038 sponsor model stays.
4. Not archived: 409 `archived`.
5. Already the owner: 200, nothing written.
6. The device is not revoked: 409 `device_revoked`.
7. The device reports `host_kind = 'service'` exactly; `desktop` **and null** are 409 `not_on_server`.
8. The caller may use the device (`device.use`, `assertDeviceUsable`, ADR-0012): 403 `device_not_shared`.

Every refusal has one fixed sentence (`ASSIGN_REFUSAL_TEXT`), writes nothing and is what the web shows in place of the
menu item ("Only sessions on a server can be assigned.").

**`host_kind` is self-reported by the device, so it is the device owner's label.** The desktop app's launcher always
sets `OCW_RUNTIME_HOST=desktop` over any inherited value (`buildDaemonEnv`) and the daemon lets that variable win
(`resolveHostKind`); both are pinned by tests. Only a daemon run outside the app, or installed as a service, reports
`service`. A device owner can still label a laptop daemon a server; that only widens Assign to me on their own device,
among the people they already let use it. **Server-only is therefore a product rule, not a security boundary.** Every
`work_session.assigned` audit row carries `hostKind` and `deviceOwnerId`, so an audit reader sees whose label allowed
the transfer.

### 3. What a transfer changes on a live session (D-05, D-13, D-15)

- **No cut turn.** The session is re-decided for the new owner with `reauthorize(…, { interruptInFlight: false, cause:
  "owner_changed" })`: settings above what the new owner may use drop between turns, a running Full access turn
  finishes. The device gets `session.configure` with the existing wire reason `access_changed` (a new reason would
  break the closed enum older daemons parse); the cause is only in the `work_session.settings_downgraded` and
  `work_session.full_access_left` audit metadata. Every other caller of `reauthorize` behaves as before.
- **Queued prompts of people who lose access are cancelled** in the same transaction, each emitted and audited
  (`work_prompt.cancelled { cause: "owner_changed" }`), so a prompt never runs in a session its author can no longer
  see. The arbiter `tryDispatch` is unchanged.
- **The previous owner is not re-added.** On an `owner` session they lose access unless they own the device; on a
  `people` session they lose it unless they are listed. The confirm dialog says so before the transfer.
- **Next turns run as their author**, as before: each prompt is decided for whoever wrote it at dispatch. Pool
  accounts, sign-ins on the server and the device's own state do not depend on the owner, so the device is told
  nothing else.
- **Live delivery** copies the visibility route: `session.owner_changed`, then `work_session.visibility_changed` on
  `ws:` (every subscription, the browser live view and the sign-in access watch are re-decided; a loaded sign-in the
  load rule no longer allows closes the page with `access_lost`, the turn continues), the session DTO per user (never
  `org:`) and `work_session.removed` to the people who lost it, after commit.
- **Audit:** one `work_session.assigned { from, to, visibility, hostKind, deviceOwnerId, removedCount,
  cancelledPrompts, settingsDowngraded }` with the new owner as actor: ids, labels and counts only.

### 4. The preview (D-13)

`GET /api/v1/work-sessions/:id/assign` answers an `AssignPreview` for the confirm dialog: who loses access, how many
queued prompts are cancelled, whether the settings drop. It runs the same pure transfer (`computeTransfer`) inside a
savepoint that is always rolled back, and every side effect (events, deliveries, device commands, audits, chat posts)
lives only in the POST after it. A refusal is a 200 `{ allowed: false, reason }` with no savepoint. The session detail
carries a per-viewer `assign { allowed, reason }` from the same check, and every session DTO a viewer-neutral
`deviceHostKind` (ADR-0031: per-viewer fields only on per-viewer surfaces). The client decides no access.

### 5. Manual rename (D-06, D-14)

`PATCH /api/v1/work-sessions/:id { title }`, decided with `work_session.configure` (the grain of the session's
settings), 409 `session_archived` when archived. The title is the typed-title rule (`TypedSessionTitle`: trimmed, 1–200
characters, one line, no control character or home-directory path), not the 32-character machine shape: a person may
type "Fix". It is stored as `user`, so no automatic title or agent ever replaces it; the conversation's name follows,
the bot card is synced and every open view gets it through `work_session.updated` on `ws:`. Audit
`work_session.renamed { by: "user", length }`, never the text. One `applyTitle` (`rename.ts`) serves people and the
agent.

### 6. The agent's `ocw_session` tool (D-07, D-14)

The session's agent, on Claude Code and Codex, gets one MCP server `ocw_session` with one tool, `rename`, beside
`ocw_browser` and separate from it (the rename tool must not depend on the browser's availability, approval rules,
shadow check or token directory):

- **Claude Code:** an in-process SDK MCP server (`createSdkMcpServer`), registered with `ocw_browser` at launch and on
  every `setMcpServers` between turns. `canUseTool` allows `mcp__ocw_session__rename` without asking a person, but
  only when the server is our registered `sdk` one; the PreToolUse hook denies a foreign `ocw_session` in every mode,
  bypass included, and a project server of the same name turns our tool off for the session.
- **Codex:** the hidden `ocw-runtime session-mcp` stdio shim, started with `-c mcp_servers.ocw_session.*` overrides
  (`default_tools_approval_mode = "approve"`, `tool_timeout_sec = 30`). It authenticates with a 64-hex token in exactly
  `<ocwHome>/run/sessions/<sessionId>/shim-token` (0700 directory, 0600 file, removed at session end, swept at start;
  only the path is in argv or env) and relays each call as the strict `sessionToolCall` on the daemon's 0600 control
  socket. No port. If the daemon does not recognise the token the shim exits before serving and Codex runs without the
  tool. A change of whether the tool is offered restarts the app-server between turns; elicitations for `ocw_session`
  are answered only while our overrides run.
- **Device pre-checks**, before any frame: the tool is offered, a turn is in flight, the turn's grant carries
  `sessionTools`, the title is not person-typed, the turn has not renamed yet, and the title has the generated shape
  (strict input, at most 32 characters and 5 words before normalizing, then `normalizeSessionTitle`, `sanitizeString`
  on the raw and normalized text and `SessionTitle`). A title with a path or a secret is refused, never fixed.
- **The API decides** each `session.rename { requestId, sessionId, promptId, title }` from the device and answers
  `session.rename.result` on the requesting socket only (never queued, published or logged), with the
  `browser.signin.load` pattern (`hub.replyOn`). In a device-tenant transaction under the session lock, in order: the
  session runs on this device (`not_available`), it is active and `promptId` is one of its prompts in flight
  (`no_turn`), the title is not `user` (`title_locked`), `SessionTitle` passes (`invalid_title`, which does not spend
  the turn), and the turn's single rename is claimed with `work_prompts.title_renamed_at` (`already_renamed`). Then
  `applyTitle(…, "auto")`: an agent's title is stored as `auto`, so a late device title (which replaces only
  `heuristic`) never overwrites it, the agent may rename again in a later turn, and a person's title always wins.
  Audit `work_session.renamed { by: "agent", promptId, length }` with the device as actor, the prompt's author as user
  and its agent when a bot wrote it.
- **Once per turn** is the rate bound; turns are already bounded by people and by the bot caps. The device waits 5 s
  for the answer; offline, an abort or the session ending answer `not_available`.
- **Provenance in the timeline:** the call shows as `ocw_session_rename` ("Renaming the session"), completed with the
  result sentence only (`Renamed the session to "…".` or one of the fixed refusal sentences), never its arguments.

### 7. Naming rules (D-08, PD-16)

- **Two settings:** the organization's `work_zone_policies.session_naming_rule` (Settings › Work Zone policy › Session
  names, `work_zone.manage`) and the project's `work_project_settings.naming_rule` (the project's Settings tab,
  `work_project.manage`). Free text, at most 600 characters each, LF and TAB the only control characters; blank is
  stored as null. The project's comes after the organization's; personal repositories get the organization's only.
- **Organization data, never logged or audited.** A change is audited by key (`work_zone_policy.updated.changed`
  lists `sessionNamingRule`) or length (`work_project.naming_rule_changed { length }`), never the text. A rule-only
  change re-decides no session.
- **Where the text lives.** Besides the two settings rows, the joined text (`joinNamingRules`: each part trimmed,
  every `naming-rules` tag stripped until none can be rebuilt, joined by one blank line, at most 1,202 characters) is
  stored only inside the `session.title` command's payload in `device_commands` (`namingRules`), as that command's
  prompt already is. `sessionTools { rename, namingRules }` is decided at send time and added only to the sent copy of
  `session.start` / `prompt` (`hydrateCommand`); the stored command never carries it.
- **Where it goes.** The device title call wraps the rules in `<naming-rules>` tags after a sentence that frames them
  as wording data that never changes the limits (`titleInstructions`); the title call keeps no tools, no settings
  sources and a read-only, ephemeral Codex thread. The rename tool's description ends with the same delimited rules
  (built per session by `renameDescription`), not a system-prompt append, so the agent's preset and the repository's
  own `CLAUDE.md` / `AGENTS.md` keep their place and authority.
- **Untrusted text.** Rules are written by admins and project leads, who need not own the devices nor write to the
  repository, yet would land in other people's session agents: bounded, delimited, framed as data, shown in the web as
  plain text only, never executed or interpolated into SQL or HTML.
- **Never in a Full access turn.** Framing in a tool description is not a boundary, so the API sends
  `sessionTools.namingRules: null` (the tool keeps a fixed, rule-free description) whenever the command's turn mode
  or the session's mode is `fullAccess`, where a step a rule asks for would run without any approval
  (`prepareSessionTools`). The rules are also sent only beside the tool: `rename: false` (a person typed the title)
  always comes with `namingRules: null`. The title call is unchanged and keeps the rules in every mode (no tools,
  ephemeral, output normalized), so automatic titles still follow them; an agent rename in a Full access session
  follows only the generated-title shape.
- **Staleness.** Titles pick a rule change up at the next title call; Claude Code re-registers the server between
  turns when the rules differ; **a running Codex app-server sees a new rule only at its next start** (a wake-up, an
  account switch or an offered change).
- **The shape wins.** `normalizeSessionTitle` keeps titles at 2–5 words and 32 characters, sentence case, without a
  leading `#` or trailing punctuation, whatever a rule says. A rule like "Title Case, prefix #TICKET" cannot be
  honoured; the field's helper says so.

### 8. Compatibility, no protocol version bump

Every new key is optional and the payloads that carry them are non-strict on the device (`SessionStartPayload`,
`PromptPayload`, `SessionTitlePayload`), so no hello flag or protocol version is needed:

- **An older daemon with this API** strips `sessionTools` and `namingRules`: no rename tool, titles without rules,
  nothing else changes. It never sends `session.rename`.
- **This daemon with an older API** never receives `sessionTools`, so it never offers the tool.
- **Older web clients** ignore the new optional DTO fields. One additive migration (`20261127204827_session_owners_rename`:
  the two rule columns with their checks and `work_prompts.title_renamed_at`); N-1 inserts keep working.

## Extends, without editing

| Clause (verbatim) | Where | What now applies | What stays |
| --- | --- | --- | --- |
| "`owner` (only the creator)" | ADR-0030, Decision, "One audience per session" | `owner` means the session's owner: its creator until an Assign to me moves `created_by` to the person who took it over (§ 1, § 2). | The four audiences, project access as the ceiling, the device owner always sees, admins explicit. |
| "The creator keeps their sessions (D-12)." | ADR-0030, same section | The rule applies to the current owner; a previous owner keeps nothing of `creator` / `creator_left` after a transfer. | `creator_left` keeps read and archive for an owner who left the project. |
| "`user`: typed by a user, never replaced." | ADR-0014, Decision, "Title source (P-14)" | A person can type a title at any time from the header or the row menu (§ 5); the session's agent writes `auto` titles, never over `user` (§ 6). | The three sources, the 2–5 words / 32 characters shape and the device's first-prompt title, now with naming rules (§ 7). |
| The in-process SDK server and the `-c mcp_servers.*` stdio shim for `ocw_browser` | ADR-0035, Decision | A second server, `ocw_session`, reaches both runtimes by the same two transports with its own token directory, its own provenance checks and no dependency on the browser (§ 6). | Everything about `ocw_browser`. |

## Consequences

- **No SQL or RLS change** for ownership; the phase's only schema change is the additive migration of § 8.
- **Server-only Assign is a label the device owner sets** (§ 2), audited with `hostKind` and `deviceOwnerId`.
- **One more Node process per Codex session** (the `session-mcp` shim, beside the browser shim when the browser is on).
- **Naming rules can only shape wording** within 2–5 words and 32 characters.
- **The Work Zone shows owners:** the header's owner chip (a line on phones), "Assign to me…" and "Rename…" in the
  session's menu, the take-over line in the timeline, and **Sessions by person** (`/work-zone/people`: grouped by
  owner, filters by person, project and device, the same readable list as the sidebar, no new visibility).
- **Older runtimes** keep working without the tool until they update to 0.5.3 (service devices update themselves,
  ADR-0040; desktop apps update with the app, ADR-0046).
- AGENTS.md's "Shared Work Zone projects" and "Runtime adapters" rows cite this record.
- **Deferred:** assigning a session to someone else, admin bulk reassignment, renaming AI chats, naming rules per team.

### Validation

The tests of the phase's plans: the contracts (`work-session.test.ts`, `work-session-tools.test.ts`); on a real
ephemeral PostgreSQL the migration and N-1 inserts (`session-owners-schema.int.test.ts`, `upgrade.int.test.ts`) and the
proof that moving `created_by` moves every owner rule (`work-session-audience.int.test.ts`); the transfer, every
refusal, cross-tenant 404, no cut turn, cancelled prompts, the people audience and a side-effect-free preview
(`assign.int.test.ts`), the reclaim refused by the backstop (`backstop.int.test.ts`), the manual rename
(`rename.int.test.ts`), the agent rename over the Device Link (`rename-agent.int.test.ts`), the rules' storage and audit
(`policy.int.test.ts`, `projects.int.test.ts`) and their delivery (`session-tools.int.test.ts`); on the device the relay,
tool text, Claude server and host kind (`session-tools/*.test.ts`, the daemon's "07.13.1.1 session tools" cases,
`daemon-launch.test.ts`), the Codex shim on a synthetic fixture derived from the browser-mcp recording
(`mcp-shim.test.ts`, `codex-session.test.ts`) and the rule-aware titles (`title.test.ts`); the web components and
screenshots at 390 and 1440 px in both themes; the CI-only end-to-end journey on a `service` and a `desktop` fake device
(`work-zone-session-owners.spec.ts`). No test uses a real login, the real `~/.ocw` or a metered API. Assign to me on a
real headless server, a real Claude Code and Codex rename under a rule, and an older runtime left at 0.5.2 are the
owner's UAT (`07.13.1.1-VALIDATION.md`).
