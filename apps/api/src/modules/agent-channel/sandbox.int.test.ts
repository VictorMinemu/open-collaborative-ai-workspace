import { randomUUID } from "node:crypto";
import { CONFINED_TOOL_FLAGS } from "@ocw/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { reserveSandbox } from "../sandbox";

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

    // A refused call carries no argv into the ledger or the audit either.
    await s.setBotSandbox(s.scoutId, false);
    try {
      const refused = await exec(ev, ["sh", "-c", "echo OCW-SENTINEL-ARGV-7731 > leak.txt"]);
      expect(codeOf(refused)).toBe("bot_off");
    } finally {
      await s.setBotSandbox(s.scoutId, true);
    }

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

// ---------------------------------------------------------------- Task 2: offering and refusals

const SANDBOX_TOOLS_OFFERED = [
  "ocw_sandbox_exec",
  "ocw_sandbox_process",
  "ocw_sandbox_read",
  "ocw_sandbox_write",
  "ocw_sandbox_list",
  "ocw_sandbox_delete",
  "ocw_sandbox_share",
];

const confinedOf = (ev: Json): string[] =>
  (ev.turn.tools as string[]).filter((t) => t.startsWith("ocw_sandbox_") || t.startsWith("ocw_browser_"));

const setModule = (scopeUnitId: string | null, subject: Json, enabled: boolean) =>
  ok(
    s.victor.request("PUT", "/api/v1/module-access", {
      module: "sandbox",
      scopeUnitId,
      subject,
      enabled,
    }) as Promise<Res>,
  );

/** A superuser-inserted permission rule; returns its removal. */
async function denyRule(subjectKind: "user" | "agent", subjectId: string, permission: string) {
  const { rows } = await s.su.query(
    `insert into app.permission_rules (organization_id, subject_kind, subject_id, permission, effect)
     values ($1, $2, $3, $4, 'deny') returning id`,
    [s.orgA, subjectKind, subjectId, permission],
  );
  return () => s.su.query("delete from app.permission_rules where id = $1", [rows[0].id]);
}

describe("the sandbox tools are offered only when every layer allows it (D-12, P-05)", () => {
  it("all on: the seven tools (never import), their confined flags, the budget of 40, no browser tool", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect(confinedOf(ev)).toEqual(SANDBOX_TOOLS_OFFERED);
    for (const name of SANDBOX_TOOLS_OFFERED) {
      const { untrustedOutput, sideEffecting } =
        CONFINED_TOOL_FLAGS[name as keyof typeof CONFINED_TOOL_FLAGS];
      expect(ev.turn.toolFlags[name], name).toEqual({ untrustedOutput, sideEffecting });
    }
    expect(ev.turn.maxSandboxCalls).toBe(40);
  });

  it("the organization switch off: no sandbox tool and no sandbox budget", async () => {
    await s.setPolicy({ enabled: false });
    try {
      const ev = await s.turnOf(s.sam, s.samDm);
      expect(confinedOf(ev)).toEqual([]);
      expect(ev.turn.maxSandboxCalls).toBeUndefined();
    } finally {
      await s.setPolicy({ enabled: true });
    }
  });

  it("the bot's own switch off: none", async () => {
    await s.setBotSandbox(s.scoutId, false);
    try {
      expect(confinedOf(await s.turnOf(s.sam, s.samDm))).toEqual([]);
    } finally {
      await s.setBotSandbox(s.scoutId, true);
    }
  });

  it("the Sandbox module off for Sam, for the organization or at Sam's unit: none for Sam; Alex keeps them", async () => {
    const alexDm = (
      await ok(
        s.alex.request("POST", "/api/v1/dms", {
          participants: [{ kind: "agent", id: s.scoutId }],
        }) as Promise<Res>,
      )
    ).id as string;
    const sales = (
      await ok(
        s.victor.request("POST", "/api/v1/units", {
          kind: "department",
          name: "Sales",
          parentId: null,
        }) as Promise<Res>,
      )
    ).id as string;
    await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: s.samId }) as Promise<Res>);

    const cases: Array<[string | null, Json]> = [
      [null, { kind: "user", userId: s.samId }],
      [null, { kind: "everyone" }],
      [sales, { kind: "everyone" }],
    ];
    for (const [scope, subject] of cases) {
      await setModule(scope, subject, false);
      try {
        expect(confinedOf(await s.turnOf(s.sam, s.samDm)), JSON.stringify(subject)).toEqual([]);
        const alexTurn = await s.turnOf(s.alex, alexDm);
        expect(confinedOf(alexTurn)).toEqual(
          subject.kind === "everyone" && scope === null ? [] : SANDBOX_TOOLS_OFFERED,
        );
      } finally {
        await setModule(scope, subject, true);
      }
    }
    expect(confinedOf(await s.turnOf(s.sam, s.samDm))).toEqual(SANDBOX_TOOLS_OFFERED);
  });

  it("the bot without `sandbox.use` (a deny rule for the agent): none", async () => {
    const remove = await denyRule("agent", s.scoutId, "sandbox.use");
    try {
      expect(confinedOf(await s.turnOf(s.sam, s.samDm))).toEqual([]);
    } finally {
      await remove();
    }
  });
});

describe("every call is re-decided: a change after delivery refuses the next exec before sandboxd", () => {
  it("switch off → 403 sandbox_off; module off for Sam → 403 not_allowed; bot off → 403 bot_off; no fake exec", async () => {
    const execBefore = calls("exec");
    const steps: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["sandbox_off", () => s.setPolicy({ enabled: false }), () => s.setPolicy({ enabled: true })],
      [
        "not_allowed",
        () => setModule(null, { kind: "user", userId: s.samId }, false),
        () => setModule(null, { kind: "user", userId: s.samId }, true),
      ],
      ["bot_off", () => s.setBotSandbox(s.scoutId, false), () => s.setBotSandbox(s.scoutId, true)],
    ];
    for (const [code, off, on] of steps) {
      const ev = await s.turnOf(s.sam, s.samDm);
      expect(ev.turn.tools).toContain(EXEC);
      await off();
      try {
        const r = await exec(ev, ["echo", "hi"]);
        expect(r.status, code).toBe(403);
        expect(codeOf(r)).toBe(code);
        expect(await callsOf(ev.eventId)).toEqual([
          expect.objectContaining({ tool: EXEC, decision: "denied", reason: code, status: null }),
        ]);
        expect((await turnRow(ev.eventId)).sandbox_calls).toBe(0);
      } finally {
        await on();
      }
    }
    expect(calls("exec")).toBe(execBefore);
  });

  it("a turn delivered without the tool cannot use it after the switch comes on → 409 policy_changed", async () => {
    await s.setPolicy({ enabled: false });
    const ev = await s.turnOf(s.sam, s.samDm);
    await s.setPolicy({ enabled: true });
    const r = await exec(ev, ["echo", "hi"]);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("policy_changed");
  });
});

describe("the per-turn budget is its own (P-06)", () => {
  it("40 calls in one turn, the 41st → 403 budget_exhausted; the 8-call tool cap is untouched", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    for (let i = 0; i < 10; i += 1) expect((await exec(ev, ["true"])).status).toBe(200);
    // Ten sandbox calls later, the turn's other tools still have their whole 8-call cap.
    const card = await s.cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: s.scoutId,
      tool: "ocw_agent_card",
    });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body?.allowed).toBe(true);
    for (let i = 10; i < 40; i += 1) expect((await exec(ev, ["true"])).status, String(i)).toBe(200);
    const execBefore = calls("exec");
    const r = await exec(ev, ["true"]);
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("budget_exhausted");
    expect(calls("exec")).toBe(execBefore);
    expect(await turnRow(ev.eventId)).toEqual({ tainted: true, tool_calls: 1, sandbox_calls: 40 });
  }, 120_000);
});

describe("the organization cap (D-09)", () => {
  it("cap 1 with Scout running: another bot's first exec → 403 cap_reached and no ensure", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((await exec(ev, ["true"])).status).toBe(200);
    await s.setPolicy({ maxSandboxes: 1 });
    try {
      const rover = await s.newBot("Rover");
      const ensureBefore = calls("ensure");
      const turn = await s.turnOf(s.sam, rover.dm, rover.id);
      const r = await exec(turn, ["true"], {}, rover.id);
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("cap_reached");
      expect(calls("ensure")).toBe(ensureBefore);
      // Scout, already running, needs no slot.
      expect((await exec(await s.turnOf(s.sam, s.samDm), ["true"])).status).toBe(200);
    } finally {
      await s.setPolicy({ maxSandboxes: 10 });
    }
  });

  it("cap 1, four bots' first execs at once: exactly one runs, one ensure (advisory lock)", async () => {
    await s.su.query("delete from app.bot_sandboxes where organization_id = $1", [s.orgA]);
    await s.setPolicy({ maxSandboxes: 1 });
    try {
      const bots = [await s.newBot("Ada"), await s.newBot("Bo"), await s.newBot("Cy"), await s.newBot("Di")];
      const turns: Json[] = [];
      for (const b of bots) turns.push(await s.turnOf(s.sam, b.dm, b.id));
      const ensureBefore = calls("ensure");
      const results = await Promise.all(bots.map((b, i) => exec(turns[i] as Json, ["true"], {}, b.id)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403, 403]);
      expect(results.map((r) => codeOf(r) ?? "ok").sort()).toEqual([
        "cap_reached",
        "cap_reached",
        "cap_reached",
        "ok",
      ]);
      expect(calls("ensure")).toBe(ensureBefore + 1);
      const running = (
        await s.su.query(
          "select count(*)::int as n from app.bot_sandboxes where organization_id = $1 and state in ('starting','running')",
          [s.orgA],
        )
      ).rows[0].n;
      expect(running).toBe(1);
    } finally {
      await s.setPolicy({ maxSandboxes: 10 });
    }
  });
});

describe("the cap's lock (D-09)", () => {
  it("a second reservation waits for the first to commit, then sees its slot taken", async () => {
    await s.su.query("delete from app.bot_sandboxes where organization_id = $1", [s.orgA]);
    await s.setPolicy({ maxSandboxes: 1 });
    try {
      const [x, y] = [await s.newBot("Xa"), await s.newBot("Yo")];
      const db = s.stack.built.core.db;
      const ctx = { organizationId: s.orgA, userId: s.samId };
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reserved: () => void = () => {};
      const firstReserved = new Promise<void>((resolve) => {
        reserved = resolve;
      });
      const first = db.withTenant(ctx, async (tx) => {
        const r = await reserveSandbox(tx, { agentId: x.id }, "sbx");
        reserved();
        await hold;
        return r;
      });
      await firstReserved;
      let secondDone = false;
      const second = db
        .withTenant(ctx, (tx) => reserveSandbox(tx, { agentId: y.id }, "sbx"))
        .finally(() => {
          secondDone = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Without the per-organization lock the second would already have read an empty count.
      expect(secondDone).toBe(false);
      release();
      expect(await first).toEqual({ ok: true, ensure: true });
      expect(await second).toEqual({ ok: false, reason: "cap_reached" });
    } finally {
      await s.setPolicy({ maxSandboxes: 10 });
    }
  });
});

describe("sandboxd unavailable", () => {
  it("down → 503 service_unavailable; the claim row completes with error; the audit says error; up again → runs", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    s.sandboxd.fake.setDown(true);
    let r: Res;
    try {
      r = await exec(ev, ["echo", "hi"]);
    } finally {
      s.sandboxd.fake.setDown(false);
    }
    expect(r.status).toBe(503);
    expect(codeOf(r)).toBe("service_unavailable");
    expect(await callsOf(ev.eventId)).toEqual([
      expect.objectContaining({ tool: EXEC, decision: "allowed", status: "error" }),
    ]);
    const [audit] = await auditOf("sandbox.exec", ev.eventId);
    expect(audit?.result).toBe("error");
    expect(audit?.metadata).toMatchObject({ status: "error", exitCode: null, reason: "service_unavailable" });
    const state = (
      await s.su.query(
        "select state, stop_reason from app.bot_sandboxes where agent_id = $1 and kind = 'sbx'",
        [s.scoutId],
      )
    ).rows[0];
    expect(state).toEqual({ state: "unavailable", stop_reason: "service_down" });
    const ensureBefore = calls("ensure");
    expect((await exec(ev, ["echo", "back"])).body?.stdout).toBe("back\n");
    expect(calls("ensure")).toBe(ensureBefore + 1);
  });
});

describe("no live turn → 403 no_trigger (as every Agent Channel route)", () => {
  it("an unknown event, another bot's turn, another organization's cell token: refused, nothing run, audited", async () => {
    const execBefore = calls("exec");
    const ev = await s.turnOf(s.sam, s.samDm);
    const other = await s.newBot("Other");
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const cases: Res[] = [
      await exec({ eventId: randomUUID() }, ["echo", "hi"]),
      await exec(ev, ["echo", "hi"], {}, other.id),
      await exec(ev, ["echo", "hi"], {}, s.scoutId, tokenB),
    ];
    for (const r of cases) {
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("no_trigger");
    }
    expect(calls("exec")).toBe(execBefore);
    expect(await callsOf(ev.eventId)).toEqual([]);
    const audited = (
      await s.su.query(
        "select organization_id from app.audit_events where action = 'bot.tool_call' and metadata->>'reason' = 'no_trigger' and metadata->>'tool' = $1",
        [EXEC],
      )
    ).rows.map((r) => r.organization_id);
    expect(audited.filter((o) => o === s.orgA).length).toBeGreaterThanOrEqual(2);
    expect(audited).toContain(s.orgB);
  });
});
