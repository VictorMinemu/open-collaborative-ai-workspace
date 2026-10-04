import { randomUUID } from "node:crypto";
import { createTenantDb, type TenantDb, type Tx } from "@ocw/db";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPrincipalFacts, loadRules } from "./facts";

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
