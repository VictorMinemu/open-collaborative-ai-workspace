---
phase: 03-realtime-presence-and-latency
plan: 02
subsystem: realtime
status: complete
tags: [realtime, presence, away, rate-limit, rt-04]
requires:
  - 03-01 presence tracer (PresenceStore, gateway Connection.presenceState, sub.presence opt-in, PresenceAvatar away styling)
provides:
  - PresenceState, ClientFrame `{ op: "presence", state }`, AWAY_AFTER_IDLE_MS, PRESENCE_CLIENT_THROTTLE_MS (contracts)
  - packages/realtime-client/src/activity.ts (createActivityMonitor, ActivityMonitor)
  - RealtimeClient.setPresence (leading + trailing 500 ms throttle, away re-reported before subs on every open)
  - PresenceStore.setState (one MULTI: ZREM old member, ZADD new, PEXPIRE, PUBLISH)
  - gateway `presence` op with PRESENCE_RATE_LIMIT (30 / 10 s per socket) and `rate_limited` error
  - realtime module option presence.rateLimit (tests)
  - RealtimeProvider activity reporter (visibilitychange + input events)
  - e2e/tests/presence-away.spec.ts
affects: [03-03, 03-04, 03-05, 03-06]
tech-stack:
  added: []
  patterns:
    - "Pure state machine for away/active with injectable timers; DOM wiring lives only in the web provider"
    - "Change-only presence ops: identical states are dropped on the client and before the server limiter"
key-files:
  created:
    - packages/realtime-client/src/activity.ts
    - packages/realtime-client/src/activity.test.ts
    - e2e/tests/presence-away.spec.ts
    - .planning/phases/03-realtime-presence-and-latency/screenshots/presence-away-{1440,1440-dark,390,390-dark}.png
  modified:
    - packages/contracts/src/realtime.ts
    - packages/contracts/src/contracts.test.ts
    - packages/realtime-client/src/client.ts
    - packages/realtime-client/src/client.test.ts
    - packages/realtime-client/src/index.ts
    - apps/api/src/modules/realtime/presence.ts
    - apps/api/src/modules/realtime/gateway.ts
    - apps/api/src/modules/realtime/index.ts
    - apps/api/src/realtime-presence.int.test.ts
    - apps/web/lib/realtime.tsx
decisions:
  - "A state change is dispatched to every joined topic at once (in order on the one Redis connection) rather than awaited topic by topic, so a heartbeat refresh cannot slip between topics"
  - "pointermove counts as activity (alongside pointerdown, keydown, wheel, touchstart, focus), forwarded at most once per second"
  - "Away e2e reuses the browsers' session cookies for API calls to stay under the 30/min sign-in limit"
metrics:
  duration: "~25 min"
  completed: "2026-10-04"
  tasks: 2
  files: 17
actuals:
  tokens: 8100
  tasks: 2
  commits: 3
---

# Phase 3 Plan 02: Away state Summary

When Sam hides the tab, everyone with the channel open sees Sam turn Away within milliseconds: amber dot, dimmed avatar, and "Away" in the tooltip. When Sam comes back or touches the mouse, Sam is Active again. After 5 minutes without input in a visible tab, Sam also turns Away. The state survives reconnects and applies to every conversation Sam opens. One socket can apply at most 30 changes per 10 s.

## What was built

- **Contracts:**
  - `PresenceState` (`online|away`).
  - ClientFrame `{ op: "presence", state }`. It carries no user, topic or connection, and Zod strips any extra fields.
  - `AWAY_AFTER_IDLE_MS` (5 min) and `PRESENCE_CLIENT_THROTTLE_MS` (500 ms).
- **`createActivityMonitor` (pure, no DOM):**
  - Starts online with the idle timer running.
  - Hidden: away at once, and the timer is cancelled.
  - Visible: counts as activity.
  - Activity in a visible tab: online, and the timer restarts.
  - Idle timer fires: away.
  - `onChange` fires only on a real change. Timers are injectable. `dispose()` cancels the timer.
- **`RealtimeClient.setPresence`:**
  - Sends on the leading edge when the state differs from what the current socket was last told.
  - Changes inside 500 ms collapse into one trailing send of the latest state.
  - Every `onopen` resets the last-sent state to online and reports `away` before re-subscribing, so a reconnecting away client is stored as away everywhere.
  - `close()` cancels the trailing timer.
- **`PresenceStore.setState(orgId, topic, conn, userId, from, to)`:** one MULTI does `ZREM` of the old member, `ZADD` of the new member with a fresh expiry, `PEXPIRE` and `PUBLISH` of the delta.
- **Gateway `presence` op:**
  - Identical states are ignored before the limiter.
  - A sliding window of applied changes per connection enforces `PRESENCE_RATE_LIMIT = { max: 30, windowMs: 10_000 }`. Anything beyond it gets `{ op: "err", code: "rate_limited" }` and is neither applied nor fanned out.
  - An applied change updates `conn.presenceState` and calls `setState` for every joined presence subscription of that socket only. Joins made later already use the new state (from 03-01).
  - Malformed states get `bad_frame`.
- **Web (`RealtimeProvider`):**
  - One monitor per client, with `onChange` sending `client.setPresence`.
  - It reads `document.visibilityState` once, then on every `visibilitychange`.
  - These window events count as activity: `pointerdown`, `pointermove`, `keydown`, `wheel`, `touchstart` and `focus`, all `{ passive: true }` and forwarded at most once per second.
  - All listeners are removed and the monitor disposed in the effect cleanup.

## Observed propagation times

| Path | Measured |
|---|---|
| Integration: `presence away` → other member's `away` delta | 1 ms |
| Integration: `presence online` → `online` delta | 1 ms |
| E2E desktop: tab hidden → admin sees `data-state="away"` | 7 ms (assertion bound 2 s) |
| E2E desktop: tab visible + mouse move → `online` | 9 ms |
| E2E mobile: hidden → away / visible → online | 7 ms / 10 ms |

## Screenshots (reviewed with Read; verdict: clean)

All four are in `.planning/phases/03-realtime-presence-and-latency/screenshots/`: `presence-away-1440.png`, `presence-away-1440-dark.png`, `presence-away-390.png` and `presence-away-390-dark.png`.

- **1440:** the tooltip reads "Here now · Sam Lee · Away" with an amber dot, fully visible below the header in both themes. Next to the 03-01 Active captures, Away is unmistakable: amber dot instead of green, and the "S" avatar visibly dimmed.
- **390:** the title truncates first. The single away avatar (amber dot) and the members button keep their size, with no crowding in either theme.

## Verification

- `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/activity.test.ts packages/realtime-client/src/client.test.ts`: 3 files, all passed. activity has 9 tests.
- `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts`: 9/9 passed. Run 3 more times after Task 2, 9/9 each time.
- `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh presence-away`: setup, desktop and mobile, 3 passed. It produced 4 `presence-away-*` screenshots.
- `pnpm verify`: exit 0, 57 files / 576 tests passed. The lint warnings are pre-existing ones in `apps/local-runtime`.
- `pnpm --filter @ocw/local-runtime test`: 113 passed. `@ocw/desktop`: 58 passed. `@ocw/openclaw-channel`: 51 passed.
- Full `bash scripts/e2e-isolated.sh`: **39 passed** (2.3 min), none flaky or skipped. The API log has 0 lines with 429, 0 with 5xx and 0 presence errors.
- The demo was untouched: `localhost:4000/health` and `localhost:3000/login` answered 200 before and after. No compose command other than the script's own was run.
- Acceptance greps all print the expected lines:
  - `AWAY_AFTER_IDLE_MS` in realtime.ts and activity.ts
  - `setPresence` in client.ts and realtime.tsx
  - `createActivityMonitor` and `visibilityState` in realtime.tsx
  - `setState` in presence.ts and gateway.ts
  - `PRESENCE_RATE_LIMIT` in gateway.ts and `rate_limited` in the integration test
  - a 5-minute fake-timer advance in activity.test.ts

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The full e2e suite tripped the sign-in rate limit**
- **Found during:** the plan-level verification (the first full run of `e2e-isolated.sh`). 3 failed and 7 did not run.
- **Issue:** `/api/auth/sign-in/email` allows 30 sign-ins per minute per IP, and every e2e request comes from 127.0.0.1. The run made 89 sign-ins, with up to 53 inside one 60 s span. The 4 extra sign-ins per project from the new spec pushed later specs into 429s: `work-zone` on desktop, and `account` and `admin-members` on mobile.
- **Fix:** the spec now builds its API contexts from the signed-in browsers' `storageState`. That is 2 sign-ins per project instead of 4, and the rate limit was not touched. After the fix the full run passed 39/39 with 0 × 429.
- **Files:** e2e/tests/presence-away.spec.ts
- **Commit:** 583888e
- **Note for 03-03 and later plans:** the suite is close to this limit. New two-person specs should reuse browser sessions the same way rather than call `apiAs` in addition to `openAs`.

**2. [Rule 1 - Minor] State changes are dispatched to all topics at once instead of awaited one by one**
- **Why:** The plan said "sequentially per topic". All commands go through the single `bus.pub` connection, so dispatching them together keeps program order. It also prevents a heartbeat `refresh` from slipping between two topics' updates and re-announcing a half-applied state.
- **Commit:** 148f5e1

**3. [Rule 2 - Missing] `pointermove` counts as activity**
- **Why:** The plan's event list (pointerdown, keydown, wheel, touchstart, focus) would mark someone who only reads and moves the mouse as Away after 5 minutes, and the e2e step itself says "Sam moves the mouse". The 1 s forwarding throttle bounds the cost.
- **Commit:** 148f5e1

### Process notes
- **TDD:**
  - Contract, activity, client and integration tests were RED before Task 1's implementation.
  - The Task 2 unit tests (idle edges, reconnect re-report, trailing send after reconnect, `close()` cancelling it) passed on first run, because Task 1's client and monitor already had that behaviour. The `rate_limited` integration test was RED and then turned GREEN.
  - The e2e spec was not run RED on its own.
  - While RED, the first integration run left sockets open after a failure, and those sockets broke the later expiry tests (wrong own-connection lookup). The new tests now close their sockets in `finally`.
- **Process:**
  - Commits are on `wt/03-02` as the orchestrator instructed. Nothing was pushed, and STATE.md and ROADMAP.md were not edited.
  - `e2e/tests/presence.spec.ts` was not edited (03-03 owns it this wave).
  - The `setup-*.png` files written by the setup spec during the screenshot run were removed rather than committed.

## Threat model status

| Threat | Status |
|---|---|
| T-03-02-01 Spoofing | Mitigated. The frame has only `state`, extra identity fields are stripped (contract test), and the gateway updates only the sending connection's entries, keyed by the server conn id and the JWT user (integration test sends a spoofed `userId`/`conn`). |
| T-03-02-02 DoS | Mitigated. Changes apply only when the state differs, at most 30 per 10 s per socket, with `rate_limited` (integration test), plus the client's 500 ms leading + trailing throttle and 1 s input forwarding. |
| T-03-02-03 Tampering | Mitigated. The Zod enum rejects other states with `bad_frame` and nothing changes (integration test: busy, offline, missing, numeric). |
| T-03-02-04 Info disclosure | Accepted. Only online/away is published, with no timestamps or idle durations. |

## Known Stubs

None.

## Self-Check: PASSED

- Files exist: activity.ts, activity.test.ts, presence-away.spec.ts, 4 × presence-away-*.png
- Commits exist: 148f5e1, 8ebaf0c, 583888e
