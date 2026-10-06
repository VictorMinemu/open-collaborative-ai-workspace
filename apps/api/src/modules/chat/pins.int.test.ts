import { randomUUID } from "node:crypto";
import { MAX_PINS_PER_CONVERSATION } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-13 (04-05): pins per conversation (shared, audited, live, capped) over real PostgreSQL + Redis. Unpinning
 * is for the pinner, a channel moderator (owner relation or admin, `channel.archive`) or any DM participant.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let orgId: string;
let adminId: string;
let samId: string;
let alexId: string;
let archieId: string;
/** Created by Alex (its owner); Sam and the admin join. */
let channelId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function events(topic: string, type: string): Promise<Json[]> {
  const res = await su.query(
    "select payload from app.stream_events where stream_id = $1 and type = $2 order by seq",
    [topic, type],
  );
  return res.rows.map((r) => r.payload);
}

const audit = async (action: string, messageId: string) =>
  (
    await su.query(
      "select * from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, messageId],
    )
  ).rows;

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));
const pin = (as: TestClient, conv: string, id: string) =>
  as.request("PUT", `/api/v1/conversations/${conv}/pins/${id}`);
const unpin = (as: TestClient, conv: string, id: string) =>
  as.request("DELETE", `/api/v1/conversations/${conv}/pins/${id}`);
const pinsOf = async (as: TestClient, conv: string) =>
  (await ok(as.request("GET", `/api/v1/conversations/${conv}/pins`))).pins as Json[];
const pageOf = async (as: TestClient, conv: string) =>
  (await ok(as.request("GET", `/api/v1/conversations/${conv}/messages`))).messages as Json[];

async function invite(email: string, name: string): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id };
}

/** A bot DM between `userId` and Archie, created directly (the 3.1 shape). */
async function botDm(userId: string): Promise<string> {
  const dm = randomUUID();
  await su.query(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key, created_by) values ($1, $2, 'dm', 'private', $3, $4)",
    [dm, orgId, `agent:${archieId}|user:${userId}`, userId],
  );
  await su.query(
    `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
     values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
    [dm, orgId, userId, archieId],
  );
  return dm;
}

/** Sign `client`'s user into a brand-new organization B as its admin. */
async function moveToOtherOrg(client: TestClient, userId: string): Promise<void> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  expect((await ok(client.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();

  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  ({ client: sam, id: samId } = await invite("sam@example.test", "Sam Lee"));
  ({ client: alex, id: alexId } = await invite("alex@example.test", "Alex Kim"));

  archieId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [archieId, orgId],
  );

  channelId = (await ok(alex.request("POST", "/api/v1/channels", { name: "pins", visibility: "public" }))).id;
  await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
  await ok(admin.request("POST", `/api/v1/channels/${channelId}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("pins (CHAT-13)", () => {
  it("a member pins: pin.updated, audit message.pinned, listed newest first with pinnedBy, page shows pinned", async () => {
    const first = await post(alex, channelId, "Runbook: https://example.com/runbook");
    const second = await post(admin, channelId, "On-call this week: Sam");

    expect(await ok(pin(sam, channelId, first.id))).toEqual({ ok: true });
    // Idempotent: one row, one event, one audit row.
    expect(await ok(pin(sam, channelId, first.id))).toEqual({ ok: true });
    const evs = (await events(`conv:${channelId}`, "pin.updated")).filter((e) => e.messageId === first.id);
    expect(evs).toEqual([
      { conversationId: channelId, messageId: first.id, pinned: true, by: { kind: "user", id: samId } },
    ]);
    const rows = await audit("message.pinned", first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource_type: "message", actor_id: samId });
    expect(rows[0].metadata).toEqual({ messageId: first.id, conversationId: channelId });

    await ok(pin(admin, channelId, second.id));
    const pins = await pinsOf(alex, channelId);
    expect(pins.map((p) => p.message.id)).toEqual([second.id, first.id]);
    expect(pins[1]).toMatchObject({
      pinnedBy: { kind: "user", id: samId, displayName: "Sam Lee" },
      message: { id: first.id, body: "Runbook: https://example.com/runbook", pinned: true, reactions: [] },
    });
    expect(pins[1]?.pinnedAt).toEqual(expect.any(String));
    expect(pins[0]?.pinnedBy).toMatchObject({ kind: "user", id: adminId });

    const page = await pageOf(alex, channelId);
    expect(page.find((m) => m.id === first.id)?.pinned).toBe(true);
    const other = await post(alex, channelId, "not pinned");
    expect((await pageOf(alex, channelId)).find((m) => m.id === other.id)?.pinned).toBe(false);
  });

  it("unpin: not the pinner nor a moderator → 403; the pinner, the channel owner and an admin may", async () => {
    const byAdmin = await post(admin, channelId, "pinned by the admin");
    await ok(pin(admin, channelId, byAdmin.id));
    const denied = await unpin(sam, channelId, byAdmin.id);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details).toMatchObject({ permission: "channel.archive" });
    expect((await pinsOf(sam, channelId)).some((p) => p.message.id === byAdmin.id)).toBe(true);

    // The channel owner (Alex, a developer) moderates pins in their channel.
    await ok(unpin(alex, channelId, byAdmin.id));
    const ev = (await events(`conv:${channelId}`, "pin.updated")).at(-1);
    expect(ev).toEqual({
      conversationId: channelId,
      messageId: byAdmin.id,
      pinned: false,
      by: { kind: "user", id: alexId },
    });
    const rows = await audit("message.unpinned", byAdmin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ messageId: byAdmin.id, conversationId: channelId });
    expect(rows[0].actor_id).toBe(alexId);

    // The pinner always may; an admin may unpin anyone's pin.
    const bySam = await post(sam, channelId, "pinned by Sam");
    await ok(pin(sam, channelId, bySam.id));
    await ok(unpin(sam, channelId, bySam.id));
    await ok(pin(sam, channelId, bySam.id));
    await ok(unpin(admin, channelId, bySam.id));
    expect((await pinsOf(sam, channelId)).some((p) => p.message.id === bySam.id)).toBe(false);
    // Unpinning what is not pinned changes nothing (no event, no audit).
    const before = (await events(`conv:${channelId}`, "pin.updated")).length;
    await ok(unpin(admin, channelId, bySam.id));
    expect((await events(`conv:${channelId}`, "pin.updated")).length).toBe(before);
  });

  it("thread replies can be pinned; the list carries the reply's threadId for the jump", async () => {
    const root = await post(alex, channelId, "Where are the release notes?");
    const reply = await post(sam, channelId, "In the wiki", { threadRootId: root.id });
    await ok(pin(alex, channelId, reply.id));
    const listed = (await pinsOf(sam, channelId)).find((p) => p.message.id === reply.id);
    expect(listed?.message.threadId).toBe(root.id);
    await ok(unpin(alex, channelId, reply.id));
  });

  it(`caps pins at ${MAX_PINS_PER_CONVERSATION} per conversation (409 too_many_pins)`, async () => {
    const full = (await ok(alex.request("POST", "/api/v1/channels", { name: "pin-cap" }))).id;
    const msg = await post(alex, full, "seed");
    // Fill the cap directly (fast): 100 pin rows on 100 messages of this channel.
    const seeded = await su.query(
      `with m as (
         insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body, mentions)
         select $1, $2, 1000 + g, 'user', $3, 'm' || g, '[]'::jsonb from generate_series(1, $4::int) g
         returning id)
       insert into app.message_pins (organization_id, conversation_id, message_id, pinned_by)
       select $1, $2, id, $3 from m returning message_id`,
      [orgId, full, alexId, MAX_PINS_PER_CONVERSATION],
    );
    expect(seeded.rowCount).toBe(MAX_PINS_PER_CONVERSATION);
    const r = await pin(alex, full, msg.id);
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe("too_many_pins");
    // A message that is already pinned stays an idempotent success.
    await ok(pin(alex, full, seeded.rows[0].message_id));
  });

  it("deleting a pinned message removes the pin and emits pin.updated {pinned:false}", async () => {
    const msg = await post(sam, channelId, "temporary announcement");
    await ok(pin(sam, channelId, msg.id));
    await ok(sam.request("DELETE", `/api/v1/messages/${msg.id}`));
    const ev = (await events(`conv:${channelId}`, "pin.updated")).at(-1);
    expect(ev).toMatchObject({ messageId: msg.id, pinned: false });
    expect((await pinsOf(alex, channelId)).some((p) => p.message.id === msg.id)).toBe(false);
    const r = await pin(alex, channelId, msg.id);
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe("message_deleted");
  });

  it("a message of another conversation → 404; public non-member → 403 channel.post; archived → 410", async () => {
    const elsewhere = (await ok(alex.request("POST", "/api/v1/channels", { name: "pins-elsewhere" }))).id;
    const foreign = await post(alex, elsewhere, "lives in another channel");
    const mismatch = await pin(alex, channelId, foreign.id);
    expect(mismatch.status).toBe(404);
    expect((await pin(alex, channelId, randomUUID())).status).toBe(404);

    const notJoined = await pin(sam, elsewhere, foreign.id);
    expect(notJoined.status).toBe(403);
    expect(errorOf(notJoined).details).toMatchObject({ permission: "channel.post", reason: "not_a_member" });
    // Reading the pins of a public channel needs no membership.
    expect(await pinsOf(sam, elsewhere)).toEqual([]);

    const old = (await ok(alex.request("POST", "/api/v1/channels", { name: "pins-old" }))).id;
    const before = await post(alex, old, "before archiving");
    await ok(admin.request("POST", `/api/v1/channels/${old}/archive`));
    const r = await pin(alex, old, before.id);
    expect(r.status).toBe(410);
    expect(errorOf(r).code).toBe("channel_archived");
  });

  it("a non-member of a private channel gets 404 on GET, PUT and DELETE", async () => {
    const secret = (
      await ok(alex.request("POST", "/api/v1/channels", { name: "pins-secret", visibility: "private" }))
    ).id;
    const msg = await post(alex, secret, "private plan");
    await ok(pin(alex, secret, msg.id));
    for (const r of [
      await sam.request("GET", `/api/v1/conversations/${secret}/pins`),
      await pin(sam, secret, msg.id),
      await unpin(sam, secret, msg.id),
    ]) {
      expect(r.status).toBe(404);
      expect(errorOf(r).details).toBeUndefined();
    }
  });

  it("in a bot DM the participant pins the bot's message and unpins it (no moderation in DMs)", async () => {
    const dm = await botDm(samId);
    const reply = await stack.built.core.chatAgent.postAgentMessage(
      { organizationId: orgId, userId: null },
      {
        agentId: archieId,
        conversationId: dm,
        threadRootId: null,
        body: "Your summary",
        idempotencyKey: "p1",
      },
    );
    await ok(pin(sam, dm, reply.messageId));
    expect((await pinsOf(sam, dm)).map((p) => p.message.id)).toEqual([reply.messageId]);
    expect((await pageOf(sam, dm)).find((m) => m.id === reply.messageId)?.pinned).toBe(true);
    await ok(unpin(sam, dm, reply.messageId));
    expect(await pinsOf(sam, dm)).toEqual([]);
    // Nobody else even learns the DM exists.
    expect((await admin.request("GET", `/api/v1/conversations/${dm}/pins`)).status).toBe(404);
  });

  it("org B's admin gets 404 on every pin route and nothing is written", async () => {
    const msg = await post(alex, channelId, "org A only");
    const { client: eve, id: eveId } = await invite(`eve-${randomUUID().slice(0, 8)}@example.test`, "Eve");
    await moveToOtherOrg(eve, eveId);
    for (const r of [
      await eve.request("GET", `/api/v1/conversations/${channelId}/pins`),
      await pin(eve, channelId, msg.id),
      await unpin(eve, channelId, msg.id),
    ]) {
      expect(r.status).toBe(404);
    }
    const n = await su.query("select count(*)::int as n from app.message_pins where message_id = $1", [
      msg.id,
    ]);
    expect(n.rows[0].n).toBe(0);
  });
});
