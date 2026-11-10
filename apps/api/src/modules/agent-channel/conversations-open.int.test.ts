import { createHash, randomUUID } from "node:crypto";
import { BUILTIN_TOOLS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.17-16 (AFO-02, AFO-05; D-02, D-03, D-05, D-10, D-15; PD-07, PD-08, PD-10, PD-17): the phase's API end to end. A
 * fan-out automation's run turn calls `POST /agent-channel/v1/conversations/open` and opens one conversation per new
 * item in its own target, deduplicated on the key's hash, capped, audited with ids and counts, each item queued for its
 * own turn (`automation.item`). Real PostgreSQL + Redis + pg-boss through the real runner (Run now, then the
 * `automation.fire` job). Víctor Ruiz owns the automations and is their run-as person; the team bot Atlas runs them on
 * the board `#fleet` (Backlog, In progress, Done).
 */

let s: SandboxStack;
let atlas: { id: string; dm: string };
let fleetId: string;
let backlogId: string;

const core = () => s.stack.built.core;
const OPEN = BUILTIN_TOOLS.conversationOpen;

const item = (key: string, extra: Json = {}): Json => ({
  externalKey: key,
  title: `Order ${key}`,
  body: `Customer order ${key}: 2 pallets.`,
  ...extra,
});

/** A fan-out automation of Víctor on `target` (default: `#fleet`'s Backlog), run by Atlas. */
async function createAutomation(extra: Json = {}): Promise<string> {
  return (
    (
      await ok(
        s.victor.request("POST", "/api/v1/automations", {
          name: `Fleet orders ${randomUUID().slice(0, 4)}`,
          agentId: atlas.id,
          instructions: "Find the new orders and open one conversation for each.",
          trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
          target: { kind: "board", conversationId: fleetId, columnId: backlogId },
          maxRunsPerDay: 24,
          fanOut: { enabled: true, perRun: 10, perDay: 100 },
          ...extra,
        }) as Promise<Res>,
        201,
      )
    ).automation as Json
  ).id as string;
}

const runRow = async (runId: string) =>
  (await s.su.query("select * from app.automation_runs where id = $1", [runId])).rows[0] as Json;

/** Run now (`n` times), drained: each run's one delivered `agent.automation_run.v1` event. */
async function runTurns(automationId: string, n = 1): Promise<Array<{ runId: string; ev: Json }>> {
  await s.su.query("delete from app.agent_usage_daily where agent_id = $1", [atlas.id]);
  const runIds: string[] = [];
  for (let i = 0; i < n; i++) {
    runIds.push(
      (await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/run`) as Promise<Res>, 202))
        .runId as string,
    );
  }
  expect(await core().jobs.drain("automation.fire")).toBe(n);
  const out: Array<{ runId: string; ev: Json }> = [];
  for (const runId of runIds) {
    const rows = (
      await s.su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
        [`cell:${s.orgA}`, runId],
      )
    ).rows;
    expect(rows, JSON.stringify(await runRow(runId))).toHaveLength(1);
    const ev = rows[0].payload as Json;
    expect(ev.turn.tools).toContain(OPEN);
    out.push({ runId, ev });
  }
  return out;
}

const runTurn = async (automationId: string) =>
  (await runTurns(automationId))[0] as { runId: string; ev: Json };

/** The cell's call for `ev` (Atlas's, organization A's token by default). */
const open = (ev: Json, items: Json[], extra: Json = {}, token?: string) =>
  s.cell(
    "/conversations/open",
    { eventId: ev.eventId, agentId: atlas.id, items, ...extra },
    ...(token ? [token] : []),
  );

const openOk = async (ev: Json, items: Json[]): Promise<Json> => {
  const body = await ok(open(ev, items));
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body;
};

const sha = (key: string) => createHash("sha256").update(key.normalize("NFC").trim()).digest("hex");

const conversationRows = async (automationId: string) =>
  (
    await s.su.query(
      "select * from app.automation_conversations where automation_id = $1 order by created_at",
      [automationId],
    )
  ).rows as Json[];

const itemJobs = async (itemIds: string[]) =>
  (
    await s.su.query(
      "select data from pgboss.job where name = 'automation.item' and data->>'itemId' = any($1)",
      [itemIds],
    )
  ).rows.map((r) => r.data as Json);

const allItemJobs = async () =>
  Number(
    (await s.su.query("select count(*)::int as n from pgboss.job where name = 'automation.item'")).rows[0].n,
  );

const boardCardCount = async (conversationId: string) =>
  Number(
    (
      await s.su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [
        conversationId,
      ])
    ).rows[0].n,
  );

const statusLabel = async (messageId: string) =>
  (await s.su.query("select status, status_label from app.message_cards where message_id = $1", [messageId]))
    .rows[0] as Json;

const audits = async (action: string, runId: string) =>
  (await s.su.query("select * from app.audit_events where action = $1 and resource_id = $2", [action, runId]))
    .rows as Json[];

const toolCalls = async (eventId: string) =>
  (
    await s.su.query(
      "select * from app.agent_tool_calls where event_id = $1 and tool = $2 order by created_at",
      [eventId, OPEN],
    )
  ).rows as Json[];

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
  for (const member of [
    { kind: "agent", id: atlas.id },
    { kind: "user", id: s.samId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${fleetId}/members`, member) as Promise<Res>);
  }
  const columns = (await ok(s.victor.request("GET", `/api/v1/boards/${fleetId}`) as Promise<Res>))
    .columns as Json[];
  backlogId = columns.find((c) => c.name === "Backlog")?.id as string;
  expect(backlogId).toBeTruthy();
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: the phase's API end to end

describe("Run now → the run's bot opens one card per new order; the next run opens none (D-02, D-03, D-15, E1)", () => {
  it("two items open two Backlog cards, two rows, two ids-only jobs; the run is answered and labelled; a second run reopens nothing", async () => {
    const automationId = await createAutomation();
    const { runId, ev } = await runTurn(automationId);
    const cardsBefore = await boardCardCount(fleetId);

    const first = await openOk(ev, [item("1042"), item("1043")]);
    expect(first.remainingRun).toBe(8);
    expect(first.remainingDay).toBe(98);
    const results = first.results as Json[];
    expect(results.map((r) => [r.externalKey, r.opened, r.conversationId, r.refused])).toEqual([
      ["1042", true, fleetId, null],
      ["1043", true, fleetId, null],
    ]);
    const roots = results.map((r) => r.threadRootMessageId as string);
    expect(new Set(roots).size).toBe(2);

    // Two cards in Backlog with the typed titles, posted by Atlas for Víctor.
    expect(await boardCardCount(fleetId)).toBe(cardsBefore + 2);
    const cards = (
      await s.su.query(
        `select c.message_id, c.column_id, c.title, c.title_source, m.author_kind, m.author_id, m.thread_id
           from app.board_cards c join app.messages m on m.id = c.message_id
          where c.message_id = any($1) order by c.title`,
        [roots],
      )
    ).rows as Json[];
    expect(cards).toEqual([
      {
        message_id: roots[0],
        column_id: backlogId,
        title: "Order 1042",
        title_source: "user",
        author_kind: "agent",
        author_id: atlas.id,
        thread_id: null,
      },
      {
        message_id: roots[1],
        column_id: backlogId,
        title: "Order 1043",
        title_source: "user",
        author_kind: "agent",
        author_id: atlas.id,
        thread_id: null,
      },
    ]);
    for (const root of roots) {
      const [created] = await audits("board.card.created", root);
      expect(created).toMatchObject({ agent_id: atlas.id, user_id: s.victorId });
    }

    // Two rows: the key's sha256 only, queued, this run, the cards as roots.
    const rows = await conversationRows(automationId);
    expect(
      rows.map((r) => [r.external_key_hash, r.status, r.run_id, r.conversation_id, r.root_message_id]),
    ).toEqual([
      [sha("1042"), "queued", runId, fleetId, roots[0]],
      [sha("1043"), "queued", runId, fleetId, roots[1]],
    ]);
    for (const r of rows) expect(r.external_key_hash).toMatch(/^[0-9a-f]{64}$/);
    const itemIds = rows.map((r) => r.id as string);
    const jobs = await itemJobs(itemIds);
    expect(jobs).toHaveLength(2);
    for (const data of jobs) {
      expect(Object.keys(data).sort()).toEqual(["itemId", "organizationId"]);
      expect(data.organizationId).toBe(s.orgA);
    }
    expect(jobs.map((j) => j.itemId).sort()).toEqual([...itemIds].sort());

    // The run is answered, its card says what it opened; one audit with counts; one claimed call.
    const run = await runRow(runId);
    expect(run.status).toBe("answered");
    expect(await statusLabel(run.anchor_message_id as string)).toEqual({
      status: "succeeded",
      status_label: "Opened 2 conversations",
    });
    const opened = await audits("automation.conversation_opened", runId);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.metadata).toEqual({
      automationId,
      runId,
      eventId: ev.eventId,
      opened: 2,
      existing: 0,
      refused: 0,
      outsideContent: false,
    });
    expect(opened[0]).toMatchObject({ agent_id: atlas.id, user_id: s.victorId, result: "success" });
    const calls = await toolCalls(ev.eventId as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: "allowed", target: automationId, user_id: s.victorId });

    // The next run: the same two keys open nothing again and answer the same ids.
    const next = await runTurn(automationId);
    const jobsBefore = await allItemJobs();
    const second = await openOk(next.ev, [item("1042"), item("1043")]);
    expect(second.results).toEqual(results.map((r) => ({ ...r, opened: false })));
    expect(await boardCardCount(fleetId)).toBe(cardsBefore + 2);
    expect(await conversationRows(automationId)).toHaveLength(2);
    expect(await allItemJobs()).toBe(jobsBefore);
    const nextRun = await runRow(next.runId);
    expect(nextRun.status).toBe("answered");
    expect((await statusLabel(nextRun.anchor_message_id as string)).status_label).toBe("Nothing new");
    expect((await audits("automation.conversation_opened", next.runId))[0]?.metadata).toMatchObject({
      opened: 0,
      existing: 2,
      refused: 0,
    });
  });
});
