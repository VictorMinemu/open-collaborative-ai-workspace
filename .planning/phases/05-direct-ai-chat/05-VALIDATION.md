---
phase: "05"
slug: "direct-ai-chat"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6; Plan 05-12 Task 3 signs off)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-06"
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Sources: `05-RESEARCH.md` §Validation Architecture and §Security Domain, `05-CONTEXT.md` (D-01 … D-08), planner decisions P-01 … P-14 in `05-01-PLAN.md`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5 — projects `unit`, `integration` (testcontainers PostgreSQL 18 + Redis 8, Garage GenericContainer from `apps/api/src/testing-storage.ts`, the fake model/SIWC server started in-process by `apps/api/src/testing-ai.ts`) and `web`; `node --test` for `infra/**` and `scripts/**`; `pnpm --filter @ocw/desktop test` (run with `env -u ELECTRON_RUN_AS_NODE`); Playwright 1.63 (`setup` → `desktop` 1440×900, `mobile` 390×844) |
| **Config file** | `vitest.config.ts`, `e2e/playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run --project unit <files>` · `pnpm exec vitest run --project integration <file>` (one file at a time: memory) · `pnpm exec vitest run --project web <files>` · `node --test infra/fake-model/<file>.test.mjs` |
| **Full suite command** | `pnpm verify && pnpm typecheck --force && env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test && pnpm --filter @ocw/local-runtime test && pnpm --filter @ocw/openclaw-channel test && node --test 'infra/**/*.test.mjs' 'scripts/**/*.test.mjs'` |
| **E2E** | `bash scripts/e2e-isolated.sh <spec filters>` (isolated: DB `ocw_e2e`, Redis DB 9, API :4290, web :3290, fake model + fake Responses API + fake SIWC (`/siwc`) + fake SearXNG (`/search`) on :4291, Garage :4292 in compose project `ocw-e2e-storage`; `OCW_MODEL_PROVIDER=mock`); screenshots with `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/05-direct-ai-chat/screenshots` |
| **No real providers** | Every test and e2e run talks only to `infra/fake-model` (OpenAI Responses, chat completions, Anthropic messages, SIWC, SearXNG). CI is unavailable (GitHub billing): every gate runs locally through the isolated harness. |
| **Estimated runtime** | ~320 s (verify), ~1,100 s (full e2e, both projects) |

---

## Sampling Rate

- **After every task commit:** the task's quick unit/integration/web command for the touched module (listed per task below).
- **After every plan wave:** `pnpm verify` (+ `pnpm typecheck --force` after any contract change).
- **Before `/gsd-verify-work 5`:** full suite command + full isolated e2e (desktop + mobile) green.
- **Max feedback latency:** 320 seconds.

---

## Per-Task Verification Map

E2E commands run as `OCW_E2E_SCREENSHOT_DIR=$PWD/.planning/phases/05-direct-ai-chat/screenshots bash scripts/e2e-isolated.sh <filters>`; every task also ends with `pnpm verify` unless noted. "❌ task" = the task creates the test file first (TDD RED), "✅" = the file exists before the task.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 (gate) | 01 | 1 | — (T-05-01-SC) | T-05-01-SC | Human verifies ai@7.0.122 + three @ai-sdk pins before install | manual gate (blocking-human) | — | — | ⬜ pending |
| 05-01-02 (tracer) | 01 | 1 | AICHAT-02, AICHAT-03, AICHAT-07, D-01, D-02, D-05, D-06 | T-05-01-01…10 | Requester's own plan token only; store:false + no forbidden fields; owner-only chat (admin 404); one generation (409); no tokens/prompts in logs | unit + node + integration + e2e | `vitest --project unit ai-chat.test model-prices.test contracts permissions resolve errors build-model-messages env`; `node --test fake-responses server`; `pnpm typecheck --force`; `vitest --project integration ai-chat/ai-chat.int`; e2e `--rebuild-web ai-chat.spec chat.spec team-bot-dm bot-capabilities`; `pnpm install --frozen-lockfile` | ❌ task | ⬜ pending |
| 05-01-03 [BLOCKING] | 01 | 1 | D-07, P-02 | T-05-01-07/08 | Both migrations fresh; 8 tables FORCE RLS; usage records append-only; secret_ref backfill idempotent on legacy rows; prompt/model static guards | integration + unit | `vitest --project integration secret-ref-migration.int`, `rls-isolation.int`, `ai-chat/ai-chat.int`; `vitest --project unit ai-chat/guard.test`; no `*_ai_chat_check` dir | ❌ task | ⬜ pending |
| 05-02-01 (tracer) | 02 | 2 | AICHAT-01, AICHAT-02, D-03, D-07 | T-05-02-01/02/05 | Keys via `secrets.resolve` only; METERED on every org row | unit + web + integration + e2e | `vitest --project unit model-gateway/registry.test`; `vitest --project web model-picker.test`; `vitest --project integration model-gateway/org-models.int`; e2e `--rebuild-web ai-chat-models ai-chat.spec bots.spec` | ❌ task | ⬜ pending |
| 05-02-02 | 02 | 2 | AICHAT-01 | T-05-02-01/03/04 | One allowed list for chats and bots; env/db refs; foreign-org ref refused; no personal key route (OpenAPI scan); key never leaks | integration + e2e | `vitest --project integration agent/providers-secret-ref.int`, `agent-channel/agent-channel.int`; e2e `ai-chat-models bots.spec personal-bots` | ❌ task | ⬜ pending |
| 05-02-03 | 02 | 2 | AICHAT-02 | T-05-02-05 | Per-message switch across backends, history preserved, labels per answer | integration + e2e | `vitest --project integration model-gateway/org-models.int`; e2e `--rebuild-web ai-chat-models ai-chat.spec` | ✅ | ⬜ pending |
| 05-03-01 (tracer) | 03 | 2 | AICHAT-02, D-02 | T-05-03-01/02/03/04 | PKCE/state/nonce, JWKS-validated ID token, scope check, single-use flow bound to the member, no token/code/verifier in DB/logs | unit + node + integration + e2e | `vitest --project unit chatgpt-plan/oauth.test`; `node --test fake-siwc fake-responses`; `vitest --project integration chatgpt-plan/signin.int`; e2e `--rebuild-web ai-chat-signin ai-chat.spec account` | ❌ task | ⬜ pending |
| 05-03-02 | 03 | 2 | AICHAT-02, D-02 | T-05-03-05/06 | Serialized refresh (one call under a race), rotation, terminal vs transient errors, revoke on disconnect | integration + e2e | `vitest --project integration chatgpt-plan/signin.int`; e2e `ai-chat-signin` | ✅ | ⬜ pending |
| 05-03-03 | 03 | 2 | D-02 | — | ADR-0017 (Proposed); ADR-0006 unchanged | docs checks | `test -f docs/adr/0017-…`; `git log ea27442..HEAD -- docs/adr/0006-…` empty | ❌ task | ⬜ pending |
| 05-04-01 (tracer) | 04 | 3 | AICHAT-03, D-05 | T-05-04-01/02 | Cross-instance stop via Redis keeps partial; 409 gate; stop owner-only | integration (2 instances) + e2e | `vitest --project integration ai-chat/stop.int`; e2e `--rebuild-web ai-chat-stop ai-chat.spec` | ❌ task | ⬜ pending |
| 05-04-02 | 04 | 3 | AICHAT-03, D-05 | T-05-04-04/05/06 | Sweeper (stale heartbeat → interrupted, partial kept), shutdown finalize, per-user cap 429, reload resume | integration + e2e | `vitest --project integration ai-chat/stop.int`; e2e `ai-chat-stop` | ✅ | ⬜ pending |
| 05-04-03 | 04 | 3 | AICHAT-03, AICHAT-02 | T-05-04-01/03 | Regenerate (also with another model); replaced body in message_versions | integration + e2e | `vitest --project integration ai-chat/regenerate.int`; e2e `ai-chat-stop ai-chat-models` | ❌ task | ⬜ pending |
| 05-05-01 (tracer) | 05 | 3 | AICHAT-03, D-02 | T-05-05-01 | Usage limit mid-stream keeps partial; no silent switch to an org key; explicit "Use an organization model" | integration + e2e | `vitest --project integration chatgpt-plan/plan-errors.int`; e2e `--rebuild-web ai-chat-plan-errors ai-chat.spec` | ❌ task | ⬜ pending |
| 05-05-02 | 05 | 3 | AICHAT-02, D-02 | T-05-05-05 | not_eligible fallback, reconnect, Continue with ChatGPT in picker, one-time welcome | integration + web + e2e | `vitest --project integration chatgpt-plan/plan-errors.int`; `vitest --project web model-picker.test`; e2e `ai-chat-plan-errors ai-chat-signin ai-chat-models` | ✅ | ⬜ pending |
| 05-05-03 | 05 | 3 | D-02 | T-05-05-02/03/04 | Desktop loopback: 127.0.0.1 only, one callback, timeout, Zod IPC, no daemon port | unit (desktop) | `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` | ❌ task | ⬜ pending |
| 05-06-01 (tracer) | 06 | 4 | AICHAT-07, D-06 | T-05-06-02/04/05 | One record per outcome; sourced prices; footer tokens/cost; no text in usage | unit + web + integration + e2e | `vitest --project unit model-prices.test`; `vitest --project web lib/ai-format.test`; `vitest --project integration ai-chat/usage.int`; e2e `--rebuild-web ai-chat-usage ai-chat.spec ai-chat-stop` | ❌ task | ⬜ pending |
| 05-06-02 | 06 | 4 | AICHAT-07, D-06 | T-05-06-01/02 | Atomic daily caps (10 concurrent at cap 5 → 5), no model call at cap, policy admin-only | integration + e2e | `vitest --project integration ai-chat/usage.int`; e2e `ai-chat-usage bots.spec` | ✅ | ⬜ pending |
| 05-06-03 | 06 | 4 | AICHAT-07 | T-05-06-03/04 | Org report admin-only; own report self-only; org isolation | integration + e2e | `vitest --project integration ai-chat/usage.int`; e2e `ai-chat-usage` | ✅ | ⬜ pending |
| 05-07-01 (tracer) | 07 | 5 | AICHAT-04 | T-05-07-02/03/05 | Titles on the owner's backend, validated, metered, never over a user title | unit + node + integration + e2e | `vitest --project unit build-model-messages guard`; `node --test fake-responses`; `vitest --project integration ai-chat/titles.int`; e2e `--rebuild-web ai-chat-list ai-chat.spec chat-sidebar` | ❌ task | ⬜ pending |
| 05-07-02 | 07 | 5 | AICHAT-04 | T-05-07-04 | List/rename/archive owner-only; 410 on archived send | integration + e2e | `vitest --project integration ai-chat/list.int`; e2e `ai-chat-list personal-bots team-bot-dm` | ❌ task | ⬜ pending |
| 05-07-03 | 07 | 5 | AICHAT-04, P-03 | T-05-07-01 | Search/palette owner-only (Alex and admin see nothing) | unit + integration + e2e | `vitest --project unit chat-workspace.test`; `pnpm typecheck --force`; `vitest --project integration search/search.int`; e2e `ai-chat-list search` | ✅ | ⬜ pending |
| 05-08-01 (tracer) | 08 | 6 | AICHAT-06, D-04 | T-05-08-01/03 | Hosted search on the plan, sources recorded, other toggles disabled | node + integration + e2e | `node --test fake-responses`; `vitest --project integration ai-chat/tools.int`; e2e `--rebuild-web ai-chat-tools ai-chat.spec` | ❌ task | ⬜ pending |
| 05-08-02 | 08 | 6 | AICHAT-06, D-04 | T-05-08-01/02/03/04 | SearXNG tool only on org keys, untrusted capped results, no fetch tool, disabled reasons (policy, deny rule, not configured) | unit + integration + e2e | `vitest --project unit ai-chat/web-tools.test`; `vitest --project integration ai-chat/tools.int`; e2e `ai-chat-tools bot-capabilities` | ❌ task | ⬜ pending |
| 05-08-03 | 08 | 6 | AICHAT-05 | T-05-08-05 | Instructions order; personal only with one human; no instruction text in audit | unit + integration + e2e | `vitest --project unit build-model-messages guard`; `vitest --project integration ai-chat/tools.int`; e2e `ai-chat-tools ai-chat-list` | ✅ | ⬜ pending |
| 05-09-01 (tracer) | 09 | 7 | AICHAT-08 | T-05-09-01/02/03 | Image bytes from Garage (no URL to providers); owner-only attachments; drafts hidden | unit + integration (Garage) + e2e | `vitest --project unit build-model-messages`; `vitest --project integration ai-chat/attachments.int`; e2e `--rebuild-web ai-chat-attachments attachments.spec ai-chat.spec` | ❌ task | ⬜ pending |
| 05-09-02 | 09 | 7 | AICHAT-08 | T-05-09-04/05 | PDFs only to PDF models, text inline ≤ 100 KB, others refused before sending | unit + integration | `vitest --project unit ai-chat/attachments.test`; `vitest --project integration ai-chat/attachments.int` | ❌ task | ⬜ pending |
| 05-09-03 | 09 | 7 | AICHAT-08 | — | Composer gate mirrors the server rule | web + e2e | `vitest --project web ai-chat/attachment-gate.test`; e2e `ai-chat-attachments` | ❌ task | ⬜ pending |
| 05-10-01 (tracer) | 10 | 8 | AICHAT-09 | T-05-10-01/02/03 | Same-org signed-in read only; immutable snapshot; anonymous 401, other org 404 | integration + e2e | `vitest --project integration ai-chat/shares.int`; e2e `--rebuild-web ai-chat-share ai-chat.spec` | ❌ task | ⬜ pending |
| 05-10-02 | 10 | 8 | AICHAT-09 | T-05-10-04/05 | Revoke → 404 identical to missing | integration + e2e | `vitest --project integration ai-chat/shares.int`; e2e `ai-chat-share` | ✅ | ⬜ pending |
| 05-10-03 | 10 | 8 | AICHAT-09 | T-05-10-02 | Share-scoped files only; chat routes stay private; Phase 4 attachments unchanged | integration (Garage) + e2e | `vitest --project integration ai-chat/shares.int`, `artifact/attachments.int`; e2e `ai-chat-share attachments.spec` | ✅ | ⬜ pending |
| 05-11-01 (tracer) | 11 | 9 | D-08 | — | Every AI chat screen captured in 4 variants with layout invariants | e2e | e2e `--rebuild-web ai-chat-visual` (before set) | ❌ task | ⬜ pending |
| 05-11-02 | 11 | 9 | D-08 | T-05-11-01/02 | Polish without behaviour change; METERED kept | e2e + docs | e2e `--rebuild-web ai-chat-visual`; `05-UI-REVIEW.md` table | ✅ | ⬜ pending |
| 05-11-03 | 11 | 9 | D-08 | — | Keyboard complete; quiet streaming for screen readers; reduced motion | e2e | e2e `ai-chat-visual ai-chat.spec ai-chat-models ai-chat-stop ai-chat-tools` | ✅ | ⬜ pending |
| 05-12-01 (tracer) | 12 | 10 | AICHAT-01 … 09 | — | Cross-feature AI chat session on a fresh stack | e2e | e2e `--rebuild-web ai-chat-day` | ❌ task | ⬜ pending |
| 05-12-02 | 12 | 10 | AICHAT-01 … 09 | T-05-12-01/02 | No key/token/code/verifier anywhere; no prompt text in audit/usage; every AI route 401 anonymously; full regression | integration + full suite + e2e | `vitest --project integration ai-chat/security.int`; full suite command; e2e `--rebuild-web` (all specs) | ❌ task | ⬜ pending |
| 05-12-03 | 12 | 10 | all | T-05-12-03/04 | ADR-0017/0018 accepted, AGENTS.md < 200 lines, traceability, sign-off | docs checks | `grep Accepted docs/adr/0017-… docs/adr/0018-…`; `wc -l AGENTS.md`; `grep -c "^- \[x\] \*\*AICHAT-" .planning/REQUIREMENTS.md` | ❌ task | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → test files

| Req | Behaviour | Where |
|-----|-----------|-------|
| AICHAT-01 | Provider keys as SecretReferences (backfill on legacy rows), one allowed list for chats and bots, no personal key path, keys never leak | `packages/db/src/secret-ref-migration.int.test.ts`, `apps/api/src/modules/agent/providers-secret-ref.int.test.ts`, `model-gateway/org-models.int.test.ts`, `agent-channel/agent-channel.int.test.ts`, `e2e/tests/ai-chat-models.spec.ts` |
| AICHAT-02 | Private chat, model from the allowed list, per-message switch, plan backend per member (sign-in, refresh, errors) | `ai-chat/ai-chat.int.test.ts`, `model-gateway/org-models.int.test.ts`, `chatgpt-plan/{oauth.test,signin.int.test,plan-errors.int.test}.ts`, `e2e/tests/{ai-chat,ai-chat-models,ai-chat-signin,ai-chat-plan-errors}.spec.ts` |
| AICHAT-03 | Streaming deltas with offsets, reload resume, stop (cross-instance, partial kept), 409 gate, sweeper, regenerate with versions | `ai-chat/{ai-chat.int,stop.int,regenerate.int}.test.ts`, `packages/contracts/src/ai-chat.test.ts` (offset reducer), `e2e/tests/ai-chat-stop.spec.ts` |
| AICHAT-04 | Auto titles, list, rename, archive, owner-only search | `ai-chat/{titles.int,list.int}.test.ts`, `search/search.int.test.ts`, `e2e/tests/ai-chat-list.spec.ts` |
| AICHAT-05 | Personal + per-chat instructions in order; personal dropped with a second human | `ai-chat/build-model-messages.test.ts`, `ai-chat/tools.int.test.ts`, `e2e/tests/ai-chat-tools.spec.ts` |
| AICHAT-06 | Four toggles, only Web functional (hosted on plan, SearXNG on org keys), disabled reasons | `ai-chat/{web-tools.test,tools.int.test}.ts`, `e2e/tests/ai-chat-tools.spec.ts` |
| AICHAT-07 | One usage record per generation (every outcome), sourced prices, tokens/cost per message, daily caps, reports | `packages/contracts/src/model-prices.test.ts`, `ai-chat/usage.int.test.ts`, `apps/web/lib/ai-format.test.ts`, `e2e/tests/ai-chat-usage.spec.ts` |
| AICHAT-08 | Images/PDF/text to capable models as server-read bytes; gating | `ai-chat/{attachments.test,attachments.int.test}.ts`, `apps/web/components/ai-chat/attachment-gate.test.ts`, `e2e/tests/ai-chat-attachments.spec.ts` |
| AICHAT-09 | Org-scoped read-only snapshot, never public, revoke, share-scoped files | `ai-chat/shares.int.test.ts`, `e2e/tests/ai-chat-share.spec.ts` |
| all | Cross-tenant on every new table; leak sweep; anonymous sweep; static prompt/model guards | `packages/db/src/rls-isolation.int.test.ts`, `ai-chat/security.int.test.ts`, `ai-chat/guard.test.ts` |

---

## Wave 0 Requirements

Created inside the first task that needs them (TDD: the test infrastructure lands before the behaviour it checks):

- [ ] `infra/fake-model/fake-responses.mjs` (+ `fake-responses.test.mjs`): `POST /v1/responses` SSE (`response.output_text.delta`, `response.completed` + usage, `response.failed` with `subscription_sharing_usage_limit_exceeded`), pre-stream SIWC error directives, preview-field enforcement for `fake-plan-` tokens, `[[slow]]`, image/file counting, plan catalog on `GET /v1/models`, `onRequest` capture — 05-01 Task 2
- [ ] `apps/api/src/testing-ai.ts`: in-process fake, `startAiStack`, `seedPlan`, `subscribeConv`, `startSecondInstance` — 05-01 Task 2
- [ ] contracts `ai-generation.ts`, `ai-chat.ts`, `model-prices.ts` with tests — 05-01 Task 2
- [ ] RLS seed rows for the eight new tables + `secret-ref-migration.int.test.ts` — 05-01 Task 3
- [ ] Harness env (`OCW_CHATGPT_API_BASE_URL`, `OCW_CHATGPT_AUTH_BASE_URL`, `OCW_AI_MOCK_BASE_URL`, `OCW_AI_SEARXNG_URL`, `OCW_AI_SEND_RATE_LIMIT_PER_MINUTE`) — 05-01 Task 2
- [ ] `infra/fake-model/fake-siwc.mjs` (+ test): discovery, authorize, token (PKCE, rotation, reuse), JWKS, revoke, `__scenario`, `__stats` — 05-03 Task 1
- [ ] Package legitimacy gate for ai@7.0.122, @ai-sdk/openai@4.0.80, @ai-sdk/anthropic@4.0.68, @ai-sdk/openai-compatible@3.0.59 — 05-01 Task 1

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy of the four AI SDK pins | T-05-01-SC | Trust decision (blocking-human gate) | 05-01 Task 1 checklist (`npm view`, npmjs.com, repository, install scripts, publish date ≥ 7 days) |
| Real "Sign in with ChatGPT – ChatGPT plan usage" with the owner's own Plus/Pro account: paste-redirect relay and desktop loopback, one plan turn, Stop | AICHAT-02, D-02 | No real provider or OpenAI auth in tests (fakes only); the paste relay acceptability (research A1) can only be proven against OpenAI | On the demo after merge: Settings › AI chat → Continue with ChatGPT → paste the 127.0.0.1 address → Connected; reconnect from the desktop app without pasting; one AI chat turn on a plan model, Stop keeps the partial, footer "ChatGPT plan" |
| ChatGPT Business/Enterprise seat eligibility | D-02 | Depends on OpenAI account policy (research A2) | If a Business/Enterprise seat is available: connect it and note `connected` vs `not_eligible`; `not_eligible` must fall back to org models |
| Owner visual review of every Phase 5 screen at 1440/390, light/dark | D-08 | Taste judgement (ChatGPT/Claude.ai quality) | Read `05-UI-REVIEW.md` and the `review-*` screenshots; harvested from 05-11 Task 2 `<human-check>` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 320 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending (05-12 Task 3 signs off)
