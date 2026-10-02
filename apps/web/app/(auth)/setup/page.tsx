"use client";

import { SetupRequest } from "@ocw/contracts";
import { CheckCircle2, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { AuthCard, AuthCardSkeleton } from "@/components/auth/auth-card";
import { PasswordInput } from "@/components/auth/password-input";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { type FieldErrors, validate } from "@/lib/form";
import { useSetup, useSetupStatus } from "@/lib/queries";

type Field = "token" | "orgName" | "name" | "email" | "password";

export default function SetupPage() {
  const router = useRouter();
  const status = useSetupStatus();
  const setup = useSetup();
  const [values, setValues] = useState<Record<Field, string>>({
    token: "",
    orgName: "",
    name: "",
    email: "",
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((er) => ({ ...er, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(SetupRequest, values);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    try {
      await setup.mutateAsync(result.data);
      toast.success(`Welcome to ${result.data.orgName}`, { description: "Your workspace is ready." });
      router.replace("/chat");
    } catch (err) {
      if (isApiError(err, 401)) {
        setErrors({ token: "This setup token is not valid" });
      } else if (isApiError(err, 409)) {
        toast.error("This workspace is already set up", { description: "Sign in instead." });
        await status.refetch();
      } else {
        toast.error("Could not create the workspace", { description: errorMessage(err) });
      }
    }
  }

  if (status.isPending) return <AuthCardSkeleton />;

  if (status.isError) {
    return (
      <AuthCard title="Set up your workspace">
        <ServerUnreachable onRetry={() => status.refetch()} retrying={status.isFetching} className="py-2" />
      </AuthCard>
    );
  }

  if (status.data.setupComplete) {
    return (
      <AuthCard
        eyebrow={<CheckCircle2 className="size-6 text-success" />}
        title="This workspace is already set up"
        description="An owner has already created the organization on this server. Sign in, or ask an admin for an invitation."
      >
        <Link href="/login" className={buttonVariants({ className: "w-full" })}>
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  const pending = setup.isPending;

  return (
    <AuthCard
      eyebrow={
        <Badge variant="brand">
          <KeyRound /> First-run setup
        </Badge>
      }
      title="Set up your workspace"
      description="Create your organization and the owner account. This only happens once per server."
      footer={
        <>
          Already set up?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form data-testid="setup-form" onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormField
          id="token"
          label="Setup token"
          error={errors.token}
          hint={
            <>
              Printed by the server, from <code className="font-mono text-xs">OCW_SETUP_TOKEN</code>.
            </>
          }
        >
          <PasswordInput
            id="token"
            name="token"
            autoComplete="off"
            spellCheck={false}
            className="pr-10 font-mono"
            value={values.token}
            onChange={set("token")}
            aria-invalid={!!errors.token}
            aria-describedby={describedBy("token", errors.token, true)}
            autoFocus
          />
        </FormField>

        <FormField id="orgName" label="Organization name" error={errors.orgName}>
          <Input
            id="orgName"
            name="orgName"
            placeholder="Acme Inc."
            autoComplete="organization"
            value={values.orgName}
            onChange={set("orgName")}
            aria-invalid={!!errors.orgName}
            aria-describedby={describedBy("orgName", errors.orgName)}
          />
        </FormField>

        <Separator className="my-1" />

        <FormField id="name" label="Your name" error={errors.name}>
          <Input
            id="name"
            name="name"
            placeholder="Ada Lovelace"
            autoComplete="name"
            value={values.name}
            onChange={set("name")}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("name", errors.name)}
          />
        </FormField>

        <FormField id="email" label="Email" error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="ada@acme.com"
            autoComplete="email"
            value={values.email}
            onChange={set("email")}
            aria-invalid={!!errors.email}
            aria-describedby={describedBy("email", errors.email)}
          />
        </FormField>

        <FormField id="password" label="Password" error={errors.password} hint="At least 12 characters.">
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
          {pending ? "Creating workspace…" : "Create workspace"}
        </Button>
      </form>
    </AuthCard>
  );
}
