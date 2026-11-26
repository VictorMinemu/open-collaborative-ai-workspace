// Which updater this platform gets, and how it is set up (07.13.1, D-01, D-02, ADR-0046). The classes are constructed
// here, explicitly, and never through electron-updater's stock getter: that one would pick the Squirrel-based macOS
// updater (which refuses every ad-hoc build and opens a loopback listener) or a package-manager updater that installs
// as root. Windows gets the NSIS updater, Linux the AppImage updater (only inside an AppImage), macOS the ad-hoc updater
// built by the caller (plan 04); everything else gets the release-page notice. Semgrep `ocw.desktop-updater-class`
// guards the rest of apps/desktop. The feed is set in code: the canonical GitHub releases, stable only, no downgrade.
// The loopback test feed exists only for unpackaged builds (the e2e test and development).

import { isAbsolute } from "node:path";
import { AppImageUpdater, type AppUpdater, NsisUpdater } from "electron-updater";
import type { UpdateFallbackReason } from "./app-update";

const OWNER = "VictorMinemu";
const REPO = "open-collaborative-ai-workspace";

export type UpdaterMode =
  | { kind: "github" }
  | { kind: "test"; feedUrl: string; configPath: string; macTestApp: string | null }
  | { kind: "off"; reason: "not_release" | "dev" };

export type MacUpdaterResult =
  | { ok: true; updater: AppUpdater }
  | { ok: false; reason: "dmg" | "translocated" | "unwritable" | "not_bundle" };

export interface PlatformUpdater {
  updater: AppUpdater | null;
  /** Why there is none (the release-page notice is shown instead); null when there is one. */
  fallback: UpdateFallbackReason | null;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Plain http on 127.0.0.1, localhost or [::1], without credentials: the e2e test's own fake release server. */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    !url.username &&
    !url.password
  );
}

/**
 * A packaged build updates only when the release workflow built it (`RELEASE_BUILD`), so a local package or a fork
 * never replaces itself with the upstream release (Pitfall 7); the test variables are ignored when packaged. An
 * unpackaged build updates only against a loopback test feed with an absolute config path.
 */
export function updaterMode(opts: { isPackaged: boolean; releaseBuild: boolean; env: Env }): UpdaterMode {
  if (opts.isPackaged) return opts.releaseBuild ? { kind: "github" } : { kind: "off", reason: "not_release" };
  const feedUrl = opts.env.OCW_DESKTOP_UPDATE_FEED;
  const configPath = opts.env.OCW_DESKTOP_UPDATE_CONFIG;
  if (!feedUrl || !isLoopbackHttpUrl(feedUrl) || !configPath || !isAbsolute(configPath))
    return { kind: "off", reason: "dev" };
  const testApp = opts.env.OCW_DESKTOP_UPDATE_TEST_APP;
  return { kind: "test", feedUrl, configPath, macTestApp: testApp && isAbsolute(testApp) ? testApp : null };
}

function configure(updater: AppUpdater, mode: Exclude<UpdaterMode, { kind: "off" }>): void {
  // No logger: electron-updater logs installer, cache and AppImage paths (Pitfall 8).
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // Set after construction: the constructor turns pre-releases on for a pre-release version.
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  if (mode.kind === "github") {
    updater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO, releaseType: "release" });
    return;
  }
  updater.forceDevUpdateConfig = true;
  updater.updateConfigPath = mode.configPath;
  updater.disableDifferentialDownload = true;
  updater.setFeedURL({ provider: "generic", url: mode.feedUrl });
}

/** The platform's one allowed updater, configured; or none and why. */
export function createPlatformUpdater(opts: {
  platform: NodeJS.Platform;
  env: Env;
  mode: UpdaterMode;
  createMac: () => MacUpdaterResult;
}): PlatformUpdater {
  const { mode } = opts;
  if (mode.kind === "off") return { updater: null, fallback: mode.reason };
  let updater: AppUpdater;
  switch (opts.platform) {
    case "win32":
      updater = new NsisUpdater();
      break;
    case "linux":
      // Outside an AppImage (the .deb) there is no self-install: the notice names the AppImage (D-06).
      if (!opts.env.APPIMAGE) return { updater: null, fallback: "deb" };
      updater = new AppImageUpdater();
      break;
    case "darwin": {
      const mac = opts.createMac();
      if (!mac.ok) return { updater: null, fallback: mac.reason };
      updater = mac.updater;
      break;
    }
    default:
      return { updater: null, fallback: "unsupported" };
  }
  configure(updater, mode);
  return { updater, fallback: null };
}
