"use client";

import { createContext, useContext } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ShellPrefs {
  railCollapsed: boolean;
  toggleRail: () => void;
}

/** UI preferences persisted per browser. */
export const useShellPrefs = create<ShellPrefs>()(
  persist(
    (set) => ({
      railCollapsed: false,
      toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
    }),
    { name: "ocw.shell", storage: createJSONStorage(() => localStorage) },
  ),
);

export interface ShellContextValue {
  isDesktop: boolean;
  /** Element inside the mobile drawer where the current page's SectionSidebar is portalled. */
  mobileSectionSlot: HTMLElement | null;
  closeMobileNav: () => void;
}

export const ShellContext = createContext<ShellContextValue>({
  isDesktop: true,
  mobileSectionSlot: null,
  closeMobileNav: () => {},
});

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}
