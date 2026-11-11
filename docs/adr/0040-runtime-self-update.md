# ADR-0040: A headless server's runtime updates itself from its workspace, with one click or by itself, never cutting a turn

## Status

Status: Accepted. **Date:** 2026-11-11. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.17.1-02), before any behaviour lands, from the owner's request of 2026-11-11 and decisions D-01 … D-12
in `.planning/phases/07.17.1-runtime-self-update-from-the-browser-one-click-in-settings-d/07.17.1-CONTEXT.md` (D-09 …
D-12 were decided after the research under the owner's autonomy grant, on the research's recommendations), the planner
decisions PD-04 … PD-22 and PD-27 in `07.17.1-01-PLAN.md`, the flagged assumption A-08 (approved by the orchestrator on
2026-11-11) and the research in `07.17.1-RESEARCH.md`. The owner's full-autonomy grant makes CONTEXT's locked decisions
the acceptance.

**Supersedes, without editing it:** the deferred item of [ADR-0033](0033-headless-work-zone-server.md) quoted below.
**Completes, without editing it:** the scope clause of [ADR-0032](0032-runtime-cli-updates.md) quoted below, for the
headless daemon only. Everything else in both records stays exactly as written.

**Builds on:** ADR-0032 (the on-device update authority, the idle gate, the levels, `device.maintain`, the run history
and its audit), ADR-0033 (distribution from the workspace, the install layout, the systemd and launchd units, the
doctor) and [ADR-0012](0012-full-access-mode-and-shared-devices.md) (the device level can only lower the organization's).

## Context

On 2026-11-11, testing v0.3.0 on ocw.autofy.ing, the owner updated a headless Work Zone server's runtime by SSH:
re-run the install command, then `ocw-runtime service restart`. Verbatim: "haz un sistema de auto update para poder
actualizar el runtime desde el navegador cuando se trate de servidores" and "desde devices que lo pueda actualizar con
un click". It ships before v0.3.1.

Every piece exists, in three places that were never joined:

1. **The 07.11 maintenance pipeline** (ADR-0032): "Update now" → the `runtime.update` command → the device's idle gate →
   `runtime.update.run` frames → `device_runtime_updates` → audit → the Settings row. It updates only Claude Code and
   Codex.
2. **The 07.12 install layout** (ADR-0033): `install.sh` writes `versions/<sha12>/` with the bundle, its `package.json`
   and `npm-shrinkwrap.json`, runs `npm ci` there, links `current` and writes `install.json`; it keeps the previous
   version.
3. **The 07.12 service units** (ADR-0033): systemd `Restart=on-failure`, launchd `KeepAlive` with `SuccessfulExit`
   false, both running the bundle through the `current` link.

One gap was not a missing piece but a missing fact: `apps/local-runtime/package.json` said `0.1.0` through v0.2.0,
v0.2.1 and v0.3.0, so the runtime's version never told two builds apart. Only the bundle's sha256 did, which is what
`ocw-runtime doctor` already compared.

## Decision

### 1. Scope: service devices only (D-01, PD-24)

- A device whose `hostKind` is `service` gets a **Runtime** row first in the existing 07.11 "Runtime updates" section
  of Settings › Devices, next to Claude Code and Codex: the installed version and build, the served version and build,
  and **Update** when they differ.
- A desktop device shows its runtime version and "Updates with the desktop app". The desktop app ships its own runtime;
  app releases stay that path.
- Out of scope: the desktop app's own update, bundle signatures, Windows services, `ocw upgrade`, automatic rollback,
  Docker or custom supervisors.

### 2. Vocabulary: one maintenance target, the session id unchanged (PD-04)

- `RuntimeId` (`claude-code | codex`, the session runtime id) never grows. A maintenance-only `RuntimeUpdateTarget`
  (`claude-code | codex | ocw-runtime`) widens only the command payload, the run frame, the history DTO, the route
  parameters and the history query.
- The device's own status travels in an optional, strict `self` of the existing `runtime.maintenance` snapshot, never in
  its strict `runtimes[]`.
- Reused unchanged: the `runtime.update` command kind, the hub's ack routing, the adoption of the `requested` row, the
  partial unique index, the 1 h expiry, the history route and the audit actions. `DEVICE_LINK_PROTOCOL_VERSION` stays 1.
  Every 07.17.1 field is optional, so an older daemon, API or web keeps working.

### 3. Build identity, and following the served build (D-10, D-11, PD-05)

- A build is the bundle's sha256; people and the API see its first 12 hex digits. The UI shows "0.3.1 · <build>".
- "Update available" means the served build differs from the running build: equality only, never an ordering. A device
  at `automatic` therefore follows whatever build its workspace serves, also an older one after a server rollback
  (D-11). The served build is the source of truth.
- The running build is hashed once at boot from the real path of the running bundle, never from what `current` points
  to (they differ between the switch and the restart).

### 4. Where the bytes come from (D-03, D-08, PD-06)

- Only the device's configured server URL (`config.serverUrl`): never `install.json`'s, never a URL, host, path,
  command or version from the request. The command's payload is exactly `{ runtime: "ocw-runtime" }`.
- The installer's transport rule: https, or plain http only to a loopback host or with `OCW_INSTALL_ALLOW_HTTP=1` in the
  daemon's environment (documented through `~/.ocw/service.env`). Redirects are refused; every request has a timeout.
- The manifest from `/api/v1/runtime/version` is parsed strictly and is the authority; response headers are only a
  cross-check.

### 5. Prepare, with the gates open (D-03, PD-07, PD-16, A-08)

Running sessions keep running while the device prepares. In order:

- Node at least the manifest's `minNode`; free space above a floor (512 MiB, A-05) on `<OCW_HOME>/runtime`.
- A complete `versions/<sha12>` whose bundle already hashes to the manifest is reused: no download, no npm.
- Otherwise a staging directory under `versions/`: the bundle is streamed with a byte cap at the manifest's size while
  it is hashed; the lockfile comes from one new read-only route, `/api/v1/runtime/npm-shrinkwrap.json` (public, the
  same rate limit, 404 / 503 like the others), and must hash to the manifest's `externalLockSha256` and pin the
  manifest's external packages; `package.json` and `npm-shrinkwrap.json` are written exactly as `install.sh` writes
  them (whose output stays byte-identical).
- `npm ci --prefix <staging> --no-audit --no-fund --omit=optional --ignore-scripts` as a fixed argument list in the
  07.11 command-table style, with npm found next to the node that runs the service, a filtered environment (no `OCW_*`,
  no credential names) and a timeout.
- **Preflight (A-08):** `<node> <staging>/ocw-runtime.mjs version` must print the manifest's version. D-03 says
  nothing from the download runs "except the bundle itself"; the preflight is the verified bundle itself, as
  `install.sh` already runs it. Nothing else from the download ever runs: no script, no postinstall.
- The staging directory is renamed to `versions/<sha12>`. Any failure removes it and leaves `current` and `install.json`
  untouched. Files 0600, directories 0700, as `install.sh`.

### 6. Switch, inside the gate (D-03, D-05, PD-08)

- A restart marker is written first (§ 10). Then `current` is replaced atomically: a relative link `current.tmp-<pid>`
  renamed over it, never unlink-then-link. Then `install.json` (temporary file and rename, 0600).
- The daemon stops cleanly and exits with **code 75** (`EX_TEMPFAIL`), so systemd (`Restart=on-failure`) and launchd
  (`KeepAlive`, `SuccessfulExit` false) start it again on the new version (A-03).
- The previous `versions/<sha12>` stays: rollback is pointing `current` back. No `sudo`, no `systemctl` or `launchctl`
  call, no write outside `<OCW_HOME>/runtime` and the 07.11 lock directory, same user and `OCW_HOME` as the install.

### 7. One gate decision for every runtime (D-04, PD-09)

- A restart ends every runtime's processes, so the switch needs every runtime idle at once: every gate with nothing
  admitted, every adapter with no turn in flight and no 07.11 job past `pending`, checked and closed in one synchronous
  step across all gates.
- A click drains at once: running turns finish, new turns wait ("Waiting for sessions to finish"). An automatic run is
  opportunistic first, then drains, as ADR-0032. Nothing ever interrupts a turn.
- The self-update and the 07.11 CLI updates exclude each other: while the self-update holds the gates no CLI job
  starts, and it waits for a CLI job that is running. A lock on `<OCW_HOME>/runtime` stops two daemons sharing one
  `OCW_HOME` from updating at once. Any failure after closing reopens every gate.

### 8. Levels: automatic, notify, off, and a click at any level (D-06, D-09, PD-10)

- The device's effective 07.11 level (organization ∩ device; the organization counts as `notify` until a
  `runtime.config` arrives) applies to the runtime too.
- `automatic`: the device asks its own server on connect and on the 07.11 cadence, and updates when the served build
  differs. `notify`: it checks and shows **Update**, never runs by itself. `off`: no automatic check at all.
- **A click updates at any level, `off` included (D-09).** This departs from ADR-0032, where `off` refuses "Update now",
  for this target only: `off` means "do not check by yourself", and the person who clicks is the decision. Claude Code
  and Codex keep ADR-0032's behaviour unchanged.
- A failed automatic run of a build is not retried for that build before a back-off; a click always may.

### 9. What counts as a service run (D-05, D-12, PD-11)

- One-click and automatic updates need a real service run: `OCW_RUNTIME_HOST=service`, the service manager's own marker
  (`INVOCATION_ID` on Linux, `XPC_SERVICE_NAME` equal to our launchd label on macOS, A-01), a running bundle under
  `<OCW_HOME>/runtime/versions/` and a readable `install.json`.
- A foreground `ocw-runtime run`, or any other platform, refuses with "Run as a service to update from the browser; or
  re-run the install command" (`not_supervised`). A missing `install.json` or a bundle outside `versions/` (a checkout,
  the desktop app) is `not_installed`, and the device makes no request at all.

### 10. The run survives the restart (D-07, PD-12)

- The Device Link's offline log is in memory, so the marker in `<OCW_HOME>/runtime` carries the run across the exit:
  its run and command ids, the versions and builds it went from and to.
- At boot the new daemon compares its running build with the marker's target: equal → `started` and `finished
  succeeded`; different → `finished failed` ("came back on the previous version"). Both frames go out first in the
  handshake. A stale `install.json` is rewritten from the running build.
- After a success the daemon prunes `versions/`, keeping the running build and the one it came from, and removes
  leftover staging directories. A redelivered command with the marker's command id is acknowledged without a second
  run.

### 11. The API decides, records and audits (D-01, D-02, D-09, PD-13, PD-14, PD-15)

- `POST /api/v1/devices/:id/runtimes/ocw-runtime/update` is decided by `device.maintain` (the device owner; admins on
  service devices, as ADR-0032), re-decided on every request; unknown, revoked or another organization's device is 404.
- Preconditions, in order, each a 409 with a fixed sentence: offline, not a service, no `self` in the stored snapshot
  (`self_update_unsupported`, an older daemon), the device's own reason (`not_supervised`, `not_installed`,
  `node_too_old`), nothing served (`runtime_not_served`), the same build (`already_current`), a run already pending
  (`update_pending`). The organization level is **not** checked for this target (D-09).
- The served build comes from one reader per API process, shared by the distribution routes, the device list and this
  route.
- Runs reuse `device_runtime_updates` (one forward-only migration widens its runtime CHECK and adds two nullable
  12-hex build columns) and the 07.11 audit actions `device.runtime_update_*`, whose metadata adds the builds. Never a
  path, output or error text.
- A run left `started` past a time limit is closed as failed ("interrupted") when its device is offline or reports
  idle; a device that reports waiting keeps it open.

### 12. Failure, and the doctor (D-07, PD-20)

- A failure before the switch leaves the current version running, and the run reads failed with a short reason
  (checksum, disk, lockfile, npm, preflight, …).
- A build that fails to come back is the service manager's restart loop. The doctor names the marker that never came
  back ("The runtime did not come back after updating to {version} ({build})") with the manual fix: re-run the install
  command from Settings › Devices, or point `current` back to the previous version and run `ocw-runtime service
  restart`. No new doctor check id.
- The API keeps accepting the previous runtime protocol, as today.

### 13. The runtime's version follows the release (D-10, PD-21)

- From v0.3.1, `apps/local-runtime/package.json` carries the release version, so a built bundle's manifest says it.
- The release workflow's `prepare` job runs `scripts/check-runtime-version.mjs` with the tag and fails a tag whose
  version, without a pre-release suffix, differs from the runtime's. D-10 is a standing rule, so it is a check, not a
  reminder. The build's identity for comparison stays the sha256 (§ 3).

### 14. A prompt that never started survives a restart (D-04, PD-18, PD-27)

- A prompt held at a closed gate, or dispatched but not yet running, has never started on the device. When a daemon
  comes back without that session, the API puts the prompt back at the head of its queue, closes its stale command
  through the device module's public interface so it is never delivered twice, and the session restarts and runs it.
  Until now it failed "The device restarted".
- A prompt that was running still fails "The device restarted" (07.11 and 07.12 behaviour unchanged).
- While held, its session shows "Restarting the OCW runtime on this device… your turn starts when it is back" once.
- This applies to every daemon restart, not only self-updates.

## Supersedes and completes

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "self-update of the runtime (re-running the install command upgrades it today)" | ADR-0033, Consequences, "Deferred:" | **Superseded:** decided here. A service device's runtime updates itself to the build its workspace serves, with one click or by itself (§ 1 … § 13). Re-running the install command still works and stays the manual fix (§ 12). | The other deferred items (a Windows service, Ed25519 device identity, cloning from the CLI, sharing from the CLI, a container image for the runtime). |
| "Our own daemon and desktop app do not update themselves here (Phase 9)." | ADR-0032, Decision, "One update authority, on the device", Scope | **Completed** for the headless daemon: it now updates itself, through the same authority, gate, levels (with § 8's departure at `off`), permission, history and audit. | The desktop app still does not update itself (Phase 9 / MVP 2); its runtime ships with the app. |

**Restated unchanged.** ADR-0033's install layout (`versions/<sha12>/`, `current`, `install.json`, `npm ci` with the
locked tree, the previous version kept, the units through `current`) is the layout the daemon now writes itself; the
install script, its routes and its output are unchanged. ADR-0032's gate (never cut a turn, opportunistic then drain,
members told while held), its levels and `device.maintain` are unchanged for Claude Code and Codex.

## Consequences

- **The first update is still the install command.** A v0.3.0 runtime lacks this code, so moving Server-1 from v0.3.0
  to this build is the install command and one `ocw-runtime service restart`; every later update is one click. The
  release notes say so.
- **Old daemons are refused, not broken.** A service device without `self` answers `self_update_unsupported`, and its
  row shows the install command once.
- **A crash-looping build** is the service manager's restart loop. There is no automatic rollback; the doctor names it
  and documents the fix (§ 12).
- **PD-27 applies to every daemon restart.** A prompt that never started is retried instead of failed. A turn that
  started but whose running event was lost in a crash window may run again; accepted.
- **Trust is the paired workspace.** The device installs whatever build the workspace it is paired with serves, the
  same trust as the first install; the sha256 checks guard the transfer, not the source. Bundle signatures are deferred.
- **Every daemon restart now has two triggers**: a person's `service restart` and an update. Both go through the
  service manager; neither cuts a turn on the update path.
- **Deferred:** desktop app auto-update (signed builds, MVP 2); bundle signatures independent of the workspace;
  Windows services.
- AGENTS.md gains a "Runtime self-update" row citing this record, right after "Runtime adapters".

### Validation

The tests of the phase's plans: contracts (target, snapshot `self`, frames, sentences), the release version check,
the lockfile route and `install.sh` byte parity, the migration on real PostgreSQL with organization B, the prepare and
switch on a scratch `OCW_HOME` against a loopback distribution stub with a fake npm (checksum, cap, redirect, transport,
lockfile, preflight, node, disk, reuse, atomicity), supervision and restart reconciliation, the all-gates idle decision
and levels, the API route's permission, preconditions, audit and abandoned runs, the held prompt across a restart, the
web row at 1440 and 390 px in both themes, and the isolated e2e on CI. No test touches `~/.ocw`, the real npm registry,
a real service manager or calls `process.exit`. The real systemd restart is proven only by the owner's UAT on Server-1
(`07.17.1-VALIDATION.md`).
