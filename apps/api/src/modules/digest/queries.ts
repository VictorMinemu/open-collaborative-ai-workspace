import type { Permission } from "@ocw/contracts";
import {
  conversations,
  messageCardFollows,
  messageCards,
  messages,
  notifications,
  orgUnits,
  type Tx,
  workProjectRepos,
  workSessions,
} from "@ocw/db";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { ApprovalService } from "../approval";
import { type ConversationAccess, loadDirectory } from "../chat";
import { NOTIFIABLE_KINDS, visibleNotifications } from "../notification";
import { orgResource, type PermissionService, type ResourceFacts } from "../organization";
import { projectNamedFor, type SessionProject, sessionFacts } from "../work-session";
import { DIGEST_SECTION_MAX, type DigestItem } from "./compose";

/**
 * The digest's four sections (07.6-13; AUTO-05, D-05, D-11; T-07.6-13-01). Each runs in the person's own tenant
 * transaction (RLS as them) and returns only what they may read NOW, newest first, at most 20 lines, of what happened
 * after `since` (the last digest that was sent, else 24 hours ago). Every read goes through the rule its own surface
 * uses, never a copy:
 *
 * - decisions: 07.2's approval inbox (`ApprovalService.list` as decider, pending), which re-decides each request with
 *   its kind's `canDecide` (a decider who lost the right stops seeing it);
 * - follows: the person's followed Agent Cards changed since, only in conversations they read now (chat's readable
 *   set, the inbox's own kinds);
 * - mentions: their unread notifications through the inbox's visibility rule (own rows, readable conversations, live
 *   messages); the digest's own DMs are never listed;
 * - Work Zone (D-11): candidate sessions (RLS-scoped), then `sessionFacts` (the one reader of `app.work_session_access`)
 *   and the resolver's `work_session.read` for the person, exactly as `GET /work-sessions` decides; a session waiting
 *   for approval is listed only when they may decide it (`work_session.approve`), and its team project is named only
 *   when 07.10's per-viewer rule (`projectNamedFor`) names it for them.
 *
 * Nothing here reads a message body: titles, names and states only.
 */

export interface DigestQueryDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  access: ConversationAccess;
}

type ConvKind = "channel" | "dm" | "group" | "ai_chat";

/** A message's in-app path (ids only, the web's permalink shapes). */
export function messageHref(
  conv: { id: string; kind: string },
  messageId: string,
  threadRootId: string | null,
): string {
  if (conv.kind === "ai_chat") return `/chat/ai/${conv.id}`;
  if (conv.kind !== "channel") return `/chat/dm/${conv.id}?m=${messageId}`;
  if (threadRootId && threadRootId !== messageId)
    return `/chat/${conv.id}?thread=${threadRootId}&m=${messageId}`;
  return `/chat/${conv.id}?m=${messageId}`;
}

/** Where a conversation is, in words (`#sales`, `a direct message`). */
function placeOf(conv: { kind: string; name: string | null }): string {
  switch (conv.kind as ConvKind) {
    case "channel":
      return conv.name ? `#${conv.name}` : "a channel";
    case "ai_chat":
      return "an AI chat";
    case "group":
      return "a group message";
    default:
      return "a direct message";
  }
}

const at = (v: string | Date) => new Date(v);

// ---------------------------------------------------------------- decisions

/** Approvals and proposals waiting for the person's decision, asked since `since`. */
export async function pendingDecisions(
  tx: Tx,
  deps: Pick<DigestQueryDeps, "approvals">,
  userId: string,
  since: Date,
): Promise<DigestItem[]> {
  const list = await deps.approvals.list(tx, userId, { role: "decider", status: "pending" });
  return list.items
    .filter((i) => i.viewerCan.includes("decide") && at(i.createdAt) > since)
    .slice(0, DIGEST_SECTION_MAX)
    .map((i) => ({
      title: i.headline?.title ?? "A request is waiting for your decision",
      href: `/approvals/${i.id}`,
      detail: i.headline?.requester ?? (i.requestedBy.displayName || null),
      at: at(i.createdAt),
    }));
}

// ---------------------------------------------------------------- followed cards

const CARD_STATES: Record<string, string | null> = {
  info: null,
  pending: "Pending",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Cards the person follows that changed since `since`, in conversations they still read. */
export async function followedCards(
  tx: Tx,
  deps: Pick<DigestQueryDeps, "access">,
  userId: string,
  since: Date,
): Promise<DigestItem[]> {
  const readable = await deps.access.readableIds(tx, userId, { kinds: NOTIFIABLE_KINDS });
  if (readable.length === 0) return [];
  const rows = await tx
    .select({
      messageId: messageCards.messageId,
      title: messageCards.title,
      status: messageCards.status,
      statusLabel: messageCards.statusLabel,
      platformOwned: messageCards.platformOwned,
      updatedAt: messageCards.updatedAt,
      threadId: messages.threadId,
      convId: conversations.id,
      convKind: conversations.kind,
      convName: conversations.name,
    })
    .from(messageCardFollows)
    .innerJoin(messageCards, eq(messageCards.messageId, messageCardFollows.messageId))
    .innerJoin(messages, eq(messages.id, messageCards.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messageCardFollows.userId, userId),
        gt(messageCards.updatedAt, since.toISOString()),
        isNull(messages.deletedAt),
        inArray(messages.conversationId, readable),
      ),
    )
    .orderBy(desc(messageCards.updatedAt), desc(messageCards.messageId))
    .limit(DIGEST_SECTION_MAX);
  return rows.map((r) => {
    const state = (r.platformOwned ? r.statusLabel : null) ?? CARD_STATES[r.status] ?? null;
    const place = placeOf({ kind: r.convKind, name: r.convName });
    return {
      title: r.title,
      href: messageHref({ id: r.convId, kind: r.convKind }, r.messageId, r.threadId),
      detail: state ? `${state} · ${place}` : place,
      at: at(r.updatedAt),
    };
  });
}

// ---------------------------------------------------------------- unread mentions

/** "Mentions, replies and DMs" (UI-SPEC): the inbox kinds addressed to the person. */
export const DIGEST_MENTION_KINDS = ["mention", "here", "channel", "thread_reply", "dm", "group_dm"] as const;

/** The idempotency key of a digest's own DM message (never listed by the next digest). */
export const digestMessageKey = (runId: string) => `digest:${runId}`;

const VERBS: Record<(typeof DIGEST_MENTION_KINDS)[number], (who: string, where: string) => string> = {
  mention: (who, where) => `${who} mentioned you in ${where}`,
  here: (who, where) => `${who} notified everyone here in ${where}`,
  channel: (who, where) => `${who} notified everyone in ${where}`,
  thread_reply: (who, where) => `${who} replied in a thread in ${where}`,
  dm: (who) => `${who} sent you a direct message`,
  group_dm: (who) => `${who} wrote in a group message`,
};

/** The person's unread mentions, replies and DMs since `since`, through the inbox's own visibility rule. */
export async function unreadMentions(
  tx: Tx,
  deps: Pick<DigestQueryDeps, "access">,
  userId: string,
  since: Date,
): Promise<DigestItem[]> {
  const readable = await deps.access.readableIds(tx, userId, { kinds: NOTIFIABLE_KINDS });
  if (readable.length === 0) return [];
  const rows = await tx
    .select({
      kind: notifications.kind,
      messageId: notifications.messageId,
      threadRootId: notifications.threadRootId,
      actorKind: notifications.actorKind,
      actorId: notifications.actorId,
      createdAt: notifications.createdAt,
      convId: conversations.id,
      convKind: conversations.kind,
      convName: conversations.name,
    })
    .from(notifications)
    .innerJoin(messages, eq(messages.id, notifications.messageId))
    .innerJoin(conversations, eq(conversations.id, notifications.conversationId))
    .where(
      and(
        visibleNotifications(userId, readable, "all"),
        isNull(notifications.readAt),
        inArray(notifications.kind, [...DIGEST_MENTION_KINDS]),
        gt(notifications.createdAt, since.toISOString()),
        // A digest is a DM from a bot: the next digest never lists the last one.
        or(
          sql`${messages.authorKind} <> 'agent'`,
          isNull(messages.clientMessageId),
          sql`${messages.clientMessageId} not like 'digest:%'`,
        ),
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(DIGEST_SECTION_MAX);
  if (rows.length === 0) return [];
  const dir = await loadDirectory(tx);
  return rows.map((r) => {
    const who =
      (r.actorKind === "agent" ? dir.agents : dir.users).get(r.actorId ?? "")?.displayName ??
      (r.actorKind === "agent" ? "A bot" : "Someone");
    const verb = VERBS[r.kind as (typeof DIGEST_MENTION_KINDS)[number]];
    return {
      title: verb(who, placeOf({ kind: r.convKind, name: r.convName })),
      href: messageHref({ id: r.convId, kind: r.convKind }, r.messageId, r.threadRootId),
      detail: null,
      at: at(r.createdAt),
    };
  });
}

// ---------------------------------------------------------------- Work Zone (D-11)

/** Sessions read for the digest: waiting for approval, or ended (completed or failed). */
const WAITING = "waiting_approval";
const ENDED = ["completed", "failed"] as const;
/** Candidate rows read before the resolver narrows them. */
const CANDIDATES = 200;

/**
 * Work Zone sessions waiting for the person's approval or ended since `since`, only through the audience rule (D-11):
 * candidates RLS-scoped, then `sessionFacts` per row and the resolver's `work_session.read` for the person (the list's
 * decision, after its organization-scope `work_session.read`); a waiting session only when they may decide it
 * (`work_session.approve`, 07.10's attention rule). Never its own audience SQL.
 */
export async function workZoneSessions(
  tx: Tx,
  perms: PermissionService,
  userId: string,
  since: Date,
): Promise<DigestItem[]> {
  const principal = { kind: "user", userId } as const;
  // GET /work-sessions' own gate (the Work Zone module, the organization-wide grain).
  if (!(await perms.decide(tx, principal, "work_session.read", orgResource())).allowed) return [];
  const candidates = await tx
    .select({
      id: workSessions.id,
      createdBy: workSessions.createdBy,
      deviceId: workSessions.deviceId,
      title: workSessions.title,
      status: workSessions.status,
      updatedAt: workSessions.updatedAt,
      unitId: orgUnits.id,
      unitName: orgUnits.name,
      unitPath: orgUnits.path,
    })
    .from(workSessions)
    .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, workSessions.projectId))
    .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
    .where(
      and(inArray(workSessions.status, [WAITING, ...ENDED]), gt(workSessions.updatedAt, since.toISOString())),
    )
    .orderBy(desc(workSessions.updatedAt), desc(workSessions.id))
    .limit(CANDIDATES);
  if (candidates.length === 0) return [];
  const withFacts = [];
  for (const c of candidates) withFacts.push({ ...c, facts: await sessionFacts(tx, userId, c) });
  const readable = await perms.filterFor(tx, principal, withFacts, "work_session.read", (r) => r.facts);
  const deciders = new Set(
    (
      await perms.filterFor(
        tx,
        principal,
        readable.filter((r) => r.status === WAITING),
        "work_session.approve",
        (r) => r.facts,
      )
    ).map((r) => r.id),
  );
  const filter = <T>(items: readonly T[], permission: Permission, toResource: (item: T) => ResourceFacts) =>
    perms.filterFor(tx, principal, items, permission, toResource);
  const out: DigestItem[] = [];
  for (const r of readable) {
    if (out.length === DIGEST_SECTION_MAX) break;
    if (r.status === WAITING && !deciders.has(r.id)) continue;
    const project: SessionProject | null =
      r.unitId && r.unitName ? { id: r.unitId, name: r.unitName, path: r.unitPath ?? [] } : null;
    const named =
      project !== null &&
      (await projectNamedFor(tx, { viewerId: userId, createdBy: r.createdBy, project, filter }));
    const state =
      r.status === WAITING ? "Waiting for your approval" : r.status === "failed" ? "Failed" : "Ended";
    out.push({
      title: r.title,
      href: `/work-zone/${r.id}`,
      detail: named && project ? `${project.name} · ${state}` : state,
      at: at(r.updatedAt),
    });
  }
  return out;
}
