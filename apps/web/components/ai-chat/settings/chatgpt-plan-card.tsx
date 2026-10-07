"use client";

import type { ChatgptPlanState, ChatgptPlanStatus } from "@ocw/contracts";
import { ArrowUpRight, CircleAlert, Unplug } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChatgptConnectDialog } from "@/components/ai-chat/chatgpt-connect-dialog";
import { ChatgptWelcomeModal } from "@/components/ai-chat/chatgpt-welcome-modal";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useChatgptPlan, useDisconnectChatgpt } from "@/lib/chatgpt-plan-queries";
import { cn } from "@/lib/utils";

const EXPLAINER =
  "Use your own ChatGPT Plus or Pro plan in AI chats. Usage counts against your plan; your organization is not billed.";

/** Why the plan cannot be used, in plain words (the member's own account, never an admin's). */
const ATTENTION: Partial<Record<ChatgptPlanState, { title: string; text: string; action: string | null }>> = {
  needs_reconnect: {
    title: "Reconnect your ChatGPT plan",
    text: "Your ChatGPT sign-in expired or was revoked. Until you reconnect, your AI chats use your organization's models.",
    action: "Reconnect",
  },
  plan_usage_disabled: {
    title: "Plan usage wasn't allowed",
    text: "This ChatGPT sign-in didn't allow plan usage in other apps. Reconnect and allow it, or keep using your organization's models.",
    action: "Reconnect",
  },
  not_eligible: {
    title: "This ChatGPT account isn't eligible",
    text: "ChatGPT doesn't offer plan usage in other apps for this account or workspace. Your AI chats use your organization's models.",
    action: "Use another account",
  },
  disabled_by_org: {
    title: "Your admin turned this off",
    text: "ChatGPT plans aren't available in AI chats in this organization. Your AI chats use your organization's models.",
    action: null,
  },
};

const planLabel = (plan: string | null) =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1).replace(/_/gu, " ") : null;

/** The ChatGPT mark used across the plan UI (identity only, not OpenAI's logo). */
export function ChatgptMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#10a37f] font-bold text-[11px] text-white tracking-tight shadow-xs",
        className,
      )}
    >
      GPT
    </span>
  );
}

/** OpenAI-style primary action: a black pill in light mode, white in dark mode. */
export function ContinueWithChatgptButton({
  onClick,
  children = "Continue with ChatGPT",
  testId = "chatgpt-continue",
}: {
  onClick(): void;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Button
      onClick={onClick}
      data-testid={testId}
      className="h-10 w-full rounded-full bg-foreground px-5 text-background hover:bg-foreground/90 sm:h-9 sm:w-auto"
    >
      {children}
    </Button>
  );
}

function Shell({ state, children }: { state: string; children: ReactNode }) {
  return (
    <div
      data-testid="chatgpt-plan-card"
      data-state={state}
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:gap-5 sm:p-5"
    >
      {children}
    </div>
  );
}

/** "Disconnect" with a confirmation: revokes the member's tokens at OpenAI and removes them (D-02). */
function DisconnectButton({ variant = "outline" }: { variant?: "outline" | "ghost" }) {
  const [open, setOpen] = useState(false);
  const disconnect = useDisconnectChatgpt();
  async function onConfirm() {
    try {
      await disconnect.mutateAsync();
      setOpen(false);
      toast.success("ChatGPT plan disconnected");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="chatgpt-disconnect"
        className="h-10 flex-1 sm:h-8 sm:flex-none"
      >
        Disconnect
      </Button>
      <Dialog open={open} onOpenChange={(o) => !disconnect.isPending && setOpen(o)}>
        <DialogContent data-testid="chatgpt-disconnect-dialog">
          <DialogHeader>
            <span className="mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs">
              <Unplug className="size-5" strokeWidth={1.75} />
            </span>
            <DialogTitle>Disconnect your ChatGPT plan?</DialogTitle>
            <DialogDescription>
              Your AI chats on ChatGPT models will switch to organization models. Your sign-in is revoked at
              OpenAI and removed from this workspace; you can connect again at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={disconnect.isPending}
              className="h-10 sm:h-9"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onConfirm}
              disabled={disconnect.isPending}
              data-testid="chatgpt-disconnect-confirm"
              className="h-10 sm:h-9"
            >
              {disconnect.isPending ? <Spinner /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Connected({ status }: { status: ChatgptPlanStatus }) {
  const plan = planLabel(status.planType);
  return (
    <Shell state="connected">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <ChatgptMark />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-sm">ChatGPT</span>
            <span
              data-testid="chatgpt-plan-connected"
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-px font-medium text-[11.5px] text-emerald-700 dark:text-emerald-400"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
              Connected
            </span>
          </div>
          <p className="mt-0.5 truncate text-muted-foreground text-sm" data-testid="chatgpt-plan-account">
            {status.email ?? "ChatGPT account"}
            {plan ? (
              <>
                <span aria-hidden className="mx-1.5 text-muted-foreground/50">
                  ·
                </span>
                <span data-testid="chatgpt-plan-type">{plan}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <a
          href={status.manageUsageUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="chatgpt-manage-usage"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "h-10 flex-1 sm:h-8 sm:flex-none",
          )}
        >
          Manage usage
          <ArrowUpRight aria-hidden className="size-3.5" />
        </a>
        <DisconnectButton />
      </div>
    </Shell>
  );
}

/**
 * Settings › AI chat › ChatGPT plan (D-02, P-09): the member's own plan, never anyone else's. Not connected →
 * "Continue with ChatGPT"; connected → account, plan, "Manage usage", "Disconnect" (and the one-time welcome until
 * it is seen); reconnect / not eligible / turned off by the admin → why, and what to do.
 */
export function ChatgptPlanCard() {
  const status = useChatgptPlan();
  const [connectOpen, setConnectOpen] = useState(false);
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  const s = status.data;
  // The one-time welcome (05-07): right after connecting here, or on the first visit after connecting elsewhere.
  const welcomeOpen = s?.state === "connected" && !s.welcomeSeen && !welcomeClosed && !connectOpen;

  let body: ReactNode;
  if (status.isPending) {
    body = <Skeleton className="h-[88px] rounded-xl" />;
  } else if (!s) {
    body = (
      <Shell state="error">
        <p className="text-muted-foreground text-sm">{errorMessage(status.error)}</p>
      </Shell>
    );
  } else if (s.state === "connected") {
    body = <Connected status={s} />;
  } else if (s.state === "not_connected") {
    body = (
      <Shell state="not_connected">
        <div className="flex min-w-0 flex-1 items-start gap-3.5 sm:items-center">
          <ChatgptMark />
          <div className="min-w-0">
            <div className="font-medium text-sm">ChatGPT</div>
            <p className="mt-0.5 text-muted-foreground text-sm leading-relaxed">{EXPLAINER}</p>
          </div>
        </div>
        <ContinueWithChatgptButton onClick={() => setConnectOpen(true)} />
      </Shell>
    );
  } else {
    const a = ATTENTION[s.state];
    body = (
      <Shell state={s.state}>
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          >
            <CircleAlert className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="font-medium text-sm">{a?.title ?? "ChatGPT plan"}</div>
            <p className="mt-0.5 text-muted-foreground text-sm leading-relaxed">{a?.text}</p>
            {s.email ? <p className="mt-1 truncate text-muted-foreground text-xs">{s.email}</p> : null}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {a?.action ? (
            <ContinueWithChatgptButton onClick={() => setConnectOpen(true)} testId="chatgpt-reconnect">
              {a.action}
            </ContinueWithChatgptButton>
          ) : null}
          {s.connectedAt ? <DisconnectButton variant="ghost" /> : null}
        </div>
      </Shell>
    );
  }

  return (
    <section className="grid gap-3" aria-labelledby="chatgpt-plan-heading">
      <div>
        <h2 id="chatgpt-plan-heading" className="font-semibold text-[15px] tracking-tight">
          ChatGPT plan
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Sign in with your own ChatGPT account. Your tokens stay on the server and are used only for your
          chats.
        </p>
      </div>
      {body}
      <ChatgptConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => toast.success("ChatGPT plan connected")}
      />
      <ChatgptWelcomeModal open={welcomeOpen} onDone={() => setWelcomeClosed(true)} />
    </section>
  );
}
