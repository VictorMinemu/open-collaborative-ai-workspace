import { randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type RuntimeCatalog, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, type FakeDevice, type Frame, sleep } from "../../testing-device";
import { startTestStorage, TEST_BUCKET, type TestStorage } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  createTeamProject,
  errorCode,
  invite,
  linkRepo,
  model,
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
type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

/** The Codex catalog this suite's device reports (P-08): one model that reads images, one that does not, one unknown. */
const CODEX: RuntimeCatalog = {
  ...CODEX_CATALOG,
  models: [
    model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, imageInput: true }),
    model("gpt-6.1-text", "GPT-6.1 Text", { imageInput: false }),
    model("gpt-5.9", "GPT-5.9"),
  ],
};

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let s3: S3Client;
let admin: TestClient;
let dana: TestClient;
let orgId: string;
let adminId: string;
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
  adminId = setup.user.id;
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
  device.capabilities([CLAUDE_CATALOG, CODEX], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  // The test device's hello reports Codex signed out; this suite runs Codex sessions too.
  await su.query(
    `update app.devices set runtime_info = (
       select jsonb_agg(case when r->>'id' = 'codex' then r || '{"loggedIn": true}'::jsonb else r end)
       from jsonb_array_elements(runtime_info) r)
     where id = $1`,
    [deviceId],
  );
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

/** Ack a dispatched prompt and complete its turn on the device. */
function finish(cmd: Cmd) {
  device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  device.event(cmd.sessionId, { type: "prompt.started", promptId });
  device.event(cmd.sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

async function newSession(body: Json): Promise<{ id: string; conv: string }> {
  const id = await startSession(admin, device, projectId, body);
  const conv = (await ok(admin.request("GET", `/api/v1/work-sessions/${id}`))).session.conversationId;
  return { id, conv };
}

const promptCount = async (sid: string) =>
  Number(
    (await su.query("select count(*)::int as n from app.work_prompts where work_session_id = $1", [sid]))
      .rows[0].n,
  );

describe("the model gate (D-05, P-08): images never go to a model that says it cannot read them", () => {
  it("a Codex session on a text-only model refuses images at submit with 400 images_not_supported", async () => {
    const { id, conv } = await newSession({ runtime: "codex", model: "gpt-6.1-text", title: "Text only" });
    const att = await upload(admin, conv, "photo.jpg", "image/jpeg", jpeg);
    const res = await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, {
      body: "what is this?",
      attachmentIds: [att.id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorCode(res)).toBe("images_not_supported");
    expect((res.body!.error as Json).message).toBe("GPT-6.1 Text can't read images");
    expect(await promptCount(id)).toBe(0);
    const row = (await su.query("select work_prompt_id from app.attachments where id = $1", [att.id]))
      .rows[0];
    expect(row.work_prompt_id).toBeNull();
    // Text alone still goes.
    await ok(admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "just text" }));
    finish(await device.command("prompt", id));
  });

  it("a model whose image support is unknown (imageInput absent) is accepted", async () => {
    const { id, conv } = await newSession({ runtime: "codex", model: "gpt-5.9", title: "Unknown" });
    const att = await upload(admin, conv, "photo.jpg", "image/jpeg", jpeg);
    const prompt = await ok(
      admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, {
        body: "what is this?",
        attachmentIds: [att.id],
      }),
    );
    expect(prompt.attachments.map((a: Json) => a.id)).toEqual([att.id]);
    const cmd = await device.command("prompt", id);
    expect(cmd.payload.promptId).toBe(prompt.id);
    finish(cmd);
  });

  it("a queued image prompt whose model changed to a text-only one is refused at dispatch, audited, never sent", async () => {
    const { id, conv } = await newSession({ runtime: "codex", title: "Switch" });
    const first = await ok(admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "first" }));
    const firstCmd = await device.command("prompt", id);
    expect(firstCmd.payload.promptId).toBe(first.id);

    const att = await upload(admin, conv, "photo.jpg", "image/jpeg", jpeg);
    const withImage = await ok(
      admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, {
        body: "look at this",
        attachmentIds: [att.id],
      }),
    );
    expect(withImage.status).toBe("queued");
    await ok(admin.request("PATCH", `/api/v1/work-sessions/${id}/settings`, { model: "gpt-6.1-text" }));
    const third = await ok(admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "third" }));

    finish(firstCmd);
    const next = await device.command("prompt", id);
    expect(next.payload.promptId).toBe(third.id);
    await sleep(150);
    expect(device.pending("prompt").filter((f) => (f as Cmd).payload.promptId === withImage.id)).toEqual([]);

    const detail = await ok(admin.request("GET", `/api/v1/work-sessions/${id}`));
    const refused = (detail.prompts as Json[]).find((p) => p.id === withImage.id)!;
    expect(refused.status).toBe("failed");
    expect(refused.attachments.map((a: Json) => a.id)).toEqual([att.id]);
    const audit = await su.query(
      "select result, metadata from app.audit_events where action = 'work_prompt.refused' and resource_id = $1",
      [withImage.id],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        result: "denied",
        metadata: expect.objectContaining({ promptId: withImage.id, reason: "images_not_supported" }),
      }),
    ]);
    const cmds = await su.query(
      "select count(*)::int as n from app.device_commands where kind = 'prompt' and payload->>'promptId' = $1",
      [withImage.id],
    );
    expect(cmds.rows[0].n).toBe(0);
    finish(next);
  });

  it("GET /controls exposes imageInput on each model as the device reported it", async () => {
    const { id } = await newSession({ runtime: "codex", title: "Controls" });
    const c = await ok(admin.request("GET", `/api/v1/work-sessions/${id}/controls`));
    const byId = new Map((c.models as Json[]).map((m) => [m.id, m]));
    expect(byId.get("gpt-6.1-sol")!.imageInput).toBe(true);
    expect(byId.get("gpt-6.1-text")!.imageInput).toBe(false);
    expect(byId.get("gpt-5.9")!.imageInput).toBeUndefined();
  });
});

/** A client whose membership moved to a fresh organization B (the artifact suite's `otherOrgAdmin` pattern). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string }> {
  const email = `eve-${randomUUID().slice(0, 8)}@example.test`;
  const { client, userId } = await invite(stack, admin, email, "Eve", "admin");
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  return { client, orgB };
}

const queuedAudits = async (sid: string) =>
  Number(
    (
      await su.query(
        "select count(*)::int as n from app.audit_events where action = 'work_prompt.queued' and session_id = $1",
        [sid],
      )
    ).rows[0].n,
  );

describe("access: only the session's controllers upload, only its readers see (D-03, P-04, WZ-IMG-04)", () => {
  let riley: TestClient;
  let pat: TestClient;
  let eve: TestClient;
  let sent: Json;
  let unsent: Json;

  beforeAll(async () => {
    // Riley: a standard member (no Work Zone access at all). Pat: a developer who reads sessions but is denied
    // `work_session.prompt` by a user rule. Eve: the admin of another organization.
    let rileyId: string;
    ({ client: riley, userId: rileyId } = await invite(
      stack,
      admin,
      "riley@example.test",
      "Riley Park",
      "standard",
    ));
    let patId: string;
    ({ client: pat, userId: patId } = await invite(stack, admin, "pat@example.test", "Pat Doe", "developer"));
    // Explicit access (07.9-03, D-06): Pat reads the admin's session, and Riley's role (not a missing audience) is
    // what refuses her, as fellow members of a team project the `ocw` repo is linked to. Dana keeps her device grant
    // and joins the project too, so linking the repo leaves her a reader.
    const { unitId } = await createTeamProject(stack, admin, {
      name: "OCW",
      members: [{ userId: adminId }, { userId: danaId }, { userId: patId }, { userId: rileyId }],
    });
    await linkRepo(stack, { organizationId: orgId, unitId, projectId, deviceId, linkedBy: adminId });
    await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: patId,
        permission: "work_session.prompt",
        effect: "deny",
      }),
    );
    ({ client: eve } = await otherOrgAdmin());
    sent = await upload(admin, sessionConv, "sent.jpg", "image/jpeg", jpeg);
    const prompt = await ok(
      admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
        body: "and this one?",
        attachmentIds: [sent.id],
      }),
    );
    finish(await device.command("prompt", sessionId));
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [prompt.id]);
      return r.rows[0].status === "completed";
    });
    unsent = await upload(admin, sessionConv, "unsent.jpg", "image/jpeg", jpeg);
  });

  it("presign: another tenant's admin and a member without Work Zone access get 404", async () => {
    for (const client of [eve, riley]) {
      const res = await presign(client, sessionConv, "x.jpg", "image/jpeg", jpeg.length);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: "Conversation not found" } });
    }
  });

  it("presign: a member who reads the session but may not prompt it gets 403", async () => {
    expect((await ok(pat.request("GET", `/api/v1/work-sessions/${sessionId}`))).session.id).toBe(sessionId);
    const res = await presign(pat, sessionConv, "x.jpg", "image/jpeg", jpeg.length);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("presign: a PDF is 400 images_only; an archived session is 409 session_archived", async () => {
    const pdf = await presign(admin, sessionConv, "spec.pdf", "application/pdf", 1000);
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(400);
    expect(errorCode(pdf)).toBe("images_only");
    expect((pdf.body!.error as Json).message).toBe(
      "Only images (PNG, JPEG, GIF, WebP) can be attached to a Work Zone prompt",
    );
    const { id, conv } = await newSession({ title: "Archived" });
    await ok(admin.request("POST", `/api/v1/work-sessions/${id}/archive`));
    const archived = await presign(admin, conv, "x.jpg", "image/jpeg", jpeg.length);
    expect(archived.status, JSON.stringify(archived.body)).toBe(409);
    expect(errorCode(archived)).toBe("session_archived");
  });

  it("presign into a channel is unchanged: any declared type (the images-only rule is the session scope's)", async () => {
    expect((await presign(admin, general, "spec.pdf", "application/pdf", 1000)).status).toBe(200);
  });

  it("previews, large and download of a sent image are 404 for a non-reader and for another tenant", async () => {
    for (const path of ["preview", "large", "download"]) {
      expect((await raw(admin, `/api/v1/attachments/${sent.id}/${path}`)).status, path).toBe(302);
      expect((await raw(dana, `/api/v1/attachments/${sent.id}/${path}`)).status, path).toBe(302);
      expect((await raw(riley, `/api/v1/attachments/${sent.id}/${path}`)).status, path).toBe(404);
      expect((await raw(eve, `/api/v1/attachments/${sent.id}/${path}`)).status, path).toBe(404);
    }
  });

  it("an unsent upload stays its uploader's own: 404 for Dana", async () => {
    expect((await raw(admin, `/api/v1/attachments/${unsent.id}/preview`)).status).toBe(302);
    expect((await raw(dana, `/api/v1/attachments/${unsent.id}/preview`)).status).toBe(404);
    expect((await raw(dana, `/api/v1/attachments/${unsent.id}/download`)).status).toBe(404);
  });
});

describe("linking: only the sender's own ready session images (D-03, P-05, T-06.1-01-01)", () => {
  /** Refused ids by case; each must give the one 409 and leave no trace. */
  const cases: Array<[string, () => Promise<string[]>]> = [];
  let alreadyLinked: string;
  /** Rows the refusals must leave unlinked. */
  let untouched: string[] = [];

  beforeAll(async () => {
    const danas = await upload(dana, sessionConv, "dana.jpg", "image/jpeg", jpeg);
    const other = await newSession({ title: "Other session" });
    const elsewhere = await upload(admin, other.conv, "elsewhere.jpg", "image/jpeg", jpeg);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#f80" } })
      .png()
      .toBuffer();
    const channel = await upload(admin, general, "channel.png", "image/png", png);
    const pending = await ok(presign(admin, sessionConv, "pending.jpg", "image/jpeg", jpeg.length));
    // Another tenant's row that matches everything else (Víctor as uploader, this session's conversation, a ready
    // image with renditions): RLS must hide it.
    const { orgB } = await otherOrgAdmin();
    const foreign = randomUUID();
    await su.query(
      `insert into app.attachments (id, organization_id, conversation_id, uploader_id, filename, declared_type,
         content_type, size_bytes, status, has_renditions, width, height)
       values ($1, $2, $3, $4, 'b.png', 'image/png', 'image/png', 10, 'ready', true, 8, 8)`,
      [foreign, orgB, sessionConv, adminId],
    );
    // A ready non-image of Víctor's in this session (the scope never presigns one; inserted to prove the link rule).
    const pdf = randomUUID();
    await su.query(
      `insert into app.attachments (id, organization_id, conversation_id, uploader_id, filename, declared_type,
         content_type, size_bytes, status, has_renditions)
       values ($1, $2, $3, $4, 'spec.pdf', 'application/pdf', 'application/pdf', 10, 'ready', false)`,
      [pdf, orgId, sessionConv, adminId],
    );
    const linked = await upload(admin, sessionConv, "linked.jpg", "image/jpeg", jpeg);
    const first = await ok(
      admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
        body: "first use",
        attachmentIds: [linked.id],
      }),
    );
    finish(await device.command("prompt", sessionId));
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [first.id]);
      return r.rows[0].status === "completed";
    });
    alreadyLinked = linked.id;
    const mine = await upload(admin, sessionConv, "mine.jpg", "image/jpeg", jpeg);
    untouched = [mine.id, danas.id, elsewhere.id, channel.id, foreign, pending.attachment.id, pdf];
    cases.push(
      ["another member's image in the same session", async () => [danas.id]],
      ["the sender's image in another session", async () => [elsewhere.id]],
      ["the sender's image in a channel", async () => [channel.id]],
      ["another tenant's id", async () => [foreign]],
      ["an id already linked to an earlier prompt", async () => [alreadyLinked]],
      ["a pending upload", async () => [pending.attachment.id]],
      ["a non-image", async () => [pdf]],
      ["the same id twice", async () => [mine.id, mine.id]],
      ["a random uuid", async () => [randomUUID()]],
      ["a good id next to a refused one", async () => [mine.id, danas.id]],
    );
  });

  it("every refused id is the same 409 attachment_not_linkable; nothing is queued, sent or audited", async () => {
    await eventually(async () => {
      const r = await su.query("select status from app.work_sessions where id = $1", [sessionId]);
      return r.rows[0].status === "idle";
    });
    const before = { prompts: await promptCount(sessionId), audits: await queuedAudits(sessionId) };
    for (const [name, ids] of cases) {
      const res = await admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
        body: `refused: ${name}`,
        attachmentIds: await ids(),
      });
      expect(res.status, name).toBe(409);
      expect(res.body, name).toEqual({
        error: {
          code: "attachment_not_linkable",
          message: "One or more attachments cannot be added to this prompt",
        },
      });
    }
    await sleep(200);
    expect(await promptCount(sessionId)).toBe(before.prompts);
    expect(await queuedAudits(sessionId)).toBe(before.audits);
    expect(device.pending("prompt").filter((f) => (f as Cmd).sessionId === sessionId)).toEqual([]);
    // The good id refused next to a bad one is still free (the transaction rolled back); nothing else got linked.
    const free = await su.query(
      "select id from app.attachments where id = any($1) and work_prompt_id is null",
      [untouched],
    );
    expect(free.rows.map((r) => r.id).sort()).toEqual([...untouched].sort());
  });

  it("5 ids are refused by the schema (400)", async () => {
    const res = await admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
      body: "too many",
      attachmentIds: [1, 2, 3, 4, 5].map(() => randomUUID()),
    });
    expect(res.status).toBe(400);
  });
});

describe("audit: ids and a count, never bytes (D-03, T-06.1-01-05, T-06.1-01-06)", () => {
  it("work_prompt.queued records attachmentIds in request order and imageCount", async () => {
    const a = await upload(admin, sessionConv, "a.jpg", "image/jpeg", jpeg);
    const b = await upload(admin, sessionConv, "b.jpg", "image/jpeg", jpeg);
    const prompt = await ok(
      admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, {
        body: "two images",
        attachmentIds: [b.id, a.id],
      }),
    );
    expect(prompt.attachments.map((x: Json) => x.id).sort()).toEqual([a.id, b.id].sort());
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_prompt.queued' and resource_id = $1",
      [prompt.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ attachmentIds: [b.id, a.id], imageCount: 2 });
    finish(await device.command("prompt", sessionId));
  });

  it("no audit row's metadata contains a base64 run", async () => {
    const rows = await su.query("select action, metadata::text as m from app.audit_events");
    expect(rows.rows.length).toBeGreaterThan(0);
    const leaks = rows.rows.filter((r) => /[A-Za-z0-9+/]{200,}/.test(r.m)).map((r) => r.action);
    expect(leaks).toEqual([]);
  });
});
