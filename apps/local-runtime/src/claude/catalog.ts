// Claude Code runtime catalog (Phase 03.2, D-08 … D-11): what THIS device's Claude Code login offers, read from
// the runtime itself, never a hard-coded list. Collecting it costs no model turn: one throw-away streaming query
// whose prompt never yields, `initializationResult().models`, a context-window probe (`setModel` +
// `getContextUsage({ detail: "summary" })`, with and without the `[1m]` suffix), then `close()`.

import type { ModelInfo, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ContextWindow,
  DEFERRED_EFFORTS,
  type PermissionMode,
  type RuntimeCatalog,
  type RuntimeModel,
} from "@ocw/contracts";
import { AsyncQueue } from "../async-queue.js";
import type { QueryFn, QueryHandle } from "./claude-runtime.js";
import { secretDenyRules } from "./tool-policy.js";

/** D-11: what Claude fast mode costs (code.claude.com/docs fast-mode: "available via usage credits only"). */
export const CLAUDE_FAST_MODE_COST =
  "Fast mode is billed from paid usage credits, not your Claude plan limits.";

/** The window `[1m]` selects. */
export const ONE_M_CONTEXT = 1_000_000;
const ONE_M_SUFFIX = "[1m]";
const CATALOG_TIMEOUT_MS = 90_000;

/** Probe result per model: the window without the suffix (null = probe failed) and whether `[1m]` is a real choice. */
export interface ContextWindowProbe {
  base: number | null;
  oneM: boolean;
}

/** The model id `setModel` gets for a catalog id and a window (`[1m]` only when the window is 1M). */
export function runtimeModelId(id: string, contextWindow: number | null): string {
  return contextWindow === ONE_M_CONTEXT ? `${id}${ONE_M_SUFFIX}` : id;
}

function clip(s: string, max: number): string {
  return s.trim().slice(0, max);
}

/**
 * PURE. The `default` alias row is dropped; the row resolving to the same model is the default. Alias rows are
 * current, explicit `claude-*` rows are "Legacy models". No NEW badge (Claude reports no such field, D-08); efforts
 * as reported minus the deferred ones, with no invented default (D-09); 200k/1M only where the probe accepted
 * both (D-10); fast mode as the runtime flags it (D-11).
 */
export function buildClaudeCatalog(input: {
  models: ModelInfo[];
  contextWindows: Record<string, ContextWindowProbe>;
  runtimeVersion: string | null;
  permissionModes: PermissionMode[];
  collectedAt: string;
}): RuntimeCatalog {
  const defaultTarget = input.models.find((m) => m.value === "default")?.resolvedModel ?? null;
  let defaultTaken = false;
  const models: RuntimeModel[] = [];
  for (const m of input.models) {
    if (m.value === "default" || !m.value || models.length >= 100) continue;
    const legacy = m.value.startsWith("claude-");
    const isDefault =
      !defaultTaken &&
      defaultTarget !== null &&
      (m.value === defaultTarget || m.resolvedModel === defaultTarget);
    if (isDefault) defaultTaken = true;
    const probe = input.contextWindows[m.value];
    const base = probe?.base != null && ContextWindow.safeParse(probe.base).success ? probe.base : null;
    const both = base !== null && base < ONE_M_CONTEXT && probe?.oneM === true;
    const description = clip(m.description ?? "", 500);
    models.push({
      id: clip(m.value, 200),
      displayName: clip(m.displayName ?? "", 200) || clip(m.value, 200),
      description: description || null,
      legacy,
      isDefault,
      badge: null,
      efforts: m.supportsEffort
        ? (m.supportedEffortLevels ?? [])
            .filter((e) => !DEFERRED_EFFORTS.includes(e))
            .map((value) => ({ value, description: null }))
        : [],
      defaultEffort: null,
      contextWindows: both ? [base, ONE_M_CONTEXT] : [],
      defaultContextWindow: base,
      fastMode: { supported: m.supportsFastMode === true, reason: null },
      supportsAutoMode: m.supportsAutoMode === true,
    });
  }
  return {
    runtime: "claude-code",
    runtimeVersion: input.runtimeVersion ? input.runtimeVersion.slice(0, 64) : null,
    models,
    permissionModes: [...input.permissionModes],
    fastModeCost: CLAUDE_FAST_MODE_COST,
    collectedAt: input.collectedAt,
  };
}

export interface CollectOptions {
  claudePath: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs?: number;
}

/**
 * Same locked-down options as a session (no bypass, project settings only, secret deny rules; every tool denied).
 * `default`, not `plan`: in plan mode the CLI runs Haiku as Sonnet, so the probe read Sonnet's 1M window for
 * `haiku` (observed at 2.1.289; the 2.1.287 plan-read fixture shows the same substitution).
 */
function probeOptions(opts: CollectOptions, abort: AbortController): Options {
  const options: Options = {
    cwd: opts.cwd,
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    settingSources: ["project"],
    settings: { permissions: { deny: secretDenyRules(), disableBypassPermissionsMode: "disable" } },
    canUseTool: async () => ({ behavior: "deny", message: "Catalog probe: no tools." }),
    env: opts.env,
    abortController: abort,
  };
  if (opts.claudePath) options.pathToClaudeCodeExecutable = opts.claudePath;
  return options;
}

async function probeWindow(q: QueryHandle, model: string): Promise<number | null> {
  try {
    await q.setModel(model);
    const usage = await q.getContextUsage({ detail: "summary" });
    return typeof usage.maxTokens === "number" && usage.maxTokens > 0 ? usage.maxTokens : null;
  } catch {
    return null; // the runtime refused the model (e.g. "Sonnet with 1M context is not available for your account")
  }
}

/** Raw runtime answers: `initializationResult().models` and the per-model window probe. Sends no user message. */
export async function probeClaudeModels(
  queryFn: QueryFn,
  opts: CollectOptions,
): Promise<{ models: ModelInfo[]; contextWindows: Record<string, ContextWindowProbe> }> {
  const prompt = new AsyncQueue<SDKUserMessage>(); // never pushed: no turn
  const abort = new AbortController();
  const q = queryFn({ prompt, options: probeOptions(opts, abort) });
  // Drain the message stream so the transport never blocks on an unread message.
  const drained = (async () => {
    try {
      for await (const _ of q) {
        // the probe sends no prompt; nothing to read
      }
    } catch {
      // closed
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Claude Code catalog probe timed out")),
      opts.timeoutMs ?? CATALOG_TIMEOUT_MS,
    );
    timer.unref();
  });
  try {
    return await Promise.race([
      (async () => {
        const init = await q.initializationResult();
        const models = Array.isArray(init.models) ? init.models : [];
        const contextWindows: Record<string, ContextWindowProbe> = {};
        for (const m of models) {
          if (m.value === "default" || contextWindows[m.value]) continue;
          const base = await probeWindow(q, m.value);
          const withSuffix = await probeWindow(q, runtimeModelId(m.value, ONE_M_CONTEXT));
          contextWindows[m.value] = { base, oneM: withSuffix === ONE_M_CONTEXT };
        }
        return { models, contextWindows };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    prompt.close();
    try {
      q.close();
    } catch {
      // already closed
    }
    abort.abort();
    await Promise.race([drained, new Promise((r) => setTimeout(r, 1_000).unref())]);
  }
}

/** The catalog the device reports for Claude Code (P-05). Never sends a model turn. */
export async function collectClaudeCatalog(
  queryFn: QueryFn,
  opts: CollectOptions & { runtimeVersion: string | null; permissionModes: PermissionMode[] },
): Promise<RuntimeCatalog> {
  const { models, contextWindows } = await probeClaudeModels(queryFn, opts);
  return buildClaudeCatalog({
    models,
    contextWindows,
    runtimeVersion: opts.runtimeVersion,
    permissionModes: opts.permissionModes,
    collectedAt: new Date().toISOString(),
  });
}
