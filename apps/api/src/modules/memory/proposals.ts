import {
  hasBlockingFinding,
  MAX_TOOL_CALLS_PER_TURN,
  MEMORY_LIMITS,
  type MemoryProposalOp,
  type MemoryToolRefusal,
  type MemoryToolScope,
  parseMemoryPath,
  type SensitiveFinding,
} from "@ocw/contracts";
import {
  agentTurns,
  approvalRequests,
  conversationMembers,
  conversations,
  memoryFiles,
  memoryProposals,
  messages,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import type { ApprovalService } from "../approval";
import { memoryResource, type PermissionService } from "../organization";
import { decideMemory, isPersonalLike, type MemoryActor, withPersonalOwner } from "./access";
import { MEMORY_WRITE } from "./approval-kind";
import { type ChangeScan, type ChangeScanner, scanChange } from "./detect";
import { guarded } from "./files";
import { ensureToolScope, liveFileCount, loadScope, resolveToolScope } from "./scopes";

/**
 * Memory proposals (MEM-04, MEM-05, MEM-06, D-08, ADR-0023): what an agent asks to write into memory, stored immutable
 * and requested as a `memory.write` approval that a person decides and the server applies. Bound to a delivered turn:
 * the agent and the human come from `agent_turns`, never from the model. A tainted turn may propose (flagged on the
 * card); no scan ever approves anything. Audit rows carry ids, kinds and counts, never a path or content.
 */

export interface CreateMemoryProposalInput {
  /** 07.6 adds a system origin (ADR-0023 decision 18). */
  origin: { kind: "agent_turn"; eventId: string; agentId: string };
  scope: MemoryToolScope;
  path: string;
  op: MemoryProposalOp;
  content: string;
  baseVersion?: number;
  reason?: string;
}

export type CreateMemoryProposalResult =
  | { approvalId: string; findings: SensitiveFinding[]; readerCount: number }
  | { refused: MemoryToolRefusal };

export interface ProposalDeps {
  core: Pick<Core, "audit">;
  perms: PermissionService;
  approvals: Pick<ApprovalService, "request">;
  scanner: ChangeScanner;
  /** The hand-off to the kind's card hook (Presidio spans are not stored). */
  scans: Map<string, ChangeScan>;
}

type FileRow = typeof memoryFiles.$inferSelect;

async function liveFileAt(tx: Tx, scopeId: string, path: string): Promise<FileRow | null> {
  const [f] = await tx
    .select()
    .from(memoryFiles)
    .where(
      and(
        eq(memoryFiles.scopeId, scopeId),
        isNull(memoryFiles.deletedAt),
        sql`lower(${memoryFiles.path}) = lower(${path})`,
      ),
    )
    .limit(1);
  return f ?? null;
}

/**
 * Whether the turn's conversation is a one-person DM with `userId` (a `dm` whose only human member is them): the only
 * place personal-like memory is used by an agent (ADR-0023 decision 4). A proposal into it anywhere else would show its
 * excerpt to the conversation's other readers on the card.
 */
async function oneHumanDm(tx: Tx, conversationId: string, userId: string): Promise<boolean> {
  const [conv] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conv?.kind !== "dm") return false;
  const humans = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberKind, "user")),
    );
  return humans.length === 1 && humans[0]?.id === userId;
}

/**
 * Creates a proposal for the turn's agent acting for the turn's human. Checks, in order: the turn is this agent's
 * (`unknown_turn`); the path (`path_invalid`); the scope (`not_found`, resolved without creating it); `memory.read` on
 * (scope, path) for the agent on behalf of the human (`denied`); personal-like memory only from the owner's one-person DM
 * (`dm_only`); the op against the live file (`create` on an existing path or `replace` on another
 * version → `version_conflict`; `replace` of a missing file → `not_found`); one tool call counted on the turn
 * (`cap_reached`); the pending cap per (agent, human) (`too_many_pending`); the scan of the added text (a secret →
 * `secret_detected`, nothing stored); the resulting size (`too_large`) and the scope's file limit (`scope_full`). Then
 * the proposal, its approval and the card mirroring it in the turn's conversation, in the caller's transaction.
 */
export async function createMemoryProposal(
  tx: Tx,
  deps: ProposalDeps,
  input: CreateMemoryProposalInput,
): Promise<CreateMemoryProposalResult> {
  const { core, perms } = deps;
  const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, input.origin.eventId));

  const refuse = async (reason: MemoryToolRefusal): Promise<CreateMemoryProposalResult> => {
    const known = turn && turn.agentId === input.origin.agentId;
    await core.audit.record(tx, {
      action: "memory.proposal_refused",
      resourceType: "agent",
      resourceId: known ? turn.agentId : null,
      result: "denied",
      actorKind: known ? "agent" : "system",
      actorId: known ? turn.agentId : null,
      agentId: known ? turn.agentId : null,
      userId: known ? turn.userId : null,
      clientKind: "agent",
      metadata: { reason, op: input.op, ...(known ? { eventId: turn.eventId } : {}) },
    });
    return { refused: reason };
  };

  // Unknown (or another organization's: RLS hides it) or another agent's delivery.
  if (!turn || turn.agentId !== input.origin.agentId) return refuse("unknown_turn");
  const human = turn.userId;
  const actor: MemoryActor = { kind: "agent", agentId: turn.agentId, onBehalfOfUserId: human };

  // Everything below reads and writes through the human's own view of the database (their personal rows only).
  return withPersonalOwner(tx, human, async () => {
    const parsed = parseMemoryPath(input.path);
    if (!parsed.ok) return refuse("path_invalid");
    const path = parsed.path;
    // The alias resolves without creating anything: a refused proposal never leaves an empty scope behind.
    const ref = await resolveToolScope(tx, {
      agentId: turn.agentId,
      onBehalfOfUserId: human,
      scope: input.scope,
    });
    if (!ref) return refuse("not_found");
    if (!(await decideMemory(perms, tx, actor, "memory.read", ref.facts, path)).allowed) {
      return refuse("denied");
    }
    // Personal-like memory only from the owner's one-person DM (07.2-11): the card shows the change to every reader.
    if (isPersonalLike(ref.facts) && !(await oneHumanDm(tx, turn.conversationId, human))) {
      return refuse("dm_only");
    }
    const scope = await loadScope(tx, await ensureToolScope(tx, ref));

    const existing = await liveFileAt(tx, scope.row.id, path);
    if (input.op === "create" && existing) return refuse("version_conflict");
    if (input.op === "replace") {
      if (!existing) return refuse("not_found");
      if (input.baseVersion !== existing.version) return refuse("version_conflict");
    }

    // Count the call (never past the turn's cap) and read the taint in one statement. A tainted turn may propose.
    const [counted] = await tx
      .update(agentTurns)
      .set({ toolCalls: sql`${agentTurns.toolCalls} + 1` })
      .where(and(eq(agentTurns.eventId, turn.eventId), lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN)))
      .returning({ tainted: agentTurns.tainted });
    if (!counted) return refuse("cap_reached");

    // Pending proposals per (agent, human), serialised so the cap is exact.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`memory:proposals:${turn.agentId}:${human}`}, 0))`,
    );
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.kind, MEMORY_WRITE),
          eq(approvalRequests.requestedByAgentId, turn.agentId),
          eq(approvalRequests.requestedForUserId, human),
          eq(approvalRequests.status, "pending"),
          sql`${approvalRequests.expiresAt} > now()`,
        ),
      );
    if ((pending?.n ?? 0) >= MEMORY_LIMITS.pendingProposalsPerRequester) return refuse("too_many_pending");

    const base = input.op === "create" ? null : (existing?.content ?? null);
    const scan = await scanChange({ base, proposed: input.content, op: input.op }, deps.scanner);
    if (hasBlockingFinding(scan.findings)) return refuse("secret_detected");
    if (Buffer.byteLength(scan.result, "utf8") > MEMORY_LIMITS.fileBytes) return refuse("too_large");
    if (!existing && (await liveFileCount(tx, scope.row.id)) >= MEMORY_LIMITS.filesPerScope) {
      return refuse("scope_full");
    }

    const personal = isPersonalLike(scope.facts);
    const readerCount = personal
      ? 1
      : (
          await perms.usersAllowed(tx, {
            candidates: "members",
            permission: "memory.read",
            resourceFor: (userId) => memoryResource(scope.facts, path, { kind: "user", id: userId }),
          })
        ).length;
    const reason = input.reason?.trim().slice(0, MEMORY_LIMITS.reasonChars) || null;

    const [proposal] = await guarded(() =>
      tx
        .insert(memoryProposals)
        .values({
          organizationId: tenantOf(tx).organizationId,
          scopeId: scope.row.id,
          fileId: existing?.id ?? null,
          path,
          op: input.op,
          baseVersion: existing?.version ?? null,
          content: input.content,
          contentSha256: sha256Hex(input.content),
          findings: scan.findings as unknown as Array<Record<string, unknown>>,
          readerCount,
          tainted: counted.tainted,
          reason,
          requestedByAgentId: turn.agentId,
          requestedForUserId: human,
          eventId: turn.eventId,
          conversationId: turn.conversationId,
        })
        .returning({ id: memoryProposals.id }),
    );
    if (!proposal) throw new Error("memory proposal insert returned no row");

    // The card replies to the human's message, in its thread when it has one (flat conversations ignore it).
    const [asked] = await tx
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(eq(messages.id, turn.messageId))
      .limit(1);
    deps.scans.set(proposal.id, scan);
    let approvalId: string;
    try {
      ({ id: approvalId } = await deps.approvals.request(tx, {
        kind: MEMORY_WRITE,
        resourceId: proposal.id,
        requestedByAgentId: turn.agentId,
        requestedForUserId: human,
        eventId: turn.eventId,
        card: {
          agentId: turn.agentId,
          conversationId: turn.conversationId,
          inReplyToMessageId: turn.messageId,
          threadRootMessageId: asked?.threadId ?? null,
        },
      }));
    } finally {
      deps.scans.delete(proposal.id);
    }

    await core.audit.record(tx, {
      action: "memory.proposal_created",
      resourceType: "memory_proposal",
      resourceId: proposal.id,
      actorKind: "agent",
      actorId: turn.agentId,
      agentId: turn.agentId,
      userId: human,
      clientKind: "agent",
      metadata: {
        proposalId: proposal.id,
        approvalId,
        scopeId: scope.row.id,
        scopeKind: scope.row.kind,
        op: input.op,
        findingKinds: [...new Set(scan.findings.map((f) => f.kind))],
        readerCount,
        tainted: counted.tainted,
      },
    });
    return { approvalId, findings: scan.findings, readerCount };
  });
}
