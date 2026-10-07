"use client";

import { CHATGPT_MANAGE_USAGE_URL } from "@ocw/contracts";
import { ArrowUpRight } from "lucide-react";
import { type JSX, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMarkChatgptWelcomeSeen } from "@/lib/chatgpt-plan-queries";
import { cn } from "@/lib/utils";

/**
 * The one-time welcome after a member connects their ChatGPT plan (OpenAI UI rules, D-02): it says whose plan pays
 * (theirs, never the organization) and where to manage usage. Any way of closing it records it as seen, so it does
 * not come back. A centered dialog from `sm` up, a bottom sheet on phones.
 */
export function ChatgptWelcomeModal({ open, onDone }: { open: boolean; onDone(): void }): JSX.Element {
  const seen = useMarkChatgptWelcomeSeen();
  const gotIt = useRef<HTMLButtonElement>(null);

  function close() {
    if (!seen.isPending) seen.mutate();
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent data-testid="chatgpt-welcome" initialFocus={gotIt}>
        <DialogHeader>
          <span
            aria-hidden
            className="mb-1 flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#10a37f] font-bold text-[11px] text-white tracking-tight shadow-xs"
          >
            GPT
          </span>
          <DialogTitle>You're using your ChatGPT plan here</DialogTitle>
          <DialogDescription>
            You're using your ChatGPT plan in Open Collaborative AI Workspace. Usage counts toward your plan's
            limits, not your organization's bill.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <a
            href={CHATGPT_MANAGE_USAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="chatgpt-welcome-manage-usage"
            className={cn(buttonVariants({ variant: "outline" }), "h-10 sm:h-9")}
          >
            Manage usage
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
          <Button ref={gotIt} onClick={close} data-testid="chatgpt-welcome-done" className="h-10 sm:h-9">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
