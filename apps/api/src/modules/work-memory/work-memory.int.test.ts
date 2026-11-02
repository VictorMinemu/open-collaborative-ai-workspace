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
  errorCode,
  invite,
  pairDevice,
  setAudience,
  shareDevice,
  startSession,
} from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { canMapFor } from "./session-unit";

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

// ---------------------------------------------------------------- Task 2: consent, cost, repetition, audience

describe("consent, cost, repetition and audience", () => {
  /** Ana's session with the automatic proposal (proposed again after a restart). */
  let s2: string;

  it("preferences: automatic proposals are off until turned on; then Ana's sessions propose without a click, another owner's do not", async () => {
    expect(await ok(ana.request("GET", "/api/v1/me/preferences"))).toEqual({
      autoProposeSessionSummaries: false,
    });
    expect(
      await ok(ana.request("PUT", "/api/v1/me/preferences", { autoProposeSessionSummaries: true })),
    ).toEqual({ autoProposeSessionSummaries: true });
    expect(await ok(ana.request("GET", "/api/v1/me/preferences"))).toEqual({
      autoProposeSessionSummaries: true,
    });
    expect(await ok(marta.request("GET", "/api/v1/me/preferences"))).toEqual({
      autoProposeSessionSummaries: false,
    });

    s2 = await startSession(ana, device, billingRepo, { title: "Tax rounding" });
    await turn(ana, s2, "Fix the tax rounding", "Rounded half-even.");
    const before = summaryRequests().length;
    await complete(ana, s2);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(ana, s2))).toMatchObject({ status: "pending", auto: true, nothingNew: true });

    // Marta never opted in: her finished session in the same repository is not summarized.
    const ms = await startSession(marta, device, billingRepo, { title: "Marta's fix" });
    await turn(marta, ms, "Fix a typo", "Fixed.");
    await complete(marta, ms);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(marta, ms))).toMatchObject({ status: "none", auto: false, canPropose: true });
  });

  it("at the owner's AI chat cap nothing is generated or billed: failed with limit_reached; Try again works once under the cap", async () => {
    let s3 = "";
    await su.query(
      `insert into app.ai_chat_policies (organization_id, org_key_daily_generations) values ($1, 1)
       on conflict (organization_id) do update set org_key_daily_generations = 1`,
      [orgId],
    );
    await su.query(
      `insert into app.ai_usage_daily (organization_id, user_id, day, backend_class, generations)
       values ($1, $2, (now() at time zone 'utc')::date, 'org_key', 1)
       on conflict (organization_id, user_id, day, backend_class) do update set generations = 1`,
      [orgId, anaId],
    );
    try {
      s3 = await startSession(ana, device, billingRepo, { title: "Capped" });
      await turn(ana, s3, "Something small", "Ok.");
      const before = summaryRequests().length;
      await complete(ana, s3);
      expect(await drain()).toBe(1);
      expect(summaryRequests()).toHaveLength(before);
      expect(await ok(memoryOf(ana, s3))).toMatchObject({ status: "failed" });
      const row = await su.query(
        "select error_code from app.work_session_memory where work_session_id = $1",
        [s3],
      );
      expect(row.rows[0]?.error_code).toBe("limit_reached");
      expect(await usageRows([s3])).toEqual([]);
      const audit = await su.query(
        "select metadata from app.audit_events where action = 'work_session.summary_failed' and resource_id = $1",
        [s3],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ code: "limit_reached" });
    } finally {
      await su.query(
        "update app.ai_chat_policies set org_key_daily_generations = 200 where organization_id = $1",
        [orgId],
      );
      await su.query("update app.ai_usage_daily set generations = 0 where user_id = $1", [anaId]);
    }
    // Back under the cap, the strip's Try again proposes it, billed to Ana once.
    const before = summaryRequests().length;
    expect((await propose(ana, s3)).status).toBe(202);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(ana, s3))).toMatchObject({ status: "pending", nothingNew: true });
    expect(await usageRows([s3])).toHaveLength(1);
  });

  it("nothing new: Propose says so and an archive proposes nothing; a restart with new work proposes exactly once more", async () => {
    const nothing = await propose(ana, s1);
    expect(nothing.status).toBe(409);
    expect(errorCode(nothing)).toBe("nothing_new");
    expect(await ok(memoryOf(ana, s1))).toMatchObject({ status: "applied", nothingNew: true });

    const firstApproval = (await ok(memoryOf(ana, s2))).proposalId as string;
    const approvalsBefore = (await systemApprovals()).length;
    const before = summaryRequests().length;
    await restartWithTurn(ana, s2, "Also round the totals");
    // New work after the last proposal: the strip offers Propose again.
    await complete(ana, s2);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await systemApprovals()).toHaveLength(approvalsBefore + 1);
    const again = await ok(memoryOf(ana, s2));
    expect(again).toMatchObject({ status: "pending", auto: true, nothingNew: true });
    expect(again.proposalId).not.toBe(firstApproval);
    // Billed once more, to Ana, under its own subject (one record per subject and kind).
    const billed = (
      await su.query(
        "select subject_id from app.ai_usage_records where kind = 'session_summary' and requester_user_id = $1",
        [anaId],
      )
    ).rows.map((r) => r.subject_id as string);
    expect(billed.filter((id) => id === s2)).toHaveLength(1);
    expect(billed.length).toBe(new Set(billed).size);

    // Archived with nothing new: the automatic job finds nothing to say.
    await ok(ana.request("POST", `/api/v1/work-sessions/${s2}/archive`, {}));
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await systemApprovals()).toHaveLength(approvalsBefore + 1);
  });

  it("unmapped: no summary even with auto on; canMap follows 07.9's linking rule; linking then unlinking through 07.9", async () => {
    const s4 = await startSession(ana, device, notesRepo, { title: "Notes cleanup" });
    await turn(ana, s4, "Tidy the notes", "Tidied.");
    const before = summaryRequests().length;
    await complete(ana, s4);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before);

    // Ana manages no team project; Marta leads Billing and may use the MacBook; Sam may use it but manages nothing.
    expect(await ok(memoryOf(ana, s4))).toMatchObject({ status: "unmapped", unit: null, canMap: false });
    expect(await ok(memoryOf(marta, s4))).toMatchObject({
      status: "unmapped",
      canMap: true,
      canPropose: false,
    });
    expect(await ok(memoryOf(sam, s4))).toMatchObject({ status: "unmapped", canMap: false });
    // Marta on a device she cannot use (Ana's Laptop): 07.9 would refuse the link, so canMap is false.
    const onLaptop = await stack.built.core.db.withTenant({ organizationId: orgId, userId: martaId }, (tx) =>
      canMapFor(tx, createPermissionService(stack.built.core), martaId, {
        id: randomUUID(),
        createdBy: anaId,
        deviceId: laptopId,
      }),
    );
    expect(onLaptop).toBe(false);
    const unmapped = await propose(ana, s4);
    expect(unmapped.status).toBe(409);
    expect(errorCode(unmapped)).toBe("session_unmapped");

    // Linked through 07.9: the next completion proposes there.
    await ok(
      marta.request("POST", `/api/v1/work-projects/${billing.unitId}/repos`, { projectId: notesRepo }),
    );
    await restartWithTurn(ana, s4, "Add a README section");
    await complete(ana, s4);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    const proposed = await ok(memoryOf(ana, s4));
    expect(proposed).toMatchObject({ status: "pending", unit: { id: billing.unitId, name: "Billing" } });

    // Unlinked through 07.9: the proposal and its approval stay; the next completion is unmapped.
    await ok(marta.request("DELETE", `/api/v1/work-projects/${billing.unitId}/repos/${notesRepo}`));
    const kept = await su.query("select status from app.approval_requests where id = $1", [
      proposed.proposalId,
    ]);
    expect(kept.rows[0]?.status).toBe("pending");
    await restartWithTurn(ana, s4, "One more line");
    await complete(ana, s4);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(ana, s4))).toMatchObject({ status: "unmapped", unit: null });

    await ok(ana.request("PUT", "/api/v1/me/preferences", { autoProposeSessionSummaries: false }));
  });

  it("audience (D-11): an `owner` session is 404 and silent for everyone else, a lead included; the owner still hears it", async () => {
    const s5 = await startSession(ana, device, billingRepo, { title: "Private spike" });
    await turn(ana, s5, "Try an idea", "Tried.");
    await complete(ana, s5);
    expect(await drain()).toBe(1);
    // Marta reads it while the audience is the project.
    expect((await memoryOf(marta, s5)).status).toBe(200);

    await setAudience(ana, s5, { kind: "owner" });
    for (const other of [marta, sam]) expect((await memoryOf(other, s5)).status).toBe(404);
    const framesFrom = published.length;
    expect((await propose(ana, s5)).status).toBe(202);
    expect(await drain()).toBe(1);
    expect(await ok(memoryOf(ana, s5))).toMatchObject({ status: "pending" });
    expect(framesFor(anaId, s5, framesFrom).length).toBeGreaterThanOrEqual(2);
    // Marta was a reader until the audience narrowed: no later frame reaches her; Sam never read it.
    expect(framesFor(martaId, s5, framesFrom)).toEqual([]);
    expect(framesFor(samId, s5, framesFrom)).toEqual([]);
    expect((await propose(marta, s5)).status).toBe(404);
    expectNoSharedMemoryFrames();
  });

  it("a reader who is not the owner sees the state but cannot propose (403)", async () => {
    const m = await ok(memoryOf(marta, s1));
    expect(m).toMatchObject({ status: "applied", canPropose: false, model: null });
    const refused = await propose(marta, s1);
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe("not_session_owner");
  });

  it("the device owner outside the project reads the state without the project's name or id (07.10 D-14)", async () => {
    // Marta's session on Ana's MacBook in Billing; then Ana leaves Billing and reads it only as the device owner (D-11).
    const s6 = await startSession(marta, device, billingRepo, { title: "Marta on the MacBook" });
    await turn(marta, s6, "Check the invoices", "Checked.");
    await complete(marta, s6);
    await drain();
    expect(await ok(memoryOf(marta, s6))).toMatchObject({ unit: { id: billing.unitId, name: "Billing" } });

    await ok(admin.request("DELETE", `/api/v1/units/${billing.unitId}/members/${anaId}`));
    /** Ana's view in `status`: no project, no decider, no note (07.6 review C ME-02). */
    const hidden = async (status: string) => {
      const m = await ok(memoryOf(ana, s6));
      expect(m).toMatchObject({ status, unit: null, decidedBy: null, decisionNote: null, canPropose: false });
      for (const secret of ["Billing", billing.unitId, "Marta", martaId, "billing lead note"]) {
        expect(JSON.stringify(m), `memory carried "${secret}" (${status})`).not.toContain(secret);
      }
    };
    const decide = async (outcome: "approved" | "denied") => {
      const id = (await ok(memoryOf(marta, s6))).proposalId as string;
      const detail = await ok(marta.request("GET", `/api/v1/approvals/${id}`));
      await ok(
        marta.request("POST", `/api/v1/approvals/${id}/decision`, {
          outcome,
          actionHash: detail.actionHash,
          note: "billing lead note",
        }),
      );
    };
    try {
      await hidden("none");
      // The creator still reads it named (D-12).
      expect(await ok(memoryOf(marta, s6))).toMatchObject({ unit: { id: billing.unitId, name: "Billing" } });

      // Pending, then applied by Marta (a lead may decide her own session's summary, ADR-0023 §15).
      expect((await propose(marta, s6)).status).toBe(202);
      expect(await drain()).toBe(1);
      await hidden("pending");
      await decide("approved");
      expect(await ok(memoryOf(marta, s6))).toMatchObject({
        status: "applied",
        decidedBy: { id: martaId, displayName: "Marta" },
      });
      await hidden("applied");

      // New work, proposed again, denied.
      await restartWithTurn(marta, s6, "Check the totals too");
      await complete(marta, s6);
      await drain();
      expect((await propose(marta, s6)).status).toBe(202);
      expect(await drain()).toBe(1);
      await decide("denied");
      expect(await ok(memoryOf(marta, s6))).toMatchObject({
        status: "denied",
        decidedBy: { id: martaId, displayName: "Marta" },
        decisionNote: "billing lead note",
      });
      await hidden("denied");
    } finally {
      await ok(
        admin.request("POST", `/api/v1/units/${billing.unitId}/members`, { userId: anaId, role: "member" }),
      );
    }
  });

  it("organization B: every session route is 404 and its preferences are its own", async () => {
    await moveToOrgB(eveId);
    expect((await memoryOf(eve, s1)).status).toBe(404);
    expect((await propose(eve, s1)).status).toBe(404);
    expect(await ok(eve.request("GET", "/api/v1/me/preferences"))).toEqual({
      autoProposeSessionSummaries: false,
    });
    const count = await su.query("select count(*)::int as n from app.work_memory_prefs where user_id = $1", [
      eveId,
    ]);
    expect(count.rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------- 07.6 review C fixes

describe("recovery, taint and the memory check before billing (07.6 review C ME-01, LO-04, LO-05)", () => {
  /** A finished session of Ana in Billing with one edited file (automatic proposals are off for her here). */
  async function finished(title: string): Promise<string> {
    const id = await startSession(ana, device, billingRepo, { title });
    await turn(ana, id, `Work on ${title}`, "Done.");
    await complete(ana, id);
    await drain();
    return id;
  }

  const errorCodeOf = async (id: string) =>
    (await su.query("select error_code from app.work_session_memory where work_session_id = $1", [id]))
      .rows[0]?.error_code as string | undefined;

  it("a summary stuck in `writing` by a dead job reads as failed after 10 minutes and Propose enqueues it again", async () => {
    const s = await finished("Stuck summary");
    await su.query(
      `insert into app.work_session_memory (work_session_id, organization_id, unit_id, status, auto, updated_at)
       values ($1, $2, $3, 'writing', false, now())`,
      [s, orgId, billing.unitId],
    );
    // A fresh claim: a summary is being written; Propose says so instead of a 202 that enqueues nothing.
    expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "writing" });
    const busy = await propose(ana, s);
    expect(busy.status).toBe(409);
    expect(errorCode(busy)).toBe("summary_in_progress");
    expect(await drain()).toBe(0);

    await su.query(
      "update app.work_session_memory set updated_at = now() - interval '11 minutes' where work_session_id = $1",
      [s],
    );
    expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "failed" });
    const before = summaryRequests().length;
    expect((await propose(ana, s)).status).toBe(202);
    expect(await drain()).toBe(1);
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "pending" });
  });

  it("a proposal step that throws leaves the summary failed (the call billed once); Propose works again", async () => {
    const s = await finished("Throwing proposal");
    const before = summaryRequests().length;
    const spy = vi.spyOn(stack.built.memory, "propose").mockRejectedValueOnce(new Error("boom"));
    try {
      expect((await propose(ana, s)).status).toBe(202);
      expect(await drain()).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(summaryRequests()).toHaveLength(before + 1);
    expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "failed" });
    expect(await errorCodeOf(s)).toBe("propose_error");
    expect(await usageRows([s])).toHaveLength(1);

    expect((await propose(ana, s)).status).toBe(202);
    expect(await drain()).toBe(1);
    expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "pending" });
  });

  it("a summary over tool output is flagged as untrusted for its approver; one without tools is not", async () => {
    const taintOf = async (sessionId: string) => {
      const approvalId = (await ok(memoryOf(ana, sessionId))).proposalId as string;
      const r = await su.query(
        `select p.tainted from app.memory_proposals p join app.approval_requests a on a.resource_id = p.id
          where a.id = $1`,
        [approvalId],
      );
      return r.rows[0]?.tainted as boolean;
    };
    // s1's transcript has an Edit tool call; s2's last proposal covers only a restart with a prompt and an answer.
    expect(await taintOf(s1)).toBe(true);
    const s2 = (
      await su.query(
        "select id from app.work_sessions where title = 'Tax rounding' and created_by = $1 limit 1",
        [anaId],
      )
    ).rows[0]?.id as string;
    expect(await taintOf(s2)).toBe(false);
  });

  it("an owner who may not read the project's memory is never billed: no model call, failed memory_denied", async () => {
    const s = await finished("No memory for Ana");
    const rule = await ok(
      admin.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: anaId,
        permission: "memory.read",
        effect: "deny",
      }),
    );
    const daily = async () =>
      (
        await su.query(
          "select coalesce(sum(generations), 0)::int as n from app.ai_usage_daily where user_id = $1",
          [anaId],
        )
      ).rows[0]?.n as number;
    try {
      const before = { calls: summaryRequests().length, generations: await daily() };
      expect((await propose(ana, s)).status).toBe(202);
      expect(await drain()).toBe(1);
      expect(summaryRequests()).toHaveLength(before.calls);
      expect(await daily()).toBe(before.generations);
      expect(await usageRows([s])).toEqual([]);
      expect(await ok(memoryOf(ana, s))).toMatchObject({ status: "failed" });
      expect(await errorCodeOf(s)).toBe("memory_denied");
    } finally {
      await ok(admin.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });
});

// ---------------------------------------------------------------- Task 3: usage reports

describe("usage reports show digest and session-summary spend as their own rows (P-16)", () => {
  it("by model: session summaries and digests are separate rows, in the totals, never counted as answers", async () => {
    await su.query(
      `insert into app.ai_usage_records
         (organization_id, kind, requester_user_id, subject_id, backend, provider, model_id, input_tokens, output_tokens, estimated, cost_micros_usd)
       values ($1, 'digest', $2, $3, 'mock', 'mock', 'mock-model', 40, 10, false, 0)`,
      [orgId, anaId, randomUUID()],
    );
    // An estimated digest (the model stopped before reporting usage): its row's cost is approximate, never an answer.
    await su.query(
      `insert into app.ai_usage_records
         (organization_id, kind, requester_user_id, subject_id, backend, provider, model_id, input_tokens, output_tokens, estimated, cost_micros_usd)
       values ($1, 'digest', $2, $3, 'mock', 'mock', 'mock-model', 0, 0, true, 0)`,
      [orgId, anaId, randomUUID()],
    );
    const r = await ok(admin.request("GET", "/api/v1/ai-usage/report?groupBy=model&days=30"));
    const rows = r.rows as Json[];
    const summaries = rows.find((x) => (x.key as string).endsWith(" · session summaries"));
    const digests = rows.find((x) => (x.key as string).endsWith(" · digests"));
    expect(summaries).toMatchObject({ kind: "session_summary", generations: 0, estimatedGenerations: 0 });
    expect(digests).toMatchObject({ kind: "digest", estimatedGenerations: 0, estimatedRecords: 1 });
    expect(r.totals.estimatedRecords).toBeGreaterThanOrEqual(1);
    expect(summaries?.label).toMatch(/ · session summaries$/);
    expect(digests).toMatchObject({ generations: 0, inputTokens: 40, outputTokens: 10 });
    expect(digests?.label).toMatch(/ · digests$/);
    const sum = (k: string) => rows.reduce((n, x) => n + (x[k] as number), 0);
    expect(r.totals.inputTokens).toBe(sum("inputTokens"));
    expect(r.totals.generations).toBe(0);

    // The owner sees their own summaries in their report.
    const mine = await ok(ana.request("GET", "/api/v1/me/ai-usage/report?days=30"));
    expect((mine.rows as Json[]).some((x) => (x.key as string).endsWith(" · session summaries"))).toBe(true);
  });
});
