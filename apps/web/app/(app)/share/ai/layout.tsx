import type { ReactNode } from "react";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ModuleGate } from "@/components/shell/module-gate";
import "../../chat/chat.css";

/**
 * A shared AI chat reads inside the Chat section (05-14): the chat sidebar stays beside the snapshot, as on every other
 * conversation, so a colleague who opened a link is one click from their own channels and AI chats. A reader whose AI
 * chats are turned off (07.3) sees the in-place off state instead of the snapshot.
 */
export default function SharedAiChatLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ChatSidebar />
      <ModuleGate module="ai_chats">{children}</ModuleGate>
    </>
  );
}
