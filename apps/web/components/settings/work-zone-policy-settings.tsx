"use client";

import type { WorkZonePolicyView } from "@ocw/contracts";
import { RotateCcw, Save, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useCan, usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useUpdateWorkZonePolicy, useWorkZonePolicy } from "@/lib/workzone-policy-queries";

type Draft = Omit<WorkZonePolicyView, "updatedAt" | "knownModels">;

const toDraft = ({ updatedAt: _u, knownModels: _k, ...rest }: WorkZonePolicyView): Draft => rest;
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** ADR-0012: the organization switch is only one of the three conditions Full access needs. */
const FULL_ACCESS_LEGS = [
  { label: "Organization policy", note: "This switch" },
  { label: "Device owner", note: "Enables it on the device" },
  { label: "Member", note: "Has Full access on that device" },
];

/**
 * Settings › Work Zone policy (Phase 03.2, D-02, D-11; WZC-03/04): what every Work Zone session of the
 * organization may use. One Save; the API stores, audits and enforces it on every turn. Admins only
 * (`work_zone.manage`).
 */
export function WorkZonePolicySettings() {
  const permissions = usePermissions();
  const canManage = useCan("work_zone.manage");
  const policy = useWorkZonePolicy(canManage);

  if (!canManage) {
    return permissions.isPending ? (
      <Skeleton className="h-40 rounded-2xl" />
    ) : (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        Only workspace admins can change the Work Zone policy.
      </div>
    );
  }
  if (policy.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }
  if (policy.isError) {
    return (
      <div className="rounded-xl border bg-card">
        <ServerUnreachable onRetry={() => policy.refetch()} retrying={policy.isFetching} />
      </div>
    );
  }
  return <PolicyForm policy={policy.data} />;
}

function PolicyForm({ policy }: { policy: WorkZonePolicyView }) {
  const save = useUpdateWorkZonePolicy();
  const saved = toDraft(policy);
  const [draft, setDraft] = useState<Draft>(saved);
  const dirty = !same(draft, saved);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function submit() {
    try {
      const updated = await save.mutateAsync(draft);
      setDraft(toDraft(updated));
      toast.success("Work Zone policy saved", {
        description: "Every Work Zone session follows it from its next turn.",
      });
    } catch (err) {
      toast.error("Could not save the Work Zone policy", { description: errorMessage(err) });
    }
  }

  return (
    <div className="grid gap-8" data-testid="work-zone-policy-settings">
      <Section
        title="Full access"
        description="The riskiest mode: the coding agent edits files and runs commands without asking anyone."
      >
        <div
          className={cn(
            "grid gap-4 rounded-2xl border bg-card p-4 shadow-xs transition-colors",
            draft.allowFullAccess && "border-warning/50 bg-warning/5",
          )}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
          <label className="flex cursor-pointer items-start gap-3">
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
                draft.allowFullAccess && "border-warning/50 text-warning",
              )}
            >
              <ShieldAlert className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-sm">Allow Full access</span>
              <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
                Runs Claude Code and Codex in their bypass mode, with no approval prompts. It also needs the
                device owner to enable it on the device and the member to have Full access on that device.
              </span>
            </span>
            <Switch
              checked={draft.allowFullAccess}
              onCheckedChange={(allowFullAccess) => setDraft((d) => ({ ...d, allowFullAccess }))}
              aria-label="Allow Full access"
              data-testid="allow-full-access"
              className="mt-1"
            />
          </label>
          <ol className="ml-11 grid gap-1.5 sm:grid-cols-3" aria-label="Full access needs all three">
            {FULL_ACCESS_LEGS.map((leg, i) => (
              <li
                key={leg.label}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5",
                  i === 0 && draft.allowFullAccess && "border-warning/50",
                )}
              >
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground tabular-nums"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-xs">{leg.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{leg.note}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <span className="mr-auto text-muted-foreground text-xs" aria-live="polite">
          {dirty ? "Unsaved changes" : policy.updatedAt ? "All changes saved" : "Defaults: Full access off"}
        </span>
        <Button variant="outline" onClick={() => setDraft(saved)} disabled={!dirty || save.isPending}>
          <RotateCcw /> Discard
        </Button>
        <Button onClick={submit} disabled={!dirty || save.isPending} data-testid="save-policy">
          {save.isPending ? <Spinner /> : <Save />}
          Save policy
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}
