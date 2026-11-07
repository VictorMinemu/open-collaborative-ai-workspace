import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import { untrustedFileBlock } from "../artifact";

/**
 * 07.15-08 (D-03, D-04, D-07, D-08, D-17; PD-06, PD-09; BRA-02, BRA-04): `POST /agent-channel/v1/attachments/read`,
 * the phase's API end to end. A bot reads a file of the conversation it answers in, decided at call time as the
 * turn's human, counted on the turn's attachment budget (never the cap of 8), tainting, audited without content.
 * Real PostgreSQL + Redis + Garage; the in-memory sandboxd.
 */

let storage: TestStorage;
let s: SandboxStack;
/** Sam's personal bot (mock model: reads images). */
let scout: { id: string; dm: string };

const READ = "ocw_attachment_read";
const enc = (text: string) => new TextEncoder().encode(text);

const read = (ev: Json, agentId: string, attachmentId: string, token?: string) =>
  s.cell("/attachments/read", { eventId: ev.eventId, agentId, attachmentId }, ...(token ? [token] : []));

const turnRow = async (eventId: string) =>
  (
    await s.su.query(
      "select tainted, tool_calls, attachment_reads, attachment_chars from app.agent_turns where event_id = $1",
      [eventId],
    )
  ).rows[0] as Json;

const auditOf = async (action: string, eventId: string) =>
  (
    await s.su.query(
      `select agent_id, user_id, actor_kind, actor_id, result, resource_type, resource_id, metadata
         from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at, id`,
      [action, eventId],
    )
  ).rows as Json[];

const callsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, decision, reason, target, status from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

const mediaTypeOf = async (attachmentId: string) =>
  (
    await s.su.query("select coalesce(content_type, declared_type) as t from app.attachments where id = $1", [
      attachmentId,
    ])
  ).rows[0]?.t as string;

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({ env: { ...storage.env } });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  const personal = await ok(
    s.sam.request("POST", "/api/v1/agents/personal", {
      name: "Scout",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    }) as Promise<Res>,
  );
  scout = { id: personal.agent.id as string, dm: personal.dmId as string };
}, 240_000);

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

describe("tracer: a personal bot reads a member's attached text file through the API", () => {
  const content = "# Notes\n\nOCW-MARKER-0715-a: ship on Friday.\n";
  let fileId: string;
  let ev: Json;

  it("Sam attaches notes.md in Scout's DM: the read answers the untrusted block, tainted, counted on its own budget", async () => {
    fileId = await uploadAttachment(s.sam, scout.dm, {
      name: "notes.md",
      type: "text/markdown",
      bytes: enc(content),
    });
    ev = await s.turnOf(s.sam, scout.dm, scout.id, { body: "read this", attachmentIds: [fileId] });
    expect(ev.turn.tools).toContain(READ);
    const before = await turnRow(ev.eventId as string);
    expect(before).toMatchObject({ tainted: false, attachment_reads: 0, attachment_chars: 0 });

    const res = await ok(read(ev, scout.id, fileId));
    expect(res).toEqual({
      kind: "text",
      attachmentId: fileId,
      name: "notes.md",
      text: untrustedFileBlock("notes.md", content),
      chars: content.length,
      truncated: false,
    });

    expect(await turnRow(ev.eventId as string)).toEqual({
      tainted: true,
      tool_calls: before.tool_calls,
      attachment_reads: 1,
      attachment_chars: content.length,
    });
  });

  it("one agent_tool_calls row, one bot.tool_call and one bot.attachment_read with the PD-09 metadata", async () => {
    const calls = await callsOf(ev.eventId as string);
    expect(calls).toEqual([{ tool: READ, decision: "allowed", reason: null, target: fileId, status: "ok" }]);
    const toolAudits = (await auditOf("bot.tool_call", ev.eventId as string)).filter(
      (a) => a.metadata.tool === READ,
    );
    expect(toolAudits).toHaveLength(1);
    expect(toolAudits[0]).toMatchObject({ agent_id: scout.id, user_id: s.samId, result: "success" });

    const reads = await auditOf("bot.attachment_read", ev.eventId as string);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      agent_id: scout.id,
      user_id: s.samId,
      actor_kind: "agent",
      actor_id: scout.id,
      result: "success",
      resource_type: "attachment",
      resource_id: fileId,
    });
    expect(reads[0]?.metadata).toEqual({
      eventId: ev.eventId,
      conversationId: scout.dm,
      attachmentId: fileId,
      kind: "text",
      mediaType: await mediaTypeOf(fileId),
      bytes: enc(content).length,
      chars: content.length,
      truncated: false,
      outcome: "ok",
    });
  });

  it("no audit row of the turn carries the file's content or its name", async () => {
    const rows = (
      await s.su.query("select * from app.audit_events where metadata->>'eventId' = $1", [ev.eventId])
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("OCW-MARKER-0715-a");
    expect(raw).not.toContain("notes.md");
  });

  it("an event id that is not this agent's turn answers 403 no_trigger", async () => {
    const other = await read({ eventId: randomUUID() }, scout.id, fileId);
    expect(other.status).toBe(403);
    expect(codeOf(other)).toBe("no_trigger");
    // Another agent naming Scout's turn is no turn of its own either.
    const foreign = await read(ev, s.scoutId, fileId);
    expect(foreign.status).toBe(403);
    expect(codeOf(foreign)).toBe("no_trigger");
  });
});
