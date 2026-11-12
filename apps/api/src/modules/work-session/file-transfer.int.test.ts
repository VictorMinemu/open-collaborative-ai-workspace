import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { BOT_FILE_LIMITS, RUNTIME_FILE_ROUTE } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { startTestStorage, type TestStorage, uploadAttachment } from "../../testing-storage";
import { connectWithProject, invite, pairDevice, startSession } from "../../testing-workzone";
import { attachmentKey, createObjectStorage, type ObjectStorage } from "../artifact";
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
/** The busy test's source: big enough that a reader who never reads holds its stream open (socket buffers fill). */
const BIG_NAME = "board-minutes-walrus.txt";
const BIG_BYTES = 32 * 1024 * 1024;

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
let bigId: string;
/** Device B: another device of organization A, with its own valid JWT. */
let jwtB: string;
/** Organization B's device JWT. */
let jwtOrgB: string;
/** A device of organization A revoked after it got its JWT. */
let jwtRevoked: string;
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
    env: { ...storage.env, LOG_LEVEL: "info", OCW_ATTACHMENT_MAX_BYTES: String(64 * 1024 * 1024) },
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
  const big = new Uint8Array(BIG_BYTES).fill(0x61);
  bigId = await uploadAttachment(admin, general, { name: BIG_NAME, type: "text/plain", bytes: big });

  const b = await pairDevice(stack, admin, "Lab box");
  jwtB = await FakeDevice.exchange(stack.baseUrl, b.token);
  const c = await pairDevice(stack, admin, "Old laptop");
  jwtRevoked = await FakeDevice.exchange(stack.baseUrl, c.token);
  const revoked = await admin.request("DELETE", `/api/v1/devices/${c.deviceId}`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

  // Organization B: Eve leaves A and becomes the admin of her own organization (the 07.5 / 07.9 matrix pattern).
  const { client: eve, userId: eveId } = await invite(stack, admin, "eve@example.test", "Eve", "developer");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  const eveDevice = await pairDevice(stack, eve, "Eve's box");
  jwtOrgB = await FakeDevice.exchange(stack.baseUrl, eveDevice.token);
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

describe("only the right device, once, in time; a busy server never burns the transfer (PD-05, E18)", () => {
  it("another device of the organization gets 404 and the row is untouched", async () => {
    const id = await transfer();
    const res = await get(id, jwtB);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(await statusOf(id)).toEqual({ status: "pending", failure: null });
  });

  it("organization B's device gets 404 for organization A's transfer id (RLS hides it)", async () => {
    const id = await transfer();
    expect((await get(id, jwtOrgB)).status).toBe(404);
    expect(await statusOf(id)).toEqual({ status: "pending", failure: null });
  });

  it("a row past expires_at and a row already failed answer 410, and stay as they were", async () => {
    const late = await transfer({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await get(late, jwtA)).status).toBe(410);
    expect(await statusOf(late)).toEqual({ status: "pending", failure: null });
    const failed = await transfer({ status: "failed", failure: "transfer_timeout" });
    expect((await get(failed, jwtA)).status).toBe(410);
    expect(await statusOf(failed)).toEqual({ status: "failed", failure: "transfer_timeout" });
  });

  it("a revoked device's JWT and a JWT naming another organization for the device answer 401", async () => {
    const id = await transfer();
    expect((await get(id, jwtRevoked)).status).toBe(401);
    // The device principal's `device.link` is decided in the JWT's organization: there, device A does not exist.
    const elsewhere = await stack.built.core.identity.signDeviceAccessToken({
      deviceId: deviceAId,
      organizationId: randomUUID(),
    });
    expect((await get(id, elsewhere.token)).status).toBe(401);
    expect(await statusOf(id)).toEqual({ status: "pending", failure: null });
  });

  it("a GET of a from_device row answers 404", async () => {
    const id = await transfer({ direction: "from_device", sizeBytes: null, sha256: null });
    expect((await get(id, jwtA)).status).toBe(404);
    expect(await statusOf(id)).toEqual({ status: "pending", failure: null });
  });

  it("a source attachment no longer ready answers 410 and fails the row (not_found)", async () => {
    const gone = await uploadAttachment(admin, general, {
      name: "deleted-notes.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("soon gone"),
    });
    await su.query("update app.attachments set status = 'deleted' where id = $1", [gone]);
    const id = await transfer({ attachmentId: gone });
    expect((await get(id, jwtA)).status).toBe(410);
    expect((await statusOf(id)).failure).toBe("not_found");
  });

  it("four slow streams make a fifth GET 503 busy with its row still pending; once one ends, the fifth streams", async () => {
    const max = BOT_FILE_LIMITS.concurrentTransfersPerProcess;
    const big = { attachmentId: bigId, sizeBytes: BIG_BYTES, sha256: null };
    const held: Array<{ id: string; res: Response; abort: AbortController }> = [];
    try {
      for (let i = 0; i < max; i++) {
        const id = await transfer(big);
        const abort = new AbortController();
        const res = await fetch(fileUrl(id), {
          headers: { authorization: `Bearer ${jwtA}` },
          signal: abort.signal,
        });
        expect(res.status).toBe(200);
        held.push({ id, res, abort });
      }
      for (const h of held) expect((await statusOf(h.id)).status).toBe("streaming");

      const fifth = await transfer();
      const refused = await get(fifth, jwtA);
      expect(refused.status).toBe(503);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("busy");
      expect(await statusOf(fifth)).toEqual({ status: "pending", failure: null });

      const first = held.shift()!;
      expect((await first.res.arrayBuffer()).byteLength).toBe(BIG_BYTES);
      await eventually(async () => (await statusOf(first.id)).status === "streamed");

      const retried = await get(fifth, jwtA);
      expect(retried.status).toBe(200);
      expect(sha256(new Uint8Array(await retried.arrayBuffer()))).toBe(attachmentSha);
      await eventually(async () => (await statusOf(fifth)).status === "streamed");
    } finally {
      for (const h of held) h.abort.abort();
    }
    // A stream the reader dropped is over: its row is failed, never left streaming.
    for (const h of held) {
      await eventually(async () => (await statusOf(h.id)).failure === "transfer_failed");
    }
  });

  it("no captured log line carries a source file name; the route logs ids and codes (P1)", () => {
    const all = logs.join("");
    expect(all).toContain('"code":"busy"');
    expect(all).toContain('"code":"streamed"');
    for (const name of [FILE_NAME, BIG_NAME, "deleted-notes.txt"]) expect(all).not.toContain(name);
  });
});

/**
 * 07.17.1.1-08 (D-03, D-07, D-08, PD-05, PD-17, E21): the write side. The device PUTs one session file into the
 * transfer's pre-allocated attachment id; the API streams it to storage in parts, never whole, then records a `pending`
 * attachment of the bot's turn. Refusals that are not about the file (the JWT, a busy server, a missing length) come
 * before the claim and leave the transfer `pending`; a declared size above the bound is refused before a byte is read.
 */
describe("the device PUTs a session file into its transfer (D-03, PD-05, PD-17)", () => {
  const MiB = 1024 * 1024;
  /** The path in the command's own payload: the attachment's name comes from it, and no log line may carry it. */
  const READ_PATH = "dist/report v2.pdf";
  const PDF_HEAD = Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1");
  let objects: ObjectStorage;

  beforeAll(() => {
    const built = createObjectStorage(
      storage.env as unknown as Parameters<typeof createObjectStorage>[0],
      createEnvFileSecretStore(storage.env),
    );
    if (!built) throw new Error("storage not configured");
    objects = built;
  });

  const pdf = (bytes: number) => Buffer.concat([PDF_HEAD, randomBytes(bytes - PDF_HEAD.length)]);

  interface Upload {
    id: string;
    attachmentId: string;
    eventId: string;
    agentId: string;
    key: string;
  }

  /** One `from_device` ledger row of device A and its `session.file.read` command (same id), as 11 will enqueue. */
  async function fromDevice(over: Record<string, unknown> = {}): Promise<Upload> {
    const up = { id: randomUUID(), attachmentId: randomUUID(), eventId: randomUUID(), agentId: randomUUID() };
    const maxBytes = (over.maxBytes as number | undefined) ?? 20 * MiB;
    await inOrg(async (tx) => {
      await insertTransfer(tx, {
        ...up,
        organizationId: orgId,
        workSessionId: sessionId,
        deviceId: deviceAId,
        conversationId: general,
        direction: "from_device",
        maxBytes,
        limitSource: "organization",
        sizeBytes: null,
        sha256: null,
        pathLength: READ_PATH.length,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...over,
      });
      await stack.built.deviceHub.enqueue(tx, {
        id: up.id,
        deviceId: deviceAId,
        workSessionId: sessionId,
        kind: "session.file.read",
        payload: { path: READ_PATH, maxBytes },
      });
    });
    return { ...up, key: attachmentKey(orgId, general, up.attachmentId, "original") };
  }

  type Answer = { status: number; body: { ok?: boolean; sizeBytes?: number; error?: { code: string } } | null };

  /**
   * A PUT over a raw socket, so the test controls the declared length and how much is sent: `declared` is the
   * `content-length` (`"chunked"` sends none), `send` the bytes written now; `end` false holds the request open.
   */
  function openPut(
    id: string,
    token: string,
    opts: { declared: number | "chunked"; send?: Uint8Array; end?: boolean },
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
    };
    if (opts.declared !== "chunked") headers["content-length"] = String(opts.declared);
    const req = httpRequest(fileUrl(id), { method: "PUT", headers });
    const answer = new Promise<Answer>((resolve, reject) => {
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Answer["body"]) : null });
        });
      });
      req.on("error", reject);
    });
    // Once answered, a later socket error (the server closing a refused upload) is not the test's concern.
    answer.catch(() => undefined);
    if (opts.send && opts.send.length > 0) req.write(opts.send);
    if (opts.end ?? true) req.end();
    else req.flushHeaders();
    return { req, answer };
  }

  const put = (id: string, token: string, body: Uint8Array) =>
    openPut(id, token, { declared: body.length, send: body }).answer;

  async function ledger(id: string) {
    const r = await su.query(
      "select status, failure, size_bytes::int as size, sha256 from app.bot_work_session_files where id = $1",
      [id],
    );
    return r.rows[0] as { status: string; failure: string | null; size: number | null; sha256: string | null };
  }

  async function attachmentRow(id: string) {
    const r = await su.query(
      `select status, filename, content_type, size_bytes::int as size, sha256, event_id, message_id, uploader_id,
              conversation_id from app.attachments where id = $1`,
      [id],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  }

  async function storedSha(key: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of await objects.stream(key)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  it("tracer: 17 MiB of a PDF become a pending attachment of the bot's turn, stored in three parts (E21)", async () => {
    const up = await fromDevice();
    const body = pdf(17 * MiB);
    const res = await put(up.id, jwtA, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, sizeBytes: body.length });

    expect(await attachmentRow(up.attachmentId)).toEqual({
      status: "pending",
      filename: "report v2.pdf",
      content_type: "application/pdf",
      size: body.length,
      sha256: sha256(body),
      event_id: up.eventId,
      message_id: null,
      uploader_id: up.agentId,
      conversation_id: general,
    });
    expect(await ledger(up.id)).toEqual({
      status: "streamed",
      failure: null,
      size: body.length,
      sha256: sha256(body),
    });
    expect(await storedSha(up.key)).toBe(sha256(body));
    // An S3 multipart object's ETag names its part count.
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const { s3Client } = await import("../artifact");
    const head = await s3Client(storage.env.OCW_S3_ENDPOINT!, "garage", {
      accessKeyId: storage.env.OCW_S3_ACCESS_KEY_ID!,
      secretAccessKey: storage.env.OCW_S3_SECRET_ACCESS_KEY!,
    }).send(new HeadObjectCommand({ Bucket: storage.env.OCW_S3_BUCKET, Key: up.key }));
    expect(head.ETag).toMatch(/-3"$/);

    // Single use: the same PUT again is 410 and changes nothing.
    const again = await put(up.id, jwtA, new Uint8Array([1, 2, 3]));
    expect(again.status).toBe(410);
    expect((await attachmentRow(up.attachmentId))?.size).toBe(body.length);
  });

  it("a small file is one object; an empty file is a zero-byte attachment", async () => {
    const small = await fromDevice();
    const text = new TextEncoder().encode("hello from the session\n");
    expect((await put(small.id, jwtA, text)).body).toEqual({ ok: true, sizeBytes: text.length });
    expect(await storedSha(small.key)).toBe(sha256(text));
    expect((await attachmentRow(small.attachmentId))?.content_type).toBe("application/octet-stream");

    const empty = await fromDevice();
    expect((await put(empty.id, jwtA, new Uint8Array(0))).body).toEqual({ ok: true, sizeBytes: 0 });
    expect((await attachmentRow(empty.attachmentId))?.size).toBe(0);
  });

  it("without content-length (chunked) → 411 length_required, and the row stays pending", async () => {
    const up = await fromDevice();
    const res = await openPut(up.id, jwtA, { declared: "chunked", send: new Uint8Array(1024) }).answer;
    expect(res.status).toBe(411);
    expect(res.body?.error?.code).toBe("length_required");
    expect(await ledger(up.id)).toMatchObject({ status: "pending", failure: null });
    expect(await objects.head(up.key)).toBeNull();
  });

  it("a declared size above max_bytes → 413 before a byte is read: no object, the row failed too_large with the size", async () => {
    const up = await fromDevice();
    const declared = 20 * MiB + 1;
    const { req, answer } = openPut(up.id, jwtA, { declared, end: false });
    const res = await answer;
    req.destroy();
    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe("too_large");
    expect(await ledger(up.id)).toMatchObject({ status: "failed", failure: "too_large", size: declared });
    expect(await objects.head(up.key)).toBeNull();
    expect(await attachmentRow(up.attachmentId)).toBeUndefined();
  });

  it("a body shorter than its content-length (the client gives up): no object, no attachment, the row failed", async () => {
    const up = await fromDevice();
    const { req, answer } = openPut(up.id, jwtA, { declared: 9 * MiB, send: pdf(MiB), end: false });
    await eventually(async () => (await ledger(up.id)).status === "streaming");
    req.destroy();
    await answer.catch(() => undefined);
    await eventually(async () => (await ledger(up.id)).status === "failed");
    expect((await ledger(up.id)).failure).toBe("transfer_failed");
    expect(await objects.head(up.key)).toBeNull();
    expect(await attachmentRow(up.attachmentId)).toBeUndefined();
  });

  it("another device, organization B's device, an expired row and a to_device row → 404 / 404 / 410 / 404, rows untouched", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const mine = await fromDevice();
    expect((await put(mine.id, jwtB, body)).status).toBe(404);
    expect((await put(mine.id, jwtOrgB, body)).status).toBe(404);
    expect(await ledger(mine.id)).toMatchObject({ status: "pending", failure: null });

    const late = await fromDevice({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect((await put(late.id, jwtA, body)).status).toBe(410);
    expect(await ledger(late.id)).toMatchObject({ status: "pending", failure: null });

    const wrongWay = await fromDevice({ direction: "to_device", sizeBytes: 3, sha256: sha256(body) });
    expect((await put(wrongWay.id, jwtA, body)).status).toBe(404);
    expect(await ledger(wrongWay.id)).toMatchObject({ status: "pending", failure: null });

    // The raw device token is never accepted, and nothing was spent: the right device still gets it.
    expect((await put(mine.id, deviceAToken, body)).status).toBe(401);
    expect((await put(mine.id, jwtA, body)).status).toBe(200);
  });

  it("four streams held open make a fifth PUT 503 busy with its row pending; once one ends, the same PUT succeeds", async () => {
    const max = BOT_FILE_LIMITS.concurrentTransfersPerProcess;
    const first = pdf(2 * MiB);
    const held: Array<{ up: Upload; open: ReturnType<typeof openPut> }> = [];
    try {
      for (let i = 0; i < max; i++) {
        const up = await fromDevice();
        const open = openPut(up.id, jwtA, { declared: first.length, send: first.subarray(0, 64 * 1024), end: false });
        held.push({ up, open });
        await eventually(async () => (await ledger(up.id)).status === "streaming");
      }

      const fifth = await fromDevice();
      const body = new TextEncoder().encode("the fifth file");
      const refused = await put(fifth.id, jwtA, body);
      expect(refused.status).toBe(503);
      expect(refused.body?.error?.code).toBe("busy");
      expect(await ledger(fifth.id)).toMatchObject({ status: "pending", failure: null });

      const done = held.shift()!;
      done.open.req.end(first.subarray(64 * 1024));
      expect((await done.open.answer).body).toEqual({ ok: true, sizeBytes: first.length });
      expect(await storedSha(done.up.key)).toBe(sha256(first));

      expect((await put(fifth.id, jwtA, body)).body).toEqual({ ok: true, sizeBytes: body.length });
      expect((await ledger(fifth.id)).status).toBe("streamed");
    } finally {
      for (const h of held) h.open.req.destroy();
    }
    for (const h of held) {
      await eventually(async () => (await ledger(h.up.id)).failure === "transfer_failed");
      expect(await objects.head(h.up.key)).toBeNull();
    }
  });

  it("FakeDevice.serveFileCommand PUTs a session.file.read's bytes under its JWT and acks ok", async () => {
    const up = await fromDevice();
    const cmd = (await deviceA.next(
      (f) => f.type === "command" && f.id === up.id,
    )) as unknown as Parameters<FakeDevice["serveFileCommand"]>[0];
    expect(cmd.kind).toBe("session.file.read");
    const body = pdf(64 * 1024);
    const served = await deviceA.serveFileCommand(cmd, { baseUrl: stack.baseUrl, jwt: jwtA, body });
    expect(served).toEqual({ ok: true, error: null });
    await eventually(async () => {
      const r = await su.query("select status from app.device_commands where id = $1", [up.id]);
      return r.rows[0]?.status === "acked";
    });
    expect((await attachmentRow(up.attachmentId))?.sha256).toBe(sha256(body));
    expect((await ledger(up.id)).status).toBe("streamed");
  });

  it("no captured log line carries the session path or the file's name (P1)", () => {
    const all = logs.join("");
    expect(all).toContain('"code":"length_required"');
    for (const name of [READ_PATH, "report v2.pdf"]) expect(all).not.toContain(name);
  });
});
