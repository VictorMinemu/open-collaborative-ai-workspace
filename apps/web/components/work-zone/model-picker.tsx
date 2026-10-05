"use client";

import { Menu } from "@base-ui/react/menu";
import type { ModelControl, WorkSession } from "@ocw/contracts";
import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSessionControls, useUpdateSessionSettings } from "@/lib/workzone-queries";
import { RUNTIMES, RuntimeLogo } from "./meta";

/**
 * Composer model chip (D-08, D-14). The list comes ONLY from the catalog the device's runtime reported, through
 * `GET /work-sessions/:id/controls`; a device that reported no catalog shows no choices. A change is held as
 * pending until the device reports it (the chip shows the requested model meanwhile; the composer hint says it
 * applies to the next turn). Plan 09 replaces this with the full reference picker under the same name.
 */
export function ModelPicker({ session, disabled = false }: { session: WorkSession; disabled?: boolean }) {
  const controls = useSessionControls(session.id);
  const update = useUpdateSessionSettings(session.id);
  const models = controls.data?.models ?? [];
  const { requested, effective, pending } = session.settings;
  const find = (id: string | null | undefined) => (id ? models.find((m) => m.id === id) : undefined);
  const requestedId = requested.model ?? null;
  const effectiveId = effective?.model ?? null;
  const shown =
    (pending ? find(requestedId) : (find(effectiveId) ?? find(requestedId))) ??
    (requestedId ? undefined : models.find((m) => m.isDefault));
  const label = shown?.displayName ?? effectiveId ?? requestedId ?? "Default";
  const currentId = shown?.id ?? null;
  const available = models.filter((m) => m.available);
  const current = available.filter((m) => !m.legacy);
  const legacy = available.filter((m) => m.legacy);
  const noCatalog = controls.isSuccess && controls.data.catalog === null;
  const locked = disabled || noCatalog || available.length === 0;

  function pick(m: ModelControl) {
    if (m.id === currentId && !pending) return;
    update.mutate(
      { model: m.id },
      {
        onSuccess: () =>
          toast.success(`Model set to ${m.displayName}`, {
            description:
              session.status === "running" || session.status === "waiting_approval"
                ? "Applies to the next turn"
                : undefined,
          }),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  const item = (m: ModelControl) => (
    <DropdownMenuItem
      key={m.id}
      data-testid="model-option"
      data-model-id={m.id}
      onClick={() => pick(m)}
      className="min-h-9 pr-8"
    >
      <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
      {m.isDefault ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-px font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          Default
        </span>
      ) : null}
      {m.id === currentId ? (
        <Check className="absolute right-2 size-4 !text-foreground" aria-label="Selected" />
      ) : null}
    </DropdownMenuItem>
  );

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={locked}
        data-testid="model-chip"
        data-model-id={currentId ?? ""}
        data-pending={pending ? "true" : "false"}
        title={noCatalog ? "This device has not reported its models yet" : undefined}
        className={cn(
          "inline-flex h-8 min-w-0 max-w-[60%] shrink items-center gap-1.5 rounded-full border border-transparent px-2 font-medium text-[12.5px] text-foreground/90 outline-none transition-colors sm:max-w-[45%]",
          "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30 data-popup-open:bg-accent",
          "disabled:cursor-default disabled:hover:bg-transparent",
        )}
      >
        <RuntimeLogo runtime={session.runtime} className="size-4 rounded-[4px]" />
        <span className="truncate">{label}</span>
        {pending ? (
          <span
            role="img"
            className="size-1.5 shrink-0 rounded-full bg-warning"
            aria-label="Applies to the next turn"
          />
        ) : null}
        {update.isPending ? (
          <Spinner className="size-3" />
        ) : locked ? null : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </Menu.Trigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="max-h-[min(60vh,420px)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
          <RuntimeLogo runtime={session.runtime} className="size-3.5 rounded-[3px]" />
          {RUNTIMES[session.runtime].label}
        </div>
        {current.map(item)}
        {legacy.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">Legacy models</div>
            {legacy.map(item)}
          </>
        ) : null}
      </DropdownMenuContent>
    </Menu.Root>
  );
}
