#!/usr/bin/env node
// Dependency-free stdio MCP server for bridge.test.mjs (never baked into the image). Newline-delimited JSON-RPC on
// stdin/stdout, as the MCP stdio transport specifies. Tools:
//   echo {message}  → "echo: <message>"
//   env             → the names of every variable in this process's environment (JSON array, sorted), plus HOME
//   pid             → this process's pid
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the message",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    annotations: { readOnlyHint: true },
  },
  { name: "env", description: "Lists environment variable names", inputSchema: { type: "object" } },
  { name: "pid", description: "Returns the process id", inputSchema: { type: "object" } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (id, value) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }] } });

function handle(msg) {
  if (msg.id === undefined || typeof msg.method !== "string") return; // notifications and responses
  switch (msg.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-echo", version: "0.0.0" },
        },
      });
    case "ping":
      return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === "echo") return text(msg.id, `echo: ${String(args.message ?? "")}`);
      if (name === "env") {
        return text(
          msg.id,
          JSON.stringify({ names: Object.keys(process.env).sort(), home: process.env.HOME }),
        );
      }
      if (name === "pid") return text(msg.id, String(process.pid));
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
});
process.stdin.on("end", () => process.exit(0));
