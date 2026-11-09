import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.16 (D-01, D-03, D-06, D-08, D-15, D-16, D-19, D-20, PD-22): the bot Work Zone storage. The shapes a bug in
 * the API must never store are refused by PostgreSQL itself, each through a NAMED constraint (asserted on the error's
 * `constraint`, the field the API reads): one profile per bot, profile projects pinned to the profile's device, one live
 * consent per (device, bot), the limit ranges, a prompt with two agent authors. Deleting a bot unlinks the sessions and
 * prompts it started or wrote (never their `organization_id`) and removes its profile, consents and bot session rows.
 * Seeded and checked as ocw_migrator (no RLS in the way) on a fresh database with every migration applied; the tenant
 * isolation, the session audience backstop and the TRUNCATE revokes are proven as ocw_app in the second block.
 */

let tdb: TestDatabase;
let db: pg.Client;
let app: pg.Client;

interface Org {
  id: string;
  sponsor: string;
  outsider: string;
  agent: string;
  device: string;
  otherDevice: string;
  project: string;
  otherProject: string;
  channel: string;
  session: string;
}

type Q = pg.Client["query"];

async function person(org: string, id: string, role: string): Promise<void> {
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [id, `${id}@bwz.test`]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', $3)",
    [org, id, role],
  );
}

async function bot(org: string, name = "builder"): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, $3, $4, 'x', 'mock', 'mock-1')",
    [id, org, name, `${name}-${id.slice(0, 8)}`],
  );
  return id;
}

async function device(org: string, owner: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'build server', 'linux', $4)",
    [id, org, owner, `tok-${id}`],
  );
  return id;
}

async function project(org: string, dev: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
    [id, org, dev, `l-${id}`],
  );
  return id;
}

async function workSession(
  o: Org,
  r: { startedBy?: string | null; createdBy?: string } = {},
): Promise<string> {
  const conv = randomUUID();
  const id = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conv, o.id],
  );
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, started_by_agent_id) values ($1, $2, $3, $4, $5, 'T', $6, $7)",
    [id, o.id, conv, o.project, o.device, r.createdBy ?? o.sponsor, r.startedBy ?? null],
  );
  return id;
}

async function seedOrg(): Promise<Org> {
  const id = randomUUID();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [id, `o-${id}`]);
  const sponsor = randomUUID();
  const outsider = randomUUID();
  await person(id, sponsor, "standard");
  await person(id, outsider, "standard");
  const agent = await bot(id);
  const dev = await device(id, sponsor);
  const otherDevice = await device(id, sponsor);
  const channel = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [channel, id, `general-${channel}`],
  );
  const o: Org = {
    id,
    sponsor,
    outsider,
    agent,
    device: dev,
    otherDevice,
    project: await project(id, dev),
    otherProject: await project(id, otherDevice),
    channel,
    session: "",
  };
  o.session = await workSession(o, { startedBy: agent });
  return o;
}

/** A profile for `agent` on the org's device (defaults unless overridden), as `q` (the migrator by default). */
async function profile(
  o: Org,
  agent: string,
  cols: Record<string, unknown> = {},
  q: Q = db.query.bind(db) as Q,
): Promise<string> {
  const base: Record<string, unknown> = {
    organization_id: o.id,
    agent_id: agent,
    sponsor_user_id: o.sponsor,
    device_id: o.device,
    runtime: "claude-code",
    updated_by: o.sponsor,
    ...cols,
  };
  const names = Object.keys(base);
  const res = await q(
    `insert into app.bot_work_zone_profiles (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(base),
  );
  return res.rows[0].id as string;
}

function profileProject(
  o: Org,
  profileId: string,
  deviceId: string,
  projectId: string,
  q: Q = db.query.bind(db) as Q,
) {
  return q(
    "insert into app.bot_work_zone_profile_projects (organization_id, profile_id, device_id, project_id) values ($1, $2, $3, $4)",
    [o.id, profileId, deviceId, projectId],
  );
}

function consent(o: Org, agent: string, r: { revoked?: boolean } = {}, q: Q = db.query.bind(db) as Q) {
  return q(
    "insert into app.device_bot_consents (organization_id, device_id, agent_id, granted_by, revoked_at, revoked_by) values ($1, $2, $3, $4, $5, $6) returning id",
    [
      o.id,
      o.device,
      agent,
      o.sponsor,
      r.revoked ? new Date().toISOString() : null,
      r.revoked ? o.sponsor : null,
    ],
  );
}

function botSession(
  o: Org,
  sessionId: string,
  agent: string,
  profileId: string | null,
  q: Q = db.query.bind(db) as Q,
) {
  return q(
    `insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, profile_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
    [sessionId, o.id, agent, profileId, o.sponsor, o.channel, randomUUID(), randomUUID()],
  );
}

async function refused(p: Promise<unknown>, named: { constraint: string }): Promise<void> {
  await expect(p, named.constraint).rejects.toMatchObject(named);
}

const count = async (sql: string, values: unknown[]) =>
  (await db.query(`select count(*)::int as n from ${sql}`, values)).rows[0].n as number;

let A: Org;
let B: Org;

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  app = new pg.Client({ connectionString: tdb.appUrl });
  await db.connect();
  await app.connect();
  A = await seedOrg();
  B = await seedOrg();
});

afterAll(async () => {
  await db?.end();
  await app?.end();
  await tdb?.stop();
});

describe("bot Work Zone schema (07.16, D-01, D-03, D-06, D-15, D-16)", () => {
  it("a profile with defaults reads the PD-22 limits, worktree and enabled on, fast mode off, outside content off", async () => {
    const id = await profile(A, await bot(A.id, "defaults"));
    const row = (
      await db.query(
        `select max_concurrent, prompts_per_hour, wakes_per_session_day, act_on_outside_content, act_on_outside_content_by,
                worktree, enabled, fast_mode, default_mode, max_mode, allowed_models, allowed_efforts,
                allowed_context_windows, default_model
           from app.bot_work_zone_profiles where id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      max_concurrent: 2,
      prompts_per_hour: 30,
      wakes_per_session_day: 20,
      act_on_outside_content: false,
      act_on_outside_content_by: null,
      worktree: true,
      enabled: true,
      fast_mode: "off",
      default_mode: "default",
      max_mode: "default",
      allowed_models: [],
      allowed_efforts: [],
      allowed_context_windows: [],
      default_model: null,
    });
  });

  it("refuses every value outside the profile's ranges, each by its named check", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ max_concurrent: 0 }, "bot_work_zone_profiles_max_concurrent_ck"],
      [{ max_concurrent: 11 }, "bot_work_zone_profiles_max_concurrent_ck"],
      [{ prompts_per_hour: 0 }, "bot_work_zone_profiles_prompts_per_hour_ck"],
      [{ prompts_per_hour: 121 }, "bot_work_zone_profiles_prompts_per_hour_ck"],
      [{ wakes_per_session_day: -1 }, "bot_work_zone_profiles_wakes_per_session_day_ck"],
      [{ wakes_per_session_day: 101 }, "bot_work_zone_profiles_wakes_per_session_day_ck"],
      [{ runtime: "gemini" }, "bot_work_zone_profiles_runtime_ck"],
      [{ max_mode: "yolo" }, "bot_work_zone_profiles_max_mode_ck"],
      [{ default_mode: "dontAsk" }, "bot_work_zone_profiles_default_mode_ck"],
      [{ fast_mode: "sometimes" }, "bot_work_zone_profiles_fast_mode_ck"],
    ];
    for (const [cols, constraint] of cases) {
      await refused(profile(A, await bot(A.id, "bad"), cols), { constraint });
    }
    // The edges are accepted.
    await profile(A, await bot(A.id, "edges"), {
      max_concurrent: 10,
      prompts_per_hour: 120,
      wakes_per_session_day: 0,
      max_mode: "fullAccess",
      fast_mode: "on",
      runtime: "codex",
    });
  });

  it("refuses a second profile for the same bot", async () => {
    const agent = await bot(A.id, "twice");
    await profile(A, agent);
    await refused(profile(A, agent), { constraint: "bot_work_zone_profiles_agent_uq" });
  });

  it("pins profile projects to the profile's device (composite FKs)", async () => {
    const id = await profile(A, await bot(A.id, "pinned"));
    await profileProject(A, id, A.device, A.project);
    // A project of another device, named with the profile's device: no such project on that device.
    await refused(profileProject(A, id, A.device, A.otherProject), {
      constraint: "bot_work_zone_profile_projects_project_fk",
    });
    // The same project named with its own device: the profile is not on that device.
    await refused(profileProject(A, id, A.otherDevice, A.otherProject), {
      constraint: "bot_work_zone_profile_projects_profile_fk",
    });
    // A project removed from the device takes its profile row with it.
    const extra = await project(A.id, A.device);
    await profileProject(A, id, A.device, extra);
    await db.query("delete from app.projects where id = $1", [extra]);
    expect(await count("app.bot_work_zone_profile_projects where profile_id = $1", [id])).toBe(1);
  });

  it("allows one live consent per (device, bot); a revoked one may coexist with a new live one", async () => {
    const agent = await bot(A.id, "consented");
    const first = (await consent(A, agent)).rows[0].id as string;
    await refused(consent(A, agent), { constraint: "device_bot_consents_live_uq" });
    await db.query("update app.device_bot_consents set revoked_at = now(), revoked_by = $2 where id = $1", [
      first,
      A.sponsor,
    ]);
    await consent(A, agent);
    await consent(A, agent, { revoked: true });
    expect(await count("app.device_bot_consents where agent_id = $1", [agent])).toBe(3);
    const fresh = (
      await db.query(
        "select allow_full_access from app.device_bot_consents where agent_id = $1 and revoked_at is null",
        [agent],
      )
    ).rows;
    expect(fresh).toEqual([{ allow_full_access: false }]);
  });

  it("refuses a prompt with both an agent author and an agent proposer", async () => {
    const agent = await bot(A.id, "author");
    await refused(
      db.query(
        "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, author_agent_id, proposed_by_agent_id) values ($1, $2, $3, 'x', 9, $4, $4)",
        [A.id, A.session, A.sponsor, agent],
      ),
      { constraint: "work_prompts_agent_author_ck" },
    );
    const ok = await db.query(
      "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, author_agent_id, tainted) values ($1, $2, $3, 'x', 10, $4, true) returning tainted",
      [A.id, A.session, A.sponsor, agent],
    );
    expect(ok.rows).toEqual([{ tainted: true }]);
  });

  it("refuses an unknown host kind, an org cap above 1000 and a negative wake count", async () => {
    await refused(db.query("update app.devices set host_kind = 'laptop' where id = $1", [A.device]), {
      constraint: "devices_host_kind_ck",
    });
    await db.query("update app.devices set host_kind = 'service', isolated_server = true where id = $1", [
      A.otherDevice,
    ]);
    await refused(
      db.query("insert into app.work_zone_policies (organization_id, bot_sessions_max) values ($1, 1001)", [
        A.id,
      ]),
      { constraint: "work_zone_policies_bot_sessions_max_ck" },
    );
    await refused(
      db.query("insert into app.work_zone_policies (organization_id, bot_sessions_max) values ($1, -1)", [
        A.id,
      ]),
      { constraint: "work_zone_policies_bot_sessions_max_ck" },
    );
    const sid = await workSession(A);
    await refused(
      db.query(
        `insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id, wakes_used)
         values ($1, $2, $3, $4, $4, $5, $6, $7, -1)`,
        [sid, A.id, A.agent, A.sponsor, A.channel, randomUUID(), randomUUID()],
      ),
      { constraint: "bot_work_sessions_wakes_used_ck" },
    );
  });

  it("new columns read their defaults on rows written without them", async () => {
    const dev = (
      await db.query("select host_kind, isolated_server from app.devices where id = $1", [A.device])
    ).rows[0];
    expect(dev).toEqual({ host_kind: null, isolated_server: false });
    const sid = await workSession(A);
    expect(
      (await db.query("select started_by_agent_id, tainted_at from app.work_sessions where id = $1", [sid]))
        .rows,
    ).toEqual([{ started_by_agent_id: null, tainted_at: null }]);
    const p = await db.query(
      "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'x', 1) returning author_agent_id, tainted",
      [A.id, sid, A.sponsor],
    );
    expect(p.rows).toEqual([{ author_agent_id: null, tainted: false }]);
    await db.query(
      "insert into app.work_zone_policies (organization_id) values ($1) on conflict do nothing",
      [B.id],
    );
    expect(
      (
        await db.query("select bot_sessions_max from app.work_zone_policies where organization_id = $1", [
          B.id,
        ])
      ).rows,
    ).toEqual([{ bot_sessions_max: 10 }]);
    const event = randomUUID();
    await db.query(
      "insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id) values ($1, $2, $3, $4, $5, 'channel', $6)",
      [event, A.id, A.agent, A.sponsor, A.channel, randomUUID()],
    );
    expect(
      (await db.query("select session_output_read from app.agent_turns where event_id = $1", [event])).rows,
    ).toEqual([{ session_output_read: false }]);
    const proposal = await db.query(
      `insert into app.work_zone_proposals (organization_id, agent_id, requested_for_user_id, conversation_id, event_id, project_id, device_id, runtime, prompt, prompt_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, 'claude-code', 'Fix it', $8) returning tainted`,
      [A.id, A.agent, A.sponsor, A.channel, event, A.project, A.device, "c".repeat(64)],
    );
    expect(proposal.rows).toEqual([{ tainted: false }]);
  });

  it("deleting a bot unlinks its sessions and prompts (organization kept) and removes its profile, consents and bot sessions", async () => {
    const agent = await bot(A.id, "doomed");
    const sid = await workSession(A, { startedBy: agent });
    await db.query("update app.work_sessions set tainted_at = now() where id = $1", [sid]);
    const prompt = (
      await db.query(
        "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position, author_agent_id, tainted) values ($1, $2, $3, 'x', 1, $4, true) returning id",
        [A.id, sid, A.sponsor, agent],
      )
    ).rows[0].id as string;
    const profileId = await profile(A, agent);
    await profileProject(A, profileId, A.device, A.project);
    await consent(A, agent);
    await botSession(A, sid, agent, profileId);

    await db.query("delete from app.agents where id = $1", [agent]);

    expect(
      (
        await db.query(
          "select organization_id, started_by_agent_id, tainted_at is not null as tainted from app.work_sessions where id = $1",
          [sid],
        )
      ).rows,
    ).toEqual([{ organization_id: A.id, started_by_agent_id: null, tainted: true }]);
    expect(
      (
        await db.query(
          "select organization_id, author_agent_id, tainted from app.work_prompts where id = $1",
          [prompt],
        )
      ).rows,
    ).toEqual([{ organization_id: A.id, author_agent_id: null, tainted: true }]);
    expect(await count("app.bot_work_zone_profiles where agent_id = $1", [agent])).toBe(0);
    expect(await count("app.bot_work_zone_profile_projects where profile_id = $1", [profileId])).toBe(0);
    expect(await count("app.device_bot_consents where agent_id = $1", [agent])).toBe(0);
    expect(await count("app.bot_work_sessions where work_session_id = $1", [sid])).toBe(0);
  });

  it("deleting a profile keeps the bot session row and clears only its profile link", async () => {
    const agent = await bot(A.id, "kept");
    const sid = await workSession(A, { startedBy: agent });
    const profileId = await profile(A, agent);
    await botSession(A, sid, agent, profileId);
    await db.query("delete from app.bot_work_zone_profiles where id = $1", [profileId]);
    expect(
      (
        await db.query(
          "select organization_id, agent_id, profile_id from app.bot_work_sessions where work_session_id = $1",
          [sid],
        )
      ).rows,
    ).toEqual([{ organization_id: A.id, agent_id: agent, profile_id: null }]);
    // Deleting the session removes its bot side row.
    await db.query("delete from app.work_sessions where id = $1", [sid]);
    expect(await count("app.bot_work_sessions where work_session_id = $1", [sid])).toBe(0);
  });
});

/** Runs `fn` as ocw_app with withTenant()'s two settings (`null` user = a user-less system transaction); rolled back. */
async function as<T>(org: string, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  await app.query("begin");
  try {
    await app.query(
      "select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [org, userId ?? ""],
    );
    return await fn(app.query.bind(app) as Q);
  } finally {
    await app.query("rollback");
  }
}

/** The SQLSTATE of a statement that must fail, or null when it succeeded. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const NEW_TABLES = [
  "app.bot_work_zone_profiles",
  "app.bot_work_zone_profile_projects",
  "app.device_bot_consents",
  "app.bot_work_sessions",
] as const;

describe("bot Work Zone isolation as ocw_app (07.16, D-07, D-16)", () => {
  let profileA: string;

  beforeAll(async () => {
    profileA = await profile(A, A.agent);
    await profileProject(A, profileA, A.device, A.project);
    await consent(A, A.agent);
    await botSession(A, A.session, A.agent, profileA);
  });

  it("organization B reads, updates and deletes none of organization A's rows, and cannot insert one naming A", async () => {
    for (const tbl of NEW_TABLES) {
      expect(await count(`${tbl} where organization_id = $1`, [A.id]), `${tbl} seeded`).toBeGreaterThan(0);
      const own = await as(A.id, null, (q) => q(`select count(*)::int as n from ${tbl}`));
      expect(own.rows[0].n, `${tbl} own`).toBeGreaterThan(0);
      const cross = await as(B.id, null, (q) =>
        q(`select count(*)::int as n from ${tbl} where organization_id = $1`, [A.id]),
      );
      expect(cross.rows[0].n, `${tbl} cross-tenant select`).toBe(0);
      for (const stmt of [
        `update ${tbl} set organization_id = organization_id where organization_id = $1`,
        `delete from ${tbl} where organization_id = $1`,
      ]) {
        const r = await as(B.id, null, (q) => q(stmt, [A.id]));
        expect(r.rowCount, `${tbl}: ${stmt}`).toBe(0);
      }
    }
    // Inserts naming organization A from B's transaction.
    const agent = await bot(A.id, "intruder");
    const sid = await workSession(A, { startedBy: agent });
    const inserts: Array<[string, (q: Q) => Promise<unknown>]> = [
      ["app.bot_work_zone_profiles", (q) => profile(A, agent, {}, q)],
      ["app.bot_work_zone_profile_projects", (q) => profileProject(A, profileA, A.device, A.otherProject, q)],
      ["app.device_bot_consents", (q) => consent(A, agent, {}, q)],
      ["app.bot_work_sessions", (q) => botSession(A, sid, agent, null, q)],
    ];
    for (const [tbl, insert] of inserts) {
      await expect(as(B.id, null, insert), `${tbl} cross-tenant insert`).rejects.toThrow(
        /row-level security/,
      );
    }
  });

  it("a bot session follows its session's audience: an outsider sees none, the creator and a system transaction see it", async () => {
    const read = (userId: string | null) =>
      as(
        A.id,
        userId,
        async (q) =>
          (
            await q("select count(*)::int as n from app.bot_work_sessions where work_session_id = $1", [
              A.session,
            ])
          ).rows[0].n as number,
      );
    expect(await read(A.outsider)).toBe(0);
    expect(await read(A.sponsor)).toBe(1);
    expect(await read(null)).toBe(1);
    // The outsider cannot change it or write one for the session either.
    const changed = await as(A.id, A.outsider, (q) =>
      q("update app.bot_work_sessions set wake_pending = true where work_session_id = $1", [A.session]),
    );
    expect(changed.rowCount).toBe(0);
    const sid = await workSession(A, { startedBy: A.agent });
    expect(await errorCode(() => as(A.id, A.outsider, (q) => botSession(A, sid, A.agent, profileA, q)))).toBe(
      "42501",
    );
    // The session's creator may.
    expect(
      await errorCode(() => as(A.id, A.sponsor, (q) => botSession(A, sid, A.agent, profileA, q))),
    ).toBeNull();
  });

  it("the app role cannot TRUNCATE the four tables (TRUNCATE ignores RLS)", async () => {
    for (const tbl of NEW_TABLES) {
      expect(await errorCode(() => as(A.id, null, (q) => q(`truncate ${tbl}`))), tbl).toBe("42501");
    }
    for (const tbl of NEW_TABLES) {
      expect(await count(`${tbl} where organization_id = $1`, [A.id]), `${tbl} kept`).toBeGreaterThan(0);
    }
  });
});
