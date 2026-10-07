"use client";

import { AI_INSTRUCTIONS_MAX, type AiUserPreferences, type ModelRef } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ModelPicker } from "@/components/ai-chat/model-picker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { saveAiPreferences, useAiModels, useAiPreferences } from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Settings › AI chat › Preferences (05-11, AICHAT-05): the member's own defaults for every AI chat — personal
 * instructions (sent only in chats where they are the one person, never shared), the model new chats start on and
 * whether Web search starts on. Per-chat instructions live in each chat's settings.
 */
export function PreferencesCard() {
  const prefs = useAiPreferences();
  return (
    <section className="grid gap-3" aria-labelledby="ai-preferences-heading" data-testid="preferences-card">
      <div>
        <h2 id="ai-preferences-heading" className="font-semibold text-[15px] tracking-tight">
          Preferences
        </h2>
        <p className="mt-0.5 text-muted-foreground text-sm">Defaults for every AI chat you start.</p>
      </div>
      {prefs.isPending ? (
        <Skeleton className="h-[22rem] rounded-2xl" />
      ) : prefs.isError ? (
        <p className="rounded-2xl border bg-card px-4 py-3 text-muted-foreground text-sm">
          {errorMessage(prefs.error)}
        </p>
      ) : (
        <PreferencesForm saved={prefs.data} />
      )}
    </section>
  );
}

function PreferencesForm({ saved }: { saved: AiUserPreferences }) {
  const qc = useQueryClient();
  const models = useAiModels();
  const [draft, setDraft] = useState<AiUserPreferences>(saved);
  const [saving, setSaving] = useState(false);
  const instructionsId = useId();
  const webId = useId();

  // A save elsewhere (another tab) arrives as new saved values.
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const tooLong = draft.instructions.length > AI_INSTRUCTIONS_MAX;
  const defaultRef: ModelRef | null = draft.defaultModel ?? models.data?.defaultRef ?? null;
  const usingFallback = !draft.defaultModel;

  async function save() {
    if (!dirty || tooLong || saving) return;
    setSaving(true);
    try {
      const patch = Object.fromEntries(
        (["instructions", "defaultModel", "webDefault"] as const)
          .filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(draft[k]))
          .map((k) => [k, draft[k]]),
      );
      await saveAiPreferences(qc, patch);
      toast.success("Preferences saved");
    } catch (err) {
      toast.error("Couldn't save your preferences", { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="grid gap-2 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={instructionsId} className="font-medium text-sm">
            Personal instructions
          </label>
          <span
            data-testid="prefs-counter"
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
          data-testid="prefs-instructions"
          value={draft.instructions}
          aria-invalid={tooLong || undefined}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          placeholder="e.g. I'm a product manager at Autofy Labs. Answer in Spanish, be direct, and use bullet points."
          className="min-h-32 resize-y text-[15px] sm:text-sm"
        />
        <p className="text-[12.5px] text-muted-foreground leading-snug">
          Used in every AI chat you have on your own. Each chat can turn them off, and they're never sent in a
          chat with other people.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:gap-5 sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Default model</div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground leading-snug">
            {usingFallback
              ? "New chats start on your ChatGPT plan when it's connected."
              : "New chats start here."}
          </p>
        </div>
        <div data-testid="prefs-default-model" className="min-w-0 sm:max-w-[16rem]">
          <ModelPicker
            chatKey="preferences"
            value={defaultRef}
            onChange={(ref) => setDraft({ ...draft, defaultModel: ref })}
          />
        </div>
      </div>

      <div className="flex items-center gap-4 border-t p-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <label htmlFor={webId} className="font-medium text-sm">
            Web search on by default
          </label>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground leading-snug">
            New chats start with Web on. You can turn it off in any chat.
          </p>
        </div>
        <Switch
          id={webId}
          data-testid="prefs-web-default"
          checked={draft.webDefault}
          onCheckedChange={(on) => setDraft({ ...draft, webDefault: on })}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3 sm:px-5">
        {dirty ? (
          <Button variant="ghost" onClick={() => setDraft(saved)} className="h-10 sm:h-9">
            Discard
          </Button>
        ) : null}
        <Button
          data-testid="prefs-save"
          disabled={!dirty || tooLong || saving}
          onClick={() => void save()}
          className="h-10 min-w-20 sm:h-9"
        >
          {saving ? <Spinner /> : "Save"}
        </Button>
      </div>
    </div>
  );
}
