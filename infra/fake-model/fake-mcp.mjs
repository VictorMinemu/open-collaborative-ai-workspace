// Deterministic fake MCP server for tests (03.1-09, D-13 / D-15). No dependencies; mounted by the fake-model
// server, so no new image is needed.
//
// Transports:
//   Streamable HTTP  POST /mcp (single JSON responses), DELETE /mcp ends the session, GET /mcp → 405
//                    (no server-initiated stream). `initialize` issues `Mcp-Session-Id`; every later request
//                    must carry it (missing → 400, unknown/ended → 404). Notifications/responses → 202.
//   HTTP+SSE (2024-11-05 style)  GET /sse opens the stream and announces `event: endpoint` with
//                    `/sse/messages?sessionId=…`; POST there → 202, the JSON-RPC answer arrives on the stream
//                    as `event: message`.
//
// Tools: `echo` (read-only: readOnlyHint true) → "echo: <text>"; `write_note` (destructiveHint true) →
// "noted: <title or text>". With a token (`FAKE_MCP_TOKEN`), every MCP request needs
// `Authorization: Bearer <token>` (401 otherwise). `onToolCall` sees every tools/call's name and arguments.
import { randomUUID } from "node:crypto";

/** Newest first. An unsupported requested version gets the newest. */
export const FAKE_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "ocw-fake-mcp", title: "OCW fake MCP server", version: "1.0.0" };

export const FAKE_MCP_TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo the given text back. Read-only.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "write_note",
    title: "Write note",
    description: "Store a note on the server. Has side effects.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

function negotiate(requested) {
  return FAKE_MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : FAKE_MCP_PROTOCOL_VERSIONS[0];
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Returns a request handler `(req, res, url) => boolean`: true when it owned the route (`/mcp`, `/sse`,
 * `/sse/messages`), false to let the host server continue.
 */
export function createFakeMcp(opts = {}) {
  const token = opts.token || null;
  /** `opts.onToolCall({name, arguments})`: every tools/call exactly as received (the real-cell smoke reads them). */
  const onToolCall = typeof opts.onToolCall === "function" ? opts.onToolCall : null;
  /** Streamable HTTP sessions: id → { protocolVersion }. */
  const sessions = new Map();
  /** SSE sessions: id → the open event-stream response. */
  const streams = new Map();
  const notes = [];

  function callTool(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      onToolCall?.({ name, arguments: args });
    } catch {
      /* a test hook never breaks the fake */
    }
    if (name === "echo") {
      if (typeof args.text !== "string") return textResult("echo: `text` must be a string", true);
      return textResult(`echo: ${args.text}`);
    }
    if (name === "write_note") {
      if (typeof args.text !== "string") return textResult("write_note: `text` must be a string", true);
      const title = typeof args.title === "string" && args.title ? args.title : args.text.slice(0, 40);
      notes.push({ title, text: args.text });
      return textResult(`noted: ${title}`);
    }
    return null;
  }

  /** Answers one JSON-RPC request (never called for notifications). */
  function dispatch(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: negotiate(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Deterministic fake MCP server for OCW tests.",
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        if (params?.cursor !== undefined) return rpcError(id, INVALID_PARAMS, "Invalid cursor");
        return rpcResult(id, { tools: FAKE_MCP_TOOLS });
      case "tools/call": {
        const result = callTool(params);
        return result ? rpcResult(id, result) : rpcError(id, INVALID_PARAMS, `Unknown tool: ${params?.name}`);
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** Parses a body into one JSON-RPC message, or returns `{ error }` with the HTTP answer. */
  function parseMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { error: rpcError(null, PARSE_ERROR, "Parse error") };
    }
    if (Array.isArray(msg)) return { error: rpcError(null, INVALID_REQUEST, "Batching is not supported") };
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return { error: rpcError(msg?.id, INVALID_REQUEST, "Invalid request") };
    }
    return { msg };
  }

  /** A request expects an answer; notifications and client responses do not. */
  const isRequest = (msg) => typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;

  async function streamablePost(req, res) {
    const parsed = parseMessage(await readRaw(req));
    if (parsed.error) return send(res, 400, parsed.error);
    const msg = parsed.msg;
    if (msg.method === "initialize") {
      if (!isRequest(msg)) return send(res, 400, rpcError(null, INVALID_REQUEST, "initialize needs an id"));
      const answer = dispatch(msg);
      const sessionId = randomUUID();
      sessions.set(sessionId, { protocolVersion: answer.result.protocolVersion });
      return send(res, 200, answer, { "mcp-session-id": sessionId });
    }
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId)
      return send(res, 400, rpcError(msg.id, -32000, "Bad Request: Mcp-Session-Id header is required"));
    if (!sessions.has(sessionId)) return send(res, 404, rpcError(msg.id, -32001, "Session not found"));
    if (!isRequest(msg)) return send(res, 202);
    return send(res, 200, dispatch(msg));
  }

  function streamable(req, res) {
    if (req.method === "POST") return streamablePost(req, res);
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId)
        return send(res, 400, rpcError(null, -32000, "Bad Request: Mcp-Session-Id header is required"));
      if (!sessions.delete(sessionId)) return send(res, 404, rpcError(null, -32001, "Session not found"));
      return send(res, 204);
    }
    // No server-initiated stream on this transport.
    return send(res, 405, rpcError(null, -32000, "Method not allowed"), { allow: "POST, DELETE" });
  }

  function sseOpen(req, res) {
    if (req.method !== "GET") return send(res, 405, undefined, { allow: "GET" });
    const sessionId = randomUUID();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /sse/messages?sessionId=${sessionId}\n\n`);
    streams.set(sessionId, res);
    req.on("close", () => streams.delete(sessionId));
  }

  async function sseMessage(req, res, url) {
    if (req.method !== "POST") return send(res, 405, undefined, { allow: "POST" });
    const stream = streams.get(url.searchParams.get("sessionId") ?? "");
    if (!stream) return send(res, 404, rpcError(null, -32001, "Session not found"));
    const parsed = parseMessage(await readRaw(req));
    if (parsed.error) return send(res, 400, parsed.error);
    send(res, 202);
    if (isRequest(parsed.msg))
      stream.write(`event: message\ndata: ${JSON.stringify(dispatch(parsed.msg))}\n\n`);
  }

  return function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/mcp" && p !== "/sse" && p !== "/sse/messages") return false;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="ocw-fake-mcp"' });
      return true;
    }
    const run =
      p === "/mcp" ? streamable(req, res) : p === "/sse" ? sseOpen(req, res) : sseMessage(req, res, url);
    Promise.resolve(run).catch((error) => {
      if (!res.headersSent)
        send(res, 500, rpcError(null, -32603, error instanceof Error ? error.message : "error"));
      else res.end();
    });
    return true;
  };
}
