import { describe, expect, it } from "vitest";
import {
  augmentPath,
  buildDaemonEnv,
  installRoot,
  killTreeCommand,
  resolveDaemonCommand,
} from "./daemon-launch";

// Review WR-03: the folder an update replaces, to tell whether a daemon started by hand runs from it.
describe("installRoot", () => {
  it("is the app bundle on macOS, the install folder on Windows, the AppImage mount or folder on Linux", () => {
    expect(
      installRoot({
        isPackaged: true,
        platform: "darwin",
        execPath: "/Applications/OCW.app/Contents/MacOS/OCW",
        env: {},
      }),
    ).toBe("/Applications/OCW.app");
    expect(
      installRoot({
        isPackaged: true,
        platform: "win32",
        execPath: "C:\\Users\\someone\\AppData\\Local\\Programs\\OCW\\OCW.exe",
        env: {},
      }),
    ).toBe("C:\\Users\\someone\\AppData\\Local\\Programs\\OCW");
    expect(
      installRoot({
        isPackaged: true,
        platform: "linux",
        execPath: "/tmp/.mount_OCWabc/ocw",
        env: { APPIMAGE: "/home/someone/OCW.AppImage", APPDIR: "/tmp/.mount_OCWabc" },
      }),
    ).toBe("/tmp/.mount_OCWabc");
    expect(installRoot({ isPackaged: true, platform: "linux", execPath: "/opt/OCW/ocw", env: {} })).toBe(
      "/opt/OCW",
    );
  });

  it("is null unpackaged or outside an app bundle", () => {
    expect(
      installRoot({ isPackaged: false, platform: "darwin", execPath: "/x/Electron", env: {} }),
    ).toBeNull();
    expect(
      installRoot({ isPackaged: true, platform: "darwin", execPath: "/usr/local/bin/ocw", env: {} }),
    ).toBeNull();
  });
});

describe("killTreeCommand (review WR-03)", () => {
  it("is taskkill from System32 over the whole tree, with a fixed argv", () => {
    expect(killTreeCommand(4242, { SystemRoot: "D:\\Windows" })).toEqual({
      command: "D:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
    });
    expect(killTreeCommand(7, {})?.command).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("refuses a pid that is not a positive integer", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(killTreeCommand(pid, {})).toBeNull();
  });
});

describe("resolveDaemonCommand", () => {
  const base = {
    appPath: "/repo/apps/desktop",
    resourcesPath: "/Applications/OCW.app/Contents/Resources",
    execPath: "/x/Electron",
  };
  it("uses the workspace daemon in dev and Electron as Node", () => {
    expect(resolveDaemonCommand({ ...base, isPackaged: false, env: {} })).toEqual({
      command: "/x/Electron",
      args: ["/repo/apps/local-runtime/bin/ocw-runtime", "run"],
      cwd: "/repo/apps/local-runtime",
      electronAsNode: true,
    });
  });
  it("uses the bundled daemon when packaged", () => {
    const c = resolveDaemonCommand({ ...base, isPackaged: true, env: {} });
    expect(c.args[0]).toBe("/Applications/OCW.app/Contents/Resources/daemon/bin/ocw-runtime");
  });
  it("honours OCW_DAEMON_NODE / OCW_DAEMON_ENTRY overrides", () => {
    const c = resolveDaemonCommand({
      ...base,
      isPackaged: false,
      env: { OCW_DAEMON_NODE: "/opt/homebrew/bin/node", OCW_DAEMON_ENTRY: "/d/bin/ocw-runtime" },
    });
    expect(c).toMatchObject({ command: "/opt/homebrew/bin/node", args: ["/d/bin/ocw-runtime", "run"] });
    expect(c.electronAsNode).toBe(false);
  });
});

describe("buildDaemonEnv", () => {
  it("passes the token and API URL, strips Electron and stale token variables", () => {
    const env = buildDaemonEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/v",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        OCW_DEVICE_TOKEN: "stale",
        OCW_DEVICE_TOKEN_FILE: "/tmp/t",
        OCW_HOME: "/tmp/ocw",
      },
      { token: "ocwdt_fresh", apiUrl: "http://localhost:4000", electronAsNode: true, home: "/Users/v" },
    );
    expect(env.OCW_DEVICE_TOKEN).toBe("ocwdt_fresh");
    expect(env.OCW_DEVICE_TOKEN_FILE).toBeUndefined();
    expect(env.OCW_SERVER_URL).toBe("http://localhost:4000");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.ELECTRON_ENABLE_LOGGING).toBeUndefined();
    expect(env.OCW_HOME).toBe("/tmp/ocw");
    expect(env.PATH).toBe("/usr/bin:/bin:/Users/v/.local/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  // Review WR-02: the AppImage updater's markers are about this app's own start, never the daemon's.
  it("drops the AppImage updater's install markers", () => {
    const env = buildDaemonEnv(
      { APPIMAGE_SILENT_INSTALL: "true", APPIMAGE_EXIT_AFTER_INSTALL: "true", APPIMAGE: "/x.AppImage" },
      { token: null, apiUrl: null, electronAsNode: true },
    );
    expect(env.APPIMAGE_SILENT_INSTALL).toBeUndefined();
    expect(env.APPIMAGE_EXIT_AFTER_INSTALL).toBeUndefined();
    expect(env.APPIMAGE).toBe("/x.AppImage");
  });

  it("sets no token when unpaired and no Electron flag for a system node", () => {
    const env = buildDaemonEnv(
      { OCW_DEVICE_TOKEN: "x" },
      { token: null, apiUrl: null, electronAsNode: false },
    );
    expect(env.OCW_DEVICE_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OCW_SERVER_URL).toBeUndefined();
  });
});

describe("buildDaemonEnv host kind (07.16, PD-18, A-02)", () => {
  it("tells the daemon it runs under the desktop app, replacing an inherited value", () => {
    expect(buildDaemonEnv({}, { token: null, apiUrl: null, electronAsNode: false }).OCW_RUNTIME_HOST).toBe(
      "desktop",
    );
    const env = buildDaemonEnv(
      { OCW_RUNTIME_HOST: "service", PATH: "/usr/bin" },
      { token: "ocwdt_x", apiUrl: "http://localhost:4000", electronAsNode: true },
    );
    expect(env.OCW_RUNTIME_HOST).toBe("desktop");
    expect(env.OCW_SERVER_URL).toBe("http://localhost:4000");
    expect(env.OCW_DEVICE_TOKEN).toBe("ocwdt_x");
  });

  // 07.13.1.1 (D-04, D-12, T-07.13.1.1-04-07): Assign to me is offered only on server devices, so the app's daemon must
  // never be able to announce `service`, whatever the app inherited.
  const inherited = ["service", "SERVICE", " service ", "laptop"];
  const combos = [null, "ocwdt_x"].flatMap((token) =>
    [null, "http://localhost:4000"].flatMap((apiUrl) =>
      [false, true].map((electronAsNode) => ({ token, apiUrl, electronAsNode })),
    ),
  );
  it.each(inherited.flatMap((value) => combos.map((opts) => [value, opts] as const)))(
    "an inherited OCW_RUNTIME_HOST=%j with %j always yields desktop",
    (value, opts) => {
      const env = buildDaemonEnv({ OCW_RUNTIME_HOST: value, PATH: "/usr/bin" }, opts);
      expect(env.OCW_RUNTIME_HOST).toBe("desktop");
    },
  );
});

describe("buildDaemonEnv app version (07.13, D-18, PD-21)", () => {
  const base = { token: null, apiUrl: null, electronAsNode: false };

  it("passes the desktop app's version as OCW_APP_VERSION", () => {
    expect(buildDaemonEnv({}, { ...base, appVersion: "0.5.0" }).OCW_APP_VERSION).toBe("0.5.0");
    expect(buildDaemonEnv({}, { ...base, appVersion: "0.5.0-rc.1" }).OCW_APP_VERSION).toBe("0.5.0-rc.1");
  });

  it.each([[""], ["  "], ["latest"], ["0.5"], ["v0.5.0"], ["0.5.0\nX=1"], [`1.2.3-${"a".repeat(80)}`]])(
    "never passes an empty or non-semver version (%j), nor an inherited one",
    (appVersion) => {
      const env = buildDaemonEnv({ OCW_APP_VERSION: "9.9.9" }, { ...base, appVersion });
      expect(env.OCW_APP_VERSION).toBeUndefined();
    },
  );

  it("drops an inherited OCW_APP_VERSION when the app gives none", () => {
    expect(buildDaemonEnv({ OCW_APP_VERSION: "9.9.9" }, base).OCW_APP_VERSION).toBeUndefined();
  });
});

describe("augmentPath", () => {
  it("does not duplicate entries", () => {
    expect(augmentPath("/opt/homebrew/bin:/usr/bin", "/h")).toBe(
      "/opt/homebrew/bin:/usr/bin:/h/.local/bin:/usr/local/bin",
    );
  });
});
