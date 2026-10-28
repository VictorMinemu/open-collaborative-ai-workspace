import { randomUUID } from "node:crypto";
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
import { ModelUnavailableError, PlanTokenUnavailableError } from "../errors";
import {
  DEFAULT_CHATGPT_AUTH_BASE_URL,
  type Discovery,
  discovery,
  OAuthError,
  PLAN_SCOPE,
  refreshTokens,
  revokeTokens,
} from "./oauth";

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
export const PLAN_USAGE_SCOPE = PLAN_SCOPE;

/** The issuer the API signs members in with: OpenAI, or the fake in tests (P-12: the override is test-only). */
export const authBaseOf = (core: Core) => core.env.OCW_CHATGPT_AUTH_BASE_URL ?? DEFAULT_CHATGPT_AUTH_BASE_URL;

/** An access token expiring within this window is refreshed before use. */
export const REFRESH_WINDOW_MS = 5 * 60_000;
/** Cross-instance refresh lock (Redis NX) and how long a caller waits for another refresh to land. */
const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 35_000;
const REFRESH_POLL_MS = 150;
export const refreshLockKey = (credentialId: string) => `ocw:ai:siwc-refresh:${credentialId}`;
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

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

async function openBundle(
  tx: Tx,
  core: Core,
  secretId: string,
  organizationId: string,
  userId: string,
): Promise<TokenBundle | null> {
  try {
    return TokenBundle.parse(
      JSON.parse(await core.secrets.revealSealed(tx, secretId, credentialAad(organizationId, userId))),
    );
  } catch {
    return null;
  }
}

const fresh = (b: TokenBundle) => Date.parse(b.expiresAt) - Date.now() > REFRESH_WINDOW_MS;

/**
 * A terminal refresh failure (the grant is dead): the member must reconnect. The sealed bundle is deleted, the row
 * keeps identity metadata with status `needs_reconnect` and the error code, and the change is audited.
 */
async function markNeedsReconnect(tx: Tx, core: Core, row: CredentialRow, reason: string): Promise<void> {
  await tx
    .update(userModelCredentials)
    .set({
      status: "needs_reconnect",
      secretId: null,
      lastError: reason,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(userModelCredentials.id, row.id));
  if (row.secretId) await core.secrets.remove(tx, row.secretId);
  await core.audit.record(tx, {
    action: "ai_credential.refresh_failed",
    resourceType: "user_model_credential",
    resourceId: row.id,
    metadata: { provider: "chatgpt_plan", reason },
  });
  await core.bus.pub.del(catalogCacheKey(row.id)).catch(() => 0);
}

type RefreshOutcome =
  | { kind: "token"; token: string }
  | { kind: "wait" }
  | { kind: "refused"; reason: "not_connected" | "needs_reconnect" }
  | { kind: "transient"; code: string };

/**
 * One attempt, in its OWN transaction (so a `needs_reconnect` transition commits even though the caller's send
 * then fails): lock the credential row (`select … for update`), re-read the bundle, and only the holder of the Redis
 * lock calls the token endpoint; the rotated bundle and the new expiry are stored atomically.
 */
async function refreshAttempt(
  core: Core,
  ctx: { organizationId: string; userId: string; credentialId: string },
  holdsLock: boolean,
  auth: () => Promise<Discovery>,
): Promise<RefreshOutcome> {
  return core.db.withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(userModelCredentials)
      .where(eq(userModelCredentials.id, ctx.credentialId))
      .for("update");
    if (!row) return { kind: "refused", reason: "not_connected" };
    if (row.status === "needs_reconnect" || !row.secretId)
      return { kind: "refused", reason: "needs_reconnect" };
    const bundle = await openBundle(tx, core, row.secretId, ctx.organizationId, ctx.userId);
    if (!bundle) return { kind: "refused", reason: "needs_reconnect" };
    if (fresh(bundle)) return { kind: "token", token: bundle.accessToken };
    if (!holdsLock) return { kind: "wait" };

    let tokens: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      tokens = await refreshTokens(await auth(), {
        refreshToken: bundle.refreshToken,
        clientId: bundle.clientId,
      });
    } catch (err) {
      const e = err instanceof OAuthError ? err : null;
      core.log.warn(
        {
          provider: "chatgpt_plan",
          code: e?.code ?? "error",
          status: e?.status ?? null,
          terminal: !!e?.terminal,
        },
        "chatgpt plan token refresh failed",
      );
      if (e?.terminal) {
        await markNeedsReconnect(tx, core, row, e.code);
        return { kind: "refused", reason: "needs_reconnect" };
      }
      return { kind: "transient", code: e?.code ?? "unavailable" };
    }
    const next: TokenBundle = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? bundle.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      clientId: bundle.clientId,
    };
    const secretId = await core.secrets.putSealed(tx, {
      name: "ChatGPT plan sign-in",
      kind: "user_model_credential",
      provider: "chatgpt_plan",
      value: JSON.stringify(next),
      aad: credentialAad(ctx.organizationId, ctx.userId),
    });
    const scopes = tokens.scopes;
    await tx
      .update(userModelCredentials)
      .set({
        secretId,
        accessExpiresAt: next.expiresAt,
        lastError: null,
        updatedAt: new Date().toISOString(),
        ...(scopes
          ? {
              scopes,
              status: (scopes.includes(PLAN_USAGE_SCOPE)
                ? "connected"
                : "plan_usage_disabled") as CredentialRow["status"],
            }
          : {}),
      })
      .where(eq(userModelCredentials.id, row.id));
    await core.secrets.remove(tx, row.secretId);
    return { kind: "token", token: next.accessToken };
  });
}

/**
 * Serialized refresh (Pitfall 2): SIWC refresh tokens rotate and a reused one logs the member out, so exactly one
 * caller across every API instance refreshes. A caller takes the Redis lock (`SET NX PX`) and the row lock; a caller
 * without the Redis lock never refreshes: it re-reads under the row lock until the new token is there.
 */
async function refreshSerialized(
  core: Core,
  ctx: { organizationId: string; userId: string; credentialId: string },
): Promise<string> {
  const redis = core.bus.pub;
  const key = refreshLockKey(ctx.credentialId);
  const me = randomUUID();
  const deadline = Date.now() + REFRESH_WAIT_MS;
  let d: Discovery | null = null;
  const auth = async () => {
    d ??= await discovery(authBaseOf(core));
    return d;
  };
  for (;;) {
    const holdsLock =
      (await redis
        .set(key, me, { condition: "NX", expiration: { type: "PX", value: REFRESH_LOCK_MS } })
        .catch(() => null)) === "OK";
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshAttempt(core, ctx, holdsLock, auth);
    } finally {
      if (holdsLock) await redis.eval(RELEASE_LOCK, { keys: [key], arguments: [me] }).catch(() => 0);
    }
    switch (outcome.kind) {
      case "token":
        return outcome.token;
      case "refused":
        throw new ModelUnavailableError(outcome.reason);
      case "transient":
        throw new PlanTokenUnavailableError(outcome.code);
      case "wait":
        if (Date.now() > deadline) throw new PlanTokenUnavailableError("refresh_timeout");
        await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
    }
  }
}

/**
 * The requester's current access token, refreshed first when it expires within 5 minutes (serialized, see
 * `refreshSerialized`). Missing → `not_connected`; unusable or a dead grant → `needs_reconnect`; an auth outage →
 * `PlanTokenUnavailableError` (nothing cleared). Never log or return the result to a client.
 */
export async function accessTokenFor(tx: Tx, core: Core, userId: string): Promise<string> {
  const row = await credentialOf(tx, userId);
  if (!row) throw new ModelUnavailableError("not_connected");
  if (!row.secretId) throw new ModelUnavailableError("needs_reconnect");
  const { organizationId } = tenantOf(tx);
  const bundle = await openBundle(tx, core, row.secretId, organizationId, userId);
  if (bundle && fresh(bundle)) return bundle.accessToken;
  // An unreadable bundle is decided under the row lock: another send's refresh may have rotated (and deleted) the
  // secret this unlocked read named, so only the locked re-read can tell a rotation from a dead credential.
  return refreshSerialized(core, { organizationId, userId, credentialId: row.id });
}

/**
 * Disconnect (D-02): revoke the refresh token, then the access token, at the auth server (best effort), then delete
 * the sealed secret and the row and audit it. Idempotent: a member without a connection is a no-op. Only the
 * requester's own row is ever touched.
 */
export async function disconnectCredential(tx: Tx, core: Core, userId: string): Promise<void> {
  const { organizationId } = tenantOf(tx);
  const [row] = await tx
    .select()
    .from(userModelCredentials)
    .where(and(eq(userModelCredentials.userId, userId), eq(userModelCredentials.provider, "chatgpt_plan")))
    .for("update");
  if (!row) return;
  const bundle = row.secretId ? await openBundle(tx, core, row.secretId, organizationId, userId) : null;
  if (bundle) {
    const d = await discovery(authBaseOf(core)).catch(() => null);
    if (d) {
      await revokeTokens(d, { token: bundle.refreshToken, clientId: bundle.clientId });
      await revokeTokens(d, { token: bundle.accessToken, clientId: bundle.clientId });
    }
  }
  await tx.delete(userModelCredentials).where(eq(userModelCredentials.id, row.id));
  if (row.secretId) await core.secrets.remove(tx, row.secretId);
  await core.audit.record(tx, {
    action: "ai_credential.disconnected",
    resourceType: "user_model_credential",
    resourceId: row.id,
    metadata: { provider: "chatgpt_plan" },
  });
  await core.bus.pub.del(catalogCacheKey(row.id)).catch(() => 0);
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
