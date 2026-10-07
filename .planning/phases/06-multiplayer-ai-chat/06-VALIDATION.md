---
phase: "06"
slug: "multiplayer-ai-chat"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6; Plan 06-16 Task 2 signs off)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
validated: "2026-10-07"
manual_pending: human_needed   # 06-16 Task 3: metered eval + OpenAI terms check deferred to the owner ("eval deferred")
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Sources: `06-RESEARCH.md` §Validation Architecture and §Security Domain, `06-CONTEXT.md` (D-01 … D-08), planner decisions P-01 … P-16 in `06-01-PLAN.md`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5 — projects `unit`, `integration` (testcontainers PostgreSQL 18 + Redis 8, Garage from `apps/api/src/testing-storage.ts`, the fake model started in-process by `apps/api/src/testing-ai.ts`, `FakeCellPlugin` against the Agent Channel API) and `web`; `node --test` for `infra/**`; `pnpm --filter @ocw/openclaw-channel test` for the cell plugin; Playwright (`setup` → `desktop` 1440×900, `mobile` 390×844) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <files>` · `pnpm exec vitest run --project integration <file>` (one file at a time: memory) · `pnpm exec vitest run --project web <files>` · `node --test infra/fake-model/<file>.test.mjs` · `pnpm --filter @ocw/openclaw-channel test` |
| **Full suite command** | `pnpm verify && pnpm typecheck --force && pnpm --filter @ocw/openclaw-channel test && node --test 'infra/**/*.test.mjs'` |
| **E2E** | `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/06-multiplayer-ai-chat/screenshots bash scripts/e2e-isolated.sh [--rebuild-web] <spec filters>` (isolated: DB `ocw_e2e`, Redis DB 9, API :4290, web :3290, fake model/MCP/ClawHub :4291, Garage :4292 in compose project `ocw-e2e-storage`; `OCW_MODEL_PROVIDER=mock`; never the demo) |
| **No real providers** | Every test, e2e and executor command talks only to `infra/fake-model`. The metered spoofing eval (`pnpm --filter @ocw/api eval:multiplayer`) runs only when the owner opts in with `OCW_EVAL_CONFIRM=metered` and their own key (D-02), or in CI behind the `ai-eval` label / weekly schedule / dispatch once GitHub Actions billing is restored. CI is unavailable today: every gate runs locally. |
| **Estimated runtime** | ~340 s (verify), ~1,300 s (full e2e, both projects) |

---

## Sampling Rate

- **After every task commit:** the task's quick unit/integration/web/node command for the touched module (listed per task below).
- **After every plan wave:** `pnpm verify` (+ `pnpm typecheck --force` after any contract change).
- **Before `/gsd-verify-work 6`:** full suite command + full isolated e2e (desktop + mobile) green; owner checkpoint of 06-16 answered.
- **Max feedback latency:** 340 seconds (per-task commands; the full e2e is the phase gate).

---

## Per-Task Verification Map

E2E commands run as `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/06-multiplayer-ai-chat/screenshots bash scripts/e2e-isolated.sh <filters>`; "❌ task" = the task creates the test file first (TDD RED), "✅" = the file exists before the task.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 (tracer) | 01 | 1 | MULTI-01, MULTI-02, MULTI-04, AGENT-01, AGENT-04, P-01, P-02 | T-06-01-01/02/03/04 | Four new tables FORCE RLS (cross-tenant invisible as `ocw_app`); one active grant per subject; org subject without id; unit agents RESTRICT; Open targets internal only | unit + integration | `vitest --project unit ai-chat.test contracts.test permissions.test`; `pnpm typecheck --force`; `vitest --project integration rls-isolation.int`; no `*_multiplayer_ai_check` dir | ✅ | ✅ green |
| 06-01-02 [BLOCKING] | 01 | 1 | P-02 | T-06-01-05 | Schema final; older migrations untouched; Phase 5 suites green on it | integration + git | `vitest --project integration secret-ref-migration.int role-migration.int`, `ai-chat.int`; `git diff` limited to `*_multiplayer_ai` | ✅ | ✅ green |
| 06-02-01 (tracer) | 02 | 2 | MULTI-01, MULTI-02, MULTI-03, MULTI-06, D-01, D-03, D-04, D-06 | T-06-02-01/02/03/05/06/07/08/09 | Person grant → read/subscribe/write; requester's own plan; attributed prompt; no personal instructions once shared; Phase 5 snapshots byte-identical | unit + integration | `vitest --project unit build-model-messages.test`; `vitest --project integration ai-chat/multiplayer.int`; `git diff --quiet <base> -- ai-chat/__snapshots__` | ✅ | ✅ green |
| 06-02-02 | 02 | 2 | MULTI-01, P-04, P-05 | T-06-02-04/05 | Manage/share owner-only; stop requester-or-owner; regenerate owner-or-requester on caller's backend; view grants read-only; admin/other tenant 404; solo 409 unchanged | unit + integration | `vitest --project unit resolve.test ai-chat/guard.test`; `vitest --project integration ai-chat/multiplayer.int`, `stop.int`, `shares.int`; `pnpm verify` | ✅ | ✅ green |
| 06-03-01 (tracer) | 03 | 3 | MULTI-01, MULTI-08, D-03, D-04, D-08 | T-06-03-02/03/04 | Scenario B 1–4 in two browsers; disclosure text; fake attributed replies; no real provider | node + e2e | `node --test infra/fake-model/attribution.test.mjs fake-responses.test.mjs server.test.mjs`; e2e `--rebuild-web ai-chat-multiplayer ai-chat.spec ai-chat-share` | ✅ | ✅ green |
| 06-03-02 | 03 | 3 | MULTI-01, D-01, P-04 | T-06-03-01 | Grantee composer defaults to own model; Can view read-only; owner-only actions hidden | e2e | e2e `--rebuild-web ai-chat-multiplayer ai-chat-models ai-chat-list`; `pnpm verify` | ✅ | ✅ green |
| 06-04-01 (tracer) | 04 | 3 | MULTI-01, D-03 | T-06-04-01/02/03/05/06 | Team/department/org grants via one `aiAccessSql`; level change; revoke closes streams within ADR-0009 bounds; notices + audits; no flood | integration | `vitest --project integration ai-chat/grants.int`, `ai-chat/multiplayer.int` | ✅ | ✅ green |
| 06-04-02 | 04 | 3 | MULTI-01 | T-06-04-04 | Search and files follow grants; view grantees cannot upload; outsiders 404 | integration (Garage) | `vitest --project integration search/search.int`, `ai-chat/attachments.int`; `pnpm verify` | ✅ | ✅ green |
| 06-05-01 (tracer) | 05 | 3 | MULTI-03, MULTI-05, MULTI-07, D-04, D-06 | T-06-05-01/04 | Persona blocks, file labels, notices, withheld in turn context; six spoof cases as free prompt fixtures; no name-colon templates, no system role outside the builder | unit | `vitest --project unit build-model-messages.test ai-chat/guard.test`; snapshots unchanged | ✅ | ✅ green |
| 06-05-02 | 05 | 3 | MULTI-03, MULTI-05 | T-06-05-02/03 | Plan Responses, OpenAI key, Anthropic key, openai-compatible wire shapes; instructions identical across requesters; requester without Web gets no tools + withheld | integration | `vitest --project integration ai-chat/prompt-matrix.int`, `ai-chat/tools.int`; `pnpm verify` | ✅ | ✅ green |
| 06-06-01 (tracer) | 06 | 3 | MULTI-04, D-01, D-05 | T-06-06-01/02/06 | Addressing; queue never 409 in shared chats; next turn in the finalize tx on the first waiting author's plan; coalescing; skips with reasons; solo 409 unchanged | integration | `vitest --project integration ai-chat/queue.int`, `ai-chat/ai-chat.int` | ✅ | ✅ green |
| 06-06-02 | 06 | 3 | MULTI-04, P-08 | T-06-06-03/04/05 | Stop lets the queue continue; regenerate waits for the queue; sweeper pickup via ids-only SECURITY DEFINER; two instances | integration (2 instances) | `vitest --project integration ai-chat/queue.int`, `stop.int`, `regenerate.int`; `pnpm verify` | ✅ | ✅ green |
| 06-07-01 (tracer) | 07 | 3 | AGENT-01, D-07 | T-06-07-01/02/03/04/05 | Leads create/configure personas only in their units; unit visibility; mention gate; unit deletion guard | unit + integration + e2e | `pnpm typecheck --force`; `vitest --project unit resolve.test`; `vitest --project integration agent/personas.int`; e2e `--rebuild-web agent-personas bots.spec personal-bots` | ✅ | ✅ green |
| 06-07-02 | 07 | 3 | AGENT-01 | — | Scope/owner in the bot detail; one-click and personal bots unchanged | integration + e2e | `vitest --project integration agent/personas.int`; e2e `--rebuild-web agent-personas bot-capabilities team-bot-dm`; `pnpm verify` | ✅ | ✅ green |
| 06-08-01 (tracer) | 08 | 4 | MULTI-01, MULTI-02, P-09 | T-06-08-01/03/04/05 | Direct share notifies the person only; inbox follows readability; unread + read marker joins; mentions notify readers only | integration + e2e | `vitest --project integration ai-chat/shared.int`, `notification/notifications.int`; e2e `--rebuild-web ai-chat-shared-inbox notifications unread ai-chat-list` | ✅ | ✅ green |
| 06-08-02 | 08 | 4 | MULTI-02 | T-06-08-02 | Per-recipient live summaries; solo payload unchanged; wave regressions | integration + e2e | `vitest --project integration ai-chat/shared.int`, `titles.int`, `list.int`, `notification/prefs.int`, `chat/unread.int`; e2e `notification-prefs chat-sidebar ai-chat-multiplayer ai-chat-shared-inbox`; `pnpm verify` | ✅ | ✅ green |
| 06-09-01 (tracer) | 09 | 4 | MULTI-07, D-02 | T-06-09-01/02/03/04 | Opt-in metered runner (confirm + key), deterministic grader, key never printed; executors use the fake / dry run only | unit + command | `vitest --project unit eval/multiplayer/eval.test ai-chat/guard.test`; dry run `OCW_EVAL_DRY_RUN=1 OCW_EVAL_CONFIRM=metered OCW_EVAL_API_KEY=dry-run-not-a-key pnpm --filter @ocw/api eval:multiplayer` | ✅ | ✅ green |
| 06-09-02 | 09 | 4 | MULTI-07, D-02 | T-06-09-02 | Workflow on label/weekly/dispatch only, skipped without the secret, never on push | unit | `vitest --project unit eval/multiplayer/eval.test`; `pnpm verify` | ✅ | ✅ green |
| 06-10-01 (tracer) | 10 | 5 | AGENT-02, D-07, P-10 | T-06-10-03/04/05 | Persona added by the owner answers mentions flat via OpenClaw with attributed history; channels/DMs unchanged | integration + plugin | `vitest --project integration agent-channel/ai-chat-delivery.int`, `agent-channel.int`, `chat/group-dm.int`; `pnpm --filter @ocw/openclaw-channel test` | ✅ | ✅ green |
| 06-10-02 | 10 | 5 | MULTI-05, MULTI-06, D-06 | T-06-10-01/02 | Scoped tools only when every participant may use them, never with unit/org grants; withheld explained; no memory in AI chats | integration + plugin | `pnpm typecheck --force`; `vitest --project integration agent-channel/ai-chat-delivery.int`, `tool-calls.int`, `bot-capabilities/memory.int`; plugin tests; `pnpm verify` | ✅ | ✅ green |
| 06-11-01 (tracer) | 11 | 6 | MULTI-02, MULTI-04, MULTI-08, D-01, D-05 | T-06-11-01/02 | Typing, queue chip, coalesced answer with "for X · X's plan", requester-only Stop, live "no longer have access" | web + e2e | `vitest --project web ai-chat-stream.test ai-format.test`; e2e `--rebuild-web ai-chat-multiplayer ai-chat-stop ai-chat.spec` | ✅ | ✅ green |
| 06-11-02 | 11 | 6 | MULTI-04, P-08 | T-06-11-03 | Ask AI toggle and @ suggestions; solo composer unchanged | e2e | e2e `--rebuild-web ai-chat-multiplayer ai-chat-tools ai-chat-attachments`; `pnpm verify` | ✅ | ✅ green |
| 06-12-01 (tracer) | 12 | 7 | MULTI-01, D-03, D-08 | T-06-12-01/02 | Share with team/department/org, level change, removal with confirmation; participants with presence; AI chats page "Shared with me" | e2e | e2e `--rebuild-web ai-chat-share-people ai-chat-share ai-chat-list` | ✅ | ✅ green |
| 06-12-02 | 12 | 7 | AGENT-02 | T-06-12-03 | Owner adds/removes a persona; mention answered through the fake cell | e2e | e2e `--rebuild-web ai-chat-agents team-bot-dm bots.spec`; `pnpm verify` | ✅ | ✅ green |
| 06-13-01 (tracer) | 13 | 6 | AGENT-04, D-07, P-11 | T-06-13-01/02/04/06 | Cards posted/updated by the posting agent only (version), in place, everywhere agents post; internal Open only; summary-only body | integration | `pnpm typecheck --force`; `vitest --project integration agent-channel/cards.int`, `agent-channel.int` | ✅ | ✅ green |
| 06-13-02 | 13 | 6 | AGENT-04 | T-06-13-03/05 | Follow → card_updated on status change; single audited decision by allowed readers; delivered as agent.card_action.v1 | integration | `vitest --project integration agent-channel/cards.int`, `notification/notifications.int`; `pnpm verify` | ✅ | ✅ green |
| 06-14-01 (tracer) | 14 | 7 | AGENT-04 | T-06-14-01/02/03/04 | `ocw_agent_card` tool bound to the active turn, offered by the turn policy, refused by the gate otherwise | plugin + integration | `pnpm typecheck --force`; `pnpm --filter @ocw/openclaw-channel test`; `vitest --project integration agent-channel/cards.int` | ✅ | ✅ green |
| 06-14-02 | 14 | 7 | AGENT-04 | — | Card decisions reach the persona as turns | plugin | `pnpm --filter @ocw/openclaw-channel test`; `pnpm verify` | ✅ | ✅ green |
| 06-15-01 (tracer) | 15 | 7 | AGENT-04, D-08 | T-06-15-01/02 | One card renderer everywhere; in-place updates; plain-text content; internal links only | web + e2e | `vitest --project web components/chat/agent-card.test`; e2e `--rebuild-web agent-cards chat.spec renderer` | ✅ | ✅ green |
| 06-15-02 | 15 | 7 | AGENT-04 | T-06-15-03/04 | Follow notifications; confirmed single approval visible to all | e2e | e2e `--rebuild-web agent-cards notifications ai-chat-multiplayer`; `pnpm verify` | ✅ | ✅ green |
| 06-16-01 (tracer) | 16 | 8 | all, MULTI-08 | T-06-16-01/02 | Fresh-stack Phase 6 day; leak sweep (no personal instructions/memory/tokens); 401/404 matrix over every Phase 6 route | integration + e2e | `vitest --project integration ai-chat/security.int`; e2e `--rebuild-web ai-chat-multiplayer-day` | ✅ | ✅ green |
| 06-16-02 | 16 | 8 | all | T-06-16-04 | ADR-0019/0020 accepted; AGENTS.md < 200 lines; DEMO owner checks; traceability; full regression | full suite + e2e + docs | full suite command; e2e `--rebuild-web` (all specs); `test "$(wc -l < AGENTS.md)" -lt 200` | ✅ | ✅ green |
| 06-16-03 (checkpoint) | 16 | 8 | MULTI-07, D-01, D-02 | T-06-16-03/05 | Owner's metered eval run (or deferral) and OpenAI terms check | manual (blocking-human) | — | — | ⏳ human_needed (eval deferred) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · ⏳ human_needed. "File Exists" now reads ✅ for every row: the files a task created exist on the branch.*

### Requirement → test files

| Req | Behaviour | Where |
|-----|-----------|-------|
| MULTI-01 | Person/team/department/org grants on the same record; levels; revoke live; dialog disclosure; search/files follow grants; notifications for direct shares | `ai-chat/{multiplayer.int,grants.int,shared.int}.test.ts`, `search/search.int.test.ts`, `ai-chat/attachments.int.test.ts`, `e2e/tests/{ai-chat-multiplayer,ai-chat-share-people,ai-chat-shared-inbox}.spec.ts` |
| MULTI-02 | Several humans + model live; per-message context record (author, time, client/session, access, model, tools); typing; per-recipient live lists | `ai-chat/{multiplayer.int,shared.int}.test.ts`, `packages/db/src/rls-isolation.int.test.ts`, `e2e/tests/ai-chat-multiplayer.spec.ts` |
| MULTI-03 | Roster in instructions, attributed blocks, merged turns, persona blocks, notices, no mid-array system, provider wire matrix, solo unchanged | `ai-chat/build-model-messages.test.ts`, `ai-chat/prompt-matrix.int.test.ts`, `ai-chat/guard.test.ts`, `infra/fake-model/attribution.test.mjs` |
| MULTI-04 | Addressing, one generation, queue, coalescing, requester pays, skips, sweeper, visible queue | `ai-chat/queue.int.test.ts`, `apps/web/lib/ai-chat-stream.test.ts`, `e2e/tests/ai-chat-multiplayer.spec.ts` |
| MULTI-05 | Agent ∩ triggering human; audience check; withheld with explanation (model and personas) | `ai-chat/prompt-matrix.int.test.ts`, `agent-channel/ai-chat-delivery.int.test.ts`, `apps/openclaw-channel/src/mention-mapper.test.ts` |
| MULTI-06 | No personal instructions once shared; no memory in AI chat deliveries | `ai-chat/{build-model-messages.test,multiplayer.int.test,security.int.test}.ts`, `agent-channel/ai-chat-delivery.int.test.ts` |
| MULTI-07 | Three-participant addressing/spoofing cases: free prompt fixtures every run; metered run opt-in; CI workflow on label/schedule | `ai-chat/spoof-cases.ts` + `build-model-messages.test.ts`, `eval/multiplayer/eval.test.ts`, `.github/workflows/ai-eval.yml`, owner run (06-16 Task 3) |
| MULTI-08 | Scenario B steps 1–4 with the mock model at 1440/390 | `e2e/tests/{ai-chat-multiplayer,ai-chat-multiplayer-day}.spec.ts` |
| AGENT-01 | Scoped personas (org/department/team/project/personal) with owner and tools by admins and Team Leads | `agent/personas.int.test.ts`, `organization/permissions/resolve.test.ts`, `e2e/tests/agent-personas.spec.ts` |
| AGENT-02 | Agents in channels, DMs and AI chats; participants list | `agent-channel/ai-chat-delivery.int.test.ts`, existing `agent/team-dm.int`, `chat/group-dm.int`, `e2e/tests/ai-chat-agents.spec.ts` |
| AGENT-04 | Typed cards, in-place updates, Open/Follow/Approve, cell tool, card-action turns | `agent-channel/cards.int.test.ts`, `apps/openclaw-channel/src/card-tool.test.ts`, `apps/web/components/chat/agent-card.test.tsx`, `e2e/tests/agent-cards.spec.ts` |
| all | Tenant isolation of new tables; leak and anonymous sweeps; fresh-stack day | `packages/db/src/rls-isolation.int.test.ts`, `ai-chat/security.int.test.ts`, `e2e/tests/ai-chat-multiplayer-day.spec.ts` |

---

## Wave 0 Requirements

Created inside the first task that needs them (TDD: the test infrastructure lands before the behaviour it checks):

- [x] RLS seed rows for `ai_chat_grants`, `ai_message_context`, `message_cards`, `message_card_follows` and the altered agent/notification rules — 06-01 Task 1
- [x] Two-person shared-chat setup (Víctor/Alex grant, both plans seeded, both subscribed) in `ai-chat/multiplayer.int.test.ts` — 06-02 Task 1 (later integration files reuse the pattern)
- [x] `infra/fake-model/attribution.mjs` (+ test): replies from `<participants>` and `<turn_context>` on Responses, chat completions and Anthropic; Dockerfile copies it — 06-03 Task 1
- [x] e2e `VICTOR`, `shareWith`, `humanTurn` in `e2e/support/ai-chat.ts` — 06-03 Task 1; fake-cell `postCard`/`patchCard` — 06-15 Task 1
- [x] Unit-tree seeding through the units API in `ai-chat/grants.int.test.ts` — 06-04 Task 1
- [x] `ai-chat/spoof-cases.ts` (shared by the free tests and the metered eval) — 06-05 Task 1

No new framework or package is installed (P-16).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Result |
|----------|-------------|------------|-------------------|--------|
| Metered three-participant spoofing/addressing eval on real models | MULTI-07, D-02 | Spends money with the owner's key; executors never call real providers | 06-16 Task 3: dry run, then `OCW_EVAL_CONFIRM=metered OCW_EVAL_PROVIDER=openrouter OCW_EVAL_API_KEY=<key> pnpm --filter @ocw/api eval:multiplayer`; every case ≥ 2/3 on both models | ⏳ human_needed — **eval deferred** (2026-10-07, recorded by the orchestrator under the owner's delegated autonomy; not run, no spend). Steps: `docs/DEMO.md` › Multiplayer AI chats › Owner checks (1) |
| OpenAI's stance on a member's ChatGPT plan answering in a shared chat | D-01 (NEEDS VALIDATION) | Vendor terms; no observable statement found in research | 06-16 Task 3: read OpenAI's current terms/help; a negative answer supersedes ADR-0019's plan rule (org models only in shared chats) | ⏳ human_needed — deferred with the eval (06-16 Task 3); NEEDS VALIDATION stays in ADR-0019 §5. Steps: `docs/DEMO.md` › Owner checks (2) |
| Visual review of the Phase 6 screens at 1440/390, light/dark | D-08 | Taste judgement | Screenshots `multiplayer-*`, `share-*`, `participants-*`, `personas-*`, `agent-card-*`, `day-*` (06-16 Task 2 `<human-check>`; also `shared-*`, `ai-chat-agent-*`) | ⬜ pending (owner). The 06-16 executor reviewed the `day-*` captures and the recaptured `agent-card-*` ones with Read; one defect found and fixed (decider's name truncated at 390, `790a7c1`) |
| CI run of `ai-eval.yml` | MULTI-07 | GitHub Actions billing unavailable (deferred in CONTEXT) | Once billing returns: add the `OCW_EVAL_API_KEY` secret and label a PR `ai-eval` or dispatch the workflow | ⬜ deferred (owner) |
| Personas in AI chats and `ocw_agent_card` against a real OpenClaw cell | AGENT-02, AGENT-04 | No OpenClaw container on an executor's machine; CI (cell-smoke / cell-proof) blocked by GitHub billing | When CI comes back: the real-cell smokes, including `SMOKE_ONLY=card` in `infra/openclaw/test/run-container-smoke.sh`; check a flat `ai_chat` mention, the withheld block and the gate refusing a withheld tool | ⬜ open (CI) |
| D-06: a chat with any agent member counts as shared (owner's personal instructions excluded) | MULTI-06, D-06 | Product decision taken by the orchestrator under the owner's delegated autonomy (06-12) | Owner confirms or asks to revert (one clause in `sharedSql` / `isShared`); recorded in ADR-0019 Consequences | ⬜ open (owner) |

The automated gate does not depend on these rows.

---

## Phase 6 gate run (06-16)

All local (GitHub Actions is unavailable), on `wt/06-16` (code head `0e96adb`; the docs commits after it change no
code). No real provider, OpenAI endpoint, OpenRouter or SearXNG was called; no OpenClaw container was started.

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/ai-chat/security.int.test.ts` | 16/16 (5 Phase 5 + 11 new). RED first: `POST /api/v1/cards/{messageId}/decision` answered an anonymous malformed body with 400; fixed in `4f2fa0c` |
| `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/cards.int.test.ts` | 32/32 (after the card routes moved to `onRequest`) |
| `OCW_E2E_SCREENSHOT_DIR=…/screenshots bash scripts/e2e-isolated.sh --rebuild-web ai-chat-multiplayer-day` (fresh stack) | 3/3 (setup + desktop + mobile), no skips, no flakes; again 7/7 with `agent-cards` after the card fix |
| `pnpm verify` | exit 0: lint (4 warnings, all pre-existing in `apps/local-runtime`), typecheck 8/8, **185 files, 2,624 tests** |
| `pnpm typecheck --force` | 8/8, 0 cached |
| `pnpm --filter @ocw/openclaw-channel test` | 16 files, 231/231 |
| `node --test 'infra/**/*.test.mjs'` | 130/130 |
| `node --test 'scripts/**/*.test.mjs'` | 4/4 |
| `pnpm --filter @ocw/local-runtime test` (temporary home) | 17 files, 286/286 |
| `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` (temporary home) | 11 files, 88/88 |
| `pnpm exec vitest run --project web` | 16 files, 220/220 |
| Full isolated e2e `--rebuild-web` (all specs, desktop + mobile), run 2 | **259 passed, 2 skipped, 0 failed, 0 flaky** (skips by design: `attachments-api` and `realtime-latency` are desktop-only) |

Run 1 of the full e2e (251 passed, 6 failed, 2 skipped, 2 did not run) was the first full run since Phase 5; every
failure was specs tripping over data another spec leaves on the shared stack, plus one real defect:

- `ai-chat-multiplayer-day` and `ai-chat-share-people` (desktop) picked the first "Backend" in the share picker, which
  could be admin-org's "Backend <suffix>" team, so the Backend reader had no access. Both now pick exactly
  Engineering › Backend.
- `bots` (desktop) added the bot to the first listed channel, 06-15's `backend-*`, where the admin is not a member
  (403). It now uses `#general` (the dialog's wider issue is in `deferred-items.md`).
- `admin-members` (mobile): two members named "Víctor Ruiz" (the admin and 06-03's VICTOR); the own row is found by
  e-mail. `admin-org` (mobile): clearing the tree hit 409 `unit_has_bots` on agent-personas' unit personas; they are
  removed first. Its people search then matched two Lenas; it searches the whole name.
- `agent-personas` (mobile): **real defect**. With many members the persona owner picker opened above the trigger past
  the top of the screen, so Kai Moreno could not be picked. Select popups are now capped at the available height and
  scroll (`3edb233`).

No security assertion was changed. Screenshots of the full runs went to `/tmp`; only the `day-*` and the recaptured
`agent-card-*` files are in `screenshots/`. The demo was not touched.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 340 s (per-task commands; the full e2e is the phase gate)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-10-07 by the 06-16 executor on the gate run above. Open (`human_needed`): the owner's
metered spoofing eval and the OpenAI terms check (06-16 Task 3, "eval deferred"), the visual review, D-06's
confirmation, the CI run of `ai-eval.yml` and the real OpenClaw cell proof.
