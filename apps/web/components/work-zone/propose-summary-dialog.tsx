"use client";

import type { SessionMemorySummary } from "@ocw/contracts";
import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { MeteredBadge } from "@/components/bots/provider-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

/**
 * The consent before any Work Zone summary is written (Phase 07.6-22, AUTO-06, D-07; UI-SPEC Surface 9b): names the
 * model, METERED (or the person's plan) and who pays. `once` proposes this session (with an opt-in to do it
 * automatically from now on, unchecked); `auto` turns automatic proposals on. Focus starts on Cancel; below 640 it is
 * the bottom sheet the plain Dialog becomes, with 44 px buttons.
 */

export type ProposeDialogMode = "once" | "auto";
type Model = NonNullable<SessionMemorySummary["model"]>;

export const PROPOSE_COPY = {
  onceTitle: (unit: string) => `Propose a summary to ${unit} memory?`,
  onceBody: (unit: string) =>
    [
      "OCW writes a short summary of this session with",
      `and sends it to ${unit} memory for review. Nothing is saved until a reviewer approves it.`,
    ] as const,
  meteredNotice:
    "Billed to the organization and counted against your AI chat limits. Only repo-relative paths are sent.",
  planNotice: "Uses your ChatGPT plan. Only repo-relative paths are sent.",
  autoCheckbox: "Do this automatically for my finished sessions",
  onceSubmit: "Propose summary",
  autoTitle: "Propose summaries automatically?",
  autoBody: (payer: "you" | "the organization") =>
    `When one of your Work Zone sessions ends in a linked repository, OCW writes a summary and sends it for review. Each summary is one AI request billed to ${payer}.`,
  autoSubmit: "Turn on",
  cancel: "Cancel",
  /** The owner's default model could not be resolved (the job will say so if it still runs). */
  modelFallback: "your default model",
} as const;

/** Who an automatic summary is billed to: the person on their plan, the organization on its keys. */
export const payerOf = (model: Model | null): "you" | "the organization" =>
  model?.plan ? "you" : "the organization";

export function ProposeSummaryDialog({
  open,
  mode,
  unitName,
  model,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  mode: ProposeDialogMode;
  unitName: string;
  model: Model | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  /** `auto`: in `once` mode, the person also turned automatic proposals on. */
  onConfirm: (opts: { auto: boolean }) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [auto, setAuto] = useState(false);
  const checkboxId = useId();
  // The opt-in is unchecked each time the dialog opens (D-07: off by default).
  useEffect(() => {
    if (open) setAuto(false);
  }, [open]);

  const [lead, tail] = PROPOSE_COPY.onceBody(unitName);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent data-testid="propose-summary-dialog" data-mode={mode} initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>
            {mode === "once" ? PROPOSE_COPY.onceTitle(unitName) : PROPOSE_COPY.autoTitle}
          </DialogTitle>
        </DialogHeader>
        {mode === "once" ? (
          <DialogDescription render={<div />} className="grid gap-3">
            <p>
              {lead}{" "}
              <span className="inline-flex items-center gap-1.5 align-middle">
                <span className="font-medium text-foreground" data-testid="propose-summary-model">
                  {model?.label ?? PROPOSE_COPY.modelFallback}
                </span>
                {model?.metered ? <MeteredBadge /> : null}
              </span>{" "}
              {tail}
            </p>
            <p
              role="note"
              data-testid="propose-summary-notice"
              className="flex gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-foreground text-xs leading-relaxed"
            >
              <Info aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
              <span>{model?.plan ? PROPOSE_COPY.planNotice : PROPOSE_COPY.meteredNotice}</span>
            </p>
          </DialogDescription>
        ) : (
          <DialogDescription className="grid gap-3">
            <span>{PROPOSE_COPY.autoBody(payerOf(model))}</span>
          </DialogDescription>
        )}
        {mode === "once" ? (
          <label
            htmlFor={checkboxId}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm md:min-h-10"
          >
            <input
              id={checkboxId}
              type="checkbox"
              data-testid="propose-summary-auto"
              className="size-4 accent-primary"
              checked={auto}
              disabled={pending}
              onChange={(e) => setAuto(e.currentTarget.checked)}
            />
            {PROPOSE_COPY.autoCheckbox}
          </label>
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className="max-sm:h-11"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {PROPOSE_COPY.cancel}
          </Button>
          <Button
            data-testid="propose-summary-submit"
            className="max-sm:h-11"
            disabled={pending}
            onClick={() => onConfirm({ auto: mode === "auto" || auto })}
          >
            {pending ? <Spinner /> : null}
            {mode === "once" ? PROPOSE_COPY.onceSubmit : PROPOSE_COPY.autoSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
