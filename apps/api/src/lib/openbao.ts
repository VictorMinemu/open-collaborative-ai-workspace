import {
  formatSecretUri,
  MissingSecretError,
  type OpenBaoReference,
  type SecretReference,
  type SecretStore,
  UnsupportedReferenceError,
} from "./secret-store";

export type { OpenBaoReference } from "./secret-store";

/**
 * OpenBao client behind `SecretStore` (SELF-02, D-04, D-16). Node `fetch` only: there is no official JS client and
 * the API needs three calls (STACK Decision 7). The store is preloaded at boot: it logs in once (AppRole, or a token),
 * reads each KV v2 path once, keeps the referenced fields in memory and serves `resolveSync`, so the synchronous
 * callers keep working. An AppRole token is revoked right after the reads (nothing renews it).
 *
 * Error messages name the address, the reference and OpenBao's own error text; never a value, the token or the
 * secret id.
 */
export interface OpenBaoConfig {
  /** e.g. http://openbao:8200 (compose network only; the vault profile publishes no port). */
  addr: string;
  roleId?: string | undefined;
  secretId?: string | undefined;
  /** Alternative to AppRole (development, or a token issued by the operator). Not revoked. */
  token?: string | undefined;
}

export interface OpenBaoOptions {
  fetch?: typeof fetch;
  /** Per request (default 10 s). */
  timeoutMs?: number;
}

/** OpenBao refused or could not be reached. Boot turns it into an EnvError naming the variable. */
export class OpenBaoError extends Error {}

export async function createOpenBaoSecretStore(
  cfg: OpenBaoConfig,
  refs: readonly OpenBaoReference[],
  opts: OpenBaoOptions = {},
): Promise<SecretStore> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const addr = normaliseAddr(cfg.addr);

  async function call(method: "GET" | "POST", path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers["X-Vault-Token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${addr}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new OpenBaoError(`OpenBao is unreachable at ${addr} (${networkReason(err)})`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  let token: string;
  let revoke = false;
  if (cfg.roleId && cfg.secretId) {
    const login = await call("POST", "/v1/auth/approle/login", undefined, {
      role_id: cfg.roleId,
      secret_id: cfg.secretId,
    });
    const clientToken = (login.json as { auth?: { client_token?: unknown } } | null)?.auth?.client_token;
    if (login.status !== 200 || typeof clientToken !== "string" || !clientToken) {
      throw new OpenBaoError(
        `OpenBao AppRole login at ${addr} failed (${login.status}${errorsOf(login.json)}): check OCW_OPENBAO_ROLE_ID and OCW_OPENBAO_SECRET_ID`,
      );
    }
    token = clientToken;
    revoke = true;
  } else if (cfg.token) {
    token = cfg.token;
  } else {
    throw new OpenBaoError(
      "OpenBao credentials are missing: set OCW_OPENBAO_ROLE_ID and OCW_OPENBAO_SECRET_ID (or OCW_OPENBAO_TOKEN)",
    );
  }

  const values = new Map<string, string>();
  try {
    const byPath = new Map<string, OpenBaoReference[]>();
    for (const ref of refs) {
      const key = `${ref.mount}/${ref.path}`;
      byPath.set(key, [...(byPath.get(key) ?? []), ref]);
    }
    for (const group of byPath.values()) {
      const [first] = group;
      if (!first) continue;
      const names = group.map(formatSecretUri).join(", ");
      const res = await call("GET", `/v1/${encodePath(first.mount)}/data/${encodePath(first.path)}`, token);
      if (res.status === 404) {
        throw new MissingSecretError(
          `${names}: no secret at ${first.mount}/${first.path} in OpenBao at ${addr}`,
        );
      }
      if (res.status === 403) {
        throw new OpenBaoError(
          `${names}: OpenBao at ${addr} refused the read (403${errorsOf(res.json)}): the token's policy must allow read on ${first.mount}/data/${first.path}`,
        );
      }
      const data = (res.json as { data?: { data?: unknown } } | null)?.data?.data;
      if (res.status !== 200 || !data || typeof data !== "object") {
        throw new OpenBaoError(
          `${names}: OpenBao at ${addr} answered ${res.status}${errorsOf(res.json)} (expected a KV v2 secret)`,
        );
      }
      for (const ref of group) {
        const v = (data as Record<string, unknown>)[ref.field];
        if (typeof v !== "string" || v === "") {
          throw new MissingSecretError(
            `${formatSecretUri(ref)}: field ${ref.field} is missing or empty at ${ref.mount}/${ref.path}`,
          );
        }
        values.set(formatSecretUri(ref), v);
      }
    }
  } finally {
    // Best effort: an unrevoked token expires on its own (token_ttl of the role).
    if (revoke) await call("POST", "/v1/auth/token/revoke-self", token).catch(() => undefined);
  }

  return {
    resolveSync(ref: SecretReference) {
      if (ref.provider !== "openbao") {
        throw new UnsupportedReferenceError("the OpenBao store resolves openbao:// references only");
      }
      const uri = formatSecretUri(ref);
      const v = values.get(uri);
      if (v === undefined) throw new MissingSecretError(`${uri} was not loaded from OpenBao at boot`);
      return v;
    },
  };
}

function normaliseAddr(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenBaoError("OCW_OPENBAO_ADDR is not a URL (expected e.g. http://openbao:8200)");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new OpenBaoError("OCW_OPENBAO_ADDR must be an http(s) URL without credentials");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** `: permission denied` from OpenBao's `{"errors": [...]}` body (short; OpenBao never echoes secret values). */
function errorsOf(json: unknown): string {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return `: ${errors
    .filter((e): e is string => typeof e === "string")
    .join("; ")
    .replace(/\s+/g, " ")
    .slice(0, 200)}`;
}

function networkReason(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out";
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  return "network error";
}
