import { Link2 } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectionsSettings } from "@/components/connectors/connections-settings";
import { ModuleGate } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Connections" };

/**
 * Settings › Connections (07.4-13, UI-SPEC § 2): the member's own accounts on per-member connectors, the return from a
 * provider's sign-in, and the conversations they allowed an account in. Connecting is part of the Bots module
 * (`connector.connect`, ADR-0024), so the page shows the module's off state when Bots are off for the member.
 */
export default function SettingsConnectionsPage() {
  return (
    <ModuleGate module="bots">
      <PageHeader
        title="Connections"
        icon={<Link2 />}
        description="Your own accounts that bots use when you ask"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={null}>
          <ConnectionsSettings />
        </Suspense>
      </div>
    </ModuleGate>
  );
}
