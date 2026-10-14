import { z } from "zod";
import { Agent, ModelId, ModelProviderKind } from "./agent";
import { MAX_DAILY_LIMIT, ToolSourceKind } from "./bot-capabilities";
import { Id, IsoDateTime } from "./common";
import { ConnectionStatus } from "./connectors";

/**
 * Agent templates (Phase 07.4, D-05; CONN-06). A unit (or the organization) publishes immutable template versions;
 * a member starts a personal agent from one. The agent is a FORK: it records `templateId` and version, gets its own
 * memory and uses its owner's connections, and personal-agent caps apply when it is created (model, daily limit,
 * sources allowed for personal bots, unit keys the owner may `vault.use`). A newer version is an "update available"
 * notice the owner reviews and applies; template authors never change a private bot silently (ADR-0010).
 */

export const TEMPLATE_LIMITS = {
  nameChars: 80,
  descriptionChars: 500,
  instructionsChars: 20_000,
  toolGrants: 64,
  requiredConnectors: 16,
  unitVaultItems: 16,
} as const;

/** A tool the template grants: one tool of an MCP server or plugin source (`<safeName>__<tool>` at the source). */
export const AgentTemplateToolGrant = z.object({
  sourceKind: ToolSourceKind,
  sourceId: Id,
  toolName: z.string().min(1).max(128),
});
export type AgentTemplateToolGrant = z.infer<typeof AgentTemplateToolGrant>;

export const AgentTemplateCapabilities = z.object({
  internet: z.boolean(),
  memory: z.boolean(),
  /** null = the policy default; clamped by the personal-bot policy at instantiation. */
  dailyLimit: z.number().int().min(0).max(MAX_DAILY_LIMIT).nullable(),
});
export type AgentTemplateCapabilities = z.infer<typeof AgentTemplateCapabilities>;

/** What one version fixes (the same instruction bound as a bot's). */
export const AgentTemplateVersionBody = z.object({
  instructions: z.string().trim().min(1).max(TEMPLATE_LIMITS.instructionsChars),
  modelProvider: ModelProviderKind,
  modelId: ModelId,
  capabilities: AgentTemplateCapabilities,
  toolGrants: z.array(AgentTemplateToolGrant).max(TEMPLATE_LIMITS.toolGrants),
  /** Per-member connectors the agent needs; each member connects their own account. */
  requiredConnectorIds: z.array(Id).max(TEMPLATE_LIMITS.requiredConnectors),
  /** Unit keys granted to the agent when its owner may use them. */
  unitVaultItemIds: z.array(Id).max(TEMPLATE_LIMITS.unitVaultItems),
});
export type AgentTemplateVersionBody = z.infer<typeof AgentTemplateVersionBody>;

/** An immutable published version (editor line "v{n} · published {date} by {name}"). */
export const AgentTemplateVersion = AgentTemplateVersionBody.extend({
  templateId: Id,
  version: z.number().int().min(1),
  createdAt: IsoDateTime,
  createdBy: Id.nullable(),
  createdByName: z.string().nullable(),
});
export type AgentTemplateVersion = z.infer<typeof AgentTemplateVersion>;

const ConnectorRef = z.object({ serverId: Id, name: z.string() });
const ConnectorRefWithStatus = ConnectorRef.extend({ status: ConnectionStatus });

export const AgentTemplate = z.object({
  id: Id,
  /** null = an organization template. */
  unitId: Id.nullable(),
  unitName: z.string().nullable(),
  name: z.string().min(1).max(TEMPLATE_LIMITS.nameChars),
  description: z.string().max(TEMPLATE_LIMITS.descriptionChars),
  currentVersion: z.number().int().min(1),
  archivedAt: IsoDateTime.nullable(),
  latest: AgentTemplateVersion,
  /** The resolver's `agent_template.manage` decision on the template's unit. */
  canManage: z.boolean(),
  /** Names of the latest version's required connectors (card "Needs {names}"). */
  requiredConnectors: z.array(ConnectorRef),
});
export type AgentTemplate = z.infer<typeof AgentTemplate>;

/** `GET /api/v1/agent-templates`. */
export const AgentTemplateList = z.object({
  templates: z.array(AgentTemplate),
  /** Where the caller may publish templates (`unitId` null = the organization). */
  manageableUnits: z.array(z.object({ unitId: Id.nullable(), name: z.string() })),
});
export type AgentTemplateList = z.infer<typeof AgentTemplateList>;

const TemplateName = z.string().trim().min(1).max(TEMPLATE_LIMITS.nameChars);
const TemplateDescription = z.string().trim().max(TEMPLATE_LIMITS.descriptionChars);

/** `POST /api/v1/agent-templates`: the template and its version 1. */
export const CreateAgentTemplateRequest = z.object({
  unitId: Id.nullable(),
  name: TemplateName,
  description: TemplateDescription.default(""),
  version: AgentTemplateVersionBody,
});
export type CreateAgentTemplateRequest = z.infer<typeof CreateAgentTemplateRequest>;

/** `PATCH /api/v1/agent-templates/:id`: metadata only; a body change is a new version. */
export const UpdateAgentTemplateRequest = z.object({
  name: TemplateName.optional(),
  description: TemplateDescription.optional(),
  archived: z.boolean().optional(),
});
export type UpdateAgentTemplateRequest = z.infer<typeof UpdateAgentTemplateRequest>;

/** `POST /api/v1/agent-templates/:id/versions`: publishes the next version. */
export const PublishAgentTemplateVersionRequest = AgentTemplateVersionBody;
export type PublishAgentTemplateVersionRequest = z.infer<typeof PublishAgentTemplateVersionRequest>;

/** Something of the template the new agent does not get, and why (listed before and after starting). */
export const AgentTemplateSkip = z.object({
  kind: z.enum(["tool", "vault_item", "model", "capability"]),
  id: z.string().max(300),
  reason: z.enum(["not_personal_allowed", "vault_denied", "model_not_allowed", "clamped"]),
});
export type AgentTemplateSkip = z.infer<typeof AgentTemplateSkip>;

/** `GET /api/v1/agent-templates/:id/preview`: what the caller's agent would get. */
export const AgentTemplatePreview = z.object({
  skipped: z.array(AgentTemplateSkip),
  requiredConnectors: z.array(ConnectorRefWithStatus),
  /** The caller already has the maximum number of personal bots. */
  capReached: z.boolean(),
  limit: z.number().int().nonnegative(),
});
export type AgentTemplatePreview = z.infer<typeof AgentTemplatePreview>;

/** `POST /api/v1/agent-templates/:id/instantiate`. */
export const InstantiateAgentTemplateRequest = z.object({ name: TemplateName.optional() });
export type InstantiateAgentTemplateRequest = z.infer<typeof InstantiateAgentTemplateRequest>;

export const InstantiateAgentTemplateResponse = AgentTemplatePreview.extend({
  agent: Agent,
  dmConversationId: Id,
});
export type InstantiateAgentTemplateResponse = z.infer<typeof InstantiateAgentTemplateResponse>;

export const AgentTemplateChangedField = z.enum([
  "instructions",
  "model",
  "capabilities",
  "toolGrants",
  "requiredConnectors",
  "vaultItems",
]);
export type AgentTemplateChangedField = z.infer<typeof AgentTemplateChangedField>;

/** A newer version than the agent's, and what applying it would overwrite. */
export const AgentTemplateUpdate = z.object({
  from: z.number().int().min(1),
  to: z.number().int().min(1),
  changedFields: z.array(AgentTemplateChangedField),
});
export type AgentTemplateUpdate = z.infer<typeof AgentTemplateUpdate>;

/** `GET /api/v1/agents/:id/template`: the agent's template, its version and the owner's connections. */
export const AgentTemplateLink = z.object({
  templateId: Id,
  templateName: z.string(),
  version: z.number().int().min(1),
  latestVersion: z.number().int().min(1),
  update: AgentTemplateUpdate.nullable(),
  requiredConnectors: z.array(ConnectorRefWithStatus),
});
export type AgentTemplateLink = z.infer<typeof AgentTemplateLink>;

/** `POST /api/v1/agents/:id/template/apply`: overwrite the template-owned fields with `toVersion`. */
export const ApplyAgentTemplateUpdateRequest = z.object({ toVersion: z.number().int().min(1) });
export type ApplyAgentTemplateUpdateRequest = z.infer<typeof ApplyAgentTemplateUpdateRequest>;

/** `GET /api/v1/agent-templates/options?unitId=`: the editor's choices for one unit. */
export const AgentTemplateOptions = z.object({
  tools: z.array(
    z.object({
      sourceKind: ToolSourceKind,
      sourceId: Id,
      sourceName: z.string(),
      toolName: z.string(),
      personalAllowed: z.boolean(),
    }),
  ),
  connectors: z.array(ConnectorRef),
  vaultItems: z.array(z.object({ id: Id, name: z.string(), handle: z.string() })),
});
export type AgentTemplateOptions = z.infer<typeof AgentTemplateOptions>;
