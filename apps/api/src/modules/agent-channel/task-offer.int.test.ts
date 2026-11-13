import { randomUUID } from "node:crypto";
import {
  type BotWorkZoneProfileInput,
  BUILTIN_TOOLS,
  TASK_TOOL_FLAGS,
  TASK_TOOL_NAMES,
  TURN_TOOLS_MAX,
  TurnTask,
  WORK_SESSION_TOOL_NAMES,
} from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMention } from "../../lib/chat-agent-bridge";
import type { TestClient } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createBotProfile,
  grantBotConsent,
  pairDevice,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { buildMentionEvents } from "./mentions";
import { taskOfferFor } from "./task-offer";

/**
 * Phase 07.17.1.1.2-07 (D-02, D-04, D-09, D-10; PD-05, PD-07, PD-09, PD-13; BTASK-02, BTASK-03, BTASK-07, BTASK-11): which
 * turn of a bot gets which task tools and what it knows about its task. Decided at delivery (`taskOfferFor`, then gated
 * by `computeTurn.longTasks` in `turnPolicy`): a person's turn in a thread without a task is offered the three tools; in a
 * thread with the bot's active task, the requester's turn while it waits (or the task's own current turn) controls it
 * (`turn.task`, continue and finish, the ledger's `task_id`), every other turn there only sees it. Real PostgreSQL, Redis
 * and Garage; the in-memory sandboxd.
 *
 * People: Sam asks (the requester), Alex is another member of #eng; Víctor is the admin. Scout is the stack's team bot.
 */

let storage: TestStorage;
let s: SandboxStack;
let engId: string;
/** Víctor's build server, paired for the Work Zone case (Task 2). */
let device: FakeDevice | undefined;

const START = BUILTIN_TOOLS.taskStart;
const CONTINUE = BUILTIN_TOOLS.taskContinue;
const FINISH = BUILTIN_TOOLS.taskFinish;

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({ env: { ...storage.env } });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  await s.setPolicy({ enabled: true });
  await s.su.query(
    "update app.sandbox_policies set max_sandboxes = 50, max_browsers = 50 where organization_id = $1",
    [s.orgA],
  );
  engId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "eng", visibility: "public" }) as Promise<Res>,
    )
  ).id as string;
  for (const member of [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
    { kind: "user", id: s.alexId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${engId}/members`, member) as Promise<Res>);
  }
}, 240_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

// ---------------------------------------------------------------- helpers

/** `who` posts in `conv` (a thread reply when `threadRootId` is set); returns the message id. */
async function post(
  who: TestClient,
  conv: string,
  body: string,
  opts: { threadRootId?: string; attachmentIds?: string[] } = {},
): Promise<string> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conv}/messages`, {
      body,
      ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
      ...(opts.attachmentIds ? { attachmentIds: opts.attachmentIds } : {}),
    }) as Promise<Res>,
  );
  return msg.id as string;
}

/** `agentId`'s delivered `agent.mention.v1` payload for one message (exactly one). */
async function deliveredTo(messageId: string, agentId = s.scoutId): Promise<Json> {
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1 and payload->'agent'->>'id' = $2",
      [messageId, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/**
 * `who` mentions Scout in #eng (in the thread of `threadRootId` when set, else at the channel's root); the delivered
 * turn. Today's usage is cleared first: this suite delivers more turns than the bot's daily limit.
 */
async function mention(
  who: TestClient,
  opts: { threadRootId?: string; conv?: string; handle?: string; agentId?: string } = {},
): Promise<Json> {
  await s.su.query("delete from app.agent_usage_daily");
  const handle = opts.handle ?? "scout";
  const id = await post(
    who,
    opts.conv ?? engId,
    `@${handle} the invoice totals ${randomUUID().slice(0, 6)}`,
    {
      ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
    },
  );
  return deliveredTo(id, opts.agentId ?? s.scoutId);
}

const ledger = async (eventId: string) =>
  (await s.su.query("select task_id, tainted, tools from app.agent_turns where event_id = $1", [eventId]))
    .rows[0] as { task_id: string | null; tainted: boolean; tools: string[] };

interface SeedTask {
  conversationId?: string;
  threadRootId: string | null;
  requesterId?: string;
  agentId?: string;
  status?: "running" | "waiting";
  currentEventId?: string;
  waitKind?: "turn" | "timer" | "process" | "session" | "nudge" | null;
  wakeAt?: string | null;
  turnsUsed?: number;
  maxTurns?: number;
  organizationId?: string;
}

/** An active task row, inserted as the start route will (superuser, so the test controls every column). */
async function seedTask(p: SeedTask): Promise<{ id: string; currentEventId: string; startedAt: string }> {
  const id = randomUUID();
  const started = randomUUID();
  const current = p.currentEventId ?? started;
  const status = p.status ?? "waiting";
  const waitKind = p.waitKind === undefined ? (status === "waiting" ? "timer" : null) : p.waitKind;
  const wakeAt =
    p.wakeAt === undefined ? (waitKind ? new Date(Date.now() + 120_000).toISOString() : null) : p.wakeAt;
  const r = await s.su.query(
    `insert into app.bot_tasks (id, organization_id, agent_id, conversation_id, thread_root_id, requester_user_id,
       started_event_id, current_event_id, status, goal, progress, next_step, turns_used, max_turns, deadline_at,
       wait_kind, wait_ref, wake_at, wait_seq)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Reconcile the invoice totals', 'Read the March ledger',
       'Compare it with the bank export', $10, $11, now() + interval '8 hours', $12, null, $13, 1)
     returning started_at`,
    [
      id,
      p.organizationId ?? s.orgA,
      p.agentId ?? s.scoutId,
      p.conversationId ?? engId,
      p.threadRootId,
      p.requesterId ?? s.samId,
      started,
      current,
      status,
      p.turnsUsed ?? 3,
      p.maxTurns ?? 40,
      waitKind,
      wakeAt,
    ],
  );
  return { id, currentEventId: current, startedAt: new Date(r.rows[0].started_at as string).toISOString() };
}

/** Ends a seeded task (done), so the thread is free again. */
const endTask = (id: string) =>
  s.su.query(
    "update app.bot_tasks set status = 'done', outcome = 'done', finished_at = now(), wait_kind = null, wake_at = null where id = $1",
    [id],
  );

/** No task tool, flag or fact on the turn. */
function expectNoTask(ev: Json) {
  for (const name of TASK_TOOL_NAMES) {
    expect(ev.turn.tools).not.toContain(name);
    expect(ev.turn.toolFlags).not.toHaveProperty(name);
  }
  expect(ev.turn).not.toHaveProperty("task");
}

/** The start offer: the three tools with their flags, no task fact, no ledger link. */
async function expectStart(ev: Json) {
  for (const name of TASK_TOOL_NAMES) {
    expect(ev.turn.tools).toContain(name);
    expect(ev.turn.toolFlags[name]).toEqual(TASK_TOOL_FLAGS[name]);
  }
  expect(ev.turn).not.toHaveProperty("task");
  const row = await ledger(ev.eventId as string);
  expect(row.task_id).toBeNull();
  expect(row.tools).toEqual(expect.arrayContaining([...TASK_TOOL_NAMES]));
}

/** Control: continue and finish (never start), `turn.task` of `taskId`, the ledger linked. */
async function expectControl(ev: Json, taskId: string): Promise<TurnTask> {
  expect(ev.turn.tools).toEqual(expect.arrayContaining([CONTINUE, FINISH]));
  expect(ev.turn.tools).not.toContain(START);
  expect(ev.turn.toolFlags[CONTINUE]).toEqual(TASK_TOOL_FLAGS[CONTINUE]);
  expect(ev.turn.toolFlags[FINISH]).toEqual(TASK_TOOL_FLAGS[FINISH]);
  const task = TurnTask.parse(ev.turn.task);
  expect(task.taskId).toBe(taskId);
  expect((await ledger(ev.eventId as string)).task_id).toBe(taskId);
  return task;
}

/** View: `turn.task` only, no task tool, no ledger link. */
async function expectView(ev: Json, taskId: string): Promise<TurnTask> {
  for (const name of TASK_TOOL_NAMES) {
    expect(ev.turn.tools).not.toContain(name);
    expect(ev.turn.toolFlags).not.toHaveProperty(name);
  }
  const task = TurnTask.parse(ev.turn.task);
  expect(task.taskId).toBe(taskId);
  expect((await ledger(ev.eventId as string)).task_id).toBeNull();
  return task;
}

const putPolicy = (body: Json) => ok(s.victor.request("PUT", "/api/v1/bot-policy", body) as Promise<Res>);

// ---------------------------------------------------------------- Task 1: the offer (tracer)

describe("tracer: a person's mention carries the three task tools; a waiting task's requester gets control (PD-07)", () => {
  it("Sam's mention at the root of #eng: the three tools with TASK_TOOL_FLAGS, no turn.task, task_id null", async () => {
    await expectStart(await mention(s.sam));
  });

  it("a waiting task of Scout for Sam in that thread: Sam's next mention there controls it, with the row's facts", async () => {
    const root = await post(s.sam, engId, "Reconcile the invoices please");
    const earlier = await mention(s.sam, { threadRootId: root });
    const wakeAt = new Date(Date.now() + 300_000).toISOString();
    const t = await seedTask({
      threadRootId: root,
      currentEventId: earlier.eventId as string,
      waitKind: "timer",
      wakeAt,
      turnsUsed: 3,
      maxTurns: 40,
    });
    try {
      const ev = await mention(s.sam, { threadRootId: root });
      const task = await expectControl(ev, t.id);
      expect(task).toMatchObject({
        status: "waiting",
        goal: "Reconcile the invoice totals",
        progress: "Read the March ledger",
        nextStep: "Compare it with the bank export",
        turnsUsed: 3,
        maxTurns: 40,
        startedAt: t.startedAt,
        requesterId: s.samId,
        waiting: { kind: "timer", ref: null, until: wakeAt },
        finishedProcesses: [],
      });
      expect(Date.parse(task.deadlineAt)).toBeGreaterThan(Date.now());

      // Alex (another member) in that thread: sees the task, controls nothing.
      await expectView(await mention(s.alex, { threadRootId: root }), t.id);
      // A mention elsewhere in #eng (its own thread): the start offer, the task is not there.
      await expectStart(await mention(s.sam));
    } finally {
      await endTask(t.id);
    }
    // The task ended: the thread offers a start again.
    await expectStart(await mention(s.sam, { threadRootId: root }));
  });

  it("the same task running on another turn: Sam's own message there only sees it (one execution authority, E16)", async () => {
    const root = await post(s.sam, engId, "Check the March export");
    const t = await seedTask({ threadRootId: root, status: "running", currentEventId: randomUUID() });
    try {
      const task = await expectView(await mention(s.sam, { threadRootId: root }), t.id);
      expect(task.status).toBe("running");
      expect(task.waiting).toBeNull();
    } finally {
      await endTask(t.id);
    }
  });

  it("in Sam's DM with Scout the task has no thread (thread_root_id null) and is found for a DM message", async () => {
    const t = await seedTask({ conversationId: s.samDm, threadRootId: null });
    try {
      await expectControl(await s.turnOf(s.sam, s.samDm), t.id);
    } finally {
      await endTask(t.id);
    }
    await expectStart(await s.turnOf(s.sam, s.samDm));
  });

  it("with the organization's long tasks off: no task tool and no turn.task on any of these turns", async () => {
    const root = await post(s.sam, engId, "Reconcile the totals");
    const t = await seedTask({ threadRootId: root });
    await putPolicy({ capabilities: { longTasks: { orgWide: false, personal: false } } });
    try {
      expectNoTask(await mention(s.sam));
      const control = await mention(s.sam, { threadRootId: root });
      expectNoTask(control);
      expect((await ledger(control.eventId as string)).task_id).toBeNull();
      expectNoTask(await mention(s.alex, { threadRootId: root }));
      expectNoTask(await s.turnOf(s.sam, s.samDm));
    } finally {
      await putPolicy({ capabilities: { longTasks: { orgWide: true, personal: true } } });
      await endTask(t.id);
    }
    await expectStart(await mention(s.sam));
  });

  it("with the bot's own Long tasks toggle off: none either", async () => {
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${s.scoutId}/capabilities`, {
        longTasks: false,
      }) as Promise<Res>,
    );
    try {
      expectNoTask(await mention(s.sam));
    } finally {
      await ok(
        s.victor.request("PATCH", `/api/v1/agents/${s.scoutId}/capabilities`, {
          longTasks: true,
        }) as Promise<Res>,
      );
    }
    await expectStart(await mention(s.sam));
  });
});

// ---------------------------------------------------------------- Task 2: the `task` trigger (D-04, D-09, D-10)

const perms = () => createPermissionService(s.stack.built.core);

const setBotBrowser = (agentId: string, on: boolean) =>
  s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', $2::boolean) where id = $1",
    [agentId, on],
  );

const browserTools = (ev: Json) => (ev.turn.tools as string[]).filter((t) => t.startsWith("ocw_browser_"));

/**
 * A delivery of `agentId` through the one builder (`buildMentionEvents`) as agent-channel's own callers build it (the
 * continuation of 09, a Work Zone wake, an automation run, a consult hop): the structural author is `author`, the body a
 * server sentence, in its tenant transaction as that person.
 */
async function deliver(
  p: {
    trigger: NonNullable<AgentMention["trigger"]>;
    messageId: string;
    threadRootId: string;
    conversationId?: string;
    agentId?: string;
    author?: string;
    eventId?: string;
    task?: AgentMention["task"];
    taintedAtStart?: boolean;
    chain?: AgentMention["chain"];
  },
  onLimitReached?: (agentId: string) => void,
): Promise<Json[]> {
  const author = p.author ?? s.samId;
  const mention: AgentMention = {
    organizationId: s.orgA,
    conversationId: p.conversationId ?? engId,
    threadRootId: p.threadRootId,
    messageId: p.messageId,
    agentIds: [p.agentId ?? s.scoutId],
    author: { kind: "user", id: author, displayName: "" },
    body: "Continue your task (turn 4 of 40).",
    createdAt: new Date().toISOString(),
    delivery: "thread",
    trigger: p.trigger,
    ...(p.eventId ? { eventId: p.eventId } : {}),
    ...(p.task ? { task: p.task } : {}),
    ...(p.taintedAtStart ? { taintedAtStart: true } : {}),
    ...(p.chain ? { chain: p.chain } : {}),
  };
  const events = await s.stack.built.core.db.withTenant({ organizationId: s.orgA, userId: author }, (tx) =>
    buildMentionEvents(tx, mention, {
      core: s.stack.built.core,
      perms: perms(),
      ...(onLimitReached ? { onLimitReached } : {}),
    }),
  );
  return events as Json[];
}

/** A thread in #eng: Sam's root (with `attachmentIds`) and a reply in it standing for the task card. */
async function taskThread(attachmentIds?: string[]): Promise<{ root: string; card: string }> {
  const root = await post(s.sam, engId, "Reconcile the March invoices", {
    ...(attachmentIds ? { attachmentIds } : {}),
  });
  const card = await post(s.sam, engId, "Task: reconcile the March invoices", { threadRootId: root });
  return { root, card };
}

/** A running task in `root` whose current turn is `eventId` (as 09 leaves it before the delivery). */
const runningTask = (root: string, eventId: string, p: Partial<SeedTask> = {}) =>
  seedTask({ threadRootId: root, status: "running", currentEventId: eventId, ...p });

describe("the task trigger: browser off, the thread's files listed, the daily limit, run turns and AI chats (D-04, D-09)", () => {
  beforeAll(async () => {
    await setBotBrowser(s.scoutId, true);
  });
  afterAll(async () => {
    await setBotBrowser(s.scoutId, false);
  });

  it("a continuation of Sam's task: no browser tool, the thread's attachments listed, continue and finish, turn.task", async () => {
    const file = await uploadAttachment(s.sam, engId, {
      name: "march.csv",
      type: "text/csv",
      bytes: new TextEncoder().encode("invoice,total\n1042,99\n"),
    });
    const { root, card } = await taskThread([file]);
    // Sam's own mention in the thread: the browser is there (the bot has it on), and so is the file.
    const person = await mention(s.sam, { threadRootId: root });
    expect(browserTools(person).length).toBeGreaterThan(0);
    expect((person.turn.attachments as Json[]).map((a) => a.id)).toContain(file);

    const eventId = randomUUID();
    const t = await runningTask(root, eventId);
    try {
      await s.su.query("delete from app.agent_usage_daily");
      const events = await deliver({
        trigger: "task",
        messageId: card,
        threadRootId: root,
        eventId,
        task: { taskId: t.id, reason: "continue" },
      });
      expect(events).toHaveLength(1);
      const ev = events[0] as Json;
      expect(ev.eventId).toBe(eventId);
      expect(browserTools(ev)).toEqual([]);
      expect((ev.turn.attachments as Json[]).map((a) => a.id)).toContain(file);
      const task = await expectControl(ev, t.id);
      expect(task.status).toBe("running");
      // P4: the notes travel in turn.task only; the message is the server's sentence.
      expect(ev.message.text).toBe("Continue your task (turn 4 of 40).");
      expect(ev.turn).not.toHaveProperty("tainted");
    } finally {
      await endTask(t.id);
    }
  });

  it("taintedAtStart from the caller: the task turn starts tainted, on the turn and in the ledger (PD-15)", async () => {
    const { root, card } = await taskThread();
    const eventId = randomUUID();
    const t = await runningTask(root, eventId);
    try {
      await s.su.query("delete from app.agent_usage_daily");
      const [ev] = await deliver({
        trigger: "task",
        messageId: card,
        threadRootId: root,
        eventId,
        task: { taskId: t.id, reason: "timer" },
        taintedAtStart: true,
      });
      expect((ev as Json).turn.tainted).toBe(true);
      expect((await ledger(eventId)).tainted).toBe(true);
      await expectControl(ev as Json, t.id);
    } finally {
      await endTask(t.id);
    }
  });

  it("at the bot's daily limit: no event, no limit notice, onLimitReached once; a person's mention still gets the notice", async () => {
    const { root, card } = await taskThread();
    const eventId = randomUUID();
    const t = await runningTask(root, eventId);
    const botMessages = async () =>
      Number(
        (
          await s.su.query(
            "select count(*)::int as n from app.messages where conversation_id = $1 and author_kind = 'agent' and author_id = $2",
            [engId, s.scoutId],
          )
        ).rows[0].n,
      );
    try {
      await s.su.query(
        `insert into app.agent_usage_daily (organization_id, agent_id, day, turns)
         values ($1, $2, (now() at time zone 'utc')::date, 100000)
         on conflict (organization_id, agent_id, day) do update set turns = 100000`,
        [s.orgA, s.scoutId],
      );
      const before = await botMessages();
      const calls: string[] = [];
      const events = await deliver(
        {
          trigger: "task",
          messageId: card,
          threadRootId: root,
          eventId,
          task: { taskId: t.id, reason: "continue" },
        },
        (agentId) => calls.push(agentId),
      );
      expect(events).toEqual([]);
      expect(calls).toEqual([s.scoutId]);
      // The after-commit hooks ran when the transaction returned: nothing was posted, no turn recorded.
      expect(await botMessages()).toBe(before);
      expect(await ledger(eventId)).toBeUndefined();
      // The over-limit delivery is still audited, as not notified.
      const audit = (
        await s.su.query(
          "select metadata from app.audit_events where action = 'agent.limit_reached' and metadata->>'messageId' = $1",
          [card],
        )
      ).rows as Json[];
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata.notified).toBe(false);

      // A person's mention at the limit keeps today's notice (the task did not use the channel's daily notice).
      await post(s.sam, engId, `@scout are you there ${randomUUID().slice(0, 6)}`);
      await eventually(async () => ((await botMessages()) === before + 1 ? true : undefined));
    } finally {
      await s.su.query("delete from app.agent_usage_daily");
      await endTask(t.id);
    }
  });

  it("automation run turns and consult hops are never offered ocw_task_start (A4)", async () => {
    const { root } = await taskThread();
    await s.su.query("delete from app.agent_usage_daily");
    const [run] = await deliver({ trigger: "automation", messageId: root, threadRootId: root });
    expectNoTask(run as Json);
    await s.su.query("delete from app.agent_usage_daily");
    const [hop] = await deliver({
      trigger: "consult",
      messageId: root,
      threadRootId: root,
      chain: {
        chainId: null,
        depth: 1,
        answeringHopId: null,
        returningHopId: null,
        rootAgentId: null,
        usedTargetIds: [],
      },
    });
    expectNoTask(hop as Json);
    // The same message as a person's delivery: the start offer.
    await s.su.query("delete from app.agent_usage_daily");
    const [person] = await deliver({ trigger: "mention", messageId: root, threadRootId: root });
    await expectStart(person as Json);
  });

  it("an AI chat never carries a task tool or turn.task, even with an active task row there (D-10)", async () => {
    const chatId = randomUUID();
    await s.su.query(
      "insert into app.conversations (id, organization_id, kind, name, created_by) values ($1, $2, 'ai_chat', 'Invoices', $3)",
      [chatId, s.orgA, s.samId],
    );
    const t = await seedTask({ conversationId: chatId, threadRootId: chatId });
    try {
      const offer = (eventId: string) =>
        s.stack.built.core.db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
          taskOfferFor(tx, {
            agentId: s.scoutId,
            conversationId: chatId,
            conversationKind: "ai_chat",
            threadRootId: chatId,
            askerUserId: s.samId,
            trigger: "mention",
            eventId,
          }),
        );
      expect(await offer(randomUUID())).toBeNull();
      expect(await offer(t.currentEventId)).toBeNull();
    } finally {
      await endTask(t.id);
    }
  });
});

/** Builder's profile on Víctor's build server: Claude Code, Opus only, up to Full access (the 07.16 offer suite's). */
const profile = (deviceId: string, projectIds: string[]): BotWorkZoneProfileInput => ({
  deviceId,
  runtime: "claude-code",
  projectIds,
  defaultModel: "opus",
  allowedModels: ["opus"],
  defaultEffort: null,
  allowedEfforts: [],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
});

describe("a task turn of a bot with an active Work Zone profile carries its session tools, as a Work Zone wake does", () => {
  let builderId: string;

  beforeAll(async () => {
    builderId = (await s.newBot("Builder")).id;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${engId}/members`, {
        kind: "agent",
        id: builderId,
      }) as Promise<Res>,
    );
    await ok(s.victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true }) as Promise<Res>);
    const paired = await pairDevice(s.stack, s.victor, "billing-server");
    device = await FakeDevice.connect(s.stack.baseUrl, paired.token);
    device.send({
      type: "projects.sync",
      projects: [{ localId: "lp_billing", name: "billing-api", gitRemote: null, defaultBranch: "main" }],
    });
    await device.next((f) => f.type === "projects.ack");
    device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);
    await eventually(async () => {
      const r = await s.su.query(
        "select runtime_catalog, full_access_opt_in from app.devices where id = $1",
        [paired.deviceId],
      );
      return (r.rows[0].runtime_catalog as unknown[]).length === 2 && r.rows[0].full_access_opt_in === true;
    });
    const list = (await ok(s.victor.request("GET", "/api/v1/projects") as Promise<Res>)).projects as Json[];
    const billingId = list.find((p) => p.name === "billing-api")?.id as string;
    await createBotProfile(s.victor, builderId, profile(paired.deviceId, [billingId]));
    await grantBotConsent(s.victor, paired.deviceId, builderId, { allowFullAccess: true });
  }, 120_000);

  it("Víctor's task turn: the six session tools and turn.workZone, equal to a work_session wake's on the same message", async () => {
    const root = await post(s.victor, engId, "Fix the billing totals");
    const person = await mention(s.victor, { threadRootId: root, handle: "builder", agentId: builderId });
    for (const name of WORK_SESSION_TOOL_NAMES) expect(person.turn.tools).toContain(name);

    const card = await post(s.victor, engId, "Task: fix the billing totals", { threadRootId: root });
    const eventId = randomUUID();
    const t = await runningTask(root, eventId, { agentId: builderId, requesterId: s.victorId });
    try {
      await s.su.query("delete from app.agent_usage_daily");
      const [ev] = await deliver({
        trigger: "task",
        messageId: card,
        threadRootId: root,
        agentId: builderId,
        author: s.victorId,
        eventId,
        task: { taskId: t.id, reason: "continue" },
      });
      await s.su.query("delete from app.agent_usage_daily");
      const [wake] = await deliver({
        trigger: "work_session",
        messageId: card,
        threadRootId: root,
        agentId: builderId,
        author: s.victorId,
      });
      const sessionTools = (e: Json) =>
        (e.turn.tools as string[]).filter((n) => (WORK_SESSION_TOOL_NAMES as readonly string[]).includes(n));
      expect(sessionTools(ev as Json)).toEqual([...WORK_SESSION_TOOL_NAMES]);
      expect(sessionTools(ev as Json)).toEqual(sessionTools(wake as Json));
      expect((ev as Json).turn.workZone).toEqual((wake as Json).turn.workZone);
      await expectControl(ev as Json, t.id);
      // The wake is not the task's current turn: it only sees the task.
      await expectView(wake as Json, t.id);
    } finally {
      await endTask(t.id);
    }
  });
});

// ---------------------------------------------------------------- Task 3: finished processes, the cap, organization B

describe("finished processes are reported on the task's own turns, once each (PD-13)", () => {
  it("12 ended processes: the 10 oldest on Sam's control turn, none on Alex's view, the other 2 on Sam's next turn", async () => {
    const root = await post(s.sam, engId, "Run the long reconciliation");
    const t = await seedTask({ threadRootId: root });
    const statuses = ["exited", "killed", "timed_out", "lost"] as const;
    for (let i = 0; i < 12; i++) {
      await s.su.query(
        `insert into app.bot_task_processes (organization_id, task_id, agent_id, process_id, event_id, status, exit_code,
           duration_ms, deadline_at, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 hour', now() - make_interval(mins => $9))`,
        [
          s.orgA,
          t.id,
          s.scoutId,
          `proc-${String(i).padStart(2, "0")}`,
          t.currentEventId,
          statuses[i % 4],
          statuses[i % 4] === "exited" ? i : null,
          statuses[i % 4] === "lost" ? null : 1000 + i,
          60 - i,
        ],
      );
    }
    await s.su.query(
      `insert into app.bot_task_processes (organization_id, task_id, agent_id, process_id, event_id, deadline_at)
       values ($1, $2, $3, 'proc-running', $4, now() + interval '1 hour')`,
      [s.orgA, t.id, s.scoutId, t.currentEventId],
    );
    const reported = async () =>
      (
        await s.su.query(
          "select process_id from app.bot_task_processes where task_id = $1 and reported_at is not null order by process_id",
          [t.id],
        )
      ).rows.map((r) => r.process_id as string);
    const ids = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, k) => `proc-${String(from + k).padStart(2, "0")}`);
    try {
      const first = await expectControl(await mention(s.sam, { threadRootId: root }), t.id);
      expect(first.finishedProcesses.map((p) => p.processId)).toEqual(ids(0, 10));
      expect(first.finishedProcesses[0]).toEqual({
        processId: "proc-00",
        status: "exited",
        exitCode: 0,
        durationMs: 1000,
      });
      expect(first.finishedProcesses[3]).toEqual({
        processId: "proc-03",
        status: "lost",
        exitCode: null,
        durationMs: null,
      });
      expect(await reported()).toEqual(ids(0, 10));

      const view = await expectView(await mention(s.alex, { threadRootId: root }), t.id);
      expect(view.finishedProcesses).toEqual([]);
      expect(await reported()).toEqual(ids(0, 10));

      const second = await expectControl(await mention(s.sam, { threadRootId: root }), t.id);
      expect(second.finishedProcesses.map((p) => p.processId)).toEqual(ids(10, 12));
      expect(await reported()).toEqual(ids(0, 12));
      // The running process is never listed, and nothing is listed twice.
      const third = await expectControl(await mention(s.sam, { threadRootId: root }), t.id);
      expect(third.finishedProcesses).toEqual([]);
    } finally {
      await endTask(t.id);
    }
  });

  it("long tasks off: the turn lists nothing and marks nothing", async () => {
    const root = await post(s.sam, engId, "Run the export");
    const t = await seedTask({ threadRootId: root });
    await s.su.query(
      `insert into app.bot_task_processes (organization_id, task_id, agent_id, process_id, event_id, status, deadline_at, ended_at)
       values ($1, $2, $3, 'proc-off', $4, 'exited', now() + interval '1 hour', now())`,
      [s.orgA, t.id, s.scoutId, t.currentEventId],
    );
    await putPolicy({ capabilities: { longTasks: { orgWide: false, personal: false } } });
    try {
      expectNoTask(await mention(s.sam, { threadRootId: root }));
      const r = await s.su.query(
        "select reported_at from app.bot_task_processes where process_id = 'proc-off'",
      );
      expect(r.rows[0].reported_at).toBeNull();
    } finally {
      await putPolicy({ capabilities: { longTasks: { orgWide: true, personal: true } } });
      await endTask(t.id);
    }
  });
});

describe("the task tools never evict a platform tool (TURN_TOOLS_MAX, P5)", () => {
  it("TURN_TOOLS_MAX - 1 usable tools: the last two connector tools give their places to the three task tools", async () => {
    const bot = await s.newBot(`Bulky ${randomUUID().slice(0, 4)}`);
    await ok(
      s.victor.request("POST", `/api/v1/channels/${engId}/members`, {
        kind: "agent",
        id: bot.id,
      }) as Promise<Res>,
    );
    const handle = (await s.su.query("select username from app.agents where id = $1", [bot.id])).rows[0]
      .username as string;
    const turn = () => mention(s.victor, { handle, agentId: bot.id });
    const plain = await turn();
    await expectStart(plain);
    const platform = (plain.turn.tools as string[]).filter((t) => t.startsWith("ocw_"));
    const base = (plain.turn.tools as string[]).length - TASK_TOOL_NAMES.length;

    const serverMcp = randomUUID();
    await s.su.query(
      `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
       values ($1, $2, 'Bulk', 'bulk', 'streamable-http', 'https://bulk.example.test/mcp', 'ready', 'org_secret')`,
      [serverMcp, s.orgA],
    );
    const names = Array.from(
      { length: TURN_TOOLS_MAX - 1 - base },
      (_, i) => `bulk__t${String(i).padStart(3, "0")}`,
    );
    for (const name of names) {
      await s.su.query(
        "insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only) values ($1, $2, $3, $4, true)",
        [s.orgA, serverMcp, name.slice("bulk__".length), name],
      );
    }
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${bot.id}/capabilities`, {
        tools: names.map((tool) => ({ sourceKind: "mcp", sourceId: serverMcp, tool })),
      }) as Promise<Res>,
    );
    const full = await turn();
    expect(full.turn.tools).toHaveLength(TURN_TOOLS_MAX);
    await expectStart(full);
    for (const name of platform) expect(full.turn.tools).toContain(name);
    for (const name of names.slice(-2)) {
      expect(full.turn.tools).not.toContain(name);
      expect(full.turn.toolFlags).not.toHaveProperty(name);
    }
    for (const name of names.slice(0, -2)) expect(full.turn.tools).toContain(name);
    expect((await ledger(full.eventId as string)).tools).toEqual(full.turn.tools);
  });
});

describe("organization B never sees organization A's task (E22)", () => {
  it("A's ids in B's tenant transaction find no task; B's own bot gets a start offer only", async () => {
    const t = await seedTask({ conversationId: s.samDm, threadRootId: null });
    try {
      const inB = await s.stack.built.core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
        taskOfferFor(tx, {
          agentId: s.scoutId,
          conversationId: s.samDm,
          conversationKind: "dm",
          threadRootId: null,
          askerUserId: s.samId,
          trigger: "mention",
          eventId: t.currentEventId,
        }),
      );
      expect(inB).toEqual({ offer: "start", task: null, taskId: null, reportedProcessIds: [] });
      // In A, the same call finds the task.
      const inA = await s.stack.built.core.db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
        taskOfferFor(tx, {
          agentId: s.scoutId,
          conversationId: s.samDm,
          conversationKind: "dm",
          threadRootId: null,
          askerUserId: s.samId,
          trigger: "mention",
          eventId: t.currentEventId,
        }),
      );
      expect(inA?.offer).toBe("control");
      expect(inA?.taskId).toBe(t.id);

      const bot = await ok(
        s.eve.request("POST", "/api/v1/agents", {
          name: "Ledger",
          username: "ledger",
          instructions: "You are Ledger.",
          modelProvider: "mock",
          modelId: "mock-1",
        }) as Promise<Res>,
      );
      await s.su.query("update app.agents set status = 'ready' where id = $1", [bot.id]);
      const dm = (
        await ok(
          s.eve.request("POST", "/api/v1/dms", {
            participants: [{ kind: "agent", id: bot.id }],
          }) as Promise<Res>,
        )
      ).id as string;
      await s.su.query("delete from app.agent_usage_daily");
      const msg = await post(s.eve, dm, "Reconcile our invoices");
      const ev = await deliveredTo(msg, bot.id as string);
      for (const name of TASK_TOOL_NAMES) expect(ev.turn.tools).toContain(name);
      expect(ev.turn).not.toHaveProperty("task");
      expect(JSON.stringify(ev)).not.toContain(t.id);
    } finally {
      await endTask(t.id);
    }
  });
});
