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
 * - hook event tool name                  dist/agent-tools.before-tool-call-*.mjs `wrapToolWithBeforeToolCallHook`
 *                                         (`toolName: normalizeToolPolicyName(tool.name)`: lower-cased, aliases
 *                                         bash→exec, apply-patch→apply_patch, cron→automations; MCP tools keep
 *                                         their server's casing in the model-facing name, not in the hook event)
 * - known hook names                      dist/hooks-*.mjs `pluginHookNameSet` (subset below)
 * - gateway_start                         dist/server-startup-post-attach-*.mjs `runGatewayStartupObservers`: once per
 *                                         boot, AFTER the startup sidecars (channel auto-start included), from the
 *                                         boot registry, void hook awaited with a timeout
 * - restart-loop breaker                  dist/run-*.mjs `beginBoot` (message) + dist/gateway-boot-lifecycle-*.mjs
 *                                         (3 unclean boots / 5 min) + dist/server-channels-*.mjs
 *                                         `startChannelProcessOwned` (a non-manual start is refused and the account
 *                                         gets `lastError` = the breaker message; `manual: true` bypasses it)
 * - channels.status / channels.start      dist/channels-*.mjs gateway methods (`channelAccounts[<id>]` is an array;
 *                                         start is `startChannel(id, account, { manual: true })`), reached in process
 *                                         through `openclaw/plugin-sdk/gateway-runtime` `callGatewayFromCli`
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
  "gateway_start",
  "gateway_stop",
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

/** dist tool-policy-shared-*.mjs `normalizeToolPolicyName`. */
const TOOL_NAME_ALIASES = new Map([
  ["bash", "exec"],
  ["apply-patch", "apply_patch"],
  ["cron", "automations"],
]);
export function normalizeToolPolicyName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES.get(normalized) ?? normalized;
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
      call: { toolName: string; params?: Record<string, unknown>; toolCallId?: string },
      ctx: Record<string, unknown>,
    ): Promise<{ blocked: boolean; reason?: string }> {
      // `toolName` is the tool's model-facing name; the hook sees OpenClaw's policy name.
      const event = { ...call, toolName: normalizeToolPolicyName(call.toolName) };
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
      call: Record<string, unknown> & { toolName: string },
      ctx: Record<string, unknown>,
    ) {
      const event = { ...call, toolName: normalizeToolPolicyName(call.toolName) };
      await Promise.allSettled(hooksFor("after_tool_call", event.toolName).map((h) => h.handler(event, ctx)));
    },
  };
}

// ---------------------------------------------------------------- gateway boot: channels, breaker, gateway_start

/** dist/run-*.mjs `beginBoot` + `formatGatewayCrashLoopManualChannelStartHint()`, verbatim. */
export function breakerMessage(uncleanBoots: number, windowMs = 300_000): string {
  return (
    `gateway restart-loop breaker tripped: ${uncleanBoots} unclean boot(s) within ${windowMs}ms; suppressing ` +
    "channel/provider account auto-start. Inspect the stability bundle and fix the startup crash before restarting " +
    `the service. Start a channel manually with: openclaw gateway call channels.start --params '{"channel":"<id>"}'`
  );
}

type HostChannelPlugin = {
  id: string;
  config: {
    listAccountIds: (cfg: unknown) => string[];
    resolveAccount: (cfg: unknown, accountId?: string | null) => unknown;
  };
  gateway?: { startAccount?: (ctx: Record<string, unknown>) => Promise<unknown> };
};

export type HostAccountRuntime = { accountId: string; running: boolean; lastError?: string | null };
export type HostStartRecord = { channelId: string; accountId: string; manual: boolean; outcome: string };

/**
 * The gateway's channel manager for one boot (dist/server-channels-*.mjs `createChannelManager`, subset): the
 * crash-loop suppression is set before channels start; automatic starts are refused while it is set, manual ones
 * (`channels.start`) are not; an account task that already runs is "task-owned".
 */
export function createHostChannelManager(opts: {
  registry: HostRegistry;
  config: Record<string, unknown>;
  /** `channelAutostartSuppression` of this boot (null: the breaker did not trip). */
  suppression?: { reason: "crash-loop-breaker"; message: string } | null;
}) {
  const runtimes = new Map<string, HostAccountRuntime>();
  const tasks = new Map<string, AbortController>();
  const starts: HostStartRecord[] = [];
  const key = (channelId: string, accountId: string) => `${channelId}:${accountId}`;
  const pluginOf = (channelId: string) =>
    opts.registry.channels.map((c) => c.plugin as HostChannelPlugin).find((p) => p.id === channelId);

  function startChannel(channelId: string, accountId: string | undefined, start: { manual: boolean }) {
    const plugin = pluginOf(channelId);
    const outcomes = new Map<string, string>();
    if (!plugin?.gateway?.startAccount) return outcomes;
    const ids = accountId ? [accountId] : plugin.config.listAccountIds(opts.config);
    for (const id of ids) {
      const k = key(channelId, id);
      let outcome: string;
      if (opts.suppression && !start.manual) {
        runtimes.set(k, { accountId: id, running: false, lastError: opts.suppression.message });
        outcome = "autostart-suppressed";
      } else if (tasks.has(k)) {
        outcome = "task-owned";
      } else {
        const abort = new AbortController();
        tasks.set(k, abort);
        runtimes.set(k, { accountId: id, running: true, lastError: null });
        const ctx = {
          cfg: opts.config,
          accountId: id,
          account: plugin.config.resolveAccount(opts.config, id),
          abortSignal: abort.signal,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          getStatus: () => runtimes.get(k),
          setStatus: (next: Record<string, unknown>) =>
            runtimes.set(k, {
              ...(runtimes.get(k) ?? { accountId: id, running: false }),
              ...next,
            } as HostAccountRuntime),
        };
        // The account task runs until its abort signal fires (it is not awaited by the manager).
        void Promise.resolve()
          .then(() => plugin.gateway?.startAccount?.(ctx))
          .catch((error: unknown) =>
            runtimes.set(k, { accountId: id, running: false, lastError: String(error) }),
          )
          .finally(() => {
            if (tasks.get(k) === abort) tasks.delete(k);
          });
        outcome = "started";
      }
      starts.push({ channelId, accountId: id, manual: start.manual, outcome });
      outcomes.set(id, outcome);
    }
    return outcomes;
  }

  const manager = {
    starts,
    /** Startup sidecar `startChannels()`: every channel, automatic. */
    startChannels() {
      for (const c of opts.registry.channels)
        startChannel((c.plugin as HostChannelPlugin).id, undefined, { manual: false });
    },
    account(channelId: string, accountId: string): HostAccountRuntime | undefined {
      return runtimes.get(key(channelId, accountId));
    },
    stopAll() {
      for (const abort of tasks.values()) abort.abort();
      tasks.clear();
    },
    /** The two gateway methods (dist/channels-*.mjs), as the in-process gateway client sees them. */
    async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method === "channels.status") {
        const channelAccounts: Record<string, HostAccountRuntime[]> = {};
        for (const c of opts.registry.channels) {
          const plugin = c.plugin as HostChannelPlugin;
          if (typeof params.channel === "string" && params.channel !== plugin.id) continue;
          channelAccounts[plugin.id] = plugin.config
            .listAccountIds(opts.config)
            .map((id) => runtimes.get(key(plugin.id, id)) ?? { accountId: id, running: false });
        }
        return { ts: Date.now(), channelAccounts };
      }
      if (method === "channels.start") {
        const channelId = String(params.channel);
        if (!pluginOf(channelId)) throw new Error(`unknown channel: ${channelId}`);
        const accountId = typeof params.accountId === "string" ? params.accountId : "default";
        const outcome = startChannel(channelId, accountId, { manual: true }).get(accountId);
        return {
          channel: channelId,
          accountId,
          started: runtimes.get(key(channelId, accountId))?.running === true,
          outcome,
        };
      }
      throw new Error(`unknown method: ${method}`);
    },
  };
  activeGateway = manager;
  return manager;
}

export type HostChannelManager = ReturnType<typeof createHostChannelManager>;

let activeGateway: HostChannelManager | null = null;

/** The module our plugin imports as `openclaw/plugin-sdk/gateway-runtime` (for `vi.mock`): the latest manager. */
export const gatewayRuntimeModule = {
  async callGatewayFromCli(method: string, _opts: unknown, params?: Record<string, unknown>) {
    if (!activeGateway) throw new Error("gateway closed (1006): no gateway is running");
    return activeGateway.call(method, params ?? {});
  },
};

/** `runGatewayStartupObservers`: every gateway_start handler of the boot registry, awaited (void hook). */
export async function runGatewayStart(
  registry: HostRegistry,
  ctx: { port: number; config: Record<string, unknown>; abortSignal: AbortSignal },
): Promise<void> {
  await Promise.allSettled(
    registry.typedHooks
      .filter((h) => h.hookName === "gateway_start")
      .map((h) => Promise.resolve(h.handler({ port: ctx.port }, ctx))),
  );
}
