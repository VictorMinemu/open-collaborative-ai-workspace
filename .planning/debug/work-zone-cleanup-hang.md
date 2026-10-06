---
status: awaiting_human_verify
trigger: "Recurring hang in e2e/tests/work-zone.spec.ts (desktop): cleanup API request (GET /devices locally, POST /archive in CI 37413703553) never returns -> 180 s test timeout"
created: 2026-10-06T14:00:00Z
updated: 2026-10-06T16:20:00Z
---

## Current Focus

reasoning_checkpoint:
  hypothesis: "Since 80a786b the Work Zone toaster's bottom offset is the composer form's clearance, so a toast lands
    on the approval banner (the dock's other child, right above the composer) and its right-hand buttons. The
    'Queued #1' toast from the second prompt covers 'Allow for session'; Playwright's click moves the pointer onto
    the toast, Sonner pauses auto-dismiss while hovered (data-expanded=true), so the toast never leaves and the click
    retries until the 180 s timeout. The cleanup request in `finally` is reported only because an exception thrown
    from `finally` replaces the body's error."
  confirming_evidence:
    - "local trace: click allow-session pending 359.2 -> 541.1 s, 345 x '<li data-sonner-toast data-type=success
      data-expanded=true> ... intercepts pointer events'; failure screenshot shows the toast on the banner buttons"
    - "CI 37413703553 attempt-1 trace (artifact playwright-report-desktop): same click, 187 s, same Sonner toast"
    - "api.log: no cleanup request ever reached Fastify; slowest request 90 ms; 187.6 s silence = idle browser"
    - "new assertion (toast box vs approval-banner box) red at 1440 on every run before the fix (frame shows overlap)"
  falsification_test: "with the clearance measured on the whole dock the toast/banner boxes still intersect, or the
    spec still stalls on allow-session over repeated runs"
  fix_rationale: "measure --toast-clearance on the dock (approval banner + agent bar + composer), so bottom-right
    toasts sit above every pinned control; the spec's cleanup gets per-request timeouts and stops masking errors"
  blind_spots: "toasts can still cover the transcript or the wide-screen side panel bottom (transient, unchanged);
    other specs' cleanup blocks keep their own style"
  candidate_causes:
    - "code (web): toaster offset tied to the composer only (80a786b) -> CONFIRMED"
    - "code (api): archive / devices route awaiting a device ack or a lock -> ELIMINATED (never received)"
    - "environment: pg pool exhaustion / slow CI runner -> ELIMINATED (no queued requests, all < 100 ms)"
    - "test: finally-block exception masks the body error -> CONFIRMED (contributing to the misdiagnosis only)"
  and_gate: "yes for the symptom shape: the stall needs the toast over the button AND the second approval arriving
    while the 4 s toast is alive (fake runtime delay); the misleading report needs the throwing finally. The hang
    itself has one cause."
next_action: owner confirms on CI (PR) that work-zone.spec stays green; then archive to resolved/ and add the KB entry

## Symptoms

expected: work-zone.spec desktop passes; cleanup requests answer in ms
actual: test hits 180 s timeout; error points at a cleanup request in the finally block
errors: "apiRequestContext.get: Test timeout of 180000ms exceeded" (local, line 215);
  "apiRequestContext.post: Test timeout of 180000ms exceeded" (CI 37413703553 attempt 1, line 203)
reproduction: full e2e, desktop project, intermittent
started: after 80a786b (toast clearance) landed on fix/stability-batch / feat/phase-4-chat

## Eliminated

- hypothesis: an API route (archive / GET devices) hangs (lock, pool exhaustion, awaiting a device ack)
  evidence: local api.log has NO "incoming request" for the cleanup GET /devices or the archive at all; the API log
    is silent 13:38:55.6 -> 13:42:03.3 because the browser was idle; every request it did receive answered (max 90 ms)
  timestamp: 2026-10-06T14:15:00Z

## Evidence

- timestamp: 2026-10-06T14:05:00Z
  checked: /tmp/gate4.log run dir api.log (ocw-e2e.Rtsp57), parsed incoming vs completed per reqId
  found: slowest completed request 90 ms; one 187.6 s silence 13:38:55.631 -> 13:42:03.290 (desktop work-zone
    window); no cleanup request ever reached Fastify
  implication: the hang is client-side, not in the API

- timestamp: 2026-10-06T14:12:00Z
  checked: trace.zip of the local failure (test.trace)
  found: pw:api@61 `click getByTestId('approval-banner').getByTestId('allow-session')` started at 359.2 s and only
    ended at 541.1 s (context close) with 345 x "<li data-sonner-toast data-type=success data-expanded=true> from
    <section aria-label='Notifications alt+T'> subtree intercepts pointer events"
  implication: the real stall is a toast covering the approval banner; the reported line 215 is just the first
    unguarded await in `finally` after the timeout closed the context

- timestamp: 2026-10-06T14:18:00Z
  checked: CI 37413703553 attempt 1 desktop log
  found: same shape: 3.3 m, error at the first unguarded await in finally (archive, line 203, before 04-13 added the
    .catch); retry then failed on two leftover device cards (since fixed by 04-13)
  implication: consistent with the same client-side stall; trace still to confirm

- timestamp: 2026-10-06T14:35:00Z
  checked: CI 37413703553 attempt-1 trace (artifact 11390722765, test-results/...-desktop/trace.zip)
  found: pw:api@61 click allow-session 187 s, "<li data-sonner-toast data-type=success data-expanded=true> ...
    intercepts pointer events"
  implication: both occurrences are the same client-side stall

- timestamp: 2026-10-06T14:40:00Z
  checked: new assertion in work-zone.spec (toast 'Queued #1' box vs approval-banner box), before the fix
  found: red at 1440 ("Timeout 5000ms exceeded while waiting on the predicate"); trace frame shows the toast on
    "Allow Write for session" / "Approve once"
  implication: deterministic geometric overlap; the hang only needs the 2nd approval to arrive within the toast's life

- timestamp: 2026-10-06T15:10:00Z
  checked: work-zone.spec desktop with the dock clearance; then all work-zone specs desktop --repeat-each=5
    (screenshots on); pnpm verify
  found: green (7.1 s); 66 passed in 10.5 min, 0 flaky; screenshot workzone-session-approval-1440 shows the toast
    above the banner with Deny / Allow for session / Approve once uncovered; wz-slash-1440 still clears the composer;
    pnpm verify: biome 760 files clean, typecheck 8/8, 139 files / 1917 tests
  implication: fix holds and the 80a786b composer guarantee is kept

## Resolution

root_cause: Work Zone toasts (bottom-right, lifted only by the composer's clearance since 80a786b) landed on the
  approval banner's decision buttons; a toast under the pointer never times out (Sonner pauses on hover), so
  Playwright's click on "Allow for session" retried until the 180 s test timeout. The spec's `finally` then threw from
  its first unguarded cleanup request (context already closed), replacing the click error, which made it look like
  an API request that never answered. No API defect: no cleanup request ever reached the API.
fix: (b409676) session view publishes --toast-clearance for the whole bottom dock (approval banner + agent bar +
  composer) instead of the composer form; work-zone.spec asserts toast/banner boxes never intersect.
  (8f78584) work-zone.spec cleanup: 10 s timeout per request, no throw from `finally` (errors collected, rethrown
  only after a passing body), revocation response checked.
oracle_type: specified (geometric non-intersection of the toast and the approval banner boxes)
verification:
  target_test: { result: pass, note: "toast/banner assertion red on 234ca73 web code, green on b409676" }
  mutation_check: { result: skipped, reason_if_skipped: "no Stryker in the repo; the revert run below is the
    fix-site mutant (clearance back on the composer form) and the assertion kills it" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, note: "composer lines are a move of the same hook
    to the dock, not a removal" }
  adjacent_tests: { result: pass, note: "pnpm verify 139 files / 1917 tests; all work-zone specs desktop x5 twice
    (66/66 in 10.5 min, 66/66 in 7.8 min, incl. work-zone-slash toast-vs-composer); full isolated e2e 153 passed,
    2 skipped (pre-existing), 12.2 min" }
  revert_and_reconfirm: { result: pass, note: "pre-fix web sources (identical to the revert of b409676) red, fix green" }
  guardrail_verdict: accepted
files_changed: [apps/web/components/work-zone/session-view.tsx, apps/web/components/work-zone/composer.tsx,
  apps/web/hooks/use-toast-clearance.ts, e2e/tests/work-zone.spec.ts]
