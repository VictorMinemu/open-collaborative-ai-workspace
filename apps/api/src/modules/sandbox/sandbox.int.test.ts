import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { invite } from "../../testing-workzone";

/**
 * 07.8-05 Task 3 (SBX-02; D-09; P-04, P-17): the admins' kill switch. `POST /api/v1/sandbox/kill` records who and when,
 * marks every sandbox of the organization killed, audits `sandbox.killed`, asks sandboxd to stop the organization after
 * the commit, and refuses every later exec (`killed`) and every offering until `POST /api/v1/sandbox/resume`. Only
 * `bot.manage` at the organization may do it; another organization's admin reaches only their own. The `/sandbox`
 * routes registered in the app equal the routes this file covers with organization-B cases.
 */

const EXEC = "ocw_sandbox_exec";

let s: SandboxStack;
let marta: TestClient;

const kill = (who: TestClient) => who.request("POST", "/api/v1/sandbox/kill") as Promise<Res>;
const resume = (who: TestClient) => who.request("POST", "/api/v1/sandbox/resume") as Promise<Res>;
const exec = (ev: Json, argv: string[], token?: string): Promise<Res> =>
  s.cell("/sandbox/exec", { eventId: ev.eventId, agentId: s.scoutId, argv }, token);
const calls = (op: string, orgId?: string) =>
  (orgId ? s.sandboxd.stats().orgs[orgId]?.[op] : s.sandboxd.stats().calls[op]) ?? 0;

const policyOf = async (orgId: string) =>
  (
    await s.su.query("select killed_at, killed_by from app.sandbox_policies where organization_id = $1", [
      orgId,
    ])
  ).rows[0] as Json | undefined;

const audits = async (orgId: string, action: string) =>
  (
    await s.su.query(
      "select actor_kind, actor_id, user_id, metadata from app.audit_events where organization_id = $1 and action = $2 order by occurred_at",
      [orgId, action],
    )
  ).rows as Json[];

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
  ({ client: marta } = await invite(s.stack, s.victor, "marta@example.test", "Marta Gil", "lead"));
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("the kill switch stops every sandbox of the organization until resumed (D-09)", () => {
  it("kill: who and when, every sandbox killed, audited once, sandboxd told after the commit, exec refused", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((await exec(ev, ["true"])).status).toBe(200);
    const killOrgBefore = calls("killOrg", s.orgA);

    const settings = await ok(kill(s.victor));
    expect(settings.killed).toMatchObject({ by: { id: s.victorId, displayName: "Víctor Ruiz" } });
    expect(typeof settings.killed.at).toBe("string");
    const row = await policyOf(s.orgA);
    expect(row?.killed_at).not.toBeNull();
    expect(row?.killed_by).toBe(s.victorId);
    const killed = await audits(s.orgA, "sandbox.killed");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toMatchObject({ actor_kind: "user", actor_id: s.victorId, user_id: s.victorId });
    expect(killed[0]?.metadata).toEqual({ sandboxes: 1, browsers: 0 });
    expect(calls("killOrg", s.orgA)).toBe(killOrgBefore + 1);
    expect(s.sandboxd.fake.stateOf({ orgId: s.orgA, agentId: s.scoutId })).toBe("killed");
    const boxes = (
      await s.su.query("select state, stop_reason from app.bot_sandboxes where organization_id = $1", [
        s.orgA,
      ])
    ).rows;
    expect(boxes).toEqual([{ state: "killed", stop_reason: "kill_switch" }]);

    // The turn delivered before the kill: refused before sandboxd.
    const execBefore = calls("exec");
    const r = await exec(ev, ["echo", "hi"]);
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("killed");
    expect(calls("exec")).toBe(execBefore);
    // The next delivered turn offers no sandbox tool.
    const next = await s.turnOf(s.sam, s.samDm);
    expect((next.turn.tools as string[]).filter((t) => t.startsWith("ocw_sandbox_"))).toEqual([]);
  });

  it("kill twice is idempotent: one audit row per state change", async () => {
    const at = (await policyOf(s.orgA))?.killed_at;
    await ok(kill(s.victor));
    expect((await policyOf(s.orgA))?.killed_at).toEqual(at);
    expect(await audits(s.orgA, "sandbox.killed")).toHaveLength(1);
  });

  it("resume: the kill state cleared and audited; the next exec runs again (ensure asked again)", async () => {
    const settings = await ok(resume(s.victor));
    expect(settings.killed).toBeNull();
    expect(await policyOf(s.orgA)).toEqual({ killed_at: null, killed_by: null });
    expect(await audits(s.orgA, "sandbox.resumed")).toHaveLength(1);
    await ok(resume(s.victor));
    expect(await audits(s.orgA, "sandbox.resumed")).toHaveLength(1);

    const ensureBefore = calls("ensure");
    const ev = await s.turnOf(s.sam, s.samDm);
    expect(ev.turn.tools).toContain(EXEC);
    const r = await exec(ev, ["echo", "back"]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.stdout).toBe("back\n");
    expect(calls("ensure")).toBe(ensureBefore + 1);
  });

  it("a member without bot.manage and a lead get 403; nothing changes", async () => {
    for (const who of [s.sam, marta]) {
      const k = await kill(who);
      expect(k.status).toBe(403);
      expect((await resume(who)).status).toBe(403);
    }
    expect((await policyOf(s.orgA))?.killed_at).toBeNull();
    expect(await audits(s.orgA, "sandbox.killed")).toHaveLength(1);
  });

  it("organization B's admin kills and resumes organization B only", async () => {
    const aBefore = s.sandboxd.stats().orgs[s.orgA] ?? {};
    await ok(kill(s.eve));
    expect((await policyOf(s.orgB))?.killed_at).not.toBeNull();
    expect((await policyOf(s.orgA))?.killed_at).toBeNull();
    expect(await audits(s.orgB, "sandbox.killed")).toHaveLength(1);
    expect(await audits(s.orgA, "sandbox.killed")).toHaveLength(1);
    expect(calls("killOrg", s.orgB)).toBe(1);
    expect(s.sandboxd.stats().orgs[s.orgA] ?? {}).toEqual(aBefore);
    // Organization A's bots still run.
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((await exec(ev, ["true"])).status).toBe(200);
    await ok(resume(s.eve));
    expect((await policyOf(s.orgB))?.killed_at).toBeNull();
  });

  it("sandboxd down during a kill: the organization stays killed (fail closed) and the next kill retries", async () => {
    s.sandboxd.fake.setDown(true);
    try {
      await ok(kill(s.victor));
    } finally {
      s.sandboxd.fake.setDown(false);
    }
    expect((await policyOf(s.orgA))?.killed_at).not.toBeNull();
    const ev = await s.turnOf(s.sam, s.samDm);
    expect((ev.turn.tools as string[]).includes(EXEC)).toBe(false);
    const before = calls("killOrg", s.orgA);
    await ok(kill(s.victor));
    expect(calls("killOrg", s.orgA)).toBe(before + 1);
    await ok(resume(s.victor));
  });
});

describe("cross-tenant guards derived from the authz registry (P-17, 07.4 #169)", () => {
  it("every registered /sandbox route is covered by an organization-B case", async () => {
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const ev = await s.turnOf(s.sam, s.samDm);
    const execBefore = calls("exec");
    const cases: Record<string, () => Promise<void>> = {
      "POST /api/v1/sandbox/kill": async () => {
        await ok(kill(s.eve));
        expect((await policyOf(s.orgA))?.killed_at).toBeNull();
        await ok(resume(s.eve));
      },
      "POST /api/v1/sandbox/resume": async () => {
        await ok(kill(s.victor));
        await ok(resume(s.eve));
        expect((await policyOf(s.orgA))?.killed_at).not.toBeNull();
        await ok(resume(s.victor));
      },
      "POST /agent-channel/v1/sandbox/exec": async () => {
        const r = await exec(ev, ["echo", "hi"], tokenB);
        expect(r.status).toBe(403);
        expect(codeOf(r)).toBe("no_trigger");
      },
    };
    // The bots' file and process tools (07.8-10) have their own registry-derived cases in
    // agent-channel/sandbox-tools.int.test.ts.
    const toolRoutes = /^POST \/agent-channel\/v1\/sandbox\/(process|read|write|list|delete|share)$/u;
    const registered = [...s.stack.built.authz.routes.keys()].filter(
      (k) => k.includes("/sandbox") && !toolRoutes.test(k),
    );
    expect(registered.sort()).toEqual(Object.keys(cases).sort());
    for (const [key, run] of Object.entries(cases)) {
      expect(s.stack.built.authz.routes.get(key), key).toBe(
        key.includes("/agent-channel/") ? "cell" : "user",
      );
      await run();
    }
    expect(calls("exec")).toBe(execBefore);
    const rows = (
      await s.su.query("select count(*)::int as n from app.agent_tool_calls where event_id = $1", [
        ev.eventId,
      ])
    ).rows[0];
    expect(rows.n).toBe(0);
  });
});
