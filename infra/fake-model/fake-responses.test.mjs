// node --test infra/fake-model/
// The fake OpenAI Responses API (ChatGPT plan backend, Phase 5): SSE shape, usage, plan preview rules,
// failure directives, slow mode, request capture and the plan catalog.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PLAN_FORBIDDEN_KEYS, planCatalog } from "./fake-responses.mjs";
import { createFakeModelServer } from "./server.mjs";

const seen = [];
let server;
let base;

before(async () => {
  server = createFakeModelServer({ onRequest: (r) => seen.push(r) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  seen.length = 0;
});

const PLAN = "Bearer fake-plan-user-1-abc";

/** A minimal request in the shape @ai-sdk/openai 4.0.80 sends for the plan backend. */
const planBody = (text, extra = {}) => ({
  model: "gpt-6-astra",
  input: [
    { role: "developer", content: "You are chatting with Sam in Autofy Labs." },
    { role: "user", content: [{ type: "input_text", text }] },
  ],
  store: false,
  stream: true,
  ...extra,
});

async function post(path, body, auth = PLAN) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

/** Parses an SSE body into [{event, data}] (data JSON-decoded). */
async function sse(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
    });
}

const deltasOf = (events) =>
  events.filter((e) => e.data.type === "response.output_text.delta").map((e) => e.data.delta);

describe("POST /v1/responses (stream)", () => {
  it("streams created, output item, several text deltas and completed with usage; reply echoes the user text", async () => {
    const res = await post("/v1/responses", planBody("Hello there, how are you today?"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const events = await sse(res);
    const types = events.map((e) => e.data.type);
    assert.equal(types[0], "response.created");
    assert.ok(types.includes("response.output_item.added"));
    assert.ok(types.includes("response.content_part.added"));
    assert.ok(types.includes("response.output_text.done"));
    assert.ok(types.includes("response.output_item.done"));
    assert.equal(types.at(-1), "response.completed");
    for (const e of events) {
      assert.equal(e.event, e.data.type, "event name mirrors the data type");
      assert.equal(typeof e.data.sequence_number, "number");
    }
    const deltas = deltasOf(events);
    assert.ok(deltas.length > 1, "several deltas");
    assert.equal(deltas.join(""), "Echo: Hello there, how are you today?");
    const delta = events.find((e) => e.data.type === "response.output_text.delta").data;
    assert.equal(typeof delta.item_id, "string");
    assert.equal(delta.output_index, 0);
    assert.equal(delta.content_index, 0);
    const completed = events.at(-1).data.response;
    assert.equal(completed.status, "completed");
    assert.equal(typeof completed.usage.input_tokens, "number");
    assert.equal(typeof completed.usage.output_tokens, "number");
    assert.equal(typeof completed.usage.input_tokens_details.cached_tokens, "number");
  });

  it("strips directives from the echo and answers with the last user message", async () => {
    const body = planBody("second question [[note]]");
    body.input.splice(1, 0, { role: "user", content: [{ type: "input_text", text: "first" }] });
    body.input.splice(2, 0, {
      role: "assistant",
      content: [{ type: "output_text", text: "Echo: first" }],
    });
    const events = await sse(await post("/v1/responses", { ...body }));
    assert.equal(deltasOf(events).join(""), "Echo: second question");
  });

  it("[[slow]] emits 40 deltas about 100 ms apart: the echo, then counting to forty", async () => {
    const started = Date.now();
    const events = await sse(await post("/v1/responses", planBody("go [[slow]]")));
    const deltas = deltasOf(events);
    assert.equal(deltas.length, 40);
    assert.equal(deltas.join(""), `Echo: go${Array.from({ length: 40 }, (_, i) => ` ${i + 1}`).join("")}`);
    assert.ok(Date.now() - started >= 3_500, "about 4 s in total");
    assert.equal(events.at(-1).data.type, "response.completed");
  });

  it("[[plan:usage_limit]] streams 3 deltas then response.failed with the SIWC code", async () => {
    const events = await sse(await post("/v1/responses", planBody("hi [[plan:usage_limit]]")));
    assert.equal(deltasOf(events).length, 3);
    const failed = events.at(-1).data;
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response.error.code, "subscription_sharing_usage_limit_exceeded");
    assert.equal(typeof failed.response.error.message, "string");
  });

  it("admission failures answer before streaming with the documented status and code", async () => {
    const cases = [
      ["[[plan:not_eligible]]", 403, "subscription_sharing_user_not_eligible", null],
      ["[[plan:invalid_user]]", 401, "subscription_sharing_invalid_user", null],
      ["[[plan:unavailable]]", 503, "subscription_sharing_usage_unavailable", null],
      ["[[plan:unsupported:tools]]", 400, "subscription_sharing_unsupported_capability", "tools"],
    ];
    for (const [directive, status, code, param] of cases) {
      const res = await post("/v1/responses", planBody(`hi ${directive}`));
      assert.equal(res.status, status, directive);
      const body = await res.json();
      assert.equal(body.error.code, code);
      assert.equal(body.error.param ?? null, param);
      assert.equal(typeof body.error.message, "string");
    }
  });

  it("plan tokens: store, stream, a system item or any forbidden key is a 400 fake_preview_violation naming it", async () => {
    const violations = [
      [{ store: true }, "store"],
      [{ store: undefined }, "store"],
      [{ stream: false }, "stream"],
      ...PLAN_FORBIDDEN_KEYS.map((k) => [{ [k]: k === "metadata" ? {} : 1 }, k]),
    ];
    for (const [extra, key] of violations) {
      const res = await post("/v1/responses", planBody("hi", extra));
      assert.equal(res.status, 400, key);
      const body = await res.json();
      assert.equal(body.error.code, "fake_preview_violation");
      assert.match(body.error.message, new RegExp(key));
    }
    const withSystem = planBody("hi");
    withSystem.input.unshift({ role: "system", content: "nope" });
    const res = await post("/v1/responses", withSystem);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /system/);
  });

  it("the preview rules apply to plan tokens only", async () => {
    const res = await post(
      "/v1/responses",
      planBody("hi", { store: true, temperature: 0.2 }),
      "Bearer sk-org",
    );
    assert.equal(res.status, 200);
    assert.equal(deltasOf(await sse(res)).join(""), "Echo: hi");
  });

  it("image and file parts add [images:N] and [files:N]", async () => {
    const body = planBody("look");
    body.input[1].content.push(
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_image", image_url: "data:image/png;base64,BBBB" },
      { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" },
    );
    const events = await sse(await post("/v1/responses", body));
    assert.equal(deltasOf(events).join(""), "Echo: look [images:2] [files:1]");
  });
});

describe("GET /v1/models", () => {
  it("a plan bearer gets the plan catalog (slug, display_name, visibility)", async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: PLAN } });
    assert.deepEqual(await res.json(), planCatalog());
    assert.deepEqual(planCatalog(), {
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
        {
          slug: "gpt-5.6-luna",
          display_name: "GPT-5.6 Luna",
          visibility: "list",
          input_modalities: ["text", "image"],
        },
        { slug: "gpt-internal", visibility: "hide" },
      ],
    });
  });

  it("any other caller keeps the OpenAI-shaped list", async () => {
    const res = await fetch(`${base}/v1/models`);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.ok(body.data.every((m) => typeof m.id === "string"));
  });
});

describe("request capture (onRequest)", () => {
  it("reports kind, path, headers and body of every model request", async () => {
    await sse(await post("/v1/responses", planBody("capture me")));
    await fetch(`${base}/v1/models`, { headers: { authorization: PLAN } });
    const responses = seen.filter((r) => r.kind === "responses");
    assert.equal(responses.length, 1);
    assert.equal(responses[0].path, "/v1/responses");
    assert.equal(responses[0].headers.authorization, PLAN);
    assert.equal(responses[0].body.store, false);
    assert.ok(seen.some((r) => r.kind === "models" && r.headers.authorization === PLAN));
  });
});

describe("chat completions and Anthropic honour [[slow]] and count images", () => {
  it("chat completions: [[slow]] streams 40 chunks and image parts add [images:N]", async () => {
    const res = await post(
      "/v1/chat/completions",
      {
        model: "mock-1",
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see [[slow]]" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
      "Bearer x",
    );
    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: {"))
      .map((b) => JSON.parse(b.slice(6)))
      .filter((c) => c.choices?.[0]?.delta?.content);
    assert.equal(chunks.length, 40);
    assert.match(chunks.map((c) => c.choices[0].delta.content).join(""), /\[images:1\]/);
  });

  it("anthropic: [[slow]] streams 40 text deltas and image blocks add [images:N]", async () => {
    const res = await post(
      "/v1/messages",
      {
        model: "mock-1",
        stream: true,
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see [[slow]]" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      },
      "Bearer x",
    );
    const text = await res.text();
    const deltas = text
      .split("\n\n")
      .map((b) =>
        b
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d))
      .filter((d) => d.type === "content_block_delta");
    assert.equal(deltas.length, 40);
    assert.match(deltas.map((d) => d.delta.text).join(""), /\[images:1\]/);
  });
});

describe("chat completions and Anthropic count file parts (05-12)", () => {
  const streamedText = (text) =>
    text
      .split("\n\n")
      .map((b) =>
        b
          .split("\n")
          .find((l) => l.startsWith("data: {"))
          ?.slice(6),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d))
      .map((d) => d.choices?.[0]?.delta?.content ?? (d.type === "content_block_delta" ? d.delta.text : ""))
      .join("");

  it("chat completions: a `file` part adds [files:1]", async () => {
    const res = await post(
      "/v1/chat/completions",
      {
        model: "mock-1",
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              {
                type: "file",
                file: { filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERg==" },
              },
            ],
          },
        ],
      },
      "Bearer x",
    );
    assert.match(streamedText(await res.text()), / \[files:1\]$/);
  });

  it("anthropic: a `document` block adds [files:1] after any images", async () => {
    const res = await post(
      "/v1/messages",
      {
        model: "claude-sonnet-5-5",
        stream: true,
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
              },
            ],
          },
        ],
      },
      "Bearer x",
    );
    assert.match(streamedText(await res.text()), / \[images:1\] \[files:1\]$/);
  });
});

describe("title requests (05-10): instructions asking for a short title answer `Title: <first three words>`", () => {
  const TITLE = "You name chats. Reply with a short title for the user's message and nothing else.";
  const request =
    "Write the title for this message.\n<request>\nPlan the quarterly offsite agenda\n</request>";

  const textOfSse = (text) =>
    text
      .split("\n\n")
      .map((b) =>
        b
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6),
      )
      .filter((d) => d && d !== "[DONE]")
      .map((d) => JSON.parse(d));

  it("responses: a developer item asking for a title (plan bearer) answers the title, with usage", async () => {
    const res = await post("/v1/responses", {
      model: "gpt-5.6-luna",
      input: [
        { role: "developer", content: TITLE },
        { role: "user", content: [{ type: "input_text", text: request }] },
      ],
      store: false,
      stream: true,
    });
    assert.equal(res.status, 200);
    const events = await sse(res);
    assert.equal(deltasOf(events).join(""), "Title: Plan the quarterly");
    assert.ok(events.at(-1).data.response.usage.output_tokens > 0);
  });

  it("responses: `instructions` asking for a title works too; [[title:…]] forces the exact reply", async () => {
    const res = await post(
      "/v1/responses",
      {
        model: "gpt-5",
        instructions: TITLE,
        input: [{ role: "user", content: [{ type: "input_text", text: "Hi [[title:Overlong]] there" }] }],
        store: false,
        stream: true,
      },
      "Bearer sk-org",
    );
    assert.equal(deltasOf(await sse(res)).join(""), "Overlong");
  });

  it("responses: without title instructions the echo is unchanged", async () => {
    const res = await post("/v1/responses", planBody("Plan the quarterly offsite agenda"));
    assert.equal(deltasOf(await sse(res)).join(""), "Echo: Plan the quarterly offsite agenda");
  });

  it("chat completions: a system message asking for a title answers the title", async () => {
    const res = await post(
      "/v1/chat/completions",
      {
        model: "mock-1",
        stream: true,
        messages: [
          { role: "system", content: TITLE },
          { role: "user", content: request },
        ],
      },
      "Bearer x",
    );
    const content = textOfSse(await res.text())
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(content, "Title: Plan the quarterly");
  });

  it("anthropic: a system prompt asking for a title answers the title; [[slow]] still streams slowly", async () => {
    const body = (text) => ({
      model: "claude-haiku-4-5",
      stream: true,
      max_tokens: 100,
      system: [{ type: "text", text: TITLE }],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
    const fast = textOfSse(await (await post("/v1/messages", body(request), "Bearer x")).text())
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta.text)
      .join("");
    assert.equal(fast, "Title: Plan the quarterly");
    const started = Date.now();
    const slow = textOfSse(await (await post("/v1/messages", body(`${request} [[slow]]`), "Bearer x")).text())
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta.text)
      .join("");
    assert.equal(slow, "Title: Plan the quarterly", "a slow title is the same title, later");
    assert.ok(Date.now() - started >= 3_000, "slow title replies take seconds");
  });
});

describe("hosted web search (05-11): `[[web <q>]]` with a `web_search` tool offered", () => {
  const URL_OF = "https://example.com/ocw-fake/ocw-release";

  it("streams a web_search_call item, then text carrying a url_citation annotation to the fake result", async () => {
    const res = await post(
      "/v1/responses",
      planBody("latest news [[web ocw release]]", {
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
      }),
    );
    assert.equal(res.status, 200);
    const events = await sse(res);
    const added = events.filter((e) => e.data.type === "response.output_item.added").map((e) => e.data);
    const done = events.filter((e) => e.data.type === "response.output_item.done").map((e) => e.data);
    assert.equal(added[0].item.type, "web_search_call");
    assert.equal(added[0].output_index, 0);
    const call = done.find((d) => d.item.type === "web_search_call");
    assert.equal(call.item.status, "completed");
    assert.deepEqual(call.item.action, {
      type: "search",
      query: "ocw release",
      sources: [{ type: "url", url: URL_OF }],
    });
    // The message is the second output item, its text cites the result.
    const message = done.find((d) => d.item.type === "message");
    assert.equal(message.output_index, 1);
    const text = deltasOf(events).join("");
    assert.match(text, /^Echo: latest news/u);
    assert.ok(text.includes(URL_OF), "the text links the cited page");
    const annotation = events.find((e) => e.data.type === "response.output_text.annotation.added")?.data;
    assert.ok(annotation, "an annotation event");
    assert.equal(annotation.output_index, 1);
    assert.equal(annotation.annotation.type, "url_citation");
    assert.equal(annotation.annotation.url, URL_OF);
    assert.equal(annotation.annotation.title, "Fake result for ocw release");
    assert.equal(
      text.slice(annotation.annotation.start_index, annotation.annotation.end_index).includes(URL_OF),
      true,
      "start/end index cover the inline citation",
    );
    assert.deepEqual(message.item.content[0].annotations, [annotation.annotation]);
    const completed = events.at(-1).data.response;
    assert.deepEqual(
      completed.output.map((o) => o.type),
      ["web_search_call", "message"],
    );
  });

  it("without the tool the directive does nothing: a plain echo, no search item, no annotation", async () => {
    const res = await post("/v1/responses", planBody("latest news [[web ocw release]]"));
    const events = await sse(res);
    assert.equal(deltasOf(events).join(""), "Echo: latest news");
    assert.equal(
      events.some((e) => e.data.item?.type === "web_search_call"),
      false,
    );
    assert.equal(
      events.some((e) => e.data.type === "response.output_text.annotation.added"),
      false,
    );
  });
});
