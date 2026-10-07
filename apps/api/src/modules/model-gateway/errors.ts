import type { AiErrorCode, ChatgptPlanState, ModelUnavailableReason } from "@ocw/contracts";

/** A turn's model cannot be used by this requester right now (refusal → 409 `model_unavailable`). */
export class ModelUnavailableError extends Error {
  constructor(readonly reason: ModelUnavailableReason) {
    super(`model unavailable: ${reason}`);
    this.name = "ModelUnavailableError";
  }
}

/**
 * The member's ChatGPT plan tokens could not be refreshed for a transient reason (auth server outage, a refresh
 * running elsewhere for too long). Nothing was cleared: the send answers 503 `usage_unavailable` (Pitfall 2).
 */
export class PlanTokenUnavailableError extends Error {
  constructor(readonly code: string) {
    super("chatgpt plan token temporarily unavailable");
    this.name = "PlanTokenUnavailableError";
  }
}

/**
 * Provider failure → normalized `AiErrorCode` (PURE). AI SDK errors carry `requestBodyValues` (the prompt) and
 * `responseBody`; this function reads codes and status only and never copies either (P-10). Log the classified
 * value (`{code, status, provider}`), never the error object.
 */
export interface ClassifiedModelError {
  code: AiErrorCode;
  /** `error.param` of an unsupported-capability refusal (e.g. the web tool), truncated. */
  param: string | null;
  status: number | null;
  /** The member's credential transition this failure implies (ChatGPT plan only). */
  credentialState: ChatgptPlanState | null;
  retryable: boolean;
}

/** "Sign in with ChatGPT – ChatGPT plan usage" error codes (developers.openai.com/siwc). */
const PLAN_CODES: Record<string, Omit<ClassifiedModelError, "param" | "status">> = {
  subscription_sharing_usage_limit_exceeded: {
    code: "usage_limit_exceeded",
    credentialState: null,
    retryable: false,
  },
  subscription_sharing_user_not_eligible: {
    code: "user_not_eligible",
    credentialState: "not_eligible",
    retryable: false,
  },
  subscription_sharing_usage_unavailable: {
    code: "usage_unavailable",
    credentialState: null,
    retryable: true,
  },
  subscription_sharing_unsupported_capability: {
    code: "unsupported_capability",
    credentialState: null,
    retryable: false,
  },
  subscription_sharing_invalid_user: {
    code: "invalid_credential",
    credentialState: "needs_reconnect",
    retryable: false,
  },
  subscription_sharing_route_not_supported: {
    code: "route_not_supported",
    credentialState: null,
    retryable: false,
  },
};

const PARAM_MAX = 200;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function isAbort(err: unknown): boolean {
  const e = rec(err);
  return e !== null && (e.name === "AbortError" || e.name === "ResponseAborted" || e.type === "abort");
}

/** The provider error code from any of the shapes the AI SDK produces (HTTP error, stream frame, stream error). */
function codeOf(e: Rec): string | null {
  const data = rec(e.data);
  const dataError = rec(data?.error);
  const responseError = rec(rec(data?.response)?.error);
  return str(e.code) ?? str(dataError?.code) ?? str(responseError?.code) ?? null;
}

function paramOf(e: Rec): string | null {
  const p = str(rec(rec(e.data)?.error)?.param) ?? str(e.param);
  return p ? p.slice(0, PARAM_MAX) : null;
}

function statusOf(e: Rec): number | null {
  const s = e.statusCode ?? e.status;
  return typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
}

export function classify(err: unknown): ClassifiedModelError {
  if (isAbort(err)) {
    return { code: "interrupted", param: null, status: null, credentialState: null, retryable: false };
  }
  const e = rec(err);
  if (!e)
    return { code: "provider_error", param: null, status: null, credentialState: null, retryable: false };
  const status = statusOf(e);
  const code = codeOf(e);
  const plan = code ? PLAN_CODES[code] : undefined;
  if (plan) return { ...plan, param: plan.code === "unsupported_capability" ? paramOf(e) : null, status };
  // Pre-stream admission errors can be `{"detail": "..."}` with 401: the token is not accepted.
  if (status === 401) {
    return {
      code: "invalid_credential",
      param: null,
      status,
      credentialState: "needs_reconnect",
      retryable: false,
    };
  }
  if (status === 429)
    return { code: "rate_limited", param: null, status, credentialState: null, retryable: true };
  return {
    code: "provider_error",
    param: null,
    status,
    credentialState: null,
    retryable: e.isRetryable === true && status !== null && status >= 500,
  };
}
