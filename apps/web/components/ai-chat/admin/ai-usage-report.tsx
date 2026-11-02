"use client";

import type { AiUsageReportRow, AiUsageReport as Report } from "@ocw/contracts";
import { ChartColumn } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MeteredBadge } from "@/components/bots/provider-bits";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCostMicros, formatTokens, usageCostEstimated, usageRowKindText } from "@/lib/ai-format";
import { type UsageGrouping, type UsageWindow, useAiUsageReport } from "@/lib/ai-usage-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * Settings › Models › Usage (05-09, AICHAT-07, D-06): the organization's AI chat usage over the last 7, 30 or 90 days,
 * by member or by model. Answers, input/output tokens and cost (estimated from published prices; "~" when some of a
 * row's counts are estimates) with each row's share of the organization's cost, a totals row, and how many answers
 * were estimated. Members' ChatGPT plans are counted but cost the organization nothing. Ids, counts and money only,
 * never message text. A table from `sm`, stacked rows on a phone. Admins only (`provider.manage`).
 */
export function AiUsageReport() {
  const canManage = useCan("provider.manage");
  const [days, setDays] = useState<UsageWindow>(30);
  const [groupBy, setGroupBy] = useState<UsageGrouping>("user");
  const report = useAiUsageReport(days, groupBy, canManage);
  if (!canManage) return null;
  return (
    <section
      aria-labelledby="ai-usage-title"
      className="mx-auto grid w-full max-w-3xl gap-5 px-4 pb-10 sm:px-6"
      data-testid="ai-usage-report"
    >
      <div className="border-t pt-7">
        <h2 id="ai-usage-title" className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
          <ChartColumn aria-hidden className="size-4 text-muted-foreground" />
          Usage
        </h2>
        <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
          AI chat answers in this workspace. Costs are estimated from published prices; members' own ChatGPT
          plans cost the organization nothing.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Group usage"
          testId="ai-usage-groupBy"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: "user", label: "By member" },
            { value: "model", label: "By model" },
          ]}
        />
        <Segmented
          label="Period"
          testId="ai-usage-days"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
            { value: 90, label: "90 days" },
          ]}
        />
      </div>

      {report.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      ) : report.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => report.refetch()} retrying={report.isFetching} />
        </div>
      ) : (
        <ReportBody report={report.data} days={days} stale={report.isPlaceholderData} />
      )}
    </section>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div
      className="inline-flex rounded-lg border bg-muted/40 p-0.5"
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-md px-2.5 font-medium text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
            value === o.value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "2026-09-07" → "Sep 7" (UTC days). */
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Who pays for a model row (members: none). Shared with the member's own usage card. */
export function BackendTag({ backend }: { backend: AiUsageReportRow["backend"] }) {
  if (backend === "org_key") return <MeteredBadge />;
  if (backend === null) return null;
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1 font-medium text-[10px] text-muted-foreground leading-none">
      {backend === "chatgpt_plan" ? "ChatGPT plan" : "Not metered"}
    </span>
  );
}

/** "~$0.12" (some counts estimated), "$0", "Not billed" on a member's plan, "—" when nothing is priced. */
function costText(row: { costMicrosUsd: number | null; estimatedRecords: number }, backend?: string | null) {
  if (backend === "chatgpt_plan") return "Not billed";
  return formatCostMicros(row.costMicrosUsd, usageCostEstimated(row));
}

/** A thin single-hue bar: the row's share of the organization's cost in the period. */
function ShareBar({ share, className }: { share: number; className?: string }) {
  const pct = Math.round(share * 100);
  return (
    <div
      className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}
      role="img"
      aria-label={`${pct}% of the organization's cost`}
      title={`${pct}% of the organization's cost`}
    >
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(share * 100, 3)}%` }} />
    </div>
  );
}

function ReportBody({ report, days, stale }: { report: Report; days: UsageWindow; stale: boolean }) {
  const t = report.totals;
  const totalCost = t.costMicrosUsd ?? 0;
  const shareOf = (row: AiUsageReportRow) =>
    totalCost > 0 && row.costMicrosUsd !== null ? row.costMicrosUsd / totalCost : 0;
  const nameHeader = report.groupBy === "user" ? "Member" : "Model";

  if (report.rows.length === 0) {
    return (
      <p
        className="rounded-2xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm"
        data-testid="ai-usage-empty"
      >
        No AI chat answers in the last {days} days.
      </p>
    );
  }

  return (
    <div className={cn("grid gap-4 transition-opacity", stale && "opacity-60")} aria-busy={stale}>
      <dl className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="ai-usage-summary">
        <Stat
          label="Answers"
          value={t.generations.toLocaleString("en-US")}
          detail={`${shortDay(report.from)} – ${shortDay(report.to)}`}
        />
        <Stat
          label="Tokens"
          value={formatTokens(t.inputTokens + t.outputTokens)}
          detail={`${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out`}
        />
        <Stat
          label={
            <>
              <span className="sm:hidden">Org cost</span>
              <span className="hidden sm:inline">Organization cost</span>
            </>
          }
          value={formatCostMicros(t.costMicrosUsd ?? 0, t.estimatedRecords > 0 && totalCost > 0)}
          detail={t.estimatedRecords > 0 ? `${t.estimatedRecords} estimated` : "API keys"}
        />
      </dl>

      {/* sm and up: a table. */}
      <div className="relative hidden overflow-hidden rounded-2xl border bg-card shadow-xs sm:block">
        <table className="w-full text-sm" data-testid="ai-usage-table">
          <caption className="sr-only">
            AI chat usage by {report.groupBy === "user" ? "member" : "model"}, last {days} days
          </caption>
          <thead className="border-b bg-muted/30 text-left text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {nameHeader}
              </th>
              <Th>Answers</Th>
              <Th>Input</Th>
              <Th>Output</Th>
              <Th className="w-36 pr-4">Cost</Th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.rows.map((row) => (
              <tr key={row.key} data-testid="ai-usage-row" data-key={row.key} data-label={row.label}>
                <th scope="row" className="max-w-0 px-4 py-2.5 text-left font-medium">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate" title={row.label}>
                      {row.label}
                    </span>
                    <BackendTag backend={row.backend} />
                  </span>
                </th>
                <Td testId="ai-usage-answers">
                  {usageRowKindText(row) ? "—" : row.generations.toLocaleString("en-US")}
                </Td>
                <Td testId="ai-usage-input" title={`${row.inputTokens.toLocaleString("en-US")} input tokens`}>
                  {formatTokens(row.inputTokens)}
                </Td>
                <Td
                  testId="ai-usage-output"
                  title={`${row.outputTokens.toLocaleString("en-US")} output tokens`}
                >
                  {formatTokens(row.outputTokens)}
                </Td>
                <td className="py-2.5 pr-4 pl-3 text-right tabular-nums">
                  <span
                    data-testid="ai-usage-cost"
                    className={cn(row.backend === "chatgpt_plan" && "text-muted-foreground text-xs")}
                  >
                    {costText(row, row.backend)}
                  </span>
                  {shareOf(row) > 0 ? <ShareBar share={shareOf(row)} className="mt-1 ml-auto w-20" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t bg-muted/20 font-medium">
            <tr data-testid="ai-usage-total">
              <th scope="row" className="px-4 py-2.5 text-left">
                Total
              </th>
              <Td>{t.generations.toLocaleString("en-US")}</Td>
              <Td>{formatTokens(t.inputTokens)}</Td>
              <Td>{formatTokens(t.outputTokens)}</Td>
              <td className="py-2.5 pr-4 pl-3 text-right tabular-nums">{costText(t)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Phones: stacked rows. */}
      <ul className="grid divide-y overflow-hidden rounded-2xl border bg-card shadow-xs sm:hidden">
        {report.rows.map((row) => (
          <li
            key={row.key}
            className="grid gap-1.5 px-4 py-3"
            data-testid="ai-usage-row"
            data-key={row.key}
            data-label={row.label}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-sm">
                <span className="min-w-0 break-words">{row.label}</span>
                <BackendTag backend={row.backend} />
              </span>
              <span
                data-testid="ai-usage-cost"
                className={cn(
                  "shrink-0 font-medium text-sm tabular-nums",
                  row.backend === "chatgpt_plan" && "font-normal text-muted-foreground text-xs",
                )}
              >
                {costText(row, row.backend)}
              </span>
            </div>
            <p className="text-muted-foreground text-xs tabular-nums">
              {usageRowKindText(row) ?? (
                <span data-testid="ai-usage-answers">{plural(row.generations, "answer")}</span>
              )}
              {" · "}
              {formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out
            </p>
            {shareOf(row) > 0 ? <ShareBar share={shareOf(row)} /> : null}
          </li>
        ))}
        <li
          className="flex items-baseline justify-between gap-3 bg-muted/20 px-4 py-3 font-medium text-sm"
          data-testid="ai-usage-total"
        >
          <span>
            Total{" "}
            <span className="font-normal text-muted-foreground text-xs">
              · {plural(t.generations, "answer")} · {formatTokens(t.inputTokens)} in ·{" "}
              {formatTokens(t.outputTokens)} out
            </span>
          </span>
          <span className="shrink-0 tabular-nums">{costText(t)}</span>
        </li>
      </ul>

      <p className="text-muted-foreground text-xs leading-relaxed" data-testid="ai-usage-note">
        {t.estimatedGenerations > 0
          ? `${plural(t.estimatedGenerations, "answer")} of ${t.generations.toLocaleString("en-US")} ${t.estimatedGenerations === 1 ? "was" : "were"} estimated (~): stopped, interrupted or failed before the provider reported usage; a failed answer's estimate errs high. `
          : ""}
        Days are UTC. Titles, digest summaries and session summaries count tokens and cost, not answers.
      </p>
    </div>
  );
}

function Stat({ label, value, detail }: { label: ReactNode; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-3 py-2.5 shadow-xs sm:px-4 sm:py-3">
      <dt className="truncate text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold text-lg tabular-nums tracking-tight sm:text-xl">
        {value}
      </dd>
      {detail ? <dd className="truncate text-[11px] text-muted-foreground tabular-nums">{detail}</dd> : null}
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("px-3 py-2.5 text-right font-medium", className)}>
      {children}
    </th>
  );
}

function Td({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) {
  return (
    <td className="px-3 py-2.5 text-right tabular-nums" title={title} data-testid={testId}>
      {children}
    </td>
  );
}
