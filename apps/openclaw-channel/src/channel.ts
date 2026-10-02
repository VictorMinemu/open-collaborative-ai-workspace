import path from "node:path";
import { type ChannelGatewayContext, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID, type ResolvedOcwAccount, readSection, resolveOcwAccount } from "./account.js";
import { createAgentChannelClient } from "./api-client.js";
import { createBridge } from "./bridge.js";
import { createFileCursorStore } from "./cursor-store.js";
import { runEventStream } from "./event-stream.js";
import { CHANNEL_ID, parseTarget } from "./mention-mapper.js";
import { createOpenClawPort, type PluginRuntimeLike } from "./openclaw-port.js";

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
  const runtime = requireRuntime();
  const log = {
    info: (m: string) => ctx.log?.info(`[ocw] ${m}`),
    warn: (m: string) => ctx.log?.warn(`[ocw] ${m}`),
    error: (m: string) => ctx.log?.error(`[ocw] ${m}`),
  };
  const client = createAgentChannelClient({ apiUrl: account.apiUrl, token: account.readToken });
  const port = createOpenClawPort({ runtime, accountId: account.accountId, cfg: ctx.cfg, log });
  const bridge = createBridge({ client, port, signal: ctx.abortSignal, log });
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
  for (let attempt = 0; !ctx.abortSignal.aborted && !startup; attempt++) {
    try {
      startup = await bridge.refreshCell();
    } catch (error) {
      log.warn(
        `initial cell sync failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)));
    }
  }
  if (!startup) return;
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
      signal: ctx.abortSignal,
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
