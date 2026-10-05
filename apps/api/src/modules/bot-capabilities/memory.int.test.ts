import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-07 (BOT-04, SC5, D-10): a bot's memory of one human. Saved only through the cell's gated tool in that
 * human's DM (`POST /agent-channel/v1/memories`, owner taken from the stored delivery), injected only into
 * that human's DM turns, listed and cleared only by that human. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-memories-0123456789abcdef";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let orgId: string;
let samId: string;
let alexId: string;
let samBotId: string;
let samDmId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function joinAs(email: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

async function cell(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** The `agent.mention.v1` event delivered to `agentId` for `messageId`. */
async function mentionOf(agentId: string, messageId: string): Promise<Json> {
  const rows = (
    await su.query(
      `select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'
        and payload->'agent'->>'id' = $2 and payload->'message'->>'id' = $3`,
      [`cell:${orgId}`, agentId, messageId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** `c` writes `text` in `conversationId`; returns the event delivered to `agentId`. */
async function say(
  c: TestClient,
  conversationId: string,
  agentId: string,
  text: string,
  mentions: Json[] = [],
): Promise<Json> {
  const msg = await ok(
    c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body: text, mentions }),
  );
  return mentionOf(agentId, msg.id as string);
}

const save = (eventId: string, text: string, agentId = samBotId, extra: Json = {}) =>
  cell("/memories", { eventId, agentId, text, ...extra });

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

const rowsOf = async (agentId: string, userId: string) =>
  (
    await su.query(
      "select id, user_id, text, source_event_id from app.agent_memories where agent_id = $1 and user_id = $2 order by created_at, id",
      [agentId, userId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim");
  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
  samDmId = personal.dmId;
  // Room for every turn of this file under the daily limit (03.1-05 meters each delivery).
  await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 100 }));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------- Task 1: save, inject, list, clear

describe("a note the human asks the bot to remember (D-10)", () => {
  it("is saved through the cell route, bound to the human of the delivery, audited without its text", async () => {
    const ev = await say(sam, samDmId, samBotId, "Remember that I prefer metric units");
    expect(ev.turn.tools).toContain("ocw_memory_save");
    expect(ev.turn.memory).toEqual([]);

    const r = await save(ev.eventId, "Prefers metric units");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ memoryId: expect.any(String), created: true });

    const rows = await rowsOf(samBotId, samId);
    expect(rows).toEqual([
      { id: r.body.memoryId, user_id: samId, text: "Prefers metric units", source_event_id: ev.eventId },
    ]);
    const audit = (await audits("agent.memory_saved")).at(-1);
    expect(audit).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      agent_id: samBotId,
      user_id: samId,
      result: "success",
    });
    expect(audit?.metadata).toMatchObject({ chars: "Prefers metric units".length });
    expect(JSON.stringify(audit)).not.toContain("metric");

    // The same text again is not stored twice.
    const again = await save(ev.eventId, "Prefers metric units");
    expect(again.body).toEqual({ memoryId: r.body.memoryId, created: false });
    expect(await rowsOf(samBotId, samId)).toHaveLength(1);
  });

  it("comes back in the human's next DM turn as turn.memory", async () => {
    const ev = await say(sam, samDmId, samBotId, "What units do I like?");
    expect(ev.turn.memory).toEqual([
      { id: expect.any(String), text: "Prefers metric units", createdAt: expect.any(String) },
    ]);
  });

  it("the owner lists it, deletes one, then clears all; each clear is audited with the count only", async () => {
    const listed = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/memories`));
    expect(listed.items.map((i: Json) => i.text)).toEqual(["Prefers metric units"]);

    const ev = await say(sam, samDmId, samBotId, "Also remember two more things");
    const a = await save(ev.eventId, "Has a cat named Miso");
    await save(ev.eventId, "Works from Madrid");
    const all = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/memories`));
    expect(all.items.map((i: Json) => i.text)).toEqual([
      "Works from Madrid",
      "Has a cat named Miso",
      "Prefers metric units",
    ]);

    await ok(sam.request("DELETE", `/api/v1/agents/${samBotId}/memories/${a.body.memoryId}`));
    const after = await ok(sam.request("GET", `/api/v1/agents/${samBotId}/memories`));
    expect(after.items.map((i: Json) => i.text)).toEqual(["Works from Madrid", "Prefers metric units"]);
    const one = (await audits("agent.memory_cleared")).at(-1);
    expect(one).toMatchObject({ actor_kind: "user", actor_id: samId, agent_id: samBotId, user_id: samId });
    expect(one?.metadata).toEqual({ count: 1, scope: "one" });

    // A note that is gone (or never was) is a 404.
    const missing = await sam.request("DELETE", `/api/v1/agents/${samBotId}/memories/${a.body.memoryId}`);
    expect(missing.status).toBe(404);

    await ok(sam.request("DELETE", `/api/v1/agents/${samBotId}/memories`));
    expect((await ok(sam.request("GET", `/api/v1/agents/${samBotId}/memories`))).items).toEqual([]);
    expect((await audits("agent.memory_cleared")).at(-1)?.metadata).toEqual({ count: 2, scope: "all" });
    expect(JSON.stringify(await audits("agent.memory_cleared"))).not.toContain("Madrid");

    const next = await say(sam, samDmId, samBotId, "Anything about me?");
    expect(next.turn.memory).toEqual([]);
  });

  it("an unknown event or another bot's event is 404 unknown_turn; text over 500 chars is refused", async () => {
    const ev = await say(sam, samDmId, samBotId, "remember this");
    const unknown = await save("0199a6f0-0000-7000-8000-00000000ffff", "Nope");
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe("unknown_turn");
    const foreign = await save(ev.eventId, "Nope", "0199a6f0-0000-7000-8000-00000000aaaa");
    expect(foreign.status).toBe(404);
    expect(codeOf(foreign)).toBe("unknown_turn");
    expect((await save(ev.eventId, "x".repeat(501))).status).toBe(400);
    expect(await rowsOf(samBotId, samId)).toEqual([]);
  });
});
