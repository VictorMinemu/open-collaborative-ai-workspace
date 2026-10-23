---
status: awaiting_human_verify
trigger: "Woodpecker sandbox workflow, step sandbox-proof, test 6 of e2e/proof/sandbox.sandbox-proof.ts: the bot's first ocw_browser_open answers 'The workspace could not be reached. Try again later.' after ~27 s (p66) / ~40 s (p64) instead of 'Opened panel.fake.test:8080'. Passed in p56 and p61; fails since CI runs 3 workflows concurrently on one shared host (PR #34)."
created: 2026-10-23T18:00:00Z
updated: 2026-10-23T21:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - timeout chain inverted; the cell gives ocw_browser_open 20 s (one attempt) while the API may take ensure 60 s + contextOpen 30 s + navigate 30 s; a cold brw start under CI load (~22-35 s) outlives the cell's budget
test: done (slow-brw 25 s injection reproduces the exact CI reply, 26981 ms vs 26963 ms)
expecting: -
next_action: human verify = the Woodpecker sandbox workflow running beside the two e2e workflows; on a failure read proof-out/api.log, sandboxd.log and the '== browser opens' line; then archive and add the KB entry

reasoning_checkpoint:
  hypothesis: "The bot's first ocw_browser_open fails because the cell aborts its HTTP call at 20 s (CONFINED_TIMEOUT_MS) while the API, which has no deadline below the cell's, is still waiting for sandboxd's cold brw start (60 s ensure budget, 75 s ready gate); the abort is not an AgentChannelHttpError, so the model reads UNREACHABLE. Under CI concurrency the cold start takes ~22-35 s instead of ~0.7 s."
  confirming_evidence:
    - "Local proof with the brw start delayed 25 s reproduces the exact reply text and timing (26981 ms vs CI 26963 ms); unloaded local proof passes (ensure 720 ms)"
    - "sandboxd log of the repro: the open's browserEnsure 25768 ms; the cell's next call (snapshot) arrives exactly 20 s after the open and waits on the per-bot ensure lock; the open then navigates (CI's egress row ~1 s before the reply)"
    - "The sentence is UNREACHABLE (non-HTTP error), not the browser family's service_unavailable/timeout sentences"
  falsification_test: "With the cell's open budget above an API open deadline that is itself above the cold start, the same 25 s injection must answer 'Opened panel.fake.test:8080' and pass steps 6-10; a start longer than the API deadline must answer the coded timeout sentence, never 'could not be reached'"
  fix_rationale: "One budget table in contracts, innermost first, with inner < outer at every hop: the API bounds each browser call by a deadline below the cell's budget (open: 75 s, others 55 s) and caps every sandboxd call by what is left, answering `timeout` itself; the cell waits 85 s for open and 65 s for the others (under OpenClaw's 90 s Codex dynamic-tool cap); the API's per-op budget outwaits brw's own op cap (45 s) and sandboxd's link (50 s). The API then always answers before the cell gives up, so the model reads the real outcome, and no second call races an open still in flight."
  blind_spots: "Which CI component was slow (Docker daemon, I/O, CPU) is inferred (22-35 s), not measured: the proof now captures sandboxd/API logs and per-step open timings to measure it; a start longer than 75 s on CI would still fail the proof (coded timeout) - then the logs show where; the same inversion exists for ocw_sandbox_exec (cell 35 s vs API ensure 60 s + 40 s) - out of scope, reported"
  candidate_causes:
    - "code: inverted timeout chain (cell 20 s < API 60-120 s < sandboxd 75 s) - CONFIRMED"
    - "environment: CI host shared by 3 workflows + production slows the cold brw start to ~22-35 s - CONFIRMED as the trigger (inferred from timing, logs now captured)"
    - "code: readiness gate never resolving / lost first request - ELIMINATED (the start completes; ensure returns as soon as the agent says ready)"
    - "data: none"
  and_gate: "yes - the failure needs (a cold start slower than 20 s: environment) AND (a cell budget below the API's: code). Fixing the code side removes the failure for any start under the API deadline; the environment side is now measured by the proof"
bug_class: Mandelbug (load-dependent timing; deterministic once the cold start exceeds the cell budget)

## Symptoms

expected: test 6 reply contains "Tool ocw_browser_open said: Opened panel.fake.test:8080" and "Sign in"
actual: "Tool ocw_browser_open said: The workspace could not be reached. Try again later." then "Tool ocw_browser_snapshot said: No page is open."
errors: reply after 26963 ms (p66) / 40086 ms (p64); audit sandbox.egress brw panel.fake.test allowed at 16:15:57.685 (p66) / 13:57:42.411 (p64), i.e. ~1 s before the reply was seen
reproduction: Woodpecker sandbox workflow next to two e2e workflows on one 12-core host; steps 1-5 pass; the first browser open of the run fails
started: pipeline 64 (chore/node-24.22.1) and 66 (07.9); passed in 56 and 61 (before parallel CI)

## Eliminated

## Evidence

- timestamp: 2026-10-23T18:00:00Z
  checked: /tmp/ci66art/proof-66.log, proof-64.log, 6x-sandbox/proof-out/{cell.log,audit.tsv,state.json}
  found: "The workspace could not be reached" is UNREACHABLE (connector-tools.ts), which confinedRefusalOf returns for a non-HTTP error (fetch abort/TimeoutError, ZodError) or an HTTP status without a known code; an API `service_unavailable`/`timeout` would read "The browser service isn't reachable" / "The page did not answer in time". The brw navigation to panel.fake.test happened ~26 s (p66) / ~40 s (p64) after the turn was delivered; the cell log shows heavy load (liveness heartbeat overdue 13.5 s, 20 s config reload, slow SQLite).
  implication: the cell's own transport failure, not an API refusal; the API kept going and navigated after the cell gave up.

- timestamp: 2026-10-23T18:00:00Z
  checked: timeouts in the chain
  found: cell browserCall: one attempt, CONFINED_TIMEOUT_MS 20 s for ocw_browser_open (api-client.ts); API browser.ts: ENSURE_TIMEOUT_MS 60 s (pushPolicy + browserEnsure), then contextOpen OP_TIMEOUT_MS 30 s, contextNavigate 30 s (up to ~120 s); sandboxd BROWSER_READY_MS 75 s for brw `ready` (agent launch timeout 60 s)
  implication: every outer layer gives up before the inner one (20 s < 60 s < 75 s): inverted chain.

- timestamp: 2026-10-23T18:40:00Z
  checked: the rest of the chain (agent.mjs LIMITS, sandboxd agent-link, API OP/WAIT budgets, OpenClaw image)
  found: brw agent navigation 30 s, op cap 45 s, launch 60 s; sandboxd agent link 60 s; API context ops 30 s (< the agent's 45 s cap: the API gives up on a slow op first), wait ms+15 s; cell 20 s for every browser tool but wait (35 s, < the API's 45 s). OpenClaw 2026.9.7: no per-tool cut on the embedded runtime (A4), but Codex app-server dynamic tools default to 90 s (CODEX_DYNAMIC_TOOL_TIMEOUT_MS) -> every cell budget must stay < 90 s.
  implication: inverted at two hops (cell->API for every browser tool, API->sandboxd for ensure and context ops); the fix must bound the API's open under the cell's budget and keep the cell under 90 s.

- timestamp: 2026-10-23T19:00:00Z
  checked: local proof, baseline (no load), ports 47xx, project ocw-brwopen-repro
  found: 10/10 PASS; first open 2610 ms end to end; sandboxd: browserEnsure 720 ms (brw started 161 ms, sandbox_fallback, launched 213 ms, ready 577 ms)
  implication: the local cold start is ~0.7 s; CI needed >20 s, so the slow component on CI is load (CPU/IO/Docker daemon), not visible without sandboxd logs (not captured).

- timestamp: 2026-10-23T19:15:00Z
  checked: local proof under 12 busy containers + 2 dd loops in the Docker VM + 8 host loops
  found: the cell itself starved (first exec 83 s; test 3 failed on kill latency 5588 ms > 5000), browser steps never reached
  implication: generic overload breaks the cell before the brw start; a deterministic slow-start injection (pause the brw container right after start) is the precise reproduction.

- timestamp: 2026-10-23T19:25:00Z
  checked: local proof with the first brw container paused 25 s right after its start event (/tmp/brwopen-scripts/slow-brw.sh), sandboxd.log of the run
  found: REPRODUCED. Step 6 reply after 26981 ms (CI p66: 26963 ms): "Tool ocw_browser_open said: The workspace could not be reached". sandboxd: open's browserEnsure 25768 ms; at +20 s (cell abort) a SECOND policy push + browserEnsure arrives (the bot's ocw_browser_snapshot, claim.ensure=true) and waits on sandboxd's per-bot lock; both return at the same ms; the snapshot's contextSnapshot gets 404 no_context (the API then closes the open's context row as crashed), while the open's contextOpen (120 ms) and contextNavigate (53 ms) succeed right after: an orphan page in sandboxd, `browser.opened` recorded, the model told "unreachable".
  implication: confirms the inverted budget. Also explains the CI "coincidence": the reply was gated by the snapshot waiting on the same cold start, so the navigation (egress row) lands ~1 s before the reply. CI cold brw starts under load were therefore ~22-25 s (p66) and ~35 s (p64).

- timestamp: 2026-10-23T19:45:00Z
  checked: RED tests before any product change
  found: contracts browser.test.ts (3 failing: no BROWSER_TIMEOUTS_MS); openclaw-channel browser-tools.test.ts (budget test failing: 20 s < API deadline); api browser-deadline.test.ts (6 failing: no deadline); api browser-deadline.int.test.ts (a 4 s start with a 1.5 s open deadline answers 200 after 4.1 s instead of 503 timeout at the deadline); sandboxd browser-timeouts.test.ts (2 failing: link 60 s, no contracts table)
  implication: the tests pin the chain and the deadline behaviour; implementation next.

- timestamp: 2026-10-23T20:20:00Z
  checked: GREEN - unit + integration after the fix; the real-stack proof locally with the same 25 s brw start injection
  found: contracts 21/21, plugin browser-tools 12/12, api browser-deadline 6/6 + int 2/2 (1.5 s deadline: a 0.6 s start opens the page; a 4 s start answers 503 `timeout` at ~1.5 s, context ended `crashed`, step error/timeout, the next open finds the browser started), sandboxd 2/2; existing browser.int + signin.int 41/41; unit suites of the 4 packages 2422/2422. Proof with the 25 s injection: 10/10 PASS; first open 28081 ms through the cell = API 26019 ms (ensure 25763 ms: brw started 119 ms, ready 25614 ms; contextOpen 103 ms; navigate 37 ms); later opens 0.55-1.6 s.
  implication: the fix holds the cold start that broke CI, and the proof now reports where a first open's time goes.

- timestamp: 2026-10-23T20:35:00Z
  checked: the proof with the brw start delayed 80 s (beyond the open's 75 s deadline)
  found: reply after 76903 ms "Tool ocw_browser_open said: The page did not answer in time. Try again later." (coded `timeout`, never "could not be reached"); API 75021 ms; audit browser.opened error reason timeout durationMs 74974 + browser.closed crashed; sandboxd's own ready gate fired at 75096 ms (brw not ready, 503); the failure path copied api.log and sandboxd.log into proof-out (E1 strings masked, none present)
  implication: past the deadline the model reads the real outcome and the records agree; the logs a CI failure needs are now kept.

## Resolution

root_cause: "Inverted timeout chain for bot browser calls: the cell gave ocw_browser_open one 20 s attempt (CONFINED_TIMEOUT_MS) while the API, with no deadline of its own, waited up to 60 s for sandboxd's browserEnsure and then 30 s + 30 s for contextOpen and contextNavigate (sandboxd's ready gate 75 s). Under parallel CI (3 workflows on one host shared with production) the first, cold brw start took ~22-35 s, so the cell aborted and rendered its transport failure as UNREACHABLE, while the API finished the open afterwards (browser.opened recorded, page open) and the bot's next call (snapshot) raced it: its ensure waited on sandboxd's per-bot lock, got no_context and closed the open's context as crashed. Same inversion for every browser tool (cell 20/35 s < API 30 s/45 s ops < brw's 45 s op cap)."
fix: "One budget table in contracts (BROWSER_TIMEOUTS_MS), innermost first, inner < outer at every hop: brw navigation 30 s < brw op 45 s < sandboxd link 50 s (was 60) < API op 55 s (was 30; wait no longer ms+15 s); each browser call runs under an API deadline (open 75 s, others 55 s) that caps every sandboxd call and answers `timeout` itself; the cell waits 85 s for open and 65 s for the others (was 20/35 s), below OpenClaw's 90 s Codex dynamic-tool cap. A start the deadline cut keeps going in sandboxd (ready gate 75 s) and is warm for the next call. The proof records per-step open timings and the first open's legs (API, ensure, brw started/ready, contextOpen, navigate) and, on failure, keeps the API and sandboxd logs (E1 masked) plus browser.* audit rows."
verification:
  target_test: { result: pass, tests: "contracts browser.test.ts (chain, 3), openclaw-channel browser-tools.test.ts (budgets + timeout sentence), api browser-deadline.test.ts (6), api browser-deadline.int.test.ts (2), sandboxd browser-timeouts.test.ts (2)" }
  mutation_check: { result: pass, reason_if_skipped: "Stryker not configured; manual mutants at the 4 fix sites instead", mutant_killed: "underDeadline rethrow, cell open budget 20 s, contracts apiOpen 80 s, sandboxd link 60 s: all 4 killed" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, note: "only WAIT_MARGIN_MS removed: the wait now uses the API op budget (55 s), above brw's own 45 s op cap that bounds every wait" }
  adjacent_tests: { result: pass, detail: "pnpm verify: 398 files, 6314 tests; browser.int + signin.int 41/41; pnpm typecheck --force" }
  revert_and_reconfirm: { result: pass, detail: "RED-first on the unchanged tree for every new test and for the real-stack proof (25 s cold start: CI reply reproduced, 26981 ms); GREEN after the fix with the same injection (10/10 PASS, first open 28081 ms); 80 s start answers the coded timeout sentence" }
  guardrail_verdict: accepted
  human_verify: "the Woodpecker sandbox workflow next to the two e2e workflows (the CI host's concurrency is not reproducible here; the slow start was injected)"
files_changed:
  - packages/contracts/src/browser.ts
  - packages/contracts/src/browser.test.ts
  - apps/api/src/modules/agent-channel/browser.ts
  - apps/api/src/modules/agent-channel/index.ts
  - apps/api/src/app.ts
  - apps/api/src/testing.ts
  - apps/api/src/testing-sandbox.ts
  - apps/api/src/modules/agent-channel/browser-deadline.test.ts
  - apps/api/src/modules/agent-channel/browser-deadline.int.test.ts
  - infra/fake-model/fake-sandboxd.mjs
  - apps/sandboxd/src/agent-link.ts
  - apps/sandboxd/src/browser.ts
  - apps/sandboxd/src/browser-timeouts.test.ts
  - apps/openclaw-channel/src/agent-channel-protocol.ts
  - apps/openclaw-channel/src/api-client.ts
  - apps/openclaw-channel/src/browser-tools.test.ts
  - e2e/proof/sandbox.sandbox-proof.ts
  - scripts/sandbox-proof.sh
oracle_type: specified (contract budget table + coded refusal sentence), plus boundary neighbours (start inside vs beyond the deadline)
