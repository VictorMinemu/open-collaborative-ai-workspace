import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_FILE_ROUTE, type RuntimeCatalog } from "@ocw/contracts";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice, type Frame, sleep } from "../../testing-device";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  errorCode,
  invite,
  model,
  pairDevice,
  startSession,
} from "../../testing-workzone";

/**
 * ADR-0045: a person attaches ANY file to a Work Zone prompt. Images the model reads still go inline (06.1); every other
 * file, and an image the model can't read, is copied into the session's working tree before the turn, through the
 * transfer of ADR-0041: one `to_device` ledger row per file, owned by the prompt; the `prompt` command lists
 * `files` (transfer id, `.ocw/uploads/<name>`, size, sha256; never bytes or a URL); the device fetches each one with its
 * own device JWT. The sender is the actor: only their own uploads of this session link. A device that would drop the
 * files is refused up front with the update sentence. Real PostgreSQL + Redis + Garage.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const MIB = 1024 * 1024;
/** A file name no audit row, ledger row or log line may carry (P1). */
const PDF_NAME = "quarterly-spec-otter.pdf";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

const CODEX: RuntimeCatalog = {
  ...CODEX_CATALOG,
  models: [
    model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, imageInput: true }),
    model("gpt-6.1-text", "GPT-6.1 Text", { imageInput: false }),
  ],
};

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let dana: TestClient;
let orgId: string;
let danaId: string;
/** A current daemon: announces `promptFiles`. */
let device: FakeDevice;
let projectId: string;
/** An older daemon: no `promptFiles`. */
let oldDevice: FakeDevice;
let oldProjectId: string;
let png: Buffer;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** presign + PUT + complete through the Phase 4 routes into `conv`; returns the completed attachment. */
async function upload(
  client: TestClient,
  conv: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
) {
  const p = await ok(
    client.request("POST", `/api/v1/conversations/${conv}/attachments`, {
      filename,
      contentType,
      size: bytes.length,
    }),
  );
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: bytes });
  expect(put.status).toBe(200);
  return ok(client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`));
}

async function newSession(d: FakeDevice, project: string, body: Json = {}) {
  const id = await startSession(admin, d, project, body);
  const conv = (await ok(admin.request("GET", `/api/v1/work-sessions/${id}`))).session
    .conversationId as string;
  return { id, conv };
}

const prompt = (client: TestClient, sid: string, body: string, attachmentIds: string[]) =>
  client.request("POST", `/api/v1/work-sessions/${sid}/prompts`, { body, attachmentIds });

const promptCount = async (sid: string) =>
  Number(
    (await su.query("select count(*)::int as n from app.work_prompts where work_session_id = $1", [sid]))
      .rows[0].n,
  );

const ledger = async (sid: string) =>
  (
    await su.query(
      "select id, work_prompt_id, agent_id, event_id, direction, attachment_id, size_bytes, sha256, path_length, status, max_bytes, limit_source from app.bot_work_session_files where work_session_id = $1 order by created_at",
      [sid],
    )
  ).rows;

/** The device's GET of a transfer with its own JWT (what the daemon does before the turn). */
const fetchTransfer = (d: FakeDevice, transferId: string) =>
  fetch(`${stack.baseUrl}${RUNTIME_FILE_ROUTE}/${transferId}`, {
    headers: { authorization: `Bearer ${d.jwt}` },
  });

function startTurn(d: FakeDevice, cmd: Cmd) {
  d.ack(cmd.id);
  d.event(cmd.sessionId, { type: "prompt.started", promptId: cmd.payload.promptId as string });
}

function completeTurn(d: FakeDevice, cmd: Cmd) {
  d.event(cmd.sessionId, {
    type: "prompt.completed",
    promptId: cmd.payload.promptId as string,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

beforeAll(async () => {
  storage = await startTestStorage();
  stack = await startTestStack({ env: storage.env });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
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
  ({ device, projectId } = await connectWithProject(
    stack,
    admin,
    paired.token,
    { localId: "lp_ocw", name: "ocw" },
    { promptFiles: 1, codexLoggedIn: true },
  ));
  device.capabilities([CLAUDE_CATALOG, CODEX], false);
  const oldPaired = await pairDevice(stack, admin, "Old laptop");
  ({ device: oldDevice, projectId: oldProjectId } = await connectWithProject(stack, admin, oldPaired.token, {
    localId: "lp_old",
    name: "old",
  }));
  oldDevice.capabilities([CLAUDE_CATALOG, CODEX], false);
  await eventually(async () => {
    const r = await su.query(
      "select count(*)::int as n from app.devices where jsonb_array_length(runtime_catalog) = 2",
    );
    return r.rows[0].n === 2;
  });
  await ok(
    admin.request("PUT", `/api/v1/devices/${paired.deviceId}/grants/user/${danaId}`, {
      maxMode: "acceptEdits",
    }),
  );
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#09f" } })
    .png()
    .toBuffer();
}, 240_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await oldDevice?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  await storage?.stop();
});

describe("any file joins a prompt; the device gets it before the turn (ADR-0045)", () => {
  it("hello.promptFiles is recorded from the device's own hello; controls say so with the per-file limit", async () => {
    const versions = await su.query("select name, prompt_files_version from app.devices order by name");
    expect(versions.rows).toEqual([
      { name: "Old laptop", prompt_files_version: null },
      { name: "Víctor's MacBook", prompt_files_version: 1 },
    ]);
    const { id } = await newSession(device, projectId, { title: "Controls" });
    expect((await ok(admin.request("GET", `/api/v1/work-sessions/${id}/controls`))).files).toEqual({
      supported: true,
      maxBytes: 25 * MIB,
    });
    const old = await newSession(oldDevice, oldProjectId, { title: "Old controls" });
    expect((await ok(admin.request("GET", `/api/v1/work-sessions/${old.id}/controls`))).files).toEqual({
      supported: false,
      maxBytes: 25 * MIB,
    });
  });

  it("a PDF and an image: the image inline, the PDF listed in `files`, fetched once with the device JWT, audited without a name", async () => {
    const { id, conv } = await newSession(device, projectId, { title: "Spec" });
    const pdf = await upload(admin, conv, PDF_NAME, "application/pdf", PDF);
    expect(pdf).toMatchObject({ status: "ready", isImage: false });
    const img = await upload(admin, conv, "shot.png", "image/png", png);
    const p = await ok(prompt(admin, id, "Summarise the spec and match the screenshot", [pdf.id, img.id]));
    expect(p.attachments.map((a: Json) => a.id)).toEqual([pdf.id, img.id]);

    const cmd = (await device.command("prompt", id)) as Cmd;
    expect(cmd.payload.text).toBe("Summarise the spec and match the screenshot");
    expect((cmd.payload.images as Json[]).map((i) => i.mediaType)).toEqual(["image/png"]);
    const files = cmd.payload.files as Json[];
    expect(files).toEqual([
      {
        transferId: expect.any(String),
        path: `.ocw/uploads/${PDF_NAME}`,
        sizeBytes: PDF.length,
        sha256: createHash("sha256").update(PDF).digest("hex"),
      },
    ]);
    expect(JSON.stringify(cmd.payload)).not.toMatch(/https?:\/\//);

    const rows = await ledger(id);
    expect(rows).toEqual([
      expect.objectContaining({
        id: files[0]!.transferId,
        work_prompt_id: p.id,
        agent_id: null,
        event_id: null,
        direction: "to_device",
        attachment_id: pdf.id,
        size_bytes: String(PDF.length),
        path_length: `.ocw/uploads/${PDF_NAME}`.length,
        status: "pending",
        // The organization's 25 MB default ties the server's; the outer level is named (ADR-0041 § 8).
        limit_source: "server",
      }),
    ]);

    // Another device's JWT gets nothing; the session's device gets the bytes once.
    expect((await fetchTransfer(oldDevice, files[0]!.transferId)).status).toBe(404);
    const got = await fetchTransfer(device, files[0]!.transferId);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await fetchTransfer(device, files[0]!.transferId)).status).toBe(410);
    await eventually(async () => (await ledger(id))[0]?.status === "streamed");

    startTurn(device, cmd);
    await eventually(async () => (await ledger(id))[0]?.status === "done");
    const audit = await su.query(
      "select user_id, device_id, session_id, result, metadata from app.audit_events where action = 'work_session.file_upload' and session_id = $1",
      [id],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        result: "success",
        session_id: id,
        metadata: expect.objectContaining({
          promptId: p.id,
          attachmentId: pdf.id,
          bytes: PDF.length,
          pathLength: `.ocw/uploads/${PDF_NAME}`.length,
        }),
      }),
    ]);
    const queued = await su.query(
      "select metadata from app.audit_events where action = 'work_prompt.queued' and resource_id = $1",
      [p.id],
    );
    expect(queued.rows[0].metadata).toMatchObject({
      attachmentIds: [pdf.id, img.id],
      imageCount: 1,
      fileCount: 1,
    });
    const leaks = await su.query(
      "select action from app.audit_events where metadata::text like '%otter%' or metadata::text like '%.ocw/uploads%'",
    );
    expect(leaks.rows).toEqual([]);
    completeTurn(device, cmd);
  });

  it("an image on a model that can't read images is copied into the tree instead of refused", async () => {
    const { id, conv } = await newSession(device, projectId, { runtime: "codex", model: "gpt-6.1-text" });
    const img = await upload(admin, conv, "diagram.png", "image/png", png);
    await ok(prompt(admin, id, "Describe the diagram", [img.id]));
    const cmd = (await device.command("prompt", id)) as Cmd;
    expect(cmd.payload.images).toBeUndefined();
    expect((cmd.payload.files as Json[]).map((f) => f.path)).toEqual([".ocw/uploads/diagram.png"]);
    startTurn(device, cmd);
    completeTurn(device, cmd);
  });

  it("a file the device could not land fails the prompt with the device's sentence; its transfer is failed and audited", async () => {
    const { id, conv } = await newSession(device, projectId, { title: "Fails" });
    const notes = await upload(admin, conv, "notes.md", "text/markdown", Buffer.from("# Notes\n"));
    const p = await ok(prompt(admin, id, "Read my notes", [notes.id]));
    const cmd = (await device.command("prompt", id)) as Cmd;
    const sentence = "Could not copy notes.md into the working tree (no_space). The prompt was not run.";
    device.ack(cmd.id, false, sentence);
    await eventually(async () => (await ledger(id))[0]?.status === "failed");
    const detail = await ok(admin.request("GET", `/api/v1/work-sessions/${id}`));
    expect((detail.prompts as Json[]).find((x) => x.id === p.id)!.status).toBe("failed");
    expect(detail.session.lastError).toBe(sentence);
    const audit = await su.query(
      "select result, metadata from app.audit_events where action = 'work_session.file_upload' and session_id = $1",
      [id],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({
        result: "error",
        metadata: expect.objectContaining({ failure: "transfer_failed" }),
      }),
    ]);
  });
});

describe("refusals at submit: nothing is queued, linked or sent (ADR-0045)", () => {
  it("a device whose runtime is too old: 409 runtime_too_old with the update sentence; images alone still go", async () => {
    const { id, conv } = await newSession(oldDevice, oldProjectId, { title: "Old" });
    const pdf = await upload(admin, conv, "spec.pdf", "application/pdf", PDF);
    const res = await prompt(admin, id, "Read the spec", [pdf.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorCode(res)).toBe("runtime_too_old");
    expect((res.body!.error as Json).message).toBe("Update this device to attach files (Settings › Devices)");
    expect(await promptCount(id)).toBe(0);
    expect(
      (await su.query("select work_prompt_id from app.attachments where id = $1", [pdf.id])).rows[0],
    ).toEqual({
      work_prompt_id: null,
    });
    const img = await upload(admin, conv, "shot.png", "image/png", png);
    await ok(prompt(admin, id, "Look", [img.id]));
    const cmd = (await oldDevice.command("prompt", id)) as Cmd;
    expect(cmd.payload.files).toBeUndefined();
    startTurn(oldDevice, cmd);
    completeTurn(oldDevice, cmd);
  });

  it("over the per-file limit (the organization's, lowered to 1 MB): 400 file_too_large naming the file", async () => {
    const { id, conv } = await newSession(device, projectId, { title: "Big" });
    const big = await upload(admin, conv, "dump.bin", "application/octet-stream", Buffer.alloc(MIB + 512, 7));
    await ok(admin.request("PUT", "/api/v1/work-zone-policy", { botFileMaxBytes: MIB }));
    try {
      const res = await prompt(admin, id, "Inspect the dump", [big.id]);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body!.error).toEqual({
        code: "file_too_large",
        message: "dump.bin: Over the 1 MB limit",
        details: { attachmentId: big.id, maxBytes: MIB, limitSource: "organization" },
      });
      expect(await promptCount(id)).toBe(0);
      expect((await ok(admin.request("GET", `/api/v1/work-sessions/${id}/controls`))).files.maxBytes).toBe(
        MIB,
      );
    } finally {
      await ok(admin.request("PUT", "/api/v1/work-zone-policy", { botFileMaxBytes: 25 * MIB }));
    }
  });

  it("a key or credentials file: 400 file_name_not_allowed (the shared deny list)", async () => {
    const { id, conv } = await newSession(device, projectId, { title: "Key" });
    const key = await upload(
      admin,
      conv,
      "server.key",
      "application/octet-stream",
      Buffer.from("-----BEGIN-----"),
    );
    const res = await prompt(admin, id, "Use this key", [key.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body!.error).toEqual({
      code: "file_name_not_allowed",
      message: "server.key: Keys and credential files can't be attached; keep them in the secret store",
      details: { attachmentId: key.id, reason: "secret" },
    });
    expect(await promptCount(id)).toBe(0);
  });

  it("another member's file in the same session, and another tenant's id, are the one 409 attachment_not_linkable", async () => {
    const { id, conv } = await newSession(device, projectId, { title: "Mine only" });
    const danas = await upload(dana, conv, "dana.pdf", "application/pdf", PDF);
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    const adminId = (await su.query("select id from auth.user where email = $1", [ADMIN.email])).rows[0].id;
    const foreign = randomUUID();
    await su.query(
      `insert into app.attachments (id, organization_id, conversation_id, uploader_id, filename, declared_type,
         content_type, size_bytes, status, has_renditions)
       values ($1, $2, $3, $4, 'b.pdf', 'application/pdf', 'application/pdf', 10, 'ready', false)`,
      [foreign, orgB, conv, adminId],
    );
    for (const ids of [[danas.id], [foreign]]) {
      const res = await prompt(admin, id, "Not yours", ids);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(errorCode(res)).toBe("attachment_not_linkable");
    }
    expect(await promptCount(id)).toBe(0);
    await sleep(100);
    expect(device.pending("prompt").filter((f) => (f as Cmd).sessionId === id)).toEqual([]);
    expect(await ledger(id)).toEqual([]);
    expect(orgId).not.toBe(orgB);
  });
});
