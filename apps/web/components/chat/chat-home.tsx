"use client";

import { Hash, MessagesSquare, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useChannels } from "@/lib/chat-queries";
import { CreateChannelDialog } from "./create-channel-dialog";

/** `/chat`: opens the default channel (#general) or the first joined one. */
export function ChatHome() {
  const router = useRouter();
  const channels = useChannels();
  const [creating, setCreating] = useState(false);
  const list = channels.data?.channels ?? [];
  const target = list.find((c) => c.isDefault && c.isMember) ?? list.find((c) => c.isMember);

  useEffect(() => {
    if (target) router.replace(`/chat/${target.id}`);
  }, [target, router]);

  if (channels.isPending || target) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b px-4 sm:px-6">
          <Skeleton className="h-4 w-36" />
        </header>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader title="Chat" icon={<MessagesSquare />} />
      {channels.isError ? (
        <EmptyState
          icon={MessagesSquare}
          title="Couldn't load channels"
          description={errorMessage(channels.error)}
        >
          <Button variant="outline" onClick={() => void channels.refetch()}>
            Try again
          </Button>
        </EmptyState>
      ) : (
        <EmptyState
          icon={Hash}
          title="Start the first conversation"
          description="Channels bring people and AI bots into the same thread. Mention a bot with @ to bring it in."
        >
          <Button onClick={() => setCreating(true)}>
            <Plus /> Create channel
          </Button>
        </EmptyState>
      )}
      <CreateChannelDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
