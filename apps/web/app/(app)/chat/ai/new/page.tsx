import type { Metadata } from "next";
import { AiChatView } from "@/components/ai-chat/ai-chat-view";

export const metadata: Metadata = { title: "New chat" };

export default function NewAiChatPage() {
  return <AiChatView chatId={null} />;
}
