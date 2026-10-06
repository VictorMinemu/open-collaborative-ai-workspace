"use client";

import type { ChatgptPlanStatus } from "@ocw/contracts";
import { ArrowUpRight, Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, isApiError } from "@/lib/api";
import { useCompleteChatgptSignIn, useStartChatgptSignIn } from "@/lib/chatgpt-plan-queries";
import { cn } from "@/lib/utils";

/** What the member reads for each refusal; `restart` means the sign-in must begin again from step 1. */
const ERRORS: Record<string, { text: string; restart: boolean }> = {
  invalid_redirect: {
    text: "That isn't the right address. Paste the full address that starts with http://127.0.0.1.",
    restart: false,
  },
  state_mismatch: {
    text: "That address belongs to an older sign-in. Continue with ChatGPT again and paste the new address.",
    restart: true,
  },
  signin_cancelled: {
    text: "The sign-in was cancelled in ChatGPT. Continue with ChatGPT to try again.",
    restart: true,
  },
  flow_not_found: { text: "This sign-in expired. Continue with ChatGPT to start again.", restart: true },
  signin_failed: {
    text: "ChatGPT didn't accept this sign-in. Continue with ChatGPT to try again.",
    restart: true,
  },
  id_token_invalid: {
    text: "ChatGPT's sign-in couldn't be verified. Continue with ChatGPT to try again.",
    restart: true,
  },
  chatgpt_unavailable: {
    text: "ChatGPT sign-in isn't reachable right now. Try again in a moment.",
    restart: true,
  },
  disabled_by_org: { text: "Your admin turned off ChatGPT plans for AI chats.", restart: true },
};

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-3">
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-7 items-center justify-center rounded-full border font-semibold text-xs tabular-nums",
          done ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-card",
        )}
      >
        {done ? <Check className="size-3.5" strokeWidth={2.5} /> : n}
      </span>
      <div className="grid min-w-0 gap-2">
        <h3 className="font-medium text-sm leading-7">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/**
 * "Continue with ChatGPT" → paste the loopback address (D-02, P-09). Step 1 asks the API for an authorize URL and
 * opens it in a new tab; after the member approves, OpenAI sends their browser to an http://127.0.0.1 page that does
 * not load. Step 2 takes that address: it is POSTed to the API, which finishes the sign-in. A dialog from `sm` up, a
 * bottom sheet on phones.
 */
export function ChatgptConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConnected?(s: ChatgptPlanStatus): void;
}) {
  const start = useStartChatgptSignIn();
  const complete = useCompleteChatgptSignIn();
  const [flow, setFlow] = useState<{ flowId: string; authorizeUrl: string } | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    if (open) return;
    setFlow(null);
    setAddress("");
    setError(null);
  }, [open]);

  async function onContinue() {
    setError(null);
    // Opened inside the click so no popup blocker interferes; it navigates once the API answers.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const r = await start.mutateAsync({});
      setFlow({ flowId: r.flowId, authorizeUrl: r.authorizeUrl });
      if (tab && !tab.closed) tab.location.href = r.authorizeUrl;
      else window.open(r.authorizeUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      tab?.close();
      setError(isApiError(err) ? (ERRORS[err.code]?.text ?? errorMessage(err)) : errorMessage(err));
    }
  }

  async function onConnect() {
    if (!flow || !address.trim()) return;
    setError(null);
    try {
      const status = await complete.mutateAsync({ flowId: flow.flowId, redirectUrl: address.trim() });
      onConnected?.(status);
      onOpenChange(false);
    } catch (err) {
      const known = isApiError(err) ? ERRORS[err.code] : undefined;
      setError(known?.text ?? errorMessage(err));
      if (known?.restart) {
        setFlow(null);
        setAddress("");
      }
    }
  }

  const pending = start.isPending || complete.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !complete.isPending && onOpenChange(o)}>
      <DialogContent data-testid="chatgpt-connect-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect your ChatGPT plan</DialogTitle>
          <DialogDescription>
            Your AI chats then run on your own ChatGPT Plus or Pro plan. Only you can use this connection.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ol className="grid gap-5">
            <Step n={1} done={flow !== null} title="Sign in to ChatGPT">
              {flow ? (
                <p className="text-muted-foreground text-sm">
                  ChatGPT opened in a new tab.{" "}
                  <a
                    href={flow.authorizeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    Open it again
                    <ArrowUpRight aria-hidden className="size-3" />
                  </a>
                </p>
              ) : (
                <Button
                  onClick={onContinue}
                  disabled={pending}
                  data-testid="chatgpt-dialog-continue"
                  className="h-10 w-full rounded-full bg-foreground text-background hover:bg-foreground/90 sm:w-fit sm:px-5"
                >
                  {start.isPending ? <Spinner /> : null}
                  Continue with ChatGPT
                </Button>
              )}
            </Step>
            <Step n={2} done={false} title="Paste the address from that tab">
              <p className="text-muted-foreground text-sm leading-relaxed">
                After you approve, the tab shows a page that can't be reached at{" "}
                <span className="font-mono text-[12.5px] text-foreground">127.0.0.1</span>. That's expected:
                copy the full address from its address bar and paste it here.
              </p>
              <label htmlFor={inputId} className="sr-only">
                Address of the ChatGPT page
              </label>
              <Textarea
                id={inputId}
                data-testid="chatgpt-redirect-input"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                rows={3}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="min-h-20 resize-none break-all font-mono text-[12.5px]"
              />
              {error ? (
                <p
                  id={errorId}
                  role="alert"
                  data-testid="chatgpt-connect-error"
                  className="text-destructive text-sm"
                >
                  {error}
                </p>
              ) : null}
            </Step>
          </ol>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={complete.isPending}
            className="h-10 sm:h-9"
          >
            Cancel
          </Button>
          <Button
            onClick={onConnect}
            disabled={!flow || !address.trim() || pending}
            data-testid="chatgpt-connect-submit"
            className="h-10 sm:h-9"
          >
            {complete.isPending ? <Spinner /> : null}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
