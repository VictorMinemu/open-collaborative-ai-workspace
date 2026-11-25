"use client";

import type { WorkApproval, WorkBrowserApprovalKind } from "@ocw/contracts";
import { FileCode2, ShieldAlert, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { useResolveApproval } from "@/lib/workzone-queries";
import { WorkSignInCard } from "./browser/work-signin-card";
import { Markdown } from "./markdown";

/** The in-flight turn's author: the person a member-only browser request is for (D-21, D-26). */
export interface ApprovalAsker {
  id: string;
  name: string | null;
}

export interface BrowserApprovalWords {
  kind: WorkBrowserApprovalKind;
  /** The banner's title (unused for `signin`, which renders the sign-in card). */
  title: string;
  /** Whether the web offers this viewer the actions; the API still decides (PD-10). */
  answerable: boolean;
  /** Said instead of the actions when they are hidden. */
  onlyLine: string | null;
}

/**
 * The words of a browser approval and whether the web offers its actions to this viewer (07.13-21; D-11, D-21, D-26,
 * D-34). `signin` and `signed_in_host` belong to the in-flight turn's (human) author alone, so anyone else gets no
 * action, only who can answer; `host` and `admin_rule` keep the session's approve rule (`canDecide`). A hint from the
 * device's `kind`: the API decides who may answer from its own state (`browserApproverRule`) and refuses the rest.
 * Null for every other approval (rendered exactly as before).
 */
export function browserApprovalWords(
  approval: WorkApproval,
  who: { viewerId: string | null; asker: ApprovalAsker | null },
): BrowserApprovalWords | null {
  const b = approval.request.browser;
  if (!b) return null;
  const mine = who.asker !== null && who.viewerId !== null && who.viewerId === who.asker.id;
  const member = who.asker?.name ?? "the person who asked";
  switch (b.kind) {
    case "signin":
      return { kind: b.kind, title: `Sign in to ${b.origin}`, answerable: mine, onlyLine: null };
    case "signed_in_host":
      return {
        kind: b.kind,
        title: `Open ${b.origin}`,
        answerable: mine,
        onlyLine: mine ? null : `Only ${member} can answer this`,
      };
    case "host":
      return { kind: b.kind, title: `Open ${b.origin}`, answerable: true, onlyLine: null };
    case "admin_rule":
      return {
        kind: b.kind,
        title: `Your organization asks before ${b.tool} is used`,
        answerable: true,
        onlyLine: null,
      };
  }
}

/** Sticky banner for the oldest pending approval: Approve once / Allow for session / Deny with comment. */
export function ApprovalBanner({
  sessionId,
  approval,
  pendingCount,
  canDecide,
  agentLabel,
  deciderHint,
  viewerId = null,
  asker = null,
  deviceName = "the device",
  onOpenSignIn,
}: {
  sessionId: string;
  approval: WorkApproval;
  pendingCount: number;
  canDecide: boolean;
  agentLabel: string;
  deciderHint: string;
  /** 07.13-21: the viewer and the in-flight turn's author, for the member-only browser requests. */
  viewerId?: string | null;
  asker?: ApprovalAsker | null;
  deviceName?: string;
  /** "Open and sign in": opens the Browser tab and takes control there. */
  onOpenSignIn?: () => void;
}) {
  const resolve = useResolveApproval(sessionId);
  const [denying, setDenying] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const browser = browserApprovalWords(approval, { viewerId, asker });

  async function decide(decision: "once" | "session" | "deny") {
    setBusy(decision);
    try {
      await resolve.mutateAsync({
        id: approval.id,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setDenying(false);
      setComment("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const { tool, summary, paths } = approval.request;
  if (browser?.kind === "signin") {
    // D-21: the agent's sign-in request, addressed to the in-flight turn's author only.
    return (
      <div
        data-testid="approval-banner"
        data-kind="signin"
        className="mx-auto w-full max-w-3xl px-4 sm:px-6"
        role="alertdialog"
        aria-label={`${agentLabel} needs a sign-in`}
      >
        <WorkSignInCard
          approval={approval}
          agentLabel={agentLabel}
          askerName={asker?.name ?? null}
          viewerIsAsker={browser.answerable}
          canDecline={browser.answerable && canDecide}
          deviceName={deviceName}
          onOpen={() => onOpenSignIn?.()}
          onNotNow={() => void decide("deny")}
          declining={busy === "deny"}
        />
      </div>
    );
  }
  const decidable = canDecide && (browser?.answerable ?? true);
  return (
    <div
      data-testid="approval-banner"
      data-kind={browser?.kind}
      className="mx-auto w-full max-w-3xl px-4 sm:px-6"
      role="alertdialog"
      aria-label={browser ? `${agentLabel}: ${browser.title}` : `${agentLabel} wants to use ${tool}`}
    >
      <div className="overflow-hidden rounded-xl border border-warning/50 bg-card shadow-lg shadow-warning/5">
        <div className="flex items-start gap-3 bg-warning/10 px-4 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/20 text-warning">
            <ShieldAlert className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">
              {browser ? (
                <span className="break-words">{browser.title}</span>
              ) : tool === "ExitPlanMode" ? (
                <>{agentLabel} has a plan and wants to start editing</>
              ) : (
                <>
                  {agentLabel} wants to use <span className="font-semibold">{tool}</span>
                </>
              )}
              {pendingCount > 1 ? (
                <span className="ml-2 font-normal text-muted-foreground text-xs">
                  +{pendingCount - 1} more waiting
                </span>
              ) : null}
            </p>
            <p className="text-muted-foreground text-xs">Requested {relativeTime(approval.createdAt)}</p>
          </div>
        </div>
        <div className="grid gap-2 px-4 py-3">
          {tool === "ExitPlanMode" ? (
            <div className="scrollbar-thin max-h-56 overflow-auto rounded-md bg-muted/60 px-3 py-2">
              <Markdown text={summary.replace(/^Proposed plan:\s*/, "")} className="text-[13px]" />
            </div>
          ) : (
            <pre className="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-3 py-2 font-mono text-[12.5px] leading-relaxed">
              {summary}
            </pre>
          )}
          {paths.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {paths.slice(0, 8).map((p) => (
                <span
                  key={p}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11.5px]"
                >
                  <FileCode2 className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {browser?.onlyLine ? (
          <p
            data-testid="approval-only"
            className="flex items-center gap-2 border-t px-4 py-3 text-muted-foreground text-sm"
          >
            <UserRound aria-hidden className="size-4 shrink-0" />
            {browser.onlyLine}
          </p>
        ) : decidable ? (
          denying ? (
            <form
              className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void decide("deny");
              }}
            >
              <Input
                autoFocus
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Tell the agent what to do instead (optional)"
                aria-label="Deny comment"
                data-testid="deny-comment"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDenying(false)}
                  className="max-md:h-11"
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={!!busy}
                  data-testid="confirm-deny"
                  className="max-md:h-11"
                >
                  {busy === "deny" ? <Spinner /> : null} Deny
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive max-md:h-11"
                onClick={() => setDenying(true)}
                disabled={!!busy}
                data-testid="deny"
              >
                Deny…
              </Button>
              <Button
                variant="outline"
                onClick={() => decide("session")}
                disabled={!!busy}
                data-testid="allow-session"
                className="max-md:h-11"
              >
                {busy === "session" ? <Spinner /> : null}{" "}
                {browser ? "For this session" : `Allow ${tool} for session`}
              </Button>
              <Button
                onClick={() => decide("once")}
                disabled={!!busy}
                data-testid="approve-once"
                className="max-md:h-11"
              >
                {busy === "once" ? <Spinner /> : null} Approve once
              </Button>
            </div>
          )
        ) : (
          <p className="border-t px-4 py-3 text-muted-foreground text-sm">{deciderHint}</p>
        )}
      </div>
    </div>
  );
}
