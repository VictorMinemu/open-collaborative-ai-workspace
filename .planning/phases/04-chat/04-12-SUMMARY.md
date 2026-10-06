---
phase: 04-chat
plan: 12
subsystem: chat
status: complete
tags: [chat, attachments, upload, drag-and-drop, paste, lightbox, file-cards, garage, web]
requirements: [CHAT-12]
dependency_graph:
  requires: [04-01 (contracts, attachments table, P-05 delete), 04-04 (artifact module, presign/complete/download, linkAttachments, attachmentsForMessages), 04-10 (views wiring)]
  provides:
    - "POST /conversations/:id/messages links attachmentIds in the message transaction (409 attachment_not_linkable; 503 attachments_disabled without storage)"
    - "chat/service.ts withAttachments; hydrateViewer and the edit DTO carry attachments; message.created / message.updated payloads carry them"
    - "artifact objectStorageConfigured(env, secrets)"
    - "web: lib/upload.ts uploadAttachment + UploadHandle, lib/attachment-queries.ts useAttachmentsConfig"
    - "web: components/chat/attachments/{files,attachment-tray,attachment-grid,file-card,lightbox,drop-zone}"
    - "Composer: conversationId, attachments, onSend(body, attachmentIds, files), ComposerApi.addFiles, attachmentLimitsHint"
  affects: [04-13, Phase 12 (artifacts reuse the tray/grid), bots reading attachments (future)]
tech-stack:
  added: []
  patterns:
    - "Upload on add: presign → XHR PUT with the signed headers and progress → complete; abortable; send waits for every upload"
    - "Optimistic rows render the verified Attachment DTOs (API previews), no object-URL lifecycle beyond the tray"
    - "Drop target per pane hands files to the composer through ComposerApi.addFiles"
key-files:
  created:
    - apps/api/src/modules/chat/message-attachments.int.test.ts
    - apps/web/lib/upload.ts
    - apps/web/lib/attachment-queries.ts
    - apps/web/components/chat/attachments/files.ts
    - apps/web/components/chat/attachments/files.test.ts
    - apps/web/components/chat/attachments/attachment-tray.tsx
    - apps/web/components/chat/attachments/attachment-grid.tsx
    - apps/web/components/chat/attachments/file-card.tsx
    - apps/web/components/chat/attachments/lightbox.tsx
    - apps/web/components/chat/attachments/drop-zone.tsx
    - e2e/tests/attachments.spec.ts
  modified:
    - apps/api/src/modules/chat/{index,service,message-actions,dm-privacy.int.test}.ts
    - apps/api/src/modules/artifact/{index,storage,attachments}.ts
    - apps/web/components/chat/{composer,message-list,channel-view,dm-view,thread-panel}.tsx
decisions:
  - "Preview and large redirects send Cross-Origin-Resource-Policy: cross-origin (Chromium treats each IP:port as its own site, so helmet's same-site blocked every preview where web and API run on one IP)"
  - "DMs with a bot offer no files: bots read text only, and an attachment-only message would reach the bot as an empty prompt"
  - "Sending is blocked while any file uploads or failed; a refused file must be removed (or retried)"
  - "An edit keeps the files; message.updated carries them"
metrics:
  duration: "~45 min"
  completed: 2026-10-06
  tasks: 2
  files: 23
estimate:
  tokens: 180000
actuals:
  tokens: 27500
  tasks: 2
  commits: 2
---

# Phase 4 Plan 12: Attachments in chat Summary

Members can now drop, paste or pick files in channels, threads, DMs and group DMs. Each file uploads straight to Garage with a progress bar. Images show as webp previews (one large, or a 2-column grid with "+N") that open in a keyboard- and swipe-friendly lightbox. Other files show as cards with a download button. Everything arrives live. Deleting a message takes its files with it, and without storage the paperclip and drop zone never appear.

## What was built

- **API**
  - The POST message route passes `attachmentIds` to `postMessage`.
  - `postMessage` calls `linkAttachments` inside the message transaction, after the insert and before `message.created`, so the event already carries the files. Any file that cannot be linked returns 409 and rolls back the whole post.
  - The 04-01 `attachments_unavailable` guard is gone. Without storage, a post with `attachmentIds` gets 503 `attachments_disabled`.
  - Every page, `around` window, thread, pin list and saved list hydrates `attachments` in one batched query, through `withAttachments` in `hydrateViewer`. Tombstones carry none.
  - The edit DTO (PATCH response and `message.updated`) keeps the files.
- **Web**
  - `uploadAttachment` presigns, PUTs with XHR using exactly the signed headers and reporting progress, then calls complete. The upload can be aborted.
  - `useAttachmentsConfig` caches the config for 5 minutes.
  - `useAttachmentQueue` checks size, count and empty files before presigning, and maps server errors to readable text. A failed upload can be retried.
  - `AttachmentTray` shows image thumbnails or file chips, with progress, errors, retry and remove.
  - `DropZone` shows a "Drop files to share in #x" overlay with the limits. It also stops a dropped file from navigating the tab away.
  - `MessageAttachments` reserves each image's box from the stored dimensions, so the list does not jump while previews load.
  - Also added: `FileCard` (tinted icon per type family, name with a middle ellipsis, size, API download) and `Lightbox` (Base UI Dialog showing the large rendition, with prev/next, swipe, download, Escape, and full screen at 390).
  - The composer has the paperclip, a hidden `attach-file` input and the paste handler.
  - Channel, thread panel and DM views all wrap their pane in a `DropZone`.

## Verification

| Check | Result |
|---|---|
| `vitest --project integration chat/message-attachments.int.test.ts` | 12/12. Task 1: 3 RED (`attachments_unavailable`), then green; the CORP case was RED with the header removed. Task 2: green on the first run (see deviation 6) |
| `vitest --project integration chat/dm-privacy.int.test.ts` (real attachments) | 12/12 |
| `vitest --project web components/chat/attachments` | 13/13 (RED first: the module did not exist) |
| `pnpm typecheck` | 8/8 |
| `pnpm verify` task 1 / task 2 | exit 0: 137 files / 1881 tests; 137 / 1887 |
| e2e `attachments` (task 1) | 3/3 (setup + desktop drop + mobile picker) |
| e2e `attachments chat.spec chat-edit dms reactions-pins unread permalinks` (desktop + mobile, final tree) | 34 passed, 1 skipped (`attachments-api` on mobile, desktop-only by design since 04-04), none flaky |
| Acceptance greps | `linkAttachments` in service.ts; `onprogress` in upload.ts; `attach-file` and `clipboardData` in composer.tsx; `file-card` in file-card.tsx; `paste\|pdf\|thread` ×21 in attachments.spec.ts |

I reviewed the screenshots with the Read tool: `attachments-{upload,grid,lightbox,file-card}-{1440,390}[-dark]` and `attachments-error-{1440,390}`. The review led to three fixes:
- The lightbox backdrop went from 90% to 95% with a blur, because the UI behind it was too visible in dark mode.
- On phones the tray chips are narrower (`w-48`).
- A refused file now scrolls into view; at 390 the error chip had been off-screen.

The other specs' regression captures were restored and are not committed.

## Deviations from Plan

1. **[Rule 1] Previews were blocked in the browser.** Helmet sets `Cross-Origin-Resource-Policy: same-site` on every API response. Chromium treats `127.0.0.1:3290` and `127.0.0.1:4290` as different sites; a standalone probe confirmed this for IP hosts, while `localhost` is fine. As a result every `<img>` preview failed with `ERR_BLOCKED_BY_RESPONSE.NotSameSite`. The same would happen on a self-hosted install reached by IP.
   - **Fix:** only the `/preview` and `/large` 302 responses now send CORP `cross-origin`.
   - **Why it is safe:** the redirect has no body, the session cookie is SameSite=Lax, and the access check still runs on every request. All other responses keep `same-site`, and an int test asserts both.
   - **File:** `artifact/attachments.ts` (a 04-04 file). Commit d27a956.
2. **[Rule 2] DMs with a bot offer no files** (`attachments={!bot}`). Bots read text only, and an attachment-only DM would reach the bot as an empty prompt. People DMs and groups do offer files.
3. **[Interface] `onSend(body, attachmentIds, files)`.** The third argument is the list of verified `Attachment` DTOs, so the optimistic row shows the real API previews and a retry resends the same ids. `ComposerApi` gained `addFiles`, which the drop zones use. `attachments` is an extra composer prop.
4. **[Structure] Files outside the plan's list:**
   - `attachments/files.ts` + `files.test.ts`: pure helpers for sizes, names, limits, error text, icon families and image boxes.
   - `artifact/storage.ts` + `index.ts`: `objectStorageConfigured`.
   - `chat/message-actions.ts`: the edit DTO.
   - `chat/dm-privacy.int.test.ts`.
   - The thread panel also gained a `DropZone`, which the plan did not ask for.
   - `packages/contracts/src/attachments.ts` was **not** changed; no contract change was needed.
5. **[e2e] Accounts and channel.** The spec uses a fresh `design-…` / `files-…` channel instead of `#general`, and the admin (Víctor) plus Sam instead of "Ada", for isolation between projects and runs. On mobile the thread is opened through `?thread=`. Deletion is checked live in the DM, where Sam's page drops the image and the download returns 404.
6. **[TDD] The Task 2 integration cases passed on their first run.** Task 1's linking, its edit DTO and 04-01's delete already covered them. To confirm the tests check something real, I removed the attachment hydration from the edit DTO, the edit case failed, and I restored it.
7. **[Behaviour] Sending is blocked while any file is uploading or has failed.** The plan says an oversized file "cannot be sent". Rather than silently drop a refused file, the member has to remove it (or retry it).

### CLAUDE.md
- No migration, no permission or policy change, and no RLS change. The CORP change and its threat reasoning are in deviation 1.
- `.env` was symlinked only for the isolated e2e and has been removed; I never read it. The demo, its ports, its database and OpenClaw were never touched. The only compose lifecycle was the harness's own `ocw-e2e-storage`.

## Known Stubs

None. `MessageAttachments` in a pending row gets a no-op `onOpenImage` on purpose: a message that is still sending cannot be opened.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: header-policy | apps/api/src/modules/artifact/attachments.ts | `/attachments/:id/{preview,large}` 302s send CORP `cross-origin` (body-less redirect, access-checked, SameSite=Lax session) |

Threat register coverage:
- **T-04-12-01:** `linkAttachments` returns 409 for another member's file, a reused file, a pending file or another conversation's file; a mixed request rolls back; org B gets 404.
- **T-04-12-02:** the page only shows the webp renditions; originals are reachable only through the `attachment`-disposition download; file cards never embed content.
- **T-04-12-03:** after a delete, preview, large and download return 404 for the author, members and admins (int test plus a live e2e check).
- **T-04-12-04:** limits are checked in the client and on the server (25 MiB, 10 per message, presign rate limit).
- **T-04-12-05:** image URLs are the DTO's API path joined to the configured API base.

## Open issues

- Bots cannot read attachments yet, so files are hidden in bot DMs. A later bot-capability plan should give bots attachment context.
- All files in the tray upload at once (at most 10). There is no multipart or resumable upload for 25 MB files on slow links.
- Search results and the Mentions inbox do not show attachment chips.
- Pre-existing, not from this plan: on phones a long composer placeholder wraps to two lines.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows fixed 20
gsd windows fixed 34
gsd windows append --kind deviation --phase 04 --file apps/api/src/modules/artifact/attachments.ts --description "04-12: attachment preview/large redirects send CORP cross-origin (Chromium treats IP:port as separate sites; helmet same-site blocked previews)"
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/dm-view.tsx --description "04-12: DMs with a bot offer no attachments until bots can read files"
```

## Commits

- d27a956 feat(chat): drop an image on a channel, watch it upload, send it; members see the preview live and open it in a lightbox (04-12 task 1)
- 5525543 feat(chat): paste, files and errors in channels, threads, DMs and groups; deleted messages take their files with them (04-12 task 2)

## Self-Check: PASSED

All created files exist; commits d27a956 and 5525543 are on wt/04-12.
