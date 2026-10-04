import { createHash, randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";

/**
 * Work Zone integration: pairing, Device Link auth, command queue (ack + at-least-once redelivery), event
 * de-duplication, the shared-queue arbiter, approvals and tenant isolation. The device side is a
 * contracts-level fake daemon speaking raw Device Link frames.
 */

type Frame = Record<string, unknown> & { type: string };

class FakeDevice {
  readonly frames: Frame[] = [];
  private cursor = 0;
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString()) as Frame));
    ws.on("close", () => {
      this.closed = true;
    });
  }

  static open(baseUrl: string, token: string): Promise<FakeDevice> {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/runtime/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new FakeDevice(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  static async connect(baseUrl: string, token: string, sessions?: string[]): Promise<FakeDevice> {
    const d = await FakeDevice.open(baseUrl, token);
    d.send({
      type: "hello",
      protocolVersion: 1,
      device: { name: "Test Mac", platform: "darwin", daemonVersion: "0.0.0-test" },
      runtimes: [
        { id: "claude-code", installed: true, version: "2.1.287", loggedIn: true },
        { id: "codex", installed: true, version: "0.160.0", loggedIn: false },
      ],
      ...(sessions ? { sessions } : {}),
    });
    await d.next((f) => f.type === "welcome");
    return d;
  }

  send(frame: Record<string, unknown>) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait for (and consume) the next frame matching `pred` after the cursor. */
  async next(pred: (f: Frame) => boolean, timeoutMs = 8000): Promise<Frame> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (let i = this.cursor; i < this.frames.length; i++) {
        const f = this.frames[i]!;
        if (pred(f)) {
          this.frames.splice(i, 1);
          return f;
        }
      }
      await sleep(20);
    }
    throw new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames.slice(-5))}`);
  }

  command(kind: string, sessionId?: string, timeoutMs?: number) {
    return this.next(
      (f) => f.type === "command" && f.kind === kind && (!sessionId || f.sessionId === sessionId),
      timeoutMs,
    ) as Promise<Frame & { id: string; payload: Record<string, unknown>; sessionId: string }>;
  }

  pending(kind: string) {
    return this.frames.filter((f) => f.type === "command" && f.kind === kind);
  }

  ack(id: string, ok = true, error?: string) {
    this.send({ type: "ack", commandId: id, ...(ok ? { ok: true } : { ok: false, error }) });
  }

  seq = Date.now() * 1000;
  event(sessionId: string, event: Record<string, unknown>, localSeq = ++this.seq) {
    this.send({ type: "event", sessionId, localSeq, event });
  }

  async close() {
    if (this.closed) return;
    await new Promise<void>((r) => {
      this.ws.once("close", () => r());
      this.ws.close();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`condition not met in time${last ? `: ${String(last)}` : ""}`);
}

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let deviceToken: string;
let projectId: string;
let device: FakeDevice;
const projectLocalId = "lp_demo";

beforeAll(async () => {
  process.env.OCW_DEVICE_OFFLINE_GRACE_MS = "300";
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  expect(
    (
      await admin.request("POST", "/api/v1/setup", {
        token: TEST_SETUP_TOKEN,
        ...ADMIN,
        orgName: "Autofy Labs",
      })
    ).status,
  ).toBe(200);
  const inv = await admin.request("POST", "/api/v1/invitations", {
    email: "alex@example.test",
    role: "developer",
  });
  alex = new TestClient(stack.baseUrl);
  expect(
    (
      await alex.request("POST", `/api/v1/invitations/${inv.body!.id as string}/accept`, {
        name: "Alex",
        password: "another-long-password",
      })
    ).status,
  ).toBe(200);
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  delete process.env.OCW_DEVICE_OFFLINE_GRACE_MS;
});

async function newSession(body: Record<string, unknown> = {}) {
  const res = await admin.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await device.command("session.start", id);
  device.ack(start.id);
  device.event(id, { type: "session.started", runtime: "claude-code", runtimeSessionId: `rt-${id}` });
  device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => (await status(id)) === "idle");
  return { id, start };
}

async function status(id: string) {
  const res = await admin.request("GET", `/api/v1/work-sessions/${id}`);
  return (res.body!.session as { status: string }).status;
}

async function detail(id: string) {
  return (await admin.request("GET", `/api/v1/work-sessions/${id}`)).body as {
    session: { status: string; pendingApprovals: number };
    prompts: Array<{ id: string; body: string; status: string; authorName: string }>;
    approvals: Array<{ id: string; status: string; decision: string | null }>;
    events: Array<{ event: { type: string; text?: string } }>;
  };
}

/** Complete the running prompt on the fake device. */
async function finishPrompt(sessionId: string, cmd: { id: string; payload: Record<string, unknown> }) {
  device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  device.event(sessionId, { type: "prompt.started", promptId });
  device.event(sessionId, {
    type: "assistant.message",
    messageId: `m-${promptId}`,
    text: `done ${promptId}`,
  });
  device.event(sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

describe("device pairing", () => {
  it("enrolls with a one-time 10-minute code and stores only the token hash", async () => {
    const res = await admin.request("POST", "/api/v1/devices/enrollments");
    expect(res.status).toBe(200);
    const code = res.body!.code as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const expiresIn = new Date(res.body!.expiresAt as string).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(9 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);

    const anon = new TestClient(stack.baseUrl);
    const bad = await anon.request("POST", "/api/v1/devices/enroll", {
      code: "ZZZZ-ZZZZ",
      name: "x",
      platform: "darwin",
    });
    expect(bad.status).toBe(400);

    // Case and separators do not matter (typed by hand).
    const ok = await anon.request("POST", "/api/v1/devices/enroll", {
      code: code.toLowerCase().replace("-", " "),
      name: "Víctor's MacBook",
      platform: "darwin",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    deviceToken = ok.body!.deviceToken as string;
    expect(deviceToken).toMatch(/^ocwd_/);

    const reuse = await anon.request("POST", "/api/v1/devices/enroll", {
      code,
      name: "y",
      platform: "linux",
    });
    expect(reuse.status).toBe(410);

    const rows = await su.query("select token_hash from app.devices where id = $1", [ok.body!.deviceId]);
    expect(rows.rows[0].token_hash).toBe(createHash("sha256").update(deviceToken).digest("hex"));
    const audit = await su.query("select action from app.audit_events where action like 'device.%'");
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["device.enrollment_created", "device.enrolled"]),
    );

    // Expired codes are refused.
    const old = await admin.request("POST", "/api/v1/devices/enrollments");
    await su.query(
      "update app.device_enrollments set expires_at = now() - interval '1 minute' where consumed_at is null",
    );
    const expired = await anon.request("POST", "/api/v1/devices/enroll", {
      code: old.body!.code,
      name: "z",
      platform: "darwin",
    });
    expect(expired.status).toBe(410);
  });

  it("device link: rejects bad tokens, goes online on hello, registers only safe projects", async () => {
    await expect(FakeDevice.open(stack.baseUrl, "ocwd_not-a-real-token")).rejects.toThrow("HTTP 401");

    device = await FakeDevice.connect(stack.baseUrl, deviceToken);
    device.send({
      type: "projects.sync",
      projects: [
        {
          localId: projectLocalId,
          name: "ocw",
          gitRemote: "git@github.com:acme/ocw.git",
          defaultBranch: "main",
        },
        {
          localId: "lp_local",
          name: "scratch",
          gitRemote: "/Users/victor/repos/scratch.git",
          defaultBranch: null,
        },
        { localId: "lp_bad", name: "/Users/victor/secret-repo", gitRemote: null, defaultBranch: null },
      ],
    });
    const ack = await device.next((f) => f.type === "projects.ack");
    expect((ack.projects as unknown[]).length).toBe(2);

    const list = await admin.request("GET", "/api/v1/devices");
    expect(list.body!.devices).toEqual([
      expect.objectContaining({
        name: "Víctor's MacBook",
        status: "online",
        projectCount: 2,
        runtimes: expect.arrayContaining([expect.objectContaining({ id: "claude-code", loggedIn: true })]),
      }),
    ]);
    const projects = (await admin.request("GET", "/api/v1/projects")).body!.projects as Array<{
      id: string;
      name: string;
      gitRemote: string | null;
    }>;
    expect(projects.map((p) => p.name).sort()).toEqual(["ocw", "scratch"]);
    expect(projects.find((p) => p.name === "scratch")!.gitRemote).toBeNull();
    projectId = projects.find((p) => p.name === "ocw")!.id;
    const dump = JSON.stringify(await su.query("select * from app.projects"));
    expect(dump).not.toContain("/Users/");

    // Not shared: Alex cannot use the admin's device or see its projects.
    expect(((await alex.request("GET", "/api/v1/projects")).body!.projects as unknown[]).length).toBe(0);
    const denied = await alex.request("POST", "/api/v1/work-sessions", { projectId });
    expect(denied.status).toBe(403);
  });
});

describe("work sessions", () => {
  it("rejects runtimes that are not signed in on the device", async () => {
    const res = await admin.request("POST", "/api/v1/work-sessions", { projectId, runtime: "codex" });
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe("runtime_unavailable");
  });

  it("arbiter: prompts from two users run strictly one at a time, in queue order", async () => {
    const { id, start } = await newSession({ title: "Arbiter", permissionMode: "plan" });
    expect(start.payload).toMatchObject({ projectLocalId, runtime: "claude-code", permissionMode: "plan" });

    const a1 = await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "A1" });
    expect(a1.status).toBe(200);
    expect((await alex.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "B1" })).status).toBe(
      200,
    );
    await Promise.all([
      admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "A2" }),
      alex.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "B2" }),
    ]);

    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const cmd = await device.command("prompt", id);
      // Never more than one prompt in flight on the device.
      await sleep(150);
      expect(device.pending("prompt")).toHaveLength(0);
      order.push((await detail(id)).prompts.find((p) => p.id === cmd.payload.promptId)!.body);
      await finishPrompt(id, cmd);
    }
    expect(order.slice(0, 2)).toEqual(["A1", "B1"]);
    expect(order.slice(2).sort()).toEqual(["A2", "B2"]);
    await eventually(async () => (await status(id)) === "idle");
    const d = await detail(id);
    expect(d.prompts.every((p) => p.status === "completed")).toBe(true);
    expect(d.prompts.find((p) => p.body === "B1")!.authorName).toBe("Alex");
    const audit = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'work_prompt.queued' and session_id = $1",
      [id],
    );
    expect(audit.rows[0].n).toBe(4);
  });

  it("shared queue: reorder, edit and cancel while a prompt runs", async () => {
    const { id } = await newSession({ title: "Queue" });
    await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "first" });
    const running = await device.command("prompt", id);
    const x = await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "X" });
    const y = await alex.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "Y" });
    const z = await alex.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "Z" });
    const xid = x.body!.id as string;
    expect(
      (
        await alex.request("PATCH", `/api/v1/work-sessions/${id}/prompts/${z.body!.id as string}`, {
          index: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin.request("DELETE", `/api/v1/work-sessions/${id}/prompts/${y.body!.id as string}`)).status,
    ).toBe(200);
    expect(
      (await alex.request("PATCH", `/api/v1/work-sessions/${id}/prompts/${xid}`, { body: "X edited" }))
        .status,
    ).toBe(200);
    // Running prompts cannot be edited.
    expect(
      (
        await admin.request(
          "PATCH",
          `/api/v1/work-sessions/${id}/prompts/${running.payload.promptId as string}`,
          { body: "no" },
        )
      ).status,
    ).toBe(409);

    await finishPrompt(id, running);
    const next1 = await device.command("prompt", id);
    expect(next1.payload.text).toBe("Z");
    await finishPrompt(id, next1);
    const next2 = await device.command("prompt", id);
    expect(next2.payload.text).toBe("X edited");
    await finishPrompt(id, next2);
    await eventually(async () => (await status(id)) === "idle");
    expect((await detail(id)).prompts.find((p) => p.body === "Y")!.status).toBe("cancelled");
  });

  it("approvals are decided exactly once, by an allowed user, and relayed to the device", async () => {
    const { id } = await newSession({ title: "Approvals" });
    await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "edit a file" });
    const cmd = await device.command("prompt", id);
    device.ack(cmd.id);
    device.event(id, { type: "prompt.started", promptId: cmd.payload.promptId });
    const approvalId = randomUUID();
    device.event(id, {
      type: "approval.requested",
      approvalId,
      tool: "Edit",
      summary: "Edit src/app.ts",
      paths: ["src/app.ts", "/etc/hosts"],
    });
    device.event(id, { type: "session.state", status: "waiting_approval" });
    await eventually(async () => (await status(id)) === "waiting_approval");
    const d = await detail(id);
    expect(d.approvals[0]).toMatchObject({ id: approvalId, status: "pending" });
    expect(JSON.stringify(d)).not.toContain("/etc/hosts");

    // A plain member who neither created the session nor owns the device cannot decide.
    expect(
      (
        await alex.request("POST", `/api/v1/work-sessions/${id}/approvals/${approvalId}`, {
          decision: "once",
        })
      ).status,
    ).toBe(403);

    const [r1, r2] = await Promise.all([
      admin.request("POST", `/api/v1/work-sessions/${id}/approvals/${approvalId}`, { decision: "once" }),
      admin.request("POST", `/api/v1/work-sessions/${id}/approvals/${approvalId}`, {
        decision: "deny",
        comment: "no",
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const resolve = await device.command("approval.resolve", id);
    expect(resolve.payload).toMatchObject({ approvalId });
    await sleep(150);
    expect(device.pending("approval.resolve")).toHaveLength(0);
    device.ack(resolve.id);
    device.event(id, { type: "approval.resolved", approvalId, decision: resolve.payload.decision });
    device.event(id, { type: "session.state", status: "running" });
    await eventually(async () => (await status(id)) === "running");
    const decided = (await detail(id)).approvals[0]!;
    expect(decided.decision).toBe(resolve.payload.decision);
    expect(
      (
        await admin.request("POST", `/api/v1/work-sessions/${id}/approvals/${approvalId}`, {
          decision: "once",
        })
      ).status,
    ).toBe(409);
    await finishPrompt(id, cmd);
    await eventually(async () => (await status(id)) === "idle");
  });

  it("de-duplicates replayed events by (sessionId, localSeq)", async () => {
    const { id } = await newSession({ title: "Dedupe" });
    const seq = device.seq + 1000;
    device.event(id, { type: "assistant.message", messageId: "dup", text: "once only" }, seq);
    device.event(id, { type: "assistant.message", messageId: "dup", text: "once only" }, seq);
    device.event(id, { type: "assistant.message", messageId: "old", text: "stale" }, seq - 1);
    device.event(id, { type: "assistant.message", messageId: "new", text: "fresh" }, seq + 1);
    device.seq = seq + 1;
    await eventually(async () => (await detail(id)).events.some((e) => e.event.text === "fresh"));
    const texts = (await detail(id)).events.map((e) => e.event.text).filter(Boolean);
    expect(texts.filter((t) => t === "once only")).toHaveLength(1);
    expect(texts).not.toContain("stale");
  });

  it("redelivers unacked commands after a reconnect, and never acked ones", async () => {
    const { id } = await newSession({ title: "Redelivery" });
    await admin.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "long task" });
    const cmd = await device.command("prompt", id);
    device.ack(cmd.id);
    device.event(id, { type: "prompt.started", promptId: cmd.payload.promptId });
    await eventually(async () => (await status(id)) === "running");
    expect((await admin.request("POST", `/api/v1/work-sessions/${id}/interrupt`)).status).toBe(200);
    const interrupt = await device.command("interrupt", id);
    // Link drops before the ack.
    await device.close();
    device = await FakeDevice.connect(stack.baseUrl, deviceToken, [id]);
    const again = await device.command("interrupt", id);
    expect(again.id).toBe(interrupt.id);
    device.ack(again.id);
    device.event(id, {
      type: "prompt.completed",
      promptId: cmd.payload.promptId,
      usage: { inputTokens: 0, outputTokens: 0 },
      interrupted: true,
    });
    await eventually(async () => (await detail(id)).prompts[0]!.status === "cancelled");
    await device.close();
    device = await FakeDevice.connect(stack.baseUrl, deviceToken, [id]);
    await sleep(300);
    expect(device.frames.filter((f) => f.type === "command" && f.id === interrupt.id)).toHaveLength(0);
  });

  it("host offline: queued prompts wait for the device; a restarted daemon re-attaches with resume", async () => {
    const { id } = await newSession({ title: "Offline" });
    await device.close();
    await eventually(async () => (await status(id)) === "host_offline");
    await alex.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "while offline" });
    expect(await status(id)).toBe("host_offline");

    // Same daemon comes back (session still alive on it): the queued prompt is dispatched.
    device = await FakeDevice.connect(stack.baseUrl, deviceToken, [id]);
    const cmd = await device.command("prompt", id);
    expect(cmd.payload.text).toBe("while offline");
    device.ack(cmd.id);
    device.event(id, { type: "prompt.started", promptId: cmd.payload.promptId });
    await eventually(async () => (await status(id)) === "running");

    // Daemon restarts (session gone): the in-flight prompt fails and the session is resumed.
    await device.close();
    device = await FakeDevice.connect(stack.baseUrl, deviceToken, []);
    const start = await device.command("session.start", id);
    expect(start.payload).toMatchObject({ resumeRuntimeSessionId: `rt-${id}` });
    expect(await status(id)).toBe("provisioning");
    expect((await detail(id)).prompts[0]!.status).toBe("failed");
    device.ack(start.id);
    await eventually(async () => (await status(id)) === "idle");
  });

  it("relays a diff request to the device and back (repo-relative paths only)", async () => {
    const { id } = await newSession({ title: "Diff" });
    const pending = admin.request("GET", `/api/v1/work-sessions/${id}/diff`);
    const req = await device.command("diff.request", id);
    expect(req.payload).toMatchObject({ projectLocalId });
    device.send({
      type: "diff.result",
      requestId: req.id,
      files: [
        { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
        { path: "/etc/passwd", status: "modified", additions: 1, deletions: 0 },
      ],
      patch: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      branch: "ocw/session",
      headSha: "abc123",
    });
    device.ack(req.id);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ branch: "ocw/session", files: [{ path: "src/a.ts" }] });
    await eventually(async () => {
      const s = (await admin.request("GET", `/api/v1/work-sessions/${id}`)).body!.session as {
        branch: string;
      };
      return s.branch === "ocw/session";
    });
  });
});

describe("tenant isolation", () => {
  it("another organization's devices, projects and sessions are invisible and untouchable", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    const wsB = randomUUID();
    const tokenB = `ocwd_${randomUUID()}`;
    const q = (t: string, v: unknown[]) => su.query(t, v);
    await q("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [orgB, `o-${orgB}`]);
    await q("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@b.test`]);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
      [devB, orgB, userB, createHash("sha256").update(tokenB).digest("hex")],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
      [projB, orgB, devB],
    );
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'b')",
      [convB, orgB],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status) values ($1, $2, $3, $4, $5, 'B', $6, 'idle')",
      [wsB, orgB, convB, projB, devB, userB],
    );
    const approvalB = randomUUID();
    await q(
      `insert into app.work_approvals (id, organization_id, work_session_id, request) values ($1, $2, $3, '{"tool":"Bash","summary":"x","paths":[]}')`,
      [approvalB, orgB, wsB],
    );

    const devices = (await admin.request("GET", "/api/v1/devices")).body!.devices as Array<{ id: string }>;
    expect(devices.map((d) => d.id)).not.toContain(devB);
    const projects = (await admin.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string }>;
    expect(projects.map((p) => p.id)).not.toContain(projB);
    const sessions = (await admin.request("GET", "/api/v1/work-sessions")).body!.sessions as Array<{
      id: string;
    }>;
    expect(sessions.map((s) => s.id)).not.toContain(wsB);

    expect((await admin.request("GET", `/api/v1/work-sessions/${wsB}`)).status).toBe(404);
    expect((await admin.request("POST", `/api/v1/work-sessions/${wsB}/prompts`, { body: "x" })).status).toBe(
      404,
    );
    expect(
      (
        await admin.request("POST", `/api/v1/work-sessions/${wsB}/approvals/${approvalB}`, {
          decision: "once",
        })
      ).status,
    ).toBe(404);
    expect((await admin.request("POST", "/api/v1/work-sessions", { projectId: projB })).status).toBe(404);
    expect((await admin.request("DELETE", `/api/v1/devices/${devB}`)).status).toBe(404);

    // Realtime: the other org's session topic is refused.
    const ws = new WebSocket(
      `${stack.baseUrl.replace(/^http/, "ws")}/ws`,
      [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await admin.token()}`],
      { headers: { origin: WEB_ORIGIN } },
    );
    const got: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ op: "sub", topic: `ws:${wsB}` }));
    await eventually(async () => got.find((f) => f.op === "err"));
    expect(got.find((f) => f.op === "err")).toMatchObject({ code: "forbidden" });
    ws.close();

    // Org B's device cannot inject events into org A's sessions.
    const aSessions = (await admin.request("GET", "/api/v1/work-sessions")).body!.sessions as Array<{
      id: string;
    }>;
    const target = aSessions[0]!.id;
    const before = (await detail(target)).events.length;
    const intruder = await FakeDevice.connect(stack.baseUrl, tokenB);
    intruder.event(target, { type: "assistant.message", messageId: "x", text: "injected" });
    intruder.event(target, { type: "session.state", status: "failed" });
    await sleep(400);
    const after = await detail(target);
    expect(after.events.length).toBe(before);
    expect(after.session.status).not.toBe("failed");
    await intruder.close();
  });
});

describe("revocation", () => {
  it("revoking a device closes its socket and fails its sessions", async () => {
    const { id } = await newSession({ title: "Revoke" });
    const devices = (await admin.request("GET", "/api/v1/devices")).body!.devices as Array<{ id: string }>;
    expect((await admin.request("DELETE", `/api/v1/devices/${devices[0]!.id}`)).status).toBe(200);
    await eventually(async () => device.closed);
    await eventually(async () => (await status(id)) === "failed");
    await expect(FakeDevice.open(stack.baseUrl, deviceToken)).rejects.toThrow("HTTP 401");
    const audit = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'device.revoked'",
    );
    expect(audit.rows[0].n).toBe(1);
  });
});
