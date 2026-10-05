import type { IncomingMessage, ServerResponse } from "node:http";

/** Types for the TypeScript tests that run the fake MCP server in-process (implementation: fake-mcp.mjs). */

export const FAKE_MCP_PROTOCOL_VERSIONS: readonly string[];

export const FAKE_MCP_TOOLS: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}>;

/** Returns true when it owned the route (`/mcp`, `/sse`, `/sse/messages`). */
export type FakeMcpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

export function createFakeMcp(opts?: { token?: string }): FakeMcpHandler;
