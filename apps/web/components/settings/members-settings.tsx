"use client";

import {
  CreateInvitationRequest,
  EventTypes,
  type Invitation,
  type Member,
  type OrgRole,
  topic,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Mail, Send, Trash2, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { UserAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage, isApiError } from "@/lib/api";
import { validate } from "@/lib/form";
import {
  queryKeys,
  useCreateInvitation,
  useInvitations,
  useMe,
  useMembers,
  useRevokeInvitation,
} from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn, formatDate, relativeTime } from "@/lib/utils";

const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, admin: 1, member: 2 };

export function MembersSettings() {
  const me = useMe();
  const qc = useQueryClient();
  const isAdmin = me.data?.organization.role === "owner" || me.data?.organization.role === "admin";
  const orgId = me.data?.organization.id ?? null;

  // Someone accepted an invitation → refresh both lists live.
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.type === EventTypes.memberJoined) {
      void qc.invalidateQueries({ queryKey: queryKeys.members });
      void qc.invalidateQueries({ queryKey: queryKeys.invitations });
    }
  });

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
      {isAdmin ? (
        <>
          <InviteSection />
          <PendingInvitations />
        </>
      ) : null}
      <MembersList currentUserId={me.data?.user.id} />
    </div>
  );
}

function Section({
  title,
  description,
  count,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  count?: number;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="grid gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
          {title}
          {count !== undefined ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </h2>
        {description ? <p className="mt-0.5 text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

// ---- invite ----

function InviteSection() {
  const create = useCreateInvitation();
  const { copy, copied } = useCopy();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<Invitation | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(CreateInvitationRequest, { email, role });
    if (result.errors) {
      setError(result.errors.email ?? result.errors.role);
      return;
    }
    try {
      const inv = await create.mutateAsync(result.data);
      setCreated(inv);
      setEmail("");
      toast.success(`Invitation created for ${inv.email}`);
    } catch (err) {
      if (isApiError(err, 409)) setError("This person is already a member or has a pending invitation");
      else toast.error("Could not create the invitation", { description: errorMessage(err) });
    }
  }

  async function onCopy(link: string) {
    try {
      await copy(link);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  }

  return (
    <Section title="Invite people" description="Create an invite link and share it with your teammate.">
      <div className="rounded-xl border bg-card p-4 shadow-xs">
        <form
          data-testid="invite-member-form"
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
        >
          <div className="grid flex-1 gap-1.5">
            <label htmlFor="invite-email" className="sr-only">
              Email
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@company.com"
                autoComplete="off"
                className="pl-9"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(undefined);
                }}
                aria-invalid={!!error}
                aria-describedby={error ? "invite-email-error" : undefined}
              />
            </div>
            {error ? (
              <p id="invite-email-error" role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Select value={role} onValueChange={(v) => v && setRole(v as "member" | "admin")}>
              <SelectTrigger aria-label="Role" data-testid="invite-role" className="w-28 sm:w-32" />
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={create.isPending} className="flex-1 sm:flex-none">
              {create.isPending ? <Spinner /> : <Send />}
              Invite
            </Button>
          </div>
        </form>

        {created ? (
          <div
            data-testid="invite-link-callout"
            className="mt-4 rounded-lg border border-primary/20 bg-brand-soft/60 p-3 animate-in fade-in-0 slide-in-from-top-1"
          >
            <div className="mb-2 flex items-center gap-2 text-sm">
              <Link2 className="size-4 text-brand-soft-foreground" />
              <span>
                Share this link with <span className="font-medium">{created.email}</span>
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                readOnly
                value={created.link}
                data-testid="invite-link"
                aria-label="Invite link"
                onFocus={(e) => e.currentTarget.select()}
                className="bg-background font-mono text-xs"
              />
              <Button
                variant="outline"
                onClick={() => onCopy(created.link)}
                data-testid="copy-invite-link"
                className="shrink-0"
              >
                {copied === created.link ? <Check className="text-success" /> : <Copy />}
                {copied === created.link ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-2 text-muted-foreground text-xs">Expires {relativeTime(created.expiresAt)}.</p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function PendingInvitations() {
  const invitations = useInvitations();
  const revoke = useRevokeInvitation();
  const { copy, copied } = useCopy();
  const pending = (invitations.data?.invitations ?? []).filter((i) => i.status === "pending");

  async function onRevoke(inv: Invitation) {
    try {
      await revoke.mutateAsync(inv.id);
      toast.success(`Invitation for ${inv.email} revoked`);
    } catch (err) {
      toast.error("Could not revoke the invitation", { description: errorMessage(err) });
    }
  }

  return (
    <Section
      title="Pending invitations"
      count={invitations.data ? pending.length : undefined}
      testId="pending-invitations"
    >
      {invitations.isPending ? (
        <ListSkeleton rows={2} />
      ) : invitations.isError ? (
        <ListError
          error={invitations.error}
          onRetry={() => invitations.refetch()}
          retrying={invitations.isFetching}
        />
      ) : pending.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          No pending invitations.
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {pending.map((inv) => {
            const expired = new Date(inv.expiresAt).getTime() < Date.now();
            return (
              <li key={inv.id} data-testid="pending-invitation" className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                  <Mail className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{inv.email}</div>
                  <div className={cn("text-xs", expired ? "text-destructive" : "text-muted-foreground")}>
                    {expired ? "Expired" : `Expires ${relativeTime(inv.expiresAt)}`}
                  </div>
                </div>
                <RoleBadge role={inv.role} />
                <div className="flex items-center gap-0.5">
                  <Tooltip content={copied === inv.link ? "Copied" : "Copy invite link"}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Copy invite link for ${inv.email}`}
                      onClick={() => copy(inv.link).then(() => toast.success("Invite link copied"))}
                    >
                      {copied === inv.link ? <Check className="text-success" /> : <Copy />}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Revoke">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revoke invitation for ${inv.email}`}
                      data-testid="revoke-invitation"
                      disabled={revoke.isPending && revoke.variables === inv.id}
                      onClick={() => onRevoke(inv)}
                      className="hover:bg-destructive/10 hover:text-destructive"
                    >
                      {revoke.isPending && revoke.variables === inv.id ? <Spinner /> : <Trash2 />}
                    </Button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---- members ----

function MembersList({ currentUserId }: { currentUserId: string | undefined }) {
  const members = useMembers();
  const list = [...(members.data?.members ?? [])].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName),
  );

  return (
    <Section title="Members" count={members.data ? list.length : undefined} testId="members-list">
      {members.isPending ? (
        <ListSkeleton rows={3} />
      ) : members.isError ? (
        <ListError error={members.error} onRetry={() => members.refetch()} retrying={members.isFetching} />
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          <UserPlus className="mx-auto mb-2 size-5" />
          No members yet.
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {list.map((m) => (
            <MemberRow key={m.userId} member={m} isYou={m.userId === currentUserId} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function MemberRow({ member, isYou }: { member: Member; isYou: boolean }) {
  return (
    <li data-testid="member-row" className="flex items-center gap-3 px-4 py-3">
      <UserAvatar name={member.displayName} src={member.avatarUrl} seed={member.userId} className="size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{member.displayName}</span>
          {isYou ? (
            <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground uppercase tracking-wide">
              You
            </span>
          ) : null}
        </div>
        <div className="truncate text-muted-foreground text-xs">{member.email ?? "—"}</div>
      </div>
      <span className="hidden text-muted-foreground text-xs sm:block">
        Joined {formatDate(member.joinedAt)}
      </span>
      <RoleBadge role={member.role} />
    </li>
  );
}

function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <Badge variant={role === "member" ? "outline" : "brand"} className="w-16 capitalize">
      {role}
    </Badge>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-14" />
        </div>
      ))}
    </div>
  );
}

function ListError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  if (isApiError(error) && !error.isNetwork) {
    return (
      <div
        role="alert"
        className="rounded-xl border bg-card px-4 py-6 text-center text-muted-foreground text-sm"
      >
        {errorMessage(error)}
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-card">
      <ServerUnreachable onRetry={onRetry} retrying={retrying} className="py-6" />
    </div>
  );
}
