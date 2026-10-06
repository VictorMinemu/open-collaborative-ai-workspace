---
phase: 04-chat
plan: 07
subsystem: chat
status: complete
tags: [chat, dm, group-dm, privacy, memory, rls, realtime, web]
requirements: [CHAT-04]
dependency_graph:
  requires: [04-01 (contracts, access.ts, group key index), 04-03 (permalink window), 04-04 (attachments), 04-05 (reactions, pins, saves), 04-06 (search), 03.1 DM model]
  provides:
    - POST /api/v1/dms (human DM, bot DM, group DM; insert-or-get on dm_key)
    - counterpart union (agent | user | group) in GET /api/v1/dms
    - ensureHumanDm, ensureGroup, groupLabel (chat/dm.ts)
    - group kind across chat, agent-channel, access, policy (state dm)
    - turn-policy memory gate on exactly one human member
    - NewDmDialog, Direct messages sidebar section, DM/group headers, Message on the palette card and profile sheet
    - dm-privacy.int.test.ts (the route list Plan 09 extends with the inbox)
  affects: [04-09 (inbox case goes into dm-privacy.int.test.ts), 04-12 (attachments on send; the privacy suite links them by hand today)]
tech-stack:
  added: []
  patterns:
    - "insert-or-get on a partial unique index per kind (dm, group), members ordered by joined_at offsets"
    - "route body schema looser than the client contract so the handler answers the domain error (CreateDmRequestFields)"
key-files:
  created:
    - apps/web/components/chat/new-dm-dialog.tsx
    - apps/api/src/modules/chat/group-dm.int.test.ts
    - apps/api/src/modules/chat/dm-privacy.int.test.ts
    - e2e/tests/dms.spec.ts
  modified:
    - packages/contracts/src/chat.ts
    - apps/api/src/modules/chat/{dm,index,service,access}.ts, dm.int.test.ts
    - apps/api/src/modules/organization/permissions/{policy.ts,resolve.test.ts}
    - apps/api/src/modules/agent-channel/mentions.ts
    - apps/api/src/modules/bot-capabilities/{turn-policy.ts,memory.int.test.ts}
    - apps/web/components/chat/{chat-sidebar,dm-view,principal-avatar}.tsx, apps/web/lib/chat-queries.ts
    - apps/web/components/search/search-palette.tsx, apps/web/components/members/member-profile-sheet.tsx
    - e2e/tests/personal-bots.spec.ts
decisions:
  - "Human DMs: both humans are role member; bot DMs keep the 3.1 shape (human owner)"
  - "Group label: others in pick order (creator first, humans before bots), up to three names then 'and N more'"
  - "Group bots are reached by @mention only, never by reply mode all, and only if already members; delivery is flat like a DM"
  - "Over-limit notices: every message in a 1:1 DM, once a day per conversation in groups (like channels)"
  - "Memory scope is a dm with exactly one human member; anything else carries no memory and offers no save tool"
metrics:
  duration: "~40 min"
  completed: 2026-10-06
  tasks: 3
  files: 38
estimate:
  tokens: 210000
actuals:
  tokens: 33600
  tasks: 3
  commits: 3
---

# Phase 4 Plan 07: Human DMs, group and mixed DMs, and the DM privacy suite Summary

A member opens a DM with a colleague from New message (or from the palette card or the profile sheet). It shows up in both sidebars live and messages flow both ways. Groups of up to 9 people and team bots have fixed membership; a bot answers only when @mentioned, at the top level, with no memory. Personal bots never join a group. A non-participant admin, and another organization's admin, get the same bare 404 on all 24 routes and see nothing in lists, search or the `conv:` topic.

## What was built

- **API:** `POST /api/v1/dms` creates or finds the conversation:
  - one person → `ensureHumanDm`: `member.read` is checked, then the person must be active and not the caller.
  - one bot → the 3.1 `ensureDm` path. `bot.read` is checked and hidden as 404, so a personal bot works for its owner only.
  - two or more → `ensureGroup`. The caller and duplicates are removed first, then the cap is 9 including the caller.
  - Errors: `cannot_dm_self`, `member_deactivated`, `agent_disabled`, `too_many_participants` (400); `personal_bot_dm_only` (409); unknown or org-B ids → 404.
  - The response is the caller's `DmSummary`, after a `channel.read` decision.
  - `dm_key` is always `dmKeyOf` (sorted `<kind>:<id>`). `dmKey()` wraps it, so 3.1 keys are unchanged.
  - `dm.created` is audited with ids only and announced on members' `user:` streams only.
- **Lists:** `listDms` returns the agent | user | group union. Deleted bots drop their 1:1 DM, deactivated people are flagged, and personal bots stay first.
- **Groups:**
  - Policy: `ChannelFacts.kind` gains `group`, which maps to state `dm`. That gives fixed membership and no `delete_any`.
  - Flat: `MESSAGE_KINDS` includes `group`, `dm_is_flat` applies, and bot replies land at the top level.
  - `dispatchGroupMentions`: only mentioned bots that are already members, live, not personal, and allowed `bot.read` for the author. It sends one delivery, and never uses reply mode.
  - The agent-channel history is the whole conversation, without tombstones.
  - `turn-policy` passes the memory gate only for a `dm` with exactly one human member.
- **Web:**
  - `NewDmDialog`: people, then team bots, then your own personal bots (one-to-one only, with the reason shown); chips; hint "Direct message" or "Group of N"; max 8 others; full-height sheet at 390.
  - Sidebar: "Direct messages" section with "+" and a "New message" row. Rows show a person avatar, a bot avatar (`data-bot-name` kept), or stacked avatars plus a count for groups.
  - `DmView` by counterpart:
    - person: avatar, `@handle`, intro, and a read-only notice when deactivated.
    - group: stacked avatars, a "N members" popover with BOT badges, and @mention candidates limited to the group.
    - Bot-only controls appear only for bots. `MentionContext` is now wired, which closes the 04-02 open item.
  - "Message" on the palette's person card (04-06 open item) and on the member profile sheet.

## Privacy suite: routes covered (`dm-privacy.int.test.ts`)

Each route is checked for a human DM and a group, as the same-org admin and as an org-B admin: 404, no `details`, no names and no secret word. Participants keep 200 or 302.

| # | Route |
|---|---|
| 1–3 | `GET /conversations/:id/messages` (latest, `around`, `after`) |
| 4 | `GET /messages/:id/thread` |
| 5 | `POST /conversations/:id/messages` |
| 6–7 | `PATCH`, `DELETE /messages/:id` |
| 8–9 | `PUT`, `DELETE /messages/:id/reactions/:emoji` |
| 10–12 | `GET /conversations/:id/pins`, `PUT`, `DELETE /conversations/:id/pins/:messageId` |
| 13–14 | `PUT`, `DELETE /messages/:id/save` |
| 15 | `POST /conversations/:id/read` |
| 16–17 | `POST /conversations/:id/attachments` (presign), `POST /attachments/:id/complete` |
| 18–20 | `GET /attachments/:id/preview`, `/large`, `/download` |
| 21–24 | `GET /channels/:id`, `GET`/`POST /channels/:id/members`, `POST /channels/:id/join` |

Lists and realtime are checked separately:
- `GET /dms` and `GET /saved` never include the conversations.
- `GET /search/messages` (with and without `in`) and `GET /search` return no hits for the conversation's unique words.
- `GET /search/channels` never lists them.
- A WS `sub` to `conv:<id>` gets `err forbidden`, and no frame arrives after a live post.
- The database is unchanged after the attempts.

**Plan 09 adds the inbox case to `routesFor`.**

## Verification

| Check | Result |
|---|---|
| `vitest --project integration dm.int.test.ts` | 16/16 (8 new; RED first: route missing) |
| `vitest --project integration group-dm.int.test.ts` | 12/12 (RED first) |
| `vitest --project integration memory.int.test.ts` | 13/13 (2 new; RED first) |
| `vitest --project unit resolve.test.ts` | 52/52 (1 new; RED first) |
| `vitest --project integration dm-privacy.int.test.ts` | 10/10 suites, none skipped |
| `pnpm typecheck --force` after the contract change | 8/8 |
| `pnpm verify` (final tree) | 128 files, 1766 tests, exit 0 |
| `e2e-isolated.sh dms team-bot-dm personal-bots search` (task 1) | all pass after 2 spec fixes |
| `e2e-isolated.sh dms bot-memory bot-reply-mode` (task 2) | 11/11 |
| `e2e-isolated.sh dms team-bot-dm personal-bots bot-memory bot-reply-mode search chat.spec permalinks` (final) | 31/31, none skipped or flaky |
| Acceptance greps | `ensureHumanDm`, `ensureGroup` exported; `"/dms"` ×2; `new-dm` in sidebar; `"group"` in policy.ts; `MESSAGE_KINDS` with group; 31 `404` and a `conv:` case in the privacy suite |

I reviewed these screenshots with the Read tool: `dm-new-dialog-{1440,390}[-dark]`, `dm-human-{1440,390}[-dark]`, `dm-group-{1440,390}[-dark]`, `dm-group-dialog-*` and `dm-group-members-*`. The dialog is a full-height sheet at 390. The 390 chips wrap above the input. The member popover isn't clipped at 390, and dark mode is legible. I also checked the regression captures of the bot DMs and memory; they were deleted afterwards, not committed.

## Deviations from Plan

1. **[Rule 3] `CreateDmRequestFields` added to contracts.** It is the route body schema, capped at 32 entries. Without it, Zod would reject 10 participants as `validation_error` before the handler could answer `too_many_participants`. `CreateDmRequest` is unchanged for clients. (5e35d5b)
2. **[Spec] Group label order.** Others are listed in pick order: creator first, humans, then bots. Member rows get `joined_at` offsets of 1 µs per position. This matches the plan's example "Sam Lee, Alex Kim and Helper".
3. **[Rule 1] `GET /messages/:id/thread` was channel-only.** DM and group participants got 404, which contradicted "participants 200 everywhere". It now reads any message conversation through the readable set; outsiders still get 404. (7714ba4)
4. **[Rule 2] Over-limit notices in groups** go out once a day per conversation, like channels, not on every message (that rule only makes sense in a 1:1 DM). The reply stays flat.
5. **[Rule 2] Memory gate defence in depth:** a `dm` with two humans gets no memory even if a bot is inserted by hand (integration test with the tampered row).
6. **[Spec] e2e uses one colleague per project** (Rosa on desktop, Theo on mobile), so each project creates its own DM live. `personal-bots.spec` now expects `dm-section` / "Direct messages", because the section was renamed by plan. `data-bot-name`, `dm-link`, `dm-title`, `dm-privacy`, `dm-intro` and `dm-missing` are unchanged.
7. **[Addition] "Message" on `MemberProfileSheet`** (file not in the plan's list). It is the same action as the palette card and closes the profile open item for both places.
8. **[Spec] Attachments in the privacy suite** are linked to their message with SQL. Linking on send arrives with 04-12, and the 04-01 `attachments_unavailable` guard is still in place.
9. **[Process] Privacy suite RED:** all outsider cases passed on the first run, so no leak was found. Only the participant thread case failed (deviation 3).
10. **[Process] Org-B admin with a real HTTP session:** a member invited to org A is moved to org B with SQL, then signs in again. There is no multi-org setup path.

### CLAUDE.md
- Policy and permission change (`ChannelFacts.kind` `group`): plan-mode approval was delegated to the orchestrator. The change is add-only and maps to the existing state `dm`. Covered by `resolve.test.ts` and the privacy suite.
- No migration. The `conversations_org_group_key_uq` index exists since 04-01.
- `wt/04-07` is outside the executor's agent-branch allow-list; I committed there as instructed. `.env` was symlinked only for the isolated e2e and has been removed; I never read it.

## Known Stubs

None.

## Open issues

- The OpenClaw plugin treats a group as `channel` (persona and session key per message). Replies are still flattened by the API, and history and the roster are complete. A group-aware persona belongs in a plugin change.
- `setAgentDmsArchived` archives only 1:1 bot DMs. A group whose bot is disabled stays active for its humans; the bot just stops answering.
- `MentionContext` in DMs uses the org directory. Handles of deleted bots render as plain text.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file packages/contracts/src/chat.ts --description "CreateDmRequestFields (route body, max 32) so POST /dms answers too_many_participants after dedupe instead of validation_error"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/index.ts --description "GET /messages/:id/thread now serves DM and group roots to participants (was channel-only); outsiders still 404"
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/chat/dm-privacy.int.test.ts --description "Privacy suite links attachments to messages via SQL until 04-12 wires attachments on send; Plan 09 adds the inbox route"
gsd windows append --kind deviation --phase 04 --file apps/web/components/members/member-profile-sheet.tsx --description "Message action added to the member profile sheet (not in plan file list)"
```

## Threat model coverage

- **T-04-07-01:** 24 routes × 2 conversations × 2 admins return 404; lists, search and WS are empty; the database is unchanged.
- **T-04-07-02:** group = state `dm` (resolver test); channel member routes return 404 for groups; a new member means a new key (int test).
- **T-04-07-03:** personal bots get 409 in groups, the owner included. Memory requires exactly one human: the group turn has no memory, the save is refused with `dm_only`, and the tampered DM gets nothing.
- **T-04-07-04:** the on-behalf-of `channel.read` in `providePostAgentMessage` covers groups; delivery is mention-only and needs `bot.read` per author.
- **T-04-07-05:** `dmKeyOf` sorts ids and holds no names (asserted); the partial unique index is backed by a 20-way concurrency test.
- **T-04-07-06:** org-B ids return 404 on `POST /dms`, and the org-B admin gets 404 everywhere.
- **T-04-07-07:** insert-or-get plus the cap of 9 (accepted).

No new surface beyond the plan.

## Commits

- 5e35d5b feat(chat): human DMs from the New message picker, Direct messages sidebar and search Message (04-07 task 1)
- 35e7601 feat(chat): group and mixed DMs up to 9 with fixed membership, mention-only team bots and no shared memory (04-07 task 2)
- 7714ba4 test(chat): non-participant admins get a bare 404 on every DM and group DM path (04-07 task 3)

## Self-Check: PASSED

All created files exist, and commits 5e35d5b, 35e7601 and 7714ba4 are on `wt/04-07`. The working tree was clean before this summary. The `.env` symlink has been removed.
