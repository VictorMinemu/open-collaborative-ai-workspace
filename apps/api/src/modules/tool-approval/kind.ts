import {
  type AgentCardRoute,
  type ApprovalHeadline,
  type ApprovalOrigin,
  type ApprovalToolSourceKind,
  BUILTIN_TOOLS,
  canonicalJson,
  isAgentCardRoute,
  TOOL_APPROVAL_LIMITS,
  TOOL_CALL_KIND,
  type ToolCallApprovalView,
} from "@ocw/contracts";
import {
  agents,
  agentTurns,
  approvalRequests,
  cellPlugins,
  conversationMembers,
  conversations,
  mcpServers,
  orgMembers,
  orgUnits,
  type Tx,
  toolCallApprovals,
  unitMemberships,
  vaultItems,
} from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import type { ApprovalKind, ApprovalRow } from "../approval";
import { createConversationAccess } from "../chat";
import {
  loadPrincipalFacts,
  loadPrincipalFactsMany,
  orgResource,
  type PermissionService,
  type PrincipalFacts,
  unitResource,
} from "../organization";
import { cardDisplayOf, composeToolCallCard } from "./card";
import { ORGANIZATION_LABEL, resolveFor } from "./policies";
import type { ResolvedApproval } from "./resolve";
import {
  approverText,
  argumentsDisplay,
  browserActionView,
  cardBrowserOf,
  isBrowserActionTool,
  isSandboxExecAfterSignIn,
  orderPreview,
  sandboxExecPreview,
  sandboxExecView,
  toolCallTitle,
} from "./view";

/**
 * The `tool.call` approval kind (07.5-07, D-02, D-04, APPROVE-02, ADR-0023): one later use of exactly one call a bot
 * asked to make. The stored action is `tool_call_approvals` (immutable by trigger); every hook reads it through the
 * transaction's tenant (RLS), so another organization's row reads as missing.
 *
 * Who decides is decided live, at every read and decision, from the rule that applies NOW (the strictest-wins resolver
 * over the agent ∩ the human) and the decider's current facts (the permission resolver's own loader): the requester
 * (`requester`, or no rule any more), the people named who are still active members (`users`; none left = nobody),
 * a lead of the rule's unit or of an ancestor (`unit_leads`), or a current organization admin (`admins`). The decision
 * right decides, not who asked (ADR-0023 decision 15 as amended): a requester who holds it decides their own request
 * and the primitive audits `selfApproved`.
 *
 * 07.8 (D-11, D-13, ADR-0029): a stored action under the member-session floor (`requester_decides`, it acts with the
 * requester's own signed-in session) is decided by the requester alone, whatever rule applies now (`decidingRule`).
 */

export const TOOL_CALL_RESOURCE = "tool_call";

export type ToolCallRow = typeof toolCallApprovals.$inferSelect;

export interface ToolCallKindDeps {
  core: Core;
  perms: PermissionService;
}

/** The action hash's tuple element added for a call under the member-session floor (absent otherwise: 07.5 hashes). */
export const REQUESTER_DECIDES_ATOM = "requester_decides";

/** The `tool.call` action hash tuple of a stored or asked call (`kind.hashInput` recomputes it from the stored row). */
export function toolCallHashTuple(t: {
  agentId: string;
  requestedForUserId: string;
  conversationId: string;
  tool: string;
  argumentsSha256: string;
  requesterDecides: boolean;
}): string[] {
  return [
    t.agentId,
    t.requestedForUserId,
    t.conversationId,
    t.tool,
    t.argumentsSha256,
    ...(t.requesterDecides ? [REQUESTER_DECIDES_ATOM] : []),
  ];
}

/** The stored action of a request (null when it is gone or belongs to another organization). */
/** Whether the turn that asked had used a member's sign-in (`agent_turns.member_data`, D-13). */
async function sourceMemberData(tx: Tx, eventId: string): Promise<boolean> {
  const [turn] = await tx
    .select({ memberData: agentTurns.memberData })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, eventId))
    .limit(1);
  return turn?.memberData === true;
}

export async function loadToolCall(
  tx: Tx,
  row: Pick<ApprovalRow, "resourceId">,
): Promise<ToolCallRow | null> {
  const [t] = await tx
    .select()
    .from(toolCallApprovals)
    .where(eq(toolCallApprovals.id, row.resourceId))
    .limit(1);
  return t ?? null;
}

/** A member's display name in this organization, or null (not a member here). */
export async function memberName(tx: Tx, userId: string): Promise<string | null> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? null;
}

export async function agentName(tx: Tx, agentId: string): Promise<string> {
  const [a] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return a?.name ?? "Deleted bot";
}

export interface SourceInfo {
  kind: ApprovalToolSourceKind;
  name: string;
  /** Whose account runs it: the requester's (connector, personal key) or the organization's. */
  account: "requester" | "org" | null;
  keyName: string | null;
}

/** Where the stored call's tool comes from, for people (names only, never a secret or a full URL). */
export async function sourceOf(
  tx: Tx,
  t: Pick<ToolCallRow, "sourceKind" | "sourceId"> & Partial<Pick<ToolCallRow, "tool">>,
): Promise<SourceInfo> {
  // 07.8-14 (WINDOWS #234): the bot's own sandbox and browser are their own sources, never "Web request".
  if (t.sourceKind === "builtin" && t.tool?.startsWith("ocw_sandbox_")) {
    return { kind: "sandbox", name: "Sandbox", account: null, keyName: null };
  }
  if (t.sourceKind === "builtin" && t.tool?.startsWith("ocw_browser_")) {
    return { kind: "browser", name: "Browser", account: null, keyName: null };
  }
  if (t.sourceKind === "mcp" && t.sourceId) {
    const [s] = await tx
      .select({ name: mcpServers.name, authMode: mcpServers.authMode })
      .from(mcpServers)
      .where(eq(mcpServers.id, t.sourceId))
      .limit(1);
    const connector = !!s?.authMode && s.authMode !== "org_secret";
    return {
      kind: connector ? "connector" : "mcp",
      name: s?.name ?? "A removed server",
      account: connector ? "requester" : "org",
      keyName: null,
    };
  }
  if (t.sourceKind === "plugin") {
    const [p] = t.sourceId
      ? await tx
          .select({ name: cellPlugins.packageName })
          .from(cellPlugins)
          .where(eq(cellPlugins.id, t.sourceId))
          .limit(1)
      : [];
    return { kind: "plugin", name: p?.name ?? "A plugin", account: null, keyName: null };
  }
  if (t.sourceKind === "vault" && t.sourceId) {
    // A personal key reads only for its owner (RLS): anyone else sees "Web request" without the key's name.
    const [k] = await tx
      .select({ name: vaultItems.name, scope: vaultItems.scope })
      .from(vaultItems)
      .where(eq(vaultItems.id, t.sourceId))
      .limit(1);
    return {
      kind: "http",
      name: "Web request",
      account: k ? (k.scope === "personal" ? "requester" : "org") : null,
      keyName: k?.name ?? null,
    };
  }
  return { kind: "http", name: "Web request", account: null, keyName: null };
}

/** The rule that applies to the call now (live: a rule changed after the request applies as it is now); never = none. */
export async function currentRule(
  tx: Tx,
  t: Pick<ToolCallRow, "agentId" | "requestedForUserId" | "tool">,
): Promise<ResolvedApproval | null> {
  const r = await resolveFor(tx, { agentId: t.agentId, userId: t.requestedForUserId }, t.tool);
  return r && r.mode !== "never" ? r : null;
}

/**
 * The rule that names who decides the stored call now: the live rule, except under the member-session floor, where the
 * requester alone decides (null reads as the requester everywhere below; see `withFloor` in `request.ts`).
 */
export async function decidingRule(
  tx: Tx,
  t: Pick<ToolCallRow, "agentId" | "requestedForUserId" | "tool" | "requesterDecides">,
): Promise<ResolvedApproval | null> {
  return t.requesterDecides ? null : currentRule(tx, t);
}

interface RuleUnit {
  id: string;
  name: string;
  path: string[];
}

/** What deciding and labelling need of a rule (a policy's, or 07.8-14's floor, which has no policy). */
type RuleLike = Pick<ResolvedApproval, "approverKind" | "approverUserIds" | "scopeUnitId">;

async function ruleUnit(tx: Tx, rule: RuleLike | null): Promise<RuleUnit | null> {
  if (!rule?.scopeUnitId) return null;
  const [u] = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, path: orgUnits.path })
    .from(orgUnits)
    .where(eq(orgUnits.id, rule.scopeUnitId))
    .limit(1);
  return u ?? null;
}

/** The one predicate of the decision right, on the decider's current facts (also used to list the deciders). */
function holdsRight(
  facts: PrincipalFacts,
  rule: ResolvedApproval | null,
  unit: RuleUnit | null,
  requesterId: string,
): boolean {
  if (facts.kind !== "user" || facts.deactivated) return false;
  if (!rule || rule.approverKind === "requester") return facts.id === requesterId;
  switch (rule.approverKind) {
    case "users":
      return rule.approverUserIds.includes(facts.id);
    case "unit_leads":
      return !!unit && unit.path.some((id) => facts.leadOfUnitIds.has(id));
    case "admins":
      return facts.orgRole === "admin";
  }
}

/** Everyone who may decide the call now (ids), by the same predicate as `canDecide`. */
export async function decidersOf(
  tx: Tx,
  t: Pick<ToolCallRow, "requestedForUserId">,
  rule: ResolvedApproval | null,
  unit: RuleUnit | null,
): Promise<string[]> {
  let candidates: string[];
  if (!rule || rule.approverKind === "requester") candidates = [t.requestedForUserId];
  else if (rule.approverKind === "users") candidates = [...rule.approverUserIds];
  else if (rule.approverKind === "unit_leads") {
    candidates = unit
      ? (
          await tx
            .select({ userId: unitMemberships.userId })
            .from(unitMemberships)
            .where(and(inArray(unitMemberships.unitId, unit.path), eq(unitMemberships.role, "lead")))
        ).map((r) => r.userId)
      : [];
  } else {
    candidates = (
      await tx
        .select({ userId: orgMembers.userId })
        .from(orgMembers)
        .where(and(eq(orgMembers.role, "admin"), isNull(orgMembers.deactivatedAt)))
    ).map((r) => r.userId);
  }
  const facts = await loadPrincipalFactsMany(tx, candidates);
  return [...facts.values()]
    .filter((f) => holdsRight(f, rule, unit, t.requestedForUserId))
    .map((f) => f.id)
    .sort();
}

/** "Waiting for …" for the rule that applies now (only active members are named). */
export async function waitingForOf(
  tx: Tx,
  t: Pick<ToolCallRow, "requestedForUserId">,
  rule: RuleLike | null,
): Promise<string> {
  const requesterName = (await memberName(tx, t.requestedForUserId)) ?? "Former member";
  let names: string[] = [];
  if (rule?.approverKind === "users") {
    const active = await loadPrincipalFactsMany(tx, rule.approverUserIds);
    const people = rule.approverUserIds.filter((id) => active.get(id)?.deactivated === false);
    const rows = people.length
      ? await tx
          .select({ id: orgMembers.userId, name: orgMembers.displayName })
          .from(orgMembers)
          .where(inArray(orgMembers.userId, people))
      : [];
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    names = people.map((id) => byId.get(id)).filter((n): n is string => !!n);
  }
  const unit = await ruleUnit(tx, rule);
  return approverText({
    approverKind: rule?.approverKind ?? null,
    requesterName,
    names,
    unitName: unit?.name ?? null,
  });
}

/** The use window of an approved grant: `decided_at + 15 min` (P-05). */
export function useByOf(row: Pick<ApprovalRow, "decidedAt" | "status">): string | null {
  if (!row.decidedAt || (row.status !== "approved" && row.status !== "applied")) return null;
  return new Date(Date.parse(row.decidedAt) + TOOL_APPROVAL_LIMITS.grantUseMs).toISOString();
}

/** The stored canonical arguments as an object (they are always one: `approvalForCall` stores only objects). */
export function parseArgs(t: Pick<ToolCallRow, "argumentsCanonical">): Record<string, unknown> {
  const v: unknown = JSON.parse(t.argumentsCanonical);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The arguments a person reads in the preview (display only; the hash and "All arguments" keep the stored ones). An
 * `ocw_record_update` names its connector by stable id and binds the watch and the snapshot it was asked against
 * (07.6 review LO-01, HI-02): people read the record, the connector's current name and the changes.
 */
export async function previewArgsOf(
  tx: Tx,
  t: Pick<ToolCallRow, "tool">,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (t.tool !== BUILTIN_TOOLS.recordUpdate) return args;
  const id = typeof args.connector === "string" && UUID.test(args.connector) ? args.connector : null;
  const [server] = id
    ? await tx.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, id)).limit(1)
    : [];
  return { record: args.record, connector: server?.name ?? "Removed connector", changes: args.changes };
}

/** An HTTP call's method and host, for its title (the host is the stored target; never a path or query). */
/**
 * The call's target as a person reads it, or null (WINDOWS #221). For an MCP server or a connector the stored target is
 * the source's internal safe name (`mc4866abe`), the tool's own `<safe>__` prefix: an id, not a place, already named
 * by Source. Only a real destination (an HTTP host) is shown. The stored value is unchanged (titles, audit, the claim).
 */
export function shownTarget(t: Pick<ToolCallRow, "target" | "tool">): string | null {
  if (!t.target) return null;
  return t.tool.startsWith(`${t.target}__`) ? null : t.target;
}

export function httpParts(t: Pick<ToolCallRow, "argumentsCanonical" | "target">): {
  method: string | null;
  host: string | null;
} {
  const args = parseArgs(t);
  const method = typeof args.method === "string" ? args.method : null;
  let host = t.target;
  if (!host && typeof args.url === "string") {
    try {
      host = new URL(args.url).hostname || null;
    } catch {
      host = null;
    }
  }
  return { method, host };
}

/** The exact title of the stored call (the review, the inbox row and an exact card). */
export async function titleOf(tx: Tx, t: ToolCallRow, source?: SourceInfo): Promise<string> {
  // 07.8-14 (R8): a browser action reads as what it does ("Click “Place order” on shop.example.com").
  if (isBrowserActionTool(t.tool)) return browserActionView(parseArgs(t)).title;
  // 07.8-25 (D-13): a command with internet access after the requester's sign-in reads as what it risks.
  const args = parseArgs(t);
  if (isSandboxExecAfterSignIn(t.tool, args)) {
    const requesterName = (await memberName(tx, t.requestedForUserId)) ?? "Former member";
    return sandboxExecView(args, { requesterName }).title;
  }
  const s = source ?? (await sourceOf(tx, t));
  return toolCallTitle({ tool: t.tool, sourceKind: s.kind, sourceName: s.name, ...httpParts(t) });
}

/** The conversation a request was asked in: itself, or the channel or DM of a thread conversation. */
interface AskedIn {
  /** The conversation whose readers are counted and checked (a thread is judged by its channel or DM). */
  judgedId: string;
  kind: string;
  name: string | null;
  /** The card's permalink pieces. */
  route: { kind: string; conversationId: string; parentId: string | null; rootMessageId: string | null };
}

async function askedIn(tx: Tx, t: ToolCallRow): Promise<AskedIn | null> {
  const [c] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      name: conversations.name,
      parent: conversations.parentConversationId,
      root: conversations.rootMessageId,
    })
    .from(conversations)
    .where(eq(conversations.id, t.conversationId))
    .limit(1);
  if (!c) return null;
  const route = { kind: c.kind, conversationId: c.id, parentId: c.parent, rootMessageId: c.root };
  if (c.kind === "thread" && c.parent) {
    const [p] = await tx
      .select({ id: conversations.id, name: conversations.name })
      .from(conversations)
      .where(eq(conversations.id, c.parent))
      .limit(1);
    return { judgedId: p?.id ?? c.id, kind: "thread", name: p?.name ?? null, route };
  }
  return { judgedId: c.id, kind: c.kind, name: c.name, route };
}

function originOf(a: AskedIn | null, threaded: boolean): ApprovalOrigin {
  if (!a) return { kind: "channel", name: null };
  const name = a.name ? a.name.slice(0, 200) : null;
  switch (a.kind) {
    case "dm":
      return { kind: "dm", name: null };
    case "group":
      return { kind: "group", name: null };
    case "ai_chat":
      return { kind: "ai_chat", name };
    case "thread":
      return { kind: "thread", name };
    default:
      return { kind: threaded ? "thread" : "channel", name };
  }
}

/** "# ops", "DM", "Group DM", "AI chat": the inbox row's "where". */
function originLabel(o: ApprovalOrigin): string {
  switch (o.kind) {
    case "dm":
      return "DM";
    case "group":
      return "Group DM";
    case "ai_chat":
      return "AI chat";
    default:
      return o.name ? `# ${o.name}`.slice(0, 120) : "Channel";
  }
}

/** The card's chat permalink, built the way the web app builds it (`apps/web/lib/permalink.ts`). */
function messageRouteOf(a: AskedIn, t: ToolCallRow, messageId: string): AgentCardRoute | null {
  let route: string | null = null;
  switch (a.route.kind) {
    case "channel":
      route = `/chat/${a.route.conversationId}?thread=${t.threadRootMessageId ?? messageId}&m=${messageId}`;
      break;
    case "thread":
      route =
        a.route.parentId && a.route.rootMessageId
          ? `/chat/${a.route.parentId}?thread=${a.route.rootMessageId}&m=${messageId}`
          : null;
      break;
    case "dm":
    case "group":
      route = `/chat/dm/${a.route.conversationId}?m=${messageId}`;
      break;
    case "ai_chat":
      route = `/chat/ai/${a.route.conversationId}`;
      break;
  }
  return route && isAgentCardRoute(route) ? route : null;
}

/** The human members of a conversation (ids). */
export async function humanMembersOf(tx: Tx, conversationId: string): Promise<string[]> {
  return (
    await tx
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.memberKind, "user"),
        ),
      )
  ).map((r) => r.id);
}

const SOURCE_ICON = {
  mcp: "plug",
  connector: "plug",
  http: "globe",
  plugin: "package",
  sandbox: "package",
  browser: "globe",
} as const satisfies Record<ApprovalToolSourceKind, string>;

export function createToolCallKind(deps: ToolCallKindDeps): ApprovalKind {
  const access = createConversationAccess(deps.core);

  /** How many people read the conversation now, each decided by the chat's own access rule (the resolver). */
  async function readersOf(tx: Tx, a: AskedIn): Promise<number> {
    const narrow = a.kind === "dm" || a.kind === "group";
    const candidates = narrow
      ? await humanMembersOf(tx, a.judgedId)
      : (
          await tx.select({ id: orgMembers.userId }).from(orgMembers).where(isNull(orgMembers.deactivatedAt))
        ).map((r) => r.id);
    let n = 0;
    for (const id of candidates) if (await access.isReadable(tx, id, a.judgedId)) n += 1;
    return n;
  }

  const kind: ApprovalKind = {
    kind: TOOL_CALL_KIND,
    mode: "grant",
    resourceType: TOOL_CALL_RESOURCE,
    ttlMs: TOOL_APPROVAL_LIMITS.pendingTtlMs,

    async hashInput(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) throw new Error("tool call approval without its stored action");
      // From the stored row only, the arguments' hash recomputed from the canonical text itself (P-05); the
      // member-session floor is bound into it (07.8, ADR-0029).
      return toolCallHashTuple({ ...t, argumentsSha256: sha256Hex(t.argumentsCanonical) });
    },

    async canDecide(tx, deciderUserId, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return false;
      const rule = await decidingRule(tx, t);
      const facts = await loadPrincipalFacts(tx, { kind: "user", userId: deciderUserId });
      return holdsRight(facts, rule, await ruleUnit(tx, rule), t.requestedForUserId);
    },

    async audience(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return [];
      const rule = await decidingRule(tx, t);
      const deciders = await decidersOf(tx, t, rule, await ruleUnit(tx, rule));
      return [...new Set([t.requestedForUserId, ...deciders])];
    },

    // A bot deleted since it asked (its stored actions go with it), or a stored action gone: never usable again.
    async gone(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return "action_gone";
      const [bot] = await tx
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, t.agentId))
        .limit(1);
      return !bot || bot.deletedAt !== null ? "bot_deleted" : null;
    },

    async view(tx, row, viewerUserId) {
      const t = await loadToolCall(tx, row);
      if (!t) return { type: "fields", title: "This action no longer exists.", fields: [] };
      const source = await sourceOf(tx, t);
      const args = parseArgs(t);
      const preview = isSandboxExecAfterSignIn(t.tool, args)
        ? sandboxExecPreview(args)
        : orderPreview(await previewArgsOf(tx, t, args));
      const all = argumentsDisplay(args);
      // The rule that applies (shown as the policy) and the one that names the deciders differ only under the floor.
      const rule = await currentRule(tx, t);
      const unit = await ruleUnit(tx, rule);
      const deciding = await decidingRule(tx, t);
      const deciders = await decidersOf(tx, t, deciding, await ruleUnit(tx, deciding));
      const a = await askedIn(tx, t);
      const canManage = rule
        ? (
            await deps.perms.decide(
              tx,
              { kind: "user", userId: viewerUserId },
              "tool_approval.manage",
              unit ? unitResource(unit) : orgResource(),
            )
          ).allowed
        : false;
      const readsCard = !!a && !!row.cardMessageId && (await access.isReadable(tx, viewerUserId, a.judgedId));
      const view: ToolCallApprovalView = {
        type: "tool_call",
        title: await titleOf(tx, t, source),
        tool: t.tool,
        source,
        target: shownTarget(t),
        preview: preview.fields,
        truncated: preview.truncated || all.cut,
        argumentsJson: all.json,
        argumentsBytes: Buffer.byteLength(canonicalJson(args), "utf8"),
        notices: {
          hiddenCharacters: preview.notices.hiddenCharacters || all.hidden,
          maskedSecret: preview.notices.maskedSecret || all.masked,
        },
        tainted: t.tainted,
        agent: { id: t.agentId, displayName: await agentName(tx, t.agentId) },
        requestedFor: {
          id: t.requestedForUserId,
          displayName: (await memberName(tx, t.requestedForUserId)) ?? "Former member",
        },
        approverLabel: await waitingForOf(tx, t, deciding),
        policy: rule
          ? {
              scopeUnitId: rule.scopeUnitId,
              scopeLabel: (unit?.name ?? ORGANIZATION_LABEL).slice(0, 120),
              mode: rule.mode,
              pattern: rule.pattern,
              viewerCanManage: canManage,
            }
          : null,
        audience: {
          origin: originOf(a, t.threadRootMessageId !== null),
          conversationReaders: a ? await readersOf(tx, a) : 0,
          detailReaders: new Set([t.requestedForUserId, ...deciders]).size,
          messageRoute: readsCard && a && row.cardMessageId ? messageRouteOf(a, t, row.cardMessageId) : null,
        },
        useBy: useByOf(row),
        usedAt: row.consumedAt ? new Date(row.consumedAt).toISOString() : null,
        // 07.8-14 (R8): the Action, Element, Page and Session of a browser action (only the requester and deciders read
        // this view, so the value a type action will type is shown, masked).
        ...(isBrowserActionTool(t.tool) ? { browser: browserActionView(args).browser } : {}),
      };
      return view;
    },

    async headline(tx, row): Promise<ApprovalHeadline> {
      const t = await loadToolCall(tx, row);
      const bot = t ? await agentName(tx, t.agentId) : "Deleted bot";
      const person = t ? ((await memberName(tx, t.requestedForUserId)) ?? "Former member") : "Former member";
      const requester = `${bot} for ${person}`.slice(0, 200);
      if (!t) return { title: "This action no longer exists.", context: null, requester, tags: [] };
      const source = await sourceOf(tx, t);
      const origin = originOf(await askedIn(tx, t), t.threadRootMessageId !== null);
      return {
        title: await titleOf(tx, t, source),
        context: originLabel(origin),
        requester,
        tags: t.tainted ? [{ label: "Outside content", tone: "warning" }] : [],
        agent: { id: t.agentId, displayName: bot.slice(0, 200) },
        origin,
        chips: [
          { kind: "source", label: source.name.slice(0, 80), icon: SOURCE_ICON[source.kind] },
          ...(t.tainted ? [{ kind: "tainted" as const, label: "Outside content" }] : []),
        ],
        useBy: useByOf(row),
      };
    },

    async card(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) throw new Error("tool call approval without its stored action");
      return composeToolCallCard(tx, row, t, await waitingForOf(tx, t, await decidingRule(tx, t)));
    },

    async link(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return { display: "summary", useBy: useByOf(row), waitingFor: null, actionFields: 2 };
      const d = await cardDisplayOf(tx, t);
      return {
        display: d.display,
        useBy: useByOf(row),
        waitingFor: await waitingForOf(tx, t, await decidingRule(tx, t)),
        actionFields: d.actionFields,
        // 07.8-20 (R8, T-07.8-20-03): the page's host and scheme for the card's Page field, never an element or value.
        ...(isBrowserActionTool(t.tool) ? { browser: cardBrowserOf(parseArgs(t)) } : {}),
      };
    },

    // W-1 (ADR-0026 amended 2026-10-15): a decider's note may quote the call's values, which audit never carries; the
    // audit records the note's length only, as memory does (ADR-0023 §12).
    async isPrivate() {
      return true;
    },

    async cardTurn(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return null;
      const useBy = useByOf(row);
      return {
        ...(row.status === "approved" && useBy
          ? { grant: { tool: t.tool, arguments: t.argumentsCanonical, useBy } }
          : {}),
        // The request turn's taint, stored under its lock: the re-run starts tainted (D-04, APPROVE-04).
        sourceTainted: t.tainted,
        // 07.8-25 (D-13): the re-run continues a turn that used the requester's sign-in, so it has member data too.
        ...((await sourceMemberData(tx, t.eventId)) ? { sourceMemberData: true } : {}),
      };
    },
  };
  return kind;
}

/**
 * 07.8-14 (WINDOWS #245): the chat permalink of an approval's card (the turn activity's "Needs approval →"), or null
 * when the request has no card or its conversation is gone. Read in the caller's tenant transaction.
 */
export async function approvalMessageRouteOf(tx: Tx, approvalId: string): Promise<AgentCardRoute | null> {
  const [row] = await tx
    .select({ resourceId: approvalRequests.resourceId, cardMessageId: approvalRequests.cardMessageId })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);
  if (!row?.cardMessageId) return null;
  const t = await loadToolCall(tx, row);
  if (!t) return null;
  const a = await askedIn(tx, t);
  return a ? messageRouteOf(a, t, row.cardMessageId) : null;
}
