import {
  type AgentScope,
  BotCapabilities,
  type BotCapabilityView,
  type BotPolicy,
  type BuiltinCapability,
  type CapabilityDenialReason,
  type CatalogTool,
  type ConfinedCapabilityState,
  type ConnectorAuthMode,
  DEFAULT_CAPABILITIES,
  type EffectiveCapability,
  isDangerousToolName,
  type ToolGrant,
  type ToolSourceKind,
} from "@ocw/contracts";

/**
 * The capability decision (D-06, BOT-04/05/10). PURE: no database, no Fastify. policy.ts / catalog.ts load
 * the inputs, turn-policy.ts and routes.ts compose them; this file only decides.
 */

/** A tool source as the decision needs it: an MCP server or an installed marketplace plugin. */
export interface CatalogSource {
  sourceKind: ToolSourceKind;
  sourceId: string;
  sourceName: string;
  /** MCP: `ready` is usable; plugins: `installed` is usable; anything else → `source_unavailable`. */
  status: string;
  orgEnabled: boolean;
  personalAllowed: boolean;
  /** "Trusted for chained calls": side-effecting tools stay usable after a taint (D-08). */
  trustedChaining: boolean;
  /**
   * MCP sources (Phase 07.4, D-01): whose credential the server is called with. `org_secret` is rendered in the cell;
   * a per-member connector is called by the API with the asking member's account. Absent (plugins) = organization.
   * The capability decision is the same for every mode.
   */
  authMode?: ConnectorAuthMode;
  tools: Array<{ name: string; title: string | null; description: string | null; sideEffecting: boolean }>;
}

const SHAPE = BotCapabilities.shape;

/** Stored jsonb over the scope defaults; unknown keys and invalid values are ignored. */
export function readCapabilities(row: { scope: AgentScope; capabilities: unknown }): BotCapabilities {
  const out: BotCapabilities = { ...DEFAULT_CAPABILITIES[row.scope] };
  const stored =
    row.capabilities && typeof row.capabilities === "object"
      ? (row.capabilities as Record<string, unknown>)
      : {};
  for (const key of Object.keys(SHAPE) as Array<keyof BotCapabilities>) {
    if (!(key in stored)) continue;
    const parsed = SHAPE[key].safeParse(stored[key]);
    if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

const USABLE_STATUS: Record<ToolSourceKind, string> = { mcp: "ready", plugin: "installed" };

/** Policy reason for one built-in capability (null = the policy allows it for this bot). */
function policyReason(
  scope: AgentScope,
  policy: BotPolicy,
  cap: BuiltinCapability,
): CapabilityDenialReason | null {
  const entry = policy.capabilities[cap];
  if (!entry.orgWide) return "org_policy";
  if (scope === "personal" && !entry.personal) return "personal_policy";
  return null;
}

/**
 * Phase 07.17.1.1.2 (D-04, PD-09): whether a bot may run long tasks, and the organization's limits. `enabled` = the
 * bot's own toggle ∧ the organization's "Allow long tasks" ∧ (personal bot ? its personal sub-switch : true); `reason`
 * names the policy that stands in the way (kept while the toggle is off, like `EffectiveCapability`).
 */
export interface TaskPolicy {
  enabled: boolean;
  reason: CapabilityDenialReason | null;
  maxTurns: number;
  maxHours: number;
  maxRunning: number;
}

/** The long-task decision for one bot (pure). `loadTaskPolicy` loads its inputs; `computeTurn` reuses its policy. */
export function taskPolicyFor(input: {
  scope: AgentScope;
  caps: Pick<BotCapabilities, "longTasks">;
  policy: BotPolicy;
}): TaskPolicy {
  const reason = policyReason(input.scope, input.policy, "longTasks");
  return {
    enabled: input.caps.longTasks && reason === null,
    reason,
    maxTurns: input.policy.tasks.maxTurns,
    maxHours: input.policy.tasks.maxHours,
    maxRunning: input.policy.tasks.maxRunning,
  };
}

/** A toggle that is off keeps its reason, so the UI can refuse to switch on what would not work. */
function result(enabled: boolean, reason: CapabilityDenialReason | null): EffectiveCapability {
  return { enabled, effective: enabled && reason === null, reason };
}

/**
 * Built-in capabilities: toggle ∧ org-wide ∧ (personal ? personal : true) ∧ configured ∧ human. `human` is
 * the resolver's agent ∩ human answer for `bot.internet`; null = no human side (the cell-wide view).
 */
export function effectiveCapabilities(input: {
  scope: AgentScope;
  caps: BotCapabilities;
  policy: BotPolicy;
  configured: { internet: boolean };
  human: { internet: boolean } | null;
}): BotCapabilityView["effective"] {
  const { scope, caps, policy, configured, human } = input;
  const internetReason =
    policyReason(scope, policy, "internet") ??
    (configured.internet ? null : "not_configured") ??
    (human && !human.internet ? "denied_for_you" : null);
  const replyAll = caps.replyMode === "all";
  return {
    internet: result(caps.internet, internetReason),
    memory: result(caps.memory, policyReason(scope, policy, "memory")),
    dateTime: result(caps.dateTime, policyReason(scope, policy, "dateTime")),
    // A personal bot lives only in its owner's DM: reply mode `all` (a channel setting) never applies.
    replyModeAll: result(
      replyAll,
      policyReason(scope, policy, "replyModeAll") ?? (scope === "personal" ? "dm_only" : null),
    ),
    // 07.17.1.1.2 (D-04): the same rule as `taskPolicyFor`. Nothing to configure and no per-person permission, so
    // neither `not_configured` nor `denied_for_you` applies.
    longTasks: result(caps.longTasks, policyReason(scope, policy, "longTasks")),
  };
}

const grantKey = (g: { sourceKind: string; sourceId: string; tool: string }) =>
  `${g.sourceKind}:${g.sourceId}:${g.tool}`;

/**
 * Every tool of the catalog with its grant and effective state for this bot. Reason precedence:
 * `dangerous` → `source_unavailable` → `org_policy` → `personal_policy` → `denied_for_you`. An ungranted tool
 * is listed with `effective: false` and the reason it could not be enabled (source, org or personal policy), so
 * the UI disables and explains it; the human side (`denied_for_you`) is judged for granted tools only. `humanToolAllowed` answers the
 * resolver's `bot.tool.use` (agent ∩ human, tool layer); null = no human side. Grants whose tool is no longer
 * in the catalog are dropped.
 */
export function effectiveTools(input: {
  scope: AgentScope;
  caps: BotCapabilities;
  policy: BotPolicy;
  catalog: readonly CatalogSource[];
  grants: readonly ToolGrant[];
  humanToolAllowed: (tool: string) => boolean | null;
}): CatalogTool[] {
  const granted = new Set(input.grants.map(grantKey));
  const out: CatalogTool[] = [];
  for (const source of input.catalog) {
    for (const t of source.tools) {
      const g = { sourceKind: source.sourceKind, sourceId: source.sourceId, tool: t.name };
      const isGranted = granted.has(grantKey(g));
      let reason: CapabilityDenialReason | null = null;
      if (isDangerousToolName(t.name)) reason = "dangerous";
      else if (source.status !== USABLE_STATUS[source.sourceKind]) reason = "source_unavailable";
      else if (!source.orgEnabled) reason = "org_policy";
      else if (input.scope === "personal" && !source.personalAllowed) reason = "personal_policy";
      else if (isGranted && input.humanToolAllowed(t.name) === false) reason = "denied_for_you";
      out.push({
        ...g,
        sourceName: source.sourceName,
        title: t.title,
        description: t.description,
        sideEffecting: t.sideEffecting,
        granted: isGranted,
        effective: isGranted && reason === null,
        reason,
      });
    }
  }
  return out;
}

/**
 * The bot page's Sandbox and Browser rows (07.8-11; D-12, R11): `enabled` is the bot's own switch; `available` says
 * whether turning it on would work for the viewer now. Reason precedence: `service_down` (sandboxd not configured) →
 * `org_off` (the organization switch) → `killed` (the kill switch) → `module_off` (the resolver refused the viewer the
 * module's grain on this bot). `moduleAllowed` is the resolver's answer; nothing here re-decides it.
 */
export function confinedCapabilities(input: {
  caps: Pick<BotCapabilities, "sandbox" | "browser">;
  configured: boolean;
  settings: { enabled: boolean; killed: boolean };
  moduleAllowed: { sandbox: boolean; browser: boolean };
}): { sandbox: ConfinedCapabilityState; browser: ConfinedCapabilityState } {
  const state = (kind: "sandbox" | "browser"): ConfinedCapabilityState => {
    const reason: ConfinedCapabilityState["reason"] = !input.configured
      ? "service_down"
      : !input.settings.enabled
        ? "org_off"
        : input.settings.killed
          ? "killed"
          : input.moduleAllowed[kind]
            ? null
            : "module_off";
    return { enabled: input.caps[kind], available: reason === null, reason };
  };
  return { sandbox: state("sandbox"), browser: state("browser") };
}
