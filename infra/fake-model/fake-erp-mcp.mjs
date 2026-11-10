// Deterministic fake ERP MCP server for watched-record tests (07.6-04, D-04 / A6). Test-only, no dependencies:
// integration tests run it in-process and the e2e fake server (server.mjs) mounts it at `/erp-mcp`. It is the
// "changed elsewhere" ERP the phase tests against; no real ERP is ever used.
//
// Transport: streamable HTTP at `/erp-mcp` (single JSON responses), like fake-mcp.mjs: `initialize` issues
// `Mcp-Session-Id`, every later request must carry it (missing → 400, unknown → 404), DELETE ends it, GET → 405.
// Every request needs `Authorization: Bearer <token>` (its own token, never the generic fake MCP's) → 401 otherwise.
//
// Tools (results carry `structuredContent` and the same JSON as text):
//   get_record    { id }                                → { id, status, delivery_date, total (string), customer,
//                                                           updated_at, notes }
//   update_record { id, expectedUpdatedAt?, ...fields } → the updated record; bumps updated_at. A stale
//                                                         expectedUpdatedAt is the 409 of an ERP: isError with
//                                                         { error: "conflict", updated_at } and nothing changes
//   add_note      { id, text }                          → { ok: true }; appends to the record's notes, updated_at kept
//                                                         (a note-back never breaks the next compare-and-set)
//   list_records  {}                                    → { ids }
//   __mutate      { id, fields }                        → test hook: a change made "elsewhere"; bumps updated_at
//   __add         { id, fields }                        → test hook (07.17-18): a new record made "elsewhere" (a new
//                                                         order); unset fields are "" (total "0.00"), updated_at is
//                                                         now; an id that exists is isError "exists: <id>". Callable
//                                                         only: tools/list never lists it (UNLISTED_HOOKS)
// Unknown ids are isError "not found: <id>". Writable fields: status, delivery_date, total (a decimal string), customer.
import { randomUUID } from "node:crypto";

export const FAKE_ERP_DEFAULT_TOKEN = "e2e-erp-token";
const PATH = "/erp-mcp";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "ocw-fake-erp-mcp", title: "OCW fake ERP MCP server", version: "1.0.0" };

/** The seed every `reset()` restores. updated_at is fixed so tests start from a known value. */
const SEED = [
  {
    id: "SO-10442",
    status: "Confirmed",
    delivery_date: "2026-10-14",
    total: "1250.00",
    customer: "Globex S.L.",
    updated_at: "2026-10-01T09:00:00.000Z",
  },
  {
    id: "SO-10443",
    status: "Draft",
    delivery_date: "2026-10-20",
    total: "980.50",
    customer: "Initech S.A.",
    updated_at: "2026-10-01T09:05:00.000Z",
  },
];

const FIELD_SCHEMA = {
  status: { type: "string", description: "Order status" },
  delivery_date: { type: "string", description: "Delivery date (YYYY-MM-DD)" },
  total: { type: "string", description: "Order total as a decimal string, e.g. 1250.00" },
  customer: { type: "string", description: "Customer name" },
};
const WRITABLE = Object.keys(FIELD_SCHEMA);
const ID = { type: "string", description: "Sales order id, e.g. SO-10442" };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const FAKE_ERP_TOOLS = [
  {
    name: "get_record",
    title: "Get sales order",
    description: "Read one sales order.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "update_record",
    title: "Update sales order",
    description:
      "Update fields of one sales order. With expectedUpdatedAt the write only applies when the order was not changed since.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        expectedUpdatedAt: { type: "string", description: "The updated_at the caller last read" },
        ...FIELD_SCHEMA,
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "add_note",
    title: "Add note",
    description: "Append a note to one sales order.",
    inputSchema: {
      type: "object",
      properties: { id: ID, text: { type: "string" } },
      required: ["id", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "list_records",
    title: "List sales orders",
    description: "List the ids of every sales order.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "__mutate",
    title: "Test hook: change elsewhere",
    description: "TEST ONLY: change fields of one sales order as another ERP user would.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        fields: { type: "object", properties: FIELD_SCHEMA, additionalProperties: false },
      },
      required: ["id", "fields"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];
const TOOL_NAMES = new Set(FAKE_ERP_TOOLS.map((t) => t.name));
/**
 * Test hooks callable through tools/call but never listed by tools/list (07.17-18): a connector another spec probes or
 * records from FAKE_ERP_TOOLS sees exactly the tools it did before, and no bot is ever offered them.
 */
const UNLISTED_HOOKS = new Set(["__add"]);

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const ok = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const fail = (text, structured) => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
  isError: true,
});

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

/** Validates writable fields: only known keys, string values. Returns an error text or null. */
function badFields(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (!WRITABLE.includes(key)) return `unknown field: ${key}`;
    if (typeof value !== "string") return `${key} must be a string`;
  }
  return null;
}

/**
 * `createFakeErpMcp({ token })` → `{ handle(req, res, url): boolean, state, reset() }`. `handle` returns true when it
 * owned the route (`/erp-mcp`). `state.records` (id → record), `state.notes` (id → texts) and `state.calls` (every
 * tools/call as received) are live; `reset()` restores the seed and forgets notes, calls and sessions.
 */
export function createFakeErpMcp(opts = {}) {
  const token = opts.token || FAKE_ERP_DEFAULT_TOKEN;
  const sessions = new Set();
  const state = { records: new Map(), notes: new Map(), calls: [] };

  function reset() {
    state.records.clear();
    state.notes.clear();
    state.calls.length = 0;
    sessions.clear();
    for (const r of SEED) {
      state.records.set(r.id, { ...r });
      state.notes.set(r.id, []);
    }
  }
  reset();

  /** Strictly later than the record's current updated_at (two writes in one millisecond still differ). */
  function bump(record) {
    const next = Math.max(Date.now(), Date.parse(record.updated_at) + 1);
    record.updated_at = new Date(next).toISOString();
  }

  const view = (record) => ({ ...record, notes: [...(state.notes.get(record.id) ?? [])] });

  /** `__add` (07.17-18): a record created elsewhere; never replaces one (an existing id is an error). */
  function add(args) {
    if (typeof args.id !== "string" || !args.id) return fail("__add: `id` must be a non-empty string");
    const fields = args.fields && typeof args.fields === "object" ? args.fields : null;
    if (!fields) return fail("__add: `fields` must be an object");
    const bad = badFields(fields);
    if (bad) return fail(`__add: ${bad}`);
    if (state.records.has(args.id)) return fail(`exists: ${args.id}`, { error: "exists", id: args.id });
    const record = {
      id: args.id,
      status: "",
      delivery_date: "",
      total: "0.00",
      customer: "",
      ...fields,
      updated_at: new Date().toISOString(),
    };
    state.records.set(record.id, record);
    state.notes.set(record.id, []);
    return ok(view(record));
  }

  function callTool(name, args) {
    state.calls.push({ name, arguments: args });
    if (name === "list_records") return ok({ ids: [...state.records.keys()] });
    if (name === "__add") return add(args);
    if (typeof args.id !== "string") return fail(`${name}: \`id\` must be a string`);
    const record = state.records.get(args.id);
    if (!record) return fail(`not found: ${args.id}`, { error: "not_found", id: args.id });
    switch (name) {
      case "get_record":
        return ok(view(record));
      case "update_record": {
        const { id: _id, expectedUpdatedAt, ...fields } = args;
        const bad = badFields(fields);
        if (bad) return fail(`update_record: ${bad}`);
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== record.updated_at) {
          return fail(
            `conflict: ${record.id} changed since ${expectedUpdatedAt} (now ${record.updated_at})`,
            {
              error: "conflict",
              id: record.id,
              updated_at: record.updated_at,
            },
          );
        }
        Object.assign(record, fields);
        bump(record);
        return ok(view(record));
      }
      case "add_note": {
        if (typeof args.text !== "string" || !args.text)
          return fail("add_note: `text` must be a non-empty string");
        state.notes.get(record.id)?.push(args.text);
        return ok({ ok: true });
      }
      case "__mutate": {
        const fields = args.fields && typeof args.fields === "object" ? args.fields : null;
        if (!fields) return fail("__mutate: `fields` must be an object");
        const bad = badFields(fields);
        if (bad) return fail(`__mutate: ${bad}`);
        Object.assign(record, fields);
        bump(record);
        return ok(view(record));
      }
      default:
        return fail(`unknown tool: ${name}`);
    }
  }

  function dispatch(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Deterministic fake ERP for OCW watched-record tests.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: FAKE_ERP_TOOLS });
      case "tools/call": {
        const name = params?.name;
        if (!TOOL_NAMES.has(name) && !UNLISTED_HOOKS.has(name))
          return rpcError(id, -32602, `Unknown tool: ${name}`);
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        return rpcResult(id, callTool(name, args));
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async function post(req, res) {
    let msg;
    try {
      msg = JSON.parse(await readRaw(req));
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0")
      return send(res, 400, rpcError(msg?.id, -32600, "Invalid request"));
    const isRequest = typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
    if (msg.method === "initialize") {
      if (!isRequest) return send(res, 400, rpcError(null, -32600, "initialize needs an id"));
      const sessionId = randomUUID();
      sessions.add(sessionId);
      return send(res, 200, dispatch(msg), { "mcp-session-id": sessionId });
    }
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId)
      return send(res, 400, rpcError(msg.id, -32000, "Bad Request: Mcp-Session-Id header is required"));
    if (!sessions.has(sessionId)) return send(res, 404, rpcError(msg.id, -32001, "Session not found"));
    if (!isRequest) return send(res, 202);
    return send(res, 200, dispatch(msg));
  }

  function handle(req, res, url) {
    if (url.pathname !== PATH) return false;
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="ocw-fake-erp-mcp"' });
      return true;
    }
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions.delete(sessionId))
        send(res, 404, rpcError(null, -32001, "Session not found"));
      else send(res, 204);
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, rpcError(null, -32000, "Method not allowed"), { allow: "POST, DELETE" });
      return true;
    }
    post(req, res).catch((error) => {
      if (!res.headersSent)
        send(res, 500, rpcError(null, -32603, error instanceof Error ? error.message : "error"));
      else res.end();
    });
    return true;
  }

  return { handle, state, reset };
}
