import { secrets, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule } from "../../core";
import { open, seal } from "../../lib/crypto";
import type { AuditService } from "../audit";

/**
 * Org secrets entered in the UI (e.g. model provider API keys) — demo exception in 01-BUILD-SPEC: stored
 * AES-256-GCM encrypted with OCW_ENCRYPTION_KEY (AAD = organization id), referenced by id, NEVER returned by
 * any API response and never logged. Operator secrets stay in env/files (SecretStore).
 */
export interface SecretsService {
  put(
    tx: Tx,
    input: { name: string; kind: "provider_api_key"; provider?: string | null; value: string },
  ): Promise<string>;
  /** Server-side only (e.g. provisioning a bot runtime). Never send the result to a client. */
  reveal(tx: Tx, secretId: string): Promise<string>;
  remove(tx: Tx, secretId: string): Promise<void>;
}

export function createSecretsService(deps: { key: Buffer; audit: AuditService }): SecretsService {
  return {
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
