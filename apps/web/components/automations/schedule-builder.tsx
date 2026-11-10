"use client";

import { AUTOMATION_LIMITS, isKnownTimeZone } from "@ocw/contracts";
import { useMemo, useState } from "react";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  browserTimeZone,
  formatRunInstant,
  HOURLY_MINUTES,
  intervalOptions,
  nowThere,
  SCHEDULE_PRESETS,
  type SchedulePreset,
  type SchedulePreviewState,
  type ScheduleValue,
  WEEK_DAYS,
  yourTimeSuffix,
} from "@/lib/automation-queries";
import { cn } from "@/lib/utils";

/** Field errors the editor shows inside the schedule (UI-SPEC § Copy › Schedule errors). */
export type ScheduleErrors = Partial<Record<"days" | "time" | "timeZone" | "cron", string>>;

const TOUCH = "max-md:h-11";
const MONTH_DAYS = [...Array.from({ length: 28 }, (_, i) => String(i + 1)), "L"];
const monthDayLabel = (d: string) => (d === "L" ? "Last day" : d);

/**
 * The schedule of an automation (07.6-15, UI-SPEC Surface 2): presets (every hour at a quarter, every day, weekdays,
 * every week on chosen days, every month on a day or the last day, custom cron), the time, the IANA zone and the next
 * three runs the API previews. The cron the presets make is `scheduleToCron`; a cron no preset makes opens as Custom.
 * Every few minutes (07.17, D-01, PD-19) offers 5 / 10 / 15 / 30; intervals below the workspace's minimum
 * (`minMinutes`, from the options) stay listed, disabled, with the reason. The API decides the minimum, not this list.
 */
export function ScheduleBuilder({
  value,
  onChange,
  preview,
  errors,
  disabled,
  minMinutes,
}: {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  preview: SchedulePreviewState;
  errors: ScheduleErrors;
  disabled?: boolean;
  /** The workspace's minimum interval (`caps.minScheduleMinutes`); undefined while the options load. */
  minMinutes?: number | undefined;
}) {
  const set = (patch: Partial<ScheduleValue>) => onChange({ ...value, ...patch });
  const id = (k: string) => `automation-schedule-${k}`;
  const timed = value.preset !== "hourly" && value.preset !== "custom" && value.preset !== "every_minutes";
  const intervals = intervalOptions(minMinutes);

  return (
    <div className="grid gap-4" data-testid="schedule-builder">
      <FormField id={id("repeat")} label="Repeat">
        <Select
          items={SCHEDULE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          value={value.preset}
          onValueChange={(v) => v && set({ preset: v as SchedulePreset })}
          disabled={disabled}
        >
          <SelectTrigger id={id("repeat")} data-testid="schedule-repeat" className={TOUCH} />
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="max-md:min-h-11">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {value.preset === "every_minutes" ? (
        <FormField id={id("interval")} label="Every">
          <Select
            items={intervals.map((o) => ({ value: String(o.value), label: `Every ${o.value} minutes` }))}
            value={String(value.everyMinutes)}
            onValueChange={(v) => v && set({ everyMinutes: Number(v) })}
            disabled={disabled}
          >
            <SelectTrigger
              id={id("interval")}
              data-testid="schedule-interval"
              className={cn("w-full sm:w-56", TOUCH)}
            />
            <SelectContent>
              {intervals.map((o) => (
                <SelectItem
                  key={o.value}
                  value={String(o.value)}
                  disabled={o.disabled}
                  className="max-md:min-h-11"
                >
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : null}

      {value.preset === "hourly" ? (
        <FormField id={id("minute")} label="At minute">
          <Select
            items={HOURLY_MINUTES.map((m) => ({ value: m, label: `:${m}` }))}
            value={value.minute}
            onValueChange={(v) => v && set({ minute: String(v) })}
            disabled={disabled}
          >
            <SelectTrigger id={id("minute")} data-testid="schedule-minute" className={cn("w-32", TOUCH)} />
            <SelectContent>
              {HOURLY_MINUTES.map((m) => (
                <SelectItem key={m} value={m} className="max-md:min-h-11">
                  :{m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : null}

      {value.preset === "weekly" ? (
        <fieldset className="grid gap-2" aria-describedby={errors.days ? id("days-error") : undefined}>
          <legend className="mb-2 font-medium text-sm">On</legend>
          <div className="flex flex-wrap gap-1 md:gap-2" data-testid="schedule-days">
            {WEEK_DAYS.map((d) => {
              const checked = value.days.includes(d.n);
              return (
                <label
                  key={d.n}
                  className={cn(
                    "inline-flex h-8 min-w-11 cursor-pointer select-none items-center justify-center rounded-md border bg-card px-2 font-medium text-[13px] transition-colors max-md:size-11 max-md:min-w-0",
                    "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                    checked
                      ? "border-primary/50 bg-brand-soft/40 text-foreground ring-1 ring-primary/30"
                      : "text-muted-foreground hover:text-foreground",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    aria-label={d.long}
                    data-testid={`schedule-day-${d.short.toLowerCase()}`}
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) =>
                      set({
                        days: e.target.checked ? [...value.days, d.n] : value.days.filter((x) => x !== d.n),
                      })
                    }
                  />
                  <span aria-hidden>{d.short}</span>
                </label>
              );
            })}
          </div>
          {errors.days ? (
            <p id={id("days-error")} role="alert" className="text-[13px] text-destructive">
              {errors.days}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {value.preset === "monthly" ? (
        <FormField id={id("day")} label="Day">
          <Select
            items={MONTH_DAYS.map((d) => ({ value: d, label: monthDayLabel(d) }))}
            value={value.monthDay}
            onValueChange={(v) => v && set({ monthDay: String(v) })}
            disabled={disabled}
          >
            <SelectTrigger id={id("day")} data-testid="schedule-month-day" className={cn("w-40", TOUCH)} />
            <SelectContent>
              {MONTH_DAYS.map((d) => (
                <SelectItem key={d} value={d} className="max-md:min-h-11">
                  {monthDayLabel(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : null}

      {value.preset === "custom" ? (
        <FormField
          id={id("cron")}
          label="Cron"
          hint="Five fields: minute hour day month weekday."
          error={errors.cron}
        >
          <Input
            id={id("cron")}
            data-testid="schedule-cron"
            value={value.cron}
            maxLength={100}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="0 9 * * 1-5"
            disabled={disabled}
            onChange={(e) => set({ cron: e.target.value })}
            aria-invalid={!!errors.cron}
            aria-describedby={describedBy(id("cron"), errors.cron, "hint")}
            className={cn("font-mono", TOUCH)}
          />
        </FormField>
      ) : null}

      <div className={cn("grid gap-4", timed && "items-start sm:grid-cols-[10rem_minmax(0,1fr)]")}>
        {timed ? (
          <FormField id={id("time")} label="At" error={errors.time}>
            <Input
              id={id("time")}
              type="time"
              data-testid="schedule-time"
              value={value.time}
              disabled={disabled}
              onChange={(e) => set({ time: e.target.value })}
              aria-invalid={!!errors.time}
              aria-describedby={describedBy(id("time"), errors.time)}
              className={TOUCH}
            />
          </FormField>
        ) : null}
        <TimeZoneField
          value={value.timeZone}
          onChange={(timeZone) => set({ timeZone })}
          error={errors.timeZone}
          disabled={disabled}
        />
      </div>

      <NextRuns preview={preview} timeZone={value.timeZone} minMinutes={minMinutes} />
    </div>
  );
}

/**
 * The automation's IANA zone: an input with the runtime's zones as suggestions, checked on blur ("Pick a time zone from
 * the list"), with the local time there as its hint.
 */
export function TimeZoneField({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (zone: string) => void;
  error?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const [blurError, setBlurError] = useState<string | null>(null);
  const zones = useMemo(
    () => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
    [],
  );
  const id = "automation-schedule-zone";
  const shown = error ?? blurError ?? undefined;
  const hint = nowThere(value) ?? undefined;
  return (
    <FormField id={id} label="Time zone" hint={hint} error={shown}>
      <Input
        id={id}
        list={`${id}-list`}
        data-testid="schedule-zone"
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(e) => {
          setBlurError(null);
          onChange(e.target.value.trim());
        }}
        onBlur={() => setBlurError(isKnownTimeZone(value) ? null : "Pick a time zone from the list")}
        aria-invalid={!!shown}
        aria-describedby={describedBy(id, shown, hint)}
        className={TOUCH}
      />
      <datalist id={`${id}-list`}>
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </FormField>
  );
}

/**
 * The next three runs the API previews (R13), in the automation's zone, each with the browser's time when the zones
 * differ. While the preview loads: three skeleton chips; a refused schedule: the field error with the fixed sentence.
 */
export function NextRuns({
  preview,
  timeZone,
  browserZone = browserTimeZone(),
  minMinutes,
}: {
  preview: SchedulePreviewState;
  timeZone: string;
  browserZone?: string;
  /** The options' minimum, used when the preview's refusal carries none. */
  minMinutes?: number | undefined;
}) {
  const min = preview.state === "error" ? preview.minMinutes : undefined;
  const error =
    preview.state === "error"
      ? preview.code === "schedule_too_frequent"
        ? `Runs can be at most every ${min ?? minMinutes ?? AUTOMATION_LIMITS.minScheduleMinutesDefault} minutes in this workspace.`
        : preview.code === "invalid_time_zone"
          ? "Pick a time zone from the list"
          : "That schedule isn't valid"
      : null;
  return (
    <div className="grid gap-2" data-testid="next-runs">
      <p className="font-medium text-sm" aria-hidden>
        Next runs
      </p>
      {preview.state === "ok" ? (
        <>
          <ul
            aria-label="Next runs"
            className="flex flex-col gap-1 text-muted-foreground text-xs sm:flex-row sm:flex-wrap sm:gap-x-1"
          >
            {preview.next.map((iso) => (
              <li
                key={iso}
                data-testid="next-run"
                className="sm:after:content-['·'] sm:last:after:content-none sm:after:ml-1"
              >
                <time dateTime={iso}>
                  {formatRunInstant(iso, timeZone)}
                  {yourTimeSuffix(iso, timeZone, browserZone)}
                </time>
              </li>
            ))}
          </ul>
          <p className="sr-only" aria-live="polite">
            {preview.next[0] ? `Next run ${formatRunInstant(preview.next[0], timeZone)}` : ""}
          </p>
        </>
      ) : error ? (
        <p role="alert" data-testid="next-runs-error" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : preview.state === "loading" ? (
        <div className="flex flex-wrap gap-2" aria-hidden data-testid="next-runs-loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-36 motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">—</p>
      )}
    </div>
  );
}
