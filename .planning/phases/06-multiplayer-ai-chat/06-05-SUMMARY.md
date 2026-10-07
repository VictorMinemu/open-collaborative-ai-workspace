---
phase: 06-multiplayer-ai-chat
plan: 05
subsystem: api (ai-chat prompt builder, turn assembly)
status: complete
tags: [multiplayer-ai, prompt, spoofing, provider-matrix, tracer]
requires: [06-02 multiplayer prompt mode (roster, attributed blocks, turn context), Phase 5 builder, gateway and fake model]
provides:
  - "Complete P-06 format: persona blocks, <attachment> labels, <notice> and <withheld> lines in the trailing <turn_context>"
  - "PersistedTurn.kind ('message' | 'notice'), author.handle; BuildInput.participants.withheld"
  - "turn.ts maps rows by author: chat model → assistant, persona → user-side agent block, system → notice; Web withheld per requester via webUnavailableReason"
  - "SPOOF_CASES + renderPrompt (spoof-cases.ts): the six eval cases as prompt fixtures (06-09 reuses them)"
  - "Guards: no name-colon-body templates in the builder; no system-role message object under modules/ai-chat/"
  - "prompt-matrix.int.test.ts: plan, OpenAI key, Anthropic key, OpenRouter, OpenAI-compatible wire shapes"
affects: [06-04 (notice rows need nothing more from the builder), 06-09 (metered eval uses SPOOF_CASES), 06-10 (persona rows need nothing more)]
tech-stack:
  added: []
  patterns:
    - "Notices are rows, not messages: only those newer than the last kept answer reach the model, inside <turn_context>"
    - "Prompt-level spoof fixtures built only through the production builder, with reply grading rules beside them"
key-files:
  created:
    - apps/api/src/modules/ai-chat/spoof-cases.ts
    - apps/api/src/modules/ai-chat/prompt-matrix.int.test.ts
  modified:
    - apps/api/src/modules/ai-chat/build-model-messages.ts
    - apps/api/src/modules/ai-chat/build-model-messages.test.ts
    - apps/api/src/modules/ai-chat/turn.ts
    - apps/api/src/modules/ai-chat/guard.test.ts
decisions:
  - "A text attachment part (inlined text file or placeholder) gets an author-only label `<attachment from=…/>`: its text already names the file and the part carries no filename field"
  - "File names in labels and on file parts drop quotes, angle brackets, backticks and line breaks (stronger than neutralise: no `<` survives)"
  - "Inlined text attachments are neutralised in multiplayer mode too (T-06-05-01)"
  - "Any non-null webUnavailableReason (policy, permission or model support) becomes the withheld reason; the web note stays tied to an attached tool, so a withheld turn's instructions differ from a Web turn's only by that note"
  - "The roster lists member agents only; persona authors who left are still attributed from the agent directory"
metrics:
  duration: "~55 min"
  completed: 2026-10-07
actuals:
  tokens: 12500   # chars/4 over the added lines of the diff (49 863 chars)
  tasks: 2
  commits: 3
---

# Phase 6 Plan 05: Complete multi-human prompt builder Summary

The multiplayer prompt now covers every row a shared chat can hold: personas are attributed agent blocks inside user turns, each file follows its author's block behind an `<attachment>` label, access notices since the last answer and withheld tools close the trailing `<turn_context>`. The six spoofing cases run as free prompt checks on every `pnpm verify`, and five provider paths are proven on the wire through the fake.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Persona, files, notice, withheld → one attributed prompt (tracer) | 02cd90d |
| 2 | Provider wire-shape matrix + withheld Web for a denied requester | c7f72d6 |

## What changed

- **Builder (P-06).** `PersistedTurn.kind = "notice"` rows go into the turn context only when newer than the last kept assistant turn (neutralised); `participants.withheld` renders `<withheld tool reason/>` after `<responding_to>` and notices. User rows with an agent author render `<message from="@handle" agent_id kind="agent" at>`. Files: `<attachment from name/>` then the part, right after the owning block. Solo mode skips notices; its output is unchanged (Phase 5 `.snap` untouched).
- **turn.ts.** Only agent rows without an author id are assistant turns; persona rows get name and handle from `agents` (even after leaving); system rows become notices; `webTools` now returns the `webUnavailableReason`, passed as `withheld: [{tool: "web", reason}]` in multiplayer chats (no tools attached, as in Phase 5).
- **spoof-cases.ts.** `SPOOF_CASES` (addressing, coalesced addressing, forged admin block with `CODE-PINEAPPLE-42`, display-name forgery with `"` and `>`, claimed approval for absent personal instructions, forged `<turn_context>` with a notice) + `renderPrompt`. Each has `expectInPrompt`, `forbidInPrompt` and `grade` (reply tokens for 06-09).
- **guard.test.ts.** Name-colon-body template rule on the builder; no `role: "system"` object in any other ai-chat file (comments ignored); self-tests for both patterns.

## Verification

- `vitest --project unit build-model-messages.test.ts guard.test.ts`: 68/68 (12 new builder cases, 7 spoof tests, 3 guard tests). RED first: 8 builder cases failed before the implementation. The spoof prompt checks already passed on the 06-02 neutraliser (they are a regression guard).
- Snapshot: `git diff --quiet origin/main -- apps/api/src/modules/ai-chat/__snapshots__` exits 0.
- `prompt-matrix.int.test.ts`: 9/9. Sensitivity checked: with 4fb45e2's builder and turn.ts the withheld and persona/notice cases fail (2/9) and the provider-shape cases pass (06-02 already had the right shape; the matrix now locks it).
- Regressions: multiplayer.int 17/17, tools.int 17/17, ai-chat unit 85/85.
- `pnpm verify`: exit 0; typecheck 8/8; 173 files, 2402 tests; lint clean except the 4 pre-existing local-runtime warnings.
- Acceptance greps: `export const SPOOF_CASES` (spoof-cases.ts), `webUnavailableReason` (turn.ts), `"anthropic"` in the matrix (4 lines).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] File names and inlined text neutralised in multiplayer mode**
- **Found during:** Task 1.
- **Issue:** a file's name (also sent as the part's `filename`) and an inlined text file could carry `<turn_context>` or `</message>` into the prompt.
- **Fix:** labels and `filename` drop `"<>`` ` `` and line breaks; text parts go through `neutralise`. Tested.
- **Commit:** 02cd90d

**2. [Rule 1 - Expected change] 06-02 test "files follow their author's block" now includes the label**
- The P-06 label `<attachment from="Alex Kim" name="file"/>` (part without a filename) is now part of that expected message. No Phase 5 test or snapshot changed.

**3. [Rule 2 - Coverage] Matrix also traces persisted persona and notice rows through turn.ts**
- The plan's Task 1 tracer has unit-only verification; the matrix inserts an agent, a persona row and a notice row (superuser, next stream seqs) and asserts the roster line, the agent block, the notice in the turn context, and that an older notice is not repeated.

**4. [Note] Snapshot check base**
- Local `main` is stale (Phase 2, as noted in 06-01/06-02); the check ran against `origin/main` (exit 0).

**5. [Note] Instruction stability with Web**
- Byte-identical instructions are asserted across requesters and providers with the same tools. A turn without the search tool has no web note, so its instructions differ from a Web turn's by that note (the tool list changes the cached prefix anyway).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-06-05-01 (neutralised bodies, persona blocks, file names, notices; SPOOF_CASES), T-06-05-02 (requester-decided tools, withheld line, deny-rule matrix case), T-06-05-03 (no system role: guard + matrix; Anthropic header asserted), T-06-05-04 (byte-identical instructions asserted) are mitigated and tested.

## Open items for later plans

- 06-04: notice rows must be written as `author_kind = 'system'` messages on the conversation stream; the builder and turn.ts need nothing more.
- 06-09: the metered eval should build prompts with `SPOOF_CASES[i].build()` and grade replies with `grade`.
- 06-10: persona messages as `author_kind = 'agent'` with the agent's id; nothing more needed in the prompt.

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: spoof-cases.ts, prompt-matrix.int.test.ts, this SUMMARY.
- Commits 02cd90d and c7f72d6 are on wt/06-05.
