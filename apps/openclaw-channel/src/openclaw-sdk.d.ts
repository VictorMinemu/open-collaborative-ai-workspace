/**
 * Narrow ambient declarations for the OpenClaw 2026.9.7 plugin SDK subpaths this plugin imports.
 *
 * Why not a devDependency on `openclaw`: the package is ~740 MB with 340+ transitive deps and a
 * postinstall script; pulling it into every workspace install for two functions is not worth it.
 * At runtime the gateway supplies these modules to the plugin. The shapes below were copied from
 * `openclaw@2026.9.7` dist d.ts (channel-core) and are exercised by the real-container test
 * (infra/openclaw/test). Re-check them on every OpenClaw bump.
 */
declare module "openclaw/plugin-sdk/channel-core" {
  export type OpenClawConfig = Record<string, unknown> & {
    channels?: Record<string, unknown>;
    agents?: { entries?: Record<string, Record<string, unknown>>; [k: string]: unknown };
  };

  export type ChannelAccountSnapshot = Record<string, unknown> & { accountId: string };

  export type ChannelLogSink = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  export type ChannelGatewayContext<ResolvedAccount> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
  };

  export type ChannelConfigAdapter<ResolvedAccount> = {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => Record<string, unknown>;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    isConfigured?: (account: ResolvedAccount) => boolean;
  };

  export type ChannelPluginBase<ResolvedAccount> = {
    id: string;
    meta?: Record<string, unknown>;
    capabilities?: {
      chatTypes?: Array<"direct" | "group" | "channel">;
      threads?: boolean;
      media?: boolean;
      blockStreaming?: boolean;
    };
    reload?: { configPrefixes: string[] };
    config: ChannelConfigAdapter<ResolvedAccount>;
    gateway?: {
      startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
    };
    /**
     * dist/status-*.mjs `buildChannelAccountSnapshotFromAccount`: when present, its result is the account's
     * `channels.status` snapshot (then OpenClaw applies enabled/configured/running state and keeps `lastError`).
     */
    status?: {
      buildAccountSnapshot?: (params: {
        account: ResolvedAccount;
        cfg: OpenClawConfig;
        runtime?: ChannelAccountSnapshot;
        probe?: unknown;
        audit?: unknown;
      }) => Record<string, unknown> | Promise<Record<string, unknown>>;
    };
    messaging?: Record<string, unknown>;
  };

  export type ChannelPlugin<ResolvedAccount = unknown> = ChannelPluginBase<ResolvedAccount> &
    Record<string, unknown>;

  export function createChatChannelPlugin<ResolvedAccount>(params: {
    base: ChannelPluginBase<ResolvedAccount>;
    threading?: { topLevelReplyToMode: "reply" | "off" | "first" | "all" };
    outbound?: Record<string, unknown>;
    security?: Record<string, unknown>;
  }): ChannelPlugin<ResolvedAccount>;

  /** `before_tool_call` / `after_tool_call` event (2026.9.7 docs/plugins/hooks/tool-policy.md, dist hook runner). */
  export type PluginHookToolCallEvent = {
    toolName: string;
    params?: Record<string, unknown>;
    toolCallId?: string;
    runId?: string;
    /** after_tool_call only. */
    result?: unknown;
    error?: unknown;
    durationMs?: number;
  };

  export type PluginHookToolContext = {
    toolName?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    toolCallId?: string;
    /** Aborts when the owning tool call is cancelled (before_tool_call). */
    abortSignal?: AbortSignal;
    requester?: { channel?: string; accountId?: string; senderId?: string; senderIsOwner?: boolean };
  };

  export type BeforeToolCallResult = {
    block?: boolean;
    blockReason?: string;
    params?: Record<string, unknown>;
  };

  export type HookOptions = { priority?: number; matcher?: string[]; timeoutMs?: number };

  /**
   * Trusted runtime context a tool factory receives when tools are assembled for a run (2026.9.7
   * `resolveOpenClawPluginToolInputs` in dist/openclaw-tools-*.mjs, docs/plugins/building-plugins.md
   * "Registering tools"): `sessionKey` is the run's session key, `nativeChannelId` the platform conversation.
   */
  export type OpenClawPluginToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    nativeChannelId?: string;
    requesterSenderId?: string;
    senderIsOwner?: boolean;
    sandboxed?: boolean;
  };

  /** A concrete agent tool: `execute(toolCallId, params, signal?, onUpdate?)` (core runtime signature). */
  export type OpenClawAgentTool = {
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<{ content: Array<TextContent | ImageContent>; details?: unknown }>;
  };

  export type TextContent = { type: "text"; text: string };
  /**
   * An image block of a tool result (pi-ai `ImageContent`). It reaches the model only when the provider model declares
   * `input: ["text", "image"]`; Chat Completions models then get it as a labelled `user` message after the tool message
   * (07.8 spike ii). Otherwise OpenClaw replaces it with "(tool image omitted: model does not support images)".
   */
  export type ImageContent = { type: "image"; data: string; mimeType: string };

  /** How the registry being built was loaded (docs/plugins/sdk-entrypoints/registration-mode.md). */
  export type PluginRegistrationMode =
    | "full"
    | "discovery"
    | "tool-discovery"
    | "setup-only"
    | "setup-runtime"
    | "cli-metadata";

  /** The subset of `OpenClawPluginApi` this plugin uses. */
  export type OpenClawPluginApi = {
    registrationMode?: PluginRegistrationMode;
    logger?: {
      info?: (msg: string) => void;
      warn?: (msg: string) => void;
      error?: (msg: string) => void;
    };
    registerTool(
      factory: (ctx: OpenClawPluginToolContext) => OpenClawAgentTool | null | undefined,
      opts: { name: string; optional?: boolean },
    ): void;
    on(
      hook: "before_tool_call",
      handler: (
        event: PluginHookToolCallEvent,
        ctx: PluginHookToolContext,
      ) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>,
      opts?: HookOptions,
    ): void;
    on(
      hook: "after_tool_call",
      handler: (event: PluginHookToolCallEvent, ctx: PluginHookToolContext) => void | Promise<void>,
      opts?: HookOptions,
    ): void;
    /**
     * Fired once per gateway boot, after the startup sidecars (channel auto-start included) ran, from the boot
     * registry only (dist/server-startup-post-attach-*.mjs `runGatewayStartupObservers`). Awaited with a timeout:
     * long work must be detached. `abortSignal` aborts on shutdown and restart drain.
     */
    on(
      hook: "gateway_start",
      handler: (event: { port: number }, ctx: PluginHookGatewayStartContext) => void | Promise<void>,
      opts?: HookOptions,
    ): void;
  };

  export type PluginHookGatewayStartContext = {
    port: number;
    config?: OpenClawConfig;
    workspaceDir?: string;
    abortSignal?: AbortSignal;
  };

  export function defineChannelPluginEntry<ResolvedAccount>(params: {
    id: string;
    name: string;
    description: string;
    plugin: ChannelPlugin<ResolvedAccount>;
    setRuntime?: (runtime: unknown) => void;
    /** Runs only in "full" and "tool-discovery" (dist/core-*.mjs). */
    registerFull?: (api: OpenClawPluginApi) => void;
    /**
     * Runs in "full", "discovery" and "tool-discovery". Agent turns run with a non-activated ("discovery")
     * registry whenever the config changed after boot, so anything a turn needs (typed hooks) goes here.
     */
    registerCapabilities?: (api: OpenClawPluginApi) => void;
  }): unknown;

  export function defineSetupPluginEntry<ResolvedAccount>(plugin: ChannelPlugin<ResolvedAccount>): unknown;
}

/**
 * Provider sign-in flow (JS-only export of openclaw@2026.9.7 `package.json#exports`; the same helper
 * OpenClaw's own channel `/login` command and Control UI use). Shapes copied from
 * `dist/provider-auth-login-flow-runtime-*.mjs` + `dist/auth-*.mjs` (runModelsAuthLoginFlow) and verified
 * against a real 2026.9.7 gateway (device code obtained from auth.openai.com). Re-check on every bump.
 */
declare module "openclaw/plugin-sdk/provider-auth-login-flow-runtime" {
  export type LoginPrompter = {
    intro(title?: string): Promise<void>;
    outro(message?: string): Promise<void>;
    note(message: string, title?: string): Promise<void>;
    plain(message: string): Promise<void>;
    deviceCode?(params: {
      title?: string;
      code: string;
      expiresInMinutes: number;
      message?: string;
    }): Promise<void>;
    select(params: { message: string; options: Array<{ value: string; label?: string }> }): Promise<string>;
    multiselect(params: unknown): Promise<string[]>;
    text(params: unknown): Promise<string>;
    confirm(params: unknown): Promise<boolean>;
    progress(message: string): { update(message: string): void; stop(message?: string): void };
  };

  export type LoginRuntime = {
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
    exit(code: number): never;
  };

  export type ModelsAuthLoginFlowResult = {
    providerId: string;
    methodId: string;
    authRefresh: "refreshed" | "gateway-rejected" | "gateway-unreachable";
    defaultModel?: string;
    profiles: Array<{ profileId: string; provider: string; mode: "api_key" | "oauth" | "token" }>;
  };

  export function runModelsAuthLoginFlow(params: {
    provider: string;
    method: string;
    ownerPluginId: string;
    /** Save the credential only; never change the default model. */
    credentialOnly: boolean;
    /**
     * 07.18 probe A-03 (holds), read from the pinned 2026.9.7 `dist/auth-BShLso3q.mjs`: `runModelsAuthLoginFlow`
     * spreads its options into `runProviderAuthMethod`, whose `resolveReloginProfileIdentity` stores the method's one
     * returned profile under `requestedProfileId` (the CLI's `models auth login --profile-id`). Absent = the method's
     * own id (`openai:<email>`, or the matching existing profile on a re-login). A requested id with a method that
     * returns several profiles throws.
     */
    profileId?: string;
    /** Agent whose auth store receives the credential (`main` = the shared store). */
    agent: string;
    config: Record<string, unknown>;
    runtime: LoginRuntime;
    prompter: LoginPrompter;
    signal: AbortSignal;
    /** true: the code is shown elsewhere (here: the OCW web UI); `openUrl` receives the verification URL. */
    isRemote: boolean;
    openUrl(url: string): Promise<void>;
    assertCurrent?(): void;
    beforePersistentEffect?(): void | Promise<void>;
    onModelAccessRequested?(request: unknown): void;
    refreshAfterLogin?(agentId: string): Promise<void>;
  }): Promise<ModelsAuthLoginFlowResult>;

  export function refreshProviderLoginAuthState(params: {
    agentId: string;
    readConfig(): Record<string, unknown>;
    assertCurrent(config: Record<string, unknown>): void;
  }): Promise<void>;
}

/**
 * Public `openclaw/plugin-sdk/gateway-runtime` (subset): the client behind `openclaw gateway call`
 * (dist/gateway-rpc-*.mjs). Inside the gateway it resolves the local URL and the shared token from config/env.
 */
declare module "openclaw/plugin-sdk/gateway-runtime" {
  export function callGatewayFromCli(
    method: string,
    opts: { json?: boolean; timeout?: string; token?: string; url?: string },
    params?: unknown,
    extra?: { progress?: boolean; timeoutMs?: number },
  ): Promise<unknown>;
}

/**
 * Public, typed `openclaw/plugin-sdk/provider-auth` (subset). Every writer resolves null when the store lock is busy
 * (`dist/provider-auth-write-compat-*.mjs` in 2026.9.7); omitted `agentDir` = the shared `main` store.
 *
 * 07.18 probes, read from the pinned 2026.9.7 dist (`dist/plugin-sdk/provider-auth.js`, `dist/profiles-*.mjs`,
 * `dist/order-*.mjs`, `dist/model-auth-provider-*.mjs`, `dist/oauth-*.mjs`, `dist/gateway/server-methods` handler
 * `dist/models-auth-order-*.mjs`, docs `gateway/authentication.md`, `auth-credential-semantics.md`):
 *
 * - **A-04 (order).** The gateway method is `models.authOrderSet` `{ provider, profileIds: string[] | null, agentId? }`
 *   (null clears). It refuses a list that leaves out any stored profile of the provider ("profileIds must include every
 *   available profile") and refuses when `auth.order` in config owns the order, so it cannot keep a disabled profile
 *   out. What it calls, `setAuthProfileOrder`, only writes `store.order[provider]` under the store lock; the cell does
 *   the same through `updateAuthProfileStoreWithLock`. At selection (`resolveAuthProfileOrderWithMetadata`) an explicit
 *   order is the only candidate list: unlisted profiles are excluded (`models status --probe` shows
 *   `excluded_by_auth_order`), listed ones keep their order and cooling ones go last. Exception: when every listed
 *   profile is missing from the store, OpenClaw falls back to all stored profiles. No order = OAuth before token
 *   before api_key, then least recently used. A stored order beats `auth.order` in config.
 * - **A-05 (token profiles before the provider key) holds.** `resolveApiKeyForProviderCore` tries, in order: a session
 *   pin, a provider entry whose `apiKey` names a stored profile, an entry with `auth: "api-key"` (the reconciler never
 *   sets it), non-secret markers, then the auth profiles in order, and only then the entry's own key. A `token`
 *   profile may carry `tokenRef` (an env SecretRef) instead of `token`; `resolveApiKeyForProfile` reads it from the
 *   runtime snapshot that `refreshProviderLoginAuthState` re-publishes from the gateway env. Not exercised with a real
 *   setup-token here (no real account in tests): owner UAT.
 */
declare module "openclaw/plugin-sdk/provider-auth" {
  export function removeProviderAuthProfilesWithLock(params: {
    cfg?: Record<string, unknown>;
    provider: string;
    agentDir?: string;
    /** Exact ids (whatever their provider) instead of every profile of `provider`. */
    profileIds?: string[];
  }): Promise<unknown | null>;

  /** An env (or file/exec/store) SecretRef: exactly these three keys. */
  export type SecretRef = { source: "env" | "file" | "exec" | "store"; provider: string; id: string };

  export type AuthProfileCredential =
    | { type: "token"; provider: string; token?: string; tokenRef?: SecretRef; expires?: number }
    | { type: "api_key"; provider: string; key?: string; keyRef?: SecretRef }
    | ({ type: "oauth"; provider: string } & Record<string, unknown>);

  /** The function behind `openclaw models auth paste-token` (07.18, A-05): one profile, under the store lock. */
  export function upsertAuthProfileWithLock(params: {
    profileId: string;
    credential: AuthProfileCredential;
    agentDir?: string;
    stateDir?: string;
  }): Promise<unknown | null>;

  /** A locked read-modify-write of the auth store; `updater` returns whether it changed anything (07.18, A-04). */
  export function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    saveOptions?: { preserveOrderProfileIds?: string[] };
    updater: (store: {
      profiles: Record<string, Record<string, unknown>>;
      order?: Record<string, string[]>;
    }) => boolean;
  }): Promise<unknown | null>;
}

/**
 * Public `openclaw/plugin-sdk/session-store-runtime` (subset; package.json export, dist/session-store-runtime-*.mjs:342
 * in 2026.9.7). Deletes one session entry by agent and session key, optionally archiving its transcript; resolves true
 * when an entry was deleted. Quick 261113-id6: the bridge's fresh session after a failed summary.
 */
declare module "openclaw/plugin-sdk/session-store-runtime" {
  export function deleteSessionEntry(params: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
    env?: NodeJS.ProcessEnv;
    archiveTranscript?: boolean;
    expectedSessionId?: string;
    expectedUpdatedAt?: number;
  }): Promise<boolean>;
}
