"use client";

import type { MeResponse } from "@ocw/contracts";
import { Menu, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useSearchPalette } from "@/components/search/search-palette";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { RailContent } from "./app-rail";
import { activeItem } from "./nav";
import { UserMenu } from "./user-menu";
import { OrgAvatar } from "./workspace-switcher";

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
        <SheetContent side="left" showClose={false} className="bg-sidebar p-0">
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
        <span className="truncate font-semibold text-[15px]">{section?.label ?? me.organization.name}</span>
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
