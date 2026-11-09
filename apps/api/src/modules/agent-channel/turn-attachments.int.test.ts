import { randomUUID } from "node:crypto";
import { ATTACHMENT_READ_FLAGS, ATTACHMENT_READ_LIMITS, TURN_ATTACHMENT_NOTES } from "@ocw/contracts";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
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
/** A team bot of the whole organization, sandbox on; Sam's DM with it. */
let ops: { id: string; dm: string };

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
  ops = await s.newBot("Ops");
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
async function deliveredTo(messageId: string, agentId: string): Promise<Json> {
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${s.orgA}`, messageId, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const csv = (who: TestClient, conv: string, name = `f-${randomUUID().slice(0, 6)}.csv`) =>
  uploadAttachment(who, conv, { name, type: "text/csv", bytes: enc("a,b\n1,2\n") });

const png = async (who: TestClient, conv: string, name = "photo.png") =>
  uploadAttachment(who, conv, {
    name,
    type: "image/png",
    bytes: await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a6" } })
      .png()
      .toBuffer(),
  });

/** Bytes nothing recognises and no text rule accepts (sniffed as opaque): the `other` kind. */
const zip = (who: TestClient, conv: string) =>
  uploadAttachment(who, conv, {
    name: "bundle.zip",
    type: "application/zip",
    bytes: new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00]),
  });

const entry = (ev: Json, id: string) => (ev.turn.attachments as Json[] | undefined)?.find((a) => a.id === id);

describe("a channel thread: the files of the turn's thread, never another thread's (D-02, Pitfall 7)", () => {
  let channel: string;

  beforeAll(async () => {
    channel = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: `files-${randomUUID().slice(0, 4)}`,
          visibility: "private",
        }) as Promise<Res>,
      )
    ).id as string;
    for (const [kind, id] of [
      ["user", s.samId],
      ["user", s.alexId],
      ["agent", ops.id],
    ] as const) {
      await ok(s.victor.request("POST", `/api/v1/channels/${channel}/members`, { kind, id }) as Promise<Res>);
    }
  });

  it("Alex's a.csv in thread T and Sam's b.png on the @ops mention in T are listed, b.png first; U's file is not", async () => {
    const root = await post(s.sam, channel, "kickoff");
    const a = await csv(s.alex, channel, "a.csv");
    await post(s.alex, channel, "numbers", { threadRootId: root, attachmentIds: [a] });
    const u = await csv(s.alex, channel, "u.csv");
    await post(s.alex, channel, "another topic", { attachmentIds: [u] });
    const b = await png(s.sam, channel, "b.png");
    const mention = await post(s.sam, channel, "@ops what do these say?", {
      threadRootId: root,
      attachmentIds: [b],
    });
    const ev = await deliveredTo(mention, ops.id);
    expect((ev.turn.attachments as Json[]).map((x) => [x.id, x.name, x.kind, x.access])).toEqual([
      [b, "b.png", "image", "read"],
      [a, "a.csv", "text", "read"],
    ]);
    expect(entry(ev, u)).toBeUndefined();
    expect(ev.turn.tools).toContain(READ);

    // Tenant isolation (the existing stream rule): organization B's cell stream never carries this turn.
    const leaked = (
      await s.su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and payload::text like $2",
        [`cell:${s.orgB}`, `%${b}%`],
      )
    ).rows[0].n;
    expect(leaked).toBe(0);
  });
});

describe("the history window, files-only messages and unsent uploads (E2, E3, E4)", () => {
  it("a file 51 messages back is outside the window: nothing listed, the tool not offered", async () => {
    const bot = await s.newBot("Window");
    const file = await csv(s.sam, bot.dm);
    const first = await s.turnOf(s.sam, bot.dm, bot.id, { body: "here", attachmentIds: [file] });
    expect(entry(first, file)?.access).toBe("read");
    // 51 later messages, written directly (no turns, no daily-limit use).
    await s.su.query(
      `insert into app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, created_at)
       select gen_random_uuid(), $1, $2, 1000000 + g, 'user', $3, 'filler ' || g, now() + g * interval '1 millisecond'
         from generate_series(1, 51) g`,
      [s.orgA, bot.dm, s.samId],
    );
    await new Promise((r) => setTimeout(r, 100));
    const ev = await s.turnOf(s.sam, bot.dm, bot.id, { body: "and the file?" });
    expect(ev.threadHistory).toHaveLength(50);
    expect(ev.turn).not.toHaveProperty("attachments");
    expect(ev.turn.tools).not.toContain(READ);
  });

  it("a files-only message is delivered with an empty text and its file listed first", async () => {
    const x = await csv(s.sam, scout.dm, "only.csv");
    const ev = await s.turnOf(s.sam, scout.dm, scout.id, { body: "", attachmentIds: [x] });
    expect(ev.message.text).toBe("");
    expect((ev.turn.attachments as Json[])[0]).toMatchObject({
      id: x,
      messageId: ev.message.id,
      access: "read",
    });
  });

  it("a presigned upload that was never completed is never listed, even after a later message", async () => {
    const pending = await uploadAttachment(
      s.sam,
      scout.dm,
      { name: "half.csv", type: "text/csv", bytes: enc("1,2\n") },
      { complete: false },
    );
    const refused = await s.sam.request("POST", `/api/v1/conversations/${scout.dm}/messages`, {
      body: "with the half file",
      attachmentIds: [pending],
    });
    expect(refused.status).toBe(409);
    const ev = await s.turnOf(s.sam, scout.dm, scout.id, { body: "anything new?" });
    expect(entry(ev, pending)).toBeUndefined();
  });

  it("21 files → 20 listed (the current message first, then the history newest first) and attachmentsMore 1", async () => {
    const bot = await s.newBot("Many");
    const older: string[] = [];
    for (let i = 0; i < 10; i++) older.push(await csv(s.sam, bot.dm));
    await post(s.sam, bot.dm, "batch one", { attachmentIds: older });
    const newer: string[] = [];
    for (let i = 0; i < 10; i++) newer.push(await csv(s.sam, bot.dm));
    await post(s.sam, bot.dm, "batch two", { attachmentIds: newer });
    const last = await csv(s.sam, bot.dm);
    const ev = await s.turnOf(s.sam, bot.dm, bot.id, { body: "all of them", attachmentIds: [last] });
    // Each message's files in upload order; uploads were sequential, so that is the order above.
    expect((ev.turn.attachments as Json[]).map((a) => a.id)).toEqual([last, ...newer, ...older].slice(0, 20));
    expect(ev.turn.attachmentsMore).toBe(1);
  });
});

describe("per bot: what its model and its sandbox let it do with each file (D-04, D-09, D-13)", () => {
  it("a text-only bot sees an image as not readable (modelNoImages); Scout (mock) reads the same image", async () => {
    const reader = await s.newBot("Reader");
    await s.su.query(
      "update app.agents set model_provider = 'openai-compatible', model_id = 'local-text-1' where id = $1",
      [reader.id],
    );
    const img = await png(s.sam, reader.dm);
    const ev = await s.turnOf(s.sam, reader.dm, reader.id, { body: "what is it?", attachmentIds: [img] });
    // A team bot in Sam's DM: its workspace is read more widely than this DM, so no import either.
    expect(entry(ev, img)).toMatchObject({
      kind: "image",
      access: "none",
      note: TURN_ATTACHMENT_NOTES.modelNoImages,
    });
    expect(ev.turn.tools).not.toContain(READ);
    expect(ev.turn).not.toHaveProperty("maxAttachmentReads");

    const same = await png(s.sam, scout.dm);
    const mine = await s.turnOf(s.sam, scout.dm, scout.id, { body: "and you?", attachmentIds: [same] });
    expect(entry(mine, same)).toMatchObject({ kind: "image", access: "read" });
    expect(entry(mine, same)).not.toHaveProperty("note");
  });

  it("a .zip: team bot Ops in Sam's DM → none (cannotReadNarrower); Scout (personal) → import (cannotReadImport)", async () => {
    const forOps = await zip(s.sam, ops.dm);
    const ev = await s.turnOf(s.sam, ops.dm, ops.id, { body: "unpack it", attachmentIds: [forOps] });
    expect(ev.turn.tools).toContain("ocw_sandbox_import");
    expect(entry(ev, forOps)).toMatchObject({
      kind: "other",
      access: "none",
      note: TURN_ATTACHMENT_NOTES.cannotReadNarrower,
    });
    expect(ev.turn.tools).not.toContain(READ);

    const forScout = await zip(s.sam, scout.dm);
    const mine = await s.turnOf(s.sam, scout.dm, scout.id, { body: "unpack it", attachmentIds: [forScout] });
    expect(entry(mine, forScout)).toMatchObject({
      kind: "other",
      access: "import",
      note: TURN_ATTACHMENT_NOTES.cannotReadImport,
    });
  });
});
