"use client";

import {
  type AiErrorCode,
  type AiModelOption,
  CHATGPT_MANAGE_USAGE_URL,
  DEFAULT_MODEL,
  modelRefKey,
} from "@ocw/contracts";
import { ArrowUpRight, CircleAlert, Gauge } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setAiChatModel } from "@/lib/ai-chat-model-store";
import { useAiModels } from "@/lib/ai-chat-queries";
import { useRefreshPlanState } from "@/lib/chatgpt-plan-queries";
import { cn } from "@/lib/utils";
import { ChatgptConnectDialog } from "./chatgpt-connect-dialog";
import { ChatgptWelcomeModal } from "./chatgpt-welcome-modal";

/** Failures that move the member's credential (not eligible, needs reconnect): the plan state is re-read live. */
const CREDENTIAL_CODES: ReadonlySet<AiErrorCode> = new Set(["user_not_eligible", "invalid_credential"]);

/**
 * What a failed answer says, per normalized code (provider error bodies never reach the client, T-05-07-05), and
 * what the member can do about it (D-02). A failure is never retried or re-routed by itself: "Use an organization
 * model" only changes the composer's selection for the NEXT message the member sends (T-05-07-01).
 */
const TEXT: Record<AiErrorCode, string> = {
  usage_limit_exceeded: "You've reached your ChatGPT usage limit",
  user_not_eligible: "Your ChatGPT account isn't eligible for plan usage here.",
  usage_unavailable: "ChatGPT is temporarily unavailable. Try again in a moment.",
  unsupported_capability: "", // built from the refused parameter, see generationErrorText
  invalid_credential: "Your ChatGPT sign-in is no longer valid. Reconnect to keep using your plan.",
  route_not_supported: "Something went wrong on the model's side. Try again later.",
  not_connected: "Your ChatGPT plan isn't connected.",
  model_unavailable: "This model isn't available to you anymore. Choose another model.",
  daily_limit_reached: "You've reached today's AI usage limit.",
  rate_limited: "The model is busy right now. Try again in a moment.",
  context_too_large: "This conversation is too long for this model. Start a new chat to continue.",
  provider_error: "Something went wrong on the model's side. Try again later.",
  timeout: "The model took too long to answer. Try again.",
  interrupted: "This answer was interrupted.",
};

/** `error.param` of an unsupported-capability refusal, in words (anything else stays generic). */
const CAPABILITY: Record<string, string> = {
  input_file: "files",
  input_image: "images",
  web_search: "web search",
  web_search_preview: "web search",
  tools: "tools",
};

export function generationErrorText(code: AiErrorCode | null, param: string | null = null): string {
  const c = code ?? "provider_error";
  if (c === "unsupported_capability") {
    const what = (param && CAPABILITY[param]) || "this feature";
    return `This model can't use ${what} on your plan.`;
  }
  return TEXT[c];
}

// ---------------------------------------------------------------- live failures

/** Messages this page has seen streaming: their failure arrived live (not a stored failure after a reload). */
const streamedHere = new Set<string>();
/** Messages whose usage-limit dialog already opened once. */
const dialogShown = new Set<string>();

/** Called while an answer renders as streaming; its failure (if any) is then treated as live. */
export function markStreamed(messageId: string): void {
  streamedHere.add(messageId);
}

/** The organization model "Use an organization model" switches to: the recommended one, else the first available. */
export function orgFallback(models: AiModelOption[] | undefined): AiModelOption | null {
  const org = (models ?? []).filter((m) => m.group === "organization" && m.available);
  const recommended = modelRefKey({ backend: "org_key", ...DEFAULT_MODEL });
  return org.find((m) => modelRefKey(m.ref) === recommended) ?? org[0] ?? null;
}

// ---------------------------------------------------------------- the card

function ManageUsageLink({
  testId,
  primary = false,
  ref,
}: {
  testId: string;
  primary?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}) {
  return (
    <a
      ref={ref}
      href={CHATGPT_MANAGE_USAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      data-primary={primary ? "true" : undefined}
      className={cn(
        buttonVariants({ variant: primary ? "default" : "outline", size: "sm" }),
        primary ? "h-10 sm:h-9" : "h-8",
      )}
    >
      Manage usage
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

/**
 * The usage-limit dialog (D-02, OpenAI UI rules): opens once when the limit arrives live. "Manage usage" is the
 * primary action; "Use an organization model" (METERED, billed to the organization) is the member's explicit choice.
 */
function UsageLimitDialog({
  open,
  onOpenChange,
  org,
  onUseOrg,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  org: AiModelOption | null;
  onUseOrg(): void;
}) {
  const manage = useRef<HTMLAnchorElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="ai-usage-limit-dialog" initialFocus={manage}>
        <DialogHeader>
          <span className="mb-1 flex size-10 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-600 shadow-xs dark:text-amber-400">
            <Gauge className="size-5" strokeWidth={1.75} />
          </span>
          <DialogTitle>You've reached your ChatGPT usage limit</DialogTitle>
          <DialogDescription>
            The answer stopped at your plan's limit; what it wrote so far is kept. Your usage resets over
            time, and you can check it in ChatGPT.
          </DialogDescription>
        </DialogHeader>
        {org ? (
          <p className="-mt-2 text-muted-foreground text-sm" data-testid="ai-usage-limit-org-note">
            You can also continue on <span className="font-medium text-foreground">{org.label}</span>, an
            organization model. It is metered and billed to your organization.
          </p>
        ) : null}
        <DialogFooter>
          {org ? (
            <Button
              variant="outline"
              onClick={onUseOrg}
              data-testid="ai-usage-limit-use-org"
              className="h-10 sm:h-9"
            >
              Use an organization model
            </Button>
          ) : null}
          <ManageUsageLink testId="ai-usage-limit-manage" primary ref={manage} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The quiet card under a failed answer (any partial text stays above it): one plain-language line and the actions
 * that help for that code. `chatKey` is the chat the composer selection belongs to.
 */
export function GenerationError({
  messageId,
  chatKey,
  code,
  param = null,
  className,
}: {
  messageId: string;
  chatKey: string;
  code: AiErrorCode | null;
  param?: string | null;
  className?: string;
}) {
  const models = useAiModels();
  const org = orgFallback(models.data?.models);
  const refreshPlan = useRefreshPlanState();
  const usageLimit = code === "usage_limit_exceeded";
  const [live] = useState(() => streamedHere.has(messageId));
  const [dialogOpen, setDialogOpen] = useState(() => usageLimit && live && !dialogShown.has(messageId));
  const [connectOpen, setConnectOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  useEffect(() => {
    if (dialogOpen) dialogShown.add(messageId);
  }, [dialogOpen, messageId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per live failure
  useEffect(() => {
    if (live && code && CREDENTIAL_CODES.has(code)) refreshPlan();
  }, [live, code]);

  function useOrg() {
    if (!org) return;
    setAiChatModel(chatKey, org.ref);
    setDialogOpen(false);
  }

  const useOrgButton = org ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={useOrg}
      data-testid="ai-error-use-org"
      className="h-8 text-foreground"
    >
      Use an organization model
    </Button>
  ) : null;
  const connectButton = (label: string) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setConnectOpen(true)}
      data-testid="ai-error-reconnect"
      className="h-8"
    >
      {label}
    </Button>
  );

  let actions: ReactNode = null;
  if (usageLimit) {
    actions = (
      <>
        <ManageUsageLink testId="ai-error-manage-usage" />
        {useOrgButton}
      </>
    );
  } else if (code === "user_not_eligible") {
    actions = useOrgButton;
  } else if (code === "invalid_credential") {
    actions = connectButton("Reconnect ChatGPT");
  } else if (code === "not_connected") {
    actions = connectButton("Continue with ChatGPT");
  }

  return (
    <div
      role="status"
      data-testid="ai-generation-error-card"
      data-code={code ?? "provider_error"}
      className={cn(
        "grid w-fit max-w-full gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-[13.5px] text-muted-foreground",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span data-testid="ai-generation-error" className="min-w-0 break-words">
          {generationErrorText(code, param)}
        </span>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5 pl-6">{actions}</div> : null}
      {usageLimit ? (
        <UsageLimitDialog open={dialogOpen} onOpenChange={setDialogOpen} org={org} onUseOrg={useOrg} />
      ) : null}
      {code === "invalid_credential" || code === "not_connected" ? (
        <>
          <ChatgptConnectDialog
            open={connectOpen}
            onOpenChange={setConnectOpen}
            onConnected={(status) => {
              if (status.state === "connected" && !status.welcomeSeen) setWelcomeOpen(true);
            }}
          />
          <ChatgptWelcomeModal open={welcomeOpen} onDone={() => setWelcomeOpen(false)} />
        </>
      ) : null}
    </div>
  );
}
