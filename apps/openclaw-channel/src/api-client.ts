import {
  AGENT_CHANNEL_BASE_PATH,
  type AgentChannelApprovalDenial,
  AgentChannelApprovalRefusalDetails,
  AgentChannelBoardCardResponse,
  type AgentChannelBoardCreateCard,
  type AgentChannelBoardPatchCard,
  type AgentChannelBoardRead,
  AgentChannelBoardReadResponse,
  type AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  type AgentChannelConnectorList,
  AgentChannelConnectorListResponse,
  type AgentChannelHttpRequest,
  AgentChannelHttpResponse,
  type AgentChannelMcpProbeResult,
  type AgentChannelMemoryList,
  AgentChannelMemoryListResponse,
  type AgentChannelMemoryPropose,
  AgentChannelMemoryProposeResponse,
  type AgentChannelMemoryRead,
  AgentChannelMemoryReadResponse,
  type AgentChannelMemorySave,
  AgentChannelMemorySaveResponse,
  type AgentChannelMemoryWrite,
  AgentChannelMemoryWriteResponse,
  type AgentChannelPatchCard,
  AgentChannelPatchCardResponse,
  type AgentChannelPluginReport,
  type AgentChannelPostCard,
  AgentChannelPostCardResponse,
  type AgentChannelPostMessage,
  AgentChannelPostMessageResponse,
  type AgentChannelProviderAuthReport,
  type AgentChannelRuntimeReport,
  type AgentChannelStatusReport,
  type AgentChannelToolCallApproval,
  AgentChannelToolCallDecision,
  type AgentChannelToolCallRequest,
  type AgentChannelToolCallResult,
  type AgentChannelTyping,
  type AgentChannelWorkZoneProjects,
  AgentChannelWorkZoneProjectsResponse,
  type AgentChannelWorkZonePropose,
  AgentChannelWorkZoneProposeResponse,
  CellSnapshot,
  SANDBOX_TOOL_RESPONSES,
  SANDBOX_TOOL_ROUTES,
  type SandboxToolBodies,
  type SandboxToolName,
  type SandboxToolResponses,
} from "./agent-channel-protocol.js";
import { backoffDelayMs, sleep } from "./backoff.js";

/** Process-wide brand of an `AgentChannelHttpError`, shared by every module instance of this plugin. */
const HTTP_ERROR_BRAND = Symbol.for("ocw.openclaw-channel.agent-channel-http-error");

export class AgentChannelHttpError extends Error {
  readonly [HTTP_ERROR_BRAND] = true;

  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    /** The API's machine error code (`error.code`), when the body carried a well-formed one. Never free text. */
    readonly code?: string,
    /** 07.5: the approval a 409 `approval_required` / `approval_pending` waits on (`error.details.approval`), if valid. */
    readonly approval?: AgentChannelToolCallApproval,
    /** 07.5-11: who denied a 409 `approval_denied` and their note (`error.details.denial`), if valid. */
    readonly denial?: AgentChannelApprovalDenial,
  ) {
    super(message);
    this.name = "AgentChannelHttpError";
  }

  /**
   * OpenClaw loads this plugin once per registry (boot, discovery, tool-discovery; see active-account.ts), so the
   * shared client's errors can come from another module instance than the tool that catches them. `instanceof`
   * therefore matches the brand, not the class identity; otherwise every API refusal (403 `no_trigger`, 409 …) read
   * as "the workspace could not be reached" in a real cell (07.2-15 container smoke, scenario memory-files).
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { [HTTP_ERROR_BRAND]?: unknown })[HTTP_ERROR_BRAND] === true
    );
  }
}

/** `error.code` of an API error body: a short snake_case code, or undefined (never any other body content). */
export function errorCodeOf(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The well-formed `error.details` of an API approval refusal (07.5), else undefined. */
function refusalDetailsOf(body: string): AgentChannelApprovalRefusalDetails | undefined {
  try {
    const details = (JSON.parse(body) as { error?: { details?: unknown } } | null)?.error?.details;
    const parsed = AgentChannelApprovalRefusalDetails.safeParse(details);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `error.details.approval` of an API error body when it is a well-formed approval (07.5), else undefined. */
export function approvalOf(body: string): AgentChannelToolCallApproval | undefined {
  return refusalDetailsOf(body)?.approval;
}

/** `error.details.denial` of an API error body when it is a well-formed denial (07.5-11), else undefined. */
export function denialOf(body: string): AgentChannelApprovalDenial | undefined {
  return refusalDetailsOf(body)?.denial;
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

/**
 * Client budget of a connector call or a keychain request: above the API's 30 s upstream timeout (07.4-11/12), so the
 * API answers `timeout` itself, and inside the cell turn (a 20 s call completes in the real cell, research A4).
 */
export const CONNECTOR_REQUEST_TIMEOUT_MS = 35_000;

/** Per-attempt budget of the Work Zone proposal routes (07.5-10): two attempts at most, both idempotent server side. */
export const WORK_ZONE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 07.8: per-call budgets of the confined tools. Exec and process yield after 25 s server side (a process id), and a
 * browser wait lasts up to 30 s, so they get 35 s; every other sandbox or browser call 20 s. One attempt each: the
 * route counts the call against the turn's budget.
 */
export const CONFINED_LONG_TIMEOUT_MS = 35_000;
export const CONFINED_TIMEOUT_MS = 20_000;
const LONG_CONFINED_TOOLS: ReadonlySet<string> = new Set([
  "ocw_sandbox_exec",
  "ocw_sandbox_process",
  "ocw_browser_wait",
]);
/** The budget of one confined call (35 s for exec, process and wait; 20 s otherwise). */
export function confinedTimeoutMs(tool: string): number {
  return LONG_CONFINED_TOOLS.has(tool) ? CONFINED_LONG_TIMEOUT_MS : CONFINED_TIMEOUT_MS;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function createAgentChannelClient(opts: AgentChannelClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const base = `${trimTrailingSlash(opts.apiUrl)}${AGENT_CHANNEL_BASE_PATH}`;
  const maxAttempts = opts.maxAttempts ?? 6;
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    signal?: AbortSignal,
    attempts = maxAttempts,
    attemptTimeoutMs = timeoutMs,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
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
        const raw = await res.text().catch(() => "");
        const detail = raw.slice(0, 200);
        const err = new AgentChannelHttpError(
          res.status,
          path,
          `${method} ${path} → ${res.status} ${detail}`,
          errorCodeOf(raw.slice(0, 4_000)),
          approvalOf(raw.slice(0, 4_000)),
          denialOf(raw.slice(0, 4_000)),
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
     * `ocw_memory_list` (07.2-07): no scope = the scopes this turn may read; a scope = its files' metadata. A refusal
     * is a 200 `{refused}`. Reads change nothing, so two attempts at most. Never logs the request or the answer.
     */
    async memoryList(
      req: AgentChannelMemoryList,
      signal?: AbortSignal,
    ): Promise<AgentChannelMemoryListResponse> {
      return AgentChannelMemoryListResponse.parse(await request("POST", "/memory/list", req, signal, 2));
    },
    /** `ocw_memory_read` (07.2-07): one file of a scope, or `{refused}`. Two attempts at most. Never logs content. */
    async memoryRead(
      req: AgentChannelMemoryRead,
      signal?: AbortSignal,
    ): Promise<AgentChannelMemoryReadResponse> {
      return AgentChannelMemoryReadResponse.parse(await request("POST", "/memory/read", req, signal, 2));
    },
    /**
     * `ocw_memory_write` (07.2-07): the agent's own scopes only. One attempt: an append retried after a lost success
     * would be stored twice, and the route counts the call against the turn.
     */
    async memoryWrite(
      req: AgentChannelMemoryWrite,
      signal?: AbortSignal,
    ): Promise<AgentChannelMemoryWriteResponse> {
      return AgentChannelMemoryWriteResponse.parse(await request("POST", "/memory/write", req, signal, 1));
    },
    /**
     * `ocw_memory_propose` (07.2-07): a change to a shared scope that a person approves and the server applies. One
     * attempt: a retry after a lost success would open a second approval.
     */
    async memoryPropose(
      req: AgentChannelMemoryPropose,
      signal?: AbortSignal,
    ): Promise<AgentChannelMemoryProposeResponse> {
      return AgentChannelMemoryProposeResponse.parse(
        await request("POST", "/memory/propose", req, signal, 1),
      );
    },
    /**
     * `ocw_agent_card` create (06-14, P-11): a typed card where the turn's agent may post. Idempotent on
     * (agentId, idempotencyKey): two attempts at most. A refusal throws AgentChannelHttpError (400/403/404/410 with
     * the API's code). Never logs the card.
     */
    async postCard(req: AgentChannelPostCard, signal?: AbortSignal): Promise<AgentChannelPostCardResponse> {
      return AgentChannelPostCardResponse.parse(await request("POST", "/cards", req, signal, 2));
    },
    /**
     * `ocw_agent_card` update: only the posting agent, naming the version it saw (409 `card_version_conflict`
     * otherwise). Two attempts at most.
     */
    async patchCard(
      messageId: string,
      req: AgentChannelPatchCard,
      signal?: AbortSignal,
    ): Promise<AgentChannelPatchCardResponse> {
      return AgentChannelPatchCardResponse.parse(
        await request("PATCH", `/cards/${encodeURIComponent(messageId)}`, req, signal, 2),
      );
    },
    /**
     * `ocw_board_card` read (07.1-13): the turn's board, its columns and the turn thread's card. Counted against the
     * turn's tool budget by the API, so one attempt only.
     */
    async boardRead(
      req: AgentChannelBoardRead,
      signal?: AbortSignal,
    ): Promise<AgentChannelBoardReadResponse> {
      return AgentChannelBoardReadResponse.parse(await request("POST", "/board/read", req, signal, 1));
    },
    /**
     * `ocw_board_card` create: a card in the turn's board. Idempotent on (agentId, idempotencyKey): two attempts at
     * most. A refusal throws AgentChannelHttpError with the API's code. Never logs the card.
     */
    async boardCreateCard(
      req: AgentChannelBoardCreateCard,
      signal?: AbortSignal,
    ): Promise<AgentChannelBoardCardResponse> {
      return AgentChannelBoardCardResponse.parse(await request("POST", "/board/cards", req, signal, 2));
    },
    /**
     * `ocw_board_card` move / waiting state, naming the version seen. One attempt: a retried change would spend the
     * turn's budget twice and answer 409 `board_card_version_conflict` after a lost success.
     */
    async boardPatchCard(
      messageId: string,
      req: AgentChannelBoardPatchCard,
      signal?: AbortSignal,
    ): Promise<AgentChannelBoardCardResponse> {
      return AgentChannelBoardCardResponse.parse(
        await request("PATCH", `/board/cards/${encodeURIComponent(messageId)}`, req, signal, 1),
      );
    },
    /**
     * `ocw_connector_list` (07.4): the turn's per-member connectors with the asker's connection status, their tools and
     * the keychain handles the bot may use. Read-only, so two attempts at most. Never logs the answer.
     */
    async listConnectors(
      req: AgentChannelConnectorList,
      signal?: AbortSignal,
    ): Promise<AgentChannelConnectorListResponse> {
      return AgentChannelConnectorListResponse.parse(
        await request("POST", "/connectors/list", req, signal, 2),
      );
    },
    /**
     * `ocw_connector_call` (07.4): one logical tool with the turn's human's own account, decided and audited by the API.
     * One attempt (a connector tool may change things, and the route counts the call), 35 s budget. A refusal throws
     * AgentChannelHttpError with its AgentChannelToolRefusal code. Never logs arguments or content.
     */
    async callConnector(
      req: AgentChannelConnectorCall,
      signal?: AbortSignal,
    ): Promise<AgentChannelConnectorCallResponse> {
      return AgentChannelConnectorCallResponse.parse(
        await request("POST", "/connectors/call", req, signal, 1, CONNECTOR_REQUEST_TIMEOUT_MS),
      );
    },
    /**
     * `ocw_http_request` (07.4): one request with a keychain handle; the API injects the secret for allowed hosts only.
     * One attempt, 35 s budget. Never logs the URL, headers or body.
     */
    async httpRequest(req: AgentChannelHttpRequest, signal?: AbortSignal): Promise<AgentChannelHttpResponse> {
      return AgentChannelHttpResponse.parse(
        await request("POST", "/http-requests", req, signal, 1, CONNECTOR_REQUEST_TIMEOUT_MS),
      );
    },
    /**
     * `ocw_work_zone_projects` (07.5): the projects the turn's human may start a Work Zone session on, with device
     * state and runtimes (names and ids only, never a path). Read-only: two attempts of 10 s at most.
     */
    async listWorkZoneProjects(
      req: AgentChannelWorkZoneProjects,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkZoneProjectsResponse> {
      return AgentChannelWorkZoneProjectsResponse.parse(
        await request("POST", "/work-zone/projects", req, signal, 2, WORK_ZONE_REQUEST_TIMEOUT_MS),
      );
    },
    /**
     * `ocw_start_work_zone` (07.5): a proposal the turn's human starts from a card; never a mode. Two attempts of 10 s
     * at most: the API returns the same approval for the same (event, project, device, prompt), so a retry after a
     * lost answer opens no second card. A refusal is a 200 `{refused}` (404 for an unknown turn). Never logs the prompt.
     */
    async proposeWorkZone(
      req: AgentChannelWorkZonePropose,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkZoneProposeResponse> {
      return AgentChannelWorkZoneProposeResponse.parse(
        await request("POST", "/work-zone/proposals", req, signal, 2, WORK_ZONE_REQUEST_TIMEOUT_MS),
      );
    },
    /**
     * The tools an `mcp.probe` discovered, or why it failed (D-13). Three attempts at most: the API applies only
     * the newest probe of a server, so a retried report is harmless. Never logs the report.
     */
    async reportMcpProbe(report: AgentChannelMcpProbeResult, signal?: AbortSignal): Promise<void> {
      await request("POST", "/mcp/probe-results", report, signal, 3);
    },
    /**
     * `ocw_sandbox_*` (07.8, D-02 b): one call to the tool's own route with the turn's ids and the tool's contract body
     * only. One attempt, 35 s (exec, process) or 20 s budget. A refusal throws AgentChannelHttpError with its
     * `SandboxRefusal` code. Never logs argv, paths, content or output.
     */
    async sandboxCall<T extends SandboxToolName>(
      tool: T,
      body: SandboxToolBodies[T],
      signal?: AbortSignal,
    ): Promise<SandboxToolResponses[T]> {
      const raw = await request("POST", SANDBOX_TOOL_ROUTES[tool], body, signal, 1, confinedTimeoutMs(tool));
      return SANDBOX_TOOL_RESPONSES[tool].parse(raw) as SandboxToolResponses[T];
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
