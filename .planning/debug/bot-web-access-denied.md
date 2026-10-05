---
status: resolved
trigger: "Bot with internet access enabled says it has no internet access when asked to search the web."
created: 2026-10-05T18:15:00Z
updated: 2026-10-05T18:20:00Z
---

# Debug report: bots with web access say they have no internet

## Symptoms

expected: a personal bot with internet access enabled answers "search the web for X" by calling `web_search`.
actual: the bot replies "no tengo acceso a búsquedas web en este momento". The same bot later fails to save a memory ("la herramienta está bloqueada en este chat").
reproduction: local demo cell (`ocw-demo-openclaw`, OpenClaw 2026.9.7), bot on a ChatGPT subscription (`openai/gpt-6-astra`), internet enabled, ask it to research a company.
started: first use of a ChatGPT-subscription bot with tools in the demo cell. CI smoke passes because the fake model is not code-mode preferred.

## Evidence

- Gateway log for the turn: `[ocw] turn … (tools: web_search,web_fetch,ocw_memory_save)`, so the API granted the tools and the plugin passed them to OpenClaw.
- Same turn: `code-mode: cataloged 3 tools behind exec/wait`.
- Transcript (agent sqlite `transcript_events`): the model called `exec` with `code: "return await web_search({query:'Fichaexpress empresa',count:5});"`. The tool result was `Tool exec is not allowed on this turn.`, `deniedReason: plugin-before-tool-call`. The memory save failed the same way (`exec` wrapping `ocw_memory_save`).
- OpenClaw dist `code-mode-state-*.mjs` `readCodeModeRawConfig`: when `tools.codeMode` is absent globally the default is `"auto"`. `isCodeModeEngagedForModel`: `"auto"` engages for models whose catalog compat says `codeMode: "preferred"` (the ChatGPT models). In code mode the model sees only `exec`/`wait`, and normal tools are reached from JS inside `exec`.
- `exec` is in `DANGEROUS_TOOL_NAMES`, so the OCW call-time gate refuses it. That refusal is correct: code mode is a code-execution sandbox.

## Root cause

OpenClaw 2026.9.7 turns on Code Mode by default (`auto`) for catalog-preferred models. Code Mode hides every tool behind `exec`, and our gate denies `exec` by design. So a ChatGPT-subscription bot with web or memory tools cannot call any of them, and the model tells the user it has no access.

## Fix

Turn Code Mode off explicitly, in two places:
- `infra/openclaw/render-config.mjs`: global `tools.codeMode: false`.
- `apps/openclaw-channel/src/reconciler.ts`: each bot entry gets `tools.codeMode: false`, which overrides `agents.defaults.models.<ref>.codeMode`.

Tools are then exposed as normal function tools and go through the gate one by one, as before. `exec` stays denied.

## Verification

- Red first: the new reconciler test ("Code Mode is off for every bot…") and the render-config assertion failed before the fix (6 reconciler failures, 1 render-config failure) and pass after it.
- `pnpm verify`: 86 test files, 1041 tests pass; lint and typecheck clean (the 4 lint warnings are pre-existing, in `apps/local-runtime`).
- Demo cell rebuilt (`ocw-openclaw:local`) and recreated with the same state volume. Live `openclaw.json`: `tools.codeMode=false` globally and on all 3 bot entries.
- Real turn as `victor@` in the same conversation, "Busca en internet qué es Fichaexpress…": no `code-mode: cataloged` line, and the bot answered from the web with a link to fichaexpress.com.

## Prevention

- Why it was not caught: the CI smoke uses the fake model, whose catalog entry is not `codeMode: "preferred"`, so Code Mode never engaged there.
- Recurrence guard: `reconciler.test.ts` and `render-config.test.mjs` pin `codeMode: false`. Re-check OpenClaw's Code Mode default on every OpenClaw bump.
