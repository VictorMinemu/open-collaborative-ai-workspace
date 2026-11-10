"use client";

import {
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationFanOutInput,
  type AutomationOptions,
  type AutomationTarget,
  type AutomationTargetOptions,
  type AutomationTriggerInput,
  type AutomationTriggerKind,
  type CreateAutomationRequest,
  type CreateAutomationResponse,
  isKnownTimeZone,
  type UpdateAutomationRequest,
} from "@ocw/contracts";
import { CircleAlert, Info, Pause, Play, Trash2, X, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bots/bot-bits";
import { SheetSection } from "@/components/bots/bot-form";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { EmptyState } from "@/components/common/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, isApiError } from "@/lib/api";
import {
  type AutomationDraftDefaults,
  automationErrorText,
  baseVersionAfter,
  cronToSchedule,
  defaultSchedule,
  expectedTurnsPerDay,
  formatRunInstant,
  resumedText,
  runReasonSentence,
  runsPerDayPrefill,
  type ScheduleValue,
  scheduleToCron,
  targetName,
  useAutomation,
  useAutomationDraft,
  useAutomationOptions,
  useDeleteAutomation,
  usePauseAutomation,
  useResumeAutomation,
  useRunNow,
  useSaveAutomation,
  useSchedulePreview,
  useTargetOptions,
} from "@/lib/automation-queries";
import {
  EMPTY_INBOUND,
  EMPTY_MAILBOX,
  type InboundErrors,
  type InboundValue,
  inboundErrors,
  inboundOf,
  inboundValueOf,
  type MailboxErrors,
  type MailboxValue,
  mailboxConfigOf,
  mailboxErrors,
  mailboxValueOf,
} from "@/lib/automation-trigger-queries";
import { useAgents } from "@/lib/bots-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  FAN_OUT_DEFAULT,
  type FanOutErrors,
  FanOutSection,
  type FanOutValue,
  fanOutAllowed,
  fanOutForSave,
  fanOutPerDayOf,
  fanOutValueOf,
} from "./fan-out-section";
import { RunHistory } from "./run-history";
import type { ScheduleErrors } from "./schedule-builder";
import { EMPTY_TARGET, type TargetErrors, TargetPicker, type TargetValue } from "./target-picker";
import { TriggerStep } from "./trigger-step";

interface Values {
  name: string;
  agentId: string;
  instructions: string;
  triggerKind: AutomationTriggerKind;
  schedule: ScheduleValue;
  target: TargetValue;
  maxRunsPerDay: string;
  /** Webhook and mail triggers (07.6-18): What happens + mapping, and the mailbox. */
  inbound: InboundValue;
  mailbox: MailboxValue;
  /** 07.17 (D-02, PD-05): one conversation per new item, with its caps. */
  fanOut: FanOutValue;
}

type Errors = Partial<Record<"name" | "agent" | "instructions" | "maxRunsPerDay", string>> & {
  schedule?: ScheduleErrors;
  target?: TargetErrors;
  inbound?: InboundErrors;
  mailbox?: MailboxErrors;
  fanOut?: FanOutErrors;
};

type Mode = "new" | "edit" | "readonly";

const TOUCH = "max-md:h-11";
const COUNTER_FROM = 3200;

function targetValueOf(t: Automation["target"]): TargetValue {
  return {
    kind: t.kind,
    conversationId: "conversationId" in t ? t.conversationId : "",
    columnId: t.kind === "board" ? t.columnId : "",
    threadRootMessageId: t.kind === "thread" ? t.threadRootMessageId : "",
    label: t.label,
  };
}

function valuesOf(a: Automation): Values {
  const zone = a.trigger.schedule?.timeZone;
  return {
    name: a.name,
    agentId: a.agent.id,
    instructions: a.instructions,
    triggerKind: a.trigger.kind,
    schedule: a.trigger.schedule ? cronToSchedule(a.trigger.schedule.cron, zone ?? "UTC") : defaultSchedule(),
    target: targetValueOf(a.target),
    maxRunsPerDay: String(a.maxRunsPerDay),
    inbound: inboundValueOf(a.inbound),
    mailbox: mailboxValueOf(a.trigger.mailbox),
    fanOut: fanOutValueOf(a.fanOut),
  };
}

function valuesOfDraft(d: AutomationDraftDefaults): Values {
  return {
    ...d,
    triggerKind: "schedule",
    inbound: EMPTY_INBOUND,
    mailbox: EMPTY_MAILBOX,
    fanOut: FAN_OUT_DEFAULT,
  };
}

/**
 * The form with the first usable bot when it has none yet (a personal bot also switches the target to its DM); a
 * form that already has a bot, such as a proposal's, comes back unchanged.
 */
export function withDefaultBot<V extends { agentId: string; target: { kind: string } }>(
  v: V,
  bots: readonly { id: string; ready: boolean; personal: boolean }[],
): V {
  if (v.agentId || bots.length === 0) return v;
  const first = bots.find((b) => b.ready) ?? bots[0];
  if (!first) return v;
  const target = first.personal ? { ...EMPTY_TARGET, kind: "dm" as const } : v.target;
  return { ...v, agentId: first.id, target };
}

function blank(): Values {
  return {
    name: "",
    agentId: "",
    instructions: "",
    triggerKind: "schedule",
    schedule: defaultSchedule(),
    target: EMPTY_TARGET,
    maxRunsPerDay: String(AUTOMATION_LIMITS.maxRunsPerDayDefault),
    inbound: EMPTY_INBOUND,
    mailbox: EMPTY_MAILBOX,
    fanOut: FAN_OUT_DEFAULT,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function targetOf(t: TargetValue): AutomationTarget | null {
  switch (t.kind) {
    case "dm":
      return { kind: "dm" };
    case "channel":
      return t.conversationId ? { kind: "channel", conversationId: t.conversationId } : null;
    case "thread":
      return t.conversationId && t.threadRootMessageId
        ? { kind: "thread", conversationId: t.conversationId, threadRootMessageId: t.threadRootMessageId }
        : null;
    case "board":
      return t.conversationId && t.columnId
        ? { kind: "board", conversationId: t.conversationId, columnId: t.columnId }
        : null;
  }
}

/**
 * The target's names for the editor's copy (`#orders`, the board column `Backlog`): from the bot's target options, else
 * from the stored label (`#orders`, `Fleet · Backlog`, `Thread in #orders`) while they load or for a read-only viewer.
 */
export function targetNamesOf(
  t: TargetValue,
  conversations: AutomationTargetOptions["conversations"] | undefined,
): { conversation: string | null; column: string | null } {
  if (t.kind === "dm") return { conversation: "your DM", column: null };
  const c = conversations?.find((x) => x.conversationId === t.conversationId);
  const [first, second] = t.label ? t.label.replace(/^Thread in /, "").split(" · ") : [];
  const conversation = c ? (c.layout === "board" ? c.name : `#${c.name}`) : (first ?? null);
  const column =
    t.kind === "board" ? (c?.columns.find((x) => x.id === t.columnId)?.name ?? second ?? null) : null;
  return { conversation, column };
}

function triggerOf(v: Values): AutomationTriggerInput | null {
  if (v.triggerKind === "schedule") {
    const cron = scheduleToCron(v.schedule);
    return cron ? { kind: "schedule", schedule: { cron, timeZone: v.schedule.timeZone } } : null;
  }
  if (v.triggerKind === "webhook") return { kind: "webhook" };
  const mailbox = mailboxConfigOf(v.mailbox);
  return mailbox ? { kind: "mail", mailbox } : null;
}

/**
 * The automation editor (07.6-15, AUTO-01, D-07, R2, R5, R13, UI-SPEC Surface 2): one right sheet for `?new=1`,
 * `?edit=<id>` (Settings · Runs) and `?draft=<approvalId>` (a bot's proposal, prefilled). The person it runs as is
 * always the viewer who creates it (read-only line); a manager opening someone else's sees every control disabled and
 * only Pause and Delete (P-04). Validation happens in place before any request; API refusals become one blocking
 * notice with the fixed sentence of their code; a 409 version offers Reload.
 */
export function AutomationEditorSheet({
  open,
  id,
  draftId,
  tab,
  runId,
  onTab,
  onClose,
  onCreated,
  onOpenRuns,
}: {
  open: boolean;
  id: string | null;
  draftId: string | null;
  tab: "settings" | "runs";
  runId: string | null;
  onTab: (tab: "settings" | "runs") => void;
  onClose: () => void;
  /** `keepOpen`: a new webhook stays open on its edit view for the secret reveal (07.6-18). */
  onCreated: (a: Automation, opts?: { keepOpen?: boolean }) => void;
  onOpenRuns: (id: string) => void;
}) {
  const me = useMe({ enabled: false }).data?.user ?? null;
  const detail = useAutomation(open ? id : null);
  const draft = useAutomationDraft(open && !id ? draftId : null);
  const options = useAutomationOptions(open);
  const agents = useAgents().data?.agents;
  const save = useSaveAutomation();
  const pause = usePauseAutomation();
  const resume = useResumeAutomation();
  const runNow = useRunNow();

  const automation = id ? (detail.data ?? null) : null;
  const draftView = draft?.state === "ready" ? draft : null;
  const own = !!automation && automation.runAs.id === me?.id;
  const mode: Mode = !id
    ? "new"
    : automation && own && automation.viewerCan.includes("edit")
      ? "edit"
      : "readonly";
  const readonly = mode === "readonly";

  const [initial, setInitial] = useState<Values>(blank);
  const [values, setValues] = useState<Values>(blank);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lastSave, setLastSave] = useState<CreateAutomationResponse | null>(null);
  // The version the form was loaded from: a live refetch must never move it, or a save would overwrite a change made
  // meanwhile instead of answering 409 (the "changed while you were editing" banner).
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const loadedFor = useRef<string | null>(null);
  // The proposal this sheet just saved: it closes as "no longer open" a moment before the sheet does; never show that.
  const savedDraft = useRef<string | null>(null);

  // A fresh form each time the sheet opens on something else (new, an automation, a draft).
  const key = open ? (id ? `edit:${id}` : draftId ? `draft:${draftId}` : "new") : null;
  useEffect(() => {
    if (!key) {
      loadedFor.current = null;
      savedDraft.current = null;
      return;
    }
    const source = id ? automation : draftId ? draftView : "blank";
    if (!source || loadedFor.current === key) return;
    loadedFor.current = key;
    const start =
      source === "blank" ? blank() : "defaults" in source ? valuesOfDraft(source.defaults) : valuesOf(source);
    setInitial(start);
    setValues(start);
    setErrors({});
    setFormError(null);
    setConflict(false);
    setLastSave(null);
    setBaseVersion(source !== "blank" && "version" in source ? source.version : null);
    setConfirmDiscard(false);
  }, [key, id, draftId, automation, draftView]);

  // A new automation picks the first usable bot (personal bots first, as the API lists them). A proposal (`?draft=`)
  // always keeps its own bot, and the functional update never replaces a bot already set in the same render.
  const bots = options.data?.bots ?? [];
  useEffect(() => {
    if (mode !== "new" || draftId || values.agentId || bots.length === 0) return;
    setValues((v) => withDefaultBot(v, bots));
    setInitial((v) => withDefaultBot(v, bots));
  }, [mode, draftId, values.agentId, bots]);

  const bot =
    bots.find((b) => b.id === values.agentId) ??
    (automation ? { ...automation.agent, unitName: null, ready: true } : null) ??
    (draftView
      ? {
          ...draftView.bot,
          personal: draftView.defaults.target.kind === "dm",
          unitName: null,
          ready: true,
        }
      : null);
  const botName = bot?.displayName ?? "The bot";
  const caps = options.data?.caps;
  const maxRuns = caps?.maxRunsPerDayCap ?? AUTOMATION_LIMITS.maxRunsPerDayCeiling;
  // "For each new item" shows only where the API allows fan-out (PD-05); the API still decides.
  const fanOutOn = fanOutAllowed({
    actionKind: automation?.actionKind ?? "agent_turn",
    triggerKind: values.triggerKind,
    targetKind: values.target.kind,
  });
  const targetOptions = useTargetOptions(open && !readonly && values.agentId ? values.agentId : null);
  const names = targetNamesOf(values.target, targetOptions.data?.conversations);

  const cron = values.triggerKind === "schedule" ? scheduleToCron(values.schedule) : null;
  const livePreview = useSchedulePreview(
    open && !readonly && tab === "settings" && cron ? { cron, timeZone: values.schedule.timeZone } : null,
  );
  // Read-only (a manager), nothing is edited: the stored next run is the preview (the preview route is a creator's).
  const preview: typeof livePreview =
    readonly && automation?.nextRunAt && automation.status === "active"
      ? { state: "ok", next: [automation.nextRunAt] }
      : livePreview;
  const dirty = !same(values, initial);

  function set(patch: Partial<Values>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors({});
    setFormError(null);
  }

  function pickBot(agentId: string) {
    const next = bots.find((b) => b.id === agentId);
    // A personal bot delivers only to the person's DM; any bot change re-picks the conversation.
    const target: TargetValue = next?.personal
      ? { ...EMPTY_TARGET, kind: "dm" }
      : values.target.kind === "dm"
        ? EMPTY_TARGET
        : { ...EMPTY_TARGET, kind: values.target.kind === "thread" ? "channel" : values.target.kind };
    set({ agentId, target });
  }

  function requestClose() {
    if (!readonly && dirty && (mode !== "new" || values.name || values.instructions)) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function validate(): {
    trigger: AutomationTriggerInput;
    target: AutomationTarget;
    runs: number;
    fanOut: AutomationFanOutInput | undefined;
  } | null {
    const e: Errors = {};
    const name = values.name.trim();
    if (!name) e.name = "Give the automation a name";
    else if (name.length > AUTOMATION_LIMITS.nameMax) e.name = "Keep it under 120 characters";
    if (!values.agentId) e.agent = "Pick a bot";
    const instructions = values.instructions.trim();
    if (!instructions) e.instructions = "Write the instructions";
    else if (instructions.length > AUTOMATION_LIMITS.instructionsMax)
      e.instructions = "Keep them under 4000 characters";
    const s: ScheduleErrors = {};
    if (values.triggerKind === "schedule") {
      const v = values.schedule;
      if (v.preset === "weekly" && v.days.length === 0) s.days = "Pick at least one day";
      if (
        v.preset !== "hourly" &&
        v.preset !== "custom" &&
        v.preset !== "every_minutes" &&
        !/^\d{2}:\d{2}$/.test(v.time)
      )
        s.time = "Enter a time";
      if (!isKnownTimeZone(v.timeZone)) s.timeZone = "Pick a time zone from the list";
      if (v.preset === "custom" && !v.cron.trim()) s.cron = "That schedule isn't valid";
      if (preview.state === "error" && !s.timeZone && !s.cron) {
        if (preview.code === "invalid_cron") s.cron = "That schedule isn't valid";
        else if (preview.code === "invalid_time_zone") s.timeZone = "Pick a time zone from the list";
      }
      if (Object.keys(s).length > 0) e.schedule = s;
    } else {
      const ie = inboundErrors(values.inbound);
      if (Object.keys(ie).length > 0) e.inbound = ie;
      const me = values.triggerKind === "mail" ? mailboxErrors(values.mailbox) : {};
      if (Object.keys(me).length > 0) e.mailbox = me;
    }
    const t: TargetErrors = {};
    const target = targetOf(values.target);
    if (!target) {
      if (!values.target.conversationId)
        t.conversation = values.target.kind === "board" ? "Pick a board" : "Pick a channel";
      else t.column = "Pick a column";
      e.target = t;
    }
    const raw = values.maxRunsPerDay.trim();
    const runs = Number(raw);
    if (!/^\d+$/.test(raw) || runs < 1 || runs > maxRuns)
      e.maxRunsPerDay = `Use a whole number from 1 to ${maxRuns}`;
    const fan = fanOutForSave({
      allowed: fanOutOn,
      value: values.fanOut,
      initial: mode === "new" ? null : initial.fanOut,
    });
    if (!fan.ok) e.fanOut = fan.errors;
    setErrors(e);
    if (Object.keys(e).length > 0) return null;
    // A schedule the preview refused (too frequent) is refused by the save the same way: say it before asking.
    if (
      values.triggerKind === "schedule" &&
      preview.state === "error" &&
      preview.code === "schedule_too_frequent"
    ) {
      setFormError(
        `Runs can be at most every ${preview.minMinutes ?? caps?.minScheduleMinutes ?? AUTOMATION_LIMITS.minScheduleMinutesDefault} minutes in this workspace.`,
      );
      return null;
    }
    const trigger = triggerOf(values);
    if (!trigger || !target) {
      setFormError("Couldn't save the automation. Try again.");
      return null;
    }
    return { trigger, target, runs, fanOut: fan.ok ? fan.fanOut : undefined };
  }

  const errorCtx = () => ({
    bot: botName,
    conversation: values.target.label || (values.target.kind === "dm" ? "your DM" : "this conversation"),
    ...(caps ? { maxAutomations: caps.maxAutomationsPerUser, minMinutes: caps.minScheduleMinutes } : {}),
  });

  async function submit() {
    const ok = validate();
    if (!ok) return;
    const name = values.name.trim();
    try {
      if (mode === "new") {
        const body: CreateAutomationRequest = {
          name,
          agentId: values.agentId,
          instructions: values.instructions.trim(),
          trigger: ok.trigger,
          target: ok.target,
          maxRunsPerDay: ok.runs,
          ...(ok.trigger.kind !== "schedule" ? { inbound: inboundOf(values.inbound, ok.target.kind) } : {}),
          ...(draftId && draftView ? { fromApprovalId: draftId } : {}),
          ...(ok.fanOut ? { fanOut: ok.fanOut } : {}),
        };
        const res = await save.mutateAsync({ body });
        // A webhook's secret leaves the mutation cache at once (07.6-18): it lives only in this sheet's state.
        if (res.webhookSecret) save.reset();
        setLastSave(res);
        const a = res.automation;
        const zone = a.trigger.schedule?.timeZone;
        toast.success(
          a.nextRunAt && zone
            ? `Created “${a.name}”. First run ${formatRunInstant(a.nextRunAt, zone)}.`
            : `Created “${a.name}”.`,
        );
        if (body.fromApprovalId) savedDraft.current = body.fromApprovalId;
        if (res.webhookSecret) {
          // The sheet stays open on the new automation: the reveal dialog, then its endpoint panel.
          const next = valuesOf(a);
          loadedFor.current = `edit:${a.id}`;
          setBaseVersion(a.version);
          setInitial(next);
          setValues(next);
          onCreated(a, { keepOpen: true });
          return;
        }
        loadedFor.current = null;
        onCreated(a);
        return;
      }
      if (!automation) return;
      const body: UpdateAutomationRequest = {
        expectedVersion: baseVersion ?? automation.version,
      };
      if (name !== initial.name.trim()) body.name = name;
      if (values.agentId !== initial.agentId) body.agentId = values.agentId;
      if (values.instructions.trim() !== initial.instructions.trim())
        body.instructions = values.instructions.trim();
      if (
        values.triggerKind !== initial.triggerKind ||
        !same(values.schedule, initial.schedule) ||
        (values.triggerKind === "mail" && !same(values.mailbox, initial.mailbox))
      )
        body.trigger = ok.trigger;
      if (!same(values.target, initial.target) || body.agentId) body.target = ok.target;
      if (ok.trigger.kind === "schedule") {
        if (initial.triggerKind !== "schedule") body.inbound = null;
      } else if (body.trigger || body.target || !same(values.inbound, initial.inbound)) {
        body.inbound = inboundOf(values.inbound, ok.target.kind);
      }
      if (values.maxRunsPerDay.trim() !== initial.maxRunsPerDay.trim()) body.maxRunsPerDay = ok.runs;
      if (ok.fanOut) body.fanOut = ok.fanOut;
      const res = await save.mutateAsync({ id: automation.id, body });
      if (res.webhookSecret) save.reset();
      setLastSave(res);
      const next = valuesOf(res.automation);
      setBaseVersion(res.automation.version);
      setInitial(next);
      setValues(next);
      toast.success(`Saved “${res.automation.name}”.`);
    } catch (err) {
      if (isApiError(err, 409) && err.code === "version") {
        setConflict(true);
        return;
      }
      if (
        isApiError(err, 400) &&
        err.code === "bad_request" &&
        (err.details as { max?: number } | null)?.max
      ) {
        setErrors({ maxRunsPerDay: `Use a whole number from 1 to ${(err.details as { max: number }).max}` });
        return;
      }
      setFormError(automationErrorText(err, errorCtx()));
    }
  }

  async function reload() {
    const fresh = await detail.refetch();
    if (fresh.data) {
      const start = valuesOf(fresh.data);
      setBaseVersion(fresh.data.version);
      setInitial(start);
      setValues(start);
    }
    setConflict(false);
    setFormError(null);
    setErrors({});
  }

  // Pause and Resume bump the version: the form's base follows when it was loaded from the version they changed.
  const doPause = (a: Automation) =>
    pause.mutate(a.id, {
      onSuccess: (r) => {
        setBaseVersion((v) => baseVersionAfter(v, a.version, r.version));
        toast(`Paused “${a.name}”.`);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  const doResume = (a: Automation) =>
    resume.mutate(a.id, {
      onSuccess: (r) => {
        setBaseVersion((v) => baseVersionAfter(v, a.version, r.version));
        toast(resumedText(r));
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  const doRun = (a: Automation) =>
    runNow.mutate(a.id, {
      onSuccess: () =>
        toast(`Running “${a.name}” now.`, {
          action: { label: "Open runs", onClick: () => onOpenRuns(a.id) },
        }),
      onError: (err) => toast.error(errorMessage(err)),
    });

  const title =
    mode === "new"
      ? "New automation"
      : automation
        ? mode === "edit"
          ? `Edit “${automation.name}”`
          : `“${automation.name}”`
        : "Automation";
  const notFound = !!id && detail.isError;
  // A proposal that is no longer pending (decided, expired, not the viewer's) has nothing to edit.
  const draftGone = draft?.state === "gone" && savedDraft.current !== draftId ? draft : null;
  const loading = (!!id && detail.isPending) || draft?.state === "loading";
  const noBots = mode === "new" && options.isSuccess && bots.length === 0;
  const id_ = (k: string) => `automation-editor-${k}`;
  const instructionsLength = values.instructions.length;
  const ownerName = automation?.runAs.displayName ?? me?.name ?? "";
  const dailyLimit = values.agentId ? options.data?.botDailyLimit[values.agentId] : undefined;
  const runsRaw = values.maxRunsPerDay.trim();
  const expectedTurns =
    /^\d+$/.test(runsRaw) && Number(runsRaw) >= 1
      ? expectedTurnsPerDay({
          schedule: values.triggerKind === "schedule" ? values.schedule : null,
          maxRunsPerDay: Number(runsRaw),
          fanOutPerDay: fanOutPerDayOf(fanOutOn, values.fanOut),
        })
      : null;
  const showTabs = !!id && !!automation;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && requestClose()}>
        <SheetContent
          side="right"
          showClose={false}
          className="w-full max-w-full sm:w-[40rem] sm:max-w-[92vw]"
          data-testid="automation-editor"
          data-mode={mode}
        >
          <div className="grid gap-3 border-b px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate" data-testid="automation-editor-title">
                  {title}
                </SheetTitle>
                <SheetDescription className="mt-0.5">
                  A standing order a bot carries out on a schedule or when something arrives.
                </SheetDescription>
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
            {showTabs ? (
              <Tabs value={tab} onValueChange={(v) => onTab(v === "runs" ? "runs" : "settings")}>
                <TabsList aria-label="Automation" className="max-md:h-auto max-md:w-full">
                  <TabsTrigger
                    value="settings"
                    className="max-md:h-11 max-md:flex-1"
                    data-testid="automation-tab-settings"
                  >
                    Settings
                  </TabsTrigger>
                  <TabsTrigger
                    value="runs"
                    className="max-md:h-11 max-md:flex-1"
                    data-testid="automation-tab-runs"
                  >
                    Runs
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>

          {automation && automation.status !== "active" ? (
            <StatusBanner
              automation={automation}
              own={own}
              busy={resume.isPending}
              onResume={() => doResume(automation)}
            />
          ) : null}

          {/* Read-only, every control is disabled: the body itself takes the keyboard so it still scrolls (axe). */}
          <div
            className="scrollbar-thin grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-5 py-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
            {...(readonly ? { tabIndex: 0, role: "region", "aria-label": "Automation settings" } : {})}
          >
            {notFound ? (
              <EmptyState
                icon={Zap}
                title="This automation doesn't exist or you can't open it"
                description="It may have been deleted."
                className="py-10"
              >
                <Button variant="outline" className={TOUCH} onClick={onClose}>
                  Back to automations
                </Button>
              </EmptyState>
            ) : draftGone ? (
              <DraftGone automationId={draftGone.automationId} onClose={onClose} />
            ) : loading ? (
              <EditorSkeleton />
            ) : tab === "runs" && automation ? (
              <RunHistory automation={automation} highlight={runId} />
            ) : (
              <>
                {draftView && mode === "new" ? (
                  <DraftBanner bot={draftView.botName} conversation={draftView.conversationName} />
                ) : null}
                {conflict ? (
                  <div
                    role="alert"
                    data-testid="automation-conflict"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
                  >
                    <span>This automation changed while you were editing.</span>
                    <Button size="sm" variant="outline" className={TOUCH} onClick={() => void reload()}>
                      Reload
                    </Button>
                  </div>
                ) : null}
                {formError ? (
                  <p
                    role="alert"
                    data-testid="automation-form-error"
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
                  >
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0">{formError}</span>
                  </p>
                ) : null}
                {noBots ? (
                  <div
                    role="note"
                    className="grid justify-items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300"
                  >
                    <span>You have no bot that can run automations.</span>
                    <Link
                      href="/bots"
                      className={cn(buttonVariants({ size: "sm", variant: "outline" }), TOUCH)}
                    >
                      Create a personal bot
                    </Link>
                  </div>
                ) : null}

                <SheetSection title="Basics">
                  <div className="grid gap-4">
                    <FormField id={id_("name")} label="Name" error={errors.name}>
                      <Input
                        id={id_("name")}
                        data-testid="automation-name-input"
                        placeholder="e.g. Weekly sales report"
                        value={values.name}
                        maxLength={AUTOMATION_LIMITS.nameMax + 20}
                        disabled={readonly}
                        onChange={(e) => set({ name: e.target.value })}
                        aria-invalid={!!errors.name}
                        aria-describedby={describedBy(id_("name"), errors.name)}
                        className={TOUCH}
                      />
                    </FormField>
                    <FormField id={id_("bot")} label="Bot" error={errors.agent}>
                      <Select
                        items={bots.map((b) => ({ value: b.id, label: botLabel(b) }))}
                        value={bots.some((b) => b.id === values.agentId) ? values.agentId : null}
                        onValueChange={(v) => v && pickBot(String(v))}
                        disabled={readonly || options.isPending}
                      >
                        <SelectTrigger
                          id={id_("bot")}
                          data-testid="automation-bot"
                          placeholder={readonly && automation ? automation.agent.displayName : "Pick a bot"}
                          aria-invalid={!!errors.agent}
                          aria-describedby={describedBy(id_("bot"), errors.agent)}
                          className={TOUCH}
                        />
                        <SelectContent>
                          {bots.map((b) => (
                            <SelectItem
                              key={b.id}
                              value={b.id}
                              disabled={!b.ready}
                              data-testid="automation-bot-option"
                              className="max-md:min-h-11"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <BotAvatar
                                  name={b.displayName}
                                  avatar={agents?.find((x) => x.id === b.id)?.avatarUrl ?? null}
                                  seed={b.id}
                                  size="sm"
                                  className="size-5 rounded-md text-[9px]"
                                />
                                <span className="truncate">{botLabel(b)}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField
                      id={id_("instructions")}
                      label="Instructions"
                      error={errors.instructions}
                      hint={
                        <span className="flex justify-between gap-3">
                          <span>{botName} follows these each time it runs.</span>
                          {instructionsLength >= COUNTER_FROM ? (
                            <span className="tabular-nums">
                              {instructionsLength} / {AUTOMATION_LIMITS.instructionsMax}
                            </span>
                          ) : null}
                        </span>
                      }
                    >
                      <Textarea
                        id={id_("instructions")}
                        data-testid="automation-instructions"
                        rows={6}
                        placeholder="What should the bot do each time?"
                        value={values.instructions}
                        disabled={readonly}
                        onChange={(e) => set({ instructions: e.target.value })}
                        aria-invalid={!!errors.instructions}
                        aria-describedby={describedBy(id_("instructions"), errors.instructions, "hint")}
                        className="max-h-[22rem] min-h-36 field-sizing-content"
                      />
                    </FormField>
                  </div>
                </SheetSection>

                <SheetSection title="When">
                  <TriggerStep
                    form={{
                      triggerKind: values.triggerKind,
                      schedule: values.schedule,
                      setTriggerKind: (triggerKind) => set({ triggerKind }),
                      setSchedule: (schedule) => {
                        // Picking an interval pre-fills runs a day (PD-04); loading or other edits never do.
                        const runs = runsPerDayPrefill(values.schedule, schedule, maxRuns);
                        set(runs === null ? { schedule } : { schedule, maxRunsPerDay: String(runs) });
                      },
                      scheduleErrors: errors.schedule ?? {},
                      preview,
                      disabled: readonly,
                      minMinutes: caps?.minScheduleMinutes,
                      automation: automation ?? lastSave?.automation ?? null,
                      inbound: values.inbound,
                      setInbound: (inbound) => set({ inbound }),
                      inboundErrors: errors.inbound ?? {},
                      mailbox: values.mailbox,
                      setMailbox: (mailbox) => set({ mailbox }),
                      mailboxErrors: errors.mailbox ?? {},
                      targetKind: values.target.kind,
                      botName,
                      dropSecret: () => setLastSave((s) => (s ? { automation: s.automation } : s)),
                    }}
                    canWebhook={options.data?.canWebhook ?? false}
                    lastSave={lastSave}
                    mode={mode}
                  />
                </SheetSection>

                <SheetSection title="Deliver to">
                  <TargetPicker
                    agent={bot ? { id: bot.id, displayName: bot.displayName, personal: bot.personal } : null}
                    value={values.target}
                    onChange={(target) => set({ target })}
                    errors={errors.target ?? {}}
                    disabled={readonly}
                  />
                </SheetSection>

                {fanOutOn && (values.target.kind === "channel" || values.target.kind === "board") ? (
                  <SheetSection title="For each new item">
                    <FanOutSection
                      value={values.fanOut}
                      onChange={(fanOut) => set({ fanOut })}
                      targetKind={values.target.kind}
                      conversationName={names.conversation}
                      columnName={names.column}
                      automationName={values.name}
                      errors={errors.fanOut ?? {}}
                      disabled={readonly}
                    />
                  </SheetSection>
                ) : null}

                <SheetSection title="Runs as">
                  <div className="grid gap-1.5" data-testid="automation-run-as">
                    <p className="flex items-center gap-2 text-sm">
                      <PrincipalAvatar kind="user" name={ownerName || "You"} className="size-6" />
                      <span className="font-medium">
                        {ownerName}
                        {mode === "readonly" && !own ? "" : " (you)"}
                      </span>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {mode === "readonly" && !own && automation
                        ? `Runs as ${automation.runAs.displayName}. Admins can pause or delete it, not run it as someone else.`
                        : `${botName} acts with your permissions. Its usage counts against your limits. Nobody else can run it as you.`}
                    </p>
                  </div>
                </SheetSection>

                <SheetSection title="Limits">
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <label htmlFor={id_("runs")} className="font-medium text-sm">
                        Runs per day
                      </label>
                      <Input
                        id={id_("runs")}
                        data-testid="automation-runs-per-day"
                        inputMode="numeric"
                        value={values.maxRunsPerDay}
                        disabled={readonly}
                        onChange={(e) => set({ maxRunsPerDay: e.target.value })}
                        aria-invalid={!!errors.maxRunsPerDay}
                        aria-describedby={
                          errors.maxRunsPerDay ? `${id_("runs")}-error` : `${id_("runs")}-hint`
                        }
                        className={cn("w-24 text-right", TOUCH)}
                      />
                      <span id={`${id_("runs")}-hint`} className="text-muted-foreground text-xs">
                        Up to {maxRuns} in this workspace.
                      </span>
                    </div>
                    {errors.maxRunsPerDay ? (
                      <p id={`${id_("runs")}-error`} role="alert" className="text-[13px] text-destructive">
                        {errors.maxRunsPerDay}
                      </p>
                    ) : null}
                    <DailyLimitWarning botName={botName} dailyLimit={dailyLimit} expected={expectedTurns} />
                    <ul className="grid gap-1 text-muted-foreground text-xs" data-testid="automation-limits">
                      {dailyLimit !== undefined ? (
                        <li>
                          {dailyLimit === null
                            ? `${botName} has no daily limit.`
                            : `${botName} answers up to ${dailyLimit} times a day in total; runs count toward it.`}
                        </li>
                      ) : null}
                      <li>Pauses itself after 3 failed runs in a row.</li>
                      {caps ? (
                        <li>
                          Workspace limits: at most every {caps.minScheduleMinutes} minutes ·{" "}
                          {caps.maxAutomationsPerUser} automations each · {caps.maxInboundPerHour} incoming
                          items an hour.
                        </li>
                      ) : null}
                    </ul>
                  </div>
                </SheetSection>
              </>
            )}
          </div>

          {notFound || draftGone || loading ? null : (
            <Footer
              mode={mode}
              tab={tab}
              automation={automation}
              own={own}
              dirty={dirty}
              pending={save.isPending}
              runPending={runNow.isPending}
              disabled={noBots}
              onCancel={requestClose}
              onSubmit={() => void submit()}
              onRun={() => automation && doRun(automation)}
              onPause={() => automation && doPause(automation)}
              onResume={() => automation && doResume(automation)}
              onDelete={() => setDeleting(true)}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={confirmDiscard} onOpenChange={(o) => !o && setConfirmDiscard(false)}>
        <DialogContent initialFocus={keepRef} data-testid="automation-discard">
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>Your edits to this automation are not saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={keepRef}
              variant="outline"
              onClick={() => setConfirmDiscard(false)}
              className={TOUCH}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className={TOUCH}
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

      <DeleteAutomationDialog
        automation={deleting ? automation : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          loadedFor.current = null;
          onClose();
        }}
      />
    </>
  );
}

function botLabel(b: AutomationOptions["bots"][number]): string {
  const where = b.personal ? " · your personal bot" : b.unitName ? ` · ${b.unitName}` : "";
  return `${b.displayName}${where}${b.ready ? "" : " · not ready"}`;
}

function EditorSkeleton() {
  return (
    <div className="grid gap-5" aria-busy="true" role="status" aria-label="Loading automation">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="grid gap-2">
          <Skeleton className="h-3.5 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-9 w-full motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

/** `?draft=` (UI-SPEC § Copy › Editor banners, R5): whose proposal this is, and that saving closes it. */
/**
 * Under runs a day (07.17, D-11, PD-19): when the turns this automation can use a day exceed the bot's daily limit, a
 * non-blocking amber note says so before saving. Saving stays possible; the limit still stops runs server-side.
 */
export function DailyLimitWarning({
  botName,
  dailyLimit,
  expected,
}: {
  botName: string;
  dailyLimit: number | null | undefined;
  expected: number | null;
}) {
  if (dailyLimit === null || dailyLimit === undefined || expected === null || expected <= dailyLimit)
    return null;
  return (
    <p
      role="status"
      data-testid="automation-daily-limit-warning"
      className="flex w-full items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 leading-5 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        {botName} can take {dailyLimit} turns a day. This automation can use up to {expected}. Raise the bot's
        daily limit in its sheet, or runs stop when it is reached.
      </span>
    </p>
  );
}

export function DraftBanner({ bot, conversation }: { bot: string; conversation: string }) {
  return (
    <p
      data-testid="automation-draft-banner"
      className="flex items-start gap-2 rounded-lg bg-brand-soft px-3 py-2 text-brand-soft-foreground text-sm"
    >
      <Zap className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        {`From ${bot}'s proposal in ${conversation}. Saving creates it and closes the proposal.`}
      </span>
    </p>
  );
}

/**
 * `?draft=` of a proposal that is no longer pending (confirmed, discarded, expired, failed, or not the viewer's): nothing
 * to edit. Once confirmed, it opens what it created.
 */
export function DraftGone({ automationId, onClose }: { automationId: string | null; onClose: () => void }) {
  return (
    <EmptyState
      icon={Zap}
      title="This proposal is no longer open"
      description="It was confirmed, discarded or it expired."
      className="py-10"
    >
      <div className="flex flex-wrap justify-center gap-2" data-testid="automation-draft-gone">
        {automationId ? (
          <Link
            href={`/bots/automations?edit=${encodeURIComponent(automationId)}`}
            className={cn(buttonVariants({ variant: "outline" }), TOUCH)}
          >
            Open automation
          </Link>
        ) : null}
        <Button variant="outline" className={TOUCH} onClick={onClose}>
          Back to automations
        </Button>
      </div>
    </EmptyState>
  );
}

/**
 * Under the header when the automation is not active (UI-SPEC Surface 2): who paused it and when, or why it paused
 * itself (amber), with Resume for its owner only (a manager reads the sentence without the button: P-04).
 */
function StatusBanner({
  automation: a,
  own,
  busy,
  onResume,
}: {
  automation: Automation;
  own: boolean;
  busy: boolean;
  onResume: () => void;
}) {
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const attention = a.status === "needs_attention";
  const reason = a.lastRun?.reason
    ? runReasonSentence(a.lastRun.reason, {
        bot: a.agent.displayName,
        conversation: targetName(a, me),
        maxRunsPerDay: a.maxRunsPerDay,
      }).replace(/\.$/, "")
    : null;
  const text = attention
    ? `Paused after 3 failed runs.${reason ? ` Last reason: ${reason}.` : ""}`
    : a.pausedBy && a.pausedAt
      ? `Paused by ${a.pausedBy.displayName} on ${new Date(a.pausedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`
      : "Paused.";
  return (
    <div
      role="note"
      data-testid="automation-status-banner"
      data-status={a.status}
      className={cn(
        "mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
        attention
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        {attention ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0">{text}</span>
      </span>
      {own ? (
        <Button
          size="sm"
          variant="outline"
          className={TOUCH}
          disabled={busy}
          onClick={onResume}
          data-testid="automation-banner-resume"
        >
          {busy ? <Spinner /> : null}
          Resume
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The sticky footer per mode (UI-SPEC Surface 2): new `Cancel · Create automation`; own `Run now` (left) `Cancel ·
 * Save changes`; read-only (a manager on someone else's) `Pause` and `Delete…` only. Stacked full width at 390 with
 * the primary action first (Run now first in edit mode).
 */
function Footer({
  mode,
  tab,
  automation: a,
  own,
  dirty,
  pending,
  runPending,
  disabled,
  onCancel,
  onSubmit,
  onRun,
  onPause,
  onResume,
  onDelete,
}: {
  mode: Mode;
  tab: "settings" | "runs";
  automation: Automation | null;
  own: boolean;
  dirty: boolean;
  pending: boolean;
  runPending: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const can = (x: Automation["viewerCan"][number]) => !!a?.viewerCan.includes(x);
  const hasLeft = mode === "edit" && !!a && (can("run") || can("delete"));
  const wrap =
    "flex flex-col gap-2 border-t bg-muted/30 px-5 py-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:flex-row sm:items-center";
  if (mode === "readonly") {
    const active = a?.status === "active";
    if (!a || (!can("pause") && !can("delete") && !(own && !active))) return null;
    return (
      <div className={wrap} data-testid="automation-footer">
        {active && can("pause") ? (
          <Button variant="outline" className={TOUCH} onClick={onPause} data-testid="automation-pause">
            <Pause /> Pause
          </Button>
        ) : null}
        {!active && own ? (
          <Button variant="outline" className={TOUCH} onClick={onResume} data-testid="automation-resume">
            Resume
          </Button>
        ) : null}
        {can("delete") ? (
          <Button
            variant="ghost"
            className={cn(
              "text-destructive hover:bg-destructive/10 hover:text-destructive sm:ml-auto",
              TOUCH,
            )}
            onClick={onDelete}
            data-testid="automation-delete"
          >
            <Trash2 /> Delete…
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={wrap} data-testid="automation-footer">
      {mode === "edit" && a && can("run") ? (
        <Button
          variant="outline"
          className={cn("sm:mr-auto", TOUCH)}
          onClick={onRun}
          disabled={runPending}
          data-testid="automation-run-now"
        >
          {runPending ? <Spinner /> : <Play />}
          Run now
        </Button>
      ) : mode === "edit" && can("delete") ? (
        <Button
          variant="ghost"
          className={cn("text-destructive hover:bg-destructive/10 hover:text-destructive sm:mr-auto", TOUCH)}
          onClick={onDelete}
          data-testid="automation-delete"
        >
          <Trash2 /> Delete…
        </Button>
      ) : null}
      <Button
        variant="outline"
        className={cn("max-sm:order-last", !hasLeft && "sm:ml-auto", TOUCH)}
        onClick={onCancel}
      >
        Cancel
      </Button>
      {tab === "settings" ? (
        <Button
          className={TOUCH}
          onClick={onSubmit}
          disabled={pending || disabled || (mode === "edit" && !dirty)}
          data-testid="automation-submit"
        >
          {pending ? <Spinner /> : null}
          {mode === "new" ? "Create automation" : "Save changes"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Delete confirmation (UI-SPEC § Copy): the run history goes, posted messages stay; a webhook's URL stops working.
 * Focus starts on Cancel.
 */
export function DeleteAutomationDialog({
  automation: a,
  onClose,
  onDeleted,
}: {
  automation: Automation | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const del = useDeleteAutomation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState<Automation | null>(a);
  useEffect(() => {
    if (a) setShown(a);
  }, [a]);
  const target = a ?? shown;
  const body = useMemo(
    () =>
      `It stops running and its run history is deleted. Messages it already posted stay.${
        target?.trigger.kind === "webhook" ? " Its webhook URL stops working." : ""
      }`,
    [target],
  );
  return (
    <Dialog open={!!a} onOpenChange={(o) => !o && !del.isPending && onClose()}>
      <DialogContent initialFocus={cancelRef} data-testid="automation-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete “{target?.name}”?</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className={TOUCH}
            disabled={del.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={TOUCH}
            disabled={del.isPending}
            data-testid="automation-delete-confirm"
            onClick={() =>
              target &&
              del.mutate(target.id, {
                onSuccess: () => {
                  toast(`Deleted “${target.name}”.`);
                  onClose();
                  onDeleted?.();
                },
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            {del.isPending ? <Spinner /> : null}
            Delete automation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
