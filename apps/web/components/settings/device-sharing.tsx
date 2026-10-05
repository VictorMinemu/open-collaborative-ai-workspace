"use client";

import type { Device, DeviceGrant, PermissionMode } from "@ocw/contracts";
import { Search, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KIND_META, KindIcon } from "@/components/organization/unit-meta";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useDeleteDeviceGrant, usePutDeviceGrant } from "@/lib/device-queries";
import { useUnits } from "@/lib/org-queries";
import { useMembers } from "@/lib/queries";
import { useUpdateDevice } from "@/lib/workzone-queries";

/** The modes an owner can cap someone at, in the order people think about them (D-05). */
export const MODE_ITEMS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Supervised" },
  { value: "acceptEdits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "fullAccess", label: "Full access" },
  { value: "plan", label: "Plan" },
];

const FULL_ACCESS_OFF = "Turn on Full access on the device first";

function ModeSelect({
  value,
  onChange,
  fullAccessAllowed,
  disabled,
  label,
  testId,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  fullAccessAllowed: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
}) {
  return (
    <Select
      items={MODE_ITEMS}
      value={value}
      disabled={disabled}
      onValueChange={(v) => v && v !== value && onChange(v as PermissionMode)}
    >
      <SelectTrigger
        aria-label={label}
        data-testid={testId}
        className="h-9 w-full text-[13px] sm:h-8 sm:w-44"
      />
      <SelectContent>
        {MODE_ITEMS.map((m) => {
          const off = m.value === "fullAccess" && !fullAccessAllowed;
          return (
            <SelectItem key={m.value} value={m.value} disabled={off} data-testid="mode-option">
              <span className="grid">
                <span>{m.label}</span>
                {off ? <span className="text-muted-foreground text-xs">{FULL_ACCESS_OFF}</span> : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Sharing section of a device card (owner only): everyone in the organization (the original switch) with its
 * maximum mode, and specific people and teams each with their own maximum mode (D-05, ADR-0012 §2).
 */
export function DeviceSharing({ device }: { device: Device }) {
  const update = useUpdateDevice();
  const put = usePutDeviceGrant(device.id);
  const del = useDeleteDeviceGrant(device.id);
  const members = useMembers();
  const units = useUnits();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DeviceGrant | null>(null);
  const grants = device.grants ?? [];
  const fullAccessAllowed = device.fullAccessOptIn;
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const memberOf = (id: string) => members.data?.members.find((m) => m.userId === id);
  const unitOf = (id: string) => units.data?.units.find((u) => u.id === id);

  return (
    <div className="border-t" data-testid="device-sharing">
      <div className="grid gap-3 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm">
            <span className="font-medium">Everyone in the organization</span>
            <span className="block text-muted-foreground text-xs">
              Let teammates start sessions on this device. You can still approve every change they request.
            </span>
          </span>
          <Switch
            checked={device.shared}
            aria-label="Share with the team"
            data-testid="share-everyone"
            onCheckedChange={(shared) => update.mutate({ id: device.id, shared }, { onError })}
          />
        </div>
        <div className="grid gap-1.5 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-3">
          <ModeSelect
            value={device.shareMaxMode}
            fullAccessAllowed={fullAccessAllowed}
            label="Most anyone else can use"
            testId="share-mode"
            onChange={(shareMaxMode) => update.mutate({ id: device.id, shareMaxMode }, { onError })}
          />
          <p className="text-muted-foreground text-xs">
            Also the most other members can use when they prompt sessions on this device. Never above the
            lowest person you list.
          </p>
        </div>
      </div>

      <div className="grid gap-2 border-t px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-sm">Specific people and teams</span>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="add-grant">
            <UserPlus /> Add people or teams
          </Button>
        </div>
        {grants.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Listed people start and control sessions here without you accepting each one, up to the mode you
            choose.
          </p>
        ) : (
          <ul className="grid gap-1" aria-label="People and teams this device is shared with">
            {grants.map((g) => {
              const unit = g.principalKind === "unit" ? unitOf(g.principalId) : undefined;
              const member = g.principalKind === "user" ? memberOf(g.principalId) : undefined;
              const name = g.principalName ?? (g.principalKind === "user" ? "Former member" : "Deleted unit");
              return (
                <li
                  key={`${g.principalKind}:${g.principalId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg py-1.5"
                  data-testid="grant-row"
                  data-principal-id={g.principalId}
                >
                  <span className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
                    {g.principalKind === "user" ? (
                      <UserAvatar
                        name={name}
                        src={member?.avatarUrl}
                        seed={g.principalId}
                        className="size-8"
                      />
                    ) : (
                      <KindIcon kind={unit?.kind ?? "team"} size="md" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-sm">{name}</span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {g.principalKind === "user" ? "Person" : KIND_META[unit?.kind ?? "team"].label}
                      </span>
                    </span>
                  </span>
                  <span className="flex flex-1 items-center gap-1.5 sm:flex-none">
                    <ModeSelect
                      value={g.maxMode}
                      fullAccessAllowed={fullAccessAllowed}
                      label={`Most ${name} can use`}
                      testId="grant-mode"
                      onChange={(maxMode) =>
                        put.mutate(
                          { kind: g.principalKind, principalId: g.principalId, maxMode },
                          { onError },
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${name}`}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setRemoving(g)}
                      data-testid="grant-remove"
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AddGrantDialog
        open={adding}
        onOpenChange={setAdding}
        device={device}
        onAdd={(kind, principalId, name) =>
          put.mutate(
            { kind, principalId, maxMode: "default" },
            {
              onSuccess: () => {
                setAdding(false);
                toast.success(`Shared ${device.name} with ${name}`);
              },
              onError,
            },
          )
        }
        pending={put.isPending}
      />

      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {removing?.principalName ?? "access"}?</DialogTitle>
            <DialogDescription>
              Their running sessions on {device.name} stop now, and they can no longer prompt sessions on it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              data-testid="confirm-remove-grant"
              onClick={() =>
                removing &&
                del.mutate(
                  { kind: removing.principalKind, principalId: removing.principalId },
                  {
                    onSuccess: () => {
                      toast.success(`${removing.principalName ?? "Access"} removed from ${device.name}`);
                      setRemoving(null);
                    },
                    onError,
                  },
                )
              }
            >
              {del.isPending ? <Spinner /> : <Trash2 />} Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Searchable list of members and units not yet listed (the owner excluded); one click adds as Supervised. */
function AddGrantDialog({
  open,
  onOpenChange,
  device,
  onAdd,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: Device;
  onAdd: (kind: "user" | "unit", principalId: string, name: string) => void;
  pending: boolean;
}) {
  const members = useMembers();
  const units = useUnits();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const listed = new Set((device.grants ?? []).map((g) => `${g.principalKind}:${g.principalId}`));
  const q = query.trim().toLowerCase();
  const people = (members.data?.members ?? [])
    .filter(
      (m) => m.status === "active" && m.userId !== device.ownerUserId && !listed.has(`user:${m.userId}`),
    )
    .filter((m) => !q || m.displayName.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const teams = (units.data?.units ?? [])
    .filter((u) => !listed.has(`unit:${u.id}`))
    .filter((u) => !q || u.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const option =
    "flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 disabled:cursor-wait";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-grant-dialog">
        <DialogHeader>
          <DialogTitle className="break-words">Share {device.name}</DialogTitle>
          <DialogDescription>
            They start as Supervised. Raise their maximum mode from the list afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search people, teams and departments"
            aria-label="Search people, teams and departments"
            data-testid="add-grant-search"
            className="h-10 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DialogBody className="-mt-1 grid min-h-40 content-start gap-3">
          {people.length === 0 && teams.length === 0 ? (
            <p className="px-2 py-10 text-center text-muted-foreground text-sm">
              {q ? `No one matches “${query.trim()}”` : "Everyone is already listed"}
            </p>
          ) : null}
          {people.length > 0 ? (
            <section className="grid gap-0.5" aria-label="People">
              <p className="px-2 font-medium text-muted-foreground text-xs">People</p>
              {people.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  disabled={pending}
                  className={option}
                  data-testid="grant-option"
                  data-principal-id={m.userId}
                  onClick={() => onAdd("user", m.userId, m.displayName)}
                >
                  <UserAvatar name={m.displayName} src={m.avatarUrl} seed={m.userId} className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">{m.displayName}</span>
                    {m.email ? (
                      <span className="block truncate text-muted-foreground text-xs">{m.email}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </section>
          ) : null}
          {teams.length > 0 ? (
            <section className="grid gap-0.5" aria-label="Teams and departments">
              <p className="px-2 font-medium text-muted-foreground text-xs">Teams and departments</p>
              {teams.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={pending}
                  className={option}
                  data-testid="grant-option"
                  data-principal-id={u.id}
                  onClick={() => onAdd("unit", u.id, u.name)}
                >
                  <KindIcon kind={u.kind} size="lg" className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">{u.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {KIND_META[u.kind].label} · {u.memberCount} member{u.memberCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
