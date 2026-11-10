import {
  AgentAutomationItemEvent,
  AgentChannelEventTypes,
  automationItemSentence,
  BUILTIN_TOOLS,
} from "@ocw/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { itemEventId } from "../automation";

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
  await s?.stop();
});

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
