import type { Metadata } from "next";
import { AiChatView } from "@/components/ai-chat/ai-chat-view";

export const metadata: Metadata = { title: "AI chat" };

export default async function AiChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <AiChatView key={chatId} chatId={chatId} />;
}
