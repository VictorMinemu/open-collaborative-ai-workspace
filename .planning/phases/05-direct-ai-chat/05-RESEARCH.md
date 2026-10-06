# Phase 5: Direct AI Chat - Research

**Researched:** 2026-10-06
**Domain:** Server-side LLM chat run loop (Vercel AI SDK 7), BYO subscription credentials (Sign in with ChatGPT), secret references, streaming over the existing realtime WS, metering, chat UX
**Confidence:** MEDIUM-HIGH (stack and repo facts HIGH; subscription terms and the brand-new OpenAI "ChatGPT plan usage" preview MEDIUM; prices of non-Anthropic models LOW)

<user_constraints>
## User Constraints

No `05-CONTEXT.md` exists yet (discuss-phase not run). The orchestrator passed this owner decision; it is copied verbatim and treated as locked.

### Locked Decisions

> **OWNER DECISION (2026-10-06, locked):** AI chats run on BOTH backends — **the customer's own subscriptions by default** (BYO, never pooled: ChatGPT via the OpenClaw cell's existing subscription sign-in; Claude via the subscription runtimes already integrated) **and optional organization API keys** (AI SDK 7 server-side with providers held as `SecretReference`, as ROADMAP Phase 5 describes). No personal API keys typed by users. Flag any paid/metered path clearly.

Research finding that the planner and owner must see before planning: **two mechanisms named inside this decision conflict with its own principle ("BYO, never pooled") or with the vendor's published terms.** See "Owner decisions" at the end. The principle (BYO by default, org keys optional, no personal API keys, flag metered paths) is fully implementable; the two named mechanisms are not the safe way to implement it.

### Claude's Discretion
Plan/wave split, table shapes, streaming protocol, title/usage/limit mechanics, UI layout (within D-08 of Phase 4: Slack/T3 Code quality, 1440/390, light/dark).

### Deferred Ideas (OUT OF SCOPE for Phase 5)
Multiplayer AI chats, sharing in place, agents in AI chats (Phase 6); Company Knowledge, MCP and Skills behind the toggles (visible but disabled); provider pools/routing/fallbacks (PRD §55-57, later MVP); NATS/Temporal (ADR-0003 deferred).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AICHAT-01 | Org-level providers with API keys as `SecretReference`; allowed-models list; no personal API keys | §SecretReference migration; §Model registry; existing `model_providers` + `SecretReference` type already include a `db` provider |
| AICHAT-02 | Private AI chat; pick model from allowed list; switch per message | §ModelRef (backend + provider + model), composer model picker, `ai_chat` conversation kind already in schema |
| AICHAT-03 | Stream to author; stop with partial persisted; regenerate last answer | §Run loop, §Streaming protocol (WS ephemeral `ai.delta` with offsets), §Stop/abort via Redis, §Regenerate |
| AICHAT-04 | Auto title; list; rename, archive, search | §Titles (ADR-0014 normalizer reused), §Search (readable set extended to `ai_chat`) |
| AICHAT-05 | Custom instructions per chat + personal defaults | §Instructions |
| AICHAT-06 | Web / Company Knowledge / MCP / Skills toggles, only Web functional | §Tool toggles and web search per backend |
| AICHAT-07 | Usage record per generation (model, provider, in/out tokens, cost estimate, requester); tokens per message | §Usage metering, price table, aborted-generation estimates |
| AICHAT-08 | Files/images to vision-capable models via upload pipeline | §Attachments (Phase 4 presign + `large.webp` rendition, `ObjectStorage.stream`) |
| AICHAT-09 | Org-scoped read-only snapshot share link, never public | §Snapshot shares |
</phase_requirements>

## Project Constraints (from AGENTS.md / CLAUDE.md)

- Principle 1/2/5/6/8/10/11/12 apply directly: sessions and history live in the Control Plane; secrets only by `SecretReference`; least privilege via the one resolver; self-hostable with `docker compose up`; stable ids; every sensitive action audited in the same transaction.
- "AI layer = Vercel AI SDK 7 server-side; prompts assembled from persisted messages by one `buildModelMessages`."
- "Participant identity in multi-human AI chats is structural … One generation per conversation."
- Zod at every boundary; contracts first in `packages/contracts`; modules talk through public `index.ts`.
- Tests: colocated `*.test.ts`; integration against real PostgreSQL/Redis containers; tenant isolation is a test target for every org-scoped table; failing test first.
- No `any`/`@ts-ignore`; Biome; Conventional Commits; ADR per architectural decision (never edit an accepted ADR, supersede).
- Never log prompts with credentials, provider keys or host paths; never weaken permission checks; treat chat/file/MCP/web content as untrusted.
- Never expose a listening TCP port **for the daemon**.
- CI never calls a metered model (SLICE-05): E2E uses `OCW_MODEL_PROVIDER=mock`, the fake model server.
- `pnpm-workspace.yaml`: `saveExact: true`, `minimumReleaseAge: 10080` (7 days) [VERIFIED: pnpm-workspace.yaml:5-8].
- CLAUDE.md: plan mode for permission/policy/audit/tenant-isolation changes and every schema migration — Phase 5 has all of these.
- Hard rules for this session (orchestrator): never touch the demo (ports 4000/3000, `ocw-demo-*`, `ocw` DB), no compose lifecycle on the demo, no OpenClaw containers locally, no real subscription turns.

## Summary

The repo already has most of the plumbing a direct AI chat needs: `conversations.kind` includes `ai_chat`, `messages.status` includes `streaming`, the realtime service has a documented ephemeral channel "for typing, deltas, presence" that the Work Zone already uses for `assistant.delta`, the Phase 4 upload pipeline produces downscaled `large.webp` renditions and exposes `ObjectStorage.stream`, search is resolver-scoped, the streamdown renderer has a streaming mode, and `SecretReference` already has an `env | file | db` union. What does not exist: any AI SDK dependency, a model-gateway module, usage records, an Agent Channel streaming path, or any per-user subscription credential.

The decisive finding is on the subscription side. **(1) OpenAI shipped an official route for exactly this on 2026-09-30 (DevDay): "Sign in with ChatGPT – ChatGPT plan usage" for open-source and self-hosted apps.** Each user authorizes their own ChatGPT plan (OAuth PKCE, dynamic client registration, no client secret) and the app calls the public `POST https://api.openai.com/v1/responses` with the user's bearer token, `store:false`, `stream:true`. OpenAI's docs say tokens "must not be shared or pooled across users" and that `backend-api` endpoints must not be used. That is the AI SDK's `@ai-sdk/openai` Responses provider with a per-user token: one run loop serves both backends. By contrast, the cell's sign-in (ADR-0006) is **one ChatGPT account per organization**, routed to `chatgpt.com/backend-api/codex`. Serving every member's private chats from it is the pooling the owner rules out, and it has no streaming path to our API today. **(2) Anthropic's published policy forbids third-party apps from routing requests through Free/Pro/Max credentials, explicitly including the Agent SDK.** A Claude-subscription AI chat (server-side via OpenClaw, or on-device via our daemon's Agent SDK) is not a sanctioned path. Claude in AI chats should come from an org Anthropic API key (metered, flagged).

**Primary recommendation:** Build one AI SDK 7 run loop in the API (`modules/model-gateway` + `modules/ai-chat`) with two credential sources. (a) **Per-user ChatGPT plan** (Sign in with ChatGPT, tokens encrypted per user behind a `SecretReference`; the default BYO path, $0 marginal cost, counts against the user's plan). (b) **Org API keys** (Anthropic / OpenAI / OpenRouter / OpenAI-compatible via `SecretReference`; metered, labelled). Stream deltas over the existing WS `conv:<id>` topic as ephemeral `ai.delta` frames with character offsets, persist the final message durably, and enforce one generation per conversation with a partial unique index. Do not route AI chats through the OpenClaw cell. Do not offer Claude-subscription chats.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Model call, streaming, abort, usage | API (`modules/model-gateway`) | — | Credentials and metering must stay server-side (principles 1, 8) |
| Prompt assembly (`buildModelMessages`) | API (`modules/ai-chat`) | contracts (types) | Built from persisted rows only (AGENTS.md) |
| One generation per conversation, stop, crash recovery | Database (partial unique index, heartbeat) | Redis (abort pub/sub across API instances) | Must hold across processes |
| Delta fan-out to browsers | API realtime (Redis pub/sub + WS ephemeral) | Browser (offset reducer) | Reuses `publishEphemeral`; no new transport |
| ChatGPT plan sign-in (OAuth PKCE + code exchange + refresh) | API | Browser (redirect paste) / Desktop (optional loopback) | Verifier, tokens and refresh never in the browser |
| Org provider keys | API secret store (`SecretReference`) | — | AICHAT-01 |
| Attachments for vision | Object storage (Garage via S3 API) → API reads bytes | Browser upload (Phase 4 presign) | Provider never fetches our storage URLs |
| Web search tool | API (hosted tool on plan backend / SearXNG function tool on org-key backend) | SearXNG container (optional profile) | ADR-0010 bans paid search for bots; see owner decision 3 |
| Chat list, titles, instructions, toggles | API + Web | — | Standard CRUD + realtime |
| Snapshot share | API (immutable snapshot row) + Web | — | Org-scoped, authenticated only |

---

## 1. Subscription backend options (question 1)

### 1a. ChatGPT through the OpenClaw cell (as literally stated in the owner decision)

**What exists (CONFIRMED, read this session):**
- One sign-in per organization: `model_providers` has a unique index on `(organization_id, provider)` and stores the signed-in account as identity metadata only [VERIFIED: packages/db/src/schema/app.ts:846-875 — `uniqueIndex("model_providers_org_provider_uq").on(t.organizationId, t.provider)`, `account: jsonb("account").$type<{ email: string | null; planType: string | null; connectedAt: string; needsReconnect: boolean; }>()`]. ADR-0006: "one sign-in serves every bot of the cell", tokens live in OpenClaw's auth store and route to `chatgpt.com/backend-api/codex` [VERIFIED: docs/adr/0006-subscription-sign-in-inside-the-cell.md].
- The channel plugin dispatches a turn through OpenClaw's inbound pipeline and receives **whole reply blocks**, not token deltas: `deliver: async (payload: { text?: string; isReasoning?: boolean }) => …` and `replyOptions: { disableTools: allowed.length === 0, abortSignal: signal }` [VERIFIED: apps/openclaw-channel/src/openclaw-port.ts:347-367]. The Agent Channel API has `POST /messages` and `POST /typing` and no delta route [VERIFIED: packages/contracts/src/agent-channel.ts:23-27]. There is no usage/token report from the cell.
- The cell gateway is bound to loopback with token auth: `bind: "loopback"` [VERIFIED: infra/openclaw/render-config.mjs:153]. The API cannot reach the gateway directly.

**What OpenClaw could offer (CITED: docs.openclaw.ai/gateway/openai-http-api):** an OpenAI-compatible `POST /v1/chat/completions` on the gateway port. It is disabled by default, accepts a full `messages` array (stateless per request unless `user` is set), supports SSE streaming and `stream_options.include_usage=true`, accepts images (8 max), and cancels on disconnect. But the docs say: "Treat this endpoint as **full operator access** to the gateway instance." To use it, the `ocw` plugin would call it on loopback and relay deltas over a new Agent Channel streaming route.

**Verdict: technically feasible (MEDIUM), not recommended.**
1. **Pooled seat.** The cell holds one ChatGPT account for the whole org. Every member's private chats would spend one person's plan. That contradicts "BYO, never pooled". OpenAI's SIWC docs say tokens "must not be shared or pooled across users" [CITED: developers.openai.com/siwc/token-sharing-open-source/sign-in]. ChatGPT seats are per person [ASSUMED for the Codex OAuth path].
2. **Route.** OpenAI's plan-usage docs say "do not point it at ChatGPT's `backend-api` endpoints" [CITED: developers.openai.com/siwc/token-sharing-open-source/models-and-inference]. OpenClaw's Codex OAuth uses `backend-api/codex` (ADR-0006). The statement is written for SIWC clients, so whether it binds the Codex-CLI OAuth that OpenClaw reuses is NEEDS VALIDATION.
3. **Engineering cost.** New delta route through the plugin, enabling an operator-level HTTP endpoint inside the cell, OpenClaw's own agent prompt wrapped around ours, no regenerate/model-switch semantics beyond what we resend, and a dependency on the cell being up. Every one of these is avoided by 1-alt below.

**Existing exposure to flag (not Phase 5 scope):** bots on the org ChatGPT sign-in already spend one member's seat for everyone's bot turns.

### 1a-alt. ChatGPT per user via "Sign in with ChatGPT – ChatGPT plan usage" (RECOMMENDED)

Everything below is CITED from OpenAI's docs, fetched this session (`developers.openai.com/siwc/token-sharing-open-source*.md`):

| Fact | Detail |
|---|---|
| Who | "ChatGPT plan usage is available to all open-source partners and selected private clients." The overview adds: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." A **Self-hosted VMs** page covers running the open-source app on a remote VM. |
| Registration | First sign-in uses `client_id=dynamic_agent_client` + `agent_name_hint` (app name, e.g. "Open Collaborative AI Workspace") + `ext_agent_host_id` (stable opaque per host: `urn:uuid:…` or a JWK thumbprint). The callback returns an issued `client_id` (`oaiapp_…`) bound to that user and workspace. No client secret, no partner API key. |
| OAuth | Authorization code + PKCE S256, `state`, `nonce`. Scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`. Authorize at `https://auth.openai.com/api/accounts/authorize`, token at `…/oauth/token`. |
| Redirect | "Use an HTTP loopback callback on `127.0.0.1` … only the port may vary … Do not substitute with `localhost`." For a remote VM: "A `127.0.0.1` callback reaches the computer running the browser, not the remote VM. Complete OAuth locally…" |
| Validation | Verify the ID token against JWKS (issuer, audience = issued client id, exp, nonce). Check that granted scopes include `chatgpt.tokens.use.direct`, else plan usage is disabled. |
| Inference | `POST https://api.openai.com/v1/responses` with `Authorization: Bearer <access_token>`. "**Set `store` to `false` and `stream` to `true` on each HTTP inference request.**" Only `response.completed` counts as success. |
| Preview limits | System-role message items are rejected ("Use `instructions` or developer messages"). Omit `max_output_tokens`, `temperature`, `top_p`, `metadata`, `user`, `truncation`, `previous_response_id`, `prompt_cache_retention`, `safety_identifier`, `background`, `conversation`, `max_tool_calls`. **Inputs: "Text, images, and files are supported when the selected model accepts them."** Web search is "subject to model and account/workspace policy". Image generation, file search, Code Interpreter and hosted MCP are unsupported. |
| Models | `GET https://api.openai.com/v1/models` with the user's token returns that account's catalog (`slug`, `display_name`, `visibility`). Show `visibility: "list"`. |
| Errors | `subscription_sharing_usage_limit_exceeded` (429, can arrive mid-stream as `response.failed`), `…_user_not_eligible` (403), `…_usage_unavailable` (503), `…_unsupported_capability` (400 + `error.param`), `…_invalid_user` (401), `…_route_not_supported` (403). Pre-stream admission errors can be `{"detail": "..."}` with 401/403/503. "OpenAI does not silently switch the request to another billing path." |
| Tokens | Access token ~3600 s. Refresh with `grant_type=refresh_token` + issued `client_id` + `resource`. Refresh tokens rotate: "serialize refreshes for the same session". Revoke at sign-out via the OIDC `revocation_endpoint`. "Keep tokens out of browser storage, source control, logs…". "Servers may hold tokens for their authenticated user." |
| Limits | Plus has a five-hour limit shared across all apps. Users manage per-app limits at `chatgpt.com/settings/usage`. |
| UI rules | A "Continue with ChatGPT" button, a one-time welcome modal, **"Using ChatGPT plan" near the composer/model selector with a "Manage usage" link**, and a usage-limit modal with "Manage usage" as the primary action (CITED: developers.openai.com/siwc/ui-ux-guidelines). |

**How it maps onto OCAW:**
- **Host id:** one `ext_agent_host_id` per OCAW deployment, generated once and persisted (org settings or a deployment row). It is opaque, not a secret.
- **Callback for a self-hosted server:** the server cannot receive a `127.0.0.1` redirect. Phase 5 should do the authorization start and the code exchange in the API (it keeps the PKCE verifier, `state` and `nonce` in Redis with a TTL, the same pattern as the 3.1 device-code flow state). The browser opens the authorize URL. The redirect lands on `http://127.0.0.1:1455/auth/callback?code…`, which shows a browser error page because nothing listens. The user pastes that URL into an OCAW dialog, and the API validates `state` and exchanges the code. Optionally, the desktop app runs a transient loopback listener and forwards `{code, state}` to the API without manual paste. Compliance of the paste pattern is NEEDS VALIDATION. The docs require a loopback redirect and say nothing against manual relay. Codex CLI and OpenClaw use this relay pattern for remote setups [ASSUMED].
- **Token custody:** the API stores per-user credentials encrypted in `app.secrets` (new kind) and references them from a `user_model_credentials` row. Refresh is serialized with `SELECT … FOR UPDATE` on that row plus a Redis lock. This is API custody, which ADR-0006 rejected *for the cell's* org sign-in to avoid racing OpenClaw's refresher. Here OpenClaw is not involved, so the race does not exist. It still needs a new ADR (ADR-0017) that complements ADR-0006 for AI chats.
- **Eligibility caveats (NEEDS VALIDATION):** docs say "Eligible ChatGPT Plus and Pro users". Whether **Business/Enterprise workspace seats** are eligible is unknown (`subscription_sharing_user_not_eligible` covers "user, workspace, or policy"). The **managed cloud** later counts as a "remotely hosted app" and needs the interest form; self-hosted OCAW matches the documented "Self-hosted VMs" case.

### 1b. Claude subscription

**Anthropic's published policy (CITED, verbatim from code.claude.com/docs/en/legal-and-compliance, fetched 2026-10-06):**
> "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code…"
> "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Secondary sources report server-side enforcement since January 2026 ("This credential is only authorized for use with Claude Code…") [CITED: gigazine.net 2026-02-20, alternativeto.net; secondary].

| Option | Status |
|---|---|
| OpenClaw `anthropic` provider with a subscription setup-token, server-side | **Not permitted** (routes requests through Pro/Max credentials on behalf of users; stores the token). CONFIRMED from the policy text. |
| Claude Agent SDK on the server with a user's login | **Not permitted** (same text, "including those using the Agent SDK"). CONFIRMED. |
| Claude Agent SDK on the user's own device (our daemon) driving a ChatGPT-style chat | **High risk / effectively not permitted.** Our code would call Claude through the user's Pro/Max OAuth from a third-party product surface. The carve-out covers "the unmodified Claude Code binary", i.e. ordinary Claude Code use. A general chat UI is not that. Classification NEEDS VALIDATION (legal), recommendation: do not build. |
| Claude via the org's Anthropic API key (AI SDK `@ai-sdk/anthropic`) | **Sanctioned. METERED** (Opus 5.5 $4/$20 per MTok, Sonnet 5.5 $2/$10, Haiku 4.5 $1/$5 [CITED: claude-api skill model table, cached 2026-09-25]). |

**Recommendation:** Phase 5 offers no Claude-subscription AI chat. Claude appears in the AI chat model picker only when an admin has configured an Anthropic (or OpenRouter) key, labelled as org-paid. The existing Work Zone use (user's own Claude Code login on their own device running coding sessions) relies on the "unmodified Claude Code binary" carve-out. It is outside this phase, but the owner should be aware that the Agent SDK sentence also touches it.

### 1c. On-device fallback (Local Runtime)

- **Feasible:** the daemon already runs one-shot model calls for titles (ADR-0014: `query()` with `tools: []`, `maxTurns: 1`; Codex ephemeral `app-server` thread) [VERIFIED: docs/adr/0014-automatic-session-titles-on-the-device.md].
- **Latency:** ADR-0014 measured a Codex title turn at ~7 s and a Claude title at 31 s with thinking on [VERIFIED: ADR-0014 Consequences]. Process spawn per turn adds seconds. Streaming would need a new device command and delta frames.
- **Availability:** zero when the desktop is asleep or offline. A web/mobile-first chat would fail unpredictably.
- **Terms:** Claude path as in 1b (not recommended). The Codex path is superseded by 1a-alt, which runs server-side, officially, with no device dependency.
- **Verdict:** do not build in Phase 5.

---

## Standard Stack

### Core

| Library | Version (pin) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ai` | **7.0.122** (2026-09-28) | `streamText`, abort, usage, message types, `ai/test` mocks | ADR stack row "Vercel AI SDK 7"; one stream format across providers [VERIFIED: npm registry; signature read from dist/index.d.ts] |
| `@ai-sdk/openai` | **4.0.80** | Responses API (org OpenAI key **and** per-user ChatGPT plan token), hosted `webSearch` | Only provider that speaks `/v1/responses` with `store`, `systemMessageMode`, `instructions` options [VERIFIED: dist/index.d.ts lines 1500-1545] |
| `@ai-sdk/anthropic` | **4.0.68** | Claude via org key | STACK.md Decision 4 |
| `@ai-sdk/openai-compatible` | **3.0.59** | OpenRouter, openai-compatible (vLLM/Ollama/LiteLLM), and the `mock` provider (fake model server) | STACK.md Decision 4 |

These four share `@ai-sdk/provider@4.0.19` + `@ai-sdk/provider-utils@5.0.51` [VERIFIED: npm view dependencies]. They are the newest versions older than the repo's 7-day `minimumReleaseAge` (the latest builds, `ai@7.0.128` etc., were published 2026-10-05 and would be refused by pnpm). STACK.md's `@ai-sdk/google` is not needed: there is no Google provider kind in `ModelProviderKind`.

### Supporting (already in the repo; reuse)
| Item | Where | Use |
|---|---|---|
| `jose` (if present via better-auth) or WebCrypto | API | ID-token JWKS verification for SIWC. Check whether `jose` is already a transitive dependency of better-auth; add it explicitly if used [ASSUMED] |
| streamdown 2.6.0 + @streamdown/code 1.1.1 | web | Streaming Markdown (`mode="streaming"`) [VERIFIED: apps/web/package.json; ADR-0016] |
| `normalizeSessionTitle`, `SessionTitle`, `SESSION_TITLE_MAX_CHARS = 32` | contracts | AI chat titles [VERIFIED: packages/contracts/src/session-title.ts:15-27,155,203] |
| `ObjectStorage.stream(key)`, `attachmentKey(..., "large.webp")` | api/artifact | Vision input bytes [VERIFIED: apps/api/src/modules/artifact/storage.ts:21-29,153] |
| `url-policy.ts` | api/mcp | SSRF guard for a `web_fetch` tool |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Per-user SIWC in API | OpenClaw `/v1/chat/completions` on the org sign-in | Pooled seat, backend-api route, new streaming relay; rejected |
| WS ephemeral deltas | SSE response of `POST /messages` | SSE is simpler for one tab, but duplicates the transport, breaks multi-tab/mobile and Phase 6 multiplayer; WS is already authorized per topic |
| `@ai-sdk/react` `useChat` | Zustand/TanStack store fed by WS | STACK.md: "Do not use `@ai-sdk/react`'s `useChat` default HTTP transport for multiplayer chats" |
| String model ids (`"openai/gpt-5"`) in `streamText` | Provider instances | Never use strings: `ai` depends on `@ai-sdk/gateway@4.0.100` [VERIFIED: npm view], and string ids route to **Vercel AI Gateway (metered, external)** [ASSUMED from AI SDK docs] |

**Installation (API only):**
```bash
pnpm --filter @ocw/api add ai@7.0.122 @ai-sdk/openai@4.0.80 @ai-sdk/anthropic@4.0.68 @ai-sdk/openai-compatible@3.0.59
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| ai | npm | multi-year; pinned version 8 days old | 34.5M/wk | github.com/vercel/ai | SUS ("too-new": the *latest* build is 1 day old) | Approved at **7.0.122** (satisfies the 7-day rule); no postinstall |
| @ai-sdk/openai | npm | same | 17.5M/wk | github.com/vercel/ai | SUS (too-new latest) | Approved at 4.0.80 |
| @ai-sdk/anthropic | npm | same | 17.2M/wk | github.com/vercel/ai | SUS (too-new latest) | Approved at 4.0.68 |
| @ai-sdk/openai-compatible | npm | same | 10.2M/wk | github.com/vercel/ai | SUS (too-new latest) | Approved at 3.0.59 |

`gsd-tools package-legitimacy check` flagged all four as SUS only because the newest publish was 2026-10-05. Packages are named in STACK.md (project research, sourced from ai-sdk.dev). **Planner:** keep one `checkpoint:human-verify` (or an automated `pnpm install --frozen-lockfile` + `npm view <pkg>@<ver> scripts.postinstall` check) before the install task. Postinstall was `null` for all four.
**Packages removed due to [SLOP]:** none.

---

## Architecture Patterns

### System Architecture Diagram

```
Browser (chat screen)                        API (Fastify)                                   Providers
─────────────────────                        ──────────────────────────────────────────      ─────────────────────
POST /ai-chats/:id/messages ───────────────► ai-chat routes
 {clientMessageId, body, model, attachments}  │ resolver: owner of ai_chat? model allowed?
                                              │ limits: consumeGeneration() (org-key only $/count)
                                              │ TX: insert user msg + assistant placeholder
                                              │     (status=streaming) + ai_generations(running)
                                              │     [partial unique idx: 1 running per conv]
                                              │     appendEvent(conv:<id>, message.created ×2)
                                              ▼ after commit
                                             run loop (in-process, AbortController)
                                              │ buildModelMessages(persisted rows, instructions,
                                              │   attachments→bytes from Garage)
                                              │ model-gateway.resolve(ModelRef, requester)
                                              │   ├─ chatgpt_plan → createOpenAI({apiKey:userToken})
                                              │   │                 .responses(slug), store:false ──► api.openai.com/v1/responses
                                              │   └─ org_key → SecretReference → provider instance ──► Anthropic / OpenAI /
                                              │                                                        OpenRouter / compat / fake
                                              │ streamText(...) ─ text-delta ─► coalesce 50 ms
WS conv:<id>  ◄── eph ai.delta {messageId,    ◄┘   publishEphemeral (Redis) ; partial_text flush 1 s
   offset,text}                                │ stop: POST …/stop → Redis "ocw:ai:abort" → owner instance aborts
WS conv:<id>  ◄── ev message.updated           │ end/abort/error: TX update message body+status,
   (final body, generation, usage)             │   ai_generations status, ai_usage_records (append-only),
                                               │   ai_usage_daily, audit; title job if first answer
GET /ai-chats/:id (snapshot incl. partial) ◄───┘ sweeper: heartbeat > 60 s → interrupted, keep partial
```

### Recommended Module Structure
```
packages/contracts/src/ai-chat.ts          # ModelRef, AiChat, Generation, Usage, Share, toggles, errors (Zod)
packages/contracts/src/model-prices.ts     # price table (USD/MTok) + estimateCost()
packages/db/src/schema/app.ts              # new tables (below) + migration + post-migrate RLS
apps/api/src/modules/model-gateway/        # index.ts: resolve(ModelRef, requester) → LanguageModel + caps
  registry.ts  credentials.ts  chatgpt-plan/{oauth,refresh,catalog,errors}.ts  prices.ts
apps/api/src/modules/ai-chat/              # routes, service, run-loop.ts, build-model-messages.ts,
  titles.ts  shares.ts  usage.ts  limits.ts  sweeper.ts  web-tools.ts
apps/web/app/(app)/chat/ai/[chatId]/page.tsx, components/ai-chat/*
infra/fake-model/server.mjs                # + POST /v1/responses (SSE), slow mode, fake SIWC auth + JWKS
```

### Data model (new migration; every table `organization_id` + ENABLE/FORCE RLS + `tenant_isolation`, seeded in `rls-isolation.int.test.ts`)

The values below come from existing enums that must be extended or reused verbatim:
- `conversations.kind`: `enum: ["channel", "dm", "group", "ai_chat", "thread", "work_session"]` [VERIFIED: packages/db/src/schema/app.ts:203]. `ai_chat` exists; reuse it with `visibility: "private"` and one `conversation_members` row `role: "owner"`.
- `messages.status`: `enum: ["sent", "streaming", "completed", "failed"]` [VERIFIED: app.ts:287]. Assistant message lifecycle: `streaming` → `completed` | `failed`. "Stopped" lives on the generation, not the message.
- `messages.author_kind`: `enum: ["user", "agent", "system"]` [VERIFIED: app.ts:283]. Recommendation: assistant messages use `author_kind: "agent"` with `author_id: null` and a `generation` projection. The model in a direct chat is not an agent principal (principle 2 forbids faking an agent with a flag). Phase 6 agent personas will set `author_id`. The alternative, a new `assistant` kind, touches every DMs/search/notification switch. Planner discretion, but decide in plan 01.
- `secrets.kind`: `enum: ["provider_api_key", "mcp_credential"]` [VERIFIED: app.ts:835]. Add `"user_model_credential"` (SIWC token bundle JSON, sealed with AAD = org id + user id).
- `message_versions.kind` check `in ('edit','delete')` [VERIFIED: app.ts:328,338]. Add `'regenerate'` to keep the replaced answer append-only.

New tables (shapes are a recommendation):
| Table | Key columns |
|---|---|
| `ai_chats` (1:1 with conversation) | `conversation_id` PK, `owner_user_id`, `title_source` (`user`/`heuristic`/`auto`, ADR-0014 semantics), `instructions` (≤ 8 000), `use_personal_instructions` bool, `last_model` jsonb ModelRef, `tools` jsonb `{web:boolean}` |
| `ai_user_preferences` | (`organization_id`,`user_id`) PK, `instructions`, `default_model`, `web_default` |
| `ai_generations` | `id`, `conversation_id`, `user_message_id`, `assistant_message_id`, `requester_user_id`, `backend` (`chatgpt_plan`/`org_key`/`mock`), `provider`, `model_id`, `attempt`, `status` (`running`/`completed`/`stopped`/`failed`/`interrupted`), `error_code`, `partial_text`, `heartbeat_at`, `started_at`, `finished_at`, `web_used`, `source_domains text[]`; **`uniqueIndex(...).on(conversation_id).where(status = 'running')`** |
| `ai_usage_records` (append-only: revoke UPDATE/DELETE/TRUNCATE like `message_versions`) | `generation_id` unique, `requester_user_id`, `conversation_id`, `message_id`, `kind` (`chat`/`title`), `backend`, `provider`, `model_id`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, `estimated` bool, `cost_micros_usd` bigint null, `price_ref` |
| `ai_usage_daily` | (`org`,`user`,`day`) PK, `generations`, `input_tokens`, `output_tokens`, `cost_micros_usd` (atomic conditional upsert, as `consumeTurn` [VERIFIED: apps/api/src/modules/bot-capabilities/usage.ts:38-59]) |
| `ai_chat_policies` (one row per org) | `chatgpt_plan_enabled`, `org_keys_enabled`, `daily_generations_per_user` (org-key), `daily_cost_micros_per_user` (org-key), `web_enabled`, `hosted_search_allowed` (metered, off), `title_models` jsonb, `max_context_tokens` |
| `user_model_credentials` | (`org`,`user`,`provider`=`chatgpt_plan`) unique, `secret_id` → `app.secrets`, `issued_client_id`, `subject`, `email`, `plan_type`, `scopes text[]`, `access_expires_at`, `status` (`connected`/`plan_disabled`/`needs_reconnect`/`not_eligible`), `connected_at` |
| `ai_chat_shares` | `id`, `conversation_id`, `created_by`, `snapshot` jsonb (messages: role, body, model label, createdAt, attachment ids), `attachment_ids uuid[]`, `created_at`, `revoked_at` |

### Pattern 1: ModelRef and the gateway
**What:** every chat turn names `ModelRef = { backend: "chatgpt_plan" | "org_key" | "mock", provider: ModelProviderKind, modelId }`. `model-gateway.resolve(tx, ref, requesterUserId)` returns `{ model: LanguageModel, caps: {vision, pdf, webHosted}, pricing, providerOptions }` or a typed refusal (`not_allowed`, `not_connected`, `needs_reconnect`, `no_key`).
- `org_key`: the model must be in `model_providers.allowed_models` of an enabled provider with a usable key. This is the **same list that governs bots** (AICHAT-01).
- `chatgpt_plan`: the model must be in the requester's catalog (`GET /v1/models`, `visibility:"list"`, cached ~1 h per credential) ∩ the org policy allowlist (empty = all). The requester's own credential is the only one ever used.
- `mock`: only when `OCW_MODEL_PROVIDER=mock` (existing rule [VERIFIED: packages/contracts/src/agent.ts:15-18]).

The current catalog values to reuse: `ModelProviderKind` = `["anthropic","openai","openrouter","openai-compatible","openai-codex","mock"]`, `SubscriptionProviderKind = z.enum(["openai-codex"])`, `DEFAULT_MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5" }` [VERIFIED: packages/contracts/src/agent.ts:20-27,31,236]. The per-user plan backend should be a **new backend, not a reuse of the `openai-codex` row**: the row means "the cell's org sign-in", and its model ids (`gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` [VERIFIED: agent.ts:322-327]) are OpenClaw catalog ids that may not equal `/v1/models` slugs (NEEDS VALIDATION).

### Pattern 2: the run loop (one function, both backends)
```typescript
// Source: ai@7.0.122 dist/index.d.ts (streamText params: instructions, abortSignal, maxRetries, onEnd, onAbort,
// onError, providerOptions); @ai-sdk/openai@4.0.80 responses options (store, systemMessageMode, instructions).
import { streamText } from "ai";

const ac = new AbortController();               // registered in a Map<generationId, AbortController>
const { model, providerOptions, maxOutputTokens } = await gateway.resolve(tx, ref, requesterId);
const { instructions, messages } = buildModelMessages(rows, chatSettings, prefs, attachmentsBytes);

const result = streamText({
  model,                                         // provider INSTANCE, never a "provider/model" string
  instructions,                                  // AI SDK 7 renamed `system` → `instructions`
  messages,
  abortSignal: ac.signal,
  maxRetries: ref.backend === "chatgpt_plan" ? 0 : 2,   // retries only happen before the stream opens
  ...(maxOutputTokens ? { maxOutputTokens } : {}),       // NEVER for chatgpt_plan (unsupported field)
  providerOptions,   // chatgpt_plan: { openai: { store: false, systemMessageMode: "developer" } }
                     // org OpenAI:   { openai: { store: false } }  (do not retain chats at the provider)
  tools: webTools,   // only when the Web toggle is on and the backend supports it
});
for await (const part of result.stream) {        // AI SDK 7 renamed fullStream → stream
  if (part.type === "text-delta") deltas.push(part);   // coalesce, publish, accumulate partial_text
  // "source" parts → source_domains; "error" → map provider codes; "abort" → finalize as stopped
}
const usage = await result.usage;                // total across steps in v7
```
Field names that could not be read from typings this session (`part.text` vs `part.delta` on `text-delta`) must be confirmed in plan 01 with a compile against the pinned version [ASSUMED].

### Pattern 3: streaming protocol (reuse WS, offsets for reconnect)
- Durable `message.created` for the user message and for the assistant placeholder (`status: "streaming"`, `body: ""`, plus a `generation` projection `{id, status, model label, backend}`).
- Ephemeral `ai.delta` `{ messageId, generationId, offset, text }` on `conv:<id>`, coalesced every ~50 ms. `offset` is the UTF-16 length already emitted, so a client applies a delta only when `offset === current.length` and refetches on a gap. Precedent: the Work Zone `assistant.delta` ephemeral path [VERIFIED: apps/api/src/modules/work-session/service.ts:921-936; packages/contracts/src/realtime.ts:189 `assistantDelta: "assistant.delta",`]. The realtime API documents it: "Fire-and-forget ephemeral event (typing, deltas, presence): never persisted, no seq." [VERIFIED: apps/api/src/modules/realtime/service.ts:74-75].
- Partial text flushes to `ai_generations.partial_text` every ~1 s, **not** to `messages.body`. `messages.search_tsv` is a STORED generated column (ADR-0016), so updating the body every second re-indexes three tsvectors each time. The REST snapshot returns `partial_text` for a running generation, so a reloaded tab resumes from the right offset.
- Durable `message.updated` at the end with the final body, `status`, generation `{status, finishReason, usage}`.

### Pattern 4: one generation per conversation, stop, crash recovery, idempotency
- Gate: insert `ai_generations(status='running')` inside the message transaction. The partial unique index rejects a second one; map that to 409 `generation_in_progress` (the UI shows Stop instead of Send). This holds across API instances.
- Idempotency: the user message reuses the existing unique `(organization_id, author_kind, author_id, client_message_id)` index [VERIFIED: app.ts:307-309]. A retried POST with the same `clientMessageId` returns the existing message and generation.
- Stop: `POST /ai-chats/:id/generations/:gid/stop` (owner only) publishes on Redis `ocw:ai:abort`. Every instance listens, and the one holding the `AbortController` aborts. The finalize step writes the accumulated text (partial kept), status `stopped`, and a usage record marked `estimated` (see Pitfall 3). Audit `ai_generation.stopped`.
- Crash/deploy: heartbeat `ai_generations.heartbeat_at` every 10 s. A sweeper (interval, like the attachments sweeper) marks `running` rows with a stale heartbeat (> 60 s) `interrupted`, copies `partial_text` into the message body, sets the message `completed` and emits `message.updated`. On SIGTERM, abort running generations as `interrupted` after a final flush.
- Regenerate: allowed only for the last assistant message when no generation is running. Append the old body to `message_versions` (`kind='regenerate'`), reset the message to `streaming`, start `attempt+1`, optionally with another model ("Regenerate with…").

### Pattern 5: `buildModelMessages` (pure, snapshot-tested)
- Input: persisted rows of the chat in seq order (non-deleted), each assistant row with its final or partial text, chat settings, personal preferences, attachment bytes and model caps.
- Output: `{ instructions: string, messages: ModelMessage[] }`.
- `instructions` = a fixed platform preamble (date, "you are chatting with <display name> inside <org>") + personal instructions (if `use_personal_instructions`) + chat instructions, delimited and labelled as user-authored preferences. **Phase 6 must drop personal instructions as soon as a second human joins** (PRD §113 rule).
- Stopped assistant answers with text are included as assistant turns. Failed/empty ones are skipped, and consecutive user turns are merged (Anthropic strict alternation; OpenAI tolerates it).
- History budget: trim oldest turns to `max_context_tokens` (estimate ~4 chars/token; flag `truncated` in generation metadata). Never silently drop the current message.
- Attachments become `{ type: "file", mediaType, data: Uint8Array }` parts on their user message: images use the `large.webp` rendition when it exists; PDFs are sent as files only to models with `pdf` capability; small text files (≤ 100 KB) are inlined as text blocks with filename labels; anything else gets an explanatory placeholder.

### Pattern 6: tool toggles and web search per backend
- Contracts: `AiChatTools = { web, companyKnowledge, mcp, skills }`, where the last three are always `{enabled:false, reason:"not_available_yet"}` and rendered disabled with that reason (AICHAT-06).
- **ChatGPT plan backend:** `openai.tools.webSearch()` (hosted; the call runs at OpenAI and counts against the user's plan, $0 to the org). Subject to "model and account/workspace policy" [CITED: preview-limitations]. A `subscription_sharing_unsupported_capability` with `param` = the web tool turns the toggle off for that model with the reason shown. Audit domains from `source` parts.
- **Org-key backend:** API-executed function tools `web_search` (SearXNG JSON API when `OCW_SEARXNG_URL` is set) and optionally `web_fetch` (through `mcp/url-policy.ts` SSRF rules, 20 000-char cap). This keeps ADR-0010's "Internet without paid or hosted search" rule [VERIFIED: docs/adr/0010-personal-bots-capability-model-and-tool-gate.md:83-86]. Without SearXNG, Web is disabled with the reason "Web search needs the search profile", **unless** the admin opts into provider-hosted search, which is **METERED** (Anthropic web search $10 per 1,000 searches [CITED: claude-api skill shared/managed-agents-core.md]; OpenAI hosted search per-call price [ASSUMED]). See owner decision 3.
- Limits per turn: ≤ 5 searches, ≤ 3 fetches, `stopWhen` step cap 6. Tool output is untrusted; there are no side-effecting tools in Phase 5.

### Pattern 7: titles (AICHAT-04)
After the first completed answer, if `title_source = 'heuristic'`, run one small-model call on **the same backend and the same credential owner** as the chat: plan → the account's smallest listed model (a configurable policy value; default a slug containing `luna` if listed [ASSUMED]); org key → the policy `title_models[provider]` or the cheapest allowed model. Reuse the ADR-0014 contract: 2-5 words, ≤ 32 chars, `normalizeSessionTitle` + `SessionTitle` validation, conditional update `where title_source = 'heuristic'`, a 20 s timeout and a fallback to the first line. Meter it as a usage record `kind='title'`. Existing constant: `TITLE_MODEL = { "claude-code": "haiku", codex: "gpt-6-luna" }` [VERIFIED: packages/contracts/src/session-title.ts:24-27]. It is runtime-specific and must not be reused as a server model id.

### Pattern 8: snapshot share (AICHAT-09)
`POST /ai-chats/:id/shares` (owner) stores an immutable JSON snapshot of the visible messages at that moment and returns `/share/ai/<shareId>`. `GET /api/v1/ai-shares/:id` requires an authenticated member **of the same org** (resolver permission, e.g. `ai_chat.share.read`, standard role). There is no anonymous route and no capability token in the URL. Attachments in the snapshot are served only through a share-scoped rendition route checking `attachment_ids`. Revoking makes the link 404. Audit `ai_chat.share_created/revoked`. A deleted chat cascades to its shares. A cross-org id returns 404 (hidden = missing, like `chat/access.ts`).

### Anti-Patterns to Avoid
- **Routing AI chats through the OpenClaw cell:** pooled seat, no deltas, operator-level endpoint.
- **Passing model id strings to `streamText`:** silently routes through Vercel AI Gateway (metered, external).
- **Writing deltas to `messages.body`:** tsvector churn and `message.updated` storms.
- **Storing the SIWC verifier/state in the browser, or tokens in `localStorage`:** violates OpenAI's credential rules and principle 8.
- **Sending `max_output_tokens`/`temperature`/`user` or a `system` role item on the plan backend:** 400 from the preview route.
- **Using the cell's org `openai-codex` model list for per-user plan chats:** different ids and a different credential owner.
- **A Claude-subscription chat path:** see 1b.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Provider streaming/normalization | Per-provider SSE parsers | `ai` `streamText` + provider packages | Usage, abort and file parts are normalized |
| Test models | Ad-hoc fakes per test | `MockLanguageModelV4`, `simulateReadableStream` from `ai/test` [VERIFIED: ai@7.0.122 dist/test/index.d.ts] + `infra/fake-model` for HTTP-level tests | Deterministic, never metered |
| Encryption of tokens/keys | New crypto | Existing `seal`/`open` (AES-256-GCM, AAD) behind `SecretsService` | Already audited |
| JWT/JWKS validation of the ChatGPT ID token | Manual base64 parsing | `jose` (`createRemoteJWKSet`, `jwtVerify`) [ASSUMED available] | Signature, issuer, audience, exp, nonce |
| Markdown streaming | Custom renderer | Phase 4 `<Markdown mode="streaming">` | XSS fixtures exist; images become links (blocks prompt-injection exfiltration through image URLs) |
| Title shaping | New rules | ADR-0014 `normalizeSessionTitle` | Same 32-char contract |
| Daily counters | Read-modify-write | `insert … on conflict … setWhere` (consumeTurn pattern) | Atomic under concurrency |
| SSRF in web_fetch | New URL checks | `apps/api/src/modules/mcp/url-policy.ts` | Already tested |
| Tokenizer for cost | tiktoken etc. | Provider-reported usage; char/4 estimate only when aborted | Exact counts come from the provider |

## Runtime State Inventory (secret migration part of the phase)

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `app.model_providers.secret_id` → `app.secrets` rows of kind `provider_api_key` (AES-GCM with `OCW_ENCRYPTION_KEY`, AAD = org id) [VERIFIED: app.ts:829-875; apps/api/src/modules/secrets/index.ts] | **Data migration:** add `secret_ref jsonb` to `model_providers`, backfill `{"provider":"db","secretId":<secret_id>}` for every row with a key. Keep `secret_id` until the code no longer reads it (drop in a later migration). Ciphertext does not move: `app.secrets` *is* the `db` SecretStore provider (the existing `SecretReference` union already has `{ provider: "db"; secretId: string; organizationId: string }` [VERIFIED: apps/api/src/lib/secret-store.ts:8-11]). |
| Live service config | The OpenClaw cell receives decrypted API keys via `GET /cell` (`cellProviders`, `apiKey: await core.secrets.reveal(tx, p.secretId)`) [VERIFIED: apps/api/src/modules/agent/service.ts:219-235] | **Code edit:** `cellProviders` resolves via `SecretStore.resolve(ref)`. The cell itself needs no change. Re-run the cell contract tests. |
| OS-registered state | None. Verified: no systemd/launchd/pm2 state references providers; compose has no provider env | none |
| Secrets/env vars | `OCW_ENCRYPTION_KEY` (unchanged); optional new operator refs (`env`/`file` providers, e.g. `OCW_PROVIDER_ANTHROPIC_API_KEY_FILE`) | Document in `.env.example` if added; no rename |
| Build artifacts | None (no package rename) | none |

Async resolution: today `SecretStore.resolveSync` throws for `db` refs ("db secrets must be resolved through the secrets module") [VERIFIED: secret-store.ts:21-31]. Add one async `resolveSecret(tx, ref)` in the secrets module that dispatches env/file/db (OpenBao later). This single entry point is what "keys held as SecretReference" means in practice.

## Common Pitfalls

### Pitfall 1: pooling one person's subscription
**What goes wrong:** a member's chat runs on another person's ChatGPT seat (org sign-in or a share in Phase 6). **How to avoid:** a generation always uses the **requester's** `user_model_credentials`. There is no admin path to read or use another user's credential. Phase 6 must decide who pays when a second human triggers a turn in a shared chat (recommend: the triggering human's own backend).

### Pitfall 2: SIWC refresh-token rotation races
**What goes wrong:** two API instances refresh at once; one rotated refresh token is reused, OpenAI returns `refresh_token_reused` and the user is logged out. **How to avoid:** refresh under `SELECT … FOR UPDATE` on the credential row plus a short Redis lock, refresh ~5 min before expiry, store all fields atomically. Clear tokens only on the listed terminal codes, never on 5xx or network errors.

### Pitfall 3: usage on stopped generations
**What goes wrong:** provider usage arrives at the end (`response.completed`; Anthropic `message_delta` `usage.output_tokens`), so an aborted stream may have no usage. **How to avoid:** use `onAbort` steps when present. Otherwise record `estimated=true` with output ≈ `ceil(chars/4)` and input from the last known value or an estimate from the request text. The UI shows "~". Anthropic's `message_start` carries the message object at stream start [CITED: claude-api skill typescript/claude-api/streaming.md]; reading it needs `includeRawChunks: true` [VERIFIED: param exists in ai@7.0.122 typings]. Treat this as an optimization.

### Pitfall 4: plan-backend request shape
**What goes wrong:** the AI SDK sends a system message as a `system` role item, or the code sets `maxOutputTokens`/`temperature`, and the route returns 400. **How to avoid:** for `chatgpt_plan`, set `providerOptions.openai = { store: false, systemMessageMode: "developer" }` (or `instructions`) and never set the unsupported fields. Add a fixture test that captures the request body at the fake `/v1/responses` and asserts the forbidden keys are absent.

### Pitfall 5: mid-stream usage-limit error
`subscription_sharing_usage_limit_exceeded` can arrive after text has streamed. Keep the partial text, mark the generation `failed` with `error_code`, show the OpenAI-mandated "Usage limit reached → Manage usage" card, and do not retry or fall back silently to an org key ("OpenAI does not silently switch… billing path", and neither should we). Offer an explicit "Use org model" choice when allowed.

### Pitfall 6: search index churn and leakage
Writing the body once at the end avoids churn (Pattern 3). Extend `ReadableKind` (`"channel" | "dm" | "group"` [VERIFIED: apps/api/src/modules/chat/access.ts:21]) with `ai_chat`, decided by a resolver precondition: owner only, admins included get 404, like personal-bot DMs. Add search tests proving another user and an admin never see AI chat hits or titles.

### Pitfall 7: metered E2E by accident
New provider code must honor `OCW_MODEL_PROVIDER=mock`, and CI must never hold real keys or SIWC tokens. The fake model needs `/v1/responses` (SSE events `response.output_text.delta`, `response.completed` with usage, `response.failed`), a slow mode for stop tests, a usage-limit mode, and fake authorize/token/JWKS endpoints behind `OCW_CHATGPT_AUTH_BASE_URL` / `OCW_CHATGPT_API_BASE_URL` (test-only env, refused in production builds).

### Pitfall 8: cost abuse through huge context
Re-sending a long history with attachments every turn multiplies input tokens. Cap context (policy `max_context_tokens`), cap attachments per message (10, existing `MAX_ATTACHMENTS_PER_MESSAGE` [VERIFIED: packages/contracts/src/attachments.ts:13]), use renditions for images, enforce per-user daily generation/cost caps on org keys and a per-user concurrent-generation cap (e.g. 3 across chats).

### Pitfall 9: provider-side retention
OpenAI Responses defaults to `store: true` ("Defaults to `true`" [CITED: ai-sdk.dev/providers/ai-sdk-providers/openai]). Set `store:false` on every OpenAI call (mandatory on the plan route, and good privacy practice on org keys).

## Code Examples

### Per-user ChatGPT plan model (gateway)
```typescript
// Source: developers.openai.com/siwc/token-sharing-open-source/models-and-inference (bearer token, store:false,
// stream:true, public /v1/responses); @ai-sdk/openai@4.0.80 createOpenAI({ apiKey, baseURL, fetch }).
import { createOpenAI } from "@ai-sdk/openai";

const accessToken = await credentials.freshAccessToken(tx, requesterUserId); // serialized refresh
const openai = createOpenAI({ apiKey: accessToken, baseURL: env.OCW_CHATGPT_API_BASE_URL ?? "https://api.openai.com/v1" });
const model = openai.responses(ref.modelId);                                  // slug from the user's /v1/models
const providerOptions = { openai: { store: false, systemMessageMode: "developer" as const } };
```

### Org key from a SecretReference
```typescript
// Source: STACK.md Decision 4; existing PROVIDER_API mapping (apps/api/src/modules/agent/providers.ts).
const key = await core.secrets.resolve(tx, row.secretRef);   // env | file | db
const model =
  row.provider === "anthropic" ? createAnthropic({ apiKey: key, baseURL })(ref.modelId)
  : row.provider === "openai"  ? createOpenAI({ apiKey: key, baseURL }).responses(ref.modelId)
  : createOpenAICompatible({ name: row.provider, apiKey: key, baseURL })(ref.modelId); // openrouter, compat, mock
```

### Atomic daily cap (reuse)
```typescript
// Source: apps/api/src/modules/bot-capabilities/usage.ts:38-59 (consumeTurn)
.insert(aiUsageDaily).values({ organizationId, userId, day, generations: 1 })
.onConflictDoUpdate({ target: [...], set: { generations: sql`${aiUsageDaily.generations} + 1` },
  setWhere: sql`${aiUsageDaily.generations} < ${limit}` })
.returning({ generations: aiUsageDaily.generations });
```

## Usage metering and cost (question 4)

- One `ai_usage_records` row per generation (chat or title), written in the finalize transaction with the generation's status. It holds model, provider, backend, requester, tokens (in/out/cached/reasoning), `estimated`, and `cost_micros_usd`: **null for `chatgpt_plan`** (no marginal $; the UI says "ChatGPT plan" with a "Manage usage" link) and computed from the price table for `org_key`.
- Price table in contracts, versioned (`price_ref` stored per row). Seed values for Anthropic [CITED: claude-api skill, cached 2026-09-25]: `claude-opus-5-5` $4 / $20 per MTok (cache read $0.20), `claude-sonnet-5-5` $2 / $10 (cache read $0.20), `claude-haiku-4-5` $1 / $5. OpenAI/OpenRouter prices must be filled from official pricing pages in the plan task, never invented [ASSUMED: none recorded here]. Unknown models get cost `null` and "—" in the UI. An admin override per model is optional.
- Per-message display: under each assistant message, `1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5` (or `· ChatGPT plan`). Totals live in Settings › Models › Usage (admin, 30 days by user/model) and in the user's own view. Usage data is metadata: no prompt text.
- Limits: reuse the 3.1 daily pattern (UTC day, atomic upsert, a clear notice, **no model call** at the limit, audited `ai_chat.limit_reached`). Org-key caps: generations and/or $ per user per day (policy). Plan backend: count only (OpenAI enforces plan limits), with an optional admin cap.

## Chat list UX (question 5)

- `/chat/ai` already exists and lists bot DMs: "Phase 5 adds AI chats to the same view" [VERIFIED: apps/web/components/chat/views/ai-chats-view.tsx:16-19]. Add a "New chat" primary action, AI chats grouped by recency (Today / Previous 7 days / Older), each row with title, model chip and time, and row actions Rename, Archive, Share, Delete (delete optional; archive is required).
- Sidebar: an "AI chats" section with the five most recent + "New chat" (⌘⇧O-style shortcut optional).
- Search: titles through `conversations.name` (the trigram index exists per ADR-0016) and message bodies through the existing FTS, with the readable set extended to the owner's `ai_chat` ids. The ⌘K palette gets an "AI chats" group.
- Instructions: Settings › Profile › "AI chat instructions" (personal default + default model + Web default), and per-chat instructions in a chat settings sheet with "Also use my personal instructions" (default on).

## Attachments (question 6)

Reuse the Phase 4 presign → sniff → `ready` pipeline with `conversationId` = the AI chat (the `attachment.upload` permission already exists [VERIFIED: packages/contracts/src/permissions.ts:59]). The composer disables image/PDF attach for models without the capability (tooltip "Claude Haiku 4.5 can't read PDFs" etc.). At generation time the API streams the bytes from Garage (`ObjectStorage.stream`) and passes them as `file` parts. The provider never receives a storage URL (internal hostnames, ADR-0015). Model caps: Anthropic Claude current models accept images and PDFs [CITED: claude-api skill]; for plan models use `/v1/models` metadata when present, else a conservative allowlist [ASSUMED].

## UI (question 7)

- **Layout:** the Work Zone/T3 Code language from 03.2. A centered column (max ~760 px) with user turns as right-aligned bubbles and assistant turns as full-width Markdown with a footer (model · tokens · cost · copy · regenerate). The composer is sticky at the bottom with model picker chip, attach, Web toggle chip, Send/Stop, and the "Using ChatGPT plan · Manage usage" line when the plan backend is selected (an OpenAI UI requirement). The empty state shows suggested starters and the model picker.
- **Model picker:** reuse the `work-zone/model-picker.tsx` surface pattern [VERIFIED: file exists] with two groups, "Your ChatGPT plan" (connected / "Continue with ChatGPT") and "Organization models" (labelled "Paid by your organization"), disabled rows with reasons.
- **Streaming:** `<Markdown mode="streaming">`, a caret while streaming, Stop replaces Send, stick-to-bottom (`use-stick-to-bottom.ts` exists). A stopped answer shows "Stopped" and keeps its text.
- **390 px:** the chat list is a drawer, the composer collapses chips into a "+" menu, and the model picker opens as a bottom sheet (existing `useSheetSurface`).
- **Verification:** screenshots at 1440 and 390, light and dark (Phase 4 D-08); run `/gsd-ui-phase` to produce a UI-SPEC before planning (config `ui_phase: true`).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Third-party apps reuse the Codex CLI OAuth to spend ChatGPT plans | Official "Sign in with ChatGPT – ChatGPT plan usage" for OSS/self-hosted apps on the public Responses API | 2026-09-30 DevDay (login beta July 2026) | Sanctioned per-user BYO path; `backend-api` explicitly not to be used |
| Claude Pro/Max OAuth in third-party tools | Prohibited outside Claude Code / Claude.ai; enforced server-side | Docs 2026-02-19 | No Claude-subscription chats |
| AI SDK `system`, `fullStream`, `onFinish` | `instructions`, `stream`, `onEnd` | AI SDK 7.0 | Use v7 names |
| `@ai-sdk/*` telemetry built in | `@ai-sdk/otel` + `registerTelemetry` | AI SDK 7.0 | Wire to OTel later (Phase 7) |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Pasting the failed loopback redirect URL into OCAW is an acceptable SIWC callback relay for a self-hosted server | 1a-alt | OpenAI could refuse it; fallback: desktop-app loopback listener only |
| A2 | ChatGPT Business/Enterprise seats are eligible for plan usage | 1a-alt | Company users on Business could be `not_eligible`; then the default must be org keys |
| A3 | `/v1/models` slugs differ from OpenClaw's catalog ids | Pattern 1 | Low: only affects reuse |
| A4 | String model ids in `streamText` route via Vercel AI Gateway | Anti-patterns | Low: we never pass strings anyway |
| A5 | `jose` is available or acceptable to add | Don't hand-roll | Low |
| A6 | OpenAI hosted web search per-call price; OpenAI/OpenRouter token prices | Usage | Cost estimates wrong if invented: planner must source them |
| A7 | `text-delta` part field name in AI SDK 7 | Pattern 2 | Compile error caught in plan 01 |
| A8 | A Claude chat via the on-device Agent SDK counts as "routing through plan credentials" | 1b | If Anthropic considers it permitted, a later phase could add it; recommendation stays conservative |
| A9 | ChatGPT seat terms forbid one seat serving a whole org through the cell | 1a | If allowed, option B becomes viable but still lacks streaming |
| A10 | Title default small plan model slug contains `luna` | Pattern 7 | Fallback to heuristic title |

## Owner decisions (genuine, numbered, one recommended default each) (RESOLVED 2026-10-06: owner chose 1.1, 2.1, 3.1 — see 05-CONTEXT.md)

1. **ChatGPT for AI chats: whose subscription and through what?**
   1. **Per-user "Sign in with ChatGPT" in the API (recommended).** BYO, never pooled, official route, one run loop, $0 to the org. Cost: per-user sign-in UX (paste redirect), new ADR-0017, and the managed cloud later needs OpenAI's interest form.
   2. The cell's org sign-in (as the decision literally says). One seat pays for everyone, uses the `backend-api` route, needs a new streaming relay through the plugin and an operator-level endpoint. Not recommended.
   3. Both: per-user by default, the org cell sign-in as an admin opt-in "shared ChatGPT" fallback, clearly labelled as pooled. Adds complexity for a path that contradicts BYO.
2. **Claude in AI chats.**
   1. **Org Anthropic/OpenRouter key only, labelled METERED (recommended).** It matches Anthropic's published policy.
   2. On-device Claude Code subscription chats. Conflicts with "route requests through … plan credentials … including the Agent SDK", needs the desktop online, latency of seconds.
3. **Web search when the chat runs on an org API key.**
   1. **SearXNG-backed tool (free, self-hosted, `search` compose profile); Web disabled with a reason when SearXNG is off (recommended).** Consistent with ADR-0010.
   2. Provider-hosted search behind an admin opt-in, **METERED** (Anthropic $10 per 1,000 searches).
   (On the ChatGPT-plan backend, hosted web search is plan-included and needs no decision.)

Everything else (data model, protocol, plan split) is Claude's discretion.

## Open Questions

1. **Paste-redirect acceptability (A1).** Recommendation: build paste-redirect (works on web, desktop and mobile) plus an optional desktop loopback listener. Before release, add a manual owner check: one real sign-in on the demo with the owner's own Plus/Pro account (not in CI).
2. **Business/Enterprise eligibility (A2).** Recommendation: surface `not_eligible` cleanly and fall back to org models. The owner tests with a Business seat when available.
3. **Assistant `author_kind`.** Recommendation: `agent` + null `author_id` + generation projection. Decide in plan 01 with a grep of every `authorKind` switch.
4. **CI availability.** 04-VERIFICATION reports GitHub Actions blocked by an account billing issue [VERIFIED: .planning/phases/04-chat/04-VERIFICATION.md:24]. Phase 5 gates must be runnable locally (isolated e2e harness), as in Phase 4.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | API/web | ✓ | 24.21.0 (= `.nvmrc`) | — |
| pnpm | install | ✓ | 12.8.1 | — |
| Docker (testcontainers only; no compose lifecycle on the demo) | integration tests | ✓ | 29.6.2 | — |
| npm registry access | install | ✓ | — | — |
| OpenAI SIWC (real) | manual owner check only | not probed (no real turns allowed) | — | fake auth/responses server |
| SearXNG | org-key Web tool | optional profile (`infra/searxng/settings.yml` exists) | — | Web disabled with reason |
| GitHub Actions | CI | ✗ (billing block per 04-VERIFICATION) | — | local isolated runs |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5 (projects `unit`, `integration`), Playwright (e2e, 1440 + 390 projects) |
| Config file | root `vitest` config (projects), `e2e/playwright.config.ts` |
| Quick run command | `pnpm vitest run --project unit apps/api/src/modules/ai-chat apps/api/src/modules/model-gateway packages/contracts` |
| Full suite command | `pnpm verify` then `pnpm e2e` (isolated harness, mock models) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AICHAT-01 | Provider keys resolve through SecretReference; backfill migration; keys never in responses/logs/stream/audit; members cannot manage; no personal key route | integration | `pnpm vitest run --project integration apps/api/src/modules/agent/providers-secret-ref.int.test.ts` | ❌ Wave 0 |
| AICHAT-01 | Allowed list governs chats and bots (a removed model is refused for both) | integration | `…/ai-chat/models.int.test.ts` | ❌ |
| AICHAT-02 | Create private chat; owner-only (others + admin 404, cross-tenant 404); per-message model switch recorded on the generation | integration + e2e | `…/ai-chat/chat.int.test.ts`; `pnpm e2e -g "ai chat"` | ❌ |
| AICHAT-03 | Deltas in order with offsets; reload mid-stream resumes; stop keeps partial (two API instances, abort via Redis); 409 on a second generation; sweeper finalizes interrupted; regenerate versions the old body | unit (offset reducer) + integration + e2e (slow mock) | `…/ai-chat/run-loop.int.test.ts`, `…/stop.int.test.ts` | ❌ |
| AICHAT-03 | `buildModelMessages` snapshots (alternation merge, stopped answers, attachments, instructions order, trimming) | unit | `…/ai-chat/build-model-messages.test.ts` | ❌ |
| AICHAT-04 | Auto title validated, never overwrites a user title; rename/archive; search finds own chats only | integration + e2e | `…/ai-chat/titles.int.test.ts`, `search.int.test.ts` additions | partial (search suite exists) |
| AICHAT-05 | Personal + chat instructions reach `instructions` in order; toggle off excludes personal | unit + integration | `build-model-messages.test.ts` | ❌ |
| AICHAT-06 | Web toggle: plan backend sends hosted tool; org backend uses SearXNG tool (fake); disabled with reason without SearXNG; other toggles disabled | unit + e2e | `…/ai-chat/web-tools.test.ts` | ❌ |
| AICHAT-07 | One usage record per generation (completed, stopped=estimated, failed); cost null for plan; price math; daily cap blocks with no model call; append-only enforced (UPDATE/DELETE fail as app role) | integration | `…/ai-chat/usage.int.test.ts` | ❌ |
| AICHAT-08 | Image to vision mock arrives as file bytes (fake model capture); refused for non-vision model; foreign attachment id refused | integration + e2e | `…/ai-chat/attachments.int.test.ts` | ❌ |
| AICHAT-09 | Share snapshot readable by same-org member, 404 for anonymous / other org / after revoke; later edits not visible | integration + e2e | `…/ai-chat/shares.int.test.ts` | ❌ |
| SIWC | PKCE/state/nonce, ID token validation (fake JWKS), scope check, serialized refresh (two parallel refreshes → one call), revoke, error mapping (`usage_limit_exceeded` mid-stream keeps partial), forbidden request fields absent | unit + integration | `…/model-gateway/chatgpt-plan/*.test.ts` | ❌ |
| Tenant | Every new table in the RLS enumerator | integration | `pnpm vitest run --project integration packages/db/src/rls-isolation.int.test.ts` | ✅ (needs seeding rows) |

### Sampling Rate
- **Per task commit:** quick unit command for touched modules.
- **Per wave merge:** `pnpm verify`.
- **Phase gate:** `pnpm verify` + full e2e (mock models, both viewports), then `/gsd-verify-work`. One manual owner check on the demo (real ChatGPT plan sign-in + one turn + stop), never in CI.

### Wave 0 Gaps
- [ ] `infra/fake-model/server.mjs`: `POST /v1/responses` SSE (`response.output_text.delta`, `response.completed` + usage, `response.failed` with `subscription_sharing_usage_limit_exceeded`), request-body capture, slow mode (`[[slow]]`), fake `GET /v1/models` slugs, fake authorize/token/revoke/JWKS
- [ ] Test helpers: seeded user credential, two-instance app factory sharing Redis (for abort), mock-model directive for image echo ("saw 1 image")
- [ ] contracts: `ai-chat.ts`, `model-prices.ts` with tests
- [ ] RLS seed rows for every new table

## Security Domain

### Applicable ASVS Categories (level 1)
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (OAuth client for SIWC) | PKCE S256, `state`, `nonce`, ID-token JWKS validation, exact redirect URI, scope check |
| V3 Session Management | yes (provider tokens) | Server-side only, rotate on refresh, revoke on disconnect, clear on terminal errors |
| V4 Access Control | yes | Resolver precondition `ai_chat` owner-only (hidden = 404); credentials usable only by their owner; shares same-org authenticated only |
| V5 Input Validation | yes | Zod on bodies (body ≤ 20 000 as `MessageBody`, instructions ≤ 8 000, ModelRef against the allowed set server-side, attachment ids owned by the chat) |
| V6 Cryptography | yes | Existing AES-256-GCM `seal/open` with AAD; never hand-roll |
| V7 Logging | yes | Never log prompts, outputs, tokens, codes or redirect URLs (they contain `code`); tests scan logs/streams/audit for token-shaped strings (3.1 device-code pattern) |
| V8 Data Protection | yes | `store:false` at OpenAI; usage records hold no content; snapshot shares hold content and are revocable |
| V12 Files | yes | Phase 4 sniffing/renditions; bytes read server-side only |
| V13 API | yes | Per-user rate limit on sends, concurrency caps, 409 generation gate |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via web results/attachments | Tampering | No side-effecting tools in Phase 5; tool caps; images rendered as links (blocks image-URL exfiltration); `safeUrl` |
| Using another user's subscription | Elevation | Credential bound to requester; no admin read path; audit `ai_chat.generation` with backend + requester |
| Cost abuse on org keys | DoS / financial | Daily caps (count/$), context cap, concurrency cap, no retries on 4xx, metered paths labelled |
| Token leakage | Information disclosure | Tokens only in `app.secrets`, never in responses, WS, audit or logs; redirect URL pasted into a POST body (never a query string we log) |
| OAuth CSRF / code injection | Spoofing | `state` bound to user + flow in Redis (TTL 10 min), single use; reject client_id mismatch |
| Cross-tenant leak via search/share | Information disclosure | Readable-set rule; share lookups scoped by org; RLS FORCE on new tables |
| SSRF via `web_fetch` | Tampering | `mcp/url-policy.ts`, no redirects to private ranges, char cap |

## Suggested plan breakdown (tracer-first, granularity fine)

| Wave | Plan | Content |
|---|---|---|
| 0 | 05-01 Foundations | contracts (`ai-chat`, ModelRef, prices), migration (tables above + secrets kind + message_versions kind + `ai_chat` in readable set), permissions (`ai_chat.create`, `ai_chat.share`, `ai_chat.share.read`, `ai_chat.web`), fake model `/v1/responses` + slow + fake SIWC auth, install pinned AI SDK, ADR-0017 draft |
| 1 | 05-02 **Tracer: one plan-backed turn end to end** | model-gateway (chatgpt_plan only, with a test-seeded credential against the fake server), run loop, WS `ai.delta` with offsets, durable final message + usage record, minimal `/chat/ai/[chatId]` screen; e2e "send → stream → persisted after reload" |
| 1 | 05-03 Org keys + SecretReference | async secret resolution, backfill migration, `cellProviders` on refs, Settings › Models copy "governs AI chats and bots", org-key providers through the same gateway, mock provider |
| 2 | 05-04 Stop / regenerate / gate | Redis abort, partial kept, 409 gate, heartbeat sweeper, SIGTERM, regenerate with versions, per-message model switch |
| 2 | 05-05 ChatGPT plan sign-in | PKCE start, paste-redirect exchange, JWKS validation, scope check, serialized refresh, revoke, catalog, error mapping, OpenAI UI requirements (welcome modal, "Using ChatGPT plan · Manage usage", limit card), audit |
| 2 | 05-06 Usage & limits | price table, records for every outcome, per-message display, daily caps, admin/user usage views |
| 3 | 05-07 List, titles, search | list page + sidebar section, rename/archive, auto titles per backend, palette/search integration with owner-only tests |
| 3 | 05-08 Instructions + toggles + web | personal/chat instructions, toggle UI with disabled reasons, hosted search (plan) / SearXNG tool (org) |
| 3 | 05-09 Attachments | vision/PDF/text parts, capability gating in composer |
| 3 | 05-10 Snapshot shares | create/revoke/view, share-scoped attachments, audit |
| 4 | 05-11 UI polish + screenshots | ChatGPT/Claude.ai-quality screen per UI-SPEC, 1440/390 light/dark |
| 4 | 05-12 Gate | security sweep (log/stream scans), e2e suite, AGENTS.md stack row + DEMO.md + traceability, ADR-0017 accepted, manual owner check |

## Sources

### Primary (HIGH / official)
- Repo files read this session: `packages/db/src/schema/app.ts`, `packages/contracts/src/{agent,chat,realtime,permissions,agent-channel,session-title,attachments}.ts`, `apps/api/src/lib/secret-store.ts`, `apps/api/src/modules/{secrets,agent,bot-capabilities,chat,realtime,work-session,artifact}/*`, `apps/openclaw-channel/src/{openclaw-port,openclaw-sdk.d}.ts`, `infra/openclaw/render-config.mjs`, `infra/fake-model/server.mjs`, `docs/adr/0006, 0010, 0013, 0014, 0016`, `docs/prd/PRD.md` §15-17, §54-58, §113, `.planning/research/STACK.md`, Phase 3.1/4 verification
- npm registry (`npm view`): ai 7.0.122/7.0.128, @ai-sdk/openai 4.0.80, @ai-sdk/anthropic 4.0.68, @ai-sdk/openai-compatible 3.0.59, dependency alignment; `ai@7.0.122/dist/index.d.ts`, `dist/test/index.d.ts`, `@ai-sdk/openai@4.0.80/dist/index.d.ts` via jsDelivr
- [Sign in with ChatGPT – ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source), [Sign in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines), [Request a client ID](https://developers.openai.com/siwc/request-client-id)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [AI SDK 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0), [streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [OpenClaw OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api)
- claude-api skill (Anthropic model ids and prices cached 2026-09-25; web search $10/1k)

### Secondary (MEDIUM)
- [trendingtopics.eu: Sign in with ChatGPT at DevDay 2026-09-30](https://www.trendingtopics.eu/sign-in-with-chatgpt-tokens-other-apps/)
- [gigazine: Anthropic bans third-party subscription auth](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block), [alternativeto.net](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)

### Tertiary (LOW)
- Community guides on OpenClaw ChatGPT OAuth (openclawvps.io, openclawlaunch.com); not relied on

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH (versions and typings read from the registry/CDN this session)
- Architecture: HIGH for repo integration points (read), MEDIUM for SIWC integration details (preview docs, one week old)
- Pitfalls: MEDIUM-HIGH
- Subscription terms: MEDIUM (official text quoted; interpretation for on-device Claude and the paste-redirect relay are assumptions)

**Research date:** 2026-10-06
**Valid until:** 2026-10-20 (SIWC is a preview launched 2026-09-30 and AI SDK 7 ships daily; re-check both before execution)
