import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentCard, AgentCardActionEvent, ApprovalDetail, type MemoryToolScope } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { type CreateMemoryProposalInput, createMemoryWriteKind } from "./index";

/**
 * 07.2-09 (MEM-04, MEM-05, MEM-06, MEM-07, D-06, D-08, ADR-0023): an agent's proposal into memory becomes an immutable
 * proposal and a pending `memory.write` approval mirrored as a platform-owned card; a person allowed to decide it makes
 * the server write exactly that revision. Real PostgreSQL + Redis, the real routes; the proposal is created through
 * the memory service (the Agent Channel route is 07.2-11), bound to a real delivered turn (`agent_turns`).
 *
 * The stack's Presidio URL points at a fake analyzer in this file: it answers nothing by default, a PERSON span on
 * demand, and is closed for the fail-open case (a refused connection).
 *
 * Cast: Víctor (admin); Lena (lead, leads team Iberia = A); Sam (standard, member of A) with his personal bot Scout;
 * Ana (standard, member of A); Bea (standard, member of team Nordics = B).
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-proposals-0123456789";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let lena: TestClient;
let sam: TestClient;
let orgId: string;
let adminId: string;
let lenaId: string;
let samId: string;
let anaId: string;
let D: string;
let A: string;
let B: string;
let scoutId: string;
let dmId: string;
const scopeOf: Record<string, string> = {};

// ---------------------------------------------------------------- the fake Presidio analyzer

let presidio: Server;
let presidioMode: "nothing" | "person" = "nothing";
let presidioCalls = 0;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startPresidio(): Promise<string> {
  presidio = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      presidioCalls += 1;
      const { text } = JSON.parse(body) as { text: string };
      if (presidioMode === "person") {
        const at = text.indexOf("Ana García");
        return json(
          res,
          200,
          at < 0 ? [] : [{ entity_type: "PERSON", start: at, end: at + 10, score: 0.85 }],
        );
      }
      return json(res, 200, []);
    });
  });
  await new Promise<void>((resolve) => presidio.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(presidio.address() as AddressInfo).port}`;
}

// ---------------------------------------------------------------- helpers

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const codeOf = (r: Res) => ((r.body as Json | null)?.error as Json | undefined)?.code as string | undefined;

async function joinAs(email: string, name: string, role: "standard" | "developer" | "lead" | "admin") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await ok(admin.request("POST", "/api/v1/units", { kind, name, parentId }))).id as string;

/** Sam writes in his DM with Scout; returns the delivered turn (`agent.mention.v1`) and his message. */
async function turn(text = "Please keep the Acme contact in team memory") {
  const messageId = (await ok(sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: text })))
    .id as string;
  const rows = (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2
          and payload->'message'->>'id' = $3`,
      [`cell:${orgId}`, scoutId, messageId],
    )
  ).rows;
  expect(rows, "one delivery").toHaveLength(1);
  return { eventId: rows[0].payload.eventId as string, messageId };
}

type ProposeArgs = Omit<CreateMemoryProposalInput, "origin" | "scope"> & {
  eventId: string;
  scope: MemoryToolScope;
  agentId?: string;
};

/** The memory service's proposal call inside one tenant transaction (07.2-11 wraps it in the Agent Channel route). */
const propose = (a: ProposeArgs) => {
  const { eventId, agentId, ...rest } = a;
  return stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
    stack.built.memory.propose(tx, {
      ...rest,
      origin: { kind: "agent_turn", eventId, agentId: agentId ?? scoutId },
    }),
  );
};

async function proposed(a: ProposeArgs) {
  const r = await propose(a);
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r;
}

const approvalRow = async (id: string) =>
  (await su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;
const proposalOf = async (approvalId: string) =>
  (
    await su.query(
      "select p.* from app.memory_proposals p join app.approval_requests r on r.resource_id = p.id where r.id = $1",
      [approvalId],
    )
  ).rows[0] as Json | undefined;
const fileAt = async (scopeId: string, path: string) =>
  (
    await su.query(
      "select * from app.memory_files where scope_id = $1 and lower(path) = lower($2) and deleted_at is null",
      [scopeId, path],
    )
  ).rows[0] as Json | undefined;
const revisionsOf = async (fileId: string) =>
  (await su.query("select * from app.memory_file_revisions where file_id = $1 order by version", [fileId]))
    .rows as Json[];
const auditsWhere = async (action: string, metadataKey: string, value: string) =>
  (
    await su.query(
      `select actor_kind, actor_id, agent_id, user_id, resource_id, result, metadata from app.audit_events
        where action = $1 and metadata->>$2 = $3 order by occurred_at`,
      [action, metadataKey, value],
    )
  ).rows as Json[];
const updatesOf = async (id: string) =>
  (
    await su.query(
      "select stream_id from app.stream_events where type = 'approval_request.updated' and payload->>'id' = $1",
      [id],
    )
  ).rows.map((r) => r.stream_id as string);
const cardActionsOf = async (messageId: string) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => AgentCardActionEvent.parse({ ...r.payload, seq: Number(r.seq) }));
const messageOf = async (id: string) =>
  (await su.query("select * from app.messages where id = $1", [id])).rows[0] as Json;

const detail = async (as: TestClient, id: string) =>
  ApprovalDetail.parse(await ok(as.request("GET", `/api/v1/approvals/${id}`)));
const decide = (as: TestClient, id: string, body: Json) =>
  as.request("POST", `/api/v1/approvals/${id}/decision`, body);
const cardFor = async (as: TestClient, messageId: string) =>
  AgentCard.parse(await ok(as.request("GET", `/api/v1/cards/${messageId}`)));

const ACME = "Contact ana@acme.com\nIBAN ES91 2100 0418 4502 0005 1332\n";

beforeAll(async () => {
  const presidioUrl = await startPresidio();
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", OCW_PRESIDIO_URL: presidioUrl },
  });
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
  adminId = setup.user.id;
  [lena, lenaId] = await joinAs("lena@example.test", "Lena Gil", "lead");
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [, anaId] = await joinAs("ana@example.test", "Ana Pérez", "standard");
  const [, beaId] = await joinAs("bea@example.test", "Bea Lind", "standard");
  D = await unit("department", "Sales", null);
  A = await unit("team", "Iberia", D);
  B = await unit("team", "Nordics", D);
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: lenaId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: samId }));
  await ok(admin.request("POST", `/api/v1/units/${A}/members`, { userId: anaId }));
  await ok(admin.request("POST", `/api/v1/units/${B}/members`, { userId: beaId }));
  const bot = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  scoutId = bot.agent.id;
  dmId = bot.dmId;
  for (const s of (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[]) {
    scopeOf[s.kind === "unit" ? s.unitId : s.kind] = s.id;
  }
}, 240_000);

afterAll(async () => {
  presidio?.closeAllConnections();
  await new Promise<void>((resolve) => (presidio ? presidio.close(() => resolve()) : resolve()));
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------------------------------------------- Task 1

describe("tracer: Scout's proposal into team memory becomes a pending card; Lena's approval writes exactly it (Task 1)", () => {
  let approvalId: string;
  let ev: { eventId: string; messageId: string };
  let cardMessageId: string;

  it("creates an immutable proposal, a pending approval, and one platform-owned card replying to Sam", async () => {
    ev = await turn();
    const r = await proposed({
      eventId: ev.eventId,
      scope: scopeOf[A] as string,
      path: "clients/acme.md",
      op: "create",
      content: ACME,
      reason: "Sam asked to keep the Acme contact",
    });
    approvalId = r.approvalId;
    // Admin, Lena (lead of A), Sam and Ana: exactly the people who may read team A's memory.
    expect(r.readerCount).toBe(4);
    expect(r.findings.map((f) => [f.kind, f.severity, f.samples])).toEqual([
      ["iban", "warn", ["ES91 •••• 1332"]],
      ["email", "warn", ["a•••@acme.com"]],
    ]);

    const row = await approvalRow(approvalId);
    expect(row).toMatchObject({
      kind: "memory.write",
      mode: "server_apply",
      resource_type: "memory_proposal",
      status: "pending",
      requested_by_agent_id: scoutId,
      requested_for_user_id: samId,
      event_id: ev.eventId,
      card_warnings: [],
    });
    const days = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    const p = await proposalOf(approvalId);
    expect(p).toMatchObject({
      scope_id: scopeOf[A],
      file_id: null,
      path: "clients/acme.md",
      op: "create",
      base_version: null,
      content: ACME,
      content_sha256: sha256Hex(ACME),
      reader_count: 4,
      tainted: false,
      requested_by_agent_id: scoutId,
      requested_for_user_id: samId,
      event_id: ev.eventId,
      conversation_id: dmId,
    });

    cardMessageId = row.card_message_id as string;
    const msg = await messageOf(cardMessageId);
    expect(msg).toMatchObject({ author_kind: "agent", author_id: scoutId, conversation_id: dmId });
    expect(msg.body).toBe("+ Contact a•••@acme.com\n+ IBAN ES91 •••• 1332");
    expect(msg.body).not.toContain("ana@acme.com");
    const card = await cardFor(sam, cardMessageId);
    expect(card).toMatchObject({
      kind: "approval",
      title: "Create clients/acme.md",
      status: "pending",
      platformOwned: true,
      approval: { id: approvalId, status: "pending", requestedForUserId: samId, warnings: [] },
    });
    expect(card.fields).toEqual([
      { label: "Memory", value: "Iberia · Team" },
      { label: "Readers", value: "4 people" },
      { label: "Found", value: "IBAN, Email" },
      { label: "Bot's note", value: "Sam asked to keep the Acme contact" },
    ]);
    expect(card.actions.find((a) => a.kind === "open")).toEqual({
      kind: "open",
      label: "Review changes",
      target: `/memory/proposals/${approvalId}`,
    });
    // Sam asked for it: he may not approve his own team proposal.
    expect(card.viewerCan).toEqual(["follow"]);
    expect(await updatesOf(approvalId)).toContain(`user:${lenaId}`);
  });

  it("GET /approvals/:id shows Lena the proposal view with spans covering exactly the PII", async () => {
    const d = await detail(lena, approvalId);
    expect(d.viewerCan).toEqual(["decide"]);
    expect(d.view.type).toBe("memory_proposal");
    if (d.view.type !== "memory_proposal") return;
    const v = d.view.proposal;
    expect(v).toMatchObject({
      scope: { id: scopeOf[A], kind: "unit", label: "Iberia" },
      path: "clients/acme.md",
      op: "create",
      baseVersion: null,
      currentVersion: null,
      base: null,
      proposed: ACME,
      linesAdded: 2,
      linesRemoved: 0,
      readerCount: 4,
      tainted: false,
      reason: "Sam asked to keep the Acme contact",
      requestedBy: {
        agent: { id: scoutId, displayName: "Sam's assistant" },
        forUser: { id: samId, displayName: "Sam Lee" },
      },
    });
    expect(v.findings.map((f) => f.kind)).toEqual(["iban", "email"]);
    expect(v.spans.map((s) => v.proposed.slice(s.start, s.end)).sort()).toEqual(
      ["ES91 2100 0418 4502 0005 1332", "ana@acme.com"].sort(),
    );
  });

  it("the inbox rows and the detail carry the kind's headline; the card is re-announced live with its link (07.2-13)", async () => {
    const headline = {
      title: "Create clients/acme.md",
      context: "Iberia · Team",
      requester: "Sam's assistant for Sam Lee",
      tags: [
        { label: "IBAN", tone: "warning" },
        { label: "Email", tone: "warning" },
      ],
    };
    expect((await detail(lena, approvalId)).headline).toEqual(headline);
    const listed = await ok(lena.request("GET", "/api/v1/approvals?role=decider&status=pending"));
    expect((listed.items as Json[]).find((i) => i.id === approvalId)?.headline).toEqual(headline);
    const mine = await ok(sam.request("GET", "/api/v1/approvals?role=requester"));
    expect((mine.items as Json[]).find((i) => i.id === approvalId)?.headline).toEqual(headline);
    // WINDOWS 160: after the link exists, readers of the DM get the card again with its approval.
    const frames = (
      await su.query(
        `select payload from app.stream_events where stream_id = $1 and type = 'message.updated'
          and payload->'message'->>'id' = $2`,
        [`conv:${dmId}`, cardMessageId],
      )
    ).rows as Json[];
    expect(frames.map((f) => f.payload.message.card?.approval?.id)).toContain(approvalId);
  });

  it("Lena approves with the hash she saw: the server writes exactly that revision, as Scout for Sam", async () => {
    const hash = (await detail(lena, approvalId)).actionHash;
    const res = await decide(lena, approvalId, { outcome: "approved", actionHash: hash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as Json).status).toBe("applied");
    const file = await fileAt(scopeOf[A] as string, "clients/acme.md");
    expect(file).toMatchObject({ content: ACME, version: 1 });
    const revs = await revisionsOf(file?.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      op: "create",
      content: ACME,
      author_kind: "agent",
      author_id: scoutId,
      on_behalf_of_user_id: samId,
      approval_request_id: approvalId,
    });
    const card = await cardFor(sam, cardMessageId);
    expect(card).toMatchObject({
      status: "succeeded",
      decision: { outcome: "approved", by: { id: lenaId } },
      approval: { status: "applied" },
    });
    expect(await cardActionsOf(cardMessageId)).toHaveLength(1);
    // History names the approver (07.2-13, WINDOWS 156).
    const history = await ok(sam.request("GET", `/api/v1/memory/files/${file?.id}/revisions`));
    expect(history.revisions[0]).toMatchObject({
      approvalRequestId: approvalId,
      approvedBy: { id: lenaId, displayName: "Lena Gil" },
    });
    const one = await ok(sam.request("GET", `/api/v1/memory/files/${file?.id}/revisions/1`));
    expect(one.approvedBy).toEqual({ id: lenaId, displayName: "Lena Gil" });
  });

  it("audits the proposal and the write with ids and counts, never the path or the content", async () => {
    const p = await proposalOf(approvalId);
    const [created] = await auditsWhere("memory.proposal_created", "proposalId", p?.id);
    expect(created).toMatchObject({ actor_kind: "agent", actor_id: scoutId, user_id: samId });
    expect(created?.metadata).toEqual({
      proposalId: p?.id,
      approvalId,
      scopeId: scopeOf[A],
      scopeKind: "unit",
      op: "create",
      findingKinds: ["iban", "email"],
      readerCount: 4,
      tainted: false,
    });
    const [written] = await auditsWhere("memory.file_created", "approvalRequestId", approvalId);
    expect(written?.metadata).toMatchObject({ actorKind: "approved", approvalRequestId: approvalId });
    for (const row of [created, written]) {
      const text = JSON.stringify(row);
      expect(text).not.toContain("acme");
      expect(text).not.toContain("clients/");
      expect(text).not.toContain("1332");
    }
  });

  it("an append proposal's spans are offsets into the whole proposed file, past the base", async () => {
    const t = await turn("Add the Acme phone");
    const r = await proposed({
      eventId: t.eventId,
      scope: scopeOf[A] as string,
      path: "clients/acme.md",
      op: "append",
      content: "Billing: billing@acme.com",
    });
    const d = await detail(lena, r.approvalId);
    if (d.view.type !== "memory_proposal") throw new Error("not a memory view");
    const v = d.view.proposal;
    expect(v).toMatchObject({ op: "append", base: ACME, baseVersion: 1, currentVersion: 1, linesAdded: 1 });
    expect(v.proposed).toBe(`${ACME}Billing: billing@acme.com\n`);
    // Only the appended text is scanned: the base's email and IBAN are not reported again.
    expect(v.findings.map((f) => [f.kind, f.count, f.lines])).toEqual([["email", 1, [3]]]);
    expect(v.spans).toHaveLength(1);
    const [s] = v.spans;
    expect(s?.start).toBeGreaterThan(ACME.length);
    expect(v.proposed.slice(s?.start, s?.end)).toBe("billing@acme.com");
  });
});

// ---------------------------------------------------------------------------------------------------- Task 2

/** A proposal on a fresh turn (each turn has its own tool budget). */
async function fresh(a: Omit<ProposeArgs, "eventId">, text?: string) {
  const t = await turn(text);
  return { ...(await proposed({ ...a, eventId: t.eventId })), turn: t };
}

const hashOf = async (as: TestClient, id: string) => (await detail(as, id)).actionHash;
const revisionCount = async (scopeId: string) =>
  Number(
    (
      await su.query("select count(*)::int as n from app.memory_file_revisions where scope_id = $1", [
        scopeId,
      ])
    ).rows[0].n,
  );

describe("four eyes: no self-approval in shared memory (Task 2)", () => {
  it("Sam cannot approve his own team proposal, not even as a lead of A; Lena can", async () => {
    const r = await fresh({
      scope: scopeOf[A] as string,
      path: "four-eyes.md",
      op: "create",
      content: "x\n",
    });
    await ok(admin.request("PATCH", `/api/v1/members/${samId}/role`, { role: "lead" }));
    await ok(admin.request("PATCH", `/api/v1/units/${A}/members/${samId}`, { role: "lead" }));
    try {
      // He may promote in A now, but this proposal was made for him.
      const scopes = (await ok(sam.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
      expect(scopes.find((s) => s.unitId === A)?.viewerCan).toContain("promote");
      const d = await detail(sam, r.approvalId);
      expect(d.viewerCan).toEqual([]);
      const res = await decide(sam, r.approvalId, { outcome: "approved", actionHash: d.actionHash });
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe("not_approver");
      expect((await approvalRow(r.approvalId)).status).toBe("pending");
    } finally {
      await ok(admin.request("PATCH", `/api/v1/units/${A}/members/${samId}`, { role: "member" }));
      await ok(admin.request("PATCH", `/api/v1/members/${samId}/role`, { role: "standard" }));
    }
    expect((await detail(lena, r.approvalId)).viewerCan).toEqual(["decide"]);
    const res = await decide(lena, r.approvalId, {
      outcome: "approved",
      actionHash: await hashOf(lena, r.approvalId),
      note: "Good to keep",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // A shared proposal's note is not private: the decision audit carries it.
    const [decided] = await auditsWhere("approval.decided", "approvalId", r.approvalId);
    expect(decided?.metadata).toMatchObject({ outcome: "approved", note: "Good to keep" });
  });
});

describe("personal memory: the owner approves in the card; admins never see it (Task 2)", () => {
  let r: Awaited<ReturnType<typeof fresh>>;

  it("a tainted turn may propose into Sam's private memory; the card says the bot read web or tool content", async () => {
    const t = await turn("Look this up and remember it");
    await su.query("update app.agent_turns set tainted = true where event_id = $1", [t.eventId]);
    const out = await proposed({
      eventId: t.eventId,
      scope: "personal",
      path: "travel.md",
      op: "create",
      content: "Flight to Lisbon on Friday\n",
    });
    r = { ...out, turn: t };
    expect(r.readerCount).toBe(1);
    expect(await proposalOf(r.approvalId)).toMatchObject({ tainted: true, personal_owner_user_id: samId });
    const row = await approvalRow(r.approvalId);
    expect(row.card_warnings).toEqual(["Sam's assistant read web or tool content in this turn."]);
    const card = await cardFor(sam, row.card_message_id);
    expect(card.fields).toEqual([
      { label: "Memory", value: "You & Sam's assistant · Private" },
      { label: "Readers", value: "Only you" },
      { label: "Found", value: "Nothing found" },
    ]);
    expect(card.viewerCan).toEqual(["follow", "decide"]);
  });

  it("an admin gets 404 on it, cannot decide it, never lists it and never receives its events", async () => {
    expect((await admin.request("GET", `/api/v1/approvals/${r.approvalId}`)).status).toBe(404);
    const res = await decide(admin, r.approvalId, { outcome: "approved", actionHash: "0".repeat(64) });
    expect(res.status).toBe(404);
    const listed = (await ok(admin.request("GET", "/api/v1/approvals?role=decider"))).items as Json[];
    expect(listed.map((i) => i.id)).not.toContain(r.approvalId);
    expect(await updatesOf(r.approvalId)).toEqual([`user:${samId}`]);
  });

  it("Sam approves it on the card; the private note is audited as its length only", async () => {
    const row = await approvalRow(r.approvalId);
    const res = await sam.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome: "approved",
      actionHash: row.action_hash,
      note: "Yes please",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await approvalRow(r.approvalId)).status).toBe("applied");
    const scope = (await proposalOf(r.approvalId))?.scope_id as string;
    expect(await fileAt(scope, "travel.md")).toMatchObject({ content: "Flight to Lisbon on Friday\n" });
    const [decided] = await auditsWhere("approval.decided", "approvalId", r.approvalId);
    expect(decided?.metadata).toMatchObject({ outcome: "approved", noteChars: 10 });
    expect(decided?.metadata).not.toHaveProperty("note");
    expect(await updatesOf(r.approvalId)).not.toContain(`user:${adminId}`);
  });
});

describe("integrity: the exact change, once, on the file it was proposed for (Task 2)", () => {
  it("replace on a file that changed since the proposal fails as stale_base and writes nothing", async () => {
    const file = await ok(
      lena.request("POST", `/api/v1/memory/scopes/${scopeOf[A]}/files`, {
        path: "notes/stale.md",
        content: "v1\n",
      }),
    );
    await ok(lena.request("PUT", `/api/v1/memory/files/${file.id}`, { content: "v2\n", expectedVersion: 1 }));
    const r = await fresh({
      scope: scopeOf[A] as string,
      path: "notes/stale.md",
      op: "replace",
      content: "v2\nfrom Scout\n",
      baseVersion: 2,
    });
    expect(await proposalOf(r.approvalId)).toMatchObject({ file_id: file.id, base_version: 2 });
    await ok(
      admin.request("PUT", `/api/v1/memory/files/${file.id}`, { content: "v3\n", expectedVersion: 2 }),
    );
    const before = await revisionsOf(file.id);
    const res = await decide(lena, r.approvalId, {
      outcome: "approved",
      actionHash: await hashOf(lena, r.approvalId),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", resultCode: "stale_base" });
    expect(await revisionsOf(file.id)).toEqual(before);
    expect(await fileAt(scopeOf[A] as string, "notes/stale.md")).toMatchObject({
      version: 3,
      content: "v3\n",
    });
    const row = await approvalRow(r.approvalId);
    expect((await cardFor(sam, row.card_message_id)).status).toBe("failed");
  });

  it("create on a path someone created meanwhile fails as path_exists and writes nothing", async () => {
    const r = await fresh({
      scope: scopeOf[A] as string,
      path: "notes/new.md",
      op: "create",
      content: "Scout\n",
    });
    const mine = await ok(
      lena.request("POST", `/api/v1/memory/scopes/${scopeOf[A]}/files`, {
        path: "Notes/New.md",
        content: "Lena\n",
      }),
    );
    const res = await decide(lena, r.approvalId, {
      outcome: "approved",
      actionHash: await hashOf(lena, r.approvalId),
    });
    expect(res.body).toMatchObject({ status: "failed", resultCode: "path_exists" });
    expect(await revisionsOf(mine.id)).toHaveLength(1);
  });

  it("a proposal changed after the request cannot be approved (409 approval_action_changed), nothing written", async () => {
    const r = await fresh({
      scope: scopeOf[A] as string,
      path: "tamper.md",
      op: "create",
      content: "honest\n",
    });
    const hash = await hashOf(lena, r.approvalId);
    const p = await proposalOf(r.approvalId);
    await su.query("update app.memory_proposals set content = 'poisoned\n' where id = $1", [p?.id]);
    const res = await decide(lena, r.approvalId, { outcome: "approved", actionHash: hash });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("approval_action_changed");
    expect(await fileAt(scopeOf[A] as string, "tamper.md")).toBeUndefined();
    expect((await approvalRow(r.approvalId)).status).toBe("pending");
  });

  it("Lena and the admin approve at once: one wins, the other gets 409, exactly one revision", async () => {
    const r = await fresh({ scope: scopeOf[A] as string, path: "race.md", op: "create", content: "once\n" });
    const hash = await hashOf(lena, r.approvalId);
    const before = await revisionCount(scopeOf[A] as string);
    const results = await Promise.all([
      decide(lena, r.approvalId, { outcome: "approved", actionHash: hash }),
      decide(admin, r.approvalId, { outcome: "approved", actionHash: hash }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await revisionCount(scopeOf[A] as string)).toBe(before + 1);
    expect(await fileAt(scopeOf[A] as string, "race.md")).toMatchObject({ content: "once\n", version: 1 });
  });

  it("deny: the card is cancelled, the file unchanged, the bot hears it was denied", async () => {
    const r = await fresh({ scope: scopeOf[A] as string, path: "denied.md", op: "create", content: "no\n" });
    const res = await decide(lena, r.approvalId, {
      outcome: "denied",
      actionHash: await hashOf(lena, r.approvalId),
    });
    expect(res.body).toMatchObject({ status: "denied" });
    expect(await fileAt(scopeOf[A] as string, "denied.md")).toBeUndefined();
    const row = await approvalRow(r.approvalId);
    expect((await cardFor(sam, row.card_message_id)).status).toBe("cancelled");
    const heard = await cardActionsOf(row.card_message_id);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.cardAction).toMatchObject({ outcome: "denied" });
  });

  it("an expired request cannot be decided (409 approval_expired), nothing written", async () => {
    const r = await fresh({ scope: scopeOf[A] as string, path: "late.md", op: "create", content: "late\n" });
    const hash = await hashOf(lena, r.approvalId);
    await su.query(
      "update app.approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [r.approvalId],
    );
    const res = await decide(lena, r.approvalId, { outcome: "approved", actionHash: hash });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("approval_expired");
    expect(await fileAt(scopeOf[A] as string, "late.md")).toBeUndefined();
  });
});

describe("refusals before anything is stored (Task 2)", () => {
  const counts = async () => {
    const q = async (sql: string) => Number((await su.query(sql)).rows[0].n);
    return {
      proposals: await q("select count(*)::int as n from app.memory_proposals"),
      approvals: await q("select count(*)::int as n from app.approval_requests"),
      cards: await q("select count(*)::int as n from app.message_cards"),
    };
  };

  it("a secret refuses the proposal: no proposal, no approval, no card", async () => {
    const t = await turn();
    const before = await counts();
    const key = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");
    expect(
      await propose({
        eventId: t.eventId,
        scope: scopeOf[A] as string,
        path: "k.md",
        op: "create",
        content: key,
      }),
    ).toEqual({ refused: "secret_detected" });
    expect(await counts()).toEqual(before);
    const [refused] = (
      await su.query(
        "select metadata from app.audit_events where action = 'memory.proposal_refused' and metadata->>'eventId' = $1",
        [t.eventId],
      )
    ).rows;
    expect(refused?.metadata).toEqual({ reason: "secret_detected", op: "create", eventId: t.eventId });
  });

  it("an unknown turn, another bot's turn and an unreadable unit are refused", async () => {
    const t = await turn();
    const base = { scope: scopeOf[A] as string, path: "x.md", op: "create" as const, content: "x\n" };
    expect(await propose({ ...base, eventId: randomUUID() })).toEqual({ refused: "unknown_turn" });
    expect(await propose({ ...base, eventId: t.eventId, agentId: randomUUID() })).toEqual({
      refused: "unknown_turn",
    });
    expect(await propose({ ...base, eventId: t.eventId, scope: scopeOf[B] as string })).toEqual({
      refused: "denied",
    });
    expect(await propose({ ...base, eventId: t.eventId, scope: randomUUID() })).toEqual({
      refused: "not_found",
    });
    expect(await propose({ ...base, eventId: t.eventId, path: "../x.md" })).toEqual({
      refused: "path_invalid",
    });
    expect(await propose({ ...base, eventId: t.eventId, path: "clients/acme.md" })).toEqual({
      refused: "version_conflict",
    });
    expect(
      await propose({ ...base, eventId: t.eventId, path: "clients/acme.md", op: "replace", baseVersion: 99 }),
    ).toEqual({ refused: "version_conflict" });
  });

  it("the ninth memory tool call of a turn is cap_reached", async () => {
    const t = await turn();
    await su.query("update app.agent_turns set tool_calls = 7 where event_id = $1", [t.eventId]);
    const base = { eventId: t.eventId, scope: scopeOf[A] as string, op: "create" as const, content: "x\n" };
    expect(await propose({ ...base, path: "eighth.md" })).toHaveProperty("approvalId");
    expect(await propose({ ...base, path: "ninth.md" })).toEqual({ refused: "cap_reached" });
    expect(
      Number(
        (await su.query("select tool_calls from app.agent_turns where event_id = $1", [t.eventId])).rows[0]
          .tool_calls,
      ),
    ).toBe(8);
  });

  it("the 21st pending proposal of the same (bot, human) is too_many_pending", async () => {
    const pending = Number(
      (
        await su.query(
          `select count(*)::int as n from app.approval_requests where kind = 'memory.write' and status = 'pending'
            and expires_at > now() and requested_by_agent_id = $1 and requested_for_user_id = $2`,
          [scoutId, samId],
        )
      ).rows[0].n,
    );
    expect(pending).toBeLessThan(20);
    const filler = Array.from({ length: 20 - pending }, () => randomUUID());
    for (const id of filler) {
      await su.query(
        `insert into app.approval_requests (organization_id, kind, mode, resource_type, resource_id, action_hash,
           requested_by_agent_id, requested_for_user_id, expires_at)
         values ($1, 'memory.write', 'server_apply', 'memory_proposal', $2, $3, $4, $5, now() + interval '1 day')`,
        [orgId, id, "0".repeat(64), scoutId, samId],
      );
    }
    try {
      const t = await turn();
      expect(
        await propose({
          eventId: t.eventId,
          scope: scopeOf[A] as string,
          path: "21st.md",
          op: "create",
          content: "x\n",
        }),
      ).toEqual({ refused: "too_many_pending" });
    } finally {
      await su.query("delete from app.approval_requests where resource_id = any($1::uuid[])", [filler]);
    }
  });
});

describe("the view's bounds and a proposal whose unit is gone (WINDOWS 126, 137)", () => {
  it("a proposal with 250 emails is viewed with 200 spans and the full count", async () => {
    const content = `${Array.from({ length: 250 }, (_, i) => `user${i}@acme.com`).join("\n")}\n`;
    const r = await fresh({ scope: scopeOf[A] as string, path: "lists/many.md", op: "create", content });
    const d = await detail(lena, r.approvalId);
    if (d.view.type !== "memory_proposal") throw new Error("not a memory view");
    expect(d.view.proposal.spans).toHaveLength(200);
    expect(d.view.proposal.findings).toEqual([expect.objectContaining({ kind: "email", count: 250 })]);
    const row = await approvalRow(r.approvalId);
    expect((await messageOf(row.card_message_id)).body.length).toBeLessThanOrEqual(600);
  });

  it("a unit deleted under a pending proposal closes its approval as failed scope_gone, card included (WINDOWS 137, 144)", async () => {
    const C = await unit("team", "Benelux", D);
    await ok(admin.request("POST", `/api/v1/units/${C}/members`, { userId: lenaId, role: "lead" }));
    await ok(admin.request("POST", `/api/v1/units/${C}/members`, { userId: samId }));
    const scopes = (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[];
    const scopeC = scopes.find((s) => s.unitId === C)?.id as string;
    const r = await fresh({ scope: scopeC, path: "benelux.md", op: "create", content: "Brussels office\n" });
    expect((await detail(lena, r.approvalId)).viewerCan).toEqual(["decide"]);
    const hash = await hashOf(lena, r.approvalId);
    const before = await approvalRow(r.approvalId);
    const cardVersion = (await cardFor(sam, before.card_message_id)).version;
    // Only the template MEMORY.md lives there, so the unit may go; its scope and the proposal cascade.
    await ok(admin.request("DELETE", `/api/v1/units/${C}`));
    expect(await proposalOf(r.approvalId)).toBeUndefined();

    // The gone path: closed in the same transaction as failed scope_gone, with no decider.
    const row = await approvalRow(r.approvalId);
    expect(row).toMatchObject({
      status: "failed",
      result_code: "scope_gone",
      decided_by: null,
      consumed_at: null,
    });
    const [closed] = await auditsWhere("approval.closed", "approvalId", r.approvalId);
    expect(closed?.metadata).toEqual({
      approvalId: r.approvalId,
      kind: "memory.write",
      mode: "server_apply",
      resultCode: "scope_gone",
    });
    expect(closed?.result).toBe("error");
    // Announced like a decision (ids only) to the requester; the card shows it failed, live, with no decision line.
    expect(await updatesOf(r.approvalId)).toContain(`user:${samId}`);
    const card = await cardFor(sam, row.card_message_id);
    expect(card).toMatchObject({ status: "failed", decision: null });
    expect(card.version).toBe(cardVersion + 1);
    expect(card.approval).toMatchObject({ status: "failed", resultCode: "scope_gone" });
    const live = await su.query(
      "select payload from app.stream_events where type = 'message.updated' and payload->'message'->>'id' = $1 order by seq",
      [row.card_message_id],
    );
    expect(live.rows.at(-1)?.payload.message.card).toMatchObject({ status: "failed" });
    expect(await cardActionsOf(row.card_message_id)).toEqual([]);

    // Inbox and detail answer cleanly; nobody can decide it any more and nothing is written.
    const lenaList = (await ok(lena.request("GET", "/api/v1/approvals?role=decider"))).items as Json[];
    expect(lenaList.map((i) => i.id)).not.toContain(r.approvalId);
    const samList = (await ok(sam.request("GET", "/api/v1/approvals?role=requester"))).items as Json[];
    expect(samList.find((i) => i.id === r.approvalId)).toMatchObject({
      status: "failed",
      resultCode: "scope_gone",
      viewerCan: [],
    });
    const d = await detail(sam, r.approvalId);
    expect(d.view).toEqual({
      type: "fields",
      title: "This memory no longer exists.",
      fields: [{ label: "Result", value: "scope_gone" }],
    });
    const byLena = await decide(lena, r.approvalId, { outcome: "approved", actionHash: hash });
    expect(byLena.status).toBe(404);
    expect(codeOf(byLena)).toBe("approval_not_found");
    const onCard = await sam.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome: "denied",
      actionHash: hash,
    });
    expect(onCard.status).toBe(409);
    expect(codeOf(onCard)).toBe("approval_already_decided");

    // The kind's own hooks read it as scope_gone, never a crash.
    const kind = createMemoryWriteKind({ perms: {} as never, files: {} as never, scans: new Map() });
    const stored = {
      ...row,
      resourceId: row.resource_id,
      requestedForUserId: row.requested_for_user_id,
      requestedByAgentId: row.requested_by_agent_id,
    } as never;
    await stack.built.core.db.withTenant({ organizationId: orgId, userId: lenaId }, async (tx) => {
      await expect(kind.hashInput(tx, stored)).rejects.toMatchObject({ statusCode: 409, code: "scope_gone" });
      expect(await kind.apply?.(tx, stored, { deciderUserId: lenaId })).toEqual({
        ok: false,
        code: "scope_gone",
      });
      expect(await kind.gone?.(tx, stored)).toBe("scope_gone");
      expect(await kind.canDecide(tx, lenaId, stored)).toBe(false);
      expect(await kind.audience(tx, stored)).toEqual([]);
      expect(await kind.isPrivate?.(tx, stored)).toBe(true);
    });
  });
});

describe("Presidio (layer 2): findings merge in, and a refused connection leaves a visible marker (Task 2)", () => {
  it("a PERSON span from the analyzer becomes a person finding, masked on the card", async () => {
    presidioMode = "person";
    try {
      const calls = presidioCalls;
      const r = await fresh({
        scope: scopeOf[A] as string,
        path: "people/ana.md",
        op: "create",
        content: "Met Ana García at the fair\n",
      });
      expect(presidioCalls).toBeGreaterThan(calls);
      expect(r.findings).toEqual([
        expect.objectContaining({
          kind: "person",
          source: "presidio",
          severity: "warn",
          samples: ["A••• G•••"],
        }),
      ]);
      const row = await approvalRow(r.approvalId);
      expect(row.card_warnings).toEqual([]);
      const msg = await messageOf(row.card_message_id);
      expect(msg.body).toBe("+ Met A••• G••• at the fair");
      expect((await cardFor(sam, row.card_message_id)).fields).toContainEqual({
        label: "Found",
        value: "Person name",
      });
    } finally {
      presidioMode = "nothing";
    }
  });

  it("with the analyzer's port closed the proposal proceeds with extended_scan_unavailable and a card warning", async () => {
    presidio.closeAllConnections();
    await new Promise<void>((resolve) => presidio.close(() => resolve()));
    const r = await fresh({
      scope: scopeOf[A] as string,
      path: "offline.md",
      op: "create",
      content: "Call ana@acme.com\n",
    });
    expect(r.findings.map((f) => [f.kind, f.severity])).toEqual([
      ["email", "warn"],
      ["extended_scan_unavailable", "info"],
    ]);
    const row = await approvalRow(r.approvalId);
    expect(row.card_warnings).toEqual(["Extended scan unavailable — review the text yourself"]);
    expect((await cardFor(sam, row.card_message_id)).approval?.warnings).toEqual([
      "Extended scan unavailable — review the text yourself",
    ]);
    const d = await detail(lena, r.approvalId);
    if (d.view.type !== "memory_proposal") throw new Error("not a memory view");
    expect(d.view.proposal.findings.map((f) => f.kind)).toContain("extended_scan_unavailable");
  });
});

describe("a deleted, turned-off or forgotten requester never gets a write (WINDOWS 144, 164)", () => {
  it("approving after the bot was turned off fails as bot_disabled and writes nothing", async () => {
    const r = await fresh({ scope: scopeOf[A] as string, path: "off.md", op: "create", content: "Paused\n" });
    const hash = await hashOf(lena, r.approvalId);
    await su.query("update app.agents set status = 'disabled' where id = $1", [scoutId]);
    try {
      const res = await decide(lena, r.approvalId, { outcome: "approved", actionHash: hash });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await approvalRow(r.approvalId)).toMatchObject({
        status: "failed",
        result_code: "bot_disabled",
      });
      expect(await fileAt(scopeOf[A] as string, "off.md")).toBeUndefined();
    } finally {
      await su.query("update app.agents set status = 'ready' where id = $1", [scoutId]);
    }
  });

  it("forgetting a private scope closes its pending proposals as scope_gone", async () => {
    const r = await fresh({ scope: "personal", path: "forgotten.md", op: "create", content: "Soon gone\n" });
    const scope = (await proposalOf(r.approvalId))?.scope_id as string;
    await ok(sam.request("DELETE", `/api/v1/memory/scopes/${scope}`));
    expect(await approvalRow(r.approvalId)).toMatchObject({ status: "failed", result_code: "scope_gone" });
    const row = await approvalRow(r.approvalId);
    expect((await cardFor(sam, row.card_message_id)).approval).toMatchObject({
      status: "failed",
      resultCode: "scope_gone",
    });
    expect(await auditsWhere("approval.closed", "approvalId", r.approvalId)).toHaveLength(1);
  });

  it("deleting the bot closes every pending proposal it asked for as bot_deleted; Lena can no longer approve", async () => {
    const shared = await fresh({
      scope: scopeOf[A] as string,
      path: "late.md",
      op: "create",
      content: "Late\n",
    });
    const mine = await fresh({ scope: "personal", path: "late.md", op: "create", content: "Mine\n" });
    const hash = await hashOf(lena, shared.approvalId);
    const decidedBefore = await fresh({
      scope: scopeOf[A] as string,
      path: "done.md",
      op: "create",
      content: "Done\n",
    });
    await ok(
      decide(lena, decidedBefore.approvalId, {
        outcome: "denied",
        actionHash: await hashOf(lena, decidedBefore.approvalId),
      }),
    );

    await ok(sam.request("DELETE", `/api/v1/agents/${scoutId}`));

    for (const r of [shared, mine]) {
      const row = await approvalRow(r.approvalId);
      expect(row, r.approvalId).toMatchObject({
        status: "failed",
        result_code: "bot_deleted",
        decided_by: null,
      });
      expect((await cardFor(sam, row.card_message_id)).status).toBe("failed");
      const [closed] = await auditsWhere("approval.closed", "approvalId", r.approvalId);
      expect(closed?.metadata.resultCode).toBe("bot_deleted");
      expect(JSON.stringify(closed)).not.toContain("late.md");
    }
    // A request already decided is left as it was.
    expect((await approvalRow(decidedBefore.approvalId)).status).toBe("denied");
    // The lead sees it decided-by-nobody and cannot approve it: nothing is written for a deleted bot.
    const res = await decide(lena, shared.approvalId, { outcome: "approved", actionHash: hash });
    expect([404, 409]).toContain(res.status);
    expect(await fileAt(scopeOf[A] as string, "late.md")).toBeUndefined();
  });
});
