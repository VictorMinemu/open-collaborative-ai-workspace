# ADR-0037: Bots read attachments

## Status

Status: Accepted. **Date:** 2026-11-07. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.15-11) from the owner's request and decisions D-01 … D-17 in
`.planning/phases/07.15-bots-read-attachments/07.15-CONTEXT.md`, the planner decisions PD-01 … PD-18 and the flagged
assumptions A-01 … A-03 in `07.15-01-PLAN.md`, the research in `07.15-RESEARCH.md` and the 07.15 SUMMARYs.

**Extends, without editing them:** [ADR-0015](0015-object-storage-garage.md) (attachments in Garage, presigned
uploads, the API as the only ACL) and [ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md) (the bot's sandbox
workspace and its F-8 audience rule; spike (ii), images in a tool result). **Builds on:**
[ADR-0018](0018-ai-chat-run-loop-and-model-gateway.md) (which models read images and PDFs),
[ADR-0019](0019-multiplayer-ai-chats.md) and [ADR-0020](0020-agent-personas-and-agent-cards.md) (personas in AI chats),
[ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md) (taint and approvals). Supersedes nothing.

## Context

On 2026-11-07 the owner reported that he could not attach a file in his personal bot's DM, and that bots in normal
chats should read files too. The web disabled the paperclip in bot DMs on purpose, because bots could not read
attachments (README, Known limitations). In channels people could attach files, but the bot never saw them.

What was already in place:

- Attachments live in Garage. Browsers upload and download through presigned URLs, and the API is the only ACL
  (ADR-0015).
- AI chats already send images and PDFs to the chat's model through the model gateway (ADR-0018), gated by the model's
  capabilities.
- A bot's sandbox has `ocw_sandbox_import`, which copies an attachment into its workspace under the F-8 audience rule
  (ADR-0029).
- A bot turn has a taint and per-tool approvals (ADR-0026), and a cap of 8 confined calls per turn.

## Decision

### Where people attach (D-01, D-14)

- The paperclip is on in personal and team bot DMs, as in a DM with a person: same limits, same accept list, same
  presigned upload (one code path). It stays off in a turned-off bot's DM, a deactivated person's DM and an archived
  conversation. Channels and threads were already on.
- In AI chats the chat's model still decides which files can be attached (`attachment-gate.ts` in the web,
  `assertReadableBy` in the API). A persona never widens that. The shared-chat send route applies the same gate to a
  message that only addresses a persona as to one that asks the chat model (fixed at this gate, 07.15-11).

### What the bot sees on its turn (D-02, PD-03, PD-04)

- The turn the API hands to the cell lists the attachments of the messages the turn reads, as metadata only: id, name,
  media type, size, message id, kind (`image`, `text`, `pdf`, `other`) and per-bot access (`read`, `import`, `none`)
  with a note. Never content, a URL or a storage key.
- The list is the current message's files in upload order, then the history window's messages newest first. At most
  20 are listed; `attachmentsMore` counts the rest.
- Access per bot: `text` and `pdf` are `read`; `image` is `read` when the bot's model takes images and the image fits;
  anything else is `import` when the turn offers `ocw_sandbox_import` and the audience rule holds, else `none`.
- `ocw_attachment_read` is a turn-scoped tool. It exists only on a turn that lists at least one readable file, while
  object storage is configured. `GET /cell` and every tool list of a turn without files stay unchanged.
- Automation runs and consult hops list no attachments.

### The read tool (D-03)

- `ocw_attachment_read` sends only the turn's event, the bot and the file id to `POST /attachments/read`. The API
  re-decides everything at call time and answers text in a labelled untrusted block, an image, or a refusal.
- **Images ride the tool result, not OpenClaw's native inbound media.** OpenClaw 2026.9.7's native `media` writes the
  bytes to the cell's disk, can run "media understanding" through other configured providers and copies files into
  OpenClaw's own sandbox. None of that goes through our decision, audit or taint. A tool result with an image part
  reaches a model declared `input: ["text", "image"]`, as ADR-0029 spike (ii) proved and `ocw_browser_screenshot`
  already uses.

### Notes and sentences (D-04)

- A file the bot cannot read carries a note on the turn (for example "this model can't see images"). A refused read
  answers a fixed sentence the bot can pass on to the person. Refusal codes are closed: `not_found`, `policy_changed`,
  `model_no_images`, `unsupported_type`, `too_large`, `no_text_layer`, `encrypted`, `extraction_failed`, `busy`,
  `timeout`, `cap_reached`, `unavailable`. Only a turn whose asker no longer reads the conversation is a 403 (`no_trigger`).

### Extraction and its bounds (D-05, D-12, PD-07)

- Extraction runs in the API process and never executes, evaluates or renders a file. SVG, HTML, XML and code come
  back as text.
- Text: at most a 256 KiB range read; decode order BOM, strict UTF-8, UTF-16, windows-1252; a NUL outside UTF-16 means
  "not text". Characters are UTF-16 code units and a cut never splits a surrogate pair.
- Images: the stored `large.webp` rendition (≤ 2048 px, no EXIF) when it exists, else the original for inline image
  types up to 5 MiB, else `too_large`.
- PDF: `unpdf` **1.9.1** (MIT, unjs) in a `worker_threads` Worker: 256 MB old and 32 MB young generation, no inherited
  flags, `isEvalSupported: false` (CVE-2024-4367), 100 pages, 64 000 characters, `terminate()` after 10 s, at most 2
  workers per process (`busy` otherwise, no queue). The worker's answer is Zod-parsed.
- **Why 1.9.1 and not 2.x:** 2.0.0 was a new major published on 2026-10-28, 10 days before this decision. The project
  prefers releases at least two weeks old. 1.9.1 (2026-10-19) has every API the phase needs. The release image carries
  `unpdf` and `pdf-worker.mjs` (checked by `pnpm gate:compose`).
- Limits per turn: 20 reads, 64 000 characters per file and 200 000 per turn. They are constants
  (`ATTACHMENT_READ_LIMITS`, `EXTRACT_LIMITS`), not environment variables (A-02).

### No cache (D-06)

There is no extraction cache in this phase. Every read re-decides and re-reads, so nothing cached can outlive a
permission change, a deleted message or a deleted file.

### Audit (D-07, PD-09)

- `bot.attachment_read`: actor and agent the bot, user the asker, resource the attachment id, result success, denied
  or error, and metadata `{ eventId, conversationId, attachmentId, kind, mediaType, bytes, chars, truncated, pages?,
  outcome }`. A refused read is audited with `bytes: 0` and `chars: 0`.
- `bot.attachment_imported`: the same base for imports. `sandbox.file_imported` and `bot.tool_call` are unchanged.
- No file name, content, path, URL or key is ever in an audit row, a log line or `agent_tool_calls`.

### Taint (D-08, PD-08)

- A read is untrusted output: it taints the turn and its return turns, like a web fetch. After it, every
  side-effecting call is refused as `tainted` unless an ADR-0026 grant covers it. So "read this file and remember X"
  cannot write memory, a board card or a record in that turn without a person's approval.
- The read itself is never approvable and needs no approval: it reads the conversation's own file.
- The import keeps its 07.8 flags. What the sandbox tools read later taints.

### Imports and the audience rule (D-09)

- `ocw_sandbox_import` copies a file into the workspace only where the conversation's audience covers the workspace
  (ADR-0029 F-8). A personal bot's workspace receives only files from conversations its owner reads.
- A team bot's workspace is shared by everyone who talks to that bot. A member's DM with a team bot is narrower than
  that, so files from such a DM are never copied into the team bot's workspace (`audience_narrower`; the turn says
  so). The bot can still read the files it can read.
- **Residual:** a bot can write text it read from a file into its workspace through its sandbox tools, exactly as it
  can with message text. The audience rule bounds where that workspace is shared.
- The import's activity step shows its target, which is a workspace path. With the default path
  (`downloads/<sanitized name>`) the file's name appears in that bot's activity tab. **This is kept:** the activity tab
  is read only by people who already see the attachment in the conversation, and 07.8 shows workspace paths there by
  design. It is not an audit or log leak (07.15-11 decision).

### One row rule (D-16, PD-05)

`attachmentForTurn` decides read and import alike: the file is visible under RLS, in the turn's conversation, `ready`,
linked to a message that is present and not deleted, never a Work Zone prompt image, and, in a channel, in the turn's
own thread. DMs, groups and AI chats are conversation-wide. `liveTurn` checks that the asker still reads the
conversation. This also fixes the import precheck that accepted unsent or other-thread uploads (the D-16 hotfix rule).

### Budget columns (D-11, D-17, A-03)

- `agent_turns` gains `attachment_reads` and `attachment_chars` (defaults 0, never negative; one additive generated
  migration). They are the only stored change; `ocw upgrade` applies it and existing attachments become readable to
  bots under these rules.
- Reads have their own budget and do not consume the cap of 8 confined calls; the cell keeps its own counter.
- **A-03:** an image read costs one read and 0 characters. A `busy`, `timeout` or storage failure after the claim
  still counts as one of the 20 (no refund).

## Consequences

**People and bots get:**

- A paperclip in every bot DM. Bots read text, code, CSV, JSON, PDFs with a text layer and, on image-capable models,
  images, in DMs, groups, channels, threads and AI chats with personas.
- Files a bot cannot read are named on its turn with a reason, and the bot can say why.
- Other files (archives, Office documents) can be copied into a bot's sandbox, where its tools convert or open them.

**Not supported (deferred):**

- OCR for scanned PDFs and images of text; audio and video.
- DOCX, XLSX and PPTX extraction (no reliable permissive pure-JS path was adopted; they go through the sandbox).
- Bots attaching files to their own replies (Phase 12 artifacts).
- Images for bots on a ChatGPT plan (D-13): the model is not declared image-capable, so the bot gets the
  `model_no_images` note and sentence.
- Activity-tab entries for reads (D-15): reads are visible through audit only.
- A persistent extraction cache (D-06).
- Work Zone attachments beyond the 06.1 images.

**Costs and risks:**

- File content is untrusted input. The labelled untrusted block and the taint limit what a hostile file can make a
  bot do; they do not stop a model from repeating what the file says.
- PDF parsing runs third-party code in the API process's worker threads, bounded by the limits above. A PDF.js
  security fix may need a new `unpdf` pin.
- The real-cell smoke waits for OpenClaw's boot hot reload to settle before its first turn, because a turn inside that
  window can find the plugin mid-reload (07.15-11).

## Amendment (2026-11-07, 07.15 code review fixes)

*Amended 2026-11-07, before the phase merged, from `07.15-REVIEW.md` (CR-01 … IN-05). The decisions above stand; these
points replace the parts they name.*

**PDF extraction runs in a child process (CR-01, WR-06, WR-07).** This replaces "in a `worker_threads` Worker" above
and "in the API process's worker threads" under Costs and risks. A worker's `resourceLimits` bound only its
JavaScript heap. PDF.js inflates streams into ArrayBuffers, which belonged to the API process, so a 1 MB PDF that
inflates to 1 GiB grew the shared API to about 2 GB. Now:

- **Spawning.** `pdfText` spawns `node` on `pdf-worker.mjs` for each read (the file kept its name). The child runs
  with:
  - `--max-old-space-size=256`;
  - the permission model (`--permission`): read access to that script and the `unpdf` package directory only; no
    writes, child processes, workers, addons or WASI;
  - `--disallow-code-generation-from-strings`;
  - an empty environment (no secret, no `_FILE` path, no `NODE_OPTIONS`) and none of the API's flags;
  - a fresh temporary working directory;
  - the bytes on stdin; stdout and stderr are dropped. The one IPC answer is still Zod-parsed.
- **Memory watchdog.** The API polls the child's resident memory and kills it past `EXTRACT_LIMITS.pdfRssMb`
  (512 MiB). It reads `/proc/<pid>/status` every 20 ms on Linux and runs `ps` every 50 ms on macOS. The read then
  answers `too_large`.
- **Kernel backstop (Linux).** When `/usr/bin/prlimit` exists, the child runs under `prlimit --as` of 4 GiB, in case
  the watchdog is late. `prlimit` comes with util-linux and is present in the API's `node:24-bookworm-slim` image.
  The value is generous on purpose: V8 reserves 1 to 1.7 GB of address space before it allocates anything (measured
  on arm64 and amd64), so a tight value would stop every extractor from starting. Elsewhere only the watchdog and the
  deadline apply.
- **Unchanged bounds.** The 10 s deadline (now SIGKILL), 100 pages, 64 000 characters and the two-per-process `busy`
  rule stay. A call settles only after its process has closed.
- **Input bound.** A PDF is parsed only up to `EXTRACT_LIMITS.pdfMaxBytes`, a fixed 25 MiB, whatever the upload limit.
  A larger one is `too_large` before any storage read, and the listing says so (`tooLarge`). The API holds one copy of
  the bytes.
- **No text layer.** `no_text_layer` is decided from every page read, not from the cut prefix (IN-03).

**What remains of WR-07:**

- The extractor is a separate process, but it runs as the same OS user, in the same container and network namespace
  as the API.
- Node 24's permission model does not restrict the network (`--allow-net` arrived in Node 25). A PDF.js
  code-execution bug could therefore open sockets to PostgreSQL, Redis or Garage. It has no credentials to use there:
  the child has no environment and cannot read files outside its script and `unpdf`.
- PDF.js has no option to bound one inflated stream, so the bound is the process's memory, not the stream's size.
- If that ever matters, the next step is a separate container or OS user with no network.

**Text reads (WR-05).** "At most a 256 KiB range read" now holds even against a store that ignores `Range`.
`rangeGet` copies at most the bytes it asked for from the body stream, then destroys the stream.

**The untrusted block (CR-02, WR-01, WR-02).**

- The content may contain something a model could read as the block's own tag: any case, whitespace around the
  slash, attributes, or no closing bracket. The `<` that starts it is replaced with U+FF1C.
- U+FF1C is one code unit, like `<`, so the block is the content plus a fixed overhead and always fits the answer.
- The trailing trim is `trimEnd()`, linear in the input.
- AI chats use the same block.

**What a turn may read (WR-03, WR-04).**

- A read is decided again when it commits. If the message is deleted, the file swept or the asker removed during the
  store read or the extraction, the read answers `not_found`: nothing is returned, no character is charged and the
  audit says `denied`.
- A turn reads only while it runs: not reported done, at most an hour old, and its bot neither turned off nor
  deleted. Otherwise the answer is 403 `no_trigger`.
- The one row rule (read and import) takes only files of messages up to the turn's own message (by `seq`). A file
  posted later belongs to a later turn and is `not_found` here.
- Other `liveTurn` tools keep their rule.

**Listing and gates (IN-01, IN-02, IN-04, WR-08, IN-05).**

- A turn whose tool list is full (64) is not offered `ocw_attachment_read`. Its readable files then say `none`, with
  the fixed note `readNotOffered`.
- The listing keeps only the conversation's own files.
- AI chats decode attached text with the bot read's decoder: BOM, UTF-16, strict UTF-8, then windows-1252.
- In a shared AI chat, a sender's model that cannot be resolved fails closed: only text goes, and images and PDFs are
  refused with `attachment_not_supported`.
- The plugin waits 35 s for one read, past the API's worst case.
