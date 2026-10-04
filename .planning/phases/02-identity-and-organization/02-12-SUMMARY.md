---
phase: 02-identity-and-organization
plan: 12
subsystem: web (admin console: members, roles, profiles)
status: complete
tags: [members, roles, role-matrix, deactivation, password-reset, profile, ui, e2e, screenshots]
requires: ["02-07", "02-09"]
provides:
  - "Settings › Members on the resolver: invite form by invitation.create with the INVITABLE_ROLES ceiling, Revoke per viewerCan, role select by member.manage; no legacy marker left in members-settings.tsx"
  - "lib/member-queries.ts: memberKeys, useMemberDetails, useMemberProfile, useChangeRole (optimistic + rollback), useDeactivateMember, useReactivateMember, useCreateResetLink"
  - "components/settings/member-row.tsx (row + row menu + confirm dialogs), role-reference-sheet.tsx (role x capability matrix), reset-link-dialog.tsx"
  - "components/members/member-profile-sheet.tsx (MemberProfileSheet, MemberAvatar with referrerPolicy no-referrer), member-badges.tsx (RoleBadge, DeactivatedPill), unit-chip.tsx (UnitChip, sortUnits, UNIT_KIND_ICON)"
  - "Channel members dialog: people open their profile"
  - "e2e/tests/admin-members.spec.ts (5 tests x desktop/mobile)"
affects: [02-13, 02-15]
tech-stack:
  added: []
  patterns:
    - "Credential results (reset link) live only in component state; the mutation is reset right after success and a generation counter drops responses that arrive after close"
    - "Responsive sheets: right panel from md, bottom sheet on phones via className overrides on SheetContent (sheet.tsx untouched)"
    - "e2e sessions reused across API and browser (storageState from the API context; invite acceptance already signs the member in) to stay under the 30/min sign-in rate limit"
key-files:
  created:
    - apps/web/lib/member-queries.ts
    - apps/web/components/settings/member-row.tsx
    - apps/web/components/settings/role-reference-sheet.tsx
    - apps/web/components/settings/reset-link-dialog.tsx
    - apps/web/components/members/member-profile-sheet.tsx
    - apps/web/components/members/member-badges.tsx
    - apps/web/components/members/unit-chip.tsx
    - e2e/tests/admin-members.spec.ts
  modified:
    - apps/web/components/settings/members-settings.tsx
    - apps/web/components/chat/members-dialog.tsx
    - apps/web/lib/permissions.ts
decisions:
  - "The role select is shown on deactivated rows as a read-only badge; reactivate first, then change the role"
  - "Relation-only permissions (account.manage, device.use, device.update) show 'Own' for every role whose surfaces include them; runtime permissions (cell.sync, device.link) are omitted from the matrix"
  - "At 390 px the matrix fits all four roles (short headers Standard/Dev/Lead/Admin) instead of scrolling sideways, so no scroll hint is shown; the first column stays sticky for narrower screens"
  - "member.updated for the caller also invalidates /me, so the workspace switcher role label follows a role change live everywhere"
metrics:
  duration: "~36 min"
  completed: "2026-10-04"
  tasks: 3
  files: 11
actuals:
  tokens: 19500
  tasks: 3
  commits: 4
---

# Phase 2 Plan 12: Settings › Members (roles, lifecycle, role matrix, profiles) Summary

Settings › Members is now the people half of the admin console, and every control on it is decided by the server. Admins change a member's role with a select of the four PRD roles. The change shows up at once, and the teammate's own UI follows it: the invite ceiling and the workspace switcher label update live. Team Leads see the invite form with only Standard User and Developer, and they see Revoke only on invitations they created. From the row menu, admins deactivate and reactivate members (a confirm dialog names what happens) and create a one-time password reset link that appears once in a copy dialog. Anyone can open any member's profile (avatar, status, role, units, joined date) from the directory or from a channel's member list. "What can each role do?" opens a matrix generated from `ROLE_PERMISSIONS`. The page works at 390 px and 1440 px, in light and dark, and has an empty state with a call to action.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `1d13f81` | feat(02-12): admins change member roles from Settings › Members; role matrix from the server's table |
| 2 | `49dc2ac` | feat(02-12): member lifecycle and profiles: deactivate/reactivate, one-time reset link, profile sheet |
| 3 | `9aab0d5` | feat(02-12): polish Settings › Members at 390/1440 in light and dark; reviewed screenshots |
| — | (this file) | docs(02-12): complete plan |

## Verification

| Command | Result |
|---------|--------|
| `pnpm --filter @ocw/web typecheck` (after each task) | exit 0 |
| `bash scripts/e2e-isolated.sh admin-members` (Task 1) | 7 passed (setup + 3 tests x 2 projects) |
| `bash scripts/e2e-isolated.sh admin-members chat` (Task 2) | 13 passed (38.4 s) |
| `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh admin-members` (Task 3, final) | **11 passed (35.6 s)**: setup + 5 tests x desktop/mobile |
| `pnpm verify` (final code) | exit 0. Biome: 4 pre-existing warnings (apps/local-runtime). Typecheck 8/8. **52 files / 505 tests passed**, guard.test.ts included |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` (full suite) | Run 1: 20 passed, 1 failed. `[mobile] smoke.spec.ts:30` timed out clicking `nav-settings` in the drawer ("element was detached from the DOM, retrying"). The smoke spec then passed twice on its own (`--keep-db smoke`). Run 2 of the full suite: **21 passed (53.7 s)**, exit 0 |
| `ls screenshots \| grep -c "^members-"` | 26 |

Acceptance greps: `grep -c "authz-legacy" members-settings.tsx` returns 0. `members-settings.tsx` contains `useCan`-equivalent checks through `usePermissionCheck()` (`can("invitation.create")`, `can("invitation.read")`, `can("member.manage")`) and `INVITABLE_ROLES`. `member-row.tsx` contains `useChangeRole` and `member-role-select`. `member-profile-sheet.tsx` contains `referrerPolicy="no-referrer"`. `reset-link-dialog.tsx` exists, and `members-dialog.tsx` imports `MemberProfileSheet`. `admin-members.spec.ts` contains `-dark` and `shot(`.

### What the e2e proves (desktop 1440 and mobile 390)

1. **Role change, followed by the teammate.** The admin invites through the form (Developer is the default), and the teammate accepts in a second browser context. The new member appears in the admin's list live through `member.joined`. The admin sets the role to Team Lead: a "Role updated" toast appears and the row updates. Unit chips appear live through `units.updated` and link to `/settings/organization?unit=<id>`. When the teammate reloads Settings, the invite role options are exactly `["Standard User", "Developer"]`, the workspace switcher reads Team Lead, and there is no role select. A pending invitation created by the admin has no Revoke button, while the lead's own invitation has one. The only admin tries to demote themselves and gets an error toast with the server's 409 message, and the select reverts to Organization Admin. This step runs only while the admin is the sole active admin, so it can never demote the shared e2e admin.
2. **Role matrix.** The `data-grant` values per role are checked for member.manage, invitation.create, work_session.create, channel.post, account.manage (Own for all four roles) and device.use (Own from Developer up). cell.sync and device.link are absent.
3. **A Developer sees the directory read-only.** Role badges are shown, and there is no role select, invite form or pending-invitations section.
4. **Lifecycle.**
   - The reset link dialog shows `/reset-password?token=`, "Expires in 24 hours", the privacy warning and a Copy button. Reopening the dialog issues a different link.
   - The deactivate confirm shows "Deactivate X? Their sessions end now. Messages and history stay." After confirming, the row leaves the default list. With "Show deactivated" on, it shows the Deactivated pill, and the teammate's open page lands on `/login` on reload.
   - Reactivate restores the row, and the teammate can sign in again.
   - The admin's own row menu has only "View profile".
5. **Profiles.** A Developer opens a teammate's profile from the directory, which shows the emoji avatar, status, role, "Joined …" and three unit links. The same profile opens from a channel's members dialog. An https avatar renders `referrerpolicy="no-referrer"`, and the intercepted image request carries no `Referer` header (T-02-12-03).

## Screenshots (final, reviewed; `.planning/phases/02-identity-and-organization/screenshots/`)

| File(s) | View | Polished in review |
|---------|------|--------------------|
| `members-list-desktop.png`, `members-list-desktop-dark.png`, `members-list-mobile.png`, `members-list-mobile-dark.png` | Members list after the role change (toast visible), with unit chips | The lead unit comes first. At 390 px there is one chip plus "+N", so chips no longer wrap onto two lines. The capture starts at the section header. The row menu is top-aligned on phones, and role selects are 40 px tall on mobile |
| `members-roles-sheet-desktop.png`, `…-desktop-dark.png`, `…-mobile.png`, `…-mobile-dark.png` | "What can each role do?" matrix | At 390 px all four role columns now fit (it showed 2 columns and needed a sideways scroll). The description is shorter, and the bottom-sheet layout is used on phones |
| `members-reset-link-desktop.png`, `…-desktop-dark.png`, `…-mobile.png`, `…-mobile-dark.png` | One-time reset link dialog | Warning callout contrast checked in dark mode. Full-width Done button on mobile |
| `members-profile-sheet-desktop.png`, `…-desktop-dark.png`, `…-mobile.png`, `…-mobile-dark.png` | Member profile (emoji avatar, status, role, units, joined) | Emoji avatar sized per context (it was tiny in rows). Units ordered department → team → project. Skeleton matches the loaded layout |
| `members-deactivate-confirm-desktop.png`, `…-desktop-dark.png`, `…-mobile.png`, `…-mobile-dark.png` | Deactivate confirm dialog | Consequences shown as an icon list (the bullets had a broken hanging indent) |
| `members-deactivated-desktop.png`, `…-desktop-dark.png`, `…-mobile.png`, `…-mobile-dark.png` | List with "Show deactivated" on | Deactivated pill gets a dark-mode tint (`dark:text-red-300`), and the avatar is greyed out. Captured after the toast clears |
| `members-empty-desktop.png`, `members-empty-desktop-dark.png` | Empty state "It's just you so far" | The CTA focuses the invite field, and the field is auto-focused on desktop only (no keyboard pop on phones). This state is only captured on a fresh stack: the desktop project runs first, while the admin is still alone, so there is no mobile capture |

That is 26 files. Superseded captures, plus the `setup-*` and `chat-*` captures that other specs write into the same directory, were deleted.

### Demo stack (hard rule)

| Check | Before | After |
|-------|--------|-------|
| `curl localhost:4000/health` | 200 | 200 |
| `curl localhost:3000/login` | 200 | 200 |
| `ocw-demo-openclaw` | running, started 2026-10-04T15:54:27Z | running, started 2026-10-04T15:54:27Z |

All e2e runs went through `scripts/e2e-isolated.sh`. No compose down/rm/stop/restart, no `db:migrate` with the default `.env`, no `demo:*`, and nothing bound on :4000 or :3000.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] `permissions.ts` also refreshes `/me` on the caller's own `member.updated`**
- **Found during:** Task 1
- **Issue:** `usePermissions` already invalidated the permission set on a self `member.updated`, but not `/me`. As a result, the workspace switcher label (`me.organization.role`) stayed stale until a reload.
- **Fix:** Three lines in `apps/web/lib/permissions.ts`. That file was not in the plan's list, and no sibling plan owns it.
- **Commit:** `1d13f81`

**2. [Rule 1 - Bug] The guard test flagged unit-role comparisons**
- **Found during:** Task 1
- **Issue:** `unit.role === "lead"` (a unit membership role, not an organization role) matches guard.test.ts's `ROLE_LITERAL`.
- **Fix:** A `UNIT_ROLE_TAG` lookup, with no literal comparison. Nothing was marked or skipped.
- **Commit:** `1d13f81`

**3. [Rule 1 - Bug] e2e sign-ins hit the 30/min per-IP rate limit and broke the next spec**
- **Found during:** Task 2
- **Issue:** The first version signed in about 13 times per project, so `chat.spec` (which runs next) failed at sign-in.
- **Fix:** There is now one admin API session per project. Browser pages reuse an API session's cookies, and `createMember` keeps the session that invite acceptance creates. The only extra sign-in left is the reactivation check.
- **Commit:** `49dc2ac`

**4. Extra files (structure, no new behaviour)**
- `components/members/member-badges.tsx` and `components/members/unit-chip.tsx` were added to avoid a circular import between the row and the profile sheet.
- `members-settings.tsx` also listens to `units.updated`, so unit chips stay live.

**5. Plan wording: "useCan(…)" vs `usePermissionCheck()`**
- `members-settings.tsx` calls `usePermissionCheck()` once and passes `canManage` down. It does not call `useCan()` per row, because each `usePermissions()` call registers its own realtime topic listener. The behaviour matches the plan.

**6. Mobile role matrix: no scroll hint**
- The plan expected a sticky first column plus a horizontal-scroll hint. The polished matrix fits all four roles at 390 px, so a hint would be misleading and was removed. The first column is still sticky for narrower screens.

**7. TDD granularity**
- `apps/web` has no unit-test project. The behaviour tests are the e2e spec, which was written in each task, run red/green iteratively, and committed with the implementation in one `feat` commit per task (same convention as 02-01 to 02-09).

### Out of scope (logged, not fixed)
- In the first full-suite run, `[mobile] smoke.spec.ts:30` timed out clicking `nav-settings` because the drawer element was repeatedly detached. It passed twice on its own and in a second full run. It appears to be a timing flake in the mobile drawer (shell code this plan does not touch).

## Known Stubs

None. The unit chips and profile unit links point to `/settings/organization?unit=<id>`, which 02-13 creates in this same wave. On this branch alone those links reach a page that does not exist yet. They resolve once both plans merge.

## Threat Flags

None. T-02-12-01: every control follows `/me/permissions` and `viewerCan`, and the API re-decides. T-02-12-02: the reset link is kept in component state only, the mutation state is reset on success, late responses are dropped after close, and the link is never in the query cache, the URL or a log. T-02-12-03: `referrerPolicy="no-referrer"` is applied to the preload and the img, and the e2e asserts no `Referer` header.

## Self-Check: PASSED

Commits 1d13f81, 49dc2ac and 9aab0d5 exist on wt/02-12. member-row.tsx, role-reference-sheet.tsx, reset-link-dialog.tsx, member-profile-sheet.tsx, member-badges.tsx, unit-chip.tsx, member-queries.ts and admin-members.spec.ts exist. The screenshots directory holds 26 `members-*` files.
