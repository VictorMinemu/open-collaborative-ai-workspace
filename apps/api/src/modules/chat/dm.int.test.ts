import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import type { AuthContext } from "../../core";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { listDms } from "./dm";
import { getConversation } from "./service";

/**
 * 03.1-01 Task 2 (BOT-01/02, SC1, T-03.1-01-01/03/04/07): no path — REST, WebSocket, mention text, channel
 * membership or another tenant — reaches a personal bot or its DM except its owner. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-dm-isolation-0123456789abcd";
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
let adminId: string;
let samId: string;
let alexId: string;
let deeId: string;
let botId: string;
let botUsername: string;
let dmId: string;
let firstMessageId: string;
let channelId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

const cellMentionCount = async () =>
  Number(
    (
      await su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'",
        [`cell:${orgId}`],
      )
    ).rows[0].n,
  );

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** Authenticated /ws socket that records every frame it receives. */
async function socketFor(client: TestClient) {
  const token = await client.token();
  const ws = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const waitFor = async (pred: (f: Record<string, unknown>) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no matching frame (got ${JSON.stringify(frames)})`);
  };
  return { ws, frames, waitFor };
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  adminId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim", "developer");
  [, deeId] = await joinAs("dee@example.test", "Dee Deactivated", "developer");
  await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [deeId]);

  const created = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  botId = created.agent.id;
  botUsername = created.agent.username;
  dmId = created.dmId;
  const first = await ok(
    sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "my secret plan" }),
  );
  firstMessageId = first.id;

  const ch = await ok(admin.request("POST", "/api/v1/channels", { name: "random" }));
  channelId = ch.id;
  await ok(alex.request("POST", `/api/v1/channels/${channelId}/join`));
  await ok(sam.request("POST", `/api/v1/channels/${channelId}/join`));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("a personal bot's DM is readable by its owner only", () => {
  it("admin and another member get 404 on messages (GET and POST) and on the read marker", async () => {
    for (const who of [admin, alex]) {
      const read = await who.request("GET", `/api/v1/conversations/${dmId}/messages`);
      expect(read.status).toBe(404);
      const post = await who.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "let me in" });
      expect(post.status).toBe(404);
      const marker = await who.request("POST", `/api/v1/conversations/${dmId}/read`, { seq: 1 });
      expect(marker.status).toBe(404);
      expect((await ok(who.request("GET", "/api/v1/dms"))).dms).toEqual([]);
    }
    const leaked = await su.query("select count(*)::int as n from app.messages where body = 'let me in'");
    expect(leaked.rows[0].n).toBe(0);
  });

  it("a WebSocket sub to conv:<dm> is refused (forbidden) for admin and others, and no DM frame arrives", async () => {
    const owner = await socketFor(sam);
    const spies = [await socketFor(admin), await socketFor(alex)];
    try {
      owner.ws.send(JSON.stringify({ op: "sub", topic: `conv:${dmId}` }));
      await owner.waitFor((f) => f.op === "subscribed" && f.topic === `conv:${dmId}`);
      for (const s of spies) {
        s.ws.send(JSON.stringify({ op: "sub", topic: `conv:${dmId}` }));
        expect(await s.waitFor((f) => f.op === "err")).toMatchObject({
          op: "err",
          code: "forbidden",
          topic: `conv:${dmId}`,
        });
      }
      await ok(sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "live secret" }));
      await owner.waitFor((f) => f.op === "ev" && JSON.stringify(f).includes("live secret"));
      await new Promise((r) => setTimeout(r, 300));
      for (const s of spies) {
        expect(s.frames.some((f) => f.topic === `conv:${dmId}` && f.op !== "err")).toBe(false);
        expect(JSON.stringify(s.frames)).not.toContain("live secret");
      }
    } finally {
      for (const s of [owner, ...spies]) s.ws.close();
    }
  });

  it("the owner cannot add members to, archive or thread in the DM (channel-only routes are 404; DMs are flat)", async () => {
    const add = await sam.request("POST", `/api/v1/channels/${dmId}/members`, {
      kind: "user",
      id: (await ok(alex.request("GET", "/api/v1/me"))).user.id,
    });
    expect(add.status).toBe(404);
    expect((await sam.request("POST", `/api/v1/channels/${dmId}/archive`)).status).toBe(404);
    expect((await sam.request("GET", `/api/v1/channels/${dmId}`)).status).toBe(404);
    const thread = await sam.request("POST", `/api/v1/conversations/${dmId}/messages`, {
      body: "in a thread",
      threadRootId: firstMessageId,
    });
    expect(thread.status).toBe(400);
    expect(codeOf(thread)).toBe("dm_is_flat");
    const members = await su.query(
      "select count(*)::int as n from app.conversation_members where conversation_id = $1",
      [dmId],
    );
    expect(members.rows[0].n).toBe(2);
  });

  it("a bot-authored DM message produces no delivery", async () => {
    const plugin = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
    const before = await cellMentionCount();
    const res = await plugin.request("POST", "/messages", {
      agentId: botId,
      conversationId: dmId,
      threadRootMessageId: null,
      text: "a proactive note",
      idempotencyKey: `bot-${randomUUID()}`,
    });
    expect(res.status).toBe(200);
    expect(await cellMentionCount()).toBe(before);
  });

  it("a disabled personal bot receives nothing for a new DM message", async () => {
    await su.query("update app.agents set status = 'disabled' where id = $1", [botId]);
    try {
      const before = await cellMentionCount();
      await ok(sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: "anyone there?" }));
      expect(await cellMentionCount()).toBe(before);
    } finally {
      await su.query("update app.agents set status = 'ready' where id = $1", [botId]);
    }
  });
});

describe("a personal bot is unreachable from channels", () => {
  it("a text @mention of someone's personal bot stores no agent mention, adds no member, emits no event", async () => {
    const before = await cellMentionCount();
    const msg = await ok(
      alex.request("POST", `/api/v1/conversations/${channelId}/messages`, {
        body: `@${botUsername} hi`,
        mentions: [{ kind: "agent", id: botId }],
      }),
    );
    expect(msg.mentions.some((m: { kind: string }) => m.kind === "agent")).toBe(false);
    // The owner cannot summon it into a channel either.
    const own = await ok(
      sam.request("POST", `/api/v1/conversations/${channelId}/messages`, { body: `@${botUsername} hi` }),
    );
    expect(own.mentions.some((m: { kind: string }) => m.kind === "agent")).toBe(false);
    expect(await cellMentionCount()).toBe(before);
    const member = await su.query(
      "select 1 from app.conversation_members where conversation_id = $1 and member_kind = 'agent' and member_id = $2",
      [channelId, botId],
    );
    expect(member.rowCount).toBe(0);
  });

  it("adding a personal bot to a channel is refused with personal_bot_dm_only, even for its owner", async () => {
    for (const who of [sam, admin]) {
      const res = await who.request("POST", `/api/v1/channels/${channelId}/members`, {
        kind: "agent",
        id: botId,
      });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe("personal_bot_dm_only");
    }
    const member = await su.query(
      "select 1 from app.conversation_members where conversation_id = $1 and member_kind = 'agent' and member_id = $2",
      [channelId, botId],
    );
    expect(member.rowCount).toBe(0);
  });
});

describe("cross-tenant", () => {
  it("another organization's admin finds no DM, cannot subscribe, cannot post as the bot", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Eve', $2)", [
      userB,
      `${userB}@evil.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, userB],
    );
    const { db, realtime, chatAgent } = stack.built.core;
    const ctxB = { organizationId: orgB, userId: userB };
    expect(await db.withTenant(ctxB, (tx) => listDms(tx, userB))).toEqual([]);
    expect(await db.withTenant(ctxB, (tx) => getConversation(tx, dmId, ["channel", "dm"]))).toBeNull();
    const authB = { userId: userB, organizationId: orgB } as AuthContext;
    expect(await realtime.authorizeTopic(authB, `conv:${dmId}`)).toBe(false);
    await expect(
      chatAgent.postAgentMessage(ctxB, {
        agentId: botId,
        conversationId: dmId,
        threadRootId: null,
        body: "pwned",
        idempotencyKey: "evil-dm-1",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const leaked = await su.query("select count(*)::int as n from app.messages where body = 'pwned'");
    expect(leaked.rows[0].n).toBe(0);
  });
});

type Dm = { id: string; counterpart: Record<string, unknown> };

describe("human DMs (CHAT-04, D-06)", () => {
  const humanKey = (a: string, b: string) => [`user:${a}`, `user:${b}`].sort().join("|");
  let humanDmId: string;

  it("the admin opens a DM with Sam: a private dm with both humans, keyed by sorted user ids", async () => {
    const dm = await ok(
      admin.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: samId }] }),
    );
    humanDmId = dm.id;
    expect(dm.kind).toBe("dm");
    expect(dm.visibility).toBe("private");
    expect(dm.counterpart).toEqual({
      kind: "user",
      id: samId,
      name: "Sam Lee",
      handle: "sam",
      avatarUrl: null,
      deactivated: false,
    });
    const row = (
      await su.query("select kind, dm_key, visibility from app.conversations where id = $1", [dm.id])
    ).rows[0];
    expect(row).toEqual({ kind: "dm", dm_key: humanKey(adminId, samId), visibility: "private" });
    expect(row.dm_key).not.toMatch(/Sam|Víctor/);
    const members = (
      await su.query(
        "select member_kind, member_id, role from app.conversation_members where conversation_id = $1 order by member_id",
        [dm.id],
      )
    ).rows;
    expect(members).toEqual(
      [adminId, samId].sort().map((id) => ({ member_kind: "user", member_id: id, role: "member" })),
    );
  });

  it("Sam opening a DM with the admin gets the same conversation", async () => {
    const again = await ok(
      sam.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: adminId }] }),
    );
    expect(again.id).toBe(humanDmId);
    expect(again.counterpart).toMatchObject({ kind: "user", id: adminId, name: "Víctor Ruiz" });
  });

  it("20 concurrent opens from both sides create exactly one conversation", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? ok(alex.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: adminId }] }))
          : ok(admin.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: alexId }] })),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    const rows = await su.query("select count(*)::int as n from app.conversations where dm_key = $1", [
      humanKey(adminId, alexId),
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("GET /dms lists the human DM for both sides; bot DMs keep their agent counterpart, personal first", async () => {
    const mine = (await ok(admin.request("GET", "/api/v1/dms"))).dms as Dm[];
    expect(mine.find((d) => d.id === humanDmId)?.counterpart).toMatchObject({ kind: "user", id: samId });
    const samList = (await ok(sam.request("GET", "/api/v1/dms"))).dms as Dm[];
    expect(samList.find((d) => d.id === humanDmId)?.counterpart).toMatchObject({
      kind: "user",
      id: adminId,
      handle: "victor",
    });
    // Sam's personal bot DM (03.1) is still there, with the bot as counterpart, and listed first.
    expect(samList[0]).toMatchObject({
      id: dmId,
      counterpart: { kind: "agent", id: botId, scope: "personal" },
    });
    // Alex never sees it.
    const alexList = (await ok(alex.request("GET", "/api/v1/dms"))).dms as Array<{ id: string }>;
    expect(alexList.some((d) => d.id === humanDmId)).toBe(false);
  });

  it("posting in a human DM works and dispatches no bot", async () => {
    const before = await cellMentionCount();
    const msg = await ok(
      sam.request("POST", `/api/v1/conversations/${humanDmId}/messages`, { body: `hi @${botUsername}` }),
    );
    expect(msg.conversationId).toBe(humanDmId);
    const read = await ok(admin.request("GET", `/api/v1/conversations/${humanDmId}/messages`));
    expect(read.messages.map((m: { body: string }) => m.body)).toContain(`hi @${botUsername}`);
    expect(await cellMentionCount()).toBe(before);
    const added = await su.query(
      "select count(*)::int as n from app.conversation_members where conversation_id = $1",
      [humanDmId],
    );
    expect(added.rows[0].n).toBe(2);
  });

  it("refuses yourself, a deactivated member and another organization's user", async () => {
    const self = await admin.request("POST", "/api/v1/dms", {
      participants: [{ kind: "user", id: adminId }],
    });
    expect(self.status).toBe(400);
    expect(codeOf(self)).toBe("cannot_dm_self");
    const dee = await admin.request("POST", "/api/v1/dms", { participants: [{ kind: "user", id: deeId }] });
    expect(dee.status).toBe(400);
    expect(codeOf(dee)).toBe("member_deactivated");
    const orgB = randomUUID();
    const userB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `other-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'Otto', $2)", [
      userB,
      `${userB}@other.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Otto', 'admin')",
      [orgB, userB],
    );
    const foreign = await admin.request("POST", "/api/v1/dms", {
      participants: [{ kind: "user", id: userB }],
    });
    expect(foreign.status).toBe(404);
    const unknown = await admin.request("POST", "/api/v1/dms", {
      participants: [{ kind: "user", id: randomUUID() }],
    });
    expect(unknown.status).toBe(404);
  });

  it("one bot participant opens the existing bot DM path; someone else's personal bot is hidden", async () => {
    const own = await ok(
      sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: botId }] }),
    );
    expect(own.id).toBe(dmId);
    expect(own.counterpart).toMatchObject({ kind: "agent", id: botId, scope: "personal" });
    const other = await alex.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: botId }] });
    expect(other.status).toBe(404);
  });

  it("audits dm.created with ids only and tells both users' streams, never the org stream", async () => {
    const audit = (
      await su.query(
        "select metadata, resource_id from app.audit_events where action = 'dm.created' and resource_id = $1",
        [humanDmId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ kind: "dm", counterpart: { kind: "user", id: samId } });
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/Sam|Víctor|body/);
    const streams = (
      await su.query(
        "select stream_id from app.stream_events where type = 'conversation.created' and payload->>'conversationId' = $1",
        [humanDmId],
      )
    ).rows.map((r) => r.stream_id as string);
    expect(streams.sort()).toEqual([`user:${adminId}`, `user:${samId}`].sort());
  });
});
