import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { continueAs, setTask, startTaskFor, taskRow } from "../../testing-tasks";
import { createPermissionService } from "../organization";
import { lockTask, mayStopTask } from "./tasks";

/**
 * Phase 07.17.1.1.2-08 (D-05, D-07; PD-12; E18; BTASK-09): a person stops a bot's long task, `POST
 * /api/v1/bot-tasks/:id/stop`. The person it runs for, a moderator of the channel and the bot's managers may (the one
 * rule `mayStopTask`, also behind the card's Stop button); another reader is refused 403 `not_task_owner`; someone who
 * cannot read the conversation, or of another organization, gets 404 `task_not_found`. Idempotent, one audit, no thread
 * message; the in-flight turn's later continue hears `task_stopped`.
 *
 * People: Sam Lee asks (the requester); Alex Kim is another member; Víctor is the admin (a moderator of every channel and
 * the manager of team bots). Eve is organization B's admin. Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;
/** Private: Sam and Scout only. */
let opsId: string;
/** A group DM: Sam, Alex, Víctor and Scout (never moderated: only the bot's managers stop there). */
let groupId: string;

beforeAll(async () => {
  s = await startSandboxStack();
  const channel = async (name: string, visibility: "public" | "private", users: string[]) => {
    const id = (await ok(s.victor.request("POST", "/api/v1/channels", { name, visibility }) as Promise<Res>))
      .id as string;
    for (const member of [{ kind: "agent", id: s.scoutId }, ...users.map((u) => ({ kind: "user", id: u }))]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${id}/members`, member) as Promise<Res>);
    }
    return id;
  };
  engId = await channel("eng", "public", [s.samId, s.alexId]);
  opsId = await channel("ops", "private", [s.samId]);
  // Víctor created #ops; he leaves it so that only Sam reads it among the people below.
  await s.su.query(
    "delete from app.conversation_members where conversation_id = $1 and member_kind = 'user' and member_id = $2",
    [opsId, s.victorId],
  );
  groupId = (
    await ok(
      s.sam.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: s.alexId },
          { kind: "user", id: s.victorId },
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

const stop = (who: TestClient, taskId: string) => who.request("POST", `/api/v1/bot-tasks/${taskId}/stop`);

const auditsOf = async (taskId: string) =>
  (
    await s.su.query(
      "select actor_kind, actor_id, agent_id, user_id, metadata from app.audit_events where action = 'bot.task_stopped' and resource_id = $1",
      [taskId],
    )
  ).rows as Json[];

/** Every bot message in the task's thread other than its card. */
async function botMessagesOf(taskId: string): Promise<Json[]> {
  const row = await taskRow(s, taskId);
  return (
    await s.su.query(
      `select m.body from app.messages m left join app.message_cards c on c.message_id = m.id
        where m.conversation_id = $1 and m.author_kind = 'agent' and c.message_id is null
          and m.thread_id is not distinct from $2`,
      [row.conversation_id, row.thread_root_id],
    )
  ).rows as Json[];
}

/** `mayStopTask` as `userId` decides it, in a tenant transaction of organization A. */
async function mayStop(taskId: string, userId: string): Promise<boolean> {
  const core = s.stack.built.core;
  const perms = createPermissionService(core);
  return core.db.withTenant({ organizationId: s.orgA, userId }, async (tx) => {
    const task = await lockTask(tx, taskId);
    if (!task) throw new Error("task not found");
    return mayStopTask(tx, core, perms, task, userId);
  });
}

describe("the requester stops their task (PD-12)", () => {
  it("Sam stops it: stopped by a person, the card says so, one audit, no message; twice is the same answer", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    const seq = (await taskRow(s, taskId)).wait_seq as number;
    const res = await stop(s.sam, taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "stopped" });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({
      status: "stopped",
      outcome: "stopped_by_person",
      stopped_by_user_id: s.samId,
      wait_seq: seq + 1,
      wait_kind: null,
    });
    expect(row.finished_at).not.toBeNull();
    const card = (
      await s.su.query("select status, status_label, notices from app.message_cards where message_id = $1", [
        row.card_message_id,
      ])
    ).rows[0];
    expect(card).toEqual({
      status: "cancelled",
      status_label: "Stopped",
      notices: [{ tone: "neutral", text: "Stopped by Sam Lee." }],
    });
    const audits = await auditsOf(taskId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "user",
      actor_id: s.samId,
      agent_id: s.scoutId,
      user_id: s.samId,
    });
    expect(audits[0]?.metadata).toMatchObject({
      taskId,
      outcome: "stopped_by_person",
      byUserId: s.samId,
      turnsUsed: 1,
    });

    const again = await stop(s.sam, taskId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, status: "stopped" });
    expect(await auditsOf(taskId)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await botMessagesOf(taskId)).toEqual([]);

    // The in-flight turn finishes; its later continue hears the stop, and no next turn is scheduled.
    const late = await continueAs(s, event);
    expect(late.body).toMatchObject({ ok: false, code: "task_stopped" });
    expect(
      (
        await s.su.query(
          "select count(*)::int as n from pgboss.job where name = 'bot_task.continue' and data->>'taskId' = $1",
          [taskId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("a waiting task stops the same way, and its queued job will find nothing (wait_seq moved on)", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: true });
    const waiting = await taskRow(s, taskId);
    expect(waiting.status).toBe("waiting");
    expect((await stop(s.sam, taskId)).body).toEqual({ ok: true, status: "stopped" });
    const row = await taskRow(s, taskId);
    expect(row).toMatchObject({ status: "stopped", wait_kind: null, wake_at: null });
    expect(row.wait_seq).toBe((waiting.wait_seq as number) + 1);
  });
});

describe("who else may stop it (PD-12, E18)", () => {
  it("in #eng: Víctor (moderator) may; Alex (a member) is refused 403 and nothing changes", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    expect(await mayStop(taskId, s.samId)).toBe(true);
    expect(await mayStop(taskId, s.alexId)).toBe(false);
    expect(await mayStop(taskId, s.victorId)).toBe(true);

    const before = await taskRow(s, taskId);
    const refused = await stop(s.alex, taskId);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("not_task_owner");
    expect(await taskRow(s, taskId)).toEqual(before);

    const moderated = await stop(s.victor, taskId);
    expect(moderated.body).toEqual({ ok: true, status: "stopped" });
    const row = await taskRow(s, taskId);
    expect(row.stopped_by_user_id).toBe(s.victorId);
    const card = (
      await s.su.query("select notices from app.message_cards where message_id = $1", [row.card_message_id])
    ).rows[0];
    expect(card).toEqual({ notices: [{ tone: "neutral", text: "Stopped by Víctor Ruiz." }] });
  });

  it("in a group DM (never moderated): the team bot's manager may; another participant may not", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: groupId });
    expect((await taskRow(s, taskId)).thread_root_id).toBeNull();
    expect(await mayStop(taskId, s.alexId)).toBe(false);
    expect(await mayStop(taskId, s.victorId)).toBe(true);
    const refused = await stop(s.alex, taskId);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe("not_task_owner");
    expect((await stop(s.victor, taskId)).body).toEqual({ ok: true, status: "stopped" });
  });

  it("a personal bot's owner may stop a task of their bot (bot.configure)", async () => {
    const pal = await s.newBot("Pal");
    await s.su.query("update app.agents set scope = 'personal', owner_user_id = $2 where id = $1", [
      pal.id,
      s.alexId,
    ]);
    // A task row of Pal for Sam (the rule is decided on the bot alone; seeded as the start route writes it).
    const taskId = randomUUID();
    await s.su.query(
      `insert into app.bot_tasks (id, organization_id, agent_id, conversation_id, thread_root_id, requester_user_id,
         started_event_id, current_event_id, goal, max_turns, deadline_at)
       values ($1, $2, $3, $4, null, $5, $6, $6, 'Sort the inbox', 40, now() + interval '8 hours')`,
      [taskId, s.orgA, pal.id, pal.dm, s.samId, randomUUID()],
    );
    expect(await mayStop(taskId, s.alexId)).toBe(true);
    expect(await mayStop(taskId, s.samId)).toBe(true);
  });

  it("someone who cannot read the conversation gets 404; so does organization B's admin", async () => {
    const { taskId } = await startTaskFor(s, { who: s.sam, conversationId: opsId });
    for (const who of [s.alex, s.eve]) {
      const res = await stop(who, taskId);
      expect(res.status).toBe(404);
      expect(codeOf(res)).toBe("task_not_found");
    }
    const unknown = await stop(s.sam, randomUUID());
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe("task_not_found");
    expect((await taskRow(s, taskId)).status).toBe("running");
    expect(await mayStop(taskId, s.samId)).toBe(true);
  });
});

describe("Stop after the budgets' own stop (idempotent across stoppers)", () => {
  it("a task the platform already stopped answers its state and audits nothing more", async () => {
    const { taskId, event } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    await setTask(s, taskId, { turns_used: 40 });
    expect((await continueAs(s, event)).body).toMatchObject({ ok: false, code: "budget_turns" });
    expect(await auditsOf(taskId)).toHaveLength(1);
    const res = await stop(s.sam, taskId);
    expect(res.body).toEqual({ ok: true, status: "stopped" });
    expect((await taskRow(s, taskId)).outcome).toBe("budget_turns");
    expect(await auditsOf(taskId)).toHaveLength(1);
  });
});
