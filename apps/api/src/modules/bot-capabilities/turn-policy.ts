import {
  A2A_MAX_DEPTH,
  A2A_MAX_TARGETS,
  ATTACHMENT_READ_FLAGS,
  ATTACHMENT_READ_LIMITS,
  type BotCapabilities,
  type BotCapabilityView,
  BROWSER_TOOL_NAMES,
  type BrowserToolName,
  BUILTIN_TOOLS,
  CONFINED_TOOL_FLAGS,
  CONVERSATION_OPEN_FLAGS,
  type ConfinedToolName,
  type ConsultTarget,
  isPerMemberMode,
  MAX_SANDBOX_CALLS_PER_TURN,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_WEB_CALLS_PER_TURN,
  modelAcceptsImages,
  SANDBOX_TOOL_NAMES,
  TASK_TOOL_FLAGS,
  TASK_TOOL_NAMES,
  type TaskToolName,
  TURN_TOOLS_MAX,
  type TurnAttachment,
  type TurnContext,
  type TurnMemoryFile,
  type TurnNow,
  type TurnTask,
  type TurnToolFlags,
  type TurnWithheldResource,
  type TurnWorkZone,
  usesConnectorProxy,
  WORK_SESSION_TOOL_FLAGS,
  WORK_SESSION_TOOL_NAMES,
} from "@ocw/contracts";
import {
  agents,
  agentTurns,
  aiChatGrants,
  conversationMembers,
  conversations,
  memberAccountShares,
  messages,
  type Tx,
  tenantOf,
  watchedRecords,
} from "@ocw/db";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Env } from "../../config/env";
import type { Core } from "../../core";
import { type AttachmentRow, objectStorageConfigured } from "../artifact";
import { channelFacts, createConversationAccess } from "../chat";
// Types only: the memory service is injected by the caller (a value import would be a module cycle).
import { type EffectiveVaultItem, effectiveVaultItems, unitAudienceAllows } from "../keychain";
import type { MemoryAudience, MemoryService } from "../memory";
import {
  agentResource,
  audienceCoverFacts,
  audienceCovers,
  channelResource,
  orgResource,
  type PermissionService,
  type PrincipalRef,
} from "../organization";
import { sandboxAvailable } from "../sandbox";
import { approvalModesFor } from "../tool-approval";
import {
  type CatalogSource,
  effectiveCapabilities,
  effectiveTools,
  readCapabilities,
  taskPolicyFor,
} from "./capabilities";
import { loadAllGrants, loadCatalog, loadGrants } from "./catalog";
import { stickyMemberData } from "./member-data";
import { loadTurnMemory } from "./memory";
import { internetConfigured, loadPolicy, type SearchEnv } from "./policy";
import { findBot, loadBotFacts } from "./routes";
import { buildTurnAttachments, withoutReadTool } from "./turn-attachments";
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
export type CurrentTurnTools = TurnTools & {
  keys: TurnKeys;
  withheld: Withheld;
  /** Phase 07.17.1.1.2 (D-04): the bot may run long tasks on this turn (`computeTurn.longTasks`). */
  longTasks: boolean;
};

/**
 * Who reads a persona's answer in a shared AI chat (06-10, D-06, P-10): the joined humans who can read it, and whether a
 * team, department or the organization holds a grant (`unbounded`: the readers are not a list). Given only for AI chat
 * deliveries; channels and DMs pass none and keep their Phase 3.1 turn.
 */
/**
 * Phase 07.17.1.1.2 (D-02, PD-07): what a turn may do about the bot's long task in its thread, computed by the caller
 * (agent-channel's `taskOfferFor`; bot-capabilities never imports agent-channel) and gated here by `computeTurn`'s
 * `longTasks`. `start`: no active task, the three tools. `control`: the task's own current turn, or its requester's turn
 * while it waits: continue and finish, `turn.task` and the ledger's `task_id`. `view`: any other turn in that thread:
 * `turn.task` only.
 */
export interface TurnTaskOffer {
  offer: "start" | "control" | "view";
  task: TurnTask | null;
  taskId: string | null;
}

/** The task tools each offer carries (A-04: the start turn may continue in the same turn). */
const TASK_OFFER_TOOLS: Readonly<Record<TurnTaskOffer["offer"], readonly TaskToolName[]>> = {
  start: TASK_TOOL_NAMES,
  control: [BUILTIN_TOOLS.taskContinue, BUILTIN_TOOLS.taskFinish],
  view: [],
};

export interface TurnAudience {
  userIds: readonly string[];
  unbounded: boolean;
}

type Withheld = NonNullable<TurnContext["withheld"]>;

/** Maximum tools per turn (`TurnContext.tools`). */
const MAX_TURN_TOOLS = TURN_TOOLS_MAX;

const PLATFORM_TOOLS: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOLS));

/** A tool of the platform (built in, `ocw_*` or a web tool) rather than an organization MCP server's tool. */
const isPlatformTool = (name: string): boolean => PLATFORM_TOOLS.has(name) || name.startsWith("ocw_");

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
 * `ocw_work_zone_projects` (07.5-08, D-03): the API's own list of the human's projects (names and ids only), trusted and
 * read-only, so a tainted turn may still list.
 */
const WORK_ZONE_PROJECTS_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/**
 * `ocw_start_work_zone` (07.5-08, D-03, APPROVE-04): trusted answer, always side-effecting: a turn that read untrusted
 * content can never propose a session (the proposal route claims it as side-effecting whatever the turn says).
 */
const START_WORK_ZONE_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/**
 * `ocw_automation_propose` (07.6-12, D-02, D-03): trusted answer, always side-effecting: a turn that read outside content
 * never proposes an automation (the route refuses it 403 `tainted`, the plugin before it).
 */
const AUTOMATION_PROPOSE_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/**
 * `ocw_record_update` (07.6-14, D-04, D-07): changes a record outside the workspace (side-effecting) and its answer
 * reflects outside values (untrusted). A turn that read outside content is refused unless a 07.5 grant covers the call.
 */
const RECORD_UPDATE_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };
/**
 * `ocw_consult_agent` (07.7, D-08, D-09): the API's own answer (trusted), always side-effecting: a turn that read outside
 * content never consults another bot (the route's claim refuses it 403 `tainted`, the plugin before it).
 */
const CONSULT_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };

/**
 * The sandbox tools a turn is offered (07.8-05, D-12, P-05, P-06): every `ocw_sandbox_*` tool, `ocw_sandbox_import`
 * included since 07.8-25 (its route copies an attachment only when the conversation's audience covers the workspace's,
 * `audienceCovers`). Their static flags come from `CONFINED_TOOL_FLAGS` (the D-13 member-data rule and P-11's team-bot
 * rule stay server-side). Browser tools are offered from 07.8-14.
 */
const OFFERED_SANDBOX_TOOLS = SANDBOX_TOOL_NAMES;

/**
 * The browser tools a turn is offered (07.8-14, D-05, D-14, P-14): open, snapshot, act, wait and close, and the
 * screenshot only when the bot's model reads images (spike ii: an image from a tool reaches only a model declared
 * `input: ["text", "image"]`; any other model would read "(tool image omitted)"). `ocw_browser_signin` (07.8-21, D-11)
 * only where the member-account audience rule allows a member's own sign-in (`signIn`).
 */
function offeredBrowserTools(
  bot: { modelProvider: string; modelId: string },
  signIn: boolean,
): BrowserToolName[] {
  return BROWSER_TOOL_NAMES.filter(
    (name) =>
      (name !== BUILTIN_TOOLS.browserSignIn || signIn) &&
      (name !== BUILTIN_TOOLS.browserScreenshot || modelAcceptsImages(bot.modelProvider, bot.modelId)),
  );
}

/**
 * The confined tools a bot's cell entry allows (`alsoAllow`, 07.8-08; WINDOWS #240): every `ocw_sandbox_*` tool while
 * the bot's Sandbox switch is on and every `ocw_browser_*` tool while its Browser switch is on, only while sandboxd is
 * configured. OpenClaw runs a plugin tool only when the agent entry allows it, and the cell-wide snapshot is computed
 * for no human, so the bot's own switch is the only fact it can use here. The organization switch, the kill state,
 * the resolver (modules, agent ∩ human) and the delivered tool list stay per-turn decisions (`turnPolicy`, every
 * confined route), so this list never widens what a turn may do: each turn narrows it (`toolsAllow`).
 */
export function confinedCellTools(
  caps: Pick<BotCapabilities, "sandbox" | "browser">,
  sandboxdConfigured: boolean,
): string[] {
  if (!sandboxdConfigured) return [];
  return [...(caps.sandbox ? SANDBOX_TOOL_NAMES : []), ...(caps.browser ? BROWSER_TOOL_NAMES : [])];
}

/**
 * Whether the API calls a catalog source's server itself through the connector proxy (07.4 D-01; 07.14 D-04): a
 * per-member connector or an organization-account server (`org_oauth`, `org_client_credentials`). Its tools are offered
 * under logical `<safe>__<tool>` names with `ocw_connector_list` / `ocw_connector_call`, and never in the cell-wide view
 * (they are not OpenClaw tools, and the credential never reaches the cell).
 */
function proxiedSource(source: CatalogSource): boolean {
  return source.sourceKind === "mcp" && source.authMode !== undefined && usesConnectorProxy(source.authMode);
}

/**
 * Whether a catalog source acts with the asking member's own account (07.4 D-01): a per-member connector only. Its tools
 * follow the member-account audience rule. The organization's account (07.14) is an organization resource: its tools
 * get the organization-resource checks of every other catalog tool (`shared_with_group`, `not_every_participant`).
 */
function memberAccountSource(source: CatalogSource): boolean {
  return source.sourceKind === "mcp" && source.authMode !== undefined && isPerMemberMode(source.authMode);
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
  /** The turn's human holds `work_session.create` (07.5-08); never in the cell-wide view (no human). */
  workZone = false,
  /**
   * The turn's human may propose automations here (07.6-12): `automation.create`, their one-person DM with the bot or a
   * channel they may post in, and a turn that does not start tainted; never in the cell-wide view (no human).
   */
  automations = false,
  /** The turn's message is in the thread of a card this bot watches with an update tool (07.6-14). */
  recordUpdate = false,
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
  // Work Zone proposals (07.5-08, D-03, P-08): only for a human who may start sessions (07.3's Work Zone module deny
  // removes them); the proposal routes re-decide everything, and Start runs the human start's checks.
  if (workZone) {
    add(BUILTIN_TOOLS.workZoneProjects, WORK_ZONE_PROJECTS_FLAGS);
    add(BUILTIN_TOOLS.startWorkZone, START_WORK_ZONE_FLAGS);
  }
  // Board cards (07.1-10, D-07): only on a board channel's turns; every other turn keeps exactly its tool list.
  if (board && conversationKind === "channel") add(BUILTIN_TOOLS.boardCard, BOARD_FLAGS);
  // Natural-language automations (07.6-12, D-02, D-07): a proposal card only this human confirms; the route re-decides
  // everything and refuses a tainted turn.
  if (automations) add(BUILTIN_TOOLS.automationPropose, AUTOMATION_PROPOSE_FLAGS);
  // Watched-record writes (07.6-14, D-07): only in a watched card's thread on a board, for the watch's bot; the route
  // re-decides everything (the record from the thread, the rules, approvals, taint) at call time.
  if (recordUpdate && board && conversationKind === "channel") {
    add(BUILTIN_TOOLS.recordUpdate, RECORD_UPDATE_FLAGS);
  }
  // Proxied connectors and keys (07.4-11, D-04, D-07, C-01; 07.14 D-04). A turn carries the proxied tools (per-member
  // connectors and organization-account servers) under their logical `<safe>__<tool>` names (for the gate) plus the
  // static tools that reach them; the cell-wide view (null kind) carries the static names only, never a logical name
  // (they are not OpenClaw tools).
  const cellWide = conversationKind === null;
  const memberTools: TurnToolFlags[] = [];
  for (const source of catalog) {
    if (!proxiedSource(source)) continue;
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
    if (cellWide && proxiedSource(source)) continue;
    for (const t of source.tools) {
      if (effectiveToolNames.has(`${source.sourceKind}:${source.sourceId}:${t.name}`)) {
        add(t.name, catalogFlags(source, t.sideEffecting));
      }
    }
  }
  return { tools, toolFlags };
}

/**
 * How many of a bot's usable catalog tools a channel turn cannot carry (`MAX_TURN_TOOLS`, after the platform tools
 * `assemble` adds first). The bot sheet shows it (`BotCapabilityView.toolsOverLimit`): a tool past the cap is never
 * offered, so the bot cannot call it. Turn-scoped extras (board, Work Zone, consult) can take a few more slots.
 */
export function toolsOverLimit(
  effective: BotCapabilityView["effective"],
  catalog: readonly CatalogSource[],
  usable: ReadonlySet<string>,
  keys: boolean,
): number {
  const offered = new Set(assemble(effective, "channel", catalog, usable, false, keys).tools);
  let over = 0;
  for (const source of catalog) {
    for (const t of source.tools) {
      if (usable.has(`${source.sourceKind}:${source.sourceId}:${t.name}`) && !offered.has(t.name)) over++;
    }
  }
  return over;
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
  /** The sandbox tools are offered (07.8-05): the turn carries `maxSandboxCalls`. */
  sandboxOffered: boolean;
  /** The bot's model reads images (`modelAcceptsImages`): what a listed image's access depends on (07.15 PD-04). */
  imageModel: boolean;
  /**
   * Phase 07.17.1.1.2 (D-04, PD-07): the bot may run long tasks (`loadTaskPolicy`'s rule over the policy this turn
   * already loaded). Adds no tool here; the task offer (07) is gated on it.
   */
  longTasks: boolean;
  /**
   * Code review IN-02: a task may start in the organization at all (`maxRunning` > 0). At 0 the start is never offered
   * (it could only answer `org_cap`); tasks already running keep their continue and finish.
   */
  longTaskStarts: boolean;
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
    /**
     * Offer the sandbox tools when `sandboxAvailable` allows them (07.8-05): delivery only, and only while sandboxd is
     * configured. The call-time re-decisions of the other routes never compute them; the sandbox routes decide each
     * call themselves.
     */
    sandbox?: boolean;
    /**
     * Phase 07.6 (D-12, P-22): an automation run's turn, with no person present. The browser family (a member's sign-in,
     * live control) is neither offered nor listed as withheld; the sandbox family is decided exactly as for any turn.
     */
    unattended?: boolean;
    /** Phase 07.6 (D-02): the turn starts tainted, so it is never offered `ocw_automation_propose`. */
    tainted?: boolean;
    /** Phase 07.6-14: the turn is in the thread of a card this bot watches with an update tool. */
    recordUpdate?: boolean;
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
  // 07.5-08: the human may start Work Zone sessions (the grain a proposal's Start needs), decided by the resolver.
  const workZone = (
    await perms.decide(tx, { kind: "user", userId: p.humanUserId }, "work_session.create", orgResource())
  ).allowed;
  const automations = await mayProposeAutomations(tx, perms, p);
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
      // audited choice covers that audience, so the group checks below do not apply). The organization's account
      // (07.14) is not a member's: it falls through to the organization-resource checks below.
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

  // Keychain (07.4-11, D-04, D-07): the keys this bot may use for this human (grant ∩ owner ∩ `vault.use`, the unit
  // audience being the resolver's unit-key precondition). The tx's user must be the turn's human: personal keys are
  // invisible to any other session (owner-only RLS), so a caller without it fails closed (personal keys absent), never
  // with another member's. Personal keys are the member's own account (the audience rule above). A unit key is used only
  // where the resolver allows `vault.use` on its unit to every reader of the conversation (07.4-12, WINDOWS #191: the
  // rule unit memory follows); organization keys serve every member. Without a conversation the readers are unknown:
  // unit keys fail closed.
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
      if (await unitAudienceAllows(tx, perms, key.unitId, await readersHere())) usable.push(key);
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
  const assembled = assemble(
    effective,
    p.conversationKind,
    catalog,
    allowed,
    p.board === true,
    usable.length > 0,
    workZone,
    automations,
    p.recordUpdate === true,
  );
  // Bot sandboxes (07.8-05, D-09, D-12, P-05) and browsers (07.8-14): offered only when the resolver grants
  // `sandbox.use` / `browser.use` to the bot acting for this human (07.3 module denies included), the organization
  // switch is on, the organization is not killed and the bot's own switch is on: the one decision `sandboxAvailable`
  // makes, asked again at every call. When only the organization's switch or its kill stands in the way of a bot whose
  // own switch is on, the turn says so (`withheld`), so the bot can tell people why (WINDOWS #248).
  let sandboxOffered = false;
  if (p.sandbox) {
    const families = [
      {
        kind: "sandbox" as const,
        tools: OFFERED_SANDBOX_TOOLS as readonly ConfinedToolName[],
        on: caps.sandbox,
      },
      {
        kind: "browser" as const,
        // D-11: a member's own sign-in follows 07.4's member-account rule (their private chat with the bot); a
        // browser session has no share, so a shared conversation never offers it.
        tools: offeredBrowserTools(
          row,
          member !== null &&
            memberAccountAllowed({
              scopeKind: member.scopeKind,
              aiChatShared: member.aiChatShared,
              hasShare: false,
            }),
        ) as readonly ConfinedToolName[],
        on: caps.browser,
      },
    ];
    // D-12: nobody is there to sign in or watch a browser on an unattended run turn.
    for (const family of p.unattended ? families.filter((f) => f.kind !== "browser") : families) {
      const available = await sandboxAvailable(
        tx,
        perms,
        { agentId: row.id, userId: p.humanUserId },
        family.kind,
      );
      if (!available.ok) {
        if (family.on && (available.reason === "killed" || available.reason === "sandbox_off")) {
          withhold(`ocw_${family.kind}_*`, available.reason);
        }
        continue;
      }
      for (const name of family.tools) {
        if (assembled.toolFlags[name] || assembled.tools.length >= MAX_TURN_TOOLS) continue;
        const { untrustedOutput, sideEffecting } = CONFINED_TOOL_FLAGS[name];
        assembled.tools.push(name);
        assembled.toolFlags[name] = { untrustedOutput, sideEffecting };
      }
    }
    sandboxOffered =
      assembled.tools.includes(BUILTIN_TOOLS.sandboxExec) ||
      assembled.tools.includes(BUILTIN_TOOLS.browserOpen);
  }
  // Per-tool approvals (07.5-11, D-01, D-04, APPROVE-01): every offered tool with an effective `always` or
  // `when_tainted` rule for (bot, human) is flagged, so the gate sends exactly those calls' arguments. One policy load
  // per turn computation; delivery and the call-time re-decision share it. The cell-wide view never calls this.
  const modes = await approvalModesFor(tx, { agentId: row.id, userId: p.humanUserId }, assembled.tools);
  for (const [tool, mode] of modes) {
    const flags = assembled.toolFlags[tool];
    if (flags) assembled.toolFlags[tool] = { ...flags, approval: mode };
  }
  return {
    effective,
    botName: row.name,
    dailyLimit: effectiveDailyLimit(row.scope, caps, policy),
    withheld,
    keys: { usable, memberAccount, unitAudience },
    sandboxOffered,
    imageModel: modelAcceptsImages(row.modelProvider, row.modelId),
    longTasks: taskPolicyFor({ scope: row.scope, caps, policy }).enabled,
    longTaskStarts: policy.tasks.maxRunning > 0,
    ...assembled,
  };
}

/**
 * Whether the turn's human may propose automations here (07.6-12, D-02, D-07): they hold `automation.create`, the turn
 * does not start tainted, and it is their one-person DM with the bot (`dm`) or a channel they may post in (a proposal
 * there delivers to that channel or its thread). Group DMs, shared DMs, AI chats and Work Zone sessions never offer it.
 */
async function mayProposeAutomations(
  tx: Tx,
  perms: PermissionService,
  p: { humanUserId: string; conversationKind: string; conversationId?: string | null; tainted?: boolean },
): Promise<boolean> {
  if (p.tainted) return false;
  if (p.conversationKind !== "dm" && p.conversationKind !== "channel") return false;
  const human = { kind: "user", userId: p.humanUserId } as const;
  if (!(await perms.decide(tx, human, "automation.create", orgResource())).allowed) return false;
  if (p.conversationKind === "dm") return true;
  // A channel's post right needs the channel: without it, fail closed.
  if (!p.conversationId) return false;
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, p.conversationId)).limit(1);
  if (conv?.kind !== "channel" || conv.archivedAt !== null) return false;
  const facts = await channelFacts(tx, conv, { kind: "user", id: p.humanUserId });
  return (await perms.decide(tx, human, "channel.post", channelResource(facts))).allowed;
}

/**
 * Phase 07.7 (D-04: channels only in v1): the conversation is a live channel, or a thread conversation of one. DMs,
 * group DMs, AI chats and Work Zone sessions never offer a consult.
 */
export async function inChannel(tx: Tx, conversationId: string): Promise<boolean> {
  const [conv] = await tx
    .select({
      kind: conversations.kind,
      parent: conversations.parentConversationId,
      archivedAt: conversations.archivedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv || conv.archivedAt !== null) return false;
  if (conv.kind === "channel") return true;
  if (conv.kind !== "thread" || !conv.parent) return false;
  const [parent] = await tx
    .select({ kind: conversations.kind, archivedAt: conversations.archivedAt })
    .from(conversations)
    .where(eq(conversations.id, conv.parent))
    .limit(1);
  return parent?.kind === "channel" && parent.archivedAt === null;
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
    ? {
        tools: turn.tools,
        toolFlags: turn.toolFlags,
        keys: turn.keys,
        withheld: turn.withheld,
        longTasks: turn.longTasks,
      }
    : {
        tools: [],
        toolFlags: {},
        keys: { usable: [], memberAccount: [], unitAudience: [] },
        withheld: [],
        longTasks: false,
      };
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
 * Whether the turn's message is in the thread of a card this bot watches with an update tool (07.6-14): one indexed
 * lookup (the message by id, the watch by its unique card). A mention in the card's thread, or a 07.5 re-run on an
 * approval card posted there, both have the card as thread root.
 */
async function inWatchedThread(tx: Tx, p: { messageId: string; agentId: string }): Promise<boolean> {
  const [row] = await tx
    .select({ id: watchedRecords.id })
    .from(messages)
    .innerJoin(
      watchedRecords,
      and(
        eq(watchedRecords.cardMessageId, sql`coalesce(${messages.threadId}, ${messages.id})`),
        eq(watchedRecords.conversationId, messages.conversationId),
      ),
    )
    .where(
      and(
        eq(messages.id, p.messageId),
        eq(watchedRecords.agentId, p.agentId),
        isNotNull(watchedRecords.writeTool),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The member-account rule's facts for a delivered turn (07.8-21): what `memberAccountAllowed` decides a member's own
 * browser sign-in and sealed session with (D-11), at call time. An AI chat is judged with its readers now
 * (`audienceOf`, passed by the caller); without them it counts as shared (fail closed).
 */
export async function memberAccountFacts(
  tx: Tx,
  p: { conversationId: string; conversationKind: string; agentId: string; humanUserId: string },
  audience: TurnAudience | null,
): Promise<{ scopeKind: string; aiChatShared: boolean | null }> {
  const facts = await memberAccountContext(tx, { ...p, audience });
  return { scopeKind: facts.scopeKind, aiChatShared: facts.aiChatShared };
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
    /**
     * Phase 07.6 (D-02, D-07, P-11): the turn starts tainted (`agent_turns.tainted` at insert): a run started by a webhook
     * or a mail, or any turn in a thread that holds inbound content. Side-effecting calls are refused from the first one.
     */
    taintedAtStart?: boolean;
    /** Phase 07.6 (D-12): an automation run's turn (no person present): never the browser tools. */
    unattended?: boolean;
    /**
     * Phase 07.7 (D-01, D-03): the turn's place in an agent chain, written to its `agent_turns` row. Absent = a turn
     * outside any chain (depth 0).
     */
    chain?: {
      chainId: string | null;
      depth: number;
      answeringHopId: string | null;
      returningHopId: string | null;
    } | null;
    /**
     * Phase 07.7 (D-04, D-08, D-09, P-05): the bots this turn may consult, decided by the caller with the canonical
     * `agent.message` decision. The turn is offered `ocw_consult_agent` (and `turn.consult`) only with at least one
     * target, below `A2A_MAX_DEPTH`, in a channel or a channel's thread, and when it does not start tainted.
     */
    consultTargets?: ConsultTarget[];
    /**
     * Phase 07.15 (D-02, PD-04): the ready attachment rows of the messages this turn reads (the current message's, then
     * the history window's newest first, each in upload order), already in listing order. Absent or empty = none.
     */
    attachments?: AttachmentRow[];
    /**
     * Phase 07.16 (D-05, D-21, PD-17): the Work Zone offer of this turn, computed by the caller (`workZoneOfferFor`;
     * bot-capabilities never imports work-session). Present = the six `ocw_work_session_*` tools (07.17.1.1 D-01) and
     * `turn.workZone`, when six tool slots remain. Absent or null = the turn is exactly what it was before the phase
     * (BWZ-06).
     */
    workZone?: TurnWorkZone | null;
    /**
     * Phase 07.17 (D-02, PD-07): the run this turn may open conversations for, computed by the caller
     * (`deliverAutomationRun`, for runs of fan-out automations only; bot-capabilities never imports automation). Present
     * = `ocw_conversation_open` with `CONVERSATION_OPEN_FLAGS`, when a tool slot remains. Absent or null = the turn is
     * exactly what it was before the phase (E9).
     */
    conversationOpen?: { automationId: string; runId: string } | null;
    /**
     * Phase 07.17.1.1.2 (D-02, PD-07): the turn's task offer, computed by the caller (`taskOfferFor`). Used only while
     * `computeTurn` says the bot may run long tasks (`longTasks`); absent, null or long tasks off = the turn is exactly
     * what it was before the phase (P5).
     */
    task?: TurnTaskOffer | null;
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
  const recordUpdate = board && (await inWatchedThread(tx, { messageId: p.messageId, agentId: p.agentId }));
  const computed = await computeTurn(
    tx,
    perms,
    // Sandbox tools only while sandboxd is configured (07.8-05): without it nothing could run them.
    {
      agentId: p.agentId,
      humanUserId: p.humanUserId,
      conversationId: p.conversationId,
      conversationKind: scopeKind,
      board,
      sandbox: core.env.OCW_SANDBOX_URL !== null,
      unattended: p.unattended === true,
      tainted: p.taintedAtStart === true,
      recordUpdate,
    },
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

  // Phase 07.7 (D-04, D-08, D-09): `ocw_consult_agent` is a turn-scoped tool, offered only where a consult can succeed
  // (the `mayProposeAutomations` rule): allowed targets, below the depth limit, a channel (or its thread), and a turn that
  // does not start tainted. The route re-decides every term at call time; the cell-wide view never lists it.
  const depth = p.chain?.depth ?? 0;
  const consultTargetsHere = p.consultTargets ?? [];
  const consult =
    consultTargetsHere.length > 0 &&
    depth < A2A_MAX_DEPTH &&
    p.taintedAtStart !== true &&
    computed.tools.length < MAX_TURN_TOOLS &&
    (await inChannel(tx, p.conversationId));
  if (consult && !computed.toolFlags[BUILTIN_TOOLS.consultAgent]) {
    computed.tools.push(BUILTIN_TOOLS.consultAgent);
    computed.toolFlags[BUILTIN_TOOLS.consultAgent] = CONSULT_FLAGS;
  }

  // Phase 07.15 (D-02, D-04, PD-03, PD-04): the files of the messages this turn reads, metadata only, with how this bot
  // can read each; `ocw_attachment_read` is a turn-scoped tool offered only when one of them reads, while object storage
  // is configured. The read route re-decides every call (the one row rule, the asker, the model, the budget).
  const files = await turnAttachments(tx, core, perms, p, computed);
  if (files.offerRead && !computed.toolFlags[BUILTIN_TOOLS.attachmentRead]) {
    computed.tools.push(BUILTIN_TOOLS.attachmentRead);
    computed.toolFlags[BUILTIN_TOOLS.attachmentRead] = ATTACHMENT_READ_FLAGS;
  }

  // Phase 07.16 (D-05, PD-17): the Work Zone session tools are turn-scoped, all or none: offered only with the caller's
  // offer and room for all of them. 07.17.1.1 (D-01): six, the four session tools then upload and download, so the
  // room counted is six slots. The routes re-decide every call (the live turn, the profile, the sponsor).
  // They replace the 07.5 proposal tools: offered both, the model kept proposing (a card the person had to start) and
  // told them it could not start sessions. The start route still falls back to a proposal after outside content.
  const proposalTools: readonly string[] = [BUILTIN_TOOLS.workZoneProjects, BUILTIN_TOOLS.startWorkZone];
  const kept = computed.tools.filter((name) => !proposalTools.includes(name)).length;
  const workZone = p.workZone && kept + WORK_SESSION_TOOL_NAMES.length <= MAX_TURN_TOOLS ? p.workZone : null;
  if (workZone) {
    for (const name of proposalTools) {
      const at = computed.tools.indexOf(name);
      if (at === -1) continue;
      computed.tools.splice(at, 1);
      delete computed.toolFlags[name];
    }
    for (const name of WORK_SESSION_TOOL_NAMES) {
      if (computed.toolFlags[name]) continue;
      computed.tools.push(name);
      computed.toolFlags[name] = WORK_SESSION_TOOL_FLAGS[name];
    }
  }

  // Phase 07.17 (D-02, PD-07): `ocw_conversation_open` is turn-scoped, offered only with the caller's offer (a fan-out
  // run). The route re-decides every call (the stored turn, its run, the automation, the caps under the automation
  // lock). Code review WR-07: it is the run turn's primary tool, so its slot is reserved: on a full turn the
  // lowest-priority tool (the last organization MCP tool offered, never a platform tool) gives its place. Only when no
  // such tool exists is the turn delivered without it (the run delivery audits `automation.fan_out_unavailable`).
  if (
    p.conversationOpen &&
    !computed.toolFlags[BUILTIN_TOOLS.conversationOpen] &&
    computed.tools.length >= MAX_TURN_TOOLS
  ) {
    const evict = computed.tools.findLastIndex((name) => !isPlatformTool(name));
    if (evict >= 0) {
      const [name] = computed.tools.splice(evict, 1);
      if (name) delete computed.toolFlags[name];
    }
  }
  if (
    p.conversationOpen &&
    !computed.toolFlags[BUILTIN_TOOLS.conversationOpen] &&
    computed.tools.length < MAX_TURN_TOOLS
  ) {
    computed.tools.push(BUILTIN_TOOLS.conversationOpen);
    computed.toolFlags[BUILTIN_TOOLS.conversationOpen] = CONVERSATION_OPEN_FLAGS;
  }

  // Phase 07.17.1.1.2 (D-02, D-04, PD-07; P3): the task tools come last, after everything else was decided for the asker,
  // so a task never widens a turn; all of the offer's tools or none. Code review WR-07: the start offer (on every
  // person's turn while long tasks are on) only takes free slots, so a full turn keeps every tool it was granted and
  // says why the start is missing (`turn_full`). A turn of a running task (control) makes room for continue and
  // finish, as the conversation-open rule does: the last non-platform tools give their places, each listed as
  // withheld `turn_full`, so the persona knows a granted tool is missing.
  const offered = computed.longTasks ? (p.task ?? null) : null;
  // Code review IN-02: no start where no task may run (`maxRunning` 0).
  const task = offered?.offer === "start" && !computed.longTaskStarts ? null : offered;
  if (task) {
    const missing = TASK_OFFER_TOOLS[task.offer].filter((name) => !computed.toolFlags[name]);
    const fits = computed.tools.length + missing.length <= MAX_TURN_TOOLS;
    const evictable = computed.tools.filter((name) => !isPlatformTool(name)).length;
    const makeRoom =
      task.offer === "control" && computed.tools.length - evictable + missing.length <= MAX_TURN_TOOLS;
    if (missing.length > 0 && (fits || makeRoom)) {
      while (computed.tools.length + missing.length > MAX_TURN_TOOLS) {
        const evict = computed.tools.findLastIndex((name) => !isPlatformTool(name));
        const [name] = computed.tools.splice(evict, 1);
        if (name) {
          delete computed.toolFlags[name];
          computed.withheld.push({ tool: name, reason: "turn_full" });
        }
      }
      for (const name of missing) {
        computed.tools.push(name);
        computed.toolFlags[name] = TASK_TOOL_FLAGS[name];
      }
    } else if (missing.length > 0 && task.offer === "start") {
      computed.withheld.push({ tool: BUILTIN_TOOLS.taskStart, reason: "turn_full" });
    }
  }

  const turn: TurnContext = {
    tools: computed.tools,
    toolFlags: computed.toolFlags,
    ...(consult
      ? {
          consult: {
            chainId: p.chain?.chainId ?? null,
            depth,
            targets: consultTargetsHere.slice(0, A2A_MAX_TARGETS),
          },
        }
      : {}),
    // D-09: the plugin starts its local taint from the server's.
    ...(p.taintedAtStart === true ? { tainted: true } : {}),
    memory,
    now: computed.effective.dateTime.effective ? turnNow(p.clientTimeZone) : null,
    maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
    maxWebCalls: MAX_WEB_CALLS_PER_TURN,
    // The separate budget of the sandbox calls (P-06), counted by the sandbox routes in `agent_turns.sandbox_calls`.
    ...(computed.sandboxOffered ? { maxSandboxCalls: MAX_SANDBOX_CALLS_PER_TURN } : {}),
    // The persona can tell people what it could not use here and why (06-10); never a reason to enable anything.
    // Member-account entries (07.4-11, R7) travel on every delivery, so the persona can offer the share link.
    ...(opts.audience || computed.withheld.length > 0 ? { withheld: computed.withheld } : {}),
    ...(memoryFiles.length > 0 ? { memoryFiles } : {}),
    ...(files.attachments.length > 0 ? { attachments: files.attachments } : {}),
    ...(files.more > 0 ? { attachmentsMore: files.more } : {}),
    ...(files.offerRead
      ? {
          maxAttachmentReads: ATTACHMENT_READ_LIMITS.readsPerTurn,
          maxAttachmentChars: ATTACHMENT_READ_LIMITS.charsPerTurn,
        }
      : {}),
    ...(workZone ? { workZone } : {}),
    // The task's facts on every turn of the bot in its thread (control and view); its notes travel here only (P4).
    ...(task?.task ? { task: task.task } : {}),
  };
  // 07.8-28 (WINDOWS #292, ADR-0029): a member's session loaded earlier by this bot in this conversation keeps its
  // member data for every later turn here (the bot's history may hold what it read signed in).
  const sticky = await stickyMemberData(tx, { agentId: p.agentId, conversationId: p.conversationId });
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
    tainted: p.taintedAtStart === true,
    ...(sticky ? { memberData: true } : {}),
    // Only the task's own turns are linked to it (PD-07): the routes accept a continue or finish from those alone.
    ...(task?.offer === "control" && task.taskId ? { taskId: task.taskId } : {}),
    // Phase 07.7 (D-01): the chain context, plain ledger ids (the consult route and the turn-done signal read them).
    ...(p.chain
      ? {
          chainId: p.chain.chainId,
          chainDepth: p.chain.depth,
          answeringHopId: p.chain.answeringHopId,
          returningHopId: p.chain.returningHopId,
        }
      : {}),
  });
  return { deliver: true, turn };
}

/** Conversation kinds whose turns read their messages' files (07.15 PD-03). */
const ATTACHMENT_KINDS = new Set(["channel", "thread", "dm", "group", "ai_chat"]);

/**
 * The attachments one delivered turn lists and whether it is offered `ocw_attachment_read` (07.15 D-02, PD-03, PD-04).
 * Nothing without rows, outside the conversation kinds above, or while object storage is not configured (nothing could
 * be read). `importCovered` is the import route's F-8 decision (`audienceCoverFacts` + `audienceCovers` with the chat's
 * readable set), loaded at most once and only when a file that cannot be read needs it.
 */
async function turnAttachments(
  tx: Tx,
  core: Core,
  perms: PermissionService,
  p: { agentId: string; conversationId: string; conversationKind: string; attachments?: AttachmentRow[] },
  computed: ComputedTurn,
): Promise<{ attachments: TurnAttachment[]; more: number; offerRead: boolean }> {
  const none = { attachments: [], more: 0, offerRead: false };
  const rows = p.attachments ?? [];
  if (rows.length === 0 || !ATTACHMENT_KINDS.has(p.conversationKind)) return none;
  if (!objectStorageConfigured(core.env, core.secretStore)) return none;
  let covered: Promise<boolean> | null = null;
  const importCovered = () => {
    covered ??= (async () => {
      const access = createConversationAccess(core);
      const isReadable = (t: Tx, userId: string, conversationId: string) =>
        access.isReadable(t, userId, conversationId, { kinds: ["channel", "dm", "group", "ai_chat"] });
      const facts = await audienceCoverFacts(
        tx,
        { perms, isReadable },
        { conversationId: p.conversationId, agentId: p.agentId },
      );
      return audienceCovers(facts);
    })();
    return covered;
  };
  const listed = await buildTurnAttachments(rows, {
    imageModel: computed.imageModel,
    importOffered: computed.tools.includes(BUILTIN_TOOLS.sandboxImport),
    importCovered,
  });
  const readable = listed.attachments.some((a) => a.access === "read");
  const offerRead =
    readable &&
    (computed.tools.length < MAX_TURN_TOOLS || computed.tools.includes(BUILTIN_TOOLS.attachmentRead));
  // IN-01: a full tool list leaves no slot for the read tool; the files then say so instead of `read`.
  if (readable && !offerRead)
    return { ...listed, attachments: withoutReadTool(listed.attachments), offerRead };
  return { ...listed, offerRead };
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
  env: SearchEnv & Pick<Env, "OCW_SANDBOX_URL">,
): Promise<Map<string, { tools: string[] }>> {
  const rows = await tx.select().from(agents).where(isNull(agents.deletedAt));
  const policy = await loadPolicy(tx);
  const configured = await internetConfigured(tx, env, policy);
  const catalog = await loadCatalog(tx);
  const grantsByAgent = await loadAllGrants(tx);
  // Agents holding a keychain grant (07.4-11): ids only. Grants on personal keys are owner-only in PostgreSQL
  // (WINDOWS #182), so this user-less session asks the definer function, which returns agent ids and nothing else.
  const keyHolders = new Set(
    (await tx.execute(sql`select agent_id from app.vault_grant_agents()`)).rows.map(
      (r) => (r as { agent_id: string }).agent_id,
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
          : [
              ...assemble(effective, null, catalog, names, false, keyHolders.has(row.id)).tools,
              ...confinedCellTools(caps, env.OCW_SANDBOX_URL !== null),
            ],
    });
  }
  return out;
}
