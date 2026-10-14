"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  type Agent,
  type AgentTemplateChangedField,
  type AgentTemplateLink,
  modelLabel,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CircleSlash, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  agentTemplateKeys,
  shortTool,
  useAgentTemplates,
  useApplyTemplateUpdate,
  useTemplatePreview,
} from "@/lib/agent-template-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { skipText } from "./templates-section";

const LABEL: Record<AgentTemplateChangedField, string> = {
  instructions: "Instructions",
  model: "Model",
  capabilities: "Abilities",
  toolGrants: "Tools",
  requiredConnectors: "Required connectors",
  vaultItems: "Keys",
};

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="font-semibold text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs">{text}</p>
    </div>
  );
}

/**
 * Template update dialog (`template-update-dialog`, 07.4-UI-SPEC § 4): what applying the template's newer version
 * overwrites on the owner's bot, then `Update to v{n}`. The owner's memory, chats and connections stay; a 409 (a newer
 * version was published meanwhile) reloads the diff.
 */
export function TemplateUpdateDialog({
  agent,
  link,
  open,
  onClose,
}: {
  agent: Agent;
  link: AgentTemplateLink;
  open: boolean;
  onClose: () => void;
}) {
  const templates = useAgentTemplates();
  const apply = useApplyTemplateUpdate(agent.id);
  const qc = useQueryClient();
  const preview = useTemplatePreview(open ? link.templateId : null);
  const [stale, setStale] = useState(false);
  const update = link.update;
  const t = templates.data?.templates.find((x) => x.id === link.templateId) ?? null;
  const latest = t?.latest ?? null;
  if (!update) return null;

  function run() {
    if (!update) return;
    setStale(false);
    apply.mutate(update.to, {
      onSuccess: (a) => {
        toast.success(`${a.name} updated to v${update.to}`);
        onClose();
      },
      onError: (err) => {
        if (isApiError(err, 409)) {
          setStale(true);
          void qc.invalidateQueries({ queryKey: agentTemplateKeys.link(agent.id) });
          void templates.refetch();
        } else {
          toast.error("Could not update the bot", { description: errorMessage(err) });
        }
      },
    });
  }

  return (
    // Opened from the bot's sheet, so it is a nested dialog: Base UI skips a nested dialog's backdrop unless forced
    // (the lightbox precedent), which left the sheet undimmed behind it. Same markup as PanelDialog otherwise.
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          forceRender
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <DialogPrimitive.Popup
          data-testid="template-update-dialog"
          className={cn(
            "fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden border bg-background shadow-2xl outline-none",
            "inset-x-0 bottom-0 rounded-t-2xl sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
            "transition-[transform,opacity] duration-200 ease-out data-ending-style:translate-y-4 data-starting-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:opacity-0 sm:data-ending-style:scale-95 sm:data-starting-style:scale-95 sm:data-ending-style:-translate-y-1/2 sm:data-starting-style:-translate-y-1/2",
          )}
        >
          <DialogHeader>
            <DialogTitle>
              Update {agent.name} to v{update.to}?
            </DialogTitle>
            <DialogDescription>
              The template's version replaces these fields. Memory, chats and connections stay.
            </DialogDescription>
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className="absolute top-3 right-3 text-muted-foreground max-md:size-11"
                />
              }
            >
              <X />
            </DialogClose>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <ul className="grid gap-4" aria-label="Changed fields">
              {update.changedFields.map((f) => (
                <li key={f} className="grid gap-2" data-testid="template-update-field" data-field={f}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{LABEL[f]}</span>
                    {f === "model" && latest ? (
                      <span className="text-right text-muted-foreground">
                        {modelLabel(agent.modelProvider, agent.modelId)} →{" "}
                        {modelLabel(latest.modelProvider, latest.modelId)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">changed</span>
                    )}
                  </div>
                  {f === "instructions" && latest ? (
                    <>
                      <Block label="Now" text={agent.instructions} />
                      <Block label={`v${update.to}`} text={latest.instructions} />
                    </>
                  ) : null}
                  {f === "capabilities" && latest ? (
                    <p className="text-muted-foreground text-xs">
                      v{update.to}: Memory {latest.capabilities.memory ? "on" : "off"} · Internet{" "}
                      {latest.capabilities.internet ? "on" : "off"} ·{" "}
                      {latest.capabilities.dailyLimit === null
                        ? "No daily limit"
                        : `${latest.capabilities.dailyLimit} replies a day`}
                    </p>
                  ) : null}
                  {f === "toolGrants" && latest ? (
                    <p className="break-words font-mono text-muted-foreground text-xs">
                      v{update.to}:{" "}
                      {latest.toolGrants.length
                        ? latest.toolGrants.map((g) => shortTool(g.toolName)).join(", ")
                        : "None"}
                    </p>
                  ) : null}
                  {f === "requiredConnectors" && t ? (
                    <p className="text-muted-foreground text-xs">
                      v{update.to}: {t.requiredConnectors.map((c) => c.name).join(", ") || "None"}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="flex items-start gap-2 text-amber-800 text-xs dark:text-amber-300" role="note">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Your own edits to these fields are replaced.
            </p>
            {preview.data && preview.data.skipped.length > 0 ? (
              <section className="grid gap-2">
                <h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
                  Not included (after update)
                </h3>
                <ul className="grid gap-1.5 text-sm">
                  {preview.data.skipped.map((s) => (
                    <li key={`${s.kind}:${s.id}`} className="flex items-start gap-2">
                      <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{skipText(s, t)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {stale ? (
              <p role="alert" className="text-destructive text-sm">
                A newer version was published. Review it again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} className="max-md:h-11">
              Not now
            </Button>
            <Button
              onClick={run}
              disabled={apply.isPending}
              data-testid="template-update-apply"
              className="max-md:h-11"
            >
              {apply.isPending ? <Spinner /> : null}
              Update to v{update.to}
            </Button>
          </DialogFooter>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
