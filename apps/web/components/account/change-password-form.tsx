"use client";

import { Password } from "@ocw/contracts";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useChangePassword } from "@/lib/account-queries";
import { errorMessage, isApiError } from "@/lib/api";
import type { FieldErrors } from "@/lib/form";

type Field = "currentPassword" | "newPassword" | "confirmPassword";
const EMPTY: Record<Field, string> = { currentPassword: "", newPassword: "", confirmPassword: "" };

function check(v: Record<Field, string>): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {};
  if (!v.currentPassword) errors.currentPassword = "Enter your current password";
  const pw = Password.safeParse(v.newPassword);
  if (!pw.success) errors.newPassword = pw.error.issues[0]?.message ?? "Use at least 12 characters";
  else if (v.newPassword === v.currentPassword)
    errors.newPassword = "Choose a password you haven't used here";
  if (!errors.newPassword && v.confirmPassword !== v.newPassword)
    errors.confirmPassword = "Passwords don't match";
  return errors;
}

/** D-04: a signed-in member changes their password with the current one. */
export function ChangePasswordForm() {
  const change = useChangePassword();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [revokeOthers, setRevokeOthers] = useState(true);

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = check(values);
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    try {
      await change.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: revokeOthers,
      });
      toast.success("Password updated", {
        description: revokeOthers ? "Your other sessions were signed out." : undefined,
      });
      setValues(EMPTY);
      setErrors({});
    } catch (err) {
      if (isApiError(err, 400) && err.code === "invalid_password") {
        setErrors({ currentPassword: "Current password is incorrect" });
      } else {
        toast.error("Could not update your password", { description: errorMessage(err) });
      }
    }
  }

  const pending = change.isPending;

  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">Password</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Choose a long password you don't use anywhere else.
        </p>
      </div>
      <form
        data-testid="change-password-form"
        onSubmit={onSubmit}
        noValidate
        className="grid gap-5 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
      >
        <FormField id="currentPassword" label="Current password" error={errors.currentPassword}>
          <PasswordInput
            id="currentPassword"
            name="currentPassword"
            autoComplete="current-password"
            value={values.currentPassword}
            onChange={set("currentPassword")}
            aria-invalid={!!errors.currentPassword}
            aria-describedby={describedBy("currentPassword", errors.currentPassword)}
          />
        </FormField>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            id="newPassword"
            className="content-start"
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
            />
          </FormField>
          <FormField
            id="confirmPassword"
            className="content-start"
            label="Confirm new password"
            error={errors.confirmPassword}
          >
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
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/50 px-3 py-2.5">
          <div className="grid gap-0.5">
            <Label htmlFor="revokeOthers">Sign out other sessions</Label>
            <p className="text-muted-foreground text-xs">Recommended if you think someone else knows it.</p>
          </div>
          <Switch
            id="revokeOthers"
            checked={revokeOthers}
            onCheckedChange={setRevokeOthers}
            aria-label="Sign out other sessions"
          />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {pending ? <Spinner /> : <KeyRound />}
            {pending ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </section>
  );
}
