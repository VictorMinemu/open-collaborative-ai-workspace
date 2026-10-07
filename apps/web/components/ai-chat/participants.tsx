"use client";

import type { AiParticipant } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Globe, Lock, Share2, UserMinus, Users } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { BotBadge, PrincipalAvatar } from "@/components/chat/principal-avatar";
import { PresenceAvatar, PresenceStack, usePresentPeople } from "@/components/presence/presence-stack";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useSheetSurface } from "@/components/work-zone/control-surface";
import { accessLabel, audienceScope, audienceSummary } from "@/lib/ai-audience";
import { removeAiChatAgent, useAiChatGrants, useAiChatParticipants } from "@/lib/ai-grant-queries";
import { errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

const SHARED_WITH = "Shared with ";

/**
 * Who is in an AI chat (06-12, MULTI-01, AGENT-02, D-07, D-08), next to the title: the people here now (Phase 4 presence
 * stack) and a chip saying how widely the chat is shared ("Shared with Backend"). The chip opens the participants list
 * (a popover on a desktop, a bottom sheet at 390): every person with their access (Owner / Can chat / Can view), then
 * the agents. Everything comes from `GET /participants` (and, for the owner, the grants); `canManage` is the server's
 * `ai_chat.manage` for the viewer and only shows the owner's actions: add an agent, remove one (confirmed), manage
 * access. The server enforces the same rules (06-10 routes).
 */
export function AiChatParticipants({
  chatId,
  canManage,
  enabled = true,
  onManageAccess,
  onAddAgent,
}: {
  chatId: string;
  canManage: boolean;
  /** Off for solo chats (nobody else takes part): nothing is fetched or shown. */
  enabled?: boolean;
  /** The owner's way to the share dialog (people and teams). */
  onManageAccess?: (() => void) | undefined;
  /** The owner's "Add an agent" (the caller hosts `AddAgentDialog`). */
  onAddAgent?: (() => void) | undefined;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const viewerId = me.data?.user.id ?? null;
  const orgName = me.data?.organization.name ?? "your organization";
  const participants = useAiChatParticipants(chatId, enabled);
  // The grant list is the owner's (ai_chat.share): it names the teams. Everyone else reads `audience`.
  const grants = useAiChatGrants(chatId, enabled && canManage);
  const sheet = useSheetSurface();
  const [open, setOpen] = useState(false);

  const list = participants.data?.participants ?? [];
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  const resolve = useCallback(
    (userId: string) => {
      const p = byId.get(userId);
      return p ? { name: p.displayName, avatarUrl: p.avatarUrl } : undefined;
    },
    [byId],
  );
  const present = usePresentPeople(enabled ? `conv:${chatId}` : null, {
    ...(viewerId ? { excludeUserId: viewerId } : {}),
    resolve,
  });

  if (!enabled || !participants.data) return null;
  const ownerGrants = canManage ? grants.data?.grants : undefined;
  const summary = audienceSummary({
    audience: participants.data.audience,
    participants: list,
    viewerId,
    grants: ownerGrants,
  });
  const scope = audienceScope({ audience: participants.data.audience, orgName, grants: ownerGrants });
  const wide =
    participants.data.audience !== "listed" || (ownerGrants?.some((g) => g.subject.kind !== "user") ?? false);
  const Icon = participants.data.audience === "organization" ? Globe : Users;

  const trigger = (
    <button
      type="button"
      data-testid="ai-chat-audience"
      aria-label={`${summary}: who is in this chat`}
      title={summary}
      className={cn(
        "flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-popup-open:bg-accent data-popup-open:text-foreground",
        wide && "border-primary/25 text-foreground/80",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-[7.5rem] truncate font-medium sm:max-w-[14rem]">
        {/* At 390 the chip keeps the name only ("Backend"); the words stay for screen readers and tests. */}
        {summary.startsWith(SHARED_WITH) ? (
          <>
            <span className="max-sm:sr-only">{SHARED_WITH}</span>
            {summary.slice(SHARED_WITH.length)}
          </>
        ) : (
          summary
        )}
      </span>
    </button>
  );

  const body = (
    <ParticipantList
      people={list.filter((p) => p.kind === "user")}
      agents={list.filter((p) => p.kind === "agent")}
      presentIds={new Map(present.map((p) => [p.userId, p.state]))}
      viewerId={viewerId}
      scope={scope}
      onRemoveAgent={
        canManage
          ? async (agent) => {
              try {
                await removeAiChatAgent(qc, chatId, agent.id);
                toast.success(`Removed @${agent.handle ?? agent.displayName} from this chat`);
              } catch (err) {
                toast.error("Couldn't remove the agent", { description: errorMessage(err) });
              }
            }
          : undefined
      }
      footer={
        canManage && (onAddAgent || onManageAccess) ? (
          <>
            {onAddAgent ? (
              <FooterAction
                testId="ai-chat-add-agent"
                icon={<Bot />}
                onClick={() => {
                  setOpen(false);
                  onAddAgent();
                }}
              >
                Add an agent
              </FooterAction>
            ) : null}
            {onManageAccess ? (
              <FooterAction
                testId="ai-chat-manage-access"
                icon={<Share2 />}
                onClick={() => {
                  setOpen(false);
                  onManageAccess();
                }}
              >
                Manage access
              </FooterAction>
            ) : null}
          </>
        ) : null
      }
    />
  );

  return (
    <div data-testid="ai-chat-participants" className="flex min-w-0 shrink items-center gap-1">
      <PresenceStack people={present} max={3} label={`${present.length} here now`} className="max-sm:px-0" />
      {sheet ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={trigger} />
          <SheetContent
            side="bottom"
            data-testid="ai-chat-participants-list"
            initialFocus={false}
            className="h-auto max-h-[85dvh] gap-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
            <SheetTitle className="px-5 pt-3 pr-12 pb-1 text-[15px]">People in this chat</SheetTitle>
            <div className="scrollbar-thin min-h-0 overflow-y-auto px-3 pb-1">{body}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={trigger} />
          <PopoverContent
            align="end"
            data-testid="ai-chat-participants-list"
            className="w-[22rem] max-w-[calc(100vw-1rem)] p-0"
          >
            <PopoverTitle className="px-4 pt-3.5 font-semibold text-[14px]">People in this chat</PopoverTitle>
            <div className="scrollbar-thin max-h-[min(28rem,70dvh)] overflow-y-auto px-2 pb-2">{body}</div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function FooterAction({
  testId,
  icon,
  onClick,
  children,
}: {
  testId: string;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left font-medium text-[13.5px] outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      {children}
    </button>
  );
}

/** One agent of the list; the owner may remove it after a confirmation in place. */
function AgentRow({
  agent,
  onRemove,
}: {
  agent: AiParticipant;
  onRemove?: ((agent: AiParticipant) => Promise<void>) | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const handle = agent.handle ?? agent.displayName;
  return (
    <div data-testid="ai-chat-participant" data-kind="agent" data-id={agent.id} className="grid gap-1">
      <div className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1">
        <PrincipalAvatar
          kind="agent"
          name={agent.displayName}
          avatarUrl={agent.avatarUrl}
          seed={agent.id}
          className="size-7"
        />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-[13.5px]">{agent.displayName}</span>
            <BotBadge />
          </span>
          <span className="truncate text-[12px] text-muted-foreground">@{handle}</span>
        </span>
        {onRemove && !confirming ? (
          <button
            type="button"
            data-testid="ai-chat-remove-agent"
            aria-label={`Remove @${handle} from this chat`}
            onClick={() => setConfirming(true)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            <UserMinus className="size-3.5" />
            Remove
          </button>
        ) : (
          <span className="shrink-0 text-[12px] text-muted-foreground">{accessLabel(agent.access)}</span>
        )}
      </div>
      {onRemove && confirming ? (
        <div className="mx-2 mb-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/[0.06] px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            Remove <span className="font-medium">@{handle}</span>? It stops answering here.
          </p>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="ai-chat-remove-agent-confirm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onRemove(agent).finally(() => {
                  setBusy(false);
                  setConfirming(false);
                });
              }}
            >
              {busy ? <Spinner /> : null}
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ParticipantList({
  people,
  agents,
  presentIds,
  viewerId,
  scope,
  footer,
  onRemoveAgent,
}: {
  people: AiParticipant[];
  agents: AiParticipant[];
  presentIds: ReadonlyMap<string, "online" | "away">;
  viewerId: string | null;
  scope: string;
  footer: ReactNode;
  onRemoveAgent?: ((agent: AiParticipant) => Promise<void>) | undefined;
}) {
  return (
    <div className="grid gap-2 pt-1">
      <p
        data-testid="ai-chat-participants-scope"
        className="flex items-start gap-1.5 px-2 text-[12.5px] text-muted-foreground leading-snug"
      >
        <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span>{scope}</span>
      </p>
      <section aria-label="People" className="grid gap-px">
        <h4 className="px-2 pt-1 pb-0.5 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider">
          People · {people.length}
        </h4>
        {people.map((p) => {
          const state = presentIds.get(p.id);
          return (
            <div
              key={p.id}
              data-testid="ai-chat-participant"
              data-kind="user"
              data-id={p.id}
              className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1"
            >
              {state ? (
                <PresenceAvatar
                  userId={p.id}
                  name={p.displayName}
                  avatarUrl={p.avatarUrl}
                  state={state}
                  className="size-7 text-[11px]"
                />
              ) : (
                <PrincipalAvatar
                  kind="user"
                  name={p.displayName}
                  avatarUrl={p.avatarUrl}
                  seed={p.id}
                  className="size-7"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[13.5px]">
                <span className="font-medium">{p.displayName}</span>
                {p.id === viewerId ? <span className="text-muted-foreground"> (you)</span> : null}
              </span>
              <span
                data-testid="ai-chat-participant-access"
                className={cn(
                  "shrink-0 text-[12px]",
                  p.access === "owner" ? "font-medium text-foreground/80" : "text-muted-foreground",
                )}
              >
                {accessLabel(p.access)}
              </span>
            </div>
          );
        })}
      </section>
      {agents.length > 0 ? (
        <section aria-label="Agents" className="grid gap-px">
          <h4 className="px-2 pt-1 pb-0.5 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wider">
            Agents · {agents.length}
          </h4>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} onRemove={onRemoveAgent} />
          ))}
        </section>
      ) : null}
      {footer ? <div className="border-t pt-1.5">{footer}</div> : null}
    </div>
  );
}
