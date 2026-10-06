import { randomUUID } from "node:crypto";
import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S, splitSnippet } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createConversationAccess } from "../chat";
import { loadDirectory } from "../chat/directory";
import { searchMessages } from "./service";

/**
 * CHAT-11 / D-04 (04-06): PostgreSQL full-text search over messages (and, Task 2, people and channels) on the
 * resolver's readable set only (P-03). Real PostgreSQL + Redis. Every user keeps under the 30/min search budget
 * (P-11) except the one the rate-limit test exhausts.
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let adminId: string;
let samId: string;
let orgB: string;
let userB: string;
const ids = {} as Record<
  | "engineering"
  | "board"
  | "samDm"
  | "samBot"
  | "orgBChannel"
  | "orgBMessage"
  | "migration"
  | "deploy"
  | "code"
  | "reply"
  | "deletedViaApi"
  | "deletedRaw"
  | "boardMessage"
  | "dmMessage",
  string
>;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const post = (as: TestClient, conv: string, body: string, extra: Json = {}) =>
  ok(as.request("POST", `/api/v1/conversations/${conv}/messages`, { body, ...extra }));

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]): [string, string] => [k, String(v)]),
  ).toString();

const search = (as: TestClient, params: Record<string, string | number | undefined>) =>
  ok(as.request("GET", `/api/v1/search/messages?${qs(params)}`));

const hitIds = (r: Json) => (r.hits as Json[]).map((h) => h.messageId as string);

async function joinAs(email: string, name: string, role: "developer" | "standard") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** A raw message row (bypasses the API: bot DMs, other orgs, rows with a past timestamp). */
async function rawMessage(p: {
  org: string;
  conv: string;
  authorKind: "user" | "agent";
  authorId: string;
  body: string;
  seq: number;
  createdAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await su.query(
    `insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
    [id, p.org, p.conv, p.seq, p.authorKind, p.authorId, p.body, p.createdAt ?? null],
  );
  return id;
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
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "developer");

  ids.engineering = (await ok(admin.request("POST", "/api/v1/channels", { name: "engineering" }))).id;
  await ok(sam.request("POST", `/api/v1/channels/${ids.engineering}/join`));
  ids.migration = (await post(admin, ids.engineering, "La migración de autenticación terminó")).id;
  ids.deploy = (await post(sam, ids.engineering, "We are deploying the API tonight")).id;
  ids.code = (await post(sam, ids.engineering, "Only call useEffect on mount")).id;
  ids.reply = (
    await post(sam, ids.engineering, "Respuesta en hilo: zanahoria lista", { threadRootId: ids.migration })
  ).id;
  ids.deletedViaApi = (await post(sam, ids.engineering, "zanahoria borrada por la autora")).id;
  await ok(sam.request("DELETE", `/api/v1/messages/${ids.deletedViaApi}`));
  // A deleted row that still has its body (defence in depth: `deleted_at` alone must hide it).
  ids.deletedRaw = (await post(sam, ids.engineering, "zanahoria con cuerpo pero borrada")).id;
  await su.query("update app.messages set deleted_at = now() where id = $1", [ids.deletedRaw]);

  // Sam's private channel: the admin is not a member.
  ids.board = (
    await ok(sam.request("POST", "/api/v1/channels", { name: "board", visibility: "private" }))
  ).id;
  ids.boardMessage = (await post(sam, ids.board, "Migración de autenticación del board, confidencial")).id;

  // Sam's personal bot and their DM (Phase 3.1 shape), messages written directly.
  ids.samBot = randomUUID();
  ids.samDm = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
     values ($1, $2, 'Sam Helper', 'sam-helper', 'x', 'mock', 'mock-1', 'ready', 'personal', $3)`,
    [ids.samBot, orgId, samId],
  );
  await su.query(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key, created_by) values ($1, $2, 'dm', 'private', $3, $4)",
    [ids.samDm, orgId, `agent:${ids.samBot}|user:${samId}`, samId],
  );
  await su.query(
    `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
     values ($1, $2, 'user', $3, 'owner'), ($1, $2, 'agent', $4, 'member')`,
    [ids.samDm, orgId, samId, ids.samBot],
  );
  ids.dmMessage = await rawMessage({
    org: orgId,
    conv: ids.samDm,
    authorKind: "agent",
    authorId: ids.samBot,
    body: "Nota privada: la migración de autenticación de Sam",
    seq: 1,
  });

  // Organization B with the identical text in a public channel.
  orgB = randomUUID();
  userB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("insert into auth.user (id, name, email) values ($1, 'Víctor Evil', $2)", [
    userB,
    `${userB}@evil.test`,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Víctor Evil', 'admin')",
    [orgB, userB],
  );
  ids.orgBChannel = randomUUID();
  await su.query(
    "insert into app.conversations (id, organization_id, kind, name, slug, visibility, created_by) values ($1, $2, 'channel', 'engineering', 'engineering', 'public', $3)",
    [ids.orgBChannel, orgB, userB],
  );
  ids.orgBMessage = await rawMessage({
    org: orgB,
    conv: ids.orgBChannel,
    authorKind: "user",
    authorId: userB,
    body: "La migración de autenticación terminó",
    seq: 1,
  });
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("GET /search/messages (CHAT-11, D-04)", () => {
  it("finds a Spanish message without accents and with them, newest first, with a marked snippet", async () => {
    const r = await search(sam, { q: "migracion autenticacion" });
    // Sam reads the channel, the private board and their bot DM: three hits, newest first.
    expect(hitIds(r)).toEqual([ids.dmMessage, ids.boardMessage, ids.migration]);
    const times = (r.hits as Json[]).map((h) => Date.parse(h.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const hit = (r.hits as Json[]).find((h) => h.messageId === ids.migration) as Json;
    expect(hit.snippet).toContain(`${S}migración${E}`);
    expect(hit.snippet).toContain(`${S}autenticación${E}`);
    expect(
      splitSnippet(hit.snippet)
        .filter((p) => p.mark)
        .map((p) => p.text),
    ).toEqual(["migración", "autenticación"]);
    expect(hit.conversation).toMatchObject({
      id: ids.engineering,
      kind: "channel",
      name: "engineering",
      label: "#engineering",
      visibility: "public",
      archived: false,
    });
    expect(hit.author).toMatchObject({ kind: "user", id: adminId, displayName: "Víctor Ruiz" });
    expect(hit.threadRootId).toBeNull();
    expect(hit.seq).toEqual(expect.any(Number));
    expect(r.nextCursor).toBeNull();

    const accented = await search(sam, { q: "Migración" });
    expect(hitIds(accented)).toContain(ids.migration);
    // The DM hit is labelled with the counterpart and authored by the bot.
    const dm = (accented.hits as Json[]).find((h) => h.messageId === ids.dmMessage) as Json;
    expect(dm.conversation).toMatchObject({ id: ids.samDm, kind: "dm", label: "Sam Helper" });
    expect(dm.author).toMatchObject({ kind: "agent", id: ids.samBot, displayName: "Sam Helper" });
  });

  it("stems English and keeps code identifiers", async () => {
    const deployed = await search(sam, { q: "deployed" });
    expect(hitIds(deployed)).toEqual([ids.deploy]);
    expect((deployed.hits as Json[])[0]?.snippet).toContain(`${S}deploying${E}`);
    const code = await search(sam, { q: "useEffect" });
    expect(hitIds(code)).toEqual([ids.code]);
    expect((code.hits as Json[])[0]?.snippet).toContain(`${S}useEffect${E}`);
  });

  it("returns thread replies with their root and never deleted messages", async () => {
    const r = await search(sam, { q: "zanahoria" });
    expect(hitIds(r)).toEqual([ids.reply]);
    expect((r.hits as Json[])[0]).toMatchObject({ threadRootId: ids.migration });
  });

  it("an admin who is not in a private channel or a DM gets no hits from them; org B never appears", async () => {
    const r = await search(admin, { q: "migracion autenticacion" });
    expect(hitIds(r)).toEqual([ids.migration]);
    for (const h of r.hits as Json[]) {
      expect([ids.board, ids.samDm, ids.orgBChannel]).not.toContain(h.conversation.id);
    }
    expect(JSON.stringify(r)).not.toContain("confidencial");
    expect(JSON.stringify(r)).not.toContain("Nota privada");
  });

  it("an unreadable or unknown `in` filter answers an empty result, never 404 (no existence oracle)", async () => {
    for (const conv of [ids.board, ids.samDm, ids.orgBChannel, randomUUID()]) {
      const r = await search(admin, { q: "migracion", in: conv });
      expect(r).toEqual({ hits: [], nextCursor: null });
    }
    // The member sees the same filter work.
    expect(hitIds(await search(sam, { q: "migracion", in: ids.board }))).toEqual([ids.boardMessage]);
  });

  it("never errors on websearch syntax edge cases", async () => {
    for (const q of ['"unterminated', "-", "!!", "'", "or", '" -"', "a & b | c", "(((", "<->"]) {
      const res = await admin.request("GET", `/api/v1/search/messages?${qs({ q })}`);
      expect(res.status, q).toBe(200);
      expect(res.body).toMatchObject({ hits: expect.any(Array) });
    }
  });

  it("validates the query and requires a session", async () => {
    expect((await admin.request("GET", "/api/v1/search/messages?q=")).status).toBe(400);
    expect((await admin.request("GET", `/api/v1/search/messages?${qs({ q: "x".repeat(201) })}`)).status).toBe(
      400,
    );
    expect(
      (await new TestClient(stack.baseUrl).request("GET", "/api/v1/search/messages?q=migracion")).status,
    ).toBe(401);
  });

  it("the overview carries message hits", async () => {
    const r = await ok(sam.request("GET", `/api/v1/search?${qs({ q: "migracion" })}`));
    expect((r.messages as Json[]).map((h) => h.messageId)).toEqual([
      ids.dmMessage,
      ids.boardMessage,
      ids.migration,
    ]);
    expect(r).toMatchObject({ people: expect.any(Array), channels: expect.any(Array) });
  });

  it("RLS: org A's readable ids searched from org B's tenant find nothing, and vice versa", async () => {
    const db = stack.built.core.db;
    const access = createConversationAccess(stack.built.core);
    const readableA = await db.withTenant({ organizationId: orgId, userId: samId }, (tx) =>
      access.readableIds(tx, samId, { includeArchived: true }),
    );
    const fromB = await db.withTenant({ organizationId: orgB, userId: userB }, async (tx) =>
      searchMessages(tx, {
        readableIds: [...readableA, ids.orgBChannel],
        q: "migracion",
        limit: 20,
        dir: await loadDirectory(tx),
        viewerId: userB,
      }),
    );
    // Only org B's own row, never one of org A's.
    expect(fromB.hits.map((h) => h.messageId)).toEqual([ids.orgBMessage]);
    const fromA = await db.withTenant({ organizationId: orgId, userId: samId }, async (tx) =>
      searchMessages(tx, {
        readableIds: [ids.orgBChannel],
        q: "migracion",
        limit: 20,
        dir: await loadDirectory(tx),
        viewerId: samId,
      }),
    );
    expect(fromA.hits).toEqual([]);
  });
});
