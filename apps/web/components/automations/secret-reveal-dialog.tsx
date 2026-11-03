"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

const TOUCH = "max-md:h-11";

/**
 * The signing secret, once (07.6-18, D-07, R3, UI-SPEC Surface 3): after a webhook automation is created and after a
 * rotation. It cannot be dismissed (Escape, ✕, the backdrop) until "I've stored the secret in the other app" is
 * ticked, and says why when someone tries. The secret lives only in the caller's component state: `onDone` is where
 * the caller drops it, so after Done it is in neither the DOM nor React state. Focus starts on Copy.
 */
export function SecretRevealDialog({ secret, onDone }: { secret: string | null; onDone: () => void }) {
  const [stored, setStored] = useState(false);
  const [tried, setTried] = useState(false);
  const { copy, copied } = useCopy(2000);
  const copyRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = secret !== null;

  // A new secret (a rotation after a create) starts unticked again.
  useEffect(() => {
    if (secret !== null) {
      setStored(false);
      setTried(false);
    }
  }, [secret]);

  const done = () => {
    if (!stored) {
      setTried(true);
      return;
    }
    setStored(false);
    setTried(false);
    onDone();
  };

  const isCopied = secret !== null && copied === secret;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && done()}>
      <DialogContent
        initialFocus={copyRef}
        showClose={stored}
        data-testid="secret-reveal"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Copy your signing secret</DialogTitle>
          <DialogDescription>
            The other app signs each event with it. You won't see it again.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <label htmlFor={`${id}-secret`} className="font-medium text-sm">
            Signing secret
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`${id}-secret`}
              data-testid="secret-reveal-value"
              readOnly
              aria-readonly
              value={secret ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              className={cn("min-w-0 flex-1 bg-muted/40 font-mono text-[13px] dark:bg-input/20", TOUCH)}
            />
            <Button
              ref={copyRef}
              type="button"
              variant="outline"
              size="sm"
              data-testid="secret-reveal-copy"
              className={cn("sm:h-9", TOUCH)}
              onClick={() => {
                if (!secret) return;
                void copy(secret).then(
                  () => toast("Secret copied"),
                  () => undefined,
                );
              }}
            >
              {isCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          <span className="sr-only" aria-live="polite">
            {isCopied ? "Copied" : ""}
          </span>
        </div>
        <div className="grid gap-1">
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm md:min-h-0">
            <input
              type="checkbox"
              data-testid="secret-reveal-stored"
              required
              aria-required
              aria-describedby={tried && !stored ? `${id}-hint` : undefined}
              checked={stored}
              onChange={(e) => {
                setStored(e.target.checked);
                if (e.target.checked) setTried(false);
              }}
              className="size-4 shrink-0 accent-primary"
            />
            I've stored the secret in the other app
          </label>
          {tried && !stored ? (
            <p id={`${id}-hint`} role="alert" className="text-[13px] text-amber-800 dark:text-amber-200">
              Tick the box to close.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            data-testid="secret-reveal-done"
            aria-disabled={!stored || undefined}
            className={cn("aria-disabled:opacity-50", TOUCH, "max-sm:w-full")}
            onClick={done}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
