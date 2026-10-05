"use client";

import { Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useCreatePersonalBot } from "@/lib/bots-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * One click → a personal bot and its private chat (BOT-01/02), then opens the chat. Rendered only when the
 * resolver grants `bot.create_personal` (every role by default; admins can deny it with a rule).
 *   variant "row": a sidebar row ("Create your personal bot"); variant "icon": the section's "+" action.
 */
export function PersonalBotButton({
  variant = "row",
  className,
}: {
  variant?: "row" | "icon";
  className?: string;
}) {
  const router = useRouter();
  const allowed = useCan("bot.create_personal");
  const create = useCreatePersonalBot();
  if (!allowed) return null;

  const run = () =>
    create.mutate(
      {},
      {
        onSuccess: (res) => {
          toast.success(`${res.agent.name} is ready to chat`);
          router.push(`/chat/dm/${res.dmId}`);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  if (variant === "icon") {
    return (
      <Tooltip content="New personal bot">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New personal bot"
          data-testid="new-personal-bot"
          disabled={create.isPending}
          onClick={run}
          className={className}
        >
          {create.isPending ? <Spinner /> : <Plus />}
        </Button>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      data-testid="create-personal-bot"
      disabled={create.isPending}
      onClick={run}
      className={cn(
        sectionItemClass(false),
        "h-auto min-h-8 py-1.5 text-muted-foreground disabled:opacity-70",
        className,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[30%] bg-brand-soft text-brand-soft-foreground">
        {create.isPending ? <Spinner className="size-3" /> : <Sparkles className="size-3" />}
      </span>
      <span className="truncate">{create.isPending ? "Creating your bot…" : "Create your personal bot"}</span>
    </button>
  );
}
