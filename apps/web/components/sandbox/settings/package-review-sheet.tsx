"use client";

import type {
  ReviewSandboxPackageRequest,
  SandboxPackage,
  SandboxPackageReview,
  SandboxPackageSource,
} from "@ocw/contracts";
import { Ban, Check, Copy, RefreshCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/components/chat/attachments/files";
import { ACK_PHRASE, RiskPanel } from "@/components/marketplace/plugin-review-sheet";
import { RiskBadge } from "@/components/marketplace/risk-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage, isApiError } from "@/lib/api";
import { refreshedReview, useApproveSandboxPackage, usePackageReview } from "@/lib/sandbox-packages-queries";

/**
 * The review of one pinned sandbox package release (07.8-23; D-03, D-11, P-12, UI-SPEC §4.4), in the layout and risk
 * vocabulary of `PluginReviewSheet`: name and exact version, source, publisher, license, size, the digest (copyable),
 * the install-script fact, how many dependencies are pinned with it, and the API's risk with every reason. Approve sends
 * the review token back; the API resolves the tree again and refuses anything that changed since (then the refreshed
 * review replaces this one). High risk needs the typed acknowledgement, Blocked has no action, and a release already
 * approved has nothing to approve. Registry text (names, licenses, publishers) is rendered as plain text only.
 */

export const SOURCE_LABEL: Record<SandboxPackageSource, string> = {
  npm: "npm",
  pypi: "PyPI",
  debian: "Debian",
  clawhub: "ClawHub skill",
};

/** How many dependencies are pinned with the package (P-12: the whole tree, each by its hash). */
export function dependencyLine(n: number): string {
  if (n === 0) return "No dependencies";
  if (n === 1) return "1 dependency, pinned by hash";
  return `${n} dependencies, each pinned by hash`;
}

export const CHANGED_UPSTREAM = {
  title: "This version changed upstream",
  description: "The review was refreshed. Check it again before approving.",
} as const;

export function approvedToast(name: string, version: string) {
  return `${name} ${version} approved. It installs in each bot's sandbox when it next starts.`;
}

export function PackageReviewSheet({
  request,
  live,
  onOpenChange,
}: {
  /** The release under review; null closes the sheet. */
  request: ReviewSandboxPackageRequest | null;
  /** The organization's live row of the same source and name, if any. */
  live: SandboxPackage | null;
  onOpenChange: (open: boolean) => void;
}) {
  const q = usePackageReview(request);
  const data = q.data;

  return (
    <Sheet open={request !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showClose={false}
        className="w-full max-w-full sm:w-[34rem]"
        data-testid="package-review-sheet"
        data-package={request?.name}
      >
        {data ? (
          <Review
            // A refreshed review (another digest or tree) starts the form again: a typed acknowledgement never carries over.
            key={`${data.source}/${data.name}@${data.version}#${data.sha256}:${data.treeSha256}`}
            review={data}
            live={live}
            onRefresh={() => void q.refetch()}
            onDone={() => onOpenChange(false)}
          />
        ) : q.isError ? (
          <div className="grid gap-3 px-5 py-6 pr-14">
            <SheetTitle className="font-mono">{request?.name}</SheetTitle>
            <p className="text-muted-foreground text-sm" role="alert">
              {isApiError(q.error, 503)
                ? `Couldn't reach ${request ? SOURCE_LABEL[request.source] : "the registry"}. Try again.`
                : errorMessage(q.error)}
            </p>
            <Button variant="outline" className="w-fit max-md:h-11" onClick={() => void q.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 px-5 py-6 pr-14" aria-busy>
            <SheetTitle className="sr-only">Reviewing package</SheetTitle>
            <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
            <Skeleton className="h-48 rounded-xl motion-reduce:animate-none" />
            <Skeleton className="h-28 rounded-xl motion-reduce:animate-none" />
          </div>
        )}
        {/* The sheet's own close, a 44 px target on phones (the primitive's is 32 px). */}
        <SheetClose
          aria-label="Close"
          className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:top-1.5 max-md:right-1 max-md:size-11"
        >
          <X className="size-4" />
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

function Review({
  review,
  live,
  onRefresh,
  onDone,
}: {
  review: SandboxPackageReview;
  live: SandboxPackage | null;
  onRefresh: () => void;
  onDone: () => void;
}) {
  const approve = useApproveSandboxPackage();
  const [ack, setAck] = useState("");
  const ackId = useId();
  const high = review.risk === "high";
  const acknowledged = ack.trim().toLowerCase() === ACK_PHRASE;
  const coords = `${review.name}@${review.version}`;
  const mode: "blocked" | "current" | "approve" =
    review.risk === "refuse"
      ? "blocked"
      : live && live.version === review.version && !live.changedUpstream
        ? "current"
        : "approve";

  async function submit() {
    if (high && !acknowledged) return;
    try {
      await approve.mutateAsync({
        reviewToken: review.reviewToken,
        ...(high ? { acknowledge: ACK_PHRASE } : {}),
      });
      toast.success(approvedToast(review.name, review.version));
      onDone();
    } catch (err) {
      if (isApiError(err, 409) && err.code === "package_changed_upstream") {
        toast.error(CHANGED_UPSTREAM.title, { description: CHANGED_UPSTREAM.description });
        // The 409 carries the refreshed review (already in the cache); without it, review again.
        if (!refreshedReview(err)) onRefresh();
        return;
      }
      if (isApiError(err, 403) && err.code === "package_refused") onRefresh();
      toast.error("Could not approve the package", { description: errorMessage(err) });
    }
  }

  return (
    <>
      {/* ---- header */}
      <div className="flex items-start gap-3 border-b px-5 py-4 pr-14">
        <div className="min-w-0 flex-1">
          <SheetTitle className="break-all font-mono font-semibold text-lg leading-snug">
            {review.name}
          </SheetTitle>
          <p
            className="break-all font-mono text-muted-foreground text-xs"
            data-testid="package-review-version"
          >
            {review.version}
          </p>
          <SheetDescription
            render={<div />}
            className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs"
          >
            <RiskBadge level={review.risk} />
            <Badge variant="outline">{SOURCE_LABEL[review.source]}</Badge>
            <span className="text-muted-foreground">Pinned to this exact version</span>
          </SheetDescription>
        </div>
      </div>

      {/* ---- body */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 px-5 py-5">
          <PackageFacts review={review} />

          <RiskPanel
            level={review.risk}
            reasons={review.riskReasons.map((message, i) => ({ code: `reason-${i}`, message }))}
            testId="package-risk"
          />

          {mode === "approve" ? (
            <div className="grid gap-3">
              <p
                className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-[13px] leading-snug"
                data-testid="package-trust-note"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                It installs in each bot's sandbox when it next starts, never in the bot runtime. Only approve
                packages you trust.
              </p>
              {high ? (
                <div className="grid gap-1.5">
                  <label htmlFor={ackId} className="font-medium text-sm">
                    Type <span className="font-mono text-destructive">{ACK_PHRASE}</span> to confirm
                  </label>
                  <Input
                    id={ackId}
                    value={ack}
                    onChange={(e) => setAck(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="package-ack"
                    aria-describedby={`${ackId}-hint`}
                    className="font-mono text-[13px] max-md:h-11"
                  />
                  <span id={`${ackId}-hint`} className="text-muted-foreground text-xs">
                    You accept the risks listed above for every bot's sandbox.
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ---- footer */}
      <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
        {mode === "blocked" ? (
          <p
            className="mr-auto flex items-center gap-2 font-medium text-destructive text-sm"
            data-testid="package-blocked"
          >
            <Ban className="size-4 shrink-0" aria-hidden />
            Blocked: this version can't be installed
          </p>
        ) : mode === "current" ? (
          <p className="mr-auto flex items-center gap-2 text-sm" data-testid="package-current">
            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
            This version is already approved.
          </p>
        ) : (
          <>
            <Button variant="outline" onClick={onDone} disabled={approve.isPending} className="max-md:h-11">
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={approve.isPending || (high && !acknowledged)}
              variant={high ? "destructive" : "default"}
              data-testid="package-approve"
              className="max-w-full max-md:h-11"
            >
              {approve.isPending ? <Spinner /> : null}
              <span className="truncate">Approve {coords}</span>
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/** The facts of one release, as plain text (registry metadata is untrusted). */
export function PackageFacts({ review }: { review: SandboxPackageReview }) {
  const { copy, copied } = useCopy();
  const digest = `sha256:${review.sha256}`;
  return (
    <dl
      className="grid gap-x-4 gap-y-2.5 rounded-xl border bg-card p-3.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]"
      data-testid="package-facts"
    >
      <Fact label="Source">{SOURCE_LABEL[review.source]}</Fact>
      <Fact label="Publisher" testId="package-publisher">
        {review.publisher ?? <span className="text-muted-foreground">Unknown</span>}
      </Fact>
      <Fact label="License" testId="package-license">
        {review.license ?? <span className="text-muted-foreground">Not declared</span>}
      </Fact>
      <Fact label="Size">
        <span className="font-mono text-xs">{formatBytes(review.sizeBytes)}</span>
      </Fact>
      <Fact label="Digest" testId="package-digest">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-xs" title={digest} data-testid="package-digest-value">
            sha256:{review.sha256.slice(0, 12)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copy(digest)}
            className="-my-1 h-7 px-2 text-xs max-md:h-11"
            data-testid="package-digest-copy"
          >
            {copied === digest ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied === digest ? "Copied" : "Copy digest"}
          </Button>
        </span>
      </Fact>
      <Fact label="Dependencies" testId="package-dependencies">
        {dependencyLine(review.dependencyCount)}
      </Fact>
      <Fact label="Install script" testId="package-install-script">
        {review.hasInstallScript ? (
          <span className="font-medium text-amber-800 dark:text-amber-300">
            Runs an install script inside the sandbox
          </span>
        ) : (
          "No install script"
        )}
      </Fact>
    </dl>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-muted-foreground text-xs sm:pt-px sm:text-[13px]">{label}</dt>
      <dd className="-mt-1.5 min-w-0 break-words sm:mt-0" data-testid={testId}>
        {children}
      </dd>
    </>
  );
}
