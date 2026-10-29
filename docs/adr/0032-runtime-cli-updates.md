# ADR-0032: Runtime CLI updates on devices

## Status

Status: Accepted. **Date:** 2026-10-28. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.11-11) from the owner's request and decisions D-01 … D-12 in
`.planning/phases/07.11-runtime-cli-auto-updates/07.11-CONTEXT.md`, the planner decisions PD-01 … PD-19 in
`07.11-01-PLAN.md`, the research in `07.11-RESEARCH.md` and the 07.11 SUMMARYs.

**Reuses, without editing it:** [ADR-0012](0012-full-access-mode-and-shared-devices.md) (the device-local opt-in that
can only lower what the organization allows: desktop menu, `ocw-runtime` command, environment variable). Builds on
[ADR-0013](0013-work-zone-session-settings-protocol.md) (the adapters and their pinned versions). Supersedes nothing.

## Context

The Local Runtime drives two vendor CLIs: Claude Code (through the Claude Agent SDK, one CLI process per session) and
Codex (one `codex app-server` per session). Both ship often. Until now, keeping them current was the device owner's
job.

The owner asked (2026-10-28) for automatic updates of Claude Code and Codex, "look at how T3 Code does it", "above all
for server-type computers, so users have their shared sessions there", "and the local ones too". The main target is a
shared server: a headless daemon, often on Linux, where several members run shared sessions (03.2-05 shared devices,
07.9 project sessions) on the owner's login. Nobody watches that machine. Members' own laptops get the same mechanism.

T3 Code (read from its shipped bundle, CONTEXT) resolves how each CLI was installed, finds the one command that
updates it, asks the npm registry for the latest version, checks the candidate against a compatibility manifest, and
runs the update with a lock, a timeout and a re-check afterwards. Its updates are one click. One click is not enough
on an unattended server, and an update that replaces a CLI in the middle of a member's turn would cut that turn. So
we keep T3 Code's resolver, runner and manifest ideas, make updates automatic by default, put them behind a gate that
never cuts a turn, serve the manifest from our own Control Plane, and make the whole thing governed and audited.

## Decision

### One update authority, on the device (D-01, D-05, D-08, D-12, PD-09, PD-11, PD-14)

- **Scope.** Only the Claude Code and Codex CLIs, on every device the daemon runs on (macOS, Linux; Windows is
  manual). Our own daemon and desktop app do not update themselves here (Phase 9).
- **A fixed table on the device chooses the command** (`apps/local-runtime/src/maintenance/install-method.ts`). The
  daemon resolves the CLI on `PATH`, follows its real path and matches it, in order:
  - native Claude Code (`~/.local/bin/claude` → `~/.local/share/claude/versions/…`) → `<bin> update`;
  - Codex standalone (under `${CODEX_HOME:-~/.codex}/packages/standalone/`) → `<bin> update` with that `CODEX_HOME`;
  - npm global (`<prefix>/lib/node_modules/<pkg>`) → `<prefix>/bin/npm install -g --prefix <prefix>
    <pkg>@<candidate>`;
  - Homebrew cask or formula, confirmed by that prefix's own `brew` → `brew upgrade [--cask] <name>`.
  - pnpm, bun, yarn and Volta globals are recognised but **manual**: their update commands are not proven (RESEARCH
    A3). The device shows the command and never runs it.
  - apt/dnf/apk system paths, mise, asdf, a project's `node_modules`, the SDK-bundled Claude CLI, Windows and anything
    unknown are manual too.
- **The server never sends a command.** "Update now" sends only `{ runtime }` (`RuntimeUpdatePayload`, strict). The
  device runs its own detected command for that runtime. No string from the server reaches a spawn.
- **No escalation.** The update runs as the daemon's user. When what the method writes is not writable (`access
  W_OK`), the method is `needs_admin`: the device shows the command (with `sudo`, except Homebrew, which refuses root)
  and never runs it. `DISABLE_UPDATES` for Claude Code makes it `updates_disabled`.
- **The runner** (`maintenance/runner.ts`): one lock file per install root in `~/.cache/ocw/runtime-updates/` (0700
  directory, 0600 file, exclusive create, stale when its pid is gone; a busy lock queues, retried every 5 s, given up
  after 10 min); `shell: false`; its own process group, killed as a group after 5 min; a child environment without any
  `OCW_*` variable, API key or device token; the install is re-resolved under the lock and a changed method or root
  fails without running. Afterwards it probes `--version`: moved up → `succeeded`, unmoved → `unchanged`, non-zero exit
  or timeout → `failed`, moved down → `failed`. Output is ANSI-stripped, sanitized, scrubbed of host paths and capped
  (10 KB kept, 4 KB sent).
- **CLI self-updaters off.** Every Claude Code process the daemon launches gets `DISABLE_AUTOUPDATER=1` (a parent value
  cannot switch it back on). Every `codex app-server` gets `-c check_for_update_on_startup=false`. **D-12 for Codex is
  "flag passed, effect unconfirmed":** the pinned 0.160.0 and 0.164.0 accept the flag and carry the key in their
  config schema (07.11-05), but 0.164.0 also accepts unknown `-c` keys silently, the key belongs to the interactive
  startup check, and a standalone install keeps its own `auto-update-version` file. So we cannot prove that no Codex
  process ever updates itself. The runner re-detects the version after every run, so a self-update is seen and
  reported either way. The user's own interactive CLIs keep their updaters.

### Latest version and the manifest (D-04, D-07, PD-10, PD-12)

- **Latest version:** `GET <registry>/<package>/<dist-tag>` on the npm registry (`@anthropic-ai/claude-code`,
  `@openai/codex`), 4 s timeout, body ≤ 64 KB, validated, cached 1 h; any failure → `unknown`. The dist-tag follows the
  install: Homebrew `claude-code` → `stable`, native Claude → `stable` when the user's Claude settings ask for it, else
  `latest`. `OCW_RUNTIME_REGISTRY_URL` (device environment only) points at a corporate mirror. This is the only
  outbound call the device makes for updates, besides what the installer itself does.
- **Cadence:** at daemon start (a paired daemon first waits up to 30 s for the organization's level, so an organization
  at `off` makes no request), then every 6 h with up to 30 min of jitter, plus on demand.
- **The compatibility manifest is ours** (`RUNTIME_COMPATIBILITY_MANIFEST` in
  `packages/contracts/src/runtime-maintenance.ts`, Zod-validated). Claude Code is `supported` from 2.1.287 and
  Codex from 0.160.0 (the oldest committed adapter fixtures), older is `unsupported`, the pinned fixture versions are
  recommended, and there is no `broken` range yet. A known-bad release becomes a `broken` range in a server release.
- **The Control Plane serves it.** The API sends its bundled copy in `runtime.config`; the device keeps the newer of its
  own bundled copy and the server's (`updatedAt`). The device never fetches compatibility from a third party.
- **What it decides.** A `broken` candidate is never installed (`skipped_broken`, audited once per candidate). A
  device whose installed version is `broken` refuses new sessions on that runtime with "{Runtime} {version} on
  {device} can't run Work Zone sessions. Ask the device owner to update it." (PD-13). `unsupported` starts and is
  flagged to everyone who sees the device (`Device.runtimeCompatibility`) and in the new-session dialog.

### The gate: never cut a turn (D-03, D-03a, D-03b, PD-07)

- A turn of runtime R is in flight when the adapter counts it (running or queued, approvals included) or a command is
  between admission and the adapter call. One `RuntimeGate` per runtime (`maintenance/gate.ts`) admits commands and
  counts them in the same synchronous step as its idle check, so nothing slips in between.
- **Opportunistic first.** An automatic update waits up to 1 h with the gate open and takes the first idle moment,
  closing the gate in that same tick.
- **Then drain.** After 1 h, or at once for "Update now", the gate closes: in-flight turns finish, new turns of R wait.
  Held: `session.start`, `prompt` and steer, `session.configure`, `session.title` and catalog collection for R. Never
  held: `interrupt`, `approval.resolve`, `session.stop`, `diff.request` and anything for the other runtime.
- **Retire and resume lazily.** Before the command runs, the idle CLI processes of R are retired without ending their
  sessions. The next turn resumes them on the new binary (Claude: resume of the runtime session; Codex: a new
  `app-server` and `thread/resume`).
- **Members are told.** A held command makes its session emit `runtime.update` `waiting` once ("Updating Claude Code…
  your turn starts when it finishes"), then `done` with the new version, or `failed`.
- **Never cut.** Nothing calls `interrupt` for an update. If R never goes idle, the update waits; after 24 h it is
  reported `stale`. A failed automatic run backs off 6 h, an `unchanged` one 24 h, for the same candidate.

### Levels (D-02, D-10, PD-08)

- Organization policy `runtimeUpdates` in Settings › Work Zone policy: `automatic` (default) · `notify` (check and
  show; install only on "Update now") · `off` (no registry request at all).
- Device level, which can only lower it, through ADR-0012's three paths: the desktop menu (Runtime updates › Automatic
  / Notify only / Off), `ocw-runtime updates automatic|notify|off` (written to `runtime.json`) and
  `OCW_RUNTIME_UPDATES`, which wins over the file.
- Effective level = the lower of the two. **D-10:** until a `runtime.config` arrives (an older API, or offline since
  start) the organization counts as `notify`, so nothing installs without a Control Plane that can audit it.
- Lowering the level drops a pending or draining automatic update and releases its held turns. A run already in
  progress finishes.

### Who sees and who acts (D-06, D-11, PD-05)

- New permission `device.maintain`: the device's owner (relation, when their role has the Work Zone surface) and every
  org admin (role). Relation-only and non-delegable like `device.update`: no allow rule confers it, a deny removes it.
  Decided only by the resolver.
- It decides `POST /api/v1/devices/:id/runtimes/:runtime/update`, `GET /api/v1/devices/:id/runtime-updates` and
  whether `GET /devices` carries `runtimeMaintenance` (install method, `~` location, update command, state, last run).
- Everyone who sees a device gets only the version and `runtimeCompatibility`. The `org:` stream carries only the
  existing id-only `device.updated` ping.
- **No host path leaves the device** (principle 7): `location` is only `~`-relative, display commands are refused if
  they contain an absolute path, and `scrubHostPaths` replaces any remaining absolute path in output with `<path>`.

### Device link, storage and audit (PD-03, PD-04, PD-06)

- Frames: server → device `runtime.config` (level + manifest, ephemeral, sent after `welcome` and on change through a
  Redis control op); device → server `runtime.maintenance` (a snapshot, on change while connected) and
  `runtime.update.run` (`started` / `finished`, through the offline log so no audit record is lost); command
  `runtime.update`. Older daemons ignore `runtime.config`; older APIs never send it (D-10 applies).
- Storage: `devices.runtime_maintenance` (the last snapshot, written only from the device socket) and the history
  table `device_runtime_updates` (RLS, composite FK to the device, one pending "Update now" per device and runtime,
  idempotent by the device's run id; a request older than 1 h expires). One forward-only migration.
- Audit, in the same transaction, never with output or a path: `device.runtime_update_requested`,
  `…_available` (once per runtime and latest version), `…_started`, `…_finished` (`result: "error"` for failed or
  refused), `…_skipped`, `…_stale`, `device.runtime_updates_level_changed`, and `work_zone_policy.updated` with
  `changed: ["runtimeUpdates"]`. The actor is the requester for "Update now", `system` for automatic, the device for a
  local trigger.

### Tests never touch a real install (PD-19)

Every e2e device starts with `OCW_RUNTIME_UPDATES=off`. The daemon maintains only with real adapters, or in fake-CLI
mode (`OCW_RUNTIME_FAKE_CLI=1`) with a `HOME` that is not the OS user's home, or with test runtimes given explicit
maintenance options. In scratch mode any install whose real path is outside the scratch home is refused before
anything runs. Tests use a fake CLI (`maintenance/fake-cli/fake-cli.mjs`) and a loopback registry stub; no test or
agent runs a real `claude update`, `codex update`, global npm install or `brew upgrade`. The Linux proof
(`scripts/runtime-update-proof.sh`) runs the daemon logic as a non-root user in a pinned `node:24` container next to a
root-owned install.

## Consequences

- **Members.** A turn in flight is never cut. A member whose new turn arrives during an update waits, usually under
  5 minutes, at most once per update, and the session says why and then which version it runs on. The other runtime is
  unaffected.
- **Codex approvals after a recycle.** Codex keeps "approve for this session" in the `app-server` process, so after a
  retirement a member may be asked once more. Claude's session approvals live in the adapter and survive.
- **Root-owned installs stay manual.** apt/dnf/apk, a system npm prefix or someone else's Homebrew show "needs admin
  on this machine" with the command. Servers should install the CLIs as the daemon's user (docs/INSTALL.md › Keep
  Claude Code and Codex up to date on devices).
- **Two daemons on one install** (two `OCW_HOME`s under one OS user) share the install lock, so they never run two
  updates at once, but each sees only its own turns. Native and standalone installs keep the version in use, so the
  risk is limited to npm and Homebrew installs.
- **Installers choose their own target.** `claude update`, `codex update` and `brew upgrade` may install something
  other than the checked candidate. The version is verified afterwards; an installed `broken` version is flagged and
  blocks new sessions. npm installs the exact candidate.
- **Codex self-update is not proven off** (D-12 above). Any version move is still detected and reported.
- **Deferred:** pinning a device to a version from the web, rollback to the previous version, OpenCode and other
  runtimes, desktop and daemon self-update, an operator manifest override (e.g. `OCW_RUNTIME_MANIFEST_FILE`) to mark a
  release `broken` without a server release, and running the pnpm/bun/yarn/Volta updates.
- Everything works with `docker compose up` and a self-hosted daemon. The only new outbound call is to the npm
  registry or the configured mirror, and `off` makes none. No new dependency.

### Validation

Unit tests (contracts, resolver on fake trees, registry stub, runner, gate, adapters, orchestrator, daemon, CLI,
desktop), integration tests on real PostgreSQL (policy, history RLS and cross-tenant, start refusal, maintenance
routes, audit), the isolated e2e on both Playwright projects (`runtime-updates.spec`, `runtime-updates-ui.spec` and
every other spec), the headless Linux proof and `pnpm gate:compose`; recorded in `07.11-VALIDATION.md`. **Owner checks
pending:** `docs/DEMO.md` › Runtime CLI updates (Phase 07.11), including a real update on the owner's Mac and on a Linux
server with live shared sessions.
