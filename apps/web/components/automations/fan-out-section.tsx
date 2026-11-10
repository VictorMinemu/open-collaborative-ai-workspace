"use client";

import {
  type AutomationActionKind,
  type AutomationFanOutInput,
  type AutomationFanOutView,
  type AutomationTriggerKind,
  FAN_OUT_LIMITS,
} from "@ocw/contracts";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The editor's fan-out fields; the caps stay strings while typed, like runs a day. */
export interface FanOutValue {
  enabled: boolean;
  perRun: string;
  perDay: string;
}

export type FanOutErrors = Partial<Record<"perRun" | "perDay", string>>;

export const FAN_OUT_DEFAULT: FanOutValue = {
  enabled: false,
  perRun: String(FAN_OUT_LIMITS.perRunDefault),
  perDay: String(FAN_OUT_LIMITS.perDayDefault),
};

/** The stored settings as form values; an automation without them (an older server) opens off with the defaults. */
export function fanOutValueOf(v: AutomationFanOutView | undefined): FanOutValue {
  if (!v) return FAN_OUT_DEFAULT;
  return { enabled: v.enabled, perRun: String(v.perRun), perDay: String(v.perDay) };
}

/**
 * Where the section shows (D-02, D-16, PD-05): agent-turn schedules (Run now included) into a channel or a board.
 * Webhooks and mail keep one item per event; digests, DMs and threads never fan out. The API decides
 * (`fan_out_not_allowed`); this only hides what it would refuse.
 */
export function fanOutAllowed(p: {
  actionKind: AutomationActionKind;
  triggerKind: AutomationTriggerKind;
  targetKind: string;
}): boolean {
  return (
    p.actionKind === "agent_turn" &&
    p.triggerKind === "schedule" &&
    (p.targetKind === "channel" || p.targetKind === "board")
  );
}

const whole = (raw: string, max: number): number | null => {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
};

/**
 * The `fanOut` body of the form's values. On: both caps are whole numbers in range, and per day at least per run
 * (inline errors otherwise). Off: the inputs are hidden, so caps that don't parse fall back to the defaults.
 */
export function fanOutPayload(
  v: FanOutValue,
): { ok: true; fanOut: AutomationFanOutInput } | { ok: false; errors: FanOutErrors } {
  const perRun = whole(v.perRun, FAN_OUT_LIMITS.perRunMax);
  const perDay = whole(v.perDay, FAN_OUT_LIMITS.perDayMax);
  if (!v.enabled) {
    const ok = perRun !== null && perDay !== null && perRun <= perDay;
    return {
      ok: true,
      fanOut: {
        enabled: false,
        perRun: ok ? perRun : FAN_OUT_LIMITS.perRunDefault,
        perDay: ok ? perDay : FAN_OUT_LIMITS.perDayDefault,
      },
    };
  }
  const errors: FanOutErrors = {};
  if (perRun === null) errors.perRun = `Use a whole number from 1 to ${FAN_OUT_LIMITS.perRunMax}`;
  if (perDay === null) errors.perDay = `Use a whole number from 1 to ${FAN_OUT_LIMITS.perDayMax}`;
  if (perRun !== null && perDay !== null && perRun > perDay)
    errors.perDay = "At most per day must be at least per run";
  if (perRun === null || perDay === null || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, fanOut: { enabled: true, perRun, perDay } };
}

/**
 * What a save sends (PD-05): a new automation only when fan-out is on where it is allowed; an existing one only when
 * the section changed, or `enabled: false` with its stored caps when it moves where fan-out isn't allowed (the API
 * would refuse the resulting row). Untouched automations save exactly as before: no `fanOut` key.
 */
export function fanOutForSave(p: {
  allowed: boolean;
  value: FanOutValue;
  /** The values the form was loaded from; null for a new automation. */
  initial: FanOutValue | null;
}): { ok: true; fanOut: AutomationFanOutInput | undefined } | { ok: false; errors: FanOutErrors } {
  if (!p.initial) {
    if (!p.allowed || !p.value.enabled) return { ok: true, fanOut: undefined };
    return fanOutPayload(p.value);
  }
  if (!p.allowed) {
    if (!p.initial.enabled) return { ok: true, fanOut: undefined };
    return fanOutPayload({ ...p.initial, enabled: false });
  }
  const same =
    p.value.enabled === p.initial.enabled &&
    p.value.perRun.trim() === p.initial.perRun.trim() &&
    p.value.perDay.trim() === p.initial.perDay.trim();
  if (same) return { ok: true, fanOut: undefined };
  return fanOutPayload(p.value);
}

/** The conversations fan-out may open a day, for the daily-limit callout (D-11): per day when on, else 0. */
export function fanOutPerDayOf(allowed: boolean, v: FanOutValue): number {
  if (!allowed || !v.enabled) return 0;
  return whole(v.perDay, FAN_OUT_LIMITS.perDayMax) ?? 0;
}

const TOUCH = "max-md:h-11";

/**
 * "For each new item" (07.17, D-02, PD-19), after "Deliver to": one switch row, and when on the two caps (one row on
 * desktop, stacked on phones) with what happens to items already opened and where runs are listed.
 */
export function FanOutSection({
  value,
  onChange,
  targetKind,
  conversationName,
  columnName,
  automationName,
  errors,
  disabled,
}: {
  value: FanOutValue;
  onChange: (next: FanOutValue) => void;
  targetKind: "channel" | "board";
  /** `#orders`, or null while the target options load. */
  conversationName: string | null;
  /** The board column new cards go to (`Backlog`); null for a channel. */
  columnName: string | null;
  automationName: string;
  errors: FanOutErrors;
  disabled?: boolean;
}) {
  const id = (k: string) => `automation-fan-out-${k}`;
  const where =
    targetKind === "board"
      ? `a card in ${columnName ?? "the board's column"}`
      : `a thread in ${conversationName ?? "the channel"}`;
  const name = automationName.trim();
  return (
    <div className="grid gap-4" data-testid="automation-fan-out-section">
      <label
        htmlFor={id("switch")}
        className={cn(
          "flex min-h-11 cursor-pointer items-start justify-between gap-4 rounded-lg border bg-card px-3 py-2.5",
          disabled && "cursor-not-allowed opacity-70",
        )}
      >
        <span className="grid min-w-0 gap-0.5">
          <span className="font-medium text-sm">Open a conversation for each new item</span>
          <span id={id("hint")} className="text-[13px] text-muted-foreground leading-snug">
            The bot opens {where} for every item it has not opened before, and works each one on its own.
          </span>
        </span>
        <Switch
          id={id("switch")}
          data-testid="automation-fan-out"
          checked={value.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
          aria-label="Open a conversation for each new item"
          aria-describedby={id("hint")}
          className="mt-0.5"
        />
      </label>
      {value.enabled ? (
        <div className="grid gap-3">
          <div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
            <FormField id={id("per-run")} label="At most per run" error={errors.perRun}>
              <Input
                id={id("per-run")}
                data-testid="automation-fan-out-per-run"
                inputMode="numeric"
                value={value.perRun}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, perRun: e.target.value })}
                aria-invalid={!!errors.perRun}
                aria-describedby={describedBy(id("per-run"), errors.perRun)}
                className={cn("tabular-nums", TOUCH)}
              />
            </FormField>
            <FormField id={id("per-day")} label="At most per day" error={errors.perDay}>
              <Input
                id={id("per-day")}
                data-testid="automation-fan-out-per-day"
                inputMode="numeric"
                value={value.perDay}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, perDay: e.target.value })}
                aria-invalid={!!errors.perDay}
                aria-describedby={describedBy(id("per-day"), errors.perDay)}
                className={cn("tabular-nums", TOUCH)}
              />
            </FormField>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Up to {FAN_OUT_LIMITS.perRunMax} per run and {FAN_OUT_LIMITS.perDayMax} a day. Items already
            opened are skipped, never opened twice. Items already opened stay where they are if you change the
            target.
          </p>
          <p className="text-[13px] text-muted-foreground" data-testid="automation-fan-out-dedicated">
            Pick a channel or board just for these items: what the bot opens counts as outside content, so a
            bot mentioned there starts with its safety limits on.
          </p>
          <p className="text-muted-foreground text-xs" data-testid="automation-fan-out-runs-thread">
            {name ? `Runs are listed in one “${name} · Runs” thread.` : "Runs are listed in one thread."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
