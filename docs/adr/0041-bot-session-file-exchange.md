# ADR-0041: A bot moves files between its Work Zone session and the conversation it started it from

## Status

Status: Accepted. **Date:** 2026-11-11. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.17.1.1-02), before any behaviour lands, from the owner's requests of 2026-11-11 while testing v0.3.0 on
ocw.autofy.ing, quoted as said:

> "el bot debe poder ver el output de la ia de la workzone y seguir haciendo prompts, descargar archivos"
>
> "añade que pueda subir y descargar archivos para el workzone"
>
> "el limite de peso por archivo que sea configurable"

(The bot must see the Work Zone's output, keep prompting and download files; it must upload and download files for the
Work Zone; the per-file size limit must be configurable.) The decisions are D-01 … D-14 in
`.planning/phases/07.17.1.1-bot-file-exchange-with-its-work-zone-sessions-upload-chat-at/07.17.1.1-CONTEXT.md`
(D-08 … D-14 were decided after the research, under the owner's full-autonomy grant), the planner decisions PD-04 …
PD-25 in `07.17.1.1-01-PLAN.md`, and the research in `07.17.1.1-RESEARCH.md`. The owner's full-autonomy grant makes
CONTEXT's locked decisions the acceptance. Reading output, prompting and stopping already ship (ADR-0038); this record
adds only the moving of files.

**Supersedes, without editing them:** the clauses of [ADR-0038](0038-bot-work-zone-orchestration.md) and
[ADR-0039](0039-automation-fan-out-and-team-mentions.md) that name the bot's Work Zone tool set as four, quoted
verbatim below, each only as far as the "What replaces it" column says. Everything else in those records stays exactly
as written.

**Builds on:**

- [ADR-0038](0038-bot-work-zone-orchestration.md): the profile, the sponsor, a bot controls only its own sessions, the
  taint and `actOnOutsideContent`, the session-output mark and its WR-02 narrowing, the hourly prompt budget, the
  closed refusal codes, the audit names.
- [ADR-0037](0037-bots-read-attachments.md): the one attachment row rule `attachmentForTurn`, decided as the asker;
  an attachment read taints the turn.
- [ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md): the import rule of `ocw_sandbox_import`, and the
  pattern of `ocw_sandbox_share` (a `pending` attachment the bot's reply links).
- [ADR-0015](0015-object-storage-garage.md): Garage through the S3 API only; the API is the only ACL. Here the API
  streams the bytes itself and never gives a device a presigned URL.
- [ADR-0040](0040-runtime-self-update.md): the one click in Settings › Devices that updates a device's runtime, where a
  `runtime_too_old` refusal sends people.

### Superseded clauses

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "### 5. Four tools, run as the sponsor (D-05, D-06, PD-03, PD-09)" | ADR-0038, § 5, heading | Six tools, all or none: the four plus `ocw_work_session_upload` and `ocw_work_session_download` (D-01, § 1). | Every rule of § 5: builtins sent to the Agent Channel API, never approvable, self-validated, turn-scoped, strict bodies that name no user, device, audience or worktree, run as the sponsor. |
| "`ocw_work_session_start`, `ocw_work_session_prompt`, `ocw_work_session_read` and `ocw_work_session_stop` are builtins (D-05)." | ADR-0038, § 5, first bullet | Six tools, all or none: the four plus `ocw_work_session_upload` and `ocw_work_session_download`, decided and audited in `agent-channel/work-session-files.ts` (§ 1). | The rest of the bullet: the plugin sends them to the Agent Channel API, which decides and audits them; never approvable, self-validated, turn-scoped, never in `GET /cell`. |
| "The four tools are offered, turn-scoped, on deliveries with `trigger` `mention`, `reply_mode` or `work_session`, in every conversation where `ocw_start_work_zone` can be offered today." | ADR-0038, § 12 | Six tools, all or none: the four plus `ocw_work_session_upload` and `ocw_work_session_download`. A turn with room for fewer than six gets none of them (§ 1). | Where they are offered; the two conditions (an active profile; the asker passes the Work Zone module gate and reads the conversation); no `work_session.create` for the asker; never on automation runs or consult hops; the ADR-0039 item turns. |
| "A delivery that offers the four `ocw_work_session_*` tools now removes `ocw_start_work_zone` and `ocw_work_zone_projects` from the same turn." | ADR-0038, Amendment (owner testing, 2026-11-11) | Reads "the six `ocw_work_session_*` tools". | The amendment's rule as written: a turn that offers the session tools carries no proposal tools; a turn with no room for them keeps the proposal tools; a bot without an active profile gets the turn it got before. |
| "The four `ocw_work_session_*` tools are offered on automation item turns, on the same conditions as a mention by the run-as person (D-04, § 6)." | ADR-0039, Superseded clauses, the row for ADR-0038 § 12 | Six tools, all or none: the four plus `ocw_work_session_upload` and `ocw_work_session_download`, on the same item turns. | Never on run turns or consult hops; the item turn's own rules (ADR-0039 § 6, § 7). |

## Context

Since 07.16 a bot with a Work Zone profile starts, prompts, reads and stops its own sessions. The owner's flow needs one
more thing: files. A person attaches a spec in the thread and the bot's session must work on it; the session writes a
report and the person wants it back in the thread. Today the bot can only paste text.

Every seam exists: the 07.16 pipeline (offer, strict bodies, the sponsor's transaction, taint, budgets, audit), the
attachment rule of ADR-0037, the pending attachment of `ocw_sandbox_share`, Garage, and the Device Link. The research
found what does not fit:

1. **The Device Link cannot carry bytes.** The API closes the link on a device frame over 256 KiB. Commands are stored
   in `device_commands.payload` and delivered at least once. Device frames are processed in order on one chain, so a
   large file in chunks would block every session event of that device.
2. **No deny list exists for shared files.** `ocw_sandbox_share` confines by realpath only. The closest list is the
   Claude adapter's `isSecretPath`. An upload into a working tree can plant executable configuration: `.claude/`
   hooks and permissions, `.git/config` commands such as `core.fsmonitor`, `.mcp.json` servers, `.codex/` config.
3. **Two people's rights meet.** The attachment is decided under the asker's RLS; the session is acted on under the
   sponsor's. One transaction cannot do both.
4. **A session already latently breaks the link.** A `diff.result` with a large patch can exceed 256 KiB and close the
   link (D-14).

## Decision

### 1. Two tools, offered with the four (D-01, PD-04)

- `ocw_work_session_upload` copies an attachment of the thread into the session's working tree. Body (strict):
  `{ eventId, agentId, workSessionId, attachmentId, path, overwrite? }`.
- `ocw_work_session_download` copies one file of the session's working tree into the conversation as an attachment.
  Body (strict): `{ eventId, agentId, workSessionId, path }`.
- `path` is a `WorkSessionFilePath`: repo-relative, 1 … 1 024 characters, segments of at most 255; no leading `/` or
  `~`, drive letter, backslash, control or bidi character, empty, `.` or `..` segment, nor a segment ending in a space
  or a dot. No body names a device, a user, a conversation, a URL, an absolute path or bytes.
- Routes: `POST /agent-channel/v1/work-sessions/upload` and `…/download`, in `agent-channel/work-session-files.ts`.
  Both are builtins, flagged side-effecting, never dangerous, never approvable, self-validated in the cell.
- The offer is the 07.16 offer, extended to six, all or none. The turn's `workZone` block carries `files`, the limit
  that applies (§ 8).
- Answers: `uploaded { workSessionId, path, sizeBytes }`, `downloaded { workSessionId, attachmentId, name, sizeBytes,
  contentType }`, or the closed refusal of ADR-0038 with its fixed sentence. Thirteen codes are added:
  `attachment_not_found`, `path_not_allowed`, `file_exists`, `file_not_found`, `not_a_file`, `file_too_large`,
  `file_cap_reached`, `session_busy`, `session_not_running`, `runtime_too_old`, `storage_unavailable`,
  `transfer_failed`, `transfer_timeout`.

### 2. The call order: the asker, then the sponsor (PD-06, PD-07)

1. **Without a user** (tx0): the turn of this bot (else 404 `unknown_turn`), its profile, its own session, the
   effective limit.
2. **As the asker** (txA, `turn.userId`): the turn is live; the tool is on the turn; storage is configured
   (`storage_unavailable`). Upload only: `attachmentForTurn` (null → `attachment_not_found`, the same answer whatever
   the reason, so nothing can be probed) and its size against the limit (`file_too_large`).
3. The route creates the transfer id and subscribes the waiter before anything is sent.
4. **As the session's sponsor** (txB, `bot_work_sessions.sponsor_user_id`): the turn is live; the tool is on the turn;
   the session is the bot's own; the conversation is the origin (§ 3); the profile is present, has the session's
   sponsor and is active; the profile's scope; the deny list (§ 6); the taint (§ 10); the session-output mark (§ 10);
   the claim (one of the turn's 8 calls); then the module prepares the transfer.
5. The sponsor's rights decide, with no new permission or grain: an upload needs `work_session.prompt` on the session
   (writing into its tree acts on it, like a prompt); a download needs `work_session.read` (what the diff route asks).
   Refused → `not_allowed`.
6. Refusals before the claim record a denied `agent_tool_calls` row and are not counted. Refusals after it are audited.
7. The route waits for the device outside any transaction, then finishes as the sponsor (txC) and audits.

Running everything as the sponsor would decide the attachment on the sponsor's rights, not the asker's (ADR-0037).
Running everything as the asker would let anyone who reads the thread write into a tree under someone else's name.

### 3. The origin conversation only (D-12, PD-14)

Both tools work only when the turn's conversation is the session's origin conversation
(`bot_work_sessions.origin_conversation_id`), the same equality the turn's session list uses. Otherwise
`not_your_session`. The session's audience is a subset of that conversation's readers (ADR-0038 § 7), so a downloaded
file never reaches a wider audience, and no file hops between conversations through a session.

### 4. The transport: commands without bytes, bytes over HTTP (D-04, D-08, PD-05)

- Two Device Link commands: `session.file.write` (payload: path, size, sha256 or null, overwrite) and
  `session.file.read` (payload: path, `maxBytes`). **A command never carries bytes or a URL.** The transfer id is the
  command id.
- The daemon builds the URL itself from its own `serverUrl`: `GET <serverUrl>/api/v1/runtime/files/<id>` to fetch an
  upload, `PUT …/<id>` to send a download. It authenticates with its cached device JWT, **never over the Device Link**.
  It never fetches a URL it was sent.
- The API route accepts only a device JWT whose device is the transfer's device, not revoked, with `device.link`
  decided. A legacy raw device token answers 401; another device's JWT, or another organization's, 404.
- **Single use and expiry.** The transfer row moves `pending` → `streaming` when claimed; any later request answers
  410. It expires at its creation plus the transfer deadline (§ 12); 410 after.
- Refusals that are not about the transfer do not consume it, so the daemon can retry: the JWT (401), the stream
  counter (at most **four streams per API process**, 503 `busy` beyond; the daemon retries a 503 up to twice) and, for
  `PUT`, a missing `content-length` (411).
- **413 before reading a byte** when the declared length exceeds the transfer's bound; the transfer then fails as
  `too_large`. The body is counted as it streams: more than declared, or than the bound, aborts.
- Storage: Garage **multipart** with 8 MiB parts, one part in memory at a time; a file of one part or less uses a
  single put. The existing S3 client; no new package. The API computes the sha256 and sniffs the type of every byte it
  stores; the device's hash is only a cross-check.
- Fastify's request timeout stays off; the transfer's deadline bounds the time.

HTTP gives backpressure, a length check before any byte moves, one origin for headless servers (ADR-0033), and leaves
the link's ordering untouched. Base64 frames or a second socket were rejected for the reasons in Context.

### 5. The ledger `app.bot_work_session_files` (PD-12, PD-16)

- One row per transfer the API enqueues: id (= the command id = the transfer id), organization, session, bot, turn
  event, device, conversation, direction (`to_device` / `from_device`), attachment id (the source of an upload,
  pre-allocated for a download), the bound and its source, size and sha256 when known, the path's length, status
  (`pending`, `streaming`, `streamed`, `done`, `failed`), failure code, expiry and times.
- RLS by organization like every tenant table; rows cascade with their session.
- **No path or file name column.** The path lives only in the command's own payload, which the device needs.
- It counts the per-turn caps and the hourly budget (§ 9) and holds the audit facts.

### 6. Containment on the device and one deny list (D-02, D-03, D-09, PD-09, PD-10)

- **One deny list in `@ocw/contracts`** (`workSessionFilePathRefusal`), pure, used by the API before the claim (a
  refusal costs no transfer) and by the daemon, which is authoritative. It applies **both ways**, segments compared
  **case-insensitively** (APFS and NTFS are case-insensitive by default):
  - any `.git` segment (file or directory; worktrees have a `.git` file) → `git`;
  - any `.ocw-worktrees` segment → `worktrees`;
  - any `.claude` or `.codex` segment, or a final `.mcp.json` → `runtime_config`;
  - a secret basename → `secret`: `.env` and `.env.*` (but `.env.example`, `.sample`, `.template`, `.dist`), `*.pem`,
    `*.p12`, `*.pfx`, `*.key`, `id_rsa`/`dsa`/`ecdsa`/`ed25519` (and `.pub`), `*.keychain(-db)`, `.netrc`, `.npmrc`,
    `.pypirc`, `credentials(.json)`, `.credentials.json`, `device-token`.
  The rule moved from the Claude adapter's `isSecretPath`, which keeps its home-directory list and uses the shared
  basename rule. **Uploading `.env` is refused on purpose**: a secret belongs in the secret store (principle 8), and a
  `.env` the bot downloads would reach every reader of the conversation.
- The daemon checks the requested path and the path relative to the realpath of the root, both ways.
- **Root** = the realpath of the active session's working directory (its worktree when isolated). The parent's
  realpath must be the root or under it. Missing parents of a write are created one segment at a time, each checked,
  never through a symlink.
- **Read:** a regular file only (not a symlink, FIFO, socket, device or directory), opened `O_NOFOLLOW`, its size
  checked against the bound before any byte moves (`too_large: <size>`).
- **Write:** enough free space; a temporary file opened exclusively in the parent; bytes counted and hashed and
  compared with the command's size and sha256 (`mismatch`); without `overwrite` an exclusive link, so an existing
  file answers `file_exists` and stays untouched; with it the target must be a regular file or absent, then a rename.
  The temporary file is removed on every failure.
- Bytes only, end to end: nothing decodes, executes or renders a moved file. Absolute paths never leave the device
  (principle 7): ack errors are sanitised with the session roots.

### 7. Writes only while idle; reads while active (D-13, PD-08)

- Under the bot's lock, then the session's row lock: archived → `session_ended`; completed or failed →
  `session_not_running`; host offline, or the device not online or revoked → `device_offline`, before any ledger row.
- **An upload needs an idle session with no prompt queued, dispatched or running**; else `session_busy`. On the device
  a write while a turn runs is refused too (`busy`), the second line. **Principle 4: one executor per working tree.**
  The runtime is the tree's writer while it works; a file appearing under it mid-turn is a second writer.
- **A download is allowed while idle, running or waiting for an approval.** Reading does not write. The accepted cost:
  a file the runtime is writing may be read half-done; the bot can read the session first or download again.
- On the device, a session not active there answers `not_running`, mapped to `session_not_running`: the bot sends a
  prompt to resume it. Downloads from a finished session are out of scope.

### 8. The limits: organization and bot, the lowest of three (D-07, PD-11)

- **Organization:** Settings › Work Zone policy › Bots › "Largest file a bot moves" (`bot_file_max_bytes`), default
  25 MB, saved only up to the server's `OCW_ATTACHMENT_MAX_BYTES` (a self-hoster may raise it up to 1 GiB). The field
  states that ceiling.
- **Bot:** the profile's Limits › "Largest file" (`file_max_bytes`), empty = the organization's, saved only up to the
  organization's value.
- **The effective limit** at every call is `min(bot, organization, OCW_ATTACHMENT_MAX_BYTES)`, recomputed each time,
  so an organization lowered later wins at once. **On a tie the outer level is named** (the server, then the
  organization), because a person cannot raise it from the bot's profile.
- **MB means MiB**, as the chat's file sizes already show.
- **Checked before any byte moves:** an upload against the attachment's stored size in the asker's transaction; a
  download by the device's size check first, and the API's 413.
- `file_too_large` carries the limit and, when known, the size, and its sentence names the level, e.g. "That file is
  40 MB. This bot moves files up to 25 MB (the organization's limit)."

### 9. Budgets (D-06, PD-12)

- **The hourly prompt budget** of ADR-0038 § 6: each transfer the API enqueued costs one unit, whatever its outcome.
  `app.bot_work_session_load` counts the bot's ledger rows of the last hour with its prompts, under the bot's lock.
  When moves spent the budget, a prompt answers `prompt_rate`, and so does a move.
- **The turn's 8 tool calls** (the claim) include both tools.
- **At most 5 files per turn each way** (`file_cap_reached`). A download is also refused when the turn already holds
  10 pending files (`MAX_ATTACHMENTS_PER_MESSAGE`).

### 10. Taint and the session-output mark (D-02, D-10, D-11, PD-13)

- **After outside content**, both tools follow the profile's `actOnOutsideContent`, exactly like a prompt (ADR-0038
  § 10): without it `outside_content`; with it the call is claimed and audited with `outsideContent: true`, and an
  upload then marks the session `tainted_at` (the first mark kept), as a tainted prompt does.
- **A clean upload does not taint the session** (A-05, decided by D-02). A file a person attached in the thread is
  treated like that person's prompt: the asker could read it, and it entered the session through their own turn.
- **After a session read**, both tools are allowed only on the one session the turn read (the WR-02 shape); any other
  session answers `session_output`. So "read the output, then download the report" works in one turn (D-11).
- The plugin lets the route decide both: the two names are in its route-decides-taint and session-output-exempt sets.
- A download answer is the platform's own ids and the name the bot asked for, not untrusted output. The bytes reach
  the bot only through `ocw_attachment_read` on a later turn, which taints (ADR-0037).

### 11. The downloaded file is a pending attachment the reply links (D-03, PD-17)

- The API pre-allocates the attachment id; the `PUT` stores the bytes under it, then inserts the attachment `pending`:
  uploader the bot, event the turn, conversation the turn's, name `sanitizeFilename(basename(path))` from the
  command's own payload, type sniffed, sha256 computed, size counted.
- **Nobody can read it until the bot's reply for that turn links it** (`linkTurnAttachments`, unchanged), exactly as
  `ocw_sandbox_share`. A turn that never replies leaves it to the 24-hour sweeper.
- People then open and download it like any attachment in the thread.

### 12. Waiting and timeouts (PD-18)

- The waiter subscribes before the command is enqueued and is aborted on any refusal.
- Its deadline is `transferDeadlineMs(bytes)` = min(10 min, 30 s + 1 s per MiB), on the attachment's size for an
  upload and on the limit for a download.
- On timeout the command and the transfer are marked failed, so a late redelivery or request gets 410 (the daemon
  acks `expired`), and the bot gets `transfer_timeout`.
- The plugin waits for these two tools up to the 10-minute cap plus 15 s. The daemon's own requests use the same
  deadline.

### 13. Old daemons (D-04, PD-15)

An older daemon acks an unknown command kind with `invalid command frame`. The API maps it to `runtime_too_old`, whose
sentence sends people to Settings › Devices, where ADR-0040's one click updates the runtime. The daemon's version is
not used as a gate.

### 14. Audit (D-05, PD-16, principle 12)

- Success: `bot.work_session_upload` and `bot.work_session_download` through the 07.16 audit helper. Actor and agent
  the bot, user the asker, the device, resource the session. Metadata: event id, `sponsorUserId`, project, session,
  attachment id, bytes, sha256, direction, path length, `outsideContent` when set.
- Refusals: `bot.work_session_refused` with the tool, the path length and, for `file_too_large`, the bytes and the
  limit's source.
- **Never a path, a file name or file content** in an audit row, `agent_tool_calls` (its target is the session id), the
  ledger, a job or a log line. Logs carry ids and codes. This extends ADR-0038 § 14 unchanged.

### 15. The diff frame bound (D-14, PD-19)

The daemon bounds every `diff.result` after sanitising it: when the serialised frame exceeds the device frame bound
(`DEVICE_LINK_MAX_DEVICE_FRAME_BYTES`, 256 KiB) minus 4 KiB, the patch is cut at the last newline that fits and marked
`truncated`; when the file list alone does not fit, the list is cut too. The API reads the same constant for its
inbound limit, so the two can never drift.

### 16. No live-card change (PD-20)

The live card of ADR-0038 § 13 is viewer-neutral and read by people outside the session's audience. It shows no file
names and no count of moved files. The files appear where the bot reports: its reply in the thread. The only UI is the
two limit fields of § 8.

## Consequences

- **What people see.** A bot that started a session can be asked to "put this file in the session" or "send me the
  report". The file appears in the session's changes, or on the bot's reply in the thread. Two new fields: the
  organization's "Largest file a bot moves" and the profile's "Largest file".
- **What bots cannot do.**
  - Move files of a session they did not start, or from a conversation other than the session's origin.
  - Write into `.git`, `.claude`, `.codex`, `.mcp.json`, `.ocw-worktrees` or a secrets file, or read them out.
  - Write while the session works, or move a folder, an archive or a link.
  - Name a device, a user, a conversation, a URL or an absolute path.
- **Reverse proxies.** A proxy in front of the API must neither limit nor buffer request bodies on
  `/api/v1/runtime/files/` below `OCW_ATTACHMENT_MAX_BYTES`, or large downloads fail. The compose proxy (Caddy) does
  neither by default; `docs/self-hosting/reverse-proxy.md` says so for other proxies. **CDNs cap bodies**: Cloudflare's
  free plan stops at 100 MB, so a server behind it should keep the limit below that.
- **Release skew** (PD-21). Every new field is optional. An older plugin lacks the two tools and strips the limit
  fields; an older API never offers them; an older daemon answers `runtime_too_old`. The offer needs room for six
  tools, so a turn that had room for four but not six falls back to the proposal tools, as the ADR-0038 amendment says.
- **Flagged assumptions**, each with how it is checked:
  - **A-01.** OpenClaw keeps a tool call open up to the 10-minute cap; 85 s is proven by the sandbox calls. Checked by
    the real-cell smoke (a small file) and the owner's UAT moving a 20 MB file on ocw.autofy.ing.
  - **A-02.** Caddy neither limits nor buffers request bodies. Checked by a 30 MiB `PUT` through the proxy in
    `scripts/gate/proxy-check.mjs`; the CDN cap is documented.
  - **A-03.** Fastify's `bodyLimit` does not bound a parser that returns the raw stream. The route sets its own limit
    to the ceiling and counts bytes anyway, so a wrong assumption cannot let more through.
  - **A-04.** Node 24's `fetch` streams a request body with `duplex: "half"`. Proven by the daemon's first test against
    a local server.
  - **A-05.** Recorded as the decision of § 10, not an assumption.
  - **A-06.** Garage enforces the S3 5 MiB minimum part size; 8 MiB parts satisfy it. Checked by the 17 MiB storage
    cases (three parts, equal sha256 at both ends).
- **Out of scope** (PD-25):
  - upload or download buttons for people in the session view;
  - folders and zip exports;
  - binary diffs;
  - files outside the session's working tree;
  - sessions the bot did not start;
  - file names on the live card, and a session history item for a moved file;
  - downloads from a finished session (`session_not_running`);
  - release notes (the v0.3.1 release PR writes them).
- AGENTS.md's "Bot Work Zone orchestration" row names the file exchange and cites this record next to ADR-0038.
