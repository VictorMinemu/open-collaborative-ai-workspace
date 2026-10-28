import WebSocket from "ws";

/**
 * Contracts-level fake daemon for API integration tests: speaks raw Device Link frames (hello, ack, events,
 * capabilities) over a real WebSocket to the API under test. Shared by `workzone.int.test.ts` and the Work Zone
 * controls suites (Phase 03.2).
 */

export type Frame = Record<string, unknown> & { type: string };

export class FakeDevice {
  readonly frames: Frame[] = [];
  private cursor = 0;
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString()) as Frame));
    ws.on("close", () => {
      this.closed = true;
    });
  }

  static open(baseUrl: string, token: string): Promise<FakeDevice> {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/runtime/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new FakeDevice(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  /** Exchange the long-lived device token for a 10-minute device JWT (what the daemon does before connecting). */
  static async exchange(baseUrl: string, deviceToken: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/v1/devices/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (res.status !== 200) throw new Error(`device token exchange: HTTP ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  }

  /** Connect like the daemon: exchange the device token for a device JWT, open the link with it, say hello. */
  static async connect(
    baseUrl: string,
    deviceToken: string,
    sessions?: string[],
    opts: {
      codexLoggedIn?: boolean;
      /** The reported Claude Code version (default 2.1.287; null = installed, version unknown). */
      claudeVersion?: string | null;
      /** The reported Codex version (default 0.160.0). */
      codexVersion?: string | null;
      /** Report Codex as not installed (07.11: a runtime that is not installed has no compatibility). */
      codexInstalled?: boolean;
    } = {},
  ): Promise<FakeDevice> {
    const d = await FakeDevice.open(baseUrl, await FakeDevice.exchange(baseUrl, deviceToken));
    d.send({
      type: "hello",
      protocolVersion: 1,
      device: { name: "Test Mac", platform: "darwin", daemonVersion: "0.0.0-test" },
      runtimes: [
        {
          id: "claude-code",
          installed: true,
          version: opts.claudeVersion === undefined ? "2.1.287" : opts.claudeVersion,
          loggedIn: true,
        },
        opts.codexInstalled === false
          ? { id: "codex", installed: false, version: null, loggedIn: false }
          : {
              id: "codex",
              installed: true,
              version: opts.codexVersion === undefined ? "0.160.0" : opts.codexVersion,
              loggedIn: opts.codexLoggedIn ?? false,
            },
      ],
      ...(sessions ? { sessions } : {}),
    });
    await d.next((f) => f.type === "welcome");
    return d;
  }

  send(frame: Record<string, unknown>) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait for (and consume) the next frame matching `pred` after the cursor. */
  async next(pred: (f: Frame) => boolean, timeoutMs = 8000): Promise<Frame> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (let i = this.cursor; i < this.frames.length; i++) {
        const f = this.frames[i]!;
        if (pred(f)) {
          this.frames.splice(i, 1);
          return f;
        }
      }
      await sleep(20);
    }
    throw new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames.slice(-5))}`);
  }

  command(kind: string, sessionId?: string, timeoutMs?: number) {
    return this.next(
      (f) => f.type === "command" && f.kind === kind && (!sessionId || f.sessionId === sessionId),
      timeoutMs,
    ) as Promise<Frame & { id: string; payload: Record<string, unknown>; sessionId: string }>;
  }

  pending(kind: string) {
    return this.frames.filter((f) => f.type === "command" && f.kind === kind);
  }

  ack(id: string, ok = true, error?: string) {
    this.send({ type: "ack", commandId: id, ...(ok ? { ok: true } : { ok: false, error }) });
  }

  /** Report what the device's runtimes offer (P-05). */
  capabilities(catalogs: unknown[], fullAccessOptIn = false) {
    this.send({ type: "capabilities", catalogs, fullAccessOptIn });
  }

  /** Answer a `session.title` command (P-15); the ack follows separately. */
  titleResult(requestId: string, sessionId: string, title: string, model: string) {
    this.send({ type: "title.result", requestId, sessionId, title, model });
  }

  seq = Date.now() * 1000;
  event(sessionId: string, event: Record<string, unknown>, localSeq = ++this.seq) {
    this.send({ type: "event", sessionId, localSeq, event });
  }

  async close() {
    if (this.closed) return;
    await new Promise<void>((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`condition not met in time${last ? `: ${String(last)}` : ""}`);
}
