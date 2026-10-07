import { randomUUID } from "node:crypto";
import {
  EphemeralTypes,
  EventTypes,
  type ServerFrame,
  WS_AUTH_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import {
  type AiStack,
  type ConvSubscription,
  seedPlan,
  startAiStack,
  subscribeConv,
  subscribeTopic,
  withoutTitles,
} from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * API tracer of Phase 6 (06-02, D-01/D-03/D-04/D-06): Víctor shares his AI chat IN PLACE with Alex (a grant on the
 * same conversation, never a copy) → the resolver lets Alex read it and subscribe to `conv:<id>` → Alex writes → the
 * model answers Alex on ALEX's own ChatGPT plan, with a roster, server-generated attributed blocks and a turn context
 * naming Alex → both subscribers see the stream and the final message. Management stays owner-only. Real PostgreSQL +
 * Redis, the in-process fake model; no real provider is ever called.
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let ada: TestClient;
let victorId: string;
let alexId: string;
let samId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

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
const grant = (as: TestClient, chatId: string, subject: Json, level?: "chat" | "view") =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/grants`, { subject, ...(level ? { level } : {}) });

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function running(generationId: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select partial_text from app.ai_generations where id = $1", [generationId]))
      .rows[0];
    if (g && g.partial_text.length > 0) return;
    if (Date.now() > until) throw new Error(`generation ${generationId} never streamed`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The texts of one Responses `input` item (string content or input_text parts). */
function textOf(item: Json): string {
  if (typeof item.content === "string") return item.content;
  return (item.content as Json[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

/** A raw `/ws` socket subscribed to `topic` that can also send client frames (typing). */
async function rawSocket(client: TestClient, topic: string) {
  const token = await client.token();
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: ServerFrame[] = [];
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as ServerFrame));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ op: "sub", topic }));
  const until = Date.now() + 5_000;
  while (!frames.some((f) => (f.op === "subscribed" || f.op === "err") && f.topic === topic)) {
    if (Date.now() > until) throw new Error(`no answer subscribing to ${topic}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return { socket, frames, subscribed: frames.some((f) => f.op === "subscribed" && f.topic === topic) };
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** A member of a brand-new organization B who is its admin (cross-tenant probes). */
async function orgBAdmin(): Promise<TestClient> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const eve = new TestClient(stack.baseUrl);
  const accepted = await ok(
    eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Eve",
      password: "eve-long-password-1",
    }),
  );
  const eveId: string = accepted.user.id;
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  return eve;
}

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  ({ client: ada } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  await seedPlan(victor);
  await seedPlan(alex);
  await seedPlan(sam);
  // Víctor's personal instructions are on: they must never reach a shared chat (D-06).
  await ok(
    victor.request("PUT", "/api/v1/me/ai-preferences", { instructions: "Always answer in pirate speak." }),
  );
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

let chatId: string;
let grantId: string;
let firstUserMessageId: string;
let victorConv: ConvSubscription;
let alexConv: ConvSubscription;

describe("tracer: Víctor shares his AI chat in place with Alex, who reads, subscribes, writes and is answered on his own plan", () => {
  it("Víctor creates a chat and gets an answer; Alex gets 404 everywhere and cannot subscribe", async () => {
    const first = await ok(createChat(victor, "Propose an architecture for the billing service"), 201);
    chatId = first.chat.id;
    firstUserMessageId = first.userMessage.id;
    expect((await settled(first.generation.id)).status).toBe("completed");

    for (const [method, path] of [
      ["GET", `/api/v1/ai-chats/${chatId}`],
      ["GET", `/api/v1/ai-chats/${chatId}/messages`],
      ["GET", `/api/v1/ai-chats/${chatId}/grants`],
    ] as const) {
      const r = await alex.request(method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const ws = await subscribeConv(stack.baseUrl, alex, chatId);
    expect(ws.outcome).toBe("error");
    ws.close();
  });

  it("Víctor grants Alex `chat`: 201 with the label; repeating it is 200 with the same grant; Alex is told on user:<alex>", async () => {
    const alexUser = await subscribeTopic(stack.baseUrl, alex, `user:${alexId}`);
    expect(alexUser.outcome).toBe("subscribed");
    victorConv = await subscribeConv(stack.baseUrl, victor, chatId);
    expect(victorConv.outcome).toBe("subscribed");

    const created = await ok(grant(victor, chatId, { kind: "user", id: alexId }, "chat"), 201);
    expect(created).toMatchObject({
      chatId,
      subject: { kind: "user", id: alexId },
      label: "Alex Kim",
      unitKind: null,
      level: "chat",
      grantedBy: { kind: "user", id: victorId, displayName: "Víctor Ruiz" },
    });
    grantId = created.id;
    const again = await ok(grant(victor, chatId, { kind: "user", id: alexId }));
    expect(again.id).toBe(grantId);
    expect(
      (
        await su.query("select count(*)::int as n from app.ai_chat_grants where conversation_id = $1", [
          chatId,
        ])
      ).rows[0].n,
    ).toBe(1);

    await alexUser.waitFor(() => alexUser.durable(EventTypes.aiChatUpdated).length > 0);
    const updated = alexUser.durable(EventTypes.aiChatUpdated)[0]!.data as Json;
    expect(updated.chat).toMatchObject({ id: chatId, access: "chat", shared: true, owner: { id: victorId } });
    await alexUser.waitFor(() => alexUser.durable(EventTypes.aiChatAccessChanged).length > 0);
    expect(alexUser.durable(EventTypes.aiChatAccessChanged)[0]!.data).toEqual({
      conversationId: chatId,
      access: "chat",
    });
    await victorConv.waitFor(() => victorConv.durable(EventTypes.aiChatAccessChanged).length > 0);
    alexUser.close();

    // The grant is one row, Alex's participation one member row; nothing was copied.
    const members = (
      await su.query(
        "select member_id, role from app.conversation_members where conversation_id = $1 order by role",
        [chatId],
      )
    ).rows;
    expect(members).toEqual([
      { member_id: alexId, role: "member" },
      { member_id: victorId, role: "owner" },
    ]);
    expect((await su.query("select count(*)::int as n from app.ai_chats", [])).rows[0].n).toBe(1);
    const audits = (
      await su.query(
        "select metadata from app.audit_events where action = 'ai_chat.grant_created' and resource_id = $1",
        [chatId],
      )
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toEqual({
      conversationId: chatId,
      grantId,
      subjectKind: "user",
      subjectId: alexId,
      level: "chat",
    });
  });

  it("Alex reads the snapshot as a chat grantee and Víctor's grant list shows him", async () => {
    const snap = await ok(alex.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat).toMatchObject({
      access: "chat",
      owner: { id: victorId, displayName: "Víctor Ruiz" },
      shared: true,
    });
    expect(snap.chat.viewerCan).toContain("ai_chat.use");
    expect(snap.chat.viewerCan).not.toContain("ai_chat.manage");
    expect(snap.chat.viewerCan).not.toContain("ai_chat.share");
    expect(snap.messages[0].author).toMatchObject({ kind: "user", id: victorId, displayName: "Víctor Ruiz" });

    const mine = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(mine.chat).toMatchObject({ access: "owner", shared: true });
    expect(mine.chat.viewerCan).toEqual(
      expect.arrayContaining(["ai_chat.use", "ai_chat.manage", "ai_chat.share"]),
    );

    const list = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}/grants`));
    expect(list.grants).toEqual([
      expect.objectContaining({
        id: grantId,
        label: "Alex Kim",
        level: "chat",
        grantedBy: expect.objectContaining({ id: victorId }),
      }),
    ]);
  });

  it("Alex subscribes to conv:<id>; his typing reaches Víctor", async () => {
    alexConv = await subscribeConv(stack.baseUrl, alex, chatId);
    expect(alexConv.outcome).toBe("subscribed");
    const typing = await rawSocket(alex, `conv:${chatId}`);
    expect(typing.subscribed).toBe(true);
    typing.socket.send(
      JSON.stringify({ op: "eph", topic: `conv:${chatId}`, type: EphemeralTypes.userTyping, data: {} }),
    );
    await victorConv.waitFor(() =>
      victorConv.frames.some(
        (f) => f.op === "eph" && f.type === EphemeralTypes.userTyping && (f.data as Json).userId === alexId,
      ),
    );
    typing.socket.close();
  });

  it("Alex writes; the model answers Alex on Alex's plan with roster, attributed blocks and turn context; both see the stream", async () => {
    stack.fake.reset();
    const res = await ok(send(alex, chatId, "But we need multi-tenancy"), 201);
    expect(res.userMessage.author).toMatchObject({ id: alexId, displayName: "Alex Kim" });
    expect(res.generation.requesterUserId).toBe(alexId);
    const assistantId = res.assistantMessage.id;
    for (const ws of [victorConv, alexConv]) {
      await ws.waitFor(
        () => ws.durable(EventTypes.messageUpdated).some((f) => (f.data as Json).message.id === assistantId),
        20_000,
      );
      expect(ws.deltas().some((d) => d.messageId === assistantId)).toBe(true);
    }
    expect((await settled(res.generation.id)).status).toBe("completed");

    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${alexId}-`));
    const input = call.body?.input as Json[];
    expect(input.some((i) => i.role === "system")).toBe(false);
    const developer = textOf(input[0]!);
    expect(input[0]).toMatchObject({ role: "developer" });
    expect(developer).toContain("<participants>");
    expect(developer).toContain(`name="Víctor Ruiz" user_id="${victorId}" role="admin" access="owner"`);
    expect(developer).toContain(`name="Alex Kim" user_id="${alexId}" role="developer" access="chat"`);
    expect(developer).not.toContain("You are chatting with");
    expect(developer).not.toContain("personal_instructions");
    expect(developer).not.toContain("pirate");
    const users = input.filter((i) => i.role === "user");
    expect(textOf(users[0]!)).toContain(`<message from="Víctor Ruiz" user_id="${victorId}"`);
    const last = textOf(users.at(-1)!);
    expect(last).toContain(`<message from="Alex Kim" user_id="${alexId}"`);
    expect(last).toContain("But we need multi-tenancy");
    expect(last).toContain(`<responding_to name="Alex Kim" user_id="${alexId}"/>`);
    expect(last).not.toMatch(/Alex Kim:/u);

    const usage = (
      await su.query("select requester_user_id from app.ai_usage_records where generation_id = $1", [
        res.generation.id,
      ])
    ).rows;
    expect(usage).toEqual([{ requester_user_id: alexId }]);
  });

  it("every human message has its context row: who, through which access, which model, answered by which generation", async () => {
    const rows = (
      await su.query(
        `select c.*, m.author_id, m.client_kind, m.session_id, g.id as gen_id
           from app.ai_message_context c
           join app.messages m on m.id = c.message_id
           left join app.ai_generations g on g.id = c.answered_by_generation_id
          where c.conversation_id = $1 order by m.seq`,
        [chatId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      message_id: firstUserMessageId,
      author_kind: "user",
      author_id: victorId,
      access: "owner",
      grant_id: null,
      level: "owner",
      addressed: true,
      model: PLAN_MODEL,
      tools: { web: false },
    });
    expect(rows[1]).toMatchObject({
      author_kind: "user",
      author_id: alexId,
      access: "grant",
      grant_id: grantId,
      level: "chat",
      addressed: true,
      shared: true,
      model: PLAN_MODEL,
    });
    for (const r of rows) {
      expect(r.answered_by_generation_id).not.toBeNull();
      expect(r.gen_id).toBe(r.answered_by_generation_id);
      expect(r.client_kind).not.toBeNull();
      expect(r.session_id).not.toBeNull();
    }
  });

  it("Víctor's next turn in the shared chat has no personal instructions either, and answers Víctor", async () => {
    const before = (await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.settings;
    expect(before.usePersonalInstructions).toBe(true);
    stack.fake.reset();
    const res = await ok(send(victor, chatId, "Fine, add tenant isolation"), 201);
    await settled(res.generation.id);
    const [call] = withoutTitles(stack.fake.requests("responses"));
    expect(call!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${victorId}-`));
    const input = call!.body?.input as Json[];
    expect(textOf(input[0]!)).not.toContain("pirate");
    expect(JSON.stringify(input)).not.toContain("personal_instructions");
    const last = textOf(input.filter((i) => i.role === "user").at(-1)!);
    expect(last).toContain(`<responding_to name="Víctor Ruiz" user_id="${victorId}"/>`);
  });

  it("lists: Víctor's default list is unchanged; Alex's `shared` scope has the chat with access chat", async () => {
    const mine = await ok(victor.request("GET", "/api/v1/ai-chats"));
    expect(mine.chats.map((c: Json) => c.id)).toEqual([chatId]);
    expect(mine.chats[0]).toMatchObject({ access: "owner" });
    expect((await ok(alex.request("GET", "/api/v1/ai-chats"))).chats).toEqual([]);
    const shared = await ok(alex.request("GET", "/api/v1/ai-chats?scope=shared"));
    expect(shared.chats).toEqual([
      expect.objectContaining({
        id: chatId,
        access: "chat",
        shared: true,
        owner: expect.objectContaining({ id: victorId }),
      }),
    ]);
    const all = await ok(alex.request("GET", "/api/v1/ai-chats?scope=all"));
    expect(all.chats.map((c: Json) => c.id)).toEqual([chatId]);
    expect((await ok(victor.request("GET", "/api/v1/ai-chats?scope=shared"))).chats).toEqual([]);
  });

  it("the snapshot's message authors carry each human's display name", async () => {
    const snap = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    const humans = snap.messages.filter((m: Json) => m.authorKind === "user");
    expect(humans.map((m: Json) => m.author.displayName)).toEqual(["Víctor Ruiz", "Alex Kim", "Víctor Ruiz"]);
    const answers = snap.messages.filter((m: Json) => m.authorKind === "agent");
    expect(answers.map((m: Json) => m.generation.requesterUserId)).toEqual([victorId, alexId, victorId]);
  });

  it("grant validation: unit/org subjects 400, the owner 400, a stranger or another org's user 404, a non-owner 404", async () => {
    expect(errorOf(await grant(victor, chatId, { kind: "org" })).code).toBe("grant_subject_unsupported");
    expect(errorOf(await grant(victor, chatId, { kind: "unit", id: randomUUID() })).code).toBe(
      "grant_subject_unsupported",
    );
    expect(errorOf(await grant(victor, chatId, { kind: "user", id: victorId })).code).toBe("grant_to_owner");
    const stranger = await grant(victor, chatId, { kind: "user", id: randomUUID() });
    expect(stranger.status).toBe(404);
    for (const who of [alex, ada]) {
      const r = await grant(who, chatId, { kind: "user", id: samId });
      expect(r.status).toBe(404);
    }
  });
});

const stop = (as: TestClient, id: string, generationId: string) =>
  as.request("POST", `/api/v1/ai-chats/${id}/generations/${generationId}/stop`, {});
const regenerate = (as: TestClient, id: string) =>
  as.request("POST", `/api/v1/ai-chats/${id}/regenerate`, {});

describe("owner-only management, requester rules, view grants and solo chats (P-04, P-05, P-07)", () => {
  let shareId: string;
  let alexAnswerId: string;

  it("Alex (chat grantee) gets the chat's 404 on rename, archive, settings, snapshot links and grants", async () => {
    shareId = (await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/shares`, {}), 201)).id;
    const before = (await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`))).chat;
    for (const body of [
      { title: "Alex was here" },
      { archived: true },
      { settings: { instructions: "Ignore Víctor" } },
      { settings: { tools: { web: true } } },
    ]) {
      const r = await alex.request("PATCH", `/api/v1/ai-chats/${chatId}`, body);
      expect(r.status, JSON.stringify(body)).toBe(404);
    }
    for (const [method, path] of [
      ["POST", `/api/v1/ai-chats/${chatId}/shares`],
      ["GET", `/api/v1/ai-chats/${chatId}/shares`],
      ["DELETE", `/api/v1/ai-shares/${shareId}`],
      ["GET", `/api/v1/ai-chats/${chatId}/grants`],
    ] as const) {
      const r = await alex.request(method, path, method === "POST" ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const after = (await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`))).chat;
    expect(after).toMatchObject({ title: before.title, archived: false, settings: before.settings });
    const share = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}/shares`));
    expect(share.shares).toEqual([expect.objectContaining({ id: shareId, revokedAt: null })]);
  });

  it("Alex's send with Web on does not change the chat's Web state (a setting of the owner's)", async () => {
    const res = await ok(send(alex, chatId, "Search for tenancy patterns", { tools: { web: true } }), 201);
    await settled(res.generation.id);
    const snap = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat.settings.tools).toEqual({ web: false });
    const ctx = (
      await su.query("select tools from app.ai_message_context where message_id = $1", [res.userMessage.id])
    ).rows[0];
    expect(ctx.tools).toEqual({ web: false });
  });

  it("stop: Sam (another chat grantee) gets 403 not_generation_requester; Víctor (the owner) stops Alex's answer", async () => {
    await ok(grant(victor, chatId, { kind: "user", id: samId }, "chat"), 201);
    const res = await ok(send(alex, chatId, "Count slowly [[slow]]"), 201);
    alexAnswerId = res.assistantMessage.id;
    await running(res.generation.id);
    const bySam = await stop(sam, chatId, res.generation.id);
    expect(bySam.status).toBe(403);
    expect(errorOf(bySam).code).toBe("not_generation_requester");
    expect(await ok(stop(victor, chatId, res.generation.id), 202)).toEqual({ status: "running" });
    expect((await settled(res.generation.id)).status).toBe("stopped");
  });

  it("regenerate: Alex regenerates his own answer on his plan; Sam gets 403 not_answer_requester; Víctor regenerates on his own plan", async () => {
    stack.fake.reset();
    const byAlex = await ok(regenerate(alex, chatId), 201);
    expect(byAlex.assistantMessage.id).toBe(alexAnswerId);
    expect(byAlex.generation.requesterUserId).toBe(alexId);
    await settled(byAlex.generation.id);
    const [alexCall] = withoutTitles(stack.fake.requests("responses"));
    expect(alexCall!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${alexId}-`));
    expect(
      (
        await su.query("select requester_user_id from app.ai_usage_records where generation_id = $1", [
          byAlex.generation.id,
        ])
      ).rows,
    ).toEqual([{ requester_user_id: alexId }]);

    const bySam = await regenerate(sam, chatId);
    expect(bySam.status).toBe(403);
    expect(errorOf(bySam).code).toBe("not_answer_requester");

    stack.fake.reset();
    const byVictor = await ok(regenerate(victor, chatId), 201);
    expect(byVictor.generation.requesterUserId).toBe(victorId);
    await settled(byVictor.generation.id);
    const [victorCall] = withoutTitles(stack.fake.requests("responses"));
    expect(victorCall!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${victorId}-`));
    // The answer still answers Alex's question: the turn context names Alex, whoever pays for the new attempt.
    const input = victorCall!.body?.input as Json[];
    expect(textOf(input.filter((i) => i.role === "user").at(-1)!)).toContain(
      `<responding_to name="Alex Kim" user_id="${alexId}"/>`,
    );
    expect(
      (
        await su.query("select requester_user_id from app.ai_usage_records where generation_id = $1", [
          byVictor.generation.id,
        ])
      ).rows,
    ).toEqual([{ requester_user_id: victorId }]);
  });

  it("a view grant: Sam reads and subscribes, but sending is 403 ai_chat_view_only; his shared list says view", async () => {
    const downgraded = await ok(grant(victor, chatId, { kind: "user", id: samId }, "view"));
    expect(downgraded.level).toBe("view");
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat.access).toBe("view");
    expect(snap.chat.viewerCan).not.toContain("ai_chat.use");
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    expect(ws.outcome).toBe("subscribed");
    ws.close();
    const refused = await send(sam, chatId, "Let me in");
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("ai_chat_view_only");
    expect((await regenerate(sam, chatId)).status).toBe(403);
    const shared = await ok(sam.request("GET", "/api/v1/ai-chats?scope=shared"));
    expect(shared.chats).toEqual([expect.objectContaining({ id: chatId, access: "view" })]);
  });

  it("the admin without a grant and another organization's admin get 404 on every route and cannot subscribe", async () => {
    const eve = await orgBAdmin();
    const [gen] = (
      await su.query("select id from app.ai_generations where conversation_id = $1 limit 1", [chatId])
    ).rows;
    for (const who of [ada, eve]) {
      for (const [method, path, body] of [
        ["GET", `/api/v1/ai-chats/${chatId}`, undefined],
        ["GET", `/api/v1/ai-chats/${chatId}/messages`, undefined],
        ["PATCH", `/api/v1/ai-chats/${chatId}`, { title: "Mine now" }],
        [
          "POST",
          `/api/v1/ai-chats/${chatId}/messages`,
          { clientMessageId: cid(), body: "hi", model: PLAN_MODEL },
        ],
        ["POST", `/api/v1/ai-chats/${chatId}/generations/${gen.id}/stop`, {}],
        ["POST", `/api/v1/ai-chats/${chatId}/regenerate`, {}],
        ["POST", `/api/v1/ai-chats/${chatId}/shares`, {}],
        ["GET", `/api/v1/ai-chats/${chatId}/shares`, undefined],
        ["DELETE", `/api/v1/ai-shares/${shareId}`, undefined],
        ["POST", `/api/v1/ai-chats/${chatId}/grants`, { subject: { kind: "user", id: samId } }],
        ["GET", `/api/v1/ai-chats/${chatId}/grants`, undefined],
      ] as const) {
        const r = await who.request(method, path, body);
        expect(r.status, `${method} ${path}`).toBe(404);
      }
      const ws = await subscribeConv(stack.baseUrl, who, chatId);
      expect(ws.outcome).toBe("error");
      ws.close();
      expect((await ok(who.request("GET", "/api/v1/ai-chats?scope=all"))).chats).toEqual([]);
    }
  });

  it("a solo chat behaves as in Phase 5: a second send while generating is 409 and the prompt has no roster", async () => {
    stack.fake.reset();
    const first = await ok(createChat(sam, "Count for me [[slow]]"), 201);
    await running(first.generation.id);
    const busy = await send(sam, first.chat.id, "Another one");
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("generation_in_progress");
    await ok(stop(sam, first.chat.id, first.generation.id), 202);
    await settled(first.generation.id);
    const [call] = withoutTitles(stack.fake.requests("responses"));
    const input = call!.body?.input as Json[];
    expect(textOf(input[0]!)).toContain("You are chatting with Sam Rivera in Autofy Labs");
    expect(JSON.stringify(input)).not.toContain("<participants>");
    expect(JSON.stringify(input)).not.toContain("<message from=");
    const ctx = (
      await su.query("select access, level, shared from app.ai_message_context where message_id = $1", [
        first.userMessage.id,
      ])
    ).rows[0];
    expect(ctx).toEqual({ access: "owner", level: "owner", shared: false });
  });
});
