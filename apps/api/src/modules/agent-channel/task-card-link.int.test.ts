import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { continueAs, startTaskFor, taskRow } from "../../testing-tasks";

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
