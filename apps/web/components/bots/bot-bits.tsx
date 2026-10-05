"use client";

import { type Agent, type AgentStatus, type ModelProviderKind, modelLabel } from "@ocw/contracts";
import { Cpu, Lock } from "lucide-react";
import { toneFor } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, initials } from "@/lib/utils";

const isUrl = (v: string) => /^https?:\/\//.test(v);

/** Bot avatar: emoji on a soft tile, an image, or initials. Rounded square (people are round). */
export function BotAvatar({
  name,
  avatar,
  seed,
  size = "md",
  className,
}: {
  name: string;
  avatar: string | null | undefined;
  seed?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const box = {
    sm: "size-7 rounded-lg text-sm",
    md: "size-11 rounded-xl text-[22px]",
    lg: "size-14 rounded-2xl text-[28px]",
  }[size];
  if (avatar && isUrl(avatar)) {
    return (
      // biome-ignore lint/performance/noImgElement: arbitrary remote avatar URLs, no Next image config
      <img src={avatar} alt="" className={cn("shrink-0 border object-cover", box, className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center border border-black/5 font-semibold dark:border-white/10",
        avatar ? "bg-gradient-to-br from-muted to-muted/40" : toneFor(seed ?? name),
        box,
        !avatar && { sm: "text-[11px]", md: "text-sm", lg: "text-base" }[size],
        className,
      )}
    >
      {avatar || initials(name)}
    </span>
  );
}

const STATUS: Record<AgentStatus, { label: string; dot: string; text: string; ring: string }> = {
  provisioning: {
    label: "Provisioning",
    dot: "bg-warning animate-pulse",
    text: "text-warning",
    ring: "bg-warning/10 border-warning/25",
  },
  ready: { label: "Ready", dot: "bg-success", text: "text-success", ring: "bg-success/10 border-success/25" },
  error: {
    label: "Error",
    dot: "bg-destructive",
    text: "text-destructive",
    ring: "bg-destructive/10 border-destructive/25",
  },
  disabled: {
    label: "Disabled",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
    ring: "bg-muted border-border",
  },
};

export function StatusChip({
  status,
  message,
  className,
}: {
  status: AgentStatus;
  message?: string | null;
  className?: string;
}) {
  const s = STATUS[status];
  const chip = (
    <span
      data-testid="bot-status"
      data-status={status}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 font-medium text-[11.5px]",
        s.ring,
        s.text,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
  if (status === "error" && message) return <Tooltip content={message}>{chip}</Tooltip>;
  return chip;
}

export function ModelChip({
  provider,
  modelId,
  className,
}: {
  provider: ModelProviderKind;
  modelId: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1 rounded-full border bg-background px-2 text-[11.5px] text-muted-foreground",
        className,
      )}
    >
      <Cpu className="size-3 shrink-0" />
      <span className="truncate">{modelLabel(provider, modelId)}</span>
    </span>
  );
}

/**
 * What the caller may do with one bot, from the API's per-bot `viewerCan` (never the org-wide role): a team bot
 * is edited with `bot.manage`; a personal bot only by its owner (`bot.configure`), while an admin may still
 * switch it off or delete it (`bot.manage`, governance) without seeing inside.
 */
export function botAbilities(agent: Agent): { edit: boolean; govern: boolean } {
  const can = new Set(agent.viewerCan ?? []);
  const edit = agent.scope === "personal" ? can.has("bot.configure") : can.has("bot.manage");
  return { edit, govern: edit || can.has("bot.manage") };
}

/** Marks the caller's own personal bot (D-01): nobody else can see it. */
export function PersonalBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="bot-personal-badge"
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-brand-soft px-1.5 font-medium text-[11px] text-brand-soft-foreground",
        className,
      )}
    >
      <Lock className="size-2.5" aria-hidden />
      Personal
    </span>
  );
}
