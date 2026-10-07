"use client";

import type { AiChatTools, AiModelOption, SendAiMessageResponse } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Lock, MessageCircleQuestion, Share2, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/chat/attachments/drop-zone";
import { attachmentLimitsHint } from "@/components/chat/composer";
import { EmptyState } from "@/components/common/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clearAiChatModel } from "@/lib/ai-chat-model-store";
import {
  createAiChat,
  createAiDraft,
  newClientMessageId,
  primeAiChat,
  sendAiMessage,
  stopGeneration,
  updateAiChat,
  useAiChat,
  useAiChatSettingsLive,
  useAiChatSummary,
  useAiModels,
  useAiPreferences,
} from "@/lib/ai-chat-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { AiChatHeader, AiChatMenuItem, AiChatPlainHeader } from "./ai-chat-header";
import { AiComposer, type AiComposerApi, type AiSendFiles } from "./ai-composer";
import { AiMessageList } from "./ai-message-list";
import { ChatSettingsSheet } from "./chat-settings-sheet";
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
    let res: SendAiMessageResponse;
    try {
      const base = { clientMessageId: newClientMessageId(), body, model: m.ref, tools };
      res =
        draft.current || files.ids.length > 0
          ? await sendAiMessage(await ensureDraft(), { ...base, attachmentIds: files.ids })
          : await createAiChat(base);
    } catch (err) {
      sendFailed(err);
    }
    primeAiChat(res);
    // The created chat's lastModel carries the pick; the next New chat starts from the default again.
    clearAiChatModel(NEW_CHAT_KEY);
    router.replace(`/chat/ai/${res.chat.id}`);
  }

  return (
    <Frame title="New chat">
      <ChatDropZone enabled={!!models.data} composer={composer}>
        <div className="flex min-h-0 flex-1 flex-col sm:justify-center sm:pb-[12vh]">
          <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 text-center sm:flex-none">
            <h2 className="text-balance font-semibold text-[22px] tracking-tight sm:text-[26px]">
              What can I help with?
            </h2>
            <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              Only you can see this chat
            </p>
          </div>
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
        </div>
      </ChatDropZone>
    </Frame>
  );
}

function ExistingChat({ chatId }: { chatId: string }) {
  const chat = useAiChat(chatId);
  const models = useAiModels();
  // A title generated or typed after the snapshot, or an archive, arrives live as the chat's latest summary.
  const live = useAiChatSummary(chatId);
  // Settings saved in the chat settings sheet after the snapshot (05-11).
  const liveSettings = useAiChatSettingsLive(chatId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const composer = useRef<AiComposerApi | null>(null);
  const snapshotChat = chat.snapshot?.chat;
  const detail = snapshotChat ? { ...snapshotChat, ...live, ...liveSettings } : snapshotChat;
  const writing = chat.messages.findLast((m) => m.authorKind === "agent" && m.status === "streaming");
  const busy = writing !== undefined;
  // The generation to stop: the streaming answer's, else the snapshot's running one.
  const runningId =
    writing?.generation?.id ??
    (chat.snapshot?.running?.messageId === writing?.id ? chat.snapshot?.running?.generationId : undefined);

  async function onStop() {
    if (!runningId) return;
    try {
      await stopGeneration(chatId, runningId);
    } catch (err) {
      toast.error("Couldn't stop the answer", { description: errorMessage(err) });
      throw err;
    }
  }

  async function onSend(body: string, m: AiModelOption, tools: AiChatTools, files: AiSendFiles) {
    try {
      chat.applySent(
        await sendAiMessage(chatId, {
          clientMessageId: newClientMessageId(),
          body,
          model: m.ref,
          tools,
          ...(files.ids.length > 0 ? { attachmentIds: files.ids } : {}),
        }),
      );
    } catch (err) {
      sendFailed(err);
    }
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

  return (
    <Frame
      header={
        detail ? (
          <AiChatHeader
            chat={detail}
            extraMenuItems={
              <>
                <AiChatMenuItem
                  icon={<SlidersHorizontal />}
                  testId="ai-chat-menu-settings"
                  onSelect={() => setSettingsOpen(true)}
                >
                  Chat settings
                </AiChatMenuItem>
                {/* A read-only snapshot link for colleagues in the organization (05-13), owner with ai_chat.share. */}
                {detail.viewerCan.includes("ai_chat.share") ? (
                  <AiChatMenuItem
                    icon={<Share2 />}
                    testId="ai-chat-menu-share"
                    onSelect={() => setShareOpen(true)}
                  >
                    Share
                  </AiChatMenuItem>
                ) : null}
              </>
            }
          />
        ) : (
          <AiChatPlainHeader title="New chat" />
        )
      }
    >
      {detail ? <ChatSettingsSheet chat={detail} open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
      {detail ? <ShareDialog chatId={chatId} open={shareOpen} onOpenChange={setShareOpen} /> : null}
      <ChatDropZone enabled={!detail?.archived} composer={composer}>
        <AiMessageList
          chatId={chatId}
          messages={chat.messages}
          textOf={chat.textOf}
          onRegenerated={chat.applySent}
          live={chat.live}
        />
        {detail?.archived ? (
          <ArchivedNotice chatId={chatId} />
        ) : (
          <AiComposer
            chatKey={chatId}
            chat={detail ?? null}
            initialTools={detail?.settings.tools}
            models={models.data?.models}
            preferred={[detail?.lastModel, models.data?.defaultRef]}
            modelsLoading={models.isPending}
            busy={busy}
            onSend={onSend}
            onStop={runningId ? onStop : undefined}
            uploadTarget={chatId}
            apiRef={composer}
          />
        )}
      </ChatDropZone>
    </Frame>
  );
}

/** An archived chat opens read-only (05-10): the composer's place explains it and offers the way back. */
function ArchivedNotice({ chatId }: { chatId: string }) {
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
        <Button size="sm" disabled={pending} onClick={() => void unarchive()} data-testid="ai-unarchive">
          Unarchive to continue
        </Button>
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
