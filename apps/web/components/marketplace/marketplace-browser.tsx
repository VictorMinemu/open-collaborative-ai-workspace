"use client";

import type { MarketplaceEntry } from "@ocw/contracts";
import {
  BadgeCheck,
  CloudOff,
  Download,
  History,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldQuestion,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useMarketplaceSearch } from "@/lib/marketplace-queries";
import { cn } from "@/lib/utils";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** ClawHub's scan state in two words; anything not clean reads as a warning. */
export function scanLabel(status: string | null): { text: string; ok: boolean } {
  if (!status) return { text: "Not scanned", ok: false };
  if (status === "clean") return { text: "Scan clean", ok: true };
  return { text: `Scan ${status.replaceAll("_", " ")}`, ok: false };
}

/**
 * Settings › Marketplace, browse (D-14): ClawHub search through the API (debounced, cached server-side). Cards
 * show who publishes the plugin, its channel, downloads and scan state; risk is decided per version, so it
 * appears in the review. Third-party text is rendered as plain text only.
 */
export function MarketplaceBrowser({ onOpen }: { onOpen: (packageName: string) => void }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);
  const search = useMarketplaceSearch(q);
  const entries = search.data?.entries ?? [];

  return (
    <section
      className="grid gap-3"
      aria-labelledby="marketplace-browse-title"
      data-testid="marketplace-browser"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="marketplace-browse-title" className="font-semibold text-[15px] tracking-tight">
            Browse ClawHub
          </h2>
          <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
            Plugins add tools to your bots. Every version is scored for risk before anyone can install it.
          </p>
        </div>
      </div>

      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          data-testid="marketplace-search"
          className="h-10 pr-9 pl-9"
          maxLength={100}
        />
        {search.isFetching && !search.isPending ? (
          <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
        ) : null}
      </div>

      {search.data?.source === "cache" ? (
        // The API's cache: fresh for 10 minutes, or kept while ClawHub is unreachable. Reviews always ask ClawHub.
        <p
          className="-mt-1 flex items-center gap-1.5 text-muted-foreground text-xs"
          data-testid="marketplace-cached"
        >
          <History className="size-3.5 shrink-0" aria-hidden />
          Saved results from ClawHub. Opening a plugin always checks the latest review.
        </p>
      ) : null}

      {search.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : search.isError ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center"
          data-testid="marketplace-unavailable"
        >
          <CloudOff className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium text-sm">
              {isApiError(search.error, 503) ? "ClawHub is unreachable" : "Couldn't load the marketplace"}
            </p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              {isApiError(search.error, 503)
                ? "The marketplace is offline for now. Installed plugins keep working."
                : errorMessage(search.error)}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void search.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
          {q ? `No plugins match “${q}”.` : "ClawHub has no plugins to show."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Plugins">
          {entries.map((e) => (
            <li key={e.packageName}>
              <EntryCard entry={e} onOpen={() => onOpen(e.packageName)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EntryCard({ entry, onOpen }: { entry: MarketplaceEntry; onOpen: () => void }) {
  // Search results often carry no scan state: then the review (per version) is where it shows.
  const scan = entry.scanStatus ? scanLabel(entry.scanStatus) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="marketplace-entry"
      data-package={entry.packageName}
      className="group flex h-full w-full flex-col gap-2.5 rounded-xl border bg-card p-4 text-left shadow-xs outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate font-semibold text-[15px] tracking-tight">{entry.displayName}</span>
          <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
            {entry.packageName}
          </span>
        </span>
        <EntryState entry={entry} />
      </div>
      {entry.summary ? (
        <span className="line-clamp-2 text-muted-foreground text-sm leading-snug">{entry.summary}</span>
      ) : null}
      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
        <span className="inline-flex min-w-0 items-center gap-1">
          {entry.publisherOfficial ? (
            <BadgeCheck className="size-3.5 shrink-0 text-primary" aria-label="Official publisher" />
          ) : null}
          <span className="truncate">{entry.publisher}</span>
        </span>
        <Badge variant={entry.channel === "official" ? "brand" : "outline"}>
          {entry.channel === "official" ? "Official" : "Community"}
        </Badge>
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Download className="size-3.5" aria-hidden />
          {compact.format(entry.downloads)}
        </span>
        {scan ? (
          <span className={cn("inline-flex items-center gap-1", !scan.ok && "text-warning")}>
            {scan.ok ? null : <ShieldQuestion className="size-3.5" aria-hidden />}
            {scan.text}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function EntryState({ entry }: { entry: MarketplaceEntry }) {
  if (entry.bundled) {
    return (
      <Badge variant="secondary" data-testid="entry-bundled">
        <PackageCheck aria-hidden /> Built in
      </Badge>
    );
  }
  if (!entry.installed) return null;
  const busy = entry.installed.status === "installing" || entry.installed.status === "approved";
  const failed = entry.installed.status === "failed";
  return (
    <Badge variant={failed ? "destructive" : busy ? "warning" : "success"} data-testid="entry-installed">
      {busy ? "Installing" : failed ? "Failed" : "Installed"} v{entry.installed.version}
    </Badge>
  );
}
