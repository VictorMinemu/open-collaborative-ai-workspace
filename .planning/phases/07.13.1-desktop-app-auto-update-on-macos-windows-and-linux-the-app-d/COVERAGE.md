# Coverage — Phase 07.13.1 Desktop app auto-update

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Every locked decision, requirement and research
> item maps to at least one plan; nothing is unplanned.

## Locked decisions (07.13.1-CONTEXT.md)

| Decision | Plans | Where |
|---|---|---|
| D-01 Updaters (electron-updater 6.8.11 exact, `lodash.isequal` accepted; NSIS, AppImage, `AdhocMacUpdater`; never the getter, Squirrel, the `.deb` updater or a port) | 02, 03, 04 | 02 T1 pin + T-07.13.1-SC; 03 T3 `createPlatformUpdater` + Semgrep `ocw.desktop-updater-class`; 04 T3 `AdhocMacUpdater extends BaseUpdater` |
| D-02 Source (GitHub provider in code, HTTPS, stable, no downgrade; release builds only; test feed only unpackaged) | 02, 03, 05 | 02 T3 `RELEASE_BUILD`; 03 T3 `updaterMode`, `setFeedURL`, flags; 05 T1 wiring |
| D-03 Assets (release names from electron-builder, `app-update.yml` + `latest*.yml`, upload unrenamed with zip and blockmaps, SHA256SUMS, manifest check on every runner) | 02 | T1 builder config + check script; T2 release.yml |
| D-04 Integrity (sha512; Mac `ditto` + `codesign --verify --deep --strict` + id + version; `persist-credentials: false`; no Ed25519; ASVS 10.3.1 deviation; immutable releases as owner action) | 02, 04, 07, 08 | 02 T1 CI seal check, T2 credentials + SHA256SUMS; 04 T1 on-device checks; 07 T2 corrupted download refused; 08 T1 ADR § 11, T2 notes |
| D-05 macOS install (stage beside, detached helper, two renames + rollback, path-free result, `open`; no elevation; dmg / translocated / unwritable → link + "Move OCW to Applications") | 03, 04, 05, 06 | 04 T1-T3; 03 T2 fallback views; 05 T1 move action, T2 result notice + sweep; 06 move button |
| D-06 Linux `.deb` (no auto-install; notice names the AppImage) | 03, 05 | 03 T2 wording; 05 T1 fallback path |
| D-07 Idle gate (`appUpdateHold { drain }` / `appUpdateRelease`, shared all-gates step, CLI job and self-update blockers, 30 min, 2-min auto-release, quit only after `held`, PD-27 re-queue) | 01, 03, 05 | 01 T1-T3; 03 T1 hold before quit, install only in `onQuit`, T2 waiting / bounds; 05 T1 quit hook |
| D-08 Levels (org ∩ device, unknown = notify; automatic: background download, install on quit, unattended when idle and away ≥ 30 min; notify: download then click; off: no automatic check; click at every level) | 03, 05 | 03 T2; 05 T1 feeds `effectiveLevel` |
| D-09 UI (tray, Runtime menu, onboarding only; check, progress, restart, waiting, fallback link; logger off; fixed sentences; no path) | 03, 05, 06 | 03 T2 views + `logger = null`; 05 T1 menus; 06 T1-T2 onboarding |
| D-10 Version (app version = tag via release.yml; repository keeps 0.1.0; first updating release installed by hand) | 02, 08 | 02 T1-T2 manifest version = tag; 08 T2 notes + README, T3 runtime 0.5.1 |
| D-11 ADR (ADR-0046 per outline, completes ADR-0032 / 0040 without editing; one AGENTS.md row) | 08 | T1 |
| D-12 Tests (offline only: fake release server, unit tests for controller / Mac updater / helper, daemon hold tests, CI manifest check; real releases = owner UAT) | 01, 02, 03, 04, 07 | every task's verify; 07 e2e in CI; VALIDATION.md manual-only table |

Deferred (CONTEXT): Developer ID / Authenticode signing, Ed25519 manifest signature, `.deb` self-install, update
channels — not planned (ADR-0046 lists them as deferred).

## Requirements (REQUIREMENTS.md › DAU)

| Requirement | Plans |
|---|---|
| DAU-01 | 02, 03, 04, 05 |
| DAU-02 | 02 |
| DAU-03 | 02, 04, 07, 08 |
| DAU-04 | 04, 05, 06 |
| DAU-05 | 03, 05 |
| DAU-06 | 01, 03 |
| DAU-07 | 03, 05 |
| DAU-08 | 03, 05, 06 |
| DAU-09 | 01, 02, 03, 04, 07, 08 |

## Research items (07.13.1-RESEARCH.md)

| Item | Plans | Note |
|---|---|---|
| Phase goal (ROADMAP 07.13.1) | 01-08 | |
| Pitfall 1 Squirrel + ad-hoc designated requirement | 03, 04 | Semgrep rule, factory test, own Mac updater |
| Pitfall 2 renamed assets, missing manifests | 02 | |
| Pitfall 3 NSIS kills the daemon and its CLIs | 03, 05 | install only from `quit` after `shutdown()` and `held` |
| Pitfall 4 Mac zip loses framework symlinks | 02, 04 | CI and on-device `ditto` + `codesign`; dummy app symlink case |
| Pitfall 5 Mac identity changes per build | 08 | documented (ADR, notes); unavoidable without a Developer ID |
| Pitfall 6 AppImage versioned file name | 03, 05, 08 | one-time notice, `OCW.AppImage` tip |
| Pitfall 7 local or fork builds replaced by upstream | 02, 03 | `RELEASE_BUILD`, `updaterMode` |
| Pitfall 8 paths in logs | 03, 04, 05 | `logger = null`, fixed sentences, path-free result |
| Pitfall 9 first update is manual | 08 | |
| `status.appUpdate` block | 01 | |
| `win.verifyUpdateCodeSignature: false` + no `publisherName` check | 02 | |
| Differential download (keep `.exe.blockmap`) | 02 | uploaded; the e2e disables differential for determinism only |
| Open Question 1 unattended restart | 03 | locked by D-08 |
| Open Question 2 server visibility of updates | — | research recommendation "none this phase": the device's `appVersion` after reconnect is enough |
| Open Question 3 newer app, older server | — | research recommendation: no cap; the org level `off` is the admin's brake |
| Optional `check-runtime-version` extension for apps/desktop | 02 | covered by the manifest check's version = tag assertion |
| Package legitimacy (`lodash.isequal` SUS, deprecated only) | 02 | accepted per D-01 (owner's autonomy grant), no checkpoint; recorded in T-07.13.1-SC |
| Risks R1-R7, assumptions A1-A7 | VALIDATION.md | owner UAT rows |

## External surfaces

### electron-updater 6.8.11

| capability | decision | reason |
|---|---|---|
| `NsisUpdater` (Windows, per-user, `--updated /S [--force-run]`) | INTEGRATE | |
| `AppImageUpdater` (Linux with `APPIMAGE`) | INTEGRATE | |
| `BaseUpdater` subclass (`doDownloadUpdate`, `executeDownload`, `doInstall`) | INTEGRATE | the macOS updater |
| GitHub provider (`setFeedURL`, atom feed, `releases/latest`, release downloads) | INTEGRATE | |
| Generic provider on loopback | INTEGRATE | unpackaged test mode only (e2e) |
| sha512 verification and the download cache | INTEGRATE | |
| `download-progress`, `update-downloaded`, `error` events | INTEGRATE | |
| `quitAndInstall` | INTEGRATE | only from the app's `quit` event |
| `allowPrerelease`, `allowDowngrade`, `autoDownload`, `autoInstallOnAppQuit`, `logger` | INTEGRATE | all set explicitly |
| `forceDevUpdateConfig`, `updateConfigPath`, `disableDifferentialDownload` | INTEGRATE | test mode only |
| differential download (blockmaps) | INTEGRATE | kept on in production |
| `appimage-filename-updated` event | OPT-OUT | fires during the quit; the next start compares file names instead (plan 05) |
| the lazy default `autoUpdater` instance | OPT-OUT | picks the Squirrel and package-manager updaters (D-01) |
| `MacUpdater` (Squirrel.Mac) | OPT-OUT | fails on ad-hoc builds and opens a loopback listener (D-01, Pitfall 1) |
| `DebUpdater`, `RpmUpdater`, `PacmanUpdater` | OPT-OUT | root shell through pkexec / sudo (D-01, D-06) |
| private GitHub repositories / tokens | OPT-OUT | not needed: public releases, no credentials |
| `channel` / update channels | OPT-OUT | explicitly out of scope (CONTEXT Deferred) |
| `fullChangelog`, release notes in the app | OPT-OUT | not needed: the release page has them |

### electron-builder 26.16.1

| capability | decision | reason |
|---|---|---|
| `publish: github` with `--publish never` (writes `app-update.yml`, `latest*.yml`) | INTEGRATE | |
| Mac `zip` target (beside `dir`, `dmg`) | INTEGRATE | |
| per-target `artifactName` (release names) | INTEGRATE | |
| `win.verifyUpdateCodeSignature: false` | INTEGRATE | until Authenticode (Phase 9) |
| uploading through electron-builder's publisher | OPT-OUT | not needed: `gh release upload` keeps the draft-then-publish flow |

### Electron 44 and macOS tools

| capability | decision | reason |
|---|---|---|
| `app.moveToApplicationsFolder()` | INTEGRATE | |
| `powerMonitor.getSystemIdleTime()` | INTEGRATE | |
| `app` `quit` event | INTEGRATE | |
| Electron's built-in `autoUpdater` | OPT-OUT | Squirrel on macOS and Windows, none on Linux |
| `/usr/bin/ditto`, `codesign`, `plutil`, `xattr`, `open` | INTEGRATE | argv only, never a shell |
| `hdiutil attach` of the dmg | OPT-OUT | not needed: the zip carries the update (research Alternatives) |

### GitHub

| capability | decision | reason |
|---|---|---|
| public releases (atom feed, `releases/latest`, asset downloads) | INTEGRATE | |
| `releases/latest` API (07.13 notice) | INTEGRATE | kept as the fallback notice |
| immutable releases | INTEGRATE | owner's repository setting (release notes) |
| release attestations verification on the device | OPT-OUT | not needed now; Phase 9 signing gives a publisher check (ADR-0046) |
