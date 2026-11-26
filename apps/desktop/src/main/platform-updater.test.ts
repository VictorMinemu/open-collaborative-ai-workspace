import { describe, expect, it, vi } from "vitest";
import type { UpdaterLike } from "./app-update";

// electron-updater needs Electron at runtime; the factory only constructs classes and sets fields, so fakes record
// what it did. Only the two stock updaters the app may use exist in this fake module.
vi.mock("electron-updater", () => {
  class FakeUpdater {
    kind = "base";
    logger: unknown = "console";
    autoDownload = true;
    autoInstallOnAppQuit = true;
    allowPrerelease = true;
    allowDowngrade = true;
    forceDevUpdateConfig = false;
    disableDifferentialDownload = false;
    configPath: string | null = null;
    feeds: unknown[] = [];
    set updateConfigPath(value: string | null) {
      this.configPath = value;
    }
    setFeedURL(options: unknown) {
      this.feeds.push(options);
    }
  }
  class NsisUpdater extends FakeUpdater {
    override kind = "nsis";
  }
  class AppImageUpdater extends FakeUpdater {
    override kind = "appimage";
  }
  return { NsisUpdater, AppImageUpdater, FakeUpdater };
});

const { createPlatformUpdater, isLoopbackHttpUrl, updaterMode } = await import("./platform-updater");
const fakes = (await import("electron-updater")) as unknown as { FakeUpdater: new () => Record<string, unknown> };

type Mode = Parameters<typeof createPlatformUpdater>[0]["mode"];
const GITHUB: Mode = { kind: "github" };
const GITHUB_FEED = {
  provider: "github",
  owner: "VictorMinemu",
  repo: "open-collaborative-ai-workspace",
  releaseType: "release",
};
const noMac = () => {
  throw new Error("createMac must not run off macOS");
};

function expectConfigured(updater: unknown) {
  expect(updater).toMatchObject({
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
  });
}

describe("createPlatformUpdater (07.13.1 D-01, D-02)", () => {
  it("Windows gets the NSIS updater on the canonical GitHub feed", () => {
    const { updater, fallback } = createPlatformUpdater({ platform: "win32", env: {}, mode: GITHUB, createMac: noMac });
    expect(fallback).toBeNull();
    expect(updater).toMatchObject({ kind: "nsis", feeds: [GITHUB_FEED] });
    expectConfigured(updater);
    // The controller takes it as is.
    const asController: UpdaterLike | null = updater;
    expect(asController).toBe(updater);
  });

  it("Linux gets the AppImage updater only with APPIMAGE set, else the .deb fallback", () => {
    const appImage = createPlatformUpdater({
      platform: "linux",
      env: { APPIMAGE: "/home/someone/OCW-v0.5.0-linux-x86_64.AppImage" },
      mode: GITHUB,
      createMac: noMac,
    });
    expect(appImage.fallback).toBeNull();
    expect(appImage.updater).toMatchObject({ kind: "appimage", feeds: [GITHUB_FEED] });
    expectConfigured(appImage.updater);
    expect(createPlatformUpdater({ platform: "linux", env: {}, mode: GITHUB, createMac: noMac })).toEqual({
      updater: null,
      fallback: "deb",
    });
    expect(createPlatformUpdater({ platform: "linux", env: { APPIMAGE: "" }, mode: GITHUB, createMac: noMac })).toEqual(
      { updater: null, fallback: "deb" },
    );
  });

  it("macOS gets the injected ad-hoc updater, configured the same way, or its refusal as the fallback", () => {
    const mac = new fakes.FakeUpdater();
    const createMac = vi.fn(() => ({ ok: true as const, updater: mac as never }));
    const built = createPlatformUpdater({ platform: "darwin", env: {}, mode: GITHUB, createMac });
    expect(createMac).toHaveBeenCalledTimes(1);
    expect(built.updater).toBe(mac);
    expect(built.fallback).toBeNull();
    expect(mac.feeds).toEqual([GITHUB_FEED]);
    expectConfigured(mac);
    for (const reason of ["dmg", "translocated", "unwritable", "not_bundle"] as const) {
      expect(
        createPlatformUpdater({
          platform: "darwin",
          env: {},
          mode: GITHUB,
          createMac: () => ({ ok: false, reason }),
        }),
      ).toEqual({ updater: null, fallback: reason });
    }
  });

  it("any other platform gets nothing", () => {
    expect(createPlatformUpdater({ platform: "freebsd", env: {}, mode: GITHUB, createMac: noMac })).toEqual({
      updater: null,
      fallback: "unsupported",
    });
  });

  it("an off mode builds nothing on any platform", () => {
    for (const reason of ["not_release", "dev"] as const) {
      for (const platform of ["win32", "linux", "darwin"] as const) {
        const createMac = vi.fn();
        expect(
          createPlatformUpdater({ platform, env: { APPIMAGE: "/x.AppImage" }, mode: { kind: "off", reason }, createMac }),
        ).toEqual({ updater: null, fallback: reason });
        expect(createMac).not.toHaveBeenCalled();
      }
    }
  });

  it("the test mode reads the given config and a loopback generic feed, full downloads only", () => {
    const { updater } = createPlatformUpdater({
      platform: "win32",
      env: {},
      mode: { kind: "test", feedUrl: "http://127.0.0.1:43123/", configPath: "/tmp/ocw-e2e/app-update.yml", macTestApp: null },
      createMac: noMac,
    });
    expect(updater).toMatchObject({
      forceDevUpdateConfig: true,
      configPath: "/tmp/ocw-e2e/app-update.yml",
      disableDifferentialDownload: true,
      feeds: [{ provider: "generic", url: "http://127.0.0.1:43123/" }],
    });
    expectConfigured(updater);
  });
});

describe("updaterMode (D-02, Pitfall 7)", () => {
  const testEnv = {
    OCW_DESKTOP_UPDATE_FEED: "http://127.0.0.1:43123/",
    OCW_DESKTOP_UPDATE_CONFIG: "/tmp/ocw-e2e/app-update.yml",
  };

  it("a packaged release build uses GitHub; a packaged local or fork build never updates, test variables or not", () => {
    expect(updaterMode({ isPackaged: true, releaseBuild: true, env: {} })).toEqual({ kind: "github" });
    expect(updaterMode({ isPackaged: true, releaseBuild: true, env: testEnv })).toEqual({ kind: "github" });
    expect(updaterMode({ isPackaged: true, releaseBuild: false, env: testEnv })).toEqual({
      kind: "off",
      reason: "not_release",
    });
  });

  it("unpackaged: the test feed only on loopback http with an absolute config, else off", () => {
    expect(updaterMode({ isPackaged: false, releaseBuild: false, env: testEnv })).toEqual({
      kind: "test",
      feedUrl: "http://127.0.0.1:43123/",
      configPath: "/tmp/ocw-e2e/app-update.yml",
      macTestApp: null,
    });
    expect(
      updaterMode({
        isPackaged: false,
        releaseBuild: true,
        env: { ...testEnv, OCW_DESKTOP_UPDATE_TEST_APP: "/tmp/ocw-e2e/OCW.app" },
      }),
    ).toMatchObject({ kind: "test", macTestApp: "/tmp/ocw-e2e/OCW.app" });
    expect(
      updaterMode({ isPackaged: false, releaseBuild: false, env: { ...testEnv, OCW_DESKTOP_UPDATE_TEST_APP: "OCW.app" } }),
    ).toMatchObject({ kind: "test", macTestApp: null });
    const off = { kind: "off", reason: "dev" };
    expect(updaterMode({ isPackaged: false, releaseBuild: false, env: {} })).toEqual(off);
    for (const feed of [
      "https://example.com/",
      "http://10.0.0.1/",
      "http://user:pass@127.0.0.1:43123/",
      "http://127.0.0.1.example.com/",
      "file:///tmp/feed",
      "not a url",
    ]) {
      expect(updaterMode({ isPackaged: false, releaseBuild: false, env: { ...testEnv, OCW_DESKTOP_UPDATE_FEED: feed } })).toEqual(
        off,
      );
    }
    expect(
      updaterMode({ isPackaged: false, releaseBuild: false, env: { ...testEnv, OCW_DESKTOP_UPDATE_CONFIG: "app-update.yml" } }),
    ).toEqual(off);
  });

  it("isLoopbackHttpUrl accepts http on 127.0.0.1, localhost and [::1] only", () => {
    for (const ok of ["http://127.0.0.1:1/", "http://localhost:8080/feed/", "http://[::1]:9/"]) {
      expect(isLoopbackHttpUrl(ok)).toBe(true);
    }
    for (const bad of ["https://127.0.0.1/", "http://127.0.0.2/", "http://a@localhost/", "http://localhost.evil/", ""]) {
      expect(isLoopbackHttpUrl(bad)).toBe(false);
    }
  });
});
