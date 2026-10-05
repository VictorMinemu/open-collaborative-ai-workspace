"use client";

import { useRouter } from "next/navigation";
import { useAgents } from "@/lib/bots-queries";
import { BotDetailSheet } from "./bot-detail-sheet";

/**
 * Bot settings opened from the bot's private chat (the DM header): for the owner of a personal bot (or the
 * manager of a team bot) its capabilities, daily limit and usage, its profile (name, avatar, model,
 * instructions) and delete. Controls follow the bot's `viewerCan`; the API re-decides every change.
 */
export function BotSettingsSheet({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const agents = useAgents();
  const agent = agents.data?.agents.find((a) => a.id === agentId) ?? null;
  return (
    <BotDetailSheet
      variant="dm"
      agent={open ? agent : null}
      onOpenChange={onOpenChange}
      onDeleted={() => router.push("/chat")}
    />
  );
}
