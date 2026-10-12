import { randomUUID } from "node:crypto";
import { RecordTemplate } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../../testing";

/**
 * Phase 07.1-07 (BOARD-06, BOARD-04; D-06, D-07, D-08, P-08): record templates over real PostgreSQL + Redis.
 * The tracer: Dana, lead of the Ops team, creates a "Case file" template; Víctor creates `#cases` in Ops from it and
 * its first card is titled `EXP-0001 · Acme · Broken pump`. Then the permission matrix, the scope rule, validation,
 * versions, snapshot independence and tenant isolation.
 */

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let dana: TestClient;
let danaId: string;
let mia: TestClient;
let leo: TestClient;
let eve: TestClient;
let operations: string;
let ops: string;
let finance: string;
/** Set by the tracer: Dana's "Case file" template in Ops and the `#cases` board created from it. */
let caseTemplate: Json;
let casesBoardId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** The error of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as Json;
}

async function invite(
  email: string,
  role: string,
  name: string,
): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
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

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
const join = (unitId: string, userId: string, role: "member" | "lead") =>
  ok(victor.request("POST", `/api/v1/units/${unitId}/members`, { userId, role }));

const CASE_RULE = "{prefix}-{seq:0000} · {field:customer} · {summary}";
const caseFile = (unitId: string | null, extra: Json = {}) => ({
  unitId,
  name: "Case file",
  prefix: "EXP",
  namingRule: CASE_RULE,
  fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
  columns: [
    { name: "Intake", category: "backlog" },
    { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
    { name: "Closed", category: "done" },
    { name: "Dropped", category: "cancelled" },
  ],
  ...extra,
});

const boardChannel = (as: TestClient, name: string, extra: Json) =>
  as.request("POST", "/api/v1/channels", { name, layout: "board", visibility: "public", ...extra });
const snapshot = (as: TestClient, id: string) => ok(as.request("GET", `/api/v1/boards/${id}`));
const card = (as: TestClient, boardId: string, body: Json) =>
  as.request("POST", `/api/v1/boards/${boardId}/cards`, { clientMessageId: randomUUID(), ...body });

const auditsOf = async (actions: string[]) =>
  (
    await su.query(
      "select action, metadata from app.audit_events where action = any($1) order by occurred_at",
      [actions],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  ({ client: dana, id: danaId } = await invite("dana@example.test", "lead", "Dana Lead"));
  operations = await unit("department", "Operations", null);
  ops = await unit("team", "Ops", operations);
  finance = await unit("department", "Finance", null);
  await join(ops, danaId, "lead");
  const plain = await invite("mia@example.test", "developer", "Mia Member");
  mia = plain.client;
  await join(ops, plain.id, "member");
  const upper = await invite("leo@example.test", "lead", "Leo Lead");
  leo = upper.client;
  await join(operations, upper.id, "lead");
  const evil = await invite("eve@example.test", "developer", "Eve");
  eve = evil.client;
  await moveToOtherOrg(eve, evil.id);
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("record templates (tracer)", () => {
  it("Dana's Case file template names the first card of #cases `EXP-0001 · Acme · Broken pump`", async () => {
    const template = await ok(dana.request("POST", "/api/v1/record-templates", caseFile(ops)));
    expect(template).toMatchObject({
      unitId: ops,
      name: "Case file",
      description: "",
      prefix: "EXP",
      namingRule: CASE_RULE,
      fields: [{ key: "customer", label: "Customer", type: "text", required: true }],
      version: 1,
    });
    expect(template.columns).toEqual([
      { name: "Intake", category: "backlog", defaultWaitingOn: null },
      { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
      { name: "Closed", category: "done", defaultWaitingOn: null },
      { name: "Dropped", category: "cancelled", defaultWaitingOn: null },
    ]);

    const channel = await ok(boardChannel(victor, "cases", { unitId: ops, templateId: template.id }));
    expect(channel).toMatchObject({ name: "cases", layout: "board" });
    expect(channel.unit?.id).toBe(ops);
    const boardId = channel.id as string;
    caseTemplate = template;
    casesBoardId = boardId;

    const snap = await snapshot(victor, boardId);
    expect(snap.board).toMatchObject({
      conversationId: boardId,
      templateId: template.id,
      prefix: "EXP",
      namingRule: CASE_RULE,
      fields: template.fields,
    });
    expect(snap.columns.map((c: Json) => [c.name, c.category, c.defaultWaitingOn])).toEqual([
      ["Intake", "backlog", null],
      ["Waiting for customer", "started", "customer"],
      ["Closed", "done", null],
      ["Dropped", "cancelled", null],
    ]);

    const first = await ok(
      card(victor, boardId, { description: "Broken pump\nPump 3", fields: { customer: "Acme" } }),
    );
    expect(first).toMatchObject({
      title: "EXP-0001 · Acme · Broken pump",
      number: 1,
      columnId: snap.columns[0].id,
    });
    const second = await ok(
      card(victor, boardId, { description: "Leaking valve", fields: { customer: "Globex" } }),
    );
    expect(second).toMatchObject({ title: "EXP-0002 · Globex · Leaking valve", number: 2 });
    const missing = await fails(card(victor, boardId, { description: "No customer" }), 400);
    expect(missing.code).toBe("invalid_field_values");

    const waiting = snap.columns[1] as Json;
    const moved = await ok(
      victor.request("PATCH", `/api/v1/boards/${boardId}/cards/${first.messageId}`, {
        expectedVersion: first.version,
        move: { columnId: waiting.id, afterCardId: null },
      }),
    );
    expect(moved).toMatchObject({ columnId: waiting.id, waitingOn: "customer" });

    const audits = await auditsOf(["record_template.created", "channel.created"]);
    expect(audits.find((a) => a.action === "record_template.created")?.metadata).toEqual({
      templateId: template.id,
      unitId: ops,
      version: 1,
      fieldCount: 1,
      columnCount: 4,
    });
    expect(
      audits.find((a) => a.action === "channel.created" && a.metadata.name === "cases")?.metadata,
    ).toMatchObject({ layout: "board", templateId: template.id, unitId: ops });
    const text = JSON.stringify(audits.filter((a) => a.action === "record_template.created"));
    for (const secret of ["Case file", "EXP", "Customer", "{field:customer}"])
      expect(text).not.toContain(secret);
  });
});

const templatesOf = (as: TestClient, unitId?: string) =>
  as.request("GET", unitId ? `/api/v1/record-templates?unitId=${unitId}` : "/api/v1/record-templates");
const createTemplate = (as: TestClient, body: Json) => as.request("POST", "/api/v1/record-templates", body);
const patchTemplate = (as: TestClient, id: string, body: Json) =>
  as.request("PATCH", `/api/v1/record-templates/${id}`, body);
const deleteTemplate = (as: TestClient, id: string) => as.request("DELETE", `/api/v1/record-templates/${id}`);
const templateRow = async (id: string) =>
  (await su.query("select * from app.record_templates where id = $1", [id])).rows[0] as Json | undefined;
const conversationCount = async (name: string) =>
  (await su.query("select count(*)::int as n from app.conversations where name = $1", [name])).rows[0].n;

/** Set by the permission matrix and reused by the scope, validation and cross-tenant cases. */
let opsRunbook: Json;
let departmentFile: Json;
let financeFile: Json;
let orgIntake: Json;

describe("who manages templates (D-07, D-08, T-07.1-07-01)", () => {
  it("a plain member of Ops can neither create nor change Ops templates", async () => {
    await fails(createTemplate(mia, { unitId: ops, name: "Mia's file" }), 403);
    await fails(patchTemplate(mia, caseTemplate.id, { expectedVersion: 1, name: "Taken over" }), 403);
    await fails(deleteTemplate(mia, caseTemplate.id), 403);
    expect(
      (await su.query("select count(*)::int as n from app.record_templates where name = $1", ["Mia's file"]))
        .rows[0].n,
    ).toBe(0);
    expect(await templateRow(caseTemplate.id)).toMatchObject({ name: "Case file", version: 1 });
  });

  it("leads manage their subtree, admins everything, organization-wide needs unit.manage", async () => {
    // Dana leads Ops only: not Finance, not organization-wide.
    await fails(createTemplate(dana, { unitId: finance, name: "Dana's finance file" }), 403);
    await fails(createTemplate(dana, { unitId: null, name: "Dana's org file" }), 403);
    // Leo leads Operations, Ops' parent: Ops and Operations are both his.
    opsRunbook = await ok(createTemplate(leo, { unitId: ops, name: "Ops runbook" }));
    expect(opsRunbook).toMatchObject({ unitId: ops, prefix: null, namingRule: null, fields: [], version: 1 });
    expect(opsRunbook.columns.map((c: Json) => c.name)).toEqual([
      "Backlog",
      "In progress",
      "Done",
      "Cancelled",
    ]);
    opsRunbook = await ok(
      patchTemplate(leo, opsRunbook.id, { expectedVersion: 1, description: "Night shift checklist" }),
    );
    expect(opsRunbook).toMatchObject({ version: 2, description: "Night shift checklist" });
    departmentFile = await ok(createTemplate(leo, { unitId: operations, name: "Department file" }));
    await fails(createTemplate(leo, { unitId: finance, name: "Leo's finance file" }), 403);
    // The admin: any unit (the same name as Ops' template is fine in Finance) and organization-wide.
    financeFile = await ok(createTemplate(victor, caseFile(finance)));
    orgIntake = await ok(createTemplate(victor, { unitId: null, name: "Org intake" }));
    expect(orgIntake.unitId).toBeNull();
    await fails(patchTemplate(dana, financeFile.id, { expectedVersion: 1, name: "Moved" }), 403);
    await fails(deleteTemplate(dana, financeFile.id), 403);
    await fails(patchTemplate(dana, orgIntake.id, { expectedVersion: 1, name: "Moved" }), 403);
    await fails(deleteTemplate(leo, orgIntake.id), 403);
    expect(await templateRow(financeFile.id)).toMatchObject({ name: "Case file", version: 1 });
    expect(await templateRow(orgIntake.id)).toMatchObject({ name: "Org intake", version: 1 });
  });

  it("every member lists what Ops may use; canManage only for leads of the path and admins", async () => {
    const forMia = await ok(templatesOf(mia, ops));
    // Organization-wide first, then root → self (Operations, then Ops); never Finance's.
    expect(forMia.templates.map((t: Json) => [t.unitId, t.name])).toEqual([
      [null, "Org intake"],
      [operations, "Department file"],
      [ops, "Case file"],
      [ops, "Ops runbook"],
    ]);
    expect(forMia.canManage).toBe(false);
    expect((await ok(templatesOf(dana, ops))).canManage).toBe(true);
    expect((await ok(templatesOf(leo, ops))).canManage).toBe(true);
    expect((await ok(templatesOf(victor, ops))).canManage).toBe(true);
    // Dana does not lead Operations (her team's parent) nor Finance.
    expect((await ok(templatesOf(dana, operations))).canManage).toBe(false);
    const forFinance = await ok(templatesOf(dana, finance));
    expect(forFinance.templates.map((t: Json) => t.id)).toEqual([orgIntake.id, financeFile.id]);
    expect(forFinance.canManage).toBe(false);

    const orgWide = await ok(templatesOf(dana));
    expect(orgWide.templates.map((t: Json) => t.id)).toEqual([orgIntake.id]);
    expect(orgWide.canManage).toBe(false);
    expect((await ok(templatesOf(victor))).canManage).toBe(true);
    expect((await fails(templatesOf(mia, randomUUID()), 404)).code).toBe("unit_not_found");
  });
});

describe("which channels may use a template (P-08, T-07.1-07-02)", () => {
  it("own unit, an ancestor or the organization; anything else is the same 400", async () => {
    const refused = async (name: string, extra: Json) => {
      expect((await fails(boardChannel(victor, name, extra), 400)).code, name).toBe("template_not_available");
      expect(await conversationCount(name), name).toBe(0);
    };
    await refused("fin-cases", { unitId: finance, templateId: caseTemplate.id });
    await refused("org-cases", { templateId: caseTemplate.id });
    await refused("ops-ghost", { unitId: ops, templateId: randomUUID() });

    // An ancestor's template, used by a plain member of the child team.
    const fromParent = await ok(
      boardChannel(mia, "ops-dept", { unitId: ops, templateId: departmentFile.id }),
    );
    const snap = await snapshot(mia, fromParent.id);
    expect(snap.board).toMatchObject({ templateId: departmentFile.id, prefix: null, namingRule: null });
    expect(snap.columns.map((c: Json) => c.name)).toEqual(["Backlog", "In progress", "Done", "Cancelled"]);
    // An organization-wide template, anywhere.
    await ok(boardChannel(victor, "fin-intake", { unitId: finance, templateId: orgIntake.id }));
    await ok(boardChannel(victor, "org-intake", { templateId: orgIntake.id }));

    // A text channel never takes a template (schema).
    const text = await fails(
      victor.request("POST", "/api/v1/channels", {
        name: "text-tpl",
        visibility: "public",
        templateId: orgIntake.id,
      }),
      400,
    );
    expect(text.code).toBe("validation_error");
    expect(await conversationCount("text-tpl")).toBe(0);
  });
});

describe("template validation (D-06, T-07.1-07-03)", () => {
  it("refuses bad prefixes, rules, fields and columns with the contract's messages, and duplicate names", async () => {
    const refused = async (body: Json, needle: string) => {
      const e = await fails(createTemplate(dana, { unitId: ops, name: "Bad", ...body }), 400);
      expect(e.code).toBe("validation_error");
      expect(JSON.stringify(e.details), needle).toContain(needle);
    };
    const customer = { key: "customer", label: "Customer", type: "text" };
    await refused({ prefix: "exp" }, "1 to 8 capital letters or digits");
    await refused({ prefix: "EXP", namingRule: "{prefix}-{seq} · {field:missing}" }, "Unknown field");
    await refused({ namingRule: "{nope}" }, "Unknown token {nope}");
    await refused({ namingRule: "{prefix}-{seq} · {summary}" }, "{prefix} and {seq} need a prefix");
    await refused({ fields: [customer, { ...customer, label: "Client" }] }, 'Duplicate field \\"customer\\"');
    await refused({ columns: [] }, "columns");
    await refused(
      {
        columns: [
          { name: "Intake", category: "backlog" },
          { name: "intake", category: "started" },
        ],
      },
      'Duplicate column \\"intake\\"',
    );
    expect(
      (await su.query("select count(*)::int as n from app.record_templates where name = 'Bad'")).rows[0].n,
    ).toBe(0);

    expect((await fails(createTemplate(dana, caseFile(ops)), 409)).code).toBe("template_exists");
    expect((await fails(createTemplate(dana, caseFile(ops, { name: "CASE FILE" })), 409)).code).toBe(
      "template_exists",
    );
    expect((await fails(createTemplate(victor, { unitId: null, name: "org intake" }), 409)).code).toBe(
      "template_exists",
    );
  });

  it("re-checks the merged template on every update", async () => {
    const merged = async (id: string, body: Json, needle: string) => {
      const e = await fails(patchTemplate(dana, id, body), 400);
      expect(e.code).toBe("invalid_naming_rule");
      expect(e.message).toContain(needle);
    };
    // Dropping the field the rule names, or the prefix it numbers with.
    await merged(caseTemplate.id, { expectedVersion: 1, fields: [] }, 'Unknown field "customer"');
    await merged(caseTemplate.id, { expectedVersion: 1, prefix: null }, "{prefix} and {seq} need a prefix");
    // A numbered rule on a template that has no prefix.
    await merged(
      opsRunbook.id,
      { expectedVersion: opsRunbook.version, namingRule: "{prefix}-{seq} · {summary}" },
      "{prefix} and {seq} need a prefix",
    );
    expect(
      (
        await fails(
          patchTemplate(dana, opsRunbook.id, { expectedVersion: opsRunbook.version, name: "case file" }),
          409,
        )
      ).code,
    ).toBe("template_exists");
    expect((await fails(patchTemplate(dana, caseTemplate.id, { expectedVersion: 1 }), 400)).code).toBe(
      "validation_error",
    );
    expect(await templateRow(caseTemplate.id)).toMatchObject({ version: 1, prefix: "EXP" });
    expect(await templateRow(opsRunbook.id)).toMatchObject({
      version: opsRunbook.version,
      name: "Ops runbook",
    });
  });
});

describe("versions and snapshots (D-06, T-07.1-07-04)", () => {
  it("a stale edit gets the current template; edits and deletion never touch #cases", async () => {
    const columns = caseTemplate.columns.map((c: Json, i: number) =>
      i === 0 ? { ...c, name: "New intake" } : c,
    );
    const edited = await ok(
      patchTemplate(dana, caseTemplate.id, { expectedVersion: 1, prefix: "CASE", columns }),
    );
    expect(edited).toMatchObject({ version: 2, prefix: "CASE", namingRule: CASE_RULE });
    expect(edited.columns[0].name).toBe("New intake");

    // The editor's "Reload template" uses the template the 409 carries.
    const stale = await fails(
      patchTemplate(dana, caseTemplate.id, { expectedVersion: 1, name: "Stale" }),
      409,
    );
    expect(stale.code).toBe("template_version_conflict");
    expect(RecordTemplate.parse(stale.details.template)).toEqual(edited);

    expect(await ok(deleteTemplate(dana, caseTemplate.id))).toEqual({ ok: true });
    expect((await fails(deleteTemplate(dana, caseTemplate.id), 404)).code).toBe("template_not_found");
    expect(
      (await fails(patchTemplate(dana, caseTemplate.id, { expectedVersion: 2, name: "Back" }), 404)).code,
    ).toBe("template_not_found");
    expect((await ok(templatesOf(dana, ops))).templates.map((t: Json) => t.id)).not.toContain(
      caseTemplate.id,
    );

    // #cases keeps its snapshot: columns, prefix EXP, rule and numbering.
    const snap = await snapshot(victor, casesBoardId);
    expect(snap.board).toMatchObject({ templateId: null, prefix: "EXP", namingRule: CASE_RULE });
    expect(snap.columns.map((c: Json) => c.name)).toEqual([
      "Intake",
      "Waiting for customer",
      "Closed",
      "Dropped",
    ]);
    const row = (
      await su.query("select template_id, prefix from app.boards where conversation_id = $1", [casesBoardId])
    ).rows[0];
    expect(row).toEqual({ template_id: null, prefix: "EXP" });
    const third = await ok(
      card(victor, casesBoardId, { description: "Next case", fields: { customer: "Acme" } }),
    );
    expect(third).toMatchObject({ title: "EXP-0003 · Acme · Next case", number: 3 });

    expect(
      (await fails(boardChannel(victor, "cases-2", { unitId: ops, templateId: caseTemplate.id }), 400)).code,
    ).toBe("template_not_available");
  });
});

describe("record templates across tenants (BOARD-04, P-10)", () => {
  /** Every template route of this plan, called by org B's admin with org A's ids (07.1-14 mirrors this table). */
  const TEMPLATE_CROSS_TENANT_ROUTES: ReadonlyArray<{
    name: string;
    status: number;
    code: string;
    call: (c: TestClient, ids: { unitId: string; templateId: string }) => Promise<Res>;
  }> = [
    {
      name: "GET /record-templates?unitId=",
      status: 404,
      code: "unit_not_found",
      call: (c, i) => templatesOf(c, i.unitId),
    },
    {
      name: "POST /record-templates",
      status: 404,
      code: "unit_not_found",
      call: (c, i) => createTemplate(c, { unitId: i.unitId, name: "Planted" }),
    },
    {
      name: "PATCH /record-templates/:id",
      status: 404,
      code: "template_not_found",
      call: (c, i) => patchTemplate(c, i.templateId, { expectedVersion: 2, name: "Planted" }),
    },
    {
      name: "DELETE /record-templates/:id",
      status: 404,
      code: "template_not_found",
      call: (c, i) => deleteTemplate(c, i.templateId),
    },
    {
      name: "POST /channels with templateId",
      status: 400,
      code: "template_not_available",
      call: (c, i) => boardChannel(c, "stolen", { templateId: i.templateId }),
    },
  ];

  it("org B's admin never reaches org A's templates and they are unchanged", async () => {
    const before = (await su.query("select * from app.record_templates order by id")).rows;
    for (const tpl of [opsRunbook, orgIntake]) {
      for (const route of TEMPLATE_CROSS_TENANT_ROUTES) {
        const res = await route.call(eve, { unitId: ops, templateId: tpl.id });
        expect(res.status, route.name).toBe(route.status);
        expect(((res.body as Json).error as Json).code, route.name).toBe(route.code);
        expect(JSON.stringify(res.body), route.name).not.toContain(tpl.name);
      }
    }
    // Org B sees none of org A's organization-wide templates.
    expect((await ok(templatesOf(eve))).templates).toEqual([]);
    expect((await su.query("select * from app.record_templates order by id")).rows).toEqual(before);
    expect(await conversationCount("stolen")).toBe(0);
  });
});

describe("template audits (principle 12, T-07.1-07-05)", () => {
  it("every write is audited with ids, version and counts only", async () => {
    const audits = await auditsOf([
      "record_template.created",
      "record_template.updated",
      "record_template.deleted",
    ]);
    expect(audits.filter((a) => a.action === "record_template.created")).toHaveLength(5);
    for (const a of audits) {
      expect(Object.keys(a.metadata).sort(), a.action).toEqual([
        "columnCount",
        "fieldCount",
        "templateId",
        "unitId",
        "version",
      ]);
    }
    const ofCase = audits.filter((a) => a.metadata.templateId === caseTemplate.id);
    expect(
      ofCase.map((a) => [a.action, a.metadata.version, a.metadata.fieldCount, a.metadata.columnCount]),
    ).toEqual([
      ["record_template.created", 1, 1, 4],
      ["record_template.updated", 2, 1, 4],
      ["record_template.deleted", 2, 1, 4],
    ]);
    const text = JSON.stringify(audits);
    for (const secret of ["Case file", "EXP", "CASE", "Customer", "Ops runbook", "Night shift"]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
