"use client";

import type { AiChatTools, AiModelOption, SendAiMessageResponse } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Eye, Lock, MessageCircleQuestion, Share2, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/chat/attachments/drop-zone";
import { attachmentLimitsHint } from "@/components/chat/composer";
import { TypingIndicator } from "@/components/chat/typing";
import { EmptyState } from "@/components/common/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clearAiChatModel } from "@/lib/ai-chat-model-store";
import {
  createAiChat,
  createAiDraft,
  isPosted,
  newClientMessageId,
  primeAiChat,
  sendAiMessage,
  stopGeneration,
  updateAiChat,
  useAiChat,
  useAiChatSettingsLive,
  useAiChatSummary,
  useAiModels,
  useAiParticipants,
  useAiPreferences,
} from "@/lib/ai-chat-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { useMe } from "@/lib/queries";
import { AiChatHeader, AiChatMenuItem, AiChatPlainHeader } from "./ai-chat-header";
import { AiComposer, type AiComposerApi, type AiSendFiles } from "./ai-composer";
import { AiEmptyState } from "./ai-empty-state";
import { AiChatPeopleContext } from "./ai-message";
import { AiMessageList } from "./ai-message-list";
import { ChatSettingsSheet } from "./chat-settings-sheet";
import { QueueChip } from "./queue-chip";
import { ShareDialog } from "./share-dialog";

/**
 * The AI chat screen (D-08, P-09) later plans extend: a borderless header, the centered conversation and a sticky
 * composer, in the Work Zone / T3 Code layout language. `chatId = null` is `/chat/ai/new`: the first send creates
 * the chat and moves to `/chat/ai/<id>` with both turns already on screen.
 */
export function AiChatView({ chatId }: { chatId: string | null }) {
  return chatId ? <ExistingChat chatId={chatId} /> : <NewChat />;
}

/** The model-store key of `/chat/ai/new`. */
const NEW_CHAT_KEY = "new";

function sendFailed(err: unknown): never {
  // At a daily cap the composer's notice explains it (which cap, when it resets); no toast on top.
  if (!(isApiError(err) && err.code === "daily_limit_reached")) {
    toast.error("Couldn't send your message", { description: errorMessage(err) });
  }
  throw err;
}

/**
 * Files on the conversation pane (05-12): a drop hands them to the composer, which uploads them into the chat. A
 * plain wrapper while attachments are off.
 */
function ChatDropZone({
  enabled,
  composer,
  children,
}: {
  enabled: boolean;
  composer: React.RefObject<AiComposerApi | null>;
  children: React.ReactNode;
}) {
  const config = useAttachmentsConfig();
  return (
    <DropZone
      conversationLabel="this chat"
      enabled={enabled && config.data?.enabled === true}
      hint={attachmentLimitsHint(config.data)}
      onFiles={(files) => composer.current?.addFiles(files)}
    >
      {children}
    </DropZone>
  );
}

function NewChat() {
  const router = useRouter();
  const models = useAiModels();
  // The member's "Web search on by default" (05-11); the default model comes with the model list.
  const prefs = useAiPreferences();
  const composer = useRef<AiComposerApi | null>(null);
  // Files need a conversation before the first message (05-12): the first attached file creates a draft chat,
  // which the send then turns into this chat (it is listed from its first message on).
  const draft = useRef<Promise<string> | null>(null);
  const ensureDraft = useCallback((): Promise<string> => {
    draft.current ??= createAiDraft().then(
      (chat) => chat.id,
      (err) => {
        draft.current = null;
        throw err;
      },
    );
    return draft.current;
  }, []);

  async function onSend(body: string, m: AiModelOption, tools: AiChatTools, files: AiSendFiles) {
    let res: SendAiMessageResponse | null;
    let chatId: string;
    try {
      const base = { clientMessageId: newClientMessageId(), body, model: m.ref, tools };
      if (draft.current || files.ids.length > 0) {
        // A draft is the member's own solo chat: always 201 (the 202 of a shared chat cannot happen here).
        const sent = await sendAiMessage(await ensureDraft(), { ...base, attachmentIds: files.ids });
        res = isPosted(sent) ? null : sent;
        chatId = sent.chat.id;
      } else {
        res = await createAiChat(base);
        chatId = res.chat.id;
      }
    } catch (err) {
      sendFailed(err);
    }
    if (res) primeAiChat(res);
    // The created chat's lastModel carries the pick; the next New chat starts from the default again.
    clearAiChatModel(NEW_CHAT_KEY);
    router.replace(`/chat/ai/${chatId}`);
  }

  return (
    <Frame title="New chat">
      <ChatDropZone enabled={!!models.data} composer={composer}>
        <AiEmptyState
          onPick={(prompt) => composer.current?.fill(prompt)}
          composer={
            <AiComposer
              chatKey={NEW_CHAT_KEY}
              initialTools={prefs.data ? { web: prefs.data.webDefault } : undefined}
              models={models.data?.models}
              preferred={[models.data?.defaultRef]}
              modelsLoading={models.isPending}
              busy={false}
              onSend={onSend}
              uploadTarget={ensureDraft}
              apiRef={composer}
              autoFocus
            />
          }
        />
      </ChatDropZone>
    </Frame>
  );
}

function ExistingChat({ chatId }: { chatId: string }) {
  const chat = useAiChat(chatId);
  const models = useAiModels();
  const me = useMe();
  // A title generated or typed after the snapshot, or an archive, arrives live as the chat's latest summary.
  const live = useAiChatSummary(chatId);
  // Settings saved in the chat settings sheet after the snapshot (05-11).
  const liveSettings = useAiChatSettingsLive(chatId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const composer = useRef<AiComposerApi | null>(null);
  const snapshotChat = chat.snapshot?.chat;
  const detail = snapshotChat ? { ...snapshotChat, ...live, ...liveSettings } : snapshotChat;
  const writing = chat.messages.findLast(
    (m) => m.authorKind === "agent" && m.authorId === null && m.status === "streaming",
  );
  const busy = writing !== undefined;
  // The chat takes turns among several people (06-11): shared, or the server keeps a queue for it (P-08).
  const multiplayer = detail?.shared === true || chat.queue !== null;
  // The generation to stop: the queue's running one (multiplayer), else the streaming answer's, else the snapshot's.
  const runningId =
    (multiplayer ? chat.queue?.running?.generationId : undefined) ??
    writing?.generation?.id ??
    (chat.snapshot?.running?.messageId === writing?.id ? chat.snapshot?.running?.generationId : undefined);
  const viewerId = me.data?.user.id ?? null;
  const participants = useAiParticipants(chatId, multiplayer && !chat.lost);
  const names = new Map<string, string>();
  for (const p of participants.data?.participants ?? []) names.set(p.id, p.displayName);
  for (const m of chat.messages) if (m.authorId && m.author) names.set(m.authorId, m.author.displayName);
  const nameOf = (id: string) => names.get(id) ?? null;

  async function onStop() {
    if (!runningId) return;
    try {
      await stopGeneration(chatId, runningId);
    } catch (err) {
      toast.error("Couldn't stop the answer", { description: errorMessage(err) });
      throw err;
    }
  }

  async function onSend(
    body: string,
    m: AiModelOption,
    tools: AiChatTools,
    files: AiSendFiles,
    askAi?: boolean,
  ) {
    try {
      const res = await sendAiMessage(
        chatId,
        {
          clientMessageId: newClientMessageId(),
          body,
          model: m.ref,
          tools,
          ...(files.ids.length > 0 ? { attachmentIds: files.ids } : {}),
          ...(askAi !== undefined ? { askAi } : {}),
        },
        { multiplayer },
      );
      if (isPosted(res)) chat.applyPosted(res);
      else chat.applySent(res);
    } catch (err) {
      sendFailed(err);
    }
  }

  if (chat.lost) {
    return (
      <Frame title="AI chat">
        <EmptyState
          icon={Lock}
          title="You no longer have access to this chat."
          description="Its owner changed who can see it. Ask them if you need it back."
        >
          <Link href="/chat/ai" className={buttonVariants({ variant: "outline" })} data-testid="ai-lost-back">
            Back to AI chats
          </Link>
        </EmptyState>
      </Frame>
    );
  }

  if (chat.notFound) {
    return (
      <Frame title="AI chat">
        <EmptyState
          icon={MessageCircleQuestion}
          title="This chat isn't available"
          description="It may have been deleted, or it belongs to someone else. AI chats are private to their owner."
        >
          <Link href="/chat/ai/new" className={buttonVariants()}>
            New chat
          </Link>
        </EmptyState>
      </Frame>
    );
  }

  if (chat.isPending) {
    return (
      <Frame title={<Skeleton className="h-4 w-40" />}>
        <div className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-7 px-4 pt-8 sm:px-6">
          <Skeleton className="ml-auto h-10 w-2/5 rounded-[20px]" />
          <div className="grid gap-2">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </div>
      </Frame>
    );
  }

  if (chat.error && chat.messages.length === 0) {
    return (
      <Frame title="AI chat">
        <EmptyState
          icon={MessageCircleQuestion}
          title="Couldn't load this chat"
          description={errorMessage(chat.error)}
        >
          <Button variant="outline" onClick={chat.refetch}>
            Try again
          </Button>
        </EmptyState>
      </Frame>
    );
  }

  // Owner-only actions follow the server's decisions for this viewer (P-04): a grantee sees none of them.
  const canManage = detail?.viewerCan.includes("ai_chat.manage") ?? false;
  const canShare = detail?.viewerCan.includes("ai_chat.share") ?? false;
  // A view grant reads only (P-04): no composer, no files, no regenerate. Until the detail loads, Phase 5 behaviour.
  const canUse = detail ? detail.viewerCan.includes("ai_chat.use") : true;
  const people = { viewerId, shared: detail?.shared === true, multiplayer, nameOf };
  // Stop belongs to the running request's author and to whoever manages the chat (06-06; the API enforces it too).
  const canStop = canManage || (!!viewerId && chat.queue?.running?.requesterUserId === viewerId);
  // D-01 / T-06-03-01: a grantee starts on their own default model, never on the owner's last one (that may be the
  // owner's plan); the owner keeps the Phase 5 rule (the chat's last model first).
  const grantee = detail?.access !== undefined && detail.access !== "owner";
  const preferred = grantee ? [models.data?.defaultRef] : [detail?.lastModel, models.data?.defaultRef];

  return (
    <Frame
      header={
        detail ? (
          <AiChatHeader
            chat={detail}
            viewerCan={detail.viewerCan}
            extraMenuItems={
              canManage || canShare ? (
                <>
                  {canManage ? (
                    <AiChatMenuItem
                      icon={<SlidersHorizontal />}
                      testId="ai-chat-menu-settings"
                      onSelect={() => setSettingsOpen(true)}
                    >
                      Chat settings
                    </AiChatMenuItem>
                  ) : null}
                  {/* People and a read-only snapshot link (05-13, 06-03), owner with ai_chat.share. */}
                  {canShare ? (
                    <AiChatMenuItem
                      icon={<Share2 />}
                      testId="ai-chat-menu-share"
                      onSelect={() => setShareOpen(true)}
                    >
                      Share
                    </AiChatMenuItem>
                  ) : null}
                </>
              ) : null
            }
          />
        ) : (
          <AiChatPlainHeader title="New chat" />
        )
      }
    >
      {detail && canManage ? (
        <ChatSettingsSheet chat={detail} open={settingsOpen} onOpenChange={setSettingsOpen} />
      ) : null}
      {detail && canShare ? (
        <ShareDialog
          chatId={chatId}
          open={shareOpen}
          onOpenChange={setShareOpen}
          viewerCan={detail.viewerCan}
        />
      ) : null}
      <ChatDropZone enabled={!detail?.archived && canUse} composer={composer}>
        <AiChatPeopleContext.Provider value={people}>
          <AiMessageList
            chatId={chatId}
            messages={chat.messages}
            textOf={chat.textOf}
            onRegenerated={canUse ? chat.applySent : undefined}
            // 06-03 deferred / 06-06: in a multiplayer chat only the answer's requester or a manager may regenerate.
            canRegenerate={
              multiplayer
                ? (a) => canManage || (!!viewerId && a.generation?.requesterUserId === viewerId)
                : undefined
            }
            regenerateBlocked={multiplayer && (chat.queue?.pending.length ?? 0) > 0}
            live={chat.live}
          />
        </AiChatPeopleContext.Provider>
        {multiplayer ? (
          <div className="mx-auto w-full max-w-3xl sm:px-2">
            <TypingIndicator typers={chat.typers} />
          </div>
        ) : null}
        {multiplayer && chat.queue && !detail?.archived ? (
          <QueueChip
            queue={chat.queue}
            names={(id) => nameOf(id) ?? "Someone"}
            viewerId={viewerId}
            canStop={canStop}
            onStop={onStop}
          />
        ) : null}
        {detail?.archived ? (
          <ArchivedNotice chatId={chatId} canUnarchive={canManage} />
        ) : !canUse ? (
          <ViewOnlyNotice owner={detail?.owner?.displayName ?? "the owner"} />
        ) : (
          <AiComposer
            chatKey={chatId}
            chat={detail ?? null}
            initialTools={detail?.settings.tools}
            models={models.data?.models}
            preferred={preferred}
            modelsLoading={models.isPending}
            // Multiplayer (06-11, D-05): Send stays while an answer runs (the server queues); Stop is in the chip.
            busy={multiplayer ? false : busy}
            onSend={onSend}
            onStop={!multiplayer && runningId ? onStop : undefined}
            onTyping={multiplayer ? chat.sendTyping : undefined}
            uploadTarget={chatId}
            apiRef={composer}
            // Arriving from New chat's first send: the keyboard stays in the composer.
            autoFocus={chat.sentHere}
          />
        )}
      </ChatDropZone>
    </Frame>
  );
}

/** A view grant (06-03, P-04): the composer's place says the chat is read-only and whom to ask for more. */
function ViewOnlyNotice({ owner }: { owner: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/40 px-4 py-3">
        <Eye aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p data-testid="ai-view-only-notice" className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">
          You can view this chat. Ask {owner} for chat access to write.
        </p>
      </div>
    </div>
  );
}

/**
 * An archived chat opens read-only (05-10): the composer's place explains it and, for its owner, offers the way back
 * (only `ai_chat.manage` may unarchive, 06-03).
 */
function ArchivedNotice({ chatId, canUnarchive = true }: { chatId: string; canUnarchive?: boolean }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  async function unarchive() {
    setPending(true);
    try {
      await updateAiChat(qc, chatId, { archived: false });
    } catch (err) {
      toast.error("Couldn't restore the chat", { description: errorMessage(err) });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
      <div
        data-testid="ai-archived-notice"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-muted/40 px-4 py-3"
      >
        <Archive aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">
          This chat is archived. You can read it, but not send new messages.
        </p>
        {canUnarchive ? (
          <Button size="sm" disabled={pending} onClick={() => void unarchive()} data-testid="ai-unarchive">
            Unarchive to continue
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Header + content column shared by every state of the screen. */
function Frame({
  title,
  header,
  children,
}: {
  title?: React.ReactNode;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="ai-chat-view">
      {header ?? <AiChatPlainHeader title={title} />}
      {children}
    </div>
  );
}
