"use client";

import {
  BOT_TASK_LIMITS,
  type BotPolicy,
  type BotPolicyView,
  type BuiltinCapability,
  type CapabilityPolicyEntry,
  MAX_DAILY_LIMIT,
  modelLabel,
  type SearchProvider,
  type UpdateBotPolicyRequest,
} from "@ocw/contracts";
import {
  Clock,
  Globe,
  ListChecks,
  Lock,
  type LucideIcon,
  Megaphone,
  NotebookPen,
  RotateCcw,
  Save,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useModels } from "@/lib/bots-queries";
import { useBotPolicy, useUpdateBotPolicy } from "@/lib/capability-queries";
import { useCan, usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Draft = Omit<BotPolicy, "updatedAt">;

const CAPABILITIES: Array<{
  name: BuiltinCapability;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Personal bots only live in their owner's DM, so a channel-only capability has no personal column. */
  personalApplies: boolean;
}> = [
  {
    name: "internet",
    label: "Internet",
    description: "Web search and page reading, read-only",
    icon: Globe,
    personalApplies: true,
  },
  {
    name: "memory",
    label: "Memory",
    description: "Remembers facts per person, only in their private chat",
    icon: NotebookPen,
    personalApplies: true,
  },
  {
    name: "dateTime",
    label: "Date & time",
    description: "Knows the asking person's local date and time",
    icon: Clock,
    personalApplies: true,
  },
  {
    name: "replyModeAll",
    label: "Every-message replies",
    description: "Team bots may answer every message in their channels",
    icon: Megaphone,
    personalApplies: false,
  },
  // 07.17.1.1.2 (D-04, PD-20): "Allow long tasks", within the limits of the Long tasks section.
  {
    name: "longTasks",
    label: "Long tasks",
    description: "Bots keep working on long requests by themselves, within the limits below",
    icon: ListChecks,
    personalApplies: true,
  },
];

type TaskLimit = keyof BotPolicy["tasks"];

/** The Long tasks limits (07.17.1.1.2 D-04, PD-20), in display order, with the API's bounds. */
export const TASK_FIELDS: Array<{
  key: TaskLimit;
  label: string;
  hint: string;
  min: number;
  max: number;
  testId: string;
}> = [
  {
    key: "maxTurns",
    label: "Turns per task",
    hint: "Each turn also counts toward the bot's daily limit",
    min: 1,
    max: BOT_TASK_LIMITS.maxTurnsCap,
    testId: "policy-task-max-turns",
  },
  {
    key: "maxHours",
    label: "Hours per task",
    hint: "A task stops when its time runs out",
    min: 1,
    max: BOT_TASK_LIMITS.maxHoursCap,
    testId: "policy-task-max-hours",
  },
  {
    key: "maxRunning",
    label: "Tasks running at once",
    hint: "0 turns long tasks off for everyone",
    min: 0,
    max: BOT_TASK_LIMITS.maxRunningCap,
    testId: "policy-task-max-running",
  },
];

/** What the API would refuse for one limit (null = valid), shown as soon as it is typed. */
export function taskLimitError(value: number, min: number, max: number): string | null {
  return Number.isInteger(value) && value >= min && value <= max
    ? null
    : `Enter a whole number from ${min} to ${max}.`;
}

const PROVIDERS: Array<{ id: SearchProvider; label: string; description: string }> = [
  { id: "duckduckgo", label: "DuckDuckGo", description: "Built in, no key or account needed" },
  { id: "searxng", label: "SearXNG", description: "Your own self-hosted metasearch instance" },
];

export const toDraft = ({ updatedAt: _u, availableSearchProviders: _a, ...rest }: BotPolicyView): Draft =>
  rest;
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The PUT body: only what differs from the saved policy (the API merges capabilities per capability and `tasks` per
 * limit), so changing one limit sends `{ tasks: { maxTurns: 12 } }`. "Every model" sends the empty list.
 */
export function toPolicyBody(draft: Draft, saved: Draft, restrictModels: boolean): UpdateBotPolicyRequest {
  const body: UpdateBotPolicyRequest = {};
  const capabilities: NonNullable<UpdateBotPolicyRequest["capabilities"]> = {};
  for (const name of Object.keys(draft.capabilities) as BuiltinCapability[]) {
    const next = draft.capabilities[name];
    const before = saved.capabilities[name];
    if (next.orgWide !== before.orgWide || next.personal !== before.personal) capabilities[name] = next;
  }
  if (Object.keys(capabilities).length > 0) body.capabilities = capabilities;
  if (draft.searchProvider !== saved.searchProvider) body.searchProvider = draft.searchProvider;
  if (draft.maxPersonalBotsPerUser !== saved.maxPersonalBotsPerUser) {
    body.maxPersonalBotsPerUser = draft.maxPersonalBotsPerUser;
  }
  if (draft.personalDailyLimitMax !== saved.personalDailyLimitMax) {
    body.personalDailyLimitMax = draft.personalDailyLimitMax;
  }
  const models = restrictModels ? draft.personalAllowedModels : [];
  if (models.join("\n") !== saved.personalAllowedModels.join("\n")) body.personalAllowedModels = models;
  const tasks: NonNullable<UpdateBotPolicyRequest["tasks"]> = {};
  for (const { key } of TASK_FIELDS) {
    if (draft.tasks[key] !== saved.tasks[key]) tasks[key] = draft.tasks[key];
  }
  if (Object.keys(tasks).length > 0) body.tasks = tasks;
  return body;
}

/**
 * Settings › Bot policy (D-06, D-09, D-11; BOT-01/05): what every bot of the organization may do, what
 * personal bots additionally may do, the web search provider and the personal-bot limits. One Save; the API
 * re-decides every bot from its next reply. Admins only (`bot.manage`).
 */
export function BotPolicySettings() {
  const permissions = usePermissions();
  const canManage = useCan("bot.manage");
  const policy = useBotPolicy(canManage);

  if (!canManage) {
    return permissions.isPending ? (
      <Skeleton className="h-40 rounded-2xl" />
    ) : (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        Only workspace admins can manage the bot policy.
      </div>
    );
  }
  if (policy.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    );
  }
  if (policy.isError) {
    return (
      <div className="rounded-xl border bg-card">
        <ServerUnreachable onRetry={() => policy.refetch()} retrying={policy.isFetching} />
      </div>
    );
  }
  return <PolicyForm policy={policy.data} />;
}

/** `initialTasks` seeds typed limits (tests render a typed value without a DOM). */
export function PolicyForm({
  policy,
  initialTasks,
}: {
  policy: BotPolicyView;
  initialTasks?: Partial<BotPolicy["tasks"]>;
}) {
  const save = useUpdateBotPolicy();
  const models = useModels();
  const saved = toDraft(policy);
  const [draft, setDraft] = useState<Draft>(() => ({ ...saved, tasks: { ...saved.tasks, ...initialTasks } }));
  const [errors, setErrors] = useState<{ maxBots?: string; dailyMax?: string; models?: string }>({});
  const [restrictModels, setRestrictModels] = useState(saved.personalAllowedModels.length > 0);
  const dirty = !same(draft, saved) || restrictModels !== saved.personalAllowedModels.length > 0;
  // The Long tasks limits are checked as they are typed: an invalid one shows its sentence and turns Save off.
  const taskErrors = Object.fromEntries(
    TASK_FIELDS.map((f) => [f.key, taskLimitError(draft.tasks[f.key], f.min, f.max)]),
  ) as Record<TaskLimit, string | null>;
  const tasksInvalid = Object.values(taskErrors).some((e) => e !== null);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const setCap = (cap: BuiltinCapability, patch: Partial<CapabilityPolicyEntry>) =>
    setDraft((d) => ({
      ...d,
      capabilities: { ...d.capabilities, [cap]: { ...d.capabilities[cap], ...patch } },
    }));

  function reset() {
    setDraft(saved);
    setRestrictModels(saved.personalAllowedModels.length > 0);
    setErrors({});
  }

  async function submit() {
    const next: typeof errors = {};
    if (
      !Number.isInteger(draft.maxPersonalBotsPerUser) ||
      draft.maxPersonalBotsPerUser < 0 ||
      draft.maxPersonalBotsPerUser > 20
    ) {
      next.maxBots = "Enter a whole number from 0 to 20";
    }
    if (
      !Number.isInteger(draft.personalDailyLimitMax) ||
      draft.personalDailyLimitMax < 1 ||
      draft.personalDailyLimitMax > MAX_DAILY_LIMIT
    ) {
      next.dailyMax = `Enter a whole number from 1 to ${MAX_DAILY_LIMIT.toLocaleString()}`;
    }
    if (restrictModels && draft.personalAllowedModels.length === 0) {
      next.models = "Pick at least one model, or allow every model";
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || tasksInvalid) return;
    try {
      const updated = await save.mutateAsync(toPolicyBody(draft, saved, restrictModels));
      setDraft(toDraft(updated));
      setRestrictModels(updated.personalAllowedModels.length > 0);
      toast.success("Bot policy saved", { description: "Every bot follows it from its next reply." });
    } catch (err) {
      toast.error("Could not save the bot policy", { description: errorMessage(err) });
    }
  }

  const available = new Set(policy.availableSearchProviders);
  const modelList = models.data?.models ?? [];

  return (
    <div className="grid gap-8" data-testid="bot-policy-settings">
      <Section
        title="Capabilities"
        description="What bots may do. Personal bots follow the stricter of both columns."
      >
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] items-center gap-4 border-b bg-muted/40 px-4 py-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wider sm:grid"
          >
            <span>Capability</span>
            <span className="text-center">All bots</span>
            <span className="text-center">Personal bots</span>
          </div>
          <ul className="divide-y">
            {CAPABILITIES.map((c) => {
              const entry = draft.capabilities[c.name];
              return (
                <li
                  key={c.name}
                  data-testid={`policy-row-${c.name}`}
                  className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem] sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
                    >
                      <c.icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-sm">{c.label}</span>
                      <span className="block text-muted-foreground text-xs leading-snug">
                        {c.description}
                      </span>
                    </span>
                  </div>
                  <div className="ml-11 grid grid-cols-2 gap-2 sm:contents">
                    <PolicySwitch
                      label="All bots"
                      ariaLabel={`${c.label}: all bots`}
                      checked={entry.orgWide}
                      onChange={(orgWide) => setCap(c.name, { orgWide })}
                      testId={`policy-${c.name}-orgWide`}
                    />
                    {c.personalApplies ? (
                      <PolicySwitch
                        label="Personal"
                        ariaLabel={`${c.label}: personal bots`}
                        checked={entry.orgWide && entry.personal}
                        disabled={!entry.orgWide}
                        hint={entry.orgWide ? undefined : "Off for every bot"}
                        onChange={(personal) => setCap(c.name, { personal })}
                        testId={`policy-${c.name}-personal`}
                      />
                    ) : (
                      <span
                        className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-dashed px-2 py-2 text-muted-foreground text-xs sm:border-0 sm:p-0"
                        data-testid={`policy-${c.name}-personal-na`}
                        title="Personal bots only answer in their owner's private chat"
                      >
                        <Lock className="size-3 shrink-0" aria-hidden />
                        <span className="sr-only">Personal bots: </span>
                        Private chat only
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      <Section
        title="Long tasks"
        description="Limits for each long task, and how many may run at once in the organization."
      >
        <div className="grid gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:grid-cols-2 xl:grid-cols-3">
          {TASK_FIELDS.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              hint={f.hint}
              value={draft.tasks[f.key]}
              min={f.min}
              max={f.max}
              error={taskErrors[f.key] ?? undefined}
              onChange={(value) => setDraft((d) => ({ ...d, tasks: { ...d.tasks, [f.key]: value } }))}
              testId={f.testId}
              touch
            />
          ))}
        </div>
      </Section>

      <Section title="Web search" description="Where bots with Internet search the web.">
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Search provider</legend>
          {PROVIDERS.map((p) => {
            const ok = available.has(p.id);
            const selected = draft.searchProvider === p.id;
            return (
              <label
                key={p.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-colors",
                  selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                  !ok && "cursor-not-allowed opacity-70",
                )}
              >
                <input
                  type="radio"
                  name="search-provider"
                  value={p.id}
                  checked={selected}
                  disabled={!ok && !selected}
                  onChange={() => setDraft((d) => ({ ...d, searchProvider: p.id }))}
                  data-testid={`policy-search-${p.id}`}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-sm">{p.label}</span>
                  <span className="block text-muted-foreground text-xs leading-snug">{p.description}</span>
                  {!ok ? (
                    <span className="mt-1.5 inline-block rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      Requires the search profile
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      </Section>

      <Section
        title="Personal bot limits"
        description="Limits for the private assistant each member can create."
      >
        <div className="grid gap-4 rounded-2xl border bg-card p-4 shadow-xs">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Personal bots per member"
              hint="0 turns personal bots off"
              value={draft.maxPersonalBotsPerUser}
              min={0}
              max={20}
              error={errors.maxBots}
              onChange={(maxPersonalBotsPerUser) => setDraft((d) => ({ ...d, maxPersonalBotsPerUser }))}
              testId="policy-maxPersonalBotsPerUser"
            />
            <NumberField
              label="Daily reply limit, maximum"
              hint="Owners choose a limit up to this"
              value={draft.personalDailyLimitMax}
              min={1}
              max={MAX_DAILY_LIMIT}
              error={errors.dailyMax}
              onChange={(personalDailyLimitMax) => setDraft((d) => ({ ...d, personalDailyLimitMax }))}
              testId="policy-personalDailyLimitMax"
            />
          </div>

          <div className="grid gap-2.5 border-t pt-4" data-testid="policy-models">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="block font-medium text-sm">Models for personal bots</span>
                <span className="block text-muted-foreground text-xs">
                  From the models allowed in Settings › Models
                </span>
              </span>
              <div
                className="inline-flex rounded-lg border bg-muted/40 p-0.5"
                role="radiogroup"
                aria-label="Models"
              >
                {[
                  { value: false, label: "Every model" },
                  { value: true, label: "Selected models" },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={restrictModels === o.value}
                    onClick={() => {
                      setRestrictModels(o.value);
                      setErrors((e) => ({ ...e, models: undefined }));
                    }}
                    className={cn(
                      "h-7 rounded-md px-2.5 font-medium text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                      restrictModels === o.value
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            {restrictModels ? (
              modelList.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
                  No models are allowed yet. Add a provider in Settings › Models.
                </p>
              ) : (
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {modelList.map((m) => {
                    const key = `${m.provider}/${m.modelId}`;
                    const on = draft.personalAllowedModels.includes(key);
                    return (
                      <li key={key}>
                        {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
                        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[13px]">
                              {m.label || modelLabel(m.provider, m.modelId)}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              {key}
                            </span>
                          </span>
                          <Switch
                            checked={on}
                            onCheckedChange={(v) => {
                              setErrors((e) => ({ ...e, models: undefined }));
                              setDraft((d) => ({
                                ...d,
                                personalAllowedModels: v
                                  ? [...d.personalAllowedModels, key]
                                  : d.personalAllowedModels.filter((x) => x !== key),
                              }));
                            }}
                            aria-label={`Allow ${m.label} for personal bots`}
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
            {errors.models ? (
              <p role="alert" className="text-[13px] text-destructive">
                {errors.models}
              </p>
            ) : null}
          </div>
        </div>
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <span className="mr-auto text-muted-foreground text-xs" aria-live="polite">
          {dirty
            ? "Unsaved changes"
            : policy.updatedAt
              ? "All changes saved"
              : "Defaults: everything allowed"}
        </span>
        <Button variant="outline" onClick={reset} disabled={!dirty || save.isPending}>
          <RotateCcw /> Discard
        </Button>
        <Button
          onClick={submit}
          disabled={!dirty || tasksInvalid || save.isPending}
          data-testid="bot-policy-save"
        >
          {save.isPending ? <Spinner /> : <Save />}
          Save policy
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

function PolicySwitch({
  label,
  ariaLabel,
  checked,
  disabled,
  hint,
  onChange,
  testId,
}: {
  label: string;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
    <label
      className={cn(
        "flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 sm:flex-col sm:justify-center sm:gap-1 sm:border-0 sm:p-0",
        disabled && "cursor-not-allowed",
      )}
      title={hint}
    >
      <span className="text-muted-foreground text-xs sm:sr-only">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
      />
      {hint ? <span className="hidden text-[10.5px] text-muted-foreground sm:block">{hint}</span> : null}
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  error,
  onChange,
  testId,
  touch = false,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  error?: string;
  onChange: (v: number) => void;
  testId: string;
  /** 44 px tall on phones (the Long tasks fields); the older fields keep their look. */
  touch?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isNaN(value) ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        aria-invalid={!!error}
        aria-describedby={`${id}-help`}
        data-testid={testId}
        className={cn("w-full tabular-nums", touch ? "h-11 sm:h-9 sm:max-w-40" : "h-9 sm:w-40")}
      />
      <span id={`${id}-help`} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? hint}
      </span>
    </div>
  );
}
