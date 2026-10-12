"use client";

import type { RecordTemplate } from "@ocw/contracts";
import { LayoutTemplate, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cardNumberLabel, shownTitle } from "@/components/chat/board/card-tile";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useUnits } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { fromTemplate, previewTitle } from "@/lib/record-template-form";
import { useDeleteRecordTemplate, useRecordTemplates } from "@/lib/template-queries";
import { RecordTemplateDialog } from "./record-template-dialog";
import type { UnitNode } from "./unit-meta";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** `EXP-0001 · Customer · Summary`: the first card's number and title as a board built from the template shows them. */
export function templatePreviewLine(t: RecordTemplate): string {
  const draft = fromTemplate(t);
  const title = previewTitle(draft);
  const label = cardNumberLabel({ prefix: t.prefix, namingRule: t.namingRule }, t.prefix ? 1 : null);
  return label ? `${label} · ${shownTitle(title, label)}` : title;
}

/** `1 field · 4 columns · EXP-0001 · Customer · Summary` (07.1-UI-SPEC Copywriting › Record templates › Row meta). */
export function templateMeta(t: RecordTemplate): string {
  return `${plural(t.fields.length, "field")} · ${plural(t.columns.length, "column")}`;
}

type Editing = { kind: "new" } | { kind: "edit"; template: RecordTemplate } | null;

/**
 * Record templates on a unit's page (07.1-12, BOARD-06, D-06, D-08, P-08, P-13): the unit's own templates and the ones
 * it inherits (its ancestors' and organization-wide ones), read by every member. Managers (`canManage`, decided by the
 * API for this unit) create, edit and delete the unit's own templates; organization-wide ones are managed by whoever
 * holds `unit.manage` (admins). Inherited rows are never editable from here. The API re-decides every write.
 */
export function RecordTemplatesCard({ unit }: { unit: UnitNode }) {
  const list = useRecordTemplates(unit.id);
  const units = useUnits();
  const canManageOrg = useCan("unit.manage");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<RecordTemplate | null>(null);
  const canManage = list.data?.canManage ?? false;
  const names = useMemo(() => new Map((units.data?.units ?? []).map((u) => [u.id, u.name])), [units.data]);
  const templates = list.data?.templates ?? [];
  // Own templates first, then what the unit inherits (organization-wide, then root → parent), as the API orders them.
  const own = templates.filter((t) => t.unitId === unit.id);
  const inherited = templates.filter((t) => t.unitId !== unit.id);
  const rows = [...own, ...inherited];

  const editable = (t: RecordTemplate) =>
    t.unitId === unit.id ? canManage : t.unitId === null && canManageOrg;

  return (
    <section
      className="grid gap-3"
      data-testid="record-templates-card"
      aria-labelledby="record-templates-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h3
            id="record-templates-title"
            className="flex items-center gap-2 font-semibold text-[15px] tracking-tight"
          >
            Record templates
            {list.data && !canManage ? (
              <Badge variant="outline" data-testid="templates-read-only">
                Read-only
              </Badge>
            ) : null}
          </h3>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Shape board channels in this unit: fields, columns and how cards are named.
          </p>
        </div>
        {canManage ? (
          <Button
            size="sm"
            className="max-md:h-11"
            onClick={() => setEditing({ kind: "new" })}
            data-testid="new-template"
          >
            <Plus /> New template
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        {list.isLoading ? (
          <div className="grid gap-2 p-4" aria-busy="true">
            <span className="sr-only">Loading templates</span>
            <Skeleton className="h-4 w-1/3 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-2/3 motion-reduce:animate-none" />
          </div>
        ) : list.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(list.error)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div
            data-testid="templates-empty"
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 text-muted-foreground text-sm"
          >
            <span className="flex min-w-0 items-start gap-3">
              <LayoutTemplate className="mt-0.5 size-4 shrink-0" aria-hidden />
              {canManage
                ? `No templates yet. Boards in ${unit.name} start with Backlog, In progress, Done and Cancelled.`
                : `No templates for ${unit.name}. Boards here start with Backlog, In progress, Done and Cancelled.`}
            </span>
            {canManage ? (
              <Button
                size="sm"
                variant="outline"
                className="max-md:h-11"
                onClick={() => setEditing({ kind: "new" })}
              >
                <Plus /> New template
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                inheritedFrom={
                  t.unitId === unit.id
                    ? null
                    : t.unitId === null
                      ? "Organization-wide"
                      : `From ${names.get(t.unitId) ?? "a parent unit"}`
                }
                editable={editable(t)}
                onEdit={() => setEditing({ kind: "edit", template: t })}
                onDelete={() => setDeleting(t)}
              />
            ))}
          </ul>
        )}
      </div>

      {editing ? (
        <RecordTemplateDialog
          unit={unit}
          template={editing.kind === "edit" ? editing.template : null}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <DeleteTemplateDialog template={deleting} onClose={() => setDeleting(null)} />
    </section>
  );
}

function TemplateRow({
  template: t,
  inheritedFrom,
  editable,
  onEdit,
  onDelete,
}: {
  template: RecordTemplate;
  inheritedFrom: string | null;
  editable: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid="record-template-row"
      data-template-id={t.id}
      data-inherited={inheritedFrom ? "true" : undefined}
      className="flex items-start gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-semibold text-sm" data-testid="record-template-name">
            {t.name}
          </span>
          {t.prefix ? (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-muted-foreground text-xs tabular-nums">
              {t.prefix}
            </span>
          ) : null}
          {inheritedFrom ? (
            <Badge variant="outline" data-testid="record-template-scope">
              {inheritedFrom}
            </Badge>
          ) : null}
        </p>
        <p className="mt-1 text-muted-foreground text-xs" data-testid="record-template-meta">
          {templateMeta(t)} ·{" "}
          <span className="break-words font-mono tabular-nums">{templatePreviewLine(t)}</span>
        </p>
      </div>
      {editable ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-1 -mr-1 shrink-0 text-muted-foreground max-md:size-11 max-md:-my-2.5 max-md:-mr-2.5"
                aria-label={`${t.name} template actions`}
                data-testid="record-template-menu"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit template…
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete template…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function DeleteTemplateDialog({
  template,
  onClose,
}: {
  template: RecordTemplate | null;
  onClose: () => void;
}) {
  const remove = useDeleteRecordTemplate();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState<RecordTemplate | null>(template);
  if (template && template !== shown) setShown(template);
  const t = template ?? shown;
  return (
    <Dialog
      open={template !== null}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          remove.reset();
        }
      }}
    >
      <DialogContent data-testid="delete-template-dialog" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Delete “{t?.name}”?</DialogTitle>
          <DialogDescription>
            Boards already created from it keep their columns, fields and numbering. New boards can't use it.
          </DialogDescription>
        </DialogHeader>
        {remove.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(remove.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={onClose} className="max-md:h-11">
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending || !t}
            className="max-md:h-11"
            data-testid="confirm-delete-template"
            onClick={() =>
              t &&
              remove.mutate(t.id, {
                onSuccess: () => {
                  onClose();
                  toast.success(`“${t.name}” deleted`);
                },
              })
            }
          >
            {remove.isPending ? <Spinner /> : <Trash2 />} Delete template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
