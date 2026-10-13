"use client";

import { useParams, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MemoryShell } from "@/components/memory/memory-shell";
import { ModuleGate } from "@/components/shell/module-gate";

/**
 * The memory viewer (Phase 07.2, MEM-02). The shell lives in the layout so the tree, its focus and its scroll
 * position survive moving between files; the pages only declare the routes. A member whose Memory module is off
 * (07.3) sees the in-place off state, live.
 */
export default function MemoryLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ scopeId?: string; path?: string[] }>();
  const pathname = usePathname();
  // The proposals inbox (07.2-13) is its own screen under Memory: same module gate, no file viewer.
  if (pathname === "/memory/proposals" || pathname.startsWith("/memory/proposals/")) {
    return <ModuleGate module="memory">{children}</ModuleGate>;
  }
  return (
    <ModuleGate module="memory">
      <MemoryShell scopeId={params.scopeId} segments={params.path} />
      {children}
    </ModuleGate>
  );
}
