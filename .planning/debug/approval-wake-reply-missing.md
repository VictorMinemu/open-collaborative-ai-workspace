---
status: awaiting_human_verify
trigger: "e2e work-zone-bot-orchestration.spec.ts:539 Supervised session approval: card shows Approval but the bot's wake reply 'Needs approval: Write @admin' never arrives within 45 s (CI p243, desktop+mobile, deterministic)"
created: 2026-11-09T00:00:00Z
updated: 2026-11-09T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED H1 (test harness) — after WR-01 (84fc14cf) the wake summary no longer lists approval tool names, but the fake cell (e81c6d32, written before WR-01) still parses them from the summary (`approvalToolsOf`), falling back to "a tool"; the reply is "Needs approval: a tool @admin", which never matches the e2e's "Needs approval: Write".
reasoning_checkpoint:
  hypothesis: "The e2e times out because the fake cell's waiting_approval reply is 'Needs approval: a tool @admin': it parses tool names out of a summary that WR-01 stripped of them, instead of reading the session as WR-01/D-20 intend"
  confirming_evidence:
    - "int case mirroring the e2e passes: the product wakes with waiting_approval, the read returns approvals[0].tool=Write and decider handles, the reply posts"
    - "fake-cell unit test fed the real summary is RED (no read; node probe gives 'Needs approval: a tool @admin')"
    - "git order: fake cell e81c6d32 < WR-01 84fc14cf; the unit fixture still uses the pre-WR-01 '(Write)' summary"
  falsification_test: "with the fake cell reading approvals from /work-sessions/read, the unit test goes green; if the e2e still timed out on CI, the cause is elsewhere"
  fix_rationale: "the fake cell stops depending on the summary's wording and takes tool names from the typed read model — the path WR-01 designated; no product permission or approval gate changes"
  blind_spots: "cannot run e2e locally (would touch the demo DB); CI must confirm. The job timing in CI (worker cadence) is assumed equal to the passing turn_done test"
  candidate_causes:
    - "code (product wake path) — eliminated by int case"
    - "data/test-harness (fake cell reply rule vs summary wording) — confirmed"
  and_gate: "no — the product path is proven correct in isolation; the reply text alone breaks the locator"
bug_class: Bohrbug (deterministic on CI, both projects)
candidate_causes:
  - "code (product): starting→running→waiting_approval collapsed into one debounced job not woken / approval row not visible / wake reserved by the start"
  - "code (product): the wake turn's read refused, or the reply after a read refused (D-20)"
  - "data/test-harness: fake cell's reply rule parses tool names from a summary that WR-01 emptied of them"
  - "data: deciders handle differs from ADMIN_HANDLE (userHandle from email local part — checked, matches)"
next_action: add int case "the e2e's order" to work-session-wakes.int.test.ts (botSession, no drain, emitApproval Write, one job, wake waiting_approval, wake-turn read returns approvals[0].tool=Write + deciders, reply via /messages accepted) and run it

## Symptoms

expected: bot message in the card's thread containing "Needs approval: Write" and "@admin" within 45 s
actual: card shows status Approval / step "Waiting for approval"; the expected bot reply locator never matches
errors: Playwright timeout on botReply(panel, "Needs approval: Write", "@admin")
reproduction: CI pipeline 243, e2e/tests/work-zone-bot-orchestration.spec.ts:539, desktop and mobile
started: after the 07.16 code review fixes (WR-01 et al.); turn_done wake test passes

## Eliminated

- hypothesis: product — the start→waiting_approval path (approval as the first event of the first prompt, all before the first debounced job) is not hooked, not woken, reserved by the start, or the approval row is not visible at decide time
  evidence: new int case "the e2e's order" passes — one job, one wake with transition waiting_approval, pendingApprovals 1, deciders[0] = sponsor with handle
  timestamp: 2026-11-09T00:10:00Z
- hypothesis: product — the wake turn's read is refused, or the reply after the read is refused (D-20)
  evidence: same int case — /work-sessions/read on the wake's eventId returns 200 kind read with approvals[0].tool = "Write" and deciders; /messages after it returns 200; session stays waiting_approval, approval stays pending
  timestamp: 2026-11-09T00:10:00Z

## Evidence

- timestamp: 2026-11-09T00:00:00Z
  checked: git log of fake-cell-plugin.ts vs work-session-wakes.ts
  found: fake cell e81c6d32 predates WR-01 84fc14cf; WR-01 removed `(Write, Bash)` tool list from the waiting_approval summary; fake cell `approvalToolsOf(summary)` regex `waiting for N approvals? \(([^)]+)\)` now never matches → "a tool"
  implication: even a correctly delivered wake replies "Needs approval: a tool @admin", not "Needs approval: Write"

- timestamp: 2026-11-09T00:05:00Z
  checked: e2e/support/fake-cell-plugin.test.ts waiting_approval case
  found: fixture summary still "…waiting for 1 approval (Write). …" (pre-WR-01 format); asserts no read is made
  implication: the unit test passes on a stale fixture; the real summary format was never fed to the fake cell

- timestamp: 2026-11-09T00:05:00Z
  checked: packages/contracts BotWorkSessionReadModel; WR-01 commit message
  found: read model carries approvals[].tool and deciders; WR-01 says "the bot reads the rest with ocw_work_session_read (D-20)"
  implication: the intended way for a bot to name the tool is the read — the fake cell must read on waiting_approval

- timestamp: 2026-11-09T00:05:00Z
  checked: bot-read.ts sessionDeciders + contracts userHandle; e2e env ADMIN email admin@ocw.test
  found: handle = email local part → "admin" = ADMIN_HANDLE
  implication: decider handle is not the mismatch

- timestamp: 2026-11-09T00:12:00Z
  checked: fake-cell unit test fed the real WR-01 summary + a read answer with approvals
  found: RED — no /work-sessions/read call; current rule yields "Needs approval: a tool @admin" for the e2e's summary (node probe)
  implication: confirmed — the e2e locator filter "Needs approval: Write" can never match the reply that does arrive

## Resolution

root_cause: Test harness drift. WR-01 (84fc14cf) removed the runtime's tool names from the waiting_approval wake summary (the bot is meant to read them with ocw_work_session_read), but the e2e fake cell (e81c6d32, older) still regex-parsed them from the summary and fell back to "a tool"; its reply "Needs approval: a tool @admin" never matched the spec's "Needs approval: Write". The unit test hid it with a pre-WR-01 fixture. The product is right.
fix: fake cell reads the session on a waiting_approval wake (when offered) and names the read's pending tools (deduped, in order); fallback "a tool". Unit fixture uses the real summary; spec asserts the read. Separately, the Mentions filter takes .first().
oracle_type: specified (exact reply text "Needs approval: Write, Bash @victor @ana"; read call path/body)
verification:
  - int work-session-wakes.int.test.ts: 30/30 pass (new "the e2e's order" case included)
  - unit e2e/support/fake-cell-plugin.test.ts: RED before fix (no read call), 16/16 after
  - pnpm typecheck --force: 11/11 tasks (incl. typecheck:e2e)
  - biome check on the 4 touched files: clean
  - e2e not run locally (would touch the demo DB); CI must confirm
  guardrail_verdict: accepted (pending CI)
files_changed: [e2e/support/fake-cell-plugin.ts, e2e/support/fake-cell-plugin.test.ts, e2e/tests/work-zone-bot-orchestration.spec.ts, apps/api/src/modules/agent-channel/work-session-wakes.int.test.ts]
commits: [1831dd08, c338496d, 19d87282]
