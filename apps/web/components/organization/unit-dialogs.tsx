"use client";

import { ALLOWED_PARENT_KINDS, type OrgUnit, type UnitKind, UnitName } from "@ocw/contracts";
import { Check, FolderInput, MoreHorizontal, Network, Pencil, Plus, Trash2 } from "lucide-react";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateUnit, useDeleteUnit, useMoveUnit, useRenameUnit } from "@/lib/org-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  canManageUnit,
  KIND_META,
  KindIcon,
  type UnitNode,
  type UnitTreeModel,
} from "./unit-meta";

// ---------------------------------------------------------------- dialog state

export type UnitDialog =
  | { type: "create"; kind: UnitKind; parent: OrgUnit | null }
  | { type: "rename"; unit: UnitNode }
  | { type: "move"; unit: UnitNode }
  | { type: "delete"; unit: UnitNode };

interface UnitDialogsValue {
  open: (dialog: UnitDialog) => void;
}

const UnitDialogsContext = createContext<UnitDialogsValue | null>(null);

export function useUnitDialogs(): UnitDialogsValue {
  const ctx = useContext(UnitDialogsContext);
  if (!ctx) throw new Error("useUnitDialogs needs <UnitDialogsProvider>");
  return ctx;
}

/** Shown on a unit that still holds teams or projects (the API answers 409 unit_has_children). */
export const DELETE_BLOCKED_HINT = "Remove its teams and projects first";

/** One instance of each dialog for the whole page; rows, the detail and the empty state open them. */
export function UnitDialogsProvider({
  tree,
  onCreated,
  onMoved,
  onDeleted,
  children,
}: {
  tree: UnitTreeModel;
  onCreated: (unit: OrgUnit) => void;
  onMoved: (unit: OrgUnit) => void;
  onDeleted: (unit: OrgUnit) => void;
  children: ReactNode;
}) {
  const [dialog, setDialog] = useState<UnitDialog | null>(null);
  // Keep the last dialog mounted while it animates out.
  const [last, setLast] = useState<UnitDialog | null>(null);
  const open = useCallback((d: UnitDialog) => {
    setLast(d);
    setDialog(d);
  }, []);
  const close = () => setDialog(null);
  const shown = dialog ?? last;
  const isOpen = (type: UnitDialog["type"]) => dialog?.type === type;
  const value = useMemo(() => ({ open }), [open]);

  return (
    <UnitDialogsContext.Provider value={value}>
      {children}
      {shown?.type === "create" ? (
        <CreateUnitDialog
          open={isOpen("create")}
          onClose={close}
          kind={shown.kind}
          parent={shown.parent}
          byId={tree.byId}
          onCreated={onCreated}
        />
      ) : shown?.type === "rename" ? (
        <RenameUnitDialog open={isOpen("rename")} onClose={close} unit={shown.unit} />
      ) : shown?.type === "move" ? (
        <MoveUnitDialog
          open={isOpen("move")}
          onClose={close}
          unit={shown.unit}
          tree={tree}
          onMoved={onMoved}
        />
      ) : shown?.type === "delete" ? (
        <DeleteUnitDialog open={isOpen("delete")} onClose={close} unit={shown.unit} onDeleted={onDeleted} />
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
      case "unit_cycle":
        return "A unit cannot move inside itself";
      case "unit_has_children":
        return DELETE_BLOCKED_HINT;
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
  unit: UnitNode;
  /** Kinds that may be created inside this unit (`childKinds(unit.kind)` from unit-tree). */
  createKinds: readonly UnitKind[];
  className?: string;
  variant?: "ghost" | "outline";
}) {
  const dialogs = useUnitDialogs();
  // Rename, move, delete and create all need unit.manage on the unit (decided by the API, viewerCan).
  if (!canManageUnit(unit)) return null;
  const hasChildren = unit.children.length > 0;

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
      <DropdownMenuContent align="end" className="w-60" onClick={(e) => e.stopPropagation()}>
        {createKinds.map((kind) => {
          const Icon = KIND_META[kind].icon;
          return (
            <DropdownMenuItem key={kind} onClick={() => dialogs.open({ type: "create", kind, parent: unit })}>
              <Icon /> Add {KIND_META[kind].label.toLowerCase()}
            </DropdownMenuItem>
          );
        })}
        {createKinds.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onClick={() => dialogs.open({ type: "rename", unit })}>
          <Pencil /> Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => dialogs.open({ type: "move", unit })}>
          <FolderInput /> Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={hasChildren}
          onClick={() => dialogs.open({ type: "delete", unit })}
          className="items-start"
        >
          <Trash2 className="mt-0.5" />
          <span className="grid gap-0.5">
            Delete…
            {hasChildren ? (
              <span data-testid="delete-blocked" className="font-normal text-muted-foreground text-xs">
                {DELETE_BLOCKED_HINT}
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
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

// ---------------------------------------------------------------- rename

function RenameUnitDialog({ open, onClose, unit }: { open: boolean; onClose: () => void; unit: UnitNode }) {
  const rename = useRenameUnit();
  const [name, setName] = useState(unit.name);
  const [error, setError] = useState<string | undefined>();
  const meta = KIND_META[unit.kind];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setName(unit.name);
    setError(undefined);
    rename.reset();
  }, [open, unit.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = UnitName.safeParse(name);
    if (!parsed.success) {
      setError(name.trim() ? "Use 80 characters or fewer" : "Enter a name");
      return;
    }
    if (parsed.data === unit.name) {
      onClose();
      return;
    }
    try {
      const updated = await rename.mutateAsync({ id: unit.id, name: parsed.data });
      toast.success(`Renamed to “${updated.name}”`);
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
              <KindIcon kind={unit.kind} size="md" />
              <DialogTitle>Rename {meta.label.toLowerCase()}</DialogTitle>
            </div>
            <DialogDescription>Members, leads and access rules stay as they are.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <Label htmlFor="unit-rename">Name</Label>
            <Input
              id="unit-rename"
              autoFocus
              autoComplete="off"
              maxLength={80}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
              }}
              onFocus={(e) => e.currentTarget.select()}
              aria-invalid={!!error}
              aria-describedby={error ? "unit-rename-error" : undefined}
            />
            {error ? (
              <p id="unit-rename-error" role="alert" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending} data-testid="unit-dialog-submit">
              {rename.isPending ? <Spinner /> : <Check />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- move

interface MoveOption {
  /** null = the organization's top level. */
  id: string | null;
  unit: UnitNode | null;
  label: string;
  hint: string;
  disabled: boolean;
  current: boolean;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parent picker: the organization's top level and every unit whose kind may contain `unit`
 * (ALLOWED_PARENT_KINDS). The unit itself and its own subtree are disabled; the API rejects cycles anyway
 * (409 unit_cycle under the per-organization lock).
 */
function moveOptions(unit: UnitNode, tree: UnitTreeModel, orgName: string): MoveOption[] {
  const allowed = ALLOWED_PARENT_KINDS[unit.kind];
  const plural = KIND_META[unit.kind].plural;
  const top: MoveOption = {
    id: null,
    unit: null,
    label: `${orgName} (top level)`,
    current: unit.parentId === null,
    disabled: !allowed.includes(null) || unit.parentId === null,
    hint: !allowed.includes(null)
      ? `${capitalize(plural)} cannot be top level`
      : unit.parentId === null
        ? "Current location"
        : "Top level of the organization",
  };
  const units = tree.ordered
    .filter((u) => allowed.includes(u.kind))
    .map((u): MoveOption => {
      const own = u.id === unit.id || u.path.includes(unit.id);
      const current = unit.parentId === u.id;
      const trail = ancestorsOf(u, tree.byId)
        .map((a) => a.name)
        .join(" › ");
      return {
        id: u.id,
        unit: u,
        label: u.name,
        current,
        disabled: own || current || !canManageUnit(u),
        hint: own
          ? u.id === unit.id
            ? `This ${KIND_META[unit.kind].label.toLowerCase()}`
            : `Inside ${unit.name}`
          : current
            ? "Current location"
            : !canManageUnit(u)
              ? "You cannot manage this unit"
              : trail || "Top level",
      };
    });
  return [top, ...units];
}

function MoveUnitDialog({
  open,
  onClose,
  unit,
  tree,
  onMoved,
}: {
  open: boolean;
  onClose: () => void;
  unit: UnitNode;
  tree: UnitTreeModel;
  onMoved: (unit: OrgUnit) => void;
}) {
  const move = useMoveUnit();
  const me = useMe({ enabled: false });
  /** undefined = nothing chosen yet; null = top level. */
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();
  const options = moveOptions(unit, tree, me.data?.organization.name ?? "Organization");
  const meta = KIND_META[unit.kind];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setTarget(undefined);
    setError(undefined);
    move.reset();
  }, [open, unit.id]);

  async function onSubmit() {
    if (target === undefined) return;
    try {
      const moved = await move.mutateAsync({ id: unit.id, parentId: target });
      const where = target === null ? "the top level" : (tree.byId.get(target)?.name ?? "its new parent");
      toast.success(`Moved “${moved.name}” to ${where}`);
      onMoved(moved);
      onClose();
    } catch (err) {
      setError(unitErrorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="move-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-3">
            <KindIcon kind={unit.kind} size="md" />
            <DialogTitle className="truncate">Move “{unit.name}”</DialogTitle>
          </div>
          <DialogDescription>
            Choose its new parent. Everything inside it moves too; members and leads keep their place.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            role="radiogroup"
            aria-label={`New parent for ${unit.name}`}
            className="scrollbar-thin max-h-[min(22rem,45dvh)] divide-y overflow-y-auto rounded-xl border"
          >
            {options.map((o) => {
              const checked = target === o.id && !o.disabled;
              return (
                <button
                  key={o.id ?? "root"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={o.disabled}
                  data-testid="move-target"
                  data-target={o.id ?? "root"}
                  onClick={() => {
                    setTarget(o.id);
                    setError(undefined);
                  }}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors first:rounded-t-xl last:rounded-b-xl",
                    "focus-visible:bg-accent/60 enabled:hover:bg-accent/50 disabled:cursor-not-allowed",
                    checked && "bg-primary/8 enabled:hover:bg-primary/10",
                  )}
                >
                  {o.unit ? (
                    <KindIcon kind={o.unit.kind} size="md" className={cn(o.disabled && "opacity-50")} />
                  ) : (
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
                        o.disabled && "opacity-50",
                      )}
                    >
                      <Network className="size-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate font-medium text-sm",
                        o.disabled && "text-muted-foreground",
                      )}
                      title={o.label}
                    >
                      {o.label}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs" title={o.hint}>
                      {o.hint}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      o.disabled && "opacity-40",
                    )}
                  >
                    {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={target === undefined || move.isPending}
            onClick={() => void onSubmit()}
            data-testid="move-submit"
          >
            {move.isPending ? <Spinner /> : <FolderInput />}
            Move {meta.label.toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- delete

function DeleteUnitDialog({
  open,
  onClose,
  unit,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  unit: UnitNode;
  onDeleted: (unit: OrgUnit) => void;
}) {
  const del = useDeleteUnit();
  const [error, setError] = useState<string | undefined>();
  const kind = KIND_META[unit.kind].label.toLowerCase();

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    del.reset();
  }, [open, unit.id]);

  async function onConfirm() {
    try {
      await del.mutateAsync(unit.id);
      toast.success(`“${unit.name}” deleted`);
      onDeleted(unit);
      onClose();
    } catch (err) {
      setError(unitErrorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="delete-unit-dialog">
        <DialogHeader>
          <DialogTitle className="break-words">Delete “{unit.name}”?</DialogTitle>
          <DialogDescription>
            {unit.memberCount > 0
              ? `${unit.memberCount} ${unit.memberCount === 1 ? "person loses" : "people lose"} the access they get through this ${kind}. `
              : ""}
            Access rules scoped to it are deleted too. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() => void onConfirm()}
            data-testid="confirm-delete-unit"
          >
            {del.isPending ? <Spinner /> : <Trash2 />} Delete {kind}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
