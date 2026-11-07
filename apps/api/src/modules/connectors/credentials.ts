import { randomUUID } from "node:crypto";
import {
  type ConnectionStatus,
  type ConnectorAuthMode,
  type ConnectorReconnectReason,
  isOrgCredentialMode,
  isPerMemberMode,
} from "@ocw/contracts";
import {
  connectorConnections,
  connectorOAuthClients,
  connectorOrgConnections,
  mcpServers,
  memberAccountShares,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { egressFor, hostPortOf } from "../../lib/egress";
import { reconnectReasonOfCode } from "../mcp";
import {
  type ClientCredentialsToken,
  ConnectorOAuthError,
  clientCredentialsGrant,
  discover,
  discoverTokenEndpoint,
  refreshTokens,
  resourceCovers,
  revokeToken,
  type TokenBundle,
  type TokenEndpointDiscovery,
} from "./oauth";

/**
 * Custody of connector credentials, for two principals (Phase 07.4 D-01, CONN-01/02; Phase 07.14 D-06, D-07, PD-04).
 * In ADR-0017's shape, the token bundle (OAuth) or the member's key (secret mode) is sealed in `app.secrets` (kind
 * `connector_credential`); the rows hold state and display metadata only.
 *
 * - **Member** (`ConnectionKey`): `connector_connections`, AAD `${org}:${user}:connector:${serverId}`. Every query is
 *   keyed by the member's own user id inside `withTenant({ organizationId, userId })`: tenant RLS plus the restrictive
 *   owner-only policy (`post-migrate.sql`) make another member's row invisible (WINDOWS #170).
 * - **Organization** (`OrgConnectionKey`): `connector_org_connections`, one row per server, AAD
 *   `${org}:org:connector:${serverId}`, read inside `withTenant({ organizationId, userId: actingUserId })` (tenant
 *   RLS). The AADs cannot collide: a member AAD's second segment is a user UUID, never the literal `org`, so a bundle
 *   swapped from one principal to the other never opens.
 * - The connector is resolved in the same tenant transaction for both, in its principal's modes only, so a row
 *   pointing at another organization's server, or at a server in the other principal's mode, is never read, refreshed
 *   or used (WINDOWS #169).
 * - Refresh is serialized across API instances (Redis `SET NX PX` + `select … for update` + re-read), one shared
 *   implementation for both principals: rotating refresh tokens are spent exactly once. The authorization server is
 *   re-discovered before each refresh; a different issuer is a reconnect, and the stored credentials are never sent to
 *   it (RFC 9207 spirit, Pitfall 3).
 * - Terminal failures commit `needs_reconnect` in their own transaction; transient ones change nothing. The dropped
 *   grant is then revoked best effort at the issuer that granted it, when its client is still known (WINDOWS #193).
 * - Nothing here logs or returns a token, refresh token, key or client secret outside `AccessToken.headerValue`, which
 *   the caller sends upstream and redacts (`secretParts`).
 */

type ConnectionRow = typeof connectorConnections.$inferSelect;
type OrgConnectionRow = typeof connectorOrgConnections.$inferSelect;
type ServerRow = typeof mcpServers.$inferSelect;

export const connectionAad = (organizationId: string, userId: string, serverId: string) =>
  `${organizationId}:${userId}:connector:${serverId}`;
/** The organization's AAD for a server's shared account (07.14 PD-04). */
export const orgConnectionAad = (organizationId: string, serverId: string) =>
  `${organizationId}:org:connector:${serverId}`;

/** An access token expiring within this window is refreshed before use. */
export const REFRESH_WINDOW_MS = 60_000;
/** Cross-instance refresh lock (Redis NX) and how long a caller waits for another refresh to land. */
const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 35_000;
const REFRESH_POLL_MS = 100;
export const refreshLockKey = (connectionId: string) => `ocw:conn:refresh:${connectionId}`;
/** The organization's refresh lock is per server: there is one organization connection per server. */
export const orgRefreshLockKey = (serverId: string) => `ocw:conn:refresh:org:${serverId}`;
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
/**
 * A member's key. `serverUrl` is the server URL it was entered for (07.14 review CR-01): it is sent only while the
 * server still has that URL. Keys stored before it was recorded have none; a URL change on their server destroys them
 * (the registry's confirmation), so they never meet another URL.
 */
const SecretBundle = z.object({
  kind: z.literal("secret"),
  value: z.string().min(1),
  serverUrl: z.string().optional(),
});
/**
 * The organization's client credentials (07.14 D-03, PD-07): the client and where its secret may go (the token endpoint
 * of the issuer pinned at save time; null = an admin-entered Token URL without metadata), with the current token. There
 * is no refresh token: a renewal is a new grant with the same secret.
 */
const ClientCredentialsBundle = z.object({
  kind: z.literal("client_credentials"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenEndpoint: z.string(),
  issuer: z.string().nullable(),
  resource: z.string(),
  revocationEndpoint: z.string().nullable(),
  authMethod: z.enum(["client_secret_basic", "client_secret_post"]),
  /** The scopes asked for (empty = none sent); the row keeps the granted ones. */
  scopes: z.array(z.string()),
  accessToken: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  /** Epoch ms of the last grant (a forced re-grant within the lock window reuses it). */
  refreshedAt: z.number().optional(),
});
export const StoredBundle = z.discriminatedUnion("kind", [
  OAuthBundle,
  SecretBundle,
  ClientCredentialsBundle,
]);
export type StoredBundle = z.infer<typeof StoredBundle>;
type OAuthBundle = z.infer<typeof OAuthBundle>;
export type ClientCredentialsBundle = z.infer<typeof ClientCredentialsBundle>;

/**
 * The sealed client-credentials bundle of a save (pure): where the secret goes (the discovered endpoint, else the
 * admin's), the pinned issuer, the resource, the auth method the grant used, the scopes asked for and the token.
 */
export function ccBundleFrom(
  discovery: Pick<TokenEndpointDiscovery, "issuer" | "resource" | "revocationEndpoint">,
  input: { clientId: string; clientSecret: string; tokenEndpoint: string; scopes: string[] },
  token: ClientCredentialsToken,
): ClientCredentialsBundle {
  return {
    kind: "client_credentials",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    tokenEndpoint: input.tokenEndpoint,
    issuer: discovery.issuer,
    resource: discovery.resource,
    revocationEndpoint: discovery.revocationEndpoint,
    authMethod: token.authMethod,
    scopes: [...input.scopes],
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    // No `refreshedAt`: a token refused right after the save is re-granted (only a re-grant opens the reuse window).
  };
}

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

/**
 * What RFC 7009 revocation needs of a client-credentials bundle: its access token (there is no refresh token), at the
 * revocation endpoint published with the pinned issuer, never one an admin typed (null then: nothing is sent).
 */
function ccRevocationOf(b: ClientCredentialsBundle): TokenBundle | null {
  if (!b.accessToken || !b.revocationEndpoint) return null;
  return {
    accessToken: b.accessToken,
    expiresAt: b.expiresAt ?? null,
    scopes: b.scopes,
    issuer: b.issuer ?? "",
    clientId: b.clientId,
    resource: b.resource,
    tokenEndpoint: b.tokenEndpoint,
    revocationEndpoint: b.revocationEndpoint,
    authMethod: b.authMethod,
    accountLabel: null,
  };
}

/** A member's own credential for a per-member connector (07.4). */
export interface ConnectionKey {
  organizationId: string;
  userId: string;
  serverId: string;
}

/**
 * The organization's shared credential for an organization-account server (07.14 PD-04). `actingUserId` is the human
 * on whose request it is used (the turn's member, the admin who connects or re-probes): the tenant transaction and its
 * audit rows carry them. Null for system work.
 */
export interface OrgConnectionKey {
  organizationId: string;
  serverId: string;
  principal: "organization";
  actingUserId: string | null;
}

export type CredentialKey = ConnectionKey | OrgConnectionKey;

export const isOrgKey = (key: CredentialKey): key is OrgConnectionKey =>
  "principal" in key && key.principal === "organization";

/** The credential a call to this server uses: the organization's for the org modes, else the caller's own. */
export function credentialKeyOf(
  server: { id: string; authMode: ConnectorAuthMode },
  ctx: { organizationId: string; userId: string },
): CredentialKey {
  return isOrgCredentialMode(server.authMode)
    ? {
        organizationId: ctx.organizationId,
        serverId: server.id,
        principal: "organization",
        actingUserId: ctx.userId,
      }
    : { organizationId: ctx.organizationId, userId: ctx.userId, serverId: server.id };
}

/**
 * What the connector proxy sends upstream. `secretParts` = every string to redact from what comes back. `url` = the
 * server URL the credential was checked against (07.14 review CR-01): the caller sends it there and nowhere else, and
 * refuses when the server it is about to call has another URL.
 */
export type AccessToken =
  | { ok: true; headerName: string; headerValue: string; secretParts: string[]; url: string }
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
export async function perMemberServer(tx: Tx, serverId: string, lock = false): Promise<ServerRow | null> {
  const q = tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
  // `for share`: members store concurrently, while the registry's URL or mode change (`for update`) waits, or has
  // already committed and is the version read here.
  const [row] = lock ? await q.for("share") : await q;
  return row && isPerMemberMode(row.authMode) ? row : null;
}

/**
 * An organization-account server (`org_oauth` / `org_client_credentials`) of the tx's organization (RLS), or null.
 * `lock` takes the server row (`for update`): a store holds it so that a concurrent mode switch or delete waits.
 */
export async function orgAccountServer(tx: Tx, serverId: string, lock = false): Promise<ServerRow | null> {
  const q = tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row && isOrgCredentialMode(row.authMode) ? row : null;
}

/**
 * The organization's stored client credentials of a server, opened in the caller's tenant transaction (RLS: another
 * organization's server is never read), or null. For the save route (keep the secret when it is omitted) and the Test
 * sign-in (use the stored values when the form omits them). Never logged or returned to a client.
 */
export async function orgClientCredentialsOf(
  tx: Tx,
  core: Core,
  serverId: string,
): Promise<ClientCredentialsBundle | null> {
  if (!(await orgAccountServer(tx, serverId))) return null;
  const row = await orgConnection(tx, serverId);
  if (!row?.secretId) return null;
  const { organizationId } = tenantOf(tx);
  try {
    const bundle = StoredBundle.parse(
      JSON.parse(
        await core.secrets.revealSealed(tx, row.secretId, orgConnectionAad(organizationId, serverId)),
      ),
    );
    return bundle.kind === "client_credentials" ? bundle : null;
  } catch {
    return null;
  }
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

/** The organization's connection of a server (tenant RLS), optionally locked. */
async function orgConnection(tx: Tx, serverId: string, lock = false): Promise<OrgConnectionRow | null> {
  const q = tx
    .select()
    .from(connectorOrgConnections)
    .where(eq(connectorOrgConnections.serverId, serverId))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/** The fields of a credential row the shared custody code reads (both tables have them). */
interface CredentialRow {
  id: string;
  serverId: string;
  status: "connected" | "needs_reconnect";
  secretId: string | null;
}

type CredentialUpdate = Partial<
  Pick<ConnectionRow, "status" | "secretId" | "lastError" | "accessExpiresAt" | "scopes" | "updatedAt">
>;

/**
 * Where one principal's credential lives (PD-04): the row lookup and its lock, the server lookup in that principal's
 * modes, the AAD, the refresh lock key, the `needs_reconnect` / refreshed writes and the audit names. `refreshAttempt`,
 * `refreshSerialized`, `current` and `markInTx` are written once over it.
 */
interface CredentialStore {
  tenant: { organizationId: string; userId: string | null };
  serverId: string;
  aad: string;
  /** Bundle kinds this principal may hold: anything else fails closed. */
  kinds: ReadonlySet<StoredBundle["kind"]>;
  lockKey(rowId: string): string;
  server(tx: Tx): Promise<ServerRow | null>;
  row(tx: Tx, lock?: boolean): Promise<CredentialRow | null>;
  update(tx: Tx, rowId: string, set: CredentialUpdate): Promise<void>;
  audit: { needsReconnect: string; resourceType: string };
}

const MEMBER_KINDS: ReadonlySet<StoredBundle["kind"]> = new Set(["oauth", "secret"]);
const ORG_KINDS: ReadonlySet<StoredBundle["kind"]> = new Set(["oauth", "client_credentials"]);

function storeOf(key: CredentialKey): CredentialStore {
  if (isOrgKey(key)) {
    return {
      tenant: { organizationId: key.organizationId, userId: key.actingUserId },
      serverId: key.serverId,
      aad: orgConnectionAad(key.organizationId, key.serverId),
      kinds: ORG_KINDS,
      lockKey: () => orgRefreshLockKey(key.serverId),
      server: (tx) => orgAccountServer(tx, key.serverId),
      row: (tx, lock) => orgConnection(tx, key.serverId, lock),
      update: async (tx, rowId, set) => {
        await tx.update(connectorOrgConnections).set(set).where(eq(connectorOrgConnections.id, rowId));
      },
      audit: { needsReconnect: "connector.org_needs_reconnect", resourceType: "connector_org_connection" },
    };
  }
  return {
    tenant: { organizationId: key.organizationId, userId: key.userId },
    serverId: key.serverId,
    aad: connectionAad(key.organizationId, key.userId, key.serverId),
    kinds: MEMBER_KINDS,
    lockKey: refreshLockKey,
    server: (tx) => perMemberServer(tx, key.serverId),
    row: (tx, lock) => ownConnection(tx, key.userId, key.serverId, lock),
    update: async (tx, rowId, set) => {
      await tx.update(connectorConnections).set(set).where(eq(connectorConnections.id, rowId));
    },
    audit: { needsReconnect: "connector.needs_reconnect", resourceType: "connector_connection" },
  };
}

async function openBundle(
  tx: Tx,
  core: Core,
  store: CredentialStore,
  row: CredentialRow,
): Promise<StoredBundle | null> {
  if (!row.secretId) return null;
  try {
    const bundle = StoredBundle.parse(
      JSON.parse(await core.secrets.revealSealed(tx, row.secretId, store.aad)),
    );
    return store.kinds.has(bundle.kind) ? bundle : null;
  } catch {
    // A seal that does not open for this principal (AAD), a missing row or a malformed value: fail closed.
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

/**
 * Whether a credential may be sent to the server's current URL (07.14 review CR-01): an OAuth or client-credentials
 * token only while its RFC 8707 `resource` covers that URL, a member's key only while the URL is the one it was entered
 * for. A URL changed behind the credential's back (a race with the registry's confirm-and-destroy) is refused.
 */
export function boundTo(server: Pick<ServerRow, "url">, bundle: StoredBundle): boolean {
  if (!server.url) return false;
  if (bundle.kind === "secret") return bundle.serverUrl === undefined || bundle.serverUrl === server.url;
  return resourceCovers(bundle.resource, server.url);
}

/** The terminal code of a credential whose server URL changed since it was stored (maps to `provider_changed`). */
const URL_CHANGED = "url_changed";

function headerFor(server: ServerRow, bundle: StoredBundle): AccessToken {
  const url = server.url ?? "";
  if (bundle.kind === "oauth") {
    const headerValue = `Bearer ${bundle.accessToken}`;
    return {
      ok: true,
      headerName: "Authorization",
      headerValue,
      secretParts: [bundle.accessToken, headerValue],
      url,
    };
  }
  if (bundle.kind === "client_credentials") {
    // Never granted (not a state a save leaves): fail closed.
    if (!bundle.accessToken) return { ok: false, reason: "needs_reconnect" };
    const headerValue = `Bearer ${bundle.accessToken}`;
    // The client secret too: a server that echoes it back is redacted like the token.
    return {
      ok: true,
      headerName: "Authorization",
      headerValue,
      secretParts: [bundle.accessToken, headerValue, bundle.clientSecret],
      url,
    };
  }
  const headerValue = `${server.memberHeaderPrefix ?? ""}${bundle.value}`;
  return {
    ok: true,
    headerName: server.memberHeaderName ?? "Authorization",
    headerValue,
    secretParts: [...new Set([bundle.value, headerValue])],
    url,
  };
}

/**
 * Usable as is: an OAuth token without an expiry or expiring after the window, a client-credentials token expiring
 * after the window (one expiring within it, exactly 60 s included, is re-granted first; 07.14 D-07).
 */
function fresh(b: OAuthBundle | ClientCredentialsBundle): boolean {
  if (b.kind === "oauth") return b.expiresAt === null || b.expiresAt - Date.now() > REFRESH_WINDOW_MS;
  return (
    b.accessToken !== undefined && b.expiresAt !== undefined && b.expiresAt - Date.now() > REFRESH_WINDOW_MS
  );
}

// ---------------------------------------------------------------- storing

/**
 * Seals a bundle in place: a reconnect re-seals the existing secret (`replaceSealed`: same id), so no stale credential
 * is left behind; a secret that no longer opens is replaced by a new one.
 */
async function sealInPlace(
  tx: Tx,
  core: Core,
  p: { previousSecretId: string | null; serverId: string; value: string; aad: string; name: string },
): Promise<string> {
  if (p.previousSecretId) {
    try {
      await core.secrets.replaceSealed(tx, p.previousSecretId, p.value, p.aad);
      return p.previousSecretId;
    } catch {
      // Seal a new one below.
    }
  }
  return core.secrets.putSealed(tx, {
    name: p.name,
    kind: "connector_credential",
    provider: p.serverId,
    value: p.value,
    aad: p.aad,
  });
}

/** Seals the bundle and upserts the member's row (`connected`, `last_error` null), re-sealing in place. */
export async function storeConnection(
  tx: Tx,
  core: Core,
  p: { userId: string; serverId: string; bundle: StoredBundle },
): Promise<ConnectionRow> {
  const { organizationId } = tenantOf(tx);
  if (!MEMBER_KINDS.has(p.bundle.kind)) throw new Error("not a member credential");
  const previous = await ownConnection(tx, p.userId, p.serverId, true);
  const secretId = await sealInPlace(tx, core, {
    previousSecretId: previous?.secretId ?? null,
    serverId: p.serverId,
    value: JSON.stringify(StoredBundle.parse(p.bundle)),
    aad: connectionAad(organizationId, p.userId, p.serverId),
    name: "Connector sign-in",
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

/**
 * Seals the organization's bundle and upserts the server's one organization row (`connected`, `last_error` null,
 * `connected_by` = the admin), re-sealing in place (07.14 D-06). The caller holds the server row lock
 * (`orgAccountServer(tx, id, true)`), so concurrent stores for a server are serialized: the last one wins, with the
 * same secret id.
 */
export async function storeOrgConnection(
  tx: Tx,
  core: Core,
  p: {
    serverId: string;
    connectedBy: string;
    bundle: StoredBundle;
    /** Client credentials: the scopes the token was granted (the row shows them), else the bundle's. */
    grantedScopes?: string[];
  },
): Promise<OrgConnectionRow> {
  const { organizationId } = tenantOf(tx);
  if (!ORG_KINDS.has(p.bundle.kind)) throw new Error("not an organization credential");
  const previous = await orgConnection(tx, p.serverId, true);
  const secretId = await sealInPlace(tx, core, {
    previousSecretId: previous?.secretId ?? null,
    serverId: p.serverId,
    value: JSON.stringify(StoredBundle.parse(p.bundle)),
    aad: orgConnectionAad(organizationId, p.serverId),
    name: "Organization connector sign-in",
  });
  const now = new Date().toISOString();
  const b = p.bundle;
  const cc = b.kind === "client_credentials" ? b : null;
  const oauth = b.kind === "oauth" ? b : null;
  const expiresAt = cc?.expiresAt ?? oauth?.expiresAt ?? null;
  const values = {
    method: cc ? ("client_credentials" as const) : ("oauth" as const),
    status: "connected" as const,
    secretId,
    issuer: cc?.issuer ?? oauth?.issuer ?? null,
    clientId: cc?.clientId ?? oauth?.clientId ?? null,
    // Client credentials: the endpoint in use (discovered or admin-entered), shown to admins; never the secret.
    tokenEndpoint: cc?.tokenEndpoint ?? null,
    scopes: p.grantedScopes ?? oauth?.scopes ?? [],
    accountLabel: oauth?.accountLabel ?? null,
    accessExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    lastError: null,
    connectedBy: p.connectedBy,
    connectedAt: now,
    updatedAt: now,
  };
  const [row] = await tx
    .insert(connectorOrgConnections)
    .values({ organizationId, serverId: p.serverId, ...values })
    .onConflictDoUpdate({
      target: [connectorOrgConnections.organizationId, connectorOrgConnections.serverId],
      set: values,
    })
    .returning();
  if (!row) throw new Error("organization connection upsert returned no row");
  return row;
}

// ---------------------------------------------------------------- reconnect state

/**
 * UI-SPEC R2: why a connection needs reconnecting, from its stored terminal code. One table for both principals: the
 * registry's (`reconnectReasonOfCode`, 07.14-05), which the organization DTO uses too.
 */
export function reconnectReasonOf(lastError: string | null): ConnectorReconnectReason {
  return reconnectReasonOfCode(lastError);
}

/**
 * A credential dropped on a terminal failure, revoked best effort at the issuer that granted it once the transaction
 * that dropped it has committed (WINDOWS #193): never inside a transaction, never at another issuer.
 */
interface DroppedGrant {
  bundle: TokenBundle;
  clientSecret: string | undefined;
}

/**
 * What to revoke for a dropped OAuth bundle: the refresh token (the whole grant) unless the authorization server just
 * refused it (`refreshRefused`), then the access token, which may still be live until it expires. Only at the issuer
 * that granted it (the stored revocation endpoint, checked again by `revokeToken`), and only while its client is still
 * known: a confidential client whose secret is gone cannot authenticate the request, so nothing is sent.
 */
async function droppedGrantOf(
  tx: Tx,
  core: Core,
  row: CredentialRow,
  bundle: StoredBundle | null,
  refreshRefused: boolean,
): Promise<DroppedGrant | null> {
  if (bundle?.kind !== "oauth" || !bundle.revocationEndpoint) return null;
  const clientSecret = await clientSecretFor(tx, core, row.serverId, bundle.issuer, bundle.clientId);
  if (bundle.authMethod !== "none" && clientSecret === undefined) return null;
  const { refreshToken, ...rest } = tokenBundleOf(bundle);
  return {
    bundle: refreshRefused || !refreshToken ? rest : { ...rest, refreshToken },
    clientSecret,
  };
}

/** Best-effort revocation of a dropped grant, outside any transaction; the outcome is logged as a code only. */
async function revokeDropped(core: Core, serverId: string, dropped: DroppedGrant | null): Promise<void> {
  if (!dropped) return;
  const revoked = await revokeToken(egressFor(core.env), dropped.bundle, dropped.clientSecret);
  core.log.info({ serverId, revoked }, "connector grant revoked at its issuer after a terminal failure");
}

async function markInTx(
  tx: Tx,
  core: Core,
  store: CredentialStore,
  row: CredentialRow,
  code: string,
  dropped: { bundle: StoredBundle | null; refreshRefused: boolean },
): Promise<DroppedGrant | null> {
  const lastError = code.slice(0, LAST_ERROR_MAX);
  const revoke = await droppedGrantOf(tx, core, row, dropped.bundle, dropped.refreshRefused);
  await store.update(tx, row.id, {
    status: "needs_reconnect",
    secretId: null,
    lastError,
    updatedAt: new Date().toISOString(),
  });
  // The grant is dead: its sealed bundle goes too (it opened for this principal, so it is theirs).
  if (row.secretId) await core.secrets.remove(tx, row.secretId);
  await core.audit.record(tx, {
    action: store.audit.needsReconnect,
    resourceType: store.audit.resourceType,
    resourceId: row.id,
    metadata: { serverId: row.serverId, code: lastError, revokeAtIssuer: revoke !== null },
  });
  return revoke;
}

/**
 * Marks the connection `needs_reconnect` with a short code (e.g. `upstream_unauthorized` after a refreshed token
 * still got a 401), in its own committed transaction, and audits it. No-op without a connected row.
 */
export async function markNeedsReconnect(core: Core, p: CredentialKey & { code: string }): Promise<void> {
  const store = storeOf(p);
  const dropped = await core.db.withTenant(store.tenant, async (tx) => {
    if (!(await store.server(tx))) return null;
    const row = await store.row(tx, true);
    if (row?.status !== "connected") return null;
    const bundle = await openBundle(tx, core, store, row);
    // The resource server refused a refreshed token: the grant may still be live at the issuer, so revoke it whole.
    return markInTx(tx, core, store, row, p.code, { bundle, refreshRefused: false });
  });
  await revokeDropped(core, p.serverId, dropped);
}

// ---------------------------------------------------------------- access tokens and refresh

type Attempt =
  | { kind: "token"; token: AccessToken; dropped?: DroppedGrant | null }
  | { kind: "wait" }
  | { kind: "transient"; code: string };

const refused = (reason: "not_connected" | "needs_reconnect", dropped?: DroppedGrant | null): Attempt => ({
  kind: "token",
  token: { ok: false, reason },
  dropped,
});

/** The MCP URL's origin and `host:port`: the only plain-http origin and private target its OAuth calls may reach. */
function mcpOriginsOf(serverUrl: string): { mcpOrigin: string; sameOrigin: string } | null {
  try {
    const url = new URL(serverUrl);
    return { mcpOrigin: url.origin, sameOrigin: hostPortOf(url) };
  } catch {
    return null;
  }
}

/**
 * A client-credentials re-grant (07.14 D-03, D-07, PD-07), inside `refreshAttempt`'s transaction and only by the
 * holder of the refresh lock: one token request across every API instance. Before each one the issuer pinned at save
 * time is re-discovered (when the bundle has one) and compared: a changed or vanished issuer is `needs_reconnect`
 * (`issuer_changed`) and the secret is sent nowhere; a discovery that fails sends nothing and is transient. The grant
 * uses the stored endpoint, client and auth method, and the server's current scopes (an admin's change applies at the
 * next grant). A terminal refusal (`invalid_client`, `unauthorized_client`, `invalid_scope`, …) is `needs_reconnect`
 * with that code; there is no grant left to revoke at the issuer.
 */
async function regrantInTx(
  tx: Tx,
  core: Core,
  store: CredentialStore,
  server: ServerRow,
  row: CredentialRow,
  bundle: ClientCredentialsBundle,
): Promise<Attempt> {
  const egress = egressFor(core.env);
  const dead = async (code: string) => {
    const dropped = await markInTx(tx, core, store, row, code, { bundle, refreshRefused: true });
    return refused("needs_reconnect", dropped);
  };
  if (!server.url) return { kind: "transient", code: "discovery_failed" };
  let where = mcpOriginsOf(server.url);
  if (bundle.issuer !== null) {
    let current: TokenEndpointDiscovery;
    try {
      current = await discoverTokenEndpoint(egress, server.url);
    } catch (err) {
      const code = err instanceof ConnectorOAuthError ? err.code : "discovery_failed";
      core.log.warn({ serverId: store.serverId, code }, "connector issuer re-discovery failed");
      return { kind: "transient", code };
    }
    if (current.issuer !== bundle.issuer) {
      core.log.warn({ serverId: store.serverId, code: "issuer_changed" }, "connector issuer changed");
      return dead("issuer_changed");
    }
    where = current;
  }
  if (!where) return { kind: "transient", code: "discovery_failed" };
  const scopes = [...(server.oauthScopes ?? [])];
  let token: ClientCredentialsToken;
  try {
    token = await clientCredentialsGrant(egress, {
      tokenEndpoint: bundle.tokenEndpoint,
      issuer: bundle.issuer,
      resource: bundle.resource,
      sameOrigin: where.sameOrigin,
      mcpOrigin: where.mcpOrigin,
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      scopes,
      authMethods: [bundle.authMethod],
    });
  } catch (err) {
    const e = err instanceof ConnectorOAuthError ? err : null;
    const code = e?.oauthError ?? e?.code ?? "refresh_failed";
    core.log.warn(
      { serverId: store.serverId, code, terminal: !!e?.terminal },
      "connector client-credentials grant failed",
    );
    return e?.terminal ? dead(code) : { kind: "transient", code };
  }
  const stored: ClientCredentialsBundle = {
    ...bundle,
    scopes,
    authMethod: token.authMethod,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    refreshedAt: Date.now(),
  };
  if (!row.secretId) return refused("needs_reconnect");
  await core.secrets.replaceSealed(tx, row.secretId, JSON.stringify(stored), store.aad);
  await store.update(tx, row.id, {
    accessExpiresAt: new Date(token.expiresAt).toISOString(),
    scopes: token.scopes,
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
  return { kind: "token", token: headerFor(server, stored) };
}

/**
 * One refresh attempt in its OWN transaction (a `needs_reconnect` transition commits even though the caller then
 * fails): lock the row, re-read the bundle (another instance may have refreshed), and only the holder of the Redis lock
 * calls the authorization server.
 */
async function refreshAttempt(
  core: Core,
  store: CredentialStore,
  rowId: string,
  holdsLock: boolean,
  force: { staleToken: string } | null,
): Promise<Attempt> {
  return core.db.withTenant(store.tenant, async (tx) => {
    const server = await store.server(tx);
    if (!server) return refused("not_connected");
    const row = await store.row(tx, true);
    // Gone, or replaced by another connection since the caller read it.
    if (!row || row.id !== rowId) return refused("not_connected");
    if (row.status !== "connected") return refused("needs_reconnect");
    const bundle = await openBundle(tx, core, store, row);
    if (!bundle) return refused("needs_reconnect");
    // Never refreshed, re-granted or sent for a server URL the credential was not granted for (CR-01).
    if (!boundTo(server, bundle)) {
      const dropped = await markInTx(tx, core, store, row, URL_CHANGED, { bundle, refreshRefused: false });
      return refused("needs_reconnect", dropped);
    }
    if (bundle.kind === "secret") return { kind: "token", token: headerFor(server, bundle) };
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
    if (bundle.kind === "client_credentials") return regrantInTx(tx, core, store, server, row, bundle);
    if (!bundle.refreshToken) {
      const dropped = await markInTx(tx, core, store, row, "expired_no_refresh", {
        bundle,
        refreshRefused: false,
      });
      return refused("needs_reconnect", dropped);
    }

    const egress = egressFor(core.env);
    // The issuer may have changed since the grant (Pitfall 3): never send its credentials to another one.
    if (server.url) {
      const current = await discover(egress, server.url).catch(() => null);
      if (current && current.issuer !== bundle.issuer) {
        core.log.warn({ serverId: store.serverId, code: "issuer_changed" }, "connector issuer changed");
        // Revoked at the OLD issuer that granted it (its stored revocation endpoint), never sent to the new one.
        const dropped = await markInTx(tx, core, store, row, "issuer_changed", {
          bundle,
          refreshRefused: false,
        });
        return refused("needs_reconnect", dropped);
      }
    }
    const clientSecret = await clientSecretFor(tx, core, store.serverId, bundle.issuer, bundle.clientId);
    let next: TokenBundle;
    try {
      next = await refreshTokens(egress, tokenBundleOf(bundle), clientSecret);
    } catch (err) {
      const e = err instanceof ConnectorOAuthError ? err : null;
      const code = e?.oauthError ?? e?.code ?? "refresh_failed";
      core.log.warn(
        { serverId: store.serverId, code, terminal: !!e?.terminal },
        "connector token refresh failed",
      );
      if (e?.terminal) {
        const dropped = await markInTx(tx, core, store, row, code, { bundle, refreshRefused: true });
        return refused("needs_reconnect", dropped);
      }
      return { kind: "transient", code };
    }
    const stored: OAuthBundle = { ...oauthBundleOf(next), refreshedAt: Date.now() };
    if (!row.secretId) return refused("needs_reconnect");
    await core.secrets.replaceSealed(tx, row.secretId, JSON.stringify(stored), store.aad);
    await store.update(tx, row.id, {
      accessExpiresAt: stored.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
      scopes: stored.scopes,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    return { kind: "token", token: headerFor(server, stored) };
  });
}

/**
 * Serialized refresh (Pitfall 2): exactly one caller across every API instance spends the refresh token. A caller
 * without the Redis lock never refreshes; it re-reads under the row lock until the new token is there.
 */
async function refreshSerialized(
  core: Core,
  store: CredentialStore,
  rowId: string,
  force: { staleToken: string } | null,
): Promise<AccessToken> {
  const redis = core.bus.pub;
  const lock = store.lockKey(rowId);
  const me = randomUUID();
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    const holdsLock =
      (await redis
        .set(lock, me, { condition: "NX", expiration: { type: "PX", value: REFRESH_LOCK_MS } })
        .catch(() => null)) === "OK";
    let outcome: Attempt;
    try {
      outcome = await refreshAttempt(core, store, rowId, holdsLock, force);
    } finally {
      if (holdsLock) await redis.eval(RELEASE_LOCK, { keys: [lock], arguments: [me] }).catch(() => 0);
    }
    switch (outcome.kind) {
      case "token":
        // After the attempt's transaction committed (and the lock is released): best effort, never blocks a retry.
        await revokeDropped(core, store.serverId, outcome.dropped ?? null);
        return outcome.token;
      case "transient":
        throw new ConnectorTokenUnavailableError(outcome.code);
      case "wait":
        if (Date.now() > deadline) throw new ConnectorTokenUnavailableError("refresh_timeout");
        await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
    }
  }
}

/**
 * The principal's connection and opened bundle, read in one tenant transaction (no refresh). A credential that is not
 * bound to the server's current URL (CR-01) is dropped there and then (`needs_reconnect`, `url_changed`, re-checked
 * under the row lock) and its grant is revoked at its issuer after the commit: it is never sent.
 */
async function current(
  core: Core,
  store: CredentialStore,
): Promise<
  | { kind: "refused"; reason: "not_connected" | "needs_reconnect" }
  | { kind: "ready"; server: ServerRow; row: CredentialRow; bundle: StoredBundle }
> {
  let dropped: DroppedGrant | null = null;
  const out = await core.db.withTenant(
    store.tenant,
    async (
      tx,
    ): Promise<
      | { kind: "refused"; reason: "not_connected" | "needs_reconnect" }
      | { kind: "ready"; server: ServerRow; row: CredentialRow; bundle: StoredBundle }
    > => {
      const server = await store.server(tx);
      if (!server) return { kind: "refused", reason: "not_connected" };
      const row = await store.row(tx);
      if (!row) return { kind: "refused", reason: "not_connected" };
      if (row.status !== "connected") return { kind: "refused", reason: "needs_reconnect" };
      const bundle = await openBundle(tx, core, store, row);
      if (!bundle) return { kind: "refused", reason: "needs_reconnect" };
      if (!boundTo(server, bundle)) {
        // Re-read under the row lock: drop only the credential that is still unbound (a reconnect may have landed).
        const locked = await store.row(tx, true);
        if (locked?.id === row.id && locked.status === "connected") {
          const lockedBundle = await openBundle(tx, core, store, locked);
          if (lockedBundle && !boundTo(server, lockedBundle)) {
            dropped = await markInTx(tx, core, store, locked, URL_CHANGED, {
              bundle: lockedBundle,
              refreshRefused: false,
            });
          }
        }
        return { kind: "refused", reason: "needs_reconnect" };
      }
      return { kind: "ready", server, row, bundle };
    },
  );
  await revokeDropped(core, store.serverId, dropped);
  return out;
}

/**
 * The header the connector proxy sends for this credential (07.4-11/12; the organization's since 07.14): the
 * member's key, or the access token refreshed first when it expires within a minute (serialized). Missing →
 * `not_connected`; a dead grant, an issuer change or a credential that does not open for this principal →
 * `needs_reconnect`; an authorization server outage → `ConnectorTokenUnavailableError` (nothing cleared). Never log
 * or return the result to a client.
 */
export async function accessTokenFor(core: Core, p: CredentialKey): Promise<AccessToken> {
  const store = storeOf(p);
  const c = await current(core, store);
  if (c.kind === "refused") return { ok: false, reason: c.reason };
  if (c.bundle.kind === "secret" || fresh(c.bundle)) return headerFor(c.server, c.bundle);
  return refreshSerialized(core, store, c.row.id, null);
}

/**
 * After an upstream 401 on a token that still looked valid: one refresh, shared by every caller that saw the same
 * token (a second forced refresh within the lock window reuses the result). A key has nothing to refresh: the same
 * header comes back, and the caller marks `needs_reconnect` (`upstream_unauthorized`) if it is refused again.
 */
export async function forceRefresh(core: Core, p: CredentialKey): Promise<AccessToken> {
  const store = storeOf(p);
  const c = await current(core, store);
  if (c.kind === "refused") return { ok: false, reason: c.reason };
  if (c.bundle.kind === "secret") return headerFor(c.server, c.bundle);
  return refreshSerialized(core, store, c.row.id, { staleToken: c.bundle.accessToken ?? "" });
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

/**
 * The status of the credential a key names (no row = `not_connected`): the member's own row for a member key
 * (`connectionStatusFor`), the server's organization row for an organization key, only while the server is an
 * organization-account one of the tx's organization (RLS).
 */
export async function credentialStatusFor(tx: Tx, key: CredentialKey): Promise<ConnectionStatus> {
  if (!isOrgKey(key)) {
    return (await connectionStatusFor(tx, key.userId, [key.serverId])).get(key.serverId) ?? "not_connected";
  }
  if (!(await orgAccountServer(tx, key.serverId))) return "not_connected";
  return (await orgConnection(tx, key.serverId))?.status ?? "not_connected";
}

/** Stamps `last_used_at` on the credential a key names (the connector proxy, after a call). */
export async function touchCredential(tx: Tx, key: CredentialKey): Promise<void> {
  if (!isOrgKey(key)) return touchConnection(tx, key);
  await tx
    .update(connectorOrgConnections)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(connectorOrgConnections.serverId, key.serverId));
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
  const store = storeOf(p);
  const found = await core.db.withTenant(ctx, async (tx) => {
    if (!(await perMemberServer(tx, p.serverId))) return null;
    const row = await ownConnection(tx, p.userId, p.serverId);
    if (!row) return null;
    const bundle = await openBundle(tx, core, store, row);
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

/**
 * The admin's Disconnect of the organization's account (07.14 D-08), mirroring `disconnect`: the bundle and the
 * confidential client's secret are read in one tenant transaction, the grant is revoked at the authorization server
 * outside any transaction (RFC 7009, best effort: the refresh token, else the access token), then the row and its
 * sealed secret are deleted and the disconnect is audited (`reason: admin`, `revoked`) in a second one.
 * Null when the server has no organization connection (nothing is sent then).
 */
export async function disconnectOrg(
  core: Core,
  p: { organizationId: string; serverId: string; actingUserId: string },
): Promise<{ revoked: boolean } | null> {
  const key: OrgConnectionKey = { ...p, principal: "organization" };
  const store = storeOf(key);
  const found = await core.db.withTenant(store.tenant, async (tx) => {
    if (!(await store.server(tx))) return null;
    const row = await orgConnection(tx, p.serverId);
    if (!row) return null;
    const bundle = await openBundle(tx, core, store, row);
    if (bundle?.kind === "client_credentials") {
      // Client credentials: the access token is the whole grant; the client's own secret authenticates the revocation.
      return { revoke: ccRevocationOf(bundle), clientSecret: bundle.clientSecret };
    }
    if (bundle?.kind !== "oauth") return { revoke: null, clientSecret: undefined };
    return {
      revoke: tokenBundleOf(bundle),
      clientSecret: await clientSecretFor(tx, core, p.serverId, bundle.issuer, bundle.clientId),
    };
  });
  if (!found) return null;
  const revoked = found.revoke
    ? await revokeToken(egressFor(core.env), found.revoke, found.clientSecret)
    : false;
  return core.db.withTenant(store.tenant, async (tx) => {
    const row = await orgConnection(tx, p.serverId, true);
    if (!row) return null;
    await tx.delete(connectorOrgConnections).where(eq(connectorOrgConnections.id, row.id));
    if (row.secretId) await core.secrets.remove(tx, row.secretId);
    await core.audit.record(tx, {
      action: "connector.org_disconnected",
      resourceType: "connector_org_connection",
      resourceId: row.id,
      metadata: { serverId: p.serverId, method: row.method, revoked, reason: "admin" },
    });
    return { revoked };
  });
}
