// The desktop app's own update, end to end and offline (07.13.1, D-12; run with `pnpm --filter @ocw/desktop
// test:update`, in CI only: release.yml on macOS arm64, Windows x64 and Linux x64). The unpackaged app gets the
// updater's test mode (`OCW_DESKTOP_UPDATE_FEED` + `OCW_DESKTOP_UPDATE_CONFIG`, honoured only unpackaged and only on
// loopback) and downloads from a fake release served by this process on 127.0.0.1 (never GitHub), through the
// platform's real electron-updater path: NSIS on Windows, the AppImage updater with `APPIMAGE` set on Linux, the ad-hoc
// Mac updater with a signed dummy `OCW.app` (`OCW_DESKTOP_UPDATE_TEST_APP`) on macOS. The test mode never installs.
// `OCW_HOME` and the user data are temp folders, the daemon runs the fake runtimes, and the updater cache folder (a
// random name from the test's app-update.yml) is removed afterwards.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { UPDATE_SENTENCES } from "../src/main/app-update";
import { RESULT_FILE, stagingDirName } from "../src/main/mac-swap";
import { type FakeRelease, startFakeRelease } from "./support/fake-release";
import { buildDummyMacApp, zipDummyMacApp } from "./support/mac-dummy-app";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const VERSION = "9.9.9";
const RESTART = `Restart to update to v${VERSION}`;
const CHECK = "Check for updates…";
const platform = process.platform;

interface Journey {
  app: ElectronApplication;
  release: FakeRelease;
  userData: string;
  /** macOS: the dummy `OCW.app` 0.1.0 standing in for the installed app. */
  macTestApp: string | null;
  /** Linux: the `APPIMAGE` file and its bytes before the run. */
  appImage: { path: string; bytes: Buffer } | null;
}

const folders: string[] = [];
const journeys: Journey[] = [];

function tempDir(prefix: string, base = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  folders.push(dir);
  return dir;
}

/** Where electron-updater keeps its download cache (its `getAppCacheDir`), for the same environment. */
function updaterCacheBase(): string {
  if (platform === "win32") return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  if (platform === "darwin") return join(homedir(), "Library", "Caches");
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/** CFBundleShortVersionString straight from the bundle's Info.plist. */
function bundleVersion(app: string): string | null {
  const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
}

/** The payload the platform's updater downloads, and what stands in for the installed app. */
async function platformPayload(work: string): Promise<{
  payload: Buffer;
  macTestApp: string | null;
  appImage: Journey["appImage"];
}> {
  if (platform === "darwin") {
    const fresh = join(work, "new");
    mkdirSync(fresh);
    const zip = join(work, `OCW-v${VERSION}-macos-arm64.zip`);
    await zipDummyMacApp(await buildDummyMacApp({ dir: fresh, version: VERSION }), zip);
    const applications = join(work, "Applications");
    mkdirSync(applications);
    const installed = await buildDummyMacApp({ dir: applications, version: "0.1.0" });
    return { payload: readFileSync(zip), macTestApp: installed, appImage: null };
  }
  if (platform === "linux") {
    const path = join(work, "OCW-v0.1.0-linux-x86_64.AppImage");
    const bytes = randomBytes(64 * 1024);
    writeFileSync(path, bytes, { mode: 0o755 });
    return { payload: randomBytes(64 * 1024), macTestApp: null, appImage: { path, bytes } };
  }
  return { payload: randomBytes(64 * 1024), macTestApp: null, appImage: null };
}

/** The app, unpackaged, against a fresh fake release (`corrupt`: the served bytes miss the manifest's sha512). */
async function launch(opts: { corrupt: boolean }): Promise<Journey> {
  const work = tempDir("ocw-update-e2e-");
  const userData = join(work, "user-data");
  mkdirSync(userData);
  // Short path on macOS and Linux: Unix socket paths are limited to ~104 bytes. Windows uses a fixed pipe name.
  const ocwHome = platform === "win32" ? tempDir("ocwe-") : tempDir("ocwe-", "/tmp");
  const { payload, macTestApp, appImage } = await platformPayload(work);
  const release = await startFakeRelease({ version: VERSION, platform, payload, corrupt: opts.corrupt });

  const cacheDirName = `ocw-e2e-${randomBytes(6).toString("hex")}`;
  folders.push(join(updaterCacheBase(), cacheDirName));
  const config = join(work, "app-update.yml");
  writeFileSync(config, `provider: generic\nurl: ${release.url}\nupdaterCacheDirName: ${cacheDirName}\n`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("ELECTRON_") && !k.startsWith("OCW_") && k !== "APPIMAGE")
      env[k] = v;
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: {
      ...env,
      OCW_DESKTOP_USER_DATA: userData,
      OCW_HOME: ocwHome,
      OCW_RUNTIME_FAKE: "1",
      OCW_DESKTOP_UPDATE_FEED: release.url,
      OCW_DESKTOP_UPDATE_CONFIG: config,
      ...(macTestApp ? { OCW_DESKTOP_UPDATE_TEST_APP: macTestApp } : {}),
      ...(appImage ? { APPIMAGE: appImage.path } : {}),
    },
  });
  const journey: Journey = { app, release, userData, macTestApp, appImage };
  journeys.push(journey);
  return journey;
}

interface MenuLine {
  label: string;
  enabled: boolean;
}

/** The Runtime menu's lines (no separators), read from the main process. */
function runtimeMenu(app: ElectronApplication): Promise<MenuLine[]> {
  return app.evaluate(({ Menu }) => {
    const runtime = Menu.getApplicationMenu()?.items.find((item) => item.label === "Runtime");
    return (runtime?.submenu?.items ?? [])
      .filter((item) => item.type !== "separator")
      .map((item) => ({ label: item.label, enabled: item.enabled }));
  });
}

async function runtimeLabels(app: ElectronApplication): Promise<string[]> {
  return (await runtimeMenu(app)).map((line) => line.label);
}

/** Clicks an enabled Runtime menu item by its label; false while there is none. */
function clickRuntimeItem(app: ElectronApplication, label: string): Promise<boolean> {
  return app.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === "Runtime")
      ?.submenu?.items.find((i) => i.label === wanted && i.enabled);
    if (!item) return false;
    item.click();
    return true;
  }, label);
}

/** Nothing was installed: the Mac test app is still 0.1.0, no swap result, the AppImage file unchanged. */
function expectNothingInstalled(journey: Journey): void {
  expect(existsSync(join(journey.userData, RESULT_FILE))).toBe(false);
  if (journey.macTestApp) expect(bundleVersion(journey.macTestApp)).toBe("0.1.0");
  if (journey.appImage) expect(readFileSync(journey.appImage.path).equals(journey.appImage.bytes)).toBe(true);
}

test.afterEach(async () => {
  for (const journey of journeys.splice(0)) {
    await journey.app.close().catch(() => undefined);
    await journey.release.close().catch(() => undefined);
  }
});

test.afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a newer release downloads, passes its checksum and is offered", async () => {
  test.setTimeout(300_000);
  const journey = await launch({ corrupt: false });
  const { app, release } = journey;

  // The first automatic check runs at the daemon's first status (else after 60 s); the download follows by itself.
  await expect.poll(() => runtimeLabels(app), { timeout: 150_000, intervals: [500] }).toContain(RESTART);
  expect(release.requests).toContain(`/${release.channelFile}`);
  expect(release.payloadRequests()).toBe(1);

  const onboarding = await app.firstWindow();
  await expect(onboarding.locator("#update-action")).toBeVisible({ timeout: 30_000 });
  await expect(onboarding.locator("#update-action")).toHaveText(RESTART);

  // macOS: the verified bundle is staged beside the (test) installed app, nothing is swapped yet.
  if (journey.macTestApp)
    expect(existsSync(join(dirname(journey.macTestApp), stagingDirName(VERSION), "OCW.app"))).toBe(true);

  await app.close();
  expectNothingInstalled(journey);
  expect(release.payloadRequests()).toBe(1);
});

test("a corrupted download is refused", async () => {
  test.setTimeout(300_000);
  const journey = await launch({ corrupt: true });
  const { app, release } = journey;
  const offered = async () =>
    (await runtimeLabels(app)).some((label) => label.startsWith("Restart to update"));

  // The automatic check downloads once; its failure is silent (no click asked for it), and nothing is offered.
  await expect
    .poll(() => release.payloadRequests(), { timeout: 150_000, intervals: [500] })
    .toBeGreaterThanOrEqual(1);
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    expect(await offered()).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
  }

  // "Check for updates…" downloads again, is refused again, and now says why (D-04).
  await expect.poll(() => clickRuntimeItem(app, CHECK), { timeout: 30_000, intervals: [500] }).toBe(true);
  await expect
    .poll(() => release.payloadRequests(), { timeout: 60_000, intervals: [500] })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      async () => (await runtimeMenu(app)).find((line) => line.label === UPDATE_SENTENCES.checksumMismatch),
      {
        timeout: 60_000,
        intervals: [500],
      },
    )
    .toEqual({ label: UPDATE_SENTENCES.checksumMismatch, enabled: false });
  expect(await offered()).toBe(false);
  if (journey.macTestApp)
    expect(existsSync(join(dirname(journey.macTestApp), stagingDirName(VERSION)))).toBe(false);

  await app.close();
  expectNothingInstalled(journey);
});
