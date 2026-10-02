import { Hash, MessagesSquare, Plus } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { SectionSidebar } from "@/components/shell/section-sidebar";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Chat" };

export default function ChatPage() {
  return (
    <>
      <SectionSidebar
        title="Channels"
        actions={
          <Button variant="ghost" size="icon-xs" aria-label="Create channel" disabled>
            <Plus />
          </Button>
        }
      >
        <p className="px-2.5 py-2 text-muted-foreground text-xs">No channels yet.</p>
      </SectionSidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title="Chat" icon={<MessagesSquare />} />
        <EmptyState
          icon={Hash}
          title="Start the first conversation"
          description="Channels bring people and AI agents into the same thread. Mention a bot to bring it in."
        >
          <Button disabled>
            <Plus /> Create channel
          </Button>
        </EmptyState>
      </div>
    </>
  );
}
