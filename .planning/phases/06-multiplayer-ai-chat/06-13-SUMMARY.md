---
phase: 06-multiplayer-ai-chat
plan: 13
subsystem: api (agent-channel cards, chat card actions, ai-chat snapshots), contracts
status: complete
tags: [agents, agent-cards, openclaw, notifications, approvals, tracer]
requires:
  - "06-01: AgentCard/AgentCardInput/AgentCardPatch/AgentCardDecisionRequest/AgentCardParams/AgentCardRoute, Message.card, agent_card.approve, message_cards, message_card_follows, card_updated"
  - "06-07: bot.read / persona visibility; 06-08: notifyUsers, AI chats in chat events; 06-10: personas post into AI chats via providePostAgentMessage"
provides:
  - "POST /agent-channel/v1/cards (201 / 200 idempotent) and PATCH /agent-channel/v1/cards/:messageId (posting agent only, optimistic version)"
  - "POST/DELETE /api/v1/cards/:messageId/follow, POST /api/v1/cards/:messageId/decision (single, audited, server-decided)"
  - "Contracts: AgentChannelPostCard(Response), AgentChannelPatchCard(Response), AgentCardActionEvent, AgentChannelEventTypes.cardAction = agent.card_action.v1"
  - "chat exports: withCards, cardOf, cardMessageOf, patchCard, CardRow; agent-channel exports emitCardAction"
  - "Bridge: PostAgentMessageInput.card, AgentPoster.cardVersion, onCardAction/emitCardAction"
  - "Audits agent_card.posted / agent_card.updated / agent_card.decided (ids, kind, status, version, outcome only)"
affects: [06-14 (cell tool posts/patches cards and handles agent.card_action.v1), 06-15 (renderer uses card, following, viewerCan, message.updated), 06-16 (security matrix over the new routes)]
tech-stack:
  added: []
  patterns:
    - "Card actions reach the agent as a synthetic mention of the agent on the card message (buildMentionEvents + turnPolicy), re-typed agent.card_action.v1"
    - "Viewer capabilities (following, viewerCan) only in REST snapshots; realtime carries the card without viewer fields"
key-files:
  created:
    - apps/api/src/modules/agent-channel/cards.ts
    - apps/api/src/modules/chat/card-actions.ts
    - apps/api/src/modules/agent-channel/cards.int.test.ts
  modified:
    - packages/contracts/src/agent-channel.ts
    - apps/api/src/lib/chat-agent-bridge.ts
    - apps/api/src/modules/agent-channel/index.ts
    - apps/api/src/modules/chat/{index,service}.ts
    - apps/api/src/modules/ai-chat/service.ts
decisions:
  - "Card writes stay in chat (insertCard in postMessage, patchCard): agent-channel owns the API surface, cell auth, audit of updates and follower notifications"
  - "A card post uses the idempotency key namespace card:<key>, so a card and a plain reply never collide on one key"
  - "A decision does not bump the card version (version is the agent's content version); it streams as message.updated"
  - "viewerCan.follow = any reader; viewerCan.decide = approve action + named approver (if any) + undecided + agent_card.approve in that conversation"
  - "Both card routes first check the agent belongs to the authenticated cell (findAgent in the cell's tenant, as POST /typing): 404 agent_not_found"
metrics:
  duration: "~1h20m"
  completed: 2026-10-07
estimate:
  tokens: 160000
actuals:
  tokens: 21000
  tasks: 2
  commits: 6
---

# Phase 6 Plan 13: Agent Cards API Summary

Agents post typed Agent Cards (kind, title, fields, status, Open/Follow/Approve) through the Agent Channel API wherever they can post; the body is the plain-text summary, the posting agent updates the card in place with an optimistic version, readers follow it (card_updated on status changes) and one allowed reader decides an approval once, delivered to the agent as `agent.card_action.v1`.

## What was built

- **Agent Channel (`agent-channel/cards.ts`)**: `POST /cards` goes through `chatAgent.postAgentMessage({card})`, so channel/thread/DM/group DM/AI chat placement, `channel.post`, the confused-deputy check and flat conversations are exactly those of `POST /messages` (thread-target resolution extracted into the shared `resolveReplyTarget`). `PATCH /cards/:messageId` checks the agent, then the card (RLS: another tenant's card is 404), then authorship (403 `not_card_author`), then the version (409 `card_version_conflict`); a summary change rewrites `messages.body` and `edited_at`. Followers get `card_updated` (actor = the agent) only when the status changes. `emitCardAction` builds the event with `buildMentionEvents` (deciding human as author, sentence `Sam Lee approved “Deploy api v2.3”`, `turn` for that human, thread or flat) and appends it to `cell:<org>`; disabled or limited agents get none and the decision stands.
- **Chat (`chat/card-actions.ts`)**: `insertCard` in the agent post transaction (so `message.created` carries `card`), `patchCard`, `cardOf`, `cardMessageOf`, `withCards` (one query for cards, one for follows; `viewerCan` from the resolver), wired into `hydrateViewer` (all channel/thread/DM/pin/saved snapshots) and the AI chat `toDtos`. Human routes: follow/unfollow (204) and decision (`channel.read` hidden 404 → `agent_card.approve` 403 → `card_not_decidable` 409 → `not_card_approver` 403 → `card_already_decided` 409, one conditional update `where decision is null`, `message.updated`, audit, bridge).

## Verification

- `pnpm typecheck --force`: 8/8 tasks.
- `cards.int.test.ts`: 25/25 (real PostgreSQL + Redis, fake cell, no provider calls).
- Regressions, one file at a time: `agent-channel.int` 23/23, `ai-chat-delivery.int` 12/12, `notifications.int` 25/25, `chat.int` 28/28, `ai-chat.int` 20/20, `dm-privacy.int` 12/12.
- `pnpm verify`: exit 0 (lint clean except 4 pre-existing local-runtime warnings, 181 files / 2547 tests).
- Acceptance greps: `agent.card_action.v1` in contracts; `/cards` ×2+ in cards.ts; `withCards` in chat and ai-chat services; `card_already_decided` in card-actions.ts; `card_updated` in cards.ts.

## Deviations from Plan

### Auto-fixed / adjusted

1. **[Rule 2 - Security, coordinator request] Card routes check agent ownership first.** An automated review flagged that `agentId` came from the body. Tenant RLS plus chat's directory lookup already refused other organizations' agents on POST, but PATCH answered 403 and POST could reveal `conversation_not_found` before the agent check. Both routes now call `findAgent` in the cell's tenant first (the `POST /typing` check; one cell per organization, so the cell's agents are the organization's): 404 `agent_not_found` for unknown or foreign agents; PATCH still answers 403 `not_card_author` for another agent's card. Tests: org-B cell naming org A's agent, org-B cell with its own agent (404 `card_not_found` on org A's card), org A's cell naming org B's agent or a random id, and another agent of the same cell. Commits fa8445f (RED), ebcabe6 (fix).
2. **[Rule 2] PATCH also refuses a disabled or deleted agent (403 `agent_disabled`), a tombstoned card message (409 `message_deleted`) and an archived conversation (410).** The decision route refuses archived conversations too (410).
3. **Structure:** the PATCH write (lock, conditional version update, body update, `message.updated`) lives in chat's `patchCard` (chat owns messages); `cards.ts` keeps the route, cell auth, audit and notifications. Same behaviour as planned.
4. **Human card routes answer a missing card with the generic `not_found`**, identical to a hidden one (no existence leak); the cell PATCH uses `card_not_found`.
5. **At its daily limit the agent gets no event**, but the standard D-11 limit notice (from `buildMentionEvents`) may be posted in the card's thread or DM, exactly as for an over-limit mention.

## Known limitations / open issues

- `notifyUsers` keeps one notification row per (user, message) and only upgrades to a stronger kind, so a follower is notified on the first status change of a card; later status changes of the same card do not re-notify or mark it unread again. Fixing it means changing 06-08's `deliver` upsert for `card_updated` (out of this plan's files).
- `agent.card_action.v1` is not yet consumed by the real plugin (06-14).

## Broken-windows ledger (single line; not written by this executor)

`gsd windows append --kind deviation --phase 06 --file apps/api/src/modules/notification/service.ts --description "06-13 card_updated notifies a follower only on a card's first status change (one notification row per user+message; later changes do not re-notify)"`

## Commits

- 008115f test(api): failing Agent Card lifecycle cases (06-13)
- 4e09788 feat(api): agents post and update typed Agent Cards in place through the Agent Channel API (06-13)
- fa8445f test(api): card routes refuse foreign, unknown and other agents' identities (06-13)
- ebcabe6 fix(api): card routes check the agent belongs to the authenticated cell first (06-13)
- ebd9a50 test(api): failing card follow, notification and decision cases (06-13)
- dd10cf8 feat(api): readers follow cards and decide approvals once; decisions reach the agent as agent.card_action.v1 (06-13)

## TDD Gate Compliance

RED → GREEN pairs in git log for both tasks and the security fix (008115f→4e09788, fa8445f→ebcabe6, ebd9a50→dd10cf8).

## Self-Check: PASSED

Files exist (cards.ts, card-actions.ts, cards.int.test.ts); all six commits present on wt/06-13.
