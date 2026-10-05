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

describe("tool gate calls", () => {
  const req = { eventId: "e1", agentId: "a1", tool: "web_search", params: { query: "ocw" } };

  it("authorizeToolCall posts once to /tool-calls and parses the decision", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: { callId: "c1", allowed: true, reason: null } },
    ]);
    const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
    await expect(client.authorizeToolCall(req)).resolves.toEqual({
      callId: "c1",
      allowed: true,
      reason: null,
    });
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/tool-calls");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(req);
  });

  it("authorizeToolCall never retries: a 5xx rejects at once (the gate fails closed)", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 503 },
      { status: 200, body: { callId: "c", allowed: true } },
    ]);
    const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
    await expect(client.authorizeToolCall(req)).rejects.toBeInstanceOf(AgentChannelHttpError);
    expect(calls).toHaveLength(1);
  });

  it("authorizeToolCall rejects within its timeout when the API hangs", async () => {
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: hanging });
    const started = Date.now();
    await expect(client.authorizeToolCall(req, undefined, 50)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reportToolCallResult posts the outcome and never throws", async () => {
    const ok = scriptedFetch([{ status: 200, body: { ok: true } }]);
    const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: ok.fetchImpl });
    await client.reportToolCallResult("c 1", { status: "ok", resultCount: 3, durationMs: 120 });
    expect(ok.calls[0]?.url).toBe("http://api/agent-channel/v1/tool-calls/c%201/result");
    const failing = scriptedFetch([{ status: 500 }, { status: 500 }]);
    const client2 = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: failing.fetchImpl,
      backoff: { baseMs: 1, maxMs: 2 },
    });
    await expect(
      client2.reportToolCallResult("c", { status: "error", durationMs: 1 }),
    ).resolves.toBeUndefined();
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
