import { randomUUID } from "node:crypto";
import type { AgentAutomationRunInbound, AutomationRunTrigger } from "@ocw/contracts";
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
import { createPermissionService, type PermissionService } from "../organization";
import { type DeliverAutomationRunResult, deliverAutomationRun } from "./automation-runs";

/**
 * 07.6-06 (AUTO-01, AUTO-02; D-02, D-03, D-07, D-08, D-12; P-03, P-08, P-11, P-12, P-22): the proactive-delivery
 * primitive. An automation run becomes a cell turn bound to its anchor (a platform-owned run card) and to its run-as
 * person; outside content makes the turn read-only, now and in every later turn of its thread; the cell's reply to the
 * anchor is accepted only while that person still reads the conversation and the automation exists; the run turn is
 * unattended (sandbox tools within 07.8's limits, never a browser). Real PostgreSQL + Redis, the in-memory sandboxd.
 */

let s: SandboxStack;
let perms: PermissionService;
let salesId: string;
const ORDER = "Every Friday, summarise this week's closed deals for the team.";

const core = () => s.stack.built.core;
const asPerson = <T>(userId: string, fn: Parameters<ReturnType<typeof core>["db"]["withTenant"]>[1]) =>
  core().db.withTenant({ organizationId: s.orgA, userId }, fn) as Promise<T>;

/** An automation row as 05's create route would store it (run-as = creator, D-07). */
async function newAutomation(
  p: {
    name?: string;
    runAs?: string;
    agentId?: string;
    trigger?: "schedule" | "webhook" | "mail";
    conversationId?: string | null;
    targetKind?: "channel" | "dm";
  } = {},
): Promise<string> {
  const trigger = p.trigger ?? "schedule";
  const runAs = p.runAs ?? s.victorId;
  const targetKind = p.targetKind ?? "channel";
  const row = await s.su.query(
    `insert into app.automations (organization_id, name, agent_id, run_as_user_id, created_by, instructions,
       trigger_kind, schedule_cron, time_zone, target_kind, conversation_id, inbound_action)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      s.orgA,
      p.name ?? "Weekly sales report",
      p.agentId ?? s.scoutId,
      runAs,
      ORDER,
      trigger,
      trigger === "schedule" ? "0 17 * * 5" : null,
      trigger === "schedule" ? "Europe/Madrid" : null,
      targetKind,
      targetKind === "dm" ? null : (p.conversationId ?? salesId),
      trigger === "schedule" ? null : "post",
    ],
  );
  return row.rows[0].id as string;
}

async function newRun(automationId: string, trigger: AutomationRunTrigger = "schedule"): Promise<string> {
  const row = await s.su.query(
    `insert into app.automation_runs (organization_id, automation_id, trigger, scheduled_for)
     values ($1, $2, $3, $4) returning id`,
    [s.orgA, automationId, trigger, trigger === "schedule" ? new Date().toISOString() : null],
  );
  return row.rows[0].id as string;
}

/** The run card, posted through the bridge as the bot (what 09's `postAnchor` does). */
async function postAnchor(
  runId: string,
  p: { conversationId?: string; threadRootId?: string | null; agentId?: string; runAs?: string } = {},
): Promise<string> {
  const posted = await core().chatAgent.postAgentMessage(
    { organizationId: s.orgA, userId: p.runAs ?? s.victorId },
    {
      agentId: p.agentId ?? s.scoutId,
      conversationId: p.conversationId ?? salesId,
      threadRootId: p.threadRootId ?? null,
      body: "Scheduled task “Weekly sales report” for Víctor Ruiz.",
      idempotencyKey: `run:${runId}`,
      cardPlatformOwned: true,
      card: {
        kind: "automation",
        title: "Weekly sales report",
        summary: "Scheduled task “Weekly sales report” for Víctor Ruiz.",
        status: "running",
        statusLabel: "Running",
        fields: [
          { label: "For", value: "Víctor Ruiz" },
          { label: "Trigger", value: "Scheduled" },
          { label: "Schedule", value: "Fridays at 5:00 PM · Europe/Madrid" },
        ],
        actions: [{ kind: "follow", label: "Follow" }],
      },
    },
  );
  return posted.messageId;
}

interface RunSetup {
  automationId: string;
  runId: string;
  anchorId: string;
  conversationId: string;
}

async function deliver(
  r: RunSetup,
  p: {
    trigger?: AutomationRunTrigger;
    inbound?: AgentAutomationRunInbound | null;
    taintedAtStart?: boolean;
    delivery?: "thread" | "dm";
    threadRootId?: string;
    runAs?: string;
    agentId?: string;
  } = {},
): Promise<DeliverAutomationRunResult> {
  const runAs = p.runAs ?? s.victorId;
  return asPerson(runAs, (tx) =>
    deliverAutomationRun(
      tx,
      { core: core(), perms },
      {
        runId: r.runId,
        agentId: p.agentId ?? s.scoutId,
        runAsUserId: runAs,
        anchorMessageId: r.anchorId,
        conversationId: r.conversationId,
        threadRootId: p.threadRootId ?? r.anchorId,
        delivery: p.delivery ?? "thread",
        automation: { id: r.automationId, name: "Weekly sales report", instructions: ORDER },
        trigger: p.trigger ?? "schedule",
        inbound: p.inbound ?? null,
        taintedAtStart: p.taintedAtStart ?? false,
        timeZone: "Europe/Madrid",
      },
    ),
  );
}

/** A queued run of a fresh automation in #sales, its anchor posted. */
async function scheduledRun(
  p: { trigger?: "schedule" | "webhook" | "mail"; conversationId?: string; runAs?: string } = {},
): Promise<RunSetup> {
  const conversationId = p.conversationId ?? salesId;
  const automationId = await newAutomation({
    trigger: p.trigger ?? "schedule",
    conversationId,
    ...(p.runAs ? { runAs: p.runAs } : {}),
  });
  const runId = await newRun(automationId, p.trigger ?? "schedule");
  const anchorId = await postAnchor(runId, { conversationId, ...(p.runAs ? { runAs: p.runAs } : {}) });
  return { automationId, runId, anchorId, conversationId };
}

const runEvents = async (runId: string) =>
  (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
      [`cell:${s.orgA}`, runId],
    )
  ).rows.map((r) => r.payload as Json);

const runRow = async (runId: string) =>
  (await s.su.query("select * from app.automation_runs where id = $1", [runId])).rows[0] as Json;

const turnRow = async (eventId: string) =>
  (await s.su.query("select * from app.agent_turns where event_id = $1", [eventId])).rows[0] as Json;

const cardOf = async (as: SandboxStack["victor"], conversationId: string, messageId: string) => {
  const list = (
    await ok(as.request("GET", `/api/v1/conversations/${conversationId}/messages`) as Promise<Res>)
  ).messages as Json[];
  return list.find((m) => m.id === messageId)?.card as Json | undefined;
};

const auditOf = async (action: string, runId: string) =>
  (
    await s.su.query(
      "select agent_id, user_id, result, metadata from app.audit_events where action = $1 and metadata->>'runId' = $2",
      [action, runId],
    )
  ).rows as Json[];

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

beforeAll(async () => {
  s = await startSandboxStack();
  perms = createPermissionService(core());
  await s.setPolicy({ enabled: true });
  await s.su.query("update app.sandbox_policies set max_browsers = 50 where organization_id = $1", [s.orgA]);
  await s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
    [s.scoutId],
  );
  // #sales: private, so leaving it takes a person's read access with them.
  salesId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "sales", visibility: "private" }) as Promise<Res>,
    )
  ).id as string;
  await ok(
    s.victor.request("POST", `/api/v1/channels/${salesId}/members`, {
      kind: "agent",
      id: s.scoutId,
    }) as Promise<Res>,
  );
  await ok(
    s.victor.request("POST", `/api/v1/channels/${salesId}/members`, {
      kind: "user",
      id: s.samId,
    }) as Promise<Res>,
  );
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("an anchor in #sales becomes a turn for Víctor that Scout answers in its thread (tracer)", () => {
  it("anchor → deliverAutomationRun → agent_turns → cell event → fake cell reply → run answered", async () => {
    const plugin = new FakeCellPlugin({
      apiUrl: s.stack.baseUrl,
      token: SANDBOX_CELL_TOKEN,
      autoReply: true,
    });
    await plugin.start();
    try {
      const r = await scheduledRun();
      // The platform card keeps the server's pill word.
      const card = await cardOf(s.victor, salesId, r.anchorId);
      expect(card).toMatchObject({ kind: "automation", platformOwned: true, statusLabel: "Running" });

      const out = await deliver(r);
      expect(out.delivered).toBe(true);
      const eventId = (out as { eventId: string }).eventId;

      const events = await runEvents(r.runId);
      expect(events).toHaveLength(1);
      const ev = events[0] as Json;
      expect(ev.eventId).toBe(eventId);
      expect(ev.message).toMatchObject({
        id: r.anchorId,
        text: "Scheduled task “Weekly sales report” for Víctor Ruiz.",
        author: { kind: "user", id: s.victorId, displayName: "Víctor Ruiz" },
      });
      expect(ev.thread.rootMessageId).toBe(r.anchorId);
      expect(ev.agent.id).toBe(s.scoutId);
      expect(ev.automationRun).toEqual({
        automationId: r.automationId,
        runId: r.runId,
        name: "Weekly sales report",
        trigger: "schedule",
        instructions: ORDER,
        inbound: null,
      });
      // The standing order never travels as the message or the history.
      expect(JSON.stringify(ev.threadHistory)).not.toContain(ORDER);
      expect(ev.turn.now?.timeZone).toBe("Europe/Madrid");

      expect(await turnRow(eventId)).toMatchObject({
        agent_id: s.scoutId,
        user_id: s.victorId,
        conversation_id: salesId,
        message_id: r.anchorId,
        tainted: false,
      });
      const run = await runRow(r.runId);
      expect(run).toMatchObject({
        status: "delivered",
        agent_event_id: eventId,
        anchor_message_id: r.anchorId,
      });
      expect(run.delivered_at).not.toBeNull();
      expect(await auditOf("automation.run_delivered", r.runId)).toEqual([
        expect.objectContaining({
          agent_id: s.scoutId,
          user_id: s.victorId,
          metadata: expect.objectContaining({ automationId: r.automationId, tainted: false, eventId }),
        }),
      ]);

      // The fake cell answers the run on its anchor; the reply lands in the anchor's thread and answers the run.
      await plugin.waitUntil(() => plugin.replies.some((x) => x.mention.eventId === eventId));
      const reply = plugin.replies.find((x) => x.mention.eventId === eventId);
      expect(reply?.created).toBe(true);
      const replyRow = (
        await s.su.query("select thread_id, author_kind, author_id from app.messages where id = $1", [
          reply?.messageId,
        ])
      ).rows[0];
      expect(replyRow).toEqual({ thread_id: r.anchorId, author_kind: "agent", author_id: s.scoutId });
      const answered = await runRow(r.runId);
      expect(answered.status).toBe("answered");
      expect(answered.answered_at).not.toBeNull();
      expect(await cardOf(s.victor, salesId, r.anchorId)).toMatchObject({
        status: "succeeded",
        statusLabel: "Done",
        version: 2,
      });
      const updates = (
        await s.su.query("select payload from app.stream_events where stream_id = $1 and type = $2", [
          `user:${s.victorId}`,
          "automation_run.updated",
        ])
      ).rows.filter((x) => x.payload.runId === r.runId);
      expect(updates.map((x) => x.payload)).toEqual([
        { automationId: r.automationId, runId: r.runId },
        { automationId: r.automationId, runId: r.runId },
      ]);
      expect(await auditOf("automation.run_answered", r.runId)).toHaveLength(1);
    } finally {
      await plugin.stop();
    }
  });

  it("delivering the same run twice appends one event (conditional on queued) and returns the same event id", async () => {
    const r = await scheduledRun();
    const first = await deliver(r);
    const second = await deliver(r);
    expect(first.delivered).toBe(true);
    expect(second).toEqual(first);
    expect(await runEvents(r.runId)).toHaveLength(1);
    expect(
      (await s.su.query("select count(*)::int as n from app.agent_turns where message_id = $1", [r.anchorId]))
        .rows[0].n,
    ).toBe(1);
  });

  it("the first accepted reply answers the run; a second reply leaves it answered and the card at version 2", async () => {
    const r = await scheduledRun();
    const out = await deliver(r);
    const [ev] = await runEvents(r.runId);
    expect(out.delivered).toBe(true);
    expect((await replyTo(ev as Json)).status).toBe(200);
    expect((await replyTo(ev as Json, "And one more thing.")).status).toBe(200);
    expect((await runRow(r.runId)).status).toBe("answered");
    expect((await cardOf(s.victor, salesId, r.anchorId))?.version).toBe(2);
    expect(await auditOf("automation.run_answered", r.runId)).toHaveLength(1);
  });
});
