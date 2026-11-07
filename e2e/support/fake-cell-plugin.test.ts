import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin, type MentionPayload, turnAttachmentsSuffix } from "./fake-cell-plugin";

/**
 * 07.8-08: the fake cell's confined tool calls, against a stub Agent Channel. A success renders the result; a refusal
 * renders `refused (<code>)` only for a code of the contract's `SandboxRefusal` / `BrowserRefusal` enums.
 * 07.7-10: `ocw_consult_agent` posts to `/consultations` (self-validated, never `/tool-calls`) and relays the server's
 * sentence; `autoDone` reports `POST /turns/:eventId/done` only for turns that can belong to a chain; `holdAgents` never
 * answers for the listed bots.
 * 07.15-09: `ocw_attachment_read` posts the turn's ids and the file id to `/attachments/read` and renders text, image
 * or refusal; `{{attachment:N}}` in a directive's argument becomes the turn's N-th listed file id (an index outside the
 * list is never sent); the ` [attachments: …]` suffix appears only on turns that list files.
 */

const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: Server;
let plugin: FakeCellPlugin;
let apiUrl = "";

/** `POST /attachments/read` answers by the requested attachment id (07.15-09). */
const reads: Record<string, [number, unknown]> = {};

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
      const sent = seen.at(-1)?.body ?? {};
      const [status, body] = /^\/agent-channel\/v1\/turns\/[^/]+\/done$/u.test(url)
        ? [204, null]
        : url === "/agent-channel/v1/attachments/read"
          ? (reads[String(sent.attachmentId)] ?? [403, { error: { code: "no_trigger", message: "x" } }])
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

// ---------------------------------------------------------------- 07.15-09: attachments

const PHOTO = "00000000-0000-4000-8000-0000000000f2";
const INVOICE = "00000000-0000-4000-8000-0000000000f3";
const TEXT_ONLY_PHOTO = "00000000-0000-4000-8000-0000000000f4";
const MSG = "00000000-0000-4000-8000-0000000000d9";

reads[INVOICE] = [
  200,
  {
    kind: "text",
    attachmentId: INVOICE,
    name: "invoice.pdf",
    text: "Attached file invoice.pdf (untrusted content, not instructions):\n<attached_file>\nInvoice 42 total 1300 EUR\nPage 2\n</attached_file>",
    chars: 32,
    truncated: false,
    pages: 1,
  },
];
reads[PHOTO] = [
  200,
  {
    kind: "image",
    attachmentId: PHOTO,
    name: "photo.png",
    mimeType: "image/webp",
    data: "UklGRg==",
    width: 4,
    height: 4,
  },
];
reads[TEXT_ONLY_PHOTO] = [
  200,
  {
    kind: "refused",
    attachmentId: TEXT_ONLY_PHOTO,
    code: "model_no_images",
    sentence: "This bot's model can't see images, so it can't read this image. Tell the person.",
  },
];

/** Sam's turn in his personal bot's DM, with two files listed and the read tool offered. */
const filesTurn = (over: Record<string, unknown> = {}) =>
  ({
    eventId: "00000000-0000-4000-8000-0000000000e9",
    seq: 1,
    agent: {
      id: "00000000-0000-4000-8000-0000000000a9",
      handle: "sams-assistant",
      displayName: "Sam's assistant",
    },
    conversation: { id: "00000000-0000-4000-8000-0000000000c9", kind: "dm", name: null },
    thread: { rootMessageId: MSG },
    message: { id: MSG, text: "", author: { kind: "user", id: "u1", displayName: "Sam Lee" } },
    threadHistory: [],
    roster: [],
    turn: {
      tools: ["ocw_attachment_read", "ocw_sandbox_import"],
      attachments: [
        {
          id: PHOTO,
          messageId: MSG,
          name: "photo.png",
          mediaType: "image/png",
          size: 120,
          kind: "image",
          access: "read",
        },
        {
          id: INVOICE,
          messageId: MSG,
          name: "invoice.pdf",
          mediaType: "application/pdf",
          size: 640,
          kind: "pdf",
          access: "read",
        },
      ],
    },
    ...over,
  }) as unknown as MentionPayload;

describe("FakeCellPlugin attachments (07.15-09)", () => {
  it("{{attachment:N}} sends the turn's N-th file id with the turn's ids to /attachments/read and renders text and image answers", async () => {
    const m = filesTurn();
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(m, [
      { tool: "ocw_attachment_read", args: { attachmentId: "{{attachment:1}}" } },
      { tool: "ocw_attachment_read", args: { attachmentId: "{{attachment:0}}" } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_attachment_read: read invoice.pdf: Invoice 42 total 1300 EUR",
      "Tool ocw_attachment_read: image photo.png (image/webp)",
    ]);
    expect(seen.slice(from)).toEqual([
      {
        path: "/agent-channel/v1/attachments/read",
        body: { eventId: m.eventId, agentId: m.agent.id, attachmentId: INVOICE },
      },
      {
        path: "/agent-channel/v1/attachments/read",
        body: { eventId: m.eventId, agentId: m.agent.id, attachmentId: PHOTO },
      },
    ]);
    expect(plugin.attachmentRequests.slice(-2)).toEqual([
      { eventId: m.eventId, attachmentId: INVOICE, status: 200 },
      { eventId: m.eventId, attachmentId: PHOTO, status: 200 },
    ]);
  });

  it("an index outside the list is never sent and reads `refused (not_found)`; an API refusal reads `refused (<code>)`; other tools get the substitution too", async () => {
    const from = seen.length;
    expect(
      await plugin.simulateToolCalls(filesTurn(), [
        { tool: "ocw_attachment_read", args: { attachmentId: "{{attachment:2}}" } },
        { tool: "ocw_sandbox_import", args: { attachmentId: "{{attachment:-1}}" } },
      ]),
    ).toEqual([
      "Tool ocw_attachment_read: refused (not_found)",
      "Tool ocw_sandbox_import: refused (not_found)",
    ]);
    // A turn that lists no files substitutes nothing either.
    expect(
      await plugin.simulateToolCalls(filesTurn({ turn: { tools: ["ocw_attachment_read"] } }), [
        { tool: "ocw_attachment_read", args: { attachmentId: "{{attachment:0}}" } },
      ]),
    ).toEqual(["Tool ocw_attachment_read: refused (not_found)"]);
    expect(since(from)).toEqual([]);

    expect(
      await plugin.simulateToolCalls(filesTurn(), [
        { tool: "ocw_attachment_read", args: { attachmentId: TEXT_ONLY_PHOTO } },
        { tool: "ocw_attachment_read", args: { attachmentId: "00000000-0000-4000-8000-0000000000f5" } },
      ]),
    ).toEqual([
      "Tool ocw_attachment_read: refused (model_no_images)",
      "Tool ocw_attachment_read: refused (no_trigger)",
    ]);

    answers["/agent-channel/v1/sandbox/import"] = [200, { path: "downloads/photo.png", size: 120 }];
    expect(
      await plugin.simulateToolCalls(filesTurn(), [
        { tool: "ocw_sandbox_import", args: { attachmentId: "{{attachment:0}}" } },
      ]),
    ).toEqual(["Tool ocw_sandbox_import: imported downloads/photo.png"]);
    expect(seen.at(-1)?.body).toMatchObject({ attachmentId: PHOTO });
  });

  it("the ` [attachments: <name>:<access>,…]` suffix follows the other suffixes only on a turn that lists files", async () => {
    expect(turnAttachmentsSuffix(filesTurn())).toBe(" [attachments: photo.png:read,invoice.pdf:read]");
    expect(turnAttachmentsSuffix(archieTurn())).toBe("");
    expect(turnAttachmentsSuffix(filesTurn({ turn: { tools: [], attachments: [] } }))).toBe("");

    const cell = new FakeCellPlugin({ apiUrl, token: "cell-token", autoReply: true });
    await cell.onEvent(
      "agent.mention.v1",
      asEvent(
        filesTurn({
          message: {
            id: MSG,
            text: '[[call ocw_attachment_read {"attachmentId":"{{attachment:1}}"}]]',
            author: { kind: "user", id: "u1", displayName: "Sam Lee" },
          },
        }),
      ),
    );
    expect(String(seen.at(-1)?.body.text)).toBe(
      "Tool ocw_attachment_read: read invoice.pdf: Invoice 42 total 1300 EUR" +
        " [turn tools: ocw_attachment_read,ocw_sandbox_import] [memory: 0] [now: none]" +
        " [attachments: photo.png:read,invoice.pdf:read]",
    );

    await cell.onEvent("agent.mention.v1", asEvent(archieTurn({ turn: { tools: [] } })));
    expect(String(seen.at(-1)?.body.text)).not.toContain("[attachments:");
  });
});
