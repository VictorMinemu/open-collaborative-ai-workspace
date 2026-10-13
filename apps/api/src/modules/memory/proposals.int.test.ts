import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentCard, AgentCardActionEvent, ApprovalDetail, type MemoryToolScope } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import type { CreateMemoryProposalInput } from "./index";

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
let lenaId: string;
let samId: string;
let anaId: string;
let A: string;
let B: string;
let scoutId: string;
let dmId: string;
const scopeOf: Record<string, string> = {};

// ---------------------------------------------------------------- the fake Presidio analyzer

let presidio: Server;
const presidioMode: "nothing" | "person" = "nothing";

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
  [lena, lenaId] = await joinAs("lena@example.test", "Lena Gil", "lead");
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [, anaId] = await joinAs("ana@example.test", "Ana Pérez", "standard");
  const [, beaId] = await joinAs("bea@example.test", "Bea Lind", "standard");
  const D = await unit("department", "Sales", null);
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
