// The Codex half of the session's own tools (07.13.1.1 D-07, PD-08): `ocw-runtime session-mcp` is the `ocw_session`
// stdio MCP server a Codex app-server starts. It decides nothing: its tool list comes from the daemon
// (`sessionToolList`) and every call is one `sessionToolCall` on the 0600 control socket, decided by the session's
// relay. These tests link an in-memory MCP client to the shim's server against a real relay behind a real
// `ControlSocketServer` (and the real daemon's handler), never a TCP port.

import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SESSION_RENAME_REFUSAL_TEXT, type SessionToolsGrant } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ControlRequest,
  ControlRequestSchema,
  ControlSocketServer,
  controlRequest,
  controlSocketPath,
} from "../control-socket.js";
import { Daemon } from "../daemon.js";
import { silentLogger } from "../logger.js";
import {
  createSessionMcpServer,
  readSessionShimConfig,
  SESSION_SHIM_SESSION_ENV,
  SESSION_SHIM_TOKEN_FILE_ENV,
  SessionMcpShimError,
} from "./mcp-shim.js";
import { SessionToolRelay } from "./relay.js";

const ALLOW: SessionToolsGrant = { rename: true, namingRules: "Start with the area, then the change." };
const TOKEN_HEX = /^[0-9a-f]{64}$/;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function scratchHome(): string {
  // Short: a Unix socket path is limited to ~104 bytes on macOS.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-ss-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const textOf = (r: object): string =>
  (((r as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

/** A relay whose fake Device Link answers every rename with ok, behind the daemon's two control cases. */
async function relayBehindSocket(): Promise<{ home: string; relay: SessionToolRelay; socket: string }> {
  const home = scratchHome();
  const relay: SessionToolRelay = new SessionToolRelay({
    send: (frame) => {
      queueMicrotask(() =>
        relay.onServerFrame({
          type: "session.rename.result",
          requestId: frame.requestId,
          result: { ok: true, title: frame.title },
        }),
      );
      return true;
    },
    rootsFor: () => [join(home, "acme")],
    ocwHome: home,
    timeoutMs: 1_000,
  });
  const socket = controlSocketPath(home);
  const control = new ControlSocketServer(socket, async (req: ControlRequest) => {
    if (req.cmd === "sessionToolList") return relay.shimList(req);
    if (req.cmd === "sessionToolCall") return relay.shimCall(req);
    throw new Error("unsupported");
  });
  await control.listen();
  cleanups.push(async () => {
    await relay.stop();
    await control.close();
  });
  return { home, relay, socket };
}

async function link(server: ReturnType<typeof createSessionMcpServer>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "codex-like", version: "0.0.0" });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  return client;
}

describe("ocw-runtime session-mcp: a Codex-style client renames through the shim and the control socket (tracer)", () => {
  it("lists one rename tool with the daemon's description and relays a call inside a turn", async () => {
    const { home, relay, socket } = await relayBehindSocket();
    const sid = randomUUID();
    relay.onPrompt(sid, null, ALLOW);
    relay.onPrompt(sid, "p1", ALLOW);
    relay.onTurnStarted(sid, "p1");
    const tokenFile = await relay.forSession(sid).shimTokenFile();
    const config = await readSessionShimConfig({
      OCW_HOME: home,
      [SESSION_SHIM_SESSION_ENV]: sid,
      [SESSION_SHIM_TOKEN_FILE_ENV]: tokenFile,
    });
    expect(config.socket).toBe(socket);
    const list = await controlRequest(socket, { cmd: "sessionToolList", session: sid, token: config.token });
    expect(list.ok).toBe(true);
    const description = relay.forSession(sid).description("rename");
    const client = await link(createSessionMcpServer(config, description));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["rename"]);
    expect(tools[0]?.description).toBe(description);
    expect(tools[0]?.description).toContain(
      "<naming-rules>\nStart with the area, then the change.\n</naming-rules>",
    );
    expect(tools[0]?.inputSchema.properties).toHaveProperty("title");
    expect(client.getServerVersion()?.name).toBe("ocw_session");

    const res = await client.callTool({ name: "rename", arguments: { title: "Fix login redirect" } });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toBe('Renamed the session to "Fix login redirect".');
    // The relay's own rule holds through the shim: once per turn.
    const again = await client.callTool({ name: "rename", arguments: { title: "Fix the redirect" } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(SESSION_RENAME_REFUSAL_TEXT.already_renamed);
  });

  it("a token that is no longer the session's gets the relay's not_available result, never a throw", async () => {
    const { home, relay } = await relayBehindSocket();
    const sid = randomUUID();
    relay.onPrompt(sid, null, ALLOW);
    relay.onPrompt(sid, "p1", ALLOW);
    relay.onTurnStarted(sid, "p1");
    const tokenFile = await relay.forSession(sid).shimTokenFile();
    const config = await readSessionShimConfig({
      OCW_HOME: home,
      [SESSION_SHIM_SESSION_ENV]: sid,
      [SESSION_SHIM_TOKEN_FILE_ENV]: tokenFile,
    });
    writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`);
    const client = await link(createSessionMcpServer(config, "Rename this session."));
    const res = await client.callTool({ name: "rename", arguments: { title: "Fix login redirect" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(SESSION_RENAME_REFUSAL_TEXT.not_available);
  });

  it("a daemon that cannot be reached is the not_available result", async () => {
    const home = scratchHome();
    const client = await link(
      createSessionMcpServer(
        { session: randomUUID(), token: randomBytes(32).toString("hex"), socket: controlSocketPath(home) },
        "Rename this session.",
      ),
    );
    const res = await client.callTool({ name: "rename", arguments: { title: "Fix login redirect" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(SESSION_RENAME_REFUSAL_TEXT.not_available);
  });
});

describe("readSessionShimConfig: only the session's own token file, before any socket", () => {
  async function setup() {
    const home = scratchHome();
    const sid = randomUUID();
    const dir = join(home, "run", "sessions", sid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "shim-token");
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    const env = (over: Record<string, string>) => ({
      OCW_HOME: home,
      [SESSION_SHIM_SESSION_ENV]: sid,
      [SESSION_SHIM_TOKEN_FILE_ENV]: file,
      ...over,
    });
    return { home, sid, dir, file, env };
  }

  const refusedWith = async (env: NodeJS.ProcessEnv, sentence: string) => {
    const err = await readSessionShimConfig(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionMcpShimError);
    expect((err as Error).message).toBe(sentence);
  };

  it("accepts the session's own file and reads its token (no socket is needed to read it)", async () => {
    const { home, sid, env } = await setup();
    const config = await readSessionShimConfig(env({}));
    expect(config).toEqual({
      session: sid,
      token: expect.stringMatching(TOKEN_HEX),
      socket: controlSocketPath(home),
    });
  });

  it("refuses a session that is not a uuid", async () => {
    const { env } = await setup();
    await refusedWith(env({ [SESSION_SHIM_SESSION_ENV]: "not-a-uuid" }), "the session is not valid");
  });

  it("refuses a token file anywhere else, a relative path, a link, a directory and a short token", async () => {
    const { home, dir, file, env } = await setup();
    const sentence = "the session token file is not valid";
    const elsewhere = join(home, "shim-token");
    writeFileSync(elsewhere, readFileSync(file));
    await refusedWith(env({ [SESSION_SHIM_TOKEN_FILE_ENV]: elsewhere }), sentence);
    await refusedWith(env({ [SESSION_SHIM_TOKEN_FILE_ENV]: "run/sessions/x/shim-token" }), sentence);
    // Another session's own file is not this session's.
    const other = join(home, "run", "sessions", randomUUID());
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "shim-token"), readFileSync(file));
    await refusedWith(env({ [SESSION_SHIM_TOKEN_FILE_ENV]: join(other, "shim-token") }), sentence);
    // A link in the file's place.
    rmSync(file);
    symlinkSync(elsewhere, file);
    await refusedWith(env({}), sentence);
    // A directory in the file's place.
    rmSync(file);
    mkdirSync(file);
    await refusedWith(env({}), sentence);
    rmSync(file, { recursive: true });
    // Not 64 hex characters.
    writeFileSync(file, "abc123\n");
    await refusedWith(env({}), sentence);
    expect(dirname(file)).toBe(dir);
  });
});

describe("ControlRequestSchema: the two session tool requests are strict", () => {
  const session = randomUUID();
  const token = randomBytes(32).toString("hex");
  const ok = (req: unknown) => ControlRequestSchema.safeParse(req).success;

  it("sessionToolCall: rename only, a uuid session, a 64-hex token, no other key", () => {
    expect(ok({ cmd: "sessionToolCall", session, token, tool: "rename", args: { title: "x" } })).toBe(true);
    expect(ok({ cmd: "sessionToolCall", session, token, tool: "rename", args: {}, extra: 1 })).toBe(false);
    expect(ok({ cmd: "sessionToolCall", session, token, tool: "open", args: {} })).toBe(false);
    expect(ok({ cmd: "sessionToolCall", session, token: "abc", tool: "rename", args: {} })).toBe(false);
    expect(ok({ cmd: "sessionToolCall", session: "nope", token, tool: "rename", args: {} })).toBe(false);
  });

  it("sessionToolList: a uuid session and a 64-hex token, no other key", () => {
    expect(ok({ cmd: "sessionToolList", session, token })).toBe(true);
    expect(ok({ cmd: "sessionToolList", session, token, tool: "rename" })).toBe(false);
    expect(ok({ cmd: "sessionToolList", session, token: token.toUpperCase() })).toBe(false);
  });
});

describe("the daemon answers the two requests only through the relay's token check", () => {
  async function daemonOnSocket(): Promise<{ daemon: Daemon; home: string }> {
    const home = scratchHome();
    const daemon = await Daemon.create({
      home,
      env: { CODEX_HOME: join(home, "codex-default") },
      token: null,
      config: { serverUrl: "http://127.0.0.1:9" },
      runtimes: [],
      logger: silentLogger,
    });
    await daemon.start();
    cleanups.push(() => daemon.stop());
    return { daemon, home };
  }

  it("lists the session's description with its token; refuses another token and a bad request", async () => {
    const { daemon, home } = await daemonOnSocket();
    const socket = controlSocketPath(home);
    const sid = randomUUID();
    daemon.sessionTools.onPrompt(sid, null, ALLOW);
    const tokenFile = await daemon.sessionTools.forSession(sid).shimTokenFile();
    const token = readFileSync(tokenFile, "utf8").trim();
    const list = await controlRequest(socket, { cmd: "sessionToolList", session: sid, token });
    expect(list).toMatchObject({
      ok: true,
      result: [{ name: "rename", description: daemon.sessionTools.forSession(sid).description("rename") }],
    });
    const other = randomBytes(32).toString("hex");
    expect(
      await controlRequest(socket, { cmd: "sessionToolList", session: sid, token: other }),
    ).toMatchObject({
      ok: false,
      error: "not allowed",
    });
    expect(
      await controlRequest(socket, { cmd: "sessionToolList", session: sid, token, x: 1 } as never),
    ).toMatchObject({ ok: false, error: "invalid request" });
    expect(
      await controlRequest(socket, {
        cmd: "sessionToolCall",
        session: sid,
        token: other,
        tool: "rename",
        args: { title: "Fix login redirect" },
      }),
    ).toMatchObject({
      ok: true,
      result: { isError: true, content: [{ type: "text", text: SESSION_RENAME_REFUSAL_TEXT.not_available }] },
    });
  });

  it("a call with the session's token in a turn reaches the relay (offline here: not_available)", async () => {
    const { daemon, home } = await daemonOnSocket();
    const sid = randomUUID();
    daemon.sessionTools.onPrompt(sid, null, ALLOW);
    daemon.sessionTools.onPrompt(sid, "p1", ALLOW);
    daemon.sessionTools.onTurnStarted(sid, "p1");
    const tokenFile = await daemon.sessionTools.forSession(sid).shimTokenFile();
    const config = await readSessionShimConfig({
      OCW_HOME: home,
      [SESSION_SHIM_SESSION_ENV]: sid,
      [SESSION_SHIM_TOKEN_FILE_ENV]: tokenFile,
    });
    const client = await link(createSessionMcpServer(config, "Rename this session."));
    // An invalid title is the relay's own refusal, before any frame: the daemon routed the call there.
    const bad = await client.callTool({ name: "rename", arguments: { title: "a b c d e f g h" } });
    expect(textOf(bad)).toBe(SESSION_RENAME_REFUSAL_TEXT.invalid_title);
    const offline = await client.callTool({ name: "rename", arguments: { title: "Fix login redirect" } });
    expect(offline.isError).toBe(true);
    expect(textOf(offline)).toBe(SESSION_RENAME_REFUSAL_TEXT.not_available);
  });
});

describe("the shim opens no port", () => {
  it("the module has no server and no listen call", () => {
    const src = readFileSync(join(import.meta.dirname, "mcp-shim.ts"), "utf8");
    expect(src).not.toMatch(/createServer\(|listen\(/);
  });
});
