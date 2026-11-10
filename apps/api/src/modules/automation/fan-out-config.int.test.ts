import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.17-05 (AFO-02; D-02, D-08, D-10, D-16; PD-05, PD-06, PD-15, PD-17): an automation can be told to fan out and whom
 * to mention, and a fan-out automation's runs live in one "<name> · Runs" thread at its target instead of one card per
 * run. Real PostgreSQL + Redis + pg-boss; Víctor Ruiz (admin) owns the automations, Sam Lee and Alex Kim are members of
 * organization A, Eve Black is the admin of organization B; the team bot Scout runs them.
 */

let s: SandboxStack;
let salesId: string;
let ordersId: string;
let intakeId: string;

const core = () => s.stack.built.core;
const drain = () => core().jobs.drain("automation.fire");

const ORDER = "Find the new orders and open one conversation for each.";

const body = (extra: Json = {}): Json => ({
  name: "New orders",
  agentId: s.scoutId,
  instructions: ORDER,
  trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
  target: { kind: "board", conversationId: ordersId, columnId: intakeId },
  maxRunsPerDay: 24,
  ...extra,
});

const create = (extra: Json = {}) =>
  s.victor.request("POST", "/api/v1/automations", body(extra)) as Promise<Res>;

async function created(extra: Json = {}): Promise<Json> {
  return (await ok(create(extra), 201)).automation as Json;
}

const patch = async (id: string, changes: Json) => {
  const version = ((await ok(s.victor.request("GET", `/api/v1/automations/${id}`) as Promise<Res>)) as Json)
    .version as number;
  return s.victor.request("PATCH", `/api/v1/automations/${id}`, {
    expectedVersion: version,
    ...changes,
  }) as Promise<Res>;
};

const automationRow = async (id: string) =>
  (await s.su.query("select * from app.automations where id = $1", [id])).rows[0] as Json;

const runRow = async (runId: string) =>
  (await s.su.query("select * from app.automation_runs where id = $1", [runId])).rows[0] as Json;

const messageRow = async (id: string) =>
  (
    await s.su.query("select id, conversation_id, thread_id, deleted_at from app.messages where id = $1", [
      id,
    ])
  ).rows[0] as Json;

const runEvent = async (runId: string) =>
  (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
      [`cell:${s.orgA}`, runId],
    )
  ).rows.map((r) => r.payload as Json)[0] as Json;

const boardCards = async (conversationId: string) =>
  Number(
    (
      await s.su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [
        conversationId,
      ])
    ).rows[0].n,
  );

const runNow = async (automationId: string) =>
  (await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/run`) as Promise<Res>, 202))
    .runId as string;

/** A top-level message as Víctor reads it (the board's Messages view lists the same top-level, non-card messages). */
async function topLevel(conversationId: string): Promise<Json[]> {
  return (
    await ok(s.victor.request("GET", `/api/v1/conversations/${conversationId}/messages`) as Promise<Res>)
  ).messages as Json[];
}

async function expectRefused(res: Promise<Res>, code: string) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(codeOf(r)).toBe(code);
}

beforeAll(async () => {
  s = await startSandboxStack();
  await s.su.query(
    `insert into app.bot_policies (organization_id, max_automations_per_user) values ($1, 1000)
     on conflict (organization_id) do update set max_automations_per_user = 1000`,
    [s.orgA],
  );
  salesId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "sales", visibility: "private" }) as Promise<Res>,
    )
  ).id as string;
  ordersId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name: "orders",
        visibility: "private",
        layout: "board",
      }) as Promise<Res>,
    )
  ).id as string;
  for (const conv of [salesId, ordersId]) {
    for (const member of [
      { kind: "agent", id: s.scoutId },
      { kind: "user", id: s.samId },
    ]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${conv}/members`, member) as Promise<Res>);
    }
  }
  const col = await s.victor.request("POST", `/api/v1/boards/${ordersId}/columns`, {
    name: "Intake",
    category: "backlog",
  });
  expect([200, 201], JSON.stringify(col.body)).toContain(col.status);
  const columns = (await ok(s.victor.request("GET", `/api/v1/boards/${ordersId}`) as Promise<Res>))
    .columns as Json[];
  intakeId = columns.find((c) => c.name === "Intake")?.id as string;
  expect(intakeId).toBeTruthy();
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: settings and the run log thread

describe("fan-out settings (D-02, D-16, PD-05)", () => {
  it("saves fanOut on a board schedule, PATCH changes and toggles it, a 07.16 body saves with fan-out off", async () => {
    const a = await created({ fanOut: { enabled: true, perRun: 5, perDay: 20 } });
    expect(a.fanOut).toEqual({ enabled: true, perRun: 5, perDay: 20 });
    expect(await automationRow(a.id)).toMatchObject({
      fan_out_enabled: true,
      fan_out_per_run: 5,
      fan_out_per_day: 20,
    });

    // The defaults (10 / 100) when only the switch is sent.
    const d = await created({ fanOut: { enabled: true } });
    expect(d.fanOut).toEqual({ enabled: true, perRun: 10, perDay: 100 });

    const changed = (await ok(patch(a.id, { fanOut: { enabled: true, perRun: 8, perDay: 40 } })))
      .automation as Json;
    expect(changed.fanOut).toEqual({ enabled: true, perRun: 8, perDay: 40 });
    const off = (await ok(patch(a.id, { fanOut: { enabled: false, perRun: 8, perDay: 40 } })))
      .automation as Json;
    expect(off.fanOut).toEqual({ enabled: false, perRun: 8, perDay: 40 });
    // An update without fanOut keeps it as it is.
    const renamed = (await ok(patch(a.id, { name: "New orders (renamed)" }))).automation as Json;
    expect(renamed.fanOut).toEqual({ enabled: false, perRun: 8, perDay: 40 });
    const on = (await ok(patch(a.id, { fanOut: { enabled: true, perRun: 8, perDay: 40 } })))
      .automation as Json;
    expect(on.fanOut).toEqual({ enabled: true, perRun: 8, perDay: 40 });

    // A 07.16 body: no fanOut at all.
    const plain = await created();
    expect(plain.fanOut).toEqual({ enabled: false, perRun: 10, perDay: 100 });
    expect(await automationRow(plain.id)).toMatchObject({ fan_out_enabled: false, run_log_message_id: null });

    // per run above per day is the contract's refusal.
    const bad = await create({ fanOut: { enabled: true, perRun: 30, perDay: 20 } });
    expect(bad.status).toBe(400);
  });

  it("WR-08: a partial fanOut on PATCH keeps the stored caps; the merged caps are checked", async () => {
    const a = await created({ fanOut: { enabled: true, perRun: 25, perDay: 500 } });
    const off = (await ok(patch(a.id, { fanOut: { enabled: false } }))).automation as Json;
    expect(off.fanOut).toEqual({ enabled: false, perRun: 25, perDay: 500 });
    expect(await automationRow(a.id)).toMatchObject({ fan_out_per_run: 25, fan_out_per_day: 500 });
    const on = (await ok(patch(a.id, { fanOut: { enabled: true } }))).automation as Json;
    expect(on.fanOut).toEqual({ enabled: true, perRun: 25, perDay: 500 });
    // Only one cap: the other one is kept.
    const day = (await ok(patch(a.id, { fanOut: { enabled: true, perDay: 300 } }))).automation as Json;
    expect(day.fanOut).toEqual({ enabled: true, perRun: 25, perDay: 300 });
    // A per-day cap below the stored per-run cap is refused (400, not the database check's 500); nothing changes.
    const bad = await patch(a.id, { fanOut: { enabled: true, perDay: 20 } });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(await automationRow(a.id)).toMatchObject({ fan_out_per_run: 25, fan_out_per_day: 300 });
    // The audit says what is stored.
    const [updated] = (
      await s.su.query(
        "select metadata from app.audit_events where action = 'automation.updated' and resource_id = $1 order by occurred_at desc, id desc limit 1",
        [a.id],
      )
    ).rows as [Json];
    expect(updated.metadata).toMatchObject({ fanOut: true, perRun: 25, perDay: 300 });
  });

  it("refuses fan-out on webhook, mail and digest automations and on DM or thread targets, on create and on update", async () => {
    const fanOut = { enabled: true };
    await expectRefused(
      create({
        fanOut,
        trigger: { kind: "webhook" },
        target: { kind: "channel", conversationId: salesId },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      "fan_out_not_allowed",
    );
    await expectRefused(
      create({
        fanOut,
        trigger: {
          kind: "mail",
          mailbox: {
            vaultItemId: "00000000-0000-4000-8000-000000000001",
            host: "imap.example.test",
            port: 993,
            folder: "INBOX",
            pollIntervalMinutes: 10,
          },
        },
        target: { kind: "channel", conversationId: salesId },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      "fan_out_not_allowed",
    );
    await expectRefused(create({ fanOut, target: { kind: "dm" } }), "fan_out_not_allowed");
    const root = (
      await ok(
        s.victor.request("POST", `/api/v1/conversations/${salesId}/messages`, {
          body: "Order thread",
        }) as Promise<Res>,
      )
    ).id as string;
    await expectRefused(
      create({ fanOut, target: { kind: "thread", conversationId: salesId, threadRootMessageId: root } }),
      "fan_out_not_allowed",
    );
    // Fan-out off on the same shapes saves as before.
    expect((await created({ fanOut: { enabled: false }, target: { kind: "dm" } })).fanOut).toMatchObject({
      enabled: false,
    });

    // A fan-out automation cannot move to a DM, a thread or a webhook.
    const a = await created({ fanOut });
    await expectRefused(patch(a.id, { target: { kind: "dm" } }), "fan_out_not_allowed");
    await expectRefused(
      patch(a.id, { target: { kind: "thread", conversationId: salesId, threadRootMessageId: root } }),
      "fan_out_not_allowed",
    );
    await expectRefused(
      patch(a.id, {
        trigger: { kind: "webhook" },
        inbound: { action: "post", askBot: true, config: {} },
      }),
      "fan_out_not_allowed",
    );
    // Turning fan-out on for a DM automation is refused the same.
    const dm = await created({ target: { kind: "dm" } });
    await expectRefused(patch(dm.id, { fanOut }), "fan_out_not_allowed");
    // A digest never fans out.
    const [digest] = (
      await s.su.query(
        `insert into app.automations (organization_id, name, agent_id, run_as_user_id, created_by, action_kind, instructions,
           trigger_kind, schedule_cron, time_zone, target_kind, max_runs_per_day)
         values ($1, 'Daily digest', $2, $3, $3, 'digest', '', 'schedule', '0 8 * * *', 'Europe/Madrid', 'dm', 1)
         returning id`,
        [s.orgA, s.scoutId, s.victorId],
      )
    ).rows as [Json];
    await expectRefused(patch(digest.id, { fanOut }), "fan_out_not_allowed");
    expect(await automationRow(a.id)).toMatchObject({ fan_out_enabled: true, target_kind: "board" });
  });
});

describe("the “<name> · Runs” thread (D-10, PD-06)", () => {
  it("board: Run now posts the run log root top-level (no board card), the run card in its thread, and delivers there; the root is reused, and replaced once deleted", async () => {
    const a = await created({ name: "Shopify orders", fanOut: { enabled: true, perRun: 5, perDay: 20 } });
    const cardsBefore = await boardCards(ordersId);

    const runId = await runNow(a.id);
    expect(await drain()).toBe(1);
    const row = await automationRow(a.id);
    const rootId = row.run_log_message_id as string;
    expect(rootId).toBeTruthy();
    // A-01: a top-level message in the board channel, not a board card, shown in its Messages view.
    expect(await messageRow(rootId)).toMatchObject({ conversation_id: ordersId, thread_id: null });
    expect(await boardCards(ordersId)).toBe(cardsBefore);
    const root = (await topLevel(ordersId)).find((m) => m.id === rootId) as Json;
    expect(root?.author).toMatchObject({ kind: "agent", id: s.scoutId });
    expect(root?.card).toMatchObject({
      kind: "automation",
      platformOwned: true,
      title: "Shopify orders · Runs",
      fields: [
        { label: "Schedule", value: "Fridays at 5:00 PM" },
        { label: "Opens", value: "Up to 5 per run · 20 a day" },
      ],
      actions: [
        { kind: "open", label: "Open automation", target: `/bots/automations?edit=${a.id}` },
        { kind: "follow", label: "Follow" },
      ],
    });
    const key = (await s.su.query("select client_message_id from app.messages where id = $1", [rootId]))
      .rows[0];
    expect(key.client_message_id).toBe(`card:runlog:${runId}`);

    // The run card is a reply in that thread; the run's turn names that thread.
    const run = await runRow(runId);
    expect(run.board_card_message_id).toBeNull();
    expect(run.status).toBe("delivered");
    const anchor = await messageRow(run.anchor_message_id);
    expect(anchor).toMatchObject({ conversation_id: ordersId, thread_id: rootId });
    const ev = await runEvent(runId);
    expect(ev.message.id).toBe(run.anchor_message_id);
    expect(ev.thread.rootMessageId).toBe(rootId);
    const listed = (
      (await ok(s.victor.request("GET", `/api/v1/automations/${a.id}/runs`) as Promise<Res>)).runs as Json[]
    ).find((r) => r.id === runId) as Json;
    expect(listed.anchor).toEqual({
      conversationId: ordersId,
      messageId: run.anchor_message_id,
      threadRootId: rootId,
    });

    // A second run: a second run card in the same thread, no new root, no board card.
    const second = await runNow(a.id);
    expect(await drain()).toBe(1);
    expect((await automationRow(a.id)).run_log_message_id).toBe(rootId);
    const secondRun = await runRow(second);
    expect(await messageRow(secondRun.anchor_message_id)).toMatchObject({ thread_id: rootId });
    expect(secondRun.anchor_message_id).not.toBe(run.anchor_message_id);
    expect(await boardCards(ordersId)).toBe(cardsBefore);
    const roots = (
      await s.su.query(
        "select count(*)::int as n from app.messages where conversation_id = $1 and client_message_id like 'card:runlog:%'",
        [ordersId],
      )
    ).rows[0];
    expect(roots.n).toBe(1);

    // The root deleted (moderated by Víctor): the next run posts a new root and stores it.
    await ok(s.victor.request("DELETE", `/api/v1/messages/${rootId}`) as Promise<Res>);
    const third = await runNow(a.id);
    expect(await drain()).toBe(1);
    const newRoot = (await automationRow(a.id)).run_log_message_id as string;
    expect(newRoot).toBeTruthy();
    expect(newRoot).not.toBe(rootId);
    expect(await messageRow(newRoot)).toMatchObject({
      conversation_id: ordersId,
      thread_id: null,
      deleted_at: null,
    });
    const thirdRun = await runRow(third);
    expect(thirdRun.status).toBe("delivered");
    expect(await messageRow(thirdRun.anchor_message_id)).toMatchObject({ thread_id: newRoot });
    expect(await boardCards(ordersId)).toBe(cardsBefore);
  });

  it("channel: the same thread, and the run card is never top-level", async () => {
    const a = await created({
      name: "Support inbox",
      target: { kind: "channel", conversationId: salesId },
      fanOut: { enabled: true },
    });
    const first = await runNow(a.id);
    const second = await runNow(a.id);
    expect(await drain()).toBe(2);
    const rootId = (await automationRow(a.id)).run_log_message_id as string;
    expect(await messageRow(rootId)).toMatchObject({ conversation_id: salesId, thread_id: null });
    const top = await topLevel(salesId);
    const root = top.find((m) => m.id === rootId) as Json;
    expect(root?.card).toMatchObject({
      title: "Support inbox · Runs",
      fields: [
        { label: "Schedule", value: "Fridays at 5:00 PM" },
        { label: "Opens", value: "Up to 10 per run · 100 a day" },
      ],
    });
    for (const runId of [first, second]) {
      const run = await runRow(runId);
      expect(await messageRow(run.anchor_message_id)).toMatchObject({
        conversation_id: salesId,
        thread_id: rootId,
      });
      expect(top.some((m) => m.id === run.anchor_message_id)).toBe(false);
      expect((await runEvent(runId)).thread.rootMessageId).toBe(rootId);
    }
  });

  it("an automation without fan-out keeps its run card top-level in the channel and stores no root (E9, PD-18)", async () => {
    const a = await created({ name: "Plain report", target: { kind: "channel", conversationId: salesId } });
    const runId = await runNow(a.id);
    expect(await drain()).toBe(1);
    const run = await runRow(runId);
    expect(await messageRow(run.anchor_message_id)).toMatchObject({
      conversation_id: salesId,
      thread_id: null,
    });
    expect((await automationRow(a.id)).run_log_message_id).toBeNull();
    expect((await runEvent(runId)).thread.rootMessageId).toBe(run.anchor_message_id);
  });
});

// ---------------------------------------------------------------- Task 2: escalation targets (D-08, PD-15)

describe("escalation targets: validated at save, resolved at delivery (D-08, PD-15, E20)", () => {
  let logistics: string;
  let operations: string;
  let roadmap: string;
  let hidden: string;
  let generalId: string;

  const unit = async (kind: string, name: string, parentId: string | null = operations) =>
    (await ok(s.victor.request("POST", "/api/v1/units", { kind, name, parentId }) as Promise<Res>))
      .id as string;
  const handleOf = async (id: string) =>
    (await s.su.query("select handle from app.org_units where id = $1", [id])).rows[0]?.handle as string;
  const onSales = (escalation: Json[], extra: Json = {}) =>
    create({ target: { kind: "channel", conversationId: salesId }, escalation, ...extra });
  const get = async (id: string) =>
    (await ok(s.victor.request("GET", `/api/v1/automations/${id}`) as Promise<Res>)) as Json;
  const removeSam = () =>
    ok(s.victor.request("DELETE", `/api/v1/channels/${salesId}/members/user/${s.samId}`) as Promise<Res>);
  const addSam = () =>
    ok(
      s.victor.request("POST", `/api/v1/channels/${salesId}/members`, {
        kind: "user",
        id: s.samId,
      }) as Promise<Res>,
    );

  beforeAll(async () => {
    operations = await unit("department", "Operations", null);
    logistics = await unit("team", "Logistics");
    roadmap = await unit("project", "Roadmap", logistics);
    hidden = await unit("team", "Board room");
    // Víctor may not read this one (an explicit deny scoped to it).
    await s.su.query(
      `insert into app.permission_rules (organization_id, scope_unit_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'user', $3, 'unit.read', 'deny')`,
      [s.orgA, hidden, s.victorId],
    );
    generalId = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: "general-fo",
          visibility: "public",
        }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${generalId}/members`, {
        kind: "agent",
        id: s.scoutId,
      }) as Promise<Res>,
    );
  });

  it("saves people and teams who can read the target, in order, and returns them as views", async () => {
    const a = (
      await ok(
        onSales([
          { kind: "unit", id: logistics },
          { kind: "user", id: s.samId },
          { kind: "unit", id: operations },
        ]),
        201,
      )
    ).automation as Json;
    expect(await handleOf(logistics)).toBe("logistics");
    expect(a.escalation).toEqual([
      { kind: "unit", id: logistics, handle: "logistics", displayName: "Logistics" },
      { kind: "user", id: s.samId, handle: "sam", displayName: "Sam Lee" },
      { kind: "unit", id: operations, handle: await handleOf(operations), displayName: "Operations" },
    ]);
    // Stable ids only in the row (principle 11).
    expect((await automationRow(a.id)).escalation_targets).toEqual([
      { kind: "unit", id: logistics },
      { kind: "user", id: s.samId },
      { kind: "unit", id: operations },
    ]);
    // Without escalation: none.
    expect((await created({ target: { kind: "channel", conversationId: salesId } })).escalation).toEqual([]);
  });

  it("refuses with escalation_not_allowed whoever cannot read the target and every unit that is not a readable team or department", async () => {
    // Alex is not in the private #sales.
    await expectRefused(onSales([{ kind: "user", id: s.alexId }]), "escalation_not_allowed");
    // An unknown person, and Eve (organization B).
    await expectRefused(
      onSales([{ kind: "user", id: "00000000-0000-4000-8000-000000000002" }]),
      "escalation_not_allowed",
    );
    await expectRefused(onSales([{ kind: "user", id: s.eveId }]), "escalation_not_allowed");
    // A deactivated member, on a public channel they otherwise read.
    const onGeneral = (escalation: Json[]) =>
      create({ target: { kind: "channel", conversationId: generalId }, escalation });
    expect(
      ((await ok(onGeneral([{ kind: "user", id: s.alexId }]), 201)).automation as Json).escalation,
    ).toHaveLength(1);
    await s.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [s.alexId]);
    try {
      await expectRefused(onGeneral([{ kind: "user", id: s.alexId }]), "escalation_not_allowed");
    } finally {
      await s.su.query("update app.org_members set deactivated_at = null where user_id = $1", [s.alexId]);
    }
    // A project unit, a unit of organization B, a unit Víctor may not read.
    await expectRefused(onSales([{ kind: "unit", id: roadmap }]), "escalation_not_allowed");
    const [foreign] = (
      await s.su.query(
        "insert into app.org_units (organization_id, kind, name, path) values ($1, 'team', 'Evil logistics', '{}') returning id",
        [s.orgB],
      )
    ).rows as [Json];
    await s.su.query("update app.org_units set path = array[id] where id = $1", [foreign.id]);
    await expectRefused(onSales([{ kind: "unit", id: foreign.id }]), "escalation_not_allowed");
    await expectRefused(onSales([{ kind: "unit", id: hidden }]), "escalation_not_allowed");
    // One bad target refuses the whole list.
    await expectRefused(
      onSales([
        { kind: "unit", id: logistics },
        { kind: "user", id: s.alexId },
      ]),
      "escalation_not_allowed",
    );
    // A DM target: only the run-as person.
    await expectRefused(
      create({ target: { kind: "dm" }, escalation: [{ kind: "user", id: s.samId }] }),
      "escalation_not_allowed",
    );
    const dm = (
      await ok(create({ target: { kind: "dm" }, escalation: [{ kind: "user", id: s.victorId }] }), 201)
    ).automation as Json;
    expect(dm.escalation).toEqual([
      { kind: "user", id: s.victorId, handle: "victor", displayName: "Víctor Ruiz" },
    ]);
    // An update is validated the same.
    const a = await created({ target: { kind: "channel", conversationId: salesId } });
    await expectRefused(
      patch(a.id, { escalation: [{ kind: "user", id: s.alexId }] }),
      "escalation_not_allowed",
    );
  });

  it("WR-04: a team whose handle a person or bot holds is never an escalation target, and a bot cannot take a team's handle", async () => {
    // A team named like Sam gets Sam's handle (people win the mention): it would name Sam, not the team.
    const samTeam = await unit("team", "Sam");
    expect(await handleOf(samTeam)).toBe("sam");
    await expectRefused(onSales([{ kind: "unit", id: samTeam }]), "escalation_not_allowed");

    // A team saved as a target, then shadowed by a bot that takes its handle: dropped at delivery.
    const yard = await unit("team", "Yard crew");
    const handle = await handleOf(yard);
    const a = (await ok(onSales([{ kind: "unit", id: yard }]), 201)).automation as Json;
    expect((await get(a.id)).escalation).toHaveLength(1);
    // The API refuses a bot with that username (below), so a raw row plays an older writer here.
    await s.su.query(
      "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Yard bot', $2, 'x', 'mock', 'mock-1')",
      [s.orgA, handle],
    );
    try {
      expect((await get(a.id)).escalation).toEqual([]);
    } finally {
      await s.su.query("delete from app.agents where organization_id = $1 and username = $2", [
        s.orgA,
        handle,
      ]);
    }

    // Bot create and rename never take a team's or department's handle; a name-derived username steps past it.
    const bot = (name: string, extra: Json = {}) =>
      s.victor.request("POST", "/api/v1/agents", {
        name,
        instructions: "Answer questions.",
        modelProvider: "mock",
        modelId: "mock-1",
        ...extra,
      }) as Promise<Res>;
    const taken = await bot("Yard", { username: handle });
    expect(taken.status, JSON.stringify(taken.body)).toBe(409);
    expect(codeOf(taken)).toBe("username_taken");
    const derived = (await ok(bot("Logistics"))) as Json;
    expect(derived.username).not.toBe("logistics");
    const renamed = await s.victor.request("PATCH", `/api/v1/agents/${derived.id}`, {
      username: "logistics",
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(409);
    expect(codeOf(renamed)).toBe("username_taken");
  });

  it("drops at delivery whoever left or lost access and a deleted unit; an update with [] clears, without escalation keeps", async () => {
    const tmp = await unit("team", "Night shift");
    const a = (
      await ok(
        onSales([
          { kind: "unit", id: tmp },
          { kind: "user", id: s.samId },
        ]),
        201,
      )
    ).automation as Json;
    expect((await get(a.id)).escalation).toHaveLength(2);
    // An update without escalation keeps it.
    expect(((await ok(patch(a.id, { name: "Renamed" }))).automation as Json).escalation).toHaveLength(2);
    const nightShift = { kind: "unit", id: tmp, handle: await handleOf(tmp), displayName: "Night shift" };

    // Sam loses access to #sales: dropped; back in: shown again.
    await removeSam();
    try {
      expect((await get(a.id)).escalation).toEqual([nightShift]);
    } finally {
      await addSam();
    }
    expect((await get(a.id)).escalation).toHaveLength(2);

    // Sam leaves the organization: only the unit; the unit deleted: nothing.
    const [member] = (
      await s.su.query("select row_to_json(m) as j from app.org_members m where user_id = $1", [s.samId])
    ).rows as [Json];
    await s.su.query("delete from app.org_members where user_id = $1", [s.samId]);
    try {
      expect((await get(a.id)).escalation).toEqual([nightShift]);
      await s.su.query("delete from app.org_units where id = $1", [tmp]);
      expect((await get(a.id)).escalation).toEqual([]);
    } finally {
      await s.su.query(
        "insert into app.org_members select (json_populate_record(null::app.org_members, $1::json)).*",
        [JSON.stringify(member.j)],
      );
    }

    // An update with [] clears it.
    const b = (await ok(onSales([{ kind: "user", id: s.samId }]), 201)).automation as Json;
    const cleared = (await ok(patch(b.id, { escalation: [] }))).automation as Json;
    expect(cleared.escalation).toEqual([]);
    expect((await automationRow(b.id)).escalation_targets).toEqual([]);
  });
});

// ---------------------------------------------------------------- Task 3: opened per run, audit, tenant isolation

describe("runs report what they opened; the settings are audited and isolated per organization (PD-17)", () => {
  const runsOf = async (id: string, as = s.victor) =>
    (await ok(as.request("GET", `/api/v1/automations/${id}/runs`) as Promise<Res>)).runs as Json[];
  const audits = async (action: string, id: string) =>
    (
      await s.su.query(
        "select metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
        [action, id],
      )
    ).rows.map((r) => r.metadata as Json);
  const hash = (n: number) => n.toString(16).padStart(64, "0");

  it("GET /runs counts the conversations a fan-out run opened; runs of other automations say null", async () => {
    const a = await created({ name: "Opened count", fanOut: { enabled: true } });
    const first = await runNow(a.id);
    const second = await runNow(a.id);
    expect(await drain()).toBe(2);
    for (const n of [1, 2]) {
      await s.su.query(
        `insert into app.automation_conversations (organization_id, automation_id, run_id, external_key_hash, conversation_id)
         values ($1, $2, $3, $4, $5)`,
        [s.orgA, a.id, first, hash(n), ordersId],
      );
    }
    const runs = await runsOf(a.id);
    expect(runs.find((r) => r.id === first)?.opened).toBe(2);
    expect(runs.find((r) => r.id === second)?.opened).toBe(0);

    const plain = await created({ name: "Not fanned out" });
    const plainRun = await runNow(plain.id);
    expect(await drain()).toBe(1);
    expect((await runsOf(plain.id)).find((r) => r.id === plainRun)?.opened).toBeNull();
  });

  it("automation.created and automation.updated carry fanOut, perRun, perDay and escalationCount, never a name or a handle", async () => {
    const team = (
      await ok(
        s.victor.request("POST", "/api/v1/units", {
          kind: "department",
          name: "Fulfilment Desk",
          parentId: null,
        }) as Promise<Res>,
      )
    ).id as string;
    const a = (
      await ok(
        create({
          name: "Audited fan-out",
          target: { kind: "channel", conversationId: salesId },
          fanOut: { enabled: true, perRun: 4, perDay: 12 },
          escalation: [
            { kind: "unit", id: team },
            { kind: "user", id: s.samId },
          ],
        }),
        201,
      )
    ).automation as Json;
    const [createdAudit] = (await audits("automation.created", a.id)) as [Json];
    expect(createdAudit).toMatchObject({ fanOut: true, perRun: 4, perDay: 12, escalationCount: 2 });
    await ok(
      patch(a.id, {
        fanOut: { enabled: false, perRun: 4, perDay: 12 },
        escalation: [{ kind: "unit", id: team }],
      }),
    );
    const [updatedAudit] = (await audits("automation.updated", a.id)) as [Json];
    expect(updatedAudit).toMatchObject({ fanOut: false, perRun: 4, perDay: 12, escalationCount: 1 });
    expect(updatedAudit.changed).toEqual(expect.arrayContaining(["escalation", "fanOut"]));
    for (const m of [createdAudit, updatedAudit]) {
      const text = JSON.stringify(m);
      expect(text).not.toMatch(/Fulfilment|fulfilment-desk|Sam Lee|"sam"|Audited fan-out/);
      expect(m).not.toHaveProperty("handle");
      expect(m).not.toHaveProperty("displayName");
    }
    // A 07.16-shaped automation: off, the defaults, none.
    const plain = await created({ name: "Plain audit" });
    expect((await audits("automation.created", plain.id))[0]).toMatchObject({
      fanOut: false,
      perRun: 10,
      perDay: 100,
      escalationCount: 0,
    });
  });

  it("organization B cannot read or change organization A's fan-out settings or runs (404)", async () => {
    const a = await created({ name: "Tenant fan-out", fanOut: { enabled: true, perRun: 3, perDay: 9 } });
    const run = await runNow(a.id);
    expect(await drain()).toBe(1);
    const version = (await automationRow(a.id)).version as number;
    for (const [method, path, payload] of [
      ["GET", `/api/v1/automations/${a.id}`, undefined],
      ["GET", `/api/v1/automations/${a.id}/runs`, undefined],
      [
        "PATCH",
        `/api/v1/automations/${a.id}`,
        { expectedVersion: version, fanOut: { enabled: false }, escalation: [{ kind: "user", id: s.eveId }] },
      ],
    ] as const) {
      const r = (await s.eve.request(method, path, payload)) as Res;
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Nothing changed, and Eve's list does not show it.
    expect(await automationRow(a.id)).toMatchObject({
      fan_out_enabled: true,
      fan_out_per_run: 3,
      fan_out_per_day: 9,
      escalation_targets: [],
      version,
    });
    const eveList = (await ok(s.eve.request("GET", "/api/v1/automations") as Promise<Res>))
      .automations as Json[];
    expect(eveList.some((x) => x.id === a.id)).toBe(false);
    expect((await runsOf(a.id)).some((r) => r.id === run)).toBe(true);
  });
});
