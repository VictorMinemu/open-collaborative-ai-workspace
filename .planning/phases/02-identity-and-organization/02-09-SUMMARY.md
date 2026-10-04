---
phase: 02-identity-and-organization
plan: 09
subsystem: identity (account API), audit, config
status: complete
tags: [sessions, password-reset, smtp, profile, audit, authz, revocation]
requires: ["02-02", "02-03"]
provides:
  - "GET /api/v1/me/sessions, DELETE /api/v1/me/sessions/:id, POST /api/v1/me/sessions/revoke-others (explicit fields, never a token)"
  - "user.sign_in_failed and user.signed_out audit (own transaction); session.revoked in the delete transaction"
  - "config.authz on every identity route (better-auth allowlist, setup, me, sessions, password, profile); GET /api/v1/me decided by org.read"
  - "GET /api/v1/auth/capabilities, POST /api/v1/password-reset/request, POST /api/v1/password-reset, POST /api/v1/members/:userId/password-reset-link, POST /api/v1/me/password"
  - "lib/mailer.ts: Mailer port, nodemailer SMTP adapter, memory: outbox for tests (createMailer, memoryOutbox, clearMemoryOutbox)"
  - "OCW_SMTP_URL (secret, _FILE form) and OCW_MAIL_FROM in env.ts, .env.example and compose.yaml"
  - "GET/PATCH /api/v1/me/profile with member.updated on org:<id> after commit"
affects: [02-08, 02-12, 02-13, 02-15]
tech-stack:
  added: []
  patterns:
    - "Revocations of some sessions publish sessionIds only; userId is reserved for 'every session of the user' (password reset)"
    - "Admin-issued reset link = better-auth verification row reset-password:<token> created through internalAdapter inside runWithTransaction with the audit row"
    - "Profile writes through the better-auth adapter (user + orgMember + audit in one tx), realtime event in a follow-up withTenant after commit"
key-files:
  created:
    - apps/api/src/modules/identity/sessions.ts
    - apps/api/src/modules/identity/sessions.int.test.ts
    - apps/api/src/modules/identity/password.ts
    - apps/api/src/modules/identity/password.int.test.ts
    - apps/api/src/modules/identity/profile.ts
    - apps/api/src/modules/identity/profile.int.test.ts
    - apps/api/src/lib/mailer.ts
    - apps/api/src/lib/mailer.test.ts
  modified:
    - apps/api/src/modules/identity/routes.ts
    - apps/api/src/modules/identity/index.ts
    - apps/api/src/modules/identity/auth.ts
    - apps/api/src/config/env.ts
    - .env.example
    - compose.yaml
decisions:
  - "A9 holds: auth.api.resetPassword joins an outer runWithTransaction (token consumption, password update and session deletion all roll back with it)"
  - "Single-session revocations (delete one, revoke-others, sign-out, change password) publish sessionIds without userId, so 02-08's gateway does not close the caller's own sockets"
  - "Issuing a new admin reset link deletes the user's earlier reset-password rows (newest link wins)"
  - "Reset request answers { ok: true } in every case, including SMTP failures and deactivated members (no e-mail sent to them)"
  - "PATCH /me/profile only writes the fields whose value changes; an unchanged PATCH writes no audit row and no event"
metrics:
  duration: "~45 min"
  completed: "2026-10-04"
  tasks: 3
  files: 14
actuals:
  tokens: 18600
  tasks: 3
  commits: 5
---

# Phase 2 Plan 09: Account API (sessions, password reset and change, profile, sign-in audit) Summary

Users now list their sessions with real client labels ("Chrome on macOS", "Desktop app on macOS"), revoke one or all others, and the revoked sessions stop working at once. Password reset works by e-mail when SMTP is configured and by a single-use 24-hour admin link otherwise; completing a reset ends every session. Signed-in users change their password and sign out other devices. Profile edits (name, emoji/https avatar, status) show up in chat and the member directory and emit `member.updated` live. Failed sign-ins, sign-outs, revocations and every password step are audited, and every identity route declares `config.authz`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `a1e5a6a` | feat(02-09): session list and revocation, sign-in failure and sign-out audit, identity route authz |
| 2 | `53365db` | feat(02-09): password reset by e-mail or admin-issued link, and change password |
| 3 | `16ebf1d` | feat(02-09): profile editing with live member.updated propagation |
| 1 (orchestrator note) | `f268451` | test(02-09): assert the revocation events published on sign-out and session revoke |

## Routes added

| Route | authz | Decision | Audit |
|-------|-------|----------|-------|
| GET /api/v1/me/sessions | user | account.manage (self) | – |
| DELETE /api/v1/me/sessions/:id | user | account.manage (self); 404 session_not_found for others' ids; 400 current_session | session.revoked { revokedSessionId, scope: "one" } (same tx) |
| POST /api/v1/me/sessions/revoke-others | user | account.manage (self) | session.revoked { revokedSessionIds, scope: "others" } (same tx) |
| POST /api/auth/sign-in/email (failure) | public | – | user.sign_in_failed, result denied, actor system, { email lower-cased ≤ 320, ip, reason } (own tx) |
| POST /api/auth/sign-out | public | – | user.signed_out (own tx), sid flagged revoked |
| GET /api/v1/auth/capabilities | public | – | – |
| POST /api/v1/password-reset/request (5/min) | public | – | password.reset_requested (own tx, members only) |
| POST /api/v1/password-reset (10/min) | public | token | password.reset_completed { revokedSessions } (same tx as the reset) |
| POST /api/v1/members/:userId/password-reset-link | user | member.manage; 400 use_change_password; 404 member_not_found; 409 member_deactivated | password.reset_link_issued { targetUserId, expiresAt } (same tx), never the token |
| POST /api/v1/me/password (10/min) | user | account.manage (self); 400 invalid_password | password.changed { revokedOtherSessions } (same tx) |
| GET/PATCH /api/v1/me/profile | user | account.manage (self) | user.profile_updated { fields } (same tx) |

## Observed facts (requested by the plan)

- **Assumption A9: holds.** The test `SPIKE A9` in `password.int.test.ts` calls `auth.api.resetPassword` inside `runWithTransaction(ctx.adapter, …)` and then throws. Afterwards the `reset-password:<token>` verification row still exists, the user's session is still there, the old password still signs in and the new one does not. The reason is that `auth.api.*` calls do not wrap themselves in `runWithAdapter` (only `auth.handler` does, `auth/base.mjs:51`), and `runWithTransaction` reuses an active transaction (`@better-auth/core/context/transaction.mjs`). `consumeVerificationValue` nests its own `runWithTransaction`, which joins ours.
- **nodemailer in use: 10.0.11** (pinned by 02-01; `apps/api/node_modules/nodemailer/package.json`).
- **better-auth 1.7.6:** `requestPasswordReset` is only callable when `sendResetPassword` is configured, so it is configured only when `createMailer(env)` returns a mailer; without SMTP the request route answers `{ ok: true }` without calling better-auth.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/identity/sessions.int.test.ts apps/api/src/identity.int.test.ts` | 16 passed (RED first: 8 of 9 new tests failed before the implementation) |
| `pnpm exec vitest run --project unit apps/api/src/lib/mailer.test.ts` | 5 passed (RED first: module missing) |
| `pnpm exec vitest run --project integration apps/api/src/modules/identity/password.int.test.ts` | 9 passed, two stacks (no SMTP / `OCW_SMTP_URL=memory:`) (RED first: 9 failed) |
| `pnpm exec vitest run --project integration apps/api/src/modules/identity/profile.int.test.ts` | 6 passed (RED first: 6 failed with 404) |
| `pnpm verify` after each task | exit 0 each time; final run (after the test commit): biome clean (4 pre-existing warnings in apps/local-runtime), turbo typecheck 8/8, **46 files / 423 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` | **11 passed (36.7 s)**, exit 0 (after waiting for the shared lock): setup, then bots, chat, codex-subscription, smoke (sign-in, sign-out) and work-zone at desktop 1440 and mobile 390. Afterwards the lock and :4290 passed to another executor's run (pid 81482, API started after ours finished) |

Acceptance greps: `sessions.ts` contains `"session.revoked"`, `publishRevocation`, `"account.manage"` and 0 `token`. `routes.ts` contains `"user.sign_in_failed"`, `"user.signed_out"`, `authz: "public"`, and `grep -c 'clientKind: "web"'` = 0. `password.ts` contains `"password.reset_link_issued"`, `"password.reset_completed"`, `"password.changed"`, `"invalid_token"`, `no-store`. `env.ts` has `OCW_SMTP_URL` in `SECRET_VARS` and `OCW_MAIL_FROM`. `auth.ts` has `revokeSessionsOnPasswordReset: true` and `sendResetPassword`. `profile.ts` has `"user.profile_updated"` and `EventTypes.memberUpdated`. `index.ts` registers all three route groups. `profile.int.test.ts` has `"member.updated"` and `realtime.listen(`.

### Demo stack (hard rule)

| Check | Before | After |
|-------|--------|-------|
| `curl localhost:4000/health` | 200 | 200 |
| `curl localhost:3000/login` | 200 | 200 |
| `ocw-demo-openclaw` | running, started 2026-10-04T15:54:27Z | running, started 2026-10-04T15:54:27Z |

No `docker compose down/rm/stop/restart`, no `db:migrate` against the default `.env`, no `demo:*`, no bind on :4000/:3000. `compose.yaml` was edited (two variables), but no compose command was run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Revocations of some sessions no longer carry `userId`**
- **Found during:** Task 1
- **Issue:** The plan publishes `{ sessionIds, userId }` for revoke-one, revoke-others and sign-out. 02-08's gateway (same wave) closes sockets that match `sessionIds` **or** `userId`, so revoking a laptop session would also close the caller's own socket and every other device.
- **Fix:** Session revoke, revoke-others, sign-out and change password publish `sessionIds` only. Password reset (every session ends) publishes `sessionIds` and `userId`.
- **Commits:** a1e5a6a, 53365db

**2. [Rule 2 - Correctness] compose.yaml passes OCW_SMTP_URL / OCW_MAIL_FROM to the API**
- The `api` service enumerates its environment, so `docker compose up` users could never enable reset e-mails. Two lines were added (empty defaults). `OCW_MAIL_FROM` treats an empty value as the default, and an empty `OCW_SMTP_URL` means "no SMTP" (readEnvOrFile). No compose command was run.
- **Commit:** 53365db

**3. [Rule 2 - Security] Reset hardening inside the plan's intent**
- A new admin link deletes the user's earlier `reset-password:*` rows (newest link wins; tested).
- A failing SMTP server is logged (error code only, never the body) and still answers `{ ok: true }`, so it cannot reveal which addresses exist.
- Deactivated members get no reset e-mail.
- `POST /api/v1/me/password` is rate limited to 10/min.
- **Commit:** 53365db

**4. [Rule 2 - Correctness] Unchanged profile fields are not written**
- PATCH compares with the stored profile. Only changed fields are written, audited (`fields`) and sent in `member.updated.changed`. A no-op PATCH writes no audit row and no event (tested). An empty `statusText` clears the status like `null`.
- **Commit:** 16ebf1d

**5. `.env.example` could not be read with `cat` (sandbox deny rule)**
- It was read with the Read tool and edited with Edit, as the plan anticipated.

### Not verified here (by design of the wave)

- **Bearer JWT on `POST /api/v1/me/password`:** Bearer authentication in `authenticate.ts` is 02-08's work (same wave, sibling worktree), so this branch cannot exercise it. The route depends only on `req.auth` (it verifies the password against the credential account through `ctx.password.verify` and updates it through `internalAdapter.updatePassword`, never through better-auth's cookie-only `change-password`), so it accepts Bearer callers as soon as 02-08 lands. The post-merge check is the 02-08 "every user REST route accepts Bearer" suite, or one extra assertion in `password.int.test.ts`.

### Orchestrator note from 02-08 (sign-out revocation)

- Sign-out already published `{ sessionIds: [sid], reason: "signed_out" }` after the audit (Task 1). Every other revocation path this plan owns publishes too: session revoke, revoke-others, change password and reset completion.
- As requested, `sessions.int.test.ts` now subscribes with `realtime.onRevocation` and asserts the exact event published on sign-out (`{ sessionIds: [sid], reason: "signed_out" }`) and on revoking one session (`{ sessionIds: [sid], reason: "session_revoked" }`). It also checks the Redis revoked-sid flag. `apps/api/src/workzone.int.test.ts` was not touched.

### Other notes

- `user.sign_in_failed` rows have `actor_kind = system`. `actor_id` equals the targeted user's id because `toAuditRow` falls back to `userId` (the audit module is not in this plan's files).
- Tests use local cookie-jar helpers (testing.ts belongs to 02-08). `profile.int.test.ts` only imports the existing `TestClient`.
- TDD: every task ran RED first (counts above). Tests were committed together with the implementation in one `feat` commit per task, as in 02-01 to 02-03, so every commit passes `pnpm verify`.

## Known Stubs

None. Avatar upload is intentionally out of scope (object storage arrives in Phase 4); the field accepts an emoji or an https URL today.

## Threat Flags

None. All new surface is covered by T-02-09-01 … T-02-09-09. The compose.yaml lines only pass through the two new variables.

## Self-Check: PASSED
