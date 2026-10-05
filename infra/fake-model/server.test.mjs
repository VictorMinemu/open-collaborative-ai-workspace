// node --test infra/fake-model/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
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

  it("never steps back over an assistant message (no re-run of an earlier turn's directive)", () => {
    const step = planToolStep(
      [
        { role: "user", content: '[[call web_search {"query":"old"}]]' },
        { role: "assistant", content: "done" },
        { role: "user", content: ctx },
      ],
      offered,
    );
    assert.equal(step, null);
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
