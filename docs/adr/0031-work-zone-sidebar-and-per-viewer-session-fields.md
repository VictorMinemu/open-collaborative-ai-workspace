# ADR-0031: Work Zone sidebar by team and per-viewer session fields

## Status

Status: Accepted. **Date:** 2026-10-27. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.10-06) from the owner's decisions C-01 … C-03 and D-01 … D-10 in
`.planning/phases/07.10-work-zone-sidebar-by-team/07.10-CONTEXT.md`, the UI contract `07.10-UI-SPEC.md`, the planner
decisions PD-01 … PD-14 and the reconciliation X1 … X6 in `07.10-01-PLAN.md`, and the 07.10 SUMMARYs.

**Extends, without editing it:** [ADR-0030](0030-shared-work-zone-projects-and-session-visibility.md) (shared Work Zone
projects and one audience per session). ADR-0030 says a device owner outside a project sees their own repositories
with the project's name hidden (D-14); this record extends that rule from `GET /projects` to every session surface
(§ Per-viewer session fields). Supersedes nothing.

## Context

After phase 07.9 shipped, the Work Zone sidebar was still one flat list of sessions, with each project as a badge on
its sessions. The owner did not see projects in the sidebar and asked (2026-10-27) for it to work "como por canales
según el equipo… piénsalo bien para que sea usable para mucha gente": grouped by team like the chat sidebar, and usable
by organizations with hundreds of members and projects. The coordinator proposed the layout (sections by department,
only the projects you belong to, at most three active sessions per project, "Needs you" on top, "Personal" at the end,
"+" actions, Browse projects for the rest) and the owner approved it ("perfecto, ponte a ello de forma autónoma").

Grouping by team needs two things the API did not say: where each project sits (its team and department) and how the
viewer belongs to it; and, for "Needs you", whether a session waits on this viewer.

While planning, reading the code showed a leak of 07.9 D-14 (PD-02). `WorkSessionService.load` put the session's team
project (id and name, from `app.work_session_visibility_summary`) on every session DTO, whoever asked. The list, the
detail, the `user:` delivery and the durable `ws:` snapshot all carried it. So the owner of a device whose repository
is linked to a project they cannot open (ADR-0030 D-11: the device owner always sees sessions on their device) read
that project's name on every session surface, although `GET /projects` already hid it from them. Plan 07.10-02 proved
it with a failing integration test (`viewer-fields.int.test.ts`: Dana, the device owner, read `{ name: "Payroll" }`)
and the sentinel's new device-owner watcher (`user:` frame named Payroll), then fixed it at the source.

## Decision

### Per-viewer session fields (PD-03, PD-04, PD-05)

- **Three fields on `WorkSession` are decided per viewer**, additively (contracts first):
  - `teamProject` (`{ id, name }` or null): named to a viewer only when the resolver lets them open the project
    (`work_session.read` on its `work_project` resource, built from `app.work_project_access`: the same decision
    `GET /projects` makes for D-14), or when the viewer created the session (D-12: a creator who left keeps the name
    the composer line "You left {project}" already shows).
  - `teamProjectHidden` (`true` or absent): set, with `teamProject: null`, for anyone else who reads a session of a team
    project (the D-11 device owner outside it; a person granted the session alone). The client then shows the session
    under its repository with "Linked to a project you can't open" and never a project name.
  - `attention` (`{ approval, lastTurnEndedAt }`): `approval` is true when the session has a pending approval and the
    resolver lets this viewer decide it (`work_session.approve` on their session facts from `facts.ts`, the detail's
    `viewerCan` decision; a Tool-layer rule still decides when the approval is answered). `lastTurnEndedAt` is the end
    of the session's most recent dispatched prompt that completed or failed, only when that prompt's author is the
    viewer; null otherwise. A queued prompt is not a reason (UI-SPEC U-3).
- **Where they travel.** Only on the viewer's own surfaces: `GET /work-sessions` and `GET /work-sessions/:id` (shaped
  for the requester) and each per-user `user:<uid>` frame (one DTO per recipient, shaped for that recipient; the
  recipient decision of ADR-0030 is unchanged).
- **Fail closed everywhere else.** The shared, durable `ws:<id>` stream (live, and replay: stored snapshots are
  stripped on read, 07.10-07) and the public `WorkSessionService.session()` / `sessions()` return the viewer-neutral
  DTO (`withoutViewerFields`), with none of the three fields. A route that forgets the shaping answers less, never more. So `POST /work-sessions`, the settings PATCH
  and `/controls` now answer without `teamProject`; the web only invalidates on those answers. The session view keeps
  the per-viewer values of its REST snapshot across `ws:` snapshots (`mergeSessionSnapshot`).
- **One place decides.** `apps/api/src/modules/work-session/viewer-fields.ts` (`loadViewerFields`,
  `loadViewerFieldsForRecipients`, `projectNamedFor`, which the visibility panel also uses since 07.10-07,
  `withViewerFields`, `withoutViewerFields`). It reads `app.work_project_access` once per list or delivery batch and the
  last turns with one `DISTINCT ON` query per list or batch. The list and the detail decide in memory through the
  request's resolver; the `user:` delivery asks the resolver once per distinct project and once per session with a
  pending approval (`usersAllowed`, capped by the delivery batch; review ME-02, open). It is in `.github/CODEOWNERS`
  with the 07.9 Work Zone security paths.
- No SQL function, migration, RLS policy, realtime topic or endpoint was added; the audience rule stays in `facts.ts`
  (the one-builder source scan still passes).

### Placement and membership in the projects index (PD-06)

- `GET /work-projects` adds, on the rows it already returns (no row added or removed): `parent { id, name, kind }` (the
  project's team or department), `top { id, name, kind, viewerIsMember }` (its department, the first unit of its path)
  and `membership`: `lead`, `member` or `team` as `app.work_project_access` reads it; `manager` for an admin or for a
  row kept only by `work_project.manage` (a lead above the project, D-14). `membership` labels a row; it never grants
  one. `viewerIsMember` uses the chat sidebar's member-unit semantics (a unit membership whose path holds `top.id`),
  read once per request.
- `GET /work-projects/parents` adds `topId`, so the client knows in which department the viewer may create.
- A project whose parent or top unit is not a team or department is a broken invariant (ADR-0030 D-13); the index
  throws rather than inventing a reference.

### The sidebar scope rule (PD-07): grouping, not access

The browser only groups what the two list responses already returned; it never decides access.

- **Rows are the projects the viewer belongs to:** index rows with `membership` `member`, `team` or `lead`, grouped
  under their department (the viewer's own departments first, then by name), with the team as a pill when the project
  sits under a team. An admin or a lead above a project (`manager`) does not get its row; Browse projects and search
  reach it. The sidebar grows with the viewer's memberships, not with the organization.
- **A session goes** (a) under its project when its `teamProject` is one of those rows (at most 3 active sessions, then
  "+N more" to the project page; the open session always shows); (b) under Personal, by its repository, when
  `teamProjectHidden` is true, or it has no project and its repository is one of the viewer's personal repositories,
  or the viewer created it (X1); (c) nowhere in the tree otherwise (admin- or manager-only sessions: search, the
  project page and Browse projects reach them).
- **Needs you and Settled draw only from (a) ∪ (b).** An admin-only approval never fills an admin's Needs you. Settled
  survives as a collapsed section at the end, in that scope, 10 rows then "Show {n} more" (UI-SPEC decision on D-04:
  history stays one click away).
- **Search** reads only names the two responses carry; a session with `teamProjectHidden` never matches on a project
  name.
- **Collapse** is remembered per browser (`ocw.workzone.sidebar.v1`), like chat. A collapsed section keeps the open
  project, the open session and the sessions that need the viewer, and shows a hidden count.
- **Two requests at any size** (D-09): `/work-sessions` and `/work-projects`, plus `/work-projects/parents` only when
  `viewerCan.create`; per-project data is derived in the browser. The "+" on a project or repository reads the
  new-session dialog's own `/projects`, already requested by the shell. Sections are capped (15 projects, 5 personal
  repositories, 3 sessions per project, 5 Needs-you rows) instead of virtualised. Live updates use the 07.9 per-user
  delivery; no organization-wide broadcast was added.

### "Your turn" is remembered per browser (PD-09)

"Needs you" lists a finished turn of the viewer's own prompt until they open the session, within 24 hours. What the
viewer has opened is a per-browser seen map (`ocw.workzone.seen.v1`, session ids and times only, pruned to 7 days and
300 entries, never sent), written by the session view's data hook (`use-live-session.ts`) when the session loads and
when a turn ends while it is open, at the later of the browser's clock and the server's turn end (so a browser clock
behind the API never brings the turn back). There is no server read cursor.

### D-20 under the tree (PD-08), a deliberate change of an earlier owner requirement

Phase 03.2's D-20 asked that an automatic title of up to 32 characters show in full in the flat sidebar row (219 px
at 1440). A session row in the approved tree is indented under its project and carries its status on the same line,
which leaves about 110–160 px; no layout of the approved tree gives a nested row 219 px. The approved 07.10 layout
(the newer owner approval) governs the row: a long title is cut with an ellipsis. D-20 keeps holding in the session
header breadcrumb, the page and the browser tab, and the full title stays in the row's `title` attribute (shown on
hover) and in its accessible name. `work-zone-title.spec.ts` checks that contract at 1440 and in the 390 drawer.

## Consequences

- A project the viewer cannot open is never named to them on any session surface: list, detail, `user:` frames, the
  `ws:` stream live and replayed, the visibility panel (`GET /work-sessions/:id/visibility` and the `PUT` answer),
  sidebar text, tooltips, search and accessible names. The panel decides with the list's rule (`projectNamedFor` in
  `viewer-fields.ts`) and gives anyone else its hidden form: `project: { kind: "hidden" }`, no default, no teams, no
  stored people, no team named on a viewer row (gap closure 07.10-07, HI-01). Proven by `viewer-fields.int.test.ts`,
  the D-08 sentinel's device-owner watcher, the cross-tenant case for the index's new fields, and the secrecy e2e of
  `work-zone-sidebar.spec.ts` and `work-zone-sidebar-attention.spec.ts`.
- **Stored `ws:` history (closed in 07.10-07, LO-02).** `ws:` snapshots stored before this phase still carry
  `teamProject` in `app.stream_events`, but no subscriber receives it: a replay strips `teamProject`,
  `teamProjectHidden` and `attention` from every `work_session.updated` payload on read, whatever cursor the client
  asks for (the work-session module's replay mapper on `ws:`, `withoutViewerFields`; the realtime service's
  `registerReplayMapper` may only remove data). No data migration: the stored rows are read only through the replay.
  Proven by `viewer-fields.int.test.ts` (a stored pre-07.10 snapshot naming the project, replayed from seq 0).
- **Team names stay organization data.** The session's visibility summary (`firstTeamName`) may name a team, never a
  project, to every reader of the session, as in 07.9: unit names are already shown in Settings › Organization.
- **Deferred: a server read cursor.** "Your turn" is per browser: on another browser or device a turn already seen
  elsewhere shows once until it is opened there. A server read cursor is deferred with the unread markers for session
  activity (CONTEXT deferred, with pinning and per-project mute).
- **The D-20 change** needs the owner's acceptance: `docs/DEMO.md` › Work Zone sidebar by team (Phase 07.10), owner
  check (5), recorded in `07.10-VALIDATION.md` › Manual-Only Verifications.
- **Two-request budget.** The sidebar costs the two list requests at any organization size; `list-perf.int.test.ts`
  is unchanged and green (projects index median 118 ms of a 1,000 ms budget). The `user:` delivery adds one resolver
  call per delivered session that has a pending approval; the list and fan-out budgets cover it, a batch with many
  approvals pending at once is not measured.
- Admins and leads above a project stop seeing it in their sidebar (by design, S2); Browse projects and search keep it
  one click away.
- **Needs you follows the same scope.** An approval on a session the viewer reaches only as an admin or a manager never
  fills their Needs you, even when the session runs on their own device: the DTO carries no device owner, so "on my
  device" is not expressible (X2). A device owner who is not an admin gets those sessions through `teamProjectHidden`
  (under Personal, so in Needs you); an admin device owner outside the project finds them on the project page, in
  search and in the session itself. Owner check (3) asks whether this is acceptable; if not, the change is a
  device-owner fact among the per-viewer fields.
- No new dependency, endpoint, migration, SQL function, RLS policy, realtime topic, CSS variable or UI primitive;
  everything runs with `docker compose up`.

### Validation

Unit, web and integration tests (real PostgreSQL and Redis: `viewer-fields`, the sentinel, cross-tenant, `list-perf`),
the isolated e2e on both Playwright projects (every spec, including `work-zone-sidebar`, `-sidebar-attention` and
`-sidebar-actions`, at 1440 and 390, light and dark, axe and 44 px targets, keyboard) and `pnpm gate:compose`; recorded
in `07.10-VALIDATION.md`. **Owner checks pending:** `docs/DEMO.md` › Work Zone sidebar by team (Phase 07.10).
