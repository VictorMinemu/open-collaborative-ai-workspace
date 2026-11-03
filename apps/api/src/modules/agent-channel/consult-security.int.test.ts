import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { invite } from "../../testing-workzone";
import { createPermissionService } from "../organization";
import { sweepConsults } from "./consult-tick";

/**
 * 07.7-11 (C-02, D-16; A2A-01…A2A-03): the phase's security properties across every 07.7 route, in two organizations on
 * one stack (real PostgreSQL, Redis and pg-boss), the 07.6-24 pattern. Organization A is Víctor Ruiz's (bots Archie and
 * Bea), organization B is Eve's (bots Warden and Keeper). The org switch is on in both. Each organization runs a full
 * consult (question, answer, return reply), a timeout (`sweepConsults` with an injected clock) and a Stop, with
 * distinctive canaries in every human message, question, answer and reply. Then:
 *   - "07.7 route coverage (org B)": every registered 07.7 route (enumerated from the authz registry) has an organization
 *     B case aimed at organization A's objects; a route added later under these paths without a case fails with its
 *     path; organization A's chains, hops, rules and turns are byte-identical before and after;
 *   - "no content in logs or audit": no canary in the captured API log lines (debug) or any `audit_events.metadata`, and
 *     every `agent.consult.*`, `agent.chain.*` and `bot.tool_call` row carries ids, codes and counts only;
 *   - "pgboss holds ids only": every `consult.tick` job's data is `{}` and no canary is anywhere in the `pgboss` schema.
 */

const CELL_TOKEN = "ocw-test-cell-token-consult-security-0123456789";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };
type OrgKey = "A" | "B";

let stack: TestStack;
let su: pg.Client;
const logs: string[] = [];

const core = () => stack.built.core;
const deps = () => ({ perms: createPermissionService(core()), memory: stack.built.memory });

/** Every canary written by the scenarios (human messages, questions, answers, replies). */
const CANARIES: string[] = [];
function canary(org: OrgKey, what: string): string {
  const c = `OCWCANARY${org}${what}${randomBytes(5).toString("hex")}`;
  CANARIES.push(c);
  return c;
}

/** One organization's cast and the objects its scenarios leave behind. */
interface Org {
  key: OrgKey;
  id: string;
  admin: TestClient;
  adminId: string;
  token: string;
  askerId: string;
  askerHandle: string;
  targetId: string;
  channelId: string;
  /** Every chain, hop, message and event id the scenarios produced (never in a body B receives). */
  ids: string[];
  completedChainId: string;
  /** An active chain with a pending hop, left open for the route cases. */
  pending?: { chainId: string; hopId: string; asker: Json; asked: Json };
}

const orgs = {} as Record<OrgKey, Org>;

async function ok(res: Promise<Res> | Res, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body ?? {}) as Json;
}

const req = (as: TestClient, method: string, path: string, body?: unknown) =>
  as.request(method, path, body) as Promise<Res>;

async function cell(path: string, body: unknown, token: string): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const rows = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows as Json[];

const consult = (o: Org, ev: Json, target: string, question: string, token = o.token) =>
  cell(
    "/consultations",
    {
      eventId: ev.eventId,
      agentId: ev.agent.id,
      target,
      question,
      idempotencyKey: `${ev.eventId}:consult:${target}`,
    },
    token,
  );

/** A bot's post for a delivered turn (what the bridge sends): in the turn's thread, with its event id. */
const post = (o: Org, ev: Json, text: string) =>
  cell(
    "/messages",
    {
      agentId: ev.agent.id,
      conversationId: ev.conversation.id,
      threadRootMessageId: ev.thread.rootMessageId,
      inReplyToMessageId: ev.message.id,
      eventId: ev.eventId,
      text,
      idempotencyKey: `evt:${ev.eventId}`,
    },
    o.token,
  );

const done = (o: Org, ev: Json, token = o.token) =>
  cell(`/turns/${ev.eventId}/done`, { agentId: ev.agent.id, outcome: "replied" }, token);

const cellEvents = (o: Org, type: string) =>
  rows("select payload from app.stream_events where stream_id = $1 and type = $2 order by seq", [
    `cell:${o.id}`,
    type,
  ]).then((r) => r.map((x) => x.payload as Json));

async function deliveryOn(o: Org, messageId: string, agentId: string): Promise<Json> {
  const [ev] = (await cellEvents(o, "agent.mention.v1")).filter(
    (p) => p.message.id === messageId && p.agent.id === agentId,
  );
  if (!ev) throw new Error(`no delivery for ${agentId} on ${messageId}`);
  return ev;
}

async function replyFor(o: Org, hopId: string): Promise<Json> {
  const [ev] = (await cellEvents(o, "agent.consult_reply.v1")).filter((p) => p.consultReply.hopId === hopId);
  if (!ev) throw new Error(`no consult reply for ${hopId}`);
  return ev;
}

/** The organization's human mentions the asking bot in a fresh thread; the bot's delivered turn. */
async function rootTurn(o: Org, what: string): Promise<Json> {
  await su.query("delete from app.agent_usage_daily");
  const root = await ok(
    req(o.admin, "POST", `/api/v1/conversations/${o.channelId}/messages`, {
      body: `Pump order ${canary(o.key, `${what}root`)}`,
    }),
  );
  const msg = await ok(
    req(o.admin, "POST", `/api/v1/conversations/${o.channelId}/messages`, {
      body: `@${o.askerHandle} please check ${canary(o.key, `${what}ask`)}`,
      mentions: [{ kind: "agent", id: o.askerId }],
      threadRootId: root.id,
    }),
  );
  o.ids.push(root.id as string, msg.id as string);
  const turn = await deliveryOn(o, msg.id as string, o.askerId);
  o.ids.push(turn.eventId as string);
  return turn;
}

/** The asking bot consults the target in a fresh thread: the hop and the target's question turn. */
async function consulted(o: Org, what: string) {
  const asker = await rootTurn(o, what);
  const hop = await ok(consult(o, asker, o.targetId, `Is it confirmed? ${canary(o.key, `${what}question`)}`));
  expect(hop.ok, JSON.stringify(hop)).toBe(true);
  const asked = await deliveryOn(o, hop.questionMessageId as string, o.targetId);
  o.ids.push(hop.chainId, hop.hopId, hop.questionMessageId, asked.eventId);
  return { asker, hop, asked };
}

async function insertBot(org: string, name: string): Promise<string> {
  return (
    await su.query(
      `insert into app.agents (organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, $3, $4, 'mock', 'mock-1', 'ready') returning id`,
      [org, name, name.toLowerCase(), `You are ${name}.`],
    )
  ).rows[0].id as string;
}

async function channel(as: TestClient, name: string, botIds: string[]): Promise<string> {
  const id = (await ok(req(as, "POST", "/api/v1/channels", { name, visibility: "private" }))).id as string;
  for (const botId of botIds) {
    await ok(req(as, "POST", `/api/v1/channels/${id}/members`, { kind: "agent", id: botId }));
  }
  return id;
}

/** A full consult, a timeout and a Stop, each with its own canaries. */
async function exercise(o: Org): Promise<void> {
  // 1. A full consult: question → answer → the asker's return reply; every turn reports done; the chain completes.
  const full = await consulted(o, "full");
  const answer = await ok(post(o, full.asked, `Yes, PO-1187 ${canary(o.key, "answer")}`));
  o.ids.push(answer.messageId as string);
  await ok(done(o, full.asked));
  const back = await replyFor(o, full.hop.hopId);
  expect(back.consultReply.outcome).toBe("answered");
  o.ids.push(back.eventId as string);
  const reply = await ok(post(o, back, `Bea says yes ${canary(o.key, "reply")}`));
  o.ids.push(reply.messageId as string);
  await ok(done(o, back));
  await ok(done(o, full.asker));
  const [chain] = await rows("select status from app.agent_chains where id = $1", [full.hop.chainId]);
  expect(chain?.status).toBe("completed");
  o.completedChainId = full.hop.chainId as string;

  // 2. A timeout through the tick with an injected clock: the asker hears back as a new turn and replies.
  const late = await consulted(o, "late");
  const [{ deadline_at }] = (await rows("select deadline_at from app.agent_chain_hops where id = $1", [
    late.hop.hopId,
  ])) as [Json];
  const at = new Date(new Date(deadline_at).getTime() + 1000);
  expect(await sweepConsults(core(), deps(), at)).toMatchObject({ timedOut: 1 });
  const timedOut = await replyFor(o, late.hop.hopId);
  expect(timedOut.consultReply.outcome).toBe("timed_out");
  o.ids.push(timedOut.eventId as string);
  await ok(post(o, timedOut, `No answer yet ${canary(o.key, "latereply")}`));
  await ok(done(o, timedOut));
  await ok(done(o, late.asker));

  // 3. A Stop by the chain's human.
  const stopped = await consulted(o, "stop");
  expect(await ok(req(o.admin, "POST", `/api/v1/agent-chains/${stopped.hop.chainId}/cancel`))).toEqual({
    chainId: stopped.hop.chainId,
    status: "cancelled",
  });
  await ok(done(o, stopped.asker));
}

beforeAll(async () => {
  stack = await startTestStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock", LOG_LEVEL: "debug" },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  const victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    req(victor, "POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  const { client: eve, userId: eveId } = await invite(
    stack,
    victor,
    "eve@example.test",
    "Eve Black",
    "standard",
  );

  // Organization A: Archie asks Bea in a private #ops.
  const orgA = setup.organization.id as string;
  const archie = await insertBot(orgA, "Archie");
  const bea = await insertBot(orgA, "Bea");
  orgs.A = {
    key: "A",
    id: orgA,
    admin: victor,
    adminId: setup.user.id as string,
    token: CELL_TOKEN,
    askerId: archie,
    askerHandle: "archie",
    targetId: bea,
    channelId: await channel(victor, "ops", [archie, bea]),
    ids: [archie, bea],
    completedChainId: "",
  };
  // Archie's per-bot rules and Bea's inbound switch: real `agent.message` rows of A that B must never change.
  await ok(req(victor, "PUT", "/api/v1/agent-messaging", { enabled: true }));
  await ok(
    req(victor, "PUT", `/api/v1/agents/${archie}/messaging`, {
      outbound: { mode: "any", allow: [], deny: [] },
      inbound: { consultable: true },
    }),
  );
  orgs.A.ids.push(orgs.A.channelId);

  // Organization B: Eve moves into her own organization as its admin, with its own cell token, bots and channel.
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Second', $2)", [
    orgB,
    `second-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve Black', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);
  expect((await ok(req(eve, "GET", "/api/v1/me/permissions"))).role).toBe("admin");
  const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [orgB, sha256Hex(tokenB)],
  );
  const warden = await insertBot(orgB, "Warden");
  const keeper = await insertBot(orgB, "Keeper");
  orgs.B = {
    key: "B",
    id: orgB,
    admin: eve,
    adminId: eveId,
    token: tokenB,
    askerId: warden,
    askerHandle: "warden",
    targetId: keeper,
    channelId: await channel(eve, "lab", [warden, keeper]),
    ids: [warden, keeper],
    completedChainId: "",
  };
  await ok(req(eve, "PUT", "/api/v1/agent-messaging", { enabled: true }));

  await exercise(orgs.A);
  await exercise(orgs.B);
  // A's chain left open for the route cases: a pending hop, the asker waiting.
  const p = await consulted(orgs.A, "open");
  orgs.A.pending = { chainId: p.hop.chainId, hopId: p.hop.hopId, asker: p.asker, asked: p.asked };
}, 300_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------- route coverage

/** What a 07.7 route answers organization B when it names organization A's objects. */
type Case = (a: Org) => Promise<void>;

const eve = () => orgs.B.admin;

/** Nothing of organization A (ids, canaries) in a body organization B received. */
function expectNothingOf(a: Org, r: Res): void {
  const text = JSON.stringify(r.body ?? {});
  for (const id of a.ids) expect(text, id).not.toContain(id);
  for (const c of CANARIES.filter((x) => x.startsWith("OCWCANARYA"))) expect(text).not.toContain(c);
}

const errorCode = (r: Res) => (r.body?.error as Json | undefined)?.code ?? r.body?.code;

/** B's admin aims at A's object: 404 with the given code, and nothing of A in the body. */
const notFound =
  (method: string, path: (a: Org) => string, code: string, body?: (a: Org) => unknown): Case =>
  async (a) => {
    const r = await req(eve(), method, path(a), body?.(a));
    expect(r.status, `${method} ${path(a)}: ${JSON.stringify(r.body)}`).toBe(404);
    expect(errorCode(r)).toBe(code);
    expectNothingOf(a, r);
  };

/** B's admin on a route without an id: B's own answer, never A's (A's decisions are in the snapshot). */
const own =
  (method: string, path: string, body?: unknown): Case =>
  async (a) => {
    const r = await req(eve(), method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body?.enabled).toBe(true);
    expectNothingOf(a, r);
  };

const CASES: Record<string, Case> = {
  // ---- the organization switch (07.7-03): B reads and writes its own; A's switch row is in the snapshot
  "GET /api/v1/agent-messaging": own("GET", "/api/v1/agent-messaging"),
  "PUT /api/v1/agent-messaging": own("PUT", "/api/v1/agent-messaging", { enabled: true }),
  // ---- per-bot consult rules (07.7-03): A's bot is 404; A's bot as a target of B's bot is 400
  "GET /api/v1/agents/:id/messaging": notFound(
    "GET",
    (a) => `/api/v1/agents/${a.askerId}/messaging`,
    "bot_not_found",
  ),
  "PUT /api/v1/agents/:id/messaging": async (a) => {
    await notFound(
      "PUT",
      (x) => `/api/v1/agents/${x.askerId}/messaging`,
      "bot_not_found",
      () => ({
        outbound: { mode: "none", allow: [], deny: [] },
        inbound: { consultable: false },
      }),
    )(a);
    const r = await req(eve(), "PUT", `/api/v1/agents/${orgs.B.askerId}/messaging`, {
      outbound: { mode: "only", allow: [a.targetId], deny: [] },
      inbound: { consultable: true },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(errorCode(r)).toBe("invalid_agent_messaging");
    expectNothingOf(a, r);
  },
  // ---- the consult route (07.7-04): B's cell with A's turn → 404; B's own turn naming A's bot → 404 target_not_found
  "POST /agent-channel/v1/consultations": async (a) => {
    const open = a.pending as NonNullable<Org["pending"]>;
    const foreign = await consult(a, open.asked, a.askerId, "From B, about A", orgs.B.token);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expectNothingOf(a, foreign);
    const warden = await rootTurn(orgs.B, "probe");
    const toA = await consult(orgs.B, warden, a.targetId, "Ask A's bot from B");
    expect(toA.status, JSON.stringify(toA.body)).toBe(404);
    expect(toA.body?.code).toBe("target_not_found");
    expectNothingOf(a, toA);
    await ok(done(orgs.B, warden));
  },
  // ---- turn done (07.7-06): B's cell reporting A's pending turns → 404, nothing closed
  "POST /agent-channel/v1/turns/:eventId/done": async (a) => {
    const open = a.pending as NonNullable<Org["pending"]>;
    for (const ev of [open.asked, open.asker]) {
      const r = await done(a, ev, orgs.B.token);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      expectNothingOf(a, r);
    }
  },
  // ---- Stop (07.7-06): B's admin with A's active chain and A's completed chain → 404 chain_not_found
  "POST /api/v1/agent-chains/:id/cancel": async (a) => {
    const open = a.pending as NonNullable<Org["pending"]>;
    await notFound("POST", () => `/api/v1/agent-chains/${open.chainId}/cancel`, "chain_not_found")(a);
    await notFound("POST", () => `/api/v1/agent-chains/${a.completedChainId}/cancel`, "chain_not_found")(a);
  },
};

const PHASE_ROUTE =
  /^[A-Z]+ (\/api\/v1\/(agent-messaging|agents\/:id\/messaging|agent-chains)(\/|$)|\/agent-channel\/v1\/(consultations|turns)(\/|$))/u;

/** Everything of organization A that organization B must never change: chains, hops, rules and turns. */
async function snapshotA(): Promise<string> {
  const out: unknown[] = [];
  for (const q of [
    "select id, status, hops_used, cancel_reason, closed_at, updated_at from app.agent_chains where organization_id = $1 order by id",
    "select id, status, answer_message_id, deadline_at, tick_attempts, closed_at, updated_at from app.agent_chain_hops where organization_id = $1 order by id",
    "select id, scope_unit_id, subject_kind, subject_id, tool, effect from app.permission_rules where organization_id = $1 and permission = 'agent.message' order by id",
    "select event_id, chain_id, chain_depth, answering_hop_id, returning_hop_id, reply_message_id, done_at, tainted from app.agent_turns where organization_id = $1 order by event_id",
  ]) {
    out.push((await su.query(q, [orgs.A.id])).rows);
  }
  return JSON.stringify(out);
}

describe("07.7 route coverage (org B)", () => {
  it("every registered 07.7 route has an organization-B case; none reaches organization A", async () => {
    const routes = stack.built.authz.routes;
    const registered = [...routes.keys()]
      .filter((key) => !key.startsWith("HEAD ") && PHASE_ROUTE.test(key))
      .sort();
    // A route added later under these paths without a case fails here, naming its method and path.
    expect(registered).toEqual(Object.keys(CASES).sort());
    const before = await snapshotA();
    for (const run of Object.values(CASES)) await run(orgs.A);
    expect(await snapshotA()).toBe(before);
    // A's chain is still open: B's done reports and Stop changed nothing.
    const open = orgs.A.pending as NonNullable<Org["pending"]>;
    expect(
      (await rows("select status from app.agent_chain_hops where id = $1", [open.hopId]))[0]?.status,
    ).toBe("pending");
    expect((await rows("select status from app.agent_chains where id = $1", [open.chainId]))[0]?.status).toBe(
      "active",
    );
    for (const key of Object.keys(CASES)) {
      expect(routes.get(key), key).toBe(key.includes("/agent-channel/") ? "cell" : "user");
    }
  });

  it("CR-B-05: B's per-target rule cap counts B's rows only; A's bot still takes a rule", async () => {
    const b = orgs.B;
    const others: string[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const id = await insertBot(b.id, `Zz${String(i).padStart(3, "0")}`);
        others.push(id);
        await su.query(
          `insert into app.permission_rules (organization_id, subject_kind, subject_id, permission, tool, effect)
           values ($1, 'agent', $2, 'agent.message', $3, 'deny')`,
          [b.id, b.askerId, `agent:${id}`],
        );
      }
      const refused = await req(eve(), "POST", "/api/v1/permission-rules", {
        subjectKind: "agent",
        subjectId: b.askerId,
        permission: "agent.message",
        tool: `agent:${b.targetId}`,
        effect: "deny",
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(errorCode(refused)).toBe("agent_rule_limit");
      // Organization A's count is its own: Víctor's 1st per-target rule on Archie is accepted.
      const a = orgs.A;
      const created = await ok(
        req(a.admin, "POST", "/api/v1/permission-rules", {
          subjectKind: "agent",
          subjectId: a.askerId,
          permission: "agent.message",
          tool: `agent:${a.targetId}`,
          effect: "deny",
        }),
      );
      await ok(req(a.admin, "DELETE", `/api/v1/permission-rules/${created.id}`));
    } finally {
      await su.query("delete from app.permission_rules where organization_id = $1 and subject_id = $2", [
        b.id,
        b.askerId,
      ]);
      await su.query("update app.agents set deleted_at = now() where id = any($1::uuid[])", [others]);
    }
  });
});

// ---------------------------------------------------------------- logs and audit

/** True when every leaf of `v` is an id, a code, a count or a flag: no free text (no whitespace, bounded). */
function idsAndCodesOnly(v: unknown): boolean {
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v === "string") return /^[A-Za-z0-9_.:@/-]{0,120}$/u.test(v);
  if (Array.isArray(v)) return v.every(idsAndCodesOnly);
  if (typeof v === "object") return Object.values(v as Json).every(idsAndCodesOnly);
  return false;
}

describe("no content in logs or audit (D-16)", () => {
  it("the canaries really travelled: questions, answers and replies are stored messages in both organizations", async () => {
    const bodies = (
      await rows("select body from app.messages where organization_id = any($1::uuid[])", [
        [orgs.A.id, orgs.B.id],
      ])
    ).map((r) => r.body as string);
    for (const k of ["A", "B"]) {
      for (const what of ["fullquestion", "answer", "reply", "latequestion", "stopquestion"]) {
        const needle = CANARIES.find((c) => c.startsWith(`OCWCANARY${k}${what}`)) as string;
        expect(
          bodies.some((b) => b.includes(needle)),
          `${k}:${what}`,
        ).toBe(true);
      }
    }
  });

  it("no canary in the captured API log lines (debug)", () => {
    expect(logs.length).toBeGreaterThan(50);
    // The capture is the API's real output: the consult requests are in it (by route, never by content).
    expect(logs.some((l) => l.includes("/agent-channel/v1/consultations"))).toBe(true);
    const leaks: string[] = [];
    for (const line of logs) {
      for (const needle of CANARIES) {
        if (line.includes(needle)) leaks.push(`${needle.slice(0, 18)}… in ${line.slice(0, 240)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no canary in any audit_events metadata; consult, chain and tool-call audits carry ids, codes and counts only", async () => {
    const audits = await rows(
      "select organization_id, action, actor_kind, metadata from app.audit_events where organization_id = any($1::uuid[])",
      [[orgs.A.id, orgs.B.id]],
    );
    for (const o of [orgs.A, orgs.B]) {
      const actions = new Set(
        audits.filter((r) => r.organization_id === o.id).map((r) => r.action as string),
      );
      for (const action of [
        "agent.consult.requested",
        "agent.consult.answered",
        "agent.consult.timed_out",
        "agent.chain.cancelled",
        "bot.tool_call",
      ]) {
        expect(actions.has(action), `${o.key} ${action}`).toBe(true);
      }
    }
    const leaks: string[] = [];
    for (const r of audits) {
      const text = JSON.stringify(r.metadata ?? {});
      for (const needle of CANARIES)
        if (text.includes(needle)) leaks.push(`${r.action}: ${needle.slice(0, 18)}…`);
    }
    expect(leaks).toEqual([]);
    const scoped = audits.filter((r) => /^(agent\.consult\.|agent\.chain\.|bot\.tool_call$)/u.test(r.action));
    expect(scoped.length).toBeGreaterThan(10);
    for (const r of scoped)
      expect(idsAndCodesOnly(r.metadata), `${r.action} ${JSON.stringify(r.metadata)}`).toBe(true);
    // A timeout is the system's act, audited as such.
    expect(
      audits.filter((r) => r.action === "agent.consult.timed_out").every((r) => r.actor_kind === "system"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- pgboss

describe("pgboss holds ids only (D-11, D-16)", () => {
  it("every consult.tick job carries {} and no canary is anywhere in the pgboss schema", async () => {
    for (const o of [orgs.A, orgs.B]) {
      await core().db.withTenant({ organizationId: o.id, userId: null }, (tx) =>
        core().jobs.sendInTx(tx, "consult.tick", {}),
      );
    }
    expect(await core().jobs.drain("consult.tick")).toBe(2);
    const jobs = await rows("select data from pgboss.job where name = 'consult.tick'");
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const j of jobs) expect(j.data).toEqual({});
    const tables = (
      await rows(
        "select table_name from information_schema.tables where table_schema = 'pgboss' and table_type = 'BASE TABLE' order by 1",
      )
    ).map((r) => r.table_name as string);
    expect(tables).toContain("job");
    const leaks: string[] = [];
    for (const table of tables) {
      for (const r of await rows(`select row_to_json(t)::text as text from pgboss."${table}" t`)) {
        for (const needle of CANARIES)
          if ((r.text as string).includes(needle)) leaks.push(`${table}: ${needle}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
