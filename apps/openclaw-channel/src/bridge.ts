import {
  AgentChannelEventTypes,
  AgentMentionEvent,
  type AgentMentionEvent as AgentMentionEventType,
  type CellAgent,
  type CellSnapshot,
  ProviderAuthCancelEvent,
  ProviderAuthRevokeEvent,
  ProviderAuthStartEvent,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { sleep } from "./backoff.js";
import type { DurableFrame, EventStreamLogger } from "./event-stream.js";
import { type MappedMention, mapMention, replyIdempotencyKey } from "./mention-mapper.js";
import type { AgentProvisioningResult } from "./reconciler.js";
import type { SubscriptionAuth } from "./subscription-auth.js";

/**
 * Everything the bridge needs from OpenClaw. The real implementation (openclaw-port.ts) wraps the
 * plugin runtime; unit tests use a fake. Keeps all Agent Channel logic testable without OpenClaw.
 */
export type OpenClawPort = {
  /**
   * Runs one agent turn for the mention. `deliver` is called for every visible reply payload, in
   * order. Resolves when the turn is finished.
   */
  dispatchMention(
    mention: MappedMention,
    deliver: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Reconciles OpenClaw agents + providers with the snapshot; returns per-agent provisioning results.
   * `readySubscriptions`: subscription ids signed in inside this cell right now.
   */
  reconcile(
    cell: CellSnapshot,
    opts?: { readySubscriptions?: ReadonlySet<string> },
  ): Promise<{ changed: boolean; results: AgentProvisioningResult[] }>;
};

export type BridgeOptions = {
  client: AgentChannelClient;
  port: OpenClawPort;
  signal: AbortSignal;
  log?: EventStreamLogger;
  typingIntervalMs?: number;
  maxReplyChars?: number;
  /** Turn attempts while no reply was delivered yet (default 3). */
  dispatchAttempts?: number;
  /** Base delay between turn attempts (linear backoff, default 1.5 s). */
  retryDelayMs?: number;
  /** Subscription sign-in (provider.auth.* commands); omitted → those commands are ignored. */
  subscriptions?: SubscriptionAuth;
};

export const FAILURE_REPLY = "Sorry, I couldn't generate a reply right now. Please try again in a moment.";

/** Reply when the model provider rejected the cell's credentials (bad key, expired/revoked sign-in). */
export const AUTH_FAILURE_REPLY =
  "I couldn't reach my model: the provider rejected my credentials. An admin can reconnect it in Settings › Models.";

/** OpenClaw's own user-facing text for a failed turn; never forward it, treat it as a failure. */
const OPENCLAW_GENERIC_FAILURE = /^\W*Something went wrong while processing your request/i;
/** OpenClaw's text when the provider answered 401/403 (e.g. a ChatGPT sign-in that is no longer valid). */
const OPENCLAW_AUTH_FAILURE = /^\W*Authentication failed \(provider returned HTTP 40[13]\)/i;

export function isOpenClawGenericFailure(text: string): boolean {
  return OPENCLAW_GENERIC_FAILURE.test(text.trim());
}

export function isOpenClawAuthFailure(text: string): boolean {
  return OPENCLAW_AUTH_FAILURE.test(text.trim());
}

/** A turn that failed for a reason retrying cannot fix; `reply` is what the bot posts instead. */
class TerminalTurnError extends Error {
  constructor(
    message: string,
    readonly reply: string,
  ) {
    super(message);
    this.name = "TerminalTurnError";
  }
}

export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/u, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function createBridge(opts: BridgeOptions) {
  const log = opts.log ?? {};
  const agents = new Map<string, CellAgent>();
  const typingIntervalMs = opts.typingIntervalMs ?? 4_000;
  const maxReplyChars = opts.maxReplyChars ?? 19_000;
  const dispatchAttempts = Math.max(1, opts.dispatchAttempts ?? 3);
  const retryDelayMs = opts.retryDelayMs ?? 1_500;
  let refreshing: Promise<CellSnapshot> | null = null;
  let lastSnapshot: CellSnapshot | undefined;

  async function reportStatuses(results: AgentProvisioningResult[]): Promise<void> {
    for (const r of results) {
      const current = agents.get(r.agentId);
      if (!current || current.status === "disabled") continue;
      if (current.status === r.status) continue;
      try {
        await opts.client.reportStatus(
          r.agentId,
          r.detail ? { status: r.status, detail: r.detail.slice(0, 500) } : { status: r.status },
          opts.signal,
        );
        agents.set(r.agentId, { ...current, status: r.status });
      } catch (error) {
        log.warn?.(
          `status report for ${r.agentId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function doRefresh(): Promise<CellSnapshot> {
    // The snapshot contains provider keys: never log it.
    const cell = await opts.client.getCell(opts.signal);
    agents.clear();
    for (const agent of cell.agents) agents.set(agent.id, agent);
    const readySubscriptions = opts.subscriptions ? await opts.subscriptions.sync(cell) : new Set<string>();
    const { changed, results } = await opts.port.reconcile(cell, { readySubscriptions });
    lastSnapshot = cell;
    log.info?.(
      `cell synced: ${cell.agents.length} bot(s), ${cell.providers.length} provider(s)${changed ? ", OpenClaw updated" : ""}`,
    );
    await reportStatuses(results);
    return cell;
  }

  /** Coalesces concurrent refreshes (startup + cell.config.changed + unknown-agent lookups). */
  function refreshCell(): Promise<CellSnapshot> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  function startTyping(m: MappedMention): () => Promise<void> {
    const body = {
      agentId: m.ocwAgentId,
      conversationId: m.conversationId,
      threadRootMessageId: m.threadRootId,
    };
    const ping = (typing: boolean) =>
      opts.client.postTyping({ ...body, typing }, opts.signal).catch((error: unknown) => {
        log.warn?.(`typing ping failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    void ping(true);
    const timer = setInterval(() => void ping(true), typingIntervalMs);
    return async () => {
      clearInterval(timer);
      await ping(false);
    };
  }

  async function handleMention(event: AgentMentionEventType): Promise<void> {
    let agent = agents.get(event.agent.id);
    if (!agent) {
      await refreshCell();
      agent = agents.get(event.agent.id);
    }
    if (!agent) {
      log.warn?.(`mention ${event.eventId} for unknown agent ${event.agent.id}; skipped`);
      return;
    }
    if (agent.status === "disabled") {
      log.info?.(`mention ${event.eventId} for disabled agent ${agent.id}; skipped`);
      return;
    }
    const mention = mapMention(event, agent);
    let index = 0;
    const post = async (text: string) => {
      for (const chunk of chunkText(text, maxReplyChars)) {
        await opts.client.postMessage(
          {
            agentId: mention.ocwAgentId,
            conversationId: mention.conversationId,
            threadRootMessageId: mention.threadRootId,
            inReplyToMessageId: mention.messageId,
            text: chunk,
            idempotencyKey: replyIdempotencyKey(event.eventId, index++),
          },
          opts.signal,
        );
      }
    };
    const stopTyping = startTyping(mention);
    try {
      // A just-provisioned agent can be briefly unavailable while OpenClaw hot-applies config or
      // swaps plugin instances: retry while nothing has been delivered yet.
      for (let attempt = 1; ; attempt++) {
        try {
          await opts.port.dispatchMention(
            mention,
            async (text) => {
              if (isOpenClawAuthFailure(text)) {
                throw new TerminalTurnError(
                  "the model provider rejected the credentials",
                  AUTH_FAILURE_REPLY,
                );
              }
              if (isOpenClawGenericFailure(text)) throw new Error("OpenClaw reported a failed turn");
              if (text.trim()) await post(text);
            },
            opts.signal,
          );
          break;
        } catch (error) {
          if (index > 0 || opts.signal.aborted || attempt >= dispatchAttempts) throw error;
          if (error instanceof TerminalTurnError) throw error;
          log.warn?.(
            `mention ${event.eventId}: turn attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying`,
          );
          await sleep(retryDelayMs * attempt, opts.signal);
        }
      }
      if (index === 0) log.warn?.(`mention ${event.eventId}: agent produced no visible reply`);
    } catch (error) {
      if (opts.signal.aborted) throw error; // stopping: leave the event for the successor to replay
      log.error?.(
        `mention ${event.eventId}: turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (index === 0) {
        await opts.client
          .postMessage(
            {
              agentId: mention.ocwAgentId,
              conversationId: mention.conversationId,
              threadRootMessageId: mention.threadRootId,
              inReplyToMessageId: mention.messageId,
              text: error instanceof TerminalTurnError ? error.reply : FAILURE_REPLY,
              idempotencyKey: `evt:${event.eventId}:failed`,
            },
            opts.signal,
          )
          .catch(() => undefined);
      }
    } finally {
      await stopTyping();
    }
  }

  async function handleFrame(frame: DurableFrame): Promise<void> {
    switch (frame.type) {
      case AgentChannelEventTypes.mention: {
        const parsed = AgentMentionEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid agent.mention.v1 payload; skipped (${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "?"})`,
          );
          return;
        }
        await handleMention(parsed.data);
        return;
      }
      case AgentChannelEventTypes.configChanged:
        await refreshCell();
        return;
      case AgentChannelEventTypes.providerAuthStart:
      case AgentChannelEventTypes.providerAuthCancel:
      case AgentChannelEventTypes.providerAuthRevoke: {
        const auth = opts.subscriptions;
        if (!auth) {
          log.info?.(`seq=${frame.seq}: ${frame.type} ignored (subscription sign-in not available)`);
          return;
        }
        if (frame.type === AgentChannelEventTypes.providerAuthStart) {
          const parsed = ProviderAuthStartEvent.safeParse(frame.data);
          // Runs in the background: a sign-in waits minutes for the human; mentions must keep flowing.
          if (parsed.success) auth.handleStart(parsed.data);
          else log.warn?.(`seq=${frame.seq}: invalid ${frame.type}; skipped`);
        } else if (frame.type === AgentChannelEventTypes.providerAuthCancel) {
          const parsed = ProviderAuthCancelEvent.safeParse(frame.data);
          if (parsed.success) auth.handleCancel(parsed.data);
        } else {
          const parsed = ProviderAuthRevokeEvent.safeParse(frame.data);
          if (parsed.success) {
            await auth.handleRevoke(parsed.data).catch((error: unknown) => {
              log.error?.(
                `revoking ${parsed.data.provider} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
        }
        return;
      }
      default:
        log.info?.(`seq=${frame.seq}: ignoring unknown event type ${frame.type}`);
    }
  }

  return { refreshCell, handleFrame, handleMention, agents, snapshot: () => lastSnapshot };
}
