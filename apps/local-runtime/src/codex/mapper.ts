// Maps `codex app-server` notifications to the Unified Session Event Protocol. Pure and stateful
// per session; tested against recorded fixtures. Output is NOT sanitised yet (the daemon does it).

import {
  browserToolFromName,
  canonicalBrowserTool,
  originOf,
  SESSION_RENAME_REFUSAL_TEXT,
  type SessionEvent,
  type Usage,
  WORK_BROWSER_MCP_SERVER,
  WORK_BROWSER_REFUSAL_TEXT,
  WORK_SESSION_MCP_SERVER,
  type WorkBrowserTool,
  WorkSessionTool,
} from "@ocw/contracts";
import { INVALID_REQUEST_TEXT } from "../browser/tools.js";
import { rawEvent, TOOL_OUTPUT_MAX_BYTES } from "../claude/mapper.js";
import { truncateBytes } from "../sanitize.js";
import { canonicalSessionTool, RENAME_STARTED_SUMMARY } from "../session-tools/tools.js";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification.js";
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { ErrorNotification } from "./generated/v2/ErrorNotification.js";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification.js";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { ThreadSettingsUpdatedNotification } from "./generated/v2/ThreadSettingsUpdatedNotification.js";
import type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification.js";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.js";
import type { JsonRpcNotification } from "./jsonrpc.js";
import { codexModeFromSettings } from "./mode-policy.js";

/** Notifications we understand and deliberately do not forward. */
const IGNORED: ReadonlySet<string> = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "turn/started",
  "turn/diff/updated",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/mcpToolCall/progress",
  "serverRequest/resolved",
  "account/rateLimits/updated",
  "account/updated",
  "mcpServer/startupStatus/updated",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "hook/started",
  "hook/completed",
  "skills/changed",
  "app/list/updated",
  "remoteControl/status/changed",
  "fs/changed",
  "model/safetyBuffering/updated",
  "turn/moderationMetadata",
  // These describe the owner's local Codex config (plugins, hooks); not useful to collaborators.
  "warning",
  "configWarning",
  "deprecationNotice",
]);

// ------------------------------------------------------------------ the Work Zone browser (07.13 D-09, PD-11)
//
// An `ocw_browser` call (our shim, codex-runtime.ts) shows the action and the origin only, under its canonical name
// (`ocw_browser_open`, as audit and approvals name it). The item's `arguments` carry what the model typed and its
// `result` the page's text (and a screenshot's base64): neither is copied into an event (Pitfall 2). The completed
// summary is the result's first text line, which the manager writes as the summary, and only when it reads like one.

type McpItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

/** The item when it is an `ocw_browser` call, else null (not a type guard: other MCP items keep their own path). */
const browserItem = (item: ThreadItem): McpItem | null =>
  item.type === "mcpToolCall" && item.server === WORK_BROWSER_MCP_SERVER ? item : null;

/** What a browser call is doing while it runs (no element, no typed text, no path or query). */
const BROWSER_STARTED: Readonly<Record<Exclude<WorkBrowserTool, "open">, string>> = {
  snapshot: "Reading the page",
  act: "Acting on the page",
  screenshot: "Taking a screenshot",
  wait: "Waiting on the page",
  close: "Closing the browser",
  signin: "Asking for a sign-in",
};

function browserName(item: McpItem): string {
  const tool = browserToolFromName(item.tool);
  return tool ? canonicalBrowserTool(tool) : WORK_BROWSER_MCP_SERVER;
}

function browserStartedSummary(item: McpItem): string {
  const tool = browserToolFromName(item.tool);
  if (tool === "open") {
    const url = (item.arguments as { url?: unknown } | null)?.url;
    const origin = typeof url === "string" ? originOf(url) : null;
    return origin ? `Opening ${origin}` : "Opening a page";
  }
  return tool ? BROWSER_STARTED[tool] : "Using the browser";
}

const HOST_PORT = String.raw`(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?`;
const ON_TARGET =
  /^(?:Opened|Read|Clicked on|Typed on|Selected on|Pressed a key on|Scrolled|Acted on|Took a screenshot of|Waited on|Sign-in on) /;
const SUMMARY_TARGET = new RegExp(`^(?:the page|${HOST_PORT})$`, "i");
const FIXED_SUMMARIES: ReadonlySet<string> = new Set([
  "Opened a page",
  "Closed the browser",
  "Sign-in",
  `Refused: ${INVALID_REQUEST_TEXT}`,
  ...Object.values(WORK_BROWSER_REFUSAL_TEXT).map((t) => `Refused: ${t}`),
]);

/** The manager's summary line (tools.ts `browserToolSummary`), or null for anything else. */
export function browserSummaryLine(line: string): string | null {
  if (FIXED_SUMMARIES.has(line)) return line;
  const verb = line.match(ON_TARGET);
  if (verb && SUMMARY_TARGET.test(line.slice(verb[0].length))) return line;
  return null;
}

function browserCompletion(item: McpItem): { ok: boolean; summary: string } {
  const name = browserName(item);
  if (item.error !== null || item.status !== "completed") return { ok: false, summary: `${name} failed` };
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  const first = content.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
  );
  const summary = first ? browserSummaryLine(first.text.split("\n")[0] ?? "") : null;
  if (!summary) return { ok: true, summary: `${name} completed` };
  return { ok: !summary.startsWith("Refused: "), summary };
}

// ------------------------------------------------------------------ the session's own tools (07.13.1.1 D-07, PD-08)
//
// An `ocw_session` call (our `session-mcp` shim) shows under its canonical name (`ocw_session_rename`) with a fixed
// started summary; the completed summary is the relay's sentence (the stored title or a refusal) and only when it is
// one, else a fixed one. The item's `arguments` (the title the model typed) and its `result` never reach an event.

/** The item when it is an `ocw_session` call, else null. */
const sessionItem = (item: ThreadItem): McpItem | null =>
  item.type === "mcpToolCall" && item.server === WORK_SESSION_MCP_SERVER ? item : null;

function sessionName(item: McpItem): string {
  const tool = WorkSessionTool.safeParse(item.tool);
  return tool.success ? canonicalSessionTool(tool.data) : WORK_SESSION_MCP_SERVER;
}

/** The relay's answers: the stored title (one line, bounded) or a refusal's fixed sentence. */
const RENAMED = /^Renamed the session to "[^"\n]{1,200}"\.$/;
const SESSION_REFUSALS: ReadonlySet<string> = new Set(Object.values(SESSION_RENAME_REFUSAL_TEXT));

function sessionCompletion(item: McpItem): { ok: boolean; summary: string } {
  const name = sessionName(item);
  if (item.error !== null || item.status !== "completed") return { ok: false, summary: `${name} failed` };
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  const first = content.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
  );
  const line = first?.text.split("\n")[0] ?? "";
  if (RENAMED.test(line)) return { ok: true, summary: line };
  if (SESSION_REFUSALS.has(line)) return { ok: false, summary: line };
  return { ok: true, summary: `${name} completed` };
}

export function toolNameForItem(item: ThreadItem): string | null {
  const browser = browserItem(item);
  if (browser) return browserName(browser);
  const session = sessionItem(item);
  if (session) return sessionName(session);
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "Edit";
    case "mcpToolCall":
      return `mcp__${item.server}__${item.tool}`;
    case "dynamicToolCall":
      return item.tool;
    case "webSearch":
      return "WebSearch";
    case "imageView":
      return "ViewImage";
    case "collabAgentToolCall":
      return "Agent";
    default:
      return null;
  }
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function summarizeItem(item: ThreadItem): string {
  const browser = browserItem(item);
  if (browser) return browserStartedSummary(browser);
  if (sessionItem(item)) return RENAME_STARTED_SUMMARY;
  switch (item.type) {
    case "commandExecution":
      return `$ ${clip(item.command, 300)}`;
    case "fileChange": {
      const paths = item.changes.map((c) => c.path);
      return `Edit ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`;
    }
    case "mcpToolCall":
      return `${item.server}.${item.tool} ${clip(JSON.stringify(item.arguments ?? {}), 200)}`;
    case "dynamicToolCall":
      return `${item.tool} ${clip(JSON.stringify(item.arguments ?? {}), 200)}`;
    case "webSearch":
      return `Web search ${clip(JSON.stringify(item), 200)}`;
    case "imageView":
      return `View image ${item.path}`;
    case "collabAgentToolCall":
      return `Sub-agent: ${clip(item.prompt ?? "", 200)}`;
    default:
      return item.type;
  }
}

function completion(item: ThreadItem): { ok: boolean; summary: string; output?: string } {
  // Never an `output` for the browser: the result is page content (PD-11, Pitfall 2).
  const browser = browserItem(item);
  if (browser) return browserCompletion(browser);
  // Never an `output` for the session's tools either: the arguments and the result stay on the device (D-07).
  const session = sessionItem(item);
  if (session) return sessionCompletion(session);
  switch (item.type) {
    case "commandExecution": {
      const ok = item.status === "completed" && (item.exitCode === null || item.exitCode === 0);
      const exit = item.exitCode === null ? item.status : `exit ${item.exitCode}`;
      const out: { ok: boolean; summary: string; output?: string } = {
        ok,
        summary: `$ ${clip(item.command, 200)} (${exit})`,
      };
      if (item.aggregatedOutput)
        out.output = truncateBytes(item.aggregatedOutput, TOOL_OUTPUT_MAX_BYTES).text;
      return out;
    }
    case "fileChange": {
      const ok = item.status === "completed";
      const diff = item.changes.map((c) => c.diff).join("\n");
      const out: { ok: boolean; summary: string; output?: string } = {
        ok,
        summary: ok ? `Edited ${item.changes.length} file(s)` : `File change ${item.status}`,
      };
      if (diff) out.output = truncateBytes(diff, TOOL_OUTPUT_MAX_BYTES).text;
      return out;
    }
    case "mcpToolCall": {
      const ok = item.error === null && item.status === "completed";
      const body = item.error ? JSON.stringify(item.error) : JSON.stringify(item.result ?? null);
      return {
        ok,
        summary: `${item.server}.${item.tool} ${ok ? "completed" : "failed"}`,
        output: truncateBytes(body, TOOL_OUTPUT_MAX_BYTES).text,
      };
    }
    case "dynamicToolCall": {
      const ok = item.success !== false && item.status === "completed";
      return { ok, summary: `${item.tool} ${ok ? "completed" : "failed"}` };
    }
    default:
      return { ok: true, summary: `${toolNameForItem(item) ?? item.type} completed` };
  }
}

function toUsage(u: ThreadTokenUsageUpdatedNotification["tokenUsage"]["last"] | undefined): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Math.max(0, u.inputTokens - u.cachedInputTokens),
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cachedInputTokens,
    cacheCreationInputTokens: u.cacheWriteInputTokens,
  };
}

/** The effective-settings fields Codex reports (ThreadStartResponse, ThreadSettings) or the adapter sent. */
export interface CodexEffectiveSettings {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  approvalPolicy: AskForApproval | null;
  sandboxPolicy: SandboxPolicy | null;
  approvalsReviewer: ApprovalsReviewer | null;
}

/**
 * `session.settings` for an effective Codex configuration (D-07). Fast mode = the `priority` service tier; the
 * permission mode comes from the inverse of the mode table and is left out when no platform mode matches (the
 * event field is optional, not nullable). Never carries the thread's absolute cwd.
 */
export function codexSettingsEvent(
  e: CodexEffectiveSettings,
): Extract<SessionEvent, { type: "session.settings" }> {
  const mode = codexModeFromSettings(e.approvalPolicy, e.sandboxPolicy, e.approvalsReviewer);
  return {
    type: "session.settings",
    model: e.model,
    effort: e.effort,
    serviceTier: e.serviceTier,
    fastMode: e.serviceTier === "priority",
    ...(mode ? { permissionMode: mode } : {}),
  };
}

export class CodexEventMapper {
  currentPromptId: string | null = null;
  currentTurnId: string | null = null;
  /** Items seen in `item/started`, so approvals can show file lists. */
  readonly items = new Map<string, ThreadItem>();
  private readonly usageByTurn = new Map<string, Usage>();
  private lastContextWindow: number | null = null;

  map(n: JsonRpcNotification): SessionEvent[] {
    if (IGNORED.has(n.method)) {
      if (n.method === "turn/started") {
        const turnId = (n.params as { turn?: { id?: string } } | undefined)?.turn?.id;
        if (turnId) this.currentTurnId = turnId;
      }
      return [];
    }
    switch (n.method) {
      case "item/agentMessage/delta": {
        const p = n.params as AgentMessageDeltaNotification;
        return p.delta ? [{ type: "assistant.delta", messageId: p.itemId, text: p.delta }] : [];
      }
      case "item/started": {
        const { item } = n.params as ItemStartedNotification;
        this.items.set(item.id, item);
        const name = toolNameForItem(item);
        return name ? [{ type: "tool.started", toolUseId: item.id, name, summary: summarizeItem(item) }] : [];
      }
      case "item/completed": {
        const { item } = n.params as ItemCompletedNotification;
        this.items.delete(item.id);
        if (item.type === "agentMessage") {
          return item.text ? [{ type: "assistant.message", messageId: item.id, text: item.text }] : [];
        }
        if (item.type === "contextCompaction") return [rawEvent("item/contextCompaction", item)];
        if (!toolNameForItem(item)) return [];
        const c = completion(item);
        const ev: SessionEvent = { type: "tool.completed", toolUseId: item.id, ok: c.ok, summary: c.summary };
        if (c.output) ev.output = c.output;
        return [ev];
      }
      case "thread/tokenUsage/updated": {
        const p = n.params as ThreadTokenUsageUpdatedNotification;
        this.usageByTurn.set(p.turnId, toUsage(p.tokenUsage.last));
        // D-10: display only, reported once per value.
        const window = p.tokenUsage.modelContextWindow;
        if (window && window > 0 && window !== this.lastContextWindow) {
          this.lastContextWindow = window;
          return [{ type: "session.settings", contextWindow: window }];
        }
        return [];
      }
      case "thread/settings/updated": {
        const { threadSettings: t } = n.params as ThreadSettingsUpdatedNotification;
        return [
          codexSettingsEvent({
            model: t.model ?? null,
            effort: t.effort ?? null,
            serviceTier: t.serviceTier ?? null,
            approvalPolicy: t.approvalPolicy ?? null,
            sandboxPolicy: t.sandboxPolicy ?? null,
            approvalsReviewer: t.approvalsReviewer ?? null,
          }),
        ];
      }
      case "error": {
        const p = n.params as ErrorNotification;
        if (p.willRetry) return [rawEvent("error/retrying", { message: p.error.message })];
        return [{ type: "session.error", message: p.error.message }];
      }
      case "turn/completed": {
        const { turn } = n.params as TurnCompletedNotification;
        const out: SessionEvent[] = [];
        if (turn.status === "failed")
          out.push({ type: "session.error", message: turn.error?.message ?? "Codex turn failed" });
        const completed: SessionEvent = {
          type: "prompt.completed",
          promptId: this.currentPromptId ?? "unknown",
          usage: this.usageByTurn.get(turn.id) ?? { inputTokens: 0, outputTokens: 0 },
        };
        if (turn.status === "failed") completed.isError = true;
        if (turn.status === "interrupted") completed.interrupted = true;
        out.push(completed);
        this.usageByTurn.delete(turn.id);
        this.currentPromptId = null;
        this.currentTurnId = null;
        return out;
      }
      default:
        return [rawEvent(n.method, n.params)];
    }
  }
}
