import { randomUUID } from "node:crypto";
import { ApprovalDetail, ApprovalList, ApprovalSummary } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { errorCode, invite } from "../../testing-workzone";
import type { ApprovalKind, ApprovalService } from "./index";

/**
 * 07.2-06 (MEM-06, D-05, D-08, ADR-0023): the approve-and-apply primitive on a real PostgreSQL + Redis, through the
 * real routes. Test-only kinds stand in for 07.2's memory proposals and 07.5's tool grants: their "stored action" is an
 * in-memory map keyed by resource id, so a test can change it between view and decision.
 *
 * Cast: Víctor (admin) and Alex (developer) are the deciders of the test kinds; Sam Lee (standard) is the human the
 * requests are made for; Riley (developer) is an outsider.
 */

const CELL_TOKEN = "ocw-test-cell-token-approvals-0123456789abcdef";

let stack: AiStack;
let su: pg.Client;
let approvals: ApprovalService;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let riley: TestClient;
let victorId: string;
let alexId: string;
let samId: string;
let rileyId: string;
let orgId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** The stored action of each test request, keyed by resource id (what `hashInput` reads). */
const stored = new Map<string, { target: string; version: number }>();
/** Resource ids whose `apply` writes and then reports a conflict. */
const failing = new Set<string>();
/** Who may decide the test kinds (live: tests add and remove people). */
const deciders = new Set<string>();
let applyCalls = 0;

function testKind(
  kind: string,
  mode: "server_apply" | "grant",
  extra: Partial<ApprovalKind> = {},
): ApprovalKind {
  return {
    kind,
    mode,
    resourceType: "test_action",
    ttlMs: 60 * 60 * 1000,
    async hashInput(_tx, row) {
      const a = stored.get(row.resourceId);
      if (!a) throw new Error("no stored action");
      return [a.target, a.version];
    },
    async canDecide(_tx, userId) {
      return deciders.has(userId);
    },
    async audience() {
      return [...deciders];
    },
    async view(_tx, row) {
      return {
        type: "fields",
        title: "Test action",
        fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
      };
    },
    ...(mode === "server_apply"
      ? {
          async apply(tx, row) {
            applyCalls += 1;
            await stack.built.core.audit.record(tx, {
              action: "test.applied",
              resourceType: "test_action",
              resourceId: row.resourceId,
              metadata: { approvalId: row.id },
            });
            return failing.has(row.resourceId) ? { ok: false, code: "test_conflict" } : { ok: true };
          },
        }
      : {}),
    ...extra,
  };
}

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** A pending request of `kind` made for `forUserId`, whose stored action targets `target`. */
async function request(kind: string, opts: { forUserId?: string | null; target?: string } = {}) {
  const resourceId = randomUUID();
  stored.set(resourceId, { target: opts.target ?? `target-${resourceId.slice(0, 8)}`, version: 1 });
  const forUserId = opts.forUserId === undefined ? samId : opts.forUserId;
  const out = await stack.built.core.db.withTenant({ organizationId: orgId, userId: forUserId }, (tx) =>
    approvals.request(tx, {
      kind,
      resourceId,
      requestedByAgentId: null,
      requestedForUserId: forUserId,
      eventId: null,
    }),
  );
  return { ...out, resourceId };
}

const decide = (as: TestClient, id: string, body: Json) =>
  as.request("POST", `/api/v1/approvals/${id}/decision`, body);

const rowOf = async (id: string) =>
  (await su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

const auditsFor = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, metadata, result from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Json[];

/** Every `approval_request.updated` appended for one request: the stream it went to and its payload. */
const updatesOf = async (id: string) =>
  (
    await su.query(
      "select stream_id, payload from app.stream_events where type = 'approval_request.updated' and payload->>'id' = $1 order by stream_id, seq",
      [id],
    )
  ).rows as Array<{ stream_id: string; payload: Json }>;

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  approvals = stack.built.approvals;
  approvals.register(testKind("test.apply", "server_apply"));
  approvals.register(testKind("test.grant", "grant"));
  approvals.register(
    testKind("test.private", "server_apply", {
      async canDecide(_tx, userId, row) {
        return userId === row.requestedForUserId;
      },
      async audience(_tx, row) {
        return row.requestedForUserId ? [row.requestedForUserId] : [];
      },
      async isPrivate() {
        return true;
      },
    }),
  );
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = (setup.organization as Json).id as string;
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  ({ client: riley, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  ));
  await seedPlan(victor);
  deciders.add(victorId).add(alexId);
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("registry", () => {
  it("refuses a duplicate kind, a server_apply kind without apply, a grant with apply and a bad id", () => {
    expect(() => approvals.register(testKind("test.apply", "server_apply"))).toThrow(/already registered/);
    expect(() =>
      approvals.register({ ...testKind("test.noapply", "server_apply"), apply: undefined }),
    ).toThrow(/no apply hook/);
    expect(() =>
      approvals.register({
        ...testKind("test.grantapply", "grant"),
        apply: async () => ({ ok: true }),
      }),
    ).toThrow(/must not have an apply hook/);
    expect(() => approvals.register(testKind("Bad Kind", "grant"))).toThrow(/invalid approval kind id/);
    expect(() => approvals.register({ ...testKind("test.nottl", "grant"), ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe("tracer: a test kind is requested, viewed, decided and applied in one audited transaction (Task 1)", () => {
  let id: string;
  let hash: string;
  let resourceId: string;

  it("request → pending row with the stored hash, audited, announced to the deciders and the requester", async () => {
    ({ id, actionHash: hash, resourceId } = await request("test.apply"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      kind: "test.apply",
      mode: "server_apply",
      resource_type: "test_action",
      resource_id: resourceId,
      action_hash: hash,
      status: "pending",
      requested_for_user_id: samId,
      consumed_at: null,
    });
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    const [audit] = await auditsFor("approval.requested", id);
    expect(audit?.metadata).toEqual({
      approvalId: id,
      kind: "test.apply",
      mode: "server_apply",
      resourceType: "test_action",
      resourceId,
    });
    expect((await updatesOf(id)).map((u) => u.stream_id).sort()).toEqual(
      [`user:${alexId}`, `user:${samId}`, `user:${victorId}`].sort(),
    );
  });

  it("GET /approvals?role=decider lists it for a decider, not for an outsider; role=requester lists it for Sam", async () => {
    const forVictor = ApprovalList.parse(await ok(victor.request("GET", "/api/v1/approvals?role=decider")));
    const mine = forVictor.items.find((i) => i.id === id);
    expect(mine).toMatchObject({ status: "pending", actionHash: hash, viewerCan: ["decide"] });
    expect(mine?.requestedBy).toEqual({ agentId: null, userId: samId, displayName: "Sam Lee" });
    const forRiley = ApprovalList.parse(await ok(riley.request("GET", "/api/v1/approvals?role=decider")));
    expect(forRiley.items.map((i) => i.id)).not.toContain(id);
    const forSam = ApprovalList.parse(await ok(sam.request("GET", "/api/v1/approvals?role=requester")));
    expect(forSam.items.find((i) => i.id === id)).toMatchObject({ viewerCan: [] });
    const samAsDecider = ApprovalList.parse(await ok(sam.request("GET", "/api/v1/approvals?role=decider")));
    expect(samAsDecider.items.map((i) => i.id)).not.toContain(id);
  });

  it("GET /approvals/:id returns the kind's view and the action hash", async () => {
    const detail = ApprovalDetail.parse(await ok(alex.request("GET", `/api/v1/approvals/${id}`)));
    expect(detail).toMatchObject({ id, kind: "test.apply", actionHash: hash, viewerCan: ["decide"] });
    expect(detail.view).toEqual({
      type: "fields",
      title: "Test action",
      fields: [{ label: "Target", value: stored.get(resourceId)?.target }],
    });
    expect(deciders.has(rileyId)).toBe(false);
    const hidden = await riley.request("GET", `/api/v1/approvals/${id}`);
    expect(hidden.status).toBe(404);
    expect(errorCode(hidden)).toBe("approval_not_found");
  });

  it("POST …/decision approved → 200 applied; consumed and applied once; audits with ids only; user: streams only", async () => {
    const before = applyCalls;
    const res = await decide(victor, id, { outcome: "approved", actionHash: hash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const summary = ApprovalSummary.parse(res.body);
    expect(summary).toMatchObject({
      status: "applied",
      decidedBy: { id: victorId, displayName: "Víctor Ruiz" },
      decisionNote: null,
      resultCode: null,
      viewerCan: [],
    });
    expect(applyCalls).toBe(before + 1);
    const row = await rowOf(id);
    expect(row.status).toBe("applied");
    expect(row.consumed_at).not.toBeNull();
    expect(row.applied_at).not.toBeNull();
    expect(row.decided_by).toBe(victorId);
    expect(await auditsFor("test.applied", resourceId)).toHaveLength(1);
    const [decided] = await auditsFor("approval.decided", id);
    expect(decided).toMatchObject({
      actor_kind: "user",
      actor_id: victorId,
      metadata: { approvalId: id, kind: "test.apply", mode: "server_apply", outcome: "approved" },
    });
    const [applied] = await auditsFor("approval.applied", id);
    expect(applied?.metadata).toEqual({ approvalId: id, kind: "test.apply", mode: "server_apply" });
    const updates = await updatesOf(id);
    expect(updates.every((u) => u.stream_id.startsWith("user:"))).toBe(true);
    expect(
      updates
        .filter((u) => u.payload.status === "applied")
        .map((u) => u.stream_id)
        .sort(),
    ).toEqual([`user:${alexId}`, `user:${samId}`, `user:${victorId}`].sort());
    for (const u of updates) expect(Object.keys(u.payload).sort()).toEqual(["id", "status"]);
    const onOrg = await su.query(
      "select count(*)::int as n from app.stream_events where stream_id like 'org:%' and payload::text like $1",
      [`%${id}%`],
    );
    expect(onOrg.rows[0].n).toBe(0);
  });

  it("denied → status denied, apply never called, the grant never consumed", async () => {
    const r = await request("test.apply");
    const before = applyCalls;
    const res = await decide(alex, r.id, { outcome: "denied", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ApprovalSummary.parse(res.body).status).toBe("denied");
    expect(applyCalls).toBe(before);
    expect(await rowOf(r.id)).toMatchObject({ status: "denied", consumed_at: null, applied_at: null });
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(0);
  });

  it("a note is stored and audited as text; a private kind audits only its length; 281 characters → 400", async () => {
    const r = await request("test.apply");
    const note = "Duplicate of the CRM entry";
    const res = await decide(victor, r.id, { outcome: "denied", actionHash: r.actionHash, note });
    expect(res.status).toBe(200);
    expect(
      ApprovalDetail.parse(await ok(victor.request("GET", `/api/v1/approvals/${r.id}`))).decisionNote,
    ).toBe(note);
    expect((await auditsFor("approval.decided", r.id))[0]?.metadata).toMatchObject({ note });

    // test.private: only the human it was requested for decides (Sam, as a personal-scope owner would).
    const p = await request("test.private");
    const secret = "Mentions my medical appointment";
    const pres = await decide(sam, p.id, { outcome: "approved", actionHash: p.actionHash, note: secret });
    expect(pres.status, JSON.stringify(pres.body)).toBe(200);
    const meta = (await auditsFor("approval.decided", p.id))[0]?.metadata as Json;
    expect(meta.noteChars).toBe(secret.length);
    expect(JSON.stringify(meta)).not.toContain("medical");

    const long = await request("test.apply");
    const tooLong = await decide(victor, long.id, {
      outcome: "approved",
      actionHash: long.actionHash,
      note: "x".repeat(281),
    });
    expect(tooLong.status).toBe(400);
    expect((await rowOf(long.id)).status).toBe("pending");
  });

  it("apply not ok → failed with its result code; its writes rolled back (savepoint); approval.apply_failed", async () => {
    const r = await request("test.apply");
    failing.add(r.resourceId);
    const res = await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ApprovalSummary.parse(res.body)).toMatchObject({ status: "failed", resultCode: "test_conflict" });
    expect(await rowOf(r.id)).toMatchObject({
      status: "failed",
      result_code: "test_conflict",
      applied_at: null,
    });
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(0);
    const [failed] = await auditsFor("approval.apply_failed", r.id);
    expect(failed).toMatchObject({
      result: "error",
      metadata: { approvalId: r.id, resultCode: "test_conflict" },
    });
  });

  it("the routes authenticate first: anonymous → 401", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await anon.request("GET", "/api/v1/approvals?role=decider")).status).toBe(401);
    expect((await anon.request("GET", `/api/v1/approvals/${randomUUID()}`)).status).toBe(401);
    const post = await anon.request("POST", `/api/v1/approvals/${randomUUID()}/decision`, {});
    expect(post.status).toBe(401);
    expect(errorCode(post)).toBeDefined();
  });
});
