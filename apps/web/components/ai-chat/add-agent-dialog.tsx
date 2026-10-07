"use client";

import type { Agent } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BotAvatar, ScopeBadge } from "@/components/bots/bot-bits";
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
import { addAiChatAgent, useAiChatParticipants } from "@/lib/ai-grant-queries";
import { errorMessage } from "@/lib/api";
import { useAgents } from "@/lib/bots-queries";
import { cn } from "@/lib/utils";

/**
 * Adds an agent persona to an AI chat (06-12, AGENT-02, D-07, P-10). The list is `GET /agents`, which the server already
 * filters to the personas the owner may see (T-06-12-03); personal bots never join an AI chat, disabled ones cannot
 * answer, and personas already in the chat are left out. The server decides the add (`ai_chat.manage` + `bot.read`).
 * Once added, everyone in the chat can @mention the persona and it answers through the Agent Channel API.
 */
export function AddAgentDialog({
  chatId,
  open,
  onOpenChange,
}: {
  chatId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const qc = useQueryClient();
  const agents = useAgents();
  const participants = useAiChatParticipants(chatId, open);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = q.trim().toLowerCase().replace(/^@/u, "");

  const inChat = useMemo(
    () => new Set((participants.data?.participants ?? []).filter((p) => p.kind === "agent").map((p) => p.id)),
    [participants.data],
  );
  const list = useMemo(
    () =>
      (agents.data?.agents ?? [])
        .filter((a) => a.scope !== "personal" && a.status !== "disabled" && !inChat.has(a.id))
        .filter(
          (a) =>
            !needle || a.name.toLowerCase().includes(needle) || a.username.toLowerCase().includes(needle),
        ),
    [agents.data, inChat, needle],
  );
  const picked: Agent | undefined = list.find((a) => a.id === selected);

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setQ("");
      setSelected(null);
    }
  }

  async function submit() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await addAiChatAgent(qc, chatId, picked.id);
      toast.success(`@${picked.username} joined this chat`, {
        description: `Mention @${picked.username} in a message to ask it something.`,
      });
      close(false);
    } catch (err) {
      toast.error("Couldn't add the agent", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="ai-add-agent-dialog">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>
            Everyone in this chat can mention it. It reads the whole conversation and answers in it, with the
            tools every reader may use.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pt-3">
          <div className="flex h-10 items-center gap-2 rounded-lg border bg-background px-2.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              data-testid="ai-add-agent-search"
              aria-label="Search agents"
              placeholder="Search agents"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-[13.5px]"
            />
          </div>
        </div>
        <DialogBody className="max-h-80 pt-3">
          {agents.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
              <Bot className="size-5" />
              <p className="max-w-xs text-balance">
                {needle
                  ? `No agent matches “${q.trim()}”.`
                  : "No more agents to add. Team and organization agents you can see appear here."}
              </p>
            </div>
          ) : (
            <ul className="grid gap-1" aria-label="Agents">
              {list.map((a) => {
                const on = selected === a.id;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      data-testid="ai-add-agent-option"
                      data-agent-id={a.id}
                      onClick={() => setSelected(a.id)}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-3 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                        on ? "border-primary/50 bg-brand-soft/60" : "border-transparent hover:bg-accent",
                      )}
                    >
                      <BotAvatar name={a.name} avatar={a.avatarUrl} seed={a.id} size="sm" />
                      <span className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate font-medium text-[13.5px]">{a.name}</span>
                        <span className="truncate text-[12px] text-muted-foreground">@{a.username}</span>
                      </span>
                      <ScopeBadge agent={a} className="max-w-[9rem] max-sm:hidden" />
                      {on ? <Check className="size-4 shrink-0 text-primary" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button data-testid="ai-add-agent-submit" onClick={() => void submit()} disabled={!picked || busy}>
            {busy ? <Spinner /> : null}
            {picked ? `Add @${picked.username}` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
