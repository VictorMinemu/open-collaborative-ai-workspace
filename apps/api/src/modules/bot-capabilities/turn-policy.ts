import {
  type BotCapabilityView,
  BUILTIN_TOOLS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_WEB_CALLS_PER_TURN,
  type TurnContext,
  type TurnNow,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agents, agentTurns, type Tx, tenantOf } from "@ocw/db";
import { isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { agentResource, type PermissionService, type PrincipalRef } from "../organization";
import { type CatalogSource, effectiveCapabilities, effectiveTools, readCapabilities } from "./capabilities";
import { loadAllGrants, loadCatalog, loadGrants } from "./catalog";
import { internetConfigured, loadPolicy, type SearchEnv } from "./policy";
import { botFacts, findBot } from "./routes";

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
  const resource = agentResource(botFacts(row), p.humanUserId);
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
  return { effective, ...assemble(effective, p.conversationKind, catalog, allowed) };
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

export type TurnDecision = { deliver: true; turn: TurnContext } | { deliver: false; notice: string };

/**
 * The single per-turn entrypoint used by delivery (agent-channel mentions), inside the message transaction:
 * computes the effective turn, records it in `agent_turns` (the ledger the tool gate and memory saves trust)
 * and returns it for `agent.mention.v1.turn`.
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
  const computed = await computeTurn(tx, perms, p, core.env);
  if (!computed) return { deliver: false, notice: "This bot is no longer available." };

  // Extension point (03.1-05): metering. Increment `agent_usage_daily` atomically here; at the limit return
  // `{ deliver: false, notice }` so no cell event (and no model call) happens.

  // Extension point (03.1-07): memory. Load this human's memories of this bot when memory is effective and
  // the conversation is their DM with it.
  const memory: TurnContext["memory"] = [];

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
