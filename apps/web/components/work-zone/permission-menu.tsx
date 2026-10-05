"use client";

import type { PermissionMode, SessionControls, WorkSession } from "@ocw/contracts";
import { ChevronDown, Lock, LockOpen } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUpdateSessionSettings } from "@/lib/workzone-queries";
import { ControlChip, ControlSurface, SurfaceOption } from "./control-surface";
import { controlReasonText, isShown, PERMISSION_MODES, permissionModeMeta } from "./meta";

/** The mode the session is set to: the requested one while a change is pending, the authorized one otherwise. */
export function sessionPermissionMode(session: WorkSession): PermissionMode {
  return session.settings.requested.permissionMode ?? session.permissionMode;
}

/**
 * Permission menu (D-12; owner's reference ref-1): Supervised, Auto-accept edits, Auto, Full access with their
 * one-line descriptions, plus Plan. Every option the API refused is disabled with its reason; options the
 * inventory has not confirmed are not shown at all (WZC-06). In Full access the chip turns to the warning tone
 * for every controller (D-04).
 */
export function PermissionMenu({
  session,
  controls,
  disabled = false,
}: {
  session: WorkSession;
  controls: SessionControls;
  disabled?: boolean;
}) {
  const update = useUpdateSessionSettings(session.id);
  const [open, setOpen] = useState(false);
  const current = sessionPermissionMode(session);
  const full = current === "fullAccess" || session.fullAccess;
  const label = permissionModeMeta(current)?.label ?? current;
  const ctx = { runtime: session.runtime, modes: controls.permissionModes };
  const rows = PERMISSION_MODES.flatMap((meta) => {
    const option = controls.permissionModes.find((m) => m.value === meta.value);
    return option && isShown(option) ? [{ meta, option }] : [];
  });

  function choose(mode: PermissionMode) {
    setOpen(false);
    if (mode === current) return;
    update.mutate(
      { permissionMode: mode },
      {
        onSuccess: () => {
          if (mode === "fullAccess")
            toast.warning("Full access is on", { description: "Commands and edits run without prompts." });
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  const Icon = full ? LockOpen : Lock;
  const trigger = (
    <ControlChip
      disabled={disabled}
      data-testid="permission-chip"
      data-mode={current}
      data-tone={full ? "warning" : undefined}
      tone={full ? "warning" : undefined}
      aria-label={`Permissions: ${label}`}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
      {update.isPending ? (
        <Spinner className="size-3" />
      ) : (
        <ChevronDown data-chevron className="size-3.5 shrink-0 opacity-70" />
      )}
    </ControlChip>
  );

  return (
    <ControlSurface
      trigger={trigger}
      title="Permissions"
      testId="permission-menu"
      open={open}
      onOpenChange={setOpen}
      className="w-[min(24.5rem,calc(100vw-1.5rem))]"
    >
      <div className="grid gap-0.5 py-0.5">
        {rows.map(({ meta, option }) => {
          const ModeIcon = meta.icon;
          const warning = meta.tone === "warning";
          return (
            <Fragment key={meta.value}>
              {meta.value === "plan" ? <div aria-hidden className="mx-2.5 my-1 h-px bg-border" /> : null}
              <SurfaceOption
                data-testid="permission-option"
                data-value={meta.value}
                selected={meta.value === current}
                disabled={!option.available}
                reason={option.available ? null : controlReasonText(option, ctx)}
                secondary={meta.hint}
                onSelect={() => choose(meta.value)}
                className="py-2"
              >
                <ModeIcon
                  className={cn(
                    "size-[18px] shrink-0",
                    warning && option.available ? "text-amber-600 dark:text-amber-400" : "text-foreground/80",
                    !option.available && "text-muted-foreground",
                  )}
                />
                <span data-label>{meta.label}</span>
              </SurfaceOption>
            </Fragment>
          );
        })}
      </div>
    </ControlSurface>
  );
}
