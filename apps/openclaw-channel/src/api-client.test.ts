import { describe, expect, it } from "vitest";
import { resolveOcwAccount } from "./account.js";
import { AgentChannelHttpError, createAgentChannelClient, isRetryableStatus } from "./api-client.js";
import { chunkText } from "./bridge.js";

function scriptedFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CELL = {
  protocolVersion: 1,
  cellId: "c1",
  organizationId: "c1",
  topic: "cell:c1",
  lastSeq: 0,
  agents: [],
  providers: [],
};

describe("agent channel client", () => {
  it("sends the bearer token and the v1 path; reads the token on every request", async () => {
    let token = "t1";
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: CELL },
      { status: 200, body: CELL },
    ]);
    const client = createAgentChannelClient({
      apiUrl: "http://api:4000/",
      token: () => token,
      fetch: fetchImpl,
    });
    await client.getCell();
    token = "t2";
    await client.getCell();
    expect(calls[0]?.url).toBe("http://api:4000/agent-channel/v1/cell");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer t1");
    expect((calls[1]?.init.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer t2");
    expect(client.wsUrl()).toBe("ws://api:4000/agent-channel/v1/ws");
  });

  it("retries 5xx/429 and gives up immediately on other 4xx", async () => {
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(403)).toBe(false);
    const retrying = scriptedFetch([
      { status: 502 },
      { status: 429 },
      {
        status: 200,
        body: { messageId: "m1", created: true, conversationId: "c", threadRootMessageId: "r" },
      },
    ]);
    const client = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: retrying.fetchImpl,
      backoff: { baseMs: 1, maxMs: 2 },
    });
    const msg = {
      agentId: "a",
      conversationId: "c",
      threadRootMessageId: "r",
      inReplyToMessageId: "m",
      text: "hi",
      idempotencyKey: "evt:e",
    };
    await expect(client.postMessage(msg)).resolves.toMatchObject({ messageId: "m1" });
    expect(retrying.calls).toHaveLength(3);

    const permanent = scriptedFetch([{ status: 403, body: { error: "nope" } }]);
    const client2 = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: permanent.fetchImpl,
      backoff: { baseMs: 1 },
    });
    await expect(client2.postMessage(msg)).rejects.toBeInstanceOf(AgentChannelHttpError);
    expect(permanent.calls).toHaveLength(1);
  });
});

describe("account resolution", () => {
  it("reads api url and token file from env; never needs secrets in config", () => {
    const acc = resolveOcwAccount(
      {},
      { OCW_API_URL: "http://api:4000", OCW_CELL_TOKEN_FILE: "/run/secrets/cell" },
      () => " tok \n",
    );
    expect(acc.configured).toBe(true);
    expect(acc.tokenSource).toBe("file");
    expect(acc.readToken()).toBe("tok");
    expect(resolveOcwAccount({}, {}).configured).toBe(false);
    expect(() => resolveOcwAccount({}, { OCW_API_URL: "x", OCW_CELL_TOKEN: "" }).readToken()).toThrow();
  });
});

describe("chunkText", () => {
  it("splits long replies on line boundaries under the API limit", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    expect(chunkText(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(chunkText("short", 100)).toEqual(["short"]);
  });
});
