---
phase: 05-direct-ai-chat
plan: 11
subsystem: api, web, contracts, fake-model
tags: [ai-chat, web-search, searxng, instructions, preferences, tools, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 02
    provides: buildModelMessages (personal → chat order, labels, humanMembers rule), turn.ts seam, run loop
  - phase: 05-direct-ai-chat
    plan: 08
    provides: AiChatPolicy.webEnabled, Settings › Models › AI chats policy UI
  - phase: 05-direct-ai-chat
    plan: 10
    provides: PATCH /ai-chats/:id, AiChatHeader.extraMenuItems, withoutTitles
provides:
  - "Gateway: ResolvedModel.hostedTools (plan web_search), caps.webSearch per backend and credential, capsOf, 24 h plan refusal marker"
  - "ai-chat/tools-state.ts: toolStates, webAllowed, webUnavailableReason; model-gateway/policy.ts: webPolicyReason"
  - "ai-chat/web-tools.ts: searxngWebSearchTool, sourceDomain, UNTRUSTED_PREFIX"
  - "ai-chat/prefs.ts: GET/PUT /me/ai-preferences, loadPreferences"
  - "PATCH /ai-chats/:id settings (instructions, usePersonalInstructions, tools); new chats take the member's Web default"
  - "Run loop: web_used, source_domains (≤ 20), audit ai_generation.web_used"
  - "Audits ai_generation.web_used, ai_preferences.updated, ai_chat.settings_updated (keys/domains only)"
  - "Contracts (add-only): AI_TOOL_LABELS, aiToolStates(), AiModelList.tools"
  - "Fake: hosted web search with url_citation on /v1/responses ([[web <q>]]); SearXNG requests reported as kind search"
  - "Web: ToolsMenu/ToolsList/WebChip, source chips, ChatSettingsSheet, PreferencesCard, lib/ai-tools"
  - "testing-ai: startSecondInstance(stack, envOverrides)"
affects: [05-12, 05-13, 05-15]

actuals:
  tokens: 28000   # chars/4 over added lines of the realized diff, screenshots excluded (112,041 chars)
  tasks: 3
  commits: 13

tech-stack:
  added: []
  patterns:
    - "Tool availability is one rule (policy → resolver → model support) used for the UI state and at every turn"
    - "Provider-executed tools come from the gateway (only it imports @ai-sdk/*); API-executed tools live in ai-chat"
    - "Untrusted tool output: labelled prefix, capped fields, no side effects, never published as deltas"

key-files:
  created:
    - apps/api/src/modules/ai-chat/tools-state.ts
    - apps/api/src/modules/ai-chat/web-tools.ts
    - apps/api/src/modules/ai-chat/web-tools.test.ts
    - apps/api/src/modules/ai-chat/prefs.ts
    - apps/api/src/modules/ai-chat/tools.int.test.ts
    - apps/web/components/ai-chat/tools-menu.tsx
    - apps/web/components/ai-chat/chat-settings-sheet.tsx
    - apps/web/components/ai-chat/settings/preferences-card.tsx
    - apps/web/lib/ai-tools.ts
    - apps/web/lib/ai-tools.test.ts
    - e2e/tests/ai-chat-tools.spec.ts
  modified:
    - packages/contracts/src/ai-chat.ts
    - apps/api/src/modules/model-gateway/{index.ts,policy.ts,routes.ts}
    - apps/api/src/modules/ai-chat/{turn.ts,run-loop.ts,build-model-messages.ts,build-model-messages.test.ts,service.ts,dto.ts,index.ts}
    - apps/api/src/testing-ai.ts
    - infra/fake-model/{fake-responses.mjs,fake-responses.test.mjs,server.mjs,server.d.mts}
    - apps/web/components/ai-chat/{ai-composer.tsx,ai-chat-view.tsx,ai-message.tsx}
    - apps/web/app/(app)/settings/ai-chat/page.tsx
    - apps/web/lib/ai-chat-queries.ts

key-decisions:
  - "Web state = organization policy (disabled_by_org) → ai_chat.web through the resolver (denied) → model support (plan: not_supported_by_model; org/mock without SearXNG: search_not_configured); checked again at every turn"
  - "A plan model that refuses web_search (unsupported_capability, param web_search) is marked for that credential for 24 h in Redis: Web shows why instead of failing every turn"
  - "Source chips link to the first page of that domain the answer cites, else the domain's home page: generations store domains only and no migration was added"
  - "No web fetch tool (SSRF): the API only ever calls the operator's SearXNG URL"
  - "SearXNG search on org keys is not metered (self-hosted); no provider-hosted search is ever attached on an org key, so no METERED tool label was needed"
  - "The Web toggle is sticky per chat (the send's choice is stored on the chat); new chats take the member's Web default"

requirements-completed: [AICHAT-05, AICHAT-06]

coverage:
  - id: D1
    description: "Web on a plan model: hosted web_search only, sources recorded, audited, chips shown; refusal marks the model for that member"
    requirement: AICHAT-06
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/tools.int.test.ts › Web on a ChatGPT-plan model"
        status: pass
      - kind: unit
        ref: "infra/fake-model/fake-responses.test.mjs › hosted web search; apps/web/lib/ai-tools.test.ts"
        status: pass
      - kind: e2e
        ref: "ai-chat-tools.spec.ts › the tools menu offers four toggles; Web on a ChatGPT-plan answer shows its source (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Org keys and the mock search through SearXNG only; deny rule, policy off and missing SearXNG each disable Web with its reason"
    requirement: AICHAT-06
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ai-chat/web-tools.test.ts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/tools.int.test.ts › Web on organization keys and the mock"
        status: pass
      - kind: e2e
        ref: "ai-chat-tools.spec.ts › on other models Web searches the self-hosted SearXNG; an admin can turn it off (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Personal and per-chat instructions in a fixed labelled order, never with a second human; defaults for new chats"
    requirement: AICHAT-05
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ai-chat/build-model-messages.test.ts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/tools.int.test.ts › personal and per-chat instructions"
        status: pass
      - kind: e2e
        ref: "ai-chat-tools.spec.ts › personal instructions and defaults …; both persist (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~140min
completed: 2026-10-07
status: complete
---

# Phase 5 Plan 11: Instructions, preferences and the four tool toggles (only Web works) Summary

**The composer has a "+" tools menu: Web, Company Knowledge, MCP and Skills. Only Web works; the other three are visibly disabled with "Not available yet". On the member's ChatGPT plan, Web uses the plan's hosted search. On organization keys and the mock, it uses the self-hosted SearXNG. Answers that searched show their source domains as chips. When Web can't run, the menu says why in words: the admin turned it off, the member's role doesn't allow it, the search service isn't set up, or the model can't search on this plan. Members set personal instructions, a default model and "Web on by default" in Settings › AI chat. Each chat has its own instructions and an "Also use my personal instructions" switch. The model receives them in a fixed, labelled order, and personal instructions never go to a chat with other people.**

## Accomplishments

- **Web on the plan (Task 1, tracer):**
  - The gateway adds `hostedTools.web_search` (`provider.tools.webSearch()`) for plan models whose `caps.webSearch` is "hosted".
  - When a plan refuses `web_search`, `reportFailure` sets a 24 h marker for that credential and model. The model then lists `webSearch: "none"`, for that member only.
  - `turn.ts` attaches the tool only when the chat has Web on and `webAllowed` holds. It adds `stopWhen: stepCountIs(AI_MAX_STEPS)` and the web note to the instructions.
  - The run loop turns `source` parts into hostnames (deduplicated, at most 20) and counts `web_search` calls. It writes `web_used` and `source_domains` at finalize and audits `ai_generation.web_used` as `{generationId, domains, searches}`. None of this is ever published as a delta.
- **SearXNG on organization keys and the mock (Task 2):**
  - `searxngWebSearchTool` calls `GET <OCW_AI_SEARXNG_URL>/search?q=&format=json` with an 8 s timeout.
  - It returns the top 5 results, with titles up to 200 characters and snippets up to 300, prefixed `Untrusted web search results …`.
  - After 5 searches in one answer it returns "Search limit reached" without fetching. A timeout or an error status becomes a plain "Search failed" result.
  - It has no side effects. No provider-hosted search is ever attached on an organization key.
- **Disabled states:** `toolStates` / `webAllowed` apply three checks in order:
  1. `policy.webEnabled` → `disabled_by_org`
  2. `ai_chat.web` decided by the resolver → `denied`
  3. model support → plan: `not_supported_by_model`; org/mock without SearXNG: `search_not_configured`

  `GET /ai-chat/models` now carries the member-wide `tools`, so a new chat can explain them before any chat exists.
- **Instructions and preferences (Task 3):**
  - `GET/PUT /me/ai-preferences` works per caller. A default model must be available when it is saved.
  - `PATCH /ai-chats/:id` `settings` now applies instructions, the personal switch and tools; it no longer answers `settings_unavailable`.
  - Audits list changed keys only.
  - New chats take the member's Web default.
  - The 05-02 builder already had the order (preamble → web note → personal → chat), the labels and the one-human rule; the tests now lock them.
- **Web:**
  - `ToolsMenu`: a popover at sm+, a sheet at 390, with the reason under each disabled switch.
  - An active "Web" chip with a ×.
  - Source chips use `safeUrl`, open in a new tab with `noopener noreferrer nofollow`, and load no favicons.
  - `ChatSettingsSheet`, opened from the header menu's "Chat settings": a side sheet on desktop, a bottom sheet at 390.
  - `PreferencesCard` sits between the ChatGPT plan card and Usage.

## Task Commits

1. **Task 1 (tracer):** `6aa32fd` test RED (fake + tools.int), `25b9f6e` feat (gateway, tools-state, turn, run loop, fake), `cfeb49c` test (e2e + web helpers), `016d616` feat (tools menu, chip, source chips)
2. **Task 2:** `5e5c3d6` test RED (web-tools + tools.int), `d102931` feat (SearXNG tool), `cb7f3f7` test (e2e)
3. **Task 3:** `546fd13` test RED (tools.int + builder), `69150e9` feat (prefs, PATCH settings), `747e1be` feat (sheet, preferences card), `0bbc360` test (e2e)
4. `c506e1d` style (biome format)

## Verification

- **Unit:** web-tools passes 5/5; build-model-messages + guard pass 28/28; web `ai-tools` passes 5/5; ai-chat, model-gateway and contracts unit suites pass 280/280.
- **Node:** `node --test infra/fake-model/fake-responses.test.mjs` passes 20/20 (2 new).
- **Integration:** `tools.int.test.ts` passes **17/17** on ephemeral PG + Redis: 4 plan, 6 SearXNG/disabled, 7 instructions/preferences. RED was recorded first for Tasks 1 and 2 and for Task 3's API.
- **`pnpm typecheck --force`:** 8/8.
- **`pnpm verify`:**
  - Lint passes with 4 pre-existing warnings in `apps/local-runtime`, and typecheck passes.
  - Tests: 165 of 166 files passed (2,229 tests). `artifact/attachments.int.test.ts` failed on load: the Garage testcontainer's ports weren't bound within 10 s. Retried once on its own, it passed 25/25.
  - Total: **166 files, 2,254 tests pass**.
- **Isolated e2e (desktop + mobile, no skips, flakes or retries):**
  - `--rebuild-web ai-chat-tools`: 3/3, including setup.
  - `ai-chat-tools bot-capabilities`: 9/9.
  - `--rebuild-web ai-chat-tools ai-chat-list`: 13/13.
  - Final regression `--rebuild-web ai-chat bot-capabilities` covers every ai-chat-* spec and bot-capabilities on desktop and mobile: **62/63**.
  - The failure was `ai-chat-list` › "titles the chat live" on desktop. It is a pre-existing 05-10 flake: the random tag `Zq<d><5 base36>` sometimes has no digit, and ADR-0014's sentence case then lowercases it ("Plan the zqddfdyy"). Rerun once, `ai-chat-list` passed 7/7.
- **Acceptance greps:** all print:
  - `hostedTools` in gateway and turn
  - `not_available_yet` in tools-state
  - `export function searxngWebSearchTool`
  - `format: "json"`
  - `"/me/ai-preferences"`
  - `humanMembers` in build-model-messages
- **Screenshots reviewed with Read:**
  - `ai-tools-menu-1440`, `ai-tools-menu-390-dark`, `ai-chat-web-sources-1440`, `ai-chat-web-sources-390`, `ai-tools-web-disabled-1440`, `ai-tools-web-disabled-390`, `ai-chat-settings-sheet-390`, `ai-chat-settings-sheet-1440`, `settings-ai-chat-preferences-1440-dark`, `settings-ai-chat-preferences-390`.
  - Human check: the sheet says "These apply to this chat only" and the card says "Defaults for every AI chat you start". The phone textarea is full width, at least 9 rem tall (`min-h-36`), with 15 px text.
  - Regression screenshots overwritten by other specs were reverted or removed.
- **Safety:**
  - No real provider or SearXNG was called; fakes only.
  - No migration was added and `db:migrate` was never run.
  - The demo and other worktrees were not touched.
  - `.env` was symlinked for the harness only and removed at the end.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing state] Member-wide tool state before a chat exists.** The new-chat composer has no `AiChatDetail`, so it could not tell "turned off by your admin" or "not allowed for your role". Fixes:
- Contracts (add-only): `AiModelList.tools` (optional), plus `AI_TOOL_LABELS` and `aiToolStates()` shared by the API and the web.
- `webPolicyReason` lives in `model-gateway/policy.ts`, so the models route and `tools-state.ts` share the rule without an ai-chat ↔ gateway import cycle.
- Commits 25b9f6e, 016d616.

**2. [Interface] Signature changes to the planned interfaces:**
- `toolStates` takes `{userId, policy, perms, gateway, chat, model: ModelRef | null}`. It has no `req`: `perms.decide` works with or without a request.
- `ModelGateway.capsOf(tx, ref, userId)` is new. It returns caps without resolving the model, so there is no token or catalog call.
- `searxngWebSearchTool.onSearch` receives the result domains (`string[]`), not a count. The run loop needs the domains for `source_domains`.

**3. [Rule 3 - No migration] Source chip links.** Generations store domains only. Each chip links to the first page of its domain that the answer cites (Markdown links, then bare URLs), else to `https://<domain>/`. The fake cites inline, as the real Responses API does. A `sources` column would need a migration.

**4. [Memory] The "without SearXNG" case does not start a second `startAiStack`.** It uses a second API instance on the same PostgreSQL and Redis, with `OCW_AI_SEARXNG_URL`/`OCW_SEARXNG_URL` set to null; `startSecondInstance` gained env overrides. This avoids two more containers on a memory-constrained machine. The behaviour checked is the same.

**5. [Test seam] Fake SearXNG requests are reported to `onRequest` as kind `search`** (`server.mjs`, `server.d.mts`), so the integration test can assert `/search?q=ocw&format=json`. Without a `web_search` tool, `[[web …]]` is stripped like any other directive and the reply is a plain echo; that is how "echoed as text" was read.

**6. [TDD note] The new builder tests passed at once.** 05-02 had already built the order, the labels and the one-human rule, and Task 1 built the web note. They lock behaviour rather than drive it.

**7. [Error code] An unavailable default model on `PUT /me/ai-preferences` is 400 `model_unavailable`.**

**8. [E2E isolation] The spec restores what it changes:**
- It marks the ChatGPT welcome as seen in `beforeAll`, so the one-time modal doesn't cover Settings › AI chat.
- It restores `webEnabled` and Sam's preferences in `finally`, so later specs keep their defaults.

**9. [Scope] Files outside `files_modified`:** contracts `ai-chat.ts`, `model-gateway/{policy,routes}.ts`, `testing-ai.ts`, `infra/fake-model/{server.mjs,server.d.mts}`, `apps/web/lib/ai-tools.ts` (+ test). `tools-menu.tsx` also exports `ToolsList`, `useWebReason` and `WebChip` for the settings sheet.

## Known Stubs

None that block the goal. Company Knowledge, MCP and Skills are intentionally visible but disabled ("Not available yet", P-14) and never reach a model.

## Windows Ledger

No entries: no blocking stubs, no skipped tests, no unrun verifies and no open deviations. No `gsd windows append` is needed.

## Threat Flags

None beyond the plan's threat model:
- T-05-11-01: labelled, capped results with no side-effecting tools.
- T-05-11-02: no fetch tool; only the operator's SearXNG URL is called.
- T-05-11-03: `webAllowed` at every turn, with deny and policy tests.
- T-05-11-04: an int test asserts the Anthropic org key gets only the function tool.
- T-05-11-05: changed keys only in audits; one-human rule unit test.

`/me/ai-preferences` is per caller and needs `ai_chat.use`.

## Issues / Notes

- A plan model's web refusal marker lasts 24 h per credential. A member who upgrades their plan within that window sees "This model can't search the web on your plan" until it expires.
- Search counts are model `web_search` calls, including one refused at the 5-search limit.
- Out of scope, not fixed: `e2e/tests/ai-chat-list.spec.ts` `tagOf` should always contain a digit, or the expectation should apply `normalizeSessionTitle`; otherwise about 1 run in 5 fails on desktop or mobile (05-10).

## Self-Check: PASSED

- Files exist: tools-state.ts, web-tools.ts (+ test), prefs.ts, tools.int.test.ts, tools-menu.tsx, chat-settings-sheet.tsx, preferences-card.tsx, lib/ai-tools.ts, ai-chat-tools.spec.ts.
- Commits found: 6aa32fd, 25b9f6e, cfeb49c, 016d616, 5e5c3d6, d102931, cb7f3f7, 546fd13, 69150e9, 747e1be, 0bbc360, c506e1d.
- Acceptance greps print.
