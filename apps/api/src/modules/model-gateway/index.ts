import { createOpenAI } from "@ai-sdk/openai";
import type {
  AiModelList,
  AiModelOption,
  ChatgptPlanState,
  ModelCaps,
  ModelRef,
  ModelUnavailableReason,
} from "@ocw/contracts";
import { aiUserPreferences, type Tx, userModelCredentials } from "@ocw/db";
import type { JSONValue, LanguageModel } from "ai";
import { and, eq } from "drizzle-orm";
import type { ApiModule, App, Core } from "../../core";
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
import { registerModelRoutes } from "./routes";

/**
 * Model Gateway (P-04): the ONLY module that imports `@ai-sdk/*` and the only place a `LanguageModel` is built,
 * always as a provider instance with an explicit key (never a "provider/model" string, which would route through
 * the metered Vercel AI Gateway). `chatgpt_plan` uses the REQUESTER's own credential only (D-01: never pooled);
 * `org_key` and `mock` arrive in 05-04.
 */

export { credentialOf, planStatusOf } from "./chatgpt-plan/credentials";
export {
  type ClassifiedModelError,
  classify,
  ModelUnavailableError,
  PlanTokenUnavailableError,
} from "./errors";
export { loadAiChatPolicy } from "./policy";

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
}

const PLAN_PROVIDER_LABEL = "ChatGPT plan";
/** The plan group's single row when the member has no usable plan (the picker shows the reason). */
const PLAN_PLACEHOLDER: ModelRef = { backend: "chatgpt_plan", provider: "openai", modelId: "chatgpt" };

/** Conservative capabilities: vision on gpt-5 and gpt-6 slugs; PDFs arrive in 05-12; hosted web search. */
export function planCaps(slug: string): ModelCaps {
  return { vision: /^gpt-[56]/u.test(slug), pdf: false, webSearch: "hosted" };
}

const STATE_REASON: Record<Exclude<ChatgptPlanState, "connected">, ModelUnavailableReason> = {
  not_connected: "not_connected",
  needs_reconnect: "needs_reconnect",
  not_eligible: "not_eligible",
  plan_usage_disabled: "plan_usage_disabled",
  disabled_by_org: "plan_disabled_by_org",
};

export function createModelGateway(core: Core, opts: { fetch?: typeof fetch } = {}): ModelGateway {
  const fetchImpl = opts.fetch ?? fetch;
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
    return {
      ref,
      model: provider.responses(ref.modelId),
      label: labels.get(ref.modelId) ?? ref.modelId,
      providerLabel: PLAN_PROVIDER_LABEL,
      metered: false,
      caps: planCaps(ref.modelId),
      // Plan route rules (Pitfalls 4, 9): never retained, instructions as a developer item.
      providerOptions: { openai: { store: false, systemMessageMode: "developer" } },
      maxRetries: 0,
      allowsMaxOutputTokens: false,
    };
  }

  const gateway: ModelGateway = {
    classify,

    labelOf(ref) {
      if (ref.backend === "mock") return "Mock (E2E)";
      return labels.get(ref.modelId) ?? ref.modelId;
    },

    async resolve(tx, ref, requesterUserId) {
      switch (ref.backend) {
        case "chatgpt_plan":
          return resolvePlan(tx, ref, requesterUserId);
        case "org_key":
        case "mock":
          // Organization keys and the E2E mock backend arrive in 05-04.
          throw new ModelUnavailableError("not_allowed");
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
        models = catalog
          .filter((m) => policy.planAllowedModels.length === 0 || policy.planAllowedModels.includes(m.slug))
          .map((m) => ({
            ref: { backend: "chatgpt_plan", provider: "openai", modelId: m.slug },
            label: m.label,
            providerLabel: PLAN_PROVIDER_LABEL,
            group: "chatgpt_plan",
            metered: false,
            caps: planCaps(m.slug),
            available: true,
            reason: null,
            isDefault: false,
          }));
      } catch (err) {
        if (!(err instanceof ModelUnavailableError)) throw err;
        models = [unavailable(err.reason)];
      }
      const [prefs] = await tx
        .select({ defaultModel: aiUserPreferences.defaultModel })
        .from(aiUserPreferences)
        .where(eq(aiUserPreferences.userId, requesterUserId))
        .limit(1);
      const preferred = prefs?.defaultModel;
      const sameRef = (a: ModelRef, b: { backend: string; provider: string; modelId: string }) =>
        a.backend === b.backend && a.provider === b.provider && a.modelId === b.modelId;
      const def =
        (preferred && models.find((m) => m.available && sameRef(m.ref, preferred))) ??
        models.find((m) => m.available) ??
        null;
      if (def) def.isDefault = true;
      return { models, chatgptPlan, defaultRef: def?.ref ?? null };
    },

    async reportFailure(tx, ref, requesterUserId, e) {
      if (ref.backend !== "chatgpt_plan" || !e.credentialState) return;
      if (e.credentialState !== "needs_reconnect" && e.credentialState !== "not_eligible") return;
      await tx
        .update(userModelCredentials)
        .set({ status: e.credentialState, lastError: e.code, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(userModelCredentials.userId, requesterUserId),
            eq(userModelCredentials.provider, "chatgpt_plan"),
          ),
        );
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
