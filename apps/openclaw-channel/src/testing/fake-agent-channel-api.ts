/**
 * Fake Agent Channel API v1 server (tests + local/container smoke runs), speaking the canonical
 * contract (`01-AGENT-CHANNEL-API.md`, `packages/contracts/src/agent-channel.ts`).
 *
 * Self-contained on purpose (only `ws` + node builtins, type-only imports) so it also runs with
 * plain `node` type stripping: `node apps/openclaw-channel/src/testing/run-fake-api.ts`.
 *
 *   GET  /agent-channel/v1/cell
 *   GET  /agent-channel/v1/ws            client {op:"sub", topic, afterSeq?} → {op:"ev"|"subscribed"|"err"|"pong"}
 *   POST /agent-channel/v1/messages      idempotent on agentId + idempotencyKey
 *   POST /agent-channel/v1/typing
 *   POST /agent-channel/v1/agents/:id/status
 *   POST /agent-channel/v1/runtime         records the report (`runtimeReports`)
 *   POST /agent-channel/v1/provider-auth  (status per report: `authResponder`, default 200)
 *   POST /agent-channel/v1/tool-calls     records the full body and allows (denies tools listed in `denyTools`); a tool
 *                                          set through POST /__test/tool-approval {tool, reply, waitingFor?, requesterName?}
 *                                          (`toolApprovals`) answers that reply instead: "allow" / "grant" allow it, any
 *                                          other reply is the refusal code, with `approval` {id, created, waitingFor,
 *                                          requesterName} for approval_required / approval_pending (07.5-04). The same
 *                                          control refuses /connectors/call for the logical tool `<connector>__<tool>`
 *                                          and /http-requests for `ocw_http_request` (409, `details.approval` likewise)
 *   POST /agent-channel/v1/tool-calls/:id/result  records the outcome
 *   POST /agent-channel/v1/memories       records the note (dedupes exact text per event's bot; 409 for
 *                                          events listed in `refuseMemoryEvents`)
 *   POST /agent-channel/v1/memory/list    no scope → `memoryScopes`; a scope → its files in `memoryFileStore` (under `folder`)
 *   POST /agent-channel/v1/memory/read    a file of `memoryFileStore` by scope alias / id and path (case-insensitive), else
 *                                          `{refused:"not_found"}`
 *   POST /agent-channel/v1/memory/write   personal / agent only (`own_scope_only`); append creates or appends, replace needs
 *                                          the current version (`version_conflict`); answers `{fileId, version}`
 *   POST /agent-channel/v1/memory/propose `secret_detected` for an `sk-…` key, else `{approvalId, findings (emails),
 *                                          readerCount: memoryReaderCount}`; nothing is written (a person approves). For a
 *                                          published turn, like the real API, the proposal also posts one platform-owned
 *                                          approval card answering the turn's message (`approvalCards`)
 *                                          All /memory routes: `memoryRefusals` forces a refusal per event; strict bodies
 *                                          (an unknown key is 400 bad_request, like the contract); every call in `memoryCalls`;
 *                                          a turn ended with `endTurn` (its human no longer reads the conversation) is
 *                                          403 `no_trigger` on every /memory route (`memoryNoTriggers`), like the real API
 *   POST /agent-channel/v1/cards          records the card (`cards`; idempotent on agentId + idempotencyKey, version 1)
 *   PATCH /agent-channel/v1/cards/:id     posting agent only (403), expectedVersion must match (409
 *                                          card_version_conflict); records the patch (`cardPatches`)
 *   POST /agent-channel/v1/board/read     a fixed two-column board (Backlog, In progress); the turn's card when the
 *                                          event's `threadRootId` names a stored board card (`boardTurnCards`), else null
 *   POST /agent-channel/v1/board/cards    records the card (`boardCards`; idempotent on agentId + idempotencyKey, 201
 *                                          then 200, version 1, the first column by default)
 *   PATCH /agent-channel/v1/board/cards/:id  move / waiting state of a stored board card (409
 *                                          board_card_version_conflict, 403 not_author on any text key)
 *   POST /agent-channel/v1/connectors/list  records the body (`connectorLists`) and answers one connected connector
 *                                          (`m1a2b3c4d` "Smoke CRM", tool whoami) and one key (`k_abcdefgh23`)
 *   POST /agent-channel/v1/connectors/call  records the body (`connectorCalls`) and answers `{content: "whoami: sub_smoke"}`
 *   POST /agent-channel/v1/http-requests    records the body (`httpRequests`) and answers `HTTP 200 {"login":"smoke"}`
 *                                          All three: 400 for any key beyond the contract's (never a user id); the
 *                                          `connectorControl` knobs (POST /__test/connectors {slowMs?, refusal?, result?})
 *                                          delay the call, refuse the call and the request with an AgentChannelToolRefusal
 *                                          code (404 unknown_turn, 502 upstream_error / egress_refused / timeout, 409
 *                                          otherwise; the error body carries FAKE_ERROR_CANARY, which must never reach the
 *                                          model) or replace the call's content. The upstream credential the real API
 *                                          would use (`connectorToken`) never leaves the fake: not in /cell, not in an
 *                                          answer.
 *   POST /agent-channel/v1/work-zone/projects   records the body (`workZone.projectLists`) and answers `workZone.projects`
 *                                          (default: billing-api on MacBook Pro, online, Claude Code ready)
 *   POST /agent-channel/v1/work-zone/proposals  records the body (`workZone.proposals`) and answers `{approvalId, created}`
 *                                          (the same approval for the same event, project, device, prompt and runtime,
 *                                          `created: false` then), or 200 `{refused: workZone.refused}`; 404 unknown_turn
 *                                          when that is the refusal, like the real API. Both: 400 for any key beyond the
 *                                          contract's (a mode, a model, a user id). POST /__test/work-zone
 *                                          {refused?, projects?} sets the knobs ({} resets them)
 *   POST /agent-channel/v1/automations/propose  (07.6) records the body (`automations.proposals`) and answers
 *                                          `{ok: true, approvalId, sentence}`; POST /agent-channel/v1/records/update
 *                                          records the body (`automations.recordUpdates`) and answers `{ok: true, code:
 *                                          null, sentence}`. Both: 400 for any key beyond the contract's. POST
 *                                          /__test/automations {propose?, record?: {status, code, sentence}} makes the
 *                                          route refuse with that status and `{ok: false, code, sentence}` ({} resets)
 *   POST /agent-channel/v1/sandbox/{exec,process,read,write,list,delete,share,import}  (07.8) records every body
 *                                          (`sandbox.calls`, refused ones included) and answers a canned result per
 *                                          route (exec `exited 0` with stdout `hi`); 400 for any key beyond the contract's
 *                                          (never a user id, a command string or a token). POST /__test/sandbox
 *                                          {exec?, results?, refusal?} replaces the knobs ({} resets them): `exec` the
 *                                          exec answer, `results` per route, `refusal` a `SandboxRefusal` code every
 *                                          sandbox route answers with its contract status (the body carries
 *                                          FAKE_ERROR_CANARY, which must never reach the model)
 *   POST /agent-channel/v1/browser/{open,snapshot,act,screenshot,wait,signin,close}  (07.8) records every body
 *                                          (`browser.calls`) and answers a canned result per route: open/snapshot on
 *                                          panel.example.test, whose snapshot reads the password `[redacted]` and also
 *                                          carries FAKE_PASSWORD_SENTINEL in `unredactedValue`, a field outside the
 *                                          contract the plugin must never render; screenshot a masked 8×8 JPEG. 400 for
 *                                          any key beyond the contract's (a selector, a script, a cookie). POST
 *                                          /__test/browser {results?, refusal?} replaces the knobs ({} resets them)
 *   POST /agent-channel/v1/mcp/probe-results  records the probe report (`mcpProbes`)
 *   POST /agent-channel/v1/plugins/report     records the report (`pluginReports`) and moves the row's status
 *   POST /agent-channel/v1/plugins/verify-install  approves only a row `installing` with the same package, version
 *                                          and sha256 (`verifyCalls`); like the real API, the install gate's authority
 *   GET  /agent-channel/v1/plugins            the rows with a plugin id (boot allowlist)
 * Test-only controls under /__test/* (never part of the real API).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type {
  AgentChannelBoardCreateCard,
  AgentChannelBoardPatchCard,
  AgentChannelMcpProbeResult,
  AgentChannelMemorySave,
  AgentChannelPatchCard,
  AgentChannelPluginReport,
  AgentChannelPostCard,
  AgentChannelPostMessage,
  AgentChannelProviderAuthReport,
  AgentChannelRuntimeReport,
  AgentChannelStatusReport,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  AgentChannelTyping,
  AgentChannelWorkZoneProjectsResponse,
  AgentMentionEvent,
  CellAgent,
  CellApprovedPlugin,
  CellMcpServer,
  CellProvider,
  CellSnapshot,
  CellSubscription,
} from "../agent-channel-protocol.js";

export type StoredEvent = { seq: number; type: string; data: Record<string, unknown> };
export type StoredMessage = AgentChannelPostMessage & { messageId: string; receivedAt: number };
export type StatusReport = AgentChannelStatusReport & { agentId: string };
export type MentionInput = Omit<AgentMentionEvent, "seq" | "type" | "organizationId" | "cellId">;
export type StoredToolCall = AgentChannelToolCallRequest & { callId: string; allowed: boolean };
export type StoredToolResult = AgentChannelToolCallResult & { callId: string };
export type StoredMemory = AgentChannelMemorySave & { memoryId: string; created: boolean };
/** One file of the fake memory store (`scope` is "personal", "agent" or a scope id, as the tools send it). */
export type FakeMemoryFile = { scope: string; path: string; version: number; content: string; id?: string };
/** A scope as `POST /memory/list` lists it (contracts `MemoryScope`). */
export type FakeMemoryScope = { id: string; kind: string; label: string; viewerCan: string[] };
export type MemoryRoute = "list" | "read" | "write" | "propose";
export type StoredMemoryCall = { route: MemoryRoute; body: Record<string, unknown> };
/**
 * The platform-owned approval card a proposal posts in the turn's conversation (the real API composes it from the
 * `memory.write` kind, ADR-0023 decision 14): never through `POST /cards`, never editable by the agent.
 */
export type StoredApprovalCard = {
  approvalId: string;
  messageId: string;
  eventId: string;
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  inReplyToMessageId: string;
  platformOwned: true;
  card: {
    kind: "approval";
    title: string;
    status: "pending";
    fields: Array<{ label: string; value: string }>;
    actions: Array<{ kind: "open"; label: string; target: string }>;
    summary: string;
  };
};
export type StoredCard = AgentChannelPostCard & { messageId: string; version: number };
export type StoredCardPatch = AgentChannelPatchCard & { messageId: string; status: number };
export type StoredBoardCard = AgentChannelBoardCreateCard & {
  messageId: string;
  columnId: string;
  waitingOn: string;
  version: number;
};
export type StoredBoardPatch = AgentChannelBoardPatchCard & { messageId: string; status: number };
/** Every POST /connectors/call body, as received (never a user id: the API reads the turn's human). */
export type StoredConnectorCall = Record<string, unknown> & { receivedAt?: number; answeredAt?: number };
/**
 * 07.5-04: what the fake API answers a tool's calls (`POST /__test/tool-approval`). "allow" and "grant" (a used grant)
 * allow the call; any other reply is the refusal code.
 */
export type ToolApprovalControl = {
  reply:
    | "approval_required"
    | "approval_pending"
    | "approval_denied"
    | "approval_used"
    | "arguments_too_large"
    | "arguments_invalid"
    | "too_many_pending"
    | "policy_changed"
    | "grant"
    | "allow";
  waitingFor?: string;
  requesterName?: string;
};
/** Test knobs of the connector routes (`POST /__test/connectors` replaces them). */
export type ConnectorControl = { slowMs?: number; refusal?: string; result?: string };
/** The fake Work Zone: what the routes recorded and answer (07.5-10). */
export type FakeWorkZone = {
  /** Every POST /work-zone/projects body, in order. */
  projectLists: Array<Record<string, unknown>>;
  /** Every POST /work-zone/proposals body, in order (refused ones included). */
  proposals: Array<Record<string, unknown>>;
  /** What POST /work-zone/projects answers. */
  projects: AgentChannelWorkZoneProjectsResponse["projects"];
  /** When set, every proposal is refused with this code. */
  refused?: string;
};
export const FAKE_WORK_ZONE_PROJECT = "0199a6f0-0000-7000-8000-00000000b111";
export const FAKE_WORK_ZONE_DEVICE = "0199a6f0-0000-7000-8000-00000000d111";
const fakeWorkZoneProjects = (): AgentChannelWorkZoneProjectsResponse["projects"] => [
  {
    projectId: FAKE_WORK_ZONE_PROJECT,
    name: "billing-api",
    device: { id: FAKE_WORK_ZONE_DEVICE, name: "MacBook Pro", online: true },
    runtimes: [{ id: "claude-code", label: "Claude Code", available: true }],
  },
];
const WORK_ZONE_BODY_KEYS = {
  projects: ["eventId", "agentId"],
  proposals: ["eventId", "agentId", "projectId", "deviceId", "prompt", "runtime"],
} as const;
/** 07.6: the automation proposal and watched-record routes' records and knobs (`POST /__test/automations`). */
export type FakeAutomations = {
  /** Every POST /automations/propose body, in order (refused ones included). */
  proposals: Array<Record<string, unknown>>;
  /** Every POST /records/update body, in order (refused ones included). */
  recordUpdates: Array<Record<string, unknown>>;
  /** When set, every proposal is answered with this status and `{ok: false, code, sentence}`. */
  proposeRefusal?: { status: number; code: string; sentence: string };
  /** When set, every record update is answered with this status and `{ok: false, code, sentence}`. */
  recordRefusal?: { status: number; code: string; sentence: string };
};
const AUTOMATION_PROPOSE_KEYS = [
  "eventId",
  "agentId",
  "name",
  "instructions",
  "schedule",
  "target",
  "maxRunsPerDay",
] as const;
const RECORD_UPDATE_KEYS = ["eventId", "agentId", "changes"] as const;
const refusalKnob = (v: unknown): FakeAutomations["proposeRefusal"] => {
  const r = v as { status?: unknown; code?: unknown; sentence?: unknown } | null;
  return r && typeof r.status === "number" && typeof r.code === "string" && typeof r.sentence === "string"
    ? { status: r.status, code: r.code, sentence: r.sentence }
    : undefined;
};
/** 07.8: the sandbox routes' records and knobs (`POST /__test/sandbox` replaces the knobs). */
export type FakeSandbox = {
  /** Every POST /sandbox/* body, in order (refused ones included). */
  calls: Array<{ route: string; body: Record<string, unknown> }>;
  /** What POST /sandbox/exec answers (default: exited 0, stdout `hi`). */
  exec?: Record<string, unknown>;
  /** Per route (`exec`, `read`, …): what it answers instead of the default. */
  results: Record<string, unknown>;
  /** When set, every sandbox route refuses with this code and its contract status. */
  refusal?: string;
};
/** The keys each sandbox body may carry (contracts `AgentChannelSandbox*`, strict objects). */
const SANDBOX_BODY_KEYS: Record<string, readonly string[]> = {
  exec: ["eventId", "agentId", "argv", "cwd", "timeoutSeconds", "background"],
  process: ["eventId", "agentId", "processId", "action"],
  read: ["eventId", "agentId", "path", "offset", "limit"],
  write: ["eventId", "agentId", "path", "content", "mode"],
  list: ["eventId", "agentId", "path"],
  delete: ["eventId", "agentId", "path", "recursive"],
  share: ["eventId", "agentId", "path"],
  import: ["eventId", "agentId", "attachmentId", "path"],
};
/** Contracts `SANDBOX_REFUSAL_STATUS` / `BROWSER_REFUSAL_STATUS` (403 for every other code). */
function confinedRefusalStatus(code: string): number {
  if (code === "not_found" || code === "no_context" || code === "screenshot_unavailable") return 404;
  if (code === "too_large") return 413;
  if (code === "invalid_path") return 422;
  if (code === "service_unavailable" || code === "timeout") return 503;
  if (
    code.startsWith("approval_") ||
    [
      "too_many_pending",
      "policy_changed",
      "disk_full",
      "busy",
      "paused",
      "signin_pending",
      "element_gone",
    ].includes(code)
  ) {
    return 409;
  }
  return 403;
}
const FAKE_FILE_TIME = "2026-10-15T09:00:00.000Z";
/** The default answer of each sandbox route for a valid body. */
function fakeSandboxResult(route: string, body: Record<string, unknown>): unknown {
  const path = typeof body.path === "string" ? body.path : "";
  switch (route) {
    case "exec":
      return { status: "exited", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, durationMs: 4 };
    case "process":
      return {
        status: "exited",
        exitCode: 0,
        stdout: "done\n",
        stderr: "",
        truncated: false,
        durationMs: 30_000,
      };
    case "read":
      return { path, content: "hello from the sandbox\n", encoding: "utf8", size: 23, truncated: false };
    case "write":
      return { path, size: new TextEncoder().encode(String(body.content ?? "")).length };
    case "list":
      return {
        path,
        entries: [
          {
            path: path ? `${path}/notes.txt` : "notes.txt",
            name: "notes.txt",
            kind: "file",
            size: 23,
            modifiedAt: FAKE_FILE_TIME,
            hidden: false,
          },
          {
            path: path ? `${path}/app` : "app",
            name: "app",
            kind: "dir",
            size: null,
            modifiedAt: FAKE_FILE_TIME,
            hidden: false,
          },
        ],
        more: 0,
      };
    case "delete":
      return { path, deleted: 1 };
    case "share":
      return { attachmentId: randomUUID(), name: path.split("/").at(-1) ?? path, size: 23 };
    default:
      return { path: path || "downloads/report.pdf", size: 1024 };
  }
}
/** 07.8: the browser routes' records and knobs (`POST /__test/browser` replaces the knobs). */
export type FakeBrowser = {
  /** Every POST /browser/* body, in order (refused ones included). */
  calls: Array<{ route: string; body: Record<string, unknown> }>;
  /** Per route (`open`, `snapshot`, …): what it answers instead of the default. */
  results: Record<string, unknown>;
  /** When set, every browser route refuses with this code and its contract status. */
  refusal?: string;
};
/** A password the fake browser "saw": only in a field outside the contract, so it must never reach the model (P-10). */
export const FAKE_PASSWORD_SENTINEL = "OCW-SENTINEL-PW-5521";
/** An 8×8 grey JPEG: what the fake browser's masked screenshot answers. */
export const FAKE_SCREENSHOT_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8AKKKKAP/Z";
const FAKE_BROWSER_CONTEXT = "0199a6f0-0000-7000-8000-0000000b5001";
const FAKE_BROWSER_HOST = "panel.example.test";
/** The keys each browser body may carry (contracts `AgentChannelBrowser*`, strict objects). */
const BROWSER_BODY_KEYS: Record<string, readonly string[]> = {
  open: ["eventId", "agentId", "url"],
  snapshot: ["eventId", "agentId"],
  act: ["eventId", "agentId", "action", "ref", "text", "key", "option", "direction"],
  screenshot: ["eventId", "agentId"],
  wait: ["eventId", "agentId", "for", "text", "ms"],
  signin: ["eventId", "agentId", "reason"],
  close: ["eventId", "agentId"],
};
/** The default answer of each browser route for a valid body. */
function fakeBrowserResult(route: string, body: Record<string, unknown>): unknown {
  const context = { contextId: FAKE_BROWSER_CONTEXT, host: FAKE_BROWSER_HOST };
  switch (route) {
    case "open": {
      let url: URL | undefined;
      try {
        url = new URL(String(body.url));
      } catch {
        /* the plugin checks URLs before posting */
      }
      return {
        ...context,
        host: url?.host ?? FAKE_BROWSER_HOST,
        secure: url?.protocol === "https:",
        title: "Panel Autofy — Sign in",
        signedIn: false,
      };
    }
    case "snapshot":
      return {
        ...context,
        title: "Panel Autofy — Sign in",
        text: '[r1] textbox "Email" value=""\n[r2] textbox "Password" value="[redacted]"\n[r3] button "Sign in"',
        truncated: false,
        signedIn: false,
        // Outside the contract: a careless renderer would leak it.
        unredactedValue: FAKE_PASSWORD_SENTINEL,
      };
    case "act":
      return { ...context, signedIn: false, navigated: body.action === "click", download: null };
    case "screenshot":
      return {
        ...context,
        image: { mimeType: "image/jpeg", data: FAKE_SCREENSHOT_JPEG, width: 8, height: 8, masked: 1 },
      };
    case "wait":
      return { ...context, ok: true };
    case "signin":
      return { posted: true, host: FAKE_BROWSER_HOST };
    default:
      return { closed: true };
  }
}
/** In every refusal body of the connector routes: a plugin must never relay it to the model. */
export const FAKE_ERROR_CANARY = "fake-api-error-body-canary";
export type VerifyCall = {
  packageName: string;
  version: string;
  sha256: string;
  approved: boolean;
  reason: string | null;
};

export type FakeAgentChannelApi = {
  url: string;
  server: Server;
  token: string;
  cellId: string;
  topic: string;
  agents: CellAgent[];
  providers: CellProvider[];
  /** Snapshot `subscriptions`; `undefined` = an older API that does not send the field. */
  cellSubscriptions: CellSubscription[] | undefined;
  /** Snapshot `webSearch.provider`; `undefined` = not sent. */
  webSearchProvider: string | undefined;
  /** Tools whose `/tool-calls` the fake API denies (`denied_by_test`). */
  denyTools: Set<string>;
  /** Tool (or logical connector tool) → the approval reply its calls get (07.5-04). */
  toolApprovals: Map<string, ToolApprovalControl>;
  /** Every POST /tool-calls body as received (the flagged tools' `arguments` included). */
  toolCalls: StoredToolCall[];
  toolResults: StoredToolResult[];
  /** Every POST /memories (also refused ones: `memoryId` "" and `created` false). */
  memories: StoredMemory[];
  /** Event ids whose memory saves the fake API refuses with 409 `tainted`. */
  refuseMemoryEvents: Set<string>;
  /** The fake memory files the /memory routes act on (tests seed it). */
  memoryFileStore: FakeMemoryFile[];
  /** What `POST /memory/list` without a scope answers (tests seed it). */
  memoryScopes: FakeMemoryScope[];
  /** The reader count every accepted proposal answers (default 1). */
  memoryReaderCount: number;
  /** Every POST /memory/* body, in order (refused ones included). */
  memoryCalls: StoredMemoryCall[];
  /** Event id → the refusal every /memory route answers for it (`{refused}` with 200, like the real API). */
  memoryRefusals: Map<string, string>;
  /** Approval cards posted by accepted proposals of published turns, in order. */
  approvalCards: StoredApprovalCard[];
  /** Every /memory call answered 403 `no_trigger` (an ended turn), in order. */
  memoryNoTriggers: Array<{ route: MemoryRoute; eventId: string }>;
  /** The turn's human no longer reads its conversation: every /memory route answers 403 `no_trigger` for it. */
  endTurn(eventId: string): void;
  /** Every card stored by POST /cards (idempotent retries are not stored twice); `version` follows the patches. */
  cards: StoredCard[];
  /** Every PATCH /cards/:id attempt with the status it got. */
  cardPatches: StoredCardPatch[];
  /** Every board card stored by POST /board/cards (idempotent retries are not stored twice). */
  boardCards: StoredBoardCard[];
  /** Every PATCH /board/cards/:id attempt with the status it got. */
  boardPatches: StoredBoardPatch[];
  /** Every POST /board/read (event ids). */
  boardReads: string[];
  /** Event id → the board card whose thread the turn runs in (what the real API reads from the stored turn). */
  boardTurnCards: Map<string, string>;
  /** Every POST /connectors/call body, in order (refused ones included), with when it arrived and was answered. */
  connectorCalls: StoredConnectorCall[];
  /** Every POST /connectors/list body, in order. */
  connectorLists: Array<Record<string, unknown>>;
  /** Every POST /http-requests body, in order (refused ones included). */
  httpRequests: Array<Record<string, unknown>>;
  /** The knobs of the connector routes. */
  connectorControl: ConnectorControl;
  /** The Work Zone proposal routes' records and knobs (07.5-10). */
  workZone: FakeWorkZone;
  /** The automation proposal and watched-record update routes' records and knobs (07.6). */
  automations: FakeAutomations;
  /** The sandbox routes' records and knobs (07.8). */
  sandbox: FakeSandbox;
  /** The browser routes' records and knobs (07.8). */
  browser: FakeBrowser;
  /** Snapshot `mcpServers` (header values included, as the real API sends them); `[]` = none. */
  mcpServers: CellMcpServer[];
  /** Every POST /mcp/probe-results, in order. */
  mcpProbes: AgentChannelMcpProbeResult[];
  /** Number of GET /cell requests served. */
  cellReads: number;
  /** Snapshot `plugins` (approved marketplace plugins); publishing a plugin event moves its row's status. */
  plugins: CellApprovedPlugin[];
  /** Every POST /plugins/report attempt, in order (404s for unknown rows included). */
  pluginReports: AgentChannelPluginReport[];
  /** Every POST /plugins/verify-install (the install gate's questions) with the answer. */
  verifyCalls: VerifyCall[];
  events: StoredEvent[];
  authReports: AgentChannelProviderAuthReport[];
  /** HTTP status for each POST /provider-auth (default 200). */
  authResponder: (report: AgentChannelProviderAuthReport) => number;
  messages: StoredMessage[];
  /** Every POST /messages attempt, including retries and failures. */
  messageAttempts: AgentChannelPostMessage[];
  typing: AgentChannelTyping[];
  statusReports: StatusReport[];
  /** Every POST /runtime (why the cell runs without its channel), in order. */
  runtimeReports: AgentChannelRuntimeReport[];
  /** `afterSeq` of every accepted `sub` (null = live), in order. */
  subscriptions: Array<number | null>;
  authFailures: number;
  publish(type: string, data: Record<string, unknown>): StoredEvent;
  publishMention(input: MentionInput): StoredEvent;
  /** Replace agents/providers and emit `cell.config.changed` (`agentId` names the bot it is about). */
  updateCell(
    next: {
      agents?: CellAgent[];
      providers?: CellProvider[];
      subscriptions?: CellSubscription[];
      mcpServers?: CellMcpServer[];
    },
    reason?: string,
    agentId?: string | null,
  ): StoredEvent;
  /** Next `n` POST /messages respond with `status` (before idempotency handling). */
  failNextPosts(n: number, status?: number): void;
  /** Close every open plugin socket (simulates an API restart / network blip). */
  dropConnections(): void;
  /** Send `{op:"resync"}` to every subscribed socket. */
  sendResync(): void;
  openSockets(): number;
  waitFor<T>(fn: () => T | undefined | false | null, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
};

const BASE = "/agent-channel/v1";

/** The fake board every board route acts on (the real API reads it from the stored turn). */
const FAKE_BOARD_ID = "0199a000-0000-7000-8000-0000000b0a2d";
export const FAKE_BOARD_COLUMNS = [
  {
    id: "0199a000-0000-7000-8000-0000000b0c01",
    conversationId: FAKE_BOARD_ID,
    name: "Backlog",
    rank: "a0",
    category: "backlog",
    defaultWaitingOn: null,
  },
  {
    id: "0199a000-0000-7000-8000-0000000b0c02",
    conversationId: FAKE_BOARD_ID,
    name: "In progress",
    rank: "a1",
    category: "started",
    defaultWaitingOn: null,
  },
];

function boardCardOut(c: StoredBoardCard) {
  const firstLine = (c.description ?? "").split("\n").find((l) => l.trim()) ?? "";
  return {
    messageId: c.messageId,
    conversationId: FAKE_BOARD_ID,
    columnId: c.columnId,
    rank: "a0",
    waitingOn: c.waitingOn,
    title: c.title ?? firstLine.trim().slice(0, 80),
    titleSource: c.title ? "user" : "heuristic",
    description: c.description ?? "",
    number: null,
    fields: {},
    authorKind: "agent",
    authorId: c.agentId,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    movedAt: "2026-10-12T10:00:00.000Z",
    version: c.version,
  };
}

/** The keys each connector / keychain body may carry: never a user (the API reads the stored turn's human). */
const CONNECTOR_BODY_KEYS = {
  list: ["eventId", "agentId"],
  call: ["eventId", "agentId", "connector", "tool", "arguments"],
  http: ["eventId", "agentId", "handle", "method", "url", "headers", "body"],
} as const;

/** The refusal (and the approval it waits on) a tool's approval control answers; undefined = allowed. */
function approvalRefusalOf(control: ToolApprovalControl | undefined):
  | {
      code: string;
      approval?: { id: string; created: boolean; waitingFor: string; requesterName: string };
    }
  | undefined {
  if (!control || control.reply === "allow" || control.reply === "grant") return undefined;
  const waits = control.reply === "approval_required" || control.reply === "approval_pending";
  return {
    code: control.reply,
    ...(waits
      ? {
          approval: {
            id: randomUUID(),
            created: control.reply === "approval_required",
            waitingFor: control.waitingFor ?? "a lead of Sales",
            requesterName: control.requesterName ?? "Ana Pérez",
          },
        }
      : {}),
  };
}

/** The status the real API answers a refusal code with. */
function refusalStatus(code: string): number {
  if (code === "unknown_turn") return 404;
  if (code === "upstream_error" || code === "egress_refused" || code === "timeout") return 502;
  return 409;
}

/** A stable id per fake file (assigned on first use). */
function memoryFileId(f: FakeMemoryFile): string {
  f.id ??= randomUUID();
  return f.id;
}

/** The keys each /memory body may carry (the contract's strict objects): never an owner or user id. */
const MEMORY_BODY_KEYS: Record<MemoryRoute, readonly string[]> = {
  list: ["eventId", "agentId", "scope", "folder"],
  read: ["eventId", "agentId", "scope", "path"],
  write: ["eventId", "agentId", "scope", "path", "mode", "content", "expectedVersion"],
  propose: ["eventId", "agentId", "scope", "path", "op", "content", "baseVersion", "reason"],
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function startFakeAgentChannelApi(
  opts: {
    token?: string;
    cellId?: string;
    agents?: CellAgent[];
    providers?: CellProvider[];
    subscriptions?: CellSubscription[];
    webSearchProvider?: string;
    denyTools?: string[];
    mcpServers?: CellMcpServer[];
    plugins?: CellApprovedPlugin[];
    /** The member credential the real API would use upstream: held here only, never sent anywhere (07.4 C-01). */
    connectorToken?: string;
    port?: number;
    host?: string;
  } = {},
): Promise<FakeAgentChannelApi> {
  const token = opts.token ?? "test-cell-token";
  const cellId = opts.cellId ?? "0199a000-0000-7000-8000-0000000000c1";
  const topic = `cell:${cellId}`;
  const subscribed = new Set<WebSocket>();
  const sockets = new Set<WebSocket>();
  let failures = { n: 0, status: 503 };
  const byKey = new Map<string, StoredMessage>();
  /** Work Zone proposal → approval id (a retry of the same proposal gets the same approval). */
  const workZoneApprovals = new Map<string, string>();
  /** Current flow per plugin row (set when a plugin command is published), as `cell_plugins.flow_id`. */
  const pluginFlows = new Map<string, string>();

  const state = {
    agents: opts.agents ?? [],
    providers: opts.providers ?? [],
    cellSubscriptions: opts.subscriptions as CellSubscription[] | undefined,
    authReports: [] as AgentChannelProviderAuthReport[],
    authResponder: (() => 200) as (report: AgentChannelProviderAuthReport) => number,
    events: [] as StoredEvent[],
    messages: [] as StoredMessage[],
    messageAttempts: [] as AgentChannelPostMessage[],
    typing: [] as AgentChannelTyping[],
    statusReports: [] as StatusReport[],
    runtimeReports: [] as AgentChannelRuntimeReport[],
    subscriptions: [] as Array<number | null>,
    authFailures: 0,
    webSearchProvider: opts.webSearchProvider,
    denyTools: new Set(opts.denyTools ?? []),
    toolApprovals: new Map<string, ToolApprovalControl>(),
    toolCalls: [] as StoredToolCall[],
    toolResults: [] as StoredToolResult[],
    memories: [] as StoredMemory[],
    refuseMemoryEvents: new Set<string>(),
    memoryFileStore: [] as FakeMemoryFile[],
    memoryScopes: [] as FakeMemoryScope[],
    memoryReaderCount: 1,
    memoryCalls: [] as StoredMemoryCall[],
    memoryRefusals: new Map<string, string>(),
    endedTurns: new Set<string>(),
    approvalCards: [] as StoredApprovalCard[],
    memoryNoTriggers: [] as Array<{ route: MemoryRoute; eventId: string }>,
    cards: [] as StoredCard[],
    cardPatches: [] as StoredCardPatch[],
    boardCards: [] as StoredBoardCard[],
    boardPatches: [] as StoredBoardPatch[],
    boardReads: [] as string[],
    boardTurnCards: new Map<string, string>(),
    connectorCalls: [] as StoredConnectorCall[],
    connectorLists: [] as Array<Record<string, unknown>>,
    httpRequests: [] as Array<Record<string, unknown>>,
    connectorControl: {} as ConnectorControl,
    workZone: { projectLists: [], proposals: [], projects: fakeWorkZoneProjects() } as FakeWorkZone,
    automations: { proposals: [], recordUpdates: [] } as FakeAutomations,
    sandbox: { calls: [], results: {} } as FakeSandbox,
    browser: { calls: [], results: {} } as FakeBrowser,
    // Never serialized: not in /cell, not in an answer, not in the state dump.
    connectorToken: opts.connectorToken ?? "fake-connector-token",
    mcpServers: opts.mcpServers ?? ([] as CellMcpServer[]),
    mcpProbes: [] as AgentChannelMcpProbeResult[],
    cellReads: 0,
    plugins: opts.plugins ?? ([] as CellApprovedPlugin[]),
    pluginReports: [] as AgentChannelPluginReport[],
    verifyCalls: [] as VerifyCall[],
  };

  const snapshot = (): CellSnapshot => ({
    protocolVersion: 1,
    cellId,
    organizationId: cellId,
    topic,
    lastSeq: state.events.at(-1)?.seq ?? 0,
    agents: state.agents,
    providers: state.providers,
    ...(state.cellSubscriptions ? { subscriptions: state.cellSubscriptions } : {}),
    ...(state.webSearchProvider ? { webSearch: { provider: state.webSearchProvider } } : {}),
    ...(state.mcpServers.length > 0 ? { mcpServers: state.mcpServers } : {}),
    plugins: state.plugins.filter((p) => p.status !== "uninstalled"),
  });
  const frameFor = (ev: StoredEvent) =>
    JSON.stringify({ op: "ev", topic, seq: ev.seq, type: ev.type, data: ev.data });
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/__test/")) {
        if (req.method === "POST" && url.pathname === "/__test/mention") {
          return json(res, 200, api.publishMention((await readJson(req)) as MentionInput));
        }
        if (req.method === "POST" && url.pathname === "/__test/cell") {
          const body = (await readJson(req)) as {
            agents?: CellAgent[];
            providers?: CellProvider[];
            mcpServers?: CellMcpServer[];
            reason?: string;
            agentId?: string | null;
          };
          return json(res, 200, api.updateCell(body, body.reason, body.agentId ?? null));
        }
        if (req.method === "POST" && url.pathname === "/__test/plugins") {
          // Replace the approved list without an event (the smoke publishes the install event next).
          state.plugins = ((await readJson(req)) as { plugins: CellApprovedPlugin[] }).plugins ?? [];
          return json(res, 200, { ok: true, plugins: state.plugins });
        }
        if (req.method === "POST" && url.pathname === "/__test/memory") {
          // Seed the fake memory store (files, scopes, the reader count proposals answer).
          const body = (await readJson(req)) as {
            files?: FakeMemoryFile[];
            scopes?: FakeMemoryScope[];
            readerCount?: number;
          };
          state.memoryFileStore.push(...(body.files ?? []));
          state.memoryScopes.push(...(body.scopes ?? []));
          if (typeof body.readerCount === "number") state.memoryReaderCount = body.readerCount;
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/connectors") {
          // Replace the connector knobs ({} resets them).
          const body = ((await readJson(req)) ?? {}) as ConnectorControl;
          state.connectorControl = {
            ...(typeof body.slowMs === "number" ? { slowMs: body.slowMs } : {}),
            ...(typeof body.refusal === "string" ? { refusal: body.refusal } : {}),
            ...(typeof body.result === "string" ? { result: body.result } : {}),
          };
          return json(res, 200, { ok: true, control: state.connectorControl });
        }
        if (req.method === "POST" && url.pathname === "/__test/work-zone") {
          // Replace the Work Zone knobs ({} resets them; the records stay).
          const body = ((await readJson(req)) ?? {}) as {
            refused?: unknown;
            projects?: AgentChannelWorkZoneProjectsResponse["projects"];
          };
          state.workZone.projects = Array.isArray(body.projects) ? body.projects : fakeWorkZoneProjects();
          if (typeof body.refused === "string") state.workZone.refused = body.refused;
          else delete state.workZone.refused;
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/automations") {
          // Replace the 07.6 knobs ({} resets them; the records stay).
          const body = ((await readJson(req)) ?? {}) as { propose?: unknown; record?: unknown };
          const propose = refusalKnob(body.propose);
          const record = refusalKnob(body.record);
          if (propose) state.automations.proposeRefusal = propose;
          else delete state.automations.proposeRefusal;
          if (record) state.automations.recordRefusal = record;
          else delete state.automations.recordRefusal;
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/sandbox") {
          // Replace the sandbox knobs ({} resets them; the records stay).
          const body = ((await readJson(req)) ?? {}) as Partial<FakeSandbox>;
          const sb = state.sandbox;
          if (body.exec && typeof body.exec === "object") sb.exec = body.exec;
          else delete sb.exec;
          sb.results = body.results && typeof body.results === "object" ? body.results : {};
          if (typeof body.refusal === "string") sb.refusal = body.refusal;
          else delete sb.refusal;
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/browser") {
          // Replace the browser knobs ({} resets them; the records stay).
          const body = ((await readJson(req)) ?? {}) as Partial<FakeBrowser>;
          const br = state.browser;
          br.results = body.results && typeof body.results === "object" ? body.results : {};
          if (typeof body.refusal === "string") br.refusal = body.refusal;
          else delete br.refusal;
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/tool-approval") {
          // One tool's approval reply; no reply clears it.
          const body = ((await readJson(req)) ?? {}) as Partial<ToolApprovalControl> & { tool?: string };
          if (typeof body.tool !== "string" || !body.tool)
            return json(res, 400, { error: { code: "bad_request" } });
          if (typeof body.reply !== "string") state.toolApprovals.delete(body.tool);
          else {
            state.toolApprovals.set(body.tool, {
              reply: body.reply,
              ...(typeof body.waitingFor === "string" ? { waitingFor: body.waitingFor } : {}),
              ...(typeof body.requesterName === "string" ? { requesterName: body.requesterName } : {}),
            });
          }
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/end-turn") {
          api.endTurn(String(((await readJson(req)) as { eventId?: string }).eventId ?? ""));
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__test/event") {
          const { type, data } = (await readJson(req)) as { type: string; data: Record<string, unknown> };
          return json(res, 200, api.publish(type, data));
        }
        if (req.method === "GET" && url.pathname === "/__test/state") {
          return json(res, 200, {
            messages: state.messages,
            typing: state.typing,
            statusReports: state.statusReports,
            runtimeReports: state.runtimeReports,
            subscriptions: state.subscriptions,
            authReports: state.authReports,
            events: state.events.length,
            toolCalls: state.toolCalls,
            toolResults: state.toolResults,
            memories: state.memories,
            memoryCalls: state.memoryCalls,
            memoryFileStore: state.memoryFileStore,
            memoryNoTriggers: state.memoryNoTriggers,
            approvalCards: state.approvalCards,
            cards: state.cards,
            cardPatches: state.cardPatches,
            boardCards: state.boardCards,
            boardPatches: state.boardPatches,
            boardReads: state.boardReads,
            connectorCalls: state.connectorCalls,
            connectorLists: state.connectorLists,
            httpRequests: state.httpRequests,
            workZone: state.workZone,
            automations: state.automations,
            sandbox: state.sandbox,
            browser: state.browser,
            mcpProbes: state.mcpProbes,
            cellReads: state.cellReads,
            plugins: state.plugins,
            pluginReports: state.pluginReports,
            verifyCalls: state.verifyCalls,
          });
        }
        return json(res, 404, { error: { code: "not_found" } });
      }
      if (!url.pathname.startsWith(BASE)) return json(res, 404, { error: { code: "not_found" } });
      if (!authorized(req)) {
        state.authFailures++;
        return json(res, 401, { error: { code: "invalid_cell_token" } });
      }
      const route = url.pathname.slice(BASE.length);
      if (req.method === "GET" && route === "/cell") {
        state.cellReads++;
        return json(res, 200, snapshot());
      }
      if (req.method === "POST" && route === "/mcp/probe-results") {
        const body = (await readJson(req)) as AgentChannelMcpProbeResult;
        if (!body.probeId || !body.serverId || typeof body.ok !== "boolean") {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        state.mcpProbes.push(body);
        return json(res, 200, { ok: true, applied: true });
      }
      if (req.method === "POST" && route === "/plugins/report") {
        const body = (await readJson(req)) as AgentChannelPluginReport;
        if (!body.flowId || !body.pluginRowId || !body.state) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        // Every attempt is recorded (also the ones answered 404, like a report for a row the API never approved).
        state.pluginReports.push(body);
        const row = state.plugins.find((p) => p.pluginRowId === body.pluginRowId);
        // Like the API: only the row's current flow (the last command published for it) may change it.
        const current = row ? pluginFlows.get(row.pluginRowId) : undefined;
        if (!row || (current !== undefined && current !== body.flowId)) {
          return json(res, 404, { error: { code: "plugin_flow_not_found" } });
        }
        if (body.state === "installed") {
          row.status = "installed";
          if (body.pluginId) row.pluginId = body.pluginId;
        } else if (body.state === "failed") row.status = "failed";
        else if (body.state === "uninstalled") row.status = "uninstalled";
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/plugins/verify-install") {
        const body = (await readJson(req)) as { packageName?: string; version?: string; sha256?: string };
        if (!body.packageName || !body.version || !/^[0-9a-f]{64}$/u.test(body.sha256 ?? "")) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const same = state.plugins.filter((p) => p.packageName === body.packageName);
        const row = same.find(
          (p) => p.status === "installing" && p.version === body.version && p.sha256 === body.sha256,
        );
        const reason = row
          ? null
          : same.length === 0
            ? "not_approved"
            : !same.some((p) => p.status === "installing")
              ? "not_in_flight"
              : !same.some((p) => p.version === body.version)
                ? "version_mismatch"
                : "digest_mismatch";
        const call: VerifyCall = {
          packageName: body.packageName,
          version: body.version,
          sha256: body.sha256 as string,
          approved: Boolean(row),
          reason,
        };
        state.verifyCalls.push(call);
        return json(res, 200, { approved: call.approved, reason });
      }
      if (req.method === "GET" && route === "/plugins") {
        const plugins = state.plugins
          .filter((p) => p.pluginId && ["installing", "installed", "uninstalling"].includes(p.status))
          .map((p) => ({
            pluginId: p.pluginId,
            packageName: p.packageName,
            version: p.version,
            status: p.status,
          }));
        return json(res, 200, { plugins });
      }
      if (req.method === "POST" && route === "/messages") {
        const body = (await readJson(req)) as AgentChannelPostMessage;
        state.messageAttempts.push(body);
        if (failures.n > 0) {
          failures.n--;
          return json(res, failures.status, { error: { code: "unavailable", message: "injected failure" } });
        }
        if (
          !body.agentId ||
          !body.conversationId ||
          !body.text ||
          !body.idempotencyKey ||
          !("threadRootMessageId" in body)
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (!state.agents.some((a) => a.id === body.agentId))
          return json(res, 404, { error: { code: "agent_not_found" } });
        const key = `${body.agentId}:${body.idempotencyKey}`;
        const existing = byKey.get(key);
        const reply = (m: StoredMessage, created: boolean) => ({
          messageId: m.messageId,
          created,
          conversationId: m.conversationId,
          threadRootMessageId: m.threadRootMessageId,
        });
        if (existing) return json(res, 200, reply(existing, false));
        const stored: StoredMessage = { ...body, messageId: randomUUID(), receivedAt: Date.now() };
        byKey.set(key, stored);
        state.messages.push(stored);
        return json(res, 200, reply(stored, true));
      }
      if (req.method === "POST" && route === "/provider-auth") {
        const report = (await readJson(req)) as AgentChannelProviderAuthReport;
        state.authReports.push(report);
        const status = state.authResponder(report);
        return status === 200
          ? json(res, 200, { ok: true })
          : json(res, status, { error: { code: status === 409 ? "flow_claimed" : "error" } });
      }
      if (req.method === "POST" && route === "/tool-calls") {
        const body = (await readJson(req)) as AgentChannelToolCallRequest;
        const refusal = approvalRefusalOf(state.toolApprovals.get(body.tool));
        const allowed = !state.denyTools.has(body.tool) && !refusal;
        const stored: StoredToolCall = { ...body, callId: randomUUID(), allowed };
        state.toolCalls.push(stored);
        return json(res, 200, {
          callId: stored.callId,
          allowed,
          reason: allowed ? null : (refusal?.code ?? "denied_by_test"),
          ...(refusal?.approval ? { approval: refusal.approval } : {}),
        });
      }
      const resultMatch = /^\/tool-calls\/([^/]+)\/result$/u.exec(route);
      if (req.method === "POST" && resultMatch?.[1]) {
        const callId = decodeURIComponent(resultMatch[1]);
        if (!state.toolCalls.some((c) => c.callId === callId && c.allowed)) {
          return json(res, 404, { error: { code: "unknown_call" } });
        }
        state.toolResults.push({ ...((await readJson(req)) as AgentChannelToolCallResult), callId });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/memories") {
        const body = (await readJson(req)) as AgentChannelMemorySave;
        if (!body.eventId || !body.agentId || typeof body.text !== "string" || body.text.length > 500) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (state.refuseMemoryEvents.has(body.eventId)) {
          state.memories.push({ ...body, memoryId: "", created: false });
          return json(res, 409, { error: { code: "tainted", message: "refused by test" } });
        }
        const same = state.memories.find(
          (m) => m.memoryId && m.agentId === body.agentId && m.text === body.text,
        );
        const stored: StoredMemory = { ...body, memoryId: same?.memoryId ?? randomUUID(), created: !same };
        state.memories.push(stored);
        return json(res, 200, { memoryId: stored.memoryId, created: stored.created });
      }
      const connectorRoute =
        route === "/connectors/list"
          ? "list"
          : route === "/connectors/call"
            ? "call"
            : route === "/http-requests"
              ? "http"
              : undefined;
      if (req.method === "POST" && connectorRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const stored: StoredConnectorCall = { ...body };
        if (connectorRoute === "list") state.connectorLists.push(stored);
        else if (connectorRoute === "call") state.connectorCalls.push(stored);
        else state.httpRequests.push(stored);
        const allowed: readonly string[] = CONNECTOR_BODY_KEYS[connectorRoute];
        const required =
          connectorRoute === "call"
            ? ["connector", "tool"]
            : connectorRoute === "http"
              ? ["handle", "method", "url"]
              : [];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          required.some((k) => typeof body[k] !== "string") ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const control = state.connectorControl;
        if (connectorRoute === "list") {
          return json(res, 200, {
            connectors: [
              {
                connector: "m1a2b3c4d",
                name: "Smoke CRM",
                status: "connected",
                tools: [
                  {
                    name: "whoami",
                    description: "Who the signed-in member is.",
                    inputSchema: { type: "object" },
                  },
                ],
              },
            ],
            keys: [{ handle: "k_abcdefgh23", name: "Smoke API", allowedHosts: ["api.example.com"] }],
          });
        }
        if (connectorRoute === "call") {
          stored.receivedAt = Date.now();
          if (control.slowMs) await new Promise((r) => setTimeout(r, control.slowMs));
        }
        const approvalRefusal = approvalRefusalOf(
          state.toolApprovals.get(
            connectorRoute === "call"
              ? `${String(body.connector)}__${String(body.tool)}`
              : "ocw_http_request",
          ),
        );
        if (approvalRefusal) {
          stored.answeredAt = Date.now();
          return json(res, refusalStatus(approvalRefusal.code), {
            error: {
              code: approvalRefusal.code,
              message: `refused by test ${FAKE_ERROR_CANARY}`,
              ...(approvalRefusal.approval ? { details: { approval: approvalRefusal.approval } } : {}),
            },
          });
        }
        if (control.refusal) {
          stored.answeredAt = Date.now();
          return json(res, refusalStatus(control.refusal), {
            error: { code: control.refusal, message: `refused by test ${FAKE_ERROR_CANARY}` },
          });
        }
        if (connectorRoute === "call") {
          stored.answeredAt = Date.now();
          return json(res, 200, {
            content: control.result ?? "whoami: sub_smoke",
            truncated: false,
            isError: false,
          });
        }
        return json(res, 200, {
          status: 200,
          contentType: "application/json",
          body: '{"login":"smoke"}',
          truncated: false,
          redirectHost: null,
        });
      }
      const sandboxRoute = /^\/sandbox\/(exec|process|read|write|list|delete|share|import)$/u.exec(
        route,
      )?.[1];
      if (req.method === "POST" && sandboxRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const sb = state.sandbox;
        sb.calls.push({ route: sandboxRoute, body: { ...body } });
        const allowed = SANDBOX_BODY_KEYS[sandboxRoute] ?? [];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request", message: `bad body ${FAKE_ERROR_CANARY}` } });
        }
        if (sb.refusal) {
          return json(res, confinedRefusalStatus(sb.refusal), {
            error: { code: sb.refusal, message: `refused by test ${FAKE_ERROR_CANARY}` },
          });
        }
        const canned = sandboxRoute === "exec" && sb.exec ? sb.exec : sb.results[sandboxRoute];
        return json(res, 200, canned ?? fakeSandboxResult(sandboxRoute, body));
      }
      const browserRoute = /^\/browser\/(open|snapshot|act|screenshot|wait|signin|close)$/u.exec(route)?.[1];
      if (req.method === "POST" && browserRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const br = state.browser;
        br.calls.push({ route: browserRoute, body: { ...body } });
        const allowed = BROWSER_BODY_KEYS[browserRoute] ?? [];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request", message: `bad body ${FAKE_ERROR_CANARY}` } });
        }
        if (br.refusal) {
          return json(res, confinedRefusalStatus(br.refusal), {
            error: { code: br.refusal, message: `refused by test ${FAKE_ERROR_CANARY}` },
          });
        }
        return json(res, 200, br.results[browserRoute] ?? fakeBrowserResult(browserRoute, body));
      }
      if (req.method === "POST" && (route === "/automations/propose" || route === "/records/update")) {
        // 07.6: record the body; 400 for any key beyond the contract's (a conversation, a person, a record id, a hash).
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const propose = route === "/automations/propose";
        const auto = state.automations;
        (propose ? auto.proposals : auto.recordUpdates).push({ ...body });
        const allowed: readonly string[] = propose ? AUTOMATION_PROPOSE_KEYS : RECORD_UPDATE_KEYS;
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request", message: `bad body ${FAKE_ERROR_CANARY}` } });
        }
        const refusal = propose ? auto.proposeRefusal : auto.recordRefusal;
        if (refusal) {
          return json(res, refusal.status, { ok: false, code: refusal.code, sentence: refusal.sentence });
        }
        if (propose) {
          const name = typeof body.name === "string" ? body.name : "it";
          return json(res, 200, {
            ok: true,
            approvalId: randomUUID(),
            sentence: `I posted a card proposing “${name}”. The person has to confirm it. Tell them in one short sentence, without repeating the details.`,
          });
        }
        return json(res, 200, { ok: true, code: null, sentence: "Updated SO-10442 in ERP." });
      }
      const workZoneRoute =
        route === "/work-zone/projects"
          ? "projects"
          : route === "/work-zone/proposals"
            ? "proposals"
            : undefined;
      if (req.method === "POST" && workZoneRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const wz = state.workZone;
        (workZoneRoute === "projects" ? wz.projectLists : wz.proposals).push({ ...body });
        const allowed: readonly string[] = WORK_ZONE_BODY_KEYS[workZoneRoute];
        const required = workZoneRoute === "proposals" ? ["projectId", "deviceId", "prompt"] : [];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          required.some((k) => typeof body[k] !== "string") ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request", message: `bad body ${FAKE_ERROR_CANARY}` } });
        }
        if (workZoneRoute === "projects") return json(res, 200, { projects: wz.projects });
        if (wz.refused === "unknown_turn") {
          return json(res, 404, {
            error: { code: "unknown_turn", message: `refused by test ${FAKE_ERROR_CANARY}` },
          });
        }
        if (wz.refused) return json(res, 200, { refused: wz.refused });
        const key = JSON.stringify([
          body.eventId,
          body.projectId,
          body.deviceId,
          body.prompt,
          body.runtime ?? null,
        ]);
        const known = workZoneApprovals.get(key);
        const approvalId = known ?? randomUUID();
        workZoneApprovals.set(key, approvalId);
        return json(res, 200, { approvalId, created: !known });
      }
      const memoryRoute = /^\/memory\/(list|read|write|propose)$/u.exec(route)?.[1] as
        | MemoryRoute
        | undefined;
      if (req.method === "POST" && memoryRoute) {
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        state.memoryCalls.push({ route: memoryRoute, body });
        const allowed = MEMORY_BODY_KEYS[memoryRoute];
        if (
          typeof body.eventId !== "string" ||
          typeof body.agentId !== "string" ||
          Object.keys(body).some((k) => !allowed.includes(k))
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (state.endedTurns.has(body.eventId)) {
          state.memoryNoTriggers.push({ route: memoryRoute, eventId: body.eventId });
          return json(res, 403, { error: { code: "no_trigger", message: "This call answers no live turn" } });
        }
        const forced = state.memoryRefusals.get(body.eventId);
        if (forced) return json(res, 200, { refused: forced });
        const key = (p: unknown) => String(p).normalize("NFC").toLowerCase();
        const find = (scope: unknown, p: unknown) =>
          state.memoryFileStore.find((f) => f.scope === scope && key(f.path) === key(p));
        if (memoryRoute === "list") {
          if (body.scope === undefined) return json(res, 200, { scopes: state.memoryScopes });
          const folder = typeof body.folder === "string" ? key(body.folder) : "";
          const files = state.memoryFileStore
            .filter((f) => f.scope === body.scope && key(f.path).startsWith(folder))
            .map((f) => ({
              id: memoryFileId(f),
              scopeId: f.scope,
              path: f.path,
              version: f.version,
              bytes: Buffer.byteLength(f.content),
              updatedAt: new Date(0).toISOString(),
              updatedBy: { kind: "agent", id: body.agentId, displayName: "fake", onBehalfOf: null },
            }));
          return json(res, 200, { files });
        }
        if (memoryRoute === "read") {
          const file = find(body.scope, body.path);
          if (!file) return json(res, 200, { refused: "not_found" });
          return json(res, 200, { file: { path: file.path, version: file.version, content: file.content } });
        }
        if (memoryRoute === "write") {
          if (body.scope !== "personal" && body.scope !== "agent")
            return json(res, 200, { refused: "own_scope_only" });
          const file = find(body.scope, body.path);
          const content = String(body.content);
          if (body.mode === "replace" && file && body.expectedVersion !== file.version) {
            return json(res, 200, { refused: "version_conflict" });
          }
          if (!file) {
            const created = { scope: body.scope, path: String(body.path), version: 1, content };
            state.memoryFileStore.push(created);
            return json(res, 200, { fileId: memoryFileId(created), version: 1 });
          }
          file.content =
            body.mode === "append"
              ? `${file.content}${file.content.endsWith("\n") || !file.content ? "" : "\n"}${content}`
              : content;
          file.version++;
          return json(res, 200, { fileId: memoryFileId(file), version: file.version });
        }
        const proposed = String(body.content);
        if (/sk-[A-Za-z0-9_-]{16,}/u.test(proposed)) return json(res, 200, { refused: "secret_detected" });
        const emails = proposed.match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/giu) ?? [];
        const approvalId = randomUUID();
        // The turn's conversation, as the real API reads it from the stored turn (only a published one here).
        const delivered = state.events.find(
          (e) => e.type === "agent.mention.v1" && e.data.eventId === body.eventId,
        )?.data as
          | {
              conversation?: { id?: string };
              thread?: { rootMessageId?: string | null };
              message?: { id?: string };
            }
          | undefined;
        if (delivered?.conversation?.id && delivered.message?.id) {
          const op = String(body.op);
          const title = `${op === "create" ? "Create" : op === "replace" ? "Rewrite" : "Append to"} ${String(body.path)}`;
          state.approvalCards.push({
            approvalId,
            messageId: randomUUID(),
            eventId: body.eventId,
            agentId: body.agentId,
            conversationId: delivered.conversation.id,
            threadRootId: delivered.thread?.rootMessageId ?? null,
            inReplyToMessageId: delivered.message.id,
            platformOwned: true,
            card: {
              kind: "approval",
              title,
              status: "pending",
              fields: [
                { label: "Readers", value: `${state.memoryReaderCount} people` },
                { label: "Found", value: emails.length > 0 ? "Email" : "Nothing" },
              ],
              actions: [{ kind: "open", label: "Review changes", target: `/memory/proposals/${approvalId}` }],
              summary: proposed
                .split("\n")
                .map((l) => `+ ${l}`)
                .join("\n"),
            },
          });
        }
        return json(res, 200, {
          approvalId,
          findings:
            emails.length > 0
              ? [
                  {
                    kind: "email",
                    severity: "warn",
                    source: "builtin",
                    count: emails.length,
                    samples: [],
                    lines: [],
                  },
                ]
              : [],
          readerCount: state.memoryReaderCount,
        });
      }
      if (req.method === "POST" && route === "/cards") {
        const body = (await readJson(req)) as AgentChannelPostCard;
        if (
          !body.agentId ||
          !body.conversationId ||
          !("threadRootId" in body) ||
          typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length < 8 ||
          !body.card?.summary
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        if (!state.agents.some((a) => a.id === body.agentId)) {
          return json(res, 404, { error: { code: "agent_not_found" } });
        }
        const same = state.cards.find(
          (c) => c.agentId === body.agentId && c.idempotencyKey === body.idempotencyKey,
        );
        if (same) return json(res, 200, { messageId: same.messageId, created: false, version: same.version });
        const stored: StoredCard = { ...body, messageId: randomUUID(), version: 1 };
        state.cards.push(stored);
        return json(res, 201, { messageId: stored.messageId, created: true, version: 1 });
      }
      const cardMatch = /^\/cards\/([^/]+)$/u.exec(route);
      if (req.method === "PATCH" && cardMatch?.[1]) {
        const messageId = decodeURIComponent(cardMatch[1]);
        const body = (await readJson(req)) as AgentChannelPatchCard;
        const card = state.cards.find((c) => c.messageId === messageId);
        const status = !card
          ? 404
          : card.agentId !== body.agentId
            ? 403
            : card.version !== body.patch?.expectedVersion
              ? 409
              : 200;
        state.cardPatches.push({ ...body, messageId, status });
        if (status === 404) return json(res, 404, { error: { code: "card_not_found" } });
        if (status === 403) return json(res, 403, { error: { code: "not_card_author" } });
        if (status === 409) return json(res, 409, { error: { code: "card_version_conflict" } });
        const c = card as StoredCard;
        c.version++;
        return json(res, 200, { messageId, version: c.version });
      }
      if (req.method === "POST" && route === "/board/read") {
        const body = (await readJson(req)) as { eventId?: string; agentId?: string };
        if (!body.eventId || !body.agentId) return json(res, 400, { error: { code: "bad_request" } });
        state.boardReads.push(body.eventId);
        const turnCard = state.boardTurnCards.get(body.eventId);
        const card = state.boardCards.find((c) => c.messageId === turnCard);
        return json(res, 200, {
          board: {
            conversationId: FAKE_BOARD_ID,
            templateId: null,
            prefix: null,
            namingRule: null,
            fields: [],
            version: 1,
          },
          columns: FAKE_BOARD_COLUMNS,
          card: card ? boardCardOut(card) : null,
        });
      }
      if (req.method === "POST" && route === "/board/cards") {
        const body = (await readJson(req)) as AgentChannelBoardCreateCard;
        if (
          !body.eventId ||
          !body.agentId ||
          typeof body.idempotencyKey !== "string" ||
          !(body.title || body.description)
        ) {
          return json(res, 400, { error: { code: "bad_request" } });
        }
        const same = state.boardCards.find(
          (c) => c.agentId === body.agentId && c.idempotencyKey === body.idempotencyKey,
        );
        if (same) return json(res, 200, { card: boardCardOut(same) });
        const stored: StoredBoardCard = {
          ...body,
          messageId: randomUUID(),
          columnId: body.columnId ?? (FAKE_BOARD_COLUMNS[0] as { id: string }).id,
          waitingOn: body.waitingOn ?? "none",
          version: 1,
        };
        state.boardCards.push(stored);
        return json(res, 201, { card: boardCardOut(stored) });
      }
      const boardCardMatch = /^\/board\/cards\/([^/]+)$/u.exec(route);
      if (req.method === "PATCH" && boardCardMatch?.[1]) {
        const messageId = decodeURIComponent(boardCardMatch[1]);
        const body = (await readJson(req)) as AgentChannelBoardPatchCard & Record<string, unknown>;
        const card = state.boardCards.find((c) => c.messageId === messageId);
        const text = ["title", "description", "fields"].some((k) => k in body);
        const status = text ? 403 : !card ? 404 : card.version !== body.expectedVersion ? 409 : 200;
        state.boardPatches.push({ ...body, messageId, status });
        if (status === 403) return json(res, 403, { error: { code: "not_author" } });
        if (status === 404) return json(res, 404, { error: { code: "card_not_in_board" } });
        if (status === 409) return json(res, 409, { error: { code: "board_card_version_conflict" } });
        const c = card as StoredBoardCard;
        if (body.move) c.columnId = body.move.columnId;
        if (body.waitingOn) c.waitingOn = body.waitingOn;
        c.version++;
        return json(res, 200, { card: boardCardOut(c) });
      }
      if (req.method === "POST" && route === "/typing") {
        state.typing.push((await readJson(req)) as AgentChannelTyping);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && route === "/runtime") {
        state.runtimeReports.push((await readJson(req)) as AgentChannelRuntimeReport);
        return json(res, 200, { ok: true });
      }
      const statusMatch = /^\/agents\/([^/]+)\/status$/u.exec(route);
      if (req.method === "POST" && statusMatch?.[1]) {
        const agentId = decodeURIComponent(statusMatch[1]);
        const body = (await readJson(req)) as AgentChannelStatusReport;
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) return json(res, 404, { error: { code: "agent_not_found" } });
        state.statusReports.push({ agentId, ...body });
        if (agent.status !== "disabled") agent.status = body.status;
        return json(res, 200, agent);
      }
      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      return json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== `${BASE}/ws` || !authorized(req)) {
      state.authFailures++;
      socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (req.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
        subscribed.delete(ws);
      });
      ws.on("message", (raw) => {
        let frame: { op?: string; topic?: string; afterSeq?: number };
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ op: "err", code: "bad_frame" }));
          return;
        }
        if (frame.op === "ping") {
          ws.send(JSON.stringify({ op: "pong" }));
          return;
        }
        if (frame.op !== "sub") {
          ws.send(JSON.stringify({ op: "err", code: "bad_frame" }));
          return;
        }
        if (frame.topic !== topic) {
          ws.send(JSON.stringify({ op: "err", code: "forbidden", topic: frame.topic }));
          return;
        }
        const afterSeq = typeof frame.afterSeq === "number" ? frame.afterSeq : null;
        state.subscriptions.push(afterSeq);
        if (afterSeq !== null) for (const ev of state.events) if (ev.seq > afterSeq) ws.send(frameFor(ev));
        subscribed.add(ws);
        ws.send(JSON.stringify({ op: "subscribed", topic, lastSeq: state.events.at(-1)?.seq ?? 0 }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  const api: FakeAgentChannelApi = {
    url: `http://${opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1"}:${address.port}`,
    server,
    token,
    cellId,
    topic,
    get agents() {
      return state.agents;
    },
    set agents(value: CellAgent[]) {
      state.agents = value;
    },
    get providers() {
      return state.providers;
    },
    set providers(value: CellProvider[]) {
      state.providers = value;
    },
    get cellSubscriptions() {
      return state.cellSubscriptions;
    },
    set cellSubscriptions(value: CellSubscription[] | undefined) {
      state.cellSubscriptions = value;
    },
    get webSearchProvider() {
      return state.webSearchProvider;
    },
    set webSearchProvider(value: string | undefined) {
      state.webSearchProvider = value;
    },
    get denyTools() {
      return state.denyTools;
    },
    get toolApprovals() {
      return state.toolApprovals;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    get toolResults() {
      return state.toolResults;
    },
    get memories() {
      return state.memories;
    },
    get refuseMemoryEvents() {
      return state.refuseMemoryEvents;
    },
    get memoryFileStore() {
      return state.memoryFileStore;
    },
    get memoryCalls() {
      return state.memoryCalls;
    },
    get memoryScopes() {
      return state.memoryScopes;
    },
    get memoryReaderCount() {
      return state.memoryReaderCount;
    },
    set memoryReaderCount(value: number) {
      state.memoryReaderCount = value;
    },
    get memoryRefusals() {
      return state.memoryRefusals;
    },
    get approvalCards() {
      return state.approvalCards;
    },
    get memoryNoTriggers() {
      return state.memoryNoTriggers;
    },
    endTurn(eventId) {
      state.endedTurns.add(eventId);
    },
    get cards() {
      return state.cards;
    },
    get cardPatches() {
      return state.cardPatches;
    },
    get boardCards() {
      return state.boardCards;
    },
    get boardPatches() {
      return state.boardPatches;
    },
    get boardReads() {
      return state.boardReads;
    },
    get boardTurnCards() {
      return state.boardTurnCards;
    },
    get connectorCalls() {
      return state.connectorCalls;
    },
    get connectorLists() {
      return state.connectorLists;
    },
    get httpRequests() {
      return state.httpRequests;
    },
    get connectorControl() {
      return state.connectorControl;
    },
    set connectorControl(value: ConnectorControl) {
      state.connectorControl = value;
    },
    get automations() {
      return state.automations;
    },
    get workZone() {
      return state.workZone;
    },
    get sandbox() {
      return state.sandbox;
    },
    get browser() {
      return state.browser;
    },
    get mcpServers() {
      return state.mcpServers;
    },
    set mcpServers(value: CellMcpServer[]) {
      state.mcpServers = value;
    },
    get mcpProbes() {
      return state.mcpProbes;
    },
    get cellReads() {
      return state.cellReads;
    },
    get plugins() {
      return state.plugins;
    },
    set plugins(value: CellApprovedPlugin[]) {
      state.plugins = value;
    },
    get pluginReports() {
      return state.pluginReports;
    },
    get verifyCalls() {
      return state.verifyCalls;
    },
    get authReports() {
      return state.authReports;
    },
    get authResponder() {
      return state.authResponder;
    },
    set authResponder(fn: (report: AgentChannelProviderAuthReport) => number) {
      state.authResponder = fn;
    },
    get events() {
      return state.events;
    },
    get messages() {
      return state.messages;
    },
    get messageAttempts() {
      return state.messageAttempts;
    },
    get typing() {
      return state.typing;
    },
    get statusReports() {
      return state.statusReports;
    },
    get runtimeReports() {
      return state.runtimeReports;
    },
    get subscriptions() {
      return state.subscriptions;
    },
    get authFailures() {
      return state.authFailures;
    },
    publish(type, data) {
      // Like the API: an install / uninstall command moves its row (installing / uninstalling) before it is sent.
      const row = state.plugins.find((p) => p.pluginRowId === data.pluginRowId);
      if (row && type === "plugin.install.v1") row.status = "installing";
      if (row && type === "plugin.uninstall.v1") row.status = "uninstalling";
      if (row && typeof data.flowId === "string" && type.startsWith("plugin.")) {
        pluginFlows.set(row.pluginRowId, data.flowId);
      }
      const seq = (state.events.at(-1)?.seq ?? 0) + 1;
      const ev: StoredEvent = { seq, type, data: { ...data, type, organizationId: cellId, cellId, seq } };
      state.events.push(ev);
      for (const ws of subscribed) ws.send(frameFor(ev));
      return ev;
    },
    publishMention(input) {
      return api.publish("agent.mention.v1", input as unknown as Record<string, unknown>);
    },
    updateCell(next, reason = "agent.updated", agentId = null) {
      if (next.agents) state.agents = next.agents;
      if (next.providers) state.providers = next.providers;
      if (next.subscriptions) state.cellSubscriptions = next.subscriptions;
      if (next.mcpServers) state.mcpServers = next.mcpServers;
      return api.publish("cell.config.changed", { reason: reason ?? "agent.updated", agentId });
    },
    failNextPosts(n, status = 503) {
      failures = { n, status };
    },
    dropConnections() {
      for (const ws of sockets) ws.terminate();
    },
    sendResync() {
      for (const ws of subscribed) ws.send(JSON.stringify({ op: "resync", topic }));
    },
    openSockets: () => subscribed.size,
    async waitFor(fn, timeoutMs = 12_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = fn();
        if (value) return value as never;
        if (Date.now() > deadline) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
