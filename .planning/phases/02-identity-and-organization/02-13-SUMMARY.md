---
phase: 02-identity-and-organization
plan: 13
subsystem: web (admin console: Settings › Organization), e2e
status: complete
tags: [admin-console, hierarchy, org-units, memberships, leads, permission-rules, viewerCan, accessibility, responsive, dark-mode]
requires: ["02-06"]
provides:
  - "Settings › Organization (/settings/organization, unit.read): indented Department → Team → Project tree, unit detail, ?unit=<id> deep links"
  - "Create, rename, move (parent picker) and delete dialogs; per-unit actions menu driven by OrgUnit.viewerCan"
  - "Unit members with Lead toggle, Add people and Remove (with confirm); read-only access-rules card for rule.read holders (D-02)"
  - "apps/web/lib/org-queries.ts: useUnits, useUnitMembers, usePermissionRules, unit and membership mutations, useUnitsLive"
  - "Sheet side=\"bottom\" (85dvh) in components/ui/sheet.tsx"
  - "e2e/tests/admin-org.spec.ts at 1440 and 390 with light and dark review captures"
affects: [02-15]
tech-stack:
  added: []
  patterns:
    - "Selection in the URL (?unit=<id>, router.replace without scroll); detail beside the tree at ≥ 1024 px, bottom sheet below"
    - "One dialog provider per page (create/rename/move/delete) opened from rows, the detail and the empty state"
    - "WAI-ARIA tree: one tab stop, arrows/Home/End, aria-level/expanded/selected on treeitems"
    - "Nested Base UI dialog inside a sheet dims the sheet through data-nested-dialog-open"
key-files:
  created:
    - apps/web/app/(app)/settings/organization/page.tsx
    - apps/web/components/organization/org-structure.tsx
    - apps/web/components/organization/unit-tree.tsx
    - apps/web/components/organization/unit-dialogs.tsx
    - apps/web/components/organization/unit-detail.tsx
    - apps/web/components/organization/add-people-dialog.tsx
    - apps/web/components/organization/unit-rules-card.tsx
    - apps/web/components/organization/unit-meta.tsx
    - apps/web/lib/org-queries.ts
    - e2e/tests/admin-org.spec.ts
    - .planning/phases/02-identity-and-organization/screenshots/org-*.png (24)
  modified:
    - apps/web/components/settings/settings-nav.ts
    - apps/web/components/ui/sheet.tsx
decisions:
  - "The admin-org spec owns the e2e hierarchy: it deletes every unit (deepest first) at the start of each project, so the empty state is asserted at both widths"
  - "The parent picker is a radio list with breadcrumbs and disabled reasons, not a Select: nothing clips at 390 px and each disabled row says why"
  - "Delete stays visible but disabled on a unit with children, with the reason written inside the menu item (readable on touch, where a hover tooltip never shows)"
  - "Remove is hidden on lead memberships unless the viewer holds unit.manage, matching 02-06's rule that removing a lead is an appointment decision"
  - "Lead eligibility in the UI reads ROLE_RANK on the target member (D-06 data), never the viewer's role; the API still answers lead_requires_role"
metrics:
  duration: "~45 min"
  completed: "2026-10-04"
  tasks: 3
  files: 13
actuals:
  tokens: 25700
  tasks: 3
  commits: 4
---

# Phase 2 Plan 13: Settings › Organization (hierarchy, memberships, leads, read-only rules) Summary

Admins now build and rearrange the company from Settings › Organization. The page starts from an empty state with a "New department" call to action. From there they add teams and projects, rename, move (with a picker that disables the unit's own subtree and kinds that cannot hold it), delete (blocked while a unit has children) and staff units with a Lead toggle. A Team Lead adds and removes people only in their own subtree. Everyone else browses the tree read-only. Every control comes from the API's `viewerCan` / `useCan`. The page works at 390 px (tree, detail in a bottom sheet) and 1440 px (two panes), in light and dark.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (tracer) | `07b6d0d` | feat(02-13): admins build Department → Team → Project from an empty Settings › Organization page |
| 2 | `8c88b38` | feat(02-13): rename, move, delete and staff units with permission-driven controls |
| 3 | `29bdc9a` | feat(02-13): review and polish Settings › Organization at 390 and 1440, light and dark |

## What the page does

- **Navigation:** the "Organization" entry sits after Members in Settings and needs `unit.read`, so every active member sees it.
- **Tree:** department, team and project rows with kind icons (violet building, sky people, amber folder), member counts and indentation guides. It follows the WAI-ARIA tree pattern: one tab stop, ↑/↓, → expands or enters, ← collapses or goes to the parent, Enter/Space select, Home/End. Long names are truncated with an ellipsis and keep the full name in `title`.
- **Row menu** (only when `viewerCan` includes `unit.manage`): "Add department/team/project" for the kinds that `ALLOWED_PARENT_KINDS` allows, then Rename…, Move to… and Delete…. On a unit with children, Delete is disabled and reads "Remove its teams and projects first".
- **Unit detail:**
  - A breadcrumb with clickable ancestors, and Members / Leads / Inside counts.
  - The units inside, with an "Add" menu for admins.
  - People: unit-role badge, org role, Lead switch (admins), Remove with confirmation, and Add people (search by name or e-mail, one click adds as member).
  - "Access rules" (Read-only), only with `rule.read`: effect badge, permission, description, subject, tool. When empty it says "No rules for this unit".
- **Live:** `units.updated`, `member.updated` and `permission_rules.updated` on `org:<id>` refresh the tree, member lists and rules. If someone deletes the selected unit, the selection is dropped.

## Verification

| Command | Result |
|---------|--------|
| `pnpm --filter @ocw/web typecheck` | exit 0 after each task |
| `bash scripts/e2e-isolated.sh admin-org` (Task 1) | First run: 2 failed. An empty actions menu (a project had no create items yet) stayed open and blocked clicks. Fixed: no menu without items. Second run: **3 passed** (setup + desktop + mobile) |
| `bash scripts/e2e-isolated.sh admin-org` (Task 2) | **5 passed (37.7 s)** |
| `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh admin-org` (Task 3, final) | **5 passed (1.1 min)**, 24 captures |
| `pnpm verify` | Task 1 and Task 3: exit 0. Task 2: first run failed `guard.test.ts` (see deviation 3), then exit 0. Final: biome 397 files clean, turbo typecheck 8/8, **52 files / 505 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` (full suite, final) | **15 passed (58.4 s)**, exit 0: setup, then admin-org (×2), bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390 |
| `ls …/screenshots \| grep -c "^org-"` | 24 |

What the e2e covers, at both widths:
- empty state and its CTA in the viewport
- three-level build with `aria-level` 1/2/3 and `data-kind`
- duplicate sibling name answered inline: "A unit with this name already exists here"
- a Developer sees 3 rows, no New department and no unit menu
- deep link `?unit=<id>` (sheet on mobile)
- rename
- move picker: top level disabled with "Teams cannot be top level", own row and current parent disabled, projects not listed, Platform enabled; after the move, the API shows Backend under Marketing and Alpha's path `[Marketing, Backend, Alpha]`
- delete blocked with the hint text; leaf menu without "Add" items; delete with confirmation
- Add people with search filtering
- Member badges; Lead toggle to "Lead"; the Developer's switch disabled with the tooltip "Only Team Leads or Organization Admins can lead a unit" (hover checked on desktop)
- access rules: one deny rule on `channel.archive` for Developer
- Team Lead view: Add people on IT and Platform, Remove on members only, no Lead switch, no menus, no rules card, no Add people on Marketing
- Remove with confirmation

Acceptance greps:
- `settings-nav.ts` has `"/settings/organization"` and `permission: "unit.read"`.
- `unit-tree.tsx` has `role="tree"` and `ALLOWED_PARENT_KINDS`.
- `unit-detail.tsx` has `viewerCan` and `unit.members.manage`.
- `unit-dialogs.tsx` has `ALLOWED_PARENT_KINDS` and `"Remove its teams and projects first"`.
- `unit-rules-card.tsx` has 0 `<form` and 0 delete.
- The spec has `-dark` and `shot(`.

**Demo stack (hard rule):** `:4000/health` 200 and `:3000/login` 200 before and after the full run. `ocw-demo-openclaw` is still running, started 2026-10-04T15:54:27Z. All e2e went through `scripts/e2e-isolated.sh`. None of these were run: compose down/rm/stop/restart, `db:migrate` against the default `.env`, `demo:*`. Nothing bound :4000 or :3000.

## Screenshots (24, `.planning/phases/02-identity-and-organization/screenshots/`)

Each view is captured at `-desktop` (1440) and `-mobile` (390), in light and `-dark`. The spec waits until toasts have cleared before each capture.

| View | Files | What was reviewed / polished |
|------|-------|------------------------------|
| Empty state | `org-empty-{desktop,mobile}{,-dark}.png` | Headline, how-it-nests chips (Department → Team → Project) and the primary CTA above the fold at 390 |
| Tree | `org-tree-{desktop,mobile}{,-dark}.png` | Three readable levels with guides at 390. The summary moved under the header so it no longer truncates in the 320 px pane. 40 px row-menu targets on phones. A "Tap a department…" hint replaces empty space under the phone tree |
| Move dialog | `org-move-{desktop,mobile}{,-dark}.png` | A radio list with breadcrumbs and the reason on each disabled row. Fits at 390 (scrolls inside, max 45dvh), legible in dark |
| Unit detail | `org-unit-{desktop,mobile}{,-dark}.png` | Balanced panes at 1440 (detail max-w-3xl). One "Add" menu replaces three crowded buttons. Visible "Lead" label on phones. Sheet actions and close grouped, 40 px targets |
| Add people | `org-add-people-{desktop,mobile}{,-dark}.png` | Nested dialog now dims the bottom sheet (`data-nested-dialog-open`). Search field and one-click rows |
| Team Lead view | `org-lead-view-{desktop,mobile}{,-dark}.png` | Read-only structure, staffing controls only. The sheet focuses its content on open, so there is no stray focus ring on the close button |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] An actions menu with no items trapped the page**
- **Found during:** Task 1, first e2e run.
- **Issue:** With only create items, a project's menu opened empty, and its inert layer blocked every later click.
- **Fix:** the menu does not render when it has nothing to offer. Since Task 2 every manageable unit has Rename/Move/Delete.
- **Commit:** `07b6d0d`

**2. [Rule 2 - Correctness] Remove hidden on lead memberships for leads**
- **Issue:** 02-06's API requires `unit.manage` to remove a lead membership.
- **Fix:** the Remove control follows the same rule, so a Team Lead never sees a button that would 403.
- **Commit:** `8c88b38`

**3. [Rule 3 - Blocking] `guard.test.ts` flagged unit-role comparisons**
- **Issue:** `m.role === "lead"` on unit memberships (data, not the viewer's role) matched the legacy-check regex.
- **Fix:** the comparison now goes through `leadsUnit(m)`, which compares against `UnitRole.enum.lead`, the same approach as 02-06. Lead eligibility reads `ROLE_RANK` on the target.
- **Commit:** `8c88b38`

### Planned-file and design adjustments

- **`components/ui/sheet.tsx` (not in the plan's file list):** added a `bottom` side (85dvh, rounded top). This is additive, and existing `left`/`right` sheets are unchanged.
- **`components/organization/unit-meta.tsx` (new, not listed):** holds the kind presentation, tree building and the `viewerCan` helpers that the tree, the dialogs and the detail share. Putting them in one of the listed files would have created an import cycle. `childKinds` (from `ALLOWED_PARENT_KINDS`) lives in `unit-tree.tsx`, as the plan asks.
- **Move picker:** a radio list instead of a Select (see decisions). It shows the same eligible set, plus a breadcrumb or the reason a row is disabled.
- **Delete hint:** written inside the disabled menu item instead of a hover tooltip, so touch users can read it. The Lead-switch hint is a real tooltip on a focusable wrapper.
- **Rename/move/delete entry points:** the plan put them in the tree row menu. The same menu also sits in the detail header, because the bottom sheet covers the tree on phones.
- **Spec setup:** besides inviting the Team Lead (Lena), the spec reuses chat.spec's Developer account (Alex, created if missing) and clears all units at the start of each project. It deletes the permission rule it creates at the end.
- **TDD granularity:** as in earlier plans, each task's e2e and implementation went into one `feat` commit, so every commit passes `pnpm verify`. RED was observed for Task 1: the spec failed until the menu fix.
- **Branch:** commits are on `wt/02-13`, as the orchestrator instructed. Nothing was pushed. STATE.md and ROADMAP.md were not edited.

## Known Stubs

None. Every control is wired to the 02-06 APIs. The rules card is read-only by design (D-02). Rules are created through `POST /api/v1/permission-rules`.

## Threat Flags

None. No new network surface. The UI reads existing endpoints and hides controls from `viewerCan` / `useCan` only. The API decides every change (T-02-13-01..03).

## Self-Check: PASSED

- All 10 created source files and 24 `org-*.png` are present.
- Commits `07b6d0d`, `8c88b38` and `29bdc9a` are on `wt/02-13`.
