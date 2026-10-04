import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * Bots (agents) and model providers. Agents are first-class principals (AGENTS principle 2): their own
 * table, usernames, channel memberships and audit trail. In MVP 0 every bot runs in the org's OpenClaw cell
 * and its model is fixed per bot, chosen from the org's allowed list.
 */

export const AgentRuntime = z.enum(["openclaw"]);
export const AgentStatus = z.enum(["provisioning", "ready", "error", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** `mock` is only offered when the operator sets OCW_MODEL_PROVIDER=mock (E2E / CI, never metered). */
export const ModelProviderKind = z.enum(["anthropic", "openai", "openrouter", "openai-compatible", "mock"]);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

export const AgentUsername = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase letters, digits, - and _");

/** Emoji (1-16 chars) or an http(s) image URL. */
export const AgentAvatar = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => /^https?:\/\//.test(v) || [...v].length <= 16, "an emoji or an http(s) image URL");

export const ModelId = z.string().trim().min(1).max(200);

export const Agent = z.object({
  id: Id,
  organizationId: Id,
  name: z.string(),
  username: z.string(),
  /** Emoji or image URL (null → initials). */
  avatarUrl: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string(),
  modelProvider: ModelProviderKind,
  modelId: z.string(),
  runtime: AgentRuntime,
  status: AgentStatus,
  statusMessage: z.string().nullable(),
  createdBy: Id.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Agent = z.infer<typeof Agent>;

export const AgentList = z.object({ agents: z.array(Agent) });
export type AgentList = z.infer<typeof AgentList>;

export const CreateAgentRequest = z.object({
  name: z.string().trim().min(1).max(80),
  /** Omit to derive one from the name (unique per org). */
  username: AgentUsername.optional(),
  avatarUrl: AgentAvatar.optional(),
  description: z.string().trim().max(500).optional(),
  instructions: z.string().trim().min(1).max(20_000),
  modelProvider: ModelProviderKind,
  modelId: ModelId,
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const UpdateAgentRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  username: AgentUsername.optional(),
  avatarUrl: AgentAvatar.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  modelProvider: ModelProviderKind.optional(),
  modelId: ModelId.optional(),
  /** false → status `disabled` (no mentions delivered); true → re-provision in the cell. */
  enabled: z.boolean().optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

// ---------------------------------------------------------------- model providers

/** A configured model provider. The API key is write-only: only `hasKey` and a 4-char hint are returned. */
export const ModelProvider = z.object({
  id: Id,
  provider: ModelProviderKind,
  baseUrl: z.string().nullable(),
  allowedModels: z.array(z.string()),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  /** Last 4 characters of the key, e.g. "x9Qa" (never more). */
  keyHint: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelProviderList = z.object({
  providers: z.array(ModelProvider),
  /** True when the operator enabled the deterministic mock provider (OCW_MODEL_PROVIDER=mock). */
  mockEnabled: z.boolean(),
});
export type ModelProviderList = z.infer<typeof ModelProviderList>;

export const UpsertModelProviderRequest = z.object({
  provider: ModelProviderKind.exclude(["mock"]),
  /** Write-only. Stored encrypted in app.secrets; omit to keep the current key. */
  apiKey: z.string().trim().min(8).max(500).optional(),
  /** Required for `openai-compatible`; optional override for the others. */
  baseUrl: z.url().max(500).nullable().optional(),
  allowedModels: z.array(ModelId).min(1).max(50),
  enabled: z.boolean().default(true),
});
export type UpsertModelProviderRequest = z.infer<typeof UpsertModelProviderRequest>;

export const ProviderParams = z.object({ provider: ModelProviderKind.exclude(["mock"]) });

export const AllowedModel = z.object({
  provider: ModelProviderKind,
  modelId: z.string(),
  label: z.string(),
  /** The recommended default for new bots. */
  isDefault: z.boolean(),
});
export type AllowedModel = z.infer<typeof AllowedModel>;
export const AllowedModelList = z.object({ models: z.array(AllowedModel) });
export type AllowedModelList = z.infer<typeof AllowedModelList>;

export interface CatalogModel {
  id: string;
  label: string;
  hint: string;
  /** Pre-selected when the provider is first configured. */
  preselected: boolean;
}

export interface ProviderCatalogEntry {
  provider: ModelProviderKind;
  label: string;
  description: string;
  defaultBaseUrl: string | null;
  baseUrlRequired: boolean;
  keyPlaceholder: string;
  keyUrl: string | null;
  models: CatalogModel[];
}

/** Default model for new bots (owner decision 5, 01-BUILD-SPEC). */
export const DEFAULT_MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;

/** Presets shown in Settings › Models. Admins can also add any custom model id. */
export const MODEL_PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    provider: "anthropic",
    label: "Anthropic",
    description: "Claude models, direct from Anthropic.",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlRequired: false,
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        hint: "Balanced · recommended",
        preselected: true,
      },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable", preselected: true },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, lowest cost", preselected: true },
    ],
  },
  {
    provider: "openai",
    label: "OpenAI",
    description: "GPT models through the OpenAI API.",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlRequired: false,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5", label: "GPT-5", hint: "Flagship", preselected: true },
      { id: "gpt-5-mini", label: "GPT-5 mini", hint: "Fast, lower cost", preselected: true },
      { id: "gpt-4.1", label: "GPT-4.1", hint: "Previous generation", preselected: false },
    ],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    description: "Hundreds of models behind one key.",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    baseUrlRequired: false,
    keyPlaceholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
    models: [
      {
        id: "anthropic/claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        hint: "via OpenRouter",
        preselected: true,
      },
      { id: "openai/gpt-5", label: "GPT-5", hint: "via OpenRouter", preselected: true },
    ],
  },
  {
    provider: "openai-compatible",
    label: "OpenAI-compatible",
    description: "Any server that speaks the OpenAI Chat Completions API (vLLM, Ollama, LiteLLM…).",
    defaultBaseUrl: null,
    baseUrlRequired: true,
    keyPlaceholder: "API key",
    keyUrl: null,
    models: [],
  },
];

/** Deterministic, never-metered model used by E2E (served by infra/fake-model). */
export const MOCK_MODEL = { provider: "mock", modelId: "mock-1", label: "Mock model (E2E)" } as const;

export function catalogEntry(provider: ModelProviderKind): ProviderCatalogEntry | undefined {
  return MODEL_PROVIDER_CATALOG.find((p) => p.provider === provider);
}

export function modelLabel(provider: ModelProviderKind, modelId: string): string {
  if (provider === "mock" && modelId === MOCK_MODEL.modelId) return MOCK_MODEL.label;
  return catalogEntry(provider)?.models.find((m) => m.id === modelId)?.label ?? modelId;
}

// ---------------------------------------------------------------- bots runtime (OpenClaw cell)

export const AgentCellStatus = z.object({
  /** MVP 0: one cell per organization; the cell id is the organization id. */
  cellId: Id,
  connected: z.boolean(),
  /** Open plugin WebSocket connections across API instances. */
  connections: z.number().int().nonnegative(),
  connectedAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  /** OCW_CELL_TOKEN / _FILE is set for the API (compose bootstrap). */
  envTokenConfigured: z.boolean(),
  /** A token created from the UI is active. */
  uiTokenCreatedAt: IsoDateTime.nullable(),
});
export type AgentCellStatus = z.infer<typeof AgentCellStatus>;

/** Returned ONCE by `POST /agent-cell/token`; only its SHA-256 is stored. */
export const RotateCellTokenResponse = z.object({ token: z.string(), createdAt: IsoDateTime });
export type RotateCellTokenResponse = z.infer<typeof RotateCellTokenResponse>;
