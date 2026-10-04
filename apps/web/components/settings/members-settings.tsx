"use client";

import {
  CreateInvitationRequest,
  EventTypes,
  INVITABLE_ROLES,
  type Invitation,
  type OrgRole,
  ROLE_LABELS,
  topic,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, Check, Copy, Link2, Mail, Send, Sparkles, Trash2, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { useIsDesktop } from "@/hooks/use-media-query";
import { errorMessage, isApiError } from "@/lib/api";
import { validate } from "@/lib/form";
import { memberKeys, useMemberDetails } from "@/lib/member-queries";
import { usePermissionCheck, usePermissions } from "@/lib/permissions";
import { queryKeys, useCreateInvitation, useInvitations, useMe, useRevokeInvitation } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import { cn, relativeTime } from "@/lib/utils";
import { MemberRow, RoleBadge } from "./member-row";
import { RoleReferenceSheet } from "./role-reference-sheet";

const ROLE_ORDER: Record<OrgRole, number> = { admin: 0, lead: 1, developer: 2, standard: 3 };

/**
 * Settings › Members (ORG-04, ORG-06). Every control follows the API resolver: the invite form needs
 * `invitation.create` and offers the inviter's role ceiling, pending invitations need `invitation.read`
 * with Revoke per `viewerCan`, and role changes need `member.manage`. The API re-decides every action.
 */
export function MembersSettings() {
  const me = useMe();
  const qc = useQueryClient();
  const perms = usePermissions();
  const can = usePermissionCheck();
  const orgId = me.data?.organization.id ?? null;
  const inviteRoles = perms.data ? INVITABLE_ROLES[perms.data.role] : [];
  const canInvite = can("invitation.create") && inviteRoles.length > 0;
  const inviteInputRef = useRef<HTMLInputElement>(null);

  // Someone joined, or a member's role / status / profile changed → refresh the lists live.
  useTopic(orgId ? topic("org", orgId) : null, (frame) => {
    if (frame.type === EventTypes.memberJoined) {
      void qc.invalidateQueries({ queryKey: memberKeys.all });
      void qc.invalidateQueries({ queryKey: queryKeys.invitations });
    } else if (frame.type === EventTypes.memberUpdated) {
      void qc.invalidateQueries({ queryKey: memberKeys.all });
    }
  });

  const focusInvite = () => {
    inviteInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    inviteInputRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
      {canInvite ? <InviteSection roles={inviteRoles} inputRef={inviteInputRef} /> : null}
      {can("invitation.read") ? <PendingInvitations /> : null}
      <MembersList
        currentUserId={me.data?.user.id}
        canManage={can("member.manage")}
        canInvite={canInvite}
        onInvite={focusInvite}
      />
    </div>
  );
}

function Section({
  title,
  description,
  count,
  actions,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
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
        {actions ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---- invite ----

function InviteSection({
  roles,
  inputRef,
}: {
  roles: OrgRole[];
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const create = useCreateInvitation();
  const { copy, copied } = useCopy();
  const items = roles.map((value) => ({ value, label: ROLE_LABELS[value] }));
  const fallbackRole: OrgRole = roles.includes("developer") ? "developer" : (roles[0] ?? "developer");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>(fallbackRole);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<Invitation | null>(null);
  // The ceiling can shrink live (a role change): never submit a role the inviter no longer offers.
  const effectiveRole = roles.includes(role) ? role : fallbackRole;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validate(CreateInvitationRequest, { email, role: effectiveRole });
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
                ref={inputRef}
                id="invite-email"
                type="email"
                placeholder="teammate@company.com"
                autoComplete="off"
                className="h-10 pl-9 sm:h-9"
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
            <Select items={items} value={effectiveRole} onValueChange={(v) => v && setRole(v)}>
              <SelectTrigger aria-label="Role" data-testid="invite-role" className="h-10 w-44 sm:h-9" />
              <SelectContent>
                {items.map((r) => (
                  <SelectItem key={r.value} value={r.value} data-testid="invite-role-option">
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={create.isPending} className="h-10 flex-1 sm:h-9 sm:flex-none">
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
        <ListSkeleton rows={1} />
      ) : invitations.isError ? (
        <ListError
          error={invitations.error}
          onRetry={() => invitations.refetch()}
          retrying={invitations.isFetching}
        />
      ) : pending.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-5 text-center text-muted-foreground text-sm">
          No pending invitations.
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {pending.map((inv) => {
            const expired = new Date(inv.expiresAt).getTime() < Date.now();
            const canRevoke = inv.viewerCan?.includes("invitation.revoke") ?? false;
            return (
              <li
                key={inv.id}
                data-testid="pending-invitation"
                data-email={inv.email}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                  <Mail className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{inv.email}</div>
                  <div className={cn("text-xs", expired ? "text-destructive" : "text-muted-foreground")}>
                    {expired ? "Expired" : `Expires ${relativeTime(inv.expiresAt)}`}
                  </div>
                </div>
                <RoleBadge role={inv.role} className="hidden sm:inline-flex" />
                <div className="flex items-center gap-0.5">
                  <Tooltip content={copied === inv.link ? "Copied" : "Copy invite link"}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Copy invite link for ${inv.email}`}
                      onClick={() => copy(inv.link).then(() => toast.success("Invite link copied"))}
                      className="size-10 sm:size-8"
                    >
                      {copied === inv.link ? <Check className="text-success" /> : <Copy />}
                    </Button>
                  </Tooltip>
                  {canRevoke ? (
                    <Tooltip content="Revoke">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Revoke invitation for ${inv.email}`}
                        data-testid="revoke-invitation"
                        disabled={revoke.isPending && revoke.variables === inv.id}
                        onClick={() => onRevoke(inv)}
                        className="size-10 hover:bg-destructive/10 hover:text-destructive sm:size-8"
                      >
                        {revoke.isPending && revoke.variables === inv.id ? <Spinner /> : <Trash2 />}
                      </Button>
                    </Tooltip>
                  ) : null}
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

function MembersList({
  currentUserId,
  canManage,
  canInvite,
  onInvite,
}: {
  currentUserId: string | undefined;
  canManage: boolean;
  canInvite: boolean;
  onInvite: () => void;
}) {
  const members = useMemberDetails();
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const all = members.data?.members ?? [];
  const deactivatedCount = all.filter((m) => m.status === "deactivated").length;
  const list = all
    .filter((m) => showDeactivated || m.status === "active")
    .sort(
      (a, b) =>
        Number(a.status === "deactivated") - Number(b.status === "deactivated") ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.displayName.localeCompare(b.displayName),
    );
  const alone = members.data !== undefined && all.filter((m) => m.status === "active").length <= 1;

  return (
    <Section
      title="Members"
      count={members.data ? list.length : undefined}
      testId="members-list"
      actions={
        <>
          <Button
            variant="link"
            size="sm"
            onClick={() => setRolesOpen(true)}
            data-testid="role-reference-trigger"
            className="h-10 text-[13px] sm:h-8"
          >
            <BookOpenCheck />
            What can each role do?
          </Button>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
          <label className="flex h-10 cursor-pointer items-center gap-2 text-[13px] text-muted-foreground sm:h-8">
            <Switch
              checked={showDeactivated}
              onCheckedChange={setShowDeactivated}
              data-testid="show-deactivated"
            />
            Show deactivated
            {deactivatedCount > 0 ? <span className="tabular-nums">({deactivatedCount})</span> : null}
          </label>
        </>
      }
    >
      {members.isPending ? (
        <ListSkeleton rows={3} />
      ) : members.isError ? (
        <ListError error={members.error} onRetry={() => members.refetch()} retrying={members.isFetching} />
      ) : (
        <>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {list.map((m) => (
              <MemberRow key={m.userId} member={m} isYou={m.userId === currentUserId} canManage={canManage} />
            ))}
          </ul>
          {alone && canInvite ? <JustYou onInvite={onInvite} /> : null}
        </>
      )}
      <RoleReferenceSheet open={rolesOpen} onOpenChange={setRolesOpen} />
    </Section>
  );
}

/** Empty state: the admin is the only active member. */
function JustYou({ onInvite }: { onInvite: () => void }) {
  const desktop = useIsDesktop();
  // On desktop, land in the invite field; on phones, never pop the keyboard uninvited.
  const focused = useRef(false);
  useEffect(() => {
    if (desktop && !focused.current) {
      focused.current = true;
      onInvite();
    }
  }, [desktop, onInvite]);

  return (
    <div
      data-testid="members-empty"
      className="relative overflow-hidden rounded-xl border border-dashed px-6 py-8 text-center"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 -top-16 mx-auto h-32 w-64 rounded-full bg-primary/10 blur-3xl"
      />
      <span className="relative mx-auto mb-3 flex size-11 items-center justify-center rounded-xl border bg-card text-primary shadow-sm">
        <Sparkles className="size-5" strokeWidth={1.75} />
      </span>
      <h3 className="relative font-semibold text-base tracking-tight">It's just you so far</h3>
      <p className="relative mx-auto mt-1 max-w-sm text-balance text-muted-foreground text-sm">
        Invite your team with a link — no email server needed.
      </p>
      <Button onClick={onInvite} className="relative mt-4 h-10 sm:h-9" data-testid="members-empty-invite">
        <UserPlus />
        Invite your team
      </Button>
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
        <div key={i} className="flex h-[61px] items-center gap-3 px-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-44 sm:block" />
          <Skeleton className="size-8" />
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
