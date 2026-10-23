# ADR-0030: Shared Work Zone projects and one audience per session

## Status

Status: Accepted. **Date:** 2026-10-23. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.9-15) from the owner's decisions C-01 … C-06 and D-01 … D-14 in
`.planning/phases/07.9-shared-work-zone-projects-and-session-visibility/07.9-CONTEXT.md`, the planner decisions
P-01 … P-15 in `07.9-01-PLAN.md`, and the coordinator decisions taken while the phase ran (the 07.9 SUMMARYs, including
the fan-out and polish passes).

**Extends, without editing them:**

- [ADR-0009](0009-realtime-presence-and-live-reauthorization.md) (live re-authorization): a topic authorizer may refuse
  with a `cause` code, all access invalidations of a transaction are published before its frames, and a subscription
  being re-decided holds its frames (§ Live re-authorization).
- [ADR-0012](0012-full-access-mode-and-shared-devices.md) (shared devices): device grants now also decide who sees a
  session on a personal repository; they no longer reach sessions on a repository linked to a team project
  (§ Project access).
- [ADR-0019](0019-multiplayer-ai-chats.md) (grants decide, members participate; `aiAccessSql`): the same pattern is
  applied to Work Zone sessions, with a SQL rule shared by the resolver and every list (§ One rule for every reader).

Builds on [ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (the resolver), [ADR-0024](0024-module-access-per-unit.md)
(module rules and lead rules, applied as implemented) and [ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md)
(Work Zone proposals). None of them is edited. Supersedes nothing.

## Context

Until this phase a Work Zone "project" was a folder a device announced (`app.projects`), with no members and no
settings, and every Work Zone user of an organization saw every session: its list row, header, stream, diff,
attachments and approvals. The organization stream `org:<id>`, which every member reads (Work Zone on or off), also
carried each session's full DTO (title, branch, device name) and stored it.

The owner asked (2026-10-22) for shared team projects in which everyone has access, a per-project default for whether
a new session is public, and per-session audiences limited to specific people or the project's assigned teams: "very
visual, little visual noise, and everything easy to understand".

## Decision

### Team projects (D-01, D-10, D-13, D-14)

- **A team project is an org unit of kind `project`** (`app.org_units`). It always sits under a team or department
  (`ALLOWED_PARENT_KINDS`); there is no "Top level" option. Its people are its direct members (`unit_memberships`,
  member or lead) and the members of its **assigned teams** (`app.work_project_teams`: teams or departments).
- **Device repositories link to it.** `app.work_project_repos` links an `app.projects` row (a folder a device
  announced) to one team project, from any device: one project per repository, composite foreign keys on the
  organization, and the project unit cannot be deleted while a repository is linked (`unit_has_repositories`). A
  repository without a link stays a **personal project**, owned by its device.
- **Default for new sessions (D-03).** `app.work_project_settings.default_visibility` is `project` (an absent row means
  the same) or `owner`. It is "New sessions are visible to everyone in the project", on by default. Project leads,
  leads above the project and admins change it; the change is audited (`work_project.default_changed`). A personal
  repository's sessions start as Project (everyone who can use the device).
- **Who manages.** Every decision is the resolver's `work_project.manage` (team surface; admins and leads):
  - create a project under a unit, and assign or remove its teams: on the **parent** unit (admins, and the leads of the
    parent following ADR-0024's subtree rule). The creator becomes the project's lead automatically; a creator whose
    role cannot lead (a delegated allow rule) joins as a member.
  - **Assignable teams follow the resolver (D-14):** a unit can be assigned only by someone holding
    `work_project.manage` on that unit (admins: every team and department; leads: the subtree they lead). The list and
    `POST …/teams` use the same decision, so the list is never a UI-only filter.
  - **Removing a team is decided on the parent only,** so a lead of the parent can remove a team an admin assigned
    (consistent with D-10; ledger #325).
  - people, the default and repositories: on the project (its leads, leads above it, admins). **Linking also needs
    `device.use`** on the repository's device; **unlinking needs only `work_project.manage`**, so a repository on a
    revoked or unshared device can always be unlinked and its project deleted.
- **Managing a project opens its page (D-14).** `GET /work-projects/:unitId` and the index answer whoever holds
  `work_project.manage` or `work_session.read` on the project (the parent's leads included). The Settings tab is
  complete for them; the Sessions tab still lists only the sessions each viewer's audience allows, and
  `viewerCan.open` tells a manager outside the project from a member ("You manage this project but aren't in it").
- **The device owner always sees their own repositories** in `GET /projects`, even when one is linked to a project
  they cannot open; the project's name is then hidden (`teamProjectHidden`, "Linked to a project you can't open"), and
  `LinkableRepos` names a linked project only to people who can open it (`linkedToHidden`).
- **Starting a session in a team project needs both** project access and `device.use` on the device that runs it
  (403 `not_in_project`). Bot proposals (ADR-0026) are listed and accepted only where the turn's human could start,
  and the card says so before Start (`WorkZoneStartBlock` `not_in_project`).
- Every write is audited with ids only (`work_project.team_assigned`, `team_removed`, `repo_linked`, `repo_unlinked`
  with the session count, `default_changed`) and announced as `work_project.updated { unitId }`.

### Project access (D-02, D-14)

- **Team project:** its direct members ∪ the members of its assigned teams ∪ organization admins. An assigned team
  gives access to the members of that team **and of its child teams and departments, never to the members of projects
  nested under it** (the SQL ignores memberships of units of kind `project`; also in the `teams` audience, the
  "through {team}" reason and the member counts).
- **Personal project:** the device owner plus the device's grantees, exactly as `deviceModeCap(...) !== null`
  (ADR-0012), proved by a parity test. A revoked personal grant does **not** override the device's "shared with
  everyone": the person keeps seeing its sessions through the share. Sessions on a revoked device stay visible to its
  former grantees, as history (ledger #305).
- **Module rules still apply.** A session's resource carries the team project's unit path, so an ADR-0024 Work Zone
  deny on that path hides the session from members and admins alike. Module access is never a feature flag.

### One audience per session (D-04) and seeing is not controlling (D-05)

- `app.work_sessions.visibility` is one of `owner` (only the creator), `project` (everyone with project access),
  `teams` (chosen assigned teams, plus the owner) or `people` (chosen people with project access, plus the owner).
  The chosen entries are `app.work_session_grants`, one active row per subject, soft-revoked (the `ai_chat_grants`
  pattern).
- **An audience never reaches beyond project access.** An entry that falls outside it (a person who left the project,
  a team no longer assigned) stops granting access while its row remains, and the panel shows it as inactive. Writes
  are validated against the rule: 422 `audience_outside_project` / `team_not_assigned`, with entry ids only. The owner
  listed in `people` is implied and dropped; the same audience again is no change (no audit, no event).
- **Who may change it:** the creator, a project lead who can see the session, and admins (`work_session.visibility`,
  held through the `creator` relation, leads and admins). The device owner always sees the session but does not
  choose its audience. A change is audited as `work_session.visibility_changed` with kinds and counts, never names.
- **Seeing is not controlling.** The audience decides who sees and follows a session: its list entry, header, stream,
  diff, attachments and approvals view. Prompting, interrupting, configuring, approving and archiving keep their rules
  (role permissions and device access, ADR-0012), **and** the person must be in the audience. No new control level
  (view / prompt / full control) exists in this phase.
- **The device owner always sees (D-11)** sessions that run on their device, whatever the audience: their machine runs
  the work and they keep the 07.x approval and kill rights. The panel says so ("Runs on Ana's Mac — Ana can always see
  it").
- **The creator keeps their sessions (D-12).** A creator who left the project keeps read and archive; anything else is
  refused as `left_project` (unless they also own the device). The admin rule outranks `creator_left`.

### The deliberate D-06 narrowing and the irreversible blanking of stored `org:` payloads

Migration `20261023003251_work_zone_visibility` says both in its header:

- **D-06, narrowing on purpose.** Before it, every Work Zone user saw every session of the organization. From then on
  an existing session (audience `project` on a repository no team project links yet) is seen only by its creator, the
  device owner, the device's grantees and admins. Linking its repository to a team project opens it to that project.
  Existing sessions keep their creator and history. Plans 03 and 08 inventoried every existing API and e2e test that
  relied on organization-wide visibility and gave the second person explicit access; no assertion was loosened.
- **D-13, one-way redaction.** Every stored `org:` `work_session.updated` payload is blanked to `{}`; sequence numbers
  are kept so replay stays continuous, and every other event (the sessions' own `ws:` streams included) is untouched.
  The blanked snapshots cannot be restored; the rollback note says so.

### One rule for every reader (C-01, D-09)

- **The rule is SQL**, SECURITY DEFINER functions scoped to `app.organization_id`, not executable by PUBLIC:
  `app.work_project_access`, `app.work_session_access` (the facts: `creator`, `creator_left`, `device_owner`, `viewer`,
  `project_lead`, `admin`), `app.work_session_viewers`, `app.work_project_people`, `app.work_session_visibility_summary`,
  `app.work_project_repo_session_count`, and the id-only readers `app.work_session_shape` and `app.work_session_exists`.
- **The resolver decides with those facts.** `work-session/facts.ts` is the only builder of a session resource
  (`sessionResourceOf`, `sessionFacts`, `sessionFactsForUsers`, `sessionAccessSql`); a source scan fails if any other
  API file builds one or calls the SQL rule. The resolver adds the `viewer` relation, the `creator_left` state and one
  audience precondition for every `work_session.*` grain but `create`: it passes on `viewer`, `device_owner` or
  `creator` (not left), then on the admin rule; otherwise `left_project` or `not_in_audience`.
- **Every reader uses it:** the list, the detail, prompts, commands, interrupt, approvals, settings, controls, diff,
  archive, attachments, the `ws:` authorizer, Work Zone proposals (`listProposableProjects`), project pages, counts and
  the per-user delivery. Outside the audience, every `/work-sessions/:id…` route answers the same 404 body as an
  unknown id and the session is absent from the list. On control routes only `not_in_audience` becomes the 404; a role
  without Work Zone and deny rules keep their existing 403 (C-06).
- **Parity is tested:** SQL ⇔ `deviceModeCap` on generated fixtures (98 members × 96 sessions), and viewers ⇔ facts.
  A change to the rule changes the SQL and its TypeScript twin together or the test fails.
- **Admins are an explicit, audited rule (D-13), never a hidden bypass.** The SQL `admin` fact is never a relation;
  the precondition admits admins by name. Opening a session's detail that an admin sees **only** through that rule
  writes one `work_session.viewed_as_admin` row (ids only); lists, `ws:` and the visibility view write none, nor does
  an admin who is also a member.
- **Lead semantics are ADR-0024's, as implemented.** A lead of the project counts, and a lead of a parent unit counts
  wherever ADR-0024's subtree rule already applies to leads. `leadConfers()` (`resolve.ts`): leading a unit confers the
  `team` surface whatever the role, but a lead grain on any other surface still needs the role's surface, so a
  standard-role lead never gains `work_session.visibility` (Work Zone surface) and still gets `work_project.manage`
  (team surface).

### Per-user delivery (D-08)

- **Nothing about a session reaches `org:` any more**, live or stored. After commit, the session DTO goes **unstored**
  (ephemeral) on `user:<uid>` to each person the resolver lets read it: candidates from the SQL rule (seeing relations
  ∪ active admins) decided by the resolver, so module and deny rules apply. One coalesced delivery per session per
  transaction, never after a rollback.
- `org:` carries ids only: `work_project.updated { unitId }`. A person removed from an audience gets
  `work_session.removed { id }` on `user:<uid>`; `ws:<id>` carries `work_session.visibility_changed`, an id-only
  invalidator. The web list follows `user:` and refetches on `device.updated`, `units.updated`,
  `permission_rules.updated`, `work_project.updated` and reconnect (people who gain access by a link or a team
  assignment see the session on that refetch, by design; ledger #312).
- **The D-08 sentinel** (`work-session-sentinel.int.test.ts`) scans every serialized frame an outsider and a member
  with Work Zone off receive, live and by `org:` replay, plus the REST answers, for the title, branch and device name.
  Two mutations (the `org:` append put back; the resolver skipped) make it fail.

### Live re-authorization with a cause (ADR-0009 extended)

- A topic authorizer may refuse with a `RevokeCause` code: `visibility`, `role`, `device` or `module`, never a name.
  The `revoked` frame keeps `reason: "forbidden"` and gains the optional `cause`; the web's access-lost view words it
  ("Who can see it changed. Ask … if you need it back."). A `conv:` revoke carries no cause.
- Every narrowing re-decides `ws:<id>` within a second: removal from the project unit or a team unassigned or a
  repository unlinked or a device grant revoked → `visibility`; a Work Zone module rule → `module`; a role downgrade or
  a deactivated member → `role`.
- **Invalidate before publish.** All access invalidations of a transaction (`TxContext.root`, shared by savepoints)
  are published before any of its frames, on one Redis connection per process, so every gateway sees the invalidation
  first.
- **Frames are held while re-deciding.** A subscription an invalidation matched buffers its frames (at most
  `HOLD_LIMIT` = 1,000, then `resync`) until its re-decision answers: denied drops them with the subscription; allowed
  delivers them in seq order; an authorizer error keeps the subscription, drops the frames and sends `resync`.

### The per-organization background queue

- **After-commit work runs in an in-process queue** (`work-session/org-queue.ts`), so a request returns after its
  commit: per-user deliveries, `work_session.removed` notices, own-narrowing snapshots, and the Work Zone policy and
  device-access sweeps.
- **One serial lane per organization, at most 2 organizations at once:** per-session order is the commit order on the
  instance. **Coalescing:** a delivery is absorbed only by the delivery waiting at the tail (so a `removed` notice
  queued in between keeps its order); a sweep is dropped when the same sweep still waits. **Retries:** 3 runs in place
  (100 ms, then 500 ms), logged with ids (at most 20 plus the count) and an error code, never a message.
- **Sweeps run as the system** in 50-session transactions, reading the policy again for each; the policy sweep keeps
  the admin as the audit actor. Device-access changes invalidate first, then queue their sweep.
- **Shutdown:** the module's `close` drains the queue for at most 5 s (`BACKGROUND_DRAIN_MS`), then drops what waits
  and logs kinds and counts. Nothing dropped widens access: live views were re-decided at commit, lists refetch on
  reconnect, and every turn is still capped by its author's current access when dispatched.
- **Revocation never waits for the queue.** The live view is revoked at commit; deliveries trail; re-authorization of
  stored session settings is eventual, with the per-turn cap as the enforcement point meanwhile.

### The RLS backstop (`audience_backstop`)

- **Shape.** A RESTRICTIVE policy `audience_backstop` on `app.work_sessions` (a user request sees or writes a row only
  when `app.work_session_access` gives that user a seeing relation, `creator`, `creator_left`, `device_owner`, `viewer`
  or the `admin` fact, or the user created it), and on `app.work_prompts`, `app.work_approvals` and
  `app.work_session_grants` (the `EXISTS` form on `work_sessions`, no recursion). It is never permissive and
  `tenant_isolation` is unchanged. A `project_lead` fact alone sees nothing. A forgotten reader in API code gets no
  row.
- **A hidden row is `not_in_audience`.** A route that finds no session asks `app.work_session_exists`: an existing
  session is refused as the resolver's `not_in_audience` (the same 404 body, the `authz.denied` audit on non-GET as
  before, `cause: visibility` on a live re-decision); a missing one is a plain 404. A first subscribe never reveals a
  cause.
- **Facts about other people come from definer functions** (`work_session_shape`, `work_session_access`), never through
  the caller's RLS, so a caller's own audience never changes who else is decided as reading.
- **Its limits, on purpose:**
  - It covers **user requests only** (D-13). Transactions with no user (`app.user_id` empty: the device link, the
    re-authorization sweeps, the queue's system snapshot) pass explicitly.
  - It is **not a defence against a compromised `ocw_app` role**, which can set an empty user id; it guards against API
    code that forgets the resolver.
  - `app.device_commands` and `app.stream_events` are not covered. FK cascades are not subject to RLS. GET denials are
    still not audited (pre-existing design).
  - `WITH CHECK` judges the row as it was before the statement (and passes `created_by = current user` first, which
    `INSERT … RETURNING` needs), so a lead may narrow a session past themself; USING hides it afterwards, and the PUT's
    answer and `ws:` snapshot are built from what the request stored and a system snapshot after commit.
- **Follow-up:** an explicit system actor, so an empty user id is denied by default instead of "no user passes"
  (ledger #322).

### Measured performance (local testcontainer, `list-perf.int.test.ts`)

5,000 sessions over 20 devices, 10 team projects, 201 members. Budgets are about four times the local measurement and
are never raised to pass.

| Reader | Measured (median of 3) | Budget |
|---|---|---|
| `GET /work-sessions` as a member who sees 50 of 5,000 | 332 ms | 3,000 ms |
| `GET /work-sessions` as an admin (5,000) | 871 ms | 5,000 ms |
| Who can see (`GET …/visibility`, ~118 viewers) | 88 ms | 1,000 ms |
| Projects index | 116 ms | 1,000 ms |
| Project detail | 20 ms | 500 ms |
| Draft preview / draft people (rolled-back savepoint) | 91 ms / 61 ms | 1,000 ms |
| `PUT …/visibility` (delivery queued) | 147 ms | 1,500 ms |
| Device access change over 250 sessions: the request / the background sweep until delivered | 1 ms / 6,993 ms | 500 ms / 20,000 ms |
| `PUT /work-zone-policy` with 2,000 live sessions: the request / re-checked / delivered | 8 ms / 12,691 ms / 49,536 ms | 500 ms / 50,000 ms / 200,000 ms |

The list's rule runs once per row, in the policy (about 0.06 ms per call); the select list calls it only on the rows
the backstop keeps. Delivery costs about 18 ms per session at 200 members. Live re-decisions answer in 11–33 ms.

## Consequences

- A session is seen by exactly its audience within project access, plus its creator, its device owner and admins
  (audited), in every reader, live and stored, with the database refusing a forgotten reader for user requests.
- Organizations that relied on "everyone sees every session" lose it on upgrade, on purpose; linking repositories to
  team projects restores sharing where it is wanted. `docs/DEMO.md` › Shared Work Zone projects and session visibility
  says so in its first paragraph.
- Every new path that reads a session must go through `facts.ts`; the source scan, the parity test, the sentinel and the
  registry-derived cross-tenant matrix (every `/work-projects*`, `/visibility*` and `/audience/*` route) make a bypass
  fail in CI. The new security paths are in `.github/CODEOWNERS` and two are required areas of `pnpm guard`.
- After-commit work is eventual and ordered per organization; operators see it only as the request returning sooner.
- No new dependency, no hosted service; everything runs with `docker compose up` (C-04).

### Validation

Unit, web and integration tests (real PostgreSQL and Redis; parity, sentinel, backstop, cross-tenant matrix, scale),
the isolated e2e on both Playwright projects (every Work Zone spec plus the four new 07.9 specs, at 1440 and 390, light
and dark, axe and 44 px targets), and `pnpm gate:compose`; recorded in `07.9-VALIDATION.md`. **Owner check pending:**
`docs/DEMO.md` › Shared Work Zone projects and session visibility.

### Deferred

- From the phase brief: per-person control levels (view only, prompt, full control: PRD §29 grains, Phase 8); project
  channels and project-level files; repositories not tied to a device (cloud repos); sharing a session outside its
  project (guests).
- The explicit system actor for the backstop (#322); one queue lane per organization, so a big sweep delays that
  organization's other deliveries (#330); the in-memory queue, so a crash loses pending sweeps, plus the
  cross-transaction window of one Redis round trip (#331).
- The open 07.9 ledger entries at the gate, by id: #305 (recorded above as a decision), #312, #313, #315, #316, #319,
  #322, #324, #325 (recorded above as a decision), #329, #330, #331, #332 (`.planning/WINDOWS.md`; #317, the
  `WorkProjectSummary` comment, is fixed by this gate). The ones that
  change behaviour: a session appears to people who gain access only on the next list refetch (#312), an editor can
  remove themself through Teams without a warning (#315, #319), and the Project row of the panel shows no count after
  a narrowing (#319).
