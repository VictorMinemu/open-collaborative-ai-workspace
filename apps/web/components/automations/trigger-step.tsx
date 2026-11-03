"use client";

import type {
  Automation,
  AutomationTriggerKind,
  CreateAutomationResponse,
  InboundAction,
} from "@ocw/contracts";
import { CalendarClock, Mail, Webhook } from "lucide-react";
import { useId, useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { SchedulePreviewState, ScheduleValue } from "@/lib/automation-queries";
import {
  EMPTY_INBOUND,
  EMPTY_MAILBOX,
  effectiveInboundAction,
  type InboundErrors,
  type InboundValue,
  type MailboxErrors,
  type MailboxValue,
} from "@/lib/automation-trigger-queries";
import { cn } from "@/lib/utils";
import { InboundMapping } from "./inbound-mapping";
import { MailboxPanel } from "./mailbox-panel";
import { ScheduleBuilder, type ScheduleErrors } from "./schedule-builder";
import { SecretRevealDialog } from "./secret-reveal-dialog";
import { WebhookEndpointPanel } from "./webhook-endpoint-panel";

/** What the editor hands its WHEN step: the values it owns, how to change them, and their errors. */
export interface TriggerForm {
  triggerKind: AutomationTriggerKind;
  schedule: ScheduleValue;
  setTriggerKind: (kind: AutomationTriggerKind) => void;
  setSchedule: (schedule: ScheduleValue) => void;
  scheduleErrors: ScheduleErrors;
  preview: SchedulePreviewState;
  disabled: boolean;
  /** 07.6-18: the saved automation (its webhook endpoint or mailbox), null before the first save. */
  automation?: Automation | null;
  /** 07.6-18: What happens and the payload mapping (webhook and mail triggers). */
  inbound?: InboundValue;
  setInbound?: (inbound: InboundValue) => void;
  inboundErrors?: InboundErrors;
  /** 07.6-18: the mailbox of a mail trigger (a Keychain item, never a credential). */
  mailbox?: MailboxValue;
  setMailbox?: (mailbox: MailboxValue) => void;
  mailboxErrors?: MailboxErrors;
  /** 07.6-18: the delivery target decides the inbound actions offered. */
  targetKind?: Automation["target"]["kind"];
  botName?: string;
  /** 07.6-18: called when the reveal dialog is done, so the editor drops the secret from its state. */
  dropSecret?: () => void;
}

const TRIGGERS = [
  { kind: "schedule", label: "Schedule", hint: "On days and times you choose", icon: CalendarClock },
  { kind: "webhook", label: "Webhook", hint: "When another app sends an event", icon: Webhook },
  { kind: "mail", label: "Mail", hint: "When mail arrives in a mailbox", icon: Mail },
] as const;

/**
 * WHEN (07.6-15/18, D-02, D-07, UI-SPEC Surfaces 2-4): Schedule · Webhook · Mail as radio cards (the 07.4 Transport
 * markup), then the chosen trigger's fields. Webhook is disabled with its reason for people without
 * `automation.webhook`. Switching trigger keeps the other sections. A webhook shows its mapping before the first save
 * and its endpoint panel after it; a new webhook's signing secret (`lastSave.webhookSecret`, once) opens the reveal
 * dialog, and Done drops it from the editor's state. Webhook and mail add What happens, which follows the target.
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
  const [doneFor, setDoneFor] = useState<CreateAutomationResponse | null>(null);
  const secret = lastSave?.webhookSecret && doneFor !== lastSave ? lastSave.webhookSecret : null;
  const inbound = form.inbound ?? EMPTY_INBOUND;
  const setInbound = form.setInbound ?? (() => undefined);
  const saved = form.automation ?? lastSave?.automation ?? null;
  const webhookSaved = saved?.trigger.kind === "webhook" ? saved : null;
  const canRotate =
    mode !== "readonly" && canWebhook && !!webhookSaved && webhookSaved.viewerCan.includes("edit");

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
        webhookSaved ? (
          <WebhookEndpointPanel
            automation={webhookSaved}
            inbound={inbound}
            onInbound={setInbound}
            errors={form.inboundErrors ?? {}}
            canRotate={canRotate}
            disabled={locked}
          />
        ) : (
          <div className="grid gap-5" data-testid="webhook-panel">
            <p className="text-[13px] text-muted-foreground" data-testid="trigger-webhook-note">
              The URL and signing secret appear after you create the automation.
            </p>
            <InboundMapping
              value={inbound}
              onChange={setInbound}
              errors={form.inboundErrors ?? {}}
              payload={null}
              disabled={locked}
            />
          </div>
        )
      ) : (
        <MailboxPanel
          value={form.mailbox ?? EMPTY_MAILBOX}
          onChange={form.setMailbox ?? (() => undefined)}
          errors={form.mailboxErrors ?? {}}
          automation={saved?.trigger.kind === "mail" ? saved : null}
          disabled={locked}
        />
      )}

      {form.triggerKind !== "schedule" ? (
        <WhatHappens
          value={inbound}
          onChange={setInbound}
          targetKind={form.targetKind ?? "channel"}
          botName={form.botName ?? "The bot"}
          disabled={locked}
        />
      ) : null}

      <SecretRevealDialog
        secret={secret}
        onDone={() => {
          setDoneFor(lastSave);
          form.dropSecret?.();
        }}
      />
    </div>
  );
}

const ACTIONS: Record<
  "board_card" | "post" | "dm",
  { action: InboundAction; label: string; hint: string | null }
> = {
  board_card: {
    action: "board_card",
    label: "Create a board card",
    hint: "Each item becomes a card in the column you pick.",
  },
  post: {
    action: "post",
    label: "Post it in a thread",
    hint: "Each item starts a thread in the channel. Replies about the same item go to the same thread.",
  },
  dm: { action: "post", label: "Post it in your DM", hint: null },
};

/**
 * What happens (07.6-18, D-07, UI-SPEC Surface 2): how an incoming item lands, following the delivery target (a board
 * offers a card, its default, or a thread; a channel a thread; a DM the DM), and whether the bot is asked to read it
 * (on by default; its turn is read-only on outside content).
 */
export function WhatHappens({
  value,
  onChange,
  targetKind,
  botName,
  disabled,
}: {
  value: InboundValue;
  onChange: (next: InboundValue) => void;
  targetKind: Automation["target"]["kind"];
  botName: string;
  disabled: boolean;
}) {
  const id = useId();
  const current = effectiveInboundAction(value, targetKind);
  const options =
    targetKind === "board"
      ? [ACTIONS.board_card, ACTIONS.post]
      : targetKind === "dm"
        ? [ACTIONS.dm]
        : [ACTIONS.post];
  return (
    <fieldset className="mt-3 grid gap-3" data-testid="what-happens">
      <legend className="mb-3 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
        What happens
      </legend>
      <div className="divide-y overflow-hidden rounded-lg border">
        {options.map((o) => {
          const checked = current === o.action;
          return (
            <label
              key={o.label}
              data-testid={`inbound-action-${o.action}`}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 bg-card px-3 py-2.5 max-md:min-h-11",
                checked && "bg-brand-soft/40",
                disabled && "cursor-not-allowed opacity-60",
                "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40 has-[:focus-visible]:ring-inset",
              )}
            >
              <input
                type="radio"
                name={`${id}-inbound-action`}
                value={o.action}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange({ ...value, action: o.action })}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block font-medium text-[13px]">{o.label}</span>
                {o.hint ? (
                  <span className="block text-[12px] text-muted-foreground leading-snug">{o.hint}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-3 max-md:min-h-11">
          <span id={`${id}-ask`} className="font-medium text-sm">
            Ask {botName} to read it
          </span>
          <Switch
            data-testid="inbound-ask-bot"
            checked={value.askBot}
            disabled={disabled}
            aria-labelledby={`${id}-ask`}
            aria-describedby={`${id}-ask-hint`}
            onCheckedChange={(askBot) => onChange({ ...value, askBot })}
            // A 44 px hit area below 768 without a bigger switch: a transparent border outside the painted track.
            className="max-md:-mr-3 max-md:box-content max-md:border-[12px] max-md:bg-clip-padding"
          />
        </div>
        <p id={`${id}-ask-hint`} className="text-muted-foreground text-xs">
          {botName} reads the item and answers in its thread. It can't take actions on outside content without
          approval.
        </p>
      </div>
    </fieldset>
  );
}
