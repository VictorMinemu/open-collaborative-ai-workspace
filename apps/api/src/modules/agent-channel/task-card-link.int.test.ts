import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "../../testing";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { continueAs, finishAs, startTaskFor, taskRow } from "../../testing-tasks";
import { createPermissionService } from "../organization";
import { createTaskCards } from "./task-card";
import { lockTask, mayStopTask } from "./tasks";

/**
 * Phase 07.17.1.1.2-10 (D-05, PD-11, PD-12, E18; BTASK-09, BTASK-11): the live task card as every reader gets it. The
 * server composes `card.task` from the `bot_tasks` row (status, outcome, turns, times, the requester, the wait) on every
 * read and on every realtime event; `viewerCan.stop` is offered, on REST reads only, to exactly the people `mayStopTask`
 * allows while the task is active.
 *
 * People: Sam Lee asks (the requester); Alex Kim is another member; Víctor is the admin. Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;
/** A group DM: Sam, Alex and Scout (the card is a flat message there). */
let groupId: string;

beforeAll(async () => {
  s = await startSandboxStack();
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
  groupId = (
    await ok(
      s.sam.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: s.alexId },
          { kind: "agent", id: s.scoutId },
        ],
      }) as Promise<Res>,
    )
  ).id as string;
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

/** The task card in `who`'s read of the conversation's messages (flat conversations). */
async function cardInList(who: TestClient, conversationId: string, messageId: string): Promise<Json> {
  const list = (await ok(
    who.request("GET", `/api/v1/conversations/${conversationId}/messages`) as Promise<Res>,
  )) as Json;
  const message = (list.messages as Json[]).find((m) => m.id === messageId);
  expect(message?.card, `the card ${messageId} in the list`).toBeTruthy();
  return message?.card as Json;
}

/** The task card in `who`'s read of its thread. */
async function cardInThread(who: TestClient, rootId: string, messageId: string): Promise<Json> {
  const thread = (await ok(who.request("GET", `/api/v1/messages/${rootId}/thread`) as Promise<Res>)) as Json;
  const reply = (thread.replies as Json[]).find((m) => m.id === messageId);
  expect(reply?.card, `the card ${messageId} in the thread`).toBeTruthy();
  return reply?.card as Json;
}

/** The single card read (`GET /api/v1/cards/:messageId`). */
const cardRead = async (who: TestClient, messageId: string): Promise<Json> =>
  (await ok(who.request("GET", `/api/v1/cards/${messageId}`) as Promise<Res>)) as Json;

/** The last `message.updated` (or `message.created`) of the card on its conversation's topic. */
async function lastEventCard(conversationId: string, messageId: string, type = "message.updated") {
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = $2 and payload->'message'->>'id' = $3 order by seq desc limit 1",
      [`conv:${conversationId}`, type, messageId],
    )
  ).rows;
  expect(rows, `a ${type} of ${messageId}`).toHaveLength(1);
  return (rows[0].payload as Json).message.card as Json;
}

describe("card.task and viewerCan.stop on every read (tracer, PD-11, PD-12)", () => {
  it("Sam's read has the link and Stop; Alex's has the same link and no Stop", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: groupId });
    const row = await taskRow(s, taskId);
    const cardId = row.card_message_id as string;

    const mine = await cardInList(s.sam, groupId, cardId);
    expect(mine.kind).toBe("task");
    expect(mine.platformOwned).toBe(true);
    expect(mine.task).toEqual({
      taskId,
      status: "running",
      outcome: null,
      turnsUsed: 1,
      maxTurns: 40,
      startedAt: new Date(row.started_at as string).toISOString(),
      deadlineAt: new Date(row.deadline_at as string).toISOString(),
      finishedAt: null,
      requesterId: s.samId,
      requesterName: "Sam Lee",
      waiting: null,
      wakeAt: null,
    });
    expect(mine.viewerCan).toEqual(expect.arrayContaining(["follow", "stop"]));

    const theirs = await cardInList(s.alex, groupId, cardId);
    expect(theirs.task).toEqual(mine.task);
    expect(theirs.viewerCan).toContain("follow");
    expect(theirs.viewerCan).not.toContain("stop");

    // The single card read carries the same.
    expect((await cardRead(s.sam, cardId)).viewerCan).toContain("stop");
    expect((await cardRead(s.alex, cardId)).viewerCan).not.toContain("stop");
  });

  it("in a channel thread: the thread read and the single read carry the link; Stop only for Sam", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const row = await taskRow(s, taskId);
    const cardId = row.card_message_id as string;
    const rootId = row.thread_root_id as string;
    expect(rootId).toBeTruthy();
    const mine = await cardInThread(s.sam, rootId, cardId);
    expect(mine.task).toMatchObject({ taskId, status: "running", requesterName: "Sam Lee" });
    expect(mine.viewerCan).toContain("stop");
    expect((await cardInThread(s.alex, rootId, cardId)).viewerCan).not.toContain("stop");
  });

  it("after a continue, the realtime update carries card.task waiting and no viewer field", async () => {
    // A new thread in #eng (the group DM is one thread: its task from above is still active).
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, event, { afterSeconds: 600 })).body).toMatchObject({ ok: true });
    const row = await taskRow(s, taskId);
    const live = await lastEventCard(engId, row.card_message_id as string);
    expect(live.task).toMatchObject({ taskId, status: "waiting", waiting: "timer", turnsUsed: 1 });
    expect(new Date((live.task as Json).wakeAt as string).toISOString()).toBe(
      new Date(row.wake_at as string).toISOString(),
    );
    expect(live).not.toHaveProperty("viewerCan");
    expect(live).not.toHaveProperty("following");
  });
});

/** A new member of organization A with `role`, signed in. */
async function joinAs(
  email: string,
  name: string,
  role: "standard" | "lead" | "admin",
): Promise<[TestClient, string]> {
  const inv = await ok(s.victor.request("POST", "/api/v1/invitations", { email, role }) as Promise<Res>);
  const c = new TestClient(s.stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }) as Promise<Res>,
  );
  return [c, acc.user.id as string];
}

/** `mayStopTask` as `userId` decides it, in a tenant transaction of organization A (the route's one rule). */
async function mayStop(taskId: string, userId: string): Promise<boolean> {
  const core = s.stack.built.core;
  const perms = createPermissionService(core);
  return core.db.withTenant({ organizationId: s.orgA, userId }, async (tx) => {
    const task = await lockTask(tx, taskId);
    if (!task) throw new Error("task not found");
    return mayStopTask(tx, core, perms, task, userId);
  });
}

describe("viewerCan.stop for each role, and only while the task is active (PD-12, E18)", () => {
  /** Mo: a channel moderator (`message.delete_any`) whose bot rights are denied. */
  let mo: TestClient;
  let moId: string;
  /** Riley: a Lead who leads the Backend team (`bot.manage_unit` on its bots). */
  let riley: TestClient;
  let rileyId: string;
  /** Builder: a team bot of the Backend team. */
  let builderId: string;
  let opsId: string;

  beforeAll(async () => {
    // Moderation (`message.delete_any`) is an admin right that no allow rule grants: Mo is an admin whose bot rights
    // are denied, so moderating the channel is the only way Mo may stop a task.
    [mo, moId] = await joinAs("mo@example.test", "Mo Diaz", "admin");
    [riley, rileyId] = await joinAs("riley@example.test", "Riley Park", "lead");
    for (const permission of ["bot.manage", "bot.manage_unit", "bot.configure"]) {
      await ok(
        s.victor.request("POST", "/api/v1/permission-rules", {
          subjectKind: "user",
          subjectId: moId,
          permission,
          effect: "deny",
        }) as Promise<Res>,
      );
    }
    const unit = async (kind: string, name: string, parentId: string | null) =>
      (await ok(s.victor.request("POST", "/api/v1/units", { kind, name, parentId }) as Promise<Res>))
        .id as string;
    const backend = await unit("team", "Backend", await unit("department", "Engineering", null));
    await ok(
      s.victor.request("POST", `/api/v1/units/${backend}/members`, {
        userId: rileyId,
        role: "lead",
      }) as Promise<Res>,
    );
    // Sam is a Backend member: a unit persona answers the people of its unit.
    await ok(
      s.victor.request("POST", `/api/v1/units/${backend}/members`, { userId: s.samId }) as Promise<Res>,
    );
    builderId = (await s.newBot("Builder")).id;
    await s.su.query("update app.agents set unit_id = $2 where id = $1", [builderId, backend]);
    opsId = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "public" }) as Promise<Res>,
      )
    ).id as string;
    for (const member of [
      { kind: "agent", id: builderId },
      ...[s.samId, s.alexId, moId, rileyId].map((id) => ({ kind: "user", id })),
    ]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${opsId}/members`, member) as Promise<Res>);
    }
  }, 120_000);

  it("the requester, a moderator, the team bot's unit lead and an admin see Stop; a plain member does not", async () => {
    const { taskId } = await startTaskFor(s, {
      who: s.sam,
      conversationId: opsId,
      agentId: builderId,
      handle: "builder",
    });
    const cardId = (await taskRow(s, taskId)).card_message_id as string;
    const table: Array<[string, TestClient, string, boolean]> = [
      ["the requester (Sam)", s.sam, s.samId, true],
      ["a channel moderator (Mo, message.delete_any, no bot right)", mo, moId, true],
      ["the team bot's unit lead (Riley, bot.manage_unit)", riley, rileyId, true],
      ["an admin (Víctor)", s.victor, s.victorId, true],
      ["a plain member (Alex)", s.alex, s.alexId, false],
    ];
    for (const [who, client, userId, expected] of table) {
      const card = await cardRead(client, cardId);
      expect(card.task, who).toMatchObject({ taskId, status: "running" });
      expect((card.viewerCan as string[]).includes("stop"), who).toBe(expected);
      // The same people the Stop route's one rule allows.
      expect(await mayStop(taskId, userId), who).toBe(expected);
    }
  });

  it("a personal bot's owner sees Stop on the task in their DM with it", async () => {
    const pal = await s.newBot("Pal");
    const alexDm = (
      await ok(
        s.alex.request("POST", "/api/v1/dms", {
          participants: [{ kind: "agent", id: pal.id }],
        }) as Promise<Res>,
      )
    ).id as string;
    const { taskId } = await startTaskFor(s, {
      who: s.alex,
      conversationId: alexDm,
      agentId: pal.id,
      handle: null,
    });
    // Pal becomes Alex's personal bot (its owner is the person its DM tasks run for).
    await s.su.query("update app.agents set scope = 'personal', owner_user_id = $2 where id = $1", [
      pal.id,
      s.alexId,
    ]);
    const cardId = (await taskRow(s, taskId)).card_message_id as string;
    const card = await cardInList(s.alex, alexDm, cardId);
    expect(card.task).toMatchObject({ taskId, requesterName: "Alex Kim" });
    expect(card.viewerCan).toContain("stop");
    expect(await mayStop(taskId, s.alexId)).toBe(true);
  });

  it("once the task stops or finishes, nobody has Stop; the realtime update says stopped, with no viewer field", async () => {
    const stopped = await startTaskFor(s, {
      who: s.sam,
      conversationId: opsId,
      agentId: builderId,
      handle: "builder",
    });
    const stoppedCard = (await taskRow(s, stopped.taskId)).card_message_id as string;
    expect((await cardRead(s.sam, stoppedCard)).viewerCan).toContain("stop");
    await ok(s.sam.request("POST", `/api/v1/bot-tasks/${stopped.taskId}/stop`) as Promise<Res>);
    for (const client of [s.sam, mo, riley, s.victor]) {
      const card = await cardRead(client, stoppedCard);
      expect(card.task).toMatchObject({ status: "stopped", outcome: "stopped_by_person" });
      expect((card.task as Json).finishedAt).not.toBeNull();
      expect(card.viewerCan).not.toContain("stop");
    }
    const live = await lastEventCard(opsId, stoppedCard);
    expect(live.task).toMatchObject({
      taskId: stopped.taskId,
      status: "stopped",
      waiting: null,
      wakeAt: null,
    });
    expect(live).not.toHaveProperty("viewerCan");

    const done = await startTaskFor(s, {
      who: s.sam,
      conversationId: opsId,
      agentId: builderId,
      handle: "builder",
    });
    expect(
      (await finishAs(s, done.event, { summary: "Summarised the pack", outcome: "done" })).body,
    ).toMatchObject({ ok: true });
    const doneCard = (await taskRow(s, done.taskId)).card_message_id as string;
    for (const client of [s.sam, s.victor]) {
      const card = await cardRead(client, doneCard);
      expect(card.task).toMatchObject({ status: "done", outcome: "done" });
      expect(card.viewerCan).not.toContain("stop");
    }
  });

  it("organization B never gets A's card, and linkOf with A's ids inside B's tenant returns nothing", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const cardId = (await taskRow(s, taskId)).card_message_id as string;
    const res = await s.eve.request("GET", `/api/v1/cards/${cardId}`);
    expect(res.status).toBe(404);

    const core = s.stack.built.core;
    const cards = createTaskCards(core, createPermissionService(core));
    const inB = await core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, async (tx) => ({
      links: await cards.linkOf(tx, [cardId]),
      stop: await cards.canStop(tx, [cardId], s.eveId),
    }));
    expect(inB.links.size).toBe(0);
    expect(inB.stop.size).toBe(0);
    // In A, the same call finds it (the test reads the right ids).
    const inA = await core.db.withTenant({ organizationId: s.orgA, userId: s.samId }, async (tx) =>
      cards.linkOf(tx, [cardId]),
    );
    expect(inA.get(cardId)?.taskId).toBe(taskId);
  });
});
