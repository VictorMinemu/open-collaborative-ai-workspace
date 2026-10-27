"use client";

import { WORK_PROJECT_LIMITS, type WorkProjectParent } from "@ocw/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { KindIcon } from "@/components/organization/unit-meta";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateWorkProject, useWorkProjectParents } from "@/lib/work-project-queries";
import { projectHref } from "@/lib/work-zone-routes";
import { trailText } from "./project-labels";

export const NEW_PROJECT_COPY = {
  title: "New project",
  description:
    "A team project groups people, teams and repositories. Its sessions are visible to everyone in it by default.",
  name: "Name",
  placeholder: "e.g. Customer portal",
  inside: "Inside",
  submit: "Create project",
  nameMissing: "Enter a name",
  created: (name: string) => `${name} created`,
} as const;

/** The unit a project sits under, as the select shows it: "Engineering › Web" (the full path, never ambiguous). */
export const parentLabel = (p: Pick<WorkProjectParent, "name" | "trail">) =>
  p.trail.length > 0 ? `${trailText(p.trail)} › ${p.name}` : p.name;

/**
 * The unit the dialog creates under: the person's own choice, else `defaultParentId` when it is one of the units the API
 * says they may create in (07.10-05, R6: a section "+" preselects its unit; anything else is ignored, never forced),
 * else the first of them.
 */
export function chosenParent<P extends { id: string }>(
  parents: readonly P[],
  parentId: string | null,
  defaultParentId?: string,
): P | null {
  return (
    parents.find((p) => p.id === parentId) ??
    parents.find((p) => p.id === defaultParentId) ??
    parents[0] ??
    null
  );
}

/**
 * `NewProjectDialog` (UI-SPEC § 4.4, D-10, D-13): a name and the team or department it sits under, from the units the
 * API says the viewer may create in. There is no option at the root: a team project always has a team or department above it.
 * The created project opens on its Settings tab.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  defaultParentId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The unit to preselect (the Work Zone sidebar's section "+", 07.10-05); ignored unless the viewer may create there. */
  defaultParentId?: string | undefined;
}) {
  const router = useRouter();
  const parents = useWorkProjectParents(open);
  const create = useCreateWorkProject();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const list = parents.data ?? [];
  const chosen = chosenParent(list, parentId, defaultParentId);

  const reset = () => {
    setName("");
    setParentId(null);
    setNameError(undefined);
    setFormError(undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(NEW_PROJECT_COPY.nameMissing);
      return;
    }
    if (!chosen) return;
    create.mutate(
      { name: trimmed, parentId: chosen.id },
      {
        onSuccess: (project) => {
          toast.success(NEW_PROJECT_COPY.created(project.name));
          onOpenChange(false);
          reset();
          router.push(projectHref(project.id, "settings"));
        },
        onError: (err) => {
          if (isApiError(err, 409)) {
            setNameError(`${chosen.name} already has a unit named ${trimmed}.`);
            return;
          }
          setFormError(errorMessage(err));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent data-testid="new-project-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{NEW_PROJECT_COPY.title}</DialogTitle>
          <DialogDescription>{NEW_PROJECT_COPY.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <FormField id="project-name" label={NEW_PROJECT_COPY.name} error={nameError}>
            <Input
              id="project-name"
              autoFocus
              autoComplete="off"
              placeholder={NEW_PROJECT_COPY.placeholder}
              value={name}
              maxLength={WORK_PROJECT_LIMITS.nameMax}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(undefined);
                setFormError(undefined);
              }}
              aria-invalid={!!nameError}
              aria-describedby={describedBy("project-name", nameError)}
              className="max-sm:h-11 max-sm:text-base"
            />
          </FormField>
          <FormField id="project-parent" label={NEW_PROJECT_COPY.inside}>
            <ParentSelect
              id="project-parent"
              parents={list}
              value={chosen?.id ?? null}
              loading={parents.isLoading}
              onChange={setParentId}
            />
          </FormField>
          {formError ? (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="max-sm:h-11"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="max-sm:h-11"
              disabled={create.isPending || !chosen}
              data-testid="new-project-submit"
            >
              {create.isPending ? <Spinner /> : null}
              {NEW_PROJECT_COPY.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The "Inside" select (the `ChannelUnitSelect` markup): `KindIcon` + name + trail, teams and departments only. */
export function ParentSelect({
  id,
  parents,
  value,
  loading,
  onChange,
}: {
  id: string;
  parents: readonly WorkProjectParent[];
  value: string | null;
  loading: boolean;
  onChange: (id: string) => void;
}) {
  const items = parents.map((p) => ({ value: p.id, label: parentLabel(p) }));
  return (
    <Select items={items} value={value} onValueChange={(v) => (v ? onChange(String(v)) : undefined)}>
      <SelectTrigger
        id={id}
        data-testid="new-project-parent"
        aria-label={NEW_PROJECT_COPY.inside}
        placeholder={loading ? "Loading…" : "Choose a team or department"}
        disabled={loading || parents.length === 0}
        className="max-sm:h-11"
      />
      <SelectContent className="max-h-72 overflow-y-auto">
        {parents.map((p) => (
          <SelectItem
            key={p.id}
            value={p.id}
            data-testid="new-project-parent-option"
            className="max-md:min-h-11"
          >
            <span className="flex min-w-0 items-center gap-2">
              <KindIcon kind={p.kind} size="sm" />
              <span className="grid min-w-0">
                <span className="truncate">{p.name}</span>
                {p.trail.length > 0 ? (
                  <span className="truncate text-muted-foreground text-xs">{trailText(p.trail)}</span>
                ) : null}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
