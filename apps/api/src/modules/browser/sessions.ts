import { BROWSER_LIMITS, type BrowserSessionItem, SiteHost } from "@ocw/contracts";
import { agents, browserSessions, sandboxPolicies, type Tx, tenantOf } from "@ocw/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Core } from "../../core";

/**
 * Sealed browser sessions (07.8-21; D-08, F-10, D-12 U-3, P-09, BRW-04). A member's sign-in to one site with one bot is
 * the Playwright storage state of that site only, sealed as a `browser_session` secret (AES-256-GCM, AAD
 * `${org}:${user}:browser:${agent}:${siteKey}`), referenced by an owner-only `browser_sessions` row (RESTRICTIVE
 * `personal_owner_only`: any other member, an admin or a user-less session reads 0 rows and cannot write one).
 *
 * Every function here runs in the caller's `withTenant` transaction whose `userId` is the session's owner (asserted),
 * so the database itself guarantees that no other member's session can be read, used or changed. The plaintext state
 * exists only in memory, on its way between sandboxd and the secret; it never reaches a column, a log line, an audit
 * row, an event or a response. Audit metadata carries ids and the site only.
 */

/** Expired sessions are listed as `expired` for this long, then purged (UI-SPEC § 4.5). */
export const PURGE_AFTER_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The site key of a host: the exact lower-case `URL.host` (`:port` only when not the default), or null. */
export function siteKeyOf(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  return SiteHost.safeParse(h).success && h.length <= 260 ? h : null;
}

/** The AAD a session's state is sealed with: it opens for exactly this organization, member, bot and site. */
export const browserSessionAad = (p: {
  organizationId: string;
  userId: string;
  agentId: string;
  siteKey: string;
}) => `${p.organizationId}:${p.userId}:browser:${p.agentId}:${p.siteKey}`;

/** RFC 6265 §5.1.3 domain-match of a host name against a cookie's domain (as the browser agent applies it). */
function domainMatch(hostname: string, cookieDomain: unknown): boolean {
  const d = String(cookieDomain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  if (d === "" || hostname === "") return false;
  if (hostname === d) return true;
  if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) return false;
  return hostname.endsWith(`.${d}`);
}

export interface KeptState {
  /** The storage state of the site only, as JSON text. */
  state: string;
  /** The earliest expiry (ms) of the kept cookies that have one; null when none has. */
  cookieExpiryMs: number | null;
}

/**
 * P-09 at the API (defence in depth: the agent already filtered at export, T-07.8-21-06): keeps only the cookies that
 * domain-match the site's host name and the origins of that exact host, so an identity provider's cookies are never
 * sealed with a site. Null when the text is not a storage state object. Pure.
 */
export function keepForSite(raw: string, siteKey: string): KeptState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const v = parsed as { cookies?: unknown; origins?: unknown };
  const hostname = siteKey.replace(/:\d+$/, "");
  const cookies = (Array.isArray(v.cookies) ? v.cookies : []).filter(
    (c): c is Record<string, unknown> =>
      typeof c === "object" && c !== null && domainMatch(hostname, (c as { domain?: unknown }).domain),
  );
  const origins = (Array.isArray(v.origins) ? v.origins : []).filter((o) => {
    try {
      const u = new URL(String((o as { origin?: unknown })?.origin ?? ""));
      return siteKey.includes(":") ? u.host === siteKey : u.hostname === hostname;
    } catch {
      return false;
    }
  });
  let cookieExpiryMs: number | null = null;
  for (const c of cookies) {
    const expires = typeof c.expires === "number" ? c.expires : -1;
    if (expires > 0) cookieExpiryMs = Math.min(cookieExpiryMs ?? Number.POSITIVE_INFINITY, expires * 1000);
  }
  return { state: JSON.stringify({ cookies, origins }), cookieExpiryMs };
}

/** The organization's `browser_session_max_days` (P-09), the default without a policy row. */
async function maxDays(tx: Tx): Promise<number> {
  const [policy] = await tx
    .select({ days: sandboxPolicies.browserSessionMaxDays })
    .from(sandboxPolicies)
    .limit(1);
  return policy?.days ?? BROWSER_LIMITS.sessionMaxDaysDefault;
}

/** The earliest of the kept cookies' expiry and `fromMs` + the organization's maximum. */
async function expiryOf(tx: Tx, cookieExpiryMs: number | null, fromMs: number): Promise<number> {
  const cap = fromMs + (await maxDays(tx)) * DAY_MS;
  return cookieExpiryMs === null ? cap : Math.min(cap, cookieExpiryMs);
}

/** The owner of this transaction (every session function needs it to be the session's member). */
function ownerOf(tx: Tx, userId: string): string {
  const ctx = tenantOf(tx);
  if (!ctx.userId || ctx.userId !== userId) throw new Error("browser sessions run as their owner only");
  return ctx.organizationId;
}

type SessionDeps = Pick<Core, "secrets" | "audit">;

/**
 * Seals a member's state for one site and bot: a new sign-in replaces the state of an existing session in place
 * (`replaceSealed`, same secret, same id), otherwise a new secret and row. Expiry = min(kept cookie expiries, now +
 * `browser_session_max_days`). Audited `browser_session.sealed` with ids and the site only.
 */
export async function sealSession(
  tx: Tx,
  deps: SessionDeps,
  p: { userId: string; agentId: string; siteKey: string; kept: KeptState; contextId: string | null },
): Promise<{ sessionId: string; expiresAt: string }> {
  const organizationId = ownerOf(tx, p.userId);
  const now = Date.now();
  const expiresAt = new Date(await expiryOf(tx, p.kept.cookieExpiryMs, now)).toISOString();
  const aad = browserSessionAad({ organizationId, userId: p.userId, agentId: p.agentId, siteKey: p.siteKey });
  const [existing] = await tx
    .select({ id: browserSessions.id, secretId: browserSessions.secretId })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, p.userId),
        eq(browserSessions.agentId, p.agentId),
        eq(browserSessions.siteKey, p.siteKey),
      ),
    )
    .limit(1)
    .for("update");
  let sessionId: string;
  if (existing) {
    await deps.secrets.replaceSealed(tx, existing.secretId, p.kept.state, aad);
    await tx
      .update(browserSessions)
      .set({ createdAt: new Date(now).toISOString(), lastUsedAt: null, expiresAt })
      .where(eq(browserSessions.id, existing.id));
    sessionId = existing.id;
  } else {
    const secretId = await deps.secrets.putSealed(tx, {
      name: "browser_session",
      kind: "browser_session",
      value: p.kept.state,
      aad,
    });
    const [row] = await tx
      .insert(browserSessions)
      .values({
        organizationId,
        userId: p.userId,
        agentId: p.agentId,
        siteKey: p.siteKey,
        secretId,
        expiresAt,
      })
      .returning({ id: browserSessions.id });
    if (!row) throw new Error("browser session insert returned no row");
    sessionId = row.id;
  }
  await deps.audit.record(tx, {
    action: "browser_session.sealed",
    actorKind: "user",
    actorId: p.userId,
    agentId: p.agentId,
    userId: p.userId,
    resourceType: "browser_session",
    resourceId: sessionId,
    metadata: { sessionId, agentId: p.agentId, site: p.siteKey, contextId: p.contextId },
  });
  return { sessionId, expiresAt };
}

export interface LoadedSession {
  sessionId: string;
  siteKey: string;
  /** The plaintext storage state, for `contextOpen` only (never stored, logged or returned). */
  state: string;
}

/**
 * The member's live session with this bot for `host`, opened from its secret, or `expired` (one exists but its time
 * passed: never loaded) or null. Marks it used (`last_used_at`); the caller audits `browser_session.used` once the
 * context exists. Must run as the member (owner-only RLS); the audience decision is the caller's
 * (`memberAccountAllowed`).
 */
export async function loadSessionFor(
  tx: Tx,
  deps: Pick<Core, "secrets">,
  p: { userId: string; agentId: string; host: string },
): Promise<LoadedSession | "expired" | null> {
  const organizationId = ownerOf(tx, p.userId);
  const siteKey = siteKeyOf(p.host);
  if (!siteKey) return null;
  const [row] = await tx
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, p.userId),
        eq(browserSessions.agentId, p.agentId),
        eq(browserSessions.siteKey, siteKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (Date.parse(String(row.expiresAt)) <= Date.now()) return "expired";
  let state: string;
  try {
    state = await deps.secrets.revealSealed(
      tx,
      row.secretId,
      browserSessionAad({ organizationId, userId: p.userId, agentId: p.agentId, siteKey }),
    );
  } catch {
    // A seal that does not open with this member's, bot's and site's AAD is never loaded (fail closed, no detail).
    return null;
  }
  await tx
    .update(browserSessions)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(browserSessions.id, row.id));
  return { sessionId: row.id, siteKey, state };
}

/** Whether the member has an expired session with this bot for `host` ("Sign in to {host} again"). */
export async function sessionExpiredFor(
  tx: Tx,
  p: { userId: string; agentId: string; host: string },
): Promise<boolean> {
  ownerOf(tx, p.userId);
  const siteKey = siteKeyOf(p.host);
  if (!siteKey) return false;
  const [row] = await tx
    .select({ expiresAt: browserSessions.expiresAt })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, p.userId),
        eq(browserSessions.agentId, p.agentId),
        eq(browserSessions.siteKey, siteKey),
      ),
    )
    .limit(1);
  return !!row && Date.parse(String(row.expiresAt)) <= Date.now();
}

/**
 * The rolling re-seal (D-08): the state exported after a signed-in call (or before the page closes) replaces the
 * sealed one in place; `last_used_at` moves and the expiry follows the cookies, never past the organization's maximum
 * counted from the sign-in. A session that is gone (revoked meanwhile) or expired is left alone (false).
 */
export async function resealSession(
  tx: Tx,
  deps: Pick<Core, "secrets">,
  p: { userId: string; sessionId: string; state: string },
): Promise<boolean> {
  const organizationId = ownerOf(tx, p.userId);
  const [row] = await tx
    .select()
    .from(browserSessions)
    .where(and(eq(browserSessions.id, p.sessionId), eq(browserSessions.userId, p.userId)))
    .limit(1)
    .for("update");
  if (!row || Date.parse(String(row.expiresAt)) <= Date.now()) return false;
  const kept = keepForSite(p.state, row.siteKey);
  if (!kept) return false;
  await deps.secrets.replaceSealed(
    tx,
    row.secretId,
    kept.state,
    browserSessionAad({ organizationId, userId: p.userId, agentId: row.agentId, siteKey: row.siteKey }),
  );
  const expiresAt = new Date(
    await expiryOf(tx, kept.cookieExpiryMs, Date.parse(String(row.createdAt))),
  ).toISOString();
  await tx
    .update(browserSessions)
    .set({ lastUsedAt: new Date().toISOString(), expiresAt })
    .where(eq(browserSessions.id, row.id));
  return true;
}

/** The member's own sessions (R7): site, bot, dates and status only; never anything sealed. */
export async function listMine(tx: Tx, userId: string, nowMs = Date.now()): Promise<BrowserSessionItem[]> {
  ownerOf(tx, userId);
  const rows = await tx
    .select({
      id: browserSessions.id,
      site: browserSessions.siteKey,
      agentId: browserSessions.agentId,
      agentName: agents.name,
      createdAt: browserSessions.createdAt,
      lastUsedAt: browserSessions.lastUsedAt,
      expiresAt: browserSessions.expiresAt,
    })
    .from(browserSessions)
    .innerJoin(agents, eq(agents.id, browserSessions.agentId))
    .where(eq(browserSessions.userId, userId))
    .orderBy(desc(browserSessions.createdAt))
    .limit(500);
  const iso = (v: string | Date) => new Date(String(v)).toISOString();
  return rows
    .filter((r) => Date.parse(String(r.expiresAt)) + PURGE_AFTER_MS > nowMs)
    .map((r) => ({
      id: r.id,
      site: r.site,
      agentId: r.agentId,
      agentName: r.agentName.slice(0, 200),
      createdAt: iso(r.createdAt),
      lastUsedAt: r.lastUsedAt ? iso(r.lastUsedAt) : null,
      expiresAt: iso(r.expiresAt),
      status: Date.parse(String(r.expiresAt)) <= nowMs ? ("expired" as const) : ("active" as const),
    }));
}

/**
 * Revokes the member's own session: its secret is deleted (the row goes with it, FK cascade) and the contexts that had
 * it loaded are returned so the caller ends them (their pages hold the cookies). Null when the session is not the
 * member's (or does not exist): the route answers 404, admins included. Audited `browser_session.revoked`.
 */
export async function revoke(
  tx: Tx,
  deps: SessionDeps,
  p: { userId: string; id: string },
): Promise<{ sessionId: string; agentId: string; siteKey: string } | null> {
  ownerOf(tx, p.userId);
  const [row] = await tx
    .select()
    .from(browserSessions)
    .where(and(eq(browserSessions.id, p.id), eq(browserSessions.userId, p.userId)))
    .limit(1)
    .for("update");
  if (!row) return null;
  await deps.secrets.remove(tx, row.secretId);
  await deps.audit.record(tx, {
    action: "browser_session.revoked",
    actorKind: "user",
    actorId: p.userId,
    agentId: row.agentId,
    userId: p.userId,
    resourceType: "browser_session",
    resourceId: row.id,
    metadata: { sessionId: row.id, agentId: row.agentId, site: row.siteKey },
  });
  return { sessionId: row.id, agentId: row.agentId, siteKey: row.siteKey };
}

/**
 * The sweep's purge of one organization (no user): sessions expired for more than 7 days are deleted through the
 * SECURITY DEFINER `app.purge_browser_sessions` (tenant-scoped; their secrets go with them) and each is audited
 * `browser_session.purged` with ids and the site. Returns how many went.
 */
export async function purgeExpired(tx: Tx, deps: Pick<Core, "audit">, nowMs = Date.now()): Promise<number> {
  const before = new Date(nowMs - PURGE_AFTER_MS).toISOString();
  const rows = (
    await tx.execute<{ id: string; user_id: string; agent_id: string; site_key: string }>(
      sql`select id, user_id, agent_id, site_key from app.purge_browser_sessions(${before}::timestamptz)`,
    )
  ).rows;
  for (const r of rows) {
    await deps.audit.record(tx, {
      action: "browser_session.purged",
      actorKind: "system",
      agentId: r.agent_id,
      userId: r.user_id,
      resourceType: "browser_session",
      resourceId: r.id,
      metadata: { sessionId: r.id, agentId: r.agent_id, site: r.site_key },
    });
  }
  return rows.length;
}

/** The site keys of sessions among `ids` visible to this transaction's member (the context's loaded session). */
export async function siteKeysOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: browserSessions.id, site: browserSessions.siteKey })
    .from(browserSessions)
    .where(inArray(browserSessions.id, ids));
  return new Map(rows.map((r) => [r.id, r.site]));
}
