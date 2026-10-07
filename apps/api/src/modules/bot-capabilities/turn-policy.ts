import {
  type BotCapabilityView,
  BUILTIN_TOOLS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_WEB_CALLS_PER_TURN,
  type TurnContext,
  type TurnNow,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agents, agentTurns, conversationMembers, type Tx, tenantOf } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { agentResource, type PermissionService, type PrincipalRef } from "../organization";
import { type CatalogSource, effectiveCapabilities, effectiveTools, readCapabilities } from "./capabilities";
import { loadAllGrants, loadCatalog, loadGrants } from "./catalog";
import { loadTurnMemory } from "./memory";
import { internetConfigured, loadPolicy, type SearchEnv } from "./policy";
import { findBot, loadBotFacts } from "./routes";
import { consumeTurn, effectiveDailyLimit, limitNotice } from "./usage";

/**
 * The per-turn policy (D-07): the API decides, for every delivery, exactly which tools this bot may use for
 * this human right now and ships the result in `agent.mention.v1.turn`. The cell never recomputes it; it only
 * intersects with its snapshot. A policy or toggle change therefore bites on the next turn, before any
 * reconcile. Agent ∩ human is decided once per turn through the one resolver.
 */

type TurnTools = { tools: string[]; toolFlags: Record<string, TurnToolFlags> };

/** Maximum tools per turn (`TurnContext.tools`). */
const MAX_TURN_TOOLS = 64;

const WEB_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
const MEMORY_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };

/**
 * Flags of a catalog tool (D-08 taint rule). Every MCP / plugin output is untrusted. MCP tools are
 * side-effecting unless read-only and non-destructive; plugin tools always are (their declarations are
 * untrusted). A source trusted for chained calls carries the taint exemption as `sideEffecting: false`.
 */
function catalogFlags(source: CatalogSource, sideEffecting: boolean): TurnToolFlags {
  const effecting = source.sourceKind === "plugin" ? true : sideEffecting;
  return { untrustedOutput: true, sideEffecting: effecting && !source.trustedChaining };
}

function assemble(
  effective: BotCapabilityView["effective"],
  conversationKind: string | null,
  catalog: readonly CatalogSource[],
  effectiveToolNames: ReadonlySet<string>,
): TurnTools {
  const tools: string[] = [];
  const toolFlags: Record<string, TurnToolFlags> = {};
  const add = (name: string, flags: TurnToolFlags) => {
    if (toolFlags[name] || tools.length >= MAX_TURN_TOOLS) return;
    tools.push(name);
    toolFlags[name] = flags;
  };
  if (effective.internet.effective) {
    add(BUILTIN_TOOLS.webSearch, WEB_FLAGS);
    add(BUILTIN_TOOLS.webFetch, WEB_FLAGS);
  }
  // Memory is DM-only (D-10): read and written only in the human's DM with the bot. A null kind = any
  // conversation the bot could ever be in (the cell-wide view).
  if (effective.memory.effective && (conversationKind === null || conversationKind === "dm")) {
    add(BUILTIN_TOOLS.memorySave, MEMORY_FLAGS);
  }
  for (const source of catalog) {
    for (const t of source.tools) {
      if (effectiveToolNames.has(`${source.sourceKind}:${source.sourceId}:${t.name}`)) {
        add(t.name, catalogFlags(source, t.sideEffecting));
      }
    }
  }
  return { tools, toolFlags };
}

const toolKey = (t: { sourceKind: string; sourceId: string; tool: string }) =>
  `${t.sourceKind}:${t.sourceId}:${t.tool}`;

interface ComputedTurn extends TurnTools {
  effective: BotCapabilityView["effective"];
  /** The bot's display name and the daily limit that applies today (D-11). */
  botName: string;
  dailyLimit: number;
}

async function computeTurn(
  tx: Tx,
  perms: PermissionService,
  p: { agentId: string; humanUserId: string; conversationKind: string },
  env: SearchEnv,
): Promise<ComputedTurn | null> {
  const row = await findBot(tx, p.agentId);
  // A disabled bot does nothing for anyone (deliveries skip it; the tool gate refuses).
  if (!row || row.status === "disabled") return null;
  const caps = readCapabilities(row);
  const policy = await loadPolicy(tx);
  const configured = await internetConfigured(tx, env, policy);
  const resource = agentResource(await loadBotFacts(tx, row), p.humanUserId);
  const as: PrincipalRef = { kind: "agent", agentId: row.id, onBehalfOfUserId: p.humanUserId };
  const internet = (await perms.decide(tx, as, "bot.internet", resource)).allowed;
  const effective = effectiveCapabilities({
    scope: row.scope,
    caps,
    policy,
    configured: { internet: configured },
    human: { internet },
  });

  const catalog = await loadCatalog(tx);
  const grants = await loadGrants(tx, row.id);
  // Decide the human side only for tools that pass every other check (the tool layer, one per tool).
  const candidates = effectiveTools({
    scope: row.scope,
    caps,
    policy,
    catalog,
    grants,
    humanToolAllowed: () => null,
  }).filter((t) => t.effective);
  const allowed = new Set<string>();
  for (const t of candidates) {
    const d = await perms.decide(tx, as, "bot.tool.use", { ...resource, tool: t.tool });
    if (d.allowed) allowed.add(toolKey(t));
  }
  return {
    effective,
    botName: row.name,
    dailyLimit: effectiveDailyLimit(row.scope, caps, policy),
    ...assemble(effective, p.conversationKind, catalog, allowed),
  };
}

/**
 * The tools (and their taint flags) this bot may use for this human in this kind of conversation, right now.
 * Used at delivery by `turnPolicy` and again at call time by the tool gate (03.1-04).
 */
export async function currentTurnTools(
  tx: Tx,
  perms: PermissionService,
  p: { agentId: string; humanUserId: string; conversationKind: string },
  env: SearchEnv,
): Promise<TurnTools> {
  const turn = await computeTurn(tx, perms, p, env);
  return turn ? { tools: turn.tools, toolFlags: turn.toolFlags } : { tools: [], toolFlags: {} };
}

function validTimeZone(zone: string | null | undefined): string {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone.length <= 64 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** The asking human's local time (D-12); invalid or missing zones fall back to UTC. */
export function turnNow(clientTimeZone: string | null | undefined, at = new Date()): TurnNow {
  const timeZone = validTimeZone(clientTimeZone);
  const local = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone })
    .format(at)
    .slice(0, 80);
  return { iso: at.toISOString(), timeZone, local };
}

/**
 * Memory lives only in one human's private chat with the bot (D-10, D-06 Pitfall 7): a `dm` with exactly one
 * human member. A group DM, or anything holding two or more humans, never reads or writes a note: one person's
 * memory would otherwise surface to the others.
 */
async function memoryScopeKind(tx: Tx, conversationId: string, conversationKind: string): Promise<string> {
  if (conversationKind !== "dm") return conversationKind;
  const [row] = await tx
    .select({ humans: sql<number>`count(*)`.mapWith(Number) })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberKind, "user")),
    );
  const humanCount = row?.humans ?? 0;
  // Any other kind keeps memory off downstream (assemble and the memory gate only accept "dm").
  return humanCount === 1 ? "dm" : "dm_shared";
}

/**
 * `deliver: false` means no cell event (so no model call). `limit_reached` carries the notice the bot posts
 * instead (the caller decides whether to post it: always in a DM, once per conversation per day elsewhere)
 * and must be audited with `recordLimitReached`. `unavailable` (a disabled or deleted bot) posts nothing.
 */
export type TurnDecision =
  | { deliver: true; turn: TurnContext }
  | { deliver: false; reason: "unavailable"; notice: null }
  | { deliver: false; reason: "limit_reached"; notice: string; limit: number };

/**
 * The single per-turn entrypoint used by delivery (agent-channel mentions), inside the message transaction:
 * computes the effective turn, meters it against the bot's daily limit (D-11), records it in `agent_turns`
 * (the ledger the tool gate and memory saves trust) and returns it for `agent.mention.v1.turn`.
 */
export async function turnPolicy(
  tx: Tx,
  core: Core,
  perms: PermissionService,
  p: {
    agentId: string;
    humanUserId: string;
    conversationId: string;
    conversationKind: string;
    messageId: string;
    eventId: string;
    clientTimeZone?: string | null;
  },
): Promise<TurnDecision> {
  // The kind the capability rules see: a "dm" shared by two or more humans is not a private chat (no memory).
  const scopeKind = await memoryScopeKind(tx, p.conversationId, p.conversationKind);
  const computed = await computeTurn(tx, perms, { ...p, conversationKind: scopeKind }, core.env);
  if (!computed) return { deliver: false, reason: "unavailable", notice: null };

  // Metering (D-11): one conditional upsert counts this turn, before anything is built or recorded. At the
  // limit nothing is delivered, so the cell never sees the message and no model is called.
  const metered = await consumeTurn(tx, p.agentId, computed.dailyLimit);
  if (!metered.ok) {
    return {
      deliver: false,
      reason: "limit_reached",
      notice: limitNotice({ botName: computed.botName, limit: computed.dailyLimit }),
      limit: computed.dailyLimit,
    };
  }

  // Memory (D-10, D-06): only in this human's DM with the bot (one human member), and only while memory is
  // effective (the same decision that offers `ocw_memory_save`). Every other turn carries none.
  const memory: TurnContext["memory"] =
    scopeKind === "dm" && computed.effective.memory.effective
      ? await loadTurnMemory(tx, p.agentId, p.humanUserId)
      : [];

  const turn: TurnContext = {
    tools: computed.tools,
    toolFlags: computed.toolFlags,
    memory,
    now: computed.effective.dateTime.effective ? turnNow(p.clientTimeZone) : null,
    maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
    maxWebCalls: MAX_WEB_CALLS_PER_TURN,
  };
  await tx.insert(agentTurns).values({
    eventId: p.eventId,
    organizationId: tenantOf(tx).organizationId,
    agentId: p.agentId,
    userId: p.humanUserId,
    conversationId: p.conversationId,
    conversationKind: p.conversationKind,
    messageId: p.messageId,
    tools: turn.tools,
    toolFlags: turn.toolFlags,
  });
  return { deliver: true, turn };
}

/**
 * Audits one over-limit delivery (`agent.limit_reached`, T-03.1-05-04): the bot is the actor, the asking human
 * the user; ids and numbers only, never message content. `notified` says whether a notice was posted.
 */
export async function recordLimitReached(
  tx: Tx,
  core: Core,
  p: {
    agentId: string;
    humanUserId: string;
    conversationId: string;
    conversationKind: string;
    messageId: string;
    limit: number;
    notified: boolean;
  },
): Promise<void> {
  await core.audit.record(tx, {
    action: "agent.limit_reached",
    resourceType: "agent",
    resourceId: p.agentId,
    result: "denied",
    actorKind: "agent",
    actorId: p.agentId,
    agentId: p.agentId,
    userId: p.humanUserId,
    metadata: {
      limit: p.limit,
      conversationId: p.conversationId,
      conversationKind: p.conversationKind,
      messageId: p.messageId,
      notified: p.notified,
    },
  });
}

/**
 * Per agent, every tool the bot could use for SOME human (toggles ∩ policy ∩ configured ∩ grants ∩ not
 * dangerous, ignoring per-human rules): the cell renders it as the agent's `alsoAllow` (D-08 layer 2).
 */
export async function cellAgentCapabilities(
  tx: Tx,
  env: SearchEnv,
): Promise<Map<string, { tools: string[] }>> {
  const rows = await tx.select().from(agents).where(isNull(agents.deletedAt));
  const policy = await loadPolicy(tx);
  const configured = await internetConfigured(tx, env, policy);
  const catalog = await loadCatalog(tx);
  const grantsByAgent = await loadAllGrants(tx);
  const out = new Map<string, { tools: string[] }>();
  for (const row of rows) {
    const caps = readCapabilities(row);
    const effective = effectiveCapabilities({
      scope: row.scope,
      caps,
      policy,
      configured: { internet: configured },
      human: null,
    });
    const tools = effectiveTools({
      scope: row.scope,
      caps,
      policy,
      catalog,
      grants: grantsByAgent.get(row.id) ?? [],
      humanToolAllowed: () => null,
    });
    const names = new Set(tools.filter((t) => t.effective).map(toolKey));
    out.set(row.id, {
      tools: row.status === "disabled" ? [] : assemble(effective, null, catalog, names).tools,
    });
  }
  return out;
}
