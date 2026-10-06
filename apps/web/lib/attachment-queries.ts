"use client";

import { AttachmentsConfig } from "@ocw/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * `GET /api/v1/attachments/config` (CHAT-12, P-10): whether this member can attach files here (storage configured
 * and reachable, `attachment.upload` allowed) and the limits. While it loads, or when it fails, attachments stay
 * hidden: the composer never offers what the server would refuse.
 */
export function useAttachmentsConfig() {
  return useQuery({
    queryKey: ["attachments", "config"],
    queryFn: () => api.get("/api/v1/attachments/config", { schema: AttachmentsConfig }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
