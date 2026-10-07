---
phase: 05-direct-ai-chat
verified: 2026-10-07T06:01:43Z
status: human_needed
score: 13/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "On the demo after merge (docs/DEMO.md › AI chats): Settings › AI chat → Continue with ChatGPT with your own Plus/Pro account → paste the 127.0.0.1 address"
    expected: "The card shows Connected with your account and plan; one plan turn streams; Stop keeps the partial text; the footer says 'ChatGPT plan'"
    why_human: "Every test talks to infra/fake-model (fake SIWC + fake Responses API). Whether OpenAI accepts the paste-redirect relay for a self-hosted app (research A1) can only be proven against the real auth server, and executors must not call real providers"
  - test: "In the desktop app: Disconnect, then Continue with ChatGPT again"
    expected: "No paste needed: the one-shot 127.0.0.1 loopback listener captures the callback and the card shows Connected"
    why_human: "Only the listener is unit-tested (apps/desktop/src/main/chatgpt-loopback.test.ts); the real OS browser → loopback → OpenAI round trip is outside every harness"
  - test: "If a ChatGPT Business/Enterprise seat is available, connect it"
    expected: "Either connected, or not_eligible with a plain reason and the default model falling back to organization models"
    why_human: "Depends on OpenAI account policy (research A2); the fallback path itself is covered by plan-errors.int"
  - test: "Owner visual review of 05-UI-REVIEW.md, screenshots/review-*.png and screenshots/ai-chat-day-*.png (1440/390, light/dark)"
    expected: "ChatGPT/Claude.ai quality in the Work Zone/T3 Code language (D-08); accept or schedule the cosmetic notes (raw Markdown link text in search palette snippets; bot form model select has no METERED badge)"
    why_human: "Taste judgement; the executor's verdicts in 05-UI-REVIEW.md are not the owner's"
  - test: "Unverified-prohibition review (process-only, judgment tier): no migration was run against the default .env database; the demo (ports 4000/3000, ocw-demo-*, ocw DB) was never started/stopped/touched; no executor made a real provider/ChatGPT/SearXNG call; no package was installed before the 05-02 legitimacy gate"
    expected: "Owner confirms from session history. Non-authoritative verifier verdict: no contrary evidence (harness uses ocw_e2e / ocw-e2e-storage / :4290-4292; 05-VALIDATION records the 05-02 gate approved and the demo baseline identical before and after 05-15)"
    why_human: "Process prohibitions leave no artifact in the repo"
---

# Phase 5: Direct AI Chat Verification Report

**Phase Goal:** A user holds a private, streaming AI conversation with organization-configured models and every generation metered — a new AI chat run loop (AI SDK 7) next to the bots' OpenClaw path, with the Phase 1 Settings › Models providers moved to `SecretReference`s that govern AI chats as well as bots (mode: mvp; owner decisions D-01 … D-08 add the member's own ChatGPT plan as the default backend)
**Verified:** 2026-10-07T06:01:43Z at `b9115b2` (branch `feat/phase-5-ai-chat`, draft PR #17)
**Status:** human_needed
**Re-verification:** No — initial verification

## User Flow Coverage (MVP mode)

The ROADMAP goal is not in user-story form (MVP-mode discrepancy, informational, same as Phase 4). 05-01-PLAN restates it
with the same intent: *As a member of an organization that uses the workspace, I want to hold a private, streaming AI
conversation on my own ChatGPT plan by default or on a model my organization pays for — choosing the model per message,
stopping and regenerating answers, with titles, instructions, web search, files, a usage record for every answer and a
read-only share link for colleagues — so that I get a ChatGPT/Claude.ai-quality assistant inside the workspace where
every generation is metered, private by default and attributable.*

| Step | Expected | Evidence in codebase | Status |
| --- | --- | --- | --- |
| Connect my own plan | Settings › AI chat → Continue with ChatGPT; the API runs PKCE/state/nonce/JWKS; tokens sealed per member | `model-gateway/chatgpt-plan/{oauth,credentials,routes}.ts`; sealed in `app.secrets` with AAD `<org>:<user>:chatgpt_plan`; `signin.int` (Alex cannot complete Sam's flow, no plaintext in any column) | ✓ (real OpenAI: human) |
| Or use an org model | Admin key as SecretReference; org rows METERED | `agent/index.ts` writes `secretRef {provider:'db'}`; `model-gateway/index.ts` `resolveOrgKey` → `core.secrets.resolve`; `metered: true` on every org row; `model-picker.tsx` `MeteredBadge` | ✓ |
| Chat and watch it stream | New chat, deltas over WS, durable final message | `ai-chat/run-loop.ts` (one `streamText`, 50 ms `ai.delta` with offsets, one finalize); web `lib/ai-chat-stream.ts` `applyAiDelta`/`stitchAiSnapshot`; `app/(app)/chat/ai/{new,[chatId]}/page.tsx` | ✓ |
| Switch model, stop, regenerate | Per-message ref; Stop keeps partial across instances; regenerate keeps versions | `SendAiMessageRequest.model`; `generations.ts` (`ocw:ai:abort` Redis fan-out, `message_versions` insert); `stop.int`, `regenerate.int` | ✓ |
| Titles, list, search | Auto title on owner's backend; rename/archive; owner-only search | `titles.ts` (conditional on `title_source='heuristic'`, metered); `search/index.ts` `ai_chat` kind via readable set; `titles.int`, `list.int`, `search.int` | ✓ |
| Instructions and tools | Personal + per-chat instructions; Web only functional | `build-model-messages.ts`; `aiToolStates` (3 tools `not_available_yet`, `AiChatTools = {web}` only); `web-tools.ts` SearXNG on org keys, hosted search on plan | ✓ |
| Attach files | Bytes read by API, gated by caps, untrusted | `ai-chat/attachments.ts` `readAttachmentBytes` → `Uint8Array` file parts, `untrustedFileBlock`; `attachments.int` | ✓ |
| See usage | Tokens/cost per answer, caps, reports | `usage.ts` one record per generation+kind (append-only grant), `limits.ts` caps, `usage-routes.ts` | ✓ |
| Share with a colleague | Same-org signed-in snapshot, never public | `shares.ts` (`requireUser` onRequest, tenant RLS, uniform 404, share-scoped files); `shares.int` | ✓ |

The `[outcome]` clause holds: every generation writes exactly one immutable usage record, AI chats are owner-only
(admins included → 404), and every credential/route is attributable and audited without bodies.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: Admin configures org providers with keys held as `SecretReference` (Phase 1 `app.secrets` keys migrated) and an allowed list governing AI chats and bots; no personal API key path | ✓ VERIFIED | Backfill `packages/db/drizzle/20261006153117_provider_secret_refs/migration.sql` (idempotent `where secret_id is not null and secret_ref is null`, rollback documented); resolution only via `core.secrets.resolve` (`model-gateway/index.ts` resolveOrgKey, `agent/service.ts` cellProviders); `allowedModels(core, tx)` shared with bots; `secret-ref-migration.int` (backfill/idempotent/ciphertext untouched/rollback), `providers-secret-ref.int` (A/B secret, rolled-back state → no_key, foreign-org ref refused, migrated row still serves a bot, OpenAPI has exactly one `apiKey` body under `/model-providers`) — green in this run |
| 2 | SC2: Private AI chat, model from allowed list, per-message switch, realtime stream, stop with partial kept, regenerate | ✓ VERIFIED | `run-loop.ts` + `service.ts` (partial unique index `ai_generations_one_running_uq` → 409, advisory-lock cap → 429); `ai-chat.int` (deltas chained from offset 0 = final body; Alex/admin 404 and cannot subscribe `conv:`), `stop.int` (stop through instance B keeps exactly the streamed text; sweeper/shutdown → interrupted with partial), `regenerate.int`, `org-models.int` (per-message switch) — green in this run |
| 3 | SC3: Auto title, list with rename/archive/search; instructions per chat and personal defaults | ✓ VERIFIED | `titles.ts` (owner's credential, never over a user title, usage kind `title`); `list.int`, `titles.int`, `search.int` (Alex and admin see nothing); `build-model-messages.ts` order + personal dropped with a second human (`build-model-messages.test`, `tools.int`) |
| 4 | SC4: Every generation writes a usage record (model, provider, tokens, cost, requester) and the chat shows tokens per message; Web/Company Knowledge/MCP/Skills toggles with only Web functional | ✓ VERIFIED | `usage.ts` `recordUsage` called from the single finalize and from titles; `REVOKE UPDATE, DELETE, TRUNCATE ON app.ai_usage_records`; `usage.int` (every outcome, 10 concurrent at cap 5 → 5, no model call at cap); `aiToolStates` + `AiChatTools = {web}`; `tools.int`, `web-tools.test` |
| 5 | SC5: Files/images to vision models via the upload pipeline; org-scoped read-only snapshot share, never public | ✓ VERIFIED | `attachments.ts` (bytes only, no URL, caps gate before send); `attachments.int`; `shares.ts` + `shares.int` (anonymous 401 on every route, other org = random-id 404, revoke → 404, later messages never in snapshot, share-scoped files) |
| 6 | One run loop for both backends (D-01, P-04/P-05) | ✓ VERIFIED | `@ai-sdk/*` imported only in `model-gateway/{index,registry}.ts`; `streamText` only in `run-loop.ts` and `titles.ts`; `gateway.resolve` switches plan/org_key/mock into one `ResolvedModel`; `guard.test.ts` enforces it |
| 7 | Per-member token isolation (D-01/D-02: never pooled) | ✓ VERIFIED | `credentialOf(tx, requesterUserId)` / `accessTokenFor` read the requester's row only; no route takes a credential id; `signin.int` ("Alex's disconnect never touches Sam's", "Alex cannot complete Sam's flow"), `ai-chat.int` (Alex 409 not_connected, fake sees no request for him) |
| 8 | No plaintext tokens/keys anywhere | ✓ VERIFIED | `security.int` scans every text/jsonb column of `app.*`/`auth.*`, responses, WS frames, audit rows and logs after a full session on plan, Anthropic org key and mock — green in this run |
| 9 | Claude only via org Anthropic/OpenRouter key, METERED (D-03) | ✓ VERIFIED | `isOrgKeyProvider` excludes subscription providers (`openai-codex` only); no Anthropic plan path exists; org rows `metered: true`; METERED badge in picker, chip, footer, Settings › Models |
| 10 | SearXNG on org keys; plan hosted search; disabled with reason when not configured (D-04) | ✓ VERIFIED | `orgCaps` → `webSearch: "function"` only with `OCW_AI_SEARXNG_URL` (defaults to compose `OCW_SEARXNG_URL`, `search` profile); `hostedTools` only on plan; `tools.int` (no SearXNG → `search_not_configured`, no tools sent) |
| 11 | Attachments untrusted, cannot trigger tools | ✓ VERIFIED | `untrustedFileBlock`, files only in the user message; tools only when Web is on (`webAllowed`); `attachments.test`, `attachments.int` |
| 12 | Every AI route requires a session | ✓ VERIFIED | All 29 AI routes use `onRequest: core.identity.requireUser` (counted per file); `security.int` OpenAPI sweep asserts the full list answers 401 anonymously — green in this run |
| 13 | Docs/decisions: ADR-0017 and ADR-0018 accepted, AGENTS.md < 200 lines, owner manual check written | ✓ VERIFIED | Both ADRs `Accepted`; AGENTS.md 199 lines; `docs/DEMO.md` › AI chats (line 261+) has the manual check |

**Score:** 13/13 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/contracts/src/{ai-chat,ai-generation,model-prices}.ts` | Contracts once | ✓ VERIFIED | Used by API and web (`lib/ai-chat-queries.ts`, `ai-chat-stream.ts`) |
| `packages/db/drizzle/20261006152939_ai_chat`, `…153117_provider_secret_refs` | Schema + backfill | ✓ VERIFIED | 8 tables under generic FORCE RLS (`post-migrate.sql`); only two Phase 5 migrations |
| `apps/api/src/modules/model-gateway/**` | Gateway, SIWC, policy, catalog | ✓ VERIFIED | 497-line gateway, 373-line credentials, 348-line OAuth; wired via `createModelGatewayModule` |
| `apps/api/src/modules/ai-chat/**` | Run loop, service, stop/regenerate, sweeper, titles, usage, tools, attachments, shares | ✓ VERIFIED | Substantive (run-loop 606, service 808, shares 428 lines); no stubs |
| `apps/web/components/ai-chat/**`, `app/(app)/chat/ai/**`, `share/ai/**`, `settings/ai-chat` | UI | ✓ VERIFIED | Pages call the API through `lib/ai-chat-queries.ts`, `ai-share-queries.ts`, `chatgpt-plan-queries.ts` |
| `apps/desktop/src/main/chatgpt-loopback.ts` | Desktop loopback | ✓ VERIFIED | Binds `CHATGPT_LOOPBACK_HOST` only; desktop process, not the daemon |
| `infra/fake-model/{fake-responses,fake-siwc}.mjs` | Fakes | ✓ VERIFIED | `node --test 'infra/**/*.test.mjs'` 121/121 |
| `docs/adr/0017-…`, `0018-…` | ADRs | ✓ VERIFIED | Accepted |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| `run-loop.ts` | `model-gateway.resolve` | `deps.gateway.resolve(tx, ref, gen.requesterUserId)` in `prepare` | ✓ WIRED |
| `model-gateway resolveOrgKey` / `agent cellProviders` | `secrets.resolve` | `row.secretRef` only | ✓ WIRED |
| `resolvePlan` | member credential | `usablePlan` → `credentialOf`/`accessTokenFor(requesterUserId)` | ✓ WIRED |
| `finalizeIn` | `recordUsage` + `message.updated` | same transaction | ✓ WIRED |
| Stop route | other instance's `AbortController` | Redis `ocw:ai:abort` | ✓ WIRED |
| `turn.ts` | `attachmentPartsFor` → storage bytes | `files: {storage, caps}` | ✓ WIRED |
| search | AI chats | `SEARCH_KINDS` includes `ai_chat` through the resolver's readable set | ✓ WIRED |
| Web composer | API | `POST /api/v1/ai-chats[/:id/messages]`, WS `ai.delta` reducer | ✓ WIRED |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
| --- | --- | --- | --- | --- |
| Message footer tokens/cost | `generation.usage` | `ai_usage_records` row written at finalize | Yes | ✓ FLOWING |
| Model picker | `AiModelList` | plan catalog per member + `model_providers.allowed_models` + policy | Yes | ✓ FLOWING |
| Usage reports | `AiUsageReport` | `ai_usage_records` aggregates (`usage-routes.ts`) | Yes | ✓ FLOWING |
| Share view | `AiShareView` | `ai_chat_shares.snapshot` (frozen copy) | Yes | ✓ FLOWING |

### Behavioral Spot-Checks (run by this verifier)

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full lint + typecheck + all unit/integration/web tests (incl. every Phase 5 `*.int` on ephemeral PG/Redis/Garage) | `pnpm verify` | exit 0; Biome 4 warnings (pre-existing, `apps/local-runtime`); **171 files, 2,310 tests passed**, 0 skipped | ✓ PASS |
| Uncached typecheck after contract changes | `pnpm typecheck --force` | 8/8, 0 cached | ✓ PASS |
| Fakes (Responses API, SIWC, SearXNG, model) | `node --test 'infra/**/*.test.mjs'` | 121/121 | ✓ PASS |
| Phase 5 integration files are in the suite | `vitest list --project integration --filesOnly` | 18 Phase 5/AI files listed (security, secret-ref-migration, providers-secret-ref, ai-chat, stop, regenerate, signin, plan-errors, shares, attachments, usage, usage-reports, titles, list, tools, org-models, search, rls-isolation) | ✓ PASS |
| Full isolated e2e (desktop + mobile) | not re-run here (outside the allowed command set) | executor gate run 4: 237 passed, 2 skipped by design, 0 failed (05-VALIDATION) | ? SKIP (executor evidence) |
| Desktop loopback unit tests | not re-run here | executor: 88/88 (05-VALIDATION) | ? SKIP (executor evidence) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared or present for this phase. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
| --- | --- | --- | --- |
| AICHAT-01 | 05-01, 05-04 | ✓ SATISFIED | Truth 1 |
| AICHAT-02 | 05-02…05-07 | ✓ SATISFIED (real SIWC: human) | Truths 2, 7, 9 |
| AICHAT-03 | 05-02, 05-03, 05-06 | ✓ SATISFIED | Truth 2 |
| AICHAT-04 | 05-10 | ✓ SATISFIED | Truth 3 |
| AICHAT-05 | 05-11 | ✓ SATISFIED | Truth 3 |
| AICHAT-06 | 05-11 | ✓ SATISFIED | Truths 4, 10 |
| AICHAT-07 | 05-01, 05-08, 05-09 | ✓ SATISFIED | Truth 4 |
| AICHAT-08 | 05-12 | ✓ SATISFIED | Truths 5, 11 |
| AICHAT-09 | 05-13 | ✓ SATISFIED | Truth 5 |

No orphaned requirements: REQUIREMENTS.md maps exactly AICHAT-01…09 to Phase 5.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| Phase 5 modules (ai-chat, model-gateway, web ai-chat, desktop loopback, fakes) | — | TBD/FIXME/XXX | — | None found |
| `model-gateway/index.ts` | 123 | `PLAN_PLACEHOLDER` | ℹ️ Info | Not a stub: the single unavailable plan row shown with a reason |
| `apps/web/components/bots/bot-detail-sheet.tsx` | 93-104 | Bot form model select lists org-key models without a METERED badge | ⚠️ Warning (cosmetic) | Outside P-11's listed surfaces (picker, chip, footer, Settings › Models, which say billing for bots); noted in 05-04 SUMMARY |
| Search palette | — | Snippets show raw Markdown link text | ℹ️ Info | Cosmetic, 05-15 open item |
| `deferred-items.md` | — | Phase 1–4 routes validate body before session (400 vs 401); request logs carry query strings | ℹ️ Info | Outside Phase 5's surface; every AI route was moved to `onRequest` |

### Prohibitions

All code-checkable prohibitions in 05-01…05-15 hold (single-gateway/single-run-loop guards, no `secret_id` resolution,
`secret_id` not dropped, only two Phase 5 migrations, no personal key route, Company Knowledge/MCP/Skills never reach a
model, no fetch tool, append-only usage and versions, no storage URL to providers, no anonymous share route). Process-only
prohibitions (demo untouched, no migration on the .env DB, no real provider call, package gate) are judgment tier and
flagged for owner review above (non-authoritative verdict: no contrary evidence).

### Human Verification Required

1. **Real Sign in with ChatGPT (paste)** — on the demo after merge, connect your own Plus/Pro plan by pasting the 127.0.0.1 address; one turn streams, Stop keeps the partial, footer "ChatGPT plan".
2. **Desktop loopback** — Disconnect and reconnect in the desktop app without pasting.
3. **Business/Enterprise eligibility** — when a seat is available: connected vs `not_eligible` with fallback to org models.
4. **Visual review** — `05-UI-REVIEW.md` and the `review-*` / `ai-chat-day-*` screenshots (1440/390, light/dark).
5. **Process prohibitions** — confirm from session history.

### Gaps Summary

No gaps. Every ROADMAP success criterion and owner decision D-01…D-08 is backed by substantive, wired code and by
integration tests this verifier ran (`pnpm verify`: 171 files / 2,310 tests on ephemeral PostgreSQL, Redis and Garage;
fakes 121/121). What remains is what no harness can prove: the real OpenAI sign-in (paste and desktop), Business seat
eligibility and the owner's visual judgement — all owner manual checks, not code gaps. Not re-run here: the full
isolated e2e and the desktop suite (executor gate evidence only).

---

_Verified: 2026-10-07T06:01:43Z_
_Verifier: Claude (gsd-verifier)_
