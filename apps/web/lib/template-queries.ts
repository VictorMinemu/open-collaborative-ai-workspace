"use client";

import {
  type CreateRecordTemplateRequest,
  Ok,
  RecordTemplate,
  RecordTemplateList,
  type UpdateRecordTemplateRequest,
} from "@ocw/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "./api";

/**
 * Record templates (07.1-07 routes, BOARD-06, P-08). `useRecordTemplates(unitId)` lists what a channel placed in that
 * unit may use (its own, its ancestors' and organization-wide templates; `null` = organization-wide only) plus
 * `canManage`, the resolver's decision for that unit, which only gates what the UI shows. Every write is re-decided
 * by the API.
 */
export const templateKeys = {
  all: ["record-templates"] as const,
  list: (unitId: string | null) => ["record-templates", unitId ?? "org"] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useRecordTemplates(unitId: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: templateKeys.list(unitId),
    queryFn: ({ signal }) =>
      api.get(
        unitId ? `/api/v1/record-templates?unitId=${encodeURIComponent(unitId)}` : "/api/v1/record-templates",
        {
          schema: RecordTemplateList,
          signal,
        },
      ),
    retry: noRetryOn4xx,
  });
}

function useInvalidateTemplates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: templateKeys.all });
}

export function useCreateRecordTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (body: CreateRecordTemplateRequest) =>
      api.post("/api/v1/record-templates", { body, schema: RecordTemplate }),
    onSuccess: invalidate,
  });
}

/** A stale `expectedVersion` answers 409 `template_version_conflict` with the current template in `details.template`. */
export function useUpdateRecordTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateRecordTemplateRequest }) =>
      api.patch(`/api/v1/record-templates/${id}`, { body, schema: RecordTemplate }),
    onSuccess: invalidate,
  });
}

export function useDeleteRecordTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/record-templates/${id}`, { schema: Ok }),
    onSuccess: invalidate,
  });
}

/** The current template a 409 `template_version_conflict` carries, or null for any other error. */
export function conflictTemplate(err: unknown): RecordTemplate | null {
  if (!isApiError(err, 409) || err.code !== "template_version_conflict") return null;
  const parsed = RecordTemplate.safeParse((err.details as { template?: unknown } | null)?.template);
  return parsed.success ? parsed.data : null;
}
