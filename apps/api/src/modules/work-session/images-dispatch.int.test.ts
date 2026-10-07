import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
