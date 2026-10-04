// node --test infra/fake-model/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { composeReply, createFakeModelServer, humanNames } from "./server.mjs";

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

  it("excludes agents from the participant list", () => {
    assert.deepEqual(humanNames("Víctor <u1>, Archie (agent) <a1>, Alex <u2>"), ["Alex", "Víctor"]);
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
    assert.equal(body.content[0].text.endsWith("[tools: 1]"), true);
  });
});
