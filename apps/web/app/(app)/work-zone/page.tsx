import { Laptop, Plus, SquareTerminal } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Work Zone" };

export default function WorkZonePage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Work Zone"
        icon={<SquareTerminal />}
        actions={
          <Button size="sm" disabled>
            <Plus /> New session
          </Button>
        }
      />
      <EmptyState
        icon={Laptop}
        title="Run coding agents together"
        description="Connect a device to start Claude Code sessions that your whole team can follow, prompt and approve."
      >
        <Button disabled>
          <Laptop /> Connect a device
        </Button>
      </EmptyState>
    </div>
  );
}
