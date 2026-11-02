import {
  type AgentCardField,
  type AgentCardNotice,
  type AutomationRunReason,
  type AutomationRunTrigger,
  scheduleSummary,
} from "@ocw/contracts";
import { agents, automationRuns, conversations, orgMembers, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import type { PlatformCardInput } from "../../lib/chat-agent-bridge";
import { HttpError } from "../../lib/errors";
import { runSentence } from "../agent-channel";
import { createBoardCard, ensureAgentDm } from "../chat";
import { AuthzDeniedError, type PermissionService } from "../organization";
import type { AutomationRow, RunRow } from "./actions";

/**
 * Where a run lands (07.6-09; P-08, R2, UI-SPEC Surface 8a) and what its card says. The run card is the run's anchor: a
 * platform-owned `automation` card posted by the bot for the run-as person under the key `run:<runId>` (so a retried
 * fire answers the same message, Pitfall 6, and 06's reply rule finds the run from it). Channel: a top-level card.
 * Thread: a reply in the chosen thread. DM: a message in the person's DM with the bot (created on the first run), the
 * bot's answer flat after it. Board: a 07.1 board card "{name} · {date}" in the chosen column, authored by the bot for
 * the person, with the run card as its first reply.
 */

/** The names a run card shows. */
export interface RunPeople {
  /** The run-as person's display name. */
  person: string;
  /** The bot's display name. */
  bot: string;
  /** The target conversation's display form (`#sales`), or null for a DM. */
  conversation: string | null;
}

export interface RunCard {
  title: string;
  summary: string;
  fields: AgentCardField[];
  statusLabel: string;
  notices: AgentCardNotice[];
}

const TRIGGER_WORDS: Record<AutomationRunTrigger, string> = {
  schedule: "Scheduled",
  manual: "Run now",
  webhook: "Webhook",
  mail: "Mail",
};

/** A run's trigger as the card and the run history word it. */
export const triggerWord = (t: AutomationRunTrigger): string => TRIGGER_WORDS[t];

/**
 * The run card (UI-SPEC Surface 8a): title = the automation's name; `For` the person, `Trigger` the run's trigger, and
 * `Schedule` (`Fridays at 5:00 PM · Europe/Madrid`) for a scheduled automation or `Source` (`Webhook · {name}`, `Mail ·
 * {name}`) for an inbound one; the summary is the server's sentence (`runSentence`); runs started by outside content
 * carry the amber notice. Every value is plain text the server composed (never model text, never the instructions).
 */
export function runCardFields(a: AutomationRow, run: RunRow, people: RunPeople): RunCard {
  const fields: AgentCardField[] = [
    { label: "For", value: people.person },
    { label: "Trigger", value: triggerWord(run.trigger) },
  ];
  if (a.triggerKind === "schedule" && a.scheduleCron && a.timeZone) {
    fields.push({ label: "Schedule", value: `${scheduleSummary(a.scheduleCron)} · ${a.timeZone}` });
  } else if (a.triggerKind === "webhook" || a.triggerKind === "mail") {
    fields.push({ label: "Source", value: `${triggerWord(a.triggerKind)} · ${a.name}` });
  }
  const outside = run.tainted || run.trigger === "webhook" || run.trigger === "mail";
  return {
    title: a.name,
    summary: runSentence(run.trigger, a.name, people.person),
    fields,
    statusLabel: "Running",
    notices: outside
      ? [
          {
            tone: "warning",
            text: `Started by outside content. ${people.bot} can read it but needs approval to act.`,
          },
        ]
      : [],
  };
}

/** The run reason as a sentence (UI-SPEC § Copy › Run reasons): the run card's notice and the run history line. */
export function reasonSentence(
  reason: AutomationRunReason,
  ctx: { bot: string; conversation: string | null; maxRunsPerDay: number },
): string {
  const where = ctx.conversation ?? "this conversation";
  switch (reason) {
    case "no_reply":
      return `${ctx.bot} didn't answer within 15 minutes.`;
    case "agent_not_member":
      return `${ctx.bot} isn't a member of ${where} any more.`;
    case "target_not_postable":
      return `You can no longer post in ${where}.`;
    case "agent_daily_limit":
      return `${ctx.bot}'s daily limit was reached.`;
    case "runs_per_day":
      return `This automation reached its ${ctx.maxRunsPerDay} runs for today.`;
    case "hourly_cap":
      return "Too many incoming items this hour.";
    case "agent_disabled":
      return `${ctx.bot} is turned off.`;
    case "run_as_not_allowed":
      return "You're no longer allowed to run automations.";
    case "bot_not_readable":
      return `${ctx.bot} isn't available any more.`;
    case "missed":
      return "Missed while the server was down.";
    case "paused":
      return "Paused when it was due.";
    case "delivery_failed":
      return `${ctx.bot} couldn't be reached for this run.`;
    case "nothing_new":
      return "Nothing new.";
    case "summary_skipped_limit":
      return "Sent without the AI summary: your AI chat limit was reached.";
    case "summary_failed":
      return "Sent without the AI summary: it couldn't be written.";
  }
}

/** The names of a run's person, bot and target conversation. */
export async function runPeople(tx: Tx, a: AutomationRow): Promise<RunPeople> {
  const [person] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, a.runAsUserId))
    .limit(1);
  const [bot] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, a.agentId)).limit(1);
  let conversation: string | null = null;
  if (a.conversationId) {
    const [conv] = await tx
      .select({ name: conversations.name })
      .from(conversations)
      .where(eq(conversations.id, a.conversationId))
      .limit(1);
    conversation = conv?.name ? `#${conv.name}` : null;
  }
  return { person: person?.name ?? "Former member", bot: bot?.name ?? "The bot", conversation };
}

/** A board run's card title: `{name} · {date in the automation's zone}` (`Weekly sales report · Oct 9`). */
export function boardCardTitle(a: AutomationRow, at: Date): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: a.timeZone ?? "UTC",
    month: "short",
    day: "numeric",
  }).format(at);
  return `${a.name} · ${date}`.slice(0, 200);
}

export interface RunAnchor {
  /** The run card. */
  anchorMessageId: string;
  conversationId: string;
  /** The thread the bot answers in: the anchor itself (channel, DM), the chosen thread, or the board card. */
  threadRootId: string;
  delivery: "thread" | "dm";
  boardCardMessageId: string | null;
}

export interface AnchorDeps {
  core: Core;
  perms: PermissionService;
}

/**
 * Posts (or, on a retry, finds) the run card where the automation delivers, in the fire transaction, as the bot for the
 * run-as person (chat decides the bot's own `channel.post` and agent ∩ person `channel.read` again). Idempotent per
 * run: the card's key is `run:<runId>` and a board run's card `board:run:<runId>`. Throws chat's refusal when the post
 * is not allowed; the runner records it on the run.
 */
export async function postAnchor(
  tx: Tx,
  deps: AnchorDeps,
  a: AutomationRow,
  run: RunRow,
  card: RunCard,
): Promise<RunAnchor> {
  const { core } = deps;
  const post = (conversationId: string, threadRootId: string | null) =>
    core.chatAgent.postAgentMessageIn(tx, {
      agentId: a.agentId,
      conversationId,
      threadRootId,
      body: card.summary,
      idempotencyKey: `run:${run.id}`,
      onBehalfOfUserId: a.runAsUserId,
      cardPlatformOwned: true,
      card: {
        kind: "automation",
        title: card.title,
        summary: card.summary,
        status: "running",
        statusLabel: card.statusLabel,
        fields: card.fields,
        ...(card.notices.length > 0 ? { notices: card.notices } : {}),
        actions: [
          {
            kind: "open",
            label: "Open automation",
            target: `/bots/automations?edit=${a.id}&run=${run.id}`,
          },
          { kind: "follow", label: "Follow" },
        ],
      } satisfies PlatformCardInput,
    });

  switch (a.targetKind) {
    case "dm": {
      const dm = await ensureAgentDm(
        tx,
        { audit: core.audit, realtime: core.realtime, perms: deps.perms },
        { agentId: a.agentId, userId: a.runAsUserId },
      );
      const posted = await post(dm.conversationId, null);
      return {
        anchorMessageId: posted.messageId,
        conversationId: dm.conversationId,
        threadRootId: posted.messageId,
        delivery: "dm",
        boardCardMessageId: null,
      };
    }
    case "thread": {
      const conversationId = a.conversationId as string;
      const root = a.threadRootMessageId as string;
      const posted = await post(conversationId, root);
      return {
        anchorMessageId: posted.messageId,
        conversationId,
        threadRootId: root,
        delivery: "thread",
        boardCardMessageId: null,
      };
    }
    case "board": {
      const conversationId = a.conversationId as string;
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!conv) throw new Error("board target conversation is gone");
      const author = { kind: "agent" as const, id: a.agentId, onBehalfOfUserId: a.runAsUserId };
      const made = await createBoardCard(
        tx,
        { audit: core.audit, realtime: core.realtime },
        {
          conv,
          author,
          input: {
            title: boardCardTitle(a, run.scheduledFor ? new Date(run.scheduledFor) : new Date()),
            description: "",
            columnId: a.boardColumnId as string,
            // Never `run:` (that namespace is the run card's, which 06's reply rule reads).
            clientMessageId: `board:run:${run.id}`,
          },
          clientKind: "agent",
          perms: deps.perms,
        },
      );
      if (made.created) {
        // Observers (notifications) as for any agent post; an agent never wakes other agents.
        await core.chatEvents.messagePosted(tx, {
          conv: { id: conv.id, kind: "channel", organizationId: conv.organizationId },
          message: made.result.message,
          author: { kind: "agent", id: a.agentId },
          mentions: made.result.row.mentions,
          mentionAll: null,
          threadRootId: null,
        });
      }
      const boardCardMessageId = made.result.row.id;
      await tx.update(automationRuns).set({ boardCardMessageId }).where(eq(automationRuns.id, run.id));
      const posted = await post(conversationId, boardCardMessageId);
      return {
        anchorMessageId: posted.messageId,
        conversationId,
        threadRootId: boardCardMessageId,
        delivery: "thread",
        boardCardMessageId,
      };
    }
    default: {
      const conversationId = a.conversationId as string;
      const posted = await post(conversationId, null);
      return {
        anchorMessageId: posted.messageId,
        conversationId,
        threadRootId: posted.messageId,
        delivery: "thread",
        boardCardMessageId: null,
      };
    }
  }
}

/** A refusal thrown while posting a run or an inbound item, as a run reason (codes only). */
export function refusalReason(err: unknown): AutomationRunReason {
  if (err instanceof AuthzDeniedError) return "target_not_postable";
  if (!(err instanceof HttpError)) return "delivery_failed";
  switch (err.code) {
    case "agent_unavailable":
    case "agent_not_found":
      return "agent_disabled";
    case "bot_not_readable":
      return "bot_not_readable";
    case "member_not_found":
    case "member_deactivated":
      return "run_as_not_allowed";
    case "personal_bot_target":
    case "channel_archived":
    case "invalid_column":
    case "not_a_board":
    case "not_found":
      return "target_not_postable";
    default:
      return "delivery_failed";
  }
}
