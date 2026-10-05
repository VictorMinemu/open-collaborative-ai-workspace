---
phase: 03-realtime-presence-and-latency
plan: 06
subsystem: realtime
status: complete
tags: [realtime, authz, rt-01, rt-03, rt-04, revocation, backstop, adr, phase-gate]
requires:
  - 03-04 re-decision engine (registerSubscriptionInvalidator, reauthorizeTopic, gateway queue, revoked frame, useTopic opts.onRevoked)
  - 03-05 latency spec and CI artifact
provides:
  - organization invalidators for member.updated (role/status), units.updated, permission_rules.updated
  - per-socket recheck re-decides every live subscription (lost-invalidation backstop)
  - Work Zone access-lost state (`session-access-lost`), useLiveSession `revoked` / `lostTitle`
  - useWorkSession(id, { enabled })
  - members dialog lists the channel's people and bots before "Add to channel"
  - ADR-0009, DEMO.md "Presence and live access"
affects: [phase-3 exit, 03.1]
tech-stack:
  added: []
  patterns:
    - "Every authz-affecting durable event registers an invalidator; scope = one user (role/status) or the whole organization (rules, units)"
    - "The 5-minute socket recheck doubles as a re-decision sweep through the same coalesced queue"
    - "A revoked view removes its cached detail, disables the query and filters the row out of cached lists (refetch may 403)"
key-files:
  created:
    - docs/adr/0009-realtime-presence-and-live-reauthorization.md
    - .planning/phases/03-realtime-presence-and-latency/screenshots/access-lost-session-{1440,1440-dark,390,390-dark}.png
  modified:
    - apps/api/src/modules/organization/index.ts
    - apps/api/src/modules/realtime/gateway.ts
    - apps/api/src/realtime-reauth.int.test.ts
    - apps/api/src/workzone.int.test.ts
    - apps/web/lib/use-live-session.ts
    - apps/web/lib/workzone-queries.ts
    - apps/web/components/work-zone/session-view.tsx
    - apps/web/components/chat/members-dialog.tsx
    - e2e/tests/work-zone.spec.ts
    - e2e/tests/presence.spec.ts
    - docs/DEMO.md
decisions:
  - "units.updated and permission_rules.updated re-decide the whole organization (rules can name a role or everyone; unit changes affect everyone below the unit); member.updated only when changed includes role or status"
  - "The recheck schedules re-decisions only after the session and member check passes; 4401 behaviour unchanged"
  - "The Work Zone access-lost state mirrors the channel one: PageHeader with muted title + Lock, EmptyState, primary Back to Work Zone"
  - "Members dialog order: People, Bots, then Add to channel (found in screenshot review)"
metrics:
  duration: "~95 min"
  completed: "2026-10-04"
  tasks: 3
  files: 13
actuals:
  tokens: 11000
  tasks: 3
  commits: 6
---

# Phase 3 Plan 06: Every access change re-decides live streams, plus ADR-0009 and the phase gate Summary

Any change that can take read access away now cuts the affected live stream within milliseconds, through the Phase 2 resolver. That covers role and status changes, explicit rules, and unit memberships or moves. The 5-minute socket recheck also re-decides every live subscription, so a lost Redis message cannot leave a stream open beyond one interval. A Work Zone viewer who loses access sees "You no longer have access to this session", and the session leaves their list. ADR-0009 and the demo notes record the design. The phase gate is green.

## What was built

- **Organization invalidators** (`organization/index.ts`, 3 × `registerSubscriptionInvalidator`). Payloads are Zod-validated and only `org:` topics are accepted.

  | Event | Invalidates |
  |---|---|
  | `member.updated` with `role` or `status` | that user (`{ userIds: [userId] }`) |
  | `member.updated` with profile fields only | nothing (`null`) |
  | `units.updated` | the whole organization (`{}`) |
  | `permission_rules.updated` | the whole organization (`{}`) |

- **Backstop** (`gateway.ts`): on each per-socket recheck tick, once the session and member check passes, `scheduleReauth(conn, topic)` runs for every live subscription. It uses the 03-04 queue, with its coalescing and 4 concurrent decisions.
- **Web:**
  - `useLiveSession` passes `onRevoked` into `useTopic("ws:<id>", …)` and keeps a per-id `revoked` flag, which resets when the id changes.
  - On revoke it removes the `wzKeys.session(id)` query and disables it. It also filters the session out of the cached `wzKeys.sessions` list and invalidates that list, and keeps the title for the header.
  - `SessionView` renders `session-access-lost`: a header with the muted title and a Lock, an EmptyState titled "You no longer have access to this session" with "Your role or permissions changed. Ask an admin if you need it back.", and a primary "Back to Work Zone" link.
- **Docs:**
  - ADR-0009 (Status, Date, Deciders, Context, Decision D-01 … D-09 with the measured numbers, Consequences, Alternatives).
  - DEMO.md "Presence and live access": here now, away, losing a private channel, losing a Work Zone session, and where the latency artifact lives.

## Observed revocation latencies (this plan)

| Path | Measured |
|---|---|
| Integration: admin PATCH role developer → standard → alex's `ws:` `revoked` | 16 ms |
| Integration: explicit deny on `channel.read` for Sam → `revoked` | 16 ms |
| Integration: silent `conversation_members` delete (no event) → `revoked` by the 200 ms recheck | 91 ms |
| Integration: unit membership added → Sam's 2 subscriptions re-decided, both `allowed`, messages keep flowing | < 1 s, 0 revoked |
| Integration: profile-only update (`statusText`) → re-decisions | 0 |
| E2E: Sam demoted while watching → `session-access-lost` visible | within the 3 s assertion, desktop and mobile |

## Phase gate (final code, in plan order)

| Check | Result |
|---|---|
| `pnpm verify` | exit 0. Turbo 8/8 tasks; Vitest **59 files / 591 tests** passed (586 after 03-04, +5 new) |
| `pnpm --filter @ocw/local-runtime test` | exit 0, 9 files / **113** passed |
| `pnpm --filter @ocw/desktop test` | exit 0, 9 files / **58** passed |
| `pnpm --filter @ocw/openclaw-channel test` | exit 0, 6 files / **51** passed |
| Full isolated e2e (`OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh`) | exit 0. **42 passed, 1 skipped** (`[mobile] realtime-latency`, skipped by design), 0 failed, 0 flaky, 4.8 min |
| API log of that run | 0 "without a permission decision", 0 5xx, 0 429, 0 "re-decision failed", 8 "live subscription revoked" (expected ones) |
| Latency in the full run (p50 / p95 / max) | message 14.4 / 19 / 19 ms; typing 3.3 / 3.7 / 3.7 ms; presence 2.8 / 4.9 / 5 ms (budget 500) |
| Plan verify: `vitest --project integration` realtime-reauth, workzone, members, rules, units | 30/30 (reauth + workzone) and 37/37 (org suites + reauth) |
| Demo untouched | `localhost:4000/health` and `localhost:3000/login` answered 200 before and after every run. `ocw-demo-openclaw` and the compose postgres/redis stayed up (not recreated). No compose, migrate or `demo:*` command was run. |

An earlier full e2e run on the Task 1–2 code also passed (42 passed, 1 skipped, same log counts). Its screenshot review led to the fix in deviation 2. The final run above was done after that fix.

## Screenshots (24 kept, each opened with Read; verdict: clean)

`.planning/phases/03-realtime-presence-and-latency/screenshots/`, all from the final gate run:

- `presence-header-{1440,1440-dark,390,390-dark}.png`: Sam's avatar with a green dot left of the members chip; the "Here now · Sam Lee · Active" tooltip is fully visible at 1440; the title truncates first at 390.
- `presence-away-{1440,1440-dark,390,390-dark}.png`: amber dot, dimmed avatar, "Away" tooltip; no crowding at 390.
- `presence-members-{1440,1440-dark,390,390-dark}.png`: PEOPLE first (Sam and you with green dots and "· Active", Rio with no dot), then ADD TO CHANNEL. "3 members · 1 here now" in the description.
- `workzone-presence-{1440,1440-dark,390,390-dark}.png`: the viewer avatar with a green dot sits next to the Ready chip at 1440; at 390 it sits before the Queue/Changes buttons and the actions menu stays on screen.
- `access-lost-channel-{1440,1440-dark,390,390-dark}.png`: Lock tile, title wraps at the hyphen at 390, primary "Back to channels"; the sidebar has already dropped the channel.
- `access-lost-session-{1440,1440-dark,390,390-dark}.png`: same layout and tone as the channel state. The Work Zone list shows "No sessions yet." (the revoked row is gone), Sam's org role reads "Standard User" and the Work Zone nav item is gone.

Superseded captures from the e2e runs (setup, workzone-devices, workzone-session and others) were deleted, not committed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The revoked Work Zone session stayed in the session list**
- **Found during:** Task 2 screenshot review (first `access-lost-session-1440`).
- **Issue:** the invalidated `wzKeys.sessions` refetch is refused (403) once the role drops. TanStack keeps the stale data, so the sidebar still listed the session the page says you cannot see.
- **Fix:** `onRevoked` filters the session out of the cached list with `setQueryData`, then invalidates it. The spec asserts the row is gone on desktop.
- **Files:** apps/web/lib/use-live-session.ts, e2e/tests/work-zone.spec.ts
- **Commit:** de761de

**2. [Rule 1 - UX bug, pre-existing since Phase 1] Members dialog hid the channel's members in a populated organization**
- **Found during:** Task 3 screenshot review.
- **Issue:** the full e2e run fills the org with about 20 people. The dialog rendered up to 20 "Add to channel" candidates above PEOPLE, so the members and their presence dots were below the fold. The 03-03 capture had been taken on a near-empty org.
- **Fix:** the section order is now People, Bots, Add to channel (`mb-3 last:mb-0` on each). Nothing was removed.
- **Regression guard:** `presence.spec` asserts the present member's row `toBeInViewport()`.
- **Files:** apps/web/components/chat/members-dialog.tsx, e2e/tests/presence.spec.ts (the spec is outside the plan's file list; changed only to guard this fix)
- **Commit:** 5a1b2bc

**3. [Process] DEMO.md removes a member through the browser console**
- **Why:** the web has no "remove member from channel" action; removal exists only in the API.
- **Change:** the "Losing a private channel" step gives a 4-line console snippet (`fetch` with credentials) instead of a UI path.
- **Commit:** b4a88fe

### Observations (no code change)

- **Rendering artifact:** in the first full run, the light-mode `presence-away` captures showed Sam's dimmed avatar as a pure #FFFF00 blob with dithered edges. No app colour produces that: the avatar tint was violet, as in the members chip next to it, and dark mode was correct.
- **Not reproducible:** an isolated re-run and the final full run were clean. A pixel scan of all 24 final PNGs found no pure-yellow pixels. It was a headless Chromium compositing artifact on the `opacity-70` layer, not a product bug.
- **TDD:** RED was confirmed for the role-downgrade, deny-rule, unit and backstop tests (4 failed before the implementation). The profile-only test passed on RED, as expected for a negative assertion. Test and implementation have separate commits (79dc21e, d18bbca).
- **Process:** commits are on `feat/phase-3-realtime-presence` as instructed. Nothing was pushed. STATE.md and ROADMAP.md were not edited, and `.planning/phases/03.1-*` was not touched.

## Threat model status

| Threat | Status |
|---|---|
| T-03-06-01 EoP: Work Zone stream after a role downgrade | Mitigated. `member.updated` (role/status) invalidator → `ws` authorizer → `revoked` in 16 ms (integration). The e2e shows the access-lost state on both projects. |
| T-03-06-02 EoP: streams after a deny rule or unit change | Mitigated. Org-wide invalidation on `permission_rules.updated` and `units.updated`. Deny-rule test revokes in 16 ms; deleting the rule revokes nothing else. |
| T-03-06-03 EoP: lost invalidation | Mitigated. The recheck re-decides all live subscriptions; backstop test revokes in 91 ms at 200 ms. |
| T-03-06-04 DoS: org-wide re-decisions | Mitigated. 03-04 coalescing and the 4-concurrency limit; profile-only updates trigger 0 re-decisions (tested). |
| T-03-06-05 Information disclosure: ADR / DEMO.md | Accepted. Design and fixtures only; no secrets or hosts. |

## Known Stubs

None.

## Threat Flags

None. No new endpoint, auth path or schema; the client only reacts to an existing frame.

## Commits

- 79dc21e test(03-06): role, rule, unit and lost-message re-decisions of live subscriptions
- d18bbca feat(03-06): organization access changes and the periodic recheck re-decide live subscriptions
- de761de feat(03-06): an open Work Zone session shows when access is lost
- b4a88fe docs(03-06): ADR-0009 realtime presence and live re-authorisation; demo notes
- 5a1b2bc fix(03-06): channel members and who is here now come before Add to channel
- 430c0c1 docs(03-06): final phase 3 screenshot set from the gate run (24 captures)

## Self-Check: PASSED

- Files exist: docs/adr/0009-realtime-presence-and-live-reauthorization.md, docs/DEMO.md ("Presence and live access" at line 74), 24 PNGs including 4 × access-lost-session-*.
- Acceptance greps:
  - `registerSubscriptionInvalidator` appears 3 times in organization/index.ts.
  - `onRevoked` appears in use-live-session.ts.
  - `session-access-lost` appears in session-view.tsx and work-zone.spec.ts.
  - The ADR has 4 `## ` sections and contains Status, Context, Decision, Consequences and the p95 numbers.
- Commits exist: 79dc21e, d18bbca, de761de, b4a88fe, 5a1b2bc, 430c0c1.
