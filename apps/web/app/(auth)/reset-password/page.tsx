"use client";

import { Password } from "@ocw/contracts";
import { KeyRound, LinkIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { toast } from "sonner";
import { AuthCard, AuthCardSkeleton } from "@/components/auth/auth-card";
import { PasswordInput } from "@/components/auth/password-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Spinner } from "@/components/ui/spinner";
import { useResetPassword } from "@/lib/account-queries";
import { errorMessage, isApiError } from "@/lib/api";
import type { FieldErrors } from "@/lib/form";

type Field = "newPassword" | "confirmPassword";

const INVALID_LINK = "This link is invalid or has expired. Ask an Organization Admin for a new one.";

/**
 * Landing page for e-mailed and admin-issued reset links (`/reset-password?token=…`). Better-auth's e-mail
 * callback appends `?error=INVALID_TOKEN` when the token is already gone.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const linkError = params.get("error");
  const [invalid, setInvalid] = useState(false);

  if (!token || linkError || invalid) return <InvalidLink />;
  return <ResetForm token={token} onInvalid={() => setInvalid(true)} />;
}

function ResetForm({ token, onInvalid }: { token: string; onInvalid: () => void }) {
  const router = useRouter();
  const reset = useResetPassword();
  const [values, setValues] = useState<Record<Field, string>>({ newPassword: "", confirmPassword: "" });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pw = Password.safeParse(values.newPassword);
    if (!pw.success) {
      setErrors({ newPassword: pw.error.issues[0]?.message ?? "Use at least 12 characters" });
      return;
    }
    if (values.confirmPassword !== values.newPassword) {
      setErrors({ confirmPassword: "Passwords don't match" });
      return;
    }
    try {
      await reset.mutateAsync({ token, newPassword: values.newPassword });
      toast.success("Password updated. Sign in with your new password.");
      // replace(): the used link leaves the history stack (T-02-14-01).
      router.replace("/login");
    } catch (err) {
      if (isApiError(err, 400) && (err.code === "invalid_token" || err.code === "validation_error")) {
        onInvalid();
      } else {
        toast.error("Could not reset your password", { description: errorMessage(err) });
      }
    }
  }

  const pending = reset.isPending;

  return (
    <AuthCard
      eyebrow={<IconTile />}
      title="Choose a new password"
      description="You will be signed out on every device, then sign in with your new password."
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form data-testid="reset-password-form" onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormField
          id="newPassword"
          label="New password"
          error={errors.newPassword}
          hint="At least 12 characters."
        >
          <PasswordInput
            id="newPassword"
            name="newPassword"
            autoComplete="new-password"
            value={values.newPassword}
            onChange={set("newPassword")}
            aria-invalid={!!errors.newPassword}
            aria-describedby={describedBy("newPassword", errors.newPassword, true)}
            autoFocus
          />
        </FormField>
        <FormField id="confirmPassword" label="Confirm new password" error={errors.confirmPassword}>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            autoComplete="new-password"
            value={values.confirmPassword}
            onChange={set("confirmPassword")}
            aria-invalid={!!errors.confirmPassword}
            aria-describedby={describedBy("confirmPassword", errors.confirmPassword)}
          />
        </FormField>
        <Button type="submit" className="mt-2 w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Updating…" : "Update password"}
        </Button>
      </form>
    </AuthCard>
  );
}

function IconTile({ broken = false }: { broken?: boolean }) {
  const Icon = broken ? LinkIcon : KeyRound;
  return (
    <div
      className={
        broken
          ? "flex size-11 items-center justify-center rounded-xl border bg-muted text-muted-foreground"
          : "flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
      }
    >
      <Icon className="size-5" />
    </div>
  );
}

function InvalidLink() {
  return (
    <AuthCard
      eyebrow={<IconTile broken />}
      title="This reset link can't be used"
      description={<span data-testid="reset-invalid">{INVALID_LINK}</span>}
    >
      <Link href="/login" className={buttonVariants({ variant: "outline", className: "w-full" })}>
        Go to sign in
      </Link>
    </AuthCard>
  );
}
