import { readFileSync } from "node:fs";

/**
 * Operator secrets (AGENTS principle 8). Code references secrets by `SecretReference`, never by value.
 * Default providers: `env` (variable) and `file` (path, e.g. Docker secret). Org-level secrets entered in the
 * UI live encrypted in app.secrets and are resolved by the secrets module (`db` provider).
 */
export type SecretReference =
  | { provider: "env"; key: string }
  | { provider: "file"; path: string }
  | { provider: "db"; secretId: string; organizationId: string };

export class MissingSecretError extends Error {}

export interface SecretStore {
  /** Resolve an env/file reference. `db` references must go through the secrets module (async, tenant tx). */
  resolveSync(ref: SecretReference): string;
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
      throw new MissingSecretError("db secrets must be resolved through the secrets module");
    },
  };
}
