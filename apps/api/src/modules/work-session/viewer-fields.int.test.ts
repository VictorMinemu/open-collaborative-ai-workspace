import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
  shareDevice,
  startSession,
} from "../../testing-workzone";

/**
 * Phase 07.10-02 (PD-02, PD-04; UI-SPEC R2; 07.9 D-11, D-12, D-14): a session row is shaped for the person who reads
 * it. Its team project is named only to the people who may open that project and to the session's creator; the owner
 * of the device a linked repository lives on (D-11) reads the session without the project (`teamProject: null`,
 * `teamProjectHidden: true`). Before this plan every DTO carried the project whoever asked: the 07.9 D-14 leak, proven
 * RED first here. Real PostgreSQL and Redis, the real routes, a contracts-level fake device.
 *
 * Cast: Víctor (admin of A, outside Payroll's roster), Dana (developer, owns "Dana's Laptop" with the repository `api`
 * linked to the team project Payroll and the personal repository `scratch`; not in Payroll), Leo and Pia (developers,
 * Payroll members, grants on Dana's device), Max (developer, a Payroll member who creates a session and then leaves
 * the project, D-12), Eve (the admin of organization B, with her own device and team project).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const PAYROLL = "Payroll";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

let stack: TestStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let adminId: string;
let dana: TestClient;
let danaId: string;
let leo: TestClient;
let leoId: string;
let pia: TestClient;
let piaId: string;
let max: TestClient;
let maxId: string;
let eve: TestClient;
let eveId: string;
let orgB: string;
let device: FakeDevice;
let deviceId: string;
let apiRepo: string;
let scratchRepo: string;
let payroll: string;
/** Leo's session on `api` (Payroll), running on Dana's device. */
let leoSession: string;
/** Max's session on `api`; Max then leaves Payroll (D-12). */
let maxSession: string;
/** Dana's session on her personal repository. */
let danaSession: string;
/** Organization B: Eve's device, her team project and her session on its linked repository. */
let eveDevice: FakeDevice;
let eveProject: string;
let eveSession: string;

async function ok(res: Promise<Res>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const list = async (as: TestClient) => (await ok(as.request("GET", "/api/v1/work-sessions"))) as Json;
const row = async (as: TestClient, id: string) =>
  ((await list(as)).sessions as Json[]).find((s) => s.id === id);
const detail = async (as: TestClient, id: string) =>
  (await ok(as.request("GET", `/api/v1/work-sessions/${id}`))) as Json;

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.5 / 07.9-04 matrix pattern). */
async function moveToOrgB(userId: string): Promise<string> {
  const id = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [id, `o-${id}`]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    id,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [id, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [id, userId]);
  return id;
}

/** Pair a device for `owner`, announce `repos` and return the device and each repository's id by name. */
async function deviceWith(owner: TestClient, name: string, repos: string[]) {
  const paired = await pairDevice(stack, owner, name);
  const d = await FakeDevice.connect(stack.baseUrl, paired.token);
  d.send({
    type: "projects.sync",
    projects: repos.map((r) => ({ localId: `lp_${r}`, name: r, gitRemote: null, defaultBranch: "main" })),
  });
  await d.next((f) => f.type === "projects.ack");
  d.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  const listed = (await ok(owner.request("GET", "/api/v1/projects"))).projects as Json[];
  const ids = Object.fromEntries(repos.map((r) => [r, listed.find((p) => p.name === r)!.id as string]));
  return { device: d, deviceId: paired.deviceId, ids };
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
  ({ client: dana, userId: danaId } = await invite(stack, admin, "dana@example.test", "Dana", "developer"));
  ({ client: leo, userId: leoId } = await invite(stack, admin, "leo@example.test", "Leo", "developer"));
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia", "developer"));
  ({ client: max, userId: maxId } = await invite(stack, admin, "max@example.test", "Max", "developer"));
  ({ client: eve, userId: eveId } = await invite(stack, admin, "eve@example.test", "Eve", "developer"));

  const laptop = await deviceWith(dana, "Dana's Laptop", ["api", "scratch"]);
  device = laptop.device;
  deviceId = laptop.deviceId;
  apiRepo = laptop.ids.api!;
  scratchRepo = laptop.ids.scratch!;
  for (const uid of [leoId, piaId, maxId]) await shareDevice(dana, deviceId, uid, "acceptEdits");

  // Payroll sits under a department whose name does not contain the project's, so a stray department name cannot
  // satisfy (or hide) the "never named" checks below.
  const finance = await ok(
    admin.request("POST", "/api/v1/units", { kind: "department", name: "Finance", parentId: null }),
  );
  payroll = (
    await createTeamProject(stack, admin, {
      name: PAYROLL,
      parentId: finance.id,
      members: [{ userId: leoId }, { userId: piaId }, { userId: maxId }],
    })
  ).unitId;
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: payroll,
    projectId: apiRepo,
    deviceId,
    linkedBy: adminId,
  });

  leoSession = await startSession(leo, device, apiRepo, { title: "Payslip export" });
  maxSession = await startSession(max, device, apiRepo, { title: "Overtime rounding" });
  danaSession = await startSession(dana, device, scratchRepo, { title: "Scratch notes" });
  // D-12: Max leaves Payroll after creating his session; he keeps reading it (`creator_left`).
  await ok(admin.request("DELETE", `/api/v1/units/${payroll}/members/${maxId}`));

  // Organization B: Eve's own device, team project and session.
  orgB = await moveToOrgB(eveId);
  const eveLaptop = await deviceWith(eve, "Eve's Desktop", ["ledger"]);
  eveDevice = eveLaptop.device;
  eveProject = (await createTeamProject(stack, eve, { name: "Treasury", members: [{ userId: eveId }] }))
    .unitId;
  await linkRepo(stack, {
    organizationId: orgB,
    unitId: eveProject,
    projectId: eveLaptop.ids.ledger!,
    deviceId: eveLaptop.deviceId,
    linkedBy: eveId,
  });
  eveSession = await startSession(eve, eveDevice, eveLaptop.ids.ledger!, { title: "Ledger close" });
}, 240_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await eveDevice?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the team project per viewer (PD-04)

describe("the team project is named per viewer on the list and the detail (PD-02, PD-04)", () => {
  it("the device owner outside the project reads its sessions without the project's name or id (07.9 D-14 leak)", async () => {
    const body = await list(dana);
    for (const id of [leoSession, maxSession]) {
      const r = (body.sessions as Json[]).find((s) => s.id === id);
      expect(r, "the device owner reads the session (D-11)").toBeDefined();
      expect(r?.createdBy, "not her own session").not.toBe(danaId);
      expect(r?.teamProject, "list").toBeNull();
      expect(r?.teamProjectHidden, "list").toBe(true);
      const d = await detail(dana, id);
      expect(d.session.teamProject, "detail").toBeNull();
      expect(d.session.teamProjectHidden, "detail").toBe(true);
      // The whole serialized answer, not selected fields: a future field cannot slip the project through.
      for (const secret of [PAYROLL, payroll]) {
        expect(JSON.stringify(d), `detail carried "${secret}"`).not.toContain(secret);
      }
    }
    for (const secret of [PAYROLL, payroll]) {
      expect(JSON.stringify(body), `list carried "${secret}"`).not.toContain(secret);
    }
  });

  it("members and the admin read the project named, with no teamProjectHidden key", async () => {
    for (const [name, as] of [
      ["Leo", () => leo],
      ["Pia", () => pia],
      ["Víctor", () => admin],
    ] as const) {
      const r = await row(as(), leoSession);
      expect(r?.teamProject, name).toEqual({ id: payroll, name: PAYROLL });
      expect(r && "teamProjectHidden" in r, name).toBe(false);
      const d = await detail(as(), leoSession);
      expect(d.session.teamProject, name).toEqual({ id: payroll, name: PAYROLL });
      expect("teamProjectHidden" in d.session, name).toBe(false);
    }
  });

  it("the creator who left the project still reads it named on their own session (D-12)", async () => {
    const r = await row(max, maxSession);
    expect(r, "Max still reads his session").toBeDefined();
    expect(r?.teamProject).toEqual({ id: payroll, name: PAYROLL });
    expect(r && "teamProjectHidden" in r).toBe(false);
    const d = await detail(max, maxSession);
    expect(d.session.teamProject).toEqual({ id: payroll, name: PAYROLL });
    expect("teamProjectHidden" in d.session).toBe(false);
  });

  it("a personal session reads teamProject null and no teamProjectHidden key, for its owner and the admin", async () => {
    for (const [name, as] of [
      ["Dana", () => dana],
      ["Víctor", () => admin],
    ] as const) {
      const r = await row(as(), danaSession);
      expect(r?.teamProject, name).toBeNull();
      expect(r && "teamProjectHidden" in r, name).toBe(false);
      const d = await detail(as(), danaSession);
      expect(d.session.teamProject, name).toBeNull();
      expect("teamProjectHidden" in d.session, name).toBe(false);
    }
  });

  it("organization B reads its own sessions named for itself and nothing of organization A, and the reverse", async () => {
    const b = await list(eve);
    expect((b.sessions as Json[]).map((s) => s.id)).toEqual([eveSession]);
    expect((b.sessions as Json[])[0]?.teamProject).toEqual({ id: eveProject, name: "Treasury" });
    for (const secret of [PAYROLL, payroll, leoSession, maxSession, danaSession, orgId]) {
      expect(JSON.stringify(b), `B's list carried "${secret}"`).not.toContain(secret);
    }
    expect((await eve.request("GET", `/api/v1/work-sessions/${leoSession}`)).status).toBe(404);
    const a = await list(admin);
    for (const secret of ["Treasury", eveProject, eveSession, orgB]) {
      expect(JSON.stringify(a), `A's list carried "${secret}"`).not.toContain(secret);
    }
    expect((await admin.request("GET", `/api/v1/work-sessions/${eveSession}`)).status).toBe(404);
  });
});
