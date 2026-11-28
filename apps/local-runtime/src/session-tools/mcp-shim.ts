// The Codex side of the session's own tools (07.13.1.1 D-07, PD-08; ADR-0047): `ocw-runtime session-mcp`, the
// `ocw_session` stdio MCP server a Codex app-server starts for a session whose payloads carry `sessionTools`
// (`-c mcp_servers.ocw_session.*`, codex-runtime.ts). The 07.13 browser bridge's second transport.
//
// - It decides nothing: its one tool's description comes from the daemon (`sessionToolList`, naming rules included),
//   and every call becomes one `sessionToolCall { session, token, tool, args }` on the daemon's local control socket
//   (a Unix socket / named pipe, 0600). The session's relay decides it exactly as it decides a Claude call.
// - It never listens: stdio towards Codex, one outgoing local connection per request towards the daemon.
// - Its env names the session and the session's token FILE (never the token: argv and env are visible to `ps`). The
//   file must be the session's own `<ocwHome>/run/sessions/<session>/shim-token`; otherwise the shim exits before
//   serving.
// - stdout carries MCP frames only; diagnostics go to stderr in fixed words (no path, no token, no title, no rule).

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WORK_SESSION_MCP_SERVER } from "@ocw/contracts";
import { z } from "zod";
import { controlCall } from "../browser/mcp-shim.js";
import { SHIM_TOKEN_FILE } from "../browser/shim-token.js";
import { ocwHome } from "../config.js";
import { controlSocketPath } from "../control-socket.js";
import type { SessionToolResult } from "../runtime.js";
import { RUNTIME_VERSION } from "../version.js";
import { refusalResult, SESSION_SERVER_INSTRUCTIONS, WORK_SESSION_TOOL_TABLE } from "./tools.js";

/** The env names the Codex runtime sets for the shim (`mcp_servers.ocw_session.env`), beside `OCW_HOME`. */
export const SESSION_SHIM_SESSION_ENV = "OCW_SESSION_TOOLS_SESSION";
export const SESSION_SHIM_TOKEN_FILE_ENV = "OCW_SESSION_TOOLS_TOKEN_FILE";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
/** One rename's socket budget: the relay's own 15 s with room for the round trip (Codex waits 30 s). */
const CALL_TIMEOUT_MS = 30_000;
/** The tool list before serving. */
const LIST_TIMEOUT_MS = 10_000;

export class SessionMcpShimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMcpShimError";
  }
}

export interface SessionMcpShimIo {
  env: NodeJS.ProcessEnv;
  stdin: Readable;
  stdout: Writable;
  stderr?: Writable;
}

export interface SessionShimConfig {
  session: string;
  token: string;
  socket: string;
}

/** The relay's `SessionToolResult` (text only); anything else is refused. */
const ShimAnswer = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean(),
});

/** The relay's `shimList` answer: the rename tool's description. */
const ListAnswer = z.array(z.object({ name: z.string(), description: z.string().min(1) }));

/** Reads the shim's env and its token file; throws `SessionMcpShimError` (fixed words) when either is not valid. */
export async function readSessionShimConfig(env: NodeJS.ProcessEnv): Promise<SessionShimConfig> {
  const session = env[SESSION_SHIM_SESSION_ENV]?.trim() ?? "";
  const file = env[SESSION_SHIM_TOKEN_FILE_ENV]?.trim() ?? "";
  if (!UUID.test(session)) throw new SessionMcpShimError("the session is not valid");
  const home = ocwHome(env);
  const expected = join(home, "run", "sessions", session, SHIM_TOKEN_FILE);
  // Only the session's own token file, never a path elsewhere (a link or a directory counts as missing).
  if (!isAbsolute(file) || resolve(file) !== expected) {
    throw new SessionMcpShimError("the session token file is not valid");
  }
  let token = "";
  try {
    const st = await lstat(expected);
    if (st.isFile()) token = (await readFile(expected, "utf8")).trim();
  } catch {
    token = "";
  }
  if (!TOKEN.test(token)) throw new SessionMcpShimError("the session token file is not valid");
  return { session, token, socket: controlSocketPath(home) };
}

const asMcp = (r: SessionToolResult) => ({
  content: r.content.map((c) => ({ type: "text" as const, text: c.text })),
  isError: r.isError,
});

/**
 * Builds the `ocw_session` MCP server: `rename` with the daemon's description, a relay to the daemon. Never throws to
 * the client: a transport failure or an answer that is not the relay's is the `not_available` result.
 */
export function createSessionMcpServer(
  config: SessionShimConfig,
  description: string,
  stderr?: Writable,
): McpServer {
  const server = new McpServer(
    { name: WORK_SESSION_MCP_SERVER, version: RUNTIME_VERSION },
    { instructions: SESSION_SERVER_INSTRUCTIONS },
  );
  const note = (words: string) => stderr?.write(`ocw-runtime session-mcp: ${words}\n`);
  const spec = WORK_SESSION_TOOL_TABLE.rename;
  server.registerTool(
    "rename",
    { description, inputSchema: spec.input },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      let answer: { ok: boolean; result?: unknown; error?: string };
      try {
        answer = await controlCall(
          config.socket,
          { cmd: "sessionToolCall", session: config.session, token: config.token, tool: "rename", args },
          CALL_TIMEOUT_MS,
          extra.signal,
        );
      } catch {
        note("the daemon could not be reached");
        return asMcp(refusalResult("not_available"));
      }
      const parsed = answer.ok ? ShimAnswer.safeParse(answer.result) : null;
      if (!parsed?.success) {
        note("the daemon did not answer the call");
        return asMcp(refusalResult("not_available"));
      }
      return parsed.data;
    },
  );
  return server;
}

/** The rename tool's description from the daemon (the session's own token); throws in fixed words otherwise. */
async function fetchDescription(config: SessionShimConfig): Promise<string> {
  let answer: { ok: boolean; result?: unknown; error?: string };
  try {
    answer = await controlCall(
      config.socket,
      { cmd: "sessionToolList", session: config.session, token: config.token },
      LIST_TIMEOUT_MS,
      undefined,
    );
  } catch {
    throw new SessionMcpShimError("the daemon could not be reached");
  }
  const list = answer.ok ? ListAnswer.safeParse(answer.result) : null;
  const rename = list?.success ? list.data.find((t) => t.name === "rename") : undefined;
  if (!rename) throw new SessionMcpShimError("the daemon did not allow this session's tools");
  return rename.description;
}

/**
 * `ocw-runtime session-mcp`: reads the env and the token file, asks the daemon for the tool's description (throws
 * before serving when any of them is not valid), then serves MCP on stdin/stdout until Codex closes stdin.
 */
export async function runSessionMcpShim(io: SessionMcpShimIo): Promise<void> {
  const config = await readSessionShimConfig(io.env);
  const description = await fetchDescription(config);
  const server = createSessionMcpServer(config, description, io.stderr);
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
}
