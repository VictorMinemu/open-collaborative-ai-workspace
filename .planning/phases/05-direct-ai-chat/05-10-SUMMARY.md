---
phase: 05-direct-ai-chat
plan: 10
subsystem: api, web, contracts
tags: [ai-chat, titles, adr-0014, search, rls, playwright, sidebar]

requires:
  - phase: 05-direct-ai-chat
    plan: 02
    provides: run loop with onAfterFinalize, buildModelMessages, guard.test, fake Responses API, testing-ai harness
  - phase: 05-direct-ai-chat
    plan: 08
    provides: recordUsage (kind title), AiChatPolicy.titleModels, MODEL_PRICES
provides:
  - "ai-chat/titles.ts: heuristicTitle, pickTitleModel, createTitler (after commit, owner credential, ADR-0014 normalize + SessionTitle, conditional update, usage kind 'title', ai_chat.updated)"
  - "buildModelMessages purpose 'title' (TITLE_INSTRUCTIONS, titleUserMessage)"
  - "GET /ai-chats (AiChatListQuery, keyset), PATCH /ai-chats/:id (title, archived), 410 chat_archived on sends and regenerate"
  - "Audits ai_chat.renamed / ai_chat.archived / ai_chat.unarchived ({conversationId} only)"
  - "Test-only POST /test/ai/chats/:id/activity (behind the ChatGPT seed gate)"
  - "Env OCW_AI_TITLE_TIMEOUT_MS (default 20 000 = TITLE_TIMEOUT_MS)"
  - "SearchOverview.aiChats (add-only); search over the owner's AI chats; AI answers authored by their model label"
  - "Web: AiChatHeader (+ AiChatMenu, AiChatMenuItem, AiChatStandardItems, AiChatTitleInput), AiChatsSection, grouped /chat/ai, archived read-only notice, palette 'AI chats' group, results page AI chat groups"
  - "lib/ai-chat-queries: useAiChats, applyAiChatUpdated, useAiChatSummary, updateAiChat; lib/ai-chat-groups"
  - "Fake model: title replies on Responses, chat completions and Anthropic; [[title:<text>]]; slow titles arrive after 4 s unchanged"
  - "testing-ai: subscribeTopic, isTitleRequest, withoutTitles"
affects: [05-11, 05-12, 05-13, 05-15]

actuals:
  tokens: 34360   # chars/4 over added lines of the realized diff, screenshots excluded (137,440 chars)
  tasks: 3
  commits: 11

tech-stack:
  added: []
  patterns:
    - "Post-finalize work: the run-loop hook only registers tenantOf(tx).afterCommit; the job runs in its own transactions"
    - "Menus that are a dropdown at sm+ and a bottom sheet at 390 share item components through a surface context (extraMenuItems stay ReactNode)"
    - "Live list caches: one applyAiChatUpdated for ai_chat.updated and PATCH answers; loaded rows re-sorted onto page 0 so the next cursor stays valid"

key-files:
  created:
    - apps/api/src/modules/ai-chat/titles.ts
    - apps/api/src/modules/ai-chat/titles.int.test.ts
    - apps/api/src/modules/ai-chat/list.int.test.ts
    - apps/web/components/ai-chat/ai-chat-header.tsx
    - apps/web/components/chat/ai-chats-section.tsx
    - apps/web/lib/ai-chat-groups.ts
    - apps/web/lib/ai-chat-groups.test.ts
    - e2e/tests/ai-chat-list.spec.ts
  modified:
    - packages/contracts/src/search.ts
    - packages/contracts/src/chat-workspace.test.ts
    - apps/api/src/modules/ai-chat/{build-model-messages.ts,build-model-messages.test.ts,index.ts,routes.ts,service.ts,generations.ts,usage.ts}
    - apps/api/src/modules/search/{index.ts,service.ts,search.int.test.ts}
    - apps/api/src/modules/model-gateway/index.ts
    - apps/api/src/app.ts
    - apps/api/src/config/{env.ts,env.test.ts}
    - apps/api/src/testing-ai.ts
    - infra/fake-model/{fake-responses.mjs,fake-responses.test.mjs,server.mjs}
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/components/ai-chat/ai-chat-view.tsx
    - apps/web/components/chat/{chat-sidebar.tsx,views/ai-chats-view.tsx}
    - apps/web/components/search/{search-palette.tsx,search-results.tsx}
    - "earlier int tests: ai-chat, usage, stop, regenerate, plan-errors, signin, org-models, providers-secret-ref"

key-decisions:
  - "Titles stream (streamText) instead of generateText: the ChatGPT plan route only accepts stream:true"
  - "Title model must be listed and available for the owner: plan → policy.titleModels.chatgpt_plan, else a 'luna' slug, else the chat's model; org key → policy.titleModels[provider], else the cheapest priced allowed model of that provider, else the chat's model; mock → mock"
  - "A title call that answered is metered as kind 'title' on the title model, even when its answer is refused by SessionTitle; a failed or timed-out call records nothing"
  - "PATCH settings answers 400 settings_unavailable until 05-11, rather than silently ignoring them"
  - "Regenerate on an archived chat is also 410 chat_archived (read-only until unarchived)"
  - "The palette's AI chats group comes after Channels, so existing keyboard order and specs stay unchanged"

requirements-completed: [AICHAT-04]

coverage:
  - id: D1
    description: "First answer → validated, metered title on the chat's own backend and owner credential; typed titles never replaced"
    requirement: AICHAT-04
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/titles.int.test.ts"
        status: pass
      - kind: unit
        ref: "build-model-messages.test.ts, guard.test.ts, infra/fake-model/fake-responses.test.mjs"
        status: pass
      - kind: e2e
        ref: "ai-chat-list.spec.ts › the first answer titles the chat live (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Owner-only list, rename, archive/unarchive, 410 on archived sends"
    requirement: AICHAT-04
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/list.int.test.ts"
        status: pass
      - kind: e2e
        ref: "ai-chat-list.spec.ts › /chat/ai groups … rename and archive (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Search and palette find the owner's AI chats; another member, an admin and another org never do"
    requirement: AICHAT-04
    verification:
      - kind: integration
        ref: "apps/api/src/modules/search/search.int.test.ts › AI chats are found by their owner alone"
        status: pass
      - kind: e2e
        ref: "ai-chat-list.spec.ts › search finds the member's own AI chats … nobody else's (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~150min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 10: AI chat titles, list, rename/archive and owner-only search Summary

**After the first answer, a chat now gets a short generated title (2–5 words, at most 32 characters). The title comes from the chat's own backend, on the owner's credential and that backend's small model: luna on the plan, the cheapest allowed model on an org key. It is normalized and validated per ADR-0014, stored with one conditional update that never replaces a title the member typed, metered as a `title` usage record, and shown live in the header and in the new sidebar "AI chats" section. `/chat/ai` groups the member's chats into Today, Previous 7 days and Older, with rename, archive and an Archived view. An archived chat opens read-only. Search (palette and results page) finds the owner's chats by title and by message text; another member, an admin or another organization never sees them.**

## Accomplishments

- **Titles (Task 1, tracer):**
  - `runLoop.onAfterFinalize` registers an after-commit job, only for the first completed answer.
  - The titler runs in three phases:
    1. Its own tenant transaction rechecks that `title_source = 'heuristic'` and that the requester is the owner, builds the prompt with `buildModelMessages({purpose:"title"})` (the first message only, delimited, nothing personal), picks the title model and resolves it for the owner.
    2. `streamText` with no tools runs under `OCW_AI_TITLE_TIMEOUT_MS`.
    3. A second transaction records `recordUsage(kind:'title', model: titleRef)`, then applies `normalizeSessionTitle` + `SessionTitle`, does the conditional update and emits `ai_chat.updated`.
  - Failures are logged as `{chatId, provider, code}` only.
  - `heuristicTitle` moved from `service.ts` to `titles.ts`.
- **List and management (Task 2):**
  - `GET /ai-chats` uses the resolver's readable set (kind `ai_chat`, archived included), narrowed to `owner_user_id = caller`. It is keyset-paged on `(last_activity_at::text, id)`, and a malformed cursor is 400.
  - `PATCH /ai-chats/:id` handles rename (`title_source 'user'`) and archive (`conversations.archived_at`). Real changes only are audited by id and announced.
  - Sends and regenerate on an archived chat answer 410 `chat_archived`.
- **Search (Task 3):** search asks `readableIds` for `ai_chat`; the resolver keeps each chat its owner's. `searchAiChats` (contains or trigram over the owner's titles, archived ones flagged) fills `SearchOverview.aiChats`. Answers in AI chats are authored by their model label (`gateway.labelOf`), never "System".
- **Web:**
  - `AiChatHeader`: click-to-rename (Enter saves, Escape cancels, blur saves) and a menu that is a dropdown at sm+ and a sheet at 390. It has an `extraMenuItems` slot for 05-11 and 05-13.
  - `AiChatsSection`: under the views, it shows the 5 most recent chats, New chat and See all.
  - `/chat/ai`: date groups, a Recent/Archived toggle, a row menu (also on long-press at 390), and the bot DMs below under "Bots" with unchanged test ids.
  - Live updates: `ai_chat.updated` handling sits in the sidebar's existing `user:` listener.
  - Search: the palette has an "AI chats" group, AI chat message hits have a Sparkles icon and open `/chat/ai/<id>`, and the results page groups hits under the chat title with an "AI chat" tag.

## Task Commits

1. **Task 1 (tracer):** `82278a4` test (RED), `31dbef6` feat (API titles, fake, env, earlier tests ignore title calls)
2. **Task 2:** `305abe4` test (RED list.int), `6f0ae35` feat (list/patch/410/test route)
3. **Web for Tasks 1 and 2:** `39502ed` test (e2e + group unit), `a3b2471` feat (header, sidebar section, list, archived notice, slow fake title)
4. **Task 3:** `feae22d` test (RED contract + search.int), `640cc87` feat (API search), `db052c9` test (e2e search), `0c2a8d1` feat (palette, results page)
5. **Regression race fix:** `658be72` test (earlier suites read the chat usage record only)

## Verification

- **Unit:** build-model-messages + guard pass 25/25. env + ai-chat unit pass 37/37. chat-workspace passes 26/26. The web `ai-chat-groups` test passes 2/2.
- **Node:** `node --test infra/fake-model/*.test.mjs` passes 62/62.
- **Integration (ephemeral PG + Redis, one file at a time):**
  - New suites: titles.int 7/7, list.int 7/7, search.int 27/27 (4 new; every existing assertion unchanged).
  - Regressions: ai-chat 20, usage 16, regenerate 6, stop 8, plan-errors 12, signin 22, org-models 13, providers-secret-ref 12.
  - RED was recorded first for titles, list, search and the contract.
- **`pnpm typecheck --force`:** 8/8. **`pnpm verify`:** exit 0. Lint shows 4 warnings, all pre-existing in `apps/local-runtime`. Tests: **162 files, 2212 tests, all pass**.
- **Isolated e2e:**
  - `--rebuild-web ai-chat-list ai-chat.spec chat-sidebar`: 15/15.
  - The final broad run, `--rebuild-web ai-chat search personal-bots team-bot-dm chat-sidebar` (every ai-chat-* spec plus the search, bots and sidebar regressions, on desktop and mobile), passed **65/65** with no skips, flakes or retries.
  - The last commit changed tests only, so no further e2e run was needed.
- **Acceptance greps:** all print:
  - `titleSource, "heuristic"` in titles.ts
  - `onAfterFinalize` in index.ts
  - `AiChatListQuery` in routes.ts
  - `chat_archived` in service.ts
  - `aiChats` in search.ts
  - `"ai_chat"` in search index.ts and service.ts
- **Screenshots reviewed with Read:**
  - `ai-chat-title-live-1440`, `sidebar-ai-chats-390-dark`, `ai-chats-list-1440(-dark)`, `ai-chats-list-390`, `ai-chat-rename-390`, `ai-chat-renamed-1440`
  - `search-ai-chats-1440`, `search-ai-chats-390-dark`, `search-ai-chats-results-1440`, `-390`
  - Human check: the AI chats group reads as the member's own space ("Your AI chat · model · time", brand Sparkles tile), distinct from channels and people.
  - One fix came from the review: the fake's slow titles had counting appended ("Count to forty 1 2"). They now arrive late but unchanged.
  - Regression screenshots overwritten by other specs were reverted or removed.
- **Safety:**
  - No real provider was called, no migration was added and `db:migrate` was never run.
  - `.env` was symlinked only for the harness and then removed.
  - The demo and the other worktrees were not touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/Spec] Titles use `streamText`, not `generateText`.** The plan route (and its fake) refuses non-streaming requests. The guard is unchanged: titles.ts imports from "ai" and calls `buildModelMessages(`.

**2. [Rule 3 - Blocking] Files outside `files_modified`:**
- `usage.ts`: optional `model` so a title record carries the title model and its price.
- `config/env.ts`: `OCW_AI_TITLE_TIMEOUT_MS`, so the integration test can shorten the 20 s deadline.
- `generations.ts`: 410 on regenerate.
- `model-gateway/index.ts`: exports `chatgptPlanSeedEnabled`.
- `app.ts`: passes `labelOf` to search.
- `testing-ai.ts`: `subscribeTopic`, `isTitleRequest`, `withoutTitles`.
- `infra/fake-model/server.mjs`: title replies on chat completions and Anthropic.
- `chat-sidebar.tsx`: the section and the live listener.
- Commits 31dbef6, 6f0ae35, 640cc87, a3b2471.

**3. [Rule 1 - Regression] Earlier integration suites counted every fake request and usage record.** Titles add one request and one `title` record per first answer, asynchronously. Assertions about chat calls now use `withoutTitles(...)` and `kind = 'chat'`, and `usage.int`'s `turn()` waits for the title record before reading counters. No assertion was weakened for chat behaviour. Commits 31dbef6, 658be72.

**4. [Order] The list route shipped with the Task 2 API, before the Task 1 web.** The Task 1 sidebar needs `GET /ai-chats`. The web for Tasks 1 and 2 was built and tested together.

**5. [Rule 2 - Test seam] Test-only route `POST /test/ai/chats/:id/activity`.** This is the e2e's "API seed helper" for the date groups. It is owner-only and behind the same gate as the ChatGPT seed (never mounted in production).

**6. [Spec detail] Two refusal cases.** "40 characters" is tested as a two-word 41-character answer whose word-boundary cut leaves one word. A 40-character answer with several words would legitimately be cut into a valid title by ADR-0014's normalizer.

**7. [UX] On phones, rows also show a ⋯ button** next to long-press, so the actions are discoverable.

## Known Stubs

- PATCH `settings` answers 400 `settings_unavailable` until 05-11, which owns chat settings.

## Windows Ledger

No entries: there are no stubs that block the goal, no skipped tests, no unrun verifies and no open deviations. No `gsd windows append` is needed.

## Threat Flags

None beyond the plan's threat model:
- T-05-10-01: owner-only readable set, with tests for Alex, the admin and org B.
- T-05-10-02: normalize + `SessionTitle`, and titles render as text.
- T-05-10-03: `resolve(…, ownerId)`, with the requester checked to be the owner.
- T-05-10-04: audits carry the id only.
- T-05-10-05: first answer only, while the title is heuristic, metered, with a deadline.

The test-only route is gated like the existing seed route.

## Issues / Notes

- On `/chat/ai`, bot DMs now sit below the member's chats, which are paged by 30. A member with many chats scrolls further to reach the bots, as the plan's layout requires.
- On the results page, AI answers use the generic agent (bot) avatar next to the model label. A model-specific avatar could follow in a later plan.

## Self-Check: PASSED

- Files exist: titles.ts, titles.int.test.ts, list.int.test.ts, ai-chat-header.tsx, ai-chats-section.tsx, ai-chat-groups.ts, ai-chat-list.spec.ts.
- Commits found: 82278a4, 31dbef6, 305abe4, 6f0ae35, 39502ed, a3b2471, feae22d, 640cc87, db052c9, 0c2a8d1, 658be72.
