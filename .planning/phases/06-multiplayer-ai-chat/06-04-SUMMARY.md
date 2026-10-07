---
phase: 06-multiplayer-ai-chat
plan: 04
subsystem: api (ai-chat, chat, search, artifact)
status: complete
tags: [multiplayer-ai, grants, units, revocation, realtime, search, attachments, tenant-isolation]
requires: [06-01 contracts + migration, 06-02 person grants + aiAccessSql + guards]
provides:
  - "Unit (subtree) and organization grant subjects through one aiGrantMatchSql used by aiAccessSql and matchingGrant"
  - "PATCH /api/v1/ai-chats/:id/grants/:grantId (level) and DELETE (revoke → 204), owner only, 404 otherwise"
  - "Participant re-decision after a level change or revoke (removeMember for those who lost the chat)"
  - "ai_chat.access_changed subscription invalidator on conv: topics (live revocation, ADR-0009)"
  - "noticeOf / postNotice: system notice rows streamed as message.created (06-10 reuses postNotice)"
  - "Audits ai_chat.grant_created / grant_updated {from,to} / grant_revoked, ids and levels only"
  - "AI chat title search over the readable set with access/owner/shared; files follow grants"
affects: [06-03 (share dialog shows unit/org labels), 06-05 (notice rendering), 06-08 (inbox/unread over grants), 06-10 (postNotice for agents), 06-12 (team/department/org share UI)]
tech-stack:
  added: []
  patterns:
    - "One SQL fragment (aiGrantMatchSql, alias ag) decides who a grant covers; access and send context share it"
    - "Access changes announce on conv:<id> with an invalidator that re-decides every live subscriber of that stream"
key-files:
  created:
    - apps/api/src/modules/ai-chat/grants.int.test.ts
  modified:
    - apps/api/src/modules/ai-chat/grants.ts
    - apps/api/src/modules/chat/{service.ts,index.ts}
    - apps/api/src/modules/ai-chat/{dto.ts,index.ts,multiplayer.int.test.ts,attachments.int.test.ts}
    - apps/api/src/modules/search/{service.ts,index.ts,search.int.test.ts}
    - apps/api/src/modules/artifact/attachments.ts
decisions:
  - "A unit grant covers every unit on the user's membership paths (department → its teams and projects); an org grant covers active org_members only"
  - "matchingGrant picks chat over view, then person > unit > org, then the oldest, so ai_message_context names one grant deterministically"
  - "Notice text keeps names on one line (whitespace collapsed); mentions only for person subjects"
  - "A person subject hears its NEW access after any change (a revoked person still covered by an org grant gets 'view', not null)"
  - "The advisory grant lock is taken only by writes (POST/PATCH/DELETE), not by GET"
metrics:
  duration: "~70 min"
  completed: 2026-10-07
actuals:
  tokens: 14250   # chars/4 over the added lines of the diff (56 990 chars)
  tasks: 2
  commits: 2
---

# Phase 6 Plan 04: Team, department and organization grants with live revocation Summary

The owner shares the same AI chat with a team, a department (covering its subtree) or the whole organization at Can chat or Can view, changes the level and revokes; a revoke drops participation rows and closes the grantee's open `conv:` stream in tens of milliseconds, every change is a server-written notice line plus an ids-only audit, and search and files follow exactly the same access.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Unit/org grants, PATCH/DELETE, participant re-decision, invalidator, notices, audits (tracer) | 133dc3e |
| 2 | Search and attachments follow grants | 0b19b0f |

## What changed

- **Access (P-03).** `aiGrantMatchSql(userId)` (chat/service.ts): person = `subject_id`; unit = `subject_id = any(org_units.path)` over the user's `unit_memberships`; org = an active `org_members` row of the grant's organization. `aiAccessSql` uses it for both levels (owner first, chat beats view); `matchingGrant` uses it for the send context. No other module computes AI chat access.
- **Grants (D-03, P-09).** POST accepts `{kind:"unit", id}` (an `org_units` row under tenant RLS, else 404 `Unit not found`) and `{kind:"org"}`; labels are the unit name + `unitKind` and "Everyone at <org>"; same-subject repeats return the active grant (200), a different level updates in place. Unit/org grants write no participation rows and notify nobody individually: one ids-only `ai_chat.access_changed {conversationId, access: null}` on `org:<id>`. PATCH changes the level (audit `{from, to}`), DELETE sets `revoked_at/revoked_by` (204; unknown or revoked → 404). After a level change or revoke every non-owner human participant is re-decided with `access.isReadable(kinds ["ai_chat"])` and removed when they lost the chat.
- **Live revocation (ADR-0009).** One `registerSubscriptionInvalidator(EventTypes.aiChatAccessChanged, …)` returns `{topics: [conv:<id>]}`; every grant change appends that event on `conv:<id>`, so every live subscriber is re-decided by the `conv` authorizer. Measured revoke → `revoked` frame: 36 ms (bound 1000 ms). Removing someone from the unit closes the stream through the existing `units.updated` invalidation.
- **Notices.** `postNotice` writes `messages(author_kind 'system', author_id null, client_kind 'system')` at the next `conv:` seq and appends `message.created` with the AI chat DTO; bodies from `noticeOf`: "Víctor Ruiz shared this chat with Backend · Can chat", "… changed Backend to Can view", "… removed access for Backend". `loadTurn` and regenerate already skip system rows, so notices never reach the model.
- **Search (T-06-04-04).** `searchAiChats` no longer narrows to `owner_user_id = viewer`; candidates are exactly the readable ids, and each summary carries `access`, `owner` (`ownerAuthor`) and `shared` (`sharedSql`), the AI chat list's helpers (exported from the ai-chat index). Message search already ran over the readable set (tests only).
- **Attachments.** Reads already followed the readable set. An upload into an AI chat by a view grantee now answers 403 `ai_chat_view_only` (as the chat's send route), every other denial stays a hidden 404 (see deviation 2).

## Verification

- `grants.int` (fresh PostgreSQL + Redis, fake model): 15/15. RED first: 14 failed before the implementation.
- `multiplayer.int`: 17/17 (person grants unchanged; one validation case updated, deviation 1).
- `search.int`: 30/30 (RED: the 2 grantee cases failed first). `attachments.int` (+ Garage): 16/16 (RED: the view-grantee upload returned 404).
- `pnpm typecheck --force`: 8/8. `pnpm verify`: exit 0, lint clean (the 4 local-runtime warnings already there), 173 files / 2390 tests passed.
- Acceptance greps: `subject_kind = 'unit'` in chat/service.ts, `registerSubscriptionInvalidator` and `export function noticeOf` in grants.ts all print. The search grep prints 1, not 0 (deviation 3).
- E2E: this plan defines none (06-VALIDATION rows 06-04-01/02 are integration only). The optional regression run was not done: creating the `.env` symlink for `scripts/e2e-isolated.sh` was denied by the permission system.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Planned behaviour change] multiplayer.int asserted that unit/org subjects answer 400 `grant_subject_unsupported`**
- That was 06-02's placeholder. The case now asserts an unknown unit → 404; the org subject moved to grants.int (granting it there would have let the admin read the chat in later 06-02 cases).
- **Commit:** 133dc3e

**2. [Rule 1 - Bug] AI chat uploads hid `ai_chat_view_only` as 404**
- **Found during:** Task 2 (attachments.int, view grantee upload).
- **Issue:** `POST /conversations/:id/attachments` decided `ai_chat.use` with `hideAs404`, so a view grantee, who can read the chat, got 404 instead of the plan's 403 `ai_chat_view_only`.
- **Fix:** in the artifact module only (as the plan allows): rethrow `ai_chat_view_only` visibly, every other denial as a hidden 404, mirroring `writableChat`. Outsiders, the admin and revoked grantees still get 404 (tested).
- **Files:** apps/api/src/modules/artifact/attachments.ts. **Commit:** 0b19b0f

**3. [Note] Task 2's acceptance grep counts 1 instead of 0**
- The remaining `owner_user_id = ` line is `searchPeople`'s candidate narrowing for personal BOTS (`a.scope = 'team' or a.owner_user_id = viewer`, then `bot.read`), unrelated to AI chats. The AI chat narrowing is gone. Changing the bot query only to satisfy the grep was out of scope.

**4. [Note] Test cast**
- search.int reuses that file's fixture: the owner is Olive (standard), the grantee Alex, the admin Ada, the no-grant member a fresh "Nia" (Sam is near the 30/min search budget there). attachments.int's owner is the file's admin Víctor; Ada is the no-grant admin.

**5. [Note] CLAUDE.md plan mode for permission changes**
- Implemented as specified by D-03/P-03/P-09 under the owner's delegated approval, without an interactive plan-mode step.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: T-06-04-01 … 06 are mitigated and tested (revoke closes the stream within the bound, foreign and unknown unit ids 404 with no row, Jo/Riley/Robin/Sam subtree matrix, search/files for grantee/outsider/admin/revoked, notices + audits, no participation rows or per-member events for unit/org grants).

## Open items for later plans

- A grant change's own events (its notice and `ai_chat.access_changed`) reach the revoked subscriber just before the `revoked` frame: they are committed in the same transaction and fan out before the re-decision, like a channel `member_removed`. Nothing appended after it reaches them (tested).
- Removing someone from a unit (units API) closes their stream and 404s them, but leaves their participation row if they had written. Rows never decide access; the prompt roster lists them with `access` null until a grant change re-decides participants. 06-08/06-12 may want the `units.updated` path to re-decide participants too.
- 06-03/06-05/06-12 must render `authorKind: "system"` notice rows in AI chats (the API streams and returns them now).

## Broken-windows ledger

`gsd windows`: nothing to append (no stubs or skipped tests; the plan has no e2e verify).

## Self-Check: PASSED

- Files exist: grants.ts, grants.int.test.ts, this SUMMARY.
- Commits 133dc3e and 0b19b0f are on wt/06-04.
