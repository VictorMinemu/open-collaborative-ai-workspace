"use client";

import type { Agent } from "@ocw/contracts";
import { Bot, Plus, Sparkles, WifiOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgents, useBotsRealtime, useCellStatus, useModels } from "@/lib/bots-queries";
import { useCan } from "@/lib/permissions";
import { AddToChannelDialog } from "./add-to-channel-dialog";
import { BotCard } from "./bot-card";
import { BotDetailSheet } from "./bot-detail-sheet";
import { NewBotSheet, NoModels } from "./new-bot-sheet";

export function BotsGallery() {
  useBotsRealtime();
  const canManage = useCan("bot.manage");
  const canManageCell = useCan("cell.manage");
  const canManageProviders = useCan("provider.manage");
  const agents = useAgents();
  const models = useModels();
  const cell = useCellStatus(canManageCell);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [channelFor, setChannelFor] = useState<Agent | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 6000);
    return () => clearTimeout(t);
  }, [fresh]);

  // The API already filters: team bots the caller may read, plus the caller's own personal bots (D-01).
  const list = agents.data?.agents ?? [];
  const open = list.find((a) => a.id === openId) ?? null;
  const noModels = models.isSuccess && models.data.models.length === 0;
  const pending = list.filter((a) => a.status === "provisioning").length;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Bots"
        description="Teammates with their own identity. Message them privately or mention them in any channel."
        icon={<Bot />}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setCreating(true)} data-testid="new-bot">
              <Plus /> New bot
            </Button>
          ) : null
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {canManageCell && cell.data && !cell.data.connected && list.length > 0 ? (
          <div
            data-testid="runtime-offline"
            className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 text-sm sm:mx-6"
          >
            <WifiOff className="size-4 shrink-0 text-warning" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">Bots runtime is offline.</span>{" "}
              <span className="text-muted-foreground">
                {pending > 0
                  ? "New bots stay in Provisioning until OpenClaw connects."
                  : "Mentions are queued until it reconnects."}
              </span>
            </p>
            <Link href="/settings/bots-runtime" className="shrink-0 font-medium text-primary hover:underline">
              Runtime
            </Link>
          </div>
        ) : null}

        {agents.isPending ? (
          <Grid>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-2xl border bg-card p-4">
                <div className="flex gap-3">
                  <Skeleton className="size-11 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="mt-4 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
                <Skeleton className="mt-5 h-6 w-32 rounded-full" />
              </div>
            ))}
          </Grid>
        ) : agents.isError ? (
          <ServerUnreachable onRetry={() => agents.refetch()} retrying={agents.isFetching} />
        ) : list.length === 0 ? (
          noModels ? (
            <div className="mx-auto flex max-w-md flex-1 px-4 py-16">
              <NoModels canManage={canManageProviders} className="w-full" />
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="Create your first bot"
              description="Bots are teammates with their own identity and permissions. Add them to channels and mention them like anyone else."
            >
              {canManage ? (
                <Button onClick={() => setCreating(true)} data-testid="new-bot-empty">
                  <Plus /> New bot
                </Button>
              ) : (
                <p className="text-muted-foreground text-sm">Ask a workspace admin to create one.</p>
              )}
            </EmptyState>
          )
        ) : (
          <Grid>
            {list.map((a) => (
              <BotCard
                key={a.id}
                agent={a}
                highlight={fresh === a.id}
                onOpen={() => setOpenId(a.id)}
                onAddToChannel={() => setChannelFor(a)}
              />
            ))}
            {canManage ? (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex min-h-16 items-center justify-center gap-2 rounded-2xl sm:min-h-[172px] sm:flex-col border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:border-primary/40 hover:bg-brand-soft/30 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <span className="flex size-9 items-center justify-center rounded-xl border bg-card shadow-xs">
                  <Plus className="size-4" />
                </span>
                New bot
              </button>
            ) : null}
          </Grid>
        )}
      </div>

      <NewBotSheet open={creating} onOpenChange={setCreating} onCreated={(a) => setFresh(a.id)} />
      <BotDetailSheet
        agent={open}
        onOpenChange={(o) => !o && setOpenId(null)}
        onAddToChannel={(a) => setChannelFor(a)}
      />
      <AddToChannelDialog agent={channelFor} onOpenChange={(o) => !o && setChannelFor(null)} />
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:gap-4 sm:px-6 sm:py-6 xl:grid-cols-3 2xl:grid-cols-4">
      {children}
    </div>
  );
}
