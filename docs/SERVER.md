# Host a Work Zone server

This guide is for an admin who wants a Linux or macOS machine to run Work Zone sessions for the team, without the
desktop app. You install the Local Runtime (`ocw-runtime`) from your own workspace, pair it from the terminal, run it
as a service, and share it with members and teams in the web. Members then pick the server in **New session** like
any other device. Decisions behind this guide: [ADR-0033](adr/0033-headless-work-zone-server.md).

The workspace itself is installed with [INSTALL.md](INSTALL.md). This guide is about the machines that run sessions.

## Requirements

| What | Notes |
| --- | --- |
| OS | Linux (systemd for the service) or macOS. Windows: not yet |
| Node.js | 24 or later, with npm. `install.sh` refuses an older Node |
| git | The sessions work on git repositories |
| curl or wget | To download the installer and the runtime |
| A user account | A normal, non-root account that owns the runtime, the repositories and the Claude Code / Codex sign-ins |
| Network | Outbound HTTPS to your workspace, and to the npm registry the machine already uses (or a mirror) |

Use a dedicated account (for example `ocw`) on a shared machine. The runtime never needs root: `install.sh` warns when
run as root, and no `ocw-runtime service` command runs as root.

## Install

In the web: **Settings › Devices › Add a device › Server**. It shows the command for your workspace. On the server, as
the account that will run it:

```bash
curl -fsSL https://ocw.example.com/api/v1/runtime/install.sh | sh
```

The script:

- downloads the runtime from your workspace (`/api/v1/runtime/bundle`) and checks its SHA-256 before using it;
- installs the Claude Agent SDK, its peers and their whole dependency tree beside it from npm with `npm ci
  --omit=optional --ignore-scripts`, from a lockfile embedded in the script: every package at the exact version the
  runtime was built and tested with, each download checked against its integrity hash. The workspace never serves the
  SDK: it is your own npm download;
- writes only to `~/.ocw/runtime/versions/<sha>/`, the `~/.ocw/runtime/current` link, `~/.ocw/runtime/install.json`
  and the launcher `~/.local/bin/ocw-runtime`;
- never uses sudo and never changes system files. It warns when run as root.

If `~/.local/bin` is not on your PATH, the script prints the line to add to `~/.profile`.

Options, as environment variables before `sh`:

- `OCW_HOME=/srv/ocw`: install somewhere other than `~/.ocw`. The launcher keeps it, so every `ocw-runtime` command
  and the service then use it (an `OCW_HOME` exported later still wins). Where this guide (and the doctor's fix
  lines) say `~/.ocw/…`, read `$OCW_HOME/…`.
- `OCW_SERVER_URL=<url>`: download from another address for the same workspace (for example inside a container).
- `OCW_INSTALL_ALLOW_HTTP=1`: allow plain `http://` to a host other than this machine. Only on a network you trust.

**Upgrade** by running the same command again. It installs the version your workspace serves now and keeps the
previous one. It never restarts a running service: when no session runs, run `ocw-runtime service restart` (a system
unit: `sudo systemctl restart ocw-runtime.service`).

## Set up

```bash
ocw-runtime setup
```

`setup` does everything in order and can be run again at any time:

1. **Server.** `--server <url>`, else the one the installer used.
2. **Pairing.** It prints a link and a code, and waits (see below). Skipped when the machine is already paired.
3. **Repositories.** `--project <dir>`, repeatable. Clone them first with your own git credentials.
4. **Service.** `--service user|system|none` (see [Run it as a service](#run-it-as-a-service)).
5. **Doctor.** It prints the checks (see [Troubleshooting](#troubleshooting-with-the-doctor)). A failing check does
   not fail setup.
6. **The link** to the device in Settings › Devices, where you share it.

On a terminal it asks for anything missing. Every question has a flag, so a script can run it:

```bash
ocw-runtime setup --yes --name build-01 --project ~/src/app --project ~/src/api --service user
```

| Flag | Meaning |
| --- | --- |
| `--server <url>` | The workspace's URL. Refused when the machine is already paired with another workspace |
| `--name <name>` | The device name proposed for approval (default: the host name). The approver can change it |
| `--project <dir>` | Register a repository (repeatable; already registered ones are skipped) |
| `--service user\|system\|none` | How to keep it running. `system` needs `--user-name` |
| `--user-name <account>` | The account a system unit runs as |
| `--yes` | Do not ask. Without `--service`, installs the user service when a service manager exists, else none |

Exit codes: `0` done, `1` a step failed, `2` a missing or wrong flag (or a value it cannot ask for without a terminal),
`130` cancelled.

If the device was revoked in the web, `setup` asks before pairing again (`--yes` confirms), then restarts the running
service so it connects with the new pairing (when a session runs, or for a system unit, it prints the restart line
instead). Setup warns when the server URL is plain `http://` to another host.

Repositories later: `ocw-runtime add-project <dir>`, `ocw-runtime remove-project <dir|name>`, `ocw-runtime projects`.
A folder without git works too: sessions run in it; the Changes view says "No git" and isolated worktrees are off.

## Pairing

`setup` (or `ocw-runtime enroll --server <url>`) prints:

```text
To pair this computer, open:
  https://ocw.example.com/settings/devices?pair=ABCD-EFGH
or open https://ocw.example.com/settings/devices?add=server and enter the code:
  ABCD-EFGH
Waiting for approval (expires in 10 minutes). Press Ctrl-C to cancel.
```

Open the link signed in, on any device (a phone works). The dialog shows the code, the proposed name, the platform,
the IP the request came from, when it was made and the runtime version. Check that the code is the one the server
shows, change the name if you like, and press **Approve**. The server becomes one of your devices, in your
organization, within a few seconds.

- **Only approve a code you started yourself, on a machine you control.** Approving adds that machine to your devices.
- A code works once and expires after 10 minutes. **Deny** stops the waiting server.
- Approving needs the **Pair your own devices** permission (developers, leads and admins, while the Work Zone module
  is on for you).
- The older flow still works: a one-time code from the Desktop app or Command line tab, then
  `ocw-runtime enroll --server <url> --code <code>`.

## Share it with members and teams

Sharing stays in the web, never in the CLI. In **Settings › Devices**, on the server's card:

- **Add people or teams** on the server's card. They start as Supervised; raise the highest mode each may use from
  the list. The server then appears in their New session.
- **Team projects:** link the server's repositories to a team project (Work Zone › the project). Members of the
  project's teams start sessions there.

Sessions run as the server's account, with its files, git credentials and sign-ins. Share only with people who may act
as that account on those repositories.

## Sign in to Claude Code and Codex on the server

Install the CLIs as the account that runs the runtime, in its home, so the runtime can find and update them:

- Claude Code with Anthropic's native installer: `curl -fsSL https://claude.ai/install.sh | bash`.
- Codex with OpenAI's standalone installer (see the Codex README).

[INSTALL.md › Keep Claude Code and Codex up to date](INSTALL.md#keep-claude-code-and-codex-up-to-date-on-devices) lists
the other install methods the runtime can update.

Then sign in as that account. Neither needs a browser on the server:

- **Claude Code:** `claude auth login`, press `c` to copy the login URL, open it on any computer and paste the code
  back. Or run `claude setup-token` on any computer and put `CLAUDE_CODE_OAUTH_TOKEN=…` in `~/.ocw/service.env`.
- **Codex:** `codex login --device-auth` (turn on device code login in your ChatGPT security settings first). Or, from
  your computer, `ssh -L 1455:localhost:1455 <account>@<server>` and then `codex login` on the server.

For a system unit, run them as its account: `sudo -u <account> -i claude auth login`. The doctor prints these lines
with the right account.

### `~/.ocw/service.env`

An optional file for the runtime's environment, such as `CLAUDE_CODE_OAUTH_TOKEN`, `HTTPS_PROXY` or
`OCW_RUNTIME_UPDATES`:

```bash
install -m 600 /dev/null ~/.ocw/service.env
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' '<token>' >> ~/.ocw/service.env
ocw-runtime service restart
```

- One `NAME=value` per line, `#` comments, no expansion. A variable already in the environment wins.
- The runtime reads it when it starts, under systemd, launchd or your own supervisor alike. Restart after a change.
- It must be mode 600 and owned by the account. Otherwise the runtime refuses it and logs the `chmod 600` fix.
- The doctor shows which names are set, never the values. Unit files never contain secrets.

## Updates

The runtime keeps Claude Code and Codex up to date by itself and never cuts a running turn (Phase 07.11). The
organization sets the level in Settings › Work Zone policy › Runtime updates; the server can only lower it:
`ocw-runtime updates notify|off|automatic`, or `OCW_RUNTIME_UPDATES` in `~/.ocw/service.env`. Details:
[INSTALL.md](INSTALL.md#keep-claude-code-and-codex-up-to-date-on-devices).

The runtime itself is updated by re-running the install command (see [Install](#install)). The doctor warns when the
installed runtime differs from the one your workspace serves.

## Run it as a service

```bash
ocw-runtime service install     # or: setup --service user
ocw-runtime service status
ocw-runtime service logs [-n 200] [--follow]
ocw-runtime service restart
ocw-runtime service uninstall
```

The service runs `ocw-runtime run` with the absolute paths of node and the runtime, restarts it on failure, writes no
secret in the unit and opens no network port.

**Linux, user unit (default).** `~/.config/systemd/user/ocw-runtime.service`, logs in the journal. Run the install
from a real login of the account (SSH, or `machinectl shell <account>@`), not through `sudo -u`, which has no user
service manager. A server must run without anyone logged in, so turn on lingering once, as an admin:

```bash
sudo loginctl enable-linger <account>
```

`service install` prints this line when lingering is off.

**Linux, system unit for a named account.** `/etc/systemd/system/ocw-runtime.service`, running as `<account>` (never
root). Root never runs `ocw-runtime`: its launcher, runtime and `install.json` belong to the account, and the account's
sessions can change them. So the account prints the unit, and root only writes that text and runs `systemctl`:

```bash
# 1. As the account: pair, register repositories, print the unit and the root lines
sudo -u <account> -i ocw-runtime setup --service system --user-name <account>
#    (later, to print them again: sudo -u <account> -i ocw-runtime service install --system)
# 2. As root: check that the printed unit says User=<account>, then paste the printed lines, which look like
sudo install -m 0644 /dev/stdin /etc/systemd/system/ocw-runtime.service <<'OCW_UNIT'
# Generated by ocw-runtime service install; re-run it instead of editing.
[Unit]
…
User=<account>
ExecStart="/usr/bin/node" "/home/<account>/.ocw/runtime/current/ocw-runtime.mjs" run
…
OCW_UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now ocw-runtime.service
```

The unit runs the account's files as the account (`User=`), never as root. A changed unit prints
`systemctl restart` instead of `enable --now`; run it when no session runs. A non-default `OCW_HOME` goes into the
unit. `ocw-runtime service status` and `logs` find the system unit by themselves. Anything else on it is root's, with
system binaries only:

```bash
sudo systemctl restart ocw-runtime.service
sudo journalctl -u ocw-runtime.service -n 200
sudo systemctl disable --now ocw-runtime.service && sudo rm /etc/systemd/system/ocw-runtime.service && sudo systemctl daemon-reload
```

`ocw-runtime service restart` and `uninstall` print these lines for a system unit, and every `ocw-runtime service`
command run as root stops and says so.

**macOS.** A LaunchAgent, `~/Library/LaunchAgents/org.ocw.runtime.plist`, logs in `~/.ocw/logs/runtime.log` (moved to
`runtime.log.1` above 5 MB). A LaunchAgent runs only while the account is logged in. On a Mac server, turn on
automatic login for that account (System Settings › Users & Groups), so the runtime comes back after a reboot.

**No systemd (containers, WSL without systemd).** `service install` refuses. Run `ocw-runtime run` under your own
supervisor: a Docker restart policy, tmux, supervisord.

### One runtime per account

Each account's `~/.ocw` has one runtime: the desktop app or the service, never both. `service install` refuses while
the desktop app (or a hand-started `ocw-runtime run`) runs on the account. Quit it first, or use another account.

## Isolated server (Phase 07.16)

Bots can run Work Zone sessions on this server (ADR-0038, [DEMO.md](DEMO.md#bot-work-zone-orchestration-phase-0716)).
After a bot reads outside content (MCP results, attachments, webhooks, mail, web pages), text written by others can
steer what it asks the coding agent to do. Such a session runs in Full access **only on an isolated server**. Turn the
mark on only on a machine that holds nothing else that matters: no other projects, no personal credentials, no access
to internal systems the bot should not reach.

```bash
ocw-runtime full-access on          # the device's own Full access opt-in (ADR-0012), needed for any Full access
ocw-runtime isolated-server on      # prints the warning, then sets the mark
ocw-runtime isolated-server status  # {"isolatedServer": true, "host": "service", "honoured": true, ...}
ocw-runtime isolated-server off
```

- **Set only here.** The mark lives in `~/.ocw/runtime.json` and reaches the API only in the device's own frames. The
  web and the API can never set it; Settings › Devices shows it read-only ("Set on the device").
- **`OCW_ISOLATED_SERVER`** (`1`/`true` or `0`/`false`) in the daemon's environment, for example in
  `~/.ocw/service.env`, overrides `runtime.json`. `status` shows the source.
- **Only for service installs.** The API honours the mark only when the daemon reports itself as a headless service:
  `OCW_RUNTIME_HOST=service`, which the systemd unit and the LaunchAgent set, or the bundle `install.sh` installed. The
  desktop app sets `OCW_RUNTIME_HOST=desktop`, so a laptop is never isolated; there `status` says `"honoured": false`
  with a note.
- **It allows nothing alone.** A bot still needs the organization policy, the device's Full access opt-in, the
  sponsor's Full access on this device, "Allow Full access for this bot" and a profile whose highest mode is Full
  access. Without the mark, a session that once followed outside content never runs in Full access here again.

## Behind a proxy

The pairing and download routes are rate limited per client IP, per route and per API instance:

| Route | Limit |
| --- | --- |
| Start a pairing | 10 per 10 minutes per IP (an IPv6 /64 counts as one IP); at most 1,000 per 10 minutes per workspace |
| Poll for approval | 60 per minute per IP |
| Look up, approve, deny | 10 per minute per member, shared |
| `install.sh`, bundle, checksum, version | 30 per minute per IP, each |

When the API runs behind a reverse proxy, set `OCW_TRUST_PROXY=1` on the API so it sees each client's IP; otherwise
every server shares the proxy's budget. The bundled Caddy proxy sets it
([reverse-proxy.md](self-hosting/reverse-proxy.md)). With several API instances, each one counts on its own.

The install script takes its server URL from the API's `OCW_PUBLIC_API_URL`, never from the request. To stamp the
runtime's source commit in its manifest, build the images with
`OCW_SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build --wait`.

## Troubleshooting with the doctor

```bash
ocw-runtime doctor            # or --json
sudo -u <account> -i ocw-runtime doctor    # for a system unit: run it as the service's account
```

Each check is `ok`, `warn` or `fail` with one fix line; the exit code is 1 when any check fails. The output contains no
token, no service.env value and no path outside the home, so you can paste it into an issue. It asks the server only
`/health`, `/api/v1/runtime/version` and the device's token exchange.

| Check | What it means |
| --- | --- |
| `node` | Node 24 or later |
| `runtime` | The installed runtime matches the one your workspace serves |
| `pairing` | This machine has a device token the workspace accepts; names the device, organization and owner |
| `server` | The workspace answers `/health` |
| `daemon` | The runtime is running and connected |
| `service` | The service is installed and active (and lingering is on, on Linux) |
| `claude-code`, `codex` | Installed, a supported version, signed in as the service's account |
| `runtimes` | At least one of them is installed and signed in |
| `git` | git is installed |
| `projects` | Each registered repository exists and is a git repository |
| `updates` | The runtime CLI updates level of the running runtime |
| `service-env` | `~/.ocw/service.env`: absent, loaded (names), or refused |

A new server shows `runtimes: fail` until Claude Code or Codex is installed and signed in: that is expected right
after `setup`. Run as another account (for example root), the doctor checks that account's files and sign-ins, so run
it as the service's account.

Other common cases:

- **The device stays offline.** `ocw-runtime service status`, then `ocw-runtime service logs`. After a reboot on
  Linux, check lingering; on a Mac, automatic login.
- **"This device is paired with <A>".** Revoke it in Settings › Devices on A, then run `setup --server <B>`.
- **A session cannot start a runtime.** The doctor's `claude-code` and `codex` lines say what is missing.

## Uninstall

```bash
ocw-runtime service uninstall
rm -rf ~/.ocw/runtime ~/.local/bin/ocw-runtime     # ~/.ocw/runtime holds install.json too
```

Then revoke the device in Settings › Devices. `~/.ocw` also holds the pairing and the registered repositories; remove
it too to start from scratch.

## Not supported yet

- A Windows service.
- Cloning repositories from the CLI (clone them yourself, then `add-project`).
- Sharing or granting access from the CLI (use Settings › Devices).
- A container image of the runtime.
