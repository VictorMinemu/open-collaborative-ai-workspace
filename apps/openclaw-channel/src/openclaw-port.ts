import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CellSnapshot } from "./agent-channel-protocol.js";
import type { OpenClawPort } from "./bridge.js";
import { CHANNEL_ID, type MappedMention } from "./mention-mapper.js";
import { applyPlanToDraft, type MutableConfig, planReconcile, type ReconcilePlan } from "./reconciler.js";

/**
 * Structural view of the parts of OpenClaw's `PluginRuntime` (2026.9.7) we use. Typed locally (see
 * openclaw-sdk.d.ts for why there is no `openclaw` devDependency).
 */
export type PluginRuntimeLike = {
  config: {
    current(): OpenClawConfig;
    mutateConfigFile(params: {
      afterWrite: { mode: "auto" | "none" | "restart"; reason?: string };
      writeOptions?: { allowedAgentRosterRemovals?: readonly string[] };
      mutate: (draft: OpenClawConfig) => void;
    }): Promise<unknown>;
  };
  state?: { resolveStateDir?: (env: NodeJS.ProcessEnv) => string };
  channel: {
    routing: {
      buildAgentSessionKey(params: {
        agentId: string;
        channel: string;
        accountId?: string | null;
        peer?: { kind: "direct" | "group" | "channel"; id: string } | null;
        dmScope?: string;
      }): string;
    };
    inbound: {
      ingress: { resolveStable(params: Record<string, unknown>): Promise<IngressResult> };
      buildContext(params: Record<string, unknown>): Record<string, unknown>;
      dispatch(params: Record<string, unknown>): Promise<unknown>;
    };
  };
};

type IngressResult = { ingress: { admission: string; reasonCode?: string } } & Record<string, unknown>;

/** Identity descriptor for ingress: our principal ids are opaque stable ids (UUIDs). */
const ingressIdentity = {
  key: "ocw-principal-id",
  normalizeEntry: (value: string) => value.trim().toLowerCase(),
  normalizeSubject: (value: string) => value.trim().toLowerCase(),
  isWildcardEntry: (value: string) => value.trim() === "*",
  entryIdPrefix: "ocw-principal",
};

export type RealPortOptions = {
  runtime: PluginRuntimeLike;
  accountId: string;
  /** Config snapshot of this account start; refreshed from runtime.config.current() per turn. */
  cfg: OpenClawConfig;
  log?: { info?: (m: string) => void; warn?: (m: string) => void };
};

export function threadSessionKey(base: string, threadRootId: string): string {
  return `${base}:thread:${threadRootId.toLowerCase()}`;
}

export function createOpenClawPort(opts: RealPortOptions): OpenClawPort {
  const { runtime, accountId } = opts;

  return {
    async reconcile(cell: CellSnapshot) {
      const current = runtime.config.current() as MutableConfig;
      const plan = planReconcile(
        { agents: current.agents?.entries, providers: current.models?.providers },
        cell,
      );
      // Secrets reach OpenClaw only through the gateway process env; the config holds ${ENV} refs.
      for (const [name, value] of Object.entries(plan.env)) process.env[name] = value;
      if (!plan.changed) return { changed: false, results: plan.results };
      const write = (p: ReconcilePlan) =>
        runtime.config.mutateConfigFile({
          afterWrite: { mode: "auto" },
          // OpenClaw refuses writes that drop agent roster entries unless the removal is declared
          // (same mechanism as `openclaw agents delete`).
          ...(p.removeAgents.length > 0
            ? { writeOptions: { allowedAgentRosterRemovals: p.removeAgents } }
            : {}),
          mutate(draft) {
            applyPlanToDraft(draft as MutableConfig, p);
          },
        });
      let removed = plan.removeAgents.length;
      try {
        await write(plan);
      } catch (error) {
        if (plan.removeAgents.length === 0) throw error;
        // Never let a refused deletion block bot sync: stale agents are inert (the bridge skips
        // unknown/disabled bots and the API stops sending them mentions).
        opts.log?.warn?.(
          `agent removal refused (${error instanceof Error ? error.message : String(error)}); keeping stale entries`,
        );
        await write({ ...plan, removeAgents: [] });
        removed = 0;
      }
      opts.log?.info?.(
        `reconciled OpenClaw: agents upsert=${Object.keys(plan.upsertAgents).length} remove=${removed}, providers upsert=${Object.keys(plan.upsertProviders).length}`,
      );
      return { changed: true, results: plan.results };
    },

    async dispatchMention(m: MappedMention, deliver, signal) {
      const cfg = runtime.config.current();
      const peer = { kind: "channel" as const, id: m.conversationId };
      const baseSessionKey = runtime.channel.routing.buildAgentSessionKey({
        agentId: m.openClawAgentId,
        channel: CHANNEL_ID,
        accountId,
        peer,
        dmScope: "main",
      });
      // One OpenClaw session per (bot, thread): OpenClaw serialises runs per session lane, which
      // gives "one generation per thread" for free.
      const sessionKey = threadSessionKey(baseSessionKey, m.threadRootId);

      const ingress = await runtime.channel.inbound.ingress.resolveStable({
        channelId: CHANNEL_ID,
        accountId,
        identity: ingressIdentity,
        cfg,
        subject: { stableId: m.sender.id },
        conversation: { kind: "group", id: m.conversationId },
        contextBinding: {
          agentId: m.openClawAgentId,
          sessionKey,
          nativeChannelId: m.conversationId,
          messageId: m.messageId,
          inboundEventKind: "user_request",
        },
        // Authorization already happened server-side: the API only delivers mentions from members
        // of conversations the agent belongs to. The cell token is the trust boundary.
        allowFrom: ["*"],
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        mentionFacts: { canDetectMention: true, wasMentioned: true, hasAnyMention: true },
        policy: { activation: { requireMention: true, allowTextCommands: false } },
        command: false,
      });
      if (ingress.ingress.admission !== "dispatch") {
        throw new Error(
          `OpenClaw ingress refused the turn (${ingress.ingress.reasonCode ?? ingress.ingress.admission})`,
        );
      }

      const ctxPayload = runtime.channel.inbound.buildContext({
        channelIngress: ingress,
        channel: CHANNEL_ID,
        accountId,
        messageId: m.messageId,
        messageIdFull: m.messageId,
        ...(m.timestampMs !== undefined ? { timestamp: m.timestampMs } : {}),
        from: m.target,
        sender: { id: m.sender.id, name: m.sender.name, isBot: m.sender.isBot },
        conversation: {
          kind: "group",
          id: m.conversationId,
          label: m.conversationLabel,
          threadId: m.threadRootId,
          nativeChannelId: m.conversationId,
        },
        route: { agentId: m.openClawAgentId, dmScope: "main", accountId, routeSessionKey: sessionKey },
        reply: {
          to: m.target,
          originatingTo: m.target,
          replyToId: m.messageId,
          messageThreadId: m.threadRootId,
          threadParentId: m.threadRootId,
        },
        message: {
          body: m.body,
          bodyForAgent: m.body,
          rawBody: m.body,
          commandBody: m.body,
          inboundHistory: m.inboundHistory,
        },
        sessionTranscript: { historyLimit: Math.max(1, m.inboundHistory.length), historyKind: "recent" },
        access: {
          commands: { authorized: false },
          mentions: {
            canDetectMention: true,
            wasMentioned: true,
            hasAnyMention: true,
            explicitlyMentionedBot: true,
            mentionedUserIds: m.mentionedUserIds,
          },
        },
        extra: {
          GroupMembers: m.groupMembers,
          GroupChannel: m.conversationLabel,
          GroupSystemPrompt: m.personaPrompt,
          SenderIsBot: m.sender.isBot,
          WasMentioned: true,
          ExplicitlyMentionedBot: true,
          ...(m.chatWindow.length > 0
            ? {
                ChannelStructuredContext: [
                  {
                    label: "Thread history",
                    source: CHANNEL_ID,
                    type: "chat_window",
                    payload: {
                      relation: "before_current_message",
                      order: "oldest_first",
                      messages: m.chatWindow,
                    },
                  },
                ],
              }
            : {}),
        },
      });

      await runtime.channel.inbound.dispatch({
        cfg,
        channel: CHANNEL_ID,
        accountId,
        route: { agentId: m.openClawAgentId, dmScope: "main", sessionKey },
        ctxPayload,
        // Defence in depth: no tools on any turn, regardless of config.
        toolsAllow: [],
        replyOptions: { disableTools: true, abortSignal: signal },
        delivery: {
          deliver: async (payload: { text?: string; isReasoning?: boolean }) => {
            if (payload.isReasoning) return;
            const text = payload.text ?? "";
            if (text.trim()) await deliver(text);
          },
          onError: (error: unknown) => {
            throw error instanceof Error ? error : new Error(`ocw dispatch failed: ${String(error)}`);
          },
        },
        replyPipeline: {},
        record: {
          onRecordError: (error: unknown) => {
            throw error instanceof Error ? error : new Error(`ocw session record failed: ${String(error)}`);
          },
        },
      });
    },
  };
}
