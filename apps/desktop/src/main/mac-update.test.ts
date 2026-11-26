import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDummyMacApp, zipDummyMacApp } from "../../e2e/support/mac-dummy-app";
import { MacUpdateError, macInstallTarget, type RunTool, stageUpdate } from "./mac-update";

/**
 * 07.13.1 (D-04, D-05): macOS gets its own installer because Squirrel.Mac refuses ad-hoc signed updates. A downloaded
 * zip becomes a staged app beside the installed one only after ditto extraction, a strict seal check, the bundle id,
 * the version and the daemon; otherwise nothing is left behind. Every test works in a temp folder; the darwin cases use
 * the real tools on a dummy app signed ad hoc, never the installed OCW.
 */

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocw-mac-update-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writable = () => true;

describe("macInstallTarget (D-05)", () => {
  it("accepts an OCW.app in a writable folder", () => {
    expect(macInstallTarget("/Applications/OCW.app/Contents/MacOS/OCW", { isWritable: writable })).toEqual({
      ok: true,
      app: "/Applications/OCW.app",
      parent: "/Applications",
    });
  });

  it("refuses a disk image, a translocated copy, a non-bundle and an unwritable folder", () => {
    expect(macInstallTarget("/Volumes/OCW/OCW.app/Contents/MacOS/OCW", { isWritable: writable })).toEqual({
      ok: false,
      reason: "dmg",
    });
    expect(
      macInstallTarget("/private/var/folders/x/AppTranslocation/y/d/OCW.app/Contents/MacOS/OCW", {
        isWritable: writable,
      }),
    ).toEqual({ ok: false, reason: "translocated" });
    expect(macInstallTarget("/usr/local/bin/ocw", { isWritable: writable })).toEqual({
      ok: false,
      reason: "not_bundle",
    });
    expect(macInstallTarget("relative/OCW.app/Contents/MacOS/OCW", { isWritable: writable })).toEqual({
      ok: false,
      reason: "not_bundle",
    });
    const isWritable = vi.fn(() => false);
    expect(macInstallTarget("/Applications/OCW.app/Contents/MacOS/OCW", { isWritable })).toEqual({
      ok: false,
      reason: "unwritable",
    });
    expect(isWritable).toHaveBeenCalledWith("/Applications");
  });
});

type Call = { cmd: string; args: readonly string[]; timeoutMs: number };

/** A fake toolset: ditto writes a staged app with the given content; the other tools answer from `opts`. */
function fakeTools(
  opts: {
    seal?: boolean;
    id?: string;
    version?: string;
    daemon?: boolean;
    frameworkSymlink?: boolean;
    xattrFails?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const run: RunTool = async (cmd, args, { timeoutMs }) => {
    calls.push({ cmd, args, timeoutMs });
    if (cmd === "/usr/bin/ditto") {
      const out = args[3] ?? "";
      const app = join(out, "OCW.app");
      mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
      writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>");
      if (opts.daemon !== false) {
        mkdirSync(join(app, "Contents", "Resources", "daemon", "bin"), { recursive: true });
        writeFileSync(join(app, "Contents", "Resources", "daemon", "bin", "ocw-runtime"), "#!/bin/sh\n");
      }
      if (opts.frameworkSymlink !== undefined) {
        const fw = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions");
        mkdirSync(join(fw, "A"), { recursive: true });
        if (opts.frameworkSymlink) symlinkSync("A", join(fw, "Current"));
        else mkdirSync(join(fw, "Current"));
      }
      return { stdout: "" };
    }
    if (cmd === "/usr/bin/codesign") {
      if (opts.seal === false) throw new Error(`${args.at(-1)}: a sealed resource is missing or invalid`);
      return { stdout: "" };
    }
    if (cmd === "/usr/bin/plutil") {
      if (args[1] === "CFBundleIdentifier") return { stdout: `${opts.id ?? "dev.ocw.desktop"}\n` };
      if (args[1] === "CFBundleShortVersionString") return { stdout: `${opts.version ?? "0.5.1"}\n` };
      throw new Error("unexpected key");
    }
    if (cmd === "/usr/bin/xattr") {
      if (opts.xattrFails) throw new Error("No such xattr: com.apple.quarantine");
      return { stdout: "" };
    }
    throw new Error(`unexpected tool ${cmd}`);
  };
  return { run, calls };
}

function targetIn(dir: string) {
  const parent = join(dir, "Applications");
  mkdirSync(join(parent, "OCW.app"), { recursive: true });
  return { app: join(parent, "OCW.app"), parent };
}

async function failure(p: Promise<unknown>): Promise<MacUpdateError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MacUpdateError) return err;
    throw err;
  }
  throw new Error("expected stageUpdate to fail");
}

describe("stageUpdate (D-04, D-05)", () => {
  it("extracts, verifies, reads the identity and clears quarantine, each with an argv array", async () => {
    const dir = temp();
    const target = targetIn(dir);
    const zipPath = join(dir, "update.zip");
    const { run, calls } = fakeTools({ xattrFails: true });
    const staged = await stageUpdate({ zipPath, version: "0.5.1", target, run });
    const stagingDir = join(target.parent, ".ocw-update-0.5.1");
    const app = join(stagingDir, "OCW.app");
    expect(staged).toEqual({ stagingDir, stagedApp: app });
    const plist = join(app, "Contents", "Info.plist");
    expect(calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ["/usr/bin/ditto", "-x", "-k", zipPath, stagingDir],
      ["/usr/bin/codesign", "--verify", "--deep", "--strict", app],
      ["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
      ["/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
      ["/usr/bin/xattr", "-dr", "com.apple.quarantine", app],
    ]);
    expect(calls.map((c) => c.timeoutMs)).toEqual([300_000, 120_000, 30_000, 30_000, 30_000]);
    // The installed app is untouched; the staged one is in place.
    expect(existsSync(join(target.parent, "OCW.app"))).toBe(true);
    expect(existsSync(join(app, "Contents", "Resources", "daemon", "bin", "ocw-runtime"))).toBe(true);
  });

  it("replaces an earlier staging folder and only unlinks a symlink in its place", async () => {
    const dir = temp();
    const target = targetIn(dir);
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    symlinkSync(elsewhere, join(target.parent, ".ocw-update-0.5.1"));
    const { run } = fakeTools();
    await stageUpdate({ zipPath: join(dir, "u.zip"), version: "0.5.1", target, run });
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
    expect(lstatSync(join(target.parent, ".ocw-update-0.5.1")).isDirectory()).toBe(true);

    mkdirSync(join(target.parent, ".ocw-update-0.5.2", "stale"), { recursive: true });
    await stageUpdate({
      zipPath: join(dir, "u.zip"),
      version: "0.5.2",
      target,
      run: fakeTools({ version: "0.5.2" }).run,
    });
    expect(existsSync(join(target.parent, ".ocw-update-0.5.2", "stale"))).toBe(false);
  });

  it.each([
    ["seal_invalid", { seal: false }],
    ["wrong_bundle", { id: "dev.example.other" }],
    ["wrong_version", { version: "0.5.0" }],
    ["no_daemon", { daemon: false }],
    ["symlinks_lost", { frameworkSymlink: false }],
  ] as const)("fails with %s, removes the staging folder and never names a path", async (code, opts) => {
    const dir = temp();
    const target = targetIn(dir);
    const err = await failure(
      stageUpdate({ zipPath: join(dir, "u.zip"), version: "0.5.1", target, run: fakeTools(opts).run }),
    );
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(dir);
    expect(err.message).not.toContain("/");
    expect(String(err.stack)).not.toContain(dir);
    expect(existsSync(join(target.parent, ".ocw-update-0.5.1"))).toBe(false);
    expect(existsSync(target.app)).toBe(true);
  });

  it("keeps a bundle whose framework symlinks survived", async () => {
    const dir = temp();
    const target = targetIn(dir);
    await expect(
      stageUpdate({
        zipPath: join(dir, "u.zip"),
        version: "0.5.1",
        target,
        run: fakeTools({ frameworkSymlink: true }).run,
      }),
    ).resolves.toBeTruthy();
  });

  it("fails with extract_failed when ditto fails", async () => {
    const dir = temp();
    const target = targetIn(dir);
    const run: RunTool = async () => {
      throw new Error(`ditto: ${dir}/u.zip: Cannot open`);
    };
    const err = await failure(stageUpdate({ zipPath: join(dir, "u.zip"), version: "0.5.1", target, run }));
    expect(err.code).toBe("extract_failed");
    expect(err.message).not.toContain(dir);
    expect(existsSync(join(target.parent, ".ocw-update-0.5.1"))).toBe(false);
  });

  it.each(["0.5.1-rc.1", "../x", "0.5", "v0.5.1", "0.5.1/../../x", ""])(
    "refuses the version %j before any command",
    async (version) => {
      const dir = temp();
      const target = targetIn(dir);
      const { run, calls } = fakeTools();
      const err = await failure(stageUpdate({ zipPath: join(dir, "u.zip"), version, target, run }));
      expect(err.code).toBe("bad_version");
      expect(calls).toEqual([]);
    },
  );
});

describe.runIf(process.platform === "darwin")("stageUpdate with the real macOS tools (darwin)", () => {
  async function zipped(version: string, opts: { bundleId?: string; tamperAfterSign?: boolean } = {}) {
    const dir = temp();
    const build = join(dir, "build");
    mkdirSync(build);
    const app = await buildDummyMacApp({ dir: build, version, ...opts });
    const zipPath = join(dir, `OCW-v${version}-macos-arm64.zip`);
    await zipDummyMacApp(app, zipPath);
    return { dir, zipPath, target: targetIn(dir) };
  }

  it("stages and verifies a signed dummy app and keeps its symlinks", async () => {
    const { zipPath, target } = await zipped("0.5.1");
    const staged = await stageUpdate({ zipPath, version: "0.5.1", target });
    expect(lstatSync(join(staged.stagedApp, "Contents", "Resources", "current")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(staged.stagedApp, "Contents", "Resources", "daemon", "bin", "ocw-runtime"))).toBe(
      true,
    );
  }, 60_000);

  it("refuses a dummy changed after signing (seal_invalid)", async () => {
    const { zipPath, target } = await zipped("0.5.1", { tamperAfterSign: true });
    const err = await failure(stageUpdate({ zipPath, version: "0.5.1", target }));
    expect(err.code).toBe("seal_invalid");
    expect(existsSync(join(target.parent, ".ocw-update-0.5.1"))).toBe(false);
  }, 60_000);

  it("refuses a dummy with another bundle id (wrong_bundle)", async () => {
    const { zipPath, target } = await zipped("0.5.1", { bundleId: "dev.example.other" });
    const err = await failure(stageUpdate({ zipPath, version: "0.5.1", target }));
    expect(err.code).toBe("wrong_bundle");
    expect(existsSync(join(target.parent, ".ocw-update-0.5.1"))).toBe(false);
  }, 60_000);
});
