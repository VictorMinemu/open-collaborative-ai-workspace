import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 07.8-16 (BRW-03; D-07, D-11 F-5, D-12 U-2; P-08, P-10): take control and hand back. One lease per page across API
 * instances; the bot waits (`paused`, no budget); during the lease only the controlling socket receives frames; while a
 * member's session is loaded only that member does; input is accepted from the controller's socket only and is never
 * recorded anywhere. Real PostgreSQL and Redis, two API instances on them, the in-memory sandboxd.
 *
 * OpenTelemetry runs in-process here with the API's own instrumentations (http, pg, Fastify) and an in-memory exporter,
 * started BEFORE the app is imported (dynamic imports below), so the sentinel sweep covers real spans.
 */

const SENTINEL = "OCW-SENTINEL-TYPED-8842";

const spans = new InMemorySpanExporter();
// biome-ignore lint/suspicious/noExplicitAny: the SDK is created before the app modules are imported
let sdk: any;
type Live = typeof import("./live-testing");
let T: Live;
let l: Awaited<ReturnType<Live["startLiveStack"]>>;
let second: { baseUrl: string; close(): Promise<void> } | null = null;
const redisMessages: string[] = [];
let redisTap: ReturnType<typeof createClient> | null = null;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

beforeAll(async () => {
  const [{ NodeSDK }, { HttpInstrumentation }, { PgInstrumentation }, { FastifyOtelInstrumentation }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-pg"),
      import("@fastify/otel"),
    ]);
  sdk = new NodeSDK({
    resourceDetectors: [],
    spanProcessors: [new SimpleSpanProcessor(spans)],
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  T = await import("./live-testing");
  l = await T.startLiveStack();
  // Every Redis message of the test, on every channel (the API's pub/sub included).
  redisTap = createClient({ url: l.s.stack.redis.getConnectionUrl() });
  await redisTap.connect();
  await redisTap.pSubscribe("*", (message) => void redisMessages.push(message));
  const { buildApp } = await import("../../app");
  const built = await buildApp(l.s.stack.env, {
    logger: true,
    logStream: { write: (line: string) => void l.s.logs.push(line) },
  });
  try {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
  } catch (err) {
    await built.close().catch(() => {});
    throw err;
  }
  const addr = built.app.server.address();
  second = {
    baseUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    close: () => built.close(),
  };
});

afterAll(async () => {
  try {
    await redisTap?.quit().catch(() => {});
    await second?.close().catch(() => {});
  } finally {
    try {
      await l?.stop();
    } finally {
      await sdk?.shutdown().catch(() => {});
    }
  }
});

const turnRow = async (eventId: string) =>
  (await l.s.su.query("select sandbox_calls from app.agent_turns where event_id = $1", [eventId]))
    .rows[0] as Json;
const fakeContext = (contextId: string) =>
  l.s.sandboxd.stats().browser.contexts.find((c) => c.contextId === contextId);
const auditOf = async (action: string, contextId: string) =>
  (
    await l.s.su.query(
      "select actor_kind, actor_id, user_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
      [action, contextId],
    )
  ).rows as Json[];
const states = (s: { json: Json[] }) => s.json.filter((f) => f.type === "state");
const ok200 = async (r: Promise<{ status: number; body: Json | null }>) => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Json;
};
/** The error code of a bot route's answer (local: importing the testing modules would load the app before OTel). */
const codeOf = (r: { body: Json | null }) => (r.body?.error as Json | undefined)?.code;

async function pageWithViewers() {
  const ev = await l.turnIn(l.s.sam);
  const contextId = await l.open(ev);
  const sam = await T.liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
  const alex = await T.liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
  await T.waitFor(() => sam.binary.length >= 2 && alex.binary.length >= 2);
  return { ev, contextId, sam, alex };
}

describe("take control and hand back: the takeover privacy rule (F-5, T-07.8-16-01)", () => {
  it("Sam takes: he controls; Alex sees `private` and ZERO frames for 3 s; the bot is paused; hand back restores both", async () => {
    const { ev, contextId, sam, alex } = await pageWithViewers();
    try {
      sam.send({ type: "take" });
      const lease = await T.waitFor(() => sam.json.find((f) => f.type === "lease"));
      expect(Date.parse(lease.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
      await T.waitState(sam, "controlling");
      expect(T.lastState(sam)).toMatchObject({ controller: "self", host: "panel.fake.test" });
      const priv = await T.waitState(alex, "private");
      expect(priv).toMatchObject({
        privateReason: "takeover",
        controller: "other",
        memberName: "Sam Lee",
        host: null,
      });
      expect(fakeContext(contextId)?.takeover).toBe(true);

      // The acceptance window: frames keep flowing to Sam, none to Alex.
      const alexAt = alex.binary.length;
      const samAt = sam.binary.length;
      await T.sleep(3000);
      expect(alex.binary.length).toBe(alexAt);
      expect(sam.binary.length - samAt).toBeGreaterThanOrEqual(10);

      // The bot waits: 409 paused, no budget used.
      const before = (await turnRow(ev.eventId)).sandbox_calls;
      const act = await l.browser("act", ev, { action: "click", ref: "r4" });
      expect(act.status).toBe(409);
      expect(codeOf(act)).toBe("paused");
      expect((await turnRow(ev.eventId)).sandbox_calls).toBe(before);

      sam.send({ type: "release" });
      await T.waitState(sam, "live");
      await T.waitState(alex, "live");
      await T.waitFor(() => alex.binary.length > alexAt + 2);
      expect(fakeContext(contextId)?.takeover).toBe(false);
      expect((await l.browser("act", ev, { action: "click", ref: "r4" })).status).toBe(200);

      const started = await auditOf("browser.takeover_started", contextId);
      const ended = await auditOf("browser.takeover_ended", contextId);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ actor_kind: "user", actor_id: l.s.samId, user_id: l.s.samId });
      expect(Object.keys(started[0]?.metadata).sort()).toEqual(["contextId", "host"]);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.metadata).toEqual({ contextId, host: "panel.fake.test", reason: "released" });
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("Alex (a reader, not the requester) cannot take: refused not_allowed, no lease, no audit", async () => {
    const { contextId, sam, alex } = await pageWithViewers();
    try {
      alex.send({ type: "take" });
      const refused = await T.waitFor(() => alex.json.find((f) => f.type === "refused"));
      expect(refused).toEqual({ type: "refused", op: "take", reason: "not_allowed" });
      await T.sleep(300);
      expect(fakeContext(contextId)?.takeover).toBe(false);
      expect(states(sam).at(-1)?.state).toBe("live");
      expect(await auditOf("browser.takeover_started", contextId)).toHaveLength(0);
      const row = (
        await l.s.su.query("select controller_user_id from app.browser_contexts where id = $1", [contextId])
      ).rows[0];
      expect(row.controller_user_id).toBeNull();
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("one lease across two API instances: Sam's other device sees other_device and no frames; its take is someone_else; closing the controller hands back", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const token = await l.s.sam.token();
    const a = await T.liveSocket(l.s.stack.baseUrl, token, contextId);
    const b = await T.liveSocket(second?.baseUrl as string, token, contextId);
    try {
      await T.waitFor(() => a.binary.length >= 2 && b.binary.length >= 2);
      a.send({ type: "take" });
      await T.waitState(a, "controlling");
      const other = await T.waitState(b, "private");
      expect(other).toMatchObject({ privateReason: "takeover", controller: "other_device" });
      const bAt = b.binary.length;
      b.send({ type: "take" });
      const refused = await T.waitFor(() => b.json.find((f) => f.type === "refused"));
      expect(refused.reason).toBe("someone_else");
      await T.sleep(1500);
      expect(b.binary.length).toBe(bAt);
      expect(fakeContext(contextId)?.takeover).toBe(true);

      a.close();
      await a.closed;
      await T.waitState(b, "live");
      await T.waitFor(() => b.binary.length > bAt + 1);
      expect(fakeContext(contextId)?.takeover).toBe(false);
      const ended = await auditOf("browser.takeover_ended", contextId);
      expect(ended.map((e) => e.metadata.reason)).toEqual(["closed"]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("member-session privacy (U-2, T-07.8-16-02)", () => {
  it("with Sam's sealed session loaded, Víctor (owner) and Alex (reader) see `private` (member_session) and zero frames; Sam sees the page", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const victor = await T.liveSocket(l.s.stack.baseUrl, await l.s.victor.token(), contextId);
    try {
      await T.waitFor(() => victor.binary.length >= 2);
      // The member's session is loaded (07.8-21 will do this through sign-in): the poll re-decides at once.
      const secret = (
        await l.s.su.query(
          "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser_session', 'x', 'x', 'x') returning id",
          [l.s.orgA, `browser-session-${contextId.slice(0, 8)}`],
        )
      ).rows[0].id as string;
      const session = (
        await l.s.su.query(
          `insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at)
           values ($1, $2, $3, 'panel.fake.test', $4, now() + interval '30 days')
           on conflict (organization_id, user_id, agent_id, site_key) do update set secret_id = excluded.secret_id
           returning id`,
          [l.s.orgA, l.s.samId, l.s.scoutId, secret],
        )
      ).rows[0].id as string;
      await l.s.su.query("update app.browser_contexts set session_id = $2 where id = $1", [
        contextId,
        session,
      ]);

      const priv = await T.waitState(victor, "private");
      expect(priv).toMatchObject({ privateReason: "member_session", memberName: "Sam Lee", host: null });
      const vAt = victor.binary.length;
      const alex = await T.liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
      const sam = await T.liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
      try {
        await T.waitFor(() => alex.json.length >= 2);
        expect(alex.json[0]).toEqual({ type: "viewerCan", watch: false, control: false });
        expect(alex.json[1]).toMatchObject({
          state: "private",
          privateReason: "member_session",
          memberName: "Sam Lee",
        });
        await T.waitFor(() => sam.binary.length >= 3);
        expect(sam.json[0]).toEqual({ type: "viewerCan", watch: true, control: true });
        await T.sleep(1000);
        expect(alex.binary).toHaveLength(0);
        // Proof pipeline 55: from the moment the live view learns of the session it holds Víctor's frames until his new
        // answer (`private`) is sent, so nothing arrives after that state frame (no "one frame in flight" either).
        expect(victor.binary.length).toBe(vAt);
        await T.sleep(1000);
        expect(victor.binary.length).toBe(vAt);
      } finally {
        alex.close();
        sam.close();
      }
    } finally {
      victor.close();
    }
  });
});

describe("input reaches the page and nothing else (P-10, T-07.8-16-03)", () => {
  it("Sam's typed sentinel and keys reach sandboxd; Alex's input is ignored; the sentinel is in no log, span, audit, stream, Redis message or response", async () => {
    const { ev, contextId, sam, alex } = await pageWithViewers();
    const spanCountBefore = spans.getFinishedSpans().length;
    try {
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      sam.send({ type: "mouse", event: "down", x: 100, y: 120, button: "left" });
      sam.send({ type: "mouse", event: "up", x: 100, y: 120, button: "left" });
      sam.send({ type: "text", text: SENTINEL });
      sam.send({ type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 });
      sam.send({ type: "key", event: "up", key: "Enter", code: "Enter", modifiers: 0 });
      // Alex's input (a reader without the lease) and a malformed frame carrying the sentinel are dropped.
      alex.send({ type: "text", text: `${SENTINEL}-alex` });
      alex.send({ type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 });
      sam.send({ type: "text", text: SENTINEL, selector: "#password" });
      // A truncated JSON frame carrying the sentinel literally: dropped without an echo or a log line.
      sam.socket.send('{"type":"text","text":"OCW-SENTINEL-TYPED-8842"');
      await T.waitFor(() => (fakeContext(contextId)?.inputs.key ?? 0) >= 2);
      await T.sleep(500);
      expect(fakeContext(contextId)?.inputs).toEqual({ mouse: 2, text: 1, key: 2 });
      sam.send({ type: "release" });
      await T.waitState(sam, "live");
      const act = await l.browser("snapshot", ev);
      expect(JSON.stringify(act.body)).not.toContain(SENTINEL);
    } finally {
      sam.close();
      alex.close();
    }
    await T.sleep(300);

    const db = await l.s.su.query(
      `select (select count(*) from app.audit_events where metadata::text like $1)
            + (select count(*) from app.stream_events where payload::text like $1)
            + (select count(*) from app.bot_turn_activity where steps::text like $1)
            + (select count(*) from app.agent_tool_calls where coalesce(reason, '') || coalesce(target, '') like $1)
            + (select count(*) from app.browser_contexts where host like $1) as n`,
      [`%${SENTINEL}%`],
    );
    expect(Number(db.rows[0].n)).toBe(0);
    expect(l.s.logs.length).toBeGreaterThan(0);
    expect(l.s.logs.filter((line) => line.includes(SENTINEL))).toEqual([]);
    expect(redisMessages.length).toBeGreaterThan(0);
    expect(redisMessages.filter((m) => m.includes(SENTINEL))).toEqual([]);
    const all = spans.getFinishedSpans();
    expect(all.length).toBeGreaterThan(spanCountBefore);
    expect(
      all.filter((s) => JSON.stringify({ n: s.name, a: s.attributes, e: s.events }).includes(SENTINEL)),
    ).toEqual([]);
    expect(JSON.stringify(sam.json)).not.toContain(SENTINEL);
    expect(JSON.stringify(alex.json)).not.toContain(SENTINEL);
  });
});

describe("the idle lease (D-07: warning at 9 minutes, released at 10)", () => {
  it("no input for 9 minutes → a lease warning; at 10 → released `idle`, audited with ids and host only", async () => {
    const { contextId, sam, alex } = await pageWithViewers();
    try {
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      const hub = l.s.stack.built.browser.live();
      const leases = () => sam.json.filter((f) => f.type === "lease").length;
      const first = leases();
      await hub?.sweep(Date.now() + 8 * 60_000);
      expect(leases()).toBe(first);
      await hub?.sweep(Date.now() + 9 * 60_000 + 30_000);
      await T.waitFor(() => leases() === first + 1);
      await hub?.sweep(Date.now() + 10 * 60_000 + 30_000);
      await T.waitState(sam, "live");
      await T.waitState(alex, "live");
      expect(fakeContext(contextId)?.takeover).toBe(false);
      const ended = await auditOf("browser.takeover_ended", contextId);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.metadata).toEqual({ contextId, host: "panel.fake.test", reason: "idle" });
    } finally {
      sam.close();
      alex.close();
    }
  });
});

describe("a lease left by a dead API instance (WINDOWS #271, #244)", () => {
  it("nobody watches the page: the browser sweep clears it as idle once its grace passed, audited once, sandboxd's takeover off; organization B's tenant clears nothing of A's", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const { agent_id: agentId } = (
      await l.s.su.query("select agent_id from app.browser_contexts where id = $1", [contextId])
    ).rows[0] as Json;
    // A takeover started through an instance that died: the row still names Sam, sandboxd still has it on.
    await l.s.su.query(
      "update app.browser_contexts set controller_user_id = $2, lease_expires_at = now() + interval '1 minute' where id = $1",
      [contextId, l.s.samId],
    );
    await l.s.stack.built.sandbox.client?.call(
      "contextTakeover",
      { target: { orgId: l.s.orgA, agentId }, contextId, active: true },
      { timeoutMs: 5_000 },
    );
    expect(fakeContext(contextId)?.takeover).toBe(true);
    const row = async () =>
      (
        await l.s.su.query(
          "select controller_user_id, lease_expires_at from app.browser_contexts where id = $1",
          [contextId],
        )
      ).rows[0] as Json;
    const sweeper = l.s.stack.built.browser.sweeper;

    // Not expired yet, then expired but within the grace its own live view would use: untouched.
    expect((await sweeper.runOnce()).leases).toBe(0);
    expect((await sweeper.runOnce(Date.now() + 90_000)).leases).toBe(0);
    expect((await row()).controller_user_id).toBe(l.s.samId);

    // Organization B's tenant does not see A's page (RLS): it clears nothing.
    const { clearDeadLeases } = await import("./takeover");
    const core = l.s.stack.built.core;
    const inB = await core.db.withTenant({ organizationId: l.s.orgB, userId: null }, (tx) =>
      clearDeadLeases(tx, core, Date.now() + 10 * 60_000),
    );
    expect(inB).toEqual([]);
    expect((await row()).controller_user_id).toBe(l.s.samId);

    const cleared = await sweeper.runOnce(Date.now() + 3 * 60_000);
    expect(cleared.leases).toBe(1);
    expect(await row()).toEqual({ controller_user_id: null, lease_expires_at: null });
    await T.waitFor(() => fakeContext(contextId)?.takeover === false);
    const ended = await auditOf("browser.takeover_ended", contextId);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ actor_kind: "system", user_id: l.s.samId });
    expect(ended[0]?.metadata).toEqual({ contextId, host: "panel.fake.test", reason: "idle" });
    // The bot is not paused any more.
    await ok200(l.browser("snapshot", ev));
    expect((await sweeper.runOnce(Date.now() + 4 * 60_000)).leases).toBe(0);
    expect(await auditOf("browser.takeover_ended", contextId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- an abandoned takeover closes the page (ADR-0029)

/**
 * A takeover that ends WITHOUT a hand back (the socket closed, the 10-minute idle release, access lost, or a dead API
 * instance's lease swept) after the member sent input in that lease (typed, clicked, pasted), or with a member's session
 * loaded, closes the page (`takeover_abandoned`): it never goes back to the bot and its watchers with whatever the member
 * left in it. Without input (looking, moving the pointer) the page stays and is public again, as before.
 */
describe("a takeover abandoned after input closes the page (takeover_abandoned)", () => {
  const ABANDONED = "takeover_abandoned";
  const typeSomething = (s: { send(f: unknown): void }) => {
    s.send({ type: "mouse", event: "down", x: 100, y: 120, button: "left" });
    s.send({ type: "mouse", event: "up", x: 100, y: 120, button: "left" });
    s.send({ type: "text", text: "half-typed" });
  };
  const contextRow = async (contextId: string) =>
    (
      await l.s.su.query(
        "select closed_at, end_reason, controller_user_id, lease_expires_at from app.browser_contexts where id = $1",
        [contextId],
      )
    ).rows[0] as Json;
  /** The abandonment's `browser.closed` row: ids and fixed reasons only (no host, no path, nothing typed). */
  async function expectAbandonedAudit(contextId: string, leaseEnd: string) {
    const closed = (await auditOf("browser.closed", contextId)).filter(
      (a) => a.metadata.reason === ABANDONED,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.metadata).toEqual({ contextId, reason: ABANDONED, leaseEnd });
    expect(closed[0]).toMatchObject({ actor_kind: "system", user_id: l.s.samId });
  }
  /** After `ended`, the socket is closed and no binary frame arrives (the count settles for 1 s). */
  async function noFrameAfterEnd(s: { binary: unknown[]; closed: Promise<unknown> }) {
    await s.closed;
    const at = s.binary.length;
    await T.sleep(1000);
    expect(s.binary.length).toBe(at);
  }
  /** Someone opening the page afterwards sees it ended and gets zero frames. */
  async function lateViewerSeesEnded(contextId: string) {
    const late = await T.liveSocket(l.s.stack.baseUrl, await l.s.alex.token(), contextId);
    try {
      expect(await T.waitState(late, "ended")).toMatchObject({ endReason: ABANDONED });
      await noFrameAfterEnd(late);
      expect(late.binary).toHaveLength(0);
    } finally {
      late.close();
    }
  }

  it("idle release after Sam typed: closed for everyone (owner, reader, Sam) and in sandboxd; no frame after; audited with ids only", async () => {
    const { ev, contextId, sam, alex } = await pageWithViewers();
    const victor = await T.liveSocket(l.s.stack.baseUrl, await l.s.victor.token(), contextId);
    try {
      await T.waitFor(() => victor.binary.length >= 1);
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      typeSomething(sam);
      await T.waitFor(() => (fakeContext(contextId)?.inputs.text ?? 0) >= 1);
      await l.s.stack.built.browser.live()?.sweep(Date.now() + 10 * 60_000 + 30_000);
      for (const s of [sam, alex, victor]) {
        expect(await T.waitState(s, "ended")).toMatchObject({ endReason: ABANDONED });
      }
      for (const s of [sam, alex, victor]) await noFrameAfterEnd(s);
      expect(await contextRow(contextId)).toMatchObject({ end_reason: ABANDONED, controller_user_id: null });
      await T.waitFor(() => !fakeContext(contextId));
      const ended = await auditOf("browser.takeover_ended", contextId);
      expect(ended.map((e) => e.metadata.reason)).toEqual(["idle"]);
      await expectAbandonedAudit(contextId, "idle");
      await lateViewerSeesEnded(contextId);
      // The bot's page is gone: its next call on it answers no_context.
      expect((await l.browser("snapshot", ev)).status).toBe(404);
    } finally {
      sam.close();
      alex.close();
      victor.close();
    }
  });

  it("the controller's socket closes after input (tab closed): the page closes, nobody gets a frame after", async () => {
    const { contextId, sam, alex } = await pageWithViewers();
    try {
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      await T.waitState(alex, "private");
      typeSomething(sam);
      await T.waitFor(() => (fakeContext(contextId)?.inputs.text ?? 0) >= 1);
      const alexAt = alex.binary.length;
      sam.close();
      expect(await T.waitState(alex, "ended")).toMatchObject({ endReason: ABANDONED });
      await noFrameAfterEnd(alex);
      expect(alex.binary.length).toBe(alexAt);
      expect(await contextRow(contextId)).toMatchObject({ end_reason: ABANDONED });
      await T.waitFor(() => !fakeContext(contextId));
      await expectAbandonedAudit(contextId, "closed");
      await lateViewerSeesEnded(contextId);
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("a dead instance's lease after input: the browser sweep closes the page (nobody watching) instead of handing it back", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const { agent_id: agentId } = (
      await l.s.su.query("select agent_id from app.browser_contexts where id = $1", [contextId])
    ).rows[0] as Json;
    // The holding instance died after Sam's input reached the page: the row still names Sam and records the input.
    await l.s.su.query(
      "update app.browser_contexts set controller_user_id = $2, lease_expires_at = now() + interval '1 minute', lease_input = true where id = $1",
      [contextId, l.s.samId],
    );
    await l.s.stack.built.sandbox.client?.call(
      "contextTakeover",
      { target: { orgId: l.s.orgA, agentId }, contextId, active: true },
      { timeoutMs: 5_000 },
    );
    const cleared = await l.s.stack.built.browser.sweeper.runOnce(Date.now() + 3 * 60_000);
    expect(cleared.leases).toBe(1);
    expect(await contextRow(contextId)).toMatchObject({
      end_reason: ABANDONED,
      controller_user_id: null,
      lease_expires_at: null,
    });
    await T.waitFor(() => !fakeContext(contextId));
    await expectAbandonedAudit(contextId, "idle");
    expect((await l.browser("snapshot", ev)).status).toBe(404);
  });

  it("a dead instance's lease after input, noticed by a live view on another instance: closed, never shown", async () => {
    const { contextId, sam, alex } = await pageWithViewers();
    sam.close();
    try {
      await T.waitFor(() => alex.binary.length >= 2);
      // Sam's lease, held through an instance that died, expired: the row records his input.
      await l.s.su.query(
        "update app.browser_contexts set controller_user_id = $2, lease_expires_at = now() - interval '1 second', lease_input = true where id = $1",
        [contextId, l.s.samId],
      );
      expect(await T.waitState(alex, "ended")).toMatchObject({ endReason: ABANDONED });
      await noFrameAfterEnd(alex);
      await T.waitFor(() => !fakeContext(contextId));
      await expectAbandonedAudit(contextId, "idle");
    } finally {
      alex.close();
    }
  });

  it("no input (Sam only looked and moved the pointer): the socket closes, the page stays and is public again", async () => {
    const { contextId, sam, alex } = await pageWithViewers();
    try {
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      await T.waitState(alex, "private");
      sam.send({ type: "mouse", event: "move", x: 50, y: 60, button: "none" });
      sam.send({ type: "wheel", x: 50, y: 60, dx: 0, dy: 120 });
      await T.waitFor(() => (fakeContext(contextId)?.inputs.wheel ?? 0) >= 1);
      const alexAt = alex.binary.length;
      sam.close();
      await T.waitState(alex, "live");
      await T.waitFor(() => alex.binary.length > alexAt + 1);
      expect(await contextRow(contextId)).toMatchObject({ closed_at: null, controller_user_id: null });
      expect(fakeContext(contextId)?.takeover).toBe(false);
      expect(
        (await auditOf("browser.closed", contextId)).filter((a) => a.metadata.reason === ABANDONED),
      ).toEqual([]);
    } finally {
      sam.close();
      alex.close();
    }
  });

  it("with Sam's session loaded, a lease that ends without a hand back closes the page even without input", async () => {
    const ev = await l.turnIn(l.s.sam);
    const contextId = await l.open(ev);
    const secret = (
      await l.s.su.query(
        "insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag) values ($1, $2, 'browser_session', 'x', 'x', 'x') returning id",
        [l.s.orgA, `browser-session-abandon-${contextId.slice(0, 8)}`],
      )
    ).rows[0].id as string;
    const session = (
      await l.s.su.query(
        `insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at)
         values ($1, $2, $3, 'panel.fake.test', $4, now() + interval '30 days')
         on conflict (organization_id, user_id, agent_id, site_key) do update set secret_id = excluded.secret_id
         returning id`,
        [l.s.orgA, l.s.samId, l.s.scoutId, secret],
      )
    ).rows[0].id as string;
    await l.s.su.query("update app.browser_contexts set session_id = $2 where id = $1", [contextId, session]);
    const sam = await T.liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    const other = await T.liveSocket(l.s.stack.baseUrl, await l.s.sam.token(), contextId);
    try {
      await T.waitFor(() => sam.binary.length >= 1);
      sam.send({ type: "take" });
      await T.waitState(sam, "controlling");
      await T.waitState(other, "private");
      sam.close();
      expect(await T.waitState(other, "ended")).toMatchObject({ endReason: ABANDONED });
      await noFrameAfterEnd(other);
      expect(await contextRow(contextId)).toMatchObject({ end_reason: ABANDONED });
      await expectAbandonedAudit(contextId, "closed");
    } finally {
      sam.close();
      other.close();
    }
  });
});
