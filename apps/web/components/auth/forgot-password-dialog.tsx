"use client";

import { RequestPasswordResetRequest } from "@ocw/contracts";
import { MailCheck, ShieldQuestion } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useAuthCapabilities, useRequestPasswordReset } from "@/lib/account-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { validate } from "@/lib/form";

/**
 * "Forgot password?" from the login page. With SMTP the user asks for an e-mail (same answer for every
 * address: no account enumeration, T-02-14-02); without it, an Organization Admin issues a one-time link.
 */
export function ForgotPasswordDialog({
  open,
  onOpenChange,
  defaultEmail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultEmail: string;
}) {
  const capabilities = useAuthCapabilities();
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState(defaultEmail);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail);
    setError(undefined);
    setSent(false);
    request.reset();
  }, [open, defaultEmail, request.reset]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(RequestPasswordResetRequest, { email });
    if (result.errors) {
      setError(result.errors.email);
      return;
    }
    try {
      await request.mutateAsync(result.data);
      setSent(true);
    } catch (err) {
      setError(isApiError(err, 429) ? "Too many requests. Wait a minute and try again." : errorMessage(err));
    }
  }

  const byEmail = capabilities.data?.passwordResetEmail === true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="forgot-password-dialog">
        {capabilities.isPending ? (
          <div className="grid gap-3" aria-busy>
            <Skeleton className="size-10 rounded-xl" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : byEmail && sent ? (
          <>
            <DialogHeader>
              <Tile icon={<MailCheck className="size-5" />} />
              <DialogTitle>Check your inbox</DialogTitle>
              <DialogDescription data-testid="forgot-sent">
                If an account exists for that email, we sent a link.
              </DialogDescription>
            </DialogHeader>
            <p className="text-muted-foreground text-sm">
              The link works once and expires soon. Nothing arrived? Check spam, or ask an Organization Admin
              to create a reset link for you.
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Back to sign in</Button>
            </DialogFooter>
          </>
        ) : byEmail ? (
          <form onSubmit={onSubmit} noValidate className="grid gap-5">
            <DialogHeader>
              <Tile icon={<ShieldQuestion className="size-5" />} />
              <DialogTitle>Reset your password</DialogTitle>
              <DialogDescription>
                Enter your work email and we'll send you a link to choose a new one.
              </DialogDescription>
            </DialogHeader>
            <FormField id="forgot-email" label="Email" error={error}>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(undefined);
                }}
                aria-invalid={!!error}
                aria-describedby={describedBy("forgot-email", error)}
                autoFocus
              />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={request.isPending}>
                {request.isPending ? <Spinner /> : null}
                Send reset link
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <Tile icon={<ShieldQuestion className="size-5" />} />
              <DialogTitle>Reset your password</DialogTitle>
              <DialogDescription data-testid="forgot-ask-admin">
                Ask an Organization Admin to create a reset link for you.
              </DialogDescription>
            </DialogHeader>
            <ol className="grid gap-2 rounded-lg bg-muted/50 p-3 text-sm">
              <Step n={1}>An admin opens Settings › Members and creates a reset link for you.</Step>
              <Step n={2}>Open the link they send you. It works once and expires after 24 hours.</Step>
              <Step n={3}>Choose a new password and sign in.</Step>
            </ol>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Got it</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Tile({ icon }: { icon: ReactNode }) {
  return (
    <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
      {icon}
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-background font-medium text-[11px] text-muted-foreground tabular-nums ring-1 ring-border">
        {n}
      </span>
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}
