"use client";

import {
  type AccountPoolView,
  BOTS_WEIGHTED_NOTE,
  CELL_CLAUDE_TOKENS,
  type PoolAccount,
  type PoolPolicy,
  type PoolProvider,
  type PoolScope,
  type UpdatePoolPolicyRequest,
} from "@ocw/contracts";
import { Info, Plus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { moveInOrder, strategyOptions } from "@/lib/account-pool-format";
import { useAccountPool, useReorderPool, useUpdatePoolPolicy } from "@/lib/account-pool-queries";
import { errorMessage } from "@/lib/api";
import { useCan, usePermissions } from "@/lib/permissions";
import { AccountPoolRow } from "./account-pool-row";
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

/** PD-18: who a Claude token account serves. */
const SCOPE_OPTIONS: Array<{ value: PoolScope; label: string }> = [
  { value: "all", label: "Work Zone and bots" },
  { value: "work_zone", label: "Work Zone only" },
  { value: "bots", label: "Bots only" },
];

/** D-05: the strategy only picks when a session starts or its account must change. */
const STICKY_NOTE = "A session keeps its account until that account hits its limit.";
/** A-05 fallback: Claude tokens do not reach the bots runtime. */
const BOTS_API_KEY_NOTE = "Bots use the Anthropic API key";

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

type Adding = { provider: "claude"; replacing: PoolAccount | null } | { provider: "chatgpt" } | null;

/**
 * Both provider sections for a loaded view (the tests render this directly). `cellClaudeTokens` is the contract's
 * `CELL_CLAUDE_TOKENS`, a prop only so its fallback text can be tested.
 */
export function PoolSections({
  view,
  cellClaudeTokens = CELL_CLAUDE_TOKENS,
}: {
  view: AccountPoolView;
  cellClaudeTokens?: boolean;
}) {
  const [adding, setAdding] = useState<Adding>(null);
  return (
    <div className="grid gap-8" data-testid="account-pool-settings">
      <p className="text-muted-foreground text-sm">
        Every member's Work Zone sessions and every bot use these accounts automatically. Nobody has to set
        anything up.
      </p>
      <ProviderSection
        provider="claude"
        pool={view.claude}
        botsUseApiKey={!cellClaudeTokens}
        onAdd={() => setAdding({ provider: "claude", replacing: null })}
        onReplaceToken={(a) => setAdding({ provider: "claude", replacing: a })}
      />
      <ProviderSection
        provider="chatgpt"
        pool={view.chatgpt}
        botsUseApiKey={false}
        onAdd={() => setAdding({ provider: "chatgpt" })}
        onReplaceToken={() => undefined}
      />
      <AddClaudeAccountDialog
        open={adding?.provider === "claude"}
        replacing={adding?.provider === "claude" ? adding.replacing : null}
        onOpenChange={(o) => {
          if (!o) setAdding(null);
        }}
      />
    </div>
  );
}

function ProviderSection({
  provider,
  pool,
  botsUseApiKey,
  onAdd,
  onReplaceToken,
}: {
  provider: PoolProvider;
  pool: AccountPoolView[PoolProvider];
  botsUseApiKey: boolean;
  onAdd: () => void;
  onReplaceToken: (a: PoolAccount) => void;
}) {
  const copy = PROVIDER_COPY[provider];
  const reorder = useReorderPool();
  const ready = pool.accounts.filter((a) => a.status === "ready").length;
  const ids = pool.accounts.map((a) => a.id);
  const weighted = pool.policy.strategy === "weighted";

  async function move(id: string, by: -1 | 1) {
    const accountIds = moveInOrder(ids, id, by);
    if (!accountIds) return;
    try {
      await reorder.mutateAsync({ provider, accountIds });
    } catch (err) {
      toast.error("Could not change the order", { description: errorMessage(err) });
    }
  }

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

      <PolicyControls policy={pool.policy} botsUseApiKey={botsUseApiKey} />

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
        <ul className="divide-y border-t" aria-label={`${copy.title} accounts, in order`}>
          {pool.accounts.map((a, i) => (
            <AccountPoolRow
              key={a.id}
              account={a}
              weighted={weighted}
              first={i === 0}
              last={i === pool.accounts.length - 1}
              reordering={reorder.isPending}
              onMove={(by) => void move(a.id, by)}
              onReplaceToken={() => onReplaceToken(a)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Strategy, scope (Claude) and the fallback switch; each change is saved at once (D-04, D-06, PD-18). */
function PolicyControls({ policy, botsUseApiKey }: { policy: PoolPolicy; botsUseApiKey: boolean }) {
  const id = useId();
  const save = useUpdatePoolPolicy();
  const provider = policy.provider;
  const options = strategyOptions();
  const chosen = options.find((o) => o.value === policy.strategy);
  const weightedForBots = policy.strategy === "weighted" && !botsUseApiKey;

  async function change(body: UpdatePoolPolicyRequest) {
    try {
      await save.mutateAsync({ provider, body });
    } catch (err) {
      toast.error("Could not save the setting", { description: errorMessage(err) });
    }
  }

  return (
    <div
      className="grid gap-4 border-t bg-muted/20 px-4 py-4 sm:px-5"
      data-testid={`pool-strategy-${provider}`}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <span id={`${id}-strategy`} className="font-medium text-sm">
            Distribution
          </span>
          <Select
            items={options.map((o) => ({ value: o.value, label: o.label }))}
            value={policy.strategy}
            onValueChange={(v) => {
              const option = options.find((o) => o.value === v);
              if (option && option.value !== policy.strategy) void change({ strategy: option.value });
            }}
            disabled={save.isPending}
          >
            <SelectTrigger
              aria-labelledby={`${id}-strategy`}
              data-testid={`pool-strategy-select-${provider}`}
              className="h-11 w-full bg-background sm:h-9"
            />
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="grid gap-0.5 py-0.5">
                    <span>{o.label}</span>
                    <span className="max-w-72 whitespace-normal text-muted-foreground text-xs">
                      {o.description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs leading-relaxed">{chosen?.description}</span>
        </div>
        {provider === "claude" ? (
          <div className="grid min-w-0 content-start gap-1.5">
            <span id={`${id}-scope`} className="font-medium text-sm">
              Used by
            </span>
            <Select
              items={SCOPE_OPTIONS}
              value={policy.scope}
              onValueChange={(v) => {
                const option = SCOPE_OPTIONS.find((o) => o.value === v);
                if (option && option.value !== policy.scope) void change({ scope: option.value });
              }}
              disabled={save.isPending}
            >
              <SelectTrigger
                aria-labelledby={`${id}-scope`}
                data-testid="pool-scope-claude"
                className="h-11 w-full bg-background sm:h-9"
              />
              <SelectContent>
                {SCOPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-xs leading-relaxed">
              Applies to every Claude account in the pool.
            </span>
          </div>
        ) : null}
      </div>

      <p className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          {STICKY_NOTE}
          {weightedForBots ? ` ${BOTS_WEIGHTED_NOTE}` : null}
          {botsUseApiKey ? ` ${BOTS_API_KEY_NOTE}.` : null}
        </span>
      </p>

      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
      <label
        className="flex cursor-pointer items-start gap-3 rounded-xl border bg-background p-3"
        data-testid={`pool-fallback-${provider}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">
            Use the device's own login when no account is ready
          </span>
          <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
            When it's off, new sessions can't start until an account is ready.
          </span>
        </span>
        <Switch
          checked={policy.fallbackToDeviceLogin}
          onCheckedChange={(fallbackToDeviceLogin) => void change({ fallbackToDeviceLogin })}
          disabled={save.isPending}
          aria-label="Use the device's own login when no account is ready"
          className="mt-0.5"
        />
      </label>
    </div>
  );
}
