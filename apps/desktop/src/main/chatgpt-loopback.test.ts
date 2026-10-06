import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeChatgptLoopbackAddress,
  awaitChatgptCallback,
  CHATGPT_LOOPBACK_PORT,
  CHATGPT_LOOPBACK_TIMEOUT_MS,
  cancelChatgptLoopback,
  prepareChatgptLoopback,
} from "./chatgpt-loopback";

/**
 * The desktop's one-shot "Sign in with ChatGPT" callback listener (05-07, D-02, ADR-0017): 127.0.0.1 only, one GET
 * /auth/callback, then closed; 5-minute timeout; the code never reaches a log. It hands back a clean loopback URL with
 * the OAuth parameters only (never a header or cookie the browser sent).
 */

const AUTHORIZE = "https://auth.openai.com/oauth/authorize?client_id=x&state=s";

/** A port is free when we can bind it ourselves (on 127.0.0.1, where the listener binds). */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function occupy(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

const closeServer = (s: Server | null) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareChatgptLoopback", () => {
  it("binds 127.0.0.1 on 1455 when it is free, never 0.0.0.0 or ::", async () => {
    // Another process on this machine (a real ChatGPT/Codex sign-in) may hold 1455: then the fallback is covered below.
    const free = await portIsFree(CHATGPT_LOOPBACK_PORT);
    const { flowToken, port } = await prepareChatgptLoopback();
    try {
      expect(flowToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      if (free) expect(port).toBe(CHATGPT_LOOPBACK_PORT);
      const addr = activeChatgptLoopbackAddress();
      expect(addr).toEqual({ address: "127.0.0.1", family: "IPv4", port });
      expect(addr?.address).not.toBe("0.0.0.0");
      expect(addr?.address).not.toBe("::");
    } finally {
      cancelChatgptLoopback(flowToken);
    }
    expect(await portIsFree(port)).toBe(true);
  });

  it("uses another port on 127.0.0.1 when 1455 is taken", async () => {
    const blocker = await occupy(CHATGPT_LOOPBACK_PORT);
    try {
      const { flowToken, port } = await prepareChatgptLoopback();
      expect(port).not.toBe(CHATGPT_LOOPBACK_PORT);
      expect(port).toBeGreaterThan(1023);
      expect(activeChatgptLoopbackAddress()?.address).toBe("127.0.0.1");
      cancelChatgptLoopback(flowToken);
    } finally {
      await closeServer(blocker);
    }
  });

  it("one pending flow at a time: a new prepare cancels the previous one", async () => {
    const first = await prepareChatgptLoopback({ preferredPort: 0 });
    const opened = vi.fn(async () => {});
    const waiting = awaitChatgptCallback(first.flowToken, AUTHORIZE, opened);
    const second = await prepareChatgptLoopback({ preferredPort: 0 });
    await expect(waiting).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(second.flowToken).not.toBe(first.flowToken);
    cancelChatgptLoopback(second.flowToken);
  });
});

describe("awaitChatgptCallback", () => {
  it("opens the authorize URL, serves exactly one GET /auth/callback and closes", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const openExternal = vi.fn(async (_url: string) => {});
    const result = awaitChatgptCallback(flowToken, AUTHORIZE, openExternal);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTHORIZE));

    // Another path is 404 and does not settle the flow.
    const other = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(other.status).toBe(404);

    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=fake-code-123&state=st-1&client_id=oaiapp_x&extra=drop`,
      { headers: { cookie: "ocw_session=SESSION-COOKIE-VALUE" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/u);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("You can close this tab");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("fake-code-123");

    const out = await result;
    expect(out).toEqual({
      ok: true,
      redirectUrl: `http://127.0.0.1:${port}/auth/callback?code=fake-code-123&state=st-1&client_id=oaiapp_x`,
    });
    // Only the OAuth parameters cross: never a cookie or header the browser sent.
    expect(JSON.stringify(out)).not.toContain("SESSION-COOKIE-VALUE");
    expect(JSON.stringify(out)).not.toContain("extra");

    // Single use: the listener is gone.
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback?code=again&state=st-1`)).rejects.toThrow();
    expect(activeChatgptLoopbackAddress()).toBeNull();
    expect(await portIsFree(port)).toBe(true);
  });

  it("an OAuth error redirect is handed over as is (the API turns it into signin_cancelled)", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const result = awaitChatgptCallback(flowToken, AUTHORIZE, async () => {});
    await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=st-2`);
    expect(await result).toEqual({
      ok: true,
      redirectUrl: `http://127.0.0.1:${port}/auth/callback?state=st-2&error=access_denied`,
    });
  });

  it("refuses a request whose Host is not the loopback address (DNS rebinding)", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const result = awaitChatgptCallback(flowToken, AUTHORIZE, async () => {});
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/auth/callback?code=c&state=s",
          headers: { host: `evil.test:${port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(404);
    cancelChatgptLoopback(flowToken);
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
  });

  it.each([
    "http://auth.openai.com/oauth/authorize",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
    "http://127.0.0.1:4291/siwc/authorize",
  ])("refuses %s as the authorize URL without opening anything", async (url) => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const openExternal = vi.fn(async () => {});
    expect(await awaitChatgptCallback(flowToken, url, openExternal)).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(await portIsFree(port)).toBe(true);
  });

  it("accepts an http://127.0.0.1 authorize URL only when allowed (tests and dev builds)", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({
      preferredPort: 0,
      allowLoopbackAuthorize: true,
    });
    const openExternal = vi.fn(async () => {});
    const result = awaitChatgptCallback(flowToken, "http://127.0.0.1:4291/siwc/authorize?x=1", openExternal);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=c&state=s`);
    expect((await result).ok).toBe(true);
  });

  it("an unknown flow token is cancelled and opens nothing", async () => {
    const openExternal = vi.fn(async () => {});
    expect(await awaitChatgptCallback("A".repeat(43), AUTHORIZE, openExternal)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("cancel resolves cancelled and frees the port", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const result = awaitChatgptCallback(flowToken, AUTHORIZE, async () => {});
    cancelChatgptLoopback(flowToken);
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
    expect(await portIsFree(port)).toBe(true);
  });

  it("times out (5 minutes by default) and frees the port", async () => {
    expect(CHATGPT_LOOPBACK_TIMEOUT_MS).toBe(5 * 60_000);
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0, timeoutMs: 150 });
    const result = awaitChatgptCallback(flowToken, AUTHORIZE, async () => {});
    expect(await result).toEqual({ ok: false, reason: "timeout" });
    expect(await portIsFree(port)).toBe(true);
  });

  it("a failing openExternal cancels the flow", async () => {
    const { flowToken, port } = await prepareChatgptLoopback({ preferredPort: 0 });
    const result = await awaitChatgptCallback(flowToken, AUTHORIZE, async () => {
      throw new Error("no browser");
    });
    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(await portIsFree(port)).toBe(true);
  });
});

afterEach(() => {
  // Nothing this module did may reach a log line with the authorization code.
  expect(logs.join("\n")).not.toMatch(/code=/u);
});
