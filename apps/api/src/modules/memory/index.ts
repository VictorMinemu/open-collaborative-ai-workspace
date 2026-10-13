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
import { createFileOps, type WriteFileOp } from "./files";
import { registerMemoryRoutes } from "./routes";
import {
  describeScopes,
  ensureScope,
  type LoadedScope,
  listScopes,
  loadScope,
  memoryNotFound,
  type ScopeKey,
  type ScopeRow,
  toScopeDto,
} from "./scopes";

/**
 * The `memory` module (MEM-01, MEM-02, MEM-07, D-01, D-04, D-08, ADR-0023): platform-owned Markdown files per scope.
 * Public interface for 07.2-09 (proposals), 07.2-11 (Agent Channel), 07.2-16 (search) and later phases.
 */
export {
  type AgentReadVerdict,
  audienceVerdict,
  type MemoryActor,
  type MemoryAudience,
  withPersonalOwner,
} from "./access";
export { assertNoSecret, isRootPath, lineChanges, parsePathOrThrow, type WriteFileOp } from "./files";
export type { LoadedScope, ScopeKey, ScopeRow } from "./scopes";

export interface MemoryService {
  ensureScope(tx: Tx, key: ScopeKey): Promise<ScopeRow>;
  listScopes(tx: Tx, viewerUserId: string): Promise<MemoryScope[]>;
  /** Opens (creating on first use) the viewer's private scope with a bot they may read, or a bot's notebook. */
  openScope(tx: Tx, viewerUserId: string, req: EnsureMemoryScopeRequest): Promise<MemoryScope>;
  /** One scope as the actor sees it (404 when unreadable). */
  scopeView(tx: Tx, actor: MemoryActor, scopeId: string): Promise<MemoryScope>;
  listReadableFiles(tx: Tx, actor: MemoryActor, scopeId: string, folder?: string): Promise<MemoryFileMeta[]>;
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
  decideAgentRead(
    tx: Tx,
    a: {
      agentId: string;
      onBehalfOfUserId: string;
      audience: MemoryAudience;
      scopeId: string;
      path?: string;
    },
  ): Promise<AgentReadVerdict>;
  /** Through the transaction's lens (another person's private scope is 404). */
  scopeFacts(tx: Tx, scopeId: string): Promise<{ row: ScopeRow; facts: MemoryScopeFacts; label: string }>;
}

export function createMemoryService(core: Core, deps: { approvals: ApprovalService }): MemoryService {
  // 07.2-09 registers the `memory.write` approval kind on `deps.approvals`; this plan only keeps the seam.
  void deps.approvals;
  const perms = createPermissionService(core);
  const files = createFileOps({ core, perms });

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
    readFile: files.readFile,
    writeFile: files.writeFile,
    appendToFile: files.appendToFile,
    forgetScope: files.forgetScope,
    listRevisions: files.listRevisions,
    readRevision: files.readRevision,

    async decideAgentRead(tx, a) {
      if (!a.onBehalfOfUserId) throw new Error("an agent read needs the human it acts for");
      return withPersonalOwner(tx, a.onBehalfOfUserId, async () => {
        let scope: LoadedScope;
        try {
          scope = await loadScope(tx, a.scopeId);
        } catch {
          return { allowed: false, reason: "denied" } as const;
        }
        return decideAgentRead(perms, tx, loadRules, scope.facts, a);
      });
    },

    async scopeFacts(tx, scopeId) {
      const s = await loadScope(tx, scopeId);
      return { row: s.row, facts: s.facts, label: s.label };
    },
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
