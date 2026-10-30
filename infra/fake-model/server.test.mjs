// node --test infra/fake-model/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakeClawhub } from "./fake-clawhub.mjs";
import { createFakeMcp } from "./fake-mcp.mjs";
import { composeReply, createFakeModelServer, humanNames, parseDirectives, planToolStep } from "./server.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/openclaw-2026.9.7-chat-request.json", import.meta.url), "utf8"),
);

describe("composeReply", () => {
  it("answers the structured sender and human participants from a real OpenClaw prompt", () => {
    const text = fixture.messages.map((m) => m.content).join("\n\n");
    assert.equal(
      composeReply(text, 0),
      "Hi Víctor Ruiz! (participants: Alex, Víctor Ruiz) [asker id: 0199a000-0000-7000-8000-0000000u0001] [tools: 0]",
    );
  });

  it("falls back gracefully without context", () => {
    assert.equal(composeReply("hello", 3), "Hi there! [tools: 3]");
  });

  it("names the offered tools (sorted) when there are any", () => {
    assert.equal(
      composeReply("hello", 2, ["web_search", "web_fetch"]),
      "Hi there! [tools: 2 | web_fetch,web_search]",
    );
    assert.equal(composeReply("hello", 0, []), "Hi there! [tools: 0]");
  });

  it("excludes agents from the participant list", () => {
    assert.deepEqual(humanNames("Víctor <u1>, Archie (agent) <a1>, Alex <u2>"), ["Alex", "Víctor"]);
  });
});

describe("planToolStep (OpenClaw message layout)", () => {
  const ctx =
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions): {}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const offered = ["web_search", "web_fetch"];

  it("finds the directive in the human's message when the context block comes as a separate, later user message", () => {
    const step = planToolStep(
      [
        { role: "system", content: "sys" },
        { role: "user", content: '@archie what is new? [[call web_search {"query":"ocw smoke"}]]' },
        { role: "user", content: ctx },
      ],
      offered,
    );
    assert.deepEqual(step?.call?.name, "web_search");
  });

  it("after the tool result OpenClaw appends the context again: the turn completes from the result", () => {
    const step = planToolStep(
      [
        { role: "user", content: '@archie [[call web_search {"query":"ocw smoke"}]]' },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: '{"results":[{"title":"OCW smoke result"}]}' },
        { role: "user", content: ctx },
      ],
      offered,
    );
    assert.ok(step?.reply, "expected a final reply once the directive has a result");
  });

  it("an earlier turn's directive is never re-run when the newest human message has none", () => {
    const step = planToolStep(
      [
        { role: "user", content: '[[call web_search {"query":"old"}]]' },
        { role: "assistant", content: "done" },
        { role: "user", content: "thanks!" },
        { role: "user", content: ctx },
      ],
      offered,
    );
    assert.equal(step, null);
  });
});

describe("planToolStep: a ref read from the latest snapshot (07.8-28)", () => {
  it("`{{ref:<name>}}` in a directive's arguments becomes the ref of the element with that name in the turn's latest tool result", () => {
    const offered = ["ocw_browser_snapshot", "ocw_browser_act"];
    const ask =
      '[[call ocw_browser_snapshot {}]] [[call ocw_browser_act {"action":"click","ref":"{{ref:Export}}"}]]';
    const snapshot =
      'Page: “Orders” on panel.fake.test:8080\n- [e3] heading "Orders"\n  - [e17] link "Export"';
    const step = planToolStep(
      [
        { role: "user", content: ask },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "ocw_browser_snapshot", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: snapshot },
      ],
      offered,
    );
    assert.deepEqual(step?.call, { name: "ocw_browser_act", args: { action: "click", ref: "e17" } });
    // No such element yet: the placeholder stays (the API answers element_gone).
    const none = planToolStep(
      [{ role: "user", content: '[[call ocw_browser_act {"action":"click","ref":"{{ref:Export}}"}]]' }],
      offered,
    );
    assert.deepEqual(none?.call?.args, { action: "click", ref: "{{ref:Export}}" });
  });
});

describe("parseDirectives", () => {
  it("finds [[call <tool> <json>]] directives in order, JSON with brackets included", () => {
    assert.deepEqual(
      parseDirectives(
        'a [[call web_search {"query":"ocw [x]"}]] b [[call web_fetch {"url":"https://e.x/a"}]]',
      ),
      [
        { tool: "web_search", args: { query: "ocw [x]" } },
        { tool: "web_fetch", args: { url: "https://e.x/a" } },
      ],
    );
    assert.deepEqual(parseDirectives("no directive [[call broken {nope]]"), []);
  });
});

describe("HTTP surface", () => {
  let server;
  let base;
  before(async () => {
    server = createFakeModelServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it("lists models", async () => {
    const res = await fetch(`${base}/v1/models`);
    const body = await res.json();
    assert.ok(body.data.some((m) => m.id === "mock-1"));
  });

  it("streams OpenAI chat completions with usage and [DONE]", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fixture, stream_options: { include_usage: true } }),
    });
    const raw = await res.text();
    assert.match(raw, /data: \[DONE\]/u);
    const text = raw
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)))
      .flatMap((c) => c.choices.map((ch) => ch.delta?.content ?? ""))
      .join("");
    assert.equal(text.startsWith("Hi Víctor Ruiz!"), true);
    assert.match(raw, /"usage"/u);
  });

  const WEB_TOOLS = [
    { type: "function", function: { name: "web_search", parameters: { type: "object" } } },
    { type: "function", function: { name: "web_fetch", parameters: { type: "object" } } },
  ];
  const userTurn = (text) => [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nhistory: [[call web_fetch {"url":"https://old.example/"}]]\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\n\n${text}`,
    },
  ];
  const post = async (body) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-1", ...body }),
    });
    return res.json();
  };
  /** Collects a streamed OpenAI response into {content, toolCalls, finish}. */
  const postStream = async (body) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-1", stream: true, ...body }),
    });
    const chunks = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    const calls = [];
    let content = "";
    let finish = null;
    for (const c of chunks) {
      for (const ch of c.choices) {
        content += ch.delta?.content ?? "";
        for (const tc of ch.delta?.tool_calls ?? []) {
          calls[tc.index] ??= { id: "", name: "", arguments: "" };
          if (tc.id) calls[tc.index].id = tc.id;
          if (tc.function?.name) calls[tc.index].name = tc.function.name;
          calls[tc.index].arguments += tc.function?.arguments ?? "";
        }
        finish = ch.finish_reason ?? finish;
      }
    }
    return { content, calls, finish };
  };

  it("a [[call]] directive for an offered tool returns an OpenAI tool_calls response", async () => {
    const body = await post({
      tools: WEB_TOOLS,
      messages: userTurn('look it up [[call web_search {"query":"ocw"}]]'),
    });
    const choice = body.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].function.name, "web_search");
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { query: "ocw" });
  });

  it("answers from the tool result on the follow-up request, naming the offered tools", async () => {
    const messages = [
      ...userTurn('look it up [[call web_search {"query":"ocw"}]]'),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"ocw"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ results: [{ title: "Fake result for ocw" }] }),
      },
    ];
    const streamed = await postStream({ tools: WEB_TOOLS, messages });
    assert.equal(streamed.calls.length, 0);
    assert.match(streamed.content, /^Tool web_search said: .*Fake result for ocw/u);
    assert.ok(streamed.content.endsWith("[tools: 2 | web_fetch,web_search]"));
  });

  it("summarises an OpenClaw-wrapped search result by its titles (markers removed)", async () => {
    const wrapped = (t) =>
      `<<<EXTERNAL_UNTRUSTED_CONTENT id="x">>>\nSource: Web Search\n---\n${t}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="x">>>`;
    const payload = {
      query: "ocw",
      provider: "searxng",
      count: 1,
      externalContent: { untrusted: true },
      tookMs: 1,
    };
    const text = `Search results:\n${JSON.stringify({ ...payload, results: [{ title: wrapped("Fake result for ocw smoke"), url: "https://e.x/" }] }, null, 2)}`;
    const messages = [
      ...userTurn('[[call web_search {"query":"ocw smoke"}]]'),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: text },
    ];
    const body = await post({ tools: WEB_TOOLS, messages });
    assert.equal(
      body.choices[0].message.content,
      "Tool web_search said: Fake result for ocw smoke [tools: 2 | web_fetch,web_search]",
    );
  });

  it("runs two directives in order across two model steps (streaming)", async () => {
    const first = userTurn(
      '[[call web_search {"query":"a"}]] then [[call web_fetch {"url":"https://docs.example.com/x"}]]',
    );
    const s1 = await postStream({ tools: WEB_TOOLS, messages: first });
    assert.equal(s1.finish, "tool_calls");
    assert.equal(s1.calls[0].name, "web_search");
    const step2 = [
      ...first,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: s1.calls[0].id,
            type: "function",
            function: { name: "web_search", arguments: s1.calls[0].arguments },
          },
        ],
      },
      { role: "tool", tool_call_id: s1.calls[0].id, content: "search said A" },
    ];
    const s2 = await postStream({ tools: WEB_TOOLS, messages: step2 });
    assert.equal(s2.calls[0].name, "web_fetch");
    assert.deepEqual(JSON.parse(s2.calls[0].arguments), { url: "https://docs.example.com/x" });
    const step3 = [
      ...step2,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: s2.calls[0].id,
            type: "function",
            function: { name: "web_fetch", arguments: s2.calls[0].arguments },
          },
        ],
      },
      { role: "tool", tool_call_id: s2.calls[0].id, content: [{ type: "text", text: "page said B" }] },
    ];
    const s3 = await postStream({ tools: WEB_TOOLS, messages: step3 });
    assert.equal(s3.calls.length, 0);
    assert.equal(
      s3.content,
      "Tool web_search said: search said A\nTool web_fetch said: page said B [tools: 2 | web_fetch,web_search]",
    );
  });

  it("a directive for a tool that is not offered is answered, never called", async () => {
    const body = await post({
      tools: [WEB_TOOLS[1]],
      messages: userTurn('[[call web_search {"query":"x"}]]'),
    });
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.choices[0].message.content, "Tool web_search not offered [tools: 1 | web_fetch]");
  });

  it("with no tools offered the reply still ends [tools: 0]", async () => {
    const body = await post({ messages: userTurn('[[call web_search {"query":"x"}]]') });
    assert.ok(body.choices[0].message.content.endsWith("[tools: 0]"));
    assert.equal(body.choices[0].message.content, "Tool web_search not offered [tools: 0]");
  });

  it("matches namespaced tool names ending in __<tool> (MCP servers)", async () => {
    const body = await post({
      tools: [{ type: "function", function: { name: "m3f9a12c4__echo" } }],
      messages: userTurn('[[call echo {"text":"hi"}]]'),
    });
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "m3f9a12c4__echo");
  });

  it("serves a deterministic fake SearXNG JSON search", async () => {
    const res = await fetch(`${base}/search?q=ocw&format=json`);
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, "Fake result for ocw");
    assert.match(body.results[0].url, /^https:\/\//u);
  });

  it("speaks Anthropic messages (non-stream)", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-1",
        system: "x",
        messages: fixture.messages.slice(1),
        tools: [{ name: "t" }],
      }),
    });
    const body = await res.json();
    assert.equal(body.content[0].text.endsWith("[tools: 1 | t]"), true);
  });

  // 06-03 (P-06): the API's multiplayer prompt (roster in the instructions, <turn_context> last) is answered by name.
  const ROSTER =
    'Shared conversation.\n<participants>\n- name="Víctor Ruiz" user_id="u1" role="admin" access="owner"\n- name="Alex Kim" user_id="u2" role="developer" access="chat"\n</participants>';
  const TURN =
    '<message from="Víctor Ruiz" user_id="u1" at="2026-10-07T10:00:00Z">\nWhat about cost?\n</message>\n\n<turn_context>\n<responding_to name="Víctor Ruiz" user_id="u1"/>\n</turn_context>';
  const ATTRIBUTED = "Hi Víctor Ruiz! (participants: Alex Kim, Víctor Ruiz) Echo: What about cost?";

  it("chat completions (non-stream): an attributed prompt answers the asker by name", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-1",
        messages: [
          { role: "developer", content: ROSTER },
          { role: "user", content: TURN },
        ],
      }),
    });
    assert.equal((await res.json()).choices[0].message.content, ATTRIBUTED);
  });

  it("chat completions: a [[call]] directive in an attributed prompt still calls the tool first", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-1",
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
        messages: [
          { role: "system", content: ROSTER },
          { role: "user", content: TURN.replace("What about cost?", '[[call echo {"text":"hi"}]]') },
        ],
      }),
    });
    const body = await res.json();
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "echo");
  });

  it("anthropic (non-stream, string system): an attributed prompt answers the asker by name", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-1", system: ROSTER, messages: [{ role: "user", content: TURN }] }),
    });
    assert.equal((await res.json()).content[0].text, ATTRIBUTED);
  });
});

// ---------------------------------------------------------------- fake MCP server (03.1-09, D-13 / D-15)

/** JSON-RPC over the streamable HTTP transport (single JSON responses). */
async function rpc(base, body, { session, token, protocol } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  if (protocol) headers["mcp-protocol-version"] = protocol;
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function initialize(base, opts = {}) {
  const res = await rpc(
    base,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: opts.version ?? "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    opts,
  );
  return { res, body: await res.json(), session: res.headers.get("mcp-session-id") };
}

/** Reads SSE events (`{event, data}`) from a fetch body until `count` events arrived. */
async function readEvents(reader, count, state) {
  const decoder = new TextDecoder();
  while (state.events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    state.buf += decoder.decode(value, { stream: true });
    let idx = state.buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = state.buf.slice(0, idx);
      state.buf = state.buf.slice(idx + 2);
      const ev = { event: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("data: ")) ev.data += line.slice(6);
      }
      if (ev.data) state.events.push(ev);
      idx = state.buf.indexOf("\n\n");
    }
  }
  return state.events;
}

describe("fake MCP server: streamable HTTP", () => {
  let server;
  let base;
  before(async () => {
    server = createFakeModelServer({ mcpToken: "" });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  it("initialize negotiates the protocol version and issues a session id", async () => {
    const { res, body, session } = await initialize(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/u);
    assert.ok(session && session.length >= 16);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, "2025-06-18");
    assert.ok(body.result.capabilities.tools);
    assert.equal(body.result.serverInfo.name, "ocw-fake-mcp");
    // An unsupported version gets the newest supported one.
    const newest = await initialize(base, { version: "1999-01-01" });
    assert.equal(newest.body.result.protocolVersion, "2025-11-25");
  });

  it("notifications/initialized → 202; tools/list returns echo (read-only) and write_note (destructive)", async () => {
    const { session } = await initialize(base);
    const note = await rpc(base, { jsonrpc: "2.0", method: "notifications/initialized" }, { session });
    assert.equal(note.status, 202);
    const res = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { session });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.deepEqual(
      result.tools.map((t) => t.name),
      ["echo", "write_note"],
    );
    const [echo, writeNote] = result.tools;
    assert.equal(echo.annotations.readOnlyHint, true);
    assert.equal(writeNote.annotations.destructiveHint, true);
    assert.equal(writeNote.annotations.readOnlyHint, false);
    assert.equal(echo.inputSchema.type, "object");
    assert.equal(result.nextCursor, undefined);
  });

  it("tools/call echo and write_note; unknown tools and methods are JSON-RPC errors", async () => {
    const { session } = await initialize(base);
    const call = async (id, name, args) =>
      (
        await rpc(
          base,
          { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
          { session },
        )
      ).json();
    const echo = await call(3, "echo", { text: "hi" });
    assert.equal(echo.result.content[0].type, "text");
    assert.equal(echo.result.content[0].text, "echo: hi");
    assert.notEqual(echo.result.isError, true);
    const note = await call(4, "write_note", { title: "Plan", text: "Ship it" });
    assert.equal(note.result.content[0].text, "noted: Plan");
    const bad = await call(5, "echo", { text: 42 });
    assert.equal(bad.result.isError, true);
    const unknown = await call(6, "nope", {});
    assert.equal(unknown.error.code, -32602);
    const method = await (
      await rpc(base, { jsonrpc: "2.0", id: 7, method: "resources/list" }, { session })
    ).json();
    assert.equal(method.error.code, -32601);
    const ping = await (await rpc(base, { jsonrpc: "2.0", id: 8, method: "ping" }, { session })).json();
    assert.deepEqual(ping.result, {});
  });

  it("requires the session after initialize; DELETE ends it; GET answers 405", async () => {
    const missing = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(missing.status, 400);
    const unknown = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { session: "nope" });
    assert.equal(unknown.status, 404);
    const { session } = await initialize(base);
    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": session } });
    assert.equal(del.status, 204);
    const after = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { session });
    assert.equal(after.status, 404);
    const get = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    assert.equal(get.status, 405);
    const parse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(parse.status, 400);
    assert.equal((await parse.json()).error.code, -32700);
  });

  it("existing fake-model routes are unchanged", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

describe("fake MCP server: bearer token (FAKE_MCP_TOKEN)", () => {
  let server;
  let base;
  before(async () => {
    server = createFakeModelServer({ mcpToken: "fake-mcp-token" });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  it("refuses requests without the bearer token with 401, accepts them with it", async () => {
    const without = await initialize(base);
    assert.equal(without.res.status, 401);
    assert.match(without.res.headers.get("www-authenticate") ?? "", /Bearer/u);
    const wrong = await initialize(base, { token: "other" });
    assert.equal(wrong.res.status, 401);
    const sse = await fetch(`${base}/sse`);
    assert.equal(sse.status, 401);
    const ok = await initialize(base, { token: "fake-mcp-token" });
    assert.equal(ok.res.status, 200);
    // Model routes never need the MCP token.
    assert.equal((await fetch(`${base}/v1/models`)).status, 200);
  });
});

describe("fake MCP server: legacy HTTP+SSE transport", () => {
  let server;
  let base;
  before(async () => {
    server = createFakeModelServer({ mcpToken: "" });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  it("GET /sse announces the endpoint; POST /sse/messages answers tools/list on the stream", async () => {
    const abort = new AbortController();
    const stream = await fetch(`${base}/sse`, {
      headers: { accept: "text/event-stream" },
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/u);
    const reader = stream.body.getReader();
    const state = { buf: "", events: [] };
    try {
      const [endpoint] = await readEvents(reader, 1, state);
      assert.equal(endpoint.event, "endpoint");
      assert.match(endpoint.data, /^\/sse\/messages\?sessionId=[\w-]+$/u);
      const post = (body) =>
        fetch(new URL(endpoint.data, base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const init = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      assert.equal(init.status, 202);
      assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
      assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 202);
      const events = await readEvents(reader, 3, state);
      const [initEv, listEv] = events.slice(1).map((e) => ({ event: e.event, msg: JSON.parse(e.data) }));
      assert.equal(initEv.event, "message");
      assert.equal(initEv.msg.result.protocolVersion, "2025-03-26");
      assert.equal(initEv.msg.result.serverInfo.name, "ocw-fake-mcp");
      assert.deepEqual(
        listEv.msg.result.tools.map((t) => t.name),
        ["echo", "write_note"],
      );
      assert.equal(listEv.msg.id, 2);
      const unknown = await fetch(`${base}/sse/messages?sessionId=nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      assert.equal(unknown.status, 404);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

describe("fake ClawHub (03.1-11)", () => {
  let server;
  let base;
  let dir;
  const tarball = Buffer.from("fake npm-pack bytes for @ocw-test/notes-plugin@1.0.0\n".repeat(40));
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const enc = encodeURIComponent;
  const notes = `/api/v1/packages/${enc("@ocw-test/notes-plugin")}`;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fake-clawhub-"));
    writeFileSync(path.join(dir, "ocw-test-notes-plugin-1.0.0.tgz"), tarball);
    server = createFakeModelServer({ mcpToken: "", clawhubArtifactDir: dir });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return {
      status: res.status,
      body: res.headers.get("content-type")?.includes("json") ? await res.json() : null,
    };
  };

  it("searches packages by text (q=duck → the official DuckDuckGo plugin)", async () => {
    const { status, body } = await get("/api/v1/packages/search?q=duck&family=code-plugin&limit=10");
    assert.equal(status, 200);
    const names = body.results.map((r) => r.package.name);
    assert.deepEqual(names, ["@openclaw/duckduckgo-plugin"]);
    const pkg = body.results[0].package;
    assert.equal(pkg.channel, "official");
    assert.equal(pkg.runtimeId, "duckduckgo");
    assert.equal(pkg.latestVersion, "2026.9.7");
    assert.equal(pkg.verificationTier, "source-linked");
    assert.equal((await get("/api/v1/packages/search?q=zzz-nothing")).body.results.length, 0);
  });

  it("browses the catalog with a cursor", async () => {
    const first = await get("/api/v1/plugins?limit=3");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 3);
    assert.ok(first.body.nextCursor);
    const second = await get(`/api/v1/plugins?limit=3&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.items.length, 2);
    assert.equal(second.body.nextCursor, null);
  });

  it("serves package, versions, version, security and detail from the fixtures", async () => {
    const pkg = await get(notes);
    assert.equal(pkg.status, 200);
    assert.equal(pkg.body.package.latestVersion, "1.1.0");
    assert.equal(pkg.body.owner.handle, "ocw-test");

    const versions = await get(`${notes}/versions`);
    assert.deepEqual(
      versions.body.items.map((v) => v.version),
      ["1.1.0", "1.0.0"],
    );

    const v = await get(`${notes}/versions/1.0.0`);
    assert.equal(v.body.version.version, "1.0.0");
    assert.deepEqual(v.body.version.pluginManifestSummary.contracts.tools, ["notes_lookup"]);

    const sec = await get(`${notes}/versions/1.0.0/security`);
    assert.equal(sec.body.trust.blockedFromDownload, false);
    assert.equal(sec.body.trust.scanStatus, "clean");

    const detail = await get(`${notes}/detail?version=1.0.0`);
    assert.equal(detail.body.version.version, "1.0.0");
    assert.equal(detail.body.package.name, "@ocw-test/notes-plugin");
    assert.equal(detail.body.security.trust.pending, false);
    assert.equal(detail.body.versions.items.length, 2);
    const latest = await get(`${notes}/detail`);
    assert.equal(latest.body.version.version, "1.1.0");
  });

  it("reports the real digest of a tarball present in the artifact dir and streams it", async () => {
    const v = await get(`${notes}/versions/1.0.0`);
    assert.equal(v.body.version.artifact.sha256, sha256);
    assert.equal(v.body.version.artifact.size, tarball.length);
    assert.match(v.body.version.artifact.npmIntegrity, /^sha512-/u);
    const detail = await get(`${notes}/detail?version=1.0.0`);
    assert.equal(detail.body.version.artifact.sha256, sha256);

    const meta = await get(`${notes}/versions/1.0.0/artifact`);
    assert.equal(meta.body.artifact.sha256, sha256);

    const res = await fetch(`${base}${notes}/versions/1.0.0/artifact/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-clawhub-artifact-sha256"), sha256);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);

    // No tarball on disk for 1.1.0: fixture digest, and no download.
    const v11 = await get(`${notes}/versions/1.1.0`);
    assert.equal(v11.body.version.artifact.sha256, "1b".repeat(32));
    assert.equal((await fetch(`${base}${notes}/versions/1.1.0/artifact/download`)).status, 404);
  });

  it("answers 404 for unknown packages and versions", async () => {
    assert.equal((await get(`/api/v1/packages/${enc("@nobody/nothing")}`)).status, 404);
    assert.equal((await get(`/api/v1/packages/${enc("@nobody/nothing")}/detail`)).status, 404);
    assert.equal((await get(`${notes}/versions/9.9.9`)).status, 404);
    assert.equal((await get(`${notes}/detail?version=9.9.9`)).status, 404);
  });

  it("does not shadow the model routes", async () => {
    assert.equal((await get("/v1/models")).status, 200);
  });
});

describe("createFakeClawhub (in-process controls)", () => {
  it("records request headers, mutates fixtures and simulates outages", async () => {
    const fake = createFakeClawhub();
    const http = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!fake(req, res, url)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${http.address().port}`;
    try {
      await fetch(`${base}/api/v1/packages/search?q=notes`, {
        headers: { "user-agent": "ocw-marketplace-proxy" },
      });
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].path, "/api/v1/packages/search");
      assert.equal(fake.requests[0].headers["user-agent"], "ocw-marketplace-proxy");

      fake
        .version("@ocw-test/notes-plugin", "1.0.0")
        .pluginManifestSummary.contracts.tools.push("notes_delete");
      const v = await (
        await fetch(`${base}/api/v1/packages/${encodeURIComponent("@ocw-test/notes-plugin")}/versions/1.0.0`)
      ).json();
      assert.deepEqual(v.version.pluginManifestSummary.contracts.tools, ["notes_lookup", "notes_delete"]);

      fake.setOutage({ status: 503 });
      assert.equal((await fetch(`${base}/api/v1/packages/search?q=notes`)).status, 503);
      fake.setOutage(null);
      fake.reset();
      const again = await (
        await fetch(`${base}/api/v1/packages/${encodeURIComponent("@ocw-test/notes-plugin")}/versions/1.0.0`)
      ).json();
      assert.deepEqual(again.version.pluginManifestSummary.contracts.tools, ["notes_lookup"]);
      assert.equal(fake.requests.length, 1);
    } finally {
      await new Promise((r) => http.close(r));
    }
  });
});

// ---------------------------------------------------------------- fake MCP tool-call hook (07.5-15 real-cell smoke)

describe("fake MCP onToolCall", () => {
  it("reports every tools/call with exactly the arguments the server received", async () => {
    const calls = [];
    const mcp = createFakeMcp({ onToolCall: (c) => calls.push(c) });
    const http = createServer((req, res) => {
      if (!mcp(req, res, new URL(req.url ?? "/", "http://fake"))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${http.address().port}`;
    try {
      const { session } = await initialize(base);
      const args = { title: "Globex invoice", text: "Invoice for Globex, 1,250 EUR" };
      const res = await rpc(
        base,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_note", arguments: args } },
        { session },
      );
      assert.equal((await res.json()).result.content[0].text, "noted: Globex invoice");
      assert.deepEqual(calls, [{ name: "write_note", arguments: args }]);
    } finally {
      await new Promise((r) => http.close(r));
    }
  });
});

describe("[[pause:N]] (07.8-08: a model that thinks before its first tool call)", () => {
  const offered = ["ocw_sandbox_exec"];
  const ask = '[[pause:8]] [[call ocw_sandbox_exec {"argv":["true"]}]]';

  it("the first tool call of the turn waits N seconds; the reply step does not", () => {
    const first = planToolStep([{ role: "user", content: ask }], offered);
    assert.equal(first?.call?.name, "ocw_sandbox_exec");
    assert.equal(first?.pauseMs, 8000);
    const done = planToolStep(
      [
        { role: "user", content: ask },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "ocw_sandbox_exec", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "exit 0" },
      ],
      offered,
    );
    assert.ok(done?.reply);
    assert.equal(done?.pauseMs, undefined);
  });

  it("is capped at 30 s and absent without the directive", () => {
    const capped = planToolStep(
      [{ role: "user", content: '[[pause:99]] [[call ocw_sandbox_exec {"argv":["true"]}]]' }],
      offered,
    );
    assert.equal(capped?.pauseMs, 30_000);
    const plain = planToolStep(
      [{ role: "user", content: '[[call ocw_sandbox_exec {"argv":["true"]}]]' }],
      offered,
    );
    assert.equal(plain?.pauseMs, undefined);
  });

  it("an OpenAI request with the directive answers its tool call only after the pause", async () => {
    const server = createFakeModelServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const started = Date.now();
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-1",
          messages: [{ role: "user", content: '[[pause:1]] [[call ocw_sandbox_exec {"argv":["true"]}]]' }],
          tools: [{ type: "function", function: { name: "ocw_sandbox_exec", parameters: {} } }],
        }),
      });
      const body = await res.json();
      assert.ok(Date.now() - started >= 1000, "answered after the pause");
      assert.equal(body.choices[0].message.tool_calls[0].function.name, "ocw_sandbox_exec");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("/__sandboxd (07.8-08: the e2e harness's fake sandboxd)", () => {
  const TOKEN = "e2e-sandbox-token-test-0123456789abcdef";

  async function withServer(opts, fn) {
    const server = createFakeModelServer(opts);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  it("serves the fake sandboxd behind its token: info 200, no token 401, policy gate, an exec round trip", async () => {
    await withServer({ sandboxToken: TOKEN }, async (base) => {
      const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      const info = await fetch(`${base}/__sandboxd/v1/info`, { headers: auth });
      assert.equal(info.status, 200);
      assert.equal((await info.json()).dockerOk, true);
      assert.equal((await fetch(`${base}/__sandboxd/v1/info`)).status, 401);
      const target = {
        orgId: "00000000-0000-4000-8000-000000000001",
        agentId: "00000000-0000-4000-8000-000000000002",
      };
      const ensure = () =>
        fetch(`${base}/__sandboxd/v1/sandboxes/ensure`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ target }),
        });
      // Fail closed like the real sandboxd: no container op before the API pushes the organization's policy.
      const refused = await ensure();
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error.code, "policy_missing");
      // The organization's policy, as the API pushes it (e2e/support/sandbox.ts seedPolicy).
      const limits = {
        nanoCpus: 1_000_000_000,
        memoryBytes: 1024 ** 3,
        pids: 256,
        diskQuotaBytes: 2 * 1024 ** 3,
        idleStopMs: 900_000,
      };
      const pushed = await fetch(`${base}/__sandboxd/v1/policy`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          orgId: target.orgId,
          sandboxEgress: "off",
          browserEgress: "off",
          allowHosts: [],
          privateHosts: [],
          limits,
          browserLimits: { ...limits, memoryBytes: 2 * 1024 ** 3, pids: 512, idleStopMs: 300_000 },
          killed: false,
          version: 0,
        }),
      });
      assert.equal(pushed.status, 200);
      assert.equal((await ensure()).status, 200);
      const exec = await fetch(`${base}/__sandboxd/v1/sandboxes/exec`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ target, argv: ["echo", "hi"], cwd: "", timeoutMs: 5000, yieldMs: 5000 }),
      });
      assert.equal((await exec.json()).stdout, "hi\n");
      // The test controls live under the same prefix (no token, as in fake-sandboxd.mjs).
      const stats = await (await fetch(`${base}/__sandboxd/__control/stats`)).json();
      assert.equal(stats.calls.exec, 1);
    });
  });

  it("is not mounted without a token", async () => {
    await withServer({ sandboxToken: "" }, async (base) => {
      assert.equal((await fetch(`${base}/__sandboxd/v1/info`)).status, 404);
    });
  });
});

// ---------------------------------------------------------------- fake ERP MCP (07.6-04, D-04)

describe("fake ERP MCP mounted at /erp-mcp", () => {
  async function erpInit(base, token) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`${base}/erp-mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
  }
  async function withErp(opts, fn) {
    const server = createFakeModelServer({ mcpToken: "fake-mcp-token", ...opts });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  it("answers with its own token (default e2e-erp-token), never the fake MCP's", async () => {
    await withErp({}, async (base) => {
      assert.equal((await erpInit(base)).status, 401);
      assert.equal((await erpInit(base, "fake-mcp-token")).status, 401);
      const ok = await erpInit(base, "e2e-erp-token");
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).result.serverInfo.name, "ocw-fake-erp-mcp");
      // The generic fake MCP keeps its own token and route.
      const mcp = await initialize(base, { token: "fake-mcp-token" });
      assert.equal(mcp.res.status, 200);
      assert.equal(mcp.body.result.serverInfo.name, "ocw-fake-mcp");
    });
  });

  it("opts.erpToken overrides the default", async () => {
    await withErp({ erpToken: "custom-erp" }, async (base) => {
      assert.equal((await erpInit(base, "e2e-erp-token")).status, 401);
      assert.equal((await erpInit(base, "custom-erp")).status, 200);
    });
  });
});
