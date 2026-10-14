import { randomUUID } from "node:crypto";
import { createTenantDb, type TenantDb, type Tx } from "@ocw/db";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditService } from "../../audit";
import { loadPrincipalFacts, loadPrincipalFactsMany, loadRules } from "./facts";
import { agentTemplateResource, memoryResource, orgResource, unitResource } from "./policy";
import { decide, type PrincipalFacts } from "./resolve";
import { createPermissionService } from "./service";

let tdb: TestDatabase;
let su: pg.Client;
let db: TenantDb;

const A = randomUUID();
const B = randomUUID();
const lead = randomUUID();
const plain = randomUUID();
const D = randomUUID();
const T = randomUUID();
const readyAgent = randomUUID();
const disabledAgent = randomUUID();
const deletedAgent = randomUUID();
const liveDevice = randomUUID();
const revokedDevice = randomUUID();
const ruleA = randomUUID();
const ruleB = randomUUID();

const q = (text: string, values: unknown[] = []) => su.query(text, values);

async function seedOrg(org: string) {
  await q("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
    org,
    `Org ${org}`,
    `org-${org}`,
  ]);
}

async function seedUser(org: string, id: string, role: string) {
  await q("insert into auth.user (id, name, email) values ($1, 'U', $2)", [id, `${id}@example.test`]);
  await q(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'U', $3)",
    [org, id, role],
  );
}

const withA = <R>(fn: (tx: Tx) => Promise<R>) => db.withTenant({ organizationId: A, userId: null }, fn);

beforeAll(async () => {
  tdb = await startTestDatabase();
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
  db = createTenantDb(tdb.appUrl);

  await seedOrg(A);
  await seedOrg(B);
  await seedUser(A, lead, "developer");
  await seedUser(A, plain, "standard");
  await q(
    `insert into app.org_units (id, organization_id, kind, name, path) values
       ($1, $3, 'department', 'Engineering', ARRAY[$1]::uuid[]),
       ($2, $3, 'team', 'Platform', ARRAY[$1, $2]::uuid[])`,
    [D, T, A],
  );
  await q(
    "insert into app.unit_memberships (organization_id, unit_id, user_id, role) values ($1, $2, $3, 'lead')",
    [A, T, lead],
  );
  await q(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, deleted_at) values
       ($1, $4, 'Ready', 'ready', 'x', 'mock', 'mock-1', 'ready', null),
       ($2, $4, 'Off', 'off', 'x', 'mock', 'mock-1', 'disabled', null),
       ($3, $4, 'Gone', 'gone', 'x', 'mock', 'mock-1', 'ready', now())`,
    [readyAgent, disabledAgent, deletedAgent, A],
  );
  await q(
    `insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, revoked_at) values
       ($1, $3, $4, 'Mac', 'darwin', $5, null),
       ($2, $3, $4, 'Old', 'darwin', $6, now())`,
    [liveDevice, revokedDevice, A, lead, randomUUID(), randomUUID()],
  );
  await q(
    "insert into app.permission_rules (id, organization_id, scope_unit_id, subject_kind, permission, effect) values ($1, $2, $3, 'everyone', 'channel.create', 'deny')",
    [ruleA, A, D],
  );
  await q(
    "insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, tool, effect) values ($1, $2, 'role', 'standard', 'work_session.*', 'Bash', 'allow')",
    [ruleB, B],
  );
});

afterAll(async () => {
  await db?.close();
  await su?.end();
  await tdb?.stop();
});

describe("loadPrincipalFacts", () => {
  it("a lead of team T under D gets the unit path and the lead unit", async () => {
    const facts = await withA((tx) => loadPrincipalFacts(tx, { kind: "user", userId: lead }));
    expect(facts).toMatchObject({ kind: "user", id: lead, orgRole: "developer", deactivated: false });
    expect(facts.memberUnitPaths).toEqual([[D, T]]);
    expect([...facts.leadOfUnitIds]).toEqual([T]);
  });

  it("a user without units has empty paths; a deactivated member is deactivated", async () => {
    const before = await withA((tx) => loadPrincipalFacts(tx, { kind: "user", userId: plain }));
    expect(before).toMatchObject({ orgRole: "standard", deactivated: false, memberUnitPaths: [] });
    await q("update app.org_members set deactivated_at = now() where user_id = $1", [plain]);
    const after = await withA((tx) => loadPrincipalFacts(tx, { kind: "user", userId: plain }));
    expect(after.deactivated).toBe(true);
  });

  it("a user of another organization is not a member here", async () => {
    const other = await db.withTenant({ organizationId: B, userId: null }, (tx) =>
      loadPrincipalFacts(tx, { kind: "user", userId: lead }),
    );
    expect(other).toMatchObject({ orgRole: null, deactivated: true, memberUnitPaths: [] });
  });

  it("agents: disabled or deleted ones are deactivated", async () => {
    const load = (agentId: string) => withA((tx) => loadPrincipalFacts(tx, { kind: "agent", agentId }));
    expect((await load(readyAgent)).deactivated).toBe(false);
    expect((await load(disabledAgent)).deactivated).toBe(true);
    expect((await load(deletedAgent)).deactivated).toBe(true);
    expect((await load(randomUUID())).deactivated).toBe(true);
  });

  it("devices: a revoked device is deactivated", async () => {
    const load = (deviceId: string) => withA((tx) => loadPrincipalFacts(tx, { kind: "device", deviceId }));
    expect((await load(liveDevice)).deactivated).toBe(false);
    expect((await load(revokedDevice)).deactivated).toBe(true);
  });

  it("a cell principal is never deactivated", async () => {
    const facts = await withA((tx) => loadPrincipalFacts(tx, { kind: "cell", cellId: A }));
    expect(facts).toMatchObject({ kind: "cell", orgRole: null, deactivated: false });
  });
});

describe("loadRules", () => {
  it("returns only the tenant's rules", async () => {
    const rules = await withA((tx) => loadRules(tx));
    expect(rules).toEqual([
      {
        id: ruleA,
        scopeUnitId: D,
        subjectKind: "everyone",
        subjectId: null,
        permission: "channel.create",
        tool: null,
        pathPrefix: null,
        effect: "deny",
      },
    ]);
    const rulesB = await db.withTenant({ organizationId: B, userId: null }, (tx) => loadRules(tx));
    expect(rulesB.map((r) => r.id)).toEqual([ruleB]);
    expect(rulesB[0]).toMatchObject({
      subjectKind: "role",
      subjectId: "standard",
      tool: "Bash",
      effect: "allow",
    });
  });
});

describe("folder rules end to end (Phase 07.2, D-04): rule row → loadRules → resolver", () => {
  const C = randomUUID();
  const E = randomUUID();
  const dept = randomUUID();
  const team = randomUUID();
  const mia = randomUUID();
  const noa = randomUUID();
  const hrDeny = randomUUID();
  const plainRule = randomUUID();
  const foreignDeny = randomUUID();
  const withC = <R>(fn: (tx: Tx) => Promise<R>) => db.withTenant({ organizationId: C, userId: null }, fn);

  beforeAll(async () => {
    await seedOrg(C);
    await seedOrg(E);
    await seedUser(C, mia, "standard");
    await seedUser(C, noa, "standard");
    await q(
      `insert into app.org_units (id, organization_id, kind, name, path) values
         ($1, $3, 'department', 'People', ARRAY[$1]::uuid[]),
         ($2, $3, 'team', 'Ops', ARRAY[$1, $2]::uuid[])`,
      [dept, team, C],
    );
    await q(
      `insert into app.unit_memberships (organization_id, unit_id, user_id, role) values
         ($1, $2, $3, 'member'), ($1, $2, $4, 'member')`,
      [C, team, mia, noa],
    );
    await q(
      `insert into app.permission_rules (id, organization_id, scope_unit_id, subject_kind, subject_id, permission, path_prefix, effect)
       values ($1, $2, $3, 'user', $4, 'memory.read', 'hr/', 'deny')`,
      [hrDeny, C, team, mia],
    );
    await q(
      `insert into app.permission_rules (id, organization_id, subject_kind, permission, effect)
       values ($1, $2, 'everyone', 'memory.write', 'deny')`,
      [plainRule, C],
    );
    // Another organization denies everyone everything under clients/: it must never reach C.
    await q(
      `insert into app.permission_rules (id, organization_id, subject_kind, permission, path_prefix, effect)
       values ($1, $2, 'everyone', 'memory.*', 'clients/', 'deny')`,
      [foreignDeny, E],
    );
  });

  it("loadRules returns the folder of a folder rule and null otherwise, only for the tenant", async () => {
    const rules = await withC((tx) => loadRules(tx));
    const byId = new Map(rules.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual([hrDeny, plainRule].sort());
    expect(byId.get(hrDeny)).toEqual({
      id: hrDeny,
      scopeUnitId: team,
      subjectKind: "user",
      subjectId: mia,
      permission: "memory.read",
      tool: null,
      pathPrefix: "hr/",
      effect: "deny",
    });
    expect(byId.get(plainRule)?.pathPrefix).toBeNull();
    const foreign = await db.withTenant({ organizationId: E, userId: null }, (tx) => loadRules(tx));
    expect(foreign.map((r) => [r.id, r.pathPrefix])).toEqual([[foreignDeny, "clients/"]]);
  });

  it("the deny hides hr/ of the team's memory from one member; the rest of the tree and the other member are unaffected", async () => {
    const scope = { kind: "unit" as const, ownerUserId: null, agent: null, unitPath: [dept, team] };
    const read = (userId: string, path: string | undefined) =>
      withC(async (tx) => {
        const p = await loadPrincipalFacts(tx, { kind: "user", userId });
        const rules = await loadRules(tx);
        return decide(p, memoryResource(scope, path, { kind: "user", id: userId }), rules, "memory.read");
      });
    expect(await read(mia, "hr/salaries.md")).toEqual({
      allowed: false,
      denial: {
        permission: "memory.read",
        layer: "user",
        reason: "denied_by_rule",
        ruleId: hrDeny,
        unitId: team,
      },
    });
    expect((await read(mia, "HR/Reviews/2026.md")).allowed).toBe(false);
    expect((await read(mia, "MEMORY.md")).allowed).toBe(true);
    expect((await read(mia, "hr-public/handbook.md")).allowed).toBe(true);
    expect((await read(mia, undefined)).allowed).toBe(true);
    expect((await read(noa, "hr/salaries.md")).allowed).toBe(true);
    // The other organization's clients/ deny never applies here.
    expect((await read(mia, "clients/acme.md")).allowed).toBe(true);
    expect((await read(noa, "clients/acme.md")).allowed).toBe(true);
  });
});

describe("batch facts and usersAllowed (Phase 07.2: reader counts and deciders)", () => {
  // Organization F: department D ⊃ teams A, B.
  const F = randomUUID();
  const G = randomUUID();
  const D_ = randomUUID();
  const A_ = randomUUID();
  const B_ = randomUUID();
  const ada = randomUUID(); // admin, no unit
  const amy = randomUUID(); // standard, member of A and of B
  const bob = randomUUID(); // standard, member of B
  const dan = randomUUID(); // lead of D
  const ali = randomUUID(); // lead of A
  const dot = randomUUID(); // standard, member of D only
  const old = randomUUID(); // deactivated member of A
  const gus = randomUUID(); // a member of organization G only
  const withF = <R>(fn: (tx: Tx) => Promise<R>) => db.withTenant({ organizationId: F, userId: null }, fn);
  const perms = () => createPermissionService({ db, audit: createAuditService() });
  const scopeOf = (path: readonly string[]) => ({
    kind: "unit" as const,
    ownerUserId: null,
    agent: null,
    unitPath: path,
  });

  beforeAll(async () => {
    await seedOrg(F);
    await seedOrg(G);
    for (const [id, role] of [
      [ada, "admin"],
      [amy, "standard"],
      [bob, "standard"],
      [dan, "lead"],
      [ali, "lead"],
      [dot, "standard"],
      [old, "standard"],
    ] as const) {
      await seedUser(F, id, role);
    }
    await seedUser(G, gus, "admin");
    await q("update app.org_members set deactivated_at = now() where user_id = $1", [old]);
    await q(
      `insert into app.org_units (id, organization_id, kind, name, path) values
         ($1, $4, 'department', 'Dept', ARRAY[$1]::uuid[]),
         ($2, $4, 'team', 'Team A', ARRAY[$1, $2]::uuid[]),
         ($3, $4, 'team', 'Team B', ARRAY[$1, $3]::uuid[])`,
      [D_, A_, B_, F],
    );
    await q(
      `insert into app.unit_memberships (organization_id, unit_id, user_id, role) values
         ($1, $2, $4, 'member'), ($1, $3, $4, 'member'), ($1, $3, $5, 'member'),
         ($1, $6, $7, 'lead'), ($1, $2, $8, 'lead'), ($1, $6, $9, 'member'), ($1, $2, $10, 'member')`,
      [F, A_, B_, amy, bob, D_, dan, ali, dot, old],
    );
    // Organization G denies everyone every memory grain: it must never reach F.
    await q(
      "insert into app.permission_rules (organization_id, subject_kind, permission, effect) values ($1, 'everyone', 'memory.*', 'deny')",
      [G],
    );
  });

  it("loadPrincipalFactsMany equals one loadPrincipalFacts per user, in two queries; unknown ids are absent", async () => {
    const ids = [ada, amy, dan, ali, old];
    const { many, single, selects } = await withF(async (tx) => {
      const spy = vi.spyOn(tx, "select");
      const many = await loadPrincipalFactsMany(tx, [...ids, randomUUID(), gus, amy]);
      const selects = spy.mock.calls.length;
      spy.mockRestore();
      const single = new Map<string, PrincipalFacts>();
      for (const id of ids) single.set(id, await loadPrincipalFacts(tx, { kind: "user", userId: id }));
      return { many, single, selects };
    });
    expect(selects).toBe(2);
    expect([...many.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const a = many.get(id);
      const b = single.get(id);
      expect(a, id).toEqual(b);
    }
    expect(many.get(amy)?.memberUnitPaths).toHaveLength(2);
    expect(many.get(old)?.deactivated).toBe(true);
    expect(await withF((tx) => loadPrincipalFactsMany(tx, []))).toEqual(new Map());
  });

  it("usersAllowed on a team A file: exactly A members, the A and D leads and admins, sorted; never deactivated", async () => {
    const service = perms();
    const allowed = (
      permission: "memory.read" | "memory.promote",
      path: string,
      candidates: readonly string[] | "members" = "members",
    ) =>
      withF((tx) =>
        service.usersAllowed(tx, {
          candidates,
          permission,
          resourceFor: (userId) => memoryResource(scopeOf([D_, A_]), path, { kind: "user", id: userId }),
        }),
      );
    expect(await allowed("memory.read", "notes/x.md")).toEqual([ada, amy, dan, ali].sort());
    expect(await allowed("memory.promote", "notes/x.md")).toEqual([ada, dan, ali].sort());
    // An explicit candidate list: strangers, other organizations and deactivated members never count.
    expect(await allowed("memory.read", "notes/x.md", [bob, amy, old, gus, randomUUID(), amy])).toEqual([
      amy,
    ]);
    expect(await allowed("memory.read", "notes/x.md", [])).toEqual([]);
  });

  it("a folder deny for one member removes exactly that member under that folder", async () => {
    const service = perms();
    await q(
      `insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, path_prefix, effect)
       values ($1, $2, 'user', $3, 'memory.read', 'hr/', 'deny')`,
      [F, A_, amy],
    );
    const readers = (path: string) =>
      withF((tx) =>
        service.usersAllowed(tx, {
          candidates: "members",
          permission: "memory.read",
          resourceFor: (userId) => memoryResource(scopeOf([D_, A_]), path, { kind: "user", id: userId }),
        }),
      );
    expect(await readers("hr/pay.md")).toEqual([ada, dan, ali].sort());
    expect(await readers("Hr/Sub/pay.md")).toEqual([ada, dan, ali].sort());
    expect(await readers("hr-public/pay.md")).toEqual([ada, amy, dan, ali].sort());
    // Organization G's memory.* deny for everyone never applied to F (cross-tenant).
    expect(await readers("MEMORY.md")).toEqual([ada, amy, dan, ali].sort());
  });
});

describe("unit keys and unit templates through the service (Phase 07.4, N5): rows → facts → resolver", () => {
  // Organization K: department D ⊃ teams A (⊃ A1) and B. Organization L holds a stranger admin.
  const K = randomUUID();
  const L = randomUUID();
  const D_ = randomUUID();
  const A_ = randomUUID();
  const A1 = randomUUID();
  const B_ = randomUUID();
  const kim = randomUUID(); // admin, no unit
  const ann = randomUUID(); // standard, member of A
  const sub = randomUUID(); // standard, member of A1 (below A)
  const dee = randomUUID(); // standard, lead of D (on A's path)
  const bea = randomUUID(); // standard, member of B (outsider)
  const nil = randomUUID(); // standard, no unit (outsider)
  const lou = randomUUID(); // admin of organization L only
  const withK = <R>(fn: (tx: Tx) => Promise<R>) => db.withTenant({ organizationId: K, userId: null }, fn);
  const perms = () => createPermissionService({ db, audit: createAuditService() });
  const unitA = () => unitResource({ id: A_, path: [D_, A_] });

  beforeAll(async () => {
    await seedOrg(K);
    await seedOrg(L);
    for (const [id, role] of [
      [kim, "admin"],
      [ann, "standard"],
      [sub, "standard"],
      [dee, "standard"],
      [bea, "standard"],
      [nil, "standard"],
    ] as const) {
      await seedUser(K, id, role);
    }
    await seedUser(L, lou, "admin");
    await q(
      `insert into app.org_units (id, organization_id, kind, name, path) values
         ($1, $5, 'department', 'Dept', ARRAY[$1]::uuid[]),
         ($2, $5, 'team', 'Team A', ARRAY[$1, $2]::uuid[]),
         ($3, $5, 'project', 'Project A1', ARRAY[$1, $2, $3]::uuid[]),
         ($4, $5, 'team', 'Team B', ARRAY[$1, $4]::uuid[])`,
      [D_, A_, A1, B_, K],
    );
    await q(
      `insert into app.unit_memberships (organization_id, unit_id, user_id, role) values
         ($1, $2, $3, 'member'), ($1, $4, $5, 'member'), ($1, $6, $7, 'lead'), ($1, $8, $9, 'member')`,
      [K, A_, ann, A1, sub, D_, dee, B_, bea],
    );
  });

  const use = (userId: string) =>
    withK((tx) => perms().decide(tx, { kind: "user", userId }, "vault.use", unitA()));

  it("decide(vault.use, unit key): outsiders are denied; a member, a member below, a lead on the path and an admin are allowed", async () => {
    expect(await use(bea)).toEqual({
      allowed: false,
      denial: { permission: "vault.use", layer: "resource", reason: "unit_key" },
    });
    expect((await use(nil)).allowed).toBe(false);
    for (const id of [ann, sub, dee, kim]) expect((await use(id)).allowed, id).toBe(true);
    // Organization keys: every member.
    for (const id of [ann, bea, nil, kim]) {
      const d = await withK((tx) =>
        perms().decide(tx, { kind: "user", userId: id }, "vault.use", orgResource()),
      );
      expect(d.allowed, id).toBe(true);
    }
  });

  it("an agent acting for an outsider gets the outsider's answer", async () => {
    const agentId = randomUUID();
    await q(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Keys', $3, 'x', 'mock', 'mock-1', 'ready')`,
      [agentId, K, `keys-${agentId.slice(0, 8)}`],
    );
    const as = (userId: string) =>
      withK((tx) =>
        perms().decide(tx, { kind: "agent", agentId, onBehalfOfUserId: userId }, "vault.use", unitA()),
      );
    expect((await as(bea)).denial).toMatchObject({ reason: "unit_key" });
    expect((await as(ann)).allowed).toBe(true);
  });

  it("usersAllowed(vault.use) on the unit key: exactly the audience; another organization's admin never counts", async () => {
    const readers = await withK((tx) =>
      perms().usersAllowed(tx, {
        candidates: [ann, sub, dee, kim, bea, nil, lou],
        permission: "vault.use",
        resourceFor: unitA,
      }),
    );
    expect(readers).toEqual([ann, sub, dee, kim].sort());
    // Decided in K, L's admin is not a member; decided in L, K's unit does not exist and L's admin holds nothing of K.
    expect((await use(lou)).allowed).toBe(false);
    const fromL = await db.withTenant({ organizationId: L, userId: null }, (tx) =>
      perms().decide(tx, { kind: "user", userId: ann }, "vault.use", unitA()),
    );
    expect(fromL.allowed).toBe(false);
  });

  it("an explicit deny still wins for a member of the unit", async () => {
    const ruleId = randomUUID();
    await q(
      `insert into app.permission_rules (id, organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, $3, 'user', $4, 'vault.use', 'deny')`,
      [ruleId, K, A_, ann],
    );
    try {
      expect((await use(ann)).denial).toMatchObject({ reason: "denied_by_rule", ruleId });
      expect((await use(sub)).allowed).toBe(true);
    } finally {
      await q("delete from app.permission_rules where id = $1", [ruleId]);
    }
  });

  it("template visibility: unit.read on a unit template is the unit audience; an organization template is everyone's", async () => {
    const sees = (userId: string, unit: { id: string; path: string[] } | null) =>
      withK((tx) => perms().decide(tx, { kind: "user", userId }, "unit.read", agentTemplateResource(unit)));
    const tplA = { id: A_, path: [D_, A_] };
    expect((await sees(bea, tplA)).denial).toMatchObject({ reason: "unit_template" });
    expect((await sees(nil, tplA)).allowed).toBe(false);
    expect((await sees(lou, tplA)).allowed).toBe(false);
    for (const id of [ann, sub, dee, kim]) expect((await sees(id, tplA)).allowed, id).toBe(true);
    for (const id of [ann, bea, nil, kim]) expect((await sees(id, null)).allowed, id).toBe(true);
    expect((await sees(lou, null)).allowed).toBe(false);
  });
});
