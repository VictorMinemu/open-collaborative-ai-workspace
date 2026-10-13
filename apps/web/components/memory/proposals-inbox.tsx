"use client";

import type { ApprovalSummary } from "@ocw/contracts";
import { ArrowLeft, Bot, Inbox, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import {
  countLabel,
  type ProposalBox,
  proposalAge,
  useApprovalLiveUpdates,
  usePendingApprovalCount,
  useProposalBox,
} from "@/lib/approval-queries";
import { cn } from "@/lib/utils";
import { useMemoryLayout } from "./memory-shell";
import { contextIcon, ProposalReview, StatusPill } from "./proposal-view";

/**
 * The approvals inbox (Phase 07.2, 07.2-13, MEM-06, D-08, UI-SPEC "Desktop at 1440 — Proposals inbox and review",
 * "Phone at 390 — proposals"): its own place under Memory because an approver may not read the conversation where a
 * proposal was born. Tabs To review (with the count) · Requested by you · Decided. From 1024 px a 280 px column beside
 * the review pane; below, the list screen, then the review screen with "Back to proposals". Lives in the proposals
 * layout so the list keeps its scroll while reviews change.
 */

const BOXES: readonly ProposalBox[] = ["review", "requested", "decided"];
const BOX_LABEL: Record<ProposalBox, string> = {
  review: "To review",
  requested: "Requested by you",
  decided: "Decided",
};
const EMPTY: Record<ProposalBox, string> = {
  review: "Nothing to review.",
  requested: "No proposals from your bots yet.",
  decided: "Nothing decided yet.",
};

export const parseBox = (v: string | null): ProposalBox =>
  v === "requested" || v === "decided" ? v : "review";

export const inboxHref = (box: ProposalBox) =>
  box === "review" ? "/memory/proposals" : `/memory/proposals?box=${box}`;
export const reviewHref = (id: string, box: ProposalBox) =>
  `/memory/proposals/${encodeURIComponent(id)}${box === "review" ? "" : `?box=${box}`}`;

function RowSkeleton() {
  return (
    <div data-testid="proposals-loading" aria-busy className="grid gap-1 px-2">
      {["w-[75%]", "w-[60%]", "w-[70%]"].map((w) => (
        <div key={w} className="grid h-18 content-center gap-2 px-3">
          <Skeleton className={cn("h-3.5 motion-reduce:animate-none", w)} />
          <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

function TruncatedTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setCut(el.scrollWidth > el.clientWidth);
  }, []);
  return (
    <Tooltip content={text} disabled={!cut}>
      <span
        ref={ref}
        data-testid="proposal-row-title"
        className="min-w-0 flex-1 truncate font-semibold text-sm"
      >
        {text}
      </span>
    </Tooltip>
  );
}

function ProposalRow({
  item,
  box,
  selected,
  stacked,
}: {
  item: ApprovalSummary;
  box: ProposalBox;
  selected: boolean;
  stacked: boolean;
}) {
  const h = item.headline;
  const Icon = contextIcon(h?.context);
  return (
    <li>
      <Link
        href={reviewHref(item.id, box)}
        data-testid="proposal-row"
        data-id={item.id}
        data-status={item.status}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "relative grid min-h-[72px] gap-1 rounded-lg px-3 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
          stacked && "rounded-none px-4",
        )}
      >
        {selected ? (
          <span aria-hidden className="absolute top-3 bottom-3 left-0 w-0.5 rounded-r-full bg-primary" />
        ) : null}
        <span className="flex min-w-0 items-baseline gap-2">
          <TruncatedTitle text={h?.title ?? "Approval request"} />
          <time dateTime={item.createdAt} className="shrink-0 text-muted-foreground text-xs">
            {proposalAge(item.createdAt)}
          </time>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {h?.context ? (
            <>
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-[55%] shrink-0 truncate">{h.context}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <Bot aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{h?.requester ?? item.requestedBy.displayName}</span>
        </span>
        {(h?.tags.length ?? 0) > 0 || box !== "review" ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {box !== "review" ? <StatusPill status={item.status} className="h-5 px-2 text-[11px]" /> : null}
            {h?.tags.map((t) => (
              <span
                key={t.label}
                data-testid="proposal-row-tag"
                className={cn(
                  "inline-flex h-5 items-center rounded-md border px-1.5 font-medium text-[11px] leading-none",
                  t.tone === "warning"
                    ? "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
                    : "border-border text-muted-foreground",
                )}
              >
                {t.label}
              </span>
            ))}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function ProposalsList({
  box,
  selectedId,
  stacked,
}: {
  box: ProposalBox;
  selectedId: string | null;
  stacked: boolean;
}) {
  const q = useProposalBox(box);
  if (q.isPending) return <RowSkeleton />;
  if (q.isError) {
    return (
      <div data-testid="proposals-error" className="grid gap-2 px-4 py-3 text-sm">
        <p className="text-muted-foreground">Couldn't load proposals.</p>
        <Button variant="outline" size="sm" className="w-fit max-lg:h-11" onClick={() => void q.refetch()}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
  if (q.items.length === 0 && !q.hasNextPage) {
    return (
      <div data-testid="proposals-empty" className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <Inbox aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">{EMPTY[box]}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-2 pb-3">
      <ul
        aria-label={BOX_LABEL[box]}
        data-testid="proposals-list"
        className={cn("grid gap-1", !stacked && "px-2")}
      >
        {q.items.map((item) => (
          <ProposalRow
            key={item.id}
            item={item}
            box={box}
            selected={item.id === selectedId}
            stacked={stacked}
          />
        ))}
      </ul>
      {q.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="mx-2 max-lg:h-11"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function BoxTabs({ box, stacked }: { box: ProposalBox; stacked: boolean }) {
  const router = useRouter();
  const count = usePendingApprovalCount();
  return (
    <Tabs
      variant="underline"
      value={box}
      onValueChange={(v) => router.replace(inboxHref(parseBox(String(v))))}
    >
      <TabsList aria-label="Proposals" className={cn("shrink-0", stacked ? "px-2" : "px-1")}>
        {BOXES.map((b) => (
          <TabsTrigger
            key={b}
            value={b}
            data-testid={`proposals-tab-${b}`}
            className={cn(stacked ? "flex-1 justify-center px-2" : "px-1.5 text-[13px]")}
          >
            {BOX_LABEL[b]}
            {b === "review" && count > 0 ? (
              <span
                data-testid="proposals-count"
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-soft px-1.5 font-medium text-[11px] text-brand-soft-foreground tabular-nums"
              >
                {countLabel(count)}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The inbox and review routes: `/memory/proposals?box=` and `/memory/proposals/<id>?box=`. */
export function ProposalsShell() {
  const layout = useMemoryLayout();
  const stacked = layout === "stacked";
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const search = useSearchParams();
  const box = parseBox(search.get("box"));
  const id = params.id ? decodeURIComponent(params.id) : null;
  useApprovalLiveUpdates();
  const first = useProposalBox(box).items[0]?.id ?? null;
  // Desktop `/memory/proposals` shows the first proposal of the tab beside the list (the URL stays the inbox's).
  const shownId = id ?? (stacked ? null : first);

  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    setMessage("");
    window.setTimeout(() => setMessage(text), 50);
  }, []);
  const live = (
    <p aria-live="polite" className="sr-only" data-testid="proposals-live">
      {message}
    </p>
  );

  const review = shownId ? (
    <ProposalReview
      key={shownId}
      id={shownId}
      stacked={stacked}
      inboxHref={inboxHref(box)}
      onBack={() => router.push(inboxHref(box))}
      announce={announce}
    />
  ) : null;

  if (stacked) {
    return (
      <div
        data-testid="proposals-shell"
        data-layout={layout}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {review ?? (
          <div data-testid="proposals-screen" className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-1 px-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Back to files"
                onClick={() => router.push("/memory")}
              >
                <ArrowLeft />
              </Button>
              <h1 className="truncate font-semibold text-lg">Proposals</h1>
            </div>
            <BoxTabs box={box} stacked />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProposalsList box={box} selectedId={null} stacked />
            </div>
          </div>
        )}
        {live}
      </div>
    );
  }

  return (
    <div data-testid="proposals-shell" data-layout={layout} className="flex min-h-0 min-w-0 flex-1">
      <aside
        data-testid="proposals-column"
        aria-label="Proposals"
        className="flex w-[280px] shrink-0 flex-col border-r bg-sidebar/50 dark:bg-sidebar/40"
      >
        <div className="flex h-12 shrink-0 items-center gap-1 px-2">
          <Link
            href="/memory"
            aria-label="Back to files"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <h2 className="truncate font-semibold text-[13px] text-muted-foreground uppercase tracking-wider">
            Proposals
          </h2>
        </div>
        <BoxTabs box={box} stacked={false} />
        <div className="min-h-0 flex-1 overflow-y-auto pt-2">
          <ProposalsList box={box} selectedId={shownId} stacked={false} />
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{review ?? <NoSelection box={box} />}</div>
      {live}
    </div>
  );
}

function NoSelection({ box }: { box: ProposalBox }) {
  const q = useProposalBox(box);
  if (q.isPending) return null;
  return (
    <div
      data-testid="proposal-review"
      data-state="empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <Inbox aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{EMPTY[box]}</p>
    </div>
  );
}
