"use client";

import { type AiModelOption, type ModelRef, modelRefKey, type SendAiMessageResponse } from "@ocw/contracts";
import { ChevronLeft, Lock, MessageCircleQuestion, SquarePen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  createAiChat,
  newClientMessageId,
  primeAiChat,
  sendAiMessage,
  useAiChat,
  useAiModels,
} from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AiComposer } from "./ai-composer";
import { AiMessageList } from "./ai-message-list";

/**
 * The AI chat screen (D-08, P-09) later plans extend: a borderless header, the centered conversation and a sticky
 * composer, in the Work Zone / T3 Code layout language. `chatId = null` is `/chat/ai/new`: the first send creates
 * the chat and moves to `/chat/ai/<id>` with both turns already on screen.
 */
export function AiChatView({ chatId }: { chatId: string | null }) {
  return chatId ? <ExistingChat chatId={chatId} /> : <NewChat />;
}

/** The model the next answer runs on: the chat's last model when still available, else the member's default. */
function pickModel(
  models: AiModelOption[] | undefined,
  preferred: (ModelRef | null)[],
): AiModelOption | null {
  const list = models ?? [];
  for (const ref of preferred) {
    if (!ref) continue;
    const found = list.find((m) => m.available && modelRefKey(m.ref) === modelRefKey(ref));
    if (found) return found;
  }
  return list.find((m) => m.available && m.isDefault) ?? list.find((m) => m.available) ?? null;
}

function sendFailed(err: unknown): never {
  toast.error("Couldn't send your message", { description: errorMessage(err) });
  throw err;
}

function NewChat() {
  const router = useRouter();
  const models = useAiModels();
  const model = pickModel(models.data?.models, [models.data?.defaultRef ?? null]);

  async function onSend(body: string, m: AiModelOption) {
    let res: SendAiMessageResponse;
    try {
      res = await createAiChat({ clientMessageId: newClientMessageId(), body, model: m.ref });
    } catch (err) {
      sendFailed(err);
    }
    primeAiChat(res);
    router.replace(`/chat/ai/${res.chat.id}`);
  }

  return (
    <Frame title="New chat">
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
        <AiComposer model={model} modelsLoading={models.isPending} busy={false} onSend={onSend} autoFocus />
      </div>
    </Frame>
  );
}

function ExistingChat({ chatId }: { chatId: string }) {
  const chat = useAiChat(chatId);
  const models = useAiModels();
  const detail = chat.snapshot?.chat;
  const model = pickModel(models.data?.models, [detail?.lastModel ?? null, models.data?.defaultRef ?? null]);
  const busy = chat.messages.some((m) => m.status === "streaming");

  async function onSend(body: string, m: AiModelOption) {
    try {
      chat.applySent(
        await sendAiMessage(chatId, { clientMessageId: newClientMessageId(), body, model: m.ref }),
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
    <Frame title={detail?.title ?? "New chat"}>
      <AiMessageList chatId={chatId} messages={chat.messages} textOf={chat.textOf} />
      <AiComposer model={model} modelsLoading={models.isPending} busy={busy} onSend={onSend} />
    </Frame>
  );
}

/** Header + content column shared by every state of the screen. */
function Frame({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="ai-chat-view">
      <header
        className="flex h-12 shrink-0 items-center gap-1 px-2 sm:h-14 sm:px-4"
        data-testid="ai-chat-header"
      >
        <Link
          href="/chat/ai"
          aria-label="All AI chats"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "text-muted-foreground sm:hidden",
          )}
        >
          <ChevronLeft />
        </Link>
        <h1
          data-testid="ai-chat-title"
          className="min-w-0 flex-1 truncate px-1 font-medium text-[14px] tracking-tight sm:text-[15px]"
        >
          {title}
        </h1>
        <Link
          href="/chat/ai/new"
          aria-label="New chat"
          title="New chat"
          data-testid="ai-header-new-chat"
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}
        >
          <SquarePen />
        </Link>
      </header>
      {children}
    </div>
  );
}
