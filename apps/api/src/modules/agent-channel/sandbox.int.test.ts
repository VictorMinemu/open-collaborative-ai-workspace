import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { codeOf, type Json, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.8-05 (SBX-02, SBX-04; D-02 (b), D-03, D-09, D-11 F-7, D-12; P-04, P-06, P-07): `POST /agent-channel/v1/sandbox/exec`.
 * A bot's command is decided by the Control Plane (live turn, resolver for agent ∩ human, organization switch and kill
 * state, the bot's switch, the per-turn budget, 07.5 approvals, the organization cap), claimed, run through sandboxd and
 * audited with ids only. Real PostgreSQL + Redis; the in-memory sandboxd runs in-process (P-13).
 */

const SENTINEL = "OCW-SENTINEL-ARGV-7731";
const EXEC = "ocw_sandbox_exec";

let s: SandboxStack;

const exec = (ev: Json, argv: string[], extra: Json = {}, agentId?: string, token?: string): Promise<Res> =>
  s.cell("/sandbox/exec", { eventId: ev.eventId, agentId: agentId ?? s.scoutId, argv, ...extra }, token);

const calls = (op: string) => s.sandboxd.stats().calls[op] ?? 0;

const turnRow = async (eventId: string) =>
  (
    await s.su.query("select tainted, tool_calls, sandbox_calls from app.agent_turns where event_id = $1", [
      eventId,
    ])
  ).rows[0] as Json;

const callsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, source_kind, target, decision, reason, status, approval_id from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

const auditOf = async (action: string, eventId: string) =>
  (
    await s.su.query(
      "select * from app.audit_events where action = $1 and metadata->>'eventId' = $2 order by occurred_at",
      [action, eventId],
    )
  ).rows as Json[];

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

async function decide(who: TestClient, id: string, outcome: "approved" | "denied") {
  const row = await approvalRow(id);
  return who.request("POST", `/api/v1/approvals/${id}/decision`, { outcome, actionHash: row.action_hash });
}

/** The one `agent.card_action.v1` of the approval's card (the re-run turn). */
async function rerunOf(approvalId: string): Promise<Json> {
  const row = await approvalRow(approvalId);
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${s.orgA}`, row.card_message_id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const clearRules = () =>
  s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

beforeEach(async () => {
  await clearRules();
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("tracer: a bot's exec is decided, counted, run through sandboxd and audited", () => {
  it("the delivered turn offers ocw_sandbox_exec with its confined flags and the separate budget", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect(ev.turn.tools).toContain(EXEC);
    expect(ev.turn.toolFlags[EXEC]).toEqual({ untrustedOutput: true, sideEffecting: false });
    expect(ev.turn.maxSandboxCalls).toBe(40);
    expect(ev.turn.maxToolCalls).toBe(8);
  });

  it("exec → 200 exited with the output; one ledger row; the turn tainted and counted; one sandbox.exec audit", async () => {
    const ensureBefore = calls("ensure");
    const ev = await s.turnOf(s.sam, s.samDm);
    const r = await exec(ev, ["sh", "-c", "echo hi"]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      status: "exited",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
    });

    // sandboxd ensured the container once, before the first exec, and the API records it running.
    expect(calls("ensure")).toBe(ensureBefore + 1);
    const box = (
      await s.su.query("select kind, state, runtime from app.bot_sandboxes where agent_id = $1", [s.scoutId])
    ).rows;
    expect(box).toEqual([{ kind: "sbx", state: "running", runtime: "gvisor" }]);

    expect(await callsOf(ev.eventId)).toEqual([
      {
        tool: EXEC,
        source_kind: "builtin",
        target: "sandbox",
        decision: "allowed",
        reason: null,
        status: "ok",
        approval_id: null,
      },
    ]);
    expect(await turnRow(ev.eventId)).toEqual({ tainted: true, tool_calls: 0, sandbox_calls: 1 });

    const audits = await auditOf("sandbox.exec", ev.eventId);
    expect(audits).toHaveLength(1);
    const a = audits[0] as Json;
    expect(a).toMatchObject({
      actor_kind: "agent",
      actor_id: s.scoutId,
      agent_id: s.scoutId,
      user_id: s.samId,
    });
    expect(a.result).toBe("success");
    expect(Object.keys(a.metadata).sort()).toEqual(["durationMs", "eventId", "exitCode", "status"]);
    expect(a.metadata).toMatchObject({ exitCode: 0, status: "exited", eventId: ev.eventId });
    expect(typeof a.metadata.durationMs).toBe("number");
    expect(JSON.stringify(a)).not.toContain("echo");
  });

  it("a second exec reuses the running sandbox (no second ensure); the argv sentinel never leaves the answer", async () => {
    const ensureBefore = calls("ensure");
    const execBefore = calls("exec");
    const ev = await s.turnOf(s.sam, s.samDm);
    const r = await exec(ev, ["echo", SENTINEL], { cwd: "", timeoutSeconds: 30 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.stdout).toBe(`${SENTINEL}\n`);
    expect(calls("ensure")).toBe(ensureBefore);
    expect(calls("exec")).toBe(execBefore + 1);

    const swept = await s.su.query(
      `select
         (select count(*)::int from app.audit_events where metadata::text like $1) as audit,
         (select count(*)::int from app.agent_tool_calls where row_to_json(agent_tool_calls)::text like $1) as ledger,
         (select count(*)::int from app.stream_events where payload::text like $1) as events,
         (select count(*)::int from app.agent_turns where row_to_json(agent_turns)::text like $1) as turns`,
      [`%${SENTINEL}%`],
    );
    expect(swept.rows[0]).toEqual({ audit: 0, ledger: 0, events: 0, turns: 0 });
    expect(s.logs.join("\n")).not.toContain(SENTINEL);
    // The fake's own counters hold counts only.
    expect(JSON.stringify(s.sandboxd.stats())).not.toContain(SENTINEL);
  });

  it("files written by one exec are there for the next one (the bot's workspace persists)", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((await exec(ev, ["sh", "-c", "echo kept > note.txt"])).status).toBe(200);
    const r = await exec(ev, ["cat", "note.txt"]);
    expect(r.body).toMatchObject({ status: "exited", exitCode: 0, stdout: "kept\n" });
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(2);
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(s.stack.built.authz.routes.get("POST /agent-channel/v1/sandbox/exec")).toBe("cell");
  });
});

describe("07.5 approvals apply to the sandbox (D-03, SBX-04)", () => {
  it("an `always` rule: 409 approval_required with the approval, sandboxd never reached; Sam approves; the re-run runs it once", async () => {
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgA, EXEC, s.victorId],
    );
    const ev = await s.turnOf(s.sam, s.samDm);
    expect(ev.turn.toolFlags[EXEC]).toEqual({
      untrustedOutput: true,
      sideEffecting: false,
      approval: "always",
    });
    const execBefore = calls("exec");
    const argv = ["sh", "-c", "echo approved > done.txt && cat done.txt"];
    const r = await exec(ev, argv);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    expect(r.body?.error.details.approval).toMatchObject({ created: true, requesterName: "Sam Lee" });
    expect(calls("exec")).toBe(execBefore);
    expect(await callsOf(ev.eventId)).toEqual([
      expect.objectContaining({
        tool: EXEC,
        decision: "denied",
        reason: "approval_required",
        approval_id: null,
      }),
    ]);
    // A refusal is not counted against the turn's budget.
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(0);

    const id = r.body?.error.details.approval.id as string;
    expect((await decide(s.sam, id, "approved")).status).toBe(200);
    const rerun = await rerunOf(id);
    expect(rerun.turn.tools).toContain(EXEC);
    const done = await exec(rerun, argv);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "exited", exitCode: 0, stdout: "approved\n" });
    expect(calls("exec")).toBe(execBefore + 1);
    expect(await callsOf(rerun.eventId)).toEqual([
      expect.objectContaining({ tool: EXEC, decision: "allowed", approval_id: id, status: "ok" }),
    ]);
    // The grant is consumed in the claim.
    expect((await approvalRow(id)).consumed_at).not.toBeNull();

    // The same action again in that turn: the grant was used once.
    const again = await exec(rerun, argv);
    expect(codeOf(again)).toBe("approval_used");
    expect(again.status).toBe(409);
    expect(calls("exec")).toBe(execBefore + 1);
  });

  it("without a rule the call is unchanged: nothing is stored for approval", async () => {
    const before = (
      await s.su.query("select count(*)::int as n from app.tool_call_approvals where organization_id = $1", [
        s.orgA,
      ])
    ).rows[0].n;
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((await exec(ev, ["true"])).status).toBe(200);
    const after = (
      await s.su.query("select count(*)::int as n from app.tool_call_approvals where organization_id = $1", [
        s.orgA,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });
});
