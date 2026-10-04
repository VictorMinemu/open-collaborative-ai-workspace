import {
  AgentChannelEventTypes,
  catalogEntry,
  cellTopic,
  EventTypes,
  type ModelProvider,
  type SubscriptionProviderKind,
} from "@ocw/contracts";
import { modelProviders, type Tx, tenantOf } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import { notifyCell, toProviderDto } from "./service";

/**
 * Subscription providers (ChatGPT via Codex): the account is signed in INSIDE the org's OpenClaw cell
 * (OpenClaw owns the device authorization, the tokens and their refresh). This module only keeps the
 * provider row (allowed models + who is signed in) in sync with what the cell reports. ADR-0006.
 */

export interface SubscriptionAccountReport {
  email: string | null;
  planType: string | null;
}

async function findRow(tx: Tx, provider: SubscriptionProviderKind) {
  const [row] = await tx.select().from(modelProviders).where(eq(modelProviders.provider, provider));
  return row ?? null;
}

/** Current account of a subscription provider (null when not connected). */
export async function subscriptionAccount(tx: Tx, provider: SubscriptionProviderKind) {
  const row = await findRow(tx, provider);
  return row ? toProviderDto(row).account : null;
}

/**
 * The cell finished a sign-in (or confirmed one it already holds): create/refresh the provider row,
 * audit it and tell browsers + the cell, all in the caller's transaction.
 * `startedBy` is the admin who started the flow (tenant user of `tx`), null for a cell-initiated refresh.
 */
export async function applySubscriptionConnected(
  core: Core,
  tx: Tx,
  provider: SubscriptionProviderKind,
  account: SubscriptionAccountReport,
  opts: { flowId: string | null },
): Promise<ModelProvider> {
  const { organizationId } = tenantOf(tx);
  const existing = await findRow(tx, provider);
  const now = new Date().toISOString();
  const sameAccount =
    !!existing?.account &&
    existing.account.email === account.email &&
    existing.account.planType === account.planType &&
    !existing.account.needsReconnect;
  const nextAccount = {
    email: account.email,
    planType: account.planType,
    connectedAt: sameAccount && existing?.account ? existing.account.connectedAt : now,
    needsReconnect: false,
  };
  const preselected = (catalogEntry(provider)?.models ?? []).filter((m) => m.preselected).map((m) => m.id);
  const [row] = existing
    ? await tx
        .update(modelProviders)
        .set({ account: nextAccount, updatedAt: now })
        .where(eq(modelProviders.id, existing.id))
        .returning()
    : await tx
        .insert(modelProviders)
        .values({
          organizationId,
          provider,
          secretId: null,
          keyHint: null,
          baseUrl: null,
          allowedModels: preselected,
          enabled: true,
          account: nextAccount,
        })
        .returning();
  if (!row) throw new Error("subscription provider upsert failed");
  if (sameAccount && existing) return toProviderDto(row);

  await core.audit.record(tx, {
    action: "model_provider.connected",
    resourceType: "model_provider",
    resourceId: row.id,
    // The cell completed the flow; the tenant user of tx (when set) is the admin who started it.
    clientKind: "agent",
    metadata: {
      provider,
      flowId: opts.flowId,
      source: "openclaw_cell",
      method: "device-code",
      accountEmail: account.email,
      planType: account.planType,
      created: !existing,
    },
  });
  await core.realtime.appendEvent(tx, `org:${organizationId}`, EventTypes.modelProvidersUpdated, {
    provider,
  });
  await notifyCell(core, tx, "providers.updated", null);
  return toProviderDto(row);
}

/**
 * The cell reports it no longer holds usable credentials for a connected subscription (state volume reset,
 * token revoked at the provider). Keep the row (bots keep their model) and flag it for reconnection.
 */
export async function markSubscriptionNeedsReconnect(
  core: Core,
  tx: Tx,
  provider: SubscriptionProviderKind,
  reason: string,
): Promise<boolean> {
  const { organizationId } = tenantOf(tx);
  const row = await findRow(tx, provider);
  if (!row?.account || row.account.needsReconnect) return false;
  await tx
    .update(modelProviders)
    .set({ account: { ...row.account, needsReconnect: true }, updatedAt: new Date().toISOString() })
    .where(eq(modelProviders.id, row.id));
  await core.audit.record(tx, {
    action: "model_provider.credentials_lost",
    resourceType: "model_provider",
    resourceId: row.id,
    actorKind: "system",
    clientKind: "agent",
    result: "error",
    metadata: { provider, source: "openclaw_cell", reason },
  });
  await core.realtime.appendEvent(tx, `org:${organizationId}`, EventTypes.modelProvidersUpdated, {
    provider,
  });
  return true;
}

/** Durable cell command: delete the cell's stored credentials for this provider (admin disconnected). */
export async function revokeSubscriptionInCell(
  core: Core,
  tx: Tx,
  provider: SubscriptionProviderKind,
): Promise<void> {
  const { organizationId } = tenantOf(tx);
  await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.providerAuthRevoke, {
    type: AgentChannelEventTypes.providerAuthRevoke,
    organizationId,
    cellId: organizationId,
    provider,
  });
}
