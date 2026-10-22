"use client";

import type { Message } from "@ocw/contracts";
import type { ReactNode } from "react";
import { BotActivity, stepViewerOf } from "@/components/browser/bot-activity";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";

const stampFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullFmt = new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short" });

/**
 * A message shown outside its conversation (pinned sheet, Saved): author, time, the body through the shared
 * renderer (long bodies clipped), an optional context line above and actions below.
 */
export function MessageCard({
  message,
  context,
  actions,
  className,
  testId,
}: {
  message: Message;
  /** A line above the author (e.g. "#general" or "Pinned by Sam"). */
  context?: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const author = message.author ?? {
    kind: message.authorKind,
    id: message.authorId,
    displayName: "Unknown",
    avatarUrl: null,
  };
  return (
    <article
      data-testid={testId}
      data-message-id={message.id}
      className={cn("rounded-xl border bg-card px-3.5 py-3 shadow-xs", className)}
    >
      {context ? <div className="mb-2 truncate text-muted-foreground text-xs">{context}</div> : null}
      <div className="flex gap-2.5">
        <PrincipalAvatar
          kind={author.kind}
          name={author.displayName}
          avatarUrl={author.avatarUrl}
          seed={author.id}
          className="mt-0.5 size-8"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-semibold text-sm">{author.displayName}</span>
            {author.kind === "agent" ? <BotBadge className="relative -top-px self-center" /> : null}
            <Tooltip content={fullFmt.format(new Date(message.createdAt))}>
              <time
                dateTime={message.createdAt}
                className="shrink-0 text-muted-foreground text-xs tabular-nums"
              >
                {stampFmt.format(new Date(message.createdAt))}
              </time>
            </Tooltip>
          </div>
          {/* 07.8-20 (R2): a bot reply keeps its sandbox and browser activity here too, collapsed. */}
          {message.activity ? (
            <BotActivity activity={message.activity} viewer={stepViewerOf(message.activity, null)} />
          ) : null}
          {/* Long messages are clipped; "Jump" opens them whole in their conversation. */}
          <div className="max-h-44 overflow-hidden text-[14px]">
            <Markdown body={message.body} />
          </div>
        </div>
      </div>
      {actions ? (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
      ) : null}
    </article>
  );
}
