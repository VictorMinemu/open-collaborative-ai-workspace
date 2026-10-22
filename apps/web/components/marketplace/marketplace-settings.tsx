"use client";

import Link from "next/link";
import { useState } from "react";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Skeleton } from "@/components/ui/skeleton";
import { useCellPlugins } from "@/lib/marketplace-queries";
import { useCan, usePermissions } from "@/lib/permissions";
import { InstalledPlugins } from "./installed-plugins";
import { MarketplaceBrowser } from "./marketplace-browser";
import { PluginReviewSheet } from "./plugin-review-sheet";

/**
 * Settings › Marketplace (D-14, SC7, BOT-09): what the organization installed, then ClawHub. Opening a plugin
 * (from either list) shows its review sheet. Organization Admins only (`plugin.manage`); everyone else gets
 * the ask-an-admin state, and the API refuses every route anyway.
 */
export function MarketplaceSettings() {
  const permissions = usePermissions();
  const canManage = useCan("plugin.manage");
  const installed = useCellPlugins(canManage);
  const [open, setOpen] = useState<{ name: string; version: string | null } | null>(null);

  if (!canManage) {
    return (
      <Shell>
        {permissions.isPending ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (
          <div
            className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm"
            data-testid="marketplace-admin-only"
          >
            Only workspace admins can install marketplace plugins. Ask an admin if your bots need one.
          </div>
        )}
      </Shell>
    );
  }

  const plugins = installed.data?.plugins ?? [];
  const row = open ? (plugins.find((p) => p.packageName === open.name) ?? null) : null;

  return (
    <Shell>
      <SandboxPackagesPointer />

      {installed.isPending ? (
        <Skeleton className="h-36 rounded-2xl" />
      ) : installed.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => installed.refetch()} retrying={installed.isFetching} />
        </div>
      ) : plugins.length > 0 ? (
        <InstalledPlugins plugins={plugins} onReview={(name, version) => setOpen({ name, version })} />
      ) : null}

      <MarketplaceBrowser onOpen={(name) => setOpen({ name, version: null })} />

      <PluginReviewSheet
        packageName={open?.name ?? null}
        initialVersion={open?.version ?? null}
        installed={row}
        onOpenChange={(o) => !o && setOpen(null)}
      />
    </Shell>
  );
}

/** R12: tools that run commands, files or a browser belong in a bot's sandbox, as sandbox packages (07.8-23). */
function SandboxPackagesPointer() {
  return (
    <p className="-mb-6 text-muted-foreground text-xs" data-testid="marketplace-sandbox-pointer">
      Packages for bot sandboxes are in{" "}
      <Link href="/settings/sandbox" className="font-medium text-foreground underline underline-offset-2">
        Settings › Sandbox &amp; Browser
      </Link>
      .
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid w-full max-w-5xl gap-10 px-4 py-6 sm:px-6 sm:py-8">{children}</div>;
}
