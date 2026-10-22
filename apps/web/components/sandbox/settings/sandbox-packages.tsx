"use client";

import type { ReviewSandboxPackageRequest, SandboxPackage } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  Ellipsis,
  Package,
  PackagePlus,
  RefreshCw,
  ScanSearch,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { RiskBadge } from "@/components/marketplace/risk-badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import {
  forgetPackageReview,
  useRemoveSandboxPackage,
  useSandboxPackages,
  useUpdateSandboxPackage,
} from "@/lib/sandbox-packages-queries";
import { cn } from "@/lib/utils";
import { AddPackageDialog } from "./add-package-dialog";
import { PackageReviewSheet, SOURCE_LABEL } from "./package-review-sheet";

/**
 * Settings › Sandbox & Browser › Sandbox packages (07.8-23; SBX-04, D-03 as refined by D-11, P-12, R12, UI-SPEC §4.4):
 * the organization's approved, pinned packages with their status in the sandboxes, Add → Review → Approve, the two
 * switches (saved on toggle, restored when the API refuses), Review…, Update to {version}… and Remove…. A package lands
 * in a bot's sandbox at that sandbox's next start. Without `plugin.manage` (the API's `viewerCan.manage`) the list is
 * read-only. Mounted between Network and Stop everything.
 */

type Flag = "enabled" | "personalAllowed";

const FLAGS: Array<{ key: Flag; label: string; hint: string }> = [
  { key: "enabled", label: "Bots can use it", hint: "Off removes it from every sandbox" },
  { key: "personalAllowed", label: "Personal bots", hint: "Members may use it in their own bot" },
];

export const CHANGED_UPSTREAM_HINT = "A dependency changed after approval. Review it again.";
export const READ_ONLY_NOTE = "Only workspace admins can approve packages.";
const FOOTNOTE =
  "Packages are installed only inside each bot's sandbox, never in the bot runtime. With Public network, bots can also install their own packages; set the sandbox shell to Allowlist to allow only approved ones.";

export type PackageStatusKey = "installed" | "installing" | "failed" | "removing" | "off" | "changed";

/**
 * A package's status in the sandboxes, in plain words. Changed upstream wins: its tree differs from the approved one, so
 * nothing installs it until an admin reviews and approves it again. Approved and not yet in any sandbox reads
 * Installing: each sandbox installs it at its next start.
 */
export function packageStatus(p: SandboxPackage): {
  key: PackageStatusKey;
  label: string;
  variant: "success" | "warning" | "destructive" | "outline";
  busy: boolean;
  hint?: string;
} {
  if (p.changedUpstream) {
    return {
      key: "changed",
      label: "Changed upstream",
      variant: "destructive",
      busy: false,
      hint: CHANGED_UPSTREAM_HINT,
    };
  }
  if (p.installing > 0) return { key: "installing", label: "Installing", variant: "warning", busy: true };
  if (p.failed > 0) return { key: "failed", label: "Install failed", variant: "destructive", busy: false };
  if (!p.enabled) {
    return p.installedIn > 0
      ? { key: "removing", label: "Removing", variant: "outline", busy: true }
      : { key: "off", label: "Off", variant: "outline", busy: false };
  }
  if (p.installedIn > 0) {
    return {
      key: "installed",
      label: `Installed in ${p.installedIn} ${p.installedIn === 1 ? "bot" : "bots"}`,
      variant: "success",
      busy: false,
    };
  }
  return { key: "installing", label: "Installing", variant: "warning", busy: true };
}

export function SandboxPackages() {
  const qc = useQueryClient();
  const q = useSandboxPackages();
  const update = useUpdateSandboxPackage();
  const remove = useRemoveSandboxPackage();
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<ReviewSandboxPackageRequest | null>(null);
  const [removing, setRemoving] = useState<SandboxPackage | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const cancelRef = useRef<HTMLButtonElement>(null);

  const items = q.data?.items ?? [];
  const manage = q.data?.viewerCan.manage ?? false;
  const live = reviewing
    ? (items.find((p) => p.source === reviewing.source && p.name === reviewing.name) ?? null)
    : null;

  function review(p: SandboxPackage, version: string = p.version) {
    const req = { source: p.source, name: p.name, version };
    // A row's review always asks the registry again.
    forgetPackageReview(qc, req);
    setReviewing(req);
  }

  function toggle(p: SandboxPackage, key: Flag, value: boolean) {
    const mark = `${p.id}:${key}`;
    setPending((s) => new Set(s).add(mark));
    update.mutate(
      { id: p.id, patch: { [key]: value } },
      {
        onError: (err) => toast.error("Could not change the package", { description: errorMessage(err) }),
        onSettled: () =>
          setPending((s) => {
            const next = new Set(s);
            next.delete(mark);
            return next;
          }),
      },
    );
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success(`${removing.name} removed`, {
        description: "It leaves each bot's sandbox when it next starts.",
      });
      setRemoving(null);
    } catch (err) {
      toast.error("Could not remove the package", { description: errorMessage(err) });
    }
  }

  return (
    <section className="grid gap-3" aria-labelledby="sandbox-packages-title" data-testid="sandbox-packages">
      {q.isPending ? (
        <>
          <Header manage={false} onAdd={() => undefined} showAdd={false} />
          <div className="grid gap-2" aria-busy>
            <Skeleton className="h-20 rounded-xl motion-reduce:animate-none" />
            <Skeleton className="h-20 rounded-xl motion-reduce:animate-none" />
          </div>
        </>
      ) : q.isError ? (
        <>
          <Header manage={false} onAdd={() => undefined} showAdd={false} />
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-8 text-center"
          >
            <p className="text-sm">Couldn't load sandbox packages.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
              className="max-md:h-11"
            >
              <RefreshCw className={cn(q.isFetching && "animate-spin")} /> Try again
            </Button>
          </div>
        </>
      ) : (
        <PackageListView
          items={items}
          manage={manage}
          pending={pending}
          onAdd={() => setAdding(true)}
          onReview={review}
          onRemove={setRemoving}
          onToggle={toggle}
        />
      )}

      {manage ? (
        <>
          <AddPackageDialog
            open={adding}
            onOpenChange={setAdding}
            onReviewed={(req) => {
              setAdding(false);
              setReviewing(req);
            }}
          />
          <PackageReviewSheet
            request={reviewing}
            live={live}
            onOpenChange={(open) => !open && setReviewing(null)}
          />
          <Dialog open={removing !== null} onOpenChange={(o) => !o && !remove.isPending && setRemoving(null)}>
            <DialogContent data-testid="package-remove-dialog" initialFocus={cancelRef}>
              <DialogHeader>
                <DialogTitle className="break-all">Remove {removing?.name}?</DialogTitle>
                <DialogDescription>
                  It's removed from every bot's sandbox the next time each one starts. Files bots made with it
                  stay.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  ref={cancelRef}
                  variant="outline"
                  onClick={() => setRemoving(null)}
                  disabled={remove.isPending}
                  className="max-md:h-11"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmRemove()}
                  disabled={remove.isPending}
                  className="max-md:h-11"
                  data-testid="package-remove-confirm"
                >
                  {remove.isPending ? <Spinner /> : <Trash2 />}
                  Remove package
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </section>
  );
}

function Header({ manage, showAdd, onAdd }: { manage: boolean; showAdd: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id="sandbox-packages-title" className="font-semibold text-[15px] tracking-tight">
        Sandbox packages
      </h2>
      {manage && showAdd ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="shrink-0 max-md:h-11"
          data-testid="package-add"
        >
          <PackagePlus /> Add package
        </Button>
      ) : null}
    </div>
  );
}

/** The list as the API answered it: rows, the empty box, the read-only note and the footnote (pure; tested as markup). */
export function PackageListView({
  items,
  manage,
  pending,
  onAdd,
  onReview,
  onRemove,
  onToggle,
}: {
  items: SandboxPackage[];
  manage: boolean;
  /** `${id}:${flag}` of switches being saved. */
  pending: ReadonlySet<string>;
  onAdd: () => void;
  onReview: (p: SandboxPackage, version?: string) => void;
  onRemove: (p: SandboxPackage) => void;
  onToggle: (p: SandboxPackage, key: Flag, value: boolean) => void;
}) {
  return (
    <>
      <Header manage={manage} showAdd={items.length > 0} onAdd={onAdd} />
      {items.length === 0 ? (
        <div
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center"
          data-testid="packages-empty"
        >
          <Package className="size-5 text-muted-foreground" aria-hidden />
          <p className="max-w-md text-muted-foreground text-sm">
            {manage
              ? "No sandbox packages yet. Approve one so every bot's sandbox has it ready."
              : "No sandbox packages yet."}
          </p>
          {manage ? (
            <Button onClick={onAdd} className="max-md:h-11" data-testid="package-add">
              <PackagePlus /> Add package
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="grid gap-3">
          {items.map((p) => (
            <li key={p.id}>
              <PackageRow
                pkg={p}
                manage={manage}
                pending={pending}
                onReview={onReview}
                onRemove={onRemove}
                onToggle={onToggle}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-1">
        {manage ? null : (
          <p className="text-muted-foreground text-xs" data-testid="packages-read-only">
            {READ_ONLY_NOTE}
          </p>
        )}
        <p className="text-muted-foreground text-xs leading-4">{FOOTNOTE}</p>
      </div>
    </>
  );
}

function PackageRow({
  pkg: p,
  manage,
  pending,
  onReview,
  onRemove,
  onToggle,
}: {
  pkg: SandboxPackage;
  manage: boolean;
  pending: ReadonlySet<string>;
  onReview: (p: SandboxPackage, version?: string) => void;
  onRemove: (p: SandboxPackage) => void;
  onToggle: (p: SandboxPackage, key: Flag, value: boolean) => void;
}) {
  const status = packageStatus(p);
  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-xs",
        (status.key === "changed" || status.key === "failed") && "border-destructive/30",
      )}
      data-testid={`package-row-${p.id}`}
      data-package={p.name}
      data-status={status.key}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <Package className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="min-w-0 break-all font-mono font-semibold text-sm">{p.name}</h3>
            <span className="break-all font-mono text-muted-foreground text-xs">{p.version}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{SOURCE_LABEL[p.source]}</Badge>
            <RiskBadge level={p.risk} />
            <Badge variant={status.variant} data-testid="package-status" data-status={status.key}>
              {status.busy ? <Spinner className="size-3" /> : null}
              {status.label}
            </Badge>
          </div>
          {status.hint ? (
            <p
              className="mt-2 flex items-start gap-1.5 text-[13px] text-destructive leading-snug"
              data-testid="package-status-hint"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {status.hint}
            </p>
          ) : null}
          {manage && status.key === "changed" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReview(p)}
              className="mt-2.5 max-md:h-11"
              data-testid="package-review-again"
            >
              <ScanSearch /> Review…
            </Button>
          ) : null}
        </div>
        {manage ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-my-1 -mr-1 shrink-0 text-muted-foreground max-md:-my-2.5 max-md:-mr-2.5 max-md:size-11"
                  aria-label={`${p.name} actions`}
                  data-testid="package-menu"
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onReview(p)} data-testid="package-menu-review">
                <ScanSearch /> Review…
              </DropdownMenuItem>
              {p.newerVersion ? (
                <DropdownMenuItem
                  onClick={() => onReview(p, p.newerVersion ?? p.version)}
                  data-testid="package-menu-update"
                >
                  <ArrowUpCircle /> Update to {p.newerVersion}…
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onRemove(p)}
                data-testid="package-menu-remove"
              >
                <Trash2 /> Remove…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {manage ? (
        <div className="grid gap-2 border-t bg-muted/20 px-4 py-3 sm:grid-cols-2">
          {FLAGS.map((f) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
            <label
              key={f.key}
              className="flex min-h-11 cursor-pointer items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2 sm:min-h-0"
            >
              <span className="min-w-0">
                <span className="block font-medium text-[13px]">{f.label}</span>
                <span className="block text-[11.5px] text-muted-foreground leading-snug">{f.hint}</span>
              </span>
              <Switch
                checked={p[f.key]}
                onCheckedChange={(v) => onToggle(p, f.key, v)}
                disabled={pending.has(`${p.id}:${f.key}`)}
                aria-label={`${f.label}: ${p.name}`}
                data-testid={`package-flag-${f.key}`}
              />
            </label>
          ))}
        </div>
      ) : null}
    </article>
  );
}
