import { createOpenAI } from "@ai-sdk/openai";
import {
  type AiChatPolicy,
  type AiModelList,
  type AiModelOption,
  type ChatgptPlanState,
  DEFAULT_MODEL,
  isSubscriptionProvider,
  MOCK_MODEL,
  type ModelCaps,
  type ModelRef,
  type ModelUnavailableReason,
  modelLabel,
  providerShortLabel,
} from "@ocw/contracts";
import { aiUserPreferences, modelProviders, type Tx, userModelCredentials } from "@ocw/db";
import type { JSONValue, LanguageModel, ToolSet } from "ai";
import { and, asc, eq, ne } from "drizzle-orm";
import type { ApiModule, App, Core } from "../../core";
import { MissingSecretError } from "../../lib/secret-store";
import { allowedModels } from "../agent";
import {
  CatalogUnavailableError,
  cachedPlanCatalog,
  DEFAULT_CHATGPT_API_BASE_URL,
  type PlanModel,
  planCatalog,
} from "./chatgpt-plan/catalog";
import {
  accessTokenFor,
  type CredentialRow,
  credentialOf,
  PLAN_USAGE_SCOPE,
  planStatusOf,
} from "./chatgpt-plan/credentials";
import { registerChatgptPlanRoutes } from "./chatgpt-plan/routes";
import {
  type ClassifiedModelError,
  classify,
  ModelUnavailableError,
  PlanTokenUnavailableError,
} from "./errors";
import { loadAiChatPolicy } from "./policy";
import { mockLanguageModel, type OrgProviderKind, orgLanguageModel, orgModelCaps } from "./registry";
import { registerModelRoutes } from "./routes";

/**
 * Model Gateway (P-04): the ONLY module that imports `@ai-sdk/*` and the only place a `LanguageModel` is built,
 * always as a provider instance with an explicit key (never a "provider/model" string, which would route through
 * the metered Vercel AI Gateway). `chatgpt_plan` uses the REQUESTER's own credential only (D-01: never pooled);
 * `org_key` uses an organization provider key, resolved only through its SecretReference (D-07, P-10) and governed
 * by the same allowed-models list as bots (`allowedModels`); `mock` exists only with `OCW_MODEL_PROVIDER=mock`.
 */

export { credentialOf, planStatusOf } from "./chatgpt-plan/credentials";
export { chatgptPlanSeedEnabled } from "./chatgpt-plan/routes";
export {
  type ClassifiedModelError,
  classify,
  ModelUnavailableError,
  PlanTokenUnavailableError,
} from "./errors";
export { loadAiChatPolicy, webPolicyReason } from "./policy";

export interface ResolvedModel {
  ref: ModelRef;
  model: LanguageModel;
  label: string;
  providerLabel: string;
  /** Billed to the organization (METERED label, P-11). */
  metered: boolean;
  caps: ModelCaps;
  providerOptions: Record<string, Record<string, JSONValue>>;
  maxRetries: number;
  /** The plan route rejects `max_output_tokens` (Pitfall 4). */
  allowsMaxOutputTokens: boolean;
  /**
   * Provider-executed tools this backend may be offered (05-11): the plan's hosted `web_search` when its
   * `caps.webSearch` is "hosted"; empty on organization keys and the mock (D-04: their web search is the API's
   * SearXNG function tool, never a provider-hosted, metered one).
   */
  hostedTools: ToolSet;
}

export interface ModelGateway {
  /** Throws `ModelUnavailableError` when the requester cannot use `ref` right now. */
  resolve(tx: Tx, ref: ModelRef, requesterUserId: string): Promise<ResolvedModel>;
  listModels(tx: Tx, requesterUserId: string): Promise<AiModelList>;
  classify(err: unknown): ClassifiedModelError;
  /** Applies the credential transition a classified failure implies (needs_reconnect, not_eligible). */
  reportFailure(tx: Tx, ref: ModelRef, requesterUserId: string, e: ClassifiedModelError): Promise<void>;
  /** Display label of a model (catalog name when known, else the id). */
  labelOf(ref: ModelRef): string;
  /**
   * The capabilities of `ref` for this requester without resolving it (no token, no catalog call): what the chat's
   * tool states are computed from (05-11).
   */
  capsOf(tx: Tx, ref: ModelRef, requesterUserId: string): Promise<ModelCaps>;
}

const PLAN_PROVIDER_LABEL = "ChatGPT plan";
const MOCK_LABEL = "Mock (E2E)";
const MOCK_REF: ModelRef = { backend: "mock", provider: "mock", modelId: MOCK_MODEL.modelId };

type ProviderRow = typeof modelProviders.$inferSelect;

/** An API-key provider an AI chat may use as `org_key` (never the bots' subscription sign-in, P-14). */
function isOrgKeyProvider(provider: string): provider is OrgProviderKind {
  return provider !== "mock" && !isSubscriptionProvider(provider);
}

/** Why an org-key row cannot answer right now (null = it can). Mirrors the bots' `usable()` rule. */
function orgRowReason(row: ProviderRow, policy: AiChatPolicy): ModelUnavailableReason | null {
  if (!policy.orgKeysEnabled) return "org_keys_disabled";
  if (!row.secretRef || (row.provider === "openai-compatible" && !row.baseUrl)) return "no_key";
  if (!row.enabled) return "not_allowed";
  return null;
}

const sameRef = (a: ModelRef, b: { backend: string; provider: string; modelId: string }) =>
  a.backend === b.backend && a.provider === b.provider && a.modelId === b.modelId;
/** The plan group's single row when the member has no usable plan (the picker shows the reason). */
const PLAN_PLACEHOLDER: ModelRef = { backend: "chatgpt_plan", provider: "openai", modelId: "chatgpt" };

/** Conservative capabilities: vision on gpt-5 and gpt-6 slugs; PDFs arrive in 05-12; hosted web search. */
export function planCaps(slug: string): ModelCaps {
  return { vision: /^gpt-[56]/u.test(slug), pdf: false, webSearch: "hosted" };
}

/** A plan model refused hosted web search for this credential (05-11): no web search on it for a day. */
const PLAN_CAP_TTL_SECONDS = 24 * 60 * 60;
export const planCapKey = (credentialId: string, slug: string, cap: "web_search") =>
  `ocw:ai:plan-cap:${credentialId}:${slug}:${cap}`;

const STATE_REASON: Record<Exclude<ChatgptPlanState, "connected">, ModelUnavailableReason> = {
  not_connected: "not_connected",
  needs_reconnect: "needs_reconnect",
  not_eligible: "not_eligible",
  plan_usage_disabled: "plan_usage_disabled",
  disabled_by_org: "plan_disabled_by_org",
};

export function createModelGateway(core: Core, opts: { fetch?: typeof fetch } = {}): ModelGateway {
  const fetchImpl = opts.fetch ?? fetch;
  /** Web search on org keys and the mock is the SearXNG function tool: only when the operator configured it. */
  const functionSearch = (): ModelCaps["webSearch"] => (core.env.OCW_AI_SEARXNG_URL ? "function" : "none");
  const orgCaps = (provider: ModelRef["provider"], modelId: string): ModelCaps => ({
    ...orgModelCaps(provider, modelId),
    webSearch: functionSearch(),
  });

  /** The member's plan models that refused hosted web search (Redis markers, 24 h); empty when Redis is out. */
  async function planSearchRefused(credentialId: string | null | undefined, slugs: string[]) {
    const out = new Set<string>();
    if (!credentialId || slugs.length === 0) return out;
    const values = await core.bus.pub
      .mGet(slugs.map((slug) => planCapKey(credentialId, slug, "web_search")))
      .catch(() => [] as (string | null)[]);
    slugs.forEach((slug, i) => {
      if (values[i]) out.add(slug);
    });
    return out;
  }
  const planCapsFor = (slug: string, refused: Set<string>): ModelCaps => {
    const caps = planCaps(slug);
    return refused.has(slug) ? { ...caps, webSearch: "none" } : caps;
  };
  /** Catalog labels seen by this process (labels only; the catalog itself is cached per credential in Redis). */
  const labels = new Map<string, string>();

  async function catalogOf(row: CredentialRow, token: string): Promise<PlanModel[] | null> {
    try {
      const models = await planCatalog(core, row, token, fetchImpl);
      for (const m of models) labels.set(m.slug, m.label);
      return models;
    } catch (err) {
      if (err instanceof CatalogUnavailableError) {
        core.log.warn({ provider: "chatgpt_plan", status: err.status }, "chatgpt plan catalog unavailable");
        return null;
      }
      throw err;
    }
  }

  /** The requester's usable plan credential and token, or a typed refusal. */
  async function usablePlan(tx: Tx, requesterUserId: string) {
    const policy = await loadAiChatPolicy(tx);
    const row = await credentialOf(tx, requesterUserId);
    const state = planStatusOf(row, policy).state;
    if (state !== "connected" || !row)
      throw new ModelUnavailableError(STATE_REASON[state as Exclude<ChatgptPlanState, "connected">]);
    if (!row.scopes.includes(PLAN_USAGE_SCOPE)) throw new ModelUnavailableError("plan_usage_disabled");
    const token = await accessTokenFor(tx, core, requesterUserId);
    return { policy, row, token };
  }

  async function resolvePlan(tx: Tx, ref: ModelRef, requesterUserId: string): Promise<ResolvedModel> {
    const { policy, row, token } = await usablePlan(tx, requesterUserId);
    if (policy.planAllowedModels.length > 0 && !policy.planAllowedModels.includes(ref.modelId)) {
      throw new ModelUnavailableError("not_allowed");
    }
    const catalog = await catalogOf(row, token);
    // A catalog outage does not block the turn: the provider refuses unknown models itself.
    if (catalog && !catalog.some((m) => m.slug === ref.modelId))
      throw new ModelUnavailableError("not_in_catalog");
    const provider = createOpenAI({
      apiKey: token,
      baseURL: core.env.OCW_CHATGPT_API_BASE_URL ?? DEFAULT_CHATGPT_API_BASE_URL,
      name: "chatgpt-plan",
      fetch: fetchImpl,
    });
    const caps = planCapsFor(ref.modelId, await planSearchRefused(row.id, [ref.modelId]));
    return {
      ref,
      model: provider.responses(ref.modelId),
      label: labels.get(ref.modelId) ?? ref.modelId,
      providerLabel: PLAN_PROVIDER_LABEL,
      metered: false,
      caps,
      // Runs at OpenAI on the member's own plan: $0 to the organization (D-04).
      hostedTools: caps.webSearch === "hosted" ? { web_search: provider.tools.webSearch() } : {},
      // Plan route rules (Pitfalls 4, 9): never retained, instructions as a developer item.
      providerOptions: { openai: { store: false, systemMessageMode: "developer" } },
      maxRetries: 0,
      allowsMaxOutputTokens: false,
    };
  }

  async function resolveOrgKey(tx: Tx, ref: ModelRef): Promise<ResolvedModel> {
    const policy = await loadAiChatPolicy(tx);
    if (!policy.orgKeysEnabled) throw new ModelUnavailableError("org_keys_disabled");
    const provider = ref.provider;
    if (!isOrgKeyProvider(provider)) throw new ModelUnavailableError("not_allowed");
    const [row] = await tx
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.provider, provider))
      .limit(1);
    if (!row) throw new ModelUnavailableError("no_key");
    const reason = orgRowReason(row, policy);
    if (reason) throw new ModelUnavailableError(reason);
    // One allowed list for AI chats and bots (D-07): the very rule bots are checked against.
    const allowed = await allowedModels(core, tx);
    if (!allowed.some((m) => m.provider === provider && m.modelId === ref.modelId)) {
      throw new ModelUnavailableError("not_allowed");
    }
    let apiKey: string;
    try {
      apiKey = await core.secrets.resolve(tx, row.secretRef as NonNullable<ProviderRow["secretRef"]>);
    } catch (err) {
      if (err instanceof MissingSecretError) throw new ModelUnavailableError("no_key");
      throw err;
    }
    const built = orgLanguageModel({ provider, baseUrl: row.baseUrl }, apiKey, ref.modelId, {
      fetch: fetchImpl,
    });
    return {
      ref,
      model: built.model,
      label: modelLabel(provider, ref.modelId),
      providerLabel: providerShortLabel(provider),
      metered: true,
      caps: orgCaps(provider, ref.modelId),
      providerOptions: built.providerOptions,
      maxRetries: 2,
      allowsMaxOutputTokens: true,
      hostedTools: {},
    };
  }

  function resolveMock(ref: ModelRef): ResolvedModel {
    if (core.env.OCW_MODEL_PROVIDER !== "mock" || ref.modelId !== MOCK_MODEL.modelId) {
      throw new ModelUnavailableError("not_allowed");
    }
    return {
      ref,
      model: mockLanguageModel(core.env.OCW_AI_MOCK_BASE_URL, { fetch: fetchImpl }),
      label: MOCK_LABEL,
      providerLabel: providerShortLabel("mock"),
      metered: false,
      caps: orgCaps("mock", ref.modelId),
      providerOptions: {},
      maxRetries: 0,
      allowsMaxOutputTokens: true,
      hostedTools: {},
    };
  }

  /** The `organization` group: every allowed model of every enabled API-key provider, available or with a reason. */
  async function organizationModels(tx: Tx, policy: AiChatPolicy): Promise<AiModelOption[]> {
    const rows = await tx.select().from(modelProviders).orderBy(asc(modelProviders.createdAt));
    const out: AiModelOption[] = [];
    for (const row of rows) {
      const provider = row.provider;
      if (!isOrgKeyProvider(provider) || !row.enabled) continue;
      const reason = orgRowReason(row, policy);
      for (const modelId of row.allowedModels) {
        out.push({
          ref: { backend: "org_key", provider, modelId },
          label: modelLabel(provider, modelId),
          providerLabel: providerShortLabel(provider),
          group: "organization",
          metered: true,
          caps: orgCaps(provider, modelId),
          available: reason === null,
          reason,
          isDefault: false,
        });
      }
    }
    return out;
  }

  const gateway: ModelGateway = {
    classify,

    labelOf(ref) {
      if (ref.backend === "mock") return MOCK_LABEL;
      if (ref.backend === "org_key") return modelLabel(ref.provider, ref.modelId);
      return labels.get(ref.modelId) ?? ref.modelId;
    },

    async resolve(tx, ref, requesterUserId) {
      switch (ref.backend) {
        case "chatgpt_plan":
          return resolvePlan(tx, ref, requesterUserId);
        case "org_key":
          return resolveOrgKey(tx, ref);
        case "mock":
          return resolveMock(ref);
      }
    },

    async listModels(tx, requesterUserId) {
      const policy = await loadAiChatPolicy(tx);
      const row = await credentialOf(tx, requesterUserId);
      const chatgptPlan = planStatusOf(row, policy);
      const unavailable = (reason: ModelUnavailableReason): AiModelOption => ({
        ref: PLAN_PLACEHOLDER,
        label: "ChatGPT",
        providerLabel: PLAN_PROVIDER_LABEL,
        group: "chatgpt_plan",
        metered: false,
        caps: planCaps(""),
        available: false,
        reason,
        isDefault: false,
      });
      let models: AiModelOption[] = [];
      try {
        let catalog: PlanModel[];
        try {
          const { token } = await usablePlan(tx, requesterUserId);
          catalog = (row ? await catalogOf(row, token) : null) ?? [];
        } catch (err) {
          // A refresh outage (05-05) keeps the member connected: show the cached catalog, sends answer 503.
          if (!(err instanceof PlanTokenUnavailableError) || !row) throw err;
          catalog = (await cachedPlanCatalog(core, row.id)) ?? [];
        }
        const listed = catalog.filter(
          (m) => policy.planAllowedModels.length === 0 || policy.planAllowedModels.includes(m.slug),
        );
        const refused = await planSearchRefused(
          row?.id,
          listed.map((m) => m.slug),
        );
        models = listed.map(
          (m): AiModelOption => ({
            ref: { backend: "chatgpt_plan", provider: "openai", modelId: m.slug },
            label: m.label,
            providerLabel: PLAN_PROVIDER_LABEL,
            group: "chatgpt_plan",
            metered: false,
            caps: planCapsFor(m.slug, refused),
            available: true,
            reason: null,
            isDefault: false,
          }),
        );
      } catch (err) {
        if (!(err instanceof ModelUnavailableError)) throw err;
        models = [unavailable(err.reason)];
      }
      models.push(...(await organizationModels(tx, policy)));
      if (core.env.OCW_MODEL_PROVIDER === "mock") {
        models.push({
          ref: MOCK_REF,
          label: MOCK_LABEL,
          providerLabel: providerShortLabel("mock"),
          group: "mock",
          metered: false,
          caps: orgCaps("mock", MOCK_MODEL.modelId),
          available: true,
          reason: null,
          isDefault: false,
        });
      }
      const [prefs] = await tx
        .select({ defaultModel: aiUserPreferences.defaultModel })
        .from(aiUserPreferences)
        .where(eq(aiUserPreferences.userId, requesterUserId))
        .limit(1);
      const preferred = prefs?.defaultModel;
      const orgDefault = { backend: "org_key", ...DEFAULT_MODEL } as const;
      // The member's preference, else their own plan, else the org's recommended model, else anything available.
      const def =
        (preferred && models.find((m) => m.available && sameRef(m.ref, preferred))) ??
        models.find((m) => m.available && m.group === "chatgpt_plan") ??
        models.find((m) => m.available && sameRef(m.ref, orgDefault)) ??
        models.find((m) => m.available) ??
        null;
      if (def) def.isDefault = true;
      return { models, chatgptPlan, defaultRef: def?.ref ?? null };
    },

    async capsOf(tx, ref, requesterUserId) {
      if (ref.backend !== "chatgpt_plan") return orgCaps(ref.provider, ref.modelId);
      const row = await credentialOf(tx, requesterUserId);
      return planCapsFor(ref.modelId, await planSearchRefused(row?.id, [ref.modelId]));
    },

    async reportFailure(tx, ref, requesterUserId, e) {
      if (
        ref.backend === "chatgpt_plan" &&
        e.code === "unsupported_capability" &&
        /web_search/u.test(e.param ?? "")
      ) {
        // This plan model can't search for this member: Web says so for a day instead of failing every turn.
        const row = await credentialOf(tx, requesterUserId);
        if (row) {
          await core.bus.pub
            .set(planCapKey(row.id, ref.modelId, "web_search"), "1", { EX: PLAN_CAP_TTL_SECONDS })
            .catch(() => null);
        }
        return;
      }
      if (ref.backend !== "chatgpt_plan" || !e.credentialState) return;
      if (e.credentialState !== "needs_reconnect" && e.credentialState !== "not_eligible") return;
      const [changed] = await tx
        .update(userModelCredentials)
        .set({ status: e.credentialState, lastError: e.code, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(userModelCredentials.userId, requesterUserId),
            eq(userModelCredentials.provider, "chatgpt_plan"),
            ne(userModelCredentials.status, e.credentialState),
          ),
        )
        .returning({ id: userModelCredentials.id });
      // A credential transition is a sensitive change (AGENTS principle 12): code and state only, never a body.
      if (changed) {
        await core.audit.record(tx, {
          action: "ai_credential.state_changed",
          resourceType: "user_model_credential",
          resourceId: changed.id,
          actorKind: "system",
          userId: requesterUserId,
          metadata: { provider: "chatgpt_plan", state: e.credentialState, reason: e.code },
        });
      }
    },
  };
  return gateway;
}

export function createModelGatewayModule(core: Core, gateway: ModelGateway): ApiModule {
  return {
    name: "model-gateway",
    register(app: App) {
      registerModelRoutes(app, core, gateway);
      registerChatgptPlanRoutes(app, core);
    },
  };
}
