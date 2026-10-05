---
phase: "03"
slug: "realtime-presence-and-latency"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: complete
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-04"
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 03-01-PLAN.md §Decisions (D-01 … D-09) and §Research notes (no separate RESEARCH.md; research level "standard").

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.2 (root projects `unit`, `integration` — testcontainers PostgreSQL 18 + Redis 8, API listening on a random port); Playwright 1.63.0 (`setup` → `desktop` 1440×900 and `mobile` 390×844) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <path>` / `pnpm exec vitest run --project integration <path>` |
| **Full suite command** | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test && pnpm --filter @ocw/openclaw-channel test` |
| **E2E command** | `bash scripts/e2e-isolated.sh [spec filters] [--project=desktop]` — isolated stack (database `ocw_e2e`, Redis DB 9, API 127.0.0.1:4290, web 127.0.0.1:3290, machine-wide lock); never `pnpm e2e` against the demo |
| **Latency command (RT-03)** | `bash scripts/e2e-isolated.sh realtime-latency --project=desktop` → `e2e/test-results/realtime-latency.json`; in CI the same spec runs inside `pnpm e2e` of the e2e job and the report is uploaded as artifact `realtime-latency` |
| **Estimated runtime** | unit ≈ 20 s; one integration file ≈ 30–60 s; `pnpm verify` ≈ 6–10 min; one e2e spec ≈ 1–3 min including setup; full e2e ≈ 4–6 min |

---

## Sampling Rate

- **After every task commit:** the task's `<automated>` commands (unit tests of the touched package, the one integration file of the touched area, the touched e2e spec through the isolated script), then `pnpm verify`.
- **After every plan:** `pnpm verify`, the three package suites (local-runtime, desktop, openclaw-channel), and the full `bash scripts/e2e-isolated.sh`.
- **After every wave:** the full suite and the full isolated e2e.
- **Before `/gsd-verify-work 3`:** 03-06 Task 3 gate green; three green latency runs recorded (03-05); screenshots reviewed.
- **Max feedback latency:** ≈ 60 s per targeted vitest command; ≈ 3 min per targeted e2e spec.

---

## Isolated e2e stack and the owner's demo (hard rule, unchanged from Phase 2)

All e2e runs go through `scripts/e2e-isolated.sh` (body and rules in `.planning/phases/02-identity-and-organization/02-VALIDATION.md` § "Isolated e2e stack"). The owner's demo (database `ocw`, Redis DB 0, API :4000, web :3000, container `ocw-demo-openclaw`) is never stopped, recreated, migrated, reset or reseeded: no `docker compose down` / `rm` / `stop` / `restart`, no `pnpm demo:*`, no `pnpm db:migrate` with the default `.env`, nothing bound to :4000/:3000. Redis pub/sub is shared across logical databases: every channel this phase adds carries a UUID topic or is filtered by organization id (03-01 Research note 8). Screenshots: `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/03-realtime-presence-and-latency/screenshots` (create it with `mkdir -p`).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | RT-04 | T-03-01-01/02/03/07 | presence only after the resolver allowed the subscription; user id from the JWT; conn ≠ sid; typing still expires | unit + integration + e2e | `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/presence.test.ts packages/realtime-client/src/client.test.ts` · `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts apps/api/src/identity.int.test.ts` · `bash scripts/e2e-isolated.sh presence.spec` | ❌ created by the task (RED first): presence.test.ts, realtime-presence.int.test.ts, presence.spec.ts, e2e/support/actors.ts | ⬜ pending |
| 03-01-02 | 01 | 1 | RT-04 | T-03-01-04/05 | half-open sockets terminated; crashed-instance entries swept and announced; keys self-heal | integration | `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts` | ✅ extend (03-01-01) | ⬜ pending |
| 03-02-01 | 02 | 2 | RT-04 | T-03-02-01/03 | presence op applies only to the sender's own connection; Zod enum | unit + integration + e2e | `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/activity.test.ts packages/realtime-client/src/client.test.ts` · `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts` · `bash scripts/e2e-isolated.sh presence-away presence.spec` | ❌ created by the task: activity.test.ts, presence-away.spec.ts | ⬜ pending |
| 03-02-02 | 02 | 2 | RT-04 | T-03-02-02 | 30 changes / 10 s per socket, `rate_limited`; idle 5 min; state re-sent on reconnect | unit + integration | `pnpm exec vitest run --project unit packages/realtime-client/src/activity.test.ts packages/realtime-client/src/client.test.ts` · `pnpm exec vitest run --project integration apps/api/src/realtime-presence.int.test.ts` | ✅ extend | ⬜ pending |
| 03-03-01 | 03 | 2 | RT-04 | T-03-03-01/02 | member list shows presence of the authorised topic only; names from readable directories | e2e + visual | `bash scripts/e2e-isolated.sh presence.spec` (with screenshot dir) | ✅ extend (presence.spec.ts) | ⬜ pending |
| 03-03-02 | 03 | 2 | RT-04 | T-03-03-01 | Work Zone viewers from `ws:` presence | e2e + visual | `bash scripts/e2e-isolated.sh work-zone` (with screenshot dir) | ✅ extend (work-zone.spec.ts) | ⬜ pending |
| 03-04-01 | 04 | 3 | RT-01 | T-03-04-01/03/06/07 | removal from a private channel → `revoked` ≤ 1 s via the `conv` authorizer (resolver); public channel keeps preview; self-leave quiet | unit + integration + e2e | `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/realtime-client/src/client.test.ts` · `pnpm exec vitest run --project integration apps/api/src/realtime-reauth.int.test.ts apps/api/src/modules/chat/chat.int.test.ts` · `bash scripts/e2e-isolated.sh realtime-access chat.spec` | ❌ created by the task: realtime-reauth.int.test.ts, realtime-access.spec.ts | ⬜ pending |
| 03-04-02 | 04 | 3 | RT-01 | T-03-04-02/04/05 | in-flight subscribe re-decided (epoch); transient error keeps the stream; storms coalesced | integration (deterministic, controlled authorizer) | `pnpm exec vitest run --project integration apps/api/src/realtime-reauth.int.test.ts apps/api/src/realtime-presence.int.test.ts apps/api/src/identity.int.test.ts` | ✅ extend | ⬜ pending |
| 03-05-01 | 05 | 3 | RT-03 | T-03-05-02/03 | p50 and p95 < 500 ms for message, typing, presence between two real web clients; budget not weakened | e2e (desktop project) | `bash scripts/e2e-isolated.sh realtime-latency --project=desktop` · report check `node -e …` (03-05 Task 1) | ❌ created by the task: realtime-latency.spec.ts | ⬜ pending |
| 03-05-02 | 05 | 3 | RT-03 | T-03-05-01 | report uploaded on every CI run | static check | `node -e …` over `.github/workflows/ci.yml` (03-05 Task 2) · `pnpm lint` | ✅ extend (ci.yml) | ⬜ pending |
| 03-06-01 | 06 | 4 | RT-01 | T-03-06-01/02/03/04 | role downgrade, deny rule and unit change re-decided through the resolver; backstop catches lost messages | integration | `pnpm exec vitest run --project integration apps/api/src/realtime-reauth.int.test.ts apps/api/src/workzone.int.test.ts apps/api/src/modules/organization/members.int.test.ts apps/api/src/modules/organization/rules.int.test.ts apps/api/src/modules/organization/units.int.test.ts` | ✅ extend | ⬜ pending |
| 03-06-02 | 06 | 4 | RT-01 | T-03-06-01 | Work Zone access-lost state after a role downgrade | e2e + visual | `bash scripts/e2e-isolated.sh work-zone` (with screenshot dir) | ✅ extend | ⬜ pending |
| 03-06-03 | 06 | 4 | RT-01, RT-03, RT-04 | T-03-06-05 | phase gate: strict authz coverage, 0 undecided / 5xx / 429 in the e2e API log | full suite + full e2e | `pnpm verify && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/desktop test && pnpm --filter @ocw/openclaw-channel test` · `bash scripts/e2e-isolated.sh` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → plan coverage

| Requirement | Plans | Evidence at phase end |
|-------------|-------|-----------------------|
| RT-01 — one authenticated WebSocket; topics authorised; re-evaluated when membership changes | 03-04 (channels, race, fail-safe), 03-06 (roles, rules, units, Work Zone, backstop) | `realtime-reauth.int.test.ts`, `workzone.int.test.ts` role-downgrade case, `realtime-access.spec.ts`, `work-zone.spec.ts` access-lost |
| RT-03 — typical propagation < 500 ms, automated test against the compose stack | 03-05 | `realtime-latency.spec.ts` in CI e2e job (compose postgres + redis) and isolated stack; `realtime-latency` artifact; three local reports in 03-05-SUMMARY.md |
| RT-04 — presence (online/away) and typing per conversation, expiring when a client disappears | 03-01 (here now, expiry, typing regression), 03-02 (away), 03-03 (member list, Work Zone header) | `realtime-presence.int.test.ts`, `presence.test.ts`, `activity.test.ts`, `presence.spec.ts`, `presence-away.spec.ts`, `work-zone.spec.ts` viewers |

### Success criterion → evidence

| ROADMAP Phase 3 SC | Evidence |
|---|---|
| SC1 latency test against the compose stack < 500 ms | 03-05 Task 1 (p50 and p95 per kind), CI artifact |
| SC2 presence per conversation, expiring; typing keeps expiring | 03-01 Tasks 1–2, 03-02, 03-03 |
| SC3 subscription lost on membership removal (channel leave/remove, Work Zone access), via the resolver | 03-04 Tasks 1–2, 03-06 Tasks 1–2 |

---

## Wave 0 Requirements

No separate Wave 0 plan: every new test file is created by the task that needs it, test-first (RED before GREEN), and listed in that task's `<files>`:

- [ ] `packages/realtime-client/src/presence.test.ts`, `apps/api/src/realtime-presence.int.test.ts`, `e2e/support/actors.ts`, `e2e/tests/presence.spec.ts` — 03-01 Task 1
- [ ] `packages/realtime-client/src/activity.test.ts`, `e2e/tests/presence-away.spec.ts` — 03-02 Task 1
- [ ] `apps/api/src/realtime-reauth.int.test.ts`, `e2e/tests/realtime-access.spec.ts` — 03-04 Task 1
- [ ] `e2e/tests/realtime-latency.spec.ts` — 03-05 Task 1

Existing infrastructure covers the rest (vitest projects, testcontainers, `scripts/e2e-isolated.sh`, Playwright projects, `shot()` helper).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual quality of presence (header, member list, Work Zone header, Away) and access-lost states at 390/1440, light/dark | RT-04, RT-01 | Visual polish cannot be grepped | Open `screenshots/presence-*.png`, `workzone-presence-*.png`, `access-lost-*.png`; harvested from each UI task's `<human-check>` and re-checked in 03-06 Task 3 |
| A real laptop going to sleep disappears from a colleague's view within ~30 s (optional) | RT-04 | OS sleep cannot be driven in CI; the `autoPong: false` integration test covers the protocol path | With two machines on the demo, open the same channel, close the lid of one; the other sees the person leave the header within ~30 s |
| First CI evidence of RT-03 | RT-03 | The branch is not pushed during this phase (another PR on it is in CI) | When the phase PR runs, download the `realtime-latency` artifact of the e2e job and compare with the local numbers in 03-05-SUMMARY.md |

---

## Artifacts this phase produces

- **Contracts:** presence frame, entry and state enums, `isPresenceTopic`, client `presence` op, `AWAY_AFTER_IDLE_MS`, `PRESENCE_CLIENT_THROTTLE_MS`, `revoked` frame (`packages/contracts/src/realtime.ts`).
- **API:** `apps/api/src/modules/realtime/presence.ts`; gateway Connection registry, presence join/leave/snapshot, heartbeat, sweep, ping liveness, away op with rate cap, re-decision queue with authz epoch and periodic backstop; realtime service invalidation API (`ocw:realtime:authz-invalidated`, `reauthorizeTopic`); invalidators in `chat/index.ts` and `organization/index.ts`.
- **Realtime client:** `presence.ts` (reducer, aggregation), `activity.ts` (away monitor), `client.presence`, `setPresence`, `revoked` handling with `onRevoked`.
- **Web:** `usePresence`, presence reporter in `RealtimeProvider`, `components/presence/presence-stack.tsx`; presence in the channel header, members dialog and Work Zone session header; access-lost states in the channel view and the Work Zone session.
- **Tests / E2E:** `realtime-presence.int.test.ts`, `realtime-reauth.int.test.ts`, new `workzone.int.test.ts` cases, unit tests; `presence.spec.ts`, `presence-away.spec.ts`, `realtime-access.spec.ts`, `realtime-latency.spec.ts`, extended `work-zone.spec.ts`; `e2e/support/actors.ts`.
- **CI:** `realtime-latency` artifact upload in the e2e job.
- **Docs:** ADR-0009, "Presence and live access" in `docs/DEMO.md`, screenshots in `.planning/phases/03-realtime-presence-and-latency/screenshots/`.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60 s per targeted vitest command
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
