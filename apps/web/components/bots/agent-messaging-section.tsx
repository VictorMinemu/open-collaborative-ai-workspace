"use client";

import type {
  Agent,
  AgentMessagingOutboundMode,
  AgentMessagingView,
  AgentRef,
  SetAgentMessagingRequest,
} from "@ocw/contracts";
import { Waypoints, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAgentMessaging, useSetAgentMessaging } from "@/lib/agent-messaging-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useAgents } from "@/lib/bots-queries";
import { cn } from "@/lib/utils";

/**
 * A team bot's consult rules in its sheet (07.7-08; A2A-02, D-02, D-04, P-04): who it can ask (the organization
 * default, any bot, only listed bots, no bot), whom it must never ask, and whether other bots can ask it. Every change
 * sends the full desired state in one PUT; the "Right now" line is the API's own decision (`effective`), never
 * computed here, and is the confirmation (no success toast). "Only these bots" is disabled while the organization
 * switch is on: rules are deny-wins, so a list cannot narrow an everyone-allow (P-04). Only bots of the organization
 * (team and unit bots) are offered; the API re-checks every id (`invalid_agent_messaging`).
 */

export const ONLY_REASON =
  "Every bot may ask any bot in this organization, so a list can't narrow it. Use “Never ask” instead.";
const INVALID_TARGET = "One of those bots can't be used here. Pick another one.";

/** "@a", "@a and @b", "@a, @b and 3 more" (the first two named). */
function namedTargets(targets: readonly AgentRef[]): string {
  const [a, b] = targets.map((t) => `@${t.handle}`);
  if (targets.length <= 1) return a ?? "";
  if (targets.length === 2) return `${a} and ${b}`;
  return `${a}, ${b} and ${targets.length - 2} more`;
}

/** The "Right now" sentence for what the API computed. */
export function effectiveSentence(view: AgentMessagingView, botName: string): string {
  const { kind, targets } = view.effective;
  if (kind === "any") return `${botName} can ask any bot.`;
  if (kind === "none" || targets.length === 0) return `${botName} can't ask other bots.`;
  return `${botName} can ask ${namedTargets(targets)}.`;
}

export interface ModeOption {
  value: AgentMessagingOutboundMode;
  label: string;
  disabled: boolean;
  reason?: string;
}

/** The four "Can ask" options; "Only these bots" is unavailable while the organization switch is on. */
export function modeOptions(view: AgentMessagingView): ModeOption[] {
  const onlyBlocked = view.orgDefault;
  return [
    {
      value: "default",
      label: `Organization default (${view.orgDefault ? "On" : "Off"})`,
      disabled: false,
    },
    { value: "any", label: "Any bot", disabled: false },
    {
      value: "only",
      label: "Only these bots",
      disabled: onlyBlocked,
      ...(onlyBlocked ? { reason: ONLY_REASON } : {}),
    },
    { value: "none", label: "No bot", disabled: false },
  ];
}

const ids = (refs: readonly AgentRef[]) => refs.map((r) => r.id);

export function AgentMessagingSection({ agent }: { agent: Agent }) {
  const q = useAgentMessaging(agent.id);

  if (q.isPending) {
    return (
      <div className="grid gap-2" aria-busy data-testid="agent-messaging-section">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 rounded-md" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3 text-sm"
        data-testid="agent-messaging-section"
      >
        <span className="text-muted-foreground" data-testid="agent-messaging-error">
          Couldn't load consult settings.
        </span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} className="max-md:h-11">
          Try again
        </Button>
      </div>
    );
  }
  return <Rules agent={agent} view={q.data} />;
}

function Rules({ agent, view }: { agent: Agent; view: AgentMessagingView }) {
  const set = useSetAgentMessaging(agent.id);
  const agents = useAgents();
  const id = useId();
  // "Only these bots" picked but no bot added yet: the API needs at least one, so nothing is saved until then.
  const [draftOnly, setDraftOnly] = useState(false);
  const readOnly = !view.canManage;
  const busy = readOnly || set.isPending;
  const mode: AgentMessagingOutboundMode = draftOnly ? "only" : view.outbound.mode;
  const options = modeOptions(view);
  const onlyReason = options.find((o) => o.value === "only")?.reason;
  const reasonId = `${id}-only-reason`;
  const allowIds = ids(view.outbound.allow);
  const denyIds = ids(view.outbound.deny);
  const listed = new Set([...allowIds, ...denyIds]);
  // Team and unit bots of the organization other than this one and not already listed (personal bots are out of v1).
  const candidates = (agents.data?.agents ?? [])
    .filter((a) => a.scope === "team" && a.id !== agent.id && !listed.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  function save(body: SetAgentMessagingRequest, after?: () => void) {
    set.mutate(body, {
      onSuccess: () => after?.(),
      onError: (err) =>
        toast.error(
          isApiError(err) && err.code === "invalid_agent_messaging" ? INVALID_TARGET : errorMessage(err),
        ),
    });
  }
  const outbound = (patch: Partial<SetAgentMessagingRequest["outbound"]>): SetAgentMessagingRequest => ({
    outbound: { mode: view.outbound.mode, allow: allowIds, deny: denyIds, ...patch },
    inbound: view.inbound,
  });

  function changeMode(next: AgentMessagingOutboundMode) {
    if (next === mode) return;
    if (next === "only") {
      setDraftOnly(true);
      return;
    }
    setDraftOnly(false);
    if (next === view.outbound.mode) return;
    save(outbound({ mode: next, allow: [], deny: next === "none" ? [] : denyIds }));
  }

  return (
    <div className="grid gap-4" data-testid="agent-messaging-section">
      <div
        className="grid gap-1 rounded-lg border bg-muted/30 p-3"
        aria-live="polite"
        data-testid="agent-messaging-effective"
      >
        <p className="flex items-start gap-2 text-sm">
          <Waypoints className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span data-testid="agent-messaging-effective-line">{effectiveSentence(view, agent.name)}</span>
        </p>
        <p className="pl-[22px] text-muted-foreground text-xs">
          People also need to see the bot being asked.
        </p>
      </div>

      <FormField id={`${id}-mode`} label="Can ask">
        <Select
          items={options.map((o) => ({ value: o.value, label: o.label }))}
          value={mode}
          onValueChange={(v) => v && changeMode(v as AgentMessagingOutboundMode)}
          disabled={busy}
        >
          <SelectTrigger
            id={`${id}-mode`}
            data-testid="agent-messaging-mode"
            aria-describedby={onlyReason ? reasonId : undefined}
            className="w-full sm:w-72 max-md:h-11"
          />
          <SelectContent>
            {options.map((o) => (
              <SelectItem
                key={o.value}
                value={o.value}
                disabled={o.disabled && mode !== o.value}
                data-testid={`agent-messaging-mode-${o.value}`}
                className="max-md:min-h-11"
              >
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {onlyReason ? (
          <p
            id={reasonId}
            className="text-[13px] text-muted-foreground"
            data-testid="agent-messaging-only-reason"
          >
            {onlyReason}
          </p>
        ) : null}
      </FormField>

      {mode === "only" ? (
        <BotList
          testId="agent-messaging-allow"
          addTestId="agent-messaging-add-allow"
          label="Only these bots"
          empty="Pick at least one bot."
          refs={view.outbound.allow}
          candidates={candidates}
          readOnly={readOnly}
          busy={busy}
          // The API needs at least one bot in mode "only": the last one leaves by changing "Can ask".
          lockLast
          onAdd={(botId) =>
            save(outbound({ mode: "only", allow: [...allowIds, botId] }), () => setDraftOnly(false))
          }
          onRemove={(botId) => save(outbound({ allow: allowIds.filter((x) => x !== botId) }))}
        />
      ) : null}

      {mode !== "none" ? (
        <BotList
          testId="agent-messaging-deny"
          addTestId="agent-messaging-add-deny"
          label="Never ask"
          helper="Always wins over the options above and the organization default."
          empty="Nobody excluded."
          refs={view.outbound.deny}
          candidates={candidates}
          readOnly={readOnly}
          busy={busy}
          onAdd={(botId) => save(outbound({ deny: [...denyIds, botId] }))}
          onRemove={(botId) => save(outbound({ deny: denyIds.filter((x) => x !== botId) }))}
        />
      ) : null}

      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
      <label
        className={cn(
          "flex min-h-11 cursor-pointer items-start justify-between gap-4 rounded-lg border bg-card p-3",
          busy && "cursor-not-allowed",
        )}
        data-testid="agent-messaging-inbound"
      >
        <span className="min-w-0 flex-1">
          <span id={`${id}-inbound`} className="block font-medium text-sm">
            Other bots can ask {agent.name}
          </span>
          <span id={`${id}-inbound-help`} className="mt-0.5 block text-muted-foreground text-xs">
            Turn off to keep {agent.name} out of every consult.
          </span>
        </span>
        <Switch
          checked={view.inbound.consultable}
          disabled={busy}
          onCheckedChange={(consultable) => save({ ...outbound({}), inbound: { consultable } })}
          aria-labelledby={`${id}-inbound`}
          aria-describedby={`${id}-inbound-help`}
          data-testid="agent-messaging-inbound-switch"
          className="mt-0.5"
        />
      </label>
    </div>
  );
}

function BotList({
  testId,
  addTestId,
  label,
  helper,
  empty,
  refs,
  candidates,
  readOnly,
  busy,
  lockLast = false,
  onAdd,
  onRemove,
}: {
  testId: string;
  addTestId: string;
  label: string;
  helper?: string;
  empty: string;
  refs: readonly AgentRef[];
  candidates: readonly Agent[];
  readOnly: boolean;
  busy: boolean;
  lockLast?: boolean;
  onAdd: (botId: string) => void;
  onRemove: (botId: string) => void;
}) {
  const id = useId();
  const items = candidates.map((a) => ({ value: a.id, label: `${a.name} · @${a.username}` }));
  return (
    <div className="grid gap-2" data-testid={testId}>
      <div>
        <p id={`${id}-label`} className="font-medium text-sm">
          {label}
        </p>
        {helper ? <p className="mt-0.5 text-[13px] text-muted-foreground">{helper}</p> : null}
      </div>
      {refs.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid={`${testId}-empty`}>
          {empty}
        </p>
      ) : null}
      <ul aria-label={label} className="flex flex-wrap gap-1.5 empty:hidden">
        {refs.map((r) => (
          <li key={r.id}>
            <Badge
              variant="outline"
              className="h-7 gap-0.5 py-0 pr-0.5 pl-2 font-mono text-foreground text-xs max-md:h-11 max-md:text-[13px]"
              data-testid={`${testId}-chip`}
              title={r.displayName}
            >
              @{r.handle}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove @${r.handle}`}
                disabled={busy || (lockLast && refs.length === 1)}
                onClick={() => onRemove(r.id)}
                className="size-6 text-muted-foreground max-md:size-11"
              >
                <X aria-hidden />
              </Button>
            </Badge>
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <Select
          items={items}
          value={null}
          onValueChange={(v) => {
            if (typeof v === "string" && v) onAdd(v);
          }}
          disabled={busy || items.length === 0}
        >
          <SelectTrigger
            placeholder="Add a bot…"
            aria-label={`Add a bot to ${label}`}
            data-testid={addTestId}
            className="w-full sm:w-72 max-md:h-11"
          />
          <SelectContent>
            {items.map((it) => (
              <SelectItem key={it.value} value={it.value} className="max-md:min-h-11">
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
