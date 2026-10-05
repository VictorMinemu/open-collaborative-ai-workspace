import { rm } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { CellSnapshot } from "./agent-channel-protocol.js";
import type { OpenClawPort } from "./bridge.js";
import { CHANNEL_ID, type MappedMention } from "./mention-mapper.js";
import {
  agentStateDirFor,
  applyPlanToDraft,
  type MutableConfig,
  planReconcile,
  type ReconcilePlan,
} from "./reconciler.js";
import { type ToolGuard, toolGuard } from "./tool-guard.js";

/**
 * OpenClaw tracks async work with AsyncLocalStorage scopes. Our account loop inherits the scope it was
 * started in; when OpenClaw drains that scope (e.g. around a config hot reload) every later turn would
 * run inside a CLOSED scope and fail with "Async work scope is closed". Run each turn from OpenClaw's
 * detached root context instead (the context-free root it initialises for exactly this), falling back
 * to a direct call on hosts that do not expose it.
 */
const DETACHED_KEY = Symbol.for("openclaw.detachedAsyncContext");
export function runDetached<T>(run: () => T): T {
  const detached = (globalThis as Record<symbol, unknown>)[DETACHED_KEY] as
    | { runInAsyncScope?: (fn: () => T) => T }
    | undefined;
  return typeof detached?.runInAsyncScope === "function" ? detached.runInAsyncScope(run) : run();
}

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
  /** Read-only auth profile inspection (subscription sign-in status). */
  modelAuth?: {
    ensureAuthProfileStore(
      agentDir?: string,
      opts?: { readOnly?: boolean; allowKeychainPrompt?: boolean },
    ): { profiles?: Record<string, Record<string, unknown>> } | undefined;
  };
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
  /** Call-time tool gate (defaults to the module singleton the plugin's hooks use). */
  guard?: ToolGuard;
  /** OpenClaw state dir (default: the runtime's, then OPENCLAW_STATE_DIR); removed bots' state is purged there. */
  stateDir?: string;
};

export function threadSessionKey(base: string, threadRootId: string): string {
  return `${base}:thread:${threadRootId.toLowerCase()}`;
}

/**
 * The OpenClaw session of a delivery: one per (bot, thread) in channels; one per (bot, conversation) in a
 * direct conversation (D-04: the base key is already per conversation, so two humans' DMs with the same bot
 * never share a session — OpenClaw's `dmScope: main` would merge them, Pitfall 2).
 */
export function sessionKeyFor(base: string, m: Pick<MappedMention, "threadRootId">): string {
  return m.threadRootId ? threadSessionKey(base, m.threadRootId) : base;
}

export function createOpenClawPort(opts: RealPortOptions): OpenClawPort {
  const { runtime, accountId } = opts;
  const guard = opts.guard ?? toolGuard;
  /**
   * One run at a time per OpenClaw session: the tool gate keys the active turn by session key, so two turns of
   * one session must never overlap (the event stream processes events concurrently).
   */
  const lanes = new Map<string, Promise<void>>();
  function inLane(key: string, run: () => Promise<void>): Promise<void> {
    const previous = lanes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    lanes.set(key, settled);
    void settled.then(() => {
      if (lanes.get(key) === settled) lanes.delete(key);
    });
    return next;
  }

  const port: OpenClawPort = {
    async reconcile(cell: CellSnapshot, reconcileOpts = {}) {
      const current = runtime.config.current() as MutableConfig;
      const searchProvider = current.tools?.web?.search?.provider;
      const loadedPlugins = Array.isArray(current.plugins?.allow) ? (current.plugins.allow as unknown[]) : [];
      const plan = planReconcile(
        {
          agents: current.agents?.entries,
          providers: current.models?.providers,
          ...(typeof searchProvider === "string" ? { webSearchProvider: searchProvider } : {}),
        },
        cell,
        {
          ...reconcileOpts,
          // Only a provider whose plugin this cell loaded can be selected (a missing one stays as rendered).
          searchProviders: new Set(loadedPlugins.filter((p): p is string => typeof p === "string")),
        },
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
      if (removed > 0) await purgeRemovedAgents(plan.removeAgents);
      opts.log?.info?.(
        `reconciled OpenClaw: agents upsert=${Object.keys(plan.upsertAgents).length} remove=${removed}, providers upsert=${Object.keys(plan.upsertProviders).length} remove=${plan.removeProviders.length}${plan.webSearchProvider ? `, web search=${plan.webSearchProvider}` : ""}`,
      );
      return { changed: true, results: plan.results };
    },

    async dispatchMention(m: MappedMention, deliver, signal) {
      const baseSessionKey = runtime.channel.routing.buildAgentSessionKey({
        agentId: m.openClawAgentId,
        channel: CHANNEL_ID,
        accountId,
        peer: { kind: "channel" as const, id: m.conversationId },
        dmScope: "main",
      });
      // One OpenClaw session per (bot, thread) — per (bot, conversation) for a DM: OpenClaw serialises runs
      // per session lane, which gives "one generation per thread / DM" for free.
      const sessionKey = sessionKeyFor(baseSessionKey, m);
      return inLane(sessionKey, () => dispatchOne(m, sessionKey, deliver, signal));
    },
  };

  /**
   * A deleted bot's DM transcripts must not stay in the cell volume (Pitfall 12): a config-only roster removal
   * keeps `<stateDir>/agents/<id>`, so delete it once the removal is written. Only plugin-owned `ocw-*` ids,
   * only inside the state dir (agentStateDirFor); failures are logged, never thrown.
   */
  async function purgeRemovedAgents(ids: readonly string[]): Promise<void> {
    const stateDir =
      opts.stateDir ?? runtime.state?.resolveStateDir?.(process.env) ?? process.env.OPENCLAW_STATE_DIR ?? "";
    for (const id of ids) {
      const dir = agentStateDirFor(stateDir, id);
      if (!dir) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        opts.log?.info?.(`purged OpenClaw state of removed bot ${id}`);
      } catch (error) {
        opts.log?.warn?.(
          `could not purge the state of removed bot ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function dispatchOne(
    m: MappedMention,
    sessionKey: string,
    deliver: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const cfg = runtime.config.current();

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

    const structuredContext = [
      ...(m.chatWindow.length > 0
        ? [
            {
              label: m.historyLabel,
              source: CHANNEL_ID,
              type: "chat_window",
              payload: {
                relation: "before_current_message",
                order: "oldest_first",
                messages: m.chatWindow,
              },
            },
          ]
        : []),
      ...m.contextBlocks,
    ];

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
        ...(m.threadRootId ? { threadId: m.threadRootId } : {}),
        nativeChannelId: m.conversationId,
      },
      route: { agentId: m.openClawAgentId, dmScope: "main", accountId, routeSessionKey: sessionKey },
      reply: {
        to: m.target,
        originatingTo: m.target,
        replyToId: m.messageId,
        ...(m.threadRootId ? { messageThreadId: m.threadRootId, threadParentId: m.threadRootId } : {}),
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
        ...(structuredContext.length > 0 ? { ChannelStructuredContext: structuredContext } : {}),
      },
    });

    // D-08 guard 2: the run may only use `turn.tools ∩ the bot's configured tools`; OpenClaw's
    // `toolsAllow` only ever narrows the configured list. Nothing allowed → tools fully disabled.
    const allowed = m.allowedTools;
    // Ids only (no content): lets operators and the smoke test see which session a turn ran in.
    opts.log?.info?.(`turn ${m.eventId} → session ${sessionKey} (tools: ${allowed.join(",") || "none"})`);
    // D-08 guard 3: the before_tool_call hook resolves this turn by session key.
    guard.beginTurn(
      sessionKey,
      { eventId: m.eventId, agentId: m.ocwAgentId, turn: { ...m.turn, tools: allowed } },
      signal,
    );
    try {
      await runDetached(() =>
        runtime.channel.inbound.dispatch({
          cfg,
          channel: CHANNEL_ID,
          accountId,
          route: { agentId: m.openClawAgentId, dmScope: "main", sessionKey },
          ctxPayload,
          toolsAllow: allowed,
          replyOptions: { disableTools: allowed.length === 0, abortSignal: signal },
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
        }),
      );
    } finally {
      guard.endTurn(sessionKey);
    }
  }

  return port;
}
