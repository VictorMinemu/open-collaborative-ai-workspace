"use client";

import { FileText, Lightbulb, ListChecks, Lock, Mail } from "lucide-react";
import type { ReactNode } from "react";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * New chat's calm empty state (05-14, D-08): a greeting with the member's first name, the privacy line, and four
 * starters that only fill the composer (text, no network, nothing is sent). The composer sits in the middle of the
 * column on a desktop with the starters under it, like ChatGPT; on a phone the composer stays at the bottom (thumb
 * reach) and the starters sit just above it as a 2 × 2 grid of touch-sized cards.
 */

const STARTERS: ReadonlyArray<{ label: string; hint: string; prompt: string; icon: typeof FileText }> = [
  {
    label: "Summarize a document",
    hint: "Key points in five bullets",
    prompt: "Summarize this document in five bullet points:\n\n",
    icon: FileText,
  },
  {
    label: "Draft an email",
    hint: "Short, clear and friendly",
    prompt: "Draft a short, friendly email to ",
    icon: Mail,
  },
  {
    label: "Explain a concept",
    hint: "Plain words, one example",
    prompt: "Explain this concept in plain words, with one example: ",
    icon: Lightbulb,
  },
  {
    label: "Plan a project",
    hint: "Steps, owners and dates",
    prompt: "Help me plan a project. Break it into steps with owners and dates: ",
    icon: ListChecks,
  },
];

/** The member's first name for the greeting (null until /me is known). */
function useFirstName(): string | null {
  const me = useMe();
  const name = me.data?.user.name?.trim();
  return name ? (name.split(/\s+/u)[0] ?? null) : null;
}

export function AiEmptyState({ onPick, composer }: { onPick(prompt: string): void; composer?: ReactNode }) {
  const first = useFirstName();
  return (
    <div data-testid="ai-empty-state" className="flex min-h-0 flex-1 flex-col sm:justify-center sm:pb-[10vh]">
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 text-center sm:flex-none sm:pb-7">
        <h2 className="text-balance font-semibold text-[22px] tracking-tight sm:text-[28px]">
          {first ? `What can I help with, ${first}?` : "What can I help with?"}
        </h2>
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Lock aria-hidden className="size-3.5" />
          Only you can see this chat
        </p>
      </div>
      <ul
        aria-label="Suggestions"
        data-testid="ai-starters"
        className={cn(
          "mx-auto grid w-full max-w-3xl grid-cols-2 gap-2 px-3 pb-2",
          "sm:order-last sm:flex sm:flex-wrap sm:justify-center sm:px-6 sm:pt-3 sm:pb-0",
        )}
      >
        {STARTERS.map(({ label, hint, prompt, icon: Icon }) => (
          <li key={label} className="min-w-0">
            <button
              type="button"
              data-testid="ai-starter"
              onClick={() => onPick(prompt)}
              className={cn(
                "flex h-full min-h-14 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-2xl border bg-card px-3.5 py-2.5 text-left outline-none transition-colors",
                "hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30",
                "sm:h-9 sm:min-h-0 sm:w-auto sm:flex-row sm:items-center sm:gap-2 sm:rounded-full sm:px-3.5 sm:py-0",
              )}
            >
              <span className="flex w-full min-w-0 items-center gap-2 font-medium text-[13.5px] leading-5 sm:w-auto sm:font-normal sm:text-foreground/85">
                {/* Two cards side by side at 390 leave no room for the icon; the pills on a desktop keep it. */}
                <Icon aria-hidden className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
                <span className="truncate">{label}</span>
              </span>
              <span className="w-full truncate text-[12px] text-muted-foreground leading-4 sm:hidden">
                {hint}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {composer}
    </div>
  );
}
