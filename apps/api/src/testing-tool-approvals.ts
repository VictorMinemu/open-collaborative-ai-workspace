import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect } from "vitest";
import type { ApprovalOutcome, ToolCallSource } from "./modules/tool-approval";
import { TEST_SETUP_TOKEN, TestClient } from "./testing";
import { type AiStack, seedPlan, startAiStack } from "./testing-ai";
import { invite } from "./testing-workzone";

/**
 * Shared fixture of the `tool.call` approval integration tests (07.5-07): the full API on real PostgreSQL + Redis with
 * log capture. Organization A: Víctor (admin), Sam Lee (standard, Sales member; his bot Keeper asks), Marta Gil (lead
 * of Sales), Luis Mora and Dana Cole (standard); Sales East is a team under Sales, Marketing a separate department.
 * Organization B: Eve (admin). One org MCP server "Notes" (safe name `m1a2b3c4d`) whose `write_note` tool is approved.
 * Turns are seeded straight into `agent_turns` (the delivery ledger), each replying to a real message of its human.
 */

export const CELL_TOKEN = "ocw-test-cell-token-tool-call-approvals-0123456789";
export const SAFE = "m1a2b3c4d";
export const TOOL = `${SAFE}__write_note`;
const TOOL_HASH_FORMAT = /^[0-9a-f]{64}$/;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
export type Json = Record<string, any>;

export interface Fixture {
  stack: AiStack;
  su: pg.Client;
  orgA: string;
  orgB: string;
  victor: TestClient;
  sam: TestClient;
  marta: TestClient;
  luis: TestClient;
  dana: TestClient;
  eve: TestClient;
  victorId: string;
  samId: string;
  martaId: string;
  luisId: string;
  danaId: string;
  eveId: string;
  sales: string;
  salesEast: string;
  marketing: string;
  keeperId: string;
  notesId: string;
  /** Sam's DM with Keeper (Sam is its single human). */
  dm: string;
  source: ToolCallSource;
}

export interface SeededTurn {
  eventId: string;
  organizationId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  messageId: string;
}

export async function ok(
  res: Promise<{ status: number; body: Record<string, unknown> | null }>,
  status = 200,
): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

export async function startToolApprovalFixture(): Promise<Fixture> {
  const stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  const su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  const orgA = (setup.organization as Json).id as string;
  const victorId = (setup.user as Json).id as string;
  const { client: sam, userId: samId } = await invite(
    stack,
    victor,
    "sam@example.test",
    "Sam Lee",
    "standard",
  );
  const { client: marta, userId: martaId } = await invite(
    stack,
    victor,
    "marta@example.test",
    "Marta Gil",
    "lead",
  );
  const { client: luis, userId: luisId } = await invite(
    stack,
    victor,
    "luis@example.test",
    "Luis Mora",
    "standard",
  );
  const { client: dana, userId: danaId } = await invite(
    stack,
    victor,
    "dana@example.test",
    "Dana Cole",
    "standard",
  );
  const { client: eve, userId: eveId } = await invite(
    stack,
    victor,
    "eve@example.test",
    "Eve Black",
    "standard",
  );

  const unit = async (kind: string, name: string, parentId: string | null) =>
    (await ok(victor.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;
  const sales = await unit("department", "Sales", null);
  const salesEast = await unit("team", "Sales East", sales);
  const marketing = await unit("department", "Marketing", null);
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: martaId, role: "lead" }));
  await ok(victor.request("POST", `/api/v1/units/${sales}/members`, { userId: samId }));
  await ok(victor.request("POST", `/api/v1/units/${marketing}/members`, { userId: danaId }));

  // Org B: Eve moves into her own organization as its admin.
  const orgB = randomUUID();
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

  await seedPlan(victor);
  const keeperId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Keeper",
        username: "keeper",
        instructions: "You are Keeper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  const notesId = randomUUID();
  await su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
     values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
    [notesId, orgA, SAFE],
  );
  const dm = (
    await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  return {
    stack,
    su,
    orgA,
    orgB,
    victor,
    sam,
    marta,
    luis,
    dana,
    eve,
    victorId,
    samId,
    martaId,
    luisId,
    danaId,
    eveId,
    sales,
    salesEast,
    marketing,
    keeperId,
    notesId,
    dm,
    source: { kind: "mcp", id: notesId, target: SAFE },
  };
}

export async function stopToolApprovalFixture(f: Fixture | undefined): Promise<void> {
  await f?.su.end();
  await f?.stack.stop();
}

/** One org-wide rule (or a unit rule) for the tool, replacing every rule there was. */
export async function setRule(
  f: Fixture,
  rule: {
    mode: "never" | "always" | "when_tainted";
    approverKind?: "requester" | "users" | "unit_leads" | "admins";
    approverUserIds?: string[];
    scopeUnitId?: string | null;
    pattern?: string;
  },
): Promise<string> {
  await f.su.query("delete from app.tool_approval_policies where organization_id = $1", [f.orgA]);
  const { rows } = await f.su.query(
    `insert into app.tool_approval_policies
       (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
    [
      f.orgA,
      rule.scopeUnitId ?? null,
      rule.pattern ?? TOOL,
      rule.mode,
      rule.approverKind ?? "requester",
      rule.approverUserIds ?? [],
      f.victorId,
    ],
  );
  return rows[0].id as string;
}

export async function clearRules(f: Fixture): Promise<void> {
  await f.su.query("delete from app.tool_approval_policies where organization_id = $1", [f.orgA]);
}

/** Every request of the kind and its stored action, so each test starts from none. */
export async function clearRequests(f: Fixture): Promise<void> {
  await f.su.query("delete from app.approval_requests where organization_id = $1 and kind = 'tool.call'", [
    f.orgA,
  ]);
  await f.su.query("delete from app.agent_tool_calls where organization_id = $1", [f.orgA]);
  await f.su.query("delete from app.tool_call_approvals where organization_id = $1", [f.orgA]);
}

/** A delivered turn of `agentId` for `userId` in `conversationId`, replying to a real message `userClient` posts. */
export async function seedTurn(
  f: Fixture,
  p: {
    conversationId?: string;
    conversationKind?: string;
    userId?: string;
    userClient?: TestClient;
    agentId?: string;
    tainted?: boolean;
    threadRootId?: string;
  } = {},
): Promise<SeededTurn> {
  const conversationId = p.conversationId ?? f.dm;
  const client = p.userClient ?? f.sam;
  const userId = p.userId ?? f.samId;
  const agentId = p.agentId ?? f.keeperId;
  const posted = await ok(
    client.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `please write the note ${randomUUID().slice(0, 6)}`,
      ...(p.threadRootId ? { threadRootId: p.threadRootId } : {}),
    }),
  );
  const eventId = randomUUID();
  await f.su.query(
    `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, tools, tainted)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      eventId,
      f.orgA,
      agentId,
      userId,
      conversationId,
      p.conversationKind ?? "dm",
      posted.id,
      [TOOL],
      p.tainted ?? false,
    ],
  );
  return {
    eventId,
    organizationId: f.orgA,
    agentId,
    userId,
    conversationId,
    messageId: posted.id as string,
  };
}

/** `approvalForCall` in one transaction opened as the turn's human (as the agent-action routes do, 07.5-11). */
export function callFor(
  f: Fixture,
  turn: SeededTurn,
  args: Record<string, unknown> | null,
  opts: { toolCallId?: string | null; tool?: string; organizationId?: string } = {},
): Promise<ApprovalOutcome> {
  return f.stack.built.core.db.withTenant(
    { organizationId: opts.organizationId ?? f.orgA, userId: turn.userId },
    (tx) =>
      f.stack.built.toolApprovals.approvalForCall(tx, {
        turn,
        tool: opts.tool ?? TOOL,
        args,
        toolCallId: opts.toolCallId === undefined ? randomUUID() : opts.toolCallId,
        source: f.source,
      }),
  );
}

export async function approvalRow(f: Fixture, id: string): Promise<Json> {
  return (await f.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;
}

export async function storedAction(f: Fixture, approvalId: string): Promise<Json> {
  return (
    await f.su.query(
      "select t.* from app.tool_call_approvals t join app.approval_requests r on r.resource_id = t.id where r.id = $1",
      [approvalId],
    )
  ).rows[0] as Json;
}

export async function countRows(
  f: Fixture,
  table: "tool_call_approvals" | "approval_requests",
): Promise<number> {
  const { rows } = await f.su.query(
    `select count(*)::int as n from app.${table} where organization_id = $1${table === "approval_requests" ? " and kind = 'tool.call'" : ""}`,
    [f.orgA],
  );
  return rows[0].n as number;
}

/** Decides through the inbox route with the hash the request carries. */
export async function decideAs(
  f: Fixture,
  client: TestClient,
  id: string,
  outcome: "approved" | "denied",
): Promise<{ status: number; body: Json | null }> {
  const row = await approvalRow(f, id);
  expect(row.action_hash).toMatch(TOOL_HASH_FORMAT);
  return client.request("POST", `/api/v1/approvals/${id}/decision`, {
    outcome,
    actionHash: row.action_hash,
  }) as Promise<{ status: number; body: Json | null }>;
}

/** The required outcome's approval id (fails the test on any other outcome). */
export function requiredId(o: ApprovalOutcome): string {
  if (o.kind !== "required") throw new Error(`expected required, got ${JSON.stringify(o)}`);
  return o.approvalId;
}
