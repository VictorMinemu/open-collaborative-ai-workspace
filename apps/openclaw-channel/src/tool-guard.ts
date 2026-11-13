import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  type AgentChannelToolCallRequest,
  ATTACHMENT_READ_LIMITS,
  ATTACHMENT_READ_SENTENCES,
  BOT_TASK_SENTENCES,
  BOT_WORK_SESSION_SENTENCES,
  CONFINED_TOOL_FLAGS,
  CONNECTOR_SAFE_NAME,
  CONNECTOR_TOOL_LIMITS,
  isConfinedTool,
  SANDBOX_LIMITS,
  TOOL_APPROVAL_LIMITS,
  TOOL_APPROVAL_REFUSALS,
  type ToolApprovalRefusal,
  type TurnContext,
  type TurnToolFlags,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
// automation-tool.ts imports from this module too; the sentence is only called while a call runs (see the note there).
import { automationTaintedSentence } from "./automation-tool.js";
// connector-tools.ts imports from this module too; its sentences are only read while a call runs.
import { REFUSAL_SENTENCE } from "./connector-tools.js";
// consult-tool.ts imports from this module too; the sentence is only called while a call runs (as automation-tool.ts).
import { consultTaintedSentence } from "./consult-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
// record-tool.ts imports from this module too; the sentence is only called while a call runs (see the note there).
import { recordTaintedSentence } from "./record-tool.js";
// No imports of its own: safe to read while this module loads (work-session-tools.ts imports this module).
import {
  BOARD_TOOL_NAME,
  CONVERSATION_OPEN_TOOL,
  TASK_CONTINUE_TOOL,
  TASK_FINISH_TOOL,
  TASK_START_TOOL,
  TASK_TOOL_NAMES,
  WORK_SESSION_DOWNLOAD_TOOL,
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_START_TOOL,
  WORK_SESSION_STOP_TOOL,
  WORK_SESSION_TOOL_NAMES,
  WORK_SESSION_UPLOAD_TOOL,
  type WorkSessionToolName,
} from "./turn-scoped-tools.js";
// work-zone-tools.ts imports from this module too; the sentence is only called while a call runs (see the note there).
import { workZoneTaintedSentence } from "./work-zone-tools.js";

/**
 * The cell's call-time tool gate (D-08 guard 3), wired to OpenClaw's `before_tool_call` / `after_tool_call`
 * hooks (register-capabilities.ts, registered unscoped). The API decided the turn's tool set at delivery and stays the
 * authority at call time; this gate:
 *   - blocks any call when no OCW turn is active for the session (fail closed),
 *   - blocks tools outside `turn.tools`, over the per-turn caps, or side-effecting after untrusted output
 *     (taint) — locally first, which saves a round trip,
 *   - asks `POST /agent-channel/v1/tool-calls` for every call except `ocw_memory_save`, `ocw_memory_write`,
 *     `ocw_memory_propose`, `ocw_board_card`, the connector and keychain tools, the Work Zone tools and the 07.6
 *     `ocw_automation_propose` / `ocw_record_update` and the 07.7 `ocw_consult_agent` (validated by their own routes,
 *     `SELF_VALIDATED_TOOLS`) and blocks
 *     on a denial, an error or a
 *     timeout (fail closed, under OpenClaw's 15 s budget),
 *   - reports each allowed call's outcome (status, result count, provider, duration; never content).
 * Per-tool approvals (07.5 D-01, D-02, D-04): for a tool whose turn flags carry `approval` (and only for those) the
 * request also carries the call's full `arguments` (≤ 32 KB, else refused locally), the local taint block is skipped
 * (the API decides: approval, a grant or a denial), and every approval refusal is a fixed sentence returned at once
 * (`APPROVAL_SENTENCES`). Nothing here ever waits for a person: the approved call re-runs in a new turn.
 * Confined tools (07.8, D-11 F-7): the fifteen `ocw_sandbox_*` / `ocw_browser_*` tools are self-validated by their own
 * routes, take their static flags (`CONFINED_TOOL_FLAGS`; a turn's flags only ever add restrictions or an approval
 * mode), and count against their own per-turn budget (`turn.maxSandboxCalls`, 40), never the cap of 8.
 * Attachment reads (07.15 D-08, D-17): `ocw_attachment_read` is self-validated by `/attachments/read`, takes its static
 * flags (untrusted output, never side-effecting; a turn's flags only add restrictions), and counts against its own
 * per-turn budget (`turn.maxAttachmentReads`, 20), never the cap of 8.
 * Bot Work Zone sessions (07.16 D-08, D-20, PD-09, PD-15): `ocw_work_session_start|prompt|read|stop` are self-validated
 * by their own routes, take their static flags (never approvable), and count against the cap of 8. On a tainted turn
 * start, prompt and stop still reach their routes (`ROUTE_DECIDES_TAINT`: the route allows them with the profile's
 * outside-content flag or answers with a proposal). After a successful `ocw_work_session_read` (`sessionOutputRead`)
 * every other side-effecting call of the turn is refused here, except prompt and stop; start answers `session_output`.
 * Bot Work Zone files (07.17.1.1 D-01, D-02, D-10, D-11, PD-13): `ocw_work_session_upload|download` are self-validated
 * the same way, side-effecting, never approvable and counted against the cap of 8; on a tainted turn and after a
 * session read they still reach their routes, which decide with the profile's `actOnOutsideContent` and the
 * one-read-session rule.
 * Automation fan-out (07.17 D-02, D-05, PD-07): `ocw_conversation_open` is self-validated by `/conversations/open`,
 * takes its static flags (side-effecting, never approvable), counts against the cap of 8, and on a tainted run turn
 * still reaches its route, which decides outside content (the run read the MCP it fans out from).
 * Board moves (07.17 D-06, D-12, PD-11): `ocw_board_card` stays side-effecting and never approvable, but on a tainted
 * turn or after a session read it reaches its routes, which exempt only a move or waiting change of the turn thread's
 * card that this bot's automation opened, with the profile's `actOnOutsideContent`; the board tool itself refuses
 * create and read on such a turn (the routes refuse them too).
 * Long tasks (07.17.1.1.2 D-08, D-13, PD-08): `ocw_task_start|continue|finish` are self-validated by `/tasks/*`, take
 * their static flags (never side-effecting, never approvable: they only schedule this bot's own next turn for this
 * person, within the task's budgets), so a tainted or session-read turn still reaches the route; they are not counted
 * against the cap of 8 (a turn that used its calls can still continue), and each runs once per turn (a second call is
 * refused here with `once_per_turn`; a refusal the model can fix frees its slot once, `taskCallEnded`, and the API
 * bounds the calls per turn too, code review WR-06). The outcome of the
 * turn's task calls (`ActiveTurn.task`) is what the bridge reads after the run (quiet turns, silent task turns).
 * Logs never include params, arguments or results.
 */

/** 07.17.1.1.2 (PD-17): what this turn's task calls achieved (each set only by a successful answer). */
export type TaskTurnOutcome = {
  started: boolean;
  continued: boolean;
  finished: boolean;
  /** The continue answered `quiet: true` and no finish followed: the turn's text is not posted (PD-10). */
  quiet: boolean;
};

const noTaskOutcome = (): TaskTurnOutcome => ({
  started: false,
  continued: false,
  finished: false,
  quiet: false,
});

export interface ActiveTurn {
  eventId: string;
  agentId: string;
  /** The OCW conversation (OpenClaw's `nativeChannelId`): secondary lookup for tool factories. */
  conversationId?: string;
  /**
   * Where the turn's reply lands (06-14: `ocw_agent_card` posts there): the thread root, null in a flat conversation
   * (DM, AI chat); undefined when the caller did not say (the card tool then refuses).
   */
  threadRootId?: string | null;
  /** The message the turn answers (the reply's `inReplyToMessageId`). */
  messageId?: string;
  turn: TurnContext;
  /**
   * 07.4 (D-07): the turn's per-member logical connector tools `<connector>__<tool>` (mention-mapper.ts
   * `connectorTools`). `turn.tools` is the run's OpenClaw tools only; these are reachable through `ocw_connector_call`.
   */
  connectorTools: string[];
  /** 07.5: the asking human's display name (sanitized), for the approval sentences; absent → a neutral fallback. */
  requesterName?: string;
  calls: number;
  webCalls: number;
  /** 07.8: confined (sandbox and browser) calls this turn, against `turn.maxSandboxCalls`. */
  sandboxCalls: number;
  /** 07.15 (D-17): `ocw_attachment_read` calls this turn, against `turn.maxAttachmentReads`; never `calls`. */
  attachmentReads: number;
  tainted: boolean;
  /**
   * 07.16 (D-20, PD-15): a Work Zone session's output was read this turn (set by `ocw_work_session_read` on a read
   * answer). From then on every side-effecting call except `ocw_work_session_prompt` and `ocw_work_session_stop` is
   * refused locally, as the API's claim refuses it.
   */
  sessionOutputRead: boolean;
  /** 07.17.1.1.2 (PD-17): the turn's task outcome, set by the task tools through `taskCallEnded`. */
  task: TaskTurnOutcome;
  /** 07.17.1.1.2 (D-13): the task tools called (or in flight) this turn; each runs once per turn. */
  taskCalls: Set<string>;
  /** Code review WR-06: refused calls of each task tool this turn (at most `TASK_REFUSALS_PER_TOOL`, then no retry). */
  taskRefusals: Map<string, number>;
}

/** Code review WR-06: refused calls of one task tool a turn may make before its slot stays taken. */
const TASK_REFUSALS_PER_TOOL = 2;

/**
 * Code review WR-06: the refusals the model can fix by calling again (its params, the wait it named, an unreachable or
 * unreadable workspace answer). Every other code (the task ended, is busy or another person's, a budget, the policy,
 * the API's own once-per-turn bound) keeps the tool's slot taken for the rest of the turn.
 */
const FIXABLE_TASK_REFUSALS: ReadonlySet<string> = new Set([
  "bad_params",
  "extra_keys",
  "wait_unknown",
  "unreachable",
]);

export type ToolCallEvent = {
  toolName: string;
  params?: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
  result?: unknown;
  error?: unknown;
  durationMs?: number;
};

export type ToolCallContext = {
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
};

export type ToolBlock = { block: true; blockReason: string };

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };

export const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);
/**
 * Validated by their own routes, which check the turn, the tool on it and the taint, and count the call themselves:
 * `ocw_memory_save` (`POST /memories`, 03.1-07), `ocw_memory_write` / `ocw_memory_propose` (`/memory/write|propose`,
 * 07.2), `ocw_board_card` (`/board/*`, 07.1-10) and the connector and keychain tools (`/connectors/list|call`,
 * `/http-requests`, 07.4 D-07: the API re-decides the logical tool, the audience and the caps and taint, and audits each
 * call with the member's credential), and the Work Zone proposal tools (`/work-zone/projects|proposals`, 07.5-10: the
 * API re-decides the tool on the turn, the taint and the human's grains). Asking `/tool-calls` too would count the call
 * twice, and `/tool-calls` cannot offer the board tool (it does not know the board layout), so it would refuse it
 * `policy_changed`. `ocw_memory_list` / `ocw_memory_read` change nothing and go through the generic gate.
 */
const SELF_VALIDATED_TOOLS: ReadonlySet<string> = new Set([
  "ocw_memory_save",
  "ocw_memory_write",
  "ocw_memory_propose",
  "ocw_board_card",
  "ocw_connector_list",
  "ocw_connector_call",
  "ocw_http_request",
  "ocw_work_zone_projects",
  "ocw_start_work_zone",
  // 07.6: `/automations/propose` and `/records/update` re-decide the turn, the tool on it, the taint and (for a record
  // update) the 07.5 approval themselves.
  "ocw_automation_propose",
  "ocw_record_update",
  // 07.7 (ADR-0027): validated by `/consultations` (the claim, the decision, the chain guards); never `/tool-calls`.
  "ocw_consult_agent",
  // 07.15 (D-03, D-08, D-17): `/attachments/read` re-decides the turn, the tool on it and the file, claims the read on
  // its own budget and taints the turn itself; never `/tool-calls`.
  "ocw_attachment_read",
  // 07.16 (PD-09): `/work-sessions/start|prompt|read|stop` re-decide the turn, the tool on it, the bot's profile, the
  // caps and the outside-content rule, claim the call and audit it; never `/tool-calls` (it would count twice).
  ...WORK_SESSION_TOOL_NAMES,
  // 07.17 (PD-07): `/conversations/open` re-decides the turn, the tool on it, the automation, fan-out, the caps and the
  // outside-content rule, claims the call and audits it; never `/tool-calls` (it would count twice).
  CONVERSATION_OPEN_TOOL,
  // 07.17.1.1.2 (PD-08): `/tasks/start|continue|finish` re-decide the turn, the tool on it, the task, the requester,
  // the policy and the budgets, claim the call (not counted) and audit it; never `/tool-calls`.
  ...TASK_TOOL_NAMES,
]);
/** 07.17.1.1.2: the bot's own long-task tools (cap-exempt, once per turn, `TASK_TOOL_FLAGS`). */
const TASK_TOOLS: ReadonlySet<string> = new Set(TASK_TOOL_NAMES);
/** 07.16: the bot's own Work Zone session tools. */
const WORK_SESSION_TOOLS: ReadonlySet<string> = new Set(WORK_SESSION_TOOL_NAMES);
/**
 * Contracts `WORK_SESSION_TOOL_FLAGS`: start, prompt and stop act on a member's device; a read changes nothing and does
 * not taint the turn (its output sets `sessionOutputRead` instead, D-20). A turn's flags only add restrictions.
 */
const WORK_SESSION_FLAGS: Record<WorkSessionToolName, TurnToolFlags> = {
  ocw_work_session_start: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_prompt: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_read: { untrustedOutput: false, sideEffecting: false },
  ocw_work_session_stop: { untrustedOutput: false, sideEffecting: true },
  // 07.17.1.1 (D-01, PD-13): the upload writes into a member's working tree and the download posts a file into the
  // conversation; both answers are the platform's own ids, the size and the name the bot asked for (the bytes reach
  // the bot only through `ocw_attachment_read` on a later turn, which taints it).
  ocw_work_session_upload: { untrustedOutput: false, sideEffecting: true },
  ocw_work_session_download: { untrustedOutput: false, sideEffecting: true },
};
/**
 * 07.16 (D-08, PD-15, Pitfall 7): side-effecting, yet a tainted turn's call still reaches the route, because the route
 * decides taint for these: start and prompt run only with the profile's `actOnOutsideContent` (Full access then only on
 * an isolated server), otherwise start answers with a proposal a person reviews (the fallback a local block would
 * lose) and prompt is refused; stop is never blocked by taint (a bot may always end its own session). The API refuses
 * anyway when its rules say so (D-08). Every `ALWAYS_SIDE_EFFECTING` tool keeps its local block.
 */
const ROUTE_DECIDES_TAINT: ReadonlySet<string> = new Set([
  WORK_SESSION_START_TOOL,
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_STOP_TOOL,
  // 07.17.1.1 (D-02, D-10, PD-13): the route moves a file on a tainted turn only with the profile's
  // `actOnOutsideContent` (claimed with `outsideContent`, audited) and answers `outside_content` otherwise; a local
  // block would make that allowed path unreachable.
  WORK_SESSION_UPLOAD_TOOL,
  WORK_SESSION_DOWNLOAD_TOOL,
  // 07.17 (D-05, PD-10): the route allows the open on a tainted run turn (the run read the MCP it fans out from) and
  // only in the run's own target, which the stored turn names (never the model); it claims with `outsideContent`.
  CONVERSATION_OPEN_TOOL,
  // 07.17 (D-06, PD-11): the board routes exempt from taint only a move or waiting change of the turn thread's card that
  // this bot's automation opened, when the profile has `actOnOutsideContent`; everything else stays `tainted` there.
  // `create` (and the read) stays refused by the board tool itself on such a turn (board-tool.ts), never posted.
  BOARD_TOOL_NAME,
]);
/**
 * 07.16 (D-20): the only side-effecting calls a turn may still make after it read a session's output (07.17.1.1: the
 * file tools too, decided by their routes).
 */
const SESSION_OUTPUT_EXEMPT: ReadonlySet<string> = new Set([
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_STOP_TOOL,
  // 07.17.1.1 (D-11, PD-13): after a session read the route allows a move only for the one session the turn read
  // (`readOnly`) and answers `session_output` otherwise; the plugin does not know which session that was, so it asks.
  WORK_SESSION_UPLOAD_TOOL,
  WORK_SESSION_DOWNLOAD_TOOL,
]);
/**
 * 07.17 (D-12, PD-11): side-effecting calls that, after a session read, still reach their route, which decides the
 * session-output rule itself: only the board tool, whose routes exempt the same automation-opened card move (with the
 * profile flag) and refuse everything else; the board tool refuses create and read on such a turn before a request.
 */
const ROUTE_DECIDES_SESSION_OUTPUT: ReadonlySet<string> = new Set([BOARD_TOOL_NAME]);
/**
 * Contracts `CONVERSATION_OPEN_FLAGS` (07.17): it posts in the automation's target; the answer is the platform's own
 * ids, never outside content. A turn's flags only add restrictions.
 */
const CONVERSATION_OPEN_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/** 07.15: the read tool, counted on its own budget (`ActiveTurn.attachmentReads`). */
const ATTACHMENT_READ_TOOL = "ocw_attachment_read";
/** Contracts `ATTACHMENT_READ_FLAGS`: a read returns a person's file (untrusted) and changes nothing. */
const ATTACHMENT_READ_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
/**
 * 07.6 (D-04, D-07): side-effecting whatever flags a turn carries, but, unlike `ALWAYS_SIDE_EFFECTING`, a turn's 07.5
 * approval policy still lets a tainted turn's call reach its route, which decides (a person may approve the write).
 */
const SIDE_EFFECTING_WITH_APPROVAL: ReadonlySet<string> = new Set(["ocw_record_update"]);
/**
 * 07.1-13 / 07.17 (D-06): the board tool is side-effecting whatever flags a turn carries (changing shared board work
 * after untrusted content is the injection the taint rule exists for) and never approvable, but it is no longer
 * `ALWAYS_SIDE_EFFECTING`: its routes decide a tainted or session-read turn (`ROUTE_DECIDES_TAINT`,
 * `ROUTE_DECIDES_SESSION_OUTPUT`).
 */
const BOARD_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
/**
 * Always side-effecting, whatever flags a turn carries: writing memory after untrusted content is exactly the
 * injection the taint rule exists for (D-08, T-03.1-07-02, T-07.2-07-02). A memory
 * proposal is not here: a person approves it before anything is written, so a tainted turn may still propose (flagged by
 * the API). A Work Zone proposal is (07.5 D-03, APPROVE-04): it would run code on a member's device, so a turn that read
 * untrusted content never proposes one, even with a person's click still to come. An automation proposal is too (07.6
 * D-02): outside content must never schedule work that runs as a person, whatever a turn's approval flag says.
 */
const ALWAYS_SIDE_EFFECTING: ReadonlySet<string> = new Set([
  "ocw_memory_save",
  "ocw_memory_write",
  "ocw_start_work_zone",
  "ocw_automation_propose",
  // 07.7 (ADR-0027): validated by `/consultations`; a consult after untrusted content is the injection the taint rule
  // exists for.
  "ocw_consult_agent",
]);
/** Unknown flags are treated as the most dangerous combination. */
const UNKNOWN_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };
/**
 * The connector and keychain tools' local flags (07.4 D-07) never come from the static tool: `ocw_connector_call` takes
 * the LOGICAL tool's (`turn.toolFlags[<connector>__<tool>]`, unknown → UNKNOWN_FLAGS), `ocw_http_request` its method's
 * (GET/HEAD read, any other method writes; the response is always untrusted), and `ocw_connector_list` reads the
 * workspace's own catalog (never side-effecting, so it stays allowed on a tainted turn). The API re-decides all of it.
 */
const CONNECTOR_LIST_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
const LISTED_CONNECTORS_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
const HTTP_READ_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: false };
const HTTP_WRITE_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };
const HTTP_READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

type Pending = { callId: string; tool: string; startedAt: number };
/** 07.5: the params the API checked for an allowed flagged call, until the pin hands them to OpenClaw (or the turn ends). */
type Pinned = { session: string; params: Record<string, unknown> };

export type ToolGuardState = {
  turns: Map<string, ActiveTurn>;
  pending: Map<string, Pending>;
  /** Keyed by `pinKey(session, toolCallId)`. */
  pinned: Map<string, Pinned>;
  client: AgentChannelClient | null;
};

export function createToolGuardState(): ToolGuardState {
  return { turns: new Map(), pending: new Map(), pinned: new Map(), client: null };
}

function block(reason: string): ToolBlock {
  return { block: true, blockReason: reason };
}

const keyOf = (sessionKey: string | undefined) => (sessionKey ?? "").trim().toLowerCase();
const pinKey = (session: string, toolCallId: string) => `${session}\u0000${toolCallId}`;

/** The turn's own spelling of a tool name OpenClaw reports case-folded; the reported name when none matches. */
export function canonicalToolName(turnTools: readonly string[], reported: string): string {
  if (turnTools.includes(reported)) return reported;
  const folded = reported.trim().toLowerCase();
  const hits = turnTools.filter((t) => t.toLowerCase() === folded);
  // Two turn tools that differ only by case are ambiguous: keep the reported name (not in the turn → blocked).
  return hits.length === 1 ? (hits[0] as string) : reported;
}

/**
 * The logical tool `<connector>__<tool>` an `ocw_connector_call` names, in the turn's own spelling (`connectorTools`,
 * the turn's logical connector tools), or why the params are invalid.
 */
export function logicalToolOf(
  connectorTools: readonly string[],
  params: Record<string, unknown> | undefined,
): { logical: string; connector: string; tool: string } | { error: string } {
  const connector = typeof params?.connector === "string" ? params.connector.trim() : "";
  if (!CONNECTOR_SAFE_NAME.test(connector)) {
    return { error: "connector must be a connector id from ocw_connector_list, like m1a2b3c4d." };
  }
  const tool = typeof params?.tool === "string" ? params.tool.trim() : "";
  if (!tool || tool.length > CONNECTOR_TOOL_LIMITS.toolChars) {
    return { error: "tool must name one of the connector's tools from ocw_connector_list." };
  }
  const logical = canonicalToolName(connectorTools, `${connector}__${tool}`);
  return { logical, connector, tool: logical.slice(connector.length + 2) };
}

/** The flags the gate checks a call with, or why it is blocked (07.4: per logical tool and per method). */
function callFlags(
  t: ActiveTurn,
  tool: string,
  params: Record<string, unknown> | undefined,
): TurnToolFlags | ToolBlock {
  if (tool === "ocw_connector_list") {
    // Never side-effecting (allowed on a tainted turn), but untrusted once it lists per-member connectors: their tool
    // descriptions are third-party text, so the API taints the turn and the local gate follows (WINDOWS #192).
    return t.turn.toolFlags[tool]?.untrustedOutput === true ? LISTED_CONNECTORS_FLAGS : CONNECTOR_LIST_FLAGS;
  }
  if (tool === "ocw_connector_call") {
    const named = logicalToolOf(t.connectorTools, params);
    if ("error" in named || !t.connectorTools.includes(named.logical)) {
      return block(`Tool ${tool} blocked: that connector tool is not allowed on this turn.`);
    }
    return t.turn.toolFlags[named.logical] ?? UNKNOWN_FLAGS;
  }
  if (isConfinedTool(tool)) {
    // 07.8 (D-11 F-7): the static flags, made stricter (never looser) by the turn's; its approval mode passes through.
    const base = CONFINED_TOOL_FLAGS[tool];
    const delivered = t.turn.toolFlags[tool];
    return {
      untrustedOutput: base.untrustedOutput || delivered?.untrustedOutput === true,
      sideEffecting: base.sideEffecting || delivered?.sideEffecting === true,
      ...(delivered?.approval ? { approval: delivered.approval } : {}),
    };
  }
  if (tool === ATTACHMENT_READ_TOOL) {
    // 07.15 (D-08): the static flags, made stricter (never looser) by the turn's. Never approvable (PD-08), so a turn's
    // approval mode is ignored.
    const delivered = t.turn.toolFlags[tool];
    return {
      untrustedOutput: ATTACHMENT_READ_FLAGS.untrustedOutput || delivered?.untrustedOutput === true,
      sideEffecting: ATTACHMENT_READ_FLAGS.sideEffecting || delivered?.sideEffecting === true,
    };
  }
  if (WORK_SESSION_TOOLS.has(tool)) {
    // 07.16 (PD-09): the static flags, made stricter (never looser) by the turn's. Never approvable, so a turn's approval
    // mode is ignored.
    const base = WORK_SESSION_FLAGS[tool as WorkSessionToolName];
    const delivered = t.turn.toolFlags[tool];
    return {
      untrustedOutput: base.untrustedOutput || delivered?.untrustedOutput === true,
      sideEffecting: base.sideEffecting || delivered?.sideEffecting === true,
    };
  }
  if (tool === BOARD_TOOL_NAME) {
    // 07.17 (D-06): side-effecting whatever the turn says, never approvable; a turn's flags only add untrusted output.
    return {
      untrustedOutput: BOARD_FLAGS.untrustedOutput || t.turn.toolFlags[tool]?.untrustedOutput === true,
      sideEffecting: true,
    };
  }
  if (tool === CONVERSATION_OPEN_TOOL) {
    // 07.17 (PD-07): the static flags, made stricter (never looser) by the turn's. Never approvable, so a turn's approval
    // mode is ignored.
    const delivered = t.turn.toolFlags[tool];
    return {
      untrustedOutput: CONVERSATION_OPEN_FLAGS.untrustedOutput || delivered?.untrustedOutput === true,
      sideEffecting: CONVERSATION_OPEN_FLAGS.sideEffecting || delivered?.sideEffecting === true,
    };
  }
  if (TASK_TOOLS.has(tool)) {
    // 07.17.1.1.2 (D-08, D-13): never side-effecting and never approvable, whatever a turn's flags say (the route
    // decides, PD-08); a turn's flags may only add untrusted output (taint).
    return { untrustedOutput: t.turn.toolFlags[tool]?.untrustedOutput === true, sideEffecting: false };
  }
  if (tool === "ocw_http_request") {
    const method = typeof params?.method === "string" ? params.method.trim().toUpperCase() : "";
    const flags = HTTP_READ_METHODS.has(method) ? HTTP_READ_FLAGS : HTTP_WRITE_FLAGS;
    // 07.5: an approval policy on the keychain tool itself routes a tainted write to a person (the API decides).
    const approval = t.turn.toolFlags[tool]?.approval;
    return approval ? { ...flags, approval } : flags;
  }
  return t.turn.toolFlags[tool] ?? UNKNOWN_FLAGS;
}

/** Only the search query / fetched URL travel (domain audit); never any other argument. */
function pickParams(params: Record<string, unknown> | undefined): AgentChannelToolCallRequest["params"] {
  const out: AgentChannelToolCallRequest["params"] = {};
  if (typeof params?.query === "string") out.query = params.query.slice(0, 500);
  if (typeof params?.url === "string") out.url = params.url.slice(0, 2000);
  return out;
}

function argsBytes(params: Record<string, unknown> | undefined): number {
  try {
    return Math.min(1_000_000, JSON.stringify(params ?? {}).length);
  } catch {
    return 0;
  }
}

/** UTF-8 bytes of the serialized params, or undefined when they cannot be serialized as JSON. */
function jsonBytes(params: Record<string, unknown> | undefined): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(params ?? {}) ?? "").length;
  } catch {
    return undefined;
  }
}

/**
 * A name or label the API composed from human-chosen names, shown to the model inside a fixed sentence: one line, no
 * invisible or structural characters, bounded. Undefined when nothing is left.
 */
export function approvalLabel(value: string | null | undefined, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = Array.from(value, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return " ";
    // Zero-width, bidi controls and isolates: invisible in a sentence, never meaningful in a name.
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      return "";
    return ch === "<" || ch === ">" || ch === "`" ? "" : ch;
  })
    .join("")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, max)
    .trim();
  return flat || undefined;
}

const ASKER = "the person who asked";
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type ApprovalSentenceInput = {
  tool: string;
  /** The approver label from the API ("a lead of Sales"). */
  waitingFor?: string | null | undefined;
  /** The requester's display name (the decision's, else the turn's). */
  requesterName?: string | null | undefined;
  /** 07.5-11: who denied exactly this action and their own note (`approval_denied`), from the API's decision. */
  denial?: { deciderName?: string | null; note?: string | null } | null | undefined;
};

/** The longest decider note the model is shown (contracts `APPROVAL_NOTE_MAX`). */
const NOTE_MAX = 280;
export type ApprovalSentenceKey = ToolApprovalRefusal | "too_large_local" | "no_call_id";

/**
 * What the model reads for each approval outcome (07.5-UI-SPEC "What the agent says while it waits", R10): fixed
 * sentences returned at once, never the API's text, never the arguments. Names are sanitized; a missing requester is
 * "the person who asked".
 */
export const APPROVAL_SENTENCES: Record<ApprovalSentenceKey, (p: ApprovalSentenceInput) => string> = {
  approval_required: (p) =>
    `This action needs approval. I posted a card and asked ${approvalLabel(p.waitingFor, 200) ?? "an approver"}. ` +
    `Tell ${approvalLabel(p.requesterName) ?? ASKER} in one short sentence that you are waiting for that approval, ` +
    `without repeating the values. Don't call ${p.tool} again now: when it is approved you will get a new message ` +
    "with the exact arguments.",
  approval_pending: (p) =>
    "This exact action is already waiting for approval in a card. Don't ask again; tell " +
    `${approvalLabel(p.requesterName) ?? ASKER} it is still waiting.`,
  approval_denied: (p) => {
    // 07.5-11: the decider by name when the API says who it was, and their note quoted (one line, bounded).
    const decider =
      approvalLabel(p.denial?.deciderName, 200) ?? approvalLabel(p.waitingFor, 200) ?? "an approver";
    const note = approvalLabel(p.denial?.note, NOTE_MAX);
    return (
      `${capitalized(decider)} denied this exact action.${note ? ` Their note: “${note}”.` : ""} Don't retry it. ` +
      `Tell ${approvalLabel(p.requesterName) ?? ASKER} it was denied and ask what to change.`
    );
  },
  approval_used: (p) =>
    `That approval was already used once. Ask ${approvalLabel(p.requesterName) ?? ASKER} if they want to run it again.`,
  arguments_too_large: (p) =>
    `This action is too large to approve (over 32 KB). Ask ${approvalLabel(p.requesterName) ?? ASKER} to split it.`,
  too_large_local: (p) => APPROVAL_SENTENCES.arguments_too_large(p),
  arguments_invalid: () =>
    "This action can't be approved because its values aren't valid JSON. Try again with plain values.",
  too_many_pending: (p) =>
    `${capitalized(approvalLabel(p.requesterName) ?? ASKER)} already has ${TOOL_APPROVAL_LIMITS.pendingPerRequester} ` +
    "actions waiting for approval from you. Wait for those first.",
  policy_changed: (p) => `Tool ${p.tool} blocked by the workspace policy (policy_changed).`,
  no_call_id: (p) =>
    `Tool ${p.tool} blocked: this action needs approval, but the call has no id to bind the approval to (fail closed).`,
};

const APPROVAL_REFUSAL_SET: ReadonlySet<string> = new Set(TOOL_APPROVAL_REFUSALS);
/** An API refusal code that has its own approval sentence (`policy_changed` keeps each caller's generic text). */
export function isApprovalRefusal(
  code: string | null | undefined,
): code is Exclude<ToolApprovalRefusal, "policy_changed"> {
  return typeof code === "string" && code !== "policy_changed" && APPROVAL_REFUSAL_SET.has(code);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Count / provider / final URL of a tool result, from its structured details or JSON text (never content). */
export function resultFacts(result: unknown): { resultCount?: number; provider?: string; finalUrl?: string } {
  const candidates: Record<string, unknown>[] = [];
  const top = asRecord(result);
  if (top) {
    candidates.push(top);
    const details = asRecord(top.details);
    if (details) candidates.push(details);
    if (Array.isArray(top.content)) {
      for (const part of top.content) {
        const text = asRecord(part)?.text;
        if (typeof text !== "string" || !text.trimStart().startsWith("{")) continue;
        try {
          const parsed = asRecord(JSON.parse(text));
          if (parsed) candidates.push(parsed);
        } catch {
          /* not JSON */
        }
      }
    }
  }
  const facts: { resultCount?: number; provider?: string; finalUrl?: string } = {};
  for (const c of candidates) {
    if (facts.resultCount === undefined) {
      if (typeof c.count === "number" && Number.isInteger(c.count) && c.count >= 0)
        facts.resultCount = c.count;
      else if (Array.isArray(c.results)) facts.resultCount = c.results.length;
    }
    if (facts.provider === undefined) {
      const provider = c.provider ?? asRecord(c.externalContent)?.provider;
      if (typeof provider === "string" && provider.length <= 64) facts.provider = provider;
    }
    if (facts.finalUrl === undefined && typeof c.finalUrl === "string" && c.finalUrl.length <= 2000) {
      facts.finalUrl = c.finalUrl;
    }
  }
  return facts;
}

export function createToolGuard(
  deps: { client: () => AgentChannelClient | null; timeoutMs?: number; log?: Logger },
  state: ToolGuardState = createToolGuardState(),
) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const log = () => deps.log ?? {};
  const dropPins = (session: string) => {
    for (const [k, pin] of state.pinned) if (pin.session === session) state.pinned.delete(k);
  };

  return {
    timeoutMs,

    /** Starts the active turn of a session (right before dispatch). Aborting `signal` ends it. */
    beginTurn(
      sessionKey: string,
      t: {
        eventId: string;
        agentId: string;
        turn: TurnContext;
        conversationId?: string;
        threadRootId?: string | null;
        messageId?: string;
        connectorTools?: string[];
        requesterName?: string;
        /** 07.6: the turn read outside content before its first call (a webhook or mail run): tainted from the start. */
        tainted?: boolean;
      },
      signal?: AbortSignal,
    ): void {
      const key = keyOf(sessionKey);
      const { tainted, ...rest } = t;
      state.turns.set(key, {
        ...rest,
        connectorTools: t.connectorTools ?? [],
        calls: 0,
        webCalls: 0,
        sandboxCalls: 0,
        attachmentReads: 0,
        tainted: tainted === true,
        sessionOutputRead: false,
        task: noTaskOutcome(),
        taskCalls: new Set(),
        taskRefusals: new Map(),
      });
      signal?.addEventListener(
        "abort",
        () => {
          if (state.turns.get(key)?.eventId === t.eventId) {
            state.turns.delete(key);
            dropPins(key);
          }
        },
        { once: true },
      );
    },

    /** Ends the session's turn: any later call for it is blocked, and its unused pins are dropped. */
    endTurn(sessionKey: string): void {
      const key = keyOf(sessionKey);
      state.turns.delete(key);
      dropPins(key);
    },

    activeTurn(sessionKey: string): ActiveTurn | undefined {
      return state.turns.get(keyOf(sessionKey));
    },

    /**
     * 07.17.1.1.2 (D-13, PD-17): a task tool's call ended. A successful answer records the turn's task outcome (a
     * finish always posts, so it clears a quiet continue of the same turn). Code review WR-06: a refusal the model can
     * fix (its params, a wait it named, the workspace unreachable) frees the tool's once-per-turn slot once, so it may
     * try again; a second refusal, or one that says the task cannot go on this turn, keeps the slot taken.
     */
    taskCallEnded(
      t: ActiveTurn,
      tool: string,
      outcome: { ok: true; quiet?: boolean } | { ok: false; code: string },
    ): void {
      if (!outcome.ok) {
        const refusals = (t.taskRefusals.get(tool) ?? 0) + 1;
        t.taskRefusals.set(tool, refusals);
        if (refusals < TASK_REFUSALS_PER_TOOL && FIXABLE_TASK_REFUSALS.has(outcome.code)) {
          t.taskCalls.delete(tool);
        }
        return;
      }
      t.taskCalls.add(tool);
      if (tool === TASK_START_TOOL) t.task.started = true;
      else if (tool === TASK_CONTINUE_TOOL) {
        t.task.continued = true;
        t.task.quiet = outcome.quiet === true && !t.task.finished;
      } else if (tool === TASK_FINISH_TOOL) {
        t.task.finished = true;
        t.task.quiet = false;
      }
    },

    /**
     * The active turn a tool runs in: by session key when the tool context carries it, otherwise by the
     * conversation (`nativeChannelId`), only when exactly one turn of that bot is active there. An OpenClaw
     * agent id that is not the turn's bot never resolves (fail closed).
     */
    findTurn(ctx: {
      sessionKey?: string;
      nativeChannelId?: string;
      agentId?: string;
    }): ActiveTurn | undefined {
      const sameBot = (t: ActiveTurn) =>
        !ctx.agentId || ctx.agentId.toLowerCase() === openClawAgentIdFor(t.agentId);
      if (ctx.sessionKey?.trim()) {
        const t = state.turns.get(keyOf(ctx.sessionKey));
        return t && sameBot(t) ? t : undefined;
      }
      if (!ctx.nativeChannelId) return undefined;
      const hits = [...state.turns.values()].filter(
        (t) => t.conversationId === ctx.nativeChannelId && sameBot(t),
      );
      return hits.length === 1 ? hits[0] : undefined;
    },

    async beforeToolCall(event: ToolCallEvent, ctx: ToolCallContext): Promise<ToolBlock | undefined> {
      const t = state.turns.get(keyOf(ctx.sessionKey));
      if (!t) return block(`Tool ${event.toolName} blocked: no active OCW turn for this session.`);
      // OpenClaw hands the hook a lower-cased policy name (`normalizeToolPolicyName`), while MCP tools keep the
      // server's casing (`m…__getFile`): resolve to the turn's exact name, the one the API decides on.
      const tool = canonicalToolName(t.turn.tools, event.toolName);
      if (ctx.agentId && ctx.agentId.toLowerCase() !== openClawAgentIdFor(t.agentId)) {
        return block(`Tool ${tool} blocked: the session belongs to another bot.`);
      }
      if (!t.turn.tools.includes(tool)) return block(`Tool ${tool} is not allowed on this turn.`);
      const delivered = callFlags(t, tool, event.params);
      if ("block" in delivered) return delivered;
      const flags =
        ALWAYS_SIDE_EFFECTING.has(tool) || SIDE_EFFECTING_WITH_APPROVAL.has(tool)
          ? { ...delivered, sideEffecting: true }
          : delivered;
      const web = WEB_TOOLS.has(tool);
      // 07.8: the confined tools have their own budget (D-11 F-7); the API counts and refuses `budget_exhausted` too.
      const confined = isConfinedTool(tool);
      const maxConfined = t.turn.maxSandboxCalls ?? SANDBOX_LIMITS.callsPerTurn;
      if (confined && t.sandboxCalls >= maxConfined) {
        return block(
          `Tool ${tool} blocked: this turn reached its limit of ${maxConfined} sandbox and browser calls.`,
        );
      }
      // 07.15 (D-17, Pitfall 2): reads have their own budget; the API counts and refuses `cap_reached` too.
      const attachmentRead = tool === ATTACHMENT_READ_TOOL;
      const maxReads = t.turn.maxAttachmentReads ?? ATTACHMENT_READ_LIMITS.readsPerTurn;
      if (attachmentRead && t.attachmentReads >= maxReads) {
        return block(ATTACHMENT_READ_SENTENCES.cap_reached);
      }
      // 07.17.1.1.2 (D-13): the task tools are not counted, so a turn that used its 8 calls can still continue.
      const taskTool = TASK_TOOLS.has(tool);
      if (!confined && !attachmentRead && !taskTool && t.calls >= t.turn.maxToolCalls) {
        return block(
          `Tool ${tool} blocked: the turn reached its limit of ${t.turn.maxToolCalls} tool calls.`,
        );
      }
      if (web && t.webCalls >= t.turn.maxWebCalls) {
        return block(`Tool ${tool} blocked: the turn reached its limit of ${t.turn.maxWebCalls} web calls.`);
      }
      // 07.5 (D-04): a tool with an approval policy is decided by the API after taint (a person approves, or a grant
      // is used); the memory tools keep their local block whatever a turn says, and the board, session and open tools
      // are never approvable (their flags carry no approval: `callFlags`).
      const approval =
        ALWAYS_SIDE_EFFECTING.has(tool) || WORK_SESSION_TOOLS.has(tool) ? undefined : flags.approval;
      const taintedBlock = (): ToolBlock => {
        // 07.5-10: the proposal's refusal is the UI-SPEC sentence the model relays (R10).
        if (tool === "ocw_start_work_zone") return block(workZoneTaintedSentence(t.requesterName));
        // 07.6: the UI-SPEC's model-facing sentence for a proposal after outside content.
        if (tool === "ocw_automation_propose") return block(automationTaintedSentence(t.requesterName));
        if (tool === "ocw_record_update") return block(recordTaintedSentence(t.requesterName));
        // 07.7: the consult route's own sentence for a tainted turn.
        if (tool === "ocw_consult_agent") return block(consultTaintedSentence(t.requesterName));
        // 07.8: `ocw_sandbox_share` (and an act the API flags) reads the 07.4 sentence its route would answer.
        if (confined) return block(REFUSAL_SENTENCE.tainted);
        return block(
          `Tool ${tool} blocked: this turn is read-only after untrusted content (web or tool output) was read.`,
        );
      };
      if (flags.sideEffecting && !approval) {
        // 07.16 (D-20): after a session's output only prompt and stop act; start reads the route's own sentence.
        // 07.17 (D-12): the board routes decide that rule for the board tool.
        if (
          t.sessionOutputRead &&
          !SESSION_OUTPUT_EXEMPT.has(tool) &&
          !ROUTE_DECIDES_SESSION_OUTPUT.has(tool)
        ) {
          if (tool === WORK_SESSION_START_TOOL) return block(BOT_WORK_SESSION_SENTENCES.session_output);
          return taintedBlock();
        }
        // 07.16 (D-08): start, prompt and stop reach their routes, which decide outside content themselves; so do the
        // 07.17 open tool (D-05) and the board tool (D-06).
        if (t.tainted && !ROUTE_DECIDES_TAINT.has(tool)) return taintedBlock();
      }
      const selfValidated = confined || SELF_VALIDATED_TOOLS.has(tool);
      // The arguments a flagged call is decided on (the API canonicalizes them; the connector tools send their own).
      const sentence = { tool, requesterName: t.requesterName };
      const approvalArgs = approval && !selfValidated ? (event.params ?? {}) : undefined;
      // The id the approved params are pinned under (Pitfall 3): without one the pin cannot hold, so the call is blocked.
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (approvalArgs) {
        const bytes = jsonBytes(approvalArgs);
        if (bytes === undefined) return block(APPROVAL_SENTENCES.arguments_invalid(sentence));
        if (bytes > TOOL_APPROVAL_LIMITS.argumentsBytes)
          return block(APPROVAL_SENTENCES.too_large_local(sentence));
        if (!callId) return block(APPROVAL_SENTENCES.no_call_id(sentence));
      }
      // 07.17.1.1.2 (T-07.17.1.1.2-05-02): once each per turn, reserved before the tool runs so two concurrent calls
      // cannot both pass; the tool frees the slot when its call did not succeed.
      if (taskTool) {
        if (t.taskCalls.has(tool)) return block(BOT_TASK_SENTENCES.once_per_turn);
        t.taskCalls.add(tool);
      }
      // Count before awaiting the API so concurrent calls of one turn can never exceed the caps.
      if (confined) t.sandboxCalls++;
      else if (attachmentRead) t.attachmentReads++;
      else if (!taskTool) t.calls++;
      if (web) t.webCalls++;

      if (!selfValidated) {
        const client = deps.client();
        if (!client) return block(`Tool ${tool} blocked: the OCW tool gate is not connected (fail closed).`);
        let decision: Awaited<ReturnType<AgentChannelClient["authorizeToolCall"]>>;
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          decision = await Promise.race([
            client.authorizeToolCall(
              {
                eventId: t.eventId,
                agentId: t.agentId,
                tool,
                ...(approvalArgs && callId
                  ? { toolCallId: callId.slice(0, 200) }
                  : event.toolCallId
                    ? { toolCallId: event.toolCallId.slice(0, 200) }
                    : {}),
                params: pickParams(event.params),
                argsBytes: argsBytes(event.params),
                // D-01: only a flagged tool's arguments ever leave the cell (structural: no key otherwise).
                ...(approvalArgs ? { arguments: approvalArgs } : {}),
              },
              signal,
              timeoutMs,
            ),
            // Belt and braces: a client that ignores the signal still cannot hold the call open.
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("tool gate timeout")), timeoutMs + 50);
            }),
          ]);
        } catch (error) {
          log().warn?.(
            `tool gate: ${tool} for ${t.eventId} blocked, API unavailable (${error instanceof Error ? error.name : "error"})`,
          );
          return block(`Tool ${tool} blocked: the OCW tool gate did not answer (fail closed).`);
        } finally {
          clearTimeout(timer);
        }
        if (!decision.allowed) {
          log().info?.(`tool gate: ${tool} for ${t.eventId} denied (${decision.reason ?? "denied"})`);
          if (isApprovalRefusal(decision.reason)) {
            return block(
              APPROVAL_SENTENCES[decision.reason]({
                tool,
                waitingFor: decision.approval?.waitingFor,
                requesterName: approvalLabel(decision.approval?.requesterName) ?? t.requesterName,
                denial: decision.denial,
              }),
            );
          }
          return block(`Tool ${tool} blocked by the workspace policy (${decision.reason ?? "denied"}).`);
        }
        if (event.toolCallId) {
          state.pending.set(event.toolCallId, { callId: decision.callId, tool, startedAt: Date.now() });
        }
        if (approvalArgs && callId) {
          // A copy: what the API checked, whatever happens later to the event's object.
          state.pinned.set(pinKey(keyOf(ctx.sessionKey), callId), {
            session: keyOf(ctx.sessionKey),
            params: structuredClone(approvalArgs),
          });
        }
      }
      if (flags.untrustedOutput) t.tainted = true;
      return undefined;
    },

    /**
     * 07.5 (D-04, Pitfall 3): the lowest-priority `before_tool_call` handler. OpenClaw gives each handler an isolated
     * copy of the original event and lets the LAST returned `params` win, so a plugin hooked between our gate and the
     * tool could change what a person approved. For a flagged call the gate allowed, this returns exactly the params the
     * API checked (once: the entry is deleted); for anything else it changes nothing.
     */
    pinParams(event: ToolCallEvent, ctx: ToolCallContext): { params: Record<string, unknown> } | undefined {
      const callId = event.toolCallId ?? ctx.toolCallId;
      if (!callId) return undefined;
      const key = pinKey(keyOf(ctx.sessionKey), callId);
      const pin = state.pinned.get(key);
      if (!pin) return undefined;
      state.pinned.delete(key);
      return { params: structuredClone(pin.params) };
    },

    async afterToolCall(event: ToolCallEvent, _ctx: ToolCallContext): Promise<void> {
      const id = event.toolCallId;
      const pending = id ? state.pending.get(id) : undefined;
      if (!id || !pending) return;
      state.pending.delete(id);
      const client = deps.client();
      if (!client) return;
      const failed = event.error !== undefined && event.error !== null && event.error !== "";
      const facts = failed ? {} : resultFacts(event.result);
      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? Math.round(event.durationMs)
          : Date.now() - pending.startedAt;
      await client.reportToolCallResult(pending.callId, {
        status: failed ? "error" : "ok",
        ...(facts.resultCount !== undefined ? { resultCount: facts.resultCount } : {}),
        ...(facts.provider ? { provider: facts.provider } : {}),
        ...(facts.finalUrl ? { finalUrl: facts.finalUrl } : {}),
        durationMs,
      });
    },
  };
}

export type ToolGuard = ReturnType<typeof createToolGuard>;

/**
 * Process-wide state: OpenClaw can load the plugin module more than once (registration modes, hot reload),
 * so the hook registered by one module instance must see the turns begun by another.
 */
const STATE_KEY = Symbol.for("ocw.openclaw-channel.tool-guard");
type StateRegistry = { [STATE_KEY]?: ToolGuardState };
const registry = globalThis as StateRegistry;
if (!registry[STATE_KEY]) registry[STATE_KEY] = createToolGuardState();
const sharedState: ToolGuardState = registry[STATE_KEY];

/** The account's API client as last handed over by channel.ts (null until an account started). */
export function sharedToolGuardClient(): AgentChannelClient | null {
  return sharedState.client;
}

/** Hands the account's API client to the gate (channel.ts, at account start). */
export function setToolGuardClient(client: AgentChannelClient | null): void {
  sharedState.client = client;
}

/** The module singleton shared by the plugin entry (hooks) and the port (turns). */
export const toolGuard: ToolGuard = createToolGuard({ client: () => sharedState.client }, sharedState);

/** Highest priority: our gate runs before any other plugin's tool hook; a block is terminal. */
export const TOOL_GATE_PRIORITY = 10_000;
/**
 * 07.5: lowest priority, so the params pin returns last and its params win (OpenClaw: "the last returned params
 * wins"). A plugin registered even lower could still rewrite after it; the real-cell smoke (07.5-15) records the order.
 */
export const TOOL_PIN_PRIORITY = -10_000;

/**
 * Registers the gate on OpenClaw (`registerCapabilities`, so it also exists in the non-activated registry agent
 * turns run with). No matcher, so it sees EVERY tool: matchers reject wildcards,
 * and a tool we did not list must not slip through. A thrown error or a timeout in `before_tool_call` blocks the
 * call (OpenClaw's fail-closed policy for that hook). 07.5: a second `before_tool_call` handler at TOOL_PIN_PRIORITY
 * pins an approved call's params. OpenClaw's own approval hook result and exec approvals stay unused (D-02, C-01).
 */
export function registerToolGate(api: OpenClawPluginApi, guard: ToolGuard = toolGuard): void {
  api.on("before_tool_call", (event, ctx) => guard.beforeToolCall(event, ctx), {
    priority: TOOL_GATE_PRIORITY,
  });
  api.on("before_tool_call", (event, ctx) => guard.pinParams(event, ctx), { priority: TOOL_PIN_PRIORITY });
  api.on("after_tool_call", (event, ctx) => guard.afterToolCall(event, ctx));
}
