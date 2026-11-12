import { createHash, randomUUID } from "node:crypto";
import {
  RUNTIME_FILE_ROUTE,
  RuntimeFilePutAnswer,
  type RuntimeSelfStatus,
  SessionFileReadPayload,
  SessionFileWritePayload,
  sessionFileAckError,
} from "@ocw/contracts";
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
  /** The API this link was opened against and the device JWT it used (null for a raw device token). */
  baseUrl: string | null = null;
  jwt: string | null = null;
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
      ws.once("open", () => {
        const d = new FakeDevice(ws);
        d.baseUrl = baseUrl;
        d.jwt = token.includes(".") ? token : null;
        resolve(d);
      });
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
    ) as Promise<Frame & { id: string; kind: string; payload: Record<string, unknown>; sessionId: string }>;
  }

  pending(kind: string) {
    return this.frames.filter((f) => f.type === "command" && f.kind === kind);
  }

  ack(id: string, ok = true, error?: string) {
    this.send({ type: "ack", commandId: id, ...(ok ? { ok: true } : { ok: false, error }) });
  }

  /**
   * 07.17.1.1 (D-08, PD-05): do what the daemon does with a `session.file.write`: GET the bytes from
   * `RUNTIME_FILE_ROUTE/<command id>` under the device JWT, check their size and sha256 against the payload, and ack on
   * the link (`expired` for a 410, `transfer_failed: HTTP <status>` for another refusal, `mismatch` when the bytes
   * differ). With `ackAs` it acks that error without any request (e.g. an old daemon's `invalid command frame`).
   * `baseUrl` and `jwt` default to the link's own. Returns the ack it sent.
   *
   * 07.17.1.1-08: a `session.file.read` PUTs `opts.body` (the session file's bytes; `too_large: <n>` without a request
   * when they exceed the payload's `maxBytes`, as the daemon does) with its `content-length`, and acks ok only when the
   * API answers `RuntimeFilePutAnswer` with exactly that size (`expired` for 410, `too_large` for 413).
   */
  async serveFileCommand(
    cmd: { id: string; kind: string; payload: Record<string, unknown> },
    opts: { baseUrl?: string; jwt?: string; ackAs?: string; body?: Uint8Array } = {},
  ): Promise<{ ok: boolean; error: string | null }> {
    const answer = (error: string | null) => {
      this.ack(cmd.id, error === null, error ?? undefined);
      return { ok: error === null, error };
    };
    if (opts.ackAs !== undefined) return answer(opts.ackAs);
    const baseUrl = opts.baseUrl ?? this.baseUrl;
    const jwt = opts.jwt ?? this.jwt;
    if (!baseUrl || !jwt) throw new Error("serveFileCommand: no base URL or device JWT for this link");
    if (cmd.kind === "session.file.read") {
      const read = SessionFileReadPayload.parse(cmd.payload);
      const body = opts.body;
      if (!body) throw new Error("serveFileCommand: a session.file.read needs the file's bytes (opts.body)");
      if (body.length > read.maxBytes) return answer(sessionFileAckError("too_large", String(body.length)));
      const res = await fetch(`${baseUrl}${RUNTIME_FILE_ROUTE}/${cmd.id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/octet-stream" },
        body,
      });
      if (res.status === 410) return answer(sessionFileAckError("expired"));
      if (res.status === 413) return answer(sessionFileAckError("too_large"));
      if (res.status !== 200) return answer(sessionFileAckError("transfer_failed", `HTTP ${res.status}`));
      const put = RuntimeFilePutAnswer.safeParse(await res.json().catch(() => null));
      if (!put.success || put.data.sizeBytes !== body.length)
        return answer(sessionFileAckError("transfer_failed"));
      return answer(null);
    }
    if (cmd.kind !== "session.file.write") throw new Error(`serveFileCommand: unsupported kind ${cmd.kind}`);
    const payload = SessionFileWritePayload.parse(cmd.payload);
    const res = await fetch(`${baseUrl}${RUNTIME_FILE_ROUTE}/${cmd.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (res.status === 410) return answer(sessionFileAckError("expired"));
    if (res.status !== 200) return answer(sessionFileAckError("transfer_failed", `HTTP ${res.status}`));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== payload.sizeBytes || (payload.sha256 !== null && sha !== payload.sha256)) {
      return answer(sessionFileAckError("mismatch"));
    }
    return answer(null);
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

/**
 * 07.17.1: the device's own OCW runtime as a supervised service reports it (`RuntimeSelfStatus`), with overrides.
 * Defaults: 0.3.1 at build `1a2b3c4d5e6f`, supervised and able to update, idle, never checked.
 */
export function selfStatus(over: Partial<RuntimeSelfStatus> = {}): RuntimeSelfStatus {
  return {
    version: "0.3.1",
    build: "1a2b3c4d5e6f",
    supervised: true,
    canUpdate: true,
    reason: null,
    servedVersion: null,
    servedBuild: null,
    state: "idle",
    pendingSince: null,
    lastRun: null,
    checkedAt: null,
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
