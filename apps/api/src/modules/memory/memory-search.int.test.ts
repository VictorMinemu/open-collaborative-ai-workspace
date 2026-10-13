import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S, splitSnippet } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-16 (MEM-02, MEM-07, SC5, D-03, D-08): memory full-text search over the files the viewer may read.
 *
 * Organization chart: department Sales (D) ⊃ teams Iberia (A) and Nordics (B).
 * Cast: Víctor (admin); Sam (standard) with his personal bot.
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
