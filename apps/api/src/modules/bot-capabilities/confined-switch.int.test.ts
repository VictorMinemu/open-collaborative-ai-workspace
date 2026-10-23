import { BROWSER_TOOL_NAMES, SANDBOX_TOOL_NAMES } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Json,
  ok,
  type Res,
  SANDBOX_CELL_TOKEN,
  type SandboxStack,
  startSandboxStack,
} from "../../testing-sandbox";

/**
 * 07.8-08 (D-12, P-05; WINDOWS #232, #240): the per-bot Sandbox and Browser switches are set through the existing
 * capabilities route, and the cell snapshot (`GET /agent-channel/v1/cell`, the bot's `alsoAllow`) lists the confined
 * tools of a bot whose switch is on while sandboxd is configured. OpenClaw only runs a tool its agent entry allows; each
 * turn still narrows the list (`toolsAllow`) and every call is re-decided by the API, so the snapshot never widens what
 * a turn may do. Real PostgreSQL + Redis; the in-memory sandboxd (P-13).
 */

let s: SandboxStack;

const patch = (who = s.victor, id = s.scoutId, body: Json = {}) =>
  who.request("PATCH", `/api/v1/agents/${id}/capabilities`, body) as Promise<Res>;

async function cellTools(agentId: string): Promise<string[]> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1/cell`, {
    headers: { authorization: `Bearer ${SANDBOX_CELL_TOKEN}` },
  });
  expect(res.status).toBe(200);
  const snapshot = (await res.json()) as { agents: Array<{ id: string; capabilities: { tools: string[] } }> };
  const agent = snapshot.agents.find((a) => a.id === agentId);
  expect(agent, `agent ${agentId} in the snapshot`).toBeTruthy();
  return agent?.capabilities.tools ?? [];
}

const confined = (tools: string[]) =>
  tools.filter((t) => t.startsWith("ocw_sandbox_") || t.startsWith("ocw_browser_")).sort();

const capabilityAudits = async (agentId: string) =>
  (
    await s.su.query(
      "select metadata from app.audit_events where action = 'agent.capabilities_updated' and resource_id = $1 order by occurred_at",
      [agentId],
    )
  ).rows.map((r) => (r as { metadata: Json }).metadata);

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("the per-bot switches go through PATCH /agents/:id/capabilities (D-12)", () => {
  it("an admin turns Scout's Sandbox off and Browser on; the view and the stored object follow; audited by key only", async () => {
    const off = await ok(patch(s.victor, s.scoutId, { sandbox: false }));
    expect(off.capabilities).toMatchObject({ sandbox: false, browser: false });
    const on = await ok(patch(s.victor, s.scoutId, { sandbox: true, browser: true }));
    expect(on.capabilities).toMatchObject({ sandbox: true, browser: true });
    const stored = (await s.su.query("select capabilities from app.agents where id = $1", [s.scoutId]))
      .rows[0] as { capabilities: Json };
    expect(stored.capabilities).toMatchObject({ sandbox: true, browser: true });
    const audits = await capabilityAudits(s.scoutId);
    expect(audits.at(-2)).toMatchObject({ changed: ["sandbox"] });
    expect(audits.at(-1)).toMatchObject({ changed: ["sandbox", "browser"] });
    // An unchanged value is no change (no audit row).
    await ok(patch(s.victor, s.scoutId, { sandbox: true }));
    expect(await capabilityAudits(s.scoutId)).toHaveLength(audits.length);
  });

  it("a member who may not configure the team bot cannot flip its switch (the route's existing bot.configure check)", async () => {
    const res = await patch(s.sam, s.scoutId, { sandbox: false });
    expect(res.status).toBe(403);
    expect(
      ((await s.su.query("select capabilities from app.agents where id = $1", [s.scoutId])).rows[0] as Json)
        .capabilities.sandbox,
    ).toBe(true);
  });

  it("a member turns their own personal bot's Sandbox on", async () => {
    const created = await ok(
      s.sam.request("POST", "/api/v1/agents/personal", {
        name: "Echo",
        instructions: "Answer briefly.",
        modelProvider: "mock",
        modelId: "mock-1",
      }) as Promise<Res>,
    );
    const echo = created.agent.id as string;
    expect((await ok(patch(s.sam, echo, {}))).capabilities).toMatchObject({ sandbox: false });
    const on = await ok(patch(s.sam, echo, { sandbox: true }));
    expect(on.capabilities).toMatchObject({ sandbox: true, browser: false });
    expect(confined(await cellTools(echo))).toEqual([...SANDBOX_TOOL_NAMES].sort());
  });
});

describe("GET /cell lists the confined tools a bot's switches allow (the bot's alsoAllow)", () => {
  it("Sandbox and Browser on: all 15 confined tools; Browser off: the 8 sandbox tools only; both off: none", async () => {
    await ok(patch(s.victor, s.scoutId, { sandbox: true, browser: true }));
    expect(confined(await cellTools(s.scoutId))).toEqual(
      [...SANDBOX_TOOL_NAMES, ...BROWSER_TOOL_NAMES].sort(),
    );
    await ok(patch(s.victor, s.scoutId, { browser: false }));
    expect(confined(await cellTools(s.scoutId))).toEqual([...SANDBOX_TOOL_NAMES].sort());
    await ok(patch(s.victor, s.scoutId, { sandbox: false }));
    expect(confined(await cellTools(s.scoutId))).toEqual([]);
    await ok(patch(s.victor, s.scoutId, { sandbox: true }));
  });

  it("a disabled bot lists no tool at all, its switches notwithstanding", async () => {
    const bot = await s.newBot("Quill");
    await ok(patch(s.victor, bot.id, { sandbox: true, browser: true }));
    expect(confined(await cellTools(bot.id))).toHaveLength(15);
    await ok(s.victor.request("PATCH", `/api/v1/agents/${bot.id}`, { enabled: false }) as Promise<Res>);
    expect(await cellTools(bot.id)).toEqual([]);
  });

  it("the snapshot never decides a turn: the organization switch off still refuses every exec offering", async () => {
    // The snapshot follows the bot's own switch; the organization switch, the kill state and the resolver are
    // decided per turn (sandboxAvailable), so a turn delivered with the switch off carries no sandbox tool.
    await s.setPolicy({ enabled: false });
    try {
      expect(confined(await cellTools(s.scoutId))).toEqual([...SANDBOX_TOOL_NAMES].sort());
      const ev = await s.turnOf(s.sam, s.samDm);
      expect((ev.turn?.tools ?? []).filter((t: string) => t.startsWith("ocw_sandbox_"))).toEqual([]);
    } finally {
      await s.setPolicy({ enabled: true });
    }
  });
});
