import {
  DigestPreview,
  DigestPreviewRequest,
  DigestSettings,
  DigestTestResponse,
  DigestView,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import type { AutomationActor } from "../automation";
import type { DigestService } from "./index";

const tags = ["digest"];

/** The caller, with the request so every resolver decision is recorded on it (strict authz). */
const actorOf = (req: FastifyRequest): AutomationActor => ({ userId: authOf(req).userId, req });

/**
 * REST of the caller's own digest (`/api/v1`, `authz: "user"`, R6). Each handler opens the caller's tenant transaction;
 * the service decides `automation.create` through the resolver first (a digest is the person's own automation).
 * Reading returns the settings and the DM-able bots; saving creates or updates the one `digest` automation; the preview
 * composes unsaved settings now (stores nothing, sends nothing, no model); the test send posts the saved digest now.
 */
export function registerDigestRoutes(app: App, core: Core, digest: DigestService) {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  // A few test sends a minute per person (HI-01), counted after requireUser so the key is the person, not the IP.
  const testLimit = app.rateLimit({
    max: 3,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `digest-test:${req.auth?.userId ?? req.ip}`,
  });

  app.get("/digest", { ...user, schema: { tags, response: { 200: DigestView } } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return core.db.withTenant(tenant(req), (tx) => digest.view(tx, actorOf(req)));
  });

  app.put(
    "/digest",
    { ...user, schema: { tags, body: DigestSettings, response: { 200: DigestView } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => digest.save(tx, actorOf(req), req.body)),
  );

  app.post(
    "/digest/preview",
    { ...user, schema: { tags, body: DigestPreviewRequest, response: { 200: DigestPreview } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => digest.preview(tx, actorOf(req), req.body));
    },
  );

  app.post(
    "/digest/test",
    {
      ...user,
      preHandler: [core.identity.requireUser, testLimit],
      schema: { tags, response: { 200: DigestTestResponse } },
    },
    // The service opens its own short transactions: the summary's model call runs outside any of them.
    async (req) => digest.test(tenant(req), actorOf(req)),
  );
}
