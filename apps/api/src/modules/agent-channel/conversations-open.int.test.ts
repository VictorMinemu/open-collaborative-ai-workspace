import { createHash, randomUUID } from "node:crypto";
import {
  BUILTIN_TOOLS,
  CONVERSATION_OPEN_SENTENCES,
  type ConversationOpenRefusal,
  MAX_TOOL_CALLS_PER_TURN,
} from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

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

// ---------------------------------------------------------------- Task 2: caps, races, targets, quiet runs, refusals

const patchAutomation = async (id: string, changes: Json) => {
  const version = (await ok(s.victor.request("GET", `/api/v1/automations/${id}`) as Promise<Res>))
    .version as number;
  return ok(
    s.victor.request("PATCH", `/api/v1/automations/${id}`, {
      expectedVersion: version,
      ...changes,
    }) as Promise<Res>,
  );
};

const expectRefusal = async (res: Promise<Res>, eventId: string, code: ConversationOpenRefusal) => {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toEqual({ ok: false, code, sentence: CONVERSATION_OPEN_SENTENCES[code] });
  const calls = await toolCalls(eventId);
  expect(calls.at(-1)).toMatchObject({ decision: "denied", reason: code });
};

describe("caps and races (PD-08, E1–E4)", () => {
  it("E3: per run 10, 11 items → 10 opened, the 11th refused run_cap, remainingRun 0", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    const keys = Array.from({ length: 11 }, (_, i) => `R-${i}`);
    const out = await openOk(
      ev,
      keys.map((k) => item(k)),
    );
    const results = out.results as Json[];
    expect(results.filter((r) => r.opened)).toHaveLength(10);
    expect(results[10]).toEqual({
      externalKey: "R-10",
      opened: false,
      conversationId: null,
      threadRootMessageId: null,
      refused: "run_cap",
    });
    expect(out.remainingRun).toBe(0);
    expect(out.remainingDay).toBe(90);
    expect(await conversationRows(automationId)).toHaveLength(10);
  });

  it("E4: per day 3 over two runs → 3 opened, one day_cap; after the automation's local midnight the cap resets", async () => {
    const automationId = await createAutomation({ fanOut: { enabled: true, perRun: 3, perDay: 3 } });
    const a = await runTurn(automationId);
    const first = await openOk(a.ev, [item("D-1"), item("D-2")]);
    expect((first.results as Json[]).every((r) => r.opened)).toBe(true);
    expect(first.remainingDay).toBe(1);

    const b = await runTurn(automationId);
    const second = await openOk(b.ev, [item("D-3"), item("D-4")]);
    expect((second.results as Json[]).map((r) => [r.externalKey, r.opened, r.refused])).toEqual([
      ["D-3", true, null],
      ["D-4", false, "day_cap"],
    ]);
    expect(second.remainingRun).toBe(0);
    expect(second.remainingDay).toBe(0);
    expect(await conversationRows(automationId)).toHaveLength(3);

    // The day's rows moved before the automation's (Madrid) midnight: a new day counts from zero again.
    await s.su.query(
      "update app.automation_conversations set created_at = created_at - interval '1 day' where automation_id = $1",
      [automationId],
    );
    const c = await runTurn(automationId);
    const third = await openOk(c.ev, [item("D-4")]);
    expect((third.results as Json[])[0]).toMatchObject({ externalKey: "D-4", opened: true, refused: null });
    expect(third.remainingDay).toBe(2);
  });

  it("E2: two runs' turns call at once with the same key → exactly one opened, one card, one job", async () => {
    const automationId = await createAutomation();
    const [a, b] = (await runTurns(automationId, 2)).map((t) => t.ev) as [Json, Json];
    const cardsBefore = await boardCardCount(fleetId);
    const jobsBefore = await allItemJobs();
    const answers = await Promise.all([openOk(a, [item("2042")]), openOk(b, [item("2042")])]);
    const results = answers.map((x) => (x.results as Json[])[0] as Json);
    expect(results.filter((r) => r.opened)).toHaveLength(1);
    expect(results.filter((r) => !r.opened && r.refused === null)).toHaveLength(1);
    // Both answer the same conversation and root.
    expect(results[0]?.threadRootMessageId).toBeTruthy();
    expect(results[0]?.threadRootMessageId).toBe(results[1]?.threadRootMessageId);
    expect(await boardCardCount(fleetId)).toBe(cardsBefore + 1);
    expect(await conversationRows(automationId)).toHaveLength(1);
    expect(await allItemJobs()).toBe(jobsBefore + 1);
  });

  it("E1: the same key twice in one call → opened, then opened: false with the same ids", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    const out = await openOk(ev, [item("3042"), item(" 3042 ")]);
    const [one, two] = out.results as [Json, Json];
    expect(one.opened).toBe(true);
    expect(two).toEqual({ ...one, opened: false });
    expect(await conversationRows(automationId)).toHaveLength(1);
  });

  it("E10: a deleted opened card never opens again for the same key; its root reads null", async () => {
    const automationId = await createAutomation();
    const a = await runTurn(automationId);
    const root = ((await openOk(a.ev, [item("4042")])).results as Json[])[0]?.threadRootMessageId as string;
    await ok(s.victor.request("DELETE", `/api/v1/messages/${root}`) as Promise<Res>);
    const cardsBefore = await boardCardCount(fleetId);
    const b = await runTurn(automationId);
    const again = ((await openOk(b.ev, [item("4042")])).results as Json[])[0];
    expect(again).toEqual({
      externalKey: "4042",
      opened: false,
      conversationId: fleetId,
      threadRootMessageId: null,
      refused: null,
    });
    expect(await boardCardCount(fleetId)).toBe(cardsBefore);
    expect(await conversationRows(automationId)).toHaveLength(1);
  });
});

describe("channel targets, quiet runs and bot-written text (D-10, E5, E6, P2)", () => {
  let dispatchId: string;

  beforeAll(async () => {
    dispatchId = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: "dispatch",
          visibility: "private",
        }) as Promise<Res>,
      )
    ).id as string;
    for (const member of [
      { kind: "agent", id: atlas.id },
      { kind: "user", id: s.samId },
    ]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${dispatchId}/members`, member) as Promise<Res>);
    }
    // A unit handle a body could name (@logistics).
    await ok(
      s.victor.request("POST", "/api/v1/units", {
        kind: "department",
        name: "Logistics",
        parentId: null,
      }) as Promise<Res>,
    );
  });

  const messageRows = async (ids: string[]) =>
    (
      await s.su.query(
        "select id, conversation_id, thread_id, body, mentions, author_kind, author_id from app.messages where id = any($1) order by body",
        [ids],
      )
    ).rows as Json[];

  const notificationsOf = async (ids: string[]) =>
    Number(
      (await s.su.query("select count(*)::int as n from app.notifications where message_id = any($1)", [ids]))
        .rows[0].n,
    );

  it("a channel target opens top-level messages: the bold title, then the fenced body; each its own thread root", async () => {
    const automationId = await createAutomation({ target: { kind: "channel", conversationId: dispatchId } });
    const { ev } = await runTurn(automationId);
    const out = await openOk(ev, [item("1042"), item("1043", { body: "" })]);
    const roots = (out.results as Json[]).map((r) => r.threadRootMessageId as string);
    expect((out.results as Json[]).every((r) => r.opened && r.conversationId === dispatchId)).toBe(true);
    const rows = await messageRows(roots);
    expect(rows.map((m) => [m.id, m.conversation_id, m.thread_id, m.author_kind, m.author_id])).toEqual([
      [roots[0], dispatchId, null, "agent", atlas.id],
      [roots[1], dispatchId, null, "agent", atlas.id],
    ]);
    expect(rows[0]?.body).toBe("**Order 1042**\n\n```text\nCustomer order 1042: 2 pallets.\n```");
    expect(rows[1]?.body).toBe("**Order 1043**");
    expect((await conversationRows(automationId)).map((r) => r.root_message_id)).toEqual(roots);
  });

  it("E5: items [] answers the run with “Nothing new”; three quiet runs leave the automation active", async () => {
    const automationId = await createAutomation();
    for (let i = 0; i < 3; i++) {
      const { runId, ev } = await runTurn(automationId);
      expect(await ok(open(ev, []))).toEqual({ ok: true, results: [], remainingRun: 10, remainingDay: 100 });
      const run = await runRow(runId);
      expect(run.status).toBe("answered");
      expect((await statusLabel(run.anchor_message_id as string)).status_label).toBe("Nothing new");
    }
    const a = (
      await s.su.query("select status, consecutive_failures from app.automations where id = $1", [
        automationId,
      ])
    ).rows[0];
    expect(a).toEqual({ status: "active", consecutive_failures: 0 });
    expect(await conversationRows(automationId)).toEqual([]);
  });

  it("E6: titles and bodies naming @sam, @logistics or @channel resolve no mention and notify nobody (board and channel)", async () => {
    const hostile = (key: string) =>
      item(key, { title: "@sam urgent", body: "@logistics now @channel, and @atlas too" });
    const botWakes = async () =>
      Number(
        (
          await s.su.query(
            "select count(*)::int as n from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'",
            [`cell:${s.orgA}`],
          )
        ).rows[0].n,
      );
    for (const target of [
      { kind: "board", conversationId: fleetId, columnId: backlogId },
      { kind: "channel", conversationId: dispatchId },
    ]) {
      const automationId = await createAutomation({ target });
      const { ev } = await runTurn(automationId);
      const wakes = await botWakes();
      const out = await openOk(ev, [hostile(`M-${randomUUID().slice(0, 6)}`)]);
      const root = (out.results as Json[])[0]?.threadRootMessageId as string;
      const [m] = await messageRows([root]);
      expect(m?.mentions).toEqual([]);
      expect(m?.body).not.toMatch(/(^|\s)@(sam|logistics|channel|atlas)\b/u);
      expect(await notificationsOf([root])).toBe(0);
      // A bot-written post wakes no bot.
      expect(await botWakes()).toBe(wakes);
      if (target.kind === "board") {
        const card = (await s.su.query("select title from app.board_cards where message_id = $1", [root]))
          .rows[0];
        expect(card.title).toBe("⁠@sam urgent");
      }
    }
  });
});

describe("refusals (PD-07, E8): each with its fixed sentence, recorded through the claim", () => {
  it("a person's turn of Atlas → not_in_turn (the tool is not on it)", async () => {
    const ev = await s.turnOf(s.sam, atlas.dm, atlas.id);
    expect(ev.turn.tools).not.toContain(OPEN);
    await expectRefusal(open(ev, [item("X-1")]), ev.eventId as string, "not_in_turn");
  });

  it("a turn with the tool but no run row → not_a_run", async () => {
    const automationId = await createAutomation();
    const { runId, ev } = await runTurn(automationId);
    await s.su.query("update app.automation_runs set agent_event_id = null where id = $1", [runId]);
    await expectRefusal(open(ev, [item("X-2")]), ev.eventId as string, "not_a_run");
    expect(await conversationRows(automationId)).toEqual([]);
  });

  it("a paused automation → automation_inactive; fan-out turned off since delivery → fan_out_off", async () => {
    const paused = await createAutomation();
    const p = await runTurn(paused);
    await ok(s.victor.request("POST", `/api/v1/automations/${paused}/pause`) as Promise<Res>);
    await expectRefusal(open(p.ev, [item("X-3")]), p.ev.eventId as string, "automation_inactive");

    const off = await createAutomation();
    const o = await runTurn(off);
    await patchAutomation(off, { fanOut: { enabled: false, perRun: 10, perDay: 100 } });
    await expectRefusal(open(o.ev, [item("X-4")]), o.ev.eventId as string, "fan_out_off");
    expect([...(await conversationRows(paused)), ...(await conversationRows(off))]).toEqual([]);
  });

  it("Atlas removed from the board → target_not_postable: nothing posted, no row, the refusal recorded", async () => {
    const yardId = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: "yard",
          visibility: "private",
          layout: "board",
        }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${yardId}/members`, {
        kind: "agent",
        id: atlas.id,
      }) as Promise<Res>,
    );
    const yardBacklog = (
      (await ok(s.victor.request("GET", `/api/v1/boards/${yardId}`) as Promise<Res>)).columns as Json[]
    ).find((c) => c.category === "backlog")?.id as string;
    const automationId = await createAutomation({
      target: { kind: "board", conversationId: yardId, columnId: yardBacklog },
    });
    const { ev } = await runTurn(automationId);
    await ok(
      s.victor.request("DELETE", `/api/v1/channels/${yardId}/members/agent/${atlas.id}`) as Promise<Res>,
    );
    const cardsBefore = await boardCardCount(yardId);
    const jobsBefore = await allItemJobs();
    await expectRefusal(open(ev, [item("Y-1"), item("Y-2")]), ev.eventId as string, "target_not_postable");
    expect(await boardCardCount(yardId)).toBe(cardsBefore);
    expect(await conversationRows(automationId)).toEqual([]);
    expect(await allItemJobs()).toBe(jobsBefore);
    // The rolled-back claim is gone: the refusal's row is the only one, and the turn's count is untouched.
    expect(await toolCalls(ev.eventId as string)).toHaveLength(1);
    expect(
      (await s.su.query("select tool_calls from app.agent_turns where event_id = $1", [ev.eventId])).rows[0],
    ).toEqual({ tool_calls: 0 });
  });

  it("the turn's ninth tool call → cap_reached", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    await s.su.query("update app.agent_turns set tool_calls = $2 where event_id = $1", [
      ev.eventId,
      MAX_TOOL_CALLS_PER_TURN,
    ]);
    await expectRefusal(open(ev, [item("X-5")]), ev.eventId as string, "cap_reached");
    expect(await conversationRows(automationId)).toEqual([]);
  });

  it("an unknown event or another bot's event → 404 unknown_turn", async () => {
    const automationId = await createAutomation();
    const { ev } = await runTurn(automationId);
    for (const r of [
      await open({ eventId: randomUUID() }, [item("X-6")]),
      await open(ev, [item("X-6")], { agentId: s.scoutId }),
    ]) {
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expect(codeOf(r)).toBe("unknown_turn");
    }
    expect(await conversationRows(automationId)).toEqual([]);
  });
});
