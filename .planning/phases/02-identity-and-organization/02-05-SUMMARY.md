---
phase: 02-identity-and-organization
plan: 05
subsystem: device, work-session, web (Work Zone)
status: complete
tags: [authorization, resolver, work-zone, devices, approvals, tool-layer, device-layer, viewerCan, client-kind]
requires: [02-02, 02-03]
provides:
  - "Every device REST route and every Work Zone route declares config.authz and is decided by the permission service"
  - "Approvals decided by work_session.approve on workSessionResource (creator / device_owner relation, admin role, Tool layer from the approval's tool)"
  - "POST /work-sessions = work_session.create ∩ device.use (device_not_shared, device_revoked) before the domain checks"
  - "ws:<id> topic authorizer decides work_session.read"
  - "viewerCan on WorkSessionDetail (prompt, interrupt, approve, archive) and on each Device (use, update, revoke)"
  - "deviceFacts(row, userId) exported from modules/device (replaces canUseDevice)"
  - "Session and prompt audit rows inherit the request's client kind (desktop from the Electron app)"
affects: [02-11, 02-15]
tech-stack:
  added: []
  patterns:
    - "sessionFacts(tx, auth, session, tool?) loads the device row once and builds workSessionResource"
    - "Domain 404/409 first (missing, already revoked), then the resolver, then the remaining domain checks (offline, runtime)"
    - "Detail snapshot cut at lastSeq: state and events read after lastSeq, events capped at seq <= lastSeq"
key-files:
  created: []
  modified:
    - apps/api/src/modules/work-session/routes.ts
    - apps/api/src/modules/work-session/index.ts
    - apps/api/src/modules/device/routes.ts
    - apps/api/src/modules/device/index.ts
    - apps/api/src/workzone.int.test.ts
    - apps/web/components/work-zone/session-view.tsx
    - apps/web/components/settings/devices-settings.tsx
decisions:
  - "GET /work-sessions uses requirePermission(work_session.read) without a per-row filter: work_session.read has no relation or precondition, so a per-row filter would return the same rows"
  - "Archive asserts work_session.archive before the already-archived short-circuit, so every 2xx is a resolver decision"
  - "The device.use denial on POST /work-sessions keeps the human message (not shared / revoked) by re-wrapping the AuthzDeniedError; the denial and its audit are unchanged"
  - "PATCH/DELETE prompts (edit, reorder, cancel) are work_session.prompt, so they are refused on a revoked device (Device layer, as decided in 02-02)"
  - "The Archive menu item in the session view is disabled from viewerCan as well (same rule as the approval buttons)"
metrics:
  duration: "~35 min"
  completed: "2026-10-04"
  tasks: 2
  files: 7
actuals:
  tokens: 12900
  tasks: 2
  commits: 4
---

# Phase 2 Plan 05: Devices and Work Zone on the permission resolver Summary

The resolver now decides every device and Work Zone route. An approval can be decided by the session creator, the device owner or an admin. A Tool-layer deny rule such as "nobody approves Bash" blocks that one tool and leaves the others alone. Standard users get 403 when they try to pair, list or start sessions, and Developers keep everything MVP 0 members could do. The web shows Approve/Deny, Archive, Revoke and Share from server-computed `viewerCan`. Prompts sent from the desktop app are audited as `desktop`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `39b156f` | feat(02-05): decide Work Zone approvals with the resolver, Tool layer included; viewerCan drives the web controls |
| 2 | `dede1d0` | feat(02-05): devices and every Work Zone route on the resolver; Device layer, real client kind, viewerCan on devices |
| fix | `cfa0a3c` | fix(02-05): cut the session detail snapshot at lastSeq so a racing event is never rendered twice |

## Route map (after this plan)

| Route | Decision |
|-------|----------|
| POST /devices/enrollments | `requirePermission("device.pair")` |
| POST /devices/enroll | `authz: "public"` (the pairing code is the credential) |
| GET /devices | `requirePermission("device.read")` + `viewerCan` per device |
| PATCH /devices/:id | 404 if missing or revoked, then `device.update` on deviceFacts (owner only) |
| DELETE /devices/:id | 404 / 409 already revoked, then `device.revoke` (owner relation or admin role) |
| GET /projects | `requirePermission("work_session.read")` + `perms.filter(device.use)` |
| GET /work-sessions | `requirePermission("work_session.read")` |
| POST /work-sessions | `work_session.create` (org), 404/409 project checks, `device.use` on the device, then offline/runtime 409s |
| GET /work-sessions/:id | `work_session.read` (hidden as 404) + `viewerCan` |
| POST prompts, PATCH/DELETE prompts/:pid | `work_session.prompt` on sessionFacts |
| POST interrupt | `work_session.interrupt` |
| POST approvals/:aid | `work_session.approve` with `tool` = the approval's `request.tool` |
| GET diff | `work_session.read` (hidden as 404) |
| POST archive | `work_session.archive` |
| ws topic `ws:<id>` | `perms.decide(work_session.read)`; false when the session is not in the tenant |

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/workzone.int.test.ts` | **17 passed** (13 before this plan, plus 4 new tests and extended assertions) |
| `pnpm --filter @ocw/web typecheck` | exit 0 |
| `pnpm verify` (after Task 2 and after the fix) | exit 0: biome clean (only the 4 old local-runtime warnings), turbo 8/8, **42 files / 399 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` (final, after the fix) | **11 passed (31.4 s)**, exit 0: setup, plus bots, chat, codex-subscription, smoke and work-zone at 1440 and 390 |
| `bash scripts/e2e-isolated.sh work-zone` ×5 after the fix | 5/5 green (10 work-zone runs) |

What the new integration cases cover:
- **Unrelated developer approving:** 403 with details `{permission: "work_session.approve", layer: "role", reason: "missing_permission"}` and one more `authz.denied` audit row.
- **Allowed deciders:** the creator (Alex, on a shared device), the device owner, and an admin with neither relation (Dana) each decide.
- **Tool-layer rule:** with an org-wide deny on `work_session.approve` for tool `Bash`, the Bash approval gets 403 `layer: "tool"` with the `ruleId`, a Read approval still succeeds, and Bash succeeds again once the rule is gone.
- **viewerCan on session detail:** creator and admin get `work_session.approve` and `work_session.archive`; an unrelated developer gets neither.
- **Standard user:** 403 on pair, create, list sessions, `/projects` and `/devices`. A `ws:<id>` subscription is refused, while a developer gets `subscribed`.
- **Developer:** pairs a device of their own.
- **viewerCan on devices:**
  - admin on a non-owned device: `["device.revoke"]`
  - owner: `["device.use", "device.update", "device.revoke"]`
  - non-owner developer: `[]`, or `["device.use"]` once the device is shared
- **/projects:** follows sharing.
- **Device updates and revokes:**
  - PATCH by an admin who is not the owner: 403 `device.update`
  - PATCH and DELETE by a non-owner developer: 403
  - DELETE by an admin who is not the owner: 200
- **Starting sessions:** `device_not_shared` (403), `device_offline` (409), and `device_revoked` (403, layer `device`).
- **Client kind:** a session and a prompt from a desktop sign-in are audited with `client_kind = "desktop"`.
- **Authz coverage:** `stack.built.authz.undecided` has no `/api/v1/devices`, `/api/v1/projects` or `/api/v1/work-sessions` entry.

Acceptance greps:
- No `canUseDevice`, `listUsableProjects` or `isAdmin` hit in `modules/device` or `modules/work-session`.
- `authz-legacy` count is 0 in `device/routes.ts`, `work-session/routes.ts`, `devices-settings.tsx` and `session-view.tsx`.
- `clientKind: "web"` count is 0 in `work-session/routes.ts`; `assertCanApprove` count is 0.
- `"work_session.approve"` and `workSessionResource(` are present in `work-session/routes.ts`.
- `viewerCan` is present in both web files.

### Demo stack (hard rule)

| Check | Before | After |
|-------|--------|-------|
| `curl localhost:4000/health` | 200 | 200 |
| `curl localhost:3000/login` | 200 | 200 |
| `ocw-demo-openclaw` | running, started 2026-10-04T15:54:27Z | running, started 2026-10-04T15:54:27Z |

No `docker compose down/rm/stop/restart`, no `db:migrate` with the default `.env`, no `demo:*`, nothing bound on :4000/:3000. Every e2e run went through `scripts/e2e-isolated.sh`, and ports 4290/3290 were free afterwards.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Duplicate prompt bubble from a race in the session detail snapshot**
- **Found during:** plan-level e2e. `work-zone.spec.ts:107` expected 2 `prompt-bubble`s and got 3, in 2 of 8 runs with this plan's code. The same spec on the base code passed 4/4 (8 runs).
- **Root cause:** `GET /work-sessions/:id` read `lastSeq` and the events in separate statements. Under READ COMMITTED, an event committed between the two reads came back in `events` with a seq above `lastSeq`. The topic replay (`afterSeq = lastSeq`) then delivered it again, and the reducer appended it a second time. The race existed before. The extra authorization queries moved the GET into the burst of events at session start, which made it show up.
- **Fix:** read `lastSeq` first. Then read the session, prompts, approvals and events (capped at `seq <= lastSeq`) one after another. Anything newer arrives only through the replay. This also stops concurrent queries on one transaction client on this path.
- **Verification:** work-zone e2e 5/5 green, the full e2e suite 11/11, the integration file 17/17.
- **Files modified:** apps/api/src/modules/work-session/routes.ts
- **Commit:** `cfa0a3c`

**2. [Rule 1 - Test] Revocation test counted every `device.revoked` row in the org**
- The new device test revokes Alex's device, so the old `count = 1` assertion would see 2. It now counts rows for the revoked device's id. The behaviour under test did not change.
- **Commit:** `dede1d0`

**3. Small additions within the planned files (UI gating, same source of truth)**
- In `session-view.tsx`, the Archive menu item is disabled unless `viewerCan` has `work_session.archive`.
- In `devices-settings.tsx`, the Share switch renders from `device.update` instead of `owned`. The plan suggested this.

### Process notes
- **TDD ordering:** tests were written with the implementation and committed together (one `feat` commit per task), as in 02-02. The new cases fail against the base code: the old code returns no `viewerCan`, no `layer: "tool"`, 200 to a standard user, and `client_kind = "web"`.
- **`pnpm verify` timing:** run after Task 2 and after the fix, not after Task 1. Task 1 was checked with its own automated commands: the integration file and the web and api typecheck.
- `pg` still prints one `DeprecationWarning` (concurrent `client.query`) in the integration run. It comes from unchanged code that runs `Promise.all` inside a transaction (for example the device list's rows/directory/counts). Out of scope.

## Notes for later plans
- `deviceFacts(row, userId)` is exported from `modules/device` for 02-11 (Device Link) and anyone else who needs device resource facts.
- `toDevice` is still exported; `listDevices` is now private to the device routes.
- Standard users get 403 from `GET /api/v1/projects` and `GET /api/v1/devices`. They used to get 200. The web hides the Work Zone and Devices entries for them (02-02 nav gating), so nothing in the UI calls these routes for a standard user.

## Known Stubs

None.

## Threat Flags

None. No new surface: the same routes, now decided by the resolver. T-02-05-01..06 are covered by the tests listed above.

## Self-Check: PASSED
