import type { Metadata } from "next";
import { AiChatsView } from "@/components/chat/views/ai-chats-view";

export const metadata: Metadata = { title: "AI Chats" };

export default function AiChatsPage() {
  return <AiChatsView />;
}
