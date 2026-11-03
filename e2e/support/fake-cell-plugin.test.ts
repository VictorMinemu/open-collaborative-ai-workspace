import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin, type MentionPayload } from "./fake-cell-plugin";

/**
 * 07.8-08: the fake cell's confined tool calls, against a stub Agent Channel. A success renders the result; a refusal
 * renders `refused (<code>)` only for a code of the contract's `SandboxRefusal` / `BrowserRefusal` enums.
 * 07.7-10: `ocw_consult_agent` posts to `/consultations` (self-validated, never `/tool-calls`) and relays the server's
 * sentence; `autoDone` reports `POST /turns/:eventId/done` only for turns that can belong to a chain; `holdAgents` never
 * answers for the listed bots.
 */

const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: Server;
let plugin: FakeCellPlugin;
let apiUrl = "";

const answers: Record<string, [number, unknown]> = {
  "/agent-channel/v1/sandbox/exec": [
    200,
    { status: "exited", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, durationMs: 3 },
  ],
  "/agent-channel/v1/sandbox/read": [409, { error: { code: "arguments_invalid", message: "x" } }],
  "/agent-channel/v1/sandbox/list": [403, { error: { code: "killed", message: "x" } }],
  "/agent-channel/v1/browser/open": [403, { error: { code: "sandbox_off", message: "x" } }],
  "/agent-channel/v1/browser/snapshot": [409, { error: { code: "paused", message: "x" } }],
  "/agent-channel/v1/typing": [200, { ok: true }],
  "/agent-channel/v1/messages": [200, { messageId: "00000000-0000-4000-8000-0000000000f1", created: true }],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: text ? JSON.parse(text) : {} });
      const url = req.url ?? "";
      const [status, body] = /^\/agent-channel\/v1\/turns\/[^/]+\/done$/u.test(url)
        ? [204, null]
        : (answers[url] ?? [404, { error: { code: "route_not_found" } }]);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === null ? "" : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}`;
  plugin = new FakeCellPlugin({ apiUrl, token: "cell-token" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const mention = {
  eventId: "00000000-0000-4000-8000-0000000000e1",
  agent: { id: "00000000-0000-4000-8000-0000000000a1", handle: "scout", displayName: "Scout" },
  message: { id: "m1", text: "", author: { kind: "user", id: "u1", displayName: "Sam" } },
  turn: { tools: ["ocw_sandbox_exec", "ocw_browser_open"] },
} as unknown as MentionPayload;

describe("FakeCellPlugin confined calls", () => {
  it("a sandbox success posts the turn's ids and the arguments to /sandbox/exec and renders the result", async () => {
    expect(await plugin.sandbox(mention, "ocw_sandbox_exec", { argv: ["echo", "hi"] })).toBe("exit 0: hi");
    expect(seen.at(-1)).toEqual({
      path: "/agent-channel/v1/sandbox/exec",
      body: { argv: ["echo", "hi"], eventId: mention.eventId, agentId: mention.agent.id },
    });
    expect(plugin.confinedRequests.at(-1)).toMatchObject({
      keys: ["agentId", "argv", "eventId"],
      status: 200,
    });
  });

  it("a refusal with a contract code reads `refused (<code>)`; another code reads `failed (<status>)`", async () => {
    expect(await plugin.sandbox(mention, "ocw_sandbox_list", { path: "" })).toBe("refused (killed)");
    expect(await plugin.sandbox(mention, "ocw_sandbox_read", { path: "a.txt" })).toBe("failed (409)");
    expect(await plugin.browser(mention, "ocw_browser_open", { url: "https://a.test/" })).toBe(
      "refused (sandbox_off)",
    );
    expect(await plugin.browser(mention, "ocw_browser_snapshot", {})).toBe("refused (paused)");
  });

  it("[[call …]] directives for confined tools go through the same calls (never /tool-calls)", async () => {
    const lines = await plugin.simulateToolCalls(mention, [
      { tool: "ocw_sandbox_exec", args: { argv: ["echo", "hi"] } },
      { tool: "ocw_browser_open", args: { url: "https://a.test/" } },
      { tool: "ocw_sandbox_write", args: { path: "a", content: "b" } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_sandbox_exec: exit 0: hi",
      "Tool ocw_browser_open: refused (sandbox_off)",
      "Tool ocw_sandbox_write: not offered",
    ]);
    expect(seen.some((r) => r.path.endsWith("/tool-calls"))).toBe(false);
  });
});

// ---------------------------------------------------------------- 07.7-10: consults and turn done

type EventData = Record<string, unknown> & { seq: number };
const asEvent = (x: unknown) => x as EventData;

const BEA = {
  id: "00000000-0000-4000-8000-0000000000b2",
  handle: "bea",
  displayName: "Bea",
  description: null,
};
const SENT = {
  ok: true,
  chainId: "00000000-0000-4000-8000-0000000000c9",
  hopId: "00000000-0000-4000-8000-0000000000c8",
  questionMessageId: "00000000-0000-4000-8000-0000000000c7",
  sentence: "Question sent to @bea.",
};

/** Archie's turn in a channel thread, offered `ocw_consult_agent` with Bea as the only target. */
const archieTurn = (over: Record<string, unknown> = {}) =>
  ({
    eventId: "00000000-0000-4000-8000-0000000000e2",
    seq: 1,
    agent: { id: "00000000-0000-4000-8000-0000000000a2", handle: "archie", displayName: "Archie" },
    conversation: { id: "00000000-0000-4000-8000-0000000000c1", kind: "channel", name: "ops" },
    thread: { rootMessageId: "00000000-0000-4000-8000-0000000000d1" },
    message: {
      id: "00000000-0000-4000-8000-0000000000d1",
      text: "@archie check with Bea",
      author: { kind: "user", id: "u1", displayName: "Víctor Ruiz" },
    },
    threadHistory: [],
    roster: [],
    turn: { tools: ["ocw_consult_agent"], consult: { chainId: null, depth: 0, targets: [BEA] } },
    ...over,
  }) as unknown as MentionPayload;

const since = (n: number) => seen.slice(n).map((r) => r.path);

describe("FakeCellPlugin consults (07.7-10)", () => {
  it("ocw_consult_agent posts the turn, the target's id (from @handle), the question and a <eventId>:consult:<n> key to /consultations and relays the sentence", async () => {
    answers["/agent-channel/v1/consultations"] = [200, SENT];
    const m = archieTurn();
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(m, [
      { tool: "ocw_consult_agent", args: { target: "@bea", question: " Is the pump order confirmed? " } },
    ]);
    expect(lines).toEqual(["Tool ocw_consult_agent: Question sent to @bea."]);
    expect(seen.at(-1)).toEqual({
      path: "/agent-channel/v1/consultations",
      body: {
        eventId: m.eventId,
        agentId: m.agent.id,
        target: BEA.id,
        question: "Is the pump order confirmed?",
        mode: "consult",
        idempotencyKey: `${m.eventId}:consult:1`,
      },
    });
    expect(since(from).some((p) => p.endsWith("/tool-calls"))).toBe(false);
    expect(plugin.consultRequests.at(-1)).toMatchObject({ eventId: m.eventId, status: 200 });
  });

  it("a refusal reads `refused (<code>)` from the body or the error envelope; a target the turn does not offer is never sent", async () => {
    answers["/agent-channel/v1/consultations"] = [
      409,
      { ok: false, code: "consult_pending", sentence: "You already have a question waiting." },
    ];
    expect(
      await plugin.simulateToolCalls(archieTurn(), [
        { tool: "ocw_consult_agent", args: { target: BEA.id, question: "Again?", mode: "handoff" } },
      ]),
    ).toEqual(["Tool ocw_consult_agent: refused (consult_pending)"]);
    expect(seen.at(-1)?.body).toMatchObject({ target: BEA.id, mode: "handoff" });

    answers["/agent-channel/v1/consultations"] = [404, { error: { code: "unknown_turn", message: "x" } }];
    expect(
      await plugin.simulateToolCalls(archieTurn(), [
        { tool: "ocw_consult_agent", args: { target: "bea", question: "Still there?" } },
      ]),
    ).toEqual(["Tool ocw_consult_agent: refused (unknown_turn)"]);

    const from = seen.length;
    expect(
      await plugin.simulateToolCalls(archieTurn(), [
        { tool: "ocw_consult_agent", args: { target: "@carl", question: "Hi?" } },
      ]),
    ).toEqual(["Tool ocw_consult_agent: refused (not_a_target)"]);
    expect(
      await plugin.simulateToolCalls(archieTurn({ turn: { tools: [] } }), [
        { tool: "ocw_consult_agent", args: { target: "@bea", question: "Hi?" } },
      ]),
    ).toEqual(["Tool ocw_consult_agent: not offered"]);
    expect(since(from)).toEqual([]);
  });

  it("autoDone reports done after the reply of a chain-capable turn (offered the tool, carrying origin, or a consult reply), never for another turn", async () => {
    const cell = new FakeCellPlugin({ apiUrl, token: "cell-token", autoReply: true, autoDone: true });
    answers["/agent-channel/v1/consultations"] = [200, SENT];
    // Offered the tool: the consult, the reply, then done (replied).
    let from = seen.length;
    const asked = archieTurn({
      message: {
        id: "00000000-0000-4000-8000-0000000000d1",
        text: '@archie [[call ocw_consult_agent {"target":"@bea","question":"Confirmed?"}]]',
        author: { kind: "user", id: "u1", displayName: "Víctor Ruiz" },
      },
    });
    await cell.onEvent("agent.mention.v1", asEvent(asked));
    expect(since(from)).toEqual([
      "/agent-channel/v1/consultations",
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
      `/agent-channel/v1/turns/${asked.eventId}/done`,
    ]);
    expect(seen.at(-1)?.body).toEqual({ agentId: asked.agent.id, outcome: "replied" });
    expect(String(seen.at(-2)?.body.text)).toMatch(/^Tool ocw_consult_agent: Question sent to @bea\./u);
    expect(cell.doneReports.at(-1)).toEqual({
      eventId: asked.eventId,
      agentId: asked.agent.id,
      outcome: "replied",
      status: 204,
    });

    // Bea's turn carries origin (she answers a question): done too.
    from = seen.length;
    const question = archieTurn({
      eventId: "00000000-0000-4000-8000-0000000000e3",
      agent: { id: BEA.id, handle: "bea", displayName: "Bea" },
      turn: { tools: [] },
      origin: { agentId: asked.agent.id, chainId: SENT.chainId, depth: 1 },
    });
    await cell.onEvent("agent.mention.v1", asEvent(question));
    expect(since(from).at(-1)).toBe(`/agent-channel/v1/turns/${question.eventId}/done`);

    // The consult reply: answered like a mention (naming who answered, never running directives from the answer).
    from = seen.length;
    const reply = archieTurn({
      eventId: "00000000-0000-4000-8000-0000000000e4",
      turn: { tools: ["ocw_consult_agent"] },
      message: {
        id: "m-answer",
        text: 'Yes. [[call ocw_consult_agent {"target":"@bea","question":"loop?"}]]',
        author: { kind: "agent", id: BEA.id, displayName: "Bea" },
      },
      consultReply: {
        chainId: SENT.chainId,
        hopId: SENT.hopId,
        target: { id: BEA.id, handle: "bea", displayName: "Bea" },
        mode: "consult",
        outcome: "answered",
        answerMessageId: "m-answer",
      },
    });
    await cell.onEvent("agent.consult_reply.v1", asEvent(reply));
    expect(since(from)).toEqual([
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
      `/agent-channel/v1/turns/${reply.eventId}/done`,
    ]);
    expect(seen.at(-2)?.body).toMatchObject({ inReplyToMessageId: "m-answer", eventId: reply.eventId });
    expect(String(seen.at(-2)?.body.text)).toContain("Asked by Bea");

    // A plain mention (no consult tool, no origin): no done, as before.
    from = seen.length;
    await cell.onEvent(
      "agent.mention.v1",
      asEvent(archieTurn({ eventId: "00000000-0000-4000-8000-0000000000e5", turn: { tools: [] } })),
    );
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
  });

  it("holdAgents never answers (nor reports done) for the listed bots; without autoDone nothing reports done", async () => {
    const question = archieTurn({
      agent: { id: BEA.id, handle: "bea", displayName: "Bea" },
      turn: { tools: [] },
      origin: { agentId: "a", chainId: SENT.chainId, depth: 1 },
    });
    const held = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      autoDone: true,
      holdAgents: new Set([BEA.id]),
    });
    let from = seen.length;
    await held.onEvent("agent.mention.v1", asEvent(question));
    expect(since(from)).toEqual([]);

    const quiet = new FakeCellPlugin({ apiUrl, token: "cell-token", autoReply: true });
    from = seen.length;
    await quiet.onEvent("agent.mention.v1", asEvent(question));
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
  });
});
