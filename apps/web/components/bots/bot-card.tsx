"use client";

import type { Agent } from "@ocw/contracts";
import { Hash, MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useOpenDm } from "@/lib/bots-queries";
import { cn } from "@/lib/utils";
import { BotAvatar, ModelChip, StatusChip } from "./bot-bits";

/** A private chat is offered for live bots the caller may use (`bot.read`, decided per bot by the API). */
export function canMessage(agent: Agent): boolean {
  return (
    (agent.status === "ready" || agent.status === "provisioning") &&
    (agent.viewerCan?.includes("bot.read") ?? false)
  );
}

/** Opens (or creates) the caller's private chat with `agent` and navigates to it (SC2). */
export function MessageBotButton({ agent, className }: { agent: Agent; className?: string }) {
  const router = useRouter();
  const open = useOpenDm();
  return (
    <Button
      size="sm"
      data-testid="bot-message"
      disabled={open.isPending}
      onClick={() =>
        open.mutate(agent.id, {
          onSuccess: (res) => router.push(`/chat/dm/${res.dmId}`),
          onError: (err) => toast.error("Could not open the chat", { description: errorMessage(err) }),
        })
      }
      className={cn("relative z-10", className)}
    >
      {open.isPending ? <Spinner /> : <MessageSquare />}
      Message
    </Button>
  );
}

export function BotCard({
  agent,
  highlight,
  onOpen,
  onAddToChannel,
}: {
  agent: Agent;
  highlight?: boolean;
  onOpen: () => void;
  onAddToChannel: () => void;
}) {
  return (
    <article
      data-testid="bot-card"
      data-username={agent.username}
      className={cn(
        "group relative flex flex-col rounded-2xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow]",
        "hover:border-foreground/15 hover:shadow-md",
        agent.status === "disabled" && "opacity-70",
        highlight && "border-primary/50 ring-4 ring-primary/10",
      )}
    >
      <div className="flex items-start gap-3">
        <BotAvatar name={agent.name} avatar={agent.avatarUrl} seed={agent.id} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-[15px] leading-tight tracking-tight">
            <button
              type="button"
              onClick={onOpen}
              className="text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
            >
              {agent.name}
            </button>
          </h3>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">@{agent.username}</p>
        </div>
        <StatusChip status={agent.status} message={agent.statusMessage} className="relative" />
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-muted-foreground text-sm leading-5">
        {agent.description || agent.instructions}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <ModelChip provider={agent.modelProvider} modelId={agent.modelId} className="mr-auto min-w-0" />
        <Tooltip content="Add to channel">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onAddToChannel}
            disabled={agent.status === "disabled"}
            aria-label="Add to channel"
            data-testid="add-to-channel"
            className="relative z-10"
          >
            <Hash />
          </Button>
        </Tooltip>
        {canMessage(agent) ? <MessageBotButton agent={agent} /> : null}
      </div>
    </article>
  );
}
