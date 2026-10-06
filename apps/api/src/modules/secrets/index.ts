import { secrets, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule } from "../../core";
import { open, seal } from "../../lib/crypto";
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
      kind: "user_model_credential";
      provider?: string | null;
      value: string;
      aad: string;
    },
  ): Promise<string>;
  /** `reveal` of a secret sealed with `putSealed`; throws when the AAD does not match. Server-side only. */
  revealSealed(tx: Tx, secretId: string, aad: string): Promise<string>;
}

export function createSecretsService(deps: { key: Buffer; audit: AuditService }): SecretsService {
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

  return {
    async putSealed(tx, input) {
      return insertSealed(tx, input, input.aad);
    },
    async revealSealed(tx, secretId, aad) {
      return openSealed(tx, secretId, aad);
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
    async reveal(tx, secretId) {
      const ctx = tenantOf(tx);
      const [row] = await tx.select().from(secrets).where(eq(secrets.id, secretId));
      if (!row) throw new Error("secret not found");
      return open(deps.key, row, ctx.organizationId);
    },
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
