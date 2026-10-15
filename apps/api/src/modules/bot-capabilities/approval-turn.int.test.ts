import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  CELL_TOKEN,
  clearRules,
  type Fixture,
  type Json,
  ok,
  SAFE,
  startToolApprovalFixture,
  stopToolApprovalFixture,
} from "../../testing-tool-approvals";
import { createPermissionService } from "../organization";
import { currentTurnTools } from "./index";

/**
 * 07.5-11 (D-01, D-04, APPROVE-01): every delivered turn flags the offered tools that have an effective `always` or
 * `when_tainted` rule for (bot, human) with `toolFlags[tool].approval`, so the cell sends exactly those calls' arguments;
 * the call-time re-decision computes the same flags, and the cell-wide view (`GET /cell`, no human) carries tool names
 * only. Real PostgreSQL + Redis; the cast is `testing-tool-approvals.ts` (Sam in Sales, Dana in Marketing, Keeper).
 */

let f: Fixture;
let danaDm = "";
const WRITE = `${SAFE}__write_note`;
const ECHO = `${SAFE}__echo`;
const DELETE = `${SAFE}__delete_note`;

async function addRule(p: { scopeUnitId: string | null; pattern: string; mode: "always" | "when_tainted" }) {
  await f.su.query(
    `insert into app.tool_approval_policies
       (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
     values ($1, $2, $3, $4, 'requester', '{}', $5, $5)`,
    [f.orgA, p.scopeUnitId, p.pattern, p.mode, f.victorId],
  );
}

/** `who` writes in `conversationId`; returns Keeper's delivered `agent.mention.v1` payload (its turn). */
async function turnOf(who: TestClient, conversationId: string): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `note this ${randomUUID().slice(0, 6)}`,
    }),
  );
  const rows = (
    await f.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${f.orgA}`, msg.id, f.keeperId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

async function cellSnapshot(): Promise<Json> {
  const res = await fetch(`${f.stack.baseUrl}/agent-channel/v1/cell`, {
    headers: { authorization: `Bearer ${CELL_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

const keeperCellTools = async () =>
  ((await cellSnapshot()).agents as Json[]).find((a) => a.id === f.keeperId)?.capabilities.tools as string[];

beforeAll(async () => {
  f = await startToolApprovalFixture();
  // Notes (an org MCP server) offers three tools: write_note and delete_note change things, echo only reads.
  for (const [name, readOnly] of [
    ["write_note", false],
    ["echo", true],
    ["delete_note", false],
  ] as const) {
    await f.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [f.orgA, f.notesId, name, `${SAFE}__${name}`, readOnly],
    );
  }
  await ok(
    f.victor.request("PATCH", `/api/v1/agents/${f.keeperId}/capabilities`, {
      tools: [WRITE, ECHO, DELETE].map((tool) => ({ sourceKind: "mcp", sourceId: f.notesId, tool })),
    }),
  );
  danaDm = (
    await ok(f.dana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: f.keeperId }] }))
  ).id as string;
}, 180_000);

afterAll(async () => {
  await stopToolApprovalFixture(f);
});

beforeEach(async () => {
  await clearRules(f);
});

describe("turn flags for tools with an approval rule (07.5-11, D-01)", () => {
  it("without any rule no offered tool carries an approval flag", async () => {
    const ev = await turnOf(f.sam, f.dm);
    expect(ev.turn.tools).toEqual(expect.arrayContaining([WRITE, ECHO, DELETE]));
    for (const tool of ev.turn.tools as string[])
      expect(ev.turn.toolFlags[tool]).not.toHaveProperty("approval");
    expect(ev.turn.toolFlags[WRITE]).toEqual({ untrustedOutput: true, sideEffecting: true });
  });

  it("an org `always` rule and a Sales `when_tainted` rule: Sam's turn flags both, Dana's (Marketing) only the org one", async () => {
    await addRule({ scopeUnitId: null, pattern: WRITE, mode: "always" });
    await addRule({ scopeUnitId: f.sales, pattern: ECHO, mode: "when_tainted" });

    const sam = await turnOf(f.sam, f.dm);
    expect(sam.turn.toolFlags[WRITE]).toEqual({
      untrustedOutput: true,
      sideEffecting: true,
      approval: "always",
    });
    expect(sam.turn.toolFlags[ECHO]).toEqual({
      untrustedOutput: true,
      sideEffecting: false,
      approval: "when_tainted",
    });
    // Tools without a rule (delete_note, the built-ins) have no approval key at all.
    for (const tool of (sam.turn.tools as string[]).filter((t) => t !== WRITE && t !== ECHO)) {
      expect(sam.turn.toolFlags[tool], tool).not.toHaveProperty("approval");
    }
    // The ledger row carries the same flags the cell received.
    const row = (
      await f.su.query("select tool_flags from app.agent_turns where event_id = $1", [sam.eventId])
    ).rows[0];
    expect(row.tool_flags).toEqual(sam.turn.toolFlags);

    const dana = await turnOf(f.dana, danaDm);
    expect(dana.turn.toolFlags[WRITE]).toMatchObject({ approval: "always" });
    expect(dana.turn.toolFlags[ECHO]).toEqual({ untrustedOutput: true, sideEffecting: false });
  });

  it("currentTurnTools (the call-time re-decision) computes the same flags as the delivery", async () => {
    await addRule({ scopeUnitId: null, pattern: WRITE, mode: "always" });
    await addRule({ scopeUnitId: f.sales, pattern: ECHO, mode: "when_tainted" });
    const ev = await turnOf(f.sam, f.dm);
    const { core } = f.stack.built;
    const now = await core.db.withTenant({ organizationId: f.orgA, userId: f.samId }, (tx) =>
      currentTurnTools(
        tx,
        createPermissionService(core),
        { agentId: f.keeperId, humanUserId: f.samId, conversationKind: "dm", conversationId: f.dm },
        core.env,
      ),
    );
    expect(now).toEqual({ tools: ev.turn.tools, toolFlags: ev.turn.toolFlags });
  });

  it("a server-wide pattern flags every tool of that server; `never` flags nothing", async () => {
    await addRule({ scopeUnitId: null, pattern: `${SAFE}__*`, mode: "always" });
    const ev = await turnOf(f.sam, f.dm);
    for (const tool of [WRITE, ECHO, DELETE])
      expect(ev.turn.toolFlags[tool]).toMatchObject({ approval: "always" });

    await clearRules(f);
    await f.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'never', 'requester', '{}', $3, $3)`,
      [f.orgA, WRITE, f.victorId],
    );
    const never = await turnOf(f.sam, f.dm);
    expect(never.turn.toolFlags[WRITE]).not.toHaveProperty("approval");
  });

  it("the cell-wide view (GET /cell) carries the same static tool names with or without rules, never a flag", async () => {
    const before = await keeperCellTools();
    expect(before).toEqual(expect.arrayContaining([WRITE, ECHO, DELETE]));
    await addRule({ scopeUnitId: null, pattern: WRITE, mode: "always" });
    await addRule({ scopeUnitId: f.sales, pattern: ECHO, mode: "when_tainted" });
    const snap = await cellSnapshot();
    const after = (snap.agents as Json[]).find((a) => a.id === f.keeperId)?.capabilities.tools;
    expect(after).toEqual(before);
    expect(after.every((t: unknown) => typeof t === "string")).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("when_tainted");
    expect(JSON.stringify(snap)).not.toContain('"approval"');
  });
});
