---
phase: 02-identity-and-organization
plan: 03
subsystem: identity, realtime, audit, db, contracts
status: complete
tags: [jwt, jwks, sessions, client-kind, audit, revocation, contracts]
requires: ["02-01"]
provides:
  - "better-auth jwt plugin: GET /api/auth/token (10-minute EdDSA JWT, claims sub/sid/org/ck/iat/exp/iss/aud) and GET /api/auth/jwks"
  - "Sessions tagged with client_kind/client_label and activeOrganizationId at creation; deactivated members cannot sign in"
  - "identity/authenticate.ts (AuthContext.clientKind, deactivated members rejected), identity/client-kind.ts, identity/session-store.ts"
  - "tenant(req) carries sessionId + clientKind; audit.record defaults to them"
  - "RealtimeService.publishRevocation / onRevocation / isSessionRevoked (ocw:auth:revoked, revoked-sid flag 900 s)"
  - "Wave-3 DTOs in packages/contracts (organization.ts, identity.ts)"
affects: [02-04, 02-05, 02-06, 02-07, 02-08, 02-09, 02-10, 02-11, 02-12, 02-13, 02-14, 02-15]
tech-stack:
  added: []
  patterns:
    - "databaseHooks.session.create.before derives client identity from the endpoint context headers"
    - "Audit defaults from the transaction's tenant context (explicit event values, including null, win)"
    - "Session store over getCurrentAdapter so it joins an outer runWithTransaction"
key-files:
  created:
    - apps/api/src/modules/identity/client-kind.ts
    - apps/api/src/modules/identity/client-kind.test.ts
    - apps/api/src/modules/identity/authenticate.ts
    - apps/api/src/modules/identity/session-store.ts
    - apps/api/src/modules/identity/tokens.int.test.ts
  modified:
    - apps/api/src/modules/identity/{auth,routes,service,invitations}.ts
    - apps/api/src/core.ts
    - packages/db/src/tenant.ts
    - apps/api/src/modules/audit/index.ts
    - apps/api/src/modules/realtime/{service,index}.ts
    - packages/contracts/src/{identity,organization,contracts.test}.ts
decisions:
  - "AccessTokenClaims needed no change: the real claim set is exactly {sub, sid, org, ck, iat, exp, iss, aud}"
  - "Explicit null for sessionId/clientKind on an audit event wins over the tenant-context default"
  - "Allow rules reject any pattern that matches a non-delegable permission (for example device.* because it covers device.link)"
  - "EmojiString also requires one pictograph or regional indicator, so digits, # and * alone are not accepted as an emoji"
metrics:
  duration: "~20 min"
  completed: "2026-10-04"
  tasks: 3
  files: 17
actuals:
  tokens: 15600
  tasks: 3
  commits: 4
---

# Phase 2 Plan 03: JWT/JWKS, session client identity, audit context, revocation and wave-3 contracts Summary

A desktop sign-in now creates a session tagged `desktop` / "Desktop app on macOS". `GET /api/auth/token` exchanges the cookie for a 10-minute EdDSA JWT with eight claims, and that JWT verifies against `GET /api/auth/jwks`. Audit rows written during a request inherit its session and client. Deactivated members are blocked at sign-in and on every request. Redis revocation fan-out and a token-free session store are ready for 02-07/08/09, and every wave-3 DTO is published.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `c82a248` | feat(02-03): tag sessions with their client and issue minimal EdDSA access JWTs |
| 2 | `e798bd7` | feat(02-03): carry session and client into audit rows; revocation fan-out and session store |
| 3 | `2405dd0` | feat(02-03): publish the wave-3 contracts for units, rules, members, sessions, passwords and profile |

## Observed facts (requested by the plan)

**JWT claim set** (decoded from a real token in `tokens.int.test.ts`): `aud, ck, exp, iat, iss, org, sid, sub`, with `exp − iat = 600`, header `alg: EdDSA` and `kid` = the JWKS key id. The JWKS holds one key `{kty: OKP, crv: Ed25519, alg: EdDSA}` and no `d`. `AccessTokenClaims` (strict) parses it unchanged, so `permissions.ts` was not modified. No `jti` is added. `iat` comes from better-auth's `getJwtToken`, and `sub` comes from `session.user.id`.

**Hook context shape:** better-auth calls `session.create.before(session, ctx)` with `ctx = tryGetCurrentAuthEndpointContext()`, the endpoint context. Headers are read from two places:
- **HTTP sign-in** (through our allowlist proxy into `auth.handler`): `ctx.request.headers`.
- **Server-side `auth.api.signUpEmail({ headers })`** (setup and invitation acceptance): `ctx.headers`.

The hook reads `ctx.request?.headers ?? ctx.headers`. If neither is present, it falls back to the `userAgent` that `createSession` already copied onto the row. Both paths are covered by tests: an Electron sign-in gives `desktop`, and an Electron invitation acceptance gives `ck: "desktop"` in the first JWT.

**A4 rollback spike:** proven for both paths.
- `identity.sessions.deleteAllForUser(userId)` inside `runWithTransaction`, followed by a thrown error, leaves every session row in place.
- `ctx.internalAdapter.deleteUserSessions(userId)` inside `runWithTransaction` also rolls back. Inside the transaction the count is 0, and afterwards all rows are back.

So 02-07 and 02-09 can delete sessions and write their audit row in one auth-plane transaction.

**Blocked sign-in:** when the hook returns `false`, better-auth answers 401 `FAILED_TO_CREATE_SESSION` and no `auth.session` row is written. It also logs "Failed to create session" at error level.

## What wave 3 can rely on

- `AuthContext.clientKind: ClientKind`. `tenant(req)` returns `{ organizationId, userId, sessionId, clientKind }`, and `TenantCtx` has the optional `sessionId` / `clientKind`.
- `audit.record(tx, e)` falls back to the transaction context. Explicit values win, including an explicit `null`. Callers that still hard-code `clientKind: "web"` (agent, agent-channel, chat message post, work-session routes) keep writing `web` until 02-04, 02-05 and 02-10 delete that literal.
- `IdentityService` exposes:
  - `authDb` (public), `sessions: SessionStore`, `authenticate`, `requireUser` and `requireRole` (legacy, still delegated).
  - `setup(input, hooks = {}, headers?)`.
  - `asRole`, re-exported from `authenticate.ts`.
- `auditVia(adapter, { …, clientKind? })` defaults to `"web"`.
- `SessionStore`: `list`, `delete(userId, sid)` (false when the session belongs to someone else), `deleteAllForUser(userId, { exceptSessionId })` (returns the ids) and `isActive`. `SessionRecord` has exactly `id, userId, clientKind, clientLabel, ipAddress, createdAt, updatedAt, expiresAt`.
- `RealtimeService`:
  - `publishRevocation({ sessionIds?, userId?, reason })`: `SET ocw:auth:revoked-sid:<sid> 1 EX 900` per sid, then `PUBLISH ocw:auth:revoked`.
  - `onRevocation(listener)`: ignores malformed messages and events with neither sessions nor user.
  - `isSessionRevoked(sid)`.
  - `REVOCATION_CHANNEL`, `REVOKED_SID_TTL_SECONDS` and the event types are exported from `modules/realtime`.
- `ACCESS_TOKEN_TTL_SECONDS = 600` is exported from `identity/auth.ts`.
- The allowlist adds `GET /api/auth/token` and `GET /api/auth/jwks`. No `config.authz` was added; 02-09 declares them.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project unit apps/api/src/modules/identity/client-kind.test.ts` | 11 passed (RED first: file missing → failed) |
| `pnpm exec vitest run --project integration apps/api/src/modules/identity/tokens.int.test.ts apps/api/src/identity.int.test.ts` (Task 1) | 10 passed |
| Same plus `apps/api/src/modules/chat/chat.int.test.ts` (Task 2) | 27 passed. The 6 new Task 2 tests failed before the implementation |
| `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts` | 15 passed (9 failed before the implementation) |
| `pnpm verify` after each task | lint clean (4 pre-existing warnings in apps/local-runtime), typecheck 8/8, final run 38 files / 338 tests passed |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` (with `COMPOSE_PROJECT_NAME=t3code-81d72154`, see deviation 3) | **11 passed (36.2 s)**, exit 0: setup, then bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390. Afterwards :4290 was free and the lock was released. The demo was unchanged: `:4000/health` 200, `:3000/login` 200, `ocw-demo-openclaw` still running since 2026-10-04T15:54:27Z, and no `ocw-02-03-*` containers exist |

Acceptance greps:
- `auth.ts` contains `jwks: dbSchema.jwks`, `disableSettingJwtHeader: true`, `expirationTime: "10m"` and `definePayload`.
- `routes.ts` has both new paths and no `list-sessions`.
- `core.ts` has `clientKind: ClientKind`. `tenant.ts` has `sessionId?: string | null` and `clientKind?: string | null`.
- `session-store.ts`: `grep -ci token` = 0.
- `realtime/service.ts` has `ocw:auth:revoked` and `"EX"`. `authenticate.ts` has `deactivatedAt`.
- Every listed contract name exists. `contracts.test.ts` rejects `javascript:`, and `Invitation` contains `inviterId`.

## Deviations from Plan

### Auto-fixed / small additions

**1. [Rule 2 - Correctness] Client kind on auth-plane audit rows**
- These rows now record the real client instead of the hard-coded `"web"`: `user.signed_in` (from the request headers), `setup.redeemed` / `organization.created` / `user.signed_up` / `invitation.accepted` (from the request headers), and `invitation.created` / `invitation.revoked` (from `auth.clientKind`).
- `AuditInput` gained an optional `clientKind`. The tests assert it for setup, accept and invite.
- Commit: e798bd7

**2. [Rule 3 - Blocking] `modules/realtime/index.ts` re-exports the revocation types**
- This file was not in the plan's list. Without the re-export, consumers would have to deep-import `realtime/service`.

**3. [Rule 3 - Environment] The e2e script must target the demo's compose project from this worktree**
- `scripts/e2e-isolated.sh` runs `docker compose ps/exec` in the current directory. From the `ocw-02-03` worktree, the compose project resolves to `ocw-02-03`, which has no running services, so the script would try `docker compose up -d` for a second postgres/redis.
- I exported `COMPOSE_PROJECT_NAME=t3code-81d72154`. The script then found the already-running postgres/redis and touched only `ocw_e2e` and Redis DB 9, as designed.
- Suggestion for later executors in other worktrees: export the same variable. Another option is to make the script honour an `OCW_COMPOSE_PROJECT` setting.

**4. Contract details inside the plan's intent**
- `EmojiString` counts code points (max 16) and needs one pictograph or regional indicator.
- The regex is an alternation, because Biome's `noMisleadingCharacterClass` rejects a ZWJ inside a character class. The Unicode escapes are written as escape sequences, as required.
- `HttpsUrl` is exported. `CreatePermissionRuleRequest` defaults `scopeUnitId`, `subjectId` and `tool` to `null`.

**5. TDD commit granularity**
- Each task's failing tests were run and seen to fail (RED) before the implementation. They were committed together with the implementation (`feat(02-03)`), so every commit passes `pnpm verify`. The same choice was made in 02-01.

## Known Stubs

None. No route consumes the wave-3 DTOs yet; that is by design, and they are consumed in wave 3.

## Threat Flags

None. `/api/auth/token` and `/api/auth/jwks` are T-02-03-01/02/03. The session hook and authenticate are T-02-03-04/05. The session store is T-02-03-06, revocation is T-02-03-07 and audit defaults are T-02-03-08.

## Self-Check: PASSED
