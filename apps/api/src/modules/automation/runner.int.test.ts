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

async function fails(res: Promise<Res> | Res, status: number, code?: string): Promise<Json> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body?.error?.code, JSON.stringify(r.body)).toBe(code);
  return (r.body ?? {}) as Json;
}
void fails;

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
