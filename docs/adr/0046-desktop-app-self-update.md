# ADR-0046: The desktop app updates itself from the GitHub releases, unsigned, never cutting a turn

## Status

Status: Accepted. **Date:** 2026-11-26. **Deciders:** Víctor Ruiz (Autofy Labs). Requested by the owner on 2026-11-26
("hay que implementar un sistema de auto update para todos los clientes, ya sea windows linux o mac") and decided
under the owner's standing autonomy grant: decisions D-01 … D-12 in
`.planning/phases/07.13.1-desktop-app-auto-update-on-macos-windows-and-linux-the-app-d/07.13.1-CONTEXT.md`, taken from
the research in `07.13.1-RESEARCH.md` in the same folder. The owner's full-autonomy grant makes CONTEXT's locked
decisions the acceptance. First shipped in v0.5.2.

**Completes, without editing them:** the scope clause of [ADR-0032](0032-runtime-cli-updates.md) and the deferred item
of [ADR-0040](0040-runtime-self-update.md) quoted below, for the desktop app. **Supersedes:** 07.13 D-18's "no silent
install". Everything else in those records stays exactly as written.

**Builds on:** [ADR-0005](0005-local-runtime-daemon-process-model.md) (the daemon the desktop app supervises),
ADR-0032 (the levels, the idle gate that never cuts a turn),
[ADR-0034](0034-public-releases-and-bundled-claude-agent-sdk.md) (the public releases, the runtime inside the desktop
app) and ADR-0040 (the all-gates idle step, the version that follows the release, prompts re-queued after a daemon
restart, PD-27).

## Context

Until v0.5.1 the desktop app only said "Update available" with a link (07.13 D-18). Every update meant downloading and
installing the new files by hand on every computer, and the runtime inside the app stayed as old as the app.

The builds are unsigned: macOS gets an ad-hoc signature (no Developer ID, no notarization), Windows none. Developer ID
and Authenticode come with Phase 9. Three facts decide the design:

1. **Squirrel.Mac refuses every ad-hoc update.** Electron's `autoUpdater` and electron-updater's `MacUpdater` both use
   Squirrel.Mac. It checks the new bundle against the running app's designated requirement (`SecCodeCopySelf` →
   `SecCodeCopyDesignatedRequirement`, then `SecStaticCodeCheckValidityWithErrors`). For our build that requirement is
   `codesign -d -r-` → `designated => cdhash H"…"`, the hash of that one build (`Signature=adhoc`,
   `TeamIdentifier=not set`). Every rebuilt app has another cdhash, so every update fails by construction ("Code
   signature at URL … did not pass validation"). `MacUpdater` also opens an HTTP listener on `127.0.0.1` to feed
   Squirrel.
2. **Windows and the AppImage work unsigned.** `NsisUpdater` skips its signature check when `app-update.yml` has no
   `publisherName`, which electron-builder writes only from a certificate. Our NSIS installer is per-user, so no UAC.
   The AppImage updater has no signature step at all. Its installer, however, kills every process under the install
   directory, the daemon and its CLIs included.
3. **The `.deb` updater runs a root shell.** electron-updater's `DebUpdater` runs `pkexec`/`sudo /bin/bash -c 'dpkg -i
   …'`, then `apt-get install -f -y` with `--allow-unauthenticated --allow-downgrades`. That does not fit this
   repository's posture (no sudo, no unauthenticated packages).

Two release problems broke any updater: release.yml renamed the built files, so a manifest would point at names that do
not exist, and without a `publish` configuration electron-builder wrote neither `latest*.yml` nor `app-update.yml`.

## Decision

### 1. One updater per platform, built explicitly (D-01)

electron-updater 6.8.11, exact pin. `createPlatformUpdater` (`apps/desktop/src/main/platform-updater.ts`) constructs:

- Windows: `NsisUpdater`;
- Linux: `AppImageUpdater`, only when `APPIMAGE` is set (inside an AppImage);
- macOS: `AdhocMacUpdater extends BaseUpdater` (`mac-update.ts`, § 5), built by `createAdhocMacUpdater`;
- everything else, and the cases of § 5 and § 6: no updater, the release-page notice instead.

Never the stock `autoUpdater` getter (it picks by package type), `MacUpdater`, Squirrel.Mac, `DebUpdater` or any
listening port. Semgrep `ocw.desktop-updater-class` refuses them anywhere else in `apps/desktop`.

### 2. Source and channel (D-02)

The GitHub provider of `VictorMinemu/open-collaborative-ai-workspace`, set in code on every updater (macOS included),
over HTTPS. Stable releases only (`allowPrerelease = false`), never backwards (`allowDowngrade = false`). The updater is
on only in a release build: `RELEASE_BUILD` (`build-flags.ts`, an esbuild define from `OCW_RELEASE_BUILD=1`) is true
only in a tag build of release.yml, so a local `pnpm package` build or a fork's build never replaces itself with the
canonical release. `updaterMode` honours a test feed (`OCW_DESKTOP_UPDATE_FEED`, loopback `http` without credentials,
and `OCW_DESKTOP_UPDATE_CONFIG`) only when the app is unpackaged, for the e2e test and development; the test mode
never installs.

### 3. Assets and manifests (D-03)

electron-builder names every file with its release name (`OCW-v<version>-macos-arm64.dmg` and `.zip`,
`-windows-x64-setup.exe`, `-linux-x86_64.AppImage`, `-linux-amd64.deb`) and, with a `publish: github` block (still
`--publish never`; `gh` uploads), writes `app-update.yml` and `latest-mac.yml`, `latest.yml`, `latest-linux.yml`.
`win.verifyUpdateCodeSignature: false` until Authenticode. release.yml uploads the files, the mac zip and the blockmaps
unrenamed, and `SHA256SUMS` covers the manifests too. `apps/desktop/scripts/check-update-manifest.mjs` gates every
desktop runner, pull requests included: the version, every `files[].url` a plain `OCW-v<version>-…` name that exists
with its sha512 and size, the install file listed, the blockmap present, `app-update.yml` canonical and without
`publisherName`; on macOS also the zip extracted with `ditto`, `codesign --verify --deep --strict`, the bundle id, the
version and the daemon run from the extracted app.

### 4. Integrity checks (D-04)

electron-updater checks the download's sha512 against the release's `latest*.yml`, again for a cached file and after a
differential download. On macOS the app then extracts the zip with `ditto` and keeps it only if `codesign --verify
--deep --strict` passes, the bundle id is `dev.ocw.desktop`, the version is the one offered, the daemon is inside and
the framework symlinks survived (`MacUpdateError` codes otherwise; nothing staged is left). Release jobs that can write
releases check out with `persist-credentials: false`. No Ed25519 signature now. What this protects and what it does
not is § 11.

### 5. The macOS install (D-05)

`AdhocMacUpdater` downloads the `.zip` entry of `latest-mac.yml` through electron-updater and `prepareDownloaded`
stages it in `.ocw-update-<version>/` beside the installed `OCW.app` (same volume, so the swap is a rename). On quit,
`doInstall` spawns a detached helper (`mac-swap-helper.cjs`: Electron as Node, `ELECTRON_RUN_AS_NODE=1`, argv only, no
shell string). It waits for the app (60 s) and its daemon (30 s) to exit, swaps by two renames and renames back if the
second fails, writes a path-free `update-result.json` (outcome, version, reason) and relaunches with `open`. No
elevation. The next start reads the result once (`readSwapResult`) and removes leftovers (`sweepLeftovers`).

An app running from the disk image, a translocated path or a folder it cannot write gets the release link, plus "Move
OCW to Applications to get automatic updates" (`app.moveToApplicationsFolder()`, the daemon stopped first).

### 6. Linux `.deb` (D-06)

No self-install. A `.deb` install (no `APPIMAGE`) keeps the daily release-page notice, worded "Update available
(v…): download the .deb, or use the AppImage, which updates itself".

### 7. The restart hold (D-07)

Two strict, local-only control commands on the daemon's socket, on ADR-0040's all-gates step (extracted to
`maintenance/all-gates.ts`, shared with the self-update):

- `appUpdateHold { drain }` → `{ held, state, running, blocked? }`. Without drain it holds only an idle daemon; with
  drain (a click) it closes every gate at once and answers when no turn runs. A running 07.11 CLI job or self-update
  answers `blocked: "runtime_update"`, and they in turn wait for the hold.
- `appUpdateRelease` reopens the gates after a cancelled or failed install.
- Bounds: a drain gives up after 30 min (`timed_out`); a hold the app does not follow by a stop reopens by itself after
  2 min (`auto_released`). `status().appUpdate` carries `{ state, running, lastEnd? }`.

The app quits for an update only after `held` (or when no daemon of its own runs: paused, stopped or external). The
install starts only from Electron's `quit` event, after `before-quit` stopped the daemon, so the NSIS installer finds
nothing to kill. A prompt held at a closed gate never started, so PD-27 re-queues it after the restart. Held sessions
see a `runtime.update` line with subject `ocw-runtime`.

### 8. Levels (D-08)

The org ∩ device 07.11 level (`status.runtimeUpdates.effectiveLevel`; unknown counts as notify), read by the
`AppUpdateController`:

- `automatic`: checks daily, downloads in the background, installs on a normal quit, and restarts by itself only when
  `appUpdateHold({ drain: false })` holds and the person has been away 30 min (system idle time);
- `notify`: checks daily and downloads; installs only after "Restart to update";
- `off`: no automatic check. "Check for updates…" works at every level.

### 9. UI and logging (D-09)

Only the tray, the Runtime menu and the onboarding window, never the web app: "Check for updates…", the download
progress, "Restart to update to v…", "Waiting for N sessions to finish…", "Waiting for a runtime update to finish…",
the release link, "Move OCW to Applications to get automatic updates", and once after an update a failed Mac swap or a
renamed AppImage. electron-updater's logger is off. Every line is a fixed sentence (`UPDATE_SENTENCES`) with versions,
percentages and counts only, never an updater error text or a path.

### 10. Version (D-10)

The app's version is the release tag (release.yml's existing `npm pkg set` before packaging); the repository keeps
`0.1.0` as the development value. The bundled runtime follows the release as before (ADR-0040 § 13). The first release
with self-update is installed by hand once.

### 11. Integrity and its limit (ASVS 10.3.1, accepted deviation)

ASVS 10.3.1 asks for updates signed by their publisher. These builds are not, until Phase 9; this is an accepted
deviation, recorded here.

- **Protects against:** a corrupted, truncated or mixed-up download and a stale cache (sha512); on-path tampering
  (HTTPS to `github.com`, the repository pinned in code); a redirected feed (no feed from config or the environment in
  a packaged app); a downgrade or a pre-release (§ 2); a broken mac bundle (`codesign --verify`, id, version); a release
  whose files do not match its manifests (the CI check of § 3); assets replaced after publishing, once the owner turns
  on GitHub immutable releases (published assets can no longer be added, changed or deleted, the tag is locked).
- **Does not protect against** anyone who can write the release before it is published: a leaked token with
  `contents: write`, a compromised step in a release job, or the GitHub account. They can upload a file and a matching
  manifest. On macOS an ad-hoc `codesign --verify` proves the bundle is intact, not who built it. This is the same trust
  as today's manual downloads. An Ed25519 signature over the manifest with its key in the same GitHub secrets would add
  little against these, so it is deferred.

## Completes, without editing

| Clause (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "Our own daemon and desktop app do not update themselves here (Phase 9)." | ADR-0032, Decision, "One update authority, on the device", Scope | **Completed** for the desktop app: it updates itself from the GitHub releases (§ 1 … § 10), unsigned until Phase 9 (§ 11), at the same 07.11 levels and never cutting a turn. ADR-0040 completed it for the headless daemon. | The 07.11 CLI updates and ADR-0040's self-update, unchanged. The desktop daemon's own self-update stays `not_installed`: its runtime ships with the app. |
| "desktop app auto-update (signed builds, MVP 2)" | ADR-0040, Consequences, "Deferred:" | **Completed** now, without signed builds: § 11 records the deviation; signing comes with Phase 9. | Bundle signatures independent of the workspace and Windows services stay deferred. |
| "no silent install" | 07.13 CONTEXT, D-18 | **Superseded:** the app installs updates by itself where it can (Windows, the AppImage, a Mac from a writable folder). | D-18's daily check and "Update available" link, kept as the fallback for the `.deb`, a Mac outside a writable folder and unsupported platforms. `DeviceInfo.appVersion` unchanged. |

## Consequences

- **The first update is by hand.** v0.5.1 and older have no updater, so v0.5.2 is installed by hand once on each
  computer; later releases arrive by themselves at the device's level. The release notes say so.
- **A new Mac identity per build.** The ad-hoc code identity changes with every release, so after an update macOS may
  ask again for Keychain access ("OCW Safe Storage") or privacy permissions, and if the device token cannot be read the
  computer shows "Pair this computer" again (`ConfigStore.token()` degrades to `null`). Manual updates did the same.
- **App Management may ask.** macOS 13 and later can ask before one app changes another app's bundle; the same-team
  exemption does not apply to ad-hoc builds. A refused swap leaves the installed app untouched and says so once.
- **Standard Mac users and the `.deb` get the link.** `/Applications` not writable, the disk image, a translocated app
  and the `.deb` keep "Update available". Apple silicon only, as the builds are.
- **AppImage file names.** A versioned AppImage name gets the new version's name; a shortcut to the old name breaks,
  and the app says so once. Renamed to `OCW.AppImage`, it is replaced in place.
- **Local and fork builds never update.** Only a tag build of release.yml turns the updater on.
- **Immutable releases are the owner's setting** (GitHub repository settings, free); `workflow_dispatch --clobber`
  then works only on drafts.
- **Phase 9 brings Developer ID and Authenticode:** a stable designated requirement the app checks before the swap
  (`anchor apple generic and certificate leaf[subject.OU] = "<TEAM>"`), a stable Keychain and privacy identity, the
  same-team App Management exemption, no "Open Anyway", and `publisherName` checks on Windows.
- **Deferred:** an Ed25519 manifest signature, the `.deb` self-install, update channels (beta, rc).
- AGENTS.md gains a "Desktop app self-update" row citing this record, right after "Runtime self-update".

### Validation

The tests of the phase's plans, offline: the hold, drain, bounds and both-way exclusion on real `RuntimeGate`s
(`all-gates.test.ts`, `app-restart-hold.test.ts`, the daemon's "07.13.1 app update hold" cases) with the self-update
suite unchanged; the manifest check on fixture folders (`update-manifest.test.ts`) and the release flag
(`build-flags.test.ts`); the controller's levels, schedule, hold-before-quit and views with fakes (`app-update.test.ts`)
and the platform factory (`platform-updater.test.ts`) with the Semgrep rule's fixture; the mac stage, refusals and
swap helper on temp folders, with real `ditto`, `codesign` and `plutil` on a dummy ad-hoc bundle on macOS
(`mac-update.test.ts`, `mac-swap.test.ts`); the wiring (`update-check.test.ts`, `config-store.test.ts`); the update
e2e through the real electron-updater against a loopback fake release on the macOS, Windows and Linux runners of
release.yml (`update.e2e.ts`, CI only), with a corrupted file refused; the manifest check on every real package. No
test calls GitHub or the npm registry, uses the real `~/.ocw` or installs anything. A real update from one published
release to the next on a Mac, Windows and Ubuntu is the owner's UAT (`07.13.1-VALIDATION.md`).
