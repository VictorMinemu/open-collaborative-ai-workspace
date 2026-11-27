import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename as realRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HelperArgs, isProcessAlive, parseHelperArgs, runSwap, SwapResult } from "./mac-swap";

/**
 * 07.13.1 (D-05): the detached helper that swaps the macOS bundle once the app and its daemon have exited. Two renames
 * on one volume, the old bundle back if the second fails, a path-free result for the next start, and a relaunch with
 * `open` only when asked. Real temp folders; liveness, sleep, `open` and the clock are injected except in the one case
 * that proves the real liveness check with no daemon.
 */

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocw-mac-swap-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const AT = 1_732_600_000_000;

/** A parent folder with an installed `OCW.app` ("old") and a staged one ("new"), plus a user data folder. */
function layout(version = "0.5.1") {
  const dir = temp();
  const parent = join(dir, "Applications");
  const installedApp = join(parent, "OCW.app");
  const stagingDir = join(parent, `.ocw-update-${version}`);
  const stagedApp = join(stagingDir, "OCW.app");
  const userData = join(dir, "userData");
  mkdirSync(installedApp, { recursive: true });
  mkdirSync(stagedApp, { recursive: true });
  mkdirSync(userData);
  writeFileSync(join(installedApp, "marker"), "old");
  writeFileSync(join(stagedApp, "marker"), "new");
  writeFileSync(join(stagingDir, "swap-helper.cjs"), "// helper");
  return {
    dir,
    parent,
    installedApp,
    stagingDir,
    stagedApp,
    resultFile: join(userData, "update-result.json"),
  };
}

function argv(l: ReturnType<typeof layout>, over: Partial<Record<number, string>> = {}): string[] {
  const base = ["101", "202", l.installedApp, l.stagedApp, l.resultFile, "0.5.1", "1"];
  return base.map((v, i) => over[i] ?? v);
}

function deps(over: { alive?: (pid: number) => boolean; failRenames?: number[] } = {}) {
  const renames: [string, string][] = [];
  let n = 0;
  const d = {
    isAlive: vi.fn(over.alive ?? (() => false)),
    sleep: vi.fn(async (_ms: number) => undefined),
    openApp: vi.fn((_path: string) => undefined),
    now: () => AT,
    rename: vi.fn(async (from: string, to: string) => {
      n += 1;
      renames.push([from, to]);
      if (over.failRenames?.includes(n)) throw new Error(`EXDEV: cross-device link not permitted, ${from}`);
      await realRename(from, to);
    }),
  };
  return { d, renames };
}

function result(file: string) {
  return SwapResult.parse(JSON.parse(readFileSync(file, "utf8")));
}

describe("parseHelperArgs (D-05)", () => {
  it("accepts the app's argv and reads a daemon pid of 0 as no daemon", () => {
    const l = layout();
    expect(parseHelperArgs(argv(l))).toEqual({
      appPid: 101,
      daemonPid: 202,
      installedApp: l.installedApp,
      stagedApp: l.stagedApp,
      resultFile: l.resultFile,
      version: "0.5.1",
      relaunch: true,
    } satisfies HelperArgs);
    expect(parseHelperArgs(argv(l, { 1: "0", 6: "0" }))).toMatchObject({ daemonPid: null, relaunch: false });
  });

  it.each([
    ["a non-numeric app pid", { 0: "abc" }],
    ["a negative app pid", { 0: "-5" }],
    ["an app pid of 0", { 0: "0" }],
    ["a non-numeric daemon pid", { 1: "4242x" }],
    ["a negative daemon pid", { 1: "-1" }],
    ["a relative installed app", { 2: "Applications/OCW.app" }],
    ["an installed app with another name", { 2: "/Applications/Other.app" }],
    ["a staged app elsewhere", { 3: "/tmp/.ocw-update-0.5.1/OCW.app" }],
    ["a result file with another name", { 4: "/tmp/other.json" }],
    ["a relative result file", { 4: "update-result.json" }],
    ["a pre-release version", { 5: "0.5.1-rc.1" }],
    ["a traversal version", { 5: "../x" }],
    ["a relaunch flag other than 0/1", { 6: "yes" }],
  ])("refuses %s", (_name, over) => {
    const l = layout();
    expect(() => parseHelperArgs(argv(l, over))).toThrow("invalid swap helper arguments");
  });

  it("refuses a missing or extra argument", () => {
    const l = layout();
    expect(() => parseHelperArgs(argv(l).slice(0, 6))).toThrow();
    expect(() => parseHelperArgs([...argv(l), "x"])).toThrow();
  });
});

describe("runSwap (D-05)", () => {
  it("swaps by two renames, removes the old bundle and the staging folder, writes the result and relaunches", async () => {
    const l = layout();
    const { d, renames } = deps();
    const out = await runSwap(parseHelperArgs(argv(l)), d);
    const old = join(l.parent, `.OCW.app.old-${AT}`);
    expect(renames.slice(0, 2)).toEqual([
      [l.installedApp, old],
      [l.stagedApp, l.installedApp],
    ]);
    // The result goes through a temp file and a rename.
    expect(renames[2]?.[1]).toBe(l.resultFile);
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("new");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(l.stagingDir)).toBe(false);
    expect(readdirSync(l.parent)).toEqual(["OCW.app"]);
    const expected = { outcome: "installed", version: "0.5.1", at: new Date(AT).toISOString() };
    expect(out).toEqual(expected);
    expect(result(l.resultFile)).toEqual(expected);
    const raw = readFileSync(l.resultFile, "utf8");
    expect(raw).not.toContain(l.dir);
    expect(raw).not.toContain("/");
    expect(statSync(l.resultFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(l.dir, "userData"))).toEqual(["update-result.json"]);
    expect(d.openApp).toHaveBeenCalledTimes(1);
    expect(d.openApp).toHaveBeenCalledWith(l.installedApp);
    // Both pids were waited for.
    expect(d.isAlive.mock.calls.map(([pid]) => pid)).toEqual([101, 202]);
  });

  it("does not relaunch when not asked", async () => {
    const l = layout();
    const { d } = deps();
    await runSwap(parseHelperArgs(argv(l, { 6: "0" })), d);
    expect(d.openApp).not.toHaveBeenCalled();
    expect(result(l.resultFile).outcome).toBe("installed");
  });

  it("puts the original bundle back when the second rename fails (rollback)", async () => {
    const l = layout();
    const { d } = deps({ failRenames: [2] });
    const out = await runSwap(parseHelperArgs(argv(l)), d);
    expect(out).toEqual({
      outcome: "failed",
      version: "0.5.1",
      reason: "swap_failed",
      at: new Date(AT).toISOString(),
    });
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("old");
    expect(existsSync(join(l.parent, `.OCW.app.old-${AT}`))).toBe(false);
    expect(result(l.resultFile)).toEqual(out);
    expect(readFileSync(l.resultFile, "utf8")).not.toContain(l.dir);
    expect(d.openApp).toHaveBeenCalledWith(l.installedApp);
  });

  // Review WR-04: with no OCW.app left, the old bundle (now hidden under its dot name) is the only working copy; it is
  // opened where it is, so the person keeps an app and reads the one-time notice, relaunch asked or not.
  it.each(["1", "0"])(
    "reports rollback_failed and opens the old bundle where it now is (relaunch %s)",
    async (relaunch) => {
      const l = layout();
      const { d } = deps({ failRenames: [2, 3] });
      const out = await runSwap(parseHelperArgs(argv(l, { 6: relaunch })), d);
      expect(out).toMatchObject({ outcome: "failed", reason: "rollback_failed" });
      expect(result(l.resultFile)).toEqual(out);
      const old = join(l.parent, `.OCW.app.old-${AT}`);
      expect(readFileSync(join(old, "marker"), "utf8")).toBe("old");
      expect(d.openApp).toHaveBeenCalledTimes(1);
      expect(d.openApp).toHaveBeenCalledWith(old);
    },
  );

  it("reports swap_failed and leaves everything when the first rename fails", async () => {
    const l = layout();
    const { d } = deps({ failRenames: [1] });
    const out = await runSwap(parseHelperArgs(argv(l)), d);
    expect(out).toMatchObject({ outcome: "failed", reason: "swap_failed" });
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("old");
    expect(d.openApp).toHaveBeenCalledWith(l.installedApp);
  });

  it("renames nothing while the app is still running after the bound", async () => {
    const l = layout();
    const { d } = deps({ alive: (pid) => pid === 101 });
    const out = await runSwap(parseHelperArgs(argv(l)), d);
    expect(out).toMatchObject({ outcome: "failed", reason: "app_still_running" });
    expect(d.rename.mock.calls.filter(([, to]) => to !== l.resultFile)).toEqual([]);
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("old");
    // 200-ms polls, 60 s for the app.
    expect(d.sleep).toHaveBeenCalledWith(200);
    expect(d.sleep).toHaveBeenCalledTimes(300);
    expect(d.openApp).not.toHaveBeenCalled();
  });

  it("renames nothing while the daemon is still running after its bound", async () => {
    const l = layout();
    const { d } = deps({ alive: (pid) => pid === 202 });
    const out = await runSwap(parseHelperArgs(argv(l)), d);
    expect(out).toMatchObject({ outcome: "failed", reason: "app_still_running" });
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("old");
    // 30 s for the daemon.
    expect(d.sleep).toHaveBeenCalledTimes(150);
  });

  it("with daemonPid 0 waits only for the app's pid, never for 0", async () => {
    const l = layout();
    const { d } = deps();
    const out = await runSwap(parseHelperArgs(argv(l, { 1: "0" })), d);
    expect(out.outcome).toBe("installed");
    expect(d.isAlive.mock.calls.map(([pid]) => pid)).toEqual([101]);
  });

  it("swaps with the real liveness check, an exited app and daemonPid 0 (process.kill(0, 0) regression)", async () => {
    const l = layout();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    expect(pid).toBeGreaterThan(0);
    const openApp = vi.fn((_path: string) => undefined);
    const out = await runSwap(parseHelperArgs(argv(l, { 0: String(pid), 1: "0", 6: "0" })), { openApp });
    expect(out.outcome).toBe("installed");
    expect(readFileSync(join(l.installedApp, "marker"), "utf8")).toBe("new");
    expect(openApp).not.toHaveBeenCalled();
  });
});

describe("isProcessAlive (D-05)", () => {
  it("is false for any pid ≤ 0 without signalling a process group", () => {
    const kill = vi.spyOn(process, "kill");
    for (const pid of [0, -1, -4242, Number.NaN, 1.5]) expect(isProcessAlive(pid)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("is true for this process and false for an exited one", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isProcessAlive(pid)).toBe(false);
  });
});
