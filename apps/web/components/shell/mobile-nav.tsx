"use client";

import type { MeResponse } from "@ocw/contracts";
import { Menu, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useSearchPalette } from "@/components/search/search-palette";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { countLabel } from "@/lib/approval-queries";
import { RailContent } from "./app-rail";
import { activeItem, type NavItem } from "./nav";
import { countedName, useNavCount } from "./nav-list";
import { UserMenu } from "./user-menu";
import { OrgAvatar } from "./workspace-switcher";

/** Matches the drawer's popup, where the rail and the page's section sidebar (portalled into it) live. */
export const MOBILE_NAV_SELECTOR = "[data-mobile-nav]";

export function MobileTopBar({
  me,
  open,
  onOpenChange,
  onSlot,
}: {
  me: MeResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the drawer element where pages portal their SectionSidebar. */
  onSlot: (el: HTMLElement | null) => void;
}) {
  const pathname = usePathname();
  const section = activeItem(pathname);
  const close = () => onOpenChange(false);
  const palette = useSearchPalette();

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-2 backdrop-blur-md">
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger
          data-testid="mobile-nav-trigger"
          aria-label="Open navigation"
          className="inline-flex size-10 items-center justify-center rounded-lg text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <Menu className="size-5" />
        </SheetTrigger>
        <SheetContent side="left" showClose={false} className="bg-sidebar p-0" data-mobile-nav="">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <RailContent me={me} onNavigate={close}>
            <div
              ref={onSlot}
              className="flex min-h-0 flex-1 flex-col border-sidebar-border border-t empty:hidden"
            />
          </RailContent>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <OrgAvatar name={me.organization.name} className="size-7 rounded-md text-xs" />
        {section?.badge ? (
          <CountedTitle item={section} />
        ) : (
          <span data-testid="mobile-topbar-title" className="truncate font-semibold text-[15px]">
            {section?.label ?? me.organization.name}
          </span>
        )}
      </div>

      <button
        type="button"
        data-testid="open-search"
        aria-label="Search"
        onClick={() => palette.open()}
        className="inline-flex size-10 items-center justify-center rounded-lg text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <Search className="size-5" />
      </button>
      <UserMenu me={me} compact />
    </header>
  );
}

/**
 * The section title of a counted section (Approvals, Memory) with its live count, as on the rail: "☰ Approvals ②"
 * (07.5 UI-SPEC, phone inbox; WINDOWS #223). Screen readers hear "Approvals, 2 to review"; the visual count is hidden
 * from them.
 */
function CountedTitle({ item }: { item: NavItem }) {
  const count = useNavCount(item);
  if (count === 0) {
    return (
      <span data-testid="mobile-topbar-title" className="truncate font-semibold text-[15px]">
        {item.label}
      </span>
    );
  }
  return (
    <span data-testid="mobile-topbar-title" className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="truncate font-semibold text-[15px]">
        {item.label}
      </span>
      <span className="sr-only">{countedName(item, count)}</span>
      <Badge
        variant="brand"
        aria-hidden
        data-testid="mobile-topbar-count"
        className="h-5 min-w-5 shrink-0 rounded-full px-1.5 tabular-nums"
      >
        {countLabel(count)}
      </Badge>
    </span>
  );
}
