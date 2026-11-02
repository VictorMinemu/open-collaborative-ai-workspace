import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { invite } from "../../testing-workzone";
import { newPublicId } from "./webhook-verify";

/**
 * 07.6-10 (AUTO-02; D-02, D-07, R3, R4, P-10; Pitfall 4): signed webhooks as an automation trigger. Ana Díaz (lead,
 * `automation.webhook`) creates the "Shopify orders" automation; its endpoint is an unguessable URL plus a `whsec_`
 * secret shown once and sealed in the secret store. The public route verifies Standard Webhooks signatures over the
 * exact bytes (±5 min), is idempotent by `webhook-id`, bounded (64 KiB, 60/min per URL counted in Redis) and answers
 * 410 once the automation is gone; an accepted request becomes an event and an `automation.inbound` job (21) in one
 * transaction. Real PostgreSQL + Redis + pg-boss and the in-memory sandboxd. Organization A: Víctor Ruiz (admin,
 * `automation.manage`), Ana Díaz (lead), Sam Lee (standard); the team bot Scout is a member of #orders.
 */

let s: SandboxStack;
let ana: TestClient;
let anaId: string;
let ordersId: string;

const core = () => s.stack.built.core;
const drainInbound = () => core().jobs.drain("automation.inbound", { max: 200 });
const drainFire = () => core().jobs.drain("automation.fire", { max: 200 });

const ORDER = { order: { id: 450789, name: "#1001", note: "Deliver before noon" } };

/** Ana's webhook automation through 05's REST resource; the secret is in the create response only. */
async function createHook(extra: Json = {}): Promise<{ id: string; secret: string; publicId: string }> {
  const created = (await ok(
    ana.request("POST", "/api/v1/automations", {
      name: "Shopify orders",
      agentId: s.scoutId,
      instructions: "Read each order and flag the risky ones.",
      trigger: { kind: "webhook" },
      target: { kind: "channel", conversationId: ordersId },
      inbound: {
        action: "post",
        askBot: true,
        config: { titlePointer: "/order/name", threadKeyPointer: "/order/id" },
      },
      ...extra,
    }) as Promise<Res>,
    201,
  )) as Json;
  return {
    id: created.automation.id as string,
    secret: created.webhookSecret as string,
    publicId: created.automation.trigger.webhook.publicId as string,
  };
}

/** A Standard Webhooks request signed by the `standardwebhooks` library, as another app sends it. */
function signedHeaders(secret: string, body: string, opts: { id?: string; at?: Date } = {}) {
  const at = opts.at ?? new Date();
  const id = opts.id ?? `msg_${randomUUID()}`;
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(id, at, body),
  };
}

async function post(publicId: string, body: string, headers: Record<string, string>) {
  const res = await fetch(`${s.stack.baseUrl}/api/v1/hooks/${publicId}`, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const send = (hook: { secret: string; publicId: string }, payload: unknown = ORDER, id?: string) => {
  const body = JSON.stringify(payload);
  return post(hook.publicId, body, signedHeaders(hook.secret, body, id ? { id } : {}));
};

const endpointRow = async (publicId: string) =>
  (await s.su.query("select * from app.webhook_endpoints where public_id = $1", [publicId])).rows[0] as Json;

const eventsOf = async (endpointId: string) =>
  (
    await s.su.query(
      "select * from app.automation_events where webhook_endpoint_id = $1 order by received_at, id",
      [endpointId],
    )
  ).rows as Json[];

const inboundJobs = async (eventId: string) =>
  Number(
    (
      await s.su.query(
        "select count(*)::int as n from pgboss.job where name = 'automation.inbound' and data->>'eventId' = $1",
        [eventId],
      )
    ).rows[0].n,
  );

const allInboundJobs = async () =>
  Number(
    (await s.su.query("select count(*)::int as n from pgboss.job where name = 'automation.inbound'")).rows[0]
      .n,
  );

const audits = async (action: string, resourceId: string) =>
  (
    await s.su.query(
      "select actor_kind, user_id, result, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Json[];

const runsOf = async (automationId: string) =>
  (
    await s.su.query("select * from app.automation_runs where automation_id = $1 order by created_at, id", [
      automationId,
    ])
  ).rows as Json[];

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
  // Ana owns many webhook automations across this file.
  await s.su.query(
    `insert into app.bot_policies (organization_id, max_automations_per_user) values ($1, 1000)
     on conflict (organization_id) do update set max_automations_per_user = 1000`,
    [s.orgA],
  );
  ({ client: ana, userId: anaId } = await invite(s.stack, s.victor, "ana@example.test", "Ana Díaz", "lead"));
  ordersId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", { name: "orders", visibility: "private" }) as Promise<Res>,
    )
  ).id as string;
  for (const member of [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: anaId },
    { kind: "user", id: s.samId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${ordersId}/members`, member) as Promise<Res>);
  }
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("Ana's Shopify orders webhook: a signed POST becomes a card in #orders and a read-only turn (tracer)", () => {
  it("create → endpoint + secret once → signed request → event → inbound → card → tainted run", async () => {
    const hook = await createHook();
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32,120}$/);
    expect(hook.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The secret is in the create response only: never in the automation or the endpoint DTO.
    const automation = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}`) as Promise<Res>,
    )) as Json;
    expect(automation.trigger.webhook).toEqual({
      publicId: hook.publicId,
      url: `${s.stack.env.OCW_PUBLIC_API_URL}/api/v1/hooks/${hook.publicId}`,
    });
    const endpoint = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(endpoint).toMatchObject({
      publicId: hook.publicId,
      url: `${s.stack.env.OCW_PUBLIC_API_URL}/api/v1/hooks/${hook.publicId}`,
      previousValidUntil: null,
      lastRejectedAt: null,
      lastRejectedReason: null,
      deliveries: [],
      lastPayload: null,
    });
    expect(Date.parse(endpoint.secretSetAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(automation)).not.toContain(hook.secret);
    expect(JSON.stringify(endpoint)).not.toContain(hook.secret);

    // Sealed in the secret store as `webhook_secret`; no column holds the value.
    const row = await endpointRow(hook.publicId);
    expect(row.automation_id).toBe(hook.id);
    const secret = (await s.su.query("select * from app.secrets where id = $1", [row.secret_id]))
      .rows[0] as Json;
    expect(secret.kind).toBe("webhook_secret");
    const secretBase64 = hook.secret.slice("whsec_".length);
    expect(JSON.stringify(secret)).not.toContain(secretBase64);
    expect(await audits("webhook_endpoint.created", row.id)).toEqual([
      {
        actor_kind: "user",
        user_id: anaId,
        result: "success",
        metadata: { endpointId: row.id, automationId: hook.id },
      },
    ]);

    // Another app sends a signed order.
    const res = await send(hook, ORDER, "msg_1");
    expect(res.status).toBe(202);
    const [event] = (await eventsOf(row.id)) as [Json];
    expect(event).toMatchObject({
      source: "webhook",
      external_id: "msg_1",
      result: "accepted",
      body_json: ORDER,
      thread_key: null,
      duplicate_count: 0,
    });
    expect(await inboundJobs(event.id)).toBe(1);
    expect(await audits("webhook.received", row.id)).toEqual([
      {
        actor_kind: "system",
        user_id: null,
        result: "success",
        metadata: { result: "accepted", endpointId: row.id, automationId: hook.id, eventId: event.id },
      },
    ]);

    // 21 posts the Received card in #orders and queues Scout's tainted turn.
    expect(await drainInbound()).toBeGreaterThanOrEqual(1);
    const handled = (await eventsOf(row.id))[0] as Json;
    expect(handled.message_id).toBeTruthy();
    const card = (
      await s.su.query("select title, status_label from app.message_cards where message_id = $1", [
        handled.message_id,
      ])
    ).rows[0] as Json;
    expect(card).toEqual({ title: "#1001", status_label: "Received" });
    const message = (
      await s.su.query("select conversation_id, author_kind, author_id from app.messages where id = $1", [
        handled.message_id,
      ])
    ).rows[0] as Json;
    expect(message).toEqual({ conversation_id: ordersId, author_kind: "agent", author_id: s.scoutId });
    const [run] = (await runsOf(hook.id)) as [Json];
    expect(run).toMatchObject({ trigger: "webhook", tainted: true, inbound_event_id: event.id });
    expect(await drainFire()).toBeGreaterThanOrEqual(1);
    expect(((await runsOf(hook.id))[0] as Json).status).toBe("delivered");

    // The owner sees the delivery and the payload to pick pointers from.
    const after = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(after.deliveries).toEqual([
      {
        id: event.id,
        receivedAt: new Date(event.received_at).toISOString(),
        result: "accepted",
        reason: null,
        duplicateCount: 0,
        link: {
          conversationId: ordersId,
          messageId: handled.message_id,
          threadRootId: null,
          cardNumber: null,
        },
      },
    ]);
    expect(after.lastPayload).toEqual(ORDER);
  });
});

// ---------------------------------------------------------------- Task 2: forgery and replay

const REFUSED = { error: { code: "unauthorized", message: "The request isn't signed correctly" } };

describe("forgery and replay fail (Task 2, D-02, D-07, Pitfall 4)", () => {
  it("a wrong signature answers 401 with a fixed body, records `signature` and leaves no event or job", async () => {
    const hook = await createHook({ name: "Forged orders" });
    const row = await endpointRow(hook.publicId);
    const body = JSON.stringify(ORDER);
    const forged = signedHeaders(`whsec_${Buffer.alloc(32, 1).toString("base64")}`, body);
    const jobsBefore = await allInboundJobs();
    const res = await post(hook.publicId, body, forged);
    expect(res).toEqual({ status: 401, body: REFUSED });
    const after = await endpointRow(hook.publicId);
    expect(after.last_rejected_reason).toBe("signature");
    expect(Date.parse(after.last_rejected_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(await eventsOf(row.id)).toEqual([]);
    expect(await allInboundJobs()).toBe(jobsBefore);

    // A tampered body under a signature made for the original is the same 401.
    const headers = signedHeaders(hook.secret, body);
    expect(await post(hook.publicId, body.replace("#1001", "#1002"), headers)).toEqual({
      status: 401,
      body: REFUSED,
    });
    // Missing headers too.
    expect(await post(hook.publicId, body, { "content-type": "application/json" })).toEqual({
      status: 401,
      body: REFUSED,
    });
    expect(await eventsOf(row.id)).toEqual([]);

    // The owner sees why; the sender never does.
    const endpoint = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(endpoint.lastRejectedReason).toBe("signature");
    expect(endpoint.deliveries).toEqual([]);
  });

  it("an old or a future timestamp answers the same 401 and records `timestamp`", async () => {
    const hook = await createHook({ name: "Late orders" });
    const row = await endpointRow(hook.publicId);
    const body = JSON.stringify(ORDER);
    for (const offset of [-301_000, 301_000]) {
      const res = await post(
        hook.publicId,
        body,
        signedHeaders(hook.secret, body, { at: new Date(Date.now() + offset) }),
      );
      expect(res).toEqual({ status: 401, body: REFUSED });
      expect((await endpointRow(hook.publicId)).last_rejected_reason).toBe("timestamp");
    }
    expect(await eventsOf(row.id)).toEqual([]);
    // Within the window it is accepted.
    const fresh = await post(
      hook.publicId,
      body,
      signedHeaders(hook.secret, body, { at: new Date(Date.now() - 240_000) }),
    );
    expect(fresh.status).toBe(202);
  });

  it("a header with two signatures where the second is valid is accepted", async () => {
    const hook = await createHook({ name: "Multi-signature orders" });
    const body = JSON.stringify(ORDER);
    const headers = signedHeaders(hook.secret, body);
    const other = new Webhook(`whsec_${Buffer.alloc(32, 2).toString("base64")}`).sign(
      headers["webhook-id"],
      new Date(Number(headers["webhook-timestamp"]) * 1000),
      body,
    );
    headers["webhook-signature"] = `${other} ${headers["webhook-signature"]}`;
    expect((await post(hook.publicId, body, headers)).status).toBe(202);
  });

  it("the same webhook-id twice: 202 then 200, one event with duplicate_count 1 and one job; another URL accepts it", async () => {
    const hook = await createHook({ name: "Replayed orders" });
    const row = await endpointRow(hook.publicId);
    const id = `msg_${randomUUID()}`;
    expect(await send(hook, ORDER, id)).toEqual({ status: 202, body: { status: "accepted" } });
    expect(await send(hook, ORDER, id)).toEqual({ status: 200, body: { status: "duplicate" } });
    const events = await eventsOf(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ external_id: id, duplicate_count: 1 });
    expect(events[0]?.last_duplicate_at).toBeTruthy();
    expect(await inboundJobs(events[0]?.id)).toBe(1);

    const endpoint = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(endpoint.deliveries.map((d: Json) => [d.result, d.duplicateCount])).toEqual([
      ["duplicate", 1],
      ["accepted", 1],
    ]);

    const second = await createHook({ name: "Replayed orders (copy)" });
    expect((await send(second, ORDER, id)).status).toBe(202);
    expect(await eventsOf((await endpointRow(second.publicId)).id)).toHaveLength(1);
  });

  it("a signed body with a lone surrogate answers 400, never a 500 the sender retries forever; a 64-bit id is kept exact (07.6 review A LO-04)", async () => {
    const hook = await createHook({ name: "Odd orders" });
    const row = await endpointRow(hook.publicId);
    const lone = '{"order":{"note":"\\ud800"}}';
    const refused = await post(hook.publicId, lone, signedHeaders(hook.secret, lone));
    expect(refused).toEqual({
      status: 400,
      body: { error: { code: "invalid_payload", message: "The body must be JSON" } },
    });
    const big = '{"order":{"id":9007199254740993}}';
    expect((await post(hook.publicId, big, signedHeaders(hook.secret, big))).status).toBe(202);
    const events = await eventsOf(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.body_json).toEqual({ order: { id: "9007199254740993" } });
  });

  it("rotation issues a new secret once and keeps the previous one valid for 24 hours", async () => {
    const hook = await createHook({ name: "Rotated orders" });
    const row = await endpointRow(hook.publicId);
    const before = Date.now();
    const rotated = (await ok(
      ana.request("POST", `/api/v1/automations/${hook.id}/webhook/rotate`) as Promise<Res>,
    )) as Json;
    expect(rotated.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32,120}$/);
    expect(rotated.secret).not.toBe(hook.secret);
    const until = Date.parse(rotated.previousValidUntil);
    expect(until).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 5_000);
    expect(await audits("webhook_endpoint.secret_rotated", row.id)).toEqual([
      {
        actor_kind: "user",
        user_id: anaId,
        result: "success",
        metadata: { endpointId: row.id, automationId: hook.id },
      },
    ]);

    const rotatedRow = await endpointRow(hook.publicId);
    expect(rotatedRow.previous_secret_id).toBe(row.secret_id);
    expect(rotatedRow.secret_id).not.toBe(row.secret_id);
    const secretRow = (await s.su.query("select * from app.secrets where id = $1", [rotatedRow.secret_id]))
      .rows[0] as Json;
    expect(secretRow.kind).toBe("webhook_secret");
    expect(JSON.stringify(secretRow)).not.toContain(rotated.secret.slice("whsec_".length));

    const endpoint = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(endpoint.previousValidUntil).toBe(new Date(until).toISOString());
    expect(JSON.stringify(endpoint)).not.toContain(rotated.secret);

    // Both secrets verify during the grace.
    expect((await send(hook)).status).toBe(202);
    expect((await send({ ...hook, secret: rotated.secret })).status).toBe(202);

    // The clock passes the grace: only the new secret verifies.
    await s.su.query(
      "update app.webhook_endpoints set previous_valid_until = now() - interval '1 second' where id = $1",
      [row.id],
    );
    expect(await send(hook)).toEqual({ status: 401, body: REFUSED });
    expect((await send({ ...hook, secret: rotated.secret })).status).toBe(202);
    const expired = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(expired.previousValidUntil).toBeNull();
  });
});

// ---------------------------------------------------------------- Task 3: limits and lifecycle

describe("limits hold (Task 3, D-07, R4, T-07.6-10-03)", () => {
  it("a 70 KiB signed body answers 413 and records `too_large`", async () => {
    const hook = await createHook({ name: "Large orders" });
    const row = await endpointRow(hook.publicId);
    const body = JSON.stringify({ order: { name: "#1001", note: "x".repeat(70 * 1024) } });
    const res = await post(hook.publicId, body, signedHeaders(hook.secret, body));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: "payload_too_large", message: "The body is over 64 KB" } });
    expect((await endpointRow(hook.publicId)).last_rejected_reason).toBe("too_large");
    expect(await eventsOf(row.id)).toEqual([]);
  });

  it("the 61st request in a minute to one URL answers 429 across two API replicas; another URL is unaffected", async () => {
    const hook = await createHook({ name: "Busy orders" });
    const other = await createHook({ name: "Quiet orders" });
    // Paused: requests are still accepted (the inbound worker records `not_run`), so the 60 items stay cheap.
    await ok(ana.request("POST", `/api/v1/automations/${hook.id}/pause`) as Promise<Res>);
    // A second API replica on the same database and Redis.
    const replica = await buildApp(s.stack.env, { logger: false });
    try {
      await replica.app.ready();
      const viaReplica = async (payload: unknown) => {
        const body = JSON.stringify(payload);
        const res = await replica.app.inject({
          method: "POST",
          url: `/api/v1/hooks/${hook.publicId}`,
          headers: signedHeaders(hook.secret, body),
          payload: body,
        });
        return res.statusCode;
      };
      for (let i = 0; i < 40; i++) expect((await send(hook, { order: { id: i } })).status).toBe(202);
      for (let i = 40; i < 60; i++) expect(await viaReplica({ order: { id: i } })).toBe(202);
      expect(await viaReplica({ order: { id: 60 } })).toBe(429);
      const limited = await send(hook, { order: { id: 61 } });
      expect(limited).toEqual({
        status: 429,
        body: { error: { code: "rate_limited", message: "Too many requests" } },
      });
    } finally {
      await replica.close();
    }
    expect((await endpointRow(hook.publicId)).last_rejected_reason).toBe("rate_limited");
    expect(await eventsOf((await endpointRow(hook.publicId)).id)).toHaveLength(60);
    expect((await send(other)).status).toBe(202);

    // The counter lives in Redis under the route's namespace, with the one-minute window.
    const key = `ocw:rl:POST/api/v1/hooks/:publicId:hook:${hook.publicId}`;
    expect(await core().bus.pub.get(key)).toBe("62");
    const ttl = await core().bus.pub.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  /** One unsigned request from `ip` to a well-formed id (in-process, so each test has its own client address). */
  const knock = async (publicId: string, ip: string) =>
    (
      await s.stack.built.app.inject({
        method: "POST",
        url: `/api/v1/hooks/${publicId}`,
        headers: { "content-type": "application/json" },
        payload: "{}",
        remoteAddress: ip,
      })
    ).statusCode;
  const randomPublicId = () => newPublicId();

  it("a rate-limited flood costs no database query per rejected request (07.6 review A LO-03)", async () => {
    const id = randomPublicId();
    for (let i = 0; i < 60; i++) expect(await knock(id, "198.51.100.31")).toBe(404);
    const queries = vi.spyOn(core().db.pool, "query");
    try {
      for (let i = 0; i < 10; i++) expect(await knock(id, "198.51.100.31")).toBe(429);
      // At most the first rejection of the minute looks the id up; the other nine stop at Redis.
      expect(queries.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      queries.mockRestore();
    }
  });

  it("one sender minting random ids is limited per address: the 601st request in a minute answers 429 (LO-03)", async () => {
    for (let i = 0; i < 600; i++) expect(await knock(randomPublicId(), "198.51.100.32")).toBe(404);
    expect(await knock(randomPublicId(), "198.51.100.32")).toBe(429);
    // Another sender is unaffected.
    expect(await knock(randomPublicId(), "198.51.100.33")).toBe(404);
  }, 60_000);
});

describe("lifecycle and permissions (Task 3, R3, P-09, P-10)", () => {
  it("deleting the automation makes its URL answer 410 and removes its secrets; an unknown id is 404", async () => {
    const hook = await createHook({ name: "Short-lived orders" });
    const row = await endpointRow(hook.publicId);
    const rotated = await ok(
      ana.request("POST", `/api/v1/automations/${hook.id}/webhook/rotate`) as Promise<Res>,
    );
    expect(rotated.secret).toBeTruthy();
    const secretIds = [
      (await endpointRow(hook.publicId)).secret_id,
      (await endpointRow(hook.publicId)).previous_secret_id,
    ];
    const res = await ana.request("DELETE", `/api/v1/automations/${hook.id}`);
    expect(res.status).toBe(204);
    expect(await send(hook)).toEqual({
      status: 410,
      body: { error: { code: "gone", message: "This webhook no longer exists" } },
    });
    const tomb = await endpointRow(hook.publicId);
    expect(tomb).toMatchObject({ automation_id: null, secret_id: null, previous_secret_id: null });
    expect(tomb.deleted_at).toBeTruthy();
    expect(
      (await s.su.query("select id from app.secrets where id = any($1::uuid[])", [secretIds])).rows,
    ).toEqual([]);
    expect(await audits("webhook_endpoint.deleted", row.id)).toHaveLength(1);

    expect((await send({ ...hook, publicId: "7QK2M9XW4R7QK2M9XW4R7QK2M9" })).status).toBe(404);
    expect((await send({ ...hook, publicId: "not-a-hook" })).status).toBe(404);
  });

  it("changing the trigger to a schedule retires the old URL (410)", async () => {
    const hook = await createHook({ name: "Switched orders" });
    const current = await ok(ana.request("GET", `/api/v1/automations/${hook.id}`) as Promise<Res>);
    const updated = await ok(
      ana.request("PATCH", `/api/v1/automations/${hook.id}`, {
        expectedVersion: current.version,
        trigger: { kind: "schedule", schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" } },
        inbound: null,
      }) as Promise<Res>,
    );
    expect(updated.automation.trigger.webhook).toBeNull();
    expect((await send(hook)).status).toBe(410);
    await ok(ana.request("DELETE", `/api/v1/automations/${hook.id}`) as Promise<Res>, 204);
  });

  it("a paused automation still accepts (202); the inbound worker records `not_run`, `paused` and posts nothing", async () => {
    const hook = await createHook({ name: "Paused orders" });
    const row = await endpointRow(hook.publicId);
    await ok(ana.request("POST", `/api/v1/automations/${hook.id}/pause`) as Promise<Res>);
    expect((await send(hook)).status).toBe(202);
    expect(await drainInbound()).toBeGreaterThanOrEqual(1);
    const [event] = (await eventsOf(row.id)) as [Json];
    expect(event).toMatchObject({ result: "not_run", reason: "paused", message_id: null });
    const endpoint = (await ok(
      ana.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(endpoint.deliveries).toEqual([
      expect.objectContaining({ id: event.id, result: "not_run", reason: "paused", link: null }),
    ]);
  });

  it("Sam cannot create, read or rotate a webhook; Víctor (admin) reads it without the payload and cannot rotate", async () => {
    const created = await s.sam.request("POST", "/api/v1/automations", {
      name: "Sam's hook",
      agentId: s.scoutId,
      instructions: "Read each order.",
      trigger: { kind: "webhook" },
      target: { kind: "dm" },
      inbound: { action: "post", askBot: true, config: {} },
    });
    expect(created.status).toBe(403);
    expect(codeOf(created)).toBe("webhook_not_allowed");

    const hook = await createHook({ name: "Governed orders" });
    expect((await send(hook)).status).toBe(202);
    expect((await s.sam.request("GET", `/api/v1/automations/${hook.id}/webhook`)).status).toBe(404);
    expect((await s.sam.request("POST", `/api/v1/automations/${hook.id}/webhook/rotate`)).status).toBe(404);

    const managerView = (await ok(
      s.victor.request("GET", `/api/v1/automations/${hook.id}/webhook`) as Promise<Res>,
    )) as Json;
    expect(managerView.publicId).toBe(hook.publicId);
    expect(managerView.lastPayload).toBeNull();
    expect(managerView.deliveries).toHaveLength(1);
    expect(JSON.stringify(managerView)).not.toContain(hook.secret);
    const rotate = await s.victor.request("POST", `/api/v1/automations/${hook.id}/webhook/rotate`);
    expect(rotate.status).toBe(403);
    expect(codeOf(rotate)).toBe("not_allowed");
    // Eve (another organization) sees nothing.
    expect((await s.eve.request("GET", `/api/v1/automations/${hook.id}/webhook`)).status).toBe(404);
  });

  it("a canary in a body and a header never reaches the API logs, the audit rows or the job data", async () => {
    const CANARY = `canary-${randomUUID()}`;
    const hook = await createHook({ name: "Canary orders" });
    const body = JSON.stringify({ order: { name: CANARY, note: CANARY } });
    const headers = { ...signedHeaders(hook.secret, body), "x-canary": CANARY, "user-agent": CANARY };
    expect((await post(hook.publicId, body, headers)).status).toBe(202);
    // Rejected (bad signature), too large and repeated requests carry it too.
    expect((await post(hook.publicId, body, { ...headers, "webhook-signature": "v1,AAAA" })).status).toBe(
      401,
    );
    const big = JSON.stringify({ note: CANARY.repeat(3000) });
    expect(
      (await post(hook.publicId, big, { ...signedHeaders(hook.secret, big), "x-canary": CANARY })).status,
    ).toBe(413);
    expect((await post(hook.publicId, body, headers)).status).toBe(200);
    expect(await drainInbound()).toBeGreaterThanOrEqual(1);

    expect(s.logs.join("\n")).not.toContain(CANARY);
    const audit = await s.su.query(
      "select count(*)::int as n from app.audit_events where metadata::text like $1",
      [`%${CANARY}%`],
    );
    expect(audit.rows[0].n).toBe(0);
    const jobs = await s.su.query("select count(*)::int as n from pgboss.job where data::text like $1", [
      `%${CANARY}%`,
    ]);
    expect(jobs.rows[0].n).toBe(0);
  });
});
