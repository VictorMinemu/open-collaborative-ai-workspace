---
phase: 05-direct-ai-chat
plan: 09
subsystem: api, web, contracts
tags: [usage, reports, metering, privacy, ai-chat, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 01
    provides: AiUsageReportQuery / AiUsageReport / AiUsageReportRow contracts, ai_usage_records with (organization_id, created_at) and (organization_id, requester_user_id, created_at) indexes
  - phase: 05-direct-ai-chat
    plan: 08
    provides: recordUsage (one record per generation and kind), usage-routes.ts registered once, GET /me/ai-usage/today, formatTokens / formatCostMicros, lib/ai-usage-queries.ts
provides:
  - "GET /api/v1/ai-usage/report?days=1..90&groupBy=user|model (provider.manage): the organization's usage by member or by model"
  - "GET /api/v1/me/ai-usage/report?days=1..90 (groupBy=model only): the caller's own records"
  - "usageReport(tx, {days, groupBy, userId?}) in usage-routes.ts; AiMyUsageReportQuery contract"
  - "Web: AiUsageReport (Settings › Models › Usage), UsageCard (Settings › AI chat › Usage), useAiUsageReport / useMyAiUsageReport"
affects: [05-10, 05-11, 05-12, 05-13]

actuals:
  tokens: 15600   # chars/4 over added lines of the realized diff (62,369 chars), screenshots excluded
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Report aggregates: one grouped select over ai_usage_records in the tenant transaction (RLS plus an explicit organization predicate for the index), count(*) filter for answers, null-safe sum for cost"
    - "Answers (`generations`, `estimatedGenerations`) count chat records only; title records add tokens and cost and get their own '<model> · titles' row by model, so totals are identical by member and by model"
    - "An sr-only element inside a scroll pane needs a positioned ancestor, or it extends the document and shifts the app shell"

key-files:
  created:
    - apps/api/src/modules/ai-chat/usage-reports.int.test.ts
    - apps/web/components/ai-chat/admin/ai-usage-report.tsx
    - apps/web/components/ai-chat/settings/usage-card.tsx
    - e2e/tests/ai-chat-usage-reports.spec.ts
  modified:
    - apps/api/src/modules/ai-chat/usage-routes.ts
    - packages/contracts/src/ai-chat.ts
    - packages/contracts/src/ai-chat.test.ts
    - apps/web/lib/ai-usage-queries.ts
    - apps/web/app/(app)/settings/models/page.tsx
    - apps/web/app/(app)/settings/ai-chat/page.tsx

key-decisions:
  - "Report window = the last `days` UTC days, today included (from = today - (days - 1) at 00:00Z), filtered on the record's created_at"
  - "Keys: member rows use the user id (label = org_members.display_name, 'Former member' when gone); model rows use `${backend}:${provider}/${modelId}` (+ ' · titles'). Plan model labels come from the openai-codex catalog (GPT-6 Astra); the mock is 'Mock (E2E)', as in the answer footer"
  - "Cost is null-safe: a member's plan row is null ('Not billed'), the mock is 0, a member row sums whatever is priced; totals are the Σ of rows"
  - "The /me report shares usageReport with a userId filter and requires ai_chat.use, like /me/ai-usage/today; its querystring is a separate contract (groupBy literal 'model'), so groupBy=user is a Zod 400"
  - "Charts kept minimal (dataviz form choice): tables plus one thin single-hue cost-share bar per row and daily-limit meters; destructive tone only at a cap, always with text"

coverage:
  - id: D1
    description: "Organization report by member and by model: answers, tokens, null-safe cost, estimated answers, totals = Σ rows, titles under their own key, window excludes older records"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ai-chat/usage-reports.int.test.ts › the organization report by member and by model"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-usage-reports.spec.ts › an admin sees AI chat usage by member and by model over 30 and 7 days (desktop + mobile)"
        status: pass
    human_judgment: true
  - id: D2
    description: "Privacy: members get 403 on the org report; /me holds only the caller's records and refuses groupBy=user; org B never visible (even a record forging Sam's id); no prompt or answer text in any response"
    requirement: AICHAT-07
    verification:
      - kind: integration
        ref: "usage-reports.int.test.ts › 403, org isolation, a member's own usage report"
        status: pass
    human_judgment: false
  - id: D3
    description: "Member's own usage: today against limits (org models METERED, plan counted and not billed), last 30 days by model"
    requirement: AICHAT-07
    verification:
      - kind: e2e
        ref: "ai-chat-usage-reports.spec.ts › a member sees their own usage today against the limits and over the last 30 days by model (desktop + mobile)"
        status: pass
    human_judgment: true

duration: ~35min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 09: AI chat usage reports Summary

**Admins now see who spent what on which model. Settings › Models › Usage shows the last 7, 30 or 90 days of AI chat usage by member or by model: answers, input and output tokens, cost with each row's share, totals, and how many answers were estimated. Members see their own usage in Settings › AI chat › Usage: today against the daily limits, and the last 30 days by model. Their ChatGPT plan answers are counted but labelled "Not billed". Reports carry ids, counts and money only.**

## Accomplishments

- **API (`usage-routes.ts`; `ai-chat/index.ts` untouched):**
  - `GET /ai-usage/report` requires `provider.manage`.
  - `GET /me/ai-usage/report` returns only the caller's records, grouped by model.
  - Both routes run one grouped aggregate over `ai_usage_records` in the tenant transaction. The query reads no text column.
  - `days` is capped at 90 by the contract.
- **Web:**
  - `AiUsageReport` sits below the AI chat policy. It has By member / By model and 7 / 30 / 90 days controls, three summary tiles (Answers, Tokens, Organization cost), a table at `sm` and up, and stacked rows at 390.
  - Model rows show who pays: METERED, ChatGPT plan "Not billed", or Not metered.
  - `~` marks an estimated cost. A note explains estimates and says a failed answer's estimate errs high.
  - `UsageCard` sits below the ChatGPT plan card. "Today" shows organization models with a meter against the cap, tokens and cost, and the ChatGPT plan "Counted against your plan, not billed to your organization", with the local reset time. "Last 30 days" lists usage by model with a total.

## Task Commits

1. **Task 1 (tracer):** `360fe63` test (RED) · `e0901ba` feat(api) org report · `de19ac8` feat(web) Settings › Models › Usage + e2e
2. **Task 2:** `f36582b` test (RED) · `96d60b4` feat(api) `/me` report + contract · `54851a4` feat(web) UsageCard + e2e

## Verification

- **Integration:** `usage-reports.int.test.ts` passes 10/10 on ephemeral PostgreSQL + Redis with the in-process fake. RED was confirmed before each GREEN (404, then 400/404).
- **Unit:** contracts `ai-chat.test.ts` passes 20/20, including the new query schemas.
- **E2E** (isolated harness only):
  - Task 1 (`--rebuild-web ai-chat-usage-reports ai-chat-usage`): 7/7 pass.
  - Task 2 (`ai-chat-usage-reports ai-chat-signin`): 11/11 pass.
  - Final run (`--rebuild-web ai-chat-usage-reports ai-chat-usage ai-chat-signin`): **15/15** pass on desktop and mobile, with no skips or flakes.
- **`pnpm verify`:** passed after each task. Tests: 160 files, **2197 tests**, all pass. Lint has 4 warnings, all pre-existing in `apps/local-runtime`. `pnpm typecheck --force` passed after the contract change.
- **Acceptance greps:**
  - `"/ai-usage/report"` is at `usage-routes.ts:63` and `"/me/ai-usage/report"` is at `:47`.
  - `export function AiUsageReport` is at `ai-usage-report.tsx:21`.
  - `export function UsageCard` is at `usage-card.tsx:19`.
- **Screenshots reviewed with Read:** `settings-ai-usage-{1440,390}[-dark]`, `settings-ai-usage-models-{1440,390}` and `settings-ai-chat-usage-{1440,390}[-dark]`. An admin can read who spent what on which model. A member can tell what counts against the plan and what the organization pays. Nothing overflows at 390.
- **Safety:**
  - The demo was not touched. No real provider was called. No migration was added and `pnpm db:migrate` was never run.
  - Screenshots overwritten by regression specs were reverted. The `.env` symlink was removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Contracts first] `AiMyUsageReportQuery` in `packages/contracts/src/ai-chat.ts` (not in files_modified)**
- The `/me` route needs `groupBy` fixed to `model`, so `groupBy=user` is a 400. The contract is `AiUsageReportQuery.extend({ groupBy: z.literal("model").default("model") })` and has a unit test. Commit 96d60b4.

**2. [Rule 1 - Bug, own code] The report's `sr-only` table caption shifted the whole app shell**
- The caption had no positioned ancestor inside the scroll pane, so it extended the document. Settings › Models then scrolled the whole shell up by about 450px; this showed in our screenshots and in 05-08's policy screenshots. The fix is `relative` on the table wrapper. The e2e scrolls the settings pane, not `scrollIntoView`. Commit de19ac8.

**3. [Test determinism] The spec marks Sam's ChatGPT welcome as seen in `beforeAll`**
- `seedPlan` reconnects the plan, and the one-time welcome modal (05-07) then makes Settings › AI chat inert. The spec calls `POST /me/model-credentials/chatgpt/welcome-seen` through the API. Commit 54851a4.

**4. [Scope] Small additions**
- `BackendTag` is exported from `ai-usage-report.tsx` and reused by `UsageCard`.
- The Settings › AI chat description now mentions usage.
- The spec captures one extra screenshot pair: `settings-ai-usage-models-{1440,390}`.

### Notes (no change made)
- **Answers versus titles:** "answers" count chat records only. Title records add tokens and cost and appear by model as "Claude Haiku 4.5 · titles" with "—" (desktop) or "Chat titles" (phone) instead of a count. Totals are therefore identical by member and by model.
- **Estimated costs:** they follow 05-08. A failed answer's estimate errs high, which the report's note says.

## Deferred Issues

None.

## Windows Ledger

None. There are no stubs, skipped tests or unrun verifies, so nothing was appended.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. Each item is covered by an integration test:
- **T-05-09-01:** 403 for members; the `/me` filter plus a 400 on `groupBy=user`; RLS, including org B's record that forges Sam's id.
- **T-05-09-02:** no text in any response.
- **T-05-09-03:** `days` is capped at 90, and the explicit organization predicate lets the query use the 05-01 indexes.

## Next Phase Readiness

- 05-10's real title records will show up as "<model> · titles" rows by model with no further change.
- The reports read `ai_usage_records` only, so any new answer path that calls `recordUsage` is reported automatically.

## Self-Check: PASSED

- Files exist: usage-reports.int.test.ts, ai-usage-report.tsx, usage-card.tsx, ai-chat-usage-reports.spec.ts, usage-routes.ts.
- Commits found: 360fe63, e0901ba, de19ac8, f36582b, 96d60b4, 54851a4.
