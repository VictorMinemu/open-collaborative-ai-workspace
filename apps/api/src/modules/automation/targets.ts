import {
  type AgentCardField,
  type AgentCardNotice,
  type AutomationRunReason,
  type AutomationRunTrigger,
  scheduleSummary,
} from "@ocw/contracts";
import { agents, conversations, orgMembers, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import type { PlatformCardInput } from "../../lib/chat-agent-bridge";
import { runSentence } from "../agent-channel";
import type { PermissionService } from "../organization";
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
    case "dm":
    case "thread":
    case "board":
      throw new Error(`target kind ${a.targetKind} is not delivered yet`);
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
