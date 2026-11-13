---
quick_id: 261113-hu7
slug: bot-sessions-use-a-worktree-only-in-git-projects
date: 2026-11-13
type: fix
status: complete
subsystem: work-session
tags: [work-zone, bots, worktree, device-link, migration]
key-files:
  created:
    - packages/db/drizzle/20261113175346_projects_git/migration.sql
  modified:
    - packages/db/src/schema/app.ts
    - apps/api/src/upgrade.int.test.ts
    - apps/api/src/modules/device/link.ts
    - apps/api/src/modules/device/routes.ts
    - apps/api/src/modules/work-session/bot-sessions.ts
    - packages/contracts/src/device.ts
    - apps/web/components/work-zone/new-session-dialog.tsx
    - apps/api/src/modules/agent-channel/work-sessions.int.test.ts
    - apps/web/components/work-zone/new-session-dialog.test.ts
decisions:
  - "A bot start's worktree = profile.worktree && project.git !== false (null = the device did not say: the profile's choice stands). The same effective value drives the D-15 tree_busy check, so a non-git project never gets a second active session on its tree."
  - "projects.git is a nullable boolean with no default (additive migration); restart and redispatch keep the session's stored worktree."
---

# Quick 261113-hu7: bot sessions use an isolated worktree only in git projects

A bot whose Work Zone profile has Isolated worktree on now starts on the project's own checkout when the device said
the project folder is in no git repository, instead of sending a worktree start the daemon refuses. A second start on
that checkout while the first is active is refused with `tree_busy` (one executor per tree). Git projects, and projects
of older devices that do not report `git`, keep the profile's worktree.

## Root cause

The device already announces `git` per project (`DeviceProjectAnnouncement.git`), but the API did not store it, and the
bot start sent `worktree: profile.worktree` for every project of the profile. The daemon refuses a worktree outside git
(`NO_GIT_WORKTREE_MESSAGE`), so the session failed and the bot's task blocked.

## Changes

1. **Schema:** `app.projects.git boolean` (nullable), migration `20261113175346_projects_git` (one `ADD COLUMN`, no
   default, no rewrite), added to `HEAD_ONLY` in the upgrade test. RLS and table grants unchanged.
2. **Device Link:** `syncProjects` stores `git: p.git ?? null` on insert and on update.
3. **Bot start (`bot-sessions.ts`):** reads the project's `git` in the start's transaction after the project check;
   `worktree = profile.worktree && git !== false` is used for both the `tree_busy` check and the start input.
4. **Projects DTO:** `Project.git` optional in `@ocw/contracts`; `GET /projects` sends it only when the device said.
5. **New session dialog:** `worktreeChoice` turns the Isolated worktree switch off and disables it on a project with
   `git === false`, with the hint "This project has no git repository"; the request and the settings summary use the
   effective value. The viewer's choice is kept for git projects. Existing behaviour is otherwise unchanged.

## Optional items

- **4 (bot turn context): skipped.** The turn's Work Zone offer (`TurnWorkZone`) carries no worktree field at all today,
  so the bot never sees or chooses it; adding a per-project flag would be a new contract field plus plugin rendering for
  information the bot cannot act on. The server already decides.
- **5 (human dialog): done.** It needed only one optional field on the existing `Project` DTO.

## Tests

- `work-sessions.int.test.ts` (new describe, failing first in `cb0d776d`): the device's flag is stored (true, false,
  absent → null) and listed by `GET /projects`; profile worktree on + `git: false` project → session `worktree: false`,
  branch `main`, `session.start` dispatched without `worktree`, a second start → `tree_busy` with no rows written;
  `git: true` and absent → `worktree: true` in the row and the dispatch.
- The suite's device now announces `billing-api` with `git: true` and a fourth project `notes` with `git: false`
  (ledger and scratch stay without `git`). No existing expectation changed.
- `new-session-dialog.test.ts`: `worktreeChoice` for false, true, absent and no project.

## Verification

Root vitest config, ephemeral PostgreSQL/Redis only:

| Suite | Result |
| --- | --- |
| integration `apps/api/src/modules/agent-channel` | 53 files, 997 tests passed |
| integration `apps/api/src/modules/work-session` | 24 files, 416 tests passed |
| integration `apps/api/src/modules/device` + `upgrade.int.test.ts` + `workzone.int.test.ts` | 9 files, 131 tests passed (upgrade: "behind by exactly HEAD_ONLY's migrations" passes) |
| integration `packages/db/src/rls-isolation.int.test.ts` | 1 file, 42 tests passed |
| unit `packages/contracts` + `apps/api/src/modules/device` + `work-session` | 58 files, 1299 tests passed |
| web `apps/web/components/work-zone` | 22 files, 264 tests passed |
| `pnpm lint` | clean (4 pre-existing warnings in untouched `apps/local-runtime` files) |
| `pnpm typecheck` | 11/11 tasks successful |

No e2e run locally (no e2e spec or fixture announces projects or builds the `Project` shape). The dialog change was
not checked in a browser here (no local stack; the owner's demo is off limits).

## Deviations from Plan

None. The device-link storage test lives in the work-sessions integration suite (the device there announces the
projects), not in a separate device suite.

## Known Stubs

None.
