import path from "node:path";
import { type ChannelGatewayContext, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID, type ResolvedOcwAccount, readSection, resolveOcwAccount } from "./account.js";
import { claimActiveAccount, releaseActiveAccount } from "./active-account.js";
import { createAgentChannelClient } from "./api-client.js";
import { createBridge } from "./bridge.js";
import { buildOcwAccountSnapshot } from "./channel-status.js";
import { createFileCursorStore } from "./cursor-store.js";
import { runEventStream } from "./event-stream.js";
import { CHANNEL_ID, parseTarget } from "./mention-mapper.js";
import { createOpenClawAuthDriver } from "./openclaw-auth.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";
import { createPluginInstaller, reportPluginViaChild } from "./plugin-installer.js";
import { createSubscriptionAuth } from "./subscription-auth.js";
import { setToolGuardClient } from "./tool-guard.js";

let pluginRuntime: PluginRuntimeLike | undefined;

/** Called by the entry's `setRuntime` (every registration mode except CLI metadata). */
export function setOcwRuntime(runtime: unknown): void {
  // The host passes its PluginRuntime; we only rely on the structural subset in PluginRuntimeLike.
  pluginRuntime = runtime as PluginRuntimeLike;
}

function requireRuntime(): PluginRuntimeLike {
  if (!pluginRuntime) throw new Error("ocw channel: OpenClaw runtime not initialised");
  return pluginRuntime;
}

/**
 * Latest host runtime, resolved on every access: after a hot reload OpenClaw hands the plugin a new
 * runtime and closes the old one's async work scope, so nothing may keep a reference to a stale one.
 */
const liveRuntime = new Proxy({} as PluginRuntimeLike, {
  get: (_target, prop) => Reflect.get(requireRuntime(), prop),
});

function resolveStateDir(runtime: PluginRuntimeLike): string {
  const fromRuntime = runtime.state?.resolveStateDir?.(process.env);
  return fromRuntime || process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME ?? "/tmp", ".openclaw");
}

async function startOcwAccount(ctx: ChannelGatewayContext<ResolvedOcwAccount>): Promise<void> {
  const account = ctx.account;
  if (!account.configured || !account.apiUrl) {
    throw new Error(
      "ocw channel is not configured: set OCW_API_URL and OCW_CELL_TOKEN_FILE (or OCW_CELL_TOKEN)",
    );
  }
  const runtime = liveRuntime;
  requireRuntime();
  const active = claimActiveAccount(ctx.abortSignal);
  const signal = active.signal;
  const log = {
    info: (m: string) => ctx.log?.info(`[ocw] ${m}`),
    warn: (m: string) => ctx.log?.warn(`[ocw] ${m}`),
    error: (m: string) => ctx.log?.error(`[ocw] ${m}`),
  };
  // Our own copy of the account (plain strings and a closure in this module): `ctx.account` is a host view that
  // OpenClaw retires with this plugin instance, while a plugin job started here may still have to report after
  // the instance was replaced (installing a plugin replaces the plugin generation).
  const own = resolveOcwAccount(readSection(ctx.cfg));
  const apiUrl = own.apiUrl ?? account.apiUrl;
  const readToken = own.tokenSource === "missing" ? account.readToken : own.readToken;
  const client = createAgentChannelClient({ apiUrl, token: readToken });
  // The tool gate (hooks registered in index.ts) asks the API through this account's client.
  setToolGuardClient(client);
  const port = createOpenClawPort({
    runtime,
    accountId: account.accountId,
    cfg: ctx.cfg,
    log,
    stateDir: resolveStateDir(runtime),
  });
  // Subscription sign-in (ChatGPT via Codex device code) runs here, inside OpenClaw (ADR-0006).
  const subscriptions = createSubscriptionAuth({
    client,
    driver: createOpenClawAuthDriver({ runtime, log }),
    signal,
    log,
  });
  // Marketplace executor (D-14): approved installs only, behind OpenClaw's install gate (infra/openclaw/install-policy.mjs).
  let bridgeRef: ReturnType<typeof createBridge> | undefined;
  const plugins = createPluginInstaller({
    client,
    snapshot: () => bridgeRef?.snapshot(),
    refresh: () => {
      if (!bridgeRef) throw new Error("bridge not ready");
      return bridgeRef.refreshCell();
    },
    stateDir: resolveStateDir(runtime),
    clawhubOrigin: process.env.OCW_CLAWHUB_URL?.trim() || "https://clawhub.ai",
    // OpenClaw's CLI entry in the image; overridable for a gateway run outside the image.
    ...(process.env.OCW_OPENCLAW_CLI?.trim() ? { cliPath: process.env.OCW_OPENCLAW_CLI.trim() } : {}),
    // Installing a plugin retires this instance (and its fetch) before the job can report: report from a child.
    reportFallback: (report) => reportPluginViaChild(apiUrl, readToken(), report),
    log,
  });
  const bridge = createBridge({ client, port, signal, log, subscriptions, plugins });
  bridgeRef = bridge;
  const cursorFile = path.join(resolveStateDir(runtime), "ocw-channel", `cursor-${account.accountId}.json`);

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: true,
  });

  // Config sync before accepting events: every bot must exist as an OpenClaw agent with its model.
  let startup: { topic: string; lastSeq: number } | undefined;
  for (let attempt = 0; !signal.aborted && !startup; attempt++) {
    try {
      startup = await bridge.refreshCell();
    } catch (error) {
      log.warn(
        `initial cell sync failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)));
    }
  }
  if (!startup) {
    releaseActiveAccount(active);
    return;
  }
  const { topic } = startup;
  let startupBaseline: number | undefined = startup.lastSeq;

  try {
    await runEventStream({
      wsUrl: () => client.wsUrl(),
      authHeader: () => client.authHeader(),
      topic,
      cursor: createFileCursorStore(cursorFile),
      // No persisted cursor / server resync: go live from the snapshot's lastSeq (never re-answer old mentions).
      baseline: async () => {
        if (startupBaseline !== undefined) {
          const seq = startupBaseline;
          startupBaseline = undefined;
          return seq;
        }
        return (await bridge.refreshCell()).lastSeq;
      },
      onEvent: (frame) => bridge.handleFrame(frame),
      signal,
      log,
      onStatus: (s) =>
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          connected: s.connected,
          lifecycle: s.connected ? "ready" : "recovering",
          ...(s.lastError ? { lastError: s.lastError } : {}),
        }),
    });
  } finally {
    releaseActiveAccount(active);
    if (signal.aborted && !ctx.abortSignal.aborted)
      log.info("superseded by a newer plugin instance; stopped");
    ctx.setStatus({ accountId: account.accountId, running: false, connected: false, lifecycle: "stopped" });
  }
}

export const ocwChannelPlugin = createChatChannelPlugin<ResolvedOcwAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Open Collaborative AI Workspace",
      selectionLabel: "OCW Agent Channel",
      blurb: "Bots of an Open Collaborative AI Workspace organization, via the Agent Channel API.",
      docsPath: "/channels/ocw",
      markdownCapable: true,
    },
    capabilities: { chatTypes: ["group"], threads: true, media: false, blockStreaming: false },
    reload: { configPrefixes: ["channels.ocw"] },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      resolveAccount: (cfg) => resolveOcwAccount(readSection(cfg)),
      inspectAccount: (cfg) => {
        const account = resolveOcwAccount(readSection(cfg));
        return {
          enabled: account.enabled,
          configured: account.configured,
          tokenStatus: account.tokenSource === "missing" ? "missing" : "available",
        };
      },
      isConfigured: (account) => account.configured,
    },
    gateway: { startAccount: startOcwAccount },
    // OpenClaw's default status projection drops `lastError`; ours keeps why the account is stopped (channel-status.ts).
    status: { buildAccountSnapshot: ({ account, runtime }) => buildOcwAccountSnapshot({ account, runtime }) },
    messaging: {
      targetPrefixes: ["ocw"],
      normalizeTarget: (raw: string) => {
        const parsed = parseTarget(raw);
        if (!parsed) return undefined;
        return parsed.threadRootId
          ? `conv:${parsed.conversationId}/thread:${parsed.threadRootId}`
          : `conv:${parsed.conversationId}`;
      },
      inferTargetChatType: () => "group",
      targetResolver: {
        looksLikeId: (raw: string) => parseTarget(raw) !== null,
        hint: "<conv:<conversationId>/thread:<rootMessageId>>",
      },
    },
  },
  threading: { topLevelReplyToMode: "reply" },
});
