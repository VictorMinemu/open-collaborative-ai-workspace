// Maps `codex app-server` notifications to the Unified Session Event Protocol. Pure and stateful
// per session; tested against recorded fixtures. Output is NOT sanitised yet (the daemon does it).

import type { SessionEvent, Usage } from "@ocw/contracts";
import { rawEvent, TOOL_OUTPUT_MAX_BYTES } from "../claude/mapper.js";
import { truncateBytes } from "../sanitize.js";
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

export function toolNameForItem(item: ThreadItem): string | null {
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
