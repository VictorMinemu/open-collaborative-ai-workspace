import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-15 (MEM-07, SC5, T-07.2-15-01): every route Phase 07.2 added or rewrote has a cross-tenant case, enforced
 * through the authz registry (`stack.built.authz.routes`), like the board guard of 07.1-14.
 *
 * The guard lists every registered route of the memory, approval and Agent Channel memory families plus the routes 07.2
 * rewrote elsewhere (the card decision, the legacy notes view) and fails, naming the route, when one has no org-B case
 * below. A case naming a route that is no longer registered fails too, so the table cannot drift from the API.
 *
 * Each case is org B acting on org A's ids: Eve, the admin of org B, for the human routes (404, or 200 with nothing of
 * org A in the answer for the lists); org B's cell token with org A's delivered turn for the cell routes (403
 * `no_trigger`, the PR #25 rule). Org A's rows are identical before and after every case, and nothing is planted in
 * org B. Then the database itself: a memory file never moves into another organization's scope, whatever the role.
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-xtenant-0123456789abc";
const CELL_TOKEN_B = `ocw_cell_${randomUUID()}${randomUUID()}`;

/** Route families the guard owns: every registered route under these prefixes needs an org-B case. */
const FAMILIES = [
  "/api/v1/memory",
  "/api/v1/approvals",
  "/agent-channel/v1/memory/",
  "/agent-channel/v1/memories",
];
/** Routes outside those prefixes that 07.2 rewrote (linked card decisions; legacy notes now read MEMORY.md). */
const REWRITTEN = [
  "POST /api/v1/cards/:p/decision",
  "GET /api/v1/agents/:p/memories",
  "DELETE /api/v1/agents/:p/memories",
  "DELETE /api/v1/agents/:p/memories/:p",
];

const routeKey = (key: string) => {
  const [method, path] = key.split(" ") as [string, string];
  return `${method} ${path.split("?")[0]?.replace(/\/:[^/]+/g, "/:p")}`;
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let lena: TestClient;
let eve: TestClient;
let orgA: string;
let orgB: string;
let samId: string;

/** Org A's ids, seeded once. */
const a = {
  scoutId: "",
  dmId: "",
  privateScope: "",
  ventasScope: "",
  orgScope: "",
  privateFile: "",
  ventasFile: "",
  eventId: "",
  approvalId: "",
  actionHash: "",
  cardMessageId: "",
  noteId: "",
};

/** Words of org A's data that must never appear in an answer to org B. */
const SECRETS = [
  "Autofy",
  "Ventas",
  "Comercial",
  "Sam Lee",
  "Lena Gil",
  "xtenant-acme",
  "XTENANT-PLAN",
  "tea-canary",
];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(path: string, body: unknown, token: string): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}
const asB = (path: string, extra: Json) =>
  cell(path, { eventId: a.eventId, agentId: a.scoutId, ...extra }, CELL_TOKEN_B);

/** One org-B case: the registry key it covers and what org B must get. */
interface Case {
  route: string;
  name: string;
  status: 200 | 403 | 404;
  code?: string;
  /** For a 200: the answer must hold exactly this (org B's own, empty view). */
  body?: (b: Json) => void;
  call: () => Promise<Res>;
}

const version = async (fileId: string) =>
  (await su.query("select version from app.memory_files where id = $1", [fileId])).rows[0].version as number;

const CASES: Case[] = [
  {
    route: "GET /api/v1/memory/scopes",
    name: "the scope list holds org B's own organization scope only",
    status: 200,
    body: (b) => expect((b.scopes as Json[]).map((s) => s.kind)).toEqual(["org"]),
    call: () => eve.request("GET", "/api/v1/memory/scopes"),
  },
  {
    route: "POST /api/v1/memory/scopes",
    name: "opening a private scope with org A's bot",
    status: 404,
    call: () => eve.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: a.scoutId }),
  },
  {
    route: "DELETE /api/v1/memory/scopes/:scopeId",
    name: "forgetting Sam's private memory",
    status: 404,
    call: () => eve.request("DELETE", `/api/v1/memory/scopes/${a.privateScope}`),
  },
  {
    route: "GET /api/v1/memory/scopes/:scopeId/files",
    name: "listing Ventas' files",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/scopes/${a.ventasScope}/files`),
  },
  {
    route: "GET /api/v1/memory/scopes/:scopeId/file",
    name: "reading a Ventas file by path",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/scopes/${a.ventasScope}/file?path=xtenant-acme.md`),
  },
  {
    route: "POST /api/v1/memory/scopes/:scopeId/files",
    name: "planting a file in org A's organization scope",
    status: 404,
    call: () =>
      eve.request("POST", `/api/v1/memory/scopes/${a.orgScope}/files`, {
        path: "planted.md",
        content: "x\n",
      }),
  },
  {
    route: "GET /api/v1/memory/files/:fileId",
    name: "reading Sam's private file by id",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/files/${a.privateFile}`),
  },
  {
    route: "PUT /api/v1/memory/files/:fileId",
    name: "rewriting a Ventas file",
    status: 404,
    call: async () =>
      eve.request("PUT", `/api/v1/memory/files/${a.ventasFile}`, {
        content: "# Planted\n",
        expectedVersion: await version(a.ventasFile),
      }),
  },
  {
    route: "POST /api/v1/memory/files/:fileId/rename",
    name: "renaming a Ventas file",
    status: 404,
    call: async () =>
      eve.request("POST", `/api/v1/memory/files/${a.ventasFile}/rename`, {
        path: "planted.md",
        expectedVersion: await version(a.ventasFile),
      }),
  },
  {
    route: "DELETE /api/v1/memory/files/:fileId",
    name: "deleting a Ventas file",
    status: 404,
    call: async () =>
      eve.request(
        "DELETE",
        `/api/v1/memory/files/${a.ventasFile}?expectedVersion=${await version(a.ventasFile)}`,
      ),
  },
  {
    route: "GET /api/v1/memory/files/:fileId/revisions",
    name: "Sam's private history",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/files/${a.privateFile}/revisions`),
  },
  {
    route: "GET /api/v1/memory/files/:fileId/revisions/:version",
    name: "one revision of a Ventas file",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/files/${a.ventasFile}/revisions/1`),
  },
  {
    route: "POST /api/v1/memory/files/:fileId/restore",
    name: "restoring a Ventas file",
    status: 404,
    call: async () =>
      eve.request("POST", `/api/v1/memory/files/${a.ventasFile}/restore`, {
        version: 1,
        expectedVersion: await version(a.ventasFile),
      }),
  },
  {
    route: "GET /api/v1/memory/search",
    name: "searching inside a Ventas scope id",
    status: 404,
    call: () => eve.request("GET", `/api/v1/memory/search?q=xtenant&scopeId=${a.ventasScope}`),
  },
  {
    route: "GET /api/v1/memory/search",
    name: "searching org A's words without a scope",
    status: 200,
    body: (b) => expect(b).toEqual({ hits: [] }),
    call: () => eve.request("GET", "/api/v1/memory/search?q=XTENANT-PLAN"),
  },
  {
    route: "GET /api/v1/approvals",
    name: "the inbox as a decider",
    status: 200,
    body: (b) => expect(b).toEqual({ items: [], nextCursor: null }),
    call: () => eve.request("GET", "/api/v1/approvals?role=decider"),
  },
  {
    route: "GET /api/v1/approvals",
    name: "the inbox as a requester",
    status: 200,
    body: (b) => expect(b).toEqual({ items: [], nextCursor: null }),
    call: () => eve.request("GET", "/api/v1/approvals?role=requester"),
  },
  {
    route: "GET /api/v1/approvals/:id",
    name: "the pending Ventas proposal",
    status: 404,
    code: "approval_not_found",
    call: () => eve.request("GET", `/api/v1/approvals/${a.approvalId}`),
  },
  {
    route: "POST /api/v1/approvals/:id/decision",
    name: "approving the pending Ventas proposal with its real hash",
    status: 404,
    code: "approval_not_found",
    call: () =>
      eve.request("POST", `/api/v1/approvals/${a.approvalId}/decision`, {
        outcome: "approved",
        actionHash: a.actionHash,
      }),
  },
  {
    route: "POST /api/v1/cards/:messageId/decision",
    name: "approving the proposal's card with its real hash",
    status: 404,
    call: () =>
      eve.request("POST", `/api/v1/cards/${a.cardMessageId}/decision`, {
        outcome: "approved",
        actionHash: a.actionHash,
      }),
  },
  {
    route: "GET /api/v1/agents/:id/memories",
    name: "Sam's legacy notes view",
    status: 404,
    call: () => eve.request("GET", `/api/v1/agents/${a.scoutId}/memories`),
  },
  {
    route: "DELETE /api/v1/agents/:id/memories",
    name: "clearing Sam's notes",
    status: 404,
    call: () => eve.request("DELETE", `/api/v1/agents/${a.scoutId}/memories`),
  },
  {
    route: "DELETE /api/v1/agents/:id/memories/:memoryId",
    name: "deleting one of Sam's notes",
    status: 404,
    call: () => eve.request("DELETE", `/api/v1/agents/${a.scoutId}/memories/${a.noteId}`),
  },
  {
    route: "POST /agent-channel/v1/memory/list",
    name: "org B's cell listing with org A's turn",
    status: 403,
    code: "no_trigger",
    call: () => asB("/memory/list", {}),
  },
  {
    route: "POST /agent-channel/v1/memory/read",
    name: "org B's cell reading Sam's MEMORY.md with org A's turn",
    status: 403,
    code: "no_trigger",
    call: () => asB("/memory/read", { scope: "personal", path: "MEMORY.md" }),
  },
  {
    route: "POST /agent-channel/v1/memory/write",
    name: "org B's cell appending to Sam's MEMORY.md",
    status: 403,
    code: "no_trigger",
    call: () =>
      asB("/memory/write", { scope: "personal", path: "MEMORY.md", mode: "append", content: "- planted" }),
  },
  {
    route: "POST /agent-channel/v1/memory/propose",
    name: "org B's cell proposing into Ventas",
    status: 403,
    code: "no_trigger",
    call: () =>
      asB("/memory/propose", {
        scope: a.ventasScope,
        path: "planted.md",
        op: "create",
        content: "- planted\n",
      }),
  },
  {
    route: "POST /agent-channel/v1/memories",
    name: "org B's cell saving a legacy note with org A's turn",
    status: 404,
    code: "unknown_turn",
    call: () => cell("/memories", { eventId: a.eventId, agentId: a.scoutId, text: "planted" }, CELL_TOKEN_B),
  },
];

/** Every org-A row a 07.2 route could touch (as the superuser, so RLS hides nothing). */
async function orgARows() {
  const q = async (sql: string) => (await su.query(sql, [orgA])).rows;
  return {
    scopes: await q("select * from app.memory_scopes where organization_id = $1 order by id"),
    files: await q("select * from app.memory_files where organization_id = $1 order by id"),
    revisions: await q(
      "select id, file_id, version, content from app.memory_file_revisions where organization_id = $1 order by id",
    ),
    proposals: await q("select * from app.memory_proposals where organization_id = $1 order by id"),
    approvals: await q("select * from app.approval_requests where organization_id = $1 order by id"),
    cards: await q("select * from app.message_cards where organization_id = $1 order by message_id"),
    turns: await q(
      "select event_id, tool_calls from app.agent_turns where organization_id = $1 order by event_id",
    ),
    messages: await q("select id, body from app.messages where organization_id = $1 order by id"),
  };
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  orgA = setup.organization.id;
  const join = async (email: string, name: string, role: string) => {
    const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
    const c = new TestClient(stack.baseUrl);
    const acc = await ok(
      c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
    );
    return [c, acc.user.id as string] as const;
  };
  [sam, samId] = await join("sam@example.test", "Sam Lee", "standard");
  const [lenaClient, lenaId] = await join("lena@example.test", "Lena Gil", "lead");
  lena = lenaClient;
  let eveId: string;
  [eve, eveId] = await join("eve@example.test", "Eve", "standard");
  const comercial = (
    await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Comercial", parentId: null }),
    )
  ).id;
  const ventas = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Ventas", parentId: comercial }))
  ).id;
  await ok(admin.request("POST", `/api/v1/units/${ventas}/members`, { userId: lenaId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${ventas}/members`, { userId: samId }));

  // Org A's memory: Sam's private file, a Ventas file, the organization scope.
  const bot = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  a.scoutId = bot.agent.id;
  a.dmId = bot.dmId;
  await ok(sam.request("PATCH", `/api/v1/agents/${a.scoutId}/capabilities`, { dailyLimit: 100 }));
  a.privateScope = (
    await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: a.scoutId }))
  ).id;
  for (const s of (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[]) {
    if (s.kind === "unit" && s.unitId === ventas) a.ventasScope = s.id;
    if (s.kind === "org") a.orgScope = s.id;
  }
  a.privateFile = (
    await ok(
      sam.request("POST", `/api/v1/memory/scopes/${a.privateScope}/files`, {
        path: "plans.md",
        content: "# Plans\n- XTENANT-PLAN private\n",
      }),
    )
  ).id;
  a.ventasFile = (
    await ok(
      lena.request("POST", `/api/v1/memory/scopes/${a.ventasScope}/files`, {
        path: "xtenant-acme.md",
        content: "# Acme\n- XTENANT-PLAN team\n",
      }),
    )
  ).id;

  // A delivered turn in Sam's DM, a legacy note and a pending proposal into Ventas with its card.
  const msg = await ok(
    sam.request("POST", `/api/v1/conversations/${a.dmId}/messages`, { body: "keep this", mentions: [] }),
  );
  a.eventId = (
    await su.query(
      "select payload->>'eventId' as id from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1",
      [msg.id],
    )
  ).rows[0].id;
  const asA = (path: string, body: Json) =>
    cell(path, { eventId: a.eventId, agentId: a.scoutId, ...body }, CELL_TOKEN);
  expect((await asA("/memories", { text: "likes tea-canary" })).status).toBe(200);
  const notes = await ok(sam.request("GET", `/api/v1/agents/${a.scoutId}/memories`));
  a.noteId = (notes.items as Json[])[0]?.id;
  expect(a.noteId).toBeTruthy();
  const proposed = await asA("/memory/propose", {
    scope: a.ventasScope,
    path: "xtenant-acme-next.md",
    op: "create",
    content: "# Next\n- XTENANT-PLAN proposal\n",
  });
  a.approvalId = proposed.body?.approvalId;
  expect(a.approvalId).toBeTruthy();
  const detail = await ok(lena.request("GET", `/api/v1/approvals/${a.approvalId}`));
  a.actionHash = detail.actionHash;
  a.cardMessageId = (
    await su.query("select card_message_id from app.approval_requests where id = $1", [a.approvalId])
  ).rows[0].card_message_id;
  expect(a.cardMessageId).toBeTruthy();

  // Org B: Eve moves into her own organization as its admin; org B has its own cell token.
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  await su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [orgB, sha256Hex(CELL_TOKEN_B)],
  );
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("every 07.2 route has a cross-tenant case (the authz registry)", () => {
  it("the registry's memory, approval, agent-memory and rewritten routes equal the covered set", () => {
    const registered = [...stack.built.authz.routes.keys()]
      .filter(
        (key) => FAMILIES.some((f) => key.split(" ")[1]?.startsWith(f)) || REWRITTEN.includes(routeKey(key)),
      )
      .map(routeKey);
    expect(registered.length).toBeGreaterThanOrEqual(26);
    const covered = new Set(CASES.map((c) => routeKey(c.route)));
    expect(
      [...new Set(registered)].filter((key) => !covered.has(key)).sort(),
      "registered routes without an org-B case",
    ).toEqual([]);
    const all = new Set([...stack.built.authz.routes.keys()].map(routeKey));
    expect(
      [...covered].filter((key) => !all.has(key)),
      "cases naming a route that is not registered",
    ).toEqual([]);
    // The human routes are user routes and the agent routes cell routes: no other principal reaches them.
    for (const [key, mode] of stack.built.authz.routes) {
      if (!registered.includes(routeKey(key))) continue;
      expect(mode, key).toBe(key.includes(" /agent-channel/") ? "cell" : "user");
    }
  });
});

describe("org B with org A's ids (MEM-07, SC5)", () => {
  it.each(CASES)("$route ($name): $status, no org-A data in the answer, org A unchanged", async (c) => {
    const before = await orgARows();
    const res = await c.call();
    expect(res.status, JSON.stringify(res.body)).toBe(c.status);
    if (c.code) expect((res.body?.error as Json | undefined)?.code).toBe(c.code);
    if (c.body) c.body(res.body as Json);
    const text = JSON.stringify(res.body);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    for (const id of Object.values(a)) if (id) expect(text).not.toContain(id);
    expect(await orgARows()).toEqual(before);
    const planted = await su.query(
      `select (select count(*)::int from app.memory_files where path ilike '%planted%')
            + (select count(*)::int from app.memory_proposals where path ilike '%planted%')
            + (select count(*)::int from app.memory_file_revisions where content ilike '%planted%') as n`,
    );
    expect(planted.rows[0].n).toBe(0);
  });

  it("the same calls with org A's own credentials do reach org A's data (the cases are not vacuous)", async () => {
    expect((await sam.request("GET", `/api/v1/memory/files/${a.privateFile}`)).status).toBe(200);
    expect((await lena.request("GET", `/api/v1/memory/scopes/${a.ventasScope}/files`)).status).toBe(200);
    expect((await lena.request("GET", `/api/v1/approvals/${a.approvalId}`)).status).toBe(200);
    const read = await cell(
      "/memory/read",
      { eventId: a.eventId, agentId: a.scoutId, scope: "personal", path: "plans.md" },
      CELL_TOKEN,
    );
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain("XTENANT-PLAN private");
  });
});

describe("the database: a memory file never moves into another organization's scope", () => {
  it("the scope-immutable trigger refuses the move even as the superuser; nothing changes", async () => {
    const orgBScope = (
      await su.query("select id from app.memory_scopes where organization_id = $1 and kind = 'org'", [orgB])
    ).rows[0]?.id as string;
    expect(orgBScope).toBeTruthy();
    const before = await orgARows();
    for (const fileId of [a.privateFile, a.ventasFile]) {
      await expect(
        su.query("update app.memory_files set scope_id = $1 where id = $2", [orgBScope, fileId]),
      ).rejects.toThrow(/memory file scope is immutable/);
      // Also with the organization moved along (the whole row re-homed): still refused before any other check.
      await expect(
        su.query("update app.memory_files set scope_id = $1, organization_id = $2 where id = $3", [
          orgBScope,
          orgB,
          fileId,
        ]),
      ).rejects.toThrow(/memory file scope is immutable/);
    }
    expect(await orgARows()).toEqual(before);
    expect(
      (await su.query("select count(*)::int as n from app.memory_files where organization_id = $1", [orgB]))
        .rows[0].n,
    ).toBe(1);
  });
});
