"use client";

import type {
  BotCapabilityView,
  CapabilityDenialReason,
  ConfinedCapabilityState,
  ReplyMode,
} from "@ocw/contracts";
import {
  Clock,
  Container,
  Gauge,
  Globe,
  Lock,
  type LucideIcon,
  Megaphone,
  MonitorPlay,
  NotebookPen,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useBotCapabilities, useUpdateBotCapabilities } from "@/lib/capability-queries";
import { cn } from "@/lib/utils";
import { reasonText } from "./capability-reason";
import { ToolsSection } from "./tools-section";
import { UsageMeter } from "./usage-meter";

type Toggle = "internet" | "memory" | "dateTime";

const TOGGLES: Array<{ name: Toggle; label: string; description: string; icon: LucideIcon }> = [
  {
    name: "internet",
    label: "Internet",
    description: "Search the web and read pages, read‑only",
    icon: Globe,
  },
  {
    name: "memory",
    label: "Memory",
    description: "Remembers what you tell it in your private chat",
    icon: NotebookPen,
  },
  { name: "dateTime", label: "Date & time", description: "Knows your local date and time", icon: Clock },
];

type Confined = "sandbox" | "browser";

/** The per-bot confined switches (07.8 D-12, UI-SPEC R11), after Date & time, with the Internet row's look. */
const CONFINED: Array<{ name: Confined; label: string; description: string; icon: LucideIcon }> = [
  {
    name: "sandbox",
    label: "Sandbox",
    description: "Keeps files and runs commands in its own sandbox",
    icon: Container,
  },
  { name: "browser", label: "Browser", description: "Opens web pages in a real browser", icon: MonitorPlay },
];

/** Why a confined switch can't be used (the API's `confined.*.reason`; `module_off` hides the row instead). */
const CONFINED_REASON: Record<
  Exclude<NonNullable<ConfinedCapabilityState["reason"]>, "module_off">,
  string
> = {
  org_off: "Turned off by your organization",
  killed: "An admin stopped all sandboxes",
  service_down: "The sandbox service isn't reachable",
};

/**
 * How long a switch that was just turned on reads "Applying": the bot's runtime picks the change up from its next
 * configuration refresh, about a second or two later, so a message sent at once may not get the tool yet (WINDOWS #248).
 */
export const APPLYING_MS = 6000;

const REPLY_MODES: Array<{ value: ReplyMode; label: string }> = [
  { value: "mentions", label: "Only when mentioned" },
  { value: "all", label: "Every message in its channels" },
];

/**
 * A bot's capabilities (D-06, D-11, D-16; BOT-04/05/07/10): internet, memory, date & time, the per-bot Sandbox and
 * Browser switches (07.8 D-12, R11: hidden while the module is off for the viewer, disabled with the API's reason while
 * the organization switch is off, the kill switch is on or the service is down), reply mode (team bots), the daily
 * limit, MCP and plugin tools (`ToolsSection`) and today's usage. Renders only the API's decision: a capability with a `reason` is disabled
 * and explained, never hidden; everything is read-only without `bot.configure` on this bot. `readOnly` forces it for
 * everyone, owners included (the agent page, 07.2-14: settings change only in the bot's sheet), and titles the tools
 * "Tools and skills". `headingLevel` is the tools title's level under the host's own headings (h4 in the bot sheet;
 * the agent page passes 2, under its h1).
 */
export function CapabilitiesPanel({
  agentId,
  className,
  readOnly: forceReadOnly = false,
  headingLevel,
}: {
  agentId: string;
  className?: string;
  readOnly?: boolean;
  headingLevel?: 2 | 3 | 4;
}) {
  const q = useBotCapabilities(agentId);
  const update = useUpdateBotCapabilities(agentId);
  const [applying, setApplying] = useState<Confined | null>(null);
  useEffect(() => {
    if (!applying) return;
    const timer = setTimeout(() => setApplying(null), APPLYING_MS);
    return () => clearTimeout(timer);
  }, [applying]);

  if (q.isPending) {
    return (
      <div className={cn("grid gap-2", className)} aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border border-dashed p-3 text-sm",
          className,
        )}
      >
        <span className="text-muted-foreground">Couldn't load capabilities. {errorMessage(q.error)}</span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const view = q.data;
  const readOnly = forceReadOnly || !view.viewerCan.includes("bot.configure");
  const save = (body: Parameters<typeof update.mutate>[0], success?: string) =>
    update.mutate(body, {
      onSuccess: () => {
        if (success) toast.success(success);
      },
      onError: (err) => toast.error("Could not update the bot", { description: errorMessage(err) }),
    });

  return (
    <div className={cn("grid gap-3", className)} data-testid="capabilities-panel">
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {TOGGLES.map((t) => {
          const eff = view.effective[t.name];
          const denied = eff.reason !== null;
          return (
            <Row
              key={t.name}
              icon={t.icon}
              label={t.label}
              description={t.description}
              reason={eff.reason}
              reasonFor={t.name}
              htmlFor={`cap-${agentId}-${t.name}`}
            >
              <Switch
                id={`cap-${agentId}-${t.name}`}
                checked={!denied && view.capabilities[t.name]}
                onCheckedChange={(v) => save({ [t.name]: v })}
                disabled={readOnly || denied}
                aria-label={t.label}
                data-testid={`capability-${t.name}`}
              />
            </Row>
          );
        })}

        {CONFINED.map((c) => {
          const state = view.confined?.[c.name];
          // Hidden while the module is off for the viewer (the Sandbox or Browser module), and on an older API.
          if (!state || state.reason === "module_off") return null;
          const why = state.reason ? CONFINED_REASON[state.reason] : null;
          return (
            <Row
              key={c.name}
              icon={c.icon}
              label={c.label}
              description={c.description}
              reasonLabel={why}
              reasonFor={c.name}
              htmlFor={`cap-${agentId}-${c.name}`}
              status={
                applying === c.name && state.enabled && !why ? (
                  <span
                    role="status"
                    data-testid={`capability-applying-${c.name}`}
                    className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs"
                  >
                    <Spinner className="size-3 motion-reduce:animate-none" />
                    Applying. Ready in a few seconds.
                  </span>
                ) : null
              }
            >
              <Switch
                id={`cap-${agentId}-${c.name}`}
                checked={state.available && state.enabled}
                onCheckedChange={(v) =>
                  update.mutate(
                    { [c.name]: v },
                    {
                      onSuccess: () => setApplying(v ? c.name : null),
                      onError: (err) =>
                        toast.error("Could not update the bot", { description: errorMessage(err) }),
                    },
                  )
                }
                disabled={readOnly || !state.available}
                aria-label={c.label}
                data-testid={`capability-${c.name}`}
              />
            </Row>
          );
        })}

        {view.scope === "team" ? (
          <ReplyModeRow view={view} readOnly={readOnly} onChange={(replyMode) => save({ replyMode })} />
        ) : null}

        <DailyLimitRow
          // Remount on a saved change so the draft follows the server value.
          key={view.capabilities.dailyLimit}
          view={view}
          readOnly={readOnly}
          onSave={(dailyLimit) => save({ dailyLimit }, `Daily limit set to ${dailyLimit}`)}
        />
      </div>

      <ToolsSection
        view={view}
        readOnly={forceReadOnly}
        title={forceReadOnly ? "Tools and skills" : "Tools"}
        headingLevel={headingLevel}
      />

      <div className="rounded-lg border bg-muted/30 p-3">
        <UsageMeter usage={view.usage} />
      </div>

      {forceReadOnly ? null : (
        <p className="text-muted-foreground text-xs">
          {readOnly
            ? "Only people who manage this bot can change its capabilities."
            : "Changes apply from the bot's next reply."}
        </p>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  description,
  reason,
  reasonLabel,
  reasonFor,
  htmlFor,
  status,
  children,
}: {
  icon: LucideIcon;
  label: string;
  description: ReactNode;
  reason?: CapabilityDenialReason | null;
  /** A reason sentence of its own (the confined switches), instead of `reason`. */
  reasonLabel?: string | null;
  reasonFor?: string;
  htmlFor?: string;
  /** A transient line under the description (a confined switch still applying). */
  status?: ReactNode;
  children: ReactNode;
}) {
  const why = reasonLabel ?? (reason ? reasonText(reason) : null);
  return (
    <div className="flex items-start gap-3 p-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
          why && "opacity-60",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block font-medium text-sm">
          {label}
        </label>
        <span className="block text-muted-foreground text-xs leading-snug">{description}</span>
        {why ? (
          <span
            className="mt-1.5 inline-flex max-w-full items-start gap-1.5 rounded-md bg-warning/12 px-2 py-1 text-foreground/85 text-xs leading-snug"
            data-testid={`capability-reason-${reasonFor}`}
          >
            <Lock className="mt-px size-3 shrink-0 text-warning" aria-hidden />
            <span>{why}</span>
          </span>
        ) : null}
        {status}
      </div>
      <div className="flex shrink-0 items-center self-center">{children}</div>
    </div>
  );
}

function ReplyModeRow({
  view,
  readOnly,
  onChange,
}: {
  view: BotCapabilityView;
  readOnly: boolean;
  onChange: (mode: ReplyMode) => void;
}) {
  const reason = view.effective.replyModeAll.reason;
  const id = useId();
  return (
    <div className="grid gap-2.5 p-3 sm:flex sm:items-start sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <Megaphone className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block font-medium text-sm">
            Reply mode
          </label>
          <span className="block text-muted-foreground text-xs leading-snug">
            When it answers in the channels it belongs to
          </span>
          {reason ? (
            <span
              className="mt-1.5 inline-flex max-w-full items-start gap-1.5 rounded-md bg-warning/12 px-2 py-1 text-foreground/85 text-xs leading-snug"
              data-testid="capability-reason-replyMode"
            >
              <Lock className="mt-px size-3 shrink-0 text-warning" aria-hidden />
              <span>Every-message replies: {reasonText(reason).toLowerCase()}</span>
            </span>
          ) : null}
        </div>
      </div>
      <Select
        items={REPLY_MODES}
        value={view.capabilities.replyMode}
        onValueChange={(v) => v && v !== view.capabilities.replyMode && onChange(v as ReplyMode)}
        disabled={readOnly}
      >
        <SelectTrigger
          id={id}
          data-testid="capability-replyMode"
          aria-label="Reply mode"
          className="w-full sm:w-56 sm:self-center"
        />
        <SelectContent>
          {REPLY_MODES.map((m) => (
            <SelectItem
              key={m.value}
              value={m.value}
              disabled={m.value === "all" && reason !== null && view.capabilities.replyMode !== "all"}
            >
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DailyLimitRow({
  view,
  readOnly,
  onSave,
}: {
  view: BotCapabilityView;
  readOnly: boolean;
  onSave: (limit: number) => void;
}) {
  const id = useId();
  const current = view.capabilities.dailyLimit;
  const max = view.dailyLimitMax;
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      setError(`Enter a whole number from 1 to ${max.toLocaleString()}`);
      return;
    }
    setError(null);
    if (n !== current) onSave(n);
  }

  return (
    <div className="flex items-start gap-3 p-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
      >
        <Gauge className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block font-medium text-sm">
          Daily limit
        </label>
        <span className="block text-muted-foreground text-xs leading-snug" id={`${id}-hint`}>
          {view.scope === "personal"
            ? `Replies a day, up to ${max.toLocaleString()} (your organization's maximum)`
            : "Replies a day across every chat"}
        </span>
        {error ? (
          <span className="mt-1 block text-destructive text-xs" id={`${id}-error`} role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={draft}
        disabled={readOnly}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        data-testid="capability-dailyLimit"
        className="h-8 w-20 shrink-0 self-center text-right tabular-nums"
      />
    </div>
  );
}
