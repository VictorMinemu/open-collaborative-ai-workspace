import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-08 (MEM-01, MEM-02, D-01, D-08): the memory domain over REST on a real PostgreSQL + Redis. The tracer: a person
 * opens their private memory with their bot and edits its `MEMORY.md` through REST → resolver → RLS (owner) →
 * append-only revision → audit (ids only) → owner event. Then the file operations and their domain errors.
 *
 * Cast: Víctor (admin), Sam Lee (standard) with his personal bot.
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-files-0123456789abcd";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let scopeId: string;
let rootId: string;

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

/** A credential-shaped canary built from parts (no whole key literal in the repository). */
const ANTHROPIC_KEY = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");

const auditRows = async (action: string) =>
  (await su.query("select * from app.audit_events where action = $1 order by occurred_at", [action]))
    .rows as Json[];

const streamEvents = async (type: string) =>
  (await su.query("select stream_id, payload from app.stream_events where type = $1 order by seq", [type]))
    .rows as Array<{ stream_id: string; payload: Json }>;

const revisionCount = async (fileId: string) =>
  Number(
    (await su.query("select count(*) from app.memory_file_revisions where file_id = $1", [fileId])).rows[0]
      .count,
  );

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
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  samBotId = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: a person edits their private memory over REST", () => {
  it("opening the private scope creates MEMORY.md version 1 from the template", async () => {
    const scope = await ok(
      sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samBotId }),
    );
    expect(scope).toMatchObject({
      kind: "personal",
      label: "You & Sam's assistant",
      agentId: samBotId,
      unitId: null,
      unitKind: null,
    });
    // `memory.promote` sits on the `team` surface: a standard owner reads and writes (09 decides personal proposals
    // with `memory.write`).
    expect(scope.viewerCan).toEqual(["read", "write"]);
    scopeId = scope.id;

    // Idempotent: the same scope, still one root file.
    expect(
      (await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: samBotId }))).id,
    ).toBe(scopeId);

    const list = await ok(sam.request("GET", `/api/v1/memory/scopes/${scopeId}/files`));
    expect(list.scope.id).toBe(scopeId);
    expect(list.files).toHaveLength(1);
    expect(list.files[0]).toMatchObject({ path: "MEMORY.md", version: 1, updatedBy: { kind: "system" } });
    expect(list.files[0]).not.toHaveProperty("content");

    const root = await ok(sam.request("GET", `/api/v1/memory/scopes/${scopeId}/file?path=MEMORY.md`));
    expect(root).toMatchObject({
      path: "MEMORY.md",
      content: "# Memory\n",
      version: 1,
      bytes: 9,
      updatedBy: { kind: "system", id: null, displayName: "Workspace", onBehalfOf: null },
    });
    rootId = root.id;
  });

  it("an edit with the expected version writes version 2, one revision, one audit row and one owner event", async () => {
    const canary = "Prefers invoices in EUR; canary-7f3a";
    const saved = await ok(
      sam.request("PUT", `/api/v1/memory/files/${rootId}`, {
        content: `# Memory\n\n- ${canary}\n`,
        expectedVersion: 1,
      }),
    );
    expect(saved).toMatchObject({
      id: rootId,
      version: 2,
      content: `# Memory\n\n- ${canary}\n`,
      updatedBy: { kind: "user", id: samId, displayName: "Sam Lee", onBehalfOf: null },
    });

    const got = await ok(sam.request("GET", `/api/v1/memory/files/${rootId}`));
    expect(got).toMatchObject({ version: 2, content: saved.content, updatedBy: { id: samId } });

    const revisions = (await ok(sam.request("GET", `/api/v1/memory/files/${rootId}/revisions`))).revisions;
    expect(revisions.map((r: Json) => [r.version, r.op, r.linesAdded, r.linesRemoved])).toEqual([
      [2, "update", 2, 0],
      [1, "create", 1, 0],
    ]);
    expect(revisions[0].author).toMatchObject({ kind: "user", id: samId });
    const v1 = await ok(sam.request("GET", `/api/v1/memory/files/${rootId}/revisions/1`));
    expect(v1).toMatchObject({ version: 1, op: "create", content: "# Memory\n" });

    const [row] = await auditRows("memory.file_updated");
    expect(row).toMatchObject({ actor_kind: "user", user_id: samId, resource_type: "memory_file" });
    expect(row?.metadata).toEqual({
      scopeId,
      scopeKind: "personal",
      fileId: rootId,
      version: 2,
      bytes: Buffer.byteLength(saved.content),
      actorKind: "user",
    });
    const json = JSON.stringify(row);
    expect(json).not.toContain("MEMORY.md");
    expect(json).not.toContain("canary-7f3a");

    const events = await streamEvents("memory.changed");
    expect(events).toEqual([
      { stream_id: `user:${samId}`, payload: { scopeId, fileId: rootId, version: 2 } },
    ]);
  });

  it("a stale expectedVersion is 409 with the current version and writes nothing", async () => {
    const before = await revisionCount(rootId);
    const err = await fails(
      sam.request("PUT", `/api/v1/memory/files/${rootId}`, { content: "# Lost\n", expectedVersion: 1 }),
      409,
    );
    expect(err).toMatchObject({ code: "memory_version_conflict", details: { currentVersion: 2 } });
    expect(await revisionCount(rootId)).toBe(before);
  });

  it("a secret is refused with masked samples and nothing is stored", async () => {
    const before = await revisionCount(rootId);
    const err = await fails(
      sam.request("PUT", `/api/v1/memory/files/${rootId}`, {
        content: `# Memory\n\nkey: ${ANTHROPIC_KEY}\n`,
        expectedVersion: 2,
      }),
      422,
    );
    expect(err.code).toBe("secret_detected");
    expect(err.details?.findings).toEqual([
      expect.objectContaining({ kind: "secret", severity: "block", count: 1, lines: [3] }),
    ]);
    expect(JSON.stringify(err)).not.toContain(ANTHROPIC_KEY);
    expect(await revisionCount(rootId)).toBe(before);
    const created = await fails(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, {
        path: "keys.md",
        content: ANTHROPIC_KEY,
      }),
      422,
    );
    expect(created.code).toBe("secret_detected");
    const stored = await su.query("select count(*) from app.memory_files where content like $1", [
      `%${ANTHROPIC_KEY}%`,
    ]);
    expect(Number(stored.rows[0].count)).toBe(0);
  });

  it("content over 256 KiB is refused as memory_file_too_large", async () => {
    const big = "a".repeat(300 * 1024);
    expect(
      (
        await fails(
          sam.request("PUT", `/api/v1/memory/files/${rootId}`, { content: big, expectedVersion: 2 }),
          413,
        )
      ).code,
    ).toBe("memory_file_too_large");
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "big.md", content: big }),
          413,
        )
      ).code,
    ).toBe("memory_file_too_large");
  });

  it("REST paths are re-parsed with the shared grammar and unique case-insensitively", async () => {
    for (const [path, reason] of [
      ["a/../b.md", "dot_segment"],
      ["%2e%2e/x.md", "percent"],
      ["a//b.md", "empty_segment"],
      ["/abs.md", "absolute"],
      ["notes.txt", "extension"],
    ] as const) {
      const err = await fails(
        sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path, content: "x" }),
        400,
      );
      expect(err, path).toMatchObject({ code: "memory_path_invalid", details: { reason } });
    }
    const bad = await fails(
      sam.request("GET", `/api/v1/memory/scopes/${scopeId}/file?path=${encodeURIComponent("a/../b.md")}`),
      400,
    );
    expect(bad).toMatchObject({ code: "memory_path_invalid", details: { reason: "dot_segment" } });

    await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "notes.md", content: "n\n" }),
    );
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "Notes.md", content: "N\n" }),
          409,
        )
      ).code,
    ).toBe("memory_path_exists");

    await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "café.md", content: "nfc\n" }),
    );
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, {
            path: "café.md",
            content: "nfd\n",
          }),
          409,
        )
      ).code,
    ).toBe("memory_path_exists");
    // The NFD spelling reads the NFC file.
    const cafe = await ok(
      sam.request("GET", `/api/v1/memory/scopes/${scopeId}/file?path=${encodeURIComponent("café.md")}`),
    );
    expect(cafe.content).toBe("nfc\n");
  });

  it("the private scope stays the owner's: an admin gets 404 on its ids", async () => {
    await fails(admin.request("GET", `/api/v1/memory/files/${rootId}`), 404);
    await fails(admin.request("GET", `/api/v1/memory/scopes/${scopeId}/files`), 404);
    await fails(
      admin.request("PUT", `/api/v1/memory/files/${rootId}`, { content: "# Admin\n", expectedVersion: 2 }),
      404,
    );
    expect(orgId).toBeTruthy();
  });
});
