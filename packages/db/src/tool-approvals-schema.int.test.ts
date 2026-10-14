import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.5 (D-04, P-04, P-05, P-08, APPROVE-01/02/03): the shapes a bug in the API must never store are refused by
 * PostgreSQL itself, and deletions keep or remove the approval rows as the phase decided. Runs as ocw_migrator (no RLS
 * in the way) on a fresh database with every migration applied; tenant isolation of the same tables, and the
 * organization carried by every foreign key, are proven in rls-isolation.int.test.ts.
 */

let tdb: TestDatabase;
let db: pg.Client;

interface Org {
  id: string;
  user: string;
  unit: string;
  unit2: string;
  dm: string;
  agent: string;
  device: string;
  project: string;
  session: string;
  event: string;
}

const HASH = "a".repeat(64);

async function seedOrg(): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    user: randomUUID(),
    unit: randomUUID(),
    unit2: randomUUID(),
    dm: randomUUID(),
    agent: randomUUID(),
    device: randomUUID(),
    project: randomUUID(),
    session: randomUUID(),
    event: randomUUID(),
  };
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  await db.query("insert into auth.user (id, name, email) values ($1, 'U', $2)", [
    o.user,
    `${o.user}@example.test`,
  ]);
  await db.query(
    "insert into app.org_units (id, organization_id, kind, name, path) values ($1, $3, 'team', 'Sales', ARRAY[$1]::uuid[]), ($2, $3, 'team', 'Support', ARRAY[$2]::uuid[])",
    [o.unit, o.unit2, o.id],
  );
  await db.query(
    "insert into app.conversations (id, organization_id, kind, visibility, dm_key) values ($1, $2, 'dm', 'private', $3)",
    [o.dm, o.id, `agent:${o.agent}|user:${o.user}`],
  );
  await agent(o, o.agent);
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'laptop', 'darwin', $4)",
    [o.device, o.id, o.user, `dev-${o.device}`],
  );
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'p1', 'repo')",
    [o.project, o.id, o.device],
  );
  o.session = await session(o);
  return o;
}

async function agent(o: Org, id: string = randomUUID()): Promise<string> {
  await db.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, scope, owner_user_id) values ($1, $2, 'Mine', $3, 'x', 'mock', 'mock-1', 'personal', $4)",
    [id, o.id, `mine-${id.slice(0, 8)}`, o.user],
  );
  return id;
}

async function session(o: Org): Promise<string> {
  const id = randomUUID();
  const conv = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conv, o.id],
  );
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'T', $6)",
    [id, o.id, conv, o.project, o.device, o.user],
  );
  return id;
}

interface PolicyRow {
  scope?: string | null;
  pattern?: string;
  mode?: string;
  kind?: string;
  approvers?: (string | null)[];
  version?: number;
}

function policy(o: Org, r: PolicyRow = {}) {
  return db
    .query(
      `insert into app.tool_approval_policies (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, version)
       values ($1, $2, $3, $4, $5, $6::uuid[], $7) returning id`,
      [
        o.id,
        r.scope === undefined ? null : r.scope,
        r.pattern ?? `m${randomUUID().replace(/-/g, "").slice(0, 8)}__*`,
        r.mode ?? "always",
        r.kind ?? "requester",
        r.approvers ?? [],
        r.version ?? 1,
      ],
    )
    .then((res) => res.rows[0].id as string);
}

interface ApprovalRow {
  agent?: string;
  event?: string;
  callId?: string | null;
  sourceKind?: string;
  args?: string;
  argsSha?: string;
  actionHash?: string;
  policy?: string | null;
}

function approval(o: Org, r: ApprovalRow = {}) {
  return db
    .query(
      `insert into app.tool_call_approvals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, tool_call_id, tool, source_kind, arguments_canonical, arguments_sha256, action_hash, tainted, policy_id)
       values ($1, $2, $3, $4, $5, $6, 'ocw_http_request', $7, $8, $9, $10, true, $11) returning id`,
      [
        o.id,
        r.agent ?? o.agent,
        o.user,
        o.dm,
        r.event ?? o.event,
        r.callId === undefined ? `call-${randomUUID()}` : r.callId,
        r.sourceKind ?? "vault",
        r.args ?? '{"method":"GET"}',
        r.argsSha ?? HASH,
        r.actionHash ?? HASH,
        r.policy === undefined ? null : r.policy,
      ],
    )
    .then((res) => res.rows[0].id as string);
}

interface ProposalRow {
  agent?: string;
  event?: string;
  runtime?: string;
  prompt?: string;
  promptSha?: string;
  session?: string | null;
}

function proposal(o: Org, r: ProposalRow = {}) {
  return db
    .query(
      `insert into app.work_zone_proposals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, project_id, device_id, runtime, prompt, prompt_sha256, work_session_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        o.id,
        r.agent ?? o.agent,
        o.user,
        o.dm,
        r.event ?? randomUUID(),
        o.project,
        o.device,
        r.runtime ?? "claude-code",
        r.prompt ?? "Run the tests",
        r.promptSha ?? HASH,
        r.session === undefined ? null : r.session,
      ],
    )
    .then((res) => res.rows[0].id as string);
}

/** `n` distinct user ids. */
const people = (n: number) => Array.from({ length: n }, () => randomUUID());

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await tdb?.stop();
});

describe("tool approval policies", () => {
  it("one rule per (organization, scope, pattern), the organization scope included", async () => {
    const o = await seedOrg();
    const pattern = "ocw_http_request";
    await policy(o, { pattern });
    // Two organization rules (scope null) for one pattern: NULLS NOT DISTINCT.
    await expect(policy(o, { pattern, mode: "when_tainted" })).rejects.toThrow(
      /tool_approval_policies_scope_pattern_uq/,
    );
    // The same pattern on two units, and next to the organization rule, is allowed; twice on one unit is not.
    await policy(o, { pattern, scope: o.unit });
    await policy(o, { pattern, scope: o.unit2 });
    await expect(policy(o, { pattern, scope: o.unit })).rejects.toThrow(
      /tool_approval_policies_scope_pattern_uq/,
    );
    // Another organization has its own rules.
    await policy(await seedOrg(), { pattern });
  });

  it("refuses an approver set that does not match its kind", async () => {
    const o = await seedOrg();
    const approvers = /violates check constraint "tool_approval_policies_approvers_check"/;
    await expect(policy(o, { kind: "users", approvers: [] })).rejects.toThrow(approvers);
    await expect(policy(o, { kind: "users", approvers: people(21) })).rejects.toThrow(approvers);
    await expect(policy(o, { kind: "users", approvers: [randomUUID(), null] })).rejects.toThrow(approvers);
    await expect(policy(o, { kind: "admins", approvers: people(1) })).rejects.toThrow(approvers);
    await expect(policy(o, { kind: "requester", approvers: people(1) })).rejects.toThrow(approvers);
    await expect(policy(o, { kind: "unit_leads", scope: o.unit, approvers: people(1) })).rejects.toThrow(
      approvers,
    );
    await policy(o, { kind: "users", approvers: people(1) });
    await policy(o, { kind: "users", approvers: people(20) });
    await policy(o, { kind: "admins" });
    // Unit leads exist only on a unit.
    await expect(policy(o, { kind: "unit_leads" })).rejects.toThrow(
      /tool_approval_policies_unit_leads_scope_check/,
    );
    await policy(o, { kind: "unit_leads", scope: o.unit });
  });

  it("refuses unknown modes and kinds, approvers on a `never` rule, a zero version and an empty pattern", async () => {
    const o = await seedOrg();
    await expect(policy(o, { mode: "sometimes" })).rejects.toThrow(/tool_approval_policies_mode_check/);
    await expect(policy(o, { kind: "owners" })).rejects.toThrow(/tool_approval_policies_approver_kind_check/);
    await expect(policy(o, { mode: "never", kind: "users", approvers: people(1) })).rejects.toThrow(
      /tool_approval_policies_never_requester_check/,
    );
    await expect(policy(o, { mode: "never", kind: "admins" })).rejects.toThrow(
      /tool_approval_policies_never_requester_check/,
    );
    await policy(o, { mode: "never" });
    await expect(policy(o, { version: 0 })).rejects.toThrow(/tool_approval_policies_version_check/);
    await expect(policy(o, { pattern: "" })).rejects.toThrow(/tool_approval_policies_tool_pattern_len_check/);
  });
});

describe("tool call approvals (the stored action)", () => {
  it("counts the arguments' bytes, not their characters: 32,768 bytes fit, 32,769 do not", async () => {
    const o = await seedOrg();
    // "é" is 2 bytes in UTF-8: 2 quotes + 16,383 × 2 = 32,768 bytes in 16,385 characters.
    const fits = `"${"é".repeat(16_383)}"`;
    expect(Buffer.byteLength(fits, "utf8")).toBe(32_768);
    await approval(o, { args: fits });
    await expect(approval(o, { args: `"${"é".repeat(16_383)}a"` })).rejects.toThrow(
      /tool_call_approvals_arguments_size_check/,
    );
  });

  it("stores only lowercase 64-character hashes", async () => {
    const o = await seedOrg();
    await expect(approval(o, { actionHash: "A".repeat(64) })).rejects.toThrow(
      /tool_call_approvals_action_hash_check/,
    );
    await expect(approval(o, { actionHash: "a".repeat(63) })).rejects.toThrow(
      /tool_call_approvals_action_hash_check/,
    );
    await expect(approval(o, { argsSha: "g".repeat(64) })).rejects.toThrow(
      /tool_call_approvals_arguments_sha256_check/,
    );
    await expect(approval(o, { argsSha: `${"a".repeat(64)}\n` })).rejects.toThrow(
      /tool_call_approvals_arguments_sha256_check/,
    );
  });

  it("one request per (event, tool call id); calls without an id never collide", async () => {
    const o = await seedOrg();
    await approval(o, { callId: "call-1" });
    await expect(approval(o, { callId: "call-1" })).rejects.toThrow(/tool_call_approvals_event_call_uq/);
    await approval(o, { callId: "call-1", event: randomUUID() });
    await approval(o, { callId: null });
    await approval(o, { callId: null });
    await expect(approval(o, { callId: "x".repeat(201) })).rejects.toThrow(
      /tool_call_approvals_tool_call_id_len_check/,
    );
  });

  it("knows the ledger's source kinds, keychain requests included", async () => {
    const o = await seedOrg();
    for (const sourceKind of ["builtin", "mcp", "plugin", "vault"]) await approval(o, { sourceKind });
    await expect(approval(o, { sourceKind: "other" })).rejects.toThrow(
      /tool_call_approvals_source_kind_check/,
    );
  });

  it("never changes once stored; only the rule's deletion clears its link", async () => {
    const o = await seedOrg();
    const rule = await policy(o);
    const other = await policy(o);
    const id = await approval(o, { policy: rule });
    for (const set of [
      "arguments_canonical = '{}'",
      "action_hash = repeat('b', 64)",
      "tainted = false",
      "requested_for_user_id = gen_random_uuid()",
      `policy_id = '${other}'`,
    ]) {
      await expect(
        db.query(`update app.tool_call_approvals set ${set} where id = $1`, [id]),
        set,
      ).rejects.toThrow(/tool call approvals are immutable/);
    }
    await db.query("delete from app.tool_approval_policies where id = $1", [rule]);
    const row = await db.query(
      "select policy_id, arguments_canonical from app.tool_call_approvals where id = $1",
      [id],
    );
    expect(row.rows).toEqual([{ policy_id: null, arguments_canonical: '{"method":"GET"}' }]);
  });
});

describe("Work Zone proposals", () => {
  it("bounds the prompt to 1–50,000 characters and knows the runtimes", async () => {
    const o = await seedOrg();
    await expect(proposal(o, { prompt: "" })).rejects.toThrow(/work_zone_proposals_prompt_len_check/);
    await expect(proposal(o, { prompt: "x".repeat(50_001) })).rejects.toThrow(
      /work_zone_proposals_prompt_len_check/,
    );
    // Characters, not bytes: 50,000 two-byte characters fit.
    await proposal(o, { prompt: "é".repeat(50_000) });
    await proposal(o, { runtime: "codex" });
    await expect(proposal(o, { runtime: "opencode" })).rejects.toThrow(/work_zone_proposals_runtime_check/);
    await expect(proposal(o, { promptSha: "A".repeat(64) })).rejects.toThrow(
      /work_zone_proposals_prompt_sha256_check/,
    );
  });

  it("one proposal per (event, project, device, prompt)", async () => {
    const o = await seedOrg();
    const event = randomUUID();
    await proposal(o, { event });
    await expect(proposal(o, { event })).rejects.toThrow(/work_zone_proposals_request_uq/);
    await proposal(o, { event, promptSha: "b".repeat(64) });
    await proposal(o, { promptSha: HASH });
  });

  it("never changes, except the session it started: set once, cleared by the session's deletion", async () => {
    const o = await seedOrg();
    const id = await proposal(o);
    await expect(
      db.query("update app.work_zone_proposals set prompt = 'Delete everything' where id = $1", [id]),
    ).rejects.toThrow(/work zone proposals are immutable/);
    await expect(
      db.query("update app.work_zone_proposals set runtime = 'codex' where id = $1", [id]),
    ).rejects.toThrow(/work zone proposals are immutable/);
    await db.query("update app.work_zone_proposals set work_session_id = $2 where id = $1", [id, o.session]);
    const other = await session(o);
    await expect(
      db.query("update app.work_zone_proposals set work_session_id = $2 where id = $1", [id, other]),
    ).rejects.toThrow(/work zone proposals are immutable/);
    await db.query("delete from app.work_sessions where id = $1", [o.session]);
    const row = await db.query("select work_session_id, prompt from app.work_zone_proposals where id = $1", [
      id,
    ]);
    expect(row.rows).toEqual([{ work_session_id: null, prompt: "Run the tests" }]);
  });
});

describe("deletions", () => {
  it("a deleted bot removes its approval resources and proposals and only unlinks the prompts it proposed", async () => {
    const o = await seedOrg();
    const bot = await agent(o);
    const keep = { approval: await approval(o), proposal: await proposal(o) };
    await approval(o, { agent: bot });
    await proposal(o, { agent: bot });
    const prompt = (
      await db.query(
        "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, proposed_by_agent_id) values ($1, $2, $3, 'Run the tests', 1, $4) returning id",
        [o.id, o.session, o.user, bot],
      )
    ).rows[0].id;
    await db.query("delete from app.agents where id = $1", [bot]);
    const left = await db.query(
      `select (select array_agg(id) from app.tool_call_approvals where organization_id = $1) as approvals,
              (select array_agg(id) from app.work_zone_proposals where organization_id = $1) as proposals,
              (select proposed_by_agent_id from app.work_prompts where id = $2) as proposed_by,
              (select count(*)::int from app.work_prompts where id = $2) as prompts`,
      [o.id, prompt],
    );
    expect(left.rows).toEqual([
      { approvals: [keep.approval], proposals: [keep.proposal], proposed_by: null, prompts: 1 },
    ]);
  });

  it("a deleted unit removes its rules and unlinks the approvals they required; a deleted project removes its proposals", async () => {
    const o = await seedOrg();
    const rule = await policy(o, { scope: o.unit, kind: "unit_leads" });
    const orgRule = await policy(o);
    const id = await approval(o, { policy: rule });
    const kept = await approval(o, { policy: orgRule });
    await db.query("delete from app.org_units where id = $1", [o.unit]);
    const rules = await db.query("select id from app.tool_approval_policies where organization_id = $1", [
      o.id,
    ]);
    expect(rules.rows).toEqual([{ id: orgRule }]);
    const links = await db.query(
      "select id, policy_id from app.tool_call_approvals where organization_id = $1",
      [o.id],
    );
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    expect(links.rows.sort(byId)).toEqual(
      [
        { id, policy_id: null },
        { id: kept, policy_id: orgRule },
      ].sort(byId),
    );
    await proposal(o);
    await db.query("delete from app.projects where id = $1", [o.project]);
    const proposals = await db.query(
      "select count(*)::int as n from app.work_zone_proposals where organization_id = $1",
      [o.id],
    );
    expect(proposals.rows[0].n).toBe(0);
  });
});
