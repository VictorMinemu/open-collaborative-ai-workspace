import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * MEM-07 / D-08 / ADR-0010 (database layer of "admins never read personal memory"): rows of a personal scope, and of
 * a personal bot's notebook, carry `personal_owner_user_id`, set by a SECURITY DEFINER trigger from the scope (never
 * from application input), and the RESTRICTIVE `personal_owner_only` policy hides them from every session whose
 * `app.user_id` is not that owner, an admin of the same organization included. Everything here connects as `ocw_app`
 * exactly as the API does (withTenant sets `app.organization_id` and `app.user_id` transaction-locally); the
 * superuser only seeds identities and checks what really is on disk.
 */

let tdb: TestDatabase;
let su: pg.Client;
let app: pg.Client;

const ORG = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const OTHER = randomUUID();
const TEAM_BOT = randomUUID();
const PERSONAL_BOT = randomUUID();
const UNIT = randomUUID();
const UNIT2 = randomUUID();
const MEMORY_TABLES = [
  "app.memory_scopes",
  "app.memory_files",
  "app.memory_file_revisions",
  "app.memory_proposals",
] as const;

/** Runs `fn` as ocw_app inside one transaction with the tenant context withTenant() would set; commits. */
async function as<T>(userId: string | null, fn: (q: pg.Client["query"]) => Promise<T>, commit = true) {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [ORG, userId ?? ""],
    );
    const out = await fn(app.query.bind(app) as pg.Client["query"]);
    await app.query(commit ? "commit" : "rollback");
    return out;
  } catch (err) {
    await app.query("rollback");
    throw err;
  }
}

/** Same as `as`, always rolled back (for statements whose effect must not persist). */
const probe = <T>(userId: string | null, fn: (q: pg.Client["query"]) => Promise<T>) => as(userId, fn, false);

async function count(userId: string | null, tbl: string, scopeId: string): Promise<number> {
  const col = tbl === "app.memory_scopes" ? "id" : "scope_id";
  return as(
    userId,
    async (q) => (await q(`select count(*)::int as n from ${tbl} where ${col} = $1`, [scopeId])).rows[0].n,
  );
}

async function seedBot(id: string, scope: "team" | "personal", owner: string | null) {
  await su.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Bot', $3, 'x', 'mock', 'mock-1', $4, $5)",
    [id, ORG, `bot-${id.slice(0, 8)}`, scope, owner],
  );
}

type Q = pg.Client["query"];

const insertScope = async (
  q: Q,
  kind: "personal" | "agent" | "unit" | "org",
  ids: {
    agentId?: string | null;
    ownerUserId?: string | null;
    unitId?: string | null;
    forgedOwner?: string | null;
  } = {},
): Promise<string> =>
  (
    await q(
      "insert into app.memory_scopes (organization_id, kind, agent_id, owner_user_id, unit_id, personal_owner_user_id) values ($1, $2, $3, $4, $5, $6) returning id",
      [ORG, kind, ids.agentId ?? null, ids.ownerUserId ?? null, ids.unitId ?? null, ids.forgedOwner ?? null],
    )
  ).rows[0].id;

const insertFile = async (
  q: Q,
  scopeId: string,
  path = "MEMORY.md",
  content = "# Memory\n",
  opts: { forgedOwner?: string | null; deletedAt?: string | null } = {},
): Promise<string> =>
  (
    await q(
      "insert into app.memory_files (organization_id, scope_id, personal_owner_user_id, path, content, bytes, updated_by_kind, deleted_at) values ($1, $2, $3, $4, $5, octet_length($5), 'user', $6) returning id",
      [ORG, scopeId, opts.forgedOwner ?? null, path, content, opts.deletedAt ?? null],
    )
  ).rows[0].id;

const insertRevision = async (q: Q, fileId: string, scopeId: string, version = 1): Promise<string> =>
  (
    await q(
      "insert into app.memory_file_revisions (organization_id, file_id, scope_id, version, op, path, content, author_kind) values ($1, $2, $3, $4, 'create', 'MEMORY.md', '# Memory\n', 'user') returning id",
      [ORG, fileId, scopeId, version],
    )
  ).rows[0].id;

const insertProposal = async (q: Q, scopeId: string, agentId: string | null = null): Promise<string> =>
  (
    await q(
      "insert into app.memory_proposals (organization_id, scope_id, path, op, content, content_sha256, reader_count, tainted, requested_by_agent_id) values ($1, $2, 'notes/x.md', 'create', 'x', $3, 1, false, $4) returning id",
      [ORG, scopeId, "a".repeat(64), agentId],
    )
  ).rows[0].id;

/** What really is on disk (superuser, no RLS). */
async function ownersOf(scopeId: string): Promise<Record<string, Array<string | null>>> {
  const out: Record<string, Array<string | null>> = {};
  for (const tbl of MEMORY_TABLES) {
    const col = tbl === "app.memory_scopes" ? "id" : "scope_id";
    const r = await su.query(`select personal_owner_user_id as o from ${tbl} where ${col} = $1`, [scopeId]);
    out[tbl] = r.rows.map((row) => row.o);
  }
  return out;
}

let personalScope: string;
let personalFile: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await su.connect();
  await app.connect();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Acme', $2)", [
    ORG,
    `acme-${ORG}`,
  ]);
  for (const [user, role] of [
    [OWNER, "standard"],
    [ADMIN, "admin"],
    [OTHER, "standard"],
  ] as const) {
    await su.query("insert into auth.user (id, name, email) values ($1, 'U', $2)", [
      user,
      `${user}@example.test`,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'U', $3)",
      [ORG, user, role],
    );
  }
  for (const [unit, name] of [
    [UNIT, "Ops"],
    [UNIT2, "Sales"],
  ] as const) {
    await su.query(
      "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $2, 'team', $3, ARRAY[$1]::uuid[])",
      [unit, ORG, name],
    );
  }
  await seedBot(TEAM_BOT, "team", null);
  await seedBot(PERSONAL_BOT, "personal", OWNER);

  // The owner's private memory with the team bot: scope, MEMORY.md, its first revision and a pending proposal.
  await as(OWNER, async (q) => {
    personalScope = await insertScope(q, "personal", { agentId: TEAM_BOT, ownerUserId: OWNER });
    personalFile = await insertFile(q, personalScope);
    await insertRevision(q, personalFile, personalScope);
    await insertProposal(q, personalScope, TEAM_BOT);
  });
});

afterAll(async () => {
  await app?.end();
  await su?.end();
  await tdb?.stop();
});

describe("personal memory is owner-only at the database layer (ocw_app)", () => {
  it("is visible to its owner and invisible to an admin of the same organization or a session without a user", async () => {
    for (const tbl of MEMORY_TABLES) {
      expect(await count(OWNER, tbl, personalScope), `${tbl} as owner`).toBe(1);
      expect(await count(ADMIN, tbl, personalScope), `${tbl} as admin`).toBe(0);
      expect(await count(OTHER, tbl, personalScope), `${tbl} as another member`).toBe(0);
      expect(await count(null, tbl, personalScope), `${tbl} without a user`).toBe(0);
    }
    // Every row really carries the owner, set by the trigger from the scope.
    expect(await ownersOf(personalScope)).toEqual({
      "app.memory_scopes": [OWNER],
      "app.memory_files": [OWNER],
      "app.memory_file_revisions": [OWNER],
      "app.memory_proposals": [OWNER],
    });
  });

  it("refuses inserts into a personal scope from an admin or a session without a user", async () => {
    for (const user of [ADMIN, null]) {
      await expect(
        probe(user, (q) => insertFile(q, personalScope, "admin.md")),
        `file as ${user}`,
      ).rejects.toThrow(/row-level security/);
      // A forged owner of their own does not help: the trigger replaces it with the scope's owner.
      await expect(
        probe(user, (q) => insertFile(q, personalScope, "forged.md", "x", { forgedOwner: user ?? ADMIN })),
        `forged file as ${user}`,
      ).rejects.toThrow(/row-level security/);
      await expect(
        probe(user, (q) => insertScope(q, "personal", { agentId: PERSONAL_BOT, ownerUserId: OWNER })),
        `scope as ${user}`,
      ).rejects.toThrow(/row-level security/);
    }
    // Nor can anyone write a revision of the owner's file or a proposal into the owner's scope.
    await expect(probe(ADMIN, (q) => insertRevision(q, personalFile, personalScope, 2))).rejects.toThrow(
      /row-level security/,
    );
    await expect(probe(ADMIN, (q) => insertProposal(q, personalScope))).rejects.toThrow(/row-level security/);
  });

  it("stores the scope's owner whatever the application sends, and never lets a file change scope", async () => {
    const forgedNull = await as(OWNER, (q) =>
      insertFile(q, personalScope, "forged-null.md", "x", { forgedOwner: null }),
    );
    const forgedOther = await as(OWNER, (q) =>
      insertFile(q, personalScope, "forged-other.md", "x", { forgedOwner: OTHER }),
    );
    const owners = await su.query(
      "select personal_owner_user_id as o from app.memory_files where id = any($1::uuid[]) order by path",
      [[forgedNull, forgedOther]],
    );
    expect(owners.rows.map((r) => r.o)).toEqual([OWNER, OWNER]);
    // The owner cannot publish a file by clearing the column…
    await as(OWNER, (q) =>
      q("update app.memory_files set personal_owner_user_id = null where id = $1", [forgedNull]),
    );
    // …nor a whole scope.
    await as(OWNER, (q) =>
      q("update app.memory_scopes set personal_owner_user_id = null where id = $1", [personalScope]),
    );
    expect((await ownersOf(personalScope))["app.memory_scopes"]).toEqual([OWNER]);
    const after = await su.query("select personal_owner_user_id as o from app.memory_files where id = $1", [
      forgedNull,
    ]);
    expect(after.rows[0].o).toBe(OWNER);
    // A scope's identity never changes after it is created (its rows' owner derives from it).
    await expect(
      probe(OWNER, (q) =>
        q("update app.memory_scopes set owner_user_id = $2 where id = $1", [personalScope, OTHER]),
      ),
    ).rejects.toThrow(/memory scope identity is immutable/);
    await expect(
      probe(OWNER, (q) =>
        q("update app.memory_scopes set kind = 'org', agent_id = null, owner_user_id = null where id = $1", [
          personalScope,
        ]),
      ),
    ).rejects.toThrow(/memory scope identity is immutable/);
    // A file never changes scope (WINDOWS 136): moving it would leave its history under the old scope and owner. The
    // database refuses it, whoever asks, and the file keeps its scope and its owner.
    const shared = await as(OWNER, (q) => insertScope(q, "unit", { unitId: UNIT2 }));
    await expect(
      probe(OWNER, (q) =>
        q("update app.memory_files set scope_id = $2 where id = $1", [forgedOther, shared]),
      ),
    ).rejects.toThrow(/memory file scope is immutable/);
    // Even the superuser (no RLS) cannot move a file: the trigger is not a policy.
    await expect(
      su.query("update app.memory_files set scope_id = $2 where id = $1", [forgedOther, shared]),
    ).rejects.toThrow(/memory file scope is immutable/);
    const kept = await su.query(
      "select scope_id, personal_owner_user_id as o from app.memory_files where id = $1",
      [forgedOther],
    );
    expect(kept.rows[0]).toEqual({ scope_id: personalScope, o: OWNER });
    // Other columns still change (the trigger fires on scope_id only, and only when it differs).
    await as(OWNER, (q) =>
      q("update app.memory_files set scope_id = scope_id, content = 'y', bytes = 1 where id = $1", [
        forgedOther,
      ]),
    );
    expect(
      (await su.query("select content from app.memory_files where id = $1", [forgedOther])).rows[0].content,
    ).toBe("y");
  });

  it("refuses a revision whose scope is not its file's, and rows pointing at another organization's scope", async () => {
    const otherBot = randomUUID();
    await seedBot(otherBot, "team", null);
    const shared = await as(OWNER, (q) => insertScope(q, "agent", { agentId: otherBot }));
    // A revision of the owner's personal file filed under a shared scope would leak its content: refused.
    await expect(probe(OWNER, (q) => insertRevision(q, personalFile, shared, 9))).rejects.toThrow(
      /memory revision scope mismatch/,
    );
    // A scope of another organization is never a valid parent (the FK alone would accept it).
    const foreignOrg = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      foreignOrg,
      `o-${foreignOrg}`,
    ]);
    const foreignScope = (
      await su.query(
        "insert into app.memory_scopes (organization_id, kind) values ($1, 'org') returning id",
        [foreignOrg],
      )
    ).rows[0].id as string;
    await expect(probe(OWNER, (q) => insertFile(q, foreignScope, "x.md"))).rejects.toThrow(
      /memory scope not found in this organization/,
    );
    await expect(probe(OWNER, (q) => insertProposal(q, foreignScope))).rejects.toThrow(
      /memory scope not found in this organization/,
    );
    const foreignBot = randomUUID();
    await su.query(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Theirs', $3, 'x', 'mock', 'mock-1', 'personal', $4)",
      [foreignBot, foreignOrg, `theirs-${foreignBot.slice(0, 8)}`, OTHER],
    );
    await expect(probe(OWNER, (q) => insertScope(q, "agent", { agentId: foreignBot }))).rejects.toThrow(
      /memory scope agent not found in this organization/,
    );
  });

  it("gives a personal bot's notebook to the bot's owner; unit, org and team-bot notebooks are shared", async () => {
    const notebook = await as(OWNER, (q) =>
      insertScope(q, "agent", { agentId: PERSONAL_BOT, forgedOwner: null }),
    );
    const team = await as(ADMIN, (q) => insertScope(q, "agent", { agentId: TEAM_BOT, forgedOwner: ADMIN }));
    const unit = await as(ADMIN, (q) => insertScope(q, "unit", { unitId: UNIT }));
    const org = await as(ADMIN, (q) => insertScope(q, "org", { forgedOwner: OWNER }));
    expect(await orgScope()).toBe(org);
    await as(OWNER, async (q) => {
      const f = await insertFile(q, notebook);
      await insertRevision(q, f, notebook);
    });
    for (const scope of [team, unit, org]) {
      await as(ADMIN, async (q) => {
        const f = await insertFile(q, scope);
        await insertRevision(q, f, scope);
        await insertProposal(q, scope);
      });
    }
    expect((await ownersOf(notebook))["app.memory_scopes"]).toEqual([OWNER]);
    expect((await ownersOf(notebook))["app.memory_files"]).toEqual([OWNER]);
    expect(await count(ADMIN, "app.memory_files", notebook)).toBe(0);
    expect(await count(OWNER, "app.memory_files", notebook)).toBe(1);
    for (const scope of [team, unit, org]) {
      expect(await ownersOf(scope), scope).toEqual({
        "app.memory_scopes": [null],
        "app.memory_files": [null],
        "app.memory_file_revisions": [null],
        "app.memory_proposals": [null],
      });
      for (const user of [OWNER, ADMIN, OTHER, null]) {
        for (const tbl of MEMORY_TABLES)
          expect(await count(user, tbl, scope), `${tbl} ${scope} as ${user}`).toBe(1);
      }
    }
  });

  it("keeps revisions and proposals append-only; the owner may still delete (forget) their own revisions", async () => {
    for (const stmt of [
      "update app.memory_file_revisions set content = 'rewritten' where scope_id = $1",
      "update app.memory_proposals set content = 'rewritten' where scope_id = $1",
    ]) {
      await expect(
        probe(OWNER, (q) => q(stmt, [personalScope])),
        stmt,
      ).rejects.toThrow(/permission denied/);
    }
    for (const tbl of ["app.memory_file_revisions", "app.memory_proposals"]) {
      await expect(
        probe(OWNER, (q) => q(`truncate ${tbl}`)),
        tbl,
      ).rejects.toThrow(/permission denied/);
    }
    // An admin deleting the owner's revisions affects nothing (they are invisible); the owner's delete works.
    expect(
      await probe(
        ADMIN,
        async (q) =>
          (await q("delete from app.memory_file_revisions where scope_id = $1", [personalScope])).rowCount,
      ),
    ).toBe(0);
    expect(
      await probe(
        OWNER,
        async (q) =>
          (await q("delete from app.memory_file_revisions where scope_id = $1", [personalScope])).rowCount,
      ),
    ).toBe(1);
  });

  it("still cascades a deleted bot's memory, personal rows included, when an admin deletes the bot (A5)", async () => {
    const bot = randomUUID();
    await seedBot(bot, "team", null);
    const scopes = await as(OWNER, async (q) => {
      const personal = await insertScope(q, "personal", { agentId: bot, ownerUserId: OWNER });
      const f = await insertFile(q, personal);
      await insertRevision(q, f, personal);
      await insertProposal(q, personal, bot);
      return [personal];
    });
    const notebook = await as(ADMIN, async (q) => {
      const s = await insertScope(q, "agent", { agentId: bot });
      const f = await insertFile(q, s);
      await insertRevision(q, f, s);
      return s;
    });
    // A proposal the bot requested into a shared scope goes with the bot too.
    const shared = await orgScope();
    const viaAgent = await as(ADMIN, (q) => insertProposal(q, shared, bot));
    const deleted = await as(
      ADMIN,
      async (q) => (await q("delete from app.agents where id = $1", [bot])).rowCount,
    );
    expect(deleted).toBe(1);
    for (const scope of [...scopes, notebook]) {
      for (const tbl of MEMORY_TABLES) {
        const col = tbl === "app.memory_scopes" ? "id" : "scope_id";
        const n = (await su.query(`select count(*)::int as n from ${tbl} where ${col} = $1`, [scope])).rows[0]
          .n;
        expect(n, `${tbl} of ${scope}`).toBe(0);
      }
    }
    expect(
      (await su.query("select count(*)::int as n from app.memory_proposals where id = $1", [viaAgent]))
        .rows[0].n,
    ).toBe(0);
  });
});

describe("memory files: paths, size and search", () => {
  it("allows one live file per case-insensitive path per scope; soft-deleted files do not count", async () => {
    // A scope of a bot that does not exist, or of another organization's bot, is refused.
    await expect(probe(ADMIN, (q) => insertScope(q, "agent", { agentId: randomUUID() }))).rejects.toThrow(
      /memory scope agent not found in this organization/,
    );
    const s = await orgScope();
    await as(ADMIN, (q) => insertFile(q, s, "Notes.md"));
    await expect(probe(ADMIN, (q) => insertFile(q, s, "notes.md"))).rejects.toThrow(
      /memory_files_scope_path_uq/,
    );
    await as(ADMIN, (q) => insertFile(q, s, "old/notes.md", "x", { deletedAt: new Date().toISOString() }));
    await as(ADMIN, (q) => insertFile(q, s, "OLD/Notes.md", "x", { deletedAt: new Date().toISOString() }));
    await as(ADMIN, (q) => insertFile(q, s, "Old/NOTES.md"));
    await expect(probe(ADMIN, (q) => insertFile(q, s, "old/notes.md"))).rejects.toThrow(
      /memory_files_scope_path_uq/,
    );
  });

  it("bounds content to 256 KiB and paths to 255 characters", async () => {
    const s = await orgScope();
    // 256 KiB of distinct words fits (the STORED tsvector included).
    let big = "";
    for (let i = 0; big.length < 262_144 - 16; i++) big += `w${i.toString(36)} `;
    big = big.padEnd(262_144, "x");
    expect(Buffer.byteLength(big)).toBe(262_144);
    await probe(ADMIN, (q) => insertFile(q, s, "big.md", big));
    await expect(probe(ADMIN, (q) => insertFile(q, s, "too-big.md", `${big}y`))).rejects.toThrow(
      /memory_files_content_size_check/,
    );
    await expect(probe(ADMIN, (q) => insertFile(q, s, `${"p".repeat(253)}.md`))).rejects.toThrow(
      /memory_files_path_len_check/,
    );
  });

  it("indexes content in the three search configurations and path words", async () => {
    const s = await orgScope();
    const vacation = await as(ADMIN, (q) =>
      insertFile(q, s, "hr/leave.md", "Las vacaciones de verano empiezan en julio."),
    );
    const policy = await as(ADMIN, (q) => insertFile(q, s, "policies/expense-rules.md", "Keep receipts."));
    const hits = (config: string, term: string) =>
      as(ADMIN, async (q) =>
        (
          await q(
            `select id from app.memory_files where scope_id = $1 and search_tsv @@ plainto_tsquery('${config}', $2) order by path`,
            [s, term],
          )
        ).rows.map((r) => r.id),
      );
    expect(await hits("app.ocw_es", "vacaciones")).toEqual([vacation]);
    expect(await hits("app.ocw_es", "vacación")).toEqual([vacation]); // Spanish stem, unaccented
    expect(await hits("app.ocw_simple", "expense")).toEqual([policy]); // a path word
    expect(await hits("app.ocw_simple", "policies")).toEqual([policy]);
    expect(await hits("app.ocw_en", "receipt")).toEqual([policy]); // English stem
    // `search_tsv` is generated: never writable.
    await expect(
      probe(ADMIN, (q) =>
        q("update app.memory_files set search_tsv = to_tsvector('x') where id = $1", [policy]),
      ),
    ).rejects.toThrow(/generated column|can only be updated to DEFAULT/);
  });
});

/** The organization's single `org` scope (one per organization), created on first use. */
async function orgScope(): Promise<string> {
  return as(ADMIN, async (q) => {
    const found = await q("select id from app.memory_scopes where kind = 'org'");
    if (found.rows[0]) return found.rows[0].id as string;
    return insertScope(q, "org");
  });
}
