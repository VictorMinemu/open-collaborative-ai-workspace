import { randomUUID } from "node:crypto";
import { TEAM_MENTION_LIMITS } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { teamMentionAudience } from "./team-mentions";

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
let orgId: string;
let adminId: string;
let scoutId: string;
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
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  adminId = setup.user.id;
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

  scoutId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Scout",
        username: "scout",
        instructions: "You are Scout.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
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

/** Scout's post through `postAgentMessageIn` (what the Agent Channel API calls) for a turn of `onBehalfOfUserId`. */
async function botPost(conversationId: string, body: string, onBehalfOfUserId: string) {
  const { core } = stack.built;
  const posted = await core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
    core.chatAgent.postAgentMessageIn(tx, {
      agentId: scoutId,
      conversationId,
      threadRootId: null,
      body,
      idempotencyKey: randomUUID(),
      onBehalfOfUserId,
    }),
  );
  return posted.messageId;
}

const count = async (text: string, values: unknown[]) =>
  Number((await su.query(text, values)).rows[0]?.n ?? 0);

describe("departments, the cap, ranks, edits, bots and tenants (07.17 D-13, PD-14, E14, E17, E18)", () => {
  const all = (unitId: string, ...names: string[]) =>
    Object.fromEntries(names.map((n) => [person[n] as string, { kind: "team_mention", unitId }]));

  it("a department mention reaches its subtree (its teams and its direct members), the author excluded", async () => {
    const opsAll = await channel("ops-all", "public", [person.ben as string]);
    const msg = await say(client.ben as TestClient, opsAll, "@ops heads up");
    expect(msg.mentions).toEqual([{ kind: "unit", id: unit.ops }]);
    expect(await rowsOf(msg.id)).toEqual(all(unit.ops as string, "ana", "cam", "dan", "eva"));
  });

  it("two units: each person once, under the first unit that reached them", async () => {
    const both = await channel("both-units", "public", [person.ben as string]);
    const msg = await say(client.ben as TestClient, both, "@billing and @ops");
    expect(await rowsOf(msg.id)).toEqual({
      ...all(unit.ops as string, "ana", "cam", "eva"),
      ...all(unit.billing as string, "dan"),
    });
  });

  it(`201 reachable members: exactly ${TEAM_MENTION_LIMITS.recipientsPerMessage} notified, the first by user id (D-13)`, async () => {
    expect(TEAM_MENTION_LIMITS.recipientsPerMessage).toBe(200);
    const hall = await createUnit("department", "Hall");
    const crowd = await createUnit("team", "Crowd", hall.id);
    expect(crowd.handle).toBe("crowd");
    const seeded = Array.from({ length: 201 }, () => randomUUID());
    // Distinct names: a person whose handle were `crowd` would take the mention (precedence users → units, PD-13).
    await su.query(
      `insert into auth.user (id, name, email)
       select id, 'Seat ' || n, id::text || '@crowd.test' from unnest($1::uuid[]) with ordinality as s(id, n)`,
      [seeded],
    );
    await su.query(
      `insert into app.org_members (organization_id, user_id, display_name, role)
       select $1, id, 'Seat ' || n, 'standard' from unnest($2::uuid[]) with ordinality as s(id, n)`,
      [orgId, seeded],
    );
    await su.query(
      `insert into app.unit_memberships (organization_id, unit_id, user_id, role)
       select $1, $2, id, 'member' from unnest($3::uuid[]) as id`,
      [orgId, crowd.id, seeded],
    );
    const crowdChannel = await channel("crowd", "public", [person.ben as string]);
    const msg = await say(client.ben as TestClient, crowdChannel, "@crowd all hands");
    const rows = await rowsOf(msg.id);
    const sorted = [...seeded].sort();
    expect(Object.keys(rows).sort()).toEqual(sorted.slice(0, 200));
    expect(Object.values(rows).every((r) => r.kind === "team_mention" && r.unitId === crowd.id)).toBe(true);
    expect(rows[sorted[200] as string]).toBeUndefined();
  });

  it("@logistics @channel @cam: one row each, the stronger kind (direct > team > channel)", async () => {
    const ranks = await channel("ranks", "public", [
      person.ben as string,
      person.ana as string,
      person.cam as string,
      person.dan as string,
    ]);
    const msg = await say(client.ben as TestClient, ranks, "@logistics @channel @cam look");
    expect(msg.mentions).toEqual([
      { kind: "unit", id: unit.logistics },
      { kind: "user", id: person.cam },
    ]);
    expect(await rowsOf(msg.id)).toEqual({
      [person.ana as string]: { kind: "team_mention", unitId: unit.logistics },
      [person.cam as string]: { kind: "mention", unitId: null },
      [person.dan as string]: { kind: "channel", unitId: null },
      // The channel's creator is a member too (not in Logistics).
      [adminId]: { kind: "channel", unitId: null },
    });
    for (const p of ["ana", "cam", "dan"])
      expect(await createdFor(person[p] as string, msg.id)).toHaveLength(1);
    const [cam] = await createdFor(person.cam as string, msg.id);
    expect(cam?.notification.kind).toBe("mention");
    expect(cam?.notification).not.toHaveProperty("unit");
  });

  it("a bot's @logistics notifies the team, attributed to the bot; no bot is notified or woken (E17, P4)", async () => {
    const botChannel = await channel("bot-posts", "public");
    await ok(admin.request("POST", `/api/v1/channels/${botChannel}/members`, { kind: "agent", id: scoutId }));
    const messageId = await botPost(botChannel, "@logistics done", adminId);
    const stored = (await su.query("select mentions from app.messages where id = $1", [messageId])).rows[0]
      ?.mentions;
    expect(stored).toEqual([{ kind: "unit", id: unit.logistics }]);
    expect(await rowsOf(messageId)).toEqual(all(unit.logistics as string, "ana", "ben", "cam"));
    const actors = await su.query(
      "select distinct actor_kind, actor_id from app.notifications where message_id = $1",
      [messageId],
    );
    expect(actors.rows).toEqual([{ actor_kind: "agent", actor_id: scoutId }]);
    expect(
      await count("select count(*)::int as n from app.notifications where user_id = $1", [scoutId]),
    ).toBe(0);
    expect(
      await count("select count(*)::int as n from app.agent_turns where message_id = $1", [messageId]),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and payload::text like $2",
        [`cell:${orgId}`, `%${messageId}%`],
      ),
    ).toBe(0);
  });

  it("editing a message to add @logistics stores the mention and notifies nobody (E18)", async () => {
    const edits = await channel("edits", "public", [person.ben as string]);
    const msg = await say(client.ben as TestClient, edits, "hello");
    const edited = await ok(
      (client.ben as TestClient).request("PATCH", `/api/v1/messages/${msg.id}`, { body: "hello @logistics" }),
    );
    expect(edited.mentions).toEqual([{ kind: "unit", id: unit.logistics }]);
    expect(await rowsOf(msg.id)).toEqual({});
  });

  it("a deleted unit: the inbox item still lists, with unit null", async () => {
    const temp = await createUnit("team", "Temp", unit.ops);
    await addToUnit(temp.id, person.ana as string);
    const tempChannel = await channel("temp", "public", [person.ben as string]);
    const msg = await say(client.ben as TestClient, tempChannel, "@temp quick one");
    expect(await rowsOf(msg.id)).toEqual(all(temp.id, "ana"));
    await ok(admin.request("DELETE", `/api/v1/units/${temp.id}`));
    expect(await rowsOf(msg.id)).toEqual({ [person.ana as string]: { kind: "team_mention", unitId: null } });
    const inbox = await ok(
      (client.ana as TestClient).request("GET", "/api/v1/notifications?filter=mentions"),
    );
    const item = (inbox.items as Json[]).find((n) => n.messageId === msg.id);
    expect(item).toMatchObject({ kind: "team_mention", unit: null });
  });

  it("organization B: never reached by A's team mentions; A's unit ids and handles resolve nothing in B (T-07.17-12-04)", async () => {
    const [zed, zedId] = await joinAs("zed@example.test", "Zed Other");
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
      orgB,
      "Other Org",
      `other-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [zedId]);
    await su.query("delete from app.org_members where user_id = $1", [zedId]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      zedId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, email, role) values ($1, $2, 'Zed Other', 'zed@example.test', 'admin')",
      [orgB, zedId],
    );
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, zedId]);
    // A crossed row (organization B, A's Logistics) must never make Zed part of A's audience.
    await su.query(
      "insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, 'member')",
      [orgB, unit.logistics, zedId],
    );

    const inA = await channel("tenant-a", "public", [person.ben as string]);
    const msgA = await say(client.ben as TestClient, inA, "@logistics tenant check");
    expect(await rowsOf(msgA.id)).toEqual(all(unit.logistics as string, "ana", "cam"));
    expect(await count("select count(*)::int as n from app.notifications where user_id = $1", [zedId])).toBe(
      0,
    );

    // In B: A's ids reach nobody, and A's handles do not resolve.
    const { core } = stack.built;
    const audience = await core.db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      teamMentionAudience(tx, {
        unitIds: [unit.logistics as string, unit.ops as string],
        authorUserId: null,
      }),
    );
    expect(audience).toEqual([]);
    const bChannel = (await ok(zed.request("POST", "/api/v1/channels", { name: "orders" }))).id;
    const inB = await say(zed, bChannel, "@logistics @billing @ops in B");
    expect(inB.mentions).toEqual([]);
    expect(await rowsOf(inB.id)).toEqual({});
  });
});
