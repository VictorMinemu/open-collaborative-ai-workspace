"use client";

import type { AiUsageReport, AiUsageToday } from "@ocw/contracts";
import type { ReactNode } from "react";
import { BackendTag } from "@/components/ai-chat/admin/ai-usage-report";
import { MeteredBadge } from "@/components/bots/provider-bits";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCostMicros,
  formatResetTime,
  formatTokens,
  usageCostEstimated,
  usageRowKindText,
} from "@/lib/ai-format";
import { useAiUsageToday, useMyAiUsageReport } from "@/lib/ai-usage-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Settings › AI chat › Usage (05-09, AICHAT-07, D-06): the member's own usage. "Today" against the organization's
 * daily limits (organization models: answers, and spend when capped; their ChatGPT plan: answers, counted against
 * the plan and never billed to the organization), then the last 30 days by model. Only the caller's own records
 * (`/me/ai-usage/today`, `/me/ai-usage/report`); counts and money only, never message text.
 */
export function UsageCard() {
  const today = useAiUsageToday();
  const report = useMyAiUsageReport(30);
  return (
    <section className="grid gap-3" aria-labelledby="ai-usage-heading" data-testid="usage-card">
      <div>
        <h2 id="ai-usage-heading" className="font-semibold text-[15px] tracking-tight">
          Usage
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Your own AI chat answers. Only you and your organization's admins can see this.
        </p>
      </div>
      <Panel
        title="Today"
        detail={today.data ? `Resets at ${formatResetTime(today.data.resetsAt)}` : undefined}
      >
        {today.isPending ? (
          <Skeleton className="m-4 h-24 rounded-xl" />
        ) : today.isError ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">{errorMessage(today.error)}</p>
        ) : (
          <Today today={today.data} />
        )}
      </Panel>
      <Panel title="Last 30 days" detail="By model">
        {report.isPending ? (
          <Skeleton className="m-4 h-20 rounded-xl" />
        ) : report.isError ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">{errorMessage(report.error)}</p>
        ) : (
          <LastDays report={report.data} />
        )}
      </Panel>
    </section>
  );
}

function Panel({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="flex items-baseline justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
        <h3 className="font-medium text-[13px]">{title}</h3>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  );
}

const answers = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "answer" : "answers"}`;

/** "3 of 200 answers" against a cap, "3 answers" without one. */
const againstCap = (used: number, max: number | null) =>
  max === null ? answers(used) : `${used.toLocaleString("en-US")} of ${answers(max)}`;

function Today({ today }: { today: AiUsageToday }) {
  const org = today.orgKey;
  const plan = today.chatgptPlan;
  const l = today.limits;
  return (
    <>
      <div className="grid gap-2 px-4 py-3.5" data-testid="usage-today-org">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 font-medium text-sm">
            Organization models
            <MeteredBadge />
          </span>
          <span className="font-medium text-sm tabular-nums" data-testid="usage-today-org-answers">
            {againstCap(org.generations, l.orgKeyGenerations)}
          </span>
        </div>
        {l.orgKeyGenerations !== null ? (
          <Meter used={org.generations} max={l.orgKeyGenerations} label="Organization model answers today" />
        ) : null}
        <p className="text-muted-foreground text-xs tabular-nums" data-testid="usage-today-org-detail">
          {formatTokens(org.inputTokens)} in · {formatTokens(org.outputTokens)} out ·{" "}
          {l.orgKeyCostMicros === null
            ? `${formatCostMicros(org.costMicrosUsd, false)} billed to your organization`
            : `${formatCostMicros(org.costMicrosUsd, false)} of ${formatCostMicros(l.orgKeyCostMicros, false)} a day`}
        </p>
        {l.orgKeyCostMicros !== null ? (
          <Meter used={org.costMicrosUsd} max={l.orgKeyCostMicros} label="Organization model spend today" />
        ) : null}
      </div>
      <div className="grid gap-2 px-4 py-3.5" data-testid="usage-today-plan">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-medium text-sm">ChatGPT plan</span>
          <span className="font-medium text-sm tabular-nums" data-testid="usage-today-plan-answers">
            {againstCap(plan.generations, l.planGenerations)}
          </span>
        </div>
        {l.planGenerations !== null ? (
          <Meter used={plan.generations} max={l.planGenerations} label="ChatGPT plan answers today" />
        ) : null}
        <p className="text-muted-foreground text-xs leading-snug tabular-nums">
          {formatTokens(plan.inputTokens)} in · {formatTokens(plan.outputTokens)} out · Counted against your
          plan, not billed to your organization
        </p>
      </div>
    </>
  );
}

/** A thin bar of usage against a daily limit; the destructive tone (with the "Limit reached" text) only at the cap. */
function Meter({ used, max, label }: { used: number; max: number; label: string }) {
  const full = used >= max;
  const ratio = max > 0 ? Math.min(1, used / max) : 1;
  return (
    <div className="grid gap-1">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(used, max)}
      >
        <div
          className={cn("h-full rounded-full", full ? "bg-destructive" : "bg-primary/70")}
          style={{ width: `${Math.max(ratio * 100, used > 0 ? 3 : 0)}%` }}
        />
      </div>
      {full ? <span className="text-destructive text-xs">Limit reached for today</span> : null}
    </div>
  );
}

function LastDays({ report }: { report: AiUsageReport }) {
  if (report.rows.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-muted-foreground text-sm" data-testid="usage-30d-empty">
        No AI chat answers in the last 30 days.
      </p>
    );
  }
  const t = report.totals;
  return (
    <>
      <ul className="divide-y" data-testid="usage-30d">
        {report.rows.map((row) => {
          const kindText = usageRowKindText(row);
          return (
            <li
              key={row.key}
              className="grid gap-0.5 px-4 py-3"
              data-testid="usage-30d-row"
              data-key={row.key}
              data-label={row.label}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-sm">
                  <span className="min-w-0 break-words">{row.label}</span>
                  <BackendTag backend={row.backend} />
                </span>
                <span
                  data-testid="usage-30d-cost"
                  className={cn(
                    "shrink-0 text-sm tabular-nums",
                    row.backend === "chatgpt_plan" && "text-muted-foreground text-xs",
                  )}
                >
                  {row.backend === "chatgpt_plan"
                    ? "Not billed"
                    : formatCostMicros(row.costMicrosUsd, usageCostEstimated(row))}
                </span>
              </div>
              <span className="text-muted-foreground text-xs tabular-nums">
                {kindText ?? answers(row.generations)} · {formatTokens(row.inputTokens)} in ·{" "}
                {formatTokens(row.outputTokens)} out
              </span>
            </li>
          );
        })}
      </ul>
      <div
        className="flex items-baseline justify-between gap-3 bg-muted/20 px-4 py-3 font-medium text-sm"
        data-testid="usage-30d-total"
      >
        <span>
          Total <span className="font-normal text-muted-foreground text-xs">· {answers(t.generations)}</span>
        </span>
        <span className="tabular-nums">
          {formatCostMicros(t.costMicrosUsd ?? 0, usageCostEstimated(t))}{" "}
          <span className="font-normal text-muted-foreground text-xs">to your organization</span>
        </span>
      </div>
      {t.estimatedGenerations > 0 ? (
        <p className="px-4 py-2.5 text-muted-foreground text-xs">
          ~ {answers(t.estimatedGenerations)} estimated: stopped, interrupted or failed before the provider
          reported usage.
        </p>
      ) : null}
    </>
  );
}
