"use client";

import type { MeResponse } from "@ocw/contracts";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LiveViewProvider } from "@/components/browser/live-view-provider";
import { OsNotifier } from "@/components/notifications/os-notifier";
import { SearchPalette, SearchPaletteProvider, useSearchPalette } from "@/components/search/search-palette";
import { useIsDesktop } from "@/hooks/use-media-query";
import { AppRail } from "./app-rail";
import { MOBILE_NAV_SELECTOR, MobileTopBar } from "./mobile-nav";
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
  const navigatedFromDrawer = useRef(false);

  // The drawer closes after a navigation the person starts while it is open: an item in it (e.g. picking a channel
  // from the section sidebar) or back/forward. Not after one they did not start: /chat redirects to the default
  // channel once the channel list loads, after the shell is interactive, and a drawer opened in that window used to
  // close by itself (07.2 gate, e2e/tests/mobile-drawer.spec.ts). Back/forward closes it at once: React renders a
  // transition started in `popstate` (Next's traversal) synchronously, before a later listener could flag it.
  useEffect(() => {
    if (!mobileOpen) return;
    navigatedFromDrawer.current = false;
    const fromDrawer = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(MOBILE_NAV_SELECTOR))
        navigatedFromDrawer.current = true;
    };
    const onHistory = () => setMobileOpen(false);
    document.addEventListener("click", fromDrawer, true);
    document.addEventListener("keydown", fromDrawer, true);
    window.addEventListener("popstate", onHistory);
    return () => {
      document.removeEventListener("click", fromDrawer, true);
      document.removeEventListener("keydown", fromDrawer, true);
      window.removeEventListener("popstate", onHistory);
    };
  }, [mobileOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run on route change only
  useEffect(() => {
    if (navigatedFromDrawer.current) setMobileOpen(false);
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
        {/* 07.8-22: the live view of a bot's browser, one at a time, in a portal that survives in-app navigation. */}
        <LiveViewProvider>
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
              {/* 07.8-26: the phone live dock sets --live-dock-h, so the composer stays above it (UI-SPEC §1.5). */}
              <main className="flex min-h-0 min-w-0 flex-1 pb-[var(--live-dock-h,0px)]">{children}</main>
            </div>
          </div>
          <SearchPalette />
        </LiveViewProvider>
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
