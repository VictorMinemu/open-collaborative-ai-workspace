import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { AgentChannelToolCallRequest, TurnContext, TurnToolFlags } from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { openClawAgentIdFor } from "./mention-mapper.js";

/**
 * The cell's call-time tool gate (D-08 guard 3), wired to OpenClaw's `before_tool_call` / `after_tool_call`
 * hooks (register-capabilities.ts, registered unscoped). The API decided the turn's tool set at delivery and stays the
 * authority at call time; this gate:
 *   - blocks any call when no OCW turn is active for the session (fail closed),
 *   - blocks tools outside `turn.tools`, over the per-turn caps, or side-effecting after untrusted output
 *     (taint) — locally first, which saves a round trip,
 *   - asks `POST /agent-channel/v1/tool-calls` for every call except `ocw_memory_save` (validated by its own
 *     route) and blocks on a denial, an error or a timeout (fail closed, under OpenClaw's 15 s budget),
 *   - reports each allowed call's outcome (status, result count, provider, duration; never content).
 * Logs never include params or results.
 */

export interface ActiveTurn {
  eventId: string;
  agentId: string;
  /** The OCW conversation (OpenClaw's `nativeChannelId`): secondary lookup for tool factories. */
  conversationId?: string;
  turn: TurnContext;
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
/** Saved through its own route (`POST /memories`, 03.1-07), which validates owner and turn itself. */
const SELF_VALIDATED_TOOLS: ReadonlySet<string> = new Set(["ocw_memory_save"]);
/**
 * Always side-effecting, whatever flags a turn carries: writing memory after untrusted content is exactly the
 * poisoning the taint rule exists for (D-08, T-03.1-07-02).
 */
const ALWAYS_SIDE_EFFECTING: ReadonlySet<string> = new Set(["ocw_memory_save"]);
/** Unknown flags are treated as the most dangerous combination. */
const UNKNOWN_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };

type Pending = { callId: string; tool: string; startedAt: number };

export type ToolGuardState = {
  turns: Map<string, ActiveTurn>;
  pending: Map<string, Pending>;
  client: AgentChannelClient | null;
};

export function createToolGuardState(): ToolGuardState {
  return { turns: new Map(), pending: new Map(), client: null };
}

function block(reason: string): ToolBlock {
  return { block: true, blockReason: reason };
}

const keyOf = (sessionKey: string | undefined) => (sessionKey ?? "").trim().toLowerCase();

/** The turn's own spelling of a tool name OpenClaw reports case-folded; the reported name when none matches. */
export function canonicalToolName(turnTools: readonly string[], reported: string): string {
  if (turnTools.includes(reported)) return reported;
  const folded = reported.trim().toLowerCase();
  const hits = turnTools.filter((t) => t.toLowerCase() === folded);
  // Two turn tools that differ only by case are ambiguous: keep the reported name (not in the turn → blocked).
  return hits.length === 1 ? (hits[0] as string) : reported;
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

  return {
    timeoutMs,

    /** Starts the active turn of a session (right before dispatch). Aborting `signal` ends it. */
    beginTurn(
      sessionKey: string,
      t: { eventId: string; agentId: string; turn: TurnContext; conversationId?: string },
      signal?: AbortSignal,
    ): void {
      const key = keyOf(sessionKey);
      state.turns.set(key, { ...t, calls: 0, webCalls: 0, tainted: false });
      signal?.addEventListener(
        "abort",
        () => {
          if (state.turns.get(key)?.eventId === t.eventId) state.turns.delete(key);
        },
        { once: true },
      );
    },

    /** Ends the session's turn: any later call for it is blocked. */
    endTurn(sessionKey: string): void {
      state.turns.delete(keyOf(sessionKey));
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
      const delivered = t.turn.toolFlags[tool] ?? UNKNOWN_FLAGS;
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
      if (t.tainted && flags.sideEffecting) {
        return block(
          `Tool ${tool} blocked: this turn is read-only after untrusted content (web or tool output) was read.`,
        );
      }
      // Count before awaiting the API so concurrent calls of one turn can never exceed the caps.
      t.calls++;
      if (web) t.webCalls++;

      if (!SELF_VALIDATED_TOOLS.has(tool)) {
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
                ...(event.toolCallId ? { toolCallId: event.toolCallId.slice(0, 200) } : {}),
                params: pickParams(event.params),
                argsBytes: argsBytes(event.params),
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
          return block(`Tool ${tool} blocked by the workspace policy (${decision.reason ?? "denied"}).`);
        }
        if (event.toolCallId) {
          state.pending.set(event.toolCallId, { callId: decision.callId, tool, startedAt: Date.now() });
        }
      }
      if (flags.untrustedOutput) t.tainted = true;
      return undefined;
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
 * Registers the gate on OpenClaw (`registerCapabilities`, so it also exists in the non-activated registry agent
 * turns run with). No matcher, so it sees EVERY tool: matchers reject wildcards,
 * and a tool we did not list must not slip through. A thrown error or a timeout in `before_tool_call` blocks the
 * call (OpenClaw's fail-closed policy for that hook).
 */
export function registerToolGate(api: OpenClawPluginApi, guard: ToolGuard = toolGuard): void {
  api.on("before_tool_call", (event, ctx) => guard.beforeToolCall(event, ctx), {
    priority: TOOL_GATE_PRIORITY,
  });
  api.on("after_tool_call", (event, ctx) => guard.afterToolCall(event, ctx));
}
