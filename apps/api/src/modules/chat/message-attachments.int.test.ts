import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { startTestStorage, type TestStorage } from "../../testing-storage";

/**
 * CHAT-12 (04-12): files uploaded through the artifact pipeline (04-04) are linked to the message that carries them,
 * in the message transaction, so `message.created` already has them; every message page hydrates them. Real
 * PostgreSQL + Redis + Garage (testcontainers).
 */

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let pat: TestClient;
let samId: string;
let patId: string;
let general: string;
let random: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** A minimal PDF (magic bytes are what the sniffer checks). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function invite(email: string, name: string): Promise<TestClient> {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const client = new TestClient(stack.baseUrl);
  await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "a-long-password-1" }),
  );
  return client;
}

/** presign (+ PUT + complete unless `complete` is false); returns the attachment id. */
async function upload(
  client: TestClient,
  conv: string,
  file: { name: string; type: string; bytes: Buffer } = { name: "dot.png", type: "image/png", bytes: PNG },
  complete = true,
): Promise<string> {
  const p = await ok(
    client.request("POST", `/api/v1/conversations/${conv}/attachments`, {
      filename: file.name,
      contentType: file.type,
      size: file.bytes.length,
    }),
  );
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: file.bytes });
  expect(put.status).toBe(200);
  if (complete) await ok(client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
  return p.attachment.id;
}

const post = (client: TestClient, conv: string, body: Json) =>
  client.request("POST", `/api/v1/conversations/${conv}/messages`, body);

/** A request that does not follow redirects (attachment routes answer 302). */
function raw(client: TestClient, path: string) {
  return fetch(`${stack.baseUrl}${path}`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
}

async function errorCode(res: Promise<{ status: number; body: Json | null }>, status: number) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body?.error?.code as string | undefined;
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({ env: storage.env });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  sam = await invite("sam@example.test", "Sam Lee");
  pat = await invite("pat@example.test", "Pat Doe");
  samId = (await ok(sam.request("GET", "/api/v1/me"))).user.id;
  patId = (await ok(pat.request("GET", "/api/v1/me"))).user.id;
  general = (await ok(admin.request("GET", "/api/v1/channels"))).channels[0].id;
  random = (await ok(admin.request("POST", "/api/v1/channels", { name: "random", visibility: "public" }))).id;
  await ok(sam.request("POST", `/api/v1/channels/${random}/join`));
});

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("posting with attachments", () => {
  it("links a completed PNG to an attachment-only message and returns it hydrated", async () => {
    const id = await upload(sam, general);
    const msg = await ok(post(sam, general, { body: "", attachmentIds: [id] }));
    expect(msg.body).toBe("");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({
      id,
      messageId: msg.id,
      conversationId: general,
      status: "ready",
      isImage: true,
      contentType: "image/png",
      previewUrl: `/api/v1/attachments/${id}/preview`,
      largeUrl: `/api/v1/attachments/${id}/large`,
      downloadUrl: `/api/v1/attachments/${id}/download`,
    });
    const { rows } = await su.query("select message_id from app.attachments where id = $1", [id]);
    expect(rows[0].message_id).toBe(msg.id);

    // message.created on the conversation stream already carries the attachment (live for every member).
    const ev = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'message.created' and seq = $2",
      [`conv:${general}`, msg.seq],
    );
    expect(ev.rows[0].payload.message.attachments).toEqual([expect.objectContaining({ id, isImage: true })]);
  });

  it("every message page (latest, around) and the thread view hydrate the attachments", async () => {
    const id = await upload(sam, general);
    const msg = await ok(post(sam, general, { body: "the mockup", attachmentIds: [id] }));
    await ok(post(admin, general, { body: "nice" }));

    const latest = await ok(admin.request("GET", `/api/v1/conversations/${general}/messages`));
    const inLatest = latest.messages.find((m: Json) => m.id === msg.id);
    expect(inLatest.attachments.map((a: Json) => a.id)).toEqual([id]);
    // Messages without files carry an empty list.
    expect(latest.messages.find((m: Json) => m.body === "nice").attachments).toEqual([]);

    const around = await ok(
      admin.request("GET", `/api/v1/conversations/${general}/messages?around=${msg.id}`),
    );
    expect(around.messages.find((m: Json) => m.id === msg.id).attachments[0].id).toBe(id);

    const thread = await ok(admin.request("GET", `/api/v1/messages/${msg.id}/thread`));
    expect(thread.root.attachments[0].id).toBe(id);
  });

  it("previews can be embedded by the web app on another site (CORP cross-origin on the redirect only)", async () => {
    const id = await upload(sam, general);
    await ok(post(sam, general, { body: "", attachmentIds: [id] }));
    for (const part of ["preview", "large"]) {
      const res = await raw(admin, `/api/v1/attachments/${id}/${part}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    }
    // Every other API response keeps helmet's same-site policy.
    const page = await fetch(`${stack.baseUrl}/api/v1/conversations/${general}/messages`, {
      headers: { origin: WEB_ORIGIN, cookie: admin.cookieHeader },
    });
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-site");
  });

  it("refuses another member's attachment, a reused, a pending or another conversation's id (409)", async () => {
    const pats = await upload(pat, general);
    expect(await errorCode(post(sam, general, { body: "x", attachmentIds: [pats] }), 409)).toBe(
      "attachment_not_linkable",
    );

    const used = await upload(sam, general);
    await ok(post(sam, general, { body: "first", attachmentIds: [used] }));
    expect(await errorCode(post(sam, general, { body: "again", attachmentIds: [used] }), 409)).toBe(
      "attachment_not_linkable",
    );

    const pending = await upload(sam, general, undefined, false);
    expect(await errorCode(post(sam, general, { body: "x", attachmentIds: [pending] }), 409)).toBe(
      "attachment_not_linkable",
    );

    const elsewhere = await upload(sam, random);
    expect(await errorCode(post(sam, general, { body: "x", attachmentIds: [elsewhere] }), 409)).toBe(
      "attachment_not_linkable",
    );

    // A refused link rolls the whole post back: no message was created and the good id stays unlinked.
    const good = await upload(sam, general);
    const before = await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [
      general,
    ]);
    await errorCode(post(sam, general, { body: "mixed", attachmentIds: [good, pats] }), 409);
    const after = await su.query("select count(*)::int as n from app.messages where conversation_id = $1", [
      general,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows } = await su.query("select message_id from app.attachments where id = $1", [good]);
    expect(rows[0].message_id).toBeNull();
  });

  it("validates the request: 11 ids and an empty body without files are 400", async () => {
    const ids = Array.from({ length: 11 }, () => randomUUID());
    expect((await post(sam, general, { body: "x", attachmentIds: ids })).status).toBe(400);
    expect((await post(sam, general, { body: "" })).status).toBe(400);
    expect((await post(sam, general, { body: "", attachmentIds: [] })).status).toBe(400);
  });

  it("another organization gets 404", async () => {
    const { client } = await otherOrgAdmin();
    const id = await upload(sam, general);
    expect((await post(client, general, { body: "", attachmentIds: [id] })).status).toBe(404);
    const { rows } = await su.query("select message_id from app.attachments where id = $1", [id]);
    expect(rows[0].message_id).toBeNull();
  });
});

describe("files, edits, deletes, threads and groups", () => {
  it("a PNG and a PDF on one message hydrate as an image and a file, in upload order", async () => {
    const png = await upload(sam, general);
    const pdf = await upload(sam, general, { name: "Q3 report.pdf", type: "application/pdf", bytes: PDF });
    const msg = await ok(post(sam, general, { body: "numbers and a chart", attachmentIds: [png, pdf] }));
    expect(msg.attachments.map((a: Json) => [a.id, a.isImage])).toEqual([
      [png, true],
      [pdf, false],
    ]);
    expect(msg.attachments[1]).toMatchObject({
      filename: "Q3 report.pdf",
      contentType: "application/pdf",
      size: PDF.length,
      previewUrl: null,
      largeUrl: null,
      downloadUrl: `/api/v1/attachments/${pdf}/download`,
    });
    const page = await ok(pat.request("GET", `/api/v1/conversations/${general}/messages`));
    expect(page.messages.find((m: Json) => m.id === msg.id).attachments).toHaveLength(2);
    const download = await raw(pat, `/api/v1/attachments/${pdf}/download`);
    expect(download.status).toBe(302);
  });

  it("editing a message keeps its attachments (response, page and message.updated)", async () => {
    const id = await upload(sam, general);
    const msg = await ok(post(sam, general, { body: "draft", attachmentIds: [id] }));
    const edited = await ok(sam.request("PATCH", `/api/v1/messages/${msg.id}`, { body: "final version" }));
    expect(edited.attachments.map((a: Json) => a.id)).toEqual([id]);
    const ev = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'message.updated' order by seq desc limit 1",
      [`conv:${general}`],
    );
    expect(ev.rows[0].payload.message.attachments.map((a: Json) => a.id)).toEqual([id]);
    const page = await ok(admin.request("GET", `/api/v1/conversations/${general}/messages`));
    expect(page.messages.find((m: Json) => m.id === msg.id).attachments[0].id).toBe(id);
  });

  it("deleting a message hides its files from every page and makes download and previews 404 for everyone", async () => {
    const png = await upload(sam, general);
    const pdf = await upload(sam, general, { name: "plan.pdf", type: "application/pdf", bytes: PDF });
    const msg = await ok(post(sam, general, { body: "to be removed", attachmentIds: [png, pdf] }));
    expect((await raw(pat, `/api/v1/attachments/${png}/preview`)).status).toBe(302);
    await ok(sam.request("DELETE", `/api/v1/messages/${msg.id}`));

    const { rows } = await su.query("select status from app.attachments where id = any($1) order by id", [
      [png, pdf],
    ]);
    expect(rows.map((r) => r.status)).toEqual(["deleted", "deleted"]);
    for (const client of [sam, pat, admin]) {
      const page = await ok(client.request("GET", `/api/v1/conversations/${general}/messages`));
      const tomb = page.messages.find((m: Json) => m.id === msg.id);
      if (tomb) expect(tomb.attachments).toEqual([]);
      const around = await ok(
        client.request("GET", `/api/v1/conversations/${general}/messages?around=${msg.id}`),
      );
      expect(around.messages.find((m: Json) => m.id === msg.id)?.attachments ?? []).toEqual([]);
      for (const path of [`${png}/preview`, `${png}/large`, `${png}/download`, `${pdf}/download`]) {
        expect((await raw(client, `/api/v1/attachments/${path}`)).status).toBe(404);
      }
    }
  });

  it("a thread reply carries attachments; the thread view hydrates them", async () => {
    const root = await ok(post(admin, general, { body: "Feedback on the deck?" }));
    const id = await upload(sam, general);
    const reply = await ok(post(sam, general, { body: "", threadRootId: root.id, attachmentIds: [id] }));
    expect(reply.threadId).toBe(root.id);
    expect(reply.attachments[0].id).toBe(id);
    const thread = await ok(pat.request("GET", `/api/v1/messages/${root.id}/thread`));
    expect(thread.replies.find((r: Json) => r.id === reply.id).attachments[0].id).toBe(id);
  });

  it("a group DM message carries attachments that only its participants can open", async () => {
    const group = await ok(
      admin.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: samId },
          { kind: "user", id: patId },
        ],
      }),
    );
    const id = await upload(admin, group.id);
    const msg = await ok(post(admin, group.id, { body: "", attachmentIds: [id] }));
    const page = await ok(pat.request("GET", `/api/v1/conversations/${group.id}/messages`));
    expect(page.messages.find((m: Json) => m.id === msg.id).attachments[0].id).toBe(id);
    expect((await raw(pat, `/api/v1/attachments/${id}/preview`)).status).toBe(302);
    // Someone outside the group: hidden = missing.
    const outsider = await invite(`zed-${randomUUID().slice(0, 8)}@example.test`, "Zed");
    expect((await raw(outsider, `/api/v1/attachments/${id}/preview`)).status).toBe(404);
    expect((await raw(outsider, `/api/v1/attachments/${id}/download`)).status).toBe(404);
  });

  it("without storage, text messages still post and attachmentIds answer 503 attachments_disabled", async () => {
    const env = {
      ...stack.env,
      OCW_S3_ENDPOINT: null,
      OCW_S3_PUBLIC_URL: null,
      OCW_S3_ACCESS_KEY_ID: null,
    };
    const bare = await buildApp(env, { logger: false });
    try {
      const headers = { origin: WEB_ORIGIN, cookie: sam.cookieHeader };
      const url = `/api/v1/conversations/${general}/messages`;
      const text = await bare.app.inject({ method: "POST", url, headers, payload: { body: "plain text" } });
      expect(text.statusCode).toBe(200);
      const files = await bare.app.inject({
        method: "POST",
        url,
        headers,
        payload: { body: "", attachmentIds: [randomUUID()] },
      });
      expect(files.statusCode).toBe(503);
      expect(files.json().error.code).toBe("attachments_disabled");
    } finally {
      await bare.close();
    }
  });
});

/** A client whose membership moved to a fresh organization B (same helper shape as attachments.int.test.ts). */
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
