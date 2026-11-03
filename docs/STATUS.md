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
