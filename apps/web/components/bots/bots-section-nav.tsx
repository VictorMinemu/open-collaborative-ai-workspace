"use client";

import { Bot, Zap } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "bots", label: "Bots", href: "/bots", icon: Bot },
  { id: "automations", label: "Automations", href: "/bots/automations", icon: Zap },
] as const;

/**
 * Bots · Automations (07.6-15, UI-SPEC R10): two pages, so a `<nav>` of links with `aria-current="page"`, not an ARIA
 * tablist. Styled like the `ui/tabs` underline variant: a 2 px primary indicator under the current one, `min-h-11`.
 */
export function BotsSectionNav({ active }: { active: (typeof SECTIONS)[number]["id"] }) {
  return (
    <nav
      aria-label="Bots sections"
      data-testid="bots-section-nav"
      className="flex h-12 shrink-0 items-stretch gap-1 border-b px-2 sm:px-4"
    >
      {SECTIONS.map((s) => {
        const current = s.id === active;
        const Icon = s.icon;
        return (
          <Link
            key={s.id}
            href={s.href}
            aria-current={current ? "page" : undefined}
            data-testid={`bots-section-${s.id}`}
            className={cn(
              "relative inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
              current &&
                "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
