import type { Automation } from "@ocw/contracts";
import { type Tx, tenantOf, webhookEndpoints } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { TriggerAdapter, TriggerDeps } from "./actions";
import { newPublicId, newWebhookSecret } from "./webhook-verify";

/** The webhook part of the automation DTO: its public id and URL (never the secret). */
export type WebhookView = NonNullable<Automation["trigger"]["webhook"]>;

export type EndpointRow = typeof webhookEndpoints.$inferSelect;

/** AAD of an endpoint's sealed secrets: they open only for this endpoint of this organization (P-10). */
export const webhookSecretAad = (organizationId: string, endpointId: string) =>
  `${organizationId}:webhook_endpoint:${endpointId}`;

/** The public URL another app posts to (Caddy forwards `/api/*` to the API). */
export const webhookUrl = (core: Core, publicId: string) =>
  `${core.env.OCW_PUBLIC_API_URL.replace(/\/+$/u, "")}/api/v1/hooks/${publicId}`;

/** Seals a signing secret for `endpointId` (kind `webhook_secret`); returns the secret row id. */
export function sealWebhookSecret(core: Core, tx: Tx, endpointId: string, value: string): Promise<string> {
  return core.secrets.putSealed(tx, {
    name: `webhook:${endpointId}`,
    kind: "webhook_secret",
    value,
    aad: webhookSecretAad(tenantOf(tx).organizationId, endpointId),
  });
}

/** The live endpoint of an automation (linked, not tombstoned), or null. */
export async function endpointOf(tx: Tx, automationId: string, lock = false): Promise<EndpointRow | null> {
  const q = tx
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.automationId, automationId), isNull(webhookEndpoints.deletedAt)))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/**
 * The webhook trigger's endpoint (07.6-10; R3, P-10), always inside the automation's own transaction:
 *
 * - `onCreate`: the endpoint row (an unguessable 26-character public id) and its sealed `whsec_` signing secret,
 *   returned once as `webhookSecret` (the create or update response is the only place it ever appears).
 * - `onUpdate`: a save that keeps the webhook kind keeps the URL and the secret.
 * - `onDelete` (the automation is deleted or its trigger changes kind): the endpoint is tombstoned and unlinked, so its
 *   URL answers 410, and both sealed secrets are removed.
 * - `view`: the public id and URL for the automation DTO.
 *
 * Audit rows carry ids only, never the secret, the URL or a payload.
 */
export const webhookTrigger: TriggerAdapter<WebhookView> = {
  async onCreate(tx, a, _input, deps) {
    const [endpoint] = await tx
      .insert(webhookEndpoints)
      .values({ organizationId: a.organizationId, automationId: a.id, publicId: newPublicId() })
      .returning({ id: webhookEndpoints.id });
    if (!endpoint) throw new Error("webhook endpoint insert failed");
    const webhookSecret = newWebhookSecret();
    const secretId = await sealWebhookSecret(deps.core, tx, endpoint.id, webhookSecret);
    await tx.update(webhookEndpoints).set({ secretId }).where(eq(webhookEndpoints.id, endpoint.id));
    await deps.core.audit.record(tx, {
      action: "webhook_endpoint.created",
      resourceType: "webhook_endpoint",
      resourceId: endpoint.id,
      metadata: { endpointId: endpoint.id, automationId: a.id },
    });
    return { webhookSecret };
  },
  async onUpdate() {
    return {};
  },
  async onDelete(tx, a, deps) {
    await tombstone(tx, a.id, deps);
  },
  async view(tx, a, deps) {
    const endpoint = await endpointOf(tx, a.id);
    return endpoint ? { publicId: endpoint.publicId, url: webhookUrl(deps.core, endpoint.publicId) } : null;
  },
};

async function tombstone(tx: Tx, automationId: string, deps: TriggerDeps): Promise<void> {
  const endpoint = await endpointOf(tx, automationId, true);
  if (!endpoint) return;
  await tx
    .update(webhookEndpoints)
    .set({
      deletedAt: sql`now()`,
      automationId: null,
      secretId: null,
      previousSecretId: null,
      previousValidUntil: null,
    })
    .where(eq(webhookEndpoints.id, endpoint.id));
  for (const secretId of [endpoint.secretId, endpoint.previousSecretId]) {
    if (secretId) await deps.core.secrets.remove(tx, secretId);
  }
  await deps.core.audit.record(tx, {
    action: "webhook_endpoint.deleted",
    resourceType: "webhook_endpoint",
    resourceId: endpoint.id,
    metadata: { endpointId: endpoint.id, automationId },
  });
}
