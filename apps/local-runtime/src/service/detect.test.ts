import { describe, expect, it } from "vitest";
import { type DetectDeps, detectServiceManager, SUPERVISOR_FALLBACK } from "./detect.js";
import type { ServiceExecFn } from "./exec.js";

function deps(over: Partial<DetectDeps> & { showEnvCode?: number } = {}): DetectDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: ServiceExecFn = async (file, args) => {
    calls.push([file, ...args]);
    return { code: over.showEnvCode ?? 0, stdout: "", stderr: "" };
  };
  return {
    platform: "linux",
    account: "alice",
    exists: async (p) => p === "/run/systemd/system",
    which: (n) => (n === "systemctl" ? "/usr/bin/systemctl" : null),
    exec,
    ...over,
    calls,
  };
}

describe("detectServiceManager (07.12, PD-11)", () => {
  it("finds a reachable systemd user manager", async () => {
    const d = deps();
    expect(await detectServiceManager(d)).toEqual({ kind: "systemd-user", available: true, reason: null });
    expect(d.calls).toEqual([["systemctl", "--user", "show-environment"]]);
  });

  it("says how to reach the user manager when it is not reachable (sudo -u, su)", async () => {
    const r = await detectServiceManager(deps({ showEnvCode: 1 }));
    expect(r.kind).toBe("systemd-user");
    expect(r.available).toBe(false);
    expect(r.reason).toContain("log in as alice over SSH (or machinectl shell alice@) and re-run");
  });

  it("is none without /run/systemd/system (containers, WSL without systemd)", async () => {
    const d = deps({ exists: async () => false });
    const r = await detectServiceManager(d);
    expect(r).toEqual({
      kind: "none",
      available: false,
      reason: expect.stringContaining(SUPERVISOR_FALLBACK),
    });
    expect(d.calls).toEqual([]);
  });

  it("is none when systemctl is not on PATH", async () => {
    const r = await detectServiceManager(deps({ which: () => null }));
    expect(r.kind).toBe("none");
    expect(r.reason).toContain(SUPERVISOR_FALLBACK);
  });

  it("is launchd on macOS, without running anything", async () => {
    const d = deps({ platform: "darwin" });
    expect(await detectServiceManager(d)).toEqual({ kind: "launchd", available: true, reason: null });
    expect(d.calls).toEqual([]);
  });

  it("is none on Windows", async () => {
    const r = await detectServiceManager(deps({ platform: "win32" }));
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("not supported on Windows");
  });

  it("checks only the system manager for a system unit (no user manager needed)", async () => {
    const d = deps({ showEnvCode: 1 });
    expect(await detectServiceManager(d, { system: true })).toEqual({
      kind: "systemd-system",
      available: true,
      reason: null,
    });
    expect(d.calls).toEqual([]);
  });

  it("does not offer a system unit on macOS", async () => {
    const r = await detectServiceManager(deps({ platform: "darwin" }), { system: true });
    expect(r.available).toBe(false);
    expect(r.reason).toContain("system services are Linux only; use the LaunchAgent");
  });
});
