"use client";

import type { CellPlugin, DeclaredSurface, MarketplacePackageDetail, RiskLevel } from "@ocw/contracts";
import {
  BadgeCheck,
  Ban,
  CircleAlert,
  Download,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, isApiError } from "@/lib/api";
import { useApprovePluginInstall, usePluginDetail, useUpdateCellPlugin } from "@/lib/marketplace-queries";
import { cn, formatDate } from "@/lib/utils";
import { scanLabel } from "./marketplace-browser";
import { RISK, RiskBadge } from "./risk-badge";

/** Typed by the admin before a high-risk version can be installed or allowed for personal bots. */
export const ACK_PHRASE = "install anyway";

const RISK_COPY: Record<RiskLevel, { title: string; lead: string; tone: string; icon: string }> = {
  low: {
    title: "Low risk",
    lead: "Nothing in this version needs extra attention.",
    tone: "border-success/30 bg-success/[0.06]",
    icon: "bg-success/15 text-success",
  },
  medium: {
    title: "Medium risk",
    lead: "Check the reasons below before you install it.",
    tone: "border-warning/35 bg-warning/[0.07]",
    icon: "bg-warning/15 text-warning",
  },
  high: {
    title: "High risk",
    lead: "Review every reason. Installing it needs your explicit confirmation.",
    tone: "border-destructive/35 bg-destructive/[0.06]",
    icon: "bg-destructive/12 text-destructive",
  },
  refuse: {
    title: "Blocked",
    lead: "This version can't be installed in this workspace.",
    tone: "border-destructive/50 bg-destructive/[0.09]",
    icon: "bg-destructive text-white",
  },
};

/**
 * Review of one pinned plugin version (D-14, SC7): publisher, channel, version, verification and scan state,
 * what it declares and the API's risk with every reason, most prominent first. Install (or update) sends the
 * review token back; the API re-reads ClawHub and refuses anything that changed. High risk needs the typed
 * acknowledgement; Blocked versions have no action at all; bundled plugins have nothing to install.
 */
export function PluginReviewSheet({
  packageName,
  initialVersion = null,
  installed,
  onOpenChange,
}: {
  packageName: string | null;
  initialVersion?: string | null;
  /** This organization's active row of the package, if any. */
  installed: CellPlugin | null;
  onOpenChange: (open: boolean) => void;
}) {
  // A version picked in this sheet applies only to the package (and starting version) it was picked for.
  const openKey = `${packageName ?? ""}|${initialVersion ?? ""}`;
  const [picked, setPicked] = useState<{ key: string; version: string } | null>(null);
  const version = picked?.key === openKey ? picked.version : initialVersion;
  const detail = usePluginDetail(packageName, version);
  const data = detail.data && detail.data.entry.packageName === packageName ? detail.data : null;

  return (
    <Sheet open={packageName !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-full sm:w-[34rem]"
        data-testid="plugin-review-sheet"
        data-package={packageName ?? undefined}
      >
        {data ? (
          <Review
            key={`${data.entry.packageName}@${data.review.version}`}
            detail={data}
            installed={installed}
            loadingVersion={detail.isFetching && version !== null && version !== data.review.version}
            onVersion={(v) => setPicked({ key: openKey, version: v })}
            onRefresh={() => void detail.refetch()}
            onDone={() => onOpenChange(false)}
          />
        ) : detail.isError ? (
          <div className="grid gap-3 px-5 py-6 pr-14">
            <SheetTitle>{packageName}</SheetTitle>
            <p className="text-muted-foreground text-sm" role="alert">
              {isApiError(detail.error, 503)
                ? "ClawHub is unreachable, so this plugin can't be reviewed right now."
                : errorMessage(detail.error)}
            </p>
            <Button variant="outline" className="w-fit" onClick={() => void detail.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 px-5 py-6 pr-14" aria-busy>
            <SheetTitle className="sr-only">Loading plugin</SheetTitle>
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Review({
  detail,
  installed,
  loadingVersion,
  onVersion,
  onRefresh,
  onDone,
}: {
  detail: MarketplacePackageDetail;
  installed: CellPlugin | null;
  loadingVersion: boolean;
  onVersion: (v: string) => void;
  onRefresh: () => void;
  onDone: () => void;
}) {
  const { entry, review, versions } = detail;
  const approve = useApprovePluginInstall();
  const update = useUpdateCellPlugin(installed?.id ?? "");
  const [ack, setAck] = useState("");
  const [personal, setPersonal] = useState(false);
  const ackId = useId();
  const high = review.risk === "high";
  const acknowledged = ack.trim().toLowerCase() === ACK_PHRASE;
  const busy = approve.isPending || update.isPending;

  const sameVersion = installed?.version === review.version;
  const canUpgrade = installed ? installed.status === "installed" || installed.status === "failed" : false;
  const mode: "bundled" | "blocked" | "current" | "update" | "install" = entry.bundled
    ? "bundled"
    : review.risk === "refuse"
      ? "blocked"
      : installed
        ? sameVersion
          ? "current"
          : "update"
        : "install";

  async function submit() {
    if (high && !acknowledged) return;
    try {
      if (mode === "install") {
        await approve.mutateAsync({
          packageName: review.packageName,
          version: review.version,
          reviewToken: review.reviewToken,
          acknowledgeHighRisk: high,
          personalAllowed: personal,
        });
        toast.success(`Installing ${entry.displayName} ${review.version}`, {
          description: "Your bots' runtime is installing it. Its tools appear in each bot's settings.",
        });
      } else if (mode === "update" && installed) {
        await update.mutateAsync({
          upgrade: { version: review.version, reviewToken: review.reviewToken },
          ...(high ? { acknowledgeHighRisk: true } : {}),
        });
        toast.success(`Updating ${entry.displayName} to ${review.version}`);
      }
      onDone();
    } catch (err) {
      if (isApiError(err) && err.code === "review_changed") {
        toast.error("This version changed on ClawHub", {
          description: "The review was refreshed. Check it again before installing.",
        });
        onRefresh();
        return;
      }
      toast.error(mode === "update" ? "Could not update the plugin" : "Could not install the plugin", {
        description: errorMessage(err),
      });
    }
  }

  const latest = versions[0]?.version ?? entry.latestVersion;
  const versionItems = versions.map((v) => ({
    value: v.version,
    label: `${v.version}${v.version === latest ? " · latest" : ""}${v.version === installed?.version ? " · installed" : ""}`,
  }));

  return (
    <>
      {/* ---- header */}
      <div className="flex items-start gap-3 border-b px-5 py-4 pr-14">
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-lg leading-snug tracking-tight">
            {entry.displayName}
          </SheetTitle>
          <p className="truncate font-mono text-muted-foreground text-xs">{entry.packageName}</p>
          <SheetDescription
            render={<div />}
            className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs"
          >
            <RiskBadge level={review.risk} />
            <span
              className="inline-flex items-center gap-1 font-medium text-foreground"
              data-testid="plugin-publisher"
            >
              {entry.publisherOfficial ? (
                <BadgeCheck className="size-3.5 text-primary" aria-label="Official publisher" />
              ) : null}
              {review.publisher}
            </span>
            <Badge variant={review.channel === "official" ? "brand" : "outline"} data-testid="plugin-channel">
              {review.channel === "official" ? "Official" : "Community"}
            </Badge>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Download className="size-3.5" aria-hidden />
              {entry.downloads.toLocaleString("en")} downloads
            </span>
          </SheetDescription>
        </div>
      </div>

      {/* ---- body */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 px-5 py-5">
          {entry.summary ? <p className="text-sm leading-relaxed">{entry.summary}</p> : null}

          <div className="grid gap-1.5">
            <span className="font-medium text-muted-foreground text-xs">Version</span>
            <div className="flex items-center gap-2">
              <Select
                items={versionItems}
                value={review.version}
                onValueChange={(v) => v && v !== review.version && onVersion(String(v))}
              >
                <SelectTrigger
                  aria-label="Version"
                  data-testid="plugin-version"
                  className="w-full font-mono text-[13px] sm:w-64"
                />
                <SelectContent>
                  {versionItems.map((v) => (
                    <SelectItem key={v.value} value={v.value} className="font-mono text-[13px]">
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loadingVersion ? <Spinner className="text-muted-foreground" /> : null}
            </div>
            {review.publishedAt ? (
              <span className="text-muted-foreground text-xs">
                Published {formatDate(review.publishedAt)}
              </span>
            ) : null}
          </div>

          <RiskPanel level={review.risk} reasons={review.riskReasons} />

          <Group title="What it adds to your bots">
            <Surface declared={review.declared} />
          </Group>

          <Group title="Verification and scan">
            <dl className="grid gap-x-4 gap-y-2.5 rounded-xl border bg-card p-3.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
              <Fact label="Verification" testId="plugin-verification">
                {review.verification.tier ? review.verification.tier.replaceAll("-", " ") : "Unverified"}
                {review.verification.hasProvenance ? " · with provenance" : ""}
              </Fact>
              {review.verification.sourceRepo ? (
                <Fact label="Source">
                  <span className="break-all font-mono text-xs">
                    {review.verification.sourceRepo}
                    {review.verification.sourceCommit
                      ? `@${review.verification.sourceCommit.slice(0, 7)}`
                      : ""}
                  </span>
                </Fact>
              ) : null}
              <Fact label="Scan" testId="plugin-scan">
                <ScanValue review={detail.review} />
              </Fact>
              <Fact label="Compatibility">
                {review.compatibility.compatible ? (
                  "Works with this workspace's runtime"
                ) : (
                  <span className="text-destructive">Not compatible with this workspace's runtime</span>
                )}
              </Fact>
              <Fact label="Digest">
                {review.artifact.sha256 ? (
                  <span className="break-all font-mono text-xs" title={review.artifact.sha256}>
                    sha256:{review.artifact.sha256.slice(0, 16)}…
                  </span>
                ) : (
                  <span className="text-destructive">Not published</span>
                )}
              </Fact>
            </dl>
          </Group>

          {mode === "install" || mode === "update" ? (
            <div className="grid gap-3">
              <p
                className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-[13px] leading-snug"
                data-testid="plugin-trust-note"
              >
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                Plugins run inside your bots' runtime. Only install plugins you trust.
              </p>

              {high ? (
                <div className="grid gap-1.5">
                  <label htmlFor={ackId} className="font-medium text-sm">
                    Type <span className="font-mono text-destructive">{ACK_PHRASE}</span> to confirm
                  </label>
                  <Input
                    id={ackId}
                    value={ack}
                    onChange={(e) => setAck(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="ack-high-risk"
                    aria-describedby={`${ackId}-hint`}
                    className="font-mono text-[13px]"
                  />
                  <span id={`${ackId}-hint`} className="text-muted-foreground text-xs">
                    You accept the risks listed above for every bot that gets its tools.
                  </span>
                </div>
              ) : null}

              {mode === "install" ? (
                // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
                <label
                  className={cn(
                    "flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5",
                    high && !acknowledged && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-sm">Allow for personal bots</span>
                    <span className="block text-muted-foreground text-xs leading-snug">
                      {high && !acknowledged
                        ? "Confirm the risk first"
                        : "Members can turn its tools on in their private assistant"}
                    </span>
                  </span>
                  <Switch
                    checked={personal && (!high || acknowledged)}
                    onCheckedChange={setPersonal}
                    disabled={high && !acknowledged}
                    aria-label="Allow for personal bots"
                    data-testid="plugin-personal"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ---- footer */}
      <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
        {mode === "bundled" ? (
          <p className="mr-auto flex items-center gap-2 text-sm" data-testid="plugin-bundled">
            <PackageCheck className="size-4 text-success" aria-hidden />
            Included with the workspace. Nothing to install.
          </p>
        ) : mode === "blocked" ? (
          <p
            className="mr-auto flex items-center gap-2 font-medium text-destructive text-sm"
            data-testid="plugin-blocked"
          >
            <Ban className="size-4" aria-hidden />
            Blocked: this version can't be installed
          </p>
        ) : mode === "current" ? (
          <p className="mr-auto flex items-center gap-2 text-sm" data-testid="plugin-current">
            <ShieldCheck className="size-4 text-success" aria-hidden />
            This version is{" "}
            {installed?.status === "installed" ? "installed" : (installed?.status ?? "installed")}.
          </p>
        ) : (
          <>
            <Button variant="outline" onClick={onDone} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                busy || loadingVersion || (high && !acknowledged) || (mode === "update" && !canUpgrade)
              }
              variant={high ? "destructive" : "default"}
              data-testid={mode === "update" ? "plugin-update" : "plugin-install"}
            >
              {busy ? <Spinner /> : null}
              {mode === "update"
                ? canUpgrade
                  ? `Update to ${review.version}`
                  : "Wait for the current change"
                : `Install ${review.version}`}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function RiskPanel({
  level,
  reasons,
}: {
  level: RiskLevel;
  reasons: Array<{ code: string; message: string }>;
}) {
  const copy = RISK_COPY[level];
  const Icon = RISK[level].icon;
  return (
    <section
      className={cn("grid gap-3 rounded-xl border p-4", copy.tone)}
      data-testid="plugin-risk"
      data-risk={level}
      aria-label={`Risk: ${copy.title}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", copy.icon)}
          aria-hidden
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-base tracking-tight">{copy.title}</h3>
          <p className="text-[13px] text-foreground/80 leading-snug">{copy.lead}</p>
        </div>
      </div>
      {reasons.length > 0 ? (
        <ul className="grid gap-1.5" aria-label="Risk reasons">
          {reasons.map((r) => (
            <li
              key={r.code}
              className="flex items-start gap-2 rounded-lg bg-background/70 px-2.5 py-2 text-[13px] leading-snug"
              data-testid="risk-reason"
              data-code={r.code}
            >
              {level === "refuse" || level === "high" ? (
                <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
              ) : (
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              )}
              <span>{r.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const SURFACE_GROUPS: Array<{ label: string; pick: (d: DeclaredSurface) => string[] }> = [
  { label: "Tools", pick: (d) => d.tools },
  { label: "Hooks", pick: (d) => d.hooks },
  {
    label: "Providers",
    pick: (d) => [
      ...d.providers,
      ...d.webSearchProviders.map((p) => `web search: ${p}`),
      ...d.webFetchProviders.map((p) => `web fetch: ${p}`),
    ],
  },
  { label: "Channels", pick: (d) => d.channels },
  { label: "MCP servers", pick: (d) => d.mcpServers },
  { label: "Other", pick: (d) => d.other },
];

function Surface({ declared }: { declared: DeclaredSurface }) {
  const groups = SURFACE_GROUPS.map((g) => ({ label: g.label, items: g.pick(declared) })).filter(
    (g) => g.items.length > 0,
  );
  if (groups.length === 0) {
    return <p className="text-muted-foreground text-sm">Declares no tools, hooks or providers.</p>;
  }
  return (
    <div className="grid gap-3 rounded-xl border bg-card p-3.5" data-testid="plugin-surface">
      {groups.map((g) => (
        <div
          key={g.label}
          className="grid gap-1.5"
          data-testid={`surface-${g.label.toLowerCase().replaceAll(" ", "-")}`}
        >
          <span className="font-medium text-muted-foreground text-xs">
            {g.label} <span className="tabular-nums">({g.items.length})</span>
          </span>
          <ul className="flex flex-wrap gap-1.5">
            {g.items.map((item) => (
              <li
                key={item}
                className="max-w-full truncate rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-xs"
                title={item}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ScanValue({ review }: { review: MarketplacePackageDetail["review"] }) {
  const s = scanLabel(review.scan.status);
  return (
    <span className="grid gap-1">
      <span className={cn("inline-flex items-center gap-1.5", !s.ok && "text-warning")}>
        {s.ok ? <ShieldCheck className="size-3.5 text-success" aria-hidden /> : null}
        {review.scan.blockedFromDownload
          ? "Blocked from download"
          : review.scan.pending
            ? "Scan pending"
            : s.text}
      </span>
      {review.scan.reasons.length > 0 ? (
        <span className="text-muted-foreground text-xs">{review.scan.reasons.join(" · ")}</span>
      ) : null}
    </span>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-muted-foreground text-xs sm:pt-px sm:text-[13px]">{label}</dt>
      <dd className="-mt-1.5 min-w-0 sm:mt-0" data-testid={testId}>
        {children}
      </dd>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="font-semibold text-sm tracking-tight">{title}</h3>
      {children}
    </section>
  );
}
