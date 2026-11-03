import { randomUUID } from "node:crypto";
import { isApprovableTool } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "../../testing-device";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { createPermissionService, type PermissionService } from "../organization";
import { deliverAutomationRun } from "./automation-runs";

/**
 * 07.7-04 Task 3 (A2A-03; D-03, D-04, D-09, D-10, D-12, D-13; P-10, P-11, P-13): the loop guards and races at the
 * route, the daily limit, taint, the 07.5 pin, automation runs, unattended hop turns, and the regressions that keep a
 * bot's typed `@handle` inert and reply-mode bots deaf to bots. Real PostgreSQL + Redis and the in-memory sandboxd (so
 * hop turns can be compared with a direct mention for sandbox and browser tools). Víctor Ruiz (admin) asks the team bots
 * Archie, Bea, Carl and Dana in #ops; Rex answers every message in #floor.
 */

let s: SandboxStack;
let perms: PermissionService;
let archieId: string;
let beaId: string;
let carlId: string;
let danaId: string;
let rexId: string;
let opsId: string;
let floorId: string;
let quietId: string;
const handles = new Map<string, string>();

const core = () => s.stack.built.core;
const rows = async (sql: string, args: unknown[] = []) => (await s.su.query(sql, args)).rows as Json[];

const consult = (ev: Json, over: Json = {}) =>
  s.cell("/consultations", {
    eventId: ev.eventId,
    agentId: ev.agent.id,
    target: beaId,
    question: "Is the pump order confirmed?",
    idempotencyKey: `${ev.eventId}:consult:0`,
    ...over,
  }) as Promise<Res & { body: Json }>;

/** Every `agent.mention.v1` for one message, optionally for one bot. */
const deliveries = (messageId: string, agentId?: string) =>
  rows(
    `select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'
       and payload->'message'->>'id' = $2 and ($3::text is null or payload->'agent'->>'id' = $3) order by seq`,
    [`cell:${s.orgA}`, messageId, agentId ?? null],
  ).then((r) => r.map((x) => x.payload as Json));

/** Víctor mentions `botId` in `conversationId` (a new root unless `threadRootId`); the bot's delivered event. */
async function turnOf(
  p: {
    botId?: string;
    conversationId?: string;
    threadRootId?: string;
    text?: string;
    clearUsage?: boolean;
  } = {},
): Promise<Json> {
  if (p.clearUsage !== false) await s.su.query("delete from app.agent_usage_daily");
  const botId = p.botId ?? archieId;
  const msg = await ok(
    s.victor.request("POST", `/api/v1/conversations/${p.conversationId ?? opsId}/messages`, {
      body: `@${handles.get(botId)} ${p.text ?? `please check the pump order ${randomUUID().slice(0, 6)}`}`,
      mentions: [{ kind: "agent", id: botId }],
      ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
    }) as Promise<Res>,
  );
  const [ev] = await deliveries(msg.id as string, botId);
  if (!ev) throw new Error(`no delivery for ${botId}`);
  return ev;
}

/** The consulted bot's turn on a question message. */
async function hopTurn(questionMessageId: string, botId: string): Promise<Json> {
  const [ev] = await deliveries(questionMessageId, botId);
  if (!ev) throw new Error(`no hop turn for ${botId}`);
  return ev;
}

async function expectGuard(r: Res & { body: Json }, status: number, code: string, eventId: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body).toMatchObject({ ok: false, code });
  const calls = await rows(
    "select decision, reason from app.agent_tool_calls where event_id = $1 order by created_at",
    [eventId],
  );
  expect(calls.at(-1)).toEqual({ decision: "denied", reason: code });
}

const audits = async (action: string) =>
  rows(
    "select actor_kind, actor_id, user_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at, id",
    [action, s.orgA],
  );

const turnsToday = async (agentId: string) =>
  Number(
    (
      await s.su.query(
        "select coalesce(sum(turns), 0)::int as n from app.agent_usage_daily where agent_id = $1 and day = (now() at time zone 'utc')::date",
        [agentId],
      )
    ).rows[0].n,
  );

async function teamBot(name: string): Promise<string> {
  const { id } = await s.newBot(name);
  handles.set(id, name.toLowerCase());
  await s.su.query("update app.agents set status = 'ready' where id = $1", [id]);
  return id;
}

async function channel(name: string, botIds: string[]): Promise<string> {
  const id = (await ok(s.victor.request("POST", "/api/v1/channels", { name }) as Promise<Res>)).id as string;
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

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
  perms = createPermissionService(core());
  archieId = await teamBot("Archie");
  beaId = await teamBot("Bea");
  carlId = await teamBot("Carl");
  danaId = await teamBot("Dana");
  rexId = await teamBot("Rex");
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${rexId}/capabilities`, { replyMode: "all" }) as Promise<Res>,
  );
  opsId = await channel("ops", [archieId, beaId, carlId, danaId]);
  floorId = await channel("floor", [archieId, beaId, rexId]);
  quietId = await channel("quiet", [archieId, beaId]);
  // The organization switch "Bots may consult each other".
  await ok(
    s.victor.request("POST", "/api/v1/permission-rules", {
      subjectKind: "everyone",
      subjectId: null,
      permission: "agent.message",
      effect: "allow",
    }) as Promise<Res>,
  );
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("loop guards (D-03, D-04): each refusal is 409 with its code and posts nothing", () => {
  let root: Json;
  let first: Json;
  let bea: Json;
  let toCarl: Json;

  it("Archie → Archie is target_is_self", async () => {
    root = await turnOf();
    await expectGuard(
      await consult(root, { target: archieId, idempotencyKey: "self" }),
      409,
      "target_is_self",
      root.eventId,
    );
  });

  it("Bea at depth 1 → Archie (the root) is target_in_chain", async () => {
    const r = await consult(root);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    first = r.body;
    bea = await hopTurn(first.questionMessageId, beaId);
    expect(bea.turn.consult).toMatchObject({ chainId: first.chainId, depth: 1 });
    expect((bea.turn.consult.targets as Json[]).map((t) => t.id).sort()).toEqual([carlId, danaId].sort());
    await expectGuard(await consult(bea, { target: archieId }), 409, "target_in_chain", bea.eventId);
  });

  it("Bea (depth 1) → Carl opens depth 2 and pushes the Archie → Bea deadline past Carl's plus the grace", async () => {
    const r = await consult(bea, { target: carlId, idempotencyKey: `${bea.eventId}:consult:1` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    toCarl = r.body;
    expect(toCarl.chainId).toBe(first.chainId);
    const [parent] = await rows("select deadline_at from app.agent_chain_hops where id = $1", [first.hopId]);
    const [child] = await rows(
      "select depth, parent_hop_id, source_agent_id, deadline_at from app.agent_chain_hops where id = $1",
      [toCarl.hopId],
    );
    expect(child).toMatchObject({ depth: 2, parent_hop_id: first.hopId, source_agent_id: beaId });
    expect(parent!.deadline_at.getTime()).toBeGreaterThanOrEqual(child!.deadline_at.getTime() + 120_000 - 1);
    expect((await rows("select hops_used from app.agent_chains where id = $1", [first.chainId]))[0]).toEqual({
      hops_used: 2,
    });
  });

  it("Carl's depth-2 turn has no consult tool: forced → 403 not_in_turn; with the tool forced in SQL → 409 depth_exceeded", async () => {
    const carl = await hopTurn(toCarl.questionMessageId, carlId);
    expect(carl.origin).toMatchObject({ depth: 2, agent: { id: beaId } });
    expect(carl.turn.tools).not.toContain("ocw_consult_agent");
    expect(carl.turn.consult).toBeUndefined();
    const [carlRow] = await rows(
      "select chain_depth, answering_hop_id from app.agent_turns where event_id = $1",
      [carl.eventId],
    );
    expect(carlRow).toEqual({ chain_depth: 2, answering_hop_id: toCarl.hopId });
    await expectGuard(await consult(carl, { target: danaId }), 403, "not_in_turn", carl.eventId);
    await s.su.query(
      "update app.agent_turns set tools = array_append(tools, 'ocw_consult_agent') where event_id = $1",
      [carl.eventId],
    );
    await expectGuard(
      await consult(carl, { target: danaId, idempotencyKey: "forced" }),
      409,
      "depth_exceeded",
      carl.eventId,
    );
  });

  it("after Archie → Bea is answered, Archie asking Bea again in the chain is target_in_chain", async () => {
    await s.su.query("update app.agent_chain_hops set status = 'answered', closed_at = now() where id = $1", [
      first.hopId,
    ]);
    await expectGuard(
      await consult(root, { idempotencyKey: `${root.eventId}:consult:2` }),
      409,
      "target_in_chain",
      root.eventId,
    );
  });

  it("with the budget spent (hops_used = 3) Archie → Dana is budget_exhausted", async () => {
    await s.su.query("update app.agent_chains set hops_used = 3 where id = $1", [first.chainId]);
    await expectGuard(
      await consult(root, { target: danaId, idempotencyKey: `${root.eventId}:consult:3` }),
      409,
      "budget_exhausted",
      root.eventId,
    );
  });

  it("a second question while one is pending is consult_pending; a ninth call of a turn is cap_reached", async () => {
    const ev = await turnOf();
    expect((await consult(ev)).status).toBe(200);
    await expectGuard(
      await consult(ev, { target: carlId, idempotencyKey: `${ev.eventId}:consult:1` }),
      409,
      "consult_pending",
      ev.eventId,
    );
    const capped = await turnOf();
    await s.su.query("update app.agent_turns set tool_calls = 8 where event_id = $1", [capped.eventId]);
    await expectGuard(await consult(capped), 409, "cap_reached", capped.eventId);
    expect(await rows("select id from app.agent_chains where root_event_id = $1", [capped.eventId])).toEqual(
      [],
    );
  });
});

describe("races (D-04): concurrent requests never break a guard", () => {
  it("one turn asking Bea and Carl at once: exactly one question, one hop, and one consult_pending recorded", async () => {
    const ev = await turnOf();
    const [a, b] = await Promise.all([
      consult(ev, { idempotencyKey: `${ev.eventId}:consult:0` }),
      consult(ev, { target: carlId, idempotencyKey: `${ev.eventId}:consult:1` }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body).toMatchObject({ code: "consult_pending" });
    expect(
      await rows("select id from app.agent_chain_hops where source_event_id = $1", [ev.eventId]),
    ).toHaveLength(1);
    expect(
      await rows("select id from app.messages where client_message_id like $1", [`consult:${ev.eventId}%`]),
    ).toHaveLength(1);
    const calls = await rows("select decision, reason from app.agent_tool_calls where event_id = $1", [
      ev.eventId,
    ]);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        { decision: "allowed", reason: null },
        { decision: "denied", reason: "consult_pending" },
      ]),
    );
    expect(
      (await rows("select tool_calls from app.agent_turns where event_id = $1", [ev.eventId]))[0],
    ).toEqual({
      tool_calls: 1,
    });
  });

  it("a guard lost after the pre-checks rolls the post back and is recorded by a second, denied claim", async () => {
    const ev = await turnOf();
    const first = await consult(ev);
    expect(first.status).toBe(200);
    await s.su.query("update app.agent_chain_hops set status = 'answered' where id = $1", [first.body.hopId]);
    // A concurrent writer re-opens the hop and holds it: the pre-checks see no pending question, the insert waits on
    // `agent_chain_hops_one_pending` and fails once the writer commits.
    await s.su.query("begin");
    await s.su.query("update app.agent_chain_hops set status = 'pending' where id = $1", [first.body.hopId]);
    const racing = consult(ev, { target: carlId, idempotencyKey: `${ev.eventId}:consult:1` });
    await new Promise((r) => setTimeout(r, 1_500));
    await s.su.query("commit");
    const r = await racing;
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "consult_pending" });
    expect(
      await rows("select id from app.agent_chain_hops where source_event_id = $1", [ev.eventId]),
    ).toHaveLength(1);
    expect(
      await rows("select id from app.messages where client_message_id = $1", [
        `consult:${ev.eventId}:consult:1`,
      ]),
    ).toEqual([]);
    const denied = (await audits("bot.tool_call")).filter(
      (a) => a.metadata.eventId === ev.eventId && a.result === "denied",
    );
    expect(denied).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "consult_pending", race: true }),
      }),
    ]);
    expect(
      (await rows("select tool_calls from app.agent_turns where event_id = $1", [ev.eventId]))[0],
    ).toEqual({
      tool_calls: 1,
    });
  });

  it("two chains asking the same bot at once both succeed (nothing is shared)", async () => {
    const one = await turnOf();
    const two = await turnOf({ botId: carlId, clearUsage: false });
    const [a, b] = await Promise.all([consult(one), consult(two)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.chainId).not.toBe(b.body.chainId);
  });

  it("the same key twice at once: both 200 with one hop, one question and one Bea turn", async () => {
    const ev = await turnOf();
    const [a, b] = await Promise.all([consult(ev), consult(ev)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.hopId).toBe(b.body.hopId);
    expect(
      await rows("select id from app.agent_chain_hops where source_event_id = $1", [ev.eventId]),
    ).toHaveLength(1);
    expect(
      await rows("select id from app.messages where client_message_id = $1", [
        `consult:${ev.eventId}:consult:0`,
      ]),
    ).toHaveLength(1);
    expect(await deliveries(a.body.questionMessageId, beaId)).toHaveLength(1);
  });
});

describe("the daily limit (D-03): the question stays visible, refused, and the target gets no turn", () => {
  it("Bea at her limit: 200 limit_reached, a refused hop, the notice once, no Bea turn, only Archie metered", async () => {
    const ev = await turnOf({ conversationId: quietId });
    const archieBefore = await turnsToday(archieId);
    await s.su.query(
      `insert into app.agent_usage_daily (organization_id, agent_id, day, turns)
       values ($1, $2, (now() at time zone 'utc')::date, 100)`,
      [s.orgA, beaId],
    );
    const r = await consult(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      ok: false,
      code: "limit_reached",
      hopId: expect.any(String),
      questionMessageId: expect.any(String),
      sentence: "@bea has reached its daily limit and cannot answer today.",
    });
    const q = r.body.questionMessageId as string;
    expect(await deliveries(q, beaId)).toEqual([]);
    expect(
      (
        await rows("select status, refusal_reason from app.agent_chain_hops where id = $1", [r.body.hopId])
      )[0],
    ).toEqual({
      status: "refused",
      refusal_reason: "limit_reached",
    });
    const frames = await rows(
      "select type, payload from app.stream_events where stream_id = $1 and payload->'message'->>'id' = $2 order by seq",
      [`conv:${quietId}`, q],
    );
    expect(frames.map((f) => [f.type, f.payload.message.consult?.status])).toEqual([
      ["message.created", "pending"],
      ["message.updated", "refused"],
    ]);
    // The existing limit notice, once (after commit), in the question's thread.
    const notice = await eventually(async () => {
      const n = await rows("select id from app.messages where author_id = $1 and client_message_id = $2", [
        beaId,
        `limit:${q}`,
      ]);
      return n.length > 0 ? n : undefined;
    });
    expect(notice).toHaveLength(1);
    expect((await audits("agent.consult.refused")).filter((a) => a.metadata.hopId === r.body.hopId)).toEqual([
      expect.objectContaining({
        actor_id: archieId,
        result: "denied",
        metadata: expect.objectContaining({ reason: "limit_reached" }),
      }),
    ]);
    expect(await turnsToday(archieId)).toBe(archieBefore);
    expect(await turnsToday(beaId)).toBe(100);
    // A retry of the key answers the stored refusal.
    expect((await consult(ev)).body).toEqual(r.body);
  });
});

describe("taint (D-09) and 07.5 approvals (D-10)", () => {
  it("a turn that read untrusted output through POST /tool-calls is refused 403 tainted, nothing posted", async () => {
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${archieId}/capabilities`, {
        internet: true,
      }) as Promise<Res>,
    );
    const ev = await turnOf();
    expect(ev.turn.tools).toContain("web_fetch");
    expect(ev.turn.tools).toContain("ocw_consult_agent");
    // The turn reads untrusted content: an untrusted-output tool allowed by the gate taints the turn row.
    const read = await s.cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: archieId,
      tool: "web_fetch",
      params: { url: "https://docs.example.com/pumps" },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ allowed: true });
    expect((await rows("select tainted from app.agent_turns where event_id = $1", [ev.eventId]))[0]).toEqual({
      tainted: true,
    });
    const r = await consult(ev);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      ok: false,
      code: "tainted",
      sentence:
        "I can't consult another bot after reading web or tool content in this turn. Tell Víctor Ruiz to ask again in a new message.",
    });
    const calls = await rows(
      "select tool, decision, reason from app.agent_tool_calls where event_id = $1 and tool = 'ocw_consult_agent'",
      [ev.eventId],
    );
    expect(calls).toEqual([{ tool: "ocw_consult_agent", decision: "denied", reason: "tainted" }]);
    expect(
      await rows("select id from app.agent_chain_hops where source_event_id = $1", [ev.eventId]),
    ).toEqual([]);
  });

  it("no approval policy can name ocw_consult_agent; Always-ask on every other tool never gates a consult", async () => {
    const refused = (await s.victor.request("POST", "/api/v1/tool-approval-policies", {
      scopeUnitId: null,
      toolPattern: "ocw_consult_agent",
      mode: "always",
      approverKind: "requester",
    })) as Res;
    expect(refused.status).toBe(400);
    expect((refused.body as Json).error.code).toBe("tool_not_approvable");

    const probe = await turnOf();
    const approvable = (probe.turn.tools as string[]).filter((t) => isApprovableTool(t));
    expect(approvable.length).toBeGreaterThan(0);
    for (const tool of approvable) {
      await ok(
        s.victor.request("POST", "/api/v1/tool-approval-policies", {
          scopeUnitId: null,
          toolPattern: tool,
          mode: "always",
          approverKind: "requester",
        }) as Promise<Res>,
        201,
      );
    }
    const before = (await rows("select count(*)::int as n from app.approval_requests"))[0]!.n as number;
    const ev = await turnOf();
    expect(ev.turn.toolFlags.ocw_consult_agent.approval).toBeUndefined();
    const r = await consult(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rows("select count(*)::int as n from app.approval_requests"))[0]!.n).toBe(before);
    await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
  });
});

describe("automation runs (D-12): consults under every chain rule, never from a tainted or DM run", () => {
  const automation = async (target: Json) =>
    (
      await ok(
        s.victor.request("POST", "/api/v1/automations", {
          name: `Pump report ${randomUUID().slice(0, 4)}`,
          agentId: archieId,
          instructions: "Check the pump orders with the team.",
          trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
          target,
          maxRunsPerDay: 24,
        }) as Promise<Res>,
        201,
      )
    ).automation.id as string;

  const runEvent = async (automationId: string) => {
    await s.su.query("delete from app.agent_usage_daily");
    await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/run`) as Promise<Res>, 202);
    await core().jobs.drain("automation.fire");
    const [ev] = await rows(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'automationId' = $2",
      [`cell:${s.orgA}`, automationId],
    );
    if (!ev) throw new Error("no run delivered");
    return ev.payload as Json;
  };

  it("a Run-now run in #ops is offered the tool; its consult opens a chain for the run-as person; the run stays delivered", async () => {
    const id = await automation({ kind: "channel", conversationId: opsId });
    const ev = await runEvent(id);
    expect(ev.turn.tools).toContain("ocw_consult_agent");
    const r = await consult(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [chain] = await rows(
      "select root_event_id, human_user_id, root_agent_id from app.agent_chains where id = $1",
      [r.body.chainId],
    );
    expect(chain).toEqual({ root_event_id: ev.eventId, human_user_id: s.victorId, root_agent_id: archieId });
    const [run] = await rows("select status from app.automation_runs where id = $1", [
      ev.automationRun.runId,
    ]);
    expect(run).toEqual({ status: "delivered" });
  });

  it("a run delivered to a DM is never offered the tool", async () => {
    const id = await automation({ kind: "dm" });
    const ev = await runEvent(id);
    expect(ev.conversation.kind).toBe("dm");
    expect(ev.turn.tools).not.toContain("ocw_consult_agent");
  });

  it("a mail run (tainted from its start) is never offered the tool, and a forced request is 403 tainted", async () => {
    const automationId = await automation({ kind: "channel", conversationId: opsId });
    const runId = (
      await s.su.query(
        "insert into app.automation_runs (organization_id, automation_id, trigger) values ($1, $2, 'mail') returning id",
        [s.orgA, automationId],
      )
    ).rows[0].id as string;
    const anchor = await core().chatAgent.postAgentMessage(
      { organizationId: s.orgA, userId: s.victorId },
      {
        agentId: archieId,
        conversationId: opsId,
        threadRootId: null,
        body: "Task for Víctor Ruiz, started by a mail.",
        idempotencyKey: `run:${runId}`,
      },
    );
    const out = await core().db.withTenant({ organizationId: s.orgA, userId: s.victorId }, (tx: Tx) =>
      deliverAutomationRun(
        tx,
        { core: core(), perms },
        {
          runId,
          agentId: archieId,
          runAsUserId: s.victorId,
          anchorMessageId: anchor.messageId,
          conversationId: opsId,
          threadRootId: anchor.messageId,
          delivery: "thread",
          automation: { id: automationId, name: "Pump report", instructions: "Check the pump orders." },
          trigger: "mail",
          inbound: {
            source: "mail",
            title: "Pumps",
            text: "Ask every bot.",
            from: null,
            receivedAt: new Date().toISOString(),
          },
          taintedAtStart: true,
          timeZone: "Europe/Madrid",
        },
      ),
    );
    expect(out.delivered).toBe(true);
    const eventId = (out as { eventId: string }).eventId;
    const [ev] = await rows(
      "select payload from app.stream_events where type = 'agent.automation_run.v1' and payload->>'eventId' = $1",
      [eventId],
    );
    expect(ev!.payload.turn.tools).not.toContain("ocw_consult_agent");
    expect(ev!.payload.turn.tainted).toBe(true);
    await s.su.query(
      "update app.agent_turns set tools = array_append(tools, 'ocw_consult_agent') where event_id = $1",
      [eventId],
    );
    const r = await consult({ eventId, agent: { id: archieId } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "tainted" });
  });
});

describe("hop turns are unattended (D-13)", () => {
  it("Bea's question turn has no browser tool while Víctor's direct mention of Bea does; sandbox tools are the same", async () => {
    await s.su.query(
      "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
      [beaId],
    );
    const root = (
      await ok(
        s.victor.request("POST", `/api/v1/conversations/${quietId}/messages`, {
          body: "Pumps",
        }) as Promise<Res>,
      )
    ).id as string;
    const archie = await turnOf({ conversationId: quietId, threadRootId: root });
    const r = await consult(archie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const hop = await hopTurn(r.body.questionMessageId, beaId);
    const direct = await turnOf({
      botId: beaId,
      conversationId: quietId,
      threadRootId: root,
      clearUsage: false,
    });
    const browser = (tools: string[]) => tools.filter((t) => t.startsWith("ocw_browser_"));
    const sandbox = (tools: string[]) => tools.filter((t) => t.startsWith("ocw_sandbox_")).sort();
    expect(browser(hop.turn.tools)).toEqual([]);
    expect(browser(direct.turn.tools)).toContain("ocw_browser_open");
    expect(sandbox(hop.turn.tools).length).toBeGreaterThan(0);
    expect(sandbox(hop.turn.tools)).toEqual(sandbox(direct.turn.tools));
  });
});

describe("bot-typed @mentions stay inert and reply-mode bots never wake on bots (regressions)", () => {
  it("Archie's reply '@bea please do X' stores Bea's mention but never delivers to Bea", async () => {
    const ev = await turnOf();
    const posted = await ok(
      s.cell("/messages", {
        agentId: archieId,
        conversationId: opsId,
        threadRootMessageId: ev.thread.rootMessageId,
        inReplyToMessageId: ev.message.id,
        eventId: ev.eventId,
        text: "@bea please do X",
        idempotencyKey: `evt:${ev.eventId}`,
      }),
    );
    const [m] = await rows("select mentions from app.messages where id = $1", [posted.messageId]);
    expect(m!.mentions).toEqual([{ kind: "agent", id: beaId }]);
    expect(await deliveries(posted.messageId as string)).toEqual([]);
    expect(
      await rows("select event_id from app.agent_turns where message_id = $1", [posted.messageId]),
    ).toEqual([]);
  });

  it("a question '@bea also ask @carl' delivers to Bea only (Carl's mention stored, not delivered)", async () => {
    const ev = await turnOf();
    const r = await consult(ev, { question: "also ask @carl" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [m] = await rows("select body, mentions from app.messages where id = $1", [
      r.body.questionMessageId,
    ]);
    expect(m!.body).toBe("@bea also ask @carl");
    expect(m!.mentions).toEqual(
      expect.arrayContaining([
        { kind: "agent", id: beaId },
        { kind: "agent", id: carlId },
      ]),
    );
    const delivered = await deliveries(r.body.questionMessageId);
    expect(delivered.map((d) => d.agent.id)).toEqual([beaId]);
  });

  it("Rex (reply mode 'all') gets nothing for Archie's question or Archie's plain reply in #floor", async () => {
    const ev = await turnOf({ conversationId: floorId });
    const r = await consult(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reply = await ok(
      s.cell("/messages", {
        agentId: archieId,
        conversationId: floorId,
        threadRootMessageId: ev.thread.rootMessageId,
        inReplyToMessageId: ev.message.id,
        eventId: ev.eventId,
        text: "Checking with Bea now.",
        idempotencyKey: `evt:${ev.eventId}:1`,
      }),
    );
    expect(await deliveries(r.body.questionMessageId, rexId)).toEqual([]);
    expect(await deliveries(reply.messageId as string, rexId)).toEqual([]);
  });
});
