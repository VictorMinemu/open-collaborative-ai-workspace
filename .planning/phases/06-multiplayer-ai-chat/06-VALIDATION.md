---
phase: "06"
slug: "multiplayer-ai-chat"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6; Plan 06-16 Task 2 signs off)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-07"
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
| 06-01-01 (tracer) | 01 | 1 | MULTI-01, MULTI-02, MULTI-04, AGENT-01, AGENT-04, P-01, P-02 | T-06-01-01/02/03/04 | Four new tables FORCE RLS (cross-tenant invisible as `ocw_app`); one active grant per subject; org subject without id; unit agents RESTRICT; Open targets internal only | unit + integration | `vitest --project unit ai-chat.test contracts.test permissions.test`; `pnpm typecheck --force`; `vitest --project integration rls-isolation.int`; no `*_multiplayer_ai_check` dir | ❌ task | ⬜ pending |
| 06-01-02 [BLOCKING] | 01 | 1 | P-02 | T-06-01-05 | Schema final; older migrations untouched; Phase 5 suites green on it | integration + git | `vitest --project integration secret-ref-migration.int role-migration.int`, `ai-chat.int`; `git diff` limited to `*_multiplayer_ai` | ✅ | ⬜ pending |
| 06-02-01 (tracer) | 02 | 2 | MULTI-01, MULTI-02, MULTI-03, MULTI-06, D-01, D-03, D-04, D-06 | T-06-02-01/02/03/05/06/07/08/09 | Person grant → read/subscribe/write; requester's own plan; attributed prompt; no personal instructions once shared; Phase 5 snapshots byte-identical | unit + integration | `vitest --project unit build-model-messages.test`; `vitest --project integration ai-chat/multiplayer.int`; `git diff --quiet <base> -- ai-chat/__snapshots__` | ❌ task | ⬜ pending |
| 06-02-02 | 02 | 2 | MULTI-01, P-04, P-05 | T-06-02-04/05 | Manage/share owner-only; stop requester-or-owner; regenerate owner-or-requester on caller's backend; view grants read-only; admin/other tenant 404; solo 409 unchanged | unit + integration | `vitest --project unit resolve.test ai-chat/guard.test`; `vitest --project integration ai-chat/multiplayer.int`, `stop.int`, `shares.int`; `pnpm verify` | ✅ | ⬜ pending |
| 06-03-01 (tracer) | 03 | 3 | MULTI-01, MULTI-08, D-03, D-04, D-08 | T-06-03-02/03/04 | Scenario B 1–4 in two browsers; disclosure text; fake attributed replies; no real provider | node + e2e | `node --test infra/fake-model/attribution.test.mjs fake-responses.test.mjs server.test.mjs`; e2e `--rebuild-web ai-chat-multiplayer ai-chat.spec ai-chat-share` | ❌ task | ⬜ pending |
| 06-03-02 | 03 | 3 | MULTI-01, D-01, P-04 | T-06-03-01 | Grantee composer defaults to own model; Can view read-only; owner-only actions hidden | e2e | e2e `--rebuild-web ai-chat-multiplayer ai-chat-models ai-chat-list`; `pnpm verify` | ✅ | ⬜ pending |
| 06-04-01 (tracer) | 04 | 3 | MULTI-01, D-03 | T-06-04-01/02/03/05/06 | Team/department/org grants via one `aiAccessSql`; level change; revoke closes streams within ADR-0009 bounds; notices + audits; no flood | integration | `vitest --project integration ai-chat/grants.int`, `ai-chat/multiplayer.int` | ❌ task | ⬜ pending |
| 06-04-02 | 04 | 3 | MULTI-01 | T-06-04-04 | Search and files follow grants; view grantees cannot upload; outsiders 404 | integration (Garage) | `vitest --project integration search/search.int`, `ai-chat/attachments.int`; `pnpm verify` | ✅ | ⬜ pending |
| 06-05-01 (tracer) | 05 | 3 | MULTI-03, MULTI-05, MULTI-07, D-04, D-06 | T-06-05-01/04 | Persona blocks, file labels, notices, withheld in turn context; six spoof cases as free prompt fixtures; no name-colon templates, no system role outside the builder | unit | `vitest --project unit build-model-messages.test ai-chat/guard.test`; snapshots unchanged | ✅ | ⬜ pending |
| 06-05-02 | 05 | 3 | MULTI-03, MULTI-05 | T-06-05-02/03 | Plan Responses, OpenAI key, Anthropic key, openai-compatible wire shapes; instructions identical across requesters; requester without Web gets no tools + withheld | integration | `vitest --project integration ai-chat/prompt-matrix.int`, `ai-chat/tools.int`; `pnpm verify` | ❌ task | ⬜ pending |
| 06-06-01 (tracer) | 06 | 3 | MULTI-04, D-01, D-05 | T-06-06-01/02/06 | Addressing; queue never 409 in shared chats; next turn in the finalize tx on the first waiting author's plan; coalescing; skips with reasons; solo 409 unchanged | integration | `vitest --project integration ai-chat/queue.int`, `ai-chat/ai-chat.int` | ❌ task | ⬜ pending |
| 06-06-02 | 06 | 3 | MULTI-04, P-08 | T-06-06-03/04/05 | Stop lets the queue continue; regenerate waits for the queue; sweeper pickup via ids-only SECURITY DEFINER; two instances | integration (2 instances) | `vitest --project integration ai-chat/queue.int`, `stop.int`, `regenerate.int`; `pnpm verify` | ✅ | ⬜ pending |
| 06-07-01 (tracer) | 07 | 3 | AGENT-01, D-07 | T-06-07-01/02/03/04/05 | Leads create/configure personas only in their units; unit visibility; mention gate; unit deletion guard | unit + integration + e2e | `pnpm typecheck --force`; `vitest --project unit resolve.test`; `vitest --project integration agent/personas.int`; e2e `--rebuild-web agent-personas bots.spec personal-bots` | ❌ task | ⬜ pending |
| 06-07-02 | 07 | 3 | AGENT-01 | — | Scope/owner in the bot detail; one-click and personal bots unchanged | integration + e2e | `vitest --project integration agent/personas.int`; e2e `--rebuild-web agent-personas bot-capabilities team-bot-dm`; `pnpm verify` | ✅ | ⬜ pending |
| 06-08-01 (tracer) | 08 | 4 | MULTI-01, MULTI-02, P-09 | T-06-08-01/03/04/05 | Direct share notifies the person only; inbox follows readability; unread + read marker joins; mentions notify readers only | integration + e2e | `vitest --project integration ai-chat/shared.int`, `notification/notifications.int`; e2e `--rebuild-web ai-chat-shared-inbox notifications unread ai-chat-list` | ❌ task | ⬜ pending |
| 06-08-02 | 08 | 4 | MULTI-02 | T-06-08-02 | Per-recipient live summaries; solo payload unchanged; wave regressions | integration + e2e | `vitest --project integration ai-chat/shared.int`, `titles.int`, `list.int`, `notification/prefs.int`, `chat/unread.int`; e2e `notification-prefs chat-sidebar ai-chat-multiplayer ai-chat-shared-inbox`; `pnpm verify` | ✅ | ⬜ pending |
| 06-09-01 (tracer) | 09 | 4 | MULTI-07, D-02 | T-06-09-01/02/03/04 | Opt-in metered runner (confirm + key), deterministic grader, key never printed; executors use the fake / dry run only | unit + command | `vitest --project unit eval/multiplayer/eval.test ai-chat/guard.test`; dry run `OCW_EVAL_DRY_RUN=1 OCW_EVAL_CONFIRM=metered OCW_EVAL_API_KEY=dry-run-not-a-key pnpm --filter @ocw/api eval:multiplayer` | ❌ task | ⬜ pending |
| 06-09-02 | 09 | 4 | MULTI-07, D-02 | T-06-09-02 | Workflow on label/weekly/dispatch only, skipped without the secret, never on push | unit | `vitest --project unit eval/multiplayer/eval.test`; `pnpm verify` | ✅ | ⬜ pending |
| 06-10-01 (tracer) | 10 | 5 | AGENT-02, D-07, P-10 | T-06-10-03/04/05 | Persona added by the owner answers mentions flat via OpenClaw with attributed history; channels/DMs unchanged | integration + plugin | `vitest --project integration agent-channel/ai-chat-delivery.int`, `agent-channel.int`, `chat/group-dm.int`; `pnpm --filter @ocw/openclaw-channel test` | ❌ task | ⬜ pending |
| 06-10-02 | 10 | 5 | MULTI-05, MULTI-06, D-06 | T-06-10-01/02 | Scoped tools only when every participant may use them, never with unit/org grants; withheld explained; no memory in AI chats | integration + plugin | `pnpm typecheck --force`; `vitest --project integration agent-channel/ai-chat-delivery.int`, `tool-calls.int`, `bot-capabilities/memory.int`; plugin tests; `pnpm verify` | ✅ | ⬜ pending |
| 06-11-01 (tracer) | 11 | 6 | MULTI-02, MULTI-04, MULTI-08, D-01, D-05 | T-06-11-01/02 | Typing, queue chip, coalesced answer with "for X · X's plan", requester-only Stop, live "no longer have access" | web + e2e | `vitest --project web ai-chat-stream.test ai-format.test`; e2e `--rebuild-web ai-chat-multiplayer ai-chat-stop ai-chat.spec` | ✅ | ⬜ pending |
| 06-11-02 | 11 | 6 | MULTI-04, P-08 | T-06-11-03 | Ask AI toggle and @ suggestions; solo composer unchanged | e2e | e2e `--rebuild-web ai-chat-multiplayer ai-chat-tools ai-chat-attachments`; `pnpm verify` | ✅ | ⬜ pending |
| 06-12-01 (tracer) | 12 | 7 | MULTI-01, D-03, D-08 | T-06-12-01/02 | Share with team/department/org, level change, removal with confirmation; participants with presence; AI chats page "Shared with me" | e2e | e2e `--rebuild-web ai-chat-share-people ai-chat-share ai-chat-list` | ❌ task | ⬜ pending |
| 06-12-02 | 12 | 7 | AGENT-02 | T-06-12-03 | Owner adds/removes a persona; mention answered through the fake cell | e2e | e2e `--rebuild-web ai-chat-agents team-bot-dm bots.spec`; `pnpm verify` | ❌ task | ⬜ pending |
| 06-13-01 (tracer) | 13 | 6 | AGENT-04, D-07, P-11 | T-06-13-01/02/04/06 | Cards posted/updated by the posting agent only (version), in place, everywhere agents post; internal Open only; summary-only body | integration | `pnpm typecheck --force`; `vitest --project integration agent-channel/cards.int`, `agent-channel.int` | ❌ task | ⬜ pending |
| 06-13-02 | 13 | 6 | AGENT-04 | T-06-13-03/05 | Follow → card_updated on status change; single audited decision by allowed readers; delivered as agent.card_action.v1 | integration | `vitest --project integration agent-channel/cards.int`, `notification/notifications.int`; `pnpm verify` | ✅ | ⬜ pending |
| 06-14-01 (tracer) | 14 | 7 | AGENT-04 | T-06-14-01/02/03/04 | `ocw_agent_card` tool bound to the active turn, offered by the turn policy, refused by the gate otherwise | plugin + integration | `pnpm typecheck --force`; `pnpm --filter @ocw/openclaw-channel test`; `vitest --project integration agent-channel/cards.int` | ❌ task | ⬜ pending |
| 06-14-02 | 14 | 7 | AGENT-04 | — | Card decisions reach the persona as turns | plugin | `pnpm --filter @ocw/openclaw-channel test`; `pnpm verify` | ✅ | ⬜ pending |
| 06-15-01 (tracer) | 15 | 7 | AGENT-04, D-08 | T-06-15-01/02 | One card renderer everywhere; in-place updates; plain-text content; internal links only | web + e2e | `vitest --project web components/chat/agent-card.test`; e2e `--rebuild-web agent-cards chat.spec renderer` | ❌ task | ⬜ pending |
| 06-15-02 | 15 | 7 | AGENT-04 | T-06-15-03/04 | Follow notifications; confirmed single approval visible to all | e2e | e2e `--rebuild-web agent-cards notifications ai-chat-multiplayer`; `pnpm verify` | ✅ | ⬜ pending |
| 06-16-01 (tracer) | 16 | 8 | all, MULTI-08 | T-06-16-01/02 | Fresh-stack Phase 6 day; leak sweep (no personal instructions/memory/tokens); 401/404 matrix over every Phase 6 route | integration + e2e | `vitest --project integration ai-chat/security.int`; e2e `--rebuild-web ai-chat-multiplayer-day` | ❌ task | ⬜ pending |
| 06-16-02 | 16 | 8 | all | T-06-16-04 | ADR-0019/0020 accepted; AGENTS.md < 200 lines; DEMO owner checks; traceability; full regression | full suite + e2e + docs | full suite command; e2e `--rebuild-web` (all specs); `test "$(wc -l < AGENTS.md)" -lt 200` | ✅ | ⬜ pending |
| 06-16-03 (checkpoint) | 16 | 8 | MULTI-07, D-01, D-02 | T-06-16-03/05 | Owner's metered eval run (or deferral) and OpenAI terms check | manual (blocking-human) | — | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

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

- [ ] RLS seed rows for `ai_chat_grants`, `ai_message_context`, `message_cards`, `message_card_follows` and the altered agent/notification rules — 06-01 Task 1
- [ ] Two-person shared-chat setup (Víctor/Alex grant, both plans seeded, both subscribed) in `ai-chat/multiplayer.int.test.ts` — 06-02 Task 1 (later integration files reuse the pattern)
- [ ] `infra/fake-model/attribution.mjs` (+ test): replies from `<participants>` and `<turn_context>` on Responses, chat completions and Anthropic; Dockerfile copies it — 06-03 Task 1
- [ ] e2e `VICTOR`, `shareWith`, `humanTurn` in `e2e/support/ai-chat.ts` — 06-03 Task 1; fake-cell `postCard`/`patchCard` — 06-15 Task 1
- [ ] Unit-tree seeding through the units API in `ai-chat/grants.int.test.ts` — 06-04 Task 1
- [ ] `ai-chat/spoof-cases.ts` (shared by the free tests and the metered eval) — 06-05 Task 1

No new framework or package is installed (P-16).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Result |
|----------|-------------|------------|-------------------|--------|
| Metered three-participant spoofing/addressing eval on real models | MULTI-07, D-02 | Spends money with the owner's key; executors never call real providers | 06-16 Task 3: dry run, then `OCW_EVAL_CONFIRM=metered OCW_EVAL_PROVIDER=openrouter OCW_EVAL_API_KEY=<key> pnpm --filter @ocw/api eval:multiplayer`; every case ≥ 2/3 on both models | ⬜ pending (owner) |
| OpenAI's stance on a member's ChatGPT plan answering in a shared chat | D-01 (NEEDS VALIDATION) | Vendor terms; no observable statement found in research | 06-16 Task 3: read OpenAI's current terms/help; a negative answer supersedes ADR-0019's plan rule (org models only in shared chats) | ⬜ pending (owner) |
| Visual review of the Phase 6 screens at 1440/390, light/dark | D-08 | Taste judgement | Screenshots `multiplayer-*`, `share-*`, `participants-*`, `personas-*`, `agent-card-*`, `day-*` (06-16 Task 2 `<human-check>`) | ⬜ pending (owner) |
| CI run of `ai-eval.yml` | MULTI-07 | GitHub Actions billing unavailable (deferred in CONTEXT) | Once billing returns: add the `OCW_EVAL_API_KEY` secret and label a PR `ai-eval` or dispatch the workflow | ⬜ deferred (owner) |

The automated gate does not depend on these rows.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 340 s (per-task commands; the full e2e is the phase gate)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending (06-16 Task 2 signs off on the gate run).
