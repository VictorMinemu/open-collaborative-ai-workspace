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
   **Authentication › Each member signs in**. Copy the **Redirect URI** into the provider's app registration, then
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
notification may not focus it until the app is code-signed. Bots cannot read attachments yet (files are hidden in
bot DMs). Full
`docker compose up` (with API/web images) is defined but was not re-run on this machine because the
Docker disk is full; the demo runs API/web natively. See
`.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-DEVIATIONS.md`.
