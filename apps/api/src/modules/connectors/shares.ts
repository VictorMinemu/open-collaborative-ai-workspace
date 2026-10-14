import type {
  CreateMemberAccountShareRequest,
  MemberAccountResourceKind,
  MemberAccountShare,
  ReadersPreview,
} from "@ocw/contracts";
import {
  aiChatGrants,
  connectorConnections,
  conversationMembers,
  conversations,
  mcpServers,
  memberAccountShares,
  orgMembers,
  type Tx,
  tenantOf,
  vaultItems,
} from "@ocw/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Core } from "../../core";
import { conflict, notFound } from "../../lib/errors";
import { aiAccessSql, type ConversationAccess } from "../chat";
import { orgResource, type PermissionService } from "../organization";

/**
 * Member-account shares (Phase 07.4, D-03; CONN-03): a member's explicit, audited choice to let bots act with their OWN
 * account (a per-member connector they are connected to, or one of their personal keys) in one conversation they can
 * read, after seeing how many people read it. Results obtained with that account become visible to those readers.
 * Revoking is immediate: the tool gate (07.4-11) re-decides with `activeShare` at call time.
 *
 * - The owner is always the session user (never a field); the resource must be theirs and the conversation readable
 *   through the readable set (`ConversationAccess`), else 404 (hidden = missing).
 * - The reader count is computed here, server-side, at grant time (T-07.4-10-08): a DM, group or private channel → its
 *   human members; a public channel → every active member, `unbounded`; an AI chat → every active member its own access
 *   rule (owner + grants, `aiAccessSql`) admits, `unbounded` while a unit or the organization holds a grant (ADR-0019
 *   decision 7); a thread → its channel.
 */

const READABLE_KINDS = ["channel", "dm", "group", "ai_chat"] as const;
type ShareRow = typeof memberAccountShares.$inferSelect;

const missing = (what = "Conversation not found") => notFound(what, "not_found");

/** The conversation readers are judged by: a thread is its parent channel's. */
async function judged(tx: Tx, conversationId: string) {
  const [conv] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      visibility: conversations.visibility,
      name: conversations.name,
      parentConversationId: conversations.parentConversationId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conv?.kind !== "thread" || !conv.parentConversationId) return conv ?? null;
  return judged(tx, conv.parentConversationId);
}

/** Who reads results posted in a conversation, counted server-side, and its display name (`#name`, AI chat title). */
export async function readersOf(
  tx: Tx,
  conversationId: string,
): Promise<{ readers: number; unbounded: boolean; name: string | null }> {
  const conv = await judged(tx, conversationId);
  if (!conv) return { readers: 0, unbounded: true, name: null };
  const activeMembers = async (where?: ReturnType<typeof sql>) => {
    const res = await tx.execute(
      sql`select count(*)::int as n from app.org_members om where om.deactivated_at is null ${
        where ? sql`and ${where}` : sql``
      }`,
    );
    return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
  };
  if (conv.kind === "ai_chat") {
    const [group] = await tx
      .select({ id: aiChatGrants.id })
      .from(aiChatGrants)
      .where(
        and(
          eq(aiChatGrants.conversationId, conv.id),
          inArray(aiChatGrants.subjectKind, ["unit", "org"]),
          isNull(aiChatGrants.revokedAt),
        ),
      )
      .limit(1);
    const readers = await activeMembers(
      sql`${aiAccessSql(sql`om.user_id`, sql`${conv.id}::uuid`)} is not null`,
    );
    // An AI chat's title is its conversation's name.
    return { readers, unbounded: group !== undefined, name: conv.name ?? null };
  }
  const name = conv.kind === "channel" ? `#${conv.name}` : null;
  if (conv.kind === "channel" && conv.visibility !== "private") {
    return { readers: await activeMembers(), unbounded: true, name };
  }
  const humans = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, conversationMembers.memberId), isNull(orgMembers.deactivatedAt)),
    )
    .where(and(eq(conversationMembers.conversationId, conv.id), eq(conversationMembers.memberKind, "user")));
  return { readers: humans.length, unbounded: false, name };
}

/** The caller's own resource and its display name, or null (another member's, missing or another organization's). */
async function ownResource(
  tx: Tx,
  userId: string,
  kind: MemberAccountResourceKind,
  resourceId: string,
): Promise<{ name: string } | null> {
  if (kind === "connector") {
    const [row] = await tx
      .select({ name: mcpServers.name, authMode: mcpServers.authMode, status: connectorConnections.status })
      .from(mcpServers)
      .innerJoin(
        connectorConnections,
        and(eq(connectorConnections.serverId, mcpServers.id), eq(connectorConnections.userId, userId)),
      )
      .where(eq(mcpServers.id, resourceId))
      .limit(1);
    return row && row.authMode !== "org_secret" ? { name: row.name } : null;
  }
  // Personal keys are their owner's alone (RLS restrictive policy too); unit keys are never "a member's account".
  const [item] = await tx
    .select({ name: vaultItems.name })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.id, resourceId),
        eq(vaultItems.scope, "personal"),
        eq(vaultItems.ownerUserId, userId),
      ),
    )
    .limit(1);
  return item ?? null;
}

/** Whether the member's account is allowed in that conversation now (the tool gate, 07.4-11/12). */
export async function activeShare(
  tx: Tx,
  p: { userId: string; conversationId: string; resourceKind: MemberAccountResourceKind; resourceId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ id: memberAccountShares.id })
    .from(memberAccountShares)
    .where(
      and(
        eq(memberAccountShares.userId, p.userId),
        eq(memberAccountShares.conversationId, p.conversationId),
        eq(memberAccountShares.resourceKind, p.resourceKind),
        eq(memberAccountShares.resourceId, p.resourceId),
        isNull(memberAccountShares.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface SharesDeps {
  core: Core;
  perms: PermissionService;
  access: ConversationAccess;
}

const permissionOf = (kind: MemberAccountResourceKind) =>
  kind === "connector" ? "connector.connect" : "vault.use";

function toDto(row: ShareRow, conversationName: string | null, resourceName: string): MemberAccountShare {
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationName,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    resourceName,
    readersAtGrant: row.readersAtGrant,
    grantedAt: new Date(row.grantedAt).toISOString(),
  };
}

/** The reader count shown before a member allows their account (404 unless the caller reads the conversation). */
export async function previewReaders(
  d: SharesDeps,
  req: FastifyRequest,
  tx: Tx,
  conversationId: string,
): Promise<ReadersPreview> {
  await d.access.readable(req, tx, conversationId, { kinds: READABLE_KINDS });
  const r = await readersOf(tx, conversationId);
  return { conversationId, conversationName: r.name, readers: r.readers, unbounded: r.unbounded };
}

export async function createShare(
  d: SharesDeps,
  req: FastifyRequest,
  tx: Tx,
  userId: string,
  input: CreateMemberAccountShareRequest,
): Promise<MemberAccountShare> {
  await d.perms.assertCan(req, tx, permissionOf(input.resourceKind), orgResource());
  await d.access.readable(req, tx, input.conversationId, { kinds: READABLE_KINDS });
  const resource = await ownResource(tx, userId, input.resourceKind, input.resourceId);
  if (!resource) {
    throw missing(input.resourceKind === "connector" ? "Connection not found" : "Key not found");
  }
  if (await activeShare(tx, { userId, ...input })) {
    throw conflict("It's already allowed in this conversation", "share_exists");
  }
  const r = await readersOf(tx, input.conversationId);
  const [row] = await tx
    .insert(memberAccountShares)
    .values({
      organizationId: tenantOf(tx).organizationId,
      userId,
      conversationId: input.conversationId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      readersAtGrant: r.readers,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("It's already allowed in this conversation", "share_exists");
  await d.core.audit.record(tx, {
    action: "member_account.shared",
    resourceType: "member_account_share",
    resourceId: row.id,
    metadata: {
      conversationId: input.conversationId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      readers: r.readers,
      ...(r.unbounded ? { unbounded: true } : {}),
    },
  });
  return toDto(row, r.name, resource.name);
}

/** The caller's active shares whose resource still exists; a conversation they can no longer read has no name. */
export async function listShares(d: SharesDeps, tx: Tx, userId: string): Promise<MemberAccountShare[]> {
  const rows = await tx
    .select()
    .from(memberAccountShares)
    .where(and(eq(memberAccountShares.userId, userId), isNull(memberAccountShares.revokedAt)))
    .orderBy(desc(memberAccountShares.grantedAt));
  const out: MemberAccountShare[] = [];
  for (const row of rows) {
    const resource = await ownResource(tx, userId, row.resourceKind, row.resourceId);
    if (!resource) continue;
    const readable = await d.access.isReadable(tx, userId, row.conversationId, { kinds: READABLE_KINDS });
    out.push(toDto(row, readable ? (await readersOf(tx, row.conversationId)).name : null, resource.name));
  }
  return out;
}

/** Revokes one of the caller's own active shares (404 for anyone else's); immediate at the next tool call. */
export async function revokeShare(d: SharesDeps, tx: Tx, userId: string, shareId: string): Promise<void> {
  const [row] = await tx
    .update(memberAccountShares)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(memberAccountShares.id, shareId),
        eq(memberAccountShares.userId, userId),
        isNull(memberAccountShares.revokedAt),
      ),
    )
    .returning({ id: memberAccountShares.id });
  if (!row) throw notFound("Share not found", "not_found");
  await d.core.audit.record(tx, {
    action: "member_account.share_revoked",
    resourceType: "member_account_share",
    resourceId: row.id,
    metadata: { shareId: row.id },
  });
}
