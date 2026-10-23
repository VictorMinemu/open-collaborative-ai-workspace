import { createHash, randomUUID } from "node:crypto";
import type { RuntimeCatalog } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice, sleep } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  createTeamProject,
  errorCode,
  invite,
  linkRepo,
  pairDevice,
  startSession,
} from "../../testing-workzone";

/**
 * Slash commands typed in a Work Zone prompt (Phase 03.2 Plan 07, D-13, P-10, ADR-0012 §4) against a real
 * PostgreSQL + Redis and a contracts-level fake device: settings commands go through the same policy-checked,
 * audited path as `PATCH /settings`; passthrough commands run as prompts; everything else is refused with a notice
 * and audited; `POST /prompts` is never a back door.
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let samId: string;
let orgId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;
let sessionId: string;

const FULL: RuntimeCatalog[] = [CLAUDE_CATALOG, CODEX_CATALOG];

type CommandResult = {
  kind: "settings" | "prompt" | "refused";
  command: string;
  notice: string;
  session?: {
    model: string | null;
    permissionMode: string;
    settings: { requested: Record<string, unknown> };
  };
  prompt?: { id: string; body: string; status: string };
};

const command = (as: TestClient, id: string, text: string) =>
  as.request("POST", `/api/v1/work-sessions/${id}/commands`, { text });
const prompt = (as: TestClient, id: string, body: string) =>
  as.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body });

async function putPolicy(body: Record<string, unknown>) {
  const res = await admin.request("PUT", "/api/v1/work-zone-policy", body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function optIn(on: boolean) {
  device.capabilities(FULL, on);
  await eventually(async () => {
    const r = await su.query("select full_access_opt_in, runtime_catalog from app.devices where id = $1", [
      deviceId,
    ]);
    return r.rows[0].full_access_opt_in === on && (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
}

async function audits(action: string, id: string) {
  return (
    await su.query(
      "select result, metadata, user_id from app.audit_events where action = $1 and session_id = $2 order by occurred_at",
      [action, id],
    )
  ).rows as Array<{ result: string; metadata: Record<string, unknown>; user_id: string | null }>;
}

const lastDenial = async () =>
  (
    await su.query(
      "select metadata from app.audit_events where action = 'authz.denied' and metadata->>'permission' = 'work_session.configure' order by occurred_at desc limit 1",
    )
  ).rows[0]?.metadata as Record<string, unknown> | undefined;

const promptCount = async (id: string) =>
  (await su.query("select count(*)::int as n from app.work_prompts where work_session_id = $1", [id])).rows[0]
    .n as number;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam", "developer"));
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_slash",
    name: "ocw",
  }));
  orgId = (await su.query("select organization_id from app.devices where id = $1", [deviceId])).rows[0]
    .organization_id as string;
  await optIn(false);
  sessionId = await startSession(admin, device, projectId, { title: "Slash" });
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("settings commands go through the settings path (Task 1, D-13, WZC-01)", () => {
  it("/effort high changes the session like the menu: session.configure, audit source slash_command", async () => {
    const res = await command(admin, sessionId, "/effort high");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as unknown as CommandResult;
    expect(body).toMatchObject({
      kind: "settings",
      command: "effort",
      notice: "Reasoning set to High — applies to the next turn",
    });
    expect(body.session?.settings.requested.effort).toBe("high");
    const cmd = await device.command("session.configure", sessionId);
    expect(cmd.payload).toEqual({ settings: { effort: "high" }, reason: "slash_command" });
    device.ack(cmd.id);
    const rows = await audits("work_session.settings_changed", sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ changed: ["effort"], source: "slash_command" });
  });

  it("/fast on and /fast off change fast mode when the policy allows it", async () => {
    await putPolicy({ allowFastMode: true });
    const on = await command(admin, sessionId, "/fast on");
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({
      kind: "settings",
      command: "fast",
      notice: "Fast mode on — applies to the next turn",
    });
    const cmdOn = await device.command("session.configure", sessionId);
    expect(cmdOn.payload).toEqual({ settings: { fastMode: true }, reason: "slash_command" });
    device.ack(cmdOn.id);
    const off = await command(admin, sessionId, "/fast off");
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ kind: "settings", notice: "Fast mode off — applies to the next turn" });
    const cmdOff = await device.command("session.configure", sessionId);
    expect(cmdOff.payload).toEqual({ settings: { fastMode: false }, reason: "slash_command" });
    device.ack(cmdOff.id);
    const rows = await audits("work_session.settings_changed", sessionId);
    expect(rows.map((r) => r.metadata.source)).toEqual(["slash_command", "slash_command", "slash_command"]);
  });

  it("/model sonnet sets the model with its display name in the notice; no prompt is queued", async () => {
    const before = await promptCount(sessionId);
    const res = await command(admin, sessionId, "/model sonnet");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as unknown as CommandResult;
    expect(body).toMatchObject({
      kind: "settings",
      command: "model",
      notice: "Model set to Claude Sonnet 5.5 — applies to the next turn",
    });
    expect(body.session?.model).toBe("sonnet");
    const cmd = await device.command("session.configure", sessionId);
    expect(cmd.payload).toEqual({ settings: { model: "sonnet" }, reason: "slash_command" });
    device.ack(cmd.id);
    const rows = await audits("work_session.settings_changed", sessionId);
    expect(rows.at(-1)!.metadata).toMatchObject({
      changed: ["model"],
      to: { model: "sonnet" },
      source: "slash_command",
    });
    expect(await promptCount(sessionId)).toBe(before);
    // The change is emitted on the session topic, so every controller sees it live.
    const emitted = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${sessionId}`],
    );
    expect(emitted.rows[0].payload.model).toBe("sonnet");
  });

  it("/model nope is refused exactly like the menu (403 not_in_catalog); bad arguments are a 400", async () => {
    const res = await command(admin, sessionId, "/model nope");
    expect([res.status, errorCode(res)]).toEqual([403, "not_in_catalog"]);
    const bad = await command(admin, sessionId, "/fast maybe");
    expect([bad.status, errorCode(bad)]).toEqual([400, "bad_command"]);
    expect((bad.body?.error as { message?: string } | undefined)?.message).toBe("Usage: /fast on|off");
    expect(device.pending("session.configure")).toHaveLength(0);
  });
});

describe("slash commands can never raise the mode (Task 2, WZC-04, ADR-0012 §4)", () => {
  it("/permissions full access under the default policy → 403 org_policy, audited as authz.denied (layer org)", async () => {
    const res = await command(admin, sessionId, "/permissions full access");
    expect([res.status, errorCode(res)]).toEqual([403, "org_policy"]);
    expect(await lastDenial()).toMatchObject({ reason: "org_policy", layer: "org" });
    expect(device.pending("session.configure")).toHaveLength(0);
  });

  it("with the policy on but no device opt-in → 403 device_opt_in", async () => {
    await putPolicy({ allowFullAccess: true });
    const res = await command(admin, sessionId, "/permissions full access");
    expect([res.status, errorCode(res)]).toEqual([403, "device_opt_in"]);
    expect(await lastDenial()).toMatchObject({ reason: "device_opt_in", layer: "device" });
  });

  it("a grantee capped at acceptEdits cannot /permissions auto → 403 device_grant", async () => {
    await su.query(
      `insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode)
       values ($1, $2, 'user', $3, 'acceptEdits')`,
      [orgId, deviceId, samId],
    );
    const res = await command(sam, sessionId, "/permissions auto");
    expect([res.status, errorCode(res)]).toEqual([403, "device_grant"]);
    // Within the cap the same command works and goes through the settings path.
    const ok = await command(sam, sessionId, "/permissions auto-accept");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      kind: "settings",
      command: "permissions",
      notice: "Permission mode set to Auto-accept edits — applies to the next turn",
    });
    const cmd = await device.command("session.configure", sessionId);
    expect(cmd.payload).toEqual({ settings: { permissionMode: "acceptEdits" }, reason: "slash_command" });
    device.ack(cmd.id);
  });
});

describe("refused and passthrough commands (Task 2, D-13)", () => {
  const REFUSED = ["/config", "/mcp", "/agents", "/login", "/hooks", "/update-config"];

  it("runtime-configuration commands are refused with a notice and audited by name only; nothing runs", async () => {
    const before = await promptCount(sessionId);
    for (const text of REFUSED) {
      const name = text.slice(1);
      const res = await command(admin, sessionId, `${text} secret-argument`);
      expect(res.status, `${text}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body).toEqual({
        kind: "refused",
        command: name,
        notice: `/${name} is not available from the workspace. Use the session controls.`,
      });
    }
    const rows = await audits("work_session.slash_refused", sessionId);
    expect(rows.map((r) => r.metadata)).toEqual(REFUSED.map((t) => ({ command: t.slice(1) })));
    expect(rows.every((r) => r.result === "denied")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("secret-argument");
    await sleep(200);
    expect(device.pending("session.configure")).toHaveLength(0);
    expect(device.pending("prompt")).toHaveLength(0);
    expect(await promptCount(sessionId)).toBe(before);
  });

  it("/compact runs as a normal prompt", async () => {
    const res = await command(admin, sessionId, "/compact");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as unknown as CommandResult;
    expect(body).toMatchObject({ kind: "prompt", command: "compact", prompt: { body: "/compact" } });
    const cmd = await device.command("prompt", sessionId);
    expect(cmd.payload).toMatchObject({ promptId: body.prompt!.id, text: "/compact" });
    device.ack(cmd.id);
    device.event(sessionId, { type: "prompt.started", promptId: body.prompt!.id });
    device.event(sessionId, {
      type: "prompt.completed",
      promptId: body.prompt!.id,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [body.prompt!.id]);
      return r.rows[0].status === "completed";
    });
  });

  it("a member without work_session.prompt cannot use refused commands to write audits", async () => {
    const { client: stan, userId: stanId } = await invite(
      stack,
      admin,
      "stan@example.test",
      "Stan",
      "standard",
    );
    // Explicit access (07.9-03, D-06): Stan sees the session as a fellow member of a team project its repo is linked
    // to, so his role (no work_session.prompt), not a missing audience, is what refuses him. Sam (a grantee above)
    // joins too and keeps his grant.
    const adminId = (await su.query("select id from auth.user where email = $1", [ADMIN.email])).rows[0]
      .id as string;
    const { unitId } = await createTeamProject(stack, admin, {
      name: "OCW",
      members: [{ userId: adminId }, { userId: samId }, { userId: stanId }],
    });
    await linkRepo(stack, { organizationId: orgId, unitId, projectId, deviceId, linkedBy: adminId });
    const res = await command(stan, sessionId, "/config");
    expect(res.status).toBe(403);
  });
});

describe("POST /prompts is no back door (Task 2, D-13)", () => {
  it("settings and refused commands are refused with 400 slash_command; passthrough and inline slashes pass", async () => {
    const before = await promptCount(sessionId);
    for (const body of ["/permissions full access", "/config", "/model sonnet"]) {
      const res = await prompt(admin, sessionId, body);
      expect([res.status, errorCode(res)], body).toEqual([400, "slash_command"]);
      expect((res.body?.error as { message?: string } | undefined)?.message).toBe(
        "Send slash commands from the composer",
      );
    }
    expect(await promptCount(sessionId)).toBe(before);

    const compact = await prompt(admin, sessionId, "/compact");
    expect(compact.status, JSON.stringify(compact.body)).toBe(200);
    const inline = await prompt(admin, sessionId, "see /config docs");
    expect(inline.status, JSON.stringify(inline.body)).toBe(200);
    expect(await promptCount(sessionId)).toBe(before + 2);
    // Drain the two turns so the session is idle for the next cases.
    for (const p of [compact, inline]) {
      const cmd = await device.command("prompt", sessionId);
      expect(cmd.payload.promptId).toBe(p.body!.id);
      device.ack(cmd.id);
      device.event(sessionId, { type: "prompt.started", promptId: p.body!.id });
      device.event(sessionId, {
        type: "prompt.completed",
        promptId: p.body!.id,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }
  });

  it("the first prompt of a new session and an edited queued prompt cannot carry a refused command either", async () => {
    const create = await admin.request("POST", "/api/v1/work-sessions", { projectId, prompt: "/config" });
    expect([create.status, errorCode(create)]).toEqual([400, "slash_command"]);
    // Hold the session busy so a prompt stays queued, then try to edit it into a command.
    const busy = await startSession(admin, device, projectId, { title: "Edit" });
    const first = await prompt(admin, busy, "first");
    expect(first.status).toBe(200);
    const queued = await prompt(admin, busy, "second");
    expect(queued.status).toBe(200);
    const edit = await admin.request("PATCH", `/api/v1/work-sessions/${busy}/prompts/${queued.body!.id}`, {
      body: "/permissions full access",
    });
    expect([edit.status, errorCode(edit)]).toEqual([400, "slash_command"]);
  });
});

describe("tenant isolation (Task 2)", () => {
  it("another organization's session cannot receive commands (404, nothing audited or enqueued)", async () => {
    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    const wsB = randomUUID();
    const q = (t: string, v: unknown[]) => su.query(t, v);
    await q("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [orgB, `o-${orgB}`]);
    await q("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@b.test`]);
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', '[]')",
      [devB, orgB, userB, createHash("sha256").update(`ocwd_${devB}`).digest("hex")],
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
    for (const text of ["/model sonnet", "/config", "/compact"]) {
      expect((await command(admin, wsB, text)).status, text).toBe(404);
    }
    expect((await prompt(admin, wsB, "/config")).status).toBe(404);
    const leaked = await su.query(
      "select count(*)::int as n from app.audit_events where session_id = $1 and action like 'work_session.%'",
      [wsB],
    );
    expect(leaked.rows[0].n).toBe(0);
    const untouched = await su.query("select model, settings_pending from app.work_sessions where id = $1", [
      wsB,
    ]);
    expect(untouched.rows[0]).toEqual({ model: null, settings_pending: false });
    expect(await promptCount(wsB)).toBe(0);
  });

  it("an unknown session is a 404", async () => {
    expect((await command(admin, randomUUID(), "/model sonnet")).status).toBe(404);
  });

  it("every Work Zone answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) => /^\/api\/v1\/work-sessions/.test(u.url));
    expect(undecided).toEqual([]);
  });
});
