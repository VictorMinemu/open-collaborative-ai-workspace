"use client";

import {
  type ApprovableGroup,
  matchesToolPattern,
  type OrgUnit,
  strictestMode,
  ToolApprovalAccess,
  ToolApprovalHistory,
  type ToolApprovalMode,
  ToolApprovalPolicy,
  ToolApprovalPolicyPage,
  type ToolApproverKind,
} from "@ocw/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Settings › Approval policies (Phase 07.5, D-01, P-04, UI-SPEC Surface 4, R4, R5): the 07.5-03 routes, parsed with the
 * 07.5-01 contracts. The web never decides who may manage what: it renders the API's access and page answers, and the
 * API re-checks every write (scope, approvers, strictness, version). The pure helpers below only label what the page
 * already says (which rule carries a row's mode, and whether an upper rule leaves nothing to add).
 */

/** `org` or a unit id: the `?scope=` of every route. */
export type PolicyScope = string;
export const ORG_SCOPE = "org";
const ORG_LABEL = "Organization";

export const approvalPolicyKeys = {
  all: ["tool-approval-policies"] as const,
  access: ["tool-approval-policies", "access"] as const,
  pages: ["tool-approval-policies", "page"] as const,
  page: (scope: PolicyScope) => ["tool-approval-policies", "page", scope] as const,
  history: (scope: PolicyScope) => ["tool-approval-policies", "history", scope] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** Where the caller may manage rules (one cached query: the settings navigation and the page share it). */
export function useApprovalPolicyAccess(enabled = true) {
  return useQuery({
    enabled,
    queryKey: approvalPolicyKeys.access,
    queryFn: ({ signal }) =>
      api.get("/api/v1/tool-approval-policies/access", { schema: ToolApprovalAccess, signal }),
    retry: noRetryOn4xx,
    staleTime: 60_000,
  });
}

/** True when the caller manages the organization or at least one unit (R4). */
export function canManageAny(access: ToolApprovalAccess | undefined): boolean {
  return !!access && (access.manageable.organization || access.manageable.unitIds.length > 0);
}

/** One scope's rules, the stricter ones above it, the catalog and the approver labels. `null` = not loaded. */
export function useApprovalPolicyPage(scope: PolicyScope | null) {
  return useQuery({
    enabled: scope !== null,
    queryKey: approvalPolicyKeys.page(scope ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/tool-approval-policies?scope=${encodeURIComponent(scope ?? "")}`, {
        schema: ToolApprovalPolicyPage,
        signal,
      }),
    retry: noRetryOn4xx,
  });
}

/** What the rule dialog saves. `never` asks nobody; only `users` names people. */
export interface PolicyDraft {
  mode: ToolApprovalMode;
  approverKind: ToolApproverKind;
  approverUserIds: string[];
}

/** The body the API accepts for a draft (P-04: a never rule is `requester`, other kinds carry no people). */
export function normalizeDraft(d: PolicyDraft): PolicyDraft {
  if (d.mode === "never") return { mode: "never", approverKind: "requester", approverUserIds: [] };
  return { ...d, approverUserIds: d.approverKind === "users" ? d.approverUserIds : [] };
}

function invalidatePolicies(qc: ReturnType<typeof useQueryClient>) {
  // Every page: a unit page inherits the organization's rules, and the MCP list reads the organization page.
  void qc.invalidateQueries({ queryKey: approvalPolicyKeys.pages });
  void qc.invalidateQueries({ queryKey: ["tool-approval-policies", "history"] });
}

/** Creates this scope's rule for the pattern, or updates the existing one at the version seen (409 on a stale one). */
export function useSaveApprovalPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      scopeUnitId: string | null;
      toolPattern: string;
      existing: ToolApprovalPolicy | null;
      draft: PolicyDraft;
    }) => {
      const d = normalizeDraft(input.draft);
      if (input.existing) {
        return api.patch(`/api/v1/tool-approval-policies/${input.existing.id}`, {
          body: { expectedVersion: input.existing.version, ...d },
          schema: ToolApprovalPolicy,
        });
      }
      return api.post("/api/v1/tool-approval-policies", {
        body: {
          scopeUnitId: input.scopeUnitId,
          toolPattern: input.toolPattern,
          mode: d.mode,
          approverKind: d.approverKind,
          ...(d.approverKind === "users" ? { approverUserIds: d.approverUserIds } : {}),
        },
        schema: ToolApprovalPolicy,
      });
    },
    onSettled: () => invalidatePolicies(qc),
  });
}

/** Removes a rule at the version seen (409 `policy_version_conflict` when someone changed it meanwhile). */
export function useRemoveApprovalPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: Pick<ToolApprovalPolicy, "id" | "version">) =>
      api.del(`/api/v1/tool-approval-policies/${policy.id}?expectedVersion=${policy.version}`),
    onSettled: () => invalidatePolicies(qc),
  });
}

/** The scope's change history, newest first, 30 per page (R5). */
export function useApprovalPolicyHistory(scope: PolicyScope, enabled: boolean) {
  return useInfiniteQuery({
    enabled,
    queryKey: approvalPolicyKeys.history(scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/api/v1/tool-approval-policies/history?scope=${encodeURIComponent(scope)}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
        }`,
        { schema: ToolApprovalHistory, signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: noRetryOn4xx,
  });
}

/**
 * The organization-scope mode of each tool (Settings › MCP servers' "Needs approval" chip, UI-SPEC Surface 4). Only
 * for callers who manage the organization's rules; everyone else gets nothing and the list stays as it was.
 */
export function useOrgToolApprovalModes(): (tool: string) => ToolApprovalMode {
  const access = useApprovalPolicyAccess();
  const page = useApprovalPolicyPage(access.data?.manageable.organization ? ORG_SCOPE : null);
  const rules = page.data?.policies ?? [];
  return (tool) =>
    strictestMode(rules.filter((r) => matchesToolPattern(r.toolPattern, tool)).map((r) => r.mode));
}

// ---------------------------------------------------------------- pure presentation helpers

export const MODE_LABEL: Readonly<Record<ToolApprovalMode, string>> = {
  never: "Never ask",
  when_tainted: "Ask after outside content",
  always: "Always ask",
};

const MODE_RANK: Readonly<Record<ToolApprovalMode, number>> = { never: 0, when_tainted: 1, always: 2 };

/** True when `mode` asks less often than `than` (a unit can only add approvals). */
export function isWeaker(mode: ToolApprovalMode, than: ToolApprovalMode): boolean {
  return MODE_RANK[mode] < MODE_RANK[than];
}

export const isServerPattern = (pattern: string) => pattern.endsWith("__*");

/**
 * Whether a rule on `rulePattern` covers the row for `rowPattern`: a server row (`<safe>__*`) is covered only by a
 * rule on the whole server (an exact tool rule never covers every tool); a tool row by its own name or its server's.
 */
export function ruleCoversRow(rulePattern: string, rowPattern: string): boolean {
  if (isServerPattern(rowPattern)) return rulePattern === rowPattern;
  return matchesToolPattern(rulePattern, rowPattern);
}

type InheritedRule = ToolApprovalPolicyPage["inherited"][number];

export type RowSource = "own" | "server" | "organization" | "unit" | "none";

export interface RowMode {
  /** The strictest applicable mode (what a bot meets at call time for this scope's people). */
  mode: ToolApprovalMode;
  /** Which rule carries it: this row's own rule, this scope's server rule, an upper scope's, or none. */
  source: RowSource;
  /** "from all tools" / "from Organization" / "from Sales"; null for an own rule or no rule. */
  sourceLabel: string | null;
  /** The carrier rule, if any. */
  policy: ToolApprovalPolicy | null;
  /** The carrier's approvers ("Admins", "Leads of Sales"), when it asks someone. */
  approverLabel: string | null;
  /** This scope's own rule on exactly this pattern (what Edit updates and Remove deletes). */
  own: ToolApprovalPolicy | null;
  /** The strictest upper-scope mode on this row, and the scope it comes from. */
  inheritedMode: ToolApprovalMode;
  inheritedScopeLabel: string | null;
  /** An upper rule already asks every time: nothing is left to add here, so Edit is unavailable. */
  locked: boolean;
}

/** "The organization already asks every time. A unit can only add approvals." (UI-SPEC inherited reason). */
export function inheritedReason(mode: ToolApprovalMode, scopeLabel: string | null): string {
  const who = !scopeLabel || scopeLabel === ORG_LABEL ? "The organization" : scopeLabel;
  const when = mode === "always" ? "every time" : "after outside content";
  return `${who} already asks ${when}. A unit can only add approvals.`;
}

/**
 * The effective mode of one row and where it comes from (own > this scope's server rule > upper scopes when equally
 * strict; a stricter rule always wins, as at call time). `withoutOwn` answers "what does it go back to" for Remove.
 */
export function effectiveRowMode(
  page: Pick<ToolApprovalPolicyPage, "scope" | "policies" | "inherited" | "approverLabels">,
  rowPattern: string,
  opts: { withoutOwn?: boolean } = {},
): RowMode {
  const own = page.policies.find((p) => p.toolPattern === rowPattern) ?? null;
  const server = isServerPattern(rowPattern)
    ? null
    : (page.policies.find(
        (p) => isServerPattern(p.toolPattern) && matchesToolPattern(p.toolPattern, rowPattern),
      ) ?? null);
  const upper = page.inherited.filter((p) => ruleCoversRow(p.toolPattern, rowPattern));
  const inheritedMode = strictestMode(upper.map((p) => p.mode));
  // Upper scopes first (the organization before units), exact tool rules before server rules: the call-time carrier.
  const upperCarrier =
    [...upper]
      .filter((p) => p.mode === inheritedMode)
      .sort(
        (a, b) =>
          Number(a.scopeUnitId !== null) - Number(b.scopeUnitId !== null) ||
          Number(isServerPattern(a.toolPattern)) - Number(isServerPattern(b.toolPattern)),
      )[0] ?? null;

  type Candidate = {
    policy: ToolApprovalPolicy | InheritedRule;
    source: RowSource;
    sourceLabel: string | null;
  };
  const candidates: Candidate[] = [];
  if (own && !opts.withoutOwn) candidates.push({ policy: own, source: "own", sourceLabel: null });
  if (server) candidates.push({ policy: server, source: "server", sourceLabel: "from all tools" });
  if (upperCarrier) {
    candidates.push({
      policy: upperCarrier,
      source: upperCarrier.scopeUnitId === null ? "organization" : "unit",
      sourceLabel: `from ${upperCarrier.scopeLabel}`,
    });
  }
  const mode = strictestMode(candidates.map((c) => c.policy.mode));
  const carrier = candidates.find((c) => c.policy.mode === mode) ?? null;
  const asks = carrier !== null && carrier.policy.mode !== "never";
  return {
    mode,
    source: carrier?.source ?? "none",
    sourceLabel: carrier?.sourceLabel ?? null,
    policy: carrier?.policy ?? null,
    approverLabel: asks && carrier ? (page.approverLabels[carrier.policy.id] ?? null) : null,
    own,
    inheritedMode,
    inheritedScopeLabel: upperCarrier?.scopeLabel ?? null,
    locked: page.scope.unitId !== null && inheritedMode === "always",
  };
}

/** The tool's own name: `echo` for `m1a2b3c4d__echo` (the catalog lists the full bot-facing name). */
export function toolDisplayName(group: Pick<ApprovableGroup, "source">, name: string): string {
  const prefix = group.source.safeName ? `${group.source.safeName}__` : null;
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** "All Acme CRM tools" for a server pattern, the tool's name otherwise (history and dialog titles). */
export function patternLabel(catalog: readonly ApprovableGroup[], pattern: string): string {
  if (isServerPattern(pattern)) {
    const safe = pattern.slice(0, -3);
    const group = catalog.find((g) => g.source.safeName === safe);
    return group ? `All ${group.source.name} tools` : pattern;
  }
  for (const g of catalog) {
    if (g.tools.some((t) => t.name === pattern)) return toolDisplayName(g, pattern);
  }
  return pattern;
}

export interface ScopeOption {
  value: PolicyScope;
  label: string;
  unit: Pick<OrgUnit, "id" | "kind" | "name"> | null;
  /** Indent level in the org chart (0 = top of what the caller manages). */
  depth: number;
}

/**
 * The Scope select (UI-SPEC Surface 4): the organization first for admins, then every manageable unit in org-chart
 * order (`ordered` is the depth-first tree), indented below the shallowest one shown.
 */
export function scopeOptions(
  access: ToolApprovalAccess,
  ordered: ReadonlyArray<Pick<OrgUnit, "id" | "kind" | "name" | "path">>,
): ScopeOption[] {
  const out: ScopeOption[] = [];
  if (access.manageable.organization) {
    out.push({ value: ORG_SCOPE, label: ORG_LABEL, unit: null, depth: 0 });
  }
  const allowed = new Set(access.manageable.unitIds);
  const units = ordered.filter((u) => allowed.has(u.id));
  // Under the organization a top-level unit is one level in; a lead's shallowest unit is level 0.
  const shallowest = units.length > 0 ? Math.min(...units.map((u) => u.path.length)) : 1;
  for (const u of units) {
    const kind = u.kind.charAt(0).toUpperCase() + u.kind.slice(1);
    out.push({
      value: u.id,
      label: `${u.name} (${kind})`,
      unit: { id: u.id, kind: u.kind, name: u.name },
      depth: access.manageable.organization ? u.path.length : u.path.length - shallowest,
    });
  }
  return out;
}
