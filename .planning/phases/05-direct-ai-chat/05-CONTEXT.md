# Phase 5: Direct AI Chat - Context

**Gathered:** 2026-10-06 (owner decisions in conversation)
**Status:** Ready for planning

<domain>
## Phase Boundary

A user holds a private, streaming AI conversation: per-message model choice, stop (partial output kept), regenerate,
auto titles, rename/archive/search, custom instructions (per chat + personal defaults), usage metering per
generation with tokens per message, vision attachments through the Phase 4 upload pipeline, org-scoped read-only
snapshot share links (never public), and Web / Company Knowledge / MCP / Skills toggles with only Web functional.
One run loop (AI SDK 7, server-side) serves two backends. Multiplayer AI chat is Phase 6.

</domain>

<decisions>
## Implementation Decisions

- **D-01 (owner: backends):** AI chats run on BOTH backends — the member's **own ChatGPT plan by default**
  (BYO, never pooled) and **optional organization API keys** (`SecretReference`) when an admin configures providers.
  No personal API keys typed by users.
- **D-02 (owner 1.1: ChatGPT):** per-user **"Sign in with ChatGPT – ChatGPT plan usage"** in the API (OpenAI's
  official route for open-source/self-hosted apps, launched 2026-09-30): each member connects their own plan; the API
  calls `POST /v1/responses` with that member's token (`store:false`, `stream:true`) through the same AI SDK OpenAI
  provider used for org keys. The cell's org-wide ChatGPT sign-in is NOT used for AI chats. Sign-in UX: paste the
  redirect URL in a dialog (works on web, desktop, mobile) plus an optional desktop loopback listener. Tokens live in
  the secret store per member, never in the DB as plaintext. `not_eligible` accounts (e.g. some Business/Enterprise)
  fall back cleanly to org models. New ADR-0017.
- **D-03 (owner 2.1: Claude):** Claude in AI chats only through an **org Anthropic or OpenRouter API key**, labelled
  **METERED** in the UI. No Claude subscription path for AI chats (Anthropic's policy forbids routing plan credentials
  through third-party apps, Agent SDK included).
- **D-04 (owner 3.1: web search on org keys):** a SearXNG-backed search tool (free, self-hosted, `search` compose
  profile, consistent with ADR-0010); when SearXNG is off, the Web toggle is disabled with the reason. On the
  ChatGPT-plan backend, the plan's hosted web search is used.
- **D-05:** one generation per conversation (partial unique index); stop works across API instances via Redis and keeps
  partial output; streaming over the existing realtime WS as offset deltas with a durable final message; prompts built
  only by `buildModelMessages` from persisted messages (AGENTS.md).
- **D-06:** usage records are immutable per generation (model, backend/provider, input/output tokens, cost estimate —
  $0 on the member's plan, provider prices on org keys); daily limits reuse the Phase 3.1 pattern.
- **D-07:** Phase 1 provider keys move from `app.secrets` to `SecretReference` (encryption stays, `db` secret provider)
  with a data migration; allowed-models list governs AI chats and bots.
- **D-08 (visual):** ChatGPT/Claude.ai-quality chat screen consistent with the Work Zone/T3 Code language and the
  Phase 4 renderer; verified at 1440/390, light and dark.

### Claude's Discretion
Data model, protocol details, plan split (research suggests 12 plans, tracer-first), assistant `author_kind`.

</decisions>

<canonical_refs>
- `.planning/phases/05-direct-ai-chat/05-RESEARCH.md` (incl. Validation Architecture, Security Domain, plan breakdown)
- ROADMAP Phase 5, REQUIREMENTS AICHAT-01..09; ADR-0006, 0010, 0013, 0014, 0015, 0016; Phase 3.1/3.2/4 summaries
- AGENTS.md, CLAUDE.md

</canonical_refs>

<deferred>
- Re-evaluate the Work Zone Claude Code path (Agent SDK + member's Claude login) against Anthropic's policy, and the
  bots' single org ChatGPT seat — follow-up todo, not this phase.
- Multiplayer AI chat (Phase 6).

</deferred>

---
*Phase: 05-direct-ai-chat · Context gathered: 2026-10-06*
