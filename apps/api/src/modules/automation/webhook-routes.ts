import {
  AUTOMATION_LIMITS,
  IdParams,
  RotateWebhookSecretResponse,
  type WebhookDelivery,
  WebhookEndpoint,
  type WebhookRejectReason,
} from "@ocw/contracts";
import { automationEvents, boardCards, messages, type Tx, webhookEndpoints } from "@ocw/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyError, FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError } from "../../lib/errors";
import { type AutomationActor, canWebhook } from "./access";
import type { AutomationSeamDeps } from "./actions";
import { newWebhookSecret, normalizePublicId, verifyStandardWebhook } from "./webhook-verify";
import { type EndpointRow, endpointOf, sealWebhookSecret, webhookSecretAad, webhookUrl } from "./webhooks";

const tags = ["automations"];
const HOUR_MS = 3_600_000;
/** `automation_events.external_id` holds at most this many characters (a longer `webhook-id` is refused). */
const EXTERNAL_ID_MAX = 998;
/** One rate-limit rejection recorded per endpoint and minute: a flood never becomes a flood of writes. */
const RATE_RECORD_MS = 60_000;
/**
 * Requests per sender address and minute across every webhook URL (07.6 review A LO-03): the per-URL limit alone let
 * one unauthenticated sender mint a fresh 60/min bucket per random id. Far above any real sender's need.
 */
const WEBHOOK_PER_IP_PER_MINUTE = 600;

const rateLimited = () => Object.assign(new Error("rate limited"), { statusCode: 429 });

const actorOf = (req: FastifyRequest): AutomationActor => ({ userId: authOf(req).userId, req });

/** Fixed answers: the sender never learns which check failed (T-07.6-10-05). */
const refused = () => new HttpError(401, "unauthorized", "The request isn't signed correctly");
const unknownHook = () => new HttpError(404, "not_found", "Not found");
const goneHook = () => new HttpError(410, "gone", "This webhook no longer exists");
const invalidPayload = () => new HttpError(400, "invalid_payload", "The body must be JSON");
const notAWebhook = () => new HttpError(404, "not_found", "This automation has no webhook");

interface Lookup {
  endpoint_id: string;
  organization_id: string;
  active: boolean;
}

/** `app.lookup_webhook_endpoint`: ids only, across organizations (the request carries no tenant yet). */
async function lookup(core: Core, publicId: string): Promise<Lookup | null> {
  const r = await core.db.pool.query<Lookup>(
    "select endpoint_id, organization_id, active from app.lookup_webhook_endpoint($1)",
    [publicId],
  );
  return r.rows[0] ?? null;
}

/** The secrets that verify now: the current one, and the previous one until its 24-hour grace ends. */
async function validSecrets(core: Core, tx: Tx, ep: EndpointRow, now = Date.now()): Promise<string[]> {
  const ids = [ep.secretId];
  if (ep.previousSecretId && ep.previousValidUntil && Date.parse(ep.previousValidUntil) > now) {
    ids.push(ep.previousSecretId);
  }
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    try {
      out.push(await core.secrets.revealSealed(tx, id, webhookSecretAad(ep.organizationId, ep.id)));
    } catch {
      // A missing row or a seal that does not open verifies nothing; no detail is logged.
    }
  }
  return out;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

const publicIdOf = (req: FastifyRequest) =>
  normalizePublicId(String((req.params as { publicId?: unknown }).publicId ?? "")) ?? "invalid";

/** Records the latest rejection on the endpoint (R4): the reason and the time, never a body or a header. */
async function recordRejection(core: Core, publicId: string, reason: WebhookRejectReason): Promise<void> {
  if (publicId === "invalid") return;
  try {
    if (reason === "rate_limited") {
      // The once-a-minute gate before any database work (07.6 review A LO-03): a flood of 429s costs one Redis
      // command each, not a query. Without Redis nothing is recorded (the rejection itself still holds).
      if (!core.bus.pub.isReady) return;
      const first = await core.bus.pub.set(`ocw:rl-rec:${publicId}`, "1", { PX: RATE_RECORD_MS, NX: true });
      if (first !== "OK") return;
    }
    const found = await lookup(core, publicId);
    if (!found?.active) return;
    await core.db.withTenant({ organizationId: found.organization_id }, (tx) =>
      markRejected(tx, found.endpoint_id, reason),
    );
  } catch (err) {
    core.log.warn({ code: (err as { code?: unknown }).code }, "webhook rejection could not be recorded");
  }
}

const markRejected = (tx: Tx, endpointId: string, reason: WebhookRejectReason) =>
  tx
    .update(webhookEndpoints)
    .set({ lastRejectedAt: sql`now()`, lastRejectedReason: reason })
    .where(eq(webhookEndpoints.id, endpointId));

type Outcome = { kind: "accepted" | "duplicate" | "gone" | "invalid" } | { kind: "rejected" };

/**
 * The public route (`authz: "public"`), checked in this order:
 *
 * 1. Rate limit, before anything else (`onRequest`): 600 a minute per sender address, and 60 a minute per URL,
 *    counted in Redis across replicas → 429.
 * 2. Body size while it is read (raw bytes, any content type): over 64 KiB → 413.
 * 3. The public id: malformed or unknown → 404; tombstoned or unlinked → 410.
 * 4. In the endpoint's organization: the signature over the exact bytes with the current secret, then the previous one
 *    during its grace, and the ±5-minute timestamp (`standardwebhooks`) → 401, the reason recorded on the endpoint.
 * 5. A verified body that is not JSON, or a `webhook-id` over 998 characters → 400.
 * 6. Insert the event on (endpoint, `webhook-id`): a repeat bumps `duplicate_count` → 200; a new one is `accepted`, its
 *    `automation.inbound` job and its `webhook.received` audit row commit with it → 202. Paused, the hourly cap and
 *    access are decided by the inbound worker (21), which records `not_run` with the reason.
 *
 * Bodies and header values never reach a log, an audit row, an error or a job (ids only).
 */
async function publicHooks(raw: unknown, core: Core): Promise<void> {
  const scope = raw as App;
  // The exact bytes, whatever the content type: the signature is over them, and JSON is parsed only once verified.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  scope.setErrorHandler(async (err: FastifyError, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status === 413) {
      await recordRejection(core, publicIdOf(req), "too_large");
      return reply
        .status(413)
        .send({ error: { code: "payload_too_large", message: "The body is over 64 KB" } });
    }
    if (status === 429) {
      await recordRejection(core, publicIdOf(req), "rate_limited");
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests" } });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (status < 500)
      return reply.status(status).send({ error: { code: "bad_request", message: "Bad request" } });
    // Only the error code: a database error's detail can quote the failing row.
    req.log.error({ code: (err as { code?: unknown }).code }, "webhook delivery failed");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
  });

  // A coarse limit per sender address in front of the per-URL one (LO-03). `createRateLimit`, not `rateLimit()`: the
  // plugin runs one `rateLimit` hook per request, so a second hook would silently skip the per-URL limit.
  const senderLimit = scope.createRateLimit({
    max: WEBHOOK_PER_IP_PER_MINUTE,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest) => `hook-ip:${req.ip}`,
  });
  const perSender = async (req: FastifyRequest) => {
    const verdict = await senderLimit(req);
    if (!verdict.isAllowed && verdict.isExceeded) throw rateLimited();
  };

  scope.post(
    "/hooks/:publicId",
    {
      bodyLimit: AUTOMATION_LIMITS.webhookBodyMaxBytes,
      onRequest: perSender,
      config: {
        authz: "public",
        rateLimit: {
          max: AUTOMATION_LIMITS.webhookPerMinute,
          timeWindow: 60_000,
          keyGenerator: (req: FastifyRequest) => `hook:${publicIdOf(req)}`,
          errorResponseBuilder: rateLimited,
        },
      },
      schema: { tags, params: z.object({ publicId: z.string().max(64) }) },
    },
    async (req, reply) => {
      const publicId = normalizePublicId(req.params.publicId);
      if (!publicId) throw unknownHook();
      const found = await lookup(core, publicId);
      if (!found) throw unknownHook();
      if (!found.active) throw goneHook();
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = {
        "webhook-id": header(req, "webhook-id"),
        "webhook-timestamp": header(req, "webhook-timestamp"),
        "webhook-signature": header(req, "webhook-signature"),
      };
      const outcome = await core.db.withTenant(
        { organizationId: found.organization_id },
        async (tx): Promise<Outcome> => {
          const [ep] = await tx
            .select()
            .from(webhookEndpoints)
            .where(eq(webhookEndpoints.id, found.endpoint_id));
          if (!ep || ep.deletedAt !== null || ep.automationId === null) return { kind: "gone" };
          const verified = verifyStandardWebhook(body, headers, await validSecrets(core, tx, ep));
          if (!verified.ok) {
            await markRejected(tx, ep.id, verified.reason);
            return { kind: "rejected" };
          }
          // jsonb refuses U+0000; such a body (or an oversized id) is the sender's mistake, not a server error.
          if (
            verified.payload === undefined ||
            verified.id.length > EXTERNAL_ID_MAX ||
            body.includes("\\u0000")
          ) {
            return { kind: "invalid" };
          }
          const [event] = await tx
            .insert(automationEvents)
            .values({
              organizationId: ep.organizationId,
              source: "webhook",
              webhookEndpointId: ep.id,
              externalId: verified.id,
              bodyJson: verified.payload,
              result: "accepted",
            })
            .onConflictDoUpdate({
              target: [automationEvents.webhookEndpointId, automationEvents.externalId],
              set: {
                duplicateCount: sql`${automationEvents.duplicateCount} + 1`,
                lastDuplicateAt: sql`now()`,
              },
            })
            .returning({ id: automationEvents.id, inserted: sql<boolean>`(xmax = 0)` });
          if (!event) throw new Error("webhook event insert failed");
          if (!event.inserted) return { kind: "duplicate" };
          await core.jobs.sendInTx(tx, "automation.inbound", {
            organizationId: ep.organizationId,
            eventId: event.id,
          });
          await core.audit.record(tx, {
            action: "webhook.received",
            resourceType: "webhook_endpoint",
            resourceId: ep.id,
            metadata: {
              result: "accepted",
              endpointId: ep.id,
              automationId: ep.automationId,
              eventId: event.id,
            },
          });
          return { kind: "accepted" };
        },
      );
      switch (outcome.kind) {
        case "gone":
          throw goneHook();
        case "rejected":
          throw refused();
        case "invalid":
          throw invalidPayload();
        case "duplicate":
          return reply.status(200).send({ status: "duplicate" });
        default:
          return reply.status(202).send({ status: "accepted" });
      }
    },
  );
}

/** The last 10 deliveries (accepted or not run, and each event's latest duplicate) with a link to the post. */
async function deliveriesOf(tx: Tx, endpointId: string): Promise<WebhookDelivery[]> {
  const rows = await tx
    .select({
      id: automationEvents.id,
      receivedAt: automationEvents.receivedAt,
      result: automationEvents.result,
      reason: automationEvents.reason,
      duplicateCount: automationEvents.duplicateCount,
      lastDuplicateAt: automationEvents.lastDuplicateAt,
      messageId: automationEvents.messageId,
      boardCardMessageId: automationEvents.boardCardMessageId,
      conversationId: messages.conversationId,
      threadId: messages.threadId,
      cardNumber: boardCards.number,
      cardConversationId: boardCards.conversationId,
    })
    .from(automationEvents)
    .leftJoin(messages, eq(messages.id, automationEvents.messageId))
    .leftJoin(boardCards, eq(boardCards.messageId, automationEvents.boardCardMessageId))
    .where(eq(automationEvents.webhookEndpointId, endpointId))
    .orderBy(desc(automationEvents.receivedAt), desc(automationEvents.id))
    .limit(10);
  const out: WebhookDelivery[] = [];
  for (const r of rows) {
    const link =
      r.boardCardMessageId && r.cardConversationId
        ? {
            conversationId: r.cardConversationId,
            messageId: r.boardCardMessageId,
            threadRootId: null,
            cardNumber: r.cardNumber === null ? null : String(r.cardNumber),
          }
        : r.messageId && r.conversationId
          ? {
              conversationId: r.conversationId,
              messageId: r.messageId,
              threadRootId: r.threadId,
              cardNumber: null,
            }
          : null;
    const base = { id: r.id, reason: r.reason, duplicateCount: r.duplicateCount, link };
    out.push({ ...base, receivedAt: new Date(r.receivedAt).toISOString(), result: r.result });
    if (r.duplicateCount > 0 && r.lastDuplicateAt) {
      out.push({
        ...base,
        reason: null,
        receivedAt: new Date(r.lastDuplicateAt).toISOString(),
        result: "duplicate",
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, 10);
}

/** The latest accepted payload still holding its content (owner only, to pick pointers from). */
async function lastPayloadOf(tx: Tx, endpointId: string): Promise<unknown> {
  const [r] = await tx
    .select({ body: automationEvents.bodyJson })
    .from(automationEvents)
    .where(and(eq(automationEvents.webhookEndpointId, endpointId), isNull(automationEvents.contentPurgedAt)))
    .orderBy(desc(automationEvents.receivedAt), desc(automationEvents.id))
    .limit(1);
  return r?.body ?? null;
}

const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

/**
 * The webhook routes (07.6-10; D-02, D-07, R3, R4, P-10): the public `POST /hooks/:publicId` in its own encapsulated
 * scope (raw body parser, 64 KiB, Redis-counted rate limit, fixed error bodies), then the endpoint panel's
 * `GET /automations/:id/webhook` (owner or `automation.manage`) and `POST /automations/:id/webhook/rotate` (owner with
 * `automation.webhook`). The secret appears only in the create, update and rotate responses.
 */
export function registerWebhookRoutes(app: App, core: Core, deps: AutomationSeamDeps): void {
  app.register(async (scope) => publicHooks(scope, core));

  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  app.get(
    "/automations/:id/webhook",
    { ...user, schema: { tags, params: IdParams, response: { 200: WebhookEndpoint } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const actor = actorOf(req);
        const automation = await deps.service.get(tx, actor, req.params.id);
        if (automation.trigger.kind !== "webhook") throw notAWebhook();
        const ep = await endpointOf(tx, automation.id);
        if (!ep) throw notAWebhook();
        const graceOpen = ep.previousValidUntil !== null && Date.parse(ep.previousValidUntil) > Date.now();
        return {
          publicId: ep.publicId,
          url: webhookUrl(core, ep.publicId),
          secretSetAt: new Date(ep.secretSetAt).toISOString(),
          previousValidUntil: graceOpen ? iso(ep.previousValidUntil) : null,
          lastRejectedAt: iso(ep.lastRejectedAt),
          lastRejectedReason: ep.lastRejectedReason,
          deliveries: await deliveriesOf(tx, ep.id),
          // Untrusted outside content: only the owner, who chose the sender, sees it (rendered as text).
          lastPayload: automation.runAs.id === actor.userId ? await lastPayloadOf(tx, ep.id) : null,
        };
      });
    },
  );

  app.post(
    "/automations/:id/webhook/rotate",
    { ...user, schema: { tags, params: IdParams, response: { 200: RotateWebhookSecretResponse } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const actor = actorOf(req);
        const automation = await deps.service.get(tx, actor, req.params.id);
        if (automation.runAs.id !== actor.userId) {
          throw new HttpError(403, "not_allowed", "Only the automation's owner can rotate its secret.");
        }
        if (!(await canWebhook(deps.perms, tx, actor))) {
          throw new HttpError(403, "webhook_not_allowed", "Only team leads and admins can create webhooks.");
        }
        if (automation.trigger.kind !== "webhook") throw notAWebhook();
        const ep = await endpointOf(tx, automation.id, true);
        if (!ep) throw notAWebhook();
        // One previous secret at a time: a second rotation inside the grace retires the oldest now.
        if (ep.previousSecretId) await core.secrets.remove(tx, ep.previousSecretId);
        const secret = newWebhookSecret();
        const secretId = await sealWebhookSecret(core, tx, ep.id, secret);
        const previousValidUntil = new Date(
          Date.now() + AUTOMATION_LIMITS.secretGraceHours * HOUR_MS,
        ).toISOString();
        await tx
          .update(webhookEndpoints)
          .set({
            secretId,
            previousSecretId: ep.secretId,
            previousValidUntil: ep.secretId ? previousValidUntil : null,
            secretSetAt: sql`now()`,
          })
          .where(eq(webhookEndpoints.id, ep.id));
        await core.audit.record(tx, {
          action: "webhook_endpoint.secret_rotated",
          resourceType: "webhook_endpoint",
          resourceId: ep.id,
          metadata: { endpointId: ep.id, automationId: automation.id },
        });
        await deps.service.announce(tx, { id: automation.id, runAsUserId: automation.runAs.id });
        return { secret, previousValidUntil };
      }),
  );
}
