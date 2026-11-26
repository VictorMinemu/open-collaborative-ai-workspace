import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildDummyMacApp, zipDummyMacApp } from "../../e2e/support/mac-dummy-app";
import {
  AdhocMacUpdater,
  createAdhocMacUpdater,
  MacUpdateError,
  macInstallTarget,
  type RunTool,
  readSwapResult,
  recordInstallFailure,
  type SpawnDetached,
  stageUpdate,
  sweepLeftovers,
} from "./mac-update";

// electron-updater's BaseUpdater needs Electron; this stand-in records the download it is asked for and runs its task
// with the options (sha512 included) electron-updater would pass.
vi.mock("electron-updater", () => {
  class BaseUpdater {
    readonly httpExecutor = { download: vi.fn(async (_url: URL, dest: string, _opts: unknown) => dest) };
    readonly executeDownload = vi.fn(
      async (t: {
        task: (dest: string, opts: unknown, pkg: null, rm: () => Promise<void>) => Promise<unknown>;
      }) => {
        await t.task(
          "/cache/pending/OCW-v0.5.1-macos-arm64.zip",
          { sha512: "c2hhNTEy" },
          null,
          async () => {},
        );
        return { updateFile: "/cache/pending/OCW-v0.5.1-macos-arm64.zip" };
      },
    );
  }
  return { BaseUpdater };
});

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

type FakeBase = {
  httpExecutor: { download: Mock };
  executeDownload: Mock;
};

/** Exposes the protected electron-updater hooks to the tests. */
class TestMacUpdater extends AdhocMacUpdater {
  download(o: DownloadUpdateOptions) {
    return this.doDownloadUpdate(o);
  }
  installNow(o: { isSilent: boolean; isForceRunAfter: boolean }) {
    return this.doInstall(o);
  }
  get fake(): FakeBase {
    return this as unknown as FakeBase;
  }
}

function releaseFile(name: string) {
  return {
    url: new URL(
      `https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/download/v0.5.1/${name}`,
    ),
    info: { url: name, sha512: "c2hhNTEy", size: 10 },
  };
}

function downloadOptions(files: ReturnType<typeof releaseFile>[]): DownloadUpdateOptions {
  const info = { version: "0.5.1", files: files.map((f) => f.info), path: "", sha512: "", releaseDate: "" };
  return {
    updateInfoAndProvider: { info, provider: { resolveFiles: () => files } },
    requestHeaders: {},
    cancellationToken: {},
  } as unknown as DownloadUpdateOptions;
}

function setup(opts: { daemonPid?: () => number } = {}) {
  const dir = temp();
  const target = targetIn(dir);
  const userData = join(dir, "userData");
  mkdirSync(userData);
  const helperSource = join(dir, "mac-swap-helper.cjs");
  writeFileSync(helperSource, "// the bundled swap helper\n");
  const tools = fakeTools();
  const unref = vi.fn();
  const spawn = vi.fn<SpawnDetached>(() => ({ unref }));
  const updater = new TestMacUpdater({
    target,
    userData,
    helperSource,
    daemonPid: opts.daemonPid ?? (() => 4242),
    run: tools.run,
    spawn,
  });
  return { dir, target, userData, helperSource, tools, spawn, unref, updater };
}

const CACHED = "/cache/OCW-v0.5.1-macos-arm64.zip";

describe("AdhocMacUpdater (D-01, D-05)", () => {
  it("downloads the release's zip through electron-updater, with its sha512", async () => {
    const { updater } = setup();
    const dmg = releaseFile("OCW-v0.5.1-macos-arm64.dmg");
    const zip = releaseFile("OCW-v0.5.1-macos-arm64.zip");
    await updater.download(downloadOptions([dmg, zip]));
    const { executeDownload, httpExecutor } = updater.fake;
    expect(executeDownload).toHaveBeenCalledTimes(1);
    expect(executeDownload.mock.calls[0]?.[0]).toMatchObject({ fileExtension: "zip", fileInfo: zip });
    expect(httpExecutor.download).toHaveBeenCalledTimes(1);
    expect(httpExecutor.download).toHaveBeenCalledWith(zip.url, "/cache/pending/OCW-v0.5.1-macos-arm64.zip", {
      sha512: "c2hhNTEy",
    });
  });

  it("rejects with no_zip when the release has no zip", async () => {
    const { updater } = setup();
    const err = await failure(updater.download(downloadOptions([releaseFile("OCW-v0.5.1-macos-arm64.dmg")])));
    expect(err.code).toBe("no_zip");
    expect(updater.fake.executeDownload).not.toHaveBeenCalled();
  });

  it("prepares the download: stages it and copies the helper beside the staged app (0600)", async () => {
    const { updater, target, tools } = setup();
    await updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED });
    const staging = join(target.parent, ".ocw-update-0.5.1");
    const helper = join(staging, "swap-helper.cjs");
    expect(readFileSync(helper, "utf8")).toBe("// the bundled swap helper\n");
    expect(statSync(helper).mode & 0o777).toBe(0o600);
    expect(tools.calls[0]?.args).toEqual(["-x", "-k", CACHED, staging]);
    // Already prepared for that version: nothing runs again.
    await updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED });
    expect(tools.calls.filter((c) => c.cmd === "/usr/bin/ditto")).toHaveLength(1);
  });

  it("fails to prepare with helper_failed and leaves no staging folder when the helper is missing", async () => {
    const { updater, target, helperSource } = setup();
    rmSync(helperSource);
    const err = await failure(updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED }));
    expect(err.code).toBe("helper_failed");
    expect(err.message).not.toContain("/");
    expect(existsSync(join(target.parent, ".ocw-update-0.5.1"))).toBe(false);
    expect(updater.installNow({ isSilent: true, isForceRunAfter: true })).toBe(false);
  });

  it("installs by spawning the detached helper with Electron as Node and argv only", async () => {
    const { updater, target, userData, spawn, unref } = setup();
    await updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED });
    expect(updater.installNow({ isSilent: true, isForceRunAfter: true })).toBe(true);
    const staging = join(target.parent, ".ocw-update-0.5.1");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        join(staging, "swap-helper.cjs"),
        String(process.pid),
        "4242",
        target.app,
        join(staging, "OCW.app"),
        join(userData, "update-result.json"),
        "0.5.1",
        "1",
      ],
      { detached: true, stdio: "ignore", env: { ELECTRON_RUN_AS_NODE: "1" } },
    );
    const options = spawn.mock.calls[0]?.[2];
    expect(options?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(options).not.toHaveProperty("shell");
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, "0"],
    [-1, "0"],
    [1.5, "0"],
    [Number.NaN, "0"],
    [77, "77"],
  ])("passes daemonPid %s as %j", async (pid, arg) => {
    const { updater, spawn } = setup({ daemonPid: () => pid });
    await updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED });
    expect(updater.installNow({ isSilent: true, isForceRunAfter: false })).toBe(true);
    expect(spawn.mock.calls[0]?.[1][2]).toBe(arg);
    expect(spawn.mock.calls[0]?.[1][7]).toBe("0");
  });

  // Review WR-01: the detached spawn reports a missing helper only asynchronously, after the app has exited; checked
  // first, so the install reports false and the controller relaunches the app.
  it("refuses to install (install_failed) when the prepared helper is gone, and spawns nothing", async () => {
    const { updater, target, spawn } = setup();
    await updater.prepareDownloaded({ version: "0.5.1", downloadedFile: CACHED });
    rmSync(join(target.parent, ".ocw-update-0.5.1", "swap-helper.cjs"));
    expect(() => updater.installNow({ isSilent: true, isForceRunAfter: true })).toThrow(MacUpdateError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("installs nothing before a download was prepared", () => {
    const { updater, spawn } = setup();
    expect(updater.installNow({ isSilent: true, isForceRunAfter: true })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("createAdhocMacUpdater (D-05)", () => {
  const base = { userData: "/x", helperSource: "/x/h.cjs", daemonPid: () => 0 };

  it("returns the target's refusal reason", () => {
    expect(
      createAdhocMacUpdater({
        ...base,
        exePath: "/Volumes/OCW/OCW.app/Contents/MacOS/OCW",
        isWritable: writable,
      }),
    ).toEqual({ ok: false, reason: "dmg" });
    expect(
      createAdhocMacUpdater({
        ...base,
        exePath: "/Applications/OCW.app/Contents/MacOS/OCW",
        isWritable: () => false,
      }),
    ).toEqual({ ok: false, reason: "unwritable" });
  });

  it("builds the updater, with installedAppOverride replacing the computed bundle", () => {
    const dir = temp();
    const override = join(dir, "Applications", "OCW.app");
    mkdirSync(override, { recursive: true });
    const made = createAdhocMacUpdater({
      ...base,
      exePath: "/Volumes/OCW/OCW.app/Contents/MacOS/OCW",
      installedAppOverride: override,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.updater).toBeInstanceOf(AdhocMacUpdater);
    expect(made.updater.installedApp).toBe(override);
    const plain = createAdhocMacUpdater({
      ...base,
      exePath: "/Applications/OCW.app/Contents/MacOS/OCW",
      isWritable: writable,
    });
    expect(plain.ok && plain.updater.installedApp).toBe("/Applications/OCW.app");
  });
});

describe("readSwapResult and sweepLeftovers (D-05)", () => {
  it("returns the last result once and deletes it", async () => {
    const dir = temp();
    const result = {
      outcome: "failed",
      version: "0.5.1",
      reason: "swap_failed",
      at: "2026-11-26T10:00:00.000Z",
    };
    writeFileSync(join(dir, "update-result.json"), JSON.stringify(result));
    expect(await readSwapResult(dir)).toEqual(result);
    expect(existsSync(join(dir, "update-result.json"))).toBe(false);
    expect(await readSwapResult(dir)).toBeNull();
  });

  it("records an install that did not start, for the next start's notice (no path)", async () => {
    const dir = temp();
    recordInstallFailure(dir, "0.5.1", () => Date.parse("2026-11-26T10:00:00.000Z"));
    const raw = readFileSync(join(dir, "update-result.json"), "utf8");
    expect(raw).not.toContain(dir);
    expect(statSync(join(dir, "update-result.json")).mode & 0o777).toBe(0o600);
    expect(await readSwapResult(dir)).toEqual({
      outcome: "failed",
      version: "0.5.1",
      reason: "install_failed",
      at: "2026-11-26T10:00:00.000Z",
    });
    // Never throws: a missing folder or a bad version writes nothing.
    expect(() => recordInstallFailure(join(dir, "missing"), "0.5.1")).not.toThrow();
    expect(() => recordInstallFailure(dir, "../x")).not.toThrow();
    expect(existsSync(join(dir, "update-result.json"))).toBe(false);
  });

  it.each([
    "not json",
    JSON.stringify({ outcome: "installed", version: "0.5.1", at: "2026-11-26T10:00:00.000Z", path: "/x" }),
    JSON.stringify({ outcome: "installed", version: "../x", at: "2026-11-26T10:00:00.000Z" }),
  ])("deletes a malformed result and gives null (%s)", async (raw) => {
    const dir = temp();
    writeFileSync(join(dir, "update-result.json"), raw);
    expect(await readSwapResult(dir)).toBeNull();
    expect(existsSync(join(dir, "update-result.json"))).toBe(false);
  });

  it("removes only old bundles and staging folders beside the app", async () => {
    const dir = temp();
    const names = [
      "OCW.app",
      ".OCW.app.old-1732600000000",
      ".ocw-update-0.5.1",
      ".ocw-update-x",
      ".OCW.app.old-x",
      "Other.app",
    ];
    for (const name of names) mkdirSync(join(dir, name, "Contents"), { recursive: true });
    await sweepLeftovers(dir);
    expect(readdirSync(dir).sort()).toEqual([".OCW.app.old-x", ".ocw-update-x", "OCW.app", "Other.app"]);
    // A missing folder is not an error.
    await expect(sweepLeftovers(join(dir, "missing"))).resolves.toBeUndefined();
  });

  // Review WR-04: after a failed rollback the old bundle (or the staged one) is the only copy left; without an OCW.app
  // beside them, nothing is removed.
  it("removes nothing when no OCW.app is beside the leftovers", async () => {
    const dir = temp();
    const names = [".OCW.app.old-1732600000000", ".ocw-update-0.5.1"];
    for (const name of names) mkdirSync(join(dir, name, "Contents"), { recursive: true });
    await sweepLeftovers(dir);
    expect(readdirSync(dir).sort()).toEqual(names);
  });
});
