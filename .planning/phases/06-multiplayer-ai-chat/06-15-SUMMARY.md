---
phase: 06-multiplayer-ai-chat
plan: 15
subsystem: web (agent cards), api (card read + approval policy), e2e
status: complete
tags: [agents, agent-cards, approvals, follow, notifications, security, tracer]
requires:
  - "06-13: AgentCard / Message.card, POST|PATCH /agent-channel/v1/cards, POST|DELETE /cards/:id/follow, POST /cards/:id/decision, agent.card_action.v1, card_updated"
  - "06-10: personas in AI chats (POST /ai-chats/:id/agents); 06-11: AI chat reducer and persona rows; 06-08: inbox kinds and OS pop-ups"
provides:
  - "AgentCardView (components/chat/agent-card.tsx): the one card renderer, used by MessageRow (channels, threads, DMs, group DMs) and AI chat persona turns"
  - "lib/agent-cards.ts: mergeCard, shownCard, openTargetOf (pure)"
  - "lib/card-queries.ts: cardKeys, useAgentCard, followCard (optimistic, rolled back), decideCard (server-confirmed), refreshCard"
  - "GET /api/v1/cards/:messageId: the viewer's card (following, viewerCan) for cards that arrived live"
  - "Policy: agent_card.approve on an AI chat needs the owner or a `chat` grant (view grantee: 403 ai_chat_view_only, never offered decide)"
  - "Fake cell: postCard / patchCard; e2e agent-cards.spec.ts"
affects: [06-16 (security matrix: GET /cards/:id and the AI chat approve rule), 06-14 (cards the real plugin posts render here)]
tech-stack:
  added: []
  patterns:
    - "Viewer fields of a card survive realtime copies (chat mergeMessage and the AI chat reducer); a decided card never offers decide, whatever a cache says"
    - "One viewer copy per card in React Query (cardKeys.card): seeded from REST, read once for live cards, written by Follow and decisions; AI chats read the same copy"
    - "e2e readiness: wait until every page sees the others present (sockets subscribed) before the cell posts"
key-files:
  created:
    - apps/web/components/chat/agent-card.tsx
    - apps/web/components/chat/agent-card.test.tsx
    - apps/web/lib/agent-cards.ts
    - apps/web/lib/agent-cards.test.ts
    - apps/web/lib/card-queries.ts
    - e2e/tests/agent-cards.spec.ts
  modified:
    - apps/web/components/chat/message-list.tsx
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/lib/chat-queries.ts
    - apps/web/lib/ai-chat-stream.ts
    - apps/web/lib/ai-chat-stream.test.ts
    - apps/api/src/modules/chat/card-actions.ts
    - apps/api/src/modules/organization/permissions/policy.ts
    - apps/api/src/modules/organization/permissions/resolve.test.ts
    - apps/api/src/modules/agent-channel/cards.int.test.ts
    - e2e/support/fake-cell-plugin.ts
decisions:
  - "Card text (title, fields, labels) is plain React text; the summary (message body) is the card's sr-only description, rendered once"
  - "Open is a Next Link only when openTargetOf passes isAgentCardRoute; otherwise no Open control at all"
  - "Follow/Approve are shown only once the viewer's capabilities are known (snapshot or GET /cards/:id); nothing is guessed from realtime"
  - "The decision line replaces Approve/Deny in the actions row, so deciding never resizes the card"
  - "Approve and Deny both confirm in a dialog naming the card (bottom sheet at 390); a refused decision (403/409) toasts the server message and re-reads the card"
  - "Deciding in an AI chat is a write: owner or `chat` grantee only (policy precondition, so withCards and the decision route agree)"
metrics:
  duration: "~1h50m"
  completed: 2026-10-07
estimate:
  tokens: 120000
actuals:
  tokens: 16000   # chars/4 over the added lines of the diff, screenshots excluded (65 283 chars)
  tasks: 2
  commits: 11
---

# Phase 6 Plan 15: Agent Card renderer Summary

Agent Cards now render everywhere people talk with agents — channels, threads, DMs, group DMs and AI chats — through one `AgentCardView`. Each card shows its kind, title, status pill, fields and Open / Follow / Approve / Deny. Updates from the agent change the same card in place on every open page. Follow is optimistic. A decision happens only after a confirmation and only once the server has accepted it; every page then shows it and the agent receives `agent.card_action.v1`. A security fix from the coordinator also landed: in an AI chat, a "Can view" grantee can no longer decide a card.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Card appears in #backend and goes Running → Succeeded in place; same card in an AI chat (tracer) | e67c1cc (RED web), 529dbdf (e2e), 3808112 (GREEN) |
| 2 | Follow → notified on failure; confirmed single approval seen everywhere | 471f9ab (e2e), 0fbd5d5 (decision in the actions row) |
| — | Security fix: view-only AI chat grantee may not decide | 5765928 (RED), 131bedf (fix) |
| — | `GET /cards/:messageId` (viewer fields for live cards) | 455381e (RED), f4f083d, a40acff (format) |
| — | Screenshots | df7196e |

## What was built

- **`AgentCardView`.** A compact card in the Phase 4 message language, with a kind icon and label.
  - The status pill has an accessible name ("Status: Running"). Its colours are AA in light and dark, and "running" gets a subtle ping (off under reduced motion). A status change remounts only the pill, so only the pill fades.
  - Fields sit in a two-column `<dl>` that becomes one column below 26rem (container query, so at 390).
  - The actions row holds Open (a Next `Link` only for valid internal routes), the Follow toggle (`aria-pressed`, "Following"), and Approve / Deny with the agent's labels. Once a decision exists, its line takes their place.
- **Wiring.**
  - `MessageRow` renders the card instead of the Markdown body when `message.card` is set. Threads, DMs and group DMs go through the same row.
  - The AI chat `PersonaTurn` renders the same component.
- **Keeping viewer fields live.** Realtime card copies carry no viewer fields (P-04), so:
  - `chat-queries.mergeMessage` and the AI chat reducer's `upsert` keep the cached `following` / `viewerCan` through `mergeCard` and drop `decide` once a card is decided.
  - A tombstone drops its card.
  - A card first seen live is read once from the new `GET /api/v1/cards/:messageId`. Follow and Approve appear only after that read.
- **Queries.**
  - `followCard`: optimistic, rolled back on error.
  - `decideCard`: applied only after the server confirms.
  - Both update the viewer copy (`cardKeys.card`) and the card in every cached channel/thread/DM window, pins and Saved. AI chats read the viewer copy.

## Verification

- **RED first:**
  - Policy unit test (1 failing).
  - Integration: the view-only decide case and the `GET /cards` cases failed, the route answering 404.
  - Web: card renderer, merge and reducer cases failed (module missing, 2 reducer cases).
- **`cards.int.test.ts`:** 27/27, on real PostgreSQL + Redis (testcontainers), with the fake cell.
- **Web unit:** `agent-card.test.tsx` 7/7, `agent-cards.test.ts` 8/8, `ai-chat-stream.test.ts` 22/22. All 15 web files, 214 tests.
- **Plan e2e, Task 1:** `OCW_E2E_SCREENSHOT_DIR=… e2e-isolated.sh --rebuild-web agent-cards chat.spec renderer` gave 19/19 (desktop and mobile; the `chat.spec` filter also matches `ai-chat.spec`).
- **Plan e2e, Task 2:** `e2e-isolated.sh --rebuild-web agent-cards notifications ai-chat-multiplayer` gave 17/17, 0 flaky.
- **Chat regression, desktop and mobile:** `e2e-isolated.sh chat dms renderer permalinks reactions-pins team-bot-dm` gave 133/133, 0 flaky. That covers every `*chat*` spec, including all 15 ai-chat specs, chat-day, chat-edit and chat-sidebar.
- **`pnpm verify`:** exit 0.
  - Typecheck 8/8.
  - 183 files, 2578 tests.
  - Lint: only the 4 existing local-runtime warnings.
- **Acceptance greps:**
  - `export function AgentCardView` is present, and `AgentCardView` appears in `message-list.tsx` and `ai-message.tsx`.
  - `export async function decideCard` is present.
  - There are 4 `agent-card-approved-*.png` files.
- **Screenshots reviewed with Read** (20 `agent-card-*` files in `screenshots/`): `running-<1440|390>[-dark]`, `succeeded-<w>`, `ai-chat-<w>[-dark]`, `approve-confirm-<w>`, `approved-<w>[-dark]`, `followed-inbox-<w>`, `view-only-<w>`.
  - The regression runs wrote to /tmp, so no other plan's captures were overwritten.
  - The `.env` symlink was removed.

## Deviations from Plan

### Security fix (coordinator request)

**1. [Rule 2 - Security] A view-only AI chat grantee could decide an Agent Card.**
- **Problem:** `agent_card.approve` was only role-based, so a "Can view" grantee who could read the card could also decide it.
- **Fix:** a policy precondition in `organization/permissions/policy.ts`. On an `ai_chat` channel resource, deciding needs the `member` relation (the owner or a `chat` grant). A `grantee` (view) is refused with `ai_chat_view_only`; anyone else gets `not_ai_chat_owner`. Channels, DMs and organization scope are unchanged.
- **Coverage:** the decision route and `withCards` both decide through the resolver, so they agree. The route answers 403 `ai_chat_view_only`, and neither the snapshot nor `GET /cards` offers `decide`, so the renderer shows no Approve.
- **Tests:**
  - Resolver unit test.
  - Integration test: a view grantee gets `viewerCan: ["follow"]` and 403 `ai_chat_view_only`; nothing is decided or emitted; a `chat` grantee can decide.
  - e2e: Sam ("Can view") sees Follow but no Approve or Deny, and his forced API call gets 403 `ai_chat_view_only`. Alex ("Can chat") sees Approve.
- **Commits:** 5765928, 131bedf.

### Auto-fixed / added

**2. [Rule 3 - Blocking] New API route `GET /api/v1/cards/:messageId` (outside the file list).**
- **Problem:** realtime carries cards without viewer fields (06-13, P-04). A card that arrives live would therefore not know whether to offer Follow or Approve, and guessing would show actions the server refuses (T-06-15-04).
- **Fix:** the route uses the same readable check as follow and decision (hidden or missing = 404) and returns `withCards` for the caller.
- **Tests:** the integration test covers following and viewerCan, an unknown id, a private channel and a plain message.
- **Commits:** 455381e, f4f083d.

**3. [Rule 2] Viewer fields kept across realtime copies (files outside the list).**
- `chat-queries.ts` `mergeMessage` (plus `card: undefined` on tombstones) and the `ai-chat-stream.ts` reducer.
- Without this, every agent update would have erased Follow, Following and Approve on every page.
- Pure helpers live in a new `lib/agent-cards.ts`, so the reducer stays free of API imports.

**4. [Design] The decision line sits in the actions row, where Approve / Deny were.**
- The first screenshots showed the card growing below the fold when it was decided at the bottom of a channel.
- **Commit:** 0fbd5d5

**5. [Clarification] Notification wording.**
- The plan's text "@deploy updated “Deploy api v2.3”" needs the card title on the notification, but `Notification` has no title field (06-08 contract).
- The inbox keeps the 06-08 label: "Deploy [BOT] updated a card you follow · #channel". The snippet is the card's summary, so the e2e patch sets "Deploy api v2.3 failed: health check timed out".
- The desktop pop-up is asserted with title "Deploy in …" and that body.
- Adding a title would need a contract and notification-service change. It is left for a follow-up.

**6. [Process] e2e written after the GREEN code.**
- The unit and integration REDs came first. The e2e specs were written once the renderer existed and passed on their first full run.
- The first run did fail, on a spec bug and a subscription race. The race was fixed with a presence-based readiness wait (`openChannel`).
- The plan's screenshot directory was swapped for /tmp during regression runs. Only the `agent-card-*` captures were copied into the phase folder.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-read-endpoint | apps/api/src/modules/chat/card-actions.ts | `GET /api/v1/cards/:messageId`. It is read-only, uses the same readable check (404 when hidden), and returns only what the conversation snapshot already shows the caller. Add it to the 06-16 security matrix. |

The register's mitigations are in place:
- **T-06-15-01:** Open is offered only for internal routes. A unit test covers https, `//`, `..` and `javascript:` targets.
- **T-06-15-02:** card text is rendered as plain text. A unit test covers `<b>`, `[x](https://evil)` and `**`.
- **T-06-15-03:** a confirmation dialog names the card, and the decision is audited by 06-13.
- **T-06-15-04:** buttons come only from the server's `viewerCan` and `decision`.

## Open items

- A follower is notified only on a card's first status change (06-13 limitation, unchanged).
- Pins and Saved still render a card message through `MessageCard` as its summary, using the shared safe Markdown renderer, not as a card.
- The card's status after a decision stays whatever the agent set (for example Pending) until the agent patches it. 06-14's plugin should move it on `agent.card_action.v1`.

## Broken-windows ledger (single line; not written by this executor)

`gsd windows append --kind deviation --phase 06 --file apps/web/components/chat/inbox.tsx --description "06-15 card_updated inbox/pop-up shows 'updated a card you follow' + summary; Notification has no card title (plan wanted '@deploy updated “<title>”')"`

## TDD Gate Compliance

- RED → GREEN pairs in the git log:
  - Security: 5765928 → 131bedf.
  - Card read: 455381e → f4f083d.
  - Web: e67c1cc → 3808112.
- The e2e specs (529dbdf, 471f9ab) came after the web RED, not before the implementation (deviation 6).

## Self-Check: PASSED

- Files exist: `agent-card.tsx`, `agent-card.test.tsx`, `agent-cards.ts`, `card-queries.ts`, `agent-cards.spec.ts`, and 20 `agent-card-*.png`.
- All 11 commits (5765928 … df7196e) are on wt/06-15.
