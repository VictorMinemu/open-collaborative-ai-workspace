import { randomUUID } from "node:crypto";
import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S, splitSnippet } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { createConversationAccess } from "../chat";
import { loadDirectory } from "../chat/directory";
import { searchChannels, searchMessages, searchPeople } from "./service";

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
  | "dmMessage"
  | "teamBot"
  | "oldOps"
  | "oldOpsMessage"
  | "pickles"
  | "radishOld"
  | "radishMid"
  | "radishNew",
  string
>;
let pager: TestClient;
let rita: TestClient;
let danaId: string;
/** The 45 "pepino" messages, newest first (created in one statement: equal timestamps, id breaks ties). */
let cucumbers: string[] = [];

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

async function joinAs(email: string, name: string, role: "developer" | "standard" | "admin") {
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

  // ---- Task 2 fixtures
  ids.teamBot = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [ids.teamBot, orgId],
  );
  // A bot of organization B with a matching name.
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
     values ($1, $2, 'Archie', 'archie', 'x', 'mock', 'mock-1', 'ready')`,
    [randomUUID(), orgB],
  );
  [, danaId] = await joinAs("dana@example.test", "Dana Deactivated", "standard");
  await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [danaId]);
  [pager] = await joinAs("pager@example.test", "Paula Pager", "standard");
  [rita] = await joinAs("rita@example.test", "Rita Rate", "standard");

  ids.oldOps = (await ok(admin.request("POST", "/api/v1/channels", { name: "old-ops" }))).id;
  ids.oldOpsMessage = (await post(admin, ids.oldOps, "El nabo archivado")).id;
  await ok(admin.request("POST", `/api/v1/channels/${ids.oldOps}/archive`));

  ids.radishOld = await rawMessage({
    org: orgId,
    conv: ids.engineering,
    authorKind: "user",
    authorId: adminId,
    body: "rábano antiguo",
    seq: 9001,
    createdAt: "2026-01-10T12:00:00Z",
  });
  ids.radishMid = await rawMessage({
    org: orgId,
    conv: ids.engineering,
    authorKind: "user",
    authorId: adminId,
    body: "rábano medio",
    seq: 9002,
    createdAt: "2026-03-15T23:30:00Z",
  });
  ids.radishNew = await rawMessage({
    org: orgId,
    conv: ids.engineering,
    authorKind: "user",
    authorId: adminId,
    body: "rábano reciente",
    seq: 9003,
  });

  ids.pickles = (
    await ok(admin.request("POST", "/api/v1/channels", { name: "pickles", topic: "Fermentation" }))
  ).id;
  const inserted = await su.query(
    `insert into app.messages (organization_id, conversation_id, seq, author_kind, author_id, body)
     select $1, $2, 10000 + n, 'user', $3, 'pepino número ' || n from generate_series(1, 45) n
     returning id`,
    [orgId, ids.pickles, adminId],
  );
  cucumbers = (inserted.rows as Array<{ id: string }>).map((r) => r.id).sort((a, b) => b.localeCompare(a));
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
    // A short message is shown whole, the stemmed match marked.
    expect((deployed.hits as Json[])[0]?.snippet).toBe(`We are ${S}deploying${E} the API tonight`);
    const code = await search(sam, { q: "useEffect" });
    expect(hitIds(code)).toEqual([ids.code]);
    expect((code.hits as Json[])[0]?.snippet).toContain(`${S}useEffect${E}`);
  });

  it("long messages get one fragment around the match; markers typed by users never become marks", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(" ");
    const long = (await post(sam, ids.engineering, `${filler} berenjena ${filler}`)).id;
    const r = await search(sam, { q: "berenjena" });
    expect(hitIds(r)).toEqual([long]);
    const snippet = (r.hits as Json[])[0]?.snippet as string;
    expect(snippet.length).toBeLessThanOrEqual(400);
    expect(snippet).toContain(`${S}berenjena${E}`);
    expect(snippet.split(" ").length).toBeLessThanOrEqual(20);

    const forged = (await post(sam, ids.engineering, `${S}falso${E} pimiento rojo`)).id;
    const f = await search(sam, { q: "pimiento" });
    expect(hitIds(f)).toEqual([forged]);
    const parts = splitSnippet((f.hits as Json[])[0]?.snippet as string);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["pimiento"]);
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

describe("filters and paging (CHAT-11)", () => {
  it("`in` limits hits to one readable conversation", async () => {
    expect(hitIds(await search(sam, { q: "migracion", in: ids.engineering }))).toEqual([ids.migration]);
    expect(hitIds(await search(sam, { q: "migracion", in: ids.samDm }))).toEqual([ids.dmMessage]);
  });

  it("`from` limits hits to one author, people and bots alike", async () => {
    expect(hitIds(await search(sam, { q: "migracion", from: adminId }))).toEqual([ids.migration]);
    expect(hitIds(await search(sam, { q: "migracion", from: ids.samBot }))).toEqual([ids.dmMessage]);
    expect(hitIds(await search(sam, { q: "zanahoria", from: samId }))).toEqual([ids.reply]);
    expect(hitIds(await search(sam, { q: "zanahoria", from: adminId }))).toEqual([]);
  });

  it("`after` / `before` are inclusive UTC days", async () => {
    expect(hitIds(await search(admin, { q: "rabano", after: "2026-03-01" }))).toEqual([
      ids.radishNew,
      ids.radishMid,
    ]);
    expect(hitIds(await search(admin, { q: "rabano", before: "2026-03-15" }))).toEqual([
      ids.radishMid,
      ids.radishOld,
    ]);
    expect(hitIds(await search(admin, { q: "rabano", after: "2026-03-15", before: "2026-03-15" }))).toEqual([
      ids.radishMid,
    ]);
    expect(
      (await admin.request("GET", `/api/v1/search/messages?${qs({ q: "rabano", after: "15/03" })}`)).status,
    ).toBe(400);
  });

  it("45 hits page as 20 / 20 / 5 with an opaque cursor, no duplicates, nextCursor null at the end", async () => {
    const p1 = await search(pager, { q: "pepino" });
    const p2 = await search(pager, { q: "pepino", cursor: p1.nextCursor });
    const p3 = await search(pager, { q: "pepino", cursor: p2.nextCursor });
    expect([p1.hits.length, p2.hits.length, p3.hits.length]).toEqual([20, 20, 5]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    expect(p2.nextCursor).toEqual(expect.any(String));
    expect(p3.nextCursor).toBeNull();
    const all = [...hitIds(p1), ...hitIds(p2), ...hitIds(p3)];
    expect(new Set(all).size).toBe(45);
    // Equal timestamps: the id breaks the tie, newest-first order is stable across pages.
    expect(all).toEqual(cucumbers);
    expect(
      (await pager.request("GET", `/api/v1/search/messages?${qs({ q: "pepino", cursor: "not-a-cursor" })}`))
        .status,
    ).toBe(400);
  });

  it("an archived channel's hit carries archived: true", async () => {
    const r = await search(admin, { q: "nabo" });
    expect(hitIds(r)).toEqual([ids.oldOpsMessage]);
    expect((r.hits as Json[])[0]?.conversation).toMatchObject({
      id: ids.oldOps,
      label: "#old-ops",
      archived: true,
    });
  });
});

describe("GET /search/people", () => {
  const people = async (as: TestClient, q: string) =>
    (await ok(as.request("GET", `/api/v1/search/people?${qs({ q })}`))).people as Json[];

  it("finds members without accents by prefix, never deactivated members or another org's people", async () => {
    const r = await people(sam, "vict");
    expect(r[0]).toMatchObject({
      kind: "user",
      id: adminId,
      displayName: "Víctor Ruiz",
      handle: expect.any(String),
    });
    expect(r.map((p) => p.id)).not.toContain(userB);
    expect(JSON.stringify(r)).not.toContain("Evil");
    expect(await people(admin, "dana")).toEqual([]);
    expect((await people(admin, "sam lee")).map((p) => p.id)).toContain(samId);
  });

  it("team bots for everyone; a personal bot only for its owner", async () => {
    const forAdmin = await people(admin, "archi");
    expect(forAdmin).toEqual([expect.objectContaining({ kind: "agent", id: ids.teamBot, handle: "archie" })]);
    expect(await people(admin, "helper")).toEqual([]);
    expect(await people(sam, "helper")).toEqual([
      expect.objectContaining({ kind: "agent", id: ids.samBot, displayName: "Sam Helper" }),
    ]);
  });

  it("fuzzy matches survive a typo", async () => {
    expect((await people(admin, "Rutz")).map((p) => p.id)).toContain(adminId);
  });
});

describe("GET /search/channels", () => {
  const channels = async (as: TestClient, q: string) =>
    (await ok(as.request("GET", `/api/v1/search/channels?${qs({ q })}`))).channels as Json[];

  it("a typo still finds #engineering (only this org's)", async () => {
    const r = await channels(admin, "enginering");
    expect(r.map((c) => c.id)).toEqual([ids.engineering]);
    expect(r[0]).toMatchObject({
      name: "engineering",
      visibility: "public",
      isMember: true,
      archived: false,
    });
    expect(r[0]?.memberCount).toBeGreaterThanOrEqual(2);
  });

  it("never returns a private channel the caller cannot read; flags archived channels; matches topics", async () => {
    expect(await channels(admin, "board")).toEqual([]);
    expect(await channels(sam, "board")).toEqual([
      expect.objectContaining({ id: ids.board, visibility: "private", isMember: true }),
    ]);
    expect(await channels(admin, "old-ops")).toEqual([
      expect.objectContaining({ id: ids.oldOps, archived: true }),
    ]);
    expect((await channels(admin, "fermentation")).map((c) => c.id)).toEqual([ids.pickles]);
  });
});

describe("overview, tenancy and rate limit", () => {
  it("the overview fills people and channels (≤ 5 each)", async () => {
    const r = await ok(admin.request("GET", `/api/v1/search?${qs({ q: "engineering" })}`));
    expect((r.channels as Json[]).map((c) => c.id)).toEqual([ids.engineering]);
    const p = await ok(admin.request("GET", `/api/v1/search?${qs({ q: "archie" })}`));
    expect((p.people as Json[]).map((x) => x.id)).toEqual([ids.teamBot]);
    for (const k of ["messages", "people", "channels"])
      expect((r[k] as Json[]).length).toBeLessThanOrEqual(5);
  });

  it("people and channels from org B's tenant never include org A rows", async () => {
    const db = stack.built.core.db;
    const access = createConversationAccess(stack.built.core);
    const readableA = await db.withTenant({ organizationId: orgId, userId: adminId }, (tx) =>
      access.readableIds(tx, adminId, { includeArchived: true }),
    );
    const fromB = await db.withTenant({ organizationId: orgB, userId: userB }, async (tx) => ({
      people: await searchPeople(tx, { viewerId: userB, q: "vict", limit: 20, dir: await loadDirectory(tx) }),
      channels: await searchChannels(tx, {
        readableIds: [...readableA, ids.orgBChannel],
        viewerId: userB,
        q: "engineering",
        limit: 20,
      }),
    }));
    expect(fromB.people.map((p) => p.id)).toEqual([userB]);
    expect(fromB.channels.map((c) => c.id)).toEqual([ids.orgBChannel]);
  });

  it("the 31st search request within a minute by one user answers 429; other users are unaffected", async () => {
    const routes = [
      "/api/v1/search",
      "/api/v1/search/messages",
      "/api/v1/search/people",
      "/api/v1/search/channels",
    ];
    for (let i = 0; i < 30; i++) {
      const res = await rita.request("GET", `${routes[i % routes.length]}?${qs({ q: `probe ${i}` })}`);
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const limited = await rita.request("GET", `/api/v1/search/people?${qs({ q: "probe" })}`);
    expect(limited.status).toBe(429);
    expect((await pager.request("GET", `/api/v1/search?${qs({ q: "probe" })}`)).status).toBe(200);
  });
});

describe("AI chats are found by their owner alone (05-10, AICHAT-04, P-03, Pitfall 6)", () => {
  let olive: TestClient;
  let oliveId: string;
  let alex: TestClient;
  let alexId: string;
  let ada: TestClient;
  const ai = {} as Record<"chat" | "archived" | "question" | "answer" | "archivedLine", string>;

  /** An AI chat of Olive's (P-03 shape: private, one owner member, an ai_chats row). */
  async function aiChat(name: string, archived: boolean): Promise<string> {
    const id = randomUUID();
    await su.query(
      `insert into app.conversations (id, organization_id, kind, visibility, name, created_by, archived_at)
       values ($1, $2, 'ai_chat', 'private', $3, $4, ${archived ? "now()" : "null"})`,
      [id, orgId, name, oliveId],
    );
    await su.query(
      `insert into app.conversation_members (conversation_id, organization_id, member_kind, member_id, role)
       values ($1, $2, 'user', $3, 'owner')`,
      [id, orgId, oliveId],
    );
    await su.query(
      `insert into app.ai_chats (conversation_id, organization_id, owner_user_id, title_source, last_model)
       values ($1, $2, $3, 'auto', $4)`,
      [id, orgId, oliveId, { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" }],
    );
    return id;
  }

  beforeAll(async () => {
    [olive, oliveId] = await joinAs("olive@example.test", "Olive Owner", "standard");
    [alex, alexId] = await joinAs("alex@example.test", "Alex Other", "standard");
    [ada] = await joinAs("ada@example.test", "Ada Admin", "admin");
    ai.chat = await aiChat("Quarterly kumquat roadmap", false);
    ai.archived = await aiChat("Old kumquat notes", true);
    ai.question = await rawMessage({
      org: orgId,
      conv: ai.chat,
      authorKind: "user",
      authorId: oliveId,
      body: "Where do kumquats grow best?",
      seq: 1,
    });
    ai.answer = randomUUID();
    await su.query(
      `insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, status)
       values ($1, $2, $3, 2, 'agent', null, 'Kumquats grow best in warm, sunny climates', 'completed')`,
      [ai.answer, orgId, ai.chat],
    );
    await su.query(
      `insert into app.ai_generations (organization_id, conversation_id, user_message_id, assistant_message_id,
         requester_user_id, backend, provider, model_id, attempt, status, instance_id, finished_at)
       values ($1, $2, $3, $4, $5, 'org_key', 'anthropic', 'claude-sonnet-5-5', 1, 'completed', 'test', now())`,
      [orgId, ai.chat, ai.question, ai.answer, oliveId],
    );
    ai.archivedLine = await rawMessage({
      org: orgId,
      conv: ai.archived,
      authorKind: "user",
      authorId: oliveId,
      body: "A kumquat line in an archived chat",
      seq: 1,
    });
  });

  it("the owner's message search finds both turns, labelled with the chat title; the answer is by the model", async () => {
    const r = await search(olive, { q: "kumquats" });
    expect(hitIds(r)).toEqual(expect.arrayContaining([ai.question, ai.answer, ai.archivedLine]));
    const answer = (r.hits as Json[]).find((h) => h.messageId === ai.answer) as Json;
    expect(answer.conversation).toMatchObject({
      id: ai.chat,
      kind: "ai_chat",
      label: "Quarterly kumquat roadmap",
      archived: false,
    });
    expect(answer.author).toEqual({
      kind: "agent",
      id: null,
      displayName: "Claude Sonnet 5.5",
      avatarUrl: null,
    });
    const question = (r.hits as Json[]).find((h) => h.messageId === ai.question) as Json;
    expect(question.author).toMatchObject({ kind: "user", id: oliveId, displayName: "Olive Owner" });
    // Archived AI chats are found, like archived channels, and flagged.
    const archived = (r.hits as Json[]).find((h) => h.messageId === ai.archivedLine) as Json;
    expect(archived.conversation).toMatchObject({ id: ai.archived, kind: "ai_chat", archived: true });
    // `in` narrows to one AI chat.
    expect(hitIds(await search(olive, { q: "kumquats", in: ai.chat })).sort()).toEqual(
      [ai.question, ai.answer].sort(),
    );
  });

  it("the overview lists the owner's AI chats by title (trigram, archived flagged)", async () => {
    const r = await ok(olive.request("GET", `/api/v1/search?${qs({ q: "kumquat" })}`));
    const chats = r.aiChats as Json[];
    expect(chats.map((c) => c.id)).toEqual([ai.chat, ai.archived]);
    expect(chats[0]).toMatchObject({
      id: ai.chat,
      title: "Quarterly kumquat roadmap",
      archived: false,
      lastModelLabel: "Claude Sonnet 5.5",
    });
    expect(chats[1]).toMatchObject({ id: ai.archived, archived: true });
    // A typo still finds it.
    const typo = await ok(olive.request("GET", `/api/v1/search?${qs({ q: "kumqat roadmap" })}`));
    expect((typo.aiChats as Json[]).map((c) => c.id)).toContain(ai.chat);
  });

  it("another member and an admin never see an AI chat hit, entry or title", async () => {
    for (const as of [alex, ada]) {
      const messages = await search(as, { q: "kumquats" });
      expect(messages.hits).toEqual([]);
      const scoped = await search(as, { q: "kumquats", in: ai.chat });
      expect(scoped.hits).toEqual([]);
      const overview = await ok(as.request("GET", `/api/v1/search?${qs({ q: "kumquat" })}`));
      expect(overview.aiChats ?? []).toEqual([]);
      expect(overview.messages).toEqual([]);
      const text = JSON.stringify([messages, scoped, overview]);
      expect(text).not.toContain("Quarterly kumquat roadmap");
      expect(text).not.toContain("Old kumquat notes");
      // Channels search never surfaces an AI chat either.
      const channels = await ok(as.request("GET", `/api/v1/search/channels?${qs({ q: "kumquat" })}`));
      expect(channels.channels).toEqual([]);
    }
  });

  it("existing results stay as they were: Sam's overview has no AI chats and the same message hits", async () => {
    const r = await ok(sam.request("GET", `/api/v1/search?${qs({ q: "migracion" })}`));
    expect((r.messages as Json[]).map((h) => h.messageId)).toEqual([
      ids.dmMessage,
      ids.boardMessage,
      ids.migration,
    ]);
    expect(r.aiChats ?? []).toEqual([]);
  });

  describe("search follows grants (06-04, P-03): grantees find a shared chat and its messages; nobody else does", () => {
    let review: string;
    let reviewLine: string;
    let outsider: TestClient;
    let grantId: string;

    beforeAll(async () => {
      [outsider] = await joinAs("nia@example.test", "Nia Nogrant", "standard");
      review = await aiChat("Architecture review", false);
      reviewLine = await rawMessage({
        org: orgId,
        conv: review,
        authorKind: "user",
        authorId: oliveId,
        body: "The quokka ledger needs event sourcing",
        seq: 1,
      });
      // The stream knows the raw row's seq, so the grant's notice line takes the next one.
      await su.query("insert into app.streams (id, organization_id, last_seq) values ($1, $2, 1)", [
        `conv:${review}`,
        orgId,
      ]);
      const g = await ok(
        olive.request("POST", `/api/v1/ai-chats/${review}/grants`, {
          subject: { kind: "user", id: alexId },
          level: "chat",
        }),
        201,
      );
      grantId = g.id;
    });

    it("Alex (chat grantee) finds the chat by title, with access chat and the owner, and its messages", async () => {
      const overview = await ok(alex.request("GET", `/api/v1/search?${qs({ q: "architecture review" })}`));
      expect(overview.aiChats).toEqual([
        expect.objectContaining({
          id: review,
          title: "Architecture review",
          access: "chat",
          shared: true,
          owner: expect.objectContaining({ kind: "user", id: oliveId, displayName: "Olive Owner" }),
        }),
      ]);
      const r = await search(alex, { q: "quokka" });
      expect(hitIds(r)).toEqual([reviewLine]);
      expect((r.hits as Json[])[0]!.conversation).toMatchObject({
        id: review,
        kind: "ai_chat",
        label: "Architecture review",
      });
    });

    it("the owner's results are unchanged (access owner); a member without a grant and the admin find nothing", async () => {
      const mine = await ok(olive.request("GET", `/api/v1/search?${qs({ q: "architecture review" })}`));
      expect(mine.aiChats).toEqual([expect.objectContaining({ id: review, access: "owner", shared: true })]);
      for (const as of [outsider, ada]) {
        const overview = await ok(as.request("GET", `/api/v1/search?${qs({ q: "architecture review" })}`));
        expect(overview.aiChats ?? []).toEqual([]);
        expect((await search(as, { q: "quokka" })).hits).toEqual([]);
        expect(JSON.stringify(overview)).not.toContain("Architecture review");
      }
    });

    it("after the grant is revoked Alex finds neither the chat nor its messages", async () => {
      expect((await olive.request("DELETE", `/api/v1/ai-chats/${review}/grants/${grantId}`)).status).toBe(
        204,
      );
      const overview = await ok(alex.request("GET", `/api/v1/search?${qs({ q: "architecture review" })}`));
      expect(overview.aiChats ?? []).toEqual([]);
      expect((await search(alex, { q: "quokka" })).hits).toEqual([]);
    });
  });
});

describe("board cards are found by their text, within the readable set (07.1-06, BOARD-05, Pitfall 5)", () => {
  let bea: TestClient;
  let pumps: string;
  let privateBoard: string;
  let pumpCard: Json;
  let acmeCard: Json;
  let secretCard: Json;

  const card = (as: TestClient, boardId: string, body: Json) =>
    ok(as.request("POST", `/api/v1/boards/${boardId}/cards`, { clientMessageId: randomUUID(), ...body }));

  beforeAll(async () => {
    [bea] = await joinAs("bea@example.test", "Bea Board", "developer");
    pumps = (await ok(admin.request("POST", "/api/v1/channels", { name: "pump-cases", layout: "board" }))).id;
    await ok(bea.request("POST", `/api/v1/channels/${pumps}/join`));
    // The board's fields as a template would set them (07.1-07 fills this row; the search needs only the body).
    await su.query("update app.boards set fields = $1::jsonb where conversation_id = $2", [
      JSON.stringify([{ key: "customer", label: "Customer", type: "text", required: false }]),
      pumps,
    ]);
    pumpCard = await card(admin, pumps, {
      title: "Broken pump",
      description: "Pump 3 leaks near the gasket",
    });
    acmeCard = await card(admin, pumps, { description: "Valve inspection", fields: { customer: "Acme" } });
    // Sam's private board: the admin is not a member.
    privateBoard = (
      await ok(
        sam.request("POST", "/api/v1/channels", { name: "hr-cases", layout: "board", visibility: "private" }),
      )
    ).id;
    secretCard = await card(sam, privateBoard, {
      title: "Fennel complaint",
      description: "Confidential fennel case",
    });
  });

  it("a member finds a card by its title, a word of its description and a field value", async () => {
    const byTitle = await search(bea, { q: "broken pump" });
    expect(hitIds(byTitle)).toEqual([pumpCard.messageId]);
    expect((byTitle.hits as Json[])[0]).toMatchObject({
      threadRootId: null,
      conversation: { id: pumps, kind: "channel", label: "#pump-cases" },
    });
    expect(hitIds(await search(bea, { q: "gasket" }))).toEqual([pumpCard.messageId]);
    expect(hitIds(await search(bea, { q: "Acme" }))).toEqual([acmeCard.messageId]);
  });

  it("after Víctor retitles the card, search finds the new title and no longer the old one", async () => {
    const edited = await ok(
      admin.request("PATCH", `/api/v1/boards/${pumps}/cards/${pumpCard.messageId}`, {
        expectedVersion: pumpCard.version,
        title: "Pump 3 replaced",
      }),
    );
    expect(edited).toMatchObject({ title: "Pump 3 replaced", titleSource: "user" });
    expect(hitIds(await search(bea, { q: "replaced" }))).toEqual([pumpCard.messageId]);
    expect(hitIds(await search(bea, { q: "broken" }))).toEqual([]);
    // The description still finds it.
    expect(hitIds(await search(bea, { q: "gasket" }))).toEqual([pumpCard.messageId]);
  });

  it("an admin who is not in a private board finds nothing of it; the member does", async () => {
    expect(hitIds(await search(sam, { q: "fennel" }))).toEqual([secretCard.messageId]);
    const r = await search(admin, { q: "fennel" });
    expect(r.hits).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("Fennel");
  });

  it("org B's tenant finds no card, even naming org A's boards as readable", async () => {
    const db = stack.built.core.db;
    for (const q of ["replaced", "gasket", "fennel", "acme"]) {
      const res = await db.withTenant({ organizationId: orgB, userId: userB }, async (tx) =>
        searchMessages(tx, {
          readableIds: [pumps, privateBoard],
          q,
          limit: 20,
          dir: await loadDirectory(tx),
          viewerId: userB,
        }),
      );
      expect(res.hits, q).toEqual([]);
    }
  });
});
