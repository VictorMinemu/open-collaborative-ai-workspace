---
phase: 06-multiplayer-ai-chat
plan: 09
subsystem: api/eval, ci
status: complete
tags: [eval, spoofing, multiplayer, metered, ci, MULTI-07]
requires:
  - "06-05: SPOOF_CASES, renderPrompt, buildModelMessages (multiplayer format)"
  - "model-gateway registry: orgLanguageModel; errors: classify; contracts: estimateCostMicros, MODEL_PRICES"
provides:
  - "apps/api/src/eval/multiplayer/grade.ts: gradeReply, summarize (deterministic, no judge)"
  - "apps/api/src/eval/multiplayer/run.ts: runEval + CLI `pnpm --filter @ocw/api eval:multiplayer` (opt-in, metered)"
  - ".github/workflows/ai-eval.yml: ai-eval label / weekly Monday 06:00 UTC / dispatch, skipped without the secret"
  - "orgLanguageModel exported from the model-gateway index"
affects: [06-16 (Task 3: the owner's metered run)]
tech-stack:
  added: []
  patterns:
    - "Two-gate metered script: OCW_EVAL_CONFIRM=metered AND an env key; dry run needs neither and calls nothing"
    - "Key-free artefacts: logs carry provider/model/case/verdict/classified code only; replies redacted; report written 0600"
key-files:
  created:
    - apps/api/src/eval/multiplayer/grade.ts
    - apps/api/src/eval/multiplayer/run.ts
    - apps/api/src/eval/multiplayer/eval.test.ts
    - .github/workflows/ai-eval.yml
  modified:
    - apps/api/src/modules/model-gateway/index.ts
    - apps/api/src/modules/ai-chat/guard.test.ts
    - apps/api/package.json
    - .gitignore
decisions:
  - "Dry run (OCW_EVAL_DRY_RUN=1) needs neither the confirmation nor a key: it cannot spend, and the owner can see the cost first"
  - "OpenRouter default models are anthropic/claude-sonnet-5.5 (dot, the id OpenRouter and MODEL_PRICES use) and openai/gpt-5"
  - "Each call is capped at maxOutputTokens 4000 (bounds the worst case; leaves room for gpt-5 reasoning)"
metrics:
  duration: "~16 min"
  completed: 2026-10-07
actuals:
  tokens: 10500
  tasks: 2
  commits: 5
---

# Phase 6 Plan 09: Multiplayer spoofing eval Summary

The six `SPOOF_CASES` can now go to real models with one opt-in command. Each prompt is built by the production `buildModelMessages`, and the model is the gateway's `orgLanguageModel` instance. A substring grader with no judge model scores every reply, a (model, case) passes with at least 2 of 3 repetitions, and the JSON report never contains the key. Executors ran it only against `infra/fake-model` and in dry-run mode. Nothing was billed.

## Owner's command (MULTI-07, D-02; 06-16 Task 3)

```bash
# 1. See the plan and cost first (no request, no key needed)
OCW_EVAL_DRY_RUN=1 pnpm --filter @ocw/api eval:multiplayer
# 2. The metered run (OpenRouter key from the environment only)
OCW_EVAL_CONFIRM=metered OCW_EVAL_PROVIDER=openrouter OCW_EVAL_API_KEY=<openrouter-key> pnpm --filter @ocw/api eval:multiplayer
```

- **Expected cost:** 36 calls (6 cases × 3 reps × 2 models). The dry run estimates about **$0.31**: ~$0.158 for anthropic/claude-sonnet-5.5 and ~$0.153 for openai/gpt-5. That figure assumes ~6.9k input tokens per model and 800 output tokens per call. The hard ceiling at 4000 output tokens per call is **$1.46**.
- **Output:** one line per call and per (model, case), then the totals and the estimated cost. The report goes to `apps/api/eval-out/multiplayer-<ISO>.json`, which is gitignored and written with mode 0600.
- **Exit codes:** 0 when everything passes or on a dry run, 1 when any (model, case) is below 2/3, 2 when a gate refuses (`eval_not_confirmed`, `eval_key_missing`, `eval_invalid_env`).
- **Options:** `OCW_EVAL_MODELS` (comma list), `OCW_EVAL_REPS` (1-10), `OCW_EVAL_PROVIDER=anthropic|openai` with that provider's key, `OCW_EVAL_BASE_URL`.
- **CI, once Actions billing returns:** add the `OCW_EVAL_API_KEY` repository secret. Then label a PR `ai-eval`, dispatch the workflow, or wait for the weekly run.

## Tasks

| # | Task | Commits |
|---|------|---------|
| 1 | Env gate → cases → builder → provider instance → grader → JSON report (tracer, TDD) | 36a4c5f (RED), fcb589d (GREEN) |
| 2 | `ai-eval.yml` runs only on the label, the weekly schedule or a dispatch, and is skipped without the secret (TDD) | ca2c40c (RED), cd87520 (GREEN) |
| — | Deferred-items entry for a pre-existing integration failure | 43587b9 |

## Verification

- `pnpm exec vitest run --project unit apps/api/src/eval/multiplayer/eval.test.ts apps/api/src/modules/ai-chat/guard.test.ts`: **2 files, 28 tests pass**. eval.test has 18 tests and guard.test has 10, including the new runner rule.
- The plan's dry-run command (`OCW_EVAL_DRY_RUN=1 OCW_EVAL_CONFIRM=metered OCW_EVAL_API_KEY=dry-run-not-a-key pnpm --filter @ocw/api eval:multiplayer`) exits 0. The key string appears 0 times in the output and no request was made.
- CLI refusals: without the confirmation it prints `eval_not_confirmed` and exits 2. Without a key it prints `eval_key_missing` and exits 2. `OCW_EVAL_PROVIDER=vercel` gives `eval_invalid_env: invalid provider` and exits 2.
- CLI end to end against a standalone `infra/fake-model` on 127.0.0.1: 12 calls and a written report, with the key absent from both the output and the file. It exits 1 as expected, because the fake echoes the forged blocks and the grader fails those cases. The report was deleted afterwards.
- `pnpm verify`: lint is clean (899 files) and typecheck is clean. Tests: **176 of 177 files and 2455 of 2456 tests pass**. The one failure is pre-existing and unrelated (see Deferred Issues).

## Deviations from Plan

1. **[Rule 2 - Safety] The dry run does not require the confirmation or the key.** It makes no request (the test proves the fetch spy and the fake saw zero calls), so the owner can check the cost before exporting a key. The plan's dry-run command, which sets both, still works.
2. **[Rule 1 - Bug] The OpenRouter default model is `anthropic/claude-sonnet-5.5` (dot), not the plan's `anthropic/claude-sonnet-5-5`.** OpenRouter and `MODEL_PRICES` (`openrouter/anthropic/claude-sonnet-5.5`) use the dot. With the dash id the model would have no price, so no cost estimate, and OpenRouter would probably reject it.
3. **[Rule 2 - Cost/Security] Additions beyond the plan's call options:**
   - `maxOutputTokens: 4000` and a 120 s timeout on every call.
   - Failing replies are redacted for the key, and the whole report JSON is redacted again before it is written.
   - The report file is written with mode 0600 and records `baseUrl` as the origin only.
   - `runEval` takes two extra options, `log` and `outDir`, so tests can capture logs and use a temporary directory.
4. **Grader is case-insensitive, as the plan says.** The doc comment on `SpoofCase.grade` in 06-05's `spoof-cases.ts` still says "case-sensitive". That file is outside this plan's file list, so I left it unchanged.
5. **Report filename** is `multiplayer-<ISO with : and . replaced by ->.json`, which keeps it portable to Windows.

## Deferred Issues

- `apps/api/src/modules/ai-chat/grants.int.test.ts:606` fails every time on the base `28a31e4` plus this plan. It also fails when run alone.
  - 06-04 asserts that access notices never reach the model. 06-05 deliberately puts notices newer than the last answer into `<turn_context>`.
  - This plan touches neither the builder, `turn.ts`, nor the grants path.
  - The full entry is in `deferred-items.md`. This is why `pnpm verify` is not fully green.

## Known Stubs

None.

## Threat Flags

None. T-06-09-01 through T-06-09-04 are mitigated and tested:
- The key never appears in logs, reports or errors, including a provider error body that echoes the key.
- Both gates hold, the dry run makes no request, and the workflow triggers only on label, schedule or dispatch.
- Prompts come only from `buildModelMessages`.
- The guard pins `orgLanguageModel` and finds no `@ai-sdk/*` import in the runner.

## Windows ledger (single line; not written by this executor)

`gsd windows append --kind unrun-verify --phase 06 --file apps/api/src/eval/multiplayer/run.ts --description "metered MULTI-07 eval on real models pending the owner's run (06-16 Task 3, ~\$0.31)"`

## Self-Check: PASSED

- FOUND: apps/api/src/eval/multiplayer/{grade,run,eval.test}.ts, .github/workflows/ai-eval.yml
- FOUND commits: 36a4c5f, fcb589d, ca2c40c, cd87520, 43587b9
