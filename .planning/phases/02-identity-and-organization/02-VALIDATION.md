---
phase: "02"
slug: "identity-and-organization"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-04"
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 02-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.2 (root projects `unit`, `integration` — testcontainers PostgreSQL 18 + Redis 8); Playwright 1.63.0 (`desktop` 1440×900, `mobile` 390×844, after `setup`); fast-check (property tests, installed in 02-01) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <path>` / `pnpm exec vitest run --project integration <path>` |
| **Full suite command** | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test` |
| **E2E command** | `pnpm e2e` (or `pnpm e2e <spec-name>`) on a stack prepared with the E2E protocol below |
| **Estimated runtime** | unit ≈ 20 s; one integration file ≈ 30–60 s; `pnpm verify` ≈ 6–10 min; `pnpm e2e` ≈ 8–12 min |

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` commands (unit project for the touched package + the one integration file of the touched module), then `pnpm verify` (D-10).
- **After every plan:** `pnpm verify`, `pnpm --filter @ocw/local-runtime test`, `pnpm --filter @ocw/desktop test`, and the E2E protocol (`pnpm e2e`) when the plan touches API behaviour or web.
- **After every wave:** full suite + `pnpm e2e`.
- **Before `/gsd-verify-work 2`:** full suite and `pnpm e2e` green; strict authz coverage on; no legacy marker left (02-15).
- **Max feedback latency:** ≈ 60 s per targeted command.

---

## E2E protocol (fresh worktree stack — referenced by every plan)

The `setup` project redeems the setup token, so e2e needs a fresh database. Run from the worktree root:

1. **Backup first (never skip).** If this worktree's postgres is running and has data, dump it outside the repo:
   `mkdir -p "$HOME/.ocw-backups" && docker compose ps --status running -q postgres | grep -q . && docker compose exec -T postgres pg_dump -U postgres -d ocw -Fc > "$HOME/.ocw-backups/$(basename "$PWD")-$(date +%Y%m%d%H%M%S).dump"` — check the file is non-empty. The dump contains password hashes: never commit it.
2. **Fresh stack (this worktree's compose project only):** `docker compose down -v && docker compose up -d --wait postgres redis && pnpm db:migrate`.
3. **API and web as CI does** (stop the API/web processes this run started earlier first; record their PIDs):
   `(cd apps/api && OCW_MODEL_PROVIDER=mock nohup node --env-file-if-exists=../../.env --import tsx src/main.ts > /tmp/ocw-02-api.log 2>&1 & echo $! > /tmp/ocw-02-api.pid)`
   `(cd apps/web && pnpm build && nohup node --env-file-if-exists=../../.env ./node_modules/next/dist/bin/next start -p 3000 > /tmp/ocw-02-web.log 2>&1 & echo $! > /tmp/ocw-02-web.pid)`
   `for i in $(seq 1 60); do curl -sf localhost:4000/health && curl -sf -o /dev/null localhost:3000/login && break; sleep 2; done`
4. **Run:** `pnpm exec playwright install chromium` (once), then `pnpm e2e` (or `pnpm e2e <spec>`); screenshots for UI plans: prefix with `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/02-identity-and-organization/screenshots`.
5. Re-running specs on the same stack is fine (`setup` skips when the stack is already set up); specs create unique users and names per project.
6. On failure: `tail -n 200 /tmp/ocw-02-api.log /tmp/ocw-02-web.log` and the Playwright report in `e2e/playwright-report`.

CI (`.github/workflows/ci.yml`) runs the same suite on every PR; the local run is still required by D-10.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | ORG-02 | T-02-01-01/02/03/05 | owner/admin→admin, member→developer only; CHECK rejects legacy roles; invitations not via plugin | integration | `pnpm exec vitest run --project integration packages/db/src/role-migration.int.test.ts apps/api/src/identity.int.test.ts` | ❌ W0 (role-migration) | ⬜ pending |
| 02-01-02 | 01 | 1 | ORG-01, ORG-06, AUTH-05, AUTH-06 | T-02-01-04/06, T-02-01-SC | new tables tenant-isolated | integration | `pnpm exec vitest run --project integration packages/db/src/rls-isolation.int.test.ts` | ✅ extend | ⬜ pending |
| 02-01-03 | 01 | 1 | ORG-03 | — | vocabulary + strict claim schemas | unit | `pnpm exec vitest run --project unit packages/contracts/src/permissions.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | ORG-03, ORG-05 | T-02-02-04/05 | archive decided by resolver; denial audited after rollback; private → 404 | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` | ✅ extend | ⬜ pending |
| 02-02-02 | 02 | 2 | ORG-03 | T-02-02-01/02/03/07 | deny precedence, non-delegable allows, agent ∩ human, surfaces | unit (fast-check) + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/permissions/resolve.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/organization/permissions/facts.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 2 | ORG-03 | T-02-02-06 | undecided 2xx recorded; legacy checks fail the guard | unit | `pnpm exec vitest run --project unit apps/api/src/authz.test.ts apps/api/src/modules/organization/permissions/guard.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | AUTH-06, AUTH-05 | T-02-03-01/02/03/04 | minimal claims, JWKS verify, deactivated cannot sign in | unit + integration | `pnpm exec vitest run --project unit apps/api/src/modules/identity/client-kind.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/identity/tokens.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | AUTH-05, ORG-05 | T-02-03-06/07/08 | audit rows carry session/client; revocation flagged ≥ JWT life; store never returns tokens | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/tokens.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-03 | 03 | 2 | ORG-01, ORG-02, ORG-06, AUTH-04 | — | https-only avatars, non-delegable allows rejected | unit | `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts` | ✅ extend | ⬜ pending |
| 02-04-01 | 04 | 3 | ORG-03 | T-02-04-01 | private channels hidden in list/detail/topic | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` | ✅ extend | ⬜ pending |
| 02-04-02 | 04 | 3 | ORG-03, AUTH-05 | T-02-04-02/03/04/06 | mutations + bot replies via resolver; desktop client kind on messages | integration | `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts apps/api/src/modules/agent-channel/agent-channel.int.test.ts` | ✅ extend | ⬜ pending |
| 02-05-01 | 05 | 3 | ORG-03 | T-02-05-01 | approvals: creator/device owner/admin; Tool-layer deny | integration | `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-05-02 | 05 | 3 | ORG-03, AUTH-05 | T-02-05-02/03/04/06 | device.use via owner/shared only; standard has no Work Zone | integration | `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-06-01 | 06 | 3 | ORG-01 | T-02-06-01 | units CRUD + move, audited | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-02 | 06 | 3 | ORG-01, ORG-02 | T-02-06-02/03 | no cycles under concurrency; leads scoped to subtree | unit (fast-check) + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/units.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/organization/units.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-06-03 | 06 | 3 | ORG-03 | T-02-06-04/05/06 | unit-scoped deny enforced end to end; org/user topics decided | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/rules.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-01 | 07 | 3 | ORG-02 | T-02-07-03/06 | role change effective; last admin protected | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/members.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-02 | 07 | 3 | ORG-06, ORG-05 | T-02-07-04/05 | deactivation ends sessions/sockets; profiles readable | integration | `pnpm exec vitest run --project integration apps/api/src/modules/organization/members.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-07-03 | 07 | 3 | ORG-02, ORG-03 | T-02-07-01/02 | lead invite ceiling; lead revokes own only | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/invitations.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-01 | 08 | 3 | AUTH-06 | T-02-08-04/05 | WS JWT before upgrade; cookie-only refused; replay exactly once | integration + unit | `pnpm exec vitest run --project integration apps/api/src/identity.int.test.ts` · `pnpm exec vitest run --project unit packages/realtime-client/src/client.test.ts` | ✅ extend | ⬜ pending |
| 02-08-02 | 08 | 3 | AUTH-06 | T-02-08-01/02/07 | Bearer on REST; tampered/expired/wrong-aud/revoked/deactivated → 401 | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/jwt.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-08-03 | 08 | 3 | AUTH-06, AUTH-05 | T-02-08-03 | revocation closes sockets 4401 < 1 s; client refreshes once | integration + unit | same as 02-08-01 | ✅ extend | ⬜ pending |
| 02-09-01 | 09 | 3 | AUTH-05, ORG-05 | T-02-09-01/02/08 | own sessions only, no tokens; sign-in failure and sign-out audited | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/sessions.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-02 | 09 | 3 | AUTH-04 | T-02-09-03/04/05/06 | single-use reset; no enumeration; sessions revoked | unit + integration | `pnpm exec vitest run --project unit apps/api/src/lib/mailer.test.ts` · `pnpm exec vitest run --project integration apps/api/src/modules/identity/password.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-09-03 | 09 | 3 | ORG-06 | T-02-09-07 | https/emoji avatars only; profile propagates | integration | `pnpm exec vitest run --project integration apps/api/src/modules/identity/profile.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-10-01 | 10 | 4 | ORG-03 | T-02-10-01 | providers/bots admin-only; explicit deny beats admin role | integration | `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/agent-channel.int.test.ts` | ✅ extend | ⬜ pending |
| 02-10-02 | 10 | 4 | ORG-03 | T-02-10-02/03/04 | cell/agent principals; agent ∩ human through the plugin route | integration | `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/agent-channel.int.test.ts apps/api/src/modules/agent-channel/provider-auth.int.test.ts` | ✅ extend | ⬜ pending |
| 02-11-01 | 11 | 4 | AUTH-06 | T-02-11-04/05 | daemon exchanges token; Device Link verifies device JWT | unit (local-runtime) + integration | `pnpm --filter @ocw/local-runtime test` · `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | ✅ extend | ⬜ pending |
| 02-11-02 | 11 | 4 | AUTH-06 | T-02-11-01/02/03 | legacy flag on/off; revoked device and user JWT refused | integration | `pnpm exec vitest run --project integration apps/api/src/device-link-auth.int.test.ts` | ❌ W0 | ⬜ pending |
| 02-12-01 | 12 | 4 | ORG-04, ORG-02 | T-02-12-01 | role change via UI; lead invite ceiling in UI | e2e | `pnpm e2e admin-members` | ❌ W0 | ⬜ pending |
| 02-12-02 | 12 | 4 | ORG-04, ORG-06 | T-02-12-02/03 | reset link shown once; profile sheet | e2e | `pnpm e2e admin-members chat` | ❌ W0 | ⬜ pending |
| 02-12-03 | 12 | 4 | ORG-04 | — | visual review 390/1440 light/dark | e2e + manual | `pnpm e2e admin-members` | ❌ W0 | ⬜ pending |
| 02-13-01 | 13 | 4 | ORG-04, ORG-01 | T-02-13-01 | build hierarchy from empty state | e2e | `pnpm e2e admin-org` | ❌ W0 | ⬜ pending |
| 02-13-02 | 13 | 4 | ORG-04, ORG-01, ORG-02 | T-02-13-02/03 | move/delete/staff; rules read-only | e2e | `pnpm e2e admin-org` | ❌ W0 | ⬜ pending |
| 02-13-03 | 13 | 4 | ORG-04 | — | visual review 390/1440 light/dark | e2e + manual | `pnpm e2e admin-org` | ❌ W0 | ⬜ pending |
| 02-14-01 | 14 | 4 | ORG-06 | T-02-14-03 | profile edit propagates | e2e | `pnpm e2e account` | ❌ W0 | ⬜ pending |
| 02-14-02 | 14 | 4 | AUTH-04, AUTH-05 | T-02-14-01/02 | sessions revoke across contexts; reset/forgot flows | e2e | `pnpm e2e account smoke` | ❌ W0 | ⬜ pending |
| 02-14-03 | 14 | 4 | ORG-06, AUTH-04 | — | visual review 390/1440 light/dark | e2e + manual | `pnpm e2e account` | ❌ W0 | ⬜ pending |
| 02-15-01 | 15 | 5 | ORG-03 | T-02-15-01/02/03 | strict coverage; no role in AuthContext; clean guard | unit + integration | `pnpm exec vitest run --project unit apps/api/src/modules/organization/permissions/guard.test.ts apps/api/src/authz.test.ts` · `pnpm verify` | ❌ W0 (authz.int) | ⬜ pending |
| 02-15-02 | 15 | 5 | all | — | phase gate | full + e2e | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test` · `pnpm e2e` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠ flaky*

### Requirement → plan coverage

| Req | Behaviour | Plans (API → UI) | Proof |
|-----|-----------|------------------|-------|
| AUTH-04 | Reset by e-mail (SMTP) or admin link; change password (D-04) | 02-09 → 02-12 (admin link UI), 02-14 | password.int.test.ts, mailer.test.ts, account.spec.ts, admin-members.spec.ts |
| AUTH-05 | Sessions list/revoke with client identifier; identifier on messages and audit | 02-01 (columns), 02-03, 02-04/05/10 (client kind), 02-08 (sockets), 02-09 → 02-14 | tokens.int.test.ts, sessions.int.test.ts, chat.int.test.ts, account.spec.ts |
| AUTH-06 | JWT/JWKS for API, WebSocket, daemon | 02-01 (jwks), 02-03 (issue), 02-08 (REST + WS), 02-11 (daemon), 02-15 (ADR-0008) | tokens/jwt/identity/device-link-auth int tests, client.test.ts, daemon.test.ts, e2e chat + work-zone |
| ORG-01 | Hierarchy CRUD incl. moves | 02-01 (schema), 02-06 → 02-13 | units.test.ts, units.int.test.ts, admin-org.spec.ts |
| ORG-02 | Four roles; unit memberships member/lead | 02-01 (migration), 02-06 (memberships), 02-07 (roles, invitations) → 02-12, 02-13 | role-migration, members, invitations, units int tests; admin specs |
| ORG-03 | One resolver, explicit-deny precedence, every route | 02-01 (vocabulary), 02-02, 02-04, 02-05, 02-06, 02-07, 02-10, 02-11, 02-15 | resolve.test.ts (matrix + properties), guard.test.ts, authz.int.test.ts (strict), module int tests |
| ORG-04 | Admin console CRUD pages | 02-06/02-07 (API) → 02-12, 02-13 | admin-members.spec.ts, admin-org.spec.ts + reviewed screenshots |
| ORG-05 | Same-transaction audit incl. failed sign-in, hierarchy, roles, memberships, sessions, denials | 02-02 (denials), 02-03 (session/client on rows), 02-06, 02-07, 02-09 | audit assertions in every int test listed above |
| ORG-06 | Edit own profile; see others' profiles | 02-01 (columns), 02-07 (member profile), 02-09 (edit) → 02-12 (sheet), 02-14 (page) | profile.int.test.ts, members.int.test.ts, account.spec.ts, admin-members.spec.ts |

---

## Wave 0 Requirements

Created inside the plans that first need them (each plan's first task writes the failing test before the code):

- [ ] `packages/db/src/role-migration.int.test.ts` — 02-01
- [ ] `packages/contracts/src/permissions.test.ts` — 02-01
- [ ] `fast-check`, `jose`, `nodemailer`, `@types/nodemailer` pinned — 02-01 (D-08)
- [ ] `apps/api/src/modules/organization/permissions/{resolve.test.ts,facts.int.test.ts,guard.test.ts}`, `apps/api/src/authz.test.ts` — 02-02
- [ ] `apps/api/src/modules/identity/{client-kind.test.ts,tokens.int.test.ts}` — 02-03
- [ ] `apps/api/src/modules/organization/{units.test.ts,units.int.test.ts,rules.int.test.ts,members.int.test.ts}` — 02-06, 02-07
- [ ] `apps/api/src/modules/identity/{invitations,jwt,sessions,password,profile}.int.test.ts`, `apps/api/src/lib/mailer.test.ts` — 02-07, 02-08, 02-09
- [ ] `TestClient.token()` + header options in `apps/api/src/testing.ts` — 02-08
- [ ] `apps/api/src/device-link-auth.int.test.ts` — 02-11
- [ ] `e2e/tests/{admin-members,admin-org,account}.spec.ts` — 02-12, 02-13, 02-14
- [ ] `apps/api/src/authz.int.test.ts` — 02-15

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual quality of the admin console and account pages at 390/1440, light/dark | ORG-04, ORG-06, AUTH-04, AUTH-05 | Visual polish cannot be grepped (D-09) | Open `screenshots/members-*.png`, `org-*.png`, `account-*.png`; harvested at end of phase from each UI plan's `<human-check>` |
| Installed desktop app built before Phase 2 keeps pairing and running sessions | AUTH-06 (D-03) | Needs the owner's existing ad-hoc signed .app | With `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` unset, start the old app; it connects; one `device.legacy_token_used` audit row per hour |
| Real SMTP delivery of a reset e-mail | AUTH-04 | Needs a real SMTP account (optional feature) | Set `OCW_SMTP_URL`/`OCW_MAIL_FROM`, use "Forgot password?" on /login, follow the link |

---

## Artifacts this phase produces

- **Contracts:** `packages/contracts/src/permissions.ts` (+ test); DTOs for units, memberships, rules, member detail, sessions, password reset, profile (`organization.ts`, `identity.ts`); `viewerCan` on ChannelSummary/Device/WorkSessionDetail/Invitation; new EventTypes.
- **Database:** migrations `*_role_values` (data), `*_role_check`, `*_identity_org` (org_units, unit_memberships, permission_rules, org_members status/deactivation, session client columns, auth.jwks); `role-migration.int.test.ts`; RLS enumerator seeds.
- **API — authorization:** `organization/permissions/{resolve,policy,facts,service,errors}.ts`, `apps/api/src/authz.ts`, guard and coverage tests; `organization/{members,units,rules}.ts`; GET `/api/v1/me/permissions`.
- **API — identity:** `identity/{authenticate,client-kind,session-store,invitations,jwt,sessions,password,profile}.ts`, `lib/mailer.ts`, revocation fan-out in `realtime/service.ts`, JWT WebSocket gateway, `device/token.ts`, `OCW_SMTP_URL`, `OCW_MAIL_FROM`, `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`.
- **Clients:** `packages/realtime-client` getToken; `apps/web/lib/{permissions,auth-token,member-queries,org-queries,account-queries}.ts`; Settings › Members (extended), › Organization, › Profile, › Security; `/reset-password`; daemon device-JWT exchange.
- **Tests/E2E:** `admin-members.spec.ts`, `admin-org.spec.ts`, `account.spec.ts`; screenshots in `.planning/phases/02-identity-and-organization/screenshots/`.
- **Docs:** ADR-0007 (roles, hierarchy, resolver), ADR-0008 (JWT transport), `docs/DEMO.md`, `scripts/demo-seed.mjs` hierarchy and roles.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60 s per targeted command
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
