import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { type ConversationAccess, createConversationAccess } from "./index";

/**
 * P-03: `createConversationAccess` is the one readable-set authority. Real PostgreSQL + Redis; every id is
 * decided by the permission resolver, and another organization's ids never appear.
 */

let stack: TestStack;
let su: pg.Client;
let access: ConversationAccess;
let orgId: string;
let adminId: string;
let samId: string;
const ids = {} as Record<
  "general" | "samPublic" | "adminPrivate" | "samPrivate" | "archived" | "samDm",
  string
>;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A request-shaped object for the resolver (only `auth` is read). */
const reqAs = (userId: string, organizationId = orgId) =>
  ({
    auth: { userId, organizationId, sessionId: randomUUID(), clientKind: "web", name: "x", email: "x@x" },
  }) as unknown as FastifyRequest;

const inOrg = <T>(userId: string, fn: Parameters<TestStack["built"]["core"]["db"]["withTenant"]>[1]) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId }, fn) as Promise<T>;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  access = createConversationAccess(stack.built.core);

  const admin = new TestClient(stack.baseUrl);
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
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "standard" }),
  );
  const sam = new TestClient(stack.baseUrl);
  samId = (
    await ok(
      sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Sam Lee",
        password: "another-long-password",
      }),
    )
  ).user.id;

  ids.general = (await ok(admin.request("GET", "/api/v1/channels"))).channels[0].id;
  // A public channel the admin never joins (created by Sam).
  ids.samPublic = (await ok(sam.request("POST", "/api/v1/channels", { name: "sams-room" }))).id;
  ids.adminPrivate = (
    await ok(admin.request("POST", "/api/v1/channels", { name: "board", visibility: "private" }))
  ).id;
  ids.samPrivate = (
    await ok(sam.request("POST", "/api/v1/channels", { name: "sams-secret", visibility: "private" }))
  ).id;
  ids.archived = (await ok(admin.request("POST", "/api/v1/channels", { name: "old" }))).id;
  await ok(admin.request("POST", `/api/v1/channels/${ids.archived}/archive`));

  // Sam's private chat with a team bot (Phase 3.1 shape).
  const bot = randomUUID();
  ids.samDm = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [bot, orgId],
  );
  await su.query(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key, created_by) values ($1, $2, 'dm', 'private', $3, $4)",
    [ids.samDm, orgId, `agent:${bot}|user:${samId}`, samId],
  );
  await su.query(
    `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
     values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
    [ids.samDm, orgId, samId, bot],
  );
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("createConversationAccess (P-03)", () => {
  it("readableIds(admin): public channels joined or not, own private ones; never others' private channels or DMs", async () => {
    const got = await inOrg<string[]>(adminId, (tx) => access.readableIds(tx, adminId));
    expect(got).toEqual(expect.arrayContaining([ids.general, ids.samPublic, ids.adminPrivate]));
    expect(got).not.toContain(ids.samPrivate);
    expect(got).not.toContain(ids.samDm);
    expect(got).not.toContain(ids.archived);
  });

  it("readableIds(sam) includes Sam's bot DM and Sam's private channel", async () => {
    const got = await inOrg<string[]>(samId, (tx) => access.readableIds(tx, samId));
    expect(got).toEqual(expect.arrayContaining([ids.general, ids.samPublic, ids.samPrivate, ids.samDm]));
    expect(got).not.toContain(ids.adminPrivate);
    const dmsOnly = await inOrg<string[]>(samId, (tx) => access.readableIds(tx, samId, { kinds: ["dm"] }));
    expect(dmsOnly).toEqual([ids.samDm]);
  });

  it("archived conversations only with includeArchived", async () => {
    const withArchived = await inOrg<string[]>(adminId, (tx) =>
      access.readableIds(tx, adminId, { includeArchived: true }),
    );
    expect(withArchived).toContain(ids.archived);
  });

  it("readable() throws a bare 404 for hidden and missing ids; isReadable agrees with readable", async () => {
    const cases: Array<[string, string, boolean]> = [
      [adminId, ids.general, true],
      [adminId, ids.samPublic, true],
      [adminId, ids.adminPrivate, true],
      [adminId, ids.samPrivate, false],
      [adminId, ids.samDm, false],
      [adminId, ids.archived, true],
      [samId, ids.samDm, true],
      [samId, ids.adminPrivate, false],
      [adminId, randomUUID(), false],
    ];
    for (const [user, conv, expected] of cases) {
      const can = await inOrg<boolean>(user, (tx) => access.isReadable(tx, user, conv));
      expect(can, `${user === adminId ? "admin" : "sam"} isReadable ${conv}`).toBe(expected);
      const res = await inOrg<unknown>(user, (tx) => access.readable(reqAs(user), tx, conv)).then(
        () => "ok",
        (err: { statusCode?: number; details?: unknown }) => err,
      );
      if (expected) expect(res).toBe("ok");
      else expect(res).toMatchObject({ statusCode: 404, details: undefined });
    }
  });

  it("another organization never sees these ids", async () => {
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
    const ctxB = { organizationId: orgB, userId: userB };
    const db = stack.built.core.db;
    expect(
      await db.withTenant(ctxB, (tx) => access.readableIds(tx, userB, { includeArchived: true })),
    ).toEqual([]);
    for (const conv of Object.values(ids)) {
      expect(await db.withTenant(ctxB, (tx) => access.isReadable(tx, userB, conv))).toBe(false);
      await expect(
        db.withTenant(ctxB, (tx) => access.readable(reqAs(userB, orgB), tx, conv)),
      ).rejects.toMatchObject({
        statusCode: 404,
      });
    }
  });
});
