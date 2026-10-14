"use client";

import { Link2 } from "lucide-react";
import { Suspense } from "react";
import { ModuleOff, ModuleSkeleton, useModule } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";
import { useConnectors, useShares } from "@/lib/connector-queries";
import { ConnectionsSettings } from "./connections-settings";

/**
 * Settings › Connections with the Bots module (ADR-0024). Connecting is part of Bots (`connector.connect`), but
 * withdrawing never is (WINDOWS #196): with Bots off the page still opens while the member has a connection or an
 * allowed conversation, in the withdrawal view (Disconnect and Revoke only); with nothing left it is the module's off
 * state, like every other Bots page.
 */
export function ConnectionsPage() {
  const status = useModule("bots");
  const off = status === "off";
  const connectors = useConnectors(off);
  const shares = useShares(off);
  if (status === "loading") return <ModuleSkeleton />;
  if (off) {
    if (connectors.isPending || shares.isPending) return <ModuleSkeleton />;
    const nothingLeft =
      (connectors.data?.connectors.length ?? 0) === 0 && (shares.data?.shares.length ?? 0) === 0;
    if (nothingLeft) return <ModuleOff module="bots" />;
  }
  return (
    <>
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
    </>
  );
}
