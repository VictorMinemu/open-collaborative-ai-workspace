import { randomUUID } from "node:crypto";
import { EventTypes, type ServerFrame } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
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
 * 06-04 (D-03, P-03, P-09, MULTI-01): the owner shares the SAME AI chat with a team, a department (and so its
 * subtree) or the whole organization, at Can chat or Can view; changes the level; revokes. Access comes from one
 * `aiAccessSql` over unit membership paths; a revoke re-decides participation rows and every live `conv:` subscriber
 * (the `ai_chat.access_changed` invalidator) within the ADR-0009 bound used by `realtime-reauth.int` (1 s). Every
 * change is a server-written notice line in the chat, audited with ids only. Real PostgreSQL + Redis, the in-process
 * fake model; no real provider is ever called.
 *
 * Units: Engineering (department) → Backend (team) → Payments (project). Riley ∈ Backend, Robin ∈ Payments,
 * Jo ∈ Engineering only, Sam ∈ none.
 */

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let riley: TestClient;
let robin: TestClient;
let jo: TestClient;
let sam: TestClient;
let ada: TestClient;
let orgId: string;
let victorId: string;
let rileyId: string;
let robinId: string;
let samId: string;
const unit = {} as Record<"engineering" | "backend" | "payments", string>;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
/** ADR-0009 / realtime-reauth.int: a revoked subscription is dropped within a second. */
const REVOKE_BOUND_MS = 1000;
const cid = () => `cm-${randomUUID()}`;
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL });
const send = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
  });
const grant = (as: TestClient, chatId: string, subject: Json, level?: "chat" | "view") =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/grants`, { subject, ...(level ? { level } : {}) });
const patchGrant = (as: TestClient, chatId: string, grantId: string, level: "chat" | "view") =>
  as.request("PATCH", `/api/v1/ai-chats/${chatId}/grants/${grantId}`, { level });
const revoke = (as: TestClient, chatId: string, grantId: string) =>
  as.request("DELETE", `/api/v1/ai-chats/${chatId}/grants/${grantId}`);

async function settled(generationId: string, timeoutMs = 20_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await sleep(50);
  }
}

async function running(generationId: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select partial_text from app.ai_generations where id = $1", [generationId]))
      .rows[0];
    if (g && g.partial_text.length > 0) return;
    if (Date.now() > until) throw new Error(`generation ${generationId} never streamed`);
    await sleep(50);
  }
}

function textOf(item: Json): string {
  if (typeof item.content === "string") return item.content;
  return (item.content as Json[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
}

const revokedOn = (s: ConvSubscription, topic: string) =>
  s.frames.find((f: ServerFrame) => f.op === "revoked" && f.topic === topic);

const memberIds = async (chatId: string) =>
  (
    await su.query(
      "select member_id from app.conversation_members where conversation_id = $1 and member_kind = 'user' order by member_id",
      [chatId],
    )
  ).rows.map((r) => r.member_id as string);

const audits = async (action: string, chatId: string) =>
  (
    await su.query(
      "select metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
      [action, chatId],
    )
  ).rows.map((r) => r.metadata as Json);

/** The bodies of the chat's system notice rows, in order. */
const notices = async (chatId: string) =>
  (
    await su.query(
      "select body, author_id, mentions from app.messages where conversation_id = $1 and author_kind = 'system' order by seq",
      [chatId],
    )
  ).rows as Array<{ body: string; author_id: string | null; mentions: Json[] }>;

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

async function newUnit(kind: "department" | "team" | "project", name: string, parentId: string | null) {
  return (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
}
const addToUnit = (unitId: string, userId: string) =>
  ok(victor.request("POST", `/api/v1/units/${unitId}/members`, { userId }));

/** A brand-new organization B with its own admin (Eve) and one unit: cross-tenant probes. */
async function orgB(): Promise<{ eve: TestClient; unitId: string }> {
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
  const b = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [b, `evil-${b}`]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    b,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [b, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [b, eveId]);
  const unitId = randomUUID();
  await su.query(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'department', 'Evil Eng', array[$1::uuid])",
    [unitId, b],
  );
  return { eve, unitId };
}

beforeAll(async () => {
  stack = await startAiStack();
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
  orgId = setup.organization.id;
  victorId = await meId(victor);
  ({ client: riley, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  ));
  ({ client: robin, userId: robinId } = await invite(
    stack,
    victor,
    "robin@example.test",
    "Robin Lee",
    "standard",
  ));
  let joId: string;
  ({ client: jo, userId: joId } = await invite(stack, victor, "jo@example.test", "Jo Marsh", "standard"));
  ({ client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Rivera",
    "standard",
  ));
  ({ client: ada } = await invite(stack, victor, "ada@example.test", "Ada Admin", "admin"));
  await seedPlan(victor);
  await seedPlan(riley);
  await seedPlan(jo);
  unit.engineering = await newUnit("department", "Engineering", null);
  unit.backend = await newUnit("team", "Backend", unit.engineering);
  unit.payments = await newUnit("project", "Payments", unit.backend);
  await addToUnit(unit.backend, rileyId);
  await addToUnit(unit.payments, robinId);
  await addToUnit(unit.engineering, joId);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

let chatId: string;
let backendGrant: string;
let victorConv: ConvSubscription;
let victorOrg: ConvSubscription;

const readStatus = async (as: TestClient) => (await as.request("GET", `/api/v1/ai-chats/${chatId}`)).status;

describe("tracer: Víctor shares the chat with the Backend team; Riley reads and writes; a revoke closes his stream", () => {
  it("Víctor's chat is private: Riley, Robin, Jo and Sam get 404", async () => {
    const first = await ok(createChat(victor, "Design the payments ledger"), 201);
    chatId = first.chat.id;
    expect((await settled(first.generation.id)).status).toBe("completed");
    for (const who of [riley, robin, jo, sam]) expect(await readStatus(who)).toBe(404);
    victorConv = await subscribeConv(stack.baseUrl, victor, chatId);
    expect(victorConv.outcome).toBe("subscribed");
    victorOrg = await subscribeTopic(stack.baseUrl, victor, `org:${orgId}`);
    expect(victorOrg.outcome).toBe("subscribed");
  });

  it("a Backend grant (Can chat): 201 with the unit label and kind; repeating it returns the same grant", async () => {
    const rileyUser = await subscribeTopic(stack.baseUrl, riley, `user:${rileyId}`);
    const created = await ok(grant(victor, chatId, { kind: "unit", id: unit.backend }, "chat"), 201);
    expect(created).toMatchObject({
      chatId,
      subject: { kind: "unit", id: unit.backend },
      label: "Backend",
      unitKind: "team",
      level: "chat",
      grantedBy: { kind: "user", id: victorId, displayName: "Víctor Ruiz" },
    });
    backendGrant = created.id;
    expect((await ok(grant(victor, chatId, { kind: "unit", id: unit.backend }, "chat"))).id).toBe(
      backendGrant,
    );
    expect(
      (
        await su.query("select count(*)::int as n from app.ai_chat_grants where conversation_id = $1", [
          chatId,
        ])
      ).rows[0].n,
    ).toBe(1);

    // The org topic hears it (ids only); nobody is told individually and nobody gets a participation row (P-09).
    await victorOrg.waitFor(() => victorOrg.durable(EventTypes.aiChatAccessChanged).length > 0);
    expect(victorOrg.durable(EventTypes.aiChatAccessChanged)[0]!.data).toEqual({
      conversationId: chatId,
      access: null,
    });
    await sleep(300);
    expect(rileyUser.durable(EventTypes.aiChatAccessChanged)).toEqual([]);
    expect(rileyUser.durable(EventTypes.aiChatUpdated)).toEqual([]);
    rileyUser.close();
    expect(await memberIds(chatId)).toEqual([victorId]);
    expect(
      (
        await su.query("select count(*)::int as n from app.notifications where conversation_id = $1", [
          chatId,
        ])
      ).rows[0].n,
    ).toBe(0);

    // The notice line: written by the server, streamed as message.created.
    const lines = await notices(chatId);
    expect(lines).toEqual([
      { body: "Víctor Ruiz shared this chat with Backend · Can chat", author_id: null, mentions: [] },
    ]);
    await victorConv.waitFor(() =>
      victorConv
        .durable(EventTypes.messageCreated)
        .some(
          (f) => (f.data as Json).message.body === "Víctor Ruiz shared this chat with Backend · Can chat",
        ),
    );
    const streamed = victorConv
      .durable(EventTypes.messageCreated)
      .find((f) => (f.data as Json).message.authorKind === "system")!.data as Json;
    expect(streamed.message.author).toEqual({
      kind: "system",
      id: null,
      displayName: "System",
      avatarUrl: null,
    });
    expect(await audits("ai_chat.grant_created", chatId)).toEqual([
      {
        conversationId: chatId,
        grantId: backendGrant,
        subjectKind: "unit",
        subjectId: unit.backend,
        level: "chat",
      },
    ]);
  });

  it("Riley (Backend) and Robin (Payments, under Backend) read; Jo (Engineering only) and Sam get 404", async () => {
    const snap = await ok(riley.request("GET", `/api/v1/ai-chats/${chatId}`));
    expect(snap.chat).toMatchObject({ access: "chat", shared: true, owner: { id: victorId } });
    expect(snap.messages.some((m: Json) => m.authorKind === "system")).toBe(true);
    expect((await ok(robin.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("chat");
    expect(await readStatus(jo)).toBe(404);
    expect(await readStatus(sam)).toBe(404);
    const shared = await ok(riley.request("GET", "/api/v1/ai-chats?scope=shared"));
    expect(shared.chats.map((c: Json) => c.id)).toEqual([chatId]);
  });

  it("Riley subscribes and writes; the model answers on Riley's own plan; his context row names the unit grant", async () => {
    const ws = await subscribeConv(stack.baseUrl, riley, chatId);
    expect(ws.outcome).toBe("subscribed");
    stack.fake.reset();
    const res = await ok(send(riley, chatId, "Use double-entry bookkeeping"), 201);
    expect(res.generation.requesterUserId).toBe(rileyId);
    await ws.waitFor(() =>
      ws.durable(EventTypes.messageCreated).some((f) => (f.data as Json).message.id === res.userMessage.id),
    );
    expect((await settled(res.generation.id)).status).toBe("completed");
    const [call] = withoutTitles(stack.fake.requests("responses"));
    expect(call!.headers.authorization).toMatch(new RegExp(`^Bearer fake-plan-${rileyId}-`));
    const ctx = (
      await su.query("select access, grant_id, level from app.ai_message_context where message_id = $1", [
        res.userMessage.id,
      ])
    ).rows[0];
    expect(ctx).toEqual({ access: "grant", grant_id: backendGrant, level: "chat" });
    // Writing makes Riley a participant (P-09); the row never decides his access.
    expect(await memberIds(chatId)).toEqual([victorId, rileyId].sort());
    ws.close();
  });

  it("a department grant (Engineering, Can view) covers Jo, Riley and Robin; the best level wins; Jo cannot write", async () => {
    const dept = await ok(grant(victor, chatId, { kind: "unit", id: unit.engineering }, "view"), 201);
    expect(dept).toMatchObject({ label: "Engineering", unitKind: "department", level: "view" });
    expect((await ok(jo.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("view");
    expect((await ok(riley.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("chat");
    expect((await ok(robin.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("chat");
    expect(await readStatus(sam)).toBe(404);
    const refused = await send(jo, chatId, "Can I?");
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("ai_chat_view_only");

    expect((await revoke(victor, chatId, dept.id)).status).toBe(204);
    expect(await readStatus(jo)).toBe(404);
    expect(await readStatus(riley)).toBe(200);
    // Revoked or unknown: 404.
    expect((await revoke(victor, chatId, dept.id)).status).toBe(404);
    expect((await revoke(victor, chatId, randomUUID())).status).toBe(404);
    expect((await patchGrant(victor, chatId, dept.id, "chat")).status).toBe(404);
  });

  it("a unit of another organization or an unknown unit → 404 and no row", async () => {
    const { unitId } = await orgB();
    for (const id of [unitId, randomUUID()]) {
      const r = await grant(victor, chatId, { kind: "unit", id }, "chat");
      expect(r.status).toBe(404);
    }
    const subjects = (
      await su.query("select subject_id from app.ai_chat_grants where conversation_id = $1", [chatId])
    ).rows.map((r) => r.subject_id);
    expect(subjects).not.toContain(unitId);
  });

  it("PATCH Backend to Can view: Riley still reads but his send is 403 ai_chat_view_only; audited from → to", async () => {
    const updated = await ok(patchGrant(victor, chatId, backendGrant, "view"));
    expect(updated).toMatchObject({ id: backendGrant, level: "view", label: "Backend" });
    // Same level again: unchanged, no second audit or notice.
    await ok(patchGrant(victor, chatId, backendGrant, "view"));
    expect((await ok(riley.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("view");
    const refused = await send(riley, chatId, "One more idea");
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("ai_chat_view_only");
    expect(await audits("ai_chat.grant_updated", chatId)).toEqual([
      {
        conversationId: chatId,
        grantId: backendGrant,
        subjectKind: "unit",
        subjectId: unit.backend,
        from: "chat",
        to: "view",
      },
    ]);
    expect((await notices(chatId)).map((n) => n.body)).toContain("Víctor Ruiz changed Backend to Can view");
  });

  it("DELETE the Backend grant: Riley's open stream is revoked within the bound, every route is 404, his row is gone", async () => {
    const ws = await subscribeConv(stack.baseUrl, riley, chatId);
    expect(ws.outcome).toBe("subscribed");
    const t0 = Date.now();
    expect((await revoke(victor, chatId, backendGrant)).status).toBe(204);
    await ws.waitFor(() => revokedOn(ws, `conv:${chatId}`) !== undefined, REVOKE_BOUND_MS);
    console.info(`ai chat grant revoke latency (ms): ${Date.now() - t0}`);
    expect(revokedOn(ws, `conv:${chatId}`)).toMatchObject({ reason: "forbidden" });

    // Nothing more reaches him: Víctor's next message is streamed to Víctor only.
    const from = ws.frames.length;
    const next = await ok(send(victor, chatId, "Noted, thanks Riley"), 201);
    await victorConv.waitFor(() =>
      victorConv
        .durable(EventTypes.messageCreated)
        .some((f) => (f.data as Json).message.id === next.userMessage.id),
    );
    await settled(next.generation.id);
    await sleep(200);
    expect(ws.frames.slice(from).filter((f) => f.op === "ev" || f.op === "eph")).toEqual([]);
    ws.close();

    for (const [method, path, body] of [
      ["GET", `/api/v1/ai-chats/${chatId}`, undefined],
      ["GET", `/api/v1/ai-chats/${chatId}/messages`, undefined],
      [
        "POST",
        `/api/v1/ai-chats/${chatId}/messages`,
        { clientMessageId: cid(), body: "hi", model: PLAN_MODEL },
      ],
      ["GET", `/api/v1/ai-chats/${chatId}/grants`, undefined],
    ] as const) {
      expect((await riley.request(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    const again = await subscribeConv(stack.baseUrl, riley, chatId);
    expect(again.outcome).toBe("error");
    again.close();
    expect(await memberIds(chatId)).toEqual([victorId]);
    expect(await readStatus(robin)).toBe(404);

    const row = (
      await su.query("select revoked_at, revoked_by from app.ai_chat_grants where id = $1", [backendGrant])
    ).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(victorId);
    const revokedAudits = await audits("ai_chat.grant_revoked", chatId);
    expect(revokedAudits.at(-1)).toEqual({
      conversationId: chatId,
      grantId: backendGrant,
      subjectKind: "unit",
      subjectId: unit.backend,
      level: "view",
    });
    expect((await notices(chatId)).map((n) => n.body)).toContain("Víctor Ruiz removed access for Backend");
    // conv:<id> and org:<id> heard the change (ids only on the org topic).
    await victorOrg.waitFor(
      () => victorOrg.durable(EventTypes.aiChatAccessChanged).length >= 5, // backend, dept ×2, patch, revoke
    );
    for (const f of victorOrg.durable(EventTypes.aiChatAccessChanged)) {
      expect(f.data).toEqual({ conversationId: chatId, access: null });
    }
  });
});

describe("organization grants, overlapping grants and unit membership changes", () => {
  let orgGrant: string;

  it("an organization grant (Can view) lets Sam read; label 'Everyone at Autofy Labs'", async () => {
    const g = await ok(grant(victor, chatId, { kind: "org" }, "view"), 201);
    expect(g).toMatchObject({
      subject: { kind: "org" },
      label: "Everyone at Autofy Labs",
      unitKind: null,
      level: "view",
    });
    orgGrant = g.id;
    expect((await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("view");
    expect((await ok(riley.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("view");
    expect((await ok(grant(victor, chatId, { kind: "org" }, "view"))).id).toBe(orgGrant);
    expect((await notices(chatId)).map((n) => n.body)).toContain(
      "Víctor Ruiz shared this chat with Everyone at Autofy Labs · Can view",
    );
  });

  it("Riley stays when another active grant (org) still covers him: no revoke, row kept", async () => {
    backendGrant = (await ok(grant(victor, chatId, { kind: "unit", id: unit.backend }, "chat"), 201)).id;
    const res = await ok(send(riley, chatId, "Back with chat access"), 201);
    await settled(res.generation.id);
    const ws = await subscribeConv(stack.baseUrl, riley, chatId);
    expect(ws.outcome).toBe("subscribed");
    expect((await revoke(victor, chatId, backendGrant)).status).toBe(204);
    await sleep(REVOKE_BOUND_MS);
    expect(revokedOn(ws, `conv:${chatId}`)).toBeUndefined();
    expect(await memberIds(chatId)).toEqual([victorId, rileyId].sort());
    expect((await ok(riley.request("GET", `/api/v1/ai-chats/${chatId}`))).chat.access).toBe("view");
    ws.close();
  });

  it("revoking the org grant removes Riley and Sam: 404, rows gone", async () => {
    const ws = await subscribeConv(stack.baseUrl, sam, chatId);
    expect(ws.outcome).toBe("subscribed");
    expect((await revoke(victor, chatId, orgGrant)).status).toBe(204);
    await ws.waitFor(() => revokedOn(ws, `conv:${chatId}`) !== undefined, REVOKE_BOUND_MS);
    ws.close();
    for (const who of [riley, sam]) expect(await readStatus(who)).toBe(404);
    expect(await memberIds(chatId)).toEqual([victorId]);
  });

  it("removing Riley from Backend (units API) closes his stream; his snapshot is 404", async () => {
    backendGrant = (await ok(grant(victor, chatId, { kind: "unit", id: unit.backend }, "chat"), 201)).id;
    const ws = await subscribeConv(stack.baseUrl, riley, chatId);
    expect(ws.outcome).toBe("subscribed");
    await ok(victor.request("DELETE", `/api/v1/units/${unit.backend}/members/${rileyId}`));
    await ws.waitFor(() => revokedOn(ws, `conv:${chatId}`) !== undefined, REVOKE_BOUND_MS);
    ws.close();
    expect(await readStatus(riley)).toBe(404);
    expect(await readStatus(robin)).toBe(200);
    await addToUnit(unit.backend, rileyId);
    expect(await readStatus(riley)).toBe(200);
  });
});

describe("person grants, management is owner-only, cross-tenant 404", () => {
  let samGrant: string;

  it("a person grant notifies user:<subject> with the new access, and with null after its revoke", async () => {
    const samUser = await subscribeTopic(stack.baseUrl, sam, `user:${samId}`);
    const created = await ok(grant(victor, chatId, { kind: "user", id: samId }, "chat"), 201);
    samGrant = created.id;
    await samUser.waitFor(() => samUser.durable(EventTypes.aiChatAccessChanged).length > 0);
    expect(samUser.durable(EventTypes.aiChatAccessChanged)[0]!.data).toEqual({
      conversationId: chatId,
      access: "chat",
    });
    const line = (await notices(chatId)).at(-1)!;
    expect(line.body).toBe("Víctor Ruiz shared this chat with Sam Rivera · Can chat");
    expect(line.mentions).toEqual([{ kind: "user", id: samId }]);

    // A chat grantee who is not the owner cannot manage grants: 404.
    expect((await patchGrant(sam, chatId, backendGrant, "view")).status).toBe(404);
    expect((await revoke(sam, chatId, backendGrant)).status).toBe(404);
    expect((await sam.request("GET", `/api/v1/ai-chats/${chatId}/grants`)).status).toBe(404);

    expect((await revoke(victor, chatId, samGrant)).status).toBe(204);
    await samUser.waitFor(() => samUser.durable(EventTypes.aiChatAccessChanged).length > 1);
    expect(samUser.durable(EventTypes.aiChatAccessChanged)[1]!.data).toEqual({
      conversationId: chatId,
      access: null,
    });
    samUser.close();
    expect(await readStatus(sam)).toBe(404);
  });

  it("the admin without a grant, org B's admin and a revoked grantee get 404 on GET/PATCH/DELETE grants", async () => {
    const { eve } = await orgB();
    for (const who of [ada, eve, sam]) {
      expect((await who.request("GET", `/api/v1/ai-chats/${chatId}/grants`)).status).toBe(404);
      expect((await patchGrant(who, chatId, backendGrant, "view")).status).toBe(404);
      expect((await revoke(who, chatId, backendGrant)).status).toBe(404);
      expect((await grant(who, chatId, { kind: "org" }, "chat")).status).toBe(404);
    }
    // Nothing changed.
    const list = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}/grants`));
    expect(list.grants).toEqual([
      expect.objectContaining({ id: backendGrant, level: "chat", unitKind: "team" }),
    ]);
  });
});

describe("after every grant is revoked", () => {
  it("the owner's next turn still attributes former grantees' messages and sends are solo again (409 while generating)", async () => {
    expect((await revoke(victor, chatId, backendGrant)).status).toBe(204);
    expect(
      (
        await su.query(
          "select count(*)::int as n from app.ai_chat_grants where conversation_id = $1 and revoked_at is null",
          [chatId],
        )
      ).rows[0].n,
    ).toBe(0);
    stack.fake.reset();
    const res = await ok(send(victor, chatId, "Summarise the thread [[slow]]"), 201);
    await running(res.generation.id);
    const busy = await send(victor, chatId, "And another");
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("generation_in_progress");
    await ok(
      victor.request("POST", `/api/v1/ai-chats/${chatId}/generations/${res.generation.id}/stop`, {}),
      202,
    );
    await settled(res.generation.id);
    const [call] = withoutTitles(stack.fake.requests("responses"));
    const input = call!.body?.input as Json[];
    const all = input.map(textOf).join("\n");
    expect(all).toContain(`<message from="Riley Park" user_id="${rileyId}"`);
    expect(all).toContain("Use double-entry bookkeeping");
    // Notice lines never reach the model as a message: only as `<notice>` lines of the turn context (P-09, 06-05).
    const outsideNotices = all.replace(/<notice>[^<]*<\/notice>/gu, "");
    expect(outsideNotices).not.toContain("shared this chat with");
    expect(outsideNotices).not.toContain("removed access for");

    // Every notice of this chat, in order.
    expect((await notices(chatId)).map((n) => n.body)).toEqual([
      "Víctor Ruiz shared this chat with Backend · Can chat",
      "Víctor Ruiz shared this chat with Engineering · Can view",
      "Víctor Ruiz removed access for Engineering",
      "Víctor Ruiz changed Backend to Can view",
      "Víctor Ruiz removed access for Backend",
      "Víctor Ruiz shared this chat with Everyone at Autofy Labs · Can view",
      "Víctor Ruiz shared this chat with Backend · Can chat",
      "Víctor Ruiz removed access for Backend",
      "Víctor Ruiz removed access for Everyone at Autofy Labs",
      "Víctor Ruiz shared this chat with Backend · Can chat",
      "Víctor Ruiz shared this chat with Sam Rivera · Can chat",
      "Víctor Ruiz removed access for Sam Rivera",
      "Víctor Ruiz removed access for Backend",
    ]);
    // Audits carry ids and levels only.
    for (const action of ["ai_chat.grant_created", "ai_chat.grant_updated", "ai_chat.grant_revoked"]) {
      for (const m of await audits(action, chatId)) {
        for (const key of Object.keys(m)) {
          expect(["conversationId", "grantId", "subjectKind", "subjectId", "level", "from", "to"]).toContain(
            key,
          );
        }
        expect(JSON.stringify(m)).not.toMatch(/Backend|Engineering|Víctor|Sam Rivera|Autofy/u);
      }
    }
  });
});
