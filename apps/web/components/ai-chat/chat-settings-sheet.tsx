"use client";

import { AI_INSTRUCTIONS_MAX, type AiChatDetail, type AiChatTools, modelRefKey } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSheetSurface } from "@/components/work-zone/control-surface";
import { updateAiChat, useAiModels } from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ToolsList, useWebReason } from "./tools-menu";

/**
 * Chat settings (05-11, AICHAT-05): instructions for this chat only, whether the member's personal instructions also
 * apply here, and the chat's tools. A side sheet on a desktop, a bottom sheet at 390. Saved together; the next answer
 * uses them. Personal instructions themselves live in Settings › AI chat (they apply to every chat).
 */

interface Draft {
  instructions: string;
  usePersonalInstructions: boolean;
  tools: AiChatTools;
}

const draftOf = (chat: AiChatDetail): Draft => ({
  instructions: chat.settings.instructions,
  usePersonalInstructions: chat.settings.usePersonalInstructions,
  tools: { web: chat.settings.tools.web },
});

export function ChatSettingsSheet({
  chat,
  open,
  onOpenChange,
}: {
  chat: AiChatDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sheet = useSheetSurface();
  const qc = useQueryClient();
  const models = useAiModels();
  const lastKey = chat.lastModel ? modelRefKey(chat.lastModel) : null;
  const model = lastKey ? (models.data?.models.find((m) => modelRefKey(m.ref) === lastKey) ?? null) : null;
  const webReason = useWebReason(chat, model);
  const [draft, setDraft] = useState<Draft>(() => draftOf(chat));
  const [saving, setSaving] = useState(false);
  const instructionsId = useId();
  const personalId = useId();

  // Each opening starts from what is saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only, not on every live update
  useEffect(() => {
    if (open) setDraft(draftOf(chat));
  }, [open]);

  const saved = draftOf(chat);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const tooLong = draft.instructions.length > AI_INSTRUCTIONS_MAX;

  async function save() {
    if (!dirty || tooLong || saving) return;
    setSaving(true);
    try {
      await updateAiChat(qc, chat.id, { settings: draft });
      toast.success("Chat settings saved");
      onOpenChange(false);
    } catch (err) {
      toast.error("Couldn't save the chat settings", { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={sheet ? "bottom" : "right"}
        data-testid="chat-settings-sheet"
        data-surface={sheet ? "sheet" : "side"}
        className={cn("gap-0", sheet ? "h-auto max-h-[92dvh]" : "w-[26rem]")}
      >
        {sheet ? (
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
        ) : null}
        <div className="shrink-0 px-5 pt-4 pr-12 pb-3">
          <SheetTitle className="text-[16px]">Chat settings</SheetTitle>
          <SheetDescription className="mt-0.5 text-[13px]">These apply to this chat only.</SheetDescription>
        </div>
        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-6 overflow-y-auto px-5 pt-1 pb-5">
          <section className="grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={instructionsId} className="font-medium text-[13.5px]">
                Instructions for this chat
              </label>
              <span
                data-testid="chat-settings-counter"
                className={cn(
                  "shrink-0 text-[11.5px] tabular-nums",
                  tooLong ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {draft.instructions.length.toLocaleString("en-US")} /{" "}
                {AI_INSTRUCTIONS_MAX.toLocaleString("en-US")}
              </span>
            </div>
            <Textarea
              id={instructionsId}
              data-testid="chat-settings-instructions"
              value={draft.instructions}
              aria-invalid={tooLong || undefined}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              placeholder="e.g. You're helping me plan the Q4 offsite. Keep answers short and use tables for options."
              className="min-h-36 resize-y text-[15px] sm:min-h-40 sm:text-sm"
            />
            <p className="text-[12.5px] text-muted-foreground leading-snug">
              How the assistant should work in this chat. Only this chat uses them.
            </p>
          </section>

          <section className="flex items-start gap-3 rounded-xl border bg-muted/25 p-3.5">
            <div className="grid min-w-0 flex-1 gap-1">
              <label htmlFor={personalId} className="font-medium text-[13.5px] leading-5">
                Also use my personal instructions
              </label>
              <p className="text-[12.5px] text-muted-foreground leading-snug">
                Your personal instructions apply to every chat.{" "}
                <Link
                  href="/settings/ai-chat"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => onOpenChange(false)}
                >
                  Edit them in Settings
                </Link>
              </p>
            </div>
            <Switch
              id={personalId}
              data-testid="chat-settings-use-personal"
              checked={draft.usePersonalInstructions}
              onCheckedChange={(on) => setDraft({ ...draft, usePersonalInstructions: on })}
              className="mt-0.5"
            />
          </section>

          <section className="grid gap-1.5" data-testid="chat-settings-tools">
            <h3 className="font-medium text-[13.5px]">Tools</h3>
            <div className="-mx-2.5">
              <ToolsList
                value={draft.tools}
                onChange={(tools) => setDraft({ ...draft, tools })}
                webReason={webReason}
                model={model}
              />
            </div>
          </section>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="h-10 sm:h-9">
            Cancel
          </Button>
          <Button
            data-testid="chat-settings-save"
            disabled={!dirty || tooLong || saving}
            onClick={() => void save()}
            className="h-10 min-w-20 sm:h-9"
          >
            {saving ? <Spinner /> : "Save"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
