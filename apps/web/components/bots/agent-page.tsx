"use client";

import { type Agent, MEMORY_ROOT_FILE } from "@ocw/contracts";
import { ArrowUpRight, Bot, NotebookText, RotateCcw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { UNIT_KIND_LABEL } from "@/components/members/unit-chip";
import { FileSkeleton, focusHeadingNext, MemoryFile } from "@/components/memory/memory-file";
import { MEMORY_SPLIT_QUERY } from "@/components/memory/memory-shell";
import { MemoryTree, type OpenVia, useMemoryTreeState } from "@/components/memory/memory-tree";
import { ModuleOff, useModule } from "@/components/shell/module-gate";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAgents, useBotsRealtime } from "@/lib/bots-queries";
import {
  useEnsureMemoryScope,
  useMemoryFilesByScope,
  useMemoryLiveUpdates,
  useMemoryScopes,
} from "@/lib/memory-queries";
import { folderNodeId, type MemoryNode, memoryAncestorIds, memoryHref, scopeNodeId } from "@/lib/memory-tree";
import { useMe, useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { BotAvatar, ScopeBadge } from "./bot-bits";
import { canMessage, MessageBotButton, PersonalBadge } from "./bot-card";
import { CapabilitiesPanel } from "./capabilities-panel";

/**
 * A bot's own page (Phase 07.2, 07.2-14, MEM-03, D-03, UI-SPEC "Agent page", R8, R9): who it is, what it remembers
 * and what it can do, read-only.
 * - Header: avatar, name, personal or scope badge, owner or unit line, description, Message.
 * - Memory: this bot's scopes as the API lists them for the viewer (its notebook, then "You & {bot}" when the viewer
 *   has private memory with it). From 1024 px the tree sits next to a read-only file pane with "Open in Memory"; below,
 *   the page is the tree and a file opens the viewer.
 * - Capabilities: the capabilities panel forced read-only, owners included (settings change in the bot's sheet).
 * A bot the viewer may not see (someone else's personal bot, admins included; ADR-0010) is the not-found state: the
 * bots list the API returns is the authority, and an unknown id never reaches the memory API.
 */

type AgentTab = "memory" | "capabilities";

export function AgentPage({ agentId }: { agentId: string }) {
  useBotsRealtime();
  const agents = useAgents();
  const agent = agents.data?.agents.find((a) => a.id === agentId) ?? null;

  if (agents.isPending) return <AgentPageSkeleton />;
  if (!agents.data) {
    return (
      <div data-testid="agent-page-error" className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={Bot}
          title="Couldn't load this bot."
          description={null}
          className="[&>p:empty]:hidden"
        >
          <Button variant="outline" className="max-lg:h-11" onClick={() => void agents.refetch()}>
            <RotateCcw /> Try again
          </Button>
        </EmptyState>
      </div>
    );
  }
  if (!agent) {
    return (
      <div data-testid="agent-page-notfound" className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={Bot}
          title="This bot doesn't exist or you can't open it"
          description={null}
          className="[&>p:empty]:hidden"
        >
          <Button variant="outline" className="max-lg:h-11" render={<Link href="/bots" />}>
            Back to Bots
          </Button>
        </EmptyState>
      </div>
    );
  }
  return <LoadedAgentPage agent={agent} />;
}

function LoadedAgentPage({ agent }: { agent: Agent }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const split = useMediaQuery(MEMORY_SPLIT_QUERY, true);
  const tab: AgentTab = search.get("tab") === "capabilities" ? "capabilities" : "memory";
  const memoryModule = useModule("memory");

  return (
    <div data-testid="agent-page" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentHeader agent={agent} split={split} />
      <Tabs
        variant="underline"
        value={tab}
        onValueChange={(next) =>
          router.replace(next === "capabilities" ? `${pathname}?tab=capabilities` : pathname, {
            scroll: false,
          })
        }
        className="min-h-0 flex-1"
      >
        <TabsList
          aria-label={`${agent.name} sections`}
          className={cn("shrink-0", split ? "px-4" : "grid grid-cols-2")}
        >
          <TabsTrigger value="memory" className={split ? "lg:min-h-10" : "justify-center"}>
            Memory
          </TabsTrigger>
          <TabsTrigger value="capabilities" className={split ? "lg:min-h-10" : "justify-center"}>
            Capabilities
          </TabsTrigger>
        </TabsList>
        <TabsContent value="memory" className="flex min-h-0 flex-col">
          {memoryModule === "off" ? (
            <ModuleOff module="memory" />
          ) : (
            <AgentMemory agent={agent} split={split} />
          )}
        </TabsContent>
        <TabsContent value="capabilities" className="scrollbar-thin overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 py-6 sm:px-6">
            <p className="mb-3 text-muted-foreground text-sm" data-testid="agent-capabilities-note">
              Read only. Bot settings change these.
            </p>
            <CapabilitiesPanel agentId={agent.id} readOnly headingLevel={2} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** "Owned by you" · "Owned by {person}" · "{Kind} · {unit}" (UI-SPEC "Copywriting › Agent page and DM panel"). */
function useOwnerLine(agent: Agent): string | null {
  const me = useMe();
  const members = useMembers();
  if (agent.scope === "personal") return "Owned by you";
  if (agent.ownerUserId) {
    if (me.data?.user.id === agent.ownerUserId) return "Owned by you";
    const owner = members.data?.members.find((m) => m.userId === agent.ownerUserId);
    if (owner) return `Owned by ${owner.displayName}`;
    if (members.isSuccess) return "Owned by a former member";
  }
  return agent.unit ? `${UNIT_KIND_LABEL[agent.unit.kind]} · ${agent.unit.name}` : null;
}

function AgentHeader({ agent, split }: { agent: Agent; split: boolean }) {
  const owner = useOwnerLine(agent);
  const message = canMessage(agent);
  return (
    <header data-testid="agent-header" className="shrink-0 border-b px-4 py-4 sm:px-6">
      <div className="flex items-start gap-3">
        <BotAvatar
          name={agent.name}
          avatar={agent.avatarUrl}
          seed={agent.id}
          className="size-10 rounded-xl text-xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="min-w-0 truncate font-semibold text-lg leading-tight tracking-tight">
              {agent.name}
            </h1>
            {agent.scope === "personal" ? <PersonalBadge /> : <ScopeBadge agent={agent} />}
          </div>
          {owner ? (
            <p data-testid="agent-owner" className="mt-0.5 truncate text-muted-foreground text-xs">
              {owner}
            </p>
          ) : null}
          {agent.description ? (
            <p
              className={cn(
                "mt-1 text-muted-foreground text-sm leading-5",
                split ? "line-clamp-1" : "line-clamp-2",
              )}
            >
              {agent.description}
            </p>
          ) : null}
        </div>
        {message && split ? <MessageBotButton agent={agent} className="shrink-0" /> : null}
      </div>
      {message && !split ? <MessageBotButton agent={agent} className="mt-3 h-11 w-full" /> : null}
    </header>
  );
}

function OpenInMemory({ href }: { href: string }) {
  return (
    <Button variant="outline" size="sm" render={<Link href={href} />} data-testid="agent-open-in-memory">
      Open in Memory <ArrowUpRight />
    </Button>
  );
}

const SKELETON_WIDTHS = ["w-[70%]", "w-[55%]", "w-[80%]", "w-[60%]", "w-[75%]", "w-[50%]"];

function TreeSkeleton({ stacked }: { stacked: boolean }) {
  return (
    <div data-testid="agent-memory-loading" aria-busy className="grid gap-px px-2 py-2">
      {SKELETON_WIDTHS.map((w) => (
        <div key={w} className={cn("flex items-center gap-2 px-2", stacked ? "h-11" : "h-8")}>
          <Skeleton className="size-4 shrink-0 rounded motion-reduce:animate-none" />
          <Skeleton className={cn("h-3.5 motion-reduce:animate-none", w)} />
        </div>
      ))}
    </div>
  );
}

function AgentMemory({ agent, split }: { agent: Agent; split: boolean }) {
  const router = useRouter();
  const scopesQ = useMemoryScopes();
  const { mutate: ensureScope } = useEnsureMemoryScope();
  const all = scopesQ.data?.scopes;
  // Only what the API listed for this viewer: never a scope it did not return (T-07.2-14-01).
  const scopes = useMemo(() => (all ?? []).filter((s) => s.agentId === agent.id), [all, agent.id]);
  const scopeFilter = useMemo(() => ({ agentId: agent.id }), [agent.id]);
  const notebook = scopes.find((s) => s.kind === "agent") ?? null;
  const own = scopes.find((s) => s.kind === "personal") ?? null;
  const scopeIds = useMemo(() => scopes.map((s) => s.id), [scopes]);
  const { files, isError: filesError, refetch: refetchFiles } = useMemoryFilesByScope(scopeIds);
  useMemoryLiveUpdates();

  // The notebook is created on first use; a 404 means the viewer may not read it, and the page shows what is left.
  const asked = useRef(false);
  const [ensured, setEnsured] = useState(false);
  useEffect(() => {
    if (!all || notebook || asked.current) return;
    asked.current = true;
    ensureScope({ kind: "agent", agentId: agent.id }, { onSettled: () => setEnsured(true) });
  }, [all, notebook, agent.id, ensureScope]);

  // The open file: what the viewer picked, else the notebook's MEMORY.md, else their private one (UI-SPEC).
  const [picked, setPicked] = useState<{ scopeId: string; path: string } | null>(null);
  const fallback = notebook ?? own;
  const selected =
    picked && scopes.some((s) => s.id === picked.scopeId)
      ? picked
      : fallback
        ? { scopeId: fallback.id, path: MEMORY_ROOT_FILE }
        : null;
  const selectedScope = selected ? (scopes.find((s) => s.id === selected.scopeId) ?? null) : null;

  // The default scope opens expanded, so its MEMORY.md row (open on desktop) is visible.
  const reveal = useMemoryTreeState((s) => s.reveal);
  const requestFocus = useMemoryTreeState((s) => s.requestFocus);
  const fallbackId = fallback?.id ?? null;
  useEffect(() => {
    if (fallbackId) reveal(memoryAncestorIds(fallbackId));
  }, [fallbackId, reveal]);

  const onOpen = (node: MemoryNode, via: OpenVia) => {
    if (node.kind !== "file" || !node.path) return;
    // Phones (and stacked widths): the viewer's file screen (UI-SPEC R9).
    if (!split) {
      router.push(memoryHref(node.scopeId, node.path));
      return;
    }
    if (via === "keyboard") focusHeadingNext();
    setPicked({ scopeId: node.scopeId, path: node.path });
  };
  const onRevealFolder = (folder: string | null) => {
    if (!selected) return;
    const scope = selected.scopeId;
    reveal(memoryAncestorIds(scope, folder ? `${folder}/x.md` : undefined));
    requestFocus(folder ? folderNodeId(scope, folder) : scopeNodeId(scope));
  };

  let body: ReactNode;
  if (scopesQ.isError || filesError) {
    body = (
      <div data-testid="agent-memory-error" className="grid justify-items-start gap-2 px-4 py-4 text-sm">
        <p className="text-muted-foreground">Couldn't load memory.</p>
        <Button
          variant="outline"
          size="sm"
          className="max-lg:h-11"
          onClick={() => {
            void scopesQ.refetch();
            refetchFiles();
          }}
        >
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  } else if (!all || (!notebook && !ensured)) {
    body = <TreeSkeleton stacked={!split} />;
  } else if (scopes.length === 0) {
    return (
      <div data-testid="agent-memory-empty" className="flex min-h-0 flex-1 flex-col">
        <EmptyState
          icon={NotebookText}
          title={`No memory you can open for ${agent.name}.`}
          description={null}
          className="[&>p:empty]:hidden"
        />
      </div>
    );
  } else {
    body = (
      <MemoryTree
        scopes={scopes}
        filesByScope={files}
        selected={split ? selected : null}
        onOpen={onOpen}
        scopeFilter={scopeFilter}
        stacked={!split}
        label={`${agent.name} memory files`}
      />
    );
  }

  if (!split) {
    return (
      <div data-testid="agent-memory" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {body}
      </div>
    );
  }

  const loading = !all || (!notebook && !ensured);
  return (
    <div data-testid="agent-memory" className="flex min-h-0 flex-1">
      <aside
        aria-label={`${agent.name} memory`}
        className="flex w-[280px] shrink-0 flex-col border-r bg-sidebar/50 dark:bg-sidebar/40"
      >
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">{body}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected && selectedScope ? (
          <MemoryFile
            key={`${selected.scopeId}:${selected.path}`}
            scopeId={selected.scopeId}
            path={selected.path}
            scope={selectedScope}
            layout="wide"
            readOnly
            actions={<OpenInMemory href={memoryHref(selected.scopeId, selected.path)} />}
            onRevealFolder={onRevealFolder}
          />
        ) : loading ? (
          <FileSkeleton stacked={false} />
        ) : null}
      </div>
    </div>
  );
}

function AgentPageSkeleton() {
  return (
    <div data-testid="agent-page-loading" aria-busy className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b px-4 py-4 sm:px-6">
        <Skeleton className="size-10 shrink-0 rounded-xl motion-reduce:animate-none" />
        <div className="grid flex-1 gap-2 pt-0.5">
          <Skeleton className="h-5 w-40 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-72 max-w-full motion-reduce:animate-none" />
        </div>
      </div>
      <div className="flex h-11 shrink-0 items-center gap-6 border-b px-6">
        <Skeleton className="h-3.5 w-16 motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-24 motion-reduce:animate-none" />
      </div>
      <TreeSkeleton stacked={false} />
    </div>
  );
}
