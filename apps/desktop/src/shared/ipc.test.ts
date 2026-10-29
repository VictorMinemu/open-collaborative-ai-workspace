import { describe, expect, it, vi } from "vitest";
import { Channels } from "./channels";
import {
  AddProjectArgs,
  ChatgptLoopbackAwaitArgs,
  ChatgptLoopbackCancelArgs,
  CheckServerArgs,
  DaemonStatusPayload,
  EnrollArgs,
  FinishArgs,
  NoArgs,
  parseArgs,
  SetBadgeCountArgs,
  toPublicProject,
} from "./ipc";
import { deriveStatus } from "./status";

describe("IPC argument validation", () => {
  it("addProject accepts nothing or a bounded name, and nothing else", () => {
    expect(parseArgs(AddProjectArgs, undefined)).toBeUndefined();
    expect(parseArgs(AddProjectArgs, { name: " demo " })).toEqual({ name: "demo" });
    expect(() => parseArgs(AddProjectArgs, { path: "/etc" })).toThrow("invalid arguments");
    expect(() => parseArgs(AddProjectArgs, { name: "x".repeat(81) })).toThrow();
    expect(() => parseArgs(AddProjectArgs, "/Users/me/repo")).toThrow();
  });

  it("no-arg channels reject payloads", () => {
    expect(parseArgs(NoArgs, undefined)).toBeUndefined();
    expect(() => parseArgs(NoArgs, { cmd: "removeProject" })).toThrow();
  });

  it("enroll validates the pairing code shape and rejects extra keys", () => {
    const ok = {
      webUrl: "http://localhost:3000",
      apiUrl: "http://localhost:4000",
      code: "ab12-cd34",
      deviceName: "Mac",
    };
    expect(parseArgs(EnrollArgs, ok).code).toBe("ab12-cd34");
    expect(() => parseArgs(EnrollArgs, { ...ok, code: "../../etc" })).toThrow(/letters, digits and dashes/);
    expect(() => parseArgs(EnrollArgs, { ...ok, code: "a" })).toThrow();
    expect(() => parseArgs(EnrollArgs, { ...ok, token: "x" })).toThrow();
    expect(() => parseArgs(EnrollArgs, { ...ok, deviceName: "" })).toThrow();
  });

  it("check-server and finish are strict", () => {
    expect(parseArgs(CheckServerArgs, { webUrl: "localhost:3000" })).toEqual({ webUrl: "localhost:3000" });
    expect(() => parseArgs(CheckServerArgs, { webUrl: 42 })).toThrow();
    expect(parseArgs(FinishArgs, { skipPairing: true })).toEqual({ skipPairing: true });
    expect(() => parseArgs(FinishArgs, {})).toThrow();
  });
});

describe("setBadgeCount (CHAT-10, T-04-11-01)", () => {
  it("accepts an integer from 0 to 9999 and nothing else", () => {
    for (const n of [0, 7, 9999]) expect(parseArgs(SetBadgeCountArgs, n)).toBe(n);
    for (const bad of [-1, 10000, 1.5, "3", { count: 3 }, null, undefined, Number.NaN]) {
      expect(() => parseArgs(SetBadgeCountArgs, bad)).toThrow();
    }
  });

  it("errors never echo the payload", () => {
    const secret = "/Users/someone/secret-token-123";
    try {
      parseArgs(SetBadgeCountArgs, secret);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("invalid arguments");
      expect((err as Error).message).not.toContain("secret");
    }
  });
});

describe("toPublicProject", () => {
  it("drops the absolute path and redacts remote credentials", () => {
    const p = toPublicProject({
      localId: "lp_1",
      path: "/Users/victor/code/repo",
      name: "repo",
      gitRemote: "https://victor:ghp_x@github.com/o/repo.git",
      defaultBranch: "main",
      addedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(p).not.toHaveProperty("path");
    expect(JSON.stringify(p)).not.toContain("/Users/");
    expect(p.gitRemote).toBe("https://github.com/o/repo.git");
  });
});

describe("deriveStatus", () => {
  const report = {
    paired: true,
    connected: true,
    deviceName: "Mac",
    projects: 2,
    runtimes: [],
    sessions: [{}],
  };
  it("maps inputs to the tray states", () => {
    expect(deriveStatus({ paused: true, paired: true, daemon: "stopped", report: null }).state).toBe(
      "paused",
    );
    expect(deriveStatus({ paused: false, paired: false, daemon: "running", report: null }).state).toBe(
      "needs_pairing",
    );
    expect(deriveStatus({ paused: false, paired: true, daemon: "running", report }).state).toBe("online");
    expect(
      deriveStatus({
        paused: false,
        paired: true,
        daemon: "running",
        report: { ...report, connected: false },
      }).state,
    ).toBe("connecting");
    expect(deriveStatus({ paused: false, paired: true, daemon: "restarting", report: null }).state).toBe(
      "offline",
    );
  });
  it("trusts an external daemon that reports itself paired", () => {
    const s = deriveStatus({ paused: false, paired: false, daemon: "external", report });
    expect(s.state).toBe("online");
    expect(s.projects).toBe(2);
    expect(s.activeSessions).toBe(1);
  });
});

describe("Full access opt-in is read-only outside the main process (ADR-0012, P-12)", () => {
  const report = {
    paired: true,
    connected: true,
    deviceName: "Mac",
    projects: 0,
    runtimes: [],
    sessions: [],
  };

  it("DaemonStatusPayload accepts the daemon's opt-in and its source", () => {
    expect(
      DaemonStatusPayload.parse({ ...report, fullAccessOptIn: true, fullAccessSource: "env" }),
    ).toMatchObject({ fullAccessOptIn: true, fullAccessSource: "env" });
    expect(DaemonStatusPayload.parse(report).fullAccessOptIn).toBeUndefined();
  });

  it("deriveStatus passes it into DesktopStatus (false when absent)", () => {
    const base = { paused: false, paired: true, daemon: "running" as const };
    expect(deriveStatus({ ...base, report: { ...report, fullAccessOptIn: true } }).fullAccessOptIn).toBe(
      true,
    );
    expect(deriveStatus({ ...base, report }).fullAccessOptIn).toBe(false);
    expect(deriveStatus({ ...base, report: null }).fullAccessOptIn).toBe(false);
    // The daemon is down: what the main process last read from runtime.json.
    expect(deriveStatus({ ...base, report: null, localFullAccess: true }).fullAccessOptIn).toBe(true);
  });

  it("the web origin's preload API has no Full access setter: only the badge count (04-11) and the ChatGPT loopback (05-07) were added", async () => {
    let exposed: Record<string, unknown> | null = null;
    const invoke = vi.fn(async () => undefined);
    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
          exposed = api;
        },
      },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }));
    vi.resetModules();
    await import("../preload/main");
    vi.doUnmock("electron");
    expect(Object.keys(exposed ?? {}).sort()).toEqual([
      "addProject",
      "chatgptLoopbackAwait",
      "chatgptLoopbackCancel",
      "chatgptLoopbackPrepare",
      "isDesktop",
      "listProjects",
      "onStatus",
      "platform",
      "setBadgeCount",
      "status",
    ]);
    // setBadgeCount forwards only a whole number on its own channel; anything else never reaches IPC.
    const setBadgeCount = (exposed as unknown as { setBadgeCount(n: unknown): Promise<unknown> })
      .setBadgeCount;
    await setBadgeCount(3);
    expect(invoke).toHaveBeenLastCalledWith("ocw:set-badge-count", 3);
    invoke.mockClear();
    await setBadgeCount("3");
    await setBadgeCount(1.5);
    await setBadgeCount({ n: 1 });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("ChatGPT loopback sign-in channels (05-07, T-05-07-04)", () => {
  const token = `${"a".repeat(20)}B-_${"9".repeat(20)}`;

  it("three channels exist under ocw:chatgpt-loopback-*", () => {
    expect(Channels.chatgptLoopbackPrepare).toBe("ocw:chatgpt-loopback-prepare");
    expect(Channels.chatgptLoopbackAwait).toBe("ocw:chatgpt-loopback-await");
    expect(Channels.chatgptLoopbackCancel).toBe("ocw:chatgpt-loopback-cancel");
  });

  it("prepare takes no arguments", () => {
    expect(parseArgs(NoArgs, undefined)).toBeUndefined();
    expect(() => parseArgs(NoArgs, { port: 80 })).toThrow();
  });

  it("await takes a flow token and an authorize URL of at most 2048 characters, nothing else", () => {
    const ok = { flowToken: token, authorizeUrl: "https://auth.openai.com/oauth/authorize?x=1" };
    expect(parseArgs(ChatgptLoopbackAwaitArgs, ok)).toEqual(ok);
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, extra: 1 })).toThrow("invalid arguments");
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, flowToken: "short" })).toThrow();
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, flowToken: `${token}!` })).toThrow();
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, flowToken: "../".repeat(15) })).toThrow();
    expect(() =>
      parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, authorizeUrl: `https://a.b/${"x".repeat(2048)}` }),
    ).toThrow();
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, { ...ok, authorizeUrl: "" })).toThrow();
    expect(() => parseArgs(ChatgptLoopbackAwaitArgs, ok.authorizeUrl)).toThrow();
  });

  it("cancel takes a flow token only", () => {
    expect(parseArgs(ChatgptLoopbackCancelArgs, { flowToken: token })).toEqual({ flowToken: token });
    expect(() => parseArgs(ChatgptLoopbackCancelArgs, { flowToken: token, port: 1455 })).toThrow();
    expect(() => parseArgs(ChatgptLoopbackCancelArgs, token)).toThrow();
    expect(() => parseArgs(ChatgptLoopbackCancelArgs, undefined)).toThrow();
  });

  it("the preload forwards only well-typed values on the three channels", async () => {
    let exposed: Record<string, (...a: unknown[]) => Promise<unknown>> | null = null;
    const invoke = vi.fn(async () => undefined);
    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, api: Record<string, (...a: unknown[]) => Promise<unknown>>) => {
          exposed = api;
        },
      },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }));
    vi.resetModules();
    await import("../preload/main");
    vi.doUnmock("electron");
    const api = exposed as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await api.chatgptLoopbackPrepare?.();
    expect(invoke).toHaveBeenLastCalledWith("ocw:chatgpt-loopback-prepare");
    await api.chatgptLoopbackAwait?.(token, "https://auth.openai.com/x");
    expect(invoke).toHaveBeenLastCalledWith("ocw:chatgpt-loopback-await", {
      flowToken: token,
      authorizeUrl: "https://auth.openai.com/x",
    });
    await api.chatgptLoopbackCancel?.(token);
    expect(invoke).toHaveBeenLastCalledWith("ocw:chatgpt-loopback-cancel", { flowToken: token });
    invoke.mockClear();
    await expect(api.chatgptLoopbackAwait?.({ flowToken: token }, 1)).rejects.toThrow();
    await api.chatgptLoopbackCancel?.(42);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("DaemonStatusPayload.runtimeUpdates (07.11, D-09)", () => {
  const base = { paired: true, connected: true };
  // The daemon's own status().runtimeUpdates, as 07.11-07 sends it (every status field, not only the menu's subset).
  const fromDaemon = {
    localLevel: "notify",
    localLevelSource: "config",
    effectiveLevel: "notify",
    orgLevelReceived: true,
    runtimes: [
      {
        runtime: "claude-code",
        installedVersion: "2.1.307",
        method: "native",
        location: "~/.local/bin",
        canUpdate: true,
        reason: null,
        updateCommand: "claude update",
        channel: "latest",
        latestVersion: "2.1.312",
        advisory: "behind",
        installedCompatibility: "supported",
        candidateCompatibility: "supported",
        state: "pending",
        pendingSince: "2026-10-28T10:00:00.000Z",
        stale: false,
        lastRun: { outcome: "failed", trigger: "automatic", fromVersion: "2.1.300", toVersion: null },
        checkedAt: "2026-10-28T10:00:00.000Z",
      },
    ],
  };

  it("parses the daemon's block, keeping the subset the menu uses", () => {
    const parsed = DaemonStatusPayload.parse({ ...base, runtimeUpdates: fromDaemon });
    expect(parsed.runtimeUpdates).toMatchObject({
      localLevel: "notify",
      localLevelSource: "config",
      effectiveLevel: "notify",
      orgLevelReceived: true,
    });
    expect(parsed.runtimeUpdates?.runtimes?.[0]).toEqual({
      runtime: "claude-code",
      installedVersion: "2.1.307",
      latestVersion: "2.1.312",
      advisory: "behind",
      state: "pending",
      lastRun: { outcome: "failed" },
      reason: null,
    });
  });

  it("an older daemon without it still parses; a block this app cannot read never breaks the status", () => {
    expect(DaemonStatusPayload.parse(base).runtimeUpdates).toBeUndefined();
    for (const odd of ["weird", { localLevel: "sometimes" }, { runtimes: [{ installedVersion: 3 }] }]) {
      const parsed = DaemonStatusPayload.safeParse({ ...base, runtimeUpdates: odd });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.runtimeUpdates).toBeUndefined();
    }
  });

  it("stays in the main process: DesktopStatus (what web content sees) has no runtime updates", () => {
    const report = DaemonStatusPayload.parse({ ...base, runtimeUpdates: fromDaemon });
    const s = deriveStatus({ paused: false, paired: true, daemon: "running", report });
    expect(Object.keys(s)).not.toContain("runtimeUpdates");
  });
});
