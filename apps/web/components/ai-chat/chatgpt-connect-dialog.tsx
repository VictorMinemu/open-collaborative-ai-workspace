"use client";

import type { ChatgptPlanStatus } from "@ocw/contracts";
import { ArrowUpRight, Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { type DesktopChatgptLoopbackResult, desktopChatgptLoopback, useDesktop } from "@/lib/desktop";
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

/** Why the desktop path handed over to pasting (a member's own cancel needs no explanation). */
const DESKTOP_FALLBACK: Record<Exclude<DesktopChatgptLoopbackResult, { ok: true }>["reason"], string | null> =
  {
    cancelled: null,
    timeout: "The browser didn't come back in time. If you approved, paste the address from that tab.",
    invalid_url: "The app couldn't open ChatGPT's sign-in page. Open it from the link and paste the address.",
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
 *
 * In the desktop app (05-07) there is nothing to paste: the main process listens once on 127.0.0.1, the API builds the
 * redirect URI on that port, the system browser comes back to the listener and the app hands the address to the API
 * itself. If that path fails or the member cancels it, the same sign-in continues with the paste step.
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
  const loopback = desktopChatgptLoopback(useDesktop());
  const [flow, setFlow] = useState<{ flowId: string; authorizeUrl: string } | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The desktop listener's flow token while the app waits for the browser. */
  const [waiting, setWaiting] = useState<string | null>(null);
  /** The desktop path failed or was cancelled: the paste steps take over. */
  const [pasteFallback, setPasteFallback] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const inputId = useId();
  const errorId = useId();
  const pasting = !loopback || pasteFallback;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset (and free a pending listener) only when it closes
  useEffect(() => {
    if (open) return;
    if (waiting) void loopback?.cancel(waiting).catch(() => {});
    setFlow(null);
    setAddress("");
    setError(null);
    setWaiting(null);
    setPasteFallback(false);
  }, [open]);

  function failWith(err: unknown) {
    const known = isApiError(err) ? ERRORS[err.code] : undefined;
    setError(known?.text ?? errorMessage(err));
    if (known?.restart) {
      setFlow(null);
      setAddress("");
    }
  }

  /** Desktop: prepare the one-shot listener → start on its port → wait for the browser → complete. */
  async function onContinueDesktop(lb: NonNullable<typeof loopback>) {
    setError(null);
    let token: string | null = null;
    try {
      const prepared = await lb.prepare();
      token = prepared.flowToken;
      setWaiting(token);
      const r = await start.mutateAsync({ redirectPort: prepared.port });
      setFlow({ flowId: r.flowId, authorizeUrl: r.authorizeUrl });
      const result = await lb.await(token, r.authorizeUrl);
      if (!openRef.current) return;
      setWaiting(null);
      if (!result.ok) {
        setPasteFallback(true);
        setError(DESKTOP_FALLBACK[result.reason]);
        return;
      }
      const status = await complete.mutateAsync({ flowId: r.flowId, redirectUrl: result.redirectUrl });
      onConnected?.(status);
      onOpenChange(false);
    } catch (err) {
      if (token) void lb.cancel(token).catch(() => {});
      if (!openRef.current) return;
      setWaiting(null);
      setPasteFallback(true);
      failWith(err);
    }
  }

  function onCancelWaiting() {
    if (waiting) void loopback?.cancel(waiting).catch(() => {});
  }

  async function onContinue() {
    if (loopback && !pasteFallback) return onContinueDesktop(loopback);
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
      failWith(err);
    }
  }

  const pending = start.isPending || complete.isPending || waiting !== null;

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
            <Step n={1} done={flow !== null && waiting === null} title="Sign in to ChatGPT">
              {waiting ? (
                <div
                  data-testid="chatgpt-desktop-waiting"
                  role="status"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Spinner />
                    Waiting for ChatGPT in your browser…
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={onCancelWaiting}
                    data-testid="chatgpt-desktop-cancel"
                    className="h-auto px-0 font-medium text-foreground"
                  >
                    Paste the address instead
                  </Button>
                </div>
              ) : flow ? (
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
            {pasting ? (
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
                    // After a "start again" error there is no sign-in to complete: keep saying why Connect is off.
                    if (error && flow) setError(null);
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
            ) : error ? (
              <p role="alert" data-testid="chatgpt-connect-error" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
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
          {pasting ? (
            <Button
              onClick={onConnect}
              disabled={!flow || !address.trim() || pending}
              data-testid="chatgpt-connect-submit"
              className="h-10 sm:h-9"
            >
              {complete.isPending ? <Spinner /> : null}
              Connect
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
