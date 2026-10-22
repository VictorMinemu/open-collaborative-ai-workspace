"use client";

import type { SandboxSettingsView } from "@ocw/contracts";
import { Container, RefreshCw } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, isApiError } from "@/lib/api";
import { usePermissions } from "@/lib/permissions";
import {
  isVersionConflict,
  type SandboxSettingsPatch,
  useKillSwitch,
  useSandboxSettings,
  useUpdateSandboxSettings,
} from "@/lib/sandbox-settings-queries";
import { cn } from "@/lib/utils";
import { EgressForm } from "./egress-form";
import { IsolationCard, unavailableReason } from "./isolation-card";
import { KillSwitchBanner, KillSwitchCard } from "./kill-switch-card";
import { CONFLICT_NOTICE, LimitsForm, type SaveResult } from "./limits-form";
import { OrgSwitchCard } from "./org-switch-card";
import { SandboxPackages } from "./sandbox-packages";

/**
 * Settings › Sandbox & Browser (07.8-19; SBX-03, SBX-05, BRW-04, D-09, D-11, D-12, UI-SPEC §4.2-4.3): top to bottom the
 * kill-switch banner (only when engaged), the organization switch, the isolation in use, Limits, Network and Stop
 * everything. The page decides nothing: the nav entry and the page come from `bot.manage` as the API resolves it, the
 * API answers 403 to anyone else, and every state shown is the API's view. Sandbox packages (07.8-23) sit between
 * Network and Stop everything; managing them needs `plugin.manage` too (read-only otherwise).
 */

type Section = "limits" | "network";

export function SandboxSettings() {
  const permissions = usePermissions();
  const canManage = permissions.data?.permissions.includes("bot.manage") ?? false;
  const q = useSandboxSettings(canManage);

  if (permissions.isPending || (canManage && q.isPending)) return <LoadingState />;
  if (!canManage || isApiError(q.error, 403)) return <NoPermission />;
  if (q.isError || !q.data) {
    const network = !isApiError(q.error) || q.error.isNetwork;
    return (
      <Body>
        <div className="rounded-xl border bg-card">
          {network ? (
            <ServerUnreachable onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : (
            <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-sm">Couldn't load sandbox settings.</p>
              <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
                <RefreshCw className={cn(q.isFetching && "animate-spin")} />
                Try again
              </Button>
            </div>
          )}
        </div>
      </Body>
    );
  }
  return <SettingsBody view={q.data} />;
}

function SettingsBody({ view }: { view: SandboxSettingsView }) {
  const update = useUpdateSandboxSettings();
  const kill = useKillSwitch();
  const [saving, setSaving] = useState<Section | "switch" | null>(null);
  const [notice, setNotice] = useState<Section | null>(null);
  const { settings, isolation } = view;
  const down = unavailableReason(isolation);

  async function save(section: Section | "switch", patch: SandboxSettingsPatch): Promise<SaveResult> {
    setSaving(section);
    setNotice(null);
    try {
      await update.mutateAsync(patch);
      return { kind: "saved" };
    } catch (err) {
      if (isVersionConflict(err)) {
        if (section !== "switch") setNotice(section);
        else toast.error(CONFLICT_NOTICE);
        return { kind: "conflict" };
      }
      return { kind: "error", message: errorMessage(err) };
    } finally {
      setSaving(null);
    }
  }

  async function setEnabled(enabled: boolean): Promise<boolean> {
    const res = await save("switch", { enabled });
    if (res.kind === "saved") {
      toast.success(
        enabled
          ? "Sandbox & Browser is on for the organization"
          : "Sandbox & Browser is off for the organization",
      );
      return true;
    }
    if (res.kind === "error") toast.error("Could not change Sandbox & Browser", { description: res.message });
    return false;
  }

  async function stopEverything(): Promise<boolean> {
    try {
      await kill.mutateAsync("kill");
      return true;
    } catch (err) {
      toast.error("Could not stop sandboxes and browsers", { description: errorMessage(err) });
      return false;
    }
  }

  function resume() {
    kill.mutate("resume", {
      onSuccess: () => toast.success("Sandboxes and browsers are back on"),
      onError: (err) => toast.error("Could not resume", { description: errorMessage(err) }),
    });
  }

  return (
    <Body>
      <div className="grid gap-10" data-testid="sandbox-settings">
        {settings.killed ? (
          <KillSwitchBanner killed={settings.killed} pending={kill.isPending} onResume={resume} />
        ) : null}

        <OrgSwitchCard
          enabled={settings.enabled}
          isolation={isolation}
          pending={saving === "switch"}
          onChange={setEnabled}
        />

        <Section title="Isolation">
          <IsolationCard isolation={isolation} />
        </Section>

        <Section title="Limits" description="Shared by every bot in the organization.">
          <LimitsForm
            // A save from elsewhere (another admin, a 409) that changed these values starts the form again.
            key={JSON.stringify(settings.limits)}
            view={view}
            disabledReason={down}
            notice={notice === "limits" ? CONFLICT_NOTICE : null}
            pending={saving === "limits"}
            onEdit={() => setNotice((n) => (n === "limits" ? null : n))}
            onSave={async (limits) => {
              const res = await save("limits", { limits });
              if (res.kind === "saved") toast.success("Limits saved");
              return res;
            }}
          />
        </Section>

        <Section title="Network" description="Where sandboxes and browsers can connect.">
          <EgressForm
            key={JSON.stringify([settings.browserEgress, settings.sandboxEgress, settings.allowHosts])}
            settings={settings}
            disabledReason={down}
            notice={notice === "network" ? CONFLICT_NOTICE : null}
            pending={saving === "network"}
            onEdit={() => setNotice((n) => (n === "network" ? null : n))}
            onSave={async (draft) => {
              const res = await save("network", draft);
              if (res.kind === "saved") toast.success("Network rules saved");
              return res;
            }}
          />
        </Section>

        <SandboxPackages />

        <Section title="Stop everything">
          <KillSwitchCard
            killed={settings.killed}
            running={isolation.running}
            pending={kill.isPending}
            onKill={stopEverything}
            onResume={resume}
          />
        </Section>
      </div>
    </Body>
  );
}

/** The settings container (= Keychain, Connections). */
function Body({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3" aria-label={title}>
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function LoadingState() {
  return (
    <Body>
      <div className="grid gap-10" aria-busy data-testid="sandbox-settings-loading">
        <Skeleton className="h-20 rounded-xl motion-reduce:animate-none" />
        <div className="grid gap-3">
          <Skeleton className="h-5 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-20 rounded-xl motion-reduce:animate-none" />
        </div>
        <div className="grid gap-3">
          <Skeleton className="h-5 w-24 motion-reduce:animate-none" />
          <Skeleton className="h-64 rounded-xl motion-reduce:animate-none" />
        </div>
      </div>
    </Body>
  );
}

function NoPermission() {
  return (
    <EmptyState
      icon={Container}
      title="You can't manage sandboxes"
      description="Only workspace admins decide where bots run commands and browse."
    >
      <Link href="/settings" className={cn(buttonVariants({ variant: "outline" }), "max-md:h-11")}>
        Back to settings
      </Link>
    </EmptyState>
  );
}
