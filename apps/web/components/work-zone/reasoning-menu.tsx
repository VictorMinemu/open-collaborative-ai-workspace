"use client";

import {
  EFFORT_LABELS,
  type ModelControl,
  type SessionControls,
  type SessionSettingsPatch,
  type WorkSession,
  type WorkSessionSettings,
} from "@ocw/contracts";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useUpdateSessionSettings } from "@/lib/workzone-queries";
import { ControlChip, ControlSurface, DefaultTag, SurfaceOption, SurfaceSection } from "./control-surface";
import { contextWindowLabel, controlReasonText, isShown, RUNTIMES } from "./meta";
import { currentModelControl } from "./model-picker";

const effortLabel = (v: string) => EFFORT_LABELS[v] ?? v;

/** The effort the session runs with on `model` (requested, else what the device reported, else the default). */
function currentEffort(model: ModelControl, settings: WorkSessionSettings): string | null {
  if (settings.requested.effort) return settings.requested.effort;
  const reported = settings.pending ? null : settings.effective?.effort;
  if (reported && model.efforts.some((e) => e.value === reported)) return reported;
  return null;
}

function currentWindow(model: ModelControl, settings: WorkSessionSettings): number | null {
  return (
    settings.requested.contextWindow ??
    (settings.pending ? null : settings.effective?.contextWindow) ??
    model.defaultContextWindow ??
    null
  );
}

/** What the model offers in this menu (options the inventory has not confirmed are not offered, WZC-06). */
function offers(model: ModelControl | undefined) {
  const efforts = model ? model.efforts.filter(isShown) : [];
  const windows = model ? model.contextWindows.filter(isShown) : [];
  const fast = !!model && isShown(model.fastMode) && model.fastMode.supported;
  return { efforts, windows, fast, any: efforts.length > 0 || windows.length > 1 || fast };
}

/** The composer's "Reasoning · Context" chip text (ref-1): "High · 1M", "Default", "1M". */
export function reasoningChipLabel(model: ModelControl | undefined, settings: WorkSessionSettings): string {
  if (!model) return "Default";
  const { efforts } = offers(model);
  const effort = currentEffort(model, settings) ?? model.defaultEffort;
  const parts = [
    efforts.length > 0 ? (effort ? effortLabel(effort) : "Default") : null,
    (() => {
      const w = currentWindow(model, settings);
      return w ? contextWindowLabel(w) : null;
    })(),
  ].filter(Boolean);
  return parts.join(" · ") || "Default";
}

/**
 * Reasoning / Context Window / Fast Mode menu (D-09, D-10, D-11; owner's reference). Only what the selected model
 * reports: its efforts (Ultracode and `ultra` never appear — deferred to the multi-agent phase), 200k / 1M only
 * where the runtime offers both, and fast mode with its cost and the policy's or runtime's reason when off.
 */
export function ReasoningMenu({
  session,
  controls,
  disabled = false,
  leading,
}: {
  session: WorkSession;
  controls: SessionControls;
  disabled?: boolean;
  /** Rendered before the chip only when the chip itself renders (the composer's divider). */
  leading?: ReactNode;
}) {
  const update = useUpdateSessionSettings(session.id);
  const [open, setOpen] = useState(false);
  const model = currentModelControl(session, controls);
  const { efforts, windows, fast, any } = offers(model);
  if (!model || !any) return null;
  const settings = session.settings;
  const ctx = { runtime: session.runtime, modes: controls.permissionModes };
  const effort = currentEffort(model, settings);
  const defaultIsListed = !!model.defaultEffort && efforts.some((e) => e.value === model.defaultEffort);
  const window = currentWindow(model, settings);
  const fastOn =
    settings.requested.fastMode ?? (settings.pending ? false : settings.effective?.fastMode) ?? false;
  const fastShown = isShown(model.fastMode) && (fast || model.fastMode.reason !== null);

  function choose(patch: SessionSettingsPatch) {
    setOpen(false);
    update.mutate(patch, { onError: (err) => toast.error(errorMessage(err)) });
  }

  const trigger = (
    <ControlChip
      disabled={disabled}
      data-testid="reasoning-chip"
      aria-label={`Reasoning: ${reasoningChipLabel(model, settings)}`}
    >
      <span className="truncate">{reasoningChipLabel(model, settings)}</span>
      {update.isPending ? (
        <Spinner className="size-3" />
      ) : (
        <ChevronDown data-chevron className="size-3.5 shrink-0 opacity-70" />
      )}
    </ControlChip>
  );

  return (
    <>
      {leading}
      <ControlSurface
        trigger={trigger}
        title="Reasoning and context"
        testId="reasoning-menu"
        open={open}
        onOpenChange={setOpen}
        className="w-[min(16.5rem,calc(100vw-1.5rem))]"
      >
        {efforts.length > 0 ? (
          <SurfaceSection title="Reasoning">
            {defaultIsListed ? null : (
              <SurfaceOption
                data-testid="reasoning-option"
                data-kind="effort"
                data-value="default"
                selected={effort === null}
                onSelect={() => choose({ effort: null })}
                secondary={`${RUNTIMES[session.runtime].label} decides`}
              >
                Default
              </SurfaceOption>
            )}
            {efforts.map((e) => (
              <SurfaceOption
                key={e.value}
                data-testid="reasoning-option"
                data-kind="effort"
                data-value={e.value}
                selected={(effort ?? model.defaultEffort) === e.value}
                disabled={!e.available}
                reason={e.available ? null : controlReasonText(e, ctx)}
                secondary={e.description}
                onSelect={() => choose({ effort: e.value })}
              >
                {effortLabel(e.value)}
                {e.value === model.defaultEffort ? <DefaultTag /> : null}
              </SurfaceOption>
            ))}
          </SurfaceSection>
        ) : null}
        {windows.length > 1 || window ? (
          <SurfaceSection title="Context Window">
            {windows.length > 1 ? (
              windows.map((w) => (
                <SurfaceOption
                  key={w.value}
                  data-testid="reasoning-option"
                  data-kind="context"
                  data-value={String(w.value)}
                  selected={window === w.value}
                  disabled={!w.available}
                  reason={w.available ? null : controlReasonText(w, ctx)}
                  onSelect={() => choose({ contextWindow: w.value })}
                >
                  {contextWindowLabel(w.value)}
                  {w.value === model.defaultContextWindow ? <DefaultTag /> : null}
                </SurfaceOption>
              ))
            ) : window ? (
              <div data-testid="context-fixed" className="flex items-baseline gap-2 px-2.5 py-1.5">
                <span className="text-[14px] text-foreground leading-6">{contextWindowLabel(window)}</span>
                <span className="text-[12px] text-muted-foreground">Fixed for this model</span>
              </div>
            ) : null}
          </SurfaceSection>
        ) : null}
        {fastShown ? (
          <SurfaceSection title="Fast Mode" note={controls.fastModeCost}>
            <SurfaceOption
              data-testid="reasoning-option"
              data-kind="fast"
              data-value="on"
              selected={fastOn}
              disabled={!model.fastMode.available}
              reason={model.fastMode.available ? null : controlReasonText(model.fastMode, ctx)}
              onSelect={() => choose({ fastMode: true })}
            >
              On
            </SurfaceOption>
            <SurfaceOption
              data-testid="reasoning-option"
              data-kind="fast"
              data-value="off"
              selected={!fastOn}
              onSelect={() => choose({ fastMode: false })}
            >
              Off
            </SurfaceOption>
          </SurfaceSection>
        ) : null}
      </ControlSurface>
    </>
  );
}
