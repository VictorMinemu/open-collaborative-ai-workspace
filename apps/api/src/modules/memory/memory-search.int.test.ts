import { randomUUID } from "node:crypto";
import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S, splitSnippet } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-16 (MEM-02, MEM-07, SC5, D-03, D-08): memory full-text search over the files the viewer may read.
 *
 * Organization chart: department Sales (D) ⊃ teams Iberia (A) and Nordics (B).
 * Cast: Víctor (admin); Sam (standard) with his personal bot; Ana (team A, denied `hr/`); Luis (lead of A); Bea
 * (team B); Dan (department D only); Eve, admin of another organization (org B).
 */

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
const scopeOf: Record<string, string> = {};
const fileOf: Record<string, string> = {};
const logs: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };
type Hit = { fileId: string; scopeId: string; path: string; snippet: string };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string, role: "standard" | "developer" | "lead" | "admin") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const scopesOf = async (c: TestClient) =>
  (await ok(c.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
const keyOf = (s: Json) => (s.kind === "unit" ? s.unitId : s.kind) as string;

const create = async (c: TestClient, scope: string, path: string, content: string) =>
  (await ok(c.request("POST", `/api/v1/memory/scopes/${scope}/files`, { path, content }))).id as string;

const searchRaw = (c: TestClient, q: string, scopeId?: string) =>
  c.request("GET", `/api/v1/memory/search?q=${encodeURIComponent(q)}${scopeId ? `&scopeId=${scopeId}` : ""}`);

const search = async (c: TestClient, q: string, scopeId?: string) =>
  (await ok(searchRaw(c, q, scopeId))).hits as Hit[];

const pathsFound = async (c: TestClient, q: string, scopeId?: string) =>
  (await search(c, q, scopeId)).map((h) => h.path).sort();

beforeAll(async () => {
  stack = await startTestStack({
    env: { OCW_MODEL_PROVIDER: "mock", OCW_SEARCH_RATE_LIMIT_PER_MINUTE: "1000", LOG_LEVEL: "info" },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  [sam] = await joinAs("sam@example.test", "Sam Lee", "standard");
  for (const s of await scopesOf(admin)) scopeOf[keyOf(s)] = s.id;

  fileOf.vacations = await create(
    admin,
    scopeOf.org as string,
    "policies/vacations.md",
    "Política de vacaciones: 23 días de vacación al año",
  );
  fileOf.expense = await create(
    admin,
    scopeOf.org as string,
    "policies/expense-rules.md",
    "Receipts within 30 days.",
  );
  fileOf.xss = await create(
    admin,
    scopeOf.org as string,
    "notes/xss.md",
    "<script>alert(1)</script> papaya smoothie",
  );
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: a member finds the organization's policy (MEM-02, D-03)", () => {
  it("'vacaciones' finds the policy with marked words, scoped and pathed", async () => {
    const hits = await search(sam, "vacaciones");
    expect(hits).toHaveLength(1);
    const [hit] = hits as [Hit];
    expect(hit).toMatchObject({
      fileId: fileOf.vacations,
      scopeId: scopeOf.org,
      path: "policies/vacations.md",
    });
    expect(hit.snippet).toContain(`${S}vacaciones${E}`);
    expect(hit.snippet).toContain(`${S}vacación${E}`);
    expect(hit.snippet.length).toBeLessThanOrEqual(400);
  });

  it("finds it by stem, without accents and in any case", async () => {
    for (const q of ["vacación", "vacacion", "VACACIONES"]) {
      expect(
        (await search(sam, q)).map((h) => h.fileId),
        q,
      ).toEqual([fileOf.vacations]);
    }
  });

  it("finds a file by the words of its path", async () => {
    const hits = await search(sam, "expense");
    expect(hits.map((h) => h.fileId)).toEqual([fileOf.expense]);
    expect(hits[0]?.path).toBe("policies/expense-rules.md");
  });

  it("returns plain text: HTML in a file is text, only the contract markers are added", async () => {
    const [hit] = (await search(sam, "papaya")) as [Hit];
    expect(hit.fileId).toBe(fileOf.xss);
    expect(hit.snippet).not.toContain("<b>");
    expect(splitSnippet(hit.snippet).filter((r) => r.mark)).toEqual([{ text: "papaya", mark: true }]);
    expect(
      splitSnippet(hit.snippet)
        .map((r) => r.text)
        .join(""),
    ).toBe("<script>alert(1)</script> papaya smoothie");
  });

  it("finds nothing for words no readable file holds", async () => {
    expect(await search(sam, "inexistentword")).toEqual([]);
  });
});

// ---------------------------------------------------------------- isolation (MEM-07, SC5, D-08)

/** A client whose membership moved to a fresh organization (org B), as its admin (memory-access.int.test.ts). */
async function orgBAdmin(): Promise<TestClient> {
  const [client, userB] = await joinAs(`eve-${randomUUID().slice(0, 8)}@example.test`, "Eve", "standard");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Org B', $2)", [
    orgB,
    `org-b-${orgB}`,
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

describe("search never crosses a boundary (MEM-07, SC5)", () => {
  let ana: TestClient;
  let luis: TestClient;
  let bea: TestClient;
  let dan: TestClient;
  let eve: TestClient;
  let anaId: string;
  let D: string;
  let A: string;
  let B: string;
  let samScope: string;
  let evePolicy: string;
  const bulk: string[] = [];

  const unit = async (kind: string, name: string, parentId: string | null) =>
    (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

  beforeAll(async () => {
    let luisId: string;
    let beaId: string;
    let danId: string;
    [ana, anaId] = await joinAs("ana@example.test", "Ana Pérez", "standard");
    [luis, luisId] = await joinAs("luis@example.test", "Luis Mora", "lead");
    [bea, beaId] = await joinAs("bea@example.test", "Bea Lind", "standard");
    [dan, danId] = await joinAs("dan@example.test", "Dan Ortiz", "standard");
    D = await unit("department", "Sales", null);
    A = await unit("team", "Iberia", D);
    B = await unit("team", "Nordics", D);
    await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: anaId }));
    await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: luisId, role: "lead" }));
    await ok(admin.request("POST", `/api/v1/units/${B}/members`, { userId: beaId }));
    await ok(admin.request("POST", `/api/v1/units/${D}/members`, { userId: danId }));
    for (const s of await scopesOf(admin)) scopeOf[keyOf(s)] = s.id;

    // Folder rule: Ana may not read hr/ in team A (every casing).
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
    fileOf.hrPay = await create(admin, scopeOf[A] as string, "hr/pay.md", "canaryhr payroll bands");
    fileOf.hrReviews = await create(admin, scopeOf[A] as string, "HR/reviews.md", "canaryhr payroll reviews");
    fileOf.teamNotes = await create(admin, scopeOf[A] as string, "notes/team.md", "canaryhr team notes");
    fileOf.orgNotes = await create(
      admin,
      scopeOf.org as string,
      "org-notes.md",
      "canaryhr organization notes",
    );

    // Units: D ⊃ A, B.
    fileOf.dLight = await create(admin, scopeOf[D] as string, "targets.md", "lighthouse targets for Sales");
    fileOf.aLight = await create(admin, scopeOf[A] as string, "iberia.md", "lighthouse accounts in Iberia");
    fileOf.bLight = await create(admin, scopeOf[B] as string, "nordics.md", "lighthouse accounts in Nordics");

    // Sam's private memory with a canary.
    const samBotId = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
    samScope = (
      await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samBotId }))
    ).id;
    fileOf.samSecret = await create(sam, samScope, "plans.md", "zebracanary plans for next year");

    // Org B with the same words as org A's policy.
    eve = await orgBAdmin();
    const eveOrg = (await scopesOf(eve)).find((s) => s.kind === "org")?.id as string;
    evePolicy = await create(
      eve,
      eveOrg,
      "policies/vacations.md",
      "Política de vacaciones: 23 días de vacación al año",
    );

    // Limits: two files rank higher (the word is also in their path), created first (oldest); then 60 equals.
    fileOf.top1 = await create(admin, scopeOf.org as string, "quokka/top-1.md", "quokka notes");
    fileOf.top2 = await create(admin, scopeOf.org as string, "quokka/top-2.md", "quokka notes");
    for (let i = 1; i <= 60; i++) {
      const n = String(i).padStart(2, "0");
      bulk.push(await create(admin, scopeOf.org as string, `bulk/n-${n}.md`, "quokka notes"));
    }
  }, 240_000);

  it("a deny on hr/ hides every casing of that folder from Ana, and nothing else; Luis finds them", async () => {
    const forAna = await search(ana, "canaryhr");
    expect(forAna.map((h) => h.path).sort()).toEqual(["notes/team.md", "org-notes.md"]);
    expect(forAna.map((h) => h.snippet).join("\n")).not.toContain("payroll");
    expect(await pathsFound(ana, "payroll")).toEqual([]);
    expect(await pathsFound(ana, "canaryhr", scopeOf[A])).toEqual(["notes/team.md"]);
    expect(await pathsFound(luis, "canaryhr")).toEqual([
      "HR/reviews.md",
      "hr/pay.md",
      "notes/team.md",
      "org-notes.md",
    ]);
    expect(await pathsFound(luis, "payroll")).toEqual(["HR/reviews.md", "hr/pay.md"]);
  });

  it("a canary in Sam's private memory is found by Sam only, never by an admin or another member", async () => {
    const forSam = await search(sam, "zebracanary");
    expect(forSam).toMatchObject([{ fileId: fileOf.samSecret, scopeId: samScope, path: "plans.md" }]);
    expect(await search(admin, "zebracanary")).toEqual([]);
    expect(await search(ana, "zebracanary")).toEqual([]);
    expect((await searchRaw(admin, "zebracanary", samScope)).status).toBe(404);
    expect((await searchRaw(ana, "zebracanary", samScope)).status).toBe(404);
  });

  it("units: a team member never sees a sibling team; a department-only member sees the department only", async () => {
    expect(await pathsFound(bea, "lighthouse")).toEqual(["nordics.md", "targets.md"]);
    expect(await pathsFound(dan, "lighthouse")).toEqual(["targets.md"]);
    expect(await pathsFound(ana, "lighthouse")).toEqual(["iberia.md", "targets.md"]);
    expect(await pathsFound(sam, "lighthouse")).toEqual([]);
    expect((await searchRaw(bea, "lighthouse", scopeOf[A])).status).toBe(404);
    expect((await searchRaw(dan, "lighthouse", scopeOf[B])).status).toBe(404);
  });

  it("another organization: org B finds only its own file with the same words, and org A only its own", async () => {
    expect((await search(eve, "vacaciones")).map((h) => h.fileId)).toEqual([evePolicy]);
    expect(await search(eve, "canaryhr")).toEqual([]);
    expect((await searchRaw(eve, "vacaciones", scopeOf.org)).status).toBe(404);
    expect((await search(sam, "vacaciones")).map((h) => h.fileId)).toEqual([fileOf.vacations]);
    expect((await search(admin, "vacaciones")).map((h) => h.fileId)).toEqual([fileOf.vacations]);
  });

  it("scopeId narrows to that scope; unknown or unreadable is 404; a bad q or scopeId is 400", async () => {
    expect(await pathsFound(luis, "canaryhr", scopeOf[A])).toEqual([
      "HR/reviews.md",
      "hr/pay.md",
      "notes/team.md",
    ]);
    expect(await pathsFound(luis, "canaryhr", scopeOf.org)).toEqual(["org-notes.md"]);
    expect((await searchRaw(luis, "canaryhr", randomUUID())).status).toBe(404);
    expect((await searchRaw(luis, "canaryhr", "not-a-uuid")).status).toBe(400);
    expect((await searchRaw(luis, "")).status).toBe(400);
    expect((await searchRaw(luis, "   ")).status).toBe(400);
    expect((await searchRaw(luis, "a".repeat(201))).status).toBe(400);
    expect((await searchRaw(luis, "a".repeat(200))).status).toBe(200);
  });

  it("returns at most 50 hits, by rank then most recent first", async () => {
    const hits = await search(sam, "quokka");
    expect(hits).toHaveLength(50);
    expect(hits.slice(0, 2).map((h) => h.fileId)).toEqual([fileOf.top2, fileOf.top1]);
    expect(hits.slice(2).map((h) => h.fileId)).toEqual([...bulk].reverse().slice(0, 48));
    expect(new Set(hits.map((h) => h.scopeId))).toEqual(new Set([scopeOf.org]));
  });

  it("never logs the query text or file content", async () => {
    await search(sam, "zebracanary");
    const all = logs.join("\n");
    expect(all).toContain("/api/v1/memory/search");
    for (const secret of ["zebracanary", "vacaciones", "canaryhr", "payroll"])
      expect(all).not.toContain(secret);
  });
});
