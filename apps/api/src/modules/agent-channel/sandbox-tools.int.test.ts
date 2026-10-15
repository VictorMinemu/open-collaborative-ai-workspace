import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { type TestClient, WEB_ORIGIN } from "../../testing";
import { codeOf, type Json, ok, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage } from "../../testing-storage";

/**
 * 07.8-10 Task 2 (SBX-02; D-02, D-11 F-7, P-06, P-07, P-17): the bot's file and process tools. Each route is decided by
 * `decideSandboxCall` with its static flag class (read, list and process taint the turn; write and delete do not),
 * counted against the per-turn budget of 40, audited with ids, sizes and counts only, recorded as a step of the turn's
 * activity, and refused for another organization's cell. Task 3: `share` turns a sandbox file into an attachment of
 * the bot's reply, the only confined tool that counts as leaving the sandbox. Real PostgreSQL + Redis + Garage (the
 * artifact storage); the in-memory sandboxd (P-13).
 */

const SENTINEL = "OCW-SENTINEL-FILE-9182";
/** A small attachment limit, so a share over it needs no large file. */
const ATTACHMENT_MAX = 65_536;
let storage: TestStorage;
let s: SandboxStack;

const tool = (name: string, ev: Json, body: Json = {}, opts: { agentId?: string; token?: string } = {}) =>
  s.cell(
    `/sandbox/${name}`,
    { eventId: ev.eventId, agentId: opts.agentId ?? s.scoutId, ...body },
    opts.token,
  );

const write = (ev: Json, path: string, content: string, agentId?: string) =>
  ok(tool("write", ev, { path, content, mode: "overwrite" }, { agentId }));

const turnRow = async (eventId: string) =>
  (
    await s.su.query("select tainted, tool_calls, sandbox_calls from app.agent_turns where event_id = $1", [
      eventId,
    ])
  ).rows[0] as Json;

const auditOf = async (action: string, eventId: string) =>
  (
    await s.su.query(
      "select agent_id, user_id, result, metadata from app.audit_events where action = $1 and metadata->>'eventId' = $2",
      [action, eventId],
    )
  ).rows as Json[];

/** Writes straight into the fake sandboxd (setup only; the bot's own calls go through the API). */
async function seed(path: string, content: string, agentId = s.scoutId) {
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

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({
      env: { ...storage.env, OCW_ATTACHMENT_MAX_BYTES: String(ATTACHMENT_MAX) },
    });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  await s.setPolicy({ enabled: true });
});

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

describe("read (taints; at most 256 KB; a folder is invalid_path)", () => {
  it("returns utf8 content and taints the turn; a write before it did not", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "notes/today.md", `hello ${SENTINEL}`);
    expect((await turnRow(ev.eventId)).tainted).toBe(false);
    const read = await ok(tool("read", ev, { path: "notes/today.md" }));
    expect(read).toEqual({
      path: "notes/today.md",
      content: `hello ${SENTINEL}`,
      encoding: "utf8",
      size: 6 + SENTINEL.length,
      truncated: false,
    });
    expect((await turnRow(ev.eventId)).tainted).toBe(true);
    // Never content in the ledger, the audit, the activity or the stream.
    const leaks = await s.su.query(
      `select (select count(*) from app.bot_turn_activity where steps::text like $1)
            + (select count(*) from app.audit_events where metadata::text like $1)
            + (select count(*) from app.agent_tool_calls where coalesce(reason, '') || coalesce(target, '') like $1)
            + (select count(*) from app.stream_events where payload::text like $1) as n`,
      [`%${SENTINEL}%`],
    );
    expect(Number(leaks.rows[0].n)).toBe(0);
  });

  it("a 300 KB file returns its first 256 KB and `truncated`; a folder is 422 invalid_path; a missing file 404", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await seed("big/log.txt", "a".repeat(300 * 1024));
    const read = await ok(tool("read", ev, { path: "big/log.txt" }));
    expect(read.content).toHaveLength(256 * 1024);
    expect(read.truncated).toBe(true);
    expect(read.size).toBe(300 * 1024);
    const dir = await tool("read", ev, { path: "big" });
    expect(dir.status).toBe(422);
    expect(codeOf(dir)).toBe("invalid_path");
    const missing = await tool("read", ev, { path: "nope.txt" });
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe("not_found");
  });
});

describe("list (taints; folders first; at most 500 and `more`)", () => {
  it("lists folders first, then files, and taints the turn", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await seed("tree/b.txt", "b");
    await seed("tree/a.txt", "a");
    await seed("tree/zeta/x.txt", "x");
    await seed("tree/alpha/y.txt", "y");
    const list = await ok(tool("list", ev, { path: "tree" }));
    expect(list.entries.map((e: Json) => [e.kind, e.name])).toEqual([
      ["dir", "alpha"],
      ["dir", "zeta"],
      ["file", "a.txt"],
      ["file", "b.txt"],
    ]);
    expect(list.more).toBe(0);
    expect((await turnRow(ev.eventId)).tainted).toBe(true);
  });

  it("501 entries: 500 and `more: 1`", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    for (let i = 0; i < 501; i++) await seed(`many/f${String(i).padStart(3, "0")}.txt`, "1");
    const list = await ok(tool("list", ev, { path: "many" }));
    expect(list.entries).toHaveLength(500);
    expect(list.more).toBe(1);
  });
});

describe("delete (does not taint; a folder needs `recursive`)", () => {
  it("non-recursive on a folder is 422 invalid_path; recursive deletes and counts; one audit with the count", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "old/a.txt", "a");
    await write(ev, "old/sub/b.txt", "b");
    const refused = await tool("delete", ev, { path: "old" });
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe("invalid_path");
    const done = await ok(tool("delete", ev, { path: "old", recursive: true }));
    expect(done).toEqual({ path: "old", deleted: 4 });
    expect((await turnRow(ev.eventId)).tainted).toBe(false);
    const audits = await auditOf("sandbox.file_deleted", ev.eventId);
    const ok1 = audits.find((a) => a.result === "success");
    expect(ok1).toMatchObject({ agent_id: s.scoutId, user_id: s.samId });
    expect(ok1?.metadata).toMatchObject({
      deleted: 4,
      recursive: true,
      pathLength: 3,
      pathSha256: sha256Hex("old"),
    });
    expect(JSON.stringify(audits)).not.toContain('"old"');
    const missing = await tool("delete", ev, { path: "gone.txt" });
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe("not_found");
  });
});

describe("process (taints; scoped to the bot)", () => {
  it("polls and kills a running command of this turn and of an earlier turn; another bot's id is 404", async () => {
    const ev1 = await s.turnOf(s.sam, s.samDm);
    const started = await ok(tool("exec", ev1, { argv: ["sleep", "60"], background: true }));
    expect(started.status).toBe("running");
    const pid = started.processId as string;
    const polled = await ok(tool("process", ev1, { processId: pid, action: "poll" }));
    expect(polled).toMatchObject({ status: "running", processId: pid });

    // A later turn of the same bot.
    const ev2 = await s.turnOf(s.sam, s.samDm);
    expect((await ok(tool("process", ev2, { processId: pid, action: "poll" }))).status).toBe("running");
    expect((await turnRow(ev2.eventId)).tainted).toBe(true);

    // Another bot of the organization, with its own sandbox, cannot reach Scout's process.
    const rover = await s.newBot(`Rover ${randomUUID().slice(0, 4)}`);
    const evR = await s.turnOf(s.sam, rover.dm, rover.id);
    const foreign = await tool("process", evR, { processId: pid, action: "kill" }, { agentId: rover.id });
    expect(foreign.status).toBe(404);
    expect(codeOf(foreign)).toBe("not_found");

    const killed = await ok(tool("process", ev2, { processId: pid, action: "kill" }));
    expect(killed).toMatchObject({ status: "exited", exitCode: 137 });
    expect((await auditOf("sandbox.process_stopped", ev2.eventId))[0]?.metadata).toMatchObject({
      status: "exited",
      exitCode: 137,
    });
  });
});

describe("flag classes and the budget across tools (D-11 F-7, P-06)", () => {
  it("after a read the turn is tainted, yet write, delete and exec still run; every call counts against 40", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "flow/in.txt", "1");
    await ok(tool("read", ev, { path: "flow/in.txt" }));
    expect((await turnRow(ev.eventId)).tainted).toBe(true);
    await write(ev, "flow/out.txt", "2");
    await ok(tool("delete", ev, { path: "flow/in.txt" }));
    await ok(tool("exec", ev, { argv: ["echo", "ok"] }));
    await ok(tool("list", ev, { path: "flow" }));
    const row = await turnRow(ev.eventId);
    expect(row.sandbox_calls).toBe(6);
    expect(row.tool_calls).toBe(0);
    // The budget is shared by every sandbox tool.
    for (let i = 6; i < 40; i++) await ok(tool("list", ev, { path: "" }));
    const over = await tool("write", ev, { path: "flow/late.txt", content: "x", mode: "overwrite" });
    expect(over.status).toBe(403);
    expect(codeOf(over)).toBe("budget_exhausted");
  });

  it("every call is one step of the turn's activity, masked, with the tool's verb", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "act/a.txt", "1");
    await ok(tool("read", ev, { path: "act/a.txt" }));
    await ok(tool("list", ev, { path: "act" }));
    await ok(tool("delete", ev, { path: "act/a.txt" }));
    const { rows } = await s.su.query(
      "select steps, running from app.bot_turn_activity where event_id = $1",
      [ev.eventId],
    );
    expect(rows[0].running).toBe(true);
    expect((rows[0].steps as Json[]).map((x) => [x.verb, x.target, x.outcome.kind])).toEqual([
      ["wrote", "act/a.txt · 1 B", "ok"],
      ["read", "act/a.txt", "ok"],
      ["listed", "act", "ok"],
      ["deleted", "act/a.txt", "ok"],
    ]);
  });
});

describe("cross-tenant guards derived from the authz registry (P-17, 07.4 #169)", () => {
  it("every /agent-channel/v1/sandbox/* route is a cell route and refuses organization B's cell with no_trigger", async () => {
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "tenant/a.txt", "a");
    const before = (
      await s.su.query("select count(*)::int as n from app.agent_tool_calls where event_id = $1", [
        ev.eventId,
      ])
    ).rows[0].n as number;
    const opsBefore = JSON.stringify(s.sandboxd.stats().calls);
    const bodies: Record<string, Json> = {
      exec: { argv: ["echo", "b"] },
      process: { processId: "p1", action: "poll" },
      read: { path: "tenant/a.txt" },
      write: { path: "tenant/b.txt", content: "b", mode: "overwrite" },
      list: { path: "" },
      delete: { path: "tenant/a.txt" },
      share: { path: "tenant/a.txt" },
    };
    const cases: Record<string, () => Promise<void>> = Object.fromEntries(
      Object.entries(bodies).map(([name, body]) => [
        `POST /agent-channel/v1/sandbox/${name}`,
        async () => {
          const r = await tool(name, ev, body, { token: tokenB });
          expect(r.status, name).toBe(403);
          expect(codeOf(r), name).toBe("no_trigger");
        },
      ]),
    );
    const registered = [...s.stack.built.authz.routes.keys()].filter((k) =>
      k.startsWith("POST /agent-channel/v1/sandbox/"),
    );
    expect(registered.sort()).toEqual(Object.keys(cases).sort());
    for (const [key, run] of Object.entries(cases)) {
      expect(s.stack.built.authz.routes.get(key), key).toBe("cell");
      await run();
    }
    // Nothing was recorded for organization A's turn, and sandboxd was never asked.
    const after = (
      await s.su.query("select count(*)::int as n from app.agent_tool_calls where event_id = $1", [
        ev.eventId,
      ])
    ).rows[0].n as number;
    expect(after).toBe(before);
    expect(JSON.stringify(s.sandboxd.stats().calls)).toBe(opsBefore);
  });

  it("another bot of the same organization cannot use a turn that is not its own", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const other = await s.newBot(`Other ${randomUUID().slice(0, 4)}`);
    const r = await tool("read", ev, { path: "x.txt" }, { agentId: other.id });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("no_trigger");
  });
});

// ---------------------------------------------------------------- Task 3: share

/** The attachment download as a reader asks for it (302 to a presigned URL, or 404); never followed. */
async function download(who: TestClient, attachmentId: string): Promise<Response> {
  return fetch(`${s.stack.baseUrl}/api/v1/attachments/${attachmentId}/download`, {
    redirect: "manual",
    headers: { origin: WEB_ORIGIN, cookie: who.cookieHeader },
  });
}

const replyTo = (ev: Json, text = "Here it is.") =>
  ok(
    s.cell("/messages", {
      agentId: s.scoutId,
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

const sharedOf = async (eventId: string) =>
  Number(
    (await s.su.query("select count(*)::int as n from app.attachments where event_id = $1", [eventId]))
      .rows[0].n,
  );

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

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

describe("share: a sandbox file becomes an attachment of the bot's reply (D-11 F-7: side-effecting)", () => {
  it("on a clean turn: pending for the turn, linked to its reply for its readers only, audited with ids and size", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    const csv = "id,late\n1,yes\n";
    await write(ev, "reports/late.csv", csv);
    const shared = await ok(tool("share", ev, { path: "reports/late.csv" }));
    expect(shared).toMatchObject({ name: "late.csv", size: csv.length });
    const id = shared.attachmentId as string;
    expect(await attachmentRow(id)).toMatchObject({
      status: "pending",
      uploader_id: s.scoutId,
      event_id: ev.eventId,
      message_id: null,
      conversation_id: s.samDm,
      filename: "late.csv",
    });
    // Nobody reads it before the reply, the turn's human included.
    expect((await download(s.sam, id)).status).toBe(404);
    // Sharing is not reading: the turn stays clean.
    expect((await turnRow(ev.eventId)).tainted).toBe(false);

    const posted = await replyTo(ev);
    expect((await attachmentRow(id))?.status).toBe("ready");
    expect((await attachmentRow(id))?.message_id).toBe(posted.messageId);
    const list = (await ok(s.sam.request("GET", `/api/v1/conversations/${s.samDm}/messages?limit=50`)))
      .messages as Json[];
    const msg = list.find((m) => m.id === posted.messageId);
    expect(msg?.attachments).toEqual([
      expect.objectContaining({ id, filename: "late.csv", size: csv.length, status: "ready" }),
    ]);
    expect(msg?.activity?.steps.map((x: Json) => [x.verb, x.target])).toEqual([
      ["wrote", "reports/late.csv · 14 B"],
      ["shared", "late.csv"],
    ]);

    const res = await download(s.sam, id);
    expect(res.status).toBe(302);
    const bytes = await (await fetch(res.headers.get("location") as string)).text();
    expect(bytes).toBe(csv);
    expect((await download(s.alex, id)).status).toBe(404);

    const audits = await auditOf("sandbox.file_shared", ev.eventId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ agent_id: s.scoutId, user_id: s.samId, result: "success" });
    expect(audits[0]?.metadata).toMatchObject({
      attachmentId: id,
      conversationId: s.samDm,
      size: csv.length,
    });
    expect(JSON.stringify(audits[0])).not.toContain("late.csv");
  });

  it("after a read in the same turn (tainted) it is 403 tainted and nothing is stored", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "loot.txt", "x");
    await ok(tool("read", ev, { path: "loot.txt" }));
    const r = await tool("share", ev, { path: "loot.txt" });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("tainted");
    expect(await sharedOf(ev.eventId)).toBe(0);
  });

  it("a 07.5 `when_tainted` rule: the tainted share asks the requester; once approved the re-run shares it once", async () => {
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, 'ocw_sandbox_share', 'when_tainted', 'requester', '{}', $2, $2)`,
      [s.orgA, s.victorId],
    );
    try {
      const ev = await s.turnOf(s.sam, s.samDm);
      await write(ev, "summary.txt", "ok");
      await ok(tool("read", ev, { path: "summary.txt" }));
      const asked = await tool("share", ev, { path: "summary.txt" });
      expect(asked.status, JSON.stringify(asked.body)).toBe(409);
      expect(codeOf(asked)).toBe("approval_required");
      expect(await sharedOf(ev.eventId)).toBe(0);
      const id = asked.body?.error.details.approval.id as string;
      const row = await approvalRow(id);
      expect(
        (
          await s.sam.request("POST", `/api/v1/approvals/${id}/decision`, {
            outcome: "approved",
            actionHash: row.action_hash,
          })
        ).status,
      ).toBe(200);
      const rerun = await rerunOf(id);
      const done = await ok(tool("share", rerun, { path: "summary.txt" }));
      expect(await attachmentRow(done.attachmentId)).toMatchObject({
        event_id: rerun.eventId,
        status: "pending",
      });
      const again = await tool("share", rerun, { path: "summary.txt" });
      expect(codeOf(again)).toBe("approval_used");
    } finally {
      await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
    }
  });

  it("over the attachment size limit is 413 too_large and nothing is stored", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "huge.txt", "z".repeat(ATTACHMENT_MAX + 1));
    const r = await tool("share", ev, { path: "huge.txt" });
    expect(r.status).toBe(413);
    expect(codeOf(r)).toBe("too_large");
    expect(await sharedOf(ev.eventId)).toBe(0);
  });

  it("a reply holds at most 10 files: the 11th share of a turn is 413 too_large", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    for (let i = 0; i < 11; i++) await seed(`batch/${i}.txt`, `${i}`);
    for (let i = 0; i < 10; i++) await ok(tool("share", ev, { path: `batch/${i}.txt` }));
    const r = await tool("share", ev, { path: "batch/10.txt" });
    expect(r.status).toBe(413);
    expect(codeOf(r)).toBe("too_large");
    const posted = await replyTo(ev);
    const linked = (
      await s.su.query("select count(*)::int as n from app.attachments where message_id = $1", [
        posted.messageId,
      ])
    ).rows[0].n;
    expect(linked).toBe(10);
  });

  it("a share whose reply never comes stays pending and is due for the attachment sweeper after 24 h", async () => {
    const ev = await s.turnOf(s.sam, s.samDm);
    await write(ev, "orphan.txt", "o");
    const shared = await ok(tool("share", ev, { path: "orphan.txt" }));
    const due = async (at: string) =>
      (await s.su.query("select id from app.due_attachment_sweeps(1000, $1)", [at])).rows.map((r) => r.id);
    expect(await due(new Date().toISOString())).not.toContain(shared.attachmentId);
    expect(await due(new Date(Date.now() + 25 * 3600_000).toISOString())).toContain(shared.attachmentId);
    expect((await attachmentRow(shared.attachmentId))?.status).toBe("pending");
  });
});
