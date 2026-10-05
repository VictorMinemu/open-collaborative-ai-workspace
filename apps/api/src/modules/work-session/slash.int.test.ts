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
  errorCode,
  invite,
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
  session?: { model: string | null; permissionMode: string; settings: { requested: Record<string, unknown> } };
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
    expect(on.body).toMatchObject({ kind: "settings", command: "fast", notice: "Fast mode on — applies to the next turn" });
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
    const bad = await command(admin, sessionId, "/effort loud");
    expect([bad.status, errorCode(bad)]).toEqual([400, "bad_command"]);
    expect((bad.body?.error as { message?: string }).message).toBe("Usage: /effort <level|default>");
    expect(device.pending("session.configure")).toHaveLength(0);
  });
});

describe("authorization (Task 1)", () => {
  it("an unknown session is a 404", async () => {
    expect((await command(admin, randomUUID(), "/model sonnet")).status).toBe(404);
  });

  it("every Work Zone answer went through the resolver", () => {
    const undecided = stack.built.authz.undecided.filter((u) => /^\/api\/v1\/work-sessions/.test(u.url));
    expect(undecided).toEqual([]);
  });
});
