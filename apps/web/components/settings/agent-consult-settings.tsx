"use client";

import { useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAgentMessagingSettings, useUpdateAgentMessagingSettings } from "@/lib/agent-messaging-queries";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

export const CONSULT_TITLE = "Consulting other bots";
export const CONSULT_DESCRIPTION =
  "Let a bot ask another bot in the same channel for help. Every question and answer shows in the thread.";
export const SWITCH_LABEL = "Bots may consult each other";
export const SWITCH_HELPER =
  "Off by default. Up to 2 levels deep, 3 questions per request and 5 minutes per answer. Fine-tune each bot in its settings.";
export const READ_ONLY_NOTE = "Only admins can change this.";

/**
 * Settings › Bot policy › Consulting other bots (07.7-08; A2A-02, D-04, P-03): the organization switch, off by default.
 * On writes the one `everyone` allow rule on `agent.message`; each bot's own rules (its sheet) refine it, deny winning.
 * Shown with `rule.read` (admins in v1); the switch needs `canManage` from the API. The visibility check only hides
 * what the API already refuses.
 */
export function AgentConsultSettings() {
  const mayReadRules = useCan("rule.read");
  const q = useAgentMessagingSettings(mayReadRules);
  const update = useUpdateAgentMessagingSettings();
  const helperId = useId();
  if (!mayReadRules) return null;

  // While a change is pending the switch shows where it is going; on error it falls back to the server state.
  const enabled =
    update.isPending && update.variables ? update.variables.enabled : (q.data?.enabled ?? false);
  const readOnly = q.data ? !q.data.canManage : true;

  function change(next: boolean) {
    update.mutate(
      { enabled: next },
      {
        onSuccess: (s) =>
          toast.success(
            s.enabled ? "Bots can now consult each other" : "Bots can no longer consult each other",
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  return (
    <section
      className="grid gap-3"
      data-testid="agent-consult-settings"
      aria-labelledby={`${helperId}-title`}
    >
      <div>
        <h2 id={`${helperId}-title`} className="font-semibold text-[15px] tracking-tight">
          {CONSULT_TITLE}
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">{CONSULT_DESCRIPTION}</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-[74px] rounded-lg" />
      ) : q.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4 text-sm">
          <span className="text-muted-foreground">Couldn't load consult settings.</span>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()} className="max-md:h-11">
            Try again
          </Button>
        </div>
      ) : (
        // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
        <label
          className={cn(
            "flex min-h-11 cursor-pointer items-start justify-between gap-4 rounded-lg border bg-card p-4",
            (readOnly || update.isPending) && "cursor-not-allowed",
          )}
          data-enabled={enabled ? "on" : "off"}
          data-testid="agent-consult-row"
        >
          <span className="min-w-0 flex-1">
            <span id={`${helperId}-label`} className="block font-medium text-sm">
              {SWITCH_LABEL}
            </span>
            <span id={helperId} className="mt-0.5 block max-w-prose text-[13px] text-muted-foreground">
              {SWITCH_HELPER}
              {readOnly ? ` ${READ_ONLY_NOTE}` : null}
            </span>
          </span>
          <span className="flex h-5 shrink-0 items-center gap-2">
            {update.isPending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
            <Switch
              checked={enabled}
              disabled={readOnly || update.isPending}
              onCheckedChange={change}
              // The label text alone names it (the wrapping <label> is the 44 px hit area; it also holds the helper).
              aria-labelledby={`${helperId}-label`}
              aria-describedby={helperId}
              data-testid="agent-consult-switch"
            />
          </span>
        </label>
      )}
    </section>
  );
}
