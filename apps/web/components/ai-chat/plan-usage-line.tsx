import { CHATGPT_MANAGE_USAGE_URL } from "@ocw/contracts";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Using ChatGPT plan · Manage usage" near the composer whenever a plan model is selected (OpenAI UI rule, D-02,
 * P-11). The link opens the member's ChatGPT usage page in a new tab.
 */
export function PlanUsageLine({ className }: { className?: string }) {
  return (
    <p
      data-testid="plan-usage-line"
      className={cn(
        "flex items-center justify-center gap-1.5 px-3 text-[11.5px] text-muted-foreground leading-5",
        className,
      )}
    >
      <span>Using ChatGPT plan</span>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <a
        href={CHATGPT_MANAGE_USAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground/75 underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30"
      >
        Manage usage
        <ArrowUpRight aria-hidden className="size-3" />
      </a>
    </p>
  );
}
