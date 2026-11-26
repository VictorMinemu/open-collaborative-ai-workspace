// Phase 07.17.1 (ADR-0040, D-05, D-12, PD-05, PD-11, E15): only a daemon a service manager will restart may switch
// versions under itself, and the running build is the running file's hash. Scratch OCW_HOME only (PD-19); env,
// platform and argv1 are explicit, never the test process's own.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLaunchdPlist } from "../service/launchd.js";
import { renderSystemdUnit } from "../service/systemd.js";
import { type ScratchHome, scratchOcwHome } from "./self-update-harness.js";
import { isSupervised, runningBuild } from "./supervision.js";

let home: ScratchHome;
let installed: string;

beforeEach(async () => {
  home = await scratchOcwHome();
  installed = join(home.ocwHome, "runtime", "current", "ocw-runtime.mjs");
});

afterEach(() => home.cleanup());

const linuxService = { OCW_RUNTIME_HOST: "service", INVOCATION_ID: "abc" };

describe("isSupervised (07.17.1, D-05, D-12, PD-11, E15)", () => {
  it("is supervised under systemd running the installed bundle", async () => {
    expect(
      await isSupervised({ env: linuxService, platform: "linux", argv1: installed, ocwHome: home.ocwHome }),
    ).toEqual({ supervised: true, reason: null });
  });

  it("answers not_supervised for the launcher in a terminal and for non-service hosts", async () => {
    for (const env of [
      { OCW_RUNTIME_HOST: "service" },
      { OCW_RUNTIME_HOST: "service", INVOCATION_ID: "" },
      { INVOCATION_ID: "abc" },
      { OCW_RUNTIME_HOST: "desktop", INVOCATION_ID: "abc" },
    ]) {
      expect(await isSupervised({ env, platform: "linux", argv1: installed, ocwHome: home.ocwHome })).toEqual(
        {
          supervised: false,
          reason: "not_supervised",
        },
      );
    }
  });

  it("is supervised under launchd only with the OCW job label", async () => {
    expect(
      await isSupervised({
        env: { OCW_RUNTIME_HOST: "service", XPC_SERVICE_NAME: "org.ocw.runtime" },
        platform: "darwin",
        argv1: installed,
        ocwHome: home.ocwHome,
      }),
    ).toEqual({ supervised: true, reason: null });
    for (const XPC_SERVICE_NAME of ["0", "com.apple.Terminal", undefined]) {
      expect(
        await isSupervised({
          env: { OCW_RUNTIME_HOST: "service", XPC_SERVICE_NAME },
          platform: "darwin",
          argv1: installed,
          ocwHome: home.ocwHome,
        }),
      ).toEqual({ supervised: false, reason: "not_supervised" });
    }
    // A systemd marker means nothing on macOS.
    expect(
      (await isSupervised({ env: linuxService, platform: "darwin", argv1: installed, ocwHome: home.ocwHome }))
        .reason,
    ).toBe("not_supervised");
  });

  it("answers not_supervised on other platforms", async () => {
    expect(
      await isSupervised({
        env: { ...linuxService, XPC_SERVICE_NAME: "org.ocw.runtime" },
        platform: "win32",
        argv1: installed,
        ocwHome: home.ocwHome,
      }),
    ).toEqual({ supervised: false, reason: "not_supervised" });
  });

  it("answers not_installed for a bundle outside versions/ or without install.json, before the env checks", async () => {
    const checkout = join(home.ocwHome, "..", "checkout", "src", "cli.ts");
    mkdirSync(join(checkout, ".."), { recursive: true });
    writeFileSync(checkout, "// a checkout\n");
    expect(
      await isSupervised({ env: linuxService, platform: "linux", argv1: checkout, ocwHome: home.ocwHome }),
    ).toEqual({ supervised: false, reason: "not_installed" });
    expect(
      await isSupervised({ env: {}, platform: "linux", argv1: undefined, ocwHome: home.ocwHome }),
    ).toEqual({ supervised: false, reason: "not_installed" });

    // A staging directory is not an installed version.
    const staging = join(home.ocwHome, "runtime", "versions", ".staging-x", "ocw-runtime.mjs");
    mkdirSync(join(staging, ".."), { recursive: true });
    writeFileSync(staging, "// staging\n");
    expect(
      (await isSupervised({ env: linuxService, platform: "linux", argv1: staging, ocwHome: home.ocwHome }))
        .reason,
    ).toBe("not_installed");

    rmSync(join(home.ocwHome, "runtime", "install.json"));
    expect(
      await isSupervised({ env: {}, platform: "linux", argv1: installed, ocwHome: home.ocwHome }),
    ).toEqual({
      supervised: false,
      reason: "not_installed",
    });
  });

  it("answers not_installed when install.json does not parse", async () => {
    writeFileSync(join(home.ocwHome, "runtime", "install.json"), "{}\n");
    expect(
      (await isSupervised({ env: linuxService, platform: "linux", argv1: installed, ocwHome: home.ocwHome }))
        .reason,
    ).toBe("not_installed");
  });
});

/**
 * Units written before 07.16-05 (v0.2.x installers) do not set OCW_RUNTIME_HOST: the daemon they start is supervised
 * when systemd started it as our own unit (cgroup), that unit is the one the installer generated, it runs the
 * installed bundle through `current` and it restarts on the update exit. Every machine path sits under a scratch root.
 */
describe("isSupervised, units written by an older installer", () => {
  let root: string;
  const USER_HOME = "/home/alice";
  const USER_UNIT = "/home/alice/.config/systemd/user/ocw-runtime.service";
  const SYSTEM_UNIT = "/etc/systemd/system/ocw-runtime.service";
  const PLIST = "/Users/alice/Library/LaunchAgents/org.ocw.runtime.plist";
  const USER_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ocw-runtime.service\n";

  beforeEach(() => {
    root = join(home.ocwHome, "..", "machine");
    mkdirSync(root, { recursive: true });
  });

  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const legacyUnit = (scope: "user" | "system" = "user", bundlePath = installed) =>
    renderSystemdUnit({
      scope,
      nodePath: "/usr/bin/node",
      bundlePath,
      workingDirectory: USER_HOME,
      path: "/usr/bin:/bin",
      ...(scope === "system" ? { account: "alice" } : {}),
    }).replace('Environment="OCW_RUNTIME_HOST=service"\n', "");
  const linux = (env: NodeJS.ProcessEnv = { INVOCATION_ID: "abc" }, unit = { userHome: USER_HOME, root }) =>
    isSupervised({ env, platform: "linux", argv1: installed, ocwHome: home.ocwHome, unit });

  it("is supervised under its systemd user unit without OCW_RUNTIME_HOST", async () => {
    put("/proc/self/cgroup", USER_CGROUP);
    put(USER_UNIT, legacyUnit());
    expect(await linux()).toEqual({ supervised: true, reason: null });
    // Also with cgroup v1's named systemd hierarchy, and Restart=always.
    put("/proc/self/cgroup", `12:cpu:/\n1:name=systemd:${USER_CGROUP.slice(3)}`);
    put(USER_UNIT, legacyUnit().replace("Restart=on-failure", "Restart=always"));
    expect(await linux()).toEqual({ supervised: true, reason: null });
  });

  it("is supervised under its system unit, and finds a user unit under XDG_CONFIG_HOME", async () => {
    put("/proc/self/cgroup", "0::/system.slice/ocw-runtime.service\n");
    put(SYSTEM_UNIT, legacyUnit("system"));
    expect(await linux()).toEqual({ supervised: true, reason: null });

    put("/proc/self/cgroup", USER_CGROUP);
    put("/home/alice/.cfg/systemd/user/ocw-runtime.service", legacyUnit());
    expect(await linux({ INVOCATION_ID: "abc", XDG_CONFIG_HOME: "/home/alice/.cfg" })).toEqual({
      supervised: true,
      reason: null,
    });
  });

  it("stays not_supervised when anything is missing or not ours (D-05: never switch without a restart)", async () => {
    const cases: Array<{ name: string; setup: () => void; env?: NodeJS.ProcessEnv }> = [
      { name: "no unit file", setup: () => put("/proc/self/cgroup", USER_CGROUP) },
      { name: "no cgroup", setup: () => put(USER_UNIT, legacyUnit()) },
      {
        name: "another unit's cgroup",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP.replace("ocw-runtime.service", "my-runner.service"));
          put(USER_UNIT, legacyUnit());
        },
      },
      {
        name: "a transient scope",
        setup: () => {
          put("/proc/self/cgroup", "0::/user.slice/user-1000.slice/session-3.scope\n");
          put(USER_UNIT, legacyUnit());
        },
      },
      {
        name: "no manager marker",
        env: {},
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(USER_UNIT, legacyUnit());
        },
      },
      {
        name: "the desktop launcher",
        env: { INVOCATION_ID: "abc", OCW_RUNTIME_HOST: "desktop" },
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(USER_UNIT, legacyUnit());
        },
      },
      {
        name: "a hand-written unit",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(USER_UNIT, legacyUnit().split("\n").slice(1).join("\n"));
        },
      },
      {
        name: "Restart=no",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(USER_UNIT, legacyUnit().replace("Restart=on-failure", "Restart=no"));
        },
      },
      {
        name: "a unit pinned to one version instead of current",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(
            USER_UNIT,
            legacyUnit("user", join(home.ocwHome, "runtime", "versions", home.oldSha12, "ocw-runtime.mjs")),
          );
        },
      },
      {
        name: "another OCW_HOME's bundle",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(
            USER_UNIT,
            legacyUnit("user", join(home.ocwHome, "..", "other", "runtime", "current", "ocw-runtime.mjs")),
          );
        },
      },
      {
        name: "a drop-in that may change Restart=",
        setup: () => {
          put("/proc/self/cgroup", USER_CGROUP);
          put(USER_UNIT, legacyUnit());
          put(`${USER_UNIT}.d/override.conf`, "[Service]\nRestart=no\n");
        },
      },
      {
        name: "a system cgroup with only a user unit",
        setup: () => {
          put("/proc/self/cgroup", "0::/system.slice/ocw-runtime.service\n");
          put(USER_UNIT, legacyUnit());
        },
      },
    ];
    for (const c of cases) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      c.setup();
      expect({ name: c.name, ...(await linux(c.env)) }).toEqual({
        name: c.name,
        supervised: false,
        reason: "not_supervised",
      });
    }
  });

  it("reads no unit at all unless the caller names where to look", async () => {
    put("/proc/self/cgroup", USER_CGROUP);
    put(USER_UNIT, legacyUnit());
    expect(
      await isSupervised({
        env: { INVOCATION_ID: "abc" },
        platform: "linux",
        argv1: installed,
        ocwHome: home.ocwHome,
      }),
    ).toEqual({ supervised: false, reason: "not_supervised" });
  });

  it("is supervised under its LaunchAgent without OCW_RUNTIME_HOST, and not without KeepAlive", async () => {
    const plist = renderLaunchdPlist({
      nodePath: "/opt/homebrew/bin/node",
      bundlePath: installed,
      workingDirectory: "/Users/alice",
      path: "/opt/homebrew/bin:/usr/bin",
      logFile: join(home.ocwHome, "logs", "runtime.log"),
    }).replace("    <key>OCW_RUNTIME_HOST</key>\n    <string>service</string>\n", "");
    const mac = () =>
      isSupervised({
        env: { XPC_SERVICE_NAME: "org.ocw.runtime" },
        platform: "darwin",
        argv1: installed,
        ocwHome: home.ocwHome,
        unit: { userHome: "/Users/alice", root },
      });
    put(PLIST, plist);
    expect(await mac()).toEqual({ supervised: true, reason: null });
    put(
      PLIST,
      plist.replace("<key>SuccessfulExit</key>\n    <false/>", "<key>SuccessfulExit</key>\n    <true/>"),
    );
    expect(await mac()).toEqual({ supervised: false, reason: "not_supervised" });
  });
});

describe("runningBuild (07.17.1, PD-05)", () => {
  it("hashes the realpath of the installed bundle once", async () => {
    const real = join(home.ocwHome, "runtime", "versions", home.oldSha12, "ocw-runtime.mjs");
    const read = vi.fn((path: string) => readFile(path));
    expect(
      await runningBuild({ argv1: installed, ocwHome: home.ocwHome, version: "0.3.1", readFile: read }),
    ).toEqual({ version: "0.3.1", sha256: createHash("sha256").update(readFileSync(real)).digest("hex") });
    expect(read).toHaveBeenCalledTimes(1);
    expect(home.oldSha256).toBe(createHash("sha256").update(readFileSync(real)).digest("hex"));
  });

  it("answers null outside versions/ and without argv1", async () => {
    const checkout = join(home.ocwHome, "..", "checkout-cli.ts");
    writeFileSync(checkout, "// a checkout\n");
    const read = vi.fn((path: string) => readFile(path));
    expect(
      await runningBuild({ argv1: checkout, ocwHome: home.ocwHome, version: "0.3.1", readFile: read }),
    ).toBe(null);
    expect(await runningBuild({ argv1: undefined, ocwHome: home.ocwHome, version: "0.3.1" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
