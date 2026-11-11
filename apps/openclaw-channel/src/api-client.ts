import {
  AGENT_CHANNEL_BASE_PATH,
  type AgentChannelApprovalDenial,
  AgentChannelApprovalRefusalDetails,
  type AgentChannelAttachmentRead,
  AgentChannelAttachmentReadResponse,
  type AgentChannelAutomationPropose,
  AgentChannelAutomationProposeResponse,
  AgentChannelBoardCard,
  AgentChannelBoardCardResponse,
  type AgentChannelBoardCreateCard,
  type AgentChannelBoardPatchCard,
  type AgentChannelBoardRead,
  AgentChannelBoardReadResponse,
  type AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  type AgentChannelConnectorList,
  AgentChannelConnectorListResponse,
  type AgentChannelConsultRequest,
  AgentChannelConsultResponse,
  type AgentChannelConversationOpen,
  AgentChannelConversationOpenResponse,
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
  type AgentChannelRecordUpdate,
  AgentChannelRecordUpdateResponse,
  type AgentChannelRuntimeReport,
  AgentChannelSentenceAnswer,
  type AgentChannelStatusReport,
  type AgentChannelToolCallApproval,
  AgentChannelToolCallDecision,
  type AgentChannelToolCallRequest,
  type AgentChannelToolCallResult,
  type AgentChannelTurnDone,
  type AgentChannelTyping,
  type AgentChannelWorkSessionDownload,
  AgentChannelWorkSessionDownloadResponse,
  type AgentChannelWorkSessionPrompt,
  AgentChannelWorkSessionPromptResponse,
  type AgentChannelWorkSessionRead,
  AgentChannelWorkSessionReadResponse,
  type AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
  type AgentChannelWorkSessionStop,
  AgentChannelWorkSessionStopResponse,
  type AgentChannelWorkSessionUpload,
  AgentChannelWorkSessionUploadResponse,
  type AgentChannelWorkZoneProjects,
  AgentChannelWorkZoneProjectsResponse,
  type AgentChannelWorkZonePropose,
  AgentChannelWorkZoneProposeResponse,
  BOT_FILE_LIMITS,
  BROWSER_TIMEOUTS_MS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_RESPONSES,
  BROWSER_TOOL_ROUTES,
  type BrowserToolBodies,
  type BrowserToolName,
  type BrowserToolResponses,
  CellSnapshot,
  SANDBOX_TIMEOUTS_MS,
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
    /** 07.6: a refusal whose body carries the server's sentence (`{ok: false, code, sentence}`), if well-formed. */
    readonly answer?: AgentChannelSentenceAnswer,
    /**
     * 07.17 (D-06): the current card of a 409 `board_card_version_conflict` (`error.details.card`), if well-formed: a
     * board move on a turn that may not read the board retries once with its version.
     */
    readonly conflictCard?: AgentChannelBoardCard,
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

/** The `{ok: false, code, sentence}` body of a refusal (07.6 routes), when well-formed; never any other content. */
export function sentenceAnswerOf(body: string): AgentChannelSentenceAnswer | undefined {
  try {
    const parsed = AgentChannelSentenceAnswer.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `error.details.card` of a board version conflict (07.17 D-06), when well-formed; never any other content. */
export function conflictCardOf(body: string): AgentChannelBoardCard | undefined {
  try {
    const details = (JSON.parse(body) as { error?: { details?: { card?: unknown } } } | null)?.error?.details;
    const parsed = AgentChannelBoardCard.safeParse(details?.card);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
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

/**
 * Client budget of a connector call or a keychain request: above the API's 30 s upstream timeout (07.4-11/12), so the
 * API answers `timeout` itself, and inside the cell turn (a 20 s call completes in the real cell, research A4).
 */
export const CONNECTOR_REQUEST_TIMEOUT_MS = 35_000;

/** Per-attempt budget of the Work Zone proposal routes (07.5-10): two attempts at most, both idempotent server side. */
export const WORK_ZONE_REQUEST_TIMEOUT_MS = 10_000;

/** 07.6: one attempt of 10 s for an automation proposal (a retry after a lost answer could post a second card). */
export const AUTOMATION_PROPOSE_TIMEOUT_MS = 10_000;

/** 07.7: per-attempt budget of a consult (two attempts, the key answers the same hop) and of the turn-done signal. */
export const CONSULT_TIMEOUT_MS = 10_000;
export const TURN_DONE_TIMEOUT_MS = 10_000;

/**
 * 07.15 (IN-05): one `ocw_attachment_read` attempt. The API's worst case is a store read of at most 25 MiB (its fixed
 * PDF bound), the PDF extractor's 10 s deadline and two transactions; 35 s waits past it, so the bot reads what the API
 * answered (and charged), never the transport sentence for a read that was counted anyway.
 */
export const ATTACHMENT_READ_TIMEOUT_MS = 35_000;

/**
 * 07.16 (PD-09): one attempt of a bot's Work Zone session call. Starting, prompting and stopping are not idempotent (a
 * retry after a lost answer could start a second session or queue the prompt twice), and the start route waits for the
 * device's first answer; 30 s waits past it, so the bot reads what the API decided.
 */
export const WORK_SESSION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 07.17.1.1 (PD-18): one attempt of `ocw_work_session_upload` / `ocw_work_session_download`. The route waits for the
 * device to finish the transfer, bounded by the ledger's deadline (at most `BOT_FILE_LIMITS.transferMaxMs`, 10 min);
 * 15 s more lets the bot read what the API decided (moved, refused or `transfer_timeout`), never the transport sentence
 * for a move that happened anyway. A retry could move the file twice, so there is none.
 */
export const WORK_SESSION_FILE_REQUEST_TIMEOUT_MS = BOT_FILE_LIMITS.transferMaxMs + 15_000;

/**
 * 07.17 (PD-07): one `/conversations/open` call posts up to 25 cards or messages in one transaction; the budget is
 * longer than a plain write's, still under OpenClaw's per-tool budget.
 */
export const CONVERSATION_OPEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 07.8: per-call budgets of the confined tools, each longer than the API's deadline of that call, so the model reads
 * what the API answered, never "the workspace could not be reached" while the call completes anyway. A sandbox call
 * waits 85 s (contracts `SANDBOX_TIMEOUTS_MS`, CI p142/p164/p178: any first call may start the bot's shell, and a cold
 * start on a loaded Docker daemon took up to 42 s, beyond the 35 s exec and 20 s file budgets of before). A browser call
 * waits 85 s for an open, which may start the bot's browser cold, 65 s otherwise (contracts `BROWSER_TIMEOUTS_MS`, CI
 * p64/p66). One attempt each: the route counts the call against the turn's budget, and neither an exec nor an open is
 * idempotent.
 */
const BROWSER_TOOLS: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);
/** The budget of one confined call. */
export function confinedTimeoutMs(tool: string): number {
  if (tool === "ocw_browser_open") return BROWSER_TIMEOUTS_MS.cellOpen;
  if (BROWSER_TOOLS.has(tool)) return BROWSER_TIMEOUTS_MS.cellCall;
  return SANDBOX_TIMEOUTS_MS.cellCall;
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
          sentenceAnswerOf(raw.slice(0, 4_000)),
          res.status === 409 ? conflictCardOf(raw.slice(0, 64_000)) : undefined,
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
     * `ocw_automation_propose` (07.6 AUTO-03): a scheduled automation as a card the turn's human confirms. One attempt (a
     * retry after a lost answer could post a second card). A refusal answered with a 4xx that still carries
     * `{ok: false, code, sentence}` resolves to that refusal; any other failure throws. Never logs the instructions.
     */
    async proposeAutomation(
      req: AgentChannelAutomationPropose,
      signal?: AbortSignal,
    ): Promise<AgentChannelAutomationProposeResponse> {
      try {
        return AgentChannelAutomationProposeResponse.parse(
          await request("POST", "/automations/propose", req, signal, 1, AUTOMATION_PROPOSE_TIMEOUT_MS),
        );
      } catch (error) {
        const answer = error instanceof AgentChannelHttpError ? error.answer : undefined;
        if (answer?.code) return { ok: false, code: answer.code, sentence: answer.sentence };
        throw error;
      }
    },
    /**
     * `ocw_record_update` (07.6 AUTO-04): compare-and-set on the watched record of the turn's card. One attempt (a write;
     * the API reads and writes through the record's connector, so the budget is a connector call's). A refusal answered
     * with a 4xx that still carries `{ok: false, code, sentence}` (409 `record_changed`, 403 `tainted`, …) resolves to
     * that refusal; any other failure throws. Never logs the changes.
     */
    async updateRecord(
      req: AgentChannelRecordUpdate,
      signal?: AbortSignal,
    ): Promise<AgentChannelRecordUpdateResponse> {
      try {
        return AgentChannelRecordUpdateResponse.parse(
          await request("POST", "/records/update", req, signal, 1, CONNECTOR_REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        const answer = error instanceof AgentChannelHttpError ? error.answer : undefined;
        if (answer) return { ok: false, code: answer.code, sentence: answer.sentence };
        throw error;
      }
    },
    /**
     * `ocw_consult_agent` (07.7 A2A-01, D-08): a question to another bot, posted in the turn's thread by the API. Two
     * attempts at most: the cell's key (`<eventId>:consult:<hash>`, consult-tool.ts) makes a retry after a lost answer
     * return the same hop.
     * A refusal answered with a 4xx that still carries `{ok: false, code, sentence}` resolves to that refusal; any other
     * failure throws. Never logs the question.
     */
    async consult(
      req: AgentChannelConsultRequest,
      signal?: AbortSignal,
    ): Promise<AgentChannelConsultResponse> {
      try {
        return AgentChannelConsultResponse.parse(
          await request("POST", "/consultations", req, signal, 2, CONSULT_TIMEOUT_MS),
        );
      } catch (error) {
        const answer = error instanceof AgentChannelHttpError ? error.answer : undefined;
        if (answer?.code) return { ok: false, code: answer.code, sentence: answer.sentence };
        throw error;
      }
    },
    /**
     * 07.7 (P-09): a turn that can belong to a consult chain ended (`replied` | `failed`). Idempotent on the server, so
     * two attempts of 10 s at most; the caller never fails or retries the turn on it (the `consult.tick` timeout is the
     * backstop).
     */
    async turnDone(eventId: string, body: AgentChannelTurnDone, signal?: AbortSignal): Promise<void> {
      await request(
        "POST",
        `/turns/${encodeURIComponent(eventId)}/done`,
        body,
        signal,
        2,
        TURN_DONE_TIMEOUT_MS,
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
     * only. One attempt, 85 s budget, above the API's deadline of the call. A refusal throws AgentChannelHttpError
     * with its `SandboxRefusal` code. Never logs argv, paths, content or output.
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
     * `ocw_browser_*` (07.8, D-05): one call to the tool's own route with the turn's ids and the tool's contract body
     * only. One attempt, 85 s (open) or 65 s budget, above the API's deadline of the call. A refusal throws
     * AgentChannelHttpError with its `BrowserRefusal` code. Never logs URLs, page text, typed text or images.
     */
    async browserCall<T extends BrowserToolName>(
      tool: T,
      body: BrowserToolBodies[T],
      signal?: AbortSignal,
    ): Promise<BrowserToolResponses[T]> {
      const raw = await request("POST", BROWSER_TOOL_ROUTES[tool], body, signal, 1, confinedTimeoutMs(tool));
      return BROWSER_TOOL_RESPONSES[tool].parse(raw) as BrowserToolResponses[T];
    },
    /**
     * `ocw_attachment_read` (07.15 D-03, PD-10): one read of a file the turn lists, with the turn's ids and the attachment
     * id only (the API derives the conversation and the human from the stored turn). One attempt of
     * `ATTACHMENT_READ_TIMEOUT_MS` (35 s, past the API's worst case): the route claims
     * the read against the turn's own budget. Every refusal is a 200 `{kind: "refused", code, sentence}`; only a turn that
     * ended throws (403 `no_trigger`). Never logs the file's name or content.
     */
    async attachmentRead(
      body: AgentChannelAttachmentRead,
      signal?: AbortSignal,
    ): Promise<AgentChannelAttachmentReadResponse> {
      const raw = await request("POST", "/attachments/read", body, signal, 1, ATTACHMENT_READ_TIMEOUT_MS);
      return AgentChannelAttachmentReadResponse.parse(raw);
    },
    /**
     * `ocw_work_session_start` (07.16 D-05, PD-09): the turn's ids, a project and the bot's optional choices; the API
     * takes the device, the runtime, the sponsor, the audience and the worktree from the bot's profile. One attempt of
     * `WORK_SESSION_REQUEST_TIMEOUT_MS`. Every refusal is a 200 `{kind: "refused", code, sentence}`; an ended turn
     * throws (404 `unknown_turn`). Never logs the prompt.
     */
    async workSessionStart(
      body: AgentChannelWorkSessionStart,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionStartResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/start",
        body,
        signal,
        1,
        WORK_SESSION_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionStartResponse.parse(raw);
    },
    /**
     * `ocw_work_session_prompt` (07.16 PD-13): one more prompt to a session this bot started, queued like a person's.
     * One attempt (a retry could queue it twice). Refusals are a 200 `{kind: "refused"}`. Never logs the prompt.
     */
    async workSessionPrompt(
      body: AgentChannelWorkSessionPrompt,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionPromptResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/prompt",
        body,
        signal,
        1,
        WORK_SESSION_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionPromptResponse.parse(raw);
    },
    /**
     * `ocw_work_session_read` (07.16 PD-14): the session's bounded, repo-relative state and output after `cursor`. One
     * attempt: the route counts the read against the turn's tool cap and audits it. The parse enforces the contract's
     * bounds, so an oversized answer never reaches the model. Never logs the output.
     */
    async workSessionRead(
      body: AgentChannelWorkSessionRead,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionReadResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/read",
        body,
        signal,
        1,
        WORK_SESSION_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionReadResponse.parse(raw);
    },
    /** `ocw_work_session_stop` (07.16 PD-13): archives a session this bot started. One attempt. */
    async workSessionStop(
      body: AgentChannelWorkSessionStop,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionStopResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/stop",
        body,
        signal,
        1,
        WORK_SESSION_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionStopResponse.parse(raw);
    },
    /**
     * `ocw_work_session_upload` (07.17.1.1 D-01, D-02): the turn's ids, the session, one of the turn's attachments and a
     * repo-relative path; the API decides everything else and waits for the device. One attempt of
     * `WORK_SESSION_FILE_REQUEST_TIMEOUT_MS`. Refusals are a 200 `{kind: "refused"}`; an ended turn throws (404
     * `unknown_turn`). Never logs the path.
     */
    async workSessionUpload(
      body: AgentChannelWorkSessionUpload,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionUploadResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/upload",
        body,
        signal,
        1,
        WORK_SESSION_FILE_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionUploadResponse.parse(raw);
    },
    /**
     * `ocw_work_session_download` (07.17.1.1 D-01, D-03): the turn's ids, the session and a repo-relative path; the API
     * waits for the device's file and stores it as a pending attachment the bot's reply links. One attempt of
     * `WORK_SESSION_FILE_REQUEST_TIMEOUT_MS`; never bytes in the answer. Never logs the path.
     */
    async workSessionDownload(
      body: AgentChannelWorkSessionDownload,
      signal?: AbortSignal,
    ): Promise<AgentChannelWorkSessionDownloadResponse> {
      const raw = await request(
        "POST",
        "/work-sessions/download",
        body,
        signal,
        1,
        WORK_SESSION_FILE_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelWorkSessionDownloadResponse.parse(raw);
    },
    /**
     * `ocw_conversation_open` (07.17 D-02, PD-07): the run turn's ids and the items it found; the API takes the
     * automation, the run, the target and the person from the stored turn, dedupes by key and applies the caps. One
     * attempt (the route claims a tool call each time). Refusals are a 200 `{ok: false, code, sentence}`; an ended turn
     * throws (404 `unknown_turn`). Never logs the items.
     */
    async conversationOpen(
      body: AgentChannelConversationOpen,
      signal?: AbortSignal,
    ): Promise<AgentChannelConversationOpenResponse> {
      const raw = await request(
        "POST",
        "/conversations/open",
        body,
        signal,
        1,
        CONVERSATION_OPEN_REQUEST_TIMEOUT_MS,
      );
      return AgentChannelConversationOpenResponse.parse(raw);
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
