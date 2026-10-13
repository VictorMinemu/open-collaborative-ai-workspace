import type {
  EnsureMemoryScopeRequest,
  MemoryFile,
  MemoryFileMeta,
  MemoryRevision,
  MemoryRevisionMeta,
  MemoryScope,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { ApiModule, App, Core } from "../../core";
import { createPresidioScanner } from "../../lib/presidio";
import { agentFacts, findAgent, loadAgentUnit } from "../agent";
import type { ApprovalService } from "../approval";
import { agentResource, createPermissionService, loadRules, type MemoryScopeFacts } from "../organization";
import {
  type AgentReadVerdict,
  asActor,
  capabilitiesOf,
  decideAgentRead,
  decideMemory,
  type MemoryActor,
  type MemoryAudience,
  withPersonalOwner,
} from "./access";
import { createMemoryWriteKind } from "./approval-kind";
import type { ChangeScan } from "./detect";
import { createFileOps, type WriteFileOp } from "./files";
import {
  type CreateMemoryProposalInput,
  type CreateMemoryProposalResult,
  createMemoryProposal,
  type ProposalPrescan,
  prescanProposal,
} from "./proposals";
import { registerMemoryRoutes } from "./routes";
import {
  describeScopes,
  ensureScope,
  ensureToolScope,
  type LoadedScope,
  listScopes,
  loadScope,
  memoryNotFound,
  resolveToolScope,
  type ScopeKey,
  type ScopeRow,
  type ToolScope,
  toScopeDto,
} from "./scopes";

/**
 * The `memory` module (MEM-01, MEM-02, MEM-07, D-01, D-04, D-08, ADR-0023): platform-owned Markdown files per scope.
 * Public interface for 07.2-09 (proposals), 07.2-11 (Agent Channel), 07.2-16 (search) and later phases.
 */
export {
  type AgentReadVerdict,
  audienceVerdict,
  isPersonalLike,
  type MemoryActor,
  type MemoryAudience,
  withPersonalOwner,
} from "./access";
export {
  createMemoryWriteKind,
  MEMORY_PROPOSAL_RESOURCE,
  MEMORY_WRITE,
  type MemoryWriteKindDeps,
} from "./approval-kind";
export { type ChangeScan, type ChangeScanner, NO_SCANNER, scanChange } from "./detect";
export { assertNoSecret, isRootPath, lineChanges, parsePathOrThrow, type WriteFileOp } from "./files";
export {
  type CreateMemoryProposalInput,
  type CreateMemoryProposalResult,
  createMemoryProposal,
  type ProposalDeps,
  type ProposalPrescan,
} from "./proposals";
export type { LoadedScope, ScopeKey, ScopeRow, ToolScope } from "./scopes";

export interface MemoryService {
  ensureScope(tx: Tx, key: ScopeKey): Promise<ScopeRow>;
  listScopes(tx: Tx, viewerUserId: string): Promise<MemoryScope[]>;
  /** Opens (creating on first use) the viewer's private scope with a bot they may read, or a bot's notebook. */
  openScope(tx: Tx, viewerUserId: string, req: EnsureMemoryScopeRequest): Promise<MemoryScope>;
  /** One scope as the actor sees it (404 when unreadable). */
  scopeView(tx: Tx, actor: MemoryActor, scopeId: string): Promise<MemoryScope>;
  listReadableFiles(tx: Tx, actor: MemoryActor, scopeId: string, folder?: string): Promise<MemoryFileMeta[]>;
  /**
   * The ids of the live files a person may read (one scope, or every scope they may read): ids only, one permission
   * pass, nothing written. What search narrows to (07.2-16; WINDOWS 139, 141).
   */
  readableFileIds(tx: Tx, viewerUserId: string, scopeId?: string): Promise<string[]>;
  readFile(
    tx: Tx,
    actor: MemoryActor,
    ref: { fileId: string } | { scopeId: string; path: string },
  ): Promise<MemoryFile>;
  writeFile(tx: Tx, actor: MemoryActor, op: WriteFileOp): Promise<MemoryFile | null>;
  appendToFile(
    tx: Tx,
    actor: MemoryActor,
    a: { scopeId: string; path: string; text: string },
  ): Promise<{ fileId: string; version: number }>;
  forgetScope(tx: Tx, actor: MemoryActor, scopeId: string): Promise<{ files: number; revisions: number }>;
  listRevisions(tx: Tx, actor: MemoryActor, fileId: string): Promise<MemoryRevisionMeta[]>;
  readRevision(tx: Tx, actor: MemoryActor, fileId: string, version: number): Promise<MemoryRevision>;
  /**
   * The audience rule for an agent read (agent ∩ the human it acts for ∩ every reader of the turn). The scope is an id,
   * or a `ToolScope` from `resolveToolScope` (07.2-11: decided before an alias's scope is created).
   */
  decideAgentRead(
    tx: Tx,
    a: {
      agentId: string;
      onBehalfOfUserId: string;
      audience: MemoryAudience;
      path?: string;
    } & ({ scopeId: string } | { scope: ToolScope }),
  ): Promise<AgentReadVerdict>;
  /**
   * A memory tool's scope (`personal`, `agent` or an id) for an agent acting for a human, through that human's lens,
   * WITHOUT creating anything (07.2-11). Null = no such scope for them.
   */
  resolveToolScope(
    tx: Tx,
    a: { agentId: string; onBehalfOfUserId: string; scope: string },
  ): Promise<ToolScope | null>;
  /** The id of a resolved tool scope, creating it once a decision allowed it (through the human's lens). */
  ensureToolScope(tx: Tx, onBehalfOfUserId: string, s: ToolScope): Promise<string>;
  /** Through the transaction's lens (another person's private scope is 404). */
  scopeFacts(tx: Tx, scopeId: string): Promise<{ row: ScopeRow; facts: MemoryScopeFacts; label: string }>;
  /**
   * The detector run of a proposal (layer 1 and Presidio), BEFORE and outside its transaction (WINDOWS 145): call it
   * with no transaction open, then `propose` with its result. Read-only.
   */
  prescan(organizationId: string, input: CreateMemoryProposalInput): Promise<ProposalPrescan>;
  /**
   * An agent's proposal for the human of a delivered turn (07.2-09): an immutable proposal, a pending `memory.write`
   * approval and its platform-owned card in the turn's conversation, or a refusal reason (07.2-11 serves it to agents).
   * Uses the `prescan` of the same input; refuses `version_conflict` when what it scanned changed since.
   */
  propose(
    tx: Tx,
    input: CreateMemoryProposalInput,
    prescan: ProposalPrescan,
  ): Promise<CreateMemoryProposalResult>;
}

export function createMemoryService(core: Core, deps: { approvals: ApprovalService }): MemoryService {
  const perms = createPermissionService(core);
  const files = createFileOps({ core, perms, approvals: deps.approvals });
  // Detector layer 2 (07.2-05): off without OCW_PRESIDIO_URL; fail-open with a visible marker.
  const scanner = createPresidioScanner(
    {
      url: core.env.OCW_PRESIDIO_URL,
      languages: core.env.OCW_PRESIDIO_LANGUAGES,
      timeoutMs: core.env.OCW_PRESIDIO_TIMEOUT_MS,
    },
    core.log,
  );
  const scans = new Map<string, ChangeScan>();
  // MEM-06: agents' proposals are decided through the approve-and-apply primitive (ADR-0023).
  deps.approvals.register(createMemoryWriteKind({ perms, files, scans }));

  const viewOf = async (tx: Tx, actor: MemoryActor, s: LoadedScope) =>
    toScopeDto(s, await capabilitiesOf(perms, tx, actor, s.facts, undefined));

  return {
    ensureScope,
    listScopes: (tx, viewerUserId) => listScopes(perms, tx, viewerUserId),

    async openScope(tx, viewerUserId, req) {
      const actor: MemoryActor = { kind: "user", userId: viewerUserId };
      const bot = await findAgent(tx, req.agentId);
      if (!bot) throw memoryNotFound("Bot not found");
      const unit = await loadAgentUnit(tx, bot.unitId);
      const facts = agentFacts(bot, unit?.path ?? []);
      // A bot the viewer may not see is 404, an admin on someone's personal bot included (ADR-0010).
      const seen = await perms.decide(
        tx,
        { kind: "user", userId: viewerUserId },
        "bot.read",
        agentResource(facts, viewerUserId),
      );
      if (!seen.allowed) throw memoryNotFound("Bot not found");
      let row: ScopeRow;
      if (req.kind === "personal") {
        row = await ensureScope(tx, { kind: "personal", agentId: bot.id, ownerUserId: viewerUserId });
      } else {
        const notebook: MemoryScopeFacts = {
          kind: "agent",
          ownerUserId: null,
          agent: { ...facts, id: bot.id },
          unitPath: facts.unitPath ?? [],
        };
        if (!(await decideMemory(perms, tx, actor, "memory.read", notebook, undefined)).allowed) {
          throw memoryNotFound("Bot not found");
        }
        row = await ensureScope(tx, { kind: "agent", agentId: bot.id });
      }
      const [loaded] = await describeScopes(tx, [row]);
      if (!loaded) throw memoryNotFound();
      return viewOf(tx, actor, loaded);
    },

    async scopeView(tx, actor, scopeId) {
      return asActor(tx, actor, async () => {
        const scope = await loadScope(tx, scopeId);
        if (!(await decideMemory(perms, tx, actor, "memory.read", scope.facts, undefined)).allowed) {
          throw memoryNotFound();
        }
        return viewOf(tx, actor, scope);
      });
    },

    listReadableFiles: files.listReadableFiles,
    readableFileIds: files.readableFileIds,
    readFile: files.readFile,
    writeFile: files.writeFile,
    appendToFile: files.appendToFile,
    forgetScope: files.forgetScope,
    listRevisions: files.listRevisions,
    readRevision: files.readRevision,

    async decideAgentRead(tx, a) {
      if (!a.onBehalfOfUserId) throw new Error("an agent read needs the human it acts for");
      return withPersonalOwner(tx, a.onBehalfOfUserId, async () => {
        if ("scope" in a) return decideAgentRead(perms, tx, loadRules, a.scope.facts, a);
        let scope: LoadedScope;
        try {
          scope = await loadScope(tx, a.scopeId);
        } catch {
          return { allowed: false, reason: "denied" } as const;
        }
        return decideAgentRead(perms, tx, loadRules, scope.facts, a);
      });
    },

    async resolveToolScope(tx, a) {
      if (!a.onBehalfOfUserId) throw new Error("an agent scope needs the human it acts for");
      return withPersonalOwner(tx, a.onBehalfOfUserId, () => resolveToolScope(tx, a));
    },

    ensureToolScope: (tx, onBehalfOfUserId, s) =>
      withPersonalOwner(tx, onBehalfOfUserId, () => ensureToolScope(tx, s)),

    async scopeFacts(tx, scopeId) {
      const s = await loadScope(tx, scopeId);
      return { row: s.row, facts: s.facts, label: s.label };
    },

    prescan: (organizationId, input) => prescanProposal(core.db, { perms, scanner }, organizationId, input),
    propose: (tx, input, prescan) =>
      createMemoryProposal(tx, { core, perms, approvals: deps.approvals, scans }, input, prescan),
  };
}

export function createMemoryModule(core: Core, memory: MemoryService): ApiModule {
  return {
    name: "memory",
    register(app: App) {
      registerMemoryRoutes(app, { core, memory });
    },
  };
}
