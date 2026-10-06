"use client";

import { Calendar, ChevronDown, Hash, Lock, MessageCircle, Search, User, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { useOrgDirectory } from "@/components/chat/use-chat-directory";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChannels, useDms } from "@/lib/chat-queries";
import type { SearchFilters as Filters } from "@/lib/search-queries";
import { cn, formatDate } from "@/lib/utils";

/** The filter part of the results page URL (everything but `q`). */
export type FilterValues = Pick<Filters, "in" | "from" | "after" | "before">;

interface PickerOption {
  id: string;
  label: string;
  hint?: string | null;
  icon: ReactNode;
}

const chipClass = (active: boolean) =>
  cn(
    "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 font-medium text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
    active
      ? "border-primary/30 bg-brand-soft text-brand-soft-foreground"
      : "bg-background text-foreground hover:bg-accent",
  );

/** YYYY-MM-DD of the browser's local day `daysAgo` days back. */
function localDay(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DATE_PRESETS = [
  { id: "today", label: "Today", after: () => localDay(0) },
  { id: "7d", label: "Last 7 days", after: () => localDay(6) },
  { id: "30d", label: "Last 30 days", after: () => localDay(29) },
] as const;

function dateLabel(after?: string, before?: string): string | null {
  if (!after && !before) return null;
  if (after && !before) {
    const preset = DATE_PRESETS.find((p) => p.after() === after);
    if (preset) return preset.label;
    return `Since ${formatDate(`${after}T12:00:00`)}`;
  }
  if (!after && before) return `Until ${formatDate(`${before}T12:00:00`)}`;
  return after === before
    ? formatDate(`${after}T12:00:00`)
    : `${formatDate(`${after}T12:00:00`)} – ${formatDate(`${before}T12:00:00`)}`;
}

/**
 * Filter chips of the results page (CHAT-11): In (a readable channel or DM), From (a person or bot) and Date
 * (presets or a custom range). Values live in the URL; this component only reads and reports them.
 */
export function SearchFilterBar({
  value,
  onChange,
}: {
  value: FilterValues;
  onChange: (next: FilterValues) => void;
}) {
  const channels = useChannels();
  const dms = useDms();
  const dir = useOrgDirectory();
  const [picker, setPicker] = useState<"in" | "from" | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const conversations = useMemo<PickerOption[]>(() => {
    const out: PickerOption[] = [];
    for (const c of channels.data?.channels ?? []) {
      out.push({
        id: c.id,
        label: `#${c.name ?? ""}`,
        hint: c.isMember ? null : "Not joined",
        icon:
          c.visibility === "private" ? (
            <Lock className="size-4" aria-hidden />
          ) : (
            <Hash className="size-4" aria-hidden />
          ),
      });
    }
    for (const d of dms.data?.dms ?? []) {
      const cp = d.counterpart;
      out.push({
        id: d.id,
        label: cp.name,
        hint: "Direct message",
        icon: <MessageCircle className="size-4" aria-hidden />,
      });
    }
    return out;
  }, [channels.data, dms.data]);

  const people = useMemo<PickerOption[]>(
    () =>
      dir.entries.map((e) => ({
        id: e.id,
        label: e.displayName,
        hint: `@${e.handle}`,
        icon: (
          <PrincipalAvatar
            kind={e.kind}
            name={e.displayName}
            avatarUrl={e.avatarUrl}
            seed={e.id}
            className="size-6"
          />
        ),
      })),
    [dir.entries],
  );

  const inLabel = value.in ? (conversations.find((c) => c.id === value.in)?.label ?? "1 conversation") : null;
  const fromLabel = value.from ? (people.find((p) => p.id === value.from)?.label ?? "1 person") : null;
  const when = dateLabel(value.after, value.before);

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="search-filters">
      <FilterChip
        testId="filter-in"
        icon={<Hash className="size-3.5" aria-hidden />}
        label="In"
        value={inLabel}
        onOpen={() => setPicker("in")}
        onClear={() => onChange({ ...value, in: undefined })}
      />
      <FilterChip
        testId="filter-from"
        icon={<User className="size-3.5" aria-hidden />}
        label="From"
        value={fromLabel}
        onOpen={() => setPicker("from")}
        onClear={() => onChange({ ...value, from: undefined })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="filter-date" className={chipClass(!!when)}>
          <Calendar className="size-3.5" aria-hidden />
          <span className="truncate">{when ?? "Date"}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {DATE_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              data-testid={`date-${p.id}`}
              onClick={() => onChange({ ...value, after: p.after(), before: undefined })}
            >
              {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem data-testid="date-custom" onClick={() => setCustomOpen(true)}>
            Custom range…
          </DropdownMenuItem>
          {when ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onChange({ ...value, after: undefined, before: undefined })}>
                Any time
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <PickerDialog
        open={picker === "in"}
        title="Search in"
        placeholder="Find a channel or direct message"
        options={conversations}
        selected={value.in}
        testId="picker-in"
        onClose={() => setPicker(null)}
        onPick={(id) => onChange({ ...value, in: id })}
      />
      <PickerDialog
        open={picker === "from"}
        title="Messages from"
        placeholder="Find a person or bot"
        options={people}
        selected={value.from}
        testId="picker-from"
        onClose={() => setPicker(null)}
        onPick={(id) => onChange({ ...value, from: id })}
      />
      {customOpen ? (
        <CustomRangeDialog
          open
          after={value.after}
          before={value.before}
          onClose={() => setCustomOpen(false)}
          onApply={(after, before) => onChange({ ...value, after, before })}
        />
      ) : null}
    </div>
  );
}

function FilterChip({
  testId,
  icon,
  label,
  value,
  onOpen,
  onClear,
}: {
  testId: string;
  icon: ReactNode;
  label: string;
  value: string | null;
  onOpen: () => void;
  onClear: () => void;
}) {
  if (!value) {
    return (
      <button type="button" data-testid={testId} onClick={onOpen} className={chipClass(false)}>
        {icon}
        <span>{label}</span>
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </button>
    );
  }
  return (
    <span className={cn(chipClass(true), "pr-1")}>
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className="flex min-w-0 items-center gap-1.5 outline-none"
      >
        {icon}
        <span className="truncate">
          {label}: {value}
        </span>
      </button>
      <button
        type="button"
        data-testid={`${testId}-clear`}
        aria-label={`Clear ${label} filter`}
        onClick={onClear}
        className="inline-flex size-6 items-center justify-center rounded-full outline-none hover:bg-primary/10 focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

function PickerDialog({
  open,
  title,
  placeholder,
  options,
  selected,
  testId,
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  options: PickerOption[];
  selected?: string;
  testId: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  const shown = options.filter((o) => norm(`${o.label} ${o.hint ?? ""}`).includes(norm(filter.trim())));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setFilter("");
        }
      }}
    >
      <DialogContent data-testid={testId} className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={placeholder}
            className="h-10 pl-9 text-base sm:text-sm"
          />
        </div>
        <div className="scrollbar-thin -mx-1 max-h-[45dvh] min-h-24 overflow-y-auto px-1 sm:max-h-80">
          {shown.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">Nothing matches “{filter}”.</p>
          ) : (
            shown.map((o) => (
              <button
                key={o.id}
                type="button"
                data-testid="picker-option"
                data-option-id={o.id}
                onClick={() => {
                  onPick(o.id);
                  onClose();
                  setFilter("");
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent",
                  o.id === selected && "bg-accent",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                  {o.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{o.label}</span>
                {o.hint ? <span className="shrink-0 text-muted-foreground text-xs">{o.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CustomRangeDialog({
  open,
  after,
  before,
  onClose,
  onApply,
}: {
  open: boolean;
  after?: string;
  before?: string;
  onClose: () => void;
  onApply: (after?: string, before?: string) => void;
}) {
  const [from, setFrom] = useState(after ?? "");
  const [to, setTo] = useState(before ?? "");
  const invalid = !!from && !!to && from > to;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent data-testid="date-range-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Custom date range</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="search-after">From</Label>
            <Input
              id="search-after"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="search-before">To</Label>
            <Input
              id="search-before"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        {invalid ? <p className="text-destructive text-sm">The start date is after the end date.</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={invalid || (!from && !to)}
            onClick={() => {
              onApply(from || undefined, to || undefined);
              onClose();
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
