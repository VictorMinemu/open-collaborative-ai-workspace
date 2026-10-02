"use client";

import type { Agent } from "@ocw/contracts";
import { Check, Hash, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useAddAgentToChannel, useChannels } from "@/lib/bots-queries";
import { cn } from "@/lib/utils";
import { BotAvatar } from "./bot-bits";

/** Adds a bot to a channel through chat's `POST /channels/:id/members {kind:'agent', id}`. */
export function AddToChannelDialog({
  agent,
  onOpenChange,
}: {
  agent: Agent | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = agent !== null;
  const channels = useChannels(open);
  const add = useAddAgentToChannel();
  const [selected, setSelected] = useState<string | null>(null);
  const list = (channels.data?.channels ?? []).filter((c) => c.kind === "channel" && !c.archivedAt);

  async function submit() {
    if (!agent || !selected) return;
    const channel = list.find((c) => c.id === selected);
    try {
      await add.mutateAsync({ channelId: selected, agentId: agent.id });
      toast.success(`@${agent.username} joined #${channel?.name ?? "channel"}`, {
        description: `Mention @${agent.username} in a message or thread to ask it something.`,
      });
      onOpenChange(false);
      setSelected(null);
    } catch (err) {
      if (isApiError(err, 404)) toast.error("Channels are not available on this server yet");
      else if (isApiError(err, 409)) {
        toast.message(`@${agent.username} is already in #${channel?.name ?? "that channel"}`);
        onOpenChange(false);
      } else toast.error("Could not add the bot", { description: errorMessage(err) });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setSelected(null);
      }}
    >
      <DialogContent data-testid="add-to-channel-dialog">
        <DialogHeader>
          <div className="mb-2 flex items-center gap-3">
            {agent ? (
              <BotAvatar name={agent.name} avatar={agent.avatarUrl} seed={agent.id} size="sm" />
            ) : null}
            <DialogTitle>Add {agent ? `@${agent.username}` : "bot"} to a channel</DialogTitle>
          </div>
          <DialogDescription>
            Members of the channel can mention it; it replies in the thread.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-80">
          {channels.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : channels.data === null ? (
            <Unavailable text="Channels arrive with Chat. Once chat is enabled on this server you can add bots here." />
          ) : channels.isError ? (
            <Unavailable text={errorMessage(channels.error)} />
          ) : list.length === 0 ? (
            <Unavailable text="No channels yet. Create one in Chat, then come back." />
          ) : (
            <ul className="grid gap-1" aria-label="Channels">
              {list.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={selected === c.id}
                    data-testid="channel-option"
                    onClick={() => setSelected(c.id)}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 rounded-lg border px-3 text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                      selected === c.id
                        ? "border-primary/50 bg-brand-soft/60"
                        : "border-transparent hover:bg-accent",
                    )}
                  >
                    <Hash className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {c.memberCount} members
                    </span>
                    {selected === c.id ? <Check className="size-4 text-primary" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selected || add.isPending} data-testid="confirm-add-to-channel">
            {add.isPending ? <Spinner /> : null}
            Add to channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
      <MessagesSquare className="size-5" />
      <p className="max-w-xs text-balance">{text}</p>
    </div>
  );
}
