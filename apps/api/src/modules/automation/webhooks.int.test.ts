import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { invite } from "../../testing-workzone";

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
