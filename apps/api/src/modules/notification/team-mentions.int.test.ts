import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * Phase 07.17 (D-07, D-13, D-18, PD-14, AFO-04): `@team` on a channel post notifies the active members of the unit's
 * subtree who can read the conversation (the resolver decides, never this module), as `team_mention` with the unit's id
 * on the row, below a direct mention, at most 200 people per message, never the author, never a bot, never on an edit
 * and never across organizations. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-team-mention-notify-0123";
const ADMIN = {
  name: "Víctor Ruiz",
  email: "victor@example.test",
  password: "correct-horse-battery",
  orgName: "Autofy Labs",
};

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
const client: Record<string, TestClient> = {};
const person: Record<string, string> = {};
const unit: Record<string, string> = {};

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const say = (c: TestClient, conversationId: string, body: string, extra: Json = {}) =>
  ok(c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body, ...extra }));

async function createUnit(kind: "department" | "team", name: string, parentId: string | null = null) {
  return (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))) as {
    id: string;
    handle: string;
  };
}

const addToUnit = (unitId: string, userId: string) =>
  ok(admin.request("POST", `/api/v1/units/${unitId}/members`, { userId, role: "member" }));

async function channel(name: string, visibility: "public" | "private", members: string[] = []) {
  const id = (await ok(admin.request("POST", "/api/v1/channels", { name, visibility }))).id as string;
  for (const m of members)
    await ok(admin.request("POST", `/api/v1/channels/${id}/members`, { kind: "user", id: m }));
  return id;
}

/** The notification rows one message created, as `{ userId: { kind, unitId } }`. */
async function rowsOf(messageId: string): Promise<Record<string, { kind: string; unitId: string | null }>> {
  const res = await su.query(
    "select user_id, kind, unit_id from app.notifications where message_id = $1 order by user_id",
    [messageId],
  );
  return Object.fromEntries(
    res.rows.map((r) => [
      r.user_id as string,
      { kind: r.kind as string, unitId: r.unit_id as string | null },
    ]),
  );
}

async function events(userId: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [`user:${userId}`, type],
  );
  return res.rows.map((r) => r.payload);
}

const createdFor = async (userId: string, messageId: string) =>
  (await events(userId, "notification.created")).filter((e) => e.notification.messageId === messageId);

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  for (const name of ["ana", "ben", "cam", "dan", "eva"]) {
    const [c, id] = await joinAs(`${name}@example.test`, `${name.toUpperCase()} Test`);
    client[name] = c;
    person[name] = id;
  }

  // Ops (department) ⊃ Logistics {ana, ben, cam}, Billing {dan}; Eva is a direct member of Ops.
  const ops = await createUnit("department", "Ops");
  unit.ops = ops.id;
  const logistics = await createUnit("team", "Logistics", ops.id);
  expect(logistics.handle).toBe("logistics");
  unit.logistics = logistics.id;
  unit.billing = (await createUnit("team", "Billing", ops.id)).id;
  for (const p of ["ana", "ben", "cam"]) await addToUnit(unit.logistics, person[p] as string);
  await addToUnit(unit.billing, person.dan as string);
  await addToUnit(unit.ops, person.eva as string);
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("@team notifies its members who read the channel (07.17 D-07, PD-14)", () => {
  it("Ben's @logistics in #orders notifies Ana and Cam once each, with the unit, in the inbox and the counts", async () => {
    const ordersId = await channel("orders", "public", [person.ben as string, person.ana as string]);
    const msg = await say(client.ben as TestClient, ordersId, "@logistics please check");
    expect(msg.mentions).toEqual([{ kind: "unit", id: unit.logistics }]);

    expect(await rowsOf(msg.id)).toEqual({
      [person.ana as string]: { kind: "team_mention", unitId: unit.logistics },
      [person.cam as string]: { kind: "team_mention", unitId: unit.logistics },
    });

    const [created] = await createdFor(person.ana as string, msg.id);
    expect(created?.popup).toBe(true);
    expect(created?.notification).toMatchObject({
      kind: "team_mention",
      actor: { kind: "user", id: person.ben },
      unit: { id: unit.logistics, handle: "logistics", name: "Logistics" },
    });

    const inbox = await ok(
      (client.ana as TestClient).request("GET", "/api/v1/notifications?filter=mentions"),
    );
    const item = (inbox.items as Json[]).find((n) => n.messageId === msg.id);
    expect(item).toMatchObject({
      kind: "team_mention",
      unit: { id: unit.logistics, handle: "logistics", name: "Logistics" },
    });

    const listed = (await ok((client.ana as TestClient).request("GET", "/api/v1/channels"))).channels.find(
      (c: Json) => c.id === ordersId,
    );
    expect(listed?.mentionCount).toBe(1);
  });

  it("a private channel: a team member who cannot read it gets nothing (T-07.17-12-01)", async () => {
    const opsPrivate = await channel("ops-private", "private", [person.ana as string, person.ben as string]);
    const msg = await say(client.ben as TestClient, opsPrivate, "@logistics private note");
    expect(msg.mentions).toEqual([{ kind: "unit", id: unit.logistics }]);
    expect(await rowsOf(msg.id)).toEqual({
      [person.ana as string]: { kind: "team_mention", unitId: unit.logistics },
    });
    expect(await createdFor(person.cam as string, msg.id)).toEqual([]);
  });
});
