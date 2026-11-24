import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerProcess } from "../codex/codex-runtime.js";
import {
  CODEX_LOGIN_TIMEOUT_MS,
  CodexLoginError,
  logoutCodex,
  readCodexAccount,
  runCodexDeviceLogin,
} from "./codex-login.js";

type Msg = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** In-memory `codex app-server` for the account methods, scripted per test. */
class FakeAccountServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Msg[] = [];
  killed: string[] = [];
  /** How `account/login/start` answers. */
  loginStart: "ok" | "unsupported" | "other_type" = "ok";
  /** What `account/read` answers. */
  account: unknown = {
    account: { type: "chatgpt", email: "ana@example.com", planType: "plus", workspaceName: null },
    userId: "u1",
    requiresOpenaiAuth: true,
  };
  /** Completion sent right after the login/start answer (null = the test sends it). */
  autoComplete: { success: boolean; error: string | null } | null = null;
  private exited = false;

  constructor(
    readonly cwd: string,
    readonly env: Record<string, string | undefined>,
  ) {
    super();
    let buf = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (c: string) => {
      buf += c;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) this.handle(JSON.parse(line) as Msg);
        i = buf.indexOf("\n");
      }
    });
  }

  send(m: Msg): void {
    this.stdout.write(`${JSON.stringify(m)}\n`);
  }

  complete(success: boolean, error: string | null = null): void {
    this.send({ method: "account/login/completed", params: { loginId: "login-1", success, error } });
  }

  methods(): string[] {
    return this.received.flatMap((m) => (m.method ? [m.method] : []));
  }

  private handle(m: Msg): void {
    this.received.push(m);
    if (m.id === undefined) return;
    switch (m.method) {
      case "initialize":
        this.send({ id: m.id, result: { userAgent: "codex/0.172.0" } });
        return;
      case "account/login/start":
        if (this.loginStart === "unsupported") {
          this.send({
            id: m.id,
            error: { code: -32600, message: "Invalid request: unknown variant `chatgptDeviceCode`" },
          });
          return;
        }
        this.send({
          id: m.id,
          result:
            this.loginStart === "other_type"
              ? { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/x" }
              : {
                  type: "chatgptDeviceCode",
                  loginId: "login-1",
                  verificationUrl: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-1234",
                },
        });
        if (this.autoComplete) this.complete(this.autoComplete.success, this.autoComplete.error);
        return;
      case "account/login/cancel":
        this.send({ id: m.id, result: { status: "canceled" } });
        return;
      case "account/read":
        this.send({ id: m.id, result: this.account });
        return;
      case "account/logout":
        this.send({ id: m.id, result: {} });
        return;
      default:
        this.send({ id: m.id, error: { code: -32601, message: "method not found" } });
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    setImmediate(() => this.emit("exit", 0));
  }
}

const HOME = "/scratch/ocw/accounts/codex/11111111-2222-4333-8444-555555555555";

function fakeSpawn(configure: (s: FakeAccountServer) => void = () => undefined) {
  const servers: FakeAccountServer[] = [];
  const spawn = vi.fn((opts: { cwd: string; env: Record<string, string | undefined> }) => {
    const s = new FakeAccountServer(opts.cwd, opts.env);
    configure(s);
    servers.push(s);
    return s;
  });
  return { spawn, servers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runCodexDeviceLogin (07.18 D-02, PD-10, A-08)", () => {
  it("initializes, starts a device-code login under the slot's CODEX_HOME, hands over the code, then reads the plan", async () => {
    const { spawn, servers } = fakeSpawn((s) => {
      s.autoComplete = { success: true, error: null };
    });
    const codes: unknown[] = [];
    const now = Date.parse("2026-11-24T10:00:00.000Z");
    const out = await runCodexDeviceLogin({
      spawn,
      home: HOME,
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-x", OCW_HOME: "/x", CODEX_HOME: "/elsewhere" },
      onCode: (c) => codes.push(c),
      now: () => now,
    });
    expect(out).toEqual({ planType: "plus" });
    // No e-mail in what the caller gets.
    expect(JSON.stringify(out)).not.toContain("ana@example.com");
    expect(codes).toEqual([
      {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: new Date(now + CODEX_LOGIN_TIMEOUT_MS).toISOString(),
      },
    ]);
    const s = servers[0];
    if (!s) throw new Error("no app-server");
    expect(s.cwd).toBe(HOME);
    expect(s.env.CODEX_HOME).toBe(HOME);
    expect(s.env.PATH).toBe("/usr/bin");
    expect(s.env.OPENAI_API_KEY).toBeUndefined();
    expect(s.env.OCW_HOME).toBeUndefined();
    expect(s.methods()).toEqual(["initialize", "initialized", "account/login/start", "account/read"]);
    expect(s.received.find((m) => m.method === "account/login/start")?.params).toEqual({
      type: "chatgptDeviceCode",
    });
    expect(s.killed.length).toBeGreaterThan(0);
  });

  it("a declined sign-in rejects denied; an expired one expired; anything else failed (always stopped)", async () => {
    for (const [error, code] of [
      ["access_denied: the user declined", "denied"],
      ["device code expired", "expired"],
      ["something broke", "failed"],
    ] as const) {
      const { spawn, servers } = fakeSpawn((s) => {
        s.autoComplete = { success: false, error };
      });
      const err = await runCodexDeviceLogin({ spawn, home: HOME, onCode: () => undefined }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CodexLoginError);
      expect((err as CodexLoginError).code).toBe(code);
      expect(servers[0]?.killed.length).toBeGreaterThan(0);
      expect(servers[0]?.methods()).not.toContain("account/read");
    }
  });

  it("an app-server without the chatgptDeviceCode variant rejects unsupported (A-08)", async () => {
    for (const variant of ["unsupported", "other_type"] as const) {
      const { spawn, servers } = fakeSpawn((s) => {
        s.loginStart = variant;
      });
      const onCode = vi.fn();
      const err = await runCodexDeviceLogin({ spawn, home: HOME, onCode }).catch((e: unknown) => e);
      expect((err as CodexLoginError).code).toBe("unsupported");
      expect((err as CodexLoginError).message).toBe("Update Codex on this device and try again");
      expect(onCode).not.toHaveBeenCalled();
      expect(servers[0]?.killed.length).toBeGreaterThan(0);
    }
  });

  it("an abort sends account/login/cancel and rejects cancelled", async () => {
    const { spawn, servers } = fakeSpawn();
    const controller = new AbortController();
    const done = runCodexDeviceLogin({
      spawn,
      home: HOME,
      signal: controller.signal,
      onCode: () => controller.abort(),
    }).catch((e: unknown) => e);
    const err = await done;
    expect((err as CodexLoginError).code).toBe("cancelled");
    const s = servers[0];
    expect(s?.methods()).toContain("account/login/cancel");
    expect(s?.received.find((m) => m.method === "account/login/cancel")?.params).toEqual({ loginId: "login-1" });
    expect(s?.killed.length).toBeGreaterThan(0);
  });

  it("a login that never completes ends expired after the bound, cancelled at Codex", async () => {
    const { spawn, servers } = fakeSpawn();
    const err = await runCodexDeviceLogin({
      spawn,
      home: HOME,
      timeoutMs: 50,
      onCode: () => undefined,
    }).catch((e: unknown) => e);
    expect((err as CodexLoginError).code).toBe("expired");
    expect(servers[0]?.methods()).toContain("account/login/cancel");
  });

  it("an app-server that exits mid-login rejects failed", async () => {
    const { spawn, servers } = fakeSpawn();
    const err = await runCodexDeviceLogin({
      spawn,
      home: HOME,
      onCode: () => servers[0]?.kill("SIGTERM"),
    }).catch((e: unknown) => e);
    expect((err as CodexLoginError).code).toBe("failed");
    expect((err as CodexLoginError).message).toBe("Codex stopped before the sign-in finished");
  });

  it("a spawn that throws (no Codex here) rejects unsupported", async () => {
    const err = await runCodexDeviceLogin({
      spawn: () => {
        throw new Error("codex CLI not found on PATH");
      },
      home: HOME,
      onCode: () => undefined,
    }).catch((e: unknown) => e);
    expect((err as CodexLoginError).code).toBe("unsupported");
  });

});

describe("readCodexAccount / logoutCodex", () => {
  it("readCodexAccount answers signed in and the plan, never the e-mail", async () => {
    const { spawn, servers } = fakeSpawn();
    const out = await readCodexAccount({ spawn, home: HOME });
    expect(out).toEqual({ signedIn: true, planType: "plus" });
    expect(JSON.stringify(out)).not.toContain("@");
    expect(servers[0]?.env.CODEX_HOME).toBe(HOME);
    expect(servers[0]?.killed.length).toBeGreaterThan(0);
  });

  it("readCodexAccount answers not signed in when Codex has no ChatGPT account", async () => {
    const { spawn } = fakeSpawn((s) => {
      s.account = { account: null, userId: null, requiresOpenaiAuth: true };
    });
    expect(await readCodexAccount({ spawn, home: HOME })).toEqual({ signedIn: false, planType: null });
  });

  it("logoutCodex calls account/logout under the slot", async () => {
    const { spawn, servers } = fakeSpawn();
    await logoutCodex({ spawn, home: HOME });
    expect(servers[0]?.methods()).toEqual(["initialize", "initialized", "account/logout"]);
    expect(servers[0]?.env.CODEX_HOME).toBe(HOME);
    expect(servers[0]?.killed.length).toBeGreaterThan(0);
  });
});
