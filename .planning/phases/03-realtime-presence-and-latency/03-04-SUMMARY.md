---
phase: 03-realtime-presence-and-latency
plan: 04
subsystem: realtime
status: complete
tags: [realtime, authz, rt-01, revocation, resolver, presence]
requires:
  - 02-02 resolver (conv topic authorizer → perms.decide channel.read)
  - 03-01 gateway Connection registry, presence opt-in per sub, unsub leaves presence
  - 03-02 gateway presence op (unchanged)
provides:
  - ServerFrame `{ op: "revoked", topic, reason: "forbidden" }` and RevokedFrame (contracts)
  - AUTHZ_INVALIDATION_CHANNEL, SubscriptionInvalidation, SubscriptionInvalidator, Reauthorization, parseInvalidation
  - RealtimeService.registerSubscriptionInvalidator / invalidateSubscriptions / onSubscriptionInvalidation / reauthorizeTopic
  - gateway re-decision queue (REAUTH_CONCURRENCY = 4, coalesced per connection + topic) with authzEpoch
  - gateway per-topic subscribe generation (latest sub/unsub wins)
  - chat `conversation.member_removed` invalidator
  - realtime-client `subscribe(..., { onRevoked })`; web `useTopic(..., { onRevoked })`
  - channel view access-lost state (`channel-access-lost`)
affects: [03-05, 03-06]
tech-stack:
  added: []
  patterns:
    - "Access changes publish an invalidation after commit; gateways re-decide the matching live subscriptions through the same topic authorizers that decided them"
    - "Tri-state re-decision: denied revokes, error keeps (fail-safe for legitimate streams), new subscribes stay deny-on-error"
    - "Latest frame wins per topic: a decision that finishes after a newer sub/unsub is dropped"
key-files:
  created:
    - apps/api/src/realtime-reauth.int.test.ts
    - e2e/tests/realtime-access.spec.ts
    - .planning/phases/03-realtime-presence-and-latency/screenshots/access-lost-channel-{1440,1440-dark,390,390-dark}.png
  modified:
    - packages/contracts/src/realtime.ts
    - packages/contracts/src/contracts.test.ts
    - apps/api/src/modules/realtime/service.ts
    - apps/api/src/modules/realtime/gateway.ts
    - apps/api/src/modules/realtime/index.ts
    - apps/api/src/modules/chat/index.ts
    - packages/realtime-client/src/client.ts
    - packages/realtime-client/src/client.test.ts
    - apps/web/lib/realtime.tsx
    - apps/web/components/chat/channel-view.tsx
decisions:
  - "onRevoked goes into useTopic's existing fifth argument (opts) instead of a new sixth positional argument, because 03-01 already used the fifth slot for { presence }"
  - "The access-lost state is keyed by channel id and rendered before the loading and not-found branches, so the channel list dropping the private channel never replaces it with 'This channel doesn't exist'"
  - "A stale unsubscribe closure in the realtime client is a no-op once its topic state was revoked or replaced, so it can never tear down a fresh subscription"
  - "Overlapping subscribes for one topic resolve to the latest sub/unsub frame (per-topic generation in the gateway)"
metrics:
  duration: "~55 min"
  completed: "2026-10-04"
  tasks: 2
  files: 16
actuals:
  tokens: 10100
  tasks: 2
  commits: 3
---

# Phase 3 Plan 04: Live subscriptions follow channel membership Summary

When someone is removed from a private channel, or leaves it, their open tab stops receiving it within milliseconds. The Phase 2 resolver makes that decision through the channel's topic authorizer. The tab then says "You no longer have access to #name", and the others see that person leave the header. Removal from a public channel keeps the read-only preview, exactly as REST does (D-06). Re-decisions are race-free, a database hiccup never cuts a legitimate stream, and bursts of changes cost a bounded number of decisions.

## What was built

- **Contracts:** a new ServerFrame `revoked { topic, reason: "forbidden" }`, plus the `RevokedFrame` type.
- **Realtime service:**
  - `registerSubscriptionInvalidator(eventType, fn)` registers one invalidator per durable event type; the last one registered wins.
  - `appendEvent` computes the invalidator's scope inside the transaction. A throwing invalidator is logged and ignored, so it never fails the domain write. In the same after-commit callback the service publishes the frame first, then `{ organizationId, userIds?, topics? }` on `ocw:realtime:authz-invalidated`.
  - `invalidateSubscriptions` publishes immediately.
  - `onSubscriptionInvalidation` parses defensively: the organization id must be a UUID, and the optional lists must be arrays of strings.
  - `reauthorizeTopic` returns `allowed`, `denied` or `error`; a throwing authorizer gives `error`.
  - `authorizeTopic` (new subscribes) is unchanged and still denies on error.
- **Chat:** an invalidator for `conversation.member_removed`. On `conv:` topics with a user member it returns `{ userIds: [member], topics: [topic] }`; the `user:` copy of the event and agent members return null. The payload is validated with Zod.
- **Gateway:**
  - It subscribes to invalidations lazily, awaited in `onRequest` next to revocations, and stops in `onClose`.
  - **Matching:** only connections in the same organization, in `userIds`, on topics in `topics` (an absent field matches everything).
  - **Re-decision:** goes through a queue with at most 4 in flight, coalesced per (connection, topic). A waiting job is not queued twice; a running job re-runs once.
  - **Outcomes:** `denied` → `unsub` (leaves presence) + `revoked` frame + info log with topic and user id. `error` → keep the subscription + warn log. A subscription that was replaced or removed meanwhile → nothing.
  - **`authzEpoch` per connection:** every matching invalidation bumps it. A subscribe that read an older epoch is re-decided once it is live (after `subscribed` and the presence snapshot).
  - **Per-topic subscribe generation:** a decision that finishes after a newer `sub`/`unsub` for the same topic is dropped (deviation 1).
- **Client:**
  - `subscribe(..., { onRevoked })` keeps a set of revoke callbacks per topic.
  - A `revoked` frame for a known topic deletes the topic and its presence and calls each callback once. No `unsub` is sent, and the topic is not resubscribed after a reconnect.
  - A stale unsubscribe closure is a no-op.
- **Web:**
  - `useTopic` gains `opts.onRevoked`, held in a ref like `onResync`.
  - When revoked, the channel view renders a Lock `EmptyState` (`channel-access-lost`) with the title "You no longer have access to #name", the planned description and "Back to channels". It also invalidates the channels list and this channel's queries, removes the messages query, and stops subscribing.
  - The view sets `leavingRef` right before `leave.mutate` and clears it on error. Your own leave is never shown as lost access.

## Observed revocation latencies

| Path | Measured |
|---|---|
| Integration: admin DELETE member → Sam's `revoked` (includes the HTTP request) | 10–17 ms (4 runs) |
| Integration: same removal → admin sees Sam's `offline` presence delta | 10–17 ms |
| Integration: Sam POST /leave → `revoked` | 12–13 ms |
| Integration: in-flight subscribe released → `revoked` after its re-decision | 9–11 ms |
| Integration: storm of 50 invalidations → re-decisions for the subscription | 2 (bound 2), in every run |
| E2E: admin removes Sam → `channel-access-lost` visible in Sam's tab | desktop 52 / 20 / 38 ms, mobile 44 / 36 / 36 ms (3 runs, bound 3 s) |

## Screenshots (reviewed with Read; verdict: clean)

All four are in `.planning/phases/03-realtime-presence-and-latency/screenshots/`: `access-lost-channel-1440.png`, `access-lost-channel-1440-dark.png`, `access-lost-channel-390.png`, `access-lost-channel-390-dark.png`.

- **1440:** centred in the content column, with the Lock tile, a bold title and three balanced lines of muted copy. The primary "Back to channels" button is clearly visible. The header shows the channel name muted with a lock, and the sidebar already dropped the channel. Both themes read well.
- **390:** the long title wraps after the hyphen, the copy stays within the margins, and the button sits well above the fold. Dark mode contrast is good.

## Verification

- `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/client.test.ts`: 2 files, 45 passed. The new contract and client tests were RED first.
- `pnpm exec vitest run --project integration apps/api/src/realtime-reauth.int.test.ts apps/api/src/modules/chat/chat.int.test.ts`: 2 files, 29 passed after Task 1.
- `pnpm exec vitest run --project integration apps/api/src/realtime-reauth.int.test.ts apps/api/src/realtime-presence.int.test.ts apps/api/src/identity.int.test.ts`: 3 files, **24 passed** (final). `realtime-reauth` was also run 3 more times on its own, 5/5 each time.
- `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh realtime-access chat.spec`: 5 passed (setup + chat + realtime-access on desktop and mobile). It produced the 4 `access-lost-channel-*` screenshots.
- `pnpm verify`: exit 0 before each commit; the final run was 59 files / **586 tests** passed.
- `pnpm --filter @ocw/local-runtime test` 113 passed · `@ocw/desktop` 58 passed · `@ocw/openclaw-channel` 51 passed.
- Full `bash scripts/e2e-isolated.sh`:
  - First run: 40 passed and 1 failed (`presence.spec` desktop). That failure led to deviation 1.
  - After the fix: **41 passed** (2.3 min), none flaky or skipped.
  - API log: 0 "without a permission decision" lines, 0 5xx, 0 re-decision warnings, 3 `live subscription revoked` info lines.
- Re-run of `bash scripts/e2e-isolated.sh presence realtime-access`: 7 passed.
- Demo untouched: `localhost:4000/health` and `localhost:3000/login` answered 200 before and after. No compose, migrate or demo command was run outside the isolated script.
- Acceptance greps:
  - `registerSubscriptionInvalidator` appears in service.ts and chat/index.ts.
  - `reauthorizeTopic`, `"revoked"` and `authzEpoch` appear in gateway.ts.
  - `ocw:realtime:authz-invalidated` appears in service.ts.
  - `onRevoked` appears in client.ts, realtime.tsx and channel-view.tsx.
  - `channel-access-lost` appears in channel-view.tsx and the spec.
  - There are 4 `access-lost-channel-*` screenshots.
  - The test titles include in-flight, transient, storm and scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two overlapping `sub` frames for one topic: the older decision could overwrite the newer subscription**
- **Found during:** plan-level verification (the first full e2e run, `presence.spec` on desktop).
- **What failed:** the admin's header never showed Sam, while Sam saw the admin as here.
- **Root cause:**
  - The sidebar's background `ChannelWatcher` and the channel view subscribe to the same `conv:` topic almost at once (a plain `sub`, then a `sub` with `presence: true`).
  - The gateway's `subscribe` awaited `authorizeTopic` and then wrote `subs.set(topic, …)` without checking whether a newer frame had arrived meanwhile. If the older, non-presence decision finished last, it replaced the presence subscription.
  - The replaced subscription had already joined presence, so the admin was listed for others. The live subscription, though, did not forward presence frames.
  - Its Redis listener and presence entry were orphaned until the socket closed or the TTL expired.
  - Through the same race, an `unsub` arriving mid-decision could be undone, leaving a ghost "here".
- **Status before this plan:** the race existed since 03-01. This run surfaced it, it is in the gateway this plan changes, and it interacts with re-decisions (a re-decision must act on the subscription that is really live).
- **Fix:** a per-topic generation, bumped by every `sub` and `unsub` frame. A decision that finishes after a newer frame for its topic is dropped.
- **Test:** a deterministic integration test on the controlled gateway, RED before the fix. It covers an older held sub released after a presence sub, and an unsub sent mid-decision.
- **Files:** apps/api/src/modules/realtime/gateway.ts, apps/api/src/realtime-reauth.int.test.ts
- **Commit:** ae0d1df

**2. [Interface] `onRevoked` lives in `useTopic`'s fifth argument, not a new positional one**
- **Why:** 03-01 already made the fifth argument `opts: { presence }`. `opts.onRevoked` keeps call sites readable and matches the plan's intent.
- **Commit:** e2041ed

**3. [Rule 2 - Correctness] A stale unsubscribe closure no longer touches a fresh subscription**
- **Issue:** after a revoke, a later `subscribe` to the same topic creates new topic state. The old component's unsubscribe would then have removed the new listener, decremented the new presence count, and possibly sent `unsub` for it.
- **Fix:** the closure compares its own state object with the current one. This is covered in the client unit test, which the plan's "a later subscribe starts fresh" behaviour requires.
- **Commit:** e2041ed

### Process notes
- **TDD:**
  - Contract, client, Task 1 integration and Task 2 integration tests (in-flight, storm) were RED first.
  - `transient` and `scope` passed on first run, because Task 1's tri-state verdict and organization/user filter already implemented them.
  - The e2e spec was not run RED on its own; its first run after the implementation passed in both projects.
- **Screenshots:** the chat and setup specs also wrote screenshots into the phase directory during the screenshot run. They were deleted rather than committed.
- **Process:**
  - Commits are on `wt/03-04`. Nothing was pushed.
  - STATE.md and ROADMAP.md were not edited, as instructed.
  - No files of 03-05 were touched.
- **Residual risk (accepted):**
  - An invalidation lost by Redis (an outage between publish and delivery) is not re-decided until the next invalidation, or until the periodic backstop that 03-06 adds.
  - The `revoked` frame tells the client only about topics it subscribed itself (T-03-04-07).

## Threat model status

| Threat | Status |
|---|---|
| T-03-04-01 EoP, live sub after removal | Mitigated. The invalidator → resolver re-decision → `revoked` path takes ≤ 17 ms in integration and ≤ 52 ms in e2e. Covered by the integration and e2e tests. |
| T-03-04-02 EoP, subscribe racing a removal | Mitigated. `authzEpoch` triggers a re-decision once the subscription is live (deterministic in-flight test). The per-topic generation also closes the overlapping-sub variant. |
| T-03-04-03 Tampering, forged invalidations | Accepted as planned. Invalidations only trigger resolver decisions; parsing is defensive and filtered by organization id (scope test). |
| T-03-04-04 DoS, storms | Mitigated. Coalescing per (connection, topic) and 4 in flight: 50 invalidations → 2 decisions (storm test). |
| T-03-04-05 DoS, transient DB errors | Mitigated. "error" keeps the subscription (transient test), and new subscribes still deny on error. |
| T-03-04-06 Repudiation | Accepted. The cause is audited in its own transaction, and each drop is logged at info with topic and user id (no payloads). |
| T-03-04-07 Information disclosure | Accepted. The frame names only the subscriber's own topic. |

## Known Stubs

None.

## Self-Check: PASSED

- Files exist: apps/api/src/realtime-reauth.int.test.ts, e2e/tests/realtime-access.spec.ts, 4 × access-lost-channel-*.png
- Commits exist: e2041ed, ca73903, ae0d1df
