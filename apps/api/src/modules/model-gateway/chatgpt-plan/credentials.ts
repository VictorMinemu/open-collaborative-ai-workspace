import {
  type AiChatPolicy,
  CHATGPT_MANAGE_USAGE_URL,
  type ChatgptPlanState,
  type ChatgptPlanStatus,
} from "@ocw/contracts";
import { type Tx, tenantOf, userModelCredentials } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../../core";
import { ModelUnavailableError } from "../errors";

/**
 * A member's own ChatGPT plan sign-in (D-01, D-02: never pooled). The token bundle is sealed in `app.secrets`
 * (kind `user_model_credential`) with AAD `<orgId>:<userId>:chatgpt_plan`; the `user_model_credentials` row holds
 * identity metadata and status only. Every function takes the REQUESTER's user id and reads that row alone: no
 * caller can name another member's credential (T-05-02-01).
 */

export type CredentialRow = typeof userModelCredentials.$inferSelect;

export const TokenBundle = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ISO time the access token expires. */
  expiresAt: z.string(),
  /** The issued `oaiapp_…` client id (refreshes use it, 05-05). */
  clientId: z.string().min(1),
});
export type TokenBundle = z.infer<typeof TokenBundle>;

export interface CredentialMeta {
  issuedClientId: string | null;
  subject: string | null;
  email: string | null;
  planType: string | null;
  scopes: string[];
}

/** Scope without which plan usage is disabled for the account (developers.openai.com/siwc). */
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";

export const credentialAad = (organizationId: string, userId: string) =>
  `${organizationId}:${userId}:chatgpt_plan`;

/** Redis key of the member's cached model catalog (catalog.ts); dropped whenever the tokens change. */
export const catalogCacheKey = (credentialId: string) => `ocw:ai:catalog:${credentialId}`;

/** The requester's own ChatGPT plan credential row, or null. */
export async function credentialOf(tx: Tx, userId: string): Promise<CredentialRow | null> {
  const [row] = await tx
    .select()
    .from(userModelCredentials)
    .where(and(eq(userModelCredentials.userId, userId), eq(userModelCredentials.provider, "chatgpt_plan")))
    .limit(1);
  return row ?? null;
}

/**
 * Seals the bundle and upserts the member's row (status `connected`). A previous bundle's secret is deleted, and
 * the catalog cache is dropped so the new token's catalog is fetched.
 */
export async function storeCredential(
  tx: Tx,
  core: Core,
  userId: string,
  bundle: TokenBundle,
  meta: CredentialMeta,
): Promise<CredentialRow> {
  const { organizationId } = tenantOf(tx);
  const previous = await credentialOf(tx, userId);
  const secretId = await core.secrets.putSealed(tx, {
    name: "ChatGPT plan sign-in",
    kind: "user_model_credential",
    provider: "chatgpt_plan",
    value: JSON.stringify(TokenBundle.parse(bundle)),
    aad: credentialAad(organizationId, userId),
  });
  const now = new Date().toISOString();
  const values = {
    secretId,
    issuedClientId: meta.issuedClientId,
    subject: meta.subject,
    email: meta.email,
    planType: meta.planType,
    scopes: meta.scopes,
    accessExpiresAt: bundle.expiresAt,
    status: (meta.scopes.includes(PLAN_USAGE_SCOPE)
      ? "connected"
      : "plan_usage_disabled") as CredentialRow["status"],
    lastError: null,
    updatedAt: now,
  };
  const [row] = await tx
    .insert(userModelCredentials)
    .values({ organizationId, userId, provider: "chatgpt_plan", connectedAt: now, ...values })
    .onConflictDoUpdate({
      target: [
        userModelCredentials.organizationId,
        userModelCredentials.userId,
        userModelCredentials.provider,
      ],
      set: { ...values, connectedAt: now },
    })
    .returning();
  if (!row) throw new Error("credential upsert returned no row");
  if (previous?.secretId && previous.secretId !== secretId) await core.secrets.remove(tx, previous.secretId);
  await core.bus.pub.del(catalogCacheKey(row.id)).catch(() => 0);
  return row;
}

/**
 * The requester's current access token. Missing → `not_connected`; expired or unreadable → `needs_reconnect`
 * (05-05 adds the serialized refresh here). Never log or return the result to a client.
 */
export async function accessTokenFor(tx: Tx, core: Core, userId: string): Promise<string> {
  const row = await credentialOf(tx, userId);
  if (!row?.secretId) throw new ModelUnavailableError("not_connected");
  const { organizationId } = tenantOf(tx);
  let bundle: TokenBundle;
  try {
    bundle = TokenBundle.parse(
      JSON.parse(await core.secrets.revealSealed(tx, row.secretId, credentialAad(organizationId, userId))),
    );
  } catch {
    throw new ModelUnavailableError("needs_reconnect");
  }
  if (!(Date.parse(bundle.expiresAt) > Date.now())) throw new ModelUnavailableError("needs_reconnect");
  return bundle.accessToken;
}

/** Status of the member's plan sign-in for the UI (no token material, ever). */
export function planStatusOf(row: CredentialRow | null, policy: AiChatPolicy): ChatgptPlanStatus {
  const state: ChatgptPlanState = !policy.chatgptPlanEnabled
    ? "disabled_by_org"
    : !row
      ? "not_connected"
      : row.status;
  return {
    state,
    email: row?.email ?? null,
    planType: row?.planType ?? null,
    connectedAt: row ? new Date(row.connectedAt).toISOString() : null,
    welcomeSeen: row?.welcomeSeenAt != null,
    manageUsageUrl: CHATGPT_MANAGE_USAGE_URL,
  };
}
