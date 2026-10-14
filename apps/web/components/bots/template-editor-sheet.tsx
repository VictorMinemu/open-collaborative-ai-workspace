"use client";

import {
  type AgentTemplate,
  type AgentTemplateVersionBody,
  MAX_DAILY_LIMIT,
  modelLabel,
} from "@ocw/contracts";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  shortTool,
  useCreateTemplate,
  usePublishTemplateVersion,
  useTemplateOptions,
  useUpdateTemplate,
} from "@/lib/agent-template-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useModels } from "@/lib/bots-queries";
import { formatDate } from "@/lib/utils";
import { SheetSection } from "./bot-form";

/** Where a template may live (`unitId` null = the organization). */
export interface ManageableUnit {
  unitId: string | null;
  name: string;
}

interface Values {
  /** "" = the organization. */
  unitId: string;
  name: string;
  description: string;
  instructions: string;
  /** `provider/modelId`. */
  model: string;
  internet: boolean;
  memory: boolean;
  dailyLimit: string;
  tools: string[];
  connectors: string[];
  keys: string[];
}

type Errors = Partial<Record<"name" | "instructions" | "model" | "dailyLimit", string>>;

const toolKey = (g: { sourceKind: string; sourceId: string; toolName: string }) =>
  `${g.sourceKind}:${g.sourceId}:${g.toolName}`;
const modelKeyOf = (provider: string, modelId: string) => `${provider}/${modelId}`;
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function valuesOf(t: AgentTemplate): Values {
  const v = t.latest;
  return {
    unitId: t.unitId ?? "",
    name: t.name,
    description: t.description,
    instructions: v.instructions,
    model: modelKeyOf(v.modelProvider, v.modelId),
    internet: v.capabilities.internet,
    memory: v.capabilities.memory,
    dailyLimit: v.capabilities.dailyLimit === null ? "" : String(v.capabilities.dailyLimit),
    tools: v.toolGrants.map(toolKey),
    connectors: v.requiredConnectorIds,
    keys: v.unitVaultItemIds,
  };
}

/** The version fields differ from the template's latest version (publishing makes a new version). */
function versionChanged(a: Values, b: Values): boolean {
  return (
    a.instructions.trim() !== b.instructions.trim() ||
    a.model !== b.model ||
    a.internet !== b.internet ||
    a.memory !== b.memory ||
    a.dailyLimit.trim() !== b.dailyLimit.trim() ||
    !sameSet(a.tools, b.tools) ||
    !sameSet(a.connectors, b.connectors) ||
    !sameSet(a.keys, b.keys)
  );
}

/**
 * Template editor (`template-editor`, 07.4-UI-SPEC § 4): a right sheet (full width at 390) with Basics, Behaviour,
 * Capabilities, Tools, Connectors and Keys. New → `Publish v1`; an edit of a version field → `Publish v{n+1}` (a new
 * immutable version); a name or description edit only → `Save`. Closing with unsaved changes asks first.
 */
export function TemplateEditorSheet({
  open,
  template,
  manageableUnits,
  onClose,
}: {
  open: boolean;
  /** null = a new template. */
  template: AgentTemplate | null;
  manageableUnits: ManageableUnit[];
  onClose: () => void;
}) {
  const models = useModels();
  const create = useCreateTemplate();
  const publish = usePublishTemplateVersion();
  const update = useUpdateTemplate();
  const available = models.data?.models ?? [];
  const defaultModel = available.find((m) => m.isDefault) ?? available[0];

  const blank = (): Values => ({
    unitId: manageableUnits[0]?.unitId ?? "",
    name: "",
    description: "",
    instructions: "",
    model: defaultModel ? modelKeyOf(defaultModel.provider, defaultModel.modelId) : "",
    internet: false,
    memory: true,
    dailyLimit: "30",
    tools: [],
    connectors: [],
    keys: [],
  });
  const [initial, setInitial] = useState<Values>(() => (template ? valuesOf(template) : blank()));
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [unitNote, setUnitNote] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);

  // A fresh form each time the sheet opens (or opens on another template).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on open and the template id on purpose
  useEffect(() => {
    if (!open) return;
    const start = template ? valuesOf(template) : blank();
    setInitial(start);
    setValues(start);
    setErrors({});
    setUnitNote(null);
    setConfirmDiscard(false);
  }, [open, template?.id]);

  // The default model arrives after the first render of a new template.
  useEffect(() => {
    if (!template && !values.model && defaultModel) {
      const model = modelKeyOf(defaultModel.provider, defaultModel.modelId);
      setValues((v) => ({ ...v, model }));
      setInitial((v) => ({ ...v, model }));
    }
  }, [template, values.model, defaultModel]);

  const unitId = values.unitId || null;
  const options = useTemplateOptions(unitId, open);
  const unitName = (id: string) =>
    manageableUnits.find((u) => (u.unitId ?? "") === id)?.name ?? (template?.unitName || "Organization");

  const versionDirty = versionChanged(values, initial);
  const metaDirty =
    values.name.trim() !== initial.name.trim() || values.description.trim() !== initial.description.trim();
  const dirty = !template || versionDirty || metaDirty || values.unitId !== initial.unitId;
  const pending = create.isPending || publish.isPending || update.isPending;
  const nextVersion = template ? template.currentVersion + 1 : 1;
  const label = !template || versionDirty ? `Publish v${nextVersion}` : "Save";
  const canSubmit = template ? versionDirty || metaDirty : true;
  const id = (k: string) => `template-editor-${k}`;

  function set(patch: Partial<Values>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors({});
  }

  function toggle(list: "tools" | "connectors" | "keys", key: string, on: boolean) {
    setValues((v) => ({ ...v, [list]: on ? [...v[list], key] : v[list].filter((x) => x !== key) }));
  }

  function changeUnit(next: string) {
    if (next === values.unitId) return;
    const hadKeys = values.keys.length > 0;
    setUnitNote(hadKeys ? `Keys of ${unitName(values.unitId)} were removed.` : null);
    // Tools come from the organization's catalog, so they stay; keys belong to the old unit.
    set({ unitId: next, keys: [] });
  }

  function requestClose() {
    if (dirty && (template ? versionDirty || metaDirty : values.name || values.instructions)) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function body(): AgentTemplateVersionBody | null {
    const e: Errors = {};
    if (!values.name.trim()) e.name = "Give the template a name";
    if (!values.instructions.trim()) e.instructions = "Write the instructions";
    if (!values.model) e.model = "Pick a model";
    const limit = Number(values.dailyLimit.trim());
    const limitOk = /^\d+$/.test(values.dailyLimit.trim()) && limit >= 1 && limit <= MAX_DAILY_LIMIT;
    if (!limitOk) e.dailyLimit = `Use a whole number from 1 to ${MAX_DAILY_LIMIT}`;
    setErrors(e);
    if (Object.keys(e).length > 0) return null;
    const [provider = "", ...rest] = values.model.split("/");
    const byKey = new Map((options.data?.tools ?? []).map((t) => [toolKey(t), t]));
    const previous = new Map((template?.latest.toolGrants ?? []).map((g) => [toolKey(g), g]));
    return {
      instructions: values.instructions.trim(),
      modelProvider: provider as AgentTemplateVersionBody["modelProvider"],
      modelId: rest.join("/"),
      capabilities: { internet: values.internet, memory: values.memory, dailyLimit: limit },
      toolGrants: values.tools.flatMap((k) => {
        const g = byKey.get(k) ?? previous.get(k);
        return g ? [{ sourceKind: g.sourceKind, sourceId: g.sourceId, toolName: g.toolName }] : [];
      }),
      requiredConnectorIds: values.connectors,
      unitVaultItemIds: values.keys,
    };
  }

  function apiError(err: unknown) {
    if (isApiError(err, 409) && err.code === "template_name_taken") {
      setErrors({ name: `A template named “${values.name.trim()}” already exists here` });
    } else {
      toast.error("Could not save the template", { description: errorMessage(err) });
    }
  }

  async function submit() {
    const version = body();
    if (!version) return;
    const name = values.name.trim();
    try {
      if (!template) {
        await create.mutateAsync({
          unitId,
          name,
          description: values.description.trim(),
          version,
        });
        toast.success(`${name} published as v1`);
      } else {
        if (metaDirty) {
          await update.mutateAsync({
            id: template.id,
            body: { name, description: values.description.trim() },
          });
        }
        if (versionDirty) {
          const t = await publish.mutateAsync({ id: template.id, body: version });
          toast.success(`${name} published as v${t.currentVersion}`);
        } else {
          toast.success(`${name} saved`);
        }
      }
      onClose();
    } catch (err) {
      apiError(err);
    }
  }

  const opts = options.data;
  const created = template?.latest;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && requestClose()}>
        <SheetContent
          side="right"
          showClose={false}
          className="w-full max-w-full sm:w-[40rem] sm:max-w-[92vw]"
          data-testid="template-editor"
        >
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">
                {template ? `Edit ${template.name}` : "New template"}
              </SheetTitle>
              {created ? (
                <SheetDescription className="mt-0.5 text-xs" data-testid="template-editor-version">
                  v{created.version} · published {formatDate(created.createdAt)}
                  {created.createdByName ? ` by ${created.createdByName}` : ""}
                </SheetDescription>
              ) : (
                <SheetDescription className="sr-only">
                  A template people in its unit can start their own agent from.
                </SheetDescription>
              )}
            </div>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className="-my-1 -mr-2 shrink-0 text-muted-foreground max-md:size-11"
                />
              }
            >
              <X />
            </SheetClose>
          </div>

          <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-5 py-5">
            <SheetSection title="Basics">
              <div className="grid gap-4">
                {template ? (
                  <div className="grid gap-1">
                    <span className="font-medium text-sm">Available in</span>
                    <span className="text-muted-foreground text-sm">
                      {template.unitName ?? "Organization"}
                    </span>
                  </div>
                ) : (
                  <FormField id={id("unit")} label="Available in">
                    <Select
                      items={manageableUnits.map((u) => ({ value: u.unitId ?? "", label: u.name }))}
                      value={values.unitId}
                      onValueChange={(v) => changeUnit(String(v ?? ""))}
                    >
                      <SelectTrigger id={id("unit")} data-testid="template-unit" className="max-md:h-11" />
                      <SelectContent>
                        {manageableUnits.map((u) => (
                          <SelectItem
                            key={u.unitId ?? "org"}
                            value={u.unitId ?? ""}
                            data-testid="template-unit-option"
                            data-unit-name={u.name}
                            className="max-md:min-h-11"
                          >
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                )}
                {unitNote ? (
                  <p className="text-muted-foreground text-xs" role="status">
                    {unitNote}
                  </p>
                ) : null}
                <FormField id={id("name")} label="Name" error={errors.name}>
                  <Input
                    id={id("name")}
                    data-testid="template-name"
                    value={values.name}
                    maxLength={80}
                    onChange={(e) => set({ name: e.target.value })}
                    aria-invalid={!!errors.name}
                    aria-describedby={describedBy(id("name"), errors.name)}
                    className="max-md:h-11"
                  />
                </FormField>
                <FormField id={id("description")} label="Description (optional)">
                  <Textarea
                    id={id("description")}
                    data-testid="template-description"
                    rows={2}
                    maxLength={500}
                    value={values.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                </FormField>
              </div>
            </SheetSection>

            <SheetSection title="Behaviour">
              <div className="grid gap-4">
                <FormField id={id("instructions")} label="Instructions" error={errors.instructions}>
                  <Textarea
                    id={id("instructions")}
                    data-testid="template-instructions"
                    rows={8}
                    value={values.instructions}
                    onChange={(e) => set({ instructions: e.target.value })}
                    aria-invalid={!!errors.instructions}
                    aria-describedby={describedBy(id("instructions"), errors.instructions)}
                  />
                </FormField>
                <FormField id={id("model")} label="Model" error={errors.model}>
                  <Select
                    items={available.map((m) => ({
                      value: modelKeyOf(m.provider, m.modelId),
                      label: m.label,
                    }))}
                    value={values.model || null}
                    onValueChange={(v) => v && set({ model: String(v) })}
                  >
                    <SelectTrigger
                      id={id("model")}
                      data-testid="template-model"
                      placeholder="Choose a model"
                      aria-invalid={!!errors.model}
                      className="max-md:h-11"
                    />
                    <SelectContent>
                      {available.map((m) => (
                        <SelectItem
                          key={modelKeyOf(m.provider, m.modelId)}
                          value={modelKeyOf(m.provider, m.modelId)}
                          className="max-md:min-h-11"
                        >
                          {m.label || modelLabel(m.provider, m.modelId)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
            </SheetSection>

            <SheetSection title="Capabilities">
              <div className="grid divide-y rounded-lg border">
                {(["internet", "memory"] as const).map((cap) => (
                  <label
                    key={cap}
                    htmlFor={id(cap)}
                    className="flex min-h-11 cursor-pointer items-center justify-between gap-4 px-3 py-2"
                  >
                    <span className="font-medium text-sm">{cap === "internet" ? "Internet" : "Memory"}</span>
                    <Switch
                      id={id(cap)}
                      checked={values[cap]}
                      onCheckedChange={(on) => set({ [cap]: on } as Partial<Values>)}
                      data-testid={`template-${cap}`}
                    />
                  </label>
                ))}
                <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
                  <label htmlFor={id("daily")} className="font-medium text-sm">
                    Daily limit
                  </label>
                  <Input
                    id={id("daily")}
                    data-testid="template-daily-limit"
                    inputMode="numeric"
                    value={values.dailyLimit}
                    onChange={(e) => set({ dailyLimit: e.target.value })}
                    aria-invalid={!!errors.dailyLimit}
                    aria-describedby={errors.dailyLimit ? `${id("daily")}-error` : undefined}
                    className="w-24 text-right max-md:h-11"
                  />
                </div>
              </div>
              {errors.dailyLimit ? (
                <p id={`${id("daily")}-error`} role="alert" className="text-[13px] text-destructive">
                  {errors.dailyLimit}
                </p>
              ) : null}
            </SheetSection>

            <SheetSection title="Tools">
              {options.isPending ? (
                <OptionSkeleton />
              ) : !opts || opts.tools.length === 0 ? (
                <p className="text-muted-foreground text-sm">No tools yet</p>
              ) : (
                <ul className="grid divide-y rounded-lg border" aria-label="Tools">
                  {opts.tools.map((t) => {
                    const key = toolKey(t);
                    return (
                      <li key={key}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-primary"
                            checked={values.tools.includes(key)}
                            onChange={(e) => toggle("tools", key, e.target.checked)}
                            data-testid="template-tool"
                            data-tool={shortTool(t.toolName)}
                            data-source={t.sourceName}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[13px]">
                              {shortTool(t.toolName)}
                            </span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {t.sourceName}
                            </span>
                          </span>
                          {t.personalAllowed ? null : (
                            <Badge variant="outline">Not for personal agents</Badge>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SheetSection>

            <SheetSection title="Connectors">
              <p className="-mt-1 text-muted-foreground text-xs">Members are asked to connect these.</p>
              {options.isPending ? (
                <OptionSkeleton />
              ) : !opts || opts.connectors.length === 0 ? (
                <p className="text-muted-foreground text-sm">No member connectors yet</p>
              ) : (
                <ul className="flex flex-wrap gap-2" aria-label="Connectors">
                  {opts.connectors.map((c) => (
                    <li key={c.serverId}>
                      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm max-md:h-11">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={values.connectors.includes(c.serverId)}
                          onChange={(e) => toggle("connectors", c.serverId, e.target.checked)}
                          data-testid="template-connector"
                          data-connector={c.name}
                        />
                        {c.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </SheetSection>

            <SheetSection title="Keys">
              <p className="-mt-1 text-muted-foreground text-xs">Unit keys the agent may use.</p>
              {options.isPending ? (
                <OptionSkeleton />
              ) : !opts || opts.vaultItems.length === 0 ? (
                <p className="text-muted-foreground text-sm">No unit keys in {unitName(values.unitId)}</p>
              ) : (
                <ul className="grid divide-y rounded-lg border" aria-label="Keys">
                  {opts.vaultItems.map((k) => (
                    <li key={k.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-primary"
                          checked={values.keys.includes(k.id)}
                          onChange={(e) => toggle("keys", k.id, e.target.checked)}
                          data-testid="template-key"
                        />
                        <span className="min-w-0 flex-1 truncate">{k.name}</span>
                        <span className="font-mono text-muted-foreground text-xs">{k.handle}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </SheetSection>
          </div>

          <div className="grid gap-3 border-t bg-muted/30 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-xs">
              Agents already started keep their version until their owner updates.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={requestClose} className="max-md:h-11">
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={!canSubmit || pending}
                data-testid="template-publish"
                className="max-md:h-11"
              >
                {pending ? <Spinner /> : null}
                {label}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={confirmDiscard} onOpenChange={(o) => !o && setConfirmDiscard(false)}>
        <DialogContent initialFocus={keepRef} data-testid="template-discard">
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>Your edits to this template are not saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={keepRef}
              variant="outline"
              onClick={() => setConfirmDiscard(false)}
              className="max-md:h-11"
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="max-md:h-11"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OptionSkeleton() {
  return (
    <div className="grid gap-2" aria-hidden>
      <Skeleton className="h-10 w-full rounded-lg" />
      <Skeleton className="h-10 w-full rounded-lg" />
    </div>
  );
}
