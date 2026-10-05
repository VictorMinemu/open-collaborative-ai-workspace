---
phase: 03-realtime-presence-and-latency
verified: 2026-10-05T00:30:00Z
status: passed
score: 3/3 roadmap success criteria verified (26/26 merged must-have truths)
behavior_unverified: 0
overrides_applied: 0
---

# Phase 3: Realtime Presence and Latency Verification Report

**Phase Goal:** Subscriptions follow membership, collaborative events reach other connected clients in under 500 ms on the compose stack, and people see who is online in each conversation, on top of the Phase 1 WebSocket, seq replay, shared realtime client and typing indicators.
**Verified:** 2026-10-05 (local 2026-10-04 19:17–19:35)
**Status:** passed
**Re-verification:** No (initial verification)

Everything below comes from code I read and commands I ran myself on `feat/phase-3-realtime-presence` at `2d265d6`. SUMMARY claims were checked against the code, not taken on trust.

## Commands run by the verifier

| Command | Result |
|---|---|
| `pnpm verify` | exit 0. Biome: 4 warnings, all in `apps/local-runtime` (`useOptionalChain`, pre-existing). Turbo typecheck 8/8. Vitest **59 files / 591 tests passed** (98.7 s). The integration project collects `realtime-reauth.int.test.ts` + `realtime-presence.int.test.ts` (19 tests, checked with `vitest list`). |
| `bash scripts/e2e-isolated.sh` (full, no screenshot dir) | exit 0. **42 passed, 1 skipped** (`[mobile] realtime-latency`, skipped by design), 3.0 min |
| API log of that run | 0 "without a permission decision", 0 × 5xx, 0 × 429, 0 "re-decision failed", 0 presence join/leave/refresh/sweep errors, 8 "live subscription revoked" (the expected ones) |
| `e2e/test-results/realtime-latency.json` (generated 2026-10-05T00:21:42Z) | message n=30 p50 12.9 / p95 19.6 / max 20.8 ms; typing n=6 p50 2.9 / p95 4.3 / max 4.3 ms; presence n=20 p50 2.4 / p95 4.6 / max 4.8 ms (budget 500 ms) |
| `pnpm --filter @ocw/local-runtime test` / `@ocw/desktop` / `@ocw/openclaw-channel` | 113 / 58 / 51 passed, all exit 0 |
| Demo safety | `localhost:4000/health` 200 and `localhost:3000/login` 200 before and after; `ocw-demo-openclaw`, compose postgres and redis kept their uptimes; no compose/demo command run; `git status` clean apart from the other agent's `03.1-*` files |

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|---|---|---|
| SC1 | An automated test against the compose stack measures typical propagation of collaborative events between two connected clients under 500 ms | ✓ VERIFIED | `e2e/tests/realtime-latency.spec.ts:189`. Two real browsers, in-page timestamps on both ends (`performance.timeOrigin + performance.now()`, lines 74–110 and 120–160), sequential samples, warm-up discarded. It asserts `n` = planned and p50/p95 `< LATENCY_BUDGET_MS = 500` for message, typing and presence (lines 320–331), and writes the report before asserting. My run: p95 ≤ 19.6 ms. It runs against compose PostgreSQL + Redis: locally through the isolated script (DB `ocw_e2e`, Redis DB 9 of the compose services), and in CI in the `e2e` job (`docker compose up -d --wait postgres redis` + `pnpm e2e`, `.github/workflows/ci.yml:55,63`). The report is uploaded `if: always()` as artifact `realtime-latency` (ci.yml:64–71). |
| SC2 | Presence (online/away) for other connected users appears per conversation and expires automatically when a client disappears; Phase 1 typing indicators keep expiring the same way | ✓ VERIFIED | **Store:** `apps/api/src/modules/realtime/presence.ts`, a Redis ZSET per (org, topic) scored by expiry. Join, leave and setState each run as one MULTI with an in-transaction PUBLISH; plus `refresh` and `sweep`. **Gateway:** `gateway.ts:111–145` runs a heartbeat that pings and terminates dead sockets, refreshes entries and sweeps crashed-instance entries. Presence joins happen only after `subscribed` (467). The away op is rate-limited (360–382). **Tests:** `realtime-presence.int.test.ts` covers "dead peer (no pong) is terminated within two heartbeats and announced offline", "entries of a crashed instance are swept once…", the away op and the rate limit. **Client:** `activity.test.ts` covers the 5-minute idle and hidden-tab cases. **Web:** `channel-view.tsx:237` uses `{ presence: true }`, with the stack at 424; `members-dialog.tsx:129`; WZ header `session-view.tsx:281`. **E2E** (this run, both projects): `presence.spec.ts` covers here now, the members dialog, a closed tab gone within 3 s, and **typing shown then cleared within 7 s** (lines 63–70). `presence-away.spec.ts` covers away and online. `work-zone.spec.ts` covers the viewers stack and the viewer gone within 3 s. |
| SC3 | A client loses a subscription automatically when its membership is removed (leaving or being removed from a channel, losing access to a Work Zone session), with authorisation resolved through the Phase 2 `resolveEffectivePermissions` resolver | ✓ VERIFIED | **Invalidators** are registered for `conversation.member_removed` (`chat/index.ts:135`) and for `member.updated` role/status, `units.updated` and `permission_rules.updated` (`organization/index.ts:84–98`). They are published after commit (`service.ts:208–214`). The gateway re-decides through `reauthorizeTopic`, which calls the same topic authorizers (`service.ts:245`, `gateway.ts:169–182`). Those authorizers call `perms.decide` (`chat/index.ts:117`, `work-session/index.ts:28`), and `perms.decide` calls `decide()`, which calls `resolveEffectivePermissions` (`permissions/resolve.ts:267–275`). **Outcomes:** a denied re-decision unsubscribes, leaves presence and sends `revoked`; an error keeps the subscription (fail-safe). **Races** are handled with `authzEpoch` (404/469) and a per-topic generation (295–300, 406). **Backstop:** the 5-minute recheck re-decides every live subscription (351). **Tests:** `realtime-reauth.int.test.ts` covers removal from a private channel, the public preview kept, leave, in-flight, transient, storm, scope, latest-wins, deny rule, unit change, profile-only no-op and the backstop. `workzone.int.test.ts:779` covers "a role downgrade revokes a live Work Zone stream within a second". **E2E** (this run): `realtime-access.spec.ts` shows access-lost after 19 ms on desktop and 37 ms on mobile, and leaving is quiet. `work-zone.spec.ts:145–158` shows `session-access-lost` after a demotion, with the row removed from the list. |

### Plan must-have truths (merged, 03-01 … 03-06)

All 26 plan truths are covered by the evidence above. Notable checks:

| Plan truth | Status | Evidence |
|---|---|---|
| Only resolver-authorised subscriptions appear in or receive presence; `conn` is random, never the sid | ✓ | `gateway.ts:321` `randomUUID()`; presence joins only after `authorizeTopic` + `subscribed`; int "a non-member of a private channel is refused and never appears…", "conn is not the session id" |
| Background watchers are not "here" | ✓ | `sub.presence` opt-in (`gateway.ts:423`); int "a background subscription (no presence flag) is not 'here'…" |
| Away frame changes only the sender's own connection | ✓ | the `presence` ClientFrame carries only `state`; `setOwnState` iterates this socket's subs only (`gateway.ts:360–382`) |
| Reconnect / 4401 refresh / exactly-once replay still work | ✓ | `identity.int.test.ts` WS cases inside the 591 green tests; full e2e green |
| Public channel removal keeps the read-only preview (D-06) | ✓ | `realtime-reauth.int.test.ts:166–178` |
| ADR-0009 and DEMO notes exist | ✓ | `docs/adr/0009-realtime-presence-and-live-reauthorization.md` (Status/Date, Context, Decision, Consequences, Alternatives); `docs/DEMO.md:74` "Presence and live access" |
| Phase gate green | ✓ | rerun by the verifier (table above) |

**Score:** 3/3 success criteria; 26/26 plan truths; 0 present-but-behaviour-unverified. Every state-transition truth (revocation, expiry, away, races, backstop) is exercised by a named passing test.

### Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `apps/api/src/modules/realtime/presence.ts` | ✓ VERIFIED | 172 lines, real Redis MULTI logic; used by gateway |
| `apps/api/src/modules/realtime/gateway.ts` | ✓ VERIFIED | heartbeat, presence, away limiter, re-decision queue, epoch, generation, backstop |
| `apps/api/src/modules/realtime/service.ts` | ✓ VERIFIED | invalidator registry, `AUTHZ_INVALIDATION_CHANNEL`, `reauthorizeTopic` tri-state |
| `packages/contracts/src/realtime.ts` | ✓ VERIFIED | presence / revoked frames, `presence` op, constants |
| `packages/realtime-client/src/{client,presence,activity}.ts` | ✓ VERIFIED | revoked handling `client.ts:422–430`, presence store, away monitor |
| `apps/web/components/presence/presence-stack.tsx`, `lib/realtime.tsx`, `lib/use-live-session.ts` | ✓ VERIFIED | wired into channel header, members dialog, WZ header; activity reporter on `visibilitychange` |
| Tests: `realtime-presence.int.test.ts`, `realtime-reauth.int.test.ts`, `presence.spec.ts`, `presence-away.spec.ts`, `realtime-access.spec.ts`, `realtime-latency.spec.ts` | ✓ VERIFIED | all ran green in this verification |
| `docs/adr/0009-…md`, `docs/DEMO.md` | ✓ VERIFIED | present and substantive |

### Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| chat/organization domain writes | gateway re-decision | `appendEvent` → invalidator → after-commit publish on `ocw:realtime:authz-invalidated` → `onSubscriptionInvalidation` | WIRED |
| gateway re-decision | `resolveEffectivePermissions` | `reauthorizeTopic` → `conv`/`ws`/`org`/`user` authorizer → `perms.decide` → `decide()` | WIRED |
| gateway `revoked` frame | web access-lost views | client `onRevoked` → `useTopic` opts → `channel-access-lost` / `session-access-lost` | WIRED (e2e proven) |
| presence store deltas | web avatars | `topicChannel` publish → gateway forwards on presence subs → `client.presence` → `usePresence` / `usePresentPeople` | WIRED (e2e proven) |
| tab visibility / input | server presence state | `createActivityMonitor` → `client.setPresence` → `presence` op → `setState` | WIRED (e2e proven) |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|---|---|---|---|---|
| PresenceStack (channel header, WZ header) | `usePresentPeople(topic)` | Redis ZSET snapshot + deltas via `/ws` | yes (e2e asserts other user's id/state) | ✓ FLOWING |
| Members dialog presence | `usePresence("conv:<id>")` | same | yes (`data-state` online/offline asserted) | ✓ FLOWING |
| Access-lost views | `revoked` frame | gateway re-decision via resolver | yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| RT-03 budget | `bash scripts/e2e-isolated.sh` (latency spec inside) | p95 message 19.6, typing 4.3, presence 4.6 ms | ✓ PASS |
| Channel revocation | same run, `realtime-access.spec.ts` | access-lost after 19 ms (desktop) / 37 ms (mobile) | ✓ PASS |
| Away propagation | same run, `presence-away.spec.ts` | desktop away 8 ms / online 11 ms; mobile away 27 ms / online 508 ms (see note) | ✓ PASS |
| Integration (presence, reauth, WZ downgrade, backstop) | `pnpm verify` | 591/591 | ✓ PASS |

### Probe Execution

Step 7c: SKIPPED. The phase declares no `scripts/*/tests/probe-*.sh` probes.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| RT-01 one authenticated WS; topics authorised; re-evaluated on membership change | 03-04, 03-06 | ✓ SATISFIED | SC3 evidence |
| RT-03 typical propagation < 500 ms, automated test against the compose stack | 03-05 | ✓ SATISFIED | SC1 evidence |
| RT-04 presence (online/away) and typing per conversation, expiring when a client disappears | 03-01, 03-02, 03-03 | ✓ SATISFIED | SC2 evidence |

No orphaned requirements: REQUIREMENTS.md maps only RT-01, RT-03 and RT-04 to Phase 3. Its checkboxes and traceability rows (lines 71–74, 327–330) still read Partial/Pending. They should be updated when the phase completes; that belongs to the orchestrator, not this verifier.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (41 code/doc files changed since `4490038`) | — | TBD/FIXME/XXX, TODO/HACK/PLACEHOLDER, `@ts-ignore`, `any` | none found | — |
| `apps/local-runtime/src/{claude,codex}/detect.ts` | 58 / 26 | Biome `useOptionalChain` warnings | ℹ️ Info | pre-existing, not touched in this phase |

### Human Verification

None is outstanding.

- **Visual quality** (`<human-check>` items in 03-01/02/03/04/06): 03-06 records that the owner delegated sign-off to an agent PNG review. The executor reviewed all 24 captures. I also opened `presence-header-1440`, `presence-away-390-dark`, `presence-members-1440`, `workzone-presence-390`, `access-lost-channel-390-dark` and `access-lost-session-1440`. All were clean: dots readable, nothing clipped at 390, the access-lost states are calm and have a primary CTA, and the revoked session is gone from the list.
- **Follow-ups (non-blocking, not success criteria):**
  - The first CI `realtime-latency` artifact appears once the phase PR runs. The same spec passed locally here against compose PostgreSQL/Redis.
  - The optional real-laptop-sleep check is covered at the protocol level by the `autoPong: false` integration test.

### Notes (informational, no gap)

1. **"Compose stack" interpretation.** The latency test drives the API and web as host processes on compose PostgreSQL + Redis, not the `api` / `web` compose containers. This was decided on purpose and documented (03-01-PLAN D-07, Research note 9). The code is the same and the margin is more than 25×. Containerised measurement can come with Phase 7's `docker compose up` E2E.
2. **Mobile away → online took 508 ms** in `presence-away.spec.ts`. This is the designed 500 ms client presence throttle (`PRESENCE_CLIENT_THROTTLE_MS`). The spec flipped back inside the throttle window, so the trailing send fired at the window edge. The RT-03 spec spaces presence samples 600 ms apart and measures "typical" propagation (p95 4.6 ms). This does not breach the requirement, but a fast flip-back can take up to about 500 ms by design.
3. **Device revocation has no invalidator.** `work_session.read` is not device-gated (`policy.ts:38–42`), so revoking a device does not remove read access, and no live-stream change is needed. Any future change to that rule is still caught by the 5-minute backstop.
4. **`03-VALIDATION.md` is still `status: draft`** with per-task rows `⬜ pending`. That is bookkeeping for `/gsd-validate-phase`, not a code gap.

### Gaps Summary

None. All three roadmap success criteria and every plan must-have hold in the code. I reproduced them with `pnpm verify` (591/591), the full isolated e2e (42 passed, 1 skipped by design), the three package suites, and a latency report with every p95 at or below 19.6 ms against a 500 ms budget.

---

_Verified: 2026-10-05T00:30:00Z_
_Verifier: Claude (gsd-verifier)_
