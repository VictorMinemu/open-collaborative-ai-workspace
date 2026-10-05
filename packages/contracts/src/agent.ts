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

/**
 * `mock` is only offered when the operator sets OCW_MODEL_PROVIDER=mock (E2E / CI, never metered).
 * `openai-codex` is a subscription provider: the customer's own ChatGPT plan, signed in through Codex
 * device authorization INSIDE their OpenClaw cell (no API key; ADR-0006).
 */
export const ModelProviderKind = z.enum([
  "anthropic",
  "openai",
  "openrouter",
  "openai-compatible",
  "openai-codex",
  "mock",
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

/** Providers connected by signing in to an account (no API key). Credentials never leave the cell. */
export const SubscriptionProviderKind = z.enum(["openai-codex"]);
export type SubscriptionProviderKind = z.infer<typeof SubscriptionProviderKind>;

export function isSubscriptionProvider(p: string): p is SubscriptionProviderKind {
  return SubscriptionProviderKind.safeParse(p).success;
}

export const ProviderAuthMode = z.enum(["api_key", "subscription"]);
export type ProviderAuthMode = z.infer<typeof ProviderAuthMode>;

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

/** D-01: `team` bots belong to the organization; a `personal` bot to one member (`ownerUserId`). */
export const AgentScope = z.enum(["team", "personal"]);
export type AgentScope = z.infer<typeof AgentScope>;

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
  scope: AgentScope,
  /** Personal bots only: the member who owns it (and the only one who can see or use it). */
  ownerUserId: Id.nullable(),
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

/**
 * `POST /api/v1/agents/personal`: one click, every field optional. Defaults: "<first name>'s assistant",
 * the organization's default allowed model, a short assistant persona.
 */
export const CreatePersonalBotRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: AgentAvatar.optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  modelProvider: ModelProviderKind.optional(),
  modelId: ModelId.optional(),
});
export type CreatePersonalBotRequest = z.infer<typeof CreatePersonalBotRequest>;

/** The new personal bot and its private direct conversation with the caller. */
export const CreatePersonalBotResponse = z.object({ agent: Agent, dmId: Id });
export type CreatePersonalBotResponse = z.infer<typeof CreatePersonalBotResponse>;

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

/**
 * The signed-in account of a subscription provider, as reported by the cell. Identity metadata only:
 * tokens stay in the OpenClaw cell's own auth store and never reach the API.
 */
export const ProviderAccount = z.object({
  /** Account email from the ID token, when the provider exposes it. */
  email: z.string().nullable(),
  /** e.g. `plus`, `pro`, `business` (ChatGPT plan type claim), when exposed. */
  planType: z.string().nullable(),
  connectedAt: IsoDateTime,
  /** The cell reported that its credentials are gone (volume reset, revoked): sign in again. */
  needsReconnect: z.boolean(),
});
export type ProviderAccount = z.infer<typeof ProviderAccount>;

/** A configured model provider. The API key is write-only: only `hasKey` and a 4-char hint are returned. */
export const ModelProvider = z.object({
  id: Id,
  provider: ModelProviderKind,
  /** `subscription` providers have no key; see `account`. */
  authMode: ProviderAuthMode,
  baseUrl: z.string().nullable(),
  allowedModels: z.array(z.string()),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  /** Last 4 characters of the key, e.g. "x9Qa" (never more). */
  keyHint: z.string().nullable(),
  /** Subscription providers only: who is signed in (null for API-key providers). */
  account: ProviderAccount.nullable(),
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
  /**
   * Subscription providers (`openai-codex`) are created by signing in (`POST /model-providers/:p/auth`);
   * upsert only edits their allowed models / enabled flag and rejects `apiKey`.
   */
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
  /** `subscription`: connect by signing in (device code), no key fields apply. */
  authMode: ProviderAuthMode;
  label: string;
  /** Short label for model pickers ("via …"). */
  shortLabel: string;
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
    authMode: "api_key",
    label: "Anthropic",
    shortLabel: "Anthropic",
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
    authMode: "api_key",
    label: "OpenAI",
    shortLabel: "OpenAI API",
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
    authMode: "api_key",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
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
    authMode: "api_key",
    label: "OpenAI-compatible",
    shortLabel: "OpenAI-compatible",
    description: "Any server that speaks the OpenAI Chat Completions API (vLLM, Ollama, LiteLLM…).",
    defaultBaseUrl: null,
    baseUrlRequired: true,
    keyPlaceholder: "API key",
    keyUrl: null,
    models: [],
  },
  {
    provider: "openai-codex",
    authMode: "subscription",
    label: "ChatGPT subscription (Codex)",
    shortLabel: "ChatGPT subscription",
    description:
      "Your own ChatGPT plan, signed in through Codex. No API key; usage counts against your plan's Codex limits.",
    defaultBaseUrl: null,
    baseUrlRequired: false,
    keyPlaceholder: "",
    keyUrl: null,
    // Ids of the OpenAI Codex catalog in OpenClaw 2026.9.7 (`openai/<id>` there). Which ones a given
    // account may use depends on its plan; admins can add any other id the account exposes.
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", hint: "Codex default · recommended", preselected: true },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "Balanced", preselected: true },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "Fastest", preselected: true },
      { id: "gpt-5.5", label: "GPT-5.5", hint: "Previous generation", preselected: false },
    ],
  },
];

/** Default model when a ChatGPT subscription is the only provider. */
export const DEFAULT_SUBSCRIPTION_MODEL = { provider: "openai-codex", modelId: "gpt-6-astra" } as const;

/** Deterministic, never-metered model used by E2E (served by infra/fake-model). */
export const MOCK_MODEL = { provider: "mock", modelId: "mock-1", label: "Mock model (E2E)" } as const;

export function catalogEntry(provider: ModelProviderKind): ProviderCatalogEntry | undefined {
  return MODEL_PROVIDER_CATALOG.find((p) => p.provider === provider);
}

export function providerShortLabel(provider: ModelProviderKind): string {
  if (provider === "mock") return "Mock";
  return catalogEntry(provider)?.shortLabel ?? provider;
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

// ---------------------------------------------------------------- subscription sign-in (device code)

/**
 * Sign-in flow of a subscription provider, run by the org's OpenClaw cell (OpenClaw owns the device
 * authorization, token storage and refresh). `starting` = asked the cell; `pending` = code ready, waiting
 * for the admin to approve it in their browser.
 */
export const ProviderAuthState = z.enum(["idle", "starting", "pending", "connected", "error"]);
export type ProviderAuthState = z.infer<typeof ProviderAuthState>;

export const ProviderAuthErrorCode = z.enum([
  /** The code expired before it was approved. */
  "expired",
  /** The account owner denied the request. */
  "denied",
  "cancelled",
  /** No OpenClaw cell is connected, or it stopped answering. */
  "cell_offline",
  /** The provider rejected device sign-in for this account/workspace. */
  "unsupported",
  "failed",
]);
export type ProviderAuthErrorCode = z.infer<typeof ProviderAuthErrorCode>;

export const ProviderAuthError = z.object({
  code: ProviderAuthErrorCode,
  /** Human-readable, never contains tokens or codes. */
  message: z.string().max(300),
});
export type ProviderAuthError = z.infer<typeof ProviderAuthError>;

/** `GET/POST/DELETE /api/v1/model-providers/:provider/auth` (admin only). */
export const ProviderAuthStatus = z.object({
  provider: SubscriptionProviderKind,
  state: ProviderAuthState,
  flowId: Id.nullable(),
  /** Where the admin approves the code (shown only while `pending`). */
  verificationUrl: z.string().nullable(),
  /** One-time code to type on the verification page (short-lived; only while `pending`). */
  userCode: z.string().nullable(),
  expiresAt: IsoDateTime.nullable(),
  startedAt: IsoDateTime.nullable(),
  error: ProviderAuthError.nullable(),
  /** Current connection (from the provider row), independent of any flow. */
  account: ProviderAccount.nullable(),
  /** Is an OpenClaw cell connected right now (sign-in needs one). */
  cellConnected: z.boolean(),
});
export type ProviderAuthStatus = z.infer<typeof ProviderAuthStatus>;

export const SubscriptionProviderParams = z.object({ provider: SubscriptionProviderKind });
