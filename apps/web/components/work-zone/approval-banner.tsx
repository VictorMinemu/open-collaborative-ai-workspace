"use client";

import type { WorkApproval } from "@ocw/contracts";
import { FileCode2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { useResolveApproval } from "@/lib/workzone-queries";
import { Markdown } from "./markdown";

/** Sticky banner for the oldest pending approval: Approve once / Allow for session / Deny with comment. */
export function ApprovalBanner({
  sessionId,
  approval,
  pendingCount,
  canDecide,
  agentLabel,
  deciderHint,
}: {
  sessionId: string;
  approval: WorkApproval;
  pendingCount: number;
  canDecide: boolean;
  agentLabel: string;
  deciderHint: string;
}) {
  const resolve = useResolveApproval(sessionId);
  const [denying, setDenying] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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
  return (
    <div
      data-testid="approval-banner"
      className="mx-auto w-full max-w-3xl px-4 sm:px-6"
      role="alertdialog"
      aria-label={`${agentLabel} wants to use ${tool}`}
    >
      <div className="overflow-hidden rounded-xl border border-warning/50 bg-card shadow-lg shadow-warning/5">
        <div className="flex items-start gap-3 bg-warning/10 px-4 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/20 text-warning">
            <ShieldAlert className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">
              {tool === "ExitPlanMode" ? (
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
        {canDecide ? (
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
                <Button type="button" variant="ghost" onClick={() => setDenying(false)}>
                  Back
                </Button>
                <Button type="submit" variant="destructive" disabled={!!busy} data-testid="confirm-deny">
                  {busy === "deny" ? <Spinner /> : null} Deny
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
              >
                {busy === "session" ? <Spinner /> : null} Allow {tool} for session
              </Button>
              <Button onClick={() => decide("once")} disabled={!!busy} data-testid="approve-once">
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
