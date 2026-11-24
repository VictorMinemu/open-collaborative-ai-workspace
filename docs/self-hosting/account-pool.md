# The subscription account pool

An organization can keep several Claude and ChatGPT **subscription** accounts in one pool, so work goes on when one
account reaches its usage limit. Admins manage it in **Settings › Account pool** (it needs `provider.manage`). Once an
admin adds accounts, **every Work Zone session and every bot uses them automatically: members do nothing**, and nothing
in the pool asks for an API key. The decisions behind this page are in
[ADR-0044](../adr/0044-subscription-account-pool.md) (the pool) and
[ADR-0006](../adr/0006-subscription-sign-in-inside-the-cell.md) (bots signed in inside their runtime).

| Who uses the pool | Claude accounts | ChatGPT accounts |
| --- | --- | --- |
| **Work Zone sessions** (Claude Code, Codex on a device) | A setup-token, sealed on the server and sent only to the device that runs the session | An account signed in **on that device** (one Codex sign-in per account) |
| **Bots** (OpenClaw) | The same setup-tokens, sent to the bots runtime | An account signed in **inside the bots runtime** |

Order of preference, always: the pool's subscription accounts, then the device's own login, then an API key only where
one is already configured (for bots, the organization's Anthropic key stays last). AI chats are not part of the pool:
each member still signs in with their own ChatGPT plan there (ADR-0017).

## Who manages it and what members see

- **Admins** add, remove, turn on and off, rename, reorder and weight accounts, and pick the strategy. Every change is
  audited (`account_pool.*`) without any token.
- **Members** see an account's **label** only, never a token. Labels are usually the account's e-mail, so pick a label
  you are happy for every member to read.
  - The new-session dialog shows which account a new session will use: **Account: pool (failover)** (or the strategy in
    use), **This device's login**, or **No pool account is ready · resets at 15:40**. There is nothing to choose.
  - A running session shows its account in the header (**Account: ana@acme**, or **This device's login**).
  - When a session moves to another account, its timeline says why: "Switched to account B: A reached its limit until
    15:40".
- A member who opens `/settings/account-pool` reads "Only workspace admins manage the account pool."

## Add a Claude account

Claude accounts on a Pro, Max or Team plan work through a long-lived **setup-token**, made by Anthropic's own sign-in.

1. On any computer where you can sign in to that Claude account, run:

   ```bash
   claude setup-token
   ```

   Sign in in the browser it opens. The command prints a token that starts with `sk-ant-oat01-`. It is not saved
   anywhere on that computer.
2. In **Settings › Account pool › Claude**, press **Add Claude account**, type a **Label** and paste the token in
   **Setup-token**. Save.

The token lasts one year. It is sealed in the secret store at once and **never shown again**, to anyone. Sessions and
bots use it right away. An API key (`sk-ant-api…`) is refused here with "This is an API key. Add it in Settings ›
Models.": API keys stay on the Models page.

When a token expires or is revoked, its row reads **Paste a new token**: run `claude setup-token` again and use
**Replace the token** on that row. Nothing else changes (label, order, history).

**Used by** (Claude section only): **Work Zone and bots** (the default), **Work Zone only** or **Bots only**.

## Add a ChatGPT account

ChatGPT tokens rotate, and Codex and OpenClaw refresh them themselves, so a ChatGPT account is signed in **where it
is used** and never copied to the server. Press **Add ChatGPT account**; the dialog asks "Where will this account be
used?".

### For bots

Choose **For bots**, type a label and press **Start sign-in**. The bots runtime asks OpenAI for a code; the dialog shows
the link and the code (with Copy buttons and an "Expires in m:ss" countdown). Open the link, sign in to the ChatGPT
account, enter the code. The dialog says **Connected** and the row reads **Bots runtime**, Ready. The bots runtime must
be online (Settings › Bots runtime).

The ChatGPT account your organization already signed in for bots on **Settings › Models** (before this release) is
already in the pool as its first account. You do not have to sign it in again.

### On a server device (Work Zone)

A ChatGPT account for Codex sessions lives on one **server device** (a headless runtime, [SERVER.md](../SERVER.md)) and
serves Work Zone sessions on that device only. Two ways:

- **From Settings:** choose **On a device**, pick an online server device, type a label, **Start sign-in**. The device
  asks Codex for a code; sign in as above. The account is on, and its row reads **On *device name***.
- **On the device itself**, as the user the runtime runs as:

  ```bash
  ocw-runtime account add codex --label "ana@acme"
  ```

  It prints the link and the code, waits for the sign-in, then says "Signed in (plan: plus). The server lists it under
  Settings › Account pool; an admin turns it on." An account added this way **arrives off**: it serves nothing until an
  admin turns it on. `ocw-runtime account list` lists the accounts on the device; `ocw-runtime account remove codex
  <id or label>` signs one out and removes it (and the server removes its row).

A device keeps up to 10 accounts. Each one has its own Codex home under `~/.ocw/accounts/codex/`, and they share one
session history, so a conversation can continue under another account. The device needs a recent Codex: an old one
ends the sign-in with "Update Codex on this device and try again."

## Pick a strategy

Each section (Claude, ChatGPT) has its own **Distribution**:

| Strategy (as Settings shows it) | What it does | Pick it when |
| --- | --- | --- |
| **Use one until its limit, then the next** (the default; *failover*) | The first ready account in your order. The next one only while it cools down. | You want the simplest, most predictable use: accounts are spent in the order you set (drag them with the arrows). |
| **Round-robin** | The ready account used least recently. | Accounts are equal and you want their usage spread out. |
| **Weighted** | Ready accounts in proportion to their weight (1–100). | Accounts are of different sizes (say, one Max and two Pro: weights 5, 1, 1). |

- **A session keeps its account until that account hits its limit.** The strategy chooses an account when a session
  starts, or when it must change, never per request: every switch loses the prompt cache, and per-request rotation is
  the pattern providers' anti-abuse checks look for.
- **Bots:** OpenClaw picks the account per bot conversation. Failover follows your order. Round-robin and weighted both
  give bots round-robin; Settings says "Bots don't support weighted. They use round-robin."
- **Use the device's own login when no account is ready** (on by default): when every account is off or cooling,
  sessions run on the device's own Claude or Codex login, as before the pool. Turn it off to refuse new sessions
  instead ("No account in the pool is ready. The earliest resets at …").

## What happens at a limit

1. The runtime reports the limit (Claude Code's rate-limit event or "You've hit your … limit"; Codex's usage-limit
   error), with the time it resets when the provider gives one. Never a token.
2. The account **cools down** until that reset (5 minutes when no time is given, at most 7 days). Its row reads
   **Cooling until 15:40** (or **Tue 15:40**).
3. **The same turn runs again** on the next ready account, in the same session: Claude Code resumes the same session,
   Codex resumes the same thread under the next account. The member sees the switch line in the timeline and the new
   label in the header; the prompt is not lost.
4. At most **3 switches per turn**. After that, or when no account is ready, the turn fails with "Every pool account
   reached its limit for this turn. The earliest resets at …", unless the device's own login can take it (the
   fallback above).
5. An account whose sign-in stopped working reads **Paste a new token** (Claude) or **Needs sign-in** (ChatGPT) and is
   skipped until an admin fixes it.

Bots handle limits inside the bots runtime: OpenClaw cools the limited account and moves to the next in the order.

Usage bars appear on a row when the runtime reported usage (Codex reports it; Claude only when it sends its rate-limit
event). The server never polls any usage endpoint.

## Where each credential lives

| Account | Where it lives | Who can read it | What the server keeps |
| --- | --- | --- | --- |
| **Claude setup-token** ("Sealed on the server") | The secret store, sealed per account | Nobody in the browser. The API opens it only to send it to the device running the session (in memory there, as `CLAUDE_CODE_OAUTH_TOKEN` for that session) or to the bots runtime | The sealed token, label, order, status, last use, usage |
| **ChatGPT on a device** ("On *device name*") | The device, in that account's Codex home (`auth.json`, written and refreshed by Codex) | Codex on that device. The runtime never reads the file | Label, plan, status, usage. No token, no e-mail, no path |
| **ChatGPT for bots** ("Bots runtime") | The bots runtime's OpenClaw store, one profile per account | OpenClaw in the bots runtime | Label, status. No token |

- A setup-token is never written to disk on a device, never logged and never in an event, an audit row or an error;
  the runtime's redaction also removes the token shape from anything it sends.
- A project cannot redirect a pool token: the runtime pins Claude Code's API address, proxy and certificates for pool
  sessions. A project whose `.claude/settings.json` sets `apiKeyHelper` chooses its own credentials, so it gets no pool
  token (its sessions use the device's own login).

## Remove an account

**Remove** asks for confirmation and says what happens:

- a Claude account: "Its token is deleted from the server.";
- a ChatGPT account on a device: "It is signed out on its device.";
- a ChatGPT account for bots: "It is signed out of the bots runtime." Only that account is signed out; the others stay.

A session that was using a removed or turned-off account moves to the next ready one before its next turn ("Switched to
account B: A is no longer available").

## Known limits

- **Continuing a conversation on another account** is built for both runtimes but still waits for the owner's check
  with real accounts. If it fails, the session says "This conversation could not continue on the next account. Start a
  new session." and the turn fails: a conversation never silently restarts from scratch.
- A project whose `.claude/settings.json` sets `apiKeyHelper` gets no pool token (above).
- Bots treat **Weighted** as round-robin.
- On a device with no Claude login of its own (pool accounts only), sessions start on the default model, and the
  automatic session title is not generated yet.
- A switch is a full prompt-cache miss: the turn after a switch costs more and is slower.
- Not in the pool: AI chats (each member's own plan), API keys (they stay on **Settings › Models** as metered models),
  and any proxy between a CLI and its provider.

## The providers' terms

Read them before adding accounts. Quoted from ADR-0044:

- Anthropic (code.claude.com/docs/en/legal-and-compliance): "Anthropic does not permit third-party developers to offer
  Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials
  on behalf of their users." and "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual
  usage of Claude Code and the Agent SDK."
- Anthropic consumer terms: "You may not share your Account login information … or Account credentials with anyone
  else."
- OpenAI Terms of Use: "You may not share your account credentials or make your account available to anyone else" and
  "circumvent any rate limits or restrictions".
- OpenAI Services Agreement: "Customer will not share Account access credentials or individual login credentials
  between multiple users" and "(i) violate or circumvent Usage Limits".

**The organization owns the accounts and the risk.** OCW does not provide accounts, does not pool across
organizations, uses each account only through Claude Code, the Agent SDK, Codex or OpenClaw's own sign-in, and never
rotates per request. It does not claim this use is permitted by those terms.
