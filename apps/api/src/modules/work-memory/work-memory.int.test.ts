import { randomUUID } from "node:crypto";
import { EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, startAiStack, withoutTitles } from "../../testing-ai";
import { eventually, FakeDevice, type Frame } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  createTeamProject,
  invite,
  pairDevice,
  shareDevice,
  startSession,
} from "../../testing-workzone";

/**
 * Phase 07.6-08 (AUTO-06; D-06, D-07, D-10, D-11; P-15, P-16): a finished Work Zone session feeds the memory of the team
 * project its repository is linked to through 07.9 (`work_project_repos`), as a 07.2 proposal with a system origin,
 * written by the owner's model and billed to the owner, only with the owner's consent. Its state is read through the
 * session's audience rule and announced on each reader's own `user:` topic, never `ws:` or `org:`. Real PostgreSQL,
 * Redis and pg-boss; the fake model only.
 *
 * Cast: Víctor (admin), Ana (developer; owns "Ana's MacBook" with `billing-api` and `notes`, and "Ana's Laptop"), Marta
 * (lead role, lead of the team project Billing, may use Ana's MacBook), Sam (developer, may use Ana's MacBook, no
 * project), Eve (organization B).
 */

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };
type Cmd = Frame & { id: string; payload: Record<string, unknown>; sessionId: string };

let stack: AiStack;
let su: pg.Client;
let orgId: string;
let admin: TestClient;
let ana: TestClient;
let anaId: string;
let marta: TestClient;
let martaId: string;
let sam: TestClient;
let samId: string;
let eve: TestClient;
let eveId: string;
let device: FakeDevice;
let deviceId: string;
let laptopId: string;
let billingRepo: string;
let notesRepo: string;
let billing: { unitId: string; parentId: string };
/** The session of Task 1: proposed, then applied by Marta. */
let s1: string;

const published: Array<{ topic: string; type: string; data: unknown }> = [];
const appended: Array<{ topic: string; type: string }> = [];

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const summaryRequests = () => withoutTitles(stack.fake.requests("openai"));
const drain = () => stack.built.core.jobs.drain("work_session.summarize");
const memoryOf = (as: TestClient, id: string) => as.request("GET", `/api/v1/work-sessions/${id}/memory`);
const propose = (as: TestClient, id: string) =>
  as.request("POST", `/api/v1/work-sessions/${id}/memory/propose`, {});
/** The `work_session_memory.updated` frames published since `from`, by topic. */
const memoryFrames = (from = 0) =>
  published.slice(from).filter((p) => p.type === EventTypes.workSessionMemoryUpdated);
const framesFor = (userId: string, sessionId: string, from = 0) =>
  memoryFrames(from).filter(
    (p) => p.topic === `user:${userId}` && (p.data as Json).workSessionId === sessionId,
  );

async function command(kind: string, sessionId: string): Promise<Cmd> {
  const cmd = (await device.command(kind, sessionId)) as Cmd;
  device.ack(cmd.id);
  return cmd;
}

const statusOf = async (as: TestClient, id: string) =>
  ((await ok(as.request("GET", `/api/v1/work-sessions/${id}`))).session as Json).status as string;

/** One prompt by `as` that edits a file, answered, then the session back to idle. */
async function turn(as: TestClient, sessionId: string, prompt: string, answer: string): Promise<void> {
  await ok(as.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: prompt }));
  const cmd = await command("prompt", sessionId);
  const promptId = cmd.payload.promptId as string;
  device.event(sessionId, { type: "prompt.started", promptId });
  device.event(sessionId, {
    type: "tool.started",
    toolUseId: `t-${promptId}`,
    name: "Edit",
    summary: "Edit /Users/ana/code/billing-api/src/invoice.ts",
  });
  device.event(sessionId, { type: "assistant.message", messageId: `m-${promptId}`, text: answer });
  device.event(sessionId, {
    type: "prompt.completed",
    promptId,
    usage: { inputTokens: 10, outputTokens: 20 },
  });
  device.event(sessionId, { type: "session.state", status: "idle" });
  await eventually(async () => (await statusOf(as, sessionId)) === "idle");
}

/** The device ends the session (`completed`). */
async function complete(as: TestClient, sessionId: string): Promise<void> {
  device.event(sessionId, { type: "session.state", status: "completed" });
  await eventually(async () => (await statusOf(as, sessionId)) === "completed");
}

/** A completed session restarted by a new prompt of `as` (the device re-attaches it), then one turn. */
async function restartWithTurn(as: TestClient, sessionId: string, prompt: string): Promise<void> {
  await ok(as.request("POST", `/api/v1/work-sessions/${sessionId}/prompts`, { body: prompt }));
  const start = await command("session.start", sessionId);
  void start;
  device.event(sessionId, { type: "session.state", status: "idle" });
  const cmd = await command("prompt", sessionId);
  const promptId = cmd.payload.promptId as string;
  device.event(sessionId, { type: "prompt.started", promptId });
  device.event(sessionId, { type: "assistant.message", messageId: `m-${promptId}`, text: "Done again." });
  device.event(sessionId, { type: "prompt.completed", promptId, usage: { inputTokens: 1, outputTokens: 1 } });
  device.event(sessionId, { type: "session.state", status: "idle" });
  await eventually(async () => (await statusOf(as, sessionId)) === "idle");
}

const usageRows = async (subjectIds: string[]) =>
  (
    await su.query(
      "select kind, subject_id, requester_user_id, generation_id, conversation_id from app.ai_usage_records where kind = 'session_summary' and subject_id = any($1::uuid[])",
      [subjectIds],
    )
  ).rows as Json[];

const systemApprovals = async () =>
  (
    await su.query(
      `select a.id, a.status, a.requested_for_user_id, a.requested_by_agent_id, a.card_message_id, p.path, s.unit_id
         from app.approval_requests a
         join app.memory_proposals p on p.id = a.resource_id
         join app.memory_scopes s on s.id = p.scope_id
        where a.kind = 'memory.write' and a.requested_by_agent_id is null
        order by a.created_at`,
    )
  ).rows as Json[];

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.9 cross-tenant pattern). */
async function moveToOrgB(userId: string): Promise<string> {
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
  return orgB;
}

beforeAll(async () => {
  stack = await startAiStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", { token: TEST_SETUP_TOKEN, ...ADMIN, orgName: "Autofy Labs" }),
  );
  orgId = setup.organization.id;
  ({ client: ana, userId: anaId } = await invite(stack, admin, "ana@example.test", "Ana", "developer"));
  ({ client: marta, userId: martaId } = await invite(stack, admin, "marta@example.test", "Marta", "lead"));
  ({ client: sam, userId: samId } = await invite(stack, admin, "sam@example.test", "Sam", "developer"));
  ({ client: eve, userId: eveId } = await invite(stack, admin, "eve@example.test", "Eve", "developer"));

  const paired = await pairDevice(stack, ana, "Ana's MacBook");
  deviceId = paired.deviceId;
  laptopId = (await pairDevice(stack, ana, "Ana's Laptop")).deviceId;
  device = await FakeDevice.connect(stack.baseUrl, paired.token);
  device.send({
    type: "projects.sync",
    projects: [
      { localId: "lp_billing", name: "billing-api", gitRemote: null, defaultBranch: "main" },
      { localId: "lp_notes", name: "notes", gitRemote: null, defaultBranch: "main" },
    ],
  });
  await device.next((f) => f.type === "projects.ack");
  device.capabilities([CLAUDE_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 1;
  });
  const repos = (await ok(ana.request("GET", "/api/v1/projects"))).projects as Json[];
  billingRepo = repos.find((p) => p.name === "billing-api")!.id;
  notesRepo = repos.find((p) => p.name === "notes")!.id;

  await shareDevice(ana, deviceId, martaId);
  await shareDevice(ana, deviceId, samId);
  billing = await createTeamProject(stack, admin, {
    name: "Billing",
    members: [{ userId: anaId }, { userId: martaId, role: "lead" }],
  });
  // 07.9's linking route (D-10): Marta manages Billing and may use Ana's MacBook.
  await ok(
    marta.request("POST", `/api/v1/work-projects/${billing.unitId}/repos`, { projectId: billingRepo }),
  );

  const realtime = stack.built.core.realtime;
  const publish = realtime.publishEphemeral.bind(realtime);
  vi.spyOn(realtime, "publishEphemeral").mockImplementation(async (topic, type, data) => {
    published.push({ topic, type, data });
    return publish(topic, type, data);
  });
  const append = realtime.appendEvent.bind(realtime);
  vi.spyOn(realtime, "appendEvent").mockImplementation(async (tx, topic, type, payload) => {
    appended.push({ topic, type });
    return append(tx, topic, type, payload);
  });
}, 240_000);

afterAll(async () => {
  try {
    vi.restoreAllMocks();
    await device?.close().catch(() => {});
    await su?.end();
  } finally {
    await stack?.stop();
  }
});

/** Nothing about a session's memory is ever written on a shared stream (D-11). */
function expectNoSharedMemoryFrames() {
  expect(
    published.filter((p) => p.type === EventTypes.workSessionMemoryUpdated && !p.topic.startsWith("user:")),
  ).toEqual([]);
  expect(appended.filter((a) => a.type === EventTypes.workSessionMemoryUpdated)).toEqual([]);
}

// ---------------------------------------------------------------- Task 1: the tracer

describe("a finished session in a linked repository becomes a pending proposal in its team project's memory", () => {
  it("07.9 linked the repository (audited there); a completed session without consent writes nothing", async () => {
    const linked = await su.query(
      "select metadata from app.audit_events where action = 'work_project.repo_linked' and resource_id = $1",
      [billing.unitId],
    );
    expect(linked.rows).toHaveLength(1);

    s1 = await startSession(ana, device, billingRepo, { title: "Invoice export" });
    await turn(
      ana,
      s1,
      "Add CSV export to /Users/ana/code/billing-api/src/invoice.ts please",
      "I added `exportCsv` in src/invoice.ts.",
    );
    const before = summaryRequests().length;
    await complete(ana, s1);
    // The completion enqueued the automatic job; Ana never opted in, so it does nothing.
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before);

    const m = await ok(memoryOf(ana, s1));
    expect(m).toMatchObject({
      status: "none",
      unit: { id: billing.unitId, name: "Billing" },
      proposalId: null,
      auto: false,
      nothingNew: false,
      canPropose: true,
      canMap: false,
    });
    expect(m.model).toMatchObject({ metered: false, plan: false });
    expect(await usageRows([s1])).toEqual([]);
  });

  it("Propose → the owner's model writes one summary from repo-relative input → one owner-paid usage record → a system-origin proposal → per-user frames", async () => {
    const before = summaryRequests().length;
    const framesFrom = published.length;
    expect((await propose(ana, s1)).status).toBe(202);
    expect(await drain()).toBe(1);

    const calls = summaryRequests().slice(before);
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]?.body);
    expect(sent).toContain("Add CSV export to src/invoice.ts please");
    expect(sent).toContain("Edit src/invoice.ts");
    expect(sent).not.toContain("/Users/");

    expect(await usageRows([s1])).toEqual([
      {
        kind: "session_summary",
        subject_id: s1,
        requester_user_id: anaId,
        generation_id: null,
        conversation_id: null,
      },
    ]);

    const approvals = await systemApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      status: "pending",
      requested_for_user_id: anaId,
      requested_by_agent_id: null,
      card_message_id: null,
      unit_id: billing.unitId,
    });
    expect(approvals[0]?.path).toMatch(/^work-zone\/\d{4}-\d{2}-\d{2}-invoice-export-[0-9a-f]{8}\.md$/);
    const content = (
      await su.query("select content from app.memory_proposals where path = $1", [approvals[0]?.path])
    ).rows[0]?.content as string;
    expect(content).toMatch(/^# Invoice export\n/);
    expect(content).not.toContain("/Users/");

    const m = await ok(memoryOf(ana, s1));
    expect(m).toMatchObject({
      status: "pending",
      unit: { id: billing.unitId, name: "Billing" },
      proposalId: approvals[0]?.id,
      auto: false,
      nothingNew: true,
    });

    const audit = await su.query(
      "select user_id, actor_kind, metadata from app.audit_events where action = 'work_session.summary_proposed' and resource_id = $1",
      [s1],
    );
    expect(audit.rows).toEqual([
      {
        user_id: anaId,
        actor_kind: "system",
        metadata: { approvalId: approvals[0]?.id, unitId: billing.unitId, auto: false },
      },
    ]);

    // D-11: both readers of the `project`-visibility session hear it on their own topic; nobody else, nothing shared.
    expect(framesFor(anaId, s1, framesFrom).length).toBeGreaterThanOrEqual(2); // writing, then pending
    expect(framesFor(martaId, s1, framesFrom).length).toBeGreaterThanOrEqual(2);
    expect(framesFor(samId, s1, framesFrom)).toEqual([]);
    expectNoSharedMemoryFrames();
  });

  it("Ana cannot decide her own proposal; Marta (Billing lead) approves it through 07.2 and the file exists", async () => {
    const [approval] = await systemApprovals();
    const id = approval?.id as string;
    const mine = await ana.request("POST", `/api/v1/approvals/${id}/decision`, {
      outcome: "approved",
      actionHash: "0".repeat(64),
    });
    expect([403, 404]).toContain(mine.status);

    const detail = await ok(marta.request("GET", `/api/v1/approvals/${id}`));
    expect(detail.view.proposal.requestedBy.agent.displayName).toBe("Work Zone");
    await ok(
      marta.request("POST", `/api/v1/approvals/${id}/decision`, {
        outcome: "approved",
        actionHash: detail.actionHash,
      }),
    );
    const file = await su.query(
      "select content from app.memory_files where path = $1 and deleted_at is null",
      [approval?.path],
    );
    expect(file.rows).toHaveLength(1);

    const m = await ok(memoryOf(ana, s1));
    expect(m).toMatchObject({ status: "applied", decidedBy: { id: martaId, displayName: "Marta" } });
  });
});
