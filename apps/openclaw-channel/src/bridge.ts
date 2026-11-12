import {
  AgentAutomationItemEvent,
  type AgentAutomationItemEvent as AgentAutomationItemEventType,
  AgentAutomationRunEvent,
  type AgentAutomationRunEvent as AgentAutomationRunEventType,
  AgentCardActionEvent,
  type AgentCardActionEvent as AgentCardActionEventType,
  AgentChannelEventTypes,
  AgentConsultReplyEvent,
  type AgentConsultReplyEvent as AgentConsultReplyEventType,
  AgentMentionEvent,
  type AgentMentionEvent as AgentMentionEventType,
  AgentTaskEvent,
  type AgentTaskEvent as AgentTaskEventType,
  AgentWorkSessionEvent,
  type AgentWorkSessionEvent as AgentWorkSessionEventType,
  type CellAgent,
  type CellSnapshot,
  McpProbeEvent,
  PluginInstallEvent,
  PluginUninstallEvent,
  ProviderAuthCancelEvent,
  ProviderAuthRevokeEvent,
  ProviderAuthStartEvent,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { sleep } from "./backoff.js";
import type { DurableFrame, EventStreamLogger } from "./event-stream.js";
import { handleMcpProbe, type probeMcpServer } from "./mcp-probe.js";
import {
  type MappedMention,
  mapAutomationItem,
  mapAutomationRun,
  mapCardAction,
  mapConsultReply,
  mapMention,
  mapTaskEvent,
  mapWorkSessionEvent,
  replyIdempotencyKey,
} from "./mention-mapper.js";
import type { PluginInstaller } from "./plugin-installer.js";
import type { AgentProvisioningResult } from "./reconciler.js";
import type { SubscriptionAuth } from "./subscription-auth.js";
import type { TaskTurnOutcome } from "./tool-guard.js";
import { CONSULT_TOOL_NAME, TASK_CONTINUE_TOOL, TASK_TOOL_NAMES } from "./turn-scoped-tools.js";

/**
 * What a run reports back besides its replies (07.17.1.1.2 PD-17): the outcome of the turn's task calls, read from the
 * gate's active turn when the run ended (null when the turn made none, or the run lost its turn).
 */
export type TurnRun = { task: TaskTurnOutcome | null };

/**
 * Everything the bridge needs from OpenClaw. The real implementation (openclaw-port.ts) wraps the
 * plugin runtime; unit tests use a fake. Keeps all Agent Channel logic testable without OpenClaw.
 */
export type OpenClawPort = {
  /**
   * Runs one agent turn for the mention. `deliver` is called for every visible reply payload, in
   * order. Resolves when the turn is finished, with the turn's task outcome (07.17.1.1.2; an older port resolves
   * with nothing, which reads as no task call).
   */
  dispatchMention(
    mention: MappedMention,
    deliver: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TurnRun | undefined>;
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
  /** MCP tool discovery for `mcp.probe` (tests inject a fake; default: the official SDK client). */
  mcpProbe?: typeof probeMcpServer;
  /** Marketplace executor for `plugin.install.v1` / `plugin.uninstall.v1` (D-14); omitted → those events are ignored. */
  plugins?: PluginInstaller;
};

/**
 * What `runTurn` reads from any delivered turn event (mention, card action, automation run, consult reply, work session
 * wake-up, automation item, task turn).
 */
type ChainFacts = {
  eventId: string;
  agent: { id: string };
  type?: string;
  origin?: unknown;
  turn?: { tools: readonly string[] } | undefined;
};

/** The turn-like events: a chain turn among them that the bridge skips still reports done (CR-C-03). */
const TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  AgentChannelEventTypes.mention,
  AgentChannelEventTypes.cardAction,
  AgentChannelEventTypes.automationRun,
  AgentChannelEventTypes.consultReply,
  AgentChannelEventTypes.workSession,
  AgentChannelEventTypes.automationItem,
  AgentChannelEventTypes.task,
]);
const TASK_TOOLS: ReadonlySet<string> = new Set(TASK_TOOL_NAMES);

const readableId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/**
 * CR-C-03: the chain facts of a turn-like frame that failed to parse, read from its raw fields only (no value is
 * logged): its event and bot ids, its type, whether it carries an `origin`, and the tools its turn lists. Null when
 * either id is unreadable.
 */
function rawChainFacts(type: string, data: unknown): ChainFacts | null {
  if (!TURN_EVENT_TYPES.has(type) || !data || typeof data !== "object") return null;
  const raw = data as {
    eventId?: unknown;
    agent?: { id?: unknown } | null;
    origin?: unknown;
    turn?: unknown;
  };
  const agentId = raw.agent && typeof raw.agent === "object" ? raw.agent.id : undefined;
  if (!readableId(raw.eventId) || !readableId(agentId)) return null;
  const tools = (raw.turn as { tools?: unknown } | null | undefined)?.tools;
  return {
    eventId: raw.eventId,
    agent: { id: agentId },
    type,
    ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
    turn: {
      tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [],
    },
  };
}

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
  /** The one refresh queued behind the flight (see `refreshCell`). */
  let queued: Promise<CellSnapshot> | null = null;
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
      `cell synced: ${cell.agents.length} bot(s), ${cell.providers.length} provider(s), ${cell.mcpServers?.length ?? 0} MCP server(s)${changed ? ", OpenClaw updated" : ""}`,
    );
    await reportStatuses(results);
    // The boot render's fallback list of installed marketplace plugins follows the API's view (never trusted for installs).
    await opts.plugins?.writeBootCache().catch((error: unknown) => {
      log.warn?.(
        `plugin boot cache not written (${error instanceof Error ? error.message.slice(0, 80) : "error"})`,
      );
    });
    return cell;
  }

  /**
   * Coalesces concurrent refreshes (startup + cell.config.changed + unknown-agent lookups) without losing a change: a
   * caller during a flight gets a refresh that starts after it, because the flight's `GET /cell` may predate the change
   * the caller was told about (07.8-08: a bot created during another bot's refresh stayed `provisioning`). Every caller
   * during one flight shares that single follow-up.
   */
  function refreshCell(): Promise<CellSnapshot> {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }
    queued ??= refreshing
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return refreshCell();
      });
    return queued;
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
    await runTurn(event, "mention", (agent) => mapMention(event, agent));
  }

  /** A decision on one of the agent's cards (06-14, P-11): a turn exactly like a mention of the agent on its card. */
  async function handleCardAction(event: AgentCardActionEventType): Promise<void> {
    await runTurn(event, "card action", (agent) => mapCardAction(event, agent));
  }

  /**
   * An automation run (07.6 D-03): a turn like a mention of the agent on the run's anchor; the reply carries the anchor
   * as `inReplyToMessageId` and the run's event id (the API's trigger rule, D-08), keyed `evt:<eventId>` like any reply.
   */
  async function handleAutomationRun(event: AgentAutomationRunEventType): Promise<void> {
    await runTurn(event, "automation run", (agent) => mapAutomationRun(event, agent));
  }

  /**
   * A consulted bot answered, failed or timed out (07.7 D-01, D-04): a turn like a mention of the asking bot in the
   * hop's thread, in reply to the event's message (the answer, or the question again), keyed `evt:<eventId>`; it then
   * reports done like any chain turn.
   */
  async function handleConsultReply(event: AgentConsultReplyEventType): Promise<void> {
    await runTurn(event, "consult reply", (agent) => mapConsultReply(event, agent));
  }

  /**
   * A session this bot started finished a turn, waits for an approval, failed, ended or lost its device (07.16 D-09,
   * PD-16): a turn like a mention of the bot on the session's card, in the card's thread, in reply to the card message,
   * keyed `evt:<eventId>`, with the update in its own block. The bot reads more with `ocw_work_session_read`; it never
   * polls.
   */
  async function handleWorkSession(event: AgentWorkSessionEventType): Promise<void> {
    await runTurn(event, "work session update", (agent) => mapWorkSessionEvent(event, agent));
  }

  /**
   * A fan-out run opened a conversation for one new item (07.17 D-04, PD-09): a tainted turn like a mention of the bot
   * on the opened root, in the root's thread, in reply to the root, keyed `evt:<eventId>`, with the item as outside
   * content in its own block.
   */
  async function handleAutomationItem(event: AgentAutomationItemEventType): Promise<void> {
    await runTurn(event, "automation item", (agent) => mapAutomationItem(event, agent));
  }

  /**
   * The next turn of the bot's own task (07.17.1.1.2 D-02, PD-16): a turn like a mention of the bot on its task card,
   * in the card's thread, in reply to the card message, keyed `evt:<eventId>`, with the task in the "Your task" block. A
   * quiet continuation posts nothing; a silent one that continued or finished is not a failure (runTurn).
   */
  async function handleTask(event: AgentTaskEventType): Promise<void> {
    await runTurn(event, "task turn", (agent) => mapTaskEvent(event, agent));
  }

  /**
   * Which turns report `POST /turns/:eventId/done` (every other turn sends nothing, as before). Read from the event
   * itself (the mapping's `turn` is the event's), so a turn the bridge skips before mapping is judged the same way
   * (CR-C-03):
   *   - 07.7 (D-04, P-09): a turn that can belong to a consult chain: it was offered `ocw_consult_agent` (it may open a
   *     hop), it answers a question (`origin`), or it is a consult reply;
   *   - 07.17.1.1.2 (PD-06, PD-17): a turn offered a task tool (it may start, continue or finish the bot's task) and
   *     every `agent.task.v1`: the API delivers the task's next turn only after this one reported done.
   */
  function reportsDone(event: ChainFacts): boolean {
    const tools = event.turn?.tools ?? [];
    return (
      tools.includes(CONSULT_TOOL_NAME) ||
      event.origin !== undefined ||
      event.type === AgentChannelEventTypes.consultReply ||
      tools.some((t) => TASK_TOOLS.has(t)) ||
      event.type === AgentChannelEventTypes.task
    );
  }

  /** Best effort: the turn never fails or retries on it (the `consult.tick` timeout is the backstop). */
  async function reportDone(event: ChainFacts, agentId: string, label: string, replied: boolean) {
    try {
      await opts.client.turnDone(
        event.eventId,
        { agentId, outcome: replied ? "replied" : "failed" },
        opts.signal,
      );
    } catch (error) {
      // The status only: an error body never reaches the logs.
      const status = error instanceof AgentChannelHttpError ? String(error.status) : "unreachable";
      log.warn?.(`${label} ${event.eventId}: turn done not reported (${status})`);
    }
  }

  /**
   * CR-C-03: a chain turn the bridge skips (its bot is unknown or disabled, its payload invalid) still reports `failed`,
   * so the API closes the hop (or the chain) now instead of at the consult timeout. Never while stopping: the successor
   * replays the event and decides.
   */
  async function reportSkipped(event: ChainFacts, label: string): Promise<void> {
    if (opts.signal.aborted || !reportsDone(event)) return;
    await reportDone(event, event.agent.id, label, false);
  }

  /** An invalid turn-like frame: skipped (the caller logged it), reported failed when it may be a chain turn. */
  async function skipInvalid(frame: DurableFrame): Promise<void> {
    const facts = rawChainFacts(frame.type, frame.data);
    if (facts) await reportSkipped(facts, `seq=${frame.seq}: ${frame.type}`);
  }

  async function runTurn(
    event: ChainFacts,
    label: string,
    map: (agent: CellAgent) => MappedMention,
  ): Promise<void> {
    let agent = agents.get(event.agent.id);
    if (!agent) {
      await refreshCell();
      agent = agents.get(event.agent.id);
    }
    if (!agent) {
      log.warn?.(`${label} ${event.eventId} for unknown agent ${event.agent.id}; skipped`);
      await reportSkipped(event, label);
      return;
    }
    if (agent.status === "disabled") {
      log.info?.(`${label} ${event.eventId} for disabled agent ${agent.id}; skipped`);
      await reportSkipped(event, label);
      return;
    }
    const mention = map(agent);
    const doneTurn = reportsDone(event);
    // 07.17.1.1.2 (PD-10, PD-17): a turn of the bot's own task (it carries the task and may continue it) holds its text
    // until the run ends, so a continue answered `quiet: true` drops it; every other turn posts as it is delivered.
    const holdsText = mention.turn.task !== undefined && mention.allowedTools.includes(TASK_CONTINUE_TOOL);
    // The turn continued or finished its task: silence is its answer, never a failure to retry (T-07.17.1.1.2-05-03).
    let taskAnswered = false;
    let index = 0;
    const post = async (text: string) => {
      for (const chunk of chunkText(text, maxReplyChars)) {
        await opts.client.postMessage(
          {
            agentId: mention.ocwAgentId,
            conversationId: mention.conversationId,
            threadRootMessageId: mention.threadRootId,
            inReplyToMessageId: mention.messageId,
            eventId: event.eventId,
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
          const held: string[] = [];
          const run = await opts.port.dispatchMention(
            mention,
            async (text) => {
              if (isOpenClawAuthFailure(text)) {
                throw new TerminalTurnError(
                  "the model provider rejected the credentials",
                  AUTH_FAILURE_REPLY,
                );
              }
              if (isOpenClawGenericFailure(text)) throw new Error("OpenClaw reported a failed turn");
              if (!text.trim()) return;
              if (holdsText) held.push(text);
              else await post(text);
            },
            opts.signal,
          );
          const task = run?.task ?? null;
          if (task?.quiet) {
            // Ids and counts only: the dropped text never reaches the logs.
            if (held.length > 0) {
              log.info?.(
                `${label} ${event.eventId}: quiet task turn, ${held.length} reply part(s) not posted`,
              );
            }
          } else {
            for (const text of held) await post(text);
          }
          taskAnswered = task !== null && (task.continued || task.finished);
          // OpenClaw can end a turn without delivering anything and without throwing (e.g. "Embedded
          // agent failed before reply"): treat silence as a failed attempt so it is retried and, if it
          // keeps failing, the asker gets a visible notice instead of nothing. A turn that continued or
          // finished its task (07.17.1.1.2 D-14) may end silently: the task card shows it.
          if (index === 0 && !taskAnswered) throw new Error("the agent produced no visible reply");
          break;
        } catch (error) {
          if (index > 0 || opts.signal.aborted || attempt >= dispatchAttempts) throw error;
          if (error instanceof TerminalTurnError) throw error;
          log.warn?.(
            `${label} ${event.eventId}: turn attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying`,
          );
          await sleep(retryDelayMs * attempt, opts.signal);
        }
      }
    } catch (error) {
      if (opts.signal.aborted) throw error; // stopping: leave the event for the successor to replay
      log.error?.(
        `${label} ${event.eventId}: turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (index === 0) {
        await opts.client
          .postMessage(
            {
              agentId: mention.ocwAgentId,
              conversationId: mention.conversationId,
              threadRootMessageId: mention.threadRootId,
              inReplyToMessageId: mention.messageId,
              eventId: event.eventId,
              text: error instanceof TerminalTurnError ? error.reply : FAILURE_REPLY,
              idempotencyKey: `evt:${event.eventId}:failed`,
            },
            opts.signal,
          )
          .catch(() => undefined);
      }
    } finally {
      // 07.7 (D-04): a dispatched chain turn tells the API it ended, after its last post (stopping: nothing is sent,
      // the successor replays the event and reports it). 07.17.1.1.2 (PD-17): so does every task turn; one that
      // continued or finished its task replied, even when it posted nothing.
      if (doneTurn && !opts.signal.aborted) {
        await reportDone(event, mention.ocwAgentId, label, index > 0 || taskAnswered);
      }
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
          await skipInvalid(frame);
          return;
        }
        await handleMention(parsed.data);
        return;
      }
      case AgentChannelEventTypes.cardAction: {
        // Untrusted until parsed; the warning names the seq and the field path only (never values such as titles).
        const parsed = AgentCardActionEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleCardAction(parsed.data);
        return;
      }
      case AgentChannelEventTypes.automationRun: {
        // agent.automation_run.v1 (07.6): untrusted until parsed; the warning names the seq and the field path only
        // (never outside content).
        const parsed = AgentAutomationRunEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleAutomationRun(parsed.data);
        return;
      }
      case AgentChannelEventTypes.consultReply: {
        // agent.consult_reply.v1 (07.7): untrusted until parsed; the warning names the seq and the field path only
        // (never the answer or a name).
        const parsed = AgentConsultReplyEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleConsultReply(parsed.data);
        return;
      }
      case AgentChannelEventTypes.workSession: {
        // agent.work_session.v1 (07.16): untrusted until parsed; the warning names the seq and the field path only
        // (never the summary, a name or a handle).
        const parsed = AgentWorkSessionEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleWorkSession(parsed.data);
        return;
      }
      case AgentChannelEventTypes.automationItem: {
        // agent.automation_item.v1 (07.17): untrusted until parsed; the warning names the seq and the field path only
        // (never the item, a name or a handle).
        const parsed = AgentAutomationItemEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleAutomationItem(parsed.data);
        return;
      }
      case AgentChannelEventTypes.task: {
        // agent.task.v1 (07.17.1.1.2): untrusted until parsed; the warning names the seq and the field path only
        // (never a goal, a note or a name). An older plugin never reaches here: it skips the unknown type (E25).
        const parsed = AgentTaskEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(
            `seq=${frame.seq}: invalid ${frame.type} payload; skipped (${parsed.error.issues[0]?.path.join(".") || "?"})`,
          );
          await skipInvalid(frame);
          return;
        }
        await handleTask(parsed.data);
        return;
      }
      case AgentChannelEventTypes.configChanged:
        await refreshCell();
        return;
      case AgentChannelEventTypes.mcpProbe: {
        const parsed = McpProbeEvent.safeParse(frame.data);
        if (!parsed.success) {
          log.warn?.(`seq=${frame.seq}: invalid ${frame.type} payload; skipped`);
          return;
        }
        // A failed report is logged, never retried forever: the admin can ask for a new probe.
        await handleMcpProbe(parsed.data, {
          client: opts.client,
          snapshot: () => lastSnapshot,
          refresh: refreshCell,
          signal: opts.signal,
          log,
          ...(opts.mcpProbe ? { probe: opts.mcpProbe } : {}),
        }).catch((error: unknown) => {
          if (opts.signal.aborted) throw error;
          log.warn?.(
            `mcp probe ${parsed.data.probeId}: report failed (${error instanceof Error ? error.message.slice(0, 120) : "error"})`,
          );
        });
        return;
      }
      case AgentChannelEventTypes.pluginInstall:
      case AgentChannelEventTypes.pluginUninstall: {
        const installer = opts.plugins;
        if (!installer) {
          log.info?.(`seq=${frame.seq}: ${frame.type} ignored (marketplace executor not available)`);
          return;
        }
        if (frame.type === AgentChannelEventTypes.pluginInstall) {
          const parsed = PluginInstallEvent.safeParse(frame.data);
          if (!parsed.success) {
            log.warn?.(`seq=${frame.seq}: invalid ${frame.type} payload; skipped`);
            return;
          }
          // Awaited (one at a time inside the installer): the cursor commits only after the outcome was reported.
          await installer.onInstall(parsed.data, opts.signal);
        } else {
          const parsed = PluginUninstallEvent.safeParse(frame.data);
          if (!parsed.success) {
            log.warn?.(`seq=${frame.seq}: invalid ${frame.type} payload; skipped`);
            return;
          }
          await installer.onUninstall(parsed.data, opts.signal);
        }
        return;
      }
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

  return {
    refreshCell,
    handleFrame,
    handleMention,
    handleCardAction,
    handleAutomationRun,
    handleConsultReply,
    handleWorkSession,
    handleTask,
    agents,
    snapshot: () => lastSnapshot,
  };
}
