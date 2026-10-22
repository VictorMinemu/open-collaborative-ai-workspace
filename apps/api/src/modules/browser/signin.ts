import { type AgentCardBrowserSignInLink, BROWSER_LIMITS } from "@ocw/contracts";
import { agents, browserContexts, browserSigninRequests, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { PlatformCardInput, SignInCards } from "../../lib/chat-agent-bridge";
import { conflict, forbidden, notFound } from "../../lib/errors";
import { announceCardMessage } from "../chat";
import type { SandboxdClient } from "../sandbox";
import { auditClosed, closeContext, type LoadedContext } from "./contexts";
import { keepForSite, sealSession, sessionExpiredFor, siteKeyOf } from "./sessions";
import { syncCard } from "./signin-card";
import { announce } from "./takeover";

/**
 * The platform-owned sign-in card (07.8-21; D-07, D-08, D-11 F-10, D-12 U-3 U-6, R1, R9, BRW-03). A bot that reaches a
 * page needing an account asks (`ocw_browser_signin`, reason only); the API composes the card from the context (the
 * page's host, never the bot's text), holds the page 15 minutes and waits for the turn's member. They take control in
 * the live view, sign in by typing in the page themselves and hand back. Then (`onHandBack`, called by the live view):
 *
 *   1. sandboxd exports the context's storage state (outside any transaction; P-09's filter in the agent);
 *   2. sandboxd site-locks that open page in place (`contextLock`, D-13): from now on it behaves as a page opened with
 *      the sealed session (other hosts blocked and turned into the requester's approval);
 *   3. one transaction AS the member: the API keeps only that host's state again (`keepForSite`), seals it
 *      (`sealSession`, AAD per organization × member × bot × site), links the session to the page (frames go to the
 *      member alone, signed-in acts ask the member, `member_data` for the next calls), turns the card "Signed in",
 *      audits `browser.signin_decided` and `browser_session.sealed` (ids and the host only) and delivers a card-action
 *      turn to the bot for the member (`cardAction.signIn`).
 *
 * The card's state lives in `browser_signin_requests` (the link every reader sees, composed by `linkOf`) and its status
 * pill on the card row. "Not now" (`skip`), the 15-minute expiry (`expireSignIns`) and a page that ended first
 * (`stopSignIns`: kill switch, module off, crash, idle) close it; only "Signed in" and "Not now" deliver a turn.
 * Nothing typed, no cookie and no username ever reaches a column but the sealed secret, a log line, the audit or a turn.
 */

export const SIGNIN_HOLD_MS = BROWSER_LIMITS.holdMinutes * 60_000;
const OP_TIMEOUT_MS = 15_000;

type Request = typeof browserSigninRequests.$inferSelect;

/** The card the server composes (UI-SPEC Surface 2): the page's host, the bot's reason as plain text, no action. */
export function signInCard(p: {
  host: string;
  botName: string;
  reason: string;
  again: boolean;
}): PlatformCardInput {
  return {
    kind: "browser",
    status: "pending",
    title: `Sign in to ${p.host}${p.again ? " again" : ""}`.slice(0, 200),
    fields: [
      { label: "Site", value: p.host },
      { label: "Why", value: p.reason },
      ...(p.again ? [{ label: "What happened", value: "Your saved sign-in expired." }] : []),
    ],
    actions: [],
    summary: `${p.botName} needs someone to sign in to ${p.host} to continue.`.slice(0, 2000),
  };
}

/** A waiting request is live until its expiry; after it, it reads `expired` even before the sweep writes it. */
const live = (r: Pick<Request, "status" | "expiresAt">, nowMs = Date.now()) =>
  (r.status === "waiting" || r.status === "signing_in") && Date.parse(String(r.expiresAt)) > nowMs;

/** The page is held for the sign-in (R9): `paused` for `signin` until `untilMs`. */
async function holdForSignIn(tx: Tx, contextId: string, untilMs: number): Promise<void> {
  await tx
    .update(browserContexts)
    .set({ state: "paused", pausedFor: "signin", heldUntil: new Date(untilMs).toISOString() })
    .where(and(eq(browserContexts.id, contextId), isNull(browserContexts.closedAt)));
}

/** The sign-in hold ends (signed in, skipped, expired): the page is live again. Approval holds are not touched. */
async function releaseSignInHold(tx: Tx, contextId: string): Promise<void> {
  await tx
    .update(browserContexts)
    .set({ state: "live", pausedFor: null, heldUntil: null })
    .where(
      and(
        eq(browserContexts.id, contextId),
        isNull(browserContexts.closedAt),
        eq(browserContexts.pausedFor, "signin"),
      ),
    );
}

/** sandboxd releases (or keeps) the page's hold; best effort: the API's row is the record. */
async function holdInSandboxd(
  core: Pick<Core, "log">,
  client: SandboxdClient | null,
  p: { orgId: string; agentId: string; contextId: string; hold: boolean },
): Promise<void> {
  if (!client) return;
  await client
    .call(
      "contextHold",
      {
        target: { orgId: p.orgId, agentId: p.agentId },
        contextId: p.contextId,
        hold: p.hold,
        reason: p.hold ? "signin" : null,
      },
      { timeoutMs: OP_TIMEOUT_MS },
    )
    .catch((err: unknown) =>
      core.log.warn(
        { contextId: p.contextId, error: (err as Error | undefined)?.name ?? "Error" },
        "sandboxd did not confirm the sign-in hold",
      ),
    );
}

export interface SignInTurn {
  eventId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  messageId: string;
}

/**
 * The bot's request (`/browser/signin`, after the decision), in a transaction AS the turn's member: one request and one
 * card per (turn, page) (the same call again answers the same card), the page held 15 minutes, audited
 * `browser.signin_requested` with ids and the host. Another turn's sign-in still waiting on the page is
 * `signin_pending`. The caller tells sandboxd to hold the page and has decided the audience rule already.
 */
export async function requestSignIn(
  tx: Tx,
  core: Core,
  p: { turn: SignInTurn; context: LoadedContext; reason: string },
): Promise<
  { posted: true; host: string; requestId: string; created: boolean } | { refused: "signin_pending" }
> {
  const { turn, context } = p;
  const host = siteKeyOf(context.host);
  if (!host) throw new Error("context host is not a site");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ocw.browser.signin:${context.id}`}, 0))`,
  );
  const rows = await tx
    .select()
    .from(browserSigninRequests)
    .where(eq(browserSigninRequests.contextId, context.id));
  const same = rows.find((r) => r.eventId === turn.eventId);
  if (same) return { posted: true, host: same.host, requestId: same.id, created: false };
  if (rows.some((r) => live(r))) return { refused: "signin_pending" };
  const [bot] = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, turn.agentId))
    .limit(1);
  const botName = bot?.name ?? "The bot";
  const again = await sessionExpiredFor(tx, { userId: turn.userId, agentId: turn.agentId, host });
  const reason = p.reason.trim().slice(0, BROWSER_LIMITS.reasonMaxChars);
  const expiresAt = new Date(Date.now() + SIGNIN_HOLD_MS);
  const [request] = await tx
    .insert(browserSigninRequests)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId: turn.agentId,
      contextId: context.id,
      requesterUserId: turn.userId,
      conversationId: turn.conversationId,
      eventId: turn.eventId,
      host,
      reason,
      status: "waiting",
      expiresAt: expiresAt.toISOString(),
    })
    .returning();
  if (!request) throw new Error("sign-in request insert returned no row");
  // The card, as the bot, in the turn's conversation and thread, through chat's agent path (membership and the
  // confused-deputy check for the member); platform-owned, so no agent can rewrite it into a phishing link.
  const posted = await core.chatAgent.postAgentMessageIn(tx, {
    agentId: turn.agentId,
    conversationId: turn.conversationId,
    threadRootId: turn.messageId,
    body: signInCard({ host, botName, reason, again }).summary,
    idempotencyKey: `signin:${turn.eventId}:${context.id}`,
    inReplyToMessageId: turn.messageId,
    onBehalfOfUserId: turn.userId,
    card: signInCard({ host, botName, reason, again }),
    cardPlatformOwned: true,
  });
  await tx
    .update(browserSigninRequests)
    .set({ cardMessageId: posted.messageId })
    .where(eq(browserSigninRequests.id, request.id));
  await holdForSignIn(tx, context.id, expiresAt.getTime());
  // The card was announced before its link existed: once more, now with the sign-in link (07.2-13 precedent).
  await announceCardMessage(tx, core, posted.messageId);
  await core.audit.record(tx, {
    action: "browser.signin_requested",
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: turn.userId,
    resourceType: "browser_context",
    resourceId: context.id,
    metadata: {
      requestId: request.id,
      contextId: context.id,
      eventId: turn.eventId,
      host,
      messageId: posted.messageId,
    },
  });
  return { posted: true, host, requestId: request.id, created: true };
}

/** The live sign-in the member may complete on this page, or null. */
async function liveRequestOf(tx: Tx, contextId: string, userId: string): Promise<Request | null> {
  const rows = await tx
    .select()
    .from(browserSigninRequests)
    .where(
      and(
        eq(browserSigninRequests.contextId, contextId),
        eq(browserSigninRequests.requesterUserId, userId),
        inArray(browserSigninRequests.status, ["waiting", "signing_in"]),
      ),
    );
  return rows.find((r) => live(r)) ?? null;
}

/** The member took control of a page with their waiting sign-in: the card reads "Signing in…". */
export async function markSigningIn(
  tx: Tx,
  core: Pick<Core, "realtime">,
  p: { contextId: string; userId: string },
): Promise<void> {
  const r = await liveRequestOf(tx, p.contextId, p.userId);
  if (!r || r.status === "signing_in") return;
  await tx
    .update(browserSigninRequests)
    .set({ status: "signing_in" })
    .where(eq(browserSigninRequests.id, r.id));
  await syncCard(tx, core, r, "signing_in");
}

/** Control ended without a hand back (idle, a closed socket, lost access): the card waits again. */
export async function backToWaiting(
  tx: Tx,
  core: Pick<Core, "realtime">,
  p: { contextId: string; userId: string },
): Promise<void> {
  const r = await liveRequestOf(tx, p.contextId, p.userId);
  if (r?.status !== "signing_in") return;
  await tx.update(browserSigninRequests).set({ status: "waiting" }).where(eq(browserSigninRequests.id, r.id));
  await syncCard(tx, core, r, "waiting");
}

export type HandBack = "sealed" | "none" | "failed";

/**
 * The member handed control back (the live view's `release`): when their sign-in waits on this page, the page's state
 * is exported, the page site-locked and the state sealed for them (see the file comment). Nothing to do otherwise.
 * A failed export leaves the card waiting (the member may try again); nothing is sealed.
 */
export async function onHandBack(
  deps: { core: Core; client: SandboxdClient | null },
  p: { organizationId: string; contextId: string; userId: string },
): Promise<HandBack> {
  const { core, client } = deps;
  const tenant = { organizationId: p.organizationId, userId: p.userId };
  const found = await core.db.withTenant(tenant, async (tx) => {
    const r = await liveRequestOf(tx, p.contextId, p.userId);
    if (!r) return null;
    const [ctx] = await tx
      .select({
        id: browserContexts.id,
        agentId: browserContexts.agentId,
        closedAt: browserContexts.closedAt,
      })
      .from(browserContexts)
      .where(eq(browserContexts.id, p.contextId))
      .limit(1);
    return ctx && ctx.closedAt === null ? { request: r, agentId: ctx.agentId } : null;
  });
  if (!found) return "none";
  const { request } = found;
  const target = { orgId: p.organizationId, agentId: found.agentId };
  let raw: string | null = null;
  if (client) {
    try {
      raw = (
        await client.call(
          "contextExportState",
          { target, contextId: p.contextId },
          { timeoutMs: OP_TIMEOUT_MS },
        )
      ).storageState;
    } catch (err) {
      // The error's name only: never the state.
      core.log.warn(
        { contextId: p.contextId, error: (err as Error | undefined)?.name },
        "sign-in export failed",
      );
    }
  }
  const kept = raw === null ? null : keepForSite(raw, request.host);
  raw = null;
  if (!client || !kept) {
    await core.db.withTenant(tenant, (tx) => backToWaiting(tx, core, p));
    return "failed";
  }
  // D-13 before the seal is visible: the signed-in page may not leave its site. A page that cannot be locked is ended
  // (fail closed); the session is still sealed, and the bot's next open loads it into a locked page.
  let locked = true;
  try {
    await client.call(
      "contextLock",
      { target, contextId: p.contextId, memberId: p.userId, siteLock: request.host },
      { timeoutMs: OP_TIMEOUT_MS },
    );
  } catch (err) {
    locked = false;
    core.log.warn({ contextId: p.contextId, error: (err as Error | undefined)?.name }, "sign-in lock failed");
    await client
      .call("contextClose", { target, contextId: p.contextId }, { timeoutMs: OP_TIMEOUT_MS })
      .catch(() => {});
  }
  const sealed = await core.db.withTenant(tenant, async (tx, after) => {
    const r = await liveRequestOf(tx, p.contextId, p.userId);
    if (!r || r.id !== request.id) return false;
    const session = await sealSession(tx, core, {
      userId: p.userId,
      agentId: r.agentId,
      siteKey: r.host,
      kept,
      contextId: p.contextId,
    });
    const now = new Date().toISOString();
    await tx
      .update(browserSigninRequests)
      .set({
        status: "signed_in",
        sessionId: session.sessionId,
        sessionExpiresAt: session.expiresAt,
        decidedAt: now,
      })
      .where(eq(browserSigninRequests.id, r.id));
    if (locked) {
      await tx
        .update(browserContexts)
        .set({ sessionId: session.sessionId })
        .where(and(eq(browserContexts.id, p.contextId), isNull(browserContexts.closedAt)));
      await releaseSignInHold(tx, p.contextId);
    } else {
      const row = await closeContext(tx, p.contextId, "crashed");
      if (row) await auditClosed(tx, core, row, "crashed");
    }
    await syncCard(tx, core, r, "signed_in");
    await core.audit.record(tx, {
      action: "browser.signin_decided",
      actorKind: "user",
      actorId: p.userId,
      agentId: r.agentId,
      userId: p.userId,
      resourceType: "browser_context",
      resourceId: p.contextId,
      metadata: {
        requestId: r.id,
        contextId: p.contextId,
        host: r.host,
        outcome: "signed_in",
        sessionId: session.sessionId,
      },
    });
    if (r.cardMessageId) {
      await core.chatAgent.emitCardAction(
        tx,
        {
          messageId: r.cardMessageId,
          outcome: "approved",
          actorUserId: p.userId,
          turnUserId: p.userId,
          signIn: { status: "signed_in", host: r.host },
        },
        after,
      );
    }
    return true;
  });
  if (!sealed) return "none";
  await holdInSandboxd(core, client, { ...target, contextId: p.contextId, hold: false });
  await announce(core.bus, p.organizationId, p.contextId);
  return "sealed";
}

/** "Not now" (UI-SPEC Surface 2): the requester only, while the card waits; the bot hears it in a card-action turn. */
export async function skip(
  tx: Tx,
  deps: { core: Core; client: SandboxdClient | null },
  p: { messageId: string; userId: string },
): Promise<void> {
  const { core } = deps;
  const [r] = await tx
    .select()
    .from(browserSigninRequests)
    .where(eq(browserSigninRequests.cardMessageId, p.messageId))
    .limit(1)
    .for("update");
  if (!r) throw notFound("Card not found");
  if (r.requesterUserId !== p.userId) {
    throw forbidden("Only the person the bot asked can answer this sign-in", "not_signin_requester");
  }
  if (!live(r)) throw conflict("This sign-in is no longer waiting", "card_already_decided");
  await tx
    .update(browserSigninRequests)
    .set({ status: "skipped", decidedAt: new Date().toISOString() })
    .where(eq(browserSigninRequests.id, r.id));
  await releaseSignInHold(tx, r.contextId);
  await syncCard(tx, core, r, "skipped");
  await core.audit.record(tx, {
    action: "browser.signin_decided",
    actorKind: "user",
    actorId: p.userId,
    agentId: r.agentId,
    userId: p.userId,
    resourceType: "browser_context",
    resourceId: r.contextId,
    metadata: { requestId: r.id, contextId: r.contextId, host: r.host, outcome: "skipped" },
  });
  const { afterCommit, organizationId } = tenantOf(tx);
  await core.chatAgent.emitCardAction(
    tx,
    {
      messageId: p.messageId,
      outcome: "denied",
      actorUserId: p.userId,
      turnUserId: p.userId,
      signIn: { status: "skipped", host: r.host },
    },
    afterCommit,
  );
  afterCommit(async () => {
    await holdInSandboxd(core, deps.client, {
      orgId: organizationId,
      agentId: r.agentId,
      contextId: r.contextId,
      hold: false,
    });
    await announce(core.bus, organizationId, r.contextId);
  });
}

/**
 * The sweep (no user, one organization): sign-ins that waited 15 minutes expire; their pages are released from the
 * hold (the card reads "No one signed in within 15 minutes"). No turn is delivered. Returns the pages released, for
 * sandboxd.
 */
export async function expireSignIns(
  tx: Tx,
  core: Pick<Core, "realtime" | "audit">,
  nowMs = Date.now(),
): Promise<Array<{ agentId: string; contextId: string }>> {
  const rows = await tx
    .update(browserSigninRequests)
    .set({ status: "expired", decidedAt: new Date(nowMs).toISOString() })
    .where(
      and(
        inArray(browserSigninRequests.status, ["waiting", "signing_in"]),
        lte(browserSigninRequests.expiresAt, new Date(nowMs).toISOString()),
      ),
    )
    .returning();
  for (const r of rows) {
    await releaseSignInHold(tx, r.contextId);
    await syncCard(tx, core, r, "expired");
    await core.audit.record(tx, {
      action: "browser.signin_decided",
      actorKind: "system",
      agentId: r.agentId,
      userId: r.requesterUserId,
      resourceType: "browser_context",
      resourceId: r.contextId,
      metadata: { requestId: r.id, contextId: r.contextId, host: r.host, outcome: "expired" },
    });
  }
  return rows.map((r) => ({ agentId: r.agentId, contextId: r.contextId }));
}

/**
 * The sign-in links of `browser` cards (the bridge provider chat asks): composed from the request and its page, the
 * same for every reader (no viewer field). A request past its expiry reads `expired` before the sweep writes it.
 */
export async function signInLinksOf(
  tx: Tx,
  messageIds: readonly string[],
  nowMs = Date.now(),
): Promise<Map<string, AgentCardBrowserSignInLink>> {
  const out = new Map<string, AgentCardBrowserSignInLink>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select({ r: browserSigninRequests, secure: browserContexts.secure })
    .from(browserSigninRequests)
    .innerJoin(browserContexts, eq(browserContexts.id, browserSigninRequests.contextId))
    .where(inArray(browserSigninRequests.cardMessageId, [...messageIds]));
  const iso = (v: string | Date | null) => (v === null ? null : new Date(String(v)).toISOString());
  for (const { r, secure } of rows) {
    if (!r.cardMessageId) continue;
    const expired = (r.status === "waiting" || r.status === "signing_in") && !live(r, nowMs);
    out.set(r.cardMessageId, {
      contextId: r.contextId,
      host: r.host,
      secure,
      requesterId: r.requesterUserId,
      status: expired ? "expired" : r.status,
      expiresAt: iso(r.expiresAt) as string,
      sessionExpiresAt: r.status === "signed_in" ? iso(r.sessionExpiresAt) : null,
      stopReason: r.status === "stopped" ? (r.stopReason ?? null) : null,
    });
  }
  return out;
}

/** The provider chat reads sign-in cards through (registered on the bridge by the browser module). */
export function signInCardsProvider(deps: { core: Core; client: SandboxdClient | null }): SignInCards {
  return {
    linkOf: (tx, messageIds) => signInLinksOf(tx, messageIds),
    skip: (tx, input) => skip(tx, deps, input),
  };
}
