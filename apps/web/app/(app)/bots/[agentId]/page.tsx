import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentPage } from "@/components/bots/agent-page";
import { ModuleGate } from "@/components/shell/module-gate";

export const metadata: Metadata = { title: "Bot" };

/**
 * `/bots/<agentId>?tab=memory|capabilities` (07.2-14, MEM-03): a bot's memory and capabilities, read-only. The bots
 * list the API returns decides whether the page exists for the viewer; the Bots module (07.3) gates it like the gallery.
 */
export default async function AgentPageRoute({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return (
    <ModuleGate module="bots">
      <Suspense>
        <AgentPage key={agentId} agentId={agentId} />
      </Suspense>
    </ModuleGate>
  );
}
