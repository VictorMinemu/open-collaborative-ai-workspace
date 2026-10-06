import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sanitizeFilename } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { attachmentsForMessages, linkAttachments } from "./index";
import { attachmentKey, createObjectStorage, type ObjectStorage } from "./storage";
import { createAttachmentSweeper } from "./sweeper";

/**
 * CHAT-12 / D-03: presign → PUT straight to a real Garage container → complete → authorized download. Real
 * PostgreSQL + Redis + Garage (testcontainers); the readable set decides every route (hidden = 404).
 */

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let s3: S3Client;
let objects: ObjectStorage;
let admin: TestClient;
let sam: TestClient;
let pat: TestClient;
let orgId: string;
let adminId: string;
let samId: string;
let general: string;
let board: string; // private: admin + sam, not pat

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A PNG whose header claims 100000×100000 pixels (a decompression bomb). */
function bombPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100_000, 0);
  ihdr.writeUInt32BE(100_000, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grey)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(100_001 * 4))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A request that does not follow redirects (the routes answer 302 to a presigned URL). */
function raw(client: TestClient, method: string, path: string) {
  return fetch(`${stack.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
}

async function invite(email: string, name: string): Promise<TestClient> {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const client = new TestClient(stack.baseUrl);
  await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "a-long-password-1" }),
  );
  return client;
}

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId }, fn);

async function presign(client: TestClient, conv: string, body: Json, status = 200) {
  return ok(client.request("POST", `/api/v1/conversations/${conv}/attachments`, body), status);
}

async function put(upload: Json, bytes: Uint8Array, headers: Record<string, string> = upload.headers) {
  return fetch(upload.url, { method: "PUT", headers, body: bytes });
}

/** presign + PUT + complete; returns the completed attachment. */
async function uploadPng(client: TestClient = admin, conv = general): Promise<Json> {
  return upload(client, conv, "dot.png", "image/png", PNG);
}

/** presign + PUT; returns the completion response (status and body). */
async function uploadRaw(
  client: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
) {
  const p = await presign(client, conv, { filename, contentType, size: bytes.length });
  expect((await put(p.upload, bytes)).status).toBe(200);
  return {
    id: p.attachment.id as string,
    res: await client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`),
  };
}

async function upload(
  client: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
) {
  const { res } = await uploadRaw(client, conv, filename, contentType, bytes);
  if (res.status !== 200) throw new Error(`complete answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as Json;
}

async function objectBytes(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: "ocw-attachments", Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  } catch {
    return null;
  }
}

async function audits(attachmentId: string): Promise<Array<{ action: string; metadata: Json }>> {
  const { rows } = await su.query(
    "select action, metadata from app.audit_events where resource_type = 'attachment' and resource_id = $1 order by occurred_at, id",
    [attachmentId],
  );
  return rows;
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({ env: storage.env });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  objects = createObjectStorage(stack.env, createEnvFileSecretStore(storage.env))!;
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
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  sam = await invite("sam@example.test", "Sam Lee");
  pat = await invite("pat@example.test", "Pat Doe");
  adminId = setup.user.id;
  samId = (await ok(sam.request("GET", "/api/v1/me"))).user.id;
  general = (await ok(admin.request("GET", "/api/v1/channels"))).channels[0].id;
  board = (await ok(admin.request("POST", "/api/v1/channels", { name: "board", visibility: "private" }))).id;
  await ok(admin.request("POST", `/api/v1/channels/${board}/members`, { kind: "user", id: samId }));
});

afterAll(async () => {
  await su?.end();
  s3?.destroy();
  await stack?.stop();
  await storage?.stop();
});

describe("config", () => {
  it("reports storage enabled with the limits", async () => {
    expect(await ok(admin.request("GET", "/api/v1/attachments/config"))).toEqual({
      enabled: true,
      maxBytes: 26214400,
      maxPerMessage: 10,
      reason: null,
    });
  });

  it("an API without storage env reports not_configured and refuses presign with 503", async () => {
    const env = {
      ...stack.env,
      OCW_S3_ENDPOINT: null,
      OCW_S3_PUBLIC_URL: null,
      OCW_S3_ACCESS_KEY_ID: null,
    };
    const bare = await buildApp(env, { logger: false });
    try {
      const headers = { origin: WEB_ORIGIN, cookie: admin.cookieHeader };
      const cfg = await bare.app.inject({ method: "GET", url: "/api/v1/attachments/config", headers });
      expect(cfg.statusCode).toBe(200);
      expect(cfg.json()).toMatchObject({ enabled: false, reason: "not_configured" });
      const res = await bare.app.inject({
        method: "POST",
        url: `/api/v1/conversations/${general}/attachments`,
        headers,
        payload: { filename: "a.png", contentType: "image/png", size: 10 },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("attachments_disabled");
    } finally {
      await bare.close();
    }
  });
});

describe("presign → PUT → complete → download", () => {
  it("presigns a pending attachment on the public endpoint with the content type signed", async () => {
    const p = await presign(admin, general, {
      filename: "dot.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect(p.attachment).toMatchObject({
      conversationId: general,
      messageId: null,
      filename: "dot.png",
      status: "pending",
      size: PNG.length,
      downloadUrl: `/api/v1/attachments/${p.attachment.id}/download`,
    });
    expect(p.upload.method).toBe("PUT");
    expect(p.upload.headers).toEqual({ "content-type": "image/png" });
    const url = new URL(p.upload.url);
    expect(url.origin).toBe(storage.endpoint);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-type");
    expect(url.pathname).toBe(
      `/ocw-attachments/${attachmentKey(orgId, general, p.attachment.id, "original")}`,
    );
    expect(url.pathname).not.toContain("dot.png");

    // A different content type on the same URL is refused by the store.
    expect((await put(p.upload, PNG, { "content-type": "text/html" })).status).toBe(403);
    expect((await put(p.upload, PNG)).status).toBe(200);

    const done = await ok(admin.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
    expect(done).toMatchObject({ id: p.attachment.id, status: "ready", size: PNG.length });
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: "ocw-attachments",
        Key: attachmentKey(orgId, general, p.attachment.id, "original"),
      }),
    );
    expect(Number(head.ContentLength)).toBe(PNG.length);
  });

  it("download answers 302 to a presigned GET with attachment disposition and no-store", async () => {
    const att = await uploadPng();
    const res = await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = res.headers.get("location")!;
    expect(new URL(location).origin).toBe(storage.endpoint);
    const file = await fetch(location);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("a declared size different from the uploaded bytes is rejected with 409 size_mismatch", async () => {
    const p = await presign(admin, general, {
      filename: "dot.png",
      contentType: "image/png",
      size: PNG.length + 5,
    });
    // The signed length makes a browser PUT of other bytes fail; simulate a store that accepted them anyway.
    await s3.send(
      new PutObjectCommand({
        Bucket: "ocw-attachments",
        Key: attachmentKey(orgId, general, p.attachment.id, "original"),
        Body: PNG,
        ContentType: "image/png",
      }),
    );
    const res = await admin.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`);
    expect(res.status).toBe(409);
    expect((res.body as Json).error.code).toBe("size_mismatch");
    const { rows } = await su.query("select status from app.attachments where id = $1", [p.attachment.id]);
    expect(rows[0].status).toBe("rejected");
  });

  it("complete before the PUT answers 409 upload_missing and leaves the attachment pending", async () => {
    const p = await presign(admin, general, {
      filename: "dot.png",
      contentType: "image/png",
      size: PNG.length,
    });
    const res = await admin.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`);
    expect(res.status).toBe(409);
    expect((res.body as Json).error.code).toBe("upload_missing");
    const { rows } = await su.query("select status from app.attachments where id = $1", [p.attachment.id]);
    expect(rows[0].status).toBe("pending");
  });

  it("a size above the limit is refused with 400 too_large", async () => {
    const res = await admin.request("POST", `/api/v1/conversations/${general}/attachments`, {
      filename: "big.bin",
      contentType: "application/octet-stream",
      size: 26214401,
    });
    expect(res.status).toBe(400);
    expect((res.body as Json).error.code).toBe("too_large");
  });

  it("stores a sanitized filename and never puts it in the key", async () => {
    const p = await presign(admin, general, {
      filename: "../../etc/pass‮wd.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect(p.attachment.filename).toBe(sanitizeFilename("../../etc/pass\u202Ewd.png"));
    expect(p.attachment.filename).not.toContain("/");
    expect(p.upload.url).not.toContain("passwd");
  });
});

describe("access (T-04-04-01)", () => {
  it("a member of the org who is not in the private channel gets 404 on presign, complete and download", async () => {
    const res = await pat.request("POST", `/api/v1/conversations/${board}/attachments`, {
      filename: "x.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect(res.status).toBe(404);

    const att = await uploadPng(sam, board);
    expect(att.status).toBe("ready");
    expect((await raw(pat, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(404);

    // Pending in the private channel: completing it as Pat is 404 too.
    const p = await presign(sam, board, { filename: "dot.png", contentType: "image/png", size: PNG.length });
    expect((await pat.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`)).status).toBe(404);
  });

  it("complete by a different member (even one who can read the conversation) is 404", async () => {
    const p = await presign(sam, general, {
      filename: "dot.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect((await put(p.upload, PNG)).status).toBe(200);
    expect((await admin.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`)).status).toBe(404);
    expect((await sam.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`)).status).toBe(200);
  });

  it("an unlinked attachment downloads only for its uploader; a linked one for every reader", async () => {
    const att = await uploadPng(sam, general);
    expect((await raw(sam, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(302);
    expect((await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(404);

    const msg = await ok(sam.request("POST", `/api/v1/conversations/${general}/messages`, { body: "file" }));
    await asUser(samId, (tx) =>
      linkAttachments(tx, { conversationId: general, messageId: msg.id, uploaderId: samId, ids: [att.id] }),
    );
    expect((await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(302);
    const listed = await asUser(adminId, (tx) => attachmentsForMessages(tx, [msg.id]));
    expect(listed.get(msg.id)?.map((a) => a.id)).toEqual([att.id]);

    // A deleted message takes its files with it.
    await ok(sam.request("DELETE", `/api/v1/messages/${msg.id}`));
    expect((await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(404);
    expect((await raw(sam, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(404);
  });

  it("linkAttachments refuses another uploader's, another conversation's, unready or already linked files", async () => {
    const mine = await uploadPng(sam, general);
    const theirs = await uploadPng(admin, general);
    const elsewhere = await uploadPng(sam, board);
    const pending = await presign(sam, general, {
      filename: "p.png",
      contentType: "image/png",
      size: PNG.length,
    });
    const msg = await ok(sam.request("POST", `/api/v1/conversations/${general}/messages`, { body: "files" }));
    const link = (ids: string[]) =>
      asUser(samId, (tx) =>
        linkAttachments(tx, { conversationId: general, messageId: msg.id, uploaderId: samId, ids }),
      );
    for (const id of [theirs.id, elsewhere.id, pending.attachment.id, randomUUID()]) {
      await expect(link([mine.id, id])).rejects.toMatchObject({
        statusCode: 409,
        code: "attachment_not_linkable",
      });
    }
    await expect(link(Array.from({ length: 11 }, () => mine.id))).rejects.toMatchObject({ statusCode: 409 });
    await link([mine.id]);
    await expect(link([mine.id])).rejects.toMatchObject({ code: "attachment_not_linkable" });
  });

  it("org B gets 404 on presign, complete and download", async () => {
    const { client } = await otherOrgAdmin();
    const att = await uploadPng();
    expect(
      (
        await client.request("POST", `/api/v1/conversations/${general}/attachments`, {
          filename: "x.png",
          contentType: "image/png",
          size: PNG.length,
        })
      ).status,
    ).toBe(404);
    expect((await client.request("POST", `/api/v1/attachments/${att.id}/complete`)).status).toBe(404);
    expect((await raw(client, "GET", `/api/v1/attachments/${att.id}/download`)).status).toBe(404);
  });
});

/** A client whose membership moved to a fresh organization B (same helper shape as message-edit.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string }> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const client = await invite(email, "Eve");
  const userB = (await ok(client.request("GET", "/api/v1/me"))).user.id;
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userB]);
  await su.query("delete from app.org_members where user_id = $1", [userB]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userB,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userB],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
  return { client, orgB };
}

describe("verification pipeline (sniff, SHA-256, renditions)", () => {
  it("a PNG completes with its sniffed type, SHA-256, size and both renditions", async () => {
    const att = await uploadPng();
    expect(att).toMatchObject({
      contentType: "image/png",
      isImage: true,
      width: 1,
      height: 1,
      previewUrl: `/api/v1/attachments/${att.id}/preview`,
      largeUrl: `/api/v1/attachments/${att.id}/large`,
    });
    const { rows } = await su.query("select sha256, has_renditions from app.attachments where id = $1", [
      att.id,
    ]);
    expect(rows[0]).toEqual({ sha256: createHash("sha256").update(PNG).digest("hex"), has_renditions: true });
    for (const part of ["thumb.webp", "large.webp"] as const) {
      const bytes = await objectBytes(attachmentKey(orgId, general, att.id, part));
      expect((await sharp(bytes!).metadata()).format).toBe("webp");
    }
  });

  it("a JPEG with GPS EXIF yields bounded renditions without any metadata", async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#3a6" } })
      .jpeg()
      .withExif({
        IFD0: { Copyright: "secret place" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "40/1 25/1 0/1",
          GPSLongitudeRef: "W",
          GPSLongitude: "3/1 42/1 0/1",
        },
      })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif?.toString("latin1")).toContain("secret place");
    const att = await upload(admin, general, "where.jpg", "image/jpeg", jpeg);
    expect(att).toMatchObject({ contentType: "image/jpeg", isImage: true, width: 3000, height: 2000 });
    const thumb = await sharp(
      (await objectBytes(attachmentKey(orgId, general, att.id, "thumb.webp")))!,
    ).metadata();
    const large = await sharp(
      (await objectBytes(attachmentKey(orgId, general, att.id, "large.webp")))!,
    ).metadata();
    expect([thumb.width, thumb.height]).toEqual([720, 480]);
    expect([large.width, large.height]).toEqual([2048, 1365]);
    for (const m of [thumb, large]) {
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.icc).toBeUndefined();
    }
  });

  it("HTML declared as image/png is rejected with 409 type_mismatch and gets no renditions", async () => {
    const html = Buffer.from("<!doctype html><html><script>alert(document.cookie)</script></html>");
    const { id, res } = await uploadRaw(admin, general, "cute.png", "image/png", html);
    expect(res.status).toBe(409);
    expect((res.body as Json).error.code).toBe("type_mismatch");
    const { rows } = await su.query("select status, has_renditions from app.attachments where id = $1", [id]);
    expect(rows[0]).toEqual({ status: "rejected", has_renditions: false });
    expect(await objectBytes(attachmentKey(orgId, general, id, "thumb.webp"))).toBeNull();
    expect(await objectBytes(attachmentKey(orgId, general, id, "original"))).toBeNull();
  });

  it("an SVG is a download-only file, never an image, and never keeps an active type", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const att = await upload(admin, general, "logo.svg", "image/svg+xml", svg);
    expect(att).toMatchObject({ isImage: false, previewUrl: null, largeUrl: null, width: null });
    expect(att.contentType).toBe("application/octet-stream");
    expect((await raw(admin, "GET", `/api/v1/attachments/${att.id}/preview`)).status).toBe(404);
    expect((await raw(admin, "GET", `/api/v1/attachments/${att.id}/large`)).status).toBe(404);
    const res = await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`);
    const file = await fetch(res.headers.get("location")!);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("a PDF downloads as application/pdf with attachment disposition", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
    const att = await upload(admin, general, "résumé ✓.pdf", "application/pdf", pdf);
    expect(att).toMatchObject({ contentType: "application/pdf", isImage: false, filename: "résumé ✓.pdf" });
    const res = await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`);
    expect(res.status).toBe(302);
    const file = await fetch(res.headers.get("location")!);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="resume _.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%9C%93.pdf`,
    );
  });

  it("/preview and /large redirect to inline webp; neither is audited", async () => {
    const att = await uploadPng();
    for (const path of ["preview", "large"]) {
      const res = await raw(admin, "GET", `/api/v1/attachments/${att.id}/${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const img = await fetch(res.headers.get("location")!);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/webp");
      expect(img.headers.get("content-disposition")).toMatch(/^inline; filename="dot.webp"/);
    }
    // Hidden from a non-member like every other route.
    const priv = await uploadPng(sam, board);
    expect((await raw(pat, "GET", `/api/v1/attachments/${priv.id}/preview`)).status).toBe(404);
    expect((await audits(att.id)).map((a) => a.action)).toEqual(["attachment.uploaded"]);
  });

  it("uploads and downloads are audited with ids only (no URL, no signature, no secret)", async () => {
    const att = await uploadPng();
    await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`);
    await raw(admin, "GET", `/api/v1/attachments/${att.id}/download`);
    const rows = await audits(att.id);
    expect(rows.map((r) => r.action)).toEqual([
      "attachment.uploaded",
      "attachment.downloaded",
      "attachment.downloaded",
    ]);
    expect(rows[0]!.metadata).toEqual({
      attachmentId: att.id,
      conversationId: general,
      size: PNG.length,
      contentType: "image/png",
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
    expect(rows[1]!.metadata).toEqual({ attachmentId: att.id, conversationId: general });
    const all = await su.query("select metadata::text as m from app.audit_events");
    for (const { m } of all.rows) {
      expect(m).not.toContain("X-Amz-");
      expect(m).not.toContain(storage.env.OCW_S3_SECRET_ACCESS_KEY);
    }
  });

  it("a decompression-bomb PNG is rejected without crashing the API", async () => {
    const { id, res } = await uploadRaw(admin, general, "bomb.png", "image/png", bombPng());
    expect(res.status).toBe(409);
    expect((res.body as Json).error.code).toBe("image_too_large");
    const { rows } = await su.query("select status from app.attachments where id = $1", [id]);
    expect(rows[0].status).toBe("rejected");
    expect((await admin.request("GET", "/api/v1/attachments/config")).status).toBe(200);
  });

  it("the 61st presign within a minute by one user answers 429", async () => {
    const quinn = await invite("quinn@example.test", "Quinn Roe");
    await ok(quinn.request("GET", "/api/v1/channels")); // joins #general
    const body = { filename: "q.txt", contentType: "text/plain", size: 10 };
    for (let i = 0; i < 60; i++) {
      expect((await quinn.request("POST", `/api/v1/conversations/${general}/attachments`, body)).status).toBe(
        200,
      );
    }
    expect((await quinn.request("POST", `/api/v1/conversations/${general}/attachments`, body)).status).toBe(
      429,
    );
    // The bucket is per user: another member is unaffected.
    expect((await admin.request("POST", `/api/v1/conversations/${general}/attachments`, body)).status).toBe(
      200,
    );
  });
});

describe("storage reachability (T-04-04-09)", () => {
  it("an unreachable store never blocks boot and reports enabled:false, reason unavailable", async () => {
    const env = {
      ...stack.env,
      OCW_S3_ENDPOINT: "http://127.0.0.1:1",
      OCW_S3_PUBLIC_URL: "http://127.0.0.1:1",
    };
    const store = createEnvFileSecretStore({ OCW_S3_SECRET_ACCESS_KEY: "0".repeat(64) });
    const down = await buildApp(env, { logger: false, secretStore: store });
    try {
      const headers = { origin: WEB_ORIGIN, cookie: admin.cookieHeader };
      const cfg = await down.app.inject({ method: "GET", url: "/api/v1/attachments/config", headers });
      expect(cfg.json()).toMatchObject({ enabled: false, reason: "unavailable" });
    } finally {
      await down.close();
    }
  });
});

describe("sweeper", () => {
  const later = (ms: number) => () => new Date(Date.now() + ms);
  const HOUR = 3_600_000;

  it("purges abandoned uploads after 24 h and deleted files after 30 days, each in its own tenant", async () => {
    // Pending with bytes in storage.
    const p = await presign(admin, general, {
      filename: "a.png",
      contentType: "image/png",
      size: PNG.length,
    });
    expect((await put(p.upload, PNG)).status).toBe(200);
    const pendingKey = attachmentKey(orgId, general, p.attachment.id, "original");
    // Deleted with its message, renditions included.
    const del = await uploadPng(sam, general);
    const msg = await ok(sam.request("POST", `/api/v1/conversations/${general}/messages`, { body: "gone" }));
    await asUser(samId, (tx) =>
      linkAttachments(tx, { conversationId: general, messageId: msg.id, uploaderId: samId, ids: [del.id] }),
    );
    await ok(sam.request("DELETE", `/api/v1/messages/${msg.id}`));
    // A ready file that must survive.
    const keep = await uploadPng();
    // Another organization's abandoned upload: only its own tenant transaction can set purged_at (forced RLS).
    const { orgB } = await otherOrgAdmin();
    const convB = randomUUID();
    const attB = randomUUID();
    await su.query(
      "insert into app.conversations (id, organization_id, kind, visibility, name, slug) values ($1, $2, 'channel', 'public', 'b', $3)",
      [convB, orgB, `b-${convB}`],
    );
    await su.query(
      `insert into app.attachments (id, organization_id, conversation_id, uploader_id, filename, declared_type, size_bytes)
       values ($1, $2, $3, $4, 'b.png', 'image/png', 1)`,
      [attB, orgB, convB, randomUUID()],
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "ocw-attachments",
        Key: attachmentKey(orgB, convB, attB, "original"),
        Body: PNG,
      }),
    );

    const purgedAt = async (id: string) =>
      (await su.query("select purged_at from app.attachments where id = $1", [id])).rows[0].purged_at;

    // 1 h later nothing is due.
    await createAttachmentSweeper(stack.built.core, objects, { now: later(HOUR) }).runOnce();
    expect(await purgedAt(p.attachment.id)).toBeNull();

    // 25 h later: abandoned uploads (both orgs) go; the deleted file waits for 30 days.
    await createAttachmentSweeper(stack.built.core, objects, { now: later(25 * HOUR) }).runOnce();
    expect(await purgedAt(p.attachment.id)).not.toBeNull();
    expect(await objectBytes(pendingKey)).toBeNull();
    expect(await purgedAt(attB)).not.toBeNull();
    expect(await objectBytes(attachmentKey(orgB, convB, attB, "original"))).toBeNull();
    expect(await purgedAt(del.id)).toBeNull();

    // 31 days later the deleted file's original and renditions go; the ready file stays.
    await createAttachmentSweeper(stack.built.core, objects, { now: later(31 * 24 * HOUR) }).runOnce();
    expect(await purgedAt(del.id)).not.toBeNull();
    for (const part of ["original", "thumb.webp", "large.webp"] as const) {
      expect(await objectBytes(attachmentKey(orgId, general, del.id, part))).toBeNull();
    }
    expect(await purgedAt(keep.id)).toBeNull();
    expect(await objectBytes(attachmentKey(orgId, general, keep.id, "original"))).not.toBeNull();
  });
});

describe("Garage memory under load (ADR-0015)", () => {
  it("five concurrent 25 MiB uploads complete; peak Garage memory is recorded", async () => {
    const size = 25 * 1024 * 1024;
    const toMiB = (s: string) => {
      const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
      if (!m) return 0;
      const n = Number(m[1]);
      return m[2]!.startsWith("G") ? n * 1024 : m[2]!.startsWith("K") ? n / 1024 : n;
    };
    // Streaming `docker stats` (one sample per second or so) for the whole run: three rounds of five concurrent
    // uploads keep Garage busy long enough to be sampled several times.
    let peak = 0;
    let samples = 0;
    const stats = spawn("docker", ["stats", "--format", "{{.MemUsage}}", storage.container.getId()]);
    stats.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const mib = toMiB(line);
        if (mib > 0) {
          samples++;
          peak = Math.max(peak, mib);
        }
      }
    });
    try {
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            upload(admin, general, `big-${round}-${i}.bin`, "application/octet-stream", randomBytes(size)),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(Array(5).fill("ready"));
      }
    } finally {
      stats.kill();
    }
    console.log(
      `[ADR-0015] Garage peak memory during 3×5 concurrent 25 MiB uploads: ${peak.toFixed(1)} MiB (${samples} samples)`,
    );
    expect(samples).toBeGreaterThan(0);
  }, 180_000);
});
