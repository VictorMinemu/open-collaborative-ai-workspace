---
phase: 06-multiplayer-ai-chat
plan: 12
subsystem: web (ai-chat share dialog, participants, AI chats page), api (ai-chat participants/roster/shared), e2e
status: complete
tags: [multiplayer-ai, sharing, grants, participants, presence, agents, personas, tracer]
requires:
  - "06-03: ShareDialog People section, useAiChatGrants/createAiChatGrant, useSharedAiChats, shareWith helper"
  - "06-04: unit/org grants, PATCH/DELETE grants, live revocation, notices"
  - "06-08: Shared with me unread, emitChatUpdated; 06-10: /participants, /agents routes, persona delivery, turn.withheld"
  - "06-11: multiplayer composer (Ask AI, @ suggestions), typing, lost access"
provides:
  - "SharePeople (share-people.tsx): one picker over members, departments/teams/projects and 'Everyone at <org>'; level menu and confirmed removal per grant; org confirmation"
  - "AiChatParticipants (participants.tsx): presence stack + audience chip; list popover (sheet at 390) with access labels, agents, owner actions"
  - "AddAgentDialog (add-agent-dialog.tsx); header menu 'Add an agent'"
  - "ai-grant-queries: updateAiChatGrant, revokeAiChatGrant, useAiChatParticipants, addAiChatAgent, removeAiChatAgent"
  - "lib/ai-audience.ts: audienceSummary, audienceScope, accessLabel (pure, unit-tested)"
  - "AI chats page 'Shared with me' group (owner, Can view, unread)"
  - "API: GET /participants lists unit/org readers who never joined; model roster drops people who lost access; an agent member makes a chat shared (D-06)"
affects: [06-16 (phase verification: share-people, agents e2e), 06-14/06-15 (fake cell gains toolCallRequests and withheld wording)]
tech-stack:
  added: []
  patterns:
    - "Owner reads the audience from its grants (team names); everyone else from /participants.audience"
    - "conv: conversation.member_added/removed refresh the participants query (agents and joiners appear live)"
key-files:
  created:
    - apps/web/components/ai-chat/share-people.tsx
    - apps/web/components/ai-chat/participants.tsx
    - apps/web/components/ai-chat/add-agent-dialog.tsx
    - apps/web/lib/ai-audience.ts
    - apps/web/lib/ai-audience.test.ts
    - e2e/tests/ai-chat-share-people.spec.ts
    - e2e/tests/ai-chat-agents.spec.ts
  modified:
    - apps/web/lib/ai-grant-queries.ts
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/components/ai-chat/{share-dialog,ai-chat-header,ai-chat-view}.tsx
    - apps/web/components/chat/views/ai-chats-view.tsx
    - apps/api/src/modules/ai-chat/{members,dto,turn}.ts
    - apps/api/src/modules/ai-chat/grants.int.test.ts
    - apps/api/src/modules/agent-channel/ai-chat-delivery.int.test.ts
    - e2e/support/fake-cell-plugin.ts
    - e2e/tests/ai-chat-multiplayer.spec.ts
decisions:
  - "D-06 (orchestrator decision): any agent member makes the chat shared (sharedSql, isShared, turn.ts), so the owner's personal instructions stop once a persona joins; memory was already never sent in AI chats"
  - "GET /participants adds the active members a unit/org grant covers who never opened the chat (max 200), with their access; the persona roster (participantsOf) stays the joined people"
  - "The model roster lists only participants who can read the chat now; their earlier messages stay attributed (06-04 open item)"
  - "Grant level and removal live in one per-row menu (Can chat / Can view / Remove access); removal and the whole organization confirm in place, like the Phase 5 link revoke"
  - "The P-13 disclosure sits above the picker (plan behaviour); the billing line still shows only for Can chat"
  - "Chip: owner 'Shared with Backend' / 'Shared with everyone' / 'Shared with 3 people'; grantee 'Shared with you' or 'N people' (grants are owner-only); at 390 the 'Shared with' prefix is screen-reader only"
  - "The AI chat stream subscribes with presence always (one subscription, no re-subscribe when a chat becomes shared)"
metrics:
  duration: "~2h45m"
  completed: 2026-10-07
estimate:
  tokens: 140000
actuals:
  tokens: 26100   # chars/4 over the added lines of the diff, screenshots excluded (104 364 chars)
  tasks: 2
  commits: 9
---

# Phase 6 Plan 12: Share in place with people, teams and everyone; participants and agents Summary

The owner now shares an AI chat from one dialog with a person, a department, a team, a project or everyone in the organization, at Can chat or Can view. The dialog states first what becomes visible. The owner can change a level or remove access. Removal always asks for confirmation, and so does sharing with the whole organization. The header shows who is here (presence dots) and how widely the chat is shared ("Shared with Backend"). That chip opens the participants list, with each person's access and the agents. From the list the owner adds a team persona or removes it. People in the chat @mention the persona from the composer suggestions, see it typing, and get its reply in the chat. The AI chats page now lists "Shared with me".

## Tasks

| Task | Name | Commits |
|------|------|---------|
| — | API: unit readers in /participants, roster after unit removal, persona = shared (D-06) | 6992880 (RED), 6d6f438 (GREEN) |
| 1 | Víctor widens his chat from Alex to Backend, makes it view-only, removes Alex (tracer) | be0aae4 (RED e2e), 3ab5b09 (GREEN) |
| 2 | Víctor adds @backend; Alex's @mention gets its reply; withheld tool refused | eb843d2 (RED e2e), 801349a (GREEN) |
| — | Regression race fix, screenshots | 47f7dda, ccdf88a |

## Verification

- **API, RED then GREEN, one file at a time on fresh PostgreSQL + Redis:**
  - `grants.int` 17/17 (2 new).
  - `ai-chat-delivery.int` 13/13 (1 new).
  - Regressions: `multiplayer.int` 17/17, `shared.int` 17/17, `prompt-matrix.int` 9/9, `queue.int` 13/13, `ai-chat.int` 20/20.
- **Web unit:** `ai-audience.test.ts` 6/6.
- **Plan e2e (isolated harness):**
  - Task 1: `--rebuild-web ai-chat-share-people ai-chat-share ai-chat-list` passed 19/19. RED first: the disclosure was below the picker.
  - Task 2: `ai-chat-agents` passed 3/3. RED first: no Add an agent control.
- **Final regression:** `--rebuild-web ai-chat team-bot-dm bots.spec` covered every ai-chat spec plus bots and team-bot-dm on desktop and mobile. Result: 106 passed, 1 failed.
  - The failure was `ai-chat-multiplayer` at 390. It read the answer text before the answer completed.
  - The spec passed 9/9 on a re-run. The read now waits for completion (47f7dda).
- **`pnpm typecheck --force`:** 8/8.
- **`pnpm verify`:** exit 0. 182 files, 2567 tests. Lint shows only the 4 existing local-runtime warnings.
- **Checker W3:** `ai-chat-agents` covers the tool refusal.
  - An admin deny rule on `bot.tool.use` for Alex.
  - Alex's turn withholds `ocw_echo` (`turn.withheld = [{ocw_echo, denied_for_you}]`).
  - The persona replies "Tool ocw_echo: not available for Alex Kim (denied_for_you)" on both pages.
  - Zero `/tool-calls` requests for that event.
  - The model never answers.
- **06-11 open item proven:** @backend appears in Alex's @ suggestions with its Bot badge, its typing shows on both pages, and its reply renders flat with a badge.
- **Screenshots, all reviewed with Read (1440 and 390, light and dark):**
  - `share-people-*` (8 files)
  - `share-org-confirm-*` (2 files)
  - `participants-*` (5 files)
  - `ai-chat-agent-*` (14 files: chat, Alex's page, add dialog, participants with the agent)
- **Acceptance greps:** `export function SharePeople`, `export function AiChatParticipants` and `export function AddAgentDialog` are all present.
- The `.env` symlink was removed. The demo was not touched.

## Deviations from Plan

1. **[Orchestrator decision, D-06] A persona counts as sharing.**
   - `sharedSql`, `isShared` and the prompt's `shared` now include agent members, so an owner + persona chat drops the owner's personal instructions.
   - Tested in `ai-chat-delivery.int`.
   - Side effect: such a chat now reports `shared: true`, so it shows attributed turns and the participants chip.
2. **[Rule 2, API outside the file list] Unit and org readers in `/participants`.**
   - Without this, a team grant listed only the owner, the chip could not count people, and the @ suggestions missed grantees who had never opened the chat (06-11 open item).
   - Capped at 200. The persona roster is unchanged.
3. **[Rule 1, 06-04 open item] The model roster listed people removed from the team.**
   - They appeared with no access attribute. The roster now lists only people who can read the chat now.
4. **[Rule 3] Presence for AI chats.** `useAiChat` now subscribes with `presence: true` (in `ai-chat-queries.ts`); before this, no presence reached an AI chat. It also refreshes the participants on `conversation.member_added` / `member_removed`.
5. **[Rule 3] Fake cell (`e2e/support/fake-cell-plugin.ts`).**
   - Records every `/tool-calls` request.
   - Says why a tool listed in `turn.withheld` is unavailable, mirroring the real plugin's "Tools withheld" block.
   - Narrow edits; 06-14 may touch the same file.
6. **[Rule 1] Regression race in `ai-chat-multiplayer`.** The read now waits for `completed`. This is a test-only change.
7. **[Additions] UI beyond the plan text.**
   - A header menu entry "Add an agent", so a still-private chat can get an agent.
   - "Manage access" in the participants list, which opens the share dialog.
   - The per-row level menu replaces a separate select.
8. **[Note] One person-only case is not asserted.** "Unit personas he cannot see are not listed" relies on the resolver-filtered `GET /agents` (06-07 tests). The e2e owner is an admin, so it asserts only that personal bots are excluded.

## Known Stubs

None.

## Threat Flags

None beyond the register.
- T-06-12-01: the organization confirmation and its Cancel path are covered by the e2e.
- T-06-12-02: owner controls are rendered from `viewerCan`. Alex sees no add or remove control, and the API enforces the same rules.
- T-06-12-03: the agent list comes from `GET /agents`.
- New read surface (deviation 2): readers of the chat can see the other readers' names and access. The P-13 disclosure already states this ("who has access … the other participants").

## Open items

- For a grantee, the chip says "N people" for a unit grant. Unit names come only from the owner's grant list, so this would need a contract field to improve.
- `GET /participants` lists at most 200 readers who have not joined. An organization grant in a very large org therefore shows a partial list.
- 06-10 open item, still open: proof against a real OpenClaw cell.

## Broken-windows ledger (single line; not written by this executor)

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: share-people.tsx, participants.tsx, add-agent-dialog.tsx, ai-audience.ts, both e2e specs, 29 screenshots, this SUMMARY.
- Commits 6992880, 6d6f438, be0aae4, 3ab5b09, eb843d2, 801349a, 47f7dda, ccdf88a are on wt/06-12.
