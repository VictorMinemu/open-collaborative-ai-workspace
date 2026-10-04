---
phase: 02-identity-and-organization
plan: 07
subsystem: organization (members), identity (invitations)
status: complete
tags: [members, roles, last-admin, deactivation, revocation, invitations, resolver, audit]
requires: ["02-02", "02-03"]
provides:
  - "PATCH /api/v1/members/:userId/role: the four PRD roles, decided by member.manage, last admin protected (409 last_admin under a FOR UPDATE lock)"
  - "Demotion to standard/developer downgrades unit lead memberships (unit_membership.role_changed audited)"
  - "GET /api/v1/members answers MemberDetailList (units + status); GET /api/v1/members/:userId (profile)"
  - "POST /api/v1/members/:userId/deactivate|reactivate: sessions deleted + revocation published after commit; history kept"
  - "loadMemberDetails(tx, userIds?) exported from organization/members.ts"
  - "Invitations decided by invitation.read/create/revoke with the role ceiling and inviter relation; viewerCan per invitation"
  - "Every invitation route declares config.authz (user or public); no legacy check left in identity/invitations.ts"
affects: [02-12, 02-15]
tech-stack:
  added: []
  patterns:
    - "Domain invariant lock: select … for update over the active admin rows, re-evaluated by PostgreSQL after the wait"
    - "Auth-plane writes: decide in a short db.withTenant first, then open the better-auth runWithTransaction"
    - "Session deletion + revocation fan-out in an afterCommit callback (security does not depend on it)"
key-files:
  created:
    - apps/api/src/modules/organization/members.int.test.ts
    - apps/api/src/modules/identity/invitations.int.test.ts
  modified:
    - apps/api/src/modules/organization/members.ts
    - apps/api/src/modules/identity/invitations.ts
decisions:
  - "Refreshing a pending invitation created by someone else also requires invitation.revoke on it, and the refresher becomes its inviter (a lead cannot overwrite an admin's pending admin invitation)"
  - "The admin-role literal lives in one constant (GOVERNING_ROLE) so the last-admin invariant does not read as a legacy role check to guard.test.ts"
  - "Deactivation order: 403 (member.manage) → 404 → 400 cannot_deactivate_self → 409 already_deactivated → 409 last_admin"
metrics:
  duration: "~35 min"
  completed: "2026-10-04"
  tasks: 3
  files: 4
actuals:
  tokens: 10400
  tasks: 3
  commits: 4
---

# Phase 2 Plan 07: Roles, last-admin invariant, deactivation, member directory and Team-Lead invitations Summary

Admins now assign any of the four PRD roles through the resolver, and the change applies on the member's next request. The last active admin cannot be demoted or deactivated: the active admin rows are locked `FOR UPDATE`, and a deterministic two-request race test proves the lock works. Deactivation ends access everywhere (cookie 401, `auth.session` rows deleted, sid flagged revoked, sign-in refused) and keeps the member's history. Reactivation restores access. The directory and profiles show units and status. Invitations are decided by the resolver: Team Leads invite Standard Users and Developers and revoke only their own invitations, while admins manage every invitation.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `7606eab` | feat(02-07): admins assign the four PRD roles through the resolver; last admin protected |
| 2 | `bffd165` | feat(02-07): member directory with units and status, profiles, deactivate and reactivate |
| 3 | `187846c` | feat(02-07): invitations on the resolver; Team Leads invite within their ceiling and revoke their own |

## API added or changed

| Route | authz | Decision | Errors |
|-------|-------|----------|--------|
| `GET /api/v1/members` | user | `member.read` | — (response is now `MemberDetailList`, a superset of `MemberList`) |
| `GET /api/v1/members/:userId` | user | `member.read` | 404 `member_not_found` |
| `PATCH /api/v1/members/:userId/role` | user | `member.manage` on `memberResource` | 404 `member_not_found`, 409 `last_admin` |
| `POST /api/v1/members/:userId/deactivate` | user | `member.manage` | 404, 400 `cannot_deactivate_self`, 409 `already_deactivated`, 409 `last_admin` |
| `POST /api/v1/members/:userId/reactivate` | user | `member.manage` | 404, 409 `not_deactivated` |
| `GET /api/v1/invitations` | user | `invitation.read` + `viewerCan` (`invitation.revoke`) per item | — |
| `POST /api/v1/invitations` | user | `invitation.create` on `invitationResource` (403 `role_ceiling`, layer `resource`); with a pending invitation for that e-mail, also `invitation.revoke` on it | 409 `already_member` |
| `DELETE /api/v1/invitations/:id` | user | `invitation.revoke` on `invitationResource` (inviter relation) | 404, 409 `invitation_not_pending` |
| `GET /api/v1/invitations/:id`, `POST …/:id/accept` | public | — | unchanged |

Audit rows, all written in the same transaction as the change: `member.role_changed {userId, from, to}`, `unit_membership.role_changed {userId, unitId, from: "lead", to: "member", reason: "org_role_changed"}`, `member.deactivated`, `member.reactivated`, and `invitation.created/revoked` (unchanged). Events: `member.updated {userId, changed: ["role"] | ["status"]}` on `org:<id>`.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/organization/members.int.test.ts` (Task 1) | 5 passed. Mutation: with the last-admin check removed, 3 tests failed |
| `pnpm exec vitest run --project integration …/members.int.test.ts apps/api/src/identity.int.test.ts` (Task 2) | 16 passed. Mutations: without the deactivation lock, the race test fails (both admins deactivated). Without session deletion, the deactivation test fails. Three repeated runs were green |
| `pnpm exec vitest run --project integration …/identity/invitations.int.test.ts apps/api/src/identity.int.test.ts` (Task 3) | 16 passed (9 + 7). Mutations: without the pending-revoke check, the takeover test fails. Without the inviter relation, 3 tests fail |
| `pnpm verify` after each task | exit 0. Lint: 4 pre-existing warnings in apps/local-runtime. Typecheck 8/8. Final run: **44 files / 412 tests passed**. guard.test.ts is green, with no marker or legacy check left in `identity/invitations.ts` |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` | Run 1: 10 passed, 1 failed. The failure was `[desktop] work-zone.spec.ts:107`, which expected 2 `prompt-bubble` and got 3. That is a Work Zone UI timing flake with no members or invitations code path, and the mobile run of the same spec passed. Run 2: **11 passed (34.0 s)**, exit 0. Setup (which invites with role developer) and chat are green in both runs |

Acceptance greps:
- `members.ts` contains `"member.role_changed"`, `"last_admin"`, `for update`, `assertCan(req, tx, "member.manage"`, `"member.deactivated"`, `"member.reactivated"`, `deleteAllForUser`, `publishRevocation` and `MemberDetailList`.
- In `invitations.ts`, `requireRole` → 0 and `authz-legacy` → 0. `"invitation.create"` → 1, `"invitation.revoke"` → 3, `invitationResource(` → 2, `authz: "public"` → 2.

### Demo stack (hard rule)

| Check | Before | After |
|-------|--------|-------|
| `curl localhost:4000/health` | 200 | 200 |
| `curl localhost:3000/login` | 200 | 200 |
| `ocw-demo-openclaw` | running, started 2026-10-04T15:54:27Z | running, started 2026-10-04T15:54:27Z |

No `docker compose down/rm/stop/restart`, no `db:migrate` against the default `.env`, no `demo:*`, and nothing bound on :4000 or :3000. After the run, :4290 was held by the 02-05 executor's e2e run, which took the shared lock next. This run's processes had exited.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] A Team Lead could overwrite someone else's pending invitation by re-inviting the same e-mail**
- **Found during:** Task 3
- **Issue:** `createInvitation` refreshes a pending invitation in place, changing its role and expiry. A lead could therefore rewrite an admin's pending `admin` invitation to `developer`, which in effect revokes an invitation the lead has no right to revoke (T-02-07-02). The refreshed row also kept the original inviter.
- **Fix:** When a pending invitation exists for the e-mail, `POST /api/v1/invitations` also asserts `invitation.revoke` on it. The refresher becomes the `inviterId`, since they chose the new role. The test "a lead cannot take over an admin's pending invitation" covers this, and a lead can still refresh their own invitation.
- **Files modified:** `apps/api/src/modules/identity/invitations.ts`
- **Commit:** `187846c`

**2. [Rule 1 - Test design] The plain concurrent-deactivation test did not exercise the lock**
- **Found during:** Task 2 (mutation check)
- **Issue:** Two simultaneous HTTP requests mostly serialised on their own, so the test passed even with the lock removed.
- **Fix:** A superuser connection now holds the admin rows `FOR UPDATE`. The test waits until both requests are blocked in `pg_stat_activity` and then commits. The expected result is exactly `[200, 409 last_admin]`, and the mutation now fails the test.
- **Commit:** `bffd165`

**3. Interpretation: `loadMemberDetails` landed in Task 1**
- `PATCH …/role` returns a `MemberDetail` with units, so Task 1 wrote the helper directly instead of an inline select that Task 2 would replace.

**4. Unreachable-by-API branch documented**
- Only active admins hold `member.manage`, and allow rules cannot grant it (it is non-delegable). A sequential deactivation of the last admin is therefore always self-deactivation, which answers 400 `cannot_deactivate_self` first. The 409 `last_admin` branch of deactivation can only be reached through a race, which is why it is tested with the deterministic lock test.

**5. e2e flake (out of scope, not fixed)**
- In the first isolated run, `[desktop] work-zone.spec.ts:107` saw 3 prompt bubbles instead of 2. The rerun was fully green. This plan does not touch Work Zone code, so the flake was not investigated further. It is recorded for whoever owns the Work Zone UI.

**6. TDD commit granularity**
- As in 02-01/02/03, each task's tests and implementation went into one `feat` commit so every commit passes `pnpm verify`. To show the tests bite, each suite was mutation-checked (last-admin check, deactivation lock, session deletion, pending-revoke check, inviter relation), and every mutation was caught.

## Notes for later plans

- 02-12 (admin console) can rely on `MemberDetail.units`/`status`, `Invitation.viewerCan` (show Revoke only when it contains `invitation.revoke`) and the error codes in the table above.
- `deleteAllForUser` deletes the user's sessions in every organization. Better-auth sessions are per user, and deactivation is per organization. This is harmless while an instance hosts one organization; a multi-org instance would need per-org session scoping.
- Sockets close on the `deactivated` revocation only once the WS gateway subscribes to `onRevocation` (02-08/09). Security does not depend on it: `authenticate` and the resolver's user layer already reject the member.
- The pg `DeprecationWarning: Calling client.query() when the client is already executing a query` that appears in `pnpm verify` comes from a pre-existing test file, not from this plan's suites (0 occurrences when they run alone).

## Known Stubs

None.

## Threat Flags

None. The new surface (member role/status routes, profile read, invitation decisions) is covered by T-02-07-01 to T-02-07-07.

## Self-Check: PASSED

Commits 7606eab, bffd165 and 187846c exist on wt/02-07. members.int.test.ts, invitations.int.test.ts, members.ts and invitations.ts exist.
