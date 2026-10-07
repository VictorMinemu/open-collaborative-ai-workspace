import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";

/**
 * AICHAT-09 (05-13): read-only snapshot share links of an AI chat. The owner freezes the visible conversation into
 * `ai_chat_shares.snapshot` once; a colleague signed in to the SAME organization (with `ai_chat.share.read`) reads
 * it at `/api/v1/ai-shares/<id>`. Nothing is anonymous, no token sits in a URL, later messages or regenerations
 * never leak into an existing snapshot, and another organization, a deny rule, a revoked link and a random id all
 * read as the same 404. Real PostgreSQL + Redis, the in-process fake model.
 */

let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;

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
const share = (as: TestClient, chatId: string) => as.request("POST", `/api/v1/ai-chats/${chatId}/shares`, {});
const view = (as: TestClient, shareId: string) => as.request("GET", `/api/v1/ai-shares/${shareId}`);

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const bodyOf = async (messageId: string) =>
  (await su.query("select body from app.messages where id = $1", [messageId])).rows[0].body as string;

/** A chat of Sam's with two finished exchanges: its id, the four bodies and the model label. */
async function twoExchanges(): Promise<{ chatId: string; bodies: string[]; label: string }> {
  const first = await ok(createChat(sam, "Plan a team offsite"), 201);
  await settled(first.generation.id);
  const second = await ok(send(sam, first.chat.id, "Add a budget"), 201);
  await settled(second.generation.id);
  return {
    chatId: first.chat.id,
    bodies: [
      "Plan a team offsite",
      await bodyOf(first.assistantMessage.id),
      "Add a budget",
      await bodyOf(second.assistantMessage.id),
    ],
    label: first.generation.modelLabel,
  };
}

/** A member of a brand-new organization B who is its admin (cross-tenant probes). */
async function orgBAdmin(): Promise<TestClient> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const eve = new TestClient(stack.baseUrl);
  const accepted = await ok(
    eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name: "Eve", password: "eve-long-password-1" }),
  );
  const eveId: string = accepted.user.id;
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [orgB, `evil-${orgB}`]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [orgB, eveId]);
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
  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex, userId: alexId } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  await seedPlan(sam);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("create and read a snapshot (same organization, signed in)", () => {
  it("Sam shares a chat with two exchanges; Alex reads the four messages as they were, with Sam as the author", async () => {
    const { chatId, bodies, label } = await twoExchanges();
    const created = await ok(share(sam, chatId), 201);
    expect(created).toMatchObject({
      chatId,
      path: `/share/ai/${created.id}`,
      title: "Plan a team offsite",
      messageCount: 4,
      revokedAt: null,
    });
    // The path is the web route: an id, nothing else (no token, no query string).
    expect(created.path).toMatch(/^\/share\/ai\/[0-9a-f-]{36}$/u);

    const read = await ok(view(alex, created.id));
    expect(read).toMatchObject({
      id: created.id,
      title: "Plan a team offsite",
      createdBy: { kind: "user", id: samId, displayName: "Sam Rivera" },
    });
    expect(read.messages.map((m: Json) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(read.messages.map((m: Json) => m.body)).toEqual(bodies);
    expect(read.messages.map((m: Json) => m.modelLabel)).toEqual([null, label, null, label]);
    expect(read.messages.every((m: Json) => Array.isArray(m.attachments) && m.attachments.length === 0)).toBe(true);
    // The owner reads his own link too.
    expect((await view(sam, created.id)).status).toBe(200);

    const audits = (
      await su.query("select metadata from app.audit_events where action = 'ai_chat.share_created' and resource_id = $1", [
        chatId,
      ])
    ).rows;
    expect(audits).toHaveLength(1);
    // Ids and the count only: never a body or the title.
    expect(audits[0].metadata).toEqual({ conversationId: chatId, shareId: created.id, messageCount: 4 });
    const viewed = (
      await su.query("select metadata from app.audit_events where action = 'ai_chat.share_viewed'")
    ).rows.filter((r) => r.metadata.shareId === created.id);
    expect(viewed.map((r) => r.metadata)).toContainEqual({ shareId: created.id, conversationId: chatId });
  });

  it("an answer still running or a failed one at share time is not in the snapshot", async () => {
    const first = await ok(createChat(sam, "Kick off"), 201);
    await settled(first.generation.id);
    // Refused before streaming: a failed answer with no text (no credential change for this code).
    const failed = await ok(send(sam, first.chat.id, "try this [[plan:unsupported:web_search]]"), 201);
    expect((await settled(failed.generation.id)).status).toBe("failed");
    const slow = await ok(send(sam, first.chat.id, "count slowly [[slow]]"), 201);
    try {
      const created = await ok(share(sam, first.chat.id), 201);
      const read = await ok(view(alex, created.id));
      expect(read.messages.map((m: Json) => m.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(created.messageCount).toBe(4);
      expect(read.messages.some((m: Json) => m.role === "assistant" && m.body === "")).toBe(false);
    } finally {
      await sam.request("POST", `/api/v1/ai-chats/${first.chat.id}/generations/${slow.generation.id}/stop`);
      await settled(slow.generation.id);
    }
  });

  it("later messages and a regenerated answer never reach an existing snapshot", async () => {
    const { chatId, bodies } = await twoExchanges();
    const created = await ok(share(sam, chatId), 201);
    const before = await ok(view(alex, created.id));

    const more = await ok(send(sam, chatId, "One more thing"), 201);
    await settled(more.generation.id);
    const regen = await ok(sam.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, {}), 201);
    await settled(regen.generation.id);
    await ok(sam.request("PATCH", `/api/v1/ai-chats/${chatId}`, { title: "Renamed later" }));

    const after = await ok(view(alex, created.id));
    expect(after).toEqual(before);
    expect(after.messages.map((m: Json) => m.body)).toEqual(bodies);
    expect(after.title).toBe("Plan a team offsite");
    // A new snapshot does see the current state.
    const fresh = await ok(share(sam, chatId), 201);
    expect(fresh.messageCount).toBe(6);
    expect(fresh.title).toBe("Renamed later");
  });
});

describe("never public, never across organizations (T-05-13-01, T-05-13-04)", () => {
  let shareId: string;
  let chatId: string;
  let missing: { status: number; body: unknown };

  beforeAll(async () => {
    const created = await ok(createChat(sam, "Private thoughts"), 201);
    await settled(created.generation.id);
    chatId = created.chat.id;
    shareId = (await ok(share(sam, chatId), 201)).id;
    const r = await view(alex, randomUUID());
    missing = { status: r.status, body: r.body };
    expect(missing.status).toBe(404);
  });

  it("an anonymous request gets 401 on every share route", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await view(anon, shareId)).status).toBe(401);
    expect((await share(anon, chatId)).status).toBe(401);
    expect((await anon.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(401);
    expect((await anon.request("DELETE", `/api/v1/ai-shares/${shareId}`)).status).toBe(401);
    // Not even with the web Origin and no cookie through plain fetch.
    const raw = await fetch(`${stack.baseUrl}/api/v1/ai-shares/${shareId}`, { headers: { origin: WEB_ORIGIN } });
    expect(raw.status).toBe(401);
  });

  it("org B's admin gets the same 404 as a random id", async () => {
    const eve = await orgBAdmin();
    const r = await view(eve, shareId);
    expect(r.status).toBe(404);
    expect(r.body).toEqual(missing.body);
    expect((await share(eve, chatId)).status).toBe(404);
  });

  it("a deny rule on ai_chat.share.read for Alex reads as 404; removing it restores access", async () => {
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "ai_chat.share.read",
        effect: "deny",
      }),
    );
    try {
      const r = await view(alex, shareId);
      expect(r.status).toBe(404);
      expect(r.body).toEqual(missing.body);
      expect((await view(sam, shareId)).status).toBe(200);
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
    expect((await view(alex, shareId)).status).toBe(200);
  });

  it("only the owner creates or lists shares of a chat (Alex and the admin get 404)", async () => {
    expect((await share(alex, chatId)).status).toBe(404);
    expect((await share(admin, chatId)).status).toBe(404);
    expect((await alex.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(404);
    expect((await admin.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(404);
    const mine = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}/shares`));
    expect(mine.shares.map((s: Json) => s.id)).toEqual([shareId]);
  });
});
