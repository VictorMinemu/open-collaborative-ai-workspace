import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { keepForSite, sealSession } from "../browser/sessions";

/**
 * 07.8-25 (BRW-04, SBX-02; D-11 F-8, D-13; P-11, P-18; Pitfall 13): what a bot saw with a member's sign-in stays with
 * the people who could already see it. A team bot that loaded Sam's sealed session cannot write, delete, run or import
 * into the workspace other people's turns read for the rest of that turn; a personal bot can (its workspace is Sam's
 * alone). Real PostgreSQL + Redis + Garage; the in-memory sandboxd and its fake site (P-13). Sessions are sealed and
 * loaded through 07.8-21's own path (`sealSession` → the open loads it, site-locks the page and sets `member_data`).
 */

const HOST = "panel.fake.test";
let storage: TestStorage;
let s: SandboxStack;
/** Sam's personal bot (its workspace audience is Sam alone). */
let scout: { id: string; dm: string };
/** A team bot of the Sales unit (Sam and Alex are members); Sam's DM with it. */
let ops: { id: string; dm: string };
let salesId: string;

const cell = (path: string, ev: Json, agentId: string, body: Json = {}) =>
  s.cell(path, { eventId: ev.eventId, agentId, ...body });
const sandbox = (name: string, ev: Json, agentId: string, body: Json = {}) =>
  cell(`/sandbox/${name}`, ev, agentId, body);
const browser = (name: string, ev: Json, agentId: string, body: Json = {}) =>
  cell(`/browser/${name}`, ev, agentId, body);

const turnRow = async (eventId: string) =>
  (
    await s.su.query("select tainted, sandbox_calls, member_data from app.agent_turns where event_id = $1", [
      eventId,
    ])
  ).rows[0] as Json;

const auditOf = async (action: string, eventId: string) =>
  (
    await s.su.query(
      `select agent_id, user_id, result, metadata from app.audit_events
        where action = $1 and metadata->>'eventId' = $2 order by occurred_at, id`,
      [action, eventId],
    )
  ).rows as Json[];

const callsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, decision, reason, status from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

const stepsOf = async (eventId: string) =>
  ((await s.su.query("select steps from app.bot_turn_activity where event_id = $1", [eventId])).rows[0]
    ?.steps ?? []) as Json[];

const fakeContext = (contextId: string) =>
  s.sandboxd.stats().browser.contexts.find((c) => c.contextId === contextId) as Json | undefined;

const fakeCalls = (op: string) => s.sandboxd.stats().calls[op] ?? 0;

/** Writes straight into the fake sandboxd (setup only; the bot's own calls go through the API). */
async function seedFile(agentId: string, path: string, content: string): Promise<void> {
  const res = await fetch(`${s.sandboxd.url}/v1/files/write`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sandboxd.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      target: { orgId: s.orgA, agentId },
      path,
      content,
      encoding: "utf8",
      mode: "overwrite",
    }),
  });
  expect(res.status).toBe(200);
}

/** Sam's sealed session with `agentId` for the fake site, through 07.8-21's seal (as Sam). */
async function sealFor(userId: string, agentId: string): Promise<string> {
  const kept = keepForSite(
    JSON.stringify({
      cookies: [
        { name: "fake_session", value: `v-${randomUUID()}`, domain: HOST, path: "/", expires: 2_000_000_000 },
      ],
      origins: [],
    }),
    HOST,
  );
  if (!kept) throw new Error("no state kept");
  const core = s.stack.built.core;
  const r = await core.db.withTenant({ organizationId: s.orgA, userId }, (tx) =>
    sealSession(tx, core, { userId, agentId, siteKey: HOST, kept, contextId: null }),
  );
  return r.sessionId;
}

const setCaps = (agentId: string) =>
  s.su.query(
    `update app.agents set capabilities = capabilities || '{"sandbox": true, "browser": true}'::jsonb where id = $1`,
    [agentId],
  );

/** A turn of `who` with `agentId` in its DM, with Sam's session loaded through the real open (member data). */
async function signedInTurn(bot: { id: string; dm: string }): Promise<{ ev: Json; contextId: string }> {
  const ev = await s.turnOf(s.sam, bot.dm, bot.id);
  const opened = await ok(browser("open", ev, bot.id, { url: `https://${HOST}/reports` }));
  expect(opened).toMatchObject({ host: HOST, signedIn: true });
  return { ev, contextId: opened.contextId as string };
}

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({ env: { ...storage.env } });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  await s.setPolicy({ enabled: true });
  await s.su.query(
    "update app.sandbox_policies set max_browsers = 50, max_sandboxes = 50 where organization_id = $1",
    [s.orgA],
  );

  const personal = await ok(
    s.sam.request("POST", "/api/v1/agents/personal", {
      name: "Scout",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    }) as Promise<Res>,
  );
  scout = { id: personal.agent.id as string, dm: personal.dmId as string };
  await setCaps(scout.id);

  salesId = (
    await ok(
      s.victor.request("POST", "/api/v1/units", {
        kind: "department",
        name: "Sales",
        parentId: null,
      }) as Promise<Res>,
    )
  ).id as string;
  for (const userId of [s.samId, s.alexId]) {
    await ok(s.victor.request("POST", `/api/v1/units/${salesId}/members`, { userId }) as Promise<Res>);
  }
  const opsId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Ops",
        username: "ops",
        instructions: "You are Ops.",
        modelProvider: "mock",
        modelId: "mock-1",
        unitId: salesId,
      }) as Promise<Res>,
    )
  ).id as string;
  await setCaps(opsId);
  const opsDm = (
    await ok(
      s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: opsId }] }) as Promise<Res>,
    )
  ).id as string;
  ops = { id: opsId, dm: opsDm };

  await sealFor(s.samId, scout.id);
  await sealFor(s.samId, ops.id);
}, 240_000);

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the tracer (P-11)

describe("a team bot that used Sam's sign-in cannot put what it saw into its shared workspace (F-8, P-11)", () => {
  it("open loads Sam's session (site lock, member_data) → snapshot → write, exec and delete are 403 member_data; read and list still work", async () => {
    await seedFile(ops.id, "notes/old.txt", "kept from before");
    const { ev, contextId } = await signedInTurn(ops);
    expect(fakeContext(contextId)).toMatchObject({ siteLock: HOST, loadedState: true });
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    await ok(browser("snapshot", ev, ops.id));

    const writesBefore = fakeCalls("filesWrite");
    const execBefore = fakeCalls("exec");
    const w = await sandbox("write", ev, ops.id, {
      path: "notes/seen.txt",
      content: "orders",
      mode: "create",
    });
    expect(w.status).toBe(403);
    expect(codeOf(w)).toBe("member_data");
    const x = await sandbox("exec", ev, ops.id, { argv: ["sh", "-c", "echo orders > notes/x.txt"] });
    expect(x.status).toBe(403);
    expect(codeOf(x)).toBe("member_data");
    const d = await sandbox("delete", ev, ops.id, { path: "notes/old.txt" });
    expect(d.status).toBe(403);
    expect(codeOf(d)).toBe("member_data");
    expect(fakeCalls("filesWrite")).toBe(writesBefore);
    expect(fakeCalls("exec")).toBe(execBefore);

    const read = await ok(sandbox("read", ev, ops.id, { path: "notes/old.txt" }));
    expect(read.content).toBe("kept from before");
    const list = await ok(sandbox("list", ev, ops.id, { path: "notes" }));
    expect((list.entries as Json[]).map((e) => e.name)).toEqual(["old.txt"]);

    // Refusals are decided calls: recorded, audited with ids only, and shown as blocked steps; never counted.
    const refused = (await callsOf(ev.eventId)).filter((c) => c.reason === "member_data");
    expect(refused.map((c) => c.tool)).toEqual([
      "ocw_sandbox_write",
      "ocw_sandbox_exec",
      "ocw_sandbox_delete",
    ]);
    const audits = (await auditOf("bot.tool_call", ev.eventId)).filter(
      (a) => a.metadata.reason === "member_data",
    );
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a).toMatchObject({ agent_id: ops.id, user_id: s.samId, result: "denied" });
      expect(JSON.stringify(a.metadata)).not.toMatch(/notes|orders|echo/u);
    }
    const blocked = (await stepsOf(ev.eventId)).filter((st) => st.outcome.code === "member_data");
    expect(blocked.map((st) => [st.verb, st.outcome.kind])).toEqual([
      ["blocked", "blocked"],
      ["blocked", "blocked"],
      ["blocked", "blocked"],
    ]);
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(4);
  });

  it("a new turn without a loaded session writes again", async () => {
    const ev = await s.turnOf(s.sam, ops.dm, ops.id);
    expect((await turnRow(ev.eventId)).member_data).toBe(false);
    const w = await ok(
      sandbox("write", ev, ops.id, { path: "notes/later.txt", content: "fine", mode: "overwrite" }),
    );
    expect(w).toMatchObject({ path: "notes/later.txt", size: 4 });
  });

  it("Sam's personal bot in the same situation writes, runs and deletes (its workspace is Sam's alone)", async () => {
    await seedFile(scout.id, "notes/old.txt", "mine");
    const { ev, contextId } = await signedInTurn(scout);
    expect(fakeContext(contextId)).toMatchObject({ siteLock: HOST, loadedState: true });
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    await ok(browser("snapshot", ev, scout.id));
    await ok(
      sandbox("write", ev, scout.id, { path: "notes/seen.txt", content: "orders", mode: "overwrite" }),
    );
    await ok(sandbox("delete", ev, scout.id, { path: "notes/old.txt" }));
    expect((await callsOf(ev.eventId)).filter((c) => c.reason === "member_data")).toEqual([]);
  });
});
