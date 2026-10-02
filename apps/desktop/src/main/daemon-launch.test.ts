import { describe, expect, it } from "vitest";
import { augmentPath, buildDaemonEnv, resolveDaemonCommand } from "./daemon-launch";

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

describe("augmentPath", () => {
  it("does not duplicate entries", () => {
    expect(augmentPath("/opt/homebrew/bin:/usr/bin", "/h")).toBe(
      "/opt/homebrew/bin:/usr/bin:/h/.local/bin:/usr/local/bin",
    );
  });
});
