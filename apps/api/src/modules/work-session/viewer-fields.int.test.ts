import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
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

// ---------------------------------------------------------------- Task 3: what waits on the viewer (PD-05, D-05)

/** A socket on the API's realtime endpoint, as `as`, recording every frame. */
async function openSocket(as: TestClient) {
  const socket = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await as.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: Json[] = [];
  socket.on("message", (m) => frames.push(JSON.parse(String(m)) as Json));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sub = async (topic: string) => {
    socket.send(JSON.stringify({ op: "sub", topic }));
    return eventually(async () =>
      frames.find((f) => (f.op === "subscribed" || f.op === "err") && f.topic === topic),
    );
  };
  return { socket, frames, sub };
}

describe("attention is decided per viewer on the list, the detail and each user: frame (PD-05, D-05)", () => {
  const NOTHING = { approval: false, lastTurnEndedAt: null };
  /** Leo's session on `api` (Payroll) for the attention cases; Pia, Dana and the admin also read it. */
  let attn: string;

  const attentionOf = async (as: TestClient, id: string) => {
    const r = await row(as, id);
    const d = await detail(as, id);
    expect(r?.attention, "the list and the detail agree").toEqual(d.session.attention);
    return d.session.attention as Json;
  };
  /** The completion time of the prompt whose body is `body`, as the detail reports it. */
  const endedAt = async (body: string) =>
    ((await detail(leo, attn)).prompts as Json[]).find((p) => p.body === body)?.completedAt as string;
  const idle = async (as: TestClient, id: string) =>
    eventually(async () => {
      const d = await detail(as, id);
      return d.session.status === "idle" && d.session.queuedCount === 0 && d.session.runningSince === null;
    });

  beforeAll(async () => {
    attn = await startSession(leo, device, apiRepo, { title: "Bonus run" });
  });

  it("with nothing pending and no finished turn, nothing waits on anyone", async () => {
    for (const [name, as] of [
      ["Leo", leo],
      ["Pia", pia],
      ["Dana", dana],
      ["Víctor", admin],
    ] as const) {
      expect(await attentionOf(as, attn), name).toEqual(NOTHING);
    }
  });

  it("a pending approval waits on the creator, the device owner and the admin, not on a fellow member; each user: frame carries its recipient's own", async () => {
    const leoSock = await openSocket(leo);
    const piaSock = await openSocket(pia);
    try {
      expect((await leoSock.sub(`user:${leoId}`)).op).toBe("subscribed");
      expect((await piaSock.sub(`user:${piaId}`)).op).toBe("subscribed");

      await ok(leo.request("POST", `/api/v1/work-sessions/${attn}/prompts`, { body: "Pay the bonuses" }));
      const cmd = await device.command("prompt", attn);
      device.ack(cmd.id);
      device.event(attn, { type: "prompt.started", promptId: cmd.payload.promptId });
      const approvalId = randomUUID();
      device.event(attn, {
        type: "approval.requested",
        approvalId,
        tool: "Edit",
        summary: "Edit src/bonus.ts",
        paths: ["src/bonus.ts"],
      });
      device.event(attn, { type: "session.state", status: "waiting_approval" });
      await eventually(async () =>
        ((await detail(leo, attn)).approvals as Json[]).some((a) => a.id === approvalId),
      );

      for (const [name, as] of [
        ["Leo (creator)", leo],
        ["Dana (device owner)", dana],
        ["Víctor (admin)", admin],
      ] as const) {
        // The turn is still running: it is not a finished turn.
        expect(await attentionOf(as, attn), name).toEqual({ approval: true, lastTurnEndedAt: null });
      }
      expect(await attentionOf(pia, attn), "Pia (a member who may not decide)").toEqual(NOTHING);

      // One delivery, two recipients, two different answers.
      const pendingFrames = (s: Awaited<ReturnType<typeof openSocket>>, topic: string) =>
        s.frames.filter(
          (f) =>
            f.topic === topic &&
            f.type === "work_session.updated" &&
            f.data?.id === attn &&
            f.data?.pendingApprovals > 0,
        );
      await eventually(async () => pendingFrames(leoSock, `user:${leoId}`).length > 0, 3000);
      await eventually(async () => pendingFrames(piaSock, `user:${piaId}`).length > 0, 3000);
      await sleep(200);
      for (const f of pendingFrames(leoSock, `user:${leoId}`)) expect(f.data.attention?.approval).toBe(true);
      for (const f of pendingFrames(piaSock, `user:${piaId}`)) expect(f.data.attention).toEqual(NOTHING);

      // Decided: nothing pending waits on anyone any more.
      await ok(
        leo.request("POST", `/api/v1/work-sessions/${attn}/approvals/${approvalId}`, { decision: "once" }),
      );
      for (const as of [leo, dana, admin, pia]) expect((await attentionOf(as, attn)).approval).toBe(false);

      // The turn ends: it ran Leo's prompt, so it waits on Leo only.
      device.event(attn, {
        type: "prompt.completed",
        promptId: cmd.payload.promptId,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      device.event(attn, { type: "session.state", status: "idle" });
      await idle(leo, attn);
    } finally {
      leoSock.socket.close();
      piaSock.socket.close();
    }
  });

  it("the last finished turn waits only on the author of its prompt; a queued or running prompt changes nothing", async () => {
    const leoEnded = await endedAt("Pay the bonuses");
    expect(leoEnded, "Leo's turn has a completion time").toEqual(expect.any(String));
    expect(await attentionOf(leo, attn)).toEqual({ approval: false, lastTurnEndedAt: leoEnded });
    for (const as of [pia, dana, admin]) expect(await attentionOf(as, attn)).toEqual(NOTHING);

    // Pia's prompt is dispatched, then running: still Leo's turn.
    await ok(pia.request("POST", `/api/v1/work-sessions/${attn}/prompts`, { body: "Check the totals" }));
    const cmd = await device.command("prompt", attn);
    device.ack(cmd.id);
    expect((await attentionOf(leo, attn)).lastTurnEndedAt).toBe(leoEnded);
    expect((await attentionOf(pia, attn)).lastTurnEndedAt).toBeNull();
    device.event(attn, { type: "prompt.started", promptId: cmd.payload.promptId });
    await eventually(async () => (await detail(pia, attn)).session.runningSince !== null);
    expect((await attentionOf(leo, attn)).lastTurnEndedAt).toBe(leoEnded);
    expect((await attentionOf(pia, attn)).lastTurnEndedAt).toBeNull();

    // It ends: now it waits on Pia and no longer on Leo.
    device.event(attn, {
      type: "prompt.completed",
      promptId: cmd.payload.promptId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    device.event(attn, { type: "session.state", status: "idle" });
    await idle(pia, attn);
    const piaEnded = await endedAt("Check the totals");
    expect(piaEnded).toEqual(expect.any(String));
    expect(await attentionOf(pia, attn)).toEqual({ approval: false, lastTurnEndedAt: piaEnded });
    for (const as of [leo, dana, admin]) expect(await attentionOf(as, attn)).toEqual(NOTHING);
  });

  it("organization B reads attention on its own sessions only, and nothing of A's turns", async () => {
    const aTimes = ((await detail(leo, attn)).prompts as Json[]).map((p) => p.completedAt as string);
    await ok(
      eve.request("POST", `/api/v1/work-sessions/${eveSession}/prompts`, { body: "Close the ledger" }),
    );
    const cmd = await eveDevice.command("prompt", eveSession);
    eveDevice.ack(cmd.id);
    eveDevice.event(eveSession, { type: "prompt.started", promptId: cmd.payload.promptId });
    eveDevice.event(eveSession, {
      type: "prompt.completed",
      promptId: cmd.payload.promptId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    eveDevice.event(eveSession, { type: "session.state", status: "idle" });
    await idle(eve, eveSession);
    const d = await detail(eve, eveSession);
    const eveEnded = (d.prompts as Json[]).find((p) => p.body === "Close the ledger")?.completedAt as string;
    const b = await list(eve);
    expect((b.sessions as Json[]).map((s) => s.id)).toEqual([eveSession]);
    expect((b.sessions as Json[])[0]?.attention).toEqual({ approval: false, lastTurnEndedAt: eveEnded });
    for (const secret of [leoId, piaId, attn, ...aTimes]) {
      expect(JSON.stringify(b), `B's list carried "${secret}"`).not.toContain(secret);
    }
    const a = await list(admin);
    for (const secret of [eveSession, eveEnded]) {
      expect(JSON.stringify(a), `A's list carried "${secret}"`).not.toContain(secret);
    }
  });
});
