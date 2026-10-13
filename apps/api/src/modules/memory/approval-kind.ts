import {
  type AgentCardField,
  type AgentCardInput,
  type ApprovalHeadline,
  type ApprovalTag,
  type ApprovalView,
  MEMORY_LIMITS,
  type MemoryFile,
  type MemoryProposalOp,
  type MemoryProposalView,
  type SensitiveFinding,
  type SensitiveFindingKind,
} from "@ocw/contracts";
import { agents, memoryFileRevisions, memoryFiles, memoryProposals, orgMembers, type Tx } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sha256Hex } from "../../lib/crypto";
import { conflict, HttpError } from "../../lib/errors";
import type { ApplyResult, ApprovalKind, ApprovalRow } from "../approval";
import { memoryResource, type PermissionService } from "../organization";
import { decideMemory, isPersonalLike, type MemoryActor, personalOwnerOf } from "./access";
import { type ChangeScan, changeExcerpt, MAX_VIEW_FINDINGS, NO_SCANNER, scanChange } from "./detect";
import type { WriteFileOp } from "./files";
import { type LoadedScope, loadScope } from "./scopes";

/**
 * The `memory.write` approval kind (MEM-05, MEM-06, MEM-07, D-08, ADR-0023): an agent's proposal into a memory scope,
 * decided by a person and applied by the server through the memory file operations. Every hook reads the stored
 * proposal (`memory_proposals`, immutable) through the transaction's lens: a personal proposal is visible only to its
 * owner (RLS), so for anyone else it reads as missing, and a missing proposal (its unit, bot or forgotten scope took it
 * along, WINDOWS 137) is decided by nobody, viewed as `scope_gone` and never a 500.
 */

export const MEMORY_WRITE = "memory.write";
export const MEMORY_PROPOSAL_RESOURCE = "memory_proposal";
const TTL_MS = MEMORY_LIMITS.proposalTtlDays * 24 * 60 * 60 * 1000;

export type ProposalRow = typeof memoryProposals.$inferSelect;

export interface MemoryWriteKindDeps {
  perms: PermissionService;
  files: {
    writeFile(tx: Tx, actor: MemoryActor, op: WriteFileOp): Promise<MemoryFile | null>;
    appendToFile(
      tx: Tx,
      actor: MemoryActor,
      a: { scopeId: string; path: string; text: string },
    ): Promise<{ fileId: string; version: number }>;
  };
  /**
   * Scans handed over by the proposal call to the card hook of the same request (in process, never stored): the card's
   * excerpt masks Presidio spans too, which are not persisted.
   */
  scans: Map<string, ChangeScan>;
}

const OP_TITLE: Record<MemoryProposalOp, string> = {
  create: "Create",
  replace: "Rewrite",
  append: "Append to",
};

const FINDING_NAME: Partial<Record<SensitiveFindingKind, string>> = {
  secret: "Secret",
  iban: "IBAN",
  payment_card: "Card number",
  es_nif: "NIF",
  es_nie: "NIE",
  email: "Email",
  phone: "Phone",
  person: "Person name",
  location: "Place",
  ip_address: "IP address",
};

const EXTENDED_UNAVAILABLE = "Extended scan unavailable — review the text yourself";
const EXTENDED_PARTIAL = "Extended scan incomplete — review the text yourself";
const GONE_COPY = "This memory no longer exists.";

/** "{Create|Rewrite|Append to} {path}", at most 200 characters (a long path keeps its end). */
export function proposalTitle(op: MemoryProposalOp, path: string): string {
  const head = `${OP_TITLE[op]} `;
  const room = 200 - head.length;
  return head + (path.length <= room ? path : `…${path.slice(path.length - room + 1)}`);
}

export function readersLabel(personal: boolean, n: number): string {
  if (personal) return "Only you";
  return n === 1 ? "1 person" : `${n} people`;
}

export function foundLabel(findings: readonly SensitiveFinding[]): string {
  const names = [
    ...new Set(findings.flatMap((f) => (f.severity === "info" ? [] : [FINDING_NAME[f.kind] ?? f.kind]))),
  ];
  return names.length ? names.join(", ") : "Nothing found";
}

function scopeTag(s: LoadedScope): string {
  switch (s.row.kind) {
    case "personal":
      return "Private";
    case "agent":
      return "Bot";
    case "org":
      return "Everyone";
    case "unit":
      return s.unitKind ? s.unitKind.charAt(0).toUpperCase() + s.unitKind.slice(1) : "Unit";
  }
}

/** The stored proposal behind a request, through the transaction's lens (null when gone or hidden). */
export async function loadProposal(
  tx: Tx,
  row: Pick<ApprovalRow, "resourceId">,
): Promise<ProposalRow | null> {
  const [p] = await tx.select().from(memoryProposals).where(eq(memoryProposals.id, row.resourceId)).limit(1);
  return p ?? null;
}

async function scopeOrNull(tx: Tx, scopeId: string): Promise<LoadedScope | null> {
  try {
    return await loadScope(tx, scopeId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return null;
    throw err;
  }
}

async function proposalAndScope(tx: Tx, row: ApprovalRow) {
  const proposal = await loadProposal(tx, row);
  const scope = proposal ? await scopeOrNull(tx, proposal.scopeId) : null;
  return proposal && scope ? { proposal, scope } : null;
}

/** The base text a proposal was made against (the revision at `base_version`), or null for a new file. */
async function baseOf(tx: Tx, p: ProposalRow): Promise<string | null> {
  if (p.op === "create" || !p.fileId || p.baseVersion === null) return null;
  const [rev] = await tx
    .select({ content: memoryFileRevisions.content })
    .from(memoryFileRevisions)
    .where(and(eq(memoryFileRevisions.fileId, p.fileId), eq(memoryFileRevisions.version, p.baseVersion)))
    .limit(1);
  return rev?.content ?? null;
}

/** The live version of the proposal's file now (by id, or by path for a file that did not exist). */
async function currentVersionOf(tx: Tx, p: ProposalRow): Promise<number | null> {
  const [f] = await tx
    .select({ version: memoryFiles.version })
    .from(memoryFiles)
    .where(
      and(
        isNull(memoryFiles.deletedAt),
        p.fileId
          ? eq(memoryFiles.id, p.fileId)
          : and(eq(memoryFiles.scopeId, p.scopeId), sql`lower(${memoryFiles.path}) = lower(${p.path})`),
      ),
    )
    .limit(1);
  return f?.version ?? null;
}

async function names(tx: Tx, p: Pick<ProposalRow, "requestedByAgentId" | "requestedForUserId">) {
  const [bot] = p.requestedByAgentId
    ? await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, p.requestedByAgentId)).limit(1)
    : [];
  const [person] = p.requestedForUserId
    ? await tx
        .select({ name: orgMembers.displayName })
        .from(orgMembers)
        .where(eq(orgMembers.userId, p.requestedForUserId))
        .limit(1)
    : [];
  return { bot: bot?.name ?? "Deleted bot", person: person?.name ?? "Former member" };
}

const storedFindings = (p: ProposalRow) =>
  (p.findings as unknown as SensitiveFinding[]).slice(0, MAX_VIEW_FINDINGS);

/** Domain errors of the file operations → the request's result code (the primitive marks it `failed`). */
function resultCode(op: MemoryProposalOp, err: HttpError): string {
  switch (err.code) {
    case "memory_version_conflict":
      return "stale_base";
    case "memory_not_found":
      return op === "replace" ? "stale_base" : "scope_gone";
    case "memory_path_exists":
      return "path_exists";
    case "secret_detected":
      return "secret_detected";
    case "memory_scope_full":
      return "scope_full";
    case "memory_file_too_large":
      return "too_large";
    default:
      return "apply_failed";
  }
}

/** An inbox row's chips: one per kind of warn/block finding (names as on the card), then the taint flag. */
export function headlineTags(findings: readonly SensitiveFinding[], tainted: boolean): ApprovalTag[] {
  const tags: ApprovalTag[] = [];
  for (const f of findings) {
    if (f.severity === "info") continue;
    const label = FINDING_NAME[f.kind] ?? f.kind;
    if (!tags.some((t) => t.label === label)) tags.push({ label, tone: "warning" });
  }
  if (tainted) tags.push({ label: "Used web content", tone: "warning" });
  return tags.slice(0, 8);
}

export function createMemoryWriteKind(deps: MemoryWriteKindDeps): ApprovalKind {
  const { perms } = deps;

  async function scanOf(tx: Tx, p: ProposalRow): Promise<ChangeScan> {
    const handed = deps.scans.get(p.id);
    if (handed) return handed;
    return scanChange({ base: await baseOf(tx, p), proposed: p.content, op: p.op }, NO_SCANNER);
  }

  const kind: ApprovalKind = {
    kind: MEMORY_WRITE,
    mode: "server_apply",
    resourceType: MEMORY_PROPOSAL_RESOURCE,
    ttlMs: TTL_MS,

    async hashInput(tx, row) {
      const p = await loadProposal(tx, row);
      if (!p) throw conflict(GONE_COPY, "scope_gone");
      return [p.id, p.scopeId, p.fileId ?? null, p.path, p.op, p.baseVersion ?? null, sha256Hex(p.content)];
    },

    async canDecide(tx, deciderUserId, row) {
      const found = await proposalAndScope(tx, row);
      if (!found) return false;
      const { proposal, scope } = found;
      const actor: MemoryActor = { kind: "user", userId: deciderUserId };
      // A person's own memory: its owner decides (memory.write there is owner-only, admins included).
      if (isPersonalLike(scope.facts)) {
        return (await decideMemory(perms, tx, actor, "memory.write", scope.facts, proposal.path)).allowed;
      }
      // Shared memory: four eyes. Someone else holding memory.promote on the path.
      if (deciderUserId === row.requestedForUserId) return false;
      return (await decideMemory(perms, tx, actor, "memory.promote", scope.facts, proposal.path)).allowed;
    },

    async audience(tx, row) {
      const found = await proposalAndScope(tx, row);
      if (!found) return [];
      const { proposal, scope } = found;
      if (isPersonalLike(scope.facts)) {
        const owner = personalOwnerOf(scope.facts);
        return owner ? [owner] : [];
      }
      const promoters = await perms.usersAllowed(tx, {
        candidates: "members",
        permission: "memory.promote",
        resourceFor: (userId) => memoryResource(scope.facts, proposal.path, { kind: "user", id: userId }),
      });
      return promoters.filter((id) => id !== row.requestedForUserId);
    },

    async isPrivate(tx, row) {
      const found = await proposalAndScope(tx, row);
      return found ? isPersonalLike(found.scope.facts) : true;
    },

    async view(tx, row): Promise<ApprovalView> {
      const found = await proposalAndScope(tx, row);
      if (!found) {
        return {
          type: "fields",
          title: GONE_COPY,
          fields: [{ label: "Result", value: "scope_gone" }],
        };
      }
      const { proposal: p, scope } = found;
      const base = await baseOf(tx, p);
      const scan = await scanChange({ base, proposed: p.content, op: p.op }, NO_SCANNER);
      const who = await names(tx, p);
      const proposal: MemoryProposalView = {
        proposalId: p.id,
        scope: { id: scope.row.id, kind: scope.row.kind, label: scope.label },
        path: p.path,
        op: p.op,
        baseVersion: p.baseVersion,
        currentVersion: await currentVersionOf(tx, p),
        base,
        proposed: scan.result,
        linesAdded: scan.linesAdded,
        linesRemoved: scan.linesRemoved,
        findings: storedFindings(p),
        spans: scan.spans,
        readerCount: p.readerCount,
        tainted: p.tainted,
        reason: p.reason,
        requestedBy: {
          agent: { id: p.requestedByAgentId ?? row.id, displayName: who.bot },
          forUser: { id: p.requestedForUserId ?? row.id, displayName: who.person },
        },
      };
      return { type: "memory_proposal", proposal };
    },

    async headline(tx, row): Promise<ApprovalHeadline> {
      const found = await proposalAndScope(tx, row);
      const who = await names(tx, found?.proposal ?? row);
      const requester = `${who.bot} for ${who.person}`;
      if (!found) return { title: GONE_COPY, context: null, requester, tags: [] };
      const { proposal: p, scope } = found;
      return {
        title: proposalTitle(p.op, p.path),
        context: `${scope.label} · ${scopeTag(scope)}`.slice(0, 120),
        requester: requester.slice(0, 200),
        tags: headlineTags(storedFindings(p), p.tainted),
      };
    },

    async card(tx, row) {
      const found = await proposalAndScope(tx, row);
      if (!found) throw conflict(GONE_COPY, "scope_gone");
      const { proposal: p, scope } = found;
      const who = await names(tx, p);
      const findings = storedFindings(p);
      const personal = isPersonalLike(scope.facts);
      const fields: AgentCardField[] = [
        { label: "Memory", value: `${scope.label} · ${scopeTag(scope)}` },
        { label: "Readers", value: readersLabel(personal, p.readerCount) },
        { label: "Found", value: foundLabel(findings) },
        ...(p.reason ? [{ label: "Bot's note", value: p.reason }] : []),
      ];
      const title = proposalTitle(p.op, p.path);
      const excerpt = changeExcerpt(await scanOf(tx, p));
      const warnings: string[] = [];
      if (p.tainted) warnings.push(`${who.bot} read web or tool content in this turn.`);
      if (findings.some((f) => f.kind === "extended_scan_unavailable")) warnings.push(EXTENDED_UNAVAILABLE);
      else if (findings.some((f) => f.kind === "extended_scan_partial")) warnings.push(EXTENDED_PARTIAL);
      const card: AgentCardInput = {
        kind: "approval",
        title,
        fields,
        status: "pending",
        actions: [{ kind: "open", label: "Review changes", target: `/memory/proposals/${row.id}` }],
        summary: excerpt || title,
      };
      return { card, warnings };
    },

    async apply(tx, row): Promise<ApplyResult> {
      const p = await loadProposal(tx, row);
      if (!p) return { ok: false, code: "scope_gone" };
      const actor: MemoryActor = {
        kind: "approved",
        agentId: p.requestedByAgentId,
        onBehalfOfUserId: p.requestedForUserId,
        approvalRequestId: row.id,
      };
      try {
        switch (p.op) {
          case "create":
            await deps.files.writeFile(tx, actor, {
              op: "create",
              scopeId: p.scopeId,
              path: p.path,
              content: p.content,
            });
            break;
          case "replace":
            if (!p.fileId || p.baseVersion === null) return { ok: false, code: "stale_base" };
            await deps.files.writeFile(tx, actor, {
              op: "update",
              fileId: p.fileId,
              content: p.content,
              expectedVersion: p.baseVersion,
            });
            break;
          case "append":
            await deps.files.appendToFile(tx, actor, { scopeId: p.scopeId, path: p.path, text: p.content });
            break;
        }
        return { ok: true };
      } catch (err) {
        if (err instanceof HttpError) return { ok: false, code: resultCode(p.op, err) };
        throw err;
      }
    },
  };
  return kind;
}
