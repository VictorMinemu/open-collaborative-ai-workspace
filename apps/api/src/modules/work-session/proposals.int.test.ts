import { createHash, randomUUID } from "node:crypto";
import { AgentCard, AgentCardActionEvent, ApprovalDetail, ApprovalSummary } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  connectWithProject,
  invite,
  pairDevice,
} from "../../testing-workzone";

/**
 * Phase 07.5-08 (D-03, D-04, P-08, APPROVE-03, APPROVE-04): a bot proposes a Work Zone session as a `work_zone` card;
 * only the person whose turn it was can start it, through exactly the checks of a human start (`createWorkSession`),
 * in their own name, at `default`, with the first prompt marked as proposed by the bot. Real PostgreSQL + Redis.
 */

const CELL_TOKEN = "ocw-test-cell-token-work-zone-proposals-0123456789";
const PROMPT = "Fix the rounding error in invoice totals";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let sam: TestClient;
let orgId: string;
let samId: string;
let samBotId: string;
let samBotName: string;
let samDmId: string;
let device: FakeDevice;
let deviceId: string;
let projectId: string;

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(
  path: string,
  body: unknown,
  token = CELL_TOKEN,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** `as` writes in `dmId`; returns the delivered event id (its turn) of the bot there. */
async function freshTurn(
  as = sam,
  dmId = samDmId,
  text = "please start a session for this",
): Promise<string> {
  // This file delivers more turns than a personal bot's daily limit (30); that limit is not what is tested here.
  await su.query("delete from app.agent_usage_daily");
  const msg = await ok(as.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: text }));
  const rows = await eventually(async () => {
    const r = (
      await su.query(
        "select payload from app.stream_events where type = 'agent.mention.v1' and payload->'message'->>'id' = $1",
        [msg.id],
      )
    ).rows;
    return r.length > 0 ? r : undefined;
  });
  expect(rows).toHaveLength(1);
  return rows[0].payload.eventId as string;
}

/** A turn forced to carry the two Work Zone tools (a stale turn whose human never held, or lost, the grain). */
async function forceTools(eventId: string): Promise<string> {
  await su.query(
    `update app.agent_turns set tools = array_cat(tools, array['ocw_work_zone_projects','ocw_start_work_zone']),
       tool_flags = tool_flags || '{"ocw_work_zone_projects":{"untrustedOutput":false,"sideEffecting":false},"ocw_start_work_zone":{"untrustedOutput":false,"sideEffecting":true}}'::jsonb
     where event_id = $1 and not ('ocw_start_work_zone' = any(tools))`,
    [eventId],
  );
  return eventId;
}

const propose = (eventId: string, over: Json = {}, token = CELL_TOKEN) =>
  cell(
    "/work-zone/proposals",
    { eventId, agentId: samBotId, projectId, deviceId, prompt: PROMPT, ...over },
    token,
  );

const rowOf = async (table: string, where: string, args: unknown[]) =>
  (await su.query(`select * from app.${table} where ${where}`, args)).rows as Json[];

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

const detail = async (as: TestClient, id: string) =>
  ApprovalDetail.parse(await ok(as.request("GET", `/api/v1/approvals/${id}`)));

const decide = (as: TestClient, id: string, body: Json) =>
  as.request("POST", `/api/v1/approvals/${id}/decision`, body);

const cardFor = async (as: TestClient, messageId: string) =>
  AgentCard.parse(await ok(as.request("GET", `/api/v1/cards/${messageId}`)));

const cardActionsOf = async (messageId: string) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => AgentCardActionEvent.parse({ ...r.payload, seq: Number(r.seq) }));

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "developer"));
  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
  samBotName = personal.agent.name;
  samDmId = personal.dmId;
  const paired = await pairDevice(stack, sam, "MacBook Pro");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, sam, paired.token, {
    localId: "lp_billing",
    name: "billing-api",
  }));
  device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("tracer: a bot proposes, the person who asked starts it (APPROVE-03)", () => {
  it("POST /work-zone/proposals → proposal → work_zone card → Sam's Start → his session at default, proposed by the bot", async () => {
    const eventId = await freshTurn();
    const r = await propose(eventId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ approvalId: expect.any(String), created: true });
    const approvalId = r.body.approvalId as string;

    // One allowed tool call, one proposal, one pending approval that expires in 24 h.
    expect(await rowOf("agent_tool_calls", "event_id = $1", [eventId])).toEqual([
      expect.objectContaining({
        tool: "ocw_start_work_zone",
        decision: "allowed",
        agent_id: samBotId,
        user_id: samId,
      }),
    ]);
    const proposals = await rowOf("work_zone_proposals", "event_id = $1", [eventId]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      agent_id: samBotId,
      requested_for_user_id: samId,
      conversation_id: samDmId,
      project_id: projectId,
      device_id: deviceId,
      runtime: "claude-code",
      prompt: PROMPT,
      prompt_sha256: createHash("sha256").update(PROMPT).digest("hex"),
      work_session_id: null,
    });
    const [request] = await rowOf("approval_requests", "id = $1", [approvalId]);
    expect(request).toMatchObject({
      kind: "work_zone.start",
      mode: "server_apply",
      status: "pending",
      resource_type: "work_zone_proposal",
      resource_id: proposals[0]!.id,
      requested_by_agent_id: samBotId,
      requested_for_user_id: samId,
      event_id: eventId,
    });
    const ttl = request!.expires_at.getTime() - request!.created_at.getTime();
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(60_000);
    const cardMessageId = request!.card_message_id as string;
    expect(cardMessageId).toBeTruthy();

    // The platform-owned work_zone card in Sam's DM, with the UI-SPEC Surface 3 content.
    const [cardMessage] = await rowOf("messages", "id = $1", [cardMessageId]);
    expect(cardMessage).toMatchObject({
      conversation_id: samDmId,
      author_kind: "agent",
      author_id: samBotId,
    });
    const card = await cardFor(sam, cardMessageId);
    expect(card).toMatchObject({
      kind: "work_zone",
      status: "pending",
      platformOwned: true,
      title: "Start a session in billing-api",
    });
    expect(card.fields).toEqual([
      { label: "Project", value: "billing-api" },
      { label: "Device", value: "MacBook Pro · Online" },
      { label: "Runtime", value: "Claude Code" },
      { label: "Mode", value: "Supervised" },
      { label: "For", value: `Sam Lee · proposed by ${samBotName}` },
      { label: "Prompt", value: PROMPT },
    ]);
    expect(card.actions).toEqual([
      { kind: "approve", label: "Start session", denyLabel: "Dismiss" },
      { kind: "open", label: "Review", target: `/approvals/${approvalId}` },
    ]);
    expect(card.approval).toMatchObject({
      id: approvalId,
      status: "pending",
      requestedForUserId: samId,
      kind: "work_zone.start",
      display: "exact",
      deviceId,
      resultRoute: null,
      blocked: null,
    });
    expect(card.viewerCan).toContain("decide");

    // Audit: ids, runtime and the prompt's length only.
    const proposed = (await audits("work_zone.proposed")).at(-1);
    expect(proposed).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      agent_id: samBotId,
      user_id: samId,
      resource_type: "work_zone_proposal",
      resource_id: proposals[0]!.id,
      result: "success",
    });
    expect(proposed!.metadata).toEqual({
      proposalId: proposals[0]!.id,
      approvalId,
      eventId,
      projectId,
      deviceId,
      runtime: "claude-code",
      promptChars: PROMPT.length,
    });

    // The same call retried in the same turn: the same approval, nothing new.
    const again = await propose(eventId);
    expect(again.body).toEqual({ approvalId, created: false });
    expect(await rowOf("work_zone_proposals", "event_id = $1", [eventId])).toHaveLength(1);

    // The review: the whole proposal, Start possible.
    const review = await detail(sam, approvalId);
    expect(review.viewerCan).toEqual(["decide"]);
    expect(review.view).toMatchObject({
      type: "work_zone_proposal",
      title: "Start a session in billing-api",
      project: { id: projectId, name: "billing-api", removed: false },
      device: { id: deviceId, name: "MacBook Pro", online: true, usable: true },
      runtime: { id: "claude-code", label: "Claude Code", available: true },
      mode: "default",
      prompt: PROMPT,
      agent: { id: samBotId, displayName: samBotName },
      requestedFor: { id: samId, displayName: "Sam Lee" },
      origin: { kind: "dm" },
      workSessionId: null,
      startBlocked: null,
    });
    expect(review.headline).toMatchObject({ title: "Start a session in billing-api" });

    // Sam presses Start.
    const started = await decide(sam, approvalId, { outcome: "approved", actionHash: review.actionHash });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(ApprovalSummary.parse(started.body).status).toBe("applied");

    const sessions = await rowOf("work_sessions", "project_id = $1", [projectId]);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session).toMatchObject({ created_by: samId, permission_mode: "default", device_id: deviceId });
    const prompts = await rowOf("work_prompts", "work_session_id = $1", [session.id]);
    expect(prompts.map((p) => [p.author_user_id, p.proposed_by_agent_id, p.body])).toEqual([
      [samId, samBotId, PROMPT],
    ]);
    expect((await rowOf("work_zone_proposals", "event_id = $1", [eventId]))[0]!.work_session_id).toBe(
      session.id,
    );
    const start = await device.command("session.start", session.id);
    expect(start.payload.permissionMode).toBe("default");
    device.ack(start.id);

    const created = (await audits("work_session.created")).at(-1);
    expect(created).toMatchObject({ user_id: samId, actor_id: samId });
    expect(created!.metadata).toMatchObject({
      proposedByAgentId: samBotId,
      approvalId,
      permissionMode: "default",
    });

    // The card is done and links to the session; the bot hears Sam's decision as Sam's turn.
    const after = await cardFor(sam, cardMessageId);
    expect(after.status).toBe("succeeded");
    expect(after.approval).toMatchObject({ status: "applied", resultRoute: `/work-zone/${session.id}` });
    const actions = await cardActionsOf(cardMessageId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.cardAction).toMatchObject({
      kind: "work_zone",
      outcome: "approved",
      decidedBy: { id: samId },
    });
    expect(actions[0]!.message.author).toMatchObject({ kind: "user", id: samId });

    // Nothing ever logged the prompt.
    const all = (
      await su.query("select metadata::text as m from app.audit_events where organization_id = $1", [orgId])
    ).rows as Array<{ m: string }>;
    for (const a of all) expect(a.m).not.toContain("rounding");
  });
});

// ---------------------------------------------------------------- Task 2: refusals, Start failures, deciders, mode

const CLAUDE_READY = { id: "claude-code", installed: true, version: "2.1.287", loggedIn: true };

/** A device seeded directly (no connection), with one project on it. */
async function seedDevice(o: {
  owner: string;
  name: string;
  status?: "online" | "offline";
  runtimeInfo?: unknown[];
  shared?: boolean;
  project?: string;
}): Promise<{ deviceId: string; projectId: string }> {
  const id = randomUUID();
  const project = randomUUID();
  await su.query(
    `insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, status, runtime_info, shared)
     values ($1, $2, $3, $4, 'darwin', $5, $6, $7, $8)`,
    [
      id,
      orgId,
      o.owner,
      o.name,
      createHash("sha256").update(randomUUID()).digest("hex"),
      o.status ?? "online",
      JSON.stringify(o.runtimeInfo ?? [CLAUDE_READY]),
      o.shared ?? false,
    ],
  );
  await su.query(
    "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, $4, $5)",
    [project, orgId, id, `lp_${project.slice(0, 8)}`, o.project ?? "seeded"],
  );
  return { deviceId: id, projectId: project };
}

/** Rows a refused proposal must not leave behind. */
async function traces() {
  const n = async (q: string) => (await su.query(q)).rows[0].n as number;
  return {
    proposals: await n("select count(*)::int as n from app.work_zone_proposals"),
    approvals: await n("select count(*)::int as n from app.approval_requests"),
    cards: await n("select count(*)::int as n from app.message_cards"),
    sessions: await n("select count(*)::int as n from app.work_sessions"),
  };
}

/** The proposal is refused with `code`: 200, nothing stored or posted, and the refusal is on record. */
async function refused(eventId: string, over: Json, code: string, agentId = samBotId) {
  const before = await traces();
  const r = await propose(eventId, { agentId, ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toEqual({ refused: code });
  expect(await traces()).toEqual(before);
  const deniedCall = (
    await rowOf("agent_tool_calls", "event_id = $1 and decision = 'denied'", [eventId])
  ).some((c) => c.reason === code);
  const audited = (await audits("work_zone.proposal_refused")).some(
    (a) => a.metadata.eventId === eventId && a.metadata.reason === code,
  );
  expect(deniedCall || audited, `${code} recorded`).toBe(true);
}

/** Pending proposals stop counting against the cap (expired by the clock, never decided). */
const expirePending = () =>
  su.query(
    "update app.approval_requests set expires_at = now() where kind = 'work_zone.start' and status = 'pending'",
  );

/** A fresh turn with the tools, a proposal on `target`, and its review hash. */
async function proposed(target: { projectId: string; deviceId: string }, prompt = PROMPT) {
  const eventId = await freshTurn();
  const r = await propose(eventId, { ...target, prompt });
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ created: true });
  const approvalId = r.body.approvalId as string;
  const [row] = await rowOf("approval_requests", "id = $1", [approvalId]);
  return {
    eventId,
    approvalId,
    actionHash: row!.action_hash as string,
    cardMessageId: row!.card_message_id as string,
  };
}

const moduleAccess = (userId: string, enabled: boolean) =>
  ok(
    victor.request("PUT", "/api/v1/module-access", {
      module: "work_zone",
      scopeUnitId: null,
      subject: { kind: "user", userId },
      enabled,
    }),
  );

let stan: TestClient;
let stanBotId: string;
let stanDmId: string;
let marta: TestClient;

describe("refusals before any card (D-03, P-08, APPROVE-04)", () => {
  beforeAll(async () => {
    await expirePending();
    ({ client: stan } = await invite(stack, victor, "stan@example.test", "Stan", "standard"));
    const personal = await ok(stan.request("POST", "/api/v1/agents/personal", {}));
    stanBotId = personal.agent.id;
    stanDmId = personal.dmId;
  });

  it("tainted: a turn that read untrusted content cannot propose (the claim refuses it)", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
    try {
      const eventId = await freshTurn();
      const web = await cell("/tool-calls", {
        eventId,
        agentId: samBotId,
        tool: "web_search",
        params: { query: "rounding" },
      });
      expect(web.body).toMatchObject({ allowed: true });
      await refused(eventId, {}, "tainted");
    } finally {
      await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: false }));
    }
  });

  it("not_in_turn: a turn that does not carry the tool", async () => {
    const eventId = await freshTurn();
    await su.query(
      "update app.agent_turns set tools = array_remove(array_remove(tools, 'ocw_start_work_zone'), 'ocw_work_zone_projects') where event_id = $1",
      [eventId],
    );
    await refused(eventId, {}, "not_in_turn");
  });

  it("unknown_turn: an unknown event id or another bot's is a 404, with nothing stored", async () => {
    const before = await traces();
    const unknown = await propose(randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("unknown_turn");
    const eventId = await freshTurn();
    const foreign = await propose(eventId, { agentId: stanBotId });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("unknown_turn");
    expect(await traces()).toEqual(before);
    expect(await rowOf("agent_tool_calls", "event_id = $1", [eventId])).toEqual([]);
  });

  it("not_allowed: a standard member, and a developer under a Work Zone module deny (07.3)", async () => {
    // Stan holds no work_session.create: even a turn forced to carry the tool is refused.
    const stanEvent = await forceTools(await freshTurn(stan, stanDmId));
    await refused(stanEvent, {}, "not_allowed", stanBotId);

    const eventId = await freshTurn();
    await moduleAccess(samId, false);
    try {
      await refused(eventId, {}, "not_allowed");
    } finally {
      await moduleAccess(samId, true);
    }
  });

  it("project_not_found: removed, on another device, another organization's", async () => {
    const removed = await seedDevice({ owner: samId, name: "Old Mac" });
    await su.query("update app.projects set removed_at = now() where id = $1", [removed.projectId]);
    await refused(await freshTurn(), removed, "project_not_found");

    const other = await seedDevice({ owner: samId, name: "Sam's iMac" });
    await refused(await freshTurn(), { projectId, deviceId: other.deviceId }, "project_not_found");

    const orgB = randomUUID();
    const userB = randomUUID();
    const devB = randomUUID();
    const projB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
      orgB,
      `o-${orgB}`,
    ]);
    await su.query("insert into auth.user (id, name, email) values ($1, 'B', $2)", [
      userB,
      `${userB}@b.test`,
    ]);
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash, shared, status, runtime_info) values ($1, $2, $3, 'B mac', 'darwin', $4, true, 'online', $5)",
      [
        devB,
        orgB,
        userB,
        createHash("sha256").update(randomUUID()).digest("hex"),
        JSON.stringify([CLAUDE_READY]),
      ],
    );
    await su.query(
      "insert into app.projects (id, organization_id, device_id, local_id, name) values ($1, $2, $3, 'lb', 'secret')",
      [projB, orgB, devB],
    );
    await refused(await freshTurn(), { projectId: projB, deviceId: devB }, "project_not_found");
  });

  it("device_not_shared, device_offline, runtime_unavailable (Codex not installed, Claude Code signed out)", async () => {
    const victorId = (await ok(victor.request("GET", "/api/v1/me"))).user.id as string;
    const notShared = await seedDevice({ owner: victorId, name: "Víctor's Mac" });
    await refused(await freshTurn(), notShared, "device_not_shared");

    const offline = await seedDevice({ owner: samId, name: "Sleeping Mac", status: "offline" });
    await refused(await freshTurn(), offline, "device_offline");

    const claudeOnly = await seedDevice({ owner: samId, name: "Claude-only Mac" });
    await refused(await freshTurn(), { ...claudeOnly, runtime: "codex" }, "runtime_unavailable");
    const signedOut = await seedDevice({
      owner: samId,
      name: "Signed-out Mac",
      runtimeInfo: [{ ...CLAUDE_READY, loggedIn: false }],
    });
    await refused(await freshTurn(), signedOut, "runtime_unavailable");
  });

  it("prompt_not_allowed: a slash command, also behind spaces or a newline", async () => {
    for (const prompt of ["/permissions bypass", "  /permissions", "\n/model x"]) {
      await refused(await freshTurn(), { prompt }, "prompt_not_allowed");
    }
  });

  it("a mode, full access or a model in the body is a 400 and nothing is stored", async () => {
    const eventId = await freshTurn();
    const before = await traces();
    for (const extra of [
      { permissionMode: "fullAccess" },
      { fullAccess: true },
      { model: "claude-opus-5-5" },
    ]) {
      const r = await propose(eventId, extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await traces()).toEqual(before);
    expect(await rowOf("agent_tool_calls", "event_id = $1", [eventId])).toEqual([]);
  });

  it("too_many_pending: a fourth pending proposal for the same bot and person", async () => {
    await expirePending();
    for (const n of [1, 2, 3]) {
      const r = await propose(await freshTurn(), { prompt: `${PROMPT} (${n})` });
      expect(r.body).toMatchObject({ created: true });
    }
    await refused(await freshTurn(), { prompt: `${PROMPT} (4)` }, "too_many_pending");
    await expirePending();
  });
});

describe("failures at Start leave the proposal failed, with no session (Pitfall 9)", () => {
  beforeEach(expirePending);

  const startFails = async (
    target: { projectId: string; deviceId: string },
    change: () => Promise<unknown>,
    code: string,
  ) => {
    const p = await proposed(target);
    await change();
    const before = await traces();
    const r = await decide(sam, p.approvalId, { outcome: "approved", actionHash: p.actionHash });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ApprovalSummary.parse(r.body)).toMatchObject({ status: "failed", resultCode: code });
    expect((await traces()).sessions).toBe(before.sessions);
    expect(await rowOf("work_sessions", "project_id = $1", [target.projectId])).toEqual([]);
    const card = await cardFor(sam, p.cardMessageId);
    expect(card.status).toBe("failed");
    expect(card.approval).toMatchObject({ status: "failed", resultCode: code, resultRoute: null });
  };

  it("the device went offline", async () => {
    const t = await seedDevice({ owner: samId, name: "Laptop A" });
    await startFails(
      t,
      () => su.query("update app.devices set status = 'offline' where id = $1", [t.deviceId]),
      "device_offline",
    );
  });

  it("the project was removed", async () => {
    const t = await seedDevice({ owner: samId, name: "Laptop B" });
    await startFails(
      t,
      () => su.query("update app.projects set removed_at = now() where id = $1", [t.projectId]),
      "project_not_found",
    );
  });

  it("the device is no longer shared with Sam", async () => {
    const victorId = (await ok(victor.request("GET", "/api/v1/me"))).user.id as string;
    const t = await seedDevice({ owner: victorId, name: "Shared Mac", shared: true });
    await startFails(
      t,
      () => su.query("update app.devices set shared = false where id = $1", [t.deviceId]),
      "device_not_shared",
    );
  });

  it("the runtime signed out", async () => {
    const t = await seedDevice({ owner: samId, name: "Laptop C" });
    await startFails(
      t,
      () =>
        su.query("update app.devices set runtime_info = $2 where id = $1", [
          t.deviceId,
          JSON.stringify([{ ...CLAUDE_READY, loggedIn: false }]),
        ]),
      "runtime_unavailable",
    );
  });
});

describe("only the person who asked starts it, never above default (D-03, D-04)", () => {
  beforeAll(async () => {
    await expirePending();
    let martaId: string;
    ({ client: marta, userId: martaId } = await invite(
      stack,
      victor,
      "marta@example.test",
      "Marta Gil",
      "lead",
    ));
    const unit = (
      await ok(
        victor.request("POST", "/api/v1/units", { kind: "department", name: "Billing", parentId: null }),
      )
    ).id as string;
    await ok(victor.request("POST", `/api/v1/units/${unit}/members`, { userId: samId }));
    await ok(victor.request("POST", `/api/v1/units/${unit}/members`, { userId: martaId, role: "lead" }));
  });
  beforeEach(expirePending);

  it("Sam's lead and an admin get 404 on the review and on the decision", async () => {
    const p = await proposed({ projectId, deviceId });
    for (const other of [marta, victor]) {
      expect((await other.request("GET", `/api/v1/approvals/${p.approvalId}`)).status).toBe(404);
      const r = await decide(other, p.approvalId, { outcome: "approved", actionHash: p.actionHash });
      expect(r.status, JSON.stringify(r.body)).toBe(404);
    }
    expect((await rowOf("approval_requests", "id = $1", [p.approvalId]))[0]!.status).toBe("pending");
  });

  it("once Sam loses work_session.create his Start is 403 not_approver and the review says not_allowed", async () => {
    const p = await proposed({ projectId, deviceId });
    await moduleAccess(samId, false);
    try {
      const r = await decide(sam, p.approvalId, { outcome: "approved", actionHash: p.actionHash });
      expect(r.status).toBe(403);
      expect(r.body!.error).toMatchObject({ code: "not_approver" });
      const review = await detail(sam, p.approvalId);
      expect(review.view).toMatchObject({ type: "work_zone_proposal", startBlocked: "not_allowed" });
      expect(review.viewerCan).toEqual([]);
    } finally {
      await moduleAccess(samId, true);
    }
  });

  it("with full access allowed everywhere for Sam, Start still creates the session at default", async () => {
    await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: true }));
    device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], true);
    await eventually(async () => {
      const r = await su.query("select full_access_opt_in from app.devices where id = $1", [deviceId]);
      return r.rows[0].full_access_opt_in === true;
    });
    try {
      const controls = await ok(
        sam.request("GET", `/api/v1/work-zone/controls?deviceId=${deviceId}&runtime=claude-code`),
      );
      const modes = controls.permissionModes as Array<{ value: string; available: boolean }>;
      expect(modes.find((m) => m.value === "fullAccess")?.available).toBe(true);

      const p = await proposed({ projectId, deviceId }, "Upgrade the invoice library");
      const r = await decide(sam, p.approvalId, { outcome: "approved", actionHash: p.actionHash });
      expect(ApprovalSummary.parse(r.body).status).toBe("applied");
      const [proposal] = await rowOf("work_zone_proposals", "event_id = $1", [p.eventId]);
      const [session] = await rowOf("work_sessions", "id = $1", [proposal!.work_session_id]);
      expect(session).toMatchObject({ created_by: samId, permission_mode: "default" });
      const start = await device.command("session.start", session!.id);
      expect(start.payload.permissionMode).toBe("default");
      device.ack(start.id);
    } finally {
      device.capabilities([CLAUDE_CATALOG, CODEX_CATALOG], false);
      await ok(victor.request("PUT", "/api/v1/work-zone-policy", { allowFullAccess: false }));
    }
  });

  it("Dismiss starts nothing and the bot hears it with the note", async () => {
    const p = await proposed({ projectId, deviceId }, "Rename the billing module");
    const before = await traces();
    const r = await decide(sam, p.approvalId, {
      outcome: "denied",
      actionHash: p.actionHash,
      note: "Not now",
    });
    expect(ApprovalSummary.parse(r.body)).toMatchObject({ status: "denied", decisionNote: "Not now" });
    expect((await traces()).sessions).toBe(before.sessions);
    expect((await rowOf("work_zone_proposals", "event_id = $1", [p.eventId]))[0]!.work_session_id).toBeNull();
    expect((await cardFor(sam, p.cardMessageId)).status).toBe("cancelled");
    const actions = await cardActionsOf(p.cardMessageId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.cardAction).toMatchObject({ outcome: "denied", decidedBy: { id: samId } });
    expect(actions[0]!.message.text).toContain("Not now");
  });
});

// ---------------------------------------------------------------- Task 3: turn offering, project list, tenants

const WORK_ZONE_TOOLS = ["ocw_work_zone_projects", "ocw_start_work_zone"];

const turnOf = async (eventId: string) => (await rowOf("agent_turns", "event_id = $1", [eventId]))[0]!;

describe("turn offering (D-03, P-08): only for a human who may start sessions", () => {
  it("Sam (developer) gets both tools after the card tool, with their flags; the mention carries them too", async () => {
    const eventId = await freshTurn();
    const turn = await turnOf(eventId);
    const tools = turn.tools as string[];
    const card = tools.indexOf("ocw_agent_card");
    expect(card).toBeGreaterThanOrEqual(0);
    expect(tools.slice(card + 1, card + 3)).toEqual(WORK_ZONE_TOOLS);
    expect(turn.tool_flags.ocw_work_zone_projects).toEqual({ untrustedOutput: false, sideEffecting: false });
    expect(turn.tool_flags.ocw_start_work_zone).toEqual({ untrustedOutput: false, sideEffecting: true });
    const [mention] = (
      await su.query(
        "select payload from app.stream_events where type = 'agent.mention.v1' and payload->>'eventId' = $1",
        [eventId],
      )
    ).rows;
    expect(mention.payload.turn.tools).toEqual(tools);
  });

  it("a standard member and a developer under a Work Zone module deny get neither", async () => {
    const stanTurn = await turnOf(await freshTurn(stan, stanDmId));
    for (const t of WORK_ZONE_TOOLS) expect(stanTurn.tools).not.toContain(t);
    expect(stanTurn.tools).toContain("ocw_agent_card");

    const { client: dana, userId: danaId } = await invite(
      stack,
      victor,
      "dana@example.test",
      "Dana",
      "developer",
    );
    const danaBot = await ok(dana.request("POST", "/api/v1/agents/personal", {}));
    expect((await turnOf(await freshTurn(dana, danaBot.dmId))).tools).toEqual(
      expect.arrayContaining(WORK_ZONE_TOOLS),
    );
    await moduleAccess(danaId, false);
    try {
      const denied = await turnOf(await freshTurn(dana, danaBot.dmId));
      for (const t of WORK_ZONE_TOOLS) expect(denied.tools).not.toContain(t);
    } finally {
      await moduleAccess(danaId, true);
    }
  });

  it("the call-time re-decision agrees: the grain revoked mid-turn is policy_changed at the gate, not_allowed here", async () => {
    const eventId = await freshTurn();
    await moduleAccess(samId, false);
    try {
      const gate = await cell("/tool-calls", {
        eventId,
        agentId: samBotId,
        tool: "ocw_start_work_zone",
        params: {},
      });
      expect(gate.body).toMatchObject({ allowed: false, reason: "policy_changed" });
      await refused(eventId, {}, "not_allowed");
    } finally {
      await moduleAccess(samId, true);
    }
  });
});

describe("POST /work-zone/projects: names and ids, devices Sam may use (principle 7)", () => {
  it("lists his own and shared devices' projects with online state and runtimes, never a path", async () => {
    const victorId = (await ok(victor.request("GET", "/api/v1/me"))).user.id as string;
    const shared = await seedDevice({
      owner: victorId,
      name: "Team Mac",
      shared: true,
      project: "design-system",
    });
    await seedDevice({ owner: victorId, name: "Private Mac", project: "secret-plans" });
    const gone = await seedDevice({ owner: samId, name: "Retired Mac", project: "old-app" });
    await su.query("update app.projects set removed_at = now() where id = $1", [gone.projectId]);

    const eventId = await freshTurn();
    const r = await cell("/work-zone/projects", { eventId, agentId: samBotId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = r.body.projects as Json[];
    expect(list.find((p) => p.projectId === projectId)).toEqual({
      projectId,
      name: "billing-api",
      device: { id: deviceId, name: "MacBook Pro", online: true },
      runtimes: [
        { id: "claude-code", label: "Claude Code", available: true },
        { id: "codex", label: "Codex", available: false },
      ],
    });
    expect(list.find((p) => p.projectId === shared.projectId)).toMatchObject({
      name: "design-system",
      device: { id: shared.deviceId, name: "Team Mac", online: true },
    });
    const names = list.map((p) => p.name);
    expect(names).not.toContain("secret-plans");
    expect(names).not.toContain("old-app");
    // Names and ids only: no local id, git remote, branch or anything shaped like a host path.
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/lp_|localId|gitRemote|path|\/Users|\\\\/);
    expect(await rowOf("agent_tool_calls", "event_id = $1", [eventId])).toEqual([
      expect.objectContaining({ tool: "ocw_work_zone_projects", decision: "allowed" }),
    ]);
  });

  it("a tainted turn may still list (read-only), but no longer propose", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
    try {
      const eventId = await freshTurn();
      const web = await cell("/tool-calls", {
        eventId,
        agentId: samBotId,
        tool: "web_search",
        params: { query: "x" },
      });
      expect(web.body).toMatchObject({ allowed: true });
      const r = await cell("/work-zone/projects", { eventId, agentId: samBotId });
      expect(r.status).toBe(200);
      expect((r.body.projects as Json[]).length).toBeGreaterThan(0);
      await refused(eventId, {}, "tainted");
    } finally {
      await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: false }));
    }
  });

  it("not_in_turn and unknown_turn on the list", async () => {
    const eventId = await freshTurn();
    await su.query(
      "update app.agent_turns set tools = array_remove(tools, 'ocw_work_zone_projects') where event_id = $1",
      [eventId],
    );
    const refusedList = await cell("/work-zone/projects", { eventId, agentId: samBotId });
    expect(refusedList.status).toBe(409);
    expect(refusedList.body.error.code).toBe("not_in_turn");
    const unknown = await cell("/work-zone/projects", { eventId: randomUUID(), agentId: samBotId });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("unknown_turn");
  });
});

describe("tenant isolation (C-02): organization B never reaches organization A", () => {
  let tokenB: string;
  let eve: TestClient;
  let orgB: string;

  beforeAll(async () => {
    // Eve joins A, then her membership moves to a fresh organization B where she is the admin.
    let eveId: string;
    ({ client: eve, userId: eveId } = await invite(stack, victor, "eve@example.test", "Eve", "standard"));
    orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    await su.query("delete from auth.member where user_id = $1", [eveId]);
    await su.query("delete from app.org_members where user_id = $1", [eveId]);
    await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
      orgB,
      eveId,
    ]);
    await su.query(
      "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
      [orgB, eveId],
    );
    await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
    tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, createHash("sha256").update(tokenB).digest("hex")],
    );
  });

  it("B's cell with A's event id: 404 unknown_turn on both routes, nothing claimed or stored", async () => {
    const eventId = await freshTurn();
    const before = await traces();
    const list = await cell("/work-zone/projects", { eventId, agentId: samBotId }, tokenB);
    expect(list.status, JSON.stringify(list.body)).toBe(404);
    expect(list.body.error.code).toBe("unknown_turn");
    const p = await propose(eventId, {}, tokenB);
    expect(p.status).toBe(404);
    expect(p.body.error.code).toBe("unknown_turn");
    expect(await traces()).toEqual(before);
    expect(await rowOf("agent_tool_calls", "event_id = $1", [eventId])).toEqual([]);
    expect((await turnOf(eventId)).tool_calls).toBe(0);
  });

  it("B's own turn naming A's project and device is refused project_not_found; B's list shows none of A's", async () => {
    const bot = await ok(eve.request("POST", "/api/v1/agents/personal", {}));
    const eventB = await freshTurn(eve, bot.dmId);
    expect((await turnOf(eventB)).organization_id).toBe(orgB);
    const before = await traces();
    const r = await cell(
      "/work-zone/proposals",
      { eventId: eventB, agentId: bot.agent.id, projectId, deviceId, prompt: PROMPT },
      tokenB,
    );
    expect(r.body).toEqual({ refused: "project_not_found" });
    expect(await traces()).toEqual(before);
    const list = await cell("/work-zone/projects", { eventId: eventB, agentId: bot.agent.id }, tokenB);
    expect(list.body).toEqual({ projects: [] });
  });

  it("a member of B gets 404 on A's approval", async () => {
    const [a] = await rowOf("approval_requests", "kind = 'work_zone.start' and organization_id = $1", [
      orgId,
    ]);
    expect((await eve.request("GET", `/api/v1/approvals/${a!.id}`)).status).toBe(404);
    const d = await decide(eve, a!.id as string, { outcome: "approved", actionHash: a!.action_hash });
    expect(d.status).toBe(404);
  });
});
