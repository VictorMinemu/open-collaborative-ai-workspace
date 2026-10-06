import type { AiErrorCode } from "@ocw/contracts";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One plain-language line per failure code (provider error bodies never reach the client). 05-07 refines the
 * plan-specific codes with actions (reconnect, switch model, manage usage).
 */
const REASONS: Record<AiErrorCode, string> = {
  usage_limit_exceeded: "you've reached your ChatGPT plan's usage limit",
  user_not_eligible: "this ChatGPT account can't be used for AI chats here",
  usage_unavailable: "ChatGPT is temporarily unavailable",
  unsupported_capability: "the model doesn't support part of this request",
  invalid_credential: "your ChatGPT sign-in is no longer valid",
  route_not_supported: "this request isn't supported on this model",
  not_connected: "your ChatGPT plan isn't connected",
  model_unavailable: "this model isn't available to you",
  daily_limit_reached: "today's AI usage limit is reached",
  rate_limited: "the model is busy right now",
  context_too_large: "this conversation is too long for the model",
  provider_error: "the model returned an error",
  timeout: "the model took too long to answer",
  interrupted: "it was interrupted",
};

export function generationErrorText(code: AiErrorCode | null): string {
  return `This answer failed — ${REASONS[code ?? "provider_error"]}`;
}

/** The quiet card under a failed answer (any partial text stays above it): calm, never a spinner. */
export function GenerationError({ code, className }: { code: AiErrorCode | null; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex w-fit max-w-full items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-[13.5px] text-muted-foreground",
        className,
      )}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span data-testid="ai-generation-error" className="min-w-0 break-words">
        {generationErrorText(code)}
      </span>
    </div>
  );
}
