"use client";

import type { Agent } from "@ocw/contracts";
import { Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BotAvatar, ModelChip, StatusChip } from "./bot-bits";

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

      <div className="mt-4 flex items-center justify-between gap-2">
        <ModelChip provider={agent.modelProvider} modelId={agent.modelId} className="min-w-0" />
        <Button
          variant={agent.status === "ready" ? "secondary" : "ghost"}
          size="sm"
          onClick={onAddToChannel}
          disabled={agent.status === "disabled"}
          data-testid="add-to-channel"
          className="relative z-10 shrink-0"
        >
          <Hash /> Add to channel
        </Button>
      </div>
    </article>
  );
}
