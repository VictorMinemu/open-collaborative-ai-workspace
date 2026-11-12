import { createHash, randomUUID } from "node:crypto";
import { BOT_FILE_LIMITS, RUNTIME_FILE_ROUTE } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import { connectWithProject, pairDevice, startSession } from "../../testing-workzone";
import { insertTransfer } from "./bot-files";

/**
 * 07.17.1.1-07 (D-02, D-08, PD-05, E18): the read side of a bot's file move. A device fetches the source attachment's
 * bytes from `GET /api/v1/runtime/files/:transferId` under its own device JWT, once; another device, another
 * organization, a late or replayed request get nothing, and a refusal that is not about the transfer (the JWT, a busy
 * server) never consumes it. Real PostgreSQL + Redis + Garage.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
/** The source file's name: no log line may ever carry it (P1). */
const FILE_NAME = "quarterly-plan-zebra.txt";
const FILE_TEXT = "Ship the bot file exchange.\n".repeat(64);

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let orgId: string;
let deviceA: FakeDevice;
let deviceAId: string;
let deviceAToken: string;
let jwtA: string;
let sessionId: string;
let general: string;
let attachmentId: string;
let attachmentSha: string;
const logs: string[] = [];

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fileUrl = (id: string) => `${stack.baseUrl}${RUNTIME_FILE_ROUTE}/${id}`;
const get = (id: string, token?: string) =>
  fetch(fileUrl(id), token ? { headers: { authorization: `Bearer ${token}` } } : {});

/** A tenant transaction of organization A without a user (what the API's own services use). */
function inOrg<T>(fn: (tx: Tx) => Promise<T>, organizationId = orgId): Promise<T> {
  return stack.built.core.db.withTenant({ organizationId, userId: null }, fn);
}

/** One `to_device` ledger row for device A (or `over`), naming the uploaded attachment. */
async function transfer(over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await inOrg((tx) =>
    insertTransfer(tx, {
      id,
      organizationId: orgId,
      workSessionId: sessionId,
      agentId: randomUUID(),
      eventId: randomUUID(),
      deviceId: deviceAId,
      conversationId: general,
      direction: "to_device",
      attachmentId,
      maxBytes: 25 * 1024 * 1024,
      limitSource: "organization",
      sizeBytes: Buffer.byteLength(FILE_TEXT),
      sha256: attachmentSha,
      pathLength: 12,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    }),
  );
  return id;
}

async function statusOf(id: string): Promise<{ status: string; failure: string | null }> {
  const r = await su.query("select status, failure from app.bot_work_session_files where id = $1", [id]);
  return r.rows[0] as { status: string; failure: string | null };
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({
    env: { ...storage.env, LOG_LEVEL: "info" },
    logStream: { write: (line) => void logs.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  orgId = (setup.body!.organization as { id: string }).id;
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  deviceAId = paired.deviceId;
  deviceAToken = paired.token;
  ({ device: deviceA } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_ocw",
    name: "ocw",
  }));
  const projects = (await admin.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string }>;
  sessionId = await startSession(admin, deviceA, projects[0]!.id, { title: "Files" });
  general = ((await admin.request("GET", "/api/v1/channels")).body!.channels as Array<{ id: string }>)[0]!.id;
  const bytes = new TextEncoder().encode(FILE_TEXT);
  attachmentSha = sha256(bytes);
  attachmentId = await uploadAttachment(admin, general, { name: FILE_NAME, type: "text/plain", bytes });
  jwtA = await FakeDevice.exchange(stack.baseUrl, deviceAToken);
}, 240_000);

afterAll(async () => {
  await deviceA?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("tracer: a device GETs an attachment's bytes through its transfer, under its JWT, once (D-02, D-08)", () => {
  it("streams the exact bytes with content-length and no-store, then the row is streamed; a second GET is 410", async () => {
    const id = await transfer();
    const res = await get(id, jwtA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(FILE_TEXT)));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(sha256(body)).toBe(attachmentSha);
    await eventually(async () => (await statusOf(id)).status === "streamed");

    const again = await get(id, jwtA);
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("gone");
    expect((await statusOf(id)).status).toBe("streamed");
  });

  it("answers 401 to the raw device token and to no token, and the row stays pending (PD-05)", async () => {
    const id = await transfer();
    expect((await get(id, deviceAToken)).status).toBe(401);
    expect((await get(id)).status).toBe(401);
    expect(await statusOf(id)).toEqual({ status: "pending", failure: null });
    expect((await get(id, jwtA)).status).toBe(200);
  });

  it("FakeDevice.serveFileCommand fetches a session.file.write, checks size and sha256, and acks on the link", async () => {
    const payload = {
      path: "docs/plan.txt",
      sizeBytes: Buffer.byteLength(FILE_TEXT),
      sha256: attachmentSha,
      overwrite: false,
    };
    const id = await transfer();
    await inOrg((tx) =>
      stack.built.deviceHub.enqueue(tx, {
        id,
        deviceId: deviceAId,
        workSessionId: sessionId,
        kind: "session.file.write",
        payload,
      }),
    );
    const cmd = await deviceA.command("session.file.write", sessionId);
    expect(cmd.id).toBe(id);
    const served = await deviceA.serveFileCommand(cmd, { baseUrl: stack.baseUrl, jwt: jwtA });
    expect(served).toEqual({ ok: true, error: null });
    await eventually(async () => {
      const r = await su.query("select status from app.device_commands where id = $1", [id]);
      return r.rows[0]?.status === "acked";
    });
    expect((await statusOf(id)).status).toBe("streamed");
  });

  it("FakeDevice.serveFileCommand with ackAs acks that error without a request (an old daemon)", async () => {
    const id = await transfer();
    await inOrg((tx) =>
      stack.built.deviceHub.enqueue(tx, {
        id,
        deviceId: deviceAId,
        workSessionId: sessionId,
        kind: "session.file.write",
        payload: { path: "docs/old.txt", sizeBytes: 1, sha256: null, overwrite: false },
      }),
    );
    const cmd = await deviceA.command("session.file.write", sessionId);
    const served = await deviceA.serveFileCommand(cmd, {
      baseUrl: stack.baseUrl,
      jwt: jwtA,
      ackAs: "invalid command frame",
    });
    expect(served).toEqual({ ok: false, error: "invalid command frame" });
    await eventually(async () => {
      const r = await su.query("select status, error from app.device_commands where id = $1", [id]);
      return r.rows[0]?.status === "failed" && r.rows[0]?.error === "invalid command frame";
    });
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("the Device Link still accepts the device JWT and the legacy device token (the shared check)", async () => {
    const viaToken = await FakeDevice.open(stack.baseUrl, deviceAToken);
    await viaToken.close();
    const viaJwt = await FakeDevice.open(
      stack.baseUrl,
      await FakeDevice.exchange(stack.baseUrl, deviceAToken),
    );
    await viaJwt.close();
    await expect(FakeDevice.open(stack.baseUrl, "not-a-token")).rejects.toThrow("HTTP 401");
    expect(BOT_FILE_LIMITS.concurrentTransfersPerProcess).toBe(4);
  });
});
