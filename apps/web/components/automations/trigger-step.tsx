"use client";

import type { AutomationTriggerKind, CreateAutomationResponse } from "@ocw/contracts";
import { CalendarClock, Mail, Webhook } from "lucide-react";
import type { SchedulePreviewState, ScheduleValue } from "@/lib/automation-queries";
import { cn } from "@/lib/utils";
import { ScheduleBuilder, type ScheduleErrors } from "./schedule-builder";

/** What the editor hands its WHEN step: the values it owns, how to change them, and their errors. */
export interface TriggerForm {
  triggerKind: AutomationTriggerKind;
  schedule: ScheduleValue;
  setTriggerKind: (kind: AutomationTriggerKind) => void;
  setSchedule: (schedule: ScheduleValue) => void;
  scheduleErrors: ScheduleErrors;
  preview: SchedulePreviewState;
  disabled: boolean;
}

const TRIGGERS = [
  { kind: "schedule", label: "Schedule", hint: "On days and times you choose", icon: CalendarClock },
  { kind: "webhook", label: "Webhook", hint: "When another app sends an event", icon: Webhook },
  { kind: "mail", label: "Mail", hint: "When mail arrives in a mailbox", icon: Mail },
] as const;

/**
 * WHEN (07.6-15, D-02, D-07, UI-SPEC Surface 2): Schedule · Webhook · Mail as radio cards (the 07.4 Transport markup),
 * then the chosen trigger's fields. Webhook is disabled with its reason for people without `automation.webhook`.
 * Switching trigger keeps the other sections. This plan builds the schedule branch; plan 07.6-18 renders the webhook
 * and mailbox panels from the same props (`canWebhook`, and `lastSave`: the save response that carries a webhook's
 * signing secret once), without touching the sheet.
 */
export function TriggerStep({
  form,
  canWebhook,
  lastSave,
  mode,
}: {
  form: TriggerForm;
  canWebhook: boolean;
  /** The last create or update response of this sheet (a new webhook's secret is in it, once). */
  lastSave: CreateAutomationResponse | null;
  mode: "new" | "edit" | "readonly";
}) {
  const locked = form.disabled || mode === "readonly";
  return (
    <div className="grid gap-4" data-testid="trigger-step" data-last-save={lastSave ? "yes" : undefined}>
      <fieldset className="grid gap-2">
        <legend className="sr-only">When</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {TRIGGERS.map((t) => {
            const selected = form.triggerKind === t.kind;
            const noRight = t.kind === "webhook" && !canWebhook && !selected;
            const off = locked || noRight;
            const Icon = t.icon;
            return (
              <label
                key={t.kind}
                data-testid={`trigger-kind-${t.kind}`}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors max-md:min-h-11 sm:flex-col sm:gap-1",
                  selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                  off && "cursor-not-allowed opacity-60",
                  "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                )}
              >
                <input
                  type="radio"
                  name="automation-trigger-kind"
                  value={t.kind}
                  checked={selected}
                  disabled={off}
                  onChange={() => form.setTriggerKind(t.kind)}
                  className="mt-0.5 size-4 shrink-0 accent-primary sm:sr-only"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium text-[13px]">
                    <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                    {t.label}
                  </span>
                  {/* A disabled option's reason replaces its hint, so it is read with the option. */}
                  <span className="block text-[11.5px] text-muted-foreground leading-snug">
                    {noRight ? "Only team leads and admins can create webhooks." : t.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {form.triggerKind === "schedule" ? (
        <ScheduleBuilder
          value={form.schedule}
          onChange={form.setSchedule}
          preview={form.preview}
          errors={form.scheduleErrors}
          disabled={locked}
        />
      ) : form.triggerKind === "webhook" ? (
        <p className="text-[13px] text-muted-foreground" data-testid="trigger-webhook-note">
          The URL and signing secret appear after you create the automation.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground" data-testid="trigger-mail-note">
          OCW only reads new mail that arrives after you save. It never marks, moves or deletes messages.
        </p>
      )}
    </div>
  );
}
