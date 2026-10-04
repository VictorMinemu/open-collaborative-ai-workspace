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
   **Codex**), permission mode *Plan* (safe) or *Default* (asks before editing). Prompt, e.g.
   *"Propose one small UX improvement for the chat composer"*. Show the live stream, tool cards, the
   shared queue (add a second prompt as Alex), the approval banner, and the Changes panel.
7. **Roles and organization** — Settings › Members: each person's role, the role select (admins only)
   and **What can each role do?**, the matrix of what each role is allowed. Settings › Organization: the
   tree, Alex as lead of Backend, a unit's members. Then sign in (private window) as `sam@autofylabs.demo`:
   a Standard User chats and uses bots but has no Work Zone and no admin settings. Every decision comes
   from one permission resolver on the server, so the UI only hides what the API would refuse anyway.

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

Desktop app is ad-hoc signed (no notarization); its main window loads the web app URL. Bots have no
tools (by design for MVP 0). No DMs, reactions, message edit/delete, search or attachments yet. Full
`docker compose up` (with API/web images) is defined but was not re-run on this machine because the
Docker disk is full; the demo runs API/web natively. See
`.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-DEVIATIONS.md`.
