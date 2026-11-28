import { randomUUID } from "node:crypto";
import {
  AssignPreview,
  AssignWorkSessionResult,
  type RuntimeCatalog,
  WS_AUTH_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  setAudience,
  settled,
  shareDevice,
  startSession,
} from "../../testing-workzone";

/**
 * Phase 07.13.1.1-02 (D-03, D-04, D-05, D-11, D-12, D-13, D-15; PD-02 … PD-05, PD-14): Assign to me through the API on
 * real PostgreSQL and Redis. A member takes over a session that runs on a server (`host_kind = 'service'`, exactly) in
 * one locked transaction that moves `work_sessions.created_by`: every owner rule moves with it, a running turn is never
 * cut, the queued prompts of people who lose access are cancelled, and everyone is told live. Every refusal is decided
 * by the API and writes nothing.
 *
 * Organization A. Víctor (admin) owns "Build server" (a headless daemon, `host: "service"`, Full access opted in) with
 * `checkout` (team project Checkout: Ana, Pia, Leo) and lends it to Ana (up to acceptEdits) and Pia (up to Full access);
 * Leo may not use it. Ana owns "Ana's server" (service, personal `notes`, lent to Pia and Leo), "Ana's laptop" (desktop,
 * lent to Pia) and "Old daemon" (never reported a host, lent to Pia). Víctor's "Retired server" (service) is lent to Ana
 * and Pia, then revoked. Olga (developer) is in nothing. Organization B: Eve (admin).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

interface Host {
  id: string;
  token: string;
  device: FakeDevice;
  repo: Record<string, string>;
}

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let adminId: string;
let ana: TestClient;
let anaId: string;
let pia: TestClient;
let piaId: string;
let leo: TestClient;
let leoId: string;
let olga: TestClient;
let eve: TestClient;
let srv: Host;
let anaSrv: Host;
let laptop: Host;
let legacy: Host;
let retired: Host;
const open: FakeDevice[] = [];
const sockets: WebSocket[] = [];

const FULL: RuntimeCatalog[] = [
  CLAUDE_CATALOG,
  { ...CODEX_CATALOG, permissionModes: ["default", "acceptEdits", "plan", "fullAccess"] },
];

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** The error of a failed request, asserting its status. */
async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as { error: { code: string; message: string; details?: Json } }).error;
}

const assign = (as: TestClient, id: string) => as.request("POST", `/api/v1/work-sessions/${id}/assign`);
const preview = (as: TestClient, id: string) => as.request("GET", `/api/v1/work-sessions/${id}/assign`);
const _preview = (as: TestClient, id: string) => as.request("GET", `/api/v1/work-sessions/${id}/assign`);

const audits = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select user_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Array<{ user_id: string; metadata: Json }>;

const ownerOf = async (id: string) =>
  (await su.query("select created_by from app.work_sessions where id = $1", [id])).rows[0]
    .created_by as string;

const prompt = async (as: TestClient, id: string, body: string) =>
  (await ok(as.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body }))).id as string;

const promptStatus = async (id: string) =>
  (await su.query("select status from app.work_prompts where id = $1", [id])).rows[0].status as string;

const commandsOf = async (sessionId: string, kind: string) =>
  (
    await su.query(
      "select payload from app.device_commands where work_session_id = $1 and kind = $2 order by created_at",
      [sessionId, kind],
    )
  ).rows.map((r) => r.payload as Json);

const statusOf = async (id: string) =>
  (await su.query("select status from app.work_sessions where id = $1", [id])).rows[0].status as string;

const streamCount = async (topic: string) =>
  (await su.query("select count(*)::int as n from app.stream_events where stream_id = $1", [topic])).rows[0]
    .n as number;

/** A paired device that said hello with `host` (none = an older daemon) and announced `projects`. */
async function host(
  owner: TestClient,
  name: string,
  projects: string[],
  kind?: "desktop" | "service",
): Promise<Host> {
  const paired = await pairDevice(stack, owner, name);
  const device = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, kind ? { host: kind } : {});
  open.push(device);
  device.send({
    type: "projects.sync",
    projects: projects.map((p) => ({ localId: `lp_${p}`, name: p, gitRemote: null, defaultBranch: "main" })),
  });
  await device.next((f) => f.type === "projects.ack");
  await eventually(async () => {
    const r = await su.query("select host_kind from app.devices where id = $1", [paired.deviceId]);
    return r.rows[0].host_kind === (kind ?? null);
  });
  const rows = (await su.query("select id, name from app.projects where device_id = $1", [paired.deviceId]))
    .rows as Array<{ id: string; name: string }>;
  return {
    id: paired.deviceId,
    token: paired.token,
    device,
    repo: Object.fromEntries(rows.map((r) => [r.name, r.id])),
  };
}

interface Frame {
  op: string;
  topic?: string;
  type?: string;
  data?: unknown;
}

/** An authenticated /ws socket that records every frame. */
async function openSocket(as: TestClient) {
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await as.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as Frame));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sub = async (topic: string) => {
    socket.send(JSON.stringify({ op: "sub", topic }));
    await waitFor(() => frames.find((f) => f.op === "subscribed" && f.topic === topic));
  };
  return { frames, sub };
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.5 / 07.9 matrix pattern). */
async function moveToOrgB(userId: string) {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
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
}

beforeAll(async () => {
  // A closed server goes offline at once (its queued prompts then wait), not after the production grace.
  process.env.OCW_DEVICE_OFFLINE_GRACE_MS = "300";
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  ({ client: ana, userId: anaId } = await invite(
    stack,
    admin,
    "ana@example.test",
    "Ana Alvarez",
    "developer",
  ));
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia Perez", "developer"));
  ({ client: leo, userId: leoId } = await invite(stack, admin, "leo@example.test", "Leo Lopez", "developer"));
  ({ client: olga } = await invite(stack, admin, "olga@example.test", "Olga Ortiz", "developer"));
  const invited = await invite(stack, admin, "eve@example.test", "Eve", "developer");
  eve = invited.client;
  await moveToOrgB(invited.userId);

  srv = await host(admin, "Build server", ["checkout"], "service");
  srv.device.capabilities(FULL, true);
  await eventually(async () => {
    const r = await su.query("select full_access_opt_in, runtime_catalog from app.devices where id = $1", [
      srv.id,
    ]);
    return r.rows[0].full_access_opt_in === true && (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  await ok(admin.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true }));
  const checkout = await createTeamProject(stack, admin, {
    name: "Checkout",
    members: [{ userId: anaId }, { userId: piaId }, { userId: leoId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: checkout.unitId,
    projectId: srv.repo.checkout!,
    deviceId: srv.id,
    linkedBy: adminId,
  });
  await shareDevice(admin, srv.id, anaId, "acceptEdits");
  await shareDevice(admin, srv.id, piaId, "fullAccess");

  anaSrv = await host(ana, "Ana's server", ["notes"], "service");
  await shareDevice(ana, anaSrv.id, piaId);
  await shareDevice(ana, anaSrv.id, leoId);
  laptop = await host(ana, "Ana's laptop", ["scratch"], "desktop");
  await shareDevice(ana, laptop.id, piaId);
  legacy = await host(ana, "Old daemon", ["legacy"]);
  await shareDevice(ana, legacy.id, piaId);
  retired = await host(admin, "Retired server", ["retired"], "service");
  await shareDevice(admin, retired.id, anaId);
  await shareDevice(admin, retired.id, piaId);
}, 300_000);

afterAll(async () => {
  try {
    for (const s of sockets) s.close();
    for (const d of open) await d.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
    delete process.env.OCW_DEVICE_OFFLINE_GRACE_MS;
  }
});

// ---------------------------------------------------------------- Task 1: the takeover, end to end

describe("tracer: Ana takes over Pia's session on the build server (D-03, D-05, D-11, PD-02, PD-04)", () => {
  it("moves the owner, audits ids and labels only, and tells the session's stream and its readers live", async () => {
    const id = await startSession(pia, srv.device, srv.repo.checkout!, { title: "Login redirect" });
    const topic = `ws:${id}`;
    const anaSock = await openSocket(ana);
    await anaSock.sub(topic);
    const piaSock = await openSocket(pia);
    await piaSock.sub(`user:${piaId}`);

    const res = AssignWorkSessionResult.parse(await ok(assign(ana, id)));
    expect(res.session.createdBy).toBe(anaId);
    expect(res).toMatchObject({ removedCount: 0, cancelledPrompts: 0, settingsDowngraded: false });

    expect(await ownerOf(id)).toBe(anaId);
    const detail = await ok(ana.request("GET", `/api/v1/work-sessions/${id}`));
    expect(detail.session).toMatchObject({ createdBy: anaId, createdByName: "Ana Alvarez" });
    // Pia keeps it (project visibility) and now sees Ana as its owner.
    expect((await ok(pia.request("GET", `/api/v1/work-sessions/${id}`))).session.createdBy).toBe(anaId);

    // The creator stays in the history; one assigned row with ids, the host label and counts (never the title).
    expect((await audits("work_session.created", id)).map((r) => r.user_id)).toEqual([piaId]);
    const rows = await audits("work_session.assigned", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(anaId);
    expect(rows[0]!.metadata).toEqual({
      from: piaId,
      to: anaId,
      visibility: "project",
      hostKind: "service",
      deviceOwnerId: adminId,
      removedCount: 0,
      cancelledPrompts: 0,
      settingsDowngraded: false,
    });
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/Login redirect|Pia|Ana/);

    // `ws:`: the timeline event, then the invalidator, then the DTO naming the new owner.
    const events = (
      await su.query("select seq, type, payload from app.stream_events where stream_id = $1 order by seq", [
        topic,
      ])
    ).rows as Array<{ seq: number; type: string; payload: Json }>;
    const owned = events.filter(
      (e) => e.type === "work_session.event" && e.payload.event?.type === "session.owner_changed",
    );
    expect(owned.map((e) => e.payload.event)).toEqual([
      { type: "session.owner_changed", fromUserId: piaId, toUserId: anaId },
    ]);
    const changed = events.filter((e) => e.type === "work_session.visibility_changed");
    expect(changed.map((e) => e.payload)).toEqual([{ workSessionId: id }]);
    const lastDto = events.filter((e) => e.type === "work_session.updated").at(-1)!;
    expect(Number(owned[0]!.seq)).toBeLessThan(Number(changed[0]!.seq));
    expect(Number(changed[0]!.seq)).toBeLessThan(Number(lastDto.seq));
    expect(lastDto.payload.createdBy).toBe(anaId);

    // Live: Ana's open view gets the timeline line; Pia's lists get the new owner on her own topic.
    await waitFor(() =>
      anaSock.frames.find(
        (f) =>
          f.topic === topic &&
          f.type === "work_session.event" &&
          (f.data as Json)?.event?.type === "session.owner_changed",
      ),
    );
    await waitFor(() =>
      piaSock.frames.find(
        (f) =>
          f.topic === `user:${piaId}` &&
          f.type === "work_session.updated" &&
          (f.data as Json)?.id === id &&
          (f.data as Json)?.createdBy === anaId,
      ),
    );
    expect(piaSock.frames.some((f) => f.type === "work_session.removed")).toBe(false);
  });
});

describe("refusals (D-04, D-05, D-12): decided by the API, nothing written", () => {
  it("not a server, a bot's session, archived, a revoked device, no device use, outside the audience, another organization", async () => {
    const onLaptop = await startSession(ana, laptop.device, laptop.repo.scratch!, { title: "Laptop work" });
    const onLegacy = await startSession(ana, legacy.device, legacy.repo.legacy!, { title: "Old work" });
    const botSession = await startSession(ana, srv.device, srv.repo.checkout!, { title: "Bot work" });
    const archived = await startSession(ana, srv.device, srv.repo.checkout!, { title: "Done work" });
    const piaOwn = await startSession(pia, srv.device, srv.repo.checkout!, { title: "Pia's work" });
    const onRetired = await startSession(ana, retired.device, retired.repo.retired!, { title: "Retired" });

    const botId = (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
        [orgId],
      )
    ).rows[0].id as string;
    await su.query("update app.work_sessions set started_by_agent_id = $2 where id = $1", [
      botSession,
      botId,
    ]);
    await ok(ana.request("POST", `/api/v1/work-sessions/${archived}/archive`));
    await retired.device.close();
    await su.query("update app.devices set revoked_at = now() where id = $1", [retired.id]);

    const all = [onLaptop, onLegacy, botSession, archived, piaOwn, onRetired];
    const ownersBefore = await Promise.all(all.map(ownerOf));
    const streamsBefore = await Promise.all(all.map((id) => streamCount(`ws:${id}`)));

    expect((await fails(assign(pia, onLaptop), 409)).code).toBe("not_on_server");
    expect((await fails(assign(pia, onLegacy), 409)).code).toBe("not_on_server");
    expect((await fails(assign(pia, botSession), 409)).code).toBe("bot_session");
    expect((await fails(assign(pia, archived), 409)).code).toBe("archived");
    expect((await fails(assign(pia, onRetired), 409)).code).toBe("device_revoked");
    const notOnServer = await fails(assign(pia, onLaptop), 409);
    expect(notOnServer.message).toBe("Only sessions on a server can be assigned.");

    // Leo is in the project but may not use the build server: the device layer's own denial and sentence.
    const leoDenied = await fails(assign(leo, piaOwn), 403);
    expect(leoDenied.code).toBe("device_not_shared");
    expect(leoDenied.message).toBe("This device is not shared with you. Ask its owner to share it.");

    // Outside the audience, and another organization's admin: the 404 of a missing session.
    const missing = (await olga.request("POST", `/api/v1/work-sessions/${randomUUID()}/assign`)).body;
    expect((await olga.request("POST", `/api/v1/work-sessions/${piaOwn}/assign`)).body).toEqual(missing);
    await fails(assign(olga, piaOwn), 404);
    await fails(assign(eve, piaOwn), 404);
    await fails(assign(eve, onLaptop), 404);

    // Pia already owns hers: 200 with the session as it is, no audit, no event.
    const same = AssignWorkSessionResult.parse(await ok(assign(pia, piaOwn)));
    expect(same.session).toMatchObject({ id: piaOwn, createdBy: piaId });
    expect(same).toMatchObject({ removedCount: 0, cancelledPrompts: 0, settingsDowngraded: false });

    await settled(stack, orgId);
    expect(await Promise.all(all.map(ownerOf))).toEqual(ownersBefore);
    expect(await Promise.all(all.map((id) => streamCount(`ws:${id}`)))).toEqual(streamsBefore);
    for (const id of all) expect(await audits("work_session.assigned", id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- Task 2: no cut turn, cancellations, the preview

describe("the takeover never cuts a turn (D-05, D-13, PD-03)", () => {
  it("a running Full access turn by Pia finishes; the settings drop to Ana's cap between turns; Pia's queued prompt stays", async () => {
    const id = await startSession(pia, srv.device, srv.repo.checkout!, {
      title: "Migrate billing",
      permissionMode: "fullAccess",
    });
    const running = await prompt(pia, id, "run the migration");
    const cmd = await srv.device.command("prompt", id);
    srv.device.ack(cmd.id as string);
    srv.device.event(id, { type: "prompt.started", promptId: running });
    await eventually(async () => (await promptStatus(running)) === "running");
    const queued = await prompt(pia, id, "then the backfill");
    expect(await promptStatus(queued)).toBe("queued");

    const seen = AssignPreview.parse(await ok(preview(ana, id)));
    expect(seen).toEqual({
      allowed: true,
      reason: null,
      previousOwnerLosesAccess: false,
      othersLosingAccess: 0,
      cancelledPrompts: 0,
      turnRunning: true,
    });

    const res = AssignWorkSessionResult.parse(await ok(assign(ana, id)));
    expect(res).toMatchObject({ removedCount: 0, cancelledPrompts: 0, settingsDowngraded: true });
    expect(res.session.permissionMode).toBe("acceptEdits");

    // The device is told between turns, with the closed reason older daemons parse; never an interrupt.
    const configure = await srv.device.command("session.configure", id);
    expect(configure.payload).toEqual({
      settings: { permissionMode: "acceptEdits" },
      reason: "access_changed",
    });
    expect(await commandsOf(id, "interrupt")).toEqual([]);
    expect(await promptStatus(running)).toBe("running");
    expect(await promptStatus(queued)).toBe("queued");

    const [downgraded] = await audits("work_session.settings_downgraded", id);
    expect(downgraded!.user_id).toBe(anaId);
    expect(downgraded!.metadata).toMatchObject({ reason: "access_changed", cause: "owner_changed" });
    const [left] = await audits("work_session.full_access_left", id);
    expect(left!.metadata).toMatchObject({ from: "fullAccess", to: "acceptEdits", cause: "owner_changed" });
    expect((await audits("work_session.assigned", id))[0]!.metadata).toMatchObject({
      settingsDowngraded: true,
      cancelledPrompts: 0,
    });
    expect(await audits("work_prompt.cancelled", queued)).toEqual([]);
  });
});

describe("people who lose access by the transfer (D-13, D-15, PD-05)", () => {
  it("a people audience never re-adds the previous owner", async () => {
    const id = await startSession(pia, anaSrv.device, anaSrv.repo.notes!, { title: "Notes cleanup" });
    await setAudience(pia, id, { kind: "people", userIds: [leoId] });
    const res = AssignWorkSessionResult.parse(await ok(assign(ana, id)));
    expect(res.removedCount).toBe(1);
    expect((await pia.request("GET", `/api/v1/work-sessions/${id}`)).status).toBe(404);
    expect((await ok(leo.request("GET", `/api/v1/work-sessions/${id}`))).session.createdBy).toBe(anaId);
    const grants = await su.query(
      "select subject_id from app.work_session_grants where work_session_id = $1 and revoked_at is null",
      [id],
    );
    expect(grants.rows.map((r) => r.subject_id)).toEqual([leoId]);
  });

  it("an owner-only session on Ana's server: the preview writes nothing; the POST cancels Pia's queued prompts and tells her", async () => {
    const id = await startSession(pia, anaSrv.device, anaSrv.repo.notes!, { title: "Private notes" });
    await setAudience(pia, id, { kind: "owner" });
    const conversationId = (
      await su.query("select conversation_id from app.work_sessions where id = $1", [id])
    ).rows[0].conversation_id as string;
    // The server goes offline: Pia's prompts wait in the queue, nothing runs.
    await anaSrv.device.close();
    await eventually(async () => (await statusOf(id)) === "host_offline");
    const p1 = await prompt(pia, id, "first");
    const p2 = await prompt(pia, id, "second");
    expect([await promptStatus(p1), await promptStatus(p2)]).toEqual(["queued", "queued"]);

    // The detail: Ana may take it (she owns the server, so she sees it); Pia already owns it.
    expect((await ok(ana.request("GET", `/api/v1/work-sessions/${id}`))).assign).toEqual({
      allowed: true,
      reason: null,
    });
    expect((await ok(pia.request("GET", `/api/v1/work-sessions/${id}`))).assign).toEqual({
      allowed: false,
      reason: "already_owner",
    });

    const piaSock = await openSocket(pia);
    await piaSock.sub(`user:${piaId}`);
    await settled(stack, orgId);
    const snapshot = async () => ({
      owner: await ownerOf(id),
      audits: (await su.query("select count(*)::int as n from app.audit_events")).rows[0].n,
      prompts: (
        await su.query("select id, status from app.work_prompts where work_session_id = $1 order by id", [id])
      ).rows,
      commands: (await su.query("select count(*)::int as n from app.device_commands")).rows[0].n,
      notifications: (await su.query("select count(*)::int as n from app.notifications")).rows[0].n,
      seqs: (
        await su.query("select id, last_seq from app.streams where id = any($1::text[]) order by id", [
          [`ws:${id}`, `user:${anaId}`, `user:${piaId}`],
        ])
      ).rows,
      members: (
        await su.query(
          "select member_id, role from app.conversation_members where conversation_id = $1 order by member_id",
          [conversationId],
        )
      ).rows,
    });
    const before = await snapshot();
    const core = stack.built.core;
    const spies = [
      vi.spyOn(core.realtime, "appendEvent"),
      vi.spyOn(core.realtime, "publishEphemeral"),
      vi.spyOn(stack.built.deviceHub, "enqueue"),
      vi.spyOn(core.chatEvents, "messagePosted"),
    ];
    try {
      const seen = AssignPreview.parse(await ok(preview(ana, id)));
      expect(seen).toEqual({
        allowed: true,
        reason: null,
        previousOwnerLosesAccess: true,
        othersLosingAccess: 0,
        cancelledPrompts: 2,
        turnRunning: false,
      });
      await settled(stack, orgId);
      expect(spies.map((x) => x.mock.calls.length)).toEqual([0, 0, 0, 0]);
      expect(await snapshot()).toEqual(before);

      const res = AssignWorkSessionResult.parse(await ok(assign(ana, id)));
      expect(res).toMatchObject({ removedCount: 1, cancelledPrompts: 2, settingsDowngraded: false });
      await settled(stack, orgId);
      // The same spies see the POST's side effects (they are wired to what the routes call).
      expect(spies[0]!.mock.calls.length).toBeGreaterThan(0);
      expect(spies[1]!.mock.calls.length).toBeGreaterThan(0);
    } finally {
      for (const x of spies) x.mockRestore();
    }

    expect([await promptStatus(p1), await promptStatus(p2)]).toEqual(["cancelled", "cancelled"]);
    expect((await audits("work_prompt.cancelled", p1)).map((r) => r.metadata)).toEqual([
      { promptId: p1, authorUserId: piaId, cancelledBy: anaId, cause: "owner_changed" },
    ]);
    expect((await audits("work_prompt.cancelled", p2)).map((r) => r.user_id)).toEqual([anaId]);
    expect((await audits("work_session.assigned", id))[0]!.metadata).toEqual({
      from: piaId,
      to: anaId,
      visibility: "owner",
      hostKind: "service",
      deviceOwnerId: anaId,
      removedCount: 1,
      cancelledPrompts: 2,
      settingsDowngraded: false,
    });

    // Pia lost it: the 404 of a missing session, told on her own topic.
    expect((await pia.request("GET", `/api/v1/work-sessions/${id}`)).status).toBe(404);
    const removed = await waitFor(() =>
      piaSock.frames.find((f) => f.op === "eph" && f.type === "work_session.removed"),
    );
    expect(removed.data).toEqual({ id });
    // The conversation follows the owner.
    const members = (
      await su.query(
        "select member_id, role from app.conversation_members where conversation_id = $1 and member_kind = 'user'",
        [conversationId],
      )
    ).rows as Array<{ member_id: string; role: string }>;
    expect(Object.fromEntries(members.map((m) => [m.member_id, m.role]))).toEqual({
      [anaId]: "owner",
      [piaId]: "member",
    });
  });
});

describe("what the views read (PD-14)", () => {
  it("the detail says whether this viewer may assign; every DTO names its device's host kind; the preview refuses as the POST", async () => {
    const onServer = await startSession(pia, srv.device, srv.repo.checkout!, { title: "Server view" });
    const onLaptop = await startSession(ana, laptop.device, laptop.repo.scratch!, { title: "Laptop view" });
    const onLegacy = await startSession(ana, legacy.device, legacy.repo.legacy!, { title: "Legacy view" });

    expect((await ok(ana.request("GET", `/api/v1/work-sessions/${onServer}`))).assign).toEqual({
      allowed: true,
      reason: null,
    });
    expect((await ok(leo.request("GET", `/api/v1/work-sessions/${onServer}`))).assign).toEqual({
      allowed: false,
      reason: "device_not_shared",
    });
    expect((await ok(pia.request("GET", `/api/v1/work-sessions/${onLaptop}`))).assign).toEqual({
      allowed: false,
      reason: "not_on_server",
    });
    expect((await ok(pia.request("GET", `/api/v1/work-sessions/${onLegacy}`))).assign).toEqual({
      allowed: false,
      reason: "not_on_server",
    });

    expect(AssignPreview.parse(await ok(preview(pia, onLaptop)))).toEqual({
      allowed: false,
      reason: "not_on_server",
      previousOwnerLosesAccess: false,
      othersLosingAccess: 0,
      cancelledPrompts: 0,
      turnRunning: false,
    });
    await fails(preview(olga, onServer), 404);
    await fails(preview(eve, onServer), 404);

    const list = (await ok(pia.request("GET", "/api/v1/work-sessions"))).sessions as Json[];
    const kinds = Object.fromEntries(list.map((s) => [s.id as string, s.deviceHostKind]));
    expect(kinds[onServer]).toBe("service");
    expect(kinds[onLaptop]).toBe("desktop");
    expect(kinds[onLegacy]).toBeNull();
    for (const s of list) expect(s).toHaveProperty("deviceHostKind");
  });
});
