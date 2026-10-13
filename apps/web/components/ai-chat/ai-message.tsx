"use client";

import type {
  AiAddressing,
  AiGeneration,
  Message,
  ModelUnavailableReason,
  SendAiMessageResponse,
} from "@ocw/contracts";
import { AtSign, Check, CircleAlert, Clock3, Copy, Globe, Square, Unplug } from "lucide-react";
import { createContext, Fragment, type ReactNode, useContext, useState } from "react";
import { AgentCardView } from "@/components/chat/agent-card";
import { MessageAttachments } from "@/components/chat/attachments/attachment-grid";
import { Lightbox } from "@/components/chat/attachments/lightbox";
import { BotBadge, PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Markdown } from "@/components/markdown/markdown";
import { safeUrl } from "@/components/markdown/safe-url";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { footerParts, formatUsage, payerLabel, usageTitle } from "@/lib/ai-format";
import { sourceLinks } from "@/lib/ai-tools";
import { cn } from "@/lib/utils";
import { GenerationError, markStreamed } from "./generation-error";
import { reasonText } from "./model-picker";
import { RegenerateMenu } from "./regenerate-menu";

/**
 * Who is reading and whether the chat is shared (06-03, MULTI-01). In a shared chat every human turn shows its
 * author's avatar and name; other people's turns sit on the left, the reader's own stay on the right. A private chat
 * (Phase 5) renders exactly as before.
 */
export interface AiChatPeople {
  viewerId: string | null;
  shared: boolean;
  /**
   * The chat takes turns among several people (06-11: shared, or the server keeps a queue for it): answers say whose
   * request they answered and who paid; human turns show where their request to the AI stands.
   */
  multiplayer?: boolean;
  /** Display names by user id (the chat's authors and participants). */
  nameOf?: (userId: string) => string | null;
}

export const AiChatPeopleContext = createContext<AiChatPeople>({ viewerId: null, shared: false });

/** Regenerate on the chat's last answer only (05-06). */
export interface AnswerRegenerate {
  chatId: string;
  /** Something is being written in the chat (one generation per chat). */
  disabled: boolean;
  onRegenerated: (response: SendAiMessageResponse) => void;
}

/**
 * One turn of an AI chat (P-09): the member's turns are right-aligned bubbles; answers are full width through the
 * one shared Markdown renderer (no raw HTML, images as links, `safeUrl`), with a caret while they stream and a
 * quiet footer once done: tokens, cost on organization keys, model and who pays (`1.2k in · 340 out · ~$0.004 ·
 * Claude Sonnet 5.5 · METERED`, `… · GPT-6 Astra · ChatGPT plan`), exact counts in its tooltip (05-08). A failed
 * answer keeps any partial text and ends with a calm card instead of a spinner. A stopped or interrupted answer keeps its text and says so in the
 * line under it ("Stopped" / "Interrupted"), quietly: it was cut short, not broken (05-06). An answer that used the
 * web lists its sources as domain chips under the text (05-11): no favicons (no third-party request), `safeUrl`
 * links that open in a new tab without a referrer.
 */
export function AiMessage({
  message,
  text,
  regenerate,
  live = true,
  last = true,
}: {
  message: Message;
  text: string;
  regenerate?: AnswerRegenerate | undefined;
  /** The chat's latest answer keeps its actions in view; earlier ones show them on hover or focus (pointer only). */
  last?: boolean;
  /** A streaming render counts as live (false for a replay ahead of the page's first snapshot). */
  live?: boolean;
}) {
  if (message.authorKind === "system") return <NoticeRow message={message} text={text} />;
  if (message.authorKind !== "agent") return <UserTurn message={message} text={text} />;
  // An agent persona of the chat (06-10) speaks as itself, like a Phase 4 bot message, never with the model footer.
  if (message.authorId !== null && !message.generation) return <PersonaTurn message={message} text={text} />;

  const streaming = message.status === "streaming";
  // A failure that follows a stream seen on this page arrived live (05-07: the usage-limit dialog opens once).
  if (streaming && live) markStreamed(message.id);
  return (
    <div
      data-testid="ai-message"
      data-role="assistant"
      data-status={message.status}
      data-message-id={message.id}
      aria-busy={streaming}
      className="group/answer grid min-w-0 gap-1.5"
    >
      <div data-testid="ai-message-text" className={text ? "min-w-0" : "hidden"}>
        {text ? (
          <Markdown text={text} variant="document" streaming={streaming} className="text-[15px] leading-7" />
        ) : null}
      </div>
      {streaming ? null : <Sources text={text} generation={message.generation} />}
      {streaming ? null : <CutShortLabel generation={message.generation} />}
      {message.status === "failed" ? (
        <GenerationError
          messageId={message.id}
          chatKey={message.conversationId}
          code={message.generation?.errorCode ?? null}
          param={message.generation?.errorParam ?? null}
        />
      ) : null}
      {streaming ? (
        <span
          data-testid="ai-streaming-caret"
          aria-hidden
          className="block size-2.5 animate-pulse rounded-full bg-foreground/70 motion-reduce:animate-none"
        />
      ) : (
        <AnswerFooter
          text={text}
          generation={message.generation}
          reveal={!last}
          actions={
            regenerate ? (
              <RegenerateMenu
                chatId={regenerate.chatId}
                message={message}
                disabled={regenerate.disabled}
                onRegenerated={regenerate.onRegenerated}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}

/**
 * A notice of the platform (06-05: an access change, someone joined): a quiet centered line, no bubble, no actions.
 */
function NoticeRow({ message, text }: { message: Message; text: string }) {
  return (
    <div
      data-testid="ai-notice"
      data-role="notice"
      data-message-id={message.id}
      className="-my-3 flex justify-center px-4"
    >
      <p className="max-w-md text-balance text-center text-[12.5px] text-muted-foreground leading-5">
        {text}
      </p>
    </div>
  );
}

/** An agent persona's message (06-10, 06-11): avatar, name and Bot badge, the text through the shared renderer. */
function PersonaTurn({ message, text }: { message: Message; text: string }) {
  const name = message.author?.displayName ?? "Agent";
  return (
    <div
      data-testid="ai-message"
      data-role="persona"
      data-status={message.status}
      data-message-id={message.id}
      data-author-id={message.authorId ?? undefined}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 pr-6 sm:pr-16"
    >
      <span className="pt-0.5">
        <PrincipalAvatar
          kind="agent"
          name={name}
          avatarUrl={message.author?.avatarUrl}
          seed={message.authorId}
          className="size-8 text-[12px]"
        />
      </span>
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span data-testid="ai-message-author" className="truncate font-semibold text-[13.5px]">
            {name}
          </span>
          <BotBadge />
        </div>
        {message.card ? (
          // An Agent Card (06-15): the same renderer as in channels, threads and DMs; the body is its summary.
          <AgentCardView
            messageId={message.id}
            card={message.card}
            summary={message.body}
            authorName={name}
          />
        ) : text ? (
          <Markdown text={text} variant="chat" className="min-w-0 break-words" />
        ) : null}
      </div>
    </div>
  );
}

/** A skip reason in words (the Phase 5 model-unavailable copy, plus the caps a queued request can meet). */
const SKIP_EXTRA: Record<string, string> = {
  daily_limit_reached: "Daily limit reached",
  usage_unavailable: "ChatGPT usage is unavailable right now",
  concurrent_generations: "Too many answers running",
};

function skipText(reason: AiAddressing["skipReason"]): string {
  if (!reason) return "AI couldn't answer";
  const words = SKIP_EXTRA[reason] ?? reasonText(reason as ModelUnavailableReason);
  return `AI couldn't answer: ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/**
 * Where a human turn's request to the AI stands in a multiplayer chat (06-11, D-05), quietly under the turn: Queued,
 * AI is answering, Not sent to AI, or why the AI couldn't answer. An answered request needs no line (its answer and
 * footer say it). The server decides every state; nothing here is guessed.
 */
function AddressingLine({ addressing }: { addressing: AiAddressing }) {
  const state =
    addressing.status === "queued"
      ? { icon: Clock3, text: "Queued", tone: "" }
      : addressing.status === "answering"
        ? { icon: null, text: "AI is answering", tone: "text-foreground/70" }
        : addressing.status === "not_addressed"
          ? { icon: AtSign, text: "Not sent to AI", tone: "" }
          : addressing.status === "skipped"
            ? {
                icon: CircleAlert,
                text: skipText(addressing.skipReason),
                tone: "text-amber-700 dark:text-amber-300",
              }
            : null;
  if (!state) return null;
  const Icon = state.icon;
  return (
    <span
      data-testid="ai-addressing"
      data-addressing={addressing.status}
      className={cn(
        "inline-flex max-w-full items-center gap-1 px-1 text-[11.5px] text-muted-foreground",
        state.tone,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="size-3 shrink-0" />
      ) : (
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      )}
      <span className="truncate">{state.text}</span>
    </span>
  );
}

/**
 * The member's turn: its files (05-12) right-aligned above the bubble, as in chat — image previews (the API's webp
 * renditions, opening the lightbox) and file cards — then the text, when there is any. In a shared chat (06-03) the
 * author's avatar and name sit above the turn, and other people's turns align left.
 */
function UserTurn({ message, text }: { message: Message; text: string }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const people = useContext(AiChatPeopleContext);
  const files = message.attachments ?? [];
  const images = files.filter((a) => a.isImage && a.previewUrl);
  const mine = people.viewerId === null || message.authorId === people.viewerId;
  const attributed = people.shared || !mine;
  const name = message.author?.displayName ?? "Former member";
  return (
    <div
      data-testid="ai-message"
      data-role="user"
      data-status={message.status}
      data-message-id={message.id}
      data-author-id={message.authorId ?? undefined}
      className={cn(
        "flex flex-col gap-1.5",
        mine ? "items-end pl-10 sm:pl-24" : "items-start pr-10 sm:pr-24",
      )}
    >
      {attributed ? (
        <div className={cn("flex min-w-0 max-w-full items-center gap-2", mine && "flex-row-reverse")}>
          <span data-testid="ai-message-avatar" className="inline-flex shrink-0">
            <PrincipalAvatar
              kind="user"
              name={name}
              avatarUrl={message.author?.avatarUrl}
              seed={message.authorId}
              compact
              className="size-5 text-[10px]"
            />
          </span>
          <span
            data-testid="ai-message-author"
            className="truncate font-medium text-[12.5px] text-foreground/80"
          >
            {name}
          </span>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={cn("flex w-full", mine ? "justify-end" : "justify-start")}>
          {/* Shrinks to the column on phones so a wide preview never overflows the turn. */}
          <div className={cn("min-w-0 max-w-full [&>div]:mt-0", mine && "[&>div]:items-end")}>
            <MessageAttachments attachments={files} onOpenImage={setLightbox} />
          </div>
        </div>
      ) : null}
      {text ? (
        <div className="max-w-full whitespace-pre-wrap break-words rounded-[20px] bg-muted px-4 py-2.5 text-[15px] leading-6">
          {text}
        </div>
      ) : null}
      {people.multiplayer && message.aiAddressing ? (
        <AddressingLine addressing={message.aiAddressing} />
      ) : null}
      {lightbox !== null ? (
        <Lightbox images={images} index={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

/** The domains an answer drew on (web search), each linking to the page it cited. */
function Sources({ text, generation }: { text: string; generation: AiGeneration | undefined }) {
  const domains = generation?.sourceDomains ?? [];
  if (domains.length === 0) return null;
  return (
    <div data-testid="ai-sources" className="flex flex-wrap items-center gap-1.5 pt-0.5">
      <span className="mr-0.5 inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <Globe aria-hidden className="size-3.5" />
        Sources
      </span>
      {sourceLinks(text, domains).map((s) => {
        const href = safeUrl(s.href);
        return (
          <a
            key={s.domain}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-testid="ai-source-chip"
            title={href}
            className="inline-flex h-6 max-w-[14rem] items-center truncate rounded-full border bg-background px-2.5 text-[12px] text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            {s.domain}
          </a>
        );
      })}
    </div>
  );
}

const CUT_SHORT: Partial<
  Record<AiGeneration["status"], { label: string; hint: string; icon: typeof Square }>
> = {
  stopped: { label: "Stopped", hint: "You stopped this answer", icon: Square },
  interrupted: {
    label: "Interrupted",
    hint: "The server restarted while writing this answer",
    icon: Unplug,
  },
};

/** "Stopped" / "Interrupted" right under an answer that was cut short (its text is kept), above the footer. */
function CutShortLabel({ generation }: { generation: AiGeneration | undefined }) {
  const state = generation ? CUT_SHORT[generation.status] : undefined;
  if (!state) return null;
  const Icon = state.icon;
  return (
    <span
      title={state.hint}
      className="inline-flex w-fit items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11.5px] text-foreground/70"
    >
      <Icon aria-hidden className={cn(Icon === Square ? "size-2.5 fill-current" : "size-3")} />
      <span data-testid="ai-generation-state">{state.label}</span>
    </span>
  );
}

function AnswerFooter({
  text,
  generation,
  actions,
  reveal,
}: {
  text: string;
  generation: AiGeneration | undefined;
  actions: ReactNode;
  /** Actions appear on hover or focus of the answer (mouse and trackpad only; always shown on touch). */
  reveal: boolean;
}) {
  const { copy, copied } = useCopy();
  const people = useContext(AiChatPeopleContext);
  // Multiplayer chats say whose request this answered and who paid (06-11, D-01); solo chats keep the Phase 5 footer.
  const requester = generation?.requesterUserId;
  const payer =
    generation && people.multiplayer && requester
      ? payerLabel(generation, people.nameOf?.(requester) ?? "a former member", people.viewerId)
      : null;
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground",
        // The copy button's padding sits outside the text column, so the label lines up with the answer.
        (text || actions) && "-ml-1.5",
      )}
    >
      <span
        className="ai-answer-actions flex shrink-0 items-center gap-1.5"
        data-reveal={reveal || undefined}
      >
        {text ? (
          <Tooltip content={copied ? "Copied" : "Copy answer"}>
            <button
              type="button"
              data-testid="ai-copy-answer"
              aria-label="Copy answer"
              onClick={() => void copy(text)}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
          </Tooltip>
        ) : null}
        {actions}
      </span>
      {generation ? (
        <span
          data-testid="ai-message-footer"
          data-usage={formatUsage(generation) || undefined}
          title={usageTitle(generation)}
          className="min-w-0 py-1 leading-[18px] tabular-nums"
        >
          {/* Each part stays whole: on a phone the line wraps between parts, never inside one. */}
          {footerParts(generation, payer).map((part, i) => (
            <Fragment key={part}>
              {i > 0 ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </div>
  );
}
