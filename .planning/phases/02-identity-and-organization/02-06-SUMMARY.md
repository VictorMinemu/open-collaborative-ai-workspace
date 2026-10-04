---
phase: 02-identity-and-organization
plan: 06
subsystem: organization (hierarchy, unit memberships, explicit rules), realtime
status: complete
tags: [hierarchy, org-units, advisory-lock, leads, permission-rules, realtime, fast-check, audit]
requires: ["02-01", "02-02", "02-03"]
provides:
  - "Units API: GET/POST /units, PATCH/DELETE /units/:id, POST /units/:id/move on app.org_units (uuid[] paths, per-org advisory lock)"
  - "Unit memberships API: GET/POST /units/:id/members, PATCH/DELETE /units/:id/members/:userId (member | lead)"
  - "Permission rules API: GET/POST /permission-rules, DELETE /permission-rules/:id"
  - "Pure helpers validateParentKind and applyMove (property-tested); exported lockUnits/requireUnit/orgTopic/unitView for later plans"
  - "org:<id> and user:<id> topic authorizers decided by the resolver; realtime has no built-in authorizers"
  - "Audit actions unit.created/renamed/moved/deleted, unit_membership.added/role_changed/removed, permission_rule.created/deleted"
affects: [02-10, 02-11, 02-12, 02-13, 02-14, 02-15]
tech-stack:
  added: []
  patterns:
    - "Structural tree changes: lock (pg_advisory_xact_lock on hashtextextended('org_units:'||org)) → re-read → assertCan → write"
    - "Subtree move in one UPDATE: newParent.path || path[array_position(path, id):] where path @> ARRAY[id]"
    - "uuid[] parameters passed as a Postgres array literal (drizzle expands JS arrays into value lists)"
key-files:
  created:
    - apps/api/src/modules/organization/units.ts
    - apps/api/src/modules/organization/rules.ts
    - apps/api/src/modules/organization/units.test.ts
    - apps/api/src/modules/organization/units.int.test.ts
    - apps/api/src/modules/organization/rules.int.test.ts
  modified:
    - apps/api/src/modules/organization/index.ts
    - apps/api/src/modules/realtime/service.ts
decisions:
  - "Removing a lead membership needs unit.manage, the same decision as appointing one (a lead cannot strip lead authority)"
  - "Create, move and delete take the per-org lock first, then re-read and decide, so the decision and the write see the same tree"
  - "A move to the current parent is a no-op: no audit row, no event"
  - "Deleting a unit also emits permission_rules.updated for each cascaded scoped rule"
  - "GET /units orders by creation time; memberCount counts every membership including leads"
metrics:
  duration: "~35 min"
  completed: "2026-10-04"
  tasks: 3
  files: 7
actuals:
  tokens: 16500
  tasks: 3
  commits: 4
---

# Phase 2 Plan 06: Hierarchy, unit memberships with leads, explicit rules and resolver-decided org/user topics Summary

Admins can now build and rearrange Department → Team → Project through the API. Every change is audited in the same transaction and announced on `org:<id>`. Moves rewrite the whole subtree in one statement under a per-organization advisory lock, so two opposite concurrent moves never create a cycle. Leads manage members of their own subtree and nothing else. Admins write explicit deny/allow rules: a deny on IT removes `channel.archive` from a Backend developer (403, layer `unit`, unitId IT) while the admin outside IT keeps it. Subscriptions to `org:` and `user:` topics are now resolver decisions.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (tracer) | `de9ebfd` | feat(02-06): admin builds and moves departments, teams and projects through audited resolver-decided APIs |
| 2 | `e2af736` | feat(02-06): rename and delete units, cycle-safe concurrent moves, unit memberships with subtree-scoped leads |
| 3 | `912abc9` | feat(02-06): explicit deny/allow rules API enforced through the resolver; org and user topics on the resolver |

## API added (all `config.authz: "user"`, Zod contracts from 02-03)

| Route | Decision | Domain errors |
|-------|----------|---------------|
| `GET /units` | `unit.read` (org); per-unit `viewerCan` ⊂ {unit.manage, unit.members.manage}; `lastSeq` of `org:<id>` | — |
| `POST /units` | `unit.manage` on the parent (org when top level) | 404 `unit_not_found`, 400 `invalid_parent_kind`, 409 `unit_name_taken` |
| `PATCH /units/:id` | `unit.manage` on the unit | 409 `unit_name_taken` (case-insensitive siblings) |
| `POST /units/:id/move` | `unit.manage` on the unit and on the target | 409 `unit_cycle`, 400 `invalid_parent_kind`, 409 `unit_name_taken` |
| `DELETE /units/:id` | `unit.manage` | 409 `unit_has_children` |
| `GET /units/:id/members` | `unit.read` on the unit | — |
| `POST /units/:id/members` | `unit.members.manage`; role lead also `unit.manage` | 400 `unknown_member`, 400 `lead_requires_role`, 409 `already_member` |
| `PATCH /units/:id/members/:userId` | `unit.manage` | 404 `not_a_unit_member`, 400 `lead_requires_role` |
| `DELETE /units/:id/members/:userId` | `unit.members.manage`; removing a lead also `unit.manage` | 404 `not_a_unit_member` |
| `GET /permission-rules` | `rule.read` | — |
| `POST /permission-rules` | `rule.manage` | 400 `validation_error` (contract), 404 `unit_not_found`, 400 `unknown_subject` |
| `DELETE /permission-rules/:id` | `rule.manage` | 404 `rule_not_found` |

Events on `org:<id>`: `units.updated` `{unitId, action}` with action `created | renamed | moved | deleted | members`, and `permission_rules.updated` `{ruleId, action}` with action `created | deleted`.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` | Task 1: 5 passed. After Task 2: **11 passed** |
| `pnpm exec vitest run --project unit apps/api/src/modules/organization/units.test.ts` | **16 passed**: a 12-cell truth table, a projects-are-leaves check, 2 `fc.assert` properties at numRuns 300 and the explicit cycle cases. No counterexample |
| `pnpm exec vitest run --project integration apps/api/src/modules/organization/rules.int.test.ts apps/api/src/identity.int.test.ts` | **14 passed** (7 + 7) |
| `pnpm verify` after each task | Task 1: lint and typecheck clean. One testcontainers port-binding timeout in `tokens.int.test.ts` (see deviation 5), which passed 9/9 on rerun. Task 2: exit 0, 44 files / 421 tests. Task 3: **exit 0, biome 374 files clean, turbo 8/8, 45 files / 428 tests** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` | **11 passed (39.3 s)**, exit 0. The script adopted the running compose project automatically. It ran setup, then bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390. The chat and bots specs subscribe to `org:`/`user:` topics, which now go through the resolver authorizers. Afterwards :4290 was held by the 02-08 executor's queued run (its cwd is `ocw-02-08`), not by this one |

**Mutation checks (the tests bite):**
- With the descendant check removed from `applyMove`, fast-check fails 2 tests and shrinks to the counterexample "move u0 under its child u2".
- With `lockUnits` removed from the move route, the concurrency test fails with `expected [200, 200] to deeply equal [200, 409]`. Without the lock, both opposite moves commit and form a cycle.

**Acceptance greps:**
- `units.ts` contains `pg_advisory_xact_lock`, `"unit.moved"`, `validateParentKind`, `"unit_has_children"`, `"lead_requires_role"`, `"unit_membership.added"`, `"unit_membership.role_changed"` and `"unit.deleted"`.
- `index.ts` contains `registerUnitRoutes`, `registerTopicAuthorizer("org"` and `registerTopicAuthorizer("user"`.
- `rules.ts` contains `requirePermission("rule.manage")` and `"permission_rule.created"`.
- `units.test.ts` contains `fc.assert`.
- `grep -c "auth.organizationId === id\|auth.userId === id" realtime/service.ts` prints 0.

**Demo stack (hard rule):** `:4000/health` 200 and `:3000/login` 200 before and after the run. `ocw-demo-openclaw` is still running, started 2026-10-04T15:54:27Z. None of these were run: `docker compose down/rm/stop/restart`, `db:migrate` against the default `.env`, `demo:*`. Nothing bound :4000 or :3000.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Removing a lead requires `unit.manage`**
- **Found during:** Task 2
- **Issue:** As written, the plan only needed `unit.members.manage` to remove a membership. A lead of IT could then remove the lead of a team under IT, or remove a co-lead, and so take away lead authority that only an admin can grant (T-02-06-03).
- **Fix:** `DELETE /units/:id/members/:userId` on a `lead` membership also asserts `unit.manage`. Plain members can still be removed by subtree leads. Tested: a lead removing a lead gets 403.
- **Commit:** `e2af736`

**2. [Rule 3 - Blocking] The legacy-check guard flagged unit-role comparisons**
- **Found during:** Task 2 (`pnpm verify`)
- **Issue:** `guard.test.ts` matches `role === "lead"` anywhere in `apps/api`. Here the comparisons were on the unit-membership role value (data), not on the caller's org role.
- **Fix:** Use `isLeadMembership(unitRole)`, which compares against `UnitRole.enum.lead`. Every authorization decision stays in the resolver (`unit.manage`). The target-eligibility rule (`LEAD_ORG_ROLES.includes(target.role)`, D-06) is a check on the target user, not on the caller. No `authz-legacy` marker was added.
- **Commit:** `e2af736`

**3. Lock before decide**
- For create, move and delete, the plan orders the steps as assertCan, then lock, then re-read. This implementation locks first, then reads, then decides, so the decision and the write see the same committed tree. A denied caller holds the per-org lock only for the length of its own short transaction.

**4. Small additions within the plan's intent**
- `DELETE /units/:id` also appends `permission_rules.updated` (action `deleted`) for each scoped rule that cascades with the unit, so rule lists refresh.
- A move to the unit's current parent returns the unit with no audit row and no event.

**5. [Environment] Flaky testcontainers start under parallel executors**
- The first `pnpm verify` failed in `tokens.int.test.ts` with "Timed out after 10000ms while waiting for container ports to be bound". That happened while five executors were starting containers at once. The file passed 9/9 when run alone, and every later `pnpm verify` exited 0. The code was not changed for this.

**6. TDD commit granularity**
- As in 02-01, 02-02 and 02-03, each task's tests are committed together with the implementation (one `feat` commit per task), so every commit passes `pnpm verify`. That the tests bite is shown by the two mutation checks above.

**7. Branch namespace**
- Commits are on `wt/02-06`, as the orchestrator instructed. The executor's `agent-*` branch allow-list was not applied. Nothing was pushed.

## Notes for later plans

- Web (02-1x): `OrgUnit.viewerCan` gives a lead `["unit.members.manage"]` on every unit in their subtree and `[]` elsewhere. An admin gets both permissions. Refetch on `units.updated` / `permission_rules.updated` (lib/permissions.ts already refetches `/me/permissions` on `units.updated`).
- `units.ts` exports `lockUnits`, `requireUnit`, `loadUnit`, `unitView`, `unitsChanged`, `orgTopic`, `uuidArray` and `isUniqueViolation` for 02-1x admin console needs. They are not re-exported from `organization/index.ts`, because no other module needs them yet.
- `memberDetail` with unit chips (`MemberDetail` contract) is not built here; it belongs to the member admin plan.

## Known Stubs

None.

## Threat Flags

None. Every new endpoint is covered by T-02-06-01…06:
- Tenant: RLS, plus a 404 for unknown parent, unit or rule ids.
- Cycle: the per-org lock, a fast-check property and a concurrency test.
- Lead escalation: tested for a sibling unit, for appointing a lead and for removing one.
- Non-delegable allows: rejected by the contract (400) and ignored by the resolver.
- Repudiation: audit rows are written in the same transaction.
- Topics: tenant check plus a resolver decision, with no defaults left.

## Self-Check: PASSED

Files: units.ts, rules.ts, units.test.ts, units.int.test.ts, rules.int.test.ts present. Commits de9ebfd, e2af736, 912abc9 present on wt/02-06.
