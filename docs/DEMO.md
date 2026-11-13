# MVP 0 demo runbook

> Installing your own instance? Follow [`docs/INSTALL.md`](INSTALL.md); this runbook is the owner's local demo.

What the demo shows, end to end, on one Mac:

1. **Chat** — Slack-style channels and single-level threads, live for every member, with `@mentions`.
2. **Bots in one click** — create an OpenClaw-backed bot from a preset, add it to a channel, mention it
   and it answers in the thread, knowing who asked and who else is in the conversation.
3. **Work Zone** — pair your computer with the desktop app, run Claude Code or Codex on a registered
   repository with **your own subscription**, while the session (prompts, queue, approvals, diff) lives
   in the platform and can be followed and steered from the web.

## Start

```bash
pnpm demo:up            # postgres + redis (compose), API :4000, web :3000, OpenClaw cell (container)
pnpm demo:up --rebuild  # same, rebuilding the web app first (after pulling changes)
```

Logs: `~/.ocw-demo/logs/`. The OpenClaw cell logs: `docker logs ocw-demo-openclaw`.

## Demo data

```bash
pnpm demo:reset                               # wipes the LOCAL database and seeds the demo workspace
ANTHROPIC_API_KEY=sk-ant-… pnpm demo:reset    # same, plus the Anthropic provider and three bots
```

Seeded workspace: organization **Autofy Labs** with one person per PRD role (`<name>@autofylabs.demo`):

| Person | Role | Units |
|---|---|---|
| Víctor Ruiz (`victor@`) | Organization Admin | member of IT |
| Alex Kim (`alex@`) | Team Lead | lead of Backend |
| Marta López (`marta@`) | Developer | member of Team Alpha |
| Sam Patel (`sam@`) | Standard User | member of Content |

Hierarchy: **IT › Backend › Team Alpha › Workspace App** (project) and **Marketing › Content**. Channels
`#general`, `#producto`, `#ingenieria`, `#lanzamiento` with a short history. The password for every demo
user is printed at the end of the seed and stored in `.env.demo` (git-ignored). With a key, bots
**@archie** (product), **@nova** (code review) and **@iris** (research) are created on Claude Sonnet 5.5
and added to their channels.

A workspace seeded before Phase 2 keeps its people but has no hierarchy and shows everyone as Developer:
run `pnpm demo:reset` when you want the roles and units above.

## Script (≈ 5 minutes)

1. **Sign in** at http://localhost:3000 as `victor@autofylabs.demo`. Open `#producto`.
2. **Model** — Settings › Models, either:
   - **ChatGPT subscription (Codex)** → *Connect* → open the link, sign in with your ChatGPT account and
     enter the code shown (see [ChatGPT subscription](#chatgpt-subscription-codex) below), or
   - **Anthropic** → paste the API key (stored encrypted, never shown again). Skip if you seeded with
     `ANTHROPIC_API_KEY`.
3. **Bot in one click** — Bots › New bot → pick the *Product Manager* preset → (on a subscription, pick
   the model *GPT-6 Astra · ChatGPT subscription*) → Create. The card goes
   *Provisioning → Ready* live (the OpenClaw cell provisions it). *Add to channel* → `#producto`.
4. **Mention** — in `#producto`, reply in a thread: `@archie resume las entrevistas en 3 puntos`. The
   typing indicator appears and the answer lands in the thread, attributed to the bot. Open a second
   browser (or a private window) as `alex@autofylabs.demo` to show it live for two people.
5. **Desktop + Work Zone** — open `apps/desktop/release/mac-arm64/OCW.app` (first time: right-click ›
   Open, it is ad-hoc signed). Server `http://localhost:3000`. In the web: Settings › Devices › Add
   device → copy the code → paste it in the app. In the app: *Add project…* → pick a git repository
   (for "the product improves itself", a clone of this repository).
6. **Work Zone session** — Work Zone › New session → your Mac, the project, **Claude Code** (or
   **Codex**), permission mode *Plan* (safe) or *Supervised* (asks before editing). Prompt, e.g.
   *"Propose one small UX improvement for the chat composer"*. Show the live stream, tool cards, the
   shared queue (add a second prompt as Alex), the approval banner, and the Changes panel.
7. **Roles and organization** — Settings › Members: each person's role, the role select (admins only)
   and **What can each role do?**, the matrix of what each role is allowed. Settings › Organization: the
   tree, Alex as lead of Backend, a unit's members. Then sign in (private window) as `sam@autofylabs.demo`:
   a Standard User chats and uses bots but has no Work Zone and no admin settings. Every decision comes
   from one permission resolver on the server, so the UI only hides what the API would refuse anyway.

## Work Zone controls

Phase 03.2 (ADR-0012, ADR-0013). What each runtime offers, and why some options are missing:
`docs/workzone/runtime-controls-inventory.md`.

1. **Model, reasoning, permission.** In a session, the composer bar has three chips. The model chip lists only the
   models your runtime reports for your subscription (search, starred favorites, "Legacy models"). The reasoning chip
   offers the effort levels, the context window where the model has two (Opus 4.6: 200k / 1M) and fast mode (off
   unless the organization allows it; the menu states its cost). The permission chip offers Supervised, Auto-accept
   edits, Auto (models that support it), Full access and Plan. A change made during a turn shows "Applies to the
   next turn". Typing `/model sonnet` or `/effort high` in the composer goes through the same checks.
2. **Allow Full access** (all three are needed; every turn's mode is audited):
   - organization: admin › **Settings › Work Zone policy** › *Allow Full access*;
   - device: the desktop app's Runtime menu › *Allow Full access on this device…* (confirm the warning), or
     `ocw-runtime full-access on` on a headless server;
   - person: the device owner, or someone the owner shared the device with at *Full access*.
   The session header and the permission chip then show the amber **Full access** badge to every controller.
   Recommended only on a dedicated machine.
3. **Share a device.** Owner › **Settings › Devices** › the device card: *Everyone in the organization* with a
   maximum mode, or *Add people or teams* with a mode each. Listed people start sessions on it without your
   acceptance and use your Claude / ChatGPT login (the card says whose). Removing someone stops their sessions.
4. **Session titles** (ADR-0014). Start a session without typing a title: it first shows the first line of your
   prompt, then, within a few seconds, a short title (2–5 words, at most 32 characters, the prompt's language)
   for every controller, shown in full in the sidebar, the header and the browser tab. The device names it with its own runtime's small model on the
   device owner's login: Claude Code uses Haiku, Codex uses GPT-6-Luna. A title you type is never replaced. When
   the Work Zone policy leaves the small model out, or the call fails or takes longer than 20 s, the first line
   stays and the session is not affected.
5. **Images in prompts** (Phase 06.1). In a session, paste a screenshot (Ctrl/Cmd+V), drop images on the session or
   use the paperclip. Only PNG, JPEG, GIF and WebP are accepted (other files are refused in place and never
   uploaded; the runtime reads the repo itself). Up to 4 images per prompt, each at most 2 MB as sent: a small PNG
   screenshot (up to 1 MB and 2000 px) goes as it is, everything else as an EXIF-free copy of at most 2000 px.
   A text is required with the images, and Send waits until every upload has finished. Every controller sees the
   images on the prompt in the stream and in the queue, and opens them full size. A model that can't read images
   is refused before anything is sent: Codex reports it per model, so the paperclip is disabled with the reason;
   Claude Code reports nothing, so if it ever happens the turn fails with "Claude Code could not read an attached
   image". Images come from the session composer, not from the New session dialog's first prompt.
   Scope: the daemon never writes images to disk, a worktree or tmp; the runtime's own transcript persistence
   (Claude `~/.claude/projects/*.jsonl`, Codex rollouts) is out of scope. That history stays on the device
   owner's machine, like the prompt text.

**Owner check before relying on Full access** (never run by an agent): on an opted-in device, start a Claude Code
session in Supervised, switch to Full access, ask for a file edit and a shell command: no approval prompt, the
badge is visible, and `app.audit_events` has `work_session.full_access_entered` and `work_prompt.dispatched` rows.
Switch back to Supervised and send another prompt: it asks again and the conversation continued (Claude relaunches
with `resume` when entering or leaving Full access). Repeat with Codex. Also check the model chip shows the alias
row (e.g. *Sonnet*) for the model the runtime reports.

**Owner check: images on real runtimes** (never run by an agent; the automated tests use a fake runtime and
synthetic fixtures). On a stack running this branch, with your desktop app connected to it:

1. Open a Claude Code session, paste a screenshot (Cmd/Ctrl+V), type "Describe this image in one sentence" and
   send. The thumbnail shows in the composer, then on the prompt in the stream, and the answer describes the
   screenshot.
2. Repeat in a Codex session. If the model chip offers a model that can't read images, the paperclip is disabled
   with the reason.
3. Open the session as a second controller (a member the device is shared with): the image is on the prompt and
   opens full size.
4. In `app.audit_events`, the `work_prompt.queued` row has `imageCount: 1` and the attachment ids, and no image
   data:
   `select action, metadata from app.audit_events where action = 'work_prompt.queued' order by occurred_at desc limit 2;`

If a runtime fails, note the runtime, the model and the message shown in the session.

## Presence and live access

Use two browsers (or a normal and a private window) side by side. Design: `docs/adr/0009-realtime-presence-and-live-reauthorization.md`.

1. **Here now** — sign in as `victor@` in one and `alex@` in the other, and open `#producto` in both. Each
   header shows the other person's avatar with a green dot. *Members* lists them first with
   "1 here now". Close one tab, and the avatar disappears from the other header within a second.
2. **Away** — switch Alex's window to another tab or minimise it. Víctor sees Alex's dot turn amber and the
   avatar dim. Come back or move the mouse, and Alex is Active again.
3. **Losing a private channel** — as Víctor, create a private channel (e.g. `#board`) and add Alex. Alex opens
   it. The web has no "remove member" action yet, so Víctor removes Alex from the browser console, on the
   channel page:

   ```js
   const api = "http://localhost:4000/api/v1", ch = location.pathname.split("/").pop();
   const { members } = await (await fetch(`${api}/members`, { credentials: "include" })).json();
   const alex = members.find((m) => m.email === "alex@autofylabs.demo");
   await fetch(`${api}/channels/${ch}/members/user/${alex.userId}`, { method: "DELETE", credentials: "include" });
   ```

   Alex's tab immediately says "You no longer have access to #board", and Alex disappears from Víctor's
   header. Removal from a public channel keeps the read-only preview, which is the same answer the API
   gives.
4. **Losing a Work Zone session** — Marta (Developer) opens a running session. Víctor changes her role to
   *Standard User* in Settings › Members. Her session page immediately says "You no longer have access to
   this session" and the stream stops. Set her back to *Developer* afterwards.

Deny rules and unit changes take effect the same way. Every API instance also re-checks each open
subscription every 5 minutes, in case a notification was lost.

**Latency numbers** — every CI run uploads the `realtime-latency` artifact (`realtime-latency.json`: p50,
p95 and max for messages, typing and presence). The build fails when any p50 or p95 reaches 500 ms.
Locally: `bash scripts/e2e-isolated.sh realtime-latency --project=desktop`. The report is written to
`e2e/test-results/`.

## Account and access

- **Profile and security** — Settings › Profile (name, avatar, status) and Settings › Security (change
  password, active sessions with a device label such as *Chrome on macOS* or *OCW desktop*, sign out a
  session or every other session).
- **Password reset** — without SMTP an admin creates a one-time reset link from Settings › Members (row
  menu › *Create password reset link*) and hands it over. Set `OCW_SMTP_URL` (e.g.
  `smtp://user:pass@smtp.example.com:587`) and optionally `OCW_MAIL_FROM` in `.env` to e-mail reset links
  from the "Forgot password?" page instead.
- **Older desktop builds** — `OCW_ACCEPT_LEGACY_DEVICE_TOKEN` (default `true`) lets a desktop app built
  before Phase 2 keep connecting with its raw device token; new builds exchange it for a 10-minute device
  JWT. Set it to `false` once every desktop app has been rebuilt. It is removed in Phase 8.
- **Rotating `BETTER_AUTH_SECRET`** — it signs the session cookies and encrypts the JWT signing keys in
  `auth.jwks`. After a rotation, delete the `auth.jwks` rows (`DELETE FROM auth.jwks;`) and restart the
  API: new keys are generated, every outstanding JWT becomes invalid, everyone signs in again and the
  clients fetch fresh tokens. Without the delete, issuing tokens fails with "Failed to decrypt private
  key". `pnpm setup:env --force` rotates the secret too.

## Module access

Turn Work Zone, AI chats or Bots off for a department, team or person (ADR-0024).

- **Where** — Settings › Organization › a unit › **Modules** for everyone in that unit, plus per-person exceptions
  ("Add person"). Settings › **Modules** does the same for the whole organization and lists the units where something
  is off, each a link to it.
- **Who** — organization admins everywhere. A team lead only on the units they lead and what is inside them, never
  above their unit and never for an admin; what a parent unit or the organization turned off shows as "Off for
  everyone in …" and cannot be changed there.
- **What "off" does** — the module disappears for those people (navigation, sidebar sections, Settings entries, deep
  links show a calm "turned off for you" page) and the API refuses it. It beats any role, admins included, and teams
  and projects inside the unit inherit it. Changes apply live in open tabs.
- **Admins** — Turning a module off for everyone in a unit also turns it off for
  organization admins who are members of that unit, even when a team lead did it; a lead can never turn it off for
  one admin in person. Turning a module off for the whole organization asks first.
- **Bots** — turning Bots off on a unit stops that unit's own bots for everyone, admins included; the card warns
  before it does.
- **What stays** — Settings › Devices (list, rename, sharing, revoke) stays when Work Zone is off; only pairing
  leaves. Existing AI chats, shares and grants are kept and come back when the module is turned on again.
- **Owner check** — turn AI chats off for a test member from their team's Modules card and watch their open tab lose
  the AI chats section and Settings › AI chat within seconds; turn it back on. Then check the audit:
  `SELECT occurred_at, actor_id, action, metadata FROM app.audit_events WHERE action = 'permission_rule.created' AND metadata->>'via' = 'module_access' ORDER BY occurred_at DESC LIMIT 5;`
  (one row per catalog pattern, with `metadata.module`; turning it on writes `permission_rule.deleted` rows).

## ChatGPT subscription (Codex)

Bots can run on **your own ChatGPT plan** (Plus, Pro, Business…) instead of an API key. The sign-in runs
inside your OpenClaw cell with OpenClaw's own Codex device-code login: the tokens stay in the cell's state
volume (`ocw-demo-openclaw-state`) and OpenClaw renews them. This app only stores which account is
connected. Design: `docs/adr/0006-subscription-sign-in-inside-the-cell.md`.

**Morning steps (first time, about 2 minutes):**

1. `pnpm demo:up` (the bots line must say `subscribed to cell`; Settings › Bots runtime shows *Connected*).
2. Sign in as `victor@autofylabs.demo` → **Settings › Models** → **ChatGPT subscription (Codex)** →
   **Connect**. Within a few seconds the card shows a link (`auth.openai.com/codex/device`) and a one-time
   code such as `E18P-OYM9T`, with a 15-minute countdown. (A code started during the night has expired; a
   fresh *Connect* gets a new one.)
3. Open the link in your browser, sign in with the ChatGPT account whose plan the bots should use, type the
   code and approve. The card turns **Connected as <your email> · ChatGPT <plan>** by itself.
4. Keep the models your plan includes (GPT-6 Astra, GPT-5.6 Terra and GPT-5.6 Luna are on by default; add
   any other id your plan exposes, e.g. `gpt-5.4`).
5. **Bots › New bot** → preset → model **GPT-6 Astra · ChatGPT subscription** → Create → *Ready* → add it
   to a channel and mention it.

**Disconnect** (card › Disconnect, confirm) deletes the sign-in from the cell; bots on ChatGPT models then
report an error until you connect again. **Switch account** starts a new sign-in.

## Personal bots, capabilities, MCP and the marketplace

Phase 3.1 (ADR-0010, ADR-0011). Use two browsers: an admin (`victor@`) and a member (e.g. a Developer).

1. **Personal bot.** As the member, sidebar **Bots › New personal bot**. The private chat opens ("Personal bot · only
   you can see this chat"); send a plain message, no `@` needed. The admin cannot open this chat.
2. **Internet.** In the chat header open **Bot settings** and turn **Internet** on. Ask something current ("what's new
   in OpenClaw this week?"): the bot searches (DuckDuckGo, keyless) and answers from the results.
3. **Admin policy, with a reason.** Admin › **Settings › Bot policy** → turn Internet off for personal bots. The
   member's switch turns off with "Turned off for personal bots by your organization". Turn it back on.
4. **Limit notice.** In Bot settings set the daily limit to 1 and send two messages: the second gets the limit
   notice instead of a reply, and the usage meter shows "1 of 1 replies today". Set it back.
5. **Memory.** Ask the bot to remember something ("remember that I work from Madrid"). Bot settings › **Memory**
   lists the note; the member can delete it. Admins never see memory.
6. **MCP server.** Admin › **Settings › MCP servers › Add**: name, URL (HTTPS, or http to an internal service), and an
   `Authorization` header (write-only: it shows as "• set"). The cell probes it: *Probing* → *Ready* with its tools
   marked Read-only / Changes data. Turn on **Allow for personal bots**.
7. **Marketplace.** Admin › **Settings › Marketplace**: search ClawHub, open a plugin, read the review (publisher,
   official/community, scan, what it adds, risk with reasons), pick the version and **Install**. The row goes
   *Installing* → *Installed* once the cell downloaded it, verified the digest and passed the install gate. On the
   demo DuckDuckGo shows *Built in* (bundled); community plugins need the typed `install anyway`.
8. **Enable a tool and use it.** Member › Bot settings › **Tools**: switch on one MCP or plugin tool and ask the bot to
   use it. Every call is checked against the turn and audited (`bot.tool_call`). Uninstalling the plugin removes the
   tool from every bot on the next turn.

Optional providers (full `docker compose` stack, not the native demo):

```bash
# SearXNG as the search provider (then Settings › Bot policy › Search provider: SearXNG)
OCW_SEARXNG_URL=http://searxng:8080 OCW_SEARXNG_SECRET=$(openssl rand -hex 32) docker compose --profile search up -d
# Sandboxed stdio MCP servers baked into the sidecar (then MCP servers › Add › Sandboxed stdio)
OCW_MCP_SANDBOX_URL=http://mcp-sandbox:8080 OCW_MCP_SANDBOX_SERVERS=everything docker compose --profile mcp-sandbox up -d
```

The real-cell proof of this flow (real ClawHub and DuckDuckGo, fake model and MCP) runs in CI on demand: add the
`cell-proof` label to the pull request (`.github/workflows/cell-proof.yml`, `scripts/cell-proof.sh`).

## Chat (Phase 4)

Phase 4 (ADR-0015, ADR-0016). Use two browsers: the admin (`victor@`) and a member (e.g. `alex@`), at desktop width
and on a phone-sized window.

**Existing install, once:** attachments need Garage (S3) and its keys. An `.env` written before Phase 4 lacks them;
nothing else depends on them, and without them the paperclip is simply hidden.

```bash
pnpm setup:env --add-missing   # appends only the Garage/S3 keys your .env lacks; never rotates existing values
docker compose up -d garage    # Garage next to postgres/redis (S3 API on 127.0.0.1:3900, restarts with Docker)
pnpm demo:up                   # restart the API so it reads the new keys
```

Do not use `pnpm setup:env --force` to upgrade: it rotates every secret, database passwords included.

1. **Sidebar by department.** Channels sit under their department or team (Settings › Organization owns the tree);
   **New channel › Belongs to** places one, the owner or an admin moves it later. Views at the top: **All,
   Mentions, Threads, AI Chats, Saved** (a segmented row on phones).
2. **DMs and groups.** **Direct messages › New message**: pick a colleague for a 1:1, or up to 8 people and team
   bots for a group. Membership is fixed; bots in a group answer only when `@mentioned`, at the top level.
3. **Mentions and the inbox.** `@alex` in a channel: Alex's **Mentions** count and the channel's mention badge
   update live; opening the item lands on the message, highlighted. `@channel` / `@here` notify everyone / everyone
   online (a confirmation above 20 members, at most one per minute per channel).
4. **Unread.** Badges count messages, live on every tab and device. **Mark unread** on any message (or the header
   bell menu) holds the conversation unread until you read it again.
5. **Preferences and pop-ups.** Header bell: mute, or *All new messages / Mentions only / Nothing* per
   conversation. Settings › **Notifications**: do not disturb, the default level, desktop and web pop-ups (the
   browser asks only after *Enable notifications*). The desktop dock badge mirrors unread mentions.
6. **Search.** **⌘K** (or the search button on phones): type `migracion` and it finds "migración"; Enter opens the
   message highlighted. **See all results** filters by channel, person and date.
7. **Files.** Drop, paste or pick files in a channel, thread or DM: the tray shows upload progress; images get a
   preview grid and a lightbox, other files a card with **Download**. Files are limited to 25 MB and 10 per message.
8. **Reactions, pins, saved, links.** Hover a message (long-press on a phone): quick reactions or the full picker,
   **Pin** (the header's *Pinned* sheet jumps to it), **Save for later** (the *Saved* view), **Copy link** (opens
   the message highlighted, with *Jump to latest*). Edit and delete your own messages; "(edited)" shows for
   everyone, live.

## AI chats (Phase 5)

Phase 5 (ADR-0017, ADR-0018). A private ChatGPT/Claude.ai-style assistant for every member: **Chat › AI Chats ›
New chat** (or the pencil next to *AI chats* in the sidebar). Nobody else sees a member's AI chats, admins included.
`pnpm demo:up` applies the Phase 5 migrations (the existing Anthropic key moves onto a `SecretReference` by itself).

1. **Your own ChatGPT plan (the default).** Settings › **AI chat** › **Continue with ChatGPT** (again in the dialog) opens
   OpenAI's sign-in in a new tab. Sign in with your own Plus or Pro account and approve. The tab then lands on an
   unreachable `http://127.0.0.1:1455/auth/callback?…` page: that is expected. Copy that whole address, paste it
   into the dialog and press *Connect*. The card shows **Connected · <your email> · <plan>**, and a one-time welcome
   explains that usage counts against **your** plan, never the organization's bill. In the **desktop app** the same
   button needs no paste: the app catches the `127.0.0.1` callback itself for one sign-in (5-minute limit;
   *Paste the address instead* falls back to the paste step). Each member connects their own plan; tokens are
   sealed for that member and never shared. *Manage usage* opens `chatgpt.com/settings/usage`; *Disconnect* revokes
   the tokens at OpenAI. A ChatGPT account that is not eligible (some Business/Enterprise seats) falls back to
   organization models with the reason in the model picker.
2. **Organization models (METERED).** Admin › Settings › **Models**: an **Anthropic** or **OpenRouter** key (the
   demo seed adds Anthropic when run with `ANTHROPIC_API_KEY`). Its allowed models appear in every member's picker
   under *Organization models · METERED · billed to your organization*; the answer footer shows tokens and the
   estimated cost (`1.2k in · 340 out · $0.004 · Claude Sonnet 5.5 · METERED`). The same allowed list governs bots.
   Claude is only available this way: Anthropic does not allow third-party apps to use Claude Pro/Max logins.
3. **In a chat.** Pick the model per message (chip under the composer). **Stop** (or Esc) keeps the text so far;
   the last answer's **Regenerate** offers *Regenerate with…* another model. The first answer names the chat;
   rename, archive and **Chat settings** (instructions for this chat) are in the header menu, and Settings › AI
   chat › Preferences holds personal instructions, the default model and *Web on by default*. The paperclip (or
   paste/drop) attaches images, PDFs and small text files when the selected model can read them. ⌘K finds your
   own AI chats by title and text.
4. **Web.** The composer's **+** menu: Web, Company knowledge, MCP and Skills (the last three say *Not available
   yet*). On your ChatGPT plan Web uses the plan's own search and answers show source chips. On organization models
   Web uses a self-hosted **SearXNG**, which the native demo cannot reach (it lives only on the compose network), so
   there the menu says *Web search needs the search service (SearXNG)*. On the full `docker compose` stack:
   `OCW_SEARXNG_URL=http://searxng:8080 OCW_SEARXNG_SECRET=$(openssl rand -hex 32) docker compose --profile search up -d`
   (`OCW_AI_SEARXNG_URL` overrides it for AI chats only). Admins can turn Web off in Settings › Models › AI chats.
5. **Limits and usage.** Admin › Settings › Models › **AI chats**: who pays, daily limits per member (organization
   models: answers and dollars; ChatGPT plans: optional), the allowed plan models and the title models; **Usage**
   below shows 7/30/90 days by member or by model, with costs. A member sees their own today and last 30 days in
   Settings › AI chat › **Usage**; at the limit the composer says when it resets and offers their own plan.
6. **Share.** Header menu › **Share** → *Create link* → *Copy*. Anyone **signed in to the same organization** reads
   a frozen, read-only snapshot at `/share/ai/<id>` (later messages are not included); it is never public, a
   signed-out browser goes to sign-in, and *Revoke* makes the link answer "This link isn't available".

**Owner check before relying on the ChatGPT plan** (never run by an agent; record the result in
`.planning/phases/05-direct-ai-chat/05-VALIDATION.md` › Manual-Only Verifications):

1. Settings › AI chat › Continue with ChatGPT with your own Plus/Pro account, paste the `127.0.0.1` address →
   *Connected*.
2. In the desktop app, Disconnect and reconnect **without** pasting.
3. One AI chat turn on a plan model streams; **Stop** keeps the partial text; the footer says "ChatGPT plan".
4. If a Business/Enterprise seat is available, connect it and note *Connected* or *not eligible* (it must fall back
   to organization models).
5. Review `.planning/phases/05-direct-ai-chat/05-UI-REVIEW.md` and the `review-*` screenshots.

## Multiplayer AI chats (Phase 6)

Phase 6 (ADR-0019, ADR-0020). An AI chat can be shared **in place**: the same conversation, never a copy. `pnpm demo:up`
applies the Phase 6 migration.

1. **Share with a person, a team or everyone.** Header menu › **Share** › *People and teams*. The box at the top says
   exactly what they will see: the whole conversation, every file, this chat's instructions, the model behind each
   answer, the tool settings, who has access and the other participants. It also says that your personal
   instructions stop being used from now on. Search a colleague, a department, team or project, or *Everyone at
   <org>* (which asks for a confirmation), pick **Can chat** or **Can view** and press *Share*. Each row's menu changes
   the level or removes access (confirmed); a removed person's open page says "You no longer have access to this
   chat." at once. The old link section is now *Read-only link (frozen copy)*.
2. **Where it shows up.** People you share with get an inbox item (*shared an AI chat with you*); everyone with access
   finds it under **Shared with me** in the sidebar and on the AI Chats page, with unread counts. The header shows who
   is here (presence) and how widely it is shared (*Shared with Backend*); the chip opens the participants list with
   each person's access.
3. **Writing together.** Every message carries its author. The model answers when a message mentions nobody, or when
   the author leaves **Ask AI** on; @-mentioning a person turns Ask AI off (*Not sent to AI*). While an answer runs,
   others keep writing: their questions wait (*Queued*, and the chip says "AI is answering Víctor · Alex is next"),
   then one coalesced answer replies to all of them by name. **Each person's question runs on their own ChatGPT plan
   or an organization model they pick, never the owner's**: the footer says who it was for and who paid (*for Alex
   Kim · Alex's ChatGPT plan*). Stop belongs to the person who asked (and the owner). *Can view* readers see
   everything live but have no composer.
4. **Personas (bots) in a chat.** Admins and team leads create bots scoped to the organization or to a department,
   team or project (Bots › New bot › *Who can use it*); a unit's bot is visible only inside that unit. In an AI chat,
   the owner adds one from the participants list › **Add an agent** (personal bots are never offered). Mention it
   (`@backend …`): the bot answers in the chat through the OpenClaw cell, sees the conversation with everyone
   attributed, and never gets anyone's memory. Tools that not everyone in the chat may use are withheld, and it says
   so. Any persona in a chat counts as sharing it, so your personal instructions stop there too.
5. **Agent Cards.** Bots can post cards (deployment, approval, report, …) in channels, DMs and AI chats: a title,
   fields, a status that changes in place, and **Open** (always a page inside the app), **Follow** (you are notified
   when its status changes) and **Approve / Deny** (confirmed, decided once, visible to everyone, and sent back to
   the bot). *Can view* readers can follow a card but never decide it.

**Owner checks for Phase 6** (never run by an agent; record each result in
`.planning/phases/06-multiplayer-ai-chat/06-VALIDATION.md` › Manual-Only Verifications):

1. **Metered spoofing eval** (MULTI-07, D-02; ≈ $0.15–0.40 per run, on your key). First the plan and the cost, no
   request: `OCW_EVAL_DRY_RUN=1 pnpm --filter @ocw/api eval:multiplayer`. Then the real run with an OpenRouter key:
   `OCW_EVAL_CONFIRM=metered OCW_EVAL_PROVIDER=openrouter OCW_EVAL_API_KEY=<your key> pnpm --filter @ocw/api eval:multiplayer`.
   Expected: every case passes (at least 2 of 3) on both models; the report lands in `apps/api/eval-out/` (gitignored,
   key redacted). The CI workflow `ai-eval.yml` (label `ai-eval`, weekly, manual) runs the same once GitHub Actions
   billing is back and the `OCW_EVAL_API_KEY` secret is set.
2. **OpenAI's terms for a ChatGPT plan in a shared chat** (D-01, NEEDS VALIDATION in ADR-0019). Read OpenAI's current
   terms and help for using a ChatGPT plan through "Sign in with ChatGPT" in an app where colleagues read the answers.
   If it is not allowed, shared chats must answer on organization models only (a new ADR supersedes ADR-0019 §5).
3. **Visual review** (D-08) of the screenshots in `.planning/phases/06-multiplayer-ai-chat/screenshots/`:
   `multiplayer-*`, `share-*`, `shared-*`, `participants-*`, `personas-*`, `ai-chat-agent-*`, `agent-card-*` and
   `day-*`, at 1440 and 390, light and dark.
4. **Confirm D-06**: a chat with any persona counts as shared, so the owner's personal instructions are excluded
   (decided by the orchestrator under your delegated autonomy in 06-12).

**Still open:** personas in AI chats and the `ocw_agent_card` tool are proven against a fake OpenClaw cell only; the
real-cell smokes (`infra/openclaw/test/run-container-smoke.sh`, scenario `card`) run when CI comes back (GitHub
Actions billing).

## Board channels and record templates (Phase 07.1)

Phase 07.1 (ADR-0022). A channel can be a **board**: cards in columns, and every card is a thread with its people and
its bots. Record templates give every card of a kind the same fields, columns and name. `pnpm demo:up` applies the
Phase 07.1 migration.

1. **Create a board.** **Create channel** › *Layout* › **Board**. It belongs to a unit like any channel and starts with
   Backlog, In progress, Done and Cancelled (or the template's columns, item 9). The header row has **Board | Messages**
   and **New card**. Board is the default view, and Messages is the channel's ordinary list, where every card is its
   root message.
2. **Cards and threads.** **New card** (or **+** on a column) asks for a description, an optional title, the column
   and who it is waiting on. The tile shows the number (on numbered boards), the title, the waiting chip, the author
   and the replies. Click a card to open its thread. The **card strip** at the top shows the number, a typed title, the
   column and waiting state as menus, **Edit card** for its author and the field values. Replies work as in any
   thread.
3. **Moving cards.** Drag a card by its grip. With the keyboard, focus the grip, press Space, use the arrows (up,
   down, or another column), then Space to drop; Escape cancels and a screen reader hears each step. Every card's
   **⋯** menu has **Move to…**, Move to top and Move to bottom. On a phone the columns are tabs: long-press a card to
   drag it within its column, or use **⋯** › Move to…. Two people moving cards at once end in the same order on both
   screens; if you both move the same card, one of you sees "Someone else changed this card. Showing the latest."
4. **Waiting states.** **⋯** › *Waiting on…* sets *Us*, *Customer*, *Both* or nobody, shown as a chip on the tile. A
   column can set it for every card that enters it (item 5).
5. **Columns (the channel's owner and admins).** The **⋯** on a column header renames it, changes its category
   (backlog, started, done, cancelled), sets *When a card enters* (a waiting state, or *Keep as is*) and moves it
   left or right; **Add column** sits after the last lane (on a phone, **+** after the tabs). Deleting a column with
   cards asks where to move them; a board keeps at least one column, and at most 20.
6. **Editing and deleting your card.** Its author edits the title, description and fields (card **⋯** › *Edit card…*,
   the strip, or *Edit message* on the root, in the thread or in Messages). A typed title stays as typed; an automatic
   one follows the description and fields. The author or a moderator deletes a card (*Delete card…*).
7. **Search.** Chat search finds cards by their title, description and field values, with the same readable-set rule
   as any message. A hit opens the card's thread over the board.
8. **Agents on a board.** Mention a bot in a card (`@clerk can you order the part?`), or let a reply-mode bot answer:
   it replies inside that card's thread. On a board's turn the bot also gets the `ocw_board_card` tool: it can read
   the board, create cards, move the thread's card (or cards it created) and set their waiting state. It never edits
   a card's text, and everything it does is audited as the bot acting for you.
9. **Record templates.** Settings › Organization › a unit › **Record templates** (right after Modules) › **New
   template**: fields (text, number, date, choice), columns with their category and waiting state, a prefix and a
   naming rule from the chips (e.g. `EXP-0001 · Acme · Broken pump`), with a live preview tile. Team leads manage
   their own units' templates and admins the organization-wide ones; everyone in the unit sees them. When you create a
   board in that unit (or below it), pick the template under *Template*; the board copies it, so later template edits
   only affect new boards.
10. **Offline.** If the connection drops for more than 3 s, the board says "You're offline. Changes from others will
    show up when you reconnect." On reconnect it catches up without a reload.
11. **Limits.** 20 columns and 20 fields per board; a column shows its first 100 cards and then **Show more cards**.

**Owner check: a real ops board** (never run by an agent; record the result in
`.planning/phases/07.1-board-channels-and-record-templates/07.1-VALIDATION.md` › Manual-Only Verifications). On a
stack running this branch:

1. On your operations team's unit page, build a **Case file** template: a prefix (e.g. `EXP`), a *Customer* field, the
   columns your team really uses (with "Waiting for customer" setting *Customer*), and the rule
   `{prefix}-{seq:0000} · {field:customer} · {summary}`.
2. Create a board channel from it in that team and invite a colleague.
3. Run a day's cards with that colleague, one of you on a phone and the other on a laptop at the same time: create
   cards, move them, set waiting states, discuss in the card threads, mention a bot in one card.
4. Say what felt slow or unclear: names, columns, moving on the phone, the card strip, search, the template editor.

## Memory (Phase 07.2)

Phase 07.2 (ADR-0023). Memory is Markdown files kept by the workspace, per scope: your private memory with each bot,
bot notebooks, every department, team and project, and the organization. People read and edit them; bots read them in
their turns, write only their own, and propose changes to shared memory that a person approves. `pnpm demo:up`
applies the Phase 07.2 migrations; your bots' old notes are already in your private `MEMORY.md` with each bot.

1. **Open Memory.** Main nav › **Memory** (between Bots and Work Zone). The tree lists only what you may read:
   *You & {bot}* (**Private**: only you, admins can't), *{bot} notebook*, your units in chart order, then
   *Organization*. Desktop opens the first scope's `MEMORY.md`; on a phone the tree is full screen and a scope expands
   in place. Arrow keys move through the tree; **Search memory** finds words in files and paths, grouped by scope.
2. **Edit.** On a file you may write: **Edit** (or `?tab=edit`), change the Markdown, **Save** (⌘S). A secret (an API
   key, a password line) is refused with the line and a masked sample; nothing is stored. If someone saved while you
   were editing, **Choose what to keep** offers *Keep mine* or *Use theirs*. File **⋯**: *Rename or move…*,
   *Delete…*, *Copy path*; **New file** and **New folder** in the header. `MEMORY.md` can be edited, never renamed or
   deleted.
3. **History.** **History** lists every version, who wrote it (a bot shows "{bot} for {person}", an approved change
   "Approved by {person}") and a diff against the previous one. **Restore version N** writes it back as a new version;
   nothing is lost.
4. **Ask your bot to remember something.** In your DM with your personal bot (Bots › **New personal bot** if you have
   none): "remember that I prefer calls after 4 pm". It appends to your private `MEMORY.md`; the DM's **Memory**
   button shows the note and **Open in Memory** opens the file. Your private memory is used only in that one-to-one
   DM.
5. **A proposal to team memory, approved by the lead.** Sign in as Marta (Team Alpha) and, in her DM with her personal
   bot, ask: "save a note in Team Alpha's memory: the staging deploy is on Thursdays". The bot cannot write team memory,
   so it proposes. A card **Created by the workspace** appears in the DM: *Create {path}*, the memory, how many people
   will read it, what the scan found, *Waiting for a reviewer*. Sign in as Alex (lead of Backend, so a decider for Team
   Alpha): **Memory** shows a badge, **Proposals** › *To review* › the proposal: readers, findings, the diff. Press
   **Approve…**, add an optional note, **Approve and apply**. The file is written as that exact version ("Approved by
   Alex Kim" in its history); Marta's card turns *Applied* live and her bot hears the decision. **Deny…** with a note
   leaves memory unchanged and the card *Denied*. Nobody approves their own team proposal, and nothing is approved
   automatically.
6. **A bot's page.** Bots › a bot › **Open page**: its memory (the scopes you may read, *Open in Memory*) and its
   capabilities, read-only.
7. **Admins.** Víctor sees every unit's and the organization's memory, and no one's private memory, not even through
   search.
8. **Extended sensitive-data scan (optional).** Turn on the `pii` profile ([INSTALL.md › Sensitive-data
   scan](INSTALL.md#sensitive-data-scan-optional-pii-profile)): two lines in `.env`, then restart. Proposals then also
   flag names and places in Spanish and English. If Presidio does not answer, the card and the review say
   *Extended scan unavailable — review the text yourself*.
9. **Module.** Settings › Modules › **Memory** turns it off for the organization, a unit or a person (ADR-0024).

**Owner checks** (never run by an agent; record the results in
`.planning/phases/07.2-scoped-memory-files-and-governed-promotion/07.2-VALIDATION.md` › Manual-Only Verifications). On
a stack running this branch:

1. **Spanish Presidio accuracy on real documents** (WINDOWS 121). With the `pii` profile on, have your bot propose a
   few real Spanish notes into a team's memory: client notes with names, places, NIF/NIE, IBANs, phones and e-mails.
   On each review, check what the scan found and what it missed (the automated smoke only proves fixed samples, and a
   Spanish name was missed in one probe). Note every miss and every false alarm.
2. **A real memory flow on a phone and a laptop.** With a colleague, one of you on a phone and the other on a laptop
   at the same time: edit a team file on both (see the conflict choice), restore an old version, ask a bot to remember
   something and to propose a team note, approve it from the phone and deny another from the laptop, follow the card
   in the DM. Say what felt slow or unclear: the tree, the editor on the phone, the review, the card, search.

## Connectors and keychain (Phase 07.4)

Phase 07.4 (ADR-0025, [self-hosting/connectors.md](self-hosting/connectors.md)). A shared bot acts with the account of
whoever asked: each person connects their own account once, keys are used by handle and never shown to the bot, and
people start their own agent from a team template. The demo has no real provider: member sign-in needs HTTPS, so on
`localhost` it works and on a LAN name it reads *Needs HTTPS*.

1. **A per-member connector (Víctor).** Settings › MCP servers › **Add**: a remote MCP server you have an account on,
   **Authentication › Member sign-in**. Copy the **Redirect URI** into the provider's app registration, then
   open **Pre-registered client (optional)** and paste its issuer and client id (and secret, if any). The card reads
   *Waiting for a member to connect*. Grant one of its tools to a team bot (Bots › the bot › Capabilities).
2. **Connect from the card.** As Marta, DM that bot and ask something that needs the tool. The bot answers that you
   have not connected, and a card **Connect your {connector} account** appears. **Connect** opens Settings ›
   Connections with the row highlighted; **Connect** goes to the provider's sign-in and back: *{connector} connected.
   Ask your bot again.* **Back to chat** returns to the DM; ask again and the answer comes from Marta's own account.
3. **Each person their own account.** As Sam, ask the same bot the same thing: Sam gets his own card, never Marta's
   data. Settings › Connections shows each person only their own row (*Connected as … · since today · last used …*).
4. **A shared channel.** As Marta, mention the bot in `#ingenieria`: it says it can only use her account in a private
   chat and links **Allow {connector} in #ingenieria**. The dialog says how many people can read the results before
   **Allow**; after it, the bot uses her account there. **Revoke** under *Allowed in shared conversations* stops it on
   the next message.
5. **A key by handle.** Settings › **Keychain** › **Add key**: an API key for the service's host, granted to your
   personal bot. The row shows a handle like `k_abc2def3gh`; the value is never shown again. Ask your personal bot to
   call the service: it names the handle, the API sends the key, and the row reads *last used just now*.
6. **Templates.** As Alex (lead of Backend): Bots › Templates › **New template**, publish v1. As Marta: **Start** it;
   the dialog lists what the personal-agent caps leave out and the connectors to connect. Publish v2 as Alex: Marta's
   agent shows *Update available*; only she applies it.
7. **Bots off.** Settings › Modules › **Bots** off for Sam: Connections still lists his connections and allowed
   conversations so he can disconnect and revoke; connecting needs Bots on.

**Owner checks** (never run by an agent; record the results in
`.planning/phases/07.4-per-member-connectors-agent-keychain-and-templates/07.4-VALIDATION.md` › Manual-Only
Verifications and in ADR-0025 › Validation). On an instance with HTTPS (`pnpm ocw enable proxy`):

1. **A real provider (research A3).** Register a real MCP server per member (a pre-registered client, or the client
   metadata URL where the provider supports it). Connect two people; ask the same bot in each DM and check each answer
   comes from that person's own account. Leave it an hour (or past the token's lifetime) and ask again: it must answer
   without a reconnect (silent refresh). Disconnect one person and check at the provider that OCW's access is gone.
2. **Reconnect after a revoke.** Revoke OCW's access at the provider for one person, then ask the bot: the card must
   read **Reconnect your {connector} account**, the bot must say the sign-in stopped working, and Settings ›
   Connections must show *Access revoked* with **Reconnect**.
3. **A phone.** Do steps 2 and 4 above from a phone: the card, the provider's sign-in, **Back to chat** and the share
   dialog must all fit and work with a thumb.

## Per-tool approvals and Work Zone proposals (Phase 07.5)

Phase 07.5 (ADR-0026). An organization decides, tool by tool, which bot actions need a person first; the person sees
exactly what will run and approves it once. Bots can also propose a Work Zone session that only the person who asked
can start. The demo's bots run through the fake cell, so the bot side is scripted; everything a person does is real.

1. **A rule (Víctor).** Settings › **Approval policies** › Organization. Expand an MCP server (or a connector), open a
   tool that changes data, choose **Always ask** and **The person who asked**, **Save rule**. Settings › MCP servers now
   shows *Needs approval* next to that tool. **Change history** lists the change.
2. **Ask in a DM (Sam).** Ask a bot that has the tool to use it. The bot says it is waiting for your approval, and a
   card shows the exact action: the tool, the source and every value it will send, *Runs once, with exactly these
   values · Expires in 24 h*. **Approve** (confirm): the card reads *Approved*, then *Used* once the bot ran it, and the
   bot reports the result. The rail shows **Approvals** with a count while something waits.
3. **A lead approves (Marta).** As Víctor, add a rule on the **Sales** unit for the same tool with **Leads of Sales**.
   Sam (a Sales member) asks the bot in a channel: the channel shows a summary card only (*Only Sam Lee and the
   approvers can see the details.*). Marta opens **Approvals**, reviews the exact action and **Approve**s: the bot runs
   it as Sam's turn in the channel and Sam's card reads *Used*. Sam's own review says *Waiting for a lead of Sales*.
4. **Deny with a note.** Repeat 3 and **Deny** with a note: the bot says Marta denied it and quotes the note; the same
   action asked again within 24 h is refused without a new card.
5. **A Work Zone proposal (Sam).** With Sam's device online, ask his bot to fix something in a project: a **Work Zone**
   card proposes the session (project, device, runtime, *Supervised*, the prompt). Only Sam sees **Start session**;
   others read *Only Sam Lee can start this session.* Start it: the session opens with the bot's prompt, credited
   *Sam Lee · proposed by {bot}*. Take the device offline first to see Start wait with the reason.

**Owner check** (never run by an agent; record the result in
`.planning/phases/07.5-per-tool-approvals-and-work-zone-proposals/07.5-VALIDATION.md` › Manual-Only Verifications and
in ADR-0026 › Validation). On your own stack, with a real connector or MCP server and a real model:

1. Add an **Always ask** rule for one connector tool that writes something you can check at the provider.
2. Ask your bot to use it in a DM: approve once **from the card**. Check at the provider that exactly the values on the
   card were written, once.
3. Ask again in a channel where the rule's approver is someone else: approve once **from `/approvals`**. Check the
   channel only ever showed the summary card and the provider received exactly the reviewed values, once.
4. From a **phone**, ask your bot to propose a Work Zone session on one of your devices and **Start** it from the card:
   the session must start in Supervised mode, on that device, with the bot's prompt.

## Sandboxes and live browser (Phase 07.8)

Phase 07.8 (ADR-0029, [self-hosting/sandbox.md](self-hosting/sandbox.md)). Each bot gets its own sandbox (files, a
shell, approved packages) and its own browser that people watch live and take over to sign in. It needs the `sandbox`
compose profile (INSTALL.md › Bot sandboxes and browser); without it Settings reads *The sandbox service isn't
reachable*.

1. **Turn it on (Víctor).** Settings › **Sandbox & Browser**: the Isolation card says what the server gives (*Isolated
   with gVisor* or *Hardened container · weaker isolation*). Turn on *Sandbox & Browser for the organization* and read
   the dialog's sentence before **Turn on**. Then Bots › a team bot › **Capabilities**: Sandbox and Browser on
   (*Applying. Ready in a few seconds.*).
2. **Files (Marta).** DM the bot: "write a CSV with three rows to reports/q3.csv and show it". The reply shows *Used its
   sandbox · 2 steps*; expand it to see the masked command and its output. Bots › the bot › **Sandbox**: the file is
   there; preview, download, upload one of yours, delete it. Stop and Restart keep the files.
3. **The browser (Marta).** Ask the bot to open a public page and summarise it. While it works the chat says *{bot} is
   reading the page on {host}*; **Watch** opens the small live window (drag it, F6 reaches it). **Expand** shows the
   large view; only the person who asked gets **Take control**.
4. **Network rules (Víctor).** Settings › Sandbox & Browser › Network: Shell **Allowlist** with no hosts, then ask the
   bot to `curl` a site: refused, and the activity says so. Add the host and ask again.
5. **A package (Víctor).** Sandbox packages › **Add package** › npm, `left-pad`, `1.3.0` › Review: the sheet shows the
   digest, *No dependencies* and the risk. **Approve**; the row reads *Installing* until the bot's sandbox next starts
   (Stop and Restart it), then *Installed in 1 bot*.
6. **Stop everything (Víctor).** Stop everything › confirm: the red banner names you; the bot answers that an admin
   stopped all sandboxes. **Resume**.

**Owner check** (never run by an agent: it needs a real site and your own account; record the result in
`.planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/07.8-VALIDATION.md` › Manual-Only Verifications and in
ADR-0029 › Validation). On your own stack with the `sandbox` profile and a real model:

1. In your DM with a bot that has Browser on, ask it to open a page of a site of your choice that needs your account
   and do something there (e.g. "open my invoices on {site} and tell me the latest one").
2. The bot posts **Sign in needed** with the site's host. **Open and sign in**: the large view opens in control
   (*{bot} is paused*). Sign in yourself, including any one-time code, then **Hand back**.
3. The card reads *Signed in until {date}* and the bot continues signed in and answers.
4. Check: a second person who can read that conversation sees *Private browsing for {you}* and no page; your password
   appears nowhere in the bot's reply or its activity; Settings › **Keychain** › *Browser sessions* lists the site with
   that bot; ask the bot to open another site: it asks you first. **Revoke** the sign-in and ask again: the bot is
   signed out.
5. Repeat steps 2–3 from a **phone** (the full-screen sheet, the keyboard button, the system Back).

## Shared Work Zone projects and session visibility (Phase 07.9)

After this upgrade, an existing Work Zone session is seen only by its creator, the owner of the device it runs on,
people the device is shared with, and admins. Before, every Work Zone user saw every session. Link a repository to a
team project to share its sessions with the project.

This narrowing is deliberate (ADR-0030, D-06). The same upgrade blanks the session snapshots the organization stream
used to store (titles, branches and device names readable by every member); that cannot be undone. From then on a
session's updates go only to the people who can see it.

Phase 07.9 (ADR-0030). A team project is a unit of kind *project* under a team or department (the demo has **Workspace
App** under Team Alpha). Its people are its members plus the members of its assigned teams, and admins. Repositories
your devices announce link to it from any device; an unlinked repository stays a personal project of its device.

1. **A team project (Víctor).** Work Zone › **Browse projects** (above Devices in the sidebar) › Workspace App › **Settings**:
   *Access* says how many people can open it. **Assign teams** › Team Alpha (Marta's team). **Link a repository** ›
   one of your Mac's repositories.
2. **The default switch (Víctor or Alex, who leads Backend above it).** *New sessions* › **Visible to everyone in the
   project**, on by default. Turn it off: the toast reads *New sessions in Workspace App start as Only me*. Turn it
   back on.
3. **The chip and the panel.** Open a session on the linked repository: next to the presence avatars a chip reads
   **Project**. Click it: four choices (Only me, Everyone in Workspace App, Teams, People), each with one line, and a
   footer with who can see it now and the line that admins and the device owner always can.
4. **The new-session line.** **New session**: repositories are grouped under their team project, then *Personal* by
   device. Under the picker, *Visible to: Everyone in Workspace App · Change* opens the same panel; what you pick is
   what the session starts with.
5. **Narrowing live (two browsers).** Marta opens the session. Víctor picks **Only me** in the chip: Marta's page turns
   into *You can no longer see this session* within a second, without a reload, and the row leaves her sidebar. Víctor's
   toast offers **Undo**; after Undo, Marta's page offers **Open session**.

**Owner check** (never run by an agent: it needs your upgraded data; record each result in
`.planning/phases/07.9-shared-work-zone-projects-and-session-visibility/07.9-VALIDATION.md` › Manual-Only
Verifications). On a stack upgraded from the current release with the demo data and a session Víctor ran before the
upgrade on his Mac:

1. As Marta (a developer who is not the creator, the device owner, a device grantee or an admin), the old session no
   longer appears in the sidebar and its URL shows *Session not found*. As Víctor, link its repository to Workspace App
   and assign Team Alpha (step 1 above): the session appears in Marta's list.
2. In two browsers, Víctor turns a Workspace App session to **Only me** from the chip; Marta's open session switches to
   *You can no longer see this session* with no reload. **Undo** brings it back.
3. On a phone (390 px), the chip is a single icon on the default and the panel opens as a bottom sheet; every control
   is easy to hit.
4. As a project lead (Alex) or Víctor, turn **Visible to everyone in the project** off; the next new session starts as
   *Only me* (its chip reads Only me). The sidebar shows no lock for it, because Only me is now the project's default:
   the lock appears only on sessions that differ from the default, such as an Only me session in a project whose
   switch is on.
5. Workspace App › Settings › Repositories › **Unlink** a repository: the dialog says how many sessions become personal
   and who will still see them.

## Work Zone sidebar by team (Phase 07.10)

Phase 07.10 (ADR-0031). The Work Zone sidebar is organised like the chat sidebar, by team, on the desktop and in the
phone drawer:

- **Needs you** (on top, only when something waits on you): sessions with an approval you can decide ("Needs
  approval") and your own finished turns you haven't opened yet ("Your turn", for 24 hours).
- **One section per department** with the team projects you belong to (your departments first). A project under a
  team shows the team as a pill and "● n" while sessions run. Clicking the project opens its page. Under it, at most 3
  active sessions, then "+N more" (the project page). Sections collapse and stay collapsed in this browser.
- **Personal**: your repositories that are not in a team project, and sessions from a project you can't open, by
  repository, with no project name.
- **Settled** (collapsed): finished sessions, 10 at a time. Searching replaces the tree with Projects, Sessions and
  Repositories.
- **Browse projects** and **Devices** at the foot. Projects you only manage (admins, leads above a project) are there
  and in search, not in the sidebar.
- **"+"**: on a department (hover, always on touch) creates a team project there; on a project or a repository
  (hover) starts a session there; the header "+" still opens New session. With no team project yet, one line reads
  *Share sessions with your team → Create project*.

Session titles under a project are cut with an ellipsis when long; the full title shows on hover, in the session
header and in the browser tab (a deliberate change of phase 03.2's D-20, see check 5).

**Owner check** (never run by an agent: it needs the demo data and real devices; record each result in
`.planning/phases/07.10-work-zone-sidebar-by-team/07.10-VALIDATION.md` › Manual-Only Verifications). On the demo data
with Workspace App set up as in the 07.9 steps above (Team Alpha assigned, a repository of Víctor's Mac linked):

1. As Marta, her department's section (IT) lists **Workspace App** with Team Alpha's pill and its active sessions: at
   most 3, then "+N more", which opens the project page.
2. As Víctor (admin), the sidebar lists only the projects he belongs to. Workspace App is not one of them (he reaches
   it as an admin, not as a member), so it is not in his sidebar; **Browse projects** lists it with the rest.
3. Add Víctor to Workspace App (its Settings › People) so it is one of his projects. With his Mac shared with Marta
   (Settings › Devices), Marta starts a Supervised session on it in Workspace App and it asks for an approval: the
   session appears at the top of Víctor's sidebar under **Needs you** ("Needs approval") and leaves, without a reload,
   once he decides it. Before he is added, the approval is not in his Needs you: an admin's Needs you only gathers the
   projects he belongs to and his Personal, even when the session runs on his Mac (ADR-0031 consequences). Confirm
   this is acceptable.
4. On a phone (390 px), the drawer shows the same tree, and every row, section header and "+" is easy to hit.
5. **The D-20 change.** A long session title under a project is cut with an ellipsis; the full title shows on hover and
   in the session header. Confirm this is acceptable.
6. **A project you can't open, under Personal.** Admins open every project, so this needs a device owned by someone
   who is not an admin. If Marta pairs a device and one of its repositories is linked to a project she is not in, her
   sessions there show under **Personal** by repository with "Linked to a project you can't open", and the project's
   name appears nowhere in her sidebar, its tooltips or search. If the demo has no such device, record "not
   applicable" (the e2e `work-zone-sidebar.spec.ts` proves it on fixtures).

## Runtime CLI updates (Phase 07.11)

Phase 07.11 (ADR-0032). Every device that runs the Local Runtime keeps its Claude Code and Codex CLIs current by
itself, above all shared servers that nobody watches:

- **The daemon decides how to update.** It finds how each CLI was installed (native installer, Codex standalone, npm,
  Homebrew; pnpm, bun, yarn, Volta, mise, system packages and others are manual) and the one command that updates it.
  The server never sends a command. Root-owned installs show "Needs admin on this machine" with the command and are
  never run.
- **It never cuts a turn.** An update waits for a moment when that CLI has no turn running on the device (up to 1 h),
  then stops new turns of that CLI until the running ones end, updates, and lets the held turns start on the new
  version. A held turn says "Updating Claude Code… your turn starts when it finishes", then "Claude Code updated to
  {version}". The other CLI is not affected.
- **Levels.** Admin › **Settings › Work Zone policy › Runtime updates**: Automatic (default), Notify only, Off. A
  device can only lower it: the desktop menu's **Runtime updates** submenu, `ocw-runtime updates
  automatic|notify|off`, or `OCW_RUNTIME_UPDATES`.
- **Who sees what.** The device owner and admins see, in **Settings › Devices** › the device card › Runtime updates,
  each CLI's version, a status pill (Up to date, {version} available, Updating…, Waiting for an idle moment, Update
  failed, Unsupported version, Can't run sessions, Not checked, Not installed), the install method and `~` location,
  the last run, **Update now** and **History**. Everyone else sees only the version, and a flag after it when the
  version is older than supported or can't run sessions (also in the new-session dialog).
- Every check that finds an update, every start and every result is in the audit log.

**Owner check** (never run by an agent: they run the real vendors' installers; record each result in
`.planning/phases/07.11-runtime-cli-auto-updates/07.11-VALIDATION.md` › Manual-Only Verifications):

1. **Your Mac.** With the desktop app running, **Settings › Devices** › your Mac shows Claude Code and Codex with their
   versions, "Native installer · ~/.local/bin" for Claude Code and "Standalone installer" for Codex, and "Checked …".
2. **A real update on the Mac.** Install an older Claude Code with the native installer (`claude install <older
   version>`, as Anthropic's setup docs describe). At the next check (or right away with `ocw-runtime updates check`,
   or **Update now** on the card) the daemon updates it: the pill goes Updating… then Up to date, and **History** shows
   the run (from → to, Succeeded, Automatic or By you).
3. **A Linux server with live shared sessions.** On a Linux server running the headless daemon (CLIs installed as the
   daemon's user, see [INSTALL.md](INSTALL.md#keep-claude-code-and-codex-up-to-date-on-devices)), share the device with a
   second member, set the organization to *Notify only* for this check (so the update waits for you) and install an
   older Claude Code there as in step 2. Each of you starts a Claude Code session on it.
   Send a long prompt in yours and, while it runs, press **Update now**: your turn keeps running and is not cut, the
   other member's new prompt shows "Updating Claude Code…" until your turn ends and the update finishes, and then both
   sessions continue on the new version (History shows one run). Repeat once with Codex, then set the organization
   back to Automatic.
4. **Notify only and the desktop toggle.** Set **Settings › Work Zone policy › Runtime updates** to *Notify only*: a
   behind CLI shows "{version} available" and is not installed until you press **Update now**. Then, in the desktop
   app's tray, **Runtime updates › Off**: Settings › Devices shows "This device: Off" with "Set on the device", and the
   tray lines (for example "Claude Code 2.1.307 · up to date") stay. Set both back to Automatic.
5. **A member's view.** Signed in as a member who is not the owner (e.g. Marta, with your device shared with her), the
   device shows only the CLI versions, and the "older than supported" flag when it applies: no install method, no
   status pill, no Update now, no History.

## Headless Work Zone server (Phase 07.12)

Phase 07.12 (ADR-0033). A Linux or macOS machine runs Work Zone sessions without the desktop app
([SERVER.md](SERVER.md)):

- **Install from your workspace.** Settings › Devices › Add a device › **Server** shows
  `curl -fsSL <api>/api/v1/runtime/install.sh | sh`. The API serves the runtime built into its image; the script checks
  its SHA-256, installs the Claude Agent SDK beside it from npm (never served by the workspace) and writes only under
  `~/.ocw` and `~/.local/bin`.
- **Pair from the terminal.** `ocw-runtime setup` prints a link and a code. You open it signed in (a phone works), check
  the code, name the device and press Approve. The server becomes one of your devices.
- **Run it as a service.** `setup` installs a systemd user unit (with the `loginctl enable-linger` line) or a macOS
  LaunchAgent, or prints a system unit for a named account with the only lines root runs (`install`, `systemctl`). `ocw-runtime doctor` checks 13 things with one fix line each.
- **Share it in the web.** Share the server with members and teams in Settings › Devices, or link its repositories to
  a team project. In **New session**, "Run sessions on a server" leads to the Server tab.

**Owner check** (never run by an agent: they install real services and run the real vendors' CLIs; record each result
in `.planning/phases/07.12-headless-work-zone-server/07.12-VALIDATION.md` › Manual-Only Verifications):

1. **A real Linux VM, from New session.** In the web, open **New session** and click **Run sessions on a server**: it
   opens Settings › Devices › Add a device on the **Server** tab. On a Linux VM with Node 24 and git, as a normal
   account, run the install command it shows, then `ocw-runtime setup` with one cloned repository and
   `--service user` (and `sudo loginctl enable-linger <account>` if it asks). Open the printed link on your phone,
   check the code and approve. Back in **New session**, the server appears as a device with its repository.
2. **Reboot.** Reboot the VM and do not log in: the device comes back online in Settings › Devices (lingering).
3. **Restart on failure.** Kill the runtime (`pkill -f ocw-runtime.mjs`): systemd starts it again within seconds and
   the device returns online (`ocw-runtime service logs` shows the restart).
4. **Real turns by a member.** Install Claude Code and Codex as the server's account and sign in with the headless
   lines the doctor prints (`claude auth login` or `claude setup-token` with `~/.ocw/service.env`;
   `codex login --device-auth`). Share the server with a second member (e.g. Marta). As Marta, start a Claude Code
   session and a Codex session on it from New session: each answers a real turn.
5. **A Mac server.** On a Mac with automatic login for its account, install, `ocw-runtime setup --service user`
   (LaunchAgent) and approve. Reboot: the device comes back online.
6. **A safe doctor.** Paste the output of `ocw-runtime doctor` from the Linux VM into a draft issue: it shows no token,
   no service.env value and no absolute path outside the home.

## Runtime self-update (Phase 07.17.1)

Phase 07.17.1 (ADR-0040). A headless server's runtime updates itself from the workspace it is paired with, without SSH
([SERVER.md › Updates](SERVER.md#updates)):

- **One click.** Settings › Devices › the server's card › Runtime updates: the **OCW runtime** row shows "0.3.1 ·
  <build>" and what the workspace serves. When they differ: "{version} available" and **Update** (device owner and
  admins). Desktop devices show "Updates with the desktop app"; a server on an older runtime shows the install command
  to run once.
- **By itself.** At the organization's *Automatic* level the server updates when the workspace serves another build
  (also an older one after a server rollback). *Notify only* shows Update; *Off* stops the checks and Update still
  works.
- **Never cuts a turn.** The new version is downloaded, checked (SHA-256) and installed beside the running one. Then
  the update waits ("Waiting for sessions to finish") until no turn runs on the server, switches, and the service
  manager restarts it. A prompt sent meanwhile says "Restarting the OCW runtime on this device… your turn starts when it
  is back" and runs after the restart.
- **Recorded.** History shows each run (Downloading… → Installing… → Restarting… → Succeeded or Failed, from → to
  builds, By you or Automatic); the audit log has the request, start and result with the builds and no path.

**Owner check** (never run by an agent: it restarts a real systemd service on a real server; record each result in
`.planning/phases/07.17.1-runtime-self-update-from-the-browser-one-click-in-settings-d/07.17.1-VALIDATION.md` ›
Manual-Only Verifications, where the full steps are):

0. **Once from v0.3.0.** Deploy this build. On Server-1 re-run the install command from Settings › Devices › Add a
   device › Server, then `ocw-runtime service restart` when no session runs (v0.3.0 has no self-update code).
1. **Up to date.** The OCW runtime row shows "0.3.1 · <build>" and Up to date.
2. **One click.** Make it behind (a later workspace build, or point `~/.ocw/runtime/current` at the previous
   `versions/<build>` and restart). Press **Update** with no session running: Downloading… → Installing… →
   Restarting…, back online within about 30 s, Up to date; History says Succeeded, By you.
3. **A running turn.** Behind again, start a long Claude Code turn and press **Update**: the turn is not cut, the row
   says Waiting for sessions to finish, a second member's prompt waits with the restart line and runs after it.
4. **Audit and doctor.** Admin › Audit shows requested, started and finished with builds and no path;
   `ocw-runtime doctor` is all ok and the runtime matches the server.
5. **Levels.** At *Automatic* the server updates by itself (History: Automatic). At *Off* the row says "Automatic
   checks are off. Update still works." and Update works. Set it back to Automatic.

## Automations and watched records (Phase 07.6)

Phase 07.6 (ADR-0028, [self-hosting/automations.md](self-hosting/automations.md)). Bots act without being asked: on a
schedule, when a signed webhook or a mail arrives, or when a record someone watches changes in an outside system. An
automation always runs as the person who made it; outside content is posted by the workspace first and never steers a
bot into changing anything. The demo's bots run through the fake cell (or the compose cell's mock model), so the bot
side is scripted; everything a person does is real.

1. **A weekly report (Víctor).** Bots › **Automations** › **New automation**: a bot of the team, *Fridays at 5:00 PM*
   in your zone (the editor lists the next runs), Deliver to `#sales`, the instructions "Summarise this week's closed
   deals". **Create automation**, then the row's menu › **Run now**: `#sales` shows the run card (*Created by the
   workspace*, Running → Done once the bot answers in its thread) and the automation's Runs tab lists it. As Sam (not
   an admin), **Everyone** is not there; as Víctor, Everyone shows Sam's automations with Pause and Delete only.
2. **A webhook to a board (Marta, a lead).** New automation › When: **Webhook**, Deliver to a board column, *Create a
   board card*. After **Create automation** the secret shows once: tick the box, copy the URL and secret. Send a signed
   test (`Send a test event`, or any Standard Webhooks sender): the board gets a card with the payload as its first
   reply, the amber *Outside content* notice on top, and the bot answers in its thread without changing anything. The
   Deliveries list shows Accepted; send the same `webhook-id` again: Duplicate. **Rotate secret** keeps the old one for
   24 hours.
3. **A mailbox (Marta).** Settings › Keychain › **Add key** › *Username & password* with an app password and the mail
   server in Allowed hosts. New automation › When: **Mail**, pick the key, folder `INBOX`, **Test connection**
   (*Connected. INBOX has … messages.*). Send a mail to that address: within the poll interval a card with the mail's
   full text appears, and the mail is still unread in your mail app.
4. **Ask a bot (Sam).** In your DM with a bot: "every Monday at 9 send me the open tickets here". The bot posts a
   proposal card (*Create automation*, *Discard*, *Edit*). **Edit** opens the editor with the draft; change the time to
   10:00 and save: the card reads *Created with changes*. Nobody else may confirm it.
5. **Watch a record (Marta).** On a board card's menu › **Watch external record…**: pick the ERP connector, find the
   record, tick the fields, **Start watching**. Change one field in the ERP: at the next check (or **Check now** in the
   thread) the card's tile reads *Changed* and the thread shows before → after. Ask the bot to update the record while
   someone else changed it: the thread shows *Not saved* and nothing was written.
6. **A digest (Sam).** Settings › **Digest**: weekdays at 09:00, the sections, the bot that sends it (your personal bot
   first), **Save digest**, then **Send a test now**: the DM lists approvals waiting for you, cards you follow, unread
   mentions and Work Zone sessions you can see. The AI summary is off until you turn it on (it says who pays).
7. **A Work Zone summary (Sam).** Link the repository to a team project (Work Zone › Projects › the project ›
   Settings). On a finished session, **Propose to memory** › **Propose summary**: the strip reads *Writing*, then
   *Pending*; a lead of the project applies it from **Approvals** and the file appears in the project's memory under
   `work-zone/`. A session whose repository is linked to no project offers the link instead.

**Owner check** (never run by an agent: it needs your own mailbox and ERP; record the result in
`.planning/phases/07.6-automations-and-watched-records/07.6-VALIDATION.md` › Manual-Only Verifications and in ADR-0028 ›
Validation). On your own stack with a real model:

1. **A real mailbox.** Create an app password at your provider, add it to Keychain with the provider's IMAP host in
   Allowed hosts, and create a mail automation on a folder you can fill (a filter or a label). **Test connection** must
   read *Connected*. Send yourself a mail into that folder: the card appears within the poll interval with the full
   text, the mail stays unread at the provider, and an auto-reply or a newsletter in the same folder is skipped.
2. **Wrong password.** Change the key's password to a wrong one: the automation reads *Sign-in failed*; put the right
   one back: it reads mail again at once.
3. **A real ERP MCP.** Register your ERP's MCP server (Settings › MCP servers), watch a real record from a board card,
   change a watched field in the ERP: the change is reported before → after in the card's thread. Ask the bot to
   update a field and approve it: the ERP shows the new value and, if the server has a note tool, the note. Change the
   record in the ERP between the bot's read and its write (or right after asking): the thread reads *Not saved* and
   the ERP keeps your change.
4. **From a phone.** Run step 1 of the demo (Run now) and step 4 (confirm a proposal) at 390 px wide.

## Agent-to-agent consults (Phase 07.7)

Phase 07.7 (ADR-0027). A bot asks another bot for help only through the workspace: the question is a message in the
thread, on behalf of the person who asked, and the answer comes back to the asking bot as a new turn. Consults are
**off** until an admin turns them on. The demo's bots run through the fake cell (or the compose cell's mock model), so
what the bots say is scripted; the switch, the rules, the chips and Stop are real.

1. **Turn it on (Víctor).** Settings › **Bot policy** › *Bots may consult each other*: switch it on (a toast confirms).
   Sam (not an admin) sees the switch disabled with "Only admins can change this."
2. **Set a bot's rules (Víctor).** Bots › open a team bot (Archie) › **Consulting other bots**: the *Right now* line
   reads "Archie can ask …" from the server. Try *Can ask* › **No bot** (the line reads that it can ask no bot), then
   back to **Organization default**; add `@carl` under **Never ask** (Carl leaves the line); switch **Other bots can ask
   Archie** off and on. With the organization switch on, **Only these bots** is disabled and says why (deny wins).
3. **Run a consult (Víctor).** Add Archie and Bea to `#ops`. In a thread of `#ops`, mention Archie and ask him to check
   something with Bea. Archie's question appears in the thread as "@bea …" with a chip *Asked @bea for Víctor Ruiz ·
   Waiting…*; Bea's answer appears with *Answer to @archie*, the chip turns **Answered** live, and Archie's reply to you
   follows in the same thread.
4. **Read the chips.** A question can read **Waiting…**, **Answered**, **Couldn't answer**, **No answer in time** (after
   5 to 6 minutes without an answer), **Stopped** or **Daily limit reached**; a second-level question starts with
   *Step 2 ·*; a handoff reads *Handed over to …*.
5. **Stop (Víctor).** Ask again while Bea is slow (or held in the fake cell): **Stop** on the chip ends the request,
   both your browser and Alex's show **Stopped** live, and Bea's late answer still posts but wakes nobody. Alex (a
   member, not a moderator) never sees Stop.
6. **Audit.** `app.audit_events` holds `agent.consult.requested`, `agent.consult.answered` and
   `agent.chain.cancelled`, each with the chain id and no message text:
   `SELECT occurred_at, action, user_id, metadata FROM app.audit_events WHERE action LIKE 'agent.c%' ORDER BY occurred_at DESC LIMIT 10;`

**Owner check: two bots helping one person** (never run by an agent: it needs your own stack and real models; record
the result in `.planning/phases/07.7-agent-to-agent-collaboration/07.7-VALIDATION.md` › Manual-Only Verifications and
in ADR-0027 › Validation). On your own stack, with two team bots on real models that are members of one channel:

1. Turn **Bots may consult each other** on (Settings › Bot policy).
2. In a thread, mention bot A and ask it to check something with bot B (for example "@archie ask @bea whether the pump
   order is confirmed and tell me"). Confirm the three messages in the thread: A's question to B with its chip, B's
   answer marked *Answer to @archie*, and A's reply to you; the chip reads **Answered**.
3. Ask a second request that keeps B busy, and press **Stop** on its chip: the chip reads **Stopped** and A does not
   reply again for that request.
4. Run the audit query of step 6 above: the `agent.consult.*` and `agent.chain.cancelled` rows carry the chain id (the
   same `chainId` on the request, the answer and the Stop), and none shows the question or the answer.
5. Turn the switch off again: mention A with the same request; A no longer offers to ask B.

## Organization connector auth (Phase 07.14)

Phase 07.14 (ADR-0036, [self-hosting/connectors.md](self-hosting/connectors.md)). An MCP server can now use one shared
account for the whole organization, through an admin's OAuth sign-in or a client ID and secret, and the dialog explains
why an OAuth sign-in fails before anything is saved:

- **Five modes, two groups.** Settings › MCP servers › **Add** › *Authentication*: *For the whole organization*
  (**Organization headers**, **Organization sign-in**, **Client credentials**) and *Each member's own account*
  (**Member sign-in**, **Member key**).
- **Test sign-in.** Runs the checks in order (this workspace's address, sign-in information, sign-in server identity,
  secure endpoints, PKCE, client registration, token) and names the first one that fails, with one fix line. It never
  registers OCW at the provider and never saves anything.
- **Connect once.** An **Organization sign-in** server's row has **Connect**: an admin signs in once, the row reads
  *Connected as … · by … · just now*, and every member's bots use that account wherever organization tools are allowed.
  **Reconnect** and **Disconnect** live on the same row. **Client credentials** connect on Save.
- **Never in the cell.** The API calls these servers itself; the token and the client secret never reach the bot's
  container. A bot that hits a disconnected server says an admin must connect or reconnect it, never "connect your
  account".

The demo has no real provider: the automated tests use the fake OAuth MCP server.

**Owner check** (never run by an agent: it needs a real provider and your live domain; record each result in
`.planning/phases/07.14-organization-connector-auth/07.14-VALIDATION.md` › Manual-Only Verifications). On
`https://ocw.autofy.ing` (behind Cloudflare), signed in as an Organization Admin:

1. **Test sign-in on a real server.** Settings › MCP servers › **Add**: a real OAuth-only MCP server (for example Notion
   or Linear), **Authentication › Organization sign-in**. Press **Test sign-in** before saving and note which steps
   pass and which one fails, if any.
2. **Connect and use it as a member.** Save, then **Connect** on the server's row and finish the provider's sign-in:
   the row reads *Connected as …*. Grant one of its tools to a team bot. As a member who is not an admin, ask that bot
   in a channel to use the tool: the answer comes from the organization's account, with no connect card.
3. **Follow the fix line.** If Test sign-in (or Connect) names a step, apply its fix line (for example
   `OCW_PUBLIC_API_URL`, the client metadata URL behind Cloudflare, or a pre-registered client) and repeat from 1.
   Note what fixed it.
4. **Disconnect.** Press **Disconnect** on the row and confirm. Ask the bot again as the member: it must say an admin
   has to connect the server, and the provider must no longer list OCW's access.
5. **Client credentials** (if a provider gives you a client ID and secret): the same with **Authentication › Client
   credentials**: Test sign-in, Save (the row turns *Ready* with *Client …*), a member's bot uses a tool, Disconnect.

## Bots read attachments (Phase 07.15)

Phase 07.15 (ADR-0037). Bots now read the files people attach where they talk to them:

- **Paperclip in bot DMs.** Personal and team bot DMs take files like a DM with a person (same limits, same upload).
  Channels, threads and AI chats with personas already did.
- **What a bot reads.** Text, code, CSV, JSON and PDFs with a text layer as text (up to 64 000 characters per file and
  200 000 per turn, 20 reads per turn); images only when the bot's model takes images. Other files (archives, Office
  documents) can be copied into the bot's sandbox, where its tools open them. A file the bot cannot read is named on
  its turn with a reason, so it tells you why.
- **Who sees what.** A bot reads only files of the conversation it answers, as the person who asked, and in a channel
  only files of the same thread. A personal bot's sandbox takes files only from conversations you read; a team bot's
  sandbox never takes files from one member's DM, because others share that sandbox.
- **Safety.** A file is untrusted: after a read, the bot cannot save memory or change data in that turn without your
  approval. Each read (`bot.attachment_read`) and import (`bot.attachment_imported`) has an `app.audit_events` row with
  ids and counts only, never the file's name or content.
- **Not yet:** OCR for scanned PDFs, audio and video, images for bots on a ChatGPT plan, bots attaching files.

The demo has no real model: the automated tests use a fake model and a real OpenClaw cell.

**Owner check** (never run by an agent: it needs a real model; record each result in
`.planning/phases/07.15-bots-read-attachments/07.15-VALIDATION.md` › Manual-Only Verifications). On
`https://ocw.autofy.ing`:

1. **Image and PDF in your personal bot's DM.** Attach a photo and a short PDF and ask what they show. The answer
   describes both.
2. **A model that cannot see images.** With a bot on a text-only or ChatGPT-plan model, attach a photo and ask about
   it. The bot says it cannot see images.
3. **A team bot in a channel thread.** In a channel, reply in a thread with a CSV attached, mention a team bot and ask
   for a total. The answer uses the CSV's numbers.
4. **Into the sandbox.** Ask your personal bot to copy a CSV into its sandbox and count its rows. It answers with the
   count.
5. **Audit.** The `bot.attachment_read` rows show ids and counts, never the file's name or content:
   `select action, result, metadata from app.audit_events where action like 'bot.attachment_%' order by occurred_at desc limit 5;`

## Bot Work Zone orchestration (Phase 07.16)

Phase 07.16 (ADR-0038). A bot starts and drives Work Zone sessions itself; nobody presses Start:

- **A profile per bot.** The bot's sheet › **Work Zone** sets the device or server, the projects, the runtime, the
  default model and options, the highest mode and the limits. Whoever saves it is the **sponsor**: sessions run in the
  sponsor's name and rights. Only an admin turns on **Act on outside content**, after a warning.
- **The device owner allows the bot.** Settings › Devices › the device › **Bots that may run sessions here** › Allow.
  On a headless server an admin may do it too. **Allow Full access for this bot** is a separate checkbox.
- **Full access** needs all of: the organization policy, the device's own opt-in (`ocw-runtime full-access on`), the
  sponsor's Full access on the device, the per-bot checkbox and a profile whose highest mode is Full access. After the
  bot read outside content, it also needs an isolated server (`ocw-runtime isolated-server on`, set only on the
  server, [SERVER.md](SERVER.md#isolated-server-phase-0716)). Without the admin's flag, a start after outside content
  becomes a proposal a person reviews.
- **What you see.** A live card in the thread (runtime, project, device, model, mode, step, updated) with **Open
  session**; the session page shows **Back to <conversation>**. The bot is woken when a turn ends, an approval waits,
  the session fails, ends or goes offline (at most 20 wake-ups per session per day), and mentions people when it needs
  help. Bots never approve runtime requests.
- **Audit.** `bot.work_session_*`, `bot.work_zone_profile_*` and `device.bot_consent_*` rows carry ids, counts and
  lengths, never prompt text, output, paths or titles.

The automated tests use a fake runtime and a fake cell (e2e) and a real OpenClaw cell (smoke).

**Owner check** (never run by an agent: it needs a real model and a real Claude Code subscription; record the result in
`.planning/phases/07.16-bot-work-zone-orchestration/07.16-VALIDATION.md` › Manual-Only Verifications). On
`https://ocw.autofy.ing`, with the headless server of Phase 07.12:

1. **On the server.** `ocw-runtime full-access on` and `ocw-runtime isolated-server on` (read the warning: the server
   must hold nothing else that matters). `ocw-runtime isolated-server status` shows `"honoured": true`.
2. **Policy.** Settings › Work Zone policy › Full access: on.
3. **Profile.** Open the team bot's sheet › Work Zone: the server, two projects, Claude Code, a model, highest mode
   Full access. Save. Until step 4 the status line reads "The device's owner has not allowed this bot to run
   sessions there."
4. **Consent.** Settings › Devices › the server › Bots that may run sessions here: **Allow** the bot, then tick **Allow
   Full access for this bot**. The server card shows **Isolated server** (Set on the device).
5. **Ask.** In a channel, mention the bot and ask it to fix something small in one of the two projects. Expect the
   live card in the thread, the session running in Full access (no approval prompts), and, when the turn ends, the
   bot's report in the thread mentioning you.
6. **Open and back.** Press **Open session** on the card: the session shows the bot's prompts "for" the sponsor. Press
   **Back to #<channel>**: you land on the card.
7. **Audit.** The rows show ids and counts only:
   `select action, result, metadata from app.audit_events where action like 'bot.work_session_%' order by occurred_at desc limit 10;`

## Automation fan-out and team mentions (Phase 07.17)

Phase 07.17 (ADR-0039, [self-hosting/automations.md](self-hosting/automations.md)). An automation opens one
conversation per new item and its bot works each one; people and bots mention whole teams:

- **Every few minutes.** Bots › Automations › the editor's **Every few minutes** (5, 10, 15 or 30) pre-fills the runs a
  day. An amber note warns when the bot's daily limit is lower than the turns the automation can use, and says how many.
- **For each new item.** On an agent schedule delivered to a channel or a board, **Open a conversation for each new
  item** gives the run's bot one call that opens a thread (channel) or a card in the chosen column (board) per item:
  never the same item twice, at most the per-run and per-day caps (10 and 100 by default). The runs themselves post
  into one **"<name> · Runs"** thread, and each reads *Opened 2 conversations* or *Nothing new*.
- **One turn per item.** Each opened item gets its own bot turn in its own thread, as the automation's creator. It
  counts as outside content, so a Work Zone start needs the profile's **Act on outside content** (else a proposal), and
  the bot may move the card it opened (to Doing, to Done) only with that same flag. It never edits the card's text.
- **When it needs people.** Up to five people or teams the bot mentions when it finishes or needs help.
- **`@team`.** In channels, threads and board cards, `@` offers **Teams** after people and bots (`@logistics`, with
  its size). The team's members who can read the conversation get a *mentioned @logistics* notification; a bot is
  never woken by a team, and a bot mentions at most 3 teams a message.
- **Audit.** `automation.conversation_opened`, `automation.item_delivered` / `item_skipped` and the board audit carry
  ids and counts, never an item's key, title or body.

The automated tests use a fake ERP MCP and a fake cell (e2e) and a real OpenClaw cell (smoke).

**Owner check** (never run by an agent: it needs the real orders MCP, a real model and the real Work Zone server; record
the result in `.planning/phases/07.17-automation-fan-out-and-team-mentions/07.17-VALIDATION.md` › Manual-Only
Verifications). On `https://ocw.autofy.ing`, with the headless server and the team bot of Phase 07.16:

1. **The orders MCP.** Settings › MCP servers: register the orders MCP and grant its list and read tools to the team
   bot (Capabilities). Connect it either once for the organization (**Organization sign-in** or **Client credentials**)
   or with your own account; with your own account, allow it in the board when the bot asks (**Allow … in #board**).
   You are the automation's run-as person.
2. **The bot's Work Zone profile.** The bot's sheet › Work Zone: the headless server, the vehicles' project, the
   runtime and model. As an admin turn on **Act on outside content** and read its warning: the orders and documents the
   bot reads can steer what it runs; it only writes in the bot's own sessions and the cards its automation opened. Set
   **Sessions at once** to the number of orders you expect at the same time (up to 10): an order whose start is refused
   for that limit waits ("N waiting" in the run history) and gets a new turn when one of the bot's sessions ends, at
   most 5 times. An idle session still counts, so the bot should stop each session when its order is done.
3. **The daily limit.** Bots › the bot › Capabilities › **Daily limit**: above the editor's number (every 10 minutes is
   144 run turns a day, plus one turn per order and the session's wake-ups).
4. **The automation.** Bots › Automations › New automation: the team bot, **Every few minutes** › every 10 minutes,
   Deliver to the board's **Backlog** column, **For each new item** › **Open a conversation for each new item** on,
   **When it needs people** › **Mention when it finishes or needs help** = the team. Instructions: "List the new orders
   with the orders MCP and open one card for each. In each card: read the vehicle's documents, start the Work Zone
   session, move the card to Doing; when the session is done, move it to Done and mention the team."
5. **Run it.** Press **Run now** (or wait 10 minutes). Expect one card per new order in Backlog and a reply in the
   "<name> · Runs" thread. On the next runs no card is opened twice (*Nothing new* when there are no new orders).
6. **Each card.** The card's thread shows the bot's turn, the live Work Zone card with **Open session**, the move to
   Doing, and when the session ends the move to Done and the bot's `@team` message.
7. **The team.** A team member gets the mention in the inbox (*mentioned @<team>*); a person outside the board does
   not.
8. **Audit.** The rows show ids and counts only:
   `select action, result, metadata from app.audit_events where action like 'automation.%' order by occurred_at desc limit 10;`

## Bot file exchange with its Work Zone sessions (Phase 07.17.1.1)

Phase 07.17.1.1 (ADR-0041). A bot with a Work Zone profile moves files between the thread and the session it started
there:

- **Upload.** `ocw_work_session_upload` copies an attachment of the thread into the bot's own session, at a
  repo-relative path (`docs/notes.md`). The file shows in the session's changes like any new file. An existing file
  is replaced only when the bot asks for it.
- **Download.** `ocw_work_session_download` copies one file of the session back into the thread as an attachment of
  the bot's reply. People open and download it like any other attachment.
- **Where it works.** Only in the conversation where the bot started the session (elsewhere: "not your session").
  Uploads only while the session is idle, with no prompt waiting or running (one writer per working tree). Downloads
  also while it runs.
- **The limits.** Settings › Work Zone policy › Bots › **Largest file a bot moves**: default 25 MB, at most the
  server's `OCW_ATTACHMENT_MAX_BYTES`. The bot's sheet › Work Zone › Limits › **Largest file**: empty means the
  organization's, never above it. The lower one applies, and a refusal names it: "That file is 40 MB. This bot moves
  files up to 25 MB (the organization's limit)."
- **What is refused, both ways.** Any path outside the project (absolute, `..`, symlinks out of the tree), `.git`,
  `.ocw-worktrees`, `.claude`, `.codex`, `.mcp.json`, `.env` and `.env.*` (but `.env.example`), key and credential
  files (`*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, …), also under another spelling the disk would open the same
  way (other letter cases, look-alike or invisible characters, Windows `:` streams and `~1` short names). Symlinks,
  folders, files with a second hard link and other non-regular files are refused too.
- **Budgets.** At most 5 files each way per turn, inside the turn's 8 tool calls. Each move counts as one prompt of
  the profile's hourly prompt budget (30 by default), whatever its outcome.
- **The device.** Bytes go over HTTPS between the device and its own workspace (`/api/v1/runtime/files/`, the
  device's token), never over the Device Link. A device on an older runtime answers "update the runtime" (Settings ›
  Devices › Update). Behind your own proxy or CDN, see
  [reverse-proxy.md](self-hosting/reverse-proxy.md#bringing-your-own-reverse-proxy) (rule 5).
- **Audit.** `bot.work_session_upload`, `bot.work_session_download` and `bot.work_session_refused` carry ids, the
  size, the sha256 and the path's length, never a path, a file name or content.

The automated tests use the real local-runtime daemon with a fake runtime and a fake cell (e2e) and a real OpenClaw
cell (smoke).

**Owner check** (never run by an agent: it needs a real model, the real cell and the real Work Zone server; record the
result in
`.planning/phases/07.17.1.1-bot-file-exchange-with-its-work-zone-sessions-upload-chat-at/07.17.1.1-VALIDATION.md` ›
Manual-Only Verifications). On `https://ocw.autofy.ing`, with the headless server and the team bot of Phase 07.16, the
server updated to this runtime (Settings › Devices › the server › Runtime updates › **Update**, Phase 07.17.1):

1. **Upload.** In a thread where the bot runs a session, attach a small file and ask the bot to put it in the session
   (for example at `docs/notes.md`). The bot says it did. **Open session** › Changes lists the file as new.
2. **Download.** Ask for a file of the project back (`README.md`). The bot's reply carries it as an attachment.
   Download it and open it: it is the project's file.
3. **A big file.** Attach a 20 MB file and ask the bot to put it in the session, then to send it back. Both work
   within the default 25 MB (a long tool call through the real cell).
4. **The bot's limit.** The bot's sheet › Work Zone › Limits › **Largest file**: 1 MB, Save. Ask it to put a 2 MB file
   in the session. The bot relays "That file is 2 MB. This bot moves files up to 1 MB (this bot's limit)." Empty the
   field and Save.
   Then set the bot's **Largest file** to 20 MB and Save, lower the organization's **Largest file a bot moves** to
   10 MB, and in the bot's sheet change only **Prompts per hour** and Save: it saves, and the Largest file line says
   10 MB applies, with a note that the bot's 20 MB is above it. Put both limits back.
5. **Secrets.** Ask the bot to download `.env` from the session. It is refused.
6. **Audit.** The rows show ids, sizes and hashes only, never a path:
   `select action, result, metadata from app.audit_events where action in ('bot.work_session_upload', 'bot.work_session_download', 'bot.work_session_refused') order by occurred_at desc limit 10;`

## Long-running bot tasks (Phase 07.17.1.1.2)

Phase 07.17.1.1.2 (ADR-0042). A bot no longer stops after each answer or asks "shall I continue?": when a request
needs more than one turn, it starts a task and keeps going in the thread by itself.

- **Start, continue, finish.** The bot calls `ocw_task_start` with a one-line goal, then `ocw_task_continue` with its
  progress and next step at the end of each turn, and `ocw_task_finish` (done, or blocked when it needs the person).
  The platform delivers its next turn in the same thread 5 s after the last one ended. A turn that ends without
  either call gets one nudge turn; a second one in a row stops the task as blocked. A next turn that cannot be
  delivered after three tries (15 s, then 30 s apart) stops the task as failed, with one message. Each tool succeeds
  at most once per turn, and a turn makes at most six task calls.
- **Waits.** `waitFor: { processId }` waits for a background sandbox command (`ocw-extract --batch` with
  `background true`, `timeoutSeconds 600`): the bot is woken with its exit code (75: run the same batch again; 8: no
  progress; 0: done). `waitFor: { workSessionId }` waits for a Work Zone session the task started. `afterSeconds`
  waits up to an hour.
- **The card.** A live task card in the thread: goal, state, "Turn n of N", elapsed time, the wait, progress and next
  step, updated in place every turn. A visible message at most every 5 turns or 10 minutes, and one at the end. A
  person's own message in the thread is answered as usual and never pauses or ends the task.
- **Stop.** On the card, for the person the task runs for, the channel's moderators and the bot's managers (its owner
  for a personal bot, bot admins and the unit's leads for a team bot). No new turn starts; a turn already running
  finishes.
- **Limits.** Settings › Bot policy › **Long tasks** (on by default, team and personal columns), **Turns per task**
  (40, 1–200), **Hours per task** (8, 1–24), **Tasks running at once** (10, 0–100; at 0 no new task starts). Per bot:
  Bots › the bot › Capabilities › **Long tasks**. Every task turn runs as, and is paid by, the person who started it,
  and counts in the bot's daily limit. When a limit ends the task, the bot posts one message mentioning that person.
- **Safety.** Each turn is re-decided as that person; the taint is sticky; continuations have no browser tools; not
  in AI chats. Losing access to the conversation, or the bot turned off or removed, stops the task. Only that
  person's own message (never another bot's consult or an automation) can steer the task while it waits. A turn
  that already carries 128 tools is not offered the start, and says so (`turn_full`).
- **Audit.** `bot.task_started`, `bot.task_continued`, `bot.task_finished`, `bot.task_stopped` and
  `bot.task_refused` carry ids, counts, reasons and durations, never the goal, the notes or the summary.

The automated tests use a fake cell (e2e: a task over four turns stopped by a 4-turn budget, a second one stopped from
the card) and a real OpenClaw cell (smoke).

**Owner check** (never run by an agent: it needs `https://ocw.autofy.ing` on v0.3.2, the bot "Gertru", the 3,030-file
knowledge pack and a real model; record the results in
`.planning/phases/07.17.1.1.2-long-running-bot-tasks-a-bot-keeps-working-across-turns-on-i/07.17.1.1.2-VALIDATION.md` ›
Manual-Only Verifications). After the upgrade, with Gertru's sandbox on the new image (07.17.1.1.1):

1. **It starts a task.** In a channel thread, attach or point Gertru to the knowledge pack and ask it to read all of
   it. It says it started a task, and a task card appears. It does not say it has no background execution and does not
   ask "¿continúo?".
2. **It keeps going.** Leave the thread alone. Over many turns the card's "Turn n of N" and its progress move by
   themselves, with a message in the thread only now and then.
3. **A sandbox batch wakes it.** While `ocw-extract --batch` runs in the background, the card says "Waiting for a
   background command"; when the chunk ends, the next turn starts by itself (and runs the batch again after exit 75).
4. **People and Stop.** Write in the thread mid-task: Gertru answers you and the task goes on. Signed in as a plain
   member who did not start it (Ben in the e2e), the card has no **Stop**. As the person who asked, press **Stop**:
   the card says Stopped and no new turn starts.
5. **The cadence.** Over a long task, the visible messages (at most every 5 turns or 10 minutes) feel right: neither
   spam nor silence.
6. **The cost.** Check the usage of a whole task on the subscription. Lower **Turns per task** to 3 in Settings › Bot
   policy, start a new task: it stops after 3 turns with one message mentioning you. Put the limit back.
7. **Audit.** The rows carry ids and counts only, never the goal or a note:
   `select action, result, metadata from app.audit_events where action like 'bot.task_%' order by occurred_at desc limit 20;`

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot stays *Provisioning* | `docker logs ocw-demo-openclaw` — the cell must show `subscribed to cell`; run `pnpm demo:up` again |
| Bot answers "Sorry, I couldn't generate a reply" | provider key missing/invalid in Settings › Models |
| Device offline | the desktop app must be running (menu-bar icon); Claude Code / Codex must be logged in (`claude`, `codex login`) |
| ChatGPT card: *Connect* disabled, "Your bot runtime is offline" | the cell is not connected: `pnpm demo:up`, then check Settings › Bots runtime |
| ChatGPT card: "The code expired…" / "denied" | press *Try again* for a new code and approve it within 15 minutes, in the same ChatGPT account |
| The OpenAI page rejects the code or says device sign-in is not allowed | your ChatGPT security or workspace settings may need device-code authorization for Codex enabled; enable it and connect again |
| Bot is *Error*: "not signed in on the bot runtime" | the cell lost the sign-in (state volume reset): Settings › Models → *Reconnect* |
| Bot answers "the provider rejected my credentials" | the sign-in was revoked or the plan does not include that model: reconnect, or pick another model for the bot |
| Settings › Members shows no role select or no Organization page | you are not signed in as an Organization Admin (only `victor@` is one) |
| After changing `BETTER_AUTH_SECRET` the web stays offline or the API logs "Failed to decrypt private key" | delete the `auth.jwks` rows and restart the API (see [Account and access](#account-and-access)) |
| Cell crash-loops with "Another Gateway owner lease" | it was killed hard: `docker rm -f ocw-demo-openclaw && docker volume rm ocw-demo-openclaw-state && pnpm demo:up` |
| AI chat dialog: "Paste the full address that starts with http://127.0.0.1." | copy the whole address bar of the unreachable `127.0.0.1` tab (not `localhost`), within 10 minutes of *Continue* |
| AI chat: no ChatGPT models, or "Reconnect ChatGPT" | Settings › AI chat: connect (or reconnect) your own plan; "not eligible" accounts use organization models |
| AI chat on Claude: Web says it needs the search service | SearXNG is not reachable from the API; see [AI chats](#ai-chats-phase-5) › Web |
| Shared AI chat: "You can view this chat. Ask … for chat access to write." | you hold *Can view*; the owner can change it to *Can chat* in Share |
| Shared AI chat: "AI couldn't answer: …" under your message | your own model was unavailable (not connected, at a limit, not allowed); nobody else's plan is used: connect your plan or pick an organization model |

## Known limits (MVP 0)

Desktop app is ad-hoc signed (no notarization); its main window loads the web app URL, and clicking a chat
notification may not focus it until the app is code-signed. Full
`docker compose up` (with API/web images) is defined but was not re-run on this machine because the
Docker disk is full; the demo runs API/web natively. See
`.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-DEVIATIONS.md`.
