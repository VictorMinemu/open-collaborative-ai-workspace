"use client";

import type { ToolApprovalPolicyPage } from "@ocw/contracts";
import { Globe, Hand, Info, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { buildTree, KindIcon } from "@/components/organization/unit-meta";
import { PageHeader } from "@/components/shell/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api";
import {
  canManageAny,
  type ScopeOption,
  scopeOptions,
  useApprovalPolicyAccess,
  useApprovalPolicyPage,
} from "@/lib/approval-policy-queries";
import { useUnits } from "@/lib/org-queries";
import { cn } from "@/lib/utils";
import { PolicyRuleDialog, type PolicyRuleTarget } from "./policy-rule-dialog";
import { groupHasRule, groupKey, ToolPolicyGroup } from "./tool-policy-group";

/** 44 px controls below 1024 (UI-SPEC: every control in this phase). */
const TOUCH = "max-lg:h-11";

const TITLE = "Approval policies";
const DESCRIPTION = "Decide which bot actions need a person first";

/**
 * Settings › Approval policies (Phase 07.5, D-01, APPROVE-01, UI-SPEC Surface 4, R2-R5): which bot actions need a
 * person first, per tool or per server, and who approves. Admins see the organization and every unit; leads see the
 * units they lead. Everything shown comes from the API's access and page answers; the API decides every write.
 */
export function ApprovalPoliciesSettings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const access = useApprovalPolicyAccess();
  const units = useUnits();
  const options = useMemo(
    () => (access.data ? scopeOptions(access.data, buildTree(units.data?.units ?? []).ordered) : []),
    [access.data, units.data],
  );
  const requested = params.get("scope");
  const selected = options.find((o) => o.value === requested) ?? options[0] ?? null;
  const page = useApprovalPolicyPage(selected?.value ?? null);
  const [search, setSearch] = useState("");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<PolicyRuleTarget | null>(null);
  const [announce, setAnnounce] = useState("");
  const opener = useRef<HTMLElement | null>(null);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const header = <PageHeader title={TITLE} icon={<Hand />} description={DESCRIPTION} />;

  if (access.isPending || (access.data && canManageAny(access.data) && units.isPending)) {
    return (
      <>
        {header}
        <Body>
          <LoadingState />
        </Body>
      </>
    );
  }
  if (access.isError) {
    return (
      <>
        {header}
        <Body>
          <LoadError
            onRetry={() => access.refetch()}
            retrying={access.isFetching}
            network={!isApiError(access.error) || access.error.isNetwork}
          />
        </Body>
      </>
    );
  }
  if (!canManageAny(access.data) || !selected || (page.isError && isApiError(page.error, 403))) {
    return (
      <>
        {header}
        <EmptyState
          icon={Hand}
          title="You can't manage approval policies"
          description="Admins and unit leads decide which bot actions need a person first."
        >
          <Link href="/settings" className={cn(buttonVariants({ variant: "outline" }), TOUCH)}>
            Back to settings
          </Link>
        </EmptyState>
      </>
    );
  }

  const q = search.trim().toLowerCase();

  return (
    <>
      {header}
      <Body>
        <div className="grid gap-6" data-testid="approval-policies">
          <ScopePicker options={options} selected={selected} onPick={(v) => setParam("scope", v)} />

          <div className="flex gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs dark:shadow-none">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>
              When a bot wants to use a tool with a rule, it stops and asks a person. The person sees exactly
              what will be sent and approves it once. Rules add up: a team can ask more often than the
              organization, never less.
            </p>
          </div>

          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              placeholder="Search tools"
              aria-label="Search tools"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn("pl-9", TOUCH)}
              data-testid="policy-search"
            />
          </div>

          {page.isPending ? (
            <GroupSkeletons />
          ) : page.isError ? (
            <LoadError
              onRetry={() => page.refetch()}
              retrying={page.isFetching}
              network={!isApiError(page.error) || page.error.isNetwork}
            />
          ) : (
            <Catalog
              page={page.data}
              query={q}
              rawQuery={search.trim()}
              toggled={toggled}
              onToggle={(key, open) => setToggled((t) => ({ ...t, [key]: open }))}
              showAll={showAll}
              onShowAll={(key) => setShowAll((s) => ({ ...s, [key]: true }))}
              onEdit={(t, el) => {
                opener.current = el;
                setTarget(t);
              }}
            />
          )}

          <div className="grid gap-2 text-muted-foreground text-xs">
            <p>
              Web search, web pages, memory, cards and Work Zone proposals can't use these rules: they have
              their own safeguards.
            </p>
            <p className="flex items-start gap-1.5">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>Every rule change and every decision is recorded in the audit log.</span>
            </p>
          </div>
          <p className="sr-only" aria-live="polite">
            {announce}
          </p>
        </div>
      </Body>
      {page.data ? (
        <PolicyRuleDialog
          target={target}
          page={page.data}
          onClose={() => setTarget(null)}
          onDone={(message) => {
            toast.success(message);
            setAnnounce(message);
            setTarget(null);
          }}
          finalFocus={opener}
          onReload={() => page.refetch()}
        />
      ) : null}
    </>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6 sm:px-6 sm:py-8">{children}</div>
    </div>
  );
}

function ScopePicker({
  options,
  selected,
  onPick,
}: {
  options: readonly ScopeOption[];
  selected: ScopeOption;
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span id="policy-scope-label" className="font-medium text-sm">
        Scope
      </span>
      <Select
        items={options.map((o) => ({ value: o.value, label: o.label }))}
        value={selected.value}
        onValueChange={(v) => v && onPick(String(v))}
      >
        <SelectTrigger
          aria-label="Scope"
          className={cn("w-full sm:w-80", TOUCH)}
          data-testid="policy-scope"
        />
        <SelectContent>
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              style={{ paddingLeft: `${8 + o.depth * 12}px` }}
              className="max-lg:min-h-11"
            >
              <span className="flex min-w-0 items-center gap-2">
                {o.unit ? (
                  <KindIcon kind={o.unit.kind} className="size-5 [&_svg]:size-3" />
                ) : (
                  <span aria-hidden className="flex size-5 items-center justify-center text-muted-foreground">
                    <Globe className="size-3.5" />
                  </span>
                )}
                <span className="truncate">{o.unit ? o.unit.name : o.label}</span>
                {o.unit ? (
                  <span className="text-muted-foreground text-xs">
                    {o.unit.kind.charAt(0).toUpperCase() + o.unit.kind.slice(1)}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Catalog({
  page,
  query,
  rawQuery,
  toggled,
  onToggle,
  showAll,
  onShowAll,
  onEdit,
}: {
  page: ToolApprovalPolicyPage;
  query: string;
  rawQuery: string;
  toggled: Record<string, boolean>;
  onToggle: (key: string, open: boolean) => void;
  showAll: Record<string, boolean>;
  onShowAll: (key: string) => void;
  onEdit: (target: PolicyRuleTarget, opener: HTMLElement) => void;
}) {
  if (page.catalog.length === 0) {
    return (
      <EmptyState
        icon={Hand}
        title="No tools to set up yet"
        description="Add an MCP server or a connector, or approve a plugin, and its tools appear here."
        className="rounded-xl border border-dashed py-12"
      >
        <Link href="/settings/mcp-servers" className={cn(buttonVariants({ variant: "outline" }), TOUCH)}>
          Open MCP servers
        </Link>
      </EmptyState>
    );
  }
  const matches = (g: ToolApprovalPolicyPage["catalog"][number]) =>
    query === "" ||
    g.source.name.toLowerCase().includes(query) ||
    g.tools.some((t) => t.name.toLowerCase().includes(query)) ||
    (g.source.safeName !== null && `all ${g.source.name} tools`.toLowerCase().includes(query));
  const groups = page.catalog.filter(matches);
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        No tools match “{rawQuery}”.
      </p>
    );
  }
  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none">
      {groups.map((g) => {
        const key = groupKey(g);
        // Search expands every group with a match; otherwise groups with a rule start expanded.
        const expanded = query !== "" || (toggled[key] ?? groupHasRule(page, g));
        return (
          <ToolPolicyGroup
            key={key}
            group={g}
            page={page}
            expanded={expanded}
            onToggle={() => onToggle(key, !expanded)}
            query={query}
            showAll={showAll[key] ?? false}
            onShowAll={() => onShowAll(key)}
            onEdit={onEdit}
          />
        );
      })}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-6" aria-busy>
      <Skeleton className="h-9 w-80 max-w-full motion-reduce:animate-none" />
      <Skeleton className="h-20 rounded-xl motion-reduce:animate-none" />
      <GroupSkeletons />
    </div>
  );
}

function GroupSkeletons() {
  return (
    <div className="divide-y rounded-xl border bg-card" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-4">
          <Skeleton className="size-8 rounded-lg motion-reduce:animate-none" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-32 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadError({
  onRetry,
  retrying,
  network,
}: {
  onRetry: () => void;
  retrying: boolean;
  network: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card">
      {network ? (
        <ServerUnreachable onRetry={onRetry} retrying={retrying} />
      ) : (
        <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm">
          <p>Couldn't load approval policies.</p>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying} className={TOUCH}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
