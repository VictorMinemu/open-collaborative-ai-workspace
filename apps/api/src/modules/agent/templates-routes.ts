import {
  Agent,
  AgentTemplate,
  AgentTemplateLink,
  AgentTemplateList,
  AgentTemplateOptions,
  AgentTemplatePreview,
  ApplyAgentTemplateUpdateRequest,
  CreateAgentTemplateRequest,
  Id,
  IdParams,
  InstantiateAgentTemplateRequest,
  InstantiateAgentTemplateResponse,
  PublishAgentTemplateVersionRequest,
  UpdateAgentTemplateRequest,
} from "@ocw/contracts";
import { z } from "zod";
import { type App, type Core, tenant } from "../../core";
import { conflict } from "../../lib/errors";
import {
  applyTemplateUpdate,
  createTemplate,
  instantiateTemplate,
  listTemplates,
  previewTemplate,
  publishVersion,
  templateLinkFor,
  templateOptions,
  updateTemplate,
} from "./templates";

const tags = ["agent"];
const OptionsQuery = z.object({ unitId: Id.optional() });

/**
 * Agent template routes (07.4-08). Every route is a signed-in user's (`authz: user`) and decided by the resolver
 * inside the handler: `agent_template.manage` on the template's unit (or the organization) for authoring, template
 * visibility plus `bot.create_personal` (in `createPersonalBot`) for starting an agent.
 */
export function registerTemplateRoutes(app: App, core: Core, isUniqueViolation: (err: unknown) => boolean) {
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  app.get(
    "/agent-templates",
    { ...user, schema: { tags, response: { 200: AgentTemplateList } } },
    async (req) => core.db.withTenant(tenant(req), (tx) => listTemplates(core, req, tx)),
  );

  app.post(
    "/agent-templates",
    { ...user, schema: { tags, body: CreateAgentTemplateRequest, response: { 201: AgentTemplate } } },
    async (req, reply) => {
      const out = await core.db.withTenant(tenant(req), (tx) => createTemplate(core, req, tx, req.body));
      return reply.code(201).send(out);
    },
  );

  app.get(
    "/agent-templates/options",
    { ...user, schema: { tags, querystring: OptionsQuery, response: { 200: AgentTemplateOptions } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => templateOptions(core, req, tx, req.query.unitId));
    },
  );

  app.patch(
    "/agent-templates/:id",
    {
      ...user,
      schema: { tags, params: IdParams, body: UpdateAgentTemplateRequest, response: { 200: AgentTemplate } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => updateTemplate(core, req, tx, req.params.id, req.body)),
  );

  app.post(
    "/agent-templates/:id/versions",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: PublishAgentTemplateVersionRequest,
        response: { 200: AgentTemplate },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => publishVersion(core, req, tx, req.params.id, req.body)),
  );

  app.get(
    "/agent-templates/:id/preview",
    { ...user, schema: { tags, params: IdParams, response: { 200: AgentTemplatePreview } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => previewTemplate(core, req, tx, req.params.id));
    },
  );

  app.post(
    "/agent-templates/:id/instantiate",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: InstantiateAgentTemplateRequest,
        response: { 201: InstantiateAgentTemplateResponse },
      },
    },
    async (req, reply) => {
      try {
        const out = await core.db.withTenant(tenant(req), (tx) =>
          instantiateTemplate(core, req, tx, req.params.id, req.body ?? {}),
        );
        return reply.code(201).send(out);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
        throw err;
      }
    },
  );

  // Owner only (404 for anyone else): the template's name and versions, never another instance's content.
  app.get(
    "/agents/:id/template",
    { ...user, schema: { tags, params: IdParams, response: { 200: AgentTemplateLink } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => templateLinkFor(core, req, tx, req.params.id));
    },
  );

  // Owner only: overwrites the template-owned fields with the latest version (D-05).
  app.post(
    "/agents/:id/template/apply",
    {
      ...user,
      schema: { tags, params: IdParams, body: ApplyAgentTemplateUpdateRequest, response: { 200: Agent } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) =>
        applyTemplateUpdate(core, req, tx, req.params.id, req.body.toVersion),
      ),
  );
}
