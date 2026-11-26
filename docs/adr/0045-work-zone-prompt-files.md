# ADR-0045: A Work Zone prompt carries any file, copied into the working tree before the turn

## Status

Status: Accepted. **Date:** 2026-11-25. **Deciders:** Víctor Ruiz (Autofy Labs). An urgent fix from the owner,
testing on production, quoted as said:

> "no me permite subir cualquier archivo, la gracia es poder subir de todo"

(It does not let me upload any file; the whole point is being able to upload anything.) The composer refused every
non-image with "Only images (PNG, JPEG, GIF, WebP) can be sent to a session", mirrored by the API's 400 `images_only`.

**Supersedes, without editing them,** these rules of Phase 06.1 (recorded in its plans and in `docs/DEMO.md`, not in an
ADR): the session's attachment scope accepts only the four inline image types (`images_only`); a prompt links only
sniffed images with renditions, at most four; a model that cannot read images refuses an image prompt at submit
(`images_not_supported`). Everything else of 06.1 stays: the upload pipeline, the inline image budget (2 MiB as sent,
`image_too_large`), the order, the previews and the slash-command guard.

**Builds on:** [ADR-0041](0041-bot-session-file-exchange.md) (the transfer, the ledger, the deny list, the limits) and
[ADR-0015](0015-object-storage-garage.md) (the API is the only ACL; the device never gets a presigned URL).

## Context

People attach specs, notes, logs, CSVs and documents to ask a Work Zone runtime about them. Claude Code and Codex read
images inline, but every other file they read from disk. ADR-0041 already moves a chat attachment into a session's
working tree for a bot, over HTTP with the device JWT, with one deny list and a per-file limit. A second transfer path
would duplicate all of that.

## Decision

1. **Any file joins a prompt.** The session's attachment scope accepts every type; `linkWorkPromptAttachments` links
   any of the sender's own ready uploads of the session's conversation, at most 10 (`WORK_PROMPT_MAX_ATTACHMENTS`).
   The person sending the prompt is the actor: another member's upload, another session's, another tenant's or an
   already linked one is the one 409 `attachment_not_linkable`.
2. **Images the model reads stay inline** (the first `WORK_PROMPT_MAX_IMAGES` = 4). Every other file, an image the
   model cannot read, and an image past the inline cap is a **prompt file** (`promptAttachmentRoutes`, decided at
   submit for the checks and again at dispatch for the model the turn runs).
3. **Destination:** `.ocw/uploads/<name>` in the session's working tree (`WORK_PROMPT_UPLOADS_DIR`), not on the deny
   list. The name is the attachment's sanitised name made safe for every volume (`promptFileName`). The device takes
   the first free name (`spec.pdf`, `spec-1.pdf` … at most 100 tries, `promptFileCollisionPath`) and never overwrites.
4. **The transfer is ADR-0041's.** At dispatch, one `to_device` row of `bot_work_session_files` per file, owned by the
   prompt (`work_prompt_id`; `agent_id` and `event_id` null, `bot_work_session_files_owner_ck`), with the attachment's
   size and sha256 and the path's length only, expiring after the longest transfer deadline (10 minutes, so a turn
   held at the runtime's update gate still finds its files). The `prompt` command lists `files` (transfer id, path,
   size, sha256; never bytes or a URL); the daemon fetches each one from `GET /api/v1/runtime/files/:id` with its
   device JWT, checks size and sha256, re-decides the deny list on the real path and lands it.
5. **Before the turn, or not at all.** The daemon lands every file (only between turns, principle 4), then appends the
   note and hands the prompt to the adapter. A file that does not land removes the ones this prompt landed and fails
   the prompt with one sentence naming the file ("Could not copy spec.pdf into the working tree (the disk is full).
   The prompt was not run."), which the session shows as its last error.
6. **The note is structural.** The device appends `Attached files (in the working tree):` and one `- <path>` line per
   file after a blank line (`withPromptFilesNote`), for Claude Code and Codex alike. The person never types it, and the
   prompt shown to people stays their own text, as ADR-0019's attributed blocks.
7. **Limits are refused at submit, per file:** over min(the organization's "Largest file a bot moves",
   `OCW_ATTACHMENT_MAX_BYTES`) → 400 `file_too_large` ("<name>: Over the 25 MB limit"); a name on the deny list → 400
   `file_name_not_allowed`; both carry `attachmentId` so the composer marks that chip. A limit lowered while the prompt
   waits refuses it at dispatch (`file_too_large`).
8. **Old devices.** An older daemon's `PromptPayload` strips an unknown `files` key and would run the turn without the
   files, so the ack cannot be the gate (as it is for ADR-0041's commands). The daemon announces
   `hello.promptFiles: 1` (`DEVICE_PROMPT_FILES_VERSION`), stored only from the device's own hello in
   `devices.prompt_files_version`. Without it a prompt file is 409 `runtime_too_old` "Update this device to attach
   files (Settings › Devices)"; images that go inline still work. `GET /work-sessions/:id/controls` carries
   `files: { supported, maxBytes }` so the composer says it before any upload.
9. **Audit:** `work_prompt.queued` and `work_prompt.dispatched` add `fileCount`; one `work_session.file_upload` row per
   file when the device answers the prompt (`success`, or `error` with the failure code), with the author, the device,
   the session, the prompt, attachment and transfer ids, the size, the sha256 and the path's length. Never a path, a
   file name or content (ADR-0041 § 14).

## Consequences

- People attach anything; the runtime finds non-image files at `.ocw/uploads/` and is told so.
- Uploads never reach a commit by accident: before landing a prompt's files in a git work tree, the device ensures
  once that the repository's own exclude file (`git rev-parse --git-path info/exclude`, the common git dir for a
  linked worktree) holds `/<prefix>.ocw/uploads/`. The tracked `.gitignore` is never touched; a project without git
  needs nothing. A runtime can still add an upload on purpose (`git add -f`, or by moving it).
- The minimum runtime that receives prompt files is the first release with this record (the next one after v0.4.0).
  Older devices keep working for text and inline images and are told to update for files.
- The organization's "Largest file a bot moves" now also bounds people's prompt files; the name stays as it is.
- Out of scope: files on the New session dialog's first prompt, folders, and removing uploads after the session.
