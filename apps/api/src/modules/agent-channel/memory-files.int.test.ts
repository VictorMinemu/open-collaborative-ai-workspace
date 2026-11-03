import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.2-11 (MEM-04, MEM-07, D-02, D-08, C-01; WINDOWS 123): the Agent Channel memory routes behind the plugin's
 * `ocw_memory_list|read|write|propose`. Every call is bound to a delivered turn whose human still reads the conversation
 * (403 `no_trigger` otherwise), decided as the bot ∩ that human and the audience of the conversation, and audited with
 * ids only. Real PostgreSQL + Redis.
 *
 * Cast: Víctor (admin); Sam and Ana (standard, team Iberia = A); Bea (standard, team Nordics = B); both teams in the
 * department Sales. Bots: Sam's personal
 * bot; Archie, an organization bot with memory on. Memory: A `clients/acme.md`, B `plan.md`, organization
 * `handbook.md` and `private/plan.md` (Bea is denied `memory.read` on `private/`).
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-files-0123456789abc";
const ANTHROPIC_KEY = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");
const CANARY = "acme-canary-5521";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let ana: TestClient;
let orgId: string;
let samId: string;
let anaId: string;
let beaId: string;
let A: string;
let B: string;
let samBotId: string;
let samDmId: string;
let archieId: string;
let samArchieDm: string;
const scopeOf: Record<string, string> = {};

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function joinAs(email: string, name: string, role: "standard" | "developer") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
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

const codeOf = (r: { body: Json }) => (r.body.error as Json | undefined)?.code as string | undefined;

/** The `agent.mention.v1` delivered to `agentId` for `messageId`. */
async function mentionOf(agentId: string, messageId: string): Promise<Json> {
  const rows = (
    await su.query(
      `select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'
        and payload->'agent'->>'id' = $2 and payload->'message'->>'id' = $3`,
      [`cell:${orgId}`, agentId, messageId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** `c` writes in `conversationId` (mentioning `agentId` outside DMs); returns the turn delivered to the bot. */
async function turn(c: TestClient, conversationId: string, agentId: string, text: string, mention = true) {
  const mentions = mention ? [{ kind: "agent", id: agentId }] : [];
  const msg = await ok(
    c.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body: text, mentions }),
  );
  return mentionOf(agentId, msg.id as string);
}

const call = (route: string, ev: Json, extra: Json, agentId = ev.agent.id as string) =>
  cell(`/memory/${route}`, { eventId: ev.eventId, agentId, ...extra });

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

const create = async (c: TestClient, scope: string, path: string, content: string) =>
  (await ok(c.request("POST", `/api/v1/memory/scopes/${scope}/files`, { path, content }))).id as string;

const personalScopes = async (agentId: string, ownerUserId: string) =>
  (
    await su.query(
      "select id from app.memory_scopes where kind = 'personal' and agent_id = $1 and owner_user_id = $2",
      [agentId, ownerUserId],
    )
  ).rows as Json[];

const toolCalls = async (eventId: string) =>
  (await su.query("select tool_calls from app.agent_turns where event_id = $1", [eventId])).rows[0]
    .tool_calls as number;

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [ana, anaId] = await joinAs("ana@example.test", "Ana Pérez", "standard");
  [, beaId] = await joinAs("bea@example.test", "Bea Lind", "standard");
  const D = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }))
  ).id;
  A = (await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Iberia", parentId: D }))).id;
  B = (await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Nordics", parentId: D }))).id;
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: samId }));
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: anaId }));
  await ok(admin.request("POST", `/api/v1/units/${B}/members`, { userId: beaId }));

  const personal = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  samBotId = personal.agent.id;
  samDmId = personal.dmId;
  await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { dailyLimit: 100 }));
  archieId = (
    await ok(
      admin.request("POST", "/api/v1/agents", {
        name: "Archie",
        instructions: "You are Archie.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  await ok(
    admin.request("PATCH", `/api/v1/agents/${archieId}/capabilities`, { memory: true, dailyLimit: 100 }),
  );
  samArchieDm = (await ok(sam.request("POST", `/api/v1/agents/${archieId}/dm`))).dmId;

  for (const s of (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[]) {
    scopeOf[s.kind === "unit" ? s.unitId : s.kind] = s.id;
  }
  await create(admin, scopeOf[A] as string, "clients/acme.md", `# Acme\n${CANARY}\n`);
  await create(admin, scopeOf[B] as string, "plan.md", "# Nordics plan\n");
  await create(admin, scopeOf.org as string, "handbook.md", "# Handbook\n");
  await create(admin, scopeOf.org as string, "private/plan.md", "# Board plan\n");
  await ok(
    admin.request("POST", "/api/v1/permission-rules", {
      subjectKind: "user",
      subjectId: beaId,
      permission: "memory.read",
      effect: "deny",
      pathPrefix: "private/",
    }),
  );
}, 240_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

const MEMORY_DM_TOOLS = [
  "ocw_memory_save",
  "ocw_memory_list",
  "ocw_memory_read",
  "ocw_memory_write",
  "ocw_memory_propose",
  "ocw_agent_card",
  // 07.6-12: Sam holds `automation.create` in his DM with the bot.
  "ocw_automation_propose",
];
const READ_FLAGS = { untrustedOutput: false, sideEffecting: false };
const WRITE_FLAGS = { untrustedOutput: false, sideEffecting: true };

// ---------------------------------------------------------------- Task 1: the tracer

describe("Sam's bot reads Sam's private MEMORY.md in their DM (tracer)", () => {
  it("the turn offers the memory tools with fixed flags and carries the file; the read returns it, audited by id", async () => {
    const ev = await turn(sam, samDmId, samBotId, "What do you remember about me?", false);
    expect(ev.turn.tools).toEqual(MEMORY_DM_TOOLS);
    expect(ev.turn.toolFlags).toMatchObject({
      ocw_memory_save: WRITE_FLAGS,
      ocw_memory_list: READ_FLAGS,
      ocw_memory_read: READ_FLAGS,
      ocw_memory_write: WRITE_FLAGS,
      ocw_memory_propose: READ_FLAGS,
    });
    const [scope] = await personalScopes(samBotId, samId);
    expect(ev.turn.memoryFiles).toEqual([
      {
        scopeKind: "personal",
        scopeId: scope?.id,
        path: "MEMORY.md",
        version: 1,
        content: "# Memory\n",
        truncated: false,
      },
    ]);

    // The gate lets the read through (generic /tool-calls), then the route answers the file.
    const gate = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: samBotId,
      tool: "ocw_memory_read",
      params: {},
    });
    expect(gate.body).toMatchObject({ allowed: true });
    const r = await call("read", ev, { scope: "personal", path: "MEMORY.md" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ file: { path: "MEMORY.md", version: 1, content: "# Memory\n" } });

    const audit = (await audits("memory.agent_read")).at(-1);
    expect(audit).toMatchObject({
      actor_kind: "agent",
      actor_id: samBotId,
      user_id: samId,
      result: "success",
    });
    expect(audit?.metadata).toMatchObject({
      scopeId: scope?.id,
      scopeKind: "personal",
      version: 1,
      eventId: ev.eventId,
    });
    expect(JSON.stringify(audit)).not.toContain("MEMORY.md");
  });

  it("the human is never a parameter, the path grammar holds, and only this agent's live turn counts", async () => {
    const ev = await turn(sam, samDmId, samBotId, "and now?", false);
    const extra = await call("read", ev, { scope: "personal", path: "MEMORY.md", userId: anaId });
    expect(extra.status).toBe(400);
    expect((await call("read", ev, { scope: "personal", path: "../x.md" })).status).toBe(400);
    expect(
      (
        await call("write", ev, {
          scope: "personal",
          path: "a.md",
          mode: "append",
          content: "x",
          ownerUserId: anaId,
        })
      ).status,
    ).toBe(400);

    // Another agent naming Sam's turn, or an unknown event: no live turn of that agent (the PR #25 rule).
    const foreign = await call("read", ev, { scope: "personal", path: "MEMORY.md" }, archieId);
    expect(foreign.status).toBe(403);
    expect(codeOf(foreign)).toBe("no_trigger");
    const unknown = await cell("/memory/list", { eventId: randomUUID(), agentId: samBotId });
    expect(unknown.status).toBe(403);
    expect(codeOf(unknown)).toBe("no_trigger");
    const refused = (await audits("memory.agent_refused")).filter((a) => a.metadata.reason === "no_trigger");
    expect(refused.at(-1)).toMatchObject({ actor_kind: "system", result: "denied" });
    expect(refused.at(-1)?.metadata).toMatchObject({ route: "list", reason: "no_trigger" });
  });
});

// ---------------------------------------------------------------- Task 2: the audience matrix

describe("agent reads follow the audience of the conversation (D-08, Pitfall 5)", () => {
  let groupId: string;
  let privateId: string;
  let publicId: string;

  beforeAll(async () => {
    groupId = (
      await ok(
        sam.request("POST", "/api/v1/dms", {
          participants: [
            { kind: "user", id: anaId },
            { kind: "agent", id: archieId },
          ],
        }),
      )
    ).id;
    privateId = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "iberia-room", visibility: "private" }))
    ).id;
    for (const [kind, id] of [
      ["user", samId],
      ["user", anaId],
      ["agent", archieId],
    ] as const) {
      await ok(admin.request("POST", `/api/v1/channels/${privateId}/members`, { kind, id }));
    }
    publicId = (await ok(admin.request("POST", "/api/v1/channels", { name: "town-square" }))).id;
    await ok(sam.request("POST", `/api/v1/channels/${publicId}/join`));
  });

  const read = (ev: Json, scope: string, path: string) => call("read", ev, { scope, path });

  it("a group DM never shows Sam's private memory, and creates no scope for a refused read", async () => {
    const ev = await turn(sam, groupId, archieId, "@archie what do you know about me?");
    expect(ev.conversation.kind).toBe("group");
    expect(ev.turn.tools).toEqual([
      "ocw_memory_list",
      "ocw_memory_read",
      "ocw_memory_propose",
      "ocw_agent_card",
    ]);
    expect(ev.turn.memory).toEqual([]);
    expect(ev.turn.memoryFiles).toBeUndefined();
    expect((await read(ev, "personal", "MEMORY.md")).body).toEqual({ refused: "audience_too_wide" });
    // Ana asks too: her private scope with Archie is decided before it would exist, so none is created.
    const anaEv = await turn(ana, groupId, archieId, "@archie and me?");
    expect((await read(anaEv, "personal", "MEMORY.md")).body).toEqual({ refused: "audience_too_wide" });
    expect(await personalScopes(archieId, anaId)).toEqual([]);
    // Both readers are in Iberia: its file is fine here.
    expect((await read(ev, scopeOf[A] as string, "clients/acme.md")).body).toEqual({
      file: { path: "clients/acme.md", version: 1, content: `# Acme\n${CANARY}\n` },
    });
  });

  it("a private channel: Iberia's file while every member reads it, audience_too_wide once a Nordics member joins", async () => {
    const ev = await turn(sam, privateId, archieId, "@archie open the Acme notes");
    expect((await read(ev, scopeOf[A] as string, "clients/acme.md")).body.file).toMatchObject({ version: 1 });
    await ok(admin.request("POST", `/api/v1/channels/${privateId}/members`, { kind: "user", id: beaId }));
    try {
      const after = await read(ev, scopeOf[A] as string, "clients/acme.md");
      expect(after.body).toEqual({ refused: "audience_too_wide" });
      expect(JSON.stringify(after.body)).not.toContain(CANARY);
    } finally {
      await su.query("delete from app.conversation_members where conversation_id = $1 and member_id = $2", [
        privateId,
        beaId,
      ]);
    }
  });

  it("a public channel: only organization-wide files nobody is denied", async () => {
    const ev = await turn(sam, publicId, archieId, "@archie what is in memory?");
    expect(ev.conversation.kind).toBe("channel");
    expect((await read(ev, scopeOf[A] as string, "clients/acme.md")).body).toEqual({
      refused: "audience_too_wide",
    });
    expect((await read(ev, scopeOf.org as string, "handbook.md")).body.file).toMatchObject({
      path: "handbook.md",
    });
    // Bea may not read private/: anyone may join a public channel, so it is too wide here.
    expect((await read(ev, scopeOf.org as string, "private/plan.md")).body).toEqual({
      refused: "audience_too_wide",
    });
    const listed = await call("list", ev, { scope: scopeOf.org });
    // Bea's denied folder is absent; by path, case-insensitively.
    expect((listed.body.files as Json[]).map((f) => f.path)).toEqual(["handbook.md", "MEMORY.md"]);
  });

  it("a file the asking human may not read is not_found (never revealed), whatever the audience", async () => {
    const ev = await turn(sam, samArchieDm, archieId, "open the Nordics plan", false);
    expect((await read(ev, scopeOf[B] as string, "plan.md")).body).toEqual({ refused: "not_found" });
    expect((await read(ev, randomUUID(), "plan.md")).body).toEqual({ refused: "not_found" });
    expect((await read(ev, scopeOf[A] as string, "clients/missing.md")).body).toEqual({
      refused: "not_found",
    });
  });

  it("list without a scope: the scopes usable here; the private one only in the one-person DM", async () => {
    const dm = await turn(sam, samArchieDm, archieId, "which memory can you use?", false);
    const inDm = await call("list", dm, {});
    const [own] = await personalScopes(archieId, samId);
    const kinds = (inDm.body.scopes as Json[]).map((s) => (s.kind === "unit" ? s.unitId : s.kind));
    expect(kinds).toContain("personal");
    expect((inDm.body.scopes as Json[]).find((s) => s.kind === "personal")?.id).toBe(own?.id);
    expect(kinds).not.toContain(B);
    expect(kinds).toContain("org");

    const pub = await turn(sam, publicId, archieId, "@archie which memory here?");
    const inPublic = (await call("list", pub, {})).body.scopes as Json[];
    expect(inPublic.map((s) => s.kind)).toEqual(["org"]);
    expect(inPublic[0]?.viewerCan).toEqual(["read"]);
  });
});

// ---------------------------------------------------------------- WINDOWS 148: the turn's cap on the read routes

describe("list and read count against the turn's tool-call cap on the routes themselves (WINDOWS 148)", () => {
  it("each call counts once, whether or not the cell asked the gate first; the ninth is cap_reached", async () => {
    const ev = await turn(sam, samDmId, samBotId, "what do you know?", false);
    // Straight to the routes (a cell that skips /tool-calls): each call still counts.
    expect((await call("read", ev, { scope: "personal", path: "MEMORY.md" })).body).toHaveProperty("file");
    expect(await toolCalls(ev.eventId)).toBe(1);
    expect((await call("list", ev, {})).body).toHaveProperty("scopes");
    expect(await toolCalls(ev.eventId)).toBe(2);
    // Through the gate (the plugin's path): the gate checks the cap, the route counts; one call is one count.
    const gate = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: samBotId,
      tool: "ocw_memory_read",
      params: {},
    });
    expect(gate.body).toMatchObject({ allowed: true });
    expect(await toolCalls(ev.eventId)).toBe(2);
    expect((await call("read", ev, { scope: "personal", path: "MEMORY.md" })).body).toHaveProperty("file");
    expect(await toolCalls(ev.eventId)).toBe(3);

    // At the cap: both routes refuse, nothing is read, and the count stays at the cap.
    await su.query("update app.agent_turns set tool_calls = 8 where event_id = $1", [ev.eventId]);
    expect((await call("read", ev, { scope: "personal", path: "MEMORY.md" })).body).toEqual({
      refused: "cap_reached",
    });
    expect((await call("list", ev, {})).body).toEqual({ refused: "cap_reached" });
    expect(await toolCalls(ev.eventId)).toBe(8);
    const gated = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: samBotId,
      tool: "ocw_memory_list",
      params: {},
    });
    expect(gated.body).toMatchObject({ allowed: false, reason: "cap_reached" });
    const refused = (await audits("memory.agent_refused")).filter((a) => a.metadata.eventId === ev.eventId);
    expect(refused.map((a) => [a.metadata.route, a.metadata.reason])).toEqual([
      ["read", "cap_reached"],
      ["list", "cap_reached"],
    ]);
  });
});

// ---------------------------------------------------------------- Task 2: writes

describe("agents write only their own scopes, before any untrusted content, within the turn's cap (D-08)", () => {
  const append = (ev: Json, content: string, scope = "personal", path = "MEMORY.md") =>
    call("write", ev, { scope, path, mode: "append", content });

  it("an append lands as a revision by the bot on behalf of Sam; replace needs the version it read", async () => {
    const ev = await turn(sam, samDmId, samBotId, "remember I like tea", false);
    const r = await append(ev, "- likes tea");
    expect(r.body).toEqual({ fileId: expect.any(String), version: 2 });
    const rev = (
      await su.query(
        "select author_kind, author_id, on_behalf_of_user_id, op from app.memory_file_revisions where file_id = $1 and version = 2",
        [r.body.fileId],
      )
    ).rows[0];
    expect(rev).toEqual({
      author_kind: "agent",
      author_id: samBotId,
      on_behalf_of_user_id: samId,
      op: "append",
    });
    expect(await toolCalls(ev.eventId)).toBe(1);

    const replace = (expectedVersion?: number) =>
      call("write", ev, {
        scope: "personal",
        path: "MEMORY.md",
        mode: "replace",
        content: "# Memory\n- likes green tea\n",
        ...(expectedVersion ? { expectedVersion } : {}),
      });
    expect((await replace(1)).body).toEqual({ refused: "version_conflict" });
    expect((await replace()).body).toEqual({ refused: "version_conflict" });
    expect((await replace(2)).body).toEqual({ fileId: r.body.fileId, version: 3 });
    // A new file without a version is created; the personal bot's own notebook is its own scope too.
    expect(
      (
        await call("write", ev, {
          scope: "personal",
          path: "trips.md",
          mode: "replace",
          content: "# Trips\n",
        })
      ).body,
    ).toMatchObject({ version: 1 });
    expect((await append(ev, "- Sam's assistant", "agent")).body).toMatchObject({ version: 2 });
    const refusedCodes = (await audits("memory.agent_refused")).map((a) => a.metadata.reason);
    expect(refusedCodes.filter((c) => c === "version_conflict")).toHaveLength(2);
  });

  it("shared scopes are own_scope_only (a unit id, a team bot's notebook); nothing is written", async () => {
    const ev = await turn(sam, samDmId, samBotId, "save it for the team", false);
    expect((await append(ev, "- team note", scopeOf[A] as string, "notes.md")).body).toEqual({
      refused: "own_scope_only",
    });
    const archie = await turn(sam, samArchieDm, archieId, "note this in your notebook", false);
    expect(archie.turn.tools).toContain("ocw_memory_write");
    expect((await append(archie, "- shared", "agent")).body).toEqual({ refused: "own_scope_only" });
    expect(
      (await su.query("select 1 from app.memory_scopes where kind = 'agent' and agent_id = $1", [archieId]))
        .rows,
    ).toEqual([]);
    expect(await toolCalls(ev.eventId)).toBe(0);
  });

  it("refused: after web content (tainted), with a secret, past the cap, outside a one-person DM, with memory off", async () => {
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: true }));
    try {
      const ev = await turn(sam, samDmId, samBotId, "look it up and remember it", false);
      const web = await cell("/tool-calls", {
        eventId: ev.eventId,
        agentId: samBotId,
        tool: "web_search",
        params: { query: "x" },
      });
      expect(web.body).toMatchObject({ allowed: true });
      expect((await append(ev, "- from the web")).body).toEqual({ refused: "tainted" });
    } finally {
      await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { internet: false }));
    }

    const secret = await turn(sam, samDmId, samBotId, "remember my key", false);
    expect((await append(secret, `- key ${ANTHROPIC_KEY}`)).body).toEqual({ refused: "secret_detected" });
    expect(
      (
        await su.query("select count(*)::int as n from app.memory_files where content like $1", [
          `%${ANTHROPIC_KEY}%`,
        ])
      ).rows[0].n,
    ).toBe(0);

    const capped = await turn(sam, samDmId, samBotId, "many things", false);
    await su.query("update app.agent_turns set tool_calls = 8 where event_id = $1", [capped.eventId]);
    expect((await append(capped, "- ninth")).body).toEqual({ refused: "cap_reached" });

    const group = (
      await ok(
        sam.request("POST", "/api/v1/dms", {
          participants: [
            { kind: "user", id: beaId },
            { kind: "agent", id: archieId },
          ],
        }),
      )
    ).id;
    const inGroup = await turn(sam, group, archieId, "@archie remember this");
    expect(inGroup.turn.tools).not.toContain("ocw_memory_write");
    expect((await append(inGroup, "- planted")).body).toEqual({ refused: "not_in_turn" });

    const delivered = await turn(sam, samDmId, samBotId, "one more", false);
    await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { memory: false }));
    try {
      expect((await append(delivered, "- too late")).body).toEqual({ refused: "memory_off" });
      expect((await call("read", delivered, { scope: "personal", path: "MEMORY.md" })).body).toEqual({
        refused: "memory_off",
      });
    } finally {
      await ok(sam.request("PATCH", `/api/v1/agents/${samBotId}/capabilities`, { memory: true }));
    }
    const audit = JSON.stringify(await audits("memory.agent_refused"));
    expect(audit).not.toContain(ANTHROPIC_KEY);
    expect(audit).not.toContain("planted");
  });
});

// ---------------------------------------------------------------- Task 2: proposals

describe("everything else is a proposal a person approves (07.2-09)", () => {
  it("into Iberia: an approval and its card; on a tainted turn: accepted and flagged; into Nordics: denied", async () => {
    const ev = await turn(sam, samDmId, samBotId, "save the Acme contact for the team", false);
    const r = await call("propose", ev, {
      scope: scopeOf[A],
      path: "clients/contacts.md",
      op: "create",
      content: "# Contacts\nAcme: a.person@acme.example\n",
      reason: "Sam asked to share it",
    });
    expect(r.body).toMatchObject({ approvalId: expect.any(String), readerCount: expect.any(Number) });
    expect((r.body.findings as Json[]).map((f) => f.kind)).toEqual(["email"]);
    const approval = (
      await su.query("select status, card_message_id from app.approval_requests where id = $1", [
        r.body.approvalId,
      ])
    ).rows[0];
    expect(approval.status).toBe("pending");
    expect(approval.card_message_id).toEqual(expect.any(String));

    await su.query("update app.agent_turns set tainted = true where event_id = $1", [ev.eventId]);
    const tainted = await call("propose", ev, {
      scope: scopeOf[A],
      path: "clients/web.md",
      op: "create",
      content: "# From the web\n",
    });
    expect(tainted.body).toMatchObject({ approvalId: expect.any(String) });
    const row = (
      await su.query(
        "select tainted from app.memory_proposals where requested_by_agent_id = $1 order by created_at desc limit 1",
        [samBotId],
      )
    ).rows[0];
    expect(row.tainted).toBe(true);

    const nordics = await call("propose", ev, {
      scope: scopeOf[B],
      path: "x.md",
      op: "create",
      content: "x\n",
    });
    expect(nordics.body).toEqual({ refused: "denied" });
  });

  it("personal memory is proposed only from the one-person DM (dm_only), without creating its scope", async () => {
    const group = (
      await ok(
        ana.request("POST", "/api/v1/dms", {
          participants: [
            { kind: "user", id: beaId },
            { kind: "agent", id: archieId },
          ],
        }),
      )
    ).id;
    const ev = await turn(ana, group, archieId, "@archie remember my desk");
    const r = await call("propose", ev, {
      scope: "personal",
      path: "MEMORY.md",
      op: "append",
      content: "- desk 4\n",
    });
    expect(r.body).toEqual({ refused: "dm_only" });
    expect(await personalScopes(archieId, anaId)).toEqual([]);
  });
});

// ---------------------------------------------------------------- Task 2: the turn's human, other tenants, the registry

describe("no live turn, no memory (the rule of every agent call)", () => {
  it("once the turn's human no longer reads the conversation: 403 no_trigger on every route", async () => {
    const roomId = (
      await ok(admin.request("POST", "/api/v1/channels", { name: "short-lived", visibility: "private" }))
    ).id;
    await ok(admin.request("POST", `/api/v1/channels/${roomId}/members`, { kind: "user", id: samId }));
    await ok(admin.request("POST", `/api/v1/channels/${roomId}/members`, { kind: "agent", id: archieId }));
    const ev = await turn(sam, roomId, archieId, "@archie read the handbook");
    expect((await call("read", ev, { scope: scopeOf.org, path: "handbook.md" })).status).toBe(200);
    expect(await toolCalls(ev.eventId)).toBe(1); // the read counts (WINDOWS 148)
    await su.query("delete from app.conversation_members where conversation_id = $1 and member_id = $2", [
      roomId,
      samId,
    ]);
    for (const [route, extra] of [
      ["list", {}],
      ["read", { scope: scopeOf.org, path: "handbook.md" }],
      ["write", { scope: "personal", path: "MEMORY.md", mode: "append", content: "- x" }],
      ["propose", { scope: scopeOf.org, path: "x.md", op: "create", content: "x\n" }],
    ] as const) {
      const r = await call(route, ev, extra);
      expect(r.status, route).toBe(403);
      expect(codeOf(r), route).toBe("no_trigger");
    }
    expect(await toolCalls(ev.eventId)).toBe(1);
  });

  it("org B's cell token with org A's turn: 403 no_trigger on all four routes, nothing changes", async () => {
    const orgB = randomUUID();
    await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
      orgB,
      `evil-${orgB}`,
    ]);
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, sha256Hex(tokenB)],
    );
    const ev = await turn(sam, samDmId, samBotId, "hello", false);
    const before = (await su.query("select count(*)::int as n from app.memory_file_revisions")).rows[0].n;
    for (const [route, extra] of [
      ["list", {}],
      ["read", { scope: "personal", path: "MEMORY.md" }],
      ["write", { scope: "personal", path: "MEMORY.md", mode: "append", content: "- planted" }],
      ["propose", { scope: "personal", path: "MEMORY.md", op: "append", content: "- planted\n" }],
    ] as const) {
      const r = await cell(`/memory/${route}`, { eventId: ev.eventId, agentId: samBotId, ...extra }, tokenB);
      expect(r.status, route).toBe(403);
      expect(codeOf(r), route).toBe("no_trigger");
    }
    expect((await su.query("select count(*)::int as n from app.memory_file_revisions")).rows[0].n).toBe(
      before,
    );
    expect(await toolCalls(ev.eventId)).toBe(0);
  });

  it("the authz registry declares the four routes as cell routes", () => {
    const routes = stack.built.authz.routes;
    const memory = [...routes.keys()].filter((k) => k.startsWith("POST /agent-channel/v1/memory/")).sort();
    expect(memory).toEqual(
      ["list", "propose", "read", "write"].map((r) => `POST /agent-channel/v1/memory/${r}`),
    );
    for (const key of memory) expect(routes.get(key), key).toBe("cell");
  });
});

// ---------------------------------------------------------------- WINDOWS 123: parity with the plugin

describe("the plugin's own client and mirror read every real answer (WINDOWS 123)", () => {
  // Non-literal specifiers: the plugin is another package and is not type-checked from here (as in its own parity tests).
  const pluginFile = (name: string) =>
    new URL(`../../../../openclaw-channel/src/${name}`, import.meta.url).href;

  it("list, read, write, propose and a refusal parse with the plugin's schemas; no_trigger reaches it as a 403", async () => {
    const client = (await import(pluginFile("api-client.ts"))) as {
      createAgentChannelClient: (o: { apiUrl: string; token: () => string; maxAttempts?: number }) => Json;
      AgentChannelHttpError: new (...a: unknown[]) => Error;
    };
    const protocol = (await import(pluginFile("agent-channel-protocol.ts"))) as Json;
    const c = client.createAgentChannelClient({
      apiUrl: stack.baseUrl,
      token: () => CELL_TOKEN,
      maxAttempts: 1,
    });
    const ev = await turn(sam, samDmId, samBotId, "parity", false);
    const base = { eventId: ev.eventId, agentId: samBotId };

    // The delivered turn, as the plugin's mirror reads it: the memory files survive the mirror unchanged.
    const mirrored = protocol.TurnContext.parse(ev.turn);
    expect(mirrored.memoryFiles).toEqual(ev.turn.memoryFiles);
    // Sam's private MEMORY.md and his personal bot's notebook (written above): both only in this one-person DM.
    expect(mirrored.memoryFiles.map((f: Json) => f.scopeKind)).toEqual(["personal", "agent"]);

    const scopes = await c.memoryList(base);
    expect(scopes.scopes.length).toBeGreaterThan(0);
    const files = await c.memoryList({ ...base, scope: "personal" });
    expect(files.files.map((f: Json) => f.path)).toContain("MEMORY.md");
    const read = await c.memoryRead({ ...base, scope: "personal", path: "MEMORY.md" });
    expect(read.file.path).toBe("MEMORY.md");
    const write = await c.memoryWrite({
      ...base,
      scope: "personal",
      path: "MEMORY.md",
      mode: "append",
      content: "- parity",
    });
    expect(write.version).toBeGreaterThan(1);
    const proposed = await c.memoryPropose({
      ...base,
      scope: scopeOf.org,
      path: "parity.md",
      op: "create",
      content: "# Parity\n",
    });
    expect(proposed.approvalId).toEqual(expect.any(String));
    expect(await c.memoryRead({ ...base, scope: scopeOf[B], path: "plan.md" })).toEqual({
      refused: "not_found",
    });

    await expect(
      c.memoryRead({ eventId: randomUUID(), agentId: samBotId, scope: "personal", path: "MEMORY.md" }),
    ).rejects.toMatchObject({ status: 403, code: "no_trigger" });
  });
});
