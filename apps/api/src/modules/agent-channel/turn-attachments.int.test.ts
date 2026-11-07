import { ATTACHMENT_READ_FLAGS, ATTACHMENT_READ_LIMITS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";

/**
 * 07.15-07 (D-02, D-04, PD-03, PD-04; BRA-01): the turn the API delivers lists, as metadata only, the files of the
 * messages it reads (the current message first, then the history window newest first), with how this bot can read each,
 * and offers `ocw_attachment_read` exactly when one of them is readable. Real PostgreSQL + Redis + Garage; the
 * in-memory sandboxd.
 */

let storage: TestStorage;
let s: SandboxStack;
/** Sam's personal bot (its workspace audience is Sam alone). */
let scout: { id: string; dm: string };

const READ = "ocw_attachment_read";
const enc = (text: string) => new TextEncoder().encode(text);

const turnTools = async (eventId: string) =>
  (await s.su.query("select tools from app.agent_turns where event_id = $1", [eventId])).rows[0]
    ?.tools as string[];

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({ env: { ...storage.env } });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  await s.setPolicy({ enabled: true });
  await s.su.query("update app.sandbox_policies set max_sandboxes = 50 where organization_id = $1", [s.orgA]);
  const personal = await ok(
    s.sam.request("POST", "/api/v1/agents/personal", {
      name: "Scout",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    }) as Promise<Res>,
  );
  scout = { id: personal.agent.id as string, dm: personal.dmId as string };
  await s.setBotSandbox(scout.id, true);
}, 240_000);

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

describe("tracer: a member's message with a file yields a turn that lists it and offers ocw_attachment_read", () => {
  let fileId: string;
  let firstMessageId: string;

  it("Sam sends notes.md in Scout's DM: one read entry, the budget fields and the tool with its flags", async () => {
    const bytes = enc("# Notes\n\nShip on Friday.\n");
    fileId = await uploadAttachment(s.sam, scout.dm, { name: "notes.md", type: "text/markdown", bytes });
    const ev = await s.turnOf(s.sam, scout.dm, scout.id, { body: "read this", attachmentIds: [fileId] });
    firstMessageId = ev.message.id as string;
    expect(ev.message.text).toBe("read this");
    expect(ev.turn.attachments).toEqual([
      {
        id: fileId,
        messageId: firstMessageId,
        name: "notes.md",
        // What the API sniffed (text has no magic bytes): the kind is what tells the bot it reads as text.
        mediaType: "application/octet-stream",
        size: bytes.length,
        kind: "text",
        access: "read",
      },
    ]);
    expect(ev.turn).not.toHaveProperty("attachmentsMore");
    expect(ev.turn.maxAttachmentReads).toBe(ATTACHMENT_READ_LIMITS.readsPerTurn);
    expect(ev.turn.maxAttachmentChars).toBe(ATTACHMENT_READ_LIMITS.charsPerTurn);
    expect(ev.turn.tools).toContain(READ);
    expect(ev.turn.toolFlags[READ]).toEqual(ATTACHMENT_READ_FLAGS);
    expect(await turnTools(ev.eventId as string)).toContain(READ);
    // Metadata only: no storage key, URL or content anywhere in the turn.
    const raw = JSON.stringify(ev.turn);
    expect(raw).not.toContain("Ship on Friday");
    expect(raw).not.toMatch(/https?:\/\/|attachments\/[0-9a-f-]{36}\//u);
  });

  it("Sam's next message without a file still lists the earlier one (history window) and offers the tool", async () => {
    const ev = await s.turnOf(s.sam, scout.dm, scout.id, { body: "and now?" });
    expect((ev.turn.attachments as Json[]).map((a) => [a.id, a.messageId, a.access])).toEqual([
      [fileId, firstMessageId, "read"],
    ]);
    expect(ev.turn.tools).toContain(READ);
    expect(await turnTools(ev.eventId as string)).toContain(READ);
  });

  it("a DM with no file anywhere: no attachments, no budget fields, no ocw_attachment_read", async () => {
    const ev = await s.turnOf(s.sam, s.samDm, s.scoutId, { body: "hello" });
    for (const key of ["attachments", "attachmentsMore", "maxAttachmentReads", "maxAttachmentChars"]) {
      expect(ev.turn).not.toHaveProperty(key);
    }
    expect(ev.turn.tools).not.toContain(READ);
    expect(ev.turn.toolFlags).not.toHaveProperty(READ);
    expect(await turnTools(ev.eventId as string)).not.toContain(READ);
  });
});
