import {
  Automation,
  AutomationList,
  AutomationListQuery,
  CreateAutomationRequest,
  CreateAutomationResponse,
  IdParams,
  SchedulePreviewRequest,
  SchedulePreviewResponse,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError } from "../../lib/errors";
import type { PermissionService } from "../organization";
import { type AutomationActor, canCreate } from "./access";
import type { AutomationService } from "./service";

const tags = ["automations"];

const actorOf = (req: FastifyRequest): AutomationActor => ({ userId: authOf(req).userId, req });

/**
 * REST of automations (`/api/v1`, `authz: "user"`): every handler opens the caller's tenant transaction and lets the
 * service decide through the resolver (the strict authz guard sees each decision on the request).
 */
export function registerAutomationRoutes(
  app: App,
  core: Core,
  service: AutomationService,
  perms: PermissionService,
) {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  app.get(
    "/automations",
    { ...user, schema: { tags, querystring: AutomationListQuery, response: { 200: AutomationList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => service.list(tx, actorOf(req), req.query));
    },
  );

  app.post(
    "/automations",
    {
      ...user,
      schema: { tags, body: CreateAutomationRequest, response: { 201: CreateAutomationResponse } },
    },
    async (req, reply) => {
      const created = await core.db.withTenant(tenant(req), (tx) =>
        service.create(tx, actorOf(req), req.body),
      );
      return reply.code(201).send(created);
    },
  );

  // The preview is the save's own schedule check (R13); creating rights decide who may ask.
  app.post(
    "/automations/schedule-preview",
    {
      ...user,
      schema: { tags, body: SchedulePreviewRequest, response: { 200: SchedulePreviewResponse } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        if (!(await canCreate(perms, tx, actorOf(req)))) {
          throw new HttpError(403, "not_allowed", "You can't create automations. Ask an admin.");
        }
        return service.preview(tx, req.body);
      }),
  );

  app.get(
    "/automations/:id",
    { ...user, schema: { tags, params: IdParams, response: { 200: Automation } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => service.get(tx, actorOf(req), req.params.id));
    },
  );
}
