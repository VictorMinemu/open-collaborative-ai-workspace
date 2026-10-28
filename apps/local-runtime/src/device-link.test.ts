// The Device Link's server → device frame limit (06.1-03, P-01): the socket's `maxPayload` is pinned to the shared
// `DEVICE_LINK_MAX_COMMAND_FRAME_BYTES`, so a frame above it closes the link (1009) and the link reconnects, while a
// frame up to it reaches `onCommand`. Against a real local `ws` server; nothing listens on the device side.

import type { AddressInfo } from "node:net";
import {
  type CommandFrame,
  DEVICE_LINK_MAX_COMMAND_FRAME_BYTES,
  RUNTIME_COMPATIBILITY_MANIFEST,
  type ServerToDeviceFrame,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { DeviceLink } from "./device-link.js";
import type { Logger } from "./logger.js";

class LinkServer {
  readonly wss: WebSocketServer;
  readonly sockets: WebSocket[] = [];
  readonly closeCodes: number[] = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
    this.wss.on("connection", (ws) => {
      this.sockets.push(ws);
      ws.on("close", (code) => {
        this.closeCodes.push(code);
      });
    });
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/runtime/ws`;
  }
  ready(): Promise<void> {
    return new Promise((resolve) => this.wss.once("listening", () => resolve()));
  }
  /** Polls `fn` until it returns a value (state changes come from both the server and the link). */
  async waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

/** A serialized command frame of exactly `bytes` bytes (ASCII padding in the payload). */
function commandOfSize(bytes: number, id = "c1"): string {
  const empty = JSON.stringify({
    type: "command",
    id,
    kind: "prompt",
    sessionId: "s1",
    payload: { pad: "" },
  });
  return JSON.stringify({
    type: "command",
    id,
    kind: "prompt",
    sessionId: "s1",
    payload: { pad: "a".repeat(bytes - empty.length) },
  });
}

let server: LinkServer;
let link: DeviceLink | null;
let commands: CommandFrame[];

beforeEach(async () => {
  server = new LinkServer();
  await server.ready();
  link = null;
  commands = [];
});

afterEach(async () => {
  await link?.stop();
  await server.close();
});

function startLink(maxPayload?: number): DeviceLink {
  link = new DeviceLink({
    url: server.url,
    token: "device-token",
    onOpenFrames: () => [],
    onCommand: (c) => commands.push(c),
    backoffMinMs: 10,
    backoffMaxMs: 20,
    heartbeatMs: 60_000,
    ...(maxPayload === undefined ? {} : { maxPayload }),
  });
  link.start();
  return link;
}

const connected = (n: number) => server.waitFor(() => (server.sockets.length >= n ? true : undefined));

describe("DeviceLink frame limit (P-01)", () => {
  it("a server message above the configured limit closes the socket with 1009 and the link reconnects", async () => {
    startLink(4096);
    await connected(1);
    server.sockets[0]?.send(commandOfSize(4097));
    await server.waitFor(() => (server.closeCodes.length > 0 ? true : undefined));
    expect(server.closeCodes[0]).toBe(1009);
    await connected(2);
    expect(commands).toEqual([]);
  });

  it("a message at the configured limit reaches onCommand", async () => {
    startLink(4096);
    await connected(1);
    const frame = commandOfSize(4096);
    expect(Buffer.byteLength(frame)).toBe(4096);
    server.sockets[0]?.send(frame);
    await server.waitFor(() => (commands.length > 0 ? true : undefined));
    expect(commands[0]).toMatchObject({ id: "c1", kind: "prompt", sessionId: "s1" });
    expect(server.closeCodes).toEqual([]);
  });

  it("with no override the limit is DEVICE_LINK_MAX_COMMAND_FRAME_BYTES (32 MiB): one byte more closes with 1009", async () => {
    startLink();
    await connected(1);
    server.sockets[0]?.send(commandOfSize(DEVICE_LINK_MAX_COMMAND_FRAME_BYTES, "at-limit"));
    await server.waitFor(() => (commands.length > 0 ? true : undefined));
    expect(commands[0]?.id).toBe("at-limit");
    server.sockets[0]?.send(commandOfSize(DEVICE_LINK_MAX_COMMAND_FRAME_BYTES + 1, "over"));
    await server.waitFor(() => (server.closeCodes.length > 0 ? true : undefined));
    expect(server.closeCodes[0]).toBe(1009);
    expect(commands.map((c) => c.id)).toEqual(["at-limit"]);
    await connected(2);
  });
});

describe("DeviceLink server frames (07.11, PD-03)", () => {
  it("a runtime.config frame reaches onServerFrame parsed; a malformed one is ignored with a debug log; commands are unchanged", async () => {
    const frames: ServerToDeviceFrame[] = [];
    const debug: string[] = [];
    const logger: Logger = {
      debug: (msg) => debug.push(msg),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    link = new DeviceLink({
      url: server.url,
      token: "device-token",
      onOpenFrames: () => [],
      onCommand: (c) => commands.push(c),
      onServerFrame: (f) => frames.push(f),
      logger,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      heartbeatMs: 60_000,
    });
    link.start();
    await connected(1);
    const ws = server.sockets[0];
    ws?.send(JSON.stringify({ type: "runtime.config", policy: "off", manifest: { nope: true } }));
    ws?.send(
      JSON.stringify({
        type: "runtime.config",
        policy: "automatic",
        manifest: RUNTIME_COMPATIBILITY_MANIFEST,
      }),
    );
    ws?.send(commandOfSize(400, "after"));
    await server.waitFor(() => (commands.length > 0 && frames.length > 0 ? true : undefined));
    expect(frames).toEqual([
      { type: "runtime.config", policy: "automatic", manifest: RUNTIME_COMPATIBILITY_MANIFEST },
    ]);
    expect(commands.map((c) => c.id)).toEqual(["after"]);
    expect(debug).toContain("ignoring server frame");
  });
});
