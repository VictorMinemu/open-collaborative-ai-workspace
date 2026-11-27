// The session's `ocw_session` tools as Claude Code sees them (07.13.1.1 D-07, D-08, PD-08): one in-process SDK MCP
// server named `ocw_session` beside `ocw_browser`, answering exactly what the session's relay answers. This factory is
// the only surface the Claude adapter uses (principle 5); every rule behind a call (turn, grant, once per turn, the
// title's shape, no path or secret, the API's decision) is the relay's or the API's.
//
// - The tool keeps its short name (`rename`); Claude shows it as `mcp__ocw_session__rename`.
// - `alwaysLoad`: the tool is always in the prompt, never deferred behind tool search.
// - The description carries the naming rules as delimited wording data (`renameDescription`); a change of rules builds a
//   new server, registered by the adapter between turns.

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { SessionRenameInput, WORK_SESSION_MCP_SERVER } from "@ocw/contracts";
import type { SessionToolsHandle } from "../runtime.js";
import { SESSION_SERVER_INSTRUCTIONS, WORK_SESSION_TOOL_TABLE } from "./tools.js";

export interface SessionMcpServerOptions {
  /** The server's version (the daemon's). */
  version: string;
}

/** The MCP request's abort signal, bounded by the tool's own budget. */
function callSignal(extra: unknown, timeoutMs: number): AbortSignal {
  const own = (extra as { signal?: unknown } | null | undefined)?.signal;
  const budget = AbortSignal.timeout(timeoutMs);
  return own instanceof AbortSignal ? AbortSignal.any([own, budget]) : budget;
}

/** The session's `ocw_session` server: `rename`, handing its arguments to the relay and its answer back unchanged. */
export function sessionMcpServer(
  handle: SessionToolsHandle,
  opts: SessionMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const spec = WORK_SESSION_TOOL_TABLE.rename;
  return createSdkMcpServer({
    name: WORK_SESSION_MCP_SERVER,
    version: opts.version,
    alwaysLoad: true,
    instructions: SESSION_SERVER_INSTRUCTIONS,
    // A hard wall above the tool's own budget, so the relay decides first.
    timeout: spec.timeoutMs + 5_000,
    tools: [
      tool("rename", handle.description("rename"), SessionRenameInput.shape, async (args, extra) => {
        const result = await handle.call("rename", args, callSignal(extra, spec.timeoutMs));
        return { content: result.content.map((c) => ({ ...c })), isError: result.isError };
      }),
    ],
  });
}
