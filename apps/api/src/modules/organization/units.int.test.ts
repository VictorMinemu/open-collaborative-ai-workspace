import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dev: TestClient;
let orgId: string;
let devId: string;

type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return r.body as Record<string, any>;
}

/** The error code of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  return (r.body as Record<string, any>).error as { code: string; details?: Record<string, unknown> };
}

const audit = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action])).rows;

const orgEvents = async () =>
  (
    await su.query("select type, payload from app.stream_events where stream_id = $1 order by seq", [
      `org:${orgId}`,
    ])
  ).rows as Array<{ type: string; payload: { unitId: string; action: string } }>;

async function invite(email: string, role: string, name: string) {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id as string };
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
  ({ client: dev, id: devId } = await invite("dev@example.test", "developer", "Dana Dev"));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("units: build and rearrange the hierarchy", () => {
  let it_: string;
  let backend: string;
  let alpha: string;
  let marketing: string;

  it("admin creates department → team → project with materialised paths", async () => {
    const itUnit = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "IT", parentId: null }),
    );
    it_ = itUnit.id;
    expect(itUnit).toMatchObject({ kind: "department", name: "IT", parentId: null, path: [it_] });
    // ADR-0024: the Modules card shows from `unit.modules.manage` in viewerCan (07.3-02).
    expect(itUnit.viewerCan).toEqual(["unit.manage", "unit.members.manage", "unit.modules.manage"]);

    const be = await ok(
      admin.request("POST", "/api/v1/units", { kind: "team", name: "Backend", parentId: it_ }),
    );
    backend = be.id;
    expect(be.path).toEqual([it_, backend]);

    const al = await ok(
      admin.request("POST", "/api/v1/units", { kind: "project", name: "Alpha", parentId: backend }),
    );
    alpha = al.id;
    expect(al.path).toEqual([it_, backend, alpha]);

    const list = await ok(admin.request("GET", "/api/v1/units"));
    expect(list.units.map((u: { name: string }) => u.name)).toEqual(["IT", "Backend", "Alpha"]);
    for (const u of list.units) expect(u).toMatchObject({ memberCount: 0, leadCount: 0 });
    expect(list.lastSeq).toBeGreaterThanOrEqual(3);
  });

  it("enforces kind rules, sibling names and tenant-scoped parents", async () => {
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "team", name: "Loose", parentId: null }),
          400,
        )
      ).code,
    ).toBe("invalid_parent_kind");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "team", name: "Under project", parentId: alpha }),
          400,
        )
      ).code,
    ).toBe("invalid_parent_kind");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", { kind: "department", name: "it", parentId: null }),
          409,
        )
      ).code,
    ).toBe("unit_name_taken");
    expect(
      (
        await fails(
          admin.request("POST", "/api/v1/units", {
            kind: "team",
            name: "Ghost",
            parentId: "01900000-0000-7000-8000-000000000000",
          }),
          404,
        )
      ).code,
    ).toBe("unit_not_found");
  });

  it("moving a unit rewrites its whole subtree in one transaction", async () => {
    const mk = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Marketing", parentId: null }),
    );
    marketing = mk.id;
    const moved = await ok(admin.request("POST", `/api/v1/units/${backend}/move`, { parentId: marketing }));
    expect(moved).toMatchObject({ id: backend, parentId: marketing, path: [marketing, backend] });

    const list = await ok(admin.request("GET", "/api/v1/units"));
    const byId = new Map(list.units.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(alpha)).toMatchObject({ parentId: backend, path: [marketing, backend, alpha] });
    expect(byId.get(it_)).toMatchObject({ path: [it_] });
    const db = await su.query("select path from app.org_units where id = $1", [alpha]);
    expect(db.rows[0].path).toEqual([marketing, backend, alpha]);
  });

  it("audits every change and emits units.updated on the org topic", async () => {
    const created = await audit("unit.created");
    expect(created).toHaveLength(4);
    expect(created.every((r) => r.result === "success" && r.organization_id === orgId)).toBe(true);
    expect(created[1].metadata).toMatchObject({ name: "Backend", kind: "team", parentId: it_ });

    const moved = await audit("unit.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ resource_id: backend, result: "success" });
    expect(moved[0].metadata).toMatchObject({ fromParentId: it_, toParentId: marketing });

    const events = (await orgEvents()).filter((e) => e.type === "units.updated");
    expect(events.map((e) => e.payload.action)).toEqual([
      "created",
      "created",
      "created",
      "created",
      "moved",
    ]);
    expect(events.at(-1)?.payload.unitId).toBe(backend);
  });

  it("a developer reads the tree but cannot change it (403, audited)", async () => {
    const list = await ok(dev.request("GET", "/api/v1/units"));
    expect(list.units).toHaveLength(4);
    expect(list.units[0].viewerCan).toEqual([]);

    const denied = await fails(
      dev.request("POST", "/api/v1/units", { kind: "department", name: "Shadow", parentId: null }),
      403,
    );
    expect(denied.details).toMatchObject({ permission: "unit.manage" });
    await fails(dev.request("POST", `/api/v1/units/${backend}/move`, { parentId: it_ }), 403);

    const rows = await audit("authz.denied");
    const mine = rows.filter((r) => r.user_id === devId && r.metadata.permission === "unit.manage");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect((await su.query("select count(*)::int as n from app.org_units")).rows[0].n).toBe(4);
  });
});

describe("units: rename, delete, concurrency and memberships with leads", () => {
  let lead: TestClient;
  let leadId: string;
  let samId: string;
  let eng: string;
  let core: string;
  let infra: string;
  let sales: string;

  const create = async (kind: string, name: string, parentId: string | null) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

  beforeAll(async () => {
    ({ client: lead, id: leadId } = await invite("lena@example.test", "lead", "Lena Lead"));
    ({ id: samId } = await invite("sam@example.test", "standard", "Sam Standard"));
    eng = await create("department", "Engineering", null);
    core = await create("team", "Core", eng);
    infra = await create("team", "Infra", eng);
    sales = await create("department", "Sales", null);
  });

  it("renames a unit; a case-insensitive sibling clash is 409", async () => {
    const renamed = await ok(admin.request("PATCH", `/api/v1/units/${core}`, { name: "Core Platform" }));
    expect(renamed).toMatchObject({ id: core, name: "Core Platform" });
    expect(
      (await fails(admin.request("PATCH", `/api/v1/units/${infra}`, { name: "core platform" }), 409)).code,
    ).toBe("unit_name_taken");
    const rows = await audit("unit.renamed");
    expect(rows.at(-1)?.metadata).toMatchObject({ from: "Core", to: "Core Platform" });
    await fails(dev.request("PATCH", `/api/v1/units/${core}`, { name: "Mine" }), 403);
  });

  it("deletes only leaves; memberships and scoped rules go with the unit and are listed in the audit", async () => {
    expect((await fails(admin.request("DELETE", `/api/v1/units/${eng}`), 409)).code).toBe(
      "unit_has_children",
    );
    const tmp = await create("project", "Temp", core);
    await ok(admin.request("POST", `/api/v1/units/${tmp}/members`, { userId: devId }));
    const rule = await su.query(
      `insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, permission, effect)
       values ($1, $2, 'everyone', 'channel.create', 'deny') returning id`,
      [orgId, tmp],
    );
    const ruleId = rule.rows[0].id as string;

    await fails(dev.request("DELETE", `/api/v1/units/${tmp}`), 403);
    await ok(admin.request("DELETE", `/api/v1/units/${tmp}`));
    expect((await su.query("select 1 from app.org_units where id = $1", [tmp])).rowCount).toBe(0);
    expect((await su.query("select 1 from app.unit_memberships where unit_id = $1", [tmp])).rowCount).toBe(0);
    expect((await su.query("select 1 from app.permission_rules where id = $1", [ruleId])).rowCount).toBe(0);
    const [row] = await audit("unit.deleted");
    expect(row).toMatchObject({ resource_id: tmp, result: "success" });
    expect(row.metadata).toMatchObject({ name: "Temp", removedMemberIds: [devId], removedRuleIds: [ruleId] });
    expect((await fails(admin.request("DELETE", `/api/v1/units/${tmp}`), 404)).code).toBe("unit_not_found");
  });

  it("two opposite concurrent moves: exactly one wins, the other is unit_cycle, the tree has no cycle", async () => {
    for (let round = 0; round < 5; round += 1) {
      const a = await create("department", `A${round}`, null);
      const b = await create("department", `B${round}`, null);
      const results = await Promise.all([
        admin.request("POST", `/api/v1/units/${a}/move`, { parentId: b }),
        admin.request("POST", `/api/v1/units/${b}/move`, { parentId: a }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)?.body as { error: { code: string } } | undefined;
      expect(loser?.error.code).toBe("unit_cycle");
    }
    const rows = (await su.query("select id, parent_id, path from app.org_units")).rows as Array<{
      id: string;
      parent_id: string | null;
      path: string[];
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      expect(r.path.at(-1)).toBe(r.id);
      expect(new Set(r.path).size).toBe(r.path.length);
      expect(r.path.slice(0, -1)).toEqual(r.parent_id ? byId.get(r.parent_id)?.path : []);
    }
  });

  it("admin adds members and appoints leads; only lead/admin org roles can lead", async () => {
    const added = await ok(admin.request("POST", `/api/v1/units/${core}/members`, { userId: devId }));
    expect(added).toMatchObject({ userId: devId, role: "member", orgRole: "developer", status: "active" });
    expect(
      (await fails(admin.request("POST", `/api/v1/units/${core}/members`, { userId: devId }), 409)).code,
    ).toBe("already_member");
    expect(
      (
        await fails(
          admin.request("POST", `/api/v1/units/${core}/members`, { userId: samId, role: "lead" }),
          400,
        )
      ).code,
    ).toBe("lead_requires_role");
    expect(
      (
        await fails(
          admin.request("POST", `/api/v1/units/${core}/members`, {
            userId: "01900000-0000-7000-8000-000000000000",
          }),
          400,
        )
      ).code,
    ).toBe("unknown_member");
    await ok(admin.request("POST", `/api/v1/units/${eng}/members`, { userId: leadId, role: "lead" }));
    expect(
      (await fails(admin.request("PATCH", `/api/v1/units/${core}/members/${devId}`, { role: "lead" }), 400))
        .code,
    ).toBe("lead_requires_role");

    const list = await ok(admin.request("GET", "/api/v1/units"));
    const byId = new Map(list.units.map((u: { id: string }) => [u.id, u]));
    expect(byId.get(eng)).toMatchObject({ memberCount: 1, leadCount: 1 });
    expect(byId.get(core)).toMatchObject({ memberCount: 1, leadCount: 0 });
  });

  it("a lead manages members of their own subtree only and cannot appoint leads", async () => {
    const view = await ok(lead.request("GET", "/api/v1/units"));
    const byId = new Map(view.units.map((u: { id: string; viewerCan: string[] }) => [u.id, u.viewerCan]));
    // ADR-0024: a lead also manages modules on the units they lead (07.3-02).
    expect(byId.get(eng)).toEqual(["unit.members.manage", "unit.modules.manage"]);
    expect(byId.get(core)).toEqual(["unit.members.manage", "unit.modules.manage"]);
    expect(byId.get(sales)).toEqual([]);

    await ok(lead.request("POST", `/api/v1/units/${core}/members`, { userId: samId }));
    const members = await ok(lead.request("GET", `/api/v1/units/${core}/members`));
    expect(members.members).toEqual([
      expect.objectContaining({
        userId: devId,
        displayName: "Dana Dev",
        orgRole: "developer",
        role: "member",
      }),
      expect.objectContaining({
        userId: samId,
        displayName: "Sam Standard",
        avatarUrl: null,
        orgRole: "standard",
        role: "member",
        status: "active",
      }),
    ]);
    await ok(lead.request("DELETE", `/api/v1/units/${core}/members/${samId}`));

    const sibling = await fails(
      lead.request("POST", `/api/v1/units/${sales}/members`, { userId: samId }),
      403,
    );
    expect(sibling.details).toMatchObject({ permission: "unit.members.manage" });
    const appoint = await fails(
      lead.request("POST", `/api/v1/units/${infra}/members`, { userId: leadId, role: "lead" }),
      403,
    );
    expect(appoint.details).toMatchObject({ permission: "unit.manage" });
    await fails(lead.request("PATCH", `/api/v1/units/${core}/members/${devId}`, { role: "member" }), 403);
    await fails(lead.request("POST", "/api/v1/units", { kind: "team", name: "Lena's", parentId: eng }), 403);
    // A lead cannot strip lead authority either (the same decision as appointing).
    await fails(lead.request("DELETE", `/api/v1/units/${eng}/members/${leadId}`), 403);
    // A plain member manages nobody.
    await fails(dev.request("POST", `/api/v1/units/${core}/members`, { userId: samId }), 403);
  });

  it("role changes and removals are audited in the same transaction and emit units.updated", async () => {
    await ok(admin.request("POST", `/api/v1/units/${core}/members`, { userId: leadId }));
    const promoted = await ok(
      admin.request("PATCH", `/api/v1/units/${core}/members/${leadId}`, { role: "lead" }),
    );
    expect(promoted).toMatchObject({ userId: leadId, role: "lead", orgRole: "lead" });
    await ok(admin.request("DELETE", `/api/v1/units/${core}/members/${leadId}`));
    expect((await fails(admin.request("DELETE", `/api/v1/units/${core}/members/${leadId}`), 404)).code).toBe(
      "not_a_unit_member",
    );

    const changed = await audit("unit_membership.role_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].metadata).toMatchObject({ unitId: core, userId: leadId, from: "member", to: "lead" });
    const addedRows = await audit("unit_membership.added");
    expect(addedRows.map((r) => r.metadata.userId)).toEqual(expect.arrayContaining([devId, leadId, samId]));
    const removed = await audit("unit_membership.removed");
    expect(removed.map((r) => r.metadata.userId)).toEqual([samId, leadId]);
    expect(removed[0].user_id).toBe(leadId); // the lead who removed Sam is the actor

    const events = (await orgEvents()).filter(
      (e) => e.type === "units.updated" && e.payload.action === "members",
    );
    expect(events.length).toBe(addedRows.length + changed.length + removed.length);
  });
});

describe("units: memory blocks a delete like bots do (Phase 07.2, MEM-01)", () => {
  const create = async (name: string) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind: "department", name, parentId: null })))
      .id as string;

  /** A unit memory scope with its root file, as the memory module creates it (system author, version 1). */
  async function scopeWithRoot(unitId: string): Promise<string> {
    const scope = (
      await su.query(
        "insert into app.memory_scopes (organization_id, kind, unit_id) values ($1, 'unit', $2) returning id",
        [orgId, unitId],
      )
    ).rows[0].id as string;
    await addFile(scope, "MEMORY.md", "# Memory\n");
    return scope;
  }

  async function addFile(scopeId: string, path: string, content: string, version = 1, author = "system") {
    return (
      await su.query(
        `insert into app.memory_files (organization_id, scope_id, path, content, version, bytes, updated_by_kind)
         values ($1, $2, $3, $4, $5, octet_length($4), $6) returning id`,
        [orgId, scopeId, path, content, version, author],
      )
    ).rows[0].id as string;
  }

  const exists = async (table: string, id: string) =>
    (await su.query(`select 1 from app.${table} where id = $1`, [id])).rowCount === 1;

  it("a unit with no memory scope, or only the untouched MEMORY.md, deletes and its scope cascades", async () => {
    const bare = await create("Bare");
    await ok(admin.request("DELETE", `/api/v1/units/${bare}`));
    const fresh = await create("Fresh");
    const scope = await scopeWithRoot(fresh);
    await ok(admin.request("DELETE", `/api/v1/units/${fresh}`));
    expect(await exists("org_units", fresh)).toBe(false);
    expect(await exists("memory_scopes", scope)).toBe(false);
    expect((await su.query("select 1 from app.memory_files where scope_id = $1", [scope])).rowCount).toBe(0);
  });

  it("a second file, an edited MEMORY.md or a root touched by a person is 409 unit_has_memory; nothing changes", async () => {
    const scopeOf = async (unitId: string) =>
      (
        await su.query(
          "insert into app.memory_scopes (organization_id, kind, unit_id) values ($1, 'unit', $2) returning id",
          [orgId, unitId],
        )
      ).rows[0].id as string;
    // A second file next to the untouched root.
    const withFile = await create("With File");
    const scopeA = await scopeWithRoot(withFile);
    const extra = await addFile(scopeA, "notes/plan.md", "plan", 1, "user");
    // The root edited (version 2).
    const edited = await create("Edited Root");
    const scopeB = await scopeOf(edited);
    const rootB = await addFile(scopeB, "MEMORY.md", "# Memory\nkeep this\n", 2, "user");
    // The root with the template content but written by a person (version 1).
    const touched = await create("Touched Root");
    const scopeC = await scopeOf(touched);
    const rootC = await addFile(scopeC, "MEMORY.md", "# Memory\n", 1, "user");
    const eventsBefore = (await orgEvents()).length;
    const auditsBefore = (await audit("unit.deleted")).length;

    for (const [unitId, scopeId, fileId] of [
      [withFile, scopeA, extra],
      [edited, scopeB, rootB],
      [touched, scopeC, rootC],
    ] as const) {
      const err = await fails(admin.request("DELETE", `/api/v1/units/${unitId}`), 409);
      expect(err.code).toBe("unit_has_memory");
      expect(await exists("org_units", unitId)).toBe(true);
      expect(await exists("memory_scopes", scopeId)).toBe(true);
      expect(await exists("memory_files", fileId)).toBe(true);
    }
    expect((await orgEvents()).length).toBe(eventsBefore);
    expect((await audit("unit.deleted")).length).toBe(auditsBefore);

    // Once the extra file is deleted, only the untouched root is left: the unit deletes and its scope cascades.
    await su.query("update app.memory_files set deleted_at = now() where id = $1", [extra]);
    await ok(admin.request("DELETE", `/api/v1/units/${withFile}`));
    expect(await exists("memory_scopes", scopeA)).toBe(false);
  });
});
