"use client";

import {
  type ApprovalDecisionRequest,
  ApprovalDetail,
  ApprovalList,
  type ApprovalRequestStatus,
  ApprovalRequestUpdatedEvent,
  ApprovalSummary,
  EventTypes,
  type MemoryProposalView,
  topic,
} from "@ocw/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, errorMessage, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Approvals over REST (Phase 07.2, 07.2-13, MEM-06, D-08): the inbox (`/memory/proposals`), one request's review and
 * its decision, every response parsed with the contract schemas. The API decides who may see and decide each request
 * (a personal proposal is visible only to its owner, never an admin); these hooks only render what it returns.
 */

export type ApprovalRole = "decider" | "requester";

/** The inbox tabs (UI-SPEC "Proposals inbox"): what I may review now, what my bots asked for, what was decided. */
export type ProposalBox = "review" | "requested" | "decided";

export const approvalKeys = {
  all: ["approvals"] as const,
  list: (role: ApprovalRole, status: ApprovalRequestStatus | null) =>
    ["approvals", "list", role, status ?? "any"] as const,
  detail: (id: string) => ["approvals", "detail", id] as const,
  count: ["approvals", "count"] as const,
};

/** 4xx answers are decisions (404 = missing or not yours), never retried. */
function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const PAGE_TARGET = 50;
/** API pages one inbox page may read (each scans at most 500 rows on the server). */
const MAX_HOPS = 10;

/**
 * One inbox page, filled: the API may answer a short page with a cursor (it checks each row's decider rule and stops
 * after a bounded scan, WINDOWS 133), so this follows the cursor until it holds a full page or the list ends.
 */
async function fetchFilled(
  role: ApprovalRole,
  status: ApprovalRequestStatus | null,
  cursor: string | null,
  target: number,
  signal?: AbortSignal,
): Promise<ApprovalList> {
  const items: ApprovalSummary[] = [];
  let next = cursor;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const params = new URLSearchParams({ role });
    if (status) params.set("status", status);
    if (next) params.set("cursor", next);
    const page = await api.get(`/api/v1/approvals?${params.toString()}`, { schema: ApprovalList, signal });
    items.push(...page.items);
    next = page.nextCursor;
    if (!next || items.length >= target) break;
  }
  return { items, nextCursor: next };
}

/** A tab's list: `status` null lists every status; "Show more" follows the cursor. */
export function useApprovals(
  role: ApprovalRole,
  status: ApprovalRequestStatus | null = null,
  enabled = true,
) {
  const q = useInfiniteQuery({
    queryKey: approvalKeys.list(role, status),
    queryFn: ({ pageParam, signal }) => fetchFilled(role, status, pageParam, PAGE_TARGET, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry: noRetryOn4xx,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return { ...q, items };
}

/** The items a tab shows (UI-SPEC: To review = pending for me; Decided = every closed one I could or did decide). */
export function useProposalBox(box: ProposalBox) {
  const review = useApprovals("decider", "pending", box === "review");
  const requested = useApprovals("requester", null, box === "requested");
  const decided = useApprovals("decider", null, box === "decided");
  const q = box === "review" ? review : box === "requested" ? requested : decided;
  const items = useMemo(
    () => (box === "decided" ? q.items.filter((i) => i.status !== "pending") : q.items),
    [box, q.items],
  );
  return { ...q, items };
}

/** Whether the viewer has anything in the inbox at all (may decide one, or their bots asked for one). */
export function useHasApprovals(enabled = true): boolean {
  const decider = useApprovals("decider", null, enabled);
  const requester = useApprovals("requester", null, enabled);
  return decider.items.length > 0 || requester.items.length > 0;
}

export function useApproval(id: string | null) {
  return useQuery({
    queryKey: approvalKeys.detail(id ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/approvals/${encodeURIComponent(id ?? "")}`, { schema: ApprovalDetail, signal }),
    enabled: !!id,
    retry: noRetryOn4xx,
  });
}

/**
 * Approve or deny with the hash of the view on screen (T-07.2-13-01): the server recomputes it and refuses a changed
 * action (409 `approval_action_changed`), so a reviewer never decides something they were not shown.
 */
export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; outcome: "approved" | "denied"; actionHash: string; note?: string }) => {
      const body: ApprovalDecisionRequest = {
        outcome: v.outcome,
        actionHash: v.actionHash,
        ...(v.note ? { note: v.note } : {}),
      };
      return api.post(`/api/v1/approvals/${encodeURIComponent(v.id)}/decision`, {
        body,
        schema: ApprovalSummary,
      });
    },
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
      void qc.invalidateQueries({ queryKey: approvalKeys.detail(v.id) });
      // An applied proposal changed a file: its tree, open copy and history.
      void qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}

const COUNT_CAP = 100;

/** How many proposals wait for the viewer (role decider, status pending), up to 100. Live. */
export function usePendingApprovalCount(enabled = true): number {
  useApprovalLiveUpdates();
  const q = useQuery({
    queryKey: approvalKeys.count,
    queryFn: async ({ signal }) => {
      let total = 0;
      let cursor: string | null = null;
      do {
        const page: ApprovalList = await fetchFilled("decider", "pending", cursor, COUNT_CAP, signal);
        total += page.items.length;
        cursor = page.nextCursor;
      } while (cursor && total < COUNT_CAP);
      return total;
    },
    enabled,
    retry: noRetryOn4xx,
    staleTime: 30_000,
  });
  return q.data ?? 0;
}

/** "3", or "99+" past 99. */
export const countLabel = (n: number) => (n > 99 ? "99+" : String(n));

/** The nav entry's accessible name: "Memory, 3 proposals to review" (UI-SPEC "Navigation and tree"). */
export function pendingLabel(label: string, n: number): string {
  if (n <= 0) return label;
  return `${label}, ${countLabel(n)} ${n === 1 ? "proposal" : "proposals"} to review`;
}

/**
 * `approval_request.updated {id, status}` on the viewer's own `user:` stream (ids and status only): refreshes the
 * count, every inbox list and that request's review without a reload.
 */
export function useApprovalLiveUpdates() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const userId = me.data?.user.id ?? null;
  useTopic(userId ? topic("user", userId) : null, (frame) => {
    if (frame.op !== "ev" || frame.type !== EventTypes.approvalRequestUpdated) return;
    const parsed = ApprovalRequestUpdatedEvent.safeParse(frame.data);
    if (!parsed.success) return;
    void qc.invalidateQueries({ queryKey: ["approvals", "list"] });
    void qc.invalidateQueries({ queryKey: approvalKeys.count });
    void qc.invalidateQueries({ queryKey: approvalKeys.detail(parsed.data.id) });
  });
}

// ---------------------------------------------------------------- copy (UI-SPEC Copywriting › Proposals)

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "2h ago", "3d ago". */
export function proposalAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** "Expires in 13 days", "Expires in 1 day", "Expires today". */
export function expiresText(iso: string, now: number = Date.now()): string {
  const days = Math.floor((new Date(iso).getTime() - now) / DAY);
  if (days < 1) return "Expires today";
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

const dateFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** "Oct 8, 9:12 AM". */
export const decisionDate = (iso: string) => dateFmt.format(new Date(iso));
/** "Oct 22". */
export const shortDate = (iso: string) => dayFmt.format(new Date(iso));

/** Why an approved change was not applied, in words (never an API code). */
export function failedReason(code: string | null | undefined, bot: string): string {
  switch (code) {
    case "stale_base":
      return `The file changed since this proposal. Ask ${bot} to propose again.`;
    case "path_exists":
      return "A file with this name was created since this proposal.";
    case "scope_gone":
      return "This memory no longer exists.";
    case "secret_detected":
      return "Not applied: the text contains a secret.";
    case "scope_full":
      return "This memory is full (2,000 files).";
    case "too_large":
      return "The file would be over 256 KB.";
    default:
      return "Couldn't apply this change.";
  }
}

/** The decision errors in words (UI-SPEC "Decision errors"); never an API code. */
export function decisionErrorText(err: unknown, requester: boolean): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "approval_action_changed":
        return "This proposal changed while you were reviewing it.";
      case "approval_already_decided":
        return "Someone already decided this proposal.";
      case "approval_expired":
        return "This proposal expired.";
      case "not_approver":
        return requester ? "You can't approve your own proposal." : "You can't decide this proposal.";
    }
  }
  return errorMessage(err);
}

/** "12 people will see this", "1 person will see this", "Only you will see this". */
export function readerSentence(view: Pick<MemoryProposalView, "readerCount" | "scope">): string {
  if (isPrivateScope(view.scope.kind)) return "Only you will see this";
  return view.readerCount === 1 ? "1 person will see this" : `${view.readerCount} people will see this`;
}

/** A person's own memory (theirs with a bot, or a personal bot's notebook): only its owner reads and decides. */
export const isPrivateScope = (kind: MemoryProposalView["scope"]["kind"]) => kind === "personal";

/** The memory a change goes to, as the dialogs name it: "Ventas memory", "your private memory with Scout", "Scout notebook". */
export function scopeText(view: Pick<MemoryProposalView, "scope" | "requestedBy">): string {
  switch (view.scope.kind) {
    case "personal":
      return `your private memory with ${view.requestedBy.agent.displayName}`;
    case "agent":
      return view.scope.label;
    case "org":
      return "Organization memory";
    default:
      return `${view.scope.label} memory`;
  }
}

/** The version an approved change becomes: a new file is version 1, an edit the version after the current one. */
export function nextVersion(view: Pick<MemoryProposalView, "currentVersion">): number {
  return (view.currentVersion ?? 0) + 1;
}
