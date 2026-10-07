import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import { type AiStack, seedPlan, startAiStack, withoutTitles } from "../../testing-ai";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { invite } from "../../testing-workzone";
import { attachmentKey, createObjectStorage, type ObjectStorage } from "../artifact";

/**
 * AICHAT-08 (05-12): files and images in AI chats through the Phase 4 upload pipeline. Presign in the member's own
 * AI chat → PUT straight to a real Garage container → complete (sniff, EXIF-free renditions) → the send links the
 * file to the user message → the turn reads the bytes server-side (`large.webp` for images) and hands them to the
 * provider inline. No storage URL, internal host or API path ever reaches the model. Attachments are private to
 * the chat's owner (P-03): another member and the admin get 404 everywhere. Real PostgreSQL + Redis + Garage, the
 * in-process fake model.
 */

let storage: TestStorage;
let stack: AiStack;
let su: pg.Client;
let objects: ObjectStorage;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let orgId: string;
let samId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const errorOf = (r: { body: Record<string, unknown> | null }) => (r.body as Json | null)?.error as Json;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A request that does not follow redirects (downloads answer 302 to a presigned URL). */
function raw(client: TestClient, path: string) {
  return fetch(`${stack.baseUrl}${path}`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
}

const draft = async (as: TestClient) => ok(as.request("POST", "/api/v1/ai-chats/drafts", {}), 201);

const send = (as: TestClient, chatId: string, body: string, extra: Json = {}) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
    ...extra,
  });

async function presign(as: TestClient, conv: string, filename: string, contentType: string, size: number) {
  return as.request("POST", `/api/v1/conversations/${conv}/attachments`, { filename, contentType, size });
}

/** presign + PUT (+ complete unless `complete: false`): the attachment DTO. */
async function upload(
  as: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  opts: { complete?: boolean } = {},
): Promise<Json> {
  const p = await ok(presign(as, conv, filename, contentType, bytes.length));
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  if (opts.complete === false) return p.attachment;
  return ok(as.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
}

const generationCount = async (conv: string) =>
  Number(
    (await su.query("select count(*)::int as n from app.ai_generations where conversation_id = $1", [conv]))
      .rows[0].n,
  );

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Sends, waits for the answer and returns {response, final assistant body}. */
async function turn(as: TestClient, chatId: string, body: string, extra: Json = {}) {
  const res = await ok(send(as, chatId, body, extra), 201);
  const g = await settled(res.generation.id);
  const msg = (await su.query("select body from app.messages where id = $1", [g.assistant_message_id]))
    .rows[0];
  return { res, generation: g, answer: msg.body as string };
}

/** A 640×480 PNG with some structure (sharp re-encodes it; the large rendition is a real webp). */
async function samplePng(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="640" height="480"><circle cx="320" cy="240" r="120" fill="#f5a623"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
}

async function objectBytes(key: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of await objects.stream(key)) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** Decodes an `image_url` / `file_data` data URL (or a bare base64 string). */
function dataBytes(v: string): Buffer {
  const comma = v.startsWith("data:") ? v.indexOf(",") : -1;
  return Buffer.from(comma >= 0 ? v.slice(comma + 1) : v, "base64");
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startAiStack({ env: storage.env });
  objects = createObjectStorage(stack.env, createEnvFileSecretStore(storage.env))!;
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex } = await invite(stack, admin, "alex@example.test", "Alex Kim", "standard"));
  await seedPlan(sam);
  await seedPlan(alex);
  // Attachments report `enabled` once the API configured bucket CORS in the background.
  for (let i = 0; i < 100; i++) {
    const cfg = await ok(sam.request("GET", "/api/v1/attachments/config"));
    if (cfg.enabled) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("drafts (a conversation to upload into before the first message)", () => {
  it("POST /ai-chats/drafts → 201 empty owner-only chat, audited as a draft; hidden from the list until used", async () => {
    const d = await draft(sam);
    expect(d).toMatchObject({ title: "New chat", archived: false, generating: false });
    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${d.id}`));
    expect(snap.messages).toEqual([]);
    const list = await ok(sam.request("GET", "/api/v1/ai-chats"));
    expect(list.chats.map((c: Json) => c.id)).not.toContain(d.id);
    const audits = (
      await su.query(
        "select metadata from app.audit_events where action = 'ai_chat.created' and resource_id = $1",
        [d.id],
      )
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ conversationId: d.id, draft: true });

    await turn(sam, d.id, "hello draft");
    const after = await ok(sam.request("GET", "/api/v1/ai-chats"));
    expect(after.chats.map((c: Json) => c.id)).toContain(d.id);
    // The first send names the draft like a new chat would.
    expect(after.chats.find((c: Json) => c.id === d.id).title).not.toBe("New chat");
  });

  it("another member and the admin get 404 on a draft", async () => {
    const d = await draft(sam);
    expect((await alex.request("GET", `/api/v1/ai-chats/${d.id}`)).status).toBe(404);
    expect((await admin.request("GET", `/api/v1/ai-chats/${d.id}`)).status).toBe(404);
  });
});

describe("an image reaches a vision model as server-read bytes (T-05-12-01)", () => {
  it("upload in the AI chat → ready with renditions → send links it → the plan gets input_image = large.webp bytes", async () => {
    const d = await draft(sam);
    const png = await samplePng();
    const att = await upload(sam, d.id, "diagram.png", "image/png", png);
    expect(att).toMatchObject({ status: "ready", isImage: true, contentType: "image/png", messageId: null });

    stack.fake.reset();
    const { res, answer } = await turn(sam, d.id, "what is this?", { attachmentIds: [att.id] });
    expect(res.userMessage.attachments.map((a: Json) => a.id)).toEqual([att.id]);
    expect(answer).toMatch(/ \[images:1\]$/u);

    const snap = await ok(sam.request("GET", `/api/v1/ai-chats/${d.id}`));
    const user = snap.messages.find((m: Json) => m.authorKind === "user");
    expect(user.attachments).toHaveLength(1);
    expect(user.attachments[0]).toMatchObject({ id: att.id, isImage: true, messageId: user.id });

    const calls = withoutTitles(stack.fake.requests("responses"));
    expect(calls).toHaveLength(1);
    const userItem = (calls[0]!.body!.input as Json[]).filter((i) => i.role === "user").at(-1)!;
    const images = (userItem.content as Json[]).filter((p) => p.type === "input_image");
    expect(images).toHaveLength(1);
    const large = await objectBytes(attachmentKey(orgId, d.id, att.id, "large.webp"));
    expect(sha(dataBytes(images[0]!.image_url))).toBe(sha(large));
    expect(images[0]!.image_url).toMatch(/^data:image\/webp;base64,/u);

    const wire = JSON.stringify(calls[0]!.body);
    expect(wire).not.toContain(new URL(storage.endpoint).host);
    expect(wire).not.toMatch(/x-amz-/iu);
    expect(wire).not.toContain("/api/v1/attachments");
    expect(wire).not.toContain(att.id);
  });

  it("the owner downloads and previews (302); Alex and the admin get 404 on presign, download and renditions (T-05-12-03)", async () => {
    const d = await draft(sam);
    const att = await upload(sam, d.id, "photo.png", "image/png", await samplePng());
    await turn(sam, d.id, "look", { attachmentIds: [att.id] });

    for (const path of ["download", "preview", "large"]) {
      expect((await raw(sam, `/api/v1/attachments/${att.id}/${path}`)).status).toBe(302);
      for (const other of [alex, admin]) {
        expect((await raw(other, `/api/v1/attachments/${att.id}/${path}`)).status).toBe(404);
      }
    }
    for (const other of [alex, admin]) {
      const r = await presign(other, d.id, "x.png", "image/png", 10);
      expect(r.status).toBe(404);
    }
  });
});

describe("only the sender's own ready, unlinked uploads of this chat can be linked (T-05-12-02)", () => {
  it("Alex's upload in his own chat, an already linked id and a pending id → 409 attachment_not_linkable, no generation", async () => {
    const mine = await draft(sam);
    const alexChat = await draft(alex);
    const alexFile = await upload(alex, alexChat.id, "a.png", "image/png", await samplePng());
    const linked = await upload(sam, mine.id, "b.png", "image/png", await samplePng());
    await turn(sam, mine.id, "first", { attachmentIds: [linked.id] });
    const pending = await upload(sam, mine.id, "c.png", "image/png", await samplePng(), { complete: false });

    const before = await generationCount(mine.id);
    stack.fake.reset();
    for (const id of [alexFile.id, linked.id, pending.id]) {
      const r = await send(sam, mine.id, "again", { attachmentIds: [id] });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(errorOf(r).code).toBe("attachment_not_linkable");
    }
    expect(await generationCount(mine.id)).toBe(before);
    expect(withoutTitles(stack.fake.requests())).toEqual([]);

    // Alex cannot attach Sam's file to his own chat either.
    const fresh = await upload(sam, mine.id, "d.png", "image/png", await samplePng());
    const r = await send(alex, alexChat.id, "steal", { attachmentIds: [fresh.id] });
    expect(r.status).toBe(409);
  });

  it("a new chat (POST /ai-chats) cannot carry ids: files belong to an existing chat", async () => {
    const d = await draft(sam);
    const f = await upload(sam, d.id, "e.png", "image/png", await samplePng());
    const r = await sam.request("POST", "/api/v1/ai-chats", {
      clientMessageId: cid(),
      body: "new",
      model: PLAN_MODEL,
      attachmentIds: [f.id],
    });
    expect(r.status).toBe(409);
    expect(errorOf(r).code).toBe("attachment_not_linkable");
    expect(samId).toBeTruthy();
  });
});
