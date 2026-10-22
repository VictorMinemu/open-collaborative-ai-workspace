import { type BrowserEndReason, BrowserHost } from "@ocw/contracts";
import {
  agents,
  browserContexts,
  browserSessions,
  conversations,
  messages,
  sandboxPolicies,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { SandboxEventHandler } from "../sandbox";
import { stopSignIns } from "./signin-card";

/**
 * A bot's browser contexts as the Control Plane records them (07.8-14; D-05, D-09, D-12, BRW-01). One open context per
 * (bot, conversation, member): the turn's human is the member the bot browses for. A row keeps the current HOST only
 * (never a path, a query, a title or page text), its state, and the hold while an approval waits (U-5, 15 minutes).
 *
 * Every function runs in the caller's transaction, under its tenant (RLS): another organization's row does not exist.
 * The member's sealed session (`session_id`) is read through `browser_sessions`, whose restrictive owner policy shows it
 * only to that member: the context's site is known to the member's own turns and to nobody else.
 */

export type BrowserContextRecord = typeof browserContexts.$inferSelect;

/** A context with the site of its loaded session (null: no session, or not readable by this transaction's user). */
export interface LoadedContext extends BrowserContextRecord {
  sessionSite: string | null;
}

/** The host of an http(s) URL as the platform keeps it (`URL.host`: lower case, `:port` when not default). */
export function hostOf(url: string): { host: string; secure: boolean } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.host.toLowerCase();
    return BrowserHost.safeParse(host).success ? { host, secure: u.protocol === "https:" } : null;
  } catch {
    return null;
  }
}

/** A host string as stored, or null when it is not a host (never stored then). */
export function validHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  return BrowserHost.safeParse(h).success && !h.includes("/") && !h.includes("@") ? h : null;
}

async function withSession(tx: Tx, row: BrowserContextRecord): Promise<LoadedContext> {
  if (!row.sessionId) return { ...row, sessionSite: null };
  const [session] = await tx
    .select({ site: browserSessions.siteKey })
    .from(browserSessions)
    .where(eq(browserSessions.id, row.sessionId))
    .limit(1);
  return { ...row, sessionSite: session?.site ?? null };
}

/** The open context of (bot, conversation, member), or null. */
export async function openContextOf(
  tx: Tx,
  p: { agentId: string; conversationId: string; userId: string },
): Promise<LoadedContext | null> {
  const [row] = await tx
    .select()
    .from(browserContexts)
    .where(
      and(
        eq(browserContexts.agentId, p.agentId),
        eq(browserContexts.conversationId, p.conversationId),
        eq(browserContexts.requestedForUserId, p.userId),
        isNull(browserContexts.closedAt),
      ),
    )
    .orderBy(desc(browserContexts.openedAt))
    .limit(1);
  return row ? withSession(tx, row) : null;
}

/** A context by id (open or not), or null. */
export async function contextById(tx: Tx, id: string): Promise<LoadedContext | null> {
  const [row] = await tx.select().from(browserContexts).where(eq(browserContexts.id, id)).limit(1);
  return row ? withSession(tx, row) : null;
}

/** Serialises the creation of the one open context of (bot, conversation, member) in this organization. */
async function lockTriple(tx: Tx, p: { agentId: string; conversationId: string; userId: string }) {
  const { organizationId } = tenantOf(tx);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ocw.browser.context:${organizationId}:${p.agentId}:${p.conversationId}:${p.userId}`}, 0))`,
  );
}

export interface ContextTurn {
  eventId: string;
  agentId: string;
  conversationId: string;
  userId: string;
  messageId: string;
}

/**
 * The open context of the turn's (bot, conversation, member), created when there is none (`created`). The agent and
 * the conversation are resolved here, in the transaction's tenant (foreign keys bypass RLS, 07.4 #169): an id of
 * another organization answers null and nothing is written. The new row holds the target's host only.
 */
export async function contextFor(
  tx: Tx,
  p: {
    turn: ContextTurn;
    host: string;
    secure: boolean;
    /** 07.8-21: the member's sealed session loaded into the new page (its site is the page's lock). */
    session?: { id: string; siteKey: string } | null;
  },
): Promise<{ context: LoadedContext; created: boolean } | null> {
  const { turn } = p;
  const host = validHost(p.host);
  if (!host) return null;
  const [bot] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, turn.agentId), isNull(agents.deletedAt)))
    .limit(1);
  const [conv] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  if (!bot || !conv) return null;
  const triple = { agentId: turn.agentId, conversationId: turn.conversationId, userId: turn.userId };
  await lockTriple(tx, triple);
  const existing = await openContextOf(tx, triple);
  if (existing) return { context: existing, created: false };
  const [asked] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const [row] = await tx
    .insert(browserContexts)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      threadRootMessageId: asked?.threadId ?? null,
      requestedForUserId: turn.userId,
      eventId: turn.eventId,
      host,
      secure: p.secure,
      state: "live",
      sessionId: p.session?.id ?? null,
    })
    .returning();
  if (!row) throw new Error("browser context insert returned no row");
  return { context: { ...row, sessionSite: p.session?.siteKey ?? null }, created: true };
}

/** A member's sealed session is loaded for this host: the context carries a session whose site is exactly the host. */
export function sessionLoadedFor(
  ctx: Pick<LoadedContext, "sessionId" | "sessionSite">,
  host: string | null,
): boolean {
  return !!ctx.sessionId && !!ctx.sessionSite && !!host && ctx.sessionSite === host;
}

/** A person holds the takeover lease now (16): every bot operation on the page waits (`paused`). */
export function takeoverActive(ctx: Pick<LoadedContext, "controllerUserId" | "leaseExpiresAt">): boolean {
  return (
    ctx.controllerUserId !== null &&
    ctx.leaseExpiresAt !== null &&
    Date.parse(String(ctx.leaseExpiresAt)) > Date.now()
  );
}

/** The context's current host (a host only) and whether the page is https. */
export async function updateHost(tx: Tx, id: string, host: string, secure?: boolean): Promise<void> {
  const h = validHost(host);
  if (!h) return;
  await tx
    .update(browserContexts)
    .set({ host: h, ...(secure !== undefined ? { secure } : {}) })
    .where(and(eq(browserContexts.id, id), isNull(browserContexts.closedAt)));
}

/** The page is held while an approval waits (U-5): `paused` for `approval` until `untilMs`. */
export async function holdContext(tx: Tx, id: string, untilMs: number): Promise<void> {
  await tx
    .update(browserContexts)
    .set({ state: "paused", pausedFor: "approval", heldUntil: new Date(untilMs).toISOString() })
    .where(and(eq(browserContexts.id, id), isNull(browserContexts.closedAt)));
}

/** The approval the page waited for was used (or the page moved on): live again, no hold. */
export async function releaseHold(tx: Tx, id: string): Promise<boolean> {
  const done = await tx
    .update(browserContexts)
    .set({ state: "live", pausedFor: null, heldUntil: null })
    .where(
      and(
        eq(browserContexts.id, id),
        isNull(browserContexts.closedAt),
        eq(browserContexts.pausedFor, "approval"),
      ),
    )
    .returning({ id: browserContexts.id });
  return done.length > 0;
}

/** Ends an open context with its reason; returns the row it ended (null when it was already closed or not here). */
export async function closeContext(
  tx: Tx,
  id: string,
  reason: BrowserEndReason,
): Promise<BrowserContextRecord | null> {
  const [row] = await tx
    .update(browserContexts)
    .set({
      state: "ended",
      endReason: reason,
      closedAt: new Date().toISOString(),
      pausedFor: null,
      heldUntil: null,
      controllerUserId: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(browserContexts.id, id), isNull(browserContexts.closedAt)))
    .returning();
  return row ?? null;
}

/** Ends every open context of the organization (the kill switch): returns the rows it ended. */
export async function closeOrganizationContexts(
  tx: Tx,
  reason: BrowserEndReason,
): Promise<BrowserContextRecord[]> {
  return tx
    .update(browserContexts)
    .set({
      state: "ended",
      endReason: reason,
      closedAt: new Date().toISOString(),
      pausedFor: null,
      heldUntil: null,
      controllerUserId: null,
      leaseExpiresAt: null,
    })
    .where(isNull(browserContexts.closedAt))
    .returning();
}

/**
 * `browser.closed` for a context the platform ended (ids, the host and the reason only). A sign-in still waiting on it
 * reads "Stopped" with that reason from now on (07.8-21; nothing is sealed).
 */
export async function auditClosed(
  tx: Tx,
  core: Pick<Core, "audit" | "realtime">,
  row: Pick<BrowserContextRecord, "id" | "agentId" | "requestedForUserId" | "host">,
  reason: BrowserEndReason,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await stopSignIns(tx, core, { contextId: row.id, reason });
  await core.audit.record(tx, {
    action: "browser.closed",
    actorKind: reason === "closed_by_bot" ? "agent" : "system",
    actorId: reason === "closed_by_bot" ? row.agentId : null,
    agentId: row.agentId,
    userId: row.requestedForUserId,
    resourceType: "browser_context",
    resourceId: row.id,
    metadata: { contextId: row.id, host: row.host, reason, ...extra },
  });
}

/**
 * The `browser` events of sandboxd's feed (07.8-11's consumer, inside the event's organization transaction, after its
 * cursor check): a navigation moves the context's host and is audited `browser.navigated` with the host only; a crash
 * ends it (`crashed`); a close sandboxd made on its own ends it with `kill_switch` when the organization is killed and
 * `idle` otherwise (the broker's idle stop). A context the API already closed, another bot's id, or a value that is not a
 * host changes nothing. Downloads and sensitive focus belong to 16 and 25.
 */
export function onBrowserEvent(core: Pick<Core, "audit" | "realtime">): SandboxEventHandler<"browser"> {
  return async (tx, e) => {
    const ctx = await contextById(tx, e.contextId);
    if (!ctx || ctx.closedAt !== null || ctx.agentId !== e.target.agentId) return;
    switch (e.event) {
      case "navigated": {
        const host = validHost(e.host);
        if (!host || host === ctx.host) return;
        await updateHost(tx, ctx.id, host);
        await core.audit.record(tx, {
          action: "browser.navigated",
          actorKind: "agent",
          actorId: ctx.agentId,
          agentId: ctx.agentId,
          userId: ctx.requestedForUserId,
          resourceType: "browser_context",
          resourceId: ctx.id,
          metadata: { contextId: ctx.id, host },
        });
        return;
      }
      case "crashed": {
        const row = await closeContext(tx, ctx.id, "crashed");
        if (row) await auditClosed(tx, core, row, "crashed");
        return;
      }
      case "closed": {
        const [policy] = await tx
          .select({ killedAt: sandboxPolicies.killedAt })
          .from(sandboxPolicies)
          .limit(1);
        const reason: BrowserEndReason = policy?.killedAt ? "kill_switch" : "idle";
        const row = await closeContext(tx, ctx.id, reason);
        if (row) await auditClosed(tx, core, row, reason);
        return;
      }
      default:
        return;
    }
  };
}
