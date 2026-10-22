"use client";

import type { SandboxIsolationInfo } from "@ocw/contracts";
import { Container } from "lucide-react";
import { useId, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { isolationSentence, isolationVariant, unavailableReason } from "./isolation-card";

/**
 * The organization switch (07.8-19; D-12, P-02): Sandbox & Browser on or off for the whole organization, off by
 * default. While it is off nothing runs anywhere, whatever the modules and each bot's own switches say. Turning it on
 * asks first, with the isolation sentence of the server in use (U-12, T-07.8-19-04); turning it off applies at once.
 * When the server cannot run sandboxes (service down, Docker too old) turning it on is disabled with the reason in
 * visible text; an organization that is already on can still turn it off. The dialog opens on Cancel: it reaches
 * every bot of the organization.
 */

export const TURN_ON_TITLE = "Turn on Sandbox & Browser for the organization?";

/** The turn-on dialog's paragraphs: the UI-SPEC's Sandbox and Browser bodies joined, then the isolation (P-02). */
export function turnOnBody(isolation: SandboxIsolationInfo): string[] {
  const sentence = isolationSentence(isolation);
  return [
    "Bots used by everyone in the organization can keep files and run commands in their own isolated sandbox, and open web pages in a real browser that people can watch and sign in to.",
    "Some sites don't allow automated browsers; you're responsible for following their terms.",
    ...(sentence ? [sentence] : []),
    "Each bot still needs its own Sandbox or Browser switch, turned on by whoever configures it.",
  ];
}

const OFF_LINE = "Off by default. While it's off, no bot in the organization gets a sandbox or a browser.";
const ON_LINE =
  "Bots get a sandbox or a browser once their own switch is on. Teams can be left out in Settings › Modules.";

export function OrgSwitchCard({
  enabled,
  isolation,
  pending,
  onChange,
}: {
  enabled: boolean;
  isolation: SandboxIsolationInfo;
  pending: boolean;
  /** Saves the switch; resolves true when the API accepted it. */
  onChange: (enabled: boolean) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const reasonId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reason = enabled ? null : unavailableReason(isolation);
  const hardened = isolationVariant(isolation) === "hardened";

  return (
    <section
      data-testid="org-switch"
      data-enabled={enabled ? "on" : "off"}
      aria-labelledby={titleId}
      className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
      >
        <Container className="size-[18px]" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="font-semibold text-[15px] leading-5 tracking-tight">
          Sandbox & Browser for the organization
        </h2>
        <p className="mt-1 text-muted-foreground text-sm" data-testid="org-switch-line">
          {enabled ? ON_LINE : OFF_LINE}
        </p>
        {reason ? (
          <p
            id={reasonId}
            className="mt-1.5 text-red-700 text-xs dark:text-red-300"
            data-testid="org-switch-reason"
          >
            {reason}
          </p>
        ) : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2">
        {pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        <span className={cn("text-xs", enabled ? "font-semibold text-foreground" : "text-muted-foreground")}>
          {enabled ? "On" : "Off"}
        </span>
        <Switch
          checked={enabled}
          disabled={pending || reason !== null}
          onCheckedChange={(on) => {
            if (on) setConfirming(true);
            else void onChange(false);
          }}
          aria-label="Sandbox & Browser for the organization"
          aria-describedby={reason ? reasonId : undefined}
          data-testid="org-switch-toggle"
          // A 44 px hit area around the 36 × 20 track (390), as on the module rows.
          className="after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']"
        />
      </div>

      <Dialog open={confirming} onOpenChange={(open) => !open && !pending && setConfirming(false)}>
        <DialogContent data-testid="org-switch-dialog" initialFocus={cancelRef} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="break-words">{TURN_ON_TITLE}</DialogTitle>
            <DialogDescription render={<div />} className="grid gap-2">
              {turnOnBody(isolation).map((p) =>
                p === isolationSentence(isolation) ? (
                  <span
                    key={p}
                    data-testid="org-switch-isolation"
                    className={cn(
                      "block rounded-lg border px-3 py-2",
                      hardened
                        ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
                        : "bg-muted/50 text-foreground",
                    )}
                  >
                    {p}
                  </span>
                ) : (
                  <span key={p} className="block">
                    {p}
                  </span>
                ),
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={cancelRef}
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="max-md:h-11"
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (await onChange(true)) setConfirming(false);
              }}
              disabled={pending}
              className="max-md:h-11"
              data-testid="org-switch-confirm"
            >
              {pending ? <Spinner /> : null}
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
