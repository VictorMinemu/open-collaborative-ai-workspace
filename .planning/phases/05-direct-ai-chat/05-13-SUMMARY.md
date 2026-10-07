---
phase: 05-direct-ai-chat
plan: 13
subsystem: ai-chat
tags: [share, snapshot, read-only, tenant-isolation, attachments, audit]

requires:
  - phase: 05-direct-ai-chat
    plan: 12
    provides: owner-only AI chat attachments, attachmentRowsForMessages, AI chat drafts
  - phase: 05-direct-ai-chat
    plan: 01
    provides: ai_chat_shares table (RLS), AiChatShare/AiShareView contracts, ai_chat.share / ai_chat.share.read
provides:
  - "ai-chat/shares.ts: snapshotOf, registerShareRoutes (create, list, revoke, view, share-scoped files)"
  - "POST/GET /ai-chats/:id/shares, DELETE /ai-shares/:shareId, GET /ai-shares/:shareId, GET /ai-shares/:shareId/attachments/:attachmentId/{preview,large,download}"
  - "artifact: presignAttachmentPart, attachmentRowsByIds (Phase 4 routes reuse presignPart, unchanged)"
  - "web: /share/ai/[shareId] inside the signed-in app, ShareView, ShareDialog (create, copy, revoke with confirm), Share in the chat header menu"
  - "audits: ai_chat.share_created, ai_chat.share_revoked, ai_chat.share_viewed; attachment.downloaded with shareId"
affects: [05-14, 05-15]

tech-stack:
  added: []
  patterns:
    - "Snapshot = bodies and file metadata copied once into jsonb {v:1, messages}; URLs are built at read time from the share id"
    - "Share reads: requireUser → ai_chat.share.read (hidden 404) → row under tenant RLS → revoked_at; every miss is the same 404 body"
    - "Share files: share readable → id ∈ attachment_ids → ready in the same conversation → presign; the chat's own attachment ACL is never widened"

key-files:
  created:
    - apps/api/src/modules/ai-chat/shares.ts
    - apps/api/src/modules/ai-chat/shares.int.test.ts
    - apps/web/app/(app)/share/ai/[shareId]/page.tsx
    - apps/web/components/ai-chat/share-view.tsx
    - apps/web/components/ai-chat/share-dialog.tsx
    - apps/web/lib/ai-share-queries.ts
    - e2e/tests/ai-chat-share.spec.ts
  modified:
    - packages/contracts/src/ai-chat.ts
    - apps/api/src/modules/ai-chat/index.ts
    - apps/api/src/modules/artifact/index.ts
    - apps/api/src/modules/artifact/attachments.ts
    - apps/web/components/ai-chat/ai-chat-view.tsx

key-decisions:
  - "Snapshots keep user turns plus answers whose latest generation is completed, stopped or interrupted with text; running, failed and empty answers are left out (the question stays)"
  - "Viewing a share is audited (ai_chat.share_viewed {shareId, conversationId}) as the brief requires; renditions stay unaudited like Phase 4"
  - "Revoke decides on the creator's own chat (readable set), not on ai_chat.share, so a member whose share permission was removed can still withdraw a link"
  - "An empty chat cannot be shared (409 share_empty); share creation is rate-limited to 30/min per member"

requirements-completed: [AICHAT-09]

duration: 95min
completed: 2026-10-06
status: complete

actuals:
  tokens: 19200   # chars/4 over the added lines of the realized diff (screenshots excluded)
  tasks: 3
  commits: 9
---

# Phase 5 Plan 13: Read-only snapshot share links Summary

**The owner of an AI chat chooses Share in the header menu. The dialog says "Anyone signed in to <org> with the link can read this snapshot. It is never public." and creates a `/share/ai/<id>` link to copy. A colleague signed in to the same organization reads the chat exactly as it was, with "Shared by Sam · date" and "Snapshot — later messages are not included". The id alone grants nothing. Signed out, the visitor goes to sign-in (API 401). Another organization, a deny rule, a revoked link and a random id all get the same 404. Images in the snapshot load only through the share's own routes, and only the snapshot's files. The chat itself stays owner-only.**

## Accomplishments

- **API (Task 1, tracer):**
  - `snapshotOf` copies the visible turns once: non-deleted top-level messages in seq order, the model label from the latest generation, and each user turn's ready files (metadata only) plus the `attachment_ids` allow-list.
  - Create: readable chat + `ai_chat.share` on the chat (owner only, hidden = 404), 30 per minute.
  - List: owner only. View: `requireUser` + `ai_chat.share.read`, with the row read under tenant RLS.
  - Missing, revoked, other-org and denied all return the same `{code: not_found, message: "This link isn't available"}`.
  - Audits carry ids and the count only.
- **Revoke (Task 2):** `DELETE /ai-shares/:id` works for the creator only (anyone else, admins included, gets 404). It is idempotent, audits once, and reads as not found at once everywhere, the files included. The dialog has Revoke with an in-place confirm, and a revoked link stays listed, struck through.
- **Files (Task 3):** `/ai-shares/:shareId/attachments/:attachmentId/{preview,large,download}` returns a 302 to a presigned GET.
  - Headers: `private, no-store`, plus CORP `cross-origin` on renditions, as the chat routes do.
  - Download is audited as `attachment.downloaded {attachmentId, conversationId, shareId}`.
  - `presignAttachmentPart` and `attachmentRowsByIds` are exported from artifact. The Phase 4 routes call the same `presignPart` with an identical TTL, type and disposition.
- **Web:**
  - `ShareView` lays the snapshot out like the chat: right-aligned bubbles, answers through `<Markdown>`, a model label, the Phase 4 grid and lightbox on share URLs, a Read-only badge, and no composer.
  - The not-available state offers "Go to your AI chats".
  - `ShareDialog` uses the Dialog primitive: centered on desktop, a bottom sheet at 390.

## Task Commits

1. **Task 1 (tracer):** `b3d3224` test RED · `427c881` feat(api) · `45ddd9d` feat(web) + e2e + screenshots
2. **Task 2:** `59e68b1` test RED (int + e2e) · `738e127` feat (api + web)
3. **Task 3:** `409a192` test RED (int + e2e) · `3f2d168` feat(api) · `7585aef` feat(web) + screenshots

## Verification

- **Integration** (ephemeral PostgreSQL + Redis + Garage):
  - `shares.int.test.ts` passes 14/14.
  - RED was seen first each time: 3/7, 2/9 and 2/14 failed on the missing routes.
  - Regressions: `artifact/attachments.int` 25/25 (Phase 4 unchanged), `ai-chat/attachments.int` 15/15.
- **`pnpm typecheck --force`:** 8/8 after the contract change.
- **`pnpm verify`:** exit 0 after Task 1 (170 files, 2298 tests) and after Task 3 (170 files, **2305 tests**). The 05-12 baseline was 169 files and 2291 tests. Lint shows the 4 pre-existing local-runtime warnings.
- **Isolated e2e:**
  - Task 1 `--rebuild-web ai-chat-share ai-chat.spec`: 11/11.
  - Task 2 `--rebuild-web ai-chat-share`: 7/7.
  - Task 3 `--rebuild-web ai-chat-share attachments.spec` (ai-chat-attachments also matched): 17/17.
- **Full regression** (`ai-chat attachments`: every ai-chat-* spec plus attachments and attachments-api, desktop and mobile):
  - Run 1: `ai-chat-plan-errors` failed on mobile, at the "dialog opens once" check after a reload. It passed 15/15 on a rerun on its own.
  - Run 2: **77 passed, 1 skipped** (attachments-api on mobile, by design). The one failure was the known `ai-chat-stop` transient "streaming" check, already noted in 05-12, and it passed 7/7 on a rerun.
  - Neither spec touches shares.
- **Acceptance greps:**
  - These lines exist: `"/ai-shares/:shareId"`, `export function registerShareRoutes`, `revoked_at|revokedAt` (6 lines), `export async function presignAttachmentPart` and `/ai-shares/:shareId/attachments/:attachmentId`.
- **Screenshots reviewed with Read:** `ai-share-dialog-{1440,390}[-dark]`, `ai-share-view-{1440,390}[-dark]`, `ai-share-revoked-{1440,390}`, `ai-share-image-{1440,390}`.
  - Human check: the snapshot reads like the chat, is clearly read-only, and states who shared it and when.
- **Safety:**
  - No migration was added, and `pnpm db:migrate` never ran.
  - No real provider was called. The demo was not touched.
  - `.env` was symlinked only for the isolated e2e and has been removed.
  - The regression screenshots were reverted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Contract] `AiShareAttachment` gains `size` and `largeUrl`.** The Phase 4 file card needs a size and the lightbox needs a large rendition URL, and the plan's routes include `/large`. Both fields were added. `pnpm typecheck --force` is green.

**2. [Rule 3 - Signature] Helper signatures differ from the interfaces block.**
- `snapshotOf(tx, chatId, gateway)`: model labels come from `generationsFor`, which needs the gateway.
- `presignAttachmentPart(storage, row, part)`: the object store lives on the artifact module, not on `Core`.
- `registerShareRoutes(app, {core, gateway, storage})`.

**3. [Rule 2 - Correctness] Revoke needs a resolver decision.** Strict authz refuses a 2xx that has no decision, so revoke decides through the creator's own chat (readable set) and not through `ai_chat.share`. That way revoking always stays possible.

**4. [Brief] Views are audited.** The brief asks to audit create, revoke and view. `ai_chat.share_viewed {shareId, conversationId}` is recorded on every snapshot read; the plan only listed create and revoke.

**5. [Scope] Behaviour choices.**
- Stopped and interrupted answers with text are kept, like completed ones.
- An empty chat cannot be shared (409 `share_empty`).
- Share creation is limited to 30 per minute per member.
- A share file must also belong to the share's own conversation (defence in depth on top of the allow-list).

**6. [Files outside `files_modified`]**
- `ai-chat-view.tsx`: that is where `extraMenuItems` is passed. `ai-chat-header.tsx` needed no change.
- `packages/contracts/src/ai-chat.ts`.

**7. [TDD notes]**
- The e2e RED runs were not separate builds; they ran as part of each task's `--rebuild-web` run.
- The Task 1 int file temporarily set aside the Task 2 cases for Task 1's `pnpm verify`. They were then committed as their own RED commit.

## Known Stubs

None.

## Open issues

- Every snapshot read writes a `ai_chat.share_viewed` audit row. There is no dedupe window, so a busy link writes one row per load.
- Snapshot images stay viewable while the original files exist. Deleting the chat cascades its shares; there is no per-file purge for shares.
- The share page sits outside the chat layout, so there is no chat sidebar on it (the app rail and mobile top bar remain).

## Threat Flags

No surface beyond the plan's threat model. Each threat has a test:
- T-05-13-01: anonymous 401, other org 404, deny rule 404, no token in the path.
- T-05-13-02: later messages, a regenerate and a rename don't move a snapshot; a later and a random file are 404 through the share.
- T-05-13-03: Alex and the admin can't create, list or revoke.
- T-05-13-04: missing, revoked, other-org and denied share one identical 404 body.
- T-05-13-05: created, revoked and viewed are audited, and so are share downloads.

## Windows Ledger

`gsd windows append --kind deviation --phase 05 --file apps/api/src/modules/ai-chat/shares.ts --description "05-13: every share view writes an ai_chat.share_viewed audit row (no dedupe window)"`

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found on wt/05-13: b3d3224, 427c881, 45ddd9d, 59e68b1, 738e127, 409a192, 3f2d168, 7585aef.
