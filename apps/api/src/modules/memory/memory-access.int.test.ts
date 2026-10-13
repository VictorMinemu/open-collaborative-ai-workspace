import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-08 (MEM-07, SC5, D-04, D-08, T-07.2-08-01/05/07): who may read and write which memory, at the API layer.
 *
 * Organization chart: department Sales (D) ⊃ teams Iberia (A) and Nordics (B).
 * Cast: Víctor (admin); Ana (standard, member of A); Dan (standard, member of D only); Lena (lead, leads D);
 * Luis (lead, leads A); Bea (standard, member of B); Sam (standard) with his personal bot; Eve, admin of another
 * organization. Bots: "Iberia helper" (a team persona of A owned by Ana) and Archie (an organization bot).
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-access-0123456789ab";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let ana: TestClient;
let dan: TestClient;
let lena: TestClient;
let luis: TestClient;
let bea: TestClient;
let sam: TestClient;
let orgId: string;
let anaId: string;
let danId: string;
let luisId: string;
let beaId: string;
let samId: string;
let D: string;
let A: string;
let B: string;
let samBotId: string;
let teamBotId: string;
let archieId: string;
const scopeOf: Record<string, string> = {};
const fileOf: Record<string, string> = {};
let samScope: string;
let samRoot: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number): Promise<{ code: string; details?: Json }> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as Json).error as { code: string; details?: Json };
}

async function joinAs(email: string, name: string, role: "standard" | "developer" | "lead" | "admin") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

const scopesOf = async (c: TestClient) =>
  (await ok(c.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
const keyOf = (s: Json) => (s.kind === "unit" ? s.unitId : s.kind) as string;

const create = async (c: TestClient, scope: string, path: string, content: string) =>
  (await ok(c.request("POST", `/api/v1/memory/scopes/${scope}/files`, { path, content }))).id as string;

const versionOf = async (fileId: string) =>
  (await su.query("select version from app.memory_files where id = $1", [fileId])).rows[0].version as number;

const put = async (c: TestClient, fileId: string, content: string) =>
  c.request("PUT", `/api/v1/memory/files/${fileId}`, { content, expectedVersion: await versionOf(fileId) });

const pathsOf = async (c: TestClient, scope: string, folder?: string) =>
  (
    (
      await ok(
        c.request(
          "GET",
          `/api/v1/memory/scopes/${scope}/files${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`,
        ),
      )
    ).files as Json[]
  ).map((f) => f.path as string);

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
  orgId = setup.organization.id;
  [ana, anaId] = await joinAs("ana@example.test", "Ana Pérez", "standard");
  [dan, danId] = await joinAs("dan@example.test", "Dan Ortiz", "standard");
  let lenaId: string;
  [lena, lenaId] = await joinAs("lena@example.test", "Lena Gil", "lead");
  [luis, luisId] = await joinAs("luis@example.test", "Luis Mora", "lead");
  [bea, beaId] = await joinAs("bea@example.test", "Bea Lind", "standard");
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");

  D = await unit("department", "Sales", null);
  A = await unit("team", "Iberia", D);
  B = await unit("team", "Nordics", D);
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: anaId }));
  await ok(admin.request("POST", `/api/v1/units/${D}/members`, { userId: danId }));
  await ok(admin.request("POST", `/api/v1/units/${D}/members`, { userId: lenaId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: luisId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${B}/members`, { userId: beaId }));

  samBotId = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
  teamBotId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Iberia helper",
        username: "iberia-helper",
        instructions: "You help the Iberia team.",
        modelProvider: "mock",
        modelId: "mock-1",
        unitId: A,
        ownerUserId: anaId,
      }),
    )
  ).id;
  archieId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Archie",
        instructions: "You are Archie.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;

  samScope = (await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samBotId })))
    .id;
  samRoot = (await ok(sam.request("GET", `/api/v1/memory/scopes/${samScope}/file?path=MEMORY.md`))).id;

  for (const s of await scopesOf(admin)) scopeOf[keyOf(s)] = s.id;
  fileOf.a = await create(lena, scopeOf[A] as string, "clients/acme.md", "# Acme\n");
  fileOf.b = await create(lena, scopeOf[B] as string, "plan.md", "# Plan\n");
  fileOf.d = await create(lena, scopeOf[D] as string, "d.md", "# Sales\n");
  fileOf.org = await create(admin, scopeOf.org as string, "handbook.md", "# Handbook\n");
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("scopes per person (D ⊃ A, B)", () => {
  it("lists exactly the scopes each person may read, in tree order", async () => {
    expect((await scopesOf(ana)).map(keyOf)).toEqual([D, A, "org"]);
    expect((await scopesOf(dan)).map(keyOf)).toEqual([D, "org"]);
    expect((await scopesOf(bea)).map(keyOf)).toEqual([D, B, "org"]);
    expect((await scopesOf(sam)).map(keyOf)).toEqual(["personal", "org"]);
    const forAdmin = await scopesOf(admin);
    expect(forAdmin.map(keyOf)).toEqual([D, A, B, "org"]);
    expect(forAdmin.map((s) => s.id)).not.toContain(samScope);
    expect(forAdmin.find((s) => s.unitId === A)).toMatchObject({
      label: "Iberia",
      unitKind: "team",
      viewerCan: ["read", "write", "promote"],
    });
  });

  it("reports what each may do: members read, leads write and promote on their subtree", async () => {
    const can = async (c: TestClient, key: string) =>
      (await scopesOf(c)).find((s) => keyOf(s) === key)?.viewerCan as string[];
    expect(await can(ana, A)).toEqual(["read"]);
    expect(await can(luis, A)).toEqual(["read", "write", "promote"]);
    expect(await can(luis, D)).toEqual(["read"]);
    expect(await can(lena, A)).toEqual(["read", "write", "promote"]);
    expect(await can(lena, B)).toEqual(["read", "write", "promote"]);
    expect(await can(ana, "org")).toEqual(["read"]);
  });
});

describe("files across units", () => {
  it("a team member reads her team and its department, never the sibling team", async () => {
    await ok(ana.request("GET", `/api/v1/memory/files/${fileOf.a}`));
    await ok(ana.request("GET", `/api/v1/memory/files/${fileOf.d}`));
    await fails(ana.request("GET", `/api/v1/memory/files/${fileOf.b}`), 404);
    await fails(ana.request("GET", `/api/v1/memory/scopes/${scopeOf[B]}/files`), 404);
    await fails(ana.request("GET", `/api/v1/memory/scopes/${scopeOf[B]}/file?path=plan.md`), 404);
  });

  it("a department-only member reads the department, not its teams", async () => {
    await ok(dan.request("GET", `/api/v1/memory/files/${fileOf.d}`));
    await fails(dan.request("GET", `/api/v1/memory/files/${fileOf.a}`), 404);
    await fails(dan.request("GET", `/api/v1/memory/files/${fileOf.b}`), 404);
  });

  it("the department lead writes both teams; the team lead writes his team only; a member gets 403", async () => {
    await ok(put(lena, fileOf.a as string, "# Acme\n\n- renewal in March\n"));
    await ok(put(lena, fileOf.b as string, "# Plan\n\n- Q4\n"));
    await fails(put(luis, fileOf.b as string, "# Luis\n"), 404);
    await ok(put(luis, fileOf.a as string, "# Acme\n\n- renewal in April\n"));
    const denied = await fails(put(ana, fileOf.a as string, "# Ana\n"), 403);
    expect(denied).toMatchObject({ code: "forbidden", details: { permission: "memory.write" } });
    await fails(
      ana.request("POST", `/api/v1/memory/scopes/${scopeOf[A]}/files`, { path: "x.md", content: "x" }),
      403,
    );
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'authz.denied' and user_id = $1 order by occurred_at",
      [anaId],
    );
    expect(audit.rows.map((r) => r.metadata.permission)).toContain("memory.write");
  });

  it("an admin reads every unit's memory but never a person's private memory (ADR-0010)", async () => {
    await ok(admin.request("GET", `/api/v1/memory/files/${fileOf.b}`));
    await fails(admin.request("GET", `/api/v1/memory/files/${samRoot}`), 404);
    await fails(admin.request("GET", `/api/v1/memory/files/${samRoot}/revisions`), 404);
    await fails(admin.request("GET", `/api/v1/memory/scopes/${samScope}/files`), 404);
    await fails(admin.request("DELETE", `/api/v1/memory/scopes/${samScope}`), 404);
    await fails(admin.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samBotId }), 404);
    await fails(admin.request("POST", "/api/v1/memory/scopes", { kind: "agent", agentId: samBotId }), 404);
  });
});

describe("folder rules (MEM-07)", () => {
  let hrFile: string;
  let movedFile: string;

  beforeAll(async () => {
    await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        scopeUnitId: A,
        subjectKind: "user",
        subjectId: anaId,
        permission: "memory.read",
        effect: "deny",
        pathPrefix: "hr/",
      }),
    );
    hrFile = await create(lena, scopeOf[A] as string, "hr/salaries.md", "# Salaries\n");
    await create(lena, scopeOf[A] as string, "HR/reviews.md", "# Reviews\n");
    await create(lena, scopeOf[A] as string, "hr-public/holidays.md", "# Holidays\n");
    movedFile = await create(lena, scopeOf[A] as string, "hr/moving.md", "hr-only draft canary-91\n");
    await ok(
      lena.request("POST", `/api/v1/memory/files/${movedFile}/rename`, {
        path: "notes/moving.md",
        expectedVersion: 1,
      }),
    );
  });

  it("a deny on hr/ hides every casing of that folder from her, and nothing else", async () => {
    const paths = await pathsOf(ana, scopeOf[A] as string);
    expect(paths.filter((p) => p.toLowerCase().startsWith("hr/"))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining(["MEMORY.md", "clients/acme.md", "hr-public/holidays.md"]));
    expect(await pathsOf(ana, scopeOf[A] as string, "hr/")).toEqual([]);
    await fails(ana.request("GET", `/api/v1/memory/files/${hrFile}`), 404);
    await fails(
      ana.request(
        "GET",
        `/api/v1/memory/scopes/${scopeOf[A]}/file?path=${encodeURIComponent("HR/salaries.md")}`,
      ),
      404,
    );
  });

  it("other members are unaffected", async () => {
    const paths = await pathsOf(luis, scopeOf[A] as string);
    expect(paths).toEqual(
      expect.arrayContaining(["hr/salaries.md", "HR/reviews.md", "hr-public/holidays.md", "notes/moving.md"]),
    );
    expect(await pathsOf(luis, scopeOf[A] as string, "hr/")).toEqual(["HR/reviews.md", "hr/salaries.md"]);
  });

  it("a file moved out of hr/ shows her only the history written outside it", async () => {
    const file = await ok(ana.request("GET", `/api/v1/memory/files/${movedFile}`));
    expect(file.path).toBe("notes/moving.md");
    const forAna = (await ok(ana.request("GET", `/api/v1/memory/files/${movedFile}/revisions`)))
      .revisions as Json[];
    expect(forAna.map((r) => [r.version, r.op])).toEqual([[2, "rename"]]);
    await fails(ana.request("GET", `/api/v1/memory/files/${movedFile}/revisions/1`), 404);
    const forLuis = (await ok(luis.request("GET", `/api/v1/memory/files/${movedFile}/revisions`)))
      .revisions as Json[];
    expect(forLuis.map((r) => r.version)).toEqual([2, 1]);
  });
});

describe("a team bot's notebook", () => {
  let notebook: string;
  let root: string;

  it("opens for the team; its owner reads and writes it", async () => {
    const scope = await ok(
      ana.request("POST", "/api/v1/memory/scopes", { kind: "agent", agentId: teamBotId }),
    );
    expect(scope).toMatchObject({ kind: "agent", label: "Iberia helper notebook", agentId: teamBotId });
    expect(scope.viewerCan).toEqual(["read", "write"]);
    notebook = scope.id;
    root = (await ok(ana.request("GET", `/api/v1/memory/scopes/${notebook}/file?path=MEMORY.md`))).id;
    await ok(put(ana, root, "# Iberia helper\n\n- Spanish first\n"));
  });

  it("is read by the team, its leads and admins, never by a sibling team or a department-only member", async () => {
    for (const c of [lena, luis, admin]) await ok(c.request("GET", `/api/v1/memory/files/${root}`));
    await fails(bea.request("GET", `/api/v1/memory/files/${root}`), 404);
    await fails(bea.request("POST", "/api/v1/memory/scopes", { kind: "agent", agentId: teamBotId }), 404);
    await fails(dan.request("GET", `/api/v1/memory/files/${root}`), 404);
  });

  it("is written by its owner, the leads on its path and admins", async () => {
    for (const c of [lena, luis, admin])
      await ok(put(c, root, `# Iberia helper\n\n- edit ${randomUUID()}\n`));
    expect(await versionOf(root)).toBe(5);
  });
});

describe("decideAgentRead: the audience rule (D-08, Pitfall 5)", () => {
  const decide = (a: {
    agentId: string;
    onBehalfOfUserId: string;
    audience: { userIds: string[]; unbounded: boolean };
    scopeId: string;
    path?: string;
  }) =>
    stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      stack.built.memory.decideAgentRead(tx, a),
    );
  const ALLOWED = { allowed: true };
  const TOO_WIDE = { allowed: false, reason: "audience_too_wide" };
  const DENIED = { allowed: false, reason: "denied" };

  it("private memory: only the owner's own bot, only with the owner as the one reader", async () => {
    const base = { agentId: samBotId, onBehalfOfUserId: samId, scopeId: samScope, path: "MEMORY.md" };
    expect(await decide({ ...base, audience: { userIds: [samId], unbounded: false } })).toEqual(ALLOWED);
    expect(await decide({ ...base, audience: { userIds: [samId, anaId], unbounded: false } })).toEqual(
      TOO_WIDE,
    );
    expect(await decide({ ...base, audience: { userIds: [], unbounded: true } })).toEqual(TOO_WIDE);
    // The same bot acting for someone else, or another bot acting for Sam: denied.
    expect(
      await decide({ ...base, onBehalfOfUserId: anaId, audience: { userIds: [anaId], unbounded: false } }),
    ).toEqual(DENIED);
    expect(
      await decide({ ...base, agentId: archieId, audience: { userIds: [samId], unbounded: false } }),
    ).toEqual(DENIED);
  });

  it("unit memory: every listed reader must be able to read the file", async () => {
    const base = {
      agentId: teamBotId,
      onBehalfOfUserId: anaId,
      scopeId: scopeOf[A] as string,
      path: "clients/acme.md",
    };
    expect(await decide({ ...base, audience: { userIds: [anaId, luisId], unbounded: false } })).toEqual(
      ALLOWED,
    );
    expect(await decide({ ...base, audience: { userIds: [anaId, beaId], unbounded: false } })).toEqual(
      TOO_WIDE,
    );
    expect(await decide({ ...base, audience: { userIds: [anaId], unbounded: true } })).toEqual(TOO_WIDE);
    // agent ∩ human: the bot acting for someone outside the team reads nothing of it.
    expect(
      await decide({ ...base, onBehalfOfUserId: beaId, audience: { userIds: [beaId], unbounded: false } }),
    ).toEqual(DENIED);
    // A folder denied to the asker is denied whatever the audience.
    expect(
      await decide({ ...base, path: "hr/salaries.md", audience: { userIds: [anaId], unbounded: false } }),
    ).toEqual(DENIED);
  });

  it("an unbounded audience reads only organization-wide files that no rule denies to anyone", async () => {
    const base = { agentId: archieId, onBehalfOfUserId: danId, scopeId: scopeOf.org as string };
    const everyone = { userIds: [], unbounded: true };
    expect(await decide({ ...base, path: "handbook.md", audience: everyone })).toEqual(ALLOWED);
    await create(admin, scopeOf.org as string, "private/plan.md", "# Plan\n");
    await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: beaId,
        permission: "memory.read",
        effect: "deny",
        pathPrefix: "private/",
      }),
    );
    expect(await decide({ ...base, path: "private/plan.md", audience: everyone })).toEqual(TOO_WIDE);
    expect(await decide({ ...base, path: "handbook.md", audience: everyone })).toEqual(ALLOWED);
    // A listed audience without Bea still reads it.
    expect(
      await decide({ ...base, path: "private/plan.md", audience: { userIds: [danId], unbounded: false } }),
    ).toEqual(ALLOWED);
  });

  it("an agent decision always carries the human it acts for (WINDOWS 131)", async () => {
    await expect(
      decide({
        agentId: archieId,
        onBehalfOfUserId: "",
        audience: { userIds: [], unbounded: false },
        scopeId: scopeOf.org as string,
      }),
    ).rejects.toThrow(/human/);
    await expect(
      stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
        stack.built.memory.readFile(
          tx,
          { kind: "agent", agentId: archieId, onBehalfOfUserId: "" },
          { fileId: fileOf.org as string },
        ),
      ),
    ).rejects.toThrow(/human/);
    // With the human: the bot reads what both may read.
    const read = await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      stack.built.memory.readFile(
        tx,
        { kind: "agent", agentId: archieId, onBehalfOfUserId: danId },
        { fileId: fileOf.org as string },
      ),
    );
    expect(read.content).toBe("# Handbook\n");
  });
});

describe("deleting a unit with memory (unit_has_memory, WINDOWS 129)", () => {
  it("live content blocks it; once the files are deleted and MEMORY.md is back to the template it goes, history with it", async () => {
    const temp = await unit("team", "Temp", D);
    const scope = (await scopesOf(admin)).find((s) => s.unitId === temp)?.id as string;
    const root = (await ok(admin.request("GET", `/api/v1/memory/scopes/${scope}/file?path=MEMORY.md`))).id;
    await ok(put(admin, root, "# Memory\n\n- Q3 targets\n"));
    expect((await fails(admin.request("DELETE", `/api/v1/units/${temp}`), 409)).code).toBe("unit_has_memory");
    const notes = await create(admin, scope, "notes.md", "n\n");
    await ok(put(admin, root, "# Memory\n"));
    expect((await fails(admin.request("DELETE", `/api/v1/units/${temp}`), 409)).code).toBe("unit_has_memory");
    await ok(admin.request("DELETE", `/api/v1/memory/files/${notes}?expectedVersion=1`));
    await ok(admin.request("DELETE", `/api/v1/units/${temp}`));
    for (const table of ["memory_scopes", "memory_files", "memory_file_revisions"]) {
      const col = table === "memory_scopes" ? "id" : "scope_id";
      const n = (await su.query(`select count(*)::int as n from app.${table} where ${col} = $1`, [scope]))
        .rows[0].n;
      expect(n, table).toBe(0);
    }
    const audit = await su.query(
      "select count(*)::int as n from app.audit_events where action like 'memory.file_%' and metadata->>'scopeId' = $1",
      [scope],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------- cross-tenant (every memory route)

/** A client whose membership moved to a fresh organization, as its admin (approval.int.test.ts). */
async function otherOrgAdmin(): Promise<TestClient> {
  const [client, userB] = await joinAs(`eve-${randomUUID().slice(0, 8)}@example.test`, "Eve", "standard");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userB]);
  await su.query("delete from app.org_members where user_id = $1", [userB]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userB,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userB],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
  return client;
}

/** Every memory route, called by another organization's admin with this organization's ids (404 everywhere). */
const MEMORY_CROSS_TENANT_ROUTES: Array<{ name: string; call: (c: TestClient) => Promise<Res> }> = [
  {
    name: "POST /memory/scopes",
    call: (c) => c.request("POST", "/api/v1/memory/scopes", { kind: "agent", agentId: teamBotId }),
  },
  {
    name: "DELETE /memory/scopes/:scopeId",
    call: (c) => c.request("DELETE", `/api/v1/memory/scopes/${samScope}`),
  },
  {
    name: "GET /memory/scopes/:scopeId/files",
    call: (c) => c.request("GET", `/api/v1/memory/scopes/${scopeOf[A]}/files`),
  },
  {
    name: "GET /memory/scopes/:scopeId/file",
    call: (c) => c.request("GET", `/api/v1/memory/scopes/${scopeOf.org}/file?path=handbook.md`),
  },
  {
    name: "POST /memory/scopes/:scopeId/files",
    call: (c) =>
      c.request("POST", `/api/v1/memory/scopes/${scopeOf.org}/files`, { path: "evil.md", content: "x" }),
  },
  { name: "GET /memory/files/:fileId", call: (c) => c.request("GET", `/api/v1/memory/files/${fileOf.org}`) },
  {
    name: "PUT /memory/files/:fileId",
    call: async (c) =>
      c.request("PUT", `/api/v1/memory/files/${fileOf.org}`, {
        content: "# Evil\n",
        expectedVersion: await versionOf(fileOf.org as string),
      }),
  },
  {
    name: "POST /memory/files/:fileId/rename",
    call: async (c) =>
      c.request("POST", `/api/v1/memory/files/${fileOf.org}/rename`, {
        path: "evil.md",
        expectedVersion: await versionOf(fileOf.org as string),
      }),
  },
  {
    name: "DELETE /memory/files/:fileId",
    call: async (c) =>
      c.request(
        "DELETE",
        `/api/v1/memory/files/${fileOf.org}?expectedVersion=${await versionOf(fileOf.org as string)}`,
      ),
  },
  {
    name: "GET /memory/files/:fileId/revisions",
    call: (c) => c.request("GET", `/api/v1/memory/files/${fileOf.a}/revisions`),
  },
  {
    name: "GET /memory/files/:fileId/revisions/:version",
    call: (c) => c.request("GET", `/api/v1/memory/files/${fileOf.a}/revisions/1`),
  },
  {
    name: "GET /memory/search",
    call: (c) => c.request("GET", `/api/v1/memory/search?q=acme&scopeId=${scopeOf[A]}`),
  },
  {
    name: "POST /memory/files/:fileId/restore",
    call: async (c) =>
      c.request("POST", `/api/v1/memory/files/${fileOf.a}/restore`, {
        version: 1,
        expectedVersion: await versionOf(fileOf.a as string),
      }),
  },
];

describe("cross-tenant: another organization's admin", () => {
  const snapshot = async () =>
    (
      await su.query(
        `select f.id, f.version, f.path, f.deleted_at, (select count(*) from app.memory_file_revisions r where r.file_id = f.id) as revisions
         from app.memory_files f where f.organization_id = $1 order by f.id`,
        [orgId],
      )
    ).rows;

  it("gets 404 on every memory route with this organization's ids and changes nothing", async () => {
    const eve = await otherOrgAdmin();
    const before = await snapshot();
    for (const route of MEMORY_CROSS_TENANT_ROUTES) {
      const res = await route.call(eve);
      expect(res.status, route.name).toBe(404);
    }
    // Her own listing holds her organization's scope only.
    const own = await scopesOf(eve);
    expect(own.map(keyOf)).toEqual(["org"]);
    expect(Object.values(scopeOf)).not.toContain(own[0]?.id);
    expect(await snapshot()).toEqual(before);
  });

  it("covers every registered memory route (the authz registry), and only registered ones", () => {
    const key = (name: string) => {
      const [method, path] = name.split(" ") as [string, string];
      return `${method} /api/v1${path}`.replace(/\/:[^/]+/g, "/:p");
    };
    const registered = [...stack.built.authz.routes.keys()]
      .filter((k) => / \/api\/v1\/memory\//.test(k))
      .map((k) => k.replace(/\/:[^/]+/g, "/:p"))
      .sort();
    const covered = [
      ...MEMORY_CROSS_TENANT_ROUTES.map((r) => key(r.name)),
      "GET /api/v1/memory/scopes",
    ].sort();
    expect(covered).toEqual(registered);
    expect(
      [...stack.built.authz.routes.entries()]
        .filter(([k]) => / \/api\/v1\/memory\//.test(k))
        .every(([, m]) => m === "user"),
    ).toBe(true);
  });
});
