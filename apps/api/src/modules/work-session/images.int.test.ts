import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import { startTestStorage, TEST_BUCKET, type TestStorage } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  errorCode,
  invite,
  pairDevice,
  startSession,
} from "../../testing-workzone";
import { attachmentKey } from "../artifact";

/**
 * Phase 06.1 (WZ-IMG-02, WZ-IMG-04): images join a Work Zone prompt through the unchanged Phase 4 attachment routes
 * (presign → PUT to a real Garage → complete), scoped to the session's conversation. Every controller of the session
 * sees them on the prompt; only readers of the session load them. Real PostgreSQL + Redis + Garage.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let s3: S3Client;
let admin: TestClient;
let dana: TestClient;
let orgId: string;
let danaId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;
let general: string;
/** Víctor's Claude Code session, shared with Dana through a device grant. */
let sessionId: string;
let sessionConv: string;
let jpeg: Buffer;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A request that does not follow redirects (the attachment routes answer 302 to a presigned URL). */
function raw(client: TestClient, path: string) {
  return fetch(`${stack.baseUrl}${path}`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
}

async function presign(
  client: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  size: number,
) {
  return client.request("POST", `/api/v1/conversations/${conv}/attachments`, { filename, contentType, size });
}

/** presign + PUT + complete through the Phase 4 routes; returns the completed attachment. */
async function upload(
  client: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<Json> {
  const p = await ok(presign(client, conv, filename, contentType, bytes.length));
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  return ok(client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
}

async function objectSize(key: string): Promise<number | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: TEST_BUCKET, Key: key }));
    return (await res.Body!.transformToByteArray()).length;
  } catch {
    return null;
  }
}

/** Subscribe to a realtime topic; frames accumulate until `close()`. */
async function listen(client: TestClient, topic: string) {
  const ws = new WebSocket(
    `${stack.baseUrl.replace(/^http/, "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await client.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Json[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ op: "sub", topic }));
  await eventually(async () => frames.find((f) => f.topic === topic && f.op === "subscribed"));
  return { frames, close: () => ws.close() };
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({ env: storage.env });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  s3 = new S3Client({
    endpoint: storage.endpoint,
    region: "garage",
    forcePathStyle: true,
    credentials: {
      accessKeyId: storage.env.OCW_S3_ACCESS_KEY_ID!,
      secretAccessKey: storage.env.OCW_S3_SECRET_ACCESS_KEY!,
    },
  });
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  orgId = setup.organization.id;
  ({ client: dana, userId: danaId } = await invite(
    stack,
    admin,
    "dana@example.test",
    "Dana Kim",
    "developer",
  ));
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_ocw",
    name: "ocw",
  }));
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  await ok(
    admin.request("PUT", `/api/v1/devices/${deviceId}/grants/user/${danaId}`, { maxMode: "acceptEdits" }),
  );
  sessionId = await startSession(admin, device, projectId, { title: "Images" });
  sessionConv = (await ok(admin.request("GET", `/api/v1/work-sessions/${sessionId}`))).session.conversationId;
  general = (await ok(admin.request("GET", "/api/v1/channels"))).channels[0].id;
  jpeg = await sharp({
    create: { width: 960, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}, 240_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  s3?.destroy();
  await stack?.stop();
  await storage?.stop();
});

describe("tracer: an image uploaded into a session joins a prompt every controller sees (WZ-IMG-02, WZ-IMG-04)", () => {
  it("presign → PUT → complete → prompt with attachmentIds → snapshot, prompt.updated and previews for Dana", async () => {
    const att = await upload(admin, sessionConv, "photo.jpg", "image/jpeg", jpeg);
    expect(att).toMatchObject({ status: "ready", isImage: true, conversationId: sessionConv, width: 960 });

    const row = (await su.query("select large_bytes from app.attachments where id = $1", [att.id])).rows[0];
    const largeSize = await objectSize(attachmentKey(orgId, sessionConv, att.id, "large.webp"));
    expect(largeSize).toBeGreaterThan(0);
    expect(row.large_bytes).toBe(largeSize);

    const live = await listen(dana, `ws:${sessionId}`);
    try {
      const prompt = await ok(
        admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
          body: "what is wrong here?",
          attachmentIds: [att.id],
        }),
      );
      expect(prompt.attachments).toEqual([
        expect.objectContaining({
          id: att.id,
          isImage: true,
          previewUrl: `/api/v1/attachments/${att.id}/preview`,
          largeUrl: `/api/v1/attachments/${att.id}/large`,
        }),
      ]);

      const detail = await ok(admin.request("GET", `/api/v1/work-sessions/${sessionId}`));
      const listed = (detail.prompts as Json[]).find((p) => p.id === prompt.id)!;
      expect(listed.attachments.map((a: Json) => a.id)).toEqual([att.id]);

      const ev = await eventually(async () =>
        live.frames.find((f) => f.op === "ev" && f.type === "prompt.updated" && f.data.id === prompt.id),
      );
      expect(ev.data.attachments.map((a: Json) => a.id)).toEqual([att.id]);
      // Every prompt.updated of this prompt (queued, dispatched, …) carries the image.
      const cmd = await device.command("prompt", sessionId);
      expect(cmd.payload.promptId).toBe(prompt.id);
      await eventually(async () =>
        live.frames.find(
          (f) => f.type === "prompt.updated" && f.data.id === prompt.id && f.data.status === "dispatched",
        ),
      );
      for (const f of live.frames.filter((x) => x.type === "prompt.updated" && x.data.id === prompt.id)) {
        expect(f.data.attachments.map((a: Json) => a.id)).toEqual([att.id]);
      }
      device.ack(cmd.id);
      device.event(sessionId, { type: "prompt.started", promptId: prompt.id });
      device.event(sessionId, {
        type: "prompt.completed",
        promptId: prompt.id,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    } finally {
      live.close();
    }

    expect((await raw(dana, `/api/v1/attachments/${att.id}/preview`)).status).toBe(302);
    expect((await raw(dana, `/api/v1/attachments/${att.id}/large`)).status).toBe(302);
    await eventually(async () => {
      const r = await su.query("select status from app.work_sessions where id = $1", [sessionId]);
      return r.rows[0].status === "idle";
    });
  });

  it("an image uploaded into a channel records large_bytes too; Phase 4 behaviour is otherwise unchanged", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#09f" } })
      .png()
      .toBuffer();
    const att = await upload(admin, general, "dot.png", "image/png", png);
    expect(att).toMatchObject({ status: "ready", isImage: true, messageId: null });
    const row = (
      await su.query("select large_bytes, work_prompt_id from app.attachments where id = $1", [att.id])
    ).rows[0];
    expect(row.work_prompt_id).toBeNull();
    expect(row.large_bytes).toBe(await objectSize(attachmentKey(orgId, general, att.id, "large.webp")));
    // Unlinked: visible to its uploader only, as before.
    expect((await raw(admin, `/api/v1/attachments/${att.id}/preview`)).status).toBe(302);
    expect((await raw(dana, `/api/v1/attachments/${att.id}/preview`)).status).toBe(404);
    expect(
      errorCode(
        await admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
          body: "a channel image",
          attachmentIds: [att.id],
        }),
      ),
    ).toBe("attachment_not_linkable");
  });
});
