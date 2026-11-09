import type { WorkSessionAgentRef } from "@ocw/contracts";
import { TriangleAlert } from "lucide-react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const OUTSIDE_CONTENT_REASON =
  "Sent after the bot read outside content (an MCP result, a file, a webhook or a web page)";

/**
 * "🤖 Scout · for Ana" in place of a prompt's person-only author line when a bot wrote it (07.16, D-06, PD-20): the
 * bot's avatar (16) and name, then the person it works for (the sponsor, who stays the prompt's author) muted, by
 * first name. Screen readers hear one phrase, "Scout, for Ana Pérez": the visible parts are decoration for them, as
 * in `ProposedByLine`.
 */
export function AgentAuthorLine({
  agent,
  forName,
  className,
}: {
  agent: WorkSessionAgentRef;
  /** The prompt's author (the bot's sponsor); null when the directory has no name for them. */
  forName: string | null;
  className?: string;
}) {
  const first = forName?.trim().split(/\s+/)[0] ?? null;
  return (
    <span
      data-testid="agent-author"
      data-agent-id={agent.agentId}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs", className)}
    >
      <span className="sr-only">{forName ? `${agent.displayName}, for ${forName}` : agent.displayName}</span>
      <span aria-hidden className="inline-flex shrink-0">
        <PrincipalAvatar kind="agent" name={agent.displayName} seed={agent.agentId} className="size-4" />
      </span>
      <span aria-hidden className="min-w-0 truncate font-medium text-foreground/80">
        {agent.displayName}
      </span>
      {first ? (
        <span aria-hidden className="whitespace-nowrap">
          · for {first}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The amber "After outside content" chip on a prompt sent from a bot turn that read outside content (07.16, D-08,
 * PD-20): visible to everyone in the session. The reason is a tooltip for pointers and a hidden sentence for screen
 * readers. Tokens only (the Full access badge's warning tone), both themes.
 */
export function OutsideContentChip({ className }: { className?: string }) {
  return (
    <Tooltip content={OUTSIDE_CONTENT_REASON}>
      <span
        data-testid="outside-content"
        className={cn(
          "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 font-medium text-[11px] text-amber-800 dark:text-amber-300",
          className,
        )}
      >
        <TriangleAlert aria-hidden className="size-3" />
        After outside content
        <span className="sr-only">. {OUTSIDE_CONTENT_REASON}.</span>
      </span>
    </Tooltip>
  );
}
