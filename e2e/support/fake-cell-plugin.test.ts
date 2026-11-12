import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentChannelConversationOpen } from "../../packages/contracts/src/automation-fan-out";
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
/** The `authorization` header of each request in `seen`, by index (07.17: the in-cell MCP call sends the rendered one). */
const seenAuth: Array<string | undefined> = [];
let server: Server;
let plugin: FakeCellPlugin;
let apiUrl = "";

/**
 * 07.17-18: answers decided per request (method, path, body), asked before `answers`; `undefined` falls through. The
 * board PATCH and the open route need them (a 409 then a 200; the items echoed back).
 */
const routes: Array<
  (method: string, url: string, body: Record<string, unknown>) => [number, unknown] | undefined
> = [];

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
      seenAuth.push(req.headers.authorization);
      const url = req.url ?? "";
      const sent = seen.at(-1)?.body ?? {};
      const routed = routes.map((r) => r(req.method ?? "GET", url, sent)).find((x) => x !== undefined);
      const [status, body] = routed
        ? routed
        : /^\/agent-channel\/v1\/turns\/[^/]+\/done$/u.test(url)
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

// ---------------------------------------------------------------- 07.16-21: the bot's own Work Zone sessions (PD-26)

const WS = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-0000000000ab";
const CARD = "00000000-0000-4000-8000-0000000000ac";
const ROOT = "00000000-0000-4000-8000-0000000000ad";
const ANA_ID = "00000000-0000-4000-8000-0000000000ae";
const VICTOR_ID = "00000000-0000-4000-8000-0000000000af";
const ATLAS_ID = "00000000-0000-4000-8000-0000000000a7";
const WAKE_EVENT = "00000000-0000-4000-8000-0000000000e8";
const WORK_SESSION_TOOLS = [
  "ocw_work_session_start",
  "ocw_work_session_prompt",
  "ocw_work_session_read",
  "ocw_work_session_stop",
];

/** A channel turn of Atlas for Ana, offered the four Work Zone tools. */
const atlasTurn = (over: Record<string, unknown> = {}) =>
  ({
    eventId: "00000000-0000-4000-8000-0000000000e7",
    seq: 1,
    agent: { id: ATLAS_ID, handle: "atlas", displayName: "Atlas" },
    conversation: { id: "00000000-0000-4000-8000-0000000000c7", kind: "channel", name: "eng" },
    thread: { rootMessageId: ROOT },
    message: { id: ROOT, text: "", author: { kind: "user", id: ANA_ID, displayName: "Ana Gil" } },
    threadHistory: [],
    roster: [],
    turn: { tools: [...WORK_SESSION_TOOLS] },
    ...over,
  }) as unknown as MentionPayload;

/** A read answer whose last output text ends with `Mode: fullAccess` (the fake runtime's footer). */
const READ_ANSWER = {
  kind: "read",
  session: {
    id: WS,
    status: "idle",
    runtime: "claude-code",
    model: "opus",
    mode: "fullAccess",
    worktree: true,
    title: "Fix the invoice test",
    projectName: "billing-api",
    updatedAt: "2026-11-09T10:00:00.000Z",
  },
  queue: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0, mine: [] },
  output: {
    texts: [
      { seq: 3, text: "I'll start by reading the project README. " },
      { seq: 9, text: "Done. I created `notes/ocw-change-1.md`.\n\nModel: opus\nMode: fullAccess\n" },
    ],
    truncated: false,
  },
  tools: [],
  changes: null,
  approvals: [],
  deciders: [],
  error: null,
  cursor: 12,
};

/** The wake (`agent.work_session.v1`) of Atlas's session: built like a mention of Atlas on its card, for Ana. */
const wake = (workSession: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  asEvent({
    ...atlasTurn({
      eventId: WAKE_EVENT,
      message: { id: CARD, text: "summary", author: { kind: "user", id: ANA_ID, displayName: "Ana Gil" } },
      ...over,
    }),
    type: "agent.work_session.v1",
    workSession: {
      workSessionId: WS,
      status: "idle",
      pendingApprovals: 0,
      deciders: [],
      ...workSession,
    },
  });

const TURN_DONE = "Work Zone session in billing-api finished turn 1; nothing is queued.";
const WAITING_SUMMARY = "Work Zone session in billing-api is waiting for 3 approvals.";

describe("FakeCellPlugin Work Zone sessions (07.16-21, PD-26)", () => {
  it("ocw_work_session_start posts the turn, the project, the prompt and only the choices given to /work-sessions/start and renders `started <project> (<mode>)`", async () => {
    answers["/agent-channel/v1/work-sessions/start"] = [
      200,
      {
        kind: "started",
        workSessionId: WS,
        status: "provisioning",
        cardMessageId: CARD,
        model: "opus",
        mode: "fullAccess",
        projectName: "billing-api",
      },
    ];
    const m = atlasTurn();
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(m, [
      {
        tool: "ocw_work_session_start",
        // A device, a user or an audience never travels: the plugin's schema is closed (07.16-08).
        args: {
          projectId: PROJECT,
          prompt: "fix the invoice test",
          permissionMode: "fullAccess",
          deviceId: "d",
        },
      },
      { tool: "ocw_work_session_start", args: { projectId: PROJECT, prompt: "and the ledger" } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_work_session_start: started billing-api (fullAccess)",
      "Tool ocw_work_session_start: started billing-api (fullAccess)",
    ]);
    expect(seen.slice(from)).toEqual([
      {
        path: "/agent-channel/v1/work-sessions/start",
        body: {
          eventId: m.eventId,
          agentId: m.agent.id,
          projectId: PROJECT,
          prompt: "fix the invoice test",
          permissionMode: "fullAccess",
        },
      },
      {
        path: "/agent-channel/v1/work-sessions/start",
        body: { eventId: m.eventId, agentId: m.agent.id, projectId: PROJECT, prompt: "and the ledger" },
      },
    ]);
    expect(plugin.workSessionRequests.at(-1)).toMatchObject({
      eventId: m.eventId,
      tool: "ocw_work_session_start",
      route: "/work-sessions/start",
      status: 200,
      body: { kind: "started", cardMessageId: CARD },
    });
  });

  it("a start renders `proposed` and `refused (<code>)` (in-band or the error envelope's code); a tool the turn does not offer is never sent", async () => {
    const m = atlasTurn();
    const start = { tool: "ocw_work_session_start", args: { projectId: PROJECT, prompt: "x" } };
    answers["/agent-channel/v1/work-sessions/start"] = [
      200,
      { kind: "proposed", approvalId: WS, reason: "outside_content", sentence: "s" },
    ];
    expect(await plugin.simulateToolCalls(m, [start])).toEqual(["Tool ocw_work_session_start: proposed"]);
    answers["/agent-channel/v1/work-sessions/start"] = [
      200,
      { kind: "refused", code: "device_offline", sentence: "s" },
    ];
    expect(await plugin.simulateToolCalls(m, [start])).toEqual([
      "Tool ocw_work_session_start: refused (device_offline)",
    ]);
    answers["/agent-channel/v1/work-sessions/start"] = [404, { error: { code: "unknown_turn" } }];
    expect(await plugin.simulateToolCalls(m, [start])).toEqual([
      "Tool ocw_work_session_start: refused (unknown_turn)",
    ]);
    const from = seen.length;
    expect(await plugin.simulateToolCalls(atlasTurn({ turn: { tools: [] } }), [start])).toEqual([
      "Tool ocw_work_session_start: not offered",
    ]);
    expect(since(from)).toEqual([]);
  });

  it("prompt, read and stop post the turn and their own fields only and render `queued`, `read <status>: <last output line>` and `stopped`", async () => {
    answers["/agent-channel/v1/work-sessions/prompt"] = [
      200,
      { kind: "queued", workSessionId: WS, promptId: PROJECT, position: 1, status: "queued" },
    ];
    answers["/agent-channel/v1/work-sessions/read"] = [200, READ_ANSWER];
    answers["/agent-channel/v1/work-sessions/stop"] = [200, { kind: "stopped", workSessionId: WS }];
    const m = atlasTurn();
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(m, [
      { tool: "ocw_work_session_prompt", args: { workSessionId: WS, prompt: "add a test", projectId: "p" } },
      { tool: "ocw_work_session_read", args: { workSessionId: WS } },
      { tool: "ocw_work_session_read", args: { workSessionId: WS, cursor: 12 } },
      { tool: "ocw_work_session_stop", args: { workSessionId: WS } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_work_session_prompt: queued",
      "Tool ocw_work_session_read: read idle: Mode: fullAccess",
      "Tool ocw_work_session_read: read idle: Mode: fullAccess",
      "Tool ocw_work_session_stop: stopped",
    ]);
    const turn = { eventId: m.eventId, agentId: m.agent.id };
    expect(seen.slice(from)).toEqual([
      {
        path: "/agent-channel/v1/work-sessions/prompt",
        body: { ...turn, workSessionId: WS, prompt: "add a test" },
      },
      { path: "/agent-channel/v1/work-sessions/read", body: { ...turn, workSessionId: WS } },
      { path: "/agent-channel/v1/work-sessions/read", body: { ...turn, workSessionId: WS, cursor: 12 } },
      { path: "/agent-channel/v1/work-sessions/stop", body: { ...turn, workSessionId: WS } },
    ]);
    answers["/agent-channel/v1/work-sessions/prompt"] = [
      200,
      { kind: "refused", code: "not_your_session", sentence: "s" },
    ];
    expect(
      await plugin.simulateToolCalls(m, [
        { tool: "ocw_work_session_prompt", args: { workSessionId: WS, prompt: "x" } },
      ]),
    ).toEqual(["Tool ocw_work_session_prompt: refused (not_your_session)"]);
  });

  it("a turn_done wake reads the session, then replies `Done: <last output line> @<asker handle>` on the card, in the card's thread, for the wake", async () => {
    answers["/agent-channel/v1/work-sessions/read"] = [200, READ_ANSWER];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      userHandles: { [ANA_ID]: "ana" },
    });
    const from = seen.length;
    await cell.onEvent("agent.work_session.v1", wake({ transition: "turn_done", summary: TURN_DONE }));
    expect(since(from)).toEqual([
      "/agent-channel/v1/work-sessions/read",
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    expect(seen.at(-3)?.body).toEqual({ eventId: WAKE_EVENT, agentId: ATLAS_ID, workSessionId: WS });
    expect(seen.at(-1)?.body).toEqual({
      agentId: ATLAS_ID,
      conversationId: "00000000-0000-4000-8000-0000000000c7",
      threadRootMessageId: ROOT,
      inReplyToMessageId: CARD,
      eventId: WAKE_EVENT,
      text: "Done: Mode: fullAccess @ana",
      idempotencyKey: `evt:${WAKE_EVENT}`,
    });
    expect(cell.workSessionWakes.at(-1)).toEqual({
      eventId: WAKE_EVENT,
      transition: "turn_done",
      workSessionId: WS,
      text: "Done: Mode: fullAccess @ana",
    });
  });

  it("a waiting_approval wake reads the session for the pending tools and names every decider; other transitions say the summary to the asker", async () => {
    // The summary as the API writes it since code review WR-01: a count, never the runtime's tool names.
    const summary = `${WAITING_SUMMARY} The bot can't approve it; mention one of the people listed.`;
    const deciders = [
      { id: VICTOR_ID, handle: "victor", displayName: "Víctor Ruiz" },
      { id: ANA_ID, handle: "ana", displayName: "Ana Gil" },
    ];
    answers["/agent-channel/v1/work-sessions/read"] = [
      200,
      {
        ...READ_ANSWER,
        session: { ...READ_ANSWER.session, status: "waiting_approval", mode: "default" },
        approvals: [
          { id: PROJECT, tool: "Write", paths: ["notes/ocw-change-1.md"], summary: "Create notes" },
          { id: CARD, tool: "Write", paths: ["notes/b.md"], summary: "Create notes" },
          { id: ROOT, tool: "Bash", paths: [], summary: "npm test" },
        ],
        deciders,
      },
    ];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      userHandles: { [ANA_ID]: "ana" },
    });
    const waiting = { transition: "waiting_approval", status: "waiting_approval", pendingApprovals: 3 };
    let from = seen.length;
    await cell.onEvent("agent.work_session.v1", wake({ ...waiting, summary, deciders }));
    expect(since(from)).toEqual([
      "/agent-channel/v1/work-sessions/read",
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    expect(seen.at(-3)?.body).toEqual({ eventId: WAKE_EVENT, agentId: ATLAS_ID, workSessionId: WS });
    // Each tool once, in the read's order; the deciders the wake names. The bot never calls a decision route.
    expect(seen.at(-1)?.body.text).toBe("Needs approval: Write, Bash @victor @ana");
    expect(cell.workSessionWakes.at(-1)).toMatchObject({
      transition: "waiting_approval",
      text: "Needs approval: Write, Bash @victor @ana",
    });

    // Not offered the read (the consent was revoked): it still names who decides, without a tool.
    from = seen.length;
    await cell.onEvent(
      "agent.work_session.v1",
      wake({ ...waiting, summary, deciders: deciders.slice(0, 1) }, { turn: { tools: [] } }),
    );
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
    expect(seen.at(-1)?.body.text).toBe("Needs approval: a tool @victor");

    from = seen.length;
    await cell.onEvent(
      "agent.work_session.v1",
      wake(
        {
          transition: "failed",
          status: "failed",
          summary: "Work Zone session in billing-api failed during turn 1.",
          deciders: [{ id: VICTOR_ID, handle: "victor", displayName: "Víctor Ruiz" }],
        },
        // No handle given for this asker: the decider with the asker's id names them.
        { message: { id: CARD, text: "s", author: { kind: "user", id: VICTOR_ID, displayName: "" } } },
      ),
    );
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
    expect(seen.at(-1)?.body.text).toBe(
      "failed: Work Zone session in billing-api failed during turn 1. @victor",
    );
  });

  it("a wake is answered only with autoReply and never for a held bot; a turn_done wake not offered the read answers with the summary", async () => {
    const quiet = new FakeCellPlugin({ apiUrl, token: "cell-token" });
    const held = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      holdAgents: new Set([ATLAS_ID]),
    });
    let from = seen.length;
    const ev = wake({ transition: "turn_done", summary: TURN_DONE });
    await quiet.onEvent("agent.work_session.v1", ev);
    await held.onEvent("agent.work_session.v1", ev);
    expect(since(from)).toEqual([]);

    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      userHandles: { [ANA_ID]: "ana" },
    });
    from = seen.length;
    await cell.onEvent(
      "agent.work_session.v1",
      wake({ transition: "turn_done", summary: TURN_DONE }, { turn: { tools: [] } }),
    );
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
    expect(seen.at(-1)?.body.text).toBe(`Done: ${TURN_DONE} @ana`);
  });

  it("07.17.1.1-10: ocw_work_session_upload and _download post only their own keys to /work-sessions/upload|download", async () => {
    const ATTACHMENT = "00000000-0000-4000-8000-0000000000b1";
    answers["/agent-channel/v1/work-sessions/upload"] = [
      404,
      { error: { code: "attachment_not_found", message: "x" } },
    ];
    answers["/agent-channel/v1/work-sessions/download"] = [
      404,
      { error: { code: "session_not_found", message: "x" } },
    ];
    const m = atlasTurn({
      turn: { tools: [...WORK_SESSION_TOOLS, "ocw_work_session_upload", "ocw_work_session_download"] },
    });
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(m, [
      {
        tool: "ocw_work_session_upload",
        args: {
          workSessionId: WS,
          attachmentId: ATTACHMENT,
          path: " docs/spec.md ",
          overwrite: true,
          url: "x",
        },
      },
      { tool: "ocw_work_session_download", args: { workSessionId: WS, path: "notes/out.md", name: "x" } },
    ]);
    expect(lines).toEqual([
      "Tool ocw_work_session_upload: refused (attachment_not_found)",
      "Tool ocw_work_session_download: refused (session_not_found)",
    ]);
    expect(seen.slice(from)).toEqual([
      {
        path: "/agent-channel/v1/work-sessions/upload",
        body: {
          eventId: m.eventId,
          agentId: m.agent.id,
          workSessionId: WS,
          attachmentId: ATTACHMENT,
          path: "docs/spec.md",
          overwrite: true,
        },
      },
      {
        path: "/agent-channel/v1/work-sessions/download",
        body: { eventId: m.eventId, agentId: m.agent.id, workSessionId: WS, path: "notes/out.md" },
      },
    ]);
  });
});

// ---------------------------------------------------------------- 07.17-18: fan-out runs, item turns, card wakes (PD-22)

const FLEET = "00000000-0000-4000-8000-000000000f01";
const RUNS_ROOT = "00000000-0000-4000-8000-000000000f02";
const RUN_CARD = "00000000-0000-4000-8000-000000000f03";
const ROOT42 = "00000000-0000-4000-8000-000000000f04";
const ROOT43 = "00000000-0000-4000-8000-000000000f05";
const RUN_EVENT = "00000000-0000-4000-8000-000000000f06";
const ITEM_EVENT = "00000000-0000-4000-8000-000000000f07";
const ITEM_WAKE = "00000000-0000-4000-8000-000000000f08";
const DOING = "00000000-0000-4000-8000-000000000f09";
const DONE = "00000000-0000-4000-8000-000000000f0a";
const LOGISTICS = "00000000-0000-4000-8000-000000000f0b";
const SAM_ID = "00000000-0000-4000-8000-000000000f0c";
const OPEN = "/agent-channel/v1/conversations/open";
const CONNECTOR_CALL = "/agent-channel/v1/connectors/call";
const ESCALATION = [
  { kind: "unit", id: LOGISTICS, handle: "logistics", displayName: "Logistics" },
  { kind: "user", id: SAM_ID, handle: "sam", displayName: "Sam Lee" },
];

/** Atlas's fan-out run turn on the run card of the automation's "· Runs" thread on #fleet, as Víctor. */
const fanOutRun = (over: Record<string, unknown> = {}) =>
  asEvent({
    eventId: RUN_EVENT,
    seq: 1,
    type: "agent.automation_run.v1",
    agent: { id: ATLAS_ID, handle: "atlas", displayName: "Atlas" },
    conversation: { id: FLEET, kind: "channel", name: "fleet" },
    thread: { rootMessageId: RUNS_ROOT },
    message: {
      id: RUN_CARD,
      text: "run",
      author: { kind: "user", id: VICTOR_ID, displayName: "Víctor Ruiz" },
    },
    threadHistory: [],
    roster: [],
    turn: { tools: ["ocw_conversation_open", "erp__list_records", "erp__get_record"] },
    automationRun: {
      automationId: PROJECT,
      runId: WS,
      name: "New orders",
      trigger: "manual",
      instructions: "Open a card for each new order.",
      inbound: null,
    },
    ...over,
  });

/** The item turn of order 1042 in its card's thread (tainted from the start: the item is outside content). */
const itemTurn = (over: Record<string, unknown> = {}) =>
  asEvent({
    eventId: ITEM_EVENT,
    seq: 2,
    type: "agent.automation_item.v1",
    agent: { id: ATLAS_ID, handle: "atlas", displayName: "Atlas" },
    conversation: { id: FLEET, kind: "channel", name: "fleet" },
    thread: { rootMessageId: ROOT42 },
    message: {
      id: ROOT42,
      text: "opened",
      author: { kind: "user", id: VICTOR_ID, displayName: "Víctor Ruiz" },
    },
    threadHistory: [],
    roster: [],
    turn: { tools: ["ocw_board_card", ...WORK_SESSION_TOOLS], tainted: true },
    automationItem: {
      automationId: PROJECT,
      runId: WS,
      itemId: CARD,
      name: "New orders",
      instructions: "Open a card for each new order.",
      item: { title: "Order 1042", text: "Order 1042 from the ERP.", openedAt: "2026-11-10T10:00:00.000Z" },
      escalation: ESCALATION,
    },
    ...over,
  });

/** The wake of the session the item turn started, in the card's thread (the live card in it). */
const itemWake = (workSession: Record<string, unknown>, root = ROOT42) =>
  wake(workSession, {
    eventId: ITEM_WAKE,
    conversation: { id: FLEET, kind: "channel", name: "fleet" },
    thread: { rootMessageId: root },
    message: {
      id: CARD,
      text: "summary",
      author: { kind: "user", id: VICTOR_ID, displayName: "Víctor Ruiz" },
    },
    turn: { tools: ["ocw_board_card", ...WORK_SESSION_TOOLS], tainted: true },
  });

const boardCardBody = (messageId: string, version: number, columnId: string) => ({
  card: {
    messageId,
    conversationId: FLEET,
    columnId,
    rank: "a",
    waitingOn: "none",
    title: "Order 1042",
    description: "",
    number: null,
    version,
  },
});

type Route = (method: string, url: string, body: Record<string, unknown>) => [number, unknown] | undefined;

/** The card's PATCH answers 200 at `start` (and bumps it), else the API's 409 with the current card in its details. */
function boardCardAt(messageId: string, start: number): Route {
  let current = start;
  return (method, url, body) => {
    if (method !== "PATCH" || url !== `/agent-channel/v1/board/cards/${messageId}`) return undefined;
    const column = String((body.move as { columnId?: string } | undefined)?.columnId ?? DOING);
    if (body.expectedVersion !== current) {
      return [
        409,
        {
          error: {
            code: "board_card_version_conflict",
            message: "x",
            details: boardCardBody(messageId, current, column),
          },
        },
      ];
    }
    current += 1;
    return [200, boardCardBody(messageId, current, column)];
  };
}

/** The open route: every key opened except 1043, which an earlier run opened (existing: not opened, not refused). */
const openAnswer: Route = (method, url, body) => {
  if (method !== "POST" || url !== OPEN) return undefined;
  const items = (body.items as Array<{ externalKey: string }> | undefined) ?? [];
  return [
    200,
    {
      ok: true,
      results: items.map((i) => ({
        externalKey: i.externalKey,
        opened: i.externalKey !== "1043",
        conversationId: FLEET,
        threadRootMessageId: i.externalKey === "1043" ? ROOT43 : ROOT42,
        refused: null,
      })),
      remainingRun: 8,
      remainingDay: 98,
    },
  ];
};

describe("FakeCellPlugin automation fan-out (07.17-18, PD-22)", () => {
  it("a fan-out run lists a proxied connector once, posts exactly the plugin's open body with an item per id it keeps, then replies `Opened <n>, existing <m>` on the run card", async () => {
    answers[CONNECTOR_CALL] = [
      200,
      { content: JSON.stringify({ ids: ["SO-10442", "1042", "1043"] }), truncated: false, isError: false },
    ];
    routes.push(openAnswer);
    const runs: unknown[] = [];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      fanOutFor: (run) => {
        runs.push(run.automationRun.runId);
        return { connector: "erp", select: (ids) => ids.filter((id) => !id.startsWith("SO-")) };
      },
    });
    const from = seen.length;
    await cell.onEvent("agent.automation_run.v1", fanOutRun());
    expect(runs).toEqual([WS]);
    // `GET /cell` renders no such server (this stub answers 404): the connector proxy reads it.
    expect(since(from)).toEqual([
      "/agent-channel/v1/cell",
      CONNECTOR_CALL,
      OPEN,
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    const turn = { eventId: RUN_EVENT, agentId: ATLAS_ID };
    expect(seen[from + 1]?.body).toEqual({ ...turn, connector: "erp", tool: "list_records", arguments: {} });
    const sent = seen[from + 2]?.body;
    expect(sent).toEqual({
      ...turn,
      items: [
        { externalKey: "1042", title: "Order 1042", body: "Order 1042 from the ERP." },
        { externalKey: "1043", title: "Order 1043", body: "Order 1043 from the ERP." },
      ],
    });
    // T-07.17-18-01: the body the plugin's own schema accepts as it is (strict: no other key).
    expect(AgentChannelConversationOpen.parse(sent)).toEqual(sent);
    expect(seen.at(-1)?.body).toEqual({
      agentId: ATLAS_ID,
      conversationId: FLEET,
      threadRootMessageId: RUNS_ROOT,
      inReplyToMessageId: RUN_CARD,
      eventId: RUN_EVENT,
      text: "Opened 1, existing 1",
      idempotencyKey: `evt:${RUN_EVENT}`,
    });
    expect(cell.conversationOpenRequests.at(-1)).toMatchObject({ eventId: RUN_EVENT, sent, status: 200 });
    routes.length = 0;
  });

  it("nothing new is an empty list; a refused open or list says why; without the option, or on a turn not offered the open tool, the run is answered as before", async () => {
    answers[CONNECTOR_CALL] = [
      200,
      { content: JSON.stringify({ ids: [] }), truncated: false, isError: false },
    ];
    answers[OPEN] = [200, { ok: true, results: [], remainingRun: 10, remainingDay: 100 }];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      fanOutFor: () => ({ connector: "erp" }),
    });
    let from = seen.length;
    await cell.onEvent("agent.automation_run.v1", fanOutRun());
    expect(seen[from + 2]?.body).toEqual({ eventId: RUN_EVENT, agentId: ATLAS_ID, items: [] });
    expect(seen.at(-1)?.body.text).toBe("Opened 0, existing 0");

    answers[OPEN] = [200, { ok: false, code: "fan_out_off", sentence: "s" }];
    await cell.onEvent("agent.automation_run.v1", fanOutRun());
    expect(seen.at(-1)?.body.text).toBe("Tool ocw_conversation_open: refused (fan_out_off)");

    // The ERP's tool is not on the turn: the list is never sent, and nothing is opened.
    from = seen.length;
    await cell.onEvent("agent.automation_run.v1", fanOutRun({ turn: { tools: ["ocw_conversation_open"] } }));
    expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
    expect(seen.at(-1)?.body.text).toBe("Tool ocw_connector_call: not offered");

    // A turn without the open tool, or a cell without the option: the 07.6 reply.
    const plain = new FakeCellPlugin({ apiUrl, token: "cell-token", autoReply: true });
    for (const [c, ev] of [
      [cell, fanOutRun({ turn: { tools: ["erp__list_records"] } })],
      [plain, fanOutRun()],
    ] as const) {
      from = seen.length;
      await c.onEvent("agent.automation_run.v1", ev);
      expect(since(from)).toEqual(["/agent-channel/v1/typing", "/agent-channel/v1/messages"]);
      expect(String(seen.at(-1)?.body.text)).toMatch(/^Asked by Víctor Ruiz/u);
    }
    delete answers[OPEN];
  });

  it("an organization server rendered in the cell is listed the real cell's way: the gate, tools/call on the server itself with its headers, the result; never the connector proxy (CI 252/255)", async () => {
    const CALL_ID = "00000000-0000-4000-8000-000000000f0d";
    const rpcs: Array<Record<string, unknown>> = [];
    // GET /cell renders the ERP (org_secret: its headers' values for the cell only), on a host only the API resolves.
    answers["/agent-channel/v1/cell"] = [
      200,
      {
        agents: [],
        mcpServers: [
          {
            id: "00000000-0000-4000-8000-000000000f0e",
            safeName: "erp",
            transport: "streamable-http",
            url: "http://fake-mcp:4291/erp-mcp",
            headers: [
              { name: "Authorization", envName: "OCW_MCP_ERP_AUTHORIZATION", value: "Bearer erp-token" },
            ],
            tools: ["list_records"],
          },
        ],
      },
    ];
    answers["/agent-channel/v1/tool-calls"] = [200, { callId: CALL_ID, allowed: true, reason: null }];
    answers[`/agent-channel/v1/tool-calls/${CALL_ID}/result`] = [200, { ok: true }];
    const erp: Route = (method, url, body) => {
      if (method !== "POST" || url !== "/erp-mcp") return undefined;
      rpcs.push(body);
      if (body.method === "initialize") {
        return [
          200,
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } },
        ];
      }
      if (body.method === "tools/call") {
        const text = JSON.stringify({ ids: ["SO-10442", "1042", "1043"] });
        return [200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } }];
      }
      return [202, null];
    };
    routes.push(erp, openAnswer);
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      mcpHostMap: { "fake-mcp:4291": new URL(apiUrl).host },
      fanOutFor: () => ({ connector: "erp", select: (ids) => ids.filter((id) => !id.startsWith("SO-")) }),
    });
    try {
      const from = seen.length;
      await cell.onEvent("agent.automation_run.v1", fanOutRun());
      expect(since(from)).toEqual([
        "/agent-channel/v1/cell",
        "/agent-channel/v1/tool-calls",
        "/erp-mcp",
        "/erp-mcp",
        "/erp-mcp",
        `/agent-channel/v1/tool-calls/${CALL_ID}/result`,
        OPEN,
        "/agent-channel/v1/typing",
        "/agent-channel/v1/messages",
      ]);
      const turn = { eventId: RUN_EVENT, agentId: ATLAS_ID };
      // The gate gets the offered name and no arguments (no approval flag on the turn), like any in-cell tool.
      expect(seen[from + 1]?.body).toEqual({ ...turn, tool: "erp__list_records", params: {} });
      expect(cell.toolCallRequests.at(-1)).toEqual({ eventId: RUN_EVENT, tool: "erp__list_records" });
      // The server itself, with the rendered header: initialize, initialized, then the MCP tool name.
      expect(rpcs.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
      expect(rpcs.at(-1)?.params).toEqual({ name: "list_records", arguments: {} });
      expect(seenAuth.slice(from + 2, from + 5)).toEqual([
        "Bearer erp-token",
        "Bearer erp-token",
        "Bearer erp-token",
      ]);
      expect(seen[from + 5]?.body).toMatchObject({ status: "ok" });
      expect(seen[from + 6]?.body).toEqual({
        ...turn,
        items: [
          { externalKey: "1042", title: "Order 1042", body: "Order 1042 from the ERP." },
          { externalKey: "1043", title: "Order 1043", body: "Order 1043 from the ERP." },
        ],
      });
      expect(seen.at(-1)?.body.text).toBe("Opened 1, existing 1");

      // A gate that refuses: the server is never called, nothing is opened, the run says why.
      answers["/agent-channel/v1/tool-calls"] = [
        200,
        { callId: CALL_ID, allowed: false, reason: "cap_reached" },
      ];
      const refusedFrom = seen.length;
      await cell.onEvent("agent.automation_run.v1", fanOutRun());
      expect(since(refusedFrom)).toEqual([
        "/agent-channel/v1/cell",
        "/agent-channel/v1/tool-calls",
        "/agent-channel/v1/typing",
        "/agent-channel/v1/messages",
      ]);
      expect(seen.at(-1)?.body.text).toBe("Tool erp__list_records: denied (cap_reached)");
    } finally {
      routes.length = 0;
      delete answers["/agent-channel/v1/cell"];
      delete answers["/agent-channel/v1/tool-calls"];
      delete answers[`/agent-channel/v1/tool-calls/${CALL_ID}/result`];
    }
  });

  it("an item turn runs itemCallsFor in the card's thread: a tainted turn moves its card without reading the board (version 1), then starts the session", async () => {
    routes.push(boardCardAt(ROOT42, 1));
    answers["/agent-channel/v1/work-sessions/start"] = [
      200,
      {
        kind: "started",
        workSessionId: WS,
        status: "provisioning",
        cardMessageId: CARD,
        model: "opus",
        mode: "fullAccess",
        projectName: "fleet-api",
      },
    ];
    const items: string[] = [];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      itemCallsFor: (item) => {
        items.push(item.automationItem.item.title);
        return [
          { tool: "ocw_board_card", args: { action: "move", columnId: DOING } },
          {
            tool: "ocw_work_session_start",
            args: { projectId: PROJECT, prompt: "Prepare order 1042", permissionMode: "fullAccess" },
          },
        ];
      },
    });
    const from = seen.length;
    await cell.onEvent("agent.automation_item.v1", itemTurn());
    expect(items).toEqual(["Order 1042"]);
    expect(since(from)).toEqual([
      `/agent-channel/v1/board/cards/${ROOT42}`,
      "/agent-channel/v1/work-sessions/start",
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    expect(seen[from]?.body).toEqual({
      eventId: ITEM_EVENT,
      agentId: ATLAS_ID,
      expectedVersion: 1,
      move: { columnId: DOING, afterCardId: null },
    });
    expect(seen.at(-1)?.body).toEqual({
      agentId: ATLAS_ID,
      conversationId: FLEET,
      threadRootMessageId: ROOT42,
      inReplyToMessageId: ROOT42,
      eventId: ITEM_EVENT,
      text: "Tool ocw_board_card: moved\nTool ocw_work_session_start: started fleet-api (fullAccess)",
      idempotencyKey: `evt:${ITEM_EVENT}`,
    });
    expect(cell.itemTurns.at(-1)).toEqual({
      eventId: ITEM_EVENT,
      rootMessageId: ROOT42,
      title: "Order 1042",
      lines: ["Tool ocw_board_card: moved", "Tool ocw_work_session_start: started fleet-api (fullAccess)"],
    });

    // Like the plugin: a tainted turn never reads the board nor creates a card (refused locally, nothing sent).
    const before = seen.length;
    expect(
      await cell.simulateToolCalls(itemTurn() as unknown as MentionPayload, [
        { tool: "ocw_board_card", args: { action: "read" } },
        { tool: "ocw_board_card", args: { action: "create", description: "x" } },
      ]),
    ).toEqual(["Tool ocw_board_card: denied (tainted)", "Tool ocw_board_card: denied (tainted)"]);
    expect(since(before)).toEqual([]);
    routes.length = 0;
  });

  it("an item turn waits for an itemCallsFor that answers later; without the option the item event is ignored", async () => {
    answers["/agent-channel/v1/work-sessions/start"] = [
      200,
      { kind: "refused", code: "too_many_sessions", sentence: "s" },
    ];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      itemCallsFor: async () => {
        await gate;
        return [{ tool: "ocw_work_session_start", args: { projectId: PROJECT, prompt: "x" } }];
      },
    });
    const from = seen.length;
    const handled = cell.onEvent("agent.automation_item.v1", itemTurn());
    await new Promise((r) => setTimeout(r, 50));
    expect(since(from)).toEqual([]);
    release();
    await handled;
    expect(seen.at(-1)?.body.text).toBe("Tool ocw_work_session_start: refused (too_many_sessions)");

    const quiet = new FakeCellPlugin({ apiUrl, token: "cell-token", autoReply: true });
    const before = seen.length;
    await quiet.onEvent("agent.automation_item.v1", itemTurn());
    expect(since(before)).toEqual([]);
  });

  it("a turn_done wake in an item's thread runs wakeCallsFor (read, then the move retried once at the 409's version) and replies `Done: <last output line> <escalation handles>`", async () => {
    routes.push(boardCardAt(ROOT42, 1));
    answers["/agent-channel/v1/work-sessions/read"] = [200, READ_ANSWER];
    const ctxs: unknown[] = [];
    const cell = new FakeCellPlugin({
      apiUrl,
      token: "cell-token",
      autoReply: true,
      userHandles: { [VICTOR_ID]: "victor" },
      itemCallsFor: () => [{ tool: "ocw_board_card", args: { action: "move", columnId: DOING } }],
      wakeCallsFor: (w, ctx) => {
        ctxs.push(ctx);
        return [
          { tool: "ocw_work_session_read", args: { workSessionId: w.workSession.workSessionId } },
          { tool: "ocw_board_card", args: { action: "move", columnId: DONE } },
        ];
      },
    });
    await cell.onEvent("agent.automation_item.v1", itemTurn());
    // The item turn left the card at version 2; someone moved it since (3): one 409, then one retry at 3.
    routes.length = 0;
    routes.push(boardCardAt(ROOT42, 3));
    const from = seen.length;
    await cell.onEvent("agent.work_session.v1", itemWake({ transition: "turn_done", summary: TURN_DONE }));
    expect(ctxs).toEqual([{ escalationHandles: ["logistics", "sam"] }]);
    expect(since(from)).toEqual([
      "/agent-channel/v1/work-sessions/read",
      `/agent-channel/v1/board/cards/${ROOT42}`,
      `/agent-channel/v1/board/cards/${ROOT42}`,
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    expect(seen[from + 1]?.body).toMatchObject({ eventId: ITEM_WAKE, expectedVersion: 2 });
    expect(seen[from + 2]?.body).toEqual({
      eventId: ITEM_WAKE,
      agentId: ATLAS_ID,
      expectedVersion: 3,
      move: { columnId: DONE, afterCardId: null },
    });
    expect(seen.at(-1)?.body).toEqual({
      agentId: ATLAS_ID,
      conversationId: FLEET,
      threadRootMessageId: ROOT42,
      inReplyToMessageId: CARD,
      eventId: ITEM_WAKE,
      text: "Done: Mode: fullAccess @logistics @sam",
      idempotencyKey: `evt:${ITEM_WAKE}`,
    });
    expect(cell.workSessionWakes.at(-1)).toEqual({
      eventId: ITEM_WAKE,
      transition: "turn_done",
      workSessionId: WS,
      text: "Done: Mode: fullAccess @logistics @sam",
      lines: ["Tool ocw_work_session_read: read idle: Mode: fullAccess", "Tool ocw_board_card: moved"],
    });

    // Another thread's wake, and a waiting_approval wake in the item's thread: the 07.16 answers.
    const before = seen.length;
    await cell.onEvent(
      "agent.work_session.v1",
      itemWake({ transition: "turn_done", summary: TURN_DONE }, ROOT43),
    );
    expect(since(before)).toEqual([
      "/agent-channel/v1/work-sessions/read",
      "/agent-channel/v1/typing",
      "/agent-channel/v1/messages",
    ]);
    expect(seen.at(-1)?.body.text).toBe("Done: Mode: fullAccess @victor");
    await cell.onEvent(
      "agent.work_session.v1",
      itemWake({ transition: "waiting_approval", status: "waiting_approval", summary: WAITING_SUMMARY }),
    );
    expect(seen.at(-1)?.body.text).toBe("Needs approval: a tool");
    expect(ctxs).toHaveLength(1);
    routes.length = 0;
  });

  it("an untainted turn still reads the board before a move and never retries a 409", async () => {
    answers["/agent-channel/v1/board/read"] = [
      200,
      { columns: [], card: boardCardBody(ROOT42, 5, DOING).card },
    ];
    routes.push(boardCardAt(ROOT42, 6));
    const from = seen.length;
    const lines = await plugin.simulateToolCalls(
      itemTurn({ turn: { tools: ["ocw_board_card"] } }) as unknown as MentionPayload,
      [{ tool: "ocw_board_card", args: { action: "move", columnId: DONE } }],
    );
    expect(lines).toEqual(["Tool ocw_board_card: denied (board_card_version_conflict)"]);
    expect(since(from)).toEqual(["/agent-channel/v1/board/read", `/agent-channel/v1/board/cards/${ROOT42}`]);
    expect(seen.at(-1)?.body).toMatchObject({ expectedVersion: 5 });
    routes.length = 0;
    delete answers["/agent-channel/v1/board/read"];
  });
});
