"use client";

import { type Agent, modelLabel, UpdateAgentRequest } from "@ocw/contracts";
import { AlertTriangle, Hash, LayoutTemplate, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAgentTemplateLink } from "@/lib/agent-template-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateTargets, useDeleteAgent, useModels, useUpdateAgent } from "@/lib/bots-queries";
import { validate } from "@/lib/form";
import { useUnits } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { useMe, useMembers } from "@/lib/queries";
import { formatDate } from "@/lib/utils";
import { AgentMessagingSection } from "./agent-messaging-section";
import { BotAvatar, botAbilities, ModelChip, ScopeBadge, StatusChip } from "./bot-bits";
import { canMessage, MessageBotButton, OpenBotPageLink, PersonalBadge } from "./bot-card";
import {
  BotForm,
  type BotFormErrors,
  type BotFormValues,
  modelKey,
  PlacementFields,
  type PlacementValues,
  SheetSection,
  splitModelKey,
} from "./bot-form";
import { CapabilitiesPanel } from "./capabilities-panel";
import { TemplateUpdateDialog } from "./template-update-dialog";
import { ConnectorRows } from "./templates-section";

function toPlacement(a: Agent): PlacementValues {
  return {
    scope: a.unit?.kind ?? "organization",
    unitId: a.unitId ?? "",
    ownerUserId: a.ownerUserId ?? "",
  };
}

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

/**
 * One bot's sheet. `variant="gallery"` (Bots page): profile, Message, Add to channel. `variant="dm"` (Bot
 * settings from the bot's private chat): the same controls minus Message and Add to channel. Both show the
 * Capabilities section when the API grants `bot.configure` on this bot.
 */
export function BotDetailSheet({
  agent,
  onOpenChange,
  onAddToChannel,
  onDeleted,
  variant = "gallery",
}: {
  agent: Agent | null;
  onOpenChange: (open: boolean) => void;
  onAddToChannel?: (agent: Agent) => void;
  onDeleted?: () => void;
  variant?: "gallery" | "dm";
}) {
  const models = useModels();
  const update = useUpdateAgent();
  const remove = useDeleteAgent();
  const where = useCreateTargets();
  const units = useUnits();
  const members = useMembers();
  const me = useMe({ enabled: false });
  // Consult rules (07.7-08, D-04): admins in v1. Cosmetic: the API refuses the routes without `rule.read`.
  const canReadRules = useCan("rule.read");
  // Owner only (07.4-08): the template this personal bot was started from; null for every other bot.
  const isOwnPersonal =
    !!agent && agent.scope === "personal" && !!me.data && agent.ownerUserId === me.data.user.id;
  const templateLink = useAgentTemplateLink(agent?.id ?? null, isOwnPersonal);
  const [values, setValues] = useState<BotFormValues | null>(agent ? toValues(agent) : null);
  const [placement, setPlacement] = useState<PlacementValues | null>(agent ? toPlacement(agent) : null);
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const agentId = agent?.id;

  // Reset the form when another bot is opened (not on live status updates of the same bot).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the bot id on purpose
  useEffect(() => {
    setValues(agent ? toValues(agent) : null);
    setPlacement(agent ? toPlacement(agent) : null);
    setErrors({});
    setConfirmDelete(false);
    setReviewing(false);
  }, [agentId]);

  if (!agent || !values) {
    return (
      <Sheet open={false} onOpenChange={onOpenChange}>
        <SheetContent side="right" />
      </Sheet>
    );
  }

  // Controls follow what the API decided for this bot (viewerCan), not the caller's org-wide role.
  const { edit: canEdit, govern: canGovern } = botAbilities(agent);
  const canConfigure = (agent.viewerCan ?? []).includes("bot.configure");
  const personal = agent.scope === "personal";
  const inDm = variant === "dm";
  // An owner cannot switch back on a personal bot an admin disabled (the API refuses with disabled_by_admin).
  const lockedByAdmin =
    personal &&
    agent.status === "disabled" &&
    !!agent.statusMessage &&
    !(agent.viewerCan ?? []).includes("bot.manage");
  const original = toValues(agent);
  const originalPlacement = toPlacement(agent);
  const place = placement ?? originalPlacement;
  const unitMoved = place.unitId !== originalPlacement.unitId;
  const ownerChanged = place.ownerUserId !== originalPlacement.ownerUserId;
  const dirty =
    (Object.keys(values) as Array<keyof BotFormValues>).some((k) => values[k] !== original[k]) ||
    (!personal && (unitMoved || ownerChanged));
  // Shared personas (AGENT-01): moving is offered only where the caller may take it from and put it.
  const allUnits = units.data?.units ?? [];
  const memberList = members.data?.members ?? [];
  const canMove = agent.unitId ? where.unitIds.includes(agent.unitId) : where.organization;
  const targets = allUnits.filter((u) => where.unitIds.includes(u.id) || u.id === agent.unitId);
  const owner = agent.ownerUserId ? memberList.find((m) => m.userId === agent.ownerUserId) : undefined;
  const ownerName = agent.ownerUserId
    ? (owner?.displayName ?? (members.isSuccess ? "Former member" : null))
    : null;
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
    if (!personal && place.scope !== "organization" && !place.unitId) return;
    const result = validate(UpdateAgentRequest, {
      name: values.name,
      username: values.username,
      avatarUrl: values.avatar || null,
      description: values.description || null,
      instructions: values.instructions,
      modelProvider: provider,
      modelId,
      // Only what changed: a move needs rights on both places, an owner change `bot.configure`.
      ...(!personal && unitMoved ? { unitId: place.unitId || null } : {}),
      ...(!personal && ownerChanged ? { ownerUserId: place.ownerUserId || null } : {}),
    } as Record<string, unknown>);
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
      onDeleted?.();
    } catch (err) {
      toast.error("Could not delete the bot", { description: errorMessage(err) });
    }
  }

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-full sm:w-[36rem] sm:max-w-[92vw]"
        data-testid={inDm ? "bot-settings-sheet" : "bot-detail-sheet"}
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
              {personal ? <PersonalBadge /> : <ScopeBadge agent={agent} className="h-6 px-2 text-[11.5px]" />}
            </div>
            {templateLink.data ? (
              <p
                className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
                data-testid="bot-template-line"
              >
                <LayoutTemplate className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  From template {templateLink.data.templateName} · v{templateLink.data.version}
                </span>
              </p>
            ) : null}
            {!personal && ownerName ? (
              <p
                className="mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground"
                data-testid="bot-owner-row"
              >
                <UserAvatar
                  name={ownerName}
                  src={owner?.avatarUrl}
                  seed={agent.ownerUserId}
                  className="size-5 text-[9px]"
                />
                <span className="truncate" data-testid="bot-owner">
                  Owner: {ownerName}
                </span>
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!inDm && canMessage(agent) ? <MessageBotButton agent={agent} /> : null}
              <OpenBotPageLink agent={agent} />
            </div>
          </div>
        </div>

        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-7 overflow-y-auto px-5 py-5">
          {templateLink.data?.update ? (
            <div
              role="status"
              data-testid="template-update-banner"
              className="flex flex-col gap-3 rounded-lg bg-brand-soft px-3 py-2.5 text-brand-soft-foreground text-sm sm:flex-row sm:items-center"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <LayoutTemplate className="size-4 shrink-0" aria-hidden />
                <span>Template updated to v{templateLink.data.update.to} · Review and update</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReviewing(true)}
                aria-label={`Review update to v${templateLink.data.update.to}`}
                data-testid="template-update-review"
                className="w-full sm:w-auto max-md:h-11"
              >
                Review
              </Button>
            </div>
          ) : null}

          {templateLink.data && templateLink.data.requiredConnectors.length > 0 ? (
            <SheetSection title="Connections">
              <ConnectorRows connectors={templateLink.data.requiredConnectors} />
            </SheetSection>
          ) : null}
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

          {!personal && canEdit ? (
            <SheetSection title="Who can use it">
              <PlacementFields
                idPrefix={`bot-${agent.id}`}
                value={place}
                onChange={(patch) => setPlacement((p) => ({ ...(p ?? originalPlacement), ...patch }))}
                targets={targets}
                allUnits={allUnits}
                allowOrganization={where.organization || !agent.unitId}
                members={memberList}
                canMove={canMove}
              />
            </SheetSection>
          ) : null}

          {canConfigure ? (
            <SheetSection title="Capabilities">
              <CapabilitiesPanel agentId={agent.id} />
            </SheetSection>
          ) : null}

          {!personal && canReadRules ? (
            <SheetSection title="Consulting other bots">
              <AgentMessagingSection agent={agent} />
            </SheetSection>
          ) : null}

          {canEdit ? (
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

          {canGovern ? (
            <SheetSection title="Availability">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <span>
                  <span className="block font-medium text-sm">Enabled</span>
                  <span className="block text-muted-foreground text-xs" data-testid="bot-enabled-hint">
                    {lockedByAdmin
                      ? `${agent.statusMessage}. Ask them to enable it again.`
                      : "Disabled bots stop answering; their private chats are archived until re-enabled."}
                  </span>
                </span>
                <Switch
                  checked={agent.status !== "disabled"}
                  onCheckedChange={(v) => toggle(v)}
                  disabled={update.isPending || lockedByAdmin}
                  aria-label="Enabled"
                  data-testid="bot-enabled"
                />
              </div>
            </SheetSection>
          ) : null}

          <p className="text-muted-foreground text-xs">
            Created {formatDate(agent.createdAt)} · runtime OpenClaw
          </p>

          {canGovern ? (
            <SheetSection title="Danger zone">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/25 p-3">
                <span className="text-sm">
                  <span className="block font-medium">Delete bot</span>
                  <span className="block text-muted-foreground text-xs">
                    {personal
                      ? "Its private chat is archived. This cannot be undone."
                      : "It leaves every channel and its private chats are archived. Its past messages stay."}
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

        <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3 empty:hidden">
          {personal || inDm || !onAddToChannel ? null : (
            <Button
              variant="outline"
              onClick={() => onAddToChannel(agent)}
              disabled={agent.status === "disabled"}
              className="flex-1 sm:flex-none"
            >
              <Hash /> Add to channel
            </Button>
          )}
          {canEdit ? (
            <Button
              onClick={save}
              disabled={!dirty || update.isPending}
              data-testid="save-bot"
              className="flex-1 sm:ml-auto sm:flex-none"
            >
              {update.isPending && dirty ? <Spinner /> : null}
              Save changes
            </Button>
          ) : null}
        </div>
        {templateLink.data?.update ? (
          <TemplateUpdateDialog
            agent={agent}
            link={templateLink.data}
            open={reviewing}
            onClose={() => setReviewing(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
