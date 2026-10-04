---
phase: 02-identity-and-organization
plan: 11
subsystem: device, local-runtime, config
status: complete
tags: [jwt, device-token, device-link, websocket, legacy-flag, audit, daemon]
requires: ["02-05", "02-08", "02-09"]
provides:
  - "POST /api/v1/devices/token (authz device, 60/min, cache-control no-store): raw device token → 10-minute device JWT, device.link decided"
  - "/runtime/ws accepts device JWTs (JWKS-verified, device row re-checked for revocation, device.link decided) and declares config.authz \"device\""
  - "OCW_ACCEPT_LEGACY_DEVICE_TOKEN (default true until Phase 8): raw device token on /runtime/ws, warned + audited device.legacy_token_used once per device per hour"
  - "DeviceLink getAccessToken({ refresh }) awaited before every connect; Daemon exchange with cache (refresh at T-60 s), 404 fallback, 401 backoff"
  - "apps/api/src/device-link-auth.int.test.ts (two stacks: flag on / flag off)"
affects: [02-14, 02-15]
tech-stack:
  added: []
  patterns:
    - "Short-lived credential fetched just before each connect; forced refresh after a refused handshake"
    - "Transitional credential behind an env flag, audited at most once per principal per hour (in-memory per API instance)"
key-files:
  created:
    - apps/api/src/modules/device/token.ts
    - apps/api/src/device-link-auth.int.test.ts
  modified:
    - apps/api/src/modules/device/link.ts
    - apps/api/src/modules/device/index.ts
    - apps/api/src/config/env.ts
    - .env.example
    - apps/api/src/workzone.int.test.ts
    - apps/local-runtime/src/device-link.ts
    - apps/local-runtime/src/daemon.ts
    - apps/local-runtime/src/daemon.test.ts
decisions:
  - "The exchange accepts only the raw device token: a device JWT or a user JWT presented to POST /devices/token is 401, so a JWT can never extend itself"
  - "A Bearer value shaped like a compact JWS goes only through the JWT path (never the hash lookup); raw tokens (ocwd_…) contain no dot, so the split is unambiguous"
  - "getAccessToken takes { refresh }: after a 401/403 on the WebSocket handshake the daemon drops its cached JWT instead of offering it until T-60 s"
  - "A failed legacy audit write does not refuse the upgrade (the flag exists to keep installed apps working); it is logged and retried on the next connect"
metrics:
  duration: "~35 min"
  completed: "2026-10-04"
  tasks: 2
  files: 10
actuals:
  tokens: 10200
  tasks: 2
  commits: 3
---

# Phase 2 Plan 11: Device Link authenticated with short-lived device JWTs, legacy tokens behind a flag Summary

The Local Runtime daemon now exchanges its long-lived device token for a 10-minute device JWT (`POST /api/v1/devices/token`) before every Device Link connect. `/runtime/ws` verifies that JWT against the JWKS, re-checks the device row so a revoked device is refused even with a JWT it still holds, and records a `device.link` resolver decision. Installed desktop apps keep working because the raw token is still accepted while `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` is true (the default), with one warning and one `device.legacy_token_used` audit row per device per hour.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `53d6dd6` | feat(02-11): daemon exchanges its device token for a 10-minute device JWT; Device Link verifies it |
| 2 | `f4c8e23` | feat(02-11): legacy device tokens behind OCW_ACCEPT_LEGACY_DEVICE_TOKEN; revocation and audience separation proven |

## What changed

- **API, `device/token.ts`:** `registerDeviceTokenRoute` mounts `POST /api/v1/devices/token` with `config: { authz: "device", rateLimit: 60/min }`. It looks up the Bearer value through `app.lookup_device_token` (non-revoked devices only), sets `req.device`, asserts `device.link` inside `withTenant({ org, userId: null })` and returns `identity.signDeviceAccessToken(...)` with `cache-control: no-store`. Neither credential is logged.
- **API, `device/link.ts`:** compact-JWS Bearer values go to `identity.verifyDeviceAccessToken`, then the device row is loaded in the tenant (`revoked_at` refused), then `perms.can(req, tx, "device.link")`. Other Bearer values go to the legacy branch only when the flag is on. The route now declares `config: { authz: "device" }`.
- **Config:** `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` (`"true"`/`"false"`, default `"true"`, parsed to a boolean) in `config/env.ts`, plus a commented entry in `.env.example`. Both say it is removed in Phase 8 with the RFC 8628 device grant.
- **Local Runtime:** `DeviceLink` awaits `getAccessToken({ refresh })` before each connect. A rejection goes through the normal backoff. A 401/403 on the handshake sets `refresh` for the next attempt. `Daemon.getAccessToken` POSTs to `toDeviceTokenUrl(serverUrl)` (keeps any path prefix) and caches `{ token, expiresAt }` until fewer than 60 s remain. A 404 (older server) falls back to the raw token, with one warning. A 401/403 logs "device token rejected by server" and throws `DeviceTokenRejectedError` so the link backs off. It never logs either token.

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` (Task 1) | 18 passed. The helper now connects like the daemon: exchange first, then the JWT. New test: exchange answer shape, TTL ≈ 600 s, `no-store`, and 401 for a wrong token, a device JWT, a user JWT and no header |
| `pnpm exec vitest run --project integration apps/api/src/device-link-auth.int.test.ts` | RED first: 2 failed (no legacy audit row; flag false still upgraded). GREEN: 5 passed |
| `pnpm exec vitest run --project integration apps/api/src/device-link-auth.int.test.ts apps/api/src/workzone.int.test.ts` | 2 files, 23 passed |
| `pnpm --filter @ocw/local-runtime test` | 9 files, 113 passed. 107 before, plus 6 new: cache reuse, refresh at < 60 s, 404 fallback, 401 backoff (2 to 25 attempts in 400 ms, none connected), forced refresh after a refused handshake, and no token in the logs |
| `pnpm --filter @ocw/desktop test` | 9 files, 58 passed |
| `pnpm verify` (after each task) | exit 0. Lint clean apart from 4 pre-existing warnings in apps/local-runtime. Typecheck: 8/8. Final run: 53 files / 517 tests passed |
| `bash scripts/e2e-isolated.sh` | **11 passed (38.4 s)**, exit 0. This covers work-zone.spec.ts at desktop 1440 and mobile 390, where the real daemon in fake-runtime mode pairs, exchanges, connects and runs a session. API log: 2 `POST /api/v1/devices/token` answered 200, followed by 2 `/runtime/ws` upgrades. It has 0 "legacy device token" warnings (so the JWT path was used), 0 `eyJ` and 0 `ocwd_`. After the run, :4290 belonged to the next queued run (02-13) and our API had stopped. The demo was unchanged: `:4000/health` 200, `:3000/login` 200, and `ocw-demo-openclaw` Up (healthy) |

Acceptance greps:
- `token.ts` contains `authz: "device"` and `signDeviceAccessToken`.
- `link.ts` contains `verifyDeviceAccessToken` and `"device.legacy_token_used"`.
- `device-link.ts` contains `getAccessToken`.
- `daemon.ts` contains `/api/v1/devices/token`.
- `env.ts` contains `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 - Correctness] Forced token refresh after a refused handshake**
- **Found during:** Task 1.
- **Issue:** with the plan's `getAccessToken: () => Promise<string>`, a cached JWT refused by `/runtime/ws` would keep being offered until 60 s before it expired, up to about 9 minutes of failed reconnects. That happens when the server's keys rotate or its database is reset.
- **Fix:** the signature became `getAccessToken({ refresh })`. `DeviceLink` sets `refresh` after a 401/403 handshake, and the daemon then skips its cache. A test covers it.
- **Commit:** 53d6dd6

**2. [Rule 2 - Correctness] Stop/start race in DeviceLink**
- **Issue:** a token fetch that resolved after `stop()` (or after `stop()` then `start()`) could open a second socket.
- **Fix:** a generation counter that `stop()` bumps. A late fetch result opens nothing.
- **Commit:** 53d6dd6

**3. [Rule 2 - Security] The exchange refuses JWTs**
- **Issue:** the plan only said to look up the Bearer value. A JWT never matches a stored hash, but the route now rejects any compact-JWS value outright, so a device JWT can never mint its successor.
- **Fix:** a test proves that a device JWT and a user JWT both get 401.
- **Commit:** 53d6dd6

**4. `/runtime/ws` declares `config: { authz: "device" }`**
- The route previously declared nothing. It now declares `device` and records a resolver decision on both credential paths, which 02-15's strict coverage expects.

**5. Helpers placed in `device/token.ts`**
- `bearerValue` and `looksLikeJwt` live in `device/token.ts` instead of importing `bearerJwt` from identity. `identity/index.ts` does not export it, and modules import each other only through public interfaces. No file outside the plan's list was touched.

### Not done (outside this plan's files)

- `docs/DEMO.md` and `scripts/setup-env.mjs` do not mention the flag. The default (`true`) keeps the demo working with no configuration, and `.env.example` documents it. The research's "Runtime State Inventory" lists both files, so 02-14 or 02-15 should add a line when the flag-off procedure is written.

## Demo safety

No compose command, no `pnpm db:migrate` with the default `.env`, no `pnpm demo:*`, and nothing bound to :4000 or :3000. The installed desktop app keeps working:
- The demo API is unchanged.
- When it is upgraded to this code, the flag defaults to `true`, so the old daemon's raw token is still accepted.
- A new daemon pointed at an old API gets 404 from the exchange and falls back to the raw token.

## Known Stubs

None.

## Threat Flags

None. All new surface is covered by T-02-11-01..05:
- T-01: audience/typ separation is tested both ways.
- T-02: the device row is re-checked on every upgrade, and the exchange refuses revoked devices.
- T-03: the flag, the hourly audit and the Phase 8 removal.
- T-04: no token appears in API or daemon logs (both are asserted).
- T-05: the 60/min limit, caching and backoff.

## Self-Check: PASSED

Files: token.ts and device-link-auth.int.test.ts exist. Commits 53d6dd6 and f4c8e23 are present on wt/02-11. No stub patterns in the files this plan touched.
