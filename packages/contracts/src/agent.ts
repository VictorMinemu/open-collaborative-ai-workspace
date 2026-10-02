import { z } from "zod";
import { Id, IsoDateTime } from "./common";

export const AgentRuntime = z.enum(["openclaw"]);
export const AgentStatus = z.enum(["provisioning", "ready", "error", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ModelProviderKind = z.enum(["anthropic", "openai", "openrouter", "mock"]);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

export const AgentUsername = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase letters, digits, - and _");

export const Agent = z.object({
  id: Id,
  organizationId: Id,
  name: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string(),
  modelProvider: ModelProviderKind,
  modelId: z.string(),
  runtime: AgentRuntime,
  status: AgentStatus,
  statusMessage: z.string().nullable().optional(),
  createdBy: Id.nullable(),
  createdAt: IsoDateTime,
});
export type Agent = z.infer<typeof Agent>;

export const AgentList = z.object({ agents: z.array(Agent) });
export type AgentList = z.infer<typeof AgentList>;

export const CreateAgentRequest = z.object({
  name: z.string().trim().min(1).max(80),
  username: AgentUsername.optional(),
  /** Emoji or URL. */
  avatarUrl: z.string().trim().max(2048).optional(),
  description: z.string().trim().max(500).optional(),
  instructions: z.string().trim().min(1).max(20_000),
  modelProvider: ModelProviderKind,
  modelId: z.string().min(1).max(200),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const UpdateAgentRequest = CreateAgentRequest.partial().extend({
  status: z.enum(["ready", "disabled"]).optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

/** A configured model provider. The API key is write-only and never returned. */
export const ModelProvider = z.object({
  id: Id,
  provider: ModelProviderKind,
  allowedModels: z.array(z.string()),
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  createdAt: IsoDateTime,
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelProviderList = z.object({ providers: z.array(ModelProvider) });

export const UpsertModelProviderRequest = z.object({
  provider: ModelProviderKind,
  /** Write-only. Stored encrypted in app.secrets; omitted to keep the current key. */
  apiKey: z.string().min(8).max(500).optional(),
  allowedModels: z.array(z.string().min(1).max(200)).min(1).max(50),
  enabled: z.boolean().default(true),
});
export type UpsertModelProviderRequest = z.infer<typeof UpsertModelProviderRequest>;

export const AllowedModel = z.object({ provider: ModelProviderKind, modelId: z.string() });
export const AllowedModelList = z.object({ models: z.array(AllowedModel) });
export type AllowedModelList = z.infer<typeof AllowedModelList>;
