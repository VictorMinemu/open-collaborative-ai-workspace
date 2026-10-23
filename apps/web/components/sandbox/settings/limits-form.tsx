"use client";

import { SANDBOX_LIMITS, type SandboxLimitsSettings, type SandboxSettingsView } from "@ocw/contracts";
import { useId, useState } from "react";
import { formatBytes } from "@/components/chat/attachments/files";
import { QuotaMeter, quotaTone } from "@/components/sandbox/quota-meter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Limits (07.8-19; D-09, SBX-03, UI-SPEC §4.2): the caps every bot of the organization shares. Edited as text, checked
 * row by row with the API's ranges, saved explicitly (no autosave) with the version read. Lowering a cap below what is
 * in use now is allowed and says so. Disk is entered in whole GB; the API stores MB, and a field left unchanged sends
 * the stored value back exactly.
 */

const MB_PER_GB = 1024;

/** What a section's save answered: saved, a version conflict (the current values were reloaded), or an error. */
export type SaveResult = { kind: "saved" } | { kind: "conflict" } | { kind: "error"; message: string };

/** The current values replaced the ones this page had (409 `settings_version_conflict`). */
export const CONFLICT_NOTICE =
  "Someone else saved these settings first. The current values are shown; check them and save again.";

/** The line under a section's Save button: the save error, the conflict notice, or why saving is off. */
export function SaveFeedback({
  error,
  notice,
  disabledReason,
  testId,
}: {
  error: string | null;
  notice: string | null;
  disabledReason: string | null;
  testId: string;
}) {
  if (error) {
    return (
      <p role="alert" className="text-[13px] text-destructive sm:text-right" data-testid={`${testId}-error`}>
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p
        role="status"
        className="text-amber-700 text-xs sm:text-right dark:text-amber-300"
        data-testid={`${testId}-notice`}
      >
        {notice}
      </p>
    );
  }
  if (disabledReason) {
    return (
      <p className="text-muted-foreground text-xs sm:text-right" data-testid={`${testId}-disabled`}>
        {disabledReason}
      </p>
    );
  }
  return null;
}

type LimitKey = "maxSandboxes" | "maxBrowsers" | "cpuMinutesPerDay" | "diskPerBotGb" | "diskTotalGb";
export type LimitsDraft = Record<LimitKey, string>;

interface Field {
  key: LimitKey;
  label: string;
  min: number;
  max: number;
}

/** The API's ranges (`SandboxLimitsSettings`), disk in whole GB. */
export const LIMIT_FIELDS: readonly Field[] = [
  { key: "maxSandboxes", label: "Sandboxes at once", min: 0, max: 100 },
  { key: "maxBrowsers", label: "Browsers at once", min: 0, max: 50 },
  { key: "cpuMinutesPerDay", label: "CPU per day (minutes)", min: 1, max: 100_000 },
  { key: "diskPerBotGb", label: "Disk per bot (GB)", min: 1, max: 100 },
  { key: "diskTotalGb", label: "Disk in total (GB)", min: 1, max: 1024 },
];

const gb = (mb: number) => String(Math.round((mb / MB_PER_GB) * 10) / 10);

export function limitsDraftOf(l: SandboxLimitsSettings): LimitsDraft {
  return {
    maxSandboxes: String(l.maxSandboxes),
    maxBrowsers: String(l.maxBrowsers),
    cpuMinutesPerDay: String(l.cpuMinutesPerDay),
    diskPerBotGb: gb(l.diskPerBotMb),
    diskTotalGb: gb(l.diskTotalMb),
  };
}

/** "Use a whole number from {min} to {max}", or null when the value fits. */
export function limitError(field: Field, value: string): string | null {
  const v = value.trim();
  const n = Number(v);
  if (!/^\d+$/u.test(v) || !Number.isInteger(n) || n < field.min || n > field.max) {
    return `Use a whole number from ${field.min} to ${field.max}`;
  }
  return null;
}

/** The limits to save, or null when a changed row is invalid. Unchanged rows keep the stored value exactly. */
export function limitsFromDraft(
  draft: LimitsDraft,
  saved: SandboxLimitsSettings,
): SandboxLimitsSettings | null {
  const initial = limitsDraftOf(saved);
  for (const f of LIMIT_FIELDS) {
    if (draft[f.key] !== initial[f.key] && limitError(f, draft[f.key])) return null;
  }
  const num = (k: LimitKey) => Number(draft[k].trim());
  const changed = (k: LimitKey) => draft[k] !== initial[k];
  return {
    maxSandboxes: changed("maxSandboxes") ? num("maxSandboxes") : saved.maxSandboxes,
    maxBrowsers: changed("maxBrowsers") ? num("maxBrowsers") : saved.maxBrowsers,
    cpuMinutesPerDay: changed("cpuMinutesPerDay") ? num("cpuMinutesPerDay") : saved.cpuMinutesPerDay,
    diskPerBotMb: changed("diskPerBotGb") ? num("diskPerBotGb") * MB_PER_GB : saved.diskPerBotMb,
    diskTotalMb: changed("diskTotalGb") ? num("diskTotalGb") * MB_PER_GB : saved.diskTotalMb,
  };
}

/** "{n} are running now. New ones wait until fewer are running." when a concurrency cap goes below what runs now. */
export function belowUseWarning(
  key: LimitKey,
  value: string,
  running: { sandboxes: number; browsers: number },
) {
  if (key !== "maxSandboxes" && key !== "maxBrowsers") return null;
  const n = key === "maxSandboxes" ? running.sandboxes : running.browsers;
  const v = Number(value.trim());
  if (!/^\d+$/u.test(value.trim()) || v >= n) return null;
  return `${n} ${n === 1 ? "is" : "are"} running now. New ones wait until fewer are running.`;
}

interface Usage {
  text: string;
  used: number;
  max: number;
  label: string;
}

/** The usage cell of a row (current use against the saved cap), or null for "Disk per bot". */
function usageOf(key: LimitKey, view: SandboxSettingsView): Usage | null {
  const { limits } = view.settings;
  const running = view.isolation.running;
  switch (key) {
    case "maxSandboxes":
      return {
        text: `${running.sandboxes} running now`,
        used: running.sandboxes,
        max: limits.maxSandboxes,
        label: "Sandboxes running",
      };
    case "maxBrowsers":
      return {
        text: `${running.browsers} open now`,
        used: running.browsers,
        max: limits.maxBrowsers,
        label: "Browsers open",
      };
    case "cpuMinutesPerDay": {
      const used = Math.round(view.usage.cpuMinutesToday);
      return {
        text: `${used.toLocaleString("en")} used today`,
        used,
        max: limits.cpuMinutesPerDay,
        label: "CPU minutes today",
      };
    }
    case "diskTotalGb":
      return {
        text: `${formatBytes(view.usage.diskBytesTotal)} used`,
        used: view.usage.diskBytesTotal,
        max: limits.diskTotalMb * 1024 * 1024,
        label: "Disk used in total",
      };
    default:
      return null;
  }
}

/** Fixed per-container limits (the API's `CONTAINER_LIMITS`; the settings view does not carry them). */
export const CONTAINER_LINE = `Each sandbox: 1 CPU · 1 GB memory · 256 processes · stops after ${SANDBOX_LIMITS.idleStopMinutes} min without use. Each browser: 1 CPU · 2 GB memory · stops after 5 min without use.`;

/** The rows, as pure rendering of a draft (unit-tested in node). */
export function LimitsFields({
  view,
  draft,
  onChange,
}: {
  view: SandboxSettingsView;
  draft: LimitsDraft;
  onChange: (key: LimitKey, value: string) => void;
}) {
  const id = useId();
  const initial = limitsDraftOf(view.settings.limits);
  return (
    <div className="grid gap-4 sm:gap-3">
      {LIMIT_FIELDS.map((f) => {
        const value = draft[f.key];
        const error = value !== initial[f.key] ? limitError(f, value) : null;
        const warning = error ? null : belowUseWarning(f.key, value, view.isolation.running);
        const usage = usageOf(f.key, view);
        const inputId = `${id}-${f.key}`;
        const usageId = `${id}-${f.key}-usage`;
        const noteId = `${id}-${f.key}-note`;
        const describedBy = [usage ? usageId : null, error || warning ? noteId : null]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={f.key}
            data-testid={`limit-${f.key}`}
            className="grid gap-1.5 sm:grid-cols-[minmax(0,12rem)_6rem_minmax(0,1fr)] sm:items-center sm:gap-x-4 sm:gap-y-1"
          >
            <label htmlFor={inputId} className="text-sm">
              {f.label}
            </label>
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={f.min}
              max={f.max}
              step={1}
              value={value}
              onChange={(e) => onChange(f.key, e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy || undefined}
              className="w-full tabular-nums max-md:h-11 sm:w-24"
              data-testid={`limit-input-${f.key}`}
            />
            {usage ? (
              <div id={usageId} className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    // A fixed width from 640 px, so the meters line up row under row.
                    "shrink-0 text-xs tabular-nums sm:w-28",
                    quotaTone(usage.used, usage.max) === "ok"
                      ? "text-muted-foreground"
                      : quotaTone(usage.used, usage.max) === "warn"
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-red-700 dark:text-red-300",
                  )}
                >
                  {usage.text}
                </span>
                <QuotaMeter
                  used={usage.used}
                  max={usage.max}
                  label={usage.label}
                  className="w-32 max-sm:w-auto max-sm:flex-1"
                />
              </div>
            ) : (
              <span aria-hidden className="hidden sm:block" />
            )}
            {error ? (
              <p
                id={noteId}
                role="alert"
                className="text-[13px] text-destructive sm:col-span-2 sm:col-start-2"
                data-testid="limit-error"
              >
                {error}
              </p>
            ) : warning ? (
              <p
                id={noteId}
                className="text-amber-700 text-xs sm:col-span-2 sm:col-start-2 dark:text-amber-300"
                data-testid="limit-warning"
              >
                {warning}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function LimitsForm({
  view,
  disabledReason,
  notice,
  pending,
  onEdit,
  onSave,
}: {
  view: SandboxSettingsView;
  /** Why saving is off right now (the sandbox service is down), shown under the button. */
  disabledReason: string | null;
  /** A message from the last save (a version conflict reloaded the values). */
  notice: string | null;
  pending: boolean;
  onEdit: () => void;
  onSave: (limits: SandboxLimitsSettings) => Promise<SaveResult>;
}) {
  const saved = view.settings.limits;
  const [draft, setDraft] = useState<LimitsDraft>(() => limitsDraftOf(saved));
  const [error, setError] = useState<string | null>(null);
  const initial = limitsDraftOf(saved);
  const changed = LIMIT_FIELDS.some((f) => draft[f.key] !== initial[f.key]);
  const next = limitsFromDraft(draft, saved);

  async function submit() {
    if (!next) return;
    setError(null);
    const res = await onSave(next);
    if (res.kind === "error") setError(res.message);
  }

  return (
    <div className="grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5" data-testid="limits-form">
      <LimitsFields
        view={view}
        draft={draft}
        onChange={(key, value) => {
          setDraft((d) => ({ ...d, [key]: value }));
          setError(null);
          onEdit();
        }}
      />
      <p className="text-muted-foreground text-xs leading-4">{CONTAINER_LINE}</p>
      <div className="grid gap-2 sm:justify-items-end">
        <Button
          onClick={() => void submit()}
          disabled={!changed || !next || pending || disabledReason !== null}
          className="w-full max-md:h-11 sm:w-auto"
          data-testid="limits-save"
        >
          {pending ? <Spinner /> : null}
          Save limits
        </Button>
        <SaveFeedback error={error} notice={notice} disabledReason={disabledReason} testId="limits" />
      </div>
    </div>
  );
}
