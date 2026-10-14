import {
  type BotCapabilityView,
  BUILTIN_TOOLS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_WEB_CALLS_PER_TURN,
  type TurnContext,
  type TurnMemoryFile,
  type TurnNow,
  type TurnToolFlags,
  type TurnWithheldResource,
} from "@ocw/contracts";
import {
  agents,
  agentTurns,
  agentVaultGrants,
  aiChatGrants,
  conversationMembers,
  conversations,
  memberAccountShares,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
// Types only: the memory service is injected by the caller (a value import would be a module cycle).
import { type EffectiveVaultItem, effectiveVaultItems, unitAudienceAllows } from "../keychain";
import type { MemoryAudience, MemoryService } from "../memory";
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

/**
 * What a turn's keychain decision produced (07.4-11): the keys usable here, and the member's own keys the audience rule
 * withholds here (`member_account`). Server-side only: the turn payload names withheld keys by id and name, never more.
 */
export interface TurnKeys {
  usable: EffectiveVaultItem[];
  memberAccount: EffectiveVaultItem[];
  /** Unit keys withheld here because someone outside the unit reads the conversation (07.4-12, WINDOWS #191). */
  unitAudience: EffectiveVaultItem[];
}

/**
 * `currentTurn`'s answer: the tools and flags, plus the keychain decision and the withheld entries the proxy routes
 * re-check (07.4-12: a per-member tool withheld here as `member_account` is refused with that reason).
 */
export type CurrentTurnTools = TurnTools & { keys: TurnKeys; withheld: Withheld };

/**
 * Who reads a persona's answer in a shared AI chat (06-10, D-06, P-10): the joined humans who can read it, and whether a
 * team, department or the organization holds a grant (`unbounded`: the readers are not a list). Given only for AI chat
 * deliveries; channels and DMs pass none and keep their Phase 3.1 turn.
 */
export interface TurnAudience {
  userIds: readonly string[];
  unbounded: boolean;
}

type Withheld = NonNullable<TurnContext["withheld"]>;

/** Maximum tools per turn (`TurnContext.tools`). */
const MAX_TURN_TOOLS = 64;

const WEB_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
const MEMORY_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/** `ocw_memory_list` / `ocw_memory_read`: workspace memory (written or approved by people), changes nothing. */
const MEMORY_READ_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/**
 * `ocw_memory_propose`: changes nothing by itself (a person approves every proposal), so it stays usable after the turn
 * read untrusted content; the proposal is flagged as tainted instead (D-08).
 */
const MEMORY_PROPOSE_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/**
 * `ocw_agent_card` (06-14, D-07): its output is the API's own answer (trusted) and it only posts into the turn's own
 * conversation, as the reply itself does, so it stays usable after the turn read untrusted content.
 */
const CARD_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/**
 * `ocw_board_card` (07.1-10, D-07, C-01): creates and moves cards on the turn's board through the Agent Channel API. Its
 * output is the API's own answer (trusted), but it changes shared work, so it is side-effecting: a turn that read
 * untrusted content can no longer use it (the board routes refuse `tainted`).
 */
const BOARD_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/**
 * `ocw_http_request` (07.4-11, D-04): its output is a third-party answer (untrusted) and the method decides whether a
 * call changes anything; the turn carries the most dangerous combination, the proxy route claims per method (GET and
 * HEAD as reads).
 */
const HTTP_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };
/** `ocw_connector_list` with only keychain handles to list (names and handles people wrote): trusted, changes nothing. */
const LIST_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/**
 * `ocw_connector_list` once it lists per-member connectors (07.4-11, WINDOWS 184): their tool names, descriptions and
 * argument schemas come from the third-party MCP server, so the list is untrusted content and taints the turn like any
 * MCP output. It still changes nothing. Read-then-write flows are unaffected (the first connector call taints anyway);
 * a direct write after the list needs a connector trusted for chained calls, as every MCP write does (Pitfall 6).
 */
const LIST_CONNECTORS_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };

/**
 * Whether a catalog source acts with the asking member's own account (07.4 D-01): a per-member MCP connector. Its tools
 * are called by the API (`ocw_connector_call`) under logical names and follow the member-account audience rule.
 */
function memberAccountSource(source: CatalogSource): boolean {
  return source.sourceKind === "mcp" && source.authMode !== undefined && source.authMode !== "org_secret";
}

/**
 * The audience rule for tools that act with a member's own account (07.4 D-03, D-07; CONN-03): per-member connectors and
 * personal keys are used only where that member alone reads the result: their one-person DM with the bot (`dm`, never a
 * DM holding two or more humans), an AI chat nobody else reads (`aiChatShared === false`), or a conversation where they
 * shared that resource explicitly (an active `member_account_shares` row). Anything else, unknown included, refuses.
 */
export function memberAccountAllowed(p: {
  scopeKind: string;
  aiChatShared: boolean | null;
  hasShare: boolean;
}): boolean {
  if (p.hasShare) return true;
  if (p.scopeKind === "dm") return true;
  return p.scopeKind === "ai_chat" && p.aiChatShared === false;
}

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
  /** The turn's conversation is a board channel (07.1-10). The cell-wide view (null kind) never is. */
  board = false,
  /** At least one keychain item is usable on this turn (07.4-11); in the cell-wide view: the bot holds a key grant. */
  keys = false,
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
  // Memory (D-02, D-08; 07.2-11). Writes are DM-only (D-10): `ocw_memory_save` and `ocw_memory_write` only in the human's
  // one-person DM with the bot. List, read and propose wherever memory is effective: the Agent Channel routes decide every
  // call as the bot ∩ the human ∩ every reader of the conversation (the audience rule). A null kind = any conversation the
  // bot could ever be in (the cell-wide view).
  if (effective.memory.effective) {
    const privateChat = conversationKind === null || conversationKind === "dm";
    if (privateChat) add(BUILTIN_TOOLS.memorySave, MEMORY_FLAGS);
    add(BUILTIN_TOOLS.memoryList, MEMORY_READ_FLAGS);
    add(BUILTIN_TOOLS.memoryRead, MEMORY_READ_FLAGS);
    if (privateChat) add(BUILTIN_TOOLS.memoryWrite, MEMORY_FLAGS);
    add(BUILTIN_TOOLS.memoryPropose, MEMORY_PROPOSE_FLAGS);
  }
  // Agent Cards (06-14, P-11): every delivered turn, wherever the bot may reply (the card routes re-check posting).
  add(BUILTIN_TOOLS.agentCard, CARD_FLAGS);
  // Board cards (07.1-10, D-07): only on a board channel's turns; every other turn keeps exactly its tool list.
  if (board && conversationKind === "channel") add(BUILTIN_TOOLS.boardCard, BOARD_FLAGS);
  // Per-member connectors and keys (07.4-11, D-04, D-07, C-01). A turn carries the per-member tools under their logical
  // `<safe>__<tool>` names (for the gate) plus the static tools that reach them; the cell-wide view (null kind) carries
  // the static names only, never a logical per-member name (they are not OpenClaw tools).
  const cellWide = conversationKind === null;
  const memberTools: TurnToolFlags[] = [];
  for (const source of catalog) {
    if (!memberAccountSource(source)) continue;
    for (const t of source.tools) {
      if (effectiveToolNames.has(`${source.sourceKind}:${source.sourceId}:${t.name}`)) {
        memberTools.push(catalogFlags(source, t.sideEffecting));
      }
    }
  }
  if (keys) add(BUILTIN_TOOLS.httpRequest, HTTP_FLAGS);
  if (memberTools.length > 0 || keys) {
    add(BUILTIN_TOOLS.connectorList, memberTools.length > 0 ? LIST_CONNECTORS_FLAGS : LIST_FLAGS);
  }
  if (memberTools.length > 0) {
    // The strictest of the turn's per-member tools: the cell's gate refines it per logical tool.
    add(BUILTIN_TOOLS.connectorCall, {
      untrustedOutput: memberTools.some((f) => f.untrustedOutput),
      sideEffecting: memberTools.some((f) => f.sideEffecting),
    });
  }
  for (const source of catalog) {
    if (cellWide && memberAccountSource(source)) continue;
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
  keys: TurnKeys;
  effective: BotCapabilityView["effective"];
  /** The bot's display name and the daily limit that applies today (D-11). */
  botName: string;
  dailyLimit: number;
  /** With an audience only: the tools this turn does not offer, and why (06-10). */
  withheld: Withheld;
}

/**
 * The tools of one turn. Agent ∩ asking human, as always. With an `audience` (a shared AI chat, D-06): web tools follow
 * the asker (they reach only public pages), and every catalog tool (MCP servers, plugins: scoped data) is kept only when
 * no unit or organization grant makes the readers unbounded AND `bot.tool.use` is allowed for EVERY listed reader, the
 * agent acting on behalf of each; anything dropped is listed in `withheld`.
 */
async function computeTurn(
  tx: Tx,
  perms: PermissionService,
  p: {
    agentId: string;
    humanUserId: string;
    conversationKind: string;
    /** The turn's conversation: needed for the member-account rule (07.4-11); without it that rule fails closed. */
    conversationId?: string | null;
    board?: boolean;
  },
  env: SearchEnv,
  audience?: TurnAudience | null,
): Promise<ComputedTurn | null> {
  const row = await findBot(tx, p.agentId);
  // A disabled bot does nothing for anyone (deliveries skip it; the tool gate refuses).
  if (!row || row.status === "disabled") return null;
  const caps = readCapabilities(row);
  const policy = await loadPolicy(tx);
  const configured = await internetConfigured(tx, env, policy);
  const facts = await loadBotFacts(tx, row);
  const resource = agentResource(facts, p.humanUserId);
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
  const withheld: Withheld = [];
  const withhold = (tool: string, reason: Withheld[number]["reason"], resource?: TurnWithheldResource) => {
    if (withheld.length >= MAX_TURN_TOOLS) return;
    // One entry per tool; a member-account entry is one per connector or key (UI-SPEC R7).
    const seen = resource
      ? withheld.some((w) => w.resource?.kind === resource.kind && w.resource.id === resource.id)
      : withheld.some((w) => w.tool === tool && !w.resource);
    if (!seen) withheld.push(resource ? { tool, reason, resource } : { tool, reason });
  };
  // The member-account rule's facts (07.4-11): the conversation as the rule judges it (a thread through its channel or
  // DM), whether an AI chat is read by anyone else, and the asker's active shares there.
  const member = p.conversationId
    ? await memberAccountContext(tx, {
        conversationId: p.conversationId,
        conversationKind: p.conversationKind,
        agentId: row.id,
        humanUserId: p.humanUserId,
        audience: audience ?? null,
      })
    : null;
  /** Fails closed without a conversation (the rule cannot be decided). */
  const memberMay = (kind: TurnWithheldResource["kind"], id: string) =>
    member !== null &&
    memberAccountAllowed({
      scopeKind: member.scopeKind,
      aiChatShared: member.aiChatShared,
      hasShare: member.shares.has(`${kind}:${id}`),
    });
  const sources = new Map(catalog.map((s) => [`${s.sourceKind}:${s.sourceId}`, s]));
  // Web is off for this asker only (their own permission), not for the bot: say so in a shared chat.
  if (audience && effective.internet.enabled && effective.internet.reason === "denied_for_you") {
    withhold(BUILTIN_TOOLS.webSearch, "denied_for_you");
    withhold(BUILTIN_TOOLS.webFetch, "denied_for_you");
  }
  const others = audience ? [...new Set(audience.userIds)].filter((id) => id !== p.humanUserId) : [];
  /** `bot.tool.use` for every other reader of the chat, the agent acting on behalf of each (fail closed). */
  const everyoneMay = async (tool: string) => {
    for (const userId of others) {
      const d = await perms.decide(
        tx,
        { kind: "agent", agentId: row.id, onBehalfOfUserId: userId },
        "bot.tool.use",
        { ...agentResource(facts, userId), tool },
      );
      if (!d.allowed) return false;
    }
    return true;
  };
  const allowed = new Set<string>();
  for (const t of candidates) {
    const d = await perms.decide(tx, as, "bot.tool.use", { ...resource, tool: t.tool });
    if (!d.allowed) {
      if (audience) withhold(t.tool, "denied_for_you");
      continue;
    }
    const source = sources.get(`${t.sourceKind}:${t.sourceId}`);
    if (source && memberAccountSource(source)) {
      // The member's own account: only where they alone read the result, or where they shared it (their explicit,
      // audited choice covers that audience, so the group checks below do not apply).
      if (memberMay("connector", source.sourceId)) allowed.add(toolKey(t));
      else {
        withhold(t.tool, "member_account", {
          kind: "connector",
          id: source.sourceId,
          name: source.sourceName.slice(0, 80),
        });
      }
      continue;
    }
    if (audience?.unbounded) {
      withhold(t.tool, "shared_with_group");
      continue;
    }
    if (audience && !(await everyoneMay(t.tool))) {
      withhold(t.tool, "not_every_participant");
      continue;
    }
    allowed.add(toolKey(t));
  }

  // Keychain (07.4-11, D-04, D-07): the keys this bot may use for this human (grant ∩ owner ∩ unit audience ∩
  // `vault.use`). The tx's user must be the turn's human: personal keys are invisible to any other session (owner-only
  // RLS), so a caller without it fails closed (personal keys absent), never with another member's.
  // Personal keys are the member's own account (the audience rule above). A unit key is used only where every reader of
  // the conversation is in that unit's audience (07.4-12, WINDOWS #191: the rule unit memory follows); organization keys
  // serve every member. Without a conversation the readers are unknown: unit keys fail closed.
  const usable: EffectiveVaultItem[] = [];
  const memberAccount: EffectiveVaultItem[] = [];
  const unitAudience: EffectiveVaultItem[] = [];
  let readers: TurnAudience | null = null;
  const readersHere = async (): Promise<TurnAudience> => {
    readers ??= member ? await conversationReaders(tx, member.judged, audience ?? null) : UNBOUNDED;
    return readers;
  };
  for (const key of await effectiveVaultItems(tx, perms, { agentId: row.id, humanUserId: p.humanUserId })) {
    if (key.scope === "unit" && key.unitId !== null) {
      if (await unitAudienceAllows(tx, key.unitId, await readersHere())) usable.push(key);
      else unitAudience.push(key);
      continue;
    }
    if (key.scope !== "personal" || memberMay("vault_item", key.id)) {
      usable.push(key);
      continue;
    }
    memberAccount.push(key);
    withhold(BUILTIN_TOOLS.httpRequest, "member_account", {
      kind: "vault_item",
      id: key.id,
      name: key.name.slice(0, 80),
    });
  }
  return {
    effective,
    botName: row.name,
    dailyLimit: effectiveDailyLimit(row.scope, caps, policy),
    withheld,
    keys: { usable, memberAccount, unitAudience },
    ...assemble(effective, p.conversationKind, catalog, allowed, p.board === true, usable.length > 0),
  };
}

/**
 * The tools (and their taint flags) this bot may use for this human in this kind of conversation, right now.
 * Used at delivery by `turnPolicy` and again at call time by the tool gate (03.1-04). With the conversation id the
 * member-account rule (07.4-11) is re-decided too, so a revoked share bites mid-turn.
 */
export async function currentTurnTools(
  tx: Tx,
  perms: PermissionService,
  p: { agentId: string; humanUserId: string; conversationKind: string; conversationId?: string | null },
  env: SearchEnv,
  /** The AI chat's current audience (06-10): the gate re-decides scoped tools with today's readers. */
  audience?: TurnAudience | null,
): Promise<TurnTools> {
  const turn = await currentTurn(tx, perms, p, env, audience);
  return { tools: turn.tools, toolFlags: turn.toolFlags };
}

/**
 * `currentTurnTools` plus the keychain decision (07.4-11): the keys usable on this turn now, for the proxy routes.
 * The tx must carry `userId` = the turn's human (owner-only RLS on personal keys).
 */
export async function currentTurn(
  tx: Tx,
  perms: PermissionService,
  p: { agentId: string; humanUserId: string; conversationKind: string; conversationId?: string | null },
  env: SearchEnv,
  audience?: TurnAudience | null,
): Promise<CurrentTurnTools> {
  const turn = await computeTurn(tx, perms, p, env, audience);
  return turn
    ? { tools: turn.tools, toolFlags: turn.toolFlags, keys: turn.keys, withheld: turn.withheld }
    : { tools: [], toolFlags: {}, keys: { usable: [], memberAccount: [], unitAudience: [] }, withheld: [] };
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

/** Whether a conversation is a board channel (07.1-10): one indexed lookup by id, like `memoryScopeKind`. */
async function isBoardChannel(tx: Tx, conversationId: string, conversationKind: string): Promise<boolean> {
  if (conversationKind !== "channel") return false;
  const [row] = await tx
    .select({ layout: conversations.layout })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.layout === "board";
}

/**
 * The facts the member-account rule needs (07.4-11): the scope kind of the conversation it judges (a thread through
 * its channel or DM; a `dm` only with exactly one human), whether an AI chat is read by anyone but the asker and this bot
 * (ADR-0019's `shared` minus the turn's own persona: an active grant, more than one reader, an unbounded audience or
 * another agent member; without an audience it counts as shared), and the asker's active shares there.
 */
async function memberAccountContext(
  tx: Tx,
  p: {
    conversationId: string;
    conversationKind: string;
    agentId: string;
    humanUserId: string;
    audience: TurnAudience | null;
  },
): Promise<{
  scopeKind: string;
  aiChatShared: boolean | null;
  shares: Set<string>;
  judged: { id: string; kind: string };
}> {
  let judgedId = p.conversationId;
  let judgedKind = p.conversationKind;
  if (p.conversationKind === "thread") {
    const [conv] = await tx
      .select({ parent: conversations.parentConversationId })
      .from(conversations)
      .where(eq(conversations.id, p.conversationId))
      .limit(1);
    const [parent] = conv?.parent
      ? await tx
          .select({ id: conversations.id, kind: conversations.kind })
          .from(conversations)
          .where(eq(conversations.id, conv.parent))
          .limit(1)
      : [];
    judgedId = parent?.id ?? p.conversationId;
    judgedKind = parent?.kind ?? "thread";
  }
  // A "dm_shared" from delivery is already decided; `memoryScopeKind` passes any non-"dm" kind through.
  const scopeKind = await memoryScopeKind(tx, judgedId, judgedKind);
  let aiChatShared: boolean | null = null;
  if (scopeKind === "ai_chat") {
    const [grant] = await tx
      .select({ id: aiChatGrants.id })
      .from(aiChatGrants)
      .where(and(eq(aiChatGrants.conversationId, judgedId), isNull(aiChatGrants.revokedAt)))
      .limit(1);
    const [otherAgent] = await tx
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, judgedId),
          eq(conversationMembers.memberKind, "agent"),
          ne(conversationMembers.memberId, p.agentId),
        ),
      )
      .limit(1);
    const readers = p.audience ? new Set(p.audience.userIds) : null;
    aiChatShared =
      grant !== undefined ||
      otherAgent !== undefined ||
      readers === null ||
      p.audience?.unbounded === true ||
      [...readers].some((id) => id !== p.humanUserId);
  }
  const rows = await tx
    .select({ kind: memberAccountShares.resourceKind, id: memberAccountShares.resourceId })
    .from(memberAccountShares)
    .where(
      and(
        eq(memberAccountShares.userId, p.humanUserId),
        eq(memberAccountShares.conversationId, judgedId),
        isNull(memberAccountShares.revokedAt),
      ),
    );
  return {
    scopeKind,
    aiChatShared,
    shares: new Set(rows.map((r) => `${r.kind}:${r.id}`)),
    judged: { id: judgedId, kind: judgedKind },
  };
}

const UNBOUNDED: TurnAudience = { userIds: [], unbounded: true };

/**
 * Who reads what the bot says in the judged conversation (as `conversationAudience` for memory, 07.2-11): a DM or group
 * DM, or a private channel → its human members; a public channel → anyone (unbounded); an AI chat → the readers the
 * caller passed (`audienceOf`), unbounded without them; anything else → unbounded (fail closed).
 */
async function conversationReaders(
  tx: Tx,
  judged: { id: string; kind: string },
  audience: TurnAudience | null,
): Promise<TurnAudience> {
  if (judged.kind === "ai_chat") return audience ?? UNBOUNDED;
  // `dm_shared`: a DM with two or more humans, as delivery labels it (`memoryScopeKind`).
  if (!["dm", "dm_shared", "group", "channel"].includes(judged.kind)) return UNBOUNDED;
  if (judged.kind === "channel") {
    const [conv] = await tx
      .select({ visibility: conversations.visibility })
      .from(conversations)
      .where(eq(conversations.id, judged.id))
      .limit(1);
    if (conv?.visibility !== "private") return UNBOUNDED;
  }
  const humans = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, judged.id), eq(conversationMembers.memberKind, "user")),
    );
  return { userIds: humans.map((h) => h.id), unbounded: false };
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
  opts: {
    /** AI chat deliveries only (06-10): the chat's readers, for scoped tools and `turn.withheld`. */
    audience?: TurnAudience | null;
    /**
     * Memory files (07.2-11): the memory service and the conversation's readers (lazy: asked only when a notebook may
     * be offered outside a one-person DM). Without it a turn carries no memory.
     */
    memory?: { service: MemoryService; audience: () => Promise<MemoryAudience> } | null;
  } = {},
): Promise<TurnDecision> {
  // The kind the capability rules see: a "dm" shared by two or more humans is not a private chat (no memory).
  const scopeKind = await memoryScopeKind(tx, p.conversationId, p.conversationKind);
  const board = await isBoardChannel(tx, p.conversationId, p.conversationKind);
  const computed = await computeTurn(
    tx,
    perms,
    { ...p, conversationKind: scopeKind, board },
    core.env,
    opts.audience,
  );
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

  // Memory (D-10, D-06, MULTI-06, 07.2-11), only while memory is effective (the decision that offers the memory tools):
  // the private `MEMORY.md` and its notes only in this human's one-person DM with the bot; the bot's notebook where every
  // reader may read it. AI chats carry none (ADR-0019: no memory once shared).
  let memory: TurnContext["memory"] = [];
  let memoryFiles: TurnMemoryFile[] = [];
  if (computed.effective.memory.effective && opts.memory && p.conversationKind !== "ai_chat") {
    const loaded = await loadTurnMemory(tx, opts.memory.service, {
      agentId: p.agentId,
      humanUserId: p.humanUserId,
      oneHumanDm: scopeKind === "dm",
      audience: opts.memory.audience,
    });
    memory = loaded.items;
    memoryFiles = loaded.files;
  }

  const turn: TurnContext = {
    tools: computed.tools,
    toolFlags: computed.toolFlags,
    memory,
    now: computed.effective.dateTime.effective ? turnNow(p.clientTimeZone) : null,
    maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
    maxWebCalls: MAX_WEB_CALLS_PER_TURN,
    // The persona can tell people what it could not use here and why (06-10); never a reason to enable anything.
    // Member-account entries (07.4-11, R7) travel on every delivery, so the persona can offer the share link.
    ...(opts.audience || computed.withheld.length > 0 ? { withheld: computed.withheld } : {}),
    ...(memoryFiles.length > 0 ? { memoryFiles } : {}),
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
  // Agents holding a keychain grant (07.4-11): ids only (personal items stay invisible to this session).
  const keyHolders = new Set(
    (await tx.selectDistinct({ agentId: agentVaultGrants.agentId }).from(agentVaultGrants)).map(
      (r) => r.agentId,
    ),
  );
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
      tools:
        row.status === "disabled"
          ? []
          : assemble(effective, null, catalog, names, false, keyHolders.has(row.id)).tools,
    });
  }
  return out;
}
