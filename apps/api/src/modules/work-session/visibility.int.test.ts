import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AuthContext } from "../../core";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  setAudience,
  shareDevice,
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

// ---------------------------------------------------------------- Task 2: the panel, who changes it, search, drafts

let gus: TestClient;
let gusId: string;
let lea: TestClient;
let leaId: string;
let ada: TestClient;
let adaId: string;
let tom: TestClient;
let tomId: string;
let max: TestClient;
let maxId: string;
let kim: TestClient;
let kimId: string;
let olgaId: string;
let eve: TestClient;
let eveId: string;
let eveUnit: string;
let portal: { unitId: string; parentId: string };
let web: string;
let mobile: string;
let ops: string;
/** Gus's session on `portal-web` (audience `project`), running on Ana's device. */
let s1: string;
/** Ana's session on her personal repo `notes`. */
let notesSession: string;
/** Kim's session on `portal-web`, before Kim leaves Portal. */
let kimSession: string;

const view = async (as: TestClient, id: string) =>
  ok(as.request("GET", `/api/v1/work-sessions/${id}/visibility`));

const put = (as: TestClient, id: string, body: unknown) =>
  as.request("PUT", `/api/v1/work-sessions/${id}/visibility`, body);

const names = (rows: Json[]) => rows.map((r) => r.name as string);

/** Organization B: Eve leaves A and becomes the admin of her own organization (as the 07.5 matrix does). */
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

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

const join = (unitId: string, userId: string, role: "member" | "lead" = "member") =>
  ok(admin.request("POST", `/api/v1/units/${unitId}/members`, { userId, role }));

describe("the panel, who may change it, search and drafts (D-04, D-11, D-12, D-13; R2–R4, R12)", () => {
  beforeAll(async () => {
    ({ client: gus, userId: gusId } = await invite(
      stack,
      admin,
      "gus@example.test",
      "Gus Garcia",
      "developer",
    ));
    ({ client: lea, userId: leaId } = await invite(stack, admin, "lea@example.test", "Lea Lund", "lead"));
    ({ client: ada, userId: adaId } = await invite(stack, admin, "ada@example.test", "Ada Admin", "admin"));
    ({ client: tom, userId: tomId } = await invite(
      stack,
      admin,
      "tom@example.test",
      "Tom Torres",
      "developer",
    ));
    ({ client: max, userId: maxId } = await invite(
      stack,
      admin,
      "max@example.test",
      "Max Moreno",
      "developer",
    ));
    ({ client: kim, userId: kimId } = await invite(
      stack,
      admin,
      "kim@example.test",
      "Kim Kowalski",
      "developer",
    ));
    olgaId = (await ok(olga.request("GET", "/api/v1/me"))).user.id;
    ({ client: eve, userId: eveId } = await invite(stack, admin, "eve@example.test", "Eve", "admin"));
    await moveToOrgB(eveId);
    eveUnit = (
      await ok(eve.request("POST", "/api/v1/units", { kind: "department", name: "Eve team", parentId: null }))
    ).id as string;

    portal = await createTeamProject(stack, admin, {
      name: "Portal",
      members: [
        { userId: anaId },
        { userId: piaId },
        { userId: leoId },
        { userId: gusId },
        { userId: kimId },
        { userId: adaId },
        { userId: leaId, role: "lead" },
      ],
    });
    web = await unit("team", "Web", portal.parentId);
    mobile = await unit("team", "Mobile", portal.parentId);
    ops = await unit("team", "Ops", portal.parentId);
    await join(web, tomId);
    await join(mobile, maxId);
    for (const t of [web, mobile]) {
      await ok(admin.request("POST", `/api/v1/work-projects/${portal.unitId}/teams`, { unitId: t }));
    }
    await linkRepo(stack, {
      organizationId: orgId,
      unitId: portal.unitId,
      projectId: repo["portal-web"]!,
      deviceId,
      linkedBy: adminId,
    });
    await shareDevice(ana, deviceId, gusId, "acceptEdits");
    await shareDevice(ana, deviceId, kimId, "acceptEdits");

    s1 = await startSession(gus, device, repo["portal-web"]!, { title: "Portal search" });
    notesSession = await startSession(ana, device, repo.notes!, { title: "Notes" });
    kimSession = await startSession(kim, device, repo["portal-web"]!, { title: "Kim's spike" });
  }, 120_000);

  it("a viewer who may not change it reads the whole panel: choices, teams, who sees it now and why (R2)", async () => {
    const v = await view(pia, s1);
    expect(v.kind).toBe("project");
    expect(v.projectDefault).toBe("project");
    expect(v.project).toEqual({ kind: "team", id: portal.unitId, name: "Portal" });
    expect(v.owner).toEqual({ userId: gusId, name: "Gus Garcia" });
    expect(v.viewerCan).toEqual({ change: false });
    expect(v.viewerState).toBeNull();
    expect(v.teams).toEqual([
      { id: mobile, name: "Mobile", kind: "team", memberCount: 1, selected: false, active: true },
      { id: web, name: "Web", kind: "team", memberCount: 1, selected: false, active: true },
    ]);
    expect(v.people).toEqual([]);
    expect((v.viewers.people as Json[]).map((p) => [p.name, p.reason, p.via?.name ?? null])).toEqual([
      ["Gus Garcia", "owner", null],
      ["Ana Alvarez", "device_owner", null],
      ["Ada Admin", "member", null],
      ["Kim Kowalski", "member", null],
      ["Lea Lund", "lead", null],
      ["Leo Lopez", "member", null],
      ["Max Moreno", "team", "Mobile"],
      ["Pia Perez", "member", null],
      ["Tom Torres", "team", "Web"],
    ]);
    expect(v.viewers.more).toBe(0);
    // The count is the people the rule lets read it, minus admins who see it only for being admins (Víctor).
    const everyone: Array<[TestClient, string]> = [
      [admin, adminId],
      [ana, anaId],
      [pia, piaId],
      [leo, leoId],
      [olga, olgaId],
      [gus, gusId],
      [lea, leaId],
      [ada, adaId],
      [tom, tomId],
      [max, maxId],
      [kim, kimId],
    ];
    const reading: string[] = [];
    for (const [as, id] of everyone) {
      if ((await as.request("GET", `/api/v1/work-sessions/${s1}`)).status === 200) reading.push(id);
    }
    expect(reading.filter((id) => id !== adminId).sort()).toEqual(
      (v.viewers.people as Json[]).map((p) => p.userId as string).sort(),
    );
    expect(v.viewers.count).toBe(reading.length - 1);
    // The device owner (not the creator) always sees it (D-11); she is told it is her.
    expect(v.alwaysVisible).toEqual({
      admins: true,
      deviceOwner: { userId: anaId, firstName: "Ana", deviceName: "Ana's MacBook", isViewer: false },
    });
    expect((await view(ana, s1)).alwaysVisible.deviceOwner.isViewer).toBe(true);
  });

  it("a personal session: no project default, the device as the project, no teams, the device's users", async () => {
    const v = await view(ana, notesSession);
    expect(v.projectDefault).toBeNull();
    expect(v.project).toEqual({ kind: "personal", deviceName: "Ana's MacBook" });
    expect(v.teams).toEqual([]);
    expect(v.alwaysVisible.deviceOwner).toBeNull();
    expect(v.viewerCan).toEqual({ change: true });
    expect((v.viewers.people as Json[]).map((p) => [p.name, p.reason, p.via])).toEqual([
      ["Ana Alvarez", "owner", null],
      ["Gus Garcia", "device", { id: deviceId, name: "Ana's MacBook" }],
      ["Kim Kowalski", "device", { id: deviceId, name: "Ana's MacBook" }],
    ]);
  });

  it("the creator, a project lead who sees it and an admin change it; a member gets 403; an outsider 404", async () => {
    await setAudience(gus, s1, { kind: "project" });
    expect((await setAudience(lea, s1, { kind: "teams", teamIds: [web] })).visibility.kind).toBe("teams");
    expect((await setAudience(admin, s1, { kind: "project" })).visibility.kind).toBe("project");
    const denied = await fails(put(leo, s1, { kind: "owner" }), 403);
    expect(denied.details).toMatchObject({ permission: "work_session.visibility" });
    expect((await fails(put(olga, s1, { kind: "owner" }), 404)).code).toBe("not_found");
    expect((await view(lea, s1)).viewerCan).toEqual({ change: true });
    expect((await view(admin, s1)).viewerCan).toEqual({ change: true });
    // The device owner always sees it but does not choose its audience.
    expect((await view(ana, s1)).viewerCan).toEqual({ change: false });
  });

  it("refuses entries outside the project with their ids only, org B's ids included (never a 500)", async () => {
    const outside = await fails(put(gus, s1, { kind: "people", userIds: [piaId, olgaId, adminId] }), 422);
    expect(outside.code).toBe("audience_outside_project");
    expect(outside.details).toEqual({ ids: [olgaId, adminId] });
    expect(JSON.stringify(outside)).not.toMatch(/Olga|Víctor/);
    const team = await fails(put(gus, s1, { kind: "teams", teamIds: [web, ops] }), 422);
    expect(team).toMatchObject({ code: "team_not_assigned", details: { ids: [ops] } });
    expect(await fails(put(ana, notesSession, { kind: "teams", teamIds: [web] }), 422)).toMatchObject({
      code: "team_not_assigned",
      details: { ids: [web] },
    });
    expect(await fails(put(gus, s1, { kind: "teams", teamIds: [eveUnit] }), 422)).toMatchObject({
      code: "team_not_assigned",
      details: { ids: [eveUnit] },
    });
    expect(await fails(put(gus, s1, { kind: "people", userIds: [eveId] }), 422)).toMatchObject({
      code: "audience_outside_project",
      details: { ids: [eveId] },
    });
    // Nothing changed.
    expect((await view(gus, s1)).kind).toBe("project");
    // A personal session takes the people who use the device.
    expect(
      (await setAudience(ana, notesSession, { kind: "people", userIds: [kimId] })).visibility.people,
    ).toEqual([{ userId: kimId, name: "Kim Kowalski", avatarUrl: null, active: true }]);
    await fails(put(ana, notesSession, { kind: "people", userIds: [piaId] }), 422);
    await setAudience(ana, notesSession, { kind: "project" });
  });

  it("people search: editors only, project access only, never the owner or the device owner, at most 10", async () => {
    const found = await ok(gus.request("GET", `/api/v1/work-sessions/${s1}/visibility/people?q=le`));
    expect(names(found.people)).toEqual(["Lea Lund", "Leo Lopez"]);
    const all = await ok(gus.request("GET", `/api/v1/work-sessions/${s1}/visibility/people`));
    expect(names(all.people)).toEqual([
      "Ada Admin",
      "Kim Kowalski",
      "Lea Lund",
      "Leo Lopez",
      "Max Moreno",
      "Pia Perez",
      "Tom Torres",
    ]);
    await fails(leo.request("GET", `/api/v1/work-sessions/${s1}/visibility/people?q=le`), 403);
    await fails(olga.request("GET", `/api/v1/work-sessions/${s1}/visibility/people?q=le`), 404);
    const personal = await ok(ana.request("GET", `/api/v1/work-sessions/${notesSession}/visibility/people`));
    expect(names(personal.people)).toEqual(["Gus Garcia", "Kim Kowalski"]);
  });

  it("a draft: search and preview for whoever could start there; the preview equals the session it would make", async () => {
    const P = `/api/v1/projects/${repo["portal-web"]}/audience`;
    expect(names((await ok(gus.request("GET", `${P}/people?q=TO`))).people)).toEqual(["Tom Torres"]);
    // A project member who cannot use the device, and an outsider, cannot start there: 404.
    await fails(leo.request("GET", `${P}/people`), 404);
    await fails(olga.request("GET", `${P}/people`), 404);
    expect(
      names((await ok(ana.request("GET", `/api/v1/projects/${repo.notes}/audience/people`))).people),
    ).toEqual(["Gus Garcia", "Kim Kowalski"]);
    await fails(pia.request("GET", `/api/v1/projects/${repo.notes}/audience/people`), 404);

    const preview = await ok(gus.request("GET", `${P}/preview?kind=people&userIds=${piaId}`));
    expect(preview.count).toBe(3);
    expect(names(preview.people)).toEqual(["Gus Garcia", "Ana Alvarez", "Pia Perez"]);
    expect(preview.alwaysVisible).toEqual({
      admins: true,
      deviceOwner: { userId: anaId, firstName: "Ana", deviceName: "Ana's MacBook", isViewer: false },
    });
    // The same audience on a real session gives the same people.
    await setAudience(gus, s1, { kind: "people", userIds: [piaId] });
    expect((await view(gus, s1)).viewers.count).toBe(preview.count);
    await setAudience(gus, s1, { kind: "project" });
    expect((await ok(gus.request("GET", `${P}/preview?kind=project`))).count).toBe(
      (await view(gus, s1)).viewers.count,
    );
    const teams = await ok(gus.request("GET", `${P}/preview?kind=teams&teamIds=${web},${mobile}`));
    expect(names(teams.people)).toEqual(["Gus Garcia", "Ana Alvarez", "Max Moreno", "Tom Torres"]);
    expect((await ok(gus.request("GET", `${P}/preview?kind=owner`))).count).toBe(2);
    expect(await fails(gus.request("GET", `${P}/preview?kind=people&userIds=${olgaId}`), 422)).toMatchObject({
      code: "audience_outside_project",
      details: { ids: [olgaId] },
    });
    expect((await fails(gus.request("GET", `${P}/preview?kind=teams`), 400)).code).toBe("invalid_audience");
    await fails(leo.request("GET", `${P}/preview?kind=project`), 404);
    // Nothing a draft wrote survives it.
    expect(
      (await su.query("select count(*)::int as n from app.work_sessions where title = 'Draft'")).rows[0].n,
    ).toBe(0);
  });

  it("the detail: viewerCan carries work_session.visibility for an editor only", async () => {
    const mine = await ok(gus.request("GET", `/api/v1/work-sessions/${s1}`));
    expect(mine.viewerCan).toContain("work_session.visibility");
    expect(mine.viewerState).toBeNull();
    const member = await ok(leo.request("GET", `/api/v1/work-sessions/${s1}`));
    expect(member.viewerCan).not.toContain("work_session.visibility");
  });

  it("an admin who sees it only as an admin leaves one audit row per detail open; lists, streams and members none", async () => {
    const before = (await audits("work_session.viewed_as_admin", s1)).length;
    await ok(admin.request("GET", `/api/v1/work-sessions/${s1}`));
    await ok(admin.request("GET", `/api/v1/work-sessions/${s1}`));
    const rows = await audits("work_session.viewed_as_admin", s1);
    expect(rows.length - before).toBe(2);
    expect(rows.at(-1)!.user_id).toBe(adminId);
    expect(JSON.stringify(rows.at(-1)!.metadata ?? {})).not.toMatch(/Portal|search/);
    await ok(admin.request("GET", "/api/v1/work-sessions"));
    await view(admin, s1);
    expect(
      await stack.built.core.realtime.authorizeTopic(
        { userId: adminId, organizationId: orgId } as AuthContext,
        `ws:${s1}`,
      ),
    ).toBe(true);
    // Ada is an admin and a project member: a viewer, never audited for it.
    await ok(ada.request("GET", `/api/v1/work-sessions/${s1}`));
    expect((await audits("work_session.viewed_as_admin", s1)).length - before).toBe(2);
  });

  it("selected teams no longer assigned and chosen people who left show inactive; a creator who left reads and archives only (D-12)", async () => {
    await setAudience(gus, s1, { kind: "teams", teamIds: [mobile] });
    const s4 = await startSession(gus, device, repo["portal-web"]!, { title: "Pairing" });
    await setAudience(gus, s4, { kind: "people", userIds: [kimId, piaId] });

    await ok(admin.request("DELETE", `/api/v1/work-projects/${portal.unitId}/teams/${mobile}`));
    await ok(admin.request("DELETE", `/api/v1/units/${portal.unitId}/members/${kimId}`));
    try {
      const teams = (await view(gus, s1)).teams as Json[];
      expect(teams.map((t) => [t.name, t.selected, t.active])).toEqual([
        ["Web", false, true],
        ["Mobile", true, false],
      ]);
      expect((await view(gus, s4)).people).toEqual([
        { userId: kimId, name: "Kim Kowalski", avatarUrl: null, active: false },
        { userId: piaId, name: "Pia Perez", avatarUrl: null, active: true },
      ]);

      // Kim created kimSession and left Portal: read and archive only.
      const detail = await ok(kim.request("GET", `/api/v1/work-sessions/${kimSession}`));
      expect(detail.viewerState).toBe("left_project");
      expect(detail.viewerCan).toContain("work_session.archive");
      expect(detail.viewerCan).not.toContain("work_session.prompt");
      expect(detail.viewerCan).not.toContain("work_session.visibility");
      const v = await view(kim, kimSession);
      expect(v.viewerState).toBe("left_project");
      expect(v.viewerCan).toEqual({ change: false });
      expect((v.viewers.people as Json[])[0]).toMatchObject({ userId: kimId, reason: "owner_left" });
      expect((await fails(put(kim, kimSession, { kind: "owner" }), 403)).code).toBe("left_project");
    } finally {
      await ok(admin.request("POST", `/api/v1/work-projects/${portal.unitId}/teams`, { unitId: mobile }));
      await join(portal.unitId, kimId);
    }
  });

  it("org B reaches none of it: every visibility and audience route answers 404 and changes nothing", async () => {
    const S = `/api/v1/work-sessions/${s1}/visibility`;
    const P = `/api/v1/projects/${repo["portal-web"]}/audience`;
    const cases: Record<string, () => Promise<unknown>> = {
      "GET /api/v1/work-sessions/:id/visibility": () => fails(eve.request("GET", S), 404),
      "PUT /api/v1/work-sessions/:id/visibility": () => fails(eve.request("PUT", S, { kind: "owner" }), 404),
      "GET /api/v1/work-sessions/:id/visibility/people": () => fails(eve.request("GET", `${S}/people`), 404),
      "GET /api/v1/projects/:projectId/audience/people": () => fails(eve.request("GET", `${P}/people`), 404),
      "GET /api/v1/projects/:projectId/audience/preview": () =>
        fails(eve.request("GET", `${P}/preview?kind=project`), 404),
    };
    // Every route of the family is in the matrix (registry-derived, as 04's).
    const family = [...stack.built.authz.routes.keys()]
      .filter((k) => k.includes("/api/v1/work-sessions/:id/visibility") || k.includes("/audience/"))
      .sort();
    expect(family).toEqual(Object.keys(cases).sort());
    const before = (await view(gus, s1)).kind;
    for (const run of Object.values(cases)) await run();
    expect((await view(gus, s1)).kind).toBe(before);
  });
});
