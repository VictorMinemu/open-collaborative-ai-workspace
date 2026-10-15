import type { WorkPrompt } from "@ocw/contracts";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";

/**
 * "· proposed by 🤖 Scout" after a prompt's author in the Work Zone (Phase 07.5, D-03, D-04, UI-SPEC Surface 3
 * "Proposed by", T-07.5-14-05): the first prompt of a session a bot proposed and a person started. The author stays
 * the person who pressed Start; this line credits the bot. 12/400 muted, bot avatar 16. Screen readers hear one
 * phrase, "Ana Pérez, proposed by Scout": the visible parts are decoration for them, a hidden phrase says it.
 */
export function ProposedByLine({ agent }: { agent: NonNullable<WorkPrompt["proposedBy"]> }) {
  return (
    <span
      data-testid="proposed-by"
      className="inline-flex min-w-0 items-center gap-1 font-normal text-muted-foreground text-xs"
    >
      <span className="sr-only">, proposed by {agent.displayName}</span>
      <span aria-hidden>·</span>
      <span aria-hidden className="whitespace-nowrap">
        proposed by
      </span>
      <span aria-hidden className="inline-flex">
        <PrincipalAvatar kind="agent" name={agent.displayName} seed={agent.agentId} className="size-4" />
      </span>
      <span aria-hidden className="min-w-0 truncate">
        {agent.displayName}
      </span>
    </span>
  );
}
