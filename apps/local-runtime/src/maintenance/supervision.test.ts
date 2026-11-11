// Phase 07.17.1 (ADR-0040, D-05, D-12, PD-05, PD-11, E15): only a daemon a service manager will restart may switch
// versions under itself, and the running build is the running file's hash. Scratch OCW_HOME only (PD-19); env,
// platform and argv1 are explicit, never the test process's own.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      expect(await isSupervised({ env, platform: "linux", argv1: installed, ocwHome: home.ocwHome })).toEqual({
        supervised: false,
        reason: "not_supervised",
      });
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
    expect(await isSupervised({ env: {}, platform: "linux", argv1: installed, ocwHome: home.ocwHome })).toEqual({
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
    expect(await runningBuild({ argv1: checkout, ocwHome: home.ocwHome, version: "0.3.1", readFile: read })).toBe(
      null,
    );
    expect(await runningBuild({ argv1: undefined, ocwHome: home.ocwHome, version: "0.3.1" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
