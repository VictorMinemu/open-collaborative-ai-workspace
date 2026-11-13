import { randomUUID } from "node:crypto";
import { BUILTIN_TOOLS, type TurnToolFlags } from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import {
  botMessagesOf,
  continueAs,
  continuedTask,
  drainTaskJobs,
  finishAs,
  reportTurnDone,
  startTaskFor,
  taskEvents,
  taskRow,
} from "../../testing-tasks";
import { invite } from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { claimToolCall } from "./claim";
import { continueBotTask } from "./task-wakes";

/**
 * Phase 07.17.1.1.2-09 (D-07, D-08; PD-15; BTASK-11; E10, E12, E22, E26): every continuation is decided again for the
 * person it runs for, at delivery. A task never acts for someone who lost access (removed from a private channel,
 * deactivated), never outlives its bot (disabled, archived, removed from the conversation) or its card, never delivers
 * after it was stopped or finished, never sheds the taint of what one of its turns read, and never crosses into another
 * organization. A stop for lost access or a lost bot leaves a card notice and posts no message.
 *
 * People: Sam Lee asks (the requester); Víctor is the admin. Scout is the team bot.
 */

let s: SandboxStack;
let engId: string;
let opsId: string;

/** An MCP tool whose output is untrusted: claiming it taints the turn, as `/tool-calls` does. */
const OUTSIDE: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
const READ: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };

const ACCESS_LOST = "Stopped: the person it runs for can no longer read this conversation.";
const BOT_GONE = "Stopped: the bot is not available here any more.";

beforeAll(async () => {
  s = await startSandboxStack();
  const channel = async (name: string, visibility: "public" | "private", members: Json[]) => {
    const id = (await ok(s.victor.request("POST", "/api/v1/channels", { name, visibility }) as Promise<Res>))
      .id as string;
    for (const member of members) {
      await ok(s.victor.request("POST", `/api/v1/channels/${id}/members`, member) as Promise<Res>);
    }
    return id;
  };
  engId = await channel("eng", "public", [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
  ]);
  opsId = await channel("ops", "private", [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
  ]);
  await ok(s.victor.request("PUT", "/api/v1/bot-policy", { tasks: { maxRunning: 100 } }) as Promise<Res>);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

const core = () => s.stack.built.core;
const deps = () => ({ perms: createPermissionService(core()) });

/** `claimToolCall` on `eventId`'s turn as its human (what the tool routes do), with `flags`. */
async function claimOn(eventId: string, tool: string, flags: TurnToolFlags, target: string | null = null) {
  const [human] = (await s.su.query("select user_id from app.agent_turns where event_id = $1", [eventId]))
    .rows;
  return core().db.withTenant({ organizationId: s.orgA, userId: human.user_id as string }, async (tx: Tx) => {
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, eventId));
    if (!turn) throw new Error(`no turn ${eventId}`);
    return claimToolCall(tx, core(), {
      cell: { organizationId: s.orgA, cellId: "test", credentialId: "env", source: "env" as const },
      turn,
      tool,
      flags,
      web: false,
      sourceKind: flags.untrustedOutput ? "mcp" : "builtin",
      sourceId: null,
      target,
      reason: null,
      metadata: { eventId },
    });
  });
}

const turnOf = async (eventId: string) =>
  (
    await s.su.query(
      "select user_id, task_id, tainted, session_output_read from app.agent_turns where event_id = $1",
      [eventId],
    )
  ).rows[0] as Json;

const noticesOf = async (messageId: string) =>
  (
    (await s.su.query("select notices from app.message_cards where message_id = $1", [messageId]))
      .rows[0] as Json
  ).notices as Json[];

/** No turn, stopped with `outcome`, the card's `notice`, one audit, and no message (after a settle). */
async function expectStoppedQuietly(taskId: string, outcome: string, notice: string) {
  expect(await taskEvents(s, taskId)).toEqual([]);
  const row = await taskRow(s, taskId);
  expect(row).toMatchObject({ status: "stopped", outcome, wait_kind: null });
  expect(await noticesOf(row.card_message_id as string)).toEqual([{ tone: "neutral", text: notice }]);
  const stops = (
    await s.su.query(
      "select metadata from app.audit_events where action = 'bot.task_stopped' and resource_id::text = $1",
      [taskId],
    )
  ).rows as Json[];
  expect(stops).toHaveLength(1);
  expect(stops[0]?.metadata).toMatchObject({ taskId, outcome });
  await new Promise((r) => setTimeout(r, 300));
  expect(await botMessagesOf(s, taskId)).toEqual([]);
}

describe("the person it runs for lost access (D-07, E10)", () => {
  it("Sam removed from the private channel after the continue: no turn, access_lost, a card notice, no message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: opsId });
    await ok(s.victor.request("DELETE", `/api/v1/channels/${opsId}/members/user/${s.samId}`) as Promise<Res>);
    try {
      await drainTaskJobs(s);
      await expectStoppedQuietly(taskId, "access_lost", ACCESS_LOST);
    } finally {
      await ok(
        s.victor.request("POST", `/api/v1/channels/${opsId}/members`, {
          kind: "user",
          id: s.samId,
        }) as Promise<Res>,
      );
    }
  });

  it("the requester deactivated after the continue: no turn, access_lost, no message", async () => {
    const dana = await invite(
      s.stack,
      s.victor,
      `dana-${randomUUID().slice(0, 6)}@example.test`,
      "Dana Reyes",
      "standard",
    );
    await ok(
      s.victor.request("POST", `/api/v1/channels/${engId}/members`, {
        kind: "user",
        id: dana.userId,
      }) as Promise<Res>,
    );
    const { taskId } = await continuedTask(s, { who: dana.client, conversationId: engId });
    await ok(s.victor.request("POST", `/api/v1/members/${dana.userId}/deactivate`) as Promise<Res>);
    await drainTaskJobs(s);
    await expectStoppedQuietly(taskId, "access_lost", ACCESS_LOST);
  });
});

describe("the bot or the card is gone (D-07, E10, E26)", () => {
  it("the bot disabled while the task waits: bot_unavailable, no message", async () => {
    const bot = await s.newBot("Ranger");
    const { taskId } = await continuedTask(s, {
      who: s.sam,
      conversationId: bot.dm,
      agentId: bot.id,
      handle: null,
    });
    await s.su.query("update app.agents set status = 'disabled' where id = $1", [bot.id]);
    await drainTaskJobs(s);
    await expectStoppedQuietly(taskId, "bot_unavailable", BOT_GONE);
  });

  it("the bot archived while the task waits: bot_unavailable, no message", async () => {
    const bot = await s.newBot("Keeper");
    const { taskId } = await continuedTask(s, {
      who: s.sam,
      conversationId: bot.dm,
      agentId: bot.id,
      handle: null,
    });
    await s.su.query("update app.agents set deleted_at = now() where id = $1", [bot.id]);
    await drainTaskJobs(s);
    await expectStoppedQuietly(taskId, "bot_unavailable", BOT_GONE);
  });

  it("the bot removed from the channel while the task waits: bot_unavailable, no message", async () => {
    const bot = await s.newBot("Scribe");
    const docs = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", { name: "docs", visibility: "public" }) as Promise<Res>,
      )
    ).id as string;
    for (const member of [
      { kind: "agent", id: bot.id },
      { kind: "user", id: s.samId },
    ]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${docs}/members`, member) as Promise<Res>);
    }
    const { taskId } = await continuedTask(s, {
      who: s.sam,
      conversationId: docs,
      agentId: bot.id,
      handle: "scribe",
    });
    await ok(s.victor.request("DELETE", `/api/v1/channels/${docs}/members/agent/${bot.id}`) as Promise<Res>);
    await drainTaskJobs(s);
    await expectStoppedQuietly(taskId, "bot_unavailable", BOT_GONE);
  });

  it("the task card deleted while the task waits: access_lost, no message", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    const row = await taskRow(s, taskId);
    await s.su.query("update app.messages set deleted_at = now() where id = $1", [row.card_message_id]);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "stopped", outcome: "access_lost" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await botMessagesOf(s, taskId)).toEqual([]);
  });
});

describe("a task that ended is never delivered", () => {
  it("stopped by Sam between the continue and the drain: nothing", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await ok(s.sam.request("POST", `/api/v1/bot-tasks/${taskId}/stop`) as Promise<Res>);
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "stopped", outcome: "stopped_by_person" });
  });

  it("finished between the continue and the drain: nothing", async () => {
    const { taskId, start } = await continuedTask(s, { who: s.sam, conversationId: engId });
    expect((await finishAs(s, start, { summary: "Done early", outcome: "done" })).body).toMatchObject({
      ok: true,
    });
    await drainTaskJobs(s);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskRow(s, taskId)).toMatchObject({ status: "done" });
  });
});

describe("taint is sticky across the task's turns (D-08, PD-15, E12)", () => {
  it("turn 2 reads outside content after its continue: turns 3 and 4 start tainted, and so does the task", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    expect(second?.turn.tainted).toBeUndefined();
    expect((await continueAs(s, second as Json)).body).toMatchObject({ ok: true });
    // After the continue call, the turn reads an MCP result (untrusted output).
    await claimOn(second?.eventId as string, "crm_read", OUTSIDE);
    expect((await turnOf(second?.eventId as string)).tainted).toBe(true);
    expect((await reportTurnDone(s, second?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [, third] = await taskEvents(s, taskId);
    expect(third?.turn.tainted).toBe(true);
    expect((await turnOf(third?.eventId as string)).tainted).toBe(true);
    expect((await taskRow(s, taskId)).tainted).toBe(true);

    // Turn 3 reads nothing; turn 4 is tainted all the same.
    expect((await continueAs(s, third as Json)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, third?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [, , fourth] = await taskEvents(s, taskId);
    expect(fourth?.turn.tainted).toBe(true);
    expect((await turnOf(fourth?.eventId as string)).tainted).toBe(true);
  });

  it("a task started on a tainted turn has every turn tainted", async () => {
    const { taskId, event: start } = await startTaskFor(s, { who: s.sam, conversationId: engId });
    // The start turn read outside content before it continued; the row itself was created untainted.
    await claimOn(start.eventId as string, "crm_read", OUTSIDE);
    expect((await continueAs(s, start)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, start.eventId as string)).status).toBe(200);
    expect((await taskRow(s, taskId)).tainted).toBe(false);
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    expect(second?.turn.tainted).toBe(true);
    expect((await turnOf(second?.eventId as string)).tainted).toBe(true);
    expect((await taskRow(s, taskId)).tainted).toBe(true);
  });

  it("a task turn read its Work Zone session's output: the next task turn starts with session_output_read", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    expect((await turnOf(second?.eventId as string)).session_output_read).toBe(false);
    // The allowed `ocw_work_session_read` record its route leaves (the session id as the target).
    await claimOn(second?.eventId as string, BUILTIN_TOOLS.workSessionRead, READ, randomUUID());
    expect((await continueAs(s, second as Json)).body).toMatchObject({ ok: true });
    expect((await reportTurnDone(s, second?.eventId as string)).status).toBe(200);
    await drainTaskJobs(s);
    const [, third] = await taskEvents(s, taskId);
    expect((await turnOf(third?.eventId as string)).session_output_read).toBe(true);
  });
});

describe("organization B (E22, P5)", () => {
  it("a bot_task.continue job naming organization B and A's task delivers nothing and changes nothing", async () => {
    const { taskId } = await continuedTask(s, { who: s.sam, conversationId: engId });
    const before = await taskRow(s, taskId);
    expect(await continueBotTask(core(), deps(), { organizationId: s.orgB, taskId })).toBe("none");
    expect(await taskRow(s, taskId)).toEqual(before);
    expect(await taskEvents(s, taskId)).toEqual([]);
    expect(await taskEvents(s, taskId, s.orgB)).toEqual([]);
  });

  it("organization B's cell reporting done for A's task turn: 404, and A's task is untouched", async () => {
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const { taskId, start } = await continuedTask(s, { who: s.sam, conversationId: engId });
    // A second turn of A's task, not yet reported done.
    await drainTaskJobs(s);
    const [second] = await taskEvents(s, taskId);
    expect((await continueAs(s, second as Json)).body).toMatchObject({ ok: true });
    const before = await taskRow(s, taskId);
    const res = await reportTurnDone(s, second?.eventId as string, "replied", { token: tokenB });
    expect(res.status).toBe(404);
    expect(await taskRow(s, taskId)).toEqual(before);
    expect(
      (await s.su.query("select done_at from app.agent_turns where event_id = $1", [second?.eventId]))
        .rows[0],
    ).toEqual({
      done_at: null,
    });
    expect(start.eventId).not.toBe(second?.eventId);
  });
});
