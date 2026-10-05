---
phase: 03-realtime-presence-and-latency
plan: 05
subsystem: realtime
status: complete
tags: [realtime, latency, e2e, ci, rt-03]
requires:
  - 03-01 presence avatars in the channel header (`presence-avatar` data-user-id / data-state)
  - 03-02 away on hidden tab, online on show + input (500 ms client throttle)
provides:
  - e2e/tests/realtime-latency.spec.ts (two-client message / typing / presence propagation, p50 and p95 < 500 ms)
  - e2e/test-results/realtime-latency.json report (n, p50, p95, max, samples per kind)
  - CI artifact `realtime-latency` uploaded by the e2e job on every run
affects: [03-06]
tech-stack:
  added: []
  patterns:
    - "In-page timestamps on both ends (performance.timeOrigin + performance.now()); Playwright only waits and reads records outside the measured interval"
    - "Receiver records are matched by index (count before the sample), not by comparing cross-page timestamps"
    - "Report written and attached before any assertion, so a failing run still leaves numbers"
key-files:
  created:
    - e2e/tests/realtime-latency.spec.ts
  modified:
    - .github/workflows/ci.yml
decisions:
  - "Warm-up messages run first, before any measured sample (typing pairs included), so every measured kind starts on warm sockets"
  - "Typing samples wait for Sam's indicator to be idle before starting, so a late typing frame can never hide the empty-to-non-empty transition"
metrics:
  duration: "~30 min"
  completed: "2026-10-04"
actuals:
  tokens: 3500
  tasks: 2
  commits: 3
---

# Phase 3 Plan 05: Realtime latency spec (RT-03) Summary

A Playwright spec now drives two real web clients on one channel (admin sends, Sam receives), stamps both ends inside the pages and fails when the p50 or p95 of messages, typing or presence reaches 500 ms. On the isolated stack the p95 stays between 3.5 and 46 ms. CI uploads the JSON report on every e2e run.

## What was built

- `e2e/tests/realtime-latency.spec.ts` (desktop project only; mobile skips by design):
  - Constants: `LATENCY_BUDGET_MS = 500`, `WARMUP = 3`, `MESSAGE_SAMPLES = 30`, `TYPING_SAMPLES = 6`, `PRESENCE_SAMPLES = 20`.
  - Sender probe (admin): capture-phase `input` and Enter `keydown` listeners on `window` stamp each `lat-<n>` token in the composer before React handles the event.
  - Receiver probe (Sam): one MutationObserver (subtree, childList, characterData, `data-state` attributes) stamps the first sight of each token in `[data-testid=message]`, each empty-to-non-empty change of `typing-indicator` and each `data-state` change of admin's `presence-avatar` in the channel header.
  - Samples run one at a time: 3 discarded warm-up messages, then 6 typing + message pairs (3.5 s apart, composer throttle), then 24 more messages, then 20 alternating hide/show toggles of admin's tab (show also dispatches `pointerdown`), 600 ms apart (above the 500 ms presence throttle).
  - If a sample isn't received within 5 s, the test fails and names the sample. Percentiles use nearest rank.
  - The report `{ budgetMs, generatedAt, baseUrl, apiUrl, kinds: { message, typing, presence } }` is written to `<outputDir>/realtime-latency.json` (= `e2e/test-results/`), attached to the test and printed as one line per kind. Then the test asserts `n` = planned, `p50 < 500` and `p95 < 500`.
- `.github/workflows/ci.yml`: a "Realtime latency report" step (`if: always()`, `actions/upload-artifact@v7`, artifact `realtime-latency`, `if-no-files-found: warn`, 30 days) right after `pnpm e2e`. The diff only adds 8 lines. `OCW_SIGNIN_RATE_LIMIT_PER_MINUTE=600` is unchanged.

## Measured latency (isolated stack, local, ms)

Three consecutive runs of `bash scripts/e2e-isolated.sh realtime-latency --project=desktop`:

| Run | Kind | n | p50 | p95 | max |
|-----|------|---|-----|-----|-----|
| 1 (23:17:01Z) | message | 30 | 13.6 | 20.9 | 25.9 |
| 1 | typing | 6 | 3.1 | 5.5 | 5.5 |
| 1 | presence | 20 | 2.3 | 3.5 | 5.2 |
| 2 (23:17:59Z) | message | 30 | 21.8 | 45.7 | 47.2 |
| 2 | typing | 6 | 2.9 | 3.5 | 3.5 |
| 2 | presence | 20 | 2.4 | 4.6 | 5.1 |
| 3 (23:18:41Z) | message | 30 | 17.5 | 29.4 | 34.8 |
| 3 | typing | 6 | 3.3 | 8.0 | 8.0 |
| 3 | presence | 20 | 2.2 | 3.5 | 3.6 |

Inside the full isolated e2e suite: message 14.2 / 20.8 / 23.1, typing 2.6 / 4.4 / 4.4, presence 2.3 / 3.4 / 3.6 (p50 / p95 / max).

Messages are slower than typing and presence because they go through HTTP POST, a PostgreSQL insert and a seq-ordered publish. Typing and presence are ephemeral Redis pub/sub frames. All samples are positive, so there is no sign of cross-page clock skew. Even the worst p95 (45.7 ms) is more than 10 times under the 500 ms budget.

**CI evidence:** this comes with the phase PR. The branch is not pushed in this plan. Download the `realtime-latency` artifact from the e2e job and compare it with this table (03-VALIDATION manual item "First CI evidence of RT-03").

## Verification

- `bash scripts/e2e-isolated.sh realtime-latency --project=desktop`: 2 passed (setup + latency), three times in a row
- Report check `node -e …` (plan Task 1): `{"message":{"n":30,"p50":13.6,"p95":20.9},"typing":{"n":6,"p50":3.1,"p95":5.5},"presence":{"n":20,"p50":2.3,"p95":3.5}}`
- CI check `node -e …` (plan Task 2): `ok`
- `pnpm lint`: clean (4 warnings, all pre-existing in `apps/local-runtime`)
- Full `bash scripts/e2e-isolated.sh`: exit 0, 40 passed, 1 skipped (`[mobile] realtime-latency`, skipped by design), 2.9 min
- `pnpm verify`: exit 0. Turbo 8/8 tasks, Vitest 58 files / 578 tests passed
- Acceptance greps: `LATENCY_BUDGET_MS = 500`, `performance.timeOrigin`, `realtime-latency.json`, the three sample-count constants in the spec; `realtime-latency` name and path in ci.yml

## Deviations from Plan

### Interpretation choices (no product code touched, budget unchanged, no sleeps inside measured intervals)

1. **Warm-up position.** The 3 discarded warm-up messages run at the very start, not between the typing pairs and the further messages. This way every measured kind runs on warm sockets.
2. **Typing input via `fill`.** `fill` fires one `input` event with the full `lat-<n>` value, so the sender stamp is keyed by the token. Per-key typing would stamp `l`, before the token exists. The composer sends `user.typing` on that first change either way.
3. **Idle indicator before each typing sample.** Before a typing sample starts, the spec waits for Sam's indicator to be empty (outside the measured interval). A typing frame that lands after its own message would otherwise keep the indicator on for its 5 s TTL and hide the next transition.
4. **Index-based matching on the receiver.** Typing and presence samples take the first receiver record after the count captured before the sample, not "first record after the sender time". The result is the same, and it does not depend on two pages agreeing on `timeOrigin`.
5. **[Rule 3 - Blocking] Type-safe wait helper.** A generic `waitForFunction` wrapper did not typecheck against Playwright's `PageFunction` overloads. The helper now takes a thunk that receives the timeout. `e2e/` has no tsconfig of its own, so the spec was typechecked ad hoc with `tsc --strict --moduleResolution bundler`.

Commit type for the CI step is `feat(03-05)`, as the orchestrator asked (`feat` / `test` only).

## Known Stubs

None.

## Threat Flags

None. The report holds only numbers, the isolated or CI stack URLs and `lat-<n>` tokens (T-03-05-01). The budget is a constant checked by the acceptance grep (T-03-05-02). All runs went through `scripts/e2e-isolated.sh`, never through :4000/:3000 (T-03-05-03).

## Commits

- e3db619 test(03-05): two-client realtime latency spec with p50/p95 under 500 ms
- dbae255 feat(03-05): CI uploads the realtime latency report on every e2e run

## Self-Check: PASSED
