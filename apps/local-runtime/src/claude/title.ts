// Claude Code session titles (Phase 03.2 Plan 12, D-18, P-17, ADR-0014): one separate, one-shot query with the
// small model (`haiku`), never the session's own query. Isolation: no tools (`tools: []` + a deny-all canUseTool),
// default mode (plan mode swaps Haiku for Sonnet, 03.2-02), bypass disabled, no filesystem settings, no MCP servers,
// nothing persisted, an empty temporary working directory removed afterwards, API keys stripped (the device owner's
// own Claude Code login).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../async-queue.js";
import { TITLE_INSTRUCTIONS, TitleError, titleUserMessage } from "../title.js";
import type { QueryFn, QueryHandle } from "./claude-runtime.js";
import { secretDenyRules } from "./tool-policy.js";

export interface ClaudeTitleOptions {
  /** The CLI the sessions use (PATH `claude`); null = the SDK's bundled CLI. */
  claudePath: string | null;
  /** `childEnv(...)`: API keys and OCW_* stripped. */
  env: Record<string, string | undefined>;
  prompt: string;
  /** The catalog id (`haiku`). */
  model: string;
  /** The concrete model the catalog row resolves to (`claude-haiku-4-5-…`); the init must report one of the two. */
  resolvedModel: string | null;
  signal: AbortSignal;
  /** Parent of the temporary working directory (tests). */
  tmpRoot?: string;
}

/** The options of the title query (exported for the recorder and the tests). */
export function titleQueryOptions(o: ClaudeTitleOptions, cwd: string, abort: AbortController): Options {
  const options: Options = {
    cwd,
    model: o.model,
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    tools: [],
    canUseTool: async () => ({ behavior: "deny", message: "Session titles never use tools." }),
    settingSources: [],
    strictMcpConfig: true,
    settings: { permissions: { deny: secretDenyRules(), disableBypassPermissionsMode: "disable" } },
    persistSession: false,
    maxTurns: 1,
    // The 2.1.289 title fixture shows Haiku thinking ~3.7k tokens (31 s) for a title, past the daemon's 20 s
    // timeout: a title needs no extended thinking.
    thinking: { type: "disabled" },
    systemPrompt: TITLE_INSTRUCTIONS,
    env: o.env,
    abortController: abort,
  };
  if (o.claudePath) options.pathToClaudeCodeExecutable = o.claudePath;
  return options;
}

function usedTool(m: SDKMessage): string | null {
  if (m.type !== "assistant") return null;
  const content = (m.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (b): b is { type: string; name?: string } =>
      typeof b === "object" && b !== null && /tool_use$/.test(String((b as { type?: unknown }).type)),
  );
  return block ? String(block.name ?? block.type) : null;
}

/** One title turn; returns the model's raw answer (the daemon normalizes and sanitizes it). */
export async function generateClaudeTitle(queryFn: QueryFn, o: ClaudeTitleOptions): Promise<string> {
  if (o.signal.aborted) throw new TitleError("title_failed", "aborted");
  const cwd = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "ocw-title-"));
  const abort = new AbortController();
  const input = new AsyncQueue<SDKUserMessage>();
  input.push({
    type: "user",
    message: { role: "user", content: titleUserMessage(o.prompt) },
    parent_tool_use_id: null,
  });
  input.close();
  let q: QueryHandle | null = null;
  const stop = () => {
    if (!q) return;
    void q.interrupt().catch(() => undefined);
    try {
      q.close();
    } catch {
      // already closed
    }
  };
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    q = queryFn({ prompt: input, options: titleQueryOptions(o, cwd, abort) });
    let text: string | null = null;
    for await (const m of q) {
      if (o.signal.aborted) break;
      if (m.type === "system" && m.subtype === "init") {
        if (m.model !== o.model && m.model !== o.resolvedModel) {
          throw new TitleError("title_model_mismatch", `the runtime answered with ${m.model}`);
        }
        continue;
      }
      const tool = usedTool(m);
      if (tool) throw new TitleError("title_used_tool", tool);
      if (m.type === "result") {
        if (m.subtype !== "success" || m.is_error) {
          throw new TitleError("title_failed", `the title turn ended with ${m.subtype}`);
        }
        text = m.result;
        break;
      }
    }
    if (o.signal.aborted) throw new TitleError("title_failed", "aborted");
    if (text === null) throw new TitleError("title_failed", "the title turn produced no result");
    return text;
  } finally {
    o.signal.removeEventListener("abort", stop);
    try {
      q?.close();
    } catch {
      // already closed
    }
    abort.abort();
    await rm(cwd, { recursive: true, force: true });
  }
}
