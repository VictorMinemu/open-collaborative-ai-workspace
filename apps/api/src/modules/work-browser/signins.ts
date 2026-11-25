import {
  BROWSER_LIMITS,
  WORK_BROWSER_AUDIT,
  type WorkBrowserSignInItem,
  WorkBrowserStorageState,
} from "@ocw/contracts";
import { sandboxPolicies, type Tx, tenantOf, workBrowserSignins } from "@ocw/db";
import { and, desc, eq } from "drizzle-orm";
import type { Core } from "../../core";
import { keepForSite, siteKeyOf } from "../browser";

/**
 * A member's sealed Work Zone sign-ins (Phase 07.13; D-22, D-23, D-28, D-30, PD-03, PD-15, P7). One per member × site:
 * the Playwright storage state of that site only (re-filtered here with the bots' `keepForSite`, T-07.13-17-04), sealed
 * as a `browser_session` secret with the Work Zone AAD `${org}:${user}:browser:workzone:${siteKey}` (never a bot's
 * `${org}:${user}:browser:${agentId}:${siteKey}`: a bot's seal never opens here and this one never opens there, D-30),
 * referenced by an owner-only `work_browser_signins` row (RESTRICTIVE `personal_owner_only`: another member, an admin or
 * a user-less session reads 0 rows and cannot write one).
 *
 * Every function here runs in a `withTenant` transaction whose `userId` is the sign-in's owner (asserted), so the
 * database itself refuses anyone else. The plaintext state exists only in memory between the device and the secret: it
 * never reaches a column, a log line, an audit row, an event or a response other than the `browser.signin.state` reply
 * (load.ts). Audit metadata carries the origin or the site only.
 */

const DAY_MS = 24 * 60 * 60_000;

/** The AAD a Work Zone sign-in is sealed with: it opens for exactly this organization, member and site. */
export const workSignInAad = (p: { organizationId: string; userId: string; siteKey: string }) =>
  `${p.organizationId}:${p.userId}:browser:workzone:${p.siteKey}`;

/** The site key of a page origin (`http://127.0.0.1:4100` → `127.0.0.1:4100`, `https://x.test:443` → `x.test`). */
export function siteKeyOfOrigin(origin: string): string | null {
  try {
    return siteKeyOf(new URL(origin).host);
  } catch {
    return null;
  }
}

/** The owner of this transaction (every sign-in function needs it to be the sign-in's member). */
function ownerOf(tx: Tx, userId: string): string {
  const ctx = tenantOf(tx);
  if (!ctx.userId || ctx.userId !== userId) throw new Error("work browser sign-ins run as their owner only");
  return ctx.organizationId;
}

/** The organization's `browser_session_max_days` (D-23: one maximum for bots and the Work Zone), the default without a row. */
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

type SignInDeps = Pick<Core, "secrets" | "audit">;

/** Where a device-side save or load happened (the audit's actor and session; ids only). */
export interface DeviceContext {
  deviceId: string;
  sessionId: string;
}

/**
 * Seals the member's state for the origin's site (PD-15): re-filtered to the site, refused (null) when nothing of it
 * is left; a second save for the same member and site replaces the secret in place (same row, same secret, new
 * expiry). Expiry = min(kept cookies' expiry, now + `browser_session_max_days`). Audited `work_browser.signin_saved`
 * `{ origin }` as the device for the member.
 */
export async function sealWorkSignIn(
  tx: Tx,
  deps: SignInDeps,
  p: { userId: string; origin: string; rawState: string; device: DeviceContext },
): Promise<{ signinId: string; expiresAt: string } | null> {
  const organizationId = ownerOf(tx, p.userId);
  const siteKey = siteKeyOfOrigin(p.origin);
  if (!siteKey) return null;
  const kept = keepForSite(p.rawState, siteKey);
  if (!kept || kept.items === 0) return null;
  const now = Date.now();
  const expiresAt = new Date(await expiryOf(tx, kept.cookieExpiryMs, now)).toISOString();
  const aad = workSignInAad({ organizationId, userId: p.userId, siteKey });
  const [existing] = await tx
    .select({ id: workBrowserSignins.id, secretId: workBrowserSignins.secretId })
    .from(workBrowserSignins)
    .where(and(eq(workBrowserSignins.userId, p.userId), eq(workBrowserSignins.siteKey, siteKey)))
    .limit(1)
    .for("update");
  let signinId: string;
  if (existing) {
    await deps.secrets.replaceSealed(tx, existing.secretId, kept.state, aad);
    await tx
      .update(workBrowserSignins)
      .set({ createdAt: new Date(now).toISOString(), lastUsedAt: null, expiresAt })
      .where(eq(workBrowserSignins.id, existing.id));
    signinId = existing.id;
  } else {
    const secretId = await deps.secrets.putSealed(tx, {
      name: "work_browser_signin",
      kind: "browser_session",
      value: kept.state,
      aad,
    });
    const [row] = await tx
      .insert(workBrowserSignins)
      .values({ organizationId, userId: p.userId, siteKey, secretId, expiresAt })
      .returning({ id: workBrowserSignins.id });
    if (!row) throw new Error("work browser sign-in insert returned no row");
    signinId = row.id;
  }
  await deps.audit.record(tx, {
    action: WORK_BROWSER_AUDIT.signin_saved,
    actorKind: "device",
    actorId: p.device.deviceId,
    deviceId: p.device.deviceId,
    sessionId: p.device.sessionId,
    userId: p.userId,
    resourceType: "work_browser_signin",
    resourceId: signinId,
    metadata: { origin: p.origin },
  });
  return { signinId, expiresAt };
}

/**
 * The rolling re-seal before an unload (D-25, PD-17): the site's state the device exported replaces the sealed one in
 * place; `last_used_at` moves and the expiry follows the kept cookies, never past the organization's maximum counted
 * from the sign-in. A sign-in that is gone (revoked meanwhile), expired, or a state with nothing of the site left is
 * not written (null): the sealed state stays as it was.
 */
export async function resealWorkSignIn(
  tx: Tx,
  deps: Pick<Core, "secrets">,
  p: { userId: string; signinId: string; rawState: string },
): Promise<{ expiresAt: string } | null> {
  const organizationId = ownerOf(tx, p.userId);
  const [row] = await tx
    .select()
    .from(workBrowserSignins)
    .where(and(eq(workBrowserSignins.id, p.signinId), eq(workBrowserSignins.userId, p.userId)))
    .limit(1)
    .for("update");
  if (!row || Date.parse(String(row.expiresAt)) <= Date.now()) return null;
  const kept = keepForSite(p.rawState, row.siteKey);
  if (!kept || kept.items === 0) return null;
  await deps.secrets.replaceSealed(
    tx,
    row.secretId,
    kept.state,
    workSignInAad({ organizationId, userId: p.userId, siteKey: row.siteKey }),
  );
  const expiresAt = new Date(
    await expiryOf(tx, kept.cookieExpiryMs, Date.parse(String(row.createdAt))),
  ).toISOString();
  await tx
    .update(workBrowserSignins)
    .set({ lastUsedAt: new Date().toISOString(), expiresAt })
    .where(eq(workBrowserSignins.id, row.id));
  return { expiresAt };
}

export interface OpenedSignIn {
  signinId: string;
  siteKey: string;
  expiresAt: string;
  /** The plaintext storage state, for the `browser.signin.state` reply only (never stored, logged or returned). */
  state: WorkBrowserStorageState;
}

/**
 * The member's sign-in for `siteKey`, opened from its secret, or `expired` (one exists but its time passed: never
 * loaded), or null (none, or a seal that does not open with this member's and site's Work Zone AAD: fail closed, no
 * detail). Marks it used (`last_used_at`). Must run as the member; the load decision is the caller's (load.ts).
 */
export async function openWorkSignIn(
  tx: Tx,
  deps: Pick<Core, "secrets">,
  p: { userId: string; siteKey: string },
): Promise<OpenedSignIn | "expired" | null> {
  const organizationId = ownerOf(tx, p.userId);
  const [row] = await tx
    .select()
    .from(workBrowserSignins)
    .where(and(eq(workBrowserSignins.userId, p.userId), eq(workBrowserSignins.siteKey, p.siteKey)))
    .limit(1)
    .for("update");
  if (!row) return null;
  if (Date.parse(String(row.expiresAt)) <= Date.now()) return "expired";
  let parsed: WorkBrowserStorageState;
  try {
    const raw = await deps.secrets.revealSealed(
      tx,
      row.secretId,
      workSignInAad({ organizationId, userId: p.userId, siteKey: row.siteKey }),
    );
    const checked = WorkBrowserStorageState.safeParse(JSON.parse(raw));
    if (!checked.success) return null;
    parsed = checked.data;
  } catch {
    return null;
  }
  await tx
    .update(workBrowserSignins)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(workBrowserSignins.id, row.id));
  return {
    signinId: row.id,
    siteKey: row.siteKey,
    expiresAt: new Date(String(row.expiresAt)).toISOString(),
    state: parsed,
  };
}

/** The member's own Work Zone sign-ins (Settings › Keychain, D-23): site, dates and status only; never anything sealed. */
export async function listMine(tx: Tx, userId: string, nowMs = Date.now()): Promise<WorkBrowserSignInItem[]> {
  ownerOf(tx, userId);
  const rows = await tx
    .select({
      id: workBrowserSignins.id,
      site: workBrowserSignins.siteKey,
      createdAt: workBrowserSignins.createdAt,
      lastUsedAt: workBrowserSignins.lastUsedAt,
      expiresAt: workBrowserSignins.expiresAt,
    })
    .from(workBrowserSignins)
    .where(eq(workBrowserSignins.userId, userId))
    .orderBy(desc(workBrowserSignins.createdAt))
    .limit(500);
  const iso = (v: string | Date) => new Date(String(v)).toISOString();
  return rows.map((r) => ({
    id: r.id,
    site: r.site,
    scope: "work_zone" as const,
    createdAt: iso(r.createdAt),
    lastUsedAt: r.lastUsedAt ? iso(r.lastUsedAt) : null,
    expiresAt: iso(r.expiresAt),
    status: Date.parse(String(r.expiresAt)) <= nowMs ? ("expired" as const) : ("active" as const),
  }));
}

/**
 * Revokes the member's own sign-in: its secret is deleted (the row goes with it, FK cascade; a page that had it loaded
 * only unlinks `signin_id`). Null when it is not the member's (or does not exist): the route answers 404, admins
 * included. Audited `work_browser.signin_revoked { site }` as the member.
 */
export async function revokeWorkSignIn(
  tx: Tx,
  deps: SignInDeps,
  p: { userId: string; id: string },
): Promise<{ id: string; siteKey: string } | null> {
  ownerOf(tx, p.userId);
  const [row] = await tx
    .select()
    .from(workBrowserSignins)
    .where(and(eq(workBrowserSignins.id, p.id), eq(workBrowserSignins.userId, p.userId)))
    .limit(1)
    .for("update");
  if (!row) return null;
  await deps.secrets.remove(tx, row.secretId);
  await deps.audit.record(tx, {
    action: WORK_BROWSER_AUDIT.signin_revoked,
    actorKind: "user",
    actorId: p.userId,
    userId: p.userId,
    resourceType: "work_browser_signin",
    resourceId: row.id,
    metadata: { site: row.siteKey },
  });
  return { id: row.id, siteKey: row.siteKey };
}
