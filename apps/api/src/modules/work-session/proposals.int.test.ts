import { createHash } from "node:crypto";
import { AgentCard, AgentCardActionEvent, ApprovalDetail, ApprovalSummary } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** TEMPORARY until turn offering (Task 3): the two Work Zone tools on a delivered turn. */
async function offerTools(eventId: string): Promise<string> {
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
    const eventId = await offerTools(await freshTurn());
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
