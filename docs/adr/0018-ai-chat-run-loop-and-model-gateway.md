# ADR-0018: AI chats run on one AI SDK 7 loop behind a model gateway, metered per generation

## Status

Accepted (owner decisions D-01 … D-08 in `.planning/phases/05-direct-ai-chat/05-CONTEXT.md`; Phase 5 gate 05-15).
**Date:** 2026-10-07. Builds on [ADR-0003](0003-infrastructure-baseline.md) (PostgreSQL, Redis, the `SecretStore`),
[ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (no paid or hosted search), [ADR-0014](0014-automatic-session-titles-on-the-device.md)
(title rules), [ADR-0015](0015-object-storage-garage.md) (files) and [ADR-0016](0016-chat-search-and-renderer.md)
(search, one renderer). Companion of [ADR-0017](0017-sign-in-with-chatgpt-per-member.md) (the ChatGPT-plan
credential); supersedes nothing.

## Context

Phase 5 (AICHAT-01 … 09) gives every member a private, streaming AI chat with per-message model choice, stop and
regenerate, titles, instructions, web search, files, a usage record for every answer and read-only share links. The
AGENTS.md stack row already named the AI layer: Vercel AI SDK 7 on the server, prompts assembled from persisted
messages by one `buildModelMessages`. What had to be decided:

- **How models are reached.** Two backends (D-01): the member's own ChatGPT plan by default (ADR-0017) and optional
  organization API keys. Claude is allowed only through an organization Anthropic or OpenRouter key (D-03): Anthropic's
  published terms forbid third-party apps from routing requests through Free, Pro or Max credentials, Agent SDK
  included. Members never type personal keys.
- **The AI SDK default is a hosted gateway.** `ai@7` depends on `@ai-sdk/gateway`; a `"provider/model"` string passed
  as a model routes through the Vercel AI Gateway, a metered external service. Principle 10 (self-hosted first) and
  the cost rules rule that out.
- **Phase 1 stored provider keys by `secret_id`** (sealed rows in `app.secrets`), while principle 8 asks code to
  reference secrets by `SecretReference` (D-07).
- **Streaming has to survive** reloads, offline gaps, several API instances, crashes and deploys, without rewriting
  the searchable message body on every token (`messages.search_tsv` is a STORED generated column, ADR-0016).
- **Every generation costs something** (the member's plan or the organization's bill), so it must be recorded,
  priced, capped and attributable without storing prompt text outside the conversation (D-06).

## Decision

1. **AI SDK 7 with exact pins and provider instances only.** `apps/api` pins `ai@7.0.122`, `@ai-sdk/openai@4.0.80`,
   `@ai-sdk/anthropic@4.0.68` and `@ai-sdk/openai-compatible@3.0.59` (package gate approved 2026-10-06, no install
   scripts). Every model is a provider instance built by the gateway (`createOpenAI(...).responses(slug)`,
   `createAnthropic(...)`, `createOpenAICompatible(...)`); a string model id is never passed and the Vercel AI
   Gateway is never used. `streamText` always receives an explicit `onError`, because the SDK default
   `console.error`s an error object that carries the request body (the prompt).
2. **`ModelRef` with three backends.** Every turn names `{backend: "chatgpt_plan" | "org_key" | "mock", provider,
   modelId}`. `chatgpt_plan` uses only the requester's own sealed credential (ADR-0017) and the plan catalog;
   `org_key` requires an enabled provider row, a model in its `allowed_models` (the same list bots are checked
   against) and a resolvable key; `mock` exists only with `OCW_MODEL_PROVIDER=mock`. `openai-codex` (the cell's
   organization sign-in, ADR-0006) is never an AI chat model.
3. **`modules/model-gateway` is the only importer of `@ai-sdk/*`.** It resolves a `ModelRef` for a requester into a
   model, capabilities (vision, PDF, web search kind), labels, `metered` and provider options, or a typed refusal
   (`not_allowed`, `not_connected`, `needs_reconnect`, `no_key`, …), and classifies provider failures into
   `AiErrorCode` without copying bodies. Plan requests carry `store:false` and the developer-message mode; org OpenAI
   requests `store:false`. Retries: 0 on the plan and the mock, 2 on org keys (before the stream opens).
4. **Claude through organization keys only, labelled METERED** (D-03). Every organization model shows METERED in
   the picker, the composer chip, the answer footer, the provider card and the policy settings. There is no Claude
   subscription path in AI chats.
5. **Provider keys are `SecretReference`s resolved by `secrets.resolve`** (D-07). `model_providers.secret_ref`
   (`env`, `file` or `{provider: "db", secretId, organizationId}`) is the only thing read for resolution, for AI chats
   and for the OpenClaw cell; a `db` reference naming another organization is refused. The data migration
   `*_provider_secret_refs` backfills `secret_ref` from `secret_id` for keyed rows without touching ciphertext;
   it is idempotent and never overwrites an operator's `env`/`file` reference. Upserts keep `secret_id` mirrored.
6. **One run loop, one prompt builder.** `ai-chat/run-loop.ts` runs `streamText` for every backend;
   `buildModelMessages` (pure, snapshot-tested) is the only place a prompt is assembled, from persisted messages, the
   chat's and the member's instructions (personal ones only while the chat has one human) and the attachment parts.
7. **Streaming protocol.** The user message and an empty assistant placeholder are durable `message.created` events.
   Text travels as ephemeral `ai.delta {messageId, generationId, offset, text}` frames on `conv:<id>`, coalesced every
   50 ms, where `offset` is the UTF-16 length already sent; a client applies a delta only at its own length and
   re-reads the snapshot on a gap. Partial text flushes to `ai_generations.partial_text` every second, never to
   `messages.body`; one finalize transaction writes the body, the generation outcome, one usage record and a durable
   `message.updated`. Snapshots read the stream cursor first.
8. **One generation per conversation, stoppable anywhere.** A partial unique index allows one `running` generation
   per conversation (409 `generation_in_progress`); a per-member advisory-locked cap limits concurrent generations
   (429). Stop authorizes and audits in the route, then publishes ids on Redis `ocw:ai:abort`; the instance that
   holds the stream flushes the unsent tail, freezes the text and finalizes `stopped`. A sweeper (SECURITY DEFINER
   ids-only lookup, per-organization re-check) finalizes generations whose heartbeat is older than 60 s as
   `interrupted`; a closing instance finalizes its own at once. Regenerate keeps the replaced text in
   `message_versions` (kind `regenerate`) and may switch model.
9. **Usage records are append-only, priced from a sourced table, and capped daily** (D-06). Every outcome
   (completed, stopped, interrupted, failed, title) writes exactly one `ai_usage_records` row with ids, model,
   backend, token counts (provider-reported, else estimated) and a cost from `MODEL_PRICES` (each row names its
   source URL and date; the member's plan costs `null`, the mock `0`). The app role cannot update or delete them.
   `ai_usage_daily` counters move in the same transaction. Daily caps per member (organization models, optional plan
   and dollar caps) are one conditional upsert before any model call, reusing the Phase 3.1 pattern; reports group by
   member or model. No usage or audit row carries prompt or answer text.
10. **Web search by backend** (D-04). On the member's plan, the plan's hosted web search (counts against the plan).
    On organization keys and the mock, an API-executed `web_search` function tool over the operator's SearXNG
    (`OCW_AI_SEARXNG_URL`, `search` compose profile): top 5 results, capped fields, labelled untrusted, no fetch tool,
    at most 5 searches per answer. Without SearXNG the Web toggle is disabled with the reason; no provider-hosted
    (metered) search is ever attached on an organization key. Company Knowledge, MCP and Skills are visible and
    disabled ("Not available yet").
11. **Attachments are server-read bytes.** Files use the Phase 4 pipeline (presign → Garage → sniff → renditions).
    Inside the turn the API reads the bytes itself (`large.webp` for images, the original PDF, text files up to 100 KB
    inlined in labelled untrusted delimiters) and sends them as parts of the member's own message; no storage URL or
    API path reaches a provider. A model that cannot read a file refuses it before anything is written.
12. **Snapshot shares, never public.** A share copies the visible turns once into `ai_chat_shares.snapshot`; reading
    it needs a session in the same organization and `ai_chat.share.read`; missing, revoked, foreign and denied all
    answer the same 404. Files load only through the share's own routes. The chat itself stays owner-only.
13. **Every AI route checks the session on request** (`onRequest`), before any body is parsed or validated, so an
    anonymous caller always gets 401 (05-15 sweep).

## Consequences

- **Static guards keep the shape.** `ai-chat/guard.test.ts` fails when `streamText`/`generateText` is imported
  outside the run loop and titler, when a model caller bypasses `buildModelMessages`, when `@ai-sdk/*` is imported
  outside `modules/model-gateway/`, when the Vercel AI Gateway is referenced, or when a provider/model string is passed
  as a model. `ai-chat/security.int.test.ts` sweeps responses, WS frames, audit, logs and every text column for keys,
  tokens, codes and verifiers, and every AI route for anonymous access.
- **A new provider** is one branch in `model-gateway/registry.ts`, its prices in `MODEL_PRICES` with a source, and
  its capabilities in `orgModelCaps`. Nothing outside the gateway changes.
- **Costs are estimates.** Prices are the providers' standard tier on the recorded date; a stopped or failed answer
  without provider usage is estimated (it errs high for failures). Reports say so.
- **History is re-sent every turn**, attachments included, so long chats with files cost more; the builder trims the
  oldest turns to a token budget and never drops the current message.
- **Deferred:** multiplayer AI chats and the second-human rule's UI (Phase 6); provider pools and per-provider
  fallbacks; a sweeper for abandoned AI chat drafts (their uploads are purged after 24 h); a dedupe window for
  `ai_chat.share_viewed` audits; the OpenRouter slug for Sonnet 5.5 (`anthropic/claude-sonnet-5.5` upstream). The
  policy review of the Work Zone's Claude path and the bots' single ChatGPT seat is
  `.planning/todos/pending/2026-10-06-subscription-policy-review.md`.
- **SecretReference backfill rollback.** To roll back decision 5, run `UPDATE app.model_providers SET secret_ref =
  NULL;` together with the pre-Phase-5 API code: `secret_id` and the sealed secrets are untouched, so that code keeps
  resolving keys through the `secret_id` join (tested in `packages/db/src/secret-ref-migration.int.test.ts`).
  `secret_id` is dropped only by the follow-up `.planning/todos/pending/2026-10-06-drop-model-providers-secret-id.md`,
  after Phase 5 has run without a rollback; that change also retires this paragraph.
