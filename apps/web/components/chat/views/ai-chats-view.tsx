"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { PersonalBotButton } from "@/components/bots/personal-bot-button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { isBotDm, useDms } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";
import { useMinuteClock } from "./all-view";
import { ConversationAvatar, ConversationRow } from "./conversation-row";

/**
 * `/chat/ai` (CHAT-02): conversations with an AI counterpart. In Phase 4 those are the bot DMs (personal bot
 * first, then by latest activity, as the sidebar orders them); Phase 5 adds AI chats to the same view.
 */
export function AiChatsView() {
  const dms = useDms();
  const now = useMinuteClock();
  const bots = (dms.data?.dms ?? []).filter(isBotDm);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="ai-chats-view">
      <PageHeader
        title="AI Chats"
        icon={<Sparkles />}
        description="Your private conversations with bots"
        actions={
          bots.length > 0 ? (
            <Button variant="outline" size="sm" render={<Link href="/bots" />}>
              Browse bots
            </Button>
          ) : undefined
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {dms.isPending ? (
          <div className="mx-auto grid w-full max-w-3xl gap-2 p-4 sm:p-6">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : dms.isError ? (
          <EmptyState
            icon={Sparkles}
            title="Couldn't load your AI chats"
            description={errorMessage(dms.error)}
          >
            <Button variant="outline" onClick={() => void dms.refetch()}>
              Try again
            </Button>
          </EmptyState>
        ) : bots.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No AI chats yet"
            description="Message a bot from the Bots page, or create your own personal bot to chat with it privately."
            className="min-h-full"
          >
            <PersonalBotButton variant="row" className="w-auto" />
            <Button variant="outline" render={<Link href="/bots" />}>
              Browse bots
            </Button>
          </EmptyState>
        ) : (
          <div
            className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-px p-2 sm:p-4"
            data-testid="ai-chats-list"
          >
            {bots.map((d) => (
              <ConversationRow
                key={d.id}
                testId="ai-chat-item"
                conversationId={d.id}
                href={`/chat/dm/${d.id}`}
                avatar={<ConversationAvatar item={d} />}
                title={d.counterpart.name}
                meta={
                  <span
                    className={cn(
                      "shrink-0 rounded-[4px] px-1.5 py-px font-medium text-[11px]",
                      d.counterpart.scope === "personal"
                        ? "bg-brand-soft text-brand-soft-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {d.counterpart.scope === "personal" ? "Personal" : "Team"}
                  </span>
                }
                preview={d.lastMessagePreview}
                at={d.lastMessageAt}
                unread={d.latestMessageSeq > d.lastReadSeq}
                now={now}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
