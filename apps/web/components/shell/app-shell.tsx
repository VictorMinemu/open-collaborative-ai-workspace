"use client";

import type { MeResponse } from "@ocw/contracts";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { OsNotifier } from "@/components/notifications/os-notifier";
import { SearchPalette, SearchPaletteProvider, useSearchPalette } from "@/components/search/search-palette";
import { useIsDesktop } from "@/hooks/use-media-query";
import { AppRail } from "./app-rail";
import { MobileTopBar } from "./mobile-nav";
import { ShellContext, type ShellContextValue } from "./shell-context";

/**
 * Workspace chrome: rail (desktop) or top bar + drawer (mobile), and a flex main area that pages fill.
 * Pages render `<SectionSidebar>` (optional) followed by their content. `OsNotifier` runs once here, on every page
 * (OS notifications, title count and the desktop badge, CHAT-10).
 */
export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const isDesktop = useIsDesktop();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  // Close the drawer after navigating (e.g. picking a channel from the section sidebar).
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on route change only
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const ctx = useMemo<ShellContextValue>(
    () => ({
      isDesktop,
      mobileSectionSlot: isDesktop ? null : slot,
      closeMobileNav: () => setMobileOpen(false),
    }),
    [isDesktop, slot],
  );

  return (
    <ShellContext.Provider value={ctx}>
      <SearchPaletteProvider>
        <SearchHotkey />
        <OsNotifier />
        {/* `relative`: absolutely positioned descendants (every `sr-only` text) resolve against the shell, which clips
            them, instead of the page, which they would make scrollable (07.1 gate). */}
        <div data-testid="app-shell" className="relative flex h-dvh w-full overflow-hidden bg-background">
          {isDesktop ? <AppRail me={me} /> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            {isDesktop ? null : (
              <MobileTopBar me={me} open={mobileOpen} onOpenChange={setMobileOpen} onSlot={setSlot} />
            )}
            <main className="flex min-h-0 min-w-0 flex-1">{children}</main>
          </div>
        </div>
        <SearchPalette />
      </SearchPaletteProvider>
    </ShellContext.Provider>
  );
}

/**
 * ⌘K (macOS) / Ctrl+K anywhere in the workspace toggles the search palette, even while typing in the composer:
 * the modifier makes it a command, never text. Plain keys are never captured.
 */
function SearchHotkey() {
  const palette = useSearchPalette();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.isComposing) return;
      e.preventDefault();
      palette.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette]);
  return null;
}
