"use client";

import {
  type AccountPoolView,
  POOL_STRATEGY_TEXT,
  type PoolAccount,
  type PoolProvider,
} from "@ocw/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccountPool } from "@/lib/account-pool-queries";
import { useCan, usePermissions } from "@/lib/permissions";
import { AddClaudeAccountDialog } from "./add-claude-account-dialog";

/** Per provider: the section's title, what kind of subscription it holds, and its empty state. */
const PROVIDER_COPY: Record<
  PoolProvider,
  { title: string; plans: string; add: string; empty: string; emptyHelp: string }
> = {
  claude: {
    title: "Claude",
    plans: "Claude Pro, Max and Team subscriptions",
    add: "Add Claude account",
    empty: "No Claude accounts yet",
    emptyHelp: "Paste a setup-token from the account. Sessions and bots use it right away.",
  },
  chatgpt: {
    title: "ChatGPT",
    plans: "ChatGPT Plus, Pro and Business subscriptions",
    add: "Add ChatGPT account",
    empty: "No ChatGPT accounts yet",
    emptyHelp: "Sign one in for bots, or on a server device for its Work Zone sessions.",
  },
};

/**
 * Settings › Account pool (Phase 07.18, D-10, D-15): the organization's Claude and ChatGPT subscription accounts that
 * every member's Work Zone sessions and every bot use automatically. Admins only (`provider.manage`, PD-19); the API
 * decides every read and write and never returns a token.
 */
export function AccountPoolSettings() {
  const permissions = usePermissions();
  const canManage = useCan("provider.manage");
  const pool = useAccountPool(canManage);

  if (!canManage) {
    return permissions.isPending ? (
      <Skeleton className="h-40 rounded-2xl" />
    ) : (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        Only workspace admins manage the account pool.
      </div>
    );
  }
  if (pool.isPending) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    );
  }
  if (pool.isError) {
    return (
      <div className="rounded-xl border bg-card">
        <ServerUnreachable onRetry={() => pool.refetch()} retrying={pool.isFetching} />
      </div>
    );
  }
  return <PoolSections view={pool.data} />;
}

/** Both provider sections for a loaded view (the tests render this directly). */
export function PoolSections({ view }: { view: AccountPoolView }) {
  const [adding, setAdding] = useState<PoolProvider | null>(null);
  return (
    <div className="grid gap-8" data-testid="account-pool-settings">
      <p className="text-muted-foreground text-sm">
        Every member's Work Zone sessions and every bot use these accounts automatically. Nobody has to set
        anything up.
      </p>
      <ProviderSection provider="claude" pool={view.claude} onAdd={() => setAdding("claude")} />
      <ProviderSection provider="chatgpt" pool={view.chatgpt} onAdd={() => setAdding("chatgpt")} />
      <AddClaudeAccountDialog
        open={adding === "claude"}
        onOpenChange={(o) => setAdding(o ? "claude" : null)}
      />
    </div>
  );
}

function ProviderSection({
  provider,
  pool,
  onAdd,
}: {
  provider: PoolProvider;
  pool: AccountPoolView[PoolProvider];
  onAdd: () => void;
}) {
  const copy = PROVIDER_COPY[provider];
  const ready = pool.accounts.filter((a) => a.status === "ready").length;
  const strategy = POOL_STRATEGY_TEXT[pool.policy.strategy];
  return (
    <section
      data-testid={`pool-section-${provider}`}
      aria-labelledby={`pool-${provider}-title`}
      className="overflow-hidden rounded-2xl border bg-card shadow-xs"
    >
      <header className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`pool-${provider}-title`} className="font-semibold text-[15px] tracking-tight">
              {copy.title}
            </h2>
            {pool.accounts.length > 0 ? (
              <Badge variant={ready > 0 ? "success" : "warning"} className="tabular-nums">
                {ready} of {pool.accounts.length} ready
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-muted-foreground text-sm">{copy.plans}</p>
        </div>
        {pool.accounts.length > 0 ? (
          <Button
            size="sm"
            onClick={onAdd}
            data-testid={`pool-add-${provider}`}
            className="w-full max-md:h-11 sm:w-auto"
          >
            <Plus /> {copy.add}
          </Button>
        ) : null}
      </header>

      <div className="border-t bg-muted/20 px-4 py-3 sm:px-5" data-testid={`pool-strategy-${provider}`}>
        <p className="font-medium text-sm">{strategy.label}</p>
        <p className="mt-0.5 text-muted-foreground text-xs">{strategy.description}</p>
      </div>

      {pool.accounts.length === 0 ? (
        <div
          data-testid={`pool-empty-${provider}`}
          className="grid justify-items-center gap-3 border-t px-4 py-8 text-center"
        >
          <div>
            <p className="font-medium text-sm">{copy.empty}</p>
            <p className="mt-0.5 text-muted-foreground text-sm">{copy.emptyHelp}</p>
          </div>
          <Button size="sm" onClick={onAdd} data-testid={`pool-add-${provider}`} className="max-md:h-11">
            <Plus /> {copy.add}
          </Button>
        </div>
      ) : (
        <ul className="divide-y border-t">
          {pool.accounts.map((a) => (
            <AccountLine key={a.id} account={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountLine({ account }: { account: PoolAccount }) {
  return (
    <li data-testid="pool-account" className="px-4 py-3 sm:px-5">
      <span className="font-medium text-sm">{account.label}</span>
    </li>
  );
}
