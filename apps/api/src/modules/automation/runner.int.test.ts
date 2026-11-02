import { randomUUID } from "node:crypto";
import { BROWSER_TOOL_NAMES, MAX_SANDBOX_CALLS_PER_TURN, SANDBOX_TOOL_NAMES } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import {
  type Json,
  ok,
  type Res,
  SANDBOX_CELL_TOKEN,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";
import { tickOnce } from "./runner";

/**
 * 07.6-09 (AUTO-01; D-01, D-03, D-07, D-12; P-07, P-08, P-09; Pitfalls 1 and 6): the phase's API tracer. Scheduled
 * automations actually run: the one-minute tick finds a due automation, queues one run and its ids-only fire job in the
 * same transaction; the fire job re-decides everything as the run-as person, posts the platform-owned run card and
 * delivers the bot's (unattended) turn; the cell's reply marks the run Done. Retries, a second tick and a second
 * replica never double-post. Real PostgreSQL + Redis + pg-boss and the in-memory sandboxd; Víctor Ruiz (admin), Sam Lee
 * and the team bot Scout (sandbox on) in organization A.
 */

let s: SandboxStack;
let salesId: string;
const ORDER = "Summarise this week's closed deals and post the totals per rep.";

const core = () => s.stack.built.core;
const drain = () => core().jobs.drain("automation.fire");

/** Víctor's automation through 05's REST resource (run as him, D-07). */
async function createAutomation(extra: Json = {}): Promise<string> {
  const body = {
    name: "Weekly sales report",
    agentId: s.scoutId,
    instructions: ORDER,
    trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
    target: { kind: "channel", conversationId: salesId },
    maxRunsPerDay: 24,
    ...extra,
  };
  const res = (await ok(s.victor.request("POST", "/api/v1/automations", body) as Promise<Res>, 201)) as Json;
  return res.automation.id as string;
}

/** Makes the automation due `agoMs` ago (what a clock reaching its next instant does). */
async function makeDue(automationId: string, agoMs = 30_000): Promise<string> {
  const at = new Date(Date.now() - agoMs).toISOString();
  await s.su.query("update app.automations set next_run_at = $2 where id = $1", [automationId, at]);
  return at;
}

const automationRow = async (id: string) =>
  (await s.su.query("select * from app.automations where id = $1", [id])).rows[0] as Json;

const runsOf = async (automationId: string) =>
  (
    await s.su.query("select * from app.automation_runs where automation_id = $1 order by created_at, id", [
      automationId,
    ])
  ).rows as Json[];

const runRow = async (runId: string) =>
  (await s.su.query("select * from app.automation_runs where id = $1", [runId])).rows[0] as Json;

const runEvents = async (runId: string) =>
  (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
      [`cell:${s.orgA}`, runId],
    )
  ).rows.map((r) => r.payload as Json);

const anchorsOf = async (runId: string) =>
  (
    await s.su.query(
      "select id, conversation_id, thread_id from app.messages where author_kind = 'agent' and client_message_id in ($1, $2)",
      [`run:${runId}`, `card:run:${runId}`],
    )
  ).rows as Json[];

const turnRow = async (eventId: string) =>
  (await s.su.query("select * from app.agent_turns where event_id = $1", [eventId])).rows[0] as Json;

const auditOf = async (action: string, runId: string) =>
  (
    await s.su.query(
      "select agent_id, user_id, result, metadata from app.audit_events where action = $1 and metadata->>'runId' = $2",
      [action, runId],
    )
  ).rows as Json[];

const runUpdates = async (userId: string, runId: string) =>
  (
    await s.su.query(
      "select seq from app.stream_events where stream_id = $1 and type = 'automation_run.updated' and payload->>'runId' = $2",
      [`user:${userId}`, runId],
    )
  ).rows.length;

/** A top-level message as a member reads it. */
async function messageOf(
  conversationId: string,
  messageId: string,
  as = s.victor,
): Promise<Json | undefined> {
  const list = (
    await ok(as.request("GET", `/api/v1/conversations/${conversationId}/messages`) as Promise<Res>)
  ).messages as Json[];
  return list.find((m) => m.id === messageId);
}

/** The card of a top-level message as a member reads it. */
const cardOf = async (conversationId: string, messageId: string, as = s.victor) =>
  (await messageOf(conversationId, messageId, as))?.card as Json | undefined;

/** The cell's reply to a delivered run, like the real plugin: on the anchor, for the run's turn. */
const replyTo = (ev: Json, text = "Here is the weekly report.") =>
  s.cell("/messages", {
    agentId: ev.agent.id,
    conversationId: ev.conversation.id,
    threadRootMessageId: ev.conversation.kind === "dm" ? null : ev.thread.rootMessageId,
    inReplyToMessageId: ev.message.id,
    eventId: ev.eventId,
    text,
    idempotencyKey: `evt:${ev.eventId}:${randomUUID().slice(0, 6)}`,
  });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The next Friday 17:00 in Madrid after `from`, found without cron-parser (CET = 16:00Z, CEST = 15:00Z). */
function nextFridayFivePmMadrid(from: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < 15; i++) {
    for (const hour of [15, 16]) {
      const t = new Date(day.getTime() + i * 86_400_000 + hour * 3_600_000);
      if (t <= from) continue;
      const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
      if (parts.weekday === "Fri" && parts.hour === "17" && parts.minute === "00") return t.toISOString();
    }
  }
  throw new Error("no Friday found");
}

/** Run now (05) → the queued manual run's id. */
const runNow = async (automationId: string) =>
  (await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/run`) as Promise<Res>, 202))
    .runId as string;

beforeAll(async () => {
  s = await startSandboxStack();
  // Organization sandboxes on (07.8), browsers allowed, and Scout's own Browser switch on: a person's turn would get the
  // browser, so its absence from run turns is the unattended rule (D-12), not a missing setting.
  await s.setPolicy({ enabled: true });
  await s.su.query("update app.sandbox_policies set max_browsers = 50 where organization_id = $1", [s.orgA]);
  await s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
    [s.scoutId],
  );
  // One person owns many automations across this file.
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
  for (const member of [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${salesId}/members`, member) as Promise<Res>);
  }
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("tick → run → fire → anchor → turn → reply → answered (AUTO-01, D-01, D-07)", () => {
  it("at Friday 17:00 Madrid “Weekly sales report” posts its run card in #sales, Scout answers in the thread, the card says Done", async () => {
    const automationId = await createAutomation();
    const scheduledFor = await makeDue(automationId);
    const plugin = new FakeCellPlugin({
      apiUrl: s.stack.baseUrl,
      token: SANDBOX_CELL_TOKEN,
      autoReply: true,
    });
    await plugin.start();
    try {
      const now = new Date();
      expect(await tickOnce(core(), now)).toMatchObject({ fired: 1, skipped: 0 });
      const [run] = (await runsOf(automationId)) as [Json];
      expect(run).toMatchObject({ trigger: "schedule", status: "queued" });
      expect(new Date(run.scheduled_for).toISOString()).toBe(scheduledFor);
      // The next instant is computed from the scheduled one, in Madrid.
      expect(new Date((await automationRow(automationId)).next_run_at).toISOString()).toBe(
        nextFridayFivePmMadrid(new Date(scheduledFor)),
      );
      // One ids-only fire job, enqueued with the run.
      const jobs = (
        await s.su.query(
          "select data from pgboss.job where name = 'automation.fire' and data->>'runId' = $1",
          [run.id],
        )
      ).rows;
      expect(jobs.map((j) => j.data)).toEqual([{ organizationId: s.orgA, runId: run.id }]);

      expect(await drain()).toBe(1);
      const [anchor] = (await anchorsOf(run.id)) as [Json];
      expect(anchor).toMatchObject({ conversation_id: salesId, thread_id: null });
      const message = await messageOf(salesId, anchor.id);
      // The summary sentence is the message body (screen readers, notifications).
      expect(message?.body).toBe("Scheduled task “Weekly sales report” for Víctor Ruiz.");
      expect(message?.author).toMatchObject({ kind: "agent", id: s.scoutId });
      const card = message?.card as Json;
      expect(card).toMatchObject({
        kind: "automation",
        platformOwned: true,
        title: "Weekly sales report",
        fields: [
          { label: "For", value: "Víctor Ruiz" },
          { label: "Trigger", value: "Scheduled" },
          { label: "Schedule", value: "Fridays at 5:00 PM · Europe/Madrid" },
        ],
      });
      expect(["Running", "Done"]).toContain(card?.statusLabel);
      const events = await runEvents(run.id);
      expect(events).toHaveLength(1);
      const ev = events[0] as Json;
      expect(ev.message.id).toBe(anchor.id);
      expect(ev.thread.rootMessageId).toBe(anchor.id);
      expect(ev.agent.id).toBe(s.scoutId);
      expect(ev.automationRun).toMatchObject({
        automationId,
        runId: run.id,
        trigger: "schedule",
        inbound: null,
      });

      // Scout's answer lands in the anchor's thread and answers the run.
      await waitFor(async () => (await runRow(run.id)).status === "answered");
      const reply = plugin.replies.find((r) => r.mention.eventId === ev.eventId);
      expect(reply?.created).toBe(true);
      const replyRow = (
        await s.su.query("select thread_id from app.messages where id = $1", [reply?.messageId])
      ).rows[0] as Json;
      expect(replyRow.thread_id).toBe(anchor.id);
      expect(await cardOf(salesId, anchor.id)).toMatchObject({ status: "succeeded", statusLabel: "Done" });
      // queued → delivered → answered, each heard by Víctor.
      expect(await runUpdates(s.victorId, run.id)).toBeGreaterThanOrEqual(3);
      for (const action of [
        "automation.run_started",
        "automation.run_delivered",
        "automation.run_answered",
      ]) {
        const rows = await auditOf(action, run.id);
        expect(rows, action).toHaveLength(1);
        expect(rows[0]?.user_id).toBe(s.victorId);
        // Ids and codes only: never the name or the instructions.
        expect(JSON.stringify(rows[0]?.metadata)).not.toMatch(/Weekly sales report|closed deals/);
      }

      // D-12: the fired run's turn is unattended: every sandbox tool, never a browser tool, 40 sandbox calls.
      const turn = await turnRow(ev.eventId);
      for (const tools of [turn.tools as string[], ev.turn.tools as string[]]) {
        expect(tools).toEqual(expect.arrayContaining([...SANDBOX_TOOL_NAMES]));
        expect(tools.filter((t) => (BROWSER_TOOL_NAMES as readonly string[]).includes(t))).toEqual([]);
        expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
      }
      expect(ev.turn.maxSandboxCalls).toBe(MAX_SANDBOX_CALLS_PER_TURN);
    } finally {
      await plugin.stop();
    }
  });

  it("a second tick in the same minute, a retried fire job and two replicas ticking at once leave one run, one anchor and one cell event", async () => {
    const automationId = await createAutomation();
    await makeDue(automationId);
    const now = new Date();
    expect((await tickOnce(core(), now)).fired).toBe(1);
    expect((await tickOnce(core(), now)).fired).toBe(0);
    const [run] = (await runsOf(automationId)) as [Json];
    expect(await drain()).toBe(1);
    // A re-delivered job (at-least-once) for the same run.
    await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
      core().jobs.sendInTx(tx, "automation.fire", { organizationId: s.orgA, runId: run.id }),
    );
    expect(await drain()).toBe(1);
    expect(await runsOf(automationId)).toHaveLength(1);
    expect(await anchorsOf(run.id)).toHaveLength(1);
    expect(await runEvents(run.id)).toHaveLength(1);
    expect((await runRow(run.id)).status).toBe("delivered");

    // Two API instances tick the same due automation concurrently.
    const other = await createAutomation();
    await makeDue(other);
    const both = await Promise.all([tickOnce(core(), now), tickOnce(core(), now)]);
    expect(both[0].fired + both[1].fired).toBe(1);
    expect(await runsOf(other)).toHaveLength(1);
    expect(await drain()).toBe(1);
    const [otherRun] = (await runsOf(other)) as [Json];
    expect(await anchorsOf(otherRun.id)).toHaveLength(1);
    expect(await runEvents(otherRun.id)).toHaveLength(1);
  });

  it("Run now (05) waits for the fire worker: a manual run whose card says Run now", async () => {
    const automationId = await createAutomation();
    const runId = await runNow(automationId);
    expect((await runRow(runId)).status).toBe("queued");
    expect(await drain()).toBe(1);
    const [anchor] = (await anchorsOf(runId)) as [Json];
    const message = await messageOf(salesId, anchor.id);
    expect(message?.body).toBe("Task “Weekly sales report” run now by Víctor Ruiz.");
    const card = message?.card as Json;
    expect(card?.fields).toContainEqual({ label: "Trigger", value: "Run now" });
    const [ev] = (await runEvents(runId)) as [Json];
    expect(ev.automationRun.trigger).toBe("manual");
    expect((await replyTo(ev)).status).toBe(200);
    expect((await runRow(runId)).status).toBe("answered");
  });

  it("with the organization's sandboxes killed the next fired run is still delivered and answered, without sandbox tools (D-12)", async () => {
    await s.setPolicy({ killed: true });
    try {
      const automationId = await createAutomation();
      await makeDue(automationId);
      expect((await tickOnce(core())).fired).toBe(1);
      expect(await drain()).toBe(1);
      const [run] = (await runsOf(automationId)) as [Json];
      expect((await runRow(run.id)).status).toBe("delivered");
      const [ev] = (await runEvents(run.id)) as [Json];
      const tools = (await turnRow(ev.eventId)).tools as string[];
      expect(tools.filter((t) => t.startsWith("ocw_sandbox_"))).toEqual([]);
      expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
      expect((await replyTo(ev)).status).toBe(200);
      expect((await runRow(run.id)).status).toBe("answered");
    } finally {
      await s.setPolicy({ killed: false });
    }
  });
});

// ---------------------------------------------------------------- Task 2: re-decided and budgeted

/** A private channel of Víctor's with these bots as members. */
async function channelWith(name: string, botIds: readonly string[]): Promise<string> {
  const id = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name: `${name}-${randomUUID().slice(0, 6)}`,
        visibility: "private",
      }) as Promise<Res>,
    )
  ).id as string;
  for (const botId of botIds) {
    await ok(
      s.victor.request("POST", `/api/v1/channels/${id}/members`, {
        kind: "agent",
        id: botId,
      }) as Promise<Res>,
    );
  }
  return id;
}

/** A permission rule for one person (removed by the caller). */
async function denyFor(userId: string, permission: string): Promise<string> {
  return (
    await ok(
      s.victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: userId,
        permission,
        effect: "deny",
      }) as Promise<Res>,
    )
  ).id as string;
}

const dropRule = async (id: string) => {
  const res = await s.victor.request("DELETE", `/api/v1/permission-rules/${id}`);
  expect([200, 204]).toContain(res.status);
};

/** Asserts `runId` was skipped for `reason` with nothing posted and nothing delivered, and audited. */
async function expectSkipped(runId: string, reason: string) {
  expect(await runRow(runId)).toMatchObject({ status: "skipped", reason, anchor_message_id: null });
  expect(await anchorsOf(runId)).toEqual([]);
  expect(await runEvents(runId)).toEqual([]);
  const [audit] = (await auditOf("automation.run_skipped", runId)) as [Json];
  expect(audit.metadata).toMatchObject({ runId, reason });
  expect(audit.user_id).toBe(s.victorId);
}

describe("every fire re-decides: skip reasons, budgets (D-07, P-09, T-07.6-09-01)", () => {
  it("Scout removed from the channel → skipped agent_not_member: no card, no event, audited", async () => {
    const channel = await channelWith("deals", [s.scoutId]);
    const automationId = await createAutomation({ target: { kind: "channel", conversationId: channel } });
    const runId = await runNow(automationId);
    await s.su.query(
      "delete from app.conversation_members where conversation_id = $1 and member_kind = 'agent' and member_id = $2",
      [channel, s.scoutId],
    );
    expect(await drain()).toBe(1);
    await expectSkipped(runId, "agent_not_member");
    expect(await runUpdates(s.victorId, runId)).toBeGreaterThanOrEqual(2);
  });

  it("Víctor loses his post rights → target_not_postable; his automation.create denied → run_as_not_allowed", async () => {
    const automationId = await createAutomation();
    const posting = await runNow(automationId);
    const noPost = await denyFor(s.victorId, "channel.post");
    try {
      expect(await drain()).toBe(1);
    } finally {
      await dropRule(noPost);
    }
    await expectSkipped(posting, "target_not_postable");

    const creating = await runNow(automationId);
    const noCreate = await denyFor(s.victorId, "automation.create");
    try {
      expect(await drain()).toBe(1);
    } finally {
      await dropRule(noCreate);
    }
    await expectSkipped(creating, "run_as_not_allowed");
  });

  it("the bot turned off → agent_disabled", async () => {
    const pixel = await s.newBot("Pixel");
    const channel = await channelWith("pixel", [pixel.id]);
    const automationId = await createAutomation({
      agentId: pixel.id,
      target: { kind: "channel", conversationId: channel },
    });
    const runId = await runNow(automationId);
    await s.su.query("update app.agents set status = 'disabled' where id = $1", [pixel.id]);
    expect(await drain()).toBe(1);
    await expectSkipped(runId, "agent_disabled");
  });

  it("max_runs_per_day 2: the third run today → runs_per_day (counted at fire, under the row lock)", async () => {
    const automationId = await createAutomation({ maxRunsPerDay: 2 });
    await runNow(automationId);
    await runNow(automationId);
    expect(await drain()).toBe(2);
    await makeDue(automationId);
    expect((await tickOnce(core())).fired).toBe(1);
    const scheduled = (await runsOf(automationId)).find((r) => r.trigger === "schedule") as Json;
    expect(await drain()).toBe(1);
    await expectSkipped(scheduled.id, "runs_per_day");
  });

  it("the bot's daily limit (from delivery) → the run fails and its card says Failed with the reason", async () => {
    const ledger = await s.newBot("Ledger");
    const channel = await channelWith("ledger", [ledger.id]);
    const automationId = await createAutomation({
      agentId: ledger.id,
      target: { kind: "channel", conversationId: channel },
    });
    await s.su.query(
      `insert into app.agent_usage_daily (organization_id, agent_id, day, turns)
       values ($1, $2, (now() at time zone 'utc')::date, 100000)
       on conflict (organization_id, agent_id, day) do update set turns = 100000`,
      [s.orgA, ledger.id],
    );
    const runId = await runNow(automationId);
    expect(await drain()).toBe(1);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "failed", reason: "agent_daily_limit" });
    expect(await runEvents(runId)).toEqual([]);
    const [anchor] = (await anchorsOf(runId)) as [Json];
    expect(run.anchor_message_id).toBe(anchor.id);
    expect(await cardOf(channel, anchor.id)).toMatchObject({
      status: "failed",
      statusLabel: "Failed",
      notices: [{ tone: "neutral", text: "Ledger's daily limit was reached." }],
    });
    expect((await auditOf("automation.run_failed", runId))[0]?.metadata).toMatchObject({
      reason: "agent_daily_limit",
    });
  });

  it("no answer within 15 minutes → no_reply and its card says so; three in a row → needs attention until resumed", async () => {
    const automationId = await createAutomation();
    const first = await runNow(automationId);
    expect(await drain()).toBe(1);
    expect((await runRow(first)).status).toBe("delivered");
    // Not yet: 14 minutes.
    await tickOnce(core(), new Date(Date.now() + 14 * 60_000));
    expect((await runRow(first)).status).toBe("delivered");
    expect((await tickOnce(core(), new Date(Date.now() + 16 * 60_000))).noReply).toBeGreaterThanOrEqual(1);
    expect(await runRow(first)).toMatchObject({ status: "no_reply", reason: "no_reply" });
    const [anchor] = (await anchorsOf(first)) as [Json];
    expect(await cardOf(salesId, anchor.id)).toMatchObject({
      status: "failed",
      statusLabel: "No reply",
      notices: [{ tone: "neutral", text: "Scout didn't answer within 15 minutes." }],
    });
    expect(await auditOf("automation.run_no_reply", first)).toHaveLength(1);
    expect(await automationRow(automationId)).toMatchObject({ status: "active", consecutive_failures: 1 });

    await runNow(automationId);
    await runNow(automationId);
    expect(await drain()).toBe(2);
    await tickOnce(core(), new Date(Date.now() + 16 * 60_000));
    const row = await automationRow(automationId);
    expect(row).toMatchObject({
      status: "needs_attention",
      paused_reason: "no_reply",
      consecutive_failures: 3,
    });
    expect(row.paused_by).toBeNull();
    const audit = (
      await s.su.query(
        "select metadata from app.audit_events where action = 'automation.needs_attention' and resource_id = $1",
        [automationId],
      )
    ).rows as Json[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ automationId, failures: 3, reason: "no_reply" });
    const announced = (
      await s.su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'automation.updated' and payload->>'automationId' = $2",
        [`user:${s.victorId}`, automationId],
      )
    ).rows[0] as Json;
    expect(announced.n).toBeGreaterThanOrEqual(2); // created, then paused by the breaker
    // No longer due, whatever its next instant says.
    await makeDue(automationId);
    const due = (await s.su.query("select id from app.due_automations(1000, now())")).rows.map((r) => r.id);
    expect(due).not.toContain(automationId);
    expect(
      (await ok(s.victor.request("GET", `/api/v1/automations/${automationId}`) as Promise<Res>)).status,
    ).toBe("needs_attention");

    const resumed = await ok(
      s.victor.request("POST", `/api/v1/automations/${automationId}/resume`) as Promise<Res>,
    );
    expect(resumed).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("a missed instant 5 hours old fires once and moves past now; one 7 hours old is skipped as missed, no catch-up burst", async () => {
    const recent = await createAutomation();
    await makeDue(recent, 5 * 3_600_000);
    const now = new Date();
    expect((await tickOnce(core(), now)).fired).toBe(1);
    expect(await runsOf(recent)).toMatchObject([{ status: "queued", trigger: "schedule" }]);
    expect(new Date((await automationRow(recent)).next_run_at).getTime()).toBeGreaterThan(now.getTime());
    expect(await drain()).toBe(1);
    expect((await tickOnce(core(), now)).fired).toBe(0);

    const old = await createAutomation();
    await makeDue(old, 7 * 3_600_000);
    const tick = await tickOnce(core(), now);
    expect(tick).toMatchObject({ fired: 0, skipped: 1 });
    const runs = await runsOf(old);
    expect(runs).toHaveLength(1);
    await expectSkipped((runs[0] as Json).id, "missed");
    expect(new Date((await automationRow(old)).next_run_at).getTime()).toBeGreaterThan(now.getTime());
    const jobs = (
      await s.su.query(
        "select count(*)::int as n from pgboss.job where name = 'automation.fire' and data->>'runId' = $1",
        [(runs[0] as Json).id],
      )
    ).rows[0] as Json;
    expect(jobs.n).toBe(0);
    expect((await tickOnce(core(), now)).skipped).toBe(0);
  });

  it("a paused automation's queued manual run is skipped as paused when its job runs", async () => {
    const automationId = await createAutomation();
    const runId = await runNow(automationId);
    await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/pause`) as Promise<Res>);
    expect(await drain()).toBe(1);
    await expectSkipped(runId, "paused");
    // A budget skip is not a failure: the breaker's streak is untouched.
    expect((await automationRow(automationId)).consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------- Task 3: every target

const messageRow = async (id: string) =>
  (await s.su.query("select id, conversation_id, thread_id from app.messages where id = $1", [id]))
    .rows[0] as Json;

const cardRow = async (messageId: string) =>
  (
    await s.su.query(
      "select kind, status, status_label, platform_owned from app.message_cards where message_id = $1",
      [messageId],
    )
  ).rows[0] as Json;

/** The run's cell event, answered like the plugin; returns the reply's message row. */
async function answer(runId: string): Promise<Json> {
  const [ev] = (await runEvents(runId)) as [Json];
  const res = await replyTo(ev);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await runRow(runId)).status).toBe("answered");
  return messageRow(res.body?.messageId as string);
}

/** The DMs between `userId` and the bot `agentId`. */
const dmsWith = async (userId: string, agentId: string) =>
  (
    await s.su.query(
      `select c.id from app.conversations c
       where c.kind = 'dm'
         and exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.member_kind = 'user' and m.member_id = $1)
         and exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.member_kind = 'agent' and m.member_id = $2)`,
      [userId, agentId],
    )
  ).rows.map((r) => r.id as string);

describe("every target lands where the UI-SPEC shows it (P-08, R2)", () => {
  it("thread target: the run card is a reply in the chosen thread, and the bot answers in the same thread", async () => {
    const root = (
      await ok(
        s.victor.request("POST", `/api/v1/conversations/${salesId}/messages`, {
          body: "Weekly numbers go in this thread",
        }) as Promise<Res>,
      )
    ).id as string;
    const automationId = await createAutomation({
      target: { kind: "thread", conversationId: salesId, threadRootMessageId: root },
    });
    const runId = await runNow(automationId);
    expect(await drain()).toBe(1);
    const [anchor] = (await anchorsOf(runId)) as [Json];
    expect(anchor).toMatchObject({ conversation_id: salesId, thread_id: root });
    expect(await cardRow(anchor.id)).toMatchObject({
      kind: "automation",
      platform_owned: true,
      status_label: "Running",
    });
    const [ev] = (await runEvents(runId)) as [Json];
    expect(ev.thread.rootMessageId).toBe(root);
    expect(ev.message.id).toBe(anchor.id);
    expect(await answer(runId)).toMatchObject({ conversation_id: salesId, thread_id: root });
    expect(await cardRow(anchor.id)).toMatchObject({ status: "succeeded", status_label: "Done" });
  });

  it("DM target: the run card is a message in Víctor's DM with Scout (created on the first run), the reply flat after it", async () => {
    expect(await dmsWith(s.victorId, s.scoutId)).toEqual([]);
    const automationId = await createAutomation({ target: { kind: "dm" } });
    const runId = await runNow(automationId);
    expect(await drain()).toBe(1);
    const dms = await dmsWith(s.victorId, s.scoutId);
    expect(dms).toHaveLength(1);
    const [anchor] = (await anchorsOf(runId)) as [Json];
    expect(anchor).toMatchObject({ conversation_id: dms[0], thread_id: null });
    expect((await cardOf(dms[0] as string, anchor.id))?.fields).toContainEqual({
      label: "For",
      value: "Víctor Ruiz",
    });
    const [ev] = (await runEvents(runId)) as [Json];
    expect(ev.conversation).toMatchObject({ id: dms[0], kind: "dm" });
    expect(await answer(runId)).toMatchObject({ conversation_id: dms[0], thread_id: null });

    // The next run reuses the same DM.
    const again = await runNow(automationId);
    expect(await drain()).toBe(1);
    expect(await dmsWith(s.victorId, s.scoutId)).toEqual(dms);
    expect(((await anchorsOf(again)) as [Json])[0].conversation_id).toBe(dms[0]);
  });

  it("Víctor's personal bot works the same: its runs land in his DM with it", async () => {
    const personal = (await ok(s.victor.request("POST", "/api/v1/agents/personal", {}) as Promise<Res>)).agent
      .id as string;
    const automationId = await createAutomation({ agentId: personal, target: { kind: "dm" } });
    const runId = await runNow(automationId);
    expect(await drain()).toBe(1);
    const dms = await dmsWith(s.victorId, personal);
    expect(dms).toHaveLength(1);
    const [anchor] = (await anchorsOf(runId)) as [Json];
    expect(anchor).toMatchObject({ conversation_id: dms[0], thread_id: null });
    const [ev] = (await runEvents(runId)) as [Json];
    expect(ev.agent.id).toBe(personal);
    expect(await answer(runId)).toMatchObject({ conversation_id: dms[0], thread_id: null });
  });

  it("board target: a card “Weekly sales report · {date}” in Intake by Scout for Víctor, the run card its first reply, Scout's turn in its thread", async () => {
    const orders = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: "orders",
          visibility: "private",
          layout: "board",
        }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${orders}/members`, {
        kind: "agent",
        id: s.scoutId,
      }) as Promise<Res>,
    );
    const columnRes = await s.victor.request("POST", `/api/v1/boards/${orders}/columns`, {
      name: "Intake",
      category: "backlog",
    });
    expect([200, 201], JSON.stringify(columnRes.body)).toContain(columnRes.status);
    const columns = (await ok(s.victor.request("GET", `/api/v1/boards/${orders}`) as Promise<Res>))
      .columns as Json[];
    const intake = columns.find((c) => c.name === "Intake")?.id as string;
    expect(intake).toBeTruthy();
    const automationId = await createAutomation({
      target: { kind: "board", conversationId: orders, columnId: intake },
    });
    await makeDue(automationId);
    expect((await tickOnce(core())).fired).toBe(1);
    expect(await drain()).toBe(1);
    const [run] = (await runsOf(automationId)) as [Json];
    const cardMessageId = run.board_card_message_id as string;
    expect(cardMessageId).toBeTruthy();
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      month: "short",
      day: "numeric",
    }).format(new Date(run.scheduled_for));
    const boardCard = (
      await s.su.query("select column_id, title, title_source from app.board_cards where message_id = $1", [
        cardMessageId,
      ])
    ).rows[0] as Json;
    expect(boardCard).toMatchObject({
      column_id: intake,
      title: `Weekly sales report · ${date}`,
      title_source: "user",
    });
    const root = (
      await s.su.query("select author_kind, author_id, thread_id from app.messages where id = $1", [
        cardMessageId,
      ])
    ).rows[0] as Json;
    expect(root).toMatchObject({ author_kind: "agent", author_id: s.scoutId, thread_id: null });
    const created = (
      await s.su.query(
        "select actor_kind, actor_id, user_id, metadata from app.audit_events where action = 'board.card.created' and resource_id = $1",
        [cardMessageId],
      )
    ).rows as Json[];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_kind: "agent", actor_id: s.scoutId, user_id: s.victorId });
    const upserted = (
      await s.su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'board.card_upserted' and payload->'card'->>'messageId' = $2",
        [`conv:${orders}`, cardMessageId],
      )
    ).rows[0] as Json;
    expect(upserted.n).toBeGreaterThanOrEqual(1);

    // The run card is the card's first reply, and Scout's turn is in that card's thread.
    const [anchor] = (await anchorsOf(run.id)) as [Json];
    expect(anchor).toMatchObject({ conversation_id: orders, thread_id: cardMessageId });
    const first = (
      await s.su.query("select id from app.messages where thread_id = $1 order by created_at, id limit 1", [
        cardMessageId,
      ])
    ).rows[0] as Json;
    expect(first.id).toBe(anchor.id);
    expect(await cardRow(anchor.id)).toMatchObject({ kind: "automation", platform_owned: true });
    const [ev] = (await runEvents(run.id)) as [Json];
    expect(ev.thread.rootMessageId).toBe(cardMessageId);
    expect(await answer(run.id)).toMatchObject({ conversation_id: orders, thread_id: cardMessageId });

    // A retried job files no second card.
    await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
      core().jobs.sendInTx(tx, "automation.fire", { organizationId: s.orgA, runId: run.id }),
    );
    expect(await drain()).toBe(1);
    const cards = (
      await s.su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [orders])
    ).rows[0] as Json;
    expect(cards.n).toBe(1);

    // The column gone since the automation was saved (the FK forbids it; forced here) → skipped, nothing filed.
    await s.su.query("set session_replication_role = replica");
    try {
      await s.su.query("delete from app.board_columns where id = $1", [intake]);
    } finally {
      await s.su.query("set session_replication_role = origin");
    }
    const runId = await runNow(automationId);
    expect(await drain()).toBe(1);
    await expectSkipped(runId, "target_not_postable");
    expect(
      (
        (
          await s.su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [
            orders,
          ])
        ).rows[0] as Json
      ).n,
    ).toBe(1);
  });
});
