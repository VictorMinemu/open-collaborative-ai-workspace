import {
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  MEMORY_ROOT_TEMPLATE,
  type MemoryCapability,
  type MemoryScope,
  type UnitKind,
} from "@ocw/contracts";
import { agents, memoryFileRevisions, memoryFiles, memoryScopes, orgUnits, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { notFound } from "../../lib/errors";
import { agentFacts } from "../agent";
import { type MemoryScopeFacts, memoryResource, type PermissionService } from "../organization";
import { isPersonalLike, withPersonalOwner } from "./access";

/**
 * Memory scopes (D-01, MEM-01): one per anchor, created lazily with their `MEMORY.md`. A scope's identity never changes
 * (post-migrate trigger), and its owner column is derived by the database, never written here.
 */

export type ScopeRow = typeof memoryScopes.$inferSelect;

export type ScopeKey =
  | { kind: "personal"; agentId: string; ownerUserId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "unit"; unitId: string }
  | { kind: "org" };

/** A scope with what the resolver and the DTO need. */
export interface LoadedScope {
  row: ScopeRow;
  facts: MemoryScopeFacts;
  label: string;
  unitKind: UnitKind | null;
  /** Sort keys for the tree order (UI-SPEC "Scopes in the tree"). */
  botName: string | null;
  /** A private scope or notebook whose bot was deleted (soft): kept, but no longer listed (WINDOWS 163). */
  deletedBot: boolean;
  chartKey: readonly string[];
}

export const memoryNotFound = (what = "Memory not found") => notFound(what, "memory_not_found");

const ROOT_BYTES = Buffer.byteLength(MEMORY_ROOT_TEMPLATE, "utf8");
const ROOT_LINES = MEMORY_ROOT_TEMPLATE.split("\n").length - (MEMORY_ROOT_TEMPLATE.endsWith("\n") ? 1 : 0);

/** `MEMORY.md` version 1 and its `system` revision, written by the transaction that created the scope. */
export async function createRootFile(tx: Tx, scope: ScopeRow): Promise<string> {
  const [file] = await tx
    .insert(memoryFiles)
    .values({
      organizationId: scope.organizationId,
      scopeId: scope.id,
      path: MEMORY_ROOT_FILE,
      content: MEMORY_ROOT_TEMPLATE,
      version: 1,
      bytes: ROOT_BYTES,
      updatedByKind: "system",
      updatedById: null,
    })
    .returning({ id: memoryFiles.id });
  if (!file) throw new Error("memory root file insert failed");
  await tx.insert(memoryFileRevisions).values({
    organizationId: scope.organizationId,
    fileId: file.id,
    scopeId: scope.id,
    version: 1,
    op: "create",
    path: MEMORY_ROOT_FILE,
    content: MEMORY_ROOT_TEMPLATE,
    linesAdded: ROOT_LINES,
    linesRemoved: 0,
    authorKind: "system",
  });
  return file.id;
}

async function insertOrGet(
  tx: Tx,
  values: Pick<typeof memoryScopes.$inferInsert, "kind" | "agentId" | "ownerUserId" | "unitId">,
  conflict: { target: PgColumn | PgColumn[]; where: SQL },
  find: SQL,
): Promise<ScopeRow> {
  const [inserted] = await tx
    .insert(memoryScopes)
    .values({ organizationId: tenantOf(tx).organizationId, ...values })
    .onConflictDoNothing(conflict)
    .returning();
  if (inserted) {
    await createRootFile(tx, inserted);
    return inserted;
  }
  const [existing] = await tx.select().from(memoryScopes).where(find).limit(1);
  if (!existing) throw new Error("memory scope insert-or-get found no row");
  return existing;
}

/**
 * The scope of `key`, created (with its `MEMORY.md`) when missing; idempotent under concurrency (the partial unique
 * indexes decide, the loser reads the winner's row). No authorization here: callers decide first. Personal-like
 * scopes are written through their owner's lens, the only session the RESTRICTIVE policy lets insert them.
 */
export async function ensureScope(tx: Tx, key: ScopeKey): Promise<ScopeRow> {
  switch (key.kind) {
    case "personal":
      return withPersonalOwner(tx, key.ownerUserId, () =>
        insertOrGet(
          tx,
          { kind: "personal", agentId: key.agentId, ownerUserId: key.ownerUserId },
          {
            target: [memoryScopes.organizationId, memoryScopes.agentId, memoryScopes.ownerUserId],
            where: sql`kind = 'personal'`,
          },
          and(
            eq(memoryScopes.kind, "personal"),
            eq(memoryScopes.agentId, key.agentId),
            eq(memoryScopes.ownerUserId, key.ownerUserId),
          ) as SQL,
        ),
      );
    case "agent": {
      const [bot] = await tx
        .select({ scope: agents.scope, ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(eq(agents.id, key.agentId))
        .limit(1);
      if (!bot) throw memoryNotFound("Bot not found");
      const run = () =>
        insertOrGet(
          tx,
          { kind: "agent", agentId: key.agentId },
          { target: [memoryScopes.organizationId, memoryScopes.agentId], where: sql`kind = 'agent'` },
          and(eq(memoryScopes.kind, "agent"), eq(memoryScopes.agentId, key.agentId)) as SQL,
        );
      return bot.scope === "personal" && bot.ownerUserId
        ? withPersonalOwner(tx, bot.ownerUserId, run)
        : run();
    }
    case "unit":
      return insertOrGet(
        tx,
        { kind: "unit", unitId: key.unitId },
        { target: [memoryScopes.organizationId, memoryScopes.unitId], where: sql`kind = 'unit'` },
        and(eq(memoryScopes.kind, "unit"), eq(memoryScopes.unitId, key.unitId)) as SQL,
      );
    case "org":
      return insertOrGet(
        tx,
        { kind: "org" },
        { target: [memoryScopes.organizationId], where: sql`kind = 'org'` },
        eq(memoryScopes.kind, "org"),
      );
  }
}

// ---------------------------------------------------------------- facts and labels

type UnitInfo = { id: string; name: string; kind: UnitKind; path: string[] };

async function loadUnits(tx: Tx, ids?: readonly string[]): Promise<Map<string, UnitInfo>> {
  const q = tx
    .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind, path: orgUnits.path })
    .from(orgUnits);
  const rows = ids ? (ids.length ? await q.where(inArray(orgUnits.id, [...ids])) : []) : await q;
  return new Map(rows.map((u) => [u.id, u]));
}

/** Facts and labels of many scopes in three queries (bots, units, then the units on their paths for chart order). */
export async function describeScopes(tx: Tx, rows: readonly ScopeRow[]): Promise<LoadedScope[]> {
  const agentIds = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  // Soft-deleted bots included: their scopes stay their owners' memory until the bot row itself goes.
  const bots = agentIds.length
    ? await tx
        .select({
          id: agents.id,
          name: agents.name,
          scope: agents.scope,
          ownerUserId: agents.ownerUserId,
          status: agents.status,
          unitId: agents.unitId,
          deletedAt: agents.deletedAt,
        })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const botById = new Map(bots.map((b) => [b.id, b]));
  const unitIds = new Set<string>();
  for (const r of rows) if (r.unitId) unitIds.add(r.unitId);
  for (const b of bots) if (b.unitId) unitIds.add(b.unitId);
  const units = await loadUnits(tx, [...unitIds]);
  const ancestorIds = new Set<string>();
  for (const u of units.values()) for (const id of u.path) if (!units.has(id)) ancestorIds.add(id);
  const ancestors = await loadUnits(tx, [...ancestorIds]);
  const nameOf = (id: string) => units.get(id)?.name ?? ancestors.get(id)?.name ?? "";

  return rows.map((row): LoadedScope => {
    const bot = row.agentId ? botById.get(row.agentId) : undefined;
    const agent = bot
      ? { ...agentFacts(bot, bot.unitId ? (units.get(bot.unitId)?.path ?? []) : []), id: bot.id }
      : null;
    const deletedBot = row.agentId !== null && (!bot || bot.deletedAt !== null);
    if (row.kind === "personal") {
      return {
        row,
        facts: { kind: "personal", ownerUserId: row.ownerUserId, agent, unitPath: [] },
        label: `You & ${bot?.name ?? "a deleted bot"}`,
        unitKind: null,
        botName: bot?.name ?? "",
        deletedBot,
        chartKey: [],
      };
    }
    if (row.kind === "agent") {
      return {
        row,
        facts: { kind: "agent", ownerUserId: null, agent, unitPath: agent?.unitPath ?? [] },
        label: `${bot?.name ?? "Deleted bot"} notebook`,
        unitKind: null,
        botName: bot?.name ?? "",
        deletedBot,
        chartKey: [],
      };
    }
    if (row.kind === "unit") {
      const unit = row.unitId ? units.get(row.unitId) : undefined;
      return {
        row,
        facts: { kind: "unit", ownerUserId: null, agent: null, unitPath: unit?.path ?? [] },
        label: unit?.name ?? "Unit",
        unitKind: unit?.kind ?? null,
        botName: null,
        deletedBot: false,
        chartKey: (unit?.path ?? []).map(nameOf),
      };
    }
    return {
      row,
      facts: { kind: "org", ownerUserId: null, agent: null, unitPath: [] },
      label: "Organization",
      unitKind: null,
      botName: null,
      deletedBot: false,
      chartKey: [],
    };
  });
}

// ---------------------------------------------------------------- an agent's scope references (07.2-11)

/**
 * A memory tool's scope for an agent acting for a human, resolved WITHOUT creating anything: the existing row when there
 * is one (`id`), the key that would create it for the aliases (`key`), and the facts the resolver decides on. A refused
 * decision therefore never leaves an empty scope behind (07.2-09 broken-window candidate 4).
 */
export interface ToolScope {
  id: string | null;
  key: ScopeKey | null;
  kind: ScopeRow["kind"];
  /** A person's private scope or a personal bot's notebook (owner-only memory). */
  personalLike: boolean;
  facts: MemoryScopeFacts;
}

/** The existing scope of a personal or agent key, or null (through the transaction's lens). */
async function findKeyScope(
  tx: Tx,
  key: ScopeKey & { kind: "personal" | "agent" },
): Promise<ScopeRow | null> {
  const where =
    key.kind === "personal"
      ? and(
          eq(memoryScopes.kind, "personal"),
          eq(memoryScopes.agentId, key.agentId),
          eq(memoryScopes.ownerUserId, key.ownerUserId),
        )
      : and(eq(memoryScopes.kind, "agent"), eq(memoryScopes.agentId, key.agentId));
  const [row] = await tx.select().from(memoryScopes).where(where).limit(1);
  return row ?? null;
}

/**
 * Resolves `personal` (the turn's human with this bot), `agent` (this bot's notebook) or a scope id. The caller runs it
 * through the human's lens (`withPersonalOwner`), so another person's personal scope is missing. Null = no such scope.
 */
export async function resolveToolScope(
  tx: Tx,
  a: { agentId: string; onBehalfOfUserId: string; scope: string },
): Promise<ToolScope | null> {
  if (a.scope !== "personal" && a.scope !== "agent") {
    try {
      const s = await loadScope(tx, a.scope);
      return {
        id: s.row.id,
        key: null,
        kind: s.row.kind,
        personalLike: isPersonalLike(s.facts),
        facts: s.facts,
      };
    } catch {
      return null;
    }
  }
  const key: ScopeKey & { kind: "personal" | "agent" } =
    a.scope === "personal"
      ? { kind: "personal", agentId: a.agentId, ownerUserId: a.onBehalfOfUserId }
      : { kind: "agent", agentId: a.agentId };
  const existing = await findKeyScope(tx, key);
  if (existing) {
    const [loaded] = await describeScopes(tx, [existing]);
    if (!loaded) return null;
    return {
      id: existing.id,
      key,
      kind: existing.kind,
      personalLike: isPersonalLike(loaded.facts),
      facts: loaded.facts,
    };
  }
  // Not created yet: the facts `describeScopes` would build for it, from the live bot.
  const [bot] = await tx
    .select({
      id: agents.id,
      scope: agents.scope,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      unitId: agents.unitId,
    })
    .from(agents)
    .where(and(eq(agents.id, a.agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!bot) return null;
  const unitPath = bot.unitId ? ((await loadUnits(tx, [bot.unitId])).get(bot.unitId)?.path ?? []) : [];
  const agent = { ...agentFacts(bot, unitPath), id: bot.id };
  const facts: MemoryScopeFacts =
    key.kind === "personal"
      ? { kind: "personal", ownerUserId: key.ownerUserId, agent, unitPath: [] }
      : { kind: "agent", ownerUserId: null, agent, unitPath };
  return { id: null, key, kind: key.kind, personalLike: isPersonalLike(facts), facts };
}

/** The id of a resolved tool scope, creating it (with its `MEMORY.md`) when it does not exist yet. */
export async function ensureToolScope(tx: Tx, s: ToolScope): Promise<string> {
  if (s.id) return s.id;
  if (!s.key) throw memoryNotFound();
  return (await ensureScope(tx, s.key)).id;
}

/** One scope through the transaction's lens (RLS hides another person's personal scope), or 404. */
export async function loadScope(tx: Tx, scopeId: string): Promise<LoadedScope> {
  const [row] = await tx.select().from(memoryScopes).where(eq(memoryScopes.id, scopeId)).limit(1);
  if (!row) throw memoryNotFound();
  const [loaded] = await describeScopes(tx, [row]);
  if (!loaded) throw memoryNotFound();
  return loaded;
}

// ---------------------------------------------------------------- listing (UI-SPEC "Scopes in the tree")

const KIND_ORDER = { personal: 0, agent: 1, unit: 2, org: 3 } as const;
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function compareScopes(a: LoadedScope, b: LoadedScope): number {
  const k = KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind];
  if (k !== 0) return k;
  if (a.botName !== null && b.botName !== null) {
    const n = collator.compare(a.botName, b.botName);
    if (n !== 0) return n;
  }
  const len = Math.min(a.chartKey.length, b.chartKey.length);
  for (let i = 0; i < len; i++) {
    const c = collator.compare(a.chartKey[i] ?? "", b.chartKey[i] ?? "");
    if (c !== 0) return c;
  }
  return a.chartKey.length - b.chartKey.length || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
}

export function toScopeDto(s: LoadedScope, viewerCan: MemoryCapability[]): MemoryScope {
  return {
    id: s.row.id,
    kind: s.row.kind,
    label: s.label,
    agentId: s.row.agentId,
    unitId: s.row.unitId,
    unitKind: s.unitKind,
    viewerCan,
  };
}

/**
 * Lazy creation for the scope tree (D-01): the organization scope and the scope of every unit the person may read,
 * one insert per missing scope. Only `GET /memory/scopes` (the tree) and the agent's scope list call it; search and
 * every other read path list what exists without writing (WINDOWS 139, 141).
 */
export async function ensureListedScopes(
  perms: PermissionService,
  tx: Tx,
  viewerUserId: string,
): Promise<void> {
  const principal = { kind: "user" as const, userId: viewerUserId };
  const viewer = { kind: "user" as const, id: viewerUserId };
  const [org] = await tx
    .select({ id: memoryScopes.id })
    .from(memoryScopes)
    .where(eq(memoryScopes.kind, "org"))
    .limit(1);
  if (!org) await ensureScope(tx, { kind: "org" });
  const allUnits = [...(await loadUnits(tx)).values()];
  const readableUnits = await perms.filterFor(tx, principal, allUnits, "memory.read", (u) =>
    memoryResource({ kind: "unit", ownerUserId: null, agent: null, unitPath: u.path }, undefined, viewer),
  );
  if (readableUnits.length === 0) return;
  const have = new Set(
    (
      await tx
        .select({ unitId: memoryScopes.unitId })
        .from(memoryScopes)
        .where(
          and(
            eq(memoryScopes.kind, "unit"),
            inArray(
              memoryScopes.unitId,
              readableUnits.map((u) => u.id),
            ),
          ),
        )
    ).map((r) => r.unitId),
  );
  for (const u of readableUnits) if (!have.has(u.id)) await ensureScope(tx, { kind: "unit", unitId: u.id });
}

/**
 * The existing scopes a person may read, in tree order, without writing anything (one permission pass): never another
 * person's private scope (RLS hides it and the resolver would refuse it, admins included, ADR-0010), and never the
 * private scope or notebook of a deleted bot (WINDOWS 163: kept as data, gone from every list).
 */
export async function readableScopes(
  perms: PermissionService,
  tx: Tx,
  viewerUserId: string,
): Promise<LoadedScope[]> {
  const principal = { kind: "user" as const, userId: viewerUserId };
  const viewer = { kind: "user" as const, id: viewerUserId };
  const rows = await tx.select().from(memoryScopes);
  const described = (await describeScopes(tx, rows)).filter((s) => !s.deletedBot);
  const readable = await perms.filterFor(tx, principal, described, "memory.read", (s) =>
    memoryResource(s.facts, undefined, viewer),
  );
  return readable.sort(compareScopes);
}

/**
 * The scopes a person may read, in tree order, as DTOs with what they may do there. Ensures the tree's scopes first
 * (`ensureListedScopes`): this is the scope tree's list, the one read that writes.
 */
export async function listScopes(
  perms: PermissionService,
  tx: Tx,
  viewerUserId: string,
): Promise<MemoryScope[]> {
  await ensureListedScopes(perms, tx, viewerUserId);
  const principal = { kind: "user" as const, userId: viewerUserId };
  const viewer = { kind: "user" as const, id: viewerUserId };
  const readable = await readableScopes(perms, tx, viewerUserId);
  const resourceOf = (s: LoadedScope) => memoryResource(s.facts, undefined, viewer);
  const writable = new Set(
    (await perms.filterFor(tx, principal, readable, "memory.write", resourceOf)).map((s) => s.row.id),
  );
  const promotable = new Set(
    (await perms.filterFor(tx, principal, readable, "memory.promote", resourceOf)).map((s) => s.row.id),
  );
  return readable.map((s) =>
    toScopeDto(s, [
      "read",
      ...(writable.has(s.row.id) ? (["write"] as const) : []),
      ...(promotable.has(s.row.id) ? (["promote"] as const) : []),
    ]),
  );
}

/** Live files of a scope (the 2,000-file limit). */
export async function liveFileCount(tx: Tx, scopeId: string): Promise<number> {
  const res = await tx.execute(
    sql`select count(*)::int as n from app.memory_files where scope_id = ${scopeId} and deleted_at is null`,
  );
  return Number((res.rows[0] as { n: number }).n);
}

export const SCOPE_FILE_LIMIT = MEMORY_LIMITS.filesPerScope;
