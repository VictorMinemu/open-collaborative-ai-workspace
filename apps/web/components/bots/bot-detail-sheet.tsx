"use client";
// authz-legacy: 02-10 migrates this file to the resolver

import { type Agent, modelLabel, UpdateAgentRequest } from "@ocw/contracts";
import { AlertTriangle, Hash, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, isApiError } from "@/lib/api";
import { useDeleteAgent, useIsAdmin, useModels, useUpdateAgent } from "@/lib/bots-queries";
import { validate } from "@/lib/form";
import { formatDate } from "@/lib/utils";
import { BotAvatar, ModelChip, StatusChip } from "./bot-bits";
import {
  BotForm,
  type BotFormErrors,
  type BotFormValues,
  modelKey,
  SheetSection,
  splitModelKey,
} from "./bot-form";

function toValues(a: Agent): BotFormValues {
  return {
    name: a.name,
    username: a.username,
    avatar: a.avatarUrl ?? "",
    description: a.description ?? "",
    instructions: a.instructions,
    model: modelKey(a.modelProvider, a.modelId),
  };
}

export function BotDetailSheet({
  agent,
  onOpenChange,
  onAddToChannel,
}: {
  agent: Agent | null;
  onOpenChange: (open: boolean) => void;
  onAddToChannel: (agent: Agent) => void;
}) {
  const isAdmin = useIsAdmin();
  const models = useModels();
  const update = useUpdateAgent();
  const remove = useDeleteAgent();
  const [values, setValues] = useState<BotFormValues | null>(agent ? toValues(agent) : null);
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const agentId = agent?.id;

  // Reset the form when another bot is opened (not on live status updates of the same bot).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the bot id on purpose
  useEffect(() => {
    setValues(agent ? toValues(agent) : null);
    setErrors({});
    setConfirmDelete(false);
  }, [agentId]);

  if (!agent || !values) {
    return (
      <Sheet open={false} onOpenChange={onOpenChange}>
        <SheetContent side="right" />
      </Sheet>
    );
  }

  const original = toValues(agent);
  const dirty = (Object.keys(values) as Array<keyof BotFormValues>).some((k) => values[k] !== original[k]);
  // Keep the bot's current model selectable even if it left the allowed list.
  const available = models.data?.models ?? [];
  const modelOptions = available.some(
    (m) => m.provider === agent.modelProvider && m.modelId === agent.modelId,
  )
    ? available
    : [
        ...available,
        {
          provider: agent.modelProvider,
          modelId: agent.modelId,
          label: modelLabel(agent.modelProvider, agent.modelId),
          isDefault: false,
        },
      ];

  async function save() {
    if (!agent || !values) return;
    const { provider, modelId } = splitModelKey(values.model);
    const result = validate(UpdateAgentRequest, {
      name: values.name,
      username: values.username,
      avatarUrl: values.avatar || null,
      description: values.description || null,
      instructions: values.instructions,
      modelProvider: provider,
      modelId,
    });
    if (result.errors) {
      const e = result.errors as Record<string, string>;
      setErrors({ name: e.name, username: e.username, avatar: e.avatarUrl, instructions: e.instructions });
      return;
    }
    try {
      await update.mutateAsync({ id: agent.id, body: result.data });
      toast.success("Bot updated", { description: "The runtime picks up the change in a moment." });
    } catch (err) {
      if (isApiError(err, 409)) setErrors({ username: "This handle is already taken" });
      else toast.error("Could not save", { description: errorMessage(err) });
    }
  }

  async function toggle(enabled: boolean) {
    if (!agent) return;
    try {
      await update.mutateAsync({ id: agent.id, body: { enabled } });
      toast.success(enabled ? `${agent.name} enabled` : `${agent.name} disabled`);
    } catch (err) {
      toast.error("Could not update the bot", { description: errorMessage(err) });
    }
  }

  async function destroy() {
    if (!agent) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await remove.mutateAsync(agent.id);
      toast.success(`${agent.name} deleted`);
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not delete the bot", { description: errorMessage(err) });
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-full sm:w-[36rem] sm:max-w-[92vw]"
        data-testid="bot-detail-sheet"
      >
        <div className="flex items-start gap-3 border-b px-5 py-4 pr-14">
          <BotAvatar name={agent.name} avatar={agent.avatarUrl} seed={agent.id} />
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate">{agent.name}</SheetTitle>
            <SheetDescription className="truncate font-mono text-[12.5px]">
              @{agent.username}
            </SheetDescription>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusChip status={agent.status} message={agent.statusMessage} />
              <ModelChip provider={agent.modelProvider} modelId={agent.modelId} />
            </div>
          </div>
        </div>

        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-5 py-5">
          {agent.status === "error" && agent.statusMessage ? (
            <div
              role="alert"
              className="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium text-destructive">The runtime could not start this bot</p>
                <p className="mt-0.5 text-muted-foreground">{agent.statusMessage}</p>
              </div>
            </div>
          ) : null}

          {isAdmin ? (
            <SheetSection title="Profile & behaviour">
              <BotForm
                idPrefix={`bot-${agent.id}`}
                values={values}
                errors={errors}
                models={modelOptions}
                onChange={(patch) => {
                  setValues((v) => (v ? { ...v, ...patch } : v));
                  setErrors({});
                }}
                usernameTouched
                onUsernameTouched={() => {}}
              />
            </SheetSection>
          ) : (
            <SheetSection title="About">
              <p className="text-sm">{agent.description || "No description."}</p>
              <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                {agent.instructions}
              </pre>
            </SheetSection>
          )}

          {isAdmin ? (
            <SheetSection title="Availability">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block font-medium text-sm">Enabled</span>
                  <span className="block text-muted-foreground text-xs">
                    Disabled bots ignore mentions and cannot post.
                  </span>
                </span>
                <Switch
                  checked={agent.status !== "disabled"}
                  onCheckedChange={(v) => toggle(v)}
                  disabled={update.isPending}
                  aria-label="Enabled"
                  data-testid="bot-enabled"
                />
              </div>
            </SheetSection>
          ) : null}

          <p className="text-muted-foreground text-xs">
            Created {formatDate(agent.createdAt)} · runtime OpenClaw · tools disabled
          </p>

          {isAdmin ? (
            <SheetSection title="Danger zone">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/25 p-3">
                <span className="text-sm">
                  <span className="block font-medium">Delete bot</span>
                  <span className="block text-muted-foreground text-xs">
                    It leaves every channel. Its past messages stay.
                  </span>
                </span>
                <Button
                  variant={confirmDelete ? "destructive" : "outline"}
                  size="sm"
                  onClick={destroy}
                  disabled={remove.isPending}
                  data-testid="delete-bot"
                >
                  {remove.isPending ? <Spinner /> : <Trash2 />}
                  {confirmDelete ? "Confirm delete" : "Delete"}
                </Button>
              </div>
            </SheetSection>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
          <Button
            variant="outline"
            onClick={() => onAddToChannel(agent)}
            disabled={agent.status === "disabled"}
            className="flex-1 sm:flex-none"
          >
            <Hash /> Add to channel
          </Button>
          {isAdmin ? (
            <Button
              onClick={save}
              disabled={!dirty || update.isPending}
              data-testid="save-bot"
              className="flex-1 sm:flex-none"
            >
              {update.isPending && dirty ? <Spinner /> : null}
              Save changes
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
