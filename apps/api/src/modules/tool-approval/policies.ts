import {
  type ApprovableGroup,
  isApprovableTool,
  ToolApprovalMode,
  type ToolApprovalPolicy,
  ToolApproverKind,
  ToolPattern,
} from "@ocw/contracts";
import { agents, mcpServers, orgMembers, orgUnits, type Tx, tenantOf, toolApprovalPolicies } from "@ocw/db";
import { asc, eq, inArray } from "drizzle-orm";
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
  authMode?: string;
  tools: ReadonlyArray<{ name: string; sideEffecting: boolean }>;
}

export type LoadCatalog = (tx: Tx) => Promise<readonly CatalogSourceLike[]>;

export const ORGANIZATION_LABEL = "Organization";
const PLUGINS_LABEL = "Plugins";
const HTTP_LABEL = "Web requests";
const HTTP_TOOL = "ocw_http_request";
const GROUP_TOOLS_MAX = 200;
const GROUPS_MAX = 100;

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
        kind: s.authMode && s.authMode !== "org_secret" ? "connector" : "mcp",
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
