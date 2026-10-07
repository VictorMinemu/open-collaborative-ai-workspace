import { createHash, randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice, type Frame } from "../../testing-device";
import { startTestStorage, TEST_BUCKET, type TestStorage } from "../../testing-storage";
import { CLAUDE_CATALOG, connectWithProject, pairDevice, startSession } from "../../testing-workzone";
import { attachmentKey } from "../artifact";

/**
 * Phase 06.1-02 (WZ-IMG-02 budget, WZ-IMG-03 server half): a prompt's linked images reach the session's device as
 * `PromptPayload.images`, read from object storage after the flush transaction and never stored. Real PostgreSQL +
 * Redis + Garage, and a FakeDevice on the Device Link.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = Frame & { id: string; payload: Json; sessionId: string };

let storage: TestStorage;
let s3: S3Client;
/** Every log line of every stack in this file (LOG_LEVEL debug), for the leak scan. */
const logs: string[] = [];

interface Ctx {
  stack: TestStack;
  su: pg.Client;
  admin: TestClient;
  orgId: string;
  device: FakeDevice;
  deviceId: string;
  projectId: string;
  sessionId: string;
  conv: string;
}
let main: Ctx;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A stack with Víctor, his paired device (Claude Code catalog) and one idle Claude Code session. */
async function boot(): Promise<Ctx> {
  const stack = await startTestStack({
    env: { ...storage.env, LOG_LEVEL: "debug" },
    logStream: { write: (m) => void logs.push(m) },
  });
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  const { device, projectId } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_ocw",
    name: "ocw",
  });
  device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  const sessionId = await startSession(admin, device, projectId, { title: "Images" });
  const conv = (await ok(admin.request("GET", `/api/v1/work-sessions/${sessionId}`))).session.conversationId;
  return {
    stack,
    su,
    admin,
    orgId: setup.organization.id,
    device,
    deviceId: paired.deviceId,
    projectId,
    sessionId,
    conv,
  };
}

async function shutdown(ctx: Ctx | undefined) {
  if (!ctx) return;
  await ctx.device.close().catch(() => {});
  await ctx.su.end();
  await ctx.stack.stop();
}

/** presign + PUT + complete through the Phase 4 routes; returns the completed attachment. */
async function upload(ctx: Ctx, filename: string, contentType: string, bytes: Buffer): Promise<Json> {
  const p = await ok(
    ctx.admin.request("POST", `/api/v1/conversations/${ctx.conv}/attachments`, {
      filename,
      contentType,
      size: bytes.length,
    }),
  );
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  return ok(ctx.admin.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
}

async function stored(ctx: Ctx, attId: string, part: "original" | "large.webp"): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: TEST_BUCKET, Key: attachmentKey(ctx.orgId, ctx.conv, attId, part) }),
  );
  return Buffer.from(await res.Body!.transformToByteArray());
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function submit(ctx: Ctx, body: string, attachmentIds?: string[]) {
  return ctx.admin.request("POST", `/api/v1/work-sessions/${ctx.sessionId}/prompts`, {
    body,
    ...(attachmentIds ? { attachmentIds } : {}),
  });
}

/** Ack a dispatched prompt and complete its turn on the device; resolves once the session is idle again. */
async function finish(ctx: Ctx, cmd: Cmd) {
  ctx.device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  ctx.device.event(cmd.sessionId, { type: "prompt.started", promptId });
  ctx.device.event(cmd.sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  await eventually(async () => {
    const r = await ctx.su.query("select status from app.work_sessions where id = $1", [cmd.sessionId]);
    return r.rows[0].status === "idle";
  });
}

const commandRow = async (ctx: Ctx, id: string) =>
  (
    await ctx.su.query(
      "select status, error, payload, payload::text as text from app.device_commands where id = $1",
      [id],
    )
  ).rows[0] as { status: string; error: string | null; payload: Json; text: string };

/** The base64 the FakeDevice received in this file (the leak scan looks for each one's first 64 characters). */
const sentBase64: string[] = [];
function received(cmd: Cmd): Array<{ mediaType: string; bytes: Buffer }> {
  return ((cmd.payload.images ?? []) as Json[]).map((i) => {
    sentBase64.push(i.dataBase64);
    return { mediaType: i.mediaType, bytes: Buffer.from(i.dataBase64, "base64") };
  });
}

let jpeg: Buffer;

beforeAll(async () => {
  storage = await startTestStorage();
  s3 = new S3Client({
    endpoint: storage.endpoint,
    region: "garage",
    forcePathStyle: true,
    credentials: {
      accessKeyId: storage.env.OCW_S3_ACCESS_KEY_ID!,
      secretAccessKey: storage.env.OCW_S3_SECRET_ACCESS_KEY!,
    },
  });
  main = await boot();
  jpeg = await sharp({
    create: { width: 960, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}, 240_000);

afterAll(async () => {
  await shutdown(main);
  s3?.destroy();
  await storage?.stop();
});

describe("tracer: a linked image reaches the device as base64 while the database holds only its id (D-04, P-03)", () => {
  it("a JPEG goes as its large.webp rendition; device_commands keeps imageAttachmentIds only", async () => {
    const att = await upload(main, "photo.jpg", "image/jpeg", jpeg);
    const prompt = await ok(submit(main, "what is wrong here?", [att.id]));

    const cmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    expect(cmd.payload.promptId).toBe(prompt.id);
    expect(cmd.payload.imageAttachmentIds).toBeUndefined();
    const images = received(cmd);
    expect(images).toHaveLength(1);
    expect(images[0]!.mediaType).toBe("image/webp");
    expect(sha(images[0]!.bytes)).toBe(sha(await stored(main, att.id, "large.webp")));

    const row = await commandRow(main, cmd.id);
    expect(row.payload.imageAttachmentIds).toEqual([att.id]);
    expect(row.payload.images).toBeUndefined();
    expect(row.text).not.toContain(sentBase64.at(-1)!.slice(0, 64));
    expect(row.status).toBe("sent");

    const audit = await main.su.query(
      "select metadata from app.audit_events where action = 'work_prompt.dispatched' and resource_id = $1",
      [prompt.id],
    );
    expect(audit.rows[0].metadata).toMatchObject({ promptId: prompt.id, imageCount: 1 });
    await finish(main, cmd);
  });

  it("a prompt without images is delivered exactly as before", async () => {
    const prompt = await ok(submit(main, "just text"));
    const cmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    expect(cmd.payload).toEqual({ promptId: prompt.id, text: "just text", permissionMode: "default" });
    const row = await commandRow(main, cmd.id);
    expect(row.payload).toEqual({ promptId: prompt.id, text: "just text", permissionMode: "default" });
    const audit = await main.su.query(
      "select metadata from app.audit_events where action = 'work_prompt.dispatched' and resource_id = $1",
      [prompt.id],
    );
    expect(audit.rows[0].metadata.imageCount).toBeUndefined();
    await finish(main, cmd);
  });
});

const solid = (width: number, height: number, hex: string) =>
  sharp({ create: { width, height, channels: 3, background: hex } });

describe("request order: a prompt's images go in the order the sender listed them (D-02)", () => {
  it("four images listed out of upload order arrive in request order, and the prompt lists them so", async () => {
    const colors = ["#e11", "#1e1", "#11e", "#ee1"];
    const atts: Json[] = [];
    for (const [i, c] of colors.entries()) {
      atts.push(
        await upload(main, `shot-${i}.jpg`, "image/jpeg", await solid(320, 200, c).jpeg().toBuffer()),
      );
    }
    const order = [atts[2]!.id, atts[0]!.id, atts[3]!.id, atts[1]!.id];
    const prompt = await ok(submit(main, "compare these", order));
    expect(prompt.attachments.map((a: Json) => a.id)).toEqual(order);

    const cmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    expect((await commandRow(main, cmd.id)).payload.imageAttachmentIds).toEqual(order);
    const got = received(cmd).map((i) => sha(i.bytes));
    const want: string[] = [];
    for (const id of order) want.push(sha(await stored(main, id, "large.webp")));
    expect(got).toEqual(want);

    const detail = await ok(main.admin.request("GET", `/api/v1/work-sessions/${main.sessionId}`));
    const listed = (detail.prompts as Json[]).find((p) => p.id === prompt.id)!;
    expect(listed.attachments.map((a: Json) => a.id)).toEqual(order);
    await finish(main, cmd);
  });
});

/** Counts every object storage call the API makes until `restore()` (the submit path must make none). */
function spyStorage(ctx: Ctx) {
  const store = ctx.stack.built.storage!;
  const methods = ["stream", "head", "rangeGet", "presignGet", "presignPut", "put", "remove"] as const;
  const spies = methods.map((m) => vi.spyOn(store, m));
  return {
    count: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

const promptCount = async (ctx: Ctx) =>
  Number(
    (
      await ctx.su.query("select count(*)::int as n from app.work_prompts where work_session_id = $1", [
        ctx.sessionId,
      ])
    ).rows[0].n,
  );

/** A PNG of `width`×`height` whose low-entropy noise keeps it between a few hundred KB and 1 MiB at 1400×900. */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const raw = randomBytes(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i]! &= i % 3 === 0 ? 0x03 : 0x01;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe("the bytes sent are the right ones and bounded (P-02): small PNG original, else a ≤ 2000 px rendition", () => {
  it("a 1400×900 PNG under 1 MiB reaches the device as the original image/png", async () => {
    const png = await noisyPng(1400, 900);
    expect(png.length).toBeGreaterThan(512 * 1024);
    expect(png.length).toBeLessThanOrEqual(1024 * 1024);
    const att = await upload(main, "screenshot.png", "image/png", png);
    await ok(submit(main, "read the error in this screenshot", [att.id]));
    const cmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    const [image] = received(cmd);
    expect(image!.mediaType).toBe("image/png");
    expect(sha(image!.bytes)).toBe(sha(png));
    await finish(main, cmd);
  });

  it("a 2400×1500 PNG reaches the device as image/webp with a long edge of 2000", async () => {
    const png = await solid(2400, 1500, "#246").png().toBuffer();
    const att = await upload(main, "wide.png", "image/png", png);
    await ok(submit(main, "and this wide one", [att.id]));
    const cmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    const [image] = received(cmd);
    expect(image!.mediaType).toBe("image/webp");
    const meta = await sharp(image!.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 2000, 1250]);
    await finish(main, cmd);
  });
});

describe("the budget is checked at submit from recorded sizes, without a storage call (WZ-IMG-02, P-01, P-03)", () => {
  it("an image whose chosen part is over 2 MiB is 400 image_too_large; nothing is queued or linked", async () => {
    const att = await upload(main, "huge.jpg", "image/jpeg", jpeg);
    // The recorded rendition size is what the budget reads (no storage call while the session row is locked).
    await main.su.query("update app.attachments set large_bytes = $2 where id = $1", [
      att.id,
      3 * 1024 * 1024,
    ]);
    const before = await promptCount(main);
    const spy = spyStorage(main);
    try {
      const res = await submit(main, "too big", [att.id]);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body!.error).toMatchObject({
        code: "image_too_large",
        message: "huge.jpg is 3.0 MB after resizing; images can be at most 2 MB",
      });
      expect(spy.count()).toBe(0);
    } finally {
      spy.restore();
    }
    expect(await promptCount(main)).toBe(before);
    const row = (await main.su.query("select work_prompt_id from app.attachments where id = $1", [att.id]))
      .rows[0];
    expect(row.work_prompt_id).toBeNull();
  });
});

describe("a vanished image fails its prompt visibly; the link stays up and the queue moves on (P-03, Pitfall 8)", () => {
  it("the device gets no frame for it; failed, idle with lastError, audited image_unavailable; the next prompt runs", async () => {
    const first = await ok(submit(main, "first"));
    const firstCmd = (await main.device.command("prompt", main.sessionId)) as Cmd;
    expect(firstCmd.payload.promptId).toBe(first.id);

    const att = await upload(main, "gone.jpg", "image/jpeg", jpeg);
    const spy = spyStorage(main);
    let withImage: Json;
    try {
      // Queued behind a running turn: the accepted submit makes no storage call either.
      withImage = await ok(submit(main, "look at this", [att.id]));
      expect(withImage.status).toBe("queued");
      expect(spy.count()).toBe(0);
    } finally {
      spy.restore();
    }
    const third = await ok(submit(main, "third"));
    await s3.send(
      new DeleteObjectCommand({
        Bucket: TEST_BUCKET,
        Key: attachmentKey(main.orgId, main.conv, att.id, "large.webp"),
      }),
    );

    main.device.ack(firstCmd.id);
    main.device.event(main.sessionId, { type: "prompt.started", promptId: first.id });
    main.device.event(main.sessionId, {
      type: "prompt.completed",
      promptId: first.id,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const next = (await main.device.command("prompt", main.sessionId)) as Cmd;
    expect(next.payload.promptId).toBe(third.id);
    expect(main.device.pending("prompt").filter((f) => (f as Cmd).payload.promptId === withImage.id)).toEqual(
      [],
    );
    expect(main.device.closed).toBe(false);

    const cmds = await main.su.query(
      "select status, error from app.device_commands where kind = 'prompt' and payload->>'promptId' = $1",
      [withImage.id],
    );
    expect(cmds.rows).toEqual([{ status: "failed", error: "image_unavailable" }]);
    const p = await main.su.query("select status from app.work_prompts where id = $1", [withImage.id]);
    expect(p.rows[0].status).toBe("failed");
    const s = await main.su.query("select last_error from app.work_sessions where id = $1", [main.sessionId]);
    expect(s.rows[0].last_error).toBe("An attached image is no longer available");
    const audit = await main.su.query(
      "select result, metadata from app.audit_events where action = 'work_prompt.refused' and resource_id = $1",
      [withImage.id],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        result: "error",
        metadata: expect.objectContaining({ promptId: withImage.id, reason: "image_unavailable" }),
      }),
    ]);
    // The session went idle with the error before the next prompt was dispatched.
    const idle = await main.su.query(
      `select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated'
         and payload->>'status' = 'idle' and payload->>'lastError' = $2`,
      [`ws:${main.sessionId}`, "An attached image is no longer available"],
    );
    expect(idle.rows.length).toBeGreaterThan(0);
    await finish(main, next);
  });
});
