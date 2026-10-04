---
phase: 02-identity-and-organization
verified: 2026-10-04T21:03:26Z
status: passed
score: 5/5 success criteria verified (9/9 requirements satisfied)
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "Daemon connections are authenticated with short-lived JWTs (AUTH-06): the server still accepts the raw hashed device token by default (OCW_ACCEPT_LEGACY_DEVICE_TOKEN defaults to true) for pre-Phase-2 desktop builds"
    addressed_in: "Phase 8"
    evidence: "Phase 8 SC2: 'the device ... authenticates on /runtime/ws with a signed challenge instead of the MVP 0 hashed bearer token'. Locked decision D-03 / ADR-0008. The current daemon already exchanges for a 10-minute device JWT (apps/local-runtime/src/daemon.ts:217)"
  - truth: "A live realtime subscription is re-authorized when the subscriber's membership changes"
    addressed_in: "Phase 3"
    evidence: "Phase 3 SC3: 'A client loses a subscription automatically when its membership is removed ... resolved through the Phase 2 resolveEffectivePermissions resolver' (RT-01). Phase 2 decides at subscribe time"
human_verification:
  - test: "Configure OCW_SMTP_URL / OCW_MAIL_FROM against a real SMTP server (e.g. a Mailpit container or the production relay), use 'Forgot password' on /login, open the received e-mail and complete the reset"
    expected: "One e-mail arrives with a link to {OCW_PUBLIC_WEB_URL}/reset-password?token=...; the link works once; every session of that user is signed out; password.reset_requested and password.reset_completed audit rows exist"
    why_human: "All automated runs use the in-memory 'memory:' transport (refused outside NODE_ENV=test, env.ts). Delivery through a real SMTP server is an external-service integration the suite cannot exercise"
  - test: "Skim the 02-12/02-13/02-14 screenshots in .planning/phases/02-identity-and-organization/screenshots/ (Members, Organization, Profile, Security, reset/forgot password at 390 and 1440, light and dark)"
    expected: "Layouts read cleanly on mobile and desktop with no clipped controls; you are happy with the look before the PR"
    why_human: "Visual quality is part of done in this repo; the e2e suite proves the flows work, not that they look right. The verifier inspected org-tree-desktop and account-security-mobile and found no defect"
---

# Phase 2: Identity and Organization Verification Report

**Phase Goal:** Every route (including every Phase 1 route: setup, invitations, channels and messages, bots and model providers, devices, Work Zone sessions and realtime subscriptions) is permission-checked through one resolver, an Organization Admin arranges members into departments, teams and projects with the four PRD roles, and users manage their passwords, sessions and profiles.
**Mode:** mvp
**Verified:** 2026-10-04T21:03:26Z
**Status:** human_needed (all automated checks pass; two short manual checks remain)
**Re-verification:** No, this is the initial verification

The verifier ran the gates itself. It did not rely on the SUMMARY claims.

| Gate | Result (run by the verifier) |
|---|---|
| `pnpm verify` | exit 0. Biome: 420 files, 4 warnings (pre-existing, apps/local-runtime). Typecheck: 8/8. Vitest: **54 files / 535 tests passed** (73 s) |
| `bash scripts/e2e-isolated.sh` | exit 0. **35 passed (1.9 min)**, 0 flaky: setup plus account, admin-members, admin-org, bots, chat, codex-subscription, smoke and work-zone at 1440 and 390 |
| e2e API log (`ocw-e2e.VfQl1f/api.log`) | 0 "without a permission decision", 0 responses with status 5xx, 0 with 429 |
| `vitest --project unit resolve.test.ts guard.test.ts` | 39 passed |
| Demo stack before and after | `:4000/health` 200, `:3000/login` 200, `ocw-demo-openclaw` healthy (up 5 h, not restarted), nothing left on :4290 |

## User Flow Coverage (MVP mode)

| Step | Expected | Evidence | Status |
|---|---|---|---|
| Admin builds the org | Department → Team → Project; rename, move, delete; staff units | e2e `admin-org.spec.ts:142`, `:214` (desktop and mobile) | VERIFIED |
| Admin assigns roles | Pick one of the four roles; the teammate's UI follows | e2e `admin-members.spec.ts:132`, `:235` | VERIFIED |
| Team Lead invites | Invites Standard or Developer; revokes their own invitations | e2e `admin-members.spec.ts` (lead ceiling, `pending-invitation` rows); `invitations.int.test.ts:79,92,141` | VERIFIED |
| User manages their account | Edit profile; list and revoke sessions; change and reset password | e2e `account.spec.ts:116`, `:208`, `:290`, `:333` | VERIFIED |
| Everything goes through the resolver | No 2xx answer without a decision | Strict mode was on in the e2e API (NODE_ENV=test) and the log has 0 undecided answers | VERIFIED |

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Password reset (e-mail with SMTP, admin link without it). Users view and revoke their sessions, each carrying the device/client id that Phase 1 records | VERIFIED | `identity/password.ts`: `/api/v1/password-reset/request` (:68, better-auth `sendResetPassword` via nodemailer, `auth.ts:125-133`), `/password-reset` (:114, token consumed and sessions revoked in one transaction with the audit row), admin link `/members/:userId/password-reset-link` (:156, `member.manage`), `/me/password` (:216). `identity/sessions.ts:41-125`: list, revoke one, revoke others, all decided by `account.manage` on self. `SessionInfo` carries `clientKind`/`clientLabel`. Tests: `password.int.test.ts:117-346` (9 tests, SMTP and non-SMTP), `sessions.int.test.ts:129,174,191`, `tokens.int.test.ts:250` (audit rows inherit session id and client kind), e2e `account.spec.ts:208,290,333` |
| 2 | Admin creates and moves Org → Department → Team → Project units, assigns the four roles (MVP 0 roles replaced), Team Leads invite and revoke, admin-console CRUD pages | VERIFIED | Migration `packages/db/drizzle/20261004184318_role_values` (owner/admin→admin, member→developer) plus `org_members_role_check` (standard, developer, lead, admin). `OrgRole` enum `contracts/src/common.ts:21`. Units API `organization/units.ts` (9 routes, advisory-locked moves). Role changes `members.ts:205-255` with a last-admin guard. `INVITABLE_ROLES` lead → [standard, developer] (`permissions.ts:164`); revoke comes from the `inviter` relation (`policy.ts:22`). Web pages: `settings/page.tsx` (Members), `settings/organization`, `settings/profile`, `settings/security`. Tests: `units.int.test.ts` (11 tests, including concurrent opposite moves → `unit_cycle`), `members.int.test.ts` (9), `invitations.int.test.ts` (9), e2e admin-org and admin-members |
| 3 | A single `resolveEffectivePermissions` (Org ∩ Dept ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device, explicit deny wins) decides every route, and every Phase 1 route is migrated | VERIFIED | Pure resolver `organization/permissions/resolve.ts:194` with layered deny ranks (org → units shallowest first → user → agent → tool, :164-185), device-layer and resource preconditions (`policy.ts:50-85`), and agent ∩ human (:241-250). Rails: `authz.ts` registry; `app.ts:181` makes it strict under test. `authz.int.test.ts`: all 98 routes declare `config.authz`, public set = 14-route allowlist, the WS routes are user/device/cell, and an undecided route answers 500. `guard.test.ts`: no marker, legacy helper or role literal in api/web. The verifier read every flagged handler and confirmed each one reaches the resolver: sessions/profile `assertSelf`, chat `readableChannel`, work-session `lockedFor`, agent/provider `requirePermission`, cell routes the `cell.sync` scope hook, Device Link `device.link`, and the 4 topic authorizers `org/user/conv/ws`. `AuthContext` has no role. `resolve.test.ts`: 31 tests including 8 fast-check properties (deny never adds, allow never removes, deny beats allow on any unit path, agent ⊆ human) |
| 4 | API and WebSocket connections authenticate with short-lived JWTs verifiable against JWKS; the browser WS moves off the cookie without breaking reconnect and replay | VERIFIED | better-auth `jwt()` plugin: EdDSA, 10 min, minimal claims `sid/org/ck` (`auth.ts:190-208`). `jose` verifier with cached JWKS and one refetch per cooldown (`identity/jwt.ts`). Bearer on every user route plus a Redis revocation deny-list (`service.ts:86-100`). `/ws` requires the `ocw.auth.<jwt>` subprotocol before the upgrade; cookies no longer open it (`realtime/gateway.ts:66-88`). Revocation closes sockets with 4401. Web `lib/realtime.tsx:32` passes `getToken`. Device Link: device JWT with its own audience (`device/token.ts`, `link.ts`). Tests: `jwt.int.test.ts` (6: tampered/expired/aud, revoked sid, kid rotation), `identity.int.test.ts:278,342,374` (WS replay exactly once, 4401 on revocation, recheck), `realtime-client/client.test.ts` (4401 refresh-and-reconnect, replay on gap), `device-link-auth.int.test.ts` (5) |
| 5 | Users view and edit their profile (name, avatar, status) and see other members' profiles. Hierarchy, role, membership, session revocation and failed sign-in are audited, in the same transaction when there is a domain write | VERIFIED | `identity/profile.ts` (GET/PATCH `/api/v1/me/profile`; avatars are an emoji or an https URL). `members.ts:121` any member's profile. Audit actions: `unit.created/renamed/moved/deleted`, `unit_membership.added/removed/role_changed`, `member.role_changed/deactivated/reactivated`, `permission_rule.created/deleted`, `session.revoked`, `user.sign_in_failed`, `user.signed_out`, `password.*`, `authz.denied`. All are written with `core.audit.record(tx, …)` inside the domain transaction, or `auditVia` inside better-auth's `runWithTransaction` on the auth plane. Tests: `profile.int.test.ts` (6), `sessions.int.test.ts:220,242,255`, `units.int.test.ts:161,364`, `members.int.test.ts:70,131`, e2e `account.spec.ts:116`, `admin-members.spec.ts:370` |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified). Every behavior-dependent truth has a passing test: revocation closing sockets, concurrent moves, last-admin under lock, and single-use reset tokens.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|---|---|---|
| 1 | Raw hashed device token still accepted by default (`OCW_ACCEPT_LEGACY_DEVICE_TOKEN=true`, `config/env.ts:72`), warned and audited `device.legacy_token_used` | Phase 8 | Phase 8 SC2 replaces the MVP 0 hashed bearer token. D-03 / ADR-0008 |
| 2 | Subscriptions are decided once, at subscribe time | Phase 3 | Phase 3 SC3 / RT-01 |

### Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `apps/api/src/modules/organization/permissions/resolve.ts` | VERIFIED | Pure; imported by `service.ts`; used by every module through `createPermissionService` |
| `apps/api/src/authz.ts` + `authz.int.test.ts` | VERIFIED | Installed in `app.ts:181` before the modules |
| `apps/api/src/modules/organization/{units,members,rules}.ts` | VERIFIED | Registered through `organization/index.ts`; RLS from the generic `post-migrate.sql` `tenant_isolation`, covered by `packages/db/src/rls-isolation.int.test.ts` (`org_units`, `unit_memberships`, `permission_rules`) |
| `apps/api/src/modules/identity/{jwt,password,sessions,profile}.ts` | VERIFIED | Registered and exercised by integration tests and e2e |
| Web: Members, Organization, Profile, Security, reset/forgot password | VERIFIED | Data comes from the API (`useCan` / `viewerCan`); e2e asserts real data at 390 and 1440 |
| `docs/adr/0007-…`, `docs/adr/0008-…`, `docs/DEMO.md`, `scripts/demo-seed.mjs` | VERIFIED | Present with Status/Context/Decision/Consequences. The seed creates the four roles and the hierarchy |

### Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| Every user/cell/device route | resolver | `perms.assertCan/can/filter/viewerCan/requirePermission/decide` → `markDecided` | WIRED (strict 500 otherwise; 0 undecided in the full e2e run) |
| `/ws` topics | resolver | `registerTopicAuthorizer` org/user/conv/ws → `perms.decide` | WIRED |
| Web realtime | `/api/auth/token` | `lib/auth-token.ts:34` → `RealtimeClient({ getToken })` | WIRED |
| Daemon | `/api/v1/devices/token` → `/runtime/ws` | `daemon.ts:217` device JWT, `link.ts:126` | WIRED |
| Session revoke / password reset / deactivate | open sockets | `publishRevocation` → Redis → `gateway.ts:47` close 4401 | WIRED |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| AUTH-04 | Password reset (SMTP or admin link) | SATISFIED (real SMTP delivery: human check) | SC1 |
| AUTH-05 | View and revoke sessions; device/client id | SATISFIED | SC1 |
| AUTH-06 | API/WS/daemon JWTs against JWKS; better-auth embedded | SATISFIED (legacy device token deferred to Phase 8) | SC4 |
| ORG-01 | Hierarchy CRUD including moves | SATISFIED | SC2 |
| ORG-02 | Four roles assigned to unit members | SATISFIED | SC2 |
| ORG-03 | Single resolver on every route | SATISFIED | SC3 |
| ORG-04 | Admin console CRUD (users, roles, units, memberships) | SATISFIED | SC2. Rules are read-only in the UI and managed through the API; ORG-04 does not list rules (ADR-0007) |
| ORG-05 | Sensitive actions audited in the same transaction | SATISFIED for Phase 2 scope | SC5. Later actions are owned by later phases |
| ORG-06 | Own and others' profiles | SATISFIED | SC5 |

There are no orphaned requirements: all nine IDs mapped to Phase 2 appear in the plans. The traceability table in REQUIREMENTS.md still says "Pending". The orchestrator, not the verifier, owns that update.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|---|---|---|---|
| (phase-changed files) | TBD / FIXME / XXX | none found | — |
| (phase-changed files) | TODO / HACK / placeholder | none (one string literal in a local-runtime test fixture) | — |
| `apps/api/src/authz.ts:54` | Strict coverage only when `NODE_ENV=test`; production warns and records | Info | Intentional (T-02-15-03). The verifier checked every route handler manually and found no undecided path |
| `organization/permissions/policy.ts` resource builders | Phase 1 resources (channels, devices, work sessions) live at the org root (`unitPath: []`), so Department/Team/Project layers act through the principal's unit memberships | Info | Documented in ADR-0007. Unit-scoped resources come with later features |
| REST from the browser | Still uses the session cookie; Bearer JWT is accepted on every user route (D-01) | Info | Documented in ADR-0008. The WebSocket and the daemon are JWT-only |

### Probe Execution

Step 7c: SKIPPED. The phase declares no `probe-*.sh`. The isolated e2e script was run directly; see the gates above.

### Human Verification Required

1. **Real SMTP delivery.** Point `OCW_SMTP_URL` at a real SMTP server (Mailpit is enough), request a reset from /login and complete it from the e-mail. Expected: one e-mail with a working single-use link, the user's sessions are signed out, and both `password.reset_*` audit rows exist. Why: every automated run uses the in-memory transport.
2. **Visual pass on the screenshots** in `screenshots/` at 390 and 1440, light and dark. Expected: no clipped or crowded controls. Why: e2e proves behaviour, not looks. The two screenshots the verifier spot-checked were clean.

### Gaps Summary

No gaps block the phase goal. All five success criteria and all nine requirements hold in the code, and the verifier's own runs of `pnpm verify` (535 tests) and the isolated e2e suite (35/35) pass with strict authorization coverage on. Two items are deferred to their scheduled phases: the legacy device token (Phase 8) and re-authorizing live subscriptions (Phase 3). Two short manual checks remain: real SMTP delivery and the visual pass.

---

_Verified: 2026-10-04T21:03:26Z_
_Verifier: Claude (gsd-verifier)_


## Human verification (orchestrator, 2026-10-04)

1. **Real SMTP reset** — PASSED. Mailpit (`smtp://127.0.0.1:1025`) on the isolated stack: `POST /api/v1/password-reset/request` → email "Reset your password" from the configured sender with a `/reset-password` link → reset 200 → old password 401, new password 200 → token reuse 400. Mailpit container and image removed afterwards.
2. **Visual review** — PASSED. Reviewed members-list (1440 light), org-tree (1440 dark) and account-security (390 light) plus the executors' own reviews (92 screenshots); layouts coherent, no clipping or overflow.
