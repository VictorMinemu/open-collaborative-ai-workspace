---
quick_id: 261113-e6s
slug: platform-tools-keep-their-turn-slots
date: 2026-11-13
type: fix
status: complete
subsystem: bot-capabilities
tags: [turn-policy, tools, mcp, work-zone, sandbox, long-tasks]
key-files:
  modified:
    - packages/contracts/src/bot-capabilities.ts
    - apps/api/src/modules/bot-capabilities/turn-policy.ts
    - apps/web/components/bots/tools-section.tsx
    - packages/contracts/src/bot-capabilities.test.ts
    - apps/api/src/modules/bot-capabilities/capabilities.int.test.ts
    - apps/api/src/modules/agent-channel/work-session-offer.int.test.ts
    - apps/api/src/modules/agent-channel/task-offer.int.test.ts
    - apps/api/src/modules/agent-channel/automation-runs.int.test.ts
    - apps/web/components/bots/tools-section.test.tsx
decisions:
  - "Organization MCP/plugin tools stop at TURN_CATALOG_TOOLS_MAX (101) turn tools; the other 27 slots (TURN_PLATFORM_RESERVE, computed from the tool arrays) are kept for the turn-scoped platform tools computeTurn adds later. 128 stays the provider limit."
---

# Quick 261113-e6s: platform tools keep their turn slots

Organization MCP tools now fill at most 101 of a turn's 128 tool slots. The other 27 are kept for the turn-scoped
platform tools: Work Zone sessions, sandbox and browser, tasks, attachment read, consult and conversation open. A bot
with every MCP tool on gets all of them again.

## Root cause

`assemble()` added the catalog tools until `TURN_TOOLS_MAX` (128). `computeTurn` adds every turn-scoped platform tool
afterwards and checks the same cap, so on a full turn all of them were dropped without a message. With all
organization tools on, the bot only proposed Work Zone sessions and had no sandbox, PDF tools or task start.

## Fix

- `packages/contracts/src/bot-capabilities.ts` adds `TURN_PLATFORM_RESERVE`. It is the sum of the sandbox, browser,
  Work Zone session and task tool counts, plus 3 (attachment read, consult, conversation open): 27 in total. It also adds
  `TURN_CATALOG_TOOLS_MAX = TURN_TOOLS_MAX - TURN_PLATFORM_RESERVE` (101). The doc comments explain why.
- `assemble()`: the catalog loop stops at `TURN_CATALOG_TOOLS_MAX` turn tools. Platform tools added in `assemble` still
  use the plain 128 check. The eviction paths for conversation open and task control are unchanged.
- `toolsOverLimit` follows from this. Only its doc comment changed.
- The bot sheet warning now reads: "A turn carries at most 101 tools from MCP servers and plugins, so the platform's own
  tools always fit. Turn off the ones this bot does not need."

## Tests (failing first)

RED commit `dcd3e8e5`. A run with the contract constants in place but `assemble` unchanged reproduced the UAT. The
turn carried 128 tools without `ocw_work_session_start`, without `ocw_task_start` and without the sandbox family.

| Test | Old expectation | New expectation (why) |
| --- | --- | --- |
| contracts `bot-capabilities.test.ts` (new) | none | The reserve equals the sum of the arrays + 3 = 27, and the catalog max is 101. |
| `capabilities.int.test.ts` toolsOverLimit | more than 140 - 128 left out | more than 140 - 101 left out. Granting exactly 101 now leaves some out, because platform tools take part of the share. The count moves by the reserve. |
| `work-session-offer.int.test.ts` "six tools need six free slots" | A full turn keeps the proposals and does not offer the six. | Rewritten. With more MCP tools than a turn holds, all six are offered, the proposals are replaced and the task tools are present. The MCP tools that fit are a prefix of the list, the rest are left out, and there is no `turn_full`. The old "no room" case can no longer happen through catalog tools. |
| `task-offer.int.test.ts` WR-07 | Start withheld as `turn_full`. A control turn evicts one MCP tool. | Rewritten. The start is offered, every platform tool is kept (sandbox family included), and the MCP tools past the share are left out. A control turn adds continue and finish without dropping a tool. No `turn_full` is reported. |
| `automation-runs.int.test.ts` WR-07 | A full run turn evicts the last MCP tool to fit `ocw_conversation_open`. | Rewritten. `ocw_conversation_open` and the sandbox family are present without any eviction, and the MCP tools are a prefix of the list. |
| `tools-section.test.tsx` | "at most 128 tools" | "at most 101 tools from MCP servers and plugins", "own tools always fit" |

No permission, RLS or approval assertion was changed. Only slot counts and eviction expectations moved by the reserve.
No e2e spec asserts tool counts or the warning copy: `do not fit in a bot turn` and `tools-over-limit` appear in
neither `e2e/` nor `apps/desktop/e2e`.

## Verification

- Contracts: `pnpm exec vitest run --project unit packages/contracts` gives 45 files, 1116 tests passed.
  `pnpm --filter @ocw/contracts test` is a no-op because the package has no `test` script.
- API: `pnpm exec vitest run apps/api/src/modules/bot-capabilities apps/api/src/modules/agent-channel` covers 59
  integration and 12 unit files: 71 files, 1201 tests passed in 414 s, using testcontainers PostgreSQL and Redis.
- Web: `pnpm exec vitest run --project web apps/web/components/bots` gives 4 files, 60 tests passed. The
  `--filter @ocw/web exec` form fails on HEAD too, because the JSX runtime is set only in the root config.
- `pnpm lint` passes. Its only output is 4 warnings that were already there, in `apps/local-runtime`.
- `pnpm typecheck` passes: 11 of 11 tasks succeeded.

## Deviations from Plan

- **[Rule 1 - test fixture]** The first RED fixture granted `TURN_CATALOG_TOOLS_MAX + 10` tools. That fit under 128
  with the old code too, so the tests would not have shown the bug. The fixture now uses `TURN_TOOLS_MAX + 10`, and the
  test commit was amended before the fix.
- The verify commands were run through the root vitest config, because the package-filtered forms do not run these
  tests (see Verification).

## Commits

- `dcd3e8e5` test(api): organization tools leave the turn-scoped platform tools their slots
- `e54f135b` fix(api): organization tools never take a platform tool's turn slot

## Self-Check: PASSED
