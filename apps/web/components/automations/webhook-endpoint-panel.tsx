"use client";

import type { Automation } from "@ocw/contracts";
import { ArrowRight, Check, ChevronDown, Copy, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/api";
import { RESULT_TONE } from "@/lib/automation-queries";
import {
  curlExample,
  deliveryView,
  graceText,
  type InboundErrors,
  type InboundValue,
  rejectionNotice,
  secretSetText,
  useRotateWebhookSecret,
  useWebhookEndpoint,
} from "@/lib/automation-trigger-queries";
import { useBoard } from "@/lib/board-queries";
import { cn, relativeTime } from "@/lib/utils";
import { InboundMapping } from "./inbound-mapping";
import { SecretRevealDialog } from "./secret-reveal-dialog";

const TOUCH = "max-md:h-11";

/**
 * The webhook of a saved automation (07.6-18, D-07, R3, R4, UI-SPEC Surface 3): the endpoint URL with copy, the
 * locked secret line (`Set {date} · shown once`) with Rotate for the owner, the 24 h grace line, How to send events,
 * the payload mapping with live values from the last delivery, the last deliveries and the latest rejection. The
 * secret is never part of this panel's data: a rotation's new secret goes straight into the reveal dialog's state and
 * is dropped on Done.
 */
export function WebhookEndpointPanel({
  automation: a,
  inbound,
  onInbound,
  errors,
  canRotate,
  disabled,
}: {
  automation: Automation;
  inbound: InboundValue;
  onInbound: (next: InboundValue) => void;
  errors: InboundErrors;
  canRotate: boolean;
  disabled: boolean;
}) {
  const ep = useWebhookEndpoint(a.id);
  const board = useBoard(a.target.kind === "board" ? a.target.conversationId : "", {
    enabled: a.target.kind === "board",
  });
  const rotate = useRotateWebhookSecret();
  const [confirm, setConfirm] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [howTo, setHowTo] = useState(false);
  const { copy, copied } = useCopy(2000);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  if (ep.isPending) {
    return (
      <div className="grid gap-3" data-testid="webhook-panel" aria-busy="true">
        <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-full motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-40 motion-reduce:animate-none" />
        <Skeleton className="h-24 w-full motion-reduce:animate-none" />
      </div>
    );
  }
  if (ep.isError || !ep.data) {
    return (
      <div
        data-testid="webhook-panel"
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-muted-foreground text-sm"
      >
        <span>Couldn't load the webhook.</span>
        <Button size="sm" variant="outline" className={TOUCH} onClick={() => void ep.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const e = ep.data;
  const notice = rejectionNotice(e);
  const snapshot = board.data?.board;
  const ctx = { prefix: snapshot?.prefix ?? null, namingRule: snapshot?.namingRule ?? null, automation: a };
  const curl = curlExample(e.url);

  async function doRotate() {
    try {
      const res = await rotate.mutateAsync(a.id);
      // The mutation is dropped from the cache at once; the secret lives only in the dialog's state.
      rotate.reset();
      setConfirm(false);
      setSecret(res.secret);
    } catch (err) {
      setConfirm(false);
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-5" data-testid="webhook-panel">
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-url`} className="font-medium text-sm">
          Endpoint URL
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`${id}-url`}
            data-testid="webhook-url"
            readOnly
            aria-readonly
            value={e.url}
            aria-describedby={`${id}-url-hint`}
            onFocus={(ev) => ev.currentTarget.select()}
            className={cn("min-w-0 flex-1 bg-muted/40 font-mono text-[13px] dark:bg-input/20", TOUCH)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Copy endpoint URL"
            data-testid="webhook-url-copy"
            className="shrink-0 max-md:size-11"
            onClick={() => void copy(e.url)}
          >
            {copied === e.url ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>
        <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
          Send POST requests here. Anyone with the URL can call it; only signed requests are accepted.
        </p>
      </div>

      <div className="grid gap-1.5">
        <span className="font-medium text-sm">Signing secret</span>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2 text-sm" data-testid="webhook-secret-line">
            <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {secretSetText(e.secretSetAt)}
          </p>
          {canRotate ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="webhook-rotate"
              className={cn("max-sm:w-full", TOUCH)}
              disabled={disabled || rotate.isPending}
              onClick={() => setConfirm(true)}
            >
              <RefreshCw aria-hidden /> Rotate secret
            </Button>
          ) : null}
        </div>
        {e.previousValidUntil ? (
          <p className="text-muted-foreground text-xs" data-testid="webhook-grace">
            {graceText(e.previousValidUntil)}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={howTo}
          aria-controls={`${id}-howto`}
          data-testid="webhook-howto-toggle"
          className={cn("-ml-2 justify-self-start", TOUCH)}
          onClick={() => setHowTo((v) => !v)}
        >
          <ChevronDown
            className={cn("transition-transform motion-reduce:transition-none", !howTo && "-rotate-90")}
          />
          How to send events
        </Button>
        {howTo ? (
          <div id={`${id}-howto`} className="grid gap-2" data-testid="webhook-howto">
            <p className="text-muted-foreground text-xs">
              Uses Standard Webhooks: send webhook-id, webhook-timestamp and webhook-signature headers. Most
              senders and libraries support it.
            </p>
            <div className="relative rounded-lg border bg-muted/50 dark:bg-white/[0.03]">
              <pre className="whitespace-pre-wrap break-all px-3 py-2.5 pr-12 font-mono text-[12px] leading-relaxed">
                {curl}
              </pre>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy example"
                className="absolute top-1.5 right-1.5 max-md:size-11"
                onClick={() => void copy(curl)}
              >
                {copied === curl ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </div>
          </div>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </div>

      <InboundMapping
        value={inbound}
        onChange={onInbound}
        errors={errors}
        payload={e.lastPayload}
        delivered={e.deliveries.length > 0}
        disabled={disabled}
      />

      <div className="grid gap-2" data-testid="webhook-deliveries">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm">Recent deliveries</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="webhook-refresh"
            className={TOUCH}
            disabled={ep.isFetching}
            onClick={() => void ep.refetch()}
          >
            {ep.isFetching ? <Spinner /> : <RefreshCw aria-hidden />}
            Refresh
          </Button>
        </div>
        {e.deliveries.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-muted-foreground text-xs">
            No deliveries yet. Send a test event from the other app.
          </p>
        ) : (
          <ul aria-label="Recent deliveries" className="divide-y overflow-hidden rounded-lg border">
            {e.deliveries.map((d) => {
              const v = deliveryView(d, ctx);
              const tone = RESULT_TONE[v.tone];
              return (
                <li
                  key={`${d.id}:${d.result}`}
                  data-testid="webhook-delivery"
                  data-result={d.result}
                  className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm"
                >
                  <div className="grid min-w-0 flex-1 gap-0.5 sm:flex sm:items-center sm:gap-3">
                    <span className="flex items-center gap-3 sm:contents">
                      <span className="w-20 shrink-0 text-muted-foreground text-xs" title={d.receivedAt}>
                        {relativeTime(d.receivedAt)}
                      </span>
                      <span className="flex w-24 shrink-0 items-center gap-1.5 text-xs">
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            v.label === "Duplicate"
                              ? "bg-transparent ring-1 ring-muted-foreground"
                              : tone.dot,
                          )}
                        />
                        <span className={cn("font-semibold", tone.text)}>{v.label}</span>
                      </span>
                    </span>
                    <span className="min-w-0 text-[13px] sm:truncate" data-testid="webhook-delivery-text">
                      {v.text}
                    </span>
                  </div>
                  {v.href ? (
                    <Link
                      href={v.href}
                      aria-label={`Open: ${v.text}`}
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:size-11"
                    >
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {notice ? (
        <p
          role="note"
          data-testid="webhook-rejection"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-xs dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{notice}</span>
        </p>
      ) : null}

      <Dialog open={confirm} onOpenChange={(o) => !o && !rotate.isPending && setConfirm(false)}>
        <DialogContent initialFocus={cancelRef} data-testid="webhook-rotate-dialog">
          <DialogHeader>
            <DialogTitle>Rotate the signing secret?</DialogTitle>
            <DialogDescription>
              You get a new secret now. The current one keeps working for 24 hours so you can update the other
              app.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={cancelRef}
              variant="outline"
              className={TOUCH}
              disabled={rotate.isPending}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              className={TOUCH}
              data-testid="webhook-rotate-confirm"
              disabled={rotate.isPending}
              onClick={() => void doRotate()}
            >
              {rotate.isPending ? <Spinner /> : null}
              Rotate secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SecretRevealDialog secret={secret} onDone={() => setSecret(null)} />
    </div>
  );
}
