import {
  type ApprovableGroup,
  type ConnectorAuthMode,
  Id,
  isApprovableTool,
  isPerMemberMode,
  strictestMode,
  TOOL_APPROVAL_LIMITS,
  type ToolApprovalHistory,
  ToolApprovalMode,
  type ToolApprovalPolicy,
  ToolApproverKind,
  ToolPattern,
} from "@ocw/contracts";
import {
  agents,
  auditEvents,
  mcpServers,
  orgMembers,
  orgUnits,
  type Tx,
  tenantOf,
  toolApprovalPolicies,
} from "@ocw/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import type { AuditService } from "../audit";
import { loadPrincipalFacts } from "../organization";
import { type ApprovalFacts, type PolicyRow, type ResolvedApproval, resolveToolApproval } from "./resolve";

/**
 * Storage access of the approval policies (Phase 07.5, D-01, P-04): every function runs in the caller's tenant
 * transaction, so RLS scopes every read and write to the caller's organization. No authorization here: routes.ts
 * decides `tool_approval.manage` through the resolver before calling in.
 */

/** A stored rule with what the settings page shows about it. */
export interface StoredPolicy extends PolicyRow {
  version: number;
  updatedAt: Date;
  updatedById: string | null;
}

/**
 * The shape of `bot-capabilities` `loadCatalog` this module reads (structural, so `tool-approval` never imports that
 * module, P-10). MCP sources carry the server's auth mode: a per-member mode is a connector.
 */
export interface CatalogSourceLike {
  sourceKind: "mcp" | "plugin";
  sourceId: string;
  sourceName: string;
  authMode?: ConnectorAuthMode;
  tools: ReadonlyArray<{ name: string; sideEffecting: boolean }>;
}

export type LoadCatalog = (tx: Tx) => Promise<readonly CatalogSourceLike[]>;

export const ORGANIZATION_LABEL = "Organization";
const PLUGINS_LABEL = "Plugins";
const HTTP_LABEL = "Web requests";
const HTTP_TOOL = "ocw_http_request";
const GROUP_TOOLS_MAX = 200;
const GROUPS_MAX = 100;
/** The contract's tool-name charset (`isApprovableTool`); a pattern outside it is not a tool name at all. */
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

// ---------------------------------------------------------------- rows

/** Rows the contract can express (a row it cannot, e.g. written by hand, never applies and is never shown). */
function expressible(r: { toolPattern: string; mode: string; approverKind: string }): boolean {
  return (
    ToolPattern.safeParse(r.toolPattern).success &&
    ToolApprovalMode.safeParse(r.mode).success &&
    ToolApproverKind.safeParse(r.approverKind).success
  );
}

async function loadStored(tx: Tx, ids?: readonly string[]): Promise<StoredPolicy[]> {
  const rows = await tx
    .select({
      id: toolApprovalPolicies.id,
      scopeUnitId: toolApprovalPolicies.scopeUnitId,
      scopePath: orgUnits.path,
      toolPattern: toolApprovalPolicies.toolPattern,
      mode: toolApprovalPolicies.mode,
      approverKind: toolApprovalPolicies.approverKind,
      approverUserIds: toolApprovalPolicies.approverUserIds,
      version: toolApprovalPolicies.version,
      updatedAt: toolApprovalPolicies.updatedAt,
      updatedById: toolApprovalPolicies.updatedBy,
    })
    .from(toolApprovalPolicies)
    .leftJoin(orgUnits, eq(orgUnits.id, toolApprovalPolicies.scopeUnitId))
    .where(ids ? inArray(toolApprovalPolicies.id, [...ids]) : undefined)
    .orderBy(asc(toolApprovalPolicies.toolPattern), asc(toolApprovalPolicies.id));
  return rows.filter(expressible).map((r) => ({
    ...r,
    scopePath: r.scopePath ?? [],
    updatedAt: new Date(r.updatedAt),
  }));
}

/** Every rule of the organization with its scope path (one query). */
export async function loadToolApprovalPolicies(tx: Tx): Promise<StoredPolicy[]> {
  return loadStored(tx);
}

/** One rule by id, or null (another organization's id is simply not found). */
export async function findPolicy(tx: Tx, id: string): Promise<StoredPolicy | null> {
  return (await loadStored(tx, [id]))[0] ?? null;
}

/** A unit of the caller's organization (RLS), or null. */
export async function findUnit(
  tx: Tx,
  id: string,
): Promise<{ id: string; name: string; path: string[] } | null> {
  const [u] = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, path: orgUnits.path })
    .from(orgUnits)
    .where(eq(orgUnits.id, id))
    .limit(1);
  return u ?? null;
}

/** Every unit of the organization (for the access probe). */
export async function allUnits(tx: Tx): Promise<Array<{ id: string; path: string[] }>> {
  return tx.select({ id: orgUnits.id, path: orgUnits.path }).from(orgUnits).orderBy(asc(orgUnits.id));
}

// ---------------------------------------------------------------- labels

interface LabelFacts {
  units: Map<string, string>;
  people: Map<string, string>;
}

async function labelFacts(
  tx: Tx,
  unitIds: Iterable<string | null>,
  userIds: Iterable<string | null>,
): Promise<LabelFacts> {
  const u = [...new Set([...unitIds].filter((x): x is string => x !== null))];
  const p = [...new Set([...userIds].filter((x): x is string => x !== null))];
  const units = u.length
    ? await tx.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits).where(inArray(orgUnits.id, u))
    : [];
  const people = p.length
    ? await tx
        .select({ id: orgMembers.userId, name: orgMembers.displayName })
        .from(orgMembers)
        .where(inArray(orgMembers.userId, p))
    : [];
  return {
    units: new Map(units.map((x) => [x.id, x.name])),
    people: new Map(people.map((x) => [x.id, x.name])),
  };
}

type ApproverShape = {
  scopeUnitId: string | null;
  approverKind: string;
  approverUserIds: readonly string[];
};

function labelOf(r: ApproverShape, f: LabelFacts): string {
  switch (r.approverKind) {
    case "requester":
      return "The person who asked";
    case "admins":
      return "Admins";
    case "unit_leads":
      return `Leads of ${(r.scopeUnitId && f.units.get(r.scopeUnitId)) || "the unit"}`;
    default: {
      const names = r.approverUserIds.map((id) => f.people.get(id)).filter((n): n is string => !!n);
      const [first] = names;
      if (!first) return "Nobody (the people named are gone)";
      const others = names.length - 1;
      return others === 0 ? first : `${first} or ${others} ${others === 1 ? "other" : "others"}`;
    }
  }
}

/** "Leads of Sales", "Admins", "Marta Gil or 2 others", "The person who asked" for many rules (two queries). */
export async function approverLabels(
  tx: Tx,
  rows: ReadonlyArray<ApproverShape & { id: string }>,
): Promise<Map<string, string>> {
  const f = await labelFacts(
    tx,
    rows.map((r) => r.scopeUnitId),
    rows.flatMap((r) => r.approverUserIds),
  );
  return new Map(rows.map((r) => [r.id, labelOf(r, f)]));
}

/** The approver label of one rule or resolution. */
export async function approverLabel(tx: Tx, r: ApproverShape): Promise<string> {
  return labelOf(r, await labelFacts(tx, [r.scopeUnitId], r.approverUserIds));
}

/** The policy as the routes return it (with who changed it last). */
export async function toPolicyDtos(tx: Tx, rows: readonly StoredPolicy[]): Promise<ToolApprovalPolicy[]> {
  const f = await labelFacts(
    tx,
    [],
    rows.map((r) => r.updatedById),
  );
  return rows.map((r) => {
    const name = r.updatedById ? f.people.get(r.updatedById) : undefined;
    return {
      id: r.id,
      scopeUnitId: r.scopeUnitId,
      toolPattern: r.toolPattern,
      mode: r.mode,
      approverKind: r.approverKind,
      approverUserIds: [...r.approverUserIds],
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedById && name ? { id: r.updatedById, displayName: name } : null,
    };
  });
}

// ---------------------------------------------------------------- catalog

/**
 * The tools a rule can name, grouped by source (UI-SPEC Surface 4): one group per org MCP server, one per per-member
 * connector, one "Plugins" group for approved plugin tools and the fixed "Web requests" group. Every tool passes
 * `isApprovableTool`, so web tools and the other `ocw_` built-ins never appear.
 */
export async function approvableCatalog(
  tx: Tx,
  sources: readonly CatalogSourceLike[],
): Promise<ApprovableGroup[]> {
  const mcpIds = sources.filter((s) => s.sourceKind === "mcp").map((s) => s.sourceId);
  const safe = mcpIds.length
    ? await tx
        .select({ id: mcpServers.id, safeName: mcpServers.safeName })
        .from(mcpServers)
        .where(inArray(mcpServers.id, mcpIds))
    : [];
  const safeOf = new Map(safe.map((s) => [s.id, s.safeName]));
  const tools = (s: CatalogSourceLike) =>
    s.tools
      .filter((t) => isApprovableTool(t.name))
      .map((t) => ({ name: t.name, sideEffecting: t.sideEffecting }));

  const groups: ApprovableGroup[] = [];
  for (const s of sources) {
    if (s.sourceKind !== "mcp") continue;
    const safeName = safeOf.get(s.sourceId) ?? null;
    groups.push({
      source: {
        // 07.14 D-04, PD-09: only member modes are a member's connector; organization modes, like organization
        // headers, are the organization's MCP server.
        kind: s.authMode && isPerMemberMode(s.authMode) ? "connector" : "mcp",
        id: s.sourceId,
        name: s.sourceName,
        safeName: safeName && /^m[0-9a-f]{8}$/.test(safeName) ? safeName : null,
      },
      tools: tools(s).slice(0, GROUP_TOOLS_MAX),
    });
  }
  const pluginTools = sources.filter((s) => s.sourceKind === "plugin").flatMap(tools);
  // One entry per tool name: a plugin tool is approvable by name, whichever plugin declares it.
  const uniquePluginTools = [...new Map(pluginTools.map((t) => [t.name, t])).values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const fixed: ApprovableGroup[] = [];
  if (uniquePluginTools.length > 0) {
    fixed.push({
      source: { kind: "plugin", id: null, name: PLUGINS_LABEL, safeName: null },
      tools: uniquePluginTools.slice(0, GROUP_TOOLS_MAX),
    });
  }
  fixed.push({
    source: { kind: "http", id: null, name: HTTP_LABEL, safeName: null },
    tools: [{ name: HTTP_TOOL, sideEffecting: true }],
  });
  return [...groups.slice(0, GROUPS_MAX - fixed.length), ...fixed];
}

// ---------------------------------------------------------------- writes

/** Metadata of every `tool_approval_policy.*` audit row: ids, pattern, mode and approvers, never anything else. */
export function policyAudit(r: {
  id: string;
  scopeUnitId: string | null;
  toolPattern: string;
  mode: string;
  approverKind: string;
  approverUserIds: readonly string[];
}) {
  return {
    policyId: r.id,
    scopeUnitId: r.scopeUnitId,
    toolPattern: r.toolPattern,
    mode: r.mode,
    approverKind: r.approverKind,
    approverUserIds: [...r.approverUserIds],
  };
}

export interface PolicyInput {
  scopeUnitId: string | null;
  toolPattern: string;
  mode: ToolApprovalMode;
  approverKind: ToolApproverKind;
  approverUserIds: readonly string[];
}

/** Inserts one rule and its audit row in the caller's transaction. */
export async function insertPolicy(
  tx: Tx,
  audit: AuditService,
  actorUserId: string,
  input: PolicyInput,
): Promise<StoredPolicy> {
  const [row] = await tx
    .insert(toolApprovalPolicies)
    .values({
      organizationId: tenantOf(tx).organizationId,
      scopeUnitId: input.scopeUnitId,
      toolPattern: input.toolPattern,
      mode: input.mode,
      approverKind: input.approverKind,
      approverUserIds: [...input.approverUserIds],
      createdBy: actorUserId,
      updatedBy: actorUserId,
    })
    .returning({ id: toolApprovalPolicies.id });
  if (!row) throw new Error("policy insert returned nothing");
  await audit.record(tx, {
    action: "tool_approval_policy.created",
    resourceType: "tool_approval_policy",
    resourceId: row.id,
    metadata: policyAudit({ id: row.id, ...input }),
  });
  const stored = await findPolicy(tx, row.id);
  if (!stored) throw new Error("policy vanished after insert");
  return stored;
}

// ---------------------------------------------------------------- resolution (D-01, D-04)

/** The (agent, human) pair a turn runs for. */
export interface ApprovalSubject {
  agentId: string;
  userId: string;
}

/**
 * The unit paths of a call: the agent's unit (`agents.unit_id`) and the human's units, from the resolver's own facts
 * loader (`loadPrincipalFacts`), so unit membership is read in one place.
 */
export async function approvalFactsFor(tx: Tx, s: ApprovalSubject): Promise<ApprovalFacts> {
  const [agent] = await tx
    .select({ path: orgUnits.path })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(eq(agents.id, s.agentId))
    .limit(1);
  const human = await loadPrincipalFacts(tx, { kind: "user", userId: s.userId });
  return { agentUnitPath: agent?.path ?? null, humanUnitPaths: human.memberUnitPaths };
}

/**
 * Per offered tool, the mode a turn must honour: `always` or `when_tainted`; absent for `never`, for no rule and for a
 * tool no rule may name (web tools, the other `ocw_` built-ins). One policy load and one facts load per call.
 */
export async function approvalModesFor(
  tx: Tx,
  s: ApprovalSubject,
  tools: readonly string[],
): Promise<Map<string, "always" | "when_tainted">> {
  const out = new Map<string, "always" | "when_tainted">();
  const approvable = tools.filter(isApprovableTool);
  if (approvable.length === 0) return out;
  const rows = await loadToolApprovalPolicies(tx);
  if (rows.length === 0) return out;
  const facts = await approvalFactsFor(tx, s);
  for (const tool of approvable) {
    const r = resolveToolApproval(rows, facts, tool);
    if (r && r.mode !== "never") out.set(tool, r.mode);
  }
  return out;
}

/** The effective rule for one call (the gate's call-time re-decision, 07.5-07), or null. */
export async function resolveFor(tx: Tx, s: ApprovalSubject, tool: string): Promise<ResolvedApproval | null> {
  if (!isApprovableTool(tool)) return null;
  const rows = await loadToolApprovalPolicies(tx);
  if (rows.length === 0) return null;
  return resolveToolApproval(rows, await approvalFactsFor(tx, s), tool);
}

// ---------------------------------------------------------------- validation (P-04)

/**
 * Why a pattern cannot carry a rule: a well-formed tool name the contract never lets a rule name (web tools, the other
 * `ocw_` built-ins) is `tool_not_approvable`; anything else that is not a tool name or `<safe>__*` is
 * `invalid_tool_pattern`. Null when the pattern is fine.
 */
export function patternError(pattern: string): "tool_not_approvable" | "invalid_tool_pattern" | null {
  if (ToolPattern.safeParse(pattern).success) return null;
  return TOOL_NAME.test(pattern) ? "tool_not_approvable" : "invalid_tool_pattern";
}

/**
 * The inherited rule a unit rule would undercut, or null. Upper rules are the organization's and those on the unit's
 * ancestors; the same pure resolver decides what they impose on the rule's pattern (for `<safe>__*`, only upper rules
 * over the whole server), and the new mode must be at least that strict.
 */
export function weakerThanInherited(
  all: readonly PolicyRow[],
  unit: { id: string; path: readonly string[] },
  rule: { id?: string; toolPattern: string; mode: ToolApprovalMode },
): ResolvedApproval | null {
  const ancestors = new Set(unit.path.filter((id) => id !== unit.id));
  const upper = all.filter(
    (r) => r.id !== rule.id && (r.scopeUnitId === null || ancestors.has(r.scopeUnitId)),
  );
  const imposed = resolveToolApproval(
    upper,
    { agentUnitPath: null, humanUnitPaths: [unit.path] },
    rule.toolPattern,
  );
  if (!imposed) return null;
  return strictestMode([rule.mode, imposed.mode]) === rule.mode ? null : imposed;
}

// ---------------------------------------------------------------- database errors

function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const c = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    e = c.cause;
  }
  return undefined;
}

/**
 * Runs a policy write and maps every named constraint of 07.5-02 to a 4xx: the unique (scope, pattern) to 409
 * `policy_exists`, the unit foreign key to 404, the checks to 400. Anything else becomes a parameter-free error (a
 * driver message would quote the row).
 */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const pg = pgError(err);
    if (!pg && !(err instanceof Error && err.name === "DrizzleQueryError")) throw err;
    if (pg?.code === "23505" && pg.constraint === "tool_approval_policies_scope_pattern_uq") {
      throw conflict("A rule for this tool already exists in this scope", "policy_exists");
    }
    if (pg?.code === "23503" && pg.constraint === "tool_approval_policies_unit_fk") {
      throw notFound("Unit not found", "unit_not_found");
    }
    if (pg?.code === "23514" && pg.constraint?.startsWith("tool_approval_policies_")) {
      throw badRequest("The rule is not valid", "invalid_policy");
    }
    throw new Error(
      `tool approval policy query failed${pg?.code && /^[0-9A-Z]{5}$/.test(pg.code) ? ` (sqlstate ${pg.code})` : ""}`,
    );
  }
}

/** Updates one rule at `expectedVersion` (version + 1) and audits it; null when the version moved meanwhile. */
export async function updatePolicy(
  tx: Tx,
  audit: AuditService,
  actorUserId: string,
  current: StoredPolicy,
  expectedVersion: number,
  next: Pick<PolicyInput, "mode" | "approverKind" | "approverUserIds">,
): Promise<StoredPolicy | null> {
  const [row] = await tx
    .update(toolApprovalPolicies)
    .set({
      mode: next.mode,
      approverKind: next.approverKind,
      approverUserIds: [...next.approverUserIds],
      version: sql`${toolApprovalPolicies.version} + 1`,
      updatedBy: actorUserId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(toolApprovalPolicies.id, current.id), eq(toolApprovalPolicies.version, expectedVersion)))
    .returning({ id: toolApprovalPolicies.id });
  if (!row) return null;
  await audit.record(tx, {
    action: "tool_approval_policy.updated",
    resourceType: "tool_approval_policy",
    resourceId: current.id,
    metadata: policyAudit({ ...current, ...next }),
  });
  return findPolicy(tx, current.id);
}

/** Deletes one rule at `expectedVersion` and audits it; false when the version moved meanwhile. */
export async function deletePolicy(
  tx: Tx,
  audit: AuditService,
  current: StoredPolicy,
  expectedVersion: number,
): Promise<boolean> {
  const [row] = await tx
    .delete(toolApprovalPolicies)
    .where(and(eq(toolApprovalPolicies.id, current.id), eq(toolApprovalPolicies.version, expectedVersion)))
    .returning({ id: toolApprovalPolicies.id });
  if (!row) return false;
  await audit.record(tx, {
    action: "tool_approval_policy.deleted",
    resourceType: "tool_approval_policy",
    resourceId: current.id,
    metadata: policyAudit(current),
  });
  return true;
}

// ---------------------------------------------------------------- history (UI-SPEC R5)

const POLICY_ACTIONS = [
  "tool_approval_policy.created",
  "tool_approval_policy.updated",
  "tool_approval_policy.deleted",
] as const;

/** The stored audit metadata this route reads (anything else in a row is never returned). */
const HistoryMetadata = z.object({
  toolPattern: z.string().max(128),
  mode: ToolApprovalMode,
  approverKind: ToolApproverKind,
  approverUserIds: z.array(z.string()).max(TOOL_APPROVAL_LIMITS.approverUsersMax),
});

/** The opaque cursor: the id of the last audit row of the previous page. */
const encodeCursor = (id: string) => Buffer.from(id, "utf8").toString("base64url");
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!Id.safeParse(id).success) throw badRequest("Invalid cursor", "invalid_cursor");
  return id;
}

/**
 * One page of a scope's change history: the `tool_approval_policy.*` audit rows whose `scopeUnitId` is the scope
 * (null for the organization), newest first, with the actor's display name and the approver label built from the
 * stored ids. RLS keeps it inside the organization; only fixed fields leave (T-07.5-03-03).
 */
export async function policyHistory(
  tx: Tx,
  scopeUnitId: string | null,
  cursor: string | undefined,
): Promise<ToolApprovalHistory> {
  const after = cursor ? decodeCursor(cursor) : null;
  const scopeMatch =
    scopeUnitId === null
      ? sql`${auditEvents.metadata} -> 'scopeUnitId' = 'null'::jsonb`
      : sql`${auditEvents.metadata} ->> 'scopeUnitId' = ${scopeUnitId}`;
  const before = after
    ? sql`(${auditEvents.occurredAt}, ${auditEvents.id}) < (select a.occurred_at, a.id from app.audit_events a where a.id = ${after})`
    : undefined;
  const rows = await tx
    .select({
      id: auditEvents.id,
      at: auditEvents.occurredAt,
      action: auditEvents.action,
      userId: auditEvents.userId,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.resourceType, "tool_approval_policy"),
        inArray(auditEvents.action, [...POLICY_ACTIONS]),
        scopeMatch,
        before,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(TOOL_APPROVAL_LIMITS.historyPage + 1);
  const page = rows.slice(0, TOOL_APPROVAL_LIMITS.historyPage);
  const parsed = page.map((r) => ({ r, m: HistoryMetadata.safeParse(r.metadata) }));
  const f = await labelFacts(
    tx,
    [scopeUnitId],
    [...page.map((r) => r.userId), ...parsed.flatMap(({ m }) => (m.success ? m.data.approverUserIds : []))],
  );
  const items = parsed.flatMap(({ r, m }) => {
    if (!m.success) return [];
    const action = r.action.slice("tool_approval_policy.".length) as "created" | "updated" | "deleted";
    const name = r.userId ? f.people.get(r.userId) : undefined;
    const removed = action === "deleted";
    return [
      {
        id: r.id,
        at: new Date(r.at).toISOString(),
        actor: r.userId && name ? { id: r.userId, displayName: name } : null,
        action,
        toolPattern: m.data.toolPattern,
        mode: removed ? null : m.data.mode,
        approverLabel: removed ? null : labelOf({ scopeUnitId, ...m.data }, f),
      },
    ];
  });
  const last = page.at(-1);
  return { items, nextCursor: rows.length > page.length && last ? encodeCursor(last.id) : null };
}
