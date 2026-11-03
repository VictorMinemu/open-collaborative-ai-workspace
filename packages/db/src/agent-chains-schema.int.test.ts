import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.7 (A2A-01, A2A-03, D-03, D-04, D-11, D-14, ADR-0027): the loop guards of agent-to-agent consults are the
 * database's, not the API's. As the app role inside one organization, every shape a bug in the API must never store is
 * refused through a NAMED constraint (asserted on the error's `constraint`): no agent twice in a chain, never the root,
 * never itself, depth 1 or 2 with a parent exactly at depth 2, one pending consult per source per chain, an idempotency
 * key used once per source, the budget never exceeded, and every foreign key onto an organization-scoped table carries
 * `organization_id` (FKs bypass RLS, so another organization's id must fail the key itself). Racing writers are decided
 * by the database alone. `agent_turns` carries the chain context with defaults that keep every older turn outside any
 * chain, and `app.expired_agent_chain_hops` returns ids only, across organizations, to `ocw_app` alone. Tenant isolation
 * of the two tables is proven in rls-isolation.int.test.ts.
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

interface Org {
  id: string;
  human: string;
  /** Five team bots: A asks, B, C and D answer, E stays outside every chain. */
  a: string;
  b: string;
  c: string;
  d: string;
  e: string;
  channel: string;
  root: string;
}

type Q = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

let seq = 100;

async function seedOrg(): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    human: randomUUID(),
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    d: randomUUID(),
    e: randomUUID(),
    channel: randomUUID(),
    root: randomUUID(),
  };
  const q = (text: string, values: unknown[]) => migrator.query(text, values);
  await q("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  for (const agent of [o.a, o.b, o.c, o.d, o.e])
    await q(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Bot', $3, 'x', 'mock', 'mock-1')",
      [agent, o.id, `bot-${agent.slice(0, 8)}`],
    );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'ops', $3)",
    [o.channel, o.id, `ops-${o.channel}`],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, '@a check the deploy')",
    [o.root, o.id, o.channel, o.human],
  );
  return o;
}

/** A question message posted by `author` in the org's channel thread (every hop needs its own). */
async function question(q: Q, o: Org, author: string): Promise<string> {
  const id = randomUUID();
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, thread_id) values ($1, $2, $3, $4, 'agent', $5, '@x a question', $6)",
    [id, o.id, o.channel, ++seq, author, o.root],
  );
  return id;
}

async function insertRow(q: Q, table: string, row: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(row);
  await q(
    `insert into app.${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((k) => row[k]),
  );
}

/** A chain rooted at A's turn (overridable) and its id. */
async function chain(q: Q, o: Org, cols: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insertRow(q, "agent_chains", {
    id,
    organization_id: o.id,
    conversation_id: o.channel,
    thread_root_id: o.root,
    root_event_id: randomUUID(),
    root_agent_id: o.a,
    human_user_id: o.human,
    ...cols,
  });
  return id;
}

/** A pending depth-1 consult A → B in `chainId` (overridable) and its id. */
async function hop(q: Q, o: Org, chainId: string, cols: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const source = (cols.source_agent_id as string | undefined) ?? o.a;
  await insertRow(q, "agent_chain_hops", {
    id,
    organization_id: o.id,
    chain_id: chainId,
    root_agent_id: o.a,
    source_agent_id: source,
    target_agent_id: o.b,
    depth: 1,
    mode: "consult",
    source_event_id: randomUUID(),
    question_message_id: await question(q, o, source),
    idempotency_key: `${randomUUID()}:consult:0`,
    deadline_at: new Date(Date.now() + 300_000).toISOString(),
    ...cols,
  });
  return id;
}

/** Runs `fn` as ocw_app in `org`'s tenant transaction, always rolled back. */
async function asApp<T>(org: string, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn((text, values) => app.query(text, values));
  } finally {
    await app.query("rollback");
  }
}

/** Expects `fn` to fail on `constraint`, inside a savepoint so the surrounding transaction goes on. */
async function refused(q: Q, constraint: string, fn: () => Promise<unknown>): Promise<void> {
  await q("savepoint s");
  await expect(fn(), constraint).rejects.toMatchObject({ constraint });
  await q("rollback to savepoint s");
}

/** One committed tenant transaction on its own connection (the racing writers). */
async function committed<T>(org: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: tdb.appUrl });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.organization_id', $1, true)", [org]);
    const out = await fn((text, values) => c.query(text, values));
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

const migratorQ: Q = (text, values) => migrator.query(text, values);

let A: Org;
let B: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  migrator = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await migrator.connect();
  await app.connect();
  A = await seedOrg();
  B = await seedOrg();
});

afterAll(async () => {
  await migrator?.end();
  await app?.end();
  await tdb?.stop();
});

describe("agent chains schema (07.7-02)", () => {
  it("a chain rooted at A holds a consult A → B, with its defaults", async () => {
    await asApp(A.id, async (q) => {
      const c = await chain(q, A);
      const h = await hop(q, A, c);
      const row = (
        await q(
          "select status, hop_budget, hops_used, cancel_reason, closed_at from app.agent_chains where id = $1",
          [c],
        )
      ).rows[0];
      expect(row).toEqual({
        status: "active",
        hop_budget: 3,
        hops_used: 0,
        cancel_reason: null,
        closed_at: null,
      });
      const hopRow = (
        await q(
          "select status, depth, parent_hop_id, target_event_id, answer_message_id, closed_at from app.agent_chain_hops where id = $1",
          [h],
        )
      ).rows[0];
      expect(hopRow).toEqual({
        status: "pending",
        depth: 1,
        parent_hop_id: null,
        target_event_id: null,
        answer_message_id: null,
        closed_at: null,
      });
    });
  });

  it("every loop guard is a named constraint (D-03, D-04)", async () => {
    await asApp(A.id, async (q) => {
      const c = await chain(q, A);
      const ab = await hop(q, A, c);
      // No agent twice in one chain.
      await refused(q, "agent_chain_hops_target_once", () =>
        hop(q, A, c, { target_agent_id: A.b, status: "answered" }),
      );
      // Never the chain's root, never itself.
      await refused(q, "agent_chain_hops_not_root", () =>
        hop(q, A, c, { target_agent_id: A.a, status: "answered" }),
      );
      await refused(q, "agent_chain_hops_not_self", () =>
        hop(q, A, c, { source_agent_id: A.b, target_agent_id: A.b, depth: 2, parent_hop_id: ab }),
      );
      // Depth 1 or 2, a parent exactly at depth 2, a depth-1 consult asked by the root.
      await refused(q, "agent_chain_hops_depth_check", () =>
        hop(q, A, c, { source_agent_id: A.b, target_agent_id: A.c, depth: 3, parent_hop_id: ab }),
      );
      await refused(q, "agent_chain_hops_parent_depth_check", () =>
        hop(q, A, c, { source_agent_id: A.b, target_agent_id: A.c, depth: 2 }),
      );
      await refused(q, "agent_chain_hops_parent_depth_check", () =>
        hop(q, A, c, { target_agent_id: A.c, status: "answered", parent_hop_id: ab }),
      );
      await refused(q, "agent_chain_hops_source_depth_check", () =>
        hop(q, A, c, { source_agent_id: A.b, target_agent_id: A.c }),
      );
      // A depth-2 consult is asked by the target of its parent, in the parent's chain.
      await refused(q, "agent_chain_hops_parent_fk", () =>
        hop(q, A, c, { source_agent_id: A.c, target_agent_id: A.d, depth: 2, parent_hop_id: ab }),
      );
      const other = await chain(q, A);
      await refused(q, "agent_chain_hops_parent_fk", () =>
        hop(q, A, other, { source_agent_id: A.b, target_agent_id: A.c, depth: 2, parent_hop_id: ab }),
      );
      // One pending consult per source per chain.
      await refused(q, "agent_chain_hops_one_pending", () => hop(q, A, c, { target_agent_id: A.c }));
      // An idempotency key names one hop per source.
      const key = (await q("select idempotency_key from app.agent_chain_hops where id = $1", [ab])).rows[0]
        .idempotency_key as string;
      await refused(q, "agent_chain_hops_idempotency", () =>
        hop(q, A, other, { target_agent_id: A.c, idempotency_key: key }),
      );
      // A question message carries one hop.
      const asked = (await q("select question_message_id from app.agent_chain_hops where id = $1", [ab]))
        .rows[0].question_message_id as string;
      await refused(q, "agent_chain_hops_question_uq", () =>
        hop(q, A, other, { target_agent_id: A.c, question_message_id: asked }),
      );
      // Closed enums and bounded text.
      await refused(q, "agent_chain_hops_mode_check", () =>
        hop(q, A, c, { target_agent_id: A.c, status: "answered", mode: "broadcast" }),
      );
      await refused(q, "agent_chain_hops_status_check", () =>
        hop(q, A, c, { target_agent_id: A.c, status: "lost" }),
      );
      await refused(q, "agent_chain_hops_refusal_reason_len_check", () =>
        hop(q, A, c, { target_agent_id: A.c, status: "refused", refusal_reason: "x".repeat(65) }),
      );
      await refused(q, "agent_chains_status_check", () => chain(q, A, { status: "paused" }));
      await refused(q, "agent_chains_cancel_reason_check", () =>
        chain(q, A, { status: "cancelled", cancel_reason: "admin" }),
      );
      // The budget: never over, never outside 1..10.
      await refused(q, "agent_chains_budget_check", () =>
        q("update app.agent_chains set hops_used = 4 where id = $1", [c]),
      );
      await refused(q, "agent_chains_budget_check", () => chain(q, A, { hop_budget: 11 }));
      await refused(q, "agent_chains_budget_check", () => chain(q, A, { hops_used: -1 }));
      // A hop's root is its chain's real root (the not-root check cannot be fooled).
      await refused(q, "agent_chain_hops_chain_fk", () =>
        hop(q, A, c, { root_agent_id: A.e, source_agent_id: A.e, target_agent_id: A.a, status: "answered" }),
      );
      // A root event opens one chain.
      const rootEvent = (await q("select root_event_id from app.agent_chains where id = $1", [c])).rows[0]
        .root_event_id as string;
      await refused(q, "agent_chains_root_event_uq", () => chain(q, A, { root_event_id: rootEvent }));
      // Once A → B is answered, A may consult C (one pending at a time, not one ever).
      await q("update app.agent_chain_hops set status = 'answered', closed_at = now() where id = $1", [ab]);
      await hop(q, A, c, { target_agent_id: A.c });
      // B, the target of A → B, may consult D at depth 2 while A's consult of C is pending.
      const bd = await hop(q, A, c, {
        source_agent_id: A.b,
        target_agent_id: A.d,
        depth: 2,
        parent_hop_id: ab,
      });
      // CR-B-01: depth ≤ 2 is the database's: a hop parented on a depth-2 hop (D, asked by B, asks E) fails the parent
      // key, whatever depth it claims (a depth-2 hop's parent was asked by the chain's root, so it is at depth 1).
      await refused(q, "agent_chain_hops_parent_fk", () =>
        hop(q, A, c, { source_agent_id: A.d, target_agent_id: A.e, depth: 2, parent_hop_id: bd }),
      );
      const n = await q("select count(*)::int as n from app.agent_chain_hops where chain_id = $1", [c]);
      expect(n.rows[0].n).toBe(3);
    });
  });

  it("another organization's agent, conversation or chain fails the composite keys, although FKs bypass RLS (D-14)", async () => {
    await asApp(A.id, async (q) => {
      await refused(q, "agent_chains_root_agent_fk", () => chain(q, A, { root_agent_id: B.a }));
      await refused(q, "agent_chains_conversation_fk", () => chain(q, A, { conversation_id: B.channel }));
      const c = await chain(q, A);
      await refused(q, "agent_chain_hops_target_fk", () => hop(q, A, c, { target_agent_id: B.b }));
    });
    // B's chain, named from A's tenant with A's organization: the key carries the organization, so no parent exists.
    const foreign = await chain(migratorQ, B);
    await asApp(A.id, async (q) => {
      await refused(q, "agent_chain_hops_chain_fk", () => hop(q, A, foreign));
    });
  });

  it("deleting the conversation or the root agent takes the chain and its hops with it", async () => {
    const conv = randomUUID();
    await migrator.query(
      "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'tmp', $3)",
      [conv, A.id, `tmp-${conv}`],
    );
    const left = async (id: string) =>
      (
        await migrator.query(
          "select (select count(*)::int from app.agent_chains where id = $1) + (select count(*)::int from app.agent_chain_hops where chain_id = $1) as n",
          [id],
        )
      ).rows[0].n as number;
    const byConversation = await chain(migratorQ, A, { conversation_id: conv });
    await hop(migratorQ, A, byConversation);
    expect(await left(byConversation)).toBe(2);
    await migrator.query("delete from app.conversations where id = $1", [conv]);
    expect(await left(byConversation)).toBe(0);

    const root = randomUUID();
    await migrator.query(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Tmp', $3, 'x', 'mock', 'mock-1')",
      [root, A.id, `tmp-${root.slice(0, 8)}`],
    );
    const byAgent = await chain(migratorQ, A, { root_agent_id: root });
    await hop(migratorQ, A, byAgent, { root_agent_id: root, source_agent_id: root });
    expect(await left(byAgent)).toBe(2);
    await migrator.query("delete from app.agents where id = $1", [root]);
    expect(await left(byAgent)).toBe(0);
  });

  it("racing budget updates: exactly one takes the last slot (D-04)", async () => {
    const c = await chain(migratorQ, A, { hops_used: 2 });
    const take = () =>
      committed(A.id, async (q) => {
        const r = await q(
          "update app.agent_chains set hops_used = hops_used + 1 where id = $1 and status = 'active' and hops_used < hop_budget returning id",
          [c],
        );
        // Hold the row lock a moment so the two transactions overlap.
        await q("select pg_sleep(0.2)");
        return r.rowCount;
      });
    const counts = await Promise.all([take(), take()]);
    expect(counts.sort()).toEqual([0, 1]);
    const final = await migrator.query("select hops_used from app.agent_chains where id = $1", [c]);
    expect(final.rows[0].hops_used).toBe(3);
  });

  it("racing inserts: one target once and one pending consult per source, decided by the database (D-04)", async () => {
    const racer = (fn: (q: Q) => Promise<unknown>) =>
      committed(A.id, async (q) => {
        const out = await fn(q);
        await q("select pg_sleep(0.2)");
        return out;
      });

    // A → C and B → C (B answering A → B) in the same chain: the same target twice.
    const c1 = await chain(migratorQ, A);
    const ab = await hop(migratorQ, A, c1, { status: "answered" });
    const sameTarget = await Promise.allSettled([
      racer((q) => hop(q, A, c1, { target_agent_id: A.c })),
      racer((q) =>
        hop(q, A, c1, { source_agent_id: A.b, target_agent_id: A.c, depth: 2, parent_hop_id: ab }),
      ),
    ]);
    expect(sameTarget.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = sameTarget.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost?.reason).toMatchObject({ code: "23505", constraint: "agent_chain_hops_target_once" });

    // A → C and A → D, both pending, in the same chain: a second pending consult by one source.
    const c2 = await chain(migratorQ, A);
    const twoPending = await Promise.allSettled([
      racer((q) => hop(q, A, c2, { target_agent_id: A.c })),
      racer((q) => hop(q, A, c2, { target_agent_id: A.d })),
    ]);
    expect(twoPending.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const second = twoPending.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(second?.reason).toMatchObject({ code: "23505", constraint: "agent_chain_hops_one_pending" });

    const n = await migrator.query(
      "select chain_id, count(*)::int as n from app.agent_chain_hops where chain_id = any($1) group by chain_id",
      [[c1, c2]],
    );
    expect(Object.fromEntries(n.rows.map((r) => [r.chain_id, r.n]))).toEqual({ [c1]: 2, [c2]: 1 });
  });

  it("turns carry the chain context; an older-style turn is outside any chain (D-04, D-14)", async () => {
    await asApp(A.id, async (q) => {
      const event = randomUUID();
      await q(
        "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'channel', $6)",
        [event, A.id, A.a, A.human, A.channel, A.root],
      );
      const row = (
        await q(
          "select chain_id, chain_depth, answering_hop_id, returning_hop_id, reply_message_id from app.agent_turns where event_id = $1",
          [event],
        )
      ).rows[0];
      expect(row).toEqual({
        chain_id: null,
        chain_depth: 0,
        answering_hop_id: null,
        returning_hop_id: null,
        reply_message_id: null,
      });
      // Plain ledger ids: a turn keeps them after its chain row is gone (no foreign key).
      await q(
        "update app.agent_turns set chain_id = $2, chain_depth = 2, answering_hop_id = $3, returning_hop_id = $4, reply_message_id = $5 where event_id = $1",
        [event, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );
      await refused(q, "agent_turns_chain_depth_check", () =>
        q("update app.agent_turns set chain_depth = 3 where event_id = $1", [event]),
      );
      await refused(q, "agent_turns_chain_depth_check", () =>
        q("update app.agent_turns set chain_depth = -1 where event_id = $1", [event]),
      );
    });
  });

  describe("app.expired_agent_chain_hops (the consult.tick's ids-only read, D-11)", () => {
    const FN = "app.expired_agent_chain_hops(integer,timestamptz)";
    const now = new Date();
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

    it("is SECURITY DEFINER with a fixed search_path, executable by ocw_app and by no one else", async () => {
      const meta = await migrator.query(
        `select p.prosecdef, p.proconfig, has_function_privilege('ocw_app', p.oid, 'execute') as app,
                has_function_privilege('ocw_auth', p.oid, 'execute') as auth,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0) as public
           from pg_proc p where p.oid = $1::regprocedure`,
        [FN],
      );
      expect(meta.rows[0]).toEqual({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, pg_temp"],
        app: true,
        auth: false,
        public: false,
      });
      const other = new pg.Client({ connectionString: tdb.authUrl });
      await other.connect();
      try {
        await expect(
          other.query("select * from app.expired_agent_chain_hops($1, $2)", [10, now.toISOString()]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await other.end();
      }
    });

    it("returns pending hops past their deadline, across organizations, oldest first, ids only, limit clamped", async () => {
      const ca = await chain(migratorQ, A);
      const cb = await chain(migratorQ, B);
      const late1 = await hop(migratorQ, A, ca, { deadline_at: ago(120) });
      const late2 = await hop(migratorQ, B, cb, { deadline_at: ago(60) });
      const answered = await hop(migratorQ, A, ca, {
        target_agent_id: A.c,
        status: "answered",
        deadline_at: ago(300),
      });
      const future = await hop(migratorQ, B, cb, {
        source_agent_id: B.b,
        target_agent_id: B.c,
        depth: 2,
        parent_hop_id: late2,
        deadline_at: ago(-60),
      });
      const mine = new Set([late1, late2, answered, future]);
      // As ocw_app with no tenant context at all (the consult.tick job runs so).
      const r = await app.query("select * from app.expired_agent_chain_hops($1, $2)", [
        1000,
        now.toISOString(),
      ]);
      expect(r.fields.map((f) => f.name)).toEqual(["id", "organization_id"]);
      expect(r.rows.filter((row) => mine.has(row.id))).toEqual([
        { id: late1, organization_id: A.id },
        { id: late2, organization_id: B.id },
      ]);
      for (const limit of [0, -5, 1]) {
        const rows = (
          await app.query("select * from app.expired_agent_chain_hops($1, $2)", [limit, now.toISOString()])
        ).rows;
        expect(rows, `limit ${limit}`).toHaveLength(1);
      }
      expect(
        (await app.query("select * from app.expired_agent_chain_hops($1, $2)", [2, now.toISOString()])).rows,
      ).toHaveLength(2);
    });
  });

  describe("app.idle_agent_chains (the consult.tick's idle sweep, CR-A-06)", () => {
    const FN = "app.idle_agent_chains(integer,timestamptz)";
    const now = new Date();
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

    it("is SECURITY DEFINER with a fixed search_path, executable by ocw_app and by no one else", async () => {
      const meta = await migrator.query(
        `select p.prosecdef, p.proconfig, has_function_privilege('ocw_app', p.oid, 'execute') as app,
                has_function_privilege('ocw_auth', p.oid, 'execute') as auth,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0) as public
           from pg_proc p where p.oid = $1::regprocedure`,
        [FN],
      );
      expect(meta.rows[0]).toEqual({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, pg_temp"],
        app: true,
        auth: false,
        public: false,
      });
    });

    it("returns active chains with nothing pending and nothing touched since the bound, across organizations, ids only", async () => {
      const idleA = await chain(migratorQ, A);
      const idleB = await chain(migratorQ, B);
      const pendingC = await chain(migratorQ, A);
      const recentHop = await chain(migratorQ, B);
      const done = await chain(migratorQ, A);
      await hop(migratorQ, A, idleA, { status: "answered" });
      await hop(migratorQ, A, pendingC, {});
      await hop(migratorQ, B, recentHop, { status: "answered" });
      await migratorQ("update app.agent_chains set updated_at = $2 where id = any($1::uuid[])", [
        [idleA, idleB, pendingC, recentHop, done],
        ago(3600),
      ]);
      await migratorQ("update app.agent_chain_hops set updated_at = $2 where chain_id = any($1::uuid[])", [
        [idleA, pendingC],
        ago(3600),
      ]);
      await migratorQ("update app.agent_chains set status = 'completed' where id = $1", [done]);
      const r = await app.query("select * from app.idle_agent_chains($1, $2)", [1000, ago(600)]);
      expect(r.fields.map((f) => f.name)).toEqual(["id", "organization_id"]);
      const mine = new Set([idleA, idleB, pendingC, recentHop, done]);
      expect(r.rows.filter((row) => mine.has(row.id)).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
        [
          { id: idleA, organization_id: A.id },
          { id: idleB, organization_id: B.id },
        ].sort((x, y) => x.id.localeCompare(y.id)),
      );
    });
  });
});
