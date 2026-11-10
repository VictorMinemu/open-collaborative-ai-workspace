import { randomUUID } from "node:crypto";
import {
  AgentAutomationItemEvent,
  AgentChannelEventTypes,
  AgentChannelWorkSessionStartResponse,
  AUTOMATION_ITEM_ATTEMPTS_MAX,
  automationItemSentence,
  type BotWorkZoneProfileInput,
  BUILTIN_TOOLS,
  WORK_SESSION_TOOL_NAMES,
} from "@ocw/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { eventually, FakeDevice } from "../../testing-device";
import {
  codeOf,
  type Json,
  ok,
  type Res,
  SANDBOX_CELL_TOKEN,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  pairDevice,
} from "../../testing-workzone";
import { itemEventId } from "../automation";
import { tickOnce } from "../automation/runner";

/**
 * 07.17-17 (AFO-02, AFO-03, AFO-05; D-04, D-06, D-07, D-09, D-12; PD-09, PD-10, PD-11; E8, E11, E12): every item a
 * fan-out run opened gets its own bot turn in its own thread. The `automation.item` job delivers one
 * `agent.automation_item.v1` per opened root, as the automation's run-as person, tainted from its first call (the item is
 * outside content), unattended, offered the bot's Work Zone tools; skips are recorded with their reason; a retry
 * delivers nothing twice. Real PostgreSQL + Redis + pg-boss through the real runner (Run now, then `automation.fire`),
 * the real open route, and `core.jobs.drain("automation.item")`. Víctor Ruiz owns the automations and is their run-as
 * person; the team bot Atlas runs them on the private board `#fleet` (Backlog, In progress, Done), which Sam and Alex
 * read; Sam and Alex are the Logistics team, the automations' escalation target.
 */

let s: SandboxStack;
let atlas: { id: string; dm: string };
let fleetId: string;
let columns: { backlog: string; started: string; done: string };
let dispatchId: string;
let logisticsId: string;

const core = () => s.stack.built.core;
const QUEUE = "automation.item";
const NAME = "Fleet orders";

const item = (key: string, extra: Json = {}): Json => ({
  externalKey: key,
  title: `Order ${key}`,
  body: `Customer order ${key}: 2 pallets.`,
  ...extra,
});

/** A fan-out automation of Víctor on `target` (default: `#fleet`'s Backlog), run by `agentId` (default Atlas). */
async function createAutomation(extra: Json = {}): Promise<string> {
  return (
    (
      await ok(
        s.victor.request("POST", "/api/v1/automations", {
          name: NAME,
          agentId: atlas.id,
          instructions: "Find the new orders and open one conversation for each.",
          trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
          target: { kind: "board", conversationId: fleetId, columnId: columns.backlog },
          maxRunsPerDay: 24,
          fanOut: { enabled: true, perRun: 10, perDay: 100 },
          escalation: [{ kind: "unit", id: logisticsId }],
          ...extra,
        }) as Promise<Res>,
        201,
      )
    ).automation as Json
  ).id as string;
}

/** Run now, drained: the run's one delivered `agent.automation_run.v1` event (today's usage cleared first). */
async function runTurn(automationId: string, agentId = atlas.id): Promise<{ runId: string; ev: Json }> {
  await s.su.query("delete from app.agent_usage_daily where agent_id = $1", [agentId]);
  const runId = (
    await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/run`) as Promise<Res>, 202)
  ).runId as string;
  expect(await core().jobs.drain("automation.fire")).toBe(1);
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
      [`cell:${s.orgA}`, runId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return { runId, ev: rows[0].payload as Json };
}

/** The run turn opens `items`; returns the opened roots in request order. */
async function openItems(ev: Json, items: Json[], agentId = atlas.id): Promise<string[]> {
  const body = await ok(s.cell("/conversations/open", { eventId: ev.eventId, agentId, items }));
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return (body.results as Json[]).map((r) => r.threadRootMessageId as string);
}

const itemRows = async (automationId: string) =>
  (
    await s.su.query(
      "select * from app.automation_conversations where automation_id = $1 order by created_at, id",
      [automationId],
    )
  ).rows as Json[];

const itemRow = async (itemId: string) =>
  (await s.su.query("select * from app.automation_conversations where id = $1", [itemId])).rows[0] as Json;

/** Every `automation.item` job now (one bot turn each). */
const drainItems = () => core().jobs.drain(QUEUE);

/** Sends one `automation.item` job as a forged or retried producer would (ids only). */
const sendItemJob = (organizationId: string, itemId: string) =>
  core().db.withTenant({ organizationId, userId: null }, (tx) =>
    core().jobs.sendInTx(tx, QUEUE, { organizationId, itemId }),
  );

/** The `agent.automation_item.v1` events of one item on organization A's cell stream. */
const itemEvents = async (itemId: string) =>
  (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = $2 and payload->'automationItem'->>'itemId' = $3 order by seq",
      [`cell:${s.orgA}`, AgentChannelEventTypes.automationItem, itemId],
    )
  ).rows.map((r) => r.payload as Json);

const allItemEvents = async () =>
  Number(
    (
      await s.su.query("select count(*)::int as n from app.stream_events where type = $1", [
        AgentChannelEventTypes.automationItem,
      ])
    ).rows[0].n,
  );

const turnRow = async (eventId: string) =>
  (
    await s.su.query(
      "select user_id, agent_id, conversation_id, message_id, tainted, tools from app.agent_turns where event_id = $1",
      [eventId],
    )
  ).rows[0] as Json | undefined;

const auditsOf = async (action: string, itemId: string) =>
  (
    await s.su.query("select * from app.audit_events where action = $1 and resource_id = $2", [
      action,
      itemId,
    ])
  ).rows as Json[];

/** An automation with `keys` opened by one run, its items drained: the rows (in request order) and their events. */
async function openedAndDelivered(keys: string[], extra: Json = {}) {
  const automationId = await createAutomation(extra);
  const { runId, ev } = await runTurn(automationId);
  const roots = await openItems(
    ev,
    keys.map((k) => item(k)),
  );
  expect(await drainItems()).toBe(keys.length);
  const rows = await itemRows(automationId);
  const events = await Promise.all(rows.map(async (r) => (await itemEvents(r.id as string))[0] as Json));
  return { automationId, runId, roots, rows, events };
}

beforeAll(async () => {
  s = await startSandboxStack({ logLevel: "debug" });
  await s.su.query(
    `insert into app.bot_policies (organization_id, max_automations_per_user) values ($1, 1000)
     on conflict (organization_id) do update set max_automations_per_user = 1000`,
    [s.orgA],
  );
  atlas = await s.newBot("Atlas");
  fleetId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name: "fleet",
        visibility: "private",
        layout: "board",
      }) as Promise<Res>,
    )
  ).id as string;
  dispatchId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name: "dispatch",
        visibility: "private",
      }) as Promise<Res>,
    )
  ).id as string;
  for (const conversationId of [fleetId, dispatchId]) {
    for (const member of [
      { kind: "agent", id: atlas.id },
      { kind: "user", id: s.samId },
      { kind: "user", id: s.alexId },
    ]) {
      await ok(
        s.victor.request("POST", `/api/v1/channels/${conversationId}/members`, member) as Promise<Res>,
      );
    }
  }
  const cols = (await ok(s.victor.request("GET", `/api/v1/boards/${fleetId}`) as Promise<Res>))
    .columns as Json[];
  const byCategory = (c: string) => cols.find((x) => x.category === c)?.id as string;
  columns = { backlog: byCategory("backlog"), started: byCategory("started"), done: byCategory("done") };
  expect(Object.values(columns).every(Boolean)).toBe(true);

  // Ops ⊃ Logistics {Sam, Alex}: the automations' escalation target and the team the bot mentions when done.
  const ops = await ok(
    s.victor.request("POST", "/api/v1/units", {
      kind: "department",
      name: "Ops",
      parentId: null,
    }) as Promise<Res>,
  );
  const logistics = await ok(
    s.victor.request("POST", "/api/v1/units", {
      kind: "team",
      name: "Logistics",
      parentId: ops.id,
    }) as Promise<Res>,
  );
  expect(logistics.handle).toBe("logistics");
  logisticsId = logistics.id as string;
  for (const userId of [s.samId, s.alexId]) {
    await ok(
      s.victor.request("POST", `/api/v1/units/${logisticsId}/members`, {
        userId,
        role: "member",
      }) as Promise<Res>,
    );
  }
}, 240_000);

afterAll(async () => {
  await server?.close().catch(() => {});
  await s?.stop();
});

// ---------------------------------------------------------------- the Work Zone (07.16): a build server and a profile

let server: FakeDevice | undefined;
let serverId: string;
let billingId: string;

/** Atlas's profile on the build server (Víctor, admin, is its sponsor): one session at a time, acting on outside content. */
const profile = (over: Partial<BotWorkZoneProfileInput> = {}): BotWorkZoneProfileInput => ({
  deviceId: serverId,
  runtime: "claude-code",
  projectIds: [billingId],
  defaultModel: "opus",
  allowedModels: ["opus"],
  defaultEffort: "medium",
  allowedEfforts: ["medium", "high"],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 1,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: true,
  ...over,
});

/**
 * Once per file (07.16's setup): Víctor pairs a build server (a `service` host with the isolated-server mark) that
 * reports billing-api and both runtimes, saves Atlas's profile and lets Atlas run sessions on it.
 */
async function setUpWorkZone(): Promise<void> {
  if (server) return;
  await ok(
    s.victor.request("PUT", "/api/v1/work-zone-policy", {
      allowFullAccess: true,
      allowFastMode: true,
    }) as Promise<Res>,
  );
  const paired = await pairDevice(s.stack, s.victor, "build-server");
  serverId = paired.deviceId;
  server = await FakeDevice.connect(s.stack.baseUrl, paired.token, undefined, {
    host: "service",
    isolatedServer: true,
  });
  server.send({
    type: "projects.sync",
    projects: [{ localId: "lp_billing-api", name: "billing-api", gitRemote: null, defaultBranch: "main" }],
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true, true);
  await eventually(async () => {
    const d = (
      await s.su.query("select runtime_catalog, host_kind, isolated_server from app.devices where id = $1", [
        serverId,
      ])
    ).rows[0] as Json;
    return (d.runtime_catalog as unknown[]).length === 2 && d.host_kind === "service" && d.isolated_server;
  });
  const list = (await ok(s.victor.request("GET", "/api/v1/projects") as Promise<Res>)).projects as Json[];
  billingId = list.find((p) => p.name === "billing-api")?.id as string;
  expect(billingId).toBeTruthy();
  await createBotProfile(s.victor, atlas.id, profile());
  await grantBotConsent(s.victor, serverId, atlas.id, { allowFullAccess: true });
}

beforeEach(async () => {
  // No item job of an earlier case is left in the queue (each case drains its own).
  await s.su.query("delete from pgboss.job where name = $1", [QUEUE]);
});

// ---------------------------------------------------------------- Task 1: one tainted turn per opened item

describe("an opened card gets its own tainted turn with the item as outside content (D-04, PD-09)", () => {
  it("two opened orders → two agent.automation_item.v1 events, each in its card's thread, as Víctor, with the item and the escalation", async () => {
    const { automationId, runId, roots, rows, events } = await openedAndDelivered(["1042", "1043"]);
    expect(rows.map((r) => r.root_message_id)).toEqual(roots);

    for (const [i, row] of rows.entries()) {
      const ev = events[i] as Json;
      expect(ev, `item ${i}`).toBeDefined();
      // Both copies of the contract parse it (the plugin's mirror is proven in plugin-contract.test.ts).
      AgentAutomationItemEvent.parse({ ...ev, seq: 1 });
      expect(ev.type).toBe(AgentChannelEventTypes.automationItem);
      expect(ev.eventId).toBe(itemEventId(row.id as string));
      expect(ev.agent.id).toBe(atlas.id);
      expect(ev.conversation).toMatchObject({ id: fleetId, kind: "channel" });
      expect(ev.thread.rootMessageId).toBe(roots[i]);
      expect(ev.message).toMatchObject({
        id: roots[i],
        text: automationItemSentence(NAME),
        author: { kind: "user", id: s.victorId, displayName: "Víctor Ruiz" },
      });
      const card = (
        await s.su.query("select title, description from app.board_cards where message_id = $1", [roots[i]])
      ).rows[0] as Json;
      expect(card.title).toBe(`Order ${["1042", "1043"][i]}`);
      expect(card.description).toContain(`Customer order ${["1042", "1043"][i]}`);
      expect(ev.automationItem).toEqual({
        automationId,
        runId,
        itemId: row.id,
        name: NAME,
        instructions: "Find the new orders and open one conversation for each.",
        item: {
          title: card.title,
          text: card.description,
          openedAt: new Date(row.created_at as string).toISOString(),
        },
        escalation: [{ kind: "unit", id: logisticsId, handle: "logistics", displayName: "Logistics" }],
      });

      // The stored turn: Víctor's, in the card, tainted from its first call, unattended (no browser tools).
      const turn = await turnRow(ev.eventId as string);
      expect(turn).toMatchObject({
        user_id: s.victorId,
        agent_id: atlas.id,
        conversation_id: fleetId,
        message_id: roots[i],
        tainted: true,
      });
      const tools = ev.turn.tools as string[];
      expect(turn?.tools).toEqual(tools);
      expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
      expect(tools).not.toContain(BUILTIN_TOOLS.conversationOpen);
      expect(ev.turn.attachments).toBeUndefined();

      // The row is delivered with the event id; one audit with ids only.
      expect(await itemRow(row.id as string)).toMatchObject({
        status: "delivered",
        reason: null,
        agent_event_id: ev.eventId,
      });
      const delivered = await auditsOf("automation.item_delivered", row.id as string);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ agent_id: atlas.id, user_id: s.victorId, result: "success" });
      expect(delivered[0]?.metadata).toEqual({ automationId, runId, itemId: row.id, eventId: ev.eventId });
    }
    expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
  });

  it("E11: the same job again (a retry, or the payload sent twice) appends nothing and writes nothing", async () => {
    const { rows } = await openedAndDelivered(["2042"]);
    const itemId = rows[0]?.id as string;
    const before = await itemRow(itemId);
    const eventsBefore = await allItemEvents();
    const turnsBefore = Number(
      (await s.su.query("select count(*)::int as n from app.agent_turns where agent_id = $1", [atlas.id]))
        .rows[0].n,
    );
    await sendItemJob(s.orgA, itemId);
    await sendItemJob(s.orgA, itemId);
    expect(await drainItems()).toBe(2);
    expect(await allItemEvents()).toBe(eventsBefore);
    expect(await itemRow(itemId)).toEqual(before);
    expect(
      Number(
        (await s.su.query("select count(*)::int as n from app.agent_turns where agent_id = $1", [atlas.id]))
          .rows[0].n,
      ),
    ).toBe(turnsBefore);
    expect(await auditsOf("automation.item_delivered", itemId)).toHaveLength(1);
  });

  it("a channel target's item text is the root message's body (its bold first line is the title)", async () => {
    const { rows, roots, events } = await openedAndDelivered(["3042"], {
      target: { kind: "channel", conversationId: dispatchId },
    });
    const [root] = (await s.su.query("select body from app.messages where id = $1", [roots[0]]))
      .rows as Json[];
    const ev = events[0] as Json;
    expect(ev.conversation.id).toBe(dispatchId);
    expect(ev.thread.rootMessageId).toBe(roots[0]);
    expect(ev.automationItem.item.text).toBe(root?.body);
    expect(ev.automationItem.item.text).toContain("Customer order 3042");
    expect(ev.automationItem.item.title).toContain("3042");
    expect(ev.automationItem.item.title).not.toContain("**");
    expect((await turnRow(ev.eventId as string))?.tainted).toBe(true);
    expect((await itemRow(rows[0]?.id as string)).status).toBe("delivered");
  });
});

// ---------------------------------------------------------------- Task 2: tools, skips and forged jobs

/** An automation whose run opened one item that is still queued (its job not drained yet). */
async function openedQueued(key: string, extra: Json = {}, agentId = atlas.id) {
  const automationId = await createAutomation({ agentId, ...extra });
  const { runId, ev } = await runTurn(automationId, agentId);
  const [root] = await openItems(ev, [item(key)], agentId);
  const [row] = await itemRows(automationId);
  expect(row).toMatchObject({ status: "queued", root_message_id: root });
  return { automationId, runId, root: root as string, itemId: row?.id as string };
}

/** The item's one job ran and skipped it with `reason`: the row, one audit with ids and the reason, no event. */
async function expectSkipped(o: { automationId: string; runId: string; itemId: string }, reason: string) {
  expect(await drainItems()).toBe(1);
  expect(await itemRow(o.itemId)).toMatchObject({ status: "skipped", reason, agent_event_id: null });
  expect(await itemEvents(o.itemId)).toEqual([]);
  expect(await auditsOf("automation.item_delivered", o.itemId)).toEqual([]);
  const skipped = await auditsOf("automation.item_skipped", o.itemId);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).toMatchObject({ result: "denied", agent_id: expect.any(String) });
  expect(skipped[0]?.metadata).toEqual({
    automationId: o.automationId,
    runId: o.runId,
    itemId: o.itemId,
    reason,
  });
}

describe("the item turn's tools (D-04, D-09, ADR-0039; T-07.17-17-03)", () => {
  beforeAll(async () => {
    await setUpWorkZone();
  }, 120_000);

  it("Atlas with an active profile: the four ocw_work_session_* tools, the board tool and turn.workZone; never the open tool, a browser tool or a consult", async () => {
    const { events } = await openedAndDelivered(["4042"]);
    const ev = events[0] as Json;
    const tools = ev.turn.tools as string[];
    for (const t of WORK_SESSION_TOOL_NAMES) expect(tools).toContain(t);
    expect(BUILTIN_TOOLS.workSessionStart).toBe("ocw_work_session_start");
    expect(tools).toContain("ocw_work_session_start");
    expect(tools).toContain(BUILTIN_TOOLS.boardCard);
    expect(ev.turn.workZone).toBeDefined();
    expect(ev.turn.workZone.projects.map((p: Json) => p.id)).toEqual([billingId]);
    expect(tools).not.toContain(BUILTIN_TOOLS.conversationOpen);
    expect(tools).not.toContain(BUILTIN_TOOLS.consultAgent);
    expect(ev.turn.consult).toBeUndefined();
    expect(tools.filter((t) => t.startsWith("ocw_browser_"))).toEqual([]);
  });

  it("the run turn of the same automation keeps its tools: the open tool, never a Work Zone tool (ADR-0038 §12 for runs)", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    const tools = ev.turn.tools as string[];
    expect(tools).toContain(BUILTIN_TOOLS.conversationOpen);
    for (const t of WORK_SESSION_TOOL_NAMES) expect(tools).not.toContain(t);
    expect(ev.turn.workZone).toBeUndefined();
  });

  it("a bot without a profile: the board tool, no Work Zone tool and no workZone", async () => {
    const nova = await s.newBot("Nova");
    await ok(
      s.victor.request("POST", `/api/v1/channels/${fleetId}/members`, {
        kind: "agent",
        id: nova.id,
      }) as Promise<Res>,
    );
    const o = await openedQueued("4043", {}, nova.id);
    expect(await drainItems()).toBe(1);
    const [ev] = await itemEvents(o.itemId);
    expect(ev?.agent.id).toBe(nova.id);
    const tools = ev?.turn.tools as string[];
    expect(tools).toContain(BUILTIN_TOOLS.boardCard);
    for (const t of WORK_SESSION_TOOL_NAMES) expect(tools).not.toContain(t);
    expect(ev?.turn.workZone).toBeUndefined();
    expect(tools).not.toContain(BUILTIN_TOOLS.conversationOpen);
  });
});

describe("skips with their reasons (E12, PD-09; T-07.17-17-05)", () => {
  it("the automation paused → skipped paused", async () => {
    const o = await openedQueued("5001");
    await s.su.query("update app.automations set status = 'paused' where id = $1", [o.automationId]);
    await expectSkipped(o, "paused");
  });

  it("Atlas disabled → skipped agent_disabled", async () => {
    const o = await openedQueued("5002");
    await s.su.query("update app.agents set status = 'disabled' where id = $1", [atlas.id]);
    try {
      await expectSkipped(o, "agent_disabled");
    } finally {
      await s.su.query("update app.agents set status = 'ready' where id = $1", [atlas.id]);
    }
  });

  it("Atlas no longer a member of #fleet → skipped agent_not_member", async () => {
    const o = await openedQueued("5003");
    await s.su.query(
      "delete from app.conversation_members where conversation_id = $1 and member_kind = 'agent' and member_id = $2",
      [fleetId, atlas.id],
    );
    try {
      await expectSkipped(o, "agent_not_member");
    } finally {
      await ok(
        s.victor.request("POST", `/api/v1/channels/${fleetId}/members`, {
          kind: "agent",
          id: atlas.id,
        }) as Promise<Res>,
      );
    }
  });

  it("the run-as person (Sam) removed from the private board → skipped bot_not_readable", async () => {
    const o = await openedQueued("5004");
    // The automation is Sam's (it always runs as its creator), and Sam then leaves #fleet (written directly: what a
    // membership change leaves behind).
    await s.su.query("update app.automations set run_as_user_id = $2, created_by = $2 where id = $1", [
      o.automationId,
      s.samId,
    ]);
    await s.su.query(
      "delete from app.conversation_members where conversation_id = $1 and member_kind = 'user' and member_id = $2",
      [fleetId, s.samId],
    );
    try {
      await expectSkipped(o, "bot_not_readable");
    } finally {
      await ok(
        s.victor.request("POST", `/api/v1/channels/${fleetId}/members`, {
          kind: "user",
          id: s.samId,
        }) as Promise<Res>,
      );
    }
  });

  it("the card deleted → skipped target_not_postable", async () => {
    const o = await openedQueued("5005");
    await s.su.query("update app.messages set deleted_at = now() where id = $1", [o.root]);
    await expectSkipped(o, "target_not_postable");
  });

  it("WR-02: Atlas at its daily limit → the item waits (agent_daily_limit), with the limit notice; the next local day's tick queues it again as a new turn", async () => {
    const o = await openedQueued("5006");
    // The run turn counted today's first turn; the limit is now reached.
    await s.su.query("update app.agent_usage_daily set turns = 100000 where agent_id = $1", [atlas.id]);
    try {
      expect(await drainItems()).toBe(1);
      expect(await itemRow(o.itemId)).toMatchObject({
        status: "waiting",
        reason: "agent_daily_limit",
        attempt: 0,
        agent_event_id: null,
      });
      expect(await itemEvents(o.itemId)).toEqual([]);
      expect(await auditsOf("automation.item_skipped", o.itemId)).toEqual([]);
      const waited = await auditsOf("automation.item_waiting", o.itemId);
      expect(waited).toHaveLength(1);
      expect(waited[0]?.metadata).toEqual({
        automationId: o.automationId,
        runId: o.runId,
        itemId: o.itemId,
        reason: "agent_daily_limit",
        attempt: 0,
      });
      const limited = (
        await s.su.query(
          "select user_id, metadata from app.audit_events where action = 'agent.limit_reached' and agent_id = $1",
          [atlas.id],
        )
      ).rows.filter((a) => a.metadata.messageId === o.root);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.user_id).toBe(s.victorId);
      const notice = await eventually(async () => {
        const r = (
          await s.su.query(
            "select author_kind, author_id, thread_id from app.messages where client_message_id = $1",
            [`limit:${o.root}`],
          )
        ).rows[0] as Json | undefined;
        return r;
      });
      expect(notice).toEqual({ author_kind: "agent", author_id: atlas.id, thread_id: o.root });

      // Still the same local day: the tick leaves it waiting.
      await tickOnce(core(), new Date());
      expect((await itemRow(o.itemId)).status).toBe("waiting");
    } finally {
      await s.su.query("delete from app.agent_usage_daily where agent_id = $1", [atlas.id]);
    }

    // The automation's next local day: the tick queues it again (attempt 1), and its job delivers a new turn.
    await s.su.query(
      "update app.automation_conversations set updated_at = now() - interval '2 days' where id = $1",
      [o.itemId],
    );
    await tickOnce(core(), new Date());
    expect(await itemRow(o.itemId)).toMatchObject({ status: "queued", reason: null, attempt: 1 });
    expect((await auditsOf("automation.item_requeued", o.itemId))[0]?.metadata).toEqual({
      automationId: o.automationId,
      runId: o.runId,
      itemId: o.itemId,
      reason: "agent_daily_limit",
      attempt: 1,
    });
    expect(await drainItems()).toBe(1);
    const events = await itemEvents(o.itemId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe(itemEventId(o.itemId, 1));
    expect(events[0]?.eventId).not.toBe(itemEventId(o.itemId));
    expect(await itemRow(o.itemId)).toMatchObject({
      status: "delivered",
      agent_event_id: itemEventId(o.itemId, 1),
    });
  });
});

describe("forged and stale jobs (E8; T-07.17-17-01)", () => {
  it("a job naming organization A's item under organization B, or an unknown item, does nothing", async () => {
    const o = await openedQueued("6001");
    const before = await itemRow(o.itemId);
    await s.su.query("delete from pgboss.job where name = $1", [QUEUE]);
    const eventsBefore = await allItemEvents();
    await sendItemJob(s.orgB, o.itemId);
    await sendItemJob(s.orgA, randomUUID());
    expect(await drainItems()).toBe(2);
    expect(await itemRow(o.itemId)).toEqual(before);
    expect(await allItemEvents()).toBe(eventsBefore);
    expect(
      Number(
        (
          await s.su.query("select count(*)::int as n from app.audit_events where resource_id = $1", [
            o.itemId,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  it("a job whose item was deleted (its automation deleted) does nothing", async () => {
    const o = await openedQueued("6002");
    await ok(s.victor.request("DELETE", `/api/v1/automations/${o.automationId}`) as Promise<Res>, 204);
    expect(
      (
        await s.su.query("select count(*)::int as n from app.automation_conversations where id = $1", [
          o.itemId,
        ])
      ).rows[0].n,
    ).toBe(0);
    const eventsBefore = await allItemEvents();
    expect(await drainItems()).toBe(1);
    expect(await allItemEvents()).toBe(eventsBefore);
    expect(await auditsOf("automation.item_skipped", o.itemId)).toEqual([]);
  });

  it("WR-01: a delivery that keeps failing is retried, then its last attempt marks the item failed delivery_failed, audited", async () => {
    const o = await openedQueued("6003");
    // A broken write (a deadlock or a dropped connection in production; a trigger here) on every attempt.
    await s.su.query(`create or replace function app.test_poison_item() returns trigger language plpgsql as $$
      begin
        if new.id = '${o.itemId}'::uuid and new.status = 'delivered' then raise exception 'poison item'; end if;
        return new;
      end $$`);
    await s.su.query(
      "create trigger test_poison_item before update on app.automation_conversations for each row execute function app.test_poison_item()",
    );
    try {
      // Every attempt fails; the earlier ones leave the item queued for the retry (the queue's retries, no backoff
      // here), and only the last one records it.
      const limit = Number(
        (await s.su.query("select retry_limit from pgboss.job where name = $1 limit 1", [QUEUE])).rows[0]
          .retry_limit,
      );
      expect(limit).toBeGreaterThan(0);
      expect(await drainItems()).toBe(limit + 1);
      expect(await itemRow(o.itemId)).toMatchObject({
        status: "failed",
        reason: "delivery_failed",
        agent_event_id: null,
      });
      expect(await itemEvents(o.itemId)).toEqual([]);
      const failed = await auditsOf("automation.item_skipped", o.itemId);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ result: "error", actor_kind: "system" });
      expect(failed[0]?.metadata).toEqual({
        automationId: o.automationId,
        runId: o.runId,
        itemId: o.itemId,
        reason: "delivery_failed",
      });
    } finally {
      await s.su.query("drop trigger if exists test_poison_item on app.automation_conversations");
      await s.su.query("drop function if exists app.test_poison_item()");
    }
  });
});

// ---------------------------------------------------------------- Task 3: the per-order journey at the API

const WAKES = "work_session.bot_sync";

/** A PATCH to the Agent Channel (the sandbox stack's `cell` only posts). */
async function cellPatch(path: string, body: unknown, token = SANDBOX_CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const cardRow = async (messageId: string) =>
  (
    await s.su.query("select column_id, waiting_on, version from app.board_cards where message_id = $1", [
      messageId,
    ])
  ).rows[0] as { column_id: string; waiting_on: string; version: number };

/** The bot's `ocw_board_card` move of `card` to `columnId`, from the turn `eventId`. */
const moveCard = async (eventId: string, card: string, columnId: string, token?: string) =>
  cellPatch(
    `/board/cards/${card}`,
    {
      eventId,
      agentId: atlas.id,
      expectedVersion: (await cardRow(card)).version,
      move: { columnId, afterCardId: null },
    },
    token,
  );

const startFrom = (eventId: string, prompt: string, token?: string) =>
  s.cell(
    "/work-sessions/start",
    { eventId, agentId: atlas.id, projectId: billingId, prompt },
    ...(token ? [token] : []),
  );

const cardAudit = async (action: string, messageId: string) =>
  (
    await s.su.query(
      "select agent_id, user_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at desc limit 1",
      [action, messageId],
    )
  ).rows[0] as Json | undefined;

const statusOf = async (workSessionId: string) =>
  (await s.su.query("select status from app.work_sessions where id = $1", [workSessionId])).rows[0]
    ?.status as string;

/** The device takes a started session: `session.start` acked, the runtime idle, the start's own prompt acked. */
async function deviceTakes(workSessionId: string) {
  const dev = server as FakeDevice;
  const start = await dev.command("session.start", workSessionId);
  dev.ack(start.id);
  dev.event(workSessionId, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${workSessionId}`,
    model: "opus",
    permissionMode: "default",
  });
  dev.event(workSessionId, { type: "session.state", status: "idle" });
  const first = await dev.command("prompt", workSessionId);
  dev.ack(first.id);
  await eventually(async () => (await statusOf(workSessionId)) === "running");
  return first;
}

/** The `agent.work_session.v1` wakes of one session, oldest first. */
const wakesOf = async (workSessionId: string) =>
  (
    await s.su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = $2 and payload->'workSession'->>'workSessionId' = $3 order by seq`,
      [`cell:${s.orgA}`, AgentChannelEventTypes.workSession, workSessionId],
    )
  ).rows.map((r) => r.payload as Json);

describe("the per-order journey: Work Zone session, card moves, wake and team mention (D-06, D-07, D-12, PD-11)", () => {
  beforeAll(async () => {
    await setUpWorkZone();
  }, 120_000);

  beforeEach(async () => {
    // Every session of an earlier case is over (archived directly, so no wake follows); no wake job is left over.
    await s.su.query(
      "update app.work_sessions set status = 'archived' where organization_id = $1 and status <> 'archived'",
      [s.orgA],
    );
    await s.su.query("delete from pgboss.job where name = $1", [WAKES]);
  });

  it("with actOnOutsideContent: 1042's turn starts a tainted session and moves its card to In progress; the wake reads it, moves the card to Done and says Done @logistics", async () => {
    const { roots, rows, events } = await openedAndDelivered(["1042", "1043"]);
    const [ev42, ev43] = events as [Json, Json];
    // Each order is its own turn in its own card's thread.
    expect(ev42.thread.rootMessageId).toBe(roots[0]);
    expect(ev43.thread.rootMessageId).toBe(roots[1]);
    expect(ev42.eventId).not.toBe(ev43.eventId);
    expect(rows.map((r) => r.status)).toEqual(["delivered", "delivered"]);

    // 1042: the start passes on the tainted turn (07.16-19's flag path), the session is tainted from the start.
    const started = await startFrom(ev42.eventId as string, "Prepare the shipment for order 1042");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const body = AgentChannelWorkSessionStartResponse.parse(started.body);
    if (body.kind !== "started") throw new Error(`not started: ${JSON.stringify(body)}`);
    const workSessionId = body.workSessionId;
    const session = (
      await s.su.query(
        "select created_by, started_by_agent_id, tainted_at is not null as tainted from app.work_sessions where id = $1",
        [workSessionId],
      )
    ).rows[0];
    expect(session).toEqual({ created_by: s.victorId, started_by_agent_id: atlas.id, tainted: true });
    const startCall = (
      await s.su.query("select decision from app.agent_tool_calls where event_id = $1 and tool = $2", [
        ev42.eventId,
        BUILTIN_TOOLS.workSessionStart,
      ])
    ).rows[0] as Json;
    expect(startCall.decision).toBe("allowed");
    const first = await deviceTakes(workSessionId);

    // The card moves to a started column from the item turn (08's exemption: the card the bot's automation opened).
    const doing = await moveCard(ev42.eventId as string, roots[0] as string, columns.started);
    expect(doing.status, JSON.stringify(doing.body)).toBe(200);
    expect((await cardRow(roots[0] as string)).column_id).toBe(columns.started);
    expect(await cardAudit("board.card.moved", roots[0] as string)).toMatchObject({
      agent_id: atlas.id,
      user_id: s.victorId,
      metadata: { outsideContent: true, toColumnId: columns.started },
    });

    // 1043 runs on its own: with one session at a time (maxConcurrent 1) its start is refused while 1042's runs.
    const second = await startFrom(ev43.eventId as string, "Prepare the shipment for order 1043");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(AgentChannelWorkSessionStartResponse.parse(second.body)).toMatchObject({
      kind: "refused",
      code: "too_many_sessions",
    });
    expect((await cardRow(roots[1] as string)).column_id).toBe(columns.backlog);
    // WR-02: 1043 waits for a free session (queued again when one ends).
    expect(await itemRow(rows[1]?.id as string)).toMatchObject({
      status: "waiting",
      reason: "session_capacity",
    });

    // The runtime finishes the turn: one wake, in the card's thread, as Víctor, tainted (the session took outside content).
    (server as FakeDevice).emitTurn(workSessionId, {
      promptId: first.payload.promptId as string,
      text: "Shipment prepared.",
    });
    await eventually(async () => (await statusOf(workSessionId)) === "idle");
    await s.su.query(
      "update pgboss.job set start_after = now() where name = $1 and state in ('created', 'retry')",
      [WAKES],
    );
    await core().jobs.drain(WAKES);
    const wakes = await wakesOf(workSessionId);
    expect(wakes).toHaveLength(1);
    const wake = wakes[0] as Json;
    expect(wake.thread.rootMessageId).toBe(roots[0]);
    expect(wake.message.author.id).toBe(s.victorId);
    expect((await turnRow(wake.eventId as string))?.tainted).toBe(true);

    // The wake reads the session (D-20's mark), then moves the card to Done (D-12: the session-output exemption).
    const read = await s.cell("/work-sessions/read", {
      eventId: wake.eventId,
      agentId: atlas.id,
      workSessionId,
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(
      (
        await s.su.query("select session_output_read from app.agent_turns where event_id = $1", [
          wake.eventId,
        ])
      ).rows[0],
    ).toEqual({ session_output_read: true });
    const done = await moveCard(wake.eventId as string, roots[0] as string, columns.done);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await cardRow(roots[0] as string)).column_id).toBe(columns.done);
    expect(await cardAudit("board.card.moved", roots[0] as string)).toMatchObject({
      agent_id: atlas.id,
      metadata: { sessionOutputExempt: true, outsideContent: true, toColumnId: columns.done },
    });

    // "Done @logistics" in the card's thread: Sam and Alex (Logistics, readers of #fleet) get team_mention; no bot wakes.
    const posted = await ok(
      s.cell("/messages", {
        agentId: atlas.id,
        conversationId: fleetId,
        threadRootMessageId: roots[0],
        inReplyToMessageId: wake.message.id,
        eventId: wake.eventId,
        text: "Done @logistics",
        idempotencyKey: randomUUID(),
      }),
    );
    const messageId = posted.messageId as string;
    expect(
      (await s.su.query("select thread_id, mentions from app.messages where id = $1", [messageId])).rows[0],
    ).toEqual({ thread_id: roots[0], mentions: [{ kind: "unit", id: logisticsId }] });
    const notified = (
      await s.su.query(
        "select user_id, kind, unit_id from app.notifications where message_id = $1 order by user_id",
        [messageId],
      )
    ).rows as Json[];
    expect(notified).toEqual(
      [s.samId, s.alexId].sort().map((user_id) => ({ user_id, kind: "team_mention", unit_id: logisticsId })),
    );
    expect(
      (await s.su.query("select count(*)::int as n from app.agent_turns where message_id = $1", [messageId]))
        .rows[0].n,
    ).toBe(0);
  });

  it("WR-02: an item whose start found no free session waits, and is queued again as a new turn when the bot's session ends", async () => {
    // Items an earlier case left waiting would be queued first (oldest first): they are not this case's.
    await s.su.query("update app.automation_conversations set status = 'skipped' where status = 'waiting'");
    const { automationId, rows, events } = await openedAndDelivered(["3042", "3043"]);
    const [ev42, ev43] = events as [Json, Json];
    const item43 = rows[1]?.id as string;
    const started = AgentChannelWorkSessionStartResponse.parse(
      (await startFrom(ev42.eventId as string, "Prepare the shipment for order 3042")).body,
    );
    if (started.kind !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
    const workSessionId = started.workSessionId;
    await deviceTakes(workSessionId);

    // 3043's start finds the only session busy: the bot hears why, and the item waits for a free one.
    const refused = await startFrom(ev43.eventId as string, "Prepare the shipment for order 3043");
    expect(AgentChannelWorkSessionStartResponse.parse(refused.body)).toMatchObject({
      kind: "refused",
      code: "too_many_sessions",
    });
    expect(await itemRow(item43)).toMatchObject({
      status: "waiting",
      reason: "session_capacity",
      attempt: 0,
      agent_event_id: ev43.eventId,
    });
    expect((await auditsOf("automation.item_waiting", item43))[0]?.metadata).toEqual({
      automationId,
      runId: rows[1]?.run_id,
      itemId: item43,
      reason: "session_capacity",
      attempt: 0,
    });
    // The run history says so.
    const history = (
      await ok(s.victor.request("GET", `/api/v1/automations/${automationId}/runs`) as Promise<Res>)
    ).runs as Json[];
    expect(history[0]).toMatchObject({ opened: 2, waiting: 1 });

    const sync = () =>
      core().db.withTenant({ organizationId: s.orgA, userId: null }, (tx) =>
        core().jobs.sendInTx(tx, WAKES, { organizationId: s.orgA, workSessionId }),
      );
    // A sync while the session still runs frees nothing.
    await sync();
    await core().jobs.drain(WAKES);
    expect((await itemRow(item43)).status).toBe("waiting");

    // The session ends: its sync queues 3043 again (attempt 1), and the item's job delivers a new turn for it.
    await s.su.query("update app.work_sessions set status = 'completed' where id = $1", [workSessionId]);
    await sync();
    await core().jobs.drain(WAKES);
    expect(await itemRow(item43)).toMatchObject({ status: "queued", reason: null, attempt: 1 });
    expect((await auditsOf("automation.item_requeued", item43))[0]?.metadata).toMatchObject({
      itemId: item43,
      reason: "session_capacity",
      attempt: 1,
    });
    expect(await drainItems()).toBe(1);
    const again = await itemEvents(item43);
    expect(again.map((e) => e.eventId)).toEqual([ev43.eventId, itemEventId(item43, 1)]);
    expect(await itemRow(item43)).toMatchObject({
      status: "delivered",
      agent_event_id: itemEventId(item43, 1),
    });
    // A second sync of the same ending queues nothing more (the item is no longer waiting).
    await sync();
    await core().jobs.drain(WAKES);
    expect(await drainItems()).toBe(0);

    // Bounded: an item already queued again the maximum number of times is skipped instead of waiting once more.
    await s.su.query("update app.work_sessions set status = 'running' where id = $1", [workSessionId]);
    await s.su.query("update app.automation_conversations set attempt = $2 where id = $1", [
      item43,
      AUTOMATION_ITEM_ATTEMPTS_MAX,
    ]);
    const last = await startFrom(again[1]?.eventId as string, "Prepare the shipment for order 3043");
    expect(AgentChannelWorkSessionStartResponse.parse(last.body)).toMatchObject({
      code: "too_many_sessions",
    });
    expect(await itemRow(item43)).toMatchObject({ status: "skipped", reason: "session_capacity" });
    expect((await auditsOf("automation.item_skipped", item43))[0]?.metadata).toMatchObject({
      reason: "session_capacity",
      attempt: AUTOMATION_ITEM_ATTEMPTS_MAX,
    });
  });

  it("WR-03: a profile that is no longer active (the device owner withdrew consent) lifts no taint, even with the flag still set", async () => {
    const { roots, events } = await openedAndDelivered(["4042"]);
    const ev = events[0] as Json;
    expect((await turnRow(ev.eventId as string))?.tainted).toBe(true);
    await s.su.query(
      "update app.device_bot_consents set revoked_at = now() where device_id = $1 and agent_id = $2 and revoked_at is null",
      [serverId, atlas.id],
    );
    try {
      const move = await moveCard(ev.eventId as string, roots[0] as string, columns.started);
      expect(move.status, JSON.stringify(move.body)).toBe(403);
      expect(codeOf(move)).toBe("tainted");
      expect((await cardRow(roots[0] as string)).column_id).toBe(columns.backlog);
    } finally {
      await grantBotConsent(s.victor, serverId, atlas.id, { allowFullAccess: true });
    }
    // With the consent back the same move passes (the exemption itself is unchanged).
    const again = await moveCard(ev.eventId as string, roots[0] as string, columns.started);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it("without the flag: the item turn's start becomes a Work Zone proposal and its move answers tainted", async () => {
    await createBotProfile(s.victor, atlas.id, profile({ actOnOutsideContent: false }));
    try {
      const { roots, events } = await openedAndDelivered(["1044"]);
      const ev = events[0] as Json;
      const sessionsBefore = Number(
        (
          await s.su.query(
            "select count(*)::int as n from app.work_sessions where started_by_agent_id = $1",
            [atlas.id],
          )
        ).rows[0].n,
      );
      const r = await startFrom(ev.eventId as string, "Prepare the shipment for order 1044");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(AgentChannelWorkSessionStartResponse.parse(r.body)).toMatchObject({
        kind: "proposed",
        reason: "outside_content",
      });
      expect(
        Number(
          (
            await s.su.query(
              "select count(*)::int as n from app.work_sessions where started_by_agent_id = $1",
              [atlas.id],
            )
          ).rows[0].n,
        ),
      ).toBe(sessionsBefore);

      const moved = await moveCard(ev.eventId as string, roots[0] as string, columns.started);
      expect(moved.status, JSON.stringify(moved.body)).toBe(403);
      expect(codeOf(moved)).toBe("tainted");
      expect((await cardRow(roots[0] as string)).column_id).toBe(columns.backlog);
    } finally {
      await createBotProfile(s.victor, atlas.id, profile());
    }
  });
});

describe("the leak sweep and tenants (P1, PD-17; E8)", () => {
  const TITLE = "OCW-MARKER-071717-title";
  const BODY = "OCW-MARKER-071717-body";

  it("the item's title and text reach only the cell event: no audit row, job, tool call or log line holds them", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    await openItems(ev, [{ externalKey: "OCW-MARKER-071717-extid", title: TITLE, body: BODY }]);
    expect(await drainItems()).toBe(1);
    const [row] = await itemRows(automationId);
    const [delivered] = await itemEvents(row?.id as string);
    // The event holds them (the sweep is meaningful).
    expect(delivered?.automationItem.item.title).toBe(TITLE);
    expect(delivered?.automationItem.item.text).toContain(BODY);
    expect(s.logs.length).toBeGreaterThan(20);
    for (const needle of [TITLE, BODY]) {
      for (const q of [
        "select count(*)::int as n from app.audit_events t where strpos(row_to_json(t)::text, $1) > 0",
        "select count(*)::int as n from app.agent_tool_calls t where strpos(row_to_json(t)::text, $1) > 0",
        "select count(*)::int as n from pgboss.job t where strpos(row_to_json(t)::text, $1) > 0",
        "select count(*)::int as n from app.agent_turns t where strpos(row_to_json(t)::text, $1) > 0",
      ]) {
        expect((await s.su.query(q, [needle])).rows[0].n, `${needle}: ${q}`).toBe(0);
      }
      expect(s.logs.filter((l) => l.includes(needle))).toEqual([]);
    }
  });

  it("organization B's cell token with A's item turn: the start is an unknown turn and the move no trigger there", async () => {
    await setUpWorkZone();
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const { roots, events } = await openedAndDelivered(["7001"]);
    const ev = events[0] as Json;
    const before = await cardRow(roots[0] as string);
    const start = await startFrom(ev.eventId as string, "Prepare order 7001", tokenB);
    expect(start.status, JSON.stringify(start.body)).toBe(404);
    const move = await moveCard(ev.eventId as string, roots[0] as string, columns.started, tokenB);
    // The board routes answer an event of no turn they can see as 403 no_trigger (07.1), whatever the organization.
    expect(move.status, JSON.stringify(move.body)).toBe(403);
    expect(codeOf(move)).toBe("no_trigger");
    expect(await cardRow(roots[0] as string)).toEqual(before);
    expect(
      Number(
        (
          await s.su.query("select count(*)::int as n from app.agent_tool_calls where event_id = $1", [
            ev.eventId,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });
});
