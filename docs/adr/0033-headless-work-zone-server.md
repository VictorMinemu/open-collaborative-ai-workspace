# ADR-0033: Headless Work Zone server

## Status

Status: Accepted. **Date:** 2026-10-29. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.12-11) from the owner's request and decisions D-01 … D-14 in
`.planning/phases/07.12-headless-work-zone-server/07.12-CONTEXT.md`, the planner decisions PD-01 … PD-19 in
`07.12-01-PLAN.md`, the research in `07.12-RESEARCH.md` and the 07.12 SUMMARYs.

**Builds on, without editing them:** [ADR-0005](0005-local-runtime-daemon-process-model.md) (the Local Runtime as a
standalone daemon), [ADR-0012](0012-full-access-mode-and-shared-devices.md) (shared devices),
[ADR-0021](0021-self-hosted-release.md) (decision 11: the Claude Agent SDK license exception),
[ADR-0030](0030-shared-work-zone-projects-and-session-visibility.md) (team projects) and
[ADR-0032](0032-runtime-cli-updates.md) (runtime CLI updates). Supersedes nothing. The user-facing guide is
[docs/SERVER.md](../SERVER.md).

## Context

The owner asked (2026-10-29) for "a CLI so we can host a server and let people connect and use the Work Zone in that
server without having the desktop app", and earlier, for 07.11, "above all for server-type computers, so users have
their shared sessions there".

Before this phase the only supported way to run the Local Runtime was the desktop app. `ocw-runtime` existed, but its
launcher ran the TypeScript sources through tsx, so it only worked inside a checkout of this monorepo. There was no
installable runtime, no service unit and no doctor, and pairing needed a code copied from the web. Shared devices
(03.2-05) and team projects (07.9) already let members run sessions on someone else's device from the web, and 07.11
already keeps the CLIs up to date on any device. What was missing was a way to get a headless machine there.

Principle 10 (open source first, everything works self-hosted) rules out a hosted download, an npm publish or a
third-party host for the runtime: a self-hosted workspace must serve its own.

## Decision

### Distribution from your own workspace (D-01, D-10, D-13, PD-03, PD-04, PD-05)

- **One file.** `apps/local-runtime/scripts/build-bundle.mjs` builds the runtime with esbuild into one ESM file,
  `ocw-runtime.mjs` (AGPL), plus `manifest.json`: version, sha256 and bytes of the exact file, the bundled packages with
  their licenses (only an allowlist, each notice in the file's footer), the external packages pinned at exact
  versions, and `source` (repository and commit). The build fails on a license outside the allowlist, on any input
  from the SDK, or on an SDK or peer that is not pinned exactly.
- **The Claude Agent SDK is never redistributed (D-10).** It is external to the bundle. `install.sh` installs that
  exact version and its peers beside the bundle with `npm install --prefix <dir> --no-audit --no-fund --omit=optional
  --ignore-scripts`, from the npm registry the machine already uses. The workspace serves only our AGPL code and its
  permissive dependencies. So the ADR-0021 decision 11 exception is not widened to every self-hosted API: the SDK
  remains the server admin's own npm download, as it is for any npm user.
- **Served by the API.** Four public, read-only routes under `/api/v1/runtime/`: `version` (the manifest),
  `bundle` (with `ETag` and `x-content-sha256`), `bundle.sha256` and `install.sh`. The dist directory is
  `OCW_RUNTIME_DIST_DIR` (the image sets `/app/runtime-dist`, root-owned, built in a `runtime-bundle` stage that
  receives `OCW_SOURCE_COMMIT`). It is re-hashed against its manifest before it is served: missing → 404
  `runtime_unavailable`, mismatch → 503 `runtime_corrupt`. The script's server URL comes only from
  `OCW_PUBLIC_API_URL`, never from the Host or X-Forwarded-Host header, and is restricted to a safe character set and
  single-quoted.
- **The install script** (`apps/api/src/modules/device/install-script.sh`, POSIX `sh`): its whole body runs from
  `main()` on the last line, so a cut download runs nothing. It refuses a non-Linux/macOS system, Node below 24, a
  missing npm, and plain `http://` to a non-loopback host unless `OCW_INSTALL_ALLOW_HTTP=1`. It checks the sha256 with
  node before using the file. It installs for the current user only into `$OCW_HOME/runtime/versions/<sha12>/`, links
  `current`, writes `install.json` and the launcher `~/.local/bin/ocw-runtime`, keeps the new and the previous
  version, never uses sudo, warns as root, and never restarts a running service (it prints the restart command).

### Terminal pairing by device code (D-03, D-13, PD-06, PD-07, PD-08)

- **Shape of RFC 8628.** `ocw-runtime enroll --server <url>` (and `setup`) asks `POST /api/v1/devices/pairings` for
  a device code (32 random bytes, the poll secret, never shown) and a user code (8 Crockford base32 symbols, 40 bits,
  shown `XXXX-XXXX`), prints the verification link `<web>/settings/devices?pair=<code>` and the code, and polls
  `POST /devices/pairings/token` at the server's interval, adding 5 s on `slow_down`. Answers:
  `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, or the device token.
- **Pre-tenant state in Redis only.** The pending request lives 10 minutes under hashes of both codes (neither is
  stored in clear). Approval in Settings › Devices (`device.pair`, the same permission as today's enrollment code)
  writes an ordinary `device_enrollments` row (code hash domain-separated from typed codes) and its audit row in the
  approver's tenant transaction, then moves the Redis record from pending to approved with a Lua compare-and-set inside
  that transaction, so a lost race rolls everything back (409). The token poll then mints the device token through
  `enrollWithCodeHash`, the same transaction the typed-code path uses. The device belongs to the approver's
  organization and user, exactly like today's enroll; the typed-code flow is unchanged. No migration.
- **Limits** (in memory, per API instance, per apparent client IP; `OCW_TRUST_PROXY` behind a proxy): start 10 per
  10 minutes per IP; token 60 per minute per IP plus `slow_down` per device code; lookup, approve and deny 10 per minute
  per member, one shared bucket; the four download routes 30 per minute per IP each.
- **Audit:** `device.pairing_approved`, `device.pairing_denied`, and `device.enrolled` with `via: code | device_code`.
  No audit row or log line carries a code or a token. Start and poll are pre-tenant and not audited.
- **Phishing and guessing.** The approve dialog shows the code, the requested name, platform, request IP, age and
  runtime version, says "Only approve a code you started yourself, on a computer you control", and decides nothing
  when the page loads. 40 bits, 10 minutes, single use and the per-member limit make guessing impractical. The
  sign-in redirect keeps `?pair=`.
- This is the user-facing slice of Phase 8's pairing; an Ed25519 device identity stays in Phase 8.

### Setup, service and doctor (D-02, D-04, D-05, D-07, D-12, D-14, PD-09 … PD-13, PD-15)

- **`ocw-runtime setup`** runs server URL → pairing (skipped when the token still works; re-pairing a revoked device
  needs a confirmation or `--yes`; a different server is refused) → projects → service → doctor → the Settings ›
  Devices link. Prompts only on a terminal, every prompt has a flag, re-running changes nothing. Exit codes 0, 1, 2,
  130. A system unit is two steps: setup as the account prints the unit and the root lines, then root runs them.
- **`ocw-runtime service install|uninstall|status|logs|restart`.**
  - Linux: a systemd **user** unit by default (it prints `sudo loginctl enable-linger <account>` when lingering is
    off, since a server must run without a login session), or `--system`, a system unit with `User=<account>`.
  - **Root never runs the runtime's files (07.12 review HI-01).** The launcher, the bundle and `install.json` belong to
    the runtime's account, which its sessions (prompted by any member the device is shared with) can change, so root
    running any of them would be a one-step escalation. `service install --system` therefore runs as the account and
    only prints: the unit, rendered from that account's install, inside a heredoc for
    `sudo install -m 0644 /dev/stdin /etc/systemd/system/ocw-runtime.service`, then `sudo systemctl daemon-reload` and
    `enable --now` (or `restart` for a changed unit). The admin reads `User=<account>` and runs those lines: root runs
    only `install` and `systemctl`, and the unit runs the account's files as the account. `restart` and `uninstall` on
    a system unit print the `systemctl` lines instead of running them, and every `ocw-runtime service` command run as
    uid 0 stops with this rule. A root-owned copy of the runtime (for example under `/opt`) was rejected: it needs a
    second, root-run install and update path, while `User=` already confines the runtime to its account.
  - macOS: a LaunchAgent (`ProcessType=Standard`, logs in `~/.ocw/logs/runtime.log`, rotated at 5 MB). A LaunchAgent
    needs the account's login session, so a Mac server needs automatic login for that account.
  - Anything else (containers, WSL without systemd): refused with "run `ocw-runtime run` under your own supervisor".
  - Units carry the absolute node and bundle paths and the PATH captured at install, `Restart=on-failure` with start
    limits, `UMask=0077`, no TCP port and no secret.
  - **Escaping.** `ExecStart=` words are double-quoted with `%`, `$`, `\` and `"` escaped. `Environment=` values escape
    `\`, `"` and `%` but not `$` (systemd does not expand it there; `$$` would reach the service as two dollars).
    `WorkingDirectory=` is unquoted (systemd does not unquote it) with `%` doubled. Plist values are XML-escaped.
  - **Never as root.** A system unit refuses `--user-name root` and any account other than the one printing it; no
    `service` command runs as uid 0.
  - **One runtime per `~/.ocw` (D-14).** Install refuses while another runtime owns the account's `~/.ocw` (a live
    control socket that is not this unit, or the desktop app's daemon). A re-install rewrites the unit and restarts it
    only when the content changed and no session runs.
- **`~/.ocw/service.env` (D-12).** Optional `NAME=value` lines read by the daemon itself at start (so it works the
  same under systemd, launchd or any supervisor), for example `CLAUDE_CODE_OAUTH_TOKEN`. A key already in the
  environment wins; `OCW_HOME` is never taken from it. Refused unless mode 0600 and owned by the running user. The
  units never reference it.
- **`ocw-runtime doctor [--json]`.** Thirteen checks in a fixed order (node, runtime, pairing, server, daemon,
  service, claude-code, codex, runtimes, git, projects, updates, service-env), each `ok | warn | fail` with one fix
  line, exit 1 on any fail. Runtime facts and the updates level come from the running daemon when one answers. The
  sign-in fix lines are headless: `claude auth login` or `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN` in
  service.env; `codex login --device-auth` or an `ssh -L 1455` forward, each as the service's account. Every line is
  redacted: no token, JWT or service.env value, and paths are `~/…` or `<outside home>`. It asks the server only
  `/health`, `/api/v1/runtime/version` and the token exchange.
- **Repositories (D-07):** `add-project`, and `remove-project <dir|name|id>`. Cloning stays the admin's job.
- **Sharing stays in the web (D-06):** no new permission and no CLI path to grant access; setup and doctor print the
  device's Settings › Devices link. Members reach the server through 03.2-05 shares and 07.9 team projects.

### Tests never touch this machine (PD-19)

No test or proof installs, enables, starts or stops a real systemd or launchd service, writes the real
`~/.config/systemd`, `~/Library/LaunchAgents`, `~/.ocw` or `~/.local/bin`, or runs the real Claude Code or Codex.
Service code runs through an injected exec under a temp root, and `defaultServiceExec` refuses `systemctl`,
`loginctl`, `launchctl` and `journalctl` whenever `VITEST` is set unless `OCW_SERVICE_PROOF=1`. CLI tests, the e2e and
the install-script tests use a scratch `HOME`/`OCW_HOME`, a `PATH` without the developer's bins, the fake runtime and
updates off, and a fake npm. The opt-in container proof (`scripts/headless-server-proof.sh`) runs the whole chain in a
pinned `node:24` slim container (plus `curl git ca-certificates`, D-11) under dash as a non-root user.

## Consequences

- **Server admins** run one command from Settings › Devices › Add a device › Server, then `ocw-runtime setup`, and
  approve the printed code from any signed-in device. They install and sign in Claude Code or Codex as the service's
  account, with the doctor's headless lines. `docs/SERVER.md` is their guide.
- **The API serves code.** Every self-hosted workspace serves the runtime built into its image, under four public,
  rate-limited routes with no off switch: the code is AGPL and public, and a knob nobody asked for is overhead. The
  manifest names its source commit when the image is built with `OCW_SOURCE_COMMIT` (compose passes it; the compose
  gate requires it on a clean tree).
- **The SDK stays the user's npm download (D-10).** Servers need outbound access to an npm registry or a mirror at
  install time. If the ADR-0021 exception were refused, nothing here changes: the SDK is already outside the bundle.
- **Rate limits are per API instance.** Behind a reverse proxy `OCW_TRUST_PROXY` must be set, or every server shares
  the proxy's IP budget. Several API instances each enforce their own budget.
- **Sessions run as the server's account.** Sharing a server means sharing that account's files, git credentials and
  sign-ins with the members it is shared with, within the modes the owner allows (ADR-0012).
- **Known limits:** a Mac server needs automatic login; a user unit needs lingering and a real login of the account to
  install; root writes a system unit from printed lines (one copy and paste); doctor run as another account checks
  that account.
- **Deferred:** a Windows service; Ed25519 device identity and key rotation (Phase 8); cloning repositories from the
  CLI; sharing or grants from the CLI; a container image for the runtime; self-update of the runtime (re-running the
  install command upgrades it today).

### Validation

Unit tests (bundle build and run outside the repo, contracts, pairing client, service units and launchd on a fake
machine, service.env, doctor, setup, CLI), integration tests on real PostgreSQL and Redis (pairing flow, every RFC 8628
answer, races, limits, `device.pair`, organization B, no code in logs, the distribution routes and the Host-header
case), web tests and the isolated e2e on both Playwright projects (`headless-pairing.spec`,
`work-zone-headless-server.spec` and every other spec), the container proof (`headless-server proof: ok`) and
`pnpm gate:compose` with its `runtime-dist` step; recorded in `07.12-VALIDATION.md`. **Owner checks pending:**
`docs/DEMO.md` › Headless Work Zone server (Phase 07.12): a real Linux VM with reboot and restart, real Claude Code and
Codex turns after headless sign-ins, a Mac LaunchAgent across a reboot, and a doctor output read for leaks.
