import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../core";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice, type Frame } from "../../testing-device";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  errorCode,
  invite,
  linkRepo,
  pairDevice,
  shareDevice,
  startSession,
} from "../../testing-workzone";
import { sessionFactsForUsers } from "./facts";

/**
 * Phase 07.9-05 (D-04, D-05, D-06, D-09, D-11, D-12; C-01, P-03, P-04): the flip. One SQL rule
 * (`app.work_session_access`) reaches the resolver through one facts helper, and every reader of a session asks it: the
 * list, the detail, every `/work-sessions/:id…` route, the attachments of its conversation and the `ws:` topic. Someone
 * outside the audience gets the 404 of a missing session everywhere; seeing is not controlling. Real PostgreSQL, Redis
 * and Garage.
 *
 * Cast: Víctor (admin), Ana (developer, owns "Ana's MacBook" with the personal repo `notes` and the repo
 * `billing-api` linked to the team project Billing), Gus (developer, a user grant on Ana's device, Billing member),
 * Pia (developer, Billing member, no device access), Olga (developer, nothing).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };
type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

let storage: TestStorage;
let stack: TestStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let adminId: string;
let ana: TestClient;
let anaId: string;
let gus: TestClient;
let gusId: string;
let pia: TestClient;
let piaId: string;
let olga: TestClient;
let olgaId: string;
let device: FakeDevice;
let deviceId: string;
let notesId: string;
let billingId: string;
let billing: { unitId: string; parentId: string };
/** Ana's session on her personal repo (audience `project`, the D-06 default). */
let personal: string;
/** Gus's session on the linked repo (team project Billing), running on Ana's device. */
let team: string;

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const authOf = (userId: string, organizationId = orgId) => ({ userId, organizationId }) as AuthContext;
const canFollow = (userId: string, sessionId: string, organizationId = orgId) =>
  stack.built.core.realtime.authorizeTopic(authOf(userId, organizationId), `ws:${sessionId}`);

const listIds = async (as: TestClient, archived = false) =>
  (
    (await ok(as.request("GET", `/api/v1/work-sessions${archived ? "?archived=1" : ""}`))).sessions as Json[]
  ).map((s) => s.id as string);

/** A request that does not follow redirects (the attachment routes answer 302 to a presigned URL). */
function raw(client: TestClient, path: string) {
  return fetch(`${stack.baseUrl}${path}`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: client.cookieHeader },
  });
}

const presign = (client: TestClient, conv: string, size: number) =>
  client.request("POST", `/api/v1/conversations/${conv}/attachments`, {
    filename: "screen.jpg",
    contentType: "image/jpeg",
    size,
  });

/** Set a session's stored audience as the system would (the visibility API arrives in 07.9-06). */
const setVisibility = (sessionId: string, visibility: "owner" | "project") =>
  su.query("update app.work_sessions set visibility = $2 where id = $1", [sessionId, visibility]);

/** The device's next command of `kind` for `sessionId`, acknowledged. */
async function command(kind: string, sessionId: string): Promise<Cmd> {
  const cmd = (await device.command(kind, sessionId)) as Cmd;
  device.ack(cmd.id);
  return cmd;
}

/** A pending approval on `sessionId`, requested by the device during a running prompt sent by `as`. */
async function pendingApproval(as: TestClient, sessionId: string): Promise<string> {
  await ok(as.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: "needs a tool" }));
  const cmd = await command("prompt", sessionId);
  device.event(sessionId, { type: "prompt.started", promptId: cmd.payload.promptId });
  const approvalId = randomUUID();
  device.event(sessionId, {
    type: "approval.requested",
    approvalId,
    tool: "Edit",
    summary: "Edit src/app.ts",
    paths: ["src/app.ts"],
  });
  device.event(sessionId, { type: "session.state", status: "waiting_approval" });
  await eventually(async () => {
    const d = await ok(as.request("GET", `/api/v1/work-sessions/${sessionId}`));
    return (d.approvals as Json[]).some((a) => a.id === approvalId);
  });
  return approvalId;
}

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    stack = await startTestStack({ env: storage.env });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  ({ client: ana, userId: anaId } = await invite(stack, admin, "ana@example.test", "Ana", "developer"));
  ({ client: gus, userId: gusId } = await invite(stack, admin, "gus@example.test", "Gus", "developer"));
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia", "developer"));
  ({ client: olga, userId: olgaId } = await invite(stack, admin, "olga@example.test", "Olga", "developer"));

  const paired = await pairDevice(stack, ana, "Ana's MacBook");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [
      { localId: "lp_notes", name: "notes", gitRemote: null, defaultBranch: "main" },
      { localId: "lp_billing", name: "billing-api", gitRemote: null, defaultBranch: "main" },
    ],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  const repos = (await ok(ana.request("GET", "/api/v1/projects"))).projects as Json[];
  notesId = repos.find((p) => p.name === "notes")!.id;
  billingId = repos.find((p) => p.name === "billing-api")!.id;

  await shareDevice(ana, deviceId, gusId, "acceptEdits");
  billing = await createTeamProject(stack, admin, {
    name: "Billing",
    members: [{ userId: anaId }, { userId: gusId }, { userId: piaId }],
  });
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: billing.unitId,
    projectId: billingId,
    deviceId,
    linkedBy: adminId,
  });

  personal = await startSession(ana, device, notesId, { title: "Notes cleanup" });
  team = await startSession(gus, device, billingId, { title: "Invoice export" });
}, 240_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
    await storage?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the rule decides a real session

describe("the rule decides a real session: detail, list and ws: (D-04, D-06, D-11)", () => {
  it("a personal session: its creator and device owner, a device grantee and the admin see it; others do not", async () => {
    for (const [name, as, id] of [
      ["Ana", ana, () => anaId],
      ["Gus", gus, () => gusId],
      ["Víctor", admin, () => adminId],
    ] as const) {
      expect((await as.request("GET", `/api/v1/work-sessions/${personal}`)).status, name).toBe(200);
      expect(await listIds(as), name).toContain(personal);
      expect(await canFollow(id(), personal), name).toBe(true);
    }
    for (const [name, as, id] of [
      ["Olga", olga, () => olgaId],
      ["Pia", pia, () => piaId],
    ] as const) {
      const res = await as.request("GET", `/api/v1/work-sessions/${personal}`);
      expect(res.status, name).toBe(404);
      // Exactly the answer for a session that does not exist.
      const missing = await as.request("GET", `/api/v1/work-sessions/${randomUUID()}`);
      expect(res.body, name).toEqual(missing.body);
      expect(await listIds(as), name).not.toContain(personal);
      expect(await canFollow(id(), personal), name).toBe(false);
    }
  });

  it("a team-project session: project members (even without the device) see it; outsiders do not", async () => {
    for (const [name, as, id] of [
      ["Gus", gus, () => gusId],
      ["Ana", ana, () => anaId],
      ["Pia", pia, () => piaId],
      ["Víctor", admin, () => adminId],
    ] as const) {
      expect((await as.request("GET", `/api/v1/work-sessions/${team}`)).status, name).toBe(200);
      expect(await listIds(as), name).toContain(team);
      expect(await canFollow(id(), team), name).toBe(true);
    }
    expect((await olga.request("GET", `/api/v1/work-sessions/${team}`)).status).toBe(404);
    expect(await listIds(olga)).not.toContain(team);
    expect(await canFollow(olgaId, team)).toBe(false);
  });

  it("`owner` hides it from the project and keeps it for the creator, the device owner and the admin", async () => {
    await setVisibility(team, "owner");
    try {
      expect((await pia.request("GET", `/api/v1/work-sessions/${team}`)).status).toBe(404);
      expect(await listIds(pia)).not.toContain(team);
      expect(await canFollow(piaId, team)).toBe(false);
      for (const [name, as, id] of [
        ["Gus (creator)", gus, () => gusId],
        ["Ana (device owner)", ana, () => anaId],
        ["Víctor (admin)", admin, () => adminId],
      ] as const) {
        expect((await as.request("GET", `/api/v1/work-sessions/${team}`)).status, name).toBe(200);
        expect(await listIds(as), name).toContain(team);
        expect(await canFollow(id(), team), name).toBe(true);
      }
      // The list DTO says so (UI-SPEC R1): `owner` differs from the project's default.
      const row = ((await ok(gus.request("GET", "/api/v1/work-sessions"))).sessions as Json[]).find(
        (s) => s.id === team,
      );
      expect(row?.visibility).toEqual({
        kind: "owner",
        activeCount: 0,
        differsFromDefault: true,
        firstTeamName: null,
      });
    } finally {
      await setVisibility(team, "project");
    }
    expect((await pia.request("GET", `/api/v1/work-sessions/${team}`)).status).toBe(200);
  });

  it("every session DTO carries its audience summary and team project (R1)", async () => {
    const sessions = (await ok(admin.request("GET", "/api/v1/work-sessions"))).sessions as Json[];
    const t = sessions.find((s) => s.id === team)!;
    expect(t.visibility).toEqual({
      kind: "project",
      activeCount: 0,
      differsFromDefault: false,
      firstTeamName: null,
    });
    expect(t.teamProject).toEqual({ id: billing.unitId, name: "Billing" });
    const p = sessions.find((s) => s.id === personal)!;
    expect(p.visibility).toEqual({
      kind: "project",
      activeCount: 0,
      differsFromDefault: false,
      firstTeamName: null,
    });
    expect(p.teamProject).toBeNull();
    // The detail carries the same summary.
    const detail = await ok(pia.request("GET", `/api/v1/work-sessions/${team}`));
    expect(detail.session.teamProject).toEqual({ id: billing.unitId, name: "Billing" });
  });
});

// ---------------------------------------------------------------- Task 2: every reader and control path

describe("every reader asks the same rule; seeing is not controlling (D-05, D-09)", () => {
  let approvalId: string;
  let queuedPromptId: string;
  let attachmentId: string;
  let conv: string;
  let jpegSize: number;

  beforeAll(async () => {
    // A pending approval (Gus prompts, the device asks for a tool), then a queued prompt behind it.
    approvalId = await pendingApproval(gus, team);
    const queued = await ok(
      gus.request("POST", `/api/v1/work-sessions/${team}/prompts`, { body: "after that" }),
    );
    queuedPromptId = queued.id as string;
    expect(queued.status).toBe("queued");
    // An image sent with a prompt by the creator, in the session's conversation.
    conv = (await ok(gus.request("GET", `/api/v1/work-sessions/${team}`))).session.conversationId;
    const jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();
    jpegSize = jpeg.length;
    const p = await ok(presign(gus, conv, jpeg.length));
    const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: jpeg });
    expect(put.status).toBe(200);
    attachmentId = (await ok(gus.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`))).id;
    await ok(
      gus.request("POST", `/api/v1/work-sessions/${team}/prompts`, {
        body: "see image",
        attachmentIds: [attachmentId],
      }),
    );
  }, 60_000);

  /** Every route of a session, as `as` calls it. */
  const routes = (as: TestClient): Array<[string, () => Promise<{ status: number }>]> => [
    ["GET detail", () => as.request("GET", `/api/v1/work-sessions/${team}`)],
    ["POST prompts", () => as.request("POST", `/api/v1/work-sessions/${team}/prompts`, { body: "hi" })],
    [
      "POST commands",
      () => as.request("POST", `/api/v1/work-sessions/${team}/commands`, { text: "/compact" }),
    ],
    [
      "PATCH prompt",
      () =>
        as.request("PATCH", `/api/v1/work-sessions/${team}/prompts/${queuedPromptId}`, { body: "edited" }),
    ],
    ["DELETE prompt", () => as.request("DELETE", `/api/v1/work-sessions/${team}/prompts/${queuedPromptId}`)],
    ["POST interrupt", () => as.request("POST", `/api/v1/work-sessions/${team}/interrupt`)],
    [
      "POST approval",
      () => as.request("POST", `/api/v1/work-sessions/${team}/approvals/${approvalId}`, { decision: "once" }),
    ],
    ["GET controls", () => as.request("GET", `/api/v1/work-sessions/${team}/controls`)],
    [
      "PATCH settings",
      () => as.request("PATCH", `/api/v1/work-sessions/${team}/settings`, { model: "sonnet" }),
    ],
    ["POST archive", () => as.request("POST", `/api/v1/work-sessions/${team}/archive`)],
    ["presign attachment", () => presign(as, conv, jpegSize)],
    ["GET attachment preview", () => raw(as, `/api/v1/attachments/${attachmentId}/preview`)],
  ];

  it("outside the audience every route is the 404 of a missing session and ws: is refused", async () => {
    for (const [name, call] of routes(olga)) {
      expect((await call()).status, name).toBe(404);
    }
    // The diff never reaches the device for her (no command is queued).
    expect((await olga.request("GET", `/api/v1/work-sessions/${team}/diff`)).status).toBe(404);
    const res = await olga.request("POST", `/api/v1/work-sessions/${team}/prompts`, { body: "hi" });
    expect(res.body).toEqual(
      (await olga.request("POST", `/api/v1/work-sessions/${randomUUID()}/prompts`, { body: "hi" })).body,
    );
    expect(await canFollow(olgaId, team)).toBe(false);
    // Her refusals are audited as denials of the audience, ids only.
    const denied = await su.query(
      `select metadata from app.audit_events where action = 'authz.denied' and user_id = $1
         and metadata->>'reason' = 'not_in_audience'`,
      [olgaId],
    );
    expect(denied.rows.length).toBeGreaterThan(0);
  });

  it("an audience member (project member, developer) reads and follows; control keeps today's rules", async () => {
    const at = async (name: string) => (await routes(pia).find(([n]) => n === name)![1]()).status;
    expect(await at("GET detail")).toBe(200);
    expect(await at("GET controls")).toBe(200);
    expect(await at("GET attachment preview")).toBe(302);
    expect(await at("presign attachment")).toBe(200);
    expect(await canFollow(piaId, team)).toBe(true);
    // The diff is relayed to the device for her.
    const pending = pia.request("GET", `/api/v1/work-sessions/${team}/diff`);
    const req = await command("diff.request", team);
    device.send({
      type: "diff.result",
      requestId: req.id,
      files: [],
      patch: "",
      branch: "ocw/x",
      headSha: "abc",
    });
    expect((await pending).status).toBe(200);
    // Controlling is decided exactly as before: the role prompts, interrupts and configures; approving and archiving
    // need the creator, the device owner or an admin (D-05).
    expect(await at("PATCH prompt")).toBe(200);
    expect(await at("POST commands")).toBe(200);
    expect(await at("PATCH settings")).toBe(200);
    const approve = await pia.request("POST", `/api/v1/work-sessions/${team}/approvals/${approvalId}`, {
      decision: "once",
    });
    expect(approve.status).toBe(403);
    expect((approve.body!.error as Json).details).toEqual({
      permission: "work_session.approve",
      layer: "role",
      reason: "missing_permission",
    });
    const archive = await pia.request("POST", `/api/v1/work-sessions/${team}/archive`);
    expect(archive.status).toBe(403);
    expect(errorCode(archive)).toBe("forbidden");
    expect(await at("POST interrupt")).toBe(200);
    expect(await at("POST prompts")).toBe(200);
  });
});

// ---------------------------------------------------------------- D-12: the creator who left

describe("a creator who left the team project keeps read and archive only (D-12, Pitfall 4)", () => {
  let left: string;
  let leftApproval: string;
  let anaLeft: string;

  beforeAll(async () => {
    left = await startSession(gus, device, billingId, { title: "Left behind" });
    leftApproval = await pendingApproval(gus, left);
    anaLeft = await startSession(ana, device, billingId, { title: "Ana's own" });
    await ok(admin.request("DELETE", `/api/v1/units/${billing.unitId}/members/${gusId}`));
  }, 60_000);

  it("Gus reads and follows his session, which stays in his list", async () => {
    const d = await ok(gus.request("GET", `/api/v1/work-sessions/${left}`));
    expect(d.viewerCan).toEqual(["work_session.archive"]);
    expect(await listIds(gus)).toContain(left);
    expect(await canFollow(gusId, left)).toBe(true);
    expect((await gus.request("GET", `/api/v1/work-sessions/${left}/controls`)).status).toBe(200);
  });

  it("prompt, interrupt, settings and approve are refused with left_project", async () => {
    for (const [name, call] of [
      ["prompt", () => gus.request("POST", `/api/v1/work-sessions/${left}/prompts`, { body: "more" })],
      ["interrupt", () => gus.request("POST", `/api/v1/work-sessions/${left}/interrupt`)],
      ["settings", () => gus.request("PATCH", `/api/v1/work-sessions/${left}/settings`, { model: "sonnet" })],
      [
        "approve",
        () =>
          gus.request("POST", `/api/v1/work-sessions/${left}/approvals/${leftApproval}`, {
            decision: "once",
          }),
      ],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect(errorCode(res), name).toBe("left_project");
    }
  });

  it("a former member who did not create the session no longer sees it", async () => {
    // Gus's device grant does not reach a team-project session: only the project does.
    expect((await gus.request("GET", `/api/v1/work-sessions/${anaLeft}`)).status).toBe(404);
    expect(await canFollow(gusId, anaLeft)).toBe(false);
  });

  it("when the creator who left also owns the device, every device-owner right stays (D-11)", async () => {
    await ok(admin.request("DELETE", `/api/v1/units/${billing.unitId}/members/${anaId}`));
    try {
      const d = await ok(ana.request("GET", `/api/v1/work-sessions/${anaLeft}`));
      expect(d.viewerCan).toEqual(
        expect.arrayContaining(["work_session.prompt", "work_session.approve", "work_session.archive"]),
      );
      await ok(ana.request("POST", `/api/v1/work-sessions/${anaLeft}/prompts`, { body: "still mine" }));
      // She also keeps Gus's session that runs on her device.
      expect((await ana.request("GET", `/api/v1/work-sessions/${left}`)).status).toBe(200);
    } finally {
      await ok(
        admin.request("POST", `/api/v1/units/${billing.unitId}/members`, { userId: anaId, role: "member" }),
      );
    }
  });

  it("Gus archives his session", async () => {
    await ok(gus.request("POST", `/api/v1/work-sessions/${left}/archive`));
    expect(await listIds(gus, true)).toContain(left);
  });
});

// ---------------------------------------------------------------- tenants and the fan-out facts

describe("tenant isolation and the facts for many people", () => {
  const orgB = randomUUID();
  const userB = randomUUID();
  const sessionB = randomUUID();

  beforeAll(async () => {
    const q = (text: string, values: unknown[]) => su.query(text, values);
    const devB = randomUUID();
    const projB = randomUUID();
    const convB = randomUUID();
    await q("insert into auth.organization (id, name, slug) values ($1, 'Org B', $2)", [orgB, `org-${orgB}`]);
    await q("insert into auth.user (id, name, email) values ($1, 'B', $2)", [userB, `${userB}@example.test`]);
    await q(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'B', 'admin')",
      [orgB, userB],
    );
    await q(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'b', 'linux', $4)",
      [devB, orgB, userB, `tok-${devB}`],
    );
    await q(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'b')",
      [projB, orgB, devB],
    );
    await q(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'work_session', 'b')",
      [convB, orgB],
    );
    await q(
      "insert into app.work_sessions (id, organization_id, conversation_id, project_id, device_id, title, created_by, status) values ($1, $2, $3, $4, $5, 'B', $6, 'idle')",
      [sessionB, orgB, convB, projB, devB, userB],
    );
  });

  it("another organization's admin follows neither way, and its session is missing here", async () => {
    expect(await canFollow(userB, team, orgB)).toBe(false);
    expect(await canFollow(userB, sessionB, orgB)).toBe(true);
    expect(await canFollow(adminId, sessionB)).toBe(false);
    expect((await admin.request("GET", `/api/v1/work-sessions/${sessionB}`)).status).toBe(404);
    expect(await listIds(admin)).not.toContain(sessionB);
  });

  it("sessionFactsForUsers decides many people with the same rule as the routes, inside the tenant only", async () => {
    const facts = await stack.built.core.db.withTenant(
      { organizationId: orgId, userId: null },
      async (tx) => {
        const [s] = (
          await tx.execute(
            sql`select id, created_by as "createdBy", device_id as "deviceId" from app.work_sessions where id = ${team}::uuid`,
          )
        ).rows as Array<{ id: string; createdBy: string; deviceId: string }>;
        return sessionFactsForUsers(tx, s!, [piaId, olgaId, anaId, userB]);
      },
    );
    expect([...facts.get(piaId)!.relations]).toEqual(["viewer"]);
    expect(facts.get(olgaId)!.relations.size).toBe(0);
    expect([...facts.get(anaId)!.relations].sort()).toEqual(["device_owner", "viewer"]);
    expect(facts.get(anaId)!.unitPath).toEqual([billing.parentId, billing.unitId]);
    // Another tenant's person holds nothing here.
    expect(facts.get(userB)!.relations.size).toBe(0);
    expect(facts.get(userB)!.state.has("creator_left")).toBe(false);
    // And from org B's context, org A's session has no facts at all (missing, treated as on a revoked device).
    const fromB = await stack.built.core.db.withTenant({ organizationId: orgB, userId: null }, (tx) =>
      sessionFactsForUsers(tx, { id: team, createdBy: gusId, deviceId }, [gusId, userB]),
    );
    expect(fromB.get(userB)!.relations.size).toBe(0);
    expect(fromB.get(userB)!.state.has("device_revoked")).toBe(true);
  });
});
