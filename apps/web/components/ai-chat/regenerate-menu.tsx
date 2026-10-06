"use client";

import type { Message, ModelRef, SendAiMessageResponse } from "@ocw/contracts";
import { ChevronLeft, ChevronRight, RotateCcw, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { ControlSurface } from "@/components/work-zone/control-surface";
import { regenerate, useAiModels } from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ModelPickerList } from "./model-picker";

/**
 * Regenerate / Regenerate with… on the chat's last answer (05-06, AICHAT-02/03). A quiet footer button opens the
 * Work Zone control surface (a popover above it on a desktop, a bottom sheet at 390): "Regenerate" runs again on
 * the answer's model; "Regenerate with…" shows the same grouped model list as the composer picker (METERED kept on
 * organization models). The answer then resets and streams again on the same message; the replaced text is kept
 * server-side (message_versions). Only offered when nothing is being written in the chat.
 */
export function RegenerateMenu({
  chatId,
  message,
  disabled,
  onRegenerated,
}: {
  chatId: string;
  message: Message;
  disabled: boolean;
  /** The API's answer (the reset answer shows before its WebSocket events arrive). */
  onRegenerated?: (response: SendAiMessageResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "models">("menu");
  const [pending, setPending] = useState(false);
  const models = useAiModels();
  const g = message.generation;
  const current = g ? ({ backend: g.backend, provider: g.provider, modelId: g.modelId } as ModelRef) : null;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setView("menu");
  }

  async function run(model?: ModelRef) {
    onOpenChange(false);
    setPending(true);
    try {
      const response = await regenerate(chatId, { messageId: message.id, ...(model ? { model } : {}) });
      onRegenerated?.(response);
    } catch (err) {
      toast.error("Couldn't regenerate the answer", { description: errorMessage(err) });
    } finally {
      setPending(false);
    }
  }

  const trigger = (
    <button
      type="button"
      data-testid="ai-regenerate"
      aria-label="Regenerate"
      title="Regenerate"
      disabled={disabled || pending}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-accent data-popup-open:text-foreground"
    >
      {pending ? <Spinner className="size-3.5" /> : <RotateCcw aria-hidden className="size-3.5" />}
    </button>
  );

  return (
    <ControlSurface
      trigger={trigger}
      title={view === "models" ? "Regenerate with…" : "Regenerate"}
      testId="ai-regenerate-menu"
      open={open}
      onOpenChange={onOpenChange}
      className="w-[min(21rem,calc(100vw-1.5rem))]"
    >
      {view === "menu" ? (
        <div className="grid gap-0.5 py-0.5">
          <MenuRow
            testId="ai-regenerate-same"
            icon={<RotateCcw className="size-4" />}
            title="Regenerate"
            detail={g ? `Same model · ${g.modelLabel}` : "Same model"}
            onClick={() => void run()}
          />
          <MenuRow
            testId="ai-regenerate-with"
            icon={<Sparkles className="size-4" />}
            title="Regenerate with…"
            detail="Choose another model for this answer"
            trailing={<ChevronRight aria-hidden className="size-4 text-muted-foreground" />}
            onClick={() => setView("models")}
          />
        </div>
      ) : (
        <div className="grid gap-0.5">
          <button
            type="button"
            data-surface-item
            data-testid="ai-regenerate-back"
            onClick={() => setView("menu")}
            className="flex h-8 w-fit items-center gap-1 rounded-lg px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            <ChevronLeft aria-hidden className="size-4" />
            Back
          </button>
          <ModelPickerList
            models={models.data?.models ?? []}
            value={current}
            onChange={(ref) => void run(ref)}
          />
        </div>
      )}
    </ControlSurface>
  );
}

function MenuRow({
  testId,
  icon,
  title,
  detail,
  trailing,
  onClick,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  detail: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-surface-item
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors",
        "hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30",
      )}
    >
      <span aria-hidden className="text-muted-foreground">
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-[14px] text-foreground leading-5">{title}</span>
        <span className="truncate text-[12px] text-muted-foreground leading-4">{detail}</span>
      </span>
      {trailing}
    </button>
  );
}
