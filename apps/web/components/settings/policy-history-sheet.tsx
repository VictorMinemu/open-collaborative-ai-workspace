"use client";

import type { ApprovableGroup, ToolApprovalHistoryItem } from "@ocw/contracts";
import { X } from "lucide-react";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  MODE_LABEL,
  type PolicyScope,
  patternLabel,
  useApprovalPolicyHistory,
} from "@/lib/approval-policy-queries";

/** "Oct 8, 10:31" (the year when it is not this one). */
export function historyDate(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "set All Acme CRM tools to Always ask" / "removed the rule for list_invoices" (after the actor's name). */
export function historyAction(item: ToolApprovalHistoryItem, catalog: readonly ApprovableGroup[]): string {
  const what = patternLabel(catalog, item.toolPattern);
  if (item.action === "deleted") return `removed the rule for ${what}`;
  return `set ${what} to ${item.mode ? MODE_LABEL[item.mode] : "a rule"}`;
}

/**
 * Change history (`PolicyHistorySheet`, UI-SPEC Surface 4, R5): the scope's `tool_approval_policy.*` audit rows,
 * newest first, 30 per page. The audit link of the settings page; never tool arguments.
 */
export function PolicyHistorySheet({
  open,
  onOpenChange,
  scope,
  scopeLabel,
  catalog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: PolicyScope;
  scopeLabel: string;
  catalog: readonly ApprovableGroup[];
}) {
  const history = useApprovalPolicyHistory(scope, open);
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showClose={false}
        className="max-sm:w-full max-sm:max-w-full sm:w-[28rem]"
        data-testid="policy-history-sheet"
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <SheetTitle>Change history</SheetTitle>
            <SheetDescription className="text-xs">{scopeLabel}</SheetDescription>
          </div>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="-mt-1 -mr-2 text-muted-foreground max-lg:size-11"
              />
            }
          >
            <X />
          </SheetClose>
        </div>
        <div
          role="region"
          aria-label="Changes"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe)
          tabIndex={0}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          {history.isPending ? (
            <ul className="divide-y" aria-busy>
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex gap-3 px-5 py-3">
                  <Skeleton className="size-7 rounded-full motion-reduce:animate-none" />
                  <div className="grid flex-1 gap-2">
                    <Skeleton className="h-3.5 w-56 max-w-full motion-reduce:animate-none" />
                    <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
                  </div>
                </li>
              ))}
            </ul>
          ) : history.isError ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm">
              <p>Couldn't load the history.</p>
              <Button variant="outline" size="sm" onClick={() => history.refetch()} className="max-lg:h-11">
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="px-5 py-10 text-center text-muted-foreground text-sm">No changes yet.</p>
          ) : (
            <ul className="divide-y" data-testid="policy-history-list">
              {items.map((item) => {
                const actor = item.actor?.displayName ?? "Someone";
                return (
                  <li key={item.id} className="flex gap-3 px-5 py-3" data-testid="policy-history-item">
                    <UserAvatar
                      name={actor}
                      seed={item.actor?.id ?? item.id}
                      className="mt-0.5 size-7 text-[11px]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm">
                        <span className="font-semibold">{actor}</span> {historyAction(item, catalog)}
                      </p>
                      <p className="mt-0.5 text-muted-foreground text-xs">
                        {item.action !== "deleted" && item.approverLabel && item.mode !== "never"
                          ? `Approvers: ${item.approverLabel} · `
                          : ""}
                        <time dateTime={item.at}>{historyDate(item.at)}</time>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {history.hasNextPage ? (
            <div className="border-t px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void history.fetchNextPage()}
                disabled={history.isFetchingNextPage}
                className="w-full max-lg:h-11"
              >
                {history.isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
                Show older changes
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
