"use client";

import { POOL_LIMITS, type PoolAccount, type PoolAccountStatus, PoolLabel } from "@ocw/contracts";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  KeyRound,
  type LucideIcon,
  Pencil,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { planLabel } from "@/components/bots/subscription-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  accountLocationText,
  accountStatusText,
  lastUsedText,
  type UsageBar,
  usageBars,
  weightError,
} from "@/lib/account-pool-format";
import { useRemovePoolAccount, useUpdatePoolAccount } from "@/lib/account-pool-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const ICON_BUTTON = "text-muted-foreground max-md:size-11";

const STATUS_VARIANT: Record<PoolAccountStatus, "success" | "warning" | "destructive" | "outline"> = {
  ready: "success",
  cooling: "warning",
  needs_sign_in: "destructive",
  disabled: "outline",
};

const KIND_ICON: Record<PoolAccount["kind"], LucideIcon> = {
  token: ShieldCheck,
  device_slot: Server,
  cell_profile: Bot,
};

/** What removing an account does, per kind (PD-25). */
const REMOVE_TEXT: Record<PoolAccount["kind"], string> = {
  token: "Its token is deleted from the server.",
  device_slot: "It is signed out on its device.",
  cell_profile: "It is signed out of the bots runtime.",
};

/** "ChatGPT Pro" for a ChatGPT plan, "Claude Max" for a Claude one; null when unknown. */
function planText(a: PoolAccount): string | null {
  if (!a.planType) return null;
  if (a.provider === "chatgpt") return planLabel(a.planType);
  return `Claude ${a.planType.charAt(0).toUpperCase()}${a.planType.slice(1)}`;
}

/**
 * One pool account (D-09, D-10): label, plan, status, where it lives, when it was used and its usage; and its actions:
 * on/off, rename, move up or down, weight (weighted only), a new token (token accounts) and remove. One line on wide
 * screens; under 640 px it stacks with a compact action bar, never scrolling sideways.
 */
export function AccountPoolRow({
  account: a,
  weighted,
  first,
  last,
  reordering,
  onMove,
  onReplaceToken,
}: {
  account: PoolAccount;
  weighted: boolean;
  first: boolean;
  last: boolean;
  reordering: boolean;
  onMove: (by: -1 | 1) => void;
  onReplaceToken: () => void;
}) {
  const update = useUpdatePoolAccount();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const bars = usageBars(a.usage);
  const plan = planText(a);
  const KindIcon = KIND_ICON[a.kind];

  async function save(body: { label?: string; enabled?: boolean; weight?: number }, done?: string) {
    try {
      await update.mutateAsync({ id: a.id, body });
      if (done) toast.success(done);
      return true;
    } catch (err) {
      toast.error("Could not update the account", { description: errorMessage(err) });
      return false;
    }
  }

  return (
    <li data-testid="pool-account" data-status={a.status}>
      <div
        data-testid={`pool-account-${a.id}`}
        className={cn(
          "flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5",
          !a.enabled && "bg-muted/30",
        )}
      >
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {editing ? (
              <RenameField
                account={a}
                saving={update.isPending}
                onCancel={() => setEditing(false)}
                onSave={async (label) => {
                  if (await save({ label })) setEditing(false);
                }}
              />
            ) : (
              <span
                className={cn("min-w-0 truncate font-medium text-sm", !a.enabled && "text-muted-foreground")}
              >
                {a.label}
              </span>
            )}
            {plan ? (
              <Badge variant="secondary" className="h-5">
                {plan}
              </Badge>
            ) : null}
            <Badge variant={STATUS_VARIANT[a.status]} className="h-5" data-testid="pool-account-status">
              {accountStatusText(a)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
            <span className="flex min-w-0 items-center gap-1">
              <KindIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{accountLocationText(a)}</span>
            </span>
            <span>{lastUsedText(a.lastUsedAt)}</span>
            {a.origin === "device_cli" ? <span>Signed in on the device</span> : null}
          </div>
          {bars.length > 0 ? <UsageBars bars={bars} /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:shrink-0 sm:flex-nowrap">
          {weighted ? <WeightField account={a} onSave={(weight) => save({ weight })} /> : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${a.label} up`}
            disabled={first || reordering}
            onClick={() => onMove(-1)}
            className={ICON_BUTTON}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${a.label} down`}
            disabled={last || reordering}
            onClick={() => onMove(1)}
            className={ICON_BUTTON}
          >
            <ArrowDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${a.label}`}
            onClick={() => setEditing(true)}
            disabled={editing}
            className={ICON_BUTTON}
          >
            <Pencil />
          </Button>
          {a.kind === "token" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Replace the token of ${a.label}`}
              onClick={onReplaceToken}
              className={cn(ICON_BUTTON, a.status === "needs_sign_in" && "text-destructive")}
            >
              <KeyRound />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${a.label}`}
            onClick={() => setRemoving(true)}
            className={cn(ICON_BUTTON, "hover:bg-destructive/10 hover:text-destructive")}
          >
            <Trash2 />
          </Button>
          <span className="ml-auto flex items-center pl-2 max-md:min-h-11">
            <Switch
              checked={a.enabled}
              aria-label={`Use ${a.label}`}
              onCheckedChange={(enabled) =>
                void save({ enabled }, enabled ? `${a.label} is on` : `${a.label} is off`)
              }
            />
          </span>
        </div>
      </div>
      <RemoveAccountDialog account={a} open={removing} onOpenChange={setRemoving} />
    </li>
  );
}

function UsageBars({ bars }: { bars: UsageBar[] }) {
  return (
    <ul className="grid max-w-md grid-cols-1 gap-1.5 pt-0.5 min-[420px]:grid-cols-2" aria-label="Usage">
      {bars.map((b) => (
        <li key={b.kind} className="grid gap-1" data-testid="pool-usage-bar">
          <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{b.label}</span>
            <span className="tabular-nums">{b.percent}%</span>
          </span>
          <span
            role="meter"
            aria-label={`${b.label} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={b.percent}
            className="block h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <span
              className={cn(
                "block h-full rounded-full",
                b.percent >= 100 ? "bg-destructive" : b.percent >= 80 ? "bg-warning" : "bg-primary",
              )}
              style={{ width: `${b.percent}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RenameField({
  account: a,
  saving,
  onSave,
  onCancel,
}: {
  account: PoolAccount;
  saving: boolean;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(a.label);
  const ok = PoolLabel.safeParse(value).success && value.trim() !== a.label;
  const submit = () => (ok ? onSave(value.trim()) : value.trim() === a.label ? onCancel() : undefined);
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") onCancel();
  }
  return (
    <span className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={POOL_LIMITS.labelMax}
        aria-label={`New label for ${a.label}`}
        autoFocus
        className="h-8 min-w-0 flex-1 sm:w-56 max-md:h-11"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Save the label"
        disabled={!ok || saving}
        onClick={submit}
        className={ICON_BUTTON}
      >
        {saving ? <Spinner /> : <Check />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Cancel" onClick={onCancel} className={ICON_BUTTON}>
        <X />
      </Button>
    </span>
  );
}

/** Weighted only (D-04): 1–100, saved on Enter or when the field loses focus. */
function WeightField({
  account: a,
  onSave,
}: {
  account: PoolAccount;
  onSave: (weight: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState(String(a.weight));
  const error = weightError(value);
  async function commit() {
    if (error) return;
    const weight = Number(value.trim());
    if (weight !== a.weight && !(await onSave(weight))) setValue(String(a.weight));
  }
  return (
    <span className="mr-1 flex items-center gap-1.5">
      <span aria-hidden className="text-muted-foreground text-xs">
        Weight
      </span>
      <Input
        type="number"
        inputMode="numeric"
        min={POOL_LIMITS.weightMin}
        max={POOL_LIMITS.weightMax}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        aria-label={`Weight for ${a.label}`}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        className="h-8 w-16 tabular-nums max-md:h-11"
      />
    </span>
  );
}

function RemoveAccountDialog({
  account: a,
  open,
  onOpenChange,
}: {
  account: PoolAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemovePoolAccount();
  async function confirm() {
    try {
      await remove.mutateAsync(a.id);
      toast.success(`${a.label} removed`);
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not remove the account", { description: errorMessage(err) });
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {a.label}?</DialogTitle>
          <DialogDescription>{REMOVE_TEXT[a.kind]}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-muted-foreground text-sm">
            Sessions on it move to the next ready account at their next turn.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="max-md:h-11">
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending} className="max-md:h-11">
            {remove.isPending ? <Spinner /> : <Trash2 />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
