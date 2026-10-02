"use client";

import { AcceptInvitationRequest } from "@ocw/contracts";
import { Clock, MailX, UserCheck } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AuthCard, AuthCardSkeleton } from "@/components/auth/auth-card";
import { PasswordInput } from "@/components/auth/password-input";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { type FieldErrors, validate } from "@/lib/form";
import { useAcceptInvitation, usePublicInvitation } from "@/lib/queries";
import { initials } from "@/lib/utils";

type Field = "name" | "password";

export default function InvitePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const invitation = usePublicInvitation(id);
  const accept = useAcceptInvitation(id);
  const [values, setValues] = useState<Record<Field, string>>({ name: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(AcceptInvitationRequest, values);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    try {
      const me = await accept.mutateAsync(result.data);
      toast.success(`Welcome to ${me.organization.name}`);
      router.replace("/chat");
    } catch (err) {
      if (isApiError(err, 409) || isApiError(err, 410)) {
        await invitation.refetch();
        toast.error("This invitation can no longer be used", { description: errorMessage(err) });
      } else {
        toast.error("Could not join the workspace", { description: errorMessage(err) });
      }
    }
  }

  if (invitation.isPending) return <AuthCardSkeleton />;

  if (invitation.isError) {
    if (isApiError(invitation.error, 404) || isApiError(invitation.error, 400)) {
      return (
        <InviteState
          icon={<MailX className="size-6 text-muted-foreground" />}
          title="Invitation not found"
          description="This link is invalid or the invitation was revoked. Ask the person who invited you for a new link."
        />
      );
    }
    return (
      <AuthCard title="Join workspace">
        <ServerUnreachable
          onRetry={() => invitation.refetch()}
          retrying={invitation.isFetching}
          className="py-2"
        />
      </AuthCard>
    );
  }

  const inv = invitation.data;

  if (inv.expired) {
    return (
      <InviteState
        icon={<Clock className="size-6 text-warning" />}
        title="This invitation has expired"
        description={`Ask an admin of ${inv.organizationName} to send you a new invitation.`}
      />
    );
  }

  if (inv.status !== "pending") {
    const accepted = inv.status === "accepted";
    return (
      <InviteState
        icon={
          accepted ? (
            <UserCheck className="size-6 text-success" />
          ) : (
            <MailX className="size-6 text-muted-foreground" />
          )
        }
        title={accepted ? "Invitation already accepted" : "This invitation is no longer valid"}
        description={
          accepted
            ? `You already joined ${inv.organizationName}. Sign in to continue.`
            : `It was ${inv.status}. Ask an admin of ${inv.organizationName} for a new one.`
        }
        showSignIn={accepted}
      />
    );
  }

  const pending = accept.isPending;

  return (
    <AuthCard
      eyebrow={
        <div className="flex size-11 items-center justify-center rounded-xl bg-linear-to-br from-indigo-500 to-violet-600 font-semibold text-sm text-white shadow-indigo-500/25 shadow-md">
          {initials(inv.organizationName)}
        </div>
      }
      title={`Join ${inv.organizationName}`}
      description={
        <>
          {inv.inviterName ? (
            <>
              <span className="text-foreground">{inv.inviterName}</span> invited you
            </>
          ) : (
            "You've been invited"
          )}{" "}
          as <span className="text-foreground">{inv.email}</span>{" "}
          <Badge
            variant={inv.role === "member" ? "outline" : "brand"}
            className="ml-0.5 align-middle capitalize"
          >
            {inv.role}
          </Badge>
        </>
      }
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form data-testid="invite-form" onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormField id="email" label="Email">
          <Input id="email" value={inv.email} readOnly aria-readonly className="text-muted-foreground" />
        </FormField>

        <FormField id="name" label="Your name" error={errors.name}>
          <Input
            id="name"
            name="name"
            placeholder="Your full name"
            autoComplete="name"
            value={values.name}
            onChange={set("name")}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("name", errors.name)}
            autoFocus
          />
        </FormField>

        <FormField
          id="password"
          label="Choose a password"
          error={errors.password}
          hint="At least 12 characters."
        >
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            value={values.password}
            onChange={set("password")}
            aria-invalid={!!errors.password}
            aria-describedby={describedBy("password", errors.password, true)}
          />
        </FormField>

        <Button type="submit" className="mt-2 w-full" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Joining…" : `Join ${inv.organizationName}`}
        </Button>
      </form>
    </AuthCard>
  );
}

function InviteState({
  icon,
  title,
  description,
  showSignIn = true,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  showSignIn?: boolean;
}) {
  return (
    <AuthCard eyebrow={icon} title={title} description={description}>
      {showSignIn ? (
        <Link href="/login" className={buttonVariants({ variant: "outline", className: "w-full" })}>
          Go to sign in
        </Link>
      ) : null}
    </AuthCard>
  );
}
