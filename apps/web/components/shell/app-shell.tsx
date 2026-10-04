"use client";

import type { MeResponse } from "@ocw/contracts";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useIsDesktop } from "@/hooks/use-media-query";
import { AppRail } from "./app-rail";
import { MobileTopBar } from "./mobile-nav";
import { ShellContext, type ShellContextValue } from "./shell-context";

/**
 * Workspace chrome: rail (desktop) or top bar + drawer (mobile), and a flex main area that pages fill.
 * Pages render `<SectionSidebar>` (optional) followed by their content.
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
      <div data-testid="app-shell" className="flex h-dvh w-full overflow-hidden bg-background">
        {isDesktop ? <AppRail me={me} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {isDesktop ? null : (
            <MobileTopBar me={me} open={mobileOpen} onOpenChange={setMobileOpen} onSlot={setSlot} />
          )}
          <main className="flex min-h-0 min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
