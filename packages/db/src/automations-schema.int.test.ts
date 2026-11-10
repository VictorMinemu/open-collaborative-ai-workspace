import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * Phase 07.6 (D-07, P-04, P-06, P-10, P-16, Pitfall 6): the rules of automations are structural. As the app role in
 * one organization, the shapes a bug in the API must never store are refused through NAMED constraints (asserted on
 * the error's `constraint`), runs and inbound items are unique per instant / item, watched-record history is
 * append-only and still goes with its record, and the six SECURITY DEFINER functions the job ticks and the public
 * webhook route use return ids only, across organizations, to `ocw_app` alone. Tenant isolation of the same tables is
 * proven in rls-isolation.int.test.ts.
 */

let tdb: TestDatabase;
let migrator: pg.Client;
let app: pg.Client;

interface Org {
  id: string;
  ana: string;
  ben: string;
  agent: string;
  channel: string;
  msg: string;
  board: string;
  column: string;
  card: string;
  mcp: string;
  vault: string;
  secret: string;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
let publicIds = 0;
/** 26 Crockford base32 characters (digits only), unique per call. */
const nextPublicId = () => String(++publicIds).padStart(26, "0");

async function seedOrg(): Promise<Org> {
  const o: Org = {
    id: randomUUID(),
    ana: randomUUID(),
    ben: randomUUID(),
    agent: randomUUID(),
    channel: randomUUID(),
    msg: randomUUID(),
    board: randomUUID(),
    column: randomUUID(),
    card: randomUUID(),
    mcp: randomUUID(),
    vault: randomUUID(),
    secret: randomUUID(),
  };
  const q = (text: string, values: unknown[]) => migrator.query(text, values);
  await q("insert into auth.organization (id, name, slug) values ($1, 'O', $2)", [o.id, `o-${o.id}`]);
  await q(
    "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Bot', $3, 'x', 'mock', 'mock-1')",
    [o.agent, o.id, `bot-${o.agent.slice(0, 8)}`],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug) values ($1, $2, 'channel', 'general', $3)",
    [o.channel, o.id, `general-${o.channel}`],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'hi')",
    [o.msg, o.id, o.channel, o.ana],
  );
  await q(
    "insert into app.conversations (id, organization_id, kind, name, slug, layout) values ($1, $2, 'channel', 'orders', $3, 'board')",
    [o.board, o.id, `orders-${o.board}`],
  );
  await q("insert into app.boards (conversation_id, organization_id) values ($1, $2)", [o.board, o.id]);
  await q(
    "insert into app.board_columns (id, organization_id, conversation_id, name, rank, category) values ($1, $2, $3, 'Backlog', 'a0', 'backlog')",
    [o.column, o.id, o.board],
  );
  await q(
    "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 1, 'user', $4, 'SO-1001')",
    [o.card, o.id, o.board, o.ana],
  );
  await q(
    "insert into app.board_cards (message_id, organization_id, conversation_id, column_id, rank, title) values ($1, $2, $3, $4, 'a0', 'SO-1001')",
    [o.card, o.id, o.board, o.column],
  );
  await q(
    "insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url) values ($1, $2, 'ERP', $3, 'streamable-http', 'https://erp.example.test/mcp')",
    [o.mcp, o.id, `m${o.mcp.replace(/-/g, "").slice(0, 8)}`],
  );
  await q(
    "insert into app.secrets (id, organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'hook', 'webhook_secret', 'c', 'i', 't')",
    [o.secret, o.id],
  );
  await q(
    `insert into app.vault_items (id, organization_id, scope, name, handle, kind, injection, allowed_hosts, secret_ref) values ($1, $2, 'unit', 'Mail', $3, 'basic', '{"header":"Authorization","scheme":"basic"}', '{imap.example.test}', '{"provider":"env","name":"MAIL"}')`,
    [o.vault, o.id, "k_mailboxkey"],
  );
  return o;
}

/** Runs `fn` as ocw_app in `org`'s tenant transaction, always rolled back. */
async function asApp<T>(
  org: string,
  fn: (q: (text: string, values?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
) {
  await app.query("begin");
  try {
    await app.query("select set_config('app.organization_id', $1, true)", [org]);
    return await fn((text, values) => app.query(text, values));
  } finally {
    await app.query("rollback");
  }
}

type Q = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

/** Inserts a scheduled channel automation (overridable) and returns its id. */
async function automation(q: Q, o: Org, cols: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    organization_id: o.id,
    name: "Weekly report",
    agent_id: o.agent,
    run_as_user_id: o.ana,
    created_by: o.ana,
    trigger_kind: "schedule",
    schedule_cron: "0 17 * * 5",
    time_zone: "Europe/Madrid",
    target_kind: "channel",
    conversation_id: o.channel,
    ...cols,
  };
  const keys = Object.keys(row);
  await q(
    `insert into app.automations (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((k) => row[k]),
  );
  return row.id as string;
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

describe("automations schema (07.6-02)", () => {
  it("an automation runs only as its creator, with a complete schedule and a well-formed target (D-07, P-04)", async () => {
    await expect(asApp(A.id, (q) => automation(q, A, { run_as_user_id: A.ben }))).rejects.toMatchObject({
      constraint: "automations_run_as_creator_check",
    });
    await expect(asApp(A.id, (q) => automation(q, A, { time_zone: null }))).rejects.toMatchObject({
      constraint: "automations_schedule_check",
    });
    await expect(
      asApp(A.id, (q) => automation(q, A, { target_kind: "board", conversation_id: A.board })),
    ).rejects.toMatchObject({ constraint: "automations_target_check" });
    await expect(
      asApp(A.id, (q) => automation(q, A, { target_kind: "thread", conversation_id: A.channel })),
    ).rejects.toMatchObject({ constraint: "automations_target_check" });
    await expect(
      asApp(A.id, (q) => automation(q, A, { target_kind: "dm", conversation_id: A.channel })),
    ).rejects.toMatchObject({ constraint: "automations_target_check" });
    // A webhook automation needs an inbound action; a schedule has none; a board card needs a board target.
    await expect(
      asApp(A.id, (q) => automation(q, A, { trigger_kind: "webhook", schedule_cron: null, time_zone: null })),
    ).rejects.toMatchObject({ constraint: "automations_inbound_check" });
    await expect(asApp(A.id, (q) => automation(q, A, { inbound_action: "post" }))).rejects.toMatchObject({
      constraint: "automations_inbound_check",
    });
    await expect(
      asApp(A.id, (q) =>
        automation(q, A, {
          trigger_kind: "mail",
          schedule_cron: null,
          time_zone: null,
          inbound_action: "board_card",
        }),
      ),
    ).rejects.toMatchObject({ constraint: "automations_inbound_check" });
    await expect(asApp(A.id, (q) => automation(q, A, { max_runs_per_day: 289 }))).rejects.toMatchObject({
      constraint: "automations_max_runs_per_day_check",
    });
    await expect(asApp(A.id, (q) => automation(q, A, { name: "" }))).rejects.toMatchObject({
      constraint: "automations_name_len_check",
    });
    await expect(
      asApp(A.id, (q) => automation(q, A, { instructions: "x".repeat(4001) })),
    ).rejects.toMatchObject({
      constraint: "automations_instructions_len_check",
    });
    // The thread root is a message of the target conversation; the column a column of the target board.
    await expect(
      asApp(A.id, (q) =>
        automation(q, A, { target_kind: "thread", conversation_id: A.board, thread_root_message_id: A.msg }),
      ),
    ).rejects.toMatchObject({ constraint: "automations_thread_root_fk" });
    await expect(
      asApp(A.id, (q) =>
        automation(q, A, { target_kind: "board", conversation_id: A.channel, board_column_id: A.column }),
      ),
    ).rejects.toMatchObject({ constraint: "automations_board_column_fk" });
    // Another organization's bot is not a parent here (the key carries the organization).
    await expect(asApp(A.id, (q) => automation(q, A, { agent_id: B.agent }))).rejects.toMatchObject({
      constraint: "automations_agent_fk",
    });
    // Every valid shape stores.
    const ok = await asApp(A.id, async (q) => [
      await automation(q, A),
      await automation(q, A, { target_kind: "thread", thread_root_message_id: A.msg }),
      await automation(q, A, { target_kind: "dm", conversation_id: null }),
      await automation(q, A, {
        trigger_kind: "webhook",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "board_card",
        target_kind: "board",
        conversation_id: A.board,
        board_column_id: A.column,
      }),
      await automation(q, A, {
        trigger_kind: "mail",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "post",
      }),
    ]);
    expect(ok).toHaveLength(5);
  });

  it("one digest per person, scheduled to their DM (D-05)", async () => {
    const digest = { action_kind: "digest", target_kind: "dm", conversation_id: null };
    await expect(
      asApp(A.id, async (q) => {
        await automation(q, A, digest);
        await automation(q, A, digest);
      }),
    ).rejects.toMatchObject({ constraint: "automations_digest_uq" });
    // Two people each have theirs.
    await asApp(A.id, async (q) => {
      await automation(q, A, digest);
      await automation(q, A, { ...digest, run_as_user_id: A.ben, created_by: A.ben });
    });
    await expect(
      asApp(A.id, (q) =>
        automation(q, A, {
          ...digest,
          trigger_kind: "webhook",
          schedule_cron: null,
          time_zone: null,
          inbound_action: "post",
        }),
      ),
    ).rejects.toMatchObject({ constraint: "automations_digest_check" });
    await expect(asApp(A.id, (q) => automation(q, A, { action_kind: "digest" }))).rejects.toMatchObject({
      constraint: "automations_digest_check",
    });
  });

  it("a run is unique per scheduled instant and per inbound item (Pitfall 6)", async () => {
    await asApp(A.id, async (q) => {
      const a = await automation(q, A);
      const at = "2026-10-30T16:00:00Z";
      const run = (cols: string, vals: unknown[]) =>
        q(
          `insert into app.automation_runs (organization_id, automation_id, ${cols}) values ($1, $2, ${vals.map((_, i) => `$${i + 3}`).join(", ")})`,
          [A.id, a, ...vals],
        );
      await run("trigger, scheduled_for", ["schedule", at]);
      await q("savepoint s");
      await expect(run("trigger, scheduled_for", ["schedule", at])).rejects.toMatchObject({
        constraint: "automation_runs_scheduled_uq",
      });
      await q("rollback to savepoint s");
      // Manual runs have no instant: any number of them.
      await run("trigger", ["manual"]);
      await run("trigger", ["manual"]);
      await q("savepoint s");
      await expect(run("trigger", ["schedule"])).rejects.toMatchObject({
        constraint: "automation_runs_scheduled_check",
      });
      await q("rollback to savepoint s");
      const n = await q("select count(*)::int as n from app.automation_runs where automation_id = $1", [a]);
      expect(n.rows[0].n).toBe(3);
    });
    await asApp(A.id, async (q) => {
      const a = await automation(q, A, {
        trigger_kind: "webhook",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "post",
      });
      const endpoint = randomUUID();
      await q(
        "insert into app.webhook_endpoints (id, organization_id, automation_id, public_id, secret_id) values ($1, $2, $3, $4, $5)",
        [endpoint, A.id, a, nextPublicId(), A.secret],
      );
      const event = randomUUID();
      await q(
        "insert into app.automation_events (id, organization_id, source, webhook_endpoint_id, external_id, result) values ($1, $2, 'webhook', $3, 'msg_1', 'accepted')",
        [event, A.id, endpoint],
      );
      const run = () =>
        q(
          "insert into app.automation_runs (organization_id, automation_id, trigger, inbound_event_id, tainted) values ($1, $2, 'webhook', $3, true)",
          [A.id, a, event],
        );
      await run();
      await expect(run()).rejects.toMatchObject({ constraint: "automation_runs_inbound_uq" });
    });
  });

  it("an inbound item is unique per endpoint and per mailbox, has exactly one source and capped content (D-07, Pitfall 3)", async () => {
    await asApp(A.id, async (q) => {
      const hook = await automation(q, A, {
        trigger_kind: "webhook",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "post",
      });
      const mail = await automation(q, A, {
        trigger_kind: "mail",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "post",
      });
      const e1 = randomUUID();
      const e2 = randomUUID();
      for (const e of [e1, e2])
        await q(
          "insert into app.webhook_endpoints (id, organization_id, automation_id, public_id, secret_id) values ($1, $2, $3, $4, $5)",
          [e, A.id, e === e1 ? hook : null, nextPublicId(), A.secret],
        );
      const box = randomUUID();
      await q(
        "insert into app.mailboxes (id, organization_id, automation_id, owner_user_id, vault_item_id, host) values ($1, $2, $3, $4, $5, 'imap.example.test')",
        [box, A.id, mail, A.ana, A.vault],
      );
      const hookEvent = (endpoint: string, external: string) =>
        q(
          "insert into app.automation_events (organization_id, source, webhook_endpoint_id, external_id, result) values ($1, 'webhook', $2, $3, 'accepted')",
          [A.id, endpoint, external],
        );
      const mailEvent = (external: string) =>
        q(
          "insert into app.automation_events (organization_id, source, mailbox_id, external_id, subject, sender, body_text, result) values ($1, 'mail', $2, $3, 'Broken pump', 'ana@example.test', 'The pump is broken', 'accepted')",
          [A.id, box, external],
        );
      await hookEvent(e1, "msg_1");
      await hookEvent(e2, "msg_1"); // the same webhook-id on another endpoint is another item
      await mailEvent("<m1@example.test>");
      const refused = async (stmt: () => Promise<unknown>, constraint: string) => {
        await q("savepoint s");
        await expect(stmt()).rejects.toMatchObject({ constraint });
        await q("rollback to savepoint s");
      };
      await refused(() => hookEvent(e1, "msg_1"), "automation_events_webhook_external_uq");
      await refused(() => mailEvent("<m1@example.test>"), "automation_events_mailbox_external_uq");
      await refused(
        () =>
          q(
            "insert into app.automation_events (organization_id, source, webhook_endpoint_id, mailbox_id, external_id, result) values ($1, 'webhook', $2, $3, 'msg_9', 'accepted')",
            [A.id, e1, box],
          ),
        "automation_events_source_check",
      );
      await refused(
        () =>
          q(
            "insert into app.automation_events (organization_id, source, webhook_endpoint_id, external_id, result) values ($1, 'mail', $2, 'msg_8', 'accepted')",
            [A.id, e1],
          ),
        "automation_events_source_check",
      );
      await refused(
        () =>
          q(
            "insert into app.automation_events (organization_id, source, mailbox_id, external_id, body_text, result) values ($1, 'mail', $2, '<m2@example.test>', $3, 'accepted')",
            [A.id, box, "x".repeat(32_769)],
          ),
        "automation_events_body_text_len_check",
      );
      // Retention clears the content: a purged item keeps no subject, sender or body.
      await refused(
        () =>
          q(
            "update app.automation_events set content_purged_at = now() where mailbox_id = $1 and external_id = '<m1@example.test>'",
            [box],
          ),
        "automation_events_purged_check",
      );
      const purged = await q(
        "update app.automation_events set content_purged_at = now(), subject = null, sender = null, body_text = null, body_json = null where mailbox_id = $1",
        [box],
      );
      expect(purged.rowCount).toBe(1);
      // Endpoint public ids are global (the public route finds the organization by them) and well formed.
      await refused(
        () =>
          q("insert into app.webhook_endpoints (organization_id, public_id) values ($1, $2)", [
            A.id,
            "not-a-public-id",
          ]),
        "webhook_endpoints_public_id_check",
      );
    });
  });

  it("usage rows of the new kinds carry a subject and no generation; chat and title rows are unchanged (P-16)", async () => {
    const usage = (cols: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        organization_id: A.id,
        requester_user_id: A.ana,
        backend: "org_key",
        provider: "mock",
        model_id: "mock-1",
        input_tokens: 1,
        output_tokens: 1,
        ...cols,
      };
      const keys = Object.keys(row);
      return (q: Q) =>
        q(
          `insert into app.ai_usage_records (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
          keys.map((k) => row[k]),
        );
    };
    await expect(asApp(A.id, usage({ kind: "digest" }))).rejects.toMatchObject({
      constraint: "ai_usage_records_kind_check",
    });
    await expect(
      asApp(A.id, usage({ kind: "session_summary", subject_id: randomUUID(), generation_id: randomUUID() })),
    ).rejects.toMatchObject({ constraint: "ai_usage_records_kind_check" });
    await expect(asApp(A.id, usage({ kind: "chat", conversation_id: A.channel }))).rejects.toMatchObject({
      constraint: "ai_usage_records_kind_check",
    });
    await expect(asApp(A.id, usage({ kind: "title", generation_id: randomUUID() }))).rejects.toMatchObject({
      constraint: "ai_usage_records_kind_check",
    });
    await expect(asApp(A.id, usage({ kind: "poll", subject_id: randomUUID() }))).rejects.toMatchObject({
      constraint: "ai_usage_records_kind_check",
    });
    const subject = randomUUID();
    await asApp(A.id, async (q) => {
      await usage({ kind: "digest", subject_id: subject })(q);
      await usage({ kind: "session_summary", subject_id: subject })(q);
      await usage({ kind: "chat", generation_id: randomUUID(), conversation_id: A.channel })(q);
      await usage({ kind: "title", generation_id: randomUUID(), conversation_id: A.channel })(q);
      await expect(usage({ kind: "digest", subject_id: subject })(q)).rejects.toMatchObject({
        constraint: "ai_usage_records_subject_kind_uq",
      });
    });
  });

  it("card labels and the automation caps are bounded (R1, Pitfall 1)", async () => {
    const card = randomUUID();
    await migrator.query(
      "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 2, 'agent', $4, 'Run')",
      [card, A.id, A.channel, A.agent],
    );
    await migrator.query(
      "insert into app.message_cards (message_id, organization_id, conversation_id, agent_id, kind, title, status, platform_owned) values ($1, $2, $3, $4, 'automation', 'Weekly report', 'info', true)",
      [card, A.id, A.channel, A.agent],
    );
    const set = (col: string, v: unknown) =>
      asApp(A.id, (q) => q(`update app.message_cards set ${col} = $2 where message_id = $1`, [card, v]));
    await expect(set("status_label", "x".repeat(25))).rejects.toMatchObject({
      constraint: "message_cards_status_label_len_check",
    });
    await expect(set("notices", JSON.stringify([1, 2, 3, 4]))).rejects.toMatchObject({
      constraint: "message_cards_notices_check",
    });
    await set("status_label", "Received");
    const defaults = await migrator.query(
      "insert into app.bot_policies (organization_id) values ($1) returning max_automations_per_user, min_schedule_minutes, max_inbound_per_hour, max_runs_per_day_cap",
      [A.id],
    );
    expect(defaults.rows[0]).toEqual({
      max_automations_per_user: 10,
      min_schedule_minutes: 5,
      max_inbound_per_hour: 30,
      max_runs_per_day_cap: 288,
    });
    await expect(
      asApp(A.id, (q) =>
        q("update app.bot_policies set max_runs_per_day_cap = 0 where organization_id = $1", [A.id]),
      ),
    ).rejects.toMatchObject({ constraint: "bot_policies_max_runs_per_day_cap_check" });
  });

  it("watched-record history is append-only for the app role and still goes with its record (D-04)", async () => {
    const watched = randomUUID();
    await migrator.query(
      `insert into app.watched_records (id, organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, check_as_user_id, created_by) values ($1, $2, $3, $4, $5, $6, 'SO-1001', 'get_order', 'id', '[]', $7, $7)`,
      [watched, A.id, A.card, A.board, A.agent, A.mcp, A.ana],
    );
    await asApp(A.id, (q) =>
      q(
        "insert into app.watched_record_changes (organization_id, watched_record_id, source, before, after, before_hash, after_hash) values ($1, $2, 'schedule', '{}', '{}', $3, $4)",
        [A.id, watched, HASH_A, HASH_B],
      ),
    );
    await migrator.query(
      "insert into app.watched_record_changes (organization_id, watched_record_id, source, after, after_hash) values ($1, $2, 'access', '{}', $3)",
      [A.id, watched, HASH_B],
    );
    for (const stmt of [
      "update app.watched_record_changes set after_hash = after_hash",
      "delete from app.watched_record_changes",
      "truncate app.watched_record_changes",
    ])
      await expect(
        asApp(A.id, (q) => q(stmt)),
        stmt,
      ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(A.id, (q) =>
        q(
          "insert into app.watched_record_changes (organization_id, watched_record_id, source, after, after_hash) values ($1, $2, 'access', '{}', 'nothex')",
          [A.id, watched],
        ),
      ),
    ).rejects.toMatchObject({ constraint: "watched_record_changes_after_hash_check" });
    // One watch per card; the card must be on the record's board.
    await expect(
      asApp(A.id, (q) =>
        q(
          `insert into app.watched_records (organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, check_as_user_id, created_by) values ($1, $2, $3, $4, $5, 'SO-1002', 'get_order', 'id', '[]', $6, $6)`,
          [A.id, A.card, A.board, A.agent, A.mcp, A.ana],
        ),
      ),
    ).rejects.toMatchObject({ constraint: "watched_records_card_uq" });
    await expect(
      asApp(A.id, (q) =>
        q(
          `insert into app.watched_records (organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, check_as_user_id, created_by, check_interval_minutes) values ($1, $2, $3, $4, $5, 'SO-1002', 'get_order', 'id', '[]', $6, $6, 7)`,
          [A.id, A.msg, A.board, A.agent, A.mcp, A.ana],
        ),
      ),
    ).rejects.toMatchObject({ constraint: "watched_records_interval_check" });
    // Deleting the watched record as the app role takes its history with it (FK cascades ignore the grant).
    const removed = await app.query("begin").then(async () => {
      try {
        await app.query("select set_config('app.organization_id', $1, true)", [A.id]);
        await app.query("delete from app.watched_records where id = $1", [watched]);
        await app.query("commit");
      } catch (err) {
        await app.query("rollback");
        throw err;
      }
      return (
        await migrator.query(
          "select count(*)::int as n from app.watched_record_changes where watched_record_id = $1",
          [watched],
        )
      ).rows[0].n;
    });
    expect(removed).toBe(0);
  });

  it("deletes keep or remove 07.6 rows as decided: a targeted column stays, a board or bot takes its automations", async () => {
    const column = randomUUID();
    await migrator.query(
      "insert into app.board_columns (id, organization_id, conversation_id, name, rank, category) values ($1, $2, $3, 'Done', 'a1', 'done')",
      [column, A.id, A.board],
    );
    const a = await automation(migratorQ, A, {
      trigger_kind: "webhook",
      schedule_cron: null,
      time_zone: null,
      inbound_action: "board_card",
      target_kind: "board",
      conversation_id: A.board,
      board_column_id: column,
    });
    const endpoint = randomUUID();
    await migrator.query(
      "insert into app.webhook_endpoints (id, organization_id, automation_id, public_id, secret_id) values ($1, $2, $3, $4, $5)",
      [endpoint, A.id, a, nextPublicId(), A.secret],
    );
    // A column an automation files cards into is not deleted under it (the API answers before).
    await expect(
      asApp(A.id, (q) => q("delete from app.board_columns where id = $1", [column])),
    ).rejects.toMatchObject({ constraint: "automations_board_column_fk" });
    // Deleting the automation keeps its endpoint, unlinked (the route answers 410 from it), with its organization.
    await migrator.query("delete from app.automations where id = $1", [a]);
    const ep = await migrator.query(
      "select automation_id, organization_id from app.webhook_endpoints where id = $1",
      [endpoint],
    );
    expect(ep.rows[0]).toEqual({ automation_id: null, organization_id: A.id });
    // A whole board conversation takes its automations (and the column NO ACTION check sees them gone).
    const b = await automation(migratorQ, B, {
      target_kind: "board",
      conversation_id: B.board,
      board_column_id: B.column,
    });
    const w = randomUUID();
    await migrator.query(
      `insert into app.watched_records (id, organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, check_as_user_id, created_by) values ($1, $2, $3, $4, $5, $6, 'SO-1', 'get_order', 'id', '[]', $7, $7)`,
      [w, B.id, B.card, B.board, B.agent, B.mcp, B.ana],
    );
    await migrator.query("delete from app.conversations where id = $1", [B.board]);
    const left = await migrator.query(
      "select (select count(*)::int from app.automations where id = $1) as automations, (select count(*)::int from app.watched_records where id = $2) as watched",
      [b, w],
    );
    expect(left.rows[0]).toEqual({ automations: 0, watched: 0 });
    // A deleted bot takes its automations.
    const bot = randomUUID();
    await migrator.query(
      "insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id) values ($1, $2, 'Gone', $3, 'x', 'mock', 'mock-1')",
      [bot, A.id, `gone-${bot.slice(0, 8)}`],
    );
    const c = await automation(migratorQ, A, { agent_id: bot });
    await migrator.query("delete from app.agents where id = $1", [bot]);
    const gone = await migrator.query("select count(*)::int as n from app.automations where id = $1", [c]);
    expect(gone.rows[0].n).toBe(0);
  });
});

describe("ids-only SECURITY DEFINER functions (07.6-02, D-07, P-10)", () => {
  const FUNCTIONS = [
    "app.due_automations(integer, timestamptz)",
    "app.stale_automation_runs(integer, timestamptz)",
    "app.due_mailboxes(integer, timestamptz)",
    "app.due_watched_records(integer, timestamptz)",
    "app.lookup_webhook_endpoint(text)",
    "app.expired_automation_events(integer, timestamptz)",
  ] as const;

  let C: Org;
  let D: Org;
  const now = new Date("2026-10-30T12:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  beforeAll(async () => {
    C = await seedOrg();
    D = await seedOrg();
  });

  /** Calls a function as ocw_app with no tenant context at all (the job ticks and the public route run so). */
  const call = async (fn: string, args: unknown[]) => {
    const r = await app.query(`select * from ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
    return { fields: r.fields.map((f) => f.name), rows: r.rows };
  };

  it("each one is SECURITY DEFINER with a fixed search_path, executable by ocw_app and by no one else", async () => {
    const other = new pg.Client({ connectionString: tdb.authUrl });
    await other.connect();
    try {
      for (const fn of FUNCTIONS) {
        const meta = await migrator.query(
          `select p.prosecdef, p.proconfig, has_function_privilege('ocw_app', p.oid, 'execute') as app,
                  has_function_privilege('ocw_auth', p.oid, 'execute') as auth,
                  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           where a.grantee = 0) as public
             from pg_proc p where p.oid = $1::regprocedure`,
          [fn],
        );
        expect(meta.rows[0], fn).toEqual({
          prosecdef: true,
          proconfig: ["search_path=pg_catalog, pg_temp"],
          app: true,
          auth: false,
          public: false,
        });
        const args = fn.endsWith("(text)") ? ["x"] : [1, now.toISOString()];
        await expect(
          other.query(
            `select * from ${fn.replace(/\(.*\)$/, "")}(${args.map((_, i) => `$${i + 1}`).join(", ")})`,
            args,
          ),
          fn,
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await other.end();
    }
  });

  it("due_automations: active scheduled rows due by now, across organizations, oldest first, ids only, limit clamped", async () => {
    const due1 = await automation(migratorQ, C, { next_run_at: ago(120) });
    const due2 = await automation(migratorQ, D, { next_run_at: ago(60) });
    const exact = await automation(migratorQ, C, { next_run_at: now.toISOString() });
    const paused = await automation(migratorQ, C, { next_run_at: ago(90), status: "paused" });
    const attention = await automation(migratorQ, D, { next_run_at: ago(90), status: "needs_attention" });
    const hook = await automation(migratorQ, C, {
      next_run_at: ago(90),
      trigger_kind: "webhook",
      schedule_cron: null,
      time_zone: null,
      inbound_action: "post",
    });
    const future = await automation(migratorQ, D, { next_run_at: ago(-5) });
    const unscheduled = await automation(migratorQ, D);
    const mine = new Set([due1, due2, exact, paused, attention, hook, future, unscheduled]);
    const r = await call("app.due_automations", [1000, now.toISOString()]);
    expect(r.fields).toEqual(["id", "organization_id"]);
    expect(r.rows.filter((row) => mine.has(row.id))).toEqual([
      { id: due1, organization_id: C.id },
      { id: due2, organization_id: D.id },
      { id: exact, organization_id: C.id },
    ]);
    expect((await call("app.due_automations", [0, now.toISOString()])).rows).toHaveLength(1);
    expect((await call("app.due_automations", [-5, now.toISOString()])).rows).toHaveLength(1);
    expect((await call("app.due_automations", [2, now.toISOString()])).rows).toHaveLength(2);
  });

  it("stale_automation_runs: delivered runs older than the cutoff only", async () => {
    const a = await automation(migratorQ, C);
    const b = await automation(migratorQ, D);
    const run = async (o: Org, automationId: string, status: string, deliveredAt: string | null) =>
      (
        await migrator.query(
          "insert into app.automation_runs (organization_id, automation_id, trigger, status, delivered_at) values ($1, $2, 'manual', $3, $4) returning id",
          [o.id, automationId, status, deliveredAt],
        )
      ).rows[0].id as string;
    const stale1 = await run(C, a, "delivered", ago(60));
    const stale2 = await run(D, b, "delivered", ago(30));
    const fresh = await run(C, a, "delivered", ago(1));
    const answered = await run(D, b, "answered", ago(60));
    const queued = await run(C, a, "queued", null);
    const mine = new Set([stale1, stale2, fresh, answered, queued]);
    const r = await call("app.stale_automation_runs", [1000, ago(10)]);
    expect(r.fields).toEqual(["id", "organization_id"]);
    expect(r.rows.filter((row) => mine.has(row.id))).toEqual([
      { id: stale1, organization_id: C.id },
      { id: stale2, organization_id: D.id },
    ]);
  });

  it("due_mailboxes: active, unreachable and backed-off auth_failed mailboxes of active automations, due by now; auth_failed at once after a key change", async () => {
    const box = async (
      o: Org,
      status: string,
      nextPollAt: string,
      automationStatus = "active",
      updatedAt = ago(60),
    ) => {
      const a = await automation(migratorQ, o, {
        trigger_kind: "mail",
        schedule_cron: null,
        time_zone: null,
        inbound_action: "post",
        status: automationStatus,
      });
      return (
        await migrator.query(
          "insert into app.mailboxes (organization_id, automation_id, owner_user_id, vault_item_id, host, status, next_poll_at, updated_at) values ($1, $2, $3, $4, 'imap.example.test', $5, $6, $7) returning id",
          [o.id, a, o.ana, o.vault, status, nextPollAt, updatedAt],
        )
      ).rows[0].id as string;
    };
    // The keys changed 30 minutes ago (a new password): after the failures dated 60 minutes ago, before the 5-minute one.
    await migrator.query("update app.vault_items set updated_at = $1 where id = any($2)", [
      ago(30),
      [C.vault, D.vault],
    ]);
    const active = await box(C, "active", ago(10));
    const unreachable = await box(D, "unreachable", ago(5));
    const authBackedOff = await box(C, "auth_failed", ago(8), "active", ago(5));
    const authKeyChanged = await box(D, "auth_failed", ago(-20), "active", ago(60));
    const authWaiting = await box(C, "auth_failed", ago(-20), "active", ago(5));
    const paused = await box(D, "paused", ago(10));
    const pausedAutomation = await box(C, "active", ago(10), "paused");
    const pausedAuthFailed = await box(D, "auth_failed", ago(10), "paused", ago(60));
    const future = await box(D, "active", ago(-10));
    const mine = new Set([
      active,
      unreachable,
      authBackedOff,
      authKeyChanged,
      authWaiting,
      paused,
      pausedAutomation,
      pausedAuthFailed,
      future,
    ]);
    const r = await call("app.due_mailboxes", [1000, now.toISOString()]);
    expect(r.fields).toEqual(["id", "organization_id"]);
    expect(r.rows.filter((row) => mine.has(row.id))).toEqual([
      { id: active, organization_id: C.id },
      { id: authBackedOff, organization_id: C.id },
      { id: unreachable, organization_id: D.id },
      { id: authKeyChanged, organization_id: D.id },
    ]);
  });

  it("due_watched_records: records whose next check is due", async () => {
    const card = async (o: Org) => {
      const m = randomUUID();
      await migrator.query(
        "insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body) values ($1, $2, $3, 9, 'user', $4, 'card')",
        [m, o.id, o.board, o.ana],
      );
      await migrator.query(
        "insert into app.board_cards (message_id, organization_id, conversation_id, column_id, rank, title) values ($1, $2, $3, $4, $5, 'card')",
        [m, o.id, o.board, o.column, `b${m.slice(0, 6)}`],
      );
      return m;
    };
    const watch = async (o: Org, nextCheckAt: string) =>
      (
        await migrator.query(
          `insert into app.watched_records (organization_id, card_message_id, conversation_id, agent_id, mcp_server_id, external_ref, read_tool, id_arg, fields, check_as_user_id, created_by, next_check_at) values ($1, $2, $3, $4, $5, 'SO-1', 'get_order', 'id', '[]', $6, $6, $7) returning id`,
          [o.id, await card(o), o.board, o.agent, o.mcp, o.ana, nextCheckAt],
        )
      ).rows[0].id as string;
    const due1 = await watch(C, ago(30));
    const due2 = await watch(D, ago(15));
    const future = await watch(C, ago(-15));
    const mine = new Set([due1, due2, future]);
    const r = await call("app.due_watched_records", [1000, now.toISOString()]);
    expect(r.fields).toEqual(["id", "organization_id"]);
    expect(r.rows.filter((row) => mine.has(row.id))).toEqual([
      { id: due1, organization_id: C.id },
      { id: due2, organization_id: D.id },
    ]);
  });

  it("lookup_webhook_endpoint: the endpoint and its organization, active only while linked and not deleted; nothing for an unknown id", async () => {
    const endpoint = async (o: Org, linked: boolean, deleted: boolean) => {
      const a = linked
        ? await automation(migratorQ, o, {
            trigger_kind: "webhook",
            schedule_cron: null,
            time_zone: null,
            inbound_action: "post",
          })
        : null;
      const publicId = nextPublicId();
      const id = (
        await migrator.query(
          "insert into app.webhook_endpoints (organization_id, automation_id, public_id, secret_id, deleted_at) values ($1, $2, $3, $4, $5) returning id",
          [o.id, a, publicId, o.secret, deleted ? now.toISOString() : null],
        )
      ).rows[0].id as string;
      return { id, publicId };
    };
    const live = await endpoint(C, true, false);
    const tombstoned = await endpoint(D, true, true);
    const unlinked = await endpoint(C, false, false);
    let r = await call("app.lookup_webhook_endpoint", [live.publicId]);
    expect(r.fields).toEqual(["endpoint_id", "organization_id", "active"]);
    expect(r.rows).toEqual([{ endpoint_id: live.id, organization_id: C.id, active: true }]);
    r = await call("app.lookup_webhook_endpoint", [tombstoned.publicId]);
    expect(r.rows).toEqual([{ endpoint_id: tombstoned.id, organization_id: D.id, active: false }]);
    r = await call("app.lookup_webhook_endpoint", [unlinked.publicId]);
    expect(r.rows).toEqual([{ endpoint_id: unlinked.id, organization_id: C.id, active: false }]);
    expect((await call("app.lookup_webhook_endpoint", ["9".repeat(26)])).rows).toEqual([]);
  });

  it("expired_automation_events: unpurged items received before the cutoff", async () => {
    const a = await automation(migratorQ, C, {
      trigger_kind: "webhook",
      schedule_cron: null,
      time_zone: null,
      inbound_action: "post",
    });
    const endpoint = (
      await migrator.query(
        "insert into app.webhook_endpoints (organization_id, automation_id, public_id, secret_id) values ($1, $2, $3, $4) returning id",
        [C.id, a, nextPublicId(), C.secret],
      )
    ).rows[0].id as string;
    const event = async (external: string, receivedAt: string, purged: boolean) =>
      (
        await migrator.query(
          "insert into app.automation_events (organization_id, source, webhook_endpoint_id, external_id, body_text, received_at, content_purged_at, result) values ($1, 'webhook', $2, $3, $4, $5, $6, 'accepted') returning id",
          [C.id, endpoint, external, purged ? null : "body", receivedAt, purged ? now.toISOString() : null],
        )
      ).rows[0].id as string;
    const old = await event("e1", ago(60), false);
    const oldPurged = await event("e2", ago(60), true);
    const recent = await event("e3", ago(1), false);
    const mine = new Set([old, oldPurged, recent]);
    const r = await call("app.expired_automation_events", [1000, ago(10)]);
    expect(r.fields).toEqual(["id", "organization_id"]);
    expect(r.rows.filter((row) => mine.has(row.id))).toEqual([{ id: old, organization_id: C.id }]);
  });
});
