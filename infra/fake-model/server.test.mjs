// node --test infra/fake-model/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { composeReply, createFakeModelServer, humanNames, parseDirectives } from "./server.mjs";

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
