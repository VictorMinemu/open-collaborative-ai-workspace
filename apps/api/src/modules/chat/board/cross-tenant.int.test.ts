import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-14 (BOARD-04 success criterion 4, P-10, T-07.1-14-01): every board query path has a cross-tenant test.
 *
 * The guard lists every registered route of the board families from the authz registry (`stack.built.authz.routes`)
 * and fails, naming the route, when one has no org-B case. A case is either a row of `CASES` below (org B's admin
 * calls it with org A's ids; org A's rows are identical before and after) or a row of one of the phase's existing
 * cross-tenant tables, read from its source (`REFERENCED_TABLES`). A case naming a route that is no longer
 * registered fails too, so the tables cannot drift from the API.
 */

/** Route families the guard owns: every route under these prefixes needs an org-B case. */
const FAMILIES = ["/api/v1/boards", "/api/v1/record-templates", "/agent-channel/v1/board"];

/**
 * The phase's earlier cross-tenant tables. Each asserts the uniform refusal in its own file: 404 for org B's admin
 * (05, 03, 06), 404 / 400 `template_not_available` for templates (07), 403 `no_trigger` for org B's cell token with
 * org A's turn (10, the PR #25 rule).
 */
const REFERENCED_TABLES = [
  { file: "./board-access.int.test.ts", table: "BOARD_ACCESS_CROSS_TENANT_ROUTES" },
  { file: "./board.int.test.ts", table: "CROSS_TENANT_ROUTES" },
  { file: "./columns.int.test.ts", table: "COLUMN_ROUTES" },
  { file: "./templates.int.test.ts", table: "TEMPLATE_CROSS_TENANT_ROUTES" },
  { file: "../../agent-channel/board.int.test.ts", table: "AGENT_BOARD_CROSS_TENANT_ROUTES" },
] as const;

/** `GET /api/v1/boards/:conversationId` and `GET /boards/:id` both become `GET /api/v1/boards/:p`. */
function routeKey(nameOrKey: string): string {
  const m = /^(GET|POST|PATCH|PUT|DELETE) (\/\S*)/.exec(nameOrKey);
  if (!m) throw new Error(`not a route: ${nameOrKey}`);
  const [, method, rawPath] = m as unknown as [string, string, string];
  let path = rawPath.split("?")[0] as string;
  if (!path.startsWith("/api/") && !path.startsWith("/agent-channel/")) path = `/api/v1${path}`;
  return `${method} ${path.replace(/\/:[^/]+/g, "/:p")}`;
}

/** The route names of a referenced table, read from its source (the `name: "METHOD /path…"` rows of the literal). */
function tableRoutes(file: string, table: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  const start = source.indexOf(`const ${table}`);
  if (start < 0) throw new Error(`${table} not found in ${file}`);
  const open = source.indexOf("= [", start);
  const close = source.indexOf("\n  ];", open);
  if (open < 0 || close < 0) throw new Error(`${table} in ${file} is not an array literal`);
  const names = [...source.slice(open, close).matchAll(/name: "((?:GET|POST|PATCH|PUT|DELETE) [^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  if (names.length === 0) throw new Error(`${table} in ${file} lists no route`);
  return names;
}

let stack: TestStack;
let su: pg.Client;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

/** One org-B case: the registry key it covers and the uniform refusal it must get. */
interface Case {
  route: string;
  name: string;
  status: 400 | 404;
  code?: string;
  call: (c: TestClient) => Promise<Res>;
}

/** Org A's ids, seeded once: a unit, a template in it, a board created from the template, two cards. */
const a = { unitId: "", templateId: "", boardId: "", columnId: "", targetId: "", messageId: "" };

/** Words of org A's data that must never appear in an answer to org B. */
const SECRETS = ["Acme", "Case file", "Broken pump", "Intake", "EXP-0001"];

const CASES: Case[] = [
  {
    route: "GET /api/v1/boards/:conversationId",
    name: "the board snapshot",
    status: 404,
    call: (c) => c.request("GET", `/api/v1/boards/${a.boardId}`),
  },
  {
    route: "GET /api/v1/boards/:conversationId/columns/:columnId/cards",
    name: "a column page",
    status: 404,
    call: (c) => c.request("GET", `/api/v1/boards/${a.boardId}/columns/${a.columnId}/cards`),
  },
  {
    route: "POST /api/v1/boards/:conversationId/cards",
    name: "a planted card",
    status: 404,
    call: (c) =>
      c.request("POST", `/api/v1/boards/${a.boardId}/cards`, {
        description: "Planted",
        fields: { customer: "Planted" },
        clientMessageId: randomUUID(),
      }),
  },
  {
    route: "PATCH /api/v1/boards/:conversationId/cards/:messageId",
    name: "moving org A's card",
    status: 404,
    call: (c) =>
      c.request("PATCH", `/api/v1/boards/${a.boardId}/cards/${a.messageId}`, {
        expectedVersion: 1,
        move: { columnId: a.targetId, afterCardId: null },
      }),
  },
  {
    route: "PATCH /api/v1/boards/:conversationId/cards/:messageId",
    name: "retitling org A's card",
    status: 404,
    call: (c) =>
      c.request("PATCH", `/api/v1/boards/${a.boardId}/cards/${a.messageId}`, {
        expectedVersion: 1,
        title: "Planted",
      }),
  },
  {
    route: "POST /api/v1/boards/:conversationId/columns",
    name: "a planted column",
    status: 404,
    call: (c) =>
      c.request("POST", `/api/v1/boards/${a.boardId}/columns`, { name: "Planted", category: "started" }),
  },
  {
    route: "PATCH /api/v1/boards/:conversationId/columns/:columnId",
    name: "renaming org A's column",
    status: 404,
    call: (c) =>
      c.request("PATCH", `/api/v1/boards/${a.boardId}/columns/${a.columnId}`, {
        name: "Planted",
        afterColumnId: null,
      }),
  },
  {
    route: "DELETE /api/v1/boards/:conversationId/columns/:columnId",
    name: "deleting org A's column",
    status: 404,
    call: (c) =>
      c.request("DELETE", `/api/v1/boards/${a.boardId}/columns/${a.columnId}?moveCardsTo=${a.targetId}`),
  },
  {
    route: "GET /api/v1/record-templates",
    name: "the templates of org A's unit",
    status: 404,
    code: "unit_not_found",
    call: (c) => c.request("GET", `/api/v1/record-templates?unitId=${a.unitId}`),
  },
  {
    route: "POST /api/v1/record-templates",
    name: "a template in org A's unit",
    status: 404,
    code: "unit_not_found",
    call: (c) => c.request("POST", "/api/v1/record-templates", { unitId: a.unitId, name: "Planted" }),
  },
  {
    route: "PATCH /api/v1/record-templates/:id",
    name: "editing org A's template",
    status: 404,
    code: "template_not_found",
    call: (c) =>
      c.request("PATCH", `/api/v1/record-templates/${a.templateId}`, { expectedVersion: 1, name: "Planted" }),
  },
  {
    route: "DELETE /api/v1/record-templates/:id",
    name: "deleting org A's template",
    status: 404,
    code: "template_not_found",
    call: (c) => c.request("DELETE", `/api/v1/record-templates/${a.templateId}`),
  },
  {
    route: "POST /api/v1/channels",
    name: "a board channel in org A's unit",
    status: 404,
    code: "unit_not_found",
    call: (c) =>
      c.request("POST", "/api/v1/channels", { name: "planted-board", layout: "board", unitId: a.unitId }),
  },
  {
    route: "POST /api/v1/channels",
    name: "a board channel from org A's template",
    status: 400,
    code: "template_not_available",
    call: (c) =>
      c.request("POST", "/api/v1/channels", {
        name: "planted-board",
        layout: "board",
        templateId: a.templateId,
      }),
  },
];

let eve: TestClient;
let orgA: string;

async function ok(res: Promise<Res>) {
  const r = await res;
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** Every org-A row a board, column, card or template route could touch (as the superuser, so RLS hides nothing). */
async function orgARows() {
  const q = async (sql: string) => (await su.query(sql, [orgA])).rows;
  return {
    conversations: await q(
      "select id, name, layout from app.conversations where organization_id = $1 order by id",
    ),
    boards: await q("select * from app.boards where organization_id = $1 order by conversation_id"),
    columns: await q("select * from app.board_columns where organization_id = $1 order by id"),
    cards: await q("select * from app.board_cards where organization_id = $1 order by message_id"),
    messages: await q("select id, body, deleted_at from app.messages where organization_id = $1 order by id"),
    templates: await q("select * from app.record_templates where organization_id = $1 order by id"),
    streams: await q("select id, last_seq from app.streams where organization_id = $1 order by id"),
  };
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
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
  orgA = setup.organization.id;

  // Org A: Ops, Dana's kind of "Case file" template, `#cases` from it, two cards.
  a.unitId = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }))
  ).id;
  const template = await ok(
    admin.request("POST", "/api/v1/record-templates", {
      unitId: a.unitId,
      name: "Case file",
      prefix: "EXP",
      namingRule: "{prefix}-{seq:0000} · {field:customer} · {summary}",
      fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
      columns: [
        { name: "Intake", category: "backlog" },
        { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
        { name: "Closed", category: "done" },
      ],
    }),
  );
  a.templateId = template.id;
  const board = await ok(
    admin.request("POST", "/api/v1/channels", {
      name: "cases",
      layout: "board",
      visibility: "public",
      unitId: a.unitId,
      templateId: a.templateId,
    }),
  );
  a.boardId = board.id;
  const snap = await ok(admin.request("GET", `/api/v1/boards/${a.boardId}`));
  const column = (name: string) => (snap.columns as Json[]).find((c) => c.name === name)?.id as string;
  a.columnId = column("Intake");
  a.targetId = column("Closed");
  const first = await ok(
    admin.request("POST", `/api/v1/boards/${a.boardId}/cards`, {
      description: "Broken pump",
      fields: { customer: "Acme" },
      clientMessageId: randomUUID(),
    }),
  );
  expect(first.title).toBe("EXP-0001 · Acme · Broken pump");
  a.messageId = first.messageId;
  await ok(
    admin.request("POST", `/api/v1/boards/${a.boardId}/cards`, {
      description: "Leaking valve",
      fields: { customer: "Acme" },
      clientMessageId: randomUUID(),
    }),
  );

  // Org B: Eve, invited into org A and then moved into her own organization as its admin.
  const inv = await ok(
    admin.request("POST", "/api/v1/invitations", { email: "eve@example.test", role: "developer" }),
  );
  eve = new TestClient(stack.baseUrl);
  const accepted = await ok(
    eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Eve",
      password: "another-long-password",
    }),
  );
  const orgB = randomUUID();
  const eveId = accepted.user.id as string;
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
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("every board route has a cross-tenant case (BOARD-04, P-10)", () => {
  const registered = () =>
    [...stack.built.authz.routes.keys()].filter((key) =>
      FAMILIES.some((f) => key.split(" ")[1]?.startsWith(f)),
    );

  it("the registry's board, column, template and agent-board routes equal the covered set", () => {
    const covered = new Map<string, string[]>();
    const cover = (key: string, by: string) => covered.set(key, [...(covered.get(key) ?? []), by]);
    for (const c of CASES) cover(routeKey(c.route), "cross-tenant.int");
    for (const { file, table } of REFERENCED_TABLES) {
      for (const name of tableRoutes(file, table)) cover(routeKey(name), table);
    }

    const family = registered();
    expect(family.length).toBeGreaterThanOrEqual(14);
    const missing = family.filter((key) => !covered.has(routeKey(key))).sort();
    expect(missing, "registered routes without an org-B case").toEqual([]);

    const all = new Set([...stack.built.authz.routes.keys()].map(routeKey));
    const stale = [...covered.entries()]
      .filter(([key]) => !all.has(key))
      .map(([key, by]) => `${key} (${by})`);
    expect(stale, "cases naming a route that is not registered").toEqual([]);
  });
});

describe("org B's admin with org A's ids (BOARD-04, T-07.1-14-01)", () => {
  it.each(CASES)("$route ($name): $status, no org-A data in the answer, org A unchanged", async (c) => {
    const before = await orgARows();
    const res = await c.call(eve);
    expect(res.status, JSON.stringify(res.body)).toBe(c.status);
    if (c.code) expect(((res.body as Json).error as Json).code).toBe(c.code);
    const text = JSON.stringify(res.body);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(await orgARows()).toEqual(before);
    // Nothing was planted in org B either.
    const planted = await su.query(
      `select (select count(*)::int from app.conversations where name = 'planted-board')
            + (select count(*)::int from app.record_templates where name = 'Planted') as n`,
    );
    expect(planted.rows[0].n).toBe(0);
  });

  it("org B's own template list is empty: org A's templates are not listed without a unit either", async () => {
    const res = await ok(eve.request("GET", "/api/v1/record-templates"));
    expect(res.templates).toEqual([]);
  });
});
