"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  AvatarRef,
  DisplayName,
  type OrgRole,
  type Profile,
  ROLE_LABELS,
  StatusEmoji,
  StatusText,
  type UpdateProfileRequest,
} from "@ocw/contracts";
import { Check, Lock, SmilePlus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useProfile, useUpdateProfile } from "@/lib/account-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AvatarPicker } from "./avatar-picker";

const STATUS_EMOJIS = ["💬", "📅", "🌴", "🤒", "🏠", "🚗", "✈️", "🎧", "🍔", "🎯", "🔕", "🚀"] as const;
const STATUS_MAX = 80;
/** Display only (badge colour), never an authorization decision. */
const ROLE_VARIANT: Record<OrgRole, "brand" | "outline"> = {
  admin: "brand",
  lead: "brand",
  developer: "outline",
  standard: "outline",
};
const AVATAR_ERROR = "Use an https:// image URL or an emoji";

interface Draft {
  displayName: string;
  avatarUrl: string | null;
  statusEmoji: string | null;
  statusText: string;
}

const fromProfile = (p: Profile): Draft => ({
  displayName: p.displayName,
  avatarUrl: p.avatarUrl,
  statusEmoji: p.statusEmoji,
  statusText: p.statusText ?? "",
});

function validateDraft(d: Draft) {
  const errors: Partial<Record<keyof Draft, string>> = {};
  const name = DisplayName.safeParse(d.displayName);
  if (!name.success) errors.displayName = d.displayName.trim() ? "Use at most 80 characters" : "Required";
  if (d.avatarUrl !== null && !AvatarRef.safeParse(d.avatarUrl).success) errors.avatarUrl = AVATAR_ERROR;
  if (d.statusEmoji !== null && !StatusEmoji.safeParse(d.statusEmoji).success) {
    errors.statusEmoji = "Pick an emoji";
  }
  if (!StatusText.safeParse(d.statusText).success) errors.statusText = `Use at most ${STATUS_MAX} characters`;
  return errors;
}

/** Only the fields that changed; an empty status text clears it. */
function diff(base: Draft, d: Draft): UpdateProfileRequest | null {
  const body: UpdateProfileRequest = {};
  if (d.displayName.trim() !== base.displayName) body.displayName = d.displayName.trim();
  if (d.avatarUrl !== base.avatarUrl) body.avatarUrl = d.avatarUrl;
  if (d.statusEmoji !== base.statusEmoji) body.statusEmoji = d.statusEmoji;
  const text = d.statusText.trim();
  if (text !== base.statusText.trim()) body.statusText = text ? text : null;
  return Object.keys(body).length ? body : null;
}

export function ProfileForm() {
  const profile = useProfile();
  if (profile.isPending) return <ProfileSkeleton />;
  if (profile.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="rounded-xl border bg-card">
          <ServerUnreachable
            onRetry={() => profile.refetch()}
            retrying={profile.isFetching}
            className="py-8"
          />
        </div>
      </div>
    );
  }
  return <ProfileEditor profile={profile.data} />;
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const update = useUpdateProfile();
  const base = useMemo(() => fromProfile(profile), [profile]);
  const [draft, setDraft] = useState<Draft>(base);
  const [nameTouched, setNameTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // A save (or a live member.updated refetch) resets the form to the stored profile.
  useEffect(() => setDraft(base), [base]);

  const errors = validateDraft(draft);
  const valid = Object.keys(errors).length === 0;
  const changes = diff(base, draft);
  const dirty = changes !== null;
  const pending = update.isPending;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setFormError(null);
  };

  // Preview only what would be accepted, so a half-typed URL never renders as text.
  const previewSrc = draft.avatarUrl !== null && !errors.avatarUrl ? draft.avatarUrl : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNameTouched(true);
    if (!valid || !changes) return;
    try {
      await update.mutateAsync(changes);
      toast.success("Profile updated");
    } catch (err) {
      if (isApiError(err, 400)) setFormError(errorMessage(err));
      else toast.error("Could not save your profile", { description: errorMessage(err) });
    }
  }

  const hasStatus = draft.statusEmoji !== null || draft.statusText !== "";

  return (
    <form
      data-testid="profile-form"
      onSubmit={onSubmit}
      noValidate
      className="mx-auto grid w-full max-w-3xl gap-8 px-4 pt-6 sm:px-6 sm:pt-8"
    >
      {formError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-sm"
        >
          {formError}
        </div>
      ) : null}

      <Section title="Avatar" description="Shown next to your messages and in the member directory.">
        <Card>
          <AvatarPicker
            value={draft.avatarUrl}
            previewSrc={previewSrc}
            onChange={(v) => set("avatarUrl", v)}
            name={draft.displayName.trim() || profile.displayName}
            seed={profile.userId}
            error={errors.avatarUrl}
          />
        </Card>
      </Section>

      <Section title="Name and status" description="Let your team know what you are up to.">
        <Card className="grid gap-5">
          <FormField
            id="displayName"
            label="Display name"
            error={nameTouched ? errors.displayName : undefined}
          >
            <Input
              id="displayName"
              name="displayName"
              autoComplete="name"
              maxLength={120}
              value={draft.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              onBlur={() => setNameTouched(true)}
              aria-invalid={nameTouched && !!errors.displayName}
              aria-describedby={describedBy("displayName", nameTouched ? errors.displayName : undefined)}
            />
          </FormField>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="statusText">Status</Label>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  draft.statusText.length > STATUS_MAX ? "text-destructive" : "text-muted-foreground",
                )}
                aria-live="polite"
              >
                {draft.statusText.length}/{STATUS_MAX}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <StatusEmojiPicker value={draft.statusEmoji} onChange={(v) => set("statusEmoji", v)} />
              <Input
                id="statusText"
                name="statusText"
                placeholder="What's your status?"
                autoComplete="off"
                value={draft.statusText}
                onChange={(e) => set("statusText", e.target.value)}
                aria-invalid={!!errors.statusText}
                aria-describedby={describedBy("statusText", errors.statusText)}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Clear status"
                data-testid="clear-status"
                disabled={!hasStatus}
                onClick={() => setDraft((d) => ({ ...d, statusEmoji: null, statusText: "" }))}
                className="sm:w-auto sm:px-3"
              >
                <X />
                <span className="hidden sm:inline">Clear</span>
              </Button>
            </div>
            {errors.statusText ? (
              <p id="statusText-error" role="alert" className="text-[13px] text-destructive">
                {errors.statusText}
              </p>
            ) : null}
          </div>
        </Card>
      </Section>

      <Section title="Account" description="Managed by your organization.">
        <Card className="grid gap-4 sm:grid-cols-2">
          <ReadOnly label="Email" value={profile.email} />
          <ReadOnly
            label="Role"
            value={<Badge variant={ROLE_VARIANT[profile.role]}>{ROLE_LABELS[profile.role]}</Badge>}
          />
        </Card>
      </Section>

      {/* Sticky action bar: always reachable on long mobile pages. */}
      <div className="sticky bottom-0 -mx-4 border-t bg-background/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-muted-foreground text-xs" aria-live="polite">
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || pending}
            onClick={() => {
              setDraft(base);
              setNameTouched(false);
              setFormError(null);
            }}
          >
            Discard
          </Button>
          <Button type="submit" data-testid="profile-save" disabled={!dirty || !valid || pending}>
            {pending ? <Spinner /> : <Check />}
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function StatusEmojiPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(v) => onChange((v as string | null) ?? null)}>
      <SelectPrimitive.Trigger
        aria-label={value ? `Status emoji ${value}` : "Choose a status emoji"}
        data-testid="status-emoji"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-input bg-background text-lg shadow-xs outline-none transition-[color,box-shadow,border-color] hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 dark:bg-input/25"
      >
        <SelectPrimitive.Value>
          {(v: string | null) =>
            v ? (
              <span className="leading-none">{v}</span>
            ) : (
              <SmilePlus className="size-4 text-muted-foreground" />
            )
          }
        </SelectPrimitive.Value>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className="z-50 outline-none"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
        >
          <SelectPrimitive.Popup className="origin-(--transform-origin) rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg shadow-black/5 outline-none transition-[transform,scale,opacity] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:shadow-black/40">
            <SelectPrimitive.List className="grid grid-cols-6 gap-1">
              {STATUS_EMOJIS.map((emoji) => (
                <SelectPrimitive.Item
                  key={emoji}
                  value={emoji}
                  aria-label={emoji}
                  className="flex size-10 cursor-default items-center justify-center rounded-lg text-xl outline-none data-highlighted:bg-accent data-selected:bg-primary/10 data-selected:ring-1 data-selected:ring-primary/40"
                >
                  <SelectPrimitive.ItemText>{emoji}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border bg-card p-4 shadow-xs sm:p-5", className)}>{children}</div>;
}

function ReadOnly({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
        <Lock className="size-3" />
        {label}
      </span>
      <span className="truncate text-sm">{value}</span>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 sm:py-8" aria-busy>
      {[220, 170, 90].map((h) => (
        <div key={h} className="grid gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="w-full rounded-xl" style={{ height: h }} />
        </div>
      ))}
    </div>
  );
}
