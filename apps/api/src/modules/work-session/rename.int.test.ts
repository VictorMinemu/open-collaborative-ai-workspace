import { randomUUID } from "node:crypto";
import { WorkSession, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  settled,
  startSession,
} from "../../testing-workzone";

/**
 * Phase 07.13.1.1-02 Task 3 (D-06, D-14, PD-07): people rename a session by hand through `PATCH /work-sessions/:id`.
 * A typed title is `titleSource = 'user'`, renames the session's conversation, is audited with its length only and goes
 * live on `ws:`; the device's automatic title never replaces it afterwards (03.2 D-19). Real PostgreSQL and Redis.
 *
 * Organization A. Víctor (admin). Ana (developer) owns "Ana's Mac" with `atlas`, linked to team project Atlas (Ana,
 * Sam). Sam has the standard role: he is in the project but his role controls no session. Olga (developer) is in nothing.
 * Organization B: Eve (admin).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const TITLE = "Login redirect fix";

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
let sam: TestClient;
let olga: TestClient;
let olgaId: string;
let atlasUnit: string;
let eve: TestClient;
let device: FakeDevice;
let projectId: string;

async function ok(res: Promise<Res>): Promise<Json> {
  const r = await res;
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function fails(res: Promise<Res>, status: number) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as { error: { code: string; message: string } }).error;
}

const rename = (as: TestClient, id: string, body: unknown) =>
  as.request("PATCH", `/api/v1/work-sessions/${id}`, body);

const renamedAudits = async (id: string) =>
  (
    await su.query(
      "select user_id, metadata, row_to_json(a)::text as row from app.audit_events a where action = 'work_session.renamed' and resource_id = $1 order by occurred_at",
      [id],
    )
  ).rows as Array<{ user_id: string; metadata: Json; row: string }>;

const sessionRow = async (id: string) =>
  (
    await su.query(
      "select s.title, s.title_source, c.name as conversation_name from app.work_sessions s join app.conversations c on c.id = s.conversation_id where s.id = $1",
      [id],
    )
  ).rows[0] as { title: string; title_source: string; conversation_name: string };

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
  const samInvite = await invite(stack, admin, "sam@example.test", "Sam Soto", "standard");
  sam = samInvite.client;
  ({ client: olga, userId: olgaId } = await invite(
    stack,
    admin,
    "olga@example.test",
    "Olga Ortiz",
    "developer",
  ));
  const invited = await invite(stack, admin, "eve@example.test", "Eve", "developer");
  eve = invited.client;
  await moveToOrgB(invited.userId);

  const paired = await pairDevice(stack, ana, "Ana's Mac");
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [{ localId: "lp_atlas", name: "atlas", gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG]);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  projectId = (await su.query("select id from app.projects where device_id = $1", [paired.deviceId])).rows[0]
    .id as string;
  const atlas = await createTeamProject(stack, admin, {
    name: "Atlas",
    members: [{ userId: anaId }, { userId: samInvite.userId }],
  });
  atlasUnit = atlas.unitId;
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: atlas.unitId,
    projectId,
    deviceId: paired.deviceId,
    linkedBy: adminId,
  });
}, 240_000);

afterAll(async () => {
  try {
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

describe("a person renames a session (D-06, D-14, PD-07)", () => {
  it("sets a typed title, renames the conversation, audits the length only and goes live", async () => {
    const id = await startSession(ana, device, projectId, { title: "Checkout work" });
    const res = WorkSession.parse(await ok(rename(ana, id, { title: `  ${TITLE}  ` })));
    expect(res).toMatchObject({ id, title: TITLE, titleSource: "user" });
    expect(await sessionRow(id)).toEqual({ title: TITLE, title_source: "user", conversation_name: TITLE });

    const rows = await renamedAudits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(anaId);
    expect(rows[0]!.metadata).toEqual({ by: "user", length: 18 });
    expect(rows[0]!.row).not.toContain("Login redirect");

    const updated = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated' order by seq desc limit 1",
      [`ws:${id}`],
    );
    expect(updated.rows[0].payload).toMatchObject({ title: TITLE, titleSource: "user" });

    // The same title again changes nothing and audits nothing.
    expect((await ok(rename(ana, id, { title: TITLE }))).title).toBe(TITLE);
    expect(await renamedAudits(id)).toHaveLength(1);
  });

  it("a device title that arrives after the rename never replaces it (D-19)", async () => {
    const created = await ok(
      ana.request("POST", "/api/v1/work-sessions", {
        projectId,
        prompt: "Find why the login redirect loops",
      }),
    );
    const id = created.id as string;
    expect(created.titleSource).toBe("heuristic");
    const request = await device.command("session.title", id);
    await ok(rename(ana, id, { title: TITLE }));
    device.titleResult(request.id as string, id, "Login loop fix", "haiku");
    device.ack(request.id as string);
    await settled(stack, orgId);
    await new Promise((r) => setTimeout(r, 300));
    expect(await sessionRow(id)).toEqual({ title: TITLE, title_source: "user", conversation_name: TITLE });
    const generated = await su.query(
      "select count(*)::int as n from app.audit_events where action = 'work_session.title_generated' and resource_id = $1",
      [id],
    );
    expect(generated.rows[0].n).toBe(0);
  });

  it("refuses a reader without the grain, an outsider, another organization, an archived session and a bad title", async () => {
    const id = await startSession(ana, device, projectId, { title: "Keep me" });
    // Sam is in the project (in the audience) but his role holds no Work Zone control: the resolver's 403.
    await fails(rename(sam, id, { title: "Mine now" }), 403);
    const missing = (await olga.request("PATCH", `/api/v1/work-sessions/${randomUUID()}`, { title: "x" }))
      .body;
    expect((await olga.request("PATCH", `/api/v1/work-sessions/${id}`, { title: "x" })).body).toEqual(
      missing,
    );
    await fails(rename(olga, id, { title: "x" }), 404);
    await fails(rename(eve, id, { title: "x" }), 404);
    for (const body of [
      { title: "a\nb" },
      { title: "" },
      { title: "   " },
      { title: "/Users/victor/secret" },
      { title: "x".repeat(201) },
      { title: "Fine", extra: 1 },
      {},
    ]) {
      await fails(rename(ana, id, body), 400);
    }
    expect((await sessionRow(id)).title).toBe("Keep me");

    await ok(ana.request("POST", `/api/v1/work-sessions/${id}/archive`));
    expect((await fails(rename(ana, id, { title: "Too late" }), 409)).code).toBe("session_archived");
    expect((await sessionRow(id)).title).toBe("Keep me");
    expect(await renamedAudits(id)).toEqual([]);
  });

  it("a bot's session: its live card follows the new title (syncBotCard)", async () => {
    const id = await startSession(ana, device, projectId, { title: "Bot work" });
    const botId = (
      await su.query(
        "insert into app.agents (organization_id, name, username, instructions, model_provider, model_id) values ($1, 'Scout', 'scout', 'Help', 'mock', 'mock-1') returning id",
        [orgId],
      )
    ).rows[0].id as string;
    const conv = (await su.query("select conversation_id from app.work_sessions where id = $1", [id])).rows[0]
      .conversation_id as string;
    await su.query("update app.work_sessions set started_by_agent_id = $2 where id = $1", [id, botId]);
    await su.query(
      "insert into app.bot_work_sessions (work_session_id, organization_id, agent_id, sponsor_user_id, requester_user_id, origin_conversation_id, origin_message_id, origin_event_id) values ($1, $2, $3, $4, $4, $5, $6, $7)",
      [id, orgId, botId, anaId, conv, randomUUID(), randomUUID()],
    );
    await ok(rename(ana, id, { title: "Bot work renamed" }));
    const flag = await su.query("select wake_pending from app.bot_work_sessions where work_session_id = $1", [
      id,
    ]);
    expect(flag.rows[0].wake_pending).toBe(true);
  });
});

describe("each viewer's surfaces say whether they may rename (07.13.1.1 WR-03)", () => {
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
  const listRow = async (as: TestClient, id: string, archived = false) =>
    (
      (await ok(as.request("GET", `/api/v1/work-sessions${archived ? "?archived=1" : ""}`)))
        .sessions as Json[]
    ).find((s) => s.id === id);
  const detailOf = async (as: TestClient, id: string) =>
    (await ok(as.request("GET", `/api/v1/work-sessions/${id}`))).session as Json;

  it("the list, the detail and the user: frames carry canRename = the configure decision; ws: never does", async () => {
    // Olga joins Atlas, so she reads its sessions; a deny rule takes `work_session.configure` from her.
    await ok(admin.request("POST", `/api/v1/units/${atlasUnit}/members`, { userId: olgaId, role: "member" }));
    await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: olgaId,
        permission: "work_session.configure",
        effect: "deny",
      }),
    );
    const id = await startSession(ana, device, projectId, { title: "Who may rename" });
    expect((await listRow(ana, id))?.canRename, "Ana (owner) list").toBe(true);
    expect((await detailOf(ana, id)).canRename, "Ana (owner) detail").toBe(true);
    // The PATCH answers her 403, so no Rename is offered.
    await fails(rename(olga, id, { title: "Mine" }), 403);
    expect((await listRow(olga, id))?.canRename, "Olga list").toBe(false);
    expect((await detailOf(olga, id)).canRename, "Olga detail").toBe(false);

    const anaSock = await openSocket(ana);
    const olgaSock = await openSocket(olga);
    try {
      expect((await anaSock.sub(`user:${anaId}`)).op).toBe("subscribed");
      expect((await olgaSock.sub(`user:${olgaId}`)).op).toBe("subscribed");
      await ok(rename(ana, id, { title: "Renamed for the frames" }));
      const framesOf = (s: Awaited<ReturnType<typeof openSocket>>, topic: string) =>
        s.frames.filter(
          (f) =>
            f.topic === topic &&
            f.type === "work_session.updated" &&
            f.data?.title === "Renamed for the frames",
        );
      await eventually(async () => framesOf(anaSock, `user:${anaId}`).length > 0, 3000);
      await eventually(async () => framesOf(olgaSock, `user:${olgaId}`).length > 0, 3000);
      for (const f of framesOf(anaSock, `user:${anaId}`)) expect(f.data.canRename).toBe(true);
      for (const f of framesOf(olgaSock, `user:${olgaId}`)) expect(f.data.canRename).toBe(false);
    } finally {
      anaSock.socket.close();
      olgaSock.socket.close();
    }
    const ws = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'work_session.updated'",
      [`ws:${id}`],
    );
    for (const r of ws.rows) expect(Object.keys(r.payload as Json)).not.toContain("canRename");

    await ok(ana.request("POST", `/api/v1/work-sessions/${id}/archive`));
    expect((await listRow(ana, id, true))?.canRename, "archived").toBe(false);
  });
});
