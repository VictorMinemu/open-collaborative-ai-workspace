import type { Metadata } from "next";
import { Suspense } from "react";
import { AutomationsPage } from "@/components/automations/automations-list";
import { ModuleGate } from "@/components/shell/module-gate";

export const metadata: Metadata = { title: "Automations" };

/**
 * `/bots/automations` (07.6-15, AUTO-01, UI-SPEC R10): a static segment beside 07.2's `/bots/<agentId>` (static wins;
 * agent ids are UUIDs). The editor is a sheet over the list (`?new=1`, `?edit=<id>`, `&tab=runs`, `&run=<runId>`,
 * `?draft=<approvalId>`); automations live with their bots, so the Bots module gates the page.
 */
export default function AutomationsRoute() {
  return (
    <ModuleGate module="bots">
      <Suspense>
        <AutomationsPage />
      </Suspense>
    </ModuleGate>
  );
}
