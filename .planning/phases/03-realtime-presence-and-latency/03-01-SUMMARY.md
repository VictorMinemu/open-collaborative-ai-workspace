---
phase: 03-realtime-presence-and-latency
plan: 01
subsystem: realtime
status: complete
tags: [realtime, presence, redis, websocket, rt-04, tracer]
requires:
  - 02-02 resolver (topic authorizers decide every `sub`)
  - 02-08 WS JWT auth (verified AuthContext on every socket)
provides:
  - presence ServerFrame, PresenceEntry, PRESENCE_TOPIC_PREFIXES, PRESENCE_SNAPSHOT_LIMIT, isPresenceTopic
  - sub.presence opt-in flag (ClientFrame)
  - apps/api/src/modules/realtime/presence.ts (createPresenceStore, PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS, presenceKey)
  - topicChannel (service.ts), gateway Connection registry, heartbeat with ping liveness, refresh and sweep
  - realtime-client applyPresenceFrame, aggregatePresence, client.presence, subscribe({ presence })
  - web usePresence, useTopic(..., { presence }), PresenceDot, PresenceAvatar, PresenceStack, usePresentPeople
  - e2e/support/actors.ts (frozen), e2e/tests/presence.spec.ts
affects: [03-02, 03-03, 03-04, 03-05, 03-06]
tech-stack:
  added: []
  patterns:
    - "Presence per connection in a Redis sorted set scored by expiry; deltas published inside the same MULTI as the write"
    - "Presence is opt-in per subscription: only the view that shows a conversation counts as here"
key-files:
  created:
    - apps/api/src/modules/realtime/presence.ts
    - apps/api/src/realtime-presence.int.test.ts
    - packages/realtime-client/src/presence.ts
    - packages/realtime-client/src/presence.test.ts
    - apps/web/components/presence/presence-stack.tsx
    - e2e/support/actors.ts
    - e2e/tests/presence.spec.ts
  modified:
    - packages/contracts/src/realtime.ts
    - packages/contracts/src/contracts.test.ts
    - apps/api/src/modules/realtime/gateway.ts
    - apps/api/src/modules/realtime/service.ts
    - apps/api/src/modules/realtime/index.ts
    - apps/api/src/app.ts
    - apps/api/src/identity.int.test.ts
    - packages/realtime-client/src/client.ts
    - packages/realtime-client/src/client.test.ts
    - packages/realtime-client/src/index.ts
    - apps/web/lib/realtime.tsx
    - apps/web/components/chat/channel-view.tsx
decisions:
  - "Presence is opt-in per subscription (`sub.presence: true`); background unread watchers never count as here (deviation from D-01 wording, see below)"
  - "join/leave publish their delta inside the same MULTI as the Redis write, so a leave can never overtake its join's announcement"
  - "leave removes the connection under every stored state (online and away), so 03-02 state changes never leave a stale member"
metrics:
  duration: "~21 min"
  completed: "2026-10-04"
  tasks: 2
  files: 19
actuals:
  tokens: 15600
  tasks: 2
  commits: 3
---

# Phase 3 Plan 01: Who is here now (presence tracer) Summary

When two people have the same channel open, each sees the other in the channel header within milliseconds. Someone who closes the tab, loses the network or whose API instance dies disappears on their own. Presence lives in Redis, one entry per connection, and only subscriptions the resolver authorised can appear in it.

## What was built

- **Contract** (`packages/contracts/src/realtime.ts`): a `presence` ServerFrame. `full: true` is the snapshot sent after `subscribed`; `full: false` is a per-connection delta, where `offline` removes the connection. Each entry is `{ conn: uuid, userId: uuid, state: online|away|offline }` and a frame holds at most 500. Also new: `isPresenceTopic` (`conv`/`ws` only), and `sub` gains an optional `presence` flag.
- **API store** (`realtime/presence.ts`): key `ocw:presence:<orgId>:<topic>`, member `<conn>|<userId>|<state>`, score = expiry. `join` and `leave` each run as one MULTI (write + PEXPIRE 2×TTL + PUBLISH on `topicChannel(topic)`). `snapshot` returns unexpired entries, newest first, at most 500, and skips malformed ones. `refresh` re-scores all entries in one MULTI and re-announces any re-added entry (self-heal). `sweep` claims expired entries with ZRANGEBYSCORE + ZREMRANGEBYSCORE in one MULTI, so exactly one instance claims each.
- **Gateway**: a `Connection` registry with `id = randomUUID()` (never the sid). Presence runs only after `authorizeTopic` allowed the sub and `subscribed` was sent. Deltas that arrive before the snapshot are buffered and flushed after it. Unsub and close leave presence. One heartbeat tick per instance (15 s) does three things: ping liveness (no pong by the next tick → `terminate()`), then refresh, then sweep of the topics that have local subscribers. On app close every joined entry leaves.
- **Client**: a pure `applyPresenceFrame` / `aggregatePresence` (online beats away, online first). `client.presence` is a zustand store that is cleared on socket close and dropped per topic when the last presence listener leaves. `subscribe(topic, l, { presence: true })` counts presence listeners per topic and re-sends `sub` when the count goes 0→1 or 1→0.
- **Web**: `usePresence(topic)`, and `useTopic(..., { presence: true })` in the channel view. `PresenceStack` sits in the channel header, left of the members button: up to 3 avatars (2 below 640 px), a `bg-success` / `bg-warning` dot with `ring-background`, a "+N" chip, and a tooltip titled "Here now".
- **E2E**: `e2e/support/actors.ts` provides SAM, apiAs, ensureMember, userIdOf, createChannel, joinChannel and openAs. `presence.spec.ts` runs in both projects.

## Observed latencies

| Path | Measured |
|---|---|
| Integration, join → other member's `online` delta | 3 ms |
| Integration, `unsub` → `offline` delta | 1 ms |
| Integration, socket close → `offline` delta | 1 ms |
| Integration, dead peer (`autoPong: false`, heartbeat 100 ms) → terminated / offline delta | 165 ms / 167 ms (bound 400 ms) |
| Integration, crashed-instance entry (expires at +200 ms) → swept `offline` | under 200 + 2 heartbeats + 150 ms margin |
| E2E, other person's avatar in the header | within the 3 s assertion, both projects (desktop 8.2 s, mobile 7.3 s for the whole spec including typing expiry) |
| E2E, typing indicator gone after the last keystroke | under 7 s (USER_TTL 5 s) |
| E2E, closed tab gone from the header | within the 3 s assertion |

## Screenshots (reviewed with Read; verdict: clean)

`.planning/phases/03-realtime-presence-and-latency/screenshots/`: `presence-header-1440.png`, `presence-header-1440-dark.png`, `presence-header-390.png`, `presence-header-390-dark.png`.

- At 1440 the stack sits left of the members button with clear spacing. The tooltip ("Here now · Sam Lee · Active") is fully visible below the header in both themes.
- At 390 the title truncates first. The stack (one avatar + green dot) and the members button keep their size and do not crowd each other.
- The green dot is clearly visible on the tinted avatar in light and dark.

## Verification

- `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/presence.test.ts packages/realtime-client/src/client.test.ts`: 3 files, all passed (contracts 19, client 15 + presence 5)
- `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts apps/api/src/identity.int.test.ts`: 2 files, 15 tests passed. The presence file was run 3 more times, each 6/6 passed.
- `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh presence.spec`: setup + desktop + mobile, 3 passed. 4 `presence-header-*` screenshots.
- `pnpm verify`: exit 0, 56 files / 555 tests passed
- `pnpm --filter @ocw/local-runtime test` 113 passed · `@ocw/desktop` 58 passed · `@ocw/openclaw-channel` 51 passed
- Full `bash scripts/e2e-isolated.sh`: **37 passed** (2.2 min), none flaky or skipped. The API log has 0 lines with a 5xx or presence errors.
- Demo untouched: `localhost:4000/health` and `localhost:3000/login` answered before and after. No compose service was stopped or recreated (uptimes unchanged).
- Acceptance greps: `z.literal("presence")`, `PRESENCE_TOPIC_PREFIXES`, `ocw:presence:`, `topicChannel` in presence.ts, `randomUUID` and `presence.join` in gateway.ts, `usePresence`, `PresenceStack`, `zRemRangeByScore`, `terminate()`, `ping()` and `autoPong: false` are all present.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] "Holds a subscription" is not "is here": presence made opt-in per subscription**
- **Found during:** Task 1, first e2e run (mobile).
- **Issue:** The chat sidebar keeps a background `conv:<id>` subscription for every joined channel (`ChannelWatcher`, for live unread dots). Under the D-01 wording, everyone with the app open would be "here" in every channel they belong to. The e2e caught Sam in the admin's header while Sam was looking at #general.
- **Fix:**
  - `ClientFrame.sub` gains an optional `presence: boolean`. The gateway joins presence and forwards presence frames only for `presence: true` subs on `conv`/`ws` topics.
  - The realtime client counts presence listeners per topic. It re-sends `sub` (from the topic's cursor, so no duplicates) when the count flips. Presence frames are applied only while the count is > 0.
  - `useTopic` gains `opts.presence`, and the channel view sets it.
  - New tests: contract (flag parses, non-boolean rejected), client (opt-in, flip via re-sub, reconnect keeps the flag), integration (a background sub is not "here" and receives no presence; re-subscribing flips it both ways), and the e2e "alone → no stack" step while Sam has the app open on another channel.
- **Impact on later plans:**
  - 03-03 (members dialog lives inside the channel view; the Work Zone header must call `useTopic(ws:…, …, { presence: true })` in `use-live-session.ts`).
  - 03-02 (the away op applies to the socket's joined entries as planned).
  - 03-04 (revocation leaves via `presenceJoined` as planned).
- **Files:** packages/contracts/src/realtime.ts, contracts.test.ts, packages/realtime-client/src/client.ts, client.test.ts, apps/api/src/modules/realtime/gateway.ts, apps/api/src/realtime-presence.int.test.ts, apps/web/lib/realtime.tsx, apps/web/components/chat/channel-view.tsx
- **Commit:** 542b775

**2. [Rule 1 - Bug] Join/leave announcement ordering**
- **Issue:** Publishing the delta after awaiting the MULTI would let a quick leave's `offline` overtake the join's `online`, leaving a ghost avatar on every watcher.
- **Fix:** PUBLISH runs inside the same MULTI as ZADD/ZREM. `leave` removes the member under every stored state.
- **Commit:** 542b775

**3. [Rule 2 - Missing critical] Sweep frames respect the contract cap**
- **Issue:** One sweep could claim more than 500 entries, and the client's Zod schema rejects frames over `PRESENCE_SNAPSHOT_LIMIT`.
- **Fix:** Offline deltas are chunked at 500 entries per frame.
- **Commit:** e6dbdc2

### Process notes
- The plan's commit guard expects an `agent-*` branch. Per the orchestrator's explicit instruction, work and commits went directly on `feat/phase-3-realtime-presence`. Nothing was pushed, and STATE.md/ROADMAP.md were not edited (also per instruction).
- The contract and integration tests were RED before the implementation. The e2e spec was not run RED on its own; its first run after the implementation failed on mobile and exposed deviation 1. The `sub.presence` contract test passed on first run because the schema line went in with it.
- Accepted residual risks (both self-healing within one TTL):
  - The refresh re-announcement after a lost key could theoretically race a simultaneous leave on the same connection.
  - A sweep racing a late refresh after a stall longer than 45 s is the inversion described in Research note 3.

## Known Stubs

None.

## Self-Check: PASSED

- Files exist: presence.ts, realtime-presence.int.test.ts, client presence.ts/presence.test.ts, presence-stack.tsx, e2e/support/actors.ts, e2e/tests/presence.spec.ts, 4 × presence-header-*.png
- Commits exist: 542b775, e6dbdc2
