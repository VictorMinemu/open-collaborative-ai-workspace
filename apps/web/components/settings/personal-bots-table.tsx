"use client";

import type { BotCapabilities, BotGovernanceEntry } from "@ocw/contracts";
import { Bot, Power, PowerOff, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BotAvatar, ModelChip, StatusChip } from "@/components/bots/bot-bits";
import { UsageMeter } from "@/components/bots/usage-meter";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useBotGovernance, useGovernBot } from "@/lib/capability-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const CAPABILITY_LABELS: Array<[keyof Pick<BotCapabilities, "internet" | "memory" | "dateTime">, string]> = [
  ["internet", "Internet"],
  ["memory", "Memory"],
  ["dateTime", "Date & time"],
];

type Pending = { bot: BotGovernanceEntry; kind: "disable" | "enable" | "delete" } | null;

const COLUMNS = "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_7.5rem_6.5rem_5.5rem]";

/**
 * Personal-bot governance (D-01, BOT-01/05): every member's personal bot by metadata only — name, owner,
 * model, capabilities, today's usage and status. Never its instructions, chats or memory (the API's
 * `BotGovernanceEntry` carries none). Admins can switch one off or delete it, with confirmation.
 */
export function PersonalBotsTable() {
  const canManage = useCan("bot.manage");
  const list = useBotGovernance(canManage);
  const govern = useGovernBot();
  const [pending, setPending] = useState<Pending>(null);
  if (!canManage) return null;

  const bots = list.data?.bots ?? [];

  function confirm() {
    if (!pending) return;
    const { bot, kind } = pending;
    govern.mutate(
      { id: bot.id, kind },
      {
        onSuccess: () => {
          toast.success(
            kind === "delete"
              ? `${bot.name} deleted`
              : kind === "disable"
                ? `${bot.name} turned off`
                : `${bot.name} turned on`,
          );
          setPending(null);
        },
        onError: (err) => toast.error("Could not update the bot", { description: errorMessage(err) }),
      },
    );
  }

  return (
    <section className="grid gap-3" data-testid="personal-bots-table">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
          Personal bots
          {list.data ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground tabular-nums">
              {bots.length}
            </span>
          ) : null}
        </h2>
        <p className="mt-0.5 flex items-start gap-1.5 text-muted-foreground text-sm">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <span>Settings and usage only. Their instructions and private chats stay with their owner.</span>
        </p>
      </div>

      {list.isPending ? (
        <div className="grid gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-10 text-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-xl border bg-card shadow-xs">
            <Bot className="size-5 text-muted-foreground" />
          </span>
          <p className="font-medium text-sm">No personal bots yet</p>
          <p className="mt-1 max-w-xs text-muted-foreground text-xs">
            Members create one from the Bots section of the sidebar. They will show up here.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <div
            aria-hidden
            className={cn(
              "hidden items-center gap-4 border-b bg-muted/40 px-4 py-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wider lg:grid",
              COLUMNS,
            )}
          >
            <span>Bot</span>
            <span>Owner · model</span>
            <span>Capabilities</span>
            <span>Usage today</span>
            <span>Status</span>
            <span />
          </div>
          <ul className="divide-y" aria-label="Personal bots">
            {bots.map((b) => (
              <Row key={b.id} bot={b} onAction={(kind) => setPending({ bot: b, kind })} />
            ))}
          </ul>
        </div>
      )}

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !govern.isPending && setPending(null)}>
        <DialogContent data-testid="governance-confirm">
          {pending ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pending.kind === "delete"
                    ? `Delete ${pending.bot.name}?`
                    : pending.kind === "disable"
                      ? `Turn off ${pending.bot.name}?`
                      : `Turn on ${pending.bot.name}?`}
                </DialogTitle>
                <DialogDescription>
                  {pending.kind === "delete"
                    ? `${pending.bot.owner.displayName}'s personal bot is removed and its private chat archived. This cannot be undone.`
                    : pending.kind === "disable"
                      ? `${pending.bot.owner.displayName}'s personal bot stops answering and its private chat is archived. Only an admin can turn it back on.`
                      : `${pending.bot.owner.displayName}'s personal bot answers again and its private chat is restored.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPending(null)} disabled={govern.isPending}>
                  Cancel
                </Button>
                <Button
                  variant={pending.kind === "enable" ? "default" : "destructive"}
                  onClick={confirm}
                  disabled={govern.isPending}
                  data-testid="governance-confirm-action"
                >
                  {govern.isPending ? <Spinner /> : null}
                  {pending.kind === "delete"
                    ? "Delete bot"
                    : pending.kind === "disable"
                      ? "Turn off"
                      : "Turn on"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Row({
  bot,
  onAction,
}: {
  bot: BotGovernanceEntry;
  onAction: (kind: "disable" | "enable" | "delete") => void;
}) {
  const disabled = bot.status === "disabled";
  const enabled = CAPABILITY_LABELS.filter(([k]) => bot.capabilities[k]);
  return (
    <li
      data-testid="personal-bot-row"
      data-bot-id={bot.id}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-4 py-3.5 lg:gap-4",
        COLUMNS,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <BotAvatar
          name={bot.name}
          avatar={bot.avatarUrl}
          seed={bot.id}
          size="sm"
          className={cn(disabled && "opacity-60")}
        />
        <span className="min-w-0">
          <span className="block truncate font-medium text-sm">{bot.name}</span>
          <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
            @{bot.username}
          </span>
        </span>
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm lg:col-span-1 lg:block">
        <span className="text-muted-foreground text-xs lg:hidden">Owner</span>
        <span className="block truncate" data-testid="personal-bot-owner">
          {bot.owner.displayName}
        </span>
        <ModelChip provider={bot.model.provider} modelId={bot.model.modelId} className="max-w-full lg:mt-1" />
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-1 lg:col-span-1">
        {enabled.length > 0 ? (
          enabled.map(([k, label]) => (
            <Badge key={k} variant="outline" data-testid="personal-bot-capability">
              {label}
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">None</span>
        )}
      </div>
      <div className="col-span-2 flex items-center gap-2 lg:col-span-1 lg:block">
        <span className="text-muted-foreground text-xs lg:hidden">Today</span>
        <UsageMeter usage={bot.usage} compact />
      </div>
      {/* Top-right of the card on small screens, its own column on large ones. */}
      <div className="col-start-2 row-start-1 justify-self-end lg:col-start-auto lg:row-start-auto lg:justify-self-start">
        <StatusChip status={bot.status} />
      </div>
      <div className="col-span-2 flex items-center gap-1 lg:col-span-1 lg:justify-end">
        <Tooltip content={disabled ? "Turn on" : "Turn off"}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAction(disabled ? "enable" : "disable")}
            data-testid="personal-bot-toggle"
            className="flex-1 lg:flex-none"
            aria-label={disabled ? `Turn on ${bot.name}` : `Turn off ${bot.name}`}
          >
            {disabled ? <Power /> : <PowerOff />}
            <span className="lg:sr-only">{disabled ? "Turn on" : "Turn off"}</span>
          </Button>
        </Tooltip>
        <Tooltip content="Delete">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onAction("delete")}
            aria-label={`Delete ${bot.name}`}
            data-testid="personal-bot-delete"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </Tooltip>
      </div>
    </li>
  );
}
