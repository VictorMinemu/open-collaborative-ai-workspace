"use client";

import { type ChannelLayout, CreateChannelRequest, type OrgUnit, type RecordTemplate } from "@ocw/contracts";
import { Building2, Globe, Hash, Lock, type LucideIcon, SquareKanban } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CategoryIcon } from "@/components/chat/board/column-header";
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
import { useChannels, useCreateChannel } from "@/lib/chat-queries";
import { useUnits } from "@/lib/org-queries";
import { usePermissionCheck } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { useRecordTemplates } from "@/lib/template-queries";
import { cn } from "@/lib/utils";

/** "Product Launch!" → "product-launch" (as you type, like Slack). */
export function toChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

/** Select value of "the organization" (Base UI selects need a string). */
export const ORG_UNIT_VALUE = "org";

export interface PlaceableUnit {
  id: string;
  /** "Product" or "Product › Mobile". */
  label: string;
  depth: number;
}

/**
 * The units the caller may place a channel in (CHAT-02): every unit for those who hold `unit.manage` (admins),
 * otherwise the units on the paths of their own memberships. Mirrors the API's rule; the API decides.
 */
export function usePlaceableUnits(): PlaceableUnit[] {
  const units = useUnits();
  const channels = useChannels();
  const can = usePermissionCheck();
  const manage = can("unit.manage");
  const mine = channels.data?.memberUnitIds;
  return useMemo(() => {
    const list: OrgUnit[] = units.data?.units ?? [];
    const byId = new Map(list.map((u) => [u.id, u]));
    const allowed = new Set(mine ?? []);
    return list
      .filter((u) => manage || allowed.has(u.id))
      .map((u) => ({
        id: u.id,
        label: u.path.map((id) => byId.get(id)?.name ?? "…").join(" › "),
        depth: u.path.length - 1,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [units.data, mine, manage]);
}

/** "Belongs to": the organization or one of the units the caller may use (create and move dialogs). */
export function ChannelUnitSelect({
  value,
  onChange,
  units,
  id,
}: {
  value: string | null;
  onChange: (unitId: string | null) => void;
  units: PlaceableUnit[];
  id?: string;
}) {
  const me = useMe({ enabled: false });
  const org = me.data?.organization.name ?? "Organization";
  const items = [
    { value: ORG_UNIT_VALUE, label: `${org} (everyone)` },
    ...units.map((u) => ({ value: u.id, label: u.label })),
  ];
  return (
    <Select
      items={items}
      value={value ?? ORG_UNIT_VALUE}
      onValueChange={(v) => onChange(!v || v === ORG_UNIT_VALUE ? null : String(v))}
    >
      <SelectTrigger id={id} data-testid="channel-unit-select" aria-label="Belongs to" />
      <SelectContent className="max-h-72 overflow-y-auto">
        <SelectItem value={ORG_UNIT_VALUE}>
          <span className="flex items-center gap-2">
            <Building2 className="size-3.5 text-muted-foreground" />
            {org} <span className="text-muted-foreground">(everyone)</span>
          </span>
        </SelectItem>
        {units.map((u) => (
          <SelectItem key={u.id} value={u.id} data-testid="channel-unit-option">
            <span className="truncate" style={{ paddingLeft: `${Math.min(u.depth, 3) * 12}px` }}>
              {u.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NO_TEMPLATE = "__none__";
const NO_TEMPLATE_LABEL = "None (Backlog, In progress, Done, Cancelled)";
const TEMPLATE_HINT = "Sets the columns, fields and how cards are named.";

/** `Case file · EXP · 4 columns` (the prefix part only when the template has one). */
export function templateOptionLabel(t: Pick<RecordTemplate, "name" | "prefix" | "columns">): string {
  const n = t.columns.length;
  return [t.name, t.prefix, `${n} column${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}

export const templateUnavailable = (unit: string) =>
  `That template isn't available in ${unit}. Pick another one.`;

/**
 * The Template field of a board (07.1-12, P-08, 07.1-UI-SPEC "Create-channel dialog (extended)"): the templates a
 * channel in the chosen unit may use (the API lists them: the unit's, its ancestors' and organization-wide ones), and a
 * read-only preview of the chosen template's columns.
 */
function TemplatePicker({
  templates,
  failed,
  value,
  onChange,
  hint,
  error,
}: {
  templates: RecordTemplate[];
  failed: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
  hint: string;
  error: string | undefined;
}) {
  const chosen = templates.find((t) => t.id === value) ?? null;
  const items = [
    { value: NO_TEMPLATE, label: NO_TEMPLATE_LABEL },
    ...templates.map((t) => ({ value: t.id, label: templateOptionLabel(t) })),
  ];
  return (
    <div className="grid gap-3" data-testid="template-field">
      <FormField
        id="channel-template"
        label="Template"
        hint={failed ? "Couldn't load templates. You can still create the board without one." : hint}
        error={error}
      >
        <Select
          items={items}
          value={value ?? NO_TEMPLATE}
          onValueChange={(v) => onChange(!v || v === NO_TEMPLATE ? null : String(v))}
        >
          <SelectTrigger
            id="channel-template"
            data-testid="template-picker"
            aria-label="Template"
            aria-describedby={describedBy("channel-template", error, hint)}
          />
          <SelectContent className="max-h-72 overflow-y-auto">
            <SelectItem value={NO_TEMPLATE}>{NO_TEMPLATE_LABEL}</SelectItem>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id} data-testid="template-option">
                {templateOptionLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {chosen ? (
        <div
          className="grid gap-1.5 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-3"
          data-testid="template-columns"
        >
          <span className="font-medium text-sm" id="template-columns-label">
            Columns
          </span>
          <ul aria-labelledby="template-columns-label" className="flex flex-wrap gap-x-3 gap-y-1.5">
            {chosen.columns.map((c) => (
              <li
                key={c.name}
                className="flex items-center gap-1.5 text-sm"
                data-testid="template-column"
                data-category={c.category}
              >
                <CategoryIcon category={c.category} />
                {c.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Radio cards (create-channel dialog): Visibility, and Layout (Phase 07.1, D-01/D-04: Text or Board, no voice). Each
 * option is a label around a visually hidden radio, `data-testid="{name}-{value}"`; the chosen card takes the accent.
 */
function RadioCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ v: T; icon: LucideIcon; title: string; body: string }>;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium text-sm">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.v}
            className={cn(
              "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-[3px] has-focus-visible:ring-ring/40",
              value === o.v ? "border-primary/60 bg-primary/5" : "hover:bg-accent/50",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.v}
              checked={value === o.v}
              onChange={() => onChange(o.v)}
              className="sr-only"
              data-testid={`${name}-${o.v}`}
            />
            <o.icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                value === o.v ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="grid gap-0.5">
              <span className="font-medium text-sm">{o.title}</span>
              <span className="text-muted-foreground text-xs leading-snug">{o.body}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  defaultUnitId = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Preselected "Belongs to" (a section's "+"). */
  defaultUnitId?: string | null;
}) {
  const router = useRouter();
  const me = useMe({ enabled: false });
  const create = useCreateChannel();
  const placeable = usePlaceableUnits();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [layout, setLayout] = useState<ChannelLayout>("text");
  const [unitId, setUnitId] = useState<string | null>(defaultUnitId);
  const [chosen, setChosen] = useState<RecordTemplate | null>(null);
  const templateId = chosen?.id ?? null;
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const units = useUnits();
  const templates = useRecordTemplates(unitId, { enabled: open && layout === "board" });
  const unitName =
    unitId === null
      ? (me.data?.organization.name ?? "the organization")
      : (units.data?.units.find((u) => u.id === unitId)?.name ?? "this unit");

  // A template chosen for another unit and not offered in this one is cleared, and the hint says why (P-08). While
  // the new unit's list loads, the chosen template stays listed so the select keeps it until the answer decides.
  const offered = templates.data?.templates;
  useEffect(() => {
    if (!templateId || !offered) return;
    if (!offered.some((t) => t.id === templateId)) {
      setChosen(null);
      setTemplateNote(templateUnavailable(unitName));
    }
  }, [offered, templateId, unitName]);
  const listed = offered ?? (chosen ? [chosen] : []);

  useEffect(() => {
    if (open) setUnitId(defaultUnitId);
  }, [open, defaultUnitId]);

  const reset = () => {
    setName("");
    setTopic("");
    setVisibility("public");
    setLayout("text");
    setUnitId(defaultUnitId);
    setChosen(null);
    setTemplateNote(null);
    setTemplateError(undefined);
    setError(undefined);
    create.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateChannelRequest.safeParse({
      name: name.replace(/^-+|-+$/g, ""),
      topic,
      visibility,
      unitId,
      layout,
      ...(layout === "board" && templateId ? { templateId } : {}),
    });
    if (!parsed.success) {
      setError(name ? "Use lowercase letters, numbers, - and _" : "Give the channel a name");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (channel) => {
        onOpenChange(false);
        reset();
        router.push(`/chat/${channel.id}`);
      },
      onError: (err) => {
        if (isApiError(err) && err.code === "template_not_available") {
          setTemplateError(templateUnavailable(unitName));
          return;
        }
        setError(isApiError(err, 409) ? `#${parsed.data.name} already exists` : errorMessage(err));
      },
    });
  };

  const org = me.data?.organization.name ?? "your workspace";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent data-testid="create-channel-dialog">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where your team and your bots work together around a topic.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <FormField id="channel-name" label="Name" error={error}>
            <div className="relative">
              <Hash className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel-name"
                autoFocus
                autoComplete="off"
                placeholder="e.g. product-launch"
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(toChannelName(e.target.value));
                  setError(undefined);
                }}
                aria-invalid={!!error}
                aria-describedby={describedBy("channel-name", error)}
                className="pl-8"
              />
            </div>
          </FormField>
          <FormField
            id="channel-topic"
            label={
              <>
                Topic <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
          >
            <Input
              id="channel-topic"
              autoComplete="off"
              placeholder="What is this channel about?"
              value={topic}
              maxLength={250}
              onChange={(e) => setTopic(e.target.value)}
            />
          </FormField>
          {placeable.length > 0 || unitId !== null ? (
            <FormField
              id="channel-unit"
              label="Belongs to"
              hint="Groups the channel in the sidebar; that department's rules apply to it."
            >
              <ChannelUnitSelect
                id="channel-unit"
                value={unitId}
                onChange={(id) => {
                  setUnitId(id);
                  setTemplateError(undefined);
                }}
                units={placeable}
              />
            </FormField>
          ) : null}
          <RadioCards
            legend="Layout"
            name="layout"
            value={layout}
            onChange={(v) => {
              setLayout(v);
              if (v === "text") {
                setChosen(null);
                setTemplateNote(null);
                setTemplateError(undefined);
              }
            }}
            options={[
              { v: "text", icon: Hash, title: "Text", body: "Messages in one stream" },
              {
                v: "board",
                icon: SquareKanban,
                title: "Board",
                body: "Cards in columns, each with its own thread",
              },
            ]}
          />
          {layout === "board" ? (
            <TemplatePicker
              templates={listed}
              failed={templates.isError}
              value={templateId}
              onChange={(id) => {
                if (id === templateId) return;
                setChosen(listed.find((t) => t.id === id) ?? null);
                // A "None" the select reports by itself (its item left the list) keeps the note saying why.
                if (id !== null) setTemplateNote(null);
                setTemplateError(undefined);
              }}
              hint={templateNote ?? TEMPLATE_HINT}
              error={templateError}
            />
          ) : null}
          <RadioCards
            legend="Visibility"
            name="visibility"
            value={visibility}
            onChange={setVisibility}
            options={[
              { v: "public", icon: Globe, title: "Public", body: `Anyone in ${org} can find and join` },
              { v: "private", icon: Lock, title: "Private", body: "Only invited people and bots" },
            ]}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name} data-testid="create-channel-submit">
              {create.isPending ? <Spinner /> : null}
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
