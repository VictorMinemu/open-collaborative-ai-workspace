---
phase: 06-multiplayer-ai-chat
plan: 03
subsystem: web (ai-chat, chat sidebar), infra/fake-model, e2e
status: complete
tags: [multiplayer-ai, sharing, grants, fake-model, e2e, tracer, scenario-b]
requires: [06-02 (grants routes, scope=shared, access/owner/shared on summaries, viewerCan with ai_chat.manage, P-06 prompt)]
provides:
  - "infra/fake-model/attribution.mjs: parseParticipants, parseTurnContext, lastMessageBody, attributedReply (pure)"
  - "Attributed replies on /v1/responses, /v1/chat/completions and /v1/messages; solo prompts unchanged"
  - "apps/web/lib/ai-grant-queries.ts: grantKeys, useAiChatGrants, createAiChatGrant (06-12 extends)"
  - "useAiChats(archived, { scope }), useSharedAiChats, aiKeys.shared; applyAiChatUpdated routes granted chats to Shared with me"
  - "ShareDialog: 'People and teams' + 'Read-only link (frozen copy)'; viewerCan prop"
  - "AiChatPeopleContext (viewerId, shared) for attributed human turns; NoticeRow for authorKind 'system'"
  - "AiChatHeader viewerCan / AiChatStandardItems viewerCan; 'Shared by <owner>' caption"
  - "e2e: VICTOR, shareWith, humanTurn; ai-chat-multiplayer.spec.ts (06-11 extends)"
affects: [06-04 (revoke/invalidator: shared list + header follow ai_chat.updated), 06-05 (notice rows render), 06-06 (queue UI), 06-11 (typing, presence, queue, Ask AI in this spec), 06-12 (dialog: teams, departments, org, levels, removal)]
tech-stack:
  added: []
  patterns:
    - "Owner-only UI follows AiChatDetail.viewerCan only (no client-side role logic)"
    - "List cache routing by AiChatSummary.access (absent = owner, Phase 5 producers)"
    - "Fake model answers attributed prompts from the P-06 tags, so e2e asserts who the model was told it answers"
key-files:
  created:
    - infra/fake-model/attribution.mjs
    - infra/fake-model/attribution.test.mjs
    - apps/web/lib/ai-grant-queries.ts
    - apps/web/lib/ai-chat-list-cache.test.ts
    - e2e/tests/ai-chat-multiplayer.spec.ts
    - .planning/phases/06-multiplayer-ai-chat/deferred-items.md
  modified:
    - infra/fake-model/{fake-responses.mjs,fake-responses.test.mjs,server.mjs,server.test.mjs,Dockerfile}
    - apps/web/lib/ai-chat-queries.ts
    - apps/web/components/ai-chat/{share-dialog.tsx,ai-chat-view.tsx,ai-chat-header.tsx,ai-message.tsx}
    - apps/web/components/chat/ai-chats-section.tsx
    - e2e/support/ai-chat.ts
decisions:
  - "The level picker is a two-option radio group (Can chat / Can view), not a select: one tap at 390, getByRole('radio') in e2e"
  - "A grantee's header hides the ⋯ menu entirely when nothing in it is theirs; the title is plain text without ai_chat.manage"
  - "In a shared chat every human turn carries avatar + name; the reader's own turns stay right, others' go left"
  - "Shared with me rows show no 'Answering' dot: grantees never receive the finalize ai_chat.updated (API gap, deferred-items)"
  - "The snapshot-link section's lock note now reads 'Messages sent later are not included, and the link gives no access to the chat itself' (the old 'stays private to you' is false once a chat is shared)"
metrics:
  duration: "~95 min"
  completed: 2026-10-07
actuals:
  tokens: 18000   # chars/4 over the added lines of the diff (71 875 chars, screenshots excluded)
  tasks: 2
  commits: 4
---

# Phase 6 Plan 03: Browser tracer — share in place, Scenario B steps 1–4 Summary

In the browser, Víctor shares a private AI chat with Alex from a dialog that lists exactly what becomes visible. Alex finds it under "Shared with me". Both write, and the fake model answers each of them by name with the participant list (`Hi Alex Kim! (participants: Alex Kim, Víctor Ruiz) Echo: …`), live on both pages, at 1440 and 390. Grantees start on their own model. A view grant is read-only. Owner-only actions are invisible to grantees.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | Scenario B in the browser (tracer): fake attribution, People section, Shared with me, attributed turns | 467a91f (fake), 0f52655 (web + e2e) |
| 2 | Grantee defaults: own model, read-only Can view, no owner-only actions, dialog at 390 / dark | da8b138 |

## What changed

- **Fake model (P-06, P-12).** `attribution.mjs` reads `<participants>` (names from `name="…"`, agents excluded), the last `<turn_context>` (`responding_to`, `notice`, `withheld`) and the last real `<message>` block. A neutralised `< message` stays text. `attributedReply` returns null unless both blocks are present. The Responses route, chat completions (system/developer messages) and Anthropic (`system`) call it before their Phase 5 reply. Titles, `[[call]]` tool steps, `[[slow]]`, `[[plan:*]]`, citations and `[images:N]`/`[files:N]` are unchanged. The Dockerfile copies the module, and `server.mjs` imports it optionally, like its other modules.
- **Share dialog (MULTI-01, P-13).**
  - "People and teams": member search by name or email over `GET /api/v1/members` (active members, not the viewer), a Can chat / Can view radio group and a Share button.
  - The P-13 disclosure is verbatim. The billing sentence shows only for Can chat.
  - "Who has access" lists the owner and each person grant.
  - "Read-only link (frozen copy)" is the Phase 5 flow (same test ids and audience sentence).
  - The People section needs `ai_chat.share`. No public link anywhere.
- **Lists.**
  - `useAiChats` takes a scope (`mine` by default, so Phase 5 callers are unchanged), and `useSharedAiChats` is added.
  - `applyAiChatUpdated` puts summaries whose `access` is `chat`/`view` in `aiKeys.shared` only, so a grant never leaks into the grantee's own list (unit test, 3 cases).
  - The sidebar shows "Shared with me" (up to five rows, owner name on a second line) only when it has rows. It updates live from the grant's `ai_chat.updated`.
- **Turns.**
  - `AiChatPeopleContext` (viewer id plus `detail.shared`): in a shared chat every human turn shows a `PrincipalAvatar` and the display name. The reader's turns stay right-aligned; others' turns align left.
  - Private chats render exactly as in Phase 5.
  - `authorKind: "system"` rows render as a quiet centered line (`ai-notice`).
- **Grantee safety (D-01, P-04, T-06-03-01).**
  - Non-owners get `preferred = [own defaultRef]`, never the chat's `lastModel`.
  - Without `ai_chat.use` there is no composer, drop zone or regenerate. A notice says "You can view this chat. Ask <owner> for chat access to write."
  - Rename/Archive/Settings need `ai_chat.manage`, and Share needs `ai_chat.share`. The menu disappears when it would be empty.
  - Grantees see "Shared by <owner>" under the title, truncated at 390.

## Verification

- `node --test` on the three fake suites: 75/75 (12 new in attribution.test, 5 new in fake-responses.test, 3 new in server.test). The new tests were run first and 7 failed (module missing, routes unchanged).
- `vitest --project web lib/ai-chat-list-cache.test.ts`: 3/3.
- Isolated e2e, Task 1: `--rebuild-web ai-chat-multiplayer ai-chat.spec ai-chat-share` passed 17/17 on desktop and mobile, with no flakes.
- Task 2 RED: the Task 2 test ran against the Task 1 build and failed (composer still shown to a view grantee).
- Isolated e2e, Task 2 plus the ai-chat regressions: `--rebuild-web ai-chat-multiplayer ai-chat-models ai-chat-list ai-chat.spec ai-chat-share` passed 33/33 on desktop and mobile, with no flakes (setup 1, multiplayer 4, models 8, list 6, share 8, ai-chat 6).
- `pnpm verify`: exit 0. Lint shows the 4 local-runtime warnings that were already there; typecheck 8/8; 173 files and 2374 tests passed.
- Acceptance checks:
  - `export function attributedReply` and `attribution.mjs` in the Dockerfile: both found.
  - `Read-only link (frozen copy)` in share-dialog.tsx: found.
  - `multiplayer-two-people-390*.png`: 4 files.
  - `ai_chat.manage` in ai-chat-view.tsx / ai-chat-header.tsx: 2 / 3 lines.
  - `multiplayer-view-only-*.png`: 4 files.
- Screenshots (22, all reviewed with Read; light and dark, 1440 and 390): `multiplayer-share-dialog-*`, `multiplayer-share-dialog-disclosure-*`, `multiplayer-shared-with-me-*`, `multiplayer-two-people-*` (owner and `-alex`), `multiplayer-view-only-*`. Captures made by the Phase 5 regression specs in the same run were deleted, not committed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Shared chats would have entered the grantee's own chat list**
- **Found during:** Task 1. `applyAiChatUpdated` put every `ai_chat.updated` into the "mine" lists, and the API now sends one to the grantee on a grant or a send.
- **Fix:** route summaries by `access`, with a unit test.
- **Files:** lib/ai-chat-queries.ts, lib/ai-chat-list-cache.test.ts
- **Commit:** 0f52655

**2. [Rule 1 - Bug] A stale "Answering" dot on Shared with me rows**
- **Found during:** review of the Task 1 screenshots.
- **Issue:** the run loop's finalize `ai_chat.updated` goes to the owner only, so a grantee's row kept `generating: true` after their own send.
- **Fix:** shared rows no longer show the dot. The API fan-out is recorded in deferred-items.md (run-loop/titles belong to other plans).
- **Commit:** da8b138

**3. [Rule 2 - Correctness] Owner-only UI hidden in Task 1, not Task 2**
- Task 1's behaviour list already asserts that Alex has no Rename/Archive/Settings/Share. The `viewerCan` gating of the header and menu therefore landed in Task 1. Task 2 added the model default, the read-only notice and the caption.
- **Commit:** 0f52655

**4. [Rule 2 - Correctness] A view grantee gets no regenerate, no drop zone, and no Unarchive on an archived chat**
- Without `ai_chat.use` (or `ai_chat.manage` for Unarchive) the API refuses these actions. Hiding them keeps the UI from offering actions that would only fail.
- **Commit:** da8b138

**5. [Note] Snapshot-link copy**
- The lock note "the chat itself stays private to you" became "the link gives no access to the chat itself", because the old sentence is false for a shared chat.
- The Create link button became outline: Share is the primary action in the dialog.
- No Phase 5 spec depends on either; ai-chat-share passed 8/8 and ai-chat.spec 6/6.

**6. [Note] Task 2 e2e also asserts the Phase 5 regressions**
- The Task 2 harness run included `ai-chat.spec` and `ai-chat-share` besides the plan's `ai-chat-models ai-chat-list`, so one build covered the plan's verify and the regression run.

**7. [Note] Web TDD order**
- The list-cache unit test was written right after the routing change, not before it. On the old code it fails (`aiKeys.shared` does not exist).
- The e2e behaviours were written before the UI (Task 1). Task 2's RED was run.

## Known Stubs

None. Teams, departments, the organization, level changes and removal in the dialog belong to 06-12 by plan. Notice rows render, and 06-05 writes them.

## Threat Flags

None beyond the register. Mitigations in place:
- T-06-03-01: grantee `preferred` list, asserted in the e2e.
- T-06-03-02: P-13 text verbatim, asserted in the e2e.
- T-06-03-03: names render as text through `PrincipalAvatar` and React; bodies stay plain text, as in Phase 5 user turns.
- T-06-03-04: harness ports and the fake only.

## Open items for later plans (deferred-items.md)

- **API fan-out:** finalize, title and rename `ai_chat.updated` events reach the owner only. Grantees' list rows keep a stale `generating` flag and title (06-04/06-06).
- **Regenerate:** offered to every `ai_chat.use` viewer on the last answer. The API refuses non-requesters (403), so the UI could hide it using `generation.requesterUserId` (06-06/06-11).

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs, skipped tests or unrun verifies).

## Self-Check: PASSED

- Files exist: attribution.mjs, attribution.test.mjs, ai-grant-queries.ts, ai-chat-list-cache.test.ts, ai-chat-multiplayer.spec.ts, deferred-items.md, 22 `multiplayer-*` screenshots.
- Commits 467a91f, 0f52655 and da8b138 are on wt/06-03.
