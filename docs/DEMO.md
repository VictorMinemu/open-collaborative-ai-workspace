# MVP 0 demo runbook

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

**Owner check before relying on Full access** (never run by an agent): on an opted-in device, start a Claude Code
session in Supervised, switch to Full access, ask for a file edit and a shell command: no approval prompt, the
badge is visible, and `app.audit_events` has `work_session.full_access_entered` and `work_prompt.dispatched` rows.
Switch back to Supervised and send another prompt: it asks again and the conversation continued (Claude relaunches
with `resume` when entering or leaving Full access). Repeat with Codex. Also check the model chip shows the alias
row (e.g. *Sonnet*) for the model the runtime reports.

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

## Known limits (MVP 0)

Desktop app is ad-hoc signed (no notarization); its main window loads the web app URL. DMs exist only
between a person and a bot (Phase 3.1). No human DMs, reactions, message edit/delete, search or attachments yet. Full
`docker compose up` (with API/web images) is defined but was not re-run on this machine because the
Docker disk is full; the demo runs API/web natively. See
`.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-DEVIATIONS.md`.
