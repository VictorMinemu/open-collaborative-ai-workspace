import { createHash, randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "./testing";
import { eventually, FakeDevice, sleep } from "./testing-device";
import { createTeamProject, linkRepo } from "./testing-workzone";

/**
 * Work Zone integration: pairing, Device Link auth, command queue (ack + at-least-once redelivery), event
 * de-duplication, the shared-queue arbiter, approvals and tenant isolation. The device side is a
 * contracts-level fake daemon speaking raw Device Link frames.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let alex: TestClient;
let dana: TestClient;
let stan: TestClient;
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
  dana = await invite("dana@example.test", "Dana", "admin");
  stan = await invite("stan@example.test", "Stan", "standard");
}, 180_000);

const ELECTRON_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ocw-desktop/0.1.0 Chrome/140.0.7339.80 Electron/38.1.0 Safari/537.36";

/** Sign in from the desktop app (its session is tagged `desktop` at creation) and reuse the cookie. */
async function desktopSignIn(email: string, password: string) {
  const res = await fetch(`${stack.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: WEB_ORIGIN, "content-type": "application/json", "user-agent": ELECTRON_MAC_UA },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const c = new TestClient(stack.baseUrl);
  for (const cookie of res.headers.getSetCookie()) {
    const [pair = ""] = cookie.split(";");
    const idx = pair.indexOf("=");
    c.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return c;
}

/** Subscribe to a realtime topic and return the gateway's first answer for it. */
async function subscribe(client: TestClient, topic: string) {
  const ws = new WebSocket(
    `${stack.baseUrl.replace(/^http/, "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await client.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const got: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ op: "sub", topic }));
  const answer = await eventually(async () =>
    got.find((f) => f.topic === topic && (f.op === "err" || f.op === "subscribed")),
  );
  ws.close();
  return answer;
}

const errorCode = (res: { body: Record<string, unknown> | null }) =>
  (res.body?.error as { code?: string } | undefined)?.code;

/** Invite a member with `role` through the API and sign them in. */
async function invite(email: string, name: string, role: "standard" | "developer" | "admin") {
  const inv = await admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  const c = new TestClient(stack.baseUrl);
  const res = await c.request("POST", `/api/v1/invitations/${inv.body!.id as string}/accept`, {
    name,
    password: "yet-another-long-password",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return c;
}

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
  delete process.env.OCW_DEVICE_OFFLINE_GRACE_MS;
});

async function newSession(body: Record<string, unknown> = {}, as: TestClient = admin) {
  const res = await as.request("POST", "/api/v1/work-sessions", { projectId, ...body });
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

async function detail(id: string, as: TestClient = admin) {
  return (await as.request("GET", `/api/v1/work-sessions/${id}`)).body as {
    session: { status: string; pendingApprovals: number };
    prompts: Array<{ id: string; body: string; status: string; authorName: string }>;
    approvals: Array<{ id: string; status: string; decision: string | null }>;
    events: Array<{ event: { type: string; text?: string } }>;
    viewerCan?: string[];
  };
}

/** Ask the fake device to request approvals for `tools` inside a running prompt. */
async function requestApprovals(sessionId: string, tools: string[]) {
  await admin.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: "needs tools" });
  const cmd = await device.command("prompt", sessionId);
  device.ack(cmd.id);
  device.event(sessionId, { type: "prompt.started", promptId: cmd.payload.promptId });
  const ids = tools.map((tool) => {
    const approvalId = randomUUID();
    device.event(sessionId, {
      type: "approval.requested",
      approvalId,
      tool,
      summary: `${tool} something`,
      paths: [],
    });
    return approvalId;
  });
  device.event(sessionId, { type: "session.state", status: "waiting_approval" });
  await eventually(async () => (await detail(sessionId)).approvals.length >= ids.length);
  return { cmd, ids };
}

const decideApproval = (as: TestClient, sessionId: string, approvalId: string) =>
  as.request("POST", `/api/v1/work-sessions/${sessionId}/approvals/${approvalId}`, { decision: "once" });

const denialsFor = async (permission: string) =>
  (
    await su.query(
      "select metadata from app.audit_events where action = 'authz.denied' and metadata->>'permission' = $1",
      [permission],
    )
  ).rows.map((r) => r.metadata as Record<string, unknown>);

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

  it("exchanges the device token for a 10-minute device JWT; wrong tokens and JWTs are refused", async () => {
    const res = await fetch(`${stack.baseUrl}/api/v1/devices/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token.split(".")).toHaveLength(3);
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(601_000);
    await expect(FakeDevice.exchange(stack.baseUrl, "ocwd_not-a-real-token")).rejects.toThrow("HTTP 401");
    // Only the long-lived device credential mints device JWTs: neither a device JWT nor a user JWT does.
    await expect(FakeDevice.exchange(stack.baseUrl, body.token)).rejects.toThrow("HTTP 401");
    await expect(FakeDevice.exchange(stack.baseUrl, await admin.token())).rejects.toThrow("HTTP 401");
    const noAuth = await fetch(`${stack.baseUrl}/api/v1/devices/token`, { method: "POST" });
    expect(noAuth.status).toBe(401);
  });

  it("device link: rejects bad tokens, goes online on hello, registers only safe projects", async () => {
    await expect(FakeDevice.open(stack.baseUrl, "ocwd_not-a-real-token")).rejects.toThrow("HTTP 401");
    await expect(FakeDevice.open(stack.baseUrl, "a.b.c")).rejects.toThrow("HTTP 401");

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
  // Explicit access (07.9-03, D-06): Alex (developer) and Stan (standard) read, follow and act on the admin's
  // sessions as fellow members of a team project the `ocw` repo is linked to; the admin is the sessions' creator and
  // device owner. Device access is unchanged (the device is not shared with them), so roles, rules and device caps
  // still decide what each may do.
  beforeAll(async () => {
    const me = (await admin.request("GET", "/api/v1/me")).body!;
    const adminId = (me.user as { id: string }).id;
    const members = (await admin.request("GET", "/api/v1/members")).body!.members as Array<{
      userId: string;
      email: string | null;
    }>;
    const idOf = (email: string) => members.find((m) => m.email === email)!.userId;
    const { unitId } = await createTeamProject(stack, admin, {
      name: "OCW",
      members: [adminId, idOf("alex@example.test"), idOf("stan@example.test")].map((userId) => ({ userId })),
    });
    const [host] = (await admin.request("GET", "/api/v1/devices")).body!.devices as Array<{ id: string }>;
    await linkRepo(stack, {
      organizationId: (me.organization as { id: string }).id,
      unitId,
      projectId,
      deviceId: host!.id,
      linkedBy: adminId,
    });
  });

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

    // A developer who neither created the session nor owns the device cannot decide (resolver, role layer).
    const before = (await denialsFor("work_session.approve")).length;
    const denied = await alex.request("POST", `/api/v1/work-sessions/${id}/approvals/${approvalId}`, {
      decision: "once",
    });
    expect(denied.status).toBe(403);
    expect((denied.body!.error as { details: unknown }).details).toEqual({
      permission: "work_session.approve",
      layer: "role",
      reason: "missing_permission",
    });
    const audited = await denialsFor("work_session.approve");
    expect(audited).toHaveLength(before + 1);
    expect(audited.at(-1)).toMatchObject({ layer: "role", reason: "missing_permission", method: "POST" });

    // viewerCan drives the web's Approve/Deny and Archive controls.
    expect(d.viewerCan).toEqual(
      expect.arrayContaining(["work_session.approve", "work_session.archive", "work_session.prompt"]),
    );
    const alexView = await detail(id, alex);
    expect(alexView.viewerCan).toEqual(expect.arrayContaining(["work_session.prompt"]));
    expect(alexView.viewerCan).not.toContain("work_session.approve");
    expect(alexView.viewerCan).not.toContain("work_session.archive");

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

  it("approvals: the creator, the device owner and an admin decide; a Tool-layer deny rule blocks one tool", async () => {
    const devices = (await admin.request("GET", "/api/v1/devices")).body!.devices as Array<{ id: string }>;
    const deviceId = devices[0]!.id;
    expect((await admin.request("PATCH", `/api/v1/devices/${deviceId}`, { shared: true })).status).toBe(200);
    try {
      // Alex creates the session on the admin's shared device: Alex = creator, admin = device owner,
      // Dana = an admin with neither relation.
      const { id } = await newSession({ title: "Relations" }, alex);
      const { cmd, ids } = await requestApprovals(id, ["Edit", "Edit", "Edit", "Bash", "Read"]);
      const [byCreator, byOwner, byAdmin, bash, read] = ids as [string, string, string, string, string];

      for (const who of [alex, dana]) {
        expect((await detail(id, who)).viewerCan).toEqual(
          expect.arrayContaining(["work_session.approve", "work_session.archive"]),
        );
      }
      expect((await decideApproval(alex, id, byCreator)).status).toBe(200);
      expect((await decideApproval(admin, id, byOwner)).status).toBe(200);
      expect((await decideApproval(dana, id, byAdmin)).status).toBe(200);

      // Tool layer: deny approving Bash for everyone, organization-wide.
      const orgId = (await su.query("select organization_id from app.work_sessions where id = $1", [id]))
        .rows[0].organization_id as string;
      const ruleId = randomUUID();
      await su.query(
        "insert into app.permission_rules (id, organization_id, subject_kind, permission, tool, effect) values ($1, $2, 'everyone', 'work_session.approve', 'Bash', 'deny')",
        [ruleId, orgId],
      );
      try {
        const blocked = await decideApproval(admin, id, bash);
        expect(blocked.status).toBe(403);
        expect((blocked.body!.error as { details: unknown }).details).toMatchObject({
          permission: "work_session.approve",
          layer: "tool",
          ruleId,
        });
        expect((await decideApproval(alex, id, read)).status).toBe(200);
      } finally {
        await su.query("delete from app.permission_rules where id = $1", [ruleId]);
      }
      expect((await decideApproval(admin, id, bash)).status).toBe(200);

      for (let i = 0; i < 5; i++) device.ack((await device.command("approval.resolve", id)).id);
      device.event(id, { type: "session.state", status: "running" });
      await finishPrompt(id, cmd);
      await eventually(async () => (await status(id)) === "idle");
    } finally {
      await admin.request("PATCH", `/api/v1/devices/${deviceId}`, { shared: false });
    }
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
    // The session is already `running` from the dispatch; wait for the prompt itself so `prompt.started` has been
    // applied before the restart (applied after it, it would move the resumed session from provisioning to running).
    await eventually(async () => (await detail(id)).prompts[0]!.status === "running");
    expect(await status(id)).toBe("running");

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

describe("devices and Work Zone on the permission resolver", () => {
  type DeviceView = { id: string; name: string; ownerUserId: string; viewerCan?: string[] };
  const listDevices = async (c: TestClient) =>
    (await c.request("GET", "/api/v1/devices")).body!.devices as DeviceView[];
  const projectNames = async (c: TestClient) =>
    ((await c.request("GET", "/api/v1/projects")).body!.projects as Array<{ name: string }>)
      .map((p) => p.name)
      .sort();

  it("a standard user cannot pair, list, start or follow sessions", async () => {
    const enroll = await stan.request("POST", "/api/v1/devices/enrollments");
    expect(enroll.status).toBe(403);
    expect((enroll.body!.error as { details: unknown }).details).toMatchObject({
      permission: "device.pair",
      layer: "role",
    });
    expect((await stan.request("POST", "/api/v1/work-sessions", { projectId })).status).toBe(403);
    expect((await stan.request("GET", "/api/v1/work-sessions")).status).toBe(403);
    expect((await stan.request("GET", "/api/v1/projects")).status).toBe(403);
    expect((await stan.request("GET", "/api/v1/devices")).status).toBe(403);

    const sessions = (await admin.request("GET", "/api/v1/work-sessions")).body!.sessions as Array<{
      id: string;
    }>;
    const topic = `ws:${sessions[0]!.id}`;
    expect(await subscribe(stan, topic)).toMatchObject({ op: "err", code: "forbidden" });
    expect(await subscribe(alex, topic)).toMatchObject({ op: "subscribed" });
  });

  it("a role downgrade revokes a live Work Zone stream within a second (RT-01, D-05)", async () => {
    const { id } = await newSession({ title: "Live access" });
    const topic = `ws:${id}`;
    const members = (await admin.request("GET", "/api/v1/members")).body!.members as Array<{
      userId: string;
      email: string | null;
    }>;
    const alexId = members.find((m) => m.email === "alex@example.test")!.userId;
    const ws = new WebSocket(
      `${stack.baseUrl.replace(/^http/, "ws")}/ws`,
      [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await alex.token()}`],
      { headers: { origin: WEB_ORIGIN } },
    );
    const got: Array<Record<string, unknown> & { at: number }> = [];
    ws.on("message", (d) => got.push({ ...JSON.parse(d.toString()), at: Date.now() }));
    await new Promise((r) => ws.once("open", r));
    try {
      ws.send(JSON.stringify({ op: "sub", topic }));
      await eventually(async () => got.find((f) => f.op === "subscribed" && f.topic === topic));
      const t0 = Date.now();
      const res = await admin.request("PATCH", `/api/v1/members/${alexId}/role`, { role: "standard" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const revoked = await eventually(
        async () => got.find((f) => f.op === "revoked" && f.topic === topic),
        1000,
      );
      expect(revoked).toMatchObject({ reason: "forbidden" });
      console.info(`work zone revocation after role change: ${revoked.at - t0} ms`);
    } finally {
      ws.close();
      const restored = await admin.request("PATCH", `/api/v1/members/${alexId}/role`, { role: "developer" });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    }
    expect(await subscribe(alex, topic)).toMatchObject({ op: "subscribed" });
  });

  it("devices: a developer pairs; update is owner-only, revoke is owner or admin; viewerCan per device", async () => {
    // Alex (developer, like an MVP 0 member) pairs a device of their own.
    const code = await alex.request("POST", "/api/v1/devices/enrollments");
    expect(code.status).toBe(200);
    const paired = await new TestClient(stack.baseUrl).request("POST", "/api/v1/devices/enroll", {
      code: code.body!.code,
      name: "Alex's Linux",
      platform: "linux",
    });
    expect(paired.status).toBe(200);
    const alexDeviceId = paired.body!.deviceId as string;
    const alexDevice = await FakeDevice.connect(stack.baseUrl, paired.body!.deviceToken as string);
    alexDevice.send({
      type: "projects.sync",
      projects: [{ localId: "lp_alex", name: "alex-repo", gitRemote: null, defaultBranch: "main" }],
    });
    await alexDevice.next((f) => f.type === "projects.ack");

    const adminDeviceId = (await listDevices(admin)).find((d) => d.id !== alexDeviceId)!.id;
    const asAdmin = await listDevices(admin);
    // 07.11: `device.maintain` (update the coding CLIs) is the owner's and every admin's, like revoke.
    expect(asAdmin.find((d) => d.id === alexDeviceId)!.viewerCan).toEqual([
      "device.revoke",
      "device.maintain",
    ]);
    expect(asAdmin.find((d) => d.id !== alexDeviceId)!.viewerCan).toEqual([
      "device.use",
      "device.update",
      "device.revoke",
      "device.maintain",
    ]);
    const asAlex = await listDevices(alex);
    expect(asAlex.find((d) => d.id === alexDeviceId)!.viewerCan).toEqual([
      "device.use",
      "device.update",
      "device.revoke",
      "device.maintain",
    ]);
    expect(asAlex.find((d) => d.id === adminDeviceId)!.viewerCan).toEqual([]);

    // Projects: only devices the caller may use (own or shared).
    expect(await projectNames(alex)).toEqual(["alex-repo"]);
    expect(await projectNames(admin)).toEqual(["ocw", "scratch"]);
    expect((await admin.request("PATCH", `/api/v1/devices/${adminDeviceId}`, { shared: true })).status).toBe(
      200,
    );
    expect(await projectNames(alex)).toEqual(["alex-repo", "ocw", "scratch"]);
    expect((await listDevices(alex)).find((d) => d.id === adminDeviceId)!.viewerCan).toEqual(["device.use"]);
    expect((await admin.request("PATCH", `/api/v1/devices/${adminDeviceId}`, { shared: false })).status).toBe(
      200,
    );

    // Rename/share is owner-only (an admin included); revoke is owner or admin.
    const byAdmin = await admin.request("PATCH", `/api/v1/devices/${alexDeviceId}`, { name: "x" });
    expect(byAdmin.status).toBe(403);
    expect((byAdmin.body!.error as { details: unknown }).details).toMatchObject({
      permission: "device.update",
    });
    expect((await alex.request("PATCH", `/api/v1/devices/${adminDeviceId}`, { shared: true })).status).toBe(
      403,
    );
    expect((await alex.request("DELETE", `/api/v1/devices/${adminDeviceId}`)).status).toBe(403);
    expect(
      (await alex.request("PATCH", `/api/v1/devices/${alexDeviceId}`, { name: "Alex's box" })).status,
    ).toBe(200);

    // Starting a session: not shared → device_not_shared; offline → device_offline; revoked → device_revoked.
    const adminProject = await alex.request("POST", "/api/v1/work-sessions", { projectId });
    expect(adminProject.status).toBe(403);
    expect(errorCode(adminProject)).toBe("device_not_shared");
    const alexProjectId = (
      (await alex.request("GET", "/api/v1/projects")).body!.projects as Array<{ id: string; name: string }>
    ).find((p) => p.name === "alex-repo")!.id;
    await alexDevice.close();
    await eventually(async () =>
      (await listDevices(alex)).some(
        (d) => d.id === alexDeviceId && (d as { status?: string }).status === "offline",
      ),
    );
    const offline = await alex.request("POST", "/api/v1/work-sessions", { projectId: alexProjectId });
    expect(offline.status).toBe(409);
    expect(errorCode(offline)).toBe("device_offline");

    expect((await dana.request("DELETE", `/api/v1/devices/${alexDeviceId}`)).status).toBe(200);
    const revoked = await alex.request("POST", "/api/v1/work-sessions", { projectId: alexProjectId });
    expect(revoked.status).toBe(403);
    expect(errorCode(revoked)).toBe("device_revoked");
    expect((revoked.body!.error as { details: unknown }).details).toMatchObject({
      permission: "device.use",
      layer: "device",
    });
  });

  it("sessions and prompts from the desktop app are audited with client kind desktop", async () => {
    const desktop = await desktopSignIn(ADMIN.email, ADMIN.password);
    const { id } = await newSession({ title: "From desktop" }, desktop);
    const queued = await desktop.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body: "hi" });
    expect(queued.status).toBe(200);
    const cmd = await device.command("prompt", id);
    const rows = (
      await su.query(
        "select action, client_kind from app.audit_events where session_id = $1 and action in ('work_session.created', 'work_prompt.queued')",
        [id],
      )
    ).rows;
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "work_session.created", client_kind: "desktop" },
        { action: "work_prompt.queued", client_kind: "desktop" },
      ]),
    );
    await finishPrompt(id, cmd);
    await eventually(async () => (await status(id)) === "idle");
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
    await expect(FakeDevice.exchange(stack.baseUrl, deviceToken)).rejects.toThrow("HTTP 401");
    const audit = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'device.revoked' and resource_id = $1",
      [devices[0]!.id],
    );
    expect(audit.rows[0].n).toBe(1);
  });
});

describe("authorization coverage", () => {
  it("the session list is filtered per session by the resolver (a deny rule hides sessions from the list)", async () => {
    const before = (await alex.request("GET", "/api/v1/work-sessions?archived=1")).body!
      .sessions as unknown[];
    expect(before.length).toBeGreaterThan(0);
    const rule = await admin.request("POST", "/api/v1/permission-rules", {
      subjectKind: "role",
      subjectId: "developer",
      permission: "work_session.read",
      effect: "deny",
    });
    expect(rule.status).toBe(200);
    try {
      const list = await alex.request("GET", "/api/v1/work-sessions?archived=1");
      // The route-level gate may already refuse; if it answers, it must not leak any session.
      if (list.status === 200) expect(list.body!.sessions).toEqual([]);
      else expect(list.status).toBe(403);
      const adminList = (await admin.request("GET", "/api/v1/work-sessions?archived=1")).body!
        .sessions as unknown[];
      expect(adminList.length).toBeGreaterThanOrEqual(before.length);
    } finally {
      await admin.request("DELETE", `/api/v1/permission-rules/${rule.body!.id as string}`);
    }
  });

  it("every device, project and Work Zone answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) =>
      /^\/api\/v1\/(devices|projects|work-sessions|work-zone)/.test(u.url),
    );
    expect(undecided).toEqual([]);
  });
});
