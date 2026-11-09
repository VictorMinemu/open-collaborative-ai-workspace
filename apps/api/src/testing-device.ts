import { randomUUID } from "node:crypto";
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
      /** 07.16 (PD-18): how the daemon says it runs (`device.host`); sent only when given. */
      host?: "desktop" | "service";
      /** 07.16 (D-19): the owner's local isolated-server mark (`isolatedServer`); sent only when given. */
      isolatedServer?: boolean;
    } = {},
  ): Promise<FakeDevice> {
    const d = await FakeDevice.open(baseUrl, await FakeDevice.exchange(baseUrl, deviceToken));
    d.send({
      type: "hello",
      protocolVersion: 1,
      device: {
        name: "Test Mac",
        platform: "darwin",
        daemonVersion: "0.0.0-test",
        ...(opts.host ? { host: opts.host } : {}),
      },
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
      ...(opts.isolatedServer !== undefined ? { isolatedServer: opts.isolatedServer } : {}),
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

  /** Report what the device's runtimes offer (P-05); `isolatedServer` (07.16, D-19) is sent only when given. */
  capabilities(catalogs: unknown[], fullAccessOptIn = false, isolatedServer?: boolean) {
    this.send({
      type: "capabilities",
      catalogs,
      fullAccessOptIn,
      ...(isolatedServer !== undefined ? { isolatedServer } : {}),
    });
  }

  /** Answer a `session.title` command (P-15); the ack follows separately. */
  titleResult(requestId: string, sessionId: string, title: string, model: string) {
    this.send({ type: "title.result", requestId, sessionId, title, model });
  }

  /**
   * 07.11: report the runtimes' maintenance snapshot (PD-03). Defaults: Claude Code 2.1.300 native and current, Codex
   * 0.160.0 standalone and current, levels `automatic` from the config, the org level received.
   */
  maintenance(frame: Record<string, unknown> = {}) {
    this.send({
      type: "runtime.maintenance",
      runtimes: [
        maintenanceStatus(),
        maintenanceStatus({
          runtime: "codex",
          installedVersion: "0.160.0",
          method: "codex_standalone",
          location: "~/.codex/packages/standalone",
          updateCommand: "codex update",
          latestVersion: "0.160.0",
        }),
      ],
      runtimeInfo: [
        { id: "claude-code", installed: true, version: "2.1.300", loggedIn: true },
        { id: "codex", installed: true, version: "0.160.0", loggedIn: false },
      ],
      localLevel: "automatic",
      localLevelSource: "config",
      effectiveLevel: "automatic",
      orgLevelReceived: true,
      ...frame,
    });
  }

  /**
   * 07.11: report one update run phase (PD-03, PD-06). Defaults: a new run id, Claude Code, automatic, `started`,
   * 2.1.290 → candidate 2.1.300, native. Pass `phase: "finished"` with an `outcome`.
   */
  updateRun(frame: Record<string, unknown> = {}) {
    this.send({
      type: "runtime.update.run",
      runId: randomUUID(),
      runtime: "claude-code",
      trigger: "automatic",
      phase: "started",
      fromVersion: "2.1.290",
      toVersion: null,
      candidate: "2.1.300",
      method: "native",
      at: new Date().toISOString(),
      ...frame,
    });
  }

  seq = Date.now() * 1000;
  event(sessionId: string, event: Record<string, unknown>, localSeq = ++this.seq) {
    this.send({ type: "event", sessionId, localSeq, event });
  }

  /**
   * 07.16 (Wave 0 helper): one whole turn of `promptId` as a runtime reports it: `prompt.started` →
   * `assistant.message` (`text`) → `prompt.completed`, each with a fresh `localSeq` (from `localSeq` when given).
   */
  emitTurn(workSessionId: string, turn: { promptId: string; text: string; localSeq?: number }) {
    if (turn.localSeq !== undefined) this.seq = Math.max(this.seq, turn.localSeq - 1);
    this.event(workSessionId, { type: "prompt.started", promptId: turn.promptId });
    this.event(workSessionId, { type: "assistant.message", messageId: randomUUID(), text: turn.text });
    this.event(workSessionId, {
      type: "prompt.completed",
      promptId: turn.promptId,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }

  /** 07.16 (Wave 0 helper): the runtime asks for an approval (`approval.requested`, repo-relative `paths`). */
  emitApproval(
    workSessionId: string,
    a: { approvalId: string; tool: string; paths: string[]; summary?: string },
  ) {
    this.event(workSessionId, {
      type: "approval.requested",
      approvalId: a.approvalId,
      tool: a.tool,
      summary: a.summary ?? `${a.tool} ${a.paths.join(", ")}`.trim(),
      paths: a.paths,
    });
  }

  async close() {
    if (this.closed) return;
    await new Promise<void>((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

/** 07.11: one runtime's maintenance status as a device reports it (`RuntimeMaintenanceStatus`), with overrides. */
export function maintenanceStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: "claude-code",
    installedVersion: "2.1.300",
    method: "native",
    location: "~/.local/bin",
    canUpdate: true,
    reason: null,
    updateCommand: "claude update",
    channel: "latest",
    latestVersion: "2.1.300",
    advisory: "current",
    installedCompatibility: "supported",
    candidateCompatibility: "supported",
    state: "idle",
    pendingSince: null,
    stale: false,
    lastRun: null,
    checkedAt: new Date().toISOString(),
    ...over,
  };
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
