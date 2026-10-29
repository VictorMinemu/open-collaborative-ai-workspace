"use client";

import { SignInRequest } from "@ocw/contracts";
import { Mail } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthCard, AuthCardSkeleton } from "@/components/auth/auth-card";
import { ForgotPasswordDialog } from "@/components/auth/forgot-password-dialog";
import { PasswordInput } from "@/components/auth/password-input";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuthCapabilities } from "@/lib/account-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { type FieldErrors, validate } from "@/lib/form";
import { signedInMe, useMe, useSetupStatus, useSignIn } from "@/lib/queries";
import { safeNext } from "@/lib/safe-next";

type Field = "email" | "password";

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const status = useSetupStatus();
  const me = useMe();
  const signIn = useSignIn();
  // Prefetched so "Forgot password?" opens on the right branch (e-mail vs ask an admin) at once.
  useAuthCapabilities();
  const [forgotOpen, setForgotOpen] = useState(false);
  const [values, setValues] = useState<Record<Field, string>>({ email: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Already signed in → straight to the app. Fresh server → first-run setup. A cached `/me` of a session that
  // ended (401) is not signed in: the app would send this page straight back here.
  const signedIn = signedInMe(me) !== null;
  useEffect(() => {
    if (signedIn) router.replace(next);
  }, [signedIn, next, router]);
  useEffect(() => {
    if (status.data && !status.data.setupComplete) router.replace("/setup");
  }, [status.data, router]);

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setFormError(null);
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(SignInRequest, values);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    try {
      await signIn.mutateAsync(result.data);
      router.replace(next);
    } catch (err) {
      if (isApiError(err) && (err.status === 401 || err.status === 400)) {
        setFormError("Incorrect email or password.");
      } else {
        toast.error("Could not sign in", { description: errorMessage(err) });
      }
    }
  }

  if (status.isPending || (status.data && !status.data.setupComplete) || signedIn) {
    return <AuthCardSkeleton />;
  }

  if (status.isError) {
    return (
      <AuthCard title="Sign in">
        <ServerUnreachable onRetry={() => status.refetch()} retrying={status.isFetching} className="py-2" />
      </AuthCard>
    );
  }

  const pending = signIn.isPending;

  return (
    <AuthCard
      title="Welcome back"
      description="Sign in to your workspace."
      footer={
        <span className="inline-flex items-center gap-1.5">
          <Mail className="size-3.5" />
          New here? Ask an admin for an invitation.
        </span>
      }
    >
      <form data-testid="login-form" onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-sm"
          >
            {formError}
          </div>
        ) : null}

        <FormField id="email" label="Email" error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            value={values.email}
            onChange={set("email")}
            aria-invalid={!!errors.email}
            aria-describedby={describedBy("email", errors.email)}
            autoFocus
          />
        </FormField>

        <FormField
          id="password"
          label="Password"
          error={errors.password}
          action={
            <button
              type="button"
              data-testid="forgot-password"
              onClick={() => setForgotOpen(true)}
              className="rounded-sm font-medium text-[13px] text-muted-foreground underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              Forgot password?
            </button>
          }
        >
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            value={values.password}
            onChange={set("password")}
            aria-invalid={!!errors.password || !!formError}
            aria-describedby={describedBy("password", errors.password)}
          />
        </FormField>

        <Button type="submit" className="mt-2 w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <ForgotPasswordDialog open={forgotOpen} onOpenChange={setForgotOpen} defaultEmail={values.email} />
    </AuthCard>
  );
}
