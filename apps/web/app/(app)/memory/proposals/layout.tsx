"use client";

import { type ReactNode, Suspense } from "react";
import { ProposalsShell } from "@/components/memory/proposals-inbox";

/**
 * The approvals inbox under Memory (Phase 07.2, 07.2-13, D-08). The shell lives in the layout so the list keeps its
 * scroll and selection while reviews change; the pages only declare the routes. The memory layout above skips the file
 * viewer on these routes and keeps the module gate.
 */
export default function ProposalsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ProposalsShell />
      {children}
    </Suspense>
  );
}
