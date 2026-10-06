import {
  AGENT_CHANNEL_BASE_PATH,
  type AgentChannelMcpProbeResult,
  type AgentChannelMemorySave,
  AgentChannelMemorySaveResponse,
  type AgentChannelPluginReport,
  type AgentChannelPostMessage,
  AgentChannelPostMessageResponse,
  type AgentChannelProviderAuthReport,
  type AgentChannelRuntimeReport,
  type AgentChannelStatusReport,
  AgentChannelToolCallDecision,
  type AgentChannelToolCallRequest,
  type AgentChannelToolCallResult,
  type AgentChannelTyping,
  CellSnapshot,
} from "./agent-channel-protocol.js";
import { backoffDelayMs, sleep } from "./backoff.js";

export class AgentChannelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentChannelHttpError";
  }
}

/** 408/425/429 and 5xx are retried; every other 4xx is a permanent failure. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export type AgentChannelClientOptions = {
  /** API base, e.g. `http://api:4000`. Paths are appended as `${apiUrl}/agent-channel/v1/...`. */
  apiUrl: string;
  /** Returns the current cell token (re-read on every request so rotated secret files apply). */
  token: () => string;
  fetch?: typeof fetch;
  /** Max attempts for retryable failures (default 6). */
  maxAttempts?: number;
  backoff?: { baseMs?: number; maxMs?: number };
  requestTimeoutMs?: number;
};

export type AgentChannelClient = ReturnType<typeof createAgentChannelClient>;

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function createAgentChannelClient(opts: AgentChannelClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const base = `${trimTrailingSlash(opts.apiUrl)}${AGENT_CHANNEL_BASE_PATH}`;
  const maxAttempts = opts.maxAttempts ?? 6;
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;

  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
    attempts = maxAttempts,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.token()}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: combined,
        });
        if (res.ok) {
          if (res.status === 204) return undefined;
          const text = await res.text();
          return text ? (JSON.parse(text) as unknown) : undefined;
        }
        // Never echo response bodies verbatim into logs beyond a short prefix.
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        const err = new AgentChannelHttpError(
          res.status,
          path,
          `${method} ${path} → ${res.status} ${detail}`,
        );
        if (!isRetryableStatus(res.status)) throw err;
        lastError = err;
      } catch (error) {
        if (error instanceof AgentChannelHttpError && !isRetryableStatus(error.status)) throw error;
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
      }
      if (attempt < attempts - 1) await sleep(backoffDelayMs(attempt, opts.backoff), signal);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    baseUrl: base,
    /** The snapshot carries provider API keys: never log it. */
    async getCell(signal?: AbortSignal): Promise<CellSnapshot> {
      return CellSnapshot.parse(await request("GET", "/cell", undefined, signal));
    },
    /** Idempotent on (agentId, idempotencyKey): safe to retry after timeouts / 5xx. */
    async postMessage(
      msg: AgentChannelPostMessage,
      signal?: AbortSignal,
    ): Promise<AgentChannelPostMessageResponse> {
      return AgentChannelPostMessageResponse.parse(await request("POST", "/messages", msg, signal));
    },
    /** Best effort, single attempt: a lost typing ping must never delay the reply. */
    async postTyping(msg: AgentChannelTyping, signal?: AbortSignal): Promise<void> {
      await request("POST", "/typing", msg, signal, 1);
    },
    /** Flips the bot's status chip (provisioning → ready | error). */
    async reportStatus(
      agentId: string,
      report: AgentChannelStatusReport,
      signal?: AbortSignal,
    ): Promise<void> {
      await request("POST", `/agents/${encodeURIComponent(agentId)}/status`, report, signal, 3);
    },
    /** Why the cell runs without its channel (or that it no longer does). Three attempts at most. */
    async reportRuntime(report: AgentChannelRuntimeReport, signal?: AbortSignal): Promise<void> {
      await request("POST", "/runtime", report, signal, 3);
    },
    /**
     * Subscription sign-in progress. The report may carry the one-time user code: never log it.
     * Throws AgentChannelHttpError (409 `flow_claimed` / `flow_closed` / `unknown_flow` → stop the flow).
     */
    async reportProviderAuth(report: AgentChannelProviderAuthReport, signal?: AbortSignal): Promise<void> {
      await request("POST", "/provider-auth", report, signal, 3);
    },
    /**
     * The tool gate's question for one call (D-08). Single attempt, bounded by `timeoutMs` (default 10 s, under
     * OpenClaw's 15 s hook budget) and the caller's signal: any failure rejects, and the caller blocks the call
     * (fail closed). Never logs params.
     */
    async authorizeToolCall(
      req: AgentChannelToolCallRequest,
      signal?: AbortSignal,
      timeoutMs = 10_000,
    ): Promise<AgentChannelToolCallDecision> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return AgentChannelToolCallDecision.parse(await request("POST", "/tool-calls", req, combined, 1));
    },
    /** Outcome of an allowed call (never its content). Best effort: never throws. */
    async reportToolCallResult(callId: string, result: AgentChannelToolCallResult): Promise<void> {
      try {
        await request(
          "POST",
          `/tool-calls/${encodeURIComponent(callId)}/result`,
          result,
          AbortSignal.timeout(10_000),
          2,
        );
      } catch {
        /* the audit row keeps the decision; the outcome is optional */
      }
    },
    /**
     * `ocw_memory_save` (D-10): stores one note for the human of the turn. Two attempts at most (a duplicate
     * text is not stored twice); a refusal throws AgentChannelHttpError (404 unknown_turn, 409 otherwise).
     * Never logs the text.
     */
    async saveMemory(
      req: AgentChannelMemorySave,
      signal?: AbortSignal,
    ): Promise<AgentChannelMemorySaveResponse> {
      return AgentChannelMemorySaveResponse.parse(await request("POST", "/memories", req, signal, 2));
    },
    /**
     * The tools an `mcp.probe` discovered, or why it failed (D-13). Three attempts at most: the API applies only
     * the newest probe of a server, so a retried report is harmless. Never logs the report.
     */
    async reportMcpProbe(report: AgentChannelMcpProbeResult, signal?: AbortSignal): Promise<void> {
      await request("POST", "/mcp/probe-results", report, signal, 3);
    },
    /**
     * A marketplace install / uninstall outcome (D-14). Three attempts at most: the API applies a report only to the
     * row's current flow, so a retried report is harmless. Throws AgentChannelHttpError on a refusal (404 unknown
     * flow, 409 wrong state).
     */
    async reportPlugin(report: AgentChannelPluginReport, signal?: AbortSignal): Promise<void> {
      await request("POST", "/plugins/report", report, signal, 3);
    },
    /** `ws(s)://…/agent-channel/v1/ws` */
    wsUrl(): string {
      const url = new URL(`${base}/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
    authHeader(): string {
      return `Bearer ${opts.token()}`;
    },
  };
}
