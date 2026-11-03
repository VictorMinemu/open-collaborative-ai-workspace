"use client";

import {
  type AiModelOption,
  type DigestSection,
  type DigestView,
  modelRefKey,
  type Weekday,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Info, Newspaper, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MeteredBadge } from "@/components/bots/provider-bits";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { describedBy } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAiModels } from "@/lib/ai-chat-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreatePersonalBot } from "@/lib/bots-queries";
import {
  digestKeys,
  useDigest,
  useDigestPreview,
  useSaveDigest,
  useSendDigestTest,
} from "@/lib/digest-queries";
import { permalinkPath } from "@/lib/permalink";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  browserTimeZone,
  DAY_LABELS,
  DIGEST_COPY,
  type DigestBase,
  type DigestErrors,
  type DigestForm,
  formatNext,
  formFromView,
  inWeekOrder,
  isDirty,
  SECTIONS,
  saveBlocker,
  saveRequest,
  shouldResync,
  statusLine,
  summaryNotice,
  testBlocker,
  timeZones,
  toSettings,
  validateDigest,
  WEEKDAYS,
  WORK_WEEK,
} from "./digest-form";
import { DigestPreview, type DigestPreviewState } from "./digest-preview";

// ---------------------------------------------------------------- the view (pure: props in, markup out)

export interface DigestSettingsViewProps {
  form: DigestForm;
  /** The errors to show (the zone's only once it was left). */
  errors: DigestErrors;
  view: DigestView;
  /** The viewer's AI chat models (`GET /ai-chat/models`); empty when they have none. */
  models: readonly AiModelOption[];
  dirty: boolean;
  saving: boolean;
  testing: boolean;
  previewing: boolean;
  creatingBot: boolean;
  canCreateBot: boolean;
  preview: DigestPreviewState;
  onChange: (patch: Partial<DigestForm>) => void;
  onZoneBlur: () => void;
  onPreview: () => void;
  onTest: () => void;
  onSave: () => void;
  onCreateBot: () => void;
}

function Block({
  title,
  testId,
  children,
  after,
  muted,
}: {
  title?: string;
  testId: string;
  children: ReactNode;
  after?: ReactNode;
  /** The digest is off: the block is greyed, never disabled (UI-SPEC Surface 6). */
  muted?: boolean;
}) {
  const headingId = `${testId}-heading`;
  return (
    <section className="grid gap-3" data-testid={testId} aria-labelledby={title ? headingId : undefined}>
      {title ? (
        <h2 id={headingId} className="font-semibold text-[15px] tracking-tight">
          {title}
        </h2>
      ) : null}
      <div
        className={cn(
          "grid divide-y rounded-xl border shadow-xs transition-colors",
          muted ? "bg-muted/40 shadow-none" : "bg-card",
        )}
      >
        {children}
      </div>
      {after}
    </section>
  );
}

const ERROR_CLASS = "text-[13px] text-destructive";
const errorId = (name: string) => `digest-${name}-error`;

/** The models a summary can use, and the one shown when none was picked (the person's default, else the first). */
function summaryModels(models: readonly AiModelOption[]) {
  const usable = models.filter((m) => m.available);
  return { usable, fallback: usable.find((m) => m.isDefault) ?? usable[0] };
}

export function DigestSettingsView(p: DigestSettingsViewProps) {
  const { form, errors, view } = p;
  const off = !form.enabled;
  const { usable, fallback } = summaryModels(p.models);
  const pickedKey = form.summary.modelRef ? modelRefKey(form.summary.modelRef) : null;
  const selected = usable.find((m) => modelRefKey(m.ref) === pickedKey) ?? fallback;
  const saveReason = saveBlocker(errors, p.dirty);
  const testReason = testBlocker(view, p.dirty);
  const invalid = Object.keys(errors).length > 0;
  const noBot = view.bots.length === 0;

  const toggleDay = (day: Weekday, on: boolean) =>
    p.onChange({ days: inWeekOrder(on ? [...form.days, day] : form.days.filter((d) => d !== day)) });
  const toggleSection = (id: DigestSection, on: boolean) =>
    p.onChange({
      sections: SECTIONS.map((s) => s.id).filter((s) => (s === id ? on : form.sections.includes(s))),
    });

  return (
    <div className="grid gap-10" data-testid="digest-settings">
      {/* Master switch */}
      <div className="rounded-xl border bg-card shadow-xs">
        <div className="flex items-center justify-between gap-4 p-4 sm:p-5">
          <div className="min-w-0">
            <Label htmlFor="digest-enabled" className="font-medium text-sm">
              {DIGEST_COPY.master}
            </Label>
            <p data-testid="digest-status" className="mt-1 text-muted-foreground text-xs">
              {statusLine(view)}
            </p>
          </div>
          <Switch
            id="digest-enabled"
            data-testid="digest-enabled"
            checked={form.enabled}
            onCheckedChange={(v: boolean) => p.onChange({ enabled: v })}
          />
        </div>
      </div>

      <div className="grid gap-10" data-off={off ? "true" : undefined}>
        {/* When */}
        <Block title={DIGEST_COPY.when} testId="digest-when" muted={off}>
          <div className="flex flex-col gap-3 p-4 sm:p-5 md:flex-row md:items-start md:gap-3">
            <span id="digest-days-label" className="font-medium text-[13px] md:w-16 md:shrink-0 md:pt-2">
              {DIGEST_COPY.days}
            </span>
            <div className="grid min-w-0 gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-labelledby="digest-days-label"
                  aria-describedby={errors.days ? errorId("days") : undefined}
                  className="flex flex-wrap gap-2 max-md:grid max-md:w-full max-md:grid-cols-7 max-md:gap-0.5"
                >
                  {WEEKDAYS.map((day) => {
                    const on = form.days.includes(day);
                    const label = DAY_LABELS[day];
                    return (
                      <label
                        key={day}
                        data-testid={`digest-day-${day}`}
                        data-checked={on ? "true" : undefined}
                        className={cn(
                          "relative inline-flex h-8 cursor-pointer select-none items-center justify-center rounded-full border px-3 font-medium text-[13px] transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40 max-md:h-11 max-md:w-full max-md:px-0",
                          on
                            ? off
                              ? "border-foreground/25 bg-muted text-foreground"
                              : "border-primary/50 bg-brand-soft/40 text-brand-soft-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          aria-label={label.full}
                          checked={on}
                          onChange={(e) => toggleDay(day, e.currentTarget.checked)}
                        />
                        <span aria-hidden className="md:hidden">
                          {label.letter}
                        </span>
                        <span aria-hidden className="max-md:hidden">
                          {label.short}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground text-sm max-md:w-full md:ml-1">
                  <Button
                    variant="link"
                    size="sm"
                    data-testid="digest-weekdays"
                    className="px-0 max-md:min-h-11"
                    onClick={() => p.onChange({ days: [...WORK_WEEK] })}
                  >
                    {DIGEST_COPY.weekdays}
                  </Button>
                  <span aria-hidden>·</span>
                  <Button
                    variant="link"
                    size="sm"
                    data-testid="digest-every-day"
                    className="px-0 max-md:min-h-11"
                    onClick={() => p.onChange({ days: [...WEEKDAYS] })}
                  >
                    {DIGEST_COPY.everyDay}
                  </Button>
                </div>
              </div>
              {errors.days ? (
                <p id={errorId("days")} role="alert" className={ERROR_CLASS}>
                  {errors.days}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-4 p-4 sm:p-5 md:flex-row md:items-start md:gap-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
              <Label htmlFor="digest-time" className="md:w-16 md:shrink-0 md:pt-3">
                {DIGEST_COPY.at}
              </Label>
              <div className="grid gap-2">
                <Input
                  id="digest-time"
                  type="time"
                  data-testid="digest-time"
                  value={form.time}
                  aria-invalid={!!errors.time}
                  aria-describedby={describedBy("digest-time", errors.time)}
                  onChange={(e) => p.onChange({ time: e.currentTarget.value })}
                  className="w-32 max-md:h-11"
                />
                {errors.time ? (
                  <p id="digest-time-error" role="alert" className={ERROR_CLASS}>
                    {errors.time}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-start md:gap-3">
              <Label htmlFor="digest-zone" className="md:shrink-0 md:pt-3 md:pl-3">
                {DIGEST_COPY.timeZone}
              </Label>
              <div className="grid min-w-0 flex-1 gap-2">
                <Input
                  id="digest-zone"
                  data-testid="digest-zone"
                  list="digest-zones"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.timeZone}
                  aria-invalid={!!errors.timeZone}
                  aria-describedby={describedBy(
                    "digest-zone",
                    errors.timeZone,
                    form.zoneDetected ? DIGEST_COPY.detected : undefined,
                  )}
                  onChange={(e) => p.onChange({ timeZone: e.currentTarget.value, zoneDetected: false })}
                  onBlur={p.onZoneBlur}
                  className="max-md:h-11"
                />
                <datalist id="digest-zones">
                  {timeZones().map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                {errors.timeZone ? (
                  <p id="digest-zone-error" role="alert" className={ERROR_CLASS}>
                    {errors.timeZone}
                  </p>
                ) : form.zoneDetected ? (
                  <p
                    id="digest-zone-hint"
                    data-testid="digest-zone-hint"
                    className="text-[13px] text-muted-foreground"
                  >
                    {DIGEST_COPY.detected}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </Block>

        {/* What to include */}
        <Block
          title={DIGEST_COPY.include}
          testId="digest-include"
          muted={off}
          after={
            errors.sections ? (
              <p id={errorId("sections")} role="alert" className={ERROR_CLASS}>
                {errors.sections}
              </p>
            ) : null
          }
        >
          {SECTIONS.map((s) => (
            <label
              key={s.id}
              className="flex min-h-14 cursor-pointer items-start gap-3 px-4 py-3 sm:items-center sm:px-5"
            >
              <input
                type="checkbox"
                data-testid={`digest-section-${s.id}`}
                className={cn(
                  "mt-0.5 size-4 shrink-0 sm:mt-0",
                  off ? "accent-muted-foreground" : "accent-primary",
                )}
                checked={form.sections.includes(s.id)}
                aria-describedby={errors.sections ? errorId("sections") : undefined}
                onChange={(e) => toggleSection(s.id, e.currentTarget.checked)}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="font-medium text-sm">{s.label}</span>
                <span className="text-muted-foreground text-xs">{s.hint}</span>
              </span>
            </label>
          ))}
          <div className="flex items-center justify-between gap-4 p-4 sm:px-5">
            <Label htmlFor="digest-skip-empty" className="font-medium text-sm">
              {DIGEST_COPY.skipEmpty}
            </Label>
            <Switch
              id="digest-skip-empty"
              data-testid="digest-skip-empty"
              checked={form.skipEmpty}
              onCheckedChange={(v: boolean) => p.onChange({ skipEmpty: v })}
            />
          </div>
        </Block>

        {/* Deliver with */}
        {noBot ? (
          <section className="grid gap-3" aria-labelledby="digest-deliver-heading">
            <h2 id="digest-deliver-heading" className="font-semibold text-[15px] tracking-tight">
              {DIGEST_COPY.deliverWith}
            </h2>
            <div
              data-testid="digest-no-bot"
              className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center"
            >
              <span className="flex size-9 items-center justify-center rounded-[30%] bg-brand-soft text-brand-soft-foreground">
                <Bot aria-hidden className="size-4" />
              </span>
              <p className="text-sm">{DIGEST_COPY.noBot}</p>
              {p.canCreateBot ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="digest-create-bot"
                  disabled={p.creatingBot}
                  onClick={p.onCreateBot}
                  className="max-md:h-11 max-md:w-full"
                >
                  {p.creatingBot ? <Spinner /> : <Plus />}
                  {DIGEST_COPY.createBot}
                </Button>
              ) : null}
            </div>
          </section>
        ) : (
          <Block
            title={DIGEST_COPY.deliverWith}
            testId="digest-deliver"
            muted={off}
            after={<p className="text-muted-foreground text-xs">{DIGEST_COPY.deliverHint}</p>}
          >
            <div role="radiogroup" aria-labelledby="digest-deliver-heading" className="grid divide-y">
              {view.bots.map((b) => (
                <label
                  key={b.id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2.5 sm:px-5 max-md:min-h-14"
                >
                  <input
                    type="radio"
                    name="digest-bot"
                    value={b.id}
                    data-testid={`digest-bot-${b.id}`}
                    className={cn("size-4 shrink-0", off ? "accent-muted-foreground" : "accent-primary")}
                    checked={form.agentId === b.id}
                    onChange={() => p.onChange({ agentId: b.id })}
                  />
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-[30%] bg-brand-soft text-brand-soft-foreground"
                  >
                    <Bot className="size-3.5" />
                  </span>
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-medium">{b.displayName}</span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {b.personal ? "your personal bot" : (b.unitName ?? "Organization")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Block>
        )}

        {/* AI summary */}
        <Block title={DIGEST_COPY.aiSummary} testId="digest-summary" muted={off}>
          <div className="flex items-center justify-between gap-4 p-4 sm:px-5">
            <div className="flex min-w-0 items-start gap-2.5">
              <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <Label htmlFor="digest-summary-enabled" className="font-medium text-sm leading-snug">
                  {DIGEST_COPY.addSummary}
                </Label>
                {usable.length === 0 ? (
                  <p className="mt-1 text-muted-foreground text-xs">{DIGEST_COPY.noModels}</p>
                ) : null}
              </div>
            </div>
            <Switch
              id="digest-summary-enabled"
              data-testid="digest-summary-enabled"
              checked={form.summary.enabled}
              disabled={usable.length === 0 && !form.summary.enabled}
              onCheckedChange={(v: boolean) =>
                p.onChange({
                  summary: { enabled: v, modelRef: v ? (selected?.ref ?? null) : form.summary.modelRef },
                })
              }
            />
          </div>
          {form.summary.enabled ? (
            <div className="grid gap-3 p-4 sm:px-5" data-testid="digest-summary-on">
              <div className="grid gap-2 md:grid-cols-[4rem_1fr] md:items-center md:gap-3">
                <Label htmlFor="digest-summary-model">{DIGEST_COPY.model}</Label>
                <div className="flex min-w-0 items-center gap-2">
                  <Select
                    items={usable.map((m) => ({ value: modelRefKey(m.ref), label: m.label }))}
                    value={selected ? modelRefKey(selected.ref) : null}
                    onValueChange={(v) => {
                      const m = usable.find((x) => modelRefKey(x.ref) === v);
                      if (m) p.onChange({ summary: { enabled: true, modelRef: m.ref } });
                    }}
                  >
                    <SelectTrigger
                      id="digest-summary-model"
                      data-testid="digest-summary-model"
                      aria-label={DIGEST_COPY.model}
                      className="min-w-0 flex-1 max-md:h-11"
                    />
                    <SelectContent>
                      {usable.map((m) => (
                        <SelectItem key={modelRefKey(m.ref)} value={modelRefKey(m.ref)}>
                          <span className="flex items-center gap-2">
                            {m.label}
                            {m.metered ? <MeteredBadge /> : null}
                            {m.group === "chatgpt_plan" ? (
                              <span className="text-muted-foreground text-xs">· ChatGPT plan</span>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selected?.metered ? <MeteredBadge /> : null}
                  {selected?.group === "chatgpt_plan" ? (
                    <span className="shrink-0 text-muted-foreground text-xs">ChatGPT plan</span>
                  ) : null}
                </div>
              </div>
              <p
                role="note"
                data-testid="digest-summary-notice"
                className="flex gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-foreground text-xs leading-relaxed"
              >
                <Info aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                <span>{summaryNotice(selected)}</span>
              </p>
            </div>
          ) : null}
        </Block>
      </div>

      {/* Actions and the preview */}
      <div className="grid gap-4">
        <div className="grid gap-2" data-testid="digest-actions">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              variant="outline"
              data-testid="digest-preview-button"
              disabled={invalid || p.previewing}
              onClick={p.onPreview}
              className="max-md:h-11"
            >
              {p.previewing ? <Spinner /> : null}
              {DIGEST_COPY.preview}
            </Button>
            <Button
              variant="outline"
              data-testid="digest-test"
              disabled={testReason !== null || p.testing}
              aria-describedby={testReason ? "digest-test-reason" : undefined}
              onClick={p.onTest}
              className="max-md:h-11"
            >
              {p.testing ? <Spinner /> : null}
              {DIGEST_COPY.test}
            </Button>
            <Button
              data-testid="digest-save"
              disabled={saveReason !== null || p.saving}
              aria-describedby={saveReason ? "digest-save-reason" : undefined}
              onClick={p.onSave}
              className="max-md:h-11 sm:ml-auto"
            >
              {p.saving ? <Spinner /> : null}
              {DIGEST_COPY.save}
            </Button>
          </div>
          {testReason || saveReason ? (
            <div className="flex flex-col gap-1 text-[13px] text-muted-foreground sm:flex-row sm:justify-between">
              <p id="digest-test-reason" data-testid="digest-test-reason">
                {testReason ?? ""}
              </p>
              {saveReason ? (
                <p id="digest-save-reason" data-testid="digest-save-reason" className="sm:text-right">
                  {saveReason}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <DigestPreview state={p.preview} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page body (state, queries, toasts)

/**
 * Settings › Digest (07.6-16, AUTO-05; D-05, D-07; UI-SPEC Surface 6, R6). Chips and switches change local state only;
 * `Save digest` sends everything (`PUT /digest`), `Preview` composes the unsaved form, `Send a test now` sends the saved
 * digest (disabled with "Save first." while there are unsaved changes). The API decides which bots can deliver it, the
 * next send time and every refusal; the summary is off until the person turns it on, after reading who pays.
 */
export function DigestSettings() {
  const qc = useQueryClient();
  const router = useRouter();
  const digest = useDigest();
  const models = useAiModels();
  const save = useSaveDigest();
  const previewMutation = useDigestPreview();
  const sendTest = useSendDigestTest();
  const createBot = useCreatePersonalBot();
  const canCreateBot = useCan("bot.create_personal");

  const [form, setForm] = useState<DigestForm | null>(null);
  const [zoneTouched, setZoneTouched] = useState(false);
  const [preview, setPreview] = useState<DigestPreviewState>({ state: "idle" });
  // The saved digest the form was last taken from (settings and version): a live refetch (a pause from the automations
  // list) refreshes an untouched form, never one with the person's unsaved changes, whose save then carries the version
  // they edited (a 409 instead of silently undoing the pause; 07.6 review C LO-06).
  const syncedFrom = useRef<DigestBase | null>(null);

  const view = digest.data;
  useEffect(() => {
    if (!view) return;
    if (!shouldResync(form, syncedFrom.current, view)) return;
    syncedFrom.current = { settings: view.settings, version: view.version };
    setForm(formFromView(view, browserTimeZone()));
  }, [view, form]);

  const allErrors = useMemo(() => (form && view ? validateDigest(form, view.bots) : {}), [form, view]);

  if (digest.isError) {
    if (isApiError(digest.error, 403)) {
      return (
        <EmptyState icon={Newspaper} title={DIGEST_COPY.title} description={errorMessage(digest.error)} />
      );
    }
    return (
      <ServerUnreachable
        title={DIGEST_COPY.loadError}
        onRetry={() => void digest.refetch()}
        retrying={digest.isFetching}
      />
    );
  }
  if (!view || !form) {
    return (
      <div className="grid gap-10" aria-busy>
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }

  const dirty = isDirty(form, view);
  const { timeZone: zoneError, ...rest } = allErrors;
  const shown: DigestErrors = zoneTouched && zoneError ? { ...rest, timeZone: zoneError } : rest;
  // Save and Preview stay off while the zone is not one from the list, even before its error shows.
  const errors: DigestErrors = zoneError && !shown.timeZone ? { ...shown, timeZone: "" } : shown;

  const onChange = (patch: Partial<DigestForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const onSave = () => {
    if (Object.keys(allErrors).length > 0) {
      setZoneTouched(true);
      return;
    }
    save.mutate(saveRequest(form, syncedFrom.current), {
      onSuccess: (next) => {
        syncedFrom.current = { settings: next.settings, version: next.version };
        setForm(formFromView(next, form.timeZone));
        if (!next.settings?.enabled) toast.success(DIGEST_COPY.turnedOff);
        else if (next.nextRunAt && next.settings)
          toast.success(DIGEST_COPY.saved(formatNext(next.nextRunAt, next.settings.timeZone)));
        else toast.success("Digest saved.");
      },
      onError: (err) => {
        if (isApiError(err, 409) && err.code === "version") {
          // Changed elsewhere since it was opened: Reload takes the saved digest (the edits here are not saved).
          toast.error(DIGEST_COPY.changedElsewhere, {
            action: {
              label: DIGEST_COPY.reload,
              onClick: () => {
                syncedFrom.current = null;
                void digest.refetch().then((r) => {
                  if (!r.data) return;
                  syncedFrom.current = { settings: r.data.settings, version: r.data.version };
                  setForm(formFromView(r.data, browserTimeZone()));
                });
              },
            },
          });
          return;
        }
        toast.error("Couldn't save your digest", { description: errorMessage(err) });
      },
    });
  };

  const onPreview = () => {
    if (Object.keys(allErrors).length > 0) return;
    setPreview({ state: "loading" });
    previewMutation.mutate(toSettings(form), {
      onSuccess: (res) => setPreview({ state: "ready", markdown: res.markdown, empty: res.empty }),
      onError: () => setPreview({ state: "error" }),
    });
  };

  const onTest = () => {
    const bot = view.bots.find((b) => b.id === view.settings?.agentId)?.displayName ?? "your bot";
    sendTest.mutate(undefined, {
      onSuccess: (res) =>
        toast.success(DIGEST_COPY.sent(bot), {
          action: {
            label: DIGEST_COPY.open,
            onClick: () => router.push(permalinkPath({ id: res.conversationId, kind: "dm" }, res.messageId)),
          },
        }),
      onError: (err) => toast.error("Couldn't send a test digest", { description: errorMessage(err) }),
    });
  };

  const onCreateBot = () =>
    createBot.mutate(
      {},
      {
        onSuccess: async (res) => {
          toast.success(`${res.agent.name} is ready to chat`);
          await qc.invalidateQueries({ queryKey: digestKeys.view });
          setForm((f) => (f ? { ...f, agentId: res.agent.id } : f));
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <DigestSettingsView
      form={form}
      errors={errors}
      view={view}
      models={models.data?.models ?? []}
      dirty={dirty}
      saving={save.isPending}
      testing={sendTest.isPending}
      previewing={previewMutation.isPending}
      creatingBot={createBot.isPending}
      canCreateBot={canCreateBot}
      preview={preview}
      onChange={onChange}
      onZoneBlur={() => setZoneTouched(true)}
      onPreview={onPreview}
      onTest={onTest}
      onSave={onSave}
      onCreateBot={onCreateBot}
    />
  );
}
