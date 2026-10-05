import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 03.1-02 (SC2, D-03/D-04, T-03.1-02-04/07): any member opens a private chat with a team bot they may use;
 * two members get two separate chats and never see each other's history; a disabled bot cannot be opened,
 * and disabling a team bot archives every member's chat with it (re-enabling restores them). Real
 * PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-team-dm-0123456789abcdefghi";
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
let teamBotId: string;
let samDm: string;
let alexDm: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

const codeOf = (r: { body: Record<string, unknown> | null }) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

// biome-ignore lint/suspicious/noExplicitAny: stored event payloads are asserted field by field
type Payload = Record<string, any>;

const mentionsFor = async (conversationId: string) =>
  (
    await su.query(
      `select payload from app.stream_events
       where stream_id = $1 and type = 'agent.mention.v1' and payload->'conversation'->>'id' = $2
       order by seq`,
      [`cell:${orgId}`, conversationId],
    )
  ).rows.map((r) => r.payload as Payload);

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

async function teamBot(name: string): Promise<string> {
  const bot = await ok(
    admin.request("POST", "/api/v1/agents", {
      name,
      instructions: "Answer status questions.",
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  return bot.id as string;
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN }));
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");
  [alex, alexId] = await joinAs("alex@example.test", "Alex Kim", "developer");
  teamBotId = await teamBot("Helper");
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("team bot DMs: one private chat per member", () => {
  it("each member opens their own DM; opening again returns the same one", async () => {
    const s = await ok(sam.request("POST", `/api/v1/agents/${teamBotId}/dm`));
    const a = await ok(alex.request("POST", `/api/v1/agents/${teamBotId}/dm`));
    expect(s).toMatchObject({ created: true });
    expect(a).toMatchObject({ created: true });
    expect(s.dmId).not.toBe(a.dmId);
    samDm = s.dmId;
    alexDm = a.dmId;
    expect(await ok(sam.request("POST", `/api/v1/agents/${teamBotId}/dm`))).toEqual({
      dmId: samDm,
      created: false,
    });

    const conv = (
      await su.query("select kind, visibility, dm_key from app.conversations where id = $1", [samDm])
    ).rows[0];
    expect(conv).toEqual({ kind: "dm", visibility: "private", dm_key: `agent:${teamBotId}|user:${samId}` });

    // Opened is audited once per member (only when created), with the bot it talks to.
    const opened = await su.query(
      "select user_id, resource_id, metadata from app.audit_events where action = 'dm.opened' order by occurred_at",
    );
    expect(opened.rows).toEqual([
      { user_id: samId, resource_id: samDm, metadata: { agentId: teamBotId } },
      { user_id: alexId, resource_id: alexDm, metadata: { agentId: teamBotId } },
    ]);

    // Listed under the opener's DMs only.
    const samDms = (await ok(sam.request("GET", "/api/v1/dms"))).dms as Array<Payload>;
    expect(samDms.map((d) => d.id)).toEqual([samDm]);
    expect(samDms[0]).toMatchObject({ counterpart: { kind: "agent", id: teamBotId, scope: "team" } });
    expect(((await ok(alex.request("GET", "/api/v1/dms"))).dms as Payload[]).map((d) => d.id)).toEqual([
      alexDm,
    ]);
  });

  it("a message in one member's DM is delivered with that DM's history and roster only", async () => {
    const alexMsg = await ok(
      alex.request("POST", `/api/v1/conversations/${alexDm}/messages`, { body: "alex's private question" }),
    );
    const samFirst = await ok(sam.request("POST", `/api/v1/conversations/${samDm}/messages`, { body: "hi" }));
    const samSecond = await ok(
      sam.request("POST", `/api/v1/conversations/${samDm}/messages`, { body: "status?" }),
    );

    const samEvents = await mentionsFor(samDm);
    expect(samEvents).toHaveLength(2);
    const last = samEvents[1]!;
    expect(last).toMatchObject({
      agent: { id: teamBotId },
      conversation: { id: samDm, kind: "dm" },
      message: { id: samSecond.id, author: { id: samId } },
    });
    expect(last.threadHistory.map((h: { id: string }) => h.id)).toEqual([samFirst.id]);
    const roster = last.roster.map((r: { kind: string; id: string }) => `${r.kind}:${r.id}`).sort();
    expect(roster).toEqual([`agent:${teamBotId}`, `user:${samId}`].sort());
    expect(JSON.stringify(samEvents)).not.toContain(alexMsg.id);
    expect(JSON.stringify(samEvents)).not.toContain("alex's private question");
    expect(JSON.stringify(samEvents)).not.toContain(alexId);
    expect(await mentionsFor(alexDm)).toHaveLength(1);

    // Neither reads the other's chat: hidden as 404.
    expect((await alex.request("GET", `/api/v1/conversations/${samDm}/messages`)).status).toBe(404);
    expect((await sam.request("GET", `/api/v1/conversations/${alexDm}/messages`)).status).toBe(404);
    expect((await admin.request("GET", `/api/v1/conversations/${samDm}/messages`)).status).toBe(404);
  });

  it("a disabled bot cannot be opened (409 bot_disabled); a missing bot is 404", async () => {
    const off = await teamBot("Sleeper");
    await ok(admin.request("PATCH", `/api/v1/agents/${off}`, { enabled: false }));
    const res = await sam.request("POST", `/api/v1/agents/${off}/dm`);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("bot_disabled");
    expect((await sam.request("POST", `/api/v1/agents/${randomUUID()}/dm`)).status).toBe(404);
  });

  it("a member denied bot.read does not see the bot (404)", async () => {
    const ruleId = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'user', $3, 'bot.read', 'deny')`,
      [ruleId, orgId, alexId],
    );
    try {
      const res = await alex.request("POST", `/api/v1/agents/${teamBotId}/dm`);
      expect(res.status).toBe(404);
    } finally {
      await su.query("delete from app.permission_rules where id = $1", [ruleId]);
    }
  });

  it("someone else's personal bot is hidden (404); its owner gets their existing DM", async () => {
    const created = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
    const personalId = created.agent.id as string;
    expect((await alex.request("POST", `/api/v1/agents/${personalId}/dm`)).status).toBe(404);
    expect((await admin.request("POST", `/api/v1/agents/${personalId}/dm`)).status).toBe(404);
    expect(await ok(sam.request("POST", `/api/v1/agents/${personalId}/dm`))).toEqual({
      dmId: created.dmId,
      created: false,
    });
  });
});
