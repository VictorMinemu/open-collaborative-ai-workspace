"use client";

import { Link2Off } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

/**
 * A permalink whose message cannot be shown (CHAT-14, T-04-03-01). Deleted, missing, malformed, or in a
 * conversation the viewer cannot read all render this one view: no name, no hint that anything exists.
 */
export function MessageUnavailable() {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="message-unavailable">
      <PageHeader title="Message" icon={<Link2Off />} />
      <EmptyState
        icon={Link2Off}
        title="This message isn't available"
        description="It may have been deleted, or the link points to a conversation you can't open."
      >
        <Button render={<Link href="/chat" />}>Back to chat</Button>
      </EmptyState>
    </div>
  );
}
