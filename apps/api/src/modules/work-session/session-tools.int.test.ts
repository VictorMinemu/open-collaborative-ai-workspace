import { joinNamingRules, SessionToolsGrant } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice, sleep } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  createTeamProject,
  invite,
  linkRepo,
  pairDevice,
} from "../../testing-workzone";

/**
 * Phase 07.13.1.1-03 Task 3 (D-07, D-08, PD-06, PD-10, PD-13): the naming rules reach the places they are used. The
 * `session.title` command carries the organization's rule, then the session's team project's rule (`joinNamingRules`;
 * the stored command holds it, the audit never does). Every `session.start` and `prompt` a device receives carries
 * `sessionTools { rename, namingRules }`, decided at send time and added to the sent copy only: the stored
 * `device_commands` payload never has it, and no other command carries it. Real PostgreSQL + Redis.
 *
 * Organization A: Víctor (admin), Pia (developer) owns "Pia's Mac" with `atlas` (linked to team project Atlas) and
 * `notes` (a personal repository).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const ORG_RULE = "Start with the area, then the change";
const PROJECT_RULE = "Prefix with the module";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Cmd = { id: string; kind: string; payload: Json; sessionId: string };

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let pia: TestClient;
let piaId: string;
let device: FakeDevice;
let deviceId: string;
let atlasRepo: string;
let notesRepo: string;
let atlasUnit: string;

const storedPayload = async (commandId: string) =>
  ((await su.query("select payload from app.device_commands where id = $1", [commandId])).rows[0] as Json)
    .payload as Json;

const grantOf = (cmd: Cmd) => SessionToolsGrant.parse(cmd.payload.sessionTools);

/** Pia creates a session (with `body`), the device acks its start and reports it idle; answers the start frame. */
async function start(projectId: string, body: Json = {}): Promise<{ id: string; start: Cmd }> {
  const res = await pia.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = (await device.command("session.start", id)) as Cmd;
  device.ack(start.id);
  device.event(id, {
    type: "session.started",
    runtime: "claude-code",
    runtimeSessionId: `rt-${id}`,
    permissionMode: "default",
  });
  device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => {
    const d = await pia.request("GET", `/api/v1/work-sessions/${id}`);
    return (d.body?.session as Json | undefined)?.status === "idle";
  });
  return { id, start };
}

/** Pia sends a prompt; answers the frame the device received (not acked yet). */
async function prompt(id: string, body = "go on"): Promise<Cmd> {
  const res = await pia.request("POST", `/api/v1/work-sessions/${id}/prompts`, { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (await device.command("prompt", id)) as Cmd;
}

/** Ack the prompt frame and report the turn finished. */
async function finish(id: string, cmd: Cmd) {
  device.ack(cmd.id);
  const promptId = cmd.payload.promptId as string;
  device.event(id, { type: "prompt.started", promptId });
  device.event(id, { type: "prompt.completed", promptId, usage: { inputTokens: 1, outputTokens: 1 } });
  await eventually(async () => {
    const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
    return r.rows[0]?.status === "completed";
  });
}

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
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  const orgId = (setup.body!.organization as Json).id as string;
  const adminId = (setup.body!.user as Json).id as string;
  ({ client: pia, userId: piaId } = await invite(stack, admin, "pia@example.test", "Pia Paz", "developer"));

  const paired = await pairDevice(stack, pia, "Pia's Mac");
  deviceId = paired.deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [
      { localId: "lp_atlas", name: "atlas", gitRemote: null, defaultBranch: "main" },
      { localId: "lp_notes", name: "notes", gitRemote: null, defaultBranch: "main" },
    ],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG]);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  const repos = (await su.query("select id, name from app.projects where device_id = $1", [deviceId])).rows;
  atlasRepo = repos.find((r) => r.name === "atlas")!.id as string;
  notesRepo = repos.find((r) => r.name === "notes")!.id as string;
  atlasUnit = (await createTeamProject(stack, admin, { name: "Atlas", members: [{ userId: piaId }] })).unitId;
  await linkRepo(stack, {
    organizationId: orgId,
    unitId: atlasUnit,
    projectId: atlasRepo,
    deviceId,
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

describe("the session tool grant on start and prompt frames (D-07, PD-10)", () => {
  it("without rules: rename on, no rules; the stored commands never hold the grant", async () => {
    const { id, start: s } = await start(atlasRepo);
    expect(grantOf(s)).toEqual({ rename: true, namingRules: null });
    expect(await storedPayload(s.id)).not.toHaveProperty("sessionTools");
    const p = await prompt(id);
    expect(grantOf(p)).toEqual({ rename: true, namingRules: null });
    expect(await storedPayload(p.id)).not.toHaveProperty("sessionTools");
    await finish(id, p);
  });

  it("carries both rules, follows a person's title and a changed project rule at the next send", async () => {
    expect(
      (await admin.request("PUT", "/api/v1/work-zone-policy", { sessionNamingRule: ORG_RULE })).status,
    ).toBe(200);
    const patched = await admin.request("PATCH", `/api/v1/work-projects/${atlasUnit}`, {
      namingRule: PROJECT_RULE,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const both = joinNamingRules(ORG_RULE, PROJECT_RULE);

    const { id, start: s } = await start(atlasRepo);
    expect(grantOf(s)).toEqual({ rename: true, namingRules: both });
    let p = await prompt(id);
    expect(grantOf(p)).toEqual({ rename: true, namingRules: both });
    expect(await storedPayload(p.id)).not.toHaveProperty("sessionTools");
    await finish(id, p);

    // A person's title turns the tool off for the next turn.
    expect((await pia.request("PATCH", `/api/v1/work-sessions/${id}`, { title: "Pia's name" })).status).toBe(
      200,
    );
    p = await prompt(id);
    expect(grantOf(p)).toEqual({ rename: false, namingRules: both });
    await finish(id, p);

    // A new project rule reaches the next prompt.
    expect(
      (await admin.request("PATCH", `/api/v1/work-projects/${atlasUnit}`, { namingRule: "Name the ticket" }))
        .status,
    ).toBe(200);
    p = await prompt(id);
    expect(grantOf(p).namingRules).toBe(joinNamingRules(ORG_RULE, "Name the ticket"));

    // Neither an interrupt nor a settings change nor a diff request carries it.
    device.ack(p.id);
    device.event(id, { type: "prompt.started", promptId: p.payload.promptId });
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [p.payload.promptId]);
      return r.rows[0]?.status === "running";
    });
    expect((await pia.request("POST", `/api/v1/work-sessions/${id}/interrupt`)).status).toBe(200);
    const interrupt = (await device.command("interrupt", id)) as Cmd;
    expect(interrupt.payload).not.toHaveProperty("sessionTools");
    device.ack(interrupt.id);
    device.event(id, {
      type: "prompt.completed",
      promptId: p.payload.promptId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const settings = await pia.request("PATCH", `/api/v1/work-sessions/${id}/settings`, { model: "sonnet" });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const configure = (await device.command("session.configure", id)) as Cmd;
    expect(configure.payload).not.toHaveProperty("sessionTools");
    device.ack(configure.id);
    await sleep(200);
    for (const f of device.frames.filter((f) => f.type === "command" && f.kind === "diff.request")) {
      expect((f as unknown as Cmd).payload).not.toHaveProperty("sessionTools");
    }
    // Restore the project rule for the title cases.
    expect(
      (await admin.request("PATCH", `/api/v1/work-projects/${atlasUnit}`, { namingRule: PROJECT_RULE }))
        .status,
    ).toBe(200);
  });

  it("a personal repository gets the organization's rule only", async () => {
    const { id, start: s } = await start(notesRepo);
    expect(grantOf(s)).toEqual({ rename: true, namingRules: ORG_RULE });
    const p = await prompt(id);
    expect(grantOf(p).namingRules).toBe(ORG_RULE);
    await finish(id, p);
  });
});

describe("the title call carries the rules (D-08, PD-06)", () => {
  it("a team project's session: the organization's rule then the project's, stored in the command, never audited", async () => {
    const res = await pia.request("POST", "/api/v1/work-sessions", {
      projectId: atlasRepo,
      prompt: "Find why the login redirect loops forever",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const id = res.body!.id as string;
    const title = (await device.command("session.title", id)) as Cmd;
    const both = joinNamingRules(ORG_RULE, PROJECT_RULE);
    expect(title.payload).toMatchObject({ runtime: "claude-code", model: "haiku", namingRules: both });
    expect((await storedPayload(title.id)).namingRules).toBe(both);
    const audits = await su.query(
      "select row_to_json(a)::text as row from app.audit_events a where action = 'work_session.title_requested' and resource_id = $1",
      [id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].row).not.toContain("Prefix with");
    expect(audits.rows[0].row).not.toContain("Start with the area");
  });

  it("a personal repository's session: the organization's rule only; with no rules, no key", async () => {
    const res = await pia.request("POST", "/api/v1/work-sessions", {
      projectId: notesRepo,
      prompt: "Write the release notes for the desktop app",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const title = (await device.command("session.title", res.body!.id as string)) as Cmd;
    expect(title.payload.namingRules).toBe(ORG_RULE);

    expect((await admin.request("PUT", "/api/v1/work-zone-policy", { sessionNamingRule: "" })).status).toBe(
      200,
    );
    const bare = await pia.request("POST", "/api/v1/work-sessions", {
      projectId: notesRepo,
      prompt: "Write the changelog for the runtime",
    });
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    const plain = (await device.command("session.title", bare.body!.id as string)) as Cmd;
    expect(plain.payload).not.toHaveProperty("namingRules");
  });
});
