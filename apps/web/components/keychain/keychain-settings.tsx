"use client";

import type { VaultItem, VaultItemList } from "@ocw/contracts";
import {
  Check,
  Copy,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { BrowserSessionsSection } from "@/components/browser/browser-sessions-section";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage, isApiError } from "@/lib/api";
import { connectionDate } from "@/lib/connections-format";
import { useDeleteVaultItem, useKeychain } from "@/lib/keychain-queries";
import { cn, relativeTime } from "@/lib/utils";
import { kindLabel, looksPrivate, type VaultDialogMode, VaultItemDialog } from "./vault-item-dialog";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";
const MAX_CHIPS = 3;
/** The organization in the unit selector (`unit=org` in the URL; `unitId` null in the API). */
const ORG = "org";

/**
 * Settings › Keychain (07.4-13; D-04, CONN-05; UI-SPEC § 3, R3): the member's personal keys and, where they manage a
 * unit, that unit's keys. A key's value is never shown again: rows say `Value set · updated {valueUpdatedAt}`, and the
 * edit dialog only offers to replace it. The private-host list is an organization policy on Settings › MCP servers (R5).
 * Below the keys, the member's own saved browser sign-ins (07.8-27, `BrowserSessionsSection`).
 */
export function KeychainSettings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useKeychain();
  const [dialog, setDialog] = useState<VaultDialogMode | null>(null);
  const [toDelete, setToDelete] = useState<VaultItem | null>(null);
  const units = q.data?.manageableUnits ?? [];
  const unitParam = params.get("unit");
  const selectedUnit = units.find((u) => (u.unitId ?? ORG) === unitParam) ?? units[0] ?? null;
  const selectedUnitId = selectedUnit ? selectedUnit.unitId : null;

  function pickUnit(v: string) {
    const next = new URLSearchParams(params.toString());
    next.set("unit", v);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  let personal: ReactNode;
  if (q.isPending) {
    personal = <SkeletonRows />;
  } else if (q.isError) {
    personal = (
      <div className="rounded-xl border bg-card">
        {isApiError(q.error) && !q.error.isNetwork ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm" role="alert">
            <p>Couldn't load your keys.</p>
            <Button variant="outline" size="sm" onClick={() => q.refetch()} className={TOUCH}>
              Try again
            </Button>
          </div>
        ) : (
          <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </div>
    );
  } else if ((q.data?.personal.length ?? 0) === 0) {
    personal = (
      <div
        className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center"
        data-testid="keychain-empty"
      >
        <span className="flex size-11 items-center justify-center rounded-xl border bg-muted/50">
          <KeyRound className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <div>
          <p className="font-medium text-sm">No keys yet</p>
          <p className="mt-0.5 max-w-md text-muted-foreground text-sm">
            Add an API key and choose which hosts it may be sent to. Bots use it by handle and never see it.
          </p>
        </div>
        <Button
          onClick={() => setDialog({ kind: "create", scope: "personal", unitId: null })}
          className={TOUCH}
          data-testid="keychain-empty-add"
        >
          <Plus /> Add key
        </Button>
      </div>
    );
  } else {
    personal = (
      <KeyList
        items={q.data?.personal ?? []}
        label="Your keys"
        testId="keychain-personal"
        onEdit={(item, replace) => setDialog({ kind: "edit", item, replace })}
        onDelete={setToDelete}
      />
    );
  }

  const unitItems = (q.data?.unit ?? []).filter((i) => i.unitId === selectedUnitId);

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
      <section className="grid gap-3" aria-labelledby="keychain-personal-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="keychain-personal-heading" className="font-semibold text-[15px] tracking-tight">
              Your keys
            </h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              Keys your bots can use without ever seeing them. A key is sent only to the hosts you list.
            </p>
          </div>
          {(q.data?.personal.length ?? 0) > 0 ? (
            <Button
              onClick={() => setDialog({ kind: "create", scope: "personal", unitId: null })}
              className={cn("w-full sm:w-auto", TOUCH)}
              data-testid="keychain-add"
            >
              <Plus /> Add key
            </Button>
          ) : null}
        </div>
        {personal}
      </section>

      {selectedUnit ? (
        <section
          className="grid gap-3"
          aria-labelledby="keychain-unit-heading"
          data-testid="keychain-unit-section"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
              <h2 id="keychain-unit-heading" className="font-semibold text-[15px] tracking-tight">
                Unit keys
              </h2>
              <Select
                items={units.map((u) => ({ value: u.unitId ?? ORG, label: u.name }))}
                value={selectedUnit.unitId ?? ORG}
                onValueChange={(v) => v && pickUnit(String(v))}
              >
                <SelectTrigger
                  aria-label="Unit"
                  className={cn("w-full sm:w-48", TOUCH)}
                  data-testid="keychain-unit-select"
                />
                <SelectContent>
                  {units.map((u) => (
                    <SelectItem key={u.unitId ?? ORG} value={u.unitId ?? ORG}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="basis-full text-muted-foreground text-sm">
                {selectedUnit.unitId === null
                  ? "Keys every bot of the organization can use. Only admins manage them."
                  : `Keys your unit's bots can use. Only leads and admins of ${selectedUnit.name} manage them.`}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setDialog({ kind: "create", scope: "unit", unitId: selectedUnitId })}
              className={cn("w-full sm:w-auto", TOUCH)}
              data-testid="keychain-unit-add"
            >
              <Plus /> Add unit key
            </Button>
          </div>
          {unitItems.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
              {selectedUnit.unitId === null
                ? "No organization keys yet."
                : `No unit keys in ${selectedUnit.name} yet.`}
            </p>
          ) : (
            <KeyList
              items={unitItems}
              label="Unit keys"
              testId="keychain-unit"
              onEdit={(item, replace) => setDialog({ kind: "edit", item, replace })}
              onDelete={setToDelete}
            />
          )}
        </section>
      ) : null}

      <p className="-mt-7 flex items-start gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Values are encrypted, injected by the server only towards the listed hosts and never returned. Each
        use is audited without the value.
      </p>

      <BrowserSessionsSection />

      <VaultItemDialog mode={dialog} units={units} onOpenChange={(o) => !o && setDialog(null)} />
      <DeleteKeyDialog item={toDelete} onDone={() => setToDelete(null)} />
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y rounded-xl border bg-card shadow-xs" aria-busy>
      {[0, 1].map((i) => (
        <div key={i} className="flex h-24 items-start gap-3 px-4 py-3 sm:px-5">
          <Skeleton className="size-9 rounded-lg motion-reduce:animate-none" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-3.5 w-40 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-64 max-w-full motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyList({
  items,
  label,
  testId,
  onEdit,
  onDelete,
}: {
  items: VaultItem[];
  label: string;
  testId: string;
  onEdit: (item: VaultItem, replace: boolean) => void;
  onDelete: (item: VaultItem) => void;
}) {
  return (
    <ul
      aria-label={label}
      className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
      data-testid={testId}
    >
      {items.map((item) => (
        <KeyRow
          key={item.id}
          item={item}
          onEdit={(replace) => onEdit(item, replace)}
          onDelete={() => onDelete(item)}
        />
      ))}
    </ul>
  );
}

function KeyRow({
  item,
  onEdit,
  onDelete,
}: {
  item: VaultItem;
  onEdit: (replace: boolean) => void;
  onDelete: () => void;
}) {
  const { copy, copied } = useCopy();
  const nameId = `vault-name-${item.id}`;
  const shown = item.allowedHosts.slice(0, MAX_CHIPS);
  const rest = item.allowedHosts.slice(MAX_CHIPS);
  const bots = item.agentIds.length;
  const privateNet = item.scope === "unit" && item.allowedHosts.some(looksPrivate);
  return (
    <li aria-labelledby={nameId} className="px-4 py-3 sm:px-5" data-testid={`vault-row-${item.id}`}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span id={nameId} className="truncate font-semibold text-sm">
              {item.name}
            </span>
            <span className="text-muted-foreground text-xs" data-testid="vault-kind-label">
              {kindLabel(item.kind)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <code className="font-mono text-xs" data-testid="vault-handle">
              {item.handle}
            </code>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy handle ${item.handle}`}
              onClick={() =>
                void copy(item.handle).then(
                  () => toast.success("Handle copied"),
                  () => undefined,
                )
              }
              className="text-muted-foreground max-md:-my-2 max-md:size-11"
              data-testid="vault-copy-handle"
            >
              {copied === item.handle ? <Check /> : <Copy />}
            </Button>
            <span className="sr-only" aria-live="polite">
              {copied === item.handle ? "Copied" : ""}
            </span>
          </div>
          <ul aria-label="Allowed hosts" className="mt-1.5 flex flex-wrap items-center gap-1">
            {shown.map((h) => (
              <li key={h} className="max-w-full">
                <Badge variant="outline" className="max-w-full font-mono text-xs" title={h}>
                  <span className="truncate">{h}</span>
                </Badge>
              </li>
            ))}
            {rest.length > 0 ? (
              <li>
                <Tooltip content={rest.join(", ")}>
                  <span className="cursor-default text-muted-foreground text-xs">+{rest.length} more</span>
                </Tooltip>
              </li>
            ) : null}
            {privateNet ? (
              <li>
                <Badge variant="outline">Private network</Badge>
              </li>
            ) : null}
          </ul>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
            <span className="inline-flex items-center gap-1" data-testid="vault-value-state">
              <Lock className="size-3.5" aria-hidden />
              Value set · updated {connectionDate(item.valueUpdatedAt)}
            </span>
            <span aria-hidden className="max-md:hidden">
              ·
            </span>
            <span className="max-md:basis-full">
              <span
                className={cn(bots === 0 && "text-amber-700 dark:text-amber-300")}
                data-testid="vault-bots"
              >
                {bots === 0 ? "no bots yet" : bots === 1 ? "1 bot" : `${bots} bots`}
              </span>
              {" · "}
              <span data-testid="vault-last-used">
                {item.lastUsedAt ? `last used ${relativeTime(item.lastUsedAt)}` : "never used"}
              </span>
            </span>
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="-mt-0.5 shrink-0 text-muted-foreground max-md:-my-2 max-md:-mr-2 max-md:size-11"
                aria-label={`${item.name} actions`}
                data-testid={`vault-menu-${item.id}`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onEdit(false)}
              className="max-md:min-h-11"
              data-testid="vault-edit"
            >
              <Pencil /> Edit…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onEdit(true)}
              className="max-md:min-h-11"
              data-testid="vault-replace-value"
            >
              <RefreshCw /> Replace value…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              variant="destructive"
              className="max-md:min-h-11"
              data-testid="vault-delete"
            >
              <Trash2 /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function DeleteKeyDialog({ item, onDone }: { item: VaultItem | null; onDone: () => void }) {
  const remove = useDeleteVaultItem();
  const cancelRef = useRef<HTMLButtonElement>(null);
  async function confirm() {
    if (!item) return;
    try {
      await remove.mutateAsync(item.id);
      toast.success(`${item.name} deleted`);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && !remove.isPending && onDone()}>
      <DialogContent data-testid="vault-delete-dialog" initialFocus={cancelRef}>
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete “{item.name}”?</DialogTitle>
              <DialogDescription>
                Bots that use <code className="font-mono text-xs">{item.handle}</code> stop working with it
                right away. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={cancelRef}
                variant="outline"
                onClick={onDone}
                disabled={remove.isPending}
                className={TOUCH}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void confirm()}
                disabled={remove.isPending}
                className={TOUCH}
                data-testid="vault-delete-confirm"
              >
                {remove.isPending ? <Spinner /> : <Trash2 />}
                Delete key
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export type { VaultItemList };
