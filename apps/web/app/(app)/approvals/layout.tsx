"use client";

import { type ReactNode, Suspense } from "react";
import { ApprovalsShell } from "@/components/approvals/approvals-inbox";

/**
 * The approvals inbox (Phase 07.5, D-04, APPROVE-02, APPROVE-03, UI-SPEC Surface 2): bot actions and Work Zone
 * proposals waiting for a person. The shell lives in the layout so the list keeps its scroll and selection while
 * reviews change; the pages only declare the routes.
 */
export default function ApprovalsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ApprovalsShell />
      {children}
    </Suspense>
  );
}
