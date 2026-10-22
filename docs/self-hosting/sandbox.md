# Bot sandboxes and the live browser

Each bot can get its own sandbox, where it writes files, runs commands and uses approved packages, and its own
browser, which people watch live in a small window and take over to sign in. The API decides, limits, audits and can
stop every call. The decisions behind this page are in
[ADR-0029](../adr/0029-bot-sandboxes-plugins-and-live-browser.md); images, smokes and host hardening are in
[infra/sandbox/README.md](../../infra/sandbox/README.md).

**Isolation, in one sentence.** Each bot runs in its own containers on its own private networks, under gVisor where
your Docker has it (Settings says "Isolated with gVisor") and otherwise in hardened containers that share the host's
kernel, a weaker boundary that Settings states ("Hardened container · weaker isolation").

## Turn it on

Three switches, all off by default. Nothing runs until all three are on.

1. **The compose profile** (the server). Add to `.env` (append `sandbox` if `COMPOSE_PROFILES` already exists), then
   `docker compose up -d --build --wait`:

   ```dotenv
   COMPOSE_PROFILES=sandbox
   OCW_SANDBOX_URL=http://sandboxd:8090
   ```

   `OCW_SANDBOX_TOKEN` is written by `pnpm ocw setup` (`pnpm ocw setup --add-missing` adds it to an older install).
   Docker Engine 26 or later is required. See [INSTALL.md](../INSTALL.md#bot-sandboxes-and-browser-optional-sandbox-profile).
2. **The organization switch** (an admin). Settings › **Sandbox & Browser** › *Sandbox & Browser for the
   organization*. Turning it on shows the isolation your server gives before you confirm.
3. **The bot's switches** (whoever configures the bot). Bots › the bot › **Capabilities** › Sandbox and Browser.

Admins and leads can keep a team out with Settings › **Modules** (Sandbox, Browser), per organization, unit or person.
A module that is off wins over every switch.

## Settings › Sandbox & Browser

| Section | What it controls | Default |
| --- | --- | --- |
| **Isolation** | Read only: gVisor, hardened containers, *service not reachable*, or *Docker too old*; for the browser, *container-only* when Chromium cannot use its own sandbox on this host | — |
| **Limits** | Sandboxes running at once (0–100), browsers at once (0–50), CPU minutes per day (1–100,000), disk per bot (1–100 GB), disk in total (1–1,024 GB), how long a sign-in lasts (1–90 days) | 10, 3, 600, 2 GB, 50 GB, 30 days |
| **Network** | The browser's and the shell's internet access: **Off**, **Allowlist** (only the hosts you list, up to 64) or **Public** (any public host). Private hosts come from Settings › MCP servers › *Private network hosts* | Browser Public, Shell Allowlist |
| **Sandbox packages** | Approved npm, PyPI, Debian and ClawHub packages for every bot's sandbox (below) | none |
| **Stop everything** | The kill switch: stops every sandbox and browser at once, including anyone signing in. Files are kept. Resume turns it back on | — |

Each container also has fixed limits: a shell 1 CPU, 1 GB of memory and 256 processes, stopped after 15 idle minutes; a
browser 1 CPU, 2 GB and 512 processes, closed 5 minutes after its last use (15 while a sign-in or an approval waits).
Settings are versioned: if another admin saved first, the page shows the current values and asks you to save again.

## The network

- Every sandbox reaches the outside only through the `sandbox-egress` proxy, which applies the same rules as the API's
  own outbound guard: public addresses only, ports 80 and 443, your private hosts by exact `host:port`, and never a
  platform service (the API, the database, the cell, sandboxd, the proxy itself), cloud metadata or another bot.
- A bot can never reach another bot's shell, browser or files, even if you list them as private hosts.
- The proxy never intercepts TLS and logs the host only, never a path or a query. Each new host a bot reaches (or is
  refused) is audited once an hour as `sandbox.egress`.

## Sandbox packages

Bots can install their own dependencies with commands, under the network rules. For something every bot should have,
an admin approves a **sandbox package**:

1. **Add package**: source (npm, PyPI, Debian, ClawHub skill), the exact name and one exact version.
2. The review runs in a throwaway container and shows the digest, license, publisher, size, whether it runs an install
   script, **how many dependencies it pulls, each pinned by hash**, and the risk with its reasons. High risk needs you
   to type `install anyway`; refused packages cannot be approved.
3. **Approve**: it installs in each bot's sandbox when that sandbox next starts, from exactly the recorded tree (`npm
   ci` from the stored lockfile, `pip --no-deps --require-hashes`, a sha256 per Debian or ClawHub file). Personal bots
   get it only with *Personal bots* on.

If the package or any of its dependencies changed upstream since the review, approval is refused and the review is
refreshed; after approval, the install is refused, nothing is written, and the row reads **Changed upstream** until you
review and approve it again. Native OpenClaw plugins with shell, file or browser tools stay refused in the Marketplace:
they would run inside the bot runtime, not a sandbox.

## Signing in for a bot

When a page needs an account, the bot posts a **Sign in needed** card. Only the person who asked sees **Open and sign
in**: they take control of the page in the live view, sign in themselves and **Hand back**.

- While they are in control, and whenever their sign-in is loaded in the page, nobody else receives a frame (others see
  *Private sign-in in progress* or *Private browsing for {person}*).
- The bot, the model, logs and the audit never see what they type; password fields are masked in everything the bot
  reads.
- The sign-in is sealed for that person, that site and that bot only, and reused only in that person's private chats
  with that bot. It lasts until the site's cookies expire or the organization's maximum, and the person revokes it in
  Settings › **Keychain** › *Browser sessions*. Admins never see it.
- Once a sign-in was used in a conversation, the bot asks that person before opening another site, clicking a link
  that leaves the site, or running a command with internet access, and team bots stop writing to their shared
  workspace in that conversation.

## Limits to know

- **Disk** is a soft quota: sandboxd measures before writes and every minute and stops a sandbox that goes over. For a
  hard limit, use XFS project quotas (infra/sandbox/README.md). The packages volume has no quota of its own.
- **Proxy restarts:** a running sandbox keeps the proxy's old address until its next start or restart, and has no
  internet until then (it fails closed).
- **Removing it:** `docker compose down` does not remove bot containers, because sandboxd created them. They go when a
  bot is deleted; to remove them all, filter by `label=ocw.namespace=<project>` (INSTALL.md).
- Not available: CAPTCHA solving, sharing a sign-in between people, recording sessions, desktop computer use.
