/**
 * A faithful, minimal model of how OpenClaw 2026.9.7 registers and dispatches a plugin's typed hooks, copied
 * from the shipped dist (image ocw-openclaw:local, /app/dist) so tests exercise the REAL registration path of
 * our entry instead of calling `registerFull` by hand. Re-check every piece against the dist on each bump:
 *
 * - `defineChannelPluginEntry`            dist/core-*.mjs (verbatim mode gating)
 * - per-mode API surface                  dist/loader-runtime-load-*.mjs `resolvePluginRegistrationCapabilities`
 *                                         + `createPluginApiFactory` (`api.on` / `registerTool` only when
 *                                         `capabilityHandlers`; `registerChannel` except in `cli-metadata`)
 * - typed hook registration               same file, `registerTypedHook` (unknown names ignored, matcher rules)
 * - tool ownership                        same file, `registerTool` (names must be in manifest contracts.tools)
 * - registration mode of a load           same file, `resolvePluginRegistrationPlan`: `runtimeSideEffects`
 *                                         (= `activate !== false`) → "full", otherwise "discovery"
 * - hook dispatch                         dist/hooks-*.mjs `createHookRunner` (priority desc, `block` terminal,
 *                                         15 s default budget) + dist/hook-runner-global-*.mjs (fail-closed
 *                                         policy for before_tool_call; a prepared generation's registry is
 *                                         used EXCLUSIVELY while a turn runs)
 *
 * Why the modes matter: OpenClaw runs each agent turn inside a prepared plugin generation. Whenever the config
 * differs from the one the boot registry was activated with (always, in an OCW cell: the plugin writes the
 * cell's bots and providers right after boot), that generation's registry is a fresh
 * `loadPluginRegistryHandle({ activate: false })`, i.e. every plugin registers in "discovery" mode, and the
 * global hook runner reads ONLY that registry during the turn.
 */

export type RegistrationMode =
  | "full"
  | "discovery"
  | "tool-discovery"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata";

export const ALL_REGISTRATION_MODES: readonly RegistrationMode[] = [
  "full",
  "discovery",
  "tool-discovery",
  "setup-only",
  "setup-runtime",
  "cli-metadata",
];

type Handler = (event: unknown, ctx: unknown) => unknown;

export type TypedHookRegistration = {
  pluginId: string;
  hookName: string;
  handler: Handler;
  matcher?: string[];
  priority?: number;
  timeoutMs?: number;
};

export type HostRegistry = {
  mode: RegistrationMode;
  typedHooks: TypedHookRegistration[];
  tools: Array<{ pluginId: string; names: string[]; factory: unknown }>;
  channels: Array<{ pluginId: string; plugin: unknown }>;
  runtimes: unknown[];
  diagnostics: Array<{ level: "warn" | "error"; pluginId: string; message: string }>;
};

/** dist/hooks-*.mjs PLUGIN_HOOK_NAMES subset relevant here plus the rest of the catalog's tool hooks. */
const KNOWN_HOOKS = new Set([
  "before_tool_call",
  "after_tool_call",
  "resolve_exec_env",
  "tool_result_persist",
  "before_message_write",
  "before_prompt_build",
  "agent_end",
  "message_received",
  "message_sending",
]);

/** dist/hooks-*.mjs `normalizePluginToolMatcher`: omission is the only match-all form. */
function normalizeMatcher(matcher: unknown): string[] | undefined {
  if (matcher === undefined) return undefined;
  if (!Array.isArray(matcher)) throw new TypeError("tool hook matcher must be an array of tool names");
  if (matcher.length === 0) throw new TypeError("tool hook matcher must contain at least one tool name");
  return matcher.map((name) => {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("tool hook matcher entries must be non-empty strings");
    }
    if (name.trim() === "*") throw new TypeError("tool hook matcher wildcard entries are not supported");
    return name.trim();
  });
}

function capabilities(mode: RegistrationMode) {
  return {
    capabilityHandlers: mode === "full" || mode === "discovery" || mode === "tool-discovery",
    setupRuntimeHandlers: mode === "setup-runtime",
  };
}

/** The `api` object one plugin receives for one registry load (dist `createPluginApiFactory`, subset). */
export function createHostPluginApi(
  registry: HostRegistry,
  plugin: { id: string; contractsTools: readonly string[] },
): Record<string, unknown> {
  const caps = capabilities(registry.mode);
  const warn = (message: string) =>
    registry.diagnostics.push({ level: "warn", pluginId: plugin.id, message });
  const error = (message: string) =>
    registry.diagnostics.push({ level: "error", pluginId: plugin.id, message });
  const api: Record<string, unknown> = {
    id: plugin.id,
    registrationMode: registry.mode,
    runtime: registry.mode === "cli-metadata" ? undefined : { kind: `runtime:${registry.mode}` },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    registerCli: () => undefined,
  };
  if (registry.mode !== "cli-metadata") {
    api.registerChannel = (registration: { plugin: unknown }) =>
      registry.channels.push({ pluginId: plugin.id, plugin: registration.plugin });
  }
  if (caps.capabilityHandlers) {
    api.on = (hookName: string, handler: Handler, opts?: { matcher?: unknown; priority?: number }) => {
      if (!KNOWN_HOOKS.has(hookName)) {
        warn(`unknown typed hook "${hookName}" ignored`);
        return;
      }
      const matcher =
        hookName === "before_tool_call" || hookName === "after_tool_call"
          ? normalizeMatcher(opts?.matcher)
          : undefined;
      registry.typedHooks.push({
        pluginId: plugin.id,
        hookName,
        handler,
        ...(matcher ? { matcher } : {}),
        priority: opts?.priority,
      });
    };
    api.registerTool = (factory: unknown, opts?: { name?: string; names?: string[] }) => {
      const declared = new Set(plugin.contractsTools);
      if (declared.size === 0) {
        error("plugin must declare contracts.tools before registering agent tools");
        return;
      }
      const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
      const undeclared = names.filter((n) => !declared.has(n));
      if (undeclared.length > 0) {
        error(`plugin must declare contracts.tools for: ${undeclared.join(", ")}`);
        return;
      }
      registry.tools.push({ pluginId: plugin.id, names, factory });
    };
  }
  return api;
}

type EntryParams = {
  id: string;
  name: string;
  description: string;
  plugin: unknown;
  configSchema?: unknown;
  setRuntime?: (runtime: unknown) => void;
  registerCliMetadata?: (api: never) => void;
  registerFull?: (api: never) => void;
  registerCapabilities?: (api: never) => void;
};

/** dist/core-*.mjs `defineChannelPluginEntry`, verbatim mode gating (the config schema getter is elided). */
export function defineChannelPluginEntry(params: EntryParams) {
  const {
    id,
    name,
    description,
    plugin,
    setRuntime,
    registerCliMetadata,
    registerFull,
    registerCapabilities,
  } = params;
  return {
    id,
    name,
    description,
    register(api: Record<string, unknown> & { registrationMode: RegistrationMode }) {
      const a = api as never;
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(a);
        return;
      }
      if (api.registrationMode === "tool-discovery") {
        registerFull?.(a);
        registerCapabilities?.(a);
        return;
      }
      (api.registerChannel as (r: { plugin: unknown }) => void)({ plugin });
      setRuntime?.(api.runtime);
      if (api.registrationMode === "discovery") {
        registerCliMetadata?.(a);
        registerCapabilities?.(a);
        return;
      }
      if (api.registrationMode !== "full") return;
      registerCliMetadata?.(a);
      registerFull?.(a);
      registerCapabilities?.(a);
    },
    channelPlugin: plugin,
    ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
  };
}

/** Stand-in for `createChatChannelPlugin`: the entry only needs an object to hand to `registerChannel`. */
export function createChatChannelPlugin(params: { base: Record<string, unknown> }) {
  return { ...params.base };
}

/** The module our plugin imports as `openclaw/plugin-sdk/channel-core` (for `vi.mock`). */
export const channelCoreModule = { defineChannelPluginEntry, createChatChannelPlugin };

export type PluginEntry = { id: string; register: (api: never) => void };

/**
 * One registry load of our plugin, in the mode OpenClaw would pick. `activate` mirrors
 * `loadOpenClawPlugins({ activate })`: the boot load is activated ("full"), prepared turn generations are not
 * ("discovery"). Pass `mode` to force a specific mode (tool-discovery, setup-*, cli-metadata).
 */
export function loadRegistry(
  entry: PluginEntry,
  manifest: { id: string; contracts?: { tools?: string[] } },
  load: { activate: boolean } | { mode: RegistrationMode },
): HostRegistry {
  const mode: RegistrationMode = "mode" in load ? load.mode : load.activate ? "full" : "discovery";
  const registry: HostRegistry = {
    mode,
    typedHooks: [],
    tools: [],
    channels: [],
    runtimes: [],
    diagnostics: [],
  };
  const api = createHostPluginApi(registry, {
    id: manifest.id,
    contractsTools: manifest.contracts?.tools ?? [],
  });
  entry.register(api as never);
  return registry;
}

const BEFORE_TOOL_CALL_BUDGET_MS = 15_000;

class HookTimeoutError extends Error {}

async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HookTimeoutError(`hook timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The global hook runner as seen by a tool call inside a prepared turn: it reads ONLY `registry` (dist
 * `resolveHookRegistry` returns the generation registry exclusively), runs before_tool_call handlers in
 * priority order, stops at the first `block`, and blocks on a thrown error or an expired budget.
 */
export function createTurnHookRunner(registry: HostRegistry, opts: { budgetMs?: number } = {}) {
  const hooksFor = (hookName: string, toolName: string) =>
    registry.typedHooks
      .filter((h) => h.hookName === hookName && (!h.matcher || h.matcher.includes(toolName)))
      .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return {
    hasHooks: (hookName: string) => registry.typedHooks.some((h) => h.hookName === hookName),
    /** dist agent-tools.before-tool-call `runBeforeToolCallHook`: no hooks → the call runs unchecked. */
    async runBeforeToolCall(
      event: { toolName: string; params?: Record<string, unknown>; toolCallId?: string },
      ctx: Record<string, unknown>,
    ): Promise<{ blocked: boolean; reason?: string }> {
      const hooks = hooksFor("before_tool_call", event.toolName);
      if (hooks.length === 0) return { blocked: false };
      for (const hook of hooks) {
        try {
          const result = (await withBudget(
            Promise.resolve(hook.handler(structuredClone(event), ctx)),
            hook.timeoutMs ?? opts.budgetMs ?? BEFORE_TOOL_CALL_BUDGET_MS,
          )) as { block?: boolean; blockReason?: string } | undefined;
          if (result?.block === true) return { blocked: true, reason: result.blockReason };
        } catch {
          return { blocked: true, reason: "Tool call blocked because before_tool_call hook failed" };
        }
      }
      return { blocked: false };
    },
    async runAfterToolCall(
      event: Record<string, unknown> & { toolName: string },
      ctx: Record<string, unknown>,
    ) {
      await Promise.allSettled(hooksFor("after_tool_call", event.toolName).map((h) => h.handler(event, ctx)));
    },
  };
}
