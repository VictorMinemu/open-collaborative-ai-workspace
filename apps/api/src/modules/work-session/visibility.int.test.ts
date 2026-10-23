import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  setAudience,
  startSession,
} from "../../testing-workzone";

/**
 * Phase 07.9-06 (D-03, D-04, D-11, D-12, D-13; P-02 R2–R4, R12; P-09, P-12, P-13): the session audience through the
 * API. One PUT changes it at once (stored grants, audit with ids and counts, `work_session.removed` to the people it
 * removed, their live `ws:` view revoked); one view names who can see the session now and why; drafts preview; admin-only
 * opens are audited. Real PostgreSQL and Redis.
 *
 * Organization A. Víctor (admin, in no project). Ana (developer) owns "Ana's MacBook" with three repositories:
 * `checkout` (team project Checkout: Ana, Pia, Leo), `portal-web` (team project Portal) and `notes` (personal).
 * Portal: Ana, Pia, Leo and Gus (members; Gus also uses Ana's device), Lea (lead role, project lead), Ada (admin and
 * member); teams Web (Tom) and Mobile (Max) assigned. Olga (developer) is in nothing. Organization B: Eve (admin).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

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
let device: FakeDevice;
let deviceId: string;
const repo: Record<string, string> = {};
let checkout: { unitId: string; parentId: string };
const sockets: WebSocket[] = [];

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

const listIds = async (as: TestClient) =>
  ((await ok(as.request("GET", "/api/v1/work-sessions"))).sessions as Json[]).map((s) => s.id as string);

const audits = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select user_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Array<{ user_id: string; metadata: Json }>;

interface Frame {
  op: string;
  topic?: string;
  type?: string;
  data?: unknown;
  reason?: string;
}

/** An authenticated /ws socket that records every frame with its arrival time. */
async function openSocket(as: TestClient) {
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await as.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  sockets.push(socket);
  const frames: Array<Frame & { at: number }> = [];
  socket.on("message", (m) => frames.push({ ...(JSON.parse(String(m)) as Frame), at: Date.now() }));
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

beforeAll(async () => {
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

  const paired = await pairDevice(stack, ana, "Ana's MacBook");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: ["checkout", "portal-web", "notes"].map((name) => ({
      localId: `lp_${name}`,
      name,
      gitRemote: null,
      defaultBranch: "main",
    })),
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  for (const r of (await su.query("select id, name from app.projects where device_id = $1", [deviceId]))
    .rows) {
    repo[r.name as string] = r.id as string;
  }

  checkout = await createTeamProject(stack, admin, {
    name: "Checkout",
    members: [{ userId: anaId }, { userId: piaId }, { userId: leoId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: checkout.unitId,
    projectId: repo.checkout!,
    deviceId,
    linkedBy: adminId,
  });
}, 240_000);

afterAll(async () => {
  try {
    for (const s of sockets) s.close();
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: narrow a session, end to end

describe("tracer: narrowing a session applies at once (D-04, ADR-0009, P-09)", () => {
  it("Ana narrows to Pia: stored grant, audit with counts, Leo loses it everywhere at once; back to Project restores him", async () => {
    const id = await startSession(ana, device, repo.checkout!, { title: "Checkout redesign" });
    const topic = `ws:${id}`;
    expect((await ok(leo.request("GET", `/api/v1/work-sessions/${id}`))).session.id).toBe(id);

    const leoSock = await openSocket(leo);
    await leoSock.sub(`user:${leoId}`);
    await leoSock.sub(topic);
    const piaSock = await openSocket(pia);
    await piaSock.sub(`user:${piaId}`);

    const res = await setAudience(ana, id, { kind: "people", userIds: [piaId] });
    const putAt = Date.now();
    expect(res.removedCount).toBe(1);
    expect(res.removedNames).toEqual(["Leo Lopez"]);
    expect(res.visibility.kind).toBe("people");

    // Stored: the session's kind and exactly one active user grant, for Pia.
    expect((await su.query("select visibility from app.work_sessions where id = $1", [id])).rows[0]).toEqual({
      visibility: "people",
    });
    const active = await su.query(
      "select subject_kind, subject_id, granted_by from app.work_session_grants where work_session_id = $1 and revoked_at is null",
      [id],
    );
    expect(active.rows).toEqual([{ subject_kind: "user", subject_id: piaId, granted_by: anaId }]);

    // Leo: the 404 of a missing session, absent from his list; Pia keeps it.
    const hidden = await leo.request("GET", `/api/v1/work-sessions/${id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual((await leo.request("GET", `/api/v1/work-sessions/${randomUUID()}`)).body);
    expect(await listIds(leo)).not.toContain(id);
    expect((await pia.request("GET", `/api/v1/work-sessions/${id}`)).status).toBe(200);

    // Live: Leo is told on his own topic (ids only) and loses the session's stream within a second.
    const removed = await waitFor(() =>
      leoSock.frames.find((f) => f.op === "eph" && f.type === "work_session.removed"),
    );
    expect(removed).toMatchObject({ topic: `user:${leoId}`, data: { id } });
    expect(Object.keys(removed.data as Json)).toEqual(["id"]);
    const revoked = await waitFor(
      () => leoSock.frames.find((f) => f.op === "revoked" && f.topic === topic),
      1000,
    );
    expect(revoked.at - putAt).toBeLessThan(1000);
    expect(piaSock.frames.some((f) => f.type === "work_session.removed")).toBe(false);

    // The durable notice on the session's own stream carries the id only.
    const changed = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.visibility_changed'",
      [topic],
    );
    expect(changed.rows.map((r) => r.payload)).toEqual([{ workSessionId: id }]);

    // Audited with ids and counts, never a name.
    const rows = await audits("work_session.visibility_changed", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(anaId);
    expect(rows[0]!.metadata).toEqual({
      from: "project",
      to: "people",
      teamCount: 0,
      peopleCount: 1,
      removedCount: 1,
    });
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/Leo|Pia/);

    // Undo is a second PUT: back to Project soft-revokes Pia's grant (the row stays) and restores Leo.
    const back = await setAudience(ana, id, { kind: "project" });
    expect(back.removedCount).toBe(0);
    expect(back.removedNames).toEqual([]);
    const grants = await su.query(
      "select subject_id, revoked_at is not null as revoked, revoked_by from app.work_session_grants where work_session_id = $1",
      [id],
    );
    expect(grants.rows).toEqual([{ subject_id: piaId, revoked: true, revoked_by: anaId }]);
    expect((await leo.request("GET", `/api/v1/work-sessions/${id}`)).status).toBe(200);
    expect(await listIds(leo)).toContain(id);
    expect((await audits("work_session.visibility_changed", id)).map((r) => r.metadata)).toEqual([
      { from: "project", to: "people", teamCount: 0, peopleCount: 1, removedCount: 1 },
      { from: "people", to: "project", teamCount: 0, peopleCount: 0, removedCount: 0 },
    ]);
  });

  it("the same audience again changes nothing and audits nothing; an outsider gets the 404 of a missing session", async () => {
    const id = await startSession(ana, device, repo.checkout!, { title: "Coupons" });
    const same = await setAudience(ana, id, { kind: "project" });
    expect(same.removedCount).toBe(0);
    expect(await audits("work_session.visibility_changed", id)).toEqual([]);
    const err = await fails(
      olga.request("PUT", `/api/v1/work-sessions/${id}/visibility`, { kind: "owner" }),
      404,
    );
    expect(err.code).toBe("not_found");
    expect((await su.query("select visibility from app.work_sessions where id = $1", [id])).rows[0]).toEqual({
      visibility: "project",
    });
  });
});
