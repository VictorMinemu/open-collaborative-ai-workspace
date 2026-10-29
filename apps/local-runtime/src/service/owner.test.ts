import { describe, expect, it } from "vitest";
import { DESKTOP_OWNS_RUNTIME, type OwnerDeps, RUNTIME_ALREADY_RUNS, runtimeOwnerConflict } from "./owner.js";

const HOME = "/home/alice/.ocw";

function deps(over: Partial<OwnerDeps> & { pidfile?: string | null; socket?: boolean } = {}) {
  const requests: Array<{ path: string; timeoutMs: number | undefined }> = [];
  const killed: number[] = [];
  const d: OwnerDeps = {
    serviceActive: false,
    readText: async (p) => (p === `${HOME}/desktop-daemon.pid` ? (over.pidfile ?? null) : null),
    controlRequest: async (path, _req, timeoutMs) => {
      requests.push({ path, timeoutMs });
      if (over.socket) return { ok: true, result: { paired: true, sessions: [] } };
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    },
    kill: (pid) => {
      killed.push(pid);
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
    ...over,
  };
  return { d, requests, killed };
}

const pidfile = (pid: number) => JSON.stringify({ pid, startedAt: "2026-10-29T10:00:00.000Z" });

describe("runtimeOwnerConflict: one runtime per ~/.ocw (07.12, D-14, PD-15, RESEARCH Pitfall 6)", () => {
  it("is none with no socket and no pidfile, probing the socket with a 2 s limit", async () => {
    const { d, requests } = deps();
    expect(await runtimeOwnerConflict(HOME, d)).toEqual({ kind: "none" });
    expect(requests).toEqual([{ path: `${HOME}/runtime.sock`, timeoutMs: 2_000 }]);
  });

  it("is socket when a runtime answers and this service is not the active unit", async () => {
    const { d } = deps({ socket: true });
    expect(await runtimeOwnerConflict(HOME, d)).toEqual({ kind: "socket", message: RUNTIME_ALREADY_RUNS });
    expect(RUNTIME_ALREADY_RUNS).toBe(
      "a runtime already runs on this account (the desktop app or a hand-started `ocw-runtime run`); stop it, then re-run",
    );
  });

  it("is none when the answering runtime is this service, active", async () => {
    const { d } = deps({ socket: true, serviceActive: true });
    expect(await runtimeOwnerConflict(HOME, d)).toEqual({ kind: "none" });
  });

  it("is desktop when the desktop app's pidfile names a live process", async () => {
    const { d, killed } = deps({ pidfile: pidfile(4321), kill: () => undefined });
    expect(await runtimeOwnerConflict(HOME, d)).toEqual({ kind: "desktop", message: DESKTOP_OWNS_RUNTIME });
    expect(DESKTOP_OWNS_RUNTIME).toBe(
      "the desktop app supervises the runtime on this account; use the desktop app or the service, not both",
    );
    expect(killed).toEqual([]);
  });

  it("is desktop even while the service is active (the desktop's own daemon)", async () => {
    const { d } = deps({ pidfile: pidfile(4321), kill: () => undefined, socket: true, serviceActive: true });
    expect((await runtimeOwnerConflict(HOME, d)).kind).toBe("desktop");
  });

  it("counts a process of another user (EPERM) as live", async () => {
    const { d } = deps({
      pidfile: pidfile(4321),
      kill: () => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    });
    expect((await runtimeOwnerConflict(HOME, d)).kind).toBe("desktop");
  });

  it("ignores a stale pidfile (ESRCH) and an invalid one", async () => {
    const stale = deps({ pidfile: pidfile(4321) });
    expect(await runtimeOwnerConflict(HOME, stale.d)).toEqual({ kind: "none" });
    expect(stale.killed).toEqual([4321]);
    for (const text of [
      "not json",
      JSON.stringify({ pid: -1, startedAt: "x" }),
      JSON.stringify({ pid: "1" }),
    ]) {
      const bad = deps({ pidfile: text, kill: () => undefined });
      expect(await runtimeOwnerConflict(HOME, bad.d)).toEqual({ kind: "none" });
    }
  });

  it("treats a socket that answers not-ok as a runtime that answers", async () => {
    const { d } = deps({ controlRequest: async () => ({ ok: false, error: "invalid request" }) });
    expect((await runtimeOwnerConflict(HOME, d)).kind).toBe("socket");
  });
});
