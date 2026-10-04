---
phase: 02-identity-and-organization
plan: 08
subsystem: identity, realtime, realtime-client, web
status: complete
tags: [jwt, jwks, jose, websocket, subprotocol, bearer, revocation, device-token]
requires: ["02-02", "02-03"]
provides:
  - "identity/jwt.ts createTokenService: jose verifier over an in-process JWKS cache (one refetch per unknown kid, 30 s cooldown), signDeviceToken / verifyDeviceToken"
  - "IdentityService.verifyAccessToken, signDeviceAccessToken, verifyDeviceAccessToken, isSessionActive, isMemberActive (contract for 02-11)"
  - "Authorization: Bearer <access JWT> on every user REST route (cookie still accepted; a failed Bearer JWT never falls back to the cookie)"
  - "/ws authenticated only by the ocw.auth.<jwt> Sec-WebSocket-Protocol entry, verified before the upgrade; server echoes ocw.v1"
  - "Revocation fan-out closes open sockets with 4401 (by sid or userId); recheck = session active + member active, injectable interval"
  - "packages/realtime-client getToken option (subprotocol transport, one forced refresh on 4401, stop on 401)"
  - "apps/web/lib/auth-token.ts single-flight access-token source (refresh 60 s before expiry)"
  - "TestClient.token() and TestClient.request(method, path, body?, { headers, noCookies })"
affects: [02-09, 02-11, 02-14, 02-15]
tech-stack:
  added: []
  patterns:
    - "JWT in a WebSocket subprotocol entry, never in the URL; handleProtocols selects only the app protocol"
    - "Revocation subscription awaited inside onRequest, so no revocation can slip between accept and registration"
    - "Narrow structural deps (RevocationCheck, TokenAuth) instead of whole services, so tests can count calls"
key-files:
  created:
    - apps/api/src/modules/identity/jwt.ts
    - apps/api/src/modules/identity/jwt.int.test.ts
    - apps/web/lib/auth-token.ts
  modified:
    - apps/api/src/modules/identity/{authenticate,service}.ts
    - apps/api/src/modules/realtime/{gateway,index}.ts
    - apps/api/src/app.ts
    - apps/api/src/testing.ts
    - apps/api/src/identity.int.test.ts
    - apps/api/src/workzone.int.test.ts
    - packages/realtime-client/src/{client,client.test}.ts
    - apps/web/lib/realtime.tsx
decisions:
  - "A2 holds: @fastify/websocket 11.3.1 spreads `options` into the ws server, so handleProtocols is forwarded unchanged; no query-string fallback exists"
  - "The JWKS refetch cooldown counts from the last unknown-kid refetch (not the initial load), so the first rotation always refetches"
  - "verifyAccessToken reads name/email from auth.user (same as the cookie path) and role/deactivation from app.org_members"
  - "The one-shot 4401 refresh is re-armed only by a `subscribed` frame, not by `open`, so a server that keeps refusing stops the client"
metrics:
  duration: "~35 min"
  completed: "2026-10-04"
  tasks: 3
  files: 14
actuals:
  tokens: 10900
  tasks: 3
  commits: 4
---

# Phase 2 Plan 08: JWT verification on REST and the browser WebSocket, instant socket revocation Summary

The browser WebSocket now opens only with a 10-minute EdDSA access JWT offered as `ocw.auth.<jwt>` in `Sec-WebSocket-Protocol`. It is verified with `jose` against a cached JWKS before the upgrade, and the server echoes `ocw.v1` and never the token. Every user REST route also accepts `Authorization: Bearer <jwt>`. Revoked or deactivated sessions are rejected immediately on REST and their open sockets close with 4401 within a second. Device tokens are a separate credential class ready for 02-11.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `271b615` | feat(02-08): browser WebSocket authenticates with a short-lived JWT subprotocol verified against the JWKS |
| 2 | `bf6d51d` | feat(02-08): Bearer access JWT on every user REST route; device tokens as a separate credential class |
| 3 | `3ed5730` | feat(02-08): revocation closes open sockets with 4401 at once; realtime client refreshes its token once on 4401 |

## Observed facts (requested by the plan)

**Assumption A2 (@fastify/websocket forwards `handleProtocols`): confirmed.** `@fastify/websocket` 11.3.1 builds its server with `Object.assign({ noServer: true }, opts.options)`, so `handleProtocols` reaches `ws` as-is. In `identity.int.test.ts` the `ws` client offered `["ocw.v1", "ocw.auth.<jwt>"]` and got `ws.protocol === "ocw.v1"`. It never reported "Server sent no subprotocol". No forwarding fix and no query-string fallback were needed.

**Chrome behaviour (A1):** in the isolated e2e (Playwright Chromium at 1440 and 390), the web app opened `/ws` with `["ocw.v1", "ocw.auth.<jwt>"]` and the server echoed `ocw.v1`. Live messages, typing, threads, bot replies and Work Zone streaming all worked. The API log of that run shows:
- 47 `/ws` upgrade requests, none answered 401 or 403.
- 41 `GET /api/auth/token` calls (fewer than the upgrades because cached tokens were reused).
- Zero occurrences of `eyJ`, so no token reached the logs.

The "Chrome fails when nothing is echoed" half of A1 was not exercised on purpose. The server always echoes, so it stays an assumption with no impact.

**Browser close codes:** when the upgrade is refused with HTTP 401 (expired or invalid token), browsers report close code 1006, not 4401. The client treats that as a network failure: it backs off, and `getAccessToken` refetches whenever fewer than 60 s remain. 4401 is only seen when the server closes an open socket (revocation or recheck). That case triggers the one forced refresh.

## Contract for 02-11 (names kept as specified)

- `IdentityService.verifyAccessToken(token): Promise<AuthContext | null>`: signature, issuer, audience, expiry and strict claims, then the revoked-sid flag in Redis, then the org_members row (missing or deactivated gives null).
- `IdentityService.signDeviceAccessToken({ deviceId, organizationId }): Promise<DeviceAccessToken>`: claims `sub, org, typ: "device", aud: "ocw:device-link", iat, exp = iat + 600`.
- `IdentityService.verifyDeviceAccessToken(token)`: returns `{ deviceId, organizationId } | null`. User tokens give null.
- `IdentityService.isSessionActive(sid)` and `isMemberActive(orgId, userId)`.
- `TestClient.token()` and `TestClient.request(method, path, body?, { headers?, noCookies? })`.
- The `IdentityService` constructor takes a fourth argument `revocations: { isSessionRevoked(sid) }`; `app.ts` passes `realtime`.
- `createRealtimeModule({ …, sessionRecheckMs? })` and `SESSION_RECHECK_MS` are exported from `modules/realtime`.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/identity.int.test.ts` | RED first (cookie-only upgrade got 101), then 7 passed (Task 1). Task 3: RED with 2 failures ("socket did not close within 3 s"), then 9 passed |
| `pnpm exec vitest run --project unit packages/realtime-client/src/client.test.ts` | RED: 3 failed for Task 1 and 3 failed for Task 3. GREEN: 8, then 11 passed |
| `pnpm exec vitest run --project integration apps/api/src/modules/identity/jwt.int.test.ts` | RED: 5 failed (Bearer 401, `signDeviceAccessToken` missing). GREEN: 6 passed |
| `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | 12 passed (after the deviation 1 edit) |
| `pnpm verify` after each task | lint clean (4 pre-existing warnings in apps/local-runtime), typecheck clean, final run 43 files / 409 tests passed |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` | **11 passed (37.9 s)**, exit 0: setup, then bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390. The web was rebuilt from this worktree. Afterwards :4290 was free. The demo was unchanged: `:4000/health` 200, `:3000/login` 200, and `ocw-demo-openclaw` Up (healthy) |

Acceptance greps:
- `app.ts` contains `handleProtocols` and `sec-websocket-protocol`.
- `gateway.ts` contains `WS_AUTH_PROTOCOL_PREFIX`, `verifyAccessToken`, `onRevocation`, `isSessionActive` and `4401`.
- `realtime.tsx` contains `getToken`, and `client.ts` contains `force: true`.
- `grep -rn "access_token=\|?token=" apps/web/lib packages/realtime-client/src` prints nothing.
- `jwt.ts` contains `createLocalJWKSet`, `jwtVerify`, `algorithms: ["EdDSA"]`, `DEVICE_TOKEN_AUDIENCE` and `ERR_JWKS_NO_MATCHING_KEY`, and `grep -c verifyJWT` gives 0.
- `identity.int.test.ts` asserts close code 4401 after a revocation.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] `apps/api/src/workzone.int.test.ts` opened `/ws` with a cookie**
- **Found during:** Task 1. The cookie path is removed from `/ws`, so this test's realtime check would have gotten 401.
- **Fix:** a 4-line change. It now offers `[WS_PROTOCOL, WS_AUTH_PROTOCOL_PREFIX + await admin.token()]`. The file is not in this plan's list, and another wave-3 plan may touch it, so watch for a trivial merge conflict.
- **Commit:** 271b615

**2. [Rule 1 - Bug] The 5-minute recheck re-ran cookie authentication**
- **Found during:** Task 1. JWT sockets carry no cookie, so the old recheck would have closed every socket with 4401 after 5 minutes.
- **Fix:** the recheck body moved to Task 1 as `isSessionActive(sid) && isMemberActive(org, user)`. A transient lookup error does not close the socket. Task 3 added the registry, revocation and the injectable interval.
- **Commit:** 271b615

**3. Scope placement**
- `signDeviceToken` and `verifyDeviceToken` landed in `jwt.ts` with Task 1. The `IdentityService` methods and their tests came with Task 2.
- The `IdentityService` constructor takes a narrow `RevocationCheck` instead of the whole `RealtimeService`.
- `isMemberActive` was added for the deactivation recheck. `bearerJwt()` is exported from `authenticate.ts`.

**4. The recheck test uses a second Fastify instance**
- That instance runs `createRealtimeModule({ sessionRecheckMs: 100 })` over the stack's real identity and realtime, not fake timers. It proves the session-row-deleted case and the member-deactivated case against real PostgreSQL.

### Notes for later plans

- **Sign-out does not publish a revocation yet.** `POST /api/auth/sign-out` is still the raw better-auth proxy. After sign-out, an already-issued access JWT keeps working on REST until it expires (at most 10 minutes), and an open socket closes at the next recheck (at most 5 minutes). 02-09 (sessions and `user.signed_out`) should call `publishRevocation({ sessionIds: [sid], reason: "signed_out" })` after sign-out, as it already plans for session revoke.
- A userId-only revocation (`{ userId }` with no sids) closes sockets. On REST it relies on the org_members deactivation check, as designed.

## Known Stubs

None.

## Threat Flags

None. All new surface is covered by T-02-08-01..07: Bearer on REST, the subprotocol token, the revocation listener and device tokens.

## Self-Check: PASSED

Files: jwt.ts, jwt.int.test.ts and auth-token.ts exist. Commits 271b615, bf6d51d and 3ed5730 are present on wt/02-08. No stub patterns in the files this plan touched.
