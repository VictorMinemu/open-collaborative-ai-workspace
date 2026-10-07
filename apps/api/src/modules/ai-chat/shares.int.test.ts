import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient, WEB_ORIGIN } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { invite } from "../../testing-workzone";

/**
 * AICHAT-09 (05-13): read-only snapshot share links of an AI chat. The owner freezes the visible conversation into
 * `ai_chat_shares.snapshot` once; a colleague signed in to the SAME organization (with `ai_chat.share.read`) reads
 * it at `/api/v1/ai-shares/<id>`. Nothing is anonymous, no token sits in a URL, later messages or regenerations
 * never leak into an existing snapshot, and another organization, a deny rule, a revoked link and a random id all
 * read as the same 404. Real PostgreSQL + Redis, the in-process fake model.
 */

let storage: TestStorage;
let stack: AiStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let alex: TestClient;
let samId: string;
let alexId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const cid = () => `cm-${randomUUID()}`;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const createChat = (as: TestClient, body: string) =>
  as.request("POST", "/api/v1/ai-chats", { clientMessageId: cid(), body, model: PLAN_MODEL });
const send = (as: TestClient, chatId: string, body: string) =>
  as.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
    clientMessageId: cid(),
    body,
    model: PLAN_MODEL,
  });
const share = (as: TestClient, chatId: string) => as.request("POST", `/api/v1/ai-chats/${chatId}/shares`, {});
const view = (as: TestClient, shareId: string) => as.request("GET", `/api/v1/ai-shares/${shareId}`);

async function settled(generationId: string, timeoutMs = 15_000): Promise<Json> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const g = (await su.query("select * from app.ai_generations where id = $1", [generationId])).rows[0];
    if (g && g.status !== "running") return g;
    if (Date.now() > until) throw new Error(`generation ${generationId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const bodyOf = async (messageId: string) =>
  (await su.query("select body from app.messages where id = $1", [messageId])).rows[0].body as string;

/** A chat of Sam's with two finished exchanges: its id, the four bodies and the model label. */
async function twoExchanges(): Promise<{ chatId: string; bodies: string[]; label: string }> {
  const first = await ok(createChat(sam, "Plan a team offsite"), 201);
  await settled(first.generation.id);
  const second = await ok(send(sam, first.chat.id, "Add a budget"), 201);
  await settled(second.generation.id);
  // A typed title: the auto title never replaces it, so the snapshot's title is known.
  await ok(sam.request("PATCH", `/api/v1/ai-chats/${first.chat.id}`, { title: "Plan a team offsite" }));
  return {
    chatId: first.chat.id,
    bodies: [
      "Plan a team offsite",
      await bodyOf(first.assistantMessage.id),
      "Add a budget",
      await bodyOf(second.assistantMessage.id),
    ],
    label: first.generation.modelLabel,
  };
}

/** A member of a brand-new organization B who is its admin (cross-tenant probes). */
async function orgBAdmin(): Promise<TestClient> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role: "standard" }));
  const eve = new TestClient(stack.baseUrl);
  const accepted = await ok(
    eve.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name: "Eve",
      password: "eve-long-password-1",
    }),
  );
  const eveId: string = accepted.user.id;
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
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
  expect((await ok(eve.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  return eve;
}

beforeAll(async () => {
  // Garage for the share-scoped file routes (ADR-0015); every other case ignores it.
  storage = await startTestStorage();
  stack = await startAiStack({ env: storage.env });
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
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam Rivera", "standard"));
  ({ client: alex, userId: alexId } = await invite(
    stack,
    admin,
    "alex@example.test",
    "Alex Kim",
    "standard",
  ));
  await seedPlan(sam);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("create and read a snapshot (same organization, signed in)", () => {
  it("Sam shares a chat with two exchanges; Alex reads the four messages as they were, with Sam as the author", async () => {
    const { chatId, bodies, label } = await twoExchanges();
    const created = await ok(share(sam, chatId), 201);
    expect(created).toMatchObject({
      chatId,
      path: `/share/ai/${created.id}`,
      title: "Plan a team offsite",
      messageCount: 4,
      revokedAt: null,
    });
    // The path is the web route: an id, nothing else (no token, no query string).
    expect(created.path).toMatch(/^\/share\/ai\/[0-9a-f-]{36}$/u);

    const read = await ok(view(alex, created.id));
    expect(read).toMatchObject({
      id: created.id,
      title: "Plan a team offsite",
      createdBy: { kind: "user", id: samId, displayName: "Sam Rivera" },
    });
    expect(read.messages.map((m: Json) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(read.messages.map((m: Json) => m.body)).toEqual(bodies);
    expect(read.messages.map((m: Json) => m.modelLabel)).toEqual([null, label, null, label]);
    expect(read.messages.every((m: Json) => Array.isArray(m.attachments) && m.attachments.length === 0)).toBe(
      true,
    );
    // The owner reads his own link too.
    expect((await view(sam, created.id)).status).toBe(200);

    const audits = (
      await su.query(
        "select metadata from app.audit_events where action = 'ai_chat.share_created' and resource_id = $1",
        [chatId],
      )
    ).rows;
    expect(audits).toHaveLength(1);
    // Ids and the count only: never a body or the title.
    expect(audits[0].metadata).toEqual({ conversationId: chatId, shareId: created.id, messageCount: 4 });
    const viewed = (
      await su.query("select metadata from app.audit_events where action = 'ai_chat.share_viewed'")
    ).rows.filter((r) => r.metadata.shareId === created.id);
    expect(viewed.map((r) => r.metadata)).toContainEqual({ shareId: created.id, conversationId: chatId });
  });

  it("an answer still running or a failed one at share time is not in the snapshot", async () => {
    const first = await ok(createChat(sam, "Kick off"), 201);
    await settled(first.generation.id);
    // Refused before streaming: a failed answer with no text (no credential change for this code).
    const failed = await ok(send(sam, first.chat.id, "try this [[plan:unsupported:web_search]]"), 201);
    expect((await settled(failed.generation.id)).status).toBe("failed");
    const slow = await ok(send(sam, first.chat.id, "count slowly [[slow]]"), 201);
    try {
      const created = await ok(share(sam, first.chat.id), 201);
      const read = await ok(view(alex, created.id));
      expect(read.messages.map((m: Json) => m.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(created.messageCount).toBe(4);
      expect(read.messages.some((m: Json) => m.role === "assistant" && m.body === "")).toBe(false);
    } finally {
      await sam.request("POST", `/api/v1/ai-chats/${first.chat.id}/generations/${slow.generation.id}/stop`);
      await settled(slow.generation.id);
    }
  });

  it("later messages and a regenerated answer never reach an existing snapshot", async () => {
    const { chatId, bodies } = await twoExchanges();
    const created = await ok(share(sam, chatId), 201);
    const before = await ok(view(alex, created.id));

    const more = await ok(send(sam, chatId, "One more thing"), 201);
    await settled(more.generation.id);
    const regen = await ok(sam.request("POST", `/api/v1/ai-chats/${chatId}/regenerate`, {}), 201);
    await settled(regen.generation.id);
    await ok(sam.request("PATCH", `/api/v1/ai-chats/${chatId}`, { title: "Renamed later" }));

    const after = await ok(view(alex, created.id));
    expect(after).toEqual(before);
    expect(after.messages.map((m: Json) => m.body)).toEqual(bodies);
    expect(after.title).toBe("Plan a team offsite");
    // A new snapshot does see the current state.
    const fresh = await ok(share(sam, chatId), 201);
    expect(fresh.messageCount).toBe(6);
    expect(fresh.title).toBe("Renamed later");
  });
});

describe("never public, never across organizations (T-05-13-01, T-05-13-04)", () => {
  let shareId: string;
  let chatId: string;
  let missing: { status: number; body: unknown };

  beforeAll(async () => {
    const created = await ok(createChat(sam, "Private thoughts"), 201);
    await settled(created.generation.id);
    chatId = created.chat.id;
    shareId = (await ok(share(sam, chatId), 201)).id;
    const r = await view(alex, randomUUID());
    missing = { status: r.status, body: r.body };
    expect(missing.status).toBe(404);
  });

  it("an anonymous request gets 401 on every share route", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await view(anon, shareId)).status).toBe(401);
    expect((await share(anon, chatId)).status).toBe(401);
    expect((await anon.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(401);
    // Not even with the web Origin and no cookie through plain fetch.
    const raw = await fetch(`${stack.baseUrl}/api/v1/ai-shares/${shareId}`, {
      headers: { origin: WEB_ORIGIN },
    });
    expect(raw.status).toBe(401);
  });

  it("org B's admin gets the same 404 as a random id", async () => {
    const eve = await orgBAdmin();
    const r = await view(eve, shareId);
    expect(r.status).toBe(404);
    expect(r.body).toEqual(missing.body);
    expect((await share(eve, chatId)).status).toBe(404);
  });

  it("a deny rule on ai_chat.share.read for Alex reads as 404; removing it restores access", async () => {
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "ai_chat.share.read",
        effect: "deny",
      }),
    );
    try {
      const r = await view(alex, shareId);
      expect(r.status).toBe(404);
      expect(r.body).toEqual(missing.body);
      expect((await view(sam, shareId)).status).toBe(200);
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
    expect((await view(alex, shareId)).status).toBe(200);
  });

  it("only the owner creates or lists shares of a chat (Alex and the admin get 404)", async () => {
    expect((await share(alex, chatId)).status).toBe(404);
    expect((await share(admin, chatId)).status).toBe(404);
    expect((await alex.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(404);
    expect((await admin.request("GET", `/api/v1/ai-chats/${chatId}/shares`)).status).toBe(404);
    const mine = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}/shares`));
    expect(mine.shares.map((s: Json) => s.id)).toEqual([shareId]);
  });
});

describe("revoke (T-05-13-03): only the creator, at once, idempotent", () => {
  it("Sam revokes his link: Alex's next read is the same 404 as a random id; the list shows it revoked", async () => {
    const created = await ok(createChat(sam, "Short-lived share"), 201);
    await settled(created.generation.id);
    const chatId = created.chat.id;
    const s = await ok(share(sam, chatId), 201);
    expect((await view(alex, s.id)).status).toBe(200);
    const missing = await view(alex, randomUUID());

    // Alex cannot revoke Sam's link, nor can the admin.
    expect((await alex.request("DELETE", `/api/v1/ai-shares/${s.id}`)).status).toBe(404);
    expect((await admin.request("DELETE", `/api/v1/ai-shares/${s.id}`)).status).toBe(404);
    expect((await view(alex, s.id)).status).toBe(200);

    const revoked = await ok(sam.request("DELETE", `/api/v1/ai-shares/${s.id}`));
    expect(revoked).toMatchObject({ id: s.id, chatId, messageCount: s.messageCount });
    expect(typeof revoked.revokedAt).toBe("string");

    const after = await view(alex, s.id);
    expect(after.status).toBe(404);
    expect(after.body).toEqual(missing.body);
    // The owner too: a revoked link is gone for everyone.
    expect((await view(sam, s.id)).status).toBe(404);

    // Idempotent: the same answer, one audit row.
    const again = await ok(sam.request("DELETE", `/api/v1/ai-shares/${s.id}`));
    expect(again.revokedAt).toBe(revoked.revokedAt);
    const audits = (
      await su.query(
        "select metadata from app.audit_events where action = 'ai_chat.share_revoked' and resource_id = $1",
        [chatId],
      )
    ).rows;
    expect(audits.map((a) => a.metadata)).toEqual([{ conversationId: chatId, shareId: s.id }]);

    const list = await ok(sam.request("GET", `/api/v1/ai-chats/${chatId}/shares`));
    expect(list.shares).toEqual([expect.objectContaining({ id: s.id, revokedAt: revoked.revokedAt })]);
    // A random id is 404, never 500.
    expect((await sam.request("DELETE", `/api/v1/ai-shares/${randomUUID()}`)).status).toBe(404);
  });

  it("an anonymous revoke is 401", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await anon.request("DELETE", `/api/v1/ai-shares/${randomUUID()}`)).status).toBe(401);
  });
});

describe("images in a snapshot: through the share only, and only the snapshot's own files (T-05-13-02)", () => {
  /** A request that does not follow redirects (file routes answer 302 to a presigned URL). */
  const raw = (client: TestClient, path: string) =>
    fetch(`${stack.baseUrl}${path}`, {
      redirect: "manual",
      headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
    });

  const png = () =>
    sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .png()
      .toBuffer();

  /** presign → PUT straight to Garage → complete: the attachment DTO. */
  async function upload(as: TestClient, conv: string, filename: string): Promise<Json> {
    const bytes = await png();
    const p = await ok(
      as.request("POST", `/api/v1/conversations/${conv}/attachments`, {
        filename,
        contentType: "image/png",
        size: bytes.length,
      }),
    );
    const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
    expect(put.status).toBe(200);
    return ok(as.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
  }

  async function sendWithFile(chatId: string, body: string, fileId: string) {
    const res = await ok(
      sam.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
        clientMessageId: cid(),
        body,
        model: PLAN_MODEL,
        attachmentIds: [fileId],
      }),
      201,
    );
    await settled(res.generation.id);
  }

  let chatId: string;
  let shareId: string;
  let inSnapshot: Json;
  let later: Json;

  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      const cfg = await ok(sam.request("GET", "/api/v1/attachments/config"));
      if (cfg.enabled) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const draft = await ok(sam.request("POST", "/api/v1/ai-chats/drafts", {}), 201);
    chatId = draft.id;
    inSnapshot = await upload(sam, chatId, "q3-chart.png");
    await sendWithFile(chatId, "what does this chart show?", inSnapshot.id);
    shareId = (await ok(share(sam, chatId), 201)).id;
    // Sent after the snapshot, in the same chat and by the same owner: never reachable through it.
    later = await upload(sam, chatId, "later.png");
    await sendWithFile(chatId, "and this one?", later.id);
  }, 120_000);

  it("the snapshot lists the image with share-scoped URLs only", async () => {
    const read = await ok(view(alex, shareId));
    const [user] = read.messages;
    const base = `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}`;
    expect(user.attachments).toEqual([
      {
        id: inSnapshot.id,
        filename: "q3-chart.png",
        contentType: "image/png",
        size: inSnapshot.size,
        isImage: true,
        width: 320,
        height: 200,
        previewUrl: `${base}/preview`,
        largeUrl: `${base}/large`,
        downloadUrl: `${base}/download`,
      },
    ]);
    expect(JSON.stringify(read)).not.toContain("/api/v1/attachments/");
    expect(JSON.stringify(read)).not.toContain(later.id);
    const row = (await su.query("select attachment_ids from app.ai_chat_shares where id = $1", [shareId]))
      .rows[0];
    expect(row.attachment_ids).toEqual([inSnapshot.id]);
  });

  it("Alex gets the renditions through the share (302, no-store, CORP) while the chat route stays 404", async () => {
    for (const [path, part] of [
      ["preview", "thumb.webp"],
      ["large", "large.webp"],
    ] as const) {
      const r = await raw(alex, `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}/${path}`);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toContain(`/att/${inSnapshot.id}/${part}`);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      const img = await fetch(r.headers.get("location") as string);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/webp");
    }
    // The chat itself stays private: the Phase 4 routes do not open up for Alex.
    for (const path of ["preview", "large", "download"]) {
      expect((await raw(alex, `/api/v1/attachments/${inSnapshot.id}/${path}`)).status).toBe(404);
    }
  });

  it("a file of Sam's that is not in this snapshot is 404 through the share", async () => {
    for (const path of ["preview", "large", "download"]) {
      expect((await raw(alex, `/api/v1/ai-shares/${shareId}/attachments/${later.id}/${path}`)).status).toBe(
        404,
      );
      expect(
        (await raw(alex, `/api/v1/ai-shares/${shareId}/attachments/${randomUUID()}/${path}`)).status,
      ).toBe(404);
    }
    // Sam's own chat route still serves it to Sam (Phase 4 behaviour unchanged).
    expect((await raw(sam, `/api/v1/attachments/${later.id}/preview`)).status).toBe(302);
  });

  it("the download is audited with the share id; anonymous and other-org readers get nothing", async () => {
    const r = await raw(alex, `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}/download`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain(`/att/${inSnapshot.id}/original`);
    const audits = (
      await su.query(
        "select metadata from app.audit_events where action = 'attachment.downloaded' and resource_id = $1",
        [inSnapshot.id],
      )
    ).rows;
    expect(audits.map((a) => a.metadata)).toContainEqual({
      attachmentId: inSnapshot.id,
      conversationId: chatId,
      shareId,
    });
    const anon = new TestClient(stack.baseUrl);
    expect(
      (await raw(anon, `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}/preview`)).status,
    ).toBe(401);
    const eve = await orgBAdmin();
    expect((await raw(eve, `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}/preview`)).status).toBe(
      404,
    );
  });

  it("after revoke every file route of the share is 404", async () => {
    await ok(sam.request("DELETE", `/api/v1/ai-shares/${shareId}`));
    for (const path of ["preview", "large", "download"]) {
      expect(
        (await raw(alex, `/api/v1/ai-shares/${shareId}/attachments/${inSnapshot.id}/${path}`)).status,
      ).toBe(404);
    }
  });
});
