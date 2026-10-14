import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  type AgentChannelToolCallRequest,
  CONNECTOR_SAFE_NAME,
  CONNECTOR_TOOL_LIMITS,
  TOOL_APPROVAL_LIMITS,
  TOOL_APPROVAL_REFUSALS,
  type ToolApprovalRefusal,
  type TurnContext,
  type TurnToolFlags,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";

/**
 * The cell's call-time tool gate (D-08 guard 3), wired to OpenClaw's `before_tool_call` / `after_tool_call`
 * hooks (register-capabilities.ts, registered unscoped). The API decided the turn's tool set at delivery and stays the
 * authority at call time; this gate:
 *   - blocks any call when no OCW turn is active for the session (fail closed),
 *   - blocks tools outside `turn.tools`, over the per-turn caps, or side-effecting after untrusted output
 *     (taint) — locally first, which saves a round trip,
 *   - asks `POST /agent-channel/v1/tool-calls` for every call except `ocw_memory_save`, `ocw_memory_write`,
 *     `ocw_memory_propose`, `ocw_board_card` and the connector and keychain tools (validated by their own routes,
 *     `SELF_VALIDATED_TOOLS`) and blocks on a denial, an error or a
 *     timeout (fail closed, under OpenClaw's 15 s budget),
 *   - reports each allowed call's outcome (status, result count, provider, duration; never content).
 * Per-tool approvals (07.5 D-01, D-02, D-04): for a tool whose turn flags carry `approval` (and only for those) the
 * request also carries the call's full `arguments` (≤ 32 KB, else refused locally), the local taint block is skipped
 * (the API decides: approval, a grant or a denial), and every approval refusal is a fixed sentence returned at once
 * (`APPROVAL_SENTENCES`). Nothing here ever waits for a person: the approved call re-runs in a new turn.
 * Logs never include params, arguments or results.
 */

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
  tainted: boolean;
}

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
 * call with the member's credential). Asking `/tool-calls` too would count the call twice, and
 * `/tool-calls` cannot offer the board tool (it does not know the board layout), so it would refuse it
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
]);
/**
 * Always side-effecting, whatever flags a turn carries: writing memory or changing shared board work after untrusted
 * content is exactly the injection the taint rule exists for (D-08, T-03.1-07-02, 07.1-13, T-07.2-07-02). A proposal
 * is not here: a person approves it before anything is written, so a tainted turn may still propose (flagged by the API).
 */
const ALWAYS_SIDE_EFFECTING: ReadonlySet<string> = new Set([
  "ocw_memory_save",
  "ocw_memory_write",
  "ocw_board_card",
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
};
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
  approval_denied: (p) =>
    `${capitalized(approvalLabel(p.waitingFor, 200) ?? "an approver")} denied this exact action. Don't retry it. ` +
    `Tell ${approvalLabel(p.requesterName) ?? ASKER} it was denied and ask what to change.`,
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
      },
      signal?: AbortSignal,
    ): void {
      const key = keyOf(sessionKey);
      state.turns.set(key, {
        ...t,
        connectorTools: t.connectorTools ?? [],
        calls: 0,
        webCalls: 0,
        tainted: false,
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
      const flags = ALWAYS_SIDE_EFFECTING.has(tool) ? { ...delivered, sideEffecting: true } : delivered;
      const web = WEB_TOOLS.has(tool);
      if (t.calls >= t.turn.maxToolCalls) {
        return block(
          `Tool ${tool} blocked: the turn reached its limit of ${t.turn.maxToolCalls} tool calls.`,
        );
      }
      if (web && t.webCalls >= t.turn.maxWebCalls) {
        return block(`Tool ${tool} blocked: the turn reached its limit of ${t.turn.maxWebCalls} web calls.`);
      }
      // 07.5 (D-04): a tool with an approval policy is decided by the API after taint (a person approves, or a grant
      // is used); the memory and board tools keep their local block whatever a turn says.
      const approval = ALWAYS_SIDE_EFFECTING.has(tool) ? undefined : flags.approval;
      if (t.tainted && flags.sideEffecting && !approval) {
        return block(
          `Tool ${tool} blocked: this turn is read-only after untrusted content (web or tool output) was read.`,
        );
      }
      const selfValidated = SELF_VALIDATED_TOOLS.has(tool);
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
      // Count before awaiting the API so concurrent calls of one turn can never exceed the caps.
      t.calls++;
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
