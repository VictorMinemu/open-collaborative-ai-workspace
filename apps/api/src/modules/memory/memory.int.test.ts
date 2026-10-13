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

  it("a body of escaped control characters is judged by its content, never by Fastify's body limit (WINDOWS 140)", async () => {
    // Exactly the 256 KiB cap: each character escapes to six bytes of JSON (1.5 MiB on the wire), and is stored.
    const atCap = "\u0001".repeat(256 * 1024);
    const created = await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "ctrl.md", content: atCap }),
    );
    expect(created.bytes).toBe(256 * 1024);
    // Over the cap and over the 2 MiB wire limit: the memory code, on create and on update alike.
    const over = "\u0001".repeat(400 * 1024);
    for (const [method, url, body] of [
      ["POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "ctrl-2.md", content: over }],
      ["PUT", `/api/v1/memory/files/${created.id}`, { content: over, expectedVersion: 1 }],
    ] as const) {
      expect((await fails(sam.request(method, url, body), 413)).code, method).toBe("memory_file_too_large");
    }
    await ok(sam.request("DELETE", `/api/v1/memory/files/${created.id}?expectedVersion=1`));
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

describe("file operations", () => {
  it("rename into a new folder keeps the file, its history and bumps the version", async () => {
    const draft = await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "draft.md", content: "one\n" }),
    );
    const moved = await ok(
      sam.request("POST", `/api/v1/memory/files/${draft.id}/rename`, {
        path: "clients/2026/draft.md",
        expectedVersion: 1,
      }),
    );
    expect(moved).toMatchObject({
      id: draft.id,
      path: "clients/2026/draft.md",
      version: 2,
      content: "one\n",
    });
    const revisions = (await ok(sam.request("GET", `/api/v1/memory/files/${draft.id}/revisions`))).revisions;
    expect(revisions.map((r: Json) => [r.version, r.op, r.path, r.linesAdded, r.linesRemoved])).toEqual([
      [2, "rename", "clients/2026/draft.md", 0, 0],
      [1, "create", "draft.md", 1, 0],
    ]);
    const [audit] = (await auditRows("memory.file_renamed")).filter((r) => r.resource_id === draft.id);
    expect(audit?.metadata).toMatchObject({ fileId: draft.id, version: 2 });
    expect(JSON.stringify(audit)).not.toContain("draft.md");
    // A stale rename is a conflict; renaming onto another live file is refused.
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/files/${draft.id}/rename`, {
            path: "x.md",
            expectedVersion: 1,
          }),
          409,
        )
      ).code,
    ).toBe("memory_version_conflict");
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/files/${draft.id}/rename`, {
            path: "NOTES.md",
            expectedVersion: 2,
          }),
          409,
        )
      ).code,
    ).toBe("memory_path_exists");
  });

  it("MEMORY.md is never renamed or deleted, and no file can take its name", async () => {
    const root = await ok(sam.request("GET", `/api/v1/memory/files/${rootId}`));
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/files/${rootId}/rename`, {
            path: "old-memory.md",
            expectedVersion: root.version,
          }),
          409,
        )
      ).code,
    ).toBe("memory_root_file");
    expect(
      (
        await fails(
          sam.request("DELETE", `/api/v1/memory/files/${rootId}?expectedVersion=${root.version}`),
          409,
        )
      ).code,
    ).toBe("memory_root_file");
    const notes = await ok(sam.request("GET", `/api/v1/memory/scopes/${scopeId}/file?path=notes.md`));
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/files/${notes.id}/rename`, {
            path: "memory.md",
            expectedVersion: notes.version,
          }),
          409,
        )
      ).code,
    ).toBe("memory_path_exists");
  });

  it("delete is soft: the file leaves the listing, its history records the delete and the path is reusable", async () => {
    const file = await ok(
      sam.request("GET", `/api/v1/memory/scopes/${scopeId}/file?path=clients/2026/draft.md`),
    );
    expect(
      (await fails(sam.request("DELETE", `/api/v1/memory/files/${file.id}?expectedVersion=1`), 409)).code,
    ).toBe("memory_version_conflict");
    await ok(sam.request("DELETE", `/api/v1/memory/files/${file.id}?expectedVersion=${file.version}`));
    const list = await ok(sam.request("GET", `/api/v1/memory/scopes/${scopeId}/files`));
    expect(list.files.map((f: Json) => f.id)).not.toContain(file.id);
    await fails(sam.request("GET", `/api/v1/memory/files/${file.id}`), 404);
    const rows = await su.query(
      "select version, op, lines_removed from app.memory_file_revisions where file_id = $1 order by version",
      [file.id],
    );
    expect(rows.rows.at(-1)).toEqual({ version: 3, op: "delete", lines_removed: 1 });
    expect((await auditRows("memory.file_deleted")).map((r) => r.resource_id)).toContain(file.id);
    const again = await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, {
        path: "clients/2026/draft.md",
        content: "fresh\n",
      }),
    );
    expect(again.id).not.toBe(file.id);
    expect(again.version).toBe(1);
  });

  it("restore writes a new version with the old content", async () => {
    const f = await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, { path: "r.md", content: "one\n" }),
    );
    await ok(sam.request("PUT", `/api/v1/memory/files/${f.id}`, { content: "two\n", expectedVersion: 1 }));
    expect(
      (
        await fails(
          sam.request("POST", `/api/v1/memory/files/${f.id}/restore`, { version: 9, expectedVersion: 2 }),
          404,
        )
      ).code,
    ).toBe("memory_not_found");
    const restored = await ok(
      sam.request("POST", `/api/v1/memory/files/${f.id}/restore`, { version: 1, expectedVersion: 2 }),
    );
    expect(restored).toMatchObject({ version: 3, content: "one\n" });
    const [latest] = (await ok(sam.request("GET", `/api/v1/memory/files/${f.id}/revisions`))).revisions;
    expect(latest).toMatchObject({ version: 3, op: "restore", linesAdded: 1, linesRemoved: 1 });
    expect((await auditRows("memory.file_restored")).map((r) => r.resource_id)).toContain(f.id);
  });

  it("two concurrent appends both land with sequential versions (the first creates the file)", async () => {
    const actor = { kind: "user" as const, userId: samId };
    const append = (text: string) =>
      stack.built.core.db.withTenant({ organizationId: orgId, userId: samId }, (tx) =>
        stack.built.memory.appendToFile(tx, actor, { scopeId, path: "log.md", text }),
      );
    const first = await Promise.all([append("first"), append("second")]);
    expect(first.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(first[0].fileId).toBe(first[1].fileId);
    const second = await Promise.all([append("third"), append("fourth\n")]);
    expect(second.map((r) => r.version).sort()).toEqual([3, 4]);
    const log = await ok(sam.request("GET", `/api/v1/memory/files/${first[0].fileId}`));
    expect(log.content.split("\n").filter(Boolean).sort()).toEqual(["first", "fourth", "second", "third"]);
    expect(log.content.endsWith("\n")).toBe(true);
    const ops = (await ok(sam.request("GET", `/api/v1/memory/files/${log.id}/revisions`))).revisions.map(
      (r: Json) => r.op,
    );
    expect(ops).toEqual(["append", "append", "append", "create"]);
    // A secret in an append is refused like any write.
    await expect(append(`token ${ANTHROPIC_KEY}`)).rejects.toMatchObject({ code: "secret_detected" });
  });
});

describe("scope limits and approved applies (unit scopes)", () => {
  let opsScope: string;

  beforeAll(async () => {
    const ops = await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Ops", parentId: null }),
    );
    const scopes = (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
    opsScope = scopes.find((s) => s.unitId === ops.id)?.id;
    expect(opsScope).toBeTruthy();
  });

  it("an approved apply writes as the agent on behalf of the human, linked to the approval; secrets still fail", async () => {
    const approvalId = (
      await su.query(
        `insert into app.approval_requests (organization_id, kind, mode, resource_type, resource_id, action_hash,
           requested_by_agent_id, requested_for_user_id, expires_at)
         values ($1, 'memory.write', 'server_apply', 'memory_proposal', gen_random_uuid(), repeat('a', 64), $2, $3,
           now() + interval '1 day') returning id`,
        [orgId, samBotId, samId],
      )
    ).rows[0].id as string;
    const actor = {
      kind: "approved" as const,
      agentId: samBotId,
      onBehalfOfUserId: samId,
      approvalRequestId: approvalId,
    };
    const adminId = (await ok(admin.request("GET", "/api/v1/me"))).user.id as string;
    const written = await stack.built.core.db.withTenant({ organizationId: orgId, userId: adminId }, (tx) =>
      stack.built.memory.writeFile(tx, actor, {
        op: "create",
        scopeId: opsScope,
        path: "runbooks/deploy.md",
        content: "Deploy on Tuesdays.\n",
      }),
    );
    expect(written).toMatchObject({
      version: 1,
      updatedBy: { kind: "agent", id: samBotId, onBehalfOf: { id: samId, displayName: "Sam Lee" } },
    });
    const rev = (
      await su.query(
        "select author_kind, author_id, on_behalf_of_user_id, approval_request_id from app.memory_file_revisions where file_id = $1",
        [written?.id],
      )
    ).rows[0];
    expect(rev).toEqual({
      author_kind: "agent",
      author_id: samBotId,
      on_behalf_of_user_id: samId,
      approval_request_id: approvalId,
    });
    const [audit] = (await auditRows("memory.file_created")).filter((r) => r.resource_id === written?.id);
    expect(audit).toMatchObject({ actor_kind: "agent", agent_id: samBotId, user_id: samId });
    expect(audit?.metadata).toMatchObject({ actorKind: "approved", approvalRequestId: approvalId });
    await expect(
      stack.built.core.db.withTenant({ organizationId: orgId, userId: adminId }, (tx) =>
        stack.built.memory.writeFile(tx, actor, {
          op: "create",
          scopeId: opsScope,
          path: "runbooks/keys.md",
          content: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}\n`,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "secret_detected" });
  });

  it("the 2,001st live file of a scope is refused", async () => {
    const live = Number(
      (
        await su.query("select count(*) from app.memory_files where scope_id = $1 and deleted_at is null", [
          opsScope,
        ])
      ).rows[0].count,
    );
    await su.query(
      `insert into app.memory_files (organization_id, scope_id, path, content, bytes, updated_by_kind)
       select $1, $2, 'bulk/f' || g || '.md', '', 0, 'system' from generate_series(1, $3::int) g`,
      [orgId, opsScope, 2_000 - live],
    );
    expect(
      (
        await fails(
          admin.request("POST", `/api/v1/memory/scopes/${opsScope}/files`, {
            path: "one-more.md",
            content: "x",
          }),
          409,
        )
      ).code,
    ).toBe("memory_scope_full");
  });

  it("forgetting is for the owner of private memory only: a unit scope is 403", async () => {
    expect((await fails(admin.request("DELETE", `/api/v1/memory/scopes/${opsScope}`), 403)).code).toBe(
      "memory_forget_owner_only",
    );
  });
});

describe("forget (private memory)", () => {
  it("removes every file and revision of the owner's private scope, audits counts only and starts a fresh MEMORY.md", async () => {
    const files = Number(
      (await su.query("select count(*) from app.memory_files where scope_id = $1", [scopeId])).rows[0].count,
    );
    const revisions = Number(
      (await su.query("select count(*) from app.memory_file_revisions where scope_id = $1", [scopeId]))
        .rows[0].count,
    );
    expect(files).toBeGreaterThan(3);
    await fails(admin.request("DELETE", `/api/v1/memory/scopes/${scopeId}`), 404);
    expect(await ok(sam.request("DELETE", `/api/v1/memory/scopes/${scopeId}`))).toEqual({ files, revisions });
    const list = await ok(sam.request("GET", `/api/v1/memory/scopes/${scopeId}/files`));
    expect(list.files.map((f: Json) => [f.path, f.version])).toEqual([["MEMORY.md", 1]]);
    const left = await su.query(
      "select count(*)::int as n from app.memory_file_revisions where scope_id = $1",
      [scopeId],
    );
    expect(left.rows[0].n).toBe(1);
    const [audit] = await auditRows("memory.scope_forgotten");
    expect(audit).toMatchObject({ actor_kind: "user", user_id: samId, resource_id: scopeId });
    expect(audit?.metadata).toEqual({ scopeId, scopeKind: "personal", files, revisions, proposals: 0 });
    const events = (await streamEvents("memory.changed")).filter((e) => e.stream_id === `user:${samId}`);
    expect(events.at(-1)?.payload).toEqual({ scopeId, fileId: list.files[0].id, version: 1 });
    // Sam's private memory is announced to Sam only (shared scopes go to their readers, WINDOWS 157).
    const ofPrivate = (await streamEvents("memory.changed")).filter((e) => e.payload.scopeId === scopeId);
    expect(ofPrivate.every((e) => e.stream_id === `user:${samId}`)).toBe(true);
  });
});

describe("a deleted bot's private memory leaves the lists (WINDOWS 163)", () => {
  it("its private scope and its notebook are no longer listed or searched, and stay stored", async () => {
    const notebook = await ok(
      sam.request("POST", "/api/v1/memory/scopes", { kind: "agent", agentId: samBotId }),
    );
    await ok(
      sam.request("POST", `/api/v1/memory/scopes/${scopeId}/files`, {
        path: "kept.md",
        content: "mangosteen notes\n",
      }),
    );
    const listed = async () =>
      ((await ok(sam.request("GET", "/api/v1/memory/scopes"))).scopes as Json[]).map((s) => s.id as string);
    expect(await listed()).toEqual(expect.arrayContaining([scopeId, notebook.id]));
    expect((await ok(sam.request("GET", "/api/v1/memory/search?q=mangosteen"))).hits).toHaveLength(1);

    await ok(sam.request("DELETE", `/api/v1/agents/${samBotId}`));

    const after = await listed();
    expect(after).not.toContain(scopeId);
    expect(after).not.toContain(notebook.id);
    expect(after.length).toBeGreaterThan(0);
    expect((await ok(sam.request("GET", "/api/v1/memory/search?q=mangosteen"))).hits).toEqual([]);
    // Soft delete: the memory itself is kept (a hard delete of the bot cascades it, ADR-0010).
    const kept = await su.query("select count(*)::int as n from app.memory_files where scope_id = $1", [
      scopeId,
    ]);
    expect(kept.rows[0].n).toBeGreaterThan(0);
  });
});
