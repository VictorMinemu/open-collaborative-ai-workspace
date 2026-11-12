import { describe, expect, it, vi } from "vitest";
import { resolveOcwAccount } from "./account.js";
import {
  AgentChannelHttpError,
  ATTACHMENT_READ_TIMEOUT_MS,
  createAgentChannelClient,
  isRetryableStatus,
  TASK_REQUEST_TIMEOUT_MS,
  WORK_SESSION_FILE_REQUEST_TIMEOUT_MS,
  WORK_SESSION_REQUEST_TIMEOUT_MS,
} from "./api-client.js";
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

describe("board calls (07.1-13, ocw_board_card)", () => {
  const COLUMN = {
    id: "col-1",
    conversationId: "conv-1",
    name: "Backlog",
    rank: "a0",
    category: "backlog",
    defaultWaitingOn: null,
  };
  const CARD = {
    messageId: "m 1",
    conversationId: "conv-1",
    columnId: "col-1",
    rank: "a0",
    waitingOn: "none",
    title: "Order spare valve",
    titleSource: "heuristic",
    description: "Order spare valve",
    number: null,
    fields: {},
    authorKind: "agent",
    authorId: "a1",
    replyCount: 0,
    lastReplyAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    movedAt: "2026-10-12T10:00:00.000Z",
    version: 1,
  };
  const client = (responses: Array<{ status: number; body?: unknown }>) => {
    const scripted = scriptedFetch(responses);
    return {
      calls: scripted.calls,
      c: createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "t",
        fetch: scripted.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
      }),
    };
  };

  it("boardRead posts {eventId, agentId} once to /board/read and parses the board", async () => {
    const { c, calls } = client([
      {
        status: 200,
        body: { board: { conversationId: "conv-1", version: 1 }, columns: [COLUMN], card: null },
      },
    ]);
    const res = await c.boardRead({ eventId: "e1", agentId: "a1" });
    expect(res.columns[0]?.name).toBe("Backlog");
    expect(res.card).toBeNull();
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/board/read");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ eventId: "e1", agentId: "a1" });
  });

  it("boardCreateCard posts to /board/cards (201 or 200 on a retry) and retries a 5xx once (idempotent key)", async () => {
    const { c, calls } = client([{ status: 503 }, { status: 201, body: { card: CARD } }]);
    const req = {
      eventId: "e1",
      agentId: "a1",
      idempotencyKey: "e1:board:1",
      description: "Order spare valve",
    };
    await expect(c.boardCreateCard(req)).resolves.toMatchObject({ card: { messageId: "m 1", version: 1 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("http://api/agent-channel/v1/board/cards");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(req);
  });

  it("boardPatchCard PATCHes /board/cards/:id once (a retried move would count twice and conflict); a 4xx keeps its code", async () => {
    const { c, calls } = client([
      { status: 409, body: { error: { code: "board_card_version_conflict", message: "x" } } },
    ]);
    const req = { eventId: "e1", agentId: "a1", expectedVersion: 1, waitingOn: "us" as const };
    const err = await c.boardPatchCard("m 1", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentChannelHttpError);
    expect((err as AgentChannelHttpError).code).toBe("board_card_version_conflict");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/board/cards/m%201");
    expect(calls[0]?.init.method).toBe("PATCH");
    const failing = client([{ status: 502 }, { status: 200, body: { card: CARD } }]);
    await expect(failing.c.boardPatchCard("m 1", req)).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(1);
  });

  it("a version conflict carries the current card from error.details.card (07.17 D-06); a malformed one carries none", async () => {
    const req = { eventId: "e1", agentId: "a1", expectedVersion: 1, waitingOn: "us" as const };
    const current = { ...CARD, version: 5 };
    const { c } = client([
      {
        status: 409,
        body: { error: { code: "board_card_version_conflict", message: "x", details: { card: current } } },
      },
      {
        status: 409,
        body: {
          error: { code: "board_card_version_conflict", message: "x", details: { card: { version: "5" } } },
        },
      },
    ]);
    const err = (await c.boardPatchCard("m 1", req).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err.conflictCard).toMatchObject({ messageId: "m 1", version: 5 });
    const bad = (await c.boardPatchCard("m 1", req).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(bad.code).toBe("board_card_version_conflict");
    expect(bad.conflictCard).toBeUndefined();
  });
});

describe("memory file calls (07.2-07, ocw_memory_list|read|write|propose)", () => {
  const client = (responses: Array<{ status: number; body?: unknown }>) => {
    const scripted = scriptedFetch(responses);
    return {
      calls: scripted.calls,
      c: createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "cell-token",
        fetch: scripted.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
      }),
    };
  };
  const READ = { eventId: "e1", agentId: "a1", scope: "personal" as const, path: "MEMORY.md" };

  it("memoryRead posts to /memory/read with the cell bearer and parses the file (or a refusal)", async () => {
    const { c, calls } = client([
      { status: 200, body: { file: { path: "MEMORY.md", version: 3, content: "- likes tea\n" } } },
      { status: 200, body: { refused: "not_found" } },
    ]);
    expect(await c.memoryRead(READ)).toEqual({
      file: { path: "MEMORY.md", version: 3, content: "- likes tea\n" },
    });
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/memory/read");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer cell-token",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(READ);
    expect(await c.memoryRead(READ)).toEqual({ refused: "not_found" });
  });

  it("a response that is neither a file nor a refusal is rejected (never shown to the model)", async () => {
    const { c } = client([{ status: 200, body: { file: { path: "MEMORY.md" } } }]);
    await expect(c.memoryRead(READ)).rejects.toBeDefined();
  });

  it("memoryList, memoryWrite and memoryPropose post to their routes; write and propose never retry", async () => {
    const { c, calls } = client([
      { status: 200, body: { scopes: [{ id: "s1", kind: "personal", label: "You", viewerCan: ["read"] }] } },
      { status: 200, body: { fileId: "f1", version: 2 } },
      { status: 200, body: { approvalId: "ap1", findings: [], readerCount: 4 } },
    ]);
    expect(await c.memoryList({ eventId: "e1", agentId: "a1" })).toMatchObject({ scopes: [{ id: "s1" }] });
    expect(
      await c.memoryWrite({
        eventId: "e1",
        agentId: "a1",
        scope: "personal",
        path: "MEMORY.md",
        mode: "append",
        content: "- x",
      }),
    ).toEqual({ fileId: "f1", version: 2 });
    expect(
      await c.memoryPropose({
        eventId: "e1",
        agentId: "a1",
        scope: "agent",
        path: "clients/acme.md",
        op: "create",
        content: "# Acme",
      }),
    ).toEqual({ approvalId: "ap1", findings: [], readerCount: 4 });
    expect(calls.map((x) => x.url)).toEqual([
      "http://api/agent-channel/v1/memory/list",
      "http://api/agent-channel/v1/memory/write",
      "http://api/agent-channel/v1/memory/propose",
    ]);
    const failing = client([{ status: 502 }, { status: 200, body: { fileId: "f1", version: 2 } }]);
    await expect(
      failing.c.memoryWrite({
        eventId: "e1",
        agentId: "a1",
        scope: "personal",
        path: "MEMORY.md",
        mode: "append",
        content: "- x",
      }),
    ).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(1);
    const proposing = client([
      { status: 503 },
      { status: 200, body: { approvalId: "a", findings: [], readerCount: 1 } },
    ]);
    await expect(
      proposing.c.memoryPropose({
        eventId: "e1",
        agentId: "a1",
        scope: "agent",
        path: "a.md",
        op: "create",
        content: "x",
      }),
    ).rejects.toBeDefined();
    expect(proposing.calls).toHaveLength(1);
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

describe("automation proposals (07.6 AUTO-03, ocw_automation_propose)", () => {
  const BODY = {
    eventId: "e1",
    agentId: "a1",
    name: "Weekly sales report",
    instructions: "Post the total.",
    schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
    target: { kind: "here" as const },
  };
  const client = (responses: Array<{ status: number; body?: unknown }>) => {
    const scripted = scriptedFetch(responses);
    return {
      calls: scripted.calls,
      c: createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "t",
        fetch: scripted.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
      }),
    };
  };

  it("proposeAutomation posts the body once to /automations/propose and parses the answer", async () => {
    const answer = {
      ok: true,
      approvalId: "ap-1",
      sentence: "I posted a card proposing “Weekly sales report”.",
    };
    const { c, calls } = client([{ status: 200, body: answer }]);
    await expect(c.proposeAutomation(BODY)).resolves.toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/automations/propose");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(BODY);
  });

  it("never retries (a retry could post a second card); a 4xx {ok:false, code, sentence} body is the refusal", async () => {
    const failing = client([
      { status: 503 },
      { status: 200, body: { ok: true, approvalId: "x", sentence: "s" } },
    ]);
    await expect(failing.c.proposeAutomation(BODY)).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(1);
    const refusal = {
      ok: false,
      code: "tainted",
      sentence: "I can't propose an automation after reading outside content in this turn.",
    };
    const refused = client([{ status: 403, body: refusal }]);
    await expect(refused.c.proposeAutomation(BODY)).resolves.toEqual(refusal);
  });

  it("an error body without a sentence keeps its code only; a malformed answer is rejected (never shown to the model)", async () => {
    const coded = client([{ status: 404, body: { error: { code: "unknown_turn", message: "no" } } }]);
    const err = (await coded.c.proposeAutomation(BODY).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err).toBeInstanceOf(AgentChannelHttpError);
    expect(err.code).toBe("unknown_turn");
    expect(err.answer).toBeUndefined();
    const odd = client([{ status: 200, body: { ok: true, sentence: "no approval id" } }]);
    await expect(odd.c.proposeAutomation(BODY)).rejects.toBeDefined();
    const long = client([
      { status: 409, body: { ok: false, code: "automation_cap", sentence: "x".repeat(501) } },
    ]);
    const e2 = (await long.c.proposeAutomation(BODY).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(e2.answer).toBeUndefined();
  });
});

describe("watched record updates (07.6 AUTO-04, ocw_record_update)", () => {
  const BODY = { eventId: "e1", agentId: "a1", changes: { "/status": "Shipped" } };

  it("updateRecord posts once to /records/update; a 409 record_changed body is the answer, not an error", async () => {
    const ok = scriptedFetch([
      { status: 200, body: { ok: true, code: null, sentence: "Updated SO-10442 in ERP." } },
    ]);
    const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: ok.fetchImpl });
    await expect(c.updateRecord(BODY)).resolves.toEqual({
      ok: true,
      code: null,
      sentence: "Updated SO-10442 in ERP.",
    });
    expect(ok.calls[0]?.url).toBe("http://api/agent-channel/v1/records/update");
    expect(JSON.parse(String(ok.calls[0]?.init.body))).toEqual(BODY);
    const changed = {
      ok: false,
      code: "record_changed",
      sentence: "The record changed in ERP since the last check.",
    };
    const conflict = scriptedFetch([{ status: 409, body: changed }]);
    const c2 = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: conflict.fetchImpl,
    });
    await expect(c2.updateRecord(BODY)).resolves.toEqual(changed);
  });

  it("never retries a write (a 5xx is one attempt); an error without a sentence keeps its code", async () => {
    const failing = scriptedFetch([
      { status: 502 },
      { status: 200, body: { ok: true, code: null, sentence: "s" } },
    ]);
    const c = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: failing.fetchImpl,
      backoff: { baseMs: 1, maxMs: 2 },
    });
    await expect(c.updateRecord(BODY)).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(1);
    const coded = scriptedFetch([{ status: 404, body: { error: { code: "unknown_turn", message: "m" } } }]);
    const c2 = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: coded.fetchImpl });
    const err = (await c2.updateRecord(BODY).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err.code).toBe("unknown_turn");
  });
});

describe("consults (07.7 A2A-01, ocw_consult_agent) and the turn-done signal (P-09)", () => {
  const BODY = {
    eventId: "e1",
    agentId: "a1",
    target: "b1",
    question: "Is the pump order confirmed?",
    mode: "consult" as const,
    idempotencyKey: "e1:consult:0",
  };
  const client = (responses: Array<{ status: number; body?: unknown }>) => {
    const scripted = scriptedFetch(responses);
    return {
      calls: scripted.calls,
      c: createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "cell-token",
        fetch: scripted.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
      }),
    };
  };
  const SENT = {
    ok: true,
    chainId: "ch-1",
    hopId: "hop-1",
    questionMessageId: "q-1",
    sentence: "Question sent to @bea.",
  };

  it("consult posts the body to /consultations with the bearer token and parses a 200 answer (ok or limit_reached)", async () => {
    const { c, calls } = client([{ status: 200, body: SENT }]);
    await expect(c.consult(BODY)).resolves.toEqual(SENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/consultations");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer cell-token",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(BODY);
    const limit = {
      ok: false,
      code: "limit_reached",
      hopId: "hop-1",
      questionMessageId: "q-1",
      sentence: "@bea has reached its daily limit and cannot answer today.",
    };
    await expect(client([{ status: 200, body: limit }]).c.consult(BODY)).resolves.toEqual(limit);
  });

  it("two attempts at most (the key makes a retry answer the same hop); a 4xx {ok:false, code, sentence} body is the refusal", async () => {
    const retried = client([{ status: 503 }, { status: 200, body: SENT }]);
    await expect(retried.c.consult(BODY)).resolves.toEqual(SENT);
    expect(retried.calls).toHaveLength(2);
    expect(new Set(retried.calls.map((x) => String(x.init.body))).size).toBe(1);
    const failing = client([{ status: 503 }, { status: 503 }, { status: 200, body: SENT }]);
    await expect(failing.c.consult(BODY)).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(2);
    for (const [status, code] of [
      [403, "not_allowed"],
      [403, "tainted"],
      [409, "consult_pending"],
      [409, "budget_exhausted"],
    ] as const) {
      const refusal = { ok: false, code, sentence: `refused: ${code}` };
      const refused = client([{ status, body: refusal }]);
      await expect(refused.c.consult(BODY)).resolves.toEqual(refusal);
      expect(refused.calls).toHaveLength(1);
    }
  });

  it("an error body without a sentence throws with its code only; a malformed 200 is rejected", async () => {
    const coded = client([{ status: 404, body: { error: { code: "unknown_turn", message: "no" } } }]);
    const err = (await coded.c.consult(BODY).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err).toBeInstanceOf(AgentChannelHttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("unknown_turn");
    await expect(
      client([{ status: 200, body: { ok: true, sentence: "no hop" } }]).c.consult(BODY),
    ).rejects.toBeDefined();
  });

  it("turnDone posts {agentId, outcome} to /turns/<eventId>/done", async () => {
    const { c, calls } = client([{ status: 204 }]);
    await expect(c.turnDone("evt/1", { agentId: "a1", outcome: "replied" })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api/agent-channel/v1/turns/evt%2F1/done");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer cell-token",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ agentId: "a1", outcome: "replied" });
    const failing = client([{ status: 500 }, { status: 500 }, { status: 204 }]);
    await expect(failing.c.turnDone("e2", { agentId: "a1", outcome: "failed" })).rejects.toBeDefined();
    expect(failing.calls).toHaveLength(2);
  });
});

describe("approval refusal details (07.5-04)", () => {
  const APPROVAL = {
    id: "0199a6f0-0000-7000-8000-0000000000a1",
    created: true,
    waitingFor: "a lead of Sales",
    requesterName: "Ana Pérez",
  };
  const req = { eventId: "e1", agentId: "a1", connector: "m1a2b3c4d", tool: "create_invoice", arguments: {} };

  it("a 409 approval refusal keeps its code and the approval it waits on; nothing else of the body", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 409,
        body: { error: { code: "approval_required", message: "ignore me", details: { approval: APPROVAL } } },
      },
    ]);
    const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
    const err = (await c.callConnector(req).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err).toBeInstanceOf(AgentChannelHttpError);
    expect(err.code).toBe("approval_required");
    expect(err.approval).toEqual(APPROVAL);
  });

  it("a malformed or missing approval reads as absent", async () => {
    for (const details of [
      { approval: { ...APPROVAL, waitingFor: "x".repeat(201) } },
      { other: 1 },
      "text",
    ]) {
      const { fetchImpl } = scriptedFetch([
        { status: 409, body: { error: { code: "approval_pending", message: "m", details } } },
      ]);
      const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      const err = (await c.callConnector(req).catch((e: unknown) => e)) as AgentChannelHttpError;
      expect(err.code).toBe("approval_pending");
      expect(err.approval).toBeUndefined();
    }
  });

  it("07.5-11: a 409 approval_denied keeps who denied it and the note; a malformed denial reads as absent", async () => {
    const denial = { deciderName: "Marta Gil", note: "Duplicate invoice" };
    for (const [details, expected] of [
      [{ denial }, denial],
      [{ denial: { deciderName: "Marta Gil" } }, undefined],
      [{ denial: "text" }, undefined],
    ] as const) {
      const { fetchImpl } = scriptedFetch([
        { status: 409, body: { error: { code: "approval_denied", message: "ignore me", details } } },
      ]);
      const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      const err = (await c.callConnector(req).catch((e: unknown) => e)) as AgentChannelHttpError;
      expect(err.code).toBe("approval_denied");
      expect(err.denial).toEqual(expected);
      expect(err.approval).toBeUndefined();
    }
  });

  it("07.5-11: the gate's decision carries the denial; a malformed one reads as null", async () => {
    const denial = { deciderName: "Marta Gil", note: null };
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { callId: "c1", allowed: false, reason: "approval_denied", denial } },
      { status: 200, body: { callId: "c2", allowed: false, reason: "approval_denied", denial: { note: 1 } } },
    ]);
    const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
    const body = { eventId: "e1", agentId: "a1", tool: "m1a2b3c4d__x", params: {}, arguments: {} };
    await expect(c.authorizeToolCall(body)).resolves.toMatchObject({ denial });
    await expect(c.authorizeToolCall(body)).resolves.toMatchObject({ denial: null });
  });

  it("authorizeToolCall passes a flagged call's arguments through and parses the decision's approval", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: { callId: "c1", allowed: false, reason: "approval_required", approval: APPROVAL },
      },
    ]);
    const c = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
    const body = {
      eventId: "e1",
      agentId: "a1",
      tool: "m1a2b3c4d__x",
      params: {},
      arguments: { a: [1, "b"] },
    };
    await expect(c.authorizeToolCall(body)).resolves.toMatchObject({ approval: APPROVAL });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
  });
});

describe("AgentChannelHttpError across module instances (07.2-15, real-cell smoke memory-files)", () => {
  it("an error thrown by another module instance of the plugin is still recognised", async () => {
    // OpenClaw loads the plugin once per registry (boot, discovery, tool-discovery): the shared client may come from
    // one module instance and the tool that catches its error from another.
    vi.resetModules();
    const other = (await import("./api-client.js")) as typeof import("./api-client.js");
    expect(other.AgentChannelHttpError).not.toBe(AgentChannelHttpError);
    const fromOther = new other.AgentChannelHttpError(403, "/memory/read", "x", "no_trigger");
    expect(fromOther instanceof AgentChannelHttpError).toBe(true);
    expect(new AgentChannelHttpError(409, "/cards", "y") instanceof other.AgentChannelHttpError).toBe(true);
    expect(fromOther instanceof Error).toBe(true);
    expect(new Error("plain") instanceof AgentChannelHttpError).toBe(false);
    expect(Object.assign(new Error("look-alike"), { status: 403 }) instanceof AgentChannelHttpError).toBe(
      false,
    );
    expect((null as unknown as object) instanceof AgentChannelHttpError).toBe(false);
  });
});

describe("attachmentRead's budget (07.15 IN-05)", () => {
  it("waits longer than the API's worst case: one attempt of ATTACHMENT_READ_TIMEOUT_MS, at least 30 s", async () => {
    // The API's worst case is a 25 MiB store read, the PDF extractor's 10 s deadline and two transactions; a shorter
    // budget let the API charge and audit a read the bot never received.
    expect(ATTACHMENT_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: { kind: "refused", attachmentId: "a", code: "busy", sentence: "s" } },
      ]);
      const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      const body = {
        eventId: "00000000-0000-7000-8000-000000000001",
        agentId: "00000000-0000-7000-8000-000000000002",
        attachmentId: "00000000-0000-7000-8000-000000000003",
      };
      await client.attachmentRead(body).catch(() => undefined);
      expect(calls).toHaveLength(1);
      expect(timeout).toHaveBeenCalledWith(ATTACHMENT_READ_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("bot Work Zone file calls (07.17.1.1 D-01, PD-18): one attempt, the transfer's budget", () => {
  const EVENT = "00000000-0000-7000-8000-000000000001";
  const AGENT = "00000000-0000-7000-8000-000000000002";
  const WS = "00000000-0000-7000-8000-000000000003";
  const ATTACHMENT = "00000000-0000-7000-8000-000000000004";

  it("the file budget is the transfer cap plus 15 s; the four 07.16 calls keep 30 s", () => {
    expect(WORK_SESSION_FILE_REQUEST_TIMEOUT_MS).toBe(615_000);
    expect(WORK_SESSION_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("workSessionUpload posts the body to /work-sessions/upload once, with the file budget, and parses the answer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetchImpl, calls } = scriptedFetch([
        {
          status: 200,
          body: { kind: "uploaded", workSessionId: WS, path: "docs/spec.pdf", sizeBytes: 1536 },
        },
      ]);
      const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      const body = {
        eventId: EVENT,
        agentId: AGENT,
        workSessionId: WS,
        attachmentId: ATTACHMENT,
        path: "docs/spec.pdf",
      };
      await expect(client.workSessionUpload(body)).resolves.toEqual({
        kind: "uploaded",
        workSessionId: WS,
        path: "docs/spec.pdf",
        sizeBytes: 1536,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://api/agent-channel/v1/work-sessions/upload");
      expect(calls[0]?.init.method).toBe("POST");
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
      expect(timeout).toHaveBeenCalledWith(WORK_SESSION_FILE_REQUEST_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it("a 5xx is never retried (a second attempt could move the file twice)", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 503 }, { status: 200, body: {} }]);
    const client = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: fetchImpl,
      backoff: { baseMs: 1, maxMs: 2 },
    });
    const body = {
      eventId: EVENT,
      agentId: AGENT,
      workSessionId: WS,
      attachmentId: ATTACHMENT,
      path: "a.txt",
    };
    await expect(client.workSessionUpload(body)).rejects.toBeInstanceOf(AgentChannelHttpError);
    expect(calls).toHaveLength(1);
  });

  it("workSessionDownload posts the body to /work-sessions/download once, with the file budget, and parses the answer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const answer = {
        kind: "downloaded",
        workSessionId: WS,
        attachmentId: ATTACHMENT,
        name: "README.md",
        sizeBytes: 64,
        contentType: "text/markdown",
      };
      const { fetchImpl, calls } = scriptedFetch([
        { status: 200, body: answer },
        { status: 200, body: answer },
      ]);
      const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      const body = { eventId: EVENT, agentId: AGENT, workSessionId: WS, path: "README.md" };
      await expect(client.workSessionDownload(body)).resolves.toEqual(answer);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("http://api/agent-channel/v1/work-sessions/download");
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
      expect(timeout).toHaveBeenCalledWith(WORK_SESSION_FILE_REQUEST_TIMEOUT_MS);
      // A refusal with the limit keeps it (the renderer composes nothing the API already said).
      const refused = scriptedFetch([
        {
          status: 200,
          body: {
            kind: "refused",
            code: "file_too_large",
            sentence: "That file is 12 MB. This bot moves files up to 10 MB (this bot's limit).",
            limit: { bytes: 10 * 1024 * 1024, source: "bot" },
            sizeBytes: 12 * 1024 * 1024,
          },
        },
      ]);
      const c2 = createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "t",
        fetch: refused.fetchImpl,
      });
      await expect(c2.workSessionDownload(body)).resolves.toMatchObject({
        kind: "refused",
        limit: { bytes: 10 * 1024 * 1024, source: "bot" },
        sizeBytes: 12 * 1024 * 1024,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("a 5xx on a download is never retried", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 502 }, { status: 200, body: {} }]);
    const client = createAgentChannelClient({
      apiUrl: "http://api",
      token: () => "t",
      fetch: fetchImpl,
      backoff: { baseMs: 1, maxMs: 2 },
    });
    await expect(
      client.workSessionDownload({ eventId: EVENT, agentId: AGENT, workSessionId: WS, path: "a.txt" }),
    ).rejects.toBeInstanceOf(AgentChannelHttpError);
    expect(calls).toHaveLength(1);
  });

  it("workSessionPrompt still waits WORK_SESSION_REQUEST_TIMEOUT_MS", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetchImpl } = scriptedFetch([
        {
          status: 200,
          body: { kind: "queued", workSessionId: WS, promptId: ATTACHMENT, position: 1, status: "queued" },
        },
      ]);
      const client = createAgentChannelClient({ apiUrl: "http://api", token: () => "t", fetch: fetchImpl });
      await client.workSessionPrompt({ eventId: EVENT, agentId: AGENT, workSessionId: WS, prompt: "next" });
      expect(timeout).toHaveBeenCalledWith(WORK_SESSION_REQUEST_TIMEOUT_MS);
      expect(timeout).not.toHaveBeenCalledWith(WORK_SESSION_FILE_REQUEST_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("task calls (07.17.1.1.2 D-02, PD-04): one attempt each, the ids and the bot's own fields only", () => {
  const EVENT = "00000000-0000-7000-8000-000000000011";
  const AGENT = "00000000-0000-7000-8000-000000000012";
  const TASK = "00000000-0000-7000-8000-000000000013";
  const client = (responses: Array<{ status: number; body?: unknown }>) => {
    const scripted = scriptedFetch(responses);
    return {
      calls: scripted.calls,
      c: createAgentChannelClient({
        apiUrl: "http://api",
        token: () => "cell-token",
        fetch: scripted.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
      }),
    };
  };
  const START = { eventId: EVENT, agentId: AGENT, goal: "Read the knowledge pack" };
  const CONTINUE = {
    eventId: EVENT,
    agentId: AGENT,
    progress: "Read 120 of 3030 files",
    nextStep: "Read the next 200",
    afterSeconds: 60,
  };
  const FINISH = { eventId: EVENT, agentId: AGENT, summary: "Done.", outcome: "done" as const };

  it("each posts its body to its own route once, with the bearer token and TASK_REQUEST_TIMEOUT_MS, and parses the answer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const started = { ok: true, taskId: TASK, maxTurns: 40, deadlineAt: "2026-11-12T18:00:00.000Z" };
      const continued = { ok: true, next: "after_turn", at: null, turnsLeft: 39, quiet: true };
      const finished = { ok: true, status: "done" };
      const { c, calls } = client([
        { status: 200, body: started },
        { status: 200, body: continued },
        { status: 200, body: finished },
      ]);
      await expect(c.taskStart(START)).resolves.toEqual(started);
      await expect(c.taskContinue(CONTINUE)).resolves.toEqual(continued);
      await expect(c.taskFinish(FINISH)).resolves.toEqual(finished);
      expect(calls.map((x) => x.url)).toEqual([
        "http://api/agent-channel/v1/tasks/start",
        "http://api/agent-channel/v1/tasks/continue",
        "http://api/agent-channel/v1/tasks/finish",
      ]);
      expect(calls.map((x) => x.init.method)).toEqual(["POST", "POST", "POST"]);
      expect(calls.map((x) => JSON.parse(String(x.init.body)))).toEqual([START, CONTINUE, FINISH]);
      expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
        "Bearer cell-token",
      );
      expect(timeout).toHaveBeenCalledWith(TASK_REQUEST_TIMEOUT_MS);
      expect(TASK_REQUEST_TIMEOUT_MS).toBe(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("a 200 refusal and a 4xx {ok:false, code, sentence} body are the refusal; a 5xx is never retried; a malformed 200 is rejected", async () => {
    const refusal = { ok: false, code: "task_active", sentence: "You already have a task running." };
    await expect(client([{ status: 200, body: refusal }]).c.taskStart(START)).resolves.toEqual(refusal);
    const coded = client([{ status: 409, body: { ok: false, code: "task_busy", sentence: "Busy." } }]);
    await expect(coded.c.taskContinue(CONTINUE)).resolves.toEqual({
      ok: false,
      code: "task_busy",
      sentence: "Busy.",
    });
    const down = client([{ status: 503 }, { status: 200, body: { ok: true, status: "done" } }]);
    await expect(down.c.taskFinish(FINISH)).rejects.toBeInstanceOf(AgentChannelHttpError);
    expect(down.calls).toHaveLength(1);
    const gone = client([{ status: 404, body: { error: { code: "unknown_turn", message: "no" } } }]);
    const err = (await gone.c.taskContinue(CONTINUE).catch((e: unknown) => e)) as AgentChannelHttpError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("unknown_turn");
    await expect(
      client([{ status: 200, body: { ok: true, next: "soon" } }]).c.taskContinue(CONTINUE),
    ).rejects.toBeDefined();
  });
});
