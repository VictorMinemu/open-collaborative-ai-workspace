import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * CHAT-02 (04-08): channels belong to the organization or to a department, team or project (`conversations.unit_id`),
 * the list DTO carries the unit (path root → self) for the grouped sidebar, placement is limited to the caller's own
 * units (admins: any), and unit-scoped permission rules apply to that unit's channels (principle 6).
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
/** Standard role, member of Product. */
let sam: TestClient;
/** Developer, member of the Mobile team (under Product). */
let dana: TestClient;
/** Developer, member of Finance. */
let finn: TestClient;
let orgId: string;
let samId: string;
let danaId: string;
let finnId: string;
let product: string;
let mobile: string;
let finance: string;

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

const move = (as: TestClient, id: string, body: Json) => as.request("PATCH", `/api/v1/channels/${id}`, body);

async function invite(
  email: string,
  name: string,
  role: string,
): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id };
}

async function unit(kind: string, name: string, parentId: string | null): Promise<string> {
  return (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id;
}

const join = (unitId: string, userId: string) =>
  ok(admin.request("POST", `/api/v1/units/${unitId}/members`, { userId }));

const create = (as: TestClient, name: string, unitId?: string | null, visibility = "public") =>
  as.request("POST", "/api/v1/channels", {
    name,
    visibility,
    ...(unitId !== undefined ? { unitId } : {}),
  });

async function channelsOf(as: TestClient): Promise<Json> {
  return ok(as.request("GET", "/api/v1/channels"));
}

async function listed(as: TestClient, id: string): Promise<Json | undefined> {
  return ((await channelsOf(as)).channels as Json[]).find((c) => c.id === id);
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
  ({ client: sam, id: samId } = await invite("sam@example.test", "Sam Lee", "standard"));
  ({ client: dana, id: danaId } = await invite("dana@example.test", "Dana Cruz", "developer"));
  ({ client: finn, id: finnId } = await invite("finn@example.test", "Finn Hale", "developer"));

  product = await unit("department", "Product", null);
  mobile = await unit("team", "Mobile", product);
  finance = await unit("department", "Finance", null);
  await join(product, samId);
  await join(mobile, danaId);
  await join(finance, finnId);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("channel placement (CHAT-02, task 1)", () => {
  it("an admin creates #design in Product: the unit travels in the DTO and in every member's list", async () => {
    const design = await ok(create(admin, "design", product));
    expect(design.unit).toEqual({
      id: product,
      name: "Product",
      kind: "department",
      path: [product],
      pathNames: ["Product"],
    });
    const forSam = await listed(sam, design.id);
    expect(forSam).toMatchObject({ isMember: false, unit: design.unit });
    // Audited with the unit id (ids only).
    const rows = (
      await su.query(
        "select metadata from app.audit_events where action = 'channel.created' and resource_id = $1",
        [design.id],
      )
    ).rows;
    expect(rows[0]?.metadata).toEqual({ name: "design", visibility: "public", unitId: product });
  });

  it("a channel created without a unit, or with unitId null, belongs to the organization", async () => {
    const plain = await ok(create(admin, "random"));
    expect(plain.unit).toBeNull();
    const explicit = await ok(create(admin, "watercooler", null));
    expect(explicit.unit).toBeNull();
    expect((await listed(sam, plain.id))?.unit).toBeNull();
  });

  it("a team channel carries the path root → self", async () => {
    const dev = await ok(create(admin, "mobile-dev", mobile));
    expect(dev.unit).toEqual({
      id: mobile,
      name: "Mobile",
      kind: "team",
      path: [product, mobile],
      pathNames: ["Product", "Mobile"],
    });
  });

  it("a member places channels only on their own units' paths; admins anywhere", async () => {
    expect((await ok(create(dana, "mobile-standup", mobile))).unit.id).toBe(mobile);
    // An ancestor of the member's team is on its path.
    expect((await ok(create(dana, "product-ideas", product))).unit.id).toBe(product);
    const denied = await create(dana, "budget-talk", finance);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe("unit_not_allowed");
    // A Product member cannot place a channel in the Mobile team below it.
    const below = await create(sam, "sam-mobile", mobile);
    expect(below.status).toBe(403);
    expect(errorOf(below).code).toBe("unit_not_allowed");
    // Nothing was created by the refused calls.
    const names = (await su.query("select name from app.conversations where kind = 'channel'")).rows.map(
      (r) => r.name,
    );
    expect(names).not.toContain("budget-talk");
    expect(names).not.toContain("sam-mobile");
    // Admins (unit.manage) place anywhere.
    expect((await ok(create(admin, "finance-ops", finance))).unit.id).toBe(finance);
  });

  it("the list tells the caller which units are on their membership paths", async () => {
    expect([...(await channelsOf(dana)).memberUnitIds].sort()).toEqual([product, mobile].sort());
    expect((await channelsOf(sam)).memberUnitIds).toEqual([product]);
    expect((await channelsOf(admin)).memberUnitIds).toEqual([]);
  });

  it("unknown units and another organization's units are 404 unit_not_found", async () => {
    const unknown = await create(admin, "ghost", randomUUID());
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("unit_not_found");

    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    const foreign = randomUUID();
    await su.query(
      "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'department', 'Foreign', $3)",
      [foreign, orgB, [foreign]],
    );
    const cross = await create(admin, "cross-tenant", foreign);
    expect(cross.status).toBe(404);
    expect(errorOf(cross).code).toBe("unit_not_found");
    const crossMember = await create(dana, "cross-tenant-2", foreign);
    expect(crossMember.status).toBe(404);
  });

  it("deleting a unit leaves its channels in the organization (on delete set null)", async () => {
    const temp = await unit("department", "Temp", null);
    const ch = await ok(create(admin, "temp-room", temp));
    expect(ch.unit.id).toBe(temp);
    await ok(admin.request("DELETE", `/api/v1/units/${temp}`));
    expect((await listed(sam, ch.id))?.unit).toBeNull();
    expect((await ok(admin.request("GET", `/api/v1/channels/${ch.id}`))).unit).toBeNull();
  });

  it("GET /channels/:id carries the unit too", async () => {
    const ch = await ok(create(admin, "roadmap", product));
    expect((await ok(sam.request("GET", `/api/v1/channels/${ch.id}`))).unit).toMatchObject({
      id: product,
      path: [product],
    });
  });
});

describe("moving channels and unit-scoped rules (CHAT-02, task 2)", () => {
  it("the owner moves a channel: audit channel.updated {from, to}, conversation.updated on the channel and the list", async () => {
    const ledger = await ok(create(finn, "ledger"));
    expect(ledger.unit).toBeNull();
    expect(ledger.viewerCan).toContain("channel.update");
    const moved = await ok(move(finn, ledger.id, { unitId: finance }));
    expect(moved.unit).toMatchObject({ id: finance, name: "Finance", path: [finance] });
    expect((await listed(sam, ledger.id))?.unit?.id).toBe(finance);

    const rows = (
      await su.query(
        "select actor_id, metadata from app.audit_events where action = 'channel.updated' and resource_id = $1",
        [ledger.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: finnId });
    expect(rows[0]?.metadata).toEqual({ from: { unitId: null }, to: { unitId: finance } });
    expect(await events(`conv:${ledger.id}`, "conversation.updated")).toEqual([
      { conversationId: ledger.id, unitId: finance },
    ]);
    const listEvents = await events(`org:${orgId}`, "conversation.updated");
    expect(listEvents.at(-1)).toEqual({ conversationId: ledger.id });

    // Unchanged unit: no new audit row, no event.
    await ok(move(finn, ledger.id, { unitId: finance }));
    expect(
      (
        await su.query(
          "select 1 from app.audit_events where action = 'channel.updated' and resource_id = $1",
          [ledger.id],
        )
      ).rowCount,
    ).toBe(1);
    // The topic travels with the same route.
    expect((await ok(move(finn, ledger.id, { topic: "Month-end close" }))).topic).toBe("Month-end close");
  });

  it("a plain member gets 403 channel.update; an admin moves any channel; DMs and empty bodies are refused", async () => {
    const room = await ok(create(dana, "mobile-room", mobile));
    await ok(sam.request("POST", `/api/v1/channels/${room.id}/join`));
    expect((await listed(sam, room.id))?.viewerCan).not.toContain("channel.update");
    const denied = await move(sam, room.id, { unitId: product });
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details).toMatchObject({ permission: "channel.update" });
    expect((await listed(sam, room.id))?.unit?.id).toBe(mobile);

    // An admin who is not even a member moves it anywhere.
    expect((await ok(move(admin, room.id, { unitId: finance }))).unit.id).toBe(finance);
    // Back to the organization.
    expect((await ok(move(admin, room.id, { unitId: null }))).unit).toBeNull();

    const empty = await move(admin, room.id, {});
    expect(empty.status).toBe(400);
  });

  it("the owner may only move to units on their own paths (unit_not_allowed); unknown units 404", async () => {
    const standup = await ok(create(dana, "dana-standup", mobile));
    expect((await ok(move(dana, standup.id, { unitId: product }))).unit.id).toBe(product);
    const refused = await move(dana, standup.id, { unitId: finance });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("unit_not_allowed");
    const unknown = await move(dana, standup.id, { unitId: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("unit_not_found");
    expect((await listed(dana, standup.id))?.unit?.id).toBe(product);
  });

  it("a deny on channel.read scoped to Finance hides Finance channels from people outside it (list, 404, search)", async () => {
    const plans = await ok(create(admin, "plans"));
    await ok(sam.request("POST", `/api/v1/channels/${plans.id}/join`));
    await ok(finn.request("POST", `/api/v1/channels/${plans.id}/join`));
    await ok(
      admin.request("POST", `/api/v1/conversations/${plans.id}/messages`, { body: "quarzite forecast" }),
    );
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: finance,
        subjectKind: "role",
        subjectId: "standard",
        permission: "channel.read",
        effect: "deny",
      }),
    );
    expect(rule.scopeUnitId).toBe(finance);

    const searchFor = async (as: TestClient) =>
      ((await ok(as.request("GET", "/api/v1/search/messages?q=quarzite"))).hits as Json[]).map(
        (h) => h.conversation.id,
      );
    // In the organization the rule does not reach the channel.
    expect(await listed(sam, plans.id)).toBeTruthy();
    expect(await searchFor(sam)).toContain(plans.id);

    await ok(move(admin, plans.id, { unitId: finance }));
    // Sam (standard, Product) loses it everywhere; Finn (developer, Finance) keeps it.
    expect(await listed(sam, plans.id)).toBeUndefined();
    const hidden = await sam.request("GET", `/api/v1/channels/${plans.id}`);
    expect(hidden.status).toBe(404);
    expect((await sam.request("GET", `/api/v1/conversations/${plans.id}/messages`)).status).toBe(404);
    expect(await searchFor(sam)).not.toContain(plans.id);
    expect((await listed(finn, plans.id))?.unit?.id).toBe(finance);
    expect(await searchFor(finn)).toContain(plans.id);
    expect((await finn.request("GET", `/api/v1/channels/${plans.id}`)).status).toBe(200);

    // Moving it back restores access.
    await ok(move(admin, plans.id, { unitId: null }));
    expect(await listed(sam, plans.id)).toBeTruthy();
    expect(await searchFor(sam)).toContain(plans.id);
    await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
  });

  it("another organization's channel is 404", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'B', $2)", [
      orgB,
      `b-${orgB}`,
    ]);
    const foreign = randomUUID();
    await su.query(
      "insert into app.conversations (id, organization_id, kind, name, slug, visibility) values ($1, $2, 'channel', 'secret', 'secret', 'public')",
      [foreign, orgB],
    );
    const r = await move(admin, foreign, { unitId: null });
    expect(r.status).toBe(404);
    const row = (await su.query("select unit_id from app.conversations where id = $1", [foreign])).rows[0];
    expect(row?.unit_id).toBeNull();
  });
});
