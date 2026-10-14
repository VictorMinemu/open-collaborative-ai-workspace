import { randomUUID } from "node:crypto";
import type { ConnectionStatus, ConnectorReconnectReason } from "@ocw/contracts";
import {
  connectorConnections,
  connectorOAuthClients,
  mcpServers,
  memberAccountShares,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { egressFor } from "../../lib/egress";
import { ConnectorOAuthError, discover, refreshTokens, revokeToken, type TokenBundle } from "./oauth";

/**
 * Custody of a member's own connector credential (Phase 07.4, D-01; CONN-01, CONN-02), in ADR-0017's shape: the token
 * bundle (OAuth) or the member's key (secret mode) is sealed in `app.secrets` (kind `connector_credential`) with the
 * AAD `${org}:${user}:connector:${serverId}`, so it opens only for that member, organization and connector. The
 * `connector_connections` row holds state and display metadata only.
 *
 * - Every query is keyed by the member's own user id inside `withTenant({ organizationId, userId })`: tenant RLS plus
 *   the restrictive owner-only policy (`post-migrate.sql`) make another member's row invisible (WINDOWS #170), and the
 *   connector is resolved in the same tenant transaction, so a row pointing at another organization's server is never
 *   read, refreshed or used (WINDOWS #169).
 * - Refresh is serialized across API instances (Redis `SET NX PX` + `select … for update` + re-read): rotating refresh
 *   tokens are spent exactly once. The authorization server is re-discovered before each refresh; a different issuer
 *   is a reconnect, and the stored credentials are never sent to it (RFC 9207 spirit, Pitfall 3).
 * - Terminal failures commit `needs_reconnect` in their own transaction; transient ones change nothing.
 * - Nothing here logs or returns a token, refresh token, key or client secret outside `AccessToken.headerValue`, which
 *   the caller sends upstream and redacts (`secretParts`).
 */

type ConnectionRow = typeof connectorConnections.$inferSelect;
type ServerRow = typeof mcpServers.$inferSelect;

export const connectionAad = (organizationId: string, userId: string, serverId: string) =>
  `${organizationId}:${userId}:connector:${serverId}`;

/** An access token expiring within this window is refreshed before use. */
export const REFRESH_WINDOW_MS = 60_000;
/** Cross-instance refresh lock (Redis NX) and how long a caller waits for another refresh to land. */
const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 35_000;
const REFRESH_POLL_MS = 100;
export const refreshLockKey = (connectionId: string) => `ocw:conn:refresh:${connectionId}`;
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const LAST_ERROR_MAX = 64;

/** The sealed value of a connection. */
const OAuthBundle = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().nullable(),
  scopes: z.array(z.string()),
  issuer: z.string(),
  clientId: z.string(),
  resource: z.string(),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().nullable(),
  authMethod: z.string(),
  accountLabel: z.string().nullable(),
  /** Epoch ms of the last refresh (a forced refresh within the lock window reuses it). */
  refreshedAt: z.number().optional(),
});
const SecretBundle = z.object({ kind: z.literal("secret"), value: z.string().min(1) });
export const StoredBundle = z.discriminatedUnion("kind", [OAuthBundle, SecretBundle]);
export type StoredBundle = z.infer<typeof StoredBundle>;
type OAuthBundle = z.infer<typeof OAuthBundle>;

export const oauthBundleOf = (b: TokenBundle): OAuthBundle => ({
  kind: "oauth",
  accessToken: b.accessToken,
  ...(b.refreshToken ? { refreshToken: b.refreshToken } : {}),
  expiresAt: b.expiresAt,
  scopes: b.scopes,
  issuer: b.issuer,
  clientId: b.clientId,
  resource: b.resource,
  tokenEndpoint: b.tokenEndpoint,
  revocationEndpoint: b.revocationEndpoint,
  authMethod: b.authMethod,
  accountLabel: b.accountLabel,
});

const tokenBundleOf = (b: OAuthBundle): TokenBundle => ({
  accessToken: b.accessToken,
  ...(b.refreshToken ? { refreshToken: b.refreshToken } : {}),
  expiresAt: b.expiresAt,
  scopes: b.scopes,
  issuer: b.issuer,
  clientId: b.clientId,
  resource: b.resource,
  tokenEndpoint: b.tokenEndpoint,
  revocationEndpoint: b.revocationEndpoint,
  authMethod: b.authMethod,
  accountLabel: b.accountLabel,
});

export interface ConnectionKey {
  organizationId: string;
  userId: string;
  serverId: string;
}

/** What the connector proxy sends upstream. `secretParts` = every string to redact from what comes back. */
export type AccessToken =
  | { ok: true; headerName: string; headerValue: string; secretParts: string[] }
  | { ok: false; reason: "not_connected" | "needs_reconnect" };

/** The authorization server could not be reached for a refresh: nothing was cleared, try again later. */
export class ConnectorTokenUnavailableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`connector token unavailable: ${code}`);
    this.name = "ConnectorTokenUnavailableError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- lookups

/** A per-member connector of the tx's organization (RLS), or null: another organization's id is never resolved. */
export async function perMemberServer(tx: Tx, serverId: string): Promise<ServerRow | null> {
  const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
  return row && row.authMode !== "org_secret" ? row : null;
}

/** The member's own connection to a connector (RLS: owner only), optionally locked. */
async function ownConnection(
  tx: Tx,
  userId: string,
  serverId: string,
  lock = false,
): Promise<ConnectionRow | null> {
  const q = tx
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.userId, userId), eq(connectorConnections.serverId, serverId)))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

async function openBundle(
  tx: Tx,
  core: Core,
  row: ConnectionRow,
  organizationId: string,
): Promise<StoredBundle | null> {
  if (!row.secretId) return null;
  try {
    return StoredBundle.parse(
      JSON.parse(
        await core.secrets.revealSealed(
          tx,
          row.secretId,
          connectionAad(organizationId, row.userId, row.serverId),
        ),
      ),
    );
  } catch {
    // A seal that does not open for this member (AAD), a missing row or a malformed value: fail closed.
    return null;
  }
}

/**
 * The client secret of a confidential client for this connector and issuer (keyed by issuer, MCP spec "MUST NOT
 * reuse"): the pre-registered or dynamically registered client whose id the bundle carries. Undefined for public
 * clients and when the client is gone (the refresh then needs a reconnect).
 */
export async function clientSecretFor(
  tx: Tx,
  core: Core,
  serverId: string,
  issuer: string,
  clientId: string,
): Promise<string | undefined> {
  const [client] = await tx
    .select({ secretId: connectorOAuthClients.clientSecretId })
    .from(connectorOAuthClients)
    .where(
      and(
        eq(connectorOAuthClients.serverId, serverId),
        eq(connectorOAuthClients.issuer, issuer),
        eq(connectorOAuthClients.clientId, clientId),
      ),
    )
    .limit(1);
  if (!client?.secretId) return undefined;
  return core.secrets.reveal(tx, client.secretId).catch(() => undefined);
}

function headerFor(server: ServerRow, bundle: StoredBundle): AccessToken {
  if (bundle.kind === "oauth") {
    const headerValue = `Bearer ${bundle.accessToken}`;
    return {
      ok: true,
      headerName: "Authorization",
      headerValue,
      secretParts: [bundle.accessToken, headerValue],
    };
  }
  const headerValue = `${server.memberHeaderPrefix ?? ""}${bundle.value}`;
  return {
    ok: true,
    headerName: server.memberHeaderName ?? "Authorization",
    headerValue,
    secretParts: [...new Set([bundle.value, headerValue])],
  };
}

const fresh = (b: OAuthBundle) => b.expiresAt === null || b.expiresAt - Date.now() > REFRESH_WINDOW_MS;

// ---------------------------------------------------------------- storing

/**
 * Seals the bundle and upserts the member's row (`connected`, `last_error` null). A reconnect re-seals the existing
 * secret in place (`replaceSealed`: same id), so no stale credential is left behind.
 */
export async function storeConnection(
  tx: Tx,
  core: Core,
  p: { userId: string; serverId: string; bundle: StoredBundle },
): Promise<ConnectionRow> {
  const { organizationId } = tenantOf(tx);
  const aad = connectionAad(organizationId, p.userId, p.serverId);
  const value = JSON.stringify(StoredBundle.parse(p.bundle));
  const previous = await ownConnection(tx, p.userId, p.serverId, true);
  let secretId = previous?.secretId ?? null;
  if (secretId) {
    try {
      await core.secrets.replaceSealed(tx, secretId, value, aad);
    } catch {
      secretId = null;
    }
  }
  secretId ??= await core.secrets.putSealed(tx, {
    name: "Connector sign-in",
    kind: "connector_credential",
    provider: p.serverId,
    value,
    aad,
  });
  const now = new Date().toISOString();
  const oauth = p.bundle.kind === "oauth" ? p.bundle : null;
  const values = {
    status: "connected" as const,
    secretId,
    issuer: oauth?.issuer ?? null,
    clientId: oauth?.clientId ?? null,
    scopes: oauth?.scopes ?? [],
    accountLabel: oauth?.accountLabel ?? null,
    accessExpiresAt: oauth?.expiresAt ? new Date(oauth.expiresAt).toISOString() : null,
    lastError: null,
    connectedAt: now,
    updatedAt: now,
  };
  const [row] = await tx
    .insert(connectorConnections)
    .values({ organizationId, userId: p.userId, serverId: p.serverId, ...values })
    .onConflictDoUpdate({
      target: [
        connectorConnections.organizationId,
        connectorConnections.userId,
        connectorConnections.serverId,
      ],
      set: values,
    })
    .returning();
  if (!row) throw new Error("connection upsert returned no row");
  return row;
}

// ---------------------------------------------------------------- reconnect state

/** UI-SPEC R2: why a connection needs reconnecting, from its stored terminal code. */
export function reconnectReasonOf(lastError: string | null): ConnectorReconnectReason {
  switch (lastError) {
    case "invalid_grant":
    case "refresh_token_reused":
    case "access_denied":
    case "invalid_client":
    case "unauthorized_client":
    case "upstream_unauthorized":
      return "revoked";
    case "issuer_changed":
      return "provider_changed";
    default:
      return "expired";
  }
}

async function markInTx(tx: Tx, core: Core, row: ConnectionRow, code: string): Promise<void> {
  const lastError = code.slice(0, LAST_ERROR_MAX);
  await tx
    .update(connectorConnections)
    .set({ status: "needs_reconnect", secretId: null, lastError, updatedAt: new Date().toISOString() })
    .where(eq(connectorConnections.id, row.id));
  // The grant is dead: its sealed bundle goes too (it opened for this member, so it is theirs).
  if (row.secretId) await core.secrets.remove(tx, row.secretId);
  await core.audit.record(tx, {
    action: "connector.needs_reconnect",
    resourceType: "connector_connection",
    resourceId: row.id,
    metadata: { serverId: row.serverId, code: lastError },
  });
}

/**
 * Marks the member's connection `needs_reconnect` with a short code (e.g. `upstream_unauthorized` after a refreshed
 * token still got a 401), in its own committed transaction, and audits it. No-op without a connected row.
 */
export async function markNeedsReconnect(core: Core, p: ConnectionKey & { code: string }): Promise<void> {
  await core.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, async (tx) => {
    if (!(await perMemberServer(tx, p.serverId))) return;
    const row = await ownConnection(tx, p.userId, p.serverId, true);
    if (row?.status !== "connected") return;
    await markInTx(tx, core, row, p.code);
  });
}

// ---------------------------------------------------------------- access tokens and refresh

type Attempt = { kind: "token"; token: AccessToken } | { kind: "wait" } | { kind: "transient"; code: string };

const refused = (reason: "not_connected" | "needs_reconnect"): Attempt => ({
  kind: "token",
  token: { ok: false, reason },
});

/**
 * One refresh attempt in its OWN transaction (a `needs_reconnect` transition commits even though the caller then
 * fails): lock the row, re-read the bundle (another instance may have refreshed), and only the holder of the Redis lock
 * calls the authorization server.
 */
async function refreshAttempt(
  core: Core,
  key: ConnectionKey & { connectionId: string },
  holdsLock: boolean,
  force: { staleToken: string } | null,
): Promise<Attempt> {
  return core.db.withTenant({ organizationId: key.organizationId, userId: key.userId }, async (tx) => {
    const server = await perMemberServer(tx, key.serverId);
    if (!server) return refused("not_connected");
    const [row] = await tx
      .select()
      .from(connectorConnections)
      .where(and(eq(connectorConnections.id, key.connectionId), eq(connectorConnections.userId, key.userId)))
      .for("update");
    if (!row) return refused("not_connected");
    if (row.status !== "connected") return refused("needs_reconnect");
    const bundle = await openBundle(tx, core, row, key.organizationId);
    if (!bundle) return refused("needs_reconnect");
    if (bundle.kind !== "oauth") return { kind: "token", token: headerFor(server, bundle) };
    if (force) {
      // Someone refreshed since the caller's 401, or within the lock window: reuse that token.
      const recent = bundle.refreshedAt !== undefined && Date.now() - bundle.refreshedAt < REFRESH_LOCK_MS;
      if (bundle.accessToken !== force.staleToken || recent) {
        return { kind: "token", token: headerFor(server, bundle) };
      }
    } else if (fresh(bundle)) {
      return { kind: "token", token: headerFor(server, bundle) };
    }
    if (!holdsLock) return { kind: "wait" };
    if (!bundle.refreshToken) {
      await markInTx(tx, core, row, "expired_no_refresh");
      return refused("needs_reconnect");
    }

    const egress = egressFor(core.env);
    // The issuer may have changed since the grant (Pitfall 3): never send its credentials to another one.
    if (server.url) {
      const current = await discover(egress, server.url).catch(() => null);
      if (current && current.issuer !== bundle.issuer) {
        core.log.warn({ serverId: key.serverId, code: "issuer_changed" }, "connector issuer changed");
        await markInTx(tx, core, row, "issuer_changed");
        return refused("needs_reconnect");
      }
    }
    const clientSecret = await clientSecretFor(tx, core, key.serverId, bundle.issuer, bundle.clientId);
    let next: TokenBundle;
    try {
      next = await refreshTokens(egress, tokenBundleOf(bundle), clientSecret);
    } catch (err) {
      const e = err instanceof ConnectorOAuthError ? err : null;
      const code = e?.oauthError ?? e?.code ?? "refresh_failed";
      core.log.warn(
        { serverId: key.serverId, code, terminal: !!e?.terminal },
        "connector token refresh failed",
      );
      if (e?.terminal) {
        await markInTx(tx, core, row, code);
        return refused("needs_reconnect");
      }
      return { kind: "transient", code };
    }
    const stored: OAuthBundle = { ...oauthBundleOf(next), refreshedAt: Date.now() };
    if (!row.secretId) return refused("needs_reconnect");
    await core.secrets.replaceSealed(
      tx,
      row.secretId,
      JSON.stringify(stored),
      connectionAad(key.organizationId, key.userId, key.serverId),
    );
    await tx
      .update(connectorConnections)
      .set({
        accessExpiresAt: stored.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
        scopes: stored.scopes,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connectorConnections.id, row.id));
    return { kind: "token", token: headerFor(server, stored) };
  });
}

/**
 * Serialized refresh (Pitfall 2): exactly one caller across every API instance spends the refresh token. A caller
 * without the Redis lock never refreshes; it re-reads under the row lock until the new token is there.
 */
async function refreshSerialized(
  core: Core,
  key: ConnectionKey & { connectionId: string },
  force: { staleToken: string } | null,
): Promise<AccessToken> {
  const redis = core.bus.pub;
  const lock = refreshLockKey(key.connectionId);
  const me = randomUUID();
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    const holdsLock =
      (await redis
        .set(lock, me, { condition: "NX", expiration: { type: "PX", value: REFRESH_LOCK_MS } })
        .catch(() => null)) === "OK";
    let outcome: Attempt;
    try {
      outcome = await refreshAttempt(core, key, holdsLock, force);
    } finally {
      if (holdsLock) await redis.eval(RELEASE_LOCK, { keys: [lock], arguments: [me] }).catch(() => 0);
    }
    switch (outcome.kind) {
      case "token":
        return outcome.token;
      case "transient":
        throw new ConnectorTokenUnavailableError(outcome.code);
      case "wait":
        if (Date.now() > deadline) throw new ConnectorTokenUnavailableError("refresh_timeout");
        await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
    }
  }
}

/** The member's connection and opened bundle, read in one tenant transaction (no refresh). */
async function current(
  core: Core,
  p: ConnectionKey,
): Promise<
  | { kind: "refused"; reason: "not_connected" | "needs_reconnect" }
  | { kind: "ready"; server: ServerRow; row: ConnectionRow; bundle: StoredBundle }
> {
  return core.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, async (tx) => {
    const server = await perMemberServer(tx, p.serverId);
    if (!server) return { kind: "refused", reason: "not_connected" };
    const row = await ownConnection(tx, p.userId, p.serverId);
    if (!row) return { kind: "refused", reason: "not_connected" };
    if (row.status !== "connected") return { kind: "refused", reason: "needs_reconnect" };
    const bundle = await openBundle(tx, core, row, p.organizationId);
    if (!bundle) return { kind: "refused", reason: "needs_reconnect" };
    return { kind: "ready", server, row, bundle };
  });
}

/**
 * The header the connector proxy sends for this member (07.4-11/12): the member's key, or their access token refreshed
 * first when it expires within a minute (serialized). Missing → `not_connected`; a dead grant, an issuer change or a
 * credential that does not open for this member → `needs_reconnect`; an authorization server outage →
 * `ConnectorTokenUnavailableError` (nothing cleared). Never log or return the result to a client.
 */
export async function accessTokenFor(core: Core, p: ConnectionKey): Promise<AccessToken> {
  const c = await current(core, p);
  if (c.kind === "refused") return { ok: false, reason: c.reason };
  if (c.bundle.kind === "secret" || fresh(c.bundle)) return headerFor(c.server, c.bundle);
  return refreshSerialized(core, { ...p, connectionId: c.row.id }, null);
}

/**
 * After an upstream 401 on a token that still looked valid: one refresh, shared by every caller that saw the same
 * token (a second forced refresh within the lock window reuses the result). A key has nothing to refresh: the same
 * header comes back, and the caller marks `needs_reconnect` (`upstream_unauthorized`) if it is refused again.
 */
export async function forceRefresh(core: Core, p: ConnectionKey): Promise<AccessToken> {
  const c = await current(core, p);
  if (c.kind === "refused") return { ok: false, reason: c.reason };
  if (c.bundle.kind === "secret") return headerFor(c.server, c.bundle);
  return refreshSerialized(core, { ...p, connectionId: c.row.id }, { staleToken: c.bundle.accessToken });
}

// ---------------------------------------------------------------- statuses, use and disconnect

/** The member's connection status per connector id (no row = `not_connected`). */
export async function connectionStatusFor(
  tx: Tx,
  userId: string,
  serverIds: string[],
): Promise<Map<string, ConnectionStatus>> {
  const out = new Map<string, ConnectionStatus>(serverIds.map((id) => [id, "not_connected"]));
  if (serverIds.length === 0) return out;
  const rows = await tx
    .select({ serverId: connectorConnections.serverId, status: connectorConnections.status })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.userId, userId), inArray(connectorConnections.serverId, serverIds)));
  for (const r of rows) out.set(r.serverId, r.status);
  return out;
}

/** Stamps `last_used_at` on the member's connection (the connector proxy, after a call). */
export async function touchConnection(tx: Tx, p: { userId: string; serverId: string }): Promise<void> {
  await tx
    .update(connectorConnections)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(and(eq(connectorConnections.userId, p.userId), eq(connectorConnections.serverId, p.serverId)));
}

/**
 * Disconnect (CONN-02): revoke the refresh token (else the access token) at the authorization server, best effort and
 * outside any transaction, with the confidential client's secret; then delete the sealed secret and the row, revoke the
 * member's active shares of this connector and audit `connector.disconnected`. Only the member's own row is ever
 * touched; null when they had none.
 */
export async function disconnect(core: Core, p: ConnectionKey): Promise<{ revoked: boolean } | null> {
  const ctx = { organizationId: p.organizationId, userId: p.userId };
  const found = await core.db.withTenant(ctx, async (tx) => {
    if (!(await perMemberServer(tx, p.serverId))) return null;
    const row = await ownConnection(tx, p.userId, p.serverId);
    if (!row) return null;
    const bundle = await openBundle(tx, core, row, p.organizationId);
    const clientSecret =
      bundle?.kind === "oauth"
        ? await clientSecretFor(tx, core, p.serverId, bundle.issuer, bundle.clientId)
        : undefined;
    return { bundle, clientSecret };
  });
  if (!found) return null;
  const revoked =
    found.bundle?.kind === "oauth"
      ? await revokeToken(egressFor(core.env), tokenBundleOf(found.bundle), found.clientSecret)
      : false;
  return core.db.withTenant(ctx, async (tx) => {
    const row = await ownConnection(tx, p.userId, p.serverId, true);
    if (!row) return null;
    await tx.delete(connectorConnections).where(eq(connectorConnections.id, row.id));
    if (row.secretId) await core.secrets.remove(tx, row.secretId);
    const shares = await tx
      .update(memberAccountShares)
      .set({ revokedAt: new Date().toISOString() })
      .where(
        and(
          eq(memberAccountShares.userId, p.userId),
          eq(memberAccountShares.resourceKind, "connector"),
          eq(memberAccountShares.resourceId, p.serverId),
          isNull(memberAccountShares.revokedAt),
        ),
      )
      .returning({ id: memberAccountShares.id });
    await core.audit.record(tx, {
      action: "connector.disconnected",
      resourceType: "connector_connection",
      resourceId: row.id,
      metadata: {
        serverId: p.serverId,
        revoked,
        ...(shares.length > 0 ? { sharesRevoked: shares.length } : {}),
      },
    });
    return { revoked };
  });
}
