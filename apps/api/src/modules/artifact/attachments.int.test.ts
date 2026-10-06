import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sanitizeFilename } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { attachmentsForMessages, linkAttachments } from "./index";
import { attachmentKey } from "./storage";

/**
 * CHAT-12 / D-03: presign → PUT straight to a real Garage container → complete → authorized download. Real
 * PostgreSQL + Redis + Garage (testcontainers); the readable set decides every route (hidden = 404).
 */

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let s3: S3Client;
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
  const p = await presign(client, conv, { filename: "dot.png", contentType: "image/png", size: PNG.length });
  expect((await put(p.upload, PNG)).status).toBe(200);
  return ok(client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
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
