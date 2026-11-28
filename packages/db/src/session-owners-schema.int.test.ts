import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.13.1.1 (D-07, D-08, PD-11, PD-16; ADR-0047): the storage of session naming rules and the per-turn rename
 * claim. `work_zone_policies.session_naming_rule` (the organization's rule) and `work_project_settings.naming_rule` (a
 * project's rule) are nullable text of at most 600 characters; `work_prompts.title_renamed_at` is set once when the
 * turn's agent renamed its session. A fresh database with every migration and post-migrate applied; rows written the
 * 07.13 way (no new column named) still insert (N-1).
 */

let tdb: TestDatabase;
let db: pg.Client;

const ORG = randomUUID();
const USER = randomUUID();
const UNIT = randomUUID();
const DEVICE = randomUUID();
const REPO = randomUUID();
const SESSION = randomUUID();

async function refused(p: Promise<unknown>, constraint: string): Promise<void> {
  await expect(p, constraint).rejects.toMatchObject({ constraint });
}

async function column(table: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await db.query(
    `select data_type, is_nullable, column_default from information_schema.columns
     where table_schema = 'app' and table_name = $1 and column_name = $2`,
    [table, name],
  );
  return r.rows[0];
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = new pg.Client({ connectionString: tdb.migratorUrl });
  await db.connect();
  await db.query("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [ORG, `o-${ORG}`]);
  await db.query("insert into auth.user (id, name, email) values ($1, 'P', $2)", [USER, `${USER}@so.test`]);
  await db.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'P', 'admin')",
    [ORG, USER],
  );
  await db.query(
    "insert into app.org_units (id, organization_id, parent_id, kind, name, path) values ($1, $2, null, 'project', 'Billing', $3::uuid[])",
    [UNIT, ORG, [UNIT]],
  );
  await db.query(
    "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'srv', 'linux', $4)",
    [DEVICE, ORG, USER, `tok-${DEVICE}`],
  );
  await db.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, 'repo')",
    [REPO, ORG, DEVICE, `l-${REPO}`],
  );
  const conversation = randomUUID();
  await db.query(
    "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'ws')",
    [conversation, ORG],
  );
  await db.query(
    "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by) values ($1, $2, $3, $4, $5, 'T', $6)",
    [SESSION, ORG, conversation, REPO, DEVICE, USER],
  );
});

afterAll(async () => {
  await db?.end();
  await tdb?.stop();
});

describe("the three columns (07.13.1.1 D-07, D-08, PD-11, PD-16)", () => {
  it("are nullable with no default", async () => {
    expect(await column("work_zone_policies", "session_naming_rule")).toEqual({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
    expect(await column("work_project_settings", "naming_rule")).toEqual({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
    expect(await column("work_prompts", "title_renamed_at")).toEqual({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("rows written the 07.13 way insert and read null (N-1)", async () => {
    await db.query("insert into app.work_zone_policies (organization_id) values ($1)", [ORG]);
    await db.query(
      "insert into app.work_project_settings (organization_id, unit_id, default_visibility, updated_by) values ($1, $2, 'owner', $3)",
      [ORG, UNIT, USER],
    );
    const prompt = await db.query(
      "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'hello', 1) returning id, title_renamed_at",
      [ORG, SESSION, USER],
    );
    expect(prompt.rows[0].title_renamed_at).toBeNull();
    const policy = await db.query(
      "select session_naming_rule from app.work_zone_policies where organization_id = $1",
      [ORG],
    );
    expect(policy.rows).toEqual([{ session_naming_rule: null }]);
    const settings = await db.query("select naming_rule from app.work_project_settings where unit_id = $1", [
      UNIT,
    ]);
    expect(settings.rows).toEqual([{ naming_rule: null }]);
  });

  it("stores a 600-character rule and refuses 601 by the named checks", async () => {
    const ok = "a".repeat(600);
    const tooLong = "a".repeat(601);
    await db.query("update app.work_zone_policies set session_naming_rule = $2 where organization_id = $1", [
      ORG,
      ok,
    ]);
    await db.query("update app.work_project_settings set naming_rule = $2 where unit_id = $1", [UNIT, ok]);
    const stored = await db.query(
      `select (select char_length(session_naming_rule) from app.work_zone_policies where organization_id = $1) as org,
              (select char_length(naming_rule) from app.work_project_settings where unit_id = $2) as project`,
      [ORG, UNIT],
    );
    expect(stored.rows).toEqual([{ org: 600, project: 600 }]);
    await refused(
      db.query("update app.work_zone_policies set session_naming_rule = $2 where organization_id = $1", [
        ORG,
        tooLong,
      ]),
      "work_zone_policies_session_naming_rule_ck",
    );
    await refused(
      db.query("update app.work_project_settings set naming_rule = $2 where unit_id = $1", [UNIT, tooLong]),
      "work_project_settings_naming_rule_ck",
    );
    // Characters, not bytes: 600 multi-byte characters fit.
    await db.query("update app.work_project_settings set naming_rule = $2 where unit_id = $1", [
      UNIT,
      "é".repeat(600),
    ]);
  });

  it("a prompt's title_renamed_at takes null and a timestamp; a conditional claim succeeds once", async () => {
    const prompt = await db.query(
      "insert into app.work_prompts (organization_id, work_session_id, author_user_id, body, position) values ($1, $2, $3, 'again', 2) returning id",
      [ORG, SESSION, USER],
    );
    const id = prompt.rows[0].id as string;
    const claim = () =>
      db.query(
        "update app.work_prompts set title_renamed_at = now() where id = $1 and title_renamed_at is null",
        [id],
      );
    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);
    const at = await db.query(
      "select title_renamed_at is not null as set from app.work_prompts where id = $1",
      [id],
    );
    expect(at.rows).toEqual([{ set: true }]);
    await db.query("update app.work_prompts set title_renamed_at = null where id = $1", [id]);
  });
});
