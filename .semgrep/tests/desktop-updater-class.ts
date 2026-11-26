// Semgrep fixtures for `ocw.desktop-updater-class` (.semgrep/rules.yml, 07.13.1-03; `node scripts/guard/run.mjs
// --rule-tests`). Never compiled, linted or scanned by the main guard run: each `ruleid:` line must match on the next
// line, each `ok:` line must not. The desktop app constructs its updater per platform (D-01): never electron-updater's
// stock getter, its Squirrel-based macOS updater or its package-manager Linux updaters, and never Electron's own.

// ruleid: ocw.desktop-updater-class
import { autoUpdater } from "electron-updater";
// ruleid: ocw.desktop-updater-class
import { MacUpdater } from "electron-updater";
// ruleid: ocw.desktop-updater-class
import { DebUpdater, NsisUpdater as Nsis } from "electron-updater";
// ruleid: ocw.desktop-updater-class
import { RpmUpdater as Rpm } from "electron-updater";
// ruleid: ocw.desktop-updater-class
import { PacmanUpdater } from "electron-updater";
// ruleid: ocw.desktop-updater-class
import { autoUpdater as squirrel } from "electron";
// ruleid: ocw.desktop-updater-class
import { app, autoUpdater as nativeUpdater } from "electron";
import * as updaters from "electron-updater";
import electron from "electron";
import * as electronNs from "electron";
// ok: ocw.desktop-updater-class
import { AppImageUpdater, BaseUpdater, NsisUpdater, type AppUpdater } from "electron-updater";
// ok: ocw.desktop-updater-class
import { app as electronApp, powerMonitor } from "electron";

// ruleid: ocw.desktop-updater-class
const viaRequire = require("electron-updater").autoUpdater;
// ruleid: ocw.desktop-updater-class
const { MacUpdater: Mac } = require("electron-updater");
// ruleid: ocw.desktop-updater-class
const nativeViaRequire = require("electron").autoUpdater;
// ruleid: ocw.desktop-updater-class
const lazy = (await import("electron-updater")).autoUpdater;

function namespaces() {
  // ruleid: ocw.desktop-updater-class
  updaters.autoUpdater.checkForUpdates();
  // ruleid: ocw.desktop-updater-class
  new updaters.DebUpdater();
  // ruleid: ocw.desktop-updater-class
  electron.autoUpdater.quitAndInstall();
  // ruleid: ocw.desktop-updater-class
  electronNs.autoUpdater.checkForUpdates();
  // ok: ocw.desktop-updater-class
  new updaters.NsisUpdater();
  // ok: ocw.desktop-updater-class
  new updaters.AppImageUpdater();
  // ok: ocw.desktop-updater-class
  electron.app.quit();
}

function allowed(u: AppUpdater) {
  // ok: ocw.desktop-updater-class
  const nsis = new NsisUpdater();
  // ok: ocw.desktop-updater-class
  const appImage = new AppImageUpdater();
  // ok: ocw.desktop-updater-class
  u.quitAndInstall(true, true);
  // ok: ocw.desktop-updater-class
  powerMonitor.getSystemIdleTime();
  void [nsis, appImage, electronApp, BaseUpdater];
}

// Semgrep resolves an imported name to its module, so using a forbidden import is a finding too.
// ruleid: ocw.desktop-updater-class
void [autoUpdater, MacUpdater, DebUpdater, Nsis, Rpm, PacmanUpdater, squirrel, app, nativeUpdater];
void [viaRequire, Mac, nativeViaRequire, lazy, namespaces, allowed];
