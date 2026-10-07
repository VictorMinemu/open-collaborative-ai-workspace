"use client";

import type { AiShareMessage, AiShareView as AiShareViewData } from "@ocw/contracts";
import { Camera, Eye, Link2Off, MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Markdown } from "@/components/markdown/markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAiShare } from "@/lib/ai-share-queries";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/utils";

/**
 * A shared AI chat snapshot (05-13, AICHAT-09) as a signed-in colleague reads it: the conversation exactly as it was
 * when the link was made, laid out like the chat screen (the member's turns as right-aligned bubbles, answers full
 * width through the one Markdown renderer) with no composer and no actions. A banner says who shared it, when, and
 * that later messages are not included. A revoked, missing or other-organization link reads as not available.
 */
export function ShareView({ shareId }: { shareId: string }) {
  const share = useAiShare(shareId);

  if (share.notFound) {
    return (
      <Frame title="Shared AI chat">
        <EmptyState
          icon={Link2Off}
          title="This link isn't available"
          description="It may have been revoked, or it was shared in another organization."
        >
          <Link href="/chat/ai" className={buttonVariants({ variant: "outline" })}>
            Go to your AI chats
          </Link>
        </EmptyState>
      </Frame>
    );
  }

  if (share.isPending) {
    return (
      <Frame title={<Skeleton className="h-4 w-40" />}>
        <div className="mx-auto grid w-full max-w-3xl content-start gap-7 px-4 pt-8 sm:px-6">
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-2/5 rounded-[20px]" />
          <div className="grid gap-2">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </Frame>
    );
  }

  if (share.error || !share.data) {
    return (
      <Frame title="Shared AI chat">
        <EmptyState
          icon={MessageCircleQuestion}
          title="Couldn't load this snapshot"
          description={errorMessage(share.error)}
        >
          <Button variant="outline" onClick={() => void share.refetch()}>
            Try again
          </Button>
        </EmptyState>
      </Frame>
    );
  }

  return <Snapshot data={share.data} />;
}

function Snapshot({ data }: { data: AiShareViewData }) {
  return (
    <Frame title={data.title} readOnly>
      <div data-testid="ai-share-view" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-7 px-4 pt-5 pb-12 sm:px-6 sm:pt-7">
          <div
            data-testid="ai-share-banner"
            className="flex items-start gap-3 rounded-2xl border bg-muted/35 px-4 py-3"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground shadow-xs ring-1 ring-border">
              <Camera aria-hidden className="size-3.5" />
            </span>
            <div className="grid min-w-0 gap-0.5">
              <p data-testid="ai-share-byline" className="font-medium text-[13.5px] leading-5">
                Shared by {data.createdBy.displayName} · {formatDate(data.createdAt)}
              </p>
              <p className="text-[12.5px] text-muted-foreground leading-snug">
                Snapshot — later messages are not included
              </p>
            </div>
          </div>
          {data.messages.map((m) => (
            <Turn key={`${m.role}-${m.createdAt}`} message={m} />
          ))}
        </div>
      </div>
    </Frame>
  );
}

function Turn({ message }: { message: AiShareMessage }) {
  if (message.role === "user") {
    return (
      <div
        data-testid="ai-share-message"
        data-role="user"
        className="flex flex-col items-end gap-1.5 pl-10 sm:pl-24"
      >
        {message.body ? (
          <div className="max-w-full whitespace-pre-wrap break-words rounded-[20px] bg-muted px-4 py-2.5 text-[15px] leading-6">
            {message.body}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div data-testid="ai-share-message" data-role="assistant" className="grid min-w-0 gap-1.5">
      <div data-testid="ai-share-message-text" className="min-w-0">
        <Markdown text={message.body} variant="document" className="text-[15px] leading-7" />
      </div>
      {message.modelLabel ? (
        <span className="text-[12px] text-muted-foreground leading-[18px]">{message.modelLabel}</span>
      ) : null}
    </div>
  );
}

/** The page's header (title + a quiet read-only badge) and its content column. */
function Frame({
  title,
  readOnly = false,
  children,
}: {
  title: React.ReactNode;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="ai-share-page">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4 sm:h-14 sm:px-6">
        <h1
          data-testid="ai-share-title"
          className="min-w-0 flex-1 truncate font-medium text-[14px] tracking-tight sm:text-[15px]"
        >
          {title}
        </h1>
        {readOnly ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[11.5px] text-muted-foreground">
            <Eye aria-hidden className="size-3" />
            Read-only
          </span>
        ) : null}
      </header>
      {children}
    </div>
  );
}
