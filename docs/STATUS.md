# What is built

What the repository already ships, by phase (planning lives in `.planning/ROADMAP.md`; decisions in `docs/adr/`).
Moved out of `AGENTS.md` so that file keeps only what every session needs.

- **1 MVP 0:** strict monorepo with RLS and audit, setup / invite / login, one WebSocket with seq replay, channels and
  threads, one-click OpenClaw bots through the Agent Channel API, device pairing, Work Zone sessions, desktop shell.
- **2 Identity and organization:** org hierarchy with four roles, one effective-permission resolver, JWT/JWKS, admin
  console, profiles (ADR-0007, ADR-0008).
- **3 Realtime:** presence, live re-authorisation of subscriptions, sub-500 ms propagation (ADR-0009).
- **03.1 Personal bots and capabilities:** bot web tools, MCP for bots, the ClawHub marketplace, bot memory
  (ADR-0010, ADR-0011).
- **03.2 Work Zone controls:** runtime settings between turns, Work Zone policy, shared devices, Full access
  (ADR-0012, ADR-0013).
- **4 Chat:** sidebar and views, DMs, Markdown, reactions, notifications, search, attachments, pins and permalinks
  (ADR-0015, ADR-0016).
- **5 AI chats:** private streaming AI chats, ChatGPT plan per member, model gateway, usage (ADR-0017, ADR-0018).
- **6 Multiplayer AI chats and agents:** shared AI chats with structural identity, personas, Agent Cards
  (ADR-0019, ADR-0020).
- **06.1 Work Zone image attachments.**
- **7 Self-hosted release:** `pnpm ocw setup` + `docker compose up`, OpenTelemetry, secrets as inputs, backups,
  release gate (ADR-0021).
- **07.1 Board channels and record templates:** a channel can be a board whose cards are threads (moves by pointer,
  keyboard, touch or Move to…, live for everyone), columns with categories and waiting states, agents on the board
  through `ocw_board_card`, and unit record templates that name cards (ADR-0022).
- **07.2 Scoped memory files and governed promotion:** Markdown memory per scope (a person's private memory with a
  bot, bot notebooks, teams, departments, projects, the organization) with a file tree, viewer, editor, history with
  diffs and search at 1440 and 390; per-folder rules; bots read through the audience rule, write only their own
  scopes and propose shared changes; the reusable approve-and-apply primitive with platform-owned approval cards and a
  proposals inbox; a built-in sensitive-data scan plus the optional Presidio `pii` profile; legacy bot notes moved to
  the private `MEMORY.md` (ADR-0023).
- **07.3 Module access per unit:** Work Zone, AI chats, Bots and Memory on or off per organization, unit or person as
  resolver deny rules, from Settings › Organization and Settings › Modules; the web hides what the API refuses
  (ADR-0024).
- **07.4 Per-member connectors, agent keychain and templates:** MCP connectors in three auth modes; each member signs
  in to their own account (OAuth 2.1 with PKCE, `resource`, `iss`; callback on the API) or pastes their own key, sealed
  per member; a shared bot calls the connector with the account of whoever asked, through the API proxy, only where
  that person alone reads the result unless they allow a conversation, and posts a "Connect your account" card that
  comes back to the chat; Settings › Connections and Keychain; keys used by handle and never seen by the model; one
  pinned, public-only egress guard for every outbound call; unit agent templates that members start as their own
  personal agent (ADR-0025).
- **07.5 Per-tool approvals and Work Zone proposals:** admins and unit leads set per tool (or per MCP server or
  connector) whether a bot's call needs a person — Never ask, Ask after outside content, Always ask — and who approves
  (the asker, unit leads, admins or named people), in Settings › Approval policies; only those tools send their
  arguments; a request is one card with the exact action in the asker's DM (a summary elsewhere) and a review in the new
  `/approvals` inbox with its own badge; one approval allows exactly that call once, re-run as the asker's turn with the
  approved values pinned in the cell; bots propose Work Zone sessions (project, device, prompt) that only the asker
  starts, in Supervised mode, credited "proposed by" the bot (ADR-0026).
- **07.6 Automations and watched records:** bots act without being asked, on jobs the Control Plane runs in
  PostgreSQL (pg-boss, installed by the migrate service; no new service, OpenClaw's cron and webhooks off). Bots ›
  Automations: a standing order for a bot, triggered by a schedule (presets or cron, time zones and DST), a signed
  Standard Webhooks URL (leads and admins) or new mail in an IMAP folder read with a Keychain app password (read-only,
  pinned TLS), delivered by stable id to a channel, thread, DM or board column; it always runs as its creator (admins
  pause and delete, never run as someone else), re-decided at every run, with run history, budgets and a pause after
  three failures. Each run posts a platform-owned run card and the bot answers in its thread; webhook and mail content
  is posted by the platform first and the turns on it are tainted (no side effects without an approval). Bots propose
  automations from a chat and only the asker confirms (Created with changes after an edit). Board cards can watch an
  external record through a connector: the API hashes the watched fields (RFC 8785), reports changes before → after on
  access and on schedule, and the bot's updates are compare-and-set with a note back. A per-person digest by DM (opt-in
  metered summary) and Work Zone sessions proposed to the linked team project's memory (manual or opt-in automatic, the
  owner pays) (ADR-0028).
- **07.7 Agent-to-agent consults:** a bot asks another bot for help, or hands work over, only through the platform
  (`ocw_consult_agent`): the question is a visible message in the thread on behalf of the person who asked, the other
  bot answers there, and its whole reply comes back to the asking bot as a new turn, labelled as another bot's answer
  (information, not instructions), so it can tell the person what it found. Off by default: admins turn on "Bots may
  consult each other" in Settings › Bot policy and set each team bot's rules in its sheet (Can ask: organization
  default, any bot, only these bots, no bot; Never ask; Other bots can ask), with a server-computed "Right now" line.
  Each question shows a live chip (Waiting, Answered, Couldn't answer, No answer in time, Stopped, Daily limit reached)
  and the person who asked, or a channel moderator, can Stop it. Chains are bounded by the database (two levels, no
  bot asked twice, 3 consults, one open question per bot per chain, 5-minute timeouts on the job runtime), the person
  pays for every turn, taint from either side carries forward, and OpenClaw's own agent-to-agent tools stay off; v1
  works in channels and threads, between team bots that are members (ADR-0027).
- **07.8 Bot sandboxes, sandbox packages and the live browser:** each bot gets its own sandbox (files, a shell,
  approved packages) and its own Chromium, created only by the `sandboxd` broker (the one Docker socket holder, optional
  `sandbox` compose profile) under gVisor or hardened runc, on private networks whose only way out is the
  `sandbox-egress` proxy with the 07.4 rules; 15 `ocw_sandbox_*` / `ocw_browser_*` tools decided, budgeted (40 per turn)
  and audited by the API; people browse a bot's files from its Sandbox tab, watch its browser live in a floating window
  (a dock and sheet on phones) and take control to sign in; sign-ins are sealed per member, site and bot (Settings ›
  Keychain › Browser sessions) and never carried to another host without the member's approval (D-13); admins turn it
  on in Settings › Sandbox & Browser (isolation, limits, network, pinned sandbox packages, kill switch) (ADR-0029).
- **07.9 Shared Work Zone projects and session visibility:** team projects (org units of kind project under a team or
  department) with members, assigned teams and linked device repositories, a Projects index and project page (Sessions
  and Settings) in the Work Zone and in Settings › Organization; one switch for whether new sessions are visible to the
  whole project; every session has one audience (Only me, Project, chosen teams, chosen people) shown as a chip in its
  header, changed from a popover (a bottom sheet on phones) by its creator, project leads and admins, and chosen in the
  new-session dialog; the audience decides every reader (list, detail, stream, diff, attachments, approvals view,
  proposals) through one SQL rule and the resolver, with an RLS backstop for user requests; the device owner always
  sees, admins are an explicit, audited rule; session updates go only to their readers, never to the organization
  stream; narrowing removes a live view within a second with the reason. On upgrade an existing session is seen only by
  its creator, the device owner, the device's grantees and admins until its repository is linked to a team project
  (deliberate narrowing) (ADR-0030).
- **07.10 Work Zone sidebar by team:** the Work Zone sidebar (desktop column and phone drawer) is grouped like the chat
  sidebar: Needs you on top (approvals you can decide, your finished turns not yet opened), one collapsible section per
  department with the team projects you belong to (team pill, live count, at most 3 active sessions then "+N more"),
  Personal for your own repositories and for sessions of projects you can't open (never named), a collapsed Settled,
  grouped search, Browse projects for the rest, "+" to create a project in a department or start a session in a project
  or repository, arrow-key navigation; two list requests at any size; a session's team project and its "needs you"
  facts are decided per viewer and sent only on that viewer's list, detail and `user:` frames, never on `ws:`, which
  closes a 07.9 leak of a hidden project's name to the device owner (ADR-0031).
- **07.11 Runtime CLI updates:** every device's Local Runtime keeps the Claude Code and Codex CLIs it drives current:
  it finds how each was installed and the one command that updates it from a fixed on-device table (native installer,
  Codex standalone, npm, Homebrew; other and root-owned installs are manual or "needs admin", never run with sudo),
  asks the npm registry (or a mirror) for the latest version on the install's channel, refuses a `broken` candidate
  from the compatibility manifest the Control Plane serves, and updates only when that CLI has no turn in flight
  (opportunistic for 1 h, then new turns of that CLI wait; nothing is ever interrupted; idle CLIs are retired and
  resume on the next turn); daemon-launched CLIs run with their own updaters off; levels Automatic / Notify only / Off
  per organization, lowered per device (desktop menu, `ocw-runtime updates`, `OCW_RUNTIME_UPDATES`), Notify only until
  the server's level arrives; owners and admins (`device.maintain`) see versions, status, history and Update now in
  Settings › Devices, members only versions and an "older than supported" flag; a `broken` installed version refuses
  new sessions; every check, start and result is audited (ADR-0032).
- **07.12 Headless Work Zone server:** a Linux or macOS machine runs Work Zone sessions without the desktop app. The
  API serves the Local Runtime as one verified AGPL file built into its image, its manifest and a POSIX `install.sh`
  (`/api/v1/runtime/*`, public, rate-limited, URL only from `OCW_PUBLIC_API_URL`); the script checks the SHA-256,
  installs the Claude Agent SDK beside it from npm at exact pins (never redistributed) and writes only under `~/.ocw`
  and `~/.local/bin`; `ocw-runtime setup` pairs by device code (RFC 8628 shape, 40-bit codes, 10 minutes, single use,
  rate-limited, approved in Settings › Devices from the printed link or the new Server tab, audited), registers
  repositories, installs a systemd user or system unit or a macOS LaunchAgent (never as root, one runtime per
  `~/.ocw`, `~/.ocw/service.env` read by the daemon) and runs `ocw-runtime doctor` (13 checks with headless sign-in
  lines, safe to paste); sharing stays in the web (ADR-0033, docs/SERVER.md).
- **07.14 Organization connector auth:** MCP servers take five auth modes. Besides Organization headers and the two
  member modes, **Organization sign-in** (an admin with `mcp.manage` signs in once with the 07.4 OAuth client: PKCE
  S256, `resource`, `iss`, pre-registered → CIMD → DCR; only that admin completes the flow and `mcp.manage` is
  re-decided at the callback) and **Client credentials** (RFC 6749 §4.4, the MCP extension: client ID and write-only
  secret, token endpoint from RFC 9728 → RFC 8414 metadata or an admin Token URL, Basic or post, issuer pinned, a new
  grant before expiry, a stored secret sent only to the target it was saved for). The organization's credential is
  one sealed bundle per server (AAD `<org>:org:connector:<server>`) with state in `app.connector_org_connections`
  (tenant RLS), refreshed one at a time, revoked on Disconnect, destroyed after a confirmation on a mode switch or
  delete; it is used only through the API connector proxy, never in the cell, offered wherever organization tools
  are (no member audience rule), audited as `bot.tool_call` with `credential: "organization"`. Test sign-in names
  the first failing step from eight closed codes with one fix line each (including the public-URL check behind a
  proxy and the Cloudflare CIMD hint), never registers and never stores; the last failure shows on the server row.
  Mode questions go through shared predicates in `packages/contracts` (Semgrep `ocw.raw-auth-mode`) (ADR-0036,
  docs/self-hosting/connectors.md).
- **07.15 Bots read attachments:** the paperclip is on in personal and team bot DMs (same limits and presigned upload
  as a person DM). A bot turn lists the attachments of the messages it reads as metadata only (id, name, type, size,
  kind, per-bot access and a note; at most 20, newest history first), and a turn with readable files gets the
  turn-scoped `ocw_attachment_read`, which posts only the turn's ids to `POST /attachments/read`. The API re-decides
  each read as the asker (`liveTurn` and one row rule shared with `ocw_sandbox_import`: live, ready, linked, same
  conversation, same thread in channels, never a Work Zone image) and answers text in a labelled untrusted block
  (256 KiB range, BOM/UTF-8/UTF-16/windows-1252, 64 000 characters per file, 200 000 and 20 reads per turn on their own
  `agent_turns` counters, outside the cap of 8), an image as a tool-result image part (rendition or a ≤ 5 MiB
  original, image-capable models only) or PDF text from `unpdf@1.9.1` in a bounded worker (100 pages, 10 s, 256 MB,
  2 at a time, no eval); nothing is cached. Refusals are closed codes with fixed sentences; a read taints the turn;
  `bot.attachment_read` and `bot.attachment_imported` audit ids and counts, never names or content. Other files go to
  the sandbox under F-8. A persona-only message in a shared AI chat meets the chat model's attachment gate (ADR-0037).
- **07.16 Bot Work Zone orchestration:** a bot with a Work Zone profile starts, prompts, reads and stops Work Zone
  sessions itself through four turn-scoped tools (`ocw_work_session_start|prompt|read|stop`) decided in the Agent
  Channel API. One profile per bot (`app.bot_work_zone_profiles`, tenant RLS) names by id the device, up to 50
  projects, the runtime, default model and options with the sets the bot may pick from, default and highest mode,
  worktree and limits; the saver is the sponsor, every value is checked against the sponsor's live controls, and
  `actOnOutsideContent` is admin-only. The device's owner (or an admin, on a headless server) allows each bot, with a
  separate "Allow Full access for this bot". Status is decided live (eight closed reasons) at every call and dispatch.
  The routes run in the sponsor's transaction (`created_by` = sponsor, `started_by_agent_id` = the bot, prompts with
  `author_agent_id`); bodies cannot name a user, device, audience or worktree; caps 2 sessions and 30 prompts an hour
  per bot, 10 bot sessions per organization; the audience comes from the existing kinds, never wider than the
  conversation's readers ∩ the project's audience. Full access is ADR-0012's chain plus the per-bot consent and the
  profile's highest mode; after outside content it needs the admin's flag and a device-only `ocw-runtime
  isolated-server` mark honoured only for service hosts, otherwise the start becomes a tainted proposal. The redacted
  read model (6 000 characters of tail, repo-relative paths, never a person's prompt text) marks the turn so other
  side effects stay blocked. `work_session.bot_sync` wakes the bot in its card's thread as the original asker on turn
  done, approval, failure, end or offline (debounced, idempotent, 20 a day per session), with the live `work_zone`
  card kept current; the session page leads back to the conversation through a per-viewer `origin`. Bots never
  approve runtime requests; bots without a profile get byte-identical turns and today's proposals. Audit carries ids
  and counts only. Limits: team mentions and automation fan-out are 07.17; a `people` audience is a snapshot
  (ADR-0038, docs/SERVER.md › Isolated server).
- **07.17 Automation fan-out and team mentions:** schedules run as often as every 5 minutes (organization defaults 5
  minutes and 288 runs a day; the editor's "Every few minutes" pre-fills the runs and warns when the bot's daily limit
  is lower than the turns it can use). An `agent_turn` schedule into a channel or a board can turn on "For each new
  item": its run turn gets the batch tool `ocw_conversation_open` (`POST /agent-channel/v1/conversations/open`, up to
  25 items a call), which opens one top-level thread or one board card per new item in the run's own target only,
  deduplicated on a keyed HMAC of the item's key (`app.automation_conversations`, tenant RLS; the key never stored in
  clear), capped per run (10, 1…25) and per day (100, 1…500) under the run and automation locks. Bot-written text is
  defused. The runs post into one "<name> · Runs" thread, and the open call answers the run, so quiet runs never trip
  the breaker. Each opened item gets one ids-only `automation.item` job and one tainted, unattended
  `agent.automation_item.v1` turn in its own thread as the run-as person, with a derived event id and the bot's 07.16
  Work Zone tools. A bot moves (and sets waiting on) a card its automation opened even after outside content or a
  session read, only with the profile's admin-set `actOnOutsideContent`; card creation stays refused. Every team and
  department has a stable `@handle` (40 characters, unique per organization, generated once); `@team` on channel
  posts is a `{ kind: "unit" }` mention decided by `unit.read`, notifying the active members of the subtree who can
  read the conversation (`team_mention`, 200 a message), never waking a bot; bots resolve at most 3 teams a message.
  An automation names up to 5 people or teams its bot mentions when it finishes or needs help. Audit carries ids and
  counts only. Limits: fan-out only from schedules; items past the bot's "Sessions at once" wait and are queued
  again when one of its sessions ends (at the daily limit: the next day), at most 5 times (code review WR-02); handles
  cannot be edited; fan-out needs the matching cell image (ADR-0039, docs/self-hosting/automations.md).
- **07.17.1 Runtime self-update:** a headless server's Local Runtime updates itself to the build its workspace serves,
  with one click (**Update** on the OCW runtime row in Settings › Devices, `device.maintain`, any level) or by itself
  at the 07.11 *Automatic* level (also to an older build after a server rollback; *Off* stops the checks, the click
  still works). The daemon fetches the manifest, bundle and lockfile only from its own paired server URL (https except
  loopback or `OCW_INSTALL_ALLOW_HTTP`, no redirects, byte cap, SHA-256 of both against the manifest, new read-only
  `/api/v1/runtime/npm-shrinkwrap.json`), installs beside the running version with the fixed `npm ci`, waits until no
  turn runs on any runtime (one gate decision; new turns wait with a "Restarting the OCW runtime…" line), switches
  `~/.ocw/runtime/current` atomically and exits with 75 so systemd or launchd restarts it; the run survives the restart
  through a marker, and a prompt that never started is requeued and runs after any daemon restart instead of failing.
  Only a real service run qualifies (`OCW_RUNTIME_HOST=service`, the service manager's marker, a bundle under
  `versions/`); the previous version stays; the doctor names a build that did not come back. The runtime's version
  follows the release (0.3.1, shown as "0.3.1 · <build>"). History and audit carry builds, never a path. Limits: a
  v0.3.0 runtime still needs the install command once; no desktop app self-update, no bundle signatures, no Windows
  service (ADR-0040, docs/SERVER.md › Updates).
- **07.17.1.1 Bot file exchange with its Work Zone sessions:** a bot with a Work Zone profile gets two more turn-scoped
  tools, offered with the four of 07.16 (all six or none): `ocw_work_session_upload` copies an attachment of the thread
  (`attachmentForTurn`, decided as the asker) into its own session at a repo-relative `WorkSessionFilePath`, and
  `ocw_work_session_download` copies one regular file of the session back as a pending attachment the bot's reply
  links (`POST /agent-channel/v1/work-sessions/upload|download`, `agent-channel/work-session-files.ts`, strict ids-only
  bodies). Both work only in the session's origin conversation, run as the sponsor (`work_session.prompt` to upload,
  `work_session.read` to download), follow the 07.16 taint and session-output rules, and cost one unit of the hourly
  prompt budget each (ledger `app.bot_work_session_files`, tenant RLS, no path column), at most 5 a turn each way.
  Uploads need an idle session (one writer per tree); downloads also run while it works. The per-file limit is the
  lowest of the bot's "Largest file", the organization's "Largest file a bot moves" (25 MB default) and
  `OCW_ATTACHMENT_MAX_BYTES`, recomputed per call and named in the refusal. One shared deny list (`.git`,
  `.ocw-worktrees`, `.claude`, `.codex`, `.mcp.json`, `.env*`, keys and credentials) applies both ways in the API and,
  authoritatively, on the device, which also checks realpath containment, `O_NOFOLLOW` regular files, size, sha256 and
  free space. Bytes never cross the Device Link: `session.file.write|read` carry a path and bounds, and the daemon
  streams over `GET|PUT /api/v1/runtime/files/:transferId` on its own server URL with its device JWT (single use,
  expiring, 4 streams per process, 413 before reading, Garage multipart in 8 MiB parts). An older daemon answers
  "update the runtime". `diff.result` frames are bounded under the 256 KiB device frame. Audit
  (`bot.work_session_upload|download|refused`) carries ids, size, sha256 and the path's length, never a path. Limits:
  no downloads from a finished session, no file list on the live card, proxies and CDNs must pass the body (ADR-0041,
  docs/self-hosting/reverse-proxy.md).
- **07.17.1.1.1 Sandbox document toolkit:** the `sbx` image bakes a document toolkit at build time:
  - From bookworm `main`: poppler, qpdf, tesseract eng+spa, LibreOffice 7.4 writer/calc/impress `-nogui`, ImageMagick
    6 behind a deny-all policy with a raster allow-list, 7-Zip, exiftool, catdoc, unrtf and `msgconvert`.
  - A pip-less root-owned venv in `/opt/ocw-tools` from a 26-pin sha256 lock resolved on the image's Python 3.11.2,
    with one SPDX record per pin checked by `pnpm guard`, and PyPI/OSV evidence by `scripts/sandbox-lock-evidence.mjs`.

  The bot's `PATH` puts the toolkit after the system paths and before approved packages; its `PYTHONPATH` puts
  approved packages first (review WR-08). `ocw-extract` (`python3 -I`, children as argv in the process group `ocw-run`
  kills, without proxy variables) turns 36 types into UTF-8 text with at most 16 384 bytes on stdout, or the whole
  text with `-o`:
  - PDFs, with per-page OCR;
  - images, AVIF and HEIC included;
  - Office and OpenDocument files, legacy formats through LibreOffice;
  - CSV/JSON/XML/HTML, mail, and archive listings.

  Exit codes are 2–7 for usage, unsupported, path, encrypted, caps and failed. `--batch` writes a `.txt` mirror and
  `_index.tsv` under `/workspace/extracted/`, never touching the originals. It sizes each chunk from the exec timeout
  (`SBX_EXEC_DEADLINE_S`, refused under 260 s: the bot runs it in the background with `timeoutSeconds 600`), exits 75
  while work remains, resumes per file and per page (PDFs and Office files read through a PDF), and exits 8 when a run
  made no progress. Archives and Office zips have caps and a size watcher, within the room left under the quota.

  LibreOffice gets finalized macro and link settings (`ocw.xcd`). The macro positive control fires without them and
  never with them. sandboxd re-creates a stopped shell, or one being restarted, whose image ID or `SHELL_ENV` drifted,
  keeping its volumes. A running shell is never touched by `ensure`. The exec tool description and the attachments
  how-to name `ocw-extract`. CI: image tests, the `docs` and `drift` smoke sections, and `gvisor-smoke --only
  core,docs`. Rootfs 1 087 MiB of 1 300.

  Limits: the bookworm LibreOffice, poppler and ImageMagick CVEs are contained, not fixed, with trixie as a follow-up.
  No audio or video transcription, and no OCR languages beyond Spanish and English (ADR-0043,
  docs/self-hosting/sandbox.md › Documents in the sandbox).
- **07.17.1.1.2 Long-running bot tasks:** a bot keeps working on a request that needs many turns, by itself, in the
  same thread, scheduled only by the platform.
  - A task is a platform entity (`app.bot_tasks`, tenant RLS, one active task per bot per thread by a partial unique
    index; `running` and `waiting`, then `done`, `failed` or `stopped`), run for and paid by the person who started
    it, whose rights `turnPolicy` re-decides on every turn.
  - Three turn-scoped tools, not side-effecting and outside the 8 calls: `ocw_task_start`, `ocw_task_continue` and
    `ocw_task_finish` (`POST /agent-channel/v1/tasks/start|continue|finish`, strict ids-and-notes bodies that cannot
    name a person, conversation, budget or time), offered as `start`, `control` or `view`.
  - A continuation is the fourth server-originated trigger, `agent.task.v1`, whose text is a fixed server sentence.
    The bot's own notes travel only in `turn.task`. Its event id derives from the task and its wait sequence, so a
    retry, the backstop, the tick and a wake all deliver one turn.
  - The API is the only scheduler: the ids-only `bot_task.continue` job, the minute `bot_task.tick` (a `SECURITY
    DEFINER` lister of ids, 100 a tick) and the turn-done release (5 s after the bot's turn ends, a 30-minute
    backstop). OpenClaw's cron, heartbeat and plugin timers stay off.
  - Waits: a timer (up to 3 600 s), a sandbox background process (sandboxd's new ids-only `process` event, linked in
    `app.bot_task_processes`; a lost process wakes it at its deadline) or a Work Zone session the task started
    (`bot_work_sessions.task_id`; its 07.16 wake becomes the task's turn within budget).
  - Budgets snapshotted at start: 40 turns and 8 h by default (up to 200 and 24 h), 10 running per organization (0 to
    100, counted under an advisory lock), every turn in the bot's daily limit; one nudge turn, then `no_progress`. A
    stop posts one fixed sentence mentioning the person (none when access was lost).
  - A platform-owned `task` Agent Card shows the goal, "Turn n of N", the elapsed time, the wait, progress and next
    step, updated in place; a visible progress post at most every 5 turns or 10 minutes (the plugin drops quiet
    turns). **Stop** (`POST /api/v1/bot-tasks/:id/stop`) for the requester, channel moderators and the bot's
    managers (`viewerCan.stop`).
  - The taint is sticky and continuations have no browser tools. Settings › Bot policy › Long tasks (the switch and
    three limits) and the bot's Long tasks capability. The persona prompt gets one paragraph per offer (never claim
    work that was not scheduled).
  - Audit (`bot.task_started|continued|finished|stopped|refused`) carries ids and counts only, guarded by Semgrep
    `ocw.bot-task-text-in-audit`; CODEOWNERS covers the four task modules. Fix: the plugin keys OpenClaw's inbound
    dedupe per delivery and attempt, so Work Zone wakes and continuations on one card are no longer dropped.

  Limits: not in AI chats; no cross-conversation tasks or task list page; a turn in flight finishes after Stop
  (ADR-0042, docs/self-hosting/automations.md).
