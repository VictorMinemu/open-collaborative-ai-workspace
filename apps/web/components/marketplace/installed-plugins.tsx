"use client";

import type { CellPlugin, CellPluginStatus } from "@ocw/contracts";
import { ArrowUpCircle, Puzzle, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useMarketplaceSearch, useUninstallPlugin, useUpdateCellPlugin } from "@/lib/marketplace-queries";
import { cn } from "@/lib/utils";
import { RiskBadge } from "./risk-badge";

type Flag = "orgEnabled" | "personalAllowed" | "trustedChaining";

const FLAGS: Array<{ key: Flag; label: string; hint: string }> = [
  { key: "orgEnabled", label: "Bots can use it", hint: "Off removes its tools from every bot" },
  { key: "personalAllowed", label: "Personal bots", hint: "Members may enable it in their own bot" },
  {
    key: "trustedChaining",
    label: "Trust for chained calls",
    hint: "Its output may lead to tools that change data in the same reply",
  },
];

/**
 * Status of a plugin row in plain words. A failed row that had been installed before is a failed UPDATE: the
 * cell keeps the previous version when the install gate or the install refuses (03.1-12).
 */
export function pluginStatus(p: Pick<CellPlugin, "status" | "installedAt">): {
  label: string;
  variant: "success" | "warning" | "destructive" | "outline";
  busy: boolean;
} {
  const s: CellPluginStatus = p.status;
  if (s === "approved" || s === "installing") {
    return { label: p.installedAt ? "Updating" : "Installing", variant: "warning", busy: true };
  }
  if (s === "installed") return { label: "Installed", variant: "success", busy: false };
  if (s === "failed") {
    return { label: p.installedAt ? "Update failed" : "Install failed", variant: "destructive", busy: false };
  }
  if (s === "uninstalling") return { label: "Uninstalling", variant: "outline", busy: true };
  return { label: "Uninstalled", variant: "outline", busy: false };
}

/** Numeric dotted-version comparison (pre-release tags ignored): > 0 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i] ?? 0) ? 0 : (pa[i] ?? 0);
    const y = Number.isNaN(pb[i] ?? 0) ? 0 : (pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Settings › Marketplace, installed (D-14, BOT-09): every plugin of the organization with its status in the
 * cell, risk, tools, the org / personal-bot / chained-call switches, update to a newer reviewed version and
 * uninstall behind a confirmation. Polling while a change is in flight comes from `useCellPlugins`.
 */
export function InstalledPlugins({
  plugins,
  onReview,
}: {
  plugins: CellPlugin[];
  onReview: (packageName: string, version: string | null) => void;
}) {
  return (
    <section className="grid gap-3" aria-labelledby="installed-plugins-title" data-testid="installed-plugins">
      <div>
        <h2 id="installed-plugins-title" className="font-semibold text-[15px] tracking-tight">
          Installed
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">
          Their tools are off on every bot until someone who manages the bot turns them on.
        </p>
      </div>
      <ul className="grid gap-3">
        {plugins.map((p) => (
          <li key={p.id}>
            <PluginRow plugin={p} onReview={onReview} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PluginRow({
  plugin,
  onReview,
}: {
  plugin: CellPlugin;
  onReview: (packageName: string, version: string | null) => void;
}) {
  const update = useUpdateCellPlugin(plugin.id);
  const uninstall = useUninstallPlugin(plugin.id);
  const [confirm, setConfirm] = useState<"uninstall" | "personal" | null>(null);
  // ClawHub search is cached by the API (10 min); an exact match tells us the latest published version.
  const latest = useMarketplaceSearch(plugin.packageName).data?.entries.find(
    (e) => e.packageName === plugin.packageName,
  )?.latestVersion;
  const status = pluginStatus(plugin);
  const settled = plugin.status === "installed" || plugin.status === "failed";
  const newer = latest && settled && compareVersions(latest, plugin.version) > 0 ? latest : null;
  const locked = plugin.status === "uninstalling";

  async function setFlag(key: Flag, value: boolean, acknowledgeHighRisk = false) {
    if (key === "personalAllowed" && value && plugin.risk === "high" && !acknowledgeHighRisk) {
      setConfirm("personal");
      return;
    }
    try {
      await update.mutateAsync({ [key]: value, ...(acknowledgeHighRisk ? { acknowledgeHighRisk } : {}) });
      setConfirm(null);
    } catch (err) {
      toast.error("Could not change the plugin", { description: errorMessage(err) });
    }
  }

  async function onUninstall() {
    try {
      await uninstall.mutateAsync();
      setConfirm(null);
      toast.success(`Uninstalling ${plugin.packageName}`, {
        description: "Its tools were removed from every bot.",
      });
    } catch (err) {
      toast.error("Could not uninstall the plugin", { description: errorMessage(err) });
    }
  }

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-card shadow-xs",
        plugin.status === "failed" && "border-destructive/30",
      )}
      data-testid="installed-plugin"
      data-package={plugin.packageName}
      data-status={plugin.status}
    >
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          <Puzzle className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate font-semibold text-[15px] tracking-tight">{plugin.packageName}</h3>
            <span className="font-mono text-muted-foreground text-xs">v{plugin.version}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={status.variant} data-testid="plugin-status" data-status={plugin.status}>
              {status.busy ? <Spinner className="size-3" /> : null}
              {status.label}
            </Badge>
            <RiskBadge level={plugin.risk} />
            <Badge variant={plugin.channel === "official" ? "brand" : "outline"}>
              {plugin.channel === "official" ? "Official" : "Community"}
            </Badge>
          </div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          {newer ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReview(plugin.packageName, newer)}
              data-testid="plugin-update-available"
              className="flex-1 sm:flex-none"
            >
              <ArrowUpCircle /> Update to {newer}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirm("uninstall")}
            disabled={locked || uninstall.isPending}
            data-testid="plugin-uninstall"
            className="flex-1 hover:bg-destructive/10 hover:text-destructive sm:flex-none"
          >
            <Trash2 /> Uninstall
          </Button>
        </div>
      </div>

      {plugin.status === "failed" && plugin.statusDetail ? (
        <p
          className="mx-4 -mt-1 mb-3 rounded-lg bg-destructive/8 px-3 py-2 text-[13px] leading-snug"
          data-testid="plugin-status-detail"
        >
          {plugin.installedAt
            ? `Version ${plugin.version} could not be installed; the previous version may still be running. `
            : ""}
          <span className="text-muted-foreground">{plugin.statusDetail}</span>
        </p>
      ) : null}

      <div className="grid gap-3 border-t bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-tools">
          <span className="mr-1 text-muted-foreground text-xs">
            {plugin.tools.length === 0
              ? status.busy
                ? "Tools appear once it is installed"
                : "No tools"
              : `${plugin.tools.length} ${plugin.tools.length === 1 ? "tool" : "tools"}`}
          </span>
          {plugin.tools.map((t) => (
            <span
              key={t.name}
              className="max-w-full truncate rounded-md border bg-background px-2 py-0.5 font-mono text-xs"
              title={t.description ?? t.name}
            >
              {t.name}
            </span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {FLAGS.map((f) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
            <label
              key={f.key}
              className={cn(
                "flex cursor-pointer items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2",
                locked && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="min-w-0">
                <span className="block font-medium text-[13px]">{f.label}</span>
                <span className="block text-[11.5px] text-muted-foreground leading-snug">{f.hint}</span>
              </span>
              <Switch
                checked={plugin[f.key]}
                onCheckedChange={(v) => void setFlag(f.key, v)}
                disabled={locked || update.isPending}
                aria-label={`${f.label}: ${plugin.packageName}`}
                data-testid={`plugin-flag-${f.key}`}
              />
            </label>
          ))}
        </div>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent data-testid="plugin-confirm">
          {confirm === "uninstall" ? (
            <>
              <DialogHeader>
                <DialogTitle>Uninstall {plugin.packageName}?</DialogTitle>
                <DialogDescription>
                  {plugin.tools.length > 0
                    ? `Its ${plugin.tools.length === 1 ? "tool is" : `${plugin.tools.length} tools are`} removed from every bot right away, then the plugin is removed from your bots' runtime.`
                    : "The plugin is removed from your bots' runtime."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={onUninstall}
                  disabled={uninstall.isPending}
                  data-testid="plugin-uninstall-confirm"
                >
                  {uninstall.isPending ? <Spinner /> : <Trash2 />}
                  Uninstall
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Allow a high-risk plugin for personal bots?</DialogTitle>
                <DialogDescription>
                  Every member could turn on its tools in their private assistant. Reasons:{" "}
                  {plugin.riskReasons.map((r) => r.message).join("; ") || "high risk"}.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void setFlag("personalAllowed", true, true)}
                  disabled={update.isPending}
                  data-testid="plugin-personal-confirm"
                >
                  {update.isPending ? <Spinner /> : null}
                  Allow anyway
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </article>
  );
}
