import {
  detectSensitive,
  hasBlockingFinding,
  MAX_TOOL_CALLS_PER_TURN,
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  MEMORY_ROOT_TEMPLATE,
  type MemoryProposalOp,
  type MemoryToolRefusal,
  type MemoryToolScope,
  memoryPathKey,
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
  type TenantDb,
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
import { ensureToolScope, type LoadedScope, liveFileCount, loadScope, resolveToolScope } from "./scopes";

/**
 * Memory proposals (MEM-04, MEM-05, MEM-06, D-08, ADR-0023): what an agent asks to write into memory, stored immutable
 * and requested as a `memory.write` approval that a person decides and the server applies. Bound to a delivered turn:
 * the agent and the human come from `agent_turns`, never from the model. A tainted turn may propose (flagged on the
 * card); no scan ever approves anything. Audit rows carry ids, kinds and counts, never a path or content.
 */

/**
 * Who asks: an agent's delivered turn (07.2), or the platform for a person (07.6, ADR-0023 decision 18): a finished Work
 * Zone session's summary, requested for the session's owner with no agent (`requested_by_agent_id` null) and no card
 * (a card needs an agent author; the approvals inbox and `approval_request.updated` reach the deciders).
 */
export type MemoryProposalOrigin =
  | { kind: "agent_turn"; eventId: string; agentId: string }
  | {
      kind: "system";
      source: "work_session";
      workSessionId: string;
      requestedForUserId: string;
      /** The content came from untrusted input (a session's tool output): the approver sees the warning. */
      tainted: boolean;
    };

export interface CreateMemoryProposalInput {
  origin: MemoryProposalOrigin;
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
  /** The hand-off to the kind's card hook (Presidio spans are not stored). */
  scans: Map<string, ChangeScan>;
}

/**
 * The detector's verdict on a proposal, computed BEFORE its transaction (`prescanProposal`, WINDOWS 145) so Presidio
 * never holds a connection, a row lock or the pending-cap advisory lock. `inputHash` names exactly what was scanned
 * (the op, the base text and the proposed text); the transaction recomputes it from what it reads and refuses on any
 * difference. Null = nothing worth scanning (the transaction refuses on its own checks first).
 */
export type ProposalPrescan = { inputHash: string; scan: ChangeScan } | null;

/** What a scan depends on: the op, the base text it diffs against (null: none) and the proposed text. */
function scanInputHash(op: MemoryProposalOp, base: string | null, proposed: string): string {
  return sha256Hex(JSON.stringify([op, base === null ? null : sha256Hex(base), sha256Hex(proposed)]));
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
 * The detector run of a proposal, outside any transaction (WINDOWS 145): a short read-only transaction finds the turn,
 * the scope and the base text exactly as `createMemoryProposal` will (through the human's lens, nothing created or
 * written, the agent's read decided), then layer 1 and layer 2 (Presidio, up to its timeout) run with no connection
 * held. Whatever cannot be resolved (unknown turn, bad path, missing scope, a denied read, the turn's cap already
 * reached) returns null without calling Presidio: the transaction refuses it on its own checks.
 */
export async function prescanProposal(
  db: TenantDb,
  deps: { perms: PermissionService; scanner: ChangeScanner },
  organizationId: string,
  input: CreateMemoryProposalInput,
): Promise<ProposalPrescan> {
  const parsed = parseMemoryPath(input.path);
  if (!parsed.ok) return null;
  const path = parsed.path;
  const origin = input.origin;
  const base = await db.withTenant({ organizationId, userId: null }, async (tx) => {
    if (origin.kind === "system") {
      return withPersonalOwner(tx, origin.requestedForUserId, async () => {
        const scope = await systemScope(tx, deps.perms, origin.requestedForUserId, input.scope, path);
        if (!scope) return null;
        if (input.op === "create") return { text: null };
        return { text: (await liveFileAt(tx, scope.row.id, path))?.content ?? null };
      });
    }
    const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, origin.eventId));
    if (!turn || turn.agentId !== origin.agentId || turn.toolCalls >= MAX_TOOL_CALLS_PER_TURN) return null;
    const human = turn.userId;
    return withPersonalOwner(tx, human, async () => {
      const ref = await resolveToolScope(tx, {
        agentId: turn.agentId,
        onBehalfOfUserId: human,
        scope: input.scope,
      });
      if (!ref) return null;
      const actor: MemoryActor = { kind: "agent", agentId: turn.agentId, onBehalfOfUserId: human };
      if (!(await decideMemory(deps.perms, tx, actor, "memory.read", ref.facts, path)).allowed) return null;
      if (input.op === "create") return { text: null };
      // A scope not created yet holds only its root file, from the template, once created.
      if (!ref.id)
        return {
          text: memoryPathKey(path) === memoryPathKey(MEMORY_ROOT_FILE) ? MEMORY_ROOT_TEMPLATE : null,
        };
      return { text: (await liveFileAt(tx, ref.id, path))?.content ?? null };
    });
  });
  if (!base) return null;
  const scan = await scanChange({ base: base.text, proposed: input.content, op: input.op }, deps.scanner);
  return { inputHash: scanInputHash(input.op, base.text, input.content), scan };
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
 * (`cap_reached`); the pending cap per (agent, human) (`too_many_pending`); the scan of the added text and of the
 * bot's note (a secret in either → `secret_detected`, nothing stored); the resulting size (`too_large`) and the scope's file limit (`scope_full`). Then
 * the proposal, its approval and the card mirroring it in the turn's conversation, in the caller's transaction.
 */
export async function createMemoryProposal(
  tx: Tx,
  deps: ProposalDeps,
  input: CreateMemoryProposalInput,
  prescan: ProposalPrescan,
): Promise<CreateMemoryProposalResult> {
  const { core, perms } = deps;
  const origin = input.origin;
  if (origin.kind === "system") return createSystemProposal(tx, deps, { ...input, origin }, prescan);
  const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, origin.eventId));

  const refuse = async (reason: MemoryToolRefusal): Promise<CreateMemoryProposalResult> => {
    const known = turn && turn.agentId === origin.agentId;
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
  if (!turn || turn.agentId !== origin.agentId) return refuse("unknown_turn");
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

    // The scan ran before this transaction (`prescanProposal`): use it only if it scanned exactly what is here now. A
    // base that changed in between (or a scope that appeared) is refused, never re-scanned inside the transaction.
    const base = input.op === "create" ? null : (existing?.content ?? null);
    if (!prescan || prescan.inputHash !== scanInputHash(input.op, base, input.content)) {
      return refuse("version_conflict");
    }
    const scan = prescan.scan;
    if (hasBlockingFinding(scan.findings)) return refuse("secret_detected");
    // The bot's note shows on the platform-owned card ("Bot's note"): never a side channel for a secret. Layer 1 runs
    // on the note as sent (before trimming and the length cap), so a secret cut by the cap is refused too.
    if (input.reason && hasBlockingFinding(detectSensitive(input.reason).findings)) {
      return refuse("secret_detected");
    }
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

// ---------------------------------------------------------------- the system origin (07.6, ADR-0023 decision 18)

type SystemOrigin = Extract<MemoryProposalOrigin, { kind: "system" }>;

/**
 * The shared scope a system proposal for `human` may go to: an existing scope id (never an alias), not personal-like
 * memory (a person's private memory is written by that person or their bot, never by the platform), and one the human
 * may read at `path`, as an agent's proposal needs for the human it acts for. Null = refused.
 */
async function systemScope(
  tx: Tx,
  perms: PermissionService,
  human: string,
  scopeRef: MemoryToolScope,
  path: string,
): Promise<LoadedScope | null> {
  if (scopeRef === "personal" || scopeRef === "agent") return null;
  let scope: LoadedScope;
  try {
    scope = await loadScope(tx, scopeRef);
  } catch {
    return null;
  }
  if (isPersonalLike(scope.facts)) return null;
  const actor: MemoryActor = { kind: "user", userId: human };
  if (!(await decideMemory(perms, tx, actor, "memory.read", scope.facts, path)).allowed) return null;
  return scope;
}

/**
 * Whether a system proposal for `requestedForUserId` may go to `scopeId` at `path`: the scope check `propose` makes
 * for the system origin, through the person's lens, nothing created or written. A caller about to pay for a model call
 * checks it first (07.6 review C LO-05).
 */
export async function systemProposalAllowed(
  tx: Tx,
  perms: PermissionService,
  a: { requestedForUserId: string; scopeId: string; path: string },
): Promise<boolean> {
  const parsed = parseMemoryPath(a.path);
  if (!parsed.ok) return false;
  return withPersonalOwner(
    tx,
    a.requestedForUserId,
    async () => (await systemScope(tx, perms, a.requestedForUserId, a.scopeId, parsed.path)) !== null,
  );
}

/**
 * A proposal the platform makes for a person (07.6, AUTO-06: a Work Zone session's summary for its owner). The same
 * checks as an agent's, minus what only a turn has (the turn, its tool-call cap, the DM rule): an existing shared scope
 * the person may read (`denied`); the op against the live file (`version_conflict` / `not_found`); the pending cap per
 * person for system proposals (`too_many_pending`); the scan made before the transaction, unchanged (`version_conflict`),
 * a secret in it refusing the proposal (`secret_detected`); the size and the scope's file limit. No agent, no event, no
 * conversation and no card; the approval is requested for the person, and 07.2's deciders decide it unchanged.
 */
async function createSystemProposal(
  tx: Tx,
  deps: ProposalDeps,
  input: CreateMemoryProposalInput & { origin: SystemOrigin },
  prescan: ProposalPrescan,
): Promise<CreateMemoryProposalResult> {
  const { core, perms } = deps;
  const { origin } = input;
  const human = origin.requestedForUserId;
  const refuse = async (reason: MemoryToolRefusal): Promise<CreateMemoryProposalResult> => {
    await core.audit.record(tx, {
      action: "memory.proposal_refused",
      resourceType: "work_session",
      resourceId: origin.workSessionId,
      result: "denied",
      actorKind: "system",
      actorId: null,
      userId: human,
      metadata: { reason, op: input.op, source: origin.source },
    });
    return { refused: reason };
  };

  return withPersonalOwner(tx, human, async () => {
    const parsed = parseMemoryPath(input.path);
    if (!parsed.ok) return refuse("path_invalid");
    const path = parsed.path;
    const loaded = await systemScope(tx, perms, human, input.scope, path);
    if (!loaded) return refuse("denied");
    const scope = loaded;

    const existing = await liveFileAt(tx, scope.row.id, path);
    if (input.op === "create" && existing) return refuse("version_conflict");
    if (input.op === "replace") {
      if (!existing) return refuse("not_found");
      if (input.baseVersion !== existing.version) return refuse("version_conflict");
    }

    // Pending system proposals per person, serialised so the cap is exact.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`memory:proposals:system:${human}`}, 0))`,
    );
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.kind, MEMORY_WRITE),
          isNull(approvalRequests.requestedByAgentId),
          eq(approvalRequests.requestedForUserId, human),
          eq(approvalRequests.status, "pending"),
          sql`${approvalRequests.expiresAt} > now()`,
        ),
      );
    if ((pending?.n ?? 0) >= MEMORY_LIMITS.pendingProposalsPerRequester) return refuse("too_many_pending");

    const base = input.op === "create" ? null : (existing?.content ?? null);
    if (!prescan || prescan.inputHash !== scanInputHash(input.op, base, input.content)) {
      return refuse("version_conflict");
    }
    const scan = prescan.scan;
    if (hasBlockingFinding(scan.findings)) return refuse("secret_detected");
    if (input.reason && hasBlockingFinding(detectSensitive(input.reason).findings)) {
      return refuse("secret_detected");
    }
    if (Buffer.byteLength(scan.result, "utf8") > MEMORY_LIMITS.fileBytes) return refuse("too_large");
    if (!existing && (await liveFileCount(tx, scope.row.id)) >= MEMORY_LIMITS.filesPerScope) {
      return refuse("scope_full");
    }

    const readerCount = (
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
          tainted: origin.tainted,
          reason,
          requestedByAgentId: null,
          requestedForUserId: human,
          eventId: null,
          conversationId: null,
        })
        .returning({ id: memoryProposals.id }),
    );
    if (!proposal) throw new Error("memory proposal insert returned no row");

    deps.scans.set(proposal.id, scan);
    let approvalId: string;
    try {
      ({ id: approvalId } = await deps.approvals.request(tx, {
        kind: MEMORY_WRITE,
        resourceId: proposal.id,
        requestedByAgentId: null,
        requestedForUserId: human,
        eventId: null,
      }));
    } finally {
      deps.scans.delete(proposal.id);
    }

    await core.audit.record(tx, {
      action: "memory.proposal_created",
      resourceType: "memory_proposal",
      resourceId: proposal.id,
      actorKind: "system",
      actorId: null,
      userId: human,
      metadata: {
        proposalId: proposal.id,
        approvalId,
        scopeId: scope.row.id,
        scopeKind: scope.row.kind,
        op: input.op,
        findingKinds: [...new Set(scan.findings.map((f) => f.kind))],
        readerCount,
        source: origin.source,
        workSessionId: origin.workSessionId,
      },
    });
    return { approvalId, findings: scan.findings, readerCount };
  });
}
