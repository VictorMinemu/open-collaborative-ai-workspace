import { randomUUID } from "node:crypto";
import { type BotWorkZoneProfileInput, isExposed, type RuntimeCatalog } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../../lib/errors";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, type Frame, sleep } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  createBotProfile,
  grantBotConsent,
  invite,
  pairDevice,
  settled,
  startSession,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { loadBotProfile, profileStatus } from "./bot-profile";
import { archiveWorkSession, submitWorkPrompt } from "./controller";
import type { WorkSessionService } from "./service";
import type { WorkSessionStartDeps } from "./start";

/**
 * Phase 07.16-10 (D-02, D-04, D-07, D-08, PD-07, PD-08, PD-13, PD-23; E4, E5, E12): a bot's turn is re-decided by the
 * ONE arbiter against its live profile (its cap, `bot_not_allowed` when the profile stopped working, no Full access
 * after outside content off an isolated server), re-authorization is agent-aware for bot sessions (a revoked consent,
 * a lowered profile or isolation turned off interrupts the bot's turn, never a person's), and people and bots queue
 * into the same session through the same `submitWorkPrompt` / `archiveWorkSession`. Real PostgreSQL + Redis.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

const FULL: RuntimeCatalog[] = [CLAUDE_CATALOG, CODEX_CATALOG];
/** The highest mode below Full access the catalog offers (Auto only once the inventory confirms it). */
const BELOW_FULL = isExposed("claude-code", "mode.auto") ? "auto" : "acceptEdits";

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let samId: string;
let dana: TestClient;
let danaId: string;
let orgId: string;
// Sam's MacBook (a desktop: never an isolated server) with billing-api; Scout works there.
let mac: FakeDevice;
let macId: string;
let billingId: string;
let scoutId: string;
// Sam's build server (a `service` host marked isolated) with infra; Rex works there.
let server: FakeDevice;
let serverToken: string;
let serverId: string;
let infraId: string;
let rexId: string;
// A person's own session on the MacBook: no bot sweep may touch it.
let human: string;

const svc = () => stack.built.deviceHub.sessionHandler as unknown as WorkSessionService;

const deps = () => {
  const core = stack.built.core;
  const startDeps: WorkSessionStartDeps = {
    core,
    perms: createPermissionService(core),
    svc: svc(),
    hub: stack.built.deviceHub,
  };
  return { core, svc: svc(), startDeps };
};

const asSam = <T>(fn: (tx: Tx) => Promise<T>) =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId: samId }, fn);
const samActor = () => ({ userId: samId, organizationId: orgId, clientKind: null });

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** A profile for `agentId` on `deviceId` with `projectId`; each test overrides what it is about. */
const profile = (
  deviceId: string,
  projectId: string,
  over: Partial<BotWorkZoneProfileInput> = {},
): BotWorkZoneProfileInput => ({
  deviceId,
  runtime: "claude-code",
  projectIds: [projectId],
  defaultModel: "opus",
  allowedModels: [],
  defaultEffort: null,
  allowedEfforts: [],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "acceptEdits",
  worktree: true,
  maxConcurrent: 10,
  promptsPerHour: 120,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
  ...over,
});

const scoutProfile = (over: Partial<BotWorkZoneProfileInput> = {}) => profile(macId, billingId, over);
const rexProfile = (over: Partial<BotWorkZoneProfileInput> = {}) => profile(serverId, infraId, over);

/**
 * Start a bot session the way the bot's route does (07.16-06): Sam's tenant transaction, the bot's live layer from
 * `profileStatus`, then the device brings it to `idle`. `tainted` stands for a start turn that read outside content.
 */
async function botSession(
  agentId: string,
  device: FakeDevice,
  projectId: string,
  deviceId: string,
  permissionMode: string,
  tainted = false,
): Promise<string> {
  const id = await asSam(async (tx) => {
    const p = await loadBotProfile(tx, agentId);
    if (!p) throw new Error("no profile");
    const status = await profileStatus(tx, createPermissionService(stack.built.core), p);
    if (!status.active) throw new Error(`profile inactive: ${status.reason}`);
    const res = await stack.built.workSession.start(
      tx,
      samActor(),
      { projectId, deviceId, runtime: "claude-code", permissionMode: permissionMode as never },
      { agent: { layer: { ...status.layer, tainted } } },
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.session.id;
  });
  const start = (await device.command("session.start", id)) as Cmd;
  device.ack(start.id);
  device.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "claude-opus-5-5",
    permissionMode,
  });
  device.event(id, { type: "session.state", status: "idle" });
  await idle(id);
  return id;
}

/** The bot prompts its session in its sponsor's name, through the ONE body people use (PD-13). */
const agentPrompt = (sessionId: string, agentId: string, body: string, tainted = false) =>
  asSam(async (tx) => {
    const s = await svc().lock(tx, sessionId);
    if (!s) throw new Error("no session");
    const p = await submitWorkPrompt(tx, deps(), samActor(), s, body, {
      authorAgentId: agentId,
      ...(tainted ? { tainted: true } : {}),
    });
    return p.id;
  });

async function prompt(as: TestClient, sessionId: string, body: string): Promise<string> {
  return (await ok(as.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body }))).id as string;
}

/** Ack a dispatched prompt and mark its turn started on the device (the session is `running`). */
function start(device: FakeDevice, cmd: Cmd) {
  device.ack(cmd.id);
  device.event(cmd.sessionId, { type: "prompt.started", promptId: cmd.payload.promptId as string });
}

/** Ack a dispatched prompt and run its whole turn on the device. */
function finish(device: FakeDevice, cmd: Cmd) {
  device.ack(cmd.id);
  device.emitTurn(cmd.sessionId, { promptId: cmd.payload.promptId as string, text: "done" });
}

/** The device reports the turn in flight ended by an interrupt. */
function interrupted(device: FakeDevice, sessionId: string, promptId: string) {
  device.event(sessionId, {
    type: "prompt.completed",
    promptId,
    interrupted: true,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

async function sessionRow(id: string) {
  return (
    await su.query("select status, permission_mode, settings_pending from app.work_sessions where id = $1", [
      id,
    ])
  ).rows[0] as { status: string; permission_mode: string; settings_pending: boolean };
}

const idle = (id: string) => eventually(async () => (await sessionRow(id)).status === "idle");

async function promptRow(id: string) {
  return (
    await su.query(
      "select status, permission_mode, author_user_id, author_agent_id from app.work_prompts where id = $1",
      [id],
    )
  ).rows[0] as {
    status: string;
    permission_mode: string | null;
    author_user_id: string;
    author_agent_id: string | null;
  };
}

async function auditOf(action: string, where: { promptId?: string; sessionId?: string }) {
  return (
    await su.query(
      `select result, metadata, user_id, actor_id, device_id, session_id from app.audit_events where action = $1
         and ($2::text is null or metadata->>'promptId' = $2) and ($3::text is null or session_id = $3)
       order by occurred_at`,
      [action, where.promptId ?? null, where.sessionId ?? null],
    )
  ).rows as Json[];
}

/** Commands the device got for `sessionId` and did not consume yet. */
const pendingFor = (device: FakeDevice, kind: string, sessionId: string) =>
  device.pending(kind).filter((f) => f.sessionId === sessionId);

async function putPolicy(body: Record<string, unknown>) {
  await ok(victor.request("PUT", "/api/v1/work-zone-policy", body));
}

/** The person's own session on the MacBook kept its settings and got no command from a bot sweep. */
async function humanUntouched() {
  await settled(stack, orgId);
  expect(await sessionRow(human)).toMatchObject({ status: "idle", permission_mode: "fullAccess" });
  expect(pendingFor(mac, "session.configure", human)).toHaveLength(0);
  expect(pendingFor(mac, "interrupt", human)).toHaveLength(0);
  expect(pendingFor(mac, "session.stop", human)).toHaveLength(0);
}

/** End a test's session over HTTP (the person's archive route) and consume its stop. */
async function archive(device: FakeDevice, sessionId: string) {
  await ok(sam.request("POST", `/api/v1/work-sessions/${sessionId}/archive`));
  device.ack(((await device.command("session.stop", sessionId)) as Cmd).id);
}

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "developer"));
  ({ client: dana, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Kim",
    "developer",
  ));
  await putPolicy({ allowFullAccess: true });

  const pairedMac = await pairDevice(stack, sam, "MacBook Pro");
  macId = pairedMac.deviceId;
  ({ device: mac, projectId: billingId } = await connectWithProject(stack, sam, pairedMac.token, {
    localId: "lp_billing",
    name: "billing-api",
  }));
  mac.capabilities(FULL, true);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog, full_access_opt_in from app.devices where id = $1", [
      macId,
    ]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2 && r.rows[0].full_access_opt_in === true;
  });
  // Dana may use the MacBook up to `default`: she is in a bot session's audience (the members who may use the device)
  // and her turns run at her own cap.
  await su.query(
    `insert into app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode)
     values ($1, $2, 'user', $3, 'default')`,
    [orgId, macId, danaId],
  );

  const pairedServer = await pairDevice(stack, sam, "Build server");
  serverId = pairedServer.deviceId;
  serverToken = pairedServer.token;
  server = await FakeDevice.connect(stack.baseUrl, serverToken, undefined, {
    host: "service",
    isolatedServer: true,
  });
  server.send({
    type: "projects.sync",
    projects: [{ localId: "lp_infra", name: "infra", gitRemote: null, defaultBranch: "main" }],
  });
  await server.next((f) => f.type === "projects.ack");
  server.capabilities(FULL, true, true);
  await eventually(async () => {
    const r = await su.query(
      "select runtime_catalog, full_access_opt_in, host_kind, isolated_server from app.devices where id = $1",
      [serverId],
    );
    const d = r.rows[0];
    return (
      (d.runtime_catalog as unknown[]).length === 2 &&
      d.full_access_opt_in === true &&
      d.host_kind === "service" &&
      d.isolated_server === true
    );
  });
  const projects = (await ok(sam.request("GET", "/api/v1/projects"))).projects as Array<{
    id: string;
    name: string;
  }>;
  infraId = projects.find((p) => p.name === "infra")!.id;

  scoutId = (await ok(sam.request("POST", "/api/v1/agents/personal", { name: "Scout" }))).agent.id;
  // A second bot of Sam's, seeded directly (one personal bot per member through the route; no cell is involved).
  rexId = randomUUID();
  await su.query(
    `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status, scope, owner_user_id)
     values ($1, $2, 'Rex', 'rex', '', 'mock', 'mock', 'ready', 'personal', $3)`,
    [rexId, orgId, samId],
  );
  await createBotProfile(sam, scoutId, scoutProfile());
  await grantBotConsent(sam, macId, scoutId, { allowFullAccess: false });
  await createBotProfile(sam, rexId, rexProfile({ maxMode: "fullAccess" }));
  await grantBotConsent(sam, serverId, rexId, { allowFullAccess: true });

  human = await startSession(sam, mac, billingId, { title: "Sam's own", permissionMode: "fullAccess" });
  await settled(stack, orgId);
}, 180_000);

afterAll(async () => {
  await mac?.close().catch(() => {});
  await server?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------- Task 1: the bot's cap through the one arbiter

describe("tracer: a bot's prompt runs at its own cap through the one arbiter (D-04, D-07, PD-07, PD-13)", () => {
  it("the bot's turns run at min(session mode, its cap); a person's turn in the same session at theirs", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "acceptEdits");
    const first = await agentPrompt(sid, scoutId, "look at the failing test");
    let cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: first, permissionMode: "acceptEdits" });
    const second = await agentPrompt(sid, scoutId, "next step");
    const danas = await prompt(dana, sid, "also check the logs");
    expect((await promptRow(second)).status).toBe("queued");
    expect((await promptRow(danas)).status).toBe("queued");

    finish(mac, cmd);
    cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: second, permissionMode: "acceptEdits" });
    expect(await promptRow(second)).toMatchObject({
      status: "dispatched",
      permission_mode: "acceptEdits",
      author_user_id: samId,
      author_agent_id: scoutId,
    });
    const [audit] = await auditOf("work_prompt.dispatched", { promptId: second });
    expect(audit).toMatchObject({ result: "success", user_id: samId, device_id: macId, session_id: sid });
    expect(audit!.metadata).toMatchObject({
      promptId: second,
      authorUserId: samId,
      authorAgentId: scoutId,
      requestedMode: "acceptEdits",
      effectiveMode: "acceptEdits",
      capped: false,
    });

    finish(mac, cmd);
    cmd = (await mac.command("prompt", sid)) as Cmd;
    // Dana's own cap on the MacBook is `default`: her turn is hers, never the bot's.
    expect(cmd.payload).toMatchObject({ promptId: danas, permissionMode: "default" });
    const [human] = await auditOf("work_prompt.dispatched", { promptId: danas });
    expect(human!.metadata).toMatchObject({ authorUserId: danaId, effectiveMode: "default", capped: true });
    expect(human!.metadata).not.toHaveProperty("authorAgentId");
    finish(mac, cmd);
    await idle(sid);
    await archive(mac, sid);
  });

  it("a person raises the bot's session above its cap: the bot's turns stay at its cap, the person's do not", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "acceptEdits");
    await ok(sam.request("PATCH", `/api/v1/work-sessions/${sid}/settings`, { permissionMode: "fullAccess" }));
    mac.ack(((await mac.command("session.configure", sid)) as Cmd).id);
    const bots = await agentPrompt(sid, scoutId, "refactor the module");
    let cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: bots, permissionMode: "acceptEdits" });
    expect((await auditOf("work_prompt.dispatched", { promptId: bots }))[0]!.metadata).toMatchObject({
      authorAgentId: scoutId,
      requestedMode: "fullAccess",
      effectiveMode: "acceptEdits",
      capped: true,
    });
    expect((await auditOf("work_prompt.dispatched", { promptId: bots }))[0]!.metadata).not.toHaveProperty(
      "fullAccess",
    );
    finish(mac, cmd);
    const sams = await prompt(sam, sid, "now run it with everything");
    cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: sams, permissionMode: "fullAccess" });
    finish(mac, cmd);
    await idle(sid);
    await archive(mac, sid);
  });

  it("the shared bodies keep the routes' answers: archived, slash commands, and the archive itself", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "default");
    // A slash command never enters the queue (the route's 400, from the same body).
    await expect(agentPrompt(sid, scoutId, "/model sonnet")).rejects.toMatchObject({
      statusCode: 400,
      code: "slash_command",
    });
    const running = await agentPrompt(sid, scoutId, "long task");
    const cmd = (await mac.command("prompt", sid)) as Cmd;
    start(mac, cmd);
    const queued = await agentPrompt(sid, scoutId, "after that");
    // The bot ends its own session through the archive body people use; the audit names the bot.
    await asSam(async (tx) => {
      const s = await svc().lock(tx, sid);
      await archiveWorkSession(tx, deps(), s!, { byAgentId: scoutId });
    });
    expect((await promptRow(queued)).status).toBe("cancelled");
    expect((await sessionRow(sid)).status).toBe("archived");
    mac.ack(((await mac.command("session.stop", sid)) as Cmd).id);
    const [archived] = await auditOf("work_session.archived", { sessionId: sid });
    expect(archived).toMatchObject({ actor_id: samId, session_id: sid, device_id: macId });
    expect(archived!.metadata).toMatchObject({ byAgentId: scoutId });
    // Archived: the next prompt is the route's 409, from the same body.
    const err = await agentPrompt(sid, scoutId, "one more").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 409, code: "session_archived" });
    expect(running).toBeTruthy();
    // Archiving again is a no-op (the route answers ok), and writes no second audit row.
    await asSam(async (tx) => {
      const s = await svc().lock(tx, sid);
      await archiveWorkSession(tx, deps(), s!, { byAgentId: scoutId });
    });
    expect(await auditOf("work_session.archived", { sessionId: sid })).toHaveLength(1);
  });

  it("a person's archive over HTTP is audited exactly as before (no bot id)", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "default");
    await archive(mac, sid);
    const [archived] = await auditOf("work_session.archived", { sessionId: sid });
    expect(archived).toMatchObject({ actor_id: samId, session_id: sid });
    expect(archived!.metadata ?? {}).not.toHaveProperty("byAgentId");
  });
});

// ---------------------------------------------------------------- Task 2: inactive profiles and outside content

/** The device reports the turn in flight finished normally (it was acked and started with `start`). */
function complete(device: FakeDevice, sessionId: string, promptId: string) {
  device.event(sessionId, { type: "prompt.completed", promptId, usage: { inputTokens: 1, outputTokens: 1 } });
}

/**
 * While Sam's own turn runs, the bot queues a prompt and Dana queues one after it; then the profile stops working
 * (`breakIt`). When Sam's turn ends, the bot's prompt is refused `bot_not_allowed` (failed, never sent) and Dana's runs.
 */
async function refusedWhileInactive(breakIt: () => Promise<void>, restore: () => Promise<void>) {
  const sid = await botSession(scoutId, mac, billingId, macId, "default");
  const sams = await prompt(sam, sid, "mine first");
  const running = (await mac.command("prompt", sid)) as Cmd;
  expect(running.payload.promptId).toBe(sams);
  start(mac, running);
  const bots = await agentPrompt(sid, scoutId, "the bot's next step");
  const danas = await prompt(dana, sid, "then mine");
  await breakIt();
  try {
    complete(mac, sid, sams);
    const cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: danas, permissionMode: "default" });
    expect(await promptRow(bots)).toMatchObject({ status: "failed", permission_mode: null });
    const [refused] = await auditOf("work_prompt.refused", { promptId: bots });
    expect(refused).toMatchObject({ result: "denied", user_id: samId, session_id: sid, device_id: macId });
    expect(refused!.metadata).toMatchObject({
      promptId: bots,
      authorUserId: samId,
      authorAgentId: scoutId,
      reason: "bot_not_allowed",
    });
    expect(await auditOf("work_prompt.dispatched", { promptId: bots })).toHaveLength(0);
    finish(mac, cmd);
    await idle(sid);
    expect(mac.pending("prompt").filter((f) => (f.payload as Json).promptId === bots)).toHaveLength(0);
  } finally {
    await restore();
  }
  await archive(mac, sid);
}

describe("a bot whose profile stopped working runs no further turn (Pitfall 10, E5)", () => {
  it("consent revoked: the bot's queued prompt is refused bot_not_allowed; a person's after it runs", async () => {
    await refusedWhileInactive(
      async () => {
        await su.query(
          "update app.device_bot_consents set revoked_at = now() where device_id = $1 and agent_id = $2",
          [macId, scoutId],
        );
      },
      async () => {
        await su.query(
          "update app.device_bot_consents set revoked_at = null where device_id = $1 and agent_id = $2",
          [macId, scoutId],
        );
      },
    );
  });

  it("sponsor deactivated: the bot's queued prompt is refused bot_not_allowed; a person's after it runs", async () => {
    await refusedWhileInactive(
      async () => {
        await su.query("update app.org_members set deactivated_at = now() where user_id = $1", [samId]);
      },
      async () => {
        await su.query("update app.org_members set deactivated_at = null where user_id = $1", [samId]);
      },
    );
  });

  it("bot disabled: the bot's queued prompt is refused bot_not_allowed; a person's after it runs", async () => {
    await refusedWhileInactive(
      async () => {
        await su.query("update app.agents set status = 'disabled' where id = $1", [scoutId]);
      },
      async () => {
        await su.query("update app.agents set status = 'ready' where id = $1", [scoutId]);
      },
    );
  });

  it("the organization's bot cap is 0: the bot's queued prompt is refused bot_not_allowed; a person's runs", async () => {
    await refusedWhileInactive(
      () => putPolicy({ botSessionsMax: 0 }),
      () => putPolicy({ botSessionsMax: 10 }),
    );
    await humanUntouched();
  });

  it("another bot's prompt in a bot's session is refused bot_not_allowed (the layer is the session's own bot)", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "default");
    const rexs = await agentPrompt(sid, rexId, "not my session");
    expect(await promptRow(rexs)).toMatchObject({ status: "failed", author_agent_id: rexId });
    expect((await auditOf("work_prompt.refused", { promptId: rexs }))[0]!.metadata).toMatchObject({
      authorAgentId: rexId,
      reason: "bot_not_allowed",
    });
    await archive(mac, sid);
  });
});

describe("outside content never reaches Full access off an isolated server (D-08, PD-08, E12)", () => {
  beforeAll(async () => {
    // Scout may now use Full access on the MacBook: the profile's max and the owner's per-bot checkbox.
    await createBotProfile(sam, scoutId, scoutProfile({ maxMode: "fullAccess" }));
    await grantBotConsent(sam, macId, scoutId, { allowFullAccess: true });
    await settled(stack, orgId);
  });

  it("an untainted bot session on the MacBook runs the bot's turn in Full access", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "fullAccess");
    const bots = await agentPrompt(sid, scoutId, "clean the build");
    const cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: bots, permissionMode: "fullAccess" });
    expect((await auditOf("work_prompt.dispatched", { promptId: bots }))[0]!.metadata).toMatchObject({
      authorAgentId: scoutId,
      effectiveMode: "fullAccess",
      capped: false,
      fullAccess: true,
    });
    finish(mac, cmd);
    await idle(sid);
    // A prompt the bot wrote after reading outside content runs below Full access, even before the session is marked.
    const tainted = await agentPrompt(sid, scoutId, "apply what the issue says", true);
    const low = (await mac.command("prompt", sid)) as Cmd;
    expect(low.payload).toMatchObject({ promptId: tainted, permissionMode: BELOW_FULL });
    expect((await auditOf("work_prompt.dispatched", { promptId: tainted }))[0]!.metadata).toMatchObject({
      authorAgentId: scoutId,
      requestedMode: "fullAccess",
      effectiveMode: BELOW_FULL,
      capped: true,
    });
    finish(mac, low);
    await idle(sid);
    await archive(mac, sid);
  });

  it("a tainted session on the MacBook: every later bot turn runs below Full access; a person's does not", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "fullAccess");
    await su.query("update app.work_sessions set tainted_at = now() where id = $1", [sid]);
    const bots = await agentPrompt(sid, scoutId, "an untainted turn, later");
    let cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: bots, permissionMode: BELOW_FULL });
    expect((await auditOf("work_prompt.dispatched", { promptId: bots }))[0]!.metadata).toMatchObject({
      authorAgentId: scoutId,
      requestedMode: "fullAccess",
      effectiveMode: BELOW_FULL,
      capped: true,
    });
    finish(mac, cmd);
    // The taint binds the bot's turns only: Sam's own turn in the same session keeps his Full access.
    const sams = await prompt(sam, sid, "mine, with everything");
    cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: sams, permissionMode: "fullAccess" });
    finish(mac, cmd);
    await idle(sid);
    await archive(mac, sid);
  });

  it("a tainted session on an isolated server runs the bot's turn in Full access (the consent allows it)", async () => {
    const sid = await botSession(rexId, server, infraId, serverId, "fullAccess", true);
    expect(
      (await su.query("select tainted_at from app.work_sessions where id = $1", [sid])).rows[0].tainted_at,
    ).not.toBeNull();
    const bots = await agentPrompt(sid, rexId, "deploy to staging", true);
    const cmd = (await server.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: bots, permissionMode: "fullAccess" });
    expect((await auditOf("work_prompt.dispatched", { promptId: bots }))[0]!.metadata).toMatchObject({
      authorAgentId: rexId,
      effectiveMode: "fullAccess",
      fullAccess: true,
    });
    finish(server, cmd);
    await idle(sid);
    await archive(server, sid);
  });
});

// ---------------------------------------------------------------- Task 3: agent-aware re-authorization

/** A bot session in Full access whose bot turn is running on `device`; returns the session and the prompt. */
async function runningBotTurn(
  agentId: string,
  device: FakeDevice,
  projectId: string,
  deviceId: string,
  tainted = false,
) {
  const sid = await botSession(agentId, device, projectId, deviceId, "fullAccess", tainted);
  const pid = await agentPrompt(sid, agentId, "a long Full access task");
  const cmd = (await device.command("prompt", sid)) as Cmd;
  expect(cmd.payload).toMatchObject({ promptId: pid, permissionMode: "fullAccess" });
  start(device, cmd);
  await eventually(async () => (await sessionRow(sid)).status === "running");
  return { sid, pid };
}

const revokeScout = () => ok(sam.request("DELETE", `/api/v1/devices/${macId}/bot-consents/${scoutId}`));
const regrantScout = () => grantBotConsent(sam, macId, scoutId, { allowFullAccess: true });

describe("re-authorization is agent-aware for bot sessions (E4, PD-08)", () => {
  it("consent revoked while the bot's Full access turn runs: interrupted, and its next prompt refused", async () => {
    const { sid, pid } = await runningBotTurn(scoutId, mac, billingId, macId);
    const next = await agentPrompt(sid, scoutId, "and then this");
    const sams = await prompt(sam, sid, "mine after");
    await revokeScout();
    const interrupt = (await mac.command("interrupt", sid)) as Cmd;
    mac.ack(interrupt.id);
    await settled(stack, orgId);
    // Sam may still use Full access himself: the session keeps his highest mode, people keep their control of it.
    expect(await sessionRow(sid)).toMatchObject({ permission_mode: "fullAccess" });
    expect(pendingFor(mac, "session.configure", sid)).toHaveLength(0);
    const [audit] = await auditOf("work_session.interrupted", { sessionId: sid });
    expect(audit).toMatchObject({ session_id: sid, device_id: macId });
    expect(audit!.metadata).toMatchObject({
      reason: "access_changed",
      promptId: pid,
      authorAgentId: scoutId,
    });
    interrupted(mac, sid, pid);
    const cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: sams, permissionMode: "fullAccess" });
    expect((await auditOf("work_prompt.refused", { promptId: next }))[0]!.metadata).toMatchObject({
      authorAgentId: scoutId,
      reason: "bot_not_allowed",
    });
    finish(mac, cmd);
    await idle(sid);
    await archive(mac, sid);
    await regrantScout();
    await humanUntouched();
  });

  it("a person's Full access turn in a bot session is not interrupted by the same revoke", async () => {
    const sid = await botSession(scoutId, mac, billingId, macId, "fullAccess");
    const sams = await prompt(sam, sid, "mine, with everything");
    const cmd = (await mac.command("prompt", sid)) as Cmd;
    expect(cmd.payload).toMatchObject({ promptId: sams, permissionMode: "fullAccess" });
    start(mac, cmd);
    await revokeScout();
    await settled(stack, orgId);
    await sleep(200);
    expect(pendingFor(mac, "interrupt", sid)).toHaveLength(0);
    expect(pendingFor(mac, "session.configure", sid)).toHaveLength(0);
    expect(await sessionRow(sid)).toMatchObject({ status: "running", permission_mode: "fullAccess" });
    expect(await auditOf("work_session.interrupted", { sessionId: sid })).toHaveLength(0);
    complete(mac, sid, sams);
    await idle(sid);
    await archive(mac, sid);
    await regrantScout();
    await humanUntouched();
  });

  it("the profile saved down to acceptEdits lowers the bot's session and interrupts its Full access turn", async () => {
    const { sid, pid } = await runningBotTurn(scoutId, mac, billingId, macId);
    await createBotProfile(sam, scoutId, scoutProfile({ maxMode: "acceptEdits" }));
    const configure = (await mac.command("session.configure", sid)) as Cmd;
    expect(configure.payload).toEqual({
      settings: { permissionMode: "acceptEdits" },
      reason: "access_changed",
    });
    mac.ack(configure.id);
    mac.ack(((await mac.command("interrupt", sid)) as Cmd).id);
    await settled(stack, orgId);
    expect((await sessionRow(sid)).permission_mode).toBe("acceptEdits");
    expect((await auditOf("work_session.full_access_left", { sessionId: sid }))[0]!.metadata).toMatchObject({
      from: "fullAccess",
      to: "acceptEdits",
      source: "access_changed",
    });
    interrupted(mac, sid, pid);
    await idle(sid);
    await archive(mac, sid);
    await createBotProfile(sam, scoutId, scoutProfile({ maxMode: "fullAccess" }));
    await humanUntouched();
  });

  it("isolation turned off on the server lowers a tainted bot session and interrupts its turn; an untainted one is left", async () => {
    const clean = await botSession(rexId, server, infraId, serverId, "fullAccess");
    const { sid, pid } = await runningBotTurn(rexId, server, infraId, serverId, true);
    server.capabilities(FULL, true, false);
    const configure = (await server.command("session.configure", sid)) as Cmd;
    expect(configure.payload).toEqual({ settings: { permissionMode: BELOW_FULL }, reason: "device_opt_out" });
    server.ack(configure.id);
    server.ack(((await server.command("interrupt", sid)) as Cmd).id);
    await settled(stack, orgId);
    expect((await sessionRow(sid)).permission_mode).toBe(BELOW_FULL);
    expect(await sessionRow(clean)).toMatchObject({ status: "idle", permission_mode: "fullAccess" });
    expect(pendingFor(server, "session.configure", clean)).toHaveLength(0);
    expect(pendingFor(server, "interrupt", clean)).toHaveLength(0);
    interrupted(server, sid, pid);
    await idle(sid);
    server.capabilities(FULL, true, true);
    await eventually(async () => {
      const r = await su.query("select isolated_server from app.devices where id = $1", [serverId]);
      return r.rows[0].isolated_server === true;
    });
    await archive(server, sid);
    await archive(server, clean);
    await humanUntouched();
  });

  it("a server that reconnects with the isolated mark off re-authorizes its bot sessions (the hello path)", async () => {
    const clean = await botSession(rexId, server, infraId, serverId, "fullAccess");
    const { sid, pid } = await runningBotTurn(rexId, server, infraId, serverId, true);
    await server.close();
    // The daemon restarts its link with its Full access opt-in still on and the isolated mark now off.
    server = await FakeDevice.open(stack.baseUrl, await FakeDevice.exchange(stack.baseUrl, serverToken));
    server.send({
      type: "hello",
      protocolVersion: 1,
      device: { name: "Build server", platform: "linux", daemonVersion: "0.0.0-test", host: "service" },
      runtimes: [
        { id: "claude-code", installed: true, version: "2.1.287", loggedIn: true },
        { id: "codex", installed: true, version: "0.160.0", loggedIn: false },
      ],
      sessions: [clean, sid],
      fullAccessOptIn: true,
      isolatedServer: false,
    });
    await server.next((f) => f.type === "welcome");
    const configure = (await server.command("session.configure", sid)) as Cmd;
    expect(configure.payload).toEqual({ settings: { permissionMode: BELOW_FULL }, reason: "device_opt_out" });
    server.ack(configure.id);
    server.ack(((await server.command("interrupt", sid)) as Cmd).id);
    expect((await sessionRow(sid)).permission_mode).toBe(BELOW_FULL);
    // The untainted session needs no isolation: untouched.
    await sleep(200);
    expect(await sessionRow(clean)).toMatchObject({ status: "idle", permission_mode: "fullAccess" });
    expect(pendingFor(server, "session.configure", clean)).toHaveLength(0);
    interrupted(server, sid, pid);
    await idle(sid);
    await archive(server, clean);
    server.capabilities(FULL, true, true);
    await eventually(async () => {
      const r = await su.query("select isolated_server from app.devices where id = $1", [serverId]);
      return r.rows[0].isolated_server === true;
    });
    await archive(server, sid);
  });

  it("no sweep above touched the person's own session on the MacBook", async () => {
    await humanUntouched();
    for (const action of [
      "work_session.settings_downgraded",
      "work_session.full_access_left",
      "work_session.interrupted",
      "work_session.access_revoked",
    ]) {
      expect(await auditOf(action, { sessionId: human }), action).toHaveLength(0);
    }
  });
});
