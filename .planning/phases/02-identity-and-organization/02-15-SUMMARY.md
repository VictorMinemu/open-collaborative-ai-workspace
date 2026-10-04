---
phase: 02-identity-and-organization
plan: 15
subsystem: api (authorization rails), demo, docs
status: complete
tags: [authz, strict-coverage, guard, auth-context, demo-seed, adr, phase-gate]
requires: ["02-02", "02-04", "02-05", "02-06", "02-07", "02-08", "02-09", "02-10", "02-11", "02-12", "02-13", "02-14"]
provides:
  - "installAuthz strict when NODE_ENV=test: a non-public 2xx without a resolver decision is a 500 in every integration and e2e run"
  - "apps/api/src/authz.int.test.ts: every route declares config.authz, the public set equals a 14-route allowlist, WS routes declare user/device/cell, throwaway undecided route answers 500, /me role read from org_members"
  - "AuthContext without role; legacy requireRole preHandler and its IdentityService facade deleted"
  - "guard.test.ts final form: any legacy marker fails (tests included), legacy helper names banned in api and web, self-check per helper"
  - "Demo seed with the four roles and the hierarchy IT › Backend › Team Alpha › Workspace App and Marketing › Content"
  - "docs/DEMO.md roles table, roles/organization step, Account and access section (profile, security, password reset, SMTP, legacy device token, BETTER_AUTH_SECRET / auth.jwks)"
  - "ADR-0007 (roles, hierarchy, resolver, enforcement rails) and ADR-0008 (short-lived JWTs for REST, browser WebSocket and Device Link)"
affects: [phase-3]
tech-stack:
  added: []
  patterns:
    - "Strict authz only under NODE_ENV=test; production warns and records (T-02-15-03)"
    - "Adding a public route is a reviewed change to PUBLIC_ROUTES in authz.int.test.ts"
key-files:
  created:
    - apps/api/src/authz.int.test.ts
    - docs/adr/0007-roles-hierarchy-and-permission-resolver.md
    - docs/adr/0008-short-lived-jwts-for-websockets-and-device-link.md
  modified:
    - apps/api/src/app.ts
    - apps/api/src/core.ts
    - apps/api/src/modules/identity/authenticate.ts
    - apps/api/src/modules/identity/service.ts
    - apps/api/src/modules/organization/permissions/guard.test.ts
    - apps/api/src/modules/organization/units.ts
    - apps/api/src/modules/realtime/gateway.ts
    - scripts/demo-seed.mjs
    - scripts/setup-env.mjs
    - docs/DEMO.md
decisions:
  - "Strict route coverage is on only when NODE_ENV=test (unit, integration and the isolated e2e API); production and dev keep warn-and-record"
  - "The guard bans the migration marker outright (tests included); its own pattern is assembled at runtime so the guard file contains no marker"
  - "/me reads the display role from app.org_members; principals (cookie or JWT) carry no role"
metrics:
  started: 2026-10-04T20:40:03Z
  completed: 2026-10-04T20:56:00Z
  duration: 16min
actuals:
  tokens: 11300
  tasks: 2
  commits: 3
---

# Phase 2 Plan 15: Strict authz coverage, role-free AuthContext, demo hierarchy, ADR-0007/0008 and the phase gate Summary

The build now enforces "no ad-hoc authorization check". Every route declares how it is authorized, and the public surface is a fixed 14-route allowlist. In tests (and in the isolated e2e API, which runs with `NODE_ENV=test`) a non-public route that answers 2xx without a resolver decision becomes a 500. `AuthContext` has no role, so a new role check does not compile. The static guard finds no migration marker and no legacy helper anywhere. The demo seed creates one person per PRD role and the full hierarchy. DEMO.md, ADR-0007 and ADR-0008 document the result. The phase gate is green.

## Commits

| Task | Commit | Message |
|---|---|---|
| 1 | `9258a2d` | feat(02-15): strict route authz coverage, no role in AuthContext, final legacy guard |
| 2 | `b6248b0` | docs(02-15): demo hierarchy and four roles, DEMO.md account notes, ADR-0007 and ADR-0008 |
| — | (this file) | docs(02-15): complete phase gate plan |

## What changed

- **Strict coverage.** `app.ts` installs `installAuthz(app, { strict: env.NODE_ENV === "test" })`.
- **Route coverage test** (`authz.int.test.ts`, 6 tests):
  - It boots the full stack. All 98 routes declare `config.authz`, and none is undeclared.
  - The public set equals `PUBLIC_ROUTES` exactly (14 routes). No `/docs` route is registered under test; the prefix exclusion stays for when one is.
  - `GET /ws` is `user`, `GET /runtime/ws` is `device` and `GET /agent-channel/v1/ws` is `cell`.
  - A second `buildApp` registers a throwaway `authz: "user"` route that answers without a decision: it returns 500, and the decided twin returns 200.
  - `/me` reports `organization.role` = admin through both the cookie and a Bearer JWT.
  - Mutation check: with `strict: false`, 2 of the 6 tests fail.
- **Coverage report.** Only one route lacked a declaration: `GET /ws`, now `user`, with no behaviour change. Its topic subscriptions are decided by the resolver authorizers from 02-06. No 2xx route answered undecided in any suite. Files touched beyond the plan's list: `apps/api/src/modules/organization/units.ts` (rename, see deviation 1). `device/link.ts` and `agent-channel/gateway.ts` already declared `device`/`cell` (02-10, 02-11) and were not changed.
- **No role in the principal.**
  - `AuthContext.role` is deleted. `authenticate.ts` no longer reads the role on the cookie path; it only reads `deactivatedAt`.
  - The `requireRole` preHandler, its `Authenticator` member and the `IdentityService.requireRole` facade are gone.
  - `verifyAccessToken` no longer sets a role.
  - `me()` reads `orgMembers.role` from `app.org_members` through `authDb`.
  - Both identity files lost their marker lines. Typecheck surfaced no other consumer: every route had already moved to the resolver in waves 3 and 4.
- **Final guard** (`guard.test.ts`):
  - Any marker in `apps/api/src` or `apps/web/{app,components,lib}` fails, test files included. The guard builds its own pattern at runtime, so `grep -rln authz-legacy apps/api/src apps/web` prints nothing.
  - `LEGACY_HELPERS` (canRead, requireReadable, requireWritable, canUseDevice, listUsableProjects, assertCanApprove, requireActiveAgent, requireMembership, requireRole) is banned in the API and the web, alongside `useIsAdmin`, `isAdmin` and role-vs-literal comparisons.
  - The self-check proves each helper name is caught.
  - Mutation check: a marker in `core.ts` and a `requireMembership` in a web file each fail the guard.
- **Demo seed.**
  - Roles: Víctor is Organization Admin through setup. Alex is invited as `lead`, Marta as `developer`, Sam as `standard`.
  - Units are created via `POST /api/v1/units`: IT › Backend › Team Alpha › Workspace App (project), and Marketing › Content.
  - Memberships: Víctor member of IT, Alex lead of Backend, Marta member of Team Alpha, Sam member of Content.
  - The seed prints one line per step with the full unit path and lists each person's role at the end.
- **DEMO.md.**
  - "Seeded workspace" now has a roles/units table and the hierarchy, plus a note that a pre-Phase-2 demo needs `pnpm demo:reset` to get them.
  - New script step 7 covers roles and organization: Members role select, "What can each role do?", the Organization tree, and Sam as a Standard User with no Work Zone.
  - New "Account and access" section: Profile/Security with session device labels; password reset (admin link via *Create password reset link*, `OCW_SMTP_URL`/`OCW_MAIL_FROM`); `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`; and the `BETTER_AUTH_SECRET` rotation steps (`DELETE FROM auth.jwks`, everyone signs in again).
  - Two troubleshooting rows were added.
- **setup-env.mjs.** `--force` prints the `auth.jwks` rotation caveat. A comment documents `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`.
- **ADR-0007** covers the roles (D-06 migration, ceiling, last-admin invariant), the hierarchy (D-07, advisory-locked moves, no ltree), the resolver semantics (principal gate, grants, preconditions, layered denies, agent ∩ human), the rules (D-02, non-delegable), the HTTP mapping, the three enforcement rails and the deferrals.
- **ADR-0008** covers the jwt plugin (EdDSA, `auth.jwks`, minimal claims, 10 minutes), the jose verifier with a cached JWKS, REST cookie-or-Bearer (D-01), the `ocw.auth.<jwt>` subprotocol with `ocw.v1` echoed, Redis revocation closing sockets with 4401, the device-token → device JWT exchange with its own audience, the legacy flag until Phase 8 (D-03), and why oauth-provider is deferred. Consequences: secret rotation, Phase 8, token lifetime.

## Phase gate (commands and results)

| Command | Result |
|---|---|
| `pnpm exec vitest run --project unit …/guard.test.ts apps/api/src/authz.test.ts` | 9 passed (2 files) |
| `pnpm exec vitest run --project integration apps/api/src/authz.int.test.ts` | 6 passed. Mutation `strict: false`: 2 failed, as expected |
| `pnpm verify` (after Task 1) | exit 0. Lint: 4 pre-existing warnings in apps/local-runtime. Typecheck 8/8. **54 files / 535 tests passed**, with strict coverage on in every integration suite |
| `pnpm --filter @ocw/local-runtime test` | 9 files / **113 passed** |
| `pnpm --filter @ocw/desktop test` | 9 files / **58 passed** |
| `pnpm --filter @ocw/openclaw-channel test` | 6 files / **51 passed** |
| `bash scripts/e2e-isolated.sh` | **35 passed (1.8 min)**, exit 0, 0 flaky: setup, then account, admin-members, admin-org, bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390. API log: 0 "without a permission decision", 0 responses with status 429, 0 with 5xx. The API ran with NODE_ENV=test (the `/api/v1/test/chat/*` routes answered), so strict coverage was active end to end |
| `DEMO_PASSWORD=Demo-e2e-check bash scripts/e2e-isolated.sh --cmd "node scripts/demo-seed.mjs"` | exit 0 on a fresh `ocw_e2e` (run twice, the second after the path-label tweak): setup; Alex (Team Lead, role lead), Marta (Developer, role developer), Sam (Standard User, role standard); 3 channels; 6 units (IT, IT › Backend, IT › Backend › Team Alpha, IT › Backend › Team Alpha › Workspace App, Marketing, Marketing › Content); 4 unit memberships; 8 history messages |
| `pnpm verify` (final, after Task 2) | exit 0, **54 files / 535 tests passed** |
| Acceptance greps | `role: OrgRole` in core.ts: none. `authz-legacy` in apps/api/src and apps/web: none. app.ts contains `strict: env.NODE_ENV === "test"`. The seed contains `role: "lead"`, `role: "standard"`, `"/api/v1/units"` and `Team Alpha`. DEMO.md mentions `OCW_SMTP_URL`, `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` and `auth.jwks`. Both ADRs have Status/Context/Decision/Consequences |

**Demo stack (hard rule).** Before and after the gate: `:4000/health` 200, `:3000/login` 200, and `ocw-demo-openclaw` running, started 2026-10-04T15:54:27Z. After the runs nothing listens on :4290. None of these were run: `docker compose down/rm/stop/restart`, `pnpm db:migrate` with the default `.env`, `pnpm demo:*`. Nothing bound :4000 or :3000. The owner's demo database was not seeded; the owner runs `pnpm demo:reset` when they choose.

## Pending items from earlier summaries

- **Remove AuthContext.role and the legacy preHandler:** done.
- **Strict route coverage:** done.
- **The legacy-marker guard ends empty:** done.
- **`OCW_ACCEPT_LEGACY_DEVICE_TOKEN` in DEMO.md and setup-env.mjs (02-11):** done.
- **Demo seed with the hierarchy and the four roles; ADR-0007/0008:** done.
- **e2e sign-in rate limit (02-12, 02-14):** the full 35-test suite had no 429. The session reuse that 02-12 and 02-14 put in place is enough, so nothing changed and the API limit was not touched.
- **Mobile smoke flake (02-12: `[mobile] smoke.spec.ts:30`, drawer `nav-settings` detached):** it did not reproduce. The mobile smoke passed in the full run (2.5 s). The nav items are keyed by id and filtered by `usePermissionCheck()`, so a late permissions refetch can re-render the drawer list once, which fits a one-off detach. With no failing run there was nothing to fix safely, so it is left as an observation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A data loader in units.ts was named after a banned legacy helper**
- **Found during:** Task 1 (adding the legacy helper names to the guard)
- **Issue:** `apps/api/src/modules/organization/units.ts` had a private `requireMembership(tx, unitId, userId)`. It loads the unit membership row (404 `not_a_unit_member`) and is not an authorization check, since the decision is `perms.assertCan(... "unit.manage" | "unit.members.manage")`. Its name matched the banned `requireMembership`.
- **Fix:** Renamed it to `loadUnitMembership`, with no behaviour change. The guard self-check asserts that `loadUnitMembership(` is not flagged.
- **Files modified:** apps/api/src/modules/organization/units.ts
- **Commit:** 9258a2d

**2. [Rule 2 - Correctness] Corrected the planned wording of the BETTER_AUTH_SECRET caveat**
- **Found during:** Task 2 (DEMO.md)
- **Issue:** Rotating the secret does more than invalidate JWTs. better-auth signs the session cookie with it (`setSignedCookie`), so everyone is signed out. Token issuance also fails with "Failed to decrypt private key" until `auth.jwks` is emptied (research Pitfall 10).
- **Fix:** DEMO.md, ADR-0008 and the setup-env message state both effects, and DEMO.md gives the `DELETE FROM auth.jwks;` step.
- **Commit:** b6248b0

**3. [Scope] Extra file: scripts/setup-env.mjs**
- The orchestrator's pending list asked for the legacy flag to be documented there, and 02-11 also flagged it. It was not in the plan's `files_modified`. The change is a comment plus a `--force` message; generated `.env` contents are unchanged.

### Notes

- The guard acceptance criterion said the marker grep "lists only guard.test.ts". It now lists nothing, because the guard assembles its pattern at runtime. That is stricter than required.
- Task 1 is a `tdd` tracer, but the test and the implementation went in one `feat` commit, as in earlier plans of this phase, so that every commit passes `pnpm verify`. To show the tests bite, both new suites were mutation-checked: strict mode off, an injected marker and an injected legacy helper. Each mutation was caught.
- The pre-commit worktree branch allow-list (agent-*) does not apply: the orchestrator ran this plan directly on `feat/phase-2-identity-org`, as instructed. Nothing was pushed.

## Known Stubs

None.

## Threat Flags

None. No new endpoint, auth path or schema change. The only new surface is test-only: throwaway routes on a second app instance inside `authz.int.test.ts`.

## Self-Check: PASSED

- FOUND: apps/api/src/authz.int.test.ts
- FOUND: docs/adr/0007-roles-hierarchy-and-permission-resolver.md
- FOUND: docs/adr/0008-short-lived-jwts-for-websockets-and-device-link.md
- FOUND: commit 9258a2d
- FOUND: commit b6248b0
