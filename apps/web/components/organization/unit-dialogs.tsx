"use client";

import { type OrgUnit, type UnitKind, UnitName } from "@ocw/contracts";
import { MoreHorizontal, Plus } from "lucide-react";
import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from "react";
import { toast } from "sonner";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateUnit } from "@/lib/org-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ancestorsOf, canManageUnit, KIND_META, KindIcon } from "./unit-meta";

// ---------------------------------------------------------------- dialog state

export type UnitDialog = { type: "create"; kind: UnitKind; parent: OrgUnit | null };

interface UnitDialogsValue {
  open: (dialog: UnitDialog) => void;
}

const UnitDialogsContext = createContext<UnitDialogsValue | null>(null);

export function useUnitDialogs(): UnitDialogsValue {
  const ctx = useContext(UnitDialogsContext);
  if (!ctx) throw new Error("useUnitDialogs needs <UnitDialogsProvider>");
  return ctx;
}

/** One instance of each dialog for the whole page; rows, the detail and the empty state open them. */
export function UnitDialogsProvider({
  byId,
  onCreated,
  children,
}: {
  byId: Map<string, OrgUnit>;
  onCreated: (unit: OrgUnit) => void;
  children: ReactNode;
}) {
  const [dialog, setDialog] = useState<UnitDialog | null>(null);
  // Keep the last dialog mounted while it animates out.
  const [last, setLast] = useState<UnitDialog | null>(null);
  const open = (d: UnitDialog) => {
    setLast(d);
    setDialog(d);
  };
  const close = () => setDialog(null);
  const shown = dialog ?? last;

  return (
    <UnitDialogsContext.Provider value={{ open }}>
      {children}
      {shown?.type === "create" ? (
        <CreateUnitDialog
          open={dialog?.type === "create"}
          onClose={close}
          kind={shown.kind}
          parent={shown.parent}
          byId={byId}
          onCreated={onCreated}
        />
      ) : null}
    </UnitDialogsContext.Provider>
  );
}

/** User-facing text for the units API's domain errors. */
export function unitErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "unit_name_taken":
        return "A unit with this name already exists here";
      case "unit_not_found":
        return "This unit no longer exists. Someone may have deleted it.";
      default:
        return errorMessage(err);
    }
  }
  return errorMessage(err);
}

// ---------------------------------------------------------------- actions menu

/** The per-unit menu (tree rows and the detail header). Renders nothing when the viewer has no action. */
export function UnitActionsMenu({
  unit,
  createKinds,
  className,
  variant = "ghost",
}: {
  unit: OrgUnit;
  /** Kinds that may be created inside this unit (`childKinds(unit.kind)` from unit-tree). */
  createKinds: readonly UnitKind[];
  className?: string;
  variant?: "ghost" | "outline";
}) {
  const dialogs = useUnitDialogs();
  if (!canManageUnit(unit) || createKinds.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant={variant}
            aria-label={`Actions for ${unit.name}`}
            data-testid="unit-menu"
            className={cn("text-muted-foreground", className)}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {createKinds.map((kind) => {
          const Icon = KIND_META[kind].icon;
          return (
            <DropdownMenuItem key={kind} onClick={() => dialogs.open({ type: "create", kind, parent: unit })}>
              <Icon /> Add {KIND_META[kind].label.toLowerCase()}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- create

function Location({ parent, byId }: { parent: OrgUnit | null; byId: Map<string, OrgUnit> }) {
  const me = useMe({ enabled: false });
  const trail = parent ? [...ancestorsOf(parent, byId), parent] : [];
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
      <span>{parent ? "Inside" : "At the top level of"}</span>
      {parent ? (
        trail.map((u, i) => (
          <span key={u.id} className="inline-flex min-w-0 items-center gap-1">
            {i > 0 ? <span aria-hidden>›</span> : null}
            <KindIcon kind={u.kind} className="size-4 rounded [&_svg]:size-2.5" />
            <span className="max-w-[12rem] truncate font-medium text-foreground">{u.name}</span>
          </span>
        ))
      ) : (
        <span className="font-medium text-foreground">
          {me.data?.organization.name ?? "your organization"}
        </span>
      )}
    </p>
  );
}

function CreateUnitDialog({
  open,
  onClose,
  kind,
  parent,
  byId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  kind: UnitKind;
  parent: OrgUnit | null;
  byId: Map<string, OrgUnit>;
  onCreated: (unit: OrgUnit) => void;
}) {
  const create = useCreateUnit();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const meta = KIND_META[kind];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setName("");
    setError(undefined);
    create.reset();
  }, [open, kind, parent?.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = UnitName.safeParse(name);
    if (!parsed.success) {
      setError(name.trim() ? "Use 80 characters or fewer" : "Enter a name");
      return;
    }
    try {
      const unit = await create.mutateAsync({ kind, name: parsed.data, parentId: parent?.id ?? null });
      toast.success(`${meta.label} “${unit.name}” created`);
      onCreated(unit);
      onClose();
    } catch (err) {
      setError(unitErrorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="unit-dialog">
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <KindIcon kind={kind} size="md" />
              <DialogTitle>
                {parent ? `Add ${meta.label.toLowerCase()}` : `New ${meta.label.toLowerCase()}`}
              </DialogTitle>
            </div>
            <DialogDescription>{meta.blurb}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <Label htmlFor="unit-name">Name</Label>
            <Input
              id="unit-name"
              autoFocus
              autoComplete="off"
              maxLength={80}
              placeholder={meta.placeholder}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
              }}
              aria-invalid={!!error}
              aria-describedby={error ? "unit-name-error" : "unit-name-location"}
            />
            {error ? (
              <p id="unit-name-error" role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : (
              <div id="unit-name-location">
                <Location parent={parent} byId={byId} />
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending} data-testid="unit-dialog-submit">
              {create.isPending ? <Spinner /> : <Plus />}
              Create {meta.label.toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
