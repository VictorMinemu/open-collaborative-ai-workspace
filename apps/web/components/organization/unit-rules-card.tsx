"use client";

import {
  OrgRole,
  PERMISSION_DESCRIPTIONS,
  type Permission,
  type PermissionRule,
  ROLE_LABELS,
} from "@ocw/contracts";
import { Ban, Check, ShieldCheck, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { usePermissionRules } from "@/lib/org-queries";
import { useMembers } from "@/lib/queries";
import type { UnitNode } from "./unit-meta";

/**
 * Explicit allow/deny rules scoped to this unit, read-only (D-02: rules are created through the API in this
 * release). Rendered only for callers holding rule.read; the API requires it as well.
 */
export function UnitRulesCard({ unit }: { unit: UnitNode }) {
  const rules = usePermissionRules(true);
  const members = useMembers();
  const scoped = (rules.data?.rules ?? []).filter((r) => r.scopeUnitId === unit.id);
  const names = new Map((members.data?.members ?? []).map((m) => [m.userId, m.displayName]));

  const subject = (r: PermissionRule): string => {
    switch (r.subjectKind) {
      case "everyone":
        return "Everyone";
      case "role": {
        const role = OrgRole.safeParse(r.subjectId);
        return role.success ? ROLE_LABELS[role.data] : (r.subjectId ?? "Role");
      }
      case "user":
        return names.get(r.subjectId ?? "") ?? "A member";
      case "agent":
        return "A bot";
    }
  };

  return (
    <section className="grid gap-3" data-testid="unit-rules" aria-label="Access rules">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
            Access rules
            <Badge variant="outline">Read-only</Badge>
          </h3>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Explicit allow and deny rules for {unit.name} and everything inside it. A deny always wins.
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        {rules.isLoading ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : rules.isError ? (
          <p role="alert" className="px-4 py-5 text-destructive text-sm">
            {errorMessage(rules.error)}
          </p>
        ) : scoped.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-4 text-muted-foreground text-sm">
            <ShieldCheck className="size-4 shrink-0" />
            No rules for this unit
          </div>
        ) : (
          <ul className="divide-y">
            {scoped.map((r) => {
              const description = PERMISSION_DESCRIPTIONS[r.permission as Permission] as string | undefined;
              return (
                <li
                  key={r.id}
                  data-testid="unit-rule"
                  data-effect={r.effect}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <Badge variant={r.effect === "deny" ? "destructive" : "success"} className="w-14">
                    {r.effect === "deny" ? <Ban /> : <Check />}
                    {r.effect === "deny" ? "Deny" : "Allow"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <code className="break-all font-mono text-[12.5px]">{r.permission}</code>
                      {r.tool ? (
                        <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          <Wrench className="size-3" />
                          {r.tool}
                        </span>
                      ) : null}
                    </p>
                    {description ? (
                      <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-sm sm:text-right">
                    <span className="text-muted-foreground text-xs sm:block">Applies to </span>
                    <span className="font-medium">{subject(r)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
