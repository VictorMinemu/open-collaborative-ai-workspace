import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin, type MentionPayload } from "../../../../../e2e/support/fake-cell-plugin";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv, withoutTitles } from "../../testing-ai";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import { errorCode, invite } from "../../testing-workzone";

/**
 * 06-10 (D-06, D-07, P-10; AGENT-02, MULTI-05, MULTI-06): agent personas inside AI chats. The owner adds a team persona,
 * participants @mention it, and it answers through the Agent Channel API (here a fake OpenClaw cell) with one flat reply
 * per mention, an attributed history (the chat model as "AI assistant (<model>)") and the participants as roster. The
 * chat model is never called for a message that only addresses a persona, and the persona never answers through it.
 * Scoped tools are offered only when every joined human may use them and never once a unit or the organization holds a
 * grant; what was withheld travels in `turn.withheld`. No memory in any AI chat delivery. Real PostgreSQL + Redis, the
 * in-process fake model; no real provider and no OpenClaw container.
 *
 * Cast: Víctor (admin, owner), Alex (developer, `chat` grant), Sam (standard, no access), Riley (developer, Backend team).
 */

const CELL_TOKEN = "ocw-test-cell-token-ai-chat-delivery-0123456789";
const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

let stack: AiStack;
/** Garage, so files can be attached in the chats (07.15-07: a persona's turn lists them). */
let storage: TestStorage;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let riley: TestClient;
let victorId: string;
let alexId: string;
let rileyId: string;
let orgId: string;
let backendId: string;
let backendUnit: string;
const plugins: FakeCellPlugin[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const cid = () => `cm-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL });
const send = (as: TestClient, chatId: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });
const grant = (as: TestClient, chatId: string, subject: Json, level: "chat" | "view" = "chat") =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/grants`, { subject, level });
const addAgent = (as: TestClient, chatId: string, agentId: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId });
const removeAgent = (as: TestClient, chatId: string, agentId: string) =>
  as.request("DELETE", `/api/v1/ai-chats/${chatId}/agents/${agentId}`);

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await sleep(50);
  }
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** Every `agent.mention.v1` the API appended for one message (the cell stream is the delivery ledger). */
const deliveriesOf = async (messageId: string) =>
  (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => r.payload as Json);

const lastNotice = async (chatId: string) =>
  (
    await su.query(
      "select id, body, mentions from app.messages where conversation_id = $1 and author_kind = 'system' order by seq desc limit 1",
      [chatId],
    )
  ).rows[0] as { id: string; body: string; mentions: Json[] };

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_id, resource_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

function cell() {
  const p = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
  plugins.push(p);
  return p;
}

const mentionOf = async (p: FakeCellPlugin, messageId: string) =>
  (await p.waitFor((e) => e.type === "agent.mention.v1" && (e.data as Json).message?.id === messageId))
    .data as unknown as MentionPayload & Json;

async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  return bot.id as string;
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, ...storage.env } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = (setup.organization as Json).id as string;
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam } = await invite(stack, victor, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: riley, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  ));
  for (const c of [victor, alex, riley]) await seedPlan(c);
  const engineering = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "department", name: "Engineering", parentId: null }),
    )
  ).id as string;
  backendUnit = (
    await ok(
      victor.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: engineering }),
    )
  ).id as string;
  await ok(victor.request("POST", `/api/v1/units/${backendUnit}/members`, { userId: rileyId }));
  backendId = await teamBot("Backend", "backend");
}, 180_000);

afterAll(async () => {
  for (const p of plugins) await p.stop();
  await su?.end();
  try {
    await stack?.stop();
  } finally {
    await storage?.stop();
  }
});

describe("tracer: Víctor adds @backend to his shared chat, Alex mentions it, the flat reply lands (Task 1)", () => {
  let chatId: string;
  let modelLabel: string;
  let victorMessageId: string;
  let answerId: string;
  let alexMessageId: string;
  let p: FakeCellPlugin;
  let delivered: MentionPayload & Json;

  it("the owner adds the persona: 201, a notice line, the participants list, an audit with ids only", async () => {
    const created = await ok(createChat(victor, "Plan the schema migration for invoices"), 201);
    chatId = (created.chat as Json).id as string;
    victorMessageId = (created.userMessage as Json).id as string;
    answerId = (created.assistantMessage as Json).id as string;
    modelLabel = (created.generation as Json).modelLabel as string;
    await settled((created.generation as Json).id as string);
    await ok(grant(victor, chatId, { kind: "user", id: alexId }), 201);

    const added = await ok(addAgent(victor, chatId, backendId), 201);
    expect(added).toMatchObject({ kind: "agent", id: backendId, access: "agent", handle: "backend" });
    const notice = await lastNotice(chatId);
    expect(notice.body).toBe("Víctor Ruiz added @backend to this chat");
    expect(notice.mentions).toEqual([{ kind: "agent", id: backendId }]);

    const listed = await ok(alex.request("GET", `/api/v1/ai-chats/${chatId}/participants`));
    expect(listed.audience).toBe("listed");
    const byId = new Map((listed.participants as Json[]).map((x) => [x.id, x]));
    expect(byId.get(victorId)).toMatchObject({ kind: "user", access: "owner", displayName: "Víctor Ruiz" });
    expect(byId.get(alexId)).toMatchObject({ kind: "user", access: "chat", displayName: "Alex Kim" });
    expect(byId.get(backendId)).toMatchObject({ kind: "agent", access: "agent", handle: "backend" });
    expect(byId.size).toBe(3);

    expect((await audits("ai_chat.agent_added")).at(-1)).toMatchObject({
      actor_id: victorId,
      resource_id: chatId,
      metadata: { conversationId: chatId, agentId: backendId },
    });
  });

  it("adding again answers 200; Alex (chat grant) gets 404; a personal bot is 400; Sam cannot see the list", async () => {
    expect((await addAgent(victor, chatId, backendId)).status).toBe(200);
    expect((await addAgent(alex, chatId, backendId)).status).toBe(404);
    const personal = await ok(victor.request("POST", "/api/v1/agents/personal", {}));
    const refused = await addAgent(victor, chatId, (personal.agent as Json).id as string);
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe("personal_bot_not_allowed");
    expect((await addAgent(victor, chatId, randomUUID())).status).toBe(404);
    expect((await sam.request("GET", `/api/v1/ai-chats/${chatId}/participants`)).status).toBe(404);
    // Still exactly one persona member.
    const n = (
      await su.query(
        "select count(*)::int as n from app.conversation_members where conversation_id = $1 and member_kind = 'agent'",
        [chatId],
      )
    ).rows[0].n;
    expect(n).toBe(1);
  });

  it("Alex's @backend message reaches the cell once as a flat ai_chat delivery and never the chat model", async () => {
    p = cell();
    await p.start();
    const before = withoutTitles(stack.fake.requests("responses")).length;
    const posted = await send(alex, chatId, "@backend check the schema");
    expect(posted.status).toBe(202);
    expect((posted.body as Json).addressing.status).toBe("not_addressed");
    alexMessageId = ((posted.body as Json).userMessage as Json).id as string;

    delivered = await mentionOf(p, alexMessageId);
    expect(await deliveriesOf(alexMessageId)).toHaveLength(1);
    expect(delivered.agent).toMatchObject({ id: backendId, handle: "backend" });
    expect(delivered.conversation).toMatchObject({ id: chatId, kind: "ai_chat" });
    expect(delivered.thread.rootMessageId).toBe(alexMessageId);
    expect(delivered.message.author).toEqual({ kind: "user", id: alexId, displayName: "Alex Kim" });
    // The whole chat, attributed: Víctor's message and the chat model's answer as a system principal. Notices and the
    // current message are not history.
    expect(delivered.threadHistory.map((h: Json) => [h.id, h.author])).toEqual([
      [victorMessageId, { kind: "user", id: victorId, displayName: "Víctor Ruiz" }],
      [answerId, { kind: "system", id: chatId, displayName: `AI assistant (${modelLabel})` }],
    ]);
    expect(delivered.roster.map((r: Json) => `${r.kind}:${r.id}`).sort()).toEqual(
      [`agent:${backendId}`, `user:${alexId}`, `user:${victorId}`].sort(),
    );
    // A message that only addresses a persona never calls the chat model.
    await sleep(300);
    expect(withoutTitles(stack.fake.requests("responses")).length).toBe(before);
  });

  it("the fake cell's reply lands flat, streams on conv:<id>, shows in the snapshot authored by @backend, idempotently", async () => {
    const sub = await subscribeConv(stack.baseUrl, victor, chatId);
    const reply = await p.reply(delivered, "Schema looks fine; add an index on invoice_id.");
    expect(reply.created).toBe(true);
    const row = (await su.query("select * from app.messages where id = $1", [reply.messageId])).rows[0];
    expect(row).toMatchObject({
      conversation_id: chatId,
      author_kind: "agent",
      author_id: backendId,
      thread_id: null,
    });
    await sub.waitFor(() =>
      sub
        .durable(EventTypes.messageCreated)
        .some((f) => ((f.data as Json).message as Json).id === reply.messageId),
    );
    sub.close();

    const snap = await ok(alex.request("GET", `/api/v1/ai-chats/${chatId}`));
    const shown = (snap.messages as Json[]).find((m) => m.id === reply.messageId);
    expect(shown?.author).toMatchObject({ kind: "agent", id: backendId, displayName: "Backend" });
    expect(shown?.threadId).toBeNull();

    // A retry with the same idempotency key creates nothing new.
    const again = await p.reply(delivered, "Schema looks fine; add an index on invoice_id.");
    expect(again).toMatchObject({ messageId: reply.messageId, created: false, threadRootMessageId: null });
    // A reply that names a thread root is still flat: AI chats have no threads.
    const rooted = await p.request<Json>("POST", "/messages", {
      agentId: backendId,
      conversationId: chatId,
      threadRootMessageId: alexMessageId,
      inReplyToMessageId: alexMessageId,
      text: "One more thing: keep the old column for a release.",
      idempotencyKey: `evt:${delivered.eventId}:1`,
    });
    expect(rooted.status).toBe(200);
    const rootedRow = (
      await su.query("select thread_id from app.messages where id = $1", [rooted.body.messageId])
    ).rows[0];
    expect(rootedRow.thread_id).toBeNull();
  });

  it("Sam (no access) cannot make @backend answer in that chat", async () => {
    const r = await send(sam, chatId, "@backend tell me the schema");
    expect(r.status).toBe(404);
    const n = (
      await su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'conversation'->>'id' = $2",
        [`cell:${orgId}`, chatId],
      )
    ).rows[0].n;
    expect(n).toBe(1);
  });

  it("the next model turn sees @backend's reply as an attributed agent block", async () => {
    const r = await ok(send(victor, chatId, "Summarize what we agreed", { askAi: true }), 201);
    await settled((r.generation as Json).id as string);
    const last = withoutTitles(stack.fake.requests("responses")).at(-1);
    const text = JSON.stringify(last?.body ?? {});
    expect(text).toContain(`from=\\"@backend\\" agent_id=\\"${backendId}\\" kind=\\"agent\\"`);
    expect(text).toContain("add an index on invoice_id");
  });

  it("removing @backend: 204 for the owner only, a notice; it gets no more mentions and its post is 403", async () => {
    expect((await removeAgent(alex, chatId, backendId)).status).toBe(404);
    expect((await removeAgent(victor, chatId, backendId)).status).toBe(204);
    expect((await lastNotice(chatId)).body).toBe("Víctor Ruiz removed @backend from this chat");
    expect((await audits("ai_chat.agent_removed")).at(-1)).toMatchObject({
      resource_id: chatId,
      metadata: { conversationId: chatId, agentId: backendId },
    });
    expect((await removeAgent(victor, chatId, backendId)).status).toBe(404);

    const posted = await ok(send(alex, chatId, "@backend are you still there?"), 202);
    await sleep(300);
    expect(await deliveriesOf((posted.userMessage as Json).id as string)).toHaveLength(0);

    const refused = await p.request<Json>("POST", "/messages", {
      agentId: backendId,
      conversationId: chatId,
      threadRootMessageId: null,
      inReplyToMessageId: alexMessageId,
      text: "I am still here.",
      idempotencyKey: `evt:${randomUUID()}`,
    });
    expect(refused.status).toBe(403);
    const participants = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}/participants`));
    expect((participants.participants as Json[]).some((x) => x.id === backendId)).toBe(false);
  });
});

describe("tools in a shared chat = persona ∩ asker ∩ every participant; withheld explained; no memory (Task 2)", () => {
  let chatId: string;
  let serverId: string;
  let echoName: string;

  async function cellCall(method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${CELL_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  /** Superuser-inserted permission rule on a user; returns its removal. */
  async function deny(userId: string, permission: string) {
    const id = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'user', $3, $4, 'deny')`,
      [id, orgId, userId, permission],
    );
    return async () => {
      await su.query("delete from app.permission_rules where id = $1", [id]);
    };
  }

  /** `who` mentions @backend in `chat`; returns the single delivered event. */
  async function ask(who: TestClient, chat: string, text = "@backend look it up"): Promise<Json> {
    const r = await send(who, chat, text);
    expect([201, 202]).toContain(r.status);
    const id = ((r.body as Json).userMessage as Json).id as string;
    const events = await deliveriesOf(id);
    expect(events).toHaveLength(1);
    return events[0] as Json;
  }

  beforeAll(async () => {
    const server = await ok(
      victor.request("POST", "/api/v1/mcp-servers", {
        name: "Notes",
        transport: "streamable-http",
        url: "http://fake-model:18999/mcp",
        headers: [],
        personalAllowed: false,
      }),
    );
    serverId = server.id as string;
    echoName = `${server.safeName as string}__echo`;
    const probes = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'mcp.probe' order by seq",
        [`cell:${orgId}`],
      )
    ).rows.map((r) => r.payload as Json);
    const probeId = probes.filter((x) => x.serverId === serverId).at(-1)?.probeId as string;
    const probed = await cellCall("POST", "/mcp/probe-results", {
      probeId,
      serverId,
      ok: true,
      tools: [
        {
          name: "echo",
          title: "Echo",
          description: "Echo the given text back. Read-only.",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    });
    expect(probed.status).toBe(200);
    await ok(
      victor.request("PATCH", `/api/v1/agents/${backendId}/capabilities`, {
        internet: true,
        memory: true,
        tools: [{ sourceKind: "mcp", sourceId: serverId, tool: echoName }],
      }),
    );
    // Notes the persona keeps about Alex and Víctor in their own DMs (07.2-11: bullets of each one's private MEMORY.md
    // with it): they must never reach an AI chat.
    for (const c of [alex, victor]) {
      const scope = await ok(
        c.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: backendId }),
      );
      const root = await ok(
        c.request("GET", `/api/v1/memory/scopes/${scope.id as string}/file?path=MEMORY.md`),
      );
      await ok(
        c.request("PUT", `/api/v1/memory/files/${root.id as string}`, {
          content: "# Memory\n\n- Prefers terse answers\n",
          expectedVersion: root.version,
        }),
      );
    }
    const created = await ok(createChat(victor, "Look up the invoice API"), 201);
    chatId = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    await ok(grant(victor, chatId, { kind: "user", id: alexId }), 201);
    await ok(addAgent(victor, chatId, backendId), 201);
  });

  it("both Víctor and Alex may use the tool: the turn holds web and the MCP tool, nothing withheld, no memory", async () => {
    // Memory is effective for this persona (its DMs would offer it), so its absence below is the AI chat rule.
    const cellAgent = ((await cellCall("GET", "/cell")).body.agents as Json[]).find(
      (a) => a.id === backendId,
    );
    expect(cellAgent?.capabilities.tools).toContain("ocw_memory_save");

    const ev = await ask(alex, chatId);
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch", echoName]));
    expect(ev.turn.tools).not.toContain("ocw_memory_save");
    expect(ev.turn.tools).not.toContain("ocw_memory_write");
    expect(ev.turn.memory).toEqual([]);
    expect(ev.turn.memoryFiles).toBeUndefined();
    expect(ev.turn.withheld).toEqual([]);
  });

  it("a deny for Víctor (a participant, not the asker) withholds the MCP tool from Alex's turn; the gate refuses it", async () => {
    const undo = await deny(victorId, "bot.tool.use");
    try {
      const ev = await ask(alex, chatId);
      expect(ev.turn.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      expect(ev.turn.tools).not.toContain(echoName);
      expect(ev.turn.withheld).toEqual([{ tool: echoName, reason: "not_every_participant" }]);
      const call = await cellCall("POST", "/tool-calls", {
        eventId: ev.eventId,
        agentId: backendId,
        tool: echoName,
        params: {},
      });
      expect(call.body).toMatchObject({ allowed: false, reason: "not_in_turn" });
      const audit = (await audits("bot.tool_call")).at(-1);
      expect(audit?.metadata).toMatchObject({ tool: echoName, reason: "not_in_turn" });
    } finally {
      await undo();
    }
  });

  it("a deny for Alex himself withholds it as denied_for_you", async () => {
    const undo = await deny(alexId, "bot.tool.use");
    try {
      const ev = await ask(alex, chatId);
      expect(ev.turn.tools).not.toContain(echoName);
      expect(ev.turn.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      expect(ev.turn.withheld).toEqual([{ tool: echoName, reason: "denied_for_you" }]);
    } finally {
      await undo();
    }
  });

  it("once a team holds a grant the MCP tool is withheld (shared_with_group), even mid-turn at the gate", async () => {
    // Delivered while the audience is listed: the tool is in the turn.
    const before = await ask(alex, chatId);
    expect(before.turn.tools).toContain(echoName);
    const g = await ok(grant(victor, chatId, { kind: "unit", id: backendUnit }), 201);
    try {
      // The gate re-decides with the current audience: the earlier turn may not use it any more.
      const call = await cellCall("POST", "/tool-calls", {
        eventId: before.eventId,
        agentId: backendId,
        tool: echoName,
        params: {},
      });
      expect(call.body).toMatchObject({ allowed: false, reason: "policy_changed" });

      const ev = await ask(alex, chatId);
      expect(ev.turn.tools).not.toContain(echoName);
      expect(ev.turn.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      expect(ev.turn.withheld).toEqual([{ tool: echoName, reason: "shared_with_group" }]);
      // Riley reaches the chat through the team grant; his turn is decided the same way.
      const rileyEv = await ask(riley, chatId);
      expect(rileyEv.message.author.id).toBe(rileyId);
      expect(rileyEv.turn.withheld).toEqual([{ tool: echoName, reason: "shared_with_group" }]);
      expect(rileyEv.turn.memory).toEqual([]);
    } finally {
      const revoked = await victor.request("DELETE", `/api/v1/ai-chats/${chatId}/grants/${g.id as string}`);
      expect(revoked.status).toBe(204);
    }
  });

  it("a solo chat (owner + persona only) still carries no memory and never offers ocw_memory_save", async () => {
    const created = await ok(createChat(victor, "Just me and the bot"), 201);
    const solo = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    await ok(addAgent(victor, solo, backendId), 201);
    const ev = await ask(victor, solo);
    expect(ev.conversation.kind).toBe("ai_chat");
    expect(ev.turn.memory).toEqual([]);
    expect(ev.turn.tools).not.toContain("ocw_memory_save");
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch", echoName]));
    expect(ev.turn.withheld).toEqual([]);
    // 07.2-11: list/read/propose (decided per call with the chat's readers), never write; no private memory file.
    expect(ev.turn.tools).toEqual(
      expect.arrayContaining(["ocw_memory_list", "ocw_memory_read", "ocw_memory_propose"]),
    );
    expect(ev.turn.tools).not.toContain("ocw_memory_write");
    expect(ev.turn.memoryFiles).toBeUndefined();
    // Even alone with its owner, a persona in an AI chat never reads his private memory (only in a one-person DM).
    const read = await cellCall("POST", "/memory/read", {
      eventId: ev.eventId,
      agentId: backendId,
      scope: "personal",
      path: "MEMORY.md",
    });
    expect(read.body).toEqual({ refused: "audience_too_wide" });
  });

  it("memory reads in an AI chat: every listed participant must read the file; a team grant makes it unbounded", async () => {
    const scopes = (await ok(victor.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
    const orgScope = scopes.find((x) => x.kind === "org")?.id as string;
    const backendScope = scopes.find((x) => x.unitId === backendUnit)?.id as string;
    const make = (scope: string, path: string, content: string) =>
      ok(victor.request("POST", `/api/v1/memory/scopes/${scope}/files`, { path, content }));
    await make(orgScope, "runbook.md", "# Runbook\n");
    await make(backendScope, "oncall.md", "# On call\n");
    const read = (ev: Json, scope: string, path: string) =>
      cellCall("POST", "/memory/read", { eventId: ev.eventId, agentId: backendId, scope, path });

    // Listed: Víctor and Alex. Víctor (admin) reads Backend's file, Alex does not.
    const ev = await ask(victor, chatId);
    expect((await read(ev, orgScope, "runbook.md")).body.file).toMatchObject({ path: "runbook.md" });
    expect((await read(ev, backendScope, "oncall.md")).body).toEqual({ refused: "audience_too_wide" });
    const fromAlex = await ask(alex, chatId);
    expect((await read(fromAlex, backendScope, "oncall.md")).body).toEqual({ refused: "not_found" });

    // A team grant: the readers are no longer a list, so only organization-wide memory nobody is denied.
    const g = await ok(grant(victor, chatId, { kind: "unit", id: backendUnit }), 201);
    try {
      const wide = await ask(victor, chatId);
      expect((await read(wide, orgScope, "runbook.md")).body.file).toMatchObject({ path: "runbook.md" });
      expect((await read(wide, backendScope, "oncall.md")).body).toEqual({ refused: "audience_too_wide" });
    } finally {
      const revoked = await victor.request("DELETE", `/api/v1/ai-chats/${chatId}/grants/${g.id as string}`);
      expect(revoked.status).toBe(204);
    }
  });
});

describe("an agent persona in an AI chat counts as sharing it (D-06, orchestrator decision in 06-12)", () => {
  it("the owner's personal instructions shape a solo chat, and stop the moment a persona joins it", async () => {
    await ok(
      victor.request("PUT", "/api/v1/me/ai-preferences", { instructions: "Always answer in pirate speak." }),
    );
    try {
      stack.fake.reset();
      const created = await ok(createChat(victor, "Plan the schema migration"), 201);
      const chatId = (created.chat as Json).id as string;
      await settled((created.generation as Json).id as string);
      // Solo (Phase 5): the owner's own instructions are used.
      expect(JSON.stringify(withoutTitles(stack.fake.requests("responses")).at(-1)?.body ?? {})).toContain(
        "pirate",
      );
      expect((created.chat as Json).shared).not.toBe(true);

      await ok(addAgent(victor, chatId, backendId), 201);
      // The chat now reads as shared everywhere the platform says so (summary, snapshot).
      const snap = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
      expect((snap.chat as Json).shared).toBe(true);
      const listed = await ok(victor.request("GET", "/api/v1/ai-chats?limit=50"));
      expect((listed.chats as Json[]).find((c) => c.id === chatId)?.shared).toBe(true);

      stack.fake.reset();
      const r = await ok(send(victor, chatId, "What next?", { askAi: true }), 201);
      await settled((r.generation as Json).id as string);
      const body = JSON.stringify(withoutTitles(stack.fake.requests("responses")).at(-1)?.body ?? {});
      expect(body).toContain("<participants>");
      expect(body).not.toContain("pirate");
      expect(body).not.toContain("personal_instructions");
    } finally {
      await ok(victor.request("PUT", "/api/v1/me/ai-preferences", { instructions: "" }));
    }
  });
});

describe("07.15-07 (D-02, D-14): a persona's turn lists the files of the chat's messages it reads", () => {
  it("an earlier message's PNG is listed for @backend with the read tool; the send route still refuses a .zip", async () => {
    const created = await ok(createChat(victor, "Look at this diagram with me"), 201);
    const chat = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#36a" } })
      .png()
      .toBuffer();
    const image = await uploadAttachment(victor, chat, { name: "diagram.png", type: "image/png", bytes });
    const withImage = await ok(send(victor, chat, "what is this?", { attachmentIds: [image] }), 201);
    await settled((withImage.generation as Json).id as string);
    await ok(addAgent(victor, chat, backendId), 201);

    const posted = await send(victor, chat, "@backend what does the diagram show?");
    expect(posted.status).toBe(202);
    const messageId = ((posted.body as Json).userMessage as Json).id as string;
    const [ev] = await deliveriesOf(messageId);
    expect(ev?.conversation).toMatchObject({ id: chat, kind: "ai_chat" });
    expect(ev?.turn.attachments).toEqual([
      {
        id: image,
        messageId: (withImage.userMessage as Json).id as string,
        name: "diagram.png",
        mediaType: "image/png",
        size: bytes.length,
        kind: "image",
        access: "read",
      },
    ]);
    expect(ev?.turn.tools).toContain("ocw_attachment_read");

    // D-14: the chat's model still decides what can be attached; a persona never widens it.
    const archive = await uploadAttachment(victor, chat, {
      name: "src.zip",
      type: "application/zip",
      bytes: new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00]),
    });
    const refused = await send(victor, chat, "unpack it", { attachmentIds: [archive] });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe("attachment_not_supported");
  });

  it("07.15-11 (D-14): a message that only addresses the persona meets the same gate; a readable file still goes", async () => {
    const created = await ok(createChat(victor, "Review the build with me"), 201);
    const chat = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    await ok(addAgent(victor, chat, backendId), 201);

    // The chat model is not asked (202), yet a file it cannot read is refused exactly as when it is: 400, nothing written.
    const archive = await uploadAttachment(victor, chat, {
      name: "build.zip",
      type: "application/zip",
      bytes: new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00]),
    });
    const refused = await send(victor, chat, "@backend unpack it", { attachmentIds: [archive] });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe("attachment_not_supported");
    const { rows: linked } = await su.query("select message_id from app.attachments where id = $1", [
      archive,
    ]);
    expect(linked[0]?.message_id ?? null).toBeNull();

    // A file the chat's model reads still reaches the persona, listed on its turn.
    const notes = await uploadAttachment(victor, chat, {
      name: "notes.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("build 42 failed on step lint\n"),
    });
    const posted = await send(victor, chat, "@backend what failed?", { attachmentIds: [notes] });
    expect(posted.status).toBe(202);
    const messageId = ((posted.body as Json).userMessage as Json).id as string;
    const [ev] = await deliveriesOf(messageId);
    expect(ev?.turn.attachments?.map((a: { id: string }) => a.id)).toContain(notes);
  });

  it("WR-08: a sender's model that cannot be resolved fails closed: only text goes to the persona", async () => {
    const created = await ok(createChat(victor, "Look at the logs with me"), 201);
    const chat = (created.chat as Json).id as string;
    await settled((created.generation as Json).id as string);
    await ok(addAgent(victor, chat, backendId), 201);
    // A model the plan's catalog does not have: the gateway answers ModelUnavailableError, so nothing says what it reads.
    const gone = { model: { ...PLAN_MODEL, modelId: "gpt-not-in-any-catalog" } };

    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#a63" } })
      .png()
      .toBuffer();
    const image = await uploadAttachment(victor, chat, { name: "chart.png", type: "image/png", bytes });
    const archive = await uploadAttachment(victor, chat, {
      name: "logs.zip",
      type: "application/zip",
      bytes: new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00]),
    });
    for (const id of [image, archive]) {
      const refused = await send(victor, chat, "@backend look", { attachmentIds: [id], ...gone });
      expect(refused.status).toBe(400);
      expect(errorCode(refused)).toBe("attachment_not_supported");
      const { rows } = await su.query("select message_id from app.attachments where id = $1", [id]);
      expect(rows[0]?.message_id ?? null).toBeNull();
    }

    // Text is what every model reads: it still goes.
    const notes = await uploadAttachment(victor, chat, {
      name: "log.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("step lint failed\n"),
    });
    const posted = await send(victor, chat, "@backend what failed?", { attachmentIds: [notes], ...gone });
    expect(posted.status).toBe(202);
  });
});
