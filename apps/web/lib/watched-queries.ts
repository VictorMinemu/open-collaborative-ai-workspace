"use client";

import {
  type CreateWatchedRecordRequest,
  EventTypes,
  isWorkspaceAccess,
  MyPermissions,
  type PreviewWatchedRecordRequest,
  PreviewWatchedRecordResponse,
  topic,
  type UpdateWatchedRecordRequest,
  type WatchedRecord,
  WatchedRecordList,
  WatchedRecord as WatchedRecordSchema,
  type WatchOptionConnector,
  WatchOptions,
} from "@ocw/contracts";
import {
  QueryClient,
  QueryClientContext,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useContext } from "react";
import { api, errorMessage, isApiError } from "./api";
import { permissionKeys } from "./permissions";
import { useTopic } from "./realtime";
import { relativeTime } from "./utils";

/**
 * Watched records in the web (07.6-17, AUTO-04, D-04, D-07, UI-SPEC Surface 7): one list per board
 * (`GET /watched-records?conversationId=`), refetched on `watched_record.updated` (ids only) on the board's `conv:`
 * stream, the dialog's options, preview and link, edit, stop and check. The API decides every right (`viewerCan`, the
 * options, 403 / 409); the browser only words what it was told. Record values are untrusted text: they are only ever
 * rendered as React text nodes.
 */

export const watchedKeys = {
  all: ["watched-records"] as const,
  list: (conversationId: string) => ["watched-records", "list", conversationId] as const,
  options: (conversationId: string) => ["watched-records", "options", conversationId] as const,
};

const BASE = "/api/v1/watched-records";
const DAY = 24 * 60 * 60_000;
/** "Check now" waits this long after a check this viewer asked for (the API's one-minute singleton). */
export const CHECK_COOLDOWN_MS = 60_000;

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/** Stands in when a tile renders outside a QueryClientProvider (static previews and tests): never fetches. */
const idleClient = new QueryClient();

/**
 * The board's watched records, one query per board (every tile and the strip share it). Live: a
 * `watched_record.updated` frame (durable `ev` or ephemeral `eph`) on `conv:<board>` refetches it. Safe outside a
 * QueryClientProvider (returns no data), so a 07.1 tile keeps rendering anywhere.
 */
export function useWatchedRecords(conversationId: string | null) {
  const provided = useContext(QueryClientContext);
  const client = provided ?? idleClient;
  const enabled = provided !== undefined && !!conversationId;
  useTopic(enabled && conversationId ? topic("conv", conversationId) : null, (frame) => {
    if ((frame.op === "ev" || frame.op === "eph") && frame.type === EventTypes.watchedRecordUpdated) {
      void client.invalidateQueries(
        { queryKey: watchedKeys.list(conversationId ?? "") },
        { cancelRefetch: false },
      );
    }
  });
  return useQuery(
    {
      enabled,
      queryKey: watchedKeys.list(conversationId ?? ""),
      queryFn: ({ signal }) =>
        api.get(`${BASE}?conversationId=${encodeURIComponent(conversationId ?? "")}`, {
          schema: WatchedRecordList,
          signal,
        }),
      retry: noRetryOn4xx,
      staleTime: 30_000,
    },
    client,
  );
}

/**
 * `record.watch` in the caller's organization permissions (the same query and key as `usePermissions`): cosmetic
 * gating only, the API re-decides on the board. False while loading and outside a QueryClientProvider.
 */
export function useMayWatch(): boolean {
  const provided = useContext(QueryClientContext);
  const q = useQuery(
    {
      enabled: provided !== undefined,
      queryKey: permissionKeys.mine,
      queryFn: ({ signal }) => api.get("/api/v1/me/permissions", { schema: MyPermissions, signal }),
      retry: noRetryOn4xx,
      staleTime: 60_000,
    },
    provided ?? idleClient,
  );
  return q.data?.permissions.includes("record.watch") ?? false;
}

/** The watch of one board card, or null. */
export function useCardWatch(card: {
  messageId: string;
  conversationId?: string | null;
}): WatchedRecord | null {
  const list = useWatchedRecords(card.conversationId ?? null);
  return list.data?.records.find((r) => r.cardMessageId === card.messageId) ?? null;
}

/** The dialog's connectors, tools and bots (fetched when the dialog opens; a share made meanwhile shows on reopen). */
export function useWatchOptions(conversationId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: watchedKeys.options(conversationId),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/options?conversationId=${encodeURIComponent(conversationId)}`, {
        schema: WatchOptions,
        signal,
      }),
    retry: noRetryOn4xx,
    staleTime: 0,
  });
}

/** `POST /watched-records/preview`: reads the record once (nothing is stored). */
export function useWatchPreview() {
  return useMutation({
    mutationFn: (body: PreviewWatchedRecordRequest) =>
      api.post(`${BASE}/preview`, { body, schema: PreviewWatchedRecordResponse }),
  });
}

function useReplace(conversationId: string) {
  const qc = useQueryClient();
  return (record: WatchedRecord) =>
    qc.setQueryData<WatchedRecordList>(watchedKeys.list(conversationId), (prev) =>
      prev ? { records: [...prev.records.filter((r) => r.id !== record.id), record] } : { records: [record] },
    );
}

export function useCreateWatch(conversationId: string) {
  const replace = useReplace(conversationId);
  return useMutation({
    mutationFn: (body: CreateWatchedRecordRequest) => api.post(BASE, { body, schema: WatchedRecordSchema }),
    onSuccess: replace,
  });
}

export function useUpdateWatch(conversationId: string) {
  const replace = useReplace(conversationId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWatchedRecordRequest }) =>
      api.patch(`${BASE}/${id}`, { body, schema: WatchedRecordSchema }),
    onSuccess: replace,
  });
}

export function useDeleteWatch(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`${BASE}/${id}`),
    onSuccess: (_res, id) =>
      qc.setQueryData<WatchedRecordList>(watchedKeys.list(conversationId), (prev) =>
        prev ? { records: prev.records.filter((r) => r.id !== id) } : prev,
      ),
  });
}

/**
 * `POST /watched-records/:id/check`: `access` when the thread opens (any reader), `manual` for Check now (posters).
 * Resolves `queued` (202) or `recent` (429: checked within the minute, P-13); anything else throws.
 */
export function useCheckWatch() {
  return useMutation({
    mutationFn: async ({ id, source }: { id: string; source: "access" | "manual" }) => {
      try {
        await api.post(`${BASE}/${id}/check`, { body: { source } });
        return "queued" as const;
      } catch (err) {
        if (isApiError(err, 429)) return "recent" as const;
        throw err;
      }
    },
  });
}

// ---------------------------------------------------------------- words (UI-SPEC Copywriting › Watched records)

export type WatchState = "watching" | "changed" | "paused" | "failed";

/** Watching · Changed (24 h after `lastChangedAt`) · Paused (reconnect) · Last check failed. */
export function watchState(
  w: Pick<WatchedRecord, "lastStatus" | "lastChangedAt">,
  now: number = Date.now(),
): WatchState {
  if (w.lastStatus === "not_connected") return "paused";
  if (w.lastStatus === "unreachable" || w.lastStatus === "error") return "failed";
  if (w.lastChangedAt && now - Date.parse(w.lastChangedAt) < DAY) return "changed";
  return "watching";
}

type LineWatch = Pick<
  WatchedRecord,
  "lastStatus" | "lastChangedAt" | "checkedAt" | "externalRef" | "connector" | "linkedBy"
>;

/** "checked 5 minutes ago" ("checked just now" within the minute). */
function checked(at: string, now: number): string {
  return `checked ${now - Date.parse(at) < 60_000 ? "just now" : relativeTime(at, now)}`;
}

function changedAgo(at: string, now: number): string {
  return now - Date.parse(at) < 60_000 ? "just now" : relativeTime(at, now);
}

/** The card strip's line: `{lead}` (amber when changed) and the rest. Null `checkedAt` = the first check is pending. */
export function watchLine(w: LineWatch, now: number = Date.now()): { lead: string; rest: string } {
  const c = w.connector.name;
  switch (watchState(w, now)) {
    case "paused":
      return { lead: "", rest: `Paused: ${w.linkedBy.displayName} needs to reconnect ${c}.` };
    case "failed":
      return {
        lead: "",
        rest: `Last check failed ${w.checkedAt ? changedAgo(w.checkedAt, now) : "just now"}. OCW tries again at the next check.`,
      };
    case "changed":
      return {
        lead: `Changed in ${c} ${changedAgo(w.lastChangedAt as string, now)}`,
        rest: w.checkedAt ? ` · ${checked(w.checkedAt, now)}` : "",
      };
    default:
      return {
        lead: "",
        rest: `Watching ${c} · ${w.externalRef}${w.checkedAt ? ` · ${checked(w.checkedAt, now)}` : ""}`,
      };
  }
}

/** The tile's accessible description sentence (the indicator icon itself is `aria-hidden`). */
export function watchDescription(w: LineWatch, now: number = Date.now()): string {
  const c = w.connector.name;
  switch (watchState(w, now)) {
    case "changed":
      return `Changed in ${c} ${changedAgo(w.lastChangedAt as string, now)}.`;
    case "paused":
      return `Paused: ${w.linkedBy.displayName} needs to reconnect ${c}.`;
    case "failed":
      return `Watching ${c} record ${w.externalRef}. The last check failed.`;
    default:
      return `Watching ${c} record ${w.externalRef}.`;
  }
}

/** The thread-open check runs only when the record was last checked more than a minute ago (the API debounces too). */
export function wantsAccessCheck(w: Pick<WatchedRecord, "checkedAt">, now: number = Date.now()): boolean {
  if (!w.checkedAt) return false; // the first check is already queued by the link
  return now - Date.parse(w.checkedAt) >= CHECK_COOLDOWN_MS;
}

/** Check now: "Checked just now" and disabled for a minute after this viewer's check (or the API's 429). */
export function checkNowState(p: { now: number; cooldownUntil: number; busy: boolean }): {
  label: "Check now" | "Checked just now";
  disabled: boolean;
} {
  const cooling = p.now < p.cooldownUntil;
  return { label: cooling ? "Checked just now" : "Check now", disabled: cooling || p.busy };
}

export const CHECK_INTERVALS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "1 day" },
] as const;

/** The Connector option: `{name} · workspace access` / `· your account` / `· your account · connect it first`. */
export function connectorLabel(c: Pick<WatchOptionConnector, "name" | "authMode" | "connection">): string {
  // Organization headers and the organization's own account alike (07.14 D-04): one shared credential.
  if (isWorkspaceAccess(c.authMode)) return `${c.name} · workspace access`;
  return c.connection === "connected"
    ? `${c.name} · your account`
    : `${c.name} · your account · connect it first`;
}

export function shareNotice(connector: string, channel: string, readers: number): string {
  const people = readers === 1 ? "1 person" : `${readers} people`;
  return `${connector} uses your own account, so everyone in #${channel} (${people}) would see what it reads. Allow ${connector} in #${channel} first.`;
}

/** The 07.4 shared-use dialog for this board and connector (UI-SPEC R7 / Surface 7a). */
export function shareHref(conversationId: string, connectorId: string): string {
  return `/settings/connections?share=${encodeURIComponent(conversationId)}&connector=${encodeURIComponent(connectorId)}`;
}

export function connectHref(connectorId: string): string {
  return `/settings/connections?connector=${encodeURIComponent(connectorId)}`;
}

/** Where a refusal belongs in the dialog and what it says (UI-SPEC Copy › Errors; never the connector's own text). */
export type WatchRefusal =
  | { at: "recordId"; text: string }
  | { at: "share" }
  | { at: "bot"; text: string }
  | { at: "form"; text: string };

export function watchRefusal(
  err: unknown,
  ctx: { connector: string; recordId: string; channel: string },
): WatchRefusal {
  if (isApiError(err)) {
    switch (err.code) {
      case "record_not_found":
        return { at: "recordId", text: `No record ${ctx.recordId} in ${ctx.connector}.` };
      case "member_account":
        return { at: "share" };
      case "not_connected":
      case "needs_reconnect":
        return { at: "form", text: `Connect ${ctx.connector} first.` };
      case "unreadable":
        return { at: "form", text: `${ctx.connector} returned something OCW can't read.` };
      case "connector_error":
        return { at: "form", text: `${ctx.connector} didn't answer. Try again later.` };
      case "agent_not_member":
      case "agent_cannot_post":
        return { at: "bot", text: `Pick a bot that's a member of #${ctx.channel}` };
      case "version_conflict":
        return {
          at: "form",
          text: "This watch changed since you opened it. Close it and open it again to see the changes.",
        };
      default:
        break;
    }
  }
  return { at: "form", text: errorMessage(err) };
}

/** Field picker rules: at least one, at most 20 (`WATCHED_LIMITS.fieldsMax`). */
export function fieldsError(count: number): string | null {
  if (count < 1) return "Pick at least one field";
  if (count > 20) return "Up to 20 fields";
  return null;
}

/** Fields preselected from the board's (template) fields: a value whose key or label names one of them. */
export function preselectedPointers(
  values: ReadonlyArray<{ pointer: string; suggestedLabel: string }>,
  boardFields: ReadonlyArray<{ key: string; label: string }>,
): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/gu, "");
  const names = new Set(boardFields.flatMap((f) => [norm(f.key), norm(f.label)]));
  return values
    .filter((v) => names.has(norm(v.suggestedLabel)) || names.has(norm(v.pointer.slice(1))))
    .map((v) => v.pointer);
}
