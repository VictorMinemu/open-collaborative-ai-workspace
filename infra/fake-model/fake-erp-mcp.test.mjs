// node --test infra/fake-model/fake-erp-mcp.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeErpMcp, FAKE_ERP_TOOLS } from "./fake-erp-mcp.mjs";

const TOKEN = "erp-test-token";

describe("fake ERP MCP (07.6-04, D-04 / A6)", () => {
  /** @type {import("node:http").Server} */
  let server;
  let base = "";
  let erp;
  let session = "";
  let nextId = 1;

  async function rpc(method, params, { token = TOKEN, withSession = true } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (withSession && session) headers["mcp-session-id"] = session;
    const res = await fetch(`${base}/erp-mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
    });
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : null };
  }
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).body.result;

  before(async () => {
    erp = createFakeErpMcp({ token: TOKEN });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (erp.handle(req, res, url)) return;
      res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((r) => server.close(r)));

  beforeEach(async () => {
    erp.reset();
    session = "";
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    assert.equal(init.res.status, 200);
    session = init.res.headers.get("mcp-session-id") ?? "";
    assert.ok(session);
  });

  it("initialize answers as the fake ERP", async () => {
    session = "";
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.body.result.serverInfo.name, "ocw-fake-erp-mcp");
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
  });

  it("tools/list lists the five tools with input schemas", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["__mutate", "add_note", "get_record", "list_records", "update_record"]);
    for (const tool of body.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.description, "string");
    }
    assert.deepEqual(names, FAKE_ERP_TOOLS.map((t) => t.name).sort());
    const get = body.result.tools.find((t) => t.name === "get_record");
    assert.equal(get.annotations.readOnlyHint, true);
  });

  it("get_record returns structured content with total as a string", async () => {
    const r = await call("get_record", { id: "SO-10442" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.id, "SO-10442");
    assert.equal(r.structuredContent.status, "Confirmed");
    assert.equal(r.structuredContent.delivery_date, "2026-10-14");
    assert.equal(r.structuredContent.total, "1250.00");
    assert.equal(typeof r.structuredContent.total, "string");
    assert.equal(r.structuredContent.customer, "Globex S.L.");
    assert.match(r.structuredContent.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    // The text content carries the same record as JSON (clients without structured content).
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  });

  it("list_records returns the seeded ids", async () => {
    const r = await call("list_records", {});
    assert.deepEqual(r.structuredContent.ids, ["SO-10442", "SO-10443"]);
  });

  it("update_record with the current updated_at changes the fields and bumps updated_at", async () => {
    const before = (await call("get_record", { id: "SO-10442" })).structuredContent;
    const r = await call("update_record", {
      id: "SO-10442",
      expectedUpdatedAt: before.updated_at,
      delivery_date: "2026-10-21",
    });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.delivery_date, "2026-10-21");
    assert.ok(r.structuredContent.updated_at > before.updated_at);
    const after = (await call("get_record", { id: "SO-10442" })).structuredContent;
    assert.equal(after.delivery_date, "2026-10-21");
    assert.equal(after.status, "Confirmed");
    assert.equal(after.updated_at, r.structuredContent.updated_at);
  });

  it("update_record without expectedUpdatedAt is an unconditional write", async () => {
    const r = await call("update_record", { id: "SO-10443", status: "Confirmed" });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.status, "Confirmed");
  });

  it("update_record with a stale expectedUpdatedAt is a conflict error and changes nothing", async () => {
    const before = (await call("get_record", { id: "SO-10442" })).structuredContent;
    await call("__mutate", { id: "SO-10442", fields: { status: "On hold" } });
    const mid = (await call("get_record", { id: "SO-10442" })).structuredContent;
    const r = await call("update_record", {
      id: "SO-10442",
      expectedUpdatedAt: before.updated_at,
      delivery_date: "2026-11-01",
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /conflict/);
    assert.equal(r.structuredContent.error, "conflict");
    assert.equal(r.structuredContent.updated_at, mid.updated_at);
    assert.deepEqual((await call("get_record", { id: "SO-10442" })).structuredContent, mid);
  });

  it("update_record refuses unknown fields and a non-string total", async () => {
    const unknown = await call("update_record", { id: "SO-10442", colour: "red" });
    assert.equal(unknown.isError, true);
    const numeric = await call("update_record", { id: "SO-10442", total: 12 });
    assert.equal(numeric.isError, true);
    assert.equal((await call("get_record", { id: "SO-10442" })).structuredContent.total, "1250.00");
  });

  it("add_note appends to the record's notes without bumping updated_at", async () => {
    const before = (await call("get_record", { id: "SO-10442" })).structuredContent;
    const r = await call("add_note", {
      id: "SO-10442",
      text: "Updated from OCW by Archie for Ana: delivery_date",
    });
    assert.deepEqual(r.structuredContent, { ok: true });
    await call("add_note", { id: "SO-10442", text: "second" });
    const after = (await call("get_record", { id: "SO-10442" })).structuredContent;
    assert.equal(after.updated_at, before.updated_at);
    assert.deepEqual(erp.state.notes.get("SO-10442"), [
      "Updated from OCW by Archie for Ana: delivery_date",
      "second",
    ]);
  });

  it("__mutate changes fields and bumps updated_at (a change made elsewhere)", async () => {
    const before = (await call("get_record", { id: "SO-10442" })).structuredContent;
    const r = await call("__mutate", { id: "SO-10442", fields: { total: "1310.00", status: "Shipped" } });
    assert.equal(r.isError, undefined);
    const after = (await call("get_record", { id: "SO-10442" })).structuredContent;
    assert.equal(after.total, "1310.00");
    assert.equal(after.status, "Shipped");
    assert.ok(after.updated_at > before.updated_at);
  });

  it("unknown ids are an isError 'not found' on every record tool", async () => {
    for (const [name, args] of [
      ["get_record", { id: "SO-1" }],
      ["update_record", { id: "SO-1", status: "x" }],
      ["add_note", { id: "SO-1", text: "x" }],
      ["__mutate", { id: "SO-1", fields: { status: "x" } }],
    ]) {
      const r = await call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /not found/, name);
    }
  });

  it("records every tools/call in state.calls (tests read what the API sent)", async () => {
    await call("get_record", { id: "SO-10443" });
    assert.deepEqual(erp.state.calls.at(-1), { name: "get_record", arguments: { id: "SO-10443" } });
  });

  it("a request without the bearer token, or with another token, is 401", async () => {
    const none = await rpc("tools/list", undefined, { token: "" });
    assert.equal(none.res.status, 401);
    assert.match(none.res.headers.get("www-authenticate") ?? "", /Bearer/);
    const other = await rpc("tools/list", undefined, { token: "e2e-mcp-token" });
    assert.equal(other.res.status, 401);
  });

  it("requires the session after initialize; unknown methods and tools are JSON-RPC errors", async () => {
    const noSession = await rpc("tools/list", undefined, { withSession: false });
    assert.equal(noSession.res.status, 400);
    const unknownTool = await rpc("tools/call", { name: "drop_table", arguments: {} });
    assert.equal(unknownTool.body.error.code, -32602);
    const unknownMethod = await rpc("resources/list");
    assert.equal(unknownMethod.body.error.code, -32601);
  });

  it("reset() restores the seed", async () => {
    await call("__mutate", { id: "SO-10442", fields: { status: "Cancelled" } });
    erp.reset();
    assert.equal(erp.state.records.get("SO-10442").status, "Confirmed");
  });

  it("owns only its own path", () => {
    const res = { writeHead() {}, end() {} };
    assert.equal(erp.handle({ headers: {} }, res, new URL("http://x/mcp")), false);
    assert.equal(erp.handle({ headers: {} }, res, new URL("http://x/erp-mcp-other")), false);
  });
});
