import { readFileSync } from "node:fs";

/**
 * Operator secrets (AGENTS principle 8). Code references secrets by `SecretReference`, never by value.
 * Default providers: `env` (variable) and `file` (path, e.g. Docker secret). Org-level secrets entered in the
 * UI live encrypted in app.secrets and are resolved by the secrets module (`db` provider). With the `vault` profile,
 * the API-only secrets live in OpenBao KV v2 (`openbao` provider, `openbao://<mount>/<path>#<field>`, lib/openbao.ts).
 */
export type SecretReference =
  | { provider: "env"; key: string }
  | { provider: "file"; path: string }
  | { provider: "db"; secretId: string; organizationId: string }
  | { provider: "openbao"; mount: string; path: string; field: string };

export type OpenBaoReference = Extract<SecretReference, { provider: "openbao" }>;

/** The secret does not exist where the reference points. Messages name the reference, never a value. */
export class MissingSecretError extends Error {}

/** This store does not handle the reference's provider (a chained store then asks the next one). */
export class UnsupportedReferenceError extends MissingSecretError {}

export interface SecretStore {
  /** Resolve a reference. `db` references must go through the secrets module (async, tenant tx). */
  resolveSync(ref: SecretReference): string;
}

export const OPENBAO_SCHEME = "openbao://";
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const URI = new RegExp(`^openbao://(${SEGMENT})/(${SEGMENT}(?:/${SEGMENT})*)#([A-Za-z0-9._-]+)$`);

/**
 * `openbao://<mount>/<path>#<field>` → an `openbao` reference; anything else (other schemes, empty or `..`
 * segments, query strings, spaces) → null.
 */
export function parseSecretUri(uri: string): OpenBaoReference | null {
  const m = URI.exec(uri);
  if (!m) return null;
  const [, mount = "", path = "", field = ""] = m;
  if ([mount, ...path.split("/")].some((s) => s === "." || s === "..")) return null;
  return { provider: "openbao", mount, path, field };
}

export function formatSecretUri(ref: OpenBaoReference): string {
  return `${OPENBAO_SCHEME}${ref.mount}/${ref.path}#${ref.field}`;
}

export function createEnvFileSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return {
    resolveSync(ref) {
      if (ref.provider === "env") {
        const v =
          env[ref.key] ??
          (env[`${ref.key}_FILE`] ? readFileSync(env[`${ref.key}_FILE`]!, "utf8").trim() : undefined);
        if (!v) throw new MissingSecretError(`secret ${ref.key} is not set`);
        return v;
      }
      if (ref.provider === "file") return readFileSync(ref.path, "utf8").trim();
      if (ref.provider === "openbao") {
        throw new UnsupportedReferenceError(`${formatSecretUri(ref)} needs the OpenBao secret store`);
      }
      throw new MissingSecretError("db secrets must be resolved through the secrets module");
    },
  };
}

/**
 * Asks `stores` in order (env/file first, then OpenBao) and returns the first value found. A MissingSecretError moves
 * on to the next store; when none has the secret, the first error that is not "unsupported provider" is thrown.
 * Any other error propagates at once.
 */
export function createChainedSecretStore(stores: SecretStore[]): SecretStore {
  return {
    resolveSync(ref) {
      const misses: MissingSecretError[] = [];
      for (const store of stores) {
        try {
          return store.resolveSync(ref);
        } catch (err) {
          if (!(err instanceof MissingSecretError)) throw err;
          misses.push(err);
        }
      }
      throw (
        misses.find((e) => !(e instanceof UnsupportedReferenceError)) ??
        misses[0] ??
        new MissingSecretError("no secret store is configured")
      );
    },
  };
}
