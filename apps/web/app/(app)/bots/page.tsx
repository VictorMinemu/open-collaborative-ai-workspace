import { Bot, Plus, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Bots" };

export default function BotsPage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Bots"
        icon={<Bot />}
        actions={
          <Button size="sm" disabled>
            <Plus /> New bot
          </Button>
        }
      />
      <EmptyState
        icon={Sparkles}
        title="Create your first bot"
        description="Bots are teammates with their own identity and permissions. Add them to channels and mention them like anyone else."
      >
        <Button disabled>
          <Plus /> New bot
        </Button>
      </EmptyState>
    </div>
  );
}
