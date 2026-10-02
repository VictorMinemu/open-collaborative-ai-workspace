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

  export function defineChannelPluginEntry<ResolvedAccount>(params: {
    id: string;
    name: string;
    description: string;
    plugin: ChannelPlugin<ResolvedAccount>;
    setRuntime?: (runtime: unknown) => void;
    registerFull?: (api: unknown) => void;
  }): unknown;

  export function defineSetupPluginEntry<ResolvedAccount>(plugin: ChannelPlugin<ResolvedAccount>): unknown;
}
