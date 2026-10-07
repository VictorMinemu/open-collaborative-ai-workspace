// Maps Claude Agent SDK messages to the Unified Session Event Protocol. Pure and stateful per
// session; no I/O, so it can be tested against recorded fixtures. Output is NOT sanitised yet.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FastModeState, type SessionEvent, type Usage, type WorkSessionStatus } from "@ocw/contracts";
import { truncateBytes } from "../sanitize.js";
import { summarizeToolInput } from "./tool-policy.js";

export const TOOL_OUTPUT_MAX_BYTES = 4 * 1024;
export const RAW_DATA_MAX_BYTES = 4 * 1024;
/** The `session.error` prefix for a turn that failed on an attached image (SDK `terminal_reason: "image_error"`). */
export const IMAGE_ERROR_MESSAGE = "Claude Code could not read an attached image";

type Loose = Record<string, unknown>;

/** SDK messages we understand and deliberately do not forward. */
const IGNORED: ReadonlySet<string> = new Set([
  "tool_progress",
  "tool_use_summary",
  "prompt_suggestion",
  "system/thinking_tokens",
  "system/hook_started",
  "system/hook_progress",
  "system/hook_response",
  "system/commands_changed",
  "system/files_persisted",
]);

const STATE_MAP: Record<string, WorkSessionStatus> = {
  idle: "idle",
  running: "running",
  requires_action: "waiting_approval",
};

function asRecord(v: unknown): Loose {
  return v && typeof v === "object" ? (v as Loose) : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

export function toUsage(raw: unknown): Usage {
  const u = asRecord(raw);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const block = asRecord(b);
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return `[${String(block.type ?? "content")}]`;
    })
    .join("\n");
}

export function rawEvent(rawType: string, msg: unknown): SessionEvent {
  let json: string;
  try {
    json = JSON.stringify(msg);
  } catch {
    json = '"[unserialisable]"';
  }
  if (Buffer.byteLength(json, "utf8") <= RAW_DATA_MAX_BYTES) {
    return { type: "runtime.raw", rawType, data: JSON.parse(json) as unknown };
  }
  return {
    type: "runtime.raw",
    rawType,
    data: { truncated: true, preview: truncateBytes(json, RAW_DATA_MAX_BYTES).text },
  };
}

/** `session.settings` from a `system/init` (model, permissionMode, fast_mode_state/_disabled_reason, effort). */
function initSettings(msg: Loose): Extract<SessionEvent, { type: "session.settings" }> {
  const ev: Extract<SessionEvent, { type: "session.settings" }> = { type: "session.settings" };
  if (typeof msg.model === "string") ev.model = msg.model.slice(0, 200);
  if (typeof msg.permissionMode === "string") ev.permissionMode = msg.permissionMode.slice(0, 32);
  const state = FastModeState.safeParse(msg.fast_mode_state);
  if (state.success) ev.fastModeState = state.data;
  if (typeof msg.fast_mode_disabled_reason === "string") {
    ev.fastModeReason = msg.fast_mode_disabled_reason.slice(0, 64);
  }
  if (typeof msg.effort === "string" || msg.effort === null) {
    ev.effort = msg.effort === null ? null : msg.effort.slice(0, 32);
  }
  return ev;
}

export class ClaudeEventMapper {
  /** Prompt the next `result` message completes. Set by the runtime when it dispatches a prompt. */
  currentPromptId: string | null = null;
  runtimeSessionId: string | null = null;
  permissionMode: string | null = null;

  private started = false;
  private readonly toolNames = new Map<string, string>();
  private readonly assistantText = new Map<string, string>();
  private streamMessageId: string | null = null;
  private lastCumulativeCostUsd = 0;

  map(message: SDKMessage): SessionEvent[] {
    const msg = message as unknown as Loose;
    const type = String(msg.type);
    const subtype = typeof msg.subtype === "string" ? msg.subtype : undefined;
    const key = subtype ? `${type}/${subtype}` : type;
    if (IGNORED.has(key) || IGNORED.has(type)) return [];

    switch (type) {
      case "system":
        return this.mapSystem(msg, key);
      case "stream_event":
        return this.mapStreamEvent(msg);
      case "assistant":
        return this.mapAssistant(msg);
      case "user":
        return this.mapUser(msg);
      case "result":
        return this.mapResult(msg);
      default:
        return [rawEvent(key, msg)];
    }
  }

  private mapSystem(msg: Loose, key: string): SessionEvent[] {
    if (typeof msg.session_id === "string" && msg.session_id) this.runtimeSessionId = msg.session_id;
    switch (msg.subtype) {
      case "init": {
        this.permissionMode = typeof msg.permissionMode === "string" ? msg.permissionMode : null;
        // Every init (one per turn) carries the effective settings; a change made by the runtime itself is
        // visible to every controller (D-15). session.started only once.
        const settings = initSettings(msg);
        if (this.started) return [settings];
        this.started = true;
        const ev: SessionEvent = { type: "session.started", runtime: "claude-code" };
        if (this.runtimeSessionId) ev.runtimeSessionId = this.runtimeSessionId;
        if (typeof msg.claude_code_version === "string") ev.runtimeVersion = msg.claude_code_version;
        if (typeof msg.model === "string") ev.model = msg.model;
        if (this.permissionMode) ev.permissionMode = this.permissionMode;
        return [ev, settings];
      }
      case "session_state_changed": {
        const status = STATE_MAP[String(msg.state)];
        return status ? [{ type: "session.state", status }] : [rawEvent(key, msg)];
      }
      case "status": {
        // `requesting` is per-API-call noise; `null` clears a status. Only compaction is forwarded raw.
        const out: SessionEvent[] = msg.status && msg.status !== "requesting" ? [rawEvent(key, msg)] : [];
        // A mode change (ours via setPermissionMode, or the runtime's own, e.g. ExitPlanMode) is reported here
        // before the next init (fixture claude-code-2.1.289.settings): forward it as the mode readback.
        if (typeof msg.permissionMode === "string") {
          this.permissionMode = msg.permissionMode;
          out.push({ type: "session.settings", permissionMode: msg.permissionMode.slice(0, 32) });
        }
        return out;
      }
      default:
        return [rawEvent(key, msg)];
    }
  }

  private mapStreamEvent(msg: Loose): SessionEvent[] {
    if (msg.parent_tool_use_id) return []; // sub-agent stream; only top-level text is streamed
    const event = asRecord(msg.event);
    if (event.type === "message_start") {
      const id = asRecord(event.message).id;
      this.streamMessageId = typeof id === "string" ? id : null;
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && this.streamMessageId) {
        return [{ type: "assistant.delta", messageId: this.streamMessageId, text: delta.text }];
      }
    }
    return [];
  }

  private mapAssistant(msg: Loose): SessionEvent[] {
    const out: SessionEvent[] = [];
    const message = asRecord(msg.message);
    const messageId = typeof message.id === "string" ? message.id : String(msg.uuid ?? "unknown");
    const isSubagent = Boolean(msg.parent_tool_use_id);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block.type === "text" && typeof block.text === "string") {
        if (isSubagent || block.text.length === 0) continue;
        const prev = this.assistantText.get(messageId);
        const text = prev ? `${prev}\n\n${block.text}` : block.text;
        this.assistantText.set(messageId, text);
        out.push({ type: "assistant.message", messageId, text });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const toolUseId = String(block.id);
        const name = String(block.name);
        this.toolNames.set(toolUseId, name);
        out.push({
          type: "tool.started",
          toolUseId,
          name,
          summary: summarizeToolInput(name, asRecord(block.input)),
        });
      }
      // thinking / redacted_thinking blocks are intentionally not forwarded
    }
    if (typeof msg.error === "string" && !isSubagent) {
      out.push({ type: "session.error", message: `Claude API error: ${msg.error}` });
    }
    return out;
  }

  private mapUser(msg: Loose): SessionEvent[] {
    if (msg.isReplay) return [];
    const message = asRecord(msg.message);
    if (!Array.isArray(message.content)) return [];
    const out: SessionEvent[] = [];
    for (const raw of message.content) {
      const block = asRecord(raw);
      if (block.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id);
      const name = this.toolNames.get(toolUseId) ?? "tool";
      const ok = block.is_error !== true;
      const text = toolResultText(block.content);
      const { text: output } = truncateBytes(text, TOOL_OUTPUT_MAX_BYTES);
      const firstLine = text.split("\n", 1)[0]?.slice(0, 200) ?? "";
      const summary = ok ? `${name} completed` : `${name} failed${firstLine ? `: ${firstLine}` : ""}`;
      const ev: SessionEvent = { type: "tool.completed", toolUseId, ok, summary };
      if (output) ev.output = output;
      out.push(ev);
      this.toolNames.delete(toolUseId);
    }
    return out;
  }

  private mapResult(msg: Loose): SessionEvent[] {
    const out: SessionEvent[] = [];
    const isError = msg.subtype !== "success" || msg.is_error === true;
    if (isError) {
      const errors = Array.isArray(msg.errors)
        ? msg.errors.filter((e): e is string => typeof e === "string")
        : [];
      const detail = errors.join("; ") || (typeof msg.result === "string" ? msg.result : "");
      // 06.1 (D-05): an image the runtime could not read fails the prompt with a readable cause, never silently.
      const message =
        msg.terminal_reason === "image_error"
          ? `${IMAGE_ERROR_MESSAGE}${detail ? `: ${detail}` : ""}`
          : detail || String(msg.subtype);
      out.push({ type: "session.error", message });
    }
    // total_cost_usd is cumulative across turns in streaming-input sessions; report the delta.
    const cumulative =
      typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : this.lastCumulativeCostUsd;
    const costUsd = Math.max(0, cumulative - this.lastCumulativeCostUsd);
    this.lastCumulativeCostUsd = Math.max(cumulative, this.lastCumulativeCostUsd);
    const completed: SessionEvent = {
      type: "prompt.completed",
      promptId: this.currentPromptId ?? "unknown",
      usage: toUsage(msg.usage),
      costUsd: Number(costUsd.toFixed(6)),
    };
    if (isError) completed.isError = true;
    out.push(completed);
    this.currentPromptId = null;
    this.assistantText.clear();
    this.streamMessageId = null;
    return out;
  }
}
