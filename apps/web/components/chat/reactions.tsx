"use client";

import type { Message, ReactionSummary } from "@ocw/contracts";
import { SmilePlus } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "./emoji-picker";
import { dirKey, useOrgDirectory } from "./use-chat-directory";

/** "You, Sam Lee and 3 others reacted with 👍" from the first reactors (ids resolved through the directory). */
function useReactorsLabel(meId: string) {
  const dir = useOrgDirectory();
  return (r: ReactionSummary) => {
    const names = r.members.map((m) =>
      m.kind === "user" && m.id === meId
        ? "You"
        : (dir.byKey.get(dirKey(m.kind, m.id))?.displayName ?? "Someone"),
    );
    // "You" leads, like Slack: the viewer finds themselves first.
    names.sort((a, b) => (a === "You" ? -1 : b === "You" ? 1 : 0));
    const rest = r.count - names.length;
    const who =
      rest > 0
        ? `${names.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`
        : names.length > 1
          ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
          : (names[0] ?? "Someone");
    return `${who} reacted with ${r.emoji}`;
  };
}

const chipClass =
  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[13px] leading-none outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-default";

/**
 * Reaction chips under a message (CHAT-07): emoji + count (tabular), the viewer's own highlighted, names on hover,
 * and a trailing "add reaction" chip that opens the picker. Click a chip to add or remove your reaction. Nothing
 * for tombstones or a message without reactions.
 */
export function ReactionBar({
  message,
  meId,
  canReact,
  onToggle,
}: {
  message: Message;
  meId: string;
  canReact: boolean;
  onToggle(emoji: string): void;
}) {
  const label = useReactorsLabel(meId);
  const reactions = message.reactions ?? [];
  if (message.deletedAt || reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reaction-bar">
      {reactions.map((r) => (
        <Tooltip key={r.emoji} content={label(r)}>
          <button
            type="button"
            data-testid="reaction-chip"
            data-emoji={r.emoji}
            data-mine={r.mine ? "true" : "false"}
            aria-pressed={r.mine}
            aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? "reaction" : "reactions"}`}
            disabled={!canReact}
            onClick={() => onToggle(r.emoji)}
            className={cn(
              chipClass,
              r.mine
                ? "border-primary/45 bg-primary/10 text-primary hover:bg-primary/15 dark:border-primary/55 dark:bg-primary/20"
                : "border-border bg-muted/50 text-foreground/80 hover:border-foreground/25 hover:bg-muted dark:bg-white/[0.04]",
            )}
          >
            <span className="text-[15px]">{r.emoji}</span>
            <span className="font-medium text-xs tabular-nums">{r.count}</span>
          </button>
        </Tooltip>
      ))}
      {canReact ? (
        <EmojiPicker
          onPick={onToggle}
          trigger={
            <button
              type="button"
              aria-label="Add reaction"
              data-testid="reaction-add"
              className={cn(
                chipClass,
                "border-transparent px-1.5 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground data-[popup-open]:border-border data-[popup-open]:bg-muted",
              )}
            >
              <SmilePlus className="size-4" />
            </button>
          }
        />
      ) : null}
    </div>
  );
}
