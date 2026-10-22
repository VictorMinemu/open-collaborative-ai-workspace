import { secrets, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule } from "../../core";
import { open, seal } from "../../lib/crypto";
import { MissingSecretError, type SecretReference, type SecretStore } from "../../lib/secret-store";
import type { AuditService } from "../audit";

type SecretKind = (typeof secrets.$inferInsert)["kind"];

/**
 * Org secrets entered in the UI (model provider API keys, MCP server header credentials) — demo exception in 01-BUILD-SPEC: stored
 * AES-256-GCM encrypted with OCW_ENCRYPTION_KEY (AAD = organization id), referenced by id, NEVER returned by
 * any API response and never logged. Operator secrets stay in env/files (SecretStore).
 */
export interface SecretsService {
  put(
    tx: Tx,
    input: {
      name: string;
      /** `mcp_credential`: an MCP server header value (D-13), revealed only for the cell snapshot. */
      kind: "provider_api_key" | "mcp_credential";
      provider?: string | null;
      value: string;
    },
  ): Promise<string>;
  /** Server-side only (e.g. provisioning a bot runtime). Never send the result to a client. */
  reveal(tx: Tx, secretId: string): Promise<string>;
  remove(tx: Tx, secretId: string): Promise<void>;
  /**
   * `put` with an explicit AAD binding the ciphertext to its owner beyond the organization, e.g. a member's
   * ChatGPT token bundle (`<orgId>:<userId>:chatgpt_plan`, P-10): it only opens with the same AAD.
   */
  putSealed(
    tx: Tx,
    input: {
      name: string;
      /**
       * `user_model_credential`: a member's ChatGPT bundle (P-10). `connector_credential`: a member's connector token
       * bundle or key (Phase 07.4, D-01). `vault_item`: a keychain item's value, AAD `<orgId>:vault:<itemId>` (D-04).
       * `browser_session`: a member's browser storage state for one site and bot (Phase 07.8, D-08, P-09), AAD
       * `<orgId>:<userId>:browser:<agentId>:<siteKey>`; only `browser/sessions.ts` seals and opens it.
       */
      kind: "user_model_credential" | "connector_credential" | "vault_item" | "browser_session";
      provider?: string | null;
      value: string;
      aad: string;
    },
  ): Promise<string>;
  /** `reveal` of a secret sealed with `putSealed`; throws when the AAD does not match. Server-side only. */
  revealSealed(tx: Tx, secretId: string, aad: string): Promise<string>;
  /**
   * Re-seals the value of an existing `putSealed` secret in place (same row, same id; the caller's AAD rules), e.g. a
   * keychain key whose value was replaced (Phase 07.4). No `secret.created`/`secret.deleted` pair: the caller audits
   * the change. Throws when the row does not exist in the tx's organization.
   */
  replaceSealed(tx: Tx, secretId: string, value: string, aad: string): Promise<void>;
  /**
   * The single entry point for a `SecretReference` (D-07, P-10): `env` / `file` through the operator store, `db`
   * through `reveal` inside the tenant tx, only when the reference names the tx's own organization (a foreign
   * reference is a `MissingSecretError`, never a cross-tenant read). The value is never logged.
   */
  resolve(tx: Tx, ref: SecretReference): Promise<string>;
}

export function createSecretsService(deps: {
  key: Buffer;
  audit: AuditService;
  /** Operator secrets (env/file). Without it, env/file references cannot be resolved. */
  store?: SecretStore;
}): SecretsService {
  async function insertSealed(
    tx: Tx,
    input: { name: string; kind: SecretKind; provider?: string | null; value: string },
    aad: string,
  ): Promise<string> {
    const ctx = tenantOf(tx);
    const [row] = await tx
      .insert(secrets)
      .values({
        organizationId: ctx.organizationId,
        name: input.name,
        kind: input.kind,
        provider: input.provider ?? null,
        ...seal(deps.key, input.value, aad),
        createdBy: ctx.userId ?? null,
      })
      .returning({ id: secrets.id });
    if (!row) throw new Error("secret insert failed");
    await deps.audit.record(tx, {
      action: "secret.created",
      resourceType: "secret",
      resourceId: row.id,
      metadata: { name: input.name, kind: input.kind, provider: input.provider ?? null },
    });
    return row.id;
  }

  async function openSealed(tx: Tx, secretId: string, aad: string): Promise<string> {
    const [row] = await tx.select().from(secrets).where(eq(secrets.id, secretId));
    if (!row) throw new Error("secret not found");
    return open(deps.key, row, aad);
  }

  async function reveal(tx: Tx, secretId: string): Promise<string> {
    const ctx = tenantOf(tx);
    const [row] = await tx.select().from(secrets).where(eq(secrets.id, secretId));
    if (!row) throw new Error("secret not found");
    return open(deps.key, row, ctx.organizationId);
  }

  return {
    async resolve(tx, ref) {
      if (ref.provider === "db") {
        if (ref.organizationId !== tenantOf(tx).organizationId) {
          throw new MissingSecretError("secret reference belongs to another organization");
        }
        try {
          return await reveal(tx, ref.secretId);
        } catch {
          // Missing row (RLS hides other tenants' rows too) or a seal that does not open: no detail leaks.
          throw new MissingSecretError("secret reference cannot be resolved");
        }
      }
      if (!deps.store) throw new MissingSecretError("no operator secret store configured");
      return deps.store.resolveSync(ref);
    },
    async putSealed(tx, input) {
      return insertSealed(tx, input, input.aad);
    },
    async revealSealed(tx, secretId, aad) {
      return openSealed(tx, secretId, aad);
    },
    async replaceSealed(tx, secretId, value, aad) {
      const updated = await tx
        .update(secrets)
        .set(seal(deps.key, value, aad))
        .where(eq(secrets.id, secretId))
        .returning({ id: secrets.id });
      if (updated.length !== 1) throw new Error("secret not found");
    },
    async put(tx, input) {
      const ctx = tenantOf(tx);
      const sealed = seal(deps.key, input.value, ctx.organizationId);
      const [row] = await tx
        .insert(secrets)
        .values({
          organizationId: ctx.organizationId,
          name: input.name,
          kind: input.kind,
          provider: input.provider ?? null,
          ...sealed,
          createdBy: ctx.userId ?? null,
        })
        .returning({ id: secrets.id });
      if (!row) throw new Error("secret insert failed");
      await deps.audit.record(tx, {
        action: "secret.created",
        resourceType: "secret",
        resourceId: row.id,
        metadata: { name: input.name, kind: input.kind, provider: input.provider ?? null },
      });
      return row.id;
    },
    reveal,
    async remove(tx, secretId) {
      await tx.delete(secrets).where(eq(secrets.id, secretId));
      await deps.audit.record(tx, { action: "secret.deleted", resourceType: "secret", resourceId: secretId });
    },
  };
}

/** No HTTP surface of its own; model-provider routes (agent module) call SecretsService. */
export function createSecretsModule(): ApiModule {
  return { name: "secrets", register() {} };
}
