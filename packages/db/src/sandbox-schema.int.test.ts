import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.8 (D-01, D-08, D-09, D-12, P-17, SBX-01/02/05, BRW-01/03/04): the shapes a bug in the API must never store
 * are refused by PostgreSQL itself, each through a NAMED constraint the API maps to a 4xx (asserted on the error's
 * `constraint`, the field the API reads), and deletions keep or remove the sandbox and browser rows as the phase
 * decided. Runs as ocw_migrator (no RLS in the way) on a fresh database with every migration applied; tenant isolation
 * of the same tables, the organization carried by every foreign key and the owner-only browser sessions are proven in
 * rls-isolation.int.test.ts.
 */

let tdb: TestDatabase;
let db: pg.Client;

interface Org {
  id: string;
  ana: string;
  channel: string;
  scout: string;
  helper: string;
  event: string;
}

const HASH = "a".repeat(64);

async function seedOrg(): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    ana: randomUUID(),
    channel: randomUUID(),
    scout: randomUUID(),
    helper: randomUUID(),
    event: randomUUID(),
  };
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [o.channel, o.id, `general-${o.channel}`],
  );
  for (const [agent, name] of [
    [o.scout, "scout"],
    [o.helper, "helper"],
  ] as const)
    await db.query(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, $3, $4, 'x', 'mock', 'mock-1')",
      [agent, o.id, name, `${name}-${agent.slice(0, 8)}`],
    );
  await db.query(
    "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'channel', $6)",
    [o.event, o.id, o.scout, o.ana, o.channel, randomUUID()],
  );
  return o;
}

/** The sealed state of a session: a `browser_session` secret (its value is never in any other table). */
async function sealed(o: Org): Promise<string> {
  return (
    await db.query(
      "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, 'browser session', 'browser_session', 'c', 'i', 't') returning id",
      [o.id],
    )
  ).rows[0].id as string;
}

async function session(
  o: Org,
  r: { user?: string; agent?: string; site?: string; secret?: string } = {},
): Promise<string> {
  return (
    await db.query(
      "insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at) values ($1, $2, $3, $4, $5, now() + interval '30 days') returning id",
      [
        o.id,
        r.user ?? o.ana,
        r.agent ?? o.scout,
        r.site ?? "panel.autofy.app",
        r.secret ?? (await sealed(o)),
      ],
    )
  ).rows[0].id as string;
}

async function context(
  o: Org,
  r: {
    host?: string;
    state?: string;
    session?: string | null;
    controller?: string | null;
    lease?: string | null;
  } = {},
): Promise<string> {
  return (
    await db.query(
      `insert into app.browser_contexts (organization_id, agent_id, conversation_id, requested_for_user_id, event_id, host, secure, state, session_id, controller_user_id, lease_expires_at)
       values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10) returning id`,
      [
        o.id,
        o.scout,
        o.channel,
        o.ana,
        o.event,
        r.host ?? "panel.autofy.app",
        r.state ?? "live",
        r.session ?? null,
        r.controller ?? null,
        r.lease ?? null,
      ],
    )
  ).rows[0].id as string;
}

function signin(
  o: Org,
  contextId: string,
  r: { reason?: string; event?: string; session?: string | null } = {},
) {
  return db.query(
    `insert into app.browser_signin_requests (organization_id, agent_id, context_id, requester_user_id, conversation_id, event_id, host, reason, session_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, 'panel.autofy.app', $7, $8, now() + interval '15 minutes') returning id`,
    [
      o.id,
      o.scout,
      contextId,
      o.ana,
      o.channel,
      r.event ?? o.event,
      r.reason ?? "Read the open invoices",
      r.session ?? null,
    ],
  );
}

interface PackageRow {
  source?: string;
  name?: string;
  version?: string;
  sha256?: string;
  tree?: string;
  deps?: number;
  lockfile?: string;
  status?: string;
}

function pkg(o: Org, r: PackageRow = {}) {
  return db
    .query(
      `insert into app.sandbox_packages (organization_id, source, name, version, sha256, size_bytes, has_install_script, risk, review_token, tree_sha256, dependency_count, lockfile, status)
       values ($1, $2, $3, $4, $5, 1024, false, 'low', 'review-token', $6, $7, $8, $9) returning id`,
      [
        o.id,
        r.source ?? "npm",
        r.name ?? `pkg-${randomUUID().slice(0, 8)}`,
        r.version ?? "1.0.0",
        r.sha256 ?? HASH,
        r.tree ?? HASH,
        r.deps ?? 0,
        r.lockfile ?? '{"lockfileVersion":3}',
        r.status ?? "approved",
      ],
    )
    .then((res) => res.rows[0].id as string);
}

/** The statement fails through exactly this named constraint (the name the API maps to a 4xx). */
async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

const count = async (sql: string, values: unknown[]) =>
  (await db.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n as number;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await tdb?.stop();
});

describe("sandbox policies (D-01, D-09, D-12)", () => {
  it("a new organization's row reads the defaults: off, shell allow list, public browser, 10/3/600/2048/51200, 30 days", async () => {
    const o = await seedOrg();
    await db.query("insert into app.sandbox_policies (organization_id) values ($1)", [o.id]);
    const row = await db.query(
      `select enabled, sandbox_egress_mode, browser_egress_mode, egress_allow_hosts, max_sandboxes, max_browsers,
              cpu_minutes_per_day, disk_per_bot_mb, disk_total_mb, browser_session_max_days, killed_at, killed_by, version
         from app.sandbox_policies where organization_id = $1`,
      [o.id],
    );
    expect(row.rows).toEqual([
      {
        enabled: false,
        sandbox_egress_mode: "allowlist",
        browser_egress_mode: "public",
        egress_allow_hosts: [],
        max_sandboxes: 10,
        max_browsers: 3,
        cpu_minutes_per_day: 600,
        disk_per_bot_mb: 2048,
        disk_total_mb: 51200,
        browser_session_max_days: 30,
        killed_at: null,
        killed_by: null,
        version: 1,
      },
    ]);
  });

  it("refuses an unknown egress mode, more than 64 hosts and every out-of-range limit by name", async () => {
    const o = await seedOrg();
    await db.query("insert into app.sandbox_policies (organization_id) values ($1)", [o.id]);
    const set = (assignment: string, values: unknown[] = []) =>
      db.query(`update app.sandbox_policies set ${assignment} where organization_id = $1`, [o.id, ...values]);
    await refused(set("sandbox_egress_mode = 'open'"), { constraint: "sandbox_policies_egress_mode_check" });
    await refused(set("browser_egress_mode = 'open'"), { constraint: "sandbox_policies_egress_mode_check" });
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.test`);
    await refused(set("egress_allow_hosts = $2", [hosts(65)]), {
      constraint: "sandbox_policies_allow_hosts_check",
    });
    await set("egress_allow_hosts = $2", [hosts(64)]);
    await refused(set("egress_allow_hosts = array[null]::text[]"), {
      constraint: "sandbox_policies_allow_hosts_check",
    });
    for (const bad of [
      "max_sandboxes = 101",
      "max_sandboxes = -1",
      "max_browsers = 51",
      "cpu_minutes_per_day = 0",
      "cpu_minutes_per_day = 100001",
      "disk_per_bot_mb = 63",
      "disk_per_bot_mb = 102401",
      "disk_total_mb = 63",
      "disk_total_mb = 1048577",
    ])
      await refused(set(bad), { constraint: "sandbox_policies_limits_check" });
    await set(
      "max_sandboxes = 0, max_browsers = 0, cpu_minutes_per_day = 1, disk_per_bot_mb = 64, disk_total_mb = 64",
    );
    await set(
      "max_sandboxes = 100, max_browsers = 50, cpu_minutes_per_day = 100000, disk_per_bot_mb = 102400, disk_total_mb = 1048576",
    );
    await refused(set("browser_session_max_days = 91"), {
      constraint: "sandbox_policies_session_days_check",
    });
    await refused(set("browser_session_max_days = 0"), { constraint: "sandbox_policies_session_days_check" });
    await refused(set("version = 0"), { constraint: "sandbox_policies_version_check" });
  });
});

describe("sandboxes, usage and the event cursor (D-01, SBX-01/02)", () => {
  it("one shell and one browser sandbox per bot, with known states and a non-negative disk", async () => {
    const o = await seedOrg();
    const sandbox = (
      kind: string,
      r: { agent?: string; state?: string; disk?: number; runtime?: string; stop?: string } = {},
    ) =>
      db.query(
        "insert into app.bot_sandboxes (organization_id, agent_id, kind, state, disk_bytes, runtime, stop_reason) values ($1, $2, $3, $4, $5, $6, $7)",
        [
          o.id,
          r.agent ?? o.scout,
          kind,
          r.state ?? "running",
          r.disk ?? 0,
          r.runtime ?? null,
          r.stop ?? null,
        ],
      );
    await sandbox("sbx", { runtime: "gvisor" });
    await refused(sandbox("sbx"), { constraint: "bot_sandboxes_agent_kind_uq" });
    await sandbox("brw", { state: "stopped", runtime: "hardened-runc", stop: "idle" });
    await sandbox("sbx", { agent: o.helper });
    await refused(sandbox("vm", { agent: o.helper }), { constraint: "bot_sandboxes_kind_check" });
    await refused(sandbox("brw", { agent: o.helper, disk: -1 }), { constraint: "bot_sandboxes_disk_check" });
    await refused(sandbox("brw", { agent: o.helper, state: "paused" }), {
      constraint: "bot_sandboxes_state_check",
    });
    await refused(sandbox("brw", { agent: o.helper, runtime: "kata" }), {
      constraint: "bot_sandboxes_runtime_check",
    });
    await refused(sandbox("brw", { agent: o.helper, stop: "crashed" }), {
      constraint: "bot_sandboxes_stop_reason_check",
    });
  });

  it("refuses negative CPU usage and a negative event cursor; the cursor holds one position per organization", async () => {
    const o = await seedOrg();
    await refused(
      db.query(
        "insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, current_date, -1)",
        [o.id, o.scout],
      ),
      { constraint: "sandbox_usage_daily_cpu_check" },
    );
    await db.query(
      "insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, current_date, 0)",
      [o.id, o.scout],
    );
    await refused(
      db.query(
        "insert into app.sandbox_usage_daily (organization_id, agent_id, day) values ($1, $2, current_date)",
        [o.id, o.scout],
      ),
      { constraint: "sandbox_usage_daily_pkey" },
    );
    await refused(
      db.query("insert into app.sandbox_event_cursor (organization_id, boot_id, seq) values ($1, $2, -1)", [
        o.id,
        randomUUID(),
      ]),
      { constraint: "sandbox_event_cursor_seq_check" },
    );
    await db.query("insert into app.sandbox_event_cursor (organization_id, boot_id) values ($1, $2)", [
      o.id,
      randomUUID(),
    ]);
    await refused(
      db.query("insert into app.sandbox_event_cursor (organization_id, boot_id) values ($1, $2)", [
        o.id,
        randomUUID(),
      ]),
      { constraint: "sandbox_event_cursor_pkey" },
    );
    expect(
      (
        await db.query("select seq::int as seq from app.sandbox_event_cursor where organization_id = $1", [
          o.id,
        ])
      ).rows,
    ).toEqual([{ seq: 0 }]);
  });

  it("an organization's event cursor is invisible to another organization as the app role", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await db.query(
      "insert into app.sandbox_event_cursor (organization_id, boot_id, seq) values ($1, $2, 41)",
      [a.id, randomUUID()],
    );
    const app = new pg.Client({ connectionString: tdb.appUrl });
    await app.connect();
    try {
      const read = async (org: string) => {
        await app.query("begin");
        try {
          await app.query("select set_config('app.organization_id', $1, true)", [org]);
          return (await app.query("select seq::int as seq from app.sandbox_event_cursor")).rows;
        } finally {
          await app.query("rollback");
        }
      };
      expect(await read(a.id)).toEqual([{ seq: 41 }]);
      expect(await read(b.id)).toEqual([]);
    } finally {
      await app.end();
    }
  });

  it("refuses a negative per-turn sandbox call count", async () => {
    const o = await seedOrg();
    await refused(db.query("update app.agent_turns set sandbox_calls = -1 where event_id = $1", [o.event]), {
      constraint: "agent_turns_sandbox_calls_check",
    });
    await db.query("update app.agent_turns set sandbox_calls = 40, member_data = true where event_id = $1", [
      o.event,
    ]);
  });
});

describe("browser contexts, sessions and sign-in requests (D-06, D-08, BRW-01/03/04)", () => {
  it("a takeover lease has both a controller and an expiry, or neither; hosts and states are bounded", async () => {
    const o = await seedOrg();
    await refused(context(o, { controller: o.ana }), { constraint: "browser_contexts_lease_check" });
    await refused(context(o, { lease: new Date().toISOString() }), {
      constraint: "browser_contexts_lease_check",
    });
    await context(o, { controller: o.ana, lease: new Date(Date.now() + 60_000).toISOString() });
    await context(o, { host: "localhost:8443" });
    for (const host of [
      "Panel.autofy.app",
      "panel.autofy.app/invoices",
      "ana@panel.autofy.app",
      "",
      "a".repeat(261),
    ])
      await refused(context(o, { host }), { constraint: "browser_contexts_host_check" });
    await refused(context(o, { state: "controlling" }), { constraint: "browser_contexts_state_check" });
    const id = await context(o);
    await refused(db.query("update app.browser_contexts set paused_for = 'captcha' where id = $1", [id]), {
      constraint: "browser_contexts_paused_for_check",
    });
    await refused(db.query("update app.browser_contexts set end_reason = 'timeout' where id = $1", [id]), {
      constraint: "browser_contexts_end_reason_check",
    });
    await db.query(
      "update app.browser_contexts set state = 'ended', closed_at = now(), end_reason = 'closed_by_bot' where id = $1",
      [id],
    );
  });

  it("one session per (member, bot, site), the site a lower-case host with no path or credentials (U-3)", async () => {
    const o = await seedOrg();
    const sam = randomUUID();
    await session(o);
    await refused(session(o), { constraint: "browser_sessions_owner_site_uq" });
    // The same site for another bot, or for another member with the same bot, is a separate session.
    await session(o, { agent: o.helper });
    await session(o, { user: sam });
    await session(o, { site: "panel.autofy.app:8443" });
    for (const site of [
      "Panel.Autofy.App",
      "panel.autofy.app/login",
      "ana@panel.autofy.app",
      "",
      "a".repeat(261),
    ])
      await refused(session(o, { site }), { constraint: "browser_sessions_site_key_check" });
  });

  it("a sign-in request gives a 1–200 character reason, a known status, and is asked once per (turn, context)", async () => {
    const o = await seedOrg();
    const ctx = await context(o);
    await refused(signin(o, ctx, { reason: "x".repeat(201) }), {
      constraint: "browser_signin_requests_reason_check",
    });
    await refused(signin(o, ctx, { reason: "" }), { constraint: "browser_signin_requests_reason_check" });
    const first = (await signin(o, ctx, { reason: "x".repeat(200) })).rows[0].id as string;
    await refused(signin(o, ctx), { constraint: "browser_signin_requests_event_uq" });
    // Another turn may ask again on the same context.
    await signin(o, ctx, { event: randomUUID() });
    const status = await db.query("select status from app.browser_signin_requests where id = $1", [first]);
    expect(status.rows).toEqual([{ status: "waiting" }]);
    await refused(
      db.query("update app.browser_signin_requests set status = 'approved' where id = $1", [first]),
      { constraint: "browser_signin_requests_status_check" },
    );
    await refused(
      db.query("update app.browser_signin_requests set stop_reason = 'user' where id = $1", [first]),
      { constraint: "browser_signin_requests_stop_reason_check" },
    );
    await refused(
      db.query("update app.browser_signin_requests set host = 'Panel.autofy.app' where id = $1", [first]),
      { constraint: "browser_signin_requests_host_check" },
    );
  });
});

describe("turn activity (SBX-02, WINDOWS #168)", () => {
  it("keeps at most 50 steps in an array and a non-negative count of older ones", async () => {
    const o = await seedOrg();
    const steps = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ id: `s${i}`, tool: "ocw_sandbox_exec", verb: "ran" })),
      );
    const activity = (stepsJson: string, more = 0) =>
      db.query(
        "insert into app.bot_turn_activity (event_id, organization_id, agent_id, conversation_id, steps, more) values ($1, $2, $3, $4, $5::jsonb, $6)",
        [randomUUID(), o.id, o.scout, o.channel, stepsJson, more],
      );
    await refused(activity(steps(51)), { constraint: "bot_turn_activity_steps_check" });
    await refused(activity('{"id":"s1"}'), { constraint: "bot_turn_activity_steps_check" });
    await refused(activity(steps(1), -1), { constraint: "bot_turn_activity_steps_check" });
    await activity(steps(50), 12);
    const fresh = randomUUID();
    await db.query(
      "insert into app.bot_turn_activity (event_id, organization_id, agent_id, conversation_id) values ($1, $2, $3, $4)",
      [fresh, o.id, o.scout, o.channel],
    );
    const row = await db.query("select steps, more, running from app.bot_turn_activity where event_id = $1", [
      fresh,
    ]);
    expect(row.rows).toEqual([{ steps: [], more: 0, running: true }]);
  });
});

describe("sandbox packages (D-03, D-11, P-12, SBX-05)", () => {
  it("pins a lower-case artifact hash, the whole tree's hash and size, and a bounded lockfile", async () => {
    const o = await seedOrg();
    await refused(pkg(o, { sha256: "A".repeat(64) }), { constraint: "sandbox_packages_sha256_check" });
    await refused(pkg(o, { sha256: "a".repeat(63) }), { constraint: "sandbox_packages_sha256_check" });
    await refused(pkg(o, { tree: "A".repeat(64) }), { constraint: "sandbox_packages_tree_check" });
    await refused(pkg(o, { deps: 5001 }), { constraint: "sandbox_packages_tree_check" });
    await refused(pkg(o, { deps: -1 }), { constraint: "sandbox_packages_tree_check" });
    await pkg(o, { deps: 5000 });
    await refused(pkg(o, { lockfile: "x".repeat(2_097_153) }), {
      constraint: "sandbox_packages_lockfile_check",
    });
    await pkg(o, { lockfile: "x".repeat(2_097_152) });
    // Bytes, not characters: 1,048,577 two-byte characters are over the limit.
    await refused(pkg(o, { lockfile: "é".repeat(1_048_577) }), {
      constraint: "sandbox_packages_lockfile_check",
    });
    await refused(pkg(o, { name: "" }), { constraint: "sandbox_packages_name_check" });
    await refused(pkg(o, { name: "n".repeat(215) }), { constraint: "sandbox_packages_name_check" });
    await refused(pkg(o, { version: "v".repeat(129) }), { constraint: "sandbox_packages_version_check" });
    await refused(pkg(o, { source: "cargo" }), { constraint: "sandbox_packages_source_check" });
    await refused(pkg(o, { status: "installed" }), { constraint: "sandbox_packages_status_check" });
    const id = await pkg(o);
    await refused(db.query("update app.sandbox_packages set size_bytes = -1 where id = $1", [id]), {
      constraint: "sandbox_packages_size_check",
    });
    await refused(db.query("update app.sandbox_packages set risk = 'critical' where id = $1", [id]), {
      constraint: "sandbox_packages_risk_check",
    });
    await refused(db.query(`update app.sandbox_packages set risk_reasons = '{"a":1}' where id = $1`, [id]), {
      constraint: "sandbox_packages_risk_reasons_check",
    });
  });

  it("one live package per (source, name): a second approval is refused until the first is removed", async () => {
    const o = await seedOrg();
    const first = await pkg(o, { name: "left-pad", version: "1.3.0" });
    await refused(pkg(o, { name: "left-pad", version: "1.3.1" }), {
      constraint: "sandbox_packages_org_source_name_uq",
    });
    // Another source may carry the same name.
    await pkg(o, { source: "pypi", name: "left-pad" });
    await db.query("update app.sandbox_packages set status = 'removed' where id = $1", [first]);
    await pkg(o, { name: "left-pad", version: "1.3.1" });
    expect(
      await count(
        "app.sandbox_packages where organization_id = $1 and source = 'npm' and name = 'left-pad'",
        [o.id],
      ),
    ).toBe(2);
  });

  it("an approved package's pins never change, for every role; its switches and state do (07.8-18, WINDOWS #231)", async () => {
    const o = await seedOrg();
    const id = await pkg(o, { name: "left-pad", version: "1.3.0" });
    for (const [column, value] of [
      ["source", "pypi"],
      ["name", "right-pad"],
      ["version", "1.3.1"],
      ["sha256", "b".repeat(64)],
      ["tree_sha256", "b".repeat(64)],
      ["lockfile", '{"lockfileVersion":3,"packages":{}}'],
      ["dependency_count", 7],
      ["review_token", "another-review"],
    ] as const) {
      await expect(
        db.query(`update app.sandbox_packages set ${column} = $2 where id = $1`, [id, value]),
        column,
      ).rejects.toMatchObject({ code: "23514", message: "sandbox package pins are immutable" });
    }
    // An update that leaves the pins as they are passes: the switches, the upstream flag and the removal.
    await db.query(
      `update app.sandbox_packages set enabled = false, personal_allowed = true, changed_upstream = true,
         status = 'removed', sha256 = sha256, updated_at = now() where id = $1`,
      [id],
    );
    const row = (
      await db.query(
        "select sha256, tree_sha256, enabled, personal_allowed, changed_upstream, status from app.sandbox_packages where id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      sha256: HASH,
      tree_sha256: HASH,
      enabled: false,
      personal_allowed: true,
      changed_upstream: true,
      status: "removed",
    });
  });

  it("an install has a known status and a short detail", async () => {
    const o = await seedOrg();
    const id = await pkg(o);
    const install = (status: string, detail: string | null = null) =>
      db.query(
        "insert into app.sandbox_package_installs (organization_id, agent_id, package_id, status, detail) values ($1, $2, $3, $4, $5)",
        [o.id, o.scout, id, status, detail],
      );
    await refused(install("done"), { constraint: "sandbox_package_installs_status_check" });
    await refused(install("failed", "x".repeat(201)), {
      constraint: "sandbox_package_installs_detail_check",
    });
    await install("failed", "integrity_mismatch");
    await refused(install("pending"), { constraint: "sandbox_package_installs_pkey" });
  });
});

describe("deletions", () => {
  it("deleting a bot removes its sandboxes, usage, contexts, sessions, sign-in requests, activity and installs", async () => {
    const o = await seedOrg();
    const id = await pkg(o);
    await db.query(
      "insert into app.bot_sandboxes (organization_id, agent_id, kind, state) values ($1, $2, 'sbx', 'running'), ($1, $2, 'brw', 'running'), ($1, $3, 'sbx', 'running')",
      [o.id, o.scout, o.helper],
    );
    await db.query(
      "insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, current_date, 10), ($1, $3, current_date, 10)",
      [o.id, o.scout, o.helper],
    );
    const s = await session(o);
    const secret = (await db.query("select secret_id from app.browser_sessions where id = $1", [s])).rows[0]
      .secret_id as string;
    const ctx = await context(o, { session: s });
    await signin(o, ctx, { session: s });
    await db.query(
      "insert into app.bot_turn_activity (event_id, organization_id, agent_id, conversation_id) values ($1, $2, $3, $4)",
      [o.event, o.id, o.scout, o.channel],
    );
    await db.query(
      "insert into app.sandbox_package_installs (organization_id, agent_id, package_id, status) values ($1, $2, $4, 'installed'), ($1, $3, $4, 'installed')",
      [o.id, o.scout, o.helper, id],
    );
    await db.query("delete from app.agents where id = $1", [o.scout]);
    const left = async (agent: string) =>
      Object.fromEntries(
        await Promise.all(
          [
            "bot_sandboxes",
            "sandbox_usage_daily",
            "browser_contexts",
            "browser_sessions",
            "browser_signin_requests",
            "bot_turn_activity",
            "sandbox_package_installs",
          ].map(async (t) => [t, await count(`app.${t} where agent_id = $1`, [agent])]),
        ),
      );
    expect(await left(o.scout)).toEqual({
      bot_sandboxes: 0,
      sandbox_usage_daily: 0,
      browser_contexts: 0,
      browser_sessions: 0,
      browser_signin_requests: 0,
      bot_turn_activity: 0,
      sandbox_package_installs: 0,
    });
    // The other bot keeps its rows; the organization keeps the approved package. The sealed secret is the API's to
    // delete (it opens only with the member's AAD); it is no longer referenced by any session.
    expect(await left(o.helper)).toMatchObject({
      bot_sandboxes: 1,
      sandbox_usage_daily: 1,
      sandbox_package_installs: 1,
    });
    expect(await count("app.sandbox_packages where id = $1", [id])).toBe(1);
    expect(await count("app.secrets where id = $1", [secret])).toBe(1);
  });

  it("deleting a session only unlinks its contexts and sign-in requests; deleting its secret removes the session", async () => {
    const o = await seedOrg();
    const s = await session(o);
    const ctx = await context(o, { session: s });
    const request = (await signin(o, ctx, { session: s })).rows[0].id as string;
    await db.query("delete from app.browser_sessions where id = $1", [s]);
    expect(
      (await db.query("select organization_id, session_id from app.browser_contexts where id = $1", [ctx]))
        .rows,
    ).toEqual([{ organization_id: o.id, session_id: null }]);
    expect(
      (
        await db.query("select organization_id, session_id from app.browser_signin_requests where id = $1", [
          request,
        ])
      ).rows,
    ).toEqual([{ organization_id: o.id, session_id: null }]);

    const again = await session(o);
    await db.query("update app.browser_contexts set session_id = $2 where id = $1", [ctx, again]);
    const secret = (await db.query("select secret_id from app.browser_sessions where id = $1", [again]))
      .rows[0].secret_id as string;
    await db.query("delete from app.secrets where id = $1", [secret]);
    expect(await count("app.browser_sessions where id = $1", [again])).toBe(0);
    expect((await db.query("select session_id from app.browser_contexts where id = $1", [ctx])).rows).toEqual(
      [{ session_id: null }],
    );
  });

  it("deleting a conversation removes its contexts and their sign-in requests; deleting a package removes its installs", async () => {
    const o = await seedOrg();
    const s = await session(o);
    const ctx = await context(o, { session: s });
    await signin(o, ctx);
    await db.query("delete from app.conversations where id = $1", [o.channel]);
    expect(await count("app.browser_contexts where id = $1", [ctx])).toBe(0);
    expect(await count("app.browser_signin_requests where context_id = $1", [ctx])).toBe(0);
    // The member's session is not the conversation's: it stays.
    expect(await count("app.browser_sessions where id = $1", [s])).toBe(1);

    const id = await pkg(o);
    await db.query(
      "insert into app.sandbox_package_installs (organization_id, agent_id, package_id, status) values ($1, $2, $3, 'installed')",
      [o.id, o.scout, id],
    );
    await db.query("delete from app.sandbox_packages where id = $1", [id]);
    expect(await count("app.sandbox_package_installs where package_id = $1", [id])).toBe(0);
  });
});
