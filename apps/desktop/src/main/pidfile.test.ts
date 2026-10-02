import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksLikeDaemon, type ReapDeps, readPidfile, reapStaleDaemon, writePidfile } from "./pidfile";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocw-pid-"));
  file = join(dir, "desktop-daemon.pid");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(alive: Set<number>, command: string | null, opts: { ignoreTerm?: boolean } = {}) {
  const kills: [number, string][] = [];
  const d: ReapDeps = {
    isAlive: (pid) => alive.has(pid),
    commandOf: async () => command,
    killGroup: (pid, sig) => {
      kills.push([pid, sig]);
      if (sig === "SIGKILL" || !opts.ignoreTerm) alive.delete(pid);
    },
    sleep: async () => {},
  };
  return { d, kills };
}

describe("pidfile reaping", () => {
  it("does nothing without a pidfile", async () => {
    expect(await reapStaleDaemon(file, deps(new Set(), null).d)).toBe("none");
  });

  it("removes a pidfile whose process is gone", async () => {
    await writePidfile(file, 4242);
    expect(await reapStaleDaemon(file, deps(new Set(), null).d)).toBe("stale-file");
    expect(existsSync(file)).toBe(false);
  });

  it("never kills a recycled pid that is not our daemon", async () => {
    await writePidfile(file, 4242);
    const { d, kills } = deps(new Set([4242]), "/Applications/Safari.app/Contents/MacOS/Safari");
    expect(await reapStaleDaemon(file, d)).toBe("not-ours");
    expect(kills).toEqual([]);
  });

  it("SIGTERMs a leftover daemon's process group", async () => {
    await writePidfile(file, 4242);
    const { d, kills } = deps(new Set([4242]), "/x/Electron /repo/apps/local-runtime/bin/ocw-runtime run");
    expect(await reapStaleDaemon(file, d)).toBe("reaped");
    expect(kills).toEqual([[4242, "SIGTERM"]]);
    expect(await readPidfile(file)).toBeNull();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    await writePidfile(file, 4242);
    const { d, kills } = deps(new Set([4242]), "node ocw-runtime run", { ignoreTerm: true });
    expect(await reapStaleDaemon(file, d, 300)).toBe("reaped");
    expect(kills).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });

  it("recognises daemon command lines", () => {
    expect(looksLikeDaemon("node /a/ocw-runtime run")).toBe(true);
    expect(looksLikeDaemon("vim")).toBe(false);
    expect(looksLikeDaemon(null)).toBe(false);
  });
});

describe("removePidfileIfOwner", () => {
  it("keeps a pidfile that belongs to a newer daemon", async () => {
    const { removePidfileIfOwner } = await import("./pidfile");
    await writePidfile(file, 2);
    await removePidfileIfOwner(file, 1);
    expect((await readPidfile(file))?.pid).toBe(2);
    await removePidfileIfOwner(file, 2);
    expect(await readPidfile(file)).toBeNull();
  });
});
