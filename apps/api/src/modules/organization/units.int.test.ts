import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dev: TestClient;
let orgId: string;
let devId: string;
let adminId: string;

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
  adminId = setup.user.id;
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
    expect(itUnit.viewerCan).toEqual([
      "unit.read",
      "unit.manage",
      "unit.members.manage",
      "unit.modules.manage",
    ]);

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
    // D-13 (Phase 07.9): only the project gets its creator, as its lead; departments and teams start empty.
    const counts = Object.fromEntries(
      list.units.map((u: { name: string; memberCount: number; leadCount: number }) => [
        u.name,
        [u.memberCount, u.leadCount],
      ]),
    );
    expect(counts).toEqual({ IT: [0, 0], Backend: [0, 0], Alpha: [1, 1] });
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
    // WR-09: reading (and so mentioning) the unit is reported too.
    expect(list.units[0].viewerCan).toEqual(["unit.read"]);

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
    // The creator (auto-lead, D-13) and the added developer both go with it.
    expect(row.metadata).toMatchObject({ name: "Temp", removedRuleIds: [ruleId] });
    expect([...row.metadata.removedMemberIds].sort()).toEqual([adminId, devId].sort());
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
    expect(byId.get(eng)).toEqual(["unit.read", "unit.members.manage", "unit.modules.manage"]);
    expect(byId.get(core)).toEqual(["unit.read", "unit.members.manage", "unit.modules.manage"]);
    expect(byId.get(sales)).toEqual(["unit.read"]);

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
    // A project creator's auto-lead (D-13) rides its unit's "created" event; every member route emits "members".
    const routeAdded = addedRows.filter((r) => r.metadata.userId !== adminId);
    expect(addedRows.length - routeAdded.length).toBe(2); // Alpha and Temp, both created by the admin
    expect(events.length).toBe(routeAdded.length + changed.length + removed.length);
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

  it("a second file or an edited MEMORY.md is 409 unit_has_memory; nothing changes", async () => {
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
    const eventsBefore = (await orgEvents()).length;
    const auditsBefore = (await audit("unit.deleted")).length;

    for (const [unitId, scopeId, fileId] of [
      [withFile, scopeA, extra],
      [edited, scopeB, rootB],
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

  it("a root a person edited back to the template (any version) does not block: MEMORY.md can never be deleted", async () => {
    // 07.2-08: the root can be edited but not deleted, so its content decides. Before this, one edit made the unit
    // undeletable forever (the version never returns to 1).
    const touched = await create("Touched Root");
    const scope = (
      await su.query(
        "insert into app.memory_scopes (organization_id, kind, unit_id) values ($1, 'unit', $2) returning id",
        [orgId, touched],
      )
    ).rows[0].id as string;
    await addFile(scope, "MEMORY.md", "# Memory\n", 3, "user");
    await ok(admin.request("DELETE", `/api/v1/units/${touched}`));
    expect(await exists("memory_scopes", scope)).toBe(false);
  });
});

describe("units: keys and live agent templates block a delete like bots do (Phase 07.4, 07.4-14)", () => {
  const create = async (name: string) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind: "department", name, parentId: null })))
      .id as string;
  const exists = async (table: string, id: string) =>
    (await su.query(`select 1 from app.${table} where id = $1`, [id])).rowCount === 1;

  /** A unit key, as the keychain stores it (07.4-07): RESTRICT on its unit. */
  async function unitKey(unitId: string, handle: string): Promise<string> {
    const secretId = (
      await su.query(
        "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, 'unit key', 'vault_item', 'c', 'i', 't') returning id",
        [orgId],
      )
    ).rows[0].id as string;
    return (
      await su.query(
        `insert into app.vault_items (organization_id, scope, unit_id, name, handle, kind, injection, allowed_hosts, secret_ref)
         values ($1, 'unit', $2, 'ERP', $3, 'api_key', '{"header":"Authorization","scheme":"bearer"}', '{erp.example.test}', $4::jsonb)
         returning id`,
        [orgId, unitId, handle, JSON.stringify({ provider: "db", secretId, organizationId: orgId })],
      )
    ).rows[0].id as string;
  }

  /** An agent template of the unit with its v1 (07.4-08): RESTRICT on its unit. */
  async function template(unitId: string, archived: boolean): Promise<string> {
    const id = (
      await su.query(
        "insert into app.agent_templates (organization_id, unit_id, name, description, current_version, archived_at) values ($1, $2, $3, 'd', 1, $4) returning id",
        [orgId, unitId, `T ${unitId.slice(0, 8)}`, archived ? new Date().toISOString() : null],
      )
    ).rows[0].id as string;
    await su.query(
      `insert into app.agent_template_versions (organization_id, template_id, version, instructions, model_provider, model_id, capabilities)
       values ($1, $2, 1, 'Help', 'mock', 'mock-1', '{"internet":false,"memory":true,"dailyLimit":null}')`,
      [orgId, id],
    );
    return id;
  }

  it("a unit key is 409 unit_has_keys and a live template 409 unit_has_templates (never a 500); nothing changes", async () => {
    const withKey = await create("With Key");
    const key = await unitKey(withKey, "k_unitkeyaaa");
    const withTemplate = await create("With Template");
    const live = await template(withTemplate, false);
    const auditsBefore = (await audit("unit.deleted")).length;
    expect((await fails(admin.request("DELETE", `/api/v1/units/${withKey}`), 409)).code).toBe(
      "unit_has_keys",
    );
    expect((await fails(admin.request("DELETE", `/api/v1/units/${withTemplate}`), 409)).code).toBe(
      "unit_has_templates",
    );
    expect(await exists("org_units", withKey)).toBe(true);
    expect(await exists("vault_items", key)).toBe(true);
    expect(await exists("org_units", withTemplate)).toBe(true);
    expect(await exists("agent_templates", live)).toBe(true);
    expect((await audit("unit.deleted")).length).toBe(auditsBefore);
  });

  it("archived templates go with the unit (their versions too); an agent started from one keeps its own copy", async () => {
    const unit = await create("Archived Only");
    const archived = await template(unit, true);
    const agent = (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, template_id, template_version) values ($1, 'From T', $2, 'Help', 'mock', 'mock-1', $3, 1) returning id",
        [orgId, `fromt${Date.now().toString(36)}`, archived],
      )
    ).rows[0].id as string;
    await ok(admin.request("DELETE", `/api/v1/units/${unit}`));
    expect(await exists("org_units", unit)).toBe(false);
    expect(await exists("agent_templates", archived)).toBe(false);
    expect(
      (await su.query("select 1 from app.agent_template_versions where template_id = $1", [archived]))
        .rowCount,
    ).toBe(0);
    expect((await su.query("select template_id from app.agents where id = $1", [agent])).rows[0]).toEqual({
      template_id: null,
    });
    expect((await audit("unit.deleted")).at(-1)?.metadata).toMatchObject({ removedTemplateIds: [archived] });
  });
});

describe("units: tool approval rules block a delete (07.5, WINDOWS #207)", () => {
  const create = async (name: string) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind: "department", name, parentId: null })))
      .id as string;
  const exists = async (table: string, id: string) =>
    (await su.query(`select 1 from app.${table} where id = $1`, [id])).rowCount === 1;
  const insertPolicy = (client: pg.Client, unitId: string, pattern: string) =>
    client.query(
      "insert into app.tool_approval_policies (organization_id, scope_unit_id, tool_pattern, mode, approver_kind) values ($1, $2, $3, 'always', 'admins') returning id",
      [orgId, unitId, pattern],
    );

  it("a unit with an approval rule is 409 unit_has_policies (never a cascade without its audit); nothing changes", async () => {
    const unit = await create("With Rule");
    const policy = (
      await ok(
        admin.request("POST", "/api/v1/tool-approval-policies", {
          scopeUnitId: unit,
          toolPattern: "ocw_http_request",
          mode: "always",
          approverKind: "admins",
        }),
        201,
      )
    ).id as string;
    const deletedBefore = (await audit("unit.deleted")).length;
    expect((await fails(admin.request("DELETE", `/api/v1/units/${unit}`), 409)).code).toBe(
      "unit_has_policies",
    );
    expect(await exists("org_units", unit)).toBe(true);
    expect(await exists("tool_approval_policies", policy)).toBe(true);
    expect((await audit("unit.deleted")).length).toBe(deletedBefore);

    // Once the rule is removed (audited by its own route), the unit deletes.
    await ok(admin.request("DELETE", `/api/v1/tool-approval-policies/${policy}?expectedVersion=1`), 204);
    await ok(admin.request("DELETE", `/api/v1/units/${unit}`));
    expect(await exists("org_units", unit)).toBe(false);
  });

  it("a rule committed while the delete waits is still seen: 409, not a silent cascade", async () => {
    const unit = await create("Racing Rule");
    const other = new pg.Client({ connectionString: stack.db.superuserUrl });
    await other.connect();
    try {
      await other.query("begin");
      // The rule's FK check holds a KEY SHARE lock on the unit row until this transaction ends.
      const policy = (await insertPolicy(other, unit, "ocw_http_request")).rows[0].id as string;
      const pending = admin.request("DELETE", `/api/v1/units/${unit}`);
      await new Promise((r) => setTimeout(r, 400));
      await other.query("commit");
      expect((await fails(pending, 409)).code).toBe("unit_has_policies");
      expect(await exists("org_units", unit)).toBe(true);
      expect(await exists("tool_approval_policies", policy)).toBe(true);
    } finally {
      await other.end();
    }
  });
});

describe("units: a team project with linked repositories (Phase 07.9, D-01, UI-SPEC U-7)", () => {
  const create = async (kind: string, name: string, parentId: string | null) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

  it("refuses unit_has_repositories while a repository is linked; unlinked, settings and teams go with it", async () => {
    const dept = await create("department", "Repos Dept", null);
    const team = await create("team", "Repos Team", dept);
    const project = await create("project", "Repos Project", team);
    const [admin_] = (await su.query("select user_id from app.org_members where role = 'admin' limit 1"))
      .rows;
    const adminId = admin_.user_id as string;
    // A device repository linked to the project (as POST /work-projects/:id/repos stores it).
    const device = (
      await su.query(
        `insert into app.devices (organization_id, owner_user_id, name, platform, token_hash)
         values ($1, $2, 'Bench', 'darwin', $3) returning id`,
        [orgId, devId, `hash-${Date.now()}`],
      )
    ).rows[0].id as string;
    const repo = (
      await su.query(
        "insert into app.projects (organization_id, device_id, local_id, name) values ($1, $2, 'r1', 'repo') returning id",
        [orgId, device],
      )
    ).rows[0].id as string;
    await su.query(
      "insert into app.work_project_repos (organization_id, project_id, device_id, unit_id, linked_by) values ($1, $2, $3, $4, $5)",
      [orgId, repo, device, project, adminId],
    );
    await su.query(
      "insert into app.work_project_settings (organization_id, unit_id, default_visibility, updated_by) values ($1, $2, 'owner', $3)",
      [orgId, project, adminId],
    );
    await su.query(
      "insert into app.work_project_teams (organization_id, project_unit_id, team_unit_id, assigned_by) values ($1, $2, $3, $4)",
      [orgId, project, dept, adminId],
    );
    const deletedBefore = (await audit("unit.deleted")).length;

    const refused = await fails(admin.request("DELETE", `/api/v1/units/${project}`), 409);
    expect(refused.code).toBe("unit_has_repositories");
    expect((await audit("unit.deleted")).length).toBe(deletedBefore);

    await su.query("delete from app.work_project_repos where project_id = $1", [repo]);
    await ok(admin.request("DELETE", `/api/v1/units/${project}`));
    for (const [table, col] of [
      ["work_project_settings", "unit_id"],
      ["work_project_teams", "project_unit_id"],
    ] as const) {
      expect(
        (await su.query(`select 1 from app.${table} where ${col} = $1`, [project])).rowCount,
        table,
      ).toBe(0);
    }
    // The repository row is the device's: it stays.
    expect((await su.query("select 1 from app.projects where id = $1", [repo])).rowCount).toBe(1);
  });
});

describe("units: a project created in Settings › Organization auto-leads its creator (Phase 07.9, D-13)", () => {
  const create = async (kind: string, name: string, parentId: string | null) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
  const memberships = async (unitId: string) =>
    (await su.query("select user_id, role from app.unit_memberships where unit_id = $1", [unitId])).rows;
  const memberAudits = async (unitId: string) =>
    (await audit("unit_membership.added")).filter((r) => r.resource_id === unitId);

  let dept: string;
  let team: string;

  beforeAll(async () => {
    dept = await create("department", "Auto Lead Dept", null);
    team = await create("team", "Auto Lead Team", dept);
  });

  it("POST /units kind=project makes the creator its lead, audited with ids only, like POST /work-projects", async () => {
    const created = await ok(
      admin.request("POST", "/api/v1/units", { kind: "project", name: "Lead Portal", parentId: team }),
    );
    expect(created).toMatchObject({ kind: "project", memberCount: 1, leadCount: 1 });
    expect(await memberships(created.id)).toEqual([{ user_id: adminId, role: "lead" }]);
    const added = await memberAudits(created.id);
    expect(added.map((r) => [r.user_id, r.result, r.metadata])).toEqual([
      [adminId, "success", { unitId: created.id, userId: adminId, role: "lead" }],
    ]);
    // The creator is inside the project, not only above it: the Work Zone page lists them in its access.
    const page = await ok(admin.request("GET", `/api/v1/work-projects/${created.id}`));
    expect(page.access.people.map((p: { userId: string }) => p.userId)).toContain(adminId);
  });

  it("a project under a department auto-leads its creator too", async () => {
    const project = await create("project", "Dept Portal", dept);
    expect(await memberships(project)).toEqual([{ user_id: adminId, role: "lead" }]);
  });

  it("departments and teams are unchanged: no membership and no membership audit", async () => {
    const otherDept = await create("department", "No Auto Dept", null);
    const otherTeam = await create("team", "No Auto Team", otherDept);
    for (const unit of [otherDept, otherTeam]) {
      expect(await memberships(unit)).toEqual([]);
      expect(await memberAudits(unit)).toEqual([]);
    }
  });

  it("a refused creation leaves neither a unit nor a membership", async () => {
    const before = (await audit("unit_membership.added")).length;
    await fails(
      dev.request("POST", "/api/v1/units", { kind: "project", name: "Sneaky", parentId: team }),
      403,
    );
    await fails(
      admin.request("POST", "/api/v1/units", { kind: "project", name: "Lead Portal", parentId: team }),
      409,
    );
    expect((await audit("unit_membership.added")).length).toBe(before);
    expect((await su.query("select 1 from app.org_units where name = 'Sneaky'")).rowCount).toBe(0);
  });
});

describe("units: @handles are generated once (Phase 07.17, D-14, PD-12, E19)", () => {
  let north: string;
  let south: string;
  let west: string;

  // biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
  const create = async (kind: string, name: string, parentId: string | null): Promise<Record<string, any>> =>
    ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }));
  const listed = async (id: string) =>
    ((await ok(admin.request("GET", "/api/v1/units"))).units as Array<{ id: string; handle: string }>).find(
      (u) => u.id === id,
    )?.handle;
  const stored = async (id: string) =>
    (await su.query("select handle from app.org_units where id = $1", [id])).rows[0]?.handle as string;
  /** What the SQL allocator (backfill and fill trigger) would give right now: the two must never disagree. */
  const sqlHandle = async (name: string) =>
    (await su.query("select app.org_unit_handle($1, $2) as h", [orgId, name])).rows[0].h as string;

  beforeAll(async () => {
    north = (await create("department", "Ops North", null)).id;
    south = (await create("department", "Ops South", null)).id;
    west = (await create("department", "Ops West", null)).id;
  });

  it("a new team gets its name's handle; the same name under other parents gets -2, -3", async () => {
    const first = await create("team", "Logistics", north);
    expect(first.handle).toBe("logistics");
    expect(await listed(first.id)).toBe("logistics");
    expect(await stored(first.id)).toBe("logistics");

    expect(await sqlHandle("Logistics")).toBe("logistics-2");
    const second = await create("team", "Logistics", south);
    expect(second.handle).toBe("logistics-2");
    expect(await sqlHandle("Logistics")).toBe("logistics-3");
    const third = await create("team", "Logistics", west);
    expect(third.handle).toBe("logistics-3");
    expect(await listed(third.id)).toBe("logistics-3");
  });

  it("WR-05: names whose letters do not decompose get the SQL allocator's handle (one source of truth)", async () => {
    for (const [name, handle] of [
      ["Straße", "strasse"],
      ["Æsir", "aesir"],
      ["Łódź", "lodz"],
      ["Søren", "soren"],
    ] as const) {
      expect(await sqlHandle(name)).toBe(handle);
      const made = await create("team", name, north);
      expect(made.handle, name).toBe(handle);
      expect(await stored(made.id)).toBe(handle);
    }
  });

  it("a sibling name clash is still unit_name_taken; nothing is created", async () => {
    const count = async () => (await su.query("select count(*)::int as n from app.org_units")).rows[0].n;
    const before = await count();
    const refused = await fails(
      admin.request("POST", "/api/v1/units", { kind: "team", name: "logistics", parentId: south }),
      409,
    );
    expect(refused.code).toBe("unit_name_taken");
    expect(await count()).toBe(before);
  });

  it("reserved and punctuated names, and a long name that stays one typeable @token", async () => {
    expect((await create("team", "here", north)).handle).toBe("here-1");
    expect((await create("team", "R&D / Labs", north)).handle).toBe("rd-labs");
    const long = "Operations and Logistics for the North Region";
    expect((await create("team", long, north)).handle).toBe("operations-and-logistics-for-the-north-r");
    expect(await sqlHandle(long)).toBe("operations-and-logistics-for-the-north-2");
    const again = await create("team", long, south);
    expect(again.handle).toBe("operations-and-logistics-for-the-north-2");
    expect(again.handle.length).toBe(40);
  });

  it("a live bot's username is skipped; a deleted bot's username is free again", async () => {
    const bot = await su.query(
      "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
      [orgId],
    );
    expect((await create("team", "Scout", north)).handle).toBe("scout-2");
    await su.query("update app.agents set deleted_at = now() where id = $1", [bot.rows[0].id]);
    expect(await sqlHandle("Scout")).toBe("scout");
    expect((await create("team", "Scout", south)).handle).toBe("scout");
    // A unit holds "scout" now and another "scout-2": the next one takes the next free suffix.
    expect((await create("team", "Scout", west)).handle).toBe("scout-3");
  });

  it("renames and moves never change a handle; a delete frees it", async () => {
    const unit = (await create("department", "Dispatch", null)).id;
    expect(await stored(unit)).toBe("dispatch");
    const renamed = await ok(admin.request("PATCH", `/api/v1/units/${unit}`, { name: "Shipping" }));
    expect(renamed).toMatchObject({ name: "Shipping", handle: "dispatch" });
    const moved = await ok(admin.request("POST", `/api/v1/units/${unit}/move`, { parentId: north }));
    expect(moved).toMatchObject({ parentId: north, handle: "dispatch" });
    expect(await listed(unit)).toBe("dispatch");
    expect(await stored(unit)).toBe("dispatch");

    // A new "Dispatch" while the renamed unit still holds the handle gets a suffix; once it is gone, the handle is free.
    expect((await create("team", "Dispatch", south)).handle).toBe("dispatch-2");
    await ok(admin.request("DELETE", `/api/v1/units/${unit}`));
    expect((await create("team", "Dispatch", west)).handle).toBe("dispatch");
  });
});

describe("units: who a unit reaches, and whether the viewer is one of them (Phase 07.17, D-13, PD-14)", () => {
  let field: string;
  let teamA: string;
  let teamB: string;
  let ben: TestClient;
  let eva: TestClient;
  const ids: Record<string, string> = {};

  const create = async (client: TestClient, kind: string, name: string, parentId: string | null) =>
    (await ok(client.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
  const join = (client: TestClient, unitId: string, userId: string) =>
    ok(client.request("POST", `/api/v1/units/${unitId}/members`, { userId }));
  /** `[reach, viewerInReach, memberCount, leadCount]` per unit id, as `GET /units` lists it for `client`. */
  const reachOf = async (client: TestClient) =>
    new Map(
      (
        (await ok(client.request("GET", "/api/v1/units"))).units as Array<{
          id: string;
          reach: number;
          viewerInReach: boolean;
          memberCount: number;
          leadCount: number;
        }>
      ).map((u) => [u.id, [u.reach, u.viewerInReach, u.memberCount, u.leadCount]]),
    );

  beforeAll(async () => {
    for (const name of ["ana", "ben", "cam", "dan", "eva", "fay"]) {
      const invited = await invite(`${name}.reach@example.test`, "standard", name);
      ids[name] = invited.id;
      if (name === "ben") ben = invited.client;
      if (name === "eva") eva = invited.client;
    }
    field = await create(admin, "department", "Field", null);
    teamA = await create(admin, "team", "Field A", field);
    teamB = await create(admin, "team", "Field B", field);
    for (const name of ["ana", "ben", "fay"]) await join(admin, teamA, ids[name] as string);
    for (const name of ["ben", "cam"]) await join(admin, teamB, ids[name] as string);
    await join(admin, field, ids.dan as string);
    // Fay is deactivated: still a membership row (memberCount), never someone a mention reaches.
    await su.query(
      "update app.org_members set deactivated_at = now() where organization_id = $1 and user_id = $2",
      [orgId, ids.fay],
    );
  });

  it("counts the distinct active members of the subtree; memberCount and leadCount are unchanged", async () => {
    const forBen = await reachOf(ben);
    expect(forBen.get(field)).toEqual([4, true, 1, 0]);
    expect(forBen.get(teamA)).toEqual([2, true, 3, 0]);
    expect(forBen.get(teamB)).toEqual([2, true, 2, 0]);

    const forEva = await reachOf(eva);
    expect(forEva.get(field)).toEqual([4, false, 1, 0]);
    expect(forEva.get(teamA)).toEqual([2, false, 3, 0]);
    expect(forEva.get(teamB)).toEqual([2, false, 2, 0]);
    // Every unit carries both fields, including the ones nobody belongs to.
    for (const [, [reach, viewerInReach]] of forEva) {
      expect(typeof reach).toBe("number");
      expect(typeof viewerInReach).toBe("boolean");
    }
  });

  it("the single-unit view carries reach and viewerInReach too", async () => {
    const view = await ok(admin.request("PATCH", `/api/v1/units/${teamB}`, { name: "Field B" }));
    expect(view).toMatchObject({ id: teamB, reach: 2, viewerInReach: false, memberCount: 2 });
    const created = await ok(
      admin.request("POST", "/api/v1/units", { kind: "team", name: "Field C", parentId: field }),
    );
    expect(created).toMatchObject({ reach: 0, viewerInReach: false, memberCount: 0 });
    expect((await reachOf(admin)).get(field)?.[0]).toBe(4);
  });

  it("organization B never sees A's units, and A's reach never counts B's members", async () => {
    const { client: zed, id: zedId } = await invite("zed.reach@example.test", "standard", "Zed");
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [zedId]);
    await su.query("delete from app.org_members where user_id = $1", [zedId]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      zedId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Zed', 'admin')",
      [orgB, zedId],
    );
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, zedId]);

    const bDept = await create(zed, "department", "Field", null);
    await join(zed, bDept, zedId);
    // A membership row planted with B's organization on A's team (no API writes this): RLS hides it from A.
    await su.query(
      "insert into app.unit_memberships (organization_id, unit_id, user_id) values ($1, $2, $3)",
      [orgB, teamA, zedId],
    );

    const forZed = await ok(zed.request("GET", "/api/v1/units"));
    expect(forZed.units.map((u: { id: string }) => u.id)).toEqual([bDept]);
    expect(forZed.units[0]).toMatchObject({ handle: "field", reach: 1, viewerInReach: true });

    const forBen = await reachOf(ben);
    expect(forBen.has(bDept)).toBe(false);
    expect(forBen.get(field)).toEqual([4, true, 1, 0]);
    expect(forBen.get(teamA)).toEqual([2, true, 3, 0]);
  });
});
