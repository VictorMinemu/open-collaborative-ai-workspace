"use client";

import type { ApprovalSummary } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Globe,
  Hand,
  Inbox,
  type LucideIcon,
  Package,
  Plug,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  ACTION_KINDS,
  countLabel,
  proposalAge,
  useApproval,
  useApprovalLiveUpdates,
  useApprovals,
  usePendingActionApprovalCount,
  usePendingApprovalCount,
} from "@/lib/approval-queries";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useDevices, useWorkZoneOrgSync } from "@/lib/workzone-queries";
import {
  ApprovalPill,
  ApprovalReview,
  ageWords,
  expiringMinutes,
  originIcon,
  originText,
  pillOf,
  requesterText,
} from "./approval-review";

/**
 * The `/approvals` inbox (Phase 07.5, D-04, APPROVE-02, APPROVE-03, UI-SPEC Surface 2, R1): what bots wait for — actions
 * (`tool.call`) and Work Zone proposals (`work_zone.start`). Memory proposals keep 07.2's `/memory/proposals`; a
 * pinned "Memory proposals" row links there when some wait. From 1024 px a 320 px list column beside the review pane;
 * below, the list screen, then the review screen with "Back to approvals". Lives in the approvals layout, so the list
 * keeps its scroll and selection while reviews change. Tabs and the kind filter are URL state (`box`, `kind`).
 */

export type ApprovalsBox = "review" | "requested" | "decided";
export type ApprovalsKind = "all" | "action" | "work_zone";

const BOXES: readonly ApprovalsBox[] = ["review", "requested", "decided"];
const BOX_LABEL: Record<ApprovalsBox, string> = {
  review: "To review",
  requested: "Requested",
  decided: "Decided",
};
const KINDS: readonly ApprovalsKind[] = ["all", "action", "work_zone"];
const KIND_LABEL: Record<ApprovalsKind, string> = { all: "All", action: "Actions", work_zone: "Work Zone" };
/** The `kinds` filter each value asks the API for (never `memory.write`). */
const KIND_FILTER: Record<ApprovalsKind, string> = {
  all: ACTION_KINDS,
  action: "tool.call",
  work_zone: "work_zone.start",
};
const PAGE_SIZE = 30;

/** Empty copy per tab and filter (UI-SPEC Copywriting "Empty tabs"). */
function emptyCopy(box: ApprovalsBox, kind: ApprovalsKind): { title: string; body: string } {
  if (kind === "action") return { title: "No actions here.", body: "" };
  if (kind === "work_zone") return { title: "No Work Zone proposals here.", body: "" };
  switch (box) {
    case "review":
      return {
        title: "Nothing to review",
        body: "When a bot needs your approval or proposes a Work Zone session, it shows up here.",
      };
    case "requested":
      return { title: "Nothing requested", body: "Actions your bots ask for appear here." };
    case "decided":
      return { title: "Nothing decided yet", body: "" };
  }
}

export const parseBox = (v: string | null): ApprovalsBox =>
  v === "requested" || v === "decided" ? v : "review";
export const parseKind = (v: string | null): ApprovalsKind =>
  v === "action" || v === "work_zone" ? v : "all";

function query(box: ApprovalsBox, kind: ApprovalsKind): string {
  const params = new URLSearchParams();
  if (box !== "review") params.set("box", box);
  if (kind !== "all") params.set("kind", kind);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const inboxHref = (box: ApprovalsBox, kind: ApprovalsKind = "all") => `/approvals${query(box, kind)}`;
export const reviewHref = (id: string, box: ApprovalsBox, kind: ApprovalsKind = "all") =>
  `/approvals/${encodeURIComponent(id)}${query(box, kind)}`;

/** Whether a request belongs to a filter value (kept selected when the filter changes). */
const inKind = (kind: ApprovalsKind, itemKind: string) => KIND_FILTER[kind].split(",").includes(itemKind);

/**
 * What a tab shows (UI-SPEC "List column"): To review = pending for me, oldest first (expiring soonest on top);
 * Requested = what my bots asked for, newest first; Decided = every closed one I could or did decide, newest first.
 */
export function useApprovalsBox(box: ApprovalsBox, kind: ApprovalsKind) {
  const kinds = KIND_FILTER[kind];
  const review = useApprovals("decider", { status: "pending", kinds, pageSize: PAGE_SIZE }, box === "review");
  const requested = useApprovals("requester", { kinds, pageSize: PAGE_SIZE }, box === "requested");
  const decided = useApprovals("decider", { kinds, pageSize: PAGE_SIZE }, box === "decided");
  const q = box === "review" ? review : box === "requested" ? requested : decided;
  const items = useMemo(() => sortBox(box, q.items), [box, q.items]);
  return { ...q, items };
}

export function sortBox(box: ApprovalsBox, items: readonly ApprovalSummary[]): ApprovalSummary[] {
  const time = (iso: string) => new Date(iso).getTime();
  if (box === "review") return [...items].sort((a, b) => time(a.expiresAt) - time(b.expiresAt));
  const shown = box === "decided" ? items.filter((i) => i.status !== "pending") : [...items];
  return shown.sort((a, b) => time(b.createdAt) - time(a.createdAt));
}

// ---------------------------------------------------------------- row

const CHIP_ICON: Record<string, LucideIcon> = { plug: Plug, globe: Globe, package: Package };

/** The kind glyph of a row (UI-SPEC: `Hand` for actions, `SquareTerminal` for Work Zone). */
const kindIcon = (kind: string): LucideIcon => (kind === "work_zone.start" ? SquareTerminal : Hand);

/**
 * A row's accessible name (UI-SPEC "Accessibility Contract › Inbox"): "Start a session in billing-api, Scout for you,
 * in DM, 5 minutes ago, MacBook Pro, Online".
 */
export function rowName(
  item: ApprovalSummary,
  box: ApprovalsBox,
  meId: string | null,
  now: number = Date.now(),
): string {
  const h = item.headline;
  const parts: string[] = [h?.title ?? "Approval request", requesterText(item, meId)];
  const where = originText(h?.origin);
  if (where) parts.push(`in ${where}`);
  parts.push(ageWords(item.createdAt, now));
  const minutes = item.status === "pending" ? expiringMinutes(item.expiresAt, now) : null;
  if (box === "review" && minutes !== null) parts.push(`expires in ${minutes} min`);
  for (const chip of h?.chips ?? []) {
    if (chip.kind === "device") parts.push(chip.label, chip.state === "offline" ? "Offline" : "Online");
    else if (chip.kind === "tainted") parts.push("used outside content");
    else parts.push(chip.label);
  }
  if (box !== "review") parts.push(pillOf(item.kind, item.status, h?.useBy ?? null, now).label);
  return parts.join(", ");
}

function RowTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setCut(el.scrollWidth > el.clientWidth);
  }, []);
  return (
    <Tooltip content={text} disabled={!cut}>
      <span ref={ref} className="min-w-0 flex-1 truncate font-semibold text-sm">
        {text}
      </span>
    </Tooltip>
  );
}

export function ApprovalRow({
  item,
  box,
  kind,
  meId,
  selected,
  stacked,
  tabIndex,
  onKeyDown,
}: {
  item: ApprovalSummary;
  box: ApprovalsBox;
  kind: ApprovalsKind;
  meId: string | null;
  selected: boolean;
  stacked: boolean;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLAnchorElement>) => void;
}) {
  const h = item.headline;
  const KindIcon = kindIcon(item.kind);
  const OriginIcon = originIcon(h?.origin);
  const where = originText(h?.origin);
  const minutes = item.status === "pending" ? expiringMinutes(item.expiresAt) : null;
  const bot = h?.agent?.displayName ?? null;
  const chips = h?.chips ?? [];
  return (
    <li>
      <Link
        href={reviewHref(item.id, box, kind)}
        data-testid={`approval-row-${item.id}`}
        data-approval-row=""
        data-id={item.id}
        data-kind={item.kind}
        data-status={item.status}
        aria-current={selected ? "page" : undefined}
        aria-label={rowName(item, box, meId)}
        tabIndex={tabIndex}
        onKeyDown={onKeyDown}
        className={cn(
          "relative grid min-h-[72px] gap-1 rounded-lg px-3 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
          stacked && "rounded-none px-4",
        )}
      >
        {selected ? (
          <span aria-hidden className="absolute top-3 bottom-3 left-0 w-0.5 rounded-r-full bg-primary" />
        ) : null}
        <span className="flex min-w-0 items-center gap-2">
          <KindIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <RowTitle text={h?.title ?? "Approval request"} />
          {box === "review" && minutes !== null ? (
            <span className="shrink-0 text-amber-800 text-xs dark:text-amber-300">
              Expires in {minutes} min
            </span>
          ) : (
            <time dateTime={item.createdAt} className="shrink-0 text-muted-foreground text-xs">
              {proposalAge(item.createdAt)}
            </time>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {bot ? <PrincipalAvatar kind="agent" name={bot} className="size-4" /> : null}
          <span className="min-w-0 truncate">{requesterText(item, meId)}</span>
          {where ? (
            <>
              <span aria-hidden>·</span>
              <OriginIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-[40%] shrink-0 truncate">{where}</span>
            </>
          ) : null}
        </span>
        {chips.length > 0 || box !== "review" ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {chips.map((chip) => {
              if (chip.kind === "tainted") {
                return (
                  <Badge key={`t-${chip.label}`} variant="warning" className="h-5 px-1.5">
                    <TriangleAlert aria-hidden /> Outside content
                  </Badge>
                );
              }
              if (chip.kind === "device") {
                const online = chip.state !== "offline";
                return (
                  <Badge
                    key={`d-${chip.label}`}
                    variant="outline"
                    data-testid="approval-row-device"
                    className="h-5 max-w-full px-1.5"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-flex size-1.5 shrink-0 rounded-full",
                        online ? "bg-emerald-500" : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="truncate">
                      {chip.label} · {online ? "Online" : "Offline"}
                    </span>
                  </Badge>
                );
              }
              const Icon = chip.icon ? CHIP_ICON[chip.icon] : Plug;
              return (
                <Badge key={`s-${chip.label}`} variant="outline" className="h-5 max-w-full px-1.5">
                  {Icon ? <Icon aria-hidden /> : null}
                  <span className="truncate">{chip.label}</span>
                </Badge>
              );
            })}
            {box !== "review" ? (
              <ApprovalPill
                kind={item.kind}
                status={item.status}
                useBy={h?.useBy ?? null}
                className="ml-auto h-5 px-2 text-[11px]"
              />
            ) : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------- list

function RowSkeleton() {
  return (
    <div data-testid="approvals-loading" aria-busy className="grid gap-1 px-2">
      {["w-[80%]", "w-[60%]", "w-[70%]", "w-[50%]"].map((w) => (
        <div key={w} className="grid h-18 content-center gap-2 px-3">
          <Skeleton className={cn("h-3.5 motion-reduce:animate-none", w)} />
          <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

function ApprovalsList({
  box,
  kind,
  selectedId,
  focusId,
  stacked,
}: {
  box: ApprovalsBox;
  kind: ApprovalsKind;
  selectedId: string | null;
  /** The row to focus once listed (phone: the review the person came back from). */
  focusId: string | null;
  stacked: boolean;
}) {
  const q = useApprovalsBox(box, kind);
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = q.items.findIndex((i) => i.id === selectedId);
  const [active, setActive] = useState(0);
  const current = selectedIndex >= 0 ? selectedIndex : Math.min(active, Math.max(0, q.items.length - 1));

  useEffect(() => {
    if (!focusId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"]`);
    row?.focus();
  }, [focusId]);

  // Desktop: one tab stop in the list, ↑/↓ move between rows, Enter opens (UI-SPEC "Inbox").
  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.max(0, Math.min(q.items.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
    setActive(next);
    listRef.current?.querySelectorAll<HTMLElement>("[data-approval-row]")[next]?.focus();
  };

  if (q.isPending) return <RowSkeleton />;
  if (q.isError) {
    return (
      <div data-testid="approvals-error" className="grid gap-2 px-4 py-3 text-sm">
        <p className="text-muted-foreground">Couldn't load approvals.</p>
        <Button variant="outline" size="sm" className="w-fit max-lg:h-11" onClick={() => void q.refetch()}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
  if (q.items.length === 0 && !q.hasNextPage) {
    const copy = emptyCopy(box, kind);
    return (
      <EmptyState
        icon={kind === "work_zone" ? SquareTerminal : Hand}
        title={copy.title}
        description={copy.body}
        className="flex-none px-4 py-12"
      />
    );
  }
  return (
    <div className="grid gap-2 pb-3">
      <ul
        ref={listRef}
        aria-label={box === "review" ? "Approvals to review" : `${BOX_LABEL[box]} approvals`}
        data-testid="approvals-list"
        className={cn("grid gap-1", !stacked && "px-2")}
      >
        {q.items.map((item, i) => (
          <ApprovalRow
            key={item.id}
            item={item}
            box={box}
            kind={kind}
            meId={me}
            selected={item.id === selectedId}
            stacked={stacked}
            tabIndex={stacked ? undefined : i === current ? 0 : -1}
            onKeyDown={stacked ? undefined : onKeyDown(i)}
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

function InboxTabs({
  box,
  kind,
  stacked,
  onChange,
}: {
  box: ApprovalsBox;
  kind: ApprovalsKind;
  stacked: boolean;
  onChange: (box: ApprovalsBox, kind: ApprovalsKind) => void;
}) {
  const count = usePendingActionApprovalCount();
  return (
    <div className="grid shrink-0 gap-2">
      <Tabs variant="underline" value={box} onValueChange={(v) => onChange(parseBox(String(v)), kind)}>
        <TabsList aria-label="Approvals" className={cn("shrink-0", stacked ? "px-2" : "px-1")}>
          {BOXES.map((b) => (
            <TabsTrigger
              key={b}
              value={b}
              data-testid={`approvals-tab-${b}`}
              className={cn(stacked ? "flex-1 justify-center px-2" : "px-2 text-[13px]")}
            >
              {BOX_LABEL[b]}
              {b === "review" && count > 0 ? (
                <Badge
                  variant="brand"
                  data-testid="approvals-review-count"
                  className="h-5 min-w-5 rounded-full px-1.5 tabular-nums"
                >
                  {countLabel(count)}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Tabs
        variant="segmented"
        value={kind}
        onValueChange={(v) => onChange(box, parseKind(String(v)))}
        className="px-3"
      >
        <TabsList aria-label="Kind" className="max-lg:h-12 max-lg:w-full max-lg:p-0.5 max-md:h-12">
          {KINDS.map((k) => (
            <TabsTrigger
              key={k}
              value={k}
              data-testid={`approvals-kind-${k}`}
              // 44 px below 1024 (the segmented list's own phone height is 36 px per tab).
              className="max-lg:h-11 max-lg:flex-1 max-md:h-11"
            >
              {KIND_LABEL[k]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

/** The pinned "Memory proposals" row (UI-SPEC "Decision: memory proposals stay in /memory/proposals"). */
function MemoryProposalsLink({ stacked }: { stacked: boolean }) {
  const count = usePendingApprovalCount();
  if (count <= 0) return null;
  return (
    <Link
      href="/memory/proposals"
      data-testid="approvals-memory-link"
      aria-label={`Memory proposals, ${countLabel(count)} to review`}
      className={cn(
        "flex shrink-0 items-center gap-2.5 border-t px-4 font-medium text-sm outline-none hover:bg-sidebar-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
        stacked ? "h-14" : "h-12",
      )}
    >
      <Inbox aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Memory proposals</span>
      <Badge
        variant="brand"
        aria-hidden
        data-testid="approvals-memory-count"
        className="h-5 min-w-5 rounded-full px-1.5 tabular-nums"
      >
        {countLabel(count)}
      </Badge>
    </Link>
  );
}

export function ApprovalsInbox({
  box,
  kind,
  selectedId,
  focusId,
  stacked,
  onChange,
}: {
  box: ApprovalsBox;
  kind: ApprovalsKind;
  selectedId: string | null;
  focusId: string | null;
  stacked: boolean;
  onChange: (box: ApprovalsBox, kind: ApprovalsKind) => void;
}) {
  // The phone list screen is the page (its h1); beside a review, the review's title is.
  const Heading = stacked ? "h1" : "h2";
  return (
    <div data-testid="approvals-inbox" className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex h-12 shrink-0 items-center px-4", stacked && "max-md:sr-only")}>
        <Heading className="truncate font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Approvals
        </Heading>
      </div>
      <InboxTabs box={box} kind={kind} stacked={stacked} onChange={onChange} />
      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        <ApprovalsList box={box} kind={kind} selectedId={selectedId} focusId={focusId} stacked={stacked} />
      </div>
      <MemoryProposalsLink stacked={stacked} />
    </div>
  );
}

/** `/approvals?box=&kind=` and `/approvals/<id>?box=&kind=`. */
export function ApprovalsShell() {
  const wide = useMediaQuery("(min-width: 1024px)", true);
  const stacked = !wide;
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const search = useSearchParams();
  const box = parseBox(search.get("box"));
  const kind = parseKind(search.get("kind"));
  const id = params.id ? decodeURIComponent(params.id) : null;
  const me = useMe({ enabled: false }).data?.user.id ?? null;
  useApprovalLiveUpdates();
  // Device presence on the org stream keeps the Work Zone review's device state live (UI-SPEC R9), and the rows'
  // device chips with it: a device that goes offline or comes back re-reads the lists.
  useWorkZoneOrgSync();
  const qc = useQueryClient();
  const devices = useDevices();
  const presence = (devices.data ?? []).map((d) => `${d.id}:${d.status}`).join(",");
  const lastPresence = useRef<string | null>(null);
  useEffect(() => {
    const was = lastPresence.current;
    lastPresence.current = presence;
    if (was !== null && was !== presence) void qc.invalidateQueries({ queryKey: ["approvals", "list"] });
  }, [presence, qc]);
  const selected = useApproval(id).data ?? null;

  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    setMessage("");
    window.setTimeout(() => setMessage(text), 50);
  }, []);

  // Counts change live (a decision here, in a card or another tab): say it politely.
  const count = usePendingActionApprovalCount();
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    const was = lastCount.current;
    lastCount.current = count;
    if (was === null || was === count) return;
    announce(count === 0 ? "Nothing to review." : `${countLabel(count)} to review.`);
  }, [count, announce]);

  // Phone: Back returns to the list with the row it came from focused.
  const lastId = useRef<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (id) lastId.current = id;
    else if (lastId.current) {
      setFocusId(lastId.current);
      lastId.current = null;
    }
  }, [id]);

  const onChange = (nextBox: ApprovalsBox, nextKind: ApprovalsKind) => {
    // Keep the open review when it still belongs to the new tab and filter; otherwise select nothing.
    const keep =
      id &&
      selected &&
      inKind(nextKind, selected.kind) &&
      (nextBox === "review"
        ? selected.status === "pending" && selected.viewerCan.includes("decide")
        : nextBox === "requested"
          ? selected.requestedBy.userId === me
          : selected.status !== "pending");
    // A history entry per change: the back button restores the earlier tab and filter (UI-SPEC "Inbox").
    router.push(keep && id ? reviewHref(id, nextBox, nextKind) : inboxHref(nextBox, nextKind));
  };

  const live = (
    <p aria-live="polite" className="sr-only" data-testid="approvals-live">
      {message}
    </p>
  );

  const review = id ? (
    <ApprovalReview
      key={id}
      id={id}
      stacked={stacked}
      inboxHref={inboxHref(box, kind)}
      onBack={() => router.push(inboxHref(box, kind))}
      announce={announce}
    />
  ) : null;

  if (stacked) {
    return (
      <div
        data-testid="approvals-shell"
        data-layout="stacked"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {review ?? (
          <ApprovalsInbox
            box={box}
            kind={kind}
            selectedId={null}
            focusId={focusId}
            stacked
            onChange={onChange}
          />
        )}
        {live}
      </div>
    );
  }

  return (
    <div data-testid="approvals-shell" data-layout="split" className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Approvals"
        data-testid="approvals-column"
        className="flex w-[320px] shrink-0 flex-col border-r bg-sidebar/50 dark:bg-sidebar/40"
      >
        <ApprovalsInbox
          box={box}
          kind={kind}
          selectedId={id}
          focusId={null}
          stacked={false}
          onChange={onChange}
        />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {review ?? (
          <EmptyState
            icon={Hand}
            title="Select an approval"
            description="Pick one from the list to see exactly what the bot wants to do."
          />
        )}
      </div>
      {live}
    </div>
  );
}
